/**
 * 论证地图投影层回归 —— 全部是纯函数断言，不起 Electron、不打接口。
 *
 * 盯的是三类真会出错的改动：把没有依据的「消解」画成已解决、
 * 主持引了不存在的发言却照样连线、同一份数据两次画出不一样顺序。
 */
import assert from 'node:assert'
import {
  ARG_BUCKETS,
  buildArgumentMap,
  type MapUtterance,
} from '../src/shared/argmap'
import type { ConsensusPoint, OpenDispute } from '../src/shared/types'

let pass = 0
let fail = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

function point(over: Partial<ConsensusPoint> = {}): ConsensusPoint {
  return {
    id: over.id ?? 'cp_1',
    claim: over.claim ?? '采用方案X以降低落地成本',
    support: over.support ?? ['m_a', 'm_b'],
    confidence: over.confidence ?? 0.85,
    evidenceRef: over.evidenceRef ?? ['utt_1'],
    confirmedRound: over.confirmedRound ?? 1,
    ...(over.variants !== undefined ? { variants: over.variants } : {}),
    ...(over.verification !== undefined ? { verification: over.verification } : {}),
  }
}

function dispute(over: Partial<OpenDispute> = {}): OpenDispute {
  return {
    id: over.id ?? 'dp_1',
    claim: over.claim ?? '供应商是否按季度评审',
    sides: over.sides ?? [
      { agentId: 'm_a', argument: '季度评审足够', utteranceIds: ['utt_1'] },
      { agentId: 'm_b', argument: '应改为月度', utteranceIds: ['utt_2'] },
    ],
    openedRound: over.openedRound ?? 2,
    lastProgress: over.lastProgress === undefined ? '第 3 轮仍未收敛' : over.lastProgress,
    status: over.status ?? 'open',
    ...(over.resolutionRef !== undefined ? { resolutionRef: over.resolutionRef } : {}),
  }
}

function utt(id: string, round: number, agentId: string, extra: Partial<MapUtterance> = {}): MapUtterance {
  return { id, round, agentId, ...extra }
}

const U = [utt('utt_1', 1, 'm_a'), utt('utt_2', 2, 'm_b'), utt('utt_3', 4, 'm_c')]

console.log('\n=== 分列：只认「有依据的消解」与核验状态 ===')

it('未核验与已核验的共识都进「已确认」，靠徽标区分而非另开一列', () => {
  const m = buildArgumentMap({
    consensus: [point({ id: 'cp_a' }), point({ id: 'cp_b', verification: { status: 'verified', checkedRound: 3, attributed: [], confirmedBy: ['m_a'], removed: [] } })],
    disputes: [],
    utterances: U,
  })
  assert.deepEqual(m.byBucket.held.map((n) => n.id).sort(), ['cp_a', 'cp_b'])
  assert.equal(m.byBucket.contested.length, 0, '核验状态为空不该被当成争议')
  assert.equal(m.byBucket.held.find((n) => n.id === 'cp_a')!.verify, null, '没跑核验的条目是 null，不是 unverified')
})

it('有代答的共识进「争议中」—— 有人被代答就是还没争完', () => {
  const m = buildArgumentMap({
    consensus: [point({ id: 'cp_x', verification: { status: 'disputed', checkedRound: 3, attributed: ['m_b'], confirmedBy: [], removed: [] } })],
    disputes: [],
    utterances: U,
  })
  assert.deepEqual(m.byBucket.contested.map((n) => n.id), ['cp_x'])
  assert.equal(m.byBucket.held.length, 0)
})

it('质询后归零的共识单独进「无人认领」，条目本身保留', () => {
  const m = buildArgumentMap({
    consensus: [point({ id: 'cp_v', verification: { status: 'vacated', checkedRound: 3, attributed: ['m_a', 'm_b'], confirmedBy: [], removed: ['m_a', 'm_b'] } })],
    disputes: [],
    utterances: U,
  })
  assert.deepEqual(m.byBucket.vacated.map((n) => n.id), ['cp_v'])
  assert.equal(m.nodes.length, 1, '被证明没人说过也是地图上的一条')
})

it('resolved 但没带依据的分歧不算消解，仍留在「争议中」', () => {
  const m = buildArgumentMap({
    consensus: [],
    disputes: [dispute({ id: 'dp_a', status: 'resolved' })],
    utterances: U,
  })
  assert.deepEqual(m.byBucket.contested.map((n) => n.id), ['dp_a'])
  assert.equal(m.byBucket.settled.length, 0)

  const ok = buildArgumentMap({
    consensus: [],
    disputes: [dispute({ id: 'dp_b', status: 'resolved', resolutionRef: ['utt_3'] })],
    utterances: U,
  })
  assert.deepEqual(ok.byBucket.settled.map((n) => n.id), ['dp_b'])
  assert.deepEqual(ok.byBucket.settled[0]!.resolution, ['utt_3'], '消解依据要带出去，图上那条线就靠它')
})

console.log('\n=== 连线：只连真实存在的发言 ===')

it('查不到原文的依据不画线，但如实数出来', () => {
  const m = buildArgumentMap({
    consensus: [point({ id: 'cp_m', evidenceRef: ['utt_1', 'utt_999'] })],
    disputes: [],
    utterances: U,
  })
  const n = m.byBucket.held[0]!
  assert.deepEqual(n.evidence.map((e) => e.utteranceId), ['utt_1'])
  assert.equal(n.missingEvidence, 1)
})

it('重复引用的同一条发言只连一次', () => {
  const m = buildArgumentMap({
    consensus: [point({ id: 'cp_dup', evidenceRef: ['utt_1', 'utt_1'] })],
    disputes: [],
    utterances: U,
  })
  assert.equal(m.byBucket.held[0]!.evidence.length, 1)
  assert.equal(m.byBucket.held[0]!.missingEvidence, 0, '重复不算查无')
})

it('分歧的连线是双方发言并上消解依据，按轮次排好', () => {
  const m = buildArgumentMap({
    consensus: [],
    disputes: [dispute({ id: 'dp_e', status: 'resolved', resolutionRef: ['utt_3', 'utt_1'] })],
    utterances: U,
  })
  const n = m.byBucket.settled[0]!
  assert.deepEqual(n.evidence.map((e) => e.utteranceId), ['utt_1', 'utt_2', 'utt_3'])
  assert.deepEqual(n.agents, ['m_a', 'm_b'], '双方顺序按 sides，界面按它画对峙')
})

it('人工介入可以当依据，但要单独数出来', () => {
  const withHuman = [...U, utt('utt_h', 2, 'human', { human: true })]
  const m = buildArgumentMap({
    consensus: [point({ id: 'cp_h', evidenceRef: ['utt_1', 'utt_h'] })],
    disputes: [],
    utterances: withHuman,
  })
  const n = m.byBucket.held[0]!
  assert.equal(n.humanCount, 1)
  assert.equal(n.evidence.find((e) => e.utteranceId === 'utt_h')!.human, true)
})

console.log('\n=== 轮次区间：能查到原文就用原文，查不到才回落到登记轮次 ===')

it('区间取证据发言的最早/最晚轮次', () => {
  const m = buildArgumentMap({
    consensus: [point({ id: 'cp_r', evidenceRef: ['utt_3', 'utt_1'], confirmedRound: 9 })],
    disputes: [],
    utterances: U,
  })
  assert.deepEqual(m.byBucket.held[0]!.rounds, { from: 1, to: 4 })
})

it('一条依据都查不到时回落到确认轮次，不留空洞', () => {
  const m = buildArgumentMap({
    consensus: [point({ id: 'cp_fb', evidenceRef: ['utt_404'], confirmedRound: 5 })],
    disputes: [dispute({ id: 'dp_fb', sides: [{ agentId: 'm_a', argument: 'x', utteranceIds: ['utt_404'] }] , openedRound: 3 })],
    utterances: U,
  })
  assert.deepEqual(m.byBucket.held[0]!.rounds, { from: 5, to: 5 })
  assert.deepEqual(m.byBucket.contested.find((n) => n.id === 'dp_fb')!.rounds, { from: 3, to: 3 })
})

console.log('\n=== 归并 / 排序 / 稳定 ===')

it('跨轮归并进来的其他说法带原文，不只带条数', () => {
  const m = buildArgumentMap({
    consensus: [point({ id: 'cp_w', variants: ['选方案X，落地成本更省', '方案X更便宜'] })],
    disputes: [],
    utterances: U,
  })
  assert.deepEqual(m.byBucket.held[0]!.variants, ['选方案X，落地成本更省', '方案X更便宜'])
})

it('分歧节点没有归并说法，字段仍给空数组', () => {
  const m = buildArgumentMap({ consensus: [], disputes: [dispute({ id: 'dp_v' })], utterances: U })
  assert.deepEqual(m.byBucket.contested[0]!.variants, [])
})

it('区内先按最早轮次，同轮按卷入模型数，再按 id —— 两次调用结果一致', () => {
  const input = {
    consensus: [
      point({ id: 'cp_late', evidenceRef: ['utt_3'], support: ['m_a'] }),
      point({ id: 'cp_early', evidenceRef: ['utt_1'], support: ['m_a', 'm_b'] }),
      point({ id: 'cp_early2', evidenceRef: ['utt_1'], support: ['m_a'] }),
    ],
    disputes: [],
    utterances: U,
  }
  const a = buildArgumentMap(input).byBucket.held.map((n) => n.id)
  const b = buildArgumentMap(input).byBucket.held.map((n) => n.id)
  assert.deepEqual(a, b)
  assert.deepEqual(a, ['cp_early', 'cp_early2', 'cp_late'])
})

it('每个分区都能被遍历到，桶里不含别的桶的节点', () => {
  const m = buildArgumentMap({
    consensus: [point({ id: 'cp_1' }), point({ id: 'cp_2', verification: { status: 'vacated', checkedRound: 2, attributed: [], confirmedBy: [], removed: ['m_a'] } })],
    disputes: [dispute({ id: 'dp_1' }), dispute({ id: 'dp_2', status: 'resolved', resolutionRef: ['utt_2'] })],
    utterances: U,
  })
  const inBuckets = ARG_BUCKETS.flatMap((b) => m.byBucket[b].map((n) => n.id)).sort()
  assert.deepEqual(inBuckets, ['cp_1', 'cp_2', 'dp_1', 'dp_2'])
  assert.equal(new Set(inBuckets).size, inBuckets.length, '一个节点只能属于一个分区')
})

console.log('\n' + '='.repeat(46))
console.log(`  通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(46) + '\n')

process.exit(fail > 0 ? 1 : 0)
