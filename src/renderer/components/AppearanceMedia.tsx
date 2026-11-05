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
 *
 * 片子自己播完才收（`onEnded`），不设短上限：用户挑了一支 14 秒的片子，
 * 就该放完 14 秒。只有拿不到时长、或者某个格式就是不发 ended 时才走兜底。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { STARTUP_HOLD_MS, STARTUP_VIDEO_FALLBACK_MS } from '@shared/appearance'
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
        /*
         * 背景保持静音，与开场相反：它铺在整场会话底下、无限循环，
         * 一段循环的声音会一直响着，那不是「背景」，是干扰。
         * 开场的片子只看一遍、看完就收，所以那边带声。
         */
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
  const [leaving, setLeaving] = useState(false)
  /** 只在挂载时问一次：运行中改系统设置不会把已经跳过的开场又拉回来 */
  const reduced = useRef(prefersReducedMotion())
  /** 挂在这里 = 还在这一出里；leaving 之后效果停掉，但层还在，淡出要看得见 */
  const shown = !!media && !skipped && !leaving && !reduced.current
  const active = !!media && !skipped && !reduced.current
  const kind = media?.kind
  const url = media?.url

  /**
   * 收场：先淡出，再拆掉。
   *
   * 三条路（点一下、按 Esc、播完 / 出错 / 到时）以前都是当场消失，画面像被掐断。
   * 现在统一走这一拍：开场与它的收尾是同一出。
   */
  const finish = useCallback((): void => {
    setLeaving(true)
    window.setTimeout(() => setSkipped(true), 180)
  }, [])

  useEffect(() => {
    // 图片型没有「播完了」这个事件，只能给一个固定停留。
    // 视频型由 `onEnded` 收场；这条定时器只是兜底：拿不到时长、或者某个格式
    // 就是不发 ended，才由它收掉。
    const cap = kind === 'video' ? STARTUP_VIDEO_FALLBACK_MS : STARTUP_HOLD_MS
    const timer = window.setTimeout(finish, cap)
    return () => window.clearTimeout(timer)
  }, [shown, kind, url, finish])

  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown, finish])

  if (!active || !media) return null
  return (
    <div
      className={`startup-media${leaving ? ' leaving' : ''}`}
      onClick={finish}
      role="presentation"
    >
      {media.kind === 'video' ? (
        /*
         * 不写 `muted`：用户挑的那支片子有声音，就该听见。
         *
         * 以前这里是 `muted`，依据是「浏览器不许无声自动播放」—— 那条规矩属于
         * 普通网页，而 Torra 是桌面应用，自动播放策略由主进程说了算
         * （`autoplayPolicy: 'no-user-gesture-required'`，见 src/main/index.ts 的建窗处）。
         * 所以这里可以直接带声起播；静音不是必需的妥协，而是把声音丢了。
         */
        <video
          className="startup-media-el"
          src={media.url}
          autoPlay
          playsInline
          onEnded={finish}
          onError={finish}
        />
      ) : (
        <img className="startup-media-el" src={media.url} alt="" onError={finish} />
      )}
      <span className="startup-media-skip">点击或按 Esc 跳过</span>
    </div>
  )
}
