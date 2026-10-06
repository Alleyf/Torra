/**
 * 共识点 / 分歧的近义归并自测 ——「同一判断换个说法不该变成三条结论」
 *
 * 分三层：
 * - 度量：同义对要并得上、反义对绝不误并（这是整件事唯一真正的难点）
 * - 归并：支持方并集、置信取高、硬度取低、原措辞留在 variants，核验标记不能丢
 * - 呈现：报告与 Markdown 要如实说「并掉了几条」，不能让用户以为本场只有这么多判断
 *
 * 运行：npm run test:dedup
 */

import assert from 'node:assert/strict'
import {
  DISPUTE_DUP_THRESHOLD,
  EXPLICIT_CONTINUATION_MIN,
  NEAR_DUP_THRESHOLD,
  claimCloseness,
  findSimilarDispute,
  foldPoint,
  mergeConsensusPoints,
} from '../src/shared/dedup'
import { mergeOpenDisputes } from '../src/shared/invariants'
import { buildReport, reportToMarkdown } from '../src/main/report/report'
import type {
  ConsensusPoint,
  OpenDispute,
  Report,
  SessionConfig,
  Topic,
  TransportKind,
  Utterance,
} from '../src/shared/types'

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
    id: over.id ?? 'cp_a',
    claim: over.claim ?? '采用方案X以降低落地成本',
    support: over.support ?? ['m1'],
    confidence: over.confidence ?? 0.7,
    evidenceRef: over.evidenceRef ?? ['utt_1'],
    confirmedRound: over.confirmedRound ?? 1,
    ...(over.weight === undefined ? {} : { weight: over.weight }),
    ...(over.variants === undefined ? {} : { variants: over.variants }),
    ...(over.verification === undefined ? {} : { verification: over.verification }),
  }
}

function dispute(over: Partial<OpenDispute> = {}): OpenDispute {
  return {
    id: over.id ?? 'od_a',
    claim: over.claim ?? '上线前要不要先做灰度',
    sides: over.sides ?? [
      { agentId: 'm1', argument: '先灰度再放量', utteranceIds: ['utt_1'] },
      { agentId: 'm2', argument: '直接全量，灰度拖节奏', utteranceIds: ['utt_2'] },
    ],
    openedRound: over.openedRound ?? 1,
    lastProgress: over.lastProgress ?? null,
    status: over.status ?? 'open',
  }
}

/** 断言区间：宁可写明「至少/至多」，也不锁死一个具体小数 —— 度量改了测试要能跟着动 */
function atLeast(label: string, got: number, want: number): void {
  assert.ok(got >= want, `${label}：期望 ≥ ${want}，实际 ${got}`)
}
function atMost(label: string, got: number, want: number): void {
  assert.ok(got <= want, `${label}：期望 ≤ ${want}，实际 ${got}`)
}

async function main() {
  console.log('\n共识点与分歧的近义归并')
  console.log('='.repeat(46))

  console.log('\n=== 度量：同义要并得上，反义绝不能误并 ===')

  it('换措辞的同一个判断落在归并阈值之上', () => {
    const pairs: Array<[string, string]> = [
      ['采用方案X以降低落地成本', '采用方案X，落地成本更低'],
      ['上线前补齐监控与回滚预案', '上线前应补齐监控和回滚预案'],
      ['按服务分级设置告警阈值', '告警阈值按服务等级分档设置'],
    ]
    for (const [a, b] of pairs) {
      atLeast(`「${a}」vs「${b}」`, claimCloseness(a, b), NEAR_DUP_THRESHOLD)
    }
  })

  it('无关判断压在阈值之下', () => {
    const pairs: Array<[string, string]> = [
      ['采用方案X以降低落地成本', '供应商合同改为按季度评审'],
      ['按服务分级设置告警阈值', '数据库变更窗口放在凌晨'],
    ]
    for (const [a, b] of pairs) {
      atMost(`「${a}」vs「${b}」`, claimCloseness(a, b), NEAR_DUP_THRESHOLD - 0.1)
    }
  })

  it('立场相反的句子字面再像也不并（否定词必须同侧）', () => {
    const opposite: Array<[string, string]> = [
      ['采用方案X', '不采用方案X'],
      ['上线前需要灰度发布', '上线前不需要灰度发布'],
      ['应当引入实时计算层', '反对引入实时计算层'],
    ]
    for (const [a, b] of opposite) {
      assert.equal(claimCloseness(a, b), 0, `反义对不该被判定为同义：${a} / ${b}`)
    }
    // 双方都带否定词时仍按字面判：不能因为「都有不」就一律判 0
    atLeast('双侧否定仍可比', claimCloseness('不采用方案X', '不采用方案Y'), 0)
  })

  it('完全相同（含标点/空白差异）判为 1，标点不参与相似度', () => {
    assert.equal(claimCloseness('采用方案 X', '采用方案X'), 1)
    assert.equal(claimCloseness('采用方案X。', '采用方案X'), 1)
  })

  console.log('\n=== 归并：折进原条目，措辞留在 variants ===')

  it('近义说法并成一条：支持方取并集、置信取高、硬度取低、轮次取早', () => {
    const existing = [
      point({ id: 'cp_1', claim: '采用方案X以降低落地成本', support: ['m1'], confidence: 0.7, weight: 0.8, evidenceRef: ['utt_1'], confirmedRound: 1 }),
      point({ id: 'cp_2', claim: '上线前补齐监控与回滚预案', support: ['m2'], confidence: 0.6, evidenceRef: ['utt_2'], confirmedRound: 1 }),
    ]
    const incoming = [
      point({ id: 'cp_9', claim: '采用方案X，落地成本更低', support: ['m2'], confidence: 0.85, weight: 0.5, evidenceRef: ['utt_3'], confirmedRound: 2 }),
      point({ id: 'cp_10', claim: '按服务分级设置告警阈值', support: ['m1'], confidence: 0.7, evidenceRef: ['utt_4'], confirmedRound: 2 }),
    ]
    const r = mergeConsensusPoints(existing, incoming)
    assert.equal(r.points.length, 3, '近义并入一条、新判断另起一条')
    assert.equal(r.merged, 1)
    const merged = r.points.find((p) => p.id === 'cp_1')!
    assert.deepEqual([...merged.support].sort(), ['m1', 'm2'], '支持方取并集')
    assert.equal(merged.confidence, 0.85, '置信取各轮最高')
    assert.equal(merged.weight, 0.5, '证据硬度取最低：短板决定这条结论有多硬')
    assert.equal(merged.confirmedRound, 1, '确认轮次取最早，报告不能把首次确认写成第二轮')
    assert.deepEqual(merged.variants, ['采用方案X，落地成本更低'], '原措辞留在 variants，归并不改写历史')
    assert.deepEqual([...merged.evidenceRef].sort(), ['utt_1', 'utt_3'], '证据并集')
    assert.equal(r.variants, 1, '措辞不同的并入要单独计数，报告才说得出「换过几种说法」')
    assert.ok(r.points.some((p) => p.id === 'cp_10'), '本轮新判断照常登记')
    assert.equal(r.ignoredContinues.length, 0)
  })

  it('反义条目绝不并（哪怕其余字面完全一样）', () => {
    const r = mergeConsensusPoints(
      [point({ claim: '上线前需要灰度发布' })],
      [point({ id: 'cp_2', claim: '上线前不需要灰度发布' })],
    )
    assert.equal(r.points.length, 2, '一条立场相反的判断必须另起条目')
    assert.equal(r.merged, 0)
  })

  it('existing 不被就地改写：归并失败时历史条目原样保留', () => {
    const existing = [point({ id: 'cp_1', support: ['m1'], evidenceRef: ['utt_1'] })]
    mergeConsensusPoints(existing, [point({ id: 'cp_2', claim: '完全不同的判断', support: ['m2'], evidenceRef: ['utt_9'] })])
    assert.deepEqual(existing[0]!.support, ['m1'], '传入的清单不能被改到')
    assert.deepEqual(existing[0]!.evidenceRef, ['utt_1'])
  })

  it('核验标记随归并保留：被并的一侧查过，合出来的条目算查过', () => {
    const target = point({ id: 'cp_1', claim: '采用方案X以降低落地成本' })
    const src = point({
      id: 'cp_2',
      claim: '采用方案X，落地成本更低',
      verification: { status: 'disputed', checkedRound: 2, attributed: ['m2'], confirmedBy: [], removed: ['m2'], notes: [] },
    })
    const r = mergeConsensusPoints([target], [src])
    const merged = r.points.find((p) => p.id === 'cp_1')!
    assert.equal(merged.verification?.status, 'disputed', '核验结论丢了就等于「没查过」，报告会把已质询过的条目当新条目')
    assert.deepEqual(merged.verification?.removed, ['m2'])
  })

  it('foldPoint 对同措辞不产生 variant（逐字重列不该被当成换说法）', () => {
    const t = point({ id: 'cp_1' })
    foldPoint(t, point({ id: 'cp_2', claim: '采用方案X以降低落地成本', support: ['m2'] }))
    assert.equal(t.variants, undefined)
    assert.deepEqual([...t.support].sort(), ['m1', 'm2'])
  })

  console.log('\n=== continues：主持显式声明的延续 ===')

  it('声明指向已有条目且不太离谱 → 按声明并（哪怕字面相似度低于归并阈值）', () => {
    const existing = [point({ id: 'cp_1', claim: '采用方案X以降低落地成本' })]
    const src = point({ id: 'cp_2', claim: '选方案X，落地成本更省' })
    // 先确认它靠自动阈值并不上，否则这个用例证明不了 continues 的作用
    atMost('自动阈值下不并', claimCloseness(existing[0]!.claim, src.claim), NEAR_DUP_THRESHOLD - 0.01)
    const r = mergeConsensusPoints(existing, [src], ['cp_1'])
    assert.equal(r.points.length, 1, '主持点名延续，程序按点名并')
    assert.equal(r.ignoredContinues.length, 0)
  })

  it('声明的 id 不存在 → 按新条目登记并留下说明', () => {
    const r = mergeConsensusPoints(
      [point({ id: 'cp_1' })],
      [point({ id: 'cp_2', claim: '一个全新的判断方向' })],
      ['cp_ghost'],
    )
    assert.equal(r.points.length, 2)
    assert.equal(r.ignoredContinues.length, 1)
    assert.ok(r.ignoredContinues[0]!.includes('cp_ghost'), `说明里要带上主持给的 id：${r.ignoredContinues[0]}`)
  })

  it('声明把无关判断塞进已有条目 → 拒绝（EXPLICIT_CONTINUATION_MIN 兜底）', () => {
    const r = mergeConsensusPoints(
      [point({ id: 'cp_1', claim: '采用方案X以降低落地成本' })],
      [point({ id: 'cp_2', claim: '供应商合同改为按季度评审并压价' })],
      ['cp_1'],
    )
    assert.equal(r.points.length, 2, 'continues 不是免检通行证：字面完全不像就不并')
    assert.equal(r.merged, 0)
    assert.equal(r.ignoredContinues.length, 1)
    atMost('阈值本身要留得住这种误标', EXPLICIT_CONTINUATION_MIN, NEAR_DUP_THRESHOLD)
  })

  console.log('\n=== 分歧：措辞像 + 当事方一致才并 ===')

  it('findSimilarDispute：同义且同当事方命中，阈值高于共识点', () => {
    const list = [dispute()]
    const hit = findSimilarDispute(list, '上线前要不要先做灰度发布', ['m1', 'm2'])
    assert.ok(hit, '同一个分歧换个说法要能认出来')
    atLeast('命中阈值不得低于设定', claimCloseness(list[0]!.claim, hit!.claim), DISPUTE_DUP_THRESHOLD)
    assert.equal(findSimilarDispute(list, '上线前要不要先做灰度发布', ['m1', 'm3']), undefined, '当事方不同就不是同一个分歧')
    assert.equal(findSimilarDispute(list, '供应商合同改为按季度评审', ['m1', 'm2']), undefined, '措辞不像不能靠凑当事方来并')
  })

  it('mergeOpenDisputes 走同义查找：近义分歧不新增未决条数', () => {
    const previous = [dispute({ id: 'od_1' })]
    const incoming = [
      dispute({
        id: 'od_2',
        claim: '上线前要不要先做灰度发布',
        sides: [
          { agentId: 'm1', argument: '先灰度', utteranceIds: ['utt_3'] },
          { agentId: 'm2', argument: '直接全量', utteranceIds: ['utt_4'] },
        ],
        openedRound: 2,
      }),
    ]
    const r = mergeOpenDisputes(previous, incoming, 2)
    assert.equal(r.merged.length, 1, `近义分歧该并成一条，实际 ${r.merged.length} 条`)
    assert.equal(r.merged[0]!.id, 'od_1', '并到已有条目上，未决数不虚高')
    const far = mergeOpenDisputes(previous, [dispute({ id: 'od_3', claim: '预算是否按季度重审', openedRound: 2 })], 2)
    assert.equal(far.merged.length, 2, '不同分歧必须各自保留（只增不减）')
  })

  console.log('\n=== 呈现：报告与 Markdown 要说清并掉了几条 ===')

  it('buildReport 带出归并统计，Markdown 逐条列出被并的说法', () => {
    const topic: Topic = { id: 't1', title: '上线选型', strategy: 'roundtable', attachments: [], createdAt: 1 }
    const config: SessionConfig = {
      maxRounds: 2,
      consensusThreshold: 85,
      participantIds: ['m1', 'm2'],
      moderatorId: 'mm',
      budgetLimitUsd: 2,
      baseline: false,
      baselineCompare: false,
      verifyPass: 'off',
      timeBudgetMs: 0,
    }
    const utterances: Utterance[] = (
      [
        ['utt_1', 'm1', '第1轮：采用方案X，落地成本更低，迁移两周。'],
        ['utt_2', 'm2', '第2轮：同意方案X，成本依据可核对。'],
      ] as Array<[string, string, string]>
    ).map(([id, agentId, content], i) => ({
      id,
      sessionId: 't1',
      round: i + 1,
      agentId,
      content,
      targets: [],
      startedAt: 1,
      endedAt: 2,
      absent: false,
      human: false,
    })) as Utterance[]

    const confirmed = [
      point({
        id: 'cp_1',
        claim: '采用方案X以降低落地成本',
        support: ['m1', 'm2'],
        evidenceRef: ['utt_1', 'utt_2'],
        variants: ['采用方案X，落地成本更低'],
        confirmedRound: 1,
      }),
    ]
    const report = buildReport({
      topic,
      config,
      utterances,
      confirmed,
      open: [],
      explored: [],
      scores: [],
      modelNames: new Map([['m1', '甲'], ['m2', '乙']]),
      modelTransports: new Map<string, TransportKind>([['m1', 'api'], ['m2', 'api']]),
      totalCostUsd: 0,
      durationMs: 1000,
      budgetLimited: false,
      moderatorUnavailable: false,
      finishedReason: 'max-rounds',
      interventions: [],
      duels: [],
      dedup: { merged: 2, notes: ['「供应商按季度评审」被主持标为延续 cp_1，但字面不像同一条判断，按新条目登记'] },
    })
    assert.equal(report.meta.dedup?.merged, 2, '归并条数要进 meta，历史回看重算报告时才有依据')
    assert.deepEqual(report.consensus[0]!.variants, ['采用方案X，落地成本更低'], '条目级的其他说法要带进报告')

    const md = reportToMarkdown(report as unknown as Report, topic)
    assert.ok(md.includes('同一判断的其他说法'), 'Markdown 里要能看到被并掉的措辞没被丢弃')
    assert.ok(md.includes('共识点归并：2 条'), '口径章节要写明并掉几条')
    assert.ok(md.includes('归并未采纳'), '主持误标的 continues 要如实留痕')
    assert.ok(!md.includes('undefined'), '报告里不能出现 undefined')
  })

  console.log('-'.repeat(46))
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46))
  if (fail > 0) process.exit(1)
}

void main()
