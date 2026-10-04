/**
 * Preload —— 通过 contextBridge 暴露白名单 API（PRD 11.2）
 *
 * 渲染进程只能调用此处显式列出的方法，拿不到 ipcRenderer 本体，
 * 也拿不到任何 Node 能力。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { HistoryEntry, RetryPlan } from '../shared/retry'
import type { DiagEvent, DoctorReport } from '../shared/diagnostics'
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
}

/**
 * 冷启动主题：主进程把已解析的明暗经 additionalArguments 递进来，
 * 在页面脚本执行之前就写进 <html data-theme>。
 *
 * 为什么不能放在渲染进程里等 IPC 回来再设：那一帧已经用默认配色画出来了，
 * 切主题会白闪一下；也不能写进 index.html 的 <script> —— CSP 是 script-src 'self'。
 */
// preload 与主进程同用一套 tsconfig（lib 里没有 DOM），这里只声明用到的那一小截
declare const document: { documentElement: { dataset: Record<string, string> } } | undefined

function applyBootTheme(): void {
  const arg = process.argv.find((a) => a.startsWith('--torra-theme='))
  const theme = arg?.split('=')[1] === 'light' ? 'light' : 'dark'
  if (typeof document !== 'undefined' && document?.documentElement) {
    document.documentElement.dataset.theme = theme
  }
}
applyBootTheme()

const api = {
  // 风险确认
  acknowledgeRisk: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('risk:acknowledge'),

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
  /** 从远程 API 拉取可用模型列表 */
  listRemoteModels: (baseUrl: string, apiKey: string): Promise<{ ok: boolean; models?: Array<{ id: string; name?: string }>; error?: string }> =>
    ipcRenderer.invoke('models:list-remote', baseUrl, apiKey),
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

  // 会话
  startSession: (topic: unknown, config: unknown): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('session:start', { topic, config }),
  interject: (text: string, target?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('session:interject', text, target),
  abortSession: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('session:abort'),

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
    },
  ): Promise<{ ok: boolean; reason?: string; accepted?: string[]; rejected?: Array<{ modelId: string; reason: string }> }> =>
    ipcRenderer.invoke('chat:send', payload),

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
  exportMarkdown: (sessionId: string): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke('report:export-markdown', sessionId),
  exportTranscript: (sessionId: string): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke('session:export-transcript', sessionId),

  // 密钥
  setSecret: (ref: string, value: string): Promise<{ ok: boolean; encrypted: boolean; reason?: string }> =>
    ipcRenderer.invoke('secrets:set', ref, value),
  hasSecret: (ref: string): Promise<{ has: boolean }> => ipcRenderer.invoke('secrets:has', ref),

  // 端到端体检与流水线日志
  runDoctor: (opts?: { modelId?: string; probeApi?: boolean }): Promise<DoctorReport> =>
    ipcRenderer.invoke('doctor:run', opts),
  doctorLog: (opts?: {
    n?: number
    sessionId?: string
    subject?: string
  }): Promise<{ events: DiagEvent[]; file: string | null }> => ipcRenderer.invoke('doctor:log', opts),
  exportDoctorReport: (report: DoctorReport): Promise<{ ok: boolean; json: string; md: string }> =>
    ipcRenderer.invoke('doctor:export', report),
  patchAdapterSelector: (input: {
    adapterId: string
    field: 'input' | 'stream' | 'health_probe'
    value: string
  }): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('adapters:patch', input),

  // 偏好设置
  loadPreferences: (): Promise<{ participantIds?: string[]; moderatorId?: string | null }> =>
    ipcRenderer.invoke('preferences:load'),
  savePreferences: (prefs: { participantIds: string[]; moderatorId: string | null }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('preferences:save', prefs),

  // 主题：mode 是用户意图，resolved 是这一刻该套的明暗
  getTheme: (): Promise<{ mode: ThemeMode; resolved: ThemeResolved }> => ipcRenderer.invoke('theme:get'),
  setTheme: (
    mode: ThemeMode,
  ): Promise<{ ok: boolean; reason?: string; mode?: ThemeMode; resolved?: ThemeResolved }> =>
    ipcRenderer.invoke('theme:set', mode),

  // 事件订阅：返回取消订阅函数
  on: (channel: string, handler: (payload: unknown) => void): (() => void) => {
    const allowed = new Set([
      'orchestrator:event',
      'report:ready',
      'risk:show',
      'adapters:changed',
      'models:changed',
      'login:result',
      'login:inventory',
      'chat:delta',
      'chat:thinking-delta',
      'chat:done',
      'chat:error',
      'smartadd:stage',
      'theme:resolved',
    ])
    if (!allowed.has(channel)) {
      throw new Error(`channel not allowed: ${channel}`)
    }
    const listener = (_e: unknown, payload: unknown) => handler(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}

contextBridge.exposeInMainWorld('torra', api)

export type TorraApi = typeof api
