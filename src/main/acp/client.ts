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
import { loadAcpSdk, type AcpConnection, type AcpSdkSurface } from './sdk'
import type {
  AcpAgentEntry,
  AcpCapabilities,
  AcpEvent,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpSelectGroup,
} from './types'

/** 协议版本：ACP v1 */
const PROTOCOL_VERSION = 1
/** 授权请求多久没人管就当拒绝 —— agent 在等，不能无限期挂着 */
const PERMISSION_TIMEOUT_MS = 5 * 60_000
/** stderr 只留尾巴：适配器爱打日志，全存会撑爆内存 */
const STDERR_TAIL_MAX = 4000

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
  /** 交给 agent 的 MCP 服务（Torra 自己的工具包走这条） */
  mcpServers?: unknown[]
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

/** 工具调用结果里的内容：可能是文本块，也可能是 diff */
function toolOutputText(content: unknown): string {
  if (!Array.isArray(content)) return contentText(content)
  return content
    .map((item) => {
      if (item && typeof item === 'object' && 'type' in item) {
        const t = (item as Record<string, unknown>).type
        if (t === 'diff') {
          const d = item as Record<string, unknown>
          const path = typeof d.path === 'string' ? d.path : ''
          const oldText = typeof d.oldText === 'string' ? d.oldText : ''
          const newText = typeof d.newText === 'string' ? d.newText : ''
          return `--- ${path}\n${oldText}\n+++\n${newText}`
        }
      }
      return contentText(item)
    })
    .filter(Boolean)
    .join('\n')
}

export class AcpClient {
  private readonly opts: AcpClientOptions
  private child?: ChildProcessWithoutNullStreams
  private conn?: AcpConnection
  private sdk?: AcpSdkSurface
  private sessionId?: string
  private capabilities?: AcpCapabilities
  private stderrTail = ''
  private closed = false
  /** 授权请求的等待者：id → 决定 */
  private readonly waiting = new Map<string, (decision: AcpPermissionDecision) => void>()
  private permissionSeq = 0

  constructor(opts: AcpClientOptions) {
    this.opts = opts
  }

  get session(): string | undefined {
    return this.sessionId
  }

  get caps(): AcpCapabilities | undefined {
    return this.capabilities
  }

  /** 握手 + 建会话。失败要抛出去 —— 预检靠它判断「这一家能不能接」 */
  async start(): Promise<AcpCapabilities> {
    const sdk = await loadAcpSdk()
    this.sdk = sdk
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

    const { Readable, Writable } = await import('node:stream')
    const output = Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>
    const input = Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
    const stream = sdk.ndJsonStream(output, input)

    const app = sdk.client({ name: this.opts.clientName })
    app.onNotification('session/update', (ctx) => {
      this.handleUpdate(ctx.params as Record<string, unknown>)
    })
    app.onRequest('session/request_permission', async (ctx) => {
      const decision = await this.askPermission(ctx.params as Record<string, unknown>)
      if (!decision.optionId) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: decision.optionId } }
    })
    app.onRequest('fs/read_text_file', async (ctx) => {
      const p = ctx.params as { path?: string; line?: number; limit?: number }
      const text = await this.readFile(String(p.path ?? ''))
      const lines = text.split('\n')
      const start = Math.max(1, Number(p.line ?? 1))
      const end = p.limit && p.limit > 0 ? start + p.limit - 1 : lines.length
      return { content: lines.slice(start - 1, end).join('\n') }
    })
    app.onRequest('fs/write_text_file', async (ctx) => {
      const p = ctx.params as { path?: string; content?: string }
      await this.writeFile(String(p.path ?? ''), String(p.content ?? ''))
      return {}
    })

    this.conn = app.connect(stream)

    const init = await this.conn.agent.request<{
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

    const session = await this.conn.agent.request<{
      sessionId?: string
      modes?: { currentModeId?: string; availableModes?: { id?: string; name?: string; description?: string }[] }
      configOptions?: {
        id?: string
        name?: string
        category?: string
        type?: string
        currentValue?: string
        options?: { value?: string; name?: string; description?: string }[]
      }[]
    }>('session/new', {
      cwd,
      mcpServers: this.opts.mcpServers ?? [],
    })

    this.sessionId = String(session.sessionId ?? '')
    if (!this.sessionId) throw new Error('这一家没有给出 sessionId')

    this.capabilities = summarize(init, session)
    this.opts.onEvent({ kind: 'status', text: `${this.opts.entry.title} 已就绪` })
    return this.capabilities
  }

  /** 发一轮。协议上是一次请求，agent 的回答从 session/update 里流回来 */
  async prompt(text: string): Promise<void> {
    if (!this.conn || !this.sessionId) throw new Error('这一家还没接上')
    this.opts.onEvent({ kind: 'status', text: '已送出' })
    const res = await this.conn.agent.request<{ stopReason?: string }>('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    })
    this.opts.onEvent({ kind: 'settled', stopReason: res?.stopReason })
  }

  /** 打断当前这一轮 */
  async cancel(): Promise<void> {
    if (!this.conn || !this.sessionId) return
    try {
      await this.conn.agent.request('session/cancel', { sessionId: this.sessionId })
    } catch (e) {
      this.opts.log?.('warn', `取消失败：${e instanceof Error ? e.message : String(e)}`)
    }
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
        const text = toolOutputText(update.content)
        this.opts.onEvent({
          kind: 'tool-result',
          id: String(update.toolCallId ?? ''),
          status: typeof update.status === 'string' ? update.status : undefined,
          text: text || undefined,
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
      case 'config_option_update':
        this.opts.onEvent({
          kind: 'mode',
          optionId: String(update.id ?? update.optionId ?? ''),
          value: String(update.value ?? ''),
        })
        return
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

  /** fs 通道的授权边界：只有会话目录与用户另外授权过的目录 */
  private assertPath(target: string): string {
    const resolved = path.resolve(target)
    const roots = [this.opts.cwd, ...(this.opts.extraDirs ?? [])].map((r) => path.resolve(r))
    const ok = roots.some((r) => resolved === r || resolved.startsWith(r + path.sep))
    if (!ok) throw new Error(`路径不在本次会话的授权目录内：${resolved}`)
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
  session: {
    modes?: { currentModeId?: string; availableModes?: { id?: string; name?: string; description?: string }[] }
    configOptions?: {
      id?: string
      name?: string
      category?: string
      type?: string
      currentValue?: string
      options?: { value?: string; name?: string; description?: string }[]
    }[]
  },
): AcpCapabilities {
  const caps = init.agentCapabilities ?? {}
  const selects: AcpSelectGroup[] = []
  const modes = session.modes
  if (modes?.availableModes?.length) {
    selects.push({
      id: 'mode',
      name: '模式',
      category: 'mode',
      type: 'select',
      currentValue: modes.currentModeId,
      options: modes.availableModes.map((m) => ({
        value: String(m.id ?? ''),
        name: String(m.name ?? m.id ?? ''),
        description: m.description ?? undefined,
      })),
    })
  }
  for (const opt of session.configOptions ?? []) {
    const id = String(opt.id ?? '')
    if (!id) continue
    const existing = selects.find((s) => s.id === id)
    const group: AcpSelectGroup = {
      id,
      name: String(opt.name ?? id),
      category: opt.category,
      type: String(opt.type ?? 'select'),
      currentValue: opt.currentValue,
      options: (opt.options ?? []).map((o) => ({
        value: String(o.value ?? ''),
        name: String(o.name ?? o.value ?? ''),
        description: o.description ?? undefined,
      })),
    }
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
