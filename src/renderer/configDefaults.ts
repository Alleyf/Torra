/**
 * 讨论参数的默认值与「恢复默认值」的白名单。
 *
 * 这里只有一个必须守住的前提：**恢复默认值动的是「怎么讨论」，不是「讨论了什么」**。
 * 议题文字、参与名单、主持指认、历史会话、模型阵容都不在这张表里 —— 用户改坏的是
 * 阈值与预算，被清掉的不该是他写了半天的背景材料。
 *
 * store 的初始值也从这里取，避免「默认值」和「界面上写的默认」两处各写一份、
 * 改了一处另一处悄悄漂移（此前 NewSession 里就硬写过一份预算上限）。
 */

import type { StrategyKind, VerifyPassMode } from '@shared/types'
import { TIME_BUDGET_DEFAULT_MS, VERIFY_PASS_DEFAULT } from '@shared/types'

export interface DiscussionConfig {
  strategy: StrategyKind
  maxRounds: number
  consensusThreshold: number
  budgetLimitUsd: number
  anonymousReview: boolean
  baseline: boolean
  baselineCompare: boolean
  verifyPass: VerifyPassMode
  timeBudgetMin: number
}

export type DiscussionConfigKey = keyof DiscussionConfig

export const CONFIG_DEFAULTS: DiscussionConfig = {
  strategy: 'roundtable',
  maxRounds: 3,
  consensusThreshold: 85,
  budgetLimitUsd: 2,
  anonymousReview: false,
  baseline: true,
  baselineCompare: true,
  verifyPass: VERIFY_PASS_DEFAULT,
  timeBudgetMin: Math.round(TIME_BUDGET_DEFAULT_MS / 60_000),
}

/** 界面顺序与叫法：这一份表同时是「恢复默认值」的作用域 */
export const CONFIG_ROWS: Array<{ key: DiscussionConfigKey; name: string; hint: string }> = [
  { key: 'strategy', name: '讨论策略', hint: '决定模型之间怎么说话' },
  { key: 'maxRounds', name: '最大轮次', hint: '一轮 = 全场各说一次' },
  { key: 'consensusThreshold', name: '共识阈值', hint: '支持度达到这个百分比即视为收敛' },
  { key: 'budgetLimitUsd', name: '预算上限', hint: 'API 通道按美元计，到点收束出报告' },
  { key: 'timeBudgetMin', name: '时长上限', hint: '网页通道不计费，墙钟是唯一兜得住代价的闸门' },
  { key: 'anonymousReview', name: '匿名互评', hint: '主持人只见别名，压制厂商身份带来的偏向' },
  { key: 'baseline', name: '单模型基线', hint: '开场先让一个模型独立作答，作为对照' },
  { key: 'baselineCompare', name: '基线对照', hint: '出报告前比对研讨多出了什么' },
  { key: 'verifyPass', name: '幻觉核验轮', hint: 'off 只测量，auto 风险达标才质询，always 逐条质询' },
]

const STRATEGY_NAME: Record<StrategyKind, string> = {
  roundtable: '圆桌',
  debate: '辩论',
  review: '评审',
}

const VERIFY_NAME: Record<VerifyPassMode, string> = { off: '关闭', auto: '自动', always: '逐条' }

/** 一行的当前值怎么说：开关说人话，数字带单位 */
export function formatConfigValue(key: DiscussionConfigKey, value: DiscussionConfig[DiscussionConfigKey]): string {
  if (key === 'strategy') return STRATEGY_NAME[value as StrategyKind]
  if (key === 'verifyPass') return VERIFY_NAME[value as VerifyPassMode]
  if (key === 'anonymousReview' || key === 'baseline' || key === 'baselineCompare') {
    return value ? '开' : '关'
  }
  if (key === 'maxRounds') return `${value} 轮`
  if (key === 'consensusThreshold') return `${value}%`
  if (key === 'budgetLimitUsd') return `${value} 美元`
  return `${value} 分钟`
}

export interface ConfigDiffItem {
  key: DiscussionConfigKey
  name: string
  current: string
  def: string
}

/**
 * 与默认值不一致的项。
 *
 * 返回空数组就是「没有可恢复的东西」，界面据此把按钮置灰 ——
 * 而不是让用户点一下确认什么都没发生。
 */
export function diffFromDefaults(cur: DiscussionConfig): ConfigDiffItem[] {
  return CONFIG_ROWS.filter((r) => cur[r.key] !== CONFIG_DEFAULTS[r.key]).map((r) => ({
    key: r.key,
    name: r.name,
    current: formatConfigValue(r.key, cur[r.key]),
    def: formatConfigValue(r.key, CONFIG_DEFAULTS[r.key]),
  }))
}
