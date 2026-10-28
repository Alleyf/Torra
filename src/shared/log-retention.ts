/**
 * 日志保留天数：出厂值、可用区间与清洗。
 *
 * 单独一份而不是塞进 discussion-defaults：那组参数管「怎么讨论」，
 * 改它的人只该看到轮次与预算；保留天数是本机运维口径，两者的修改理由不同。
 * 放 shared 是因为同一组数字有三处要用 —— 主进程的清理、界面显示的当前值、
 * 以及偏好文件的清洗；抄两份就会漂移。
 */

export const DEFAULT_LOG_KEEP_DAYS = 14
export const MIN_LOG_KEEP_DAYS = 1
export const MAX_LOG_KEEP_DAYS = 365

/**
 * 归一到可用天数：整数、夹在 1..365。
 *
 * 0 与负数都收成 1 而不是丢弃 —— 「保留 0 天」在语义上等于每次启动都清空，
 * 而这个值还挂在 UI 上，退回默认会让用户以为自己的设置没保存。
 */
export function normalizeLogKeepDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_LOG_KEEP_DAYS
  return Math.min(MAX_LOG_KEEP_DAYS, Math.max(MIN_LOG_KEEP_DAYS, Math.round(n)))
}
