/**
 * WallSeam —— 原生墙里格与格之间那条能拖开的缝。
 *
 * 它为什么必须是一条真的栅格轨道，而不是盖在 gap 上的把手：
 * WebContentsView 永远画在渲染层之上，压在窗格上的那几像素收不到指针。
 * 旧的 .col-split 用负 margin 借邻居 3.5px 在这行得通（那一侧全是 DOM），
 * 搬到墙上就成了「看着有把手，鼠标按下去是站点页面」。所以缝自己占 7px，
 * 缝里没有视图，指针才落得下来；那道发丝线由 ::after 画在正中间。
 *
 * 拖动期间父层会钉住形状（planPanes 的 hold/cap）：不钉的话，把某一格拖窄到
 * 破地板档的那一瞬间列数就退了，这根把手所属的格子当场消失，指针像被弹开。
 * 松手之后才让父层重算 —— 该少挂的少挂、该重新等分的重新等分。
 */

import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { FLOOR_PANE, shiftSeam } from '../chatWall'

export type SeamAxis = 'col' | 'row'

/** 这一轴的地板档：拖到最窄那一格只剩它就停手（见 chatWall.shiftSeam） */
const floorOf = (axis: SeamAxis): number => (axis === 'col' ? FLOOR_PANE.w : FLOOR_PANE.h)

export function WallSeam({
  axis,
  index,
  total,
  weights,
  onDragStart,
  onDrag,
  onEnd,
  onReset,
  style,
}: {
  /** col = 竖直缝（拖它改列宽），row = 水平缝（拖它改行高） */
  axis: SeamAxis
  /** 这条缝在第几格与第几格之间（0 起） */
  index: number
  /** 这一轴此刻的总像素（含缝）：位移换权重要用它 */
  total: number
  /** 父层当前生效的权重（键盘微调拿它当基准，鼠标拖动拿按下那一刻的快照当基准） */
  weights: number[]
  onDragStart: () => void
  onDrag: (next: number[]) => void
  /** 松手：next 为 null 表示这一趟根本没挪动（只是点了一下） */
  onEnd: (next: number[] | null) => void
  /** 双击：恢复等分 */
  onReset: () => void
  style?: CSSProperties
}) {
  const start = useRef<{ at: number; base: number[] } | null>(null)
  const latest = useRef<number[] | null>(null)
  /** 位移：向右/向下为正 = 把左（上）那一格推宽，两轴同一个口径 */
  const pos = (e: ReactPointerEvent<HTMLDivElement>) => (axis === 'col' ? e.clientX : e.clientY)

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { at: pos(e), base: weights }
    latest.current = null
    onDragStart()
    document.body.classList.add(axis === 'col' ? 'wall-resizing-col' : 'wall-resizing-row')
  }

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current
    if (!s) return
    const next = shiftSeam(total, s.base, index, pos(e) - s.at, floorOf(axis))
    latest.current = next
    onDrag(next)
  }

  const stop = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    start.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove(axis === 'col' ? 'wall-resizing-col' : 'wall-resizing-row')
    onEnd(latest.current)
    latest.current = null
  }

  return (
    <div
      className={`cx-wall-seam ${axis === 'col' ? 'seam-col' : 'seam-row'}`}
      style={style}
      role="separator"
      aria-orientation={axis === 'col' ? 'vertical' : 'horizontal'}
      aria-label={axis === 'col' ? `调整第 ${index + 1} 与第 ${index + 2} 格的宽度` : `调整第 ${index + 1} 与第 ${index + 2} 行的高度`}
      tabIndex={0}
      title={
        axis === 'col'
          ? '拖动改这两格的宽窄（其余格不动）· 双击恢复等分 · 最窄拖到地板档就停手'
          : '拖动改这两行的高低（其余行不动）· 双击恢复等分 · 最窄拖到地板档就停手'
      }
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown'
        if (!back && !fwd) return
        e.preventDefault()
        const next = shiftSeam(total, weights, index, fwd ? 16 : -16, floorOf(axis))
        onDrag(next)
        onEnd(next)
      }}
      onDoubleClick={onReset}
    />
  )
}
