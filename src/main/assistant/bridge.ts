/**
 * 助手 agent 的主进程侧胶水：真实能力 → caps → pi 会话 → IPC。
 *
 * 为什么单独一层：tools.ts 只认 AssistantCaps（可离线测），session.ts 只认 pi（可离线测），
 * 而「从钥匙串取 key」「在页面里跑拾取脚本」「弹确认卡片」这些必须碰 Electron。
 * 混在一起会导致任何一个改动都要起 app 才能验证。这一层刻意只做转换和编排，
 * 不放业务判断。
 *
 * 三条安全约束，都在这层落实：
 *
 * 1. **API Key 的走向是单向的**。发起对话时 key 从钥匙串现场取，注入 pi 的内存态
 *    （applyModelKey），绝不进 config 对象、绝不回渲染层、绝不进对话记录。
 *    新建模型时 key 由确认卡片交给主进程，直接写进钥匙串，同样不经过模型。
 *
 * 2. **确认卡片有超时**。pi 的 tool handler 是被 await 的：渲染层崩了、窗口关了、
 *    用户走开了，没有超时的话整个 agent loop 会永久挂住，并且占着这条会话。
 *    超时按「拒绝」处理，理由是「未确认」而不是「出错」，模型才会去问用户。
 *
 * 3. **模型清单变了就重建 runtime**。助手新建/删除模型后，pi 侧的模型表必须跟上，
 *    否则「刚创建的模型无法当助手模型」；重建用签名比对，避免每轮对话都重建。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AdapterSpec } from '../../shared/adapter'
import {
  APPROVAL_PREFS_DEFAULT,
  clampApprovalTimeout,
  describeApprovalPrefs,
  expandSkillCall,
  isApprovalMode,
  type AssistantApprovalDecision,
  type AssistantApprovalMode,
  type AssistantApprovalPrefs,
  type AssistantApprovalRequest,
  type AssistantApprovalResolved,
  type AssistantCapabilitiesView,
  type AssistantHistoryItem,
  type AssistantModeState,
  type AssistantModelView,
  type AssistantOverlayData,
  type AssistantResult,
  type AssistantSessionStats,
  type AssistantSessionView,
  type AssistantStatus,
  type AssistantStreamEvent,
  type SkillImportResult,
  type SkillScanView,
} from '../../shared/assistant'
import type { DiagEvent, DiagLayer, DoctorReport } from '../../shared/diagnostics'
import type { WebPlanResult, WebRole } from '../../shared/smart-add'
import type { ChatAttachmentMeta, ModelConfig } from '../../shared/types'
import type { AdapterRegistry } from '../adapters/registry'
import type { WebviewPool } from '../webview/pool'
import { PICKER_SCRIPT } from '../webview/picker'
import type { Assistant, AssistantImage, SessionTarget } from './session'
import { createAssistant } from './session'
import { assistantSkillsDir } from './session'
import { friendlyError } from './errors'
import { applyModelKey, createAssistantRuntime, isUsableApiModel, type AssistantRuntime } from './provider'
import { assertOwnSessionFile, deleteSession, listSessions, readSessionHistory } from './sessions'
import { importSkill, listImportedSkills, removeSkill, scanSkills, writeAuthoredSkill } from './skills'
import { createModeEngine, type TurnOutcome } from './modes'
import { expandAt, listAt } from './atrefs'
import {
  PLUGIN_SECRET_RE,
  extensionsDirOf,
  listPendingExtensions,
  loadPluginManifests,
  pendingDirOf,
  pluginsDirOf,
  promotePendingExtension,
  removePendingExtension,
  removePluginManifest,
  toPluginView,
  writePendingExtension,
  writePluginManifest,
} from './plugins'
import type { PendingExtensionView, PluginListView, AtListing } from '../../shared/assistant'
import type { ApprovalRequest, AssistantCaps } from './tools'

/** 确认卡片等待用户点击的上限：超时视为拒绝 */
const APPROVAL_TTL_MS = 5 * 60_000
/** 历史/日志读取的硬上限，防止一次工具调用把上下文打满 */
const LOG_LIMIT_MAX = 200
/** 同时授权给助手读取的目录上限：授权不是越多越安全，而是越多越没人记得住自己给过谁 */
const MAX_READ_DIRS = 4
/**
 * 兜底浏览根（助手自己的数据目录）下不露出的顶层目录：`keys` 是 safeStorage 密文。
 *
 * @ 引用由主进程直接读盘，不经 read 闸门，所以默认根必须自己把凭据那条路堵死。
 */
const DEFAULT_AT_HIDDEN = ['keys']

export interface NewApiModelInputLike {
  displayName: string
  baseUrl: string
  model: string
  protocol?: 'openai' | 'anthropic'
  pricePerMTokIn?: number
  pricePerMTokOut?: number
  maxContextTokens?: number
}

export interface NewWebModelInputLike {
  displayName: string
  entry: string
  selectors?: { input: string; stream: string; send?: string; stop?: string; generating?: string }
  input_kind?: 'textarea' | 'contenteditable'
  send_mode?: 'click' | 'enter'
  stream_mode?: 'last' | 'all'
  completion_mode?: 'stop_button_hidden' | 'generating_absent' | 'dom_stable'
  stable_ms?: number
}

/**
 * 智能添加的识别链（设置页向导用的同一个实例）。
 * 助手拿到它，才能「从一个纯网址凭空建出第一个网页模型」；
 * 不注入的话，创建前的页面识别只能靠人走进向导，助手会在第一步卡住。
 */
export interface SiteScanDeps {
  planWeb(input: { entry: string; assistantModelId?: string }): Promise<WebPlanResult>
  refineWeb(planId: string, answers: Record<string, string>): Promise<WebPlanResult>
  verifyWeb(planId: string, selectors: Record<WebRole, string>): Promise<WebPlanResult>
  driveWeb(planId: string, input: { text?: string }): Promise<WebPlanResult>
  closeScanWindow(): void
}

export interface AssistantBridgeDeps {
  dataDir(): string
  models(): ModelConfig[]
  /** 只暴露助手真正需要的三个动作，别把整个 KeychainSecretStore 传进来 */
  secrets: {
    get(ref: string): string | null
    has(ref: string): boolean
  }
  registry(): AdapterRegistry
  pool(): WebviewPool
  /** 体检：index.ts 用 doctorDeps() 现场组依赖，这层不关心它怎么来的 */
  runDoctor(opts: { modelId?: string; probeApi?: boolean }): Promise<DoctorReport>
  readLog(limit: number, filter: { layer?: DiagLayer; subject?: string }): DiagEvent[]
  createApiModel(input: NewApiModelInputLike & { apiKey: string }): Promise<{ ok: boolean; errors?: string[]; id?: string }>
  createWebModel(input: NewWebModelInputLike): Promise<{ ok: boolean; errors?: string[]; id?: string }>
  /** 真机试发言：走讨论/聊天同一条 WebviewAgent 通道，发一句、读一条回复 */
  runWebTurn(modelId: string, text: string): Promise<{ ok: boolean; reason?: string; chars?: number; preview?: string; ms?: number }>
  /** 智能识别链：注入设置页同一个实例，助手与向导共用一套方案缓存与扫描窗口 */
  siteScan: SiteScanDeps
  deleteModel(modelId: string): Promise<{ ok: boolean; reason?: string }>
  /** 打开网页版模型（内嵌视图），登录由人完成 */
  presentModel(modelId: string): Promise<{ ok: boolean; reason?: string }>
  listRemoteModels(baseUrl: string, apiKey: string): Promise<{ ok: boolean; models?: Array<{ id: string }>; error?: string }>
  /** mainWindow.webContents.send */
  send(channel: string, payload: unknown): void
  /** ipcMain.handle 的注入点：不在这里 import electron，模块才能在离线测试里加载 */
  handle(channel: string, fn: (args: any) => Promise<unknown> | unknown): void
  /** 读回一份聊天附件的字节（base64）：图片走多模态通道，文本并入正文 */
  readAttachment(id: string): Promise<{ kind: 'image' | 'text'; name: string; mime: string; base64: string } | null>
  log(entry: { layer: DiagLayer; stage: string; subject?: string; ok: boolean; detail?: string }): void
  /** 技能/扩展开关（读自主进程的 preferences） */
  extensionsEnabled(): boolean
  /** 开关落盘：会话的下一次组装才生效，所以桥这边还会把会话拆掉重建 */
  setExtensionsEnabled(on: boolean): Promise<void> | void
  /** 「允许助手自建工具」开关（默认关）：关着时那五个工具不注册、提示词也不提 */
  selfAuthoringEnabled(): boolean
  setSelfAuthoringEnabled(on: boolean): Promise<void> | void
  /** 审批偏好（模式 + 超时自动批准时长），由主进程从 preferences 读 */
  approvalPrefs(): AssistantApprovalPrefs
  /** 审批偏好落盘：桥不自己存，存储归主进程的 preferences */
  setApprovalPrefs(prefs: AssistantApprovalPrefs): Promise<void> | void
  /**
   * 原生目录选择器（/ 浮层的「授权一个读取目录」用它）。
   *
   * 必须留在主进程：渲染层的 <input type=file> 拿不到目录，而 Electron 的
   * File.path 已废弃。桥不 import electron，所以选择器由 index.ts 注入。
   */
  pickDirectory(): Promise<{ ok: boolean; path?: string; reason?: string }>
  /**
   * 上一场亲手挑过的项目目录（落在 preferences 里，是「记性」不是「授权」）。
   *
   * 记住它只为了让浮层能给出一行「继续用「X」」；这一场的读取范围仍由那一下点击决定，
   * 所以权限的作用域没有跨过会话 —— 自动沿用的话，等于上一次的选择一直有效。
   */
  lastWorkDir(): string | undefined
  setLastWorkDir(dir: string | undefined): Promise<void> | void
  /** 技能来源的搜索根（别的 agent 应用都把技能放在主目录下）；测试里指到假树 */
  skillsHome?(): string
  /**
   * 确认时限的注入点（仅测试用）：等人点击的 TTL 和倒计时自动批准都走它，
   * 否则「超时自动批准」的用例要真等若干秒。
   */
  approvalTtlMs?: number
}

export interface AssistantBridge {
  caps: AssistantCaps
  /** 挂上渲染层用的 IPC 通道；由 index.ts 在 registerIpc() 里调用一次 */
  registerIpc(): void
  status(): AssistantStatus
  listModels(): AssistantModelView[]
  setModel(modelId: string): Promise<AssistantResult>
  send(text: string, attachments?: ChatAttachmentMeta[]): Promise<AssistantResult>
  steer(text: string): Promise<AssistantResult>
  abort(): Promise<AssistantResult>
  /** 会话没建立时读磁盘上最近的一场 —— 重启后打开面板就该看到上次的对话 */
  history(): Promise<AssistantHistoryItem[]>
  /** 整场会话的累计账；还没对话过时为 null */
  stats(): Promise<AssistantSessionStats | null>
  /** 历史会话列表（最近修改的在前） */
  sessions(): Promise<AssistantSessionView[]>
  /** 切到某场历史会话继续聊 */
  openSession(file: string): Promise<AssistantResult>
  deleteSession(file: string): Promise<AssistantResult>
  capabilities(): AssistantCapabilitiesView
  /** 开/关技能与扩展 */
  setExtensions(on: boolean): Promise<AssistantResult>
  /** 扫描别的 agent 应用里的技能 */
  scanSkills(): Promise<SkillScanView>
  /** 以软链接方式把一条技能接进 Torra */
  importSkill(input: { key: string; name?: string }): Promise<SkillImportResult>
  /** 断开导入（只删链接，不碰源目录） */
  removeSkill(name: string): Promise<SkillImportResult>
  /** 插件目录现状（读盘，不依赖会话装配过） */
  plugins(): PluginListView
  /** 待审区里的 JS 扩展清单 */
  pendingExtensions(): PendingExtensionView[]
  removePlugin(name: string): Promise<AssistantResult>
  /** 把待审扩展搬进 extensions/ */
  enablePendingExtension(name: string): Promise<AssistantResult>
  /** 丢弃一份待审源码 */
  dropPendingExtension(name: string): Promise<AssistantResult>
  /** 开/关「允许助手自建工具」 */
  setSelfAuthoring(on: boolean): Promise<AssistantResult>
  /** 当前审批偏好（模式 + 超时自动批准时长） */
  approvalPrefs(): AssistantApprovalPrefs
  /** 改审批偏好：非法值一律夹回可用范围 */
  setApprovalPrefs(input: { mode?: unknown; timeoutMs?: unknown }): Promise<AssistantResult>
  /** / 浮层的数据：模式快照 + 盘上的技能清单 + 技能开关 */
  overlay(): Promise<AssistantOverlayData>
  /** 切运行模式（普通 / 目标 / 计划） */
  setMode(input: { mode?: unknown; goal?: unknown }): AssistantResult
  /** 停止正在自动推进的目标或计划 */
  stopMode(): AssistantResult
  /** 执行计划模式刚产出的那份计划：撤掉只读闸门，把计划交回去跑 */
  executePlan(): Promise<AssistantResult>
  /**
   * 换 @ 引用浏览的项目目录：不传 dir 走原生选择器，传了只认「上一场记下的那一个」。
   * 无论哪条路，它同时进读取授权。
   */
  setWorkDir(input?: { dir?: string }): Promise<AssistantResult>
  /** 列 @ 后面那半条路径的候选（读盘，只在当前浏览根里面找；没挑过项目目录就是助手目录） */
  atList(query: string): AtListing
  /** 撤销一个已授权的读取目录 */
  revokeDir(dir: string): Promise<AssistantResult>
  /** 开一场新会话（旧会话文件留在盘上，列表里还能翻到） */
  reset(): Promise<AssistantResult>
  dispose(): void
}

type Rgb = AssistantResult

/** 会话还没组装时能报的只有开关状态：清单要等 pi 真的加载过才知道 */
function pendingCaps(on: boolean, note: string): AssistantCapabilitiesView {
  return { extensionsEnabled: on, selfAuthoringEnabled: false, skills: [], extensions: [], plugins: [], errors: [], note }
}

export function createAssistantBridge(deps: AssistantBridgeDeps): AssistantBridge {
  let assistant: Assistant | undefined
  let pi: AssistantRuntime | undefined
  /** 上次组会话用的模型清单签名：变了就要重建 pi runtime */
  let signature = ''
  /** 打开哪场会话：undefined=接最近的一场，{fresh}=新开，{file}=指定那场 */
  let target: SessionTarget | undefined
  /** 上次组装会话时读到的技能/扩展清单，面板与设置页都从这里取 */
  let loadedCaps: AssistantCapabilitiesView = pendingCaps(false, '助手尚未开始对话')
  let modelId: string | null = null
  let inFlight = false
  const approvals = new Map<string, (d: AssistantApprovalDecision) => void>()
  /**
   * 人在 / 浮层里亲手授权的读取目录。
   *
   * 只活在这场助手会话期间（不写盘）：授权的作用域一旦跨过会话，
   * 「我上次给哪个目录开过口子」就再也没人记得住。
   */
  let readDirs: string[] = []
  /**
   * 人亲手挑过的项目目录，只活在这场会话期间；没挑过时 @ 浏览走 defaultWorkDir()。
   *
   * 挑它的时候顺手并进 readDirs，于是「@ 能引用到的」和「助手自己 read 得到的」
   * 是同一个范围 —— 两套边界迟早分叉，分叉之后没人说得清这个目录到底能不能被读到。
   */
  let workDir: string | undefined
  /**
   * @ 的兜底浏览根：助手自己的数据目录，开箱就有东西可列。
   *
   * 它本来就在 read 闸门之外（会话文件、技能清单都在那儿），所以拿它当默认根不算新开口子；
   * 但同一个目录下还有钥匙串密文，那份由 DEFAULT_AT_HIDDEN 挡住。
   */
  const defaultWorkDir = (): string => path.resolve(deps.dataDir())
  /** 现在真正在浏览的那个根 */
  const atRoot = (): string => workDir ?? defaultWorkDir()
  /** 隐藏范围只在兜底根上生效：人亲手挑的项目目录中可能正经有个 keys/ 是要引用的 */
  const atHidden = (): string[] => (workDir ? [] : DEFAULT_AT_HIDDEN)
  /** 正在跑的这一轮的助手原文：目标模式靠它末尾的自评标记决定要不要续跑 */
  let turnText = ''

  const usable = (): ModelConfig[] => deps.models().filter(isUsableApiModel)

  /**
   * 抛出来的错转成返回体：reason 给人看，detail 留原文。
   * 日志一定要落 detail，否则翻译过的那句话就成了唯一线索 —— 翻译是有损的。
   */
  const fail = (e: unknown): AssistantResult => {
    const raw = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: friendlyError(raw), detail: raw }
  }

  function view(cfg: ModelConfig, hasKey: boolean): AssistantModelView {
    return {
      id: cfg.id,
      displayName: cfg.displayName,
      transport: cfg.transport,
      enabled: cfg.enabled,
      adapterId: cfg.adapterId,
      baseUrl: cfg.api?.baseUrl,
      apiModel: cfg.api?.model,
      protocol: cfg.api?.protocol,
      hasKey,
      vision: cfg.api?.vision,
      status: cfg.enabled ? undefined : 'disabled',
    }
  }

  function listModels(): AssistantModelView[] {
    return deps.models().map((cfg) =>
      view(cfg, cfg.api ? deps.secrets.has(cfg.api.apiKeyRef) : true),
    )
  }

  /** 默认助手模型：优先用户上次挑的，其次第一个「有 Key」的，最后第一个 */
  function pickModel(): ModelConfig | undefined {
    const list = usable()
    if (list.length === 0) return undefined
    if (modelId) {
      const keep = list.find((m) => m.id === modelId)
      if (keep) return keep
    }
    return (
      list.find((m) => deps.secrets.has(m.api!.apiKeyRef)) ?? list[0]
    )
  }

  function keyOf(cfg: ModelConfig): string | null {
    return deps.secrets.get(cfg.api!.apiKeyRef)
  }

  /**
   * 组（或复用）会话。
   *
   * 清单签名变了 → 重建 pi runtime，会话也必须重开（旧会话绑在旧 runtime 上）；
   * 只有 reset 换了作用域或还没建过 → 只重开会话，runtime 复用。
   * 重开走 SessionManager.continueRecent，同一作用域里的对话记录接得上。
   */
  async function ensureAssistant(): Promise<Assistant> {
    const list = usable()
    if (list.length === 0) {
      throw new Error('没有可供助手使用的 API 模型。请在设置页新建一个 API 模型并填入 API Key。')
    }
    const next = list.map((m) => `${m.id}=${m.api!.baseUrl}:${m.api!.model}`).join(';')
    if (!pi || next !== signature) {
      pi = await createAssistantRuntime({
        userDataDir: deps.dataDir(),
        models: list,
        hasKey: (ref) => deps.secrets.has(ref),
      })
      signature = next
      assistant?.dispose()
      assistant = undefined
    }
    const runtime = pi
    if (!runtime) throw new Error('助手运行时初始化失败')

    const cfg = pickModel()
    if (!cfg) throw new Error('助手模型清单为空')
    const key = keyOf(cfg)
    if (!key) throw new Error(`模型「${cfg.displayName}」还没有 API Key，请在设置页填写。`)
    const model = await applyModelKey(runtime.runtime, cfg.id, key)

    if (!assistant) {
      assistant = await createAssistant({
        dataDir: deps.dataDir(),
        session: target,
        extensions: deps.extensionsEnabled(),
        caps: base.caps,
        runtime: runtime.runtime,
        model,
        // 授权目录是组装时读进 read 闸门的，所以每次增减都要重开这一场
        readDirs: [...readDirs],
        emit: (e) => {
          // 攒本轮原文：目标模式的续跑判据写在助手回复的末尾，而模式层拿不到 pi，
          // 只有这里看得到每一个字。
          if (e.kind === 'text') turnText += e.delta
          // 模型侧的失败（404、Key 失效、端点不通）只以流事件出现，不进日志的话
          // 事后无从知道「没响应」那一轮究竟发生了什么。
          // 记 detail 而不是 text：text 是翻译后的人话，原文才经得起排查。
          if (e.kind === 'error') {
            deps.log({ layer: 'runtime', stage: 'assistant:error', subject: modelId ?? undefined, ok: false, detail: e.detail ?? e.text })
          }
          // 每轮的耗时/token/费用进流水线日志：界面会翻篇，账要留在盘上
          if (e.kind === 'turn-stats') {
            const s = e.stats
            deps.log({
              layer: 'runtime',
              stage: 'assistant:turn',
              subject: modelId ?? undefined,
              ok: true,
              detail: `ms=${s.ms} ttft=${s.ttftMs ?? '-'} tok=${s.input}/${s.output}/${s.cacheRead} cost=${s.cost.toFixed(4)} steps=${s.steps}`,
            })
          }
          deps.send('assistant:stream', e)
        },
      })
      const c = assistant.capabilities()
      loadedCaps = {
        extensionsEnabled: deps.extensionsEnabled(),
        selfAuthoringEnabled: deps.selfAuthoringEnabled(),
        skills: c.skills,
        extensions: c.extensions,
        plugins: c.plugins,
        errors: c.errors,
        dirs: c.dirs,
        ...(c.skills.length + c.extensions.length + c.plugins.length === 0
          ? { note: `已加载目录里没有内容：${c.dirs.skills} 、${c.dirs.extensions} 、${c.dirs.plugins}` }
          : {}),
      }
    } else if (assistant.modelId !== cfg.id) {
      // 复用会话只换模型：会话历史、已注册工具都不必重建
      await assistant.useModel(cfg.id, key)
    }
    modelId = cfg.id
    return assistant
  }

  /**
   * 拆掉当前会话，但把 target 钉回同一场会话文件：下一次发送会重开它。
   *
   * 技能清单、插件清单、授权的读取目录都是**组装会话时**读进去的（pi 传了自定义
   * resourceLoader 就不会再 reload），所以这些东西一变就得重开 —— 对话记录不丢，
   * 丢的只是内存里那份装配结果。回合进行中不能拆：那会让正在跑的这一轮失去事件出口。
   */
  function restartSession(): void {
    const file = assistant?.sessionFile
    assistant?.dispose()
    assistant = undefined
    if (file) target = { file }
    loadedCaps = pendingCaps(deps.extensionsEnabled(), '下一次对话时才会加载')
  }

  /**
   * 技能清单变化之后要让下一次对话真的看到它。
   *
   * 所以这里把会话拆掉（记录还在同一个文件里）；开关关着时拆了也白拆，
   * 回合进行中不能拆 —— 两种情况都只回一句话，不动会话。
   */
  function capabilityReloadNote(verb: string, opts: { gated?: boolean } = {}): string {
    // 技能与扩展要看得开开关；插件不需要（清单是数据，执行时自己弹卡片）
    if (opts.gated && !deps.extensionsEnabled()) {
      return `${verb}完成。「加载技能 / 扩展」开关还关着，打开后才会加载`
    }
    if (inFlight) return `${verb}完成。助手正在说完这一句，之后重新发消息才会装配新的能力（这一次不拆会话）`
    restartSession()
    return `${verb}完成。下一次对话会重新装配技能与插件（这场对话的记录不丢）`
  }

  /** 盘符根与主目录整体都不叫「一个项目目录」：Windows 大小写不敏感，比之前两边归一化 */
  function samePath(a: string, b: string): boolean {
    const k = (p: string): string => path.resolve(p)
    return process.platform === 'win32' ? k(a).toLowerCase() === k(b).toLowerCase() : k(a) === k(b)
  }

  /**
   * 一条待授权目录的拒绝理由（返回 undefined 才是可以授权）。
   *
   * 选择器是人亲手点的，但「整块盘」和「整个主目录」也点得出来 —— 那一条点下去，
   * 助手就能读你所有的文档和凭据文件。一次点击毁掉全部边界的情况，必须在闸门处挡下。
   */
  function grantRejection(dir: string): string | undefined {
    if (!path.isAbsolute(dir)) return `「${dir}」不是绝对路径，不能授权`
    const st = fs.statSync(dir, { throwIfNoEntry: false })
    if (!st) return `「${dir}」不存在`
    if (!st.isDirectory()) return `「${dir}」不是目录，授权读取范围要的是目录`
    if (samePath(dir, path.parse(path.resolve(dir)).root)) return '不能把整个磁盘根目录授权给助手，请选其中的项目目录'
    if (samePath(dir, os.homedir())) return '不能把用户主目录整体授权给助手，请选具体的项目目录'
    return undefined
  }

  /** 授权变了就要重开这一场：readDirs 是组装会话时读进 read 闸门的，不是每次调用现查的 */
  function applyReadDirs(next: string[], note: string): void {
    readDirs = next
    restartSession()
    modes.setReadDirs(next, note)
    deps.log({ layer: 'runtime', stage: 'assistant:read-dir', ok: true, detail: note })
  }

  /**
   * 换会话就把「只属于这一场」的东西清零：运行模式、自动推进的计数、读取授权。
   *
   * 留着它们跨会话，等于用户切到另一场对话里，助手还带着上一场攒下的写权限 ——
   * 那种权限没人记得是谁给的，也就没人能在事后收回。
   */
  function clearSessionScoped(): void {
    readDirs = []
    // @ 浏览回到兜底根：项目目录的「记忆」留在 preferences 里，授权不留在这儿
    workDir = undefined
    modes.reset()
  }

  /**
   * 跑一轮对话，并把这一轮的助手原文带回来。
   *
   * 原文是目标模式唯一的判据（自评标记写在回复末尾），而模式层碰不到 pi，所以只有
   * 这一层能抄给它。附件解析、视觉闸门、忙碌态也都收在这一个函数里 ——
   * 三种模式共用同一条发送路径，才不会「普通对话能发图，目标模式不能」。
   */
  async function runTurn(prompt: string, opts: { attachments?: ChatAttachmentMeta[]; refs?: string } = {}): Promise<TurnOutcome> {
    const atts = Array.isArray(opts.attachments) ? opts.attachments : []
    let session: Assistant
    try {
      session = await ensureAssistant()
    } catch (e) {
      // 组会话失败时不推流：直接以返回值给调用方，
      // 免得 UI 同时收到「invoke 失败」和「error 事件」两条同样的原因
      const r = fail(e)
      deps.log({ layer: 'runtime', stage: 'assistant:boot', ok: false, detail: r.detail })
      return { ...r, text: '' }
    }
    // 解析附件：文本并入正文，图片走 pi 的多模态通道。
    // 图片先过视觉闸门 —— 给纯文本端点发图只会被服务端拒，这里提前挡下并说清原因。
    const hasImage = atts.some((a) => a.kind === 'image')
    if (hasImage) {
      const cfg = deps.models().find((m) => m.id === session.modelId)
      if (!cfg?.api?.vision) {
        return { ok: false, reason: '当前助手模型不支持图片输入，请在设置里勾选「支持图片输入」或换一个视觉模型', text: '' }
      }
    }
    const images: AssistantImage[] = []
    const textBlocks: string[] = []
    for (const a of atts) {
      const r = await deps.readAttachment(a.id)
      if (!r) {
        textBlocks.push(`【附件读取失败：${a.name}】`)
        continue
      }
      if (r.kind === 'image') images.push({ type: 'image', mimeType: r.mime, data: r.base64 })
      else textBlocks.push(`【附件：${r.name}】\n${Buffer.from(r.base64, 'base64').toString('utf8')}`)
    }
    const promptText = textBlocks.length ? `${prompt}${prompt ? '\n\n' : ''}${textBlocks.join('\n\n')}` : prompt
    const refBlock = String(opts.refs ?? '').trim()
    const withRefs = refBlock ? `${promptText}${promptText ? '\n\n' : ''}${refBlock}` : promptText
    turnText = ''
    inFlight = true
    deps.log({ layer: 'runtime', stage: 'assistant:send', subject: modelId ?? undefined, ok: true, detail: withRefs.slice(0, 60) })
    try {
      await session.send(withRefs, images)
      return { ok: true, text: turnText }
    } catch (e) {
      // session.send 已经补发过 settled，这里只把原因带回去：
      // 再推一条 error 事件，界面就会长出两条一模一样的红字
      const r = fail(e)
      deps.log({ layer: 'runtime', stage: 'assistant:turn', subject: modelId ?? undefined, ok: false, detail: r.detail })
      return { ...r, text: turnText }
    } finally {
      inFlight = false
    }
  }

  /**
   * 运行模式状态机（普通 / 目标 / 计划），细节见 modes.ts。
   *
   * 桥在这里只提供三件事：跑一轮、把状态和进度推给渲染层、中止正在跑的这轮。
   */
  const modes = createModeEngine({
    runTurn: (prompt, opts) => runTurn(prompt, opts ?? {}),
    onState: (state) => deps.send('assistant:stream', { kind: 'mode', state } satisfies AssistantStreamEvent),
    onNote: (text) => deps.send('assistant:stream', { kind: 'status', text } satisfies AssistantStreamEvent),
    abortTurn: () => {
      // 不 await：中止和这一轮自己的收尾谁先到都行，等着只会让这里变成第二个挂点
      assistant?.abort().catch(() => undefined)
    },
  })

  /**
   * 插件目录的现状：直接读盘。
   *
   * 不走 capabilities() 那份快照，因为那是「上一次装配时」的结果 —— 助手刚写完一条清单、
   * 会话还没重开时，设置页要看的是盘上现在有什么，否则用户会以为自己写丢了。
   */
  function readPlugins(): PluginListView {
    const dir = pluginsDirOf(deps.dataDir())
    const { manifests, invalid } = loadPluginManifests(dir)
    return {
      dir,
      plugins: manifests.map(toPluginView),
      invalid: invalid.map((e) => ({ name: e.name, file: e.file, errors: e.errors })),
    }
  }

  // -------------------------------------------------------------------------
  // 确认卡片
  // -------------------------------------------------------------------------

  /** 结算原因进对话流：自动放行/自动拒绝都不是静默动作，用户回来要看得懂这一步是谁定的 */
  function approvalNote(text: string): void {
    deps.send('assistant:stream', { kind: 'status', text } satisfies AssistantStreamEvent)
  }

  /**
   * 问人之前先问偏好：这次是「等人点」「倒计时放行」还是「根本不该问」。
   *
   * 三条不变的边界：
   * - 需要人输入 API Key 的卡片，任何自动模式都照旧等人 —— 倒计时变不出 Key；
   * - 自动结算也要留可见回执（一行状态 + 一条卡片移除事件），否则用户回来只看到
   *   配置被改过，分不清是自己点的还是到点放行的；
   * - 每条路径都必须让 Promise 落地：pi 的 tool handler 是被 await 的，
   *   挂住就等于卡死整个 agent loop。
   */
  function approve(req: ApprovalRequest): Promise<AssistantApprovalDecision> {
    const id = randomUUID()
    const prefs = deps.approvalPrefs()

    // 计划模式的只读是闸门，不是提示词里的请求：在这儿拒绝，模型换任何说法都绕不过去
    if (modes.state().planLocked) {
      deps.log({ layer: 'runtime', stage: 'assistant:approval', subject: req.action, ok: false, detail: '计划模式拒绝写操作' })
      approvalNote(`计划模式：已拒绝「${req.title}」，没有改动任何东西`)
      return Promise.resolve({
        approved: false,
        reason: '当前是计划模式，助手只出计划不动手。把计划写完（不要执行），由人确认后在 / 浮层里选「执行计划」才会放行',
      })
    }
    if (prefs.mode === 'read_only') {
      deps.log({ layer: 'runtime', stage: 'assistant:approval', subject: req.action, ok: false, detail: '只读模式拒绝写操作' })
      approvalNote(`只读模式：已拒绝「${req.title}」，没有改动任何东西`)
      return Promise.resolve({ approved: false, reason: '当前是只读模式，助手不会改动本机配置；要改请先在设置页切回询问类模式' })
    }
    const autoable = req.needsKey !== true
    if (prefs.mode === 'auto_all' && autoable) {
      deps.log({ layer: 'runtime', stage: 'assistant:approval', subject: req.action, ok: true, detail: '免确认模式自动批准' })
      approvalNote(`免确认模式：已自动执行「${req.title}」`)
      return Promise.resolve({ approved: true })
    }

    const auto = prefs.mode === 'auto_after_timeout' && autoable
    const waitMs = deps.approvalTtlMs ?? (auto ? clampApprovalTimeout(prefs.timeoutMs) : APPROVAL_TTL_MS)
    const card: AssistantApprovalRequest = { id, ...req, ...(auto ? { autoApproveAt: Date.now() + waitMs } : {}) }
    return new Promise<AssistantApprovalDecision>((resolve) => {
      const finish = (decision: AssistantApprovalDecision, autoSettled: boolean): void => {
        deps.send('assistant:approval:resolved', {
          id,
          approved: decision.approved,
          auto: autoSettled,
          ...(decision.reason ? { reason: decision.reason } : {}),
        } satisfies AssistantApprovalResolved)
        resolve(decision)
      }
      const timer = setTimeout(() => {
        approvals.delete(id)
        if (auto) {
          deps.log({ layer: 'runtime', stage: 'assistant:approval', subject: req.action, ok: true, detail: '倒计时到点自动批准' })
          approvalNote(`倒计时结束，已自动执行「${req.title}」`)
          return finish({ approved: true }, true)
        }
        // 超时按拒绝处理，且把原因写清楚：模型看到「超时」会去问用户，看到「出错」会重试
        deps.log({ layer: 'runtime', stage: 'assistant:approval', subject: req.action, ok: false, detail: '超时未确认' })
        finish({ approved: false, reason: '确认超时，未做任何改动' }, true)
      }, waitMs)
      approvals.set(id, (decision) => {
        clearTimeout(timer)
        approvals.delete(id)
        finish(decision, false)
      })
      deps.send('assistant:approval:request', card)
    })
  }

  function respond(id: string, decision: AssistantApprovalDecision): Rgb {
    const settle = approvals.get(id)
    if (!settle) return { ok: false, reason: '这张确认卡片已经失效' }
    const approved = decision?.approved === true
    const apiKey = typeof decision?.apiKey === 'string' ? decision.apiKey.trim() : undefined
    const reason = typeof decision?.reason === 'string' ? decision.reason.slice(0, 200) : undefined
    settle({ approved, apiKey, reason })
    deps.log({ layer: 'runtime', stage: 'assistant:approval', ok: approved, detail: approved ? '用户允许' : '用户拒绝' })
    return { ok: true }
  }

  /** 渲染层被刷新/关闭时，挂着的确认全部按拒绝落地，别让 agent loop 卡死 */
  function dropPendingApprovals(reason: string): void {
    for (const [id, settle] of approvals) {
      approvals.delete(id)
      settle({ approved: false, reason })
    }
  }

  // -------------------------------------------------------------------------
  // caps：工具 → 真实能力
  // -------------------------------------------------------------------------

  function requireWebview(modelId: string): { cfg: ModelConfig } | { reason: string } {
    const cfg = deps.models().find((m) => m.id === modelId)
    if (!cfg) return { reason: `模型「${modelId}」不存在，请用 torra_list_models 里的真实 id` }
    if (cfg.transport !== 'webview') return { reason: `${cfg.displayName} 走 API 通道，没有页面可读` }
    return { cfg }
  }

  function liveView(modelId: string): Electron.WebContents | undefined {
    const view = deps.pool().get(modelId)
    if (!view) return undefined
    try {
      return view.webContents
    } catch {
      return undefined
    }
  }

  const caps: AssistantCaps = {
    listModels: () => listModels(),
    findModel: (id) => deps.models().find((m) => m.id === id),
    runDoctor: (opts) => deps.runDoctor({ modelId: opts.modelId, probeApi: opts.probeApi }),
    readLog: (filter) =>
      deps.readLog(Math.min(LOG_LIMIT_MAX, Math.max(1, filter.limit)), {
        layer: filter.layer,
        subject: filter.subject,
      }),
    async pageFacts(modelId) {
      const w = requireWebview(modelId)
      if ('reason' in w) return { ok: false, reason: w.reason }
      // 页面实例不在就先建一个：助手要看的是真实页面，不是配置文件里的猜测
      if (!deps.pool().has(modelId)) {
        const rt = w.cfg.adapterId ? deps.registry().get(w.cfg.adapterId) : undefined
        if (!rt) return { ok: false, reason: `适配器「${w.cfg.adapterId ?? '?'}」缺失` }
        deps.pool().ensure(modelId, rt, w.cfg.partition)
      }
      const login = await deps.pool().inspectLogin(modelId)
      const wc = liveView(modelId)
      const chatInputs = wc
        ? await wc
            .executeJavaScript(
              `document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]').length`,
              true,
            )
            .then((n) => Number(n ?? 0))
            .catch(() => undefined)
        : undefined
      return {
        ok: true,
        url: login.url,
        loginState: login.state,
        loginReason: login.reason,
        chatInputs,
      }
    },
    async verifySelector(modelId, selector) {
      const w = requireWebview(modelId)
      if ('reason' in w) return { ok: false, reason: w.reason }
      const wc = liveView(modelId)
      if (!wc) return { ok: false, reason: '页面实例还没建好，先调 torra_page_facts' }
      await wc.executeJavaScript(PICKER_SCRIPT, true).catch(() => undefined)
      const r = await wc
        .executeJavaScript(`window.__torraPicker.verify(${JSON.stringify(selector)})`, true)
        .catch(() => null) as { ok?: boolean; matches?: number; covers?: boolean } | null
      if (!r) return { ok: false, reason: '页面无响应，选择器无法当场校验' }
      return { ok: r.ok === true, matches: Number(r.matches ?? 0), covers: r.covers === true }
    },
    readAdapter(adapterId) {
      const rt = deps.registry().get(adapterId)
      if (!rt) return undefined
      return {
        id: adapterId,
        name: rt.spec.name,
        origin: rt.spec.origin ?? 'builtin',
        entry: rt.spec.entry,
        health: rt.health,
        healthError: rt.lastError,
        stale: deps.registry().isStale(adapterId),
        yaml: deps.registry().getYaml(adapterId) ?? '',
      }
    },
    saveAdapter: (spec: AdapterSpec) => deps.registry().saveUser(spec),
    async probeApiModel(modelId) {
      const cfg = deps.models().find((m) => m.id === modelId)
      if (!cfg) return { ok: false, reason: `模型「${modelId}」不存在` }
      if (!cfg.api) return { ok: false, reason: `${cfg.displayName} 不是 API 通道，没有可探测的端点` }
      const key = keyOf(cfg)
      if (!key) return { ok: false, reason: `${cfg.displayName} 未配置 API Key，无法探测` }
      const r = await deps.listRemoteModels(cfg.api.baseUrl, key)
      if (!r.ok) return { ok: false, reason: r.error ?? '探测失败' }
      const ids = (r.models ?? []).map((m) => m.id)
      return { ok: true, modelCount: ids.length, models: ids.slice(0, 60) }
    },
    createApiModel: (input, apiKey) => deps.createApiModel({ ...input, apiKey }),
    createWebModel: (input) => deps.createWebModel(input),
    runWebTurn: (modelId, text) => deps.runWebTurn(modelId, text),
    deleteModel: (modelId) => deps.deleteModel(modelId),
    openLogin: (modelId) => deps.presentModel(modelId),
    // 纯 URL 也能起步：识别链自己开扫描窗口、在真实页面上回测，不依赖已存在的模型
    scanSite: (input) => deps.siteScan.planWeb({ entry: input.entry, assistantModelId: modelId ?? undefined }),
    answerSiteQuestions: (planId, answers) => deps.siteScan.refineWeb(planId, answers),
    checkSiteSelectors: (planId, selectors) =>
      deps.siteScan.verifyWeb(planId, {
        input: '',
        send: '',
        stop: '',
        stream: '',
        generating: '',
        ...selectors,
      }),
    // 代发消息：识别链里唯一会写页面的一步，确认卡片在 tools 层已经把过闸
    driveSite: (planId, text) => deps.siteScan.driveWeb(planId, { text }),
    closeSiteScan: () => deps.siteScan.closeScanWindow(),
    approve,
    // 清单里的 {{secrets:REF}} 只能取 plugin: 前缀的条目（校验在 plugins.ts 装载时做，
    // 这里再挡一道）：模型的 Key 是 `<id>:key`，绝不能被一条插件清单转发出去。
    pluginSecret: (ref) => (PLUGIN_SECRET_RE.test(ref) ? deps.secrets.get(ref) : null),
    selfAuthoring: () => deps.selfAuthoringEnabled(),
    listPlugins: () => readPlugins(),
    authorTool: async (manifest) => writePluginManifest(pluginsDirOf(deps.dataDir()), manifest),
    authorSkill: async (input) =>
      writeAuthoredSkill({ skillsDir: assistantSkillsDir(deps.dataDir()), name: input.name, description: input.description, body: input.body }),
    removePlugin: async (name) => removePluginManifest(pluginsDirOf(deps.dataDir()), name),
    proposeExtension: async (input) => writePendingExtension(pendingDirOf(deps.dataDir()), input),
    capabilityNote: (verb) => capabilityReloadNote(verb),
    log: (e) => deps.log({ layer: 'runtime', stage: e.stage, subject: e.subject, ok: e.ok, detail: e.detail }),
  }

  // 桥对象与 caps 互相引用（caps 里要用 approve，组会话要用 caps），因此后置赋值
  const base: Omit<AssistantBridge, "registerIpc"> = {
    caps,
    status() {
      return {
        ready: !!assistant,
        modelId,
        streaming: inFlight,
        reason: assistant ? undefined : '助手尚未开始对话',
      }
    },
    listModels,
    async setModel(next) {
      const cfg = usable().find((m) => m.id === next)
      if (!cfg) return { ok: false, reason: `助手只能用自己的 API 模型，「${next}」不可用` }
      const key = keyOf(cfg)
      if (!key) return { ok: false, reason: `模型「${cfg.displayName}」还没有 API Key，请在设置页填写` }
      modelId = cfg.id
      if (assistant) {
        try {
          await assistant.useModel(cfg.id, key)
        } catch (e) {
          const r = fail(e)
          deps.log({ layer: 'runtime', stage: 'assistant:set-model', subject: cfg.id, ok: false, detail: r.detail })
          return r
        }
      }
      return { ok: true }
    },
    async send(text, attachments) {
      const body = String(text ?? '').trim()
      const atts = Array.isArray(attachments) ? attachments : []
      if (!body && atts.length === 0) return { ok: false, reason: '消息为空' }
      if (body.length > 8000) return { ok: false, reason: '消息过长（上限 8000 字）' }
      if (inFlight) return { ok: false, reason: '助手正在处理上一句，可以等它说完或使用插话' }
      // `/技能 X …` 在这里展开成模型看得懂的指令。名字的真相读盘，不读 capabilities() 快照：
      // 那是「上一次装配」的结果，第一条消息之前它是空的，于是刚导入的技能会表现成「没这个技能」。
      const skills = await listImportedSkills(assistantSkillsDir(deps.dataDir()))
      const exp = expandSkillCall(body, skills)
      if (exp.unknown) {
        return {
          ok: false,
          reason: `技能目录里没有「${exp.unknown}」这条技能。在 / 浮层里能看到有哪些可用，或先到设置页导入`,
        }
      }
      // @ 引用在这里展开成内容：三种模式共用同一条发送路径，所以「计划模式能不能看到
      // 这个文件」不该取决于模式。没展开成的那些必须当场说一句话 —— 悄悄丢掉一个引用，
      // 模型就会一本正经地按它没看到的东西给结论。
      const at = expandAt(atRoot(), exp.text, atHidden())
      for (const n of at.notes) deps.send('assistant:stream', { kind: 'status', text: n } satisfies AssistantStreamEvent)
      if (at.used) {
        deps.log({ layer: 'runtime', stage: 'assistant:at-ref', ok: true, detail: `${at.used} 个引用已展开（工作目录 ${atRoot()}）` })
      }
      // 模式的差别只在这一步交给状态机：普通对话就是它 runTurn 一次，
      // 目标/计划由主进程决定要不要接着再跑（渲染层不参与，也不自己数轮数）
      return modes.submit(exp.text, atts, at.blocks.join('\n\n'))
    },
    async steer(text) {
      const body = String(text ?? '').trim()
      if (!body) return { ok: false, reason: '消息为空' }
      if (!assistant || !inFlight) return { ok: false, reason: '助手当前没有进行中的回合' }
      try {
        await assistant.steer(body)
      } catch (e) {
        return fail(e)
      }
      return { ok: true }
    },
    async abort() {
      if (!assistant) return { ok: false, reason: '助手尚未开始对话' }
      // 中止 = 连自动推进一起停：只掐这一轮、循环接着跑下一轮，等于按了个假停止
      modes.stop()
      dropPendingApprovals('用户中止了本轮')
      await assistant.abort()
      return { ok: true }
    },
    async history() {
      if (assistant) return assistant.history()
      // 会话没建立（刚重启）也要有历史：读磁盘上最近修改的那一场
      try {
        const list = await listSessions(deps.dataDir())
        const head = list[0]
        if (!head) return []
        return await readSessionHistory(deps.dataDir(), head.path)
      } catch (e) {
        deps.log({ layer: 'runtime', stage: 'assistant:history', ok: false, detail: (e as Error).message })
        return []
      }
    },
    async stats() {
      if (!assistant) return null
      try {
        return assistant.stats()
      } catch (e) {
        deps.log({ layer: 'runtime', stage: 'assistant:stats', ok: false, detail: (e as Error).message })
        return null
      }
    },
    async sessions() {
      try {
        return await listSessions(deps.dataDir(), assistant?.sessionFile)
      } catch (e) {
        deps.log({ layer: 'runtime', stage: 'assistant:sessions', ok: false, detail: (e as Error).message })
        return []
      }
    },
    async openSession(file) {
      if (inFlight) return { ok: false, reason: '助手正在处理上一句，等它说完再切换会话' }
      const requested = path.resolve(String(file ?? ''))
      // 先验路径，再动状态：校验没过就清审批队列、拆掉正在跑的助手，等于一次误点
      // 把用户当前的对话打断，而渲染层只看到一句「失败」。打开是读盘，同样只认自家目录。
      try {
        assertOwnSessionFile(deps.dataDir(), requested)
      } catch (e) {
        const r = fail(e)
        deps.log({ layer: 'runtime', stage: 'assistant:open-session', ok: false, detail: r.detail })
        return r
      }
      dropPendingApprovals('会话已切换')
      clearSessionScoped()
      assistant?.dispose()
      assistant = undefined
      target = { file: requested }
      try {
        await ensureAssistant()
      } catch (e) {
        const r = fail(e)
        deps.log({ layer: 'runtime', stage: 'assistant:open-session', ok: false, detail: r.detail })
        return r
      }
      return { ok: true }
    },
    async deleteSession(file) {
      const r = await deleteSession(deps.dataDir(), String(file ?? ''), assistant?.sessionFile)
      deps.log({ layer: 'runtime', stage: 'assistant:delete-session', ok: r.ok === true, detail: r.reason })
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? '删除失败' }
    },
    async overlay() {
      // 技能读盘而不是读 loadedCaps：浮层在第一条消息之前就要能选技能，
      // 而那份快照要到会话装配过 pi 之后才有内容
      const skills = await listImportedSkills(assistantSkillsDir(deps.dataDir()))
      const root = atRoot()
      const remembered = deps.lastWorkDir()
      return {
        mode: modes.state(),
        skills,
        extensionsEnabled: deps.extensionsEnabled(),
        workDir: root,
        defaultWorkDir: defaultWorkDir(),
        // 和当前根相同、或者那个目录已经不在了，就不给这一行：点上去什么也不会变，
        // 或者点了报错，两条都比没有这一行更让人困惑
        ...(remembered && fs.existsSync(remembered) && !samePath(remembered, root) ? { recentWorkDir: path.resolve(remembered) } : {}),
      }
    },
    setMode(input) {
      return modes.setMode(input)
    },
    stopMode() {
      return modes.stop()
    },
    async executePlan() {
      return modes.execute()
    },
    async setWorkDir(input) {
      // 换工作目录会连带改读取授权，而改授权要重开这场会话 —— 回合进行中不能拆
      if (inFlight) return { ok: false, reason: '助手正在说完这一句，等它停下再换工作目录（要重开这场会话）' }
      const wanted = String(input?.dir ?? '').trim()
      let dir = ''
      let resumed = false
      if (wanted) {
        // 一键「继续用」只认上一场记下的那一个：否则这条通道就成了「递个路径就拿到读取授权」的口子
        const remembered = deps.lastWorkDir()
        if (!remembered || !samePath(wanted, remembered)) {
          return { ok: false, reason: '只能继续沿用上一场挑过的那个目录，换一个请走选择器' }
        }
        dir = remembered
        resumed = true
      } else {
        let picked: { ok: boolean; path?: string; reason?: string }
        try {
          picked = await deps.pickDirectory()
        } catch (e) {
          return fail(e)
        }
        dir = String(picked.path ?? '').trim()
        if (!picked.ok || !dir) return { ok: false, reason: picked.reason ?? '没有选择目录' }
      }
      const why = grantRejection(dir)
      if (why) {
        deps.log({ layer: 'runtime', stage: 'assistant:work-dir', ok: false, detail: `${why}（来源：${dir}）` })
        return { ok: false, reason: why }
      }
      const abs = path.resolve(dir)
      workDir = abs
      try {
        await deps.setLastWorkDir(abs)
      } catch (e) {
        // 没记住不影响这一场能用：下一场少一行「继续用」而已
        deps.log({ layer: 'runtime', stage: 'assistant:work-dir', ok: false, detail: `记住工作目录失败：${e instanceof Error ? e.message : String(e)}` })
      }
      const already = readDirs.some((d) => samePath(d, abs))
      if (already) {
        modes.setReadDirs(readDirs, `@ 引用从「${abs}」开始找`)
      } else if (readDirs.length >= MAX_READ_DIRS) {
        // 授权位子是满的：不悄悄挤掉谁，只说清楚这个目录现在只有 @ 能读到内容
        modes.setReadDirs(readDirs, `@ 引用从「${abs}」开始找（读取授权已满 ${MAX_READ_DIRS} 个，助手自己 read 不到它）`)
      } else {
        applyReadDirs([...readDirs, abs], `已把工作目录加入读取授权：${abs}`)
      }
      return {
        ok: true,
        reason: `${resumed ? `继续用「${abs}」` : `@ 引用现在从「${abs}」开始找`}（授权只在这场会话期间有效）`,
      }
    },
    atList(query) {
      return listAt(atRoot(), String(query ?? ''), atHidden())
    },
    async revokeDir(dir) {
      const raw = String(dir ?? '').trim()
      if (!raw) return { ok: false, reason: '缺少要撤销的目录路径' }
      if (!readDirs.some((d) => samePath(d, raw))) return { ok: false, reason: `「${raw}」不在这场会话的授权列表里` }
      if (inFlight) return { ok: false, reason: '助手正在说完这一句，等它停下再撤销' }
      const next = readDirs.filter((d) => !samePath(d, raw))
      // 撤销的正好是工作目录：@ 浏览的起点也要一起收掉，否则界面上还在往里挑文件，
      // 而助手那边已经读不到它 —— 两套边界分叉的下一步一定是「引用了个空东西」。
      // 收掉之后回到兜底根（助手的目录），@ 仍然可用，只是不再能挑那个项目。
      if (workDir && samePath(workDir, raw)) workDir = undefined
      applyReadDirs(next, `已撤销读取目录：${path.resolve(raw)}`)
      return {
        ok: true,
        reason: `已撤销「${raw}」的读取授权${
          workDir ? '' : `；@ 引用的工作目录也一起收了，现在回到助手目录「${defaultWorkDir()}」里挑，浮层里点一下可以继续用上次那个项目目录`
        }`,
      }
    },
    capabilities() {
      // 两个开关都以主进程的当前值为准：loadedCaps 是上一次装配时读到的快照，
      // 用户刚点过开关但还没重新对话时，界面上不能显示旧值。
      return {
        ...loadedCaps,
        // 目录路径不依赖会话装配，第一轮对话之前也该看得到 ——
        // 设置页要靠它告诉用户「清单文件该手动放在哪儿」。
        dirs: loadedCaps.dirs ?? {
          skills: assistantSkillsDir(deps.dataDir()),
          extensions: extensionsDirOf(deps.dataDir()),
          plugins: pluginsDirOf(deps.dataDir()),
        },
        extensionsEnabled: deps.extensionsEnabled(),
        selfAuthoringEnabled: deps.selfAuthoringEnabled(),
      }
    },
    async setExtensions(on) {
      const next = on === true
      if (next === deps.extensionsEnabled()) return { ok: true }
      // 开关要拆掉重开这场会话，回合进行中拆它等于把正在跑的那一轮凭空掐掉
      if (inFlight) return { ok: false, reason: '助手正在说完这一句，等它停下再改加载开关（要重开这场会话）' }
      try {
        await deps.setExtensionsEnabled(next)
      } catch (e) {
        return fail(e)
      }
      // 开关改变的是「会话组装时加载哪些资源」，所以现有会话必须拆掉重开
      dropPendingApprovals('助手能力配置已变更')
      assistant?.dispose()
      assistant = undefined
      loadedCaps = pendingCaps(next, '下一次对话时才会加载')
      deps.log({ layer: 'runtime', stage: 'assistant:extensions', ok: true, detail: next ? '开启技能/扩展' : '关闭技能/扩展' })
      return { ok: true }
    },
    async scanSkills() {
      const view = await scanSkills({ skillsDir: assistantSkillsDir(deps.dataDir()), home: deps.skillsHome?.() })
      // 导入了却没开加载开关，是最容易让人以为「坏了」的一种静默无效
      return { ...view, extensionsEnabled: deps.extensionsEnabled() }
    },
    async importSkill(input) {
      const r = await importSkill({
        skillsDir: assistantSkillsDir(deps.dataDir()),
        home: deps.skillsHome?.(),
        key: String(input?.key ?? ''),
        ...(input?.name ? { name: String(input.name) } : {}),
      })
      deps.log({ layer: 'runtime', stage: 'assistant:skill-import', ok: r.ok === true, detail: r.detail ?? r.name ?? r.reason })
      if (!r.ok) return r
      return { ...r, reason: r.reason ?? capabilityReloadNote('导入', { gated: true }) }
    },
    async removeSkill(name) {
      const r = await removeSkill({ skillsDir: assistantSkillsDir(deps.dataDir()), name: String(name ?? '') })
      deps.log({ layer: 'runtime', stage: 'assistant:skill-remove', ok: r.ok === true, detail: r.name ?? r.reason })
      if (!r.ok) return r
      return { ...r, reason: capabilityReloadNote('移除', { gated: true }) }
    },
    plugins: () => readPlugins(),
    pendingExtensions: (): PendingExtensionView[] => listPendingExtensions(pendingDirOf(deps.dataDir())),
    /** 删除插件清单：盘上少了，下一次装配就少一个工具 */
    async removePlugin(name) {
      const r = removePluginManifest(pluginsDirOf(deps.dataDir()), String(name ?? ''))
      deps.log({ layer: 'runtime', stage: 'assistant:plugin-remove', ok: r.ok, detail: r.reason })
      if (!r.ok) return r
      return { ok: true, reason: capabilityReloadNote(`删除插件 ${name}`) }
    },
    /**
     * 启用待审扩展：把文件搬进 extensions/。
     *
     * 这一步是整个自建链路里唯一「让任意代码进入主进程」的动作，所以它只能由设置页的
     * 按钮触发（助手调不到），并且界面上必须先把源码摆给人看过。
     */
    async enablePendingExtension(name) {
      const r = promotePendingExtension(pendingDirOf(deps.dataDir()), extensionsDirOf(deps.dataDir()), String(name ?? ''))
      deps.log({ layer: 'runtime', stage: 'assistant:extension-enable', ok: r.ok, detail: r.reason })
      if (!r.ok) return r
      return { ok: true, reason: `${r.reason}。${capabilityReloadNote('启用扩展', { gated: true })}` }
    },
    async dropPendingExtension(name) {
      const r = removePendingExtension(pendingDirOf(deps.dataDir()), String(name ?? ''))
      deps.log({ layer: 'runtime', stage: 'assistant:extension-drop', ok: r.ok, detail: r.reason })
      return r
    },
    async setSelfAuthoring(on) {
      const next = on === true
      if (next === deps.selfAuthoringEnabled()) return { ok: true }
      try {
        await deps.setSelfAuthoringEnabled(next)
      } catch (e) {
        return fail(e)
      }
      // 改的是「哪几个工具会被注册」，旧会话里的名单已经定了，只能拆掉重装配
      dropPendingApprovals('助手能力配置已变更')
      assistant?.dispose()
      assistant = undefined
      loadedCaps = pendingCaps(deps.extensionsEnabled(), '下一次对话时才会加载')
      deps.log({ layer: 'runtime', stage: 'assistant:self-authoring', ok: true, detail: next ? '开启自建工具' : '关闭自建工具' })
      return { ok: true }
    },
    approvalPrefs: () => deps.approvalPrefs(),
    /**
     * 改审批偏好：mode 与秒数都按外部输入处理（不认识的 mode 退回默认，
     * 秒数夹进可用范围），否则 preferences.json 手改一下就等于给了个任意定时器。
     *
     * 模式一变，挂在半空的卡片就失去了依据（比如从「超时自动批准」切到「只读」），
     * 所以先把未决卡片按拒绝结算掉，让人重新发起 —— 沿用旧模式放行才奇怪。
     */
    async setApprovalPrefs(input) {
      const mode: AssistantApprovalMode = isApprovalMode(input?.mode) ? input.mode : APPROVAL_PREFS_DEFAULT.mode
      const next: AssistantApprovalPrefs = { mode, timeoutMs: clampApprovalTimeout(input?.timeoutMs) }
      const cur = deps.approvalPrefs()
      const modeChanged = cur.mode !== next.mode
      if (!modeChanged && cur.timeoutMs === next.timeoutMs) {
        return { ok: true, reason: `当前审批模式：${describeApprovalPrefs(next)}` }
      }
      try {
        await deps.setApprovalPrefs(next)
      } catch (e) {
        return fail(e)
      }
      if (modeChanged) dropPendingApprovals('审批模式已变更')
      deps.log({ layer: 'runtime', stage: 'assistant:approval-prefs', ok: true, detail: describeApprovalPrefs(next) })
      return {
        ok: true,
        reason: `已切换为「${describeApprovalPrefs(next)}」${modeChanged ? '，之前没处理的确认已作废' : ''}`,
      }
    },
    async reset() {
      dropPendingApprovals('会话已重置')
      clearSessionScoped()
      assistant?.dispose()
      assistant = undefined
      // 新开一场文件，旧那场留在同一目录里，历史列表还能翻到
      target = { fresh: true }
      try {
        const a = await ensureAssistant()
        // 之后若因模型清单变化而重开，要接这一场，而不是再开第三场
        target = { file: a.sessionFile }
      } catch (e) {
        const r = fail(e)
        deps.log({ layer: 'runtime', stage: 'assistant:reset', ok: false, detail: r.detail })
        return r
      }
      return { ok: true }
    },
    dispose() {
      dropPendingApprovals('助手已关闭')
      assistant?.dispose()
      assistant = undefined
      pi = undefined
    },
  }

  // IPC 绑定：渲染层只看到这几个动作，其余全部留在主进程。
  // 放在显式 registerIpc() 里，因为 ipcMain.handle 必须在 app ready 之后挂。
  function registerIpc(): void {
    deps.handle('assistant:status', () => base.status())
    deps.handle('assistant:models', () => base.listModels())
    deps.handle('assistant:set-model', (a: { modelId?: unknown }) => base.setModel(String(a?.modelId ?? '')))
    deps.handle('assistant:send', (a: { text?: unknown; attachments?: unknown }) =>
      base.send(String(a?.text ?? ''), Array.isArray(a?.attachments) ? (a.attachments as ChatAttachmentMeta[]) : []),
    )
    deps.handle('assistant:steer', (a: { text?: unknown }) => base.steer(String(a?.text ?? '')))
    deps.handle('assistant:abort', () => base.abort())
    deps.handle('assistant:history', () => base.history())
    deps.handle('assistant:stats', () => base.stats())
    deps.handle('assistant:sessions', () => base.sessions())
    deps.handle('assistant:open-session', (a: { file?: unknown }) => base.openSession(String(a?.file ?? '')))
    deps.handle('assistant:delete-session', (a: { file?: unknown }) => base.deleteSession(String(a?.file ?? '')))
    deps.handle('assistant:capabilities', () => base.capabilities())
    deps.handle('assistant:set-extensions', (a: { on?: unknown }) => base.setExtensions(a?.on === true))
    deps.handle('assistant:skills-scan', () => base.scanSkills())
    deps.handle('assistant:skills-import', (a: { key?: unknown; name?: unknown }) =>
      base.importSkill({ key: String(a?.key ?? ''), ...(a?.name ? { name: String(a.name) } : {}) }),
    )
    deps.handle('assistant:skills-remove', (a: { name?: unknown }) => base.removeSkill(String(a?.name ?? '')))
    deps.handle('assistant:plugins', () => base.plugins())
    deps.handle('assistant:plugins-remove', (a: { name?: unknown }) => base.removePlugin(String(a?.name ?? '')))
    deps.handle('assistant:pending', () => base.pendingExtensions())
    deps.handle('assistant:pending-enable', (a: { name?: unknown }) => base.enablePendingExtension(String(a?.name ?? '')))
    deps.handle('assistant:pending-drop', (a: { name?: unknown }) => base.dropPendingExtension(String(a?.name ?? '')))
    deps.handle('assistant:set-self-authoring', (a: { on?: unknown }) => base.setSelfAuthoring(a?.on === true))
    deps.handle('assistant:approval-prefs', () => base.approvalPrefs())
    deps.handle('assistant:set-approval-prefs', (a: { mode?: unknown; timeoutMs?: unknown }) =>
      base.setApprovalPrefs({ mode: a?.mode, timeoutMs: a?.timeoutMs }),
    )
    // / 浮层：数据一条，动作各一条。浮层只负责显示与选择，模式怎么推进全在主进程
    deps.handle('assistant:overlay', () => base.overlay())
    deps.handle('assistant:set-mode', (a: { mode?: unknown; goal?: unknown }) =>
      base.setMode({ mode: a?.mode, ...(a?.goal ? { goal: a.goal } : {}) }),
    )
    deps.handle('assistant:stop-mode', () => base.stopMode())
    deps.handle('assistant:execute-plan', () => base.executePlan())
    deps.handle('assistant:set-workdir', (a: { dir?: unknown }) =>
      base.setWorkDir(a?.dir ? { dir: String(a.dir) } : undefined),
    )
    deps.handle('assistant:at-list', (a: { query?: unknown }) => base.atList(String(a?.query ?? '')))
    deps.handle('assistant:revoke-dir', (a: { path?: unknown }) => base.revokeDir(String(a?.path ?? '')))
    deps.handle('assistant:reset', () => base.reset())
    deps.handle('assistant:approval:respond', (a: { id?: unknown; decision?: AssistantApprovalDecision }) =>
      respond(String(a?.id ?? ''), a?.decision ?? { approved: false }),
    )
  }

  return { ...base, registerIpc }
}
