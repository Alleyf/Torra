/**
 * 共识证据与通道死线的离线回归（不需要 Electron）
 *
 * 两条底线，都是「错了不报错、只是悄悄失真」那一类：
 * 1. 人类插话与模型发言在同一条 utterances 流里，但它不是模型共识的证据（规则 3）。
 *    证据校验原本只滤缺席不滤 human —— 主持把用户那句话的 id 填进 evidence_ref 照样放行，
 *    报告就把人话渲染成「几个模型共同主张」的支撑链。
 * 2. 轮次批次的发送有通道级死线，对辩轮与核验轮原本裸 await：网页通道一卡，
 *    finish() 不返回，done 事件不发，而存档只在收尾那一步写 —— 整场连同存档一起挂死。
 *
 * 运行：npm run test:integrity-gates
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelUtterancesOnly } from '../src/shared/interventions'
import type { Utterance } from '../src/shared/types'

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

const utt = (over: Partial<Utterance>): Utterance =>
  ({
    id: 'u1',
    round: 1,
    agentId: 'a',
    content: '正文',
    targets: [],
    ...over,
  }) as Utterance

async function main(): Promise<void> {
  console.log('\n── 口径：能当共识证据的只有模型发言')

  await it('人类插话与缺席占位都不算模型发言', () => {
    const list = [
      utt({ id: 'm1' }),
      utt({ id: 'h1', human: true, agentId: 'human' }),
      utt({ id: 'a1', absent: true }),
    ]
    assert.deepEqual(
      modelUtterancesOnly(list).map((u) => u.id),
      ['m1'],
      '人的表态不是模型共识的组成部分（规则 3）',
    )
  })

  await it('主持小结里引用人类插话当证据会被单独拒掉', () => {
    const src = readSrc('src/main/orchestrator/orchestrator.ts')
    assert.match(src, /const humanIds = new Set\(/, '要有一张人类发言 id 表，才能报出准确的原因')
    assert.match(src, /共识点的证据里混入了人类介入的发言/, '拒得要有名目，不能笼统说「未发生的发言」')
    assert.match(src, /citedHuman/, '人类引用与凭空引用要分两条错误')
  })

  await it('证据集用 modelUtterancesOnly，不留第三套判据', () => {
    const src = readSrc('src/main/orchestrator/orchestrator.ts')
    assert.match(
      src,
      /const spokeThisSession = modelUtterancesOnly\(this\.utterances\)[\s\S]{0,200}const allUtteranceIds = new Set\(spokeThisSession\.map/,
      '本轮证据集与全场依据集必须同源于「非缺席 + 非人类」这一个口径',
    )
    assert.doesNotMatch(
      src,
      /const allUtteranceIds = new Set\(this\.utterances\.filter\(\(u\) => !u\.absent\)\.map/,
      '终局审校的证据集曾经只滤缺席 —— 人类插话会顺着这里进决定清单',
    )
  })

  console.log('\n── 死线：每一路发送都必须到点判缺席')

  await it('对辩轮与核验轮都走 sendWithinDeadline', () => {
    const src = readSrc('src/main/orchestrator/orchestrator.ts')
    const guarded = (src.match(/this\.sendWithinDeadline\(\(\) =>/g) ?? []).length
    assert.equal(guarded, 2, `只有对辩轮与核验轮需要新包一层，实到 ${guarded} 处`)
    assert.doesNotMatch(
      src,
      /await agent\.send\(/,
      '裸 await agent.send 会卡住 finish()，整场连同存档一起挂死',
    )
  })

  await it('死线口径与轮次批次同源（同一个 roundWallClockMs）', () => {
    const src = readSrc('src/main/orchestrator/orchestrator.ts')
    assert.match(src, /withDeadline\(this\.deps\.roundWallClockMs \?\? 240_000, run\)/)
  })

  await it('到点判的是缺席，不是整场失败', () => {
    const src = readSrc('src/main/orchestrator/orchestrator.ts')
    const duel = src.slice(src.indexOf('private async runDuel'), src.indexOf('private absent('))
    assert.match(duel, /catch \(e\) \{\s*\n\s*return this\.absent\(/, '对辩一路超时只把自己记成缺席')
    const verify = src.slice(src.indexOf('private async runVerificationPass'))
    assert.match(verify, /settleCorrection\(target, null, question, null\)/, '核验拿不到答复要按未答结案')
  })

  await it('注册：npm run test:integrity-gates 存在且在 npm test 链里', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> }
    assert.match(pkg.scripts['test:integrity-gates'] ?? '', /test-integrity-gates\.ts/)
    assert.match(pkg.scripts.test ?? '', /run-tests/, 'npm test 必须走汇总跑法')
  })

  console.log(`\nintegrity-gates: ${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
