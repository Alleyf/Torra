/**
 * 领域不变量 —— 把 PRD 中的「硬约束」落成可执行、可测试的代码。
 *
 * 对应章节：
 * - 6.7 共识度的可计算定义 + 程序机械校验（防「假收敛」主防线）
 * - 6.8 上下文管理：未决分歧只增不减、压缩时逐字保留
 */

import {
  CONSENSUS_WEIGHTS,
  type ConsensusPoint,
  type ConsensusScore,
  type Digest,
  type DigestValidation,
  type ModeratorDigest,
  type OpenDispute,
  type Utterance,
} from './types'

// ---------------------------------------------------------------------------
// 共识度计算（PRD 6.7）
// ---------------------------------------------------------------------------

/**
 * 立场一致度：由程序从各模型发言的立场标记直接核算，不接受主持主观打分。
 *
 * 规则：取所有发言立场标记中占比最高的阵营的比例。
 * 无立场标记的发言不计入分母。
 */
export function computeAgreement(utterances: Utterance[]): number {
  const marks = utterances.map((u) => u.stance).filter((s): s is NonNullable<typeof s> => !!s)
  if (marks.length === 0) return 0
  const counter = new Map<string, number>()
  for (const m of marks) counter.set(m, (counter.get(m) ?? 0) + 1)
  const max = Math.max(...counter.values())
  return round1((max / marks.length) * 100)
}

/**
 * 论点重合度：被 >= 2 个模型共同提及的论点占比。
 *
 * 主持须在 consensus_points 中列出论点及其 support；本函数只做机械核算：
 * 支持方数量 >= 2 的共识点占比即为重合度。
 */
export function computeOverlap(points: ConsensusPoint[]): number {
  if (points.length === 0) return 0
  const shared = points.filter((p) => new Set(p.support).size >= 2)
  return round1((shared.length / points.length) * 100)
}

/**
 * 收敛趋势：未决分歧数量相对上轮的变化。
 * 分歧减少 → 分数上升；持平 → 50；增加 → 下降。
 */
export function computeTrend(currentOpen: number, previousOpen: number | null): number {
  if (previousOpen === null) return 50
  if (currentOpen === 0) return 100
  const delta = previousOpen - currentOpen
  return Math.max(0, Math.min(100, round1(50 + delta * 25)))
}

export function weightedScore(dims: {
  agreement: number
  overlap: number
  trend: number
}): ConsensusScore {
  const score = round1(
    dims.agreement * CONSENSUS_WEIGHTS.agreement +
      dims.overlap * CONSENSUS_WEIGHTS.overlap +
      dims.trend * CONSENSUS_WEIGHTS.trend,
  )
  return { ...dims, score }
}

// ---------------------------------------------------------------------------
// 主持小结的机械校验（PRD 6.7 —— 防假收敛主防线）
// ---------------------------------------------------------------------------

/**
 * 校验主持输出的结构化小结。
 *
 * 拒绝条件（PRD 6.7 + 附录 A 硬约束）：
 * 1. consensus_points 的 support 指向不存在的发言 id —— 即凭空生成共识；
 * 2. evidence_ref 缺失 —— 共识点必须指向具体发言；
 * 3. open_disputes 缺少任何一方论据；
 * 4. score_dimensions 缺任一维度。
 *
 * 校验失败 → 拒绝该次小结，要求主持重打。
 */
export function validateModeratorDigest(
  digest: ModeratorDigest,
  realUtteranceIds: Set<string>,
  realAgentIds: Set<string>,
): DigestValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!digest.score_dimensions) {
    errors.push('score_dimensions 缺失：共识度必须按三维度分别给分，不接受单一主观总分')
  }
  for (const key of ['agreement', 'overlap', 'trend'] as const) {
    const v = digest.score_dimensions?.[key]
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 100) {
      errors.push(`score_dimensions.${key} 非法：必须为 0-100 的数值`)
    }
  }

  if (!Array.isArray(digest.consensus_points)) {
    errors.push('consensus_points 缺失')
  } else {
    digest.consensus_points.forEach((p, i) => {
      if (!p.claim || !p.claim.trim()) {
        errors.push(`consensus_points[${i}].claim 为空`)
      }
      const phantom = (p.support ?? []).filter((id) => !realAgentIds.has(id))
      if (phantom.length > 0) {
        errors.push(
          `consensus_points[${i}] 声称的共识没有真实发言支撑：support 含不存在的模型 ${phantom.join(', ')}`,
        )
      }
      const phantomRef = (p.evidence_ref ?? []).filter((id) => !realUtteranceIds.has(id))
      if (phantomRef.length > 0) {
        errors.push(
          `consensus_points[${i}].evidence_ref 指向不存在的发言 id：${phantomRef.join(', ')}`,
        )
      }
      if (!p.evidence_ref || p.evidence_ref.length === 0) {
        errors.push(`consensus_points[${i}] 缺少 evidence_ref：共识点必须指向具体发言，不得凭空生成`)
      }
      if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1) {
        warnings.push(`consensus_points[${i}].confidence 期望 0-1，实际 ${p.confidence}`)
      }
    })
  }

  if (!Array.isArray(digest.open_disputes)) {
    errors.push('open_disputes 缺失')
  } else {
    digest.open_disputes.forEach((d, i) => {
      if (!d.sides || d.sides.length < 2) {
        errors.push(`open_disputes[${i}] 至少需要两方论据，当前 ${d.sides?.length ?? 0} 方`)
      }
      d.sides?.forEach((s, j) => {
        if (!realAgentIds.has(s.agent_id)) {
          errors.push(`open_disputes[${i}].sides[${j}] 引用了不存在的模型 ${s.agent_id}`)
        }
        if (!s.argument || !s.argument.trim()) {
          errors.push(`open_disputes[${i}].sides[${j}] 论据为空`)
        }
      })
    })
  }

  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// 未决分歧生命周期（PRD 6.8 硬约束：只增不减）
// ---------------------------------------------------------------------------

/**
 * 合并上一轮的 open 清单与主持新登记的分歧。
 *
 * 硬约束（PRD 6.8）：
 * - 历史 open 条目不会因为本轮未提及而消失；
 * - 仅当新条目显式提供 resolutionRef 时才可标记为 resolved；
 * - resolved 必须带消解依据，否则拒绝。
 */
export function mergeOpenDisputes(
  previous: OpenDispute[],
  incoming: OpenDispute[],
  round: number,
): { merged: OpenDispute[]; rejected: string[] } {
  const rejected: string[] = []
  const byClaim = new Map<string, OpenDispute>()

  for (const d of previous) {
    byClaim.set(d.claim.trim(), { ...d })
  }

  for (const d of incoming) {
    const key = d.claim.trim()
    if (!key) {
      rejected.push('分歧 claim 为空，已丢弃')
      continue
    }
    const existing = byClaim.get(key)
    if (existing) {
      // 已存在的分歧：只允许更新进展或显式消解
      if (d.status === 'resolved') {
        if (!d.resolutionRef || d.resolutionRef.length === 0) {
          rejected.push(
            `分歧「${key}」被标记为已消解但未提供消解依据，按 PRD 6.8 拒绝该消解，保留为 open`,
          )
          existing.lastProgress = d.lastProgress ?? existing.lastProgress
        } else {
          existing.status = 'resolved'
          existing.resolutionRef = d.resolutionRef
          existing.lastProgress = d.lastProgress ?? existing.lastProgress
        }
      } else {
        existing.lastProgress = d.lastProgress ?? existing.lastProgress
        // 补充新出现的论据，但不覆盖既有 sides
        for (const s of d.sides) {
          if (!existing.sides.some((x) => x.agentId === s.agentId)) {
            existing.sides.push(s)
          }
        }
      }
    } else {
      byClaim.set(key, { ...d, openedRound: d.openedRound ?? round })
    }
  }

  return { merged: [...byClaim.values()], rejected }
}

/** 仍处 open 状态的条目 */
export function openOnly(list: OpenDispute[]): OpenDispute[] {
  return list.filter((d) => d.status === 'open')
}

// ---------------------------------------------------------------------------
// 上下文压缩（PRD 6.8）
// ---------------------------------------------------------------------------

/**
 * 压缩历史纪要。
 *
 * 硬约束：confirmed 与 explored 可被概括，open 清单逐字搬运、不经改写。
 * 这里用类型系统 + 运行时断言双重保证 open 不被改写。
 */
export function compressDigest(
  full: Digest,
  summarizer: (input: { confirmed: ConsensusPoint[]; explored: string[]; rounds: Digest['rounds'] }) => {
    confirmed: ConsensusPoint[]
    explored: string[]
  },
): Digest {
  const { confirmed, explored } = summarizer({
    confirmed: full.confirmed,
    explored: full.explored,
    rounds: full.rounds,
  })

  // 逐字搬运未决分歧：不传给摘要器，避免被概括
  const openLiteral: OpenDispute[] = full.open.map((d) => ({
    ...d,
    sides: d.sides.map((s) => ({ ...s })),
  }))

  return {
    confirmed,
    open: openLiteral,
    explored,
    rounds: full.rounds,
  }
}

/**
 * 把 Digest 渲染为注入模型的文本（PRD 附录 B）。
 * 未决分歧必须显式呈现给参会模型 —— 否则模型不知道自己该反驳什么，
 * 只能重复已有观点，这是「假收敛」在发言侧的诱因。
 */
export function renderDigestForPrompt(digest: Digest): string {
  const parts: string[] = []

  parts.push('【已确认共识】')
  if (digest.confirmed.length === 0) {
    parts.push('（暂无）')
  } else {
    digest.confirmed.forEach((c, i) => {
      parts.push(`${i + 1}. ${c.claim}（支持方 ${c.support.join('、')}，确认于第 ${c.confirmedRound} 轮）`)
    })
  }

  parts.push('')
  parts.push('【当前仍存未决分歧】')
  const opens = openOnly(digest.open)
  if (opens.length === 0) {
    parts.push('（暂无）')
  } else {
    opens.forEach((d, i) => {
      parts.push(`${i + 1}. ${d.claim}`)
      d.sides.forEach((s) => {
        parts.push(`   - ${s.agentId}：${s.argument}`)
      })
    })
  }

  if (digest.explored.length > 0) {
    parts.push('')
    parts.push('【已充分讨论并排除的方向】')
    digest.explored.forEach((e) => parts.push(`- ${e}`))
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function nowMs(): number {
  return Date.now()
}

let idCounter = 0
export function makeId(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}
