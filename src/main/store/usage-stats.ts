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
import type { UsageStats } from '../../shared/update'

// 口径只在 shared 声明一次（AboutInfo.usage 与这里必须是同一份账）
export type { UsageStats }

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
  return out
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
