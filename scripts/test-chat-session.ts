/**
 * 「另起一场」这条链路的离线回归
 *
 * 聊天模式的原生视图里，上下文不在客户端，而在站点那一页。所以「新开会话」必须有
 * 两边：本地换一场，墙上那几枚网页面板同时开回站点入口 —— 只换本地那场，DeepSeek、
 * 元宝照旧带着上一场全部内容，这颗按钮就是空的。
 *
 * 这条链路最容易坏在三个地方，逐条钉：
 * - 已在入口就别动，停在上一场的会话页却要动：判据是「同一个页面」而不是「同一个站」；
 * - 不许为了换一场去重建实例或拉起实例（登录态会跟着没，250MB 也会凭空多出来）；
 * - 每一格的结果要指得出是谁、为什么，界面不能只说一句「已新开会话」。
 *
 * 运行：npm run test:chat-session
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WebviewAgent } from '../src/main/agents/webview-agent'
import { diag } from '../src/main/diagnostics/log'
import { isSamePage } from '../src/main/webview/origin'

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

const ENTRY = 'https://example.chat/'

/**
 * 一枚会记账的假 WebView 池。
 *
 * 只实现 openFreshConversation 真正碰到的四个口子（get / waitReady / ensure / loadURL），
 * 其余一律不敢调用：ensure 与 recreate 直接抛，好让「顺手拉起实例」这种走样当场暴露，
 * 而不是悄悄通过。land 决定导航落地后页面停在哪，用它区分「开回了」与「被站点弹走」。
 */
function makeAgent(opts: {
  entry?: string
  url?: string
  land?: string
  status?: string
  view?: boolean
} = {}) {
  const entry = opts.entry ?? ENTRY
  const state = {
    url: opts.url ?? entry,
    loaded: [] as string[],
    ensured: 0,
    readyWaits: 0,
  }
  const view = {
    webContents: {
      getURL: () => state.url,
      loadURL: (target: string) => {
        state.loaded.push(target)
        state.url = opts.land ?? target
        return Promise.resolve()
      },
    },
  }
  const pool = {
    get: () => (opts.view === false ? undefined : (view as never)),
    waitReady: async () => {
      state.readyWaits++
    },
    ensure: () => {
      state.ensured++
      throw new Error('不该为新开会话拉起实例')
    },
  }
  const adapter = { spec: { entry, health_probe: [] as string[], selectors: {} as Record<string, string> } }

  const agent = Object.create(WebviewAgent.prototype) as unknown as Record<string, unknown>
  Object.assign(agent, {
    id: 'web_a',
    displayName: '示例站',
    color: '#8a7cff',
    transport: 'webview',
    status: opts.status ?? 'ready',
    pool,
    adapter,
    partition: 'persist:torra-web_a',
  })
  return { agent: agent as unknown as WebviewAgent, state }
}

async function main(): Promise<void> {
  console.log('\n── 页面判据：同站不等于同页')

  await it('入口与它的会话页不是同一个页面', () => {
    assert.equal(isSamePage('https://example.chat/', 'https://example.chat/s/42'), false)
  })

  await it('只差结尾斜杠算同一页（别让一次多余导航白闪一下）', () => {
    assert.equal(isSamePage('https://example.chat/', 'https://example.chat'), true)
  })

  await it('查询串参与判定：?new=1 与首页不是一个页面', () => {
    assert.equal(isSamePage('https://example.chat/', 'https://example.chat/?new=1'), false)
    assert.equal(isSamePage('https://example.chat/?new=1', 'https://example.chat/?new=1'), true)
  })

  await it('换站一定不同页；空白页不与任何入口相等', () => {
    assert.equal(isSamePage('https://example.chat/', 'https://evil.chat/'), false)
    assert.equal(isSamePage('https://example.chat/', 'about:blank'), false)
    assert.equal(isSamePage('', 'https://example.chat/'), false)
  })

  console.log('\n── openFreshConversation 的实际动作')

  await it('停在上一场的会话页：导航回入口，并说清是真的重开了', async () => {
    const { agent, state } = makeAgent({ url: 'https://example.chat/s/42' })
    const r = await agent.openFreshConversation!()
    assert.deepEqual(state.loaded, [ENTRY], '该导航一次，且导航的就是适配器入口')
    assert.equal(state.ensured, 0, '不许顺手拉起实例')
    assert.equal(r.ok, true)
    assert.equal(r.reopened, true)
  })

  await it('已经在入口页：什么都不做', async () => {
    const { agent, state } = makeAgent({ url: ENTRY })
    const r = await agent.openFreshConversation!()
    assert.deepEqual(state.loaded, [], '白刷一次页面会打断用户正在读的内容')
    assert.equal(state.readyWaits, 0)
    assert.equal(r.ok, true)
    assert.equal(r.reopened, undefined, '没重开就别报 reopened')
  })

  await it('实例不在场时空操作：不为一屏没在看的页面拉起 WebView', async () => {
    const { agent, state } = makeAgent({ view: false })
    const r = await agent.openFreshConversation!()
    assert.equal(r.ok, true)
    assert.equal(state.ensured, 0)
    assert.deepEqual(state.loaded, [])
  })

  await it('正在发言时不抽走这一页', async () => {
    const { agent, state } = makeAgent({ url: 'https://example.chat/s/42', status: 'busy' })
    const r = await agent.openFreshConversation!()
    assert.equal(r.ok, false)
    assert.match(r.reason || '', /正在发言中/)
    assert.deepEqual(state.loaded, [], '半途换页等于把正在跑的轮次抽走')
  })

  await it('入口不是合法地址：照实说，不拿空串去导航', async () => {
    const { agent, state } = makeAgent({ entry: '' })
    const r = await agent.openFreshConversation!()
    assert.equal(r.ok, false)
    assert.match(r.reason || '', /不是合法地址/)
    assert.deepEqual(state.loaded, [])
  })

  await it('站点把人弹到别处：失败结论里说得出是哪一格、停在哪', async () => {
    const { agent, state } = makeAgent({ url: 'https://example.chat/s/42', land: 'https://other.test/login' })
    const r = await agent.openFreshConversation!()
    assert.equal(r.ok, false)
    assert.match(r.reason || '', /示例站/)
    assert.match(r.reason || '', /没能开回/)
    assert.equal(state.ensured, 0)
    assert.equal(state.loaded.length, 1, '判不过就是判不过，别反复硬导航')
  })

  await it('每次重开都在诊断里留一条 fresh-conversation', async () => {
    const { agent } = makeAgent({ url: 'https://example.chat/s/77' })
    await agent.openFreshConversation!()
    const hit = diag.tail(50).find((e) => e.stage === 'fresh-conversation' && e.subject === 'web_a')
    assert.ok(hit, '界面上说「开回来了」却没有任何记录，事后无从核对')
    assert.equal(hit!.ok, true)
  })

  console.log('\n── 接线层：主进程、preload、界面三层都在线上')

  await it('IPC 只把网页通道当网页通道，参数不当字符串就拒', () => {
    const main = readSrc('src/main/index.ts')
    const handler = main.slice(main.indexOf("ipcMain.handle('webview:fresh'"), main.indexOf("ipcMain.handle('webview:fresh'") + 900)
    assert.match(handler, /typeof modelId !== 'string' \|\| !modelId/, '参数校验不是可选的')
    assert.match(handler, /agent\.transport !== 'webview'/, 'API 通道没有网页，别给它找网页通道')
    assert.match(handler, /if \(!agent\.openFreshConversation\) return \{ ok: false, reason: '网页通道异常' \}/,
      '通道异常时要有兜底结论，不是把 undefined 丢回渲染层')
    assert.match(handler, /return agent\.openFreshConversation\(\)/)
    assert.doesNotMatch(handler, /recreate\(|ensure\(/, '这颗按钮不许换成重建实例那条路')
  })

  await it('preload 暴露的函数名与频道路线一致', () => {
    const pre = readSrc('src/preload/index.ts')
    assert.match(pre, /webviewFresh:[\s\S]{0,240}ipcRenderer\.invoke\('webview:fresh'/)
  })

  await it('两个入口共用同一段动作，且新会话不叠空壳、不清草稿', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    const body = page.slice(page.indexOf('const addChat = () => {'), page.indexOf('const openFreshWebPanes'))
    assert.ok(body.length > 40, 'addChat 与 openFreshWebPanes 之间就是这颗按钮的全部语义')
    assert.match(body, /active\.turns\.length === 0/, '已经站在空会话上就别再叠一层壳')
    assert.doesNotMatch(body, /setInput\(/, '点按钮的人大概率已经把下一个问题打在框里了，清草稿等于让他重打')
    assert.doesNotMatch(body, /confirm\(|removeChat\(/, '旧那场要留在列表里随时切得回去')
    const shared = (page.match(/onClick=\{addChat\}/g) || []).length
    assert.ok(shared >= 2, `会话栏与输入坞要走同一段动作，现在只有 ${shared} 处`)
  })

  await it('输入坞那颗按钮确实存在，且说的是「两边一起换」', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /className="cx-icon-btn cx-new-chat"/)
    assert.match(page, /title="另起一场[^"]*网页[^"]*开回站点[^"]*"/, 'title 必须说清网页那几格也会动')
    assert.match(page, /MessageSquarePlus/, 'lucide 图标没 import 会在运行时才炸')
  })

  await it('网页那几格逐枚调用，失败时点得出是谁', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    const body = page.slice(page.indexOf('const openFreshWebPanes'), page.indexOf('const removeChat'))
    assert.match(body, /window\.torra\.webviewFresh\(id\)/)
    assert.match(body, /webTargets\.map\(\(m\) => m\.id\)/, '只动在场的网页模型')
    assert.match(body, /failed\.push\(r\.reason\)/, '主进程给的结论要原样带出来')
    assert.match(body, /displayName/, '异常那条要说得出是哪一格')
    assert.match(body, /if \(r\?\.reopened\) reopened\+\+/, '动过页面和没动页面必须分得出来')
    assert.match(body, /if \(reopened > 0\) flash\(/, '刷掉了用户正在读的那几页就要留一句话')
    assert.match(body, /flash\(`已另起一场，但网页那几格没全开回来[\s\S]{0,120}'warn'\)/, '汇总提示要走故障分量')
  })

  await it('提示分两种分量：说明不该借用故障色', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /const flash = \(msg: string, tone: NoteTone = 'warn'\)/)
    assert.match(page, /cx-dock-note\$\{composerNote\.tone === 'info' \? ' info' : ''\}/)
    const css = readSrc('src/renderer/styles.css')
    assert.match(css, /\.cx-dock-note\.info \{ color: var\(--text-3\); \}/)
    assert.match(css, /\.cx-new-chat \{/)
    assert.match(css, /\.cx-dock\.bar \.cx-attach, \.cx-dock\.bar \.cx-send, \.cx-dock\.bar \.cx-new-chat \{ margin-bottom: 0; \}/,
      '收起态那一行里新按钮别比发送高出一截')
  })

  await it('适配器接口把这一步声明成可选：API 通道没有网页', () => {
    const api = readSrc('src/main/agents/agent.ts')
    assert.match(api, /openFreshConversation\?\(\)/, '接口上是可选的，调用方才需要兜底')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
