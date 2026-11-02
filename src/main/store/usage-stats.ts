/**
 * 本机使用统计（PRD 12 章 V1.1 度量机制 ①）。
 *
 * Torra 承诺「数据本地存储」，所以没有遥测——12 章的留存/完成率/导出率在
 * 「不外传」的前提下本会无法度量。这个模块是替代口径的第一件：把公测要用的
 * 几个数字**只算在本机**（preferences.json 的 usageStats 键），用户自己看得到，
 * 种子用户自报时也有数可依。它不是分析系统：没有事件流、没有分桶、没有上报。
 *
 * 挂点只有两类：会话收束（finalizeSession / 恢复孤儿）与报告导出成功。
 * 全部 try-catch 吞错 —— 统计坏了不能拖累任何主链路，宁可这一版数字缺着。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { usageDayKey, type UsageLedger, type UsageLedgerDelta, type UsageLedgerDay, type UsageLedgerEntry, type UsageStats } from '../../shared/update'

// 口径只在 shared 声明一次（AboutInfo.usage 与这里必须是同一份账）
export type { UsageStats }

/**
 * 按天分桶只留最近 30 天。
 *
 * 总账与按模型的累计永不裁剪 —— 那是「这台机器上花掉多少」的答案。
 * 但按天的桶只是给柱状图看的近期趋势，留着一年前几百个零散日期没有意义。
 */
export const LEDGER_DAYS_KEPT = 30

export function emptyUsageStats(): UsageStats {
  return {
    sessionsStarted: 0,
    sessionsFinished: 0,
    finishedByReason: {},
    reportExports: 0,
    lastSessionAt: 0,
    lastFinishedAt: 0,
    lastExportAt: 0,
  }
}

/** 空账：一次调用都没有过 */
export function emptyUsageLedger(): UsageLedger {
  return {
    models: {},
    days: {},
    totalCostUsd: 0,
    totalCalls: 0,
    webCalls: 0,
    apiCalls: 0,
    updatedAt: 0,
  }
}

/**
 * 从偏好文件里读出统计；坏文件按空账处理 —— 统计丢了可以重攒，
 * 不能因为一段损坏的 JSON 让发起讨论的链路多一个失败点。
 */
export async function readUsageStats(preferencesFile: string): Promise<UsageStats> {
  try {
    const raw = JSON.parse(await fs.readFile(preferencesFile, 'utf8')) as {
      usageStats?: Partial<UsageStats> | null
    }
    return normalizeUsageStats(raw.usageStats)
  } catch {
    return emptyUsageStats()
  }
}

/** 只认字段语义归一（坏值不计入），读到的数永远可显示 */
export function normalizeUsageStats(raw: unknown): UsageStats {
  const out = emptyUsageStats()
  if (typeof raw !== 'object' || raw === null) return out
  const v = raw as Partial<UsageStats>
  const nonNeg = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)
  out.sessionsStarted = nonNeg(v.sessionsStarted)
  out.sessionsFinished = nonNeg(v.sessionsFinished)
  out.reportExports = nonNeg(v.reportExports)
  out.lastSessionAt = nonNeg(v.lastSessionAt)
  out.lastFinishedAt = nonNeg(v.lastFinishedAt)
  out.lastExportAt = nonNeg(v.lastExportAt)
  if (typeof v.finishedByReason === 'object' && v.finishedByReason !== null) {
    for (const [k, n] of Object.entries(v.finishedByReason)) {
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out.finishedByReason[k] = n
    }
  }
  // 账本整个缺席与「账本在但是空」是两种状态：前者从没记过，后者记过又被手改坏了
  if (v.ledger && typeof v.ledger === 'object') out.ledger = normalizeUsageLedger(v.ledger)
  return out
}

/**
 * 账本归一：负数、非有限数一律当 0，形状不对的条目丢掉。
 *
 * 这份账是从 preferences.json 里读回来的，用户可能手改过。
 * 坏值宁可当 0 也不能让界面炸掉 —— 但**不能**因此把「量不到」写成「量到了」：
 * 网页通道的 token 恒为 0 是口径，不是坏值。
 */
export function normalizeUsageLedger(raw: unknown): UsageLedger {
  const out = emptyUsageLedger()
  if (typeof raw !== 'object' || raw === null) return out
  const v = raw as Partial<UsageLedger>
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)
  const int = (x: unknown): number => Math.floor(num(x))
  out.totalCostUsd = num(v.totalCostUsd)
  out.totalCalls = int(v.totalCalls)
  out.webCalls = int(v.webCalls)
  out.apiCalls = int(v.apiCalls)
  out.updatedAt = num(v.updatedAt)
  if (v.models && typeof v.models === 'object') {
    for (const [id, e] of Object.entries(v.models as Record<string, unknown>)) {
      if (!id || !e || typeof e !== 'object') continue
      const row = e as Partial<UsageLedgerEntry>
      out.models[id] = {
        calls: int(row.calls),
        promptTokens: int(row.promptTokens),
        completionTokens: int(row.completionTokens),
        costUsd: num(row.costUsd),
        lastAt: num(row.lastAt),
        transport: row.transport === 'web' ? 'web' : 'api',
        label: typeof row.label === 'string' ? row.label : undefined,
      }
    }
  }
  if (v.days && typeof v.days === 'object') {
    for (const [day, b] of Object.entries(v.days as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !b || typeof b !== 'object') continue
      const bucket = b as Partial<UsageLedgerDay>
      out.days[day] = { calls: int(bucket.calls), costUsd: num(bucket.costUsd) }
    }
  }
  return out
}

/** 丢掉 LEDGER_DAYS_KEPT 天之前的桶；总账与按模型的累计不动 */
function pruneLedgerDays(ledger: UsageLedger, now: number): void {
  const cutoff = dayKeyBefore(now, LEDGER_DAYS_KEPT - 1)
  for (const day of Object.keys(ledger.days)) {
    if (day < cutoff) delete ledger.days[day]
  }
}

/** 本机日期往前推 n 天后的日期键（按日历天算，不是减 24 小时） */
function dayKeyBefore(at: number, days: number): string {
  const d = new Date(at)
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return usageDayKey(d.getTime())
}

/**
 * 记一次调用：按模型累计 token 与金额，网页渠道只记次数。
 *
 * 网页通道拿不到实测 token —— 站点不暴露，字符数折算出来的只是量级参考。
 * 把它折成 token 塞进「花费」这一栏，就是拿估算冒充实测，
 * 所以 web 通道的 token 与金额一律按 0 记，次数照记。
 */
export function noteModelUsage(
  stats: UsageStats,
  modelId: string,
  usage: { promptTokens?: number; completionTokens?: number; costUsd?: number },
  transport: 'api' | 'web',
  at = Date.now(),
  label?: string,
): UsageStats {
  const id = String(modelId ?? '').trim()
  if (!id) return stats
  const isWeb = transport === 'web'
  const day = usageDayKey(at)
  const costUsd = isWeb ? 0 : numOf(usage?.costUsd)
  return mergeUsageDeltas(stats, [
    {
      modelId: id,
      label,
      transport: isWeb ? 'web' : 'api',
      calls: 1,
      promptTokens: isWeb ? 0 : intOf(usage?.promptTokens),
      completionTokens: isWeb ? 0 : intOf(usage?.completionTokens),
      costUsd,
      lastAt: at,
      days: { [day]: { calls: 1, costUsd } },
    },
  ], at)
}

/**
 * 并进一段增量（编排器记完本场，主进程每轮结束拿它来落盘）。
 *
 * 纯函数：算好再写，调用方负责持久化 —— 与本文件其它 note* 同一口径。
 */
export function mergeUsageDeltas(stats: UsageStats, deltas: UsageLedgerDelta[], at = Date.now()): UsageStats {
  if (!deltas.length) return stats
  const ledger = normalizeUsageLedger(stats.ledger)
  for (const d of deltas) {
    const id = String(d?.modelId ?? '').trim()
    if (!id) continue
    const isWeb = d.transport === 'web'
    const calls = intOf(d.calls)
    if (calls <= 0) continue
    const promptTokens = isWeb ? 0 : intOf(d.promptTokens)
    const completionTokens = isWeb ? 0 : intOf(d.completionTokens)
    const costUsd = isWeb ? 0 : numOf(d.costUsd)
    const prev = ledger.models[id]
    ledger.models[id] = {
      calls: (prev?.calls ?? 0) + calls,
      promptTokens: (prev?.promptTokens ?? 0) + promptTokens,
      completionTokens: (prev?.completionTokens ?? 0) + completionTokens,
      costUsd: (prev?.costUsd ?? 0) + costUsd,
      lastAt: Math.max(prev?.lastAt ?? 0, numOf(d.lastAt)),
      transport: isWeb ? 'web' : (prev?.transport ?? 'api'),
      label: d.label ?? prev?.label,
    }
    for (const [day, bucket] of Object.entries(d.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      const b = ledger.days[day]
      ledger.days[day] = {
        calls: (b?.calls ?? 0) + intOf(bucket?.calls),
        costUsd: (b?.costUsd ?? 0) + (isWeb ? 0 : numOf(bucket?.costUsd)),
      }
    }
    ledger.totalCalls += calls
    ledger.totalCostUsd += costUsd
    if (isWeb) ledger.webCalls += calls
    else ledger.apiCalls += calls
  }
  ledger.updatedAt = Math.max(ledger.updatedAt, numOf(at))
  pruneLedgerDays(ledger, at)
  return { ...stats, ledger }
}

/** 坏值一律当 0：宁可少算钱，也不要让界面显示一个编出来的数 */
function numOf(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0
}

function intOf(x: unknown): number {
  return Math.floor(numOf(x))
}

/** 合并一次会话发起。纯函数：算好再写，调用方负责持久化。 */
export function noteSessionStarted(stats: UsageStats, at = Date.now()): UsageStats {
  return {
    ...stats,
    sessionsStarted: stats.sessionsStarted + 1,
    lastSessionAt: Math.max(stats.lastSessionAt, at),
  }
}

/** 合并一次会话收束（拿到报告）。 */
export function noteSessionFinished(stats: UsageStats, reason: string, at = Date.now()): UsageStats {
  return {
    ...stats,
    sessionsFinished: stats.sessionsFinished + 1,
    finishedByReason: { ...stats.finishedByReason, [reason]: (stats.finishedByReason[reason] ?? 0) + 1 },
    lastFinishedAt: Math.max(stats.lastFinishedAt, at),
  }
}

/** 合并一次报告导出成功。 */
export function noteReportExport(stats: UsageStats, at = Date.now()): UsageStats {
  return {
    ...stats,
    reportExports: stats.reportExports + 1,
    lastExportAt: Math.max(stats.lastExportAt, at),
  }
}

/**
 * 写回 preferences.json 的 usageStats 键。
 *
 * 走「读全文件 → 只换这一个键 → 写回」的合并路径，与 index.ts 的 patchPreferences
 * 同一口径 —— 统计与主题/偏好同住一份文件，任何一处按「我关心的字段」整份覆盖
 * 都会把别处刚存的东西抹掉（主题曾因此被清掉一次）。
 */
export async function writeUsageStats(preferencesFile: string, stats: UsageStats): Promise<void> {
  let merged: Record<string, unknown> = {}
  try {
    merged = JSON.parse(await fs.readFile(preferencesFile, 'utf8')) as Record<string, unknown>
  } catch {
    /* 文件不存在或坏了：以空文件为底，别把锅甩给用户 */
  }
  merged.usageStats = stats
  await fs.mkdir(path.dirname(preferencesFile), { recursive: true })
  await fs.writeFile(preferencesFile, JSON.stringify(merged, null, 2), 'utf8')
}
