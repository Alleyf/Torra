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
import type { WallNode } from '../shared/wall-tree'
import { sanitizeWallLayout } from '../shared/wall-tree'
import type { WallBox } from './chatWall'

type Listener = () => void

/**
 * 单个像素宽、一轴的格权重（旧版原生墙的缝）、一份窗格顺序（原生墙拖动交换位置），
 * 或一棵切分树（原生墙的形状与比例）。
 */
type Stored = number | number[] | { root: WallNode }

const widths = new Map<string, Stored>()
const listeners = new Set<Listener>()
let loading: Promise<void> | null = null
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function emit(): void {
  for (const l of [...listeners]) l()
}

/** 只认数字；脏值（旧版本存的对象、手改偏好的字符串）当成「没拖过」 */
function numOf(v: Stored | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function vecOf(v: Stored | undefined): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  return v.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0) ? (v as number[]) : null
}

/**
 * 一棵切分树（原生墙的形状）；判据与主进程同一份（shared/wall-tree），
 * 不合法就当成「没拖过」交给等分 —— 半吊子的树比没有树更难解释。
 */
function treeOf(v: Stored | undefined): { root: WallNode } | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const ok = sanitizeWallLayout(v)
  return ok ? { root: ok.root } : null
}

/** 冷启动只问主进程一次：几个区域同时挂载不该各发一次 IPC */
function loadOnce(): void {
  if (loading) return
  loading = window.torra
    .layoutGet()
    .then((m) => {
      for (const [k, v] of Object.entries(m || {})) {
        const n = numOf(v as number)
        if (n !== null) {
          widths.set(k, n)
          continue
        }
        const arr = vecOf(v as number[])
        if (arr) {
          widths.set(k, [...arr])
          continue
        }
        /** 墙的形状存的是切分树：不认它的话重启后拖出来的宽窄会静默回到等分 */
        const tree = treeOf(v as { root: WallNode })
        if (tree) widths.set(k, tree)
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
    }, 320,
    ),
  )
}

/** 订阅某一区域的存值；值到手或别的区域改动时重算 */
function useStored(key: string): [Stored | undefined, (next: Stored | null) => void] {
  const [v, setV] = useState<Stored | undefined>(() => widths.get(key))
  useEffect(() => {
    const sync = (): void => setV(widths.get(key))
    listeners.add(sync)
    loadOnce()
    sync()
    return () => {
      listeners.delete(sync)
    }
  }, [key])
  const update = useCallback(
    (next: Stored | null) => {
      if (next === null) widths.delete(key)
      else widths.set(key, next)
      emit()
      persist(key)
    },
    [key],
  )
  return [v, update]
}

/**
 * 读某一区域的宽度；返回 [像素|null, 设置]。
 * null = 未拖过，用 CSS 默认；传 null 即恢复默认。
 */
export function useStoredWidth(key: string): [number | null, (px: number | null) => void] {
  const [v, update] = useStored(key)
  return [numOf(v), (px: number | null) => update(px === null ? null : Math.round(px))]
}

/**
 * 读原生墙的切分树（用户拖出来的形状与比例）；返回 [树|null, 设置]。
 *
 * 与旧的每轴一组权重（wall.colw / wall.roww）相比，树把「哪一刀切在哪里」一起存了下来：
 * 权重只能表达「整墙几等分、每份多宽」，所以一条缝必然牵动整行整列。
 * null = 从没拖过 = 交给墙宽自动等分；传 null 即恢复等分。
 */
export function useStoredWallTree(key: string): [WallNode | null, (next: WallNode | null) => void] {
  const [v, update] = useStored(key)
  return [
    treeOf(v)?.root ?? null,
    (next: WallNode | null) => update(next ? sanitizeWallLayout({ root: next }) ?? null : null),
  ]
}

/** 内联 style 里的宽度变量；未拖过时返回 undefined，让 CSS 默认值生效 */
export function widthVar(name: string, px: number | null): Record<string, string> | undefined {
  return px === null ? undefined : { [name]: `${px}px` }
}

/**
 * 量一个元素的可用像素（getBoundingClientRect，含边框）。
 *
 * 原生墙靠它决定「这一屏挂几枚、开几列」：格数不能写死，写死了要么宽屏下半面墙是空的，
 * 要么窄屏上每格糊成一团。测的是网格容器本身，它的高宽都由 flex 与列宽定死，
 * 不随列数变化 —— 所以量它不会和「按尺寸定列数」形成回环。
 *
 * 收元素而不是收 ref：墙只在原生模式下存在，从提取切过来时那个节点是后挂上来的，
 * 传 ref 的话 effect 的依赖永远是那个不变的 ref 对象，切过来量不到东西。
 * 调用方用回调 ref（setState）把节点交进来，节点一出现 effect 就重跑。
 */
export function useElementBox(el: HTMLElement | null): WallBox {
  const [box, setBox] = useState<WallBox>({ w: 0, h: 0 })
  useEffect(() => {
    if (!el) {
      // 节点被卸载（切回提取模式）：把尺寸清成「没得量」，
      // 否则下一次挂载会先按上一场的尺寸算一遍格数，再跳一次。
      setBox((p) => (p.w === 0 && p.h === 0 ? p : { w: 0, h: 0 }))
      return
    }
    const read = (): void => {
      const r = el.getBoundingClientRect()
      setBox((prev) =>
        Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1
          ? prev
          : { w: Math.round(r.width), h: Math.round(r.height) },
      )
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return box
}
