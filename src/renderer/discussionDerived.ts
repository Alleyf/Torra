/**
 * 研讨屏（论题演化图 + 跟随条 + 右栏 aside）要显示、但数据里没有现成字段的量，全部在这里现推。
 *
 * 两处是硬缺口：
 * - `RoundMeta` 类型定义了却没有任何写入点（各处都写死 `rounds: []`），所以每轮的
 *   ⏱ 与花费只能从发言时间戳与 usage 现算；
 * - 主持小结没有「一句话摘要」字段，附录 A 里全是结构化数组。摘要条因此只能由
 *   条数 + callout 指令拼出来，不能伪造一句散文。
 *
 * 还有一条口径必须写死在代码里：网页通道的 costUsd 恒为 0。所以时长与金额分开显示，
 * $0 一律带「不计费」标注，不然用户会以为那一场是免费的。
 */

import type { ModeratorAuditEntry } from '@shared/types'
import type { UiUtterance } from './store'

/** 一轮的账面：⏱ / 花费 / token / 出席情况 */
export interface RoundStat {
  round: number
  /** 本轮墙钟毫秒；取不到时间戳时为 0，界面显示「—」而不是 0s */
  ms: number
  /** 参会者发言的花费（不含主持） */
  utteranceUsd: number
  /** 主持这一轮的小结花费（含被驳回的重打尝试） */
  moderatorUsd: number
  tokens: number
  done: number
  streaming: number
  absent: number
  /** 本轮还有发言在流或还没回来：时长是「到目前为止」，界面要标「估算」 */
  partial: boolean
  /** 本轮完全没有任何时间戳可推 */
  unknown: boolean
}

/**
 * 按轮聚合发言的时间戳与 usage。
 *
 * 人类插话不进账面：它不算这一轮的批次耗时，也不该把某一轮的 ⏱ 撑长。
 * 主持的花费从审计条目里加：那部分不在 utterances 里，漏了就会少报。
 */
export function roundStats(
  utterances: UiUtterance[],
  audit: ModeratorAuditEntry[],
): Map<number, RoundStat> {
  const out = new Map<number, RoundStat>()
  const stat = (round: number): RoundStat => {
    let v = out.get(round)
    if (!v) {
      v = {
        round,
        ms: 0,
        utteranceUsd: 0,
        moderatorUsd: 0,
        tokens: 0,
        done: 0,
        streaming: 0,
        absent: 0,
        partial: false,
        unknown: true,
      }
      out.set(round, v)
    }
    return v
  }

  for (const u of utterances) {
    if (u.human) continue
    const v = stat(u.round)
    if (u.absent) v.absent++
    else if (u.streaming) v.streaming++
    else v.done++
    v.tokens += (u.usage?.promptTokens ?? 0) + (u.usage?.completionTokens ?? 0)
    v.utteranceUsd += u.usage?.costUsd ?? 0
    if (u.startedAt) v.unknown = false
    if (u.streaming) v.partial = true
  }

  // 同轮是并行的，一轮的墙钟取「最晚结束 − 最早开始」，不是各自耗时相加。
  // 先收齐端点再落账，否则并行批次里后回来的那条会被先回来的压掉。
  const span = new Map<number, { from: number; to: number }>()
  for (const u of utterances) {
    if (u.human || !u.startedAt) continue
    const cur = span.get(u.round) ?? { from: u.startedAt, to: u.endedAt ?? Date.now() }
    cur.from = Math.min(cur.from, u.startedAt)
    cur.to = Math.max(cur.to, u.endedAt ?? Date.now())
    span.set(u.round, cur)
  }
  for (const [round, s] of span) {
    const v = stat(round)
    v.ms = Math.max(0, s.to - s.from)
    v.unknown = false
  }

  for (const a of audit) {
    const v = stat(a.round)
    for (const at of a.attempts ?? []) v.moderatorUsd += at.costUsd ?? 0
  }

  return out
}

/** 主持小结那一条横栏的内容：只有条数与指令，散文由数据里没有的字段假装不出来 */
export interface DigestStrip {
  round: number
  /** 这一轮有没有被程序接受的小结。没有就显示被拒原因，不编数 */
  accepted: boolean
  points: number
  disputes: number
  /**
   * 相对上一轮新增的条数。
   *
   * 主持每轮发的是全量生命周期（合并后的清单），只报总数会看着像「跑了三轮还是那几条」，
   * 也看不出这一轮到底登记了什么新的。
   */
  newPoints: number
  newDisputes: number
  callout: string | null
  calloutTarget: string | null
  explored: number
  /** 第几次尝试才通过：>1 说明被程序校验驳回过重打，这件事必须写在脸上 */
  attempts: number
  /** 主持指名的对象不在本场（反匿名化失败的别名） */
  unknownAliases: string[]
  /** 没有 accepted 小结时的拒绝原因 */
  errors: string[]
  ms: number
  costUsd: number
}

export function digestStrips(audit: ModeratorAuditEntry[]): Map<number, DigestStrip> {
  const out = new Map<number, DigestStrip>()
  const ordered = [...audit].sort((a, b) => a.round - b.round)
  let prevPoints: Set<string> = new Set()
  let prevDisputes: Set<string> = new Set()

  for (const a of ordered) {
    const d = a.accepted
    // attempts/unknownAliases 在主进程一定存在，但会话 JSON 是外部输入：
    // 老场次的存档缺字段时，整屏不该因为一条附录而白掉（这一屏没有 ErrorBoundary）
    const attempts = a.attempts ?? []
    const strip: DigestStrip = {
      round: a.round,
      accepted: !!d,
      points: d?.consensus_points?.length ?? 0,
      disputes: d?.open_disputes?.length ?? 0,
      newPoints: 0,
      newDisputes: 0,
      callout: d?.callout?.instruction ?? null,
      calloutTarget: d?.callout?.target_agent ?? null,
      explored: d?.explored_directions?.length ?? 0,
      attempts: attempts.length,
      unknownAliases: a.unknownAliases ?? [],
      errors: attempts.filter((x) => !x.ok).flatMap((x) => x.validation?.errors ?? []).slice(0, 2),
      ms: attempts.reduce((s, x) => s + (x.ms || 0), 0),
      costUsd: attempts.reduce((s, x) => s + (x.costUsd || 0), 0),
    }
    if (d) {
      const claims = new Set((d.consensus_points ?? []).map((p) => p.claim))
      const dc = new Set((d.open_disputes ?? []).map((p) => p.claim))
      strip.newPoints = [...claims].filter((c) => !prevPoints.has(c)).length
      strip.newDisputes = [...dc].filter((c) => !prevDisputes.has(c)).length
      prevPoints = claims
      prevDisputes = dc
    }
    out.set(a.round, strip)
  }
  return out
}

/** ⏱：秒级够用，超过一分钟才换成分秒 */
export function fmtSpan(ms: number): string {
  if (!ms || ms <= 0) return '—'
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

/** $：4 位小数。网页通道的 0 由调用方标注「不计费」，这里不替它解释 */
export function fmtUsd(v: number): string {
  return `$${(v || 0).toFixed(4)}`
}

export function fmtTokens(n: number): string {
  if (!n) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}
