/**
 * 把内嵌视图的身份从「Electron 客户端」改写成「一台普通 Chrome」。
 *
 * 触发这件事的现场：Gemini 登录走到 accounts.google.com/v3/signin/rejected，
 * 页面写着「此浏览器或应用可能不安全」。那是 Google 的登录闸门在服务端拒的，
 * 它看的是三处彼此印证的信号，缺一处都会自相矛盾，而矛盾本身就是被拒的理由：
 *
 * 1. `User-Agent`：Electron 默认带 `Electron/x.y.z`，站点据此直接判定这不是浏览器；
 * 2. `Sec-CH-UA` 客户端提示：由构建品牌生成。Electron 是不带 Google 品牌的 Chromium
 *    构建，品牌列表里只有 `Chromium` 与那枚 grease 品牌（`Not?A_Brand` 之类），
 *    **没有 `Google Chrome`**。闸门以这份列表为准 —— 只改 UA 字符串会得到
 *    「UA 说 Chrome、提示说 Chromium」，比不改更容易被拒；
 * 3. `navigator.userAgentData`：页面脚本读到的仍是真实品牌，服务端拿它复核前两项。
 *    这一层必须在任何站点脚本之前跑，所以走 CDP 的 addScriptToEvaluateOnNewDocument
 *    （preload 在隔离世界，够不着主世界的 navigator）。
 *    而「任何站点脚本之前」包含了第一次导航：这条命令只管它**之后**新建的文档，
 *    建完视图就 loadURL 的话，登录页那份文档恰好读不到 Google Chrome 品牌 ——
 *    实测如此，所以入场导航一律先过 primeDocumentIdentity。
 *
 * 但「脚本改写出来的品牌」本身就是破绽：站点只要看一眼
 * `String(Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgentData').get)`，
 * 读到的会是 `function () { return api }`，而真 Chrome 是 `[native code]`。
 * 实测同一台机器、同一个账号、同一个网络下真 Chrome 能登录、Torra 不能，
 * 差的正是这一处（外加 `window.chrome` 等只有真内核才有的细节）。
 * 所以第三层优先走 `Network.setUserAgentOverride` + `userAgentMetadata`：
 * 让**内核自己**上报带 Google Chrome 的品牌，getter 保持原生、
 * 线上的 `sec-ch-ua` 也随之正确。JS 补丁退为兜底，且它在品牌已经对了的时候自己退出 ——
 * 否则两份补丁同时在场，反而是自己造的那一枚把原生实现挡掉。
 *
 * 品牌与版本一律**从真实信号里派生**：UA 版本取 `process.versions.chrome`，
 * 品牌列表取页面自己的 `navigator.userAgentData.brands`，只往里补 `Google Chrome` 一项。
 * 硬编码一个固定的 Chrome 版本会在 Electron 升级后与真实内核错位，
 * 而「错位」正是闸门要抓的那个特征。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { diag } from '../diagnostics/log'

/** Google 登录闸门认的品牌；缺失时补进真实品牌列表 */
export const CHROME_BRAND = 'Google Chrome'

/** 从 `process.versions.chrome`（形如 130.0.6723.191）取内核版本；取不到返回 null */
export function chromeBuildVersion(raw: string | undefined): { major: string; full: string } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(String(raw || ''))
  if (!m) return null
  return { major: m[1] as string, full: m[0] as string }
}

/** 伪装用的 UA：主版本号与真实内核一致，全零的小版本是 Chrome 自己的简化 UA 口径 */
export function chromeUserAgent(major: string): string {
  return [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '(KHTML, like Gecko)',
    `Chrome/${major}.0.0.0`,
    'Safari/537.36',
  ].join(' ')
}

/**
 * 解析 `Sec-CH-UA` 这类结构化品牌列表：`"Chromium";v="130", "Not?A_Brand";v="24"`。
 * 解析不动就返回 null —— 宁可不改，也不要把一份看不懂的头部改写成第三形态。
 */
export function parseSecUaList(value: string): { brand: string; version: string }[] | null {
  const out: { brand: string; version: string }[] = []
  for (const raw of String(value || '').split(',')) {
    const item = raw.trim()
    if (!item) continue
    const m = /^"((?:[^"\\]|\\.)*)"\s*;\s*v\s*=\s*"((?:[^"\\]|\\.)*)"$/.exec(item)
    if (!m) return null
    const brand = (m[1] as string).replace(/\\(.)/g, '$1')
    const version = (m[2] as string).replace(/\\(.)/g, '$1')
    out.push({ brand, version })
  }
  return out.length ? out : null
}

/** 序列化回 `Sec-CH-UA` 的写法，品牌里的引号/反斜杠按规范转义 */
export function formatSecUaList(list: { brand: string; version: string }[]): string {
  return list
    .map((e) => `"${e.brand.replace(/["\\]/g, (c) => '\\' + c)}";v="${e.version.replace(/["\\]/g, (c) => '\\' + c)}"`)
    .join(', ')
}

/**
 * 把 `Google Chrome` 品牌插进一份真实品牌列表。
 *
 * 位置照抄 Chrome 自己的顺序：`Google Chrome` 排第一，紧跟 `Chromium`，其余（含
 * grease 品牌 `Not?A_Brand`）留在后面。已存在则只对齐版本，不重复插入 ——
 * 同一份列表里两枚同名品牌本身就是异常。
 *
 * 顺序不是可有可无的：Electron 给出的原始列表把 grease 品牌排在最前，
 * 只往里补一项会得到「Chrome 排在 Chromium 后面」的写法，
 * 那是真实 Chrome 永远不会生成的形态。
 */
export function withChromeBrand(
  list: { brand: string; version: string }[],
  brand: string,
  version: string,
): { brand: string; version: string }[] {
  const out = list.map((e) => ({ brand: e.brand, version: e.version }))
  const existing = out.findIndex((e) => e.brand === brand)
  if (existing >= 0) out[existing] = { brand, version }
  else out.push({ brand, version })
  // 稳定排序：Chrome → Chromium → 其余（保持各自原有相对顺序）
  const rank = (b: string): number => (b === brand ? 0 : b === 'Chromium' ? 1 : 2)
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e.brand) - rank(b.e.brand) || a.i - b.i)
    .map((x) => x.e)
}

/**
 * 改写一枚客户端提示头：补上 Google Chrome 品牌，版本用调用方给的那一份
 * （短清单给主版本，全版本清单给全版本号）。
 *
 * 返回 undefined 表示「不动它」：头部本来就不在（这枚请求不该带客户端提示）、
 * 格式读不懂、或已经是 Chrome 的写法 —— 这三种情况下凭空造一份，
 * 都比留原样更容易被识破。
 */
export function patchSecUaHeader(
  value: string | undefined,
  brandVersion: string,
): string | undefined {
  if (!value) return undefined
  const list = parseSecUaList(value)
  if (!list) return undefined
  const rendered = formatSecUaList(withChromeBrand(list, CHROME_BRAND, brandVersion))
  return rendered === value ? undefined : rendered
}

/** 平台名口径：`Sec-CH-UA-Platform` 与 userAgentData.platform 用的是这一套字面量 */
export function clientHintPlatform(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  return 'Linux'
}

/**
 * 兜底补丁脚本：在任何站点脚本之前，把 `navigator.userAgentData` 换成
 * 与请求头一致的那一份（补上 Google Chrome 品牌）。
 *
 * 但**品牌已经对了就原样退出**：内核级覆盖生效后，页面读到的本来就有 Google Chrome，
 * 这时再 defineProperty 等于亲手把原生 getter 换成 JS 的 —— 那正是覆盖要修掉的破绽。
 * 有了这条自检，补丁只需登记一次：它自动只管覆盖赶不及的那份文档
 * （站点 window.open 出来的登录弹窗，第一个文档在覆盖落地之前就开始跑脚本了）。
 *
 * 这里不用模板字面量，也不用反斜杠转义的正则 —— 这段字符串要经
 * JSON.stringify 再塞进 CDP，注释里一枚裸反引号就能静默截断整段脚本
 * （inject.ts 踩过，表现为窗口挂起、零输出）。
 */
export function userAgentDataPatchScript(major: string, fullVersion: string, platform: string): string {
  const lines = [
    '(function () {',
    '  try {',
    '    var real = navigator.userAgentData;',
    '    var MAJOR = ' + JSON.stringify(major) + ';',
    '    var FULL = ' + JSON.stringify(fullVersion) + ';',
    '    var PLATFORM = ' + JSON.stringify(platform) + ';',
    '    var list0 = (real && real.brands) || [];',
    '    var hit0 = false; var i0;',
    '    for (i0 = 0; i0 < list0.length; i0++) { if (String(list0[i0].brand) === "Google Chrome") hit0 = true }',
    '    if (hit0) return;',
    '    function withBrand(list, brand, version) {',
    '      var out = []; var i;',
    '      for (i = 0; i < (list || []).length; i++) {',
    '        out.push({ brand: String(list[i].brand), version: String(list[i].version) });',
    '      }',
    '      var hit = null;',
    '      for (i = 0; i < out.length; i++) { if (out[i].brand === brand) hit = out[i] }',
    '      if (hit) { hit.version = version } else { out.push({ brand: brand, version: version }) }',
    '      function rank(b) { return b === brand ? 0 : b === "Chromium" ? 1 : 2 }',
    '      var idx = [];',
    '      for (i = 0; i < out.length; i++) idx.push(i);',
    '      idx.sort(function (a, b) { return rank(out[a].brand) - rank(out[b].brand) || a - b });',
    '      var sorted = [];',
    '      for (i = 0; i < idx.length; i++) sorted.push(out[idx[i]]);',
    '      return sorted;',
    '    }',
    '    var brands = withBrand(real && real.brands, "Google Chrome", MAJOR);',
    '    var platform = (real && real.platform) || PLATFORM;',
    '    var mobile = !!(real && real.mobile);',
    '    function fullList() { return withBrand(real && real.brands, "Google Chrome", FULL) }',
    '    var api = {',
    '      brands: brands,',
    '      mobile: mobile,',
    '      platform: platform,',
    '      getHighEntropyValues: function (hints) {',
    '        var fallback = {',
    '          brands: brands, mobile: mobile, platform: platform, architecture: "",',
    '          bitness: "", model: "", platformVersion: "", uaFullVersion: FULL,',
    '          fullVersionList: fullList(),',
    '        };',
    '        if (!real || typeof real.getHighEntropyValues !== "function") return Promise.resolve(fallback);',
    '        try {',
    '          return real.getHighEntropyValues(hints || []).then(function (v) {',
    '            var out = {}; var k;',
    '            for (k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = v[k] }',
    '            out.brands = brands;',
    '            out.uaFullVersion = FULL;',
    '            if (out.fullVersionList) out.fullVersionList = withBrand(out.fullVersionList, "Google Chrome", FULL);',
    '            return out;',
    '          }, function () { return fallback });',
    '        } catch (e) { return Promise.resolve(fallback) }',
    '      },',
    '    };',
    '    Object.defineProperty(Navigator.prototype, "userAgentData", {',
    '      configurable: true,',
    '      get: function () { return api },',
    '    });',
    '  } catch (e) {}',
    '})();',
  ]
  return lines.join('\n')
}

/** 页面里读回来的那一份真实身份信号（内核原生视角，未经任何改写） */
export interface RealIdentitySignals {
  brands: { brand: string; version: string }[]
  fullVersionList: { brand: string; version: string }[]
  platform: string
  platformVersion: string
  architecture: string
  bitness: string
  model: string
  mobile: boolean
  uaFullVersion: string
  navigatorPlatform: string
  languages: string[]
  /** userAgentData 的 getter 是否还是内核原生实现（被 JS 改写过的文档读回来的是 false） */
  native: boolean
}

/**
 * 从当前文档读回**真实**身份信号的求值脚本。
 *
 * 必须在打任何补丁之前读：一旦 JS 补丁或 CDP 覆盖生效，读回来的就是自己造的假身份，
 * 再拿它去构造下一份覆盖，等于把自己的输出当证据 —— 品牌会逐次漂移。
 * 所以这里连 getter 是否原生也一起读回来（native=false 的读数不能进缓存）。
 *
 * 同样不能出现裸反引号（这段字符串要经 JSON.stringify 塞进 CDP）。
 */
export function readIdentityScript(): string {
  const lines = [
    '(async function () {',
    '  try {',
    '    var u = navigator.userAgentData;',
    "    var g = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgentData');",
    "    var native = !!(g && g.get && String(g.get).indexOf('[native code]') >= 0);",
    "    var he = null;",
    "    if (u && typeof u.getHighEntropyValues === 'function') {",
    "      try { he = await u.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness', 'model', 'uaFullVersion']) } catch (e) { he = null }",
    '    }',
    '    function norm(list) {',
    '      var out = []; var i;',
    '      for (i = 0; i < (list || []).length; i++) out.push({ brand: String(list[i].brand), version: String(list[i].version) });',
    '      return out;',
    '    }',
    '    var langs = []; var k;',
    '    for (k = 0; k < (navigator.languages || []).length; k++) langs.push(String(navigator.languages[k]));',
    '    return JSON.stringify({',
    '      brands: norm(u && u.brands),',
    '      fullVersionList: norm(he && he.fullVersionList),',
    '      platform: String((u && u.platform) || \'\'),',
    '      platformVersion: String((he && he.platformVersion) || \'\'),',
    '      architecture: String((he && he.architecture) || \'\'),',
    '      bitness: String((he && he.bitness) || \'\'),',
    '      model: String((he && he.model) || \'\'),',
    '      mobile: !!(u && u.mobile),',
    '      uaFullVersion: String((he && he.uaFullVersion) || \'\'),',
    '      navigatorPlatform: String(navigator.platform || \'\'),',
    '      languages: langs,',
    '      native: native,',
    '    });',
    '  } catch (e) { return \'\' }',
    '})()',
  ]
  return lines.join('\n')
}

/** 把读回来的 JSON 解析成信号；不是真身份（读不到、或 getter 已被 JS 改过）时返回 null */
export function parseIdentitySignals(raw: unknown): RealIdentitySignals | null {
  if (typeof raw !== 'string' || !raw) return null
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || v.native !== true) return null
  const list = (x: unknown) =>
    Array.isArray(x)
      ? x
          .filter((e) => e && typeof e === 'object')
          .map((e) => ({ brand: String((e as Record<string, unknown>).brand ?? ''), version: String((e as Record<string, unknown>).version ?? '') }))
          .filter((e) => e.brand)
      : []
  const brands = list(v.brands)
  if (!brands.length) return null
  if (!String(v.platform || '')) return null
  return {
    brands,
    fullVersionList: list(v.fullVersionList),
    platform: String(v.platform),
    platformVersion: String(v.platformVersion || ''),
    architecture: String(v.architecture || ''),
    bitness: String(v.bitness || ''),
    model: String(v.model || ''),
    mobile: !!v.mobile,
    uaFullVersion: String(v.uaFullVersion || ''),
    navigatorPlatform: String(v.navigatorPlatform || ''),
    languages: Array.isArray(v.languages) ? v.languages.map((s) => String(s)).filter(Boolean) : [],
    native: true,
  }
}

/**
 * 由真实信号 + 内核版本号构造 `Network.setUserAgentOverride` 的参数。
 *
 * 只有 `Google Chrome` 这一枚品牌是补进去的，其余字段（平台版本、架构、位宽、机型、
 * grease 品牌及其版本号）全部照抄内核自己报的那一份。编造这些字段等于换一处矛盾：
 * 闸门复核的是各字段之间能否互相圆上，不是单个字段像不像 Chrome。
 *
 * `acceptLanguage` 只能给纯语言列表：CDP 会把它同时用作 `navigator.languages` 的来源，
 * 带 `;q=0.9` 进去会得到 `["zh-CN","zh;q=0.9"]` 这种真浏览器不可能出现的形态。
 * 读不到信号、或缺了品牌列表 / 平台名时返回 null —— 交回 JS 兜底，不硬造。
 */
export function buildUserAgentOverride(
  real: RealIdentitySignals | null,
  userAgent: string | null,
  major: string,
  full: string,
): Record<string, unknown> | null {
  if (!real || !userAgent) return null
  const fullVersion = real.uaFullVersion || full
  const brands = withChromeBrand(real.brands, CHROME_BRAND, major)
  const metadata: Record<string, unknown> = {
    brands,
    mobile: real.mobile,
    platform: real.platform,
    platformVersion: real.platformVersion,
    architecture: real.architecture,
    bitness: real.bitness,
    model: real.model,
    uaFullVersion: fullVersion,
  }
  // 全版本清单是高熵提示，内核没报就没有：把短清单的主版本号冒充进去，
  // 会得到「Chrome 带四位版本、Chromium 带两位」这种真实 Chrome 不可能产生的清单。
  if (real.fullVersionList.length) {
    metadata.fullVersionList = withChromeBrand(real.fullVersionList, CHROME_BRAND, fullVersion)
  }
  const override: Record<string, unknown> = { userAgent, userAgentMetadata: metadata }
  if (real.languages.length) override.acceptLanguage = real.languages.join(',')
  if (real.navigatorPlatform) override.platform = real.navigatorPlatform
  return override
}

/** Torra 自己的分区名（内嵌站点视图、登录窗口、登录弹窗共用），主窗口界面不在其列 */
export function isTorraPartition(partition: string | undefined): boolean {
  return typeof partition === 'string' && partition.startsWith('persist:torra-')
}

/**
 * Google 的「此浏览器或应用可能不安全」拒绝页。
 *
 * 它和普通登录页同形（都在 signin 路径下、都判未登录），但成因是环境被拒 ——
 * 混为一谈会让人对着一个点不通的登录框反复重试。整段路径匹配，
 * 不接受 `/signin/rejectedfoo` 这类前缀巧合。
 */
export function isGoogleSignInRejected(url: string): boolean {
  return /^https:\/\/accounts\.google\.[^/]*\/[^\s?#]*signin\/rejected(?=$|[/?#])/i.test(String(url || ''))
}

/**
 * 站点自己的登录/授权页（不限 Google）。
 *
 * 判定登录态时它是决定性证据；导航日志也用它记一次「跳进登录页」——
 * SPA 常用 replaceState 把用户从内容页挪到登录页，那种原地导航不会跟着
 * did-finish-load，只盯主框架跳转的日志会把「已经掉回登录页」记成「内容页加载正常」。
 *
 * 边界必须含 `?` 与 `#`：这两站的登录页恰恰是 `/signin?continue=…`、`/login?from=logout…`，
 * 只认 `/` 或结尾等于永远认不出真实登录页。
 */
export function isLoginPageUrl(url: string): boolean {
  return /\/(sign_?in|sign_?up|login|register|auth)(?:[/?#]|$)/i.test(String(url || ''))
}

const identity = chromeBuildVersion(process.versions?.chrome)
const platformName = clientHintPlatform(process.platform)

/**
 * 伪装用的 UA。内核版本读不到时为 null：宁可不伪装，也不编一个与真实内核对不上的版本号 ——
 * 「UA 说一个版本、客户端提示说另一个版本」正是闸门要抓的特征，编造比不伪装更糟。
 */
export const spoofedUserAgent: string | null = identity ? chromeUserAgent(identity.major) : null

const headerDone = new WeakSet<Electron.Session>()
/** 每枚 contents 的「文档层补丁已挂上」票据；重复索取拿同一张 */
const documentArmed = new WeakMap<Electron.WebContents, Promise<void>>()
/** 被认领为 Torra 内嵌分区的 session → 分区名。日志与钩子都靠它认身份 */
const torraSessions = new WeakMap<Electron.Session, string>()
/**
 * 每个分区只读一次真实身份信号。
 *
 * 读它需要一个活着的文档，而站点自己 window.open 出来的登录弹窗没有「先喂空白页」的
 * 机会 —— 等到那时再读，要么读不到、要么读到的已经是被改写后的身份。
 * 所以第一份文档（about:blank，未打任何补丁）读一次并缓存，后续 target 复用同一份。
 */
const realIdentity = new WeakMap<Electron.Session, RealIdentitySignals>()

/**
 * 这枚 session 是不是 Torra 的内嵌站点分区。
 *
 * WebContents 上没有 partition 可读（Electron 33 的 typings 里没有），
 * 而 app 的 web-contents-created 钩子必须分辨「内嵌站点」与「自家界面」——
 * 给主窗口挂调试器既没好处，还会抢走验证脚本自己要用的那枚 CDP target。
 * 所以身份在这里认领，钩子那边只查认领记录。
 */
export function torraPartitionOf(ses: Electron.Session): string | null {
  return torraSessions.get(ses) ?? null
}

/**
 * 就地改写一枚请求头字典里的客户端提示，返回是否动了。
 *
 * 键名按小写比对：HTTP/2 传下来的是小写，Electron 把字典原样交给 handler，
 * 大小写敏感地比对等于漏改 —— 漏一个请求就少一层伪装。
 * 两处版本口径必须与 Chrome 自己一致（短清单发主版本、全版本清单发全版本号），
 * 版本对不上号正是闸门要复核的那类矛盾。
 */
export function patchRequestHeaders(
  headers: Record<string, string | string[]>,
  major: string,
  full: string,
): boolean {
  let changed = false
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase()
    const brandVersion = lower === 'sec-ch-ua' ? major : lower === 'sec-ch-ua-full-version-list' ? full : null
    if (!brandVersion) continue
    const patched = patchSecUaHeader(String(headers[key]), brandVersion)
    if (patched) {
      headers[key] = patched
      changed = true
    }
  }
  return changed
}

/**
 * 会话层：认领分区 + UA + 客户端提示头。
 *
 * 分区名不是 persist:torra- 就整件事不做：伪装只该作用于内嵌站点，
 * 自家界面（defaultSession）一旦被挂上这些，验证与调试通道都会受影响。
 *
 * `onBeforeSendHeaders` 是按 session 覆盖式注册的，跟权限闸门同一个坑：
 * 同一分区注册第二次会把前一份 handler 换掉。按 session 去重，只装一次。
 */
export function applyChromeIdentity(ses: Electron.Session, partition: string): void {
  if (!isTorraPartition(partition)) return
  torraSessions.set(ses, partition)
  if (spoofedUserAgent) ses.setUserAgent(spoofedUserAgent)
  if (!identity || headerDone.has(ses)) return
  headerDone.add(ses)
  const { major, full } = identity
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders
    try {
      patchRequestHeaders(headers, major, full)
    } catch (e) {
      // 伪装失败不该把请求本身掐断：原样放行，站点顶多回到「被拒」那一步
      diag.log({
        ts: Date.now(),
        layer: 'channel',
        stage: 'identity-headers-error',
        subject: partition,
        ok: false,
        detail: (e as Error).message,
      })
    }
    callback({ requestHeaders: headers })
  })
}

/**
 * 调试器接管后，站点弹出的原生对话框由谁回答。
 *
 * attach 之后 Chromium 会把 alert/confirm/prompt 交给 CDP 客户端；
 * 没人回答，这一页就永远停在那一句弹窗上 —— 表现成「网页模型卡死」，
 * 而它本可以一次自动应答就过去。
 *
 * 只有 `Page.javascriptDialogOpening` 真的发过来才走这一支：
 * Electron 若仍自己弹原生框（不发这条事件），这里一次都不触发，行为不变。
 * confirm/prompt 一律按「用户没点确定」处理 —— 宁可让站点的删除确认走不下去，
 * 也不能替用户点头。
 */
export function dialogAnswerFor(type: string | undefined): { accept: boolean } {
  return { accept: type === 'alert' }
}

/**
 * 第三层的首选：让内核自己上报带 Google Chrome 的品牌。
 *
 * 必须是 CDP 覆盖而不是 JS 改写：站点只要读
 * `String(Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgentData').get)`
 * 就能分清 `[native code]` 与 `function () { return api }`。
 * 覆盖成功后线上的 `sec-ch-ua` 与 `navigator.userAgentData` 同源，
 * 不再需要 JS 补丁 —— 也**不能**再打，否则自己造的 getter 会把原生实现挡掉。
 *
 * 前提是要有一份活着的文档（读真实信号、以及命令本身要能被处理），
 * 所以调用它之前先经过 primeDocumentIdentity 的唤醒。
 * 返回 false = 这一层没做成，调用方回落到 JS 补丁。
 */
async function applyNativeOverride(contents: Electron.WebContents, subject: string): Promise<boolean> {
  const id = identity
  if (!id || contents.isDestroyed()) return false
  try {
    await contents.debugger.sendCommand('Network.enable')
    let real = realIdentity.get(contents.session)
    if (!real) {
      const res = await contents.debugger.sendCommand('Runtime.evaluate', {
        expression: readIdentityScript(),
        awaitPromise: true,
        returnByValue: true,
      })
      real = parseIdentitySignals((res as { result?: { value?: unknown } } | undefined)?.result?.value) ?? undefined
      if (!real) return false
      // 高熵值（平台版本等）在非安全上下文可能读不到：那样的读数够用但不完整，
      // 不写进缓存 —— 让后面那份文档再读一次，争取一份全的。
      if (real.platformVersion) realIdentity.set(contents.session, real)
    }
    const params = buildUserAgentOverride(real, spoofedUserAgent, id.major, id.full)
    if (!params) return false
    await contents.debugger.sendCommand('Network.setUserAgentOverride', params)
    return true
  } catch (e) {
    diag.log({
      ts: Date.now(),
      layer: 'channel',
      stage: 'identity-native',
      subject,
      ok: false,
      detail: `内核级品牌覆盖未生效：${(e as Error)?.message ?? e}`,
    })
    return false
  }
}

/**
 * 文档层：让页面脚本读到的 `navigator.userAgentData` 与请求头一致。
 *
 * 走 CDP 而不是 preload：preload 跑在隔离世界，碰不到站点自己的 navigator。
 * attach 失败（外部调试器已占着这枚 target）时只记一条日志并降级为「只有会话层」，
 * 不抛回业务流程。
 *
 * 返回的是「身份层已就位」这张票据，调用方可以用它挡住第一次导航 ——
 * 因为覆盖与 `addScriptToEvaluateOnNewDocument` 都只管**它之后**的文档，
 * 而命令要等渲染进程活着才会 resolve（见 primeDocumentIdentity）。
 * 同一枚 contents 重复调用返回同一张票，不会重复 attach。
 */
export function spoofDocumentIdentity(contents: Electron.WebContents, subject: string): Promise<void> {
  const ticket = documentArmed.get(contents)
  if (ticket) return ticket
  const armed = armDocumentIdentity(contents, subject)
  documentArmed.set(contents, armed)
  contents.once('destroyed', () => {
    try {
      contents.debugger.detach()
    } catch {
      /* 随 target 一起没了 */
    }
  })
  return armed
}

/** 挂上文档层补丁；失败只记录并 resolve，绝不让调用方卡在「等一个永远不来的确认」上 */
function armDocumentIdentity(contents: Electron.WebContents, subject: string): Promise<void> {
  const id = identity
  if (!id || contents.isDestroyed()) return Promise.resolve()
  return (async () => {
    contents.debugger.attach('1.3')
    // 原生对话框从此归 CDP 客户端回答：没人应答，页面就永远停在那一句 alert 上。
    // confirm/prompt 一律按「用户没点确定」处理（见 dialogAnswerFor）。
    contents.debugger.on('message', (_ev, method, params) => {
      if (method !== 'Page.javascriptDialogOpening' || contents.isDestroyed()) return
      void contents.debugger
        .sendCommand('Page.handleJavaScriptDialog', dialogAnswerFor((params as { type?: string } | undefined)?.type))
        .catch(() => undefined)
    })
    // 顺序有讲究：Page.enable 是弹窗事件的前置，品牌覆盖才是正文。
    // 每一段都要等 —— 渲染进程没起来时这些命令会一直悬着，这正是 primeDocumentIdentity
    // 要先喂一枚空白文档的原因。
    await contents.debugger.sendCommand('Page.enable')
    const native = await applyNativeOverride(contents, subject)
    // 兜底补丁总是登记。它在品牌已经对了的时候自己退出（见 userAgentDataPatchScript），
    // 所以覆盖成功的那些文档不会被换上 JS getter，而覆盖赶不及的那份 ——
    // 站点 window.open 出来的登录弹窗，第一个文档在覆盖落地前就开始跑脚本了 —— 仍有兜底。
    const source = userAgentDataPatchScript(id.major, id.full, platformName)
    await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source })
    diag.log({
      ts: Date.now(),
      layer: 'channel',
      stage: 'identity-spoof',
      subject,
      ok: true,
      detail: native
        ? `Chrome/${id.major} 由内核直接上报（getter 保持原生），补丁已登记为赶不上第一份文档时的兜底`
        : `Chrome/${id.major} 只有 JS 补丁（内核覆盖不可用，此形态站点可识破）`,
    })
  })().catch((e: Error) => {
    diag.log({
      ts: Date.now(),
      layer: 'channel',
      stage: 'identity-spoof',
      subject,
      ok: false,
      detail: `品牌补丁未挂上：${e?.message ?? e}`,
    })
  })
}

/**
 * 让补丁赶得上**第一个**业务文档。
 *
 * 现场：新建的 contents 还没有渲染进程，CDP 命令会一直悬着；等它随着第一次真实导航
 * 落地时，那个文档早就开始跑站点脚本了。于是登录页读到的是「请求头说 Chrome、
 * 页面说 Chromium」—— Google 的闸门抓的正是这处矛盾，实测第一份文档的品牌列表
 * 里没有 Google Chrome，第二份才有。
 *
 * 办法：先导航到一枚唤醒文档把渲染进程叫醒（实测 93ms），等身份层确认就位，
 * 再放真实地址过去。唤醒页只为这一步存在，不留历史痕迹给站点。
 * 超时后照常放行：宁可退回「只有会话层」，也不把站点的加载无限期押住。
 *
 * **唤醒文档必须是安全上下文**：`navigator.userAgentData` 只在安全上下文暴露，
 * 实测 about:blank 与 data: 页面的 `isSecureContext` 都是 false，那份文档里
 * 根本没有 userAgentData —— 拿它当唤醒页，真实信号一条都读不回来，
 * 内核级覆盖因此静默退化成 JS 补丁（正是这次要修的那处）。
 * 本地 `file://` 是安全上下文，实测能读全 brands / fullVersionList / platformVersion。
 */
export const ARM_TIMEOUT_MS = 2000

/** 唤醒页的文件名（落在 userData 下，见 isWakeDocument） */
export const WAKE_FILE_NAME = 'torra-identity-wake.html'

const WAKE_HTML = '<!doctype html><meta charset="utf-8"><title>wake</title>'

/**
 * 唤醒文档的地址：userData 下的一枚一次性空页面。
 *
 * 造不出来（目录不可写等）时返回 null，调用方退回 about:blank ——
 * 依然能叫醒渲染进程，只是读不回真实信号，那一支由 JS 补丁兜底。
 * 用 pathToFileURL 而不是拼字符串：用户名里带空格或中文时拼出来的不是合法 URL。
 */
export function wakeDocumentUrl(dir: string | null): string | null {
  if (!dir) return null
  const file = path.join(dir, WAKE_FILE_NAME)
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, WAKE_HTML)
    return pathToFileURL(file).href
  } catch {
    return null
  }
}

/** 这枚地址是不是 Torra 自己的唤醒页（不是站点内容，不该进导航日志、也不算「没加载出来」） */
export function isWakeDocument(url: string): boolean {
  const u = String(url || '')
  if (u === 'about:blank') return true
  return u.startsWith('file:') && u.endsWith(WAKE_FILE_NAME)
}

export async function primeDocumentIdentity(
  contents: Electron.WebContents,
  subject: string,
  timeoutMs: number = ARM_TIMEOUT_MS,
): Promise<void> {
  if (contents.isDestroyed() || !identity) return
  /*
   * 唤醒导航必须排在补丁登记**之前**：补丁里的读数（以及覆盖所用的真实信号）
   * 来自当时那份文档，而 BrowserWindow 一出生就停在 about:blank 上 ——
   * 先登记再唤醒，读回来的是那份非安全上下文里的空值，内核级覆盖就此静默失效。
   * 补丁本身照样赶得上业务文档：业务地址是调用方在 prime 返回之后才发的。
   */
  const current = contents.getURL()
  if (!current || current === 'about:blank') {
    try {
      await contents.loadURL(wakeDocumentUrl(safeUserDataDir()) ?? 'about:blank')
    } catch {
      /* 唤醒页导航失败不影响下面的等待与放行 */
    }
  }
  // 已经在某个页面上（登录弹窗就是这种：window.open 一发起就带地址），
  // 不能再拿唤醒页把它打断；那份文档本身就是安全上下文，直接照着它打补丁。
  const armed = spoofDocumentIdentity(contents, subject)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([armed, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * userData 目录。
 *
 * 验证脚本会在纯 Node（不起 Electron）里 import 本文件取纯函数：那时 `app` 是 undefined，
 * 所以这里整体包在 try 里 —— 拿不到目录只是退回 about:blank，不该把模块本身搞崩。
 */
function safeUserDataDir(): string | null {
  try {
    return app.getPath('userData')
  } catch {
    return null
  }
}

