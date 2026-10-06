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

/** 聊天附件类型：图片走多模态；文本/代码并入问题文字 */
export type ChatAttachmentKind = 'image' | 'text'

/**
 * 聊天附件的轻量元数据。
 *
 * 字节存在主进程的资源目录（dataDir/chat-assets/{id}），这里只留引用 ——
 * 否则 base64 图片写进 localStorage 会立刻撑爆配额。渲染层凭 id 走
 * attachment:read 回捞预览，主进程凭 id 读回字节喂给模型。
 */
export interface ChatAttachmentMeta {
  id: string
  kind: ChatAttachmentKind
  name: string
  mime: string
  size: number
}

/** 已解析的图片附件：base64（不含 data: 前缀）+ MIME */
export interface ChatImage {
  mime: string
  base64: string
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
  /**
   * 匿名互评：主持小结与注入模型的历史纪要只看论点、不看厂商身份。
   *
   * 关掉即「署名轨」，同一议题重跑一次就能对照匿名/署下的共识度差值 ——
   * 差值本身是模型抱团程度的证据。旧存档无此字段，按署名轨处理。
   */
  anonymousReview?: boolean
  /**
   * 单模型基线：讨论开始前，让主持（无主持则第一位参会者）就同题独立答一次。
   *
   * 没有基线，「研讨结果好」这句话无法被证伪 —— 它只回答「大家说了什么」，
   * 不回答「比直接问最强的那一个强在哪」。旧存档无此字段，按关闭处理。
   */
  baseline?: boolean
  /** 基线对照：出报告前让主持比一次「研讨多出什么 / 基线有什么而研讨丢了什么」 */
  baselineCompare?: boolean
  /**
   * 幻觉核验轮。
   * - off：只测量不矫正
   * - auto：风险达标才跑（默认）
   * - always：只要存在被代答的共识点就逐条质询
   */
  verifyPass?: VerifyPassMode
  /**
   * 时长预算（ms）。网页通道的 costUsd 恒为 0，只靠金额熔断等于没有闸门；
   * 这里用墙钟兜住「5 个网页模型 × 若干轮」的真实代价。
   */
  timeBudgetMs?: number
}

export type VerifyPassMode = 'off' | 'auto' | 'always'

export const VERIFY_PASS_DEFAULT: VerifyPassMode = 'auto'
export const TIME_BUDGET_DEFAULT_MS = 12 * 60_000
export const TIME_BUDGET_MIN_MS = 60_000
export const TIME_BUDGET_MAX_MS = 60 * 60_000

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
  /**
   * agent 型网页站（Kimi 等）的执行过程：检索、跑代码、写文件等步骤文本。
   * 与正文和思维链都分开，供 UI「执行过程」折叠块展示。
   */
  steps?: string
  /**
   * 本轮的非致命异常提示（如「附件未送达：2 张（输入框拿不到焦点）」）。
   * 发言照常计入，只在卡片上挂一个警示角标 —— 半失败的轮次不能静默。
   */
  note?: string
  /**
   * 发言内的引用自审（程序机械核验的结果，不是模型自评）。
   *
   * 只覆盖「本场可核验的幻觉」：引用了不存在的发言、引用了尚未发生的轮次。
   * 这类幻觉不需要外部知识就能判死，因此必须在产生的当下记账 ——
   * 越早拦下，越不会在下一轮被别的模型当作既定事实接住。
   */
  citations?: CitationAudit
  startedAt: number
  endedAt: number
}

/**
 * 一条发言的引用自审结果。
 *
 * 三种「本场可判死」的凭空引用：发言 id 不存在、轮次越界、指名的参会者不在场。
 * 只统计显式引用标记，不做语义猜测 —— 判据必须能被用户复算。
 */
export interface CitationAudit {
  /** 引用到真实存在的发言 id */
  validUtteranceIds: string[]
  /** 形似发言 id 但本场查无此条 */
  bogusUtteranceIds: string[]
  /** 引用的轮次号 */
  roundRefs: number[]
  /** 越界轮次（<1 或大于当前轮）—— 即「引用了还没发生的讨论」 */
  outOfRangeRounds: number[]
  /** 提到但不在本场参会表里的别名/标识 */
  unknownLabels: string[]
  /** 无任何引用标记时为 true：不算幻觉，也不算有效引用 */
  noCitations: boolean
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
  /**
   * 证据权重 0-1，由主持给出、程序只校验范围。
   * 与 confidence 的分工：confidence 是「认同的普遍程度」，weight 是「支撑它的证据有多硬」。
   * 旧存档无此字段。
   */
  weight?: number
  /**
   * 跨轮归并时留下的其他措辞。
   *
   * 主持每轮重新措辞，同一判断会被写成好几种说法。程序按内容归并为一条，
   * 但把原始说法逐条保留在这里 —— 归并是压缩呈现，不是改写历史，
   * 用户要能核对「合并掉的到底是哪几句」。旧存档无此字段。
   */
  variants?: string[]
  /**
   * 核验状态：这条共识的「谁同意了」被谁核对过、核对结果如何。
   *
   * 关键约束：核验只会**降级**支持方，绝不会让共识点消失。
   * 全员否认的条目转为 vacated 并留在报告里 —— 「被证明没人说过」是一条结论，
   * 静默删除则是把幻觉换成另一种幻觉（PRD 6.8 只增不减的同一条理由）。
   */
  verification?: ConsensusVerification
}

export type ConsensusVerificationStatus =
  /** 尚未核验（默认，报告按「未核对」呈现） */
  | 'unverified'
  /** 每位声称的支持者都能在本人发言中找到原文 */
  | 'verified'
  /** 存在代答支持，且已被核验轮质询过 */
  | 'disputed'
  /** 质询后支持方归零 —— 保留条目本身，标注为「无实质支持者」 */
  | 'vacated'

export interface ConsensusVerification {
  status: ConsensusVerificationStatus
  /** 发起核验的轮次 */
  checkedRound: number
  /** 声称支持但本人发言无原文的模型（核验发起时的快照） */
  attributed: string[]
  /** 质询后被模型本人确认的模型 */
  confirmedBy: string[]
  /** 质询后被模型本人否认、已从 support 移除的模型 */
  removed: string[]
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
  /**
   * agreement 这一维是**怎么来的**。
   *
   * - stance：从发言立场标记核算，值可信但受独立性折扣影响；
   * - no_stance：全场没有任何显式表态句式，按中性 50 计入。
   *   旧实现直接记 0，导致总分上限只有 60、阈值 85 永远够不到 ——
   *   那不是「没共识」，那是「我们的判据看不见共识」。诚实的做法是标注来源，
   *   并让收敛判定不只依赖这个分数（见 evaluateConvergence）。
   */
  agreementSource?: AgreementSource
  /** 论点重合度取的是程序核算值还是主持自评（后者只在程序无数据时兜底） */
  overlapSource?: 'program' | 'moderator_fallback'
  /**
   * 独立性系数 0-1：主导阵营里「带可核对论据」的发言占比。
   * 口号式一致同意会被它压低 —— 这是防「从众式假收敛」的那一层。
   */
  independence?: number
}

export type AgreementSource = 'stance' | 'no_stance'

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
   * 程序发起的质询（不是人类发言，也不是主持观点）。
   *
   * 用于幻觉治理里的「当场拦下」：某条发言引用了不存在的发言或尚未发生的轮次时，
   * 下一轮先让它自己澄清，再进入常规论证。必须与 humanIntervention 分开 ——
   * 塞进人类介入区，报告里就会把程序的核验记成用户的发言，归属直接错。
   */
  systemChallenge?: string | null
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
    history: Array<{
      role: 'user' | 'assistant'
      content: string
      /**
       * 图片附件（已解析成 base64），只挂在当前这条 user 消息上。
       * API 通道据此拼多模态 content parts；网页通道据此尽力粘贴。
       * 历史轮次的图片不回传，以文本形式保留即可。
       */
      images?: ChatImage[]
    }>
    system?: string
  }
}

export interface Callout {
  targetAgent: string
  quoteFromAgent: string
  quote: string
  instruction: string
  /**
   * 给模型看的署名：匿名轨是别名，署名轨是真实 id。
   * quoteFromAgent 必须保持真实 id —— 它是发言血缘（targets）的唯一来源；
   * 提示词只印这个字段，否则匿名轨会在「点名回应」这一步把身份漏回去。
   */
  quoteFromLabel?: string
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
  /** 该端点是否接受图片输入。缺省 false：宁可少报能力，也不给纯文本端点发 image */
  vision?: boolean
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
    /** 证据硬度 0-1；缺失时报告按「未加权」呈现，不猜测 */
    weight?: number
    /**
     * 这条是上一轮某条共识的延续时，填那条的编号。
     *
     * 主持看不到原文就只能重新措辞，同一判断于是每轮新增一条；
     * 有了编号就能显式归并。程序不盲信：字面差太远会忽略这个声明并按新条目处理。
     */
    continues?: string
  }>
  open_disputes: Array<{
    claim: string
    sides: Array<{ agent_id: string; argument: string }>
  }>
  score_dimensions: { agreement: number; overlap: number; trend: number }
  score: number
  next_round_order: string[]
  callout: { target_agent: string; quote_from_agent: string; instruction: string } | null
  /**
   * 本轮各模型的回答质量名次（对标 llm-council 的互评排名）。
   *
   * 只作为**相对**信号跨轮平均（见 aggregateLeaderboard）：主持给的是名次不是分数，
   * 名次差一位不代表质量差一档。缺失时 leaderboard 为空，报告不编造名次。
   */
  agent_quality?: Array<{ agent_id: string; rank: number; rationale: string }>
  /**
   * 本轮被充分讨论后排除的方向（一句话一条）。
   *
   * 这是 explored 的**唯一**写入来源：不接进来，注入纪要里的
   * 「已充分讨论并排除的方向」永远是空的，模型只能重新论证已经排除的东西。
   * 缺失只记警告，不驳回小结。
   */
  explored_directions?: string[]
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

/**
 * 主持小结的一次尝试（通过或被拒）。
 *
 * raw 必须留存：校验通过与否、程序从这坨文本里抽出了什么，用户此前只能信一面之词。
 * 把原文和抽取结果并排回显，才谈得上「可验证」而不是「自动过关」。
 */
export interface ModeratorAttempt {
  attempt: number
  ok: boolean
  /** 模型原样输出（未经 parseModeratorJson 清洗） */
  raw: string
  validation: DigestValidation
  ms: number
  costUsd: number
  /** 解析/HTTP 失败时的说明；被校验拒绝时看 validation.errors */
  error?: string
}

/** 一轮主持小结的审计条目 */
export interface ModeratorAuditEntry {
  round: number
  anonymous: boolean
  /** alias → agentId；署名轨为 null。不落盘就查不回「主持当时看到谁」 */
  aliases: Record<string, string> | null
  attempts: ModeratorAttempt[]
  /** 反匿名化后仍未登记的别名 */
  unknownAliases: string[]
  /** 匿名轨里模型直接写出真实 id —— 匿名前提被破坏的痕迹 */
  leakedRealIds: string[]
  accepted: ModeratorDigest | null
  startedAt: number
}

/** 粗粒度阶段。并行批次动辄几十秒，只有逐字流时 UI 看着像卡死 */
export type DiscussionStage =
  | 'agent-batch'
  | 'moderator'
  | 'consensus'
  | 'report'
  /** 单模型基线批次（讨论开始前，独立作答） */
  | 'baseline'
  /** 幻觉核验轮（就代答/凭空引用向被冒名模型定向质询） */
  | 'verification'

export interface StageTiming {
  round: number
  stage: DiscussionStage
  startedAt: number
  durationMs: number
  /** 一行摘要，如「发言 5/5 · 缺席 1」 */
  summary: string
}

/** 跨轮平均名次（名次越小越好） */
export interface LeaderboardRow {
  agentId: string
  averageRank: number
  rounds: number
  /** 最后一轮主持给该模型的名次说明 */
  rationale: string | null
}

// ---------------------------------------------------------------------------
// 幻觉治理（多轮交互的误差累积 / 自我矫正）
// ---------------------------------------------------------------------------

/**
 * 逐轮幻觉账本。
 *
 * 只记**本场内部可判死**的四类信号，不去猜外部事实：
 * 1. 凭空引用（citations）：模型引用了不存在的发言或尚未发生的轮次；
 * 2. 代答归因（attributedGrowth）：主持把某模型列为支持者，但其本人发言里没有相关论述；
 * 3. 空心改写（hollowMutations）：共识点的措辞跨轮变了，但证据一条没加；
 * 4. 主持抬分（inflation）：主持自评维度高于程序机械核算值。
 */
export interface HallucinationRoundRecord {
  round: number
  /** 本轮有效发言数（分母，缺席与人类发言不计） */
  utterances: number
  /** 含凭空引用（不存在的发言 id 或越界轮次）的发言数 */
  badCitationUtterances: number
  bogusUtteranceRefs: number
  outOfRangeRoundRefs: number
  unknownLabelRefs: number
  /** 本轮新增的「代答支持」条数（主持替模型表态） */
  attributedGrowth: number
  /** 本轮「有新增证据支撑的改写」条数 —— 被论据矫正 */
  substantiatedRefinements: number
  /** 本轮「换了说法但没加证据」的改写条数 —— 误差累积的主要形态 */
  hollowMutations: number
  /** 主持自评相对程序核算的最大抬分幅度（0-100 维度点） */
  inflation: number
  /** 本轮错误信号合计（用于跨轮趋势比较） */
  errorCount: number
}

/**
 * 多轮幻觉的演化判定 —— 这是「矫正还是越滚越糟」的程序化回答。
 *
 * 判据只用轮次内的 errorCount 序列前后半段比较，不看绝对值：
 * 绝对值高但一路下降，说明交叉质询在起作用；反之哪怕数值不大，
 * 一路上升也意味着讨论在被自己编出来的内容带偏。
 */
export type HallucinationTrajectory = 'self_correcting' | 'flat' | 'compounding' | 'insufficient_data'

export type CorrectionIssue = 'attributed_endorsement' | 'bogus_citation' | 'out_of_range_round'

export type CorrectionOutcome =
  /** 模型确认确实说过/确实支持 —— 补上血缘后升为 verified */
  | 'confirmed'
  /** 模型否认 —— 从 support 移除，条目保留 */
  | 'denied'
  /** 模型给出修正后的表述 —— 记为限定，不算原样支持 */
  | 'clarified'
  /** 未回复（缺席或通道失败）—— 保持 unverified */
  | 'no_response'

/** 一次核验质询及其结果 */
export interface HallucinationCorrection {
  id: string
  round: number
  issue: CorrectionIssue
  outcome: CorrectionOutcome
  /** 被质询的模型（真实 id；匿名轨的提示词里只出现别名） */
  agentId: string
  /** 涉及的共识点，引用类问题为 null */
  pointId: string | null
  pointClaim: string | null
  /** 质询原文 */
  question: string
  /** 模型答复摘录 */
  answer: string | null
  /** 答复里补上的证据发言 */
  addedEvidenceRef: string[]
  /** 因否认而移出的支持者 */
  removedSupport: string[]
}

export interface HallucinationReport {
  rounds: HallucinationRoundRecord[]
  /** 全场凭空引用率 = 含凭空引用的发言数 / 有效发言数 ×100 */
  citationBogusRate: number
  /** 代答率 = 代答支持条数 / 声称支持总数 ×100（沿用溯源口径的分母） */
  attributedRate: number
  /** 空心改写率 = 空心改写 / (空心改写 + 有据改写) ×100 */
  hollowMutationRate: number
  /** 主持抬分的最大值 */
  maxInflation: number
  /** 0-100 的风险分：越高说明本场结论越可能建立在编造内容上 */
  riskScore: number
  trajectory: HallucinationTrajectory
  /** 判定依据的一句话说明，必须引用具体数字 */
  trajectoryNote: string
  /** 核验轮统计：发起几次、矫正回来几条、被否认几条、还剩几条没核对 */
  verification: {
    asked: number
    confirmed: number
    denied: number
    clarified: number
    noResponse: number
    /** 结算后仍无实质支持者、转为 vacated 的共识点数 */
    vacatedPoints: number
    /** 触发原因：auto 的阈值命中项 / always / off */
    triggeredBy: string
  }
  corrections: HallucinationCorrection[]
  /** 需要人去看的具体条目，逐条可点开 */
  flags: string[]
}

/** 单模型基线的作答结果 */
export interface BaselineResult {
  agentId: string
  displayName: string
  transport: TransportKind
  content: string
  startedAt: number
  endedAt: number
  costUsd: number
  /** 基线模型缺席：报告须显式说明「无可用基线」 */
  absent?: boolean
  absentReason?: string
}

export type BaselineVerdict = 'council_better' | 'baseline_better' | 'mixed' | 'inconclusive'

/** 研讨结论 vs 单模型基线的结构化对照 */
export interface BaselineComparison {
  verdict: BaselineVerdict
  /** 研讨多出、基线没有的要点 */
  councilAdds: string[]
  /** 基线提到、研讨反而丢掉的要点 */
  councilDrops: string[]
  /** 研讨中相对基线被削弱或跑偏的判断 */
  regressions: string[]
  note: string
  /** 主持原始输出，供回看核对 */
  raw: string
}

// ---------------------------------------------------------------------------
// 报告（PRD 7.1 P0-7）
// ---------------------------------------------------------------------------

export interface Report {
  sessionId: string
  executiveSummary: string
  /** 结论强度与一句话判断：报告最上层，先给结论再给依据 */
  verdict: ReportVerdict
  /** 全局计数，供摘要条与「下一步」引用 */
  stats: ReportStats
  /** 逐轮进程：分数、发言量、本轮事件 */
  timeline: ReportRoundRow[]
  consensus: ConsensusReportItem[]
  disputes: DisputeReportItem[]
  /** 各模型的参与度与血缘统计 */
  participation: ReportParticipation[]
  blindSpots: string[]
  /**
   * 单模型基线：讨论开始前，同一个模型在同题上独立作答的原文。
   *
   * 这是「研讨有没有实际用处」的唯一可核对答案。没有它，报告只能说明
   * 大家说了什么，不能说明比直接问一个强模型多出了什么。
   * 未开启 / 基线模型缺席时为 null，报告显式标注「无基线」而不是省略。
   */
  baseline: BaselineResult | null
  /** 基线对照结论；未开启或主持失败为 null */
  baselineCompare: BaselineComparison | null
  /** 幻觉治理账本（含核验轮结果） */
  hallucination?: HallucinationReport
  /** 由分歧/缺席/预算推导出的建议动作，不承诺自动执行 */
  nextActions: string[]
  /** 人类介入记录摘要（PRD 5.5：单列一章，不混入模型发言） */
  interventions: string[]
  /** 专项对辩轮摘要 */
  duels: Array<{ topic: string; agentIds: string[]; utteranceCount: number }>
  /**
   * 粗粒度阶段耗时，用于回答「时间都花在哪」。
   * 只含报告生成之前的阶段 —— 一份报告无法记录自己的生成用时；
   * 会话存档里的 stageTimings 才是全量（含 report 阶段）。
   */
  stageTimings?: StageTiming[]
  meta: ReportMeta
  generatedAt: number
}

/** 结论强度：宁可保守，也不把「没人反对」写成「一致认同」（PRD 附录 C 硬约束） */
export interface ReportVerdict {
  level: 'strong' | 'qualified' | 'weak' | 'none'
  headline: string
  /** 支撑该强度的具体依据（分数、缺席、未决分歧等），逐条可核 */
  reasons: string[]
  /** 结论覆盖率 = 已确认共识 / (共识 + 未决分歧) × 100 */
  coverage: number
}

export interface ReportStats {
  /** 有效发言条数（不含缺席占位与人类介入） */
  utterances: number
  /** 人类发言条数（介入产生的发言，不计入共识度） */
  humanUtterances: number
  /** 点名回应他人的发言条数（血缘边数） */
  replyEdges: number
  /** 缺席事件数 */
  absentCount: number
  /** 参与发言的模型数 */
  speakerCount: number
  /** 平均每轮耗时 */
  avgRoundMs: number
  /** 被回应最多的发言；没有任何回应时为 null */
  hub: {
    utteranceId: string
    agentId: string
    displayName: string
    round: number
    quote: string
    citedBy: number
  } | null
}

export interface ReportRoundRow {
  round: number
  /** 本轮有效发言数 */
  utterances: number
  /** 本轮缺席事件数 */
  absent: number
  /** 本轮生效的人工介入数 */
  interventions: number
  /** 本轮综合共识度；无主持时为 null */
  score: number | null
  dims: { agreement: number; overlap: number; trend: number } | null
  /** 本轮新确认的共识条数 */
  newConsensus: number
  /** 本轮新登记的分歧条数 */
  newDisputes: number
  /** 本轮是否触发收敛 */
  converged: boolean
}

export interface ReportParticipation {
  agentId: string
  displayName: string
  transport: TransportKind
  /** 有效发言条数 */
  utterances: number
  /** 主动回应他人的发言条数 */
  replies: number
  /** 被其他发言点名的次数（血缘入度） */
  citedBy: number
  /** 缺席轮数 */
  absentRounds: number
  /** 该模型的累计成本（无 API 计价时为 0） */
  costUsd: number
  /** 最后一条有效发言的摘录，供快速回看 */
  lastQuote: string | null
}

export interface ReportEvidence {
  utteranceId: string
  agentId: string
  displayName: string
  round: number
  quote: string
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
  /** 认同数 / 参与模型数 × 100，用于「全员认同 / 多数认同 / 少数认同」标记 */
  supportRatio: number
  /** 主持给出的置信度 0~1 */
  confidence: number
  /** 该共识在哪一轮被确认 */
  confirmedRound: number
  /** 证据链：按轮次排序的原文摘录 */
  evidence: ReportEvidence[]
  /** 主持给的证据硬度 0-1；旧数据与未给分为 null */
  weight: number | null
  /**
   * 可核对支持占比 =支持者本人有发言被引为证据 / 声称支持者 ×100。
   * 与 ReportVerdict.coverage（结论覆盖率）不是一回事，故不用同名缩写。
   */
  verifiedSupportRate: number
  /** 声称支持但证据里没有其发言的模型 —— 主持替他归因，报告须显式标注 */
  attributedSupport: string[]
  /** 该共识的证据是否被他人点名质询过 */
  crossExamined: boolean
  /**
   * 核验轮对该条共识的结算状态（PRD 6.7 的延伸：代答必须被质询，不能被默默采信）。
   * 未跑核验轮为 undefined —— 与 'unverified' 区别开，前者是「没查」，后者是「查了但没答案」。
   */
  verification?: ConsensusVerification
  /**
   * 归并进来过的其他说法（措辞不同、判断相同）。
   * 归并只压缩呈现不改写历史：报告正文用第一条措辞，其余留在这里可查。
   */
  variants?: string[]
}

export interface DisputeReportItem {
  claim: string
  sides: Array<{ agentId: string; argument: string; sourceRounds: number[] }>
  whyUnresolved: string
  openedRound: number
  /** 交锋持续的轮数 */
  roundsEngaged: number
  /** 是否在专项对辩中被正面对垒过 */
  dueled: boolean
  /** 双方立场的原文摘录（按轮次排序） */
  quotes: ReportEvidence[]
}

export type ReportFinishedReason = 'converged' | 'max-rounds' | 'aborted' | 'no-moderator' | 'failed'

export interface ReportMeta {
  models: Array<{ id: string; displayName: string; transport: TransportKind }>
  rounds: number
  /** 本场配置的轮次上限，报告据此判断「是否跑满」 */
  maxRounds: number
  /** 本场配置的共识阈值，趋势图的参考线 */
  consensusThreshold: number
  totalCostUsd: number
  /** 预算上限（USD）；0 表示未设限 */
  budgetLimitUsd: number
  durationMs: number
  /** 缺席模型 id 列表 */
  absentAgents: string[]
  budgetLimited: boolean
  /** 无主持降级时为 true（PRD 6.2） */
  moderatorUnavailable: boolean
  consensusAvailable: boolean
  finalConsensusScore: ConsensusScore | null
  /** 结束原因：视图与导出都据此给结论打标，不再靠猜 */
  finishedReason: ReportFinishedReason
  /** 主持模型名；无主持降级为 null */
  moderatorName: string | null
  /** 人类介入次数（PRD 5.5：报告中单列一章） */
  interventionCount: number
  /** 专项对辩轮次数 */
  duelCount: number
  /** 本场走的是匿名轨还是署名轨 —— 共识度的可比性前提，必须标注 */
  anonymousReview: boolean
  /** 互评名次跨轮平均；主持未输出 agent_quality 时为空数组 */
  leaderboard: LeaderboardRow[]
  /** 全场共识点的证据可核对情况，分数虚高在此现形 */
  provenance: { coverageRate: number; crossExaminedRate: number }
  /**
   * 分通道调用台账。
   *
   * 网页通道的 costUsd 恒为 0，只看金额等于没有闸门 —— 真实代价在这里体现：
   * 多少次调用、多少墙钟。报告必须并列展示，否则「成本 $0」是假的。
   */
  channels?: {
    apiCalls: number
    webCalls: number
    moderatorCalls: number
    totalMs: number
    /** 一句话说明金额口径的不完全性 */
    costNote: string
  }
  /** 本场时长预算（ms）；未设为 0 */
  timeBudgetMs?: number
  /** 是否因触达时长预算而收束（与 budgetLimited 分开：一个是钱，一个是时间） */
  timeLimited?: boolean
  /** 已登记「充分讨论后排除」的方向条数 */
  exploredCount?: number
  /** 注入模型的历史纪要是否触发过压缩（PRD 6.8 阈值） */
  digestCompacted?: boolean
  /**
   * 共识点归并结果：本场有几条说法被并进了已有条目，以及主持的 continues
   * 声明因字面不像而被程序改判为新建的说明。缺省表示旧存档（未统计）。
   */
  dedup?: ReportDedup
}

export interface ReportDedup {
  /** 被折进已有条目的共识点数量（措辞不同也算，原文留在 variants 上） */
  merged: number
  /** 主持声称延续但程序未采纳的条目说明 */
  notes: string[]
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
  /**
   * 主持小结审计（原始输出 + 校验结论 + 别名映射）。
   * 旧存档为 undefined；回看时据此判断「能不能展开校验区」。
   */
  moderatorAudit?: ModeratorAuditEntry[]
  /** 各阶段耗时，供历史回看复盘「这一场慢在哪」 */
  stageTimings?: StageTiming[]
  /**
   * 单模型基线 + 对照结论。
   *
   * 报告重算走的是纯函数，基线却是**一次真实的模型调用**产物 —— 不存下来，
   * 「重新生成报告」就只能把对照章节空掉，等于丢掉本场唯一可证伪的基准。
   */
  baseline?: BaselineResult | null
  baselineCompare?: BaselineComparison | null
  /** 幻觉治理账本（逐轮信号 + 核验轮结算），同样不可重算 */
  hallucination?: HallucinationReport | null
  /** 分通道调用台账：网页通道没有单价，非金额代价只记在这里 */
  ledger?: { apiCalls: number; webCalls: number; moderatorCalls: number; totalMs: number }
  timeLimited?: boolean
  digestCompacted?: boolean
  /** 归并统计（不可重算：程序按内容折叠的那一刻才记得住并掉了几条） */
  dedup?: ReportDedup
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

// ---------------------------------------------------------------------------
// 全局快捷键：快速唤起 / 最小化应用
// ---------------------------------------------------------------------------

/** 一条 Electron Accelerator 字符串（如 CommandOrControl+Alt+T）与开关，存进 preferences.json */
export interface HotkeyConfig {
  enabled: boolean
  /** 空串表示「还没设过」；注册与持久化都以它为准 */
  accel: string
}

/** 主进程回给设置页的权威状态：配置之外还要带上「这条键到底注册上没有」 */
export interface HotkeyState extends HotkeyConfig {
  /** 启用但因被其它程序占用而注册失败时，设置页要显示，不能谎报已生效 */
  registered: boolean
  error?: string
}
