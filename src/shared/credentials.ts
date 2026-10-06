/**
 * 认证 cookie 剩余有效期的展示口径。
 *
 * 为什么单独成一个模块：模型栏、Cookie 面板、体检三处都要回答同一个问题
 * （「这份登录还能用多久」），各写一遍必然漂移成三种说法。
 *
 * 一条不能省的约束：**这是提示，不是倒计时**。
 * cookie 上的到期时间是站点签发时写死的，既不保证到点才失效（服务端可以提前注销），
 * 也不保证失效即登出（有些站点靠续期 cookie 维持会话）。所以文案要说清依据，
 * 不能做成一根看着很确定的进度条。
 */

/** 与主进程 CredentialExpiry 对应的展示输入（渲染层拿不到 cookie 本身） */
export interface CredExpiryInput {
  /** 最早到期的认证 cookie 时间（epoch ms）；没有带到期时间的认证 cookie 时为空 */
  expiresAt?: number
  /** 这个到期时间来自哪个 cookie 名 */
  expiresCookie?: string
  /** 有认证 cookie，但站点没给任何到期时间（会话级） */
  sessionOnly?: boolean
}

export type CredTone = 'ok' | 'warn' | 'muted'

export interface CredHint {
  /** 完整文案，用于 Cookie 面板这类空间充裕的地方 */
  text: string
  /** 去掉「凭据」前缀的短文案，用于模型栏这类一行只有几十字符的地方 */
  short: string
  /** 悬停说明：说清依据与局限 */
  title: string
  tone: CredTone
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** 一天多一点以内就提醒：一场长讨论跑到后半程时掉登录，已经花掉的时间会整轮作废 */
const SOON = 36 * HOUR

function fmtLocal(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatRemaining(remainMs: number): string {
  const r = Math.abs(remainMs)
  if (r < HOUR) return `${Math.max(1, Math.round(r / MIN))} 分钟`
  if (r < DAY) return `${Math.max(1, Math.round(r / HOUR))} 小时`
  return `${Math.floor(r / DAY)} 天`
}

/**
 * 逐条 cookie 的到期文案（Cookie 面板展开区用）。
 * 入参一律是**毫秒**：Electron 的 expirationDate 是秒，主进程在跨界前已换算，
 * 面板里传进来的 exp 若是秒，请在调用处显式 *1000 —— 单位混用是这类倒计时最典型的错。
 */
export function cookieExpireText(expiresAtMs: number, now = Date.now()): { text: string; tone: CredTone } {
  if (!(expiresAtMs > 0)) return { text: '会话级', tone: 'muted' }
  const remain = expiresAtMs - now
  if (remain <= 0) return { text: `已过期 ${formatRemaining(remain)}`, tone: 'warn' }
  return { text: `剩 ${formatRemaining(remain)}`, tone: remain < SOON ? 'warn' : 'ok' }
}

/**
 * 把有效期折成一句人话。没有任何认证 cookie 时返回 null ——
 * 未登录的模型不该出现「剩 N 天」这种字样。
 */
export function credentialHint(input: CredExpiryInput | undefined, now = Date.now()): CredHint | null {
  const exp = input?.expiresAt ?? 0
  const cookie = input?.expiresCookie
  if (exp > 0) {
    const remain = exp - now
    const basis = `依据认证 cookie「${cookie || '未命名'}」上的到期时间 ${fmtLocal(exp)}`
    if (remain <= 0) {
      return { text: '凭据已过期', short: '已过期', title: `${basis}，已过期 ${formatRemaining(remain)}。站点可能仍在宽限，但随时会掉，建议尽快重新登录续期`, tone: 'warn' }
    }
    const left = formatRemaining(remain)
    const title = `${basis}，还剩 ${left}。这是 cookie 上写的到期时间：站点可能提前注销，也可能靠续期拖后`
    if (remain < SOON) return { text: `凭据剩 ${left}`, short: left, title, tone: 'warn' }
    return { text: `凭据剩 ${left}`, short: left, title, tone: 'ok' }
  }
  if (input?.sessionOnly) {
    return {
      text: '凭据会话级',
      short: '会话级',
      title: '站点没有给认证 cookie 设到期时间：关闭登录窗（会话结束）通常就失效，问不出还剩多久',
      tone: 'muted',
    }
  }
  return null
}
