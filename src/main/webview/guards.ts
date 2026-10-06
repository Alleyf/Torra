/**
 * 内嵌页面的权限与弹窗判定（纯函数层，不 import electron）
 *
 * 分成两层是为了能被 ts-node 直接测：装 handler 的那几行必须真跑在 Electron 里才验得出来，
 * 而「该不该放」这个判断 —— 尤其是 loginWindow 这个例外、以及 `javascript:`/`data:` 这类
 * 根本不该离开判定层的 URL —— 用纯函数就能钉死。装 handler 的接线见 main/index.ts。
 *
 * 为什么这是必须的：Electron 官方安全文档写明「未自定义 handler 时，权限请求一律自动批准」。
 * 池里跑的是第三方站点自己的页面，于是任何一个站点都能静默拿到通知、麦克风、摄像头、
 * 地理位置，用户既没有提示也没有撤销的出口。
 */

/** 登录窗口的 webContents id：只有它允许在应用内开子窗（OAuth 常以弹窗续接，挡掉就登不进去） */
const loginWindowIds = new Set<number>()

export function markLoginWindow(id: number): void {
  loginWindowIds.add(id)
}

export function releaseLoginWindow(id: number): void {
  loginWindowIds.delete(id)
}

export function isLoginWindow(id: number): boolean {
  return loginWindowIds.has(id)
}

/**
 * in-app —— 应用内开子窗（仅登录窗口）
 * external —— 不在应用内开，交系统浏览器
 * block —— 哪儿都不去（协议本身就不该开窗口）
 */
export type PopupDisposition = 'in-app' | 'external' | 'block'

const OPENABLE = new Set(['http:', 'https:'])

/** 只认能解析、且协议为 http(s) 的 URL；解析失败一律按不可信处理 */
export function isHttpUrl(raw: string): boolean {
  try {
    return OPENABLE.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

export function popupDisposition(url: string, ctx: { loginWindow: boolean }): PopupDisposition {
  if (!isHttpUrl(url)) return 'block'
  return ctx.loginWindow ? 'in-app' : 'external'
}

export function safeHost(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}

/** 拒绝留痕的一行说明。只记名称与主机，绝不把 URL 的 query/hash 抄进日志 —— 那里面常带 token */
export function denyNote(permission: string, requestingUrl: string): string {
  return `${permission} 已拒绝（Torra 不给内嵌站点任何权限）；来源 ${safeHost(requestingUrl) || '未知页面'}`
}

export function popupNote(disposition: PopupDisposition, targetUrl: string, openerUrl: string): string {
  const from = safeHost(openerUrl) || '应用页面'
  if (disposition === 'block') return `${from} 申请开非 http(s) 窗口，已整体挡掉：${targetUrl.slice(0, 80)}`
  const to = safeHost(targetUrl) || '未知站点'
  return disposition === 'in-app' ? `${from} 的登录弹窗放行到应用内：${to}` : `${from} 的弹窗交系统浏览器：${to}`
}
