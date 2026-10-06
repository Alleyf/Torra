/**
 * 区域尺寸 store —— 拖动分隔条调出来的列宽，跨挂载、跨重启都要保住。
 *
 * 尺寸收在主进程 preferences.layout 下，而不是 localStorage：设置页之外的所有
 * 持久状态都走主进程，这样体检与打包后的实例能读到同一份偏好。
 *
 * 这里刻意只存「用户明确拖过的键」。没拖过的列返回 null，交给 CSS 的相对宽度
 * （网页视图列是 44%）—— 若把首次量到的像素当成默认值写死，用户一放大窗口，
 * 那一列就不再跟着变，看起来像布局坏了。
 */

import { useCallback, useEffect, useState } from 'react'

type Listener = () => void

const widths = new Map<string, number>()
const listeners = new Set<Listener>()
let loading: Promise<void> | null = null
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function emit(): void {
  for (const l of [...listeners]) l()
}

/** 冷启动只问主进程一次：几个区域同时挂载不该各发一次 IPC */
function loadOnce(): void {
  if (loading) return
  loading = window.torra
    .layoutGet()
    .then((m) => {
      for (const [k, v] of Object.entries(m || {})) {
        if (typeof v === 'number' && Number.isFinite(v)) widths.set(k, v)
      }
      emit()
    })
    .catch(() => {})
}

/** 落盘做防抖：拖动时每帧写一次会把主进程排成一条磁盘队列 */
function persist(key: string): void {
  const prev = timers.get(key)
  if (prev) clearTimeout(prev)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      const v = widths.get(key)
      void window.torra.layoutSet(key, v ?? null)
    }, 320),
  )
}

/**
 * 读某一区域的宽度；返回 [像素|null, 设置]。
 * null = 未拖过，用 CSS 默认；传 null 即恢复默认。
 */
export function useStoredWidth(key: string): [number | null, (px: number | null) => void] {
  const [px, setPx] = useState<number | null>(() => widths.get(key) ?? null)

  useEffect(() => {
    const sync = (): void => setPx(widths.get(key) ?? null)
    listeners.add(sync)
    loadOnce()
    sync()
    return () => {
      listeners.delete(sync)
    }
  }, [key])

  const update = useCallback(
    (next: number | null) => {
      if (next === null) widths.delete(key)
      else widths.set(key, Math.round(next))
      emit()
      persist(key)
    },
    [key],
  )

  return [px, update]
}

/** 内联 style 里的宽度变量；未拖过时返回 undefined，让 CSS 默认值生效 */
export function widthVar(name: string, px: number | null): Record<string, string> | undefined {
  return px === null ? undefined : { [name]: `${px}px` }
}
