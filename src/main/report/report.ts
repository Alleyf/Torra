/**
 * 报告生成（PRD 附录 C + 7.1 P0-7）
 *
 * 硬约束：禁止删除未决分歧以使报告显得一致；
 *         禁止把「无人反对」表述为「一致认同」。
 * 这两条是「假收敛」的最后一道出口 —— 前面机制失效时，这里是最后拦截点。
 */

import { openOnly } from '../../shared/invariants'
import { modelUtterancesOnly, summarizeInterventions } from '../../shared/interventions'
import type {
  ConsensusPoint,
  DuelRound,
  Intervention,
  OpenDispute,
  Report,
  ReportMeta,
  SessionConfig,
  Topic,
  Utterance,
  ConsensusScore,
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
  totalCostUsd: number
  durationMs: number
  budgetLimited: boolean
  moderatorUnavailable: boolean
  finishedReason: 'converged' | 'max-rounds' | 'aborted' | 'no-moderator' | 'failed'
  /** 人工介入全记录（PRD 5.5） */
  interventions: Intervention[]
  /** 专项对辩轮 */
  duels: DuelRound[]
}

const REASON_LABEL: Record<BuildReportInput['finishedReason'], string> = {
  converged: '已达共识阈值',
  'max-rounds': '达到最大轮次',
  aborted: '用户终止',
  'no-moderator': '主持不可用（无主持降级模式）',
  failed: '异常终止（已保存部分结果）',
}

export function buildReport(input: BuildReportInput): Report {
  const { topic, utterances, confirmed, open, scores, modelNames } = input

  const opens = openOnly(open)
  const absent = utterances.filter((u) => u.absent)
  const absentAgents = [...new Set(absent.map((u) => u.agentId))]

  const finalScore = scores.length > 0 ? (scores[scores.length - 1]!.score) : null
  const totalRounds = scores.length > 0 ? scores[scores.length - 1]!.round : 0

  // 共识条目：必须标注认同模型数与来源轮次（PRD P0-7 强制）
  const consensus = confirmed.map((c) => {
    const srcUtts = utterances.filter((u) => c.evidenceRef.includes(u.id))
    const rounds = [...new Set(srcUtts.map((u) => u.round))].sort()
    return {
      claim: c.claim,
      supporterCount: new Set(c.support).size,
      supporters: c.support.map((id) => modelNames.get(id) ?? id),
      argument: srcUtts.map((u) => excerpt(u.content)).join(' / '),
      sourceRounds: rounds.length > 0 ? rounds : [c.confirmedRound],
      sourceUtteranceIds: c.evidenceRef,
    }
  })

  // 分歧：双方论据 + 为何未消解
  const disputes = opens.map((d) => ({
    claim: d.claim,
    sides: d.sides.map((s) => {
      const us = utterances.filter((u) => s.utteranceIds.includes(u.id) || (u.agentId === s.agentId && !u.absent))
      return {
        agentId: modelNames.get(s.agentId) ?? s.agentId,
        argument: excerpt(s.argument || us.map((u) => excerpt(u.content)).join(' '), 120),
        sourceRounds: [...new Set(us.map((u) => u.round))].sort(),
      }
    }),
    whyUnresolved: d.lastProgress ?? '经多轮讨论仍未能消解，各方论据均未被对方接受。',
    openedRound: d.openedRound,
  }))

  // 盲区：缺席模型 + 未被任何一方提及的议题
  const blindSpots: string[] = []
  for (const id of absentAgents) {
    blindSpots.push(`${modelNames.get(id) ?? id} 在本场讨论中缺席（${absent.find((u) => u.agentId === id)?.absentReason ?? '未知原因'}），其视角未被纳入。`)
  }
  if (input.moderatorUnavailable) {
    blindSpots.push('本场无主持评估，共识度不可用，分歧未做结构化消解。')
  }
  for (const d of opens) {
    blindSpots.push(`议题「${d.claim}」在 ${input.config.maxRounds} 轮内未形成结论，需人工判断。`)
  }
  // 共识度核算只基于模型发言（规则 2）
  const modelOnly = modelUtterancesOnly(utterances)
  if (modelOnly.length < utterances.filter((u) => !u.absent).length) {
    // 说明：人类介入已记录但不计入共识度
  }

  const meta: ReportMeta = {
    models: [...new Set(modelOnly.map((u) => u.agentId))].map((id) => ({
      id,
      displayName: modelNames.get(id) ?? id,
      transport: 'webview',
    })),
    rounds: totalRounds,
    totalCostUsd: input.totalCostUsd,
    durationMs: input.durationMs,
    absentAgents,
    budgetLimited: input.budgetLimited,
    moderatorUnavailable: input.moderatorUnavailable,
    consensusAvailable: finalScore !== null,
    finalConsensusScore: finalScore,
    interventionCount: input.interventions.length,
    duelCount: input.duels.length,
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
    ),
    consensus,
    disputes,
    blindSpots,
    interventions: summarizeInterventions(input.interventions),
    duels: input.duels.map((d) => ({
      topic: d.topic,
      agentIds: d.agentIds.map((a) => modelNames.get(a) ?? a),
      utteranceCount: d.utterances.filter((u) => !u.absent).length,
    })),
    meta,
    generatedAt: Date.now(),
  }
}

function buildSummary(
  topic: Topic,
  consensusCount: number,
  disputeCount: number,
  reasonLabel: string,
  absentCount: number,
  interventionCount: number,
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
  return parts.join('')
}

function excerpt(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 导出 Markdown（本地文件，PRD P0-7） */
export function reportToMarkdown(r: Report, topic: Topic): string {
  const lines: string[] = []
  lines.push(`# 讨论报告：${topic.title}`)
  lines.push('')
  lines.push(`> 生成时间：${new Date(r.generatedAt).toLocaleString('zh-CN')}`)
  lines.push('')

  lines.push('## 执行摘要')
  lines.push('')
  lines.push(r.executiveSummary)
  lines.push('')

  lines.push('## 一、共识结论')
  lines.push('')
  if (r.consensus.length === 0) {
    lines.push('（本场未形成可确认的共识）')
  } else {
    r.consensus.forEach((c, i) => {
      lines.push(`${i + 1}. **${c.claim}**`)
      lines.push(`   - 认同模型：${c.supporters.join('、')}（${c.supporterCount} 个）`)
      lines.push(`   - 来源轮次：第 ${c.sourceRounds.join('、')} 轮`)
      lines.push(`   - 关键论据：${c.argument}`)
    })
  }
  lines.push('')

  lines.push('## 二、保留分歧')
  lines.push('')
  if (r.disputes.length === 0) {
    lines.push('（无保留分歧）')
  } else {
    r.disputes.forEach((d, i) => {
      lines.push(`${i + 1}. **${d.claim}**（始于第 ${d.openedRound} 轮）`)
      d.sides.forEach((s) => {
        lines.push(`   - ${s.agentId}（第 ${s.sourceRounds.join('、')} 轮）：${s.argument}`)
      })
      lines.push(`   - 未消解原因：${d.whyUnresolved}`)
    })
  }
  lines.push('')

  if (r.blindSpots.length > 0) {
    lines.push('## 三、未覆盖风险与盲区')
    lines.push('')
    r.blindSpots.forEach((b) => lines.push(`- ${b}`))
    lines.push('')
  }

  // 人类介入单列一章（PRD 5.5）
  if (r.interventions.length > 0) {
    lines.push('## 四、人类参与者的介入与影响')
    lines.push('')
    r.interventions.forEach((i) => lines.push(`- ${i}`))
    lines.push('')
    lines.push('> 人类介入已计入讨论记录，但**不计入共识度核算** —— 人的表态不等于模型共识。')
    lines.push('')
  }

  if (r.duels.length > 0) {
    lines.push('## 五、专项对辩')
    lines.push('')
    r.duels.forEach((d, i) => {
      lines.push(`${i + 1}. **${d.topic}**：${d.agentIds.join(' vs ')}（${d.utteranceCount} 条发言）`)
    })
    lines.push('')
  }

  lines.push('## 溯源信息')
  lines.push('')
  lines.push(`- 参与模型：${r.meta.models.map((m) => m.displayName).join('、')}`)
  lines.push(`- 轮次数：${r.meta.rounds}`)
  lines.push(`- 费用：$${r.meta.totalCostUsd.toFixed(4)}`)
  lines.push(`- 缺席模型：${r.meta.absentAgents.length > 0 ? r.meta.absentAgents.join('、') : '无'}`)
  lines.push(`- 人类介入：${r.meta.interventionCount} 次`)
  lines.push(`- 专项对辩：${r.meta.duelCount} 轮`)
  if (r.meta.finalConsensusScore) {
    const s = r.meta.finalConsensusScore
    lines.push(
      `- 最终共识度：${s.score}（立场一致度 ${s.agreement} / 论点重合度 ${s.overlap} / 收敛趋势 ${s.trend}）`,
    )
  } else {
    lines.push('- 最终共识度：不可用（无主持评估）')
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('本报告由 Torra 自动生成。共识结论均可溯源至具体轮次与发言；保留分歧项不应被视为已达成一致。')

  return lines.join('\n')
}
