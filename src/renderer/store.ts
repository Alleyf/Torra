/**
 * 渲染层状态（Zustand）
 *
 * 对应 PRD 8.1 三区布局与 8.2 三种模式。
 */

import { create } from 'zustand'
import type {
  BaselineComparison,
  BaselineResult,
  CitationAudit,
  ConsensusPoint,
  DiscussionStage,
  HallucinationCorrection,
  HallucinationReport,
  HallucinationRoundRecord,
  ModeratorAuditEntry,
  OpenDispute,
  OrchestratorState,
  SessionRecord,
  StageTiming,
  StanceMark,
  StrategyKind,
  TokenUsage,
  UtteranceInput,
  VerifyPassMode,
} from '@shared/types'
import { TIME_BUDGET_DEFAULT_MS, VERIFY_PASS_DEFAULT } from '@shared/types'
import { pickDefaultParticipants, usableModels } from '@shared/participants'

/**
 * 视图模式。
 *
 * 原先有第三个 takeover 模式，用于「手动操作页面」。
 * 现已移除：登录、人机验证、纠偏都需要直接操作同一个页面，
 * 而内嵌的 WebContentsView 本就可直接交互，无需再切模式 ——
 * 多一个模式只会让「登录在哪做」这件事变得含糊。
 */
export type ViewMode = 'hall' | 'broadcast'

export interface UiUtterance {
  id: string
  round: number
  agentId: string
  content: string
  streaming: boolean
  absent: boolean
  absentReason?: string
  targets: string[]
  stance?: StanceMark
  /** 人类参与者发言（PRD 5.5：单列呈现，不计入共识度） */
  human?: boolean
  usage?: TokenUsage
  /** 实际发给模型的输入，供 UI 查看「输入/输出」 */
  input?: UtteranceInput
  /** 推理模型的思维链/思考内容，供 UI「思考」区块展示与复制 */
  thinking?: string
  /** agent 型网页站的执行过程（检索/跑代码等步骤），供 UI「执行过程」区块展示 */
  steps?: string
  /** 本轮的非致命异常（如附件未送达），卡片角标用 */
  note?: string
  /** 程序对本条发言的引用核验：不存在的发言 id / 越界轮次 / 未知别名 */
  citations?: CitationAudit
  startedAt?: number
  endedAt?: number
}

/** 人工介入记录（PRD 5.5） */
export interface UiIntervention {
  id: string
  kind: 'interject' | 'followup' | 'duel' | 'set-stance' | 'stop'
  text: string
  atRound: number
  deliveredRound?: number
  status: 'pending' | 'delivered' | 'cancelled'
  targetAgentIds: string[]
  targetAgentId?: string
  duelAgentIds?: string[]
  topic?: string
  stanceAgentId?: string
  stanceBefore?: string
  stanceAfter?: string
  note?: string
}

export interface UiDispute extends OpenDispute {}
export interface UiConsensus extends ConsensusPoint {}

export interface ScorePoint {
  round: number
  score: number
  agreement: number
  overlap: number
  trend: number
}

interface TorraState {
  // 配置态
  models: ModelSummary[]
  topicTitle: string
  topicBackground: string
  strategy: StrategyKind
  participantIds: string[]
  moderatorId: string | null
  maxRounds: number
  consensusThreshold: number
  budgetLimitUsd: number
  /** 匿名互评轨：主持人只见别名，用来压制厂商身份带来的偏向 */
  anonymousReview: boolean
  /** 单模型基线：讨论开场先让一个模型独立作答，作为「研讨到底多出了什么」的对照 */
  baseline: boolean
  /** 出报告前让主持比对研讨结论与基线 */
  baselineCompare: boolean
  /** 幻觉核验轮模式：off 只测量，auto 风险达标才质询，always 逐条质询 */
  verifyPass: VerifyPassMode
  /** 时长预算（分钟）。网页通道不计费，墙钟是唯一能兜住代价的闸门 */
  timeBudgetMin: number

  // 运行态
  state: OrchestratorState
  /**
   * 结束原因（converged / max-rounds / aborted / no-moderator / failed）。
   *
   * 「跑了 5 轮刚好用尽」和「第 3 轮就收敛」是两份可信度不同的结论，
   * 主进程在 done 里给过、历史存档里也有，此前被丢掉，界面只能显示「已结束」。
   */
  finishedReason: string | null
  round: number
  viewMode: ViewMode
  broadcastTarget: string | null
  /** 聊天页按需打开的网页模型：与研讨的 broadcastTarget 分开，各自生命周期 */
  chatWebviewTarget: string | null
  utterances: UiUtterance[]
  consensus: UiConsensus[]
  disputes: UiDispute[]
  scores: ScorePoint[]
  spentUsd: number
  budgetLimited: boolean
  moderatorUnavailable: boolean
  moderatorNote: string | null
  /**
   * 主持小结审计：原始 JSON + 程序校验结果 + 别名映射。
   * 与 moderatorNote 的分工不同 —— note 是「主持人说了什么」，
   * audit 是「程序信到什么程度」，两者并置才能让人看出代答与凭空归因。
   */
  moderatorAudit: ModeratorAuditEntry[]
  /** 粗粒度阶段耗时，补齐 *-delta 覆盖不到的等待期（并行发言批、主持批、报告） */
  stageTimings: StageTiming[]
  /** 第 0 轮的单模型基线（不参与任何轮次，也不进纪要） */
  baselineResult: BaselineResult | null
  /** 主持对「研讨 vs 基线」的结构化比对 */
  baselineCompareResult: BaselineComparison | null
  /** 逐轮幻觉账本：凭空引用 / 代答 / 空心改写 / 抬分 */
  hallucinationRounds: HallucinationRoundRecord[]
  /** 核验轮里发出的质询与模型答复 */
  corrections: HallucinationCorrection[]
  /** 全场幻觉治理汇总（含轨迹判定），讨论结束时才产出 */
  hallucination: HallucinationReport | null
  /** 最近一次收敛判定说明：为什么收敛 / 为什么还没 */
  convergenceNote: { round: number; converged: boolean; text: string } | null
  /** 因时长预算触顶收束 */
  timeLimited: boolean
  paused: boolean
  stalledNotice: boolean

  // 报告
  reportReady: boolean
  sessionId: string | null
  /** 报告正文（主进程 Report 结构，这里按 unknown 透传给视图层归一化） */
  report: unknown
  reportOpen: boolean
  /** 正在用当前渲染逻辑重算报告 */
  reportRegenerating: boolean
  /** 重算结果提示（成功/失败），几秒后自动清除 */
  reportRegenNote: string | null

  // 人工介入
  interventions: UiIntervention[]
  stanceOverrides: Record<string, string>
  duelActive: { topic: string; agentIds: string[] } | null
  pendingFollowup: PendingAction | null

  // 风险墙
  riskNotice: string | null

  // actions
  setModels(m: ModelSummary[]): void
  patchConfig(p: Partial<TorraState>): void
  toggleParticipant(id: string): void
  reset(): void
  hydrateFromRecord(rec: SessionRecord): void
  applyEvent(e: OrchestratorEventPayload): void
  setViewMode(m: ViewMode, target?: string): void
  setChatWebview(id: string | null): void
  toggleChatWebview(id: string): void
  dismissStall(): void
  setRiskNotice(msg: string | null): void
  setReport(sessionId: string, report: unknown): void
  setReportOpen(open: boolean): void
  regenerateReport(): Promise<void>
  addIntervention(i: UiIntervention): void
  setStanceOverride(agentId: string, stance: string): void
  setDuelActive(d: { topic: string; agentIds: string[] } | null): void
  setPendingFollowup(f: PendingAction | null): void
}

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
  /** 网站域名，用于获取 favicon */
  domain?: string
  /** 是否为用户自建模型（决定 UI 是否提供删除入口） */
  userDefined?: boolean
  adapterLastError?: string
  /** 登录态判定结论，如「页面被重定向到登录页」，供悬停展示 */
  loginNote?: string
  loginState?: 'logged-in' | 'logged-out' | 'unknown'
  /** 最早到期的认证 cookie（epoch ms）。它是提示，界面须连着 credExpiresCookie 一起说 */
  credExpiresAt?: number
  /** credExpiresAt 来自哪条认证 cookie */
  credExpiresCookie?: string
  /** 有认证 cookie 但站点没给到期时间（会话级） */
  credSessionOnly?: boolean
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

/** 登录态 / Cookie 诊断结果（与主进程 login:diagnose 对齐，不含任何 cookie 值） */
export interface LoginDiagnosis {
  ok: boolean
  reason?: string
  partition: string
  declaredPartition: string
  partitionMismatch: boolean
  cookieTotal: number
  authCookies: string[]
  /**
   * 认证 cookie 的有效期明细（名称/域/exp；exp 为 epoch 毫秒，0 表示会话级）。
   * 只给名字和时间，永远不含 cookie 值。
   */
  credCookies?: Array<{ name: string; domain: string; exp: number }>
  /** 最早到期的那条：epoch 毫秒；无带到期时间的认证 cookie 时为空 */
  credExpiresAt?: number
  credExpiresCookie?: string
  credSessionOnly?: boolean
  storage: { localKeys: string[]; sessionKeys: string[] } | null
  probeOk: boolean
  loginState: 'logged-in' | 'logged-out' | 'unknown'
  pageUrl: string
  evidence: {
    onLoginPage: boolean
    hasUserFlag: boolean
    hasLoginCta: boolean
    allLocalKeys: string[]
  } | null
  verdict: string
}

export type OrchestratorEventPayload =
  | { type: 'state'; state: OrchestratorState; round: number }
  | { type: 'round-start'; round: number; total: number }
  | { type: 'utterance-delta'; utteranceId: string; agentId: string; chunk: string }
  | { type: 'thinking-delta'; utteranceId: string; agentId: string; chunk: string }
  | { type: 'steps-delta'; utteranceId: string; agentId: string; chunk: string }
  | { type: 'utterance-done'; utterance: UtterancePayload }
  | { type: 'absent'; utterance: UtterancePayload }
  | { type: 'moderator'; digest: unknown; score: ScorePoint; open: OpenDispute[] }
  | { type: 'moderator-rejected'; errors: string[]; attempt: number }
  | { type: 'moderator-audit'; audit: ModeratorAuditEntry }
  | { type: 'stage-complete'; round: number; stage: DiscussionStage; durationMs: number; summary: string }
  | { type: 'converged'; score: number; round: number }
  /**
   * 收敛判定的过程说明。
   *
   * 只有 converged/none 是不够的：用户要看见「为什么这轮没收敛」——
   * 分数没到、还是分歧未清、还是轮次门槛。缺了它，收敛开关看起来像黑箱。
   */
  | { type: 'convergence'; round: number; converged: boolean; path: 'score' | 'structural' | 'none'; reason: string }
  | { type: 'time-limited'; elapsedMs: number; budgetMs: number }
  | { type: 'baseline'; baseline: BaselineResult }
  | { type: 'baseline-compare'; compare: BaselineComparison }
  | { type: 'hallucination-round'; record: HallucinationRoundRecord }
  | { type: 'verification'; correction: HallucinationCorrection }
  | { type: 'hallucination'; report: HallucinationReport }
  | { type: 'stalled'; score: number; round: number }
  | { type: 'budget-limited'; spentUsd: number }
  | { type: 'paused'; reason: string }
  | { type: 'intervention'; intervention: InterventionPayload }
  | { type: 'stance-changed'; agentId: string; before: string; after: string; effectiveRound: number }
  | { type: 'duel-start'; duel: { topic: string; agentIds: string[] } }
  | { type: 'duel-done'; duelId: string }
  | { type: 'done'; reason: string }
  | { type: 'error'; message: string }

/** 点发言卡上的「追问 / 对辩」后，干预条要自动就位的动作 */
export type PendingAction = { agentId: string; utteranceId: string; topic: string; kind: 'followup' | 'duel' }

export interface UtterancePayload {
  id: string
  round: number
  agentId: string
  content: string
  targets: string[]
  absent?: boolean
  absentReason?: string
  stance?: StanceMark
  human?: boolean
  usage?: TokenUsage
  input?: UtteranceInput
  thinking?: string
  steps?: string
  /** 本轮的非致命异常（如附件未送达），卡片角标用 */
  note?: string
  /** 程序对本条发言的引用核验：不存在的发言 id / 越界轮次 / 未知别名 */
  citations?: CitationAudit
  startedAt?: number
  endedAt?: number
}

export interface InterventionPayload {
  id: string
  kind: UiIntervention['kind']
  text: string
  atRound: number
  deliveredRound?: number
  status: UiIntervention['status']
  targetAgentIds?: string[]
  targetAgentId?: string
  duelAgentIds?: string[]
  topic?: string
  stanceAgentId?: string
  stanceBefore?: string
  stanceAfter?: string
  note?: string
}

const initial = {
  models: [] as ModelSummary[],
  topicTitle: '',
  topicBackground: '',
  strategy: 'roundtable' as StrategyKind,
  participantIds: [] as string[],
  moderatorId: null as string | null,
  maxRounds: 3,
  consensusThreshold: 85,
  budgetLimitUsd: 2,
  anonymousReview: false,
  baseline: true,
  baselineCompare: true,
  verifyPass: VERIFY_PASS_DEFAULT as VerifyPassMode,
  timeBudgetMin: Math.round(TIME_BUDGET_DEFAULT_MS / 60_000),
  state: 'INIT' as OrchestratorState,
  finishedReason: null as string | null,
  round: 0,
  viewMode: 'hall' as ViewMode,
  broadcastTarget: null as string | null,
  chatWebviewTarget: null as string | null,
  utterances: [] as UiUtterance[],
  consensus: [] as UiConsensus[],
  disputes: [] as UiDispute[],
  scores: [] as ScorePoint[],
  spentUsd: 0,
  budgetLimited: false,
  moderatorUnavailable: false,
  moderatorNote: null as string | null,
  moderatorAudit: [] as ModeratorAuditEntry[],
  stageTimings: [] as StageTiming[],
  baselineResult: null as BaselineResult | null,
  baselineCompareResult: null as BaselineComparison | null,
  hallucinationRounds: [] as HallucinationRoundRecord[],
  corrections: [] as HallucinationCorrection[],
  hallucination: null as HallucinationReport | null,
  convergenceNote: null as { round: number; converged: boolean; text: string } | null,
  timeLimited: false,
  paused: false,
  stalledNotice: false,
  reportReady: false,
  report: null as unknown,
  reportOpen: false,
  reportRegenerating: false,
  reportRegenNote: null as string | null,
  sessionId: null as string | null,
  riskNotice: null as string | null,
  interventions: [] as UiIntervention[],
  stanceOverrides: {} as Record<string, string>,
  duelActive: null as { topic: string; agentIds: string[] } | null,
  pendingFollowup: null as PendingAction | null,
}

export const useStore = create<TorraState>((set) => ({
  ...initial,

  setModels: (m) =>
    set((s) => {
      // 已有显式选择时保持不变（包括从持久化恢复后）
      if (s.participantIds.length > 0) {
        return { models: m }
      }
      // 首次加载：默认名单优先 API 通道并带数量上限 —— 网页模型一轮几十秒，
      // 全量勾选会让第一次开场的人直接进了一场十分钟的讨论（见 shared/participants）
      const healthy = usableModels(m)
      const defaultModerator =
        s.moderatorId ?? (healthy.find((x) => x.transport === 'api' && x.supportsStructuredOutput)?.id ?? null)
      return {
        models: m,
        participantIds: pickDefaultParticipants(m, defaultModerator),
        moderatorId: defaultModerator,
      }
    }),

  patchConfig: (p) => set(p as Partial<TorraState>),

  toggleParticipant: (id) =>
    set((s) => ({
      participantIds: s.participantIds.includes(id)
        ? s.participantIds.filter((x) => x !== id)
        : [...s.participantIds, id],
    })),

  // 显式返回类型：内部引用 useStore.getState() 会形成自引用，
  // 无标注时 TS 无法推断 useStore 类型，进而把整个 store 退化为 any。
  reset: (): void => set({ ...initial, models: useStore.getState().models }),

  /**
   * 回放：把一条已结束的历史会话灌进运行态，让议事厅按当时的样子重现。
   *
   * 与实时编排的区别：这里没有 orchestrator 推事件，所以一次性把 utterances /
   * consensus / disputes / scores 全部落到 store，并把 state 设为已结束态 ——
   * DiscussionFlow 见 state 非运行中，就不会显示「进行中」的状态条与流式光标。
   * models 保留当前值（决定头像/配色/域名），否则回放里所有发言都会退化成首字母。
   */
  hydrateFromRecord: (rec): void => {
    const maxRound = rec.utterances.reduce((m, u) => Math.max(m, u.round), 0)
    set({
      ...initial,
      models: useStore.getState().models,
      topicTitle: rec.topic.title,
      topicBackground: rec.topic.background,
      strategy: rec.topic.strategy,
      participantIds: [...rec.config.participantIds],
      moderatorId: rec.config.moderatorId,
      maxRounds: rec.config.maxRounds,
      consensusThreshold: rec.config.consensusThreshold,
      budgetLimitUsd: rec.config.budgetLimitUsd,
      anonymousReview: !!rec.config.anonymousReview,
      baseline: rec.config.baseline !== false,
      baselineCompare: rec.config.baselineCompare !== false,
      verifyPass: rec.config.verifyPass ?? VERIFY_PASS_DEFAULT,
      timeBudgetMin: Math.round((rec.config.timeBudgetMs ?? TIME_BUDGET_DEFAULT_MS) / 60_000),
      state: (rec.state ?? 'DONE') as OrchestratorState,
      finishedReason: rec.finishedReason ?? null,
      round: maxRound,
      spentUsd: rec.totalCostUsd,
      sessionId: rec.id,
      report: rec.report ?? null,
      reportReady: !!rec.report,
      utterances: rec.utterances.map((u) => ({
        id: u.id,
        round: u.round,
        agentId: u.agentId,
        content: u.content,
        streaming: false,
        absent: !!u.absent,
        absentReason: u.absentReason,
        targets: u.targets,
        stance: u.stance,
        human: u.human,
        usage: u.usage,
        input: u.input,
        thinking: u.thinking,
        steps: u.steps,
        note: u.note,
        startedAt: u.startedAt,
        endedAt: u.endedAt,
      })),
      consensus: rec.confirmed.map((c) => ({ ...c })),
      disputes: rec.open.map((d) => ({ ...d })),
      scores: rec.scores.map((s) => ({
        round: s.round,
        score: s.score.score,
        agreement: s.score.agreement,
        overlap: s.score.overlap,
        trend: s.score.trend,
      })),
      interventions: rec.interventions.map((iv) => ({
        id: iv.id,
        kind: iv.kind,
        text: iv.text,
        atRound: iv.atRound,
        deliveredRound: iv.deliveredRound,
        status: iv.status,
        targetAgentIds: iv.targetAgentIds ?? [],
        targetAgentId: iv.targetAgentId,
        duelAgentIds: iv.duelAgentIds,
        topic: iv.topic,
        stanceAgentId: iv.stanceAgentId,
        stanceBefore: iv.stanceBefore,
        stanceAfter: iv.stanceAfter,
        note: iv.note,
      })),
      moderatorAudit: [...(rec.moderatorAudit ?? [])],
      stageTimings: [...(rec.stageTimings ?? [])],
      // 基线与幻觉账本都是一次真实调用的产物，只能从存档读回；报告里的那份是同源副本
      baselineResult: rec.baseline ?? rec.report?.baseline ?? null,
      baselineCompareResult: rec.baselineCompare ?? rec.report?.baselineCompare ?? null,
      hallucination: rec.hallucination ?? rec.report?.hallucination ?? null,
      hallucinationRounds: rec.hallucination?.rounds ?? rec.report?.hallucination?.rounds ?? [],
      corrections: rec.hallucination?.corrections ?? rec.report?.hallucination?.corrections ?? [],
      timeLimited: rec.timeLimited ?? rec.report?.meta?.timeLimited ?? false,
    })
  },

  applyEvent: (e) =>
    set((s) => {
      switch (e.type) {
        case 'state':
          return { state: e.state, round: e.round, paused: e.state === 'PAUSE_FOR_USER' }
        case 'round-start':
          return { round: e.round }
        case 'utterance-delta': {
          const idx = s.utterances.findIndex((u) => u.id === e.utteranceId)
          if (idx < 0) {
            return {
              utterances: [
                ...s.utterances,
                {
                  id: e.utteranceId,
                  round: s.round,
                  agentId: e.agentId,
                  content: e.chunk,
                  streaming: true,
                  absent: false,
                  targets: [],
                },
              ],
            }
          }
          const next = [...s.utterances]
          const u = next[idx]!
          next[idx] = { ...u, content: u.content + e.chunk }
          return { utterances: next }
        }
        case 'thinking-delta': {
          // 推理模型常先流思考、后流正文，故本轮 utterance 可能尚未创建
          const idx = s.utterances.findIndex((u) => u.id === e.utteranceId)
          if (idx < 0) {
            return {
              utterances: [
                ...s.utterances,
                {
                  id: e.utteranceId,
                  round: s.round,
                  agentId: e.agentId,
                  content: '',
                  thinking: e.chunk,
                  streaming: true,
                  absent: false,
                  targets: [],
                },
              ],
            }
          }
          const next = [...s.utterances]
          const u = next[idx]!
          next[idx] = { ...u, thinking: (u.thinking ?? '') + e.chunk }
          return { utterances: next }
        }
        case 'steps-delta': {
          // 与 thinking-delta 同理：agent 站常先流步骤、后流正文，utterance 可能尚未创建
          const idx = s.utterances.findIndex((u) => u.id === e.utteranceId)
          if (idx < 0) {
            return {
              utterances: [
                ...s.utterances,
                {
                  id: e.utteranceId,
                  round: s.round,
                  agentId: e.agentId,
                  content: '',
                  steps: e.chunk,
                  streaming: true,
                  absent: false,
                  targets: [],
                },
              ],
            }
          }
          const next = [...s.utterances]
          const u = next[idx]!
          next[idx] = { ...u, steps: (u.steps ?? '') + e.chunk }
          return { utterances: next }
        }
        case 'utterance-done':
          return {
            utterances: [
              ...s.utterances.filter((u) => u.id !== e.utterance.id),
              {
                id: e.utterance.id,
                round: e.utterance.round,
                agentId: e.utterance.agentId,
                content: e.utterance.content,
                streaming: false,
                absent: false,
                targets: e.utterance.targets,
                stance: e.utterance.stance,
                human: e.utterance.human,
                usage: e.utterance.usage,
                input: e.utterance.input,
                // done 未必再带全文（网页通道会把思考折叠成摘要）：缺失时保留已流出的
                thinking:
                  e.utterance.thinking ?? s.utterances.find((u) => u.id === e.utterance.id)?.thinking,
                steps: e.utterance.steps ?? s.utterances.find((u) => u.id === e.utterance.id)?.steps,
                note: e.utterance.note,
                citations: e.utterance.citations,
                startedAt: e.utterance.startedAt,
                endedAt: e.utterance.endedAt,
              },
            ],
            spentUsd: s.spentUsd + (e.utterance.usage?.costUsd ?? 0),
          }
        case 'absent':
          return {
            utterances: [
              ...s.utterances,
              {
                id: e.utterance.id,
                round: e.utterance.round,
                agentId: e.utterance.agentId,
                content: e.utterance.content,
                streaming: false,
                absent: true,
                absentReason: e.utterance.absentReason,
                targets: [],
              },
            ],
          }
        case 'moderator': {
          const d = e.digest as {
            consensus_points: Array<{ claim: string; support: string[]; confidence: number; evidence_ref: string[]; weight?: number }>
            open_disputes: Array<{ claim: string; sides: Array<{ agent_id: string; argument: string }> }>
          }
          const incomingPoints: UiConsensus[] = d.consensus_points.map((p, i) => {
            const prior = s.consensus.find((c) => c.claim === p.claim)
            return {
              id: prior?.id ?? `cp_${s.round}_${i}`,
              claim: p.claim,
              support: p.support,
              confidence: p.confidence,
              evidenceRef: p.evidence_ref,
              weight: typeof p.weight === 'number' ? p.weight : undefined,
              confirmedRound: prior?.confirmedRound ?? s.round,
              // 核验结果只由核验轮写入，主持的下一轮小结并不带它 —— 不接住就会被抹掉，
              // 用户会看到「已撤回」的共识重新变成未核验，等于治理白做。
              verification: prior?.verification,
            }
          })
          const pointByClaim = new Map(s.consensus.map((p) => [p.claim, p]))
          for (const p of incomingPoints) pointByClaim.set(p.claim, p)

          // The main process sends the merged lifecycle, including resolved
          // disputes, so the UI does not retain stale open items.
          const incomingDisputes: UiDispute[] = e.open.map((x) => ({
            ...x,
            sides: x.sides.map((sd) => ({ ...sd })),
          }))
          const disputeById = new Map(s.disputes.map((d) => [d.id, d]))
          for (const d of incomingDisputes) disputeById.set(d.id, d)

          return {
            consensus: [...pointByClaim.values()],
            disputes: [...disputeById.values()],
            scores: [...s.scores, e.score],
            moderatorNote: null,
          }
        }
        case 'moderator-rejected':
          return {
            moderatorNote: `第 ${e.attempt} 次小结被程序校验拒绝：${e.errors.slice(0, 2).join('；')}`,
          }
        case 'moderator-audit':
          /**
           * 一轮一条：重跑同一轮时按轮次覆盖，否则审计区会堆出重复轮次。
           * 一场讨论也就几条，直接替换比按时间戳排序更好读。
           */
          return {
            moderatorAudit: [...s.moderatorAudit.filter((a) => a.round !== e.audit.round), e.audit],
          }
        case 'stage-complete':
          return {
            stageTimings: [
              ...s.stageTimings,
              {
                round: e.round,
                stage: e.stage,
                startedAt: Date.now() - e.durationMs,
                durationMs: e.durationMs,
                summary: e.summary,
              },
            ],
          }
        case 'converged':
          return { moderatorNote: `已达共识阈值 ${e.score}，正在生成报告…` }
        case 'stalled':
          return { stalledNotice: true }
        case 'budget-limited':
          return { budgetLimited: true, spentUsd: e.spentUsd }
        case 'time-limited':
          /**
           * 时长触顶与金额触顶分开记：网页通道 costUsd 恒为 0，
           * 只报 budgetLimited 的话，用户会以为这场「免费跑完」，其实是墙钟闸门关掉的后半程。
           */
          return {
            timeLimited: true,
            moderatorNote: `已达时长预算 ${Math.round(e.budgetMs / 60000)} 分钟（用时 ${Math.round(e.elapsedMs / 1000)} 秒），提前收束并生成报告。`,
          }
        case 'convergence':
          return {
            convergenceNote: { round: e.round, converged: e.converged, text: e.reason },
          }
        case 'baseline':
          return { baselineResult: e.baseline }
        case 'baseline-compare':
          return { baselineCompareResult: e.compare }
        case 'hallucination-round':
          return {
            hallucinationRounds: [
              ...s.hallucinationRounds.filter((r) => r.round !== e.record.round),
              e.record,
            ],
          }
        case 'hallucination':
          return { hallucination: e.report }
        case 'verification': {
          /**
           * 核验结算与主进程同源同判：denied 移出支持者、confirmed/clarified 补证据，
           * 支持清空即 vacated。渲染端不重算就只能显示「已质询」，看不出结论被改了。
           */
          const c = e.correction
          return {
            corrections: [...s.corrections.filter((x) => x.id !== c.id), c],
            consensus: s.consensus.map((p) => {
              if (p.id !== c.pointId) return p
              const support = c.outcome === 'denied' ? p.support.filter((a) => !c.removedSupport.includes(a)) : p.support
              const confirmedBy = new Set(p.verification?.confirmedBy ?? [])
              const removed = new Set(p.verification?.removed ?? [])
              if (c.outcome === 'confirmed') confirmedBy.add(c.agentId)
              if (c.outcome === 'clarified') confirmedBy.delete(c.agentId)
              for (const a of c.removedSupport) removed.add(a)
              return {
                ...p,
                support,
                evidenceRef: [...new Set([...p.evidenceRef, ...c.addedEvidenceRef])],
                verification: {
                  status: support.length === 0 ? 'vacated' : c.outcome === 'denied' ? 'disputed' : 'verified',
                  checkedRound: p.verification?.checkedRound ?? c.round,
                  attributed: p.verification?.attributed ?? (c.issue === 'attributed_endorsement' ? [c.agentId] : []),
                  confirmedBy: [...confirmedBy],
                  removed: [...removed],
                },
              }
            }),
          }
        }
        case 'paused':
          return { paused: true, moderatorNote: e.reason }
        case 'intervention':
          return {
            interventions: [
              ...s.interventions.filter((i) => i.id !== e.intervention.id),
              {
                id: e.intervention.id,
                kind: e.intervention.kind,
                text: e.intervention.text,
                atRound: e.intervention.atRound,
                deliveredRound: e.intervention.deliveredRound,
                status: e.intervention.status,
                targetAgentIds: e.intervention.targetAgentIds ?? [],
                targetAgentId: e.intervention.targetAgentId,
                duelAgentIds: e.intervention.duelAgentIds,
                topic: e.intervention.topic,
                stanceAgentId: e.intervention.stanceAgentId,
                stanceBefore: e.intervention.stanceBefore,
                stanceAfter: e.intervention.stanceAfter,
                note: e.intervention.note,
              },
            ],
            moderatorNote: null,
          }
        case 'stance-changed':
          return {
            stanceOverrides: { ...s.stanceOverrides, [e.agentId]: e.after },
            moderatorNote: `${e.agentId} 立场已从「${e.before}」改为「${e.after}」，第 ${e.effectiveRound} 轮生效`,
          }
        case 'duel-start':
          return { duelActive: e.duel }
        case 'duel-done':
          return { duelActive: null }
        case 'done':
          /** 「正在生成报告…」必须在这里收掉：done 之后主进程才落盘，留着它会一直挂在流上 */
          return { state: 'DONE' as OrchestratorState, moderatorNote: null, finishedReason: e.reason }
        case 'error':
          return { moderatorNote: `错误：${e.message}` }
        default:
          return {}
      }
    }),

  setViewMode: (m, target) => set({ viewMode: m, broadcastTarget: target ?? null }),
  setChatWebview: (id) => set({ chatWebviewTarget: id }),
  toggleChatWebview: (id) =>
    set((s) => ({ chatWebviewTarget: s.chatWebviewTarget === id ? null : id })),
  dismissStall: () => set({ stalledNotice: false }),
  setRiskNotice: (msg) => set({ riskNotice: msg }),
  setReport: (sessionId, report) => set({ sessionId, report, reportReady: true }),
  /** 打开报告弹窗：正文可能不在渲染进程里（刷新过 / 回看历史），点开时按需补拉一次 */
  setReportOpen: (open) => {
    set({ reportOpen: open })
    const s = useStore.getState()
    if (open && !s.report && s.sessionId) {
      void window.torra.getReport(s.sessionId).then((r) => set({ report: r }))
    }
  },
  /**
   * 重新生成报告：让主进程用当前的报告渲染逻辑，就持久化的会话记录重算一遍。
   * 纯本地重算、不调模型，所以零成本、可反复；重算成功后就地更新弹窗内容。
   */
  regenerateReport: async () => {
    const s = useStore.getState()
    if (!s.sessionId || s.reportRegenerating) return
    set({ reportRegenerating: true, reportRegenNote: null })
    const clear = (note: string) => {
      set({ reportRegenNote: note })
      setTimeout(() => {
        if (useStore.getState().reportRegenNote === note) set({ reportRegenNote: null })
      }, 3200)
    }
    try {
      const r = await window.torra.regenerateReport(s.sessionId)
      if (r?.ok && r.report) {
        set({ report: r.report, reportReady: true })
        clear('报告已按当前格式重新生成')
      } else {
        clear(r?.reason ? `重新生成失败：${r.reason}` : '重新生成失败')
      }
    } catch (e) {
      clear(`重新生成失败：${(e as Error).message}`)
    } finally {
      set({ reportRegenerating: false })
    }
  },
  addIntervention: (i) => set((s) => ({ interventions: [i, ...s.interventions] })),
  setStanceOverride: (agentId, stance) =>
    set((s) => ({ stanceOverrides: { ...s.stanceOverrides, [agentId]: stance } })),
  setDuelActive: (d) => set({ duelActive: d }),
  setPendingFollowup: (f) => set({ pendingFollowup: f }),
}))

// 供运行时冒烟测试重放编排事件（scripts/smoke.js）。
// 生产构建不依赖它——仅在测试脚本主动读取时才有对象。
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__torraStore = useStore
}
