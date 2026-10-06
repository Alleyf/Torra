/**
 * 默认参与名单 —— 「一场要等多久」在这一步就定了
 *
 * 旧行为是「把所有健康的模型都勾上」，而健康里混着网页通道：
 * 网页模型一轮要等它出首字、等它停止生成、再等 settle，单条发言动辄几十秒，
 * 三个网页模型并列也能把一轮拖到两三分钟。用户感知的「研讨太慢」大部分来自这里，
 * 不是 API 通道慢 —— API 通道走的是流式请求，一轮几秒到几十秒。
 *
 * 所以默认名单优先 API，凑不满才补网页模型，并且带数量上限：
 * 这不是限制用户（界面上随时能加），而是别在第一次点「开始讨论」时
 * 就把人放进一场十分钟的讨论。
 */

import type { TransportKind } from './types'

/** 默认勾选的参与模型上限：3 个足够形成交锋，再多是线性加时 */
export const DEFAULT_PARTICIPANT_CAP = 3

/** 判定「这个模型现在能不能发言」的最小字段集（与 ModelSummary 结构兼容） */
export interface ParticipantCandidate {
  id: string
  transport: TransportKind
  enabled: boolean
  hasKey: boolean
  status: string
  supportsStructuredOutput?: boolean
}

/**
 * 能不能发言的统一口径：API 要有 Key，网页要已登录。
 *
 * 只写一处是有原因的：store 的默认勾选和新建页的「还不能开场」提示用的是同一条判据，
 * 两套判断会自相矛盾 —— 上面说缺，下面的名单却已经给人选上了。
 */
export function isUsableModel(m: ParticipantCandidate): boolean {
  if (!m.enabled) return false
  return m.transport === 'api' ? m.hasKey : m.status === 'ready'
}

export function usableModels<T extends ParticipantCandidate>(list: T[]): T[] {
  return list.filter((m) => isUsableModel(m))
}

/**
 * 默认参与名单。
 *
 * API 模型够两个就只选 API（最快的一条路）；不够才用网页模型补满上限 ——
 * 一个 API 模型当不了主持人又孤掌难鸣，此时有网页模型总比开不了场好。
 * 主持默认不进名单：它兼发言会多等一轮它的作答，而且随后要由它自己评判自己说过的话。
 * 只是**默认**不选 —— 界面上随时能把主持勾进参会名单（见 validateSessionConfig）。
 */
export function pickDefaultParticipants<T extends ParticipantCandidate>(
  list: T[],
  moderatorId: string | null,
): string[] {
  const usable = usableModels(list).filter((m) => m.id !== moderatorId)
  const api = usable.filter((m) => m.transport === 'api')
  const web = usable.filter((m) => m.transport !== 'api')
  const pool = api.length >= 2 ? api : [...api, ...web]
  return pool.slice(0, DEFAULT_PARTICIPANT_CAP).map((m) => m.id)
}

/**
 * 已选名单的通道构成，用于界面把「这场大概要多久」说在人点开始之前。
 *
 * 只说通道个数，不编造具体分钟数 —— 单轮耗时由模型、网络、议题长度共同决定，
 * 报一个假精确的时间比报「有网页模型会更慢」更容易误导。
 */
export function channelMix(ids: string[], list: ParticipantCandidate[]): { api: number; webview: number } {
  const byId = new Map(list.map((m) => [m.id, m]))
  let api = 0
  let webview = 0
  for (const id of ids) {
    const m = byId.get(id)
    if (!m) continue
    if (m.transport === 'api') api += 1
    else webview += 1
  }
  return { api, webview }
}

/**
 * 单轮墙钟预算（编排器里超时即判该模型本轮缺席）。
 *
 * 纯 API 场把默认 240s 留着没意义：API 正常几十秒就完，等满 240s 只是
 * 让一个卡住的请求把整轮拖住。网页场必须留足时间 —— 那是在等一个真人页面
 * 把答案打完。有网页模型就按网页算，宁可慢也别把正常作答误判成缺席。
 */
export const ROUND_WALL_CLOCK_API_MS = 90_000
export const ROUND_WALL_CLOCK_WEB_MS = 240_000

/** 按这一轮实际要等的通道取墙钟：有网页模型就按网页算 */
export function roundWallClockMs(transports: TransportKind[]): number {
  return transports.includes('webview') ? ROUND_WALL_CLOCK_WEB_MS : ROUND_WALL_CLOCK_API_MS
}
