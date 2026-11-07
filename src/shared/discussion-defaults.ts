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
 * 「怎么讨论」这一组参数，与会话配置同形 —— 提示词那四句除外：
 * 它们是发给模型的句子，只住在这张表里，会话配置不带它们。
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
  /**
   * 主持小结的输出 token 上限（每轮小结、基线对照、终局审校三处共用）。
   *
   * 为什么可调而不是写死：这个上限跟端点语义绑在一起 —— `responses` 的
   * max_output_tokens 含推理 token，推理模型可以把预算全烧在思考上、一个可见字
   * 都不给；`anthropic-messages` 不开 thinking 时只算可见输出。同一个 8192 喂给
   * 两种端点，结果可能一边刚好、一边全空。所以交给每场自己定，默认仍是 8192
   * （实测 4096 会把长小结切在半路，整场以 no-moderator 收场）。
   */
  moderatorMaxTokens: number
  /**
   * 研讨提示词四句。挪进这张表的唯一理由是「出厂文案只该有一处」：
   * 两条通道各自装配提示词，文案若内联在装配代码里，改一句要动两处，
   * 而设置页还没有地方看见它。
   *
   * speakerTurnClose / speakerTurnAlone 里的 {{maxLen}} 是占位符，
   * 装配方必须 replaceAll 成当轮字数上限，原样发给模型等于把模板当指令。
   */
  speakerRoleHint: string
  speakerTurnClose: string
  speakerTurnAlone: string
  moderatorRoleHint: string
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
  moderatorMaxTokens: 8_192,
  speakerRoleHint:
    '你参与一场协商，目标是和在场的人一起得出一份彼此都能接受的结论。先把议题读透，再讲清楚自己这一环的判断；接住别人已经说过的、把它往共识推进一步，比另起一个说法更有价值。观点相左时说清分歧在哪、缺哪份证据，不为了显得有立场而硬找对立面。',
  speakerTurnClose:
    '请输出你的判断与论据（≤{{maxLen}} 字）。能接住上面「他人论点原话」里的一条就接 —— 认同并补充、指出它站不住的地方、或提出它没覆盖的另一种可能，都算一次回应；原样复制它的编号 [utt_…] 或写明「第N轮」，程序会核对这些引用在本场是否真实存在。一条都接不上时，讲自己这一环的新判断即可：这场讨论要把问题谈透，不要求每一轮都分出胜负。',
  speakerTurnAlone:
    '请输出你的判断与论据（≤{{maxLen}} 字）。引用他人观点时写明「第N轮」或发言编号 [utt_…] —— 程序会核对这些引用在本场是否真实存在。',
  moderatorRoleHint:
    '你是本场多模型讨论的主持人。你的职责是如实记录共识与分歧，而非推动讨论看起来成功。',
}

/** 白名单就是这张表的键集合：界面的行序另有一表，恢复作用域只认这里 */
export const DISCUSSION_CONFIG_KEYS = Object.keys(DISCUSSION_DEFAULTS) as DiscussionConfigKey[]

type Bound =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'bool' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'num'; min: number; max: number }
  // 提示词只限长度不限内容：超上限整条丢弃、回落出厂，不截半句 ——
  // 被拦腰剪掉一半的指令比没有指令更误导
  | { kind: 'string'; max: number }

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
  // 主持输出上限：下限兜住「整份 JSON 小结至少要写这么多」，上限按常见端点的
  // 单次输出天花板给到 64k（超过它的端点多半会直接 400，不如在这里就拦住）
  moderatorMaxTokens: { kind: 'int', min: 1_024, max: 65_536 },
  // 四句提示词的字符上限：够说清一轮怎么说话，又长不到被提示词预算吞掉
  speakerRoleHint: { kind: 'string', max: 1200 },
  speakerTurnClose: { kind: 'string', max: 1200 },
  speakerTurnAlone: { kind: 'string', max: 1200 },
  moderatorRoleHint: { kind: 'string', max: 1200 },
}

/**
 * 单项收进可用值：越界夹紧，非法返回 undefined（调用方丢弃该项，回落出厂值）。
 *
 * 「丢弃」而不是「报错」：默认值缺失只是回到出厂那一组，不该让整份偏好作废，
 * 更不该让设置页在打开时就抛异常。
 */
export function normalizeDefault(key: DiscussionConfigKey, raw: unknown): DiscussionConfig[DiscussionConfigKey] | undefined {
  const bound = BOUNDS[key]
  if (bound.kind === 'string') {
    if (typeof raw !== 'string') return undefined
    // 超上限不夹断也不报错：提示词被剪掉一半比没有更糟，整条丢弃回落出厂值
    return raw.length <= bound.max ? (raw as never) : undefined
  }
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

/** 生效默认 = 出厂 ⊕ 我的覆盖，永远是一份完整的配置（一个键都不缺） */
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

/** 编排器拿到的那四句：从完整配置里挑出来，不带数字/布尔那八项 */
export type DiscussionPrompts = Pick<
  DiscussionConfig,
  'speakerRoleHint' | 'speakerTurnClose' | 'speakerTurnAlone' | 'moderatorRoleHint'
>

/**
 * 字符串项的字符上限，供 textarea 写 maxLength 与超限提示。
 * 与 numberBound 同一个理由：界面不自己抄一份数字，改边界的人只会改这里。
 */
export function stringBound(key: keyof DiscussionPrompts): number | null {
  const bound = BOUNDS[key as DiscussionConfigKey]
  if (bound.kind !== 'string') return null
  return bound.max
}

/** 提示词键：从完整配置里挑出来的那一组，设置页按它单独渲染 */
export type PromptKey = keyof DiscussionPrompts

/**
 * 提示词四句的界面口径：名字与说明都写明这句插在提示词的哪个位置。
 *
 * 与 CONFIG_ROWS 并列而不是并进它：那张表是「区间/枚举/开关」的控件描述，
 * 字符串项没有区间可抄，塞进去会让每条按行渲染的逻辑都多一个分支。
 * 用户改的是一句话，但要知道它落在系统提示、当轮末尾还是主持小结，
 * 否则改坏了无从判断。
 */
export const PROMPT_ROWS: Array<{ key: PromptKey; name: string; hint: string }> = [
  {
    key: 'speakerRoleHint',
    name: '发言者角色',
    hint: '排在参会发言的系统提示里，决定模型把自己当成协商者还是对手',
  },
  {
    key: 'speakerTurnClose',
    name: '发言收尾 · 场上有话可接',
    hint: '排在当轮发言末尾；有人可接时用它，要求回应具体一条论点而不是另起话头',
  },
  {
    key: 'speakerTurnAlone',
    name: '发言收尾 · 无人可接',
    hint: '同样排在当轮末尾；接不上任何人时退用这句，只要求讲清自己这一环',
  },
  {
    key: 'moderatorRoleHint',
    name: '主持人角色',
    hint: '排在主持小结的系统提示首句，决定它记录分歧还是催着讨论「看起来成功」',
  },
]
