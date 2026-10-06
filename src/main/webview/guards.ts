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

/** 登录窗口的 webContents id → 已用掉的应用内弹窗数 */
const loginWindows = new Map<number, { used: number }>()

/**
 * 一枚登录窗口最多能在应用内开几枚弹窗。
 * OAuth 常见一枚，个别站点多一步授权确认，所以留两枚；再多就只能走系统浏览器。
 */
export const LOGIN_POPUP_BUDGET = 2

export function markLoginWindow(id: number): void {
  loginWindows.set(id, { used: 0 })
}

export function releaseLoginWindow(id: number): void {
  loginWindows.delete(id)
}

export function isLoginWindow(id: number): boolean {
  return loginWindows.has(id)
}

/**
 * 取用一次「应用内开窗」额度，成功返回第几枚（从 1 起），否则返回 null。
 *
 * 例外不能按整窗无限放行：登录窗口里嵌的每一个页面（站点自己的跳转、第三方登录按钮、
 * 甚至一个广告 iframe）都能刷出一串临时窗口，顶着 Torra 开的外壳、带着同一分区的登录态
 * 显示钓鱼内容。额度用尽后按普通站点处理 —— 登录流程仍然走得通，只是不再长 Torra 的窗口。
 */
export function claimInAppPopup(id: number): number | null {
  const slot = loginWindows.get(id)
  if (!slot || slot.used >= LOGIN_POPUP_BUDGET) return null
  slot.used += 1
  return slot.used
}

/**
 * 应用内弹窗窗口的标题。
 *
 * 必须钉死且由 Torra 来说话：这类窗口的默认标题来自站点自己的文档，
 * 用户分不清「这是 Torra 给我开的临时登录弹窗」还是「我自己点的链接」，
 * 更不知道该在哪儿关掉它 —— 分不清来源，正是仿冒页要的那层皮。
 */
export function loginPopupTitle(index: number): string {
  return `Torra 登录弹窗（第 ${index} 枚 · 临时窗口，登录完成后可关闭）`
}

/**
 * in-app —— 应用内开子窗（仅登录窗口，且额度未用尽）
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

/**
 * 弹窗留痕。`reason` 用来写「为什么走了这一档」（比如登录窗口的应用内额度已用尽），
 * 同样只允许传固定措辞，不要把 URL 片段塞进去。
 */
export function popupNote(
  disposition: PopupDisposition,
  targetUrl: string,
  openerUrl: string,
  reason?: string,
): string {
  const from = safeHost(openerUrl) || '应用页面'
  const tail = reason ? `（${reason}）` : ''
  if (disposition === 'block') return `${from} 申请开非 http(s) 窗口，已整体挡掉：${targetUrl.slice(0, 80)}`
  const to = safeHost(targetUrl) || '未知站点'
  if (disposition === 'in-app') return `${from} 的登录弹窗放行到应用内：${to}${tail}`
  return `${from} 的弹窗交系统浏览器：${to}${tail}`
}
