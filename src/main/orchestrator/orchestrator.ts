/**
 * 编排状态机（PRD 6.2 / 6.7）
 *
 * 轮内并行、轮间串行：
 *   一轮 = 1 个并行发言批次（Batch A）+ 1 次主持小结（Batch B）
 *
 * 轮内模型看到的是同一份「上一轮结束时的快照」，因此互相看不到本轮他人发言，
 * 保证发言独立性；交叉质询靠主持的 callout 在下一轮实现。
 *
 * 时序预算（5 模型 × 3 轮 = 6 个串行批次 ≈ 2~4 分钟）是「5 分钟」目标的前提。
 */

import { EventEmitter } from 'node:events'
import {
  aggregateLeaderboard,
  computeAgreement,
  computeOverlap,
  computeTrend,
  compressDigest,
  evaluateConvergence,
  makeId,
  mergeOpenDisputes,
  nowMs,
  openOnly,
  PEER_CAP,
  renderDigestForPrompt,
  resolveOverlap,
  validateModeratorDigest,
  weightedScore,
} from '../../shared/invariants'
import {
  auditCitations,
  attributedGrowth,
  attributedEndorsements,
  buildCitationChallenge,
  buildEndorsementChallenge,
  buildHallucinationReport,
  buildRoundRecord,
  classifyVerificationAnswer,
  applyCorrection,
  hasBadCitation,
  moderatorInflation,
  needsVerificationPass,
  pendingVerificationTargets,
  trackClaimDrift,
  type CorrectionTarget,
} from '../../shared/hallucination'
import {
  anonymizeDigest,
  buildAliasMap,
  deanonymizeModeratorDigest,
  endorsementProvenance,
  type AliasMap,
} from '../../shared/anonymity'
import { mergeConsensusPoints } from '../../shared/dedup'
import {
  createIntervention,
  deliverInterventions,
  humanUtterance,
  modelUtterancesOnly,
  renderInterventions,
} from '../../shared/interventions'
import { renderPriorConclusion, type RetryMode, type RetrySource } from '../../shared/retry'
import {
  CONTEXT_COMPRESSION,
  type AgentStatus,
  type BaselineComparison,
  type BaselineResult,
  type Callout,
  type ConsensusPoint,
  type ConsensusScore,
  type Digest,
  type DiscussionStage,
  type DuelRound,
  type HallucinationCorrection,
  type HallucinationReport,
  type HallucinationRoundRecord,
  type Intervention,
  type LeaderboardRow,
  type ModeratorAttempt,
  type ModeratorAuditEntry,
  type ModeratorDigest,
  type OpenDispute,
  type OrchestratorState,
  type PeerArgument,
  type ReportDedup,
  type SessionConfig,
  type StanceMark,
  type StageTiming,
  type TokenUsage,
  type Topic,
  type TurnContext,
  type Utterance,
} from '../../shared/types'
import { AgentError, absentText, type Agent, type AbsentReason } from '../agents/agent'

/** 「已充分讨论并排除的方向」的累计上限：太多会把注入纪要撑成噪声 */
const EXPLORED_CAP = 20
/**
 * 主持提示词里列出的已有共识条数上限（取最近若干条）。
 * 列全量会把主持推去逐条复述，反而更长更慢；最近的条目才是它本轮会重提的那批。
 */
const MODERATOR_LEDGER_CAP = 25
/** 核验轮最多质询几位模型 —— 一次批次就要几十秒，无上限的核验本身会变成新的代价 */
const VERIFY_TARGET_CAP = 6
/** 基线作答的字数上限：比参会发言宽松，否则「单模型基线」会被人为削弱，对照失去意义 */
const BASELINE_MAX_CHARS = 1_200
/**
 * 触发纪要压缩的字符门槛。
 * 直接沿用 PRD 6.8 的 token 阈值：中文约 1 字≈1 token，宁可早压不可晚压。
 */
const DIGEST_COMPRESS_CHARS = CONTEXT_COMPRESSION.forceCompressAbove
/** 压缩后保留的共识条数（取最近若干条） */
const CONFIRMED_KEEP_ON_COMPRESS = 12

/**
 * 把一次发言的「回应了谁」收敛成发言 id 清单。
 *
 * 两个来源：主持/人类的点名（agent.send 返回的 targets）与模型自己复制的引用编号
 * （citations.validUtteranceIds，已核对过在本场真实存在）。
 * 必须过滤掉自己写的发言 —— 自引不是交锋，放进血缘会让「被他人回应」的统计虚高。
 */
export function mergeTargets(
  calloutTargets: readonly string[] | undefined,
  citedUtteranceIds: readonly string[],
  authorById: ReadonlyMap<string, string>,
  selfAgentId: string
): string[] {
  const out: string[] = []
  for (const id of [...(calloutTargets ?? []), ...citedUtteranceIds]) {
    if (authorById.get(id) === selfAgentId) continue
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** 主持小结之外的宽容 JSON 抽取：容忍代码块包裹与前后解释文字 */
function parseJsonObject<T>(content: string): T | null {
  const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0)
}

function verdictLabel(v: BaselineComparison['verdict']): string {
  switch (v) {
    case 'council_better':
      return '研讨更完整'
    case 'baseline_better':
      return '基线更可靠'
    case 'mixed':
      return '各有得失'
    case 'inconclusive':
    default:
      return '证据不足，无法判定'
  }
}

/** 编排引擎向 UI 推送的事件 */
export type OrchestratorEvent =
  | { type: 'state'; state: OrchestratorState; round: number }
  | { type: 'round-start'; round: number; total: number }
  | { type: 'utterance-delta'; utteranceId: string; agentId: string; chunk: string }
  | { type: 'thinking-delta'; utteranceId: string; agentId: string; chunk: string }
  | { type: 'steps-delta'; utteranceId: string; agentId: string; chunk: string }
  | { type: 'utterance-done'; utterance: Utterance }
  | { type: 'absent'; utterance: Utterance }
  | { type: 'moderator'; digest: ModeratorDigest; score: ConsensusScore; open: OpenDispute[] }
  | { type: 'moderator-rejected'; errors: string[]; attempt: number }
  /** 主持小结的完整审计：原始输出、校验结论、别名映射。UI 据此把「程序抽出了什么」摊给用户看 */
  | { type: 'moderator-audit'; audit: ModeratorAuditEntry }
  /** 粗粒度阶段完成（发言批 / 主持 / 收敛 / 报告）：网页通道动辄几十秒，只靠逐字流看着像卡死 */
  | { type: 'stage-complete'; round: number; stage: DiscussionStage; durationMs: number; summary: string }
  | { type: 'converged'; score: number; round: number }
  | { type: 'stalled'; score: number; round: number }
  | { type: 'budget-limited'; spentUsd: number }
  /** 时长预算触顶（网页通道不计价，这是唯一有效的闸门） */
  | { type: 'time-limited'; elapsedMs: number; budgetMs: number }
  /** 收敛判定结论，无论是否收敛都发：用户要能看到「为什么这场没停」 */
  | { type: 'convergence'; round: number; converged: boolean; path: 'score' | 'structural' | 'none'; reason: string }
  /** 单模型基线（讨论开始前的独立作答） */
  | { type: 'baseline'; baseline: BaselineResult }
  /** 研讨结论 vs 基线的结构化对照 */
  | { type: 'baseline-compare'; compare: BaselineComparison }
  /** 逐轮幻觉账本 */
  | { type: 'hallucination-round'; record: HallucinationRoundRecord }
  /** 一次核验质询及其结果 */
  | { type: 'verification'; correction: HallucinationCorrection }
  /** 全场幻觉治理汇总（含轨迹判定） */
  | { type: 'hallucination'; report: HallucinationReport }
  | { type: 'paused'; reason: string }
  /** 用户点了「继续」：暂停提示的撤销信号，不靠下一个 state 事件碰运气 */
  | { type: 'resumed' }
  | { type: 'intervention'; intervention: Intervention }
  | { type: 'stance-changed'; agentId: string; before: string; after: string; effectiveRound: number }
  | { type: 'duel-start'; duel: { topic: string; agentIds: string[] } }
  | { type: 'duel-done'; duelId: string }
  | { type: 'retry-mode'; mode: RetryMode; sourceSessionId: string; notices: string[] }
  | { type: 'done'; reason: 'converged' | 'max-rounds' | 'aborted' | 'no-moderator' | 'failed' }
  | { type: 'error'; message: string }

export interface ModeratorLike {
  id: string
  send(raw: { system: string; user: string }): Promise<{ content: string; usage: TokenUsage }>
}

/** 参与本场讨论的发言 agent 的立场标记提供者（可由调用方注入） */
export type StanceExtractor = (agentId: string, content: string) => StanceMark | undefined

export interface OrchestratorDeps {
  /** 按 id 取 agent（只取参与发言的） */
  getAgent(id: string): Agent | undefined
  /**
   * 纯查表的可读名称。提示词里用它替代内部 id，所以构造别名表时只走这一条 ——
   * 换成 getAgent 会在编排器 new 出来那一刻就把网页分区建好。
   */
  nameOf?: (id: string) => string | undefined
  /** 取主持；返回 null 表示无主持降级模式 */
  getModerator: () => ModeratorLike | null
  /** 从发言文本抽取立场标记，供程序核算立场一致度 */
  extractStance?: StanceExtractor
  /** 单轮最大墙钟（ms），超时则中止本场并出部分报告 */
  roundWallClockMs?: number
}

export class Orchestrator extends EventEmitter {
  private state: OrchestratorState = 'INIT'
  private round = 0
  private utterances: Utterance[] = []
  private confirmed: ConsensusPoint[] = []
  private open: OpenDispute[] = []
  private explored: string[] = []
  private scores: Array<{ round: number; score: ConsensusScore }> = []
  private spentUsd = 0
  private budgetLimited = false
  private aborted = false
  private paused = false
  /** 暂停前的状态，恢复时回退用 —— 不回退的话 PAUSE_FOR_USER 会留在状态机上 */
  private stateBeforePause: OrchestratorState | null = null
  private moderatorUnavailable = false
  private pendingCallout: Callout | null = null
  private interventions: Intervention[] = []
  private duels: DuelRound[] = []
  /** 人类介入的可读摘要，供主持 prompt 与报告使用 */
  private humanRecords: string[] = []
  /** agentId -> 用户覆盖的立场（下一轮生效） */
  private stanceOverrides = new Map<string, string>()
  /** 重试模式（null 表示非重试发起的新讨论） */
  private retryMode: RetryMode | null = null
  private retrySource: RetrySource | null = null
  /** 上一场结论作为「已知前提」注入的文本（continue 模式） */
  private priorConclusion: string | null = null
  /** 补跑模式下本场只让这些模型发言（fill-missing） */
  private fillMissingOnly: string[] = []
  /** 继承自来源会话的轮次计数（fill-missing 用） */
  private inheritedRound = 0
  private lastOpenCount: number | null = null
  private noProgressRounds = 0
  /**
   * 别名映射。参与顺序即 participantIds 顺序 —— 全场唯一，因此轮次之间别名稳定，
   * 主持可以把「参会者A」当作跨轮可引用的标识。
   */
  private readonly aliases: AliasMap
  private audits: ModeratorAuditEntry[] = []
  private stageTimings: StageTiming[] = []
  /** 单模型基线（同题独立作答），null 表示未开启或还没跑 */
  private baseline: BaselineResult | null = null
  /** 研讨结论与基线的对照 */
  private baselineCompare: BaselineComparison | null = null
  /**
   * 与第一轮并行的基线。任何收口路径都要先等它落地再出对照与报告，
   * 否则「本场有没有基线」变成谁先跑完的竞态。
   */
  private baselinePromise: Promise<void> | null = null
  /** 逐轮幻觉账本 */
  private hallucinationRounds: HallucinationRoundRecord[] = []
  /** 核验轮的质询与结果 */
  private corrections: HallucinationCorrection[] = []
  /** 核验轮为何（没）跑，报告要如实说明 */
  private verificationTriggeredBy = '未触发'
  private vacatedPoints = 0
  private timeLimited = false
  private sessionStartedAt = 0
  /**
   * 分通道调用台账。
   * 网页通道 costUsd 恒为 0 —— 只看金额等于没闸门，所以次数和墙钟必须单独记。
   */
  private ledger = { apiCalls: 0, webCalls: 0, moderatorCalls: 0, totalMs: 0 }
  /** agentId → 下一轮回灌给该模型的引用质询原文 */
  private pendingChallenges = new Map<string, string>()
  /** 上一轮通过校验的共识点快照，供跨轮漂移与代答增量比较 */
  private prevRoundPoints: ConsensusPoint[] = []
  /** 最近一轮的「共识点被质询覆盖率」，结构收敛判定的输入之一 */
  private lastCrossExaminedRate = 0
  /** 本场是否触发过纪要压缩（报告如实标注，注入内容被概括过不能瞒） */
  private digestCompacted = false
  /** 本场被归并的近义共识条数：条目变少必须能被解释，不能悄悄少 */
  private mergedPoints = 0
  /** 归并过程中的可疑声明（主持说「延续某条」但字面不像同一条判断） */
  private mergeNotes: string[] = []

  constructor(
    private readonly topic: Topic,
    private readonly config: SessionConfig,
    private readonly deps: OrchestratorDeps,
  ) {
    super()
    this.aliases = buildAliasMap(
      config.participantIds,
      !!config.anonymousReview,
      (id) => this.deps.nameOf?.(id),
    )
  }

  /**
   * 以重试模式启动。
   *
   * 四种语义的差别（详见 shared/retry.ts）：
   * - rerun：等价于全新讨论，仅在事件流标注来源
   * - continue：注入「已知前提」文本，但**不写入 confirmed/open**
   *   —— 抄上一轮的答案不构成本轮共识，否则就是假共识
   * - fill-missing：本场只跑缺席模型，轮次从来源延续
   * - dispute：不跑常规轮，排空专项对辩后直接出报告
   */
  startAsRetry(mode: RetryMode, source: RetrySource, notices: string[]): void {
    this.retryMode = mode
    this.retrySource = source
    this.emit('event', {
      type: 'retry-mode',
      mode,
      sourceSessionId: source.sessionId,
      notices,
    } satisfies OrchestratorEvent)

    switch (mode) {
      case 'continue':
        this.priorConclusion = renderPriorConclusion(source, (id) => this.label(id))
        break
      case 'fill-missing':
        this.fillMissingOnly = [...source.absentAgentIds]
        this.inheritedRound = source.config.maxRounds
        this.round = 0
        break
      case 'dispute':
        this.round = source.config.maxRounds
        break
      case 'rerun':
      default:
        break
    }
  }

  getRetryMode(): RetryMode | null {
    return this.retryMode
  }

  getRetrySource(): RetrySource | null {
    return this.retrySource
  }

  getState(): OrchestratorState {
    return this.state
  }

  getRound(): number {
    return this.round
  }

  getUtterances(): Utterance[] {
    return [...this.utterances]
  }

  getOpenDisputes(): OpenDispute[] {
    return openOnly(this.open)
  }

  getConsensusPoints(): ConsensusPoint[] {
    return [...this.confirmed]
  }

  getScores(): Array<{ round: number; score: ConsensusScore }> {
    return [...this.scores]
  }

  getSpentUsd(): number {
    return Math.round(this.spentUsd * 10_000) / 10_000
  }

  getInterventions(): Intervention[] {
    return [...this.interventions]
  }

  getDuels(): DuelRound[] {
    return [...this.duels]
  }

  /** 展开的发言（人类发言已并入，按时间序） */
  getAllUtterances(): Utterance[] {
    return [...this.utterances]
  }

  isModeratorUnavailable(): boolean {
    return this.moderatorUnavailable
  }

  isBudgetLimited(): boolean {
    return this.budgetLimited
  }

  getModeratorAudit(): ModeratorAuditEntry[] {
    return [...this.audits]
  }

  getStageTimings(): StageTiming[] {
    return [...this.stageTimings]
  }

  /** 本场是否走匿名轨；落盘时写进记录，报告与回看都要靠它解释共识度怎么来的 */
  isAnonymousReview(): boolean {
    return this.aliases.anonymous
  }

  /** 别名 → 真实 id；署名轨为 null */
  getAliasMap(): Record<string, string> | null {
    return this.aliases.anonymous ? { ...this.aliases.aliasToAgent } : null
  }

  /** 已登记的「充分讨论后排除」方向（落盘用） */
  getExplored(): string[] {
    return [...this.explored]
  }

  /** 本场是否压缩过注入纪要 */
  isDigestCompacted(): boolean {
    return this.digestCompacted
  }

  /** 归并统计：并掉几条近义说法 + 主持 continues 未采纳的说明 */
  getDedup(): ReportDedup {
    return { merged: this.mergedPoints, notes: [...this.mergeNotes] }
  }

  /** 互评名次的跨轮平均；主持未输出名次时为空数组 */
  getLeaderboard(): LeaderboardRow[] {
    return aggregateLeaderboard(this.audits)
  }

  getBaseline(): BaselineResult | null {
    return this.baseline
  }

  getBaselineCompare(): BaselineComparison | null {
    return this.baselineCompare
  }

  isTimeLimited(): boolean {
    return this.timeLimited
  }

  /** 分通道台账 + 墙钟。报告与 doctor 都靠它说明「这场花了多少非金额代价」 */
  getLedger(): { apiCalls: number; webCalls: number; moderatorCalls: number; totalMs: number } {
    return { ...this.ledger, totalMs: this.sessionStartedAt > 0 ? nowMs() - this.sessionStartedAt : this.ledger.totalMs }
  }

  getCorrections(): HallucinationCorrection[] {
    return [...this.corrections]
  }

  /** 全场幻觉治理汇总；无主持降级跑不到任何账本时返回 null */
  getHallucinationReport(): HallucinationReport | null {
    if (this.hallucinationRounds.length === 0) return null
    const totalSupport = this.confirmed.reduce((a, p) => a + new Set(p.support).size, 0)
    /**
     * 代答条数按程序口径现算，不读 point.verification.attributed ——
     * 那份字段只有跑过核验轮才会写，verifyPass=off 时报告会写成「零代答」，
     * 而每轮账本里明明记着检测到的代答，两处口径必须一致。
     */
    const attributedTotal = attributedEndorsements(
      this.confirmed,
      modelUtterancesOnly(this.utterances),
    ).length
    return buildHallucinationReport({
      records: this.hallucinationRounds,
      totalClaimedSupport: totalSupport,
      totalAttributedSupport: attributedTotal,
      corrections: this.corrections,
      vacatedPoints: this.vacatedPoints,
      triggeredBy: this.verificationTriggeredBy,
    })
  }

  // -------------------------------------------------------------------------
  // 人工介入（PRD 5.5）
  // -------------------------------------------------------------------------

  /**
   * 插话：内容进入下一批次所有（或指定）模型的上下文。
   * 立即记录为一条 human 发言（可在讨论流中看到），并作为干预注入下一轮。
   */
  interject(text: string, targetAgentId?: string): Intervention {
    const it = createIntervention('interject', text, this.round, {
      targetAgentIds: targetAgentId ? [targetAgentId] : [],
    })
    this.interventions.push(it)

    // 人类发言进入记录，但不计入共识度核算
    const u = humanUtterance(text, this.round, it.targetAgentIds)
    this.utterances.push(u)
    this.humanRecords.push(
      it.targetAgentIds.length > 0 ? `@${it.targetAgentIds.join(' @')}：${text}` : `对全员：${text}`,
    )
    this.emit('event', { type: 'utterance-done', utterance: u } satisfies OrchestratorEvent)
    this.emit('event', { type: 'intervention', intervention: it } satisfies OrchestratorEvent)
    return it
  }

  /**
   * 定向追问：指定模型就某条发言/议题点再答一轮。
   * 立即插入队列，作为下一批次的首个发言。
   */
  followup(targetAgentId: string, text: string, targetUtteranceId?: string): Intervention {
    const it = createIntervention('followup', text, this.round, {
      targetAgentId,
      targetUtteranceId,
      targetAgentIds: [targetAgentId],
    })
    this.interventions.push(it)
    const quoteFrom = this.utterances.find((u) => u.id === targetUtteranceId)?.agentId ?? ''
    this.pendingCallout = {
      targetAgent: targetAgentId,
      quoteFromAgent: quoteFrom,
      quoteFromLabel: quoteFrom ? this.aliases.labelFor(quoteFrom) : undefined,
      // 追问本来就是针对某条发言发起的：把它的 id 一起带走，
      // 这一轮的「回应」才能在演化图/报告血缘里落下来
      ...(targetUtteranceId ? { quoteFromUtterance: targetUtteranceId } : {}),
      quote: text,
      instruction: `人类参与者要求你针对上述内容作出回应。`,
    }
    this.emit('event', { type: 'intervention', intervention: it } satisfies OrchestratorEvent)
    return it
  }

  /**
   * 要求对辩：指定两个模型就某议题点追加专项轮次。
   * 专项轮不计入常规轮次编号，也不参与收敛度判定（PRD 5.5）。
   */
  requestDuel(agentIds: string[], topic: string): Intervention {
    const it = createIntervention('duel', topic, this.round, {
      duelAgentIds: agentIds,
      topic,
    })
    this.interventions.push(it)
    this.emit('event', { type: 'intervention', intervention: it } satisfies OrchestratorEvent)
    return it
  }

  /**
   * 中途调整立场：从下一轮生效，不影响已完成的轮次。
   */
  setStance(agentId: string, stance: string): Intervention {
    const before = this.stanceOverrides.get(agentId) ?? '（默认立场）'
    const it = createIntervention('set-stance', stance, this.round, {
      stanceAgentId: agentId,
      stanceBefore: before,
      stanceAfter: stance,
      targetAgentIds: [agentId],
    })
    this.interventions.push(it)
    this.stanceOverrides.set(agentId, stance)
    this.emit('event', {
      type: 'stance-changed',
      agentId,
      before,
      after: stance,
      effectiveRound: this.round + 1,
    } satisfies OrchestratorEvent)
    this.emit('event', { type: 'intervention', intervention: it } satisfies OrchestratorEvent)
    return it
  }

  getStance(agentId: string): string | null {
    return this.stanceOverrides.get(agentId) ?? null
  }

  /**
   * 终止是「请求」，不是「立刻断」：正在飞行中的那次 send 没法从外面掐掉（Agent 接口没有 signal），
   * 所以这里做的是让剩下的检查点尽快看到标志 ——
   * 清 paused 是必须的，否则循环卡在 waitWhilePaused 的 sleep 轮询里，
   * 用户按了终止却永远停在中止检查之前。
   */
  requestAbort(): void {
    this.aborted = true
    this.paused = false
  }

  requestPause(reason: string): void {
    // 正在终止的场次不再「暂停」：标志已经翻了，再声明一次暂停态
    // 只会让顶栏停在「已暂停」，看着像终止没生效。
    if (this.aborted) return
    if (!this.paused) this.stateBeforePause = this.state
    this.paused = true
    this.setState('PAUSE_FOR_USER')
    this.emit('event', { type: 'paused', reason } satisfies OrchestratorEvent)
  }

  /**
   * 继续必须自己发声：暂停时状态机停在 PAUSE_FOR_USER，而恢复后循环可能
   * 已经没有下一轮可发 state（跑满轮次直接进收尾），渲染层的「用户手动暂停」
   * 就永远摘不掉。这里补一次状态回退，让提示随点击消失。
   */
  resume(): void {
    this.paused = false
    this.emit('event', { type: 'resumed' } satisfies OrchestratorEvent)
    if (this.state === 'PAUSE_FOR_USER') this.setState(this.stateBeforePause ?? 'CONSENSUS_EVAL')
    this.stateBeforePause = null
  }

  private setState(s: OrchestratorState): void {
    this.state = s
    this.emit('event', { type: 'state', state: s, round: this.round } satisfies OrchestratorEvent)
  }

  /**
   * 记录阶段耗时并发出 stage-complete。
   *
   * 与 *-delta 的分工：逐字流证明「这条发言在动」，阶段事件证明「这场在推进」。
   * 网页通道一个批次几十秒，只有前者时用户看到的是五个格子都在闪、整场没有进展。
   * 报告阶段由主进程计时后回调这里，让耗时与发言批在同一张表里。
   */
  recordStage(stage: DiscussionStage, startedAt: number, summary: string): void {
    const durationMs = nowMs() - startedAt
    const timing: StageTiming = { round: this.round, stage, startedAt, durationMs, summary }
    this.stageTimings.push(timing)
    this.emit('event', {
      type: 'stage-complete',
      round: this.round,
      stage,
      durationMs,
      summary,
    } satisfies OrchestratorEvent)
  }

  /**
   * 统一收尾。顺序不能乱：
   * 1. 幻觉核验轮 —— 必须在最终共识清单定稿后、报告生成前，质询结果要进报告；
   * 2. 基线对照 —— 需要「研讨最终结论」作为对照的一侧；
   * 3. 排空专项对辩 —— 对辩发言必须进报告；
   * 4. done —— 必须最后发，主进程靠它落盘。
   *
   * 中止/失败的场次不追加核验批次：用户按下停止是要立刻拿到部分报告，
   * 不是等再一次 30 秒的质询往返。
   */
  private async finish(reason: 'converged' | 'max-rounds' | 'aborted' | 'no-moderator' | 'failed'): Promise<void> {
    // 与第一轮并行的基线必须在对照与报告之前落地，否则「本场有没有基线」取决于谁先跑完
    if (this.baselinePromise) {
      await this.baselinePromise
      this.baselinePromise = null
    }
    const normalExit = reason === 'converged' || reason === 'max-rounds'
    if (normalExit && !this.moderatorUnavailable) {
      await this.runVerificationPass()
      await this.runBaselineCompare()
    }
    const report = this.getHallucinationReport()
    if (report) {
      this.emit('event', { type: 'hallucination', report } satisfies OrchestratorEvent)
    }
    await this.drainPendingDuels()
    this.setState('REPORT_GEN')
    this.emit('event', { type: 'done', reason } satisfies OrchestratorEvent)
  }

  /** 时长预算是否已触顶（网页通道不计价，这是唯一有效的总闸门） */
  private overTimeBudget(): boolean {
    const budget = this.config.timeBudgetMs ?? 0
    return budget > 0 && this.sessionStartedAt > 0 && nowMs() - this.sessionStartedAt >= budget
  }

  /** 主执行流 */
  async run(): Promise<void> {
    try {
      this.setState('LOGIN_CHECK')
      this.setState('READY')
      this.sessionStartedAt = nowMs()

      // dispute 模式：不跑常规轮，排空专项对辩后直接出报告
      if (this.retryMode === 'dispute') {
        await this.finish('max-rounds')
        return
      }

      // fill-missing 模式：只补跑缺席模型一轮，不跑主持小结与收敛判定
      if (this.retryMode === 'fill-missing') {
        if (this.fillMissingOnly.length === 0) {
          this.emit('event', {
            type: 'error',
            message: '没有需要补跑的缺席模型',
          } satisfies OrchestratorEvent)
          await this.finish('max-rounds')
          return
        }
        this.round = this.inheritedRound + 1
        this.setState('ROUND_START')
        this.emit('event', {
          type: 'round-start',
          round: this.round,
          total: this.round,
        } satisfies OrchestratorEvent)
        this.setState('AGENT_BATCH')
        await this.runAgentBatch()
        await this.finish('max-rounds')
        return
      }

      // 单模型基线：必须在任何发言进入纪要之前跑完，且结果不进 digest ——
      // 它是「研讨值不值」的对照物，一旦混进讨论上下文就自证失效。
      //
      // API 通道可以让它和第一轮发言并行：基线是一次独立的 HTTP 请求，
      // 不占网页视图、也不改变任何参会者看到的内容。网页基线必须串行 ——
      // 同一个原生视图没法同时打两场，抢同一个页面只会两边都超时。
      if (this.config.baseline) {
        if (this.resolveBaselineAgent()?.transport === 'api') {
          this.baselinePromise = this.runBaseline()
        } else {
          await this.runBaseline()
        }
      }

      while (this.round < this.config.maxRounds) {
        if (this.aborted) {
          this.setState('ABORTED')
          await this.finish('aborted')
          return
        }
        if (this.paused) {
          await this.waitWhilePaused()
          continue
        }

        // 轮与轮之间查时长预算：轮内已有 roundWallClockMs 兜底，这里管的是「整场」
        if (this.overTimeBudget()) {
          this.timeLimited = true
          const budget = this.config.timeBudgetMs ?? 0
          this.emit('event', {
            type: 'time-limited',
            elapsedMs: nowMs() - this.sessionStartedAt,
            budgetMs: budget,
          } satisfies OrchestratorEvent)
          break
        }

        this.round += 1
        this.setState('ROUND_START')
        this.emit('event', {
          type: 'round-start',
          round: this.round,
          total: this.config.maxRounds,
        } satisfies OrchestratorEvent)

        // ---- Batch A：轮内并行发言 ----
        this.setState('AGENT_BATCH')
        await this.runAgentBatch()

        if (this.aborted) {
          this.setState('ABORTED')
          await this.finish('aborted')
          return
        }

        // ---- Batch B：主持小结 ----
        this.setState('MODERATOR_SUMMARY')
        const ok = await this.runModerator()

        // 主持往返之间被终止：先按 aborted 收尾，不能被下面的「无主持降级」抢走，
        // 否则用户明明点的是终止，报告却写着主持不可用。
        if (this.aborted) {
          this.setState('ABORTED')
          await this.finish('aborted')
          return
        }

        // 无主持降级：跑满轮次直接出报告（PRD 6.2）
        if (!ok) {
          this.moderatorUnavailable = true
          await this.finish('no-moderator')
          return
        }

        // ---- 收敛判定 ----
        this.setState('CONSENSUS_EVAL')
        const last = this.scores[this.scores.length - 1]
        const conv = this.evaluateRoundConvergence(last?.score.score ?? 0)
        this.emit('event', {
          type: 'convergence',
          round: this.round,
          converged: conv.converged,
          path: conv.path,
          reason: conv.reason,
        } satisfies OrchestratorEvent)

        if (conv.converged && last) {
          this.emit('event', {
            type: 'converged',
            score: last.score.score,
            round: this.round,
          } satisfies OrchestratorEvent)
          await this.finish('converged')
          return
        }

        // 连续 2 轮不升 → 提示用户（PRD 8.4）
        if (this.noProgressRounds >= 2) {
          this.emit('event', {
            type: 'stalled',
            score: last?.score.score ?? 0,
            round: this.round,
          } satisfies OrchestratorEvent)
          this.noProgressRounds = 0
        }
      }

      await this.finish('max-rounds')
    } catch (e) {
      this.setState('FAILED')
      this.emit('event', { type: 'error', message: (e as Error).message } satisfies OrchestratorEvent)
      // Errors must still produce a durable partial report.  Without a done
      // event the main process has no opportunity to persist the session.
      await this.finish('failed')
    } finally {
      // 异常路径兜底：确保待执行对辩不被丢弃
      await this.drainPendingDuels()
    }
  }

  /**
   * 本轮是否收敛。
   *
   * 单独抽出来，是为了让「为什么这场没停」有一个人能看懂的理由串 ——
   * 旧实现只有一句 `score >= threshold`，不达标时用户只能看到「跑满了 3 轮」。
   */
  private evaluateRoundConvergence(score: number): {
    converged: boolean
    path: 'score' | 'structural' | 'none'
    reason: string
  } {
    const provenanceUtts = this.utterances.filter((u) => !u.absent && !u.human)
    const speakers = new Set(provenanceUtts.map((u) => u.agentId)).size
    const newPoints = this.confirmed.filter((p) => p.confirmedRound === this.round).length
    const rate = this.lastCrossExaminedRate
    return evaluateConvergence({
      score,
      threshold: this.config.consensusThreshold,
      round: this.round,
      openCount: openOnly(this.open).length,
      newPoints,
      crossExaminedRate: rate,
      speakerCount: speakers,
    })
  }

  /** 执行排队中的专项对辩 */
  private async drainPendingDuels(): Promise<void> {
    const pending = this.interventions.filter(
      (i) => i.kind === 'duel' && i.status === 'pending' && (i.duelAgentIds?.length ?? 0) >= 2,
    )
    for (const it of pending) {
      if (this.aborted) break
      const duel: DuelRound = {
        id: makeId('d'),
        parentRound: this.round,
        topic: it.topic ?? it.text,
        agentIds: it.duelAgentIds!,
        utterances: [],
        createdAt: nowMs(),
      }
      it.status = 'delivered'
      it.deliveredRound = this.round
      await this.runDuel(duel)
    }
  }
  private async waitWhilePaused(): Promise<void> {
    // 暂停是「批次结束后生效」：批次里发的 MODERATOR_SUMMARY 等状态会把渲染层
    // 的暂停态冲掉，真正停下来的这一刻必须重新声明，否则提示和实际相反。
    if (this.state !== 'PAUSE_FOR_USER') {
      this.stateBeforePause = this.state
      this.setState('PAUSE_FOR_USER')
    }
    while (this.paused && !this.aborted) {
      await sleep(200)
    }
    this.paused = false
  }

  /**
   * Batch A —— 轮内并行发言。
   * 所有 agent 同时发起；每个看到同一份上一轮结束时的快照。
   * 单个失败不阻塞整批（PRD 6.2 通道降级）。
   */
  private async runAgentBatch(): Promise<void> {
    // fill-missing 模式：本批次只跑缺席模型，已发言模型不重跑
    const ids =
      this.fillMissingOnly.length > 0
        ? this.config.participantIds.filter((id) => this.fillMissingOnly.includes(id))
        : this.config.participantIds
    const digest = anonymizeDigest(this.buildDigest(), this.aliases)
    const batchStartedAt = nowMs()
    /**
     * 引用核验的参照系：本批次开始前的全部发言 + 当前轮次 + 合法别名。
     * 快照必须是「批次前」的 —— 否则同批次里别人刚说出的 id 会被当成合法引用。
     */
    const citationIndex = {
      utteranceIds: new Set(this.utterances.map((u) => u.id)),
      round: this.round,
      aliases: this.aliases.anonymous ? Object.keys(this.aliases.aliasToAgent) : [],
    }
    /** 发言 → 作者：合并 targets 时用来剔除「自己回应自己」 */
    const authorById = new Map(this.utterances.map((u) => [u.id, u.agentId]))
    /** 给参会者的「他人论点原话」候选：与 citationIndex 同源，取批次开始前的快照 */
    const preBatchUtterances = [...this.utterances]
    /**
     * 上一轮攒下的引用质询，随本批次一次性投递。
     * 必须在批次开始前取走快照：本批次里新发现的凭空引用要留到**下一轮**再问，
     * 当场追问会把这一轮的发言顺序变成串行。
     */
    const challengeSnapshot = new Map(this.pendingChallenges)
    this.pendingChallenges.clear()

    // 处置待生效的介入：缺席目标改投 / 作废（规则 3）
    const statusMap = new Map<string, AgentStatus>()
    for (const id of ids) {
      statusMap.set(id, this.deps.getAgent(id)?.status ?? 'disabled')
    }
    const delivered = deliverInterventions(this.interventions, this.round, statusMap)

    // 介入文本按目标拆分：定向介入只投给指定模型（PRD 5.5）
    const interventionByAgent = new Map<string, string[]>()
    for (const it of delivered) {
      const text =
        it.kind === 'interject'
          ? it.text
          : it.kind === 'followup'
            ? `【定向追问】${it.text}`
            : `【专项对辩】议题：${it.topic ?? it.text}`
      const targets = it.kind === 'interject' ? it.targetAgentIds : it.targetAgentId ? [it.targetAgentId] : ids
      for (const t of targets) {
        const arr = interventionByAgent.get(t) ?? []
        arr.push(text)
        interventionByAgent.set(t, arr)
      }
    }

    // 立场覆盖在本次批次生效（用户设置的是"下一轮"，此时正是下一轮）
    const stanceApplied = [...this.stanceOverrides.entries()]
    if (stanceApplied.length > 0) {
      for (const it of this.interventions) {
        if (it.kind === 'set-stance' && it.status === 'pending') {
          it.status = 'delivered'
          it.deliveredRound = this.round
        }
      }
    }

    const wallClock = this.deps.roundWallClockMs ?? 240_000
    const batchTimer = setTimeout(() => {
      this.aborted = true
    }, wallClock)

    const tasks = ids.map(async (agentId): Promise<Utterance> => {
      const agent = this.deps.getAgent(agentId)
      const startedAt = nowMs()

      if (!agent) {
        return this.absent(agentId, 'channel-error', startedAt)
      }

      // 预算熔断：达到上限则本批不再发言（PRD P0-2）
      if (this.spentUsd >= this.config.budgetLimitUsd) {
        this.budgetLimited = true
        this.emit('event', {
          type: 'budget-limited',
          spentUsd: this.getSpentUsd(),
        } satisfies OrchestratorEvent)
        return this.absent(agentId, 'over-budget', startedAt, '已达预算上限，本轮未发言')
      }

      const id = makeId('utt')
      // 立场覆盖注入：只对被指定的 agent 生效
      const stanceOverride = this.stanceOverrides.get(agentId)
      // 人类介入：只投递给目标模型，以独立区块呈现（不被摘要淡化）
      const myInterventions = interventionByAgent.get(agentId) ?? []

      const ctx = {
        sessionId: this.topic.id,
        round: this.round,
        topic: this.topic,
        digest,
        callout: this.pendingCallout,
        maxLenChars: 400,
        humanIntervention: myInterventions.length > 0 ? myInterventions.join('\n') : null,
        priorConclusion: this.priorConclusion,
        // 程序的引用质询：上一轮被判定凭空引用的模型，本轮先澄清再论证。
        // 单独成块、不混进人类介入 —— 归属错了，报告里就会把程序核验记成用户发言。
        systemChallenge: challengeSnapshot.get(agentId) ?? null,
        // 他人论点原话：digest 只有主持的转述，模型看不到对方怎么论证，
        // 于是一场讨论就退化成各说各话 —— 交锋需要弹药
        peers: this.buildPeerArguments(agentId, preBatchUtterances),
        ...(stanceOverride ? { stanceOverride } : {}),
      }

      let acc = ''
      try {
        const res = await agent.send(
          ctx,
          (chunk) => {
            acc += chunk
            this.emit('event', {
              type: 'utterance-delta',
              utteranceId: id,
              agentId,
              chunk,
            } satisfies OrchestratorEvent)
          },
          (chunk) => {
            this.emit('event', {
              type: 'thinking-delta',
              utteranceId: id,
              agentId,
              chunk,
            } satisfies OrchestratorEvent)
          },
          (chunk) => {
            this.emit('event', {
              type: 'steps-delta',
              utteranceId: id,
              agentId,
              chunk,
            } satisfies OrchestratorEvent)
          },
        )
        this.spentUsd += res.usage.costUsd
        this.countCall(agent, nowMs() - startedAt)
        const content = res.content || acc
        // 当场核验引用：只判「本场存在与否」，不判外部事实对错。
        // 判得晚一轮，别的模型就会把这些引用当作既定事实接住。
        const citations = auditCitations(content, citationIndex)
        if (hasBadCitation(citations)) {
          this.pendingChallenges.set(agentId, buildCitationChallenge(citations) ?? '')
        }
        const u: Utterance = {
          id,
          round: this.round,
          agentId,
          content,
          citations,
          targets: mergeTargets(
            res.targets,
            citations.validUtteranceIds,
            authorById,
            agentId,
          ),
          usage: res.usage,
          input: res.input,
          thinking: res.thinking,
          steps: res.steps,
          note: res.note,
          stance: this.deps.extractStance?.(agentId, res.content || acc),
          startedAt,
          endedAt: nowMs(),
        }
        this.utterances.push(u)
        this.emit('event', { type: 'utterance-done', utterance: u } satisfies OrchestratorEvent)
        return u
      } catch (e) {
        const reason: AbsentReason = e instanceof AgentError ? e.reason : 'channel-error'
        return this.absent(agentId, reason, startedAt, (e as Error).message)
      }
    })

    await Promise.all(tasks)
    clearTimeout(batchTimer)
    this.pendingCallout = null
    const challenged = challengeSnapshot.size

    // 人类插话与缺席都不算「模型说过了」：摘要只报有效发言数，否则 5/5 会骗人
    const roundUtts = this.utterances.filter((u) => u.round === this.round)
    const spoken = roundUtts.filter((u) => !u.absent && !u.human).length
    const absent = roundUtts.filter((u) => u.absent).length
    this.recordStage(
      'agent-batch',
      batchStartedAt,
      `发言 ${spoken}/${ids.length}${absent > 0 ? ` · 缺席 ${absent}` : ''}${challenged > 0 ? ` · 引用质询 ${challenged}` : ''}`,
    )
  }

  /**
   * 专项对辩轮（PRD 5.5）：追加一轮不计入常规轮次编号的对抗。
   * 突破 maxRounds 限制，且不参与收敛度判定。
   */
  private async runDuel(duel: DuelRound): Promise<void> {
    this.setState('AGENT_BATCH')
    this.emit('event', {
      type: 'duel-start',
      duel: { topic: duel.topic, agentIds: duel.agentIds },
    } satisfies OrchestratorEvent)

    const digest = anonymizeDigest(this.buildDigest(), this.aliases)
    const startedAt = nowMs()
    // 对辩同样要核对引用：快照取在开打前，双方各自的新发言不互为「合法引用」
    const duelCitationIndex = {
      utteranceIds: new Set(this.utterances.map((u) => u.id)),
      round: duel.parentRound,
      aliases: this.aliases.anonymous ? Object.keys(this.aliases.aliasToAgent) : [],
    }
    const duelAuthorById = new Map(this.utterances.map((u) => [u.id, u.agentId]))
    const preDuelUtterances = [...this.utterances]

    const tasks = duel.agentIds.map(async (agentId, idx) => {
      const agent = this.deps.getAgent(agentId)
      if (!agent) {
        return this.absent(agentId, 'channel-error', startedAt, '对辩模型不可用')
      }
      // 对辩双方互换：后发言者需回应先发言者。
      // 数组下标在 noUncheckedIndexedAccess 下为 string | undefined，
      // 单人对辩（agentIds 长度为 1）没有对手，此时不给 targets。
      const opponentId = duel.agentIds.length > 1 ? duel.agentIds[idx === 0 ? 1 : 0] : undefined
      const id = makeId('duel')
      // 提示词里只出现别名（匿名轨）或模型名称（署名轨）；targets 记的是发言 id 保血缘
      const opponentLabel = opponentId ? this.aliases.labelFor(opponentId) : '在场模型'
      // 对手最近一条有效发言：对辩的落点，也是 targets 唯一能写进血缘的形式
      const opponentUtteranceId = opponentId
        ? [...this.utterances].reverse().find((u) => u.agentId === opponentId && !u.absent && !u.human)?.id
        : undefined

      const ctx: TurnContext = {
        sessionId: this.topic.id,
        round: duel.parentRound,
        topic: this.topic,
        digest,
        callout: {
          targetAgent: agentId,
          quoteFromAgent: opponentId ?? agentId,
          quoteFromLabel: opponentLabel,
          ...(opponentUtteranceId ? { quoteFromUtterance: opponentUtteranceId } : {}),
          quote: `就「${duel.topic}」与 ${opponentLabel} 直接对辩`,
          instruction: `人类参与者要求你就「${duel.topic}」与对方直接对辩，不要重复此前已说过的论点。`,
        },
        maxLenChars: 400,
        peers: this.buildPeerArguments(agentId, preDuelUtterances),
      }

      let acc = ''
      try {
        const res = await agent.send(
          ctx,
          (chunk) => {
            acc += chunk
            this.emit('event', {
              type: 'utterance-delta',
              utteranceId: id,
              agentId,
              chunk,
            } satisfies OrchestratorEvent)
          },
          (chunk) => {
            this.emit('event', {
              type: 'thinking-delta',
              utteranceId: id,
              agentId,
              chunk,
            } satisfies OrchestratorEvent)
          },
          (chunk) => {
            this.emit('event', {
              type: 'steps-delta',
              utteranceId: id,
              agentId,
              chunk,
            } satisfies OrchestratorEvent)
          },
        )
        this.spentUsd += res.usage.costUsd
        const duelContent = res.content || acc
        const duelCitations = auditCitations(duelContent, duelCitationIndex)
        const u: Utterance = {
          id,
          round: duel.parentRound,
          agentId,
          content: duelContent,
          citations: duelCitations,
          targets: mergeTargets(
            res.targets,
            duelCitations.validUtteranceIds,
            duelAuthorById,
            agentId,
          ),
          usage: res.usage,
          input: res.input,
          thinking: res.thinking,
          steps: res.steps,
          note: res.note,
          stance: this.deps.extractStance?.(agentId, res.content || acc),
          startedAt: nowMs(),
          endedAt: nowMs(),
        }
        duel.utterances.push(u)
        this.utterances.push(u)
        this.emit('event', { type: 'utterance-done', utterance: u } satisfies OrchestratorEvent)
        return u
      } catch (e) {
        return this.absent(agentId, (e as AgentError).reason ?? 'channel-error', startedAt, (e as Error).message)
      }
    })

    await Promise.all(tasks)
    duel.endedAt = nowMs()
    this.duels.push(duel)
    this.emit('event', { type: 'duel-done', duelId: duel.id } satisfies OrchestratorEvent)
  }

  private absent(
    agentId: string,
    reason: AbsentReason,
    startedAt: number,
    detail?: string,
  ): Utterance {
    const agent = this.deps.getAgent(agentId)
    const name = agent?.displayName ?? agentId
    const u: Utterance = {
      id: makeId('utt'),
      round: this.round,
      agentId,
      content: absentText(name, reason) + (detail ? `（${detail}）` : ''),
      targets: [],
      absent: true,
      absentReason: reason,
      startedAt,
      endedAt: nowMs(),
    }
    this.utterances.push(u)
    this.emit('event', { type: 'absent', utterance: u } satisfies OrchestratorEvent)
    return u
  }

  /**
   * Batch B —— 主持小结。
   * 机械校验不通过则要求重打（最多 1 次重试），仍失败则暂停交还用户。
   *
   * 两点顺序不能颠倒：
   * - 先反匿名化再校验 —— 否则别名会被「support 指向不存在的模型」全部误杀；
   * - 无论通过还是被拒都要落审计 —— 被拒的那次正是用户该看到模型输出了什么的时候。
   */
  private async runModerator(): Promise<boolean> {
    const moderator = this.deps.getModerator()
    if (!moderator) return false

    const startedAt = nowMs()
    const attempts: ModeratorAttempt[] = []
    let accepted: ModeratorDigest | null = null
    let unknownAliases: string[] = []
    let leakedRealIds: string[] = []

    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        /**
         * 终止标志在主持往返之间生效。第一次 send 已经在飞行中掐不掉，
         * 但绝不该再补第二次 —— 更要紧的是这里必须 return false 而不是 break：
         * break 会掉进下面的「两次都失败 → 请暂停」，把一场正在终止的会话重新置为暂停。
         */
        if (this.aborted) return false
        const attemptAt = nowMs()
        const elapsed = () => nowMs() - attemptAt
        try {
          if (attempt === 2) this.setState('MODERATOR_RETRY')

          const raw = await moderator.send({
            system: this.moderatorSystemPrompt(),
            user: this.moderatorUserPrompt(),
          })
          this.spentUsd += raw.usage.costUsd
          this.ledger.moderatorCalls += 1

          const parsed = this.parseModeratorJson(raw.content)
          if (!parsed) {
            attempts.push({
              attempt,
              ok: false,
              raw: raw.content,
              validation: { ok: false, errors: ['主持输出不是合法 JSON'], warnings: [] },
              ms: elapsed(),
              costUsd: raw.usage.costUsd,
            })
            this.emit('event', {
              type: 'moderator-rejected',
              errors: ['主持输出不是合法 JSON'],
              attempt,
            } satisfies OrchestratorEvent)
            continue
          }

          const deanon = deanonymizeModeratorDigest(parsed, this.aliases)
          const digest = deanon.digest
          unknownAliases = deanon.unknownAliases
          leakedRealIds = deanon.leakedRealIds

          const realUtteranceIds = new Set(
            this.utterances.filter((u) => !u.absent && u.round === this.round).map((u) => u.id),
          )
          const allUtteranceIds = new Set(this.utterances.map((u) => u.id))
          const realAgentIds = new Set(this.config.participantIds)

          const v = validateModeratorDigest(
            digest,
            allUtteranceIds,
            new Set([...realAgentIds, moderator.id]),
          )
          if (deanon.unknownAliases.length > 0) {
            v.ok = false
            v.errors.push(
              `小结里的别名不在本场参会模型中：${deanon.unknownAliases.join('、')} —— 视为凭空归因`,
            )
          }
          // 本轮新发言必须真实存在
          if (digest.consensus_points?.some((p) => p.evidence_ref?.some((r) => !realUtteranceIds.has(r)))) {
            v.ok = false
            v.errors.push('存在共识点引用了本轮未发生的发言')
          }

          if (!v.ok) {
            attempts.push({
              attempt,
              ok: false,
              raw: raw.content,
              validation: v,
              ms: elapsed(),
              costUsd: raw.usage.costUsd,
            })
            this.emit('event', {
              type: 'moderator-rejected',
              errors: v.errors,
              attempt,
            } satisfies OrchestratorEvent)
            continue
          }

          attempts.push({
            attempt,
            ok: true,
            raw: raw.content,
            validation: v,
            ms: elapsed(),
            costUsd: raw.usage.costUsd,
          })
          this.applyModeratorDigest(digest)
          accepted = digest
          return true
        } catch (e) {
          const message = (e as Error).message
          attempts.push({
            attempt,
            ok: false,
            raw: '',
            validation: { ok: false, errors: [message], warnings: [] },
            ms: elapsed(),
            costUsd: 0,
            error: message,
          })
          this.emit('event', {
            type: 'moderator-rejected',
            errors: [message],
            attempt,
          } satisfies OrchestratorEvent)
        }
      }

      // 两次都失败 → 暂停交还用户（PRD 6.2）
      this.requestPause('主持模型小结失败，请更换主持或切换无主持降级模式')
      return false
    } finally {
      const audit: ModeratorAuditEntry = {
        round: this.round,
        anonymous: this.aliases.anonymous,
        aliases: this.getAliasMap(),
        attempts,
        unknownAliases,
        leakedRealIds,
        accepted,
        startedAt,
      }
      this.audits.push(audit)
      this.emit('event', { type: 'moderator-audit', audit } satisfies OrchestratorEvent)
      this.recordStage(
        'moderator',
        startedAt,
        accepted
          ? `第 ${attempts.length} 次尝试通过 · 共识 ${accepted.consensus_points.length} 条`
          : `${attempts.length} 次尝试均未通过校验`,
      )
    }
  }

  /** 校验通过后落库：共识、分歧、三维度分数 + 本轮幻觉账本 */
  private applyModeratorDigest(d: ModeratorDigest): void {
    // 规则 2：共识度核算只看模型发言，排除人类发言与缺席
    const roundUtterances = modelUtterancesOnly(
      this.utterances.filter((u) => u.round === this.round),
    )
    // 本轮新列出的共识点（尚未去重写入 this.confirmed）
    const incomingPoints: ConsensusPoint[] = d.consensus_points.map((p) => {
      const weight =
        typeof p.weight === 'number' && p.weight >= 0 && p.weight <= 1 ? p.weight : undefined
      return {
        id: makeId('cp'),
        claim: p.claim,
        support: p.support,
        confidence: p.confidence,
        evidenceRef: p.evidence_ref,
        confirmedRound: this.round,
        ...(weight === undefined ? {} : { weight }),
      }
    })

    // ---- 幻觉账本：必须在写入 this.confirmed 之前算 ----
    // 两份清单合并之后就分不出「本轮新列的」和「历史带过来的」，跨轮增量无从比较。
    const allModelUtterances = modelUtterancesOnly(this.utterances)
    const utterancesUpToPrev = allModelUtterances.filter((u) => u.round < this.round)
    const drift = trackClaimDrift(this.prevRoundPoints, incomingPoints)
    const growth = attributedGrowth(this.prevRoundPoints, utterancesUpToPrev, incomingPoints, allModelUtterances)
    const citations = {
      badUtterances: roundUtterances.filter((u) => hasBadCitation(u.citations)).length,
      bogusRefs: roundUtterances.reduce((a, u) => a + (u.citations?.bogusUtteranceIds.length ?? 0), 0),
      outOfRangeRefs: roundUtterances.reduce((a, u) => a + (u.citations?.outOfRangeRounds.length ?? 0), 0),
      unknownLabels: roundUtterances.reduce((a, u) => a + (u.citations?.unknownLabels.length ?? 0), 0),
    }

    // 共识点：support 与 evidence_ref 必须来自真实发言（重复 claim 不重复登记）。
    // 主持每轮看不到自己上一轮的原文，只能重新措辞，于是同一个判断会被写成三四种说法 ——
    // 这里按内容归并成一条，原始说法留在 variants 上，报告如实说明并掉了几条。
    const pointMerge = mergeConsensusPoints(
      this.confirmed,
      incomingPoints,
      d.consensus_points.map((p) => p.continues ?? null),
    )
    this.confirmed = pointMerge.points
    this.mergedPoints += pointMerge.merged
    this.mergeNotes.push(...pointMerge.ignoredContinues)

    // 未决分歧：只增不减（PRD 6.8）
    const incoming: OpenDispute[] = d.open_disputes.map((x) => ({
      id: makeId('od'),
      claim: x.claim,
      sides: x.sides.map((s) => ({
        agentId: s.agent_id,
        argument: s.argument,
        utteranceIds: roundUtterances.filter((u) => u.agentId === s.agent_id).map((u) => u.id),
      })),
      openedRound: this.round,
      lastProgress: null,
      status: 'open',
    }))

    const { merged, rejected } = mergeOpenDisputes(this.open, incoming, this.round)
    this.open = merged
    if (rejected.length > 0) {
      console.warn('[orchestrator] 分歧合并拒绝项：', rejected)
    }

    // 「已充分讨论并排除的方向」：主持列举 → 程序去重累计。
    // 不接这一手，注入纪要里的这个区块就永远是空的，模型会重新论证已经排除的东西。
    for (const raw of d.explored_directions ?? []) {
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (!text) continue
      if (!this.explored.includes(text)) this.explored.push(text)
    }
    if (this.explored.length > EXPLORED_CAP) {
      this.explored.splice(0, this.explored.length - EXPLORED_CAP)
    }

    // 三维度：agreement 与 trend 由程序核算，overlap 以程序值为准（主持自评只在无数据时兜底）
    const agreement = computeAgreement(roundUtterances, incomingPoints)
    const trend = computeTrend(openOnly(this.open).length, this.lastOpenCount)
    const computedOverlap = computeOverlap(incomingPoints)
    const overlap = resolveOverlap(computedOverlap, d.score_dimensions.overlap, incomingPoints.length)

    const score: ConsensusScore = {
      ...weightedScore({ agreement: agreement.value, overlap: overlap.value, trend }),
      agreementSource: agreement.source,
      overlapSource: overlap.source,
      ...(agreement.independence === null ? {} : { independence: agreement.independence }),
    }
    this.scores.push({ round: this.round, score })

    // 主持抬分：它被要求给三维度打分，旧实现把这份打分丢掉 —— 现在把它当信号用。
    const inflation = moderatorInflation(d.score_dimensions, {
      agreement: agreement.value,
      overlap: overlap.value,
      trend,
    })

    const record = buildRoundRecord({
      round: this.round,
      utterances: roundUtterances.length,
      citations,
      attributedGrowthCount: growth.growthCount,
      drift: { hollow: drift.hollow, substantiated: drift.substantiated },
      inflation,
    })
    this.hallucinationRounds.push(record)
    this.emit('event', { type: 'hallucination-round', record } satisfies OrchestratorEvent)

    // 质询覆盖率供结构收敛判定使用：没人反驳过的共识可能只是没人读
    const provenance = endorsementProvenance(incomingPoints, allModelUtterances)
    this.lastCrossExaminedRate =
      provenance.length === 0
        ? 0
        : Math.round((provenance.filter((p) => p.crossExamined).length / provenance.length) * 100)

    // 收敛趋势：记录上一轮未决数
    this.lastOpenCount = openOnly(this.open).length

    // 连续不升检测
    const prev = this.scores[this.scores.length - 2]
    if (prev && score.score <= prev.score.score) {
      this.noProgressRounds += 1
    } else {
      this.noProgressRounds = 0
    }

    this.prevRoundPoints = incomingPoints

    this.emit('event', { type: 'moderator', digest: d, score, open: [...this.open] } satisfies OrchestratorEvent)

    // 下一轮 callout
    if (d.callout) {
      // 主持只给了「回应谁」，没给发言编号 —— 取该模型最近一条有效发言：
      // 交锋要接住的是他刚说过的话，不是开场白。这条 id 就是下一轮 targets 的落点。
      const targetQuote = [...this.utterances]
        .reverse()
        .find((u) => u.agentId === d.callout?.quote_from_agent && !u.absent && !u.human)
      this.pendingCallout = {
        targetAgent: d.callout.target_agent,
        quoteFromAgent: d.callout.quote_from_agent,
        quoteFromLabel: this.aliases.labelFor(d.callout.quote_from_agent),
        quote: targetQuote?.content.slice(0, 200) ?? '',
        instruction: d.callout.instruction,
        ...(targetQuote ? { quoteFromUtterance: targetQuote.id } : {}),
      }
    }
  }

  private parseModeratorJson(content: string): ModeratorDigest | null {
    // 容忍模型输出 markdown 代码块包裹
    const cleaned = content
      .replace(/```json\s*/gi, '')
      .replace(/```\s*$/g, '')
      .trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as ModeratorDigest
    } catch {
      return null
    }
  }

  /**
   * 注入模型的历史纪要。
   *
   * 超过阈值就压缩 —— 这条路径此前从未被调用（compressDigest 只有定义没有调用点），
   * 于是轮次一多，注入文本无上限增长：网页通道的输入框有截断，压到后半段直接丢。
   * 硬约束照旧：open 清单逐字搬运，概括只作用于 confirmed 的措辞与证据条数。
   */
  private buildDigest(): Digest {
    const full: Digest = {
      confirmed: this.confirmed,
      open: this.open,
      explored: this.explored,
      rounds: [],
    }
    if (renderDigestForPrompt(full).length <= DIGEST_COMPRESS_CHARS) return full

    this.digestCompacted = true
    return compressDigest(full, ({ confirmed, explored }) => ({
      confirmed: confirmed.slice(-CONFIRMED_KEEP_ON_COMPRESS).map((c) => ({
        ...c,
        claim: c.claim.length > 90 ? `${c.claim.slice(0, 90)}…` : c.claim,
        // 证据只留最近两条：更早的发言本轮模型并不重读，靠 id 引用即可核对
        evidenceRef: c.evidenceRef.slice(-2),
      })),
      explored: explored.slice(-EXPLORED_CAP),
    }))
  }

  /** 按通道记账：金额之外的真实代价（次数、墙钟）全靠这里 */
  private countCall(agent: Agent, ms: number): void {
    if (agent.transport === 'api') this.ledger.apiCalls += 1
    else this.ledger.webCalls += 1
    this.ledger.totalMs += Math.max(0, ms)
  }

  // -------------------------------------------------------------------------
  // 单模型基线（回答「研讨到底值不值」）
  // -------------------------------------------------------------------------

  /**
   * 基线模型的选择：按参会顺序取第一位可用模型，**不选主持**。
   *
   * 主持来答基线会形成先入 —— 它随后要评判别人的发言是否与自己那套一致。
   * 参会顺序是用户在设置页排过的，本身就是「用户心中的强弱次序」。
   *
   * 主持兼参会是允许的，所以这里必须在参会循环里跳过它：
   * 只在末尾兜底跳过，会让「名单第一位恰好是主持」的场次静默变成主持答基线，
   * 把上面那条纪律绕过去。只有一个参会者且他就是主持时，仍走兜底 —— 那时没得选。
   */
  private resolveBaselineAgent(): Agent | undefined {
    for (const id of this.config.participantIds) {
      if (id === this.config.moderatorId) continue
      const a = this.deps.getAgent(id)
      if (a && a.status !== 'disabled') return a
    }
    return this.config.moderatorId ? this.deps.getAgent(this.config.moderatorId) : undefined
  }

  /**
   * 基线批次：在任何参会发言之前，让一个模型独立答一次。
   *
   * 两条纪律：
   * - 结果**不写入** this.utterances，也不进 digest —— 基线一旦进入讨论上下文，
   *   就成了「被讨论采纳的又一个观点」，对照物本身消失；
   * - 字数上限比参会发言宽松得多 —— 给基线 400 字等于替研讨搭擂台。
   */
  private async runBaseline(): Promise<void> {
    const startedAt = nowMs()
    const agent = this.resolveBaselineAgent()
    if (!agent) {
      this.recordStage('baseline', startedAt, '无可用基线模型（参会者全部禁用）')
      return
    }

    const ctx: TurnContext = {
      sessionId: this.topic.id,
      round: 0,
      topic: this.topic,
      digest: { confirmed: [], open: [], explored: [], rounds: [] },
      callout: null,
      maxLenChars: BASELINE_MAX_CHARS,
      systemChallenge: null,
    }

    try {
      const res = await agent.send(ctx, () => {})
      this.spentUsd += res.usage.costUsd
      this.countCall(agent, nowMs() - startedAt)
      const baseline: BaselineResult = {
        agentId: agent.id,
        displayName: agent.displayName,
        transport: agent.transport,
        content: res.content,
        startedAt,
        endedAt: nowMs(),
        costUsd: res.usage.costUsd,
      }
      this.baseline = baseline
      this.emit('event', { type: 'baseline', baseline } satisfies OrchestratorEvent)
      this.recordStage(
        'baseline',
        startedAt,
        `${agent.displayName} 独立作答 ${res.content.length} 字（不进讨论上下文）`,
      )
    } catch (e) {
      const message = (e as Error).message
      const baseline: BaselineResult = {
        agentId: agent.id,
        displayName: agent.displayName,
        transport: agent.transport,
        content: '',
        startedAt,
        endedAt: nowMs(),
        costUsd: 0,
        absent: true,
        absentReason: message,
      }
      this.baseline = baseline
      this.emit('event', { type: 'baseline', baseline } satisfies OrchestratorEvent)
      this.recordStage('baseline', startedAt, `基线未产出：${message}`)
    }
  }

  /**
   * 研讨结论 vs 基线的对照，交给主持做一次结构化判断。
   *
   * 这是全场唯一带主观性的额外调用，所以只要求它「列举差异」，不要求它打分 ——
   * 差异清单用户可以逐条核对，分数只能信。
   */
  private async runBaselineCompare(): Promise<void> {
    if (!this.config.baselineCompare) return
    const baseline = this.baseline
    if (!baseline || baseline.absent || !baseline.content.trim()) return
    const moderator = this.deps.getModerator()
    if (!moderator) return

    const startedAt = nowMs()
    const consensus = this.confirmed
      .map(
        (p, i) =>
          `${i + 1}. ${p.claim}（支持：${p.support.map((id) => this.label(id)).join('、') || '未登记'}）`,
      )
      .join('\n')
    const disputes = openOnly(this.open)
      .map(
        (d, i) =>
          `${i + 1}. ${d.claim}（${d.sides.map((s) => this.label(s.agentId)).join(' vs ')}）`,
      )
      .join('\n')

    try {
      const res = await moderator.send({
        system: [
          '你是同一场讨论的对照审校。下面给出：同题的单模型独立作答（基线），以及多模型研讨的最终共识与未决分歧。',
          '任务只有列举，不打分：',
          '- council_adds：研讨里有、基线里没有的要点（须是基线确实没说的，不是换了措辞的）；',
          '- council_drops：基线说到了、研讨反而丢掉或没展开的要点；',
          '- regressions：研讨相对基线讲错、讲虚或被削弱的判断；',
          '- verdict：council_better / baseline_better / mixed / inconclusive 四选一；',
          '- note：一句话说明判定依据。',
          '若信息不足以判断，宁可给 inconclusive。不得为了显得研讨有价值而编造差异。',
          '输出严格为 JSON。',
        ].join('\n'),
        user: [
          `议题：${this.topic.title}`,
          this.topic.background ? `背景：${this.topic.background}` : '',
          '',
          `【基线 · ${baseline.displayName} 独立作答】`,
          baseline.content,
          '',
          '【研讨共识】',
          consensus || '（无）',
          '',
          '【研讨未决分歧】',
          disputes || '（无）',
          '',
          '请输出：{"verdict":"...","council_adds":["..."],"council_drops":["..."],"regressions":["..."],"note":"..."}',
        ]
          .filter(Boolean)
          .join('\n'),
      })
      this.spentUsd += res.usage.costUsd
      this.ledger.moderatorCalls += 1

      const parsed = parseJsonObject<{
        verdict?: string
        council_adds?: string[]
        council_drops?: string[]
        regressions?: string[]
        note?: string
      }>(res.content)
      if (!parsed) {
        this.recordStage(
          'baseline',
          startedAt,
          '基线对照未产出：主持输出不是合法 JSON（报告仍并排给出基线与研讨结论）',
        )
        return
      }
      const allowed: BaselineComparison['verdict'][] = [
        'council_better',
        'baseline_better',
        'mixed',
        'inconclusive',
      ]
      const verdict = allowed.includes(parsed.verdict as BaselineComparison['verdict'])
        ? (parsed.verdict as BaselineComparison['verdict'])
        : 'inconclusive'
      const compare: BaselineComparison = {
        verdict,
        councilAdds: toStringList(parsed.council_adds),
        councilDrops: toStringList(parsed.council_drops),
        regressions: toStringList(parsed.regressions),
        note: typeof parsed.note === 'string' ? parsed.note.trim() : '',
        raw: res.content,
      }
      this.baselineCompare = compare
      this.emit('event', { type: 'baseline-compare', compare } satisfies OrchestratorEvent)
      this.recordStage(
        'baseline',
        startedAt,
        `对照完成：${verdictLabel(verdict)} · 研讨多出 ${compare.councilAdds.length} 点 / 丢掉 ${compare.councilDrops.length} 点`,
      )
    } catch (e) {
      this.recordStage('baseline', startedAt, `基线对照未产出：${(e as Error).message}`)
    }
  }

  // -------------------------------------------------------------------------
  // 幻觉核验轮（主动矫正，不只是测量）
  // -------------------------------------------------------------------------

  /**
   * 就「被代答的共识支持」向被冒名的模型本人质询。
   *
   * 为什么问模型本人而不是问主持：主持是归因方，让它复核自己的归因等于让它
   * 对同一件事判断第二次；只有被归因的模型能用它自己的发言否掉这条支持。
   *
   * 结算纪律（与 open 清单只增不减同是一条理由）：
   * - 否认 → 从 support 移出，共识点**保留**；支持归零标 vacated，仍进报告；
   * - 确认 → 把本次答复登记为证据，代答转为可核对；
   * - 未答 / 通道失败 → 保持原状，报告如实写「没核对上」。
   */
  private async runVerificationPass(): Promise<void> {
    const startedAt = nowMs()
    const mode = this.config.verifyPass ?? 'auto'
    const modelUtterances = modelUtterancesOnly(this.utterances)
    const totalAttributed = attributedEndorsements(this.confirmed, modelUtterances).length
    const provisional = buildHallucinationReport({
      records: this.hallucinationRounds,
      totalClaimedSupport: this.confirmed.reduce((a, p) => a + new Set(p.support).size, 0),
      totalAttributedSupport: totalAttributed,
      corrections: [],
      vacatedPoints: 0,
      triggeredBy: '',
    })
    const decision = needsVerificationPass(mode, {
      riskScore: provisional.riskScore,
      trajectory: provisional.trajectory,
      attributedTotal: totalAttributed,
    })
    this.verificationTriggeredBy = decision.triggeredBy

    if (!decision.needed) {
      this.recordStage('verification', startedAt, `核验轮跳过 · ${decision.triggeredBy}`)
      return
    }

    // 每位模型只问「影响最大的一条」：一次答复对应一条共识点，归属才不含糊
    const targets = pendingVerificationTargets(this.confirmed, modelUtterances, VERIFY_TARGET_CAP)
    const byAgent = new Map<string, CorrectionTarget>()
    for (const t of targets) {
      if (!byAgent.has(t.agentId)) byAgent.set(t.agentId, t)
    }
    if (byAgent.size === 0) {
      this.verificationTriggeredBy = `${decision.triggeredBy}；无可质询对象（支持方已全部核对过）`
      this.recordStage('verification', startedAt, '核验轮跳过 · 无可质询对象')
      return
    }

    const digest = anonymizeDigest(this.buildDigest(), this.aliases)
    const tasks = [...byAgent.values()].map(async (target) => {
      const agent = this.deps.getAgent(target.agentId)
      if (!agent) {
        this.settleCorrection(target, null, buildEndorsementChallenge(target), null)
        return
      }
      const question = buildEndorsementChallenge(target)
      const ctx: TurnContext = {
        sessionId: this.topic.id,
        round: this.round,
        topic: this.topic,
        digest,
        callout: null,
        maxLenChars: 300,
        systemChallenge: question,
      }
      const sendStartedAt = nowMs()
      const id = makeId('verify')
      try {
        const res = await agent.send(ctx, (chunk) => {
          this.emit('event', {
            type: 'utterance-delta',
            utteranceId: id,
            agentId: target.agentId,
            chunk,
          } satisfies OrchestratorEvent)
        })
        this.spentUsd += res.usage.costUsd
        this.countCall(agent, nowMs() - sendStartedAt)
        const u: Utterance = {
          id,
          round: this.round,
          agentId: target.agentId,
          content: res.content,
          targets: [],
          usage: res.usage,
          input: res.input,
          note: '【核验轮】对「这句话是不是你说的」的答复，不参与下一轮论证',
          startedAt: sendStartedAt,
          endedAt: nowMs(),
        }
        this.utterances.push(u)
        this.emit('event', { type: 'utterance-done', utterance: u } satisfies OrchestratorEvent)
        this.settleCorrection(target, u.id, question, res.content)
      } catch (e) {
        this.settleCorrection(target, null, question, null)
        console.warn('[orchestrator] 核验轮质询失败：', target.agentId, (e as Error).message)
      }
    })

    await Promise.all(tasks)

    this.vacatedPoints = this.confirmed.filter((p) => p.verification?.status === 'vacated').length
    const report = this.getHallucinationReport()
    this.recordStage(
      'verification',
      startedAt,
      `质询 ${byAgent.size} 位 · 确认 ${report?.verification.confirmed ?? 0} / 否认 ${report?.verification.denied ?? 0} / 未答 ${report?.verification.noResponse ?? 0}`,
    )
  }

  /** 把一次答复结算到对应共识点上（只降级，不删除条目） */
  private settleCorrection(
    target: CorrectionTarget,
    utteranceId: string | null,
    question: string,
    answer: string | null,
  ): void {
    const index = this.confirmed.findIndex((p) => p.id === target.pointId)
    if (index < 0) return
    const point = this.confirmed[index]
    if (!point) return
    const outcome = answer === null || answer.trim() === '' ? 'no_response' : classifyVerificationAnswer(answer)
    const { point: next, correction } = applyCorrection(point, {
      agentId: target.agentId,
      outcome,
      round: this.round,
      utteranceId,
      question,
      answer: answer?.slice(0, 400) ?? null,
    })
    this.confirmed[index] = next
    // 必须落进本场账本：报告的 asked/confirmed/denied 全靠这份清单，
    // 只发事件不记账，报告就会把「已经核验过」写成「一次都没问」。
    this.corrections.push(correction)
    this.emit('event', { type: 'verification', correction } satisfies OrchestratorEvent)
  }

  /** 提示词里对某个参会模型的可读称呼：匿名轨只给别名，署名轨给模型名称 */
  private label(agentId: string): string {
    if (this.aliases.anonymous && !this.aliases.agentToAlias[agentId]) return agentId
    const labeled = this.aliases.labelFor(agentId)
    // 别名表只覆盖参会名单；名单外被点到的（兼岗主持单独出现时）也得有个能看的名字
    return labeled === agentId ? (this.deps.nameOf?.(agentId) ?? agentId) : labeled
  }

  /**
   * 他人论点原话（最近的在前，最多 PEER_CAP 条）。
   *
   * 为什么必须由编排层给、而不是让模型从 digest 里读：digest 是主持的转述，
   * 只剩「谁支持什么」，模型看不到对方究竟是怎么论证的，也没有可复制的发言编号，
   * 于是「点名反驳」在提示词里根本没有对象 —— 一场讨论就写成五段并列陈述。
   *
   * pool 必须是批次开始前的快照：本轮同批次的发言互相看不到（发言独立性），
   * 把刚生成的 id 也塞进去等于让它回应还没定稿的话，引用核验也会失去参照系。
   */
  private buildPeerArguments(excludeAgentId: string, pool: readonly Utterance[]): PeerArgument[] {
    return pool
      .filter(
        (u) =>
          !u.absent &&
          !u.human &&
          u.agentId !== excludeAgentId &&
          u.content.trim().length > 0,
      )
      .slice(-PEER_CAP)
      .reverse()
      .map((u) => ({
        utteranceId: u.id,
        label: this.label(u.agentId),
        round: u.round,
        text: u.content,
      }))
  }

  private moderatorSystemPrompt(): string {
    const rules = [
      '每条 consensus_points 的 support 必须指向真实参与过的模型，evidence_ref 必须指向真实存在的发言；',
      '不得为了推进收敛而合并本质不同的观点；若分歧无法消解，保留在 open_disputes 中；',
      '必须按三维度分别给分（score_dimensions），不接受单一主观总分；',
      'surface 附和不得加分：若模型只是换了措辞而未提供新论据，不应计入 agreement。',
      // 代答是共识度虚高的主通道：主持替模型点头，模型本人无法反驳这个归因。
      // 程序会算出「代答率」并向本人质询，所以这里先把规矩讲明白。
      'support 只能列**本人发言里说过的**模型。某条共识只在你归纳时出现、任何模型都没说过 —— 它不是共识，写进 open_disputes 或不写，不要替模型认领。',
      'score_dimensions 三档分数会被程序复算，你给的分数只用于比较偏差；把 agreement 写高不会让本场收敛，只会让报告标注一处「主持抬分」。',
      // 重列的代价：每换一次说法就丢一点限定条件，三轮下来「5 条共识」其实是 2 个判断。
      // 程序按内容兜底归并，但兜不住措辞漂移，所以这里从源头要求照抄。
      'consensus_points 只写**本轮有新证据或新支持方**的条目。用户提示里给了「此前已确认的共识」清单：判断没变就不要重列；确实要补充时，claim 必须原样照抄清单里的措辞并在 continues 填它的 id —— 换个说法重写同一个判断，程序会按内容并回原条目，但你的重复列举会让报告里的共识数虚高。',
    ]
    /**
     * 兼岗护栏。用户可以把主持同时勾进参会名单 —— 那它就既出题又判卷。
     * 风险不是它「说了什么」，而是它给自己那份观点背书：同一段判断被同一个模型
     * 说两遍，在 agreement 上看起来像两个独立支持方。程序侧的复算只看本人发言，
     * 拦不住「我同意我自己」，所以这里从提示词口径上先把它降级成一名普通观点。
     */
    if (this.config.moderatorId && this.config.participantIds.includes(this.config.moderatorId)) {
      rules.push(
        '本场你同时是参会者：你的发言已经和其他发言一起列在「本轮发言」里。把它当作一名普通观点计分 —— 不要因为出自你手就加入自己的 support，也不要用它去「印证」别人的说法；你自己说过、但没有任何其他模型说过的判断，只能进 open_disputes 或不写。',
      )
    }
    if (this.aliases.anonymous) {
      rules.push(
        '本场为匿名轨：参会者身份已隐去，只按论点本身判断。support / agent_id / target_agent / quote_from_agent / next_round_order 一律使用给出的别名，不得猜测厂商或模型名。',
      )
    }
    rules.push(
      'weight、agent_quality、explored_directions 与 continues 是附加信号：格式写错只记入警告、不会导致本次小结被拒；但 support 与 evidence_ref 凭空捏造会被直接拒绝。',
    )

    return `你是本场多模型讨论的主持人。你的职责是如实记录共识与分歧，而非推动讨论看起来成功。

硬约束（违反将被程序拒绝）：
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

输出严格为 JSON，不要包裹任何解释文字。`
  }

  private moderatorUserPrompt(): string {
    const ref = this.aliases.anonymous ? '参会者A' : '模型名称'
    const lines: string[] = []
    lines.push(`议题：${this.topic.title}`)
    if (this.topic.background) lines.push(`背景材料：${this.topic.background}`)
    lines.push(`当前第 ${this.round}/${this.config.maxRounds} 轮`)
    lines.push('')
    lines.push(
      this.aliases.anonymous
        ? '参会者（身份已匿名，请用下列别名指代）：'
        : '参与模型（指代时请照抄下列名称，不要写内部 id）：',
    )
    for (const id of this.config.participantIds) {
      // 匿名轨不标：标了就等于告诉主持哪个别名是它自己，护栏反而变成偏袒入口
      const self = !this.aliases.anonymous && id === this.config.moderatorId
      lines.push(`- ${this.label(id)}${self ? '（主持兼任参会，本场也在发言）' : ''}`)
    }
    lines.push('')
    lines.push('本轮发言：')
    for (const u of this.utterances.filter((x) => x.round === this.round && !x.absent)) {
      lines.push(`- [${u.id}] ${this.label(u.agentId)}：${u.content}`)
    }
    const absentList = this.utterances.filter((x) => x.round === this.round && x.absent)
    if (absentList.length > 0) {
      lines.push('')
      lines.push('本轮缺席（不得据此推断立场）：')
      for (const u of absentList) lines.push(`- ${this.label(u.agentId)}：${u.absentReason}`)
    }

    // 已确认共识清单。不给这一份，主持每轮只能凭记忆重新措辞，同一个判断被写成三四条：
    // 程序侧的归并能压住呈现，但压不住每次重写漂走的限定条件，所以从提示词源头要求照抄。
    const ledger = this.confirmed.slice(-MODERATOR_LEDGER_CAP)
    if (ledger.length > 0) {
      lines.push('')
      lines.push('此前已确认的共识（判断相同就不要重列；要补充则 claim 原样照抄、continues 填该 id，并带上本轮的新证据）：')
      for (const p of ledger) {
        lines.push(
          `- [${p.id}] ${p.claim}（认同：${p.support.map((id) => this.label(id)).join('、') || '未记录'}，第 ${p.confirmedRound} 轮确认）`,
        )
      }
    }

    if (this.open.length > 0) {
      lines.push('')
      lines.push('此前已登记且仍未消解的分歧：')
      for (const d of openOnly(this.open)) {
        lines.push(`- ${d.claim}（${d.sides.map((s) => this.label(s.agentId)).join(' vs ')}）`)
      }
    }

    if (this.humanRecords.length > 0) {
      lines.push('')
      lines.push('人类参与者介入（需在下一轮分发给相关模型，且不得据此抬高共识度）：')
      for (const h of this.humanRecords) lines.push(`- ${h}`)
    }

    lines.push('')
    lines.push('请输出如下结构的 JSON：')
    lines.push(`{
  "consensus_points": [{ "claim": "...", "support": ["${ref}"], "confidence": 0.0-1.0, "weight": 0.0-1.0, "evidence_ref": ["utteranceId"], "continues": null | "本轮补充的已有共识 id" }],
  "open_disputes": [{ "claim": "...", "sides": [{ "agent_id": "${ref}", "argument": "..." }] }],
  "score_dimensions": { "agreement": 0-100, "overlap": 0-100, "trend": 0-100 },
  "score": 0-100,
  "next_round_order": ["${ref}"],
  "agent_quality": [{ "agent_id": "${ref}", "rank": 1, "rationale": "一句话名次依据" }],
  "explored_directions": ["本轮已充分讨论并可排除的方向（一句话一条，没有就给空数组）"],
  "callout": null | { "target_agent": "${ref}", "quote_from_agent": "${ref}", "instruction": "..." }
}`)
    lines.push('')
    lines.push(
      'weight 是这条共识的证据硬度（0=只有一句口号，1=多个独立来源给出可核对的论据）；' +
        'agent_quality 是本轮各参会者回答质量的名次（1 为最好，只列确有差异的几位即可）。',
    )
    lines.push(
      'explored_directions 会被登记进「已充分讨论并排除的方向」并在后续轮次注入给参会模型 —— ' +
        '只在确实聊透、且理由成立时列举，不要为了填字段而填。',
    )

    return lines.join('\n')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
