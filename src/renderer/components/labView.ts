/**
 * 研讨屏的视图坐标：中央三视图 + 右栏五切面。
 *
 * 为什么不做成 store 字段：它们是「这一屏现在看哪儿」，不是这一场的台账。
 * 写进 store 就得跟着场次一起被回放/清空，而实际上换个视图不该动任何数据。
 * 但中央与右栏是两个组件树，点图上的节点要让右栏的「此刻」跟着讲它 ——
 * 所以必须有一份共享状态，且切换要联动：进了协作视图，右栏就是完整台账。
 *
 * 联动只在「用户没自己选过」时生效：他手动点过右栏别的切面，就别再替他切回去。
 */
import { useSyncExternalStore } from 'react'

export type LabTab = 'flow' | 'graph' | 'time'
export type RailView = 'insight' | 'verify' | 'run' | 'cost' | 'ledger'

/**
 * 回放游标（`replay`）：null = 看现在，数字 = 倒回第 r 轮。`playing` 只表示「还在自动走」。
 *
 * 它和 `tab` / `rail` 放在一起，因为它同样是「这一屏现在看哪儿」：观点视图、协作视图、
 * 右栏、页头五步四处必须看同一个游标，各存一份就会出现「上面说回到 R1、右边还列着 R3 的结论」。
 * 台账本身一个字节都不动 —— 回放只改呈现口径，数据仍是从 store 读那一份。
 *
 * 走针（ticker）只有一处，归 `DiscussionLab` 管：它知道这一场的数据跑到第几轮（上限）。
 * 三个视图各自开一根定时器，就会有三根针同时推同一个游标，速度快三倍。
 */
type State = { tab: LabTab; rail: RailView; railPinned: boolean; replay: number | null; playing: boolean }

let state: State = { tab: 'flow', rail: 'insight', railPinned: false, replay: null, playing: false }

const subs = new Set<() => void>()

const emit = () => {
  for (const fn of subs) fn()
}

export function setLabTab(tab: LabTab) {
  if (state.tab === tab) return
  /** 协作视图里点节点会往 store 写 focus，而「此刻」只在台账里：不联动就等于点了没反应 */
  const rail: RailView = tab === 'graph' ? 'ledger' : state.railPinned ? state.rail : 'insight'
  state = { ...state, tab, rail, railPinned: state.railPinned && tab !== 'graph' }
  emit()
}

/**
 * 开始回放：从第 1 轮起。`max` 为 0（一条数据都没有）时什么也不做 ——
 * 否则会停在「回放至 R1」而画面上一个格子都没有，看着像坏了。
 */
export function startReplay(max: number) {
  if (max < 1) return
  state = { ...state, replay: 1, playing: max > 1 }
  emit()
}

/** 停止回放 = 回到现在。手动停不该保留一个半截的游标，那样按钮和画面会各说一件事 */
export function stopReplay() {
  if (state.replay === null && !state.playing) return
  state = { ...state, replay: null, playing: false }
  emit()
}

/**
 * 走一格。到上限就停住不再往前，也不自己退回「现在」——
 * 最后一格的那批结论同样要落光；若在这里直接清空游标，`diffRailPoints` 会把
 * 「退出回放」当成换基准，最后那一轮的光就永远不出现。
 * 停住之后按钮仍显示「停止」（判据是游标在不在，不是走针在不在），再点一次才回到现在。
 */
export function advanceReplay(max: number) {
  if (state.replay === null) return
  const next = Math.min(state.replay + 1, max)
  state = { ...state, replay: next, playing: state.playing && next < max }
  emit()
}

/** 页头那颗按钮：游标在（无论还在走还是停住了）就回现在，否则从头放 */
export function toggleReplay(max: number) {
  if (state.replay !== null) stopReplay()
  else startReplay(max)
}

export function setRailView(rail: RailView) {
  state = { ...state, rail, railPinned: true }
  emit()
}

export function useLabView(): State {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => state,
  )
}
