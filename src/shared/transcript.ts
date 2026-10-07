/**
 * 完整会话记录导出（transcript）
 *
 * 与 reportToMarkdown 的区别：报告只给结论摘要，这里逐条搬运所有发言，
 * 并附上每条发言「实际发给模型的输入」——用于复盘「模型当时看到了什么、说了什么」。
 * 纯函数：只吃 SessionRecord 与一个 id→显示名的解析器，主进程与渲染层共用。
 */

import { agreementDimNote } from './invariants'
import type { SessionRecord, Utterance } from './types'

const STANCE_LABEL: Record<string, string> = {
  support: '支持',
  oppose: '反对',
  neutral: '中立',
  conditional: '有条件',
}

const KIND_LABEL: Record<string, string> = {
  interject: '插话',
  followup: '追问',
  duel: '对辩',
  'set-stance': '调立场',
  stop: '终止',
}

const FINISH_LABEL: Record<string, string> = {
  converged: '结论收敛',
  'max-rounds': '轮次用尽',
  aborted: '用户中止',
  'no-moderator': '主持不可用',
  failed: '异常终止',
}

export interface TranscriptOptions {
  /** 是否包含每条发言发给模型的输入提示词（默认 true，这是「完整记录」的核心） */
  includeInput?: boolean
}

function fmtDuration(ms?: number): string {
  if (!ms || ms <= 0) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * targets 存的是发言 id（Utterance.targets 的契约），不是模型 id ——
 * 这里把它翻回「谁、第几轮」，直接拿 nameOf 印会把编号印成模型名。
 */
function replyLabelFor(
  utterances: readonly Utterance[],
  nameOf: (id: string) => string,
): (utteranceId: string) => string {
  const byId = new Map(utterances.map((u) => [u.id, u]))
  return (utteranceId) => {
    const t = byId.get(utteranceId)
    return t ? `${t.human ? '人类参与者' : nameOf(t.agentId)}（第 ${t.round} 轮）` : utteranceId
  }
}

function utteranceBlock(
  u: Utterance,
  nameOf: (id: string) => string,
  replyLabel: (utteranceId: string) => string,
  includeInput: boolean,
): string[] {
  const lines: string[] = []
  const who = u.human ? '人类参与者' : nameOf(u.agentId)
  const tags: string[] = [`第 ${u.round} 轮`]
  if (u.stance) tags.push(STANCE_LABEL[u.stance] ?? u.stance)
  if (u.absent) tags.push('缺席')
  if (u.human) tags.push('插话·不计入共识度')
  const dur = fmtDuration(u.endedAt - u.startedAt)
  if (dur) tags.push(dur)
  if (u.usage) tags.push(`↑${u.usage.promptTokens || 0} ↓${u.usage.completionTokens || 0} tok · $${u.usage.costUsd.toFixed(4)}`)

  lines.push(`### ${who}  \n*${tags.join(' · ')}*`)
  lines.push('')

  if (u.targets.length > 0) {
    lines.push(`> 回应：${u.targets.map(replyLabel).join('、')}`)
    lines.push('')
  }

  if (includeInput && (u.input?.system || u.input?.user)) {
    lines.push('<details><summary>输入 · 发给模型的提示词</summary>')
    lines.push('')
    if (u.input?.system) {
      lines.push('**[system]**')
      lines.push('')
      lines.push('```')
      lines.push(u.input.system)
      lines.push('```')
      lines.push('')
    }
    if (u.input?.user) {
      lines.push('**[user]**')
      lines.push('')
      lines.push('```')
      lines.push(u.input.user)
      lines.push('```')
      lines.push('')
    }
    lines.push('</details>')
    lines.push('')
  }

  if (u.thinking?.trim()) {
    lines.push('<details><summary>思考过程 · Thinking</summary>')
    lines.push('')
    lines.push('```')
    lines.push(u.thinking)
    lines.push('```')
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  if (u.steps?.trim()) {
    lines.push('<details><summary>执行过程 · Steps</summary>')
    lines.push('')
    lines.push('```')
    lines.push(u.steps)
    lines.push('```')
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  lines.push('**输出：**')
  lines.push('')
  lines.push(u.content || '（空）')
  lines.push('')
  // 半成功的轮次要在导出里留痕：只看报告的人需要知道这条回答是在缺输入的条件下给出的
  if (u.note) {
    lines.push(`> ⚠️ ${u.note}`)
    lines.push('')
  }
  return lines
}

export function buildTranscriptMarkdown(
  rec: SessionRecord,
  nameOf: (id: string) => string,
  opts: TranscriptOptions = {},
): string {
  const includeInput = opts.includeInput ?? true
  const lines: string[] = []

  lines.push(`# 完整讨论记录：${rec.topic.title || '未命名议题'}`)
  lines.push('')
  lines.push(`> 会话 ID：\`${rec.id}\` 导出时间：${new Date().toLocaleString('zh-CN')}`)
  lines.push('')

  // 概览
  const lastScore = rec.scores.length > 0 ? rec.scores[rec.scores.length - 1]!.score : null
  lines.push('## 概览')
  lines.push('')
  lines.push(`- 结束状态：${rec.finishedReason ? FINISH_LABEL[rec.finishedReason] ?? rec.finishedReason : rec.state}`)
  lines.push(`- 参与模型：${rec.config.participantIds.map(nameOf).join('、') || '—'}`)
  lines.push(`- 主持模型：${rec.config.moderatorId ? nameOf(rec.config.moderatorId) : '无'}`)
  lines.push(`- 轮次：${rec.scores.length} / ${rec.config.maxRounds}（共识阈值 ${rec.config.consensusThreshold}）`)
  lines.push(`- 总费用：$${rec.totalCostUsd.toFixed(4)}`)
  if (lastScore) {
    const note = agreementDimNote(lastScore)
    lines.push(
      `- 最终共识度：${lastScore.score}（主张一致 ${lastScore.agreement} / 重合 ${lastScore.overlap} / 趋势 ${lastScore.trend}）${note ? ` —— ${note}` : ''}`,
    )
  }
  lines.push('')

  if (rec.topic.background) {
    lines.push('## 背景材料')
    lines.push('')
    lines.push(rec.topic.background)
    lines.push('')
  }

  // 逐轮发言
  lines.push('## 讨论全文')
  lines.push('')
  const replyLabel = replyLabelFor(rec.utterances, nameOf)
  const byRound = new Map<number, Utterance[]>()
  for (const u of rec.utterances) {
    const arr = byRound.get(u.round) ?? []
    arr.push(u)
    byRound.set(u.round, arr)
  }
  const roundNums = [...byRound.keys()].sort((a, b) => a - b)
  if (roundNums.length === 0) {
    lines.push('（本场没有任何发言）')
    lines.push('')
  }
  for (const r of roundNums) {
    lines.push(`---`)
    lines.push('')
    lines.push(`## 第 ${r} 轮`)
    lines.push('')
    for (const u of byRound.get(r) ?? []) {
      lines.push(...utteranceBlock(u, nameOf, replyLabel, includeInput))
    }
  }

  // 收敛过程
  if (rec.scores.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## 共识度收敛')
    lines.push('')
    lines.push('| 轮次 | 综合 | 主张一致 | 论点重合 | 收敛趋势 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const s of rec.scores) {
      lines.push(`| ${s.round} | ${s.score.score} | ${s.score.agreement} | ${s.score.overlap} | ${s.score.trend} |`)
    }
    lines.push('')
  }

  // 共识与分歧
  if (rec.confirmed.length > 0 || rec.open.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## 共识与分歧')
    lines.push('')
    if (rec.confirmed.length > 0) {
      lines.push('### 已达成共识')
      lines.push('')
      rec.confirmed.forEach((c, i) => {
        lines.push(`${i + 1}. **${c.claim}**（置信 ${c.confidence}，第 ${c.confirmedRound} 轮确认）`)
        lines.push(`   - 认同：${c.support.map(nameOf).join('、')}`)
      })
      lines.push('')
    }
    const openDisputes = rec.open.filter((d) => d.status === 'open')
    if (openDisputes.length > 0) {
      lines.push('### 保留分歧')
      lines.push('')
      openDisputes.forEach((d, i) => {
        lines.push(`${i + 1}. **${d.claim}**（始于第 ${d.openedRound} 轮）`)
        d.sides.forEach((s) => lines.push(`   - ${nameOf(s.agentId)}：${s.argument}`))
      })
      lines.push('')
    }
  }

  // 人类介入
  if (rec.interventions.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## 人类介入')
    lines.push('')
    for (const iv of rec.interventions) {
      const label = KIND_LABEL[iv.kind] ?? iv.kind
      const target =
        iv.targetAgentId ? ` → ${nameOf(iv.targetAgentId)}`
        : iv.duelAgentIds?.length ? ` → ${iv.duelAgentIds.map(nameOf).join(' vs ')}`
        : iv.stanceAgentId ? ` → ${nameOf(iv.stanceAgentId)}`
        : ''
      lines.push(`- **${label}**（第 ${iv.atRound} 轮${target}）：${iv.text}`)
    }
    lines.push('')
  }

  // 报告（若已生成）
  if (rec.report) {
    lines.push('---')
    lines.push('')
    lines.push('## 结论报告')
    lines.push('')
    lines.push(rec.report.executiveSummary || '（无摘要）')
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('> 由 Torra 导出的完整讨论记录。输入提示词反映各模型当时实际收到的上下文，可用于复盘。')

  return lines.join('\n')
}
