/**
 * 更新流程的状态投影层。
 *
 * 和 argmap 一样放在 shared：主进程是状态的唯一生产者，渲染层只画拿到的那一格。
 * 「查得到 / 查不到 / 下好了 / 装不了」这些判断只在这一份里写一遍，界面不许从阶段
 * 之外自己推断 —— 否则会出现「按钮写着重试、旁边的说明写着已是最新」。
 * 这个文件不 import electron，reducer 与解释函数都是纯函数，脱机就能测。
 */

export type UpdatePhase =
  | 'idle'
  | 'checking'
  /** 有新版本，还没下载，等用户点「下载」 */
  | 'available'
  | 'downloading'
  /** 安装包已经在本地，只差重启 */
  | 'ready'
  /** 查过了，没有更新 */
  | 'latest'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** 本机正在跑的版本，来自 app.getVersion() */
  current: string
  /** 要升去的那个版本；没查到或已是最新时为 null */
  latest: string | null
  /** 0–100 */
  percent: number
  transferred: number | null
  total: number | null
  /** 永远是一句人话：结论、进度或失败原因 */
  note: string
  /** 最近一次「检查」动作的时刻（epoch ms）；null = 这一场还没查过 */
  checkedAt: number | null
  /** 这一台机器能不能走自动升级 */
  canAutoUpdate: boolean
  /** 不能的话，为什么 —— 直说，不装作按钮还能点 */
  blockedReason: string | null
}

export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; percent: number; transferred: number | null; total: number | null }
  | { type: 'downloaded' }
  | { type: 'error'; stage: 'check' | 'download'; message: string }

export interface UpdateEnv {
  /** app.isPackaged：dev 跑的是 dist/ 里的代码，没有可被替换的安装包 */
  packaged: boolean
  /** 便携版宿主启动子进程时注入这个变量，指回 exe 所在目录 */
  portable: boolean
  version: string
}

/**
 * 这一台能不能自动升级，不能的话为什么。返回 null 表示可以。
 *
 * 两条都不是「等会儿重试就好」的临时故障，而是这类型安装不具备的条件，
 * 所以要把代价说清楚（重装 / 手动覆盖），而不是含糊地报一句「不支持」。
 */
export function updateBlockReason(env: UpdateEnv): string | null {
  if (!env.packaged) {
    return '现在跑的是开发构建，本机没有可被替换的安装包，检查不了更新。'
  }
  if (env.portable) {
    return '便携版不能原地升级：请到发布页下载新的 Torra-Portable-*.exe，用它覆盖这个文件。'
  }
  return null
}

export function initialUpdateState(env: UpdateEnv): UpdateState {
  const reason = updateBlockReason(env)
  return {
    phase: 'idle',
    current: env.version,
    latest: null,
    percent: 0,
    transferred: null,
    total: null,
    note: reason ?? '还没检查过。',
    checkedAt: null,
    canAutoUpdate: reason === null,
    blockedReason: reason,
  }
}

export function reduceUpdate(state: UpdateState, ev: UpdateEvent, now: number): UpdateState {
  switch (ev.type) {
    case 'checking':
      return {
        ...state,
        phase: 'checking',
        latest: null,
        percent: 0,
        transferred: null,
        total: null,
        note: '正在检查更新…',
        checkedAt: now,
      }
    case 'available':
      return {
        ...state,
        phase: 'available',
        latest: ev.version,
        percent: 0,
        note: `发现新版本 v${ev.version}（当前 v${state.current}）。下载不会关掉应用，装的时候才要重启。`,
        checkedAt: now,
      }
    case 'not-available':
      return {
        ...state,
        phase: 'latest',
        latest: null,
        note: `已经是最新的了（v${ev.version}）。`,
        checkedAt: now,
      }
    case 'progress':
      return {
        ...state,
        phase: 'downloading',
        percent: clampPercent(ev.percent),
        transferred: ev.transferred,
        total: ev.total,
        note: `正在下载 v${state.latest ?? '新版本'}…`,
      }
    case 'downloaded':
      return {
        ...state,
        phase: 'ready',
        percent: 100,
        note: '安装包已就绪。点「重启并安装」会关掉应用，装完自动再打开。',
      }
    case 'error': {
      // 失败不留在旧阶段上：note 和按钮同一帧更新，两者必须指向同一个结论
      const failedMidDownload = state.phase === 'downloading'
      return {
        ...state,
        phase: 'error',
        percent: failedMidDownload ? state.percent : 0,
        note: explainUpdateError(ev.message, ev.stage),
        checkedAt: state.checkedAt ?? now,
      }
    }
  }
}

function clampPercent(v: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 0)))
}

/**
 * 把 electron-updater 抛出的原文翻成人话。
 *
 * 为什么不能只贴原文：它给的是 `Unknown: 404 Not Found`、`Cannot find latest.yml`
 * 这类 feed 那一侧的话，用户看完只知道「失败了」，不知道下一步做什么。
 * 认不出来的一律原文照登 —— 猜一个「网络问题」比不猜更糟。
 */
export function explainUpdateError(message: string, stage: 'check' | 'download'): string {
  const raw = (message ?? '').trim()
  const lower = raw.toLowerCase()
  if (!lower) return stage === 'download' ? '下载失败了，原因未知，可以再试一次。' : '检查更新失败了，原因未知。'

  // 这一条是本应用当前真实存在的状态：自动升级从下一个带 latest.yml 的发布起才可用
  if (lower.includes('latest.yml') || lower.includes('no published') || lower.includes('no files')) {
    return '这个版本之前发布的包没带更新信息，应用内查不到。先手动下载一次新版本 —— 从带更新信息的那次发布起，这里就能自动检查了。'
  }
  if (lower.includes('404') || lower.includes('not found')) {
    return '更新源上找不到这个应用的发布记录。可能是发布还没完成，或者发布的位置变了；先去发布页确认一下。'
  }
  if (
    lower.includes('err_conn') ||
    lower.includes('err_name') ||
    lower.includes('err_timed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('getaddrinfo') ||
    lower.includes('network')
  ) {
    return stage === 'download'
      ? '下载中断了：连不上更新源。检查网络之后可以重新下载，已经下过的部分不会白下。'
      : '连不上更新源。检查网络，或者稍后再试。'
  }
  if (lower.includes('certificate') || lower.includes('self-signed') || lower.includes('unable to verify')) {
    return '更新源的证书没通过校验。公司网络做中间人解密时会这样 —— 不是安装包有问题，换个网络再试。'
  }
  if (lower.includes('eperm') || lower.includes('eacces') || lower.includes('ebusy') || lower.includes('locked')) {
    return '安装文件写不进去：Torra 正被别的程序占用（杀毒软件，或者旧窗口没关完）。关掉之后重试。'
  }
  return `更新失败：${raw}`
}

/** 字节数成人话；未知返回 null，由调用方决定是省略还是写「未知」 */
export function formatBytes(n: number | null): string | null {
  if (n === null || !Number.isFinite(n) || n < 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/**
 * 「关于」这一格要的本机事实，全部由主进程给出：版本要从打包元数据读，
 * 数据目录是 app.getPath 的结果（渲染层连绝对路径都拿不到）。
 *
 * 只给界面真要用、且用户用得上的那几项。运行时版本（Electron / Chromium / Node）、
 * 操作系统、依赖与许可证清单这类排查用的事实归「诊断」，从这条通道传过去早晚会被画到界面上。
 * dataDir 不作为文字展示，只用来决定「打开数据目录」这一格能不能点。
 */
export interface AboutInfo {
  version: string
  dataDir: string
  packaged: boolean
  portable: boolean
}
