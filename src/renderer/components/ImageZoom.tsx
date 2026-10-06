/**
 * 图片放大层：附件缩略图点开原图。
 *
 * 为什么不各组件自己画遮罩：玻璃拟态容器带 backdrop-filter，它会成为 fixed 元素的
 * 包含块 —— 缩略图就地渲染的遮罩会被父容器裁掉、跟着一起滚。所以放大层统一挂在
 * 页面顶层，谁要点开就发一个事件，Host 负责渲染与 Esc 关闭。
 */
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

type Zoom = { url: string; name: string }
const EVT = 'torra:zoom-image'

export function openImageZoom(url: string, name: string): void {
  window.dispatchEvent(new CustomEvent<Zoom>(EVT, { detail: { url, name } }))
}

export function ImageZoomHost() {
  const [zoom, setZoom] = useState<Zoom | null>(null)

  useEffect(() => {
    const onOpen = (e: Event) => setZoom((e as CustomEvent<Zoom>).detail)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !zoom) return
      // 捕获阶段先截下 Esc：否则会一路冒泡到助手抽屉，放大图关了、抽屉也跟着关
      e.stopPropagation()
      setZoom(null)
    }
    window.addEventListener(EVT, onOpen)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener(EVT, onOpen)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [zoom])

  if (!zoom) return null
  return (
    <div className="img-zoom-mask" onClick={() => setZoom(null)} role="dialog" aria-label={zoom.name}>
      <img className="img-zoom-img" src={zoom.url} alt={zoom.name} onClick={(e) => e.stopPropagation()} />
      <div className="img-zoom-bar" onClick={(e) => e.stopPropagation()}>
        <span className="img-zoom-name">{zoom.name}</span>
        <button className="btn icon sm" onClick={() => setZoom(null)} title="关闭（Esc）" aria-label="关闭放大预览">
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
