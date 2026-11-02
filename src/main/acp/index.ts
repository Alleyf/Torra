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
import {
  curatedView,
  fetchOfficialCatalog,
  fetchOfficialIcon,
  readCachedOfficial,
  splitPkgVersion,
  OFFICIAL_ID_TO_TORRA_ID,
} from './catalog'
import { matrixCell, matrixProvenance, matrixStatus } from './matrix'
import { classifyProbeFailure, redactSecrets } from './diagnose'
import { buildAcpMcpTools, mcpDeclaration, startAcpMcpServer, type AcpMcpServerHandle } from './mcp'
import type { AssistantCaps } from '../assistant/tools'
import { judgeResume, type HostEvent, type HostResume, type HostSnapshot } from '../../shared/host'
import type {
  AcpAgentEntry,
  AcpCapabilities,
  AcpCatalogItem,
  AcpCatalogView,
  AcpMatrixStatus,
  AcpOfficialCatalog,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpProbeResult,
  AcpResumeResult,
  AcpStartResult,
  AcpToolPackView,
  AcpVerdict,
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
  /** 事件出口：Host 领域事件（与 agent 无关，带身份），渲染层照它画 */
  onEvent?: (agentId: string, event: HostEvent) => void
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

  /** 官方目录上一次拉到的结果（内存里；没有就落盘那份缓存） */
  private official?: AcpOfficialCatalog

  /**
   * 目录：可以接进来的那些家。
   *
   * 精选那一份每次都现算 —— 「本机有没有装」是此刻的事实，存进文件就过期了。
   * 官方那一份先看缓存：拉过就用缓存，没拉过就空着，等用户点「拉官方目录」。
   *
   * 每一条都带两个状态：接上之后叫什么（torraId）、是不是已经接上了（registered）。
   * 官方目录与 Torra 内置那四家用的是两套叫法（claude-acp / claude），
   * 不把它们对上，界面上就会出现两条 Claude。
   */
  catalogView(): AcpCatalogView {
    const registered = new Set(this.list().entries.map((e) => e.id))
    const curated = curatedView().map((item) => ({
      ...item,
      torraId: item.id,
      registered: registered.has(item.id),
    }))
    const raw = this.official ?? readCachedOfficial(this.userData)
    const seen = new Set<string>()
    const officialItems = raw.items
      .map((item) => {
        const torraId = OFFICIAL_ID_TO_TORRA_ID[item.id] ?? item.id
        return { ...item, torraId, registered: registered.has(torraId) }
      })
      // 精选里已经有的（同一家的另一种叫法）不重复列：精选那一份写得更全，
      // 官方目录那条只补一个版本号。
      .filter((item) => !curated.some((c) => c.id === item.torraId))
      // opencode 与 opencode-v2 在官方目录里是两条，落到 Torra 里是同一家
      .filter((item) => {
        if (seen.has(item.torraId)) return false
        seen.add(item.torraId)
        return true
      })
    return { curated, official: { ...raw, items: officialItems } }
  }

  /** 拉官方目录（联网）。拉到的条目只进候选区，接不接由用户点 */
  async fetchOfficialCatalog(): Promise<AcpOfficialCatalog> {
    const view = await fetchOfficialCatalog(this.userData)
    this.official = view
    return view
  }

  /** 官方图标：主进程取回来，以 data URI 交给界面（界面的 CSP 不放行那个 CDN） */
  async officialIcon(id: string): Promise<{ ok: true; dataUrl: string } | { ok: false; reason: string }> {
    return fetchOfficialIcon(this.userData, id)
  }

  /**
   * 从目录里接一家。
   *
   * 只有目录里有的才接得上 —— 不是为了防用户，是为了让落盘的条目一定是
   * 我们知道启动方式的那一家：command 与 args 会被拼成一条命令行，
   * 拼错了接不上，拼对了但没装同样接不上。
   *
   * mode='npx' 走的是「不装全局包、临时跑这个包」那条路。
   */
  addFromCatalog(
    id: string,
    mode?: 'local' | 'npx',
  ): { ok: true; entry: AcpAgentEntry } | { ok: false; reason: string } {
    const item = this.findCatalogItem(id)
    if (!item) return { ok: false, reason: `目录里没有「${id}」这一家` }
    const torraId = item.torraId ?? item.id
    if (this.list().entries.some((e) => e.id === torraId)) {
      return { ok: false, reason: `「${item.title}」已经接上了` }
    }
    if (item.unsupported || !item.command) {
      return { ok: false, reason: item.unsupported ?? '这一家没有可用的启动方式' }
    }
    const useNpx = mode === 'npx'
    if (useNpx && !item.npx) {
      return { ok: false, reason: '这一家没有 npx 那条路' }
    }
    const command = useNpx ? 'npx' : item.command
    const args = useNpx ? ['-y', item.npx!.package, ...item.npx!.args] : [...item.args]
    const pkg = useNpx ? splitPkgVersion(item.npx!.package) : item.package
    const notes = [...item.notes]
    if (!useNpx && !item.installed) {
      notes.push('接上的时候本机还没装这一份：先装上再开会话')
    }
    return saveOverride(this.userData, {
      id: torraId,
      title: item.title,
      blurb: item.blurb,
      command,
      args,
      package: pkg,
      authHint: item.authHint,
      notes,
    })
  }

  /** 在目录里找一家（精选 + 官方都算） */
  private findCatalogItem(id: string): AcpCatalogItem | undefined {
    const curated = curatedView()
    const hit = curated.find((c) => c.id === id)
    if (hit) return { ...hit, torraId: hit.id }
    // 官方那一份这次没拉过也别急着说「目录里没有」—— 界面上摆着的是缓存里那一份，
    // 用户点它的时候得接得上，否则就是「看得见、点不动」。
    const official = (this.official ?? readCachedOfficial(this.userData)).items.find((o) => o.id === id)
    if (official) return { ...official, torraId: OFFICIAL_ID_TO_TORRA_ID[official.id] ?? official.id }
    return undefined
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

  /**
   * 接上某一家：先送走上一家。
   *
   * 给了 nativeSessionId 就是去读回一场旧会话（见 resume）。
   */
  async start(agentId: string, opts: AcpStartOptions = {}): Promise<AcpStartResult> {
    const r = await this.attach(agentId, opts)
    if (!r.ok) return { ok: false, error: r.error, verdict: r.verdict }
    return { ok: true, agentId, capabilities: r.capabilities, sessionId: r.sessionId }
  }

  /**
   * 接着聊一场旧的：把这一家的进程拉起来，让它把那一场的历史重播一遍。
   *
   * 真源在这一家自己那儿 —— 读回来的是它留下的历史，不是 Torra 自己那份记录。
   * 读不回来就是读不回来：这里不拿本地那份顶替，而是把失败照实报回去，
   * 让界面说「这一家读不回这一场」。
   */
  async resume(
    agentId: string,
    nativeSessionId: string,
    opts: AcpStartOptions = {},
  ): Promise<AcpResumeResult> {
    if (!nativeSessionId) return { ok: false, error: '没有要接着聊的会话号' }
    const r = await this.attach(agentId, opts, nativeSessionId)
    if (!r.ok) return { ok: false, error: r.error, verdict: r.verdict }
    return {
      ok: true,
      agentId,
      capabilities: r.capabilities,
      sessionId: r.sessionId ?? nativeSessionId,
      snapshot: r.snapshot ?? { nativeSessionId, items: [], turns: [] },
    }
  }

  /**
   * 拉起一家 agent 并接上它。
   *
   * 建会话与读历史走同一条路，差别只在第一个方法名：session/new 还是 session/load。
   * 工具包、授权、事件出口三样都一样，所以收在一处 —— 两份代码迟早会分叉，
   * 而分叉的那一处往往正好是「读历史」这种新加的路径。
   */
  private async attach(
    agentId: string,
    opts: AcpStartOptions,
    resumeSessionId?: string,
  ): Promise<
    | { ok: true; agentId: string; capabilities: AcpCapabilities; sessionId?: string; snapshot?: HostSnapshot }
    | { ok: false; error: string; verdict?: AcpVerdict }
  > {
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
      const capabilities = await client.start(resumeSessionId ? { resumeSessionId } : {})
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
      // 能不能接着聊：协商给一半，实测给另一半，两边合起来才是结论
      capabilities.resume = judgeResume({
        loadSession: capabilities.loadSession,
        cell: matrixCell(entry),
        observedNativeTurnRef: client.lastNativeTurnRef,
      })
      return { ok: true, agentId, capabilities, sessionId: client.session, snapshot: client.replay }
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

  /** 预检用的工作目录：默认取当前进程的工作目录 */
  defaultCwd(): string {
    return path.resolve(process.cwd())
  }
}
