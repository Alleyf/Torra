/**
 * 「曾经是用户自建、现在是内置」的站点迁移规则 —— 纯函数，不碰 Electron。
 *
 * 元宝（web-custom-2）与灵光（web-custom-3）原先由用户自建：模型条目在 models.json、
 * 适配器 YAML 在 userData/adapters、登录态在 `persist:torra-user-web-custom-N`。
 * 收成内置之后 id 与分区都变了，不搬就会看到两个「灵光」，而且**登录态看起来丢了**
 * （内置条目读新分区，那里什么都没有）。
 *
 * 搬什么、怎么搬的规则放这里，是因为它最该被测试钉住，而主进程那一侧离不开
 * Electron 运行时。实际调 session API 的胶水留在 src/main/index.ts。
 */

/** 一条旧条目 → 新条目的对应 */
export interface LegacyModelMapping {
  /** 旧的用户自建 id（同时是旧 YAML 文件名与旧分区后缀） */
  from: string
  /** 内置条目的 id（分区是 `persist:torra-<to>`） */
  to: string
}

export const LEGACY_WEB_MODELS: readonly LegacyModelMapping[] = [
  { from: 'web-custom-2', to: 'yuanbao' },
  { from: 'web-custom-3', to: 'lingguang' },
]

export const legacyIds = (): Set<string> => new Set(LEGACY_WEB_MODELS.map((x) => x.from))

/** 旧分区名 */
export const legacyPartition = (from: string): string => `persist:torra-user-${from}`
/** 内置条目读的分区名 */
export const builtinPartition = (to: string): string => `persist:torra-${to}`

/**
 * 从 models.json 那一份列表里摘掉旧条目，其余原样保留。
 *
 * 只按 id 认，不按 displayName：用户可能改过显示名（「灵光」改成「灵光 Pro」），
 * 但 id 是落盘键，改不了。返回新数组，不改入参。
 */
export function dropLegacyModels<T extends { id?: unknown }>(list: readonly T[]): T[] {
  const dead = legacyIds()
  return list.filter((m) => !(m && typeof m.id === 'string' && dead.has(m.id)))
}

/** 这份列表里有没有需要迁移的旧条目 */
export function hasLegacyModels(list: readonly { id?: unknown }[]): boolean {
  const dead = legacyIds()
  return list.some((m) => m && typeof m.id === 'string' && dead.has(m.id))
}

/**
 * cookie 搬运时要重建的那个 url。
 *
 * Chromium 的 `cookies.set` 只认 url + name + value，域与路径从 url 推导；
 * 给错域会被**静默丢掉**（不抛错），所以这一步必须是可测的纯函数。
 *
 * 灵光的登录 cookie 落在 `.lingguang.com`（带前导点）与 `www.lingguang.com`，
 * 两者都要能拼出合法 url —— 前导点在 url 里是非法的，必须剥掉。
 */
export function cookieUrlFor(
  cookie: { domain?: string | null; path?: string | null; secure?: boolean },
): string | null {
  const host = String(cookie.domain ?? '').replace(/^\./, '').trim()
  if (!host) return null
  const p = String(cookie.path ?? '/').trim() || '/'
  return `${cookie.secure ? 'https' : 'http'}://${host}${p.startsWith('/') ? p : `/${p}`}`
}
