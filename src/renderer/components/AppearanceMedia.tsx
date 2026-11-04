/**
 * 外观媒体：主背景与启动动画。
 *
 * 两条都只画主进程给的 `torra-media://` 地址，渲染层不碰文件系统、不拼路径。
 *
 * 主背景铺在 `.app` 底下（`.app` 自己透明），所以正文面片仍是它们自己的底色 ——
 * 遮罩浓度调的是「背景还剩多少」，不是「字有多黑」。视频背景在窗口隐藏时暂停：
 * 桌面客户端最小化之后还在解一段 1080p，是纯烧电。
 *
 * 启动动画是一块**可跳过**的遮罩，不是门：应用在它下面照常渲染与跑任务，
 * 点一下或按 Esc 就走。系统要求减少动效时整块不挂 —— 一块静止的图挡在开场，
 * 比没有开场更糟。
 */
import { useEffect, useRef, useState } from 'react'
import { STARTUP_HOLD_MS, STARTUP_VIDEO_MAX_MS } from '@shared/appearance'
import { useAppearance } from '../appearance'
import { prefersReducedMotion } from '../motion'

export function AppBackground(): React.ReactElement | null {
  const media = useAppearance().background
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const url = media?.url

  useEffect(() => {
    const v = videoRef.current
    if (!v || !url) return
    // 最小化/切走时停：视频背景的开销必须跟着可见性走
    const onVisibility = () => {
      if (document.hidden) v.pause()
      else void v.play().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [url])

  if (!media) return null
  return (
    <div className="app-bg" aria-hidden>
      {media.kind === 'video' ? (
        <video
          ref={videoRef}
          className="app-bg-el"
          src={media.url}
          autoPlay={!prefersReducedMotion()}
          muted
          loop
          playsInline
        />
      ) : (
        <img className="app-bg-el" src={media.url} alt="" />
      )}
      {/* 遮罩：把媒体压回「背景」的位置，正文面片才对得上对比度门槛 */}
      <div className="app-bg-scrim" style={{ opacity: media.dim }} />
    </div>
  )
}

export function StartupMedia(): React.ReactElement | null {
  const media = useAppearance().startup
  const [skipped, setSkipped] = useState(false)
  /** 只在挂载时问一次：运行中改系统设置不会把已经跳过的开场又拉回来 */
  const reduced = useRef(prefersReducedMotion())
  const active = !!media && !skipped && !reduced.current
  const kind = media?.kind
  const url = media?.url

  useEffect(() => {
    if (!active || !kind) return
    // 图片型没有「播完」事件，给一个固定停留；视频型另设上限，长片子不能锁住开场
    const cap = kind === 'video' ? STARTUP_VIDEO_MAX_MS : STARTUP_HOLD_MS
    const timer = window.setTimeout(() => setSkipped(true), cap)
    return () => window.clearTimeout(timer)
  }, [active, kind, url])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSkipped(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  if (!active || !media) return null
  return (
    <div className="startup-media" onClick={() => setSkipped(true)} role="presentation">
      {media.kind === 'video' ? (
        <video
          className="startup-media-el"
          src={media.url}
          autoPlay
          muted
          playsInline
          onEnded={() => setSkipped(true)}
          onError={() => setSkipped(true)}
        />
      ) : (
        <img className="startup-media-el" src={media.url} alt="" onError={() => setSkipped(true)} />
      )}
      <span className="startup-media-skip">点击或按 Esc 跳过</span>
    </div>
  )
}
