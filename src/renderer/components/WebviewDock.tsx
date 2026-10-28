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
 *
 * 挂不上来不留空白：present 的失败原因（适配器缺失 / 主窗口未就绪）与「后台实例不在了」
 * 都写进容器里，那颗按钮同时从「刷新此页」换成「重新打开」—— 重新打开走的就是 present 这条路，
 * 用户接着点一下就能自愈，不必猜「实例未初始化」是谁的毛病。
 * 实例本身卡死（刷新没反应）另有第二颗按钮：换掉整个 WebContents 重建一份。
 * 站点连不上也算「挂不上来」：那份原生错误页由主进程摘回后台（它压在DOM之上，
 * 留着它这句话就永远看不见），原因走 webview:nav 写进同一块空白区。
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  Expand,
  GripVertical,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Shrink,
  X,
} from 'lucide-react'
import { ModelAvatar } from './ModelAvatar'
import { pushNotice } from '../notice'
import type { ModelSummary } from '../store'

function DockFavicon({ m }: { m: ModelSummary }) {
  return <ModelAvatar model={m} size={14} className="wdh-favicon" />
}

/** 视图占位：侧栏 / 应用内放大 / 连窗口一起全屏 */
type DockMode = 'side' | 'zoom' | 'full'

/**
 * dock = 单窗视图（研讨转播、登录复核、聊天提取模式的右侧栏）；
 * pane = 原生墙里的一格：挂载要非互斥，头部的标签条/提示/关闭都不属于它，
 * 放大交给上层换列数（一格独占），而不是这套全局 body class。
 */
type DockVariant = 'dock' | 'pane'

export function WebviewDock({
  model,
  onClose,
  onRecheck,
  tabs,
  onPickTab,
  zoomable,
  variant = 'dock',
  wall = variant === 'pane',
  status,
  onExpand,
  expanded,
  onSwapGrip,
  swapRole,
  swapHold,
  paneTabs,
  onPaneTabPick,
  onPaneTabGrip,
}: {
  model: ModelSummary
  onClose?: () => void
  onRecheck?: () => void
  /** 可一键切走的其它网页模型；少于两个时不显示标签条 */
  tabs?: ModelSummary[]
  onPickTab?: (id: string) => void
  /** 允许放大/全屏。登录场景不传：那里网页只是配角，放大反而找不到回来的路 */
  zoomable?: boolean
  /** 见 DockVariant；pane 用于聊天模式的原生墙 */
  variant?: DockVariant
  /**
   * 挂载是否非互斥。默认跟着 variant 走：pane 用 wall 口径（多枚并存），
   * dock 保持「一次只挂一枚」的旧语义。
   */
  wall?: boolean
  /** pane 头部右侧的状态位（已投递 / 投递失败 / 需处理），由上层按轮次给 */
  status?: ReactNode
  /** pane 的「放大」：上层把墙收成只剩这一格 */
  onExpand?: () => void
  /** 当前就是被放大的那一格（按钮变成「还原」） */
  expanded?: boolean
  /**
   * pane 头部的拖拽把手：按下它才能交换这一格的位置。
   * 只能挂在头部 —— 格子里那一大片是原生视图，指针一进去就归站点，
   * 渲染层连 pointermove 都收不到（缝要做成一条轨道是同一个原因）。
   */
  onSwapGrip?: (e: ReactPointerEvent<HTMLElement>) => void
  /** 这一格在交换手势里的身份：正被拖着的那一格 / 松手会落上去的那一格 */
  swapRole?: 'src' | 'target' | null
  /**
   * 交换进行中：把这一格的原生视图摘回离屏宿主，并暂停贴合。
   * 摘掉之后整格都是 DOM，指针才终于能穿过格子去命中别的格子；
   * 松手（这个 prop 变 false）由贴合循环重新贴回来，页面不重载。
   */
  swapHold?: boolean
  /**
   * pane 专属：这一格折叠着的其它页面（标签组）。
   *
   * 与 `tabs` 那一条不是一回事：那边是「同一个视图里切目标」（单窗 dock），
   * 这边是「原生墙里一格折叠着一叠页面」—— 每页各有自己的 WebContentsView、
   * 自己的登录态，切过去是 present 回去，不是重新加载。
   */
  paneTabs?: ModelSummary[]
  /** 点某个折叠标签：把它切到这一格露出来 */
  onPaneTabPick?: (id: string) => void
  /** 拖某个折叠标签：从这一格拖出去（拆成自己一格） */
  onPaneTabGrip?: (id: string, e: ReactPointerEvent<HTMLElement>) => void
}) {
  const isPane = variant === 'pane'
  const bodyRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<DockMode>('side')
  /** 刷新中的那一个模型：转圈停在按钮上，而不是让用户以为没点到 */
  const [reloadingId, setReloadingId] = useState<string | null>(null)
  /** 重建实例进行中（和刷新分开记：两颗按钮各自转自己的圈） */
  const [recreatingId, setRecreatingId] = useState<string | null>(null)
  /**
   * 页面挂不上来的原因；null = 正常显示中。
   * 原生视图画在渲染层之上，所以这块提示只在「确实没东西可展示」时看得见 ——
   * 正是它要说话的那些场景（适配器缺失 / 主窗口未就绪 / 实例已被回收）。
   */
  const [issue, setIssue] = useState<string | null>(null)
  // 换目标时要把新视图先贴上再摘旧的，所以「当前该贴谁」得能被循环读到
  const idRef = useRef(model.id)
  idRef.current = model.id
  /** 由贴合循环交出来的「重发一次 present」开关：让重试走同一条量矩形的路径 */
  const requeueRef = useRef<(() => void) | null>(null)
  /**
   * 交换手势进行中。true 时这一格的原生视图必须让位：它留在窗口上，
   * 指针就永远进不了格子内部，命中不了「要换到哪一格」——
   * 摘回离屏宿主只是换个爹，页面、登录态、滚动位置都还在。
   */
  const holdRef = useRef(false)
  useEffect(() => {
    holdRef.current = !!swapHold
    // 松手：作废「上一次发过的矩形」，让下一帧照着当下这个尺寸重新贴回来
    if (!swapHold) requeueRef.current?.()
  }, [swapHold])

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
    /*
     * needsOpen：池里没有实例，不是故障，是「没有东西可刷新」。
     * 记下原因，让按钮自己变成「重新打开」—— 用户接着点一下就走 present 那条会重建实例的路，
     * 而不是拿到第二句读不懂的「未初始化」。
     */
    if (!r.ok && r.needsOpen) setIssue(r.reason ?? '这个网页当前没在运行')
    pushNotice(r.ok ? `已刷新「${model.displayName}」页面` : (r.reason ?? '刷新失败'), {
      tone: r.ok ? 'success' : 'warn',
      ttl: r.ok ? 2600 : 9000,
    })
  }

  /**
   * 重建实例：换掉整个 WebContents，从站点入口重新加载一份。
   *
   * 刷新救不回来的那类卡死才用它 —— 渲染进程崩了、站点把导航锁死、
   * 登录已经写进分区而这份文档始终不认。代价是离开用户当前停留的那一页，
   * 所以它是第二颗按钮，不并进刷新。登录态不丢（凭据在 persist: 分区）。
   */
  const recreate = async () => {
    const id = model.id
    if (recreatingId === id) return
    setRecreatingId(id)
    const startedAt = Date.now()
    const r = await window.torra.webviewRecreate(id)
    // 新视图换的是整个 WebContents，界面这边矩形没变 —— 主进程照上次的矩形先贴一次，
    // 这里再作废矩形补一发，按的是当下这个（可能已经变过的）尺寸。
    if (r.ok) {
      setIssue(null)
      requeueRef.current?.()
    } else if (r.needsOpen) {
      setIssue(r.reason ?? '这个网页当前没在运行')
    }
    await new Promise((res) => setTimeout(res, Math.max(0, 700 - (Date.now() - startedAt))))
    if (idRef.current === id) setRecreatingId(null)
    pushNotice(
      r.ok ? `已重建「${model.displayName}」的网页实例，页面回到站点入口` : (r.reason ?? '重建实例失败'),
      { tone: r.ok ? 'success' : 'warn', ttl: r.ok ? 3200 : 9000 },
    )
  }

  const retryOpen = () => {
    setIssue('正在重新打开页面…')
    requeueRef.current?.()
  }

  /*
   * 主框架的加载结论。present 只回答「贴上去了没有」，页面本身是内容还是错误页，
   * 只有主进程那一侧的导航事件知道 —— 而失败时它已经把视图摘回后台，
   * 为的就是让这块空白由下面这句话来填，而不是站点自己那页读不懂的报错。
   */
  useEffect(() => {
    /** 上一条结论是失败：只有它才需要在加载成功时把视图重新贴回来 */
    let wasFailed = false
    return window.torra.on('webview:nav', (payload) => {
      const p = payload as { modelId?: string; state?: 'ok' | 'failed'; reason?: string } | null
      if (!p || p.modelId !== idRef.current) return
      if (p.state === 'failed') {
        wasFailed = true
        setIssue(p.reason || '页面加载失败')
        return
      }
      if (!wasFailed) return
      wasFailed = false
      setIssue(null)
      requeueRef.current?.()
    })
  }, [model.id])

  /*
   * 保活实例被内存回收。
   *
   * 界面这边对此完全无感：矩形没变、DOM 没动、rAF 逐帧比对不到差异，所以贴合循环
   * 不会再发一次 present —— 而那正是「静默重载」会被发现的地方。主进程拆掉实例的那一刻
   * 直接推一条过来，把话写在这格空白上：点「重试打开」确实会重新加载站点页面，
   * 但那是用户按下按钮的结果，不是我们在背后替他把上一场对话刷没了。
   */
  useEffect(() => {
    return window.torra.on('webview:recycled', (payload) => {
      const p = payload as { modelId?: string } | null
      if (!p || p.modelId !== idRef.current) return
      setIssue('这一格的网页实例已被系统回收 · 点「重试打开」会重新加载站点页面（登录态不丢）')
    })
  }, [model.id])

  useEffect(() => {
    // pane 不参与这套全局占位：原生墙的「放大」是上层把列数收成一格，
    // 靠 body class 撑满整行会让同一面墙上其它窗格一起被挤没。
    if (isPane) return
    document.body.classList.toggle('webview-zoom', mode !== 'side')
    return () => document.body.classList.remove('webview-zoom')
  }, [mode, isPane])

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
    let timer = 0
    let hb = 0
    /** 上一次真正发给主进程的矩形 */
    let sent = ''
    /** 视图当前是否挂在窗口上（与主进程保持一致，避免重复 dismiss） */
    let attached = true
    /** 一次贴合的 IPC 还没回来就不再排队：拖窗口时否则会堆出一条长队 */
    let inFlight = false
    /** 是否由本循环主动摘掉的（hold / 夹到 0 尺寸）：那条路不该再自己贴回来 */
    let selfDetached = false

    /**
     * 只作废「上一次发过的矩形」，不碰 attached/inFlight ——
     * 下一次 tick 会照着当下的尺寸把 present 重发一遍。
     * 主进程拆掉实例（内存回收、散场 dismissAll）后，矩形没变、DOM 没动，
     * 逐帧比对不到差异，那一格就永远停在白屏；把 sent 清掉即可让同一条路径补发。
     */
    const invalidate = (): void => {
      sent = ''
    }

    /*
     * 兜底重发：主进程那头没有视图、而这一格在界面上仍有位置时，定期把 present 重发一次。
     *
     * 拆掉视图的路径全都静默（内存回收、散场 dismissAll、relievePressure），
     * 事件只覆盖「保活或被摘下过」的那一部分；而矩形没变、DOM 没动，
     * 逐帧逐帧比对不到差异 —— 那一格就停在白屏，用户能做的只有点「重试打开」。
     * present 是幂等的（主进程只在 !attached 时才 addChildView，见 WebviewPool.present），
     * 所以多发一次不会把页面顶掉，也不会闪一下；这里只是把「坏了」变成「自己长回来」。
     */
    const heartbeat = (): void => {
      if (selfDetached) return
      if (holdRef.current) return
      sent = ''
    }

    /*
     * rAF 是唯一的贴合驱动，而它在页面隐藏时被 Chromium 整批暂停
     * （窗口未置前 / 最小化 / 系统切走焦点都算）。实测：hidden 时 1.2 秒 0 滴答，
     * 置回可见后立刻恢复到每帧一次。于是「从未贴合过」的那一格在隐藏期间
     * 一次 present 都发不出去，等用户回来看就是一片白。
     *
     * setInterval 不受可见性影响（同一次实测里它照常走），
     * 拿它当兜底：可见时两路都跑，tick 内部的 sent/inFlight 去重让它们互不干扰；
     * 隐藏时至少这一路还在，矩形一变化就能贴上去。
     */
    const drive = (): void => {
      tick()
      timer = window.setInterval(tick, 200)
      hb = window.setInterval(heartbeat, 3000)
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = bodyRef.current
      if (!el) return
      /*
       * 交换手势期间：这一格的原生视图先摘回离屏宿主，然后本循环彻底静默。
       * 不摘的话指针进不了格子内部，也就命中不到「要换到哪一格」；
       * 摘了又每帧贴回去，等于一边摘一边贴，页面会一闪一闪。
       */
      if (holdRef.current) {
        if (sent !== 'hold') {
          sent = 'hold'
          if (attached) {
            attached = false
            void window.torra.dismissWebview(idRef.current)
          }
        }
        selfDetached = true
        return
      }
      const r = el.getBoundingClientRect()
      /*
       * 让位不能只靠 CSS：dock 的宿主是 flex 项，撑破视口时 padding-right 再大也留着一截，
       * 而原生视图永远画在渲染层之上 —— 那一截就会压在助手身上。这里按视口坐标硬夹一次。
       */
      let left = r.left
      let right = window.innerWidth
      const cs = getComputedStyle(document.documentElement)
      if (document.body.classList.contains('assistant-open')) {
        const reserve = Number.parseFloat(cs.getPropertyValue('--a-drawer-reserve')) || 0
        right -= reserve
      }
      /*
       * 模型侧栏的 hover 浮层会伸进正文（它不挤布局，否则原生视图逐帧重贴会抖），
       * 而窄窗口下（聊天页窄轨态、会话栏收起）墙从 340px 左右就开始了 —— 不夹的话
       * 浮层那一段会被站点页面切掉，弹层看起来「只弹了一半」。同一条口径：浮层靠
       * --rail-sheet-reserve（实测右缘）让位，关的时候 JS 会把变量清掉，这里自然不生效。
       */
      if (document.body.classList.contains('rail-sheet-open')) {
        const reserve = Number.parseFloat(cs.getPropertyValue('--rail-sheet-reserve')) || 0
        if (reserve > left) left = reserve
      }
      const b = {
        x: Math.round(left),
        y: Math.round(r.top),
        width: Math.max(0, Math.round(Math.min(r.right, right) - left)),
        height: Math.round(r.height),
      }
      const key = `${b.x},${b.y},${b.width},${b.height}`
      if (key === sent || inFlight) return
      sent = key
      /*
       * 夹完没地方放了（助手全屏档就会这样）：贴 0 宽等于还挂在窗口上，直接摘掉，
       * 等矩形恢复再由同一条路径贴回来。
       *
       * 门槛从 24px 提到 100px：窗口在动画/缩放途中常常量到几十像素的瞬时矩形，
       * 旧门槛下这会让视图反复「摘掉 → 贴回」，而每一次摘掉都会让主进程记一次
       * 「刚被卸下」；放大独占时再叠加回收闸门，表现就是白屏。真正没有可读内容的
       * 尺寸是「几乎为零」，100px 以下已经没有能用的站点页面了。
       */
      if (b.width < 100 || b.height < 100) {
        if (attached) {
          attached = false
          void window.torra.dismissWebview(idRef.current)
        }
        selfDetached = true
        return
      }
      /*
       * attached 是渲染层自己的账，与主进程同口径但不同步：这一帧发现
       * 「我以为贴着，其实没有了」时先按贴着发 —— present 是幂等的
       * （主进程侧只在 !attached 时才 addChildView，见 WebviewPool.present），
       * 所以多发一次不会把页面顶掉，也不会闪一下。
       */
      selfDetached = false
      attached = true
      const id = idRef.current
      inFlight = true
      /*
       * present 的失败原因以前被丢掉：主进程返回「适配器缺失」时，
       * 用户看到的是一片空白，只能去点刷新，再拿到一句「实例未初始化」。
       * 现在把原因留在空白区，同一句在出现的当场就说清。
       */
      void window.torra
        .presentWebview(id, b, wall ? { wall: true } : undefined)
        .then((r) => {
          if (idRef.current === id) setIssue(r.ok ? null : (r.reason || '页面没能打开'))
        })
        .catch(() => {
          if (idRef.current === id) setIssue('页面没能打开：主进程没有响应这次挂载')
        })
        .finally(() => {
          inFlight = false
          // 在途期间矩形又变了（动画中很常见）：把 sent 作废，下一帧重新对齐
          if (idRef.current !== id) sent = ''
        })
    }
    requeueRef.current = () => {
      invalidate()
    }
    raf = requestAnimationFrame(drive)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(timer)
      window.clearInterval(hb)
      requeueRef.current = null
    }
  }, [model.id, wall])

  /* 换目标：上一页的挂载失败原因不该跟着串台 */
  useEffect(() => {
    setIssue(null)
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
    <div
      className={`webview-dock${isPane ? ' pane' : ''}${swapRole ? ` swap-${swapRole}` : ''}${
        swapHold ? ' swap-hold' : ''
      }`}
    >
      <div className="webview-dock-head">
        {onSwapGrip && (
          /*
           * 把手只做「按下并开始拖」，不抢那颗放大按钮的位置：头部是这一格里唯一
           * 收得到指针的 DOM，格子里那一片归站点自己。
           */
          <span
            className="wdh-grip"
            role="button"
            tabIndex={-1}
            aria-label={`拖动以交换 ${model.displayName} 这一格的位置`}
            title="按住拖动，与另一格交换位置（只有头部能拖，格子里那一片收不到指针）"
            onPointerDown={onSwapGrip}
          >
            <GripVertical size={12} />
          </span>
        )}
        <span className="wdh-id">
          <DockFavicon m={model} />
          <b>{model.displayName}</b>
          <span className="wdh-tag">{isPane ? '原生' : '网页视图'}</span>
        </span>
        {/*
         * 标签组：这一格折叠着一叠页面时，标签条长在头部。
         * 折叠的页仍各自占一个 WebContentsView（登录态、滚动位置都在），
         * 点一下是 present 回去，不是重新加载。
         */}
        {isPane && paneTabs && paneTabs.length > 0 && (
          <span className="wdh-foldtabs" role="tablist" aria-label="这一格折叠着的页面">
            {paneTabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={false}
                className="wdh-foldtab"
                title={`切到 ${t.displayName}（它仍在自己那一格里，登录态不丢）`}
                onClick={() => onPaneTabPick?.(t.id)}
                onPointerDown={(e) => onPaneTabGrip?.(t.id, e)}
              >
                <DockFavicon m={t} />
                <span className="wdh-foldtab-name">{t.displayName}</span>
              </button>
            ))}
          </span>
        )}
        {isPane && status && <span className="wdh-slot">{status}</span>}
        {!isPane && tabList.length > 0 && (
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
        {!isPane && <span className="wdh-hint">可在此登录或处理人机验证，登录态与自动化共用同一会话</span>}
        <div className="wdh-actions">
          <button
            className="btn sm icon"
            onClick={() => (issue ? retryOpen() : void reload())}
            disabled={reloadingId === model.id || recreatingId === model.id}
            title={
              reloadingId === model.id
                ? '正在刷新…'
                : issue
                  ? `重新打开页面（${issue}）`
                  : '刷新此页（保留当前页面，不跳回站点首页）'
            }
            aria-label={issue ? '重新打开网页' : '刷新网页'}
          >
            {reloadingId === model.id ? (
              <Loader2 size={13} className="spin" />
            ) : issue ? (
              <RefreshCw size={13} />
            ) : (
              <RotateCw size={13} />
            )}
          </button>
          <button
            className="btn sm icon"
            onClick={() => void recreate()}
            disabled={recreatingId === model.id || reloadingId === model.id}
            title={
              recreatingId === model.id
                ? '正在重建实例…'
                : '刷新没用时的下一招：重建网页实例（换掉整个页面进程，回到站点入口；登录态保留）'
            }
            aria-label="重建网页实例"
          >
            {recreatingId === model.id ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}
          </button>
          {!isPane && onRecheck && (
            <button className="btn sm" onClick={onRecheck} title="复核登录状态">
              <RefreshCw size={11} />
              我已登录完成
            </button>
          )}
          {isPane && onExpand && (
            <button
              className={`btn sm icon${expanded ? ' active' : ''}`}
              onClick={onExpand}
              title={expanded ? '还原为整面墙' : '放大：这一格独占整面墙（其余窗格退回后台，登录态与生成都不受影响）'}
              aria-label={expanded ? '还原窗格墙' : '放大此窗格'}
            >
              {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          )}
          {!isPane && zoomable && (
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
          {onClose && (
            <button className="btn sm icon" onClick={onClose} title="关闭网页视图">
              <X size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="webview-dock-body" ref={bodyRef}>
        {issue && (
          <div className="wd-empty">
            <span className="wd-empty-reason">{issue}</span>
            <button
              className="btn sm"
              onClick={retryOpen}
              title="按当前容器再请求一次挂载（与逐帧贴合走同一条路径）"
            >
              <RefreshCw size={11} />
              重试打开
            </button>
          </div>
        )}
        {/*
         * 交换期间这一格是空的（原生视图被暂时摘走了），空着不说话就等于「页面没了」。
         * 这一层填的就是那句「只是暂时让位」，松手会自己消失。
         */}
        {swapHold && !issue && (
          <div className="wd-empty swap-veil">
            <span className="wd-empty-reason">
              {swapRole === 'src' ? '这一格正被拖着 · 拖到另一格上松手' : swapRole === 'target' ? '松手就和这一格交换位置' : '拖到这里交换位置'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
