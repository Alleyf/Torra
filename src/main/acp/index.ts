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
import { findAgent, listAgents } from './registry'
import type {
  AcpAgentEntry,
  AcpCapabilities,
  AcpEvent,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpProbeResult,
} from './types'

export interface AcpServiceOptions {
  /** userData 根目录；用户自定义条目放在 <userData>/torra/acp.json */
  userDataDir: string
  clientName: string
  clientVersion: string
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 事件出口：中性事件词表，渲染层照它画 */
  onEvent?: (agentId: string, event: AcpEvent) => void
  /** 授权请求出口：把 agent 的请求转给用户 */
  onPermission?: (agentId: string, request: AcpPermissionRequest) => void
}

export interface AcpStartOptions {
  /** 会话工作目录；不给就用当前进程的工作目录 */
  cwd?: string
  /** 用户另外授权过的目录 */
  extraDirs?: string[]
  /** 交给 agent 的 MCP 服务 */
  mcpServers?: unknown[]
}

export class AcpService {
  private readonly opts: AcpServiceOptions
  private client?: AcpClient
  private activeId?: string
  /** 授权请求挂起时，渲染层回话要靠它对上号 */
  private pendingPermissions = new Map<string, { agentId: string; request: AcpPermissionRequest }>()

  constructor(opts: AcpServiceOptions) {
    this.opts = opts
  }

  /** 有哪些 agent 可用，外加用户自定义条目里的毛病 */
  list(): { entries: AcpAgentEntry[]; problems: string[] } {
    return listAgents(this.opts.userDataDir)
  }

  /** 当前挂着的是谁 */
  get active(): { agentId: string; capabilities: AcpCapabilities } | undefined {
    if (!this.activeId || !this.client) return undefined
    const caps = this.client.caps
    return caps ? { agentId: this.activeId, capabilities: caps } : undefined
  }

  /**
   * 预检：起一次、握手、建会话、看协商结果，然后收摊。
   *
   * 刻意不发 prompt —— 预检要的是「能不能接上」，不是「能不能干活」。
   * 打一次模型来验证接得上，既花钱又慢，还会让用户以为已经开始了。
   */
  async probe(agentId: string, opts: AcpStartOptions = {}): Promise<AcpProbeResult> {
    const entry = findAgent(this.opts.userDataDir, agentId)
    const started = Date.now()
    if (!entry) {
      return { ok: false, agentId, elapsedMs: 0, error: `注册表里没有「${agentId}」这一家` }
    }
    const client = new AcpClient({
      entry,
      cwd: opts.cwd ?? process.cwd(),
      clientName: this.opts.clientName,
      clientVersion: this.opts.clientVersion,
      onEvent: () => {},
      onPermission: async () => ({ optionId: null, reason: '预检不请求授权' }),
      extraDirs: opts.extraDirs,
      mcpServers: opts.mcpServers,
      log: this.opts.log,
    })
    try {
      const capabilities = await client.start()
      return {
        ok: true,
        agentId,
        agentTitle: capabilities.agentTitle ?? entry.title,
        elapsedMs: Date.now() - started,
        capabilities,
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      const stderr = client.stderr.trim()
      return {
        ok: false,
        agentId,
        agentTitle: entry.title,
        elapsedMs: Date.now() - started,
        error: stderr ? `${detail}\n${stderr.slice(-600)}` : detail,
      }
    } finally {
      await client.stop()
    }
  }

  /** 接上某一家：先送走上一家 */
  async start(agentId: string, opts: AcpStartOptions = {}): Promise<{ ok: boolean; agentId?: string; capabilities?: AcpCapabilities; error?: string }> {
    const entry = findAgent(this.opts.userDataDir, agentId)
    if (!entry) return { ok: false, error: `注册表里没有「${agentId}」这一家` }
    await this.stop()
    const client = new AcpClient({
      entry,
      cwd: opts.cwd ?? process.cwd(),
      clientName: this.opts.clientName,
      clientVersion: this.opts.clientVersion,
      onEvent: (event) => this.opts.onEvent?.(agentId, event),
      onPermission: async (request) => {
        this.pendingPermissions.set(request.id, { agentId, request })
        this.opts.onPermission?.(agentId, request)
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
        })
      },
      extraDirs: opts.extraDirs,
      mcpServers: opts.mcpServers,
      log: this.opts.log,
    })
    try {
      const capabilities = await client.start()
      this.client = client
      this.activeId = agentId
      return { ok: true, agentId, capabilities }
    } catch (e) {
      await client.stop()
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
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

  /** 送走当前这一家 */
  async stop(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.activeId = undefined
    for (const [, resolve] of this.resolvers) resolve({ optionId: null, reason: '已停止' })
    this.resolvers.clear()
    this.pendingPermissions.clear()
    await client?.stop()
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
    if (caps && !caps.mcpHttp) {
      lines.push('这一家不收 http 形态的 MCP 服务，Torra 的工具包它拿不到')
    }
    return lines.join('\n')
  }

  /** 预检用的工作目录：默认取当前进程的工作目录 */
  defaultCwd(): string {
    return path.resolve(process.cwd())
  }
}
