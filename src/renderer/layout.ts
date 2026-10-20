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
import type { WallBox } from './chatWall'

type Listener = () => void

/** 单个像素宽、一轴的格权重（原生墙的缝），或一份窗格顺序（原生墙拖动交换位置） */
type Stored = number | number[] | string[]

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

/** 一串模型 id；不是字符串、有空缺或重复的都当成「没排过序」，让默认顺序接管 */
function strArrayOf(v: Stored | undefined): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const ids = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((s) => s.trim())
  return ids.length === v.length && new Set(ids).size === ids.length ? ids : null
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
        /** 顺序键存的是 id 数组：不认它的话重启后那份排好的位置会静默回到默认序 */
        const ids = strArrayOf(v as string[])
        if (ids) widths.set(k, [...ids])
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
 * 读一轴的格权重（原生墙拖开的缝）；返回 [权重|null, 设置]。
 *
 * 存比例不存像素：窗口一拉大，存像素的那套就变形（列宽守卫踩过这个坑），
 * 而「这一格比隔壁宽一半」才是用户拖出来的东西。null = 没拖过 = 等分。
 */
export function useStoredWeights(key: string): [number[] | null, (next: number[] | null) => void] {
  const [v, update] = useStored(key)
  return [vecOf(v), (next: number[] | null) => update(next ? next.map((x) => Math.round(x)) : null)]
}

/**
 * 读一份 id 顺序（原生墙拖动交换位置）；返回 [顺序|null, 设置]。
 *
 * 存的是 id 数组而不是像素或下标：参与者被摘掉一个、或新加一个进来，下标会整体错位，
 * 而 id 名单自愈得了 —— 不在场的自然被忽略，新来的按侧栏顺序补到末尾。
 * null = 从没拖过，用侧栏/参与者的原有顺序。
 */
export function useStoredOrder(key: string): [string[] | null, (next: string[] | null) => void] {
  const [v, update] = useStored(key)
  return [strArrayOf(v), (next: string[] | null) => update(next && next.length > 0 ? [...next] : null)]
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
