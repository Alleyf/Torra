/**
 * 匿名互评与认同溯源
 *
 * 为什么要匿名：模型一旦认出同伴身份就会附和强势厂商（「GPT 都这么说，那应该对」），
 * agreement / overlap 于是被身份偏置污染，共识度虚高。而现有的机械校验查不出它 ——
 * 每条 support 确实指向真实模型，只是那个「支持」是看身份点头，不是看论点点头。
 *
 * 做法（对标 llm-council 的 Stage 2，但把它扩到两处）：
 * - 主持小结：support / sides / callout / 名次一律用别名，程序持有别名映射并还原；
 * - 注入参会模型的历史纪要：共识支持方与分歧各方同样脱敏，模型猜不到谁是谁。
 *
 * 署名轨用「模型名称」而不是内部 id：`api-user-minimax` 这种 id 对模型没有语义，
 * 还会被当成名字的一部分照抄进结论；名称 → id 的反查表由本模块持有。
 *
 * 别名映射必须落盘：反匿名化之后磁盘上只剩真实 id，事后无法回答
 * 「主持当时看到的到底是谁」，审计与匿名轨/署名轨对照都会失效。
 */

import type { ConsensusPoint, Digest, ModeratorDigest, Utterance } from './types'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** 别名：参会者A / 参会者B …；超过 26 个退化为序号 */
export function aliasLabel(index: number): string {
  return index < LETTERS.length
    ? `参会者${LETTERS[index]}`
    : `参会者${index + 1}`
}

export interface AliasMap {
  /** 本场是否走匿名轨 */
  anonymous: boolean
  aliasToAgent: Record<string, string>
  agentToAlias: Record<string, string>
  /** 还原：别名 / 模型名称 / 真实 id → 真实 agentId；认不出的原样返回，交给既有校验拒绝 */
  resolve(ref: string): string
  /** 名称 → 真实 agentId（重名的不收）；认不出返回 null */
  resolveByName(ref: string): string | null
  /** 是否是本场的合法别名 */
  isAlias(ref: string): boolean
  /**
   * 提示词里的可读标签。
   * 匿名轨只给别名（连模型 id 都不给，id 常含厂商名）；
   * 署名轨给模型名称 —— 内部 id 形如 `api-user-minimax`，对模型没有任何语义，
   * 只会让它把「api-user-」当成名字的一部分照抄进结论里。
   */
  labelFor(agentId: string): string
}

export function buildAliasMap(
  agentIds: string[],
  anonymous: boolean,
  /** 取模型的可读名称；缺省或取不到时退回 id（等于改动前的行为） */
  nameOf?: (agentId: string) => string | undefined,
): AliasMap {
  const aliasToAgent: Record<string, string> = {}
  const agentToAlias: Record<string, string> = {}
  agentIds.forEach((id, i) => {
    const alias = aliasLabel(i)
    aliasToAgent[alias] = id
    agentToAlias[id] = alias
  })

  /**
   * 署名轨的标签表。重名（忽略大小写）时反查会歧义，于是两处一起退化：
   * 标签补上 id 后缀供人辨认，反查表里干脆不收这个名字 —— 宁可让主持被驳回，
   * 也不能把两个模型的支持记到同一个人头上。
   */
  const names = agentIds.map((id) => (nameOf?.(id) ?? '').trim() || id)
  const nameCount = new Map<string, number>()
  names.forEach((n) => nameCount.set(n.toLowerCase(), (nameCount.get(n.toLowerCase()) ?? 0) + 1))
  const labelById = new Map<string, string>()
  const labelToAgent = new Map<string, string>()
  agentIds.forEach((id, i) => {
    const n = names[i] ?? id
    const ambiguous = (nameCount.get(n.toLowerCase()) ?? 0) > 1
    labelById.set(id, ambiguous ? `${n}（${id}）` : n)
    if (!ambiguous) labelToAgent.set(n.toLowerCase(), id)
  })

  return {
    anonymous,
    aliasToAgent,
    agentToAlias,
    resolve(ref) {
      const v = ref.trim()
      if (anonymous) {
        const byAlias = aliasToAgent[v]
        if (byAlias) return byAlias
      }
      if (agentToAlias[v]) return v
      return labelToAgent.get(v.toLowerCase()) ?? v
    },
    resolveByName(ref) {
      return labelToAgent.get(ref.trim().toLowerCase()) ?? null
    },
    isAlias(ref) {
      return anonymous && Object.prototype.hasOwnProperty.call(aliasToAgent, ref)
    },
    labelFor(agentId) {
      if (!anonymous) return labelById.get(agentId) ?? agentId
      return agentToAlias[agentId] ?? `参会者?`
    },
  }
}

/**
 * 纪要改写：把注入参会模型的共识支持方、分歧各方换成提示词标签
 * （匿名轨是别名，署名轨是模型名称）。
 * claim / argument 文本原样保留 —— 匿名轨要藏的是「谁说的」，不是「说了什么」；
 * 署名轨换名称只是因为内部 id 对模型没有语义，还会被照抄进结论。
 *
 * 只改副本：this.confirmed / this.open 里存的仍是真实 id，报告与血缘不受影响。
 */
export function anonymizeDigest(digest: Digest, map: AliasMap): Digest {
  return {
    ...digest,
    confirmed: digest.confirmed.map((c) => ({
      ...c,
      support: c.support.map((id) => map.labelFor(id)),
    })),
    open: digest.open.map((d) => ({
      ...d,
      sides: d.sides.map((s) => ({ ...s, agentId: map.labelFor(s.agentId) })),
    })),
  }
}

/**
 * 反匿名化：主持输出的别名 / 模型名称 → 真实 agentId。
 *
 * 未登记的别名（如模型自己造了「参会者Z」）原样透传，由 validateModeratorDigest
 * 的「support 含不存在的模型」拒绝 —— 这是凭空归因，不能悄悄放过。
 * 两个清单都回报，让驳回原因与审计标注说得出是哪个字段、出在哪个位置。
 */
export function deanonymizeModeratorDigest(
  digest: ModeratorDigest,
  map: AliasMap,
): { digest: ModeratorDigest; unknownAliases: string[]; leakedRealIds: string[] } {
  const unknownAliases = new Set<string>()
  const leakedRealIds = new Set<string>()

  const ref = (value: string): string => {
    if (!map.anonymous) {
      // 署名轨现在只给模型名称，主持照抄回来的就是名称；认不出的一律原样
      // 交给 validateModeratorDigest —— 它才知道主持自己（不在参会名单里）也算合法
      return map.resolveByName(value) ?? value
    }
    if (map.isAlias(value)) return map.resolve(value)
    // 不是别名但确实是本场模型：模型照抄或直接写出了真实 id。
    // 结论仍可用（能对上真人），但「匿名」这个前提被破坏了，必须留痕。
    if (map.agentToAlias[value]) {
      leakedRealIds.add(value)
      return value
    }
    const byName = map.resolveByName(value)
    if (byName) {
      // 写名称与写 id 是同一件事：身份被模型自己说回来了
      leakedRealIds.add(byName)
      return byName
    }
    unknownAliases.add(value)
    return value
  }

  const out: ModeratorDigest = {
    ...digest,
    consensus_points: (digest.consensus_points ?? []).map((p) => ({
      ...p,
      support: (p.support ?? []).map(ref),
    })),
    open_disputes: (digest.open_disputes ?? []).map((d) => ({
      ...d,
      sides: (d.sides ?? []).map((s) => ({ ...s, agent_id: ref(s.agent_id) })),
    })),
    next_round_order: (digest.next_round_order ?? []).map(ref),
    agent_quality: (digest.agent_quality ?? []).map((q) => ({ ...q, agent_id: ref(q.agent_id) })),
    callout: digest.callout
      ? {
          target_agent: ref(digest.callout.target_agent),
          quote_from_agent: ref(digest.callout.quote_from_agent),
          instruction: digest.callout.instruction,
        }
      : null,
  }

  return { digest: out, unknownAliases: [...unknownAliases], leakedRealIds: [...leakedRealIds] }
}

/**
 * 认同溯源：一条共识点里，每个「支持」到底有没有对应的原文证据。
 *
 * covered   = 支持者本人有发言被引为证据（可核对，强）
 * attributed= 声称他支持，但证据里没有他的发言（主持替他归因，弱）
 * crossExamined = 证据发言里至少有一条被**他人**点名回应过（这条共识挨过质询）
 */
export interface PointProvenance {
  pointId: string
  claim: string
  covered: string[]
  attributed: string[]
  /** 证据发言的作者中，不在 support 清单里的 —— 主持引用了反对者/旁观者的话 */
  evidenceAgents: string[]
  crossExamined: boolean
}

/**
 * 溯源只需要发言的「谁、是否缺席、回应了谁」，
 * 渲染层的 UiUtterance 由此可直接复用同一套算法，不必复制一份校验逻辑。
 */
export type ProvenanceUtterance = Pick<Utterance, 'id' | 'agentId' | 'absent' | 'targets'>

export function endorsementProvenance(
  points: ConsensusPoint[],
  utterances: readonly ProvenanceUtterance[],
): PointProvenance[] {
  const byId = new Map(utterances.map((u) => [u.id, u]))

  return points.map((p) => {
    const evidences = p.evidenceRef.map((id) => byId.get(id)).filter((u): u is Utterance => !!u)
    const evidenceAgents = [...new Set(evidences.map((u) => u.agentId))]
    const support = new Set(p.support)

    // 「被他人回应」＝有别的模型的发言把这条证据列为 targets
    const crossExamined = evidences.some((u) =>
      utterances.some((x) => !x.absent && x.agentId !== u.agentId && x.targets.includes(u.id)),
    )

    return {
      pointId: p.id,
      claim: p.claim,
      covered: p.support.filter((id) => evidenceAgents.includes(id)),
      attributed: [...support].filter((id) => !evidenceAgents.includes(id)),
      evidenceAgents,
      crossExamined,
    }
  })
}

export interface ProvenanceSummary {
  /** 可核对支持的占比；低覆盖率说明主持在替模型归因，共识强度要打折看 */
  coverageRate: number
  /** 挨过质询的共识点占比 */
  crossExaminedRate: number
  points: PointProvenance[]
}

export function provenanceSummary(
  points: ConsensusPoint[],
  utterances: readonly ProvenanceUtterance[],
): ProvenanceSummary {
  const entries = endorsementProvenance(points, utterances)
  if (entries.length === 0) {
    return { coverageRate: 0, crossExaminedRate: 0, points: [] }
  }
  const totalSupport = entries.reduce((a, e) => a + e.covered.length + e.attributed.length, 0)
  const covered = entries.reduce((a, e) => a + e.covered.length, 0)
  const cross = entries.filter((e) => e.crossExamined).length
  return {
    coverageRate: totalSupport === 0 ? 0 : Math.round((covered / totalSupport) * 100),
    crossExaminedRate: Math.round((cross / entries.length) * 100),
    points: entries,
  }
}
