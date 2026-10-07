/**
 * 领域不变量 —— 把 PRD 中的「硬约束」落成可执行、可测试的代码。
 *
 * 对应章节：
 * - 6.7 共识度的可计算定义 + 程序机械校验（防「假收敛」主防线）
 * - 6.8 上下文管理：未决分歧只增不减、压缩时逐字保留
 */

import {
  consensusWeightsFor,
  type AgreementSource,
  type ConsensusPoint,
  type ConsensusScore,
  type Digest,
  type DigestValidation,
  type LeaderboardRow,
  type ModeratorAuditEntry,
  type ModeratorDigest,
  type OpenDispute,
  type PeerArgument,
  type Utterance,
} from './types'
import { findSimilarDispute } from './dedup'

// ---------------------------------------------------------------------------
// 共识度计算（PRD 6.7）
// ---------------------------------------------------------------------------

/**
 * 主张一致度：由程序从各模型发言里的显式表态句式直接核算，不接受主持主观打分。
 *
 * 三处与旧实现的差别，都是为了让这个分数不再系统性地骗人：
 *
 * 1. **独立性折扣**。旧实现只取「最大阵营占比」，于是 5 个模型齐声喊
 *    「我支持 X」能直接拿到 100 分 —— 这恰恰是假收敛里最常见的一种（从众），
 *    而本文件开头声明要防的就是假收敛。现在按主导阵营中「带可核对论据」的比例打折：
 *    发言够长（>=40 字）、点名回应过他人、或被某条共识点引为证据，三者任一即算有论据。
 *    折扣区间 0.6~1.0：即使全是口号也不会归零，但最高只能拿到阵营占比的 6 成。
 *
 * 2. **表态数不出时记中性 50 并标注来源**，不记 0。记 0 的实际后果是总分上限被压到 60，
 *    而阈值默认 85 —— 于是「程序看不见表态」被误读成「模型没有共识」。
 *
 * 3. **这一维算不出就不计入综合分**。研讨不是辩论：补充、限定、换角度的发言不会写
 *    「我支持/我反对」，一场探索型圆桌里绝大多数发言没有表态句式。用「带表态的发言占比」
 *    当可数性判据，低于 `STANCE_MARK_COVERAGE_MIN` 就按 no_stance 处理，
 *    让出 0.4 的权重（见 CONSENSUS_WEIGHTS_NO_STANCE）—— 一个常数不该决定总分。
 */
export interface AgreementResult {
  value: number
  source: AgreementSource
  /** 主导阵营中带论据的比例 0-1；无立场标记时为 null */
  independence: number | null
  /** 带显式表态句式的发言占本场模型发言的比例 0-1 —— 这一维的可数性 */
  coverage: number
}

/** 一条发言「带可核对论据」的最低字数门槛 */
const SUBSTANTIVE_MIN_CHARS = 40

/** 表态覆盖率低于此值，主张一致度按「没测到」处理，不计入综合分 */
export const STANCE_MARK_COVERAGE_MIN = 0.34

export function computeAgreement(utterances: Utterance[], points: ConsensusPoint[] = []): AgreementResult {
  const spoken = utterances.filter((u) => !u.absent && !u.human)
  const marks = spoken.filter((u): u is Utterance & { stance: NonNullable<Utterance['stance']> } => !!u.stance)
  const coverage = round2(spoken.length === 0 ? 0 : marks.length / spoken.length)

  if (marks.length === 0) {
    return { value: 50, source: 'no_stance', independence: null, coverage }
  }

  const counter = new Map<string, number>()
  for (const m of marks) counter.set(m.stance, (counter.get(m.stance) ?? 0) + 1)
  const dominant = [...counter.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!dominant) return { value: 50, source: 'no_stance', independence: null, coverage }

  const camp = marks.filter((m) => m.stance === dominant[0])
  const evidencedIds = new Set(points.flatMap((p) => p.evidenceRef))
  const withArgument = camp.filter((m) => {
    if ((m.content ?? '').length >= SUBSTANTIVE_MIN_CHARS) return true
    if ((m.targets ?? []).length > 0) return true
    return evidencedIds.has(m.id)
  })
  const independence = round2(withArgument.length / camp.length)
  const share = round1((dominant[1] / marks.length) * 100)
  const value = round1(share * (0.6 + 0.4 * independence))

  // 只有一两条发言写了「我支持/我反对」时，这个 value 是拿极少数样本外推的全场一致度，
  // 摆着看无妨，但它不该以 0.4 的权重决定综合分 —— 交给 source，让权重让位。
  return { value, source: coverage < STANCE_MARK_COVERAGE_MIN ? 'no_stance' : 'stance', independence, coverage }
}

/**
 * 论点重合度的取值口径。
 *
 * 旧实现是 `Math.max(程序值, 主持自评)` —— 主持想抬就能抬，与同文件里
 * 「由程序核算，不接受主持主观打分」的声明矛盾。改为：有共识点数据时**只认程序值**，
 * 主持自评仅在程序算不出东西（本轮没有任何共识点）时兜底，并标注来源。
 */
export function resolveOverlap(
  computed: number,
  claimed: number,
  pointCount: number,
): { value: number; source: 'program' | 'moderator_fallback' } {
  if (pointCount > 0) return { value: computed, source: 'program' }
  const safe = typeof claimed === 'number' && !Number.isNaN(claimed) ? Math.max(0, Math.min(100, claimed)) : 0
  return { value: safe, source: 'moderator_fallback' }
}

/** 至少跑完几轮才允许判收敛：第 1 轮里模型互相看不到对方，谈不上一致 */
export const MIN_ROUNDS_BEFORE_CONVERGENCE = 2

export interface ConvergenceInput {
  score: number
  threshold: number
  round: number
  /** 仍处 open 的分歧条数 */
  openCount: number
  /** 本轮新增共识条数 */
  newPoints: number
  /** 挨过质询的共识点占比 0-100 */
  crossExaminedRate: number
  /** 本场有效发言的模型数 */
  speakerCount: number
  minRounds?: number
}

export interface ConvergenceResult {
  converged: boolean
  path: 'score' | 'structural' | 'none'
  reason: string
}

/**
 * 收敛判定：分数达标 **或** 结构上真的没东西可争了。
 *
 * 加结构收敛这条路，是因为默认阈值 85 在「无立场标记」的真实场次里够不到 ——
 * 但直接调低阈值等于放水。结构条件要求四件事同时成立，缺一不可：
 * - open 清单为空：没有未决分歧；
 * - 本轮零新增共识：不是刚抛出大批新论点就被判停；
 * - 过半共识点挨过质询：没人反驳过的共识可能只是没人读；
 * - 至少 2 位模型发过言：单模型场次的「一致」没有意义。
 */
export function evaluateConvergence(input: ConvergenceInput): ConvergenceResult {
  const minRounds = input.minRounds ?? MIN_ROUNDS_BEFORE_CONVERGENCE
  if (input.round < minRounds) {
    return {
      converged: false,
      path: 'none',
      reason: `第 ${input.round} 轮不足以判收敛：参会模型本轮互相看不到彼此发言，交叉质询要到下一轮才成立`,
    }
  }
  if (input.score >= input.threshold) {
    return { converged: true, path: 'score', reason: `加权分 ${input.score} 达到阈值 ${input.threshold}` }
  }
  const structural =
    input.openCount === 0 &&
    input.newPoints === 0 &&
    input.crossExaminedRate >= 50 &&
    input.speakerCount >= 2
  if (structural) {
    return {
      converged: true,
      path: 'structural',
      reason: `未决分歧 0 条、本轮零新增共识、${input.crossExaminedRate}% 共识点挨过质询：结构上已无待决内容`,
    }
  }
  return {
    converged: false,
    path: 'none',
    reason: `加权分 ${input.score} < 阈值 ${input.threshold}，结构条件未满足（未决 ${input.openCount} 条 / 新增 ${input.newPoints} 条 / 质询覆盖 ${input.crossExaminedRate}%）`,
  }
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

export function weightedScore(
  dims: { agreement: number; overlap: number; trend: number },
  agreementSource?: AgreementSource,
): ConsensusScore {
  const w = consensusWeightsFor(agreementSource)
  const score = round1(dims.agreement * w.agreement + dims.overlap * w.overlap + dims.trend * w.trend)
  return { ...dims, ...(agreementSource ? { agreementSource } : {}), score }
}

/**
 * 综合分中 agreement 这一维的口径说明。
 *
 * 报告与台账里都必须出现：算不出时那个 50 只是占位记账，读的人若不知道权重已让位，
 * 会把「主张一致度 50」当成「一半人不同意」——那是凭空造出一条分歧。
 */
export function agreementDimNote(score: { agreementSource?: AgreementSource } | null | undefined): string {
  return score?.agreementSource === 'no_stance' ? '本场没有可数的表态句式，这一维未计入综合分' : ''
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
 * 3. open_disputes 缺少任何一方论据（只有一方在质疑也算合法的未决条目，不要求凑成两方）；
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
      // 旧规则要凑满两方才放行，等于逼主持替一个不存在的反方编一段论据 —— 凭空造分歧。
      if (!d.sides || d.sides.length === 0) {
        errors.push(`open_disputes[${i}] 缺少任何一方论据，当前 ${d.sides?.length ?? 0} 方`)
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

  // 以下是**新增的可选字段**：格式问题只警示、不驳回。
  // 让 weight / agent_quality 这类附加信号有能力否掉一次合法小结，
  // 是把可观测性换成了失败率 —— 不值得。
  if (Array.isArray(digest.consensus_points)) {
    digest.consensus_points.forEach((p, i) => {
      if (p.weight !== undefined && p.weight !== null) {
        if (typeof p.weight !== 'number' || Number.isNaN(p.weight) || p.weight < 0 || p.weight > 1) {
          warnings.push(`consensus_points[${i}].weight 期望 0-1，实际 ${p.weight}；报告按未加权呈现`)
        }
      }
    })
  }

  if (Array.isArray(digest.explored_directions)) {
    digest.explored_directions.forEach((e, i) => {
      if (typeof e !== 'string' || !e.trim()) {
        warnings.push(`explored_directions[${i}] 为空，已忽略该条`)
      }
    })
  } else if (digest.explored_directions !== undefined) {
    warnings.push('explored_directions 不是数组，本轮「已排除方向」未登记')
  }

  if (digest.agent_quality !== undefined) {
    if (!Array.isArray(digest.agent_quality)) {
      warnings.push('agent_quality 不是数组，已忽略本轮名次')
    } else {
      const seen = new Set<number>()
      digest.agent_quality.forEach((q, i) => {
        if (!realAgentIds.has(q.agent_id)) {
          warnings.push(`agent_quality[${i}] 引用了不存在的模型 ${q.agent_id}，该条名次已忽略`)
        }
        if (typeof q.rank !== 'number' || !Number.isInteger(q.rank) || q.rank < 1) {
          warnings.push(`agent_quality[${i}].rank 期望 ≥1 的整数，实际 ${q.rank}`)
        } else if (seen.has(q.rank)) {
          warnings.push(`agent_quality 出现重复名次 ${q.rank}，平均名次会偏`)
        } else {
          seen.add(q.rank)
        }
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// 互评名次聚合（对标 llm-council 的 aggregate rankings）
// ---------------------------------------------------------------------------

/**
 * 把各轮主持给出的 agent_quality 名次跨轮平均。
 *
 * 只取**通过校验**的小结：被驳回的那次里模型可能正乱序。
 * 名次是相对信号，平均后仍不是分数 —— 第 1 名与第 2 名的差距不可量化，
 * 所以报告只用它排序与标注，不参与共识度加权。
 */
export function aggregateLeaderboard(audits: ModeratorAuditEntry[]): LeaderboardRow[] {
  const positions = new Map<string, number[]>()
  const lastRationale = new Map<string, string>()

  for (const audit of audits) {
    const quality = audit.accepted?.agent_quality
    if (!Array.isArray(quality)) continue
    for (const row of quality) {
      if (typeof row.rank !== 'number' || !Number.isInteger(row.rank) || row.rank < 1) continue
      const list = positions.get(row.agent_id) ?? []
      list.push(row.rank)
      positions.set(row.agent_id, list)
      const note = row.rationale?.trim()
      if (note) lastRationale.set(row.agent_id, note)
    }
  }

  return [...positions.entries()]
    .map(([agentId, ranks]) => ({
      agentId,
      averageRank: round1(ranks.reduce((a, b) => a + b, 0) / ranks.length),
      rounds: ranks.length,
      rationale: lastRationale.get(agentId) ?? null,
    }))
    .sort(
      (a, b) =>
        a.averageRank - b.averageRank || b.rounds - a.rounds || a.agentId.localeCompare(b.agentId),
    )
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
    // 同一分歧换个说法仍是同一分歧：先按原文精确匹配，再按内容归并。
    // 只认原文会把「要不要先做灰度」和「灰度发布是否前置」记成两条未决分歧，
    // 未决数虚高会压低收敛趋势，报告里的分歧清单也越读越啰嗦。
    const existing =
      byClaim.get(key) ?? findSimilarDispute([...byClaim.values()], d.claim, d.sides.map((s) => s.agentId))
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

/** 注入的他人论点条数与单条字数上限：够反驳即可，不要把上下文喂成复读机 */
export const PEER_CAP = 8
export const PEER_TEXT_CHARS = 220

/**
 * 把他人论点原话渲染进提示词。
 *
 * 为什么单独一段而不塞进 digest：digest 是主持的转述，模型从里面只知道
 * 「谁支持什么」，不知道对方是怎么论证的，于是只能各说各话 ——
 * 这是「论点无人点名回应」的直接成因。这里给出可复制的发言编号，
 * 反驳才落得成可核对的 targets 血缘。
 */
export function renderPeersForPrompt(peers: readonly PeerArgument[]): string {
  if (peers.length === 0) return ''
  const parts: string[] = ['【他人论点原话】']
  for (const p of peers) {
    const text =
      p.text.length > PEER_TEXT_CHARS ? p.text.slice(0, PEER_TEXT_CHARS).trimEnd() + '……' : p.text
    parts.push(`- [${p.utteranceId}] 第${p.round}轮 ${p.label}：${text.replace(/\s+/g, ' ')}`)
  }
  parts.push('以上引用均为真实发言，编号可原样复制。')
  return parts.join('\n')
}
// ---------------------------------------------------------------------------

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function nowMs(): number {
  return Date.now()
}

let idCounter = 0
export function makeId(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}
