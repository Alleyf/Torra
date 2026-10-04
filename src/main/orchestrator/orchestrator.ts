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
  computeAgreement,
  computeOverlap,
  computeTrend,
  makeId,
  mergeOpenDisputes,
  nowMs,
  openOnly,
  validateModeratorDigest,
  weightedScore,
} from '../../shared/invariants'
import {
  createIntervention,
  deliverInterventions,
  humanUtterance,
  modelUtterancesOnly,
  renderInterventions,
} from '../../shared/interventions'
import { renderPriorConclusion, type RetryMode, type RetrySource } from '../../shared/retry'
import type {
  AgentStatus,
  Callout,
  ConsensusPoint,
  ConsensusScore,
  DuelRound,
  Intervention,
  ModeratorDigest,
  OpenDispute,
  OrchestratorState,
  SessionConfig,
  StanceMark,
  TokenUsage,
  Topic,
  TurnContext,
  Utterance,
} from '../../shared/types'
import { AgentError, absentText, type Agent, type AbsentReason } from '../agents/agent'

/** 编排引擎向 UI 推送的事件 */
export type OrchestratorEvent =
  | { type: 'state'; state: OrchestratorState; round: number }
  | { type: 'round-start'; round: number; total: number }
  | { type: 'utterance-delta'; utteranceId: string; agentId: string; chunk: string }
  | { type: 'thinking-delta'; utteranceId: string; agentId: string; chunk: string }
  | { type: 'utterance-done'; utterance: Utterance }
  | { type: 'absent'; utterance: Utterance }
  | { type: 'moderator'; digest: ModeratorDigest; score: ConsensusScore; open: OpenDispute[] }
  | { type: 'moderator-rejected'; errors: string[]; attempt: number }
  | { type: 'converged'; score: number; round: number }
  | { type: 'stalled'; score: number; round: number }
  | { type: 'budget-limited'; spentUsd: number }
  | { type: 'paused'; reason: string }
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

  constructor(
    private readonly topic: Topic,
    private readonly config: SessionConfig,
    private readonly deps: OrchestratorDeps,
  ) {
    super()
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
        this.priorConclusion = renderPriorConclusion(source)
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
    this.pendingCallout = {
      targetAgent: targetAgentId,
      quoteFromAgent: this.utterances.find((u) => u.id === targetUtteranceId)?.agentId ?? '',
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

  requestAbort(): void {
    this.aborted = true
  }

  requestPause(reason: string): void {
    this.paused = true
    this.setState('PAUSE_FOR_USER')
    this.emit('event', { type: 'paused', reason } satisfies OrchestratorEvent)
  }

  resume(): void {
    this.paused = false
  }

  private setState(s: OrchestratorState): void {
    this.state = s
    this.emit('event', { type: 'state', state: s, round: this.round } satisfies OrchestratorEvent)
  }

  /**
   * 统一收尾：先排空待执行的专项对辩，再进入报告生成并发出 done。
   * 顺序很重要 —— 对辩发言必须进入报告，done 必须最后发。
   */
  private async finish(reason: 'converged' | 'max-rounds' | 'aborted' | 'no-moderator' | 'failed'): Promise<void> {
    await this.drainPendingDuels()
    this.setState('REPORT_GEN')
    this.emit('event', { type: 'done', reason } satisfies OrchestratorEvent)
  }

  /** 主执行流 */
  async run(): Promise<void> {
    try {
      this.setState('LOGIN_CHECK')
      this.setState('READY')

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

        // 无主持降级：跑满轮次直接出报告（PRD 6.2）
        if (!ok) {
          this.moderatorUnavailable = true
          await this.finish('no-moderator')
          return
        }

        // ---- 收敛判定 ----
        this.setState('CONSENSUS_EVAL')
        const last = this.scores[this.scores.length - 1]
        if (last && last.score.score >= this.config.consensusThreshold) {
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
    const digest = this.buildDigest()

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
        return this.absent(agentId, 'not-started', startedAt, '已达预算上限，本轮未发言')
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
        )
        this.spentUsd += res.usage.costUsd
        const u: Utterance = {
          id,
          round: this.round,
          agentId,
          content: res.content || acc,
          targets: res.targets,
          usage: res.usage,
          input: res.input,
          thinking: res.thinking,
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

    const digest = this.buildDigest()
    const startedAt = nowMs()

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

      const ctx: TurnContext = {
        sessionId: this.topic.id,
        round: duel.parentRound,
        topic: this.topic,
        digest,
        callout: {
          targetAgent: agentId,
          quoteFromAgent: opponentId ?? agentId,
          quote: `就「${duel.topic}」与 ${opponentId ?? '在场模型'} 直接对辩`,
          instruction: `人类参与者要求你就「${duel.topic}」与对方直接对辩，不要重复此前已说过的论点。`,
        },
        maxLenChars: 400,
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
        )
        this.spentUsd += res.usage.costUsd
        const u: Utterance = {
          id,
          round: duel.parentRound,
          agentId,
          content: res.content || acc,
          targets: opponentId ? [opponentId] : [],
          usage: res.usage,
          input: res.input,
          thinking: res.thinking,
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
   */
  private async runModerator(): Promise<boolean> {
    const moderator = this.deps.getModerator()
    if (!moderator) return false

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt === 2) this.setState('MODERATOR_RETRY')

        const raw = await moderator.send({
          system: this.moderatorSystemPrompt(),
          user: this.moderatorUserPrompt(),
        })
        this.spentUsd += raw.usage.costUsd

        const parsed = this.parseModeratorJson(raw.content)
        if (!parsed) {
          this.emit('event', {
            type: 'moderator-rejected',
            errors: ['主持输出不是合法 JSON'],
            attempt,
          } satisfies OrchestratorEvent)
          continue
        }

        const realUtteranceIds = new Set(
          this.utterances.filter((u) => !u.absent && u.round === this.round).map((u) => u.id),
        )
        const allUtteranceIds = new Set(this.utterances.map((u) => u.id))
        const realAgentIds = new Set(this.config.participantIds)

        const v = validateModeratorDigest(
          parsed,
          allUtteranceIds,
          new Set([...realAgentIds, moderator.id]),
        )
        // 本轮新发言必须真实存在
        if (parsed.consensus_points?.some((p) => p.evidence_ref?.some((r) => !realUtteranceIds.has(r)))) {
          v.ok = false
          v.errors.push('存在共识点引用了本轮未发生的发言')
        }

        if (!v.ok) {
          this.emit('event', {
            type: 'moderator-rejected',
            errors: v.errors,
            attempt,
          } satisfies OrchestratorEvent)
          continue
        }

        this.applyModeratorDigest(parsed)
        return true
      } catch (e) {
        this.emit('event', {
          type: 'moderator-rejected',
          errors: [(e as Error).message],
          attempt,
        } satisfies OrchestratorEvent)
      }
    }

    // 两次都失败 → 暂停交还用户（PRD 6.2）
    this.requestPause('主持模型小结失败，请更换主持或切换无主持降级模式')
    return false
  }

  /** 校验通过后落库：共识、分歧、三维度分数 */
  private applyModeratorDigest(d: ModeratorDigest): void {
    // 规则 2：共识度核算只看模型发言，排除人类发言与缺席
    const roundUtterances = modelUtterancesOnly(
      this.utterances.filter((u) => u.round === this.round),
    )

    // 共识点：support 与 evidence_ref 必须来自真实发言
    for (const p of d.consensus_points) {
      if (this.confirmed.some((c) => c.claim === p.claim)) continue
      this.confirmed.push({
        id: makeId('cp'),
        claim: p.claim,
        support: p.support,
        confidence: p.confidence,
        evidenceRef: p.evidence_ref,
        confirmedRound: this.round,
      })
    }

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

    // 三维度：agreement 与 trend 由程序核算，overlap 采用主持列举 + 程序校验
    const agreement = computeAgreement(roundUtterances)
    const trend = computeTrend(openOnly(this.open).length, this.lastOpenCount)
    const newPoints = d.consensus_points.map((p) => ({
      id: makeId('tmp'),
      claim: p.claim,
      support: p.support,
      confidence: p.confidence,
      evidenceRef: p.evidence_ref,
      confirmedRound: this.round,
    }))
    const overlap = Math.max(computeOverlap(newPoints), d.score_dimensions.overlap)

    const score = weightedScore({ agreement, overlap, trend })
    this.scores.push({ round: this.round, score })

    // 收敛趋势：记录上一轮未决数
    this.lastOpenCount = openOnly(this.open).length

    // 连续不升检测
    const prev = this.scores[this.scores.length - 2]
    if (prev && score.score <= prev.score.score) {
      this.noProgressRounds += 1
    } else {
      this.noProgressRounds = 0
    }

    this.emit('event', { type: 'moderator', digest: d, score, open: [...this.open] } satisfies OrchestratorEvent)

    // 下一轮 callout
    if (d.callout) {
      const targetQuote = this.utterances.find(
        (u) => u.agentId === d.callout?.quote_from_agent && !u.absent,
      )
      this.pendingCallout = {
        targetAgent: d.callout.target_agent,
        quoteFromAgent: d.callout.quote_from_agent,
        quote: targetQuote?.content.slice(0, 200) ?? '',
        instruction: d.callout.instruction,
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

  private buildDigest() {
    return {
      confirmed: this.confirmed,
      open: this.open,
      explored: this.explored,
      rounds: [],
    }
  }

  private moderatorSystemPrompt(): string {
    return `你是本场多模型讨论的主持人。你的职责是如实记录共识与分歧，而非推动讨论看起来成功。

硬约束（违反将被程序拒绝）：
1. 每条 consensus_points 的 support 必须指向真实参与过的模型，evidence_ref 必须指向真实存在的发言；
2. 不得为了推进收敛而合并本质不同的观点；若分歧无法消解，保留在 open_disputes 中；
3. 必须按三维度分别给分（score_dimensions），不接受单一主观总分；
4. surface 附和不得加分：若模型只是换了措辞而未提供新论据，不应计入 agreement。

输出严格为 JSON，不要包裹任何解释文字。`
  }

  private moderatorUserPrompt(): string {
    const names = new Map<string, string>()
    for (const id of this.config.participantIds) {
      names.set(id, this.deps.getAgent(id)?.displayName ?? id)
    }

    const lines: string[] = []
    lines.push(`议题：${this.topic.title}`)
    if (this.topic.background) lines.push(`背景材料：${this.topic.background}`)
    lines.push(`当前第 ${this.round}/${this.config.maxRounds} 轮`)
    lines.push('')
    lines.push('参与模型：')
    for (const [id, name] of names) lines.push(`- ${id}（${name}）`)
    lines.push('')
    lines.push('本轮发言：')
    for (const u of this.utterances.filter((x) => x.round === this.round && !x.absent)) {
      lines.push(`- [${u.id}] ${names.get(u.agentId) ?? u.agentId}：${u.content}`)
    }
    const absentList = this.utterances.filter((x) => x.round === this.round && x.absent)
    if (absentList.length > 0) {
      lines.push('')
      lines.push('本轮缺席（不得据此推断立场）：')
      for (const u of absentList) {
        lines.push(`- ${names.get(u.agentId) ?? u.agentId}：${u.absentReason}`)
      }
    }

    if (this.open.length > 0) {
      lines.push('')
      lines.push('此前已登记且仍未消解的分歧：')
      for (const d of openOnly(this.open)) lines.push(`- ${d.claim}`)
    }

    if (this.humanRecords.length > 0) {
      lines.push('')
      lines.push('人类参与者介入（需在下一轮分发给相关模型，且不得据此抬高共识度）：')
      for (const h of this.humanRecords) lines.push(`- ${h}`)
    }

    lines.push('')
    lines.push('请输出如下结构的 JSON：')
    lines.push(`{
  "consensus_points": [{ "claim": "...", "support": ["agentId"], "confidence": 0.0-1.0, "evidence_ref": ["utteranceId"] }],
  "open_disputes": [{ "claim": "...", "sides": [{ "agent_id": "...", "argument": "..." }] }],
  "score_dimensions": { "agreement": 0-100, "overlap": 0-100, "trend": 0-100 },
  "score": 0-100,
  "next_round_order": ["agentId"],
  "callout": null | { "target_agent": "...", "quote_from_agent": "...", "instruction": "..." }
}`)

    return lines.join('\n')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
