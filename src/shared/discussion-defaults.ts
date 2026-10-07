/**
 * 讨论参数的出厂默认值、以及「越界值怎么收回来」的唯一口径。
 *
 * 分成两层：出厂值是这里的常量（改代码才会变），用户自己调的「我的默认」只存
 * **与出厂不同的那几项**，落 preferences.json 的 discussionDefaults 键。
 *
 * 钳制在读取侧也做一遍，不只在写入侧：偏好文件是纯文本，手改一个 maxRounds: 999
 * 要是原样灌进界面，第一场讨论就被主进程拒掉，而拒掉的理由看起来像代码写错了。
 * 区间数字与主进程 validateSessionInput 同组（见 src/main/index.ts 的会话校验）。
 */

import type { StrategyKind, VerifyPassMode } from './types'
import { TIME_BUDGET_DEFAULT_MS, TIME_BUDGET_MAX_MS, TIME_BUDGET_MIN_MS, VERIFY_PASS_DEFAULT } from './types'

/**
 * 「怎么讨论」这一组参数，与会话配置同形。
 *
 * 这里头没有共识阈值：收束早就不看加权分了（判定只认结构条件与轮数/费用/时长三个天花板），
 * 会话配置里也不再带它；旧存档各自记着当年的那条线，只在回看时显示。
 */
export interface DiscussionConfig {
  strategy: StrategyKind
  maxRounds: number
  budgetLimitUsd: number
  anonymousReview: boolean
  baseline: boolean
  baselineCompare: boolean
  verifyPass: VerifyPassMode
  timeBudgetMin: number
}

export type DiscussionConfigKey = keyof DiscussionConfig

/** 只存差异的覆盖表：键不存在 = 该项用出厂值 */
export type DiscussionDefaultsPatch = Partial<DiscussionConfig>

export const DISCUSSION_DEFAULTS: DiscussionConfig = {
  strategy: 'roundtable',
  maxRounds: 3,
  budgetLimitUsd: 2,
  anonymousReview: false,
  baseline: true,
  baselineCompare: true,
  verifyPass: VERIFY_PASS_DEFAULT,
  timeBudgetMin: Math.round(TIME_BUDGET_DEFAULT_MS / 60_000),
}

/** 白名单就是这张表的键集合：界面的行序另有一表，恢复作用域只认这里 */
export const DISCUSSION_CONFIG_KEYS = Object.keys(DISCUSSION_DEFAULTS) as DiscussionConfigKey[]

type Bound =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'bool' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'num'; min: number; max: number }

const BOUNDS: Record<DiscussionConfigKey, Bound> = {
  strategy: { kind: 'enum', values: ['roundtable', 'debate', 'review'] },
  maxRounds: { kind: 'int', min: 1, max: 20 },
  budgetLimitUsd: { kind: 'num', min: 0.1, max: 100_000 },
  anonymousReview: { kind: 'bool' },
  baseline: { kind: 'bool' },
  baselineCompare: { kind: 'bool' },
  verifyPass: { kind: 'enum', values: ['off', 'auto', 'always'] },
  // 单位换算只在这一处发生：主进程拿到的仍是毫秒
  timeBudgetMin: { kind: 'int', min: Math.round(TIME_BUDGET_MIN_MS / 60_000), max: Math.round(TIME_BUDGET_MAX_MS / 60_000) },
}

/**
 * 单项收进可用值：越界夹紧，非法返回 undefined（调用方丢弃该项，回落出厂值）。
 *
 * 「丢弃」而不是「报错」：默认值缺失只是回到出厂那一组，不该让整份偏好作废，
 * 更不该让设置页在打开时就抛异常。
 */
export function normalizeDefault(key: DiscussionConfigKey, raw: unknown): DiscussionConfig[DiscussionConfigKey] | undefined {
  const bound = BOUNDS[key]
  if (bound.kind === 'bool') return typeof raw === 'boolean' ? (raw as never) : undefined
  if (bound.kind === 'enum') return bound.values.includes(String(raw)) ? (raw as never) : undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  const clamped = Math.min(bound.max, Math.max(bound.min, raw))
  return (bound.kind === 'int' ? Math.round(clamped) : clamped) as never
}

/** 一份来源不明的对象 → 干净的覆盖表：不认识键丢弃、越界钳制、非法值丢弃 */
export function sanitizeDiscussionDefaults(raw: unknown): DiscussionDefaultsPatch {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  for (const key of DISCUSSION_CONFIG_KEYS) {
    const v = normalizeDefault(key, src[key])
    // 与出厂值相同的项不进覆盖表：偏好文件只写「我改了什么」
    if (v !== undefined && v !== DISCUSSION_DEFAULTS[key]) out[key] = v
  }
  return out as DiscussionDefaultsPatch
}

/** 生效默认 = 出厂 ⊕ 我的覆盖，永远是一份完整的八项配置 */
export function resolveDiscussionDefaults(patch: unknown): DiscussionConfig {
  return { ...DISCUSSION_DEFAULTS, ...sanitizeDiscussionDefaults(patch) }
}

/**
 * 数值项的可用区间，供输入框写 min/max/step。
 * 界面不自己抄一份数字：抄了就等于第三个真相，改边界的人只会改这里。
 */
export function numberBound(key: DiscussionConfigKey): { min: number; max: number; step: number } | null {
  const bound = BOUNDS[key]
  if (bound.kind !== 'int' && bound.kind !== 'num') return null
  return { min: bound.min, max: bound.max, step: bound.kind === 'int' ? 1 : 0.1 }
}

/** 枚举项的取值表，供分段按钮渲染 */
export function enumValues(key: DiscussionConfigKey): string[] {
  const bound = BOUNDS[key]
  return bound.kind === 'enum' ? [...bound.values] : []
}
