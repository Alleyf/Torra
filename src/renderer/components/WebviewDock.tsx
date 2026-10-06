/**
 * WebviewDock —— 把主进程的网页视图「嵌」进一枚受控的 DOM 容器。
 *
 * 约束：WebContentsView 由主进程直接挂在主窗口上，永远盖在渲染层之上，
 * 无法成为 DOM 的一部分。若改用 <webview> 标签虽能入流，但会另起一份
 * WebContents，与共享登录态/自动化的实例池割裂 —— 于是「这里登录了、
 * 自动化却读另一份」。
 *
 * 折中：渲染一个带表头的玻璃容器，量出内部 body 的矩形，把原生视图边界
 * 精确贴合上去。视觉上等同于嵌在元素里，架构上仍是池化的同一实例。
 *
 * 贴合的时机是这里唯一的难点。原生视图住在合成层之外，DOM 动了它不会跟着动：
 * 之前靠 resize / scroll / ResizeObserver / MutationObserver 四路事件补，
 * 每一路都只看「某一类变化」—— 提示条把整行内容顶下 42px 时，容器宽高没变、
 * 窗口没缩、没有 class/style 变化，四路全不触发，于是视图错位停在原地，
 * 直到用户滚一下鼠标才「啪」地跳回去。看着就是顿挫。
 * 现在改成逐帧比对矩形：只在实际变化时发一次贴合，任何布局来源都被同一条路径覆盖。
 */

import { useEffect, useRef, useState } from 'react'
import { Expand, Loader2, Maximize2, Minimize2, RefreshCw, RotateCw, Shrink, X } from 'lucide-react'
import { getFaviconUrls } from './ModelRail'
import { pushNotice } from '../notice'
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

/** 视图占位：侧栏 / 应用内放大 / 连窗口一起全屏 */
type DockMode = 'side' | 'zoom' | 'full'

export function WebviewDock({
  model,
  onClose,
  onRecheck,
  tabs,
  onPickTab,
  zoomable,
}: {
  model: ModelSummary
  onClose: () => void
  onRecheck?: () => void
  /** 可一键切走的其它网页模型；少于两个时不显示标签条 */
  tabs?: ModelSummary[]
  onPickTab?: (id: string) => void
  /** 允许放大/全屏。登录场景不传：那里网页只是配角，放大反而找不到回来的路 */
  zoomable?: boolean
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<DockMode>('side')
  /** 刷新中的那一个模型：转圈停在按钮上，而不是让用户以为没点到 */
  const [reloadingId, setReloadingId] = useState<string | null>(null)
  // 换目标时要把新视图先贴上再摘旧的，所以「当前该贴谁」得能被循环读到
  const idRef = useRef(model.id)
  idRef.current = model.id

  /**
   * 重载当前这一份文档（不是跳回站点入口）。
   * 主进程等 did-finish-load 才返回，所以这里的转圈有真实的终点；
   * 再补一个最短时长：秒回的话用户只看到图标闪了一下，等于没有反馈。
   */
  const reload = async () => {
    const id = model.id
    if (reloadingId === id) return
    setReloadingId(id)
    const startedAt = Date.now()
    const r = await window.torra.webviewReload(id)
    await new Promise((res) => setTimeout(res, Math.max(0, 700 - (Date.now() - startedAt))))
    if (idRef.current === id) setReloadingId(null)
    pushNotice(r.ok ? `已刷新「${model.displayName}」页面` : (r.reason ?? '刷新失败'), {
      tone: r.ok ? 'success' : 'warn',
      ttl: r.ok ? 2600 : 9000,
    })
  }

  useEffect(() => {
    document.body.classList.toggle('webview-zoom', mode !== 'side')
    return () => document.body.classList.remove('webview-zoom')
  }, [mode])

  /**
   * 主进程全屏。挂载时窗口本来就处于窗口态，所以第一次进/出全屏之前不发指令，
   * 免得每个 dock 一挂上来就朝窗口拍一次「退出全屏」。
   */
  const fsTouched = useRef(false)
  const wantFs = mode === 'full'
  useEffect(() => {
    if (!fsTouched.current && !wantFs) return
    fsTouched.current = true
    void window.torra.webviewFullscreen(wantFs)
  }, [wantFs])

  // 放大/全屏下 Esc 是唯一的退路（顶栏被布局藏起来时也得能按回来）
  useEffect(() => {
    if (mode === 'side') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setMode('side')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mode])

  useEffect(() => {
    let raf = 0
    /** 上一次真正发给主进程的矩形 */
    let sent = ''
    /** 视图当前是否挂在窗口上（与主进程保持一致，避免重复 dismiss） */
    let attached = true
    /** 一次贴合的 IPC 还没回来就不再排队：拖窗口时否则会堆出一条长队 */
    let inFlight = false

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = bodyRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      // 让位不能只靠 CSS：dock 的宿主是 flex 项，撑破视口时 padding-right 再大也留着一截，
      // 而原生视图永远画在渲染层之上 —— 那一截就会压在助手身上。这里按视口坐标硬夹一次。
      let right = window.innerWidth
      if (document.body.classList.contains('assistant-open')) {
        const reserve =
          Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--a-drawer-reserve')) || 0
        right -= reserve
      }
      const b = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.max(0, Math.round(Math.min(r.right, right) - r.left)),
        height: Math.round(r.height),
      }
      const key = `${b.x},${b.y},${b.width},${b.height}`
      if (key === sent || inFlight) return
      sent = key
      // 夹完没地方放了（助手全屏档就会这样）：贴 0 宽等于还挂在窗口上，直接摘掉，
      // 等矩形恢复再由同一条路径贴回来。
      if (b.width < 24 || b.height < 24) {
        if (attached) {
          attached = false
          void window.torra.dismissWebview(idRef.current)
        }
        return
      }
      attached = true
      const id = idRef.current
      inFlight = true
      void window.torra.presentWebview(id, b).finally(() => {
        inFlight = false
        // 在途期间矩形又变了（动画中很常见）：把 sent 作废，下一帧重新对齐
        if (idRef.current !== id) sent = ''
      })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [model.id])

  /*
   * 收起只挂在卸载时：换目标走的是「贴上新的、主进程顺手摘掉旧的」，
   * 这里若跟着 model.id 变化先 dismiss，中间就会露出一帧应用底色 —— 切一下闪一下。
   */
  useEffect(
    () => () => {
      void window.torra.dismissWebview(idRef.current)
    },
    [],
  )

  const tabList = tabs && tabs.length > 1 ? tabs : []

  return (
    <div className="webview-dock">
      <div className="webview-dock-head">
        <span className="wdh-id">
          <DockFavicon m={model} />
          <b>{model.displayName}</b>
          <span className="wdh-tag">网页视图</span>
        </span>
        {tabList.length > 0 && (
          <span className="wdh-tabs" role="tablist" aria-label="切换网页模型">
            {tabList.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={t.id === model.id}
                className={`wdh-tab${t.id === model.id ? ' active' : ''}`}
                title={`切到 ${t.displayName}`}
                onClick={() => t.id !== model.id && onPickTab?.(t.id)}
              >
                <DockFavicon m={t} />
                <span className="wdh-tab-name">{t.displayName}</span>
              </button>
            ))}
          </span>
        )}
        <span className="wdh-hint">可在此登录或处理人机验证，登录态与自动化共用同一会话</span>
        <div className="wdh-actions">
          <button
            className="btn sm icon"
            onClick={() => void reload()}
            disabled={reloadingId === model.id}
            title={reloadingId === model.id ? '正在刷新…' : '刷新此页（保留当前页面，不跳回站点首页）'}
            aria-label="刷新网页"
          >
            {reloadingId === model.id ? <Loader2 size={13} className="spin" /> : <RotateCw size={13} />}
          </button>
          {onRecheck && (
            <button className="btn sm" onClick={onRecheck} title="复核登录状态">
              <RefreshCw size={11} />
              我已登录完成
            </button>
          )}
          {zoomable && (
            <>
              <button
                className={`btn sm icon${mode !== 'side' ? ' active' : ''}`}
                onClick={() => setMode((m) => (m === 'zoom' ? 'side' : 'zoom'))}
                title={mode === 'side' ? '放大到整窗（Esc 还原）' : '还原为侧栏'}
                aria-label="放大网页视图"
              >
                {mode === 'side' ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
              </button>
              <button
                className={`btn sm icon${mode === 'full' ? ' active' : ''}`}
                onClick={() => setMode((m) => (m === 'full' ? 'side' : 'full'))}
                title={mode === 'full' ? '退出全屏（Esc）' : '全屏，当独立页面用（Esc 退出）'}
                aria-label="全屏网页视图"
              >
                {mode === 'full' ? <Shrink size={13} /> : <Expand size={13} />}
              </button>
            </>
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
