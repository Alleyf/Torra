/**
 * 交接稿的中转站：渲染层 → 插件面板。
 *
 * 面板帧不一定在那儿：插件可能刚启用、进程可能还没起来、用户可能还没点进那条屏。
 * 所以这里只做一件事 —— 存住一份待送的交接稿，等有人来取。
 *
 * 取的人（PluginFrame）只在「帧已经 onLoad」时才真的把它送出去，送完就清掉：
 * 不然来回切标签页会把同一场结论重复灌进主线。
 *
 * 同时只存一份：研讨一次只结束一场，后来的交接稿顶掉先来的那份，
 * 免得用户先点的那一场在半小时后突然冒出来。
 */

import type { HandoffPayload } from '@shared/handoff'

export interface StagedHandoff {
  /** 这份交接稿要送去哪个插件 */
  pluginId: string
  payload: HandoffPayload
  /** 入队时间（毫秒） */
  at: number
}

type Listener = (staged: StagedHandoff) => void

let pending: StagedHandoff | null = null
const listeners = new Set<Listener>()

/** 存一份待送的交接稿 */
export function stageHandoff(pluginId: string, payload: HandoffPayload): StagedHandoff {
  const staged: StagedHandoff = { pluginId, payload, at: Date.now() }
  pending = staged
  listeners.forEach((fn) => {
    try {
      fn(staged)
    } catch {
      // 订阅者出错不能带坏中转站：这份稿子还得等下一个订阅者来取
    }
  })
  return staged
}

/** 现在有一份待送的交接稿吗？是给哪个插件的？ */
export function pendingHandoff(): StagedHandoff | null {
  return pending
}

/** 给某个插件准备的交接稿（不是给它的就不给） */
export function handoffFor(pluginId: string): HandoffPayload | null {
  return pending && pending.pluginId === pluginId ? pending.payload : null
}

/** 送到了才清 */
export function clearHandoff(pluginId?: string): void {
  if (!pending) return
  if (pluginId && pending.pluginId !== pluginId) return
  pending = null
}

/** 订阅「有新的交接稿了」：插件面板的帧就绪后会来这里取 */
export function onHandoff(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
