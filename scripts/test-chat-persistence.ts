/**
 * 聊天落盘节奏的离线回归（假 localStorage，不需要 Electron）
 *
 * 逐字流每来一个 token，store 就换一次 chats 的引用；而旧写法是「引用一变就
 * JSON.stringify 全量 + 同步写 localStorage」。会话越长，单次 stringify 越贵，
 * 乘上 token 数就是平方级的主线程开销。
 *
 * 钉死两层：
 * - 纯函数层：写盘频率、快照取最新、flush 取消在排的定时器、空队列不写；
 * - 接线层：ChatPage 不再直接写 STORE_KEY、三个保存时点都补 flush、读路径没被动过。
 *
 * 运行：npm run test:chat-persistence
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CHATS_SAVE_DEBOUNCE_MS, createChatsSaver } from '../src/renderer/chatPersistence'

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

/** 可编程的定时器：测试自己决定「时间到」的那一刻发生什么 */
function makeClock() {
  const queued: Array<{ fn: () => void; ms: number }> = []
  const cancelled = new Set<() => void>()
  return {
    delay(fn: () => void, ms: number): () => void {
      queued.push({ fn, ms })
      const cancel = (): void => void cancelled.add(fn)
      return cancel
    },
    /** 放行第 n 个还没被取消的定时器（默认最早的那个） */
    fire(nth = 0): void {
      const pending = queued.filter((q) => !cancelled.has(q.fn))
      const target = pending[nth]
      if (!target) throw new Error('队列里没有待触发的定时器')
      const i = queued.indexOf(target)
      if (i >= 0) queued.splice(i, 1)
      target.fn()
    },
    /** 无视取消硬跑第 n 个：模拟「定时器已经排出去了才来的取消」这种最坏情况 */
    force(nth = 0): void {
      const target = queued[nth]
      if (!target) throw new Error('从来没有排过定时器')
      target.fn()
    },
    get scheduled(): number {
      return queued.length
    },
    get pendingCount(): number {
      return queued.filter((q) => !cancelled.has(q.fn)).length
    },
  }
}

/** 记录写入的假 localStorage */
function makeSink() {
  const writes: Array<{ key: string; json: string }> = []
  return {
    writes,
    put(key: string, json: string): void {
      writes.push({ key, json })
    },
    get count(): number {
      return writes.length
    },
    get last(): string {
      const w = writes[writes.length - 1]
      if (!w) throw new Error('一次都没写过')
      return w.json
    },
  }
}

/** 像真实 chats 那样的形状：会话 × 轮次 × 每轮多模型单元格 */
function makeChats(sessions: number, turns: number, models: number): unknown[] {
  return Array.from({ length: sessions }, (_, s) => ({
    id: `chat_${s}`,
    title: `会话 ${s}`,
    createdAt: 1_700_000_000_000 + s,
    system: '你是评审',
    turns: Array.from({ length: turns }, (_, t) => ({
      id: `turn_${s}_${t}`,
      question: `第 ${t} 个问题：这套方案的边界条件都覆盖到了吗？`.padEnd(60, '·'),
      at: 1_700_000_000_000 + t,
      cells: Object.fromEntries(
        Array.from({ length: models }, (_, m) => [
          `model_${m}`,
          { content: `模型 ${m} 对第 ${t} 轮的回答。`.padEnd(200, '内容'), streaming: m === 0 && t === turns - 1 },
        ]),
      ),
    })),
  }))
}

async function main(): Promise<void> {
  console.log('聊天落盘节奏回归\n')

  await it('逐字流那样连排 50 次变化：一个定时器都不许多排，写盘一次都没有', () => {
    const sink = makeSink()
    const clock = makeClock()
    const saver = createChatsSaver('torra.chat.v1', sink.put, CHATS_SAVE_DEBOUNCE_MS, clock.delay)
    for (let i = 0; i < 50; i++) saver.schedule({ v: i })
    assert.equal(clock.scheduled, 1, '队列里已有定时器就不该再排第二个')
    assert.equal(sink.count, 0, '时间没到就不该写盘')
  })

  await it('定时器到点：只落最新那一份快照，中间值一概不进磁盘', () => {
    const sink = makeSink()
    const clock = makeClock()
    const saver = createChatsSaver('torra.chat.v1', sink.put, CHATS_SAVE_DEBOUNCE_MS, clock.delay)
    for (let i = 0; i < 50; i++) saver.schedule({ v: i })
    clock.fire()
    assert.equal(sink.count, 1)
    assert.equal(sink.last, JSON.stringify({ v: 49 }))
  })

  await it('落盘之后又能接着排：一场长会话是许多个 320ms 窗口，不是只写一次', () => {
    const sink = makeSink()
    const clock = makeClock()
    const saver = createChatsSaver('torra.chat.v1', sink.put, CHATS_SAVE_DEBOUNCE_MS, clock.delay)
    saver.schedule({ v: 1 })
    clock.fire()
    saver.schedule({ v: 2 })
    assert.equal(clock.pendingCount, 1, '上一轮写完后应重新排队')
    clock.fire()
    assert.equal(sink.count, 2)
    assert.equal(sink.last, JSON.stringify({ v: 2 }))
  })

  await it('flush 立刻落盘并吃掉在排的定时器：关窗时既不能丢帧也不能写两遍', () => {
    const sink = makeSink()
    const clock = makeClock()
    const saver = createChatsSaver('torra.chat.v1', sink.put, CHATS_SAVE_DEBOUNCE_MS, clock.delay)
    saver.schedule({ v: 7 })
    saver.flush()
    assert.equal(sink.count, 1)
    assert.equal(sink.last, JSON.stringify({ v: 7 }))
    assert.equal(clock.pendingCount, 0, 'flush 之后不该还有定时器悬着')
    // 定时器已经排出去了才来的取消，浏览器仍可能执行它 —— 也不能重复写
    clock.force(0)
    assert.equal(sink.count, 1)
  })

  await it('没有待写内容时 flush 是空操作：切走/卸载不该各写一份重复的快照', () => {
    const sink = makeSink()
    const clock = makeClock()
    const saver = createChatsSaver('torra.chat.v1', sink.put, CHATS_SAVE_DEBOUNCE_MS, clock.delay)
    saver.flush()
    saver.schedule({ v: 1 })
    saver.flush()
    saver.flush()
    assert.equal(sink.count, 1)
  })

  await it('key 原样透传：落盘的还是那个 torra.chat.v1，读路径不用跟着改', () => {
    const sink = makeSink()
    const clock = makeClock()
    const saver = createChatsSaver('torra.chat.v1', sink.put, CHATS_SAVE_DEBOUNCE_MS, clock.delay)
    saver.schedule([{ id: 'chat_0', turns: [] }])
    clock.fire()
    const w = sink.writes[0]
    assert.ok(w, '应有一次写入')
    assert.equal(w!.key, 'torra.chat.v1')
    assert.deepEqual(JSON.parse(w!.json), [{ id: 'chat_0', turns: [] }])
  })

  await it('前后数值：同样 2000 次 token 级变化，写盘次数从 2000 → 1，主线程耗时明显下降', async () => {
    // 夹具刻意不做到 2MB：那个量级下旧口径要跑十几秒，测试会比重构本身还慢
    const chats = makeChats(8, 12, 3)
    const tokens = 2000
    const bytes = JSON.stringify(chats).length

    // 旧口径：每个 token 一次全量 stringify + 同步写盘
    let oldWrites = 0
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < tokens; i++) {
      const json = JSON.stringify(chats)
      oldWrites += json.length
    }
    const oldMs = Number(process.hrtime.bigint() - t0) / 1e6

    // 新口径：token 只更新引用，写盘最多每 debounce 窗口一次
    const sink = makeSink()
    const clock = makeClock()
    const saver = createChatsSaver('torra.chat.v1', sink.put, CHATS_SAVE_DEBOUNCE_MS, clock.delay)
    const t1 = process.hrtime.bigint()
    for (let i = 0; i < tokens; i++) saver.schedule(chats)
    clock.fire()
    const newMs = Number(process.hrtime.bigint() - t1) / 1e6

    const newBytes = sink.writes.reduce((n, w) => n + w.json.length, 0)
    console.log(
      `         夹具 ${bytes.toLocaleString()} 字节 · ${tokens} 次变化：` +
        `写盘次数 ${oldWrites.toLocaleString()} → ${newBytes.toLocaleString()} 字节 / ${sink.count} 次调用，` +
        `耗时 ${oldMs.toFixed(1)}ms → ${newMs.toFixed(1)}ms`,
    )
    assert.equal(sink.count, 1, '整场流式只该落一次盘')
    assert.ok(newBytes < oldWrites / 1000, '落盘字节量应下降三个数量级')
    assert.ok(newMs < oldMs, '新口径必须不慢于旧口径')
  })

  await it('接线：ChatPage 不再直接写 STORE_KEY，改走落盘器', () => {
    const src = readSrc('src/renderer/components/ChatPage.tsx')
    assert.ok(!/localStorage\.setItem\(\s*STORE_KEY/.test(src), '仍有直接的全量 stringify 写盘')
    assert.match(src, /createChatsSaver\(\s*STORE_KEY/)
    assert.match(src, /chatsSaver\.schedule\(chats\)/)
    assert.match(src, /from '\.\.\/chatPersistence'/)
  })

  await it('接线：三个保存时点都补 flush（关窗、切走、卸载），失败照旧静默', () => {
    const src = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(src, /addEventListener\('beforeunload',\s*\w+\)/)
    assert.match(src, /addEventListener\('visibilitychange',\s*\w+\)/)
    assert.match(src, /return \(\) => \{[\s\S]{0,400}?chatsSaver\.flush\(\)/, '卸载时没有补那一次 flush')
    assert.match(src, /try \{\s*localStorage\.setItem\(k, json\)[\s\S]{0,80}catch/)
    assert.match(src, /localStorage\.getItem\(STORE_KEY\)/, '读路径不该被动过')
  })

  await it('注册：npm run test:chat-persistence 存在且在 npm test 链里', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> }
    assert.match(pkg.scripts['test:chat-persistence'] ?? '', /test-chat-persistence\.ts/)
    assert.match(pkg.scripts.test ?? '', /npm run test:chat-persistence/)
  })

  console.log(`\n通过 ${pass} · 失败 ${fail}`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
