/**
 * 认证 cookie 的识别与有效期汇总 —— 纯函数，不碰 Electron。
 *
 * 为什么单独成文件：这段判定是「模型还能用多久」的唯一口径，状态灯、Cookie 面板、
 * 体检三处都读它。放在 pool.ts 里就没法离线测（真实分区要 Electron 运行时），
 * 而恰恰是最该被测试钉住的那种启发式判定。
 *
 * 站点各自用什么 cookie 表示登录并不统一，因此用启发式。
 * 误判代价极低：漏判会在用到时补建，错判只是多预热一个实例。
 * 但仍须排除「像认证、实则不是」的 cookie —— 实测踩过的坑：
 *   claude.ai/__ssid                    Cloudflare 会话 ID，所有访客都有
 *   kimi.com/next-sidebar-entry-order    界面偏好，未登录也存在
 * 反过来，跨站通用的强信号（access/id/refresh token、passport、
 * session token、sid）几乎只在真正登录后才写入。
 */

// DeepSeek uses `ds_session_id` for its chat session. Keep this explicit rather
// than accepting every `*_session_id`, many of which are anonymous analytics
// cookies and would cause needless WebView prewarming.
const AUTH_COOKIE_RE = /access_?token|id_?token|refresh_?token|session_?token|auth_?token|passport(?!_csrf)|sso|sid$|^sid|credential|bearer|jwt|oai-client-auth-info|next-auth|^ds_session_id$/i

/**
 * 明确排除：这些 cookie 名字看着像认证，实际在未登录时也存在。
 * 命中它们不构成「已登录」证据。
 */
const NOT_AUTH_COOKIE_RE = /__ssid|__cf_bm|cf_clearance|__cflb|passport_csrf|bd_sso|theme|locale|lang|width|order|entry|dark|smid|thumbcache|_ga|_gid|abtest|experiment|sidebar|hwwafsesid|wafsess/i

/** 参与判定的一条认证 cookie：只留名字、域和到期时刻，值不外传 */
export interface AuthCookie {
  name: string
  domain: string
  /** epoch 秒；0 = 会话级（浏览器进程退出就没了，站点本来也没给到期时间） */
  exp: number
}

export interface CredentialExpiry {
  /** 算作认证证据的 cookie 条数 */
  authCookies: number
  /** 最早到期的那一条；一条带到期时间的都没有时为 undefined */
  earliest?: AuthCookie
  /** 有认证 cookie，但全都没有到期时间 —— 「还能用多久」问不出答案 */
  sessionOnly: boolean
}

/**
 * 从分区里全部 cookie 中挑出「属于这个 host 且算认证证据」的那些，并汇总有效期。
 *
 * 有效期只算这一份：状态灯、Cookie 面板和体检回答的是同一个问题，各算各的就会出现
 * 「界面上剩 20 天、体检里即将过期」，用户无从判断该信谁。
 */
export function summarizeAuthCookies<
  T extends { name?: unknown; domain?: unknown; value?: unknown; expirationDate?: unknown },
>(cookies: readonly T[], host: string): { auth: AuthCookie[]; expiry: CredentialExpiry } {
  const wantHost = host.replace(/^www\./, '')
  const auth: AuthCookie[] = []
  for (const c of cookies) {
    // www 两侧都剥掉：入口写 www.kimi.com 时凭据可能落在 kimi.com，反之亦然。
    // 只剥一侧会把这类站点整个判成「未登录」（实测 Kimi 就栽在这里）。
    const domain = String(c.domain ?? '').replace(/^\./, '').replace(/^www\./, '')
    // 浏览器把 cookie 发到页面 host 的条件：host 等于 cookie 域，或 host 是该域的子域
    // （cookie 可设在 .qwen.ai 这类父域上，实际会随 chat.qwen.ai 一起发出）。
    // 旧逻辑只判 domain.endsWith(host)，会漏掉父域上的认证 cookie ——
    // 通义千问的 refresh_token 正落在 .qwen.ai，导致登录后仍判不出。
    if (!(domain === wantHost || wantHost.endsWith(`.${domain}`))) continue
    const name = String(c.name ?? '')
    if (NOT_AUTH_COOKIE_RE.test(name)) continue
    // 带值的才算（存在但为空的壳 cookie 无意义）
    if (String(c.value ?? '').length <= 8) continue
    if (!AUTH_COOKIE_RE.test(name)) continue
    const raw = Number(c.expirationDate)
    auth.push({ name, domain, exp: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0 })
  }
  const dated = auth.filter((c) => c.exp > 0).sort((a, b) => a.exp - b.exp)
  return {
    auth,
    expiry: {
      authCookies: auth.length,
      ...(dated[0] ? { earliest: dated[0] } : {}),
      sessionOnly: auth.length > 0 && dated.length === 0,
    },
  }
}
