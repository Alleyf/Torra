/**
 * Torra 核心领域模型
 *
 * 对应 PRD：第 5 章（核心概念定义）、6.4（Agent 抽象）、6.7（共识度可计算定义）、
 * 6.8（上下文管理策略）。
 *
 * 设计要点：
 * - 本文件是 main / preload / renderer 三段共用的唯一类型来源，不得依赖任何运行时。
 * - PRD 中标记为「硬约束」「不可省」的规则，在此以类型与不变量函数的形式落地，
 *   而非仅写在文档里。
 */

// ---------------------------------------------------------------------------
// 传输与通道
// ---------------------------------------------------------------------------

export type TransportKind = 'webview' | 'api'

/** Agent 生命周期状态。对应 PRD 6.4 interface Agent.status */
export type AgentStatus =
  | 'ready'
  | 'busy'
  | 'expired'           // 会话过期（webview）
  | 'adapter-broken'    // 适配器失效
  | 'disabled'          // 用户禁用 / 移出本场
  | 'absent'            // 本轮未响应（缺席占位，非持久状态）

// ---------------------------------------------------------------------------
// 议题 / 讨论 / 轮次
// ---------------------------------------------------------------------------

/** 议题（Topic）—— PRD 第 5 章 */
export interface Topic {
  id: string
  title: string
  /** 背景材料 */
  background: string
  /** 策略模式（PRD 7.4）。仅影响主持 Prompt，不改变底层调度 */
  strategy: StrategyKind
  attachments: Attachment[]
  createdAt: number
}

export type StrategyKind = 'roundtable' | 'debate' | 'review'

export interface Attachment {
  id: string
  kind: 'file' | 'link'
  name: string
  /** file: 绝对路径；link: URL */
  ref: string
}

/** 讨论配置（SessionConfig）——对应 PRD 7.1 P0-3 */
export interface SessionConfig {
  /** 最大轮次，默认 3 */
  maxRounds: number
  /** 共识阈值，默认 85 */
  consensusThreshold: number
  /** 参与发言的 agentId 列表。主持默认不在其中（PRD 6.5） */
  participantIds: string[]
  /** 主持 agentId */
  moderatorId: string | null
  /** 预算上限（USD）；达到后自动收束并出报告（PRD 7.1 P0-2） */
  budgetLimitUsd: number
}

/** 一轮中的发言（Message） */
export interface Utterance {
  id: string
  round: number
  agentId: string
  content: string
  /** 本条发言回应的发言 id 列表（点名回应，PRD 6.7） */
  targets: string[]
  /** 缺席时为 true，content 保留占位说明 */
  absent?: boolean
  absentReason?: string
  /** 该模型在议题点上的立场标记，供程序核算「立场一致度」 */
  stance?: StanceMark
  /**
   * 人类介入的发言。计入记录与报告，但**不计入**共识度核算 ——
   * 人的表态不是模型共识的组成部分（PRD 6.7）。
   */
  human?: boolean
  usage?: TokenUsage
  /** 实际发给模型的输入（渲染后的 prompt），供 UI 查看「输入/输出」 */
  input?: UtteranceInput
  /**
   * 推理模型透出的思维链（reasoning / thinking），与最终答案分开保存。
   * 仅 API 通道且模型支持思考时才有；供 UI「思考」区块展示与复制。
   */
  thinking?: string
  startedAt: number
  endedAt: number
}

/**
 * 一条发言的输入侧。
 *
 * 记录适配器真正发给模型的文本：API 通道分 system+user 两段，
 * 网页通道只有一个合并后的 prompt（放 user）。
 * 让用户能核对「模型到底看到了什么」，而不是只看到结论。
 */
export interface UtteranceInput {
  system?: string
  user?: string
}

export type StanceMark = 'support' | 'oppose' | 'neutral' | 'conditional'

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  /** 按模型单价折算的 USD */
  costUsd: number
}

/**
 * 轮次元信息（RoundMeta）—— 一轮 = 1 个并行发言批次 + 1 次主持小结（PRD 6.2）
 */
export interface RoundMeta {
  round: number
  /** 本轮是否因超时/故障产生缺席 */
  degraded: boolean
  utteranceIds: string[]
  startedAt: number
  endedAt: number
}

// ---------------------------------------------------------------------------
// 共识 / 分歧（PRD 6.7、6.8）
// ---------------------------------------------------------------------------

export interface ConsensusPoint {
  id: string
  claim: string
  /** 支持方 agentId 列表。程序校验其必须指向真实发言（PRD 6.7） */
  support: string[]
  confidence: number
  /** 依据：指向具体发言 id（Prompt 硬约束要求） */
  evidenceRef: string[]
  /** 该共识在哪一轮被确认 */
  confirmedRound: number
}

export interface OpenDispute {
  id: string
  claim: string
  sides: DisputeSide[]
  /** 首次登记的轮次 */
  openedRound: number
  /** 最近一轮的进展说明；null 表示无进展 */
  lastProgress: string | null
  status: 'open' | 'resolved'
  /** 被消解的依据（status=resolved 时必填） */
  resolutionRef?: string[]
}

/**
 * PRD 6.8 硬约束：open 清单在整个会话生命周期内只增不减
 * ——除非该条分歧被明确消解并记录消解依据。
 */
export const OPEN_DISPUTE_LIFECYCLE = {
  /** 压缩时 open 字段逐字搬运，不经改写 */
  preserveOnCompress: true,
  /** 消解必须给出依据 */
  requireResolutionRef: true,
} as const

export interface DisputeSide {
  agentId: string
  argument: string
  utteranceIds: string[]
}

/**
 * 共识度三维度（PRD 6.7）——主持不得只给一个主观总分
 */
export interface ConsensusScore {
  /** 立场一致度 0-100，可由程序从发言立场标记直接核算 */
  agreement: number
  /** 论点重合度 0-100，需列出被 >=2 模型共同提及的论点 */
  overlap: number
  /** 收敛趋势 0-100，由程序计算未决分歧数量变化，主持仅确认 */
  trend: number
  /** 加权综合分 = 0.4*agreement + 0.3*overlap + 0.3*trend */
  score: number
}

export const CONSENSUS_WEIGHTS = {
  agreement: 0.4,
  overlap: 0.3,
  trend: 0.3,
} as const

// ---------------------------------------------------------------------------
// 结构化纪要 Digest（PRD 6.8）
// ---------------------------------------------------------------------------

/**
 * 注入模型的历史不是全文，而是本结构。
 * PRD 6.8：confirmed 与 explored 可被概括，open 必须逐字保留。
 */
export interface Digest {
  confirmed: ConsensusPoint[]
  /** 未决分歧——逐字保留，不允许概括（硬约束） */
  open: OpenDispute[]
  /** 已被充分讨论并排除的方向 */
  explored: string[]
  rounds: RoundMeta[]
}

export const CONTEXT_COMPRESSION = {
  /** 低于此 token 数不压缩 */
  fullInjectBelow: 8_000,
  /** 超过此值强制压缩 */
  forceCompressAbove: 20_000,
} as const

// ---------------------------------------------------------------------------
// Agent（PRD 6.4）
// ---------------------------------------------------------------------------

/** 参与讨论的发言轮次上下文 */
export interface TurnContext {
  sessionId: string
  round: number
  topic: Topic
  digest: Digest
  /** 主持点名的要求（PRD 附录 B） */
  callout: Callout | null
  maxLenChars: number
  /**
   * 用户中途指定的立场（PRD 5.5 调整立场）。
   * 覆盖默认立场分配，要求模型按新立场发言。
   */
  stanceOverride?: string
  /**
   * 人类参与者的介入内容（PRD 5.5）。
   * 只投递给被指定的目标模型；为 null 表示本批次无投递给该模型的介入。
   *
   * 关键：这是**独立区块**，不是 digest 的一部分 —— 放进 explored 会被摘要器
   * 当成"已排除方向"稀释掉。
   */
  humanIntervention?: string | null
  /**
   * 上一场讨论的结论，作为「已知前提」注入（continue 重试模式）。
   *
   * 措辞已明确要求模型独立判断、可以反驳 —— 避免"抄上一轮答案"式假共识。
   * 这部分**不写入** confirmed/open，因此不参与共识度核算。
   */
  priorConclusion?: string | null
  /**
   * 聊天直连模式。设置后 agent 走独立对话提示词，绕过圆桌参会者的发言格式。
   *
   * - API 通道：携带完整 history，逐字作为多轮 messages 发给模型；
   * - 网页通道：只把最后一条 user 内容键入站点输入框，
   *   既往轮次由站点自身的会话上下文维持（同一个 WebContents 连续对话）。
   *
   * 与讨论模式互斥：chat 存在时，topic/digest/callout 一律不参与提示词。
   */
  chat?: {
    history: Array<{ role: 'user' | 'assistant'; content: string }>
    system?: string
  }
}

export interface Callout {
  targetAgent: string
  quoteFromAgent: string
  quote: string
  instruction: string
}

/** 模型定义（配置态） */
export interface ModelConfig {
  id: string
  displayName: string
  transport: TransportKind
  /** webview 通道的分区名（持久化登录态） */
  partition?: string
  /** adapter id，webview 通道必填 */
  adapterId?: string
  /** api 通道的端点与模型名 */
  api?: ApiConfig
  /** 模型标识色，仅用于头像环/发言卡色条/@提及（PRD 9 色彩纪律） */
  color: string
  /** 是否支持结构化输出——不支持者不能担任主持（PRD 6.5） */
  supportsStructuredOutput: boolean
  enabled: boolean
}

export interface ApiConfig {
  baseUrl: string
  model: string
  apiKeyRef: string
  /** API 协议，默认 openai */
  protocol?: 'openai' | 'anthropic'
  /** 单价，用于费用估算（USD / 1M tokens） */
  pricePerMTokIn: number
  pricePerMTokOut: number
  maxContextTokens: number
}

// ---------------------------------------------------------------------------
// 状态机（PRD 6.7）
// ---------------------------------------------------------------------------

export type OrchestratorState =
  | 'INIT'
  | 'LOGIN_CHECK'
  | 'READY'
  | 'ROUND_START'
  | 'AGENT_BATCH'
  | 'MODERATOR_SUMMARY'
  | 'MODERATOR_RETRY'
  | 'PAUSE_FOR_USER'
  | 'CONSENSUS_EVAL'
  | 'REPORT_GEN'
  | 'DONE'
  | 'ABORTED'
  | 'FAILED'

/** 主持模型的小结输出（结构化 JSON，PRD 附录 A） */
export interface ModeratorDigest {
  consensus_points: Array<{
    claim: string
    support: string[]
    confidence: number
    evidence_ref: string[]
  }>
  open_disputes: Array<{
    claim: string
    sides: Array<{ agent_id: string; argument: string }>
  }>
  score_dimensions: { agreement: number; overlap: number; trend: number }
  score: number
  next_round_order: string[]
  callout: { target_agent: string; quote_from_agent: string; instruction: string } | null
}

/**
 * 汇报校验结果（PRD 6.7）
 * 主持声称的共识点，其 support 必须指向真实存在的发言 id，
 * 否则拒绝该次小结并要求重打。
 */
export interface DigestValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// 报告（PRD 7.1 P0-7）
// ---------------------------------------------------------------------------

export interface Report {
  sessionId: string
  executiveSummary: string
  consensus: ConsensusReportItem[]
  disputes: DisputeReportItem[]
  blindSpots: string[]
  /** 人类介入记录摘要（PRD 5.5：单列一章，不混入模型发言） */
  interventions: string[]
  /** 专项对辩轮摘要 */
  duels: Array<{ topic: string; agentIds: string[]; utteranceCount: number }>
  meta: ReportMeta
  generatedAt: number
}

export interface ConsensusReportItem {
  claim: string
  /** 认同模型数（PRD 7.1 P0-7 强制标注） */
  supporterCount: number
  supporters: string[]
  argument: string
  sourceRounds: number[]
  /** 溯源：指向具体发言 id */
  sourceUtteranceIds: string[]
}

export interface DisputeReportItem {
  claim: string
  sides: Array<{ agentId: string; argument: string; sourceRounds: number[] }>
  whyUnresolved: string
  openedRound: number
}

export interface ReportMeta {
  models: Array<{ id: string; displayName: string; transport: TransportKind }>
  rounds: number
  totalCostUsd: number
  durationMs: number
  /** 缺席模型 id 列表 */
  absentAgents: string[]
  budgetLimited: boolean
  /** 无主持降级时为 true（PRD 6.2） */
  moderatorUnavailable: boolean
  consensusAvailable: boolean
  finalConsensusScore: ConsensusScore | null
  /** 人类介入次数（PRD 5.5：报告中单列一章） */
  interventionCount: number
  /** 专项对辩轮次数 */
  duelCount: number
}

// ---------------------------------------------------------------------------
// 人工介入（PRD 5.5 / 8.2 / 7.1 P0-8）
// ---------------------------------------------------------------------------

/**
 * 人工介入动作类型。
 *
 * 关键设计：介入**不是**普通上下文。它有独立类型与独立的生命周期，
 * 不能被塞进 explored（那会被摘要器当成"已排除方向"淡化掉），
 * 也不能计入共识度核算（人的表态不是模型共识的组成部分）。
 */
export type InterventionKind =
  | 'interject'      // 插话：内容进入下一批次所有（或指定）模型的上下文
  | 'followup'       // 定向追问：指定模型就某条发言/议题点再答一轮
  | 'duel'           // 要求对辩：两个模型就某议题点追加专项轮
  | 'set-stance'     // 调整立场：中途改某模型立场，下一轮生效
  | 'stop'           // 中止并出报告

export type InterventionStatus = 'pending' | 'delivered' | 'cancelled'

export interface Intervention {
  id: string
  kind: InterventionKind
  /** 用户原始输入文本（set-stance 时为新立场描述） */
  text: string
  /** 发起时所处的轮次（用于报告溯源） */
  atRound: number
  createdAt: number

  // ---- interject ----
  /** 为空表示对全员；否则仅投递给这些 agent（PRD 5.5） */
  targetAgentIds: string[]

  // ---- followup ----
  /** 被追问的发言 id */
  targetUtteranceId?: string
  /** 被追问模型 */
  targetAgentId?: string

  // ---- duel ----
  duelAgentIds?: string[]
  /** 对辩的议题点；缺省表示该轮全部未决分歧 */
  topic?: string

  // ---- set-stance ----
  stanceAgentId?: string
  stanceBefore?: string
  stanceAfter?: string

  status: InterventionStatus
  /** 实际生效的轮次 */
  deliveredRound?: number
  /** 处置说明：如"目标模型已缺席，已改投全员" */
  note?: string
}

/** 人类参与者的固定 agentId，报告中单列一章（PRD 5.5） */
export const HUMAN_AGENT_ID = 'human'

/**
 * 专项对辩轮：不计入常规轮次编号，也不参与收敛度判定。
 * 依据 PRD 5.5「要求辩论：追加一轮专项轮次，突破原轮次上限」。
 */
export interface DuelRound {
  id: string
  /** 关联的主轮次 */
  parentRound: number
  topic: string
  agentIds: string[]
  utterances: Utterance[]
  createdAt: number
  endedAt?: number
}

// ---------------------------------------------------------------------------
// 会话持久化（PRD 10 SQLite，此处先定义接口）
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string
  topic: Topic
  config: SessionConfig
  state: OrchestratorState
  rounds: RoundMeta[]
  utterances: Utterance[]
  confirmed: ConsensusPoint[]
  open: OpenDispute[]
  explored: string[]
  scores: Array<{ round: number; score: ConsensusScore }>
  /** 人工介入全记录（PRD 5.5：可追溯） */
  interventions: Intervention[]
  /** 专项对辩轮 */
  duels: DuelRound[]
  /** 讨论结局；进行中为 null。历史列表据此判断可否重试 */
  finishedReason: 'converged' | 'max-rounds' | 'aborted' | 'no-moderator' | 'failed' | null
  /** 本场是否由重试发起 */
  retryMode: string | null
  /** 重试来源会话 id */
  retrySourceId: string | null
  report: Report | null
  totalCostUsd: number
  createdAt: number
  updatedAt: number
}
