/**
 * 定时任务 / 抓取工具 / 任务目录闸门的离线回归。
 *
 * 不启动 Electron、不联网、不打真实模型：调度用可注入的 now，抓取用假 fetch，
 * 任务目录是临时目录。守的是后台那条链上「没人看着时最容易错」的几件事：
 * - 到点判定与补跑：同一格只跑一次，停用的不跑，错过的那一天启动时补一次；
 * - 保留期清理按文件 mtime，0 表示不清理；
 * - 任务目录只能写相对路径，绝对路径 / 盘符 / .. 一律拒绝；
 * - 抓取失败必须带原因（超时 / 网络 / 非法地址），4xx/5xx 不算抓取失败。
 *
 * 运行：npm run test:assistant-scheduler
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runFetchUrl, normalizeFetchUrl } from '../src/main/assistant/fetch-url'
import { resolveTaskPath } from '../src/main/assistant/task-tools'
import {
  addScheduledTask,
  isDue,
  markScheduledRun,
  nextRunAtOf,
  pruneOutput,
  readStoredTasks,
  removeScheduledTask,
  setScheduledTaskEnabled,
  startTaskScheduler,
  viewScheduledTasks,
} from '../src/main/assistant/tasks'

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

const DAY = 86_400_000
/** 本地时间点：调度全部按本地时钟走，测试也按本地时间造样本 */
const at = (y: number, m: number, d: number, h: number, min: number): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime()

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'torra-sched-'))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 单条读取：noUncheckedIndexedAccess 下数组下标永远是 T | undefined，测试里直接断言存在 */
function first<T>(list: T[]): T {
  assert.ok(list.length > 0, '期望至少一条记录')
  return list[0]!
}

async function main(): Promise<void> {
  console.log('\n定时任务与抓取回归（离线）\n' + '='.repeat(44))

  // -------------------------------------------------------------------------
  // 存储与校验
  // -------------------------------------------------------------------------

  await it('新建任务：默认产出目录建在任务根下，默认保留 30 天', async () => {
    const dir = tempDir()
    const r = await addScheduledTask(
      dir,
      { title: 'AIHOT 日报', prompt: '抓取并整理', time: '08:00' },
      at(2026, 10, 29, 7, 0),
    )
    assert.equal(r.ok, true)
    assert.match(r.id ?? '', /^task-[0-9a-f]{8}$/)
    assert.equal(path.dirname(r.task!.outDir).endsWith(path.join('assistant-tasks')), true)
    assert.equal(fs.existsSync(r.task!.outDir), true)
    assert.equal(r.task!.retentionDays, 30)
    assert.equal(r.task!.enabled, true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await it('非法输入全部拒绝，且一条都不落盘', async () => {
    const dir = tempDir()
    for (const bad of [
      { title: '', prompt: 'x', time: '08:00' },
      { title: 'x', prompt: '', time: '08:00' },
      { title: 'x', prompt: 'y', time: '8:00' },
      { title: 'x', prompt: 'y', time: '24:00' },
      { title: 'x', prompt: 'y', time: '08:00', retentionDays: 400 },
      { title: 'x', prompt: 'y', time: '08:00', outDir: 'relative/dir' },
    ]) {
      const r = await addScheduledTask(dir, bad)
      assert.equal(r.ok, false, JSON.stringify(bad))
      assert.ok(r.reason)
    }
    assert.equal((await readStoredTasks(dir)).length, 0)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await it('清单按时间排序，并带回「只在应用运行时触发」的说明', async () => {
    const dir = tempDir()
    await addScheduledTask(dir, { title: '晚', prompt: 'p', time: '20:00' })
    await addScheduledTask(dir, { title: '早', prompt: 'p', time: '08:00' })
    const v = await viewScheduledTasks(dir, at(2026, 10, 29, 7, 0))
    assert.deepEqual(v.tasks.map((t) => t.title), ['早', '晚'])
    assert.match(v.note, /Torra 运行期间/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // 到点判定与下一次
  // -------------------------------------------------------------------------

  await it('到点判定：过点未跑才跑，跑过就不再跑', async () => {
    const dir = tempDir()
    await addScheduledTask(dir, { title: 't', prompt: 'p', time: '08:00' }, at(2026, 10, 29, 6, 0))
    const t = first(await readStoredTasks(dir))
    assert.equal(isDue(t, at(2026, 10, 29, 7, 59)), false)
    assert.equal(isDue(t, at(2026, 10, 29, 8, 0)), true)
    await markScheduledRun(dir, t.id, {
      startedAt: at(2026, 10, 29, 8, 0),
      ms: 1000,
      ok: true,
      files: ['a.md'],
    })
    const after = first(await readStoredTasks(dir))
    assert.equal(isDue(after, at(2026, 10, 29, 9, 0)), false)
    assert.equal(nextRunAtOf(after, at(2026, 10, 29, 9, 0)), at(2026, 10, 30, 8, 0))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await it('下一次时刻：没跑过是今天那一格，跑过是明天', async () => {
    const dir = tempDir()
    await addScheduledTask(dir, { title: 't', prompt: 'p', time: '08:00' }, at(2026, 10, 29, 6, 0))
    const t = first(await readStoredTasks(dir))
    assert.equal(nextRunAtOf(t, at(2026, 10, 29, 6, 0)), at(2026, 10, 29, 8, 0))
    await markScheduledRun(dir, t.id, { startedAt: at(2026, 10, 29, 8, 0), ms: 1, ok: true, files: [] })
    const after = first(await readStoredTasks(dir))
    assert.equal(nextRunAtOf(after, at(2026, 10, 29, 8, 30)), at(2026, 10, 30, 8, 0))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await it('今天那一格过去之后才建的任务：不补跑今天，下次是明天', async () => {
    const dir = tempDir()
    const r = await addScheduledTask(dir, { title: 't', prompt: 'p', time: '08:00' }, at(2026, 10, 29, 15, 0))
    const t = first(await readStoredTasks(dir))
    // 「建之前的那一格」不属于这条任务 —— 否则下午建完立刻跑，界面还会显示一个已经过去的下次
    assert.equal(isDue(t, at(2026, 10, 29, 15, 1)), false)
    assert.equal(nextRunAtOf(t, at(2026, 10, 29, 15, 1)), at(2026, 10, 30, 8, 0))
    assert.equal(r.task?.nextRunAt, at(2026, 10, 30, 8, 0))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await it('停用的任务既不到点，也不给下一次时刻', async () => {
    const dir = tempDir()
    const r = await addScheduledTask(dir, { title: 't', prompt: 'p', time: '08:00' })
    await setScheduledTaskEnabled(dir, r.id!, false)
    const t = first(await readStoredTasks(dir))
    assert.equal(t.enabled, false)
    assert.equal(isDue(t, at(2026, 10, 29, 12, 0)), false)
    assert.equal(nextRunAtOf(t, at(2026, 10, 29, 12, 0)), undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // 调度循环
  // -------------------------------------------------------------------------

  await it('补跑：错过的一格启动后跑一次，多跑几次 tick 也不会重复', async () => {
    const dir = tempDir()
    const runs: string[] = []
    const s = startTaskScheduler({
      dataDir: dir,
      run: async (t) => {
        runs.push(t.id)
        return { ok: true, files: ['2026-10-29.md'] }
      },
      intervalMs: 60 * 60_000,
    })
    // 先让启动那一次检查跑过（此刻还没有任务），再建任务，避免真实时钟干扰断言
    await sleep(30)
    assert.equal(runs.length, 0)
    const r = await addScheduledTask(dir, { title: 't', prompt: 'p', time: '08:00' }, at(2026, 10, 29, 7, 0))
    await s.tick(at(2026, 10, 29, 8, 5))
    assert.deepEqual(runs, [r.id])
    await s.tick(at(2026, 10, 29, 8, 6))
    await s.tick(at(2026, 10, 29, 8, 7))
    assert.equal(runs.length, 1)
    const t = first(await readStoredTasks(dir))
    assert.equal(t.lastRun?.ok, true)
    assert.deepEqual(t.lastRun?.files, ['2026-10-29.md'])
    s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await it('运行失败也记一条 lastRun，并通知一次', async () => {
    const dir = tempDir()
    const notes: string[] = []
    let changes = 0
    const s = startTaskScheduler({
      dataDir: dir,
      run: async () => ({ ok: false, error: '抓取超时' }),
      notify: (n) => notes.push(`${n.title}|${n.body}`),
      onChange: () => changes++,
      intervalMs: 60 * 60_000,
    })
    await sleep(30)
    const r = await addScheduledTask(dir, { title: '会失败', prompt: 'p', time: '08:00' }, at(2026, 10, 29, 7, 0))
    await s.tick(at(2026, 10, 29, 8, 5))
    const t = first(await readStoredTasks(dir))
    assert.equal(t.lastRun?.ok, false)
    assert.match(t.lastRun?.error ?? '', /抓取超时/)
    assert.equal(notes.length, 1)
    assert.match(notes[0]!, /会失败.*失败/)
    assert.ok(changes >= 1)
    s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await it('手动运行：任务不存在时明确失败，存在时只跑那一条', async () => {
    const dir = tempDir()
    const runs: string[] = []
    const s = startTaskScheduler({
      dataDir: dir,
      run: async (t) => {
        runs.push(t.id)
        return { ok: true, files: [] }
      },
      intervalMs: 60 * 60_000,
    })
    await sleep(30)
    const missing = await s.runNow('task-nope')
    assert.equal(missing.ok, false)
    const r = await addScheduledTask(dir, { title: 't', prompt: 'p', time: '08:00' })
    const out = await s.runNow(r.id!)
    assert.equal(out.ok, true)
    assert.deepEqual(runs, [r.id])
    s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await it('同一任务正在跑时，手动运行被拒（不叠第二条）', async () => {
    const dir = tempDir()
    let release: (() => void) | undefined
    const s = startTaskScheduler({
      dataDir: dir,
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, files: [] })
        }),
      intervalMs: 60 * 60_000,
    })
    await sleep(30)
    const r = await addScheduledTask(dir, { title: 't', prompt: 'p', time: '08:00' })
    const first = s.runNow(r.id!)
    await sleep(10)
    const second = await s.runNow(r.id!)
    assert.equal(second.ok, false)
    assert.match(second.error ?? '', /正在运行/)
    release?.()
    await first
    s.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // 清理
  // -------------------------------------------------------------------------

  await it('保留期清理：只删超过保留期的文件，0 = 不清理', async () => {
    const dir = tempDir()
    const oldFile = path.join(dir, 'old.md')
    const newFile = path.join(dir, 'new.md')
    fs.writeFileSync(oldFile, 'old')
    fs.writeFileSync(newFile, 'new')
    const now = at(2026, 10, 29, 9, 0)
    fs.utimesSync(oldFile, new Date(now - 40 * DAY), new Date(now - 40 * DAY))
    fs.utimesSync(newFile, new Date(now - 2 * DAY), new Date(now - 2 * DAY))

    const removed = await pruneOutput(dir, 30, now)
    assert.equal(removed, 1)
    assert.equal(fs.existsSync(oldFile), false)
    assert.equal(fs.existsSync(newFile), true)

    const again = await pruneOutput(dir, 0, now + 365 * DAY)
    assert.equal(again, 0)
    assert.equal(fs.existsSync(newFile), true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await it('删除任务只删定义，产出目录原样保留', async () => {
    const dir = tempDir()
    const r = await addScheduledTask(dir, { title: 't', prompt: 'p', time: '08:00' })
    fs.writeFileSync(path.join(r.task!.outDir, 'keep.md'), 'keep')
    const out = await removeScheduledTask(dir, r.id!)
    assert.equal(out.ok, true)
    assert.equal((await readStoredTasks(dir)).length, 0)
    assert.equal(fs.existsSync(path.join(r.task!.outDir, 'keep.md')), true)
    const again = await removeScheduledTask(dir, r.id!)
    assert.equal(again.ok, false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // 任务目录闸门
  // -------------------------------------------------------------------------

  await it('任务目录只收相对路径：绝对路径 / 盘符 / ~ / .. 全拒绝', async () => {
    const root = tempDir()
    const ok = resolveTaskPath(root, '2026-10-29.md')
    assert.equal(ok.ok, true)
    assert.equal(ok.ok && ok.rel, '2026-10-29.md')
    const nested = resolveTaskPath(root, 'archive\\2026-10-29.md')
    assert.equal(nested.ok && nested.rel, 'archive/2026-10-29.md')
    for (const bad of ['', '/etc/passwd', 'C:\\Windows\\x.md', '~/x.md', '../x.md', 'a/../../x.md']) {
      const r = resolveTaskPath(root, bad)
      assert.equal(r.ok, false, bad)
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // 抓取
  // -------------------------------------------------------------------------

  await it('地址校验：只收 http/https，且不允许把凭据写进 URL', () => {
    assert.equal(normalizeFetchUrl('https://aihot.news/api/v1/agent/daily'), 'https://aihot.news/api/v1/agent/daily')
    assert.equal(normalizeFetchUrl('ftp://x/y'), null)
    assert.equal(normalizeFetchUrl('https://user:pass@x/y'), null)
    assert.equal(normalizeFetchUrl('not a url'), null)
  })

  await it('抓 HTML：去标签留正文，状态码原样带回', async () => {
    const fake = (async () =>
      new Response('<html><head><style>.a{}</style></head><body><h1>头条</h1><p>正文 &amp; 细节</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })) as unknown as typeof fetch
    const r = await runFetchUrl({ url: 'https://example.com/daily' }, { fetch: fake })
    assert.equal(r.ok, true)
    assert.equal(r.status, 200)
    assert.match(r.text ?? '', /头条/)
    assert.match(r.text ?? '', /正文 & 细节/)
    assert.doesNotMatch(r.text ?? '', /<h1>|\.a\{\}/)
  })

  await it('抓 JSON：原样保留，不做 HTML 化', async () => {
    const body = JSON.stringify({ title: '日报', items: [1, 2] })
    const fake = (async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const r = await runFetchUrl({ url: 'https://example.com/api' }, { fetch: fake })
    assert.equal(r.text, body)
  })

  await it('4xx/5xx 不算抓取失败：状态码回给模型自己判断', async () => {
    const fake = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
    const r = await runFetchUrl({ url: 'https://example.com/missing' }, { fetch: fake })
    assert.equal(r.ok, true)
    assert.equal(r.status, 404)
  })

  await it('网络失败与超时都返回 ok:false + 中文原因', async () => {
    const down = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    const a = await runFetchUrl({ url: 'https://example.com/x' }, { fetch: down })
    assert.equal(a.ok, false)
    assert.match(a.reason ?? '', /抓取失败/)

    const slow = (async () => {
      throw new Error('This operation was aborted: timeout')
    }) as unknown as typeof fetch
    const b = await runFetchUrl({ url: 'https://example.com/x' }, { fetch: slow, timeoutMs: 50 })
    assert.equal(b.ok, false)
    assert.match(b.reason ?? '', /超时/)
  })

  await it('字数上限：低于 500 按 500 算，超出时截断并标明', async () => {
    const body = 'x'.repeat(5000)
    const fake = (async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch
    const r = await runFetchUrl({ url: 'https://example.com/long', maxChars: 120 }, { fetch: fake })
    assert.equal(r.ok, true)
    assert.equal(r.truncated, true)
    assert.match(r.text ?? '', /已截断/)
    // maxChars 有 500 字符的下限：太小会把「读关键部分」变成读不到任何东西
    assert.equal((r.text ?? '').startsWith('x'.repeat(500)), true)
    assert.ok((r.text ?? '').length < 560)
  })

  console.log(`${'-'.repeat(46)}\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
