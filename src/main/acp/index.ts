/**
 * ACP 服务：Torra 侧的门面。
 *
 * 它管三件事 —— 有哪些 agent 可用（注册表）、某一家能不能接上（预检）、
 * 现在挂着的那一家（会话与事件出口）。渲染层只跟这一层说话，
 * 不直接碰子进程与协议。
 *
 * 同一时刻只挂一家：助手抽屉本来就是一位助手的位置，接第二家之前先把上一家送走。
 */
import path from 'node:path'
import { AcpClient } from './client'
import { findAgent, listAgents, overridesPath, removeOverride, saveOverride } from './registry'
import { matrixProvenance, matrixStatus } from './matrix'
import { classifyProbeFailure, redactSecrets } from './diagnose'
import { buildAcpMcpTools, mcpDeclaration, startAcpMcpServer, type AcpMcpServerHandle } from './mcp'
import type { AssistantCaps } from '../assistant/tools'
import type {
  AcpAgentEntry,
  AcpCapabilities,
  AcpEvent,
  AcpMatrixStatus,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpProbeResult,
  AcpStartResult,
  AcpToolPackView,
} from '../../shared/acp'
import { isBlockedAcpOption } from '../../shared/acp'

export interface AcpServiceOptions {
  /**
   * Electron 的 userData 根目录；用户自定义条目落在 `<userDataRoot>/torra/acp.json`。
   *
   * 传函数是因为这层在模块加载时就构造，而 userData 要等 app ready 才有值。
   */
  userDataRoot: string | (() => string)
  clientName: string
  clientVersion: string
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 事件出口：中性事件词表，渲染层照它画 */
  onEvent?: (agentId: string, event: AcpEvent) => void
  /** 授权请求出口：把 agent 的请求转给用户 */
  onPermission?: (agentId: string, request: AcpPermissionRequest) => void
  /**
   * Torra 的能力（助手那套工具的入口）。给了才能把工具包端成 MCP 交给 agent。
   *
   * 传函数而不是值：这层构造得比助手桥早，桥什么时候就绪是运行时的事。
   */
  caps?: () => AssistantCaps | undefined
}

export interface AcpStartOptions {
  /** 会话工作目录；不给就用当前进程的工作目录 */
  cwd?: string
  /** 用户另外授权过的目录 */
  extraDirs?: string[]
}

export class AcpService {
  private readonly opts: AcpServiceOptions
  private client?: AcpClient
  private activeId?: string
  /** 授权请求挂起时，渲染层回话要靠它对上号 */
  private pendingPermissions = new Map<string, { agentId: string; request: AcpPermissionRequest }>()
  /** 本次会话端起来的 MCP 服务（Torra 的工具包） */
  private mcpServer?: AcpMcpServerHandle
  /** 工具包挂上去没有：挂不上去要能说清为什么 */
  private toolPack?: AcpToolPackView

  constructor(opts: AcpServiceOptions) {
    this.opts = opts
  }

  /** userData 根目录：每问一次取一次，避免缓存住 app ready 之前的空值 */
  private get userData(): string {
    return typeof this.opts.userDataRoot === 'function' ? this.opts.userDataRoot() : this.opts.userDataRoot
  }

  /** 有哪些 agent 可用，外加用户自定义条目里的毛病 */
  list(): { entries: AcpAgentEntry[]; problems: string[] } {
    return listAgents(this.userData)
  }

  /**
   * 列表视图：注册表 + 毛病 + 每一家的验过状态。
   *
   * 矩阵要跟着条目一起给界面：光列「有 Claude Code」没用，
   * 用户要看到的是「这一版验过，能直接接」还是「还没验过，接之前先预检」。
   */
  listView(): {
    entries: AcpAgentEntry[]
    problems: string[]
    matrix: Record<string, AcpMatrixStatus>
    provenance: { generatedBy?: string; note?: string }
  } {
    const { entries, problems } = this.list()
    const matrix: Record<string, AcpMatrixStatus> = {}
    for (const e of entries) matrix[e.id] = matrixStatus(e)
    return { entries, problems, matrix, provenance: matrixProvenance() }
  }

  /** 当前挂着的是谁 */
  get active(): { agentId: string; capabilities: AcpCapabilities } | undefined {
    if (!this.activeId || !this.client) return undefined
    const caps = this.client.caps
    return caps ? { agentId: this.activeId, capabilities: caps } : undefined
  }

  /** 用户自定义条目落在哪儿（界面上告诉用户「自己改这个文件也行」） */
  get registryPath(): string {
    return overridesPath(this.userData)
  }

  /** 存一条用户自定义条目 */
  saveEntry(raw: unknown): { ok: true; entry: AcpAgentEntry } | { ok: false; reason: string } {
    return saveOverride(this.userData, raw)
  }

  /** 删掉一条用户自定义条目 */
  removeEntry(id: string): { ok: true } | { ok: false; reason: string } {
    return removeOverride(this.userData, id)
  }

  /**
   * 端起 Torra 的工具包，并把声明交给 agent。
   *
   * 挂不挂得上、为什么挂不上，都在这一处定：
   *   - 这一家不收 http 形态的 MCP（协商结果说了算）→ 不端服务，说明原因
   *   - Torra 这一侧还没有工具 → 不端服务
   *   - 端起来了 → 把地址与令牌写进声明
   *
   * 失败一律不抛。工具包是加分项，不是「接得上」的前提 ——
   * 挂不上也要让 agent 能干活，只是它少两只手。
   */
  private async provideToolPack(info: { mcpHttp: boolean }): Promise<{
    declarations: unknown[]
    view: AcpToolPackView
    handle?: AcpMcpServerHandle
  }> {
    if (!info.mcpHttp) {
      return {
        declarations: [],
        view: { attached: false, tools: 0, reason: '这一家不收 http 形态的 MCP，工具包挂不上' },
      }
    }
    const caps = this.opts.caps?.()
    if (!caps) {
      return {
        declarations: [],
        view: { attached: false, tools: 0, reason: 'Torra 的工具还没就绪，工具包挂不上' },
      }
    }
    try {
      const tools = await buildAcpMcpTools(caps)
      if (!tools.length) {
        return {
          declarations: [],
          view: { attached: false, tools: 0, reason: 'Torra 这一侧没有可交出去的工具' },
        }
      }
      const handle = await startAcpMcpServer(tools)
      return {
        declarations: [mcpDeclaration(handle)],
        view: { attached: true, tools: handle.toolCount },
        handle,
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      this.opts.log?.('warn', `工具包没挂上：${reason}`)
      return {
        declarations: [],
        view: { attached: false, tools: 0, reason: `工具包没挂上：${reason}` },
      }
    }
  }

  /**
   * 预检：起一次、握手、建会话、看协商结果，然后收摊。
   *
   * 刻意不发 prompt —— 预检要的是「能不能接上」，不是「能不能干活」。
   * 打一次模型来验证接得上，既花钱又慢，还会让用户以为已经开始了。
   *
   * 工具包也一起预检：这一家肯不肯收 MCP、收不收得下 Torra 的工具，
   * 都在建会话那一刻就知道，不必等到用户真的派活时才发现少两只手。
   */
  async probe(agentId: string, opts: AcpStartOptions = {}): Promise<AcpProbeResult> {
    const entry = findAgent(this.userData, agentId)
    const started = Date.now()
    if (!entry) {
      return { ok: false, agentId, elapsedMs: 0, error: `注册表里没有「${agentId}」这一家` }
    }
    let packView: AcpToolPackView | undefined
    let packHandle: AcpMcpServerHandle | undefined
    const client = new AcpClient({
      entry,
      cwd: opts.cwd ?? process.cwd(),
      clientName: this.opts.clientName,
      clientVersion: this.opts.clientVersion,
      onEvent: () => {},
      onPermission: async () => ({ optionId: null, reason: '预检不请求授权' }),
      extraDirs: opts.extraDirs,
      mcpServers: async (info) => {
        const r = await this.provideToolPack(info)
        packView = r.view
        packHandle = r.handle
        return r.declarations
      },
      log: this.opts.log,
    })
    try {
      const capabilities = await client.start()
      if (packHandle && !client.toolPackAccepted) {
        await packHandle.close()
        packHandle = undefined
        packView = { attached: false, tools: 0, reason: '这一家不认带 MCP 声明的建会话请求，工具包挂不上' }
      }
      if (packView) capabilities.toolPack = packView
      return {
        ok: true,
        agentId,
        agentTitle: capabilities.agentTitle ?? entry.title,
        elapsedMs: Date.now() - started,
        capabilities,
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      const stderr = redactSecrets(client.stderr.trim())
      return {
        ok: false,
        agentId,
        agentTitle: entry.title,
        elapsedMs: Date.now() - started,
        error: stderr ? `${redactSecrets(detail)}\n${stderr.slice(-600)}` : redactSecrets(detail),
        verdict: classifyProbeFailure(detail, stderr, entry.title),
      }
    } finally {
      await client.stop()
      await packHandle?.close()
    }
  }

  /** 接上某一家：先送走上一家 */
  async start(agentId: string, opts: AcpStartOptions = {}): Promise<AcpStartResult> {
    const entry = findAgent(this.userData, agentId)
    if (!entry) return { ok: false, error: `注册表里没有「${agentId}」这一家` }
    await this.stop()
    let packView: AcpToolPackView | undefined
    let packHandle: AcpMcpServerHandle | undefined
    const client = new AcpClient({
      entry,
      cwd: opts.cwd ?? process.cwd(),
      clientName: this.opts.clientName,
      clientVersion: this.opts.clientVersion,
      onEvent: (event) => this.opts.onEvent?.(agentId, event),
      onPermission: async (request) => {
        this.pendingPermissions.set(request.id, { agentId, request })
        return new Promise<AcpPermissionDecision>((resolve) => {
          const timer = setTimeout(() => {
            if (this.pendingPermissions.delete(request.id)) {
              resolve({ optionId: null, reason: '超时未确认' })
            }
          }, 5 * 60_000)
          timer.unref?.()
          this.resolvers.set(request.id, (d) => {
            clearTimeout(timer)
            resolve(d)
          })
          // 先把回话的入口登记好，再去通知界面。
          // 顺序反了的话，界面在同一拍里回话就找不到人接 —— 授权会被静默丢掉，
          // 而 agent 那边还在等，等到超时。
          this.opts.onPermission?.(agentId, request)
        })
      },
      extraDirs: opts.extraDirs,
      mcpServers: async (info) => {
        const r = await this.provideToolPack(info)
        packView = r.view
        packHandle = r.handle
        return r.declarations
      },
      log: this.opts.log,
    })
    try {
      const capabilities = await client.start()
      // 这一家退回了不带声明的建会话 → 工具包其实没挂上，服务要收掉
      if (packHandle && !client.toolPackAccepted) {
        await packHandle.close()
        packHandle = undefined
        packView = { attached: false, tools: 0, reason: '这一家不认带 MCP 声明的建会话请求，工具包挂不上' }
      }
      this.client = client
      this.activeId = agentId
      this.mcpServer = packHandle
      this.toolPack = packView
      if (packView) capabilities.toolPack = packView
      return { ok: true, agentId, capabilities }
    } catch (e) {
      await client.stop()
      await packHandle?.close()
      const detail = redactSecrets(e instanceof Error ? e.message : String(e))
      return {
        ok: false,
        error: detail,
        verdict: classifyProbeFailure(detail, client.stderr, entry.title),
      }
    }
  }

  private resolvers = new Map<string, (d: AcpPermissionDecision) => void>()

  /** 发一轮 */
  async prompt(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: '现在没有挂着任何 agent' }
    try {
      await this.client.prompt(text)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 打断当前这一轮 */
  async cancel(): Promise<void> {
    await this.client?.cancel()
  }

  /**
   * 改一项设置（下拉项）。
   *
   * 只认协议给的项：先在协商结果里找到这一组，找不到就拒绝 ——
   * 不往 agent 发明协议里没有的参数，它要么报错，要么按自己的理解执行。
   */
  async setOption(optionId: string, value: string | boolean): Promise<{ ok: boolean; error?: string }> {
    const client = this.client
    if (!client) return { ok: false, error: '现在没有挂着任何 agent' }
    const group = client.caps?.selects.find((s) => s.id === optionId)
    if (!group) return { ok: false, error: `这一家没有「${optionId}」这一项` }
    // 免掉全部授权的那一档不发出去。协商结果里已经把它摘掉了，
    // 这里再挡一道是为了防渲染层绕过界面直接调 IPC。
    if (typeof value === 'string' && isBlockedAcpOption(value)) {
      return { ok: false, error: '这一档 Torra 不开放：它会让 agent 不再问就把所有事做完' }
    }
    try {
      await client.setOption(group, value)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 送走当前这一家 */
  async stop(): Promise<void> {
    const client = this.client
    const server = this.mcpServer
    this.client = undefined
    this.activeId = undefined
    this.mcpServer = undefined
    this.toolPack = undefined
    for (const [, resolve] of this.resolvers) resolve({ optionId: null, reason: '已停止' })
    this.resolvers.clear()
    this.pendingPermissions.clear()
    await client?.stop()
    // 工具包的服务也收掉：不收的话本机还留着一个带令牌的端口
    await server?.close()
  }

  /** 渲染层回话：用户在授权卡上点了哪一项 */
  respondPermission(id: string, decision: AcpPermissionDecision): boolean {
    const pending = this.pendingPermissions.get(id)
    this.pendingPermissions.delete(id)
    const resolve = this.resolvers.get(id)
    this.resolvers.delete(id)
    if (!resolve) return false
    resolve(decision)
    this.opts.onEvent?.(pending?.agentId ?? this.activeId ?? '', {
      kind: 'notice',
      text: decision.optionId ? '你已允许这一步' : '你拒绝了这一步',
    })
    return true
  }

  /** 当前会话的 id（存盘、恢复用） */
  get sessionId(): string | undefined {
    return this.client?.session
  }

  /** 供界面读的一份说明：这一家能干什么、要怎么登录 */
  static describe(entry: AcpAgentEntry, caps?: AcpCapabilities): string {
    const lines: string[] = [entry.blurb]
    if (entry.notes.length) lines.push(...entry.notes)
    if (caps?.authMethods.length) {
      lines.push(
        `登录方式：${caps.authMethods.map((m) => m.name).join('、')}`,
      )
    } else if (entry.authHint) {
      lines.push(entry.authHint)
    }
    if (caps?.toolPack) {
      if (caps.toolPack.attached) {
        lines.push(`Torra 的工具包已挂上：${caps.toolPack.tools} 个工具`)
      } else if (caps.toolPack.reason) {
        lines.push(caps.toolPack.reason)
      }
    } else if (caps && !caps.mcpHttp) {
      lines.push('这一家不收 http 形态的 MCP 服务，Torra 的工具包它拿不到')
    }
    return lines.join('\n')
  }

  /** 预检用的工作目录：默认取当前进程的工作目录 */
  defaultCwd(): string {
    return path.resolve(process.cwd())
  }
}
