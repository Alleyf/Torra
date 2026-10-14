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
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
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
    const sendBody = src.slice(src.indexOf('async send('))
    assert.ok(sendBody.includes('requireEntryOrigin'), 'send() 里必须真的调了闸门')
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

  console.log(`\norigin-guard: ${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
