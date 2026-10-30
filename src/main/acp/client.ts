/**
 * ACP 客户端：把一家外部编码智能体接进 Torra。
 *
 * 这一层只做协议，不做产品：握手、建会话、发一轮、收事件、接授权请求。
 * 谁家的 agent 都不特殊 —— 差异全部由握手协商出来（capabilities、authMethods、
 * configOptions），代码不替它们猜含义。这也是「不写 shim」的落点：
 * 唯一的分叉点是启动命令，而那写在注册表里。
 *
 * 两件必须守住的规矩：
 * 一、agent 永远在**别的进程**里。它崩了是它的事，Torra 只看见 EOF；
 * 二、fs 读写只许落在会话的工作目录里。agent 要读工作目录外的文件，
 *    走的是授权请求（问用户），不是这条通道。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { NdJsonRpc } from './jsonrpc'
import type {
  AcpAgentEntry,
  AcpCapabilities,
  AcpDiff,
  AcpEvent,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpSelectGroup,
  AcpSelectOption,
} from '../../shared/acp'
import { isBlockedAcpOption } from '../../shared/acp'

/** 协议版本：ACP v1 */
const PROTOCOL_VERSION = 1
/** 授权请求多久没人管就当拒绝 —— agent 在等，不能无限期挂着 */
const PERMISSION_TIMEOUT_MS = 5 * 60_000
/** stderr 只留尾巴：适配器爱打日志，全存会撑爆内存 */
const STDERR_TAIL_MAX = 4000

/** session/new 的答复：会话 id、模式、配置项 */
interface AcpSessionResponse {
  sessionId?: string
  modes?: { currentModeId?: string; availableModes?: { id?: string; name?: string; description?: string }[] }
  configOptions?: Array<{
    id?: string
    name?: string
    description?: string
    category?: string
    type?: string
    currentValue?: string | boolean
    options?: Array<
      | { value?: string; name?: string; description?: string }
      | { group?: string; name?: string; options?: Array<{ value?: string; name?: string; description?: string }> }
    >
  }>
}

export interface AcpClientOptions {
  entry: AcpAgentEntry
  /** 会话工作目录：agent 的沙箱根，也是 fs 通道的授权边界 */
  cwd: string
  clientName: string
  clientVersion: string
  onEvent: (event: AcpEvent) => void
  /** 把授权请求交给用户；返回 null 等于拒绝 */
  onPermission: (req: AcpPermissionRequest) => Promise<AcpPermissionDecision>
  /** 用户另外授权过的目录 */
  extraDirs?: string[]
  /**
   * 工具包的出口：握手之后才问它要声明。
   *
   * 为什么要等到握手之后：「这一家收不收 http 形态的 MCP」是协商出来的，
   * 握手之前谁也不知道。提前报过去，等于把服务塞给一个不收它的 agent ——
   * codex 遇到不认识的形态会直接报错，那一整个会话都起不来。
   */
  mcpServers?: (info: { mcpHttp: boolean }) => Promise<unknown[]>
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/**
 * Windows 上 cwd 不能带 \\?\ 前缀。
 * Node 有时会把长路径规范化成这个形式，而 cmd.exe 不认 —— 它会抱怨
 * 「不是当前目录」然后在错误的目录里干活。这条坑只在 Windows 上出现。
 */
function normalizeCwd(dir: string): string {
  const abs = path.resolve(dir)
  return abs.startsWith('\\\\?\\') ? abs.slice(4) : abs
}

/**
 * fs 通道的授权边界：目标路径必须落在给定根目录之一里。
 *
 * 单独抽成纯函数是为了能被离线测：这是唯一一处决定「agent 能碰哪些文件」的地方，
 * 藏在类里就等于没人能证明它对。
 */
export function pathWithinRoots(target: string, roots: string[]): boolean {
  const resolved = path.resolve(target)
  return roots
    .map((r) => path.resolve(r))
    .some((r) => resolved === r || resolved.startsWith(r + path.sep))
}

/** 从协议的内容块里取能显示的字：文本直取，资源取内嵌文本，其余给个占位 */
function contentText(content: unknown): string {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).join('')
  if (typeof content !== 'object') return ''
  const c = content as Record<string, unknown>
  if (typeof c.text === 'string') return c.text
  if (c.resource && typeof c.resource === 'object') {
    const r = c.resource as Record<string, unknown>
    if (typeof r.text === 'string') return r.text
    if (typeof r.uri === 'string') return `[${r.uri}]`
  }
  if (typeof c.type === 'string') return `[${c.type}]`
  return ''
}

/**
 * 工具调用结果拆成两样东西：给人看的一段话，和能画成审查面板的改动。
 *
 * diff 块既算正文（一行行折在步骤后面），也单独留一份 —— 审查面板要的是
 * 路径与改前改后原文，而不是把三种东西缝在一起的字符串。之前这里把它们
 * 拼成 `--- path` 的伪补丁，界面只能当文本贴着看，没法并排核对。
 */
export function toolOutputParts(content: unknown): { text: string; diffs: AcpDiff[] } {
  if (!Array.isArray(content)) return { text: contentText(content), diffs: [] }
  const diffs: AcpDiff[] = []
  const text = content
    .map((item) => {
      if (item && typeof item === 'object' && 'type' in item) {
        const t = (item as Record<string, unknown>).type
        if (t === 'diff') {
          const d = item as Record<string, unknown>
          const path = typeof d.path === 'string' ? d.path : ''
          const oldText = typeof d.oldText === 'string' ? d.oldText : ''
          const newText = typeof d.newText === 'string' ? d.newText : ''
          if (path) diffs.push({ path, oldText, newText })
          return `--- ${path}\n${oldText}\n+++\n${newText}`
        }
      }
      return contentText(item)
    })
    .filter(Boolean)
    .join('\n')
  return { text, diffs }
}

export class AcpClient {
  private readonly opts: AcpClientOptions
  private child?: ChildProcessWithoutNullStreams
  private conn?: NdJsonRpc
  private sessionId?: string
  private capabilities?: AcpCapabilities
  private stderrTail = ''
  private closed = false
  /** 授权请求的等待者：id → 决定 */
  private readonly waiting = new Map<string, (decision: AcpPermissionDecision) => void>()
  private permissionSeq = 0
  /**
   * 带 MCP 声明的建会话有没有被认下。
   *
   * 有一家会直接拒（codex 遇到不认的形态就 invalidParams），那时客户端会退一步
   * 再试一次不带声明的 —— 工具包等于没挂上，外层要知道自己端起来的服务可以收了。
   */
  private mcpAccepted = false

  constructor(opts: AcpClientOptions) {
    this.opts = opts
  }

  get session(): string | undefined {
    return this.sessionId
  }

  get caps(): AcpCapabilities | undefined {
    return this.capabilities
  }

  /** 工具包真的被这一家收下了没有 */
  get toolPackAccepted(): boolean {
    return this.mcpAccepted
  }

  /** 握手 + 建会话。失败要抛出去 —— 预检靠它判断「这一家能不能接」 */
  async start(): Promise<AcpCapabilities> {
    const entry = this.opts.entry
    const cwd = normalizeCwd(this.opts.cwd)

    this.child = spawn(entry.command, entry.args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      /*
       * Windows 上 npx / 各个 CLI 都是 .cmd 垫片，Node 不允许直接 spawn 它们
       * （安全修复之后会报 EINVAL），只能经 cmd.exe。参数在注册表里就校验过
       * 不含 shell 特殊字符，所以这里走 shell 是安全的。
       */
      shell: process.platform === 'win32',
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams

    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX)
    })
    this.child.on('exit', (code) => {
      if (this.closed) return
      this.closed = true
      this.opts.onEvent({
        kind: 'error',
        text: `${this.opts.entry.title} 的进程退出了（code ${code ?? '未知'}）`,
      })
      this.releaseWaiting('进程已退出')
    })

    // 传输层自己写：stdio 上的 NDJSON，一行一个 JSON-RPC 2.0 消息。
    // 不装 @agentclientprotocol/sdk —— 那个包是 ESM-only，主进程为了它得留一条
    // 原生 import() 的装载通道（理由见 jsonrpc.ts 顶上那段）。
    const rpc = new NdJsonRpc(this.child.stdout, this.child.stdin)

    rpc.onNotification('session/update', (params) => {
      this.handleUpdate(params as Record<string, unknown>)
    })
    rpc.onRequest('session/request_permission', async (params) => {
      const decision = await this.askPermission(params as Record<string, unknown>)
      if (!decision.optionId) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: decision.optionId } }
    })
    rpc.onRequest('fs/read_text_file', async (params) => {
      const p = params as { path?: string; line?: number; limit?: number }
      const text = await this.readFile(String(p.path ?? ''))
      const lines = text.split('\n')
      const start = Math.max(1, Number(p.line ?? 1))
      const end = p.limit && p.limit > 0 ? start + p.limit - 1 : lines.length
      return { content: lines.slice(start - 1, end).join('\n') }
    })
    rpc.onRequest('fs/write_text_file', async (params) => {
      const p = params as { path?: string; content?: string }
      await this.writeFile(String(p.path ?? ''), String(p.content ?? ''))
      return {}
    })

    this.conn = rpc

    const init = await this.conn.request<{
      protocolVersion?: number
      agentInfo?: { name?: string; title?: string; version?: string }
      agentCapabilities?: Record<string, unknown>
      authMethods?: { id?: string; name?: string; description?: string }[]
    }>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        // 终端这一项我们不实现，所以不声明 —— 声明了 agent 就会来要，
        // 而我们给不出一个能用的终端（那要 node-pty + ConPTY，另一件事）
        terminal: false,
      },
      clientInfo: { name: this.opts.clientName, version: this.opts.clientVersion },
    })

    const session = await this.newSession(cwd, init)

    this.sessionId = String(session.sessionId ?? '')
    if (!this.sessionId) throw new Error('这一家没有给出 sessionId')

    this.capabilities = summarize(init, session)
    this.opts.onEvent({ kind: 'status', text: `${this.opts.entry.title} 已就绪` })
    return this.capabilities
  }

  /**
   * 建会话。
   *
   * 工具包在这里交接：握手之后才知道这一家收不收 http 形态的 MCP，
   * 所以先问出口要声明，再把声明放进 session/new。
   *
   * 报出去的东西被拒了也不该连累整个会话 —— 那一家的适配器认不认这个形态，
   * 只能试。所以带声明失败时退一步再试一次：工具包没有，agent 照样能接上。
   */
  private async newSession(
    cwd: string,
    init: {
      agentCapabilities?: Record<string, unknown>
    },
  ): Promise<AcpSessionResponse> {
    const mcpHttp = readMcpHttp(init)
    let mcpServers: unknown[] = []
    if (this.opts.mcpServers) {
      try {
        mcpServers = await this.opts.mcpServers({ mcpHttp })
      } catch (e) {
        this.opts.log?.('warn', `工具包没挂上：${e instanceof Error ? e.message : String(e)}`)
        mcpServers = []
      }
    }

    const request = { cwd, mcpServers }
    try {
      const session = await this.conn!.request<AcpSessionResponse>('session/new', request)
      this.mcpAccepted = mcpServers.length > 0
      return session
    } catch (e) {
      if (!mcpServers.length || !isInvalidParams(e)) throw e
      this.opts.log?.('warn', '这一家不认带 MCP 声明的建会话请求，退回不带工具包再试一次')
      this.mcpAccepted = false
      return await this.conn!.request<AcpSessionResponse>('session/new', { cwd, mcpServers: [] })
    }
  }

  /** 发一轮。协议上是一次请求，agent 的回答从 session/update 里流回来 */
  async prompt(text: string): Promise<void> {
    if (!this.conn || !this.sessionId) throw new Error('这一家还没接上')
    this.opts.onEvent({ kind: 'status', text: '已送出' })
    const res = await this.conn.request<{ stopReason?: string }>('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    })
    this.opts.onEvent({ kind: 'settled', stopReason: res?.stopReason })
  }

  /** 打断当前这一轮 */
  async cancel(): Promise<void> {
    if (!this.conn || !this.sessionId) return
    try {
      await this.conn.request('session/cancel', { sessionId: this.sessionId })
    } catch (e) {
      this.opts.log?.('warn', `取消失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 改一项设置。
   *
   * 协议把「模式」和「配置项」分成两个方法，所以这里按来源分派：
   * 来自 session/new 的 modes 走 session/set_mode，来自 configOptions 的
   * 走 session/set_config_option。
   *
   * 不按名字分派 —— 实测 opencode 的 config option 就叫「mode」，
   * 而 codex 的 mode 指的是沙箱档位；按名字猜就会把请求发到错误的方法上。
   */
  async setOption(group: { id: string; kind: 'mode' | 'config' }, value: string | boolean): Promise<void> {
    if (!this.conn || !this.sessionId) throw new Error('这一家还没接上')
    if (group.kind === 'mode') {
      await this.conn.request('session/set_mode', { sessionId: this.sessionId, modeId: String(value) })
      return
    }
    // config option 的值有两种形态：字符串（select）与真假（boolean），
    // 协议按值的类型区分，所以原样送过去，不做转换
    await this.conn.request('session/set_config_option', {
      sessionId: this.sessionId,
      configId: group.id,
      value,
    })
  }

  /** 关掉这一家：先断协议，再杀进程 */
  async stop(): Promise<void> {
    this.closed = true
    this.releaseWaiting('已停止')
    try {
      this.conn?.close()
    } catch {
      /* 连接可能已经断了 */
    }
    const child = this.child
    this.child = undefined
    this.conn = undefined
    if (child && !child.killed) {
      child.kill()
      // Windows 上 kill 只发信号，进程可能赖着不走：给一点时间再补一刀
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 1500).unref?.()
    }
  }

  /** 进程自己没了（stderr 里有线索）时给一句人话 */
  get stderr(): string {
    return this.stderrTail
  }

  private async askPermission(params: Record<string, unknown>): Promise<AcpPermissionDecision> {
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>
    const options = Array.isArray(params.options) ? params.options : []
    const req: AcpPermissionRequest = {
      id: `p${++this.permissionSeq}`,
      sessionId: String(params.sessionId ?? this.sessionId ?? ''),
      title: String(toolCall.title ?? '这次操作需要你点头'),
      toolKind: typeof toolCall.kind === 'string' ? toolCall.kind : undefined,
      rawInput: toolCall.rawInput,
      options: options.map((o) => {
        const opt = o as Record<string, unknown>
        return {
          optionId: String(opt.optionId ?? ''),
          name: String(opt.name ?? opt.optionId ?? ''),
          kind: String(opt.kind ?? ''),
        }
      }),
    }
    const decision = await new Promise<AcpPermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(req.id)
        resolve({ optionId: null, reason: '超时未确认' })
      }, PERMISSION_TIMEOUT_MS)
      timer.unref?.()
      this.waiting.set(req.id, (d) => {
        clearTimeout(timer)
        resolve(d)
      })
      try {
        void this.opts.onPermission(req).then(
          (d) => {
            const w = this.waiting.get(req.id)
            if (w) w(d)
          },
          () => {
            const w = this.waiting.get(req.id)
            if (w) w({ optionId: null, reason: '宿主出错' })
          },
        )
      } catch {
        const w = this.waiting.get(req.id)
        if (w) w({ optionId: null, reason: '宿主出错' })
      }
    })
    return decision
  }

  /** 用户在界面上点了某个选项 */
  respondPermission(id: string, decision: AcpPermissionDecision): boolean {
    const w = this.waiting.get(id)
    if (!w) return false
    this.waiting.delete(id)
    w(decision)
    return true
  }

  private releaseWaiting(reason: string): void {
    for (const [, w] of this.waiting) w({ optionId: null, reason })
    this.waiting.clear()
  }

  /** 把协议的 session/update 翻译成中性事件 */
  private handleUpdate(params: Record<string, unknown>): void {
    const update = (params.update ?? {}) as Record<string, unknown>
    const kind = String(update.sessionUpdate ?? '')
    switch (kind) {
      case 'agent_message_chunk':
        this.opts.onEvent({ kind: 'text', delta: contentText(update.content) })
        return
      case 'agent_thought_chunk':
        this.opts.onEvent({ kind: 'thinking', delta: contentText(update.content) })
        return
      case 'user_message_chunk':
        return
      case 'tool_call':
        this.opts.onEvent({
          kind: 'tool-call',
          id: String(update.toolCallId ?? ''),
          title: String(update.title ?? ''),
          name: typeof update.name === 'string' ? update.name : undefined,
          toolKind: typeof update.kind === 'string' ? update.kind : undefined,
          status: typeof update.status === 'string' ? update.status : undefined,
        })
        return
      case 'tool_call_update': {
        const { text, diffs } = toolOutputParts(update.content)
        // locations 是协议给的「这一步碰了哪些文件」：有的 agent 不给 diff 只给路径，
        // 那时审查面板没东西可画，但输入坞上仍要说清这一轮动过哪些文件
        const locations = Array.isArray(update.locations)
          ? update.locations
              .map((l) => String((l as Record<string, unknown>).path ?? ''))
              .filter(Boolean)
          : []
        this.opts.onEvent({
          kind: 'tool-result',
          id: String(update.toolCallId ?? ''),
          status: typeof update.status === 'string' ? update.status : undefined,
          text: text || undefined,
          diffs: diffs.length ? diffs : undefined,
          locations: locations.length ? locations : undefined,
        })
        return
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : []
        this.opts.onEvent({
          kind: 'plan',
          entries: entries.map((e) => {
            const item = e as Record<string, unknown>
            return {
              content: String(item.content ?? ''),
              status: String(item.status ?? 'pending'),
              priority: typeof item.priority === 'string' ? item.priority : undefined,
            }
          }),
        })
        return
      }
      case 'current_mode_update':
        this.opts.onEvent({
          kind: 'mode',
          optionId: 'mode',
          value: String(update.currentModeId ?? ''),
        })
        return
      case 'config_option_update': {
        /*
         * 协议给的是「一份选项清单」，不是「某一项变了」：
         * 每个元素带自己的 id 与当前值。所以这里逐项发事件，
         * 界面按 id 覆盖自己那份下拉组的当前值。
         */
        const list = Array.isArray(update.configOptions) ? update.configOptions : []
        for (const raw of list) {
          const opt = raw as Record<string, unknown>
          const id = String(opt.id ?? '')
          if (!id) continue
          this.opts.onEvent({
            kind: 'mode',
            optionId: id,
            value: typeof opt.currentValue === 'boolean' ? String(opt.currentValue) : String(opt.currentValue ?? ''),
            name: typeof opt.name === 'string' ? opt.name : undefined,
          })
        }
        return
      }
      case 'usage_update':
        this.opts.onEvent({
          kind: 'usage',
          input: numberOrUndef(update.inputTokens ?? update.input),
          output: numberOrUndef(update.outputTokens ?? update.output),
          totalTokens: numberOrUndef(update.totalTokens),
          cost: numberOrUndef(update.cost),
        })
        return
      case 'notice':
        this.opts.onEvent({ kind: 'notice', text: contentText(update.content) || String(update.message ?? '') })
        return
      case 'session_info_update':
      case 'available_commands_update':
      case 'compaction_update':
      case 'compaction_summary_chunk':
      default:
        return
    }
  }

  /**
   * fs 通道的授权边界：只有会话目录与用户另外授权过的目录。
   *
   * 相对路径按**会话目录**解，不按主进程的当前目录 —— agent 眼里的工作目录
   * 就是会话目录，按别的地方解会让「相对路径」这件事失去意义。
   */
  private assertPath(target: string): string {
    const root = path.resolve(this.opts.cwd)
    const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target)
    const roots = [root, ...(this.opts.extraDirs ?? [])]
    if (!pathWithinRoots(resolved, roots)) throw new Error(`路径不在本次会话的授权目录内：${resolved}`)
    return resolved
  }

  private async readFile(target: string): Promise<string> {
    const resolved = this.assertPath(target)
    return fs.readFile(resolved, 'utf8')
  }

  private async writeFile(target: string, content: string): Promise<void> {
    const resolved = this.assertPath(target)
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    await fs.writeFile(resolved, content, 'utf8')
  }
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 握手协商出来的「这一家吃不吃 http 形态的 MCP」。
 *
 * 没有这一项就是不吃 —— 协议说「能」才是能。实测 pi 的适配器压根不读 mcpServers，
 * 而 codex 遇到不认识的形态会直接 invalidParams，所以这个判断必须按协商结果来，
 * 不能按「大家都支持」来。
 */
function readMcpHttp(init: { agentCapabilities?: Record<string, unknown> }): boolean {
  const mcp = (init.agentCapabilities?.mcpCapabilities ?? {}) as Record<string, unknown>
  return mcp.http === true
}

/**
 * 这个错是不是「参数不认」。
 *
 * 只在带工具包声明失败时才认这一种：别的错（网络、超时、agent 自己挂了）
 * 重试没有意义，还可能留下一个野会话。
 */
function isInvalidParams(e: unknown): boolean {
  const code = (e as { code?: unknown } | undefined)?.code
  return code === -32602
}

/**
 * 把协议里的候选项摊平成一张表。
 *
 * 协议允许两种形态：平的候选列表，或者带分组的（每组自己一个 group 名）。
 * 分组只是排版，界面要的是「有哪些值可选」，所以摊平后把组名并进说明里 ——
 * 但值本身一点不改：发给 agent 回去的还是那个 value。
 */
function flattenConfigOptions(
  options:
    | Array<
        | { value?: string; name?: string; description?: string }
        | { group?: string; name?: string; options?: Array<{ value?: string; name?: string; description?: string }> }
      >
    | undefined,
): AcpSelectOption[] {
  const out: AcpSelectOption[] = []
  for (const raw of options ?? []) {
    const o = raw as Record<string, unknown>
    if (typeof o.group === 'string') {
      const groupName = String(o.name ?? o.group)
      for (const inner of (o.options ?? []) as Array<Record<string, unknown>>) {
        out.push({
          value: String(inner.value ?? ''),
          name: String(inner.name ?? inner.value ?? ''),
          description: [groupName, inner.description].filter(Boolean).join(' · ') || undefined,
        })
      }
      continue
    }
    out.push({
      value: String(o.value ?? ''),
      name: String(o.name ?? o.value ?? ''),
      description: typeof o.description === 'string' ? o.description : undefined,
    })
  }
  return out
}

/**
 * 把握手结果压成一张「这一家能干什么」的表。
 *
 * 刻意不解释各家 modes 的含义：实测四家返回的 mode 分别是权限模式、沙箱档位、
 * 思考档和（没有），语义全不相同。界面按数据渲染成通用下拉，含义由各自的名字说明。
 */
function summarize(
  init: {
    protocolVersion?: number
    agentInfo?: { name?: string; title?: string; version?: string }
    agentCapabilities?: Record<string, unknown>
    authMethods?: { id?: string; name?: string; description?: string }[]
  },
  session: AcpSessionResponse,
): AcpCapabilities {
  const caps = init.agentCapabilities ?? {}
  const selects: AcpSelectGroup[] = []
  const modes = session.modes
  if (modes?.availableModes?.length) {
    selects.push({
      id: 'mode',
      name: '模式',
      category: 'mode',
      kind: 'mode',
      type: 'select',
      currentValue: modes.currentModeId,
      // 免掉全部授权的那一档不往下发：界面看不到它，主进程也不会替用户点它
      options: modes.availableModes
        .filter((m) => !isBlockedAcpOption(String(m.id ?? '')))
        .map((m) => ({
          value: String(m.id ?? ''),
          name: String(m.name ?? m.id ?? ''),
          description: m.description ?? undefined,
        })),
    })
  }
  for (const opt of session.configOptions ?? []) {
    const id = String(opt.id ?? '')
    if (!id) continue
    const group: AcpSelectGroup = {
      id,
      name: String(opt.name ?? id),
      category: opt.category,
      kind: 'config',
      type: String(opt.type ?? 'select'),
      currentValue: typeof opt.currentValue === 'boolean' ? opt.currentValue : opt.currentValue,
      options: flattenConfigOptions(opt.options).filter((o) => !isBlockedAcpOption(o.value)),
    }
    const existing = selects.find((s) => s.id === id)
    if (existing) {
      existing.currentValue = group.currentValue ?? existing.currentValue
      existing.options = group.options.length ? group.options : existing.options
      continue
    }
    selects.push(group)
  }
  const sessionCaps = (caps.sessionCapabilities ?? {}) as Record<string, unknown>
  const promptCaps = (caps.promptCapabilities ?? {}) as Record<string, unknown>
  const mcpCaps = (caps.mcpCapabilities ?? {}) as Record<string, unknown>
  return {
    protocolVersion: Number(init.protocolVersion ?? PROTOCOL_VERSION),
    agentName: init.agentInfo?.name,
    agentTitle: init.agentInfo?.title,
    agentVersion: init.agentInfo?.version,
    loadSession: caps.loadSession === true,
    mcpHttp: mcpCaps.http === true,
    mcpSse: mcpCaps.sse === true,
    sessionCapabilities: Object.keys(sessionCaps),
    promptCapabilities: Object.keys(promptCaps),
    authMethods: (init.authMethods ?? []).map((m) => ({
      id: String(m.id ?? ''),
      name: String(m.name ?? m.id ?? ''),
      description: m.description ?? undefined,
    })),
    selects,
  }
}
