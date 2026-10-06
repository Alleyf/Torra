/**
 * Splitter —— 一列的可拖动边界。
 *
 * 起点宽度读真实 DOM 而不是用鼠标坐标推算：CSS 那一侧还有 min/max-width
 * 在夹（网页视图列最宽 880px），拖过夹取点后 DOM 宽和「起点 + 位移」就不相等了，
 * 下一帧再按推算值写回会把手柄甩到鼠标前面去，手感表现为「黏不住」。
 *
 * 用 pointer 事件 + setPointerCapture：原生网页视图盖在渲染层之上，指针一旦
 * 滑出那一列就会丢焦点；capture 让移动/抬起始终回到这条手柄上。
 */

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

export function Splitter({
  dir,
  measure,
  min,
  max,
  onResize,
  label,
  className = '',
  style,
}: {
  /** +1 = 向右拖变宽（左列的右缘）；-1 = 向左拖变宽（右浮层的左缘） */
  dir: 1 | -1
  /** 拖拽起点宽度：每次按下重新量，因为默认值可能是百分比 */
  measure: () => number
  min: number
  max: number | (() => number)
  onResize: (px: number | null) => void
  label: string
  className?: string
  style?: CSSProperties
}) {
  const limit = () => Math.max(min, typeof max === 'function' ? max() : max)
  const clamp = (n: number) => Math.min(Math.max(n, min), limit())

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.dataset.start = String(e.clientX)
    e.currentTarget.dataset.width = String(measure())
    document.body.classList.add('col-resizing')
  }

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.dataset.start === undefined) return
    const dx = e.clientX - Number(el.dataset.start)
    const w = Number(el.dataset.width) + dir * dx
    onResize(clamp(w))
  }

  const stop = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.dataset.start === undefined) return
    delete el.dataset.start
    delete el.dataset.width
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    document.body.classList.remove('col-resizing')
  }

  return (
    <div
      className={`col-split${className ? ' ' + className : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(measure())}
      tabIndex={0}
      title={`${label}（双击恢复默认）`}
      style={style}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        onResize(clamp(measure() + (e.key === 'ArrowRight' ? 16 : -16) * (dir === 1 ? 1 : -1)))
      }}
      onDoubleClick={() => onResize(null)}
    />
  )
}
