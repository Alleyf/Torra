/**
 * WallSeam —— 原生墙里格与格之间那条能拖开的缝（切分树里的一段边界）。
 *
 * 它为什么必须是一段自己的命中带，而不是盖在 gap 上的把手：
 * WebContentsView 永远画在渲染层之上，压在窗格上的那几像素收不到指针。
 * 旧的 .col-split 用负 margin 借邻居 3.5px 在这行得通（那一侧全是 DOM），
 * 搬到墙上就成了「看着有把手，鼠标按下去是站点页面」。所以缝自己占 7px
 * （矩形由 chatWall.layoutWall 给出），缝里没有视图，指针才落得下来；
 * 那道发丝线由 ::after 画在正中间。
 *
 * 一条缝只属于切分树里的**一个节点**：拖动它只改该节点下相邻两个子矩形的比例，
 * 子树之外的格子一像素都不动 —— 这就是「精确控制单个网页模型」取代
 * 「一拖牵动整行整列」的地方。形状（有几格、怎么切）不随拖动改变，
 * 所以也不需要旧那套「拖动期间钉住格数」的补丁。
 */

import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { FLOOR_PANE, shiftSeam, type WallSeamSeg } from '../chatWall'

/** 缝的轴：x = 竖直缝（拖它改宽），y = 水平缝（拖它改高）。与切分树的 axis 同口径 */
export type SeamAxis = 'x' | 'y'

/** 这一轴的地板档：拖到最窄那一格只剩它就停手（见 chatWall.shiftSeam） */
const floorOf = (axis: SeamAxis): number => (axis === 'x' ? FLOOR_PANE.w : FLOOR_PANE.h)

export function WallSeam({
  seam,
  onDragStart,
  onDrag,
  onEnd,
  onReset,
  style,
}: {
  /** layoutWall 铺出来的那一段缝：轴、所属节点路径、总像素与当下权重都在这里 */
  seam: WallSeamSeg
  onDragStart: () => void
  /** 拖动中：新的这一组子格权重（只覆盖 seam.path 那个节点） */
  onDrag: (next: number[]) => void
  /** 松手：next 为 null 表示这一趟根本没挪动（只是点了一下） */
  onEnd: (next: number[] | null) => void
  /** 双击：恢复等分 */
  onReset: () => void
  style?: CSSProperties
}) {
  const { axis, index, totalPx: total, weights } = seam
  const start = useRef<{ at: number; base: number[] } | null>(null)
  const latest = useRef<number[] | null>(null)
  /** 位移：向右/向下为正 = 把左（上）那一格推宽，两轴同一个口径 */
  const pos = (e: ReactPointerEvent<HTMLDivElement>) => (axis === 'x' ? e.clientX : e.clientY)

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { at: pos(e), base: weights }
    latest.current = null
    onDragStart()
    document.body.classList.add(axis === 'x' ? 'wall-resizing-col' : 'wall-resizing-row')
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
    document.body.classList.remove(axis === 'x' ? 'wall-resizing-col' : 'wall-resizing-row')
    onEnd(latest.current)
    latest.current = null
  }

  return (
    <div
      className={`cx-wall-seam ${axis === 'x' ? 'seam-col' : 'seam-row'}`}
      style={style}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={axis === 'x' ? '调整相邻两格的宽度' : '调整相邻两格的高度'}
      tabIndex={0}
      title={
        axis === 'x'
          ? '拖动只改这两格的宽窄（其余格一像素不动）· 双击恢复等分 · 最窄拖到地板档就停手'
          : '拖动只改这两格的高低（其余格一像素不动）· 双击恢复等分 · 最窄拖到地板档就停手'
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
