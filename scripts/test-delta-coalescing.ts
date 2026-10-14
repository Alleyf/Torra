/**
 * 流式增量合并的离线回归（不需要 Electron）
 *
 * 旧路径是逐 token 各拷一遍 utterances 数组、各触发一次 set：一条 1500 字的
 * 回答就是 750 次全树重排，复制量还随正文长度平方增长。现在 App 按 60ms 窗口
 * 攒批，一批 chunk 只落一次更新。
 *
 * 钉死两层：
 * - 纯函数层：一批只换一次数组引用、正文/思考/步骤三条流互不顶掉、新条目按当前轮创建；
 * - 接线层：App 确实攒批并且在非增量事件前冲账，store 里不许再留逐 token 的整数组拷贝。
 *
 * 运行：npm run test:delta-coalescing
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { appendDeltas, type DeltaBatchItem, type DeltaState } from '../src/renderer/deltaMerge'
import type { UiUtterance } from '../src/renderer/store'

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

type StreamState = DeltaState

const ut = (over: Partial<UiUtterance>): UiUtterance =>
  ({
    id: 'u1',
    round: 1,
    agentId: 'a',
    content: '',
    targets: [],
    streaming: true,
    absent: false,
    ...over,
  }) as UiUtterance

const stream = (utterances: UiUtterance[], round = 1): StreamState => ({ utterances, round })

async function main(): Promise<void> {
  console.log('appendDeltas：一批增量落成一次更新')

  await it('同一批里的多个 chunk 全部落地，未涉及的条目保持同一引用', () => {
    const base = [ut({ id: 'u1' }), ut({ id: 'u2', content: '别人说的' })]
    const batch: DeltaBatchItem[] = [
      { utteranceId: 'u1', agentId: 'a', content: '你' },
      { utteranceId: 'u1', agentId: 'a', content: '好' },
      { utteranceId: 'u1', agentId: 'a', thinking: '先想' },
      { utteranceId: 'u1', agentId: 'a', steps: '再查' },
    ]
    const out = appendDeltas(stream(base), batch)
    assert.equal(out.utterances.length, 2, '合并不得凭空长出发言')
    assert.equal(out.utterances[0]!.content, '你好')
    assert.equal(out.utterances[0]!.thinking, '先想')
    assert.equal(out.utterances[0]!.steps, '再查')
    assert.equal(out.utterances[1], base[1], '没被这批碰过的条目必须是同一个对象，否则下游 memo 全失效')
  })

  await it('三条流各写各的字段，后到的不顶掉先到的', () => {
    const base = [ut({ id: 'u1', content: '正文', thinking: '思考', steps: '步骤' })]
    const out = appendDeltas(stream(base), [
      { utteranceId: 'u1', agentId: 'a', thinking: '·续想' },
      { utteranceId: 'u1', agentId: 'a', content: '·续写' },
    ])
    assert.equal(out.utterances[0]!.content, '正文·续写')
    assert.equal(out.utterances[0]!.thinking, '思考·续想')
    assert.equal(out.utterances[0]!.steps, '步骤', '这批没有 steps，已流出的步骤不能被抹平')
  })

  await it('推理/步骤先流时按当前轮新建条目，正文随后补齐', () => {
    const out = appendDeltas(stream([], 4), [
      { utteranceId: 'n1', agentId: 'b', thinking: '先流思考' },
      { utteranceId: 'n1', agentId: 'b', content: '再流正文' },
    ])
    assert.equal(out.utterances.length, 1, '同一 utteranceId 不得建出两条')
    assert.equal(out.utterances[0]!.round, 4)
    assert.equal(out.utterances[0]!.agentId, 'b')
    assert.equal(out.utterances[0]!.thinking, '先流思考')
    assert.equal(out.utterances[0]!.content, '再流正文')
    assert.equal(out.utterances[0]!.streaming, true, '流式期间必须仍标 streaming，收尾由 utterance-done 翻')
  })

  await it('一批里多个 utterance 各自归位（并行发言不会串行覆盖）', () => {
    const base = [ut({ id: 'u1', agentId: 'a' }), ut({ id: 'u2', agentId: 'b' })]
    const out = appendDeltas(stream(base), [
      { utteranceId: 'u2', agentId: 'b', content: '乙' },
      { utteranceId: 'u1', agentId: 'a', content: '甲' },
      { utteranceId: 'u2', agentId: 'b', content: '方' },
    ])
    assert.equal(out.utterances[0]!.content, '甲')
    assert.equal(out.utterances[1]!.content, '乙方')
  })

  await it('空批次不改数组引用', () => {
    const base = [ut({ id: 'u1' })]
    const out = appendDeltas(stream(base), [])
    assert.equal(out.utterances.length, 1)
    assert.equal(out.utterances[0]!.content, '')
  })

  console.log('接线层：攒批与冲账的位置')

  await it('App 的监听器按窗口攒增量，并在非增量事件前冲账', () => {
    const app = readSrc('src/renderer/App.tsx')
    assert.match(app, /const buf = new Map<string, DeltaBatchItem>\(\)/, '事件流上要有一块增量缓冲')
    assert.match(app, /setTimeout\(flushDeltas, DELTA_FLUSH_MS\)/, '攒到的增量要有窗口')
    assert.match(app, /s\.applyDeltas\(batch\)/, '落地走合并后的单次更新')
    assert.match(
      app,
      /flushDeltas\(\)[\s\S]{0,80}s\.applyEvent\(e\)/,
      '非增量事件（done/state/error）必须先冲账，否则会把还没落地的 chunk 覆盖掉',
    )
  })

  await it('订阅粒度：没有人再整份订 store', () => {
    const files = [
      'src/renderer/App.tsx',
      'src/renderer/components/ChatPage.tsx',
      'src/renderer/components/InterventionBar.tsx',
      'src/renderer/components/NewSession.tsx',
    ]
    // 只看代码：注释里写着 `useStore()` 不算订阅（App 的切片说明就带着这两个括号）
    const codeOnly = (src: string) =>
      src
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')
    for (const f of files) {
      const src = codeOnly(readSrc(f))
      assert.doesNotMatch(
        src,
        /=\s*useStore\(\s*\)/,
        `${f} 还在整份订阅：合并到 60ms 也救不了它 —— 每次 flush 都要重渲染这一层`,
      )
    }
    // App 是根：它一旦订 utterances，攒批就只是把全树重渲染从 750 次降到 25 次
    const app = readSrc('src/renderer/App.tsx')
    assert.doesNotMatch(app, /^ {6}utterances: st\.utterances,$/m, 'App 的切片不许含 utterances')
    assert.match(
      app,
      /function DiscussModelRail[\s\S]{0,200}useStore\(\(st\) => st\.utterances\)/,
      '增量由左栏自己订，别顺着根往下传',
    )
  })

  await it('流式那一条不解析 Markdown，收尾后才建 AST', () => {
    const plain = readSrc('src/renderer/components/Markdown.tsx')
    assert.match(plain, /export function PlainStream\(/, '要有一个不建 AST 的正文出口')
    assert.doesNotMatch(plain, /export function PlainStream[\s\S]{0,200}ReactMarkdown/, '出口本身不许再走 react-markdown')

    // 三处逐字流正文：正在流的必须走 PlainStream，已完成的可疑（漏改＝每批重解析整篇）
    const sites: [string, RegExp][] = [
      ['src/renderer/components/TopicEvolution.tsx', /u\.streaming \? <PlainStream text=\{u\.content\} \/> : <Markdown text=\{formatSpeech\(u\.content\)\} \/>/],
      ['src/renderer/components/RightPanel.tsx', /streaming \? <PlainStream text=\{text\} \/> : <Markdown text=\{formatSpeech\(text\)\} \/>/],
      ['src/renderer/components/ChatPage.tsx', /cell\.streaming \? \(\s*<PlainStream text=\{cell\.content\} \/>/],
    ]
    for (const [f, re] of sites) {
      assert.match(readSrc(f), re, `${f} 的流式正文还在按批重解析 Markdown`)
    }
    // 聊天页有两处正文（并排网格 + 单列细读），只改一处等于另一半照旧
    const chat = readSrc('src/renderer/components/ChatPage.tsx')
    assert.equal(
      (chat.match(/cell\.streaming \? \(\s*<PlainStream/g) ?? []).length,
      2,
      '聊天页两处正文都得按 streaming 分岔',
    )
  })

  await it('store 里不再留逐 token 的整数组拷贝', () => {
    const store = readSrc('src/renderer/store.ts')
    assert.doesNotMatch(
      store,
      /case 'utterance-delta'[\s\S]{0,300}\[\.\.\.s\.utterances\]/,
      'delta 分支必须走 appendDeltas，逐 token 拷全文是平方级开销',
    )
    assert.match(store, /applyDeltas: \(batch\)/, '合并入口要在 store 上')
    assert.match(store, /case 'thinking-delta':\s*\n\s*return appendDeltas/, '三条流共用同一段合并逻辑')
  })

  await it('注册：npm run test:delta-coalescing 存在且在 npm test 链里', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> }
    assert.match(pkg.scripts['test:delta-coalescing'] ?? '', /test-delta-coalescing\.ts/)
    assert.match(pkg.scripts.test ?? '', /run-tests/, 'npm test 必须走汇总跑法，别让新套件漏在链外')
  })

  console.log(`\ndelta-coalescing: ${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
