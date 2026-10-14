/**
 * Chrome 身份伪装：UA / Sec-CH-UA 客户端提示 / navigator.userAgentData 三层（纯函数，不需要 Electron）
 *
 * 起因是 Gemini 登不进：Google 的登录闸门把内嵌视图判成「此浏览器或应用可能不安全」，
 * 直接重定向到 accounts.google.com/v3/signin/rejected。
 * 这个判定只在真实登录时才暴露，而它一旦错就是静默的 —— 页面照常显示，只是永远登不进。
 * 所以把能离线钉死的都钉住：
 * - 版本从内核派生，不写死常量（写死的会在 Electron 升级后与真实内核错位）；
 * - 品牌列表的插入位置与幂等（同名品牌出现两次本身就是异常特征）；
 * - 看不懂的头一律不改（凭空造一份比留原样更容易被识破）；
 * - 注入脚本能被解析、能跑，并且**与请求头给出同一份品牌列表** —— 两层不一致正是被拒的成因；
 * - 接线层：三层确实装在了所有 persist:torra- 分区上，且没去碰主窗口界面。
 *
 * 运行：npx ts-node -P tsconfig.test.json scripts/test-chrome-identity.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {
  CHROME_BRAND,
  WAKE_FILE_NAME,
  buildUserAgentOverride,
  chromeBuildVersion,
  chromeUserAgent,
  clientHintPlatform,
  dialogAnswerFor,
  formatSecUaList,
  isGoogleSignInRejected,
  isLoginPageUrl,
  isTorraPartition,
  isWakeDocument,
  parseIdentitySignals,
  parseSecUaList,
  patchRequestHeaders,
  patchSecUaHeader,
  readIdentityScript,
  userAgentDataPatchScript,
  wakeDocumentUrl,
  withChromeBrand,
  type RealIdentitySignals,
} from '../src/main/webview/chrome-identity'

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    fail++
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${(e as Error).message.split('\n').slice(0, 4).join('\n         ')}`)
  }
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** Electron 33 真实发出的那一份：只有 Chromium 与 grease 品牌，没有 Google Chrome */
const ELECTRON_SEC_UA = '"Chromium";v="130", "Not?A_Brand";v="24"'
const CHROME_SEC_UA = '"Google Chrome";v="130", "Chromium";v="130", "Not?A_Brand";v="24"'
const ELECTRON_FULL_LIST = '"Chromium";v="130.0.6723.191", "Not?A_Brand";v="24.0.0.0"'

/**
 * 沙箱里造出来的数组带着那份上下文自己的原型，跟宿主字面量一比就红（结构相同、引用不等）。
 * 断言前先 join 成字符串：比的是这份列表对外说了什么，不是对象身份。
 */
function brandPairs(list: unknown): string {
  return (Array.isArray(list) ? list : [])
    .map((e) => `${(e as any).brand}=${(e as any).version}`)
    .join(' ')
}

/**
 * 在 vm 沙箱里真跑一遍注入脚本：光做字符串断言验不出「脚本根本跑不起来」，
 * 也验不出补丁是否真的盖住了页面读到的 navigator。
 *
 * 假 navigator 必须把 userAgentData 挂在原型上（浏览器就是这么做的）：
 * 挂在实例上会成了一枚自有属性，原型上的 getter 根本盖不住它，测试会假绿。
 */
async function patchedUserAgentData(
  major: string,
  full: string,
  platform: string,
  realBrands: { brand: string; version: string }[],
  highEntropy?: unknown,
): Promise<any> {
  const source = userAgentDataPatchScript(major, full, platform)
  const Navigator = function Navigator(this: unknown) {}
  Object.defineProperty(Navigator.prototype, 'userAgentData', {
    configurable: true,
    get() {
      return {
        brands: realBrands,
        mobile: false,
        platform,
        getHighEntropyValues: highEntropy ? () => Promise.resolve(highEntropy) : undefined,
      }
    },
  })
  const sandbox: Record<string, unknown> = { Navigator, navigator: new (Navigator as unknown as new () => object)() }
  vm.runInContext(source, vm.createContext(sandbox))
  return (sandbox.navigator as any).userAgentData
}

async function main(): Promise<void> {
  console.log('='.repeat(46))
  console.log('  Chrome 身份伪装：三层一致，才登得进 Google')
  console.log('='.repeat(46))

  await it('内核版本派生：认得出 major/full，认不出就返回 null 而不是编一个', () => {
    assert.deepEqual(chromeBuildVersion('130.0.6723.191'), { major: '130', full: '130.0.6723.191' })
    assert.deepEqual(chromeBuildVersion('131.0.6778.85'), { major: '131', full: '131.0.6778.85' })
    assert.equal(chromeBuildVersion(undefined), null)
    assert.equal(chromeBuildVersion(''), null)
    assert.equal(chromeBuildVersion('v13'), null, '残缺版本号不该被当成主版本')
    assert.equal(chromeBuildVersion('not-a-version'), null)
  })

  await it('UA 与真实内核同主版本，且不含 Electron 与应用名标识', () => {
    const ua = chromeUserAgent('130')
    assert.match(ua, /Chrome\/130\.0\.0\.0/)
    assert.doesNotMatch(ua, /Electron/, 'UA 里带 Electron/x.y.z 就是这次被拒的第一层原因')
    assert.doesNotMatch(ua, /Torra/)
  })

  await it('Sec-CH-UA 解析：认 grease 品牌里的 ?，读不懂就整份放弃', () => {
    assert.deepEqual(parseSecUaList(ELECTRON_SEC_UA), [
      { brand: 'Chromium', version: '130' },
      { brand: 'Not?A_Brand', version: '24' },
    ])
    assert.equal(parseSecUaList('"Chromium" v="130"'), null, '缺分号就是另一套语法，别猜')
    assert.equal(parseSecUaList('Chromium;v=130'), null, '品牌不加引号不是合法清单')
    assert.equal(parseSecUaList(''), null)
    assert.deepEqual(parseSecUaList(' "Chromium";v="130" '), [{ brand: 'Chromium', version: '130' }], '多余空白要容得下')
  })

  await it('品牌插入：按真实 Chrome 的顺序排（Google Chrome 最前、Chromium 次之、grease 垫后），且不改动入参', () => {
    const list = parseSecUaList(ELECTRON_SEC_UA)!
    const patched = withChromeBrand(list, CHROME_BRAND, '130')
    assert.equal(brandPairs(patched), 'Google Chrome=130 Chromium=130 Not?A_Brand=24')
    assert.equal(brandPairs(list), 'Chromium=130 Not?A_Brand=24', '入参被改等于污染了真实品牌列表')
    assert.equal(formatSecUaList(patched), CHROME_SEC_UA)
  })

  await it('幂等：已有 Google Chrome 时只对齐版本，绝不出现两枚同名品牌', () => {
    const twice = withChromeBrand(
      withChromeBrand(parseSecUaList(ELECTRON_SEC_UA)!, CHROME_BRAND, '130'),
      CHROME_BRAND,
      '131',
    )
    assert.equal(twice.filter((e) => e.brand === CHROME_BRAND).length, 1)
    assert.equal(twice.find((e) => e.brand === CHROME_BRAND)!.version, '131')
  })

  await it('改写头部的边界：没有就不造、读不懂就不动、本来就对就不重写', () => {
    assert.equal(patchSecUaHeader(undefined, '130'), undefined, '这枚请求本来不带客户端提示，凭空造一份反而异常')
    assert.equal(patchSecUaHeader('', '130'), undefined)
    assert.equal(patchSecUaHeader('not-a-list', '130'), undefined)
    assert.equal(
      patchSecUaHeader(CHROME_SEC_UA, '130'),
      undefined,
      '已经是 Chrome 的写法就别再动它，省掉一次无谓的头部改写',
    )
    assert.equal(patchSecUaHeader(ELECTRON_SEC_UA, '130'), CHROME_SEC_UA)
  })

  await it('全版本清单用全版本号，短清单用主版本号', () => {
    assert.equal(
      patchSecUaHeader(ELECTRON_FULL_LIST, '130.0.6723.191'),
      '"Google Chrome";v="130.0.6723.191", "Chromium";v="130.0.6723.191", "Not?A_Brand";v="24.0.0.0"',
    )
    assert.equal(patchSecUaHeader(ELECTRON_SEC_UA, '130'), CHROME_SEC_UA)
  })

  await it('平台字面量：与 Sec-CH-UA-Platform 同一套写法', () => {
    assert.equal(clientHintPlatform('win32'), 'Windows')
    assert.equal(clientHintPlatform('darwin'), 'macOS')
    assert.equal(clientHintPlatform('linux'), 'Linux')
    assert.equal(clientHintPlatform('freebsd' as NodeJS.Platform), 'Linux')
  })

  await it('注入脚本没有裸反引号，且能被解析', () => {
    const source = userAgentDataPatchScript('130', '130.0.6723.191', 'Windows')
    assert.doesNotMatch(source, /`/, 'inject.ts 踩过的坑：一枚裸反引号静默截断整段脚本，表现为窗口挂起零输出')
    assert.doesNotMatch(source, /<\/script/i)
    new Function(source)
  })

  await it('注入脚本真跑得起来，并把品牌补成与请求头同一份', async () => {
    const real = [
      { brand: 'Chromium', version: '130' },
      { brand: 'Not?A_Brand', version: '24' },
    ]
    const api = await patchedUserAgentData('130', '130.0.6723.191', 'Windows', real)
    assert.equal(api.brands.length, 3)
    assert.equal(brandPairs(api.brands), brandPairs(parseSecUaList(patchSecUaHeader(ELECTRON_SEC_UA, '130')!)))
    assert.equal(brandPairs(api.brands), 'Google Chrome=130 Chromium=130 Not?A_Brand=24')
    assert.equal(api.platform, 'Windows')
    assert.equal(api.mobile, false, '补品牌不该顺手把移动端标记带上')
  })

  await it('真实 navigator 读不到高熵值时也有兜底，不抛给站点', async () => {
    const api = await patchedUserAgentData('130', '130.0.6723.191', 'Windows', [])
    assert.equal(brandPairs(api.brands), 'Google Chrome=130')
    const hv = await api.getHighEntropyValues(['uaFullVersion'])
    assert.equal(hv.uaFullVersion, '130.0.6723.191')
    assert.equal(hv.platform, 'Windows')
    assert.equal(brandPairs(hv.fullVersionList), 'Google Chrome=130.0.6723.191')
  })

  await it('高熵值：透传真实字段，只把品牌相关项对齐', async () => {
    const realHigh = {
      brands: [
        { brand: 'Chromium', version: '130' },
        { brand: 'Not?A_Brand', version: '24' },
      ],
      mobile: false,
      platform: 'Windows',
      architecture: 'x86',
      bitness: '64',
      model: '',
      platformVersion: '15.0.0',
      uaFullVersion: '130.0.6723.190',
      fullVersionList: [
        { brand: 'Chromium', version: '130.0.6723.190' },
        { brand: 'Not?A_Brand', version: '24.0.0.0' },
      ],
    }
    const api = await patchedUserAgentData(
      '130',
      '130.0.6723.191',
      'Windows',
      realHigh.brands,
      realHigh,
    )
    const hv = await api.getHighEntropyValues(['platformVersion', 'fullVersionList'])
    assert.equal(hv.architecture, 'x86', '与品牌无关的高熵字段不该被补丁抹掉')
    assert.equal(hv.platformVersion, '15.0.0')
    assert.equal(brandPairs(hv.brands), 'Google Chrome=130 Chromium=130 Not?A_Brand=24')
    assert.equal(
      brandPairs(hv.fullVersionList),
      'Google Chrome=130.0.6723.191 Chromium=130.0.6723.190 Not?A_Brand=24.0.0.0',
      '全版本清单里补的那一枚要用全版本号，短版本号会让清单自相矛盾',
    )
  })

  /*
   * 以下是第三层的「首选路径」：CDP 的 Network.setUserAgentOverride + userAgentMetadata。
   * 来现场：品牌补全后仍然被拒，而同一台机器上的真 Chrome 能登进。差的是
   * String(getUserAgentDataDescriptor.get) —— 真 Chrome 是 [native code]，
   * JS 补丁是 function () { return api }。让内核自己上报才是唯一走得通的形态。
   */
  const REAL_SIGNALS: RealIdentitySignals = {
    brands: [
      { brand: 'Not?A_Brand', version: '99' },
      { brand: 'Chromium', version: '130' },
    ],
    fullVersionList: [
      { brand: 'Not?A_Brand', version: '99.0.0.0' },
      { brand: 'Chromium', version: '130.0.6723.191' },
    ],
    platform: 'Windows',
    platformVersion: '19.0.0',
    architecture: 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    uaFullVersion: '130.0.6723.191',
    navigatorPlatform: 'Win32',
    languages: ['zh-CN', 'zh'],
    native: true,
  }

  await it('读数脚本跑得起来：从一份原生 getter 的页面读回真实身份', async () => {
    const source = readIdentityScript()
    assert.doesNotMatch(source, /`/, '同样是塞进 CDP 的字符串，一枚裸反引号就截断整段')
    new Function(source)
    const Navigator = function Navigator(this: unknown) {} as unknown as {
      prototype: Record<string, unknown>
      new (): object
    }
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true,
      // 借一枚真·原生 getter（Object.prototype.__proto__ 的那枚）：
      // 用 JS 函数当 getter 会被脚本自己判成 native=false，测的就不是「未改写的页面」了
      get: Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')!.get!,
    })
    Navigator.prototype.brands = REAL_SIGNALS.brands
    Navigator.prototype.mobile = false
    Navigator.prototype.platform = REAL_SIGNALS.platform
    Navigator.prototype.getHighEntropyValues = () =>
      Promise.resolve({
        fullVersionList: REAL_SIGNALS.fullVersionList,
        platformVersion: REAL_SIGNALS.platformVersion,
        architecture: REAL_SIGNALS.architecture,
        bitness: REAL_SIGNALS.bitness,
        model: REAL_SIGNALS.model,
        uaFullVersion: REAL_SIGNALS.uaFullVersion,
      })
    const navigator = Object.assign(new (Navigator as unknown as new () => object)(), {
      platform: REAL_SIGNALS.navigatorPlatform,
      languages: REAL_SIGNALS.languages,
    })
    const sandbox: Record<string, unknown> = { Navigator, navigator, Promise }
    const raw = await vm.runInContext(source, vm.createContext(sandbox))
    const real = parseIdentitySignals(raw)
    assert.ok(real, '读回来的应当能解析成信号；解析不出来说明脚本没真跑通')
    assert.equal(real!.native, true)
    assert.equal(brandPairs(real!.brands), 'Not?A_Brand=99 Chromium=130', '读数必须是真实品牌，不含 Google Chrome')
    assert.equal(real!.platformVersion, '19.0.0', '高熵值要等 promise 落回来，不能读成空')
    assert.equal(real!.navigatorPlatform, 'Win32')
    assert.equal(real!.languages.join(','), 'zh-CN,zh')
  })

  await it('读数不是证据就别进缓存：getter 已被改写、或读不全时返回 null', () => {
    assert.equal(parseIdentitySignals(''), null)
    assert.equal(parseIdentitySignals(undefined), null)
    assert.equal(parseIdentitySignals('{}'), null)
    assert.equal(parseIdentitySignals('not json'), null)
    assert.equal(parseIdentitySignals(JSON.stringify({ ...REAL_SIGNALS, native: false })), null)
    assert.equal(parseIdentitySignals(JSON.stringify({ ...REAL_SIGNALS, brands: [] })), null)
    assert.equal(parseIdentitySignals(JSON.stringify({ ...REAL_SIGNALS, platform: '' })), null)
    const ok = parseIdentitySignals(JSON.stringify(REAL_SIGNALS))
    assert.ok(ok)
    assert.equal(ok!.model, '', '机型本来就是空串（桌面 Chrome 如此），不该当成读失败')
  })

  await it('CDP 覆盖参数：只补 Google Chrome 一枚品牌，其余字段照抄内核', () => {
    const o = buildUserAgentOverride(REAL_SIGNALS, chromeUserAgent('130'), '130', '130.0.6723.191')
    assert.ok(o)
    const m = o!.userAgentMetadata as Record<string, unknown>
    assert.equal(o!.userAgent, chromeUserAgent('130'))
    assert.equal(brandPairs(m.brands), 'Google Chrome=130 Chromium=130 Not?A_Brand=99')
    assert.equal(
      brandPairs(m.fullVersionList),
      'Google Chrome=130.0.6723.191 Chromium=130.0.6723.191 Not?A_Brand=99.0.0.0',
    )
    assert.equal(m.platform, 'Windows')
    assert.equal(m.platformVersion, '19.0.0', '平台版本是编造高发点：内核没报的字段不许自己填一个')
    assert.equal(m.architecture, 'x86')
    assert.equal(m.bitness, '64')
    assert.equal(m.model, '')
    assert.equal(m.uaFullVersion, '130.0.6723.191')
    // 顶上的 platform 字段是 navigator.platform 的覆盖值，与元数据里的 Windows 是两套口径
    assert.equal(o!.platform, 'Win32')
    assert.equal(o!.acceptLanguage, 'zh-CN,zh')
    assert.doesNotMatch(String(o!.acceptLanguage), /q=/, '带 q 值会污染 navigator.languages，得到 ["zh-CN","zh;q=0.9"] 这种真浏览器没有的形态')
  })

  await it('覆盖参数的边界：读不到就不覆盖，缺高熵值时退回短清单口径', () => {
    assert.equal(buildUserAgentOverride(null, chromeUserAgent('130'), '130', '130.0.6723.191'), null)
    assert.equal(buildUserAgentOverride(REAL_SIGNALS, null, '130', '130.0.6723.191'), null)
    const noHigh = buildUserAgentOverride(
      { ...REAL_SIGNALS, fullVersionList: [], uaFullVersion: '', navigatorPlatform: '', languages: [] },
      chromeUserAgent('130'),
      '130',
      '130.0.6723.191',
    )
    assert.ok(noHigh)
    const m = noHigh!.userAgentMetadata as Record<string, unknown>
    assert.equal(m.fullVersionList, undefined, '内核没报全版本清单就别冒充：拿短清单补出会自相矛盾的形态')
    assert.equal(m.uaFullVersion, '130.0.6723.191', '全版本号至少与内核版本派生的那一份同源')
    assert.equal(noHigh!.platform, undefined, 'navigator.platform 没读到就不覆盖，别猜一个 Win32')
    assert.equal(noHigh!.acceptLanguage, undefined, '语言列表空就别覆盖，把站点的兜底口径留给浏览器自己')
  })

  await it('请求头字典：按键名小写比对，只动该动的两枚', () => {    const headers: Record<string, string | string[]> = {
      'sec-ch-ua': ELECTRON_SEC_UA,
      Cookie: 'SID=1',
      Accept: '*/*',
    }
    assert.equal(patchRequestHeaders(headers, '130', '130.0.6723.191'), true)
    assert.equal(headers['sec-ch-ua'], CHROME_SEC_UA)
    assert.equal(headers.Cookie, 'SID=1', '与身份无关的头一律不碰')
    // HTTP/2 传下来的是小写，但字典原样进 handler：大小写敏感地比对等于漏改
    const upper: Record<string, string | string[]> = { 'Sec-CH-UA': ELECTRON_SEC_UA }
    assert.equal(patchRequestHeaders(upper, '130', '130.0.6723.191'), true)
    assert.equal(upper['Sec-CH-UA'], CHROME_SEC_UA, '改写要落回原来那个键，而不是另起一枚小写键')
    const none: Record<string, string | string[]> = { Accept: '*/*' }
    assert.equal(patchRequestHeaders(none, '130', '130.0.6723.191'), false)
    const fullList: Record<string, string | string[]> = { 'sec-ch-ua-full-version-list': ELECTRON_FULL_LIST }
    assert.equal(patchRequestHeaders(fullList, '130', '130.0.6723.191'), true)
    assert.match(String(fullList['sec-ch-ua-full-version-list']), /"Google Chrome";v="130\.0\.6723\.191"/)
  })

  await it('分区判定：只认 persist:torra-，主窗口界面（defaultSession）不在其列', () => {
    assert.equal(isTorraPartition('persist:torra-gemini'), true)
    assert.equal(isTorraPartition('persist:torra-picker'), true, '选择器/登录窗口用的是独立分区')
    assert.equal(isTorraPartition('persist:torra-user-7'), true, '自建网页模型的分区同样是 torra 前缀')
    assert.equal(isTorraPartition(''), false, '主窗口没有独立分区：给它挂调试器既没好处，还会抢走验证脚本的 CDP target')
    assert.equal(isTorraPartition(undefined), false)
    assert.equal(isTorraPartition('persist:other'), false)
    assert.equal(isTorraPartition('torra-gemini'), false, '缺 persist: 前缀说明不是落盘分区')
  })

  await it('Google 拒绝页认得准：不与普通登录页混为一谈', () => {
    assert.equal(
      isGoogleSignInRejected(
        'https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fgemini.google.com%2F&flowName=GlifWebSignIn',
      ),
      true,
    )
    assert.equal(isGoogleSignInRejected('https://accounts.google.com/ServiceLogin?hl=zh'), false)
    assert.equal(isGoogleSignInRejected('https://accounts.google.com/v3/signin/identifier'), false)
    assert.equal(isGoogleSignInRejected('https://accounts.google.com/v3/signin/rejectedfoo'), false, '前缀巧合不算')
    assert.equal(isGoogleSignInRejected('https://evil.example/x?u=https://accounts.google.com/v3/signin/rejected'), false)
    assert.equal(isGoogleSignInRejected(''), false)
  })

  await it('登录页判定：一个口径，判定与导航日志共用', () => {
    assert.equal(isLoginPageUrl('https://accounts.google.com/v3/signin/identifier?continue=x'), true)
    assert.equal(isLoginPageUrl('https://gemini.google.com/signin?continue=%2Fapp'), true)
    assert.equal(isLoginPageUrl('https://claude.ai/login?from=logout&returnTo=%2Fnew'), true)
    assert.equal(isLoginPageUrl('https://chat.qwen.ai/'), false)
    assert.equal(isLoginPageUrl('https://example.com/author-me'), false, '路径段巧合不算')
    assert.equal(isLoginPageUrl(''), false)

    /*
     * 站点用 replaceState 把用户从内容页挪到登录页时不会有 did-finish-load，
     * 而旧的导航日志整行跳过原地导航 —— 于是「内容页加载正常」与「其实已掉回登录页」
     * 在日志里完全同形。补一条 nav-signin，并让判定与日志读同一枚谓词。
     */
    const poolSrc = readSrc('src/main/webview/pool.ts')
    assert.match(poolSrc, /isLoginPageUrl\(String\(url\)\)/, '导航日志要用同一个谓词')
    assert.match(poolSrc, /stage: 'nav-signin'/)
    const inPlaceAt = poolSrc.indexOf('if (isInPlace) {')
    const startAt = poolSrc.indexOf("stage: 'nav-start'")
    assert.ok(inPlaceAt > 0 && startAt > inPlaceAt, '原地导航要在 nav-start 之前自行返回：它不该把 navState 拍回 loading')
    assert.match(poolSrc, /if \(isLoginPageUrl\(url\)\) \{/, 'inspectLogin 不再自带一份正则')
    assert.doesNotMatch(poolSrc, /\/\(sign_\?in\|sign_\?up\|login\|register\|auth\)/, '正则只许留在 chrome-identity.ts 一处')
  })

  await it('调试器接管后，站点弹窗不会把这一页吊死', () => {
    assert.deepEqual(dialogAnswerFor('alert'), { accept: true }, 'alert 只需消失')
    assert.deepEqual(dialogAnswerFor('confirm'), { accept: false }, '不能替用户点确定')
    assert.deepEqual(dialogAnswerFor('prompt'), { accept: false })
    assert.deepEqual(dialogAnswerFor(undefined), { accept: false })
    const src = readSrc('src/main/webview/chrome-identity.ts')
    assert.match(src, /Page\.javascriptDialogOpening/)
    assert.match(src, /Page\.handleJavaScriptDialog/, 'attach 之后没人应答 = 页面停在弹窗上，表现为通道卡死')
  })

  await it('接线：会话层先认领，文档层再由钩子补到每一枚内嵌 webContents', () => {
    const index = readSrc('src/main/index.ts')
    assert.match(index, /from '\.\/webview\/chrome-identity'/)
    const at = index.indexOf("app.on('web-contents-created', (")
    assert.ok(at > 0, '找不到 web-contents-created 钩子本体（注释里那句不算）')
    const hook = index.slice(at, at + 1200)
    assert.match(hook, /torraPartitionOf\(ses\)/, '身份按认领判：WebContents 上没有 partition 可读')
    assert.match(hook, /if \(embedded\) void spoofDocumentIdentity\(contents, embedded\)/)
    assert.ok(
      !/applyChromeIdentity/.test(hook),
      '钩子不认领分区：认领只发生在池与登录窗口，主窗口界面因此永远不会被挂上调试器',
    )
    assert.ok(
      index.indexOf('spoofDocumentIdentity(contents,') < index.indexOf('contents.setWindowOpenHandler'),
      '身份要在弹窗闸门之前装好：登录流程的第一次导航可能比 handler 更早',
    )
    assert.ok(
      index.indexOf('hardenEmbeddedContents()') < index.indexOf('app.whenReady()'),
      '钩子必须在任何窗口诞生之前登记：晚一步，第一枚 webContents 就带着未伪装的身份出生',
    )

    const pool = readSrc('src/main/webview/pool.ts')
    assert.match(pool, /applyChromeIdentity\(ses, part\)/)
    assert.match(pool, /applyChromeIdentity\(session\.fromPartition\(part\), part\)/, '登录窗口与后台实例同一口径')
    assert.doesNotMatch(pool, /\.setUserAgent\(/, 'UA 只有一个出口，改版本不必再翻两处')
    assert.doesNotMatch(pool, /Chrome\/\d/, '池里不该再留硬编码内核版本')
    assert.doesNotMatch(pool, /CHROME_UA/, '旧的常量已经由 chrome-identity.ts 派生取代')
    assert.ok(
      pool.indexOf('applyChromeIdentity(ses, part)') < pool.indexOf('new WebContentsView('),
      '认领必须早于建视图：钩子是在构造那一刻查认领记录的',
    )
    const loginAt = pool.indexOf('  openLoginWindow(')
    const loginBody = pool.slice(loginAt, loginAt + 1200)
    assert.ok(
      loginBody.indexOf('applyChromeIdentity') >= 0 && loginBody.indexOf('applyChromeIdentity') < loginBody.indexOf('new BrowserWindow('),
      '认领必须早于建窗口，否则登录窗口自己拿不到品牌补丁',
    )
    assert.match(pool, /isGoogleSignInRejected\(url\)/, '拒绝页要单独给结论，别让用户对着登录框空转')

    const identity = readSrc('src/main/webview/chrome-identity.ts')
    assert.match(identity, /process\.versions/, '版本号从内核派生，Electron 升级后不会与真实品牌错位')
    assert.doesNotMatch(identity, /Chrome\/\d/, '本文件里不该出现写死的内核版本：读不到就明说不伪装，不编一个')
  })

  await it('唤醒页：本地一个空文件就够，但它必须是安全上下文才读得到真实信号', () => {
    /*
     * 实测：about:blank 与 data: 页面的 isSecureContext 都是 false，那份文档里
     * 根本没有 navigator.userAgentData —— 拿它们当唤醒页，内核级覆盖每次都静默
     * 退化成 JS 补丁（就是这次要修的破绽）。file:// 是安全上下文，brands /
     * fullVersionList / platformVersion 全能读回来。
     */
    const dir = path.join(os.tmpdir(), 'torra-wake-test-' + process.pid)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    try {
      const url = wakeDocumentUrl(dir)
      assert.ok(url, '给了可写目录就该造出唤醒页地址')
      assert.ok(url!.startsWith('file:///'), '必须是 file: 协议才落在安全上下文里')
      assert.ok(url!.endsWith(WAKE_FILE_NAME))
      assert.equal(isWakeDocument(url!), true)
      assert.equal(isWakeDocument('about:blank'), true, '造不出唤醒页时退回空白页：照样能叫醒渲染进程，只是读不回信号')
      assert.equal(isWakeDocument(''), false)
      assert.equal(isWakeDocument('https://gemini.google.com/app'), false, '业务地址绝不算唤醒页')
      assert.equal(isWakeDocument('file:///C:/Users/x/other.html'), false)
      // 已存在时不重复写：每次 prime 都重刷一遍磁盘没有意义
      const again = wakeDocumentUrl(dir)
      assert.equal(again, url)
      assert.equal(wakeDocumentUrl(null), null)
      assert.equal(wakeDocumentUrl(path.join(dir, 'nope', 'deeper')), null, '目录造不出来就退回 null，由调用方降级')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('接线：第一次业务导航要等文档层补丁落地，否则第一个文档读不到品牌', () => {
    /*
     * 这一条是踩过现场之后补的：`addScriptToEvaluateOnNewDocument` 只管它之后新建的文档，
     * 而这条命令要等渲染进程活着才 resolve —— 于是「建完视图就 loadURL」的那份文档
     * 永远缺品牌。实测（本机 Electron 33，本地回显服务）：不 priming 时
     * 文档#1 的品牌列表只有 Chromium，文档#2 才有 Google Chrome；
     * prime 之后文档#1 就齐了。登录页恰好就是文档#1。
     */
    const src = readSrc('src/main/webview/chrome-identity.ts')
    assert.match(src, /export async function primeDocumentIdentity/)
    assert.match(src, /about:blank/, '造不出唤醒页时的降级：空白页照样能叫醒渲染进程')
    assert.match(src, /pathToFileURL/, '唤醒页地址要用 pathToFileURL 生成：用户名里带空格时手拼的 file: 地址根本不合法')
    assert.match(src, /Promise\.race/, '补丁确认不能无限期押住站点加载')
    assert.match(src, /ARM_TIMEOUT_MS/, '超时要有名字，不要散落一个字面量')
    assert.match(src, /const ticket = documentArmed\.get\(contents\)/, '同一枚 contents 只 attach 一次')
    /*
     * prime 内部的顺序：唤醒导航必须排在补丁登记之前。
     * BrowserWindow 一出生就停在 about:blank 上，先登记的话，补丁与覆盖读到的
     * 都是那份非安全上下文里的空值 —— 内核级覆盖就此静默退化成 JS 补丁。
     */
    const primeBody = src.slice(src.indexOf('export async function primeDocumentIdentity'))
    const wakeAt = primeBody.indexOf("loadURL(wakeDocumentUrl(safeUserDataDir())")
    const spoofAt = primeBody.indexOf('spoofDocumentIdentity(contents, subject)')
    assert.ok(wakeAt >= 0 && spoofAt >= 0, 'prime 里既要有唤醒导航也要有补丁登记')
    assert.ok(wakeAt < spoofAt, '先唤醒到安全上下文，再登记补丁：顺序反了就读不到真实信号')
    assert.match(primeBody, /current === 'about:blank'/, 'BrowserWindow 出生就在 about:blank 上，这也要当「还没有页面」处理')

    const pool = readSrc('src/main/webview/pool.ts')
    const ensureAt = pool.indexOf('applyChromeIdentity(ses, part)')
    // 右边界用下一条声明的名字，不用 `return view`：
    // prime 之后那句 `return view.webContents.loadURL(...)` 也以前缀 return view 开头，
    // 拿它当右边界会把入场导航整段切掉，变成一条永远不可能满足的断言。
    const body = pool.slice(ensureAt, pool.indexOf('  get(modelId', ensureAt))
    assert.ok(
      body.indexOf('primeDocumentIdentity(view.webContents, part)') >= 0 &&
        body.indexOf('primeDocumentIdentity(view.webContents, part)') <
          body.indexOf('loadURL(adapter.spec.entry)'),
      '池视图的入场导航必须排在 prime 之后',
    )
    // 同样按声明名取右边界，但要的是**下一条**声明：
    // 切片起点 'openLoginWindow(' 先命中文件头注释里的那句话，
    // 最近的 'return login' 落在它前面，slice 会变成空串（注释里提过的 onClosed 那处不算）。
    const loginAt = pool.indexOf('  openLoginWindow(')
    const loginBody = pool.slice(loginAt, pool.indexOf('  watchLogin', loginAt))
    assert.ok(
      loginBody.indexOf('primeDocumentIdentity(login.webContents, part)') >= 0 &&
        loginBody.indexOf('primeDocumentIdentity(login.webContents, part)') <
          loginBody.indexOf('loadURL(url)'),
      '登录页就是那个「第一个文档」，不能让它带着未伪装的品牌出生',
    )
    assert.doesNotMatch(loginBody, /^\s*void login\.loadURL\(/m, '不许留一条绕过 prime 的直发导航')
    assert.match(pool, /!e\.priming/, 'priming 期间的空白页不是「什么都没加载出来」，present 不能抢着补导')
  })

  await it('接线：先试内核覆盖，补丁总是登记但只对缺品牌的那份文档动手', () => {
    /*
     * 两份都在场时，defineProperty 造的 getter 会盖住原生实现 —— 那正是覆盖要修的破绽。
     * 所以补丁里加了自检：品牌已经对了就原样退出。这样它只剩一件事可做：
     * 补上覆盖赶不及的那份文档（站点 window.open 的登录弹窗，第一个文档在覆盖落地前
     * 就开始跑脚本了）。
     */
    const src = readSrc('src/main/webview/chrome-identity.ts')
    assert.match(src, /Network\.enable/, 'setUserAgentOverride 之前必须开 Network 域，否则命令被拒')
    assert.match(src, /Network\.setUserAgentOverride/)
    assert.match(src, /Runtime\.evaluate/, '真实信号要从页面里读回来，不能在 Node 侧猜')
    assert.ok(
      src.indexOf('applyNativeOverride(contents, subject)') < src.indexOf('Page.addScriptToEvaluateOnNewDocument'),
      '覆盖要排在补丁登记之前：晚登记的话，第一份文档就没有原生 getter 可言',
    )
    assert.match(src, /realIdentity\.get\(contents\.session\)/, '按 session 缓存：站点自己 window.open 的弹窗没机会重读真实信号')
    assert.doesNotMatch(src, /Chrome\/\d/, '本文件里不该出现写死的内核版本')

    // 补丁的自检：真实品牌里已有 Google Chrome 时不得换掉 getter
    const source = userAgentDataPatchScript('130', '130.0.6723.191', 'Windows')
    const Navigator = function Navigator(this: unknown) {}
    const real = {
      brands: [
        { brand: 'Google Chrome', version: '130' },
        { brand: 'Chromium', version: '130' },
      ],
      mobile: false,
      platform: 'Windows',
    }
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true,
      get: () => real,
    })
    const sandbox: Record<string, unknown> = { Navigator, navigator: new (Navigator as unknown as new () => object)() }
    vm.runInContext(source, vm.createContext(sandbox))
    assert.equal(
      Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgentData')!.get!() === real,
      true,
      '内核已经报对了品牌，补丁就不许再把 getter 换成自己造的那一份',
    )
  })

  console.log('-'.repeat(46))
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46))
  if (fail > 0) process.exit(1)
}

void main()
