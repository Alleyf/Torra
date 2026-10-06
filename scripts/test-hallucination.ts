/**
 * 幻觉治理自测 —— 「多轮交互到底在矫正误差，还是在放大误差」的可复算判据
 *
 * 覆盖四层：
 * - 测量：凭空引用 / 代答归因 / 空心改写 / 主持抬分（四条都是本场内部可判死的信号）
 * - 趋势：误差序列的 self_correcting / flat / compounding 判定
 * - 矫正：核验轮要不要跑、质询谁、答复怎么结算（只降级不删除）
 * - 呈现：风险分构成与 flag 触发线
 *
 * 运行：npm run test:hallucination
 */

import assert from 'node:assert/strict'
import {
  applyCorrection,
  attributedGrowth,
  auditCitations,
  buildCitationChallenge,
  buildEndorsementChallenge,
  buildHallucinationReport,
  buildRoundRecord,
  citationCorrection,
  classifyVerificationAnswer,
  claimSimilarity,
  dedupeTargets,
  hasBadCitation,
  judgeTrajectory,
  moderatorInflation,
  needsVerificationPass,
  pendingVerificationTargets,
  trackClaimDrift,
  VERIFY_RISK_THRESHOLD,
  type CitationIndex,
  type RoundRecordInput,
} from '../src/shared/hallucination'
import type { ConsensusPoint, HallucinationReport, HallucinationRoundRecord, TransportKind, Utterance } from '../src/shared/types'
import { buildReport, reportToMarkdown } from '../src/main/report/report'

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
    id: over.id ?? 'p1',
    claim: over.claim ?? '应当为报表系统引入实时计算层',
    support: over.support ?? ['m1', 'm2'],
    confidence: over.confidence ?? 0.8,
    evidenceRef: over.evidenceRef ?? ['utt_m1_r1'],
    confirmedRound: over.confirmedRound ?? 1,
  }
}

function record(round: number, errorCount: number): HallucinationRoundRecord {
  // 全部误差都记在「凭空引用」这一栏：趋势判定只看 errorCount 序列
  return buildRoundRecord({
    round,
    utterances: 4,
    citations: { badUtterances: errorCount, bogusRefs: errorCount, outOfRangeRefs: 0, unknownLabels: 0 },
    attributedGrowthCount: 0,
    drift: { hollow: 0, substantiated: 0 },
    inflation: 0,
  })
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. 凭空引用：本场内部可判死的三类 ===')

const idx = (over: Partial<CitationIndex> = {}): CitationIndex => ({
  utteranceIds: new Set(['utt_m1_r1', 'utt_m2_r1']),
  round: 2,
  aliases: ['参会者A', '参会者B'],
  ...over,
})

it('真实存在的发言 id 记为有效，不判幻觉', () => {
  const a = auditCitations('如 utt_m1_r1 与 utt_m2_r1 所述，第 1 轮已经验证过。', idx())
  assert.deepEqual(a.validUtteranceIds, ['utt_m1_r1', 'utt_m2_r1'])
  assert.equal(a.bogusUtteranceIds.length, 0)
  assert.equal(hasBadCitation(a), false)
  assert.equal(buildCitationChallenge(a), null)
})

it('重复引用同一个不存在的发言只记一次', () => {
  const a = auditCitations('utt_m9_r9 说过……再由 utt_m9_r9 佐证。', idx())
  assert.deepEqual(a.bogusUtteranceIds, ['utt_m9_r9'])
  assert.equal(hasBadCitation(a), true)
})

it('引用尚未发生的轮次（阿拉伯数字与中文都算）', () => {
  const a = auditCitations('第 5 轮的结论已经表明这点；第十一轮也一致。', idx({ round: 2 }))
  assert.deepEqual(a.outOfRangeRounds.sort((x, y) => x - y), [5, 11])
  assert.deepEqual(a.roundRefs.sort((x, y) => x - y), [5, 11])
})

it('第 0 轮不存在：引用它同样是凭空', () => {
  const a = auditCitations('这一点在第 0 轮就已达成共识。', idx())
  assert.deepEqual(a.outOfRangeRounds, [0])
})

it('别名轨里指名的对象不在参会名单 → 判死；署名轨不判（避免假阳性）', () => {
  const anon = auditCitations('参会者C 明确反对，参会者A 则支持。', idx())
  assert.deepEqual(anon.unknownLabels, ['参会者C'])
  const signed = auditCitations('参会者C 明确反对。', idx({ aliases: [] }))
  assert.deepEqual(signed.unknownLabels, [])
})

it('没按格式引用不算幻觉：noCitations 为 true', () => {
  const a = auditCitations('我认为实时层不必要，成本收益不匹配。', idx())
  assert.equal(a.noCitations, true)
  assert.equal(hasBadCitation(a), false)
})

it('回灌下一轮的质询文本把判据原样列出', () => {
  const q = buildCitationChallenge(auditCitations('utt_m9_r9 提过，第 7 轮也一致。', idx()))
  assert.ok(q)
  assert.ok(q!.includes('utt_m9_r9'))
  assert.ok(q!.includes('第 7 轮'))
  assert.ok(q!.includes('撤回'))
})

// ---------------------------------------------------------------------------
console.log('\n=== 2. 代答归因：主持替模型点的头 ===')

const utterances = [
  { id: 'utt_m1_r1', agentId: 'm1', targets: [] },
  { id: 'utt_m2_r1', agentId: 'm2', targets: [] },
]

it('support 里有 id 但 evidenceRef 里没有它 → 记为代答', () => {
  const p = point({ support: ['m1', 'm2'], evidenceRef: ['utt_m1_r1'] })
  const out = attributedGrowth([], [], [p], utterances)
  assert.equal(out.growthCount, 1)
  assert.equal(out.growth[0]!.agentId, 'm2')
})

it('跨轮做差集：上一轮已经暴露的代答不重复计入本轮', () => {
  const p = point({ support: ['m1', 'm2'], evidenceRef: ['utt_m1_r1'] })
  const first = attributedGrowth([], [], [p], utterances)
  const second = attributedGrowth([p], utterances, [p], utterances)
  assert.equal(first.growthCount, 1)
  assert.equal(second.growthCount, 0)
})

it('差集按论点文本认人，不按 pointId：编排器每轮重新生成 id', () => {
  // 编排器登记共识点时按 claim 去重、id 每轮新造（makeId('cp')）。
  // 若差集用 id 做键，同一处代答每轮都会被当成「新增」，风险分随轮次虚高。
  const prev = point({ id: 'cp_r1', support: ['m1', 'm2'], evidenceRef: ['utt_m1_r1'] })
  const carried = point({ id: 'cp_r2', support: ['m1', 'm2'], evidenceRef: ['utt_m1_r1'] })
  assert.equal(attributedGrowth([prev], utterances, [carried], utterances).growthCount, 0)
  const fresh = point({ id: 'cp_r2', claim: '另一条主张', support: ['m1', 'm2'], evidenceRef: ['utt_m1_r1'] })
  assert.equal(attributedGrowth([prev], utterances, [fresh], utterances).growthCount, 1)
})

it('全员有据 → 无代答', () => {
  const p = point({ support: ['m1'], evidenceRef: ['utt_m1_r1'] })
  assert.equal(attributedGrowth([], [], [p], utterances).growthCount, 0)
})

it('质询对象去重并按预算截断，已结算过的不再打扰', () => {
  const points = [
    point({ id: 'p1', support: ['m1', 'm2', 'm3'], evidenceRef: ['utt_m1_r1'] }),
    point({ id: 'p2', support: ['m2', 'm3'], evidenceRef: ['utt_m1_r1'] }),
  ]
  const all = pendingVerificationTargets(points, utterances, 10)
  assert.equal(dedupeTargets(all).length, all.length)
  assert.deepEqual(
    all
      .map((t) => `${t.pointId}:${t.agentId}`)
      .sort()
      .join(','),
    'p1:m2,p1:m3,p2:m2,p2:m3',
  )
  assert.equal(pendingVerificationTargets(points, utterances, 1).length, 1)
  // 已经否认并被移出 support 的 (p1,m2) 不应再来一遍
  const settled: ConsensusPoint[] = [
    {
      ...points[0]!,
      verification: { status: 'disputed', checkedRound: 2, attributed: ['m2'], confirmedBy: [], removed: ['m2'] },
    },
  ]
  assert.ok(!pendingVerificationTargets(settled, utterances, 10).some((t) => t.pointId === 'p1' && t.agentId === 'm2'))
})

// ---------------------------------------------------------------------------
console.log('\n=== 3. 论点漂移：被论据矫正，还是换个说法继续飘 ===')

it('相似度对称且同一句话为 1', () => {
  assert.equal(claimSimilarity('引入实时层', '引入实时层'), 1)
  assert.equal(claimSimilarity('引入实时层', '入实时层引'), claimSimilarity('入实时层引', '引入实时层'))
})

it('措辞变具体但证据一条没加 = 空心改写', () => {
  const prev = [point({ claim: '实时计算层是必要的，可以显著降低报表延迟', evidenceRef: ['utt_m1_r1'] })]
  const cur = [point({ claim: '实时计算层是必要的，能把报表 P95 延迟压到亚秒级', evidenceRef: ['utt_m1_r1'] })]
  const r = trackClaimDrift(prev, cur)
  assert.equal(r.hollow, 1)
  assert.equal(r.substantiated, 0)
  assert.equal(r.entries[0]!.kind, 'hollow_mutation')
  assert.equal(r.entries[0]!.evidenceDelta, 0)
  assert.ok(r.entries[0]!.drift > 0.3)
})

it('改写同时补了证据 = 有据修正（讨论真的在收敛）', () => {
  const prev = [point({ claim: '实时计算层是必要的，可以显著降低报表延迟', evidenceRef: ['utt_m1_r1'] })]
  const cur = [
    point({
      claim: '实时计算层是必要的，能把报表 P95 延迟压到亚秒级',
      evidenceRef: ['utt_m1_r1', 'utt_m2_r1'],
    }),
  ]
  const r = trackClaimDrift(prev, cur)
  assert.equal(r.substantiated, 1)
  assert.equal(r.hollow, 0)
  assert.equal(r.entries[0]!.evidenceDelta, 1)
})

it('复述（变化不到 30%）不进账本：不制造噪声', () => {
  const prev = [point({ claim: '应当为报表系统引入实时计算层' })]
  const cur = [point({ claim: '应当为报表系统引入实时计算层。' })]
  assert.equal(trackClaimDrift(prev, cur).entries.length, 0)
})

it('同一批共识点不会同时挂到两个旧点上', () => {
  const prev = [point({ id: 'a', claim: '应当为报表系统引入实时计算层' }), point({ id: 'b', claim: '缓存淘汰策略需要按业务日切重做' })]
  const cur = [point({ id: 'a', claim: '应当为报表系统引入实时计算层，把 P95 延迟压到亚秒' })]
  const r = trackClaimDrift(prev, cur)
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0]!.previousClaim, '应当为报表系统引入实时计算层')
})

// ---------------------------------------------------------------------------
console.log('\n=== 4. 主持抬分：只算「抬」不算「压」 ===')

it('自评高于核算 → 取最大正偏差', () => {
  assert.equal(moderatorInflation({ agreement: 90, overlap: 70, trend: 60 }, { agreement: 75, overlap: 70, trend: 60 }), 15)
})

it('自评低于核算 → 0（压低自己不是幻觉信号）', () => {
  assert.equal(moderatorInflation({ agreement: 40, overlap: 30, trend: 20 }, { agreement: 75, overlap: 80, trend: 90 }), 0)
})

// ---------------------------------------------------------------------------
console.log('\n=== 5. 轨迹判定：误差在收敛还是扩散 ===')

it('误差递减 = self_correcting', () => {
  const r = judgeTrajectory([record(1, 5), record(2, 3), record(3, 1), record(4, 0)])
  assert.equal(r.trajectory, 'self_correcting')
  assert.ok(r.note.includes('5 → 3 → 1 → 0'))
})

it('误差递增 = compounding（越聊越糟的直接证据）', () => {
  const r = judgeTrajectory([record(1, 0), record(2, 1), record(3, 4), record(4, 5)])
  assert.equal(r.trajectory, 'compounding')
  assert.ok(r.note.includes('自我强化'))
})

it('持平 = flat：既没矫正也没扩散', () => {
  assert.equal(judgeTrajectory([record(1, 2), record(2, 2), record(3, 2), record(4, 2)]).trajectory, 'flat')
})

it('单轮样本不判趋势，并说明为什么', () => {
  const r = judgeTrajectory([record(1, 3)])
  assert.equal(r.trajectory, 'insufficient_data')
  assert.ok(r.note.includes('至少需要 2 轮'))
})

it('errorCount 组成：代答与空心改写计入，抬分只在 >=10 时计 1', () => {
  const base: RoundRecordInput = {
    round: 2,
    utterances: 4,
    citations: { badUtterances: 1, bogusRefs: 2, outOfRangeRefs: 1, unknownLabels: 3 },
    attributedGrowthCount: 2,
    drift: { hollow: 1, substantiated: 4 },
    inflation: 9,
  }
  // 1 条坏引用发言 + 1 处越界轮次 + 2 条代答 + 1 条空心改写 = 5；
  // unknownLabels 只登记不重复计（它与 badUtterances 常来自同一条发言）
  assert.equal(buildRoundRecord(base).errorCount, 5)
  assert.equal(buildRoundRecord({ ...base, inflation: 10 }).errorCount, 6)
})

// ---------------------------------------------------------------------------
console.log('\n=== 6. 风险分与 flag ===')

it('干净场次风险分为 0、无 flag', () => {
  const h = buildHallucinationReport({
    records: [buildRoundRecord({ round: 1, utterances: 4, citations: { badUtterances: 0, bogusRefs: 0, outOfRangeRefs: 0, unknownLabels: 0 }, attributedGrowthCount: 0, drift: { hollow: 0, substantiated: 0 }, inflation: 0 })],
    totalClaimedSupport: 6,
    totalAttributedSupport: 0,
    corrections: [],
    vacatedPoints: 0,
    triggeredBy: 'none',
  })
  assert.equal(h.riskScore, 0)
  assert.equal(h.flags.length, 0)
  assert.equal(h.citationBogusRate, 0)
})

it('风险分按 3:4:2:2 加权，代答权重最高（它直接伪造「谁同意了」）', () => {
  const h = buildHallucinationReport({
    records: [
      buildRoundRecord({
        round: 1,
        utterances: 10,
        citations: { badUtterances: 2, bogusRefs: 2, outOfRangeRefs: 0, unknownLabels: 0 },
        attributedGrowthCount: 0,
        drift: { hollow: 2, substantiated: 2 },
        inflation: 10,
      }),
    ],
    totalClaimedSupport: 10,
    totalAttributedSupport: 3,
    corrections: [],
    vacatedPoints: 0,
    triggeredBy: 'auto',
  })
  // 20%×0.3 + 30%×0.4 + 50%×0.2 + 10×0.2 = 30（单轮 → insufficient_data 不加权）
  assert.equal(h.citationBogusRate, 20)
  assert.equal(h.attributedRate, 30)
  assert.equal(h.hollowMutationRate, 50)
  assert.equal(h.trajectory, 'insufficient_data')
  assert.equal(h.riskScore, 30)
  assert.equal(h.flags.length, 3)
})

it('compounding 放大风险、self_correcting 衰减：同一绝对值不是一回事', () => {
  const base = {
    totalClaimedSupport: 10,
    totalAttributedSupport: 3,
    corrections: [],
    vacatedPoints: 0,
    triggeredBy: 'auto',
  }
  const mk = (counts: number[]) => ({
    ...base,
    records: counts.map((c, i) => record(i + 1, c)),
  })
  const rising = buildHallucinationReport(mk([0, 1, 4, 5]))
  const falling = buildHallucinationReport(mk([5, 4, 1, 0]))
  assert.equal(rising.trajectory, 'compounding')
  assert.equal(falling.trajectory, 'self_correcting')
  assert.ok(rising.riskScore > falling.riskScore)
  assert.ok(rising.flags.some((f) => f.includes('只采信最近一轮')))
})

// ---------------------------------------------------------------------------
console.log('\n=== 7. 核验轮：闸门、答复归类、结算只降级 ===')

it('off 只测量不质询；always 有代答就质询', () => {
  const rep = { riskScore: 90, trajectory: 'compounding' as const, attributedTotal: 3 }
  assert.equal(needsVerificationPass('off', rep).needed, false)
  assert.equal(needsVerificationPass('always', rep).needed, true)
  assert.equal(needsVerificationPass(undefined, rep).needed, true)
})

it('没有代答时任何模式都不追加批次', () => {
  assert.equal(needsVerificationPass('always', { riskScore: 90, trajectory: 'flat', attributedTotal: 0 }).needed, false)
})

it('auto：风险分未达阈值且误差未放大 → 不打扰', () => {
  const r = needsVerificationPass('auto', { riskScore: VERIFY_RISK_THRESHOLD - 1, trajectory: 'flat', attributedTotal: 2 })
  assert.equal(r.needed, false)
  assert.ok(r.triggeredBy.includes('暂不追加'))
})

it('auto：低分但误差放大仍要质询', () => {
  assert.equal(needsVerificationPass('auto', { riskScore: 10, trajectory: 'compounding', attributedTotal: 1 }).needed, true)
})

it('答复归类：否认优先，模糊按限定，空转按未答', () => {
  assert.equal(classifyVerificationAnswer(''), 'no_response')
  assert.equal(classifyVerificationAnswer('我并没有说过这句话，实际主张是相反的。'), 'denied')
  assert.equal(classifyVerificationAnswer('我确认支持，同时更准确地说需要限定在日切窗口内。'), 'clarified')
  assert.equal(classifyVerificationAnswer('我确认这是我的立场，见 utt_m1_r1。'), 'confirmed')
  assert.equal(classifyVerificationAnswer('这个话题我们可以再讨论。'), 'clarified')
})

it('质询文本把「被安在你头上的话」原样还给模型', () => {
  const q = buildEndorsementChallenge({ pointId: 'p1', claim: '实时层有必要', agentId: 'm2' })
  assert.ok(q.includes('实时层有必要'))
  assert.ok(q.includes('三选一'))
})

it('denied：移出 support 但共识点本身不消失', () => {
  const p = point({ support: ['m1', 'm2'], evidenceRef: ['utt_m1_r1'] })
  const { point: next, correction } = applyCorrection(p, {
    agentId: 'm2',
    outcome: 'denied',
    round: 3,
    utteranceId: 'utt_m2_r3',
    question: 'q',
    answer: '我并没有说过',
  })
  assert.deepEqual(next.support, ['m1'])
  assert.equal(next.verification?.status, 'disputed')
  assert.deepEqual(correction.removedSupport, ['m2'])
  assert.equal(correction.addedEvidenceRef.length, 0)
})

it('全员否认 → vacated 留档，不静默删除', () => {
  const p = point({ support: ['m2'], evidenceRef: ['utt_m1_r1'] })
  const { point: next } = applyCorrection(p, {
    agentId: 'm2',
    outcome: 'denied',
    round: 3,
    utteranceId: null,
    question: 'q',
    answer: '这不是我的立场',
  })
  assert.deepEqual(next.support, [])
  assert.equal(next.verification?.status, 'vacated')
  assert.ok(next.claim.length > 0)
})

it('confirmed：本次答复登记为证据，代答转为可核对', () => {
  const p = point({ support: ['m1', 'm2'], evidenceRef: ['utt_m1_r1'] })
  const { point: next, correction } = applyCorrection(p, {
    agentId: 'm2',
    outcome: 'confirmed',
    round: 3,
    utteranceId: 'utt_m2_r3',
    question: 'q',
    answer: '我确认这是我的立场',
  })
  assert.deepEqual(next.support, ['m1', 'm2'])
  assert.deepEqual(next.evidenceRef, ['utt_m1_r1', 'utt_m2_r3'])
  assert.ok(next.verification?.confirmedBy?.includes('m2'))
  assert.equal(next.verification?.status, 'verified')
  assert.deepEqual(correction.addedEvidenceRef, ['utt_m2_r3'])
})

it('clarified：支持保留但不算点头（从 confirmedBy 里剔除）', () => {
  const p = point({ support: ['m1', 'm2'], evidenceRef: ['utt_m1_r1', 'utt_m2_r1'] })
  const { point: next } = applyCorrection(p, {
    agentId: 'm2',
    outcome: 'confirmed',
    round: 3,
    utteranceId: 'utt_m2_r3',
    question: 'q',
    answer: '我确认',
  })
  const again = applyCorrection(next, {
    agentId: 'm2',
    outcome: 'clarified',
    round: 4,
    utteranceId: 'utt_m2_r4',
    question: 'q',
    answer: '更准确地说需要限定条件',
  })
  assert.ok(!again.point.verification?.confirmedBy?.includes('m2'))
  assert.equal(again.point.verification?.status, 'verified')
})

it('结算不引入新 id：utteranceId 为 null 时 evidenceRef 不变', () => {
  const p = point({ evidenceRef: ['utt_m1_r1'] })
  const { point: next } = applyCorrection(p, {
    agentId: 'm2',
    outcome: 'clarified',
    round: 3,
    utteranceId: null,
    question: 'q',
    answer: '需要限定',
  })
  assert.deepEqual(next.evidenceRef, ['utt_m1_r1'])
})

it('凭空引用只留账，不改动任何 support', () => {
  const c = citationCorrection({
    agentId: 'm1',
    round: 2,
    issue: 'bogus_citation',
    question: 'q',
    answer: '我并没有说过',
    utteranceId: 'utt_m1_r2',
  })
  assert.equal(c.outcome, 'denied')
  assert.equal(c.issue, 'bogus_citation')
  assert.deepEqual(c.removedSupport, [])
  assert.equal(citationCorrection({ agentId: 'm1', round: 2, issue: 'bogus_citation', question: 'q', answer: null, utteranceId: null }).outcome, 'no_response')
})

// ---------------------------------------------------------------------------
console.log('\n=== 8. 报告层：治理结果必须落到能读的文字里 ===')

const repUtterances = (): Utterance[] => [
  {
    id: 'utt_m1_r1',
    round: 1,
    agentId: 'm1',
    content: '报表侧的 P95 已经顶到 8 秒，缓存加批处理在日均 2 万次查询下压不下去了，所以实时层是必要的',
    targets: [],
    citations: auditCitations('如 utt_m2_r1 所述。', { utteranceIds: new Set(['utt_m1_r1', 'utt_m2_r1']), round: 2, aliases: [] }),
    usage: { promptTokens: 100, completionTokens: 200, costUsd: 0.01 },
    stance: 'support',
    startedAt: 0,
    endedAt: 1000,
  },
  {
    id: 'utt_m2_r1',
    round: 1,
    agentId: 'm2',
    content: '同意实时化的必要性，但要先给出常驻成本上限，否则计算层的月度开销会盖过延迟收益',
    targets: ['utt_m1_r1'],
    citations: auditCitations('如 utt_m9_r9 所述，第 7 轮已经定论。', {
      utteranceIds: new Set(['utt_m1_r1', 'utt_m2_r1']),
      round: 2,
      aliases: [],
    }),
    usage: { promptTokens: 90, completionTokens: 150, costUsd: 0.02 },
    stance: 'support',
    startedAt: 0,
    endedAt: 1200,
  },
]

const repPoints = (): ConsensusPoint[] => [
  {
    id: 'p1',
    claim: '报表侧需要引入实时计算层',
    support: ['m1', 'm2'],
    confidence: 0.9,
    evidenceRef: ['utt_m1_r1', 'utt_m2_r1'],
    confirmedRound: 2,
    verification: { status: 'disputed', checkedRound: 3, attributed: ['m2'], confirmedBy: ['m1'], removed: ['m2'] },
  },
]

function repInput(hallucination: HallucinationReport | null, extra: object = {}) {
  return {
    topic: { id: 't1', title: '是否为报表系统引入实时计算层', background: '', strategy: 'roundtable' as const, attachments: [], createdAt: 0 },
    config: {
      maxRounds: 3,
      consensusThreshold: 85,
      participantIds: ['m1', 'm2'],
      moderatorId: 'mo',
      budgetLimitUsd: 2,
      baseline: true,
      baselineCompare: true,
      verifyPass: 'auto' as const,
      timeBudgetMs: 900_000,
    },
    utterances: repUtterances(),
    confirmed: repPoints(),
    open: [],
    scores: [{ round: 2, score: { agreement: 90, overlap: 88, trend: 92, score: 90, agreementSource: 'stance' as const, overlapSource: 'program' as const, independence: 1 } }],
    modelNames: new Map([['m1', 'Alpha'], ['m2', 'Beta'], ['mo', 'Moderator']]),
    modelTransports: new Map<string, TransportKind>([['m1', 'api'], ['m2', 'webview'], ['mo', 'api']]),
    totalCostUsd: 0.03,
    durationMs: 240_000,
    budgetLimited: false,
    moderatorUnavailable: false,
    finishedReason: 'converged' as const,
    interventions: [],
    duels: [],
    hallucination,
    ledger: { apiCalls: 6, webCalls: 4, moderatorCalls: 2, totalMs: 240_000 },
    baseline: {
      agentId: 'mo',
      displayName: 'Moderator',
      transport: 'api',
      content: '建议先做查询侧物化视图，成本低于常驻计算层。',
      startedAt: 0,
      endedAt: 4000,
      costUsd: 0.01,
    },
    baselineCompare: {
      verdict: 'baseline_better',
      councilAdds: ['补出了日切窗口冲突这条前提'],
      councilDrops: ['丢掉了物化视图这条更便宜的替代方案'],
      regressions: [],
      note: '研讨把延迟收益谈成了共识，却没有解释为什么不选成本更低的方案。',
      raw: '{}',
    },
    timeLimited: false,
    digestCompacted: true,
    ...extra,
  }
}

const riskyReport = buildHallucinationReport({
  records: [record(1, 0), record(2, 2), record(3, 4), record(4, 5)],
  totalClaimedSupport: 8,
  totalAttributedSupport: 5,
  corrections: [
    citationCorrection({ agentId: 'm2', round: 2, issue: 'bogus_citation', question: 'q', answer: '我并没有说过', utteranceId: null }),
  ],
  vacatedPoints: 1,
  triggeredBy: 'auto：风险分越线',
})

it('高幻觉风险会把「强结论」降级，而不只是附一章说明', () => {
  const clean = buildReport(repInput(null) as never)
  const risky = buildReport(repInput(riskyReport) as never)
  assert.equal(clean.verdict.level, 'strong')
  assert.equal(risky.verdict.level, 'qualified')
  assert.ok(risky.verdict.headline.includes('幻觉风险'))
  assert.ok(risky.verdict.reasons.some((x) => x.includes('凭空引用')))
})

it('报告正文给出治理章节、逐轮轨迹与核验结算', () => {
  const md = reportToMarkdown(buildReport(repInput(riskyReport) as never), repInput(null).topic)
  assert.ok(md.includes('幻觉治理'))
  assert.ok(md.includes('误差随轮次') || md.includes('越聊越糟') || md.includes('自我强化'))
  assert.ok(md.includes('核验'), '每条共识的核验状态要出现在溯源行里')
  assert.ok(md.includes('无人否认'), '未答的条目必须写明「沉默不等于同意」')
})

it('基线对照进报告，且「基线更好」会出现在下一步建议里', () => {
  const r = buildReport(repInput(riskyReport) as never)
  const md = reportToMarkdown(r, repInput(null).topic)
  assert.ok(md.includes('单模型基线'))
  assert.ok(md.includes('丢掉了物化视图'))
  assert.ok(r.nextActions.some((x) => x.includes('基线')))
})

it('网页通道的代价不伪装成金额：台账与费用口径同时给出', () => {
  const r = buildReport(repInput(null) as never)
  assert.ok(r.meta?.channels)
  assert.equal(r.meta!.channels!.webCalls, 4)
  assert.ok(r.meta!.channels!.costNote!.includes('网页通道'), '有网页调用时必须注明金额只覆盖 API 通道')
  assert.equal(r.meta!.digestCompacted, true)
  const md = reportToMarkdown(r, repInput(null).topic)
  assert.ok(md.includes('调用台账'))
  assert.ok(md.includes('时长预算'))
  assert.ok(md.includes('已排除方向'))
  assert.ok(md.includes('费用口径'))
})

console.log('\n==============================================')
console.log(`  通过 ${pass} · 失败 ${fail}`)
console.log('==============================================')
if (fail > 0) process.exit(1)
