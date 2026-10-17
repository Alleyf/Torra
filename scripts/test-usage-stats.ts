/**
 * 本机使用统计的离线验证：记账纯函数、偏好文件合并、坏数据读回。
 * 对应 PRD 12 章度量机制 ① —— 数字只算在本机，这里验证的是「算得对、写得稳」。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  emptyUsageStats,
  normalizeUsageStats,
  noteReportExport,
  noteSessionFinished,
  noteSessionStarted,
  readUsageStats,
  writeUsageStats,
} from '../src/main/store/usage-stats'

let pass = 0
const failed: string[] = []
async function it(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    failed.push(`${name}: ${(e as Error).message}`)
    console.log(`  [FAIL] ${name}\n         ${(e as Error).message}`)
  }
}

async function main() {
  await it('记账纯函数：计数只涨不跌、时间戳单调', () => {
    let s = emptyUsageStats()
    s = noteSessionStarted(s, 1000)
    assert.equal(s.sessionsStarted, 1)
    assert.equal(s.lastSessionAt, 1000)
    // 迟到的活动不回滚时间戳：收束可能比发起晚注册（恢复孤儿场景）
    s = noteSessionStarted(s, 500)
    assert.equal(s.lastSessionAt, 1000)
    s = noteSessionFinished(s, 'converged', 2000)
    assert.equal(s.sessionsFinished, 1)
    assert.equal(s.finishedByReason.converged, 1)
    s = noteSessionFinished(s, 'converged', 3000)
    assert.equal(s.finishedByReason.converged, 2)
    s = noteReportExport(s, 4000)
    assert.equal(s.reportExports, 1)
    assert.equal(s.lastExportAt, 4000)
    // 纯函数不改上一份账
    assert.equal(s.sessionsStarted, 2)
  })

  await it('归一化：坏值按 0 计，未知形状按空账', () => {
    const s = normalizeUsageStats({
      sessionsStarted: -3,
      sessionsFinished: 'x',
      finishedByReason: { converged: 5, bogus: NaN },
      reportExports: 2,
      lastSessionAt: Infinity,
    })
    assert.equal(s.sessionsStarted, 0)
    assert.equal(s.sessionsFinished, 0)
    assert.equal(s.finishedByReason.converged, 5)
    assert.ok(!('bogus' in s.finishedByReason))
    assert.equal(s.reportExports, 2)
    assert.equal(s.lastSessionAt, 0)
    assert.ok(normalizeUsageStats(null).sessionsStarted === 0)
    assert.ok(normalizeUsageStats('junk').reportExports === 0)
  })

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'torra-usage-'))
  try {
    const prefs = path.join(tmp, 'preferences.json')

    await it('读不存在/损坏的偏好文件都当空账（发起链路绝不因它失败）', async () => {
      assert.deepEqual(await readUsageStats(prefs), emptyUsageStats())
      await fs.writeFile(prefs, '{ broken json', 'utf8')
      assert.deepEqual(await readUsageStats(prefs), emptyUsageStats())
    })

    await it('写回走合并：同文件其它键原样保留', async () => {
      await fs.writeFile(prefs, JSON.stringify({ theme: 'dark', participantIds: ['a', 'b'] }), 'utf8')
      let s = emptyUsageStats()
      s = noteSessionStarted(s, 111)
      await writeUsageStats(prefs, s)
      const raw = JSON.parse(await fs.readFile(prefs, 'utf8')) as Record<string, unknown>
      assert.equal(raw.theme, 'dark')
      assert.deepEqual(raw.participantIds, ['a', 'b'])
      const back = await readUsageStats(prefs)
      assert.equal(back.sessionsStarted, 1)
      assert.equal(back.lastSessionAt, 111)
    })

    await it('往返多次：结局原因各自计数不串', async () => {
      let s = await readUsageStats(prefs)
      s = noteSessionFinished(s, 'max-rounds')
      s = noteSessionFinished(s, 'aborted')
      s = noteSessionFinished(s, 'max-rounds')
      await writeUsageStats(prefs, s)
      const back = await readUsageStats(prefs)
      assert.equal(back.finishedByReason['max-rounds'], 2)
      assert.equal(back.finishedByReason.aborted, 1)
      assert.equal(back.sessionsStarted, 1, '旧账不能被新写覆盖')
    })
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }

  console.log(`\n通过 ${pass} · 失败 ${failed.length}`)
  if (failed.length > 0) {
    for (const f of failed) console.error(`! ${f}`)
    process.exit(1)
  }
}

void main()
