/**
 * 幻觉治理 —— 多模型讨论里的误差累积与自我矫正
 *
 * 这里只处理**本场内部可判死**的幻觉，不去碰需要外部知识的对错：
 *
 * | 信号 | 判据 | 为什么会随轮次变糟 |
 * |---|---|---|
 * | 凭空引用 | 发言里引用了不存在的发言 id / 尚未发生的轮次 / 不在场的参会者 | 下一轮别的模型会把它当作既定事实接住 |
 * | 代答归因 | 主持把某模型列为支持者，但该模型本人发言里没有对应论述 | 第三轮起，模型看到的是「已确认共识」，等于把自己的话当外部证据 |
 * | 空心改写 | 共识点措辞跨轮变化，但 evidence 一条没加 | 说法越传越具体，来源却始终是空的 |
 * | 主持抬分 | 主持自评维度高于程序机械核算值 | 收敛判定被主持的乐观偏差推动 |
 *
 * 四条都是纯函数，不依赖 Electron，可脱机跑（与 tools.ts / invariants.ts 同一套取舍）。
 * 判据必须能被用户复算，因此宁少勿滥：不做语义猜测、不做 NLU。
 */

import { endorsementProvenance, type ProvenanceUtterance } from './anonymity'
import type {
  CitationAudit,
  ConsensusPoint,
  ConsensusVerification,
  ConsensusVerificationStatus,
  CorrectionIssue,
  CorrectionOutcome,
  HallucinationCorrection,
  HallucinationReport,
  HallucinationRoundRecord,
  HallucinationTrajectory,
  VerifyPassMode,
} from './types'

// ---------------------------------------------------------------------------
// 1. 凭空引用
// ---------------------------------------------------------------------------

/** 核验一条发言的引用需要知道什么 */
export interface CitationIndex {
  /** 本场已存在的发言 id（含此前所有轮次） */
  utteranceIds: Set<string>
  /** 当前轮次；引用第 N 轮时 N>当前轮即为「引用还没发生的讨论」 */
  round: number
  /**
   * 合法别名清单（匿名轨）。署名轨传空数组 —— 署名轨里模型提到「GPT-4」
   * 无法在本场判死，硬要判只会产生假阳性。
   */
  aliases: string[]
}

const UTT_REF = /\butt_[A-Za-z0-9_]+\b/g
const ROUND_REF = /第\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*轮/g
/** 别名形态：参会者A / 参会者甲 —— 与 buildAliasMap 的生成规则一致 */
const LABEL_REF = /参会者([A-Za-z\u4e00-\u9fa5]{1,2})/g

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

function toNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token)
  if (token.length === 1) return CN_DIGITS[token] ?? null
  // 「十一」~「十九」够用即可；再往上不是本场的合理轮次
  if (token.startsWith('十')) return 10 + (CN_DIGITS[token[1] ?? ''] ?? 0)
  return null
}

/**
 * 抽取并核验一条发言里的引用标记。
 *
 * 只认显式标记（[utt_x]、第N轮、参会者X）：这三种是提示词要求模型使用的格式，
 * 因此「没按格式引用」不会被记为幻觉 —— 我们惩罚的是引用了不存在的东西。
 */
export function auditCitations(content: string, index: CitationIndex): CitationAudit {
  const validUtteranceIds: string[] = []
  const bogusUtteranceIds: string[] = []
  for (const m of content.matchAll(UTT_REF)) {
    const id = m[0]
    if (index.utteranceIds.has(id)) {
      if (!validUtteranceIds.includes(id)) validUtteranceIds.push(id)
    } else if (!bogusUtteranceIds.includes(id)) {
      bogusUtteranceIds.push(id)
    }
  }

  const roundRefs: number[] = []
  const outOfRangeRounds: number[] = []
  for (const m of content.matchAll(ROUND_REF)) {
    const n = toNumber(m[1] ?? '')
    if (n === null) continue
    if (!roundRefs.includes(n)) roundRefs.push(n)
    // 本轮发言不能引用本轮之后的轮次；第 0 轮不存在
    if (n < 1 || n > index.round) {
      if (!outOfRangeRounds.includes(n)) outOfRangeRounds.push(n)
    }
  }

  const unknownLabels: string[] = []
  if (index.aliases.length > 0) {
    const known = new Set(index.aliases)
    for (const m of content.matchAll(LABEL_REF)) {
      const label = `参会者${m[1] ?? ''}`
      if (!known.has(label) && !unknownLabels.includes(label)) unknownLabels.push(label)
    }
  }

  return {
    validUtteranceIds,
    bogusUtteranceIds,
    roundRefs,
    outOfRangeRounds,
    unknownLabels,
    noCitations:
      validUtteranceIds.length === 0 &&
      bogusUtteranceIds.length === 0 &&
      roundRefs.length === 0 &&
      unknownLabels.length === 0,
  }
}

/** 这条发言是否含「本场可判死」的凭空引用 */
export function hasBadCitation(audit: CitationAudit | undefined): boolean {
  if (!audit) return false
  return audit.bogusUtteranceIds.length > 0 || audit.outOfRangeRounds.length > 0 || audit.unknownLabels.length > 0
}

/**
 * 把凭空引用整理成下一轮要回灌给该模型的问题文本。
 *
 * 为什么要当场拦：幻觉一旦进入下一轮的「讨论记录」，其他模型会把它当既有事实
 * 继续论证 —— 错误就从「一条发言」升级为「全场前提」。
 */
export function buildCitationChallenge(audit: CitationAudit | undefined): string | null {
  if (!audit || !hasBadCitation(audit)) return null
  const parts: string[] = []
  if (audit.bogusUtteranceIds.length > 0) {
    parts.push(`你引用的发言并不存在：${audit.bogusUtteranceIds.join('、')}`)
  }
  if (audit.outOfRangeRounds.length > 0) {
    parts.push(`你引用了尚未发生的轮次：第 ${audit.outOfRangeRounds.join('、')} 轮`)
  }
  if (audit.unknownLabels.length > 0) {
    parts.push(`你提到了不在本场参会名单中的对象：${audit.unknownLabels.join('、')}`)
  }
  return [
    '【引用核验】',
    ...parts,
    '请先说明这些引用从何而来；若确实没有依据，请直接撤回该论点并重新给出你的立场，不要重复原表述。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 2. 代答归因（主持替模型表态）
// ---------------------------------------------------------------------------

/** 一条共识点上「声称支持但本人发言里没有原文」的模型 */
export interface AttributedEndorsement {
  pointId: string
  claim: string
  agentId: string
}

export function attributedEndorsements(
  points: ConsensusPoint[],
  utterances: readonly ProvenanceUtterance[],
): AttributedEndorsement[] {
  const out: AttributedEndorsement[] = []
  for (const entry of endorsementProvenance(points, utterances)) {
    for (const agentId of entry.attributed) {
      out.push({ pointId: entry.pointId, claim: entry.claim, agentId })
    }
  }
  return out
}

/**
 * 跨轮代答增长：本轮新增了多少条「主持替模型点的头」。
 *
 * 用 (论点文本, 被冒名者) 配对做差集 —— 只看新增，避免把上一轮已经暴露的问题
 * 重复计入本轮，那样会让趋势永远是平的。
 *
 * 为什么按 claim 而不是 pointId：共识点 id 每轮由程序新生成（`makeId('cp')`），
 * 而登记时是按 claim 去重的 —— claim 才是跨轮稳定的身份。
 * 按 id 做差集的话，同一处代答每轮都会被当成「新增」重计一次，
 * 风险分和轨迹判定会随轮次虚高。
 */
export function attributedGrowth(
  previousPoints: ConsensusPoint[],
  previousUtterances: readonly ProvenanceUtterance[],
  currentPoints: ConsensusPoint[],
  currentUtterances: readonly ProvenanceUtterance[],
): { growth: AttributedEndorsement[]; growthCount: number } {
  const key = (claim: string, agentId: string) => `${claim.trim()}\u0000${agentId}`
  const prev = new Set(
    attributedEndorsements(previousPoints, previousUtterances).map((x) => key(x.claim, x.agentId)),
  )
  const growth = attributedEndorsements(currentPoints, currentUtterances).filter(
    (x) => !prev.has(key(x.claim, x.agentId)),
  )
  return { growth, growthCount: growth.length }
}

// ---------------------------------------------------------------------------
// 3. 论点漂移：被论据矫正，还是换个说法继续飘
// ---------------------------------------------------------------------------

export type DriftKind = 'stable' | 'hollow_mutation' | 'substantiated_refinement'

export interface DriftEntry {
  pointId: string
  claim: string
  previousClaim: string
  /** 0-1，文本变化程度（1 - 字符 bigram 相似度） */
  drift: number
  /** 证据条数的变化；<=0 表示改写没有带来新证据 */
  evidenceDelta: number
  kind: DriftKind
}

export interface DriftResult {
  entries: DriftEntry[]
  hollow: number
  substantiated: number
}

/** 判定「说法变了」的门槛：低于此值视为同一句话的复述 */
const DRIFT_THRESHOLD = 0.3
/** 认定两条 claim 在谈同一件事的最低相似度 */
const MATCH_THRESHOLD = 0.34

function bigrams(text: string): Set<string> {
  const norm = text.replace(/\s+/g, '').toLowerCase()
  const set = new Set<string>()
  for (let i = 0; i < norm.length - 1; i++) set.add(norm.slice(i, i + 2))
  if (set.size === 0 && norm.length > 0) set.add(norm)
  return set
}

export function claimSimilarity(a: string, b: string): number {
  const x = bigrams(a)
  const y = bigrams(b)
  if (x.size === 0 || y.size === 0) return a === b ? 1 : 0
  let inter = 0
  for (const g of x) if (y.has(g)) inter += 1
  const union = x.size + y.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * 跨轮追踪每条共识点的措辞变化。
 *
 * 这是「幻觉在多轮交互里到底怎么演化」最直接的观测面：
 * - 有据改写（evidence 增加）= 讨论真的在收敛，说法被论据矫正；
 * - 空心改写（说法变具体但证据没加）= 模型在把自己上一轮的概括当作新事实，
 *   这正是越聊越糟的形态 —— 单看某一条不明显，跨轮才看得出来。
 */
export function trackClaimDrift(previous: ConsensusPoint[], current: ConsensusPoint[]): DriftResult {
  const entries: DriftEntry[] = []
  const taken = new Set<string>()

  for (const point of current) {
    let best: { prev: ConsensusPoint; sim: number } | null = null
    for (const prev of previous) {
      if (taken.has(prev.id)) continue
      const sim = claimSimilarity(prev.claim, point.claim)
      if (sim >= MATCH_THRESHOLD && (!best || sim > best.sim)) best = { prev, sim }
    }
    if (!best) continue
    taken.add(best.prev.id)

    const drift = 1 - best.sim
    if (drift <= DRIFT_THRESHOLD) continue
    const evidenceDelta = point.evidenceRef.length - best.prev.evidenceRef.length
    entries.push({
      pointId: point.id,
      claim: point.claim,
      previousClaim: best.prev.claim,
      drift: Math.round(drift * 100) / 100,
      evidenceDelta,
      kind: evidenceDelta > 0 ? 'substantiated_refinement' : 'hollow_mutation',
    })
  }

  return {
    entries,
    hollow: entries.filter((e) => e.kind === 'hollow_mutation').length,
    substantiated: entries.filter((e) => e.kind === 'substantiated_refinement').length,
  }
}

// ---------------------------------------------------------------------------
// 4. 主持抬分
// ---------------------------------------------------------------------------

/**
 * 主持自评与程序核算值的最大正偏差（只算「抬」，不算「压」）。
 *
 * 主持被要求给三维度打分，但分数本身由程序核算 —— 差值不是错误，
 * 而是一条信号：主持越是倾向把讨论描述得比实际更成功，收敛判定越可能被它推动。
 */
export function moderatorInflation(
  claimed: { agreement: number; overlap: number; trend: number },
  computed: { agreement: number; overlap: number; trend: number },
): number {
  const deltas = (['agreement', 'overlap', 'trend'] as const).map((k) => claimed[k] - computed[k])
  const max = Math.max(...deltas)
  return max > 0 ? Math.round(max * 10) / 10 : 0
}

// ---------------------------------------------------------------------------
// 5. 逐轮记账与趋势判定
// ---------------------------------------------------------------------------

export interface RoundRecordInput {
  round: number
  /** 本轮有效发言数 */
  utterances: number
  citations: {
    badUtterances: number
    bogusRefs: number
    outOfRangeRefs: number
    unknownLabels: number
  }
  attributedGrowthCount: number
  drift: { hollow: number; substantiated: number }
  inflation: number
}

export function buildRoundRecord(input: RoundRecordInput): HallucinationRoundRecord {
  const errorCount =
    input.citations.badUtterances +
    input.citations.outOfRangeRefs +
    input.attributedGrowthCount +
    input.drift.hollow +
    (input.inflation >= 10 ? 1 : 0)
  return {
    round: input.round,
    utterances: input.utterances,
    badCitationUtterances: input.citations.badUtterances,
    bogusUtteranceRefs: input.citations.bogusRefs,
    outOfRangeRoundRefs: input.citations.outOfRangeRefs,
    unknownLabelRefs: input.citations.unknownLabels,
    attributedGrowth: input.attributedGrowthCount,
    substantiatedRefinements: input.drift.substantiated,
    hollowMutations: input.drift.hollow,
    inflation: input.inflation,
    errorCount,
  }
}

/**
 * 趋势判定：把 errorCount 序列切成前后两半比较。
 *
 * 用相对趋势而不是绝对值 —— 「每轮都有 2 处凭空引用但一路降到 0」是好消息，
 * 「每轮 1 处且在上升」是坏消息。绝对阈值会把这两种混为一谈。
 */
export function judgeTrajectory(
  records: HallucinationRoundRecord[],
): { trajectory: HallucinationTrajectory; note: string } {
  const series = records.map((r) => r.errorCount)
  if (series.length < 2) {
    return {
      trajectory: 'insufficient_data',
      note: `仅 ${series.length} 轮有账本，趋势无从判断 —— 至少需要 2 轮才能看出误差在收敛还是放大。`,
    }
  }
  const half = Math.floor(series.length / 2)
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  const head = mean(series.slice(0, half))
  const tail = mean(series.slice(series.length - half))
  const delta = Math.round((tail - head) * 10) / 10

  const path = series.join(' → ')
  if (delta <= -0.5) {
    return {
      trajectory: 'self_correcting',
      note: `误差计数 ${path}，后半段均值比前半段低 ${Math.abs(delta)} 处：交叉质询在把编造的内容挤出去。`,
    }
  }
  if (delta >= 0.5) {
    return {
      trajectory: 'compounding',
      note: `误差计数 ${path}，后半段均值比前半段高 ${delta} 处：后续轮次在引用前面编出来的内容，讨论在自我强化。`,
    }
  }
  return {
    trajectory: 'flat',
    note: `误差计数 ${path} 基本持平：多轮交互既没有矫正掉凭空归因，也没有让它继续扩散。`,
  }
}

export interface ReportInput {
  records: HallucinationRoundRecord[]
  /** 全场代答率的分母：声称支持总数 */
  totalClaimedSupport: number
  totalAttributedSupport: number
  corrections: HallucinationCorrection[]
  vacatedPoints: number
  triggeredBy: string
}

export function buildHallucinationReport(input: ReportInput): HallucinationReport {
  const records = input.records
  const utterances = records.reduce((a, r) => a + r.utterances, 0)
  const badUtterances = records.reduce((a, r) => a + r.badCitationUtterances, 0)
  const hollow = records.reduce((a, r) => a + r.hollowMutations, 0)
  const refined = records.reduce((a, r) => a + r.substantiatedRefinements, 0)
  const attributed = records.reduce((a, r) => a + r.attributedGrowth, 0)
  const maxInflation = records.reduce((a, r) => Math.max(a, r.inflation), 0)

  const pct = (n: number, d: number): number => (d <= 0 ? 0 : Math.round((n / d) * 100))
  const citationBogusRate = pct(badUtterances, utterances)
  const attributedRate = pct(input.totalAttributedSupport, input.totalClaimedSupport)
  const hollowMutationRate = pct(hollow, hollow + refined)
  const { trajectory, note } = judgeTrajectory(records)

  // 风险分：代答占 4 成（它直接伪造「谁同意了」），引用 3 成，空心改写 2 成，抬分 1 成。
  // 趋势单独加权：compounding 时整体风险上浮，self_correcting 时下浮 ——
  // 同样的绝对值，扩散中和收敛中不是一回事。
  let riskScore =
    citationBogusRate * 0.3 +
    attributedRate * 0.4 +
    hollowMutationRate * 0.2 +
    Math.min(maxInflation, 50) * 0.2
  if (trajectory === 'compounding') riskScore *= 1.2
  if (trajectory === 'self_correcting') riskScore *= 0.8
  riskScore = Math.max(0, Math.min(100, Math.round(riskScore)))

  const outcomeCount = (o: CorrectionOutcome): number =>
    input.corrections.filter((c) => c.outcome === o).length

  const flags: string[] = []
  if (citationBogusRate >= 20) {
    flags.push(`${citationBogusRate}% 的有效发言含本场可判死的凭空引用（${badUtterances}/${utterances} 条）。`)
  }
  if (attributedRate >= 30) {
    flags.push(
      `${attributedRate}% 的「支持」在支持者本人发言里找不到原文（${input.totalAttributedSupport}/${input.totalClaimedSupport}），共识度按代答打折。`,
    )
  }
  if (hollow > refined && hollow > 0) {
    flags.push(`空心改写 ${hollow} 条 > 有据改写 ${refined} 条：共识点在换说法，不是在攒证据。`)
  }
  if (maxInflation >= 10) {
    flags.push(`主持自评最高比程序核算高 ${maxInflation} 分（0-100 量纲）。`)
  }
  if (trajectory === 'compounding') {
    flags.push('误差随轮次放大：本场结论应当只采信最近一轮新增、且有原文支撑的部分。')
  }
  const denied = outcomeCount('denied')
  if (denied > 0) flags.push(`核验轮有 ${denied} 条「被代答的支持」被模型本人否认，已从 support 移出。`)

  return {
    rounds: records,
    citationBogusRate,
    attributedRate,
    hollowMutationRate,
    maxInflation,
    riskScore,
    trajectory,
    trajectoryNote: note,
    verification: {
      asked: input.corrections.length,
      confirmed: outcomeCount('confirmed'),
      denied,
      clarified: outcomeCount('clarified'),
      noResponse: outcomeCount('no_response'),
      vacatedPoints: input.vacatedPoints,
      triggeredBy: input.triggeredBy,
    },
    corrections: input.corrections,
    flags,
  }
}

// ---------------------------------------------------------------------------
// 6. 核验轮：要不要跑、跑谁、结果怎么结算
// ---------------------------------------------------------------------------

/** auto 模式的风险闸门：低于此值不值得再花一个批次去质询 */
export const VERIFY_RISK_THRESHOLD = 30

export function needsVerificationPass(
  mode: VerifyPassMode | undefined,
  report: { riskScore: number; trajectory: HallucinationTrajectory; attributedTotal: number },
): { needed: boolean; triggeredBy: string } {
  const effective: VerifyPassMode = mode ?? 'auto'
  if (effective === 'off') return { needed: false, triggeredBy: 'off：只测量不质询' }
  if (report.attributedTotal === 0) {
    return { needed: false, triggeredBy: '每位声称支持者都能在本人发言里找到原文，无需质询' }
  }
  if (effective === 'always') {
    return { needed: true, triggeredBy: `always：存在 ${report.attributedTotal} 条代答支持，逐条质询` }
  }
  if (report.riskScore >= VERIFY_RISK_THRESHOLD) {
    return {
      needed: true,
      triggeredBy: `auto：风险分 ${report.riskScore} ≥ ${VERIFY_RISK_THRESHOLD}，且存在 ${report.attributedTotal} 条代答支持`,
    }
  }
  if (report.trajectory === 'compounding') {
    return { needed: true, triggeredBy: `auto：误差在跨轮放大，且存在 ${report.attributedTotal} 条代答支持` }
  }
  return {
    needed: false,
    triggeredBy: `auto：风险分 ${report.riskScore} 未达 ${VERIFY_RISK_THRESHOLD} 且误差未放大，暂不追加质询批次`,
  }
}

const DENIED = /(我并(没有|未)|我没有(说过|同意|支持|提过)|并非我的|不是我的|这并非|否认|我反对这一归因|未提出|没有说过|I did not|I never|disagree with this attribution)/i
const CONFIRMED = /(我确认|确实(说过|提过|持|支持)|我(也|一直|确实)?支持|同意该|这是我的观点|是的，我(认为|支持)|I confirm|I do support|that is my view)/i
const CLARIFIED = /(更准确地说|需要限定|部分同意|在.{0,12}前提下才|我的原意是|我当时的表述是|有条件地同意)/i

/**
 * 把模型对质询的答复归为四种结局之一。
 *
 * 顺序很重要：先判否认，再判限定，最后才是确认 ——
 * 「我支持，但需要限定」按限定处理，不把模糊答复算成点头。
 * 非空但三条都不匹配的答复同样按限定处理：没明确点头就不能算确认。
 */
export function classifyVerificationAnswer(content: string): CorrectionOutcome {
  const text = content.trim()
  if (text.length === 0) return 'no_response'
  if (DENIED.test(text)) return 'denied'
  if (CLARIFIED.test(text)) return 'clarified'
  if (CONFIRMED.test(text)) return 'confirmed'
  return 'clarified'
}

export interface CorrectionTarget {
  pointId: string
  claim: string
  agentId: string
}

/** 质询文本：把「被安在你头上的话」原样还给模型 */
export function buildEndorsementChallenge(target: CorrectionTarget): string {
  return [
    '【共识核验】',
    `主持人把「${target.claim}」列为你支持的共识点，但在你此前所有发言里没有找到对应论述。`,
    '请只回答三选一，并给出依据：',
    '1）确认：这确实是我的立场，请说明在你的哪次发言里可以核对；',
    '2）否认：这不是我的立场，请直接说明你实际的主张；',
    '3）修正：部分同意，但需要限定条件 —— 请说清限定。',
    '不要复述主持人的表述。',
  ].join('\n')
}

/**
 * 结算一次质询结果。
 *
 * 硬约束：
 * - denied → 从 support 移出，绝不删除共识点本身；support 归零时标 vacated 留档；
 * - confirmed → 把本次答复登记为证据（血缘补上），代答变可核对；
 * - clarified → 支持保留但标记为「有条件」，并在 verification 里留痕；
 * - 全程不新增未被引用的发言 id：addedEvidenceRef 必须是本次答复产生的真实 id。
 */
export function applyCorrection(
  point: ConsensusPoint,
  input: {
    agentId: string
    outcome: CorrectionOutcome
    round: number
    utteranceId: string | null
    question: string
    answer: string | null
  },
): { point: ConsensusPoint; correction: HallucinationCorrection } {
  const support = new Set(point.support)
  const evidenceRef = [...point.evidenceRef]
  const removed: string[] = []

  if (input.outcome === 'denied') {
    if (support.delete(input.agentId)) removed.push(input.agentId)
  } else {
    // confirmed / clarified：把答复本身登记为证据，代答转为「本轮起可核对」
    if (input.utteranceId && !evidenceRef.includes(input.utteranceId)) {
      evidenceRef.push(input.utteranceId)
    }
  }

  const previous = point.verification
  const confirmedBy = new Set(previous?.confirmedBy ?? [])
  const removedSet = new Set(previous?.removed ?? [])
  if (input.outcome === 'confirmed') confirmedBy.add(input.agentId)
  if (removed.length > 0) removedSet.add(input.agentId)
  if (input.outcome === 'clarified') confirmedBy.delete(input.agentId)

  const status: ConsensusVerificationStatus =
    support.size === 0 ? 'vacated' : input.outcome === 'denied' ? 'disputed' : 'verified'

  const verification: ConsensusVerification = {
    status,
    checkedRound: previous?.checkedRound ?? input.round,
    attributed: previous?.attributed ?? [input.agentId],
    confirmedBy: [...confirmedBy],
    removed: [...removedSet],
  }

  const nextPoint: ConsensusPoint = {
    ...point,
    support: [...support],
    evidenceRef,
    verification,
  }

  const correction: HallucinationCorrection = {
    id: `hc_${point.id}_${input.agentId}`,
    round: input.round,
    issue: 'attributed_endorsement',
    outcome: input.outcome,
    agentId: input.agentId,
    pointId: point.id,
    pointClaim: point.claim,
    question: input.question,
    answer: input.answer,
    addedEvidenceRef:
      input.utteranceId && !previous?.confirmedBy?.includes(input.agentId) && input.outcome !== 'denied'
        ? [input.utteranceId]
        : [],
    removedSupport: removed,
  }

  return { point: nextPoint, correction }
}

/** 记录一次「凭空引用」质询（不改动 support，只留账） */
export function citationCorrection(input: {
  agentId: string
  round: number
  issue: CorrectionIssue
  question: string
  answer: string | null
  utteranceId: string | null
}): HallucinationCorrection {
  return {
    id: `hc_cite_${input.agentId}_${input.round}`,
    round: input.round,
    issue: input.issue,
    outcome: input.answer === null ? 'no_response' : classifyVerificationAnswer(input.answer),
    agentId: input.agentId,
    pointId: null,
    pointClaim: null,
    question: input.question,
    answer: input.answer,
    addedEvidenceRef: [],
    removedSupport: [],
  }
}

/** 汇总全场代答支持（核验轮的质询对象清单来源） */
export function dedupeTargets(list: AttributedEndorsement[]): CorrectionTarget[] {
  const seen = new Set<string>()
  const out: CorrectionTarget[] = []
  for (const x of list) {
    const key = `${x.pointId}\u0000${x.agentId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ pointId: x.pointId, claim: x.claim, agentId: x.agentId })
  }
  return out
}

/** 每条共识点当前仍需质询的模型（已在 verification.removed 里的不再打扰） */
export function pendingVerificationTargets(
  points: ConsensusPoint[],
  utterances: readonly ProvenanceUtterance[],
  maxTargets: number,
): CorrectionTarget[] {
  const all = dedupeTargets(attributedEndorsements(points, utterances)).filter((t) => {
    const point = points.find((p) => p.id === t.pointId)
    if (!point) return false
    const done = new Set([...(point.verification?.removed ?? []), ...(point.verification?.confirmedBy ?? [])])
    return !done.has(t.agentId)
  })
  // 优先质询「被冒名最多」的模型 —— 质询预算有限时先解影响最大的归因错误
  return all.slice(0, Math.max(0, maxTargets))
}
