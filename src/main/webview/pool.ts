/**
 * 后台 WebView 池（PRD 6.3）
 *
 * 核心机制：用户看到的是一个页面，后台常驻一群页面。
 *
 * 两个必须做对的地方（否则功能静默失效）：
 * 1. partition 名必须以 "persist:" 开头 —— 该前缀即代表 session 落盘，
 *    Electron 33 的 fromPartition 不接受 persist 选项（只有 cache）；
 *    缺这个前缀则重启后所有登录态都会丢；
 * 2. 空闲实例用 setBackgroundThrottling(true) + 挂起渲染，内存超阈值时 LRU 回收，
 *    但保留 partition 以保证登录态不丢。
 *
 * 第三个坑（实测踩过，代价是「所有 webview 模型静默全灭」）：
 * 未挂到任何窗口的 WebContentsView 视口是 0×0。站点据此渲染移动端/降级布局，
 * 桌面版选择器（如 ChatGPT 的 #prompt-textarea）根本不存在 —— 表现成
 * 「适配器失效」，实际是压根没渲染出那个元素。setBounds() 对未挂载的 view 无效，
 * 只有 addChildView 之后视口才成立。
 * 因此后台实例一律挂在一枚「创建时就显示、但摆在屏幕外」的宿主窗口里：
 * 既有真实视口、又正常出帧（渲染帧的必要性见 ensureHost 注释），用户还看不见它；
 * 转播/接管时再把 view 搬到主窗口，结束后搬回来。
 */

import { BrowserWindow, WebContentsView, session } from 'electron'
import type { AdapterRuntime } from '../../shared/adapter'
import { diag } from '../diagnostics/log'
import { markLoginWindow, releaseLoginWindow } from './guards'
import { summarizeAuthCookies, type AuthCookie, type CredentialExpiry } from './auth-cookies'

// 认证 cookie 的识别与有效期汇总是纯函数（见 auth-cookies.ts），这里转发给既有调用方，
// 让「读 cookie 判登录态」的入口仍然只有一个。
export { summarizeAuthCookies, type AuthCookie, type CredentialExpiry }

/**
 * 伪装成普通 Chrome 浏览器。
 * Electron 默认 User-Agent 包含 `Electron/xx` 标识，LLM 站点据此识别自动化环境
 * 并在服务端使 session 失效，导致每次重启都要重新登录。
 */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

interface PoolEntry {
  modelId: string
  partition: string
  view: WebContentsView
  adapter: AdapterRuntime
  createdAt: number
  lastUsedAt: number
  /** 是否挂在主窗口上（转播/接管模式，用户可见） */
  attached: boolean
  /** 是否挂在隐藏宿主窗口上 —— 后台实例的唯一合法归属，见文件头注释 */
  inHost: boolean
  /** 挂起渲染以省内存 */
  suspended: boolean
  /** 上一次检测到的登录态，用于在变化时通知 UI */
  lastLoginState?: 'logged-in' | 'logged-out' | 'unknown'
  /** 是否已绑定导航监听，避免重复绑定 */
  watchBound?: boolean
  /**
   * 主框架最近一次加载的结果。present 时据此决定是否重试：
   * 开机预热常撞在网络还没就绪的窗口里，站点连不上（ERR_CONNECTION_TIMED_OUT）
   * 就把文档停在空白页；此后 ensure() 只认「已存在」，再不会自发重导，
   * 用户点开时看到的就是那一片空白 —— 而它本可以一次重载就救回来。
   */
  navState?: 'loading' | 'ok' | 'failed'
}

export interface WebviewPoolOptions {
  /** 内存上限（MB），超过则 LRU 回收非活跃实例 */
  memoryBudgetMb: number
}

/** 单个 WebContentsView 的保守内存估算（MB） */
export const MB_PER_WEBVIEW = 250

/**
 * 默认内存预算。
 *
 * 必须 ≥ 内置 webview 型模型数 × MB_PER_WEBVIEW，否则启动预热时
 * 就会触发 LRU 回收，把刚创建的实例销毁 —— 表现为该模型整场缺席，
 * 且原因被报成「WebView 未初始化」，与真实问题（内存预算不足）毫无关联。
 *
 * 当前内置 9 个网页版模型，9 × 250 = 2250MB，留出余量取 3072MB。
 * 超出部分由 LRU 回收兜底（只回收 15 秒未触及的空闲实例）。
 */
export const DEFAULT_MEMORY_BUDGET_MB = 3072

/**
 * 轻量登录预检：只读 cookie，不创建 WebView。
 *
 * 目的：让「启动时只预热已登录模型」成为可能。
 * 实例化一个 WebView 约 250MB 且要数秒加载，而绝大多数模型
 * 处于未登录状态 —— 启动就把全部实例拉起来，纯属浪费内存与时间，
 * 还会把内存预算顶穿。
 *
 * 「哪些 cookie 算认证证据、最早什么时候到期」的判定不在这里，
 * 见 auth-cookies.ts —— 那是纯函数，界面与体检共用同一个口径。
 */
export async function probeSessionCookies(
  partition: string,
  host: string,
): Promise<{ likelyLoggedIn: boolean; hits: string[]; total: number; expiry: CredentialExpiry }> {
  try {
    const all = await session.fromPartition(partition).cookies.get({})
    const { auth, expiry } = summarizeAuthCookies(all, host)
    return { likelyLoggedIn: auth.length > 0, hits: auth.slice(0, 6).map((c) => c.name), total: all.length, expiry }
  } catch {
    return { likelyLoggedIn: false, hits: [], total: 0, expiry: { authCookies: 0, sessionOnly: false } }
  }
}

/** 只问有效期：不建实例、不判登录态，读一次 cookie 就够 */
export async function credentialExpiry(partition: string, host: string): Promise<CredentialExpiry> {
  return (await probeSessionCookies(partition, host)).expiry
}

export class WebviewPool {
  private entries = new Map<string, PoolEntry>()
  private win: BrowserWindow | null = null
  private hostWin: BrowserWindow | null = null

  /** 宿主窗口尺寸 = 后台实例拿到的视口。太小会让站点退化成移动端布局 */
  private static readonly HOST_W = 1280
  private static readonly HOST_H = 900

  constructor(private readonly opts: WebviewPoolOptions = { memoryBudgetMb: DEFAULT_MEMORY_BUDGET_MB }) {}

  attachToWindow(win: BrowserWindow): void {
    this.win = win
  }

  /**
   * 宿主窗口：后台实例挂在这里才有真实视口，同时用负坐标 + skipTaskbar 让用户看不见。
   *
   * 必须「创建时即 show:true」，不能 show:false 之后再 show()。
   * 实测（克隆真实 DeepSeek 分区，同视口同分区跑完整抽取链路）：
   *   创建时 show:false → document.visibilityState 恒为 hidden，rAF 回调数 0，
   *   之后调用 show()/showInactive() 也翻不回可见态；
   *   创建时 show:true 且摆在 -32000 → visibilityState=visible，rAF 正常出帧。
   * 差别对功能不是细节而是生死：隐藏态下站点一帧都不画，
   * 而 DeepSeek 的消息列表是虚拟化 + IntersectionObserver 挂载的 ——
   * 观察回调不出帧就不触发，连历史消息都不会进 DOM（实测 dsMessage 恒为 0、
   * body 停在 78 字符 110 秒零变化），于是抓取只能读到一个空串，
   * 表现为「生成结束但未捕获到内容」。靠定时器提交文本的站点（ChatGPT/豆包）
   * 不受影响，所以这个坑只在个别模型上发作。
   *
   * 顺带保留两条旧结论：① 抓取只能读 DOM（executeJavaScript 强制同步布局，
   * 不依赖绘制）；② 想给后台实例截图只能走 CDP，capturePage 拿到的是空帧。
   */
  private ensureHost(): BrowserWindow {
    if (this.hostWin && !this.hostWin.isDestroyed()) return this.hostWin
    const host = new BrowserWindow({
      width: WebviewPool.HOST_W,
      height: WebviewPool.HOST_H,
      x: -32000,
      y: -32000,
      show: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      frame: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    host.on('closed', () => {
      this.hostWin = null
      // 窗口销毁会带走其下的 view 归属关系：标记为未挂载，下次 park 时重新挂
      for (const e of this.entries.values()) e.inHost = false
    })
    this.hostWin = host
    return host
  }

  /** 把实例挂回宿主窗口（后台态） */
  private park(e: PoolEntry): void {
    if (e.inHost) return
    const host = this.ensureHost()
    try {
      host.contentView.addChildView(e.view)
      e.view.setBounds({ x: 0, y: 0, width: WebviewPool.HOST_W, height: WebviewPool.HOST_H })
      e.inHost = true
    } catch {
      /* view 仍被别的窗口持有：先由那条路径 removeChildView */
    }
  }

  /** 从宿主窗口摘除 */
  private unpark(e: PoolEntry): void {
    if (!e.inHost) return
    if (this.hostWin && !this.hostWin.isDestroyed()) {
      try {
        this.hostWin.contentView.removeChildView(e.view)
      } catch {
        /* 已不在树上 */
      }
    }
    e.inHost = false
  }

  /**
   * 关闭宿主窗口。主窗口关闭时必须调用 —— 否则宿主本身算一枚存活窗口，
   * window-all-closed 永不触发，应用会僵在后台退不出去。
   */
  disposeHost(): void {
    if (!this.hostWin || this.hostWin.isDestroyed()) {
      this.hostWin = null
      return
    }
    for (const e of this.entries.values()) this.unpark(e)
    this.hostWin.close()
    this.hostWin = null
  }

  /**
   * 主窗口内「网页视图」边界。
   *
   * 顶部要让出 mode-tabs（含「已登录完成」复核按钮）52px，
   * 底部要让出提示条 44px —— 否则提示文字会压在站点页面之上，
   * 既挡住页面又点不到。
   */
  presentBounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.win || this.win.isDestroyed()) return null
    const b = this.win.getContentBounds()
    // 旧布局基线：const TOP = 56 + 36；新布局使用标题栏 64px + 标签栏 52px。
    const TOP = 64 + 52
    const BOTTOM = 44
    const LEFT = b.width <= 820 ? 204 : b.width <= 1080 ? 220 : 244
    const RIGHT = b.width <= 820 ? 0 : b.width <= 1080 ? 260 : 300
    return {
      x: LEFT,
      y: TOP,
      width: Math.max(320, b.width - LEFT - RIGHT),
      height: Math.max(240, b.height - TOP - BOTTOM),
    }
  }

  /**
   * 分区名解析。
   *
   * 必须使用调用方传入的 partition，而不是自己按 modelId 推导：
   * 用户自建模型声明的是 persist:torra-user-<id>，若这里按 modelId 推导出
   * persist:torra-<id>，则登录窗口与后台实例会落在两个不同分区 ——
   * 用户在登录窗口登录成功，写进的是 A 分区，而自动化实际读的是 B 分区，
   * 表现为「登录了但等于没登录」。
   */
  private partitionOf(modelId: string, declared?: string): string {
    return declared ?? `persist:torra-${modelId}`
  }

  /** 取得某模型实例当前使用的分区名（供诊断与一致性校验） */
  getPartition(modelId: string): string | null {
    return this.entries.get(modelId)?.partition ?? null
  }

  /**
   * 取得（必要时创建）某模型的后台 WebView。
   * @param partition 调用方声明的分区名。必须与登录窗口使用的一致。
   */
  ensure(modelId: string, adapter: AdapterRuntime, partition?: string): WebContentsView {
    const existing = this.entries.get(modelId)
    if (existing) {
      existing.lastUsedAt = Date.now()
      existing.view.webContents.setBackgroundThrottling(false)
      existing.suspended = false
      // 宿主窗口曾被销毁（主窗口关闭过）：重新挂回去，否则又是 0×0
      if (!existing.attached && !existing.inHost) this.park(existing)
      return existing.view
    }

    const part = this.partitionOf(modelId, partition)

    // 以 "persist:" 前缀命名即代表该 session 落盘持久化（Electron 约定，
    // 33.x 的 fromPartition 不接受 persist 选项，只有 cache）。缺这个前缀
    // 重启后所有登录态都会丢。
    const ses = session.fromPartition(part)
    ses.setUserAgent(CHROME_UA)

    const view = new WebContentsView({
      webPreferences: {
        partition: part,
        // PRD 11.2：站点页面零 Node 权限
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // 站点不需要申请更多权限：真正的拒处在 web-contents-created 装的闸门（见 webview/guards.ts），
        // 不装的话 Electron 会自动批准站点的一切权限请求
        webSecurity: true,
      },
    })

    // 显式释放后台节流（激活态全速）
    view.webContents.setBackgroundThrottling(false)

    const entry: PoolEntry = {
      modelId,
      partition: part,
      view,
      adapter,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      attached: false,
      inHost: false,
      suspended: false,
    }
    this.entries.set(modelId, entry)
    this.wireNavLog(entry)

    // 必须先挂进宿主窗口再导航：未挂载的 view 视口为 0×0，站点会渲染成
    // 移动端布局，桌面版选择器根本不存在（详见文件头注释）。
    this.park(entry)

    // 未参与讨论的实例挂起渲染
    void view.webContents.loadURL(adapter.spec.entry)
    this.enforceMemoryBudget()

    return view
  }

  get(modelId: string): WebContentsView | undefined {
    return this.entries.get(modelId)?.view
  }

  /**
   * 导航事件进流水线日志。
   * 没有它，「页面没加载完」与「加载到了错误的页面」在外部完全同形，
   * 只能靠现场复现脚本猜 —— 而复现脚本本身的分区又不一定等价。
   */
  private wireNavLog(e: PoolEntry): void {
    const wc = e.view.webContents
    let started = Date.now()
    wc.on('did-start-loading', () => {
      started = Date.now()
      e.navState = 'loading'
      diag.log({ ts: started, layer: 'channel', stage: 'nav-start', subject: e.modelId, detail: wc.getURL() })
    })
    wc.on('did-finish-load', () => {
      e.navState = 'ok'
      diag.log({
        ts: Date.now(),
        layer: 'channel',
        stage: 'nav-finish',
        subject: e.modelId,
        ok: true,
        ms: Date.now() - started,
        detail: wc.getURL(),
      })
    })
    wc.on('did-fail-load', (_ev, code, desc, url, isMainFrame) => {
      // -3 = ERR_ABORTED：被新导航打断，不是真失败，别把它记成 failed 触发无谓重试
      if (isMainFrame && code !== -3) e.navState = 'failed'
      diag.log({
        ts: Date.now(),
        layer: 'channel',
        stage: 'did-fail-load',
        subject: e.modelId,
        ok: false,
        detail: `code=${code} desc=${desc} url=${String(url).slice(0, 120)} mainFrame=${isMainFrame}`,
      })
    })
    wc.on('render-process-gone', (_ev, d) => {
      diag.log({
        ts: Date.now(),
        layer: 'channel',
        subject: e.modelId,
        stage: 'renderer-gone',
        ok: false,
        detail: `${d.reason}/${d.exitCode}`,
      })
    })
  }

  /**
   * 适配器热更新后同步实例。spec 内容与 registry 同引用，选择器改动即刻生效；
   * 这里只处理 entry 变化：仅当页面已不站点同源时才重新导航，
   * 避免打断用户当前所在的会话页。
   */
  refreshEntry(modelId: string, adapter: AdapterRuntime): void {
    const e = this.entries.get(modelId)
    if (!e) return
    e.adapter = adapter
    try {
      if (new URL(e.view.webContents.getURL()).origin === new URL(adapter.spec.entry).origin) return
    } catch {
      /* 页面尚未加载完或地址非法：按下面的分支重新导航 */
    }
    void e.view.webContents.loadURL(adapter.spec.entry)
  }

  has(modelId: string): boolean {
    return this.entries.has(modelId)
  }

  /**
   * 将某实例的 WebView 搬到主窗口指定区域（转播 / 接管模式）。
   * 实例平时住在隐藏宿主窗口里，这里做的是「换宿主」，不是「从无到有」。
   */
  present(modelId: string, bounds?: { x: number; y: number; width: number; height: number }): boolean {
    const e = this.entries.get(modelId)
    if (!e || !this.win || this.win.isDestroyed()) return false
    const target = bounds ?? this.presentBounds()
    if (!target) return false
    this.unpark(e)
    e.view.setBounds(target)
    if (!e.attached) {
      this.win.contentView.addChildView(e.view)
      e.attached = true
    }
    /*
     * 切换目标时不留空白帧：后 add 的视图画在上层，所以先把新的贴好，
     * 再摘掉其它还挂着的。反过来「先摘后贴」会露出一瞬应用底色 ——
     * 用户在标签之间切一下就要闪一下，正是「一顿一顿」的来源之一。
     */
    for (const other of this.entries.values()) {
      if (other !== e && other.attached) this.dismiss(other.modelId)
    }
    e.view.webContents.setBackgroundThrottling(false)
    e.lastUsedAt = Date.now()
    /*
     * 补导一次「空白页」。开机预热常撞在网络还没就绪的窗口里，站点连不上
     * （ERR_CONNECTION_TIMED_OUT）就把文档永久停在空白页；ensure() 之后只认
     * 「实例已存在」，不再自发重导，用户点开时看到的就是那一片空白。
     * 只在确实没东西可展示时补导，且先把状态置成 loading 去抖 ——
     * present 会被界面逐帧调用，不能每帧都朝站点重发一次导航。
     */
    if (e.navState === 'failed' || this.isBlankDoc(e)) {
      e.navState = 'loading'
      void e.view.webContents.loadURL(e.adapter.spec.entry)
    }
    return true
  }

  /** 文档当前是否停在「什么都没有」的状态（空白页或错误页） */
  private isBlankDoc(e: PoolEntry): boolean {
    try {
      const u = e.view.webContents.getURL()
      return u === '' || u === 'about:blank' || u.startsWith('chrome-error://')
    } catch {
      /* 实例已销毁：不判为空白，交给上层分支自然退出 */
      return false
    }
  }

  /** 从主窗口摘回宿主窗口（回到后台常驻，不销毁、不掉视口） */
  dismiss(modelId: string): void {
    const e = this.entries.get(modelId)
    if (!e) return
    if (e.attached) {
      if (this.win && !this.win.isDestroyed()) {
        try {
          this.win.contentView.removeChildView(e.view)
        } catch {
          /* 已不在树上 */
        }
      }
      e.attached = false
    }
    this.park(e)
  }

  dismissAll(): void {
    for (const id of this.entries.keys()) this.dismiss(id)
  }

  /**
   * 打开一个独立的、可见的登录窗口（PRD 7.1 P0-1）
   *
   * @param partition 必须与 ensure() 用的是同一个分区，否则登录态互不可见
   * @param onClosed 窗口关闭时回调。登录窗口一关，后台实例就刷新页面 ——
   *   否则它仍停留在登录前加载的那份文档里，站点不会因为 cookie 变化
   *   而自行重渲染，表现就是「登录成功但仍需重复登录」。
   * @param title 窗口标题。给了就把站点的 <title> 挡掉：标题变成「元宝」之后，
   *   用户分不清这是 Torra 的临时识别窗口还是自己开的浏览器，更不知道该在哪儿关它。
   */
  openLoginWindow(
    modelId: string,
    url: string,
    options?: { partition?: string; title?: string; onClosed?: () => void },
  ): BrowserWindow {
    const part = this.partitionOf(modelId, options?.partition)
    const login = new BrowserWindow({
      width: 520,
      height: 760,
      title: options?.title ?? '登录以建立会话分区（完成后关闭本窗口）',
      webPreferences: {
        partition: part,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    if (options?.title) {
      // 站点的 <title> 会把窗口标题换成「元宝」，用户就分不清这是 Torra 的临时窗口还是自己的浏览器
      login.on('page-title-updated', (e) => e.preventDefault())
    }
    // 登记为「允许应用内弹窗」的唯一场景：不少站点的 OAuth 靠 window.open 续接，
    // 闸门（见 webview/guards.ts）对未登记的页面一律不在应用内开窗。id 要先取 —— 关闭回调里 webContents 已销毁。
    const loginContentsId = login.webContents.id
    markLoginWindow(loginContentsId)
    login.once('closed', () => releaseLoginWindow(loginContentsId))
    if (options?.onClosed) {
      // once 而非 on：用户可能重复开关登录窗口，每次关闭都该触发一次刷新
      login.once('closed', options.onClosed)
    }
    session.fromPartition(part).setUserAgent(CHROME_UA)
    void login.loadURL(url)
    return login
  }

  /**
   * 观察登录态变化。
   *
   * 内嵌视图下用户直接在页面里完成登录，没有「关闭窗口」这个天然终点，
   * 因此需要在导航完成时主动复检 —— 用户登录成功的那次跳转就是信号。
   * 状态从非 logged-in 变为 logged-in 时回调通知 UI，
   * 这样用户不必手动点「复核状态」才知道登录已生效。
   */
  watchLogin(modelId: string, onChange: (state: 'logged-in' | 'logged-out' | 'unknown', reason: string) => void): void {
    const e = this.entries.get(modelId)
    if (!e || e.watchBound) return
    e.watchBound = true

    let timer: NodeJS.Timeout | null = null
    const check = () => {
      if (timer) clearTimeout(timer)
      // 登录常伴随多次跳转（SPA 路由、OAuth 回跳），延迟一段再判定，
      // 否则会拿到跳转中途的中间态而误报
      timer = setTimeout(() => {
        void this.inspectLogin(modelId).then((st) => {
          const prev = e.lastLoginState
          e.lastLoginState = st.state
          // 只在「转为已登录」与「从已登录退回」这两个方向通知，
          // 避免页面每次跳转都弹提示
          if (prev === st.state) return
          if (st.state === 'logged-in' || prev === 'logged-in') {
            onChange(st.state, st.reason)
          }
        })
      }, 2500)
    }

    e.view.webContents.on('did-navigate-in-page', check)
    e.view.webContents.on('did-navigate', check)
    e.view.webContents.on('did-finish-load', check)

    // 页面可能在观察器绑定前就已完成登录/加载（例如从后台恢复或
    // 用户直接点开一个已登录实例）。只监听后续导航会把旧的
    // logged-out 状态一直留在状态灯上，因此绑定时主动复核一次。
    check()
  }

  /**
   * 重新加载后台实例的页面。
   *
   * 这是「登录态不生效」的关键修复：登录窗口与后台实例是两个独立的
   * WebContents。后台实例在登录之前就已经加载完页面，它不会感知到
   * 另一个实例写入的登录凭据，必须重新导航一次才会带上新 cookie。
   *
   * 注意不能用 executeJavaScript 改写 DOM —— 那属于伪造页面状态，
   * 且站点自己的前端状态机（登录态）并不会同步，刷新才是唯一正解。
   */
  reloadEntry(modelId: string): void {
    const e = this.entries.get(modelId)
    if (!e) return
    void e.view.webContents.loadURL(e.adapter.spec.entry)
  }

  /**
   * 刷新某个模型的页面（网页视图表头那颗刷新按钮）。
   *
   * 用 reload() 而不是 reloadEntry()：用户可能正停在某一条具体会话里，
   * 重新导航到入口等于把他的上下文丢了。「点了没反应」的时候，
   * 就地重载这一份文档才是他要的那一下。
   *
   * 等 did-finish-load / did-fail-load 再返回，界面才知道转圈该在哪儿停 ——
   * 否则按钮一按就复原，跟没按一样。
   */
  async reload(modelId: string, timeoutMs = 20_000): Promise<{ ok: boolean; reason?: string }> {
    const e = this.entries.get(modelId)
    if (!e) return { ok: false, reason: '实例未初始化，无法刷新' }
    const wc = e.view.webContents
    if (wc.isDestroyed()) return { ok: false, reason: '实例已销毁' }
    e.lastUsedAt = Date.now()

    return new Promise((resolve) => {
      let settled = false
      const finish = (ok: boolean, reason?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        wc.off('did-finish-load', onDone)
        wc.off('did-fail-load', onFail)
        resolve({ ok, reason })
      }
      const onDone = () => finish(true)
      const onFail = (_ev: Electron.Event, code: number, desc: string, _url: string, isMainFrame: boolean) => {
        // 子资源失败不该判负；-3 是被新导航打断，也不是错误
        if (!isMainFrame || code === -3) return
        finish(false, `页面加载失败：${desc || '未知错误'}（${code}）`)
      }
      const timer = setTimeout(() => finish(false, '刷新超时：站点可能还在加载'), timeoutMs)
      wc.on('did-finish-load', onDone)
      wc.on('did-fail-load', onFail)
      wc.reload()
    })
  }

  /**
   * 等待后台实例页面加载到可探测状态（用于登录后立即复核）
   */
  async waitReady(modelId: string, timeoutMs = 20000): Promise<boolean> {
    const e = this.entries.get(modelId)
    if (!e) return false
    const wc = e.view.webContents
    if (!wc.isLoading()) return true
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        wc.off('did-finish-load', onDone)
        resolve(false)
      }, timeoutMs)
      const onDone = () => {
        clearTimeout(timer)
        // 再给 SPA 一点渲染时间，否则探针会因元素尚未挂载而误判
        setTimeout(() => resolve(true), 1200)
      }
      wc.once('did-finish-load', onDone)
    })
  }

  /**
   * 登录态检测。
   *
   * 不能只看 health_probe（输入框）是否存在 —— 实测 Kimi 未登录时
   * 同样会渲染出 div.chat-input-editor，用它判定会得到「已登录」的假阳性，
   * 于是用户明明没登录却被告知一切正常，反复登录却不知为何。
   *
   * 判定依据按可信度排序：
   * 1. URL 落到登录页 → 一定未登录（最强证据）
   * 2. 页面出现登录 CTA 且缺少用户态标记 → 未登录
   * 3. localStorage 出现 token/auth 类 key → 已登录
   * 4. 以上都判不出 → 返回 unknown 而非瞎猜
   */
  async inspectLogin(modelId: string): Promise<{
    state: 'logged-in' | 'logged-out' | 'unknown'
    reason: string
    url: string
    tokenKeys: string[]
    /** 判定所依据的原始观测，用于诊断「明明已登录却判未登录」 */
    evidence?: {
      onLoginPage: boolean
      hasUserFlag: boolean
      hasLoginCta: boolean
      allLocalKeys: string[]
      storageReadable?: boolean
      authCookieKeys?: string[]
    }
  }> {
    const e = this.entries.get(modelId)
    if (!e) {
      /*
       * 实例不存在时不能直接报 unknown。
       * 状态灯会把 unknown 退化成 disabled（灰），
       * 用户看到的是一个无法解释的灰色圆点，而不是「未登录，请登录」。
       * 这里让调用方提供 ensure 的能力；拿不到时如实说明原因。
       */
      return {
        state: 'unknown',
        reason: '实例未初始化，无法判定登录态',
        url: '',
        tokenKeys: [],
      }
    }

    let url = ''
    try {
      url = e.view.webContents.getURL()
    } catch {
      /* 实例已销毁 */
    }

    // 落在登录/注册页是决定性证据，无需再看 DOM
    if (/\/(sign_?in|sign_?up|login|register|auth)(\/|$)/i.test(url)) {
      return {
        state: 'logged-out',
        reason: `页面被重定向到登录页：${url}`,
        url,
        tokenKeys: [],
        evidence: { onLoginPage: true, hasUserFlag: false, hasLoginCta: false, allLocalKeys: [] },
      }
    }

    let tokenKeys: string[] = []
    let hasLoginCta = false
    let hasUserFlag = false
    let allLocalKeys: string[] = []
    let hasUsableInput = false
    let storageReadable = true
    let authCookieKeys: string[] = []

    try {
      const r = (await e.view.webContents.executeJavaScript(
        `(() => {
          const grab = (s) => {
            const a = [];
            try { for (let i = 0; i < s.length; i++) a.push(s.key(i)); } catch {}
            return a;
          };
          // Accessing localStorage/sessionStorage itself can throw (for example
          // while a renderer is between navigations or on an opaque origin).
          // Do not let that hide page evidence; an input alone is not
          // sufficient to prove that the visitor is authenticated.
          let keys = [];
          let storageReadable = true;
          try {
            keys = grab(window.localStorage).concat(grab(window.sessionStorage));
          } catch {
            storageReadable = false;
          }
          const tokenish = keys.filter(k => /token|auth|session|user|account|uid|jwt|bearer|credential|passport|sso/i.test(k));
          // 站点自己的用户态标记
          const userFlagKeys = keys.filter(k => /^__.*user|^.*_user$|profile|account|userinfo/i.test(k));
          // Keep this as an array comparison rather than a regex literal: this
          // code runs inside a TS template string, where an escaped slash can
          // be collapsed and make the injected script invalid JavaScript.
          const ctaLabels = ['登录', '立即登录', '登录/注册', 'Sign in', 'Log in', 'Login', '注册'];
          const cta = [...document.querySelectorAll('button,a,span,div')]
            .map(e => (e.textContent || '').trim())
            .filter(t => t.length > 0 && t.length < 12)
            .some(t => ctaLabels.includes(t));
          // 关键补充证据：聊天输入区是否可用。
          // 已登录的对话页一定有输入区；登录页没有（只有手机号/密码框）。
          // 这个信号比任何文本匹配都可靠，且不受站点改版文案影响。
          const spec = ${JSON.stringify({ input: e.adapter.spec.selectors.input })};
          let inputPresent = false;
          try { inputPresent = spec.input ? document.querySelectorAll(spec.input).length > 0 : false; } catch {}
          if (!inputPresent) {
            inputPresent = document.querySelectorAll(
              'textarea[name="user query"],div.chat-input-editor[contenteditable="true"],#prompt-textarea,div[contenteditable="true"][role="textbox"],rich-textarea .ql-editor,textarea.message-input-textarea'
            ).length > 0;
          }
          return {
            tokenish: tokenish.slice(0, 10),
            userFlagKeys,
            hasUserFlag: userFlagKeys.length > 0,
            cta,
            inputPresent,
            storageReadable,
            allKeys: keys.slice(0, 60),
          };
        })()`,
        true,
      )) as {
        tokenish: string[]
        userFlagKeys: string[]
        hasUserFlag: boolean
        cta: boolean
        inputPresent: boolean
        storageReadable: boolean
        allKeys: string[]
      }
      tokenKeys = r.tokenish
      hasLoginCta = r.cta
      hasUserFlag = r.hasUserFlag
      allLocalKeys = r.allKeys
      hasUsableInput = r.inputPresent
      storageReadable = r.storageReadable
    } catch {
      // If the page script itself is temporarily unavailable, make one narrow
      // DOM-only attempt before returning unknown. This keeps a visible chat
      // input from being misreported as a storage/login failure.
      const inputPresent = await e.view.webContents.executeJavaScript(
        `(() => {
          const s = ${JSON.stringify(e.adapter.spec.selectors.input)};
          try {
            return (s && document.querySelectorAll(s).length > 0) ||
              document.querySelectorAll('textarea[name="user query"],div.chat-input-editor[contenteditable="true"],div[contenteditable="true"][role="textbox"]').length > 0;
          } catch { return false; }
        })()`,
        true,
      ).catch(() => false)
      if (inputPresent) {
        return {
          state: 'unknown',
          reason: '聊天输入区可用但页面存储暂不可读，不能确认登录态',
          url,
          tokenKeys: [],
          evidence: { onLoginPage: false, hasUserFlag: false, hasLoginCta: false, allLocalKeys: [], storageReadable: false },
        }
      }
      return { state: 'unknown', reason: '页面尚未就绪，无法读取登录态', url, tokenKeys: [] }
    }

    // Cookie 是 ChatGPT / DeepSeek 等站点的主要认证信号；必须在页面加载后
    // 再读一次，因为 DeepSeek 会在导航完成后才写入 ds_session_id。
    try {
      const host = new URL(e.adapter.spec.entry).hostname
      const cookies = await probeSessionCookies(e.partition, host)
      authCookieKeys = cookies.hits
      for (const key of cookies.hits) {
        if (!tokenKeys.includes(key)) tokenKeys.push(key)
      }
    } catch {
      authCookieKeys = []
    }

    const evidence = {
      onLoginPage: false,
      hasUserFlag,
      hasLoginCta,
      allLocalKeys,
      storageReadable,
      authCookieKeys,
    }

    /*
     * 登录态必须保守：登录入口优先否决，输入框只能说明页面可交互，
     * 只有用户态标记或可信 Cookie 才允许状态灯变绿。
     */
    // 登录入口优先于泛化的 token 命中：Kimi 的匿名页面也有埋点 token，
    // 豆包有 passport_csrf_token，但两者都不代表用户已登录。
    if (hasLoginCta) {
      return { state: 'logged-out', reason: '页面显示登录入口，未确认用户态', url, tokenKeys, evidence }
    }
    if (hasUserFlag || authCookieKeys.length > 0) {
      return {
        state: 'logged-in',
        reason: hasUserFlag ? '检测到用户态存储标记' : '检测到可信登录 Cookie',
        url,
        tokenKeys,
        evidence,
      }
    }
    if (hasUsableInput) {
      // 游客页也可能渲染输入框；没有可信认证证据时不能把“能输入”
      // 误报成“已登录”。unknown 会阻止状态灯变绿，并提示用户复核。
      return {
        state: 'unknown',
        reason: storageReadable
          ? '聊天输入区可用但未检测到可信登录凭据'
          : '聊天输入区可用但页面存储不可读，不能确认登录态',
        url,
        tokenKeys,
        evidence,
      }
    }

    // 判不出就如实报存疑，不硬猜。
    return {
      state: 'unknown',
      reason:
        '无法确定登录态：页面无登录入口也无凭据。' +
        '若你确实已登录，可能是站点改版导致输入区选择器失效 —— 请检查适配器的 input 选择器',
      url,
      tokenKeys,
      evidence,
    }
  }

  /** 关闭登录窗口 */
  closeLoginWindow(w: BrowserWindow): void {
    if (!w.isDestroyed()) w.close()
  }

  /** 健康探针：探测 health_probe 选择器是否存活 */
  async healthCheck(modelId: string): Promise<boolean> {
    const e = this.entries.get(modelId)
    if (!e) return false
    try {
      const found = await e.view.webContents.executeJavaScript(
        `(() => { try { return !!document.querySelector(${JSON.stringify(e.adapter.spec.health_probe)}); } catch { return false; } })()`,
        true,
      )
      return found === true
    } catch {
      return false
    }
  }

  /**
   * 内存超阈值时 LRU 回收非活跃实例（保留登录态）。
   *
   * 两条硬约束，缺一个就会出现「模型被无故标记缺席」：
   *
   * 1. **绝不回收刚创建的实例**。ensure() 是「先创建、再检查预算」，
   *    新实例的 lastUsedAt 与旧实例几乎相同，按时间排序会随机被选中 ——
   *    结果是 ensure() 返回后实例已被自己销毁，发言时必然报
   *    「WebView 未初始化」。故引入 notBefore 作为保护期。
   * 2. **只回收未被使用的实例**。attached 或刚被 ensure/present 触及的跳过。
   *
   * 被回收的实例下次用到时会由 ensure() 重建；partition 数据保留，
   * 登录态不丢（登录凭据在 session 层，与 WebContents 实例生命周期无关）。
   */
  private enforceMemoryBudget(): void {
    const total = this.entries.size
    // 保守估算：每个 WebView 约 250MB
    const estimatedMb = total * MB_PER_WEBVIEW
    if (estimatedMb <= this.opts.memoryBudgetMb) return

    // 保护期：本次 ensure() 之前 15 秒内创建/使用过的实例一律不回收
    const protectAfter = Date.now() - 15_000

    const sorted = [...this.entries.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    let excess = estimatedMb - this.opts.memoryBudgetMb
    for (const e of sorted) {
      if (excess <= 0) break
      if (e.attached) continue
      if (e.lastUsedAt > protectAfter) continue
      if (e.inHost && e.view.webContents.isLoading()) continue // 正在加载，别打断
      this.disposeEntry(e.modelId)
      excess -= MB_PER_WEBVIEW
    }
  }

  /** 销毁一个实例（登录态不丢，partition 数据保留） */
  disposeEntry(modelId: string): void {
    const e = this.entries.get(modelId)
    if (!e) return
    if (e.attached && this.win && !this.win.isDestroyed()) {
      try {
        this.win.contentView.removeChildView(e.view)
      } catch {
        /* 已不在树上 */
      }
      e.attached = false
    }
    // 注意不能走 dismiss()：那会把 view 又挂回宿主窗口
    this.unpark(e)
    try {
      e.view.webContents.close()
    } catch {
      /* 已销毁 */
    }
    this.entries.delete(modelId)
  }

  markSuspended(modelId: string, suspended: boolean): void {
    const e = this.entries.get(modelId)
    if (!e) return
    e.view.webContents.setBackgroundThrottling(suspended)
    e.suspended = suspended
    if (!suspended) e.lastUsedAt = Date.now()
  }

  /** 当前内存占用估算（MB） */
  estimateMemoryMb(): number {
    return this.entries.size * 250
  }

  listModelIds(): string[] {
    return [...this.entries.keys()]
  }

  disposeAll(): void {
    for (const id of [...this.entries.keys()]) this.disposeEntry(id)
    this.disposeHost()
  }
}
