/**
 * WebviewDock —— 把主进程的网页视图「嵌」进一枚受控的 DOM 容器。
 *
 * 约束：WebContentsView 由主进程直接挂在主窗口上，永远盖在渲染层之上，
 * 无法成为 DOM 的一部分。若改用 <webview> 标签虽能入流，但会另起一份
 * WebContents，与共享登录态/自动化的实例池割裂 —— 于是「这里登录了、
 * 自动化却读另一份」。
 *
 * 折中：渲染一个带表头的玻璃容器，用 getBoundingClientRect 量出内部
 * body 的矩形，把原生视图边界精确贴合上去，并在窗口缩放 / 容器尺寸变化
 * 时重新贴合。视觉上等同于嵌在元素里，架构上仍是池化的同一实例。
 */

import { useEffect, useRef, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { getFaviconUrls } from './ModelRail'
import type { ModelSummary } from '../store'

function DockFavicon({ m }: { m: ModelSummary }) {
  const urls = getFaviconUrls(m.domain)
  const [idx, setIdx] = useState(0)
  if (urls.length > 0 && idx < urls.length) {
    return (
      <img
        src={urls[idx]}
        alt=""
        crossOrigin="anonymous"
        className="wdh-favicon"
        onError={() => setIdx((p) => p + 1)}
      />
    )
  }
  return <span className="wdh-favicon dot" style={{ background: m.color }} />
}

export function WebviewDock({
  model,
  onClose,
  onRecheck,
}: {
  model: ModelSummary
  onClose: () => void
  onRecheck?: () => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bounds = () => {
      const el = bodyRef.current
      if (!el) return undefined
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
    }
    const present = () => {
      const b = bounds()
      if (b) void window.torra.presentWebview(model.id, b)
    }
    // 等一帧让 dock 完成布局，再量取贴合的矩形
    const raf = requestAnimationFrame(present)
    window.addEventListener('resize', present)
    const ro = new ResizeObserver(present)
    if (bodyRef.current) ro.observe(bodyRef.current)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', present)
      ro.disconnect()
      void window.torra.dismissWebview(model.id)
    }
  }, [model.id])

  return (
    <div className="webview-dock">
      <div className="webview-dock-head">
        <span className="wdh-id">
          <DockFavicon m={model} />
          <b>{model.displayName}</b>
          <span className="wdh-tag">网页视图</span>
        </span>
        <span className="wdh-hint">可在此登录或处理人机验证，登录态与自动化共用同一会话</span>
        <div className="wdh-actions">
          {onRecheck && (
            <button className="btn sm" onClick={onRecheck} title="复核登录状态">
              <RefreshCw size={11} />
              我已登录完成
            </button>
          )}
          <button className="btn sm icon" onClick={onClose} title="关闭网页视图">
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="webview-dock-body" ref={bodyRef} />
    </div>
  )
}
