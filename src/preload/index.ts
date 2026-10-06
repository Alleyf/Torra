/**
 * Preload —— 通过 contextBridge 暴露白名单 API（PRD 11.2）
 *
 * 渲染进程只能调用此处显式列出的方法，拿不到 ipcRenderer 本体，
 * 也拿不到任何 Node 能力。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { HistoryEntry, RetryPlan } from '../shared/retry'
import type { ChatAttachmentMeta, HotkeyConfig, HotkeyState } from '../shared/types'
import type { DiagEvent, DoctorReport, LogFileInfo, LogFilter, LogReadResult } from '../shared/diagnostics'
import type {
  AssistantApprovalPrefs,
  AssistantCapabilitiesView,
  AssistantHistoryItem,
  AssistantModelView,
  AssistantOverlayData,
  AssistantResult,
  AssistantSessionStats,
  AssistantSessionView,
  AssistantStatus,
  AtListing,
  PluginListView,
  PendingExtensionView,
  SkillImportResult,
  SkillScanView,
} from '../shared/assistant'
import type { ThemeMode, ThemeResolved } from '../shared/theme'
import type {
  ApiMetaResult,
  ApiProbe,
  WebPlanResult,
  WebRole,
} from '../shared/smart-add'

export interface ModelSummary {
  id: string
  displayName: string
  transport: 'webview' | 'api'
  color: string
  enabled: boolean
  supportsStructuredOutput: boolean
  adapterHealth: string
  adapterStale: boolean
  hasKey: boolean
  status: string
  /** 是否为用户自建模型（决定 UI 是否提供删除入口） */
  userDefined?: boolean
  adapterLastError?: string
}

export interface AdapterSummary {
  id: string
  name: string
  health: string
  verifiedAt: string
  stale: boolean
  tosNotice?: string
  origin?: 'builtin' | 'user'
  entry?: string
  selectors?: Record<string, string>
  lastError?: string
}

/** 选择器拾取扫描出的候选元素 */
export interface PickCandidate {
  selector: string
  candidates: Array<{ selector: string; matches: number }>
  tag: string
  text: string
  inViewport: boolean
}

export interface PickScan {
  input: PickCandidate[]
  send: PickCandidate[]
  stop: PickCandidate[]
  stream: PickCandidate[]
}

/** 登录态诊断结果 */
export interface LoginDiagnosis {
  ok: boolean
  reason?: string
  partition: string
  declaredPartition: string
  partitionMismatch: boolean
  cookieTotal: number
  authCookies: string[]
  /** 认证 cookie 有效期明细（名称/域/exp，exp 为 epoch 毫秒、0 为会话级），不含值 */
  credCookies?: Array<{ name: string; domain: string; exp: number }>
  /** 最早到期的认证 cookie（epoch ms）与其来源 cookie 名 */
  credExpiresAt?: number
  credExpiresCookie?: string
  credSessionOnly?: boolean
  storage: { localKeys: string[]; sessionKeys: string[] } | null
  probeOk: boolean
  /** 真实登录态。输入框存在不等于已登录 */
  loginState: 'logged-in' | 'logged-out' | 'unknown'
  pageUrl: string
  /** 判定所依据的原始观测 */
  evidence: {
    onLoginPage: boolean
    hasUserFlag: boolean
    hasLoginCta: boolean
    allLocalKeys: string[]
  } | null
  verdict: string
}

/** 新建网页版模型的入参 */
export interface NewModelInput {
  displayName: string
  entry: string
  color?: string
  selectors?: {
    input: string
    send?: string
    stop?: string
    generating?: string
    stream: string
  }
  input_kind?: 'textarea' | 'contenteditable'
  send_mode?: 'click' | 'enter'
  stream_mode?: 'last' | 'all'
  completion_mode?: 'stop_button_hidden' | 'generating_absent' | 'dom_stable'
  stable_ms?: number
  max_wait_s?: number
}

/** 新建 API 模型的入参 */
export interface NewApiModelInput {
  displayName: string
  baseUrl: string
  apiKey: string
  model: string
  protocol?: 'openai' | 'anthropic'
  color?: string
  pricePerMTokIn?: number
  pricePerMTokOut?: number
  maxContextTokens?: number
  /** 能否稳定输出可解析 JSON；缺省按协议推断 */
  supportsStructuredOutput?: boolean
  /** 端点是否接受图片输入（视觉）；缺省 false */
  vision?: boolean
}

/**
 * 编辑已有 API 模型的入参：缺省字段沿用当前配置。
 * apiKey 留空 = 不动钥匙串里已存的那份（旧 Key 不回显，界面上也无从带上）。
 */
export interface EditApiModelInput extends Partial<Omit<NewApiModelInput, 'apiKey'>> {
  apiKey?: string
}

/** 编辑弹窗预填用的配置，不含 Key */
export interface ApiModelEditableConfig {
  displayName: string
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic'
  color: string
  pricePerMTokIn: number
  pricePerMTokOut: number
  maxContextTokens: number
  supportsStructuredOutput: boolean
  vision: boolean
  hasKey: boolean
}

/**
 * 冷启动主题：在页面脚本执行之前就把明暗写进 <html data-theme>。
 *
 * 为什么不写在 index.html 里：CSP 是 script-src 'self'，内联引导脚本会被拦。
 * 为什么不等渲染进程调 IPC：那一帧已经按默认配色画完了，切换就是一次闪白。
 * 为什么不用 additionalArguments：实测沙箱 preload 收不到窗口传来的参数。
 */
// preload 与主进程同用一套 tsconfig（lib 里没有 DOM），这里只声明用到的那一小截
declare const document: { documentElement?: { dataset: Record<string, string> } } | undefined
declare class MutationObserver {
  constructor(cb: () => void)
  observe(target: unknown, options: { childList: boolean }): void
  disconnect(): void
}

function readBootTheme(): ThemeResolved {
  try {
    // 主进程在建窗口之前就注册了这个同步 handler（见 main/initTheme）
    return ipcRenderer.sendSync('theme:boot') === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

const BOOT_THEME = readBootTheme()

/**
 * preload 执行时文档还是空的（实测 documentElement 为 null），
 * 所以直接写会静默失败：挂 MutationObserver 等 <html> 一出现就补上。
 * at 记录写入时刻，供验证「有没有晚于首次绘制」——晚了就是一次闪色。
 * dev:renderer 在浏览器里打开时没有 preload，走渲染层自己的初值。
 */
declare const performance: { now(): number }

let bootWriteAt: number | null = null

function applyBootTheme(): { hasDocument: boolean; hadRoot: boolean; deferred: boolean; at: number | null } {
  const write = (root: { dataset: Record<string, string> }): void => {
    root.dataset.theme = BOOT_THEME
    bootWriteAt = performance.now()
  }
  const doc = document
  if (!doc) return { hasDocument: false, hadRoot: false, deferred: false, at: null }
  if (doc.documentElement) {
    write(doc.documentElement)
    return { hasDocument: true, hadRoot: true, deferred: false, at: bootWriteAt }
  }
  try {
    const observer = new MutationObserver(() => {
      const root = document?.documentElement
      if (root) {
        write(root)
        observer.disconnect()
      }
    })
    observer.observe(doc, { childList: true })
    return { hasDocument: true, hadRoot: false, deferred: true, at: null }
  } catch {
    return { hasDocument: true, hadRoot: false, deferred: false, at: null }
  }
}
const BOOT_DIAG = applyBootTheme()

/**
 * 主进程能推给渲染层的事件通道，也是渲染层唯一能订阅的通道。
 *
 * 这里必须和主进程的 webContents.send 一一对应，而且漏一条的代价远比想象大：
 * 订阅用的是 window.torra.on()，不在名单里就直接抛 —— 而它是在 useEffect 里被调的，
 * React 会把这次抛错一路冒到根，整棵树被卸掉，表现就是「应用白屏，且没有任何报错界面」。
 * 所以名单写成 as const 的数组并让 on 的参数取它的联合类型：
 * 少写一条从运行时的白屏变成编译期报错，改一处另一处就过不了 typecheck。
 */
const PUSH_CHANNELS = [
  'orchestrator:event',
  'report:ready',
  'risk:show',
  'adapters:changed',
  'models:changed',
  'login:result',
  'login:inventory',
  'chat:delta',
  'chat:thinking-delta',
  'chat:steps-delta',
  'chat:done',
  'chat:error',
  'smartadd:stage',
  // 识别用的独立窗口开/关：界面据此挂一条常驻横幅，给用户一个看得见也按得动的关闭入口
  'smartadd:scan-window',
  // 主进程请渲染层挂载 <WebviewDock> 来呈现某个模型的页面 —— 原生视图自己贴到主窗口上没有关闭按钮
  'webview:request',
  'assistant:stream',
  'assistant:approval:request',
  // 卡片结算还包括没人点的那几张：超时 / 自动放行 / 被丢弃，都靠这条把卡片从界面上收掉
  'assistant:approval:resolved',
  'theme:resolved',
] as const

export type PushChannel = (typeof PUSH_CHANNELS)[number]

const ALLOWED_PUSH: ReadonlySet<string> = new Set(PUSH_CHANNELS)

const api = {
  // 风险确认
  acknowledgeRisk: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('risk:acknowledge'),

  // 一次性上手引导（已读标记存在主进程）
  onboardingState: (): Promise<{ show: boolean }> => ipcRenderer.invoke('onboarding:state'),
  onboardingDismiss: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('onboarding:dismiss'),

  // 模型与适配器
  listModels: (): Promise<ModelSummary[]> => ipcRenderer.invoke('models:list'),
  /** 重新探测各模型真实状态（登录后刷新状态灯用） */
  probeModels: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('models:probe'),
  listAdapters: (): Promise<AdapterSummary[]> => ipcRenderer.invoke('adapters:list'),
  checkAdapter: (adapterId: string): Promise<{ ok: boolean; health?: string }> =>
    ipcRenderer.invoke('adapters:check', adapterId),

  // ---- 用户自建网页版模型（无需改代码即可扩展站点）----
  createWebModel: (input: NewModelInput): Promise<{ ok: boolean; id?: string; errors?: string[] }> =>
    ipcRenderer.invoke('models:create-web', input),
  deleteWebModel: (modelId: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('models:delete-web', modelId),

  // ---- 用户自建 API 模型 ----
  createApiModel: (input: NewApiModelInput): Promise<{ ok: boolean; id?: string; errors?: string[] }> =>
    ipcRenderer.invoke('models:create-api', input),
  deleteApiModel: (modelId: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('models:delete-api', modelId),
  /** 编辑已有 API 模型；返回 errors 为校验失败原因列表 */
  updateApiModel: (modelId: string, patch: EditApiModelInput): Promise<{ ok: boolean; errors?: string[] }> =>
    ipcRenderer.invoke('models:update-api', modelId, patch),
  /** 读取 API 模型的可编辑配置（不含 Key），供编辑弹窗预填 */
  getApiModelConfig: (modelId: string): Promise<{ ok: boolean; errors?: string[]; config?: ApiModelEditableConfig }> =>
    ipcRenderer.invoke('models:get-api', modelId),
  /** 从远程 API 拉取可用模型列表 */
  listRemoteModels: (baseUrl: string, apiKey: string): Promise<{ ok: boolean; models?: Array<{ id: string; name?: string }>; error?: string }> =>
    ipcRenderer.invoke('models:list-remote', baseUrl, apiKey),

  // ---- 侧栏模型管理：排序 / 停用 / 移除（内置=隐藏可恢复，自建=真删） ----
  /** 持久化侧栏拖动后的模型顺序 */
  reorderModels: (orderedIds: string[]): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('models:reorder', orderedIds),
  /** 停用（灰显、不参与）或启用某模型 */
  setModelEnabled: (modelId: string, enabled: boolean): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('models:set-enabled', modelId, enabled),
  /** 从侧栏移除：自建真删，内置持久隐藏（设置页可恢复） */
  removeModel: (modelId: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('models:remove', modelId),
  /** 被隐藏的内置模型清单，供设置页恢复 */
  listHiddenModels: (): Promise<Array<{ id: string; displayName: string; transport: 'webview' | 'api'; color: string; domain?: string }>> =>
    ipcRenderer.invoke('models:list-hidden'),
  /** 把隐藏的内置模型恢复回侧栏 */
  restoreModel: (modelId: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('models:restore', modelId),
  /** 打开临时窗口扫描页面选择器候选 */
  scanSelectors: (entry: string): Promise<{ ok: boolean; scan?: PickScan; reason?: string }> =>
    ipcRenderer.invoke('adapters:scan', entry),
  /** 复用已有模型的登录态扫描（更准：登录后的对话页才与自动化时 DOM 一致） */
  scanSelectorsOfModel: (modelId: string): Promise<{ ok: boolean; scan?: PickScan; reason?: string }> =>
    ipcRenderer.invoke('adapters:scan-model', modelId),

  // ---- 智能添加：给域名，产出经过页面校验的配置方案 ----
  /** 识别网页版：打开页面 → 读结构 → 助手推断 → 回页面校验 */
  smartAddWebPlan: (input: { entry: string; assistantModelId?: string }): Promise<WebPlanResult> =>
    ipcRenderer.invoke('smartadd:web-plan', input),
  /** 回答澄清问题，返回套用答案后的新方案 */
  smartAddWebRefine: (planId: string, answers: Record<string, string>): Promise<WebPlanResult> =>
    ipcRenderer.invoke('smartadd:web-refine', planId, answers),
  /** 手改选择器后重新取命中数 */
  smartAddWebVerify: (planId: string, selectors: Record<WebRole, string>): Promise<WebPlanResult> =>
    ipcRenderer.invoke('smartadd:web-verify', planId, selectors),
  /** 关闭识别用的临时窗口（弹窗卸载时调用） */
  smartAddClose: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('smartadd:close'),
  /** 嗅探 API 端点：地址形态 × 协议 × 鉴权，只做只读的 /models */
  smartAddApiProbe: (input: { address: string; apiKey?: string }): Promise<ApiProbe> =>
    ipcRenderer.invoke('smartadd:api-probe', input),
  /** 让助手补全价格与上下文（估计值，UI 必须标注来源） */
  smartAddApiMeta: (input: {
    assistantModelId?: string
    host: string
    baseUrl: string
    model: string
    protocol: 'openai' | 'anthropic'
  }): Promise<ApiMetaResult> => ipcRenderer.invoke('smartadd:api-meta', input),

  // 登录与转播
  openLogin: (modelId: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('login:open', modelId),
  /** 登录态诊断：cookie 是否落盘、存在哪、探针是否命中 */
  diagnoseLogin: (modelId: string): Promise<LoginDiagnosis> => ipcRenderer.invoke('login:diagnose', modelId),
  /** 强制刷新后台实例并复核 */
  refreshLogin: (
    modelId: string,
  ): Promise<{ ok: boolean; ready?: boolean; reason?: string; state?: string }> =>
    ipcRenderer.invoke('login:refresh', modelId),
  presentWebview: (modelId: string, bounds?: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('webview:present', modelId, bounds),
  dismissWebview: (modelId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('webview:dismiss', modelId),
  webviewMemory: (): Promise<{ estimatedMb: number; count: number }> =>
    ipcRenderer.invoke('webview:memory'),
  /** 主窗口无边框全屏：配合渲染层的放大布局，把网页视图当独立页面用 */
  webviewFullscreen: (on: boolean): Promise<{ ok: boolean; fullscreen?: boolean; reason?: string }> =>
    ipcRenderer.invoke('webview:fullscreen', on),
  /** 刷新网页视图当前这一份文档（停留在用户所在的会话页，不跳回站点入口） */
  webviewReload: (modelId: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('webview:reload', modelId),

  // 会话
  startSession: (topic: unknown, config: unknown): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('session:start', { topic, config }),
  interject: (text: string, target?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('session:interject', text, target),
  abortSession: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('session:abort'),

  // 人工介入（PRD 5.5）
  followup: (targetAgentId: string, text: string, targetUtteranceId?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('session:followup', targetAgentId, text, targetUtteranceId),
  requestDuel: (agentIds: string[], topic: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('session:duel', agentIds, topic),
  setStance: (agentId: string, stance: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('session:set-stance', agentId, stance),
  getStance: (agentId: string): Promise<{ stance: string | null }> =>
    ipcRenderer.invoke('session:stance', agentId),
  pauseSession: (reason?: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('session:pause', reason),
  resumeSession: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('session:resume'),
  listInterventions: (): Promise<{ interventions: unknown[]; duels: unknown[] }> =>
    ipcRenderer.invoke('session:interventions'),

  sessionState: (): Promise<unknown> => ipcRenderer.invoke('session:state'),

  // 聊天直连：把同一问题并行发给多个模型，各自独立作答
  chatSend: (
    payload: {
      chatId: string
      message: string
      system?: string
      items: Array<{ modelId: string; history: Array<{ role: 'user' | 'assistant'; content: string }> }>
      attachments?: ChatAttachmentMeta[]
    },
  ): Promise<{ ok: boolean; reason?: string; accepted?: string[]; rejected?: Array<{ modelId: string; reason: string }> }> =>
    ipcRenderer.invoke('chat:send', payload),

  // 聊天附件：字节存主进程资源目录，渲染层只留元数据
  attachmentSave: (
    a: { id: string; kind: 'image' | 'text'; name: string; mime: string; data: Uint8Array },
  ): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('attachment:save', a),
  attachmentRead: (
    id: string,
  ): Promise<{ ok: boolean; reason?: string; kind?: 'image' | 'text'; name?: string; mime?: string; base64?: string }> =>
    ipcRenderer.invoke('attachment:read', id),

  // 历史与重试
  listHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke('session:list'),
  getSessionDetail: (sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke('session:detail', sessionId),
  removeSession: (sessionId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('session:remove', sessionId),
  retrySession: (
    sessionId: string,
    plan: RetryPlan,
  ): Promise<{ ok: boolean; errors?: string[]; notices?: string[]; topic?: string }> =>
    ipcRenderer.invoke('session:retry', sessionId, plan),

  listSessions: (): Promise<unknown[]> => ipcRenderer.invoke('session:list'),

  // 报告
  getReport: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('report:get', sessionId),
  regenerateReport: (
    sessionId: string,
  ): Promise<{ ok: boolean; reason?: string; report?: unknown }> =>
    ipcRenderer.invoke('report:regenerate', sessionId),
  exportMarkdown: (sessionId: string): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke('report:export-markdown', sessionId),
  exportTranscript: (sessionId: string): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke('session:export-transcript', sessionId),

  // 密钥
  setSecret: (ref: string, value: string): Promise<{ ok: boolean; encrypted: boolean; reason?: string }> =>
    ipcRenderer.invoke('secrets:set', ref, value),
  hasSecret: (ref: string): Promise<{ has: boolean }> => ipcRenderer.invoke('secrets:has', ref),

  // 端到端体检与流水线日志。probeCompletion 会真发一次最小补全（按 token 计费），
  // 只有设置页那颗「试一次真实请求」按钮会带它。
  runDoctor: (opts?: {
    modelId?: string
    probeApi?: boolean
    probeCompletion?: boolean
  }): Promise<DoctorReport> => ipcRenderer.invoke('doctor:run', opts),
  doctorLog: (opts?: LogFilter): Promise<{ events: DiagEvent[]; file: string | null }> =>
    ipcRenderer.invoke('doctor:log', opts),
  listLogFiles: (): Promise<{ dir: string | null; keepDays: number; files: LogFileInfo[] }> =>
    ipcRenderer.invoke('logs:files'),
  readLogFile: (day: string, opts?: LogFilter): Promise<LogReadResult> =>
    ipcRenderer.invoke('logs:read', day, opts),
  openLogFolder: (): Promise<{ ok: boolean; path?: string; reason?: string }> =>
    ipcRenderer.invoke('logs:open'),
  pruneLogs: (): Promise<{ removed: string[]; dir: string | null }> => ipcRenderer.invoke('logs:prune'),
  exportDoctorReport: (report: DoctorReport): Promise<{ ok: boolean; json: string; md: string }> =>
    ipcRenderer.invoke('doctor:export', report),
  patchAdapterSelector: (input: {
    adapterId: string
    field: 'input' | 'stream' | 'health_probe'
    value: string
  }): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('adapters:patch', input),

  // ---- 助手 agent：通用运维助手，工具都在主进程执行 ----
  /** 助手状态：会话是懒创建的，未就绪不算错误 */
  assistantStatus: (): Promise<AssistantStatus> => ipcRenderer.invoke('assistant:status'),
  /** 全部模型清单；助手只能拿有 Key 的 API 模型当大脑，其余只是被诊断对象 */
  assistantModels: (): Promise<AssistantModelView[]> => ipcRenderer.invoke('assistant:models'),
  assistantSetModel: (modelId: string): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:set-model', { modelId }),
  /** 发起一轮对话；正文与工具轨迹都从 assistant:stream 推回来。attachments 走多模态/文本内联通道 */
  assistantSend: (text: string, attachments?: ChatAttachmentMeta[]): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:send', { text, attachments }),
  /** 往进行中的回合插话 */
  assistantSteer: (text: string): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:steer', { text }),
  assistantAbort: (): Promise<AssistantResult> => ipcRenderer.invoke('assistant:abort'),
  /** 对话历史：会话没建立时主进程会读磁盘上最近的一场 */
  assistantHistory: (): Promise<AssistantHistoryItem[]> => ipcRenderer.invoke('assistant:history'),
  /** 整场会话的累计账（token / 费用 / 上下文占用）；没对话过时为 null */
  assistantStats: (): Promise<AssistantSessionStats | null> => ipcRenderer.invoke('assistant:stats'),
  /** 历史会话列表，按最近修改排序 */
  assistantSessions: (): Promise<AssistantSessionView[]> => ipcRenderer.invoke('assistant:sessions'),
  /** 切到某场历史会话继续聊 */
  assistantOpenSession: (file: string): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:open-session', { file }),
  /** 删除一场历史会话（当前正在用的那场删不掉） */
  assistantDeleteSession: (file: string): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:delete-session', { file }),
  /** 技能 / 扩展的开关与已加载清单 */
  assistantCapabilities: (): Promise<AssistantCapabilitiesView> => ipcRenderer.invoke('assistant:capabilities'),
  assistantSetExtensions: (on: boolean): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:set-extensions', { on }),
  /** 扫描别的 agent 应用（Claude Code / Codex / Qoder / WorkBuddy / Trae…）里的技能 */
  assistantSkillsScan: (): Promise<SkillScanView> => ipcRenderer.invoke('assistant:skills-scan'),
  /** 以软链接方式把一条技能接进 Torra 的技能目录 */
  assistantSkillsImport: (input: { key: string; name?: string }): Promise<SkillImportResult> =>
    ipcRenderer.invoke('assistant:skills-import', input),
  /** 断开导入：只删 Torra 目录里的链接，不碰源目录 */
  assistantSkillsRemove: (name: string): Promise<SkillImportResult> =>
    ipcRenderer.invoke('assistant:skills-remove', { name }),
  /** 插件目录的现状：有效清单与读不出来的清单都直接读盘，不受技能/扩展开关约束 */
  assistantPlugins: (): Promise<PluginListView> => ipcRenderer.invoke('assistant:plugins'),
  /** 删除一条插件清单：下一次对话才少掉那个工具，已注册的不会立刻消失 */
  assistantPluginRemove: (name: string): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:plugins-remove', { name }),
  /** 待审扩展列表：助手写的 JS 都先落在这里，界面上要能读到源码本身 */
  assistantPending: (): Promise<PendingExtensionView[]> => ipcRenderer.invoke('assistant:pending'),
  /** 启用待审扩展：把文件搬进扩展目录，之后它直接跑在主进程里 */
  assistantPendingEnable: (name: string): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:pending-enable', { name }),
  /** 丢弃待审扩展：只删 pending 里那份文件 */
  assistantPendingDrop: (name: string): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:pending-drop', { name }),
  /** 「允许助手自建工具」开关：关着时那五个自建工具连注册都没有 */
  assistantSetSelfAuthoring: (on: boolean): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:set-self-authoring', { on }),
  assistantReset: (): Promise<AssistantResult> => ipcRenderer.invoke('assistant:reset'),
  /**
   * 回应确认卡片。
   * apiKey 只在「新建 API 模型」这类确认里出现：它直接进主进程写钥匙串，
   * 不会回流给模型，也不会出现在会话记录里。
   */
  assistantApprove: (
    id: string,
    decision: { approved: boolean; apiKey?: string; reason?: string },
  ): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('assistant:approval:respond', { id, decision }),
  /** 审批偏好：模式 + 「超时自动批准」的倒计时时长（主进程持久化） */
  assistantApprovalPrefs: (): Promise<AssistantApprovalPrefs> => ipcRenderer.invoke('assistant:approval-prefs'),
  assistantSetApprovalPrefs: (input: { mode?: string; timeoutMs?: number }): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:set-approval-prefs', input),
  /**
   * / 功能浮层的数据：模式快照 + 盘上的技能清单 + 技能开关。
   * 打开浮层时取一次，之后靠 assistant:stream 里的 mode 事件保持新鲜。
   */
  assistantOverlay: (): Promise<AssistantOverlayData> => ipcRenderer.invoke('assistant:overlay'),
  assistantSetMode: (input: { mode?: string; goal?: string }): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:set-mode', input),
  /** 停止自动推进：目标/计划的循环都吃这一条 */
  assistantStopMode: (): Promise<AssistantResult> => ipcRenderer.invoke('assistant:stop-mode'),
  /** 执行计划模式刚产出的那份计划（这时才放开写操作闸门） */
  assistantExecutePlan: (): Promise<AssistantResult> => ipcRenderer.invoke('assistant:execute-plan'),
  /**
   * 换 @ 引用浏览的项目目录（同时进读取授权）。
   * 不传 dir 开原生选择器；传了只认「上一场记下的那一个」，也就是浮层上那行「继续用」。
   */
  assistantSetWorkDir: (input?: { dir?: string }): Promise<AssistantResult> =>
    ipcRenderer.invoke('assistant:set-workdir', input ?? {}),
  /** @ 后面那半条路径的候选：读盘在主进程，界面只列结果 */
  assistantAtList: (query: string): Promise<AtListing> => ipcRenderer.invoke('assistant:at-list', { query }),
  assistantRevokeDir: (path: string): Promise<AssistantResult> => ipcRenderer.invoke('assistant:revoke-dir', { path }),

  // 偏好设置
  loadPreferences: (): Promise<{ participantIds?: string[]; moderatorId?: string | null }> =>
    ipcRenderer.invoke('preferences:load'),
  savePreferences: (prefs: { participantIds: string[]; moderatorId: string | null }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('preferences:save', prefs),

  /** 可拖动区域的宽度：键是区域名，值是像素；null 表示恢复默认（主进程删键） */
  layoutGet: (): Promise<Record<string, number>> => ipcRenderer.invoke('layout:get'),
  layoutSet: (key: string, value: number | null): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('layout:set', { key, value }),

  // 主题：mode 是用户意图，resolved 是这一刻该套的明暗
  /** 冷启动时 preload 实际拿到的明暗；渲染层用它兜底，也让「到底哪一环没生效」可查 */
  bootTheme: (): ThemeResolved => BOOT_THEME,
  bootDiag: () => ({ ...BOOT_DIAG, at: bootWriteAt }),
  getTheme: (): Promise<{ mode: ThemeMode; resolved: ThemeResolved }> => ipcRenderer.invoke('theme:get'),
  setTheme: (
    mode: ThemeMode,
  ): Promise<{ ok: boolean; reason?: string; mode?: ThemeMode; resolved?: ThemeResolved }> =>
    ipcRenderer.invoke('theme:set', mode),

  // 全局快捷键（唤起 / 最小化）：配置读写都经主进程，注册成败以主进程返回为准
  getHotkey: (): Promise<HotkeyState> => ipcRenderer.invoke('hotkey:get'),
  setHotkey: (cfg: HotkeyConfig): Promise<HotkeyState & { ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('hotkey:set', cfg),

  // 事件订阅：返回取消订阅函数。通道名单见上面的 PUSH_CHANNELS —— 漏一条是白屏级的
  on: (channel: PushChannel, handler: (payload: unknown) => void): (() => void) => {
    if (!ALLOWED_PUSH.has(channel)) {
      throw new Error(`channel not allowed: ${channel}`)
    }
    const listener = (_e: unknown, payload: unknown) => handler(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}

contextBridge.exposeInMainWorld('torra', api)

export type TorraApi = typeof api
