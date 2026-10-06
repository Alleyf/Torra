/**
 * 报告生成（PRD 附录 C + 7.1 P0-7）
 *
 * 硬约束：禁止删除未决分歧以使报告显得一致；
 *         禁止把「无人反对」表述为「一致认同」。
 * 这两条是「假收敛」的最后一道出口 —— 前面机制失效时，这里是最后拦截点。
 */

import { aggregateLeaderboard, openOnly } from '../../shared/invariants'
import { provenanceSummary } from '../../shared/anonymity'
import { modelUtterancesOnly, summarizeInterventions } from '../../shared/interventions'
import { HUMAN_AGENT_ID } from '../../shared/types'
import type {
  ConsensusPoint,
  ConsensusReportItem,
  DisputeReportItem,
  DuelRound,
  Intervention,
  ModeratorAuditEntry,
  OpenDispute,
  Report,
  ReportEvidence,
  ReportFinishedReason,
  ReportMeta,
  ReportParticipation,
  ReportRoundRow,
  ReportStats,
  ReportVerdict,
  SessionConfig,
  StageTiming,
  Topic,
  TransportKind,
  Utterance,
  ConsensusScore,
  DiscussionStage,
  DisputeSide,
  BaselineResult,
  BaselineComparison,
  BaselineVerdict,
  HallucinationReport,
  HallucinationTrajectory,
  CorrectionOutcome,
  CorrectionIssue,
  ConsensusVerificationStatus,
  ReportDedup,
} from '../../shared/types'

export interface BuildReportInput {
  topic: Topic
  config: SessionConfig
  utterances: Utterance[]
  confirmed: ConsensusPoint[]
  open: OpenDispute[]
  explored: string[]
  scores: Array<{ round: number; score: ConsensusScore }>
  modelNames: Map<string, string>
  /** 模型 id → 通道；缺失时按 webview 记账 */
  modelTransports: Map<string, TransportKind>
  totalCostUsd: number
  durationMs: number
  budgetLimited: boolean
  moderatorUnavailable: boolean
  finishedReason: ReportFinishedReason
  /** 人工介入全记录（PRD 5.5） */
  interventions: Intervention[]
  /** 专项对辩轮 */
  duels: DuelRound[]
  /**
   * 主持小结审计。报告只从中聚合互评名次（aggregateLeaderboard），
   * 不重述校验过程 —— 那是 UI 的事，报告里放原始 JSON 只会淹没结论。
   */
  moderatorAudit?: ModeratorAuditEntry[]
  /** 截至报告生成时刻的粗粒度阶段耗时 */
  stageTimings?: StageTiming[]
  /** 单模型基线（第 0 轮独立作答）。未开启/没产出为 null：报告要显式说「无基线」 */
  baseline?: BaselineResult | null
  /** 研讨结论 vs 基线的结构化对照 */
  baselineCompare?: BaselineComparison | null
  /** 幻觉治理账本（含核验轮结果） */
  hallucination?: HallucinationReport | null
  /** 分通道调用台账：网页通道没有单价，金额之外的真实代价只在这里体现 */
  ledger?: { apiCalls: number; webCalls: number; moderatorCalls: number; totalMs: number }
  timeLimited?: boolean
  digestCompacted?: boolean
  /** 共识点归并统计（措辞不同、判断相同的条目被折成一条） */
  dedup?: ReportDedup
}

const REASON_LABEL: Record<BuildReportInput['finishedReason'], string> = {
  converged: '已达共识阈值',
  'max-rounds': '达到最大轮次',
  aborted: '用户终止',
  'no-moderator': '主持不可用（无主持降级模式）',
  failed: '异常终止（已保存部分结果）',
}

const STAGE_LABEL: Record<DiscussionStage, string> = {
  'agent-batch': '并行发言',
  moderator: '主持小结',
  consensus: '收敛判定',
  report: '报告生成',
  baseline: '单模型基线',
  verification: '幻觉核验轮',
}

const BASELINE_VERDICT_LABEL: Record<BaselineVerdict, string> = {
  council_better: '研讨结论优于基线（多出可核对的新要点）',
  baseline_better: '基线反而更好（研讨丢掉了基线已说清的要点）',
  mixed: '互有胜负（既有新增，也有丢失）',
  inconclusive: '无法判定（样本或证据不足）',
}

const TRAJECTORY_LABEL: Record<HallucinationTrajectory, string> = {
  self_correcting: '跨轮自我矫正：后半段错误信号低于前半段',
  flat: '跨轮持平：交叉质询没有明显压住，也没有恶化',
  compounding: '跨轮累积：后半段错误信号高于前半段，讨论在给自造内容加固',
  insufficient_data: '轮次不足，无法判定趋势',
}

const VERIFICATION_STATUS_LABEL: Record<ConsensusVerificationStatus, string> = {
  unverified: '未核验',
  verified: '本人确认',
  disputed: '被否认/存疑',
  vacated: '已撤回（失去实质支持）',
}

const CORRECTION_OUTCOME_LABEL: Record<CorrectionOutcome, string> = {
  confirmed: '确认',
  denied: '否认',
  clarified: '修正',
  no_response: '无应答',
}

const CORRECTION_ISSUE_LABEL: Record<CorrectionIssue, string> = {
  attributed_endorsement: '主持代答归因',
  bogus_citation: '凭空引用',
  out_of_range_round: '引用了未发生的轮次',
}

export function buildReport(input: BuildReportInput): Report {
  const { topic, utterances, confirmed, open, scores, modelNames } = input

  /** 人类发言也要有可读的署名，不能落到 'human' 这种原始 id */
  const nameOf = (id: string) => (id === HUMAN_AGENT_ID ? '人类介入' : modelNames.get(id) ?? id)
  const transportOf = (id: string): TransportKind => input.modelTransports.get(id) ?? 'webview'
  const opens = openOnly(open)
  const absent = utterances.filter((u) => u.absent)
  const absentAgents = [...new Set(absent.map((u) => u.agentId))]
  // 共识度核算只基于模型发言（规则 2）；人类介入另计
  const modelOnly = modelUtterancesOnly(utterances)
  const spoken = modelOnly.filter((u) => !u.absent)

  const finalScore = scores.length > 0 ? (scores[scores.length - 1]!.score) : null
  const totalRounds = scores.length > 0 ? scores[scores.length - 1]!.round : 0

  // 认同率只按「真的发过言」的模型算：缺席模型不该稀释在场共识
  const speakerIds = [...new Set(spoken.map((u) => u.agentId))]
  const speakerCount = Math.max(1, speakerIds.length)

  // ---- 血缘：谁点名回应了谁（Utterance.targets 是唯一事实来源） ----
  const byId = new Map(utterances.map((u) => [u.id, u]))
  const citedByAgent = new Map<string, number>()
  const citedByUtterance = new Map<string, number>()
  for (const u of spoken) {
    for (const t of u.targets) {
      const src = byId.get(t)
      if (!src || src.agentId === u.agentId) continue
      citedByAgent.set(src.agentId, (citedByAgent.get(src.agentId) ?? 0) + 1)
      citedByUtterance.set(src.id, (citedByUtterance.get(src.id) ?? 0) + 1)
    }
  }
  const replyEdges = [...citedByUtterance.values()].reduce((a, b) => a + b, 0)

  const evidenceOf = (ids: string[]): ReportEvidence[] =>
    utterances
      .filter((u) => ids.includes(u.id))
      .sort((a, b) => a.round - b.round || a.startedAt - b.startedAt)
      .map((u) => ({
        utteranceId: u.id,
        agentId: u.agentId,
        displayName: nameOf(u.agentId),
        round: u.round,
        quote: excerpt(u.content, 140),
      }))

  // 共识条目：必须标注认同模型数与来源轮次（PRD P0-7 强制）
  //
  // 认同溯源（coverage / attributedSupport / crossExamined）回答的是
  // 「这些支持有没有各自的原文可查」——没有的话，报告不能把它写成一致认同。
  const provenance = provenanceSummary(confirmed, utterances)
  const provById = new Map(provenance.points.map((p) => [p.pointId, p]))

  const consensus: ConsensusReportItem[] = confirmed.map((c) => {
    const srcUtts = utterances.filter((u) => c.evidenceRef.includes(u.id))
    const rounds = [...new Set(srcUtts.map((u) => u.round))].sort((a, b) => a - b)
    const supporterCount = new Set(c.support).size
    const prov = provById.get(c.id)
    return {
      claim: c.claim,
      supporterCount,
      supporters: c.support.map(nameOf),
      argument: srcUtts.map((u) => excerpt(u.content)).join(' / '),
      sourceRounds: rounds.length > 0 ? rounds : [c.confirmedRound],
      sourceUtteranceIds: c.evidenceRef,
      supportRatio: Math.round((supporterCount / speakerCount) * 100),
      confidence: c.confidence,
      confirmedRound: c.confirmedRound,
      evidence: evidenceOf(c.evidenceRef),
      weight: typeof c.weight === 'number' && c.weight >= 0 && c.weight <= 1 ? c.weight : null,
      verifiedSupportRate:
        supporterCount === 0 || !prov
          ? 0
          : Math.round((prov.covered.length / supporterCount) * 100),
      attributedSupport: (prov?.attributed ?? []).map(nameOf),
      crossExamined: prov?.crossExamined ?? false,
      verification: c.verification,
      ...(c.variants && c.variants.length > 0 ? { variants: c.variants } : {}),
    }
  })

  // 分歧：双方论据 + 为何未消解
  // 轮次口径只认这条分歧自己登记的发言；把某模型的全部发言都算进来，
  // 会把「交锋 1 轮」写成「交锋 4 轮」，报告就夸大了分歧的被检验程度。
  const disputes: DisputeReportItem[] = opens.map((d) => {
    const sideOf = (s: DisputeSide) => {
      const listed = utterances.filter((u) => s.utteranceIds.includes(u.id))
      const us = listed.length > 0 ? listed : utterances.filter((u) => u.agentId === s.agentId && !u.absent)
      return {
        agentId: nameOf(s.agentId),
        argument: excerpt(s.argument || us.map((u) => excerpt(u.content)).join(' '), 120),
        sourceRounds: [...new Set(us.map((u) => u.round))].sort((a, b) => a - b),
      }
    }
    const engaged = new Set(
      d.sides.flatMap((s) => utterances.filter((u) => s.utteranceIds.includes(u.id)).map((u) => u.round)),
    )
    return {
      claim: d.claim,
      sides: d.sides.map(sideOf),
      whyUnresolved: d.lastProgress ?? '经多轮讨论仍未能消解，各方论据均未被对方接受。',
      openedRound: d.openedRound,
      roundsEngaged: Math.max(engaged.size, 1),
      dueled: input.duels.some((x) => x.topic.includes(d.claim) || d.claim.includes(x.topic)),
      quotes: evidenceOf(d.sides.flatMap((s) => s.utteranceIds)).slice(0, 4),
    }
  })

  // 逐轮进程：分数与事件对齐到同一根时间轴上
  const roundSet = [
    ...new Set([...scores.map((s) => s.round), ...utterances.map((u) => u.round)]),
  ].sort((a, b) => a - b)
  const timeline: ReportRoundRow[] = roundSet.map((r) => {
    const sc = scores.find((x) => x.round === r)?.score ?? null
    const inRound = utterances.filter((u) => u.round === r)
    return {
      round: r,
      utterances: inRound.filter((u) => !u.absent && !u.human).length,
      absent: inRound.filter((u) => u.absent).length,
      interventions: input.interventions.filter((i) => (i.deliveredRound ?? i.atRound) === r).length,
      score: sc ? sc.score : null,
      dims: sc ? { agreement: sc.agreement, overlap: sc.overlap, trend: sc.trend } : null,
      newConsensus: confirmed.filter((c) => c.confirmedRound === r).length,
      newDisputes: open.filter((d) => d.openedRound === r).length,
      converged: r === totalRounds && input.finishedReason === 'converged',
    }
  })

  // 参与度：先列参会者，再补上只在缺席记录里出现的模型
  const participantOrder = [...new Set([...input.config.participantIds, ...speakerIds, ...absentAgents])]
  const participation: ReportParticipation[] = participantOrder.map((id) => {
    const mine = spoken.filter((u) => u.agentId === id)
    const last = mine[mine.length - 1]
    return {
      agentId: id,
      displayName: nameOf(id),
      transport: transportOf(id),
      utterances: mine.length,
      replies: mine.filter((u) => u.targets.length > 0).length,
      citedBy: citedByAgent.get(id) ?? 0,
      absentRounds: utterances.filter((u) => u.agentId === id && u.absent).length,
      costUsd: Math.round(mine.reduce((n, u) => n + (u.usage?.costUsd ?? 0), 0) * 1e6) / 1e6,
      lastQuote: last ? excerpt(last.content, 120) : null,
    }
  })

  const hubId = [...citedByUtterance.entries()].sort((a, b) => b[1] - a[1])[0]
  const hubUtt = hubId ? byId.get(hubId[0]) : undefined
  const stats: ReportStats = {
    utterances: spoken.length,
    humanUtterances: utterances.filter((u) => u.human && !u.absent).length,
    replyEdges,
    absentCount: absent.length,
    speakerCount: speakerIds.length,
    avgRoundMs: totalRounds > 0 ? Math.round(input.durationMs / totalRounds) : input.durationMs,
    hub:
      hubUtt && hubId
        ? {
            utteranceId: hubUtt.id,
            agentId: hubUtt.agentId,
            displayName: nameOf(hubUtt.agentId),
            round: hubUtt.round,
            quote: excerpt(hubUtt.content, 120),
            citedBy: hubId[1],
          }
        : null,
  }

  const coverage = Math.round((confirmed.length / Math.max(1, confirmed.length + opens.length)) * 100)
  const hallucination = input.hallucination ?? null
  const verdict = buildVerdict({
    coverage,
    consensusCount: confirmed.length,
    disputeCount: opens.length,
    absentCount: absentAgents.length,
    finalScore,
    threshold: input.config.consensusThreshold,
    moderatorUnavailable: input.moderatorUnavailable,
    budgetLimited: input.budgetLimited,
    finishedReason: input.finishedReason,
  })

  /**
   * 幻觉账本直接参与结论强度，而不只是附一章说明。
   *
   * 「无人反驳的共识」如果建立在主持代答 + 空心改写之上，分数再高也不能标 strong：
   * 轨迹判定为 compounding 时，后面的轮次是在给自己编的内容做加固。
   */
  if (hallucination) {
    const risky = hallucination.riskScore >= 40 || hallucination.trajectory === 'compounding'
    verdict.reasons.push(
      `幻觉风险 ${hallucination.riskScore}/100（凭空引用 ${hallucination.citationBogusRate}%、代答 ${hallucination.attributedRate}%、空心改写 ${hallucination.hollowMutationRate}%）：${hallucination.trajectoryNote}`,
    )
    if (risky && verdict.level === 'strong') {
      verdict.level = 'qualified'
      verdict.headline = `${verdict.headline}（但幻觉风险偏高：先处理下列可疑条目再对外发布）`
    } else if (risky && verdict.level === 'qualified') {
      verdict.headline = `${verdict.headline}（幻觉风险偏高，逐条核验前不宜直接引用）`
    }
  }

  // 分数不变，但要把「分数没法告诉你的东西」写进理由：
  // 支持方没有可核对的原文，是主持代答，不是模型自己站队。
  if (consensus.length > 0 && provenance.coverageRate < 60) {
    verdict.reasons.push(
      `仅 ${provenance.coverageRate}% 的「支持」能在本人发言中找到原文，其余为主持代答，共识度可能偏高。`,
    )
  }

  const nextActions = buildNextActions({
    disputes: opens.map((d) => ({
      claim: d.claim,
      agents: d.sides.map((s) => nameOf(s.agentId)),
      dueled: input.duels.some((x) => x.topic.includes(d.claim) || d.claim.includes(x.topic)),
    })),
    absent: absentAgents.map(nameOf),
    budgetLimited: input.budgetLimited,
    moderatorUnavailable: input.moderatorUnavailable,
    finishedReason: input.finishedReason,
    finalScore,
    threshold: input.config.consensusThreshold,
    interventionCount: input.interventions.length,
    spentUsd: input.totalCostUsd,
    budgetLimitUsd: input.config.budgetLimitUsd,
  })

  /**
   * 治理动作排在最前面：报告读者最该先做的是「把可疑条目处理掉」，
   * 而不是直接跳到下一场讨论。
   */
  if (hallucination) {
    const v = hallucination.verification
    const pending = hallucination.rounds.reduce((a, r) => a + r.badCitationUtterances, 0)
    if (v.asked > 0) {
      nextActions.unshift(
        `核验轮已质询 ${v.asked} 次：确认 ${v.confirmed}、否认 ${v.denied}、修正 ${v.clarified}、无应答 ${v.noResponse}` +
          (v.vacatedPoints > 0 ? `，${v.vacatedPoints} 条共识因失去实质支持转为「已撤回」` : '') +
          '。被否认/修正的条目仍在共识清单里，只是标了状态 —— 逐条看一眼比重新跑一场更快。',
      )
    } else if (pending > 0 || hallucination.attributedRate > 0) {
      nextActions.unshift(
        `本场有 ${pending} 条含凭空引用的发言、${hallucination.attributedRate}% 的支持为主持代答，但未触发核验轮（verifyPass=off 或轮次过少）：开启「自动核验」重跑，或手动质询这几个模型。`,
      )
    }
    if (hallucination.trajectory === 'compounding') {
      nextActions.unshift(
        '幻觉跨轮递增（后半段错误信号高于前半段）：这条讨论链不宜再加轮，先压缩轮次或加入外部证据，否则越往后越是在给自造内容做加固。',
      )
    }
  }
  const cmp = input.baselineCompare
  if (cmp && cmp.verdict === 'baseline_better') {
    nextActions.unshift(
      `研讨结论未优于单模型基线（丢掉 ${cmp.councilDrops.length} 个基线要点）：本场不值得再投入，改为直接问基线模型或换更对立的参会组合。`,
    )
  }

  // 盲区：缺席模型 + 未被任何一方提及的议题
  const blindSpots: string[] = []
  for (const id of absentAgents) {
    blindSpots.push(`${nameOf(id)} 在本场讨论中缺席（${absent.find((u) => u.agentId === id)?.absentReason ?? '未知原因'}），其视角未被纳入。`)
  }
  if (input.moderatorUnavailable) {
    blindSpots.push('本场无主持评估，共识度不可用，分歧未做结构化消解。')
  }
  for (const d of opens) {
    blindSpots.push(`议题「${d.claim}」在 ${input.config.maxRounds} 轮内未形成结论，需人工判断。`)
  }
  const silent = speakerIds.filter((id) => (citedByAgent.get(id) ?? 0) === 0 && spoken.filter((u) => u.agentId === id).length > 0)
  if (silent.length > 0 && speakerIds.length > 1) {
    blindSpots.push(`${silent.map(nameOf).join('、')} 的论点没有被任何其他人点名回应，可能只是并列陈述而非真正的交锋。`)
  }

  const meta: ReportMeta = {
    models: [...new Set(modelOnly.map((u) => u.agentId))].map((id) => ({
      id,
      displayName: nameOf(id),
      transport: transportOf(id),
    })),
    rounds: totalRounds,
    maxRounds: input.config.maxRounds,
    consensusThreshold: input.config.consensusThreshold,
    totalCostUsd: input.totalCostUsd,
    budgetLimitUsd: input.config.budgetLimitUsd,
    durationMs: input.durationMs,
    absentAgents,
    budgetLimited: input.budgetLimited,
    moderatorUnavailable: input.moderatorUnavailable,
    consensusAvailable: finalScore !== null,
    finalConsensusScore: finalScore,
    finishedReason: input.finishedReason,
    moderatorName: input.config.moderatorId ? nameOf(input.config.moderatorId) : null,
    interventionCount: input.interventions.length,
    duelCount: input.duels.length,
    anonymousReview: !!input.config.anonymousReview,
    leaderboard: aggregateLeaderboard(input.moderatorAudit ?? []),
    provenance: {
      coverageRate: provenance.coverageRate,
      crossExaminedRate: provenance.crossExaminedRate,
    },
    channels: channelsOf(input.ledger, input.config.moderatorId !== null),
    timeBudgetMs: input.config.timeBudgetMs ?? 0,
    timeLimited: !!input.timeLimited,
    exploredCount: input.explored?.length ?? 0,
    digestCompacted: !!input.digestCompacted,
    dedup: input.dedup,
  }

  return {
    sessionId: topic.id,
    executiveSummary: buildSummary(
      topic,
      consensus.length,
      disputes.length,
      REASON_LABEL[input.finishedReason],
      absentAgents.length,
      input.interventions.length,
      baselineNote(input.baseline ?? null, input.baselineCompare ?? null),
      hallucinationNote(hallucination),
    ),
    verdict,
    stats,
    timeline,
    consensus,
    disputes,
    participation,
    blindSpots,
    baseline: input.baseline ?? null,
    baselineCompare: input.baselineCompare ?? null,
    hallucination: hallucination ?? undefined,
    nextActions,
    interventions: summarizeInterventions(input.interventions, nameOf),
    stageTimings: input.stageTimings ?? [],
    duels: input.duels.map((d) => ({
      topic: d.topic,
      agentIds: d.agentIds.map(nameOf),
      utteranceCount: d.utterances.filter((u) => !u.absent).length,
    })),
    meta,
    generatedAt: Date.now(),
  }
}

interface VerdictInput {
  coverage: number
  consensusCount: number
  disputeCount: number
  absentCount: number
  finalScore: ConsensusScore | null
  threshold: number
  moderatorUnavailable: boolean
  budgetLimited: boolean
  finishedReason: BuildReportInput['finishedReason']
}

function buildVerdict(v: VerdictInput): ReportVerdict {
  const reasons: string[] = []
  if (v.finalScore) {
    reasons.push(
      `最终共识度 ${v.finalScore.score}（阈值 ${v.threshold}）：立场一致 ${v.finalScore.agreement} / 论点重合 ${v.finalScore.overlap} / 收敛趋势 ${v.finalScore.trend}。`,
    )
  } else {
    reasons.push('本场没有可用的共识度评估。')
  }
  reasons.push(`${v.consensusCount} 条共识已由主席确认，${v.disputeCount} 项分歧仍未消解。`)
  if (v.absentCount > 0) reasons.push(`${v.absentCount} 个模型全程或部分缺席，覆盖面不完整。`)
  if (v.moderatorUnavailable) reasons.push('无主持降级模式：结论未经结构化复核。')
  if (v.budgetLimited) reasons.push('预算触顶提前收束，后续轮次的反驳未发生。')
  if (v.finishedReason === 'max-rounds') reasons.push('轮次用尽仍未达到阈值。')
  if (v.finishedReason === 'aborted') reasons.push('用户中途终止，样本量不足以支撑结论。')

  let level: ReportVerdict['level']
  let headline: string
  if (v.consensusCount === 0) {
    level = 'none'
    headline = '本场没有形成可确认的共识，只有过程记录。'
  } else if (v.moderatorUnavailable || !v.finalScore) {
    level = 'weak'
    headline = `形成 ${v.consensusCount} 条共识，但缺少共识度核算，只能作为参考方向。`
  } else if (v.disputeCount > 0 || v.absentCount > 0 || v.budgetLimited || v.finishedReason !== 'converged') {
    level = 'qualified'
    headline = `形成 ${v.consensusCount} 条共识（覆盖率 ${v.coverage}%），仍有 ${v.disputeCount} 项分歧未消解，结论可用于方向判断，不能直接当作落地承诺。`
  } else {
    level = 'strong'
    headline = `形成 ${v.consensusCount} 条共识，未消解分歧为 0，共识度 ${v.finalScore.score} 达标，结论可对外发布并逐条溯源。`
  }
  return { level, headline, reasons, coverage: v.coverage }
}

interface NextActionInput {
  disputes: Array<{ claim: string; agents: string[]; dueled: boolean }>
  absent: string[]
  budgetLimited: boolean
  moderatorUnavailable: boolean
  finishedReason: BuildReportInput['finishedReason']
  finalScore: ConsensusScore | null
  threshold: number
  interventionCount: number
  spentUsd: number
  budgetLimitUsd: number
}

function buildNextActions(v: NextActionInput): string[] {
  const out: string[] = []
  for (const d of v.disputes) {
    if (d.dueled) {
      out.push(`「${d.claim}」已对辩过仍未消解：需要外部证据或决策约束才能推进，建议带资料再开一轮。`)
    } else if (d.agents.length < 2) {
      out.push(`「${d.claim}」目前只有 ${(d.agents[0] ?? '一方')} 单方面陈述：先补齐对立方（或数据提供方）再判断，现在下结论为时过早。`)
    } else {
      out.push(`为「${d.claim}」开一轮专项对辩（${d.agents.join(' vs ')}），比全员圆桌更容易逼出分歧的真实根据。`)
    }
  }
  if (v.absent.length > 0) {
    out.push(`让缺席的 ${v.absent.join('、')} 单独补一轮，检验是否会推翻现有共识。`)
  }
  if (v.finishedReason === 'max-rounds' && v.finalScore && v.finalScore.score < v.threshold) {
    out.push(
      `轮次用尽时共识度 ${v.finalScore.score} 距阈值 ${v.threshold} 还差 ${(v.threshold - v.finalScore.score).toFixed(0)}：继续加轮之前，先收窄议题或换主持的追问角度。`,
    )
  }
  if (v.budgetLimited) {
    out.push(`预算已用去 $${v.spentUsd.toFixed(4)} / $${v.budgetLimitUsd.toFixed(2)}：如需续跑，先提高上限再从下一轮接上。`)
  }
  if (v.moderatorUnavailable) {
    out.push('换用一个支持结构化输出的 API 模型当主持重跑，才能拿到共识度与分歧消解记录。')
  }
  if (v.interventionCount > 0) {
    out.push('本场有人工介入：抽查介入前后一轮的发言，确认结论走向是被证据改变还是被提示改变。')
  }
  if (out.length === 0) {
    out.push('结论已收敛且无未决分歧：把报告连同溯源链接发给决策方，并保留本场诊断日志备查。')
  }
  return out
}

function buildSummary(
  topic: Topic,
  consensusCount: number,
  disputeCount: number,
  reasonLabel: string,
  absentCount: number,
  interventionCount: number,
  baselineNoteText: string,
  hallucinationNoteText: string,
): string {
  const parts: string[] = []
  parts.push(`围绕「${topic.title}」的讨论已结束（${reasonLabel}）。`)
  parts.push(`本场形成 ${consensusCount} 条共识、${disputeCount} 项保留分歧。`)
  if (interventionCount > 0) {
    parts.push(`用户介入了 ${interventionCount} 次。`)
  }
  if (absentCount > 0) {
    parts.push(`有 ${absentCount} 个模型缺席，其视角未纳入，结论应据此打折。`)
  }
  if (disputeCount > 0) {
    parts.push('需注意：保留分歧项尚未消解，不应视为已达成一致。')
  }
  parts.push(baselineNoteText)
  parts.push(hallucinationNoteText)
  return parts.join('')
}

/** 基线对照的存在与否必须写进摘要：读者不看第七章也要知道「有没有跟直接问一个模型比过」 */
function baselineNote(
  baseline: BaselineResult | null,
  compare: BaselineComparison | null,
): string {
  if (!baseline) return '本场未设单模型基线，无法判断研讨相比直接问一个模型多出了什么。'
  if (baseline.absent) return `单模型基线（${baseline.displayName}）未产出，本场没有对照基准。`
  if (!compare) return `单模型基线为 ${baseline.displayName} 的独立作答，未做结构化对照。`
  return `与 ${baseline.displayName} 的单模型基线相比：${BASELINE_VERDICT_LABEL[compare.verdict]}。`
}

function hallucinationNote(h: HallucinationReport | null): string {
  if (!h) return ''
  return `幻觉风险 ${h.riskScore}/100（轨迹：${TRAJECTORY_LABEL[h.trajectory]}）。`
}

/**
 * 分通道台账。
 *
 * 网页通道拿不到用量，costUsd 恒为 0 —— 于是「本场成本 $0」是个假象。
 * 只有真的用过网页通道时才补一句口径说明，纯 API 场不必啰嗦。
 */
function channelsOf(
  ledger: BuildReportInput['ledger'],
  hasModerator: boolean,
): ReportMeta['channels'] {
  if (!ledger) return undefined
  if (ledger.webCalls === 0 && !hasModerator) {
    return { ...ledger, costNote: '金额按 API 单价折算。' }
  }
  return {
    ...ledger,
    costNote:
      ledger.webCalls > 0
        ? `金额只含 API 通道的计价；网页通道 ${ledger.webCalls} 次调用拿不到用量，真实代价看调用次数与耗时。`
        : '金额按 API 单价折算，主持小结另计次数。',
  }
}

function excerpt(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

const LEVEL_LABEL: Record<ReportVerdict['level'], string> = {
  strong: '结论稳固',
  qualified: '有条件成立',
  weak: '仅供参考',
  none: '未形成共识',
}

/** Markdown 表格单元格：竖线和换行会把整张表撞乱 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

function supportLabel(ratio: number): string {
  return ratio >= 100 ? '全员认同' : ratio >= 60 ? '多数认同' : '少数认同'
}

/**
 * 导出 Markdown（本地文件，PRD P0-7）
 *
 * 章节顺序与界面报告一致：结论 → 数字 → 依据 → 过程 → 风险 → 下一步 → 口径。
 * 早期落盘的报告缺 verdict / timeline 等字段，这里一律按缺省渲染，不抛错。
 */
export function reportToMarkdown(r: Report, topic: Topic): string {
  const lines: string[] = []
  // 报告里出现的是模型名称：内部 id（api-user-xxx）对读者没有意义，只该出现在文件名与磁盘上
  const nameOf = (id: string): string => r.meta?.models.find((m) => m.id === id)?.displayName ?? id
  const consensus = r.consensus ?? []
  const disputes = r.disputes ?? []
  const timeline = r.timeline ?? []
  const participation = r.participation ?? []
  const nextActions = r.nextActions ?? []
  const stats = r.stats ?? {
    utterances: 0,
    humanUtterances: 0,
    replyEdges: 0,
    absentCount: 0,
    speakerCount: Math.max(1, (r.meta?.models ?? []).length),
    avgRoundMs: 0,
    hub: null,
  }
  const verdict: ReportVerdict = r.verdict ?? {
    level: r.meta?.consensusAvailable ? 'qualified' : 'weak',
    headline: r.executiveSummary,
    reasons: ['该报告由旧版本生成，未包含结论强度核算。'],
    coverage: Math.round((consensus.length / Math.max(1, consensus.length + disputes.length)) * 100),
  }

  lines.push(`# 讨论报告：${topic.title}`)
  lines.push('')
  lines.push(`> 生成时间：${new Date(r.generatedAt).toLocaleString('zh-CN')} · 结论强度：**${LEVEL_LABEL[verdict.level]}**`)
  lines.push('')

  let sec = 0
  const nextCn = () => CN[(sec += 1)] ?? String(sec)

  lines.push('## 结论')
  lines.push('')
  lines.push(`**${verdict.headline}**`)
  lines.push('')
  lines.push(`结论覆盖率 ${verdict.coverage}%`)
  lines.push('')
  for (const reason of verdict.reasons) lines.push(`- ${reason}`)
  lines.push('')

  lines.push('## 关键数字')
  lines.push('')
  lines.push('| 共识 | 未决分歧 | 有效发言 | 点名回应 | 缺席事件 | 人工介入 | 专项对辩 | 耗时 | 成本 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  lines.push(
    `| ${consensus.length} | ${disputes.length} | ${stats.utterances} | ${stats.replyEdges} | ${stats.absentCount} | ` +
      `${r.meta?.interventionCount ?? 0} | ${r.meta?.duelCount ?? 0} | ${fmtDuration(r.meta?.durationMs ?? 0)} | ` +
      `$${(r.meta?.totalCostUsd ?? 0).toFixed(4)} |`,
  )
  lines.push('')

  lines.push(`## ${nextCn()}、执行摘要`)
  lines.push('')
  lines.push(r.executiveSummary)
  lines.push('')

  lines.push(`## ${nextCn()}、共识结论`)
  lines.push('')
  const dedup = r.meta?.dedup
  if (dedup && dedup.merged > 0) {
    lines.push(
      `> 主持跨轮重复列出的 ${dedup.merged} 条说法已按内容并入下面的 ${consensus.length} 条结论（原措辞逐条附在对应条目下，未丢弃）。`,
    )
    lines.push('')
  }
  if (consensus.length === 0) {
    lines.push('（本场未形成可确认的共识）')
  } else {
    consensus.forEach((c, i) => {
      lines.push(`${i + 1}. **${c.claim}** —— ${supportLabel(c.supportRatio)}（${c.supporterCount}/${Math.max(1, stats.speakerCount)}）`)
      lines.push(`   - 认同模型：${c.supporters.join('、')}（置信度 ${(c.confidence ?? 0).toFixed(2)}，第 ${c.confirmedRound} 轮确认）`)
      lines.push(`   - 来源轮次：第 ${(c.sourceRounds ?? []).join('、')} 轮`)
      lines.push(`   - 关键论据：${c.argument}`)
      const evidence = c.evidence ?? []
      if (evidence.length > 0) {
        lines.push(`   - 证据链（${evidence.length} 条原文）：`)
        for (const e of evidence) lines.push(`     - R${e.round} ${e.displayName}：${e.quote}`)
      }
      const audit: string[] = []
      if (typeof c.weight === 'number') audit.push(`证据硬度 ${c.weight.toFixed(2)}`)
      if (typeof c.verifiedSupportRate === 'number') {
        audit.push(`支持可核对 ${c.verifiedSupportRate}%`)
      }
      if ((c.attributedSupport ?? []).length > 0) {
        audit.push(`主持代答：${c.attributedSupport.join('、')}`)
      }
      if (c.crossExamined) audit.push('曾被对方点名反驳')
      if (c.verification) {
        audit.push(`核验：${VERIFICATION_STATUS_LABEL[c.verification.status]}（第 ${c.verification.checkedRound} 轮）`)
      }
      if (audit.length > 0) lines.push(`   - 溯源校验：${audit.join(' · ')}`)
      const variants = c.variants ?? []
      if (variants.length > 0) {
        lines.push(`   - 同一判断的其他说法（已并入本条，非独立结论）：${variants.map((v) => `「${cell(v)}」`).join('、')}`)
      }
    })
  }
  lines.push('')

  lines.push(`## ${nextCn()}、保留分歧`)
  lines.push('')
  if (disputes.length === 0) {
    lines.push('（无登记在案的分歧。注意：这不等于全员一致认同。）')
  } else {
    disputes.forEach((d, i) => {
      lines.push(
        `${i + 1}. **${d.claim}**（始于第 ${d.openedRound} 轮，交锋 ${d.roundsEngaged ?? 1} 轮${d.dueled ? '，已专项对辩' : ''}）`,
      )
      for (const s of d.sides ?? []) {
        lines.push(`   - ${nameOf(s.agentId)}（第 ${(s.sourceRounds ?? []).join('、')} 轮）：${s.argument}`)
      }
      const quotes = d.quotes ?? []
      if (quotes.length > 0) {
        lines.push(`   - 交锋原文：`)
        for (const e of quotes) lines.push(`     - R${e.round} ${e.displayName}：${e.quote}`)
      }
      lines.push(`   - 未消解原因：${d.whyUnresolved}`)
    })
  }
  lines.push('')

  if (timeline.length > 0) {
    lines.push(`## ${nextCn()}、讨论进程`)
    lines.push('')
    lines.push('| 轮次 | 发言 | 缺席 | 介入 | 新共识 | 新分歧 | 共识度 | 立场/重合/趋势 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const row of timeline) {
      const dims = row.dims ? `${row.dims.agreement} / ${row.dims.overlap} / ${row.dims.trend}` : '-'
      lines.push(
        `| R${row.round}${row.converged ? '（收敛）' : ''} | ${row.utterances} | ${row.absent || '-'} | ` +
          `${row.interventions || '-'} | ${row.newConsensus || '-'} | ${row.newDisputes || '-'} | ` +
          `${row.score ?? '-'} | ${dims} |`,
      )
    }
    lines.push('')
  }

  if (participation.length > 0) {
    lines.push(`## ${nextCn()}、参与度与血缘`)
    lines.push('')
    lines.push('| 模型 | 通道 | 发言 | 主动回应 | 被引用 | 缺席轮 | 成本 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const p of participation) {
      lines.push(
        `| ${cell(p.displayName)} | ${p.transport === 'api' ? 'API' : '网页'} | ${p.utterances} | ${p.replies} | ` +
          `${p.citedBy} | ${p.absentRounds || '-'} | $${(p.costUsd ?? 0).toFixed(4)} |`,
      )
    }
    lines.push('')
    if (stats.hub) {
      lines.push(`被引用最多的论点：${stats.hub.displayName} 第 ${stats.hub.round} 轮（${stats.hub.citedBy} 次）—— ${stats.hub.quote}`)
      lines.push('')
    }
    // 互评名次：主持每轮对参会者的相对排序（匿名轨下按别名评，去掉厂商光环）
    const lb = r.meta?.leaderboard ?? []
    if (lb.length > 0) {
      const nameOfMeta = new Map((r.meta?.models ?? []).map((m) => [m.id, m.displayName]))
      lines.push('**互评名次**（平均名次越小越靠前）')
      lines.push('')
      lines.push('| 模型 | 平均名次 | 参评轮次 | 主持理由 |')
      lines.push('| --- | --- | --- | --- |')
      for (const row of lb) {
        lines.push(
          `| ${cell(nameOfMeta.get(row.agentId) ?? row.agentId)} | ${row.averageRank.toFixed(2)} | ${row.rounds} | ${cell(row.rationale ?? '-')} |`,
        )
      }
      lines.push('')
      lines.push('> 名次只是相对信号，取跨轮平均，不参与共识度加权。')
      lines.push('')
    }
  }

  if ((r.interventions ?? []).length > 0 || (r.duels ?? []).length > 0) {
    lines.push(`## ${nextCn()}、人类介入与专项对辩`)
    lines.push('')
    for (const i of r.interventions ?? []) lines.push(`- ${i}`)
    if ((r.duels ?? []).length > 0) {
      lines.push('')
      lines.push('**专项对辩轮**')
      lines.push('')
      ;(r.duels ?? []).forEach((d, i) => {
        lines.push(`${i + 1}. **${d.topic}**：${d.agentIds.join(' vs ')}（${d.utteranceCount} 条发言）`)
      })
    }
    lines.push('')
    lines.push('> 人类介入已计入讨论记录，但**不计入共识度核算** —— 人的表态不等于模型共识。')
    lines.push('')
  }

  if ((r.blindSpots ?? []).length > 0) {
    lines.push(`## ${nextCn()}、未覆盖风险与盲区`)
    lines.push('')
    r.blindSpots.forEach((b) => lines.push(`- ${b}`))
    lines.push('')
  }

  const h = r.hallucination
  if (h) {
    lines.push(`## ${nextCn()}、幻觉治理`)
    lines.push('')
    lines.push(
      `风险分 **${h.riskScore}/100** · 轨迹判定：**${TRAJECTORY_LABEL[h.trajectory]}**`,
    )
    lines.push('')
    lines.push(`- ${h.trajectoryNote}`)
    lines.push('')
    lines.push('| 轮次 | 有效发言 | 凭空引用 | 代答新增 | 有据改写 | 空心改写 | 主持抬分 | 错误信号合计 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const x of h.rounds) {
      lines.push(
        `| R${x.round} | ${x.utterances} | ${x.badCitationUtterances || '-'} | ${x.attributedGrowth || '-'} | ` +
          `${x.substantiatedRefinements || '-'} | ${x.hollowMutations || '-'} | ${x.inflation.toFixed(1)} | ${x.errorCount} |`,
      )
    }
    lines.push('')
    lines.push(
      `全场：含凭空引用的发言占 ${h.citationBogusRate}%；主持代答占声称支持的 ${h.attributedRate}%；` +
        `改写中空心（没加证据只换说法）占 ${h.hollowMutationRate}%；最大抬分 ${h.maxInflation.toFixed(1)} 维度点。`,
    )
    lines.push('')
    const v = h.verification
    lines.push(
      v.asked > 0
        ? `核验轮：质询 ${v.asked} 次（触发依据：${v.triggeredBy}）→ 确认 ${v.confirmed} / 否认 ${v.denied} / 修正 ${v.clarified} / 无应答 ${v.noResponse}；${v.vacatedPoints} 条共识失去实质支持转为「已撤回」。`
        : `核验轮：未触发（${v.triggeredBy}）。`,
    )
    lines.push('')
    for (const c of (h.corrections ?? []).slice(0, 20)) {
      lines.push(
        `- R${c.round} ${CORRECTION_ISSUE_LABEL[c.issue]} · ${CORRECTION_OUTCOME_LABEL[c.outcome]}：${c.pointClaim ?? '引用问题'}` +
          (c.answer ? ` —— ${cell(c.answer).slice(0, 120)}` : ''),
      )
    }
    if ((h.corrections ?? []).length > 20) {
      lines.push(`- …另有 ${(h.corrections ?? []).length - 20} 条质询记录`)
    }
    lines.push('')
    for (const f of h.flags ?? []) lines.push(`- 需人工查看：${f}`)
    lines.push('')
    lines.push('> 只统计本场内部可判死的信号（引用的发言/轮次是否存在、支持有没有本人原文、改写是否新增证据）。')
    lines.push('> 无人否认不等于确认：被质询后无应答的条目保持「未核验」，报告不将其计入已核实共识。')
    lines.push('')
  }

  const base = r.baseline
  if (base) {
    lines.push(`## ${nextCn()}、对照：研讨 vs 单模型基线`)
    lines.push('')
    lines.push(
      `基线模型：**${base.displayName}**（${base.transport === 'api' ? 'API' : '网页'}通道，` +
        `${fmtDuration(Math.max(0, base.endedAt - base.startedAt))}` +
        `${base.costUsd > 0 ? ` · $${base.costUsd.toFixed(4)}` : ''}）`,
    )
    lines.push('')
    if (base.absent) {
      lines.push(`基线未产出：${base.absentReason ?? '原因未记录'}。本场无法回答「研讨比直接问一个模型多出了什么」。`)
    } else {
      lines.push(`> ${cell(base.content).slice(0, 400)}`)
      lines.push('')
      const cmp = r.baselineCompare
      if (cmp) {
        lines.push(`主持对照结论：**${BASELINE_VERDICT_LABEL[cmp.verdict]}** —— ${cmp.note}`)
        lines.push('')
        const block = (title: string, items: string[]) => {
          if (items.length === 0) return
          lines.push(`**${title}**`)
          lines.push('')
          items.forEach((x, i) => lines.push(`${i + 1}. ${x}`))
          lines.push('')
        }
        block('研讨多出、基线没有的要点', cmp.councilAdds)
        block('基线提到、研讨反而丢掉的要点', cmp.councilDrops)
        block('研讨中被削弱或跑偏的判断', cmp.regressions)
      } else {
        lines.push('未做结构化对照（对照开关未开启或主持未产出）。')
      }
    }
    lines.push('')
    lines.push('> 基线是讨论开始前在同一议题上的独立作答，不参与任何轮次、不进入纪要，也不计入共识度。')
    lines.push('')
  }

  if (nextActions.length > 0) {
    lines.push(`## ${nextCn()}、下一步建议`)
    lines.push('')
    nextActions.forEach((a, i) => lines.push(`${i + 1}. ${a}`))
    lines.push('')
  }

  lines.push('## 溯源与口径')
  lines.push('')
  lines.push(`- 参与模型：${(r.meta?.models ?? []).map((m) => m.displayName).join('、') || '未记录'}`)
  lines.push(`- 主持：${r.meta?.moderatorUnavailable ? '无主持（降级）' : r.meta?.moderatorName ?? 'API 模型'}`)
  lines.push(`- 轮次：${r.meta?.rounds ?? 0} / ${r.meta?.maxRounds ?? r.meta?.rounds ?? 0}（阈值 ${r.meta?.consensusThreshold ?? '未记录'}）`)
  lines.push(`- 结束原因：${REASON_LABEL[r.meta?.finishedReason ?? 'failed'] ?? '未记录'}`)
  lines.push(`- 费用：$${(r.meta?.totalCostUsd ?? 0).toFixed(4)}${r.meta?.budgetLimited ? '（预算触顶）' : ''}`)
  lines.push(`- 耗时：${fmtDuration(r.meta?.durationMs ?? 0)}`)
  const nameById = new Map((r.meta?.models ?? []).map((m) => [m.id, m.displayName]))
  const absentNames = (r.meta?.absentAgents ?? []).map((id) => nameById.get(id) ?? id)
  lines.push(`- 缺席模型：${absentNames.length > 0 ? absentNames.join('、') : '无'}`)
  lines.push(`- 人类介入：${r.meta?.interventionCount ?? 0} 次`)
  lines.push(`- 专项对辩：${r.meta?.duelCount ?? 0} 轮`)
  if (r.meta?.finalConsensusScore) {
    const s = r.meta.finalConsensusScore
    lines.push(
      `- 最终共识度：${s.score}（立场一致度 ${s.agreement} / 论点重合度 ${s.overlap} / 收敛趋势 ${s.trend}）`,
    )
  } else {
    lines.push('- 最终共识度：不可用（无主持评估）')
  }
  lines.push(`- 互评模式：${r.meta?.anonymousReview ? '匿名轨（主持人只见「参会者A/B…」别名）' : '署名轨（可见模型身份）'}`)
  const prov = r.meta?.provenance
  if (prov) {
    lines.push(
      `- 认同溯源：${prov.coverageRate}% 的支持有本人发言原文可核对，${prov.crossExaminedRate}% 的共识点曾被对方点名反驳。`,
    )
  }
  const ch = r.meta?.channels
  if (ch) {
    lines.push(
      `- 调用台账：API 发言 ${ch.apiCalls} 次 · 网页发言 ${ch.webCalls} 次 · 主持调用 ${ch.moderatorCalls} 次 · 墙钟 ${fmtDuration(ch.totalMs)}`,
    )
    if (ch.costNote) lines.push(`- 费用口径：${ch.costNote}`)
  }
  if ((r.meta?.timeBudgetMs ?? 0) > 0) {
    lines.push(
      `- 时长预算：${fmtDuration(r.meta!.timeBudgetMs!)}${r.meta!.timeLimited ? '（已触顶，提前收束）' : '（未触顶）'}`,
    )
  }
  lines.push(`- 已排除方向：${r.meta?.exploredCount ?? 0} 条登记在册`)
  if (dedup && dedup.merged > 0) {
    lines.push(`- 共识点归并：${dedup.merged} 条近义说法并入已有条目，判据为混合字面相似度 ≥ 0.6 且否定词同侧`)
  }
  for (const n of dedup?.notes ?? []) lines.push(`- 归并未采纳：${n}`)
  const stages = (r.stageTimings ?? []).map(
    (t) => `R${t.round} ${STAGE_LABEL[t.stage]} ${fmtDuration(t.durationMs)}`,
  )
  if (stages.length > 0) lines.push(`- 阶段耗时：${stages.join(' · ')}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('本报告由 Torra 自动生成。共识结论均可溯源至具体轮次与发言；保留分歧项不应被视为已达成一致。')

  return lines.join('\n')
}

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

function fmtDuration(ms: number): string {
  if (!ms) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
