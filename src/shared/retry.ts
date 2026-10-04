/**
 * 重试的领域模型（PRD 7.2 历史与 fork 继续讨论 / F6 复盘与二次讨论）
 *
 * 四种重试语义，差别在于「保留什么、重跑什么」：
 *
 * | mode          | 保留                          | 重跑              | 适用场景               |
 * |---------------|-------------------------------|-------------------|------------------------|
 * | rerun         | 无                            | 整场（从第 1 轮）  | 换一批随机种子重来     |
 * | continue      | 上一轮结论作为已知前提        | 整场（第 1 轮起）  | 刚才那场没聊透         |
 * | fill-missing  | 已完成轮次 + 已发言模型        | 仅缺席模型一轮    | 修正单点失败           |
 * | dispute       | 全部历史                      | 定点再辩          | 就某条分歧深挖         |
 *
 * 关键约束（与既有不变量一致）：
 * - `continue` 的上一轮结论以「已知前提」注入，**不得直接计入本轮共识点**，
 *   否则会出现"抄上一轮的答案"式假共识；
 * - `fill-missing` 不重跑已发言模型，避免浪费与重复；
 * - `dispute` 复用专项对辩机制，**不参与收敛度判定**。
 */

import type { SessionConfig, Topic } from './types'

export type RetryMode = 'rerun' | 'continue' | 'fill-missing' | 'dispute'

export const RETRY_MODE_LABEL: Record<RetryMode, string> = {
  rerun: '整场重跑',
  continue: '带着上一轮结论继续',
  'fill-missing': '仅重跑缺席模型',
  dispute: '就某个分歧点再辩',
}

export const RETRY_MODE_HINT: Record<RetryMode, string> = {
  rerun: '用相同议题、模型阵容与策略重新跑一场完整讨论，从第 1 轮开始。适合换一批采样重来。',
  continue:
    '把上一场的报告作为背景材料注入新一轮，原共识与分歧作为「已知前提」。原结论不计入本轮共识点。',
  'fill-missing': '保留已有轮次与已发言模型，仅让缺席/失败的模型补跑一轮，其余沿用。',
  dispute: '针对报告中的某一条保留分歧，只让两个相关模型就这一点直接交锋，突破轮次上限。',
}

/** 重试来源 */
export interface RetrySource {
  /** 来源会话 id */
  sessionId: string
  /** 来源议题快照 */
  topic: Topic
  config: SessionConfig
  /** 上一场的共识点（continue 模式用作已知前提） */
  confirmed: Array<{ claim: string; support: string[]; confirmedRound: number }>
  /** 上一场的未决分歧（dispute 模式供用户勾选） */
  open: Array<{
    id: string
    claim: string
    sides: Array<{ agentId: string; argument: string }>
    openedRound: number
    status?: 'open' | 'resolved'
  }>
  /** 上一场缺席的模型（fill-missing 模式的补跑对象） */
  absentAgentIds: string[]
  /** 上一场已发言的模型 */
  spokenAgentIds: string[]
  finishedReason: 'converged' | 'max-rounds' | 'aborted' | 'no-moderator'
  reportSummary: string
}

/** 重试计划 */
export interface RetryPlan {
  mode: RetryMode
  /** dispute 模式：选中的分歧 id */
  disputeId?: string
  /** dispute 模式：参与对辩的两个模型 */
  duelAgentIds?: string[]
  /** continue 模式：是否把上一轮结论作为已知前提注入 */
  usePriorConclusion?: boolean
  /** 本次重试可覆盖的轮次上限（默认沿用来源配置） */
  maxRoundsOverride?: number
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
  /** 面向用户的提示（如"本场无可补跑的缺席模型"） */
  notices: string[]
}

/**
 * 校验重试计划是否可执行。
 *
 * 这一步很重要：不可执行的重试如果直接放行，会让用户等一个必然失败的过程。
 */
export function validateRetryPlan(plan: RetryPlan, src: RetrySource): ValidationResult {
  const errors: string[] = []
  const notices: string[] = []

  switch (plan.mode) {
    case 'rerun':
      notices.push('将从第 1 轮重新开始，不保留上一场任何结论。')
      break

    case 'continue':
      if (src.confirmed.length === 0 && src.open.length === 0) {
        notices.push('上一场没有形成任何结论，"带结论继续"将退化为整场重跑。')
      } else {
        notices.push(
          `将以「已知前提」注入 ${src.confirmed.length} 条共识与 ${src.open.length} 项分歧。这些前提不计入本轮共识度。`,
        )
      }
      break

    case 'fill-missing': {
      if (src.absentAgentIds.length === 0) {
        errors.push('上一场没有缺席模型，无需补跑。可改用「整场重跑」。')
      } else {
        notices.push(`将补跑：${src.absentAgentIds.join('、')}。已发言模型沿用上一场结果。`)
      }
      break
    }

    case 'dispute': {
      if (!plan.disputeId) {
        errors.push('请选择要再辩的保留分歧。')
        break
      }
      if (!plan.duelAgentIds || plan.duelAgentIds.length < 2) {
        errors.push('请选择两个参与对辩的模型。')
        break
      }
      const d = src.open.find((x) => x.id === plan.disputeId)
      if (!d) {
        errors.push('选中的分歧不存在，可能来自更早的会话。')
        break
      }
      const involved = new Set(d.sides.map((s) => s.agentId))
      if (!plan.duelAgentIds.some((a) => involved.has(a))) {
        notices.push('所选模型都不是该分歧的原参与方，对辩质量可能受限。')
      }
      notices.push(`专项对辩不计入收敛度判定，会在报告的「专项对辩」章节单独呈现。`)
      break
    }
  }

  return { ok: errors.length === 0, errors, notices }
}

/** 列出历史会话可用的重试模式（禁用不可用的） */
export function availableRetryModes(src: RetrySource): Array<{
  mode: RetryMode
  enabled: boolean
  reason?: string
}> {
  return [
    { mode: 'rerun', enabled: true },
    { mode: 'continue', enabled: true },
    {
      mode: 'fill-missing',
      enabled: src.absentAgentIds.length > 0,
      reason: src.absentAgentIds.length === 0 ? '上一场无缺席模型' : undefined,
    },
    {
      mode: 'dispute',
      enabled: src.open.length > 0,
      reason: src.open.length === 0 ? '上一场无保留分歧' : undefined,
    },
  ]
}

/**
 * 构造「已知前提」文本块（continue 模式注入用）。
 *
 * 独立区块 + 显式声明"这些是上一场的结论，不是本轮的共识"——
 * 措辞很重要，否则模型会直接附和，形成假共识。
 */
export function renderPriorConclusion(src: RetrySource): string {
  if (src.confirmed.length === 0 && src.open.length === 0) return ''

  const lines: string[] = []
  lines.push('【上一场讨论的已知前提】')
  lines.push(
    '以下内容来自更早的一次讨论，是**参考前提而非本轮结论**。' +
      '请独立判断：可以认可、可以反驳、也可以指出其局限。不要因为它们被列出就默认认同。',
  )

  if (src.confirmed.length > 0) {
    lines.push('')
    lines.push('此前已确认的共识：')
    for (const c of src.confirmed) {
      lines.push(`- ${c.claim}（原支持方：${c.support.join('、')}，第 ${c.confirmedRound} 轮）`)
    }
  }

  const openItems = src.open.filter((o) => o.status !== 'resolved')
  if (openItems.length > 0) {
    lines.push('')
    lines.push('此前未消解的分歧（很可能仍需你重点回应）：')
    for (const d of openItems) {
      lines.push(`- ${d.claim}`)
      for (const s of d.sides) {
        lines.push(`    ${s.agentId} 曾主张：${s.argument}`)
      }
    }
  }

  return lines.join('\n')
}

/** 历史列表条目（渲染层用） */
export interface HistoryEntry {
  id: string
  title: string
  background: string
  strategy: string
  state: string
  finishedReason: 'converged' | 'max-rounds' | 'aborted' | 'no-moderator' | 'failed' | null
  createdAt: number
  updatedAt: number
  rounds: number
  totalCostUsd: number
  consensusCount: number
  openDisputeCount: number
  absentAgentIds: string[]
  interventionCount: number
  duelCount: number
  hasReport: boolean
  /** 本场是否由重试发起（重试链上的会话） */
  retryModeTag: string | null
  /** 失败/中止原因摘要，供用户判断为何要重试 */
  statusNote: string
}

export const FINISH_REASON_LABEL: Record<string, string> = {
  converged: '达成共识',
  'max-rounds': '轮次用尽',
  aborted: '用户中止',
  'no-moderator': '主持不可用',
  failed: '异常终止',
  running: '进行中',
}
