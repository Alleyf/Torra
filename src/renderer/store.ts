/**
 * 渲染层状态（Zustand）
 *
 * 对应 PRD 8.1 三区布局与 8.2 三种模式。
 */

import { create } from 'zustand'
import type {
  ConsensusPoint,
  OpenDispute,
  OrchestratorState,
  SessionRecord,
  StanceMark,
  StrategyKind,
  TokenUsage,
  UtteranceInput,
} from '@shared/types'

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

  // 运行态
  state: OrchestratorState
  round: number
  viewMode: ViewMode
  broadcastTarget: string | null
  utterances: UiUtterance[]
  consensus: UiConsensus[]
  disputes: UiDispute[]
  scores: ScorePoint[]
  spentUsd: number
  budgetLimited: boolean
  moderatorUnavailable: boolean
  moderatorNote: string | null
  paused: boolean
  stalledNotice: boolean

  // 报告
  reportReady: boolean
  sessionId: string | null

  // 人工介入
  interventions: UiIntervention[]
  stanceOverrides: Record<string, string>
  duelActive: { topic: string; agentIds: string[] } | null
  pendingFollowup: { agentId: string; utteranceId: string; topic: string } | null

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
  dismissStall(): void
  setRiskNotice(msg: string | null): void
  setReport(sessionId: string, report: unknown): void
  addIntervention(i: UiIntervention): void
  setStanceOverride(agentId: string, stance: string): void
  setDuelActive(d: { topic: string; agentIds: string[] } | null): void
  setPendingFollowup(f: { agentId: string; utteranceId: string; topic: string } | null): void
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
  | { type: 'thinking-delta'; utteranceId: string; agentId: string; chunk: string }
  | { type: 'utterance-done'; utterance: UtterancePayload }
  | { type: 'absent'; utterance: UtterancePayload }
  | { type: 'moderator'; digest: unknown; score: ScorePoint; open: OpenDispute[] }
  | { type: 'moderator-rejected'; errors: string[]; attempt: number }
  | { type: 'converged'; score: number; round: number }
  | { type: 'stalled'; score: number; round: number }
  | { type: 'budget-limited'; spentUsd: number }
  | { type: 'paused'; reason: string }
  | { type: 'intervention'; intervention: InterventionPayload }
  | { type: 'stance-changed'; agentId: string; before: string; after: string; effectiveRound: number }
  | { type: 'duel-start'; duel: { topic: string; agentIds: string[] } }
  | { type: 'duel-done'; duelId: string }
  | { type: 'done'; reason: string }
  | { type: 'error'; message: string }

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
  state: 'INIT' as OrchestratorState,
  round: 0,
  viewMode: 'hall' as ViewMode,
  broadcastTarget: null as string | null,
  utterances: [] as UiUtterance[],
  consensus: [] as UiConsensus[],
  disputes: [] as UiDispute[],
  scores: [] as ScorePoint[],
  spentUsd: 0,
  budgetLimited: false,
  moderatorUnavailable: false,
  moderatorNote: null as string | null,
  paused: false,
  stalledNotice: false,
  reportReady: false,
  sessionId: null as string | null,
  riskNotice: null as string | null,
  interventions: [] as UiIntervention[],
  stanceOverrides: {} as Record<string, string>,
  duelActive: null as { topic: string; agentIds: string[] } | null,
  pendingFollowup: null as { agentId: string; utteranceId: string; topic: string } | null,
}

export const useStore = create<TorraState>((set) => ({
  ...initial,

  setModels: (m) =>
    set((s) => {
      // 已有显式选择时保持不变（包括从持久化恢复后）
      if (s.participantIds.length > 0) {
        return { models: m }
      }
      // 首次加载：按健康状态默认 —— API 模型需有 Key，网页模型需已登录
      const healthy = m.filter((x) =>
        x.transport === 'api' ? x.hasKey : x.status === 'ready',
      )
      const defaultModerator =
        s.moderatorId ?? (healthy.find((x) => x.transport === 'api' && x.supportsStructuredOutput)?.id ?? null)
      return {
        models: m,
        participantIds: healthy.filter((x) => x.id !== defaultModerator).map((x) => x.id),
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
      state: (rec.state ?? 'DONE') as OrchestratorState,
      round: maxRound,
      spentUsd: rec.totalCostUsd,
      sessionId: rec.id,
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
                thinking: e.utterance.thinking,
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
            consensus_points: Array<{ claim: string; support: string[]; confidence: number; evidence_ref: string[] }>
            open_disputes: Array<{ claim: string; sides: Array<{ agent_id: string; argument: string }> }>
          }
          const incomingPoints: UiConsensus[] = d.consensus_points.map((p, i) => ({
            id: s.consensus.find((c) => c.claim === p.claim)?.id ?? `cp_${s.round}_${i}`,
            claim: p.claim,
            support: p.support,
            confidence: p.confidence,
            evidenceRef: p.evidence_ref,
            confirmedRound: s.consensus.find((c) => c.claim === p.claim)?.confirmedRound ?? s.round,
          }))
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
        case 'converged':
          return { moderatorNote: `已达共识阈值 ${e.score}，正在生成报告…` }
        case 'stalled':
          return { stalledNotice: true }
        case 'budget-limited':
          return { budgetLimited: true, spentUsd: e.spentUsd }
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
          return { state: 'DONE' as OrchestratorState }
        case 'error':
          return { moderatorNote: `错误：${e.message}` }
        default:
          return {}
      }
    }),

  setViewMode: (m, target) => set({ viewMode: m, broadcastTarget: target ?? null }),
  dismissStall: () => set({ stalledNotice: false }),
  setRiskNotice: (msg) => set({ riskNotice: msg }),
  setReport: (sessionId) => set({ sessionId, reportReady: true }),
  addIntervention: (i) => set((s) => ({ interventions: [i, ...s.interventions] })),
  setStanceOverride: (agentId, stance) =>
    set((s) => ({ stanceOverrides: { ...s.stanceOverrides, [agentId]: stance } })),
  setDuelActive: (d) => set({ duelActive: d }),
  setPendingFollowup: (f) => set({ pendingFollowup: f }),
}))

// 供运行时冒烟测试重放编排事件（scripts/smoke.js）。
// 生产构建不依赖它——仅在测试脚本主动读取时才有对象。
if (typeof window !== 'undefine