/**
 * 应用内自动升级（electron-updater / GitHub Releases）
 *
 * 分工与论题演化那套一致：主进程是唯一的状态生产者，渲染层只画拿到的那一格状态，
 * 阶段名与解释文案全部出自 shared/update 这一份 reducer —— 界面不许自己判断
 * 「算不算有新版本」。
 *
 * 三条绕不过去的现实，都在 shared/update 里写成了人话而不是异常码：
 * 1. 安装包没有代码签名，所以必须关掉签名校验，否则 electron-updater 一律拒绝；
 * 2. 便携版和开发构建没有「原地替换」的位置，这两种情况下不假装按钮还能点；
 * 3. 装的是新进程，必须重启才生效 —— 所以下载自动、安装手动。
 */

import { app, shell } from 'electron'
import { autoUpdater, type NsisUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import {
  initialUpdateState,
  reduceUpdate,
  updateBlockReason,
  type UpdateEnv,
  type UpdateEvent,
  type UpdateState,
} from '../../shared/update'

export const RELEASE_REPO = { owner: 'Alleyf', repo: 'Torra' }
export const RELEASE_PAGE = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases`

export interface UpdaterApi {
  state: () => UpdateState
  check: () => Promise<{ ok: boolean; reason?: string }>
  download: () => Promise<{ ok: boolean; reason?: string }>
  install: () => { ok: boolean; reason?: string }
  openReleasePage: () => void
}

export interface UpdaterDeps {
  /** 广播给渲染层；窗口没开时吞掉就行，渲染层挂载时会用 state() 补回来 */
  send: (channel: string, payload: unknown) => void
  /** 诊断日志（可选）：升级失败要能在日志层查到原文 */
  log?: (detail: string) => void
}

/**
 * 建 updater。
 *
 * 可以在模块加载时就建：electron-updater 读 app 的版本号、userData 全在方法里
 * （`out/AppUpdater.js` / `out/ElectronAppAdapter.js` 里没有构造期读取），
 * `app.isPackaged` 与 `app.getVersion()` 也不要求 ready。真正要等 ready 的是 IPC 注册，
 * 那在 index.ts 的 registerIpc() 里。
 */
export function createUpdater(deps: UpdaterDeps): UpdaterApi {
  const env: UpdateEnv = {
    packaged: app.isPackaged,
    // 便携版宿主在启动子进程时注入这个变量，指回 exe 所在目录
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
    version: app.getVersion(),
  }
  let state: UpdateState = initialUpdateState(env)
  const publish = (ev: UpdateEvent) => {
    state = reduceUpdate(state, ev, Date.now())
    deps.send('update:state', state)
  }
  /**
   * 跨调用的状态读取都走这一格。
   *
   * `state` 会在事件回调里被换掉，TS 的属性窄化看不见这件事 —— 直接读会得到
   * 「它一定还是刚才那个阶段」的假结论，编译器还会替这个假结论背书。
   */
  const now = (): UpdateState => state

  /*
   * 没有代码签名（没有证书），所以 Authenticode 那一关必然过不了。
   * v6.8.9 的 setter 忽略 false（`if (value)`），所以要给一个恒通过的函数而不是布尔值 ——
   * 写 `= false` 是个静默无效的动作，看着像关掉了，其实什么都没变。
   * 关掉它不等于没有完整性校验：下载仍然按 latest.yml 里的 sha512 校验，源仍是 HTTPS。
   * 这一项只在 NsisUpdater 上，而 autoUpdater 的公开类型是平台无关的 AppUpdater。
   */
  ;(autoUpdater as unknown as NsisUpdater).verifyUpdateCodeSignature = async () => null
  // 下载不自动：升级包几十 MB，走用户的流量；找到新版本先问一声。
  autoUpdater.autoDownload = false
  // 也不在退出时偷偷装：用户点「重启并安装」才动他的安装目录。
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.setFeedURL({ provider: 'github', ...RELEASE_REPO })

  autoUpdater.on('update-available', (info: UpdateInfo) => publish({ type: 'available', version: info.version }))
  autoUpdater.on('update-not-available', (info: UpdateInfo | null) =>
    publish({ type: 'not-available', version: info?.version ?? env.version }),
  )
  autoUpdater.on('download-progress', (p: ProgressInfo) =>
    publish({
      type: 'progress',
      percent: p.percent,
      transferred: Number.isFinite(p.transferred) ? p.transferred : null,
      total: Number.isFinite(p.total) ? p.total : null,
    }),
  )
  autoUpdater.on('update-downloaded', () => publish({ type: 'downloaded' }))
  autoUpdater.on('error', (err: Error | null) => {
    // 同一次操作的错误既走事件也走 promise rejection：这里落一次，rejection 那边只补日志
    const message = err?.message ?? String(err)
    deps.log?.(`更新失败：${message}`)
    publish({ type: 'error', stage: now().phase === 'downloading' ? 'download' : 'check', message })
  })

  /**
   * 这一身能不能升级。理由已经在 initialUpdateState 里写进 note 和 blockedReason，
   * 所以这里只回答，不再往状态里补一份 —— 两个生产者写同一格 note，早晚对不上。
   * 何况被挡住的构建根本走不到别的阶段：check 是它唯一能按的按钮，一按就被这里退回。
   */
  const blocked = (): string | null => updateBlockReason(env)

  return {
    state: () => state,

    async check() {
      const reason = blocked()
      if (reason) return { ok: false, reason }
      // 立刻进「检查中」：GitHub 的 feed 要走几秒，少了这一格按钮看着就像没反应
      publish({ type: 'checking' })
      try {
        // 用 checkForUpdates 而不是 checkForUpdatesAndNotify：后者发现新版本会
        // 自己开始下载并弹系统通知，而这里的口径是「几十 MB 的流量要用户自己点」。
        await autoUpdater.checkForUpdates()
        return { ok: true }
      } catch (err) {
        // 'error' 事件已经把状态翻译成人话了；这里只把「失败」这件事本身交回去
        return { ok: false, reason: errMessage(err) }
      }
    },

    async download() {
      const reason = blocked()
      if (reason) return { ok: false, reason }
      if (now().phase !== 'available') return { ok: false, reason: '还没有待下载的新版本。' }
      try {
        await autoUpdater.downloadUpdate()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: errMessage(err) }
      }
    },

    install() {
      const reason = blocked()
      if (reason) return { ok: false, reason }
      if (now().phase !== 'ready') return { ok: false, reason: '安装包还没下载完，等它下好再重启。' }
      try {
        // isSilent=false：沿用安装时那个向导，用户看得见装的过程；
        // isForceRunAfter=true：装完自动把应用拉回来，不用他去桌面找图标。
        autoUpdater.quitAndInstall(false, true)
        // quitAndInstall 返回 void，装不成只会发一个 'error' 事件（emit 是同步的，回调已经跑完）。
        // 所以结论要从状态里读，不能假设「没抛异常就是装上并退出了」。
        if (now().phase === 'error') return { ok: false, reason: now().note }
        return { ok: true }
      } catch (err) {
        const message = errMessage(err)
        publish({ type: 'error', stage: 'download', message })
        return { ok: false, reason: message }
      }
    },

    openReleasePage() {
      void shell.openExternal(RELEASE_PAGE).catch(() => undefined)
    },
  }
}

/** rejection 那边给的不一定是 Error（也有字符串、也有 null），原文取出来就好 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}
