/**
 * 聊天历史的落盘节奏。
 *
 * 逐字流期间 store 每个 token 都会换一次 chats 的引用，而 localStorage 是同步 API：
 * 跟着每帧跑就等于每个 token 全量 stringify + 一次主线程写盘，会话越长越贵。
 * 这里把「变化」和「落盘」解耦 —— 变化只更新快照，落盘最多每 debounceMs 一次，
 * 关窗/切走/卸载再补一次，保证防抖窗口里最多丢这几百毫秒、不会丢到最后一步。
 *
 * DOM-free：写盘动作与定时器都由外部注入，所以 ts-node 就能把节奏本身测干净。
 */

/** 与 layout.ts 的列宽防抖同一口径 */
export const CHATS_SAVE_DEBOUNCE_MS = 320

export type ChatsPut = (key: string, json: string) => void
/** 安排一次延迟执行，返回取消函数 */
export type ChatsDelay = (fn: () => void, ms: number) => () => void

export interface ChatsSaver {
  /** 每次快照变化都调：只记下最新值，队列里已有定时器就不重排 */
  schedule(snapshot: unknown): void
  /** 立刻落盘并清空队列；没有待写内容时是空操作 */
  flush(): void
}

function browserDelay(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export function createChatsSaver(
  key: string,
  put: ChatsPut,
  debounceMs: number = CHATS_SAVE_DEBOUNCE_MS,
  delay: ChatsDelay = browserDelay,
): ChatsSaver {
  let latest: unknown = null
  let dirty = false
  let cancel: (() => void) | null = null

  const write = (): void => {
    cancel = null
    if (!dirty) return
    dirty = false
    const json = JSON.stringify(latest)
    latest = null
    put(key, json)
  }

  return {
    schedule(snapshot): void {
      latest = snapshot
      dirty = true
      if (cancel) return
      cancel = delay(write, debounceMs)
    },
    flush(): void {
      if (cancel) cancel()
      write()
    },
  }
}
