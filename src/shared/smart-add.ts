/**
 * 智能添加模型的共享类型（main / preload / renderer 三段共用，不得依赖运行时）
 *
 * 背景：手动配置一个网页版模型要理解 input/send/stop/stream 四个选择器、
 * 输入框形态、发送方式、回复读取与完成判定 —— 这些概念本来只有写适配器的人
 * 才清楚。智能添加把「读页面 → 猜配置 → 逐条校验」交给一个 API 模型，
 * 人只负责回答它拿不准的问题。
 *
 * 关键约束：模型给的只是**建议**，每个选择器都必须回到真实页面上验证命中数
 * （见 checks）。没有经过验证的配置不进创建流程。
 */

import type { CompletionMode, InputKind, SendMode, StreamMode } from './adapter'

/** 适配器需要的页面角色 */
export type WebRole = 'input' | 'send' | 'stop' | 'stream' | 'generating'

export const WEB_ROLES: WebRole[] = ['input', 'send', 'stop', 'stream', 'generating']

/** 单个选择器在真实页面上的验证结果 */
export interface SelectorCheck {
  selector: string
  matches: number
  level: 'ok' | 'warn' | 'fail'
  note?: string
}

/** 澄清问题可回填的字段 */
export type QuestionTarget =
  | 'name'
  | 'entry'
  | 'input_kind'
  | 'send_mode'
  | 'stream_mode'
  | 'completion_mode'
  | 'selectors.input'
  | 'selectors.send'
  | 'selectors.stop'
  | 'selectors.stream'
  | 'selectors.generating'

/** 助手拿不准的地方 —— 渲染成结构化卡片，用户点选而非自由聊天 */
export interface SmartQuestion {
  id: string
  prompt: string
  target: QuestionTarget
  options: Array<{ value: string; label: string; hint?: string }>
  /** 选项不够用时允许补充说明 */
  free_text?: boolean
}

/** 一次智能识别产出的完整方案 */
export interface WebPlan {
  planId: string
  entry: string
  name: string
  selectors: Record<WebRole, string>
  input_kind: InputKind
  send_mode: SendMode
  stream_mode: StreamMode
  completion_mode: CompletionMode
  stable_ms: number
  /** 0~1，供 UI 决定「直接创建」还是「请用户确认」 */
  confidence: Partial<Record<WebRole | 'overall', number>>
  why: Partial<Record<WebRole | 'overall', string>>
  risks: string[]
  questions: SmartQuestion[]
  checks: Partial<Record<WebRole, SelectorCheck>>
  /** assistant=由配置助手推断；heuristic=纯规则降级（未配 API 模型时） */
  source: 'assistant' | 'heuristic'
  assistant: { modelId: string; displayName: string } | null
  login: { state: 'logged-in' | 'logged-out' | 'unknown'; reason: string }
  /** 已经过了几轮「模型出方案 → 页面校验 → 回修」 */
  rounds: number
}

export interface WebPlanResult {
  ok: boolean
  plan?: WebPlan
  reason?: string
}

/** 识别过程的阶段事件，供 UI 显示「现在在做什么」 */
export interface SmartStage {
  kind: 'web' | 'api'
  stage: 'open' | 'wait' | 'snapshot' | 'ask' | 'verify' | 'probe' | 'meta' | 'done' | 'error'
  text: string
}

// ---------------------------------------------------------------------------
// API 接入模型的智能识别
// ---------------------------------------------------------------------------

/** 一次端点嗅探尝试（GET {base}/models，两种鉴权头各试一次） */
export interface ApiAttempt {
  base: string
  protocol: 'openai' | 'anthropic'
  status: number | null
  ok: boolean
  modelCount: number
  error?: string
}

export interface ApiProbe {
  ok: boolean
  attempts: ApiAttempt[]
  baseUrl?: string
  protocol?: 'openai' | 'anthropic'
  models?: string[]
  /** 端点可达但拒绝鉴权：需要用户补 Key */
  needsKey?: boolean
  reason?: string
}

/** 模型清单之外的元信息（价格/上下文）由助手补，标为估计值 */
export interface ApiMeta {
  displayName: string
  pricePerMTokIn: number
  pricePerMTokOut: number
  maxContextTokens: number
  supportsStructuredOutput: boolean
  confidence: number
  note: string
}

export interface ApiMetaResult {
  ok: boolean
  meta?: ApiMeta
  reason?: string
}
