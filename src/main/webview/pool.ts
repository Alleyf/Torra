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

import { app, BrowserWindow, WebContentsView, session } from 'electron'
import type { AdapterRuntime } from '../../shared/adapter'
import { diag } from '../diagnostics/log'
import { applyChromeIdentity, clearGoogleAuthCookies, isGoogleSignInRejected, isLoginPageUrl, isWakeDocument, primeDocumentIdentity } from './chrome-identity'
import { markLoginWindow, releaseLoginWindow } from './guards'
import { summarizeAuthCookies, type AuthCookie, type CredentialExpiry } from './auth-cookies'
import { planEvictions, planIdle, planLimit, type Evictable } from './pool-memory'

// 认证 cookie 的识别与有效期汇总是纯函数（见 auth-cookies.ts），这里转发给既有调用方，
// 让「读 cookie 判登录态」的入口仍然只有一个。
export { summarizeAuthCookies, type AuthCookie, type CredentialExpiry }

// 「伪装成一台普通 Chrome」不是一行 setUserAgent 能做完的（UA / Sec-CH-UA 客户端提示 /
// navigator.userAgentData 三层要彼此一致），整套机制与它的由来都在 chrome-identity.ts。
// 会话层在这里的两个创建点认领分区；文档层由 app 的 web-contents-created 钩子补到
// 每一枚内嵌 webContents（含 window.open 的登录弹窗），见 main/index.ts。

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
  /**
   * 正被一轮生成占用。挂起与回收都要跳过它：
   * 一轮网页生成可以跑四分钟，中途节流或拆实例等于把这路直接判缺席。
   */
  busy?: boolean
  /**
   * 原生墙上的候补（这一场聊天的网页参与者），由渲染层整批报上来。
   *
   * 见 pool-memory.ts 的 Evictable.pinned：池内 MB 回收、常驻枚数裁剪、空闲回收三处都跳过它 ——
   * 那三道的本意是清理「用户大概不会再看」的后台实例，而参与者是点名要在场的。
   * 唯一会动它们的是系统可用内存低于阈值时的那一次紧急释放（relievePressure），
   * 那一刻渲染层会在格子上写明「已回收 · 点击重新加载」，不静默重载。
   */
  pinned?: boolean
  /** 上一次检测到的登录态，用于在变化时通知 UI */
  lastLoginState?: 'logged-in' | 'logged-out' | 'unknown'
  /** 是否已绑定导航监听，避免重复绑定 */
  watchBound?: boolean
  /**
   * 主框架最近一次加载的结果。present 时据此决定是否重试：
   * 开机预热常撞在网络还没就绪的窗口里，站点连不上（ERR_CONNECTION_TIMED_OUT）
   * 就把文档停在空白页；此后 ensure() 只认「已存在」，再不会自发重导，
   * 用户点开时看到的就是那一片空白 —— 而它本可以一次重载就救回来。
   *
   * 只由**主框架**的导航写：子帧（登录浮层、about:srcdoc 广告帧）不算，
   * 见 wireNavLog 的注释。
   */
  navState?: 'loading' | 'ok' | 'failed'
  /**
   * 正在等文档层身份补丁挂上（prime 阶段，文档停在 Torra 自己的唤醒页上）。
   * 这段时间 present() 不要补导：唤醒页是流程的一部分，不是「什么都没加载出来」，
   * 两处同时朝同一枚 contents 发导航只会互相打断成 ERR_ABORTED。
   */
  priming?: boolean
  /**
   * 最近一次由界面量出来的矩形。
   * 换实例（recreate）时界面那边不会有任何尺寸变化，主进程得照着它自己补贴一次，
   * 否则新视图一直停在屏幕外的宿主里。
   */
  lastPresentBounds?: { x: number; y: number; width: number; height: number }
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
 * 这里曾经是 3072MB（≈12 枚实例），而一场讨论最多 9 个网页模型 ——
 * 也就是 LRU 那条回收路径在生产里根本走不到，空闲实例一直占着渲染进程。
 * 现在按「八成场景装得下、满载能挤出两枚」取 1800MB（7.2 枚）：
 * 一场 8 路讨论里最久没被碰的那一两枚会被回收，下次用到由 ensure() 重建
 * （partition 数据保留，登录态不丢）。
 *
 * 预热不会因此被自我销毁：ensure() 的保护期是 15 秒，预热循环远快于它，
 * 且预热的判据是「已登录」，未登录模型根本不会建实例。
 */
export const DEFAULT_MEMORY_BUDGET_MB = 1800

/**
 * 空闲到多久就整枚回收（而不只是挂起）。
 *
 * 挂起（setBackgroundThrottling）省的是 CPU，渲染进程的内存原样留着 ——
 * 7 枚网页模型就是 7 个 Chromium 渲染进程常驻，这正是「Torra 占 1.5GB」的主因。
 * 所以再加一道更长的空闲线：10 分钟没人碰，就把实例拆掉，内存还给系统。
 * 下次用到由 ensure() 重建，partition 数据保留，登录态不丢。
 *
 * 取 10 分钟而不是跟着 3 分钟的挂起线：一场讨论里轮转到某个模型之前，
 * 它整几分钟没被碰过是常态，拆得早了下一轮就得重建视图 + 重新导航，
 * 站点重新落地时读到的往往是上一场对话的最后一条（把旧答案当新回答）。
 */
export const DEFAULT_IDLE_DISPOSE_MS = 10 * 60_000

/**
 * 后台常驻实例的枚数上限。
 *
 * 一枚实例就是一个 Chromium 渲染进程（实测 120~500MB），所以「同时留几枚」
 * 是比 MB 预算更贴近真实成本的旋钮。3 枚的取法：覆盖「刚讨论完接着追问」
 * 与「单独打开某两三个模型对比」这两类常见用法，再往上是纯浪费 ——
 * 一场 8 路讨论的真正活跃枚数由场次决定，不该由常驻上限决定。
 *
 * 被裁掉的实例下次用到时由 ensure() 重建（partition 保留，登录态不丢），
 * 代价是那一路的首字晚几秒；这笔账在「内存一直占着」面前是划算的。
 */
export const DEFAULT_MAX_WARM_INSTANCES = 3

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
  private sweeper: ReturnType<typeof setInterval> | null = null

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
    // 认领这枚分区并装好 UA / 客户端提示。必须早于下面的 new WebContentsView：
    // app 的 web-contents-created 钩子（文档层，见 chrome-identity.ts）靠这份认领
    // 分辨内嵌站点与自家界面。体检与诊断脚本直接 new WebviewPool、不装钩子，
    // 少了这一层它们跑的是未伪装的内核，站点整页弹「使用环境异常」——
    // 现场与生产不同形，结论就不可信。
    applyChromeIdentity(ses, part)

    // 每个 partition 各存一份拼写词典与语言模型，站点页面里用不到它；
    // 关掉能省下每枚实例几十 MB 的常驻内存，且不影响页面功能。
    try {
      ses.setSpellCheckerEnabled(false)
    } catch {
      /* 内核不支持时忽略 */
    }

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
    /*
     * 站点页面里的动图/表情一直在解码与重绘，后台实例没人看却没有理由付这份
     * CPU 与内存。setImageAnimationPolicy 只关掉自动播放的动画帧，
     * 静态首帧照常显示（站点自己的交互式动画走脚本，不受影响）。
     */
    try {
      view.webContents.setImageAnimationPolicy('noAnimation')
    } catch {
      /* 内核不支持时忽略 */
    }

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
    // 在册的参与者后来才建出来的实例要自己认领保活标记，名单不等渲染层再报一次
    // （见 declaredPinned：首报时这几枚还不存在，漏了这一步就等于没保活）。
    if (this.declaredPinned.has(modelId)) entry.pinned = true
    this.wireNavLog(entry)

    // 必须先挂进宿主窗口再导航：未挂载的 view 视口为 0×0，站点会渲染成
    // 移动端布局，桌面版选择器根本不存在（详见文件头注释）。
    this.park(entry)

    // 未参与讨论的实例由清扫挂起渲染（见 startIdleSweeper），不在这里当场节流：
    // 文档还在加载时打开后台节流，站点自己的首屏脚本会被拖慢甚至拖出问题页。
    /*
     * 第一枚业务导航要等文档层补丁确认挂上再发（见 chrome-identity.ts 的
     * primeDocumentIdentity）。早于它发出去的那份文档读不到 Google Chrome 品牌，
     * 而请求头已经改好了 —— 「页面说 Chromium、请求头说 Chrome」这处矛盾
     * 正是 Google 登录闸门抓的东西，实测第一份文档缺品牌、第二份才有。
     */
    entry.priming = true
    void primeDocumentIdentity(view.webContents, part)
      .then(() => {
        entry.priming = false
        if (view.webContents.isDestroyed()) return
        return view.webContents.loadURL(adapter.spec.entry)
      })
      .catch(() => {
        entry.priming = false
      })
    /*
     * 回收不在这里做。ensure() 是预热与发言共用的入口，创建后立刻查预算，
     * 就会在预热循环里把先创建的那枚判成 LRU 淘汰掉 —— 表现为该模型整场缺席、
     * 原因报「WebView 未初始化」。改由周期清扫在「空闲 3 分钟 + 超预算」时才动手，
     * 且忙中的实例（正被一轮生成占着）一律跳过。
     */
    return view
  }

  get(modelId: string): WebContentsView | undefined {
    return this.entries.get(modelId)?.view
  }

  /**
   * 导航事件进流水线日志，并维护 navState。
   * 没有它，「页面没加载完」与「加载到了错误的页面」在外部完全同形，
   * 只能靠现场复现脚本猜 —— 而复现脚本本身的分区又不一定等价。
   *
   * navState 只认主框架：之前用的是 did-start-loading，它没有 isMainFrame 参数，
   * 站点里任意一个 iframe 开始加载就会把状态拍回 'loading'；而 did-finish-load 只在
   * 主框架加载完时发，于是这一拍再没人复位 —— 一次真实的主框架失败被抹掉后，
   * present() 的补导分支再也触发不了，用户看到的就是一片洗不掉的白。
   */
  private wireNavLog(e: PoolEntry): void {
    const wc = e.view.webContents
    let started = Date.now()
    wc.on('did-start-navigation', (_ev, url, isInPlace, isMainFrame) => {
      // 原地导航（hash / pushState）不会跟着 did-finish-load，置位会把上一次的失败原因抹掉
      // 原地导航（hash / pushState）不会跟着 did-finish-load，置位会把上一次的失败原因抹掉
      if (!isMainFrame) return
      if (isInPlace) {
        /*
         * 原地导航里只补记一种：掉进登录页。它不改 navState（不代表加载失败），
         * 但少了这一条，「内容页照常加载完」与「其实已被挪回登录页」在流水线日志里完全同形 ——
         * 而后者正是「站点看着好好的，Torra 却说没登进去」的那种现场。
         */
        if (isLoginPageUrl(String(url))) {
          diag.log({
            ts: Date.now(),
            layer: 'channel',
            stage: 'nav-signin',
            subject: e.modelId,
            ok: false,
            detail: String(url).slice(0, 120),
          })
        }
        // Google 拒绝页落地的这一刻就把毒 cookie 清掉：__Host-GAPS / OTZ 一旦写进分区，
        // 之后每次请求 accounts.google.com 都会短路进拒绝页，重试按钮永远撞同一堵墙。
        // 只清一次触发时机就够 —— 导航到 signin/rejected 本身就是「拒绝已发生」的凭证。
        if (isGoogleSignInRejected(String(url))) {
          void clearGoogleAuthCookies(wc.session).then(({ removed }) => {
            if (removed > 0) {
              diag.log({
                ts: Date.now(),
                layer: 'channel',
                stage: 'nav-signin',
                subject: e.modelId,
                ok: true,
                detail: `Google 拒绝页：已清除 ${removed} 枚拒绝 cookie，可点「重试」再登一次`,
              })
            }
          })
        }
      }
      // prime 阶段那枚唤醒渲染进程的本地页面不算一次业务导航：
      // 记进流水线日志只会多一条看不懂的「已加载」，界面还会闪一下 ok。
      if (isWakeDocument(String(url))) return
      started = Date.now()
      e.navState = 'loading'
      diag.log({
        ts: started,
        layer: 'channel',
        stage: 'nav-start',
        subject: e.modelId,
        detail: String(url).slice(0, 120),
      })
    })
    wc.on('did-finish-load', () => {
      // 同上：唤醒页落地不代表站点加载好了
      if (isWakeDocument(wc.getURL())) return
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
      this.notifyNav(e.modelId, 'ok', '')
    })
    wc.on('did-fail-load', (_ev, code, desc, url, isMainFrame) => {
      diag.log({
        ts: Date.now(),
        layer: 'channel',
        stage: 'did-fail-load',
        subject: e.modelId,
        ok: !isMainFrame || code === -3,
        detail: `code=${code} desc=${desc} url=${String(url).slice(0, 120)} mainFrame=${isMainFrame}`,
      })
      // 子资源失败不是页面失败；-3 = ERR_ABORTED 是被新导航打断，也不算 —— 别触发无谓重试
      if (!isMainFrame || code === -3) return
      e.navState = 'failed'
      /*
       * 错误页是原生视图，永远画在渲染层之上：留着它，界面那句「为什么是白的」
       * 就被站点自己的报错盖住，用户只看到一个陌生的错误页和一颗点不动的鼠标。
       * 摘回宿主、把原因推给渲染层 —— 空白区于是有了可读的成因，
       * 「重试打开」按下去走的仍是 present() 那条会补导的路径。
       */
      this.dismiss(e.modelId)
      this.notifyNav(e.modelId, 'failed', `页面加载失败：${desc || '未知错误'}（${code}）`)
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

  /** 主框架加载结论推给渲染层：界面只有在这一刻才知道自己贴上来的是内容还是错误页 */
  private notifyNav(modelId: string, state: 'ok' | 'failed', reason: string): void {
    if (!this.win || this.win.isDestroyed()) return
    try {
      this.win.webContents.send('webview:nav', { modelId, state, reason })
    } catch {
      /* 渲染层还没就绪：这条只是提示，丢了不影响功能 */
    }
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
   *
   * @param renav 关掉「空白页补导」。只有一种情况需要：recreate() 刚为新实例发过导航，
   *   这里再发一次只会把它打断成 ERR_ABORTED（并留下一个没人 catch 的 loadURL promise）。
   * @param wall 多视图并存（聊天模式的原生墙）。默认 false 沿用「一次只挂一枚」的互斥语义；
   *   置 true 时不摘其它已挂载的实例 —— 每一枚各占一块不重叠的矩形，同屏可见。
   *   互斥摘除是单窗格 dock 的设计，不能拿去承载墙：那会让第 2 枚贴上来时把第 1 枚踢回宿主，
   *   表现成「只留最后打开的那一页」，而墙的全部意义就是几页同时在场。
   *   回收与挂起本来就让行 attached，所以墙上的多枚不会被预算清扫误伤。
   */
  present(
    modelId: string,
    bounds?: { x: number; y: number; width: number; height: number },
    opts?: { renav?: boolean; wall?: boolean },
  ): boolean {
    const e = this.entries.get(modelId)
    if (!e || !this.win || this.win.isDestroyed()) return false
    const target = bounds ?? this.presentBounds()
    if (!target) return false
    e.lastPresentBounds = target
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
     *
     * 墙模式跳过这段互斥：摘除时机由界面自己负责（每个窗格卸载或塌成 0 尺寸时
     * 只 dismiss 自己那一路），否则窗格之间会互相踢下线。
     */
    if (!opts?.wall) {
      for (const other of this.entries.values()) {
        if (other !== e && other.attached) this.dismiss(other.modelId)
      }
    }
    e.view.webContents.setBackgroundThrottling(false)
    // 用户正在看它：声音该出就出（后台实例在挂起时静音，见 markSuspended）
    e.view.webContents.setAudioMuted(false)
    e.lastUsedAt = Date.now()
    /*
     * 补导一次「空白页」。开机预热常撞在网络还没就绪的窗口里，站点连不上
     * （ERR_CONNECTION_TIMED_OUT）就把文档永久停在空白页；ensure() 之后只认
     * 「实例已存在」，不再自发重导，用户点开时看到的就是那一片空白。
     * 只在确实没东西可展示时补导，且先把状态置成 loading 去抖 ——
     * present 会被界面逐帧调用，不能每帧都朝站点重发一次导航。
     */
    if ((opts?.renav ?? true) && !e.priming && (e.navState === 'failed' || this.isBlankDoc(e))) {
      e.navState = 'loading'
      void e.view.webContents.loadURL(e.adapter.spec.entry)
    }
    return true
  }

  /** 文档当前是否停在「什么都没有」的状态（唤醒页、空白页或错误页） */
  private isBlankDoc(e: PoolEntry): boolean {
    try {
      const u = e.view.webContents.getURL()
      return u === '' || isWakeDocument(u) || u.startsWith('chrome-error://')
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
    // 认领分区要早于造窗口：web-contents-created 钩子在那一刻就要认出这是内嵌站点分区
    applyChromeIdentity(session.fromPartition(part), part)
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
    /*
     * 登录页就是那枚「第一个文档」—— 用户在这里敲账号密码，Google 的闸门也在这里
     * 读页面自己报的品牌。所以和 ensure() 一样：先让补丁落地，再放登录地址过去。
     */
    void primeDocumentIdentity(login.webContents, part).then(() => {
      if (login.isDestroyed() || login.webContents.isDestroyed()) return
      return login.webContents.loadURL(url)
    })
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

    /*
     * 整页导航的拒绝页也要清毒 cookie：拒绝页经 302 落地走的是 did-navigate，
     * 到不了上面的原地分支。清里时机也在这里才可靠 —— did-start-navigation 时
     * Set-Cookie 还没落地，did-navigate（响应已收、cookie 已种）删的才是那份毒 token。
     */
    e.view.webContents.on('did-navigate', (_ev, url) => {
      if (!isGoogleSignInRejected(String(url))) return
      void clearGoogleAuthCookies(e.view.webContents.session).then(({ removed }) => {
        if (removed > 0) {
          diag.log({
            ts: Date.now(),
            layer: 'channel',
            stage: 'nav-signin',
            subject: e.modelId,
            ok: true,
            detail: `Google 拒绝页：已清除 ${removed} 枚拒绝 cookie，可点「重试」再登一次`,
          })
        }
      })
    })

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
   *
   * needsOpen：这一句不是「出错了」，而是「没有东西可刷新」。后台实例可能从没建过
   * （未登录、没被预热）或被内存预算回收了；重建走 present()，界面据此把按钮换成「重新打开」。
   */
  async reload(
    modelId: string,
    timeoutMs = 20_000,
  ): Promise<{ ok: boolean; reason?: string; needsOpen?: boolean }> {
    const e = this.entries.get(modelId)
    if (!e)
      return { ok: false, reason: '这个网页当前没在运行（实例未创建或已按内存预算回收）', needsOpen: true }
    const wc = e.view.webContents
    if (wc.isDestroyed()) return { ok: false, reason: '页面实例已销毁', needsOpen: true }
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
   * 重建实例：销毁当前 WebContents，按同一分区新建一个并从入口重新加载。
   *
   * 与 reload() 的分工：reload 保住用户当前停留的那一页，只是把这份文档重载一遍；
   * 卡死的如果是 WebContents 本身（渲染进程崩了、站点把导航锁死、登录窗口写进了
   * cookie 而这份文档始终不认），reload 也救不回来，只能换掉实例。
   *
   * 登录态不丢：凭据在 persist: 分区里，与实例生命周期无关。代价是回到站点入口页，
   * 所以它是视图表头的第二颗按钮，不并进刷新。
   */
  recreate(modelId: string): { ok: boolean; reason?: string; needsOpen?: boolean } {
    const e = this.entries.get(modelId)
    if (!e)
      return { ok: false, reason: '这个网页当前没在运行（实例未创建或已按内存预算回收）', needsOpen: true }
    const { adapter, partition, lastPresentBounds } = e
    this.disposeEntry(modelId)
    // ensure 会把它先挂回隐藏宿主并从入口导航
    this.ensure(modelId, adapter, partition)
    /*
     * 换掉整个 WebContents 之后，界面那边不会有任何尺寸变化 —— 它的逐帧贴合只看矩形，
     * 矩形没变就再也不发第二次 present。于是新实例一直待在屏幕外的宿主里：
     * 用户拿到一句「已重建」，看到的还是那片白。这里照着上一次贴好的矩形补一次。
     * renav:false —— 刚发的导航还在跑，别再打断它。
     */
    if (lastPresentBounds) this.present(modelId, lastPresentBounds, { renav: false })
    return { ok: true }
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

    /*
     * Google 的「此浏览器或应用可能不安全」页：它同样落在 signin 路径下，
     * 但结论完全不同 —— 一个是「还没登」，一个是「登不了，而且重试也没用」。
     * 把两者混成一句「页面被重定向到登录页」，用户会一直点、一直撞同一堵墙。
     */
    if (isGoogleSignInRejected(url)) {
      return {
        state: 'logged-out',
        reason:
          'Google 判定当前浏览器不安全，这次登录被直接拒了。Torra 已把 UA、Sec-CH-UA 客户端提示与页面指纹都伪装成 Chrome，仍被拒说明 Google 认出了非官方构建：先点表头「重建实例」再登一次；反复被拒就改走 API 接入的模型。',
        url,
        tokenKeys: [],
        evidence: { onLoginPage: true, hasUserFlag: false, hasLoginCta: false, allLocalKeys: [] },
      }
    }

    // 落在登录/注册页是决定性证据，无需再看 DOM
    if (isLoginPageUrl(url)) {
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
   * 只在周期清扫里跑，不在 ensure() 里跑 —— 创建后立刻查预算会误杀，见那里的注释。
   *
   * 两条硬约束，缺一个就会出现「模型被无故标记缺席」：
   *
   * 1. **绝不回收刚创建的实例**。预热循环里的实例彼此创建时间接近，
   *    按时间排序会随机被选中 —— 结果是发言时必然报「WebView 未初始化」。
   *    故引入 notBefore 作为保护期。
   * 2. **只回收未被使用的实例**。attached（用户正在看）、busy（一轮生成占着）、
   *    或刚被 ensure/present 触及的跳过。
   *
   * 被回收的实例下次用到时会由 ensure() 重建；partition 数据保留，
   * 登录态不丢（登录凭据在 session 层，与 WebContents 实例生命周期无关）。
   */
  private enforceMemoryBudget(): void {
    const report = this.memoryReport()
    if (report.totalMb <= this.opts.memoryBudgetMb) return

    const byId = new Map(report.models.map((m) => [m.modelId, m.mb]))
    const plan = planEvictions({
      entries: this.snapshotEntries(),
      totalMb: report.totalMb,
      budgetMb: this.opts.memoryBudgetMb,
      // 量不到的那几枚退回保守估值，免得把「量不到」当成「不占」
      mbOf: (e) => byId.get(e.modelId) ?? MB_PER_WEBVIEW,
      // 保护期：本次 ensure() 之前 15 秒内创建/使用过的实例一律不回收
      protectAfter: Date.now() - 15_000,
    })
    for (const id of plan.evict) this.disposeEntry(id)
    // 落一条埋点：「内存怎么降下来的」与「谁被牺牲了」都要能在日志里对上
    if (plan.evict.length > 0) {
      diag.log({
        ts: Date.now(),
        layer: 'runtime',
        stage: 'memory:evict',
        detail: `超预算回收 ${plan.evict.join('、')}（实测 ${report.totalMb}MB / 预算 ${this.opts.memoryBudgetMb}MB）`,
      })
    }
  }

  /**
   * 把入口表投影成纯函数层能吃的形状（见 pool-memory.ts）。
   * `isLoading()` 在实例刚销毁的竞态里会抛，这里一律按「没在加载」处理。
   */
  private snapshotEntries(): Evictable[] {
    return [...this.entries.values()].map((e) => ({
      modelId: e.modelId,
      lastUsedAt: e.lastUsedAt,
      attached: e.attached,
      busy: e.busy,
      suspended: e.suspended,
      loading: this.isLoading(e),
      pinned: e.pinned,
    }))
  }

  /**
   * 声明式保活名单：渲染层报上来的「这一场点名的网页参与者」。
   *
   * 它和 PoolEntry.pinned 不是一回事，必须分开存：
   * - 顺序：渲染层先在参与者里选中一家，那家的实例才由 present/投递走 ensure() 造出来。
   *   只按现存实例算的话，这一选恰好发生在实例不存在的那一刻 —— 名单落了空，
   *   三分钟后空闲清扫把这枚建早了的实例拆掉，用户点回来是一页重载过的站点，
   *   上一场对话没了。这正是「参与者全保活」要防的事，却被创建顺序咬了一口。
   * - 生命周期：实例被回收后 ensure() 会重建一枚新的。保活说的是「这家在场」，
   *   不是「这枚进程别死」，所以重建的那一枚要自动接着保活，而不是等渲染层再报一次。
   */
  private declaredPinned = new Set<string>()

  /**
   * 整批设置「保活名单」= 原生墙这一场的网页参与者（含没挂上、住在标签条里的那几枚）。
   *
   * 为什么由渲染层报而不是主进程自己推：只有界面知道哪几枚是用户点名要同时在场的。
   * 主进程看得见 attached（贴在窗口上的那几格），可候补那几枚恰恰不 attached ——
   * 而它们正是被常驻上限和空闲清扫拆掉的那一批。
   *
   * 整批替换（不是增量）：切回提取模式或退出参与者时传空数组就能干净地放开，
   * 不留「上一场的参与者至今还在保活」这种隐性内存占用。
   *
   * 返回值是「实例上真的动了的那些」，不是名单长度：两者在首报时故意不同 ——
   * 名单可以先记下来，实例还没生出来，那几枚要等 ensure() 自己认领。
   */
  setPinned(ids: readonly string[]): string[] {
    this.declaredPinned = new Set(ids)
    const changed: string[] = []
    for (const [modelId, e] of this.entries) {
      const on = this.declaredPinned.has(modelId)
      if (on === Boolean(e.pinned)) continue
      e.pinned = on || undefined
      changed.push(modelId)
    }
    return changed
  }

  /** 当前在册的保活实例（给内存面板与体检读） */
  pinnedIds(): string[] {
    return [...this.entries.values()].filter((e) => e.pinned).map((e) => e.modelId)
  }

  /** 声明式名单（还没实例化的那几家也在里面） */
  declaredPinnedIds(): string[] {
    return [...this.declaredPinned]
  }

  private isLoading(e: PoolEntry): boolean {
    try {
      return e.view.webContents.isLoading()
    } catch {
      return false
    }
  }

  /** 进程 pid → 实测工作集（MB）。取不到返回 null，由调用方退回保守估值 */
  private appMetricsByPid(): Map<number, number> | null {
    try {
      const map = new Map<number, number>()
      for (const m of app.getAppMetrics()) {
        // workingSetSize 的单位是 KB
        const mb = Math.round((m.memory?.workingSetSize ?? 0) / 1024)
        if (mb > 0) map.set(m.pid, mb)
      }
      return map.size > 0 ? map : null
    } catch {
      return null
    }
  }

  /**
   * 池子的内存实况。
   *
   * 每枚实例是一个完整 Chromium 渲染进程，只有主进程能报出它们的真实占用 ——
   * 这是把「1.5GB 到底花在哪」说清楚、也是让预算回收真的能触发的前提。
   * 渲染进程尚未起、或内核报不出时，那一枚按 MB_PER_WEBVIEW 保守估值补进总数。
   */
  memoryReport(): {
    totalMb: number
    count: number
    measured: boolean
    models: Array<{ modelId: string; mb: number | null; pinned: boolean; attached: boolean }>
  } {
    const metrics = this.appMetricsByPid()
    const models = [...this.entries.values()].map((e) => {
      let pid = 0
      try {
        pid = e.view.webContents.getOSProcessId()
      } catch {
        pid = 0
      }
      const mb = pid > 0 && metrics ? metrics.get(pid) ?? null : null
      /*
       * 把「为什么这一枚还在」一起报出去：常驻枚数早就不是上限了（原生墙整批保活），
       * 性能面板若只写 MB，用户看到「7 枚常驻」会以为闸门坏了。
       * pinned = 这一场的参与者，主动保活；attached = 此刻贴在窗口上的那一格。
       */
      return { modelId: e.modelId, mb, pinned: Boolean(e.pinned), attached: e.attached }
    })
    const measuredTotal = models.reduce((acc, m) => acc + (m.mb ?? 0), 0)
    const unmeasured = models.filter((m) => m.mb === null).length
    return {
      totalMb: measuredTotal + unmeasured * MB_PER_WEBVIEW,
      count: models.length,
      measured: models.length > 0 && unmeasured === 0,
      models,
    }
  }

  /**
   * 销毁一个实例（登录态不丢，partition 数据保留）。
   *
   * 拆掉的如果是保活实例，必须让界面知道：那一格从此没有内容可贴，
   * 而用户刚点它进墙就会看到站点重新落地的那一页 —— 上一场对话当场没了。
   * 这正是这次改动要消灭的「静默刷新」，所以回收的那一刻就把 modelId 推给渲染层，
   * 由它在标签上写明「已回收 · 点击重新加载」。
   */
  disposeEntry(modelId: string): void {
    const e = this.entries.get(modelId)
    if (!e) return
    const wasPinned = Boolean(e.pinned)
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
    if (wasPinned) this.notifyRecycled(modelId)
  }

  /** 保活实例被回收 → 推给渲染层（只有用户点名要在场的这几枚值得当场说一声） */
  private notifyRecycled(modelId: string): void {
    if (!this.win || this.win.isDestroyed()) return
    try {
      this.win.webContents.send('webview:recycled', { modelId })
    } catch {
      /* 渲染层还没就绪：这一句是提示，实例已经真的没了，功能不受影响 */
    }
  }

  /**
   * 按常驻枚数上限裁剪（见 DEFAULT_MAX_WARM_INSTANCES）。
   *
   * 与 enforceMemoryBudget 是两条互补的线：MB 预算管「别超总盘子」，
   * 枚数上限管「别把不活跃的都留着」—— 实测单枚 120~500MB，光按 MB 挤
   * 容易挤掉几枚小的、留下一枚大的。attached / busy / loading / pinned 不占名额也不被裁。
   *
   * 上限因此重新变回「后台」上限：以前一场 6 路聊天会把 3 枚的额度全占满，
   * 于是墙上那几枚候补在用户眼皮底下被拆掉、点回来就是重载过的页面。
   */
  trimToWarmLimit(limit = DEFAULT_MAX_WARM_INSTANCES, ignorePinned = false): string[] {
    const evict = planLimit({
      entries: this.snapshotEntries(),
      limit,
      // 与 LRU 回收共用 15 秒保护期：刚 ensure()/刚用过的那几枚不该被这一轮裁掉
      protectAfter: Date.now() - 15_000,
      ignorePinned,
    })
    for (const id of evict) this.disposeEntry(id)
    if (evict.length > 0) {
      diag.log({
        ts: Date.now(),
        layer: 'runtime',
        stage: 'memory:trim',
        detail:
          `按常驻上限 ${limit} 枚裁剪${ignorePinned ? '（系统内存吃紧，连保活一起放）' : ''}：` +
          `回收 ${evict.join('、')}`,
      })
    }
    return evict
  }

  /**
   * 系统内存吃紧时的紧急释放：把后台实例全部拆掉，只留正在看的/在跑的。
   * 调用方必须确认没有讨论在跑（attach/busy 的保护只是兜底，不该依赖它）。
   *
   * 这是唯一会动 pinned 的那一条路 —— 系统只剩几百 MB 时，
   * 「保活」和「整机卡到交换区」只能选一个，选后者对用户更糟。
   */
  relievePressure(): string[] {
    return this.trimToWarmLimit(0, true)
  }

  /**
   * 手动释放指定的空闲实例（设置页内存面板的单枚「释放」）。
   * 正在看 / 正在跑 / 还在加载的返回 false —— 释放它们等于当场白屏或把这路判缺席，
   * 与堆积几百 MB 相比不值得。
   */
  releaseIdle(modelId: string): boolean {
    const e = this.entries.get(modelId)
    if (!e) return false
    if (e.attached || e.busy || this.isLoading(e)) return false
    this.disposeEntry(modelId)
    return true
  }

  /**
   * 挂起 / 恢复一个实例的后台节流。
   *
   * 空闲实例继续跑 rAF 与定时器，就是在为没有人在看的页面烧 CPU；
   * 但两种实例不能挂：正被用户看着的（attached，节流会让他觉得站点变卡）、
   * 还在加载的（节流会把 onload 拖到看不见）。
   */
  markSuspended(modelId: string, suspended: boolean): void {
    const e = this.entries.get(modelId)
    if (!e) return
    if (suspended && (e.attached || e.busy || e.view.webContents.isLoading())) return
    e.view.webContents.setBackgroundThrottling(suspended)
    /*
     * 后台实例一并静音：没人看的页面还在解码音频（TTS 语音回复、站点的提示音）
     * 就是白占内存与 CPU。用户点开某一枚（present）时立刻恢复出声 ——
     * 静音只挂在「后台且空闲」这一个状态上。
     */
    e.view.webContents.setAudioMuted(suspended)
    e.suspended = suspended
    if (!suspended) e.lastUsedAt = Date.now()
  }

  /**
   * 一轮生成的占用标记。网页通道在 send 开始时解除挂起、结束时登记忙闲，
   * 挂起与 LRU 才有「这枚现在不能碰」的依据。
   */
  setBusy(modelId: string, busy: boolean): void {
    const e = this.entries.get(modelId)
    if (!e) return
    e.busy = busy
    if (!busy) e.lastUsedAt = Date.now()
  }

  /**
   * 周期清扫：空闲到点的实例挂起，内存超预算的按 LRU 挤出。
   * 返回挂起名单只为体检能说明「这一路为什么慢」，不为日志而日志。
   *
   * `canEvict()` 只掐回收，不掐挂起。理由：一场讨论里轮转到某个模型之前，它可能整几分钟
   * 没被碰过，LRU 只看 15 秒保护期，于是「上一轮用完的」正好都在回收名单里；把它挤掉，
   * 下一轮就得重建视图 + 重新导航，而站点重新落地时读到的往往是上一场对话的最后一条 ——
   * 把旧答案当成本轮新回答，比多占 250MB 贵得多。挂起没这个风险，随时可以解开。
   *
   * 回收因此分两级：空闲够久（disposeIdleMs）才拆实例 —— 这是真正把内存还给系统的
   * 那一步；超预算则按实测占用做 LRU 挤人。两者都由 canEvict 统一掐断。
   */
  sweepIdle(idleMs: number, canEvict = true, disposeIdleMs = DEFAULT_IDLE_DISPOSE_MS): string[] {
    const plan = planIdle({
      entries: this.snapshotEntries(),
      now: Date.now(),
      idleMs,
      // 讨论进行中（canEvict=false）只挂起不拆实例 —— 见上面这段的理由
      disposeIdleMs: canEvict ? disposeIdleMs : 0,
    })
    for (const id of plan.dispose) this.disposeEntry(id)
    for (const id of plan.suspend) this.markSuspended(id, true)
    if (canEvict) this.enforceMemoryBudget()
    // 常驻枚数上限：超预算回收之后再按枚数裁一刀（幂等，散场时也会单独调用）
    if (canEvict) this.trimToWarmLimit()
    return plan.suspend
  }

  /**
   * 空闲清扫的启动：没起定时器时 sweepIdle 只是给体检用的纯入口。
   * `busy()` 为真（讨论在跑）时只做挂起，不做回收 —— 见 sweepIdle 的说明。
   */
  startIdleSweeper(
    intervalMs = 60_000,
    idleMs = 3 * 60_000,
    busy: () => boolean = () => false,
    disposeIdleMs = DEFAULT_IDLE_DISPOSE_MS,
  ): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweepIdle(idleMs, !busy(), disposeIdleMs), intervalMs)
    // 清扫不该单独把进程留在世上
    this.sweeper.unref?.()
  }

  /**
   * 当前内存占用（MB）：有实测用实测，量不到才退回 MB_PER_WEBVIEW 估值。
   * 零实例时返回 0（不留 250MB 的幽灵占用）。
   */
  estimateMemoryMb(): number {
    return this.memoryReport().totalMb
  }

  listModelIds(): string[] {
    return [...this.entries.keys()]
  }

  disposeAll(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }
    for (const id of [...this.entries.keys()]) this.disposeEntry(id)
    this.disposeHost()
  }
}
