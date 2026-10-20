/**
 * 网页通道发送前同源闸门的离线回归
 *
 * 「注入 → 键入 → 按发送」假定当前文档就是适配器声明的站点。页面自己的跳转脚本、
 * 广告重定向、用户自建模型里填的入口，都可能把 top frame 带到别的域 —— 那时整场
 * 研讨的上下文会被原样键进别人的页面，而读回来的是对方想让我们看到的东西。
 * 判错不是报错，是静默外泄，所以这道判定必须逐条钉死。
 *
 * 钉死两层：
 * - 纯函数层：origin 比较的边界（子域、协议、端口、空白页、伪后缀、非法入口）；
 * - 接线层：闸门确实排在注入之前、拒绝时抛错而不是继续、纠正只拉回声明入口。
 *
 * 运行：npm run test:origin-guard
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isEntryOrigin, originOf } from '../src/main/webview/origin'

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

const ENTRY = 'https://chatgpt.com/'

async function main(): Promise<void> {
  console.log('\n── originOf / isEntryOrigin 的边界')

  await it('同站不同路径算同源（会话页、子页面都能继续）', () => {
    assert.equal(isEntryOrigin(ENTRY, 'https://chatgpt.com/c/2026-10-14-abcd'), true)
  })

  await it('换域就拦：攻击者域名与研讨入口不同源', () => {
    assert.equal(isEntryOrigin(ENTRY, 'https://torra-relay.evil.test/chat'), false)
  })

  await it('伪后缀骗不过：chatgpt.com.evil.test 不是 chatgpt.com', () => {
    assert.equal(isEntryOrigin(ENTRY, 'https://chatgpt.com.evil.test/'), false)
  })

  await it('子域不算同源（api.chatgpt.com ≠ chatgpt.com）', () => {
    assert.equal(isEntryOrigin(ENTRY, 'https://api.chatgpt.com/v1'), false)
  })

  await it('协议降级不算同源（http ≠ https）', () => {
    assert.equal(isEntryOrigin(ENTRY, 'http://chatgpt.com/'), false)
  })

  await it('端口不同不算同源', () => {
    assert.equal(originOf('https://chatgpt.com:8443/'), 'https://chatgpt.com:8443')
    assert.equal(isEntryOrigin(ENTRY, 'https://chatgpt.com:8443/'), false)
  })

  await it('空白页 / 错误页 / about:blank 都判不在站点上', () => {
    // new URL('about:blank').origin 是字符串 'null' 而不是抛错：不归空就会与怪值相等
    assert.equal(originOf('about:blank'), '')
    assert.equal(originOf(''), '')
    assert.equal(isEntryOrigin(ENTRY, 'about:blank'), false)
    assert.equal(isEntryOrigin(ENTRY, 'chrome-error://chromewebdata/'), false)
  })

  await it('入口本身非法时不放行（判不同源，交给 adapter-broken 分支）', () => {
    assert.equal(originOf('not-a-url'), '')
    assert.equal(isEntryOrigin('', ENTRY), false)
    assert.equal(isEntryOrigin('javascript:alert(1)', ENTRY), false)
  })

  await it('file:// 与 data: 不是可用入口', () => {
    assert.equal(isEntryOrigin('file:///C:/x.html', 'https://chatgpt.com/'), false)
    assert.equal(originOf('data:text/html,hi'), '')
  })

  console.log('\n── 接线层：闸门在发送链上的位置')

  await it('闸门排在注入之前，且注入前不再有别的执行路径', () => {
    const src = readSrc('src/main/agents/webview-agent.ts')
    assert.match(
      src,
      /await this\.requireEntryOrigin\(view, ctx\.sessionId\)\s*\n\s*await this\.ensureInjected\(\)/,
      '注入就是往当前文档放我们的代码，闸门必须在它前面',
    )
    /*
     * 投递这半边被两个入口共用：send()（提取，还要读回正文）与 deliverNative()
     *（原生，递到就收工）。闸门必须住在共用的 deliverTurn 里，两个入口都只能经由它投递
     * —— 少钉一处，就等于某条链路可以自己注入而不问一句「这是不是声明的站点」。
     */
    assert.match(src, /private async deliverTurn/, '投递段要被两个入口共用')
    const turn = src.slice(src.indexOf('private async deliverTurn'))
    assert.ok(turn.includes('this.requireEntryOrigin('), 'deliverTurn 里必须真的调了闸门')
    const sendBody = src.slice(src.indexOf('async send('))
    assert.ok(
      /const d = await this\.deliverTurn\(ctx\)/.test(sendBody),
      'send() 必须经由 deliverTurn 投递，不能自己键字/注入',
    )
    const nativeBody = src.slice(src.indexOf('async deliverNative('), src.indexOf('async locateTurn('))
    assert.ok(
      /await this\.deliverTurn\(ctx\)/.test(nativeBody),
      'deliverNative() 同样要经由 deliverTurn —— 原生模式也是把话键进别人的页面',
    )
    for (const [name, body] of [['send()', sendBody], ['deliverNative()', nativeBody]] as const) {
      assert.ok(!body.includes('this.ensureInjected('), `${name} 里不该再出现第二处注入（那是绕过闸门的路径）`)
    }
    /*
     * 页内定位（点左侧第 N 问 → 右边滚到那一问）第三条自己铺脚本的路。
     * 它不键字、不读正文，看起来 harmless，但注入这一步和发送那条路完全一样：
     * 代码进的是「当前这个文档」，而这一格随时可能被用户点到别的站点（点回答里的外链就会）。
     * 那时无视判据把脚本铺进去、把别站的 DOM 当本站的消息列表读 —— 闸门存在理由正是这个。
     */
    const locateBody = src.slice(src.indexOf('async locateTurn('), src.indexOf('async send('))
    assert.match(
      locateBody,
      /const onSite = isEntryOrigin\(spec\.entry, safeUrl\(view\)\)[\s\S]{0,240}if \(onSite\) \{\s*\n\s*await this\.ensureInjected\(\)/,
      'locateTurn 必须先判源再注入：不判源就等于给定位开了一条绕过闸门的铺脚本通道',
    )
    assert.match(
      locateBody,
      /reason: 'off-site'/,
      '判不过时不能继续读页面：得留下「这一格不在本站」这条结论',
    )
  })

  await it('拒绝时抛 AgentError，而不是带着错页面继续发', () => {
    const src = readSrc('src/main/agents/webview-agent.ts')
    assert.match(src, /已拦下发送/, '拦下要给出看得见的理由')
    assert.match(src, /throw new AgentError\(\s*\n?\s*'channel-error',\s*\n?\s*`\$\{this\.displayName\} 当前页面不在声明的站点上/)
  })

  await it('纠正只拉回声明入口，不会把当前页地址当入口', () => {
    const src = readSrc('src/main/agents/webview-agent.ts')
    assert.match(src, /loadURL\(entry\)/, '纠正目标是适配器入口')
    assert.doesNotMatch(src, /loadURL\(safeUrl\(view\)\)/, '把当前页当入口等于哪都不去')
  })

  await it('入口地址非法时报适配器坏，不是静默跳过', () => {
    const src = readSrc('src/main/agents/webview-agent.ts')
    assert.match(src, /if \(!want\) \{\s*\n\s*throw new AgentError\('adapter-broken'/)
  })

  await it('注册：npm run test:origin-guard 存在且在 npm test 链里', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> }
    assert.match(pkg.scripts['test:origin-guard'] ?? '', /test-origin-guard\.ts/)
    assert.match(pkg.scripts.test ?? '', /run-tests/, 'npm test 必须走汇总跑法')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
