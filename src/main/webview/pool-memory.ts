/**
 * WebView 池的内存取舍（纯函数，不 import electron —— 因此能被 ts-node 直接单测）
 *
 * 为什么要单独一层：池子原先用「实例数 × 250MB」猜占用，七枚网页模型折合 1750MB，
 * 永远落在 1800MB 预算线以下 —— 回收那条路在生产里一次都走不到，空闲实例一直占着
 * 渲染进程常驻到退出。真人站点单枚实测 300~500MB，估值偏低就等于看不见超支。
 *
 * 现在两条判定都吃「实测占用」：池子（pool.ts）用 app.getAppMetrics() 的
 * workingSetSize 按 pid 摊到每枚实例上，本模块只做取舍本身 ——
 * 给一批实例与它们的占用，决定这一轮该回收谁、该挂起谁。
 * 分层的好处是这些取舍能被直接断言（见 scripts/test-pool-memory.ts），
 * 不必再靠「读源码长得像不像」来守。
 */

/** 参与决策的实例视图（由 pool.ts 的 PoolEntry 投影而来） */
export interface Evictable {
  modelId: string
  lastUsedAt: number
  /** 用户正在看（转播/接管）：回收或挂起都会让他当场看到白屏 */
  attached: boolean
  /** 一轮生成正占着。中途拆实例等于把这路直接判缺席 */
  busy?: boolean
  /** 文档还在加载：打断会把页面停在半截 */
  loading?: boolean
  /** 已经处于后台节流状态 */
  suspended?: boolean
}

export interface EvictionOptions {
  entries: readonly Evictable[]
  /** 当前占用（MB）。优先实测，量不到的那几枚由调用方按保守估值补进总数 */
  totalMb: number
  budgetMb: number
  /** 单枚占用量（MB）：同样以实测为准，量不到退回保守估值 */
  mbOf: (e: Evictable) => number
  /** 保护期：lastUsedAt 晚于此刻的实例一律不回收 */
  protectAfter: number
}

export interface EvictionPlan {
  /** 按 LRU 顺序该回收的实例 */
  evict: string[]
  /** 挤完这些还剩多少超支（正数说明可回收的对象已经用尽） */
  remainingOverMb: number
}

/**
 * 超预算时按 LRU 挤人。
 *
 * 三条不动的保护：attached（用户在看）、busy（生成在跑）、loading（还在加载），
 * 以及 15 秒保护期 —— 预热循环与刚 ensure() 的实例远快于它，不会被自己挤掉。
 */
export function planEvictions(opts: EvictionOptions): EvictionPlan {
  let excess = opts.totalMb - opts.budgetMb
  if (excess <= 0) return { evict: [], remainingOverMb: 0 }

  const sorted = [...opts.entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  const evict: string[] = []
  for (const e of sorted) {
    if (excess <= 0) break
    if (e.attached) continue
    if (e.busy) continue
    if (e.loading) continue
    if (e.lastUsedAt > opts.protectAfter) continue
    evict.push(e.modelId)
    excess -= opts.mbOf(e)
  }
  return { evict, remainingOverMb: Math.max(0, excess) }
}

export interface IdleOptions {
  entries: readonly Evictable[]
  now: number
  /** 空闲超过它就该挂起渲染（省的是 CPU，不是内存） */
  idleMs: number
  /**
   * 空闲超过它就整枚回收（真正把内存还给系统）。
   * 传 0 表示这一轮只挂起、不回收 —— 讨论进行中的不变量就是这个 0（见 pool.ts 的 sweepIdle）。
   */
  disposeIdleMs: number
}

export interface IdlePlan {
  /** 这一轮新挂起的实例 */
  suspend: string[]
  /** 这一轮该销毁的实例 */
  dispose: string[]
}

/**
 * 空闲清扫的取舍。
 *
 * 与回收共用同一批保护：attached / busy / loading 既不挂起也不回收。
 * 挂起只降 CPU 占用，回收才真的把内存还给系统 —— 所以两者阈值分开：
 * 先挂起（3 分钟没碰），久到 disposeIdleMs 才拆实例（下一次用到由 ensure() 重建，
 * partition 数据保留，登录态不丢）。
 */
export function planIdle(opts: IdleOptions): IdlePlan {
  const suspend: string[] = []
  const dispose: string[] = []
  const sorted = [...opts.entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt)

  for (const e of sorted) {
    if (e.attached) continue
    if (e.busy) continue
    if (e.loading) continue
    const idleFor = opts.now - e.lastUsedAt
    if (idleFor < opts.idleMs) continue
    if (opts.disposeIdleMs > 0 && idleFor >= opts.disposeIdleMs) {
      dispose.push(e.modelId)
      continue
    }
    if (!e.suspended) suspend.push(e.modelId)
  }
  return { suspend, dispose }
}

/**
 * 常驻枚数与系统内存压力。
 *
 * 为什么要有「枚数」这一道，光有 MB 预算不够：实测单枚从 120MB 到 500MB 都有，
 * 按 MB 挤容易「挤掉三枚小的、留下一枚大的」，用户看到的是内存没降还多了重建。
 * 枚数是用户能理解的单位（「同时最多留 3 枚在后台」），也和真实成本一一对应 ——
 * 一枚就是一个 Chromium 渲染进程。
 */

export interface WarmLimitOptions {
  entries: readonly Evictable[]
  /**
   * 最多常驻几枚。
   * 传 0 = 「只留正在看的/在跑的」。
   * attached（用户在看）/ busy（生成在跑）/ loading（还在加载）既不占名额也不被裁 ——
   * 否则「用户正看 1 枚 + 限额 3」会把后台清空，下一场讨论全部冷启动。
   */
  limit: number
  protectAfter: number
}

/** 按「保留最近用过的 limit 枚」裁剪，返回该回收的实例（按最久没用的先走） */
export function planLimit(opts: WarmLimitOptions): string[] {
  const limit = Math.max(0, Math.floor(opts.limit))
  // 从最近用过的往回数：名额先给最近的，数满之后的（也就是更久没用的）才是该裁的
  const sorted = [...opts.entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  const evict: Evictable[] = []
  let kept = 0

  for (const e of sorted) {
    if (e.attached) continue
    if (e.busy) continue
    if (e.loading) continue
    // 保护期内的算「保留」：刚 ensure()/刚用过的那几枚不该被这一轮裁掉
    if (e.lastUsedAt > opts.protectAfter || kept < limit) {
      kept += 1
      continue
    }
    evict.push(e)
  }
  // 归还顺序按最久没用的先走：日志里读起来才是「先牺牲了谁」
  return evict.sort((a, b) => a.lastUsedAt - b.lastUsedAt).map((e) => e.modelId)
}

/** 系统可用内存低于这个绝对量就算紧张（MB） */
export const PRESSURE_FREE_MB = 800
/** 或可用内存低于总内存的这个比例 */
export const PRESSURE_FREE_RATIO = 0.1

export interface PressureSample {
  /** 系统可用物理内存（MB） */
  freeMb: number
  /** 系统物理内存总量（MB） */
  totalMb: number
}

/**
 * 是否处于内存紧张。
 *
 * 读不到（freeMb 非正数）一律判「不紧张」：宁可少回收一次，
 * 也不能因为一次失败的读数把用户正在等的那几枚实例全拆了。
 */
export function underPressure(s: PressureSample | null | undefined): boolean {
  if (!s) return false
  if (!Number.isFinite(s.freeMb) || s.freeMb <= 0) return false
  if (s.freeMb <= PRESSURE_FREE_MB) return true
  return Number.isFinite(s.totalMb) && s.totalMb > 0 && s.freeMb / s.totalMb <= PRESSURE_FREE_RATIO
}
