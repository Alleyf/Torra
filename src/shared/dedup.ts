/**
 * 共识点与分歧的归并 —— 同一个判断换个说法，不该在报告里变成三条
 *
 * 旧实现只在 claim 字符串完全相等时才去重（`c.claim === p.claim`）。
 * 但主持每轮看不到已登记条目的原文，只能重新措辞，于是
 * 「应当采用方案X以降低落地成本」和「采用方案X，落地成本更低」各成一条，
 * 三轮下来结论看着厚，其实就那两三个意思。
 *
 * 度量为什么不用 hallucination.ts 里的 claimSimilarity：
 * 那个是给「论点漂移」用的纯 bigram Jaccard，判据是措辞变没变；
 * 归并要判的是「两句话是不是同一个判断」，中文里词序一变、连接词一加，
 * bigram 就掉到 0.41（真同义）而反义对却能到 0.33，单靠它切不开。
 * 这里把 bigram 相似度与字符集合相似度对半混合，实测同义对能到 0.61-0.75，
 * 无关对与反义对都压在 0.42 以下，再加一道「否定词必须同侧」的闸门。
 */

import type { ConsensusPoint, OpenDispute } from './types'

/** 判定为同义并合并的下限（措辞不同也照样合） */
export const NEAR_DUP_THRESHOLD = 0.6
/** 主持显式声明「这条延续已有条目」时，程序至少要到这个相似度才肯照办 */
export const EXPLICIT_CONTINUATION_MIN = 0.3
/** 分歧清单误并的代价更高（会把真实分歧藏起来），阈值抬到 0.66 且要求当事方一致 */
export const DISPUTE_DUP_THRESHOLD = 0.66

const PUNCT = /[\s，。、；：！？…—－\-_.,;:!?"'“”‘’「」『’（）()〈〉《》【】[\]{}<>《》]/g

const NEGATION = /(不|别|勿|未|无|禁止|反对|否决|避免|排除|无需|不必|不能|不可|不应|no|not|never)/i

function normalize(text: string): string {
  return (text ?? '').replace(PUNCT, '').toLowerCase()
}

function bigrams(norm: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < norm.length - 1; i++) set.add(norm.slice(i, i + 2))
  if (set.size === 0 && norm.length > 0) set.add(norm)
  return set
}

function jaccard(x: Set<string>, y: Set<string>): number {
  if (x.size === 0 || y.size === 0) return 0
  let inter = 0
  for (const g of x) if (y.has(g)) inter += 1
  const union = x.size + y.size - inter
  return union === 0 ? 0 : inter / union
}

function charSet(norm: string): Set<string> {
  return new Set(norm)
}

/**
 * 两句话像不像同一个判断。0-1。
 *
 * 先否掉「否定词一侧有一侧无」的对：那种是立场相反，不是措辞不同，
 * 无论字面多像都不许并。
 */
export function claimCloseness(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return 1
  if (NEGATION.test(na) !== NEGATION.test(nb)) return 0
  return (jaccard(bigrams(na), bigrams(nb)) + jaccard(charSet(na), charSet(nb))) / 2
}

export interface PointMergeResult {
  points: ConsensusPoint[]
  /** 被并进已有条目的数量 */
  merged: number
  /** 其中措辞不同、留下变体记录的数量 */
  variants: number
}

/**
 * 把 src 折进 target（就地改写 target）：支持方并集、置信取高、证据硬度取低、
 * 证据并集、确认轮次取早。措辞不同则作为「变体」挂在原条目上 —— 归并是压缩呈现，
 * 不是改写历史，用户仍能看到主持换过哪些说法。
 */
export function foldPoint(target: ConsensusPoint, src: ConsensusPoint): void {
  for (const id of src.support) if (!target.support.includes(id)) target.support.push(id)
  for (const id of src.evidenceRef) if (!target.evidenceRef.includes(id)) target.evidenceRef.push(id)
  target.confidence = Math.max(target.confidence, src.confidence)
  if (typeof src.weight === 'number') {
    target.weight = typeof target.weight === 'number' ? Math.min(target.weight, src.weight) : src.weight
  }
  target.confirmedRound = Math.min(target.confirmedRound, src.confirmedRound)
  if (src.claim.trim() !== target.claim.trim()) {
    const rest = target.variants ?? []
    if (!rest.includes(src.claim)) target.variants = [...rest, src.claim]
  }
  // 归并过就重新走一遍核验标记：代答名单要按合并后的 support 重算
  if (src.verification && !target.verification) target.verification = src.verification
}

/**
 * 逐条并入已有清单：优先用主持显式声明的 continues 目标（但字面太不像就退回新建，
 * 否则主持可以用 continues 把任意论点塞进任意条目），其次按相似度找最近的一条。
 *
 * declaredTargets 与 incoming 同序对齐（主持 JSON 里才有 continues，
 * 转成 ConsensusPoint 后没地方放，所以按位置传）。
 */
export function mergeConsensusPoints(
  existing: ConsensusPoint[],
  incoming: ConsensusPoint[],
  declaredTargets: Array<string | null> = [],
): PointMergeResult & { ignoredContinues: string[] } {
  const points = existing.map((p) => ({ ...p, support: [...p.support], evidenceRef: [...p.evidenceRef] }))
  let merged = 0
  let variants = 0
  const ignoredContinues: string[] = []

  incoming.forEach((raw, i) => {
    const src = { ...raw, support: [...raw.support], evidenceRef: [...raw.evidenceRef] }
    let target: ConsensusPoint | undefined
    const declared = declaredTargets[i] ?? null
    if (declared) {
      const found = points.find((p) => p.id === declared)
      if (found && claimCloseness(found.claim, src.claim) >= EXPLICIT_CONTINUATION_MIN) {
        target = found
      } else {
        ignoredContinues.push(`「${src.claim}」被主持标为延续 ${declared}，但字面不像同一条判断，按新条目登记`)
      }
    }
    if (!target) {
      let best: ConsensusPoint | undefined
      let bestSim = 0
      for (const p of points) {
        const sim = claimCloseness(p.claim, src.claim)
        if (sim >= NEAR_DUP_THRESHOLD && sim > bestSim) {
          best = p
          bestSim = sim
        }
      }
      target = best
    }
    if (target) {
      const hadVariants = (target.variants?.length ?? 0) > 0
      foldPoint(target, src)
      merged += 1
      if (!hadVariants && src.claim.trim() !== target.claim.trim()) variants += 1
    } else {
      points.push(src)
    }
  })

  return { points, merged, variants, ignoredContinues }
}

/**
 * 分歧清单的同义查找：措辞像 + 当事方一致才算同一条分歧。
 * 当事方不同就不并 —— 「甲 vs 乙 要不要 X」和「甲 vs 乙 要不要 Y」是两条分歧，
 * 并起来等于把未决问题藏掉一个（PRD 6.8 只增不减）。
 */
export function findSimilarDispute(
  disputes: OpenDispute[],
  claim: string,
  agentIds: string[],
): OpenDispute | undefined {
  const sideKey = (ids: string[]) => [...new Set(ids)].sort().join('\u0000')
  const want = sideKey(agentIds)
  let best: OpenDispute | undefined
  let bestSim = DISPUTE_DUP_THRESHOLD
  for (const d of disputes) {
    if (sideKey(d.sides.map((s) => s.agentId)) !== want) continue
    const sim = claimCloseness(d.claim, claim)
    if (sim >= bestSim) {
      best = d
      bestSim = sim
    }
  }
  return best
}
