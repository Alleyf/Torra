/**
 * 结论的状态投影层 —— 把「一场讨论现在的结构」算成可直接画的桶与区间。
 *
 * 消费方有两个：右栏「论证地图」按桶与轮次区间摆位置，「结论台账」顶部那条
 * 状态条据此筛选、每张卡的轮次行据此写区间。同一批判断按有没有人认账分四桶，
 * 两屏共用这一层，口径不会分叉。这层保持纯函数：地图要改成真正的跨轮矩阵，
 * 加视图就行，算法不用重写。
 *
 * 与「论题演化」的分工是按粒度定的：那张图一个节点 = 一次发言（Utterance.targets
 * 决定线怎么走），看的是过程；这里一个节点 = 一个判断（共识点 / 分歧），看的是
 * 现状 —— 立住了几条、还争着什么、哪条被消解过、哪条被质询到没人认领。
 *
 * 只投影真实存在的外键。数据里 claim 与 claim 之间没有边（没有 claim 级的
 * 「支持/反对某命题」的立场字段），唯一真实的边是 判断 → 发言：
 * evidenceRef / sides[].utteranceIds / resolutionRef。所以这一层不产出
 * 「正方→核心命题」那种看着漂亮、实际是编的连线。
 */

import type { ConsensusPoint, ConsensusVerificationStatus, OpenDispute } from './types'

/** 地图只需要这几列，UiUtterance 与 Utterance 都满足 */
export interface MapUtterance {
  id: string
  round: number
  agentId: string
  human?: boolean
}

/**
 * 四个状态桶（列）。
 * held=已确认的共识，contested=还争着的（open 分歧 + 有代答的共识），
 * settled=有依据地消解了，vacated=质询后没人认领。
 */
export type ArgBucket = 'held' | 'contested' | 'settled' | 'vacated'

export const ARG_BUCKETS: ArgBucket[] = ['held', 'contested', 'settled', 'vacated']

export const ARG_BUCKET_LABEL: Record<ArgBucket, string> = {
  held: '已确认',
  contested: '争议中',
  settled: '已消解',
  vacated: '无人认领',
}

export interface ArgEvidence {
  utteranceId: string
  agentId: string
  round: number
  /** 人类介入的发言：算证据可见，但不算模型共识 */
  human: boolean
}

export interface ArgNode {
  id: string
  kind: 'consensus' | 'dispute'
  bucket: ArgBucket
  claim: string
  /** 共识=声称支持者；分歧=双方（按 sides 顺序） */
  agents: string[]
  /** 分歧双方的论点原文；共识为 null */
  sides: Array<{ agentId: string; argument: string }> | null
  /** 真连线：能在本场发言里找到原文的依据 */
  evidence: ArgEvidence[]
  /** 引了但查不到原文的条数 —— 不画线、不臆造，只做显式标注 */
  missingEvidence: number
  /** 支撑/交锋覆盖的轮次区间；一条都定位不到时为 null */
  rounds: { from: number; to: number } | null
  /** 跨轮归并进来的其他措辞（原话，供界面逐条回看）；分歧为空数组 */
  variants: string[]
  /** 核验结论；分歧节点为 null */
  verify: ConsensusVerificationStatus | null
  /** 分歧的最近进展；共识节点为 null */
  lastProgress: string | null
  /** 消解依据的发言 id（已消解列的连线来源）；其余为 null */
  resolution: string[] | null
  /** 证据里人工介入的条数 */
  humanCount: number
  /**
   * 主持自报的「认同普遍程度」0-1。分歧节点为 null —— 数据里只有共识点带 confidence。
   * 它是主持人给的估计值，不是统计量，界面只能当提示画。
   */
  confidence: number | null
  /**
   * 证据硬度 0-1（与 confidence 分工：一个「多少人认」，一个「支撑它的证据多硬」）。
   * 旧存档没这个字段 → null，界面整条不画，不许当成 0。
   */
  weight: number | null
  /** 依据里出现过发言的模型数（不含人工介入）：一条判断被几个嘴说过 */
  modelCount: number
}

export interface ArgumentMap {
  nodes: ArgNode[]
  byBucket: Record<ArgBucket, ArgNode[]>
}

function consensusBucket(status: ConsensusVerificationStatus | null): ArgBucket {
  if (status === 'vacated') return 'vacated'
  if (status === 'disputed') return 'contested'
  return 'held'
}

/**
 * 分歧进哪一列只认「有依据的消解」。
 *
 * status=resolved 但没带 resolutionRef 的不算消解：PRD 6.8 规定清单只增不减，
 * 减的唯一凭据是依据。放它进「已消解」等于让一条没证据的声明抹掉一个争点。
 */
function disputeBucket(d: OpenDispute): ArgBucket {
  return d.status === 'resolved' && (d.resolutionRef?.length ?? 0) > 0 ? 'settled' : 'contested'
}

/**
 * 把发言 id 列表翻译成带轮次的证据，并数出查不到原文的条数。
 *
 * 只认这场真实存在的发言 id：主持把 evidence_ref 写成不存在的 id 时，
 * 核验层已经记过一笔账，地图上更不能把它画成一条线。
 */
function toEvidence(
  ids: string[],
  byId: Map<string, MapUtterance>,
): { evidence: ArgEvidence[]; missing: number } {
  const seen = new Set<string>()
  const evidence: ArgEvidence[] = []
  let missing = 0
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const u = byId.get(id)
    if (!u) {
      missing++
      continue
    }
    evidence.push({ utteranceId: id, agentId: u.agentId, round: u.round, human: u.human === true })
  }
  evidence.sort((a, b) => a.round - b.round || a.utteranceId.localeCompare(b.utteranceId))
  return { evidence, missing }
}

function roundSpan(evidence: ArgEvidence[], fallback: number | null): { from: number; to: number } | null {
  if (evidence.length === 0) return fallback === null ? null : { from: fallback, to: fallback }
  let from = evidence[0]!.round
  let to = from
  for (const e of evidence) {
    if (e.round < from) from = e.round
    if (e.round > to) to = e.round
  }
  return { from, to }
}

/** 先按最早出现的轮次，同轮按卷入的模型数，再按 id：让同一份数据每次画出来一样 */
function orderNodes(nodes: ArgNode[]): ArgNode[] {
  return [...nodes].sort((a, b) => {
    const ra = a.rounds?.from ?? Number.MAX_SAFE_INTEGER
    const rb = b.rounds?.from ?? Number.MAX_SAFE_INTEGER
    return ra - rb || b.agents.length - a.agents.length || a.id.localeCompare(b.id)
  })
}

/**
 * 0-1 才画。缺失或非法一律 null，界面整条不出现 ——
 * 把「没记这个字段」画成 0，等于替主持宣布一条判断没有分量。
 */
function ratio(v: number | undefined | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null
}

/** 依据里真正开过口的模型数；人工介入不算一张「嘴」，它另有人数 */
function speakerCount(evidence: ArgEvidence[]): number {
  return new Set(evidence.filter((e) => !e.human).map((e) => e.agentId)).size
}

export function buildArgumentMap(input: {
  consensus: ConsensusPoint[]
  disputes: OpenDispute[]
  utterances: MapUtterance[]
}): ArgumentMap {
  const byId = new Map(input.utterances.map((u) => [u.id, u]))

  const nodes: ArgNode[] = []

  for (const c of input.consensus) {
    const status = c.verification?.status ?? null
    const { evidence, missing } = toEvidence(c.evidenceRef, byId)
    const bucket = consensusBucket(status)
    nodes.push({
      id: c.id,
      kind: 'consensus',
      bucket,
      claim: c.claim,
      agents: [...c.support],
      sides: null,
      evidence,
      missingEvidence: missing,
      rounds: roundSpan(evidence, c.confirmedRound ?? null),
      variants: c.variants ? [...c.variants] : [],
      verify: status,
      lastProgress: null,
      resolution: null,
      humanCount: evidence.filter((e) => e.human).length,
      confidence: ratio(c.confidence),
      weight: ratio(c.weight),
      modelCount: speakerCount(evidence),
    })
  }

  for (const d of input.disputes) {
    const claimed = [...d.sides.flatMap((s) => s.utteranceIds), ...(d.resolutionRef ?? [])]
    const { evidence, missing } = toEvidence(claimed, byId)
    nodes.push({
      id: d.id,
      kind: 'dispute',
      bucket: disputeBucket(d),
      claim: d.claim,
      agents: d.sides.map((s) => s.agentId),
      sides: d.sides.map((s) => ({ agentId: s.agentId, argument: s.argument })),
      evidence,
      missingEvidence: missing,
      rounds: roundSpan(evidence, d.openedRound ?? null),
      variants: [],
      verify: null,
      lastProgress: d.lastProgress,
      resolution: d.resolutionRef && d.resolutionRef.length > 0 ? [...d.resolutionRef] : null,
      humanCount: evidence.filter((e) => e.human).length,
      confidence: null,
      weight: null,
      modelCount: speakerCount(evidence),
    })
  }

  const sorted = orderNodes(nodes)
  const byBucket = {
    held: sorted.filter((n) => n.bucket === 'held'),
    contested: sorted.filter((n) => n.bucket === 'contested'),
    settled: sorted.filter((n) => n.bucket === 'settled'),
    vacated: sorted.filter((n) => n.bucket === 'vacated'),
  }
  return { nodes: sorted, byBucket }
}
