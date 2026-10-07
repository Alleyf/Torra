/**
 * 讨论参数的界面口径：行表（顺序与叫法）、值的文案、以及「与默认不同」的比对。
 *
 * 值本身不在这儿写死 —— 出厂默认表、区间与钳制在 @shared/discussion-defaults，
 * 主进程读偏好时用的是同一份，两处不可能算出两套结果。
 *
 * 这里必须守住的前提：**恢复默认动的是「怎么讨论」，不是「讨论了什么」**。
 * 议题文字、参与名单、主持指认、历史会话、模型阵容都不在这张表里 —— 用户改坏的是
 * 轮次与预算，被清掉的不该是他写了半天的背景材料。
 *
 * 「默认」有两层：出厂值（代码常量）与我的默认（用户在设置页调的，只存差异）。
 * 比对函数一律接受 base 参数，不假设它就是出厂表。
 */

import type { StrategyKind, VerifyPassMode } from '@shared/types'
import {
  DISCUSSION_DEFAULTS,
  type DiscussionConfig,
  type DiscussionConfigKey,
  type DiscussionDefaultsPatch,
} from '@shared/discussion-defaults'

export type { DiscussionConfig, DiscussionConfigKey, DiscussionDefaultsPatch }

/** 出厂默认值。渲染层的旧名字入口；store 初值与开场页兜底都从这里起 */
export const CONFIG_DEFAULTS = DISCUSSION_DEFAULTS

/** 界面顺序与叫法：这一份表同时是「恢复默认值」的可见范围 */
export const CONFIG_ROWS: Array<{ key: DiscussionConfigKey; name: string; hint: string }> = [
  { key: 'strategy', name: '讨论策略', hint: '决定模型之间怎么说话' },
  { key: 'maxRounds', name: '最大轮次', hint: '一轮 = 全场各说一次' },
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

/** 一行的值怎么说：开关说人话，数字带单位 */
export function formatConfigValue(key: DiscussionConfigKey, value: DiscussionConfig[DiscussionConfigKey]): string {
  if (key === 'strategy') return STRATEGY_NAME[value as StrategyKind]
  if (key === 'verifyPass') return VERIFY_NAME[value as VerifyPassMode]
  if (key === 'anonymousReview' || key === 'baseline' || key === 'baselineCompare') {
    return value ? '开' : '关'
  }
  if (key === 'maxRounds') return `${value} 轮`
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
 * base 缺省是出厂表；设置页传进来的是「我的默认」——
 * 按钮的禁用态靠这个返回空数组来判断，而不是让用户点一下确认什么都没发生。
 */
export function diffFromDefaults(cur: DiscussionConfig, base: DiscussionConfig = CONFIG_DEFAULTS): ConfigDiffItem[] {
  return CONFIG_ROWS.filter((r) => cur[r.key] !== base[r.key]).map((r) => ({
    key: r.key,
    name: r.name,
    current: formatConfigValue(r.key, cur[r.key]),
    def: formatConfigValue(r.key, base[r.key]),
  }))
}

/** 与出厂值不同的那几项 —— 设置页抬头用它说「N 项默认已被你改过」 */
export function customizedDefaults(patch: DiscussionDefaultsPatch): DiscussionConfigKey[] {
  return CONFIG_ROWS.map((r) => r.key).filter((k) => patch[k] !== undefined)
}
