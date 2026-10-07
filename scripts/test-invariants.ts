/**
 * 核心不变量自测（M1 出口标准的可自动化部分）
 *
 * 覆盖 PRD 6.7 / 6.8 的硬约束：
 * - 机械校验能否拦住「凭空生成的共识」
 * - 主张一致度 / 论点重合度 / 收敛趋势的核算是否正确
 * - 未决分歧是否真的只增不减
 * - 压缩时 open 是否逐字保留
 *
 * 运行：npm run test:invariants
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Orchestrator, type OrchestratorEvent } from '../src/main/orchestrator/orchestrator'
import {
  agreementDimNote,
  applyDisputeUpdates,
  buildFinalReview,
  computeAgreement,
  computeOverlap,
  computeTrend,
  compressDigest,
  evaluateConvergence,
  FINAL_REVIEW_CAP,
  makeId,
  mergeOpenDisputes,
  openOnly,
  renderDigestForPrompt,
  resolveOverlap,
  shelvedOnly,
  validateModeratorDigest,
  weightedScore,
} from '../src/shared/invariants'
import type { ModeratorDigest, OpenDispute, SessionConfig, Topic, Utterance } from '../src/shared/types'
import { INJECT_SCRIPT } from '../src/main/webview/inject'
import { applyReorder, visibleInOrder } from '../src/main/store/model-order'

import {
  createIntervention,
  deliverInterventions,
  humanUtterance,
  modelUtterancesOnly,
  renderInterventions,
  summarizeInterventions,
} from '../src/shared/interventions'
import { HUMAN_AGENT_ID } from '../src/shared/types'
import {
  availableRetryModes,
  renderPriorConclusion,
  validateRetryPlan,
  type RetrySource,
} from '../src/shared/retry'

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

function utt(agentId: string, stance?: Utterance['stance'], content = 'x'): Utterance {
  return {
    id: makeId('u'),
    round: 1,
    agentId,
    content,
    targets: [],
    ...(stance ? { stance } : {}),
    startedAt: 0,
    endedAt: 0,
  }
}

console.log('\n=== 共识度核算（PRD 6.7）===')

it('主张一致度：同立场但全是口号 → 只能拿到阵营占比的 6 成', () => {
  // content 只有 1 字、没点名回应、也没被共识点引为证据 => independence 0
  const us = [utt('a', 'support'), utt('b', 'support'), utt('c', 'support')]
  const r = computeAgreement(us)
  assert.equal(r.source, 'stance')
  assert.equal(r.independence, 0)
  assert.equal(r.value, 60)
})

it('主张一致度：同立场且带论据 = 100（独立性折扣不打满）', () => {
  const us = [
    utt('a', 'support', '报表实时化会显著增加计算层的常驻成本，但 P95 延迟从 8 秒降到亚秒是可量化的业务收益'),
    utt('b', 'support', '同意前一位的核心论据：日均 2 万次的查询量级下，缓存加批处理已无法覆盖峰值窗口的读放大'),
    utt('c', 'support', '补充一条被忽略的前提：现有批处理窗口与业务日切时间冲突，延迟问题无法靠错峰调度解决'),
  ]
  const r = computeAgreement(us)
  assert.equal(r.independence, 1)
  assert.equal(r.value, 100)
})

it('主张一致度：主导阵营里一条没论据 → 份额与独立性双重打折', () => {
  const us = [
    utt('a', 'support', '报表实时化会显著增加计算层的常驻成本，但 P95 延迟从 8 秒降到亚秒是可量化的业务收益'),
    utt('b', 'support', '同意前一位的核心论据：日均 2 万次的查询量级下，缓存加批处理已无法覆盖峰值窗口的读放大'),
    // 短口号、没回应任何人、也没被共识点引为证据
    utt('c', 'support', '同意'),
    utt('d', 'oppose', '反对，但理由还需要再想想，这里先不展开论述具体内容'),
  ]
  const r = computeAgreement(us)
  // 主导阵营占 3/4 = 75，阵营内 2/3 带论据 => 75 × (0.6 + 0.4×0.67)
  assert.equal(r.independence, 0.67)
  assert.equal(r.value, 65.1)
})

it('主张一致度：被共识点引为证据也算带论据（短但可核对）', () => {
  const a = utt('a', 'support', '同意')
  const b = utt('b', 'support', '同意')
  const points = [
    {
      id: 'p1',
      claim: 'A',
      support: ['a', 'b'],
      confidence: 0.9,
      evidenceRef: [a.id, b.id],
      confirmedRound: 1,
    },
  ]
  assert.equal(computeAgreement([a, b]).independence, 0)
  assert.equal(computeAgreement([a, b], points).independence, 1)
})

it('主张一致度：二对一 = 66.7 × 独立性', () => {
  const us = [utt('a', 'support'), utt('b', 'support'), utt('c', 'oppose')]
  const r = computeAgreement(us)
  // 主导阵营 2/3 = 66.7，无论据打折到 0.6 => 40
  assert.equal(r.value, 40)
})

it('主张一致度：无立场标记 = 记中性 50 并标注来源（不再压死总分）', () => {
  const r = computeAgreement([utt('a'), utt('b')])
  assert.equal(r.source, 'no_stance')
  assert.equal(r.independence, null)
  assert.equal(r.value, 50)
})

it('主张一致度：全场只有一句表态时不算「测到了」', () => {
  // 研讨不是辩论：补充、限定、换角度的发言不会写「我支持/我反对」
  const r = computeAgreement([utt('a', 'support'), utt('b'), utt('c'), utt('d'), utt('e')])
  assert.equal(r.coverage, 0.2)
  assert.equal(r.source, 'no_stance')
  // value 照旧算出来，摆着看不碍事 —— 权重让位是 source 决定的
  assert.equal(r.value, 60)
})

it('主张一致度：覆盖率门槛卡在 1/3，两条表态就算这一维', () => {
  assert.equal(computeAgreement([utt('a', 'support'), utt('b'), utt('c')]).source, 'no_stance')
  assert.equal(computeAgreement([utt('a', 'support'), utt('b', 'support'), utt('c'), utt('d')]).source, 'stance')
})

it('重合度口径：有共识点时只认程序值，主持自评抬不动', () => {
  const points = [
    { id: '1', claim: 'A', support: ['m1', 'm2'], confidence: 0.9, evidenceRef: ['u1'], confirmedRound: 1 },
    { id: '2', claim: 'B', support: ['m1'], confidence: 0.8, evidenceRef: ['u2'], confirmedRound: 1 },
  ]
  assert.equal(computeOverlap(points), 50)
  assert.deepEqual(resolveOverlap(50, 92, points.length), { value: 50, source: 'program' })
  assert.deepEqual(resolveOverlap(50, 92, 0), { value: 92, source: 'moderator_fallback' })
  assert.deepEqual(resolveOverlap(50, NaN, 0), { value: 0, source: 'moderator_fallback' })
})

it('收敛判定：首轮一律不判收敛（模型之间还没交叉看过）', () => {
  const r = evaluateConvergence({
    round: 1,
    openCount: 0,
    shelvedCount: 0,
    newPoints: 0,
    crossExaminedRate: 100,
    speakerCount: 3,
  })
  assert.equal(r.converged, false)
  assert.equal(r.path, 'none')
})

it('收敛判定：加权分再高也不终止 —— 分数路径已整个删掉', () => {
  // 曾经是 score>=threshold 直接散会：还剩 2 条未决、质询覆盖 0% 也能走
  const r = evaluateConvergence({
    round: 2,
    openCount: 2,
    shelvedCount: 0,
    newPoints: 3,
    crossExaminedRate: 0,
    speakerCount: 3,
  })
  assert.equal(r.converged, false)
  assert.equal(r.path, 'none')
  assert.match(r.reason, /结构条件未满足/)
})

it('收敛判定：搁置不阻塞收束，但理由里必须点名它', () => {
  const r = evaluateConvergence({
    round: 3,
    openCount: 0,
    shelvedCount: 2,
    newPoints: 0,
    crossExaminedRate: 66.7,
    speakerCount: 3,
  })
  assert.equal(r.converged, true)
  assert.match(r.reason, /搁置/)
  assert.match(r.reason, /风险段/)
})

it('收敛判定：结构四条件任一不成立都要退回', () => {
  const base = { round: 3, shelvedCount: 0, speakerCount: 3 }
  const r = evaluateConvergence({
    ...base,
    openCount: 0,
    newPoints: 0,
    crossExaminedRate: 66.7,
  })
  assert.equal(r.converged, true)
  assert.equal(r.path, 'structural')
  assert.equal(evaluateConvergence({ ...base, openCount: 1, newPoints: 0, crossExaminedRate: 66.7 }).converged, false)
  assert.equal(evaluateConvergence({ ...base, openCount: 0, newPoints: 2, crossExaminedRate: 66.7 }).converged, false)
  assert.equal(evaluateConvergence({ ...base, openCount: 0, newPoints: 0, crossExaminedRate: 40 }).converged, false)
  assert.equal(evaluateConvergence({ ...base, openCount: 0, newPoints: 0, crossExaminedRate: 60, speakerCount: 1 }).converged, false)
})

it('收敛趋势：分歧减少 = 上升', () => {
  // 分歧从 5 降到 2，delta=3 → 50+75=125，超出上限被 clamp 到 100
  assert.equal(computeTrend(2, 5), 100)
  // 小幅减少：3→2，delta=1 → 75
  assert.equal(computeTrend(2, 3), 75)
  assert.equal(computeTrend(0, 3), 100)
  // 分歧增加：2→6，delta=-4 → 50-100 → clamp 到 0
  assert.equal(computeTrend(6, 2), 0)
})

it('收敛趋势：首轮无基准 = 50', () => {
  assert.equal(computeTrend(3, null), 50)
})

it('加权综合分：权重 0.4/0.3/0.3', () => {
  // 100*0.4 + 50*0.3 + 0*0.3 = 40 + 15 = 55
  const s = weightedScore({ agreement: 100, overlap: 50, trend: 0 })
  assert.equal(s.score, 55)
})

it('加权综合分：表态句式不可数时，那一维让位成 0/0.5/0.5', () => {
  // 50*0.4 + 80*0.3 + 90*0.3 = 71：那个 50 是常数占位，却吃掉 0.4 的权重
  assert.equal(weightedScore({ agreement: 50, overlap: 80, trend: 90 }, 'stance').score, 71)
  // 摊权以后只由真算出来的两维决定：80*0.5 + 90*0.5 = 85
  assert.equal(weightedScore({ agreement: 50, overlap: 80, trend: 90 }, 'no_stance').score, 85)
  // agreement 填什么都不影响综合分 —— 它没进
  assert.equal(weightedScore({ agreement: 0, overlap: 80, trend: 90 }, 'no_stance').score, 85)
  // 来源随分数一起落地：UI 与报告才知道该写「不计入」
  assert.equal(weightedScore({ agreement: 50, overlap: 80, trend: 90 }, 'no_stance').agreementSource, 'no_stance')
})

it('加权综合分：非辩论场不按表态加权（没指派正反方，零星「我同意」不算站队）', () => {
  // 同一份 stance 来源的分数，策略换成圆桌后 agreement 必须掉出加权
  assert.equal(weightedScore({ agreement: 100, overlap: 50, trend: 0 }, 'stance', 'debate').score, 55)
  assert.equal(weightedScore({ agreement: 100, overlap: 50, trend: 0 }, 'stance', 'roundtable').score, 25)
  assert.equal(weightedScore({ agreement: 100, overlap: 50, trend: 0 }, 'stance', 'review').score, 25)
  // 只传来源不传策略的旧调用保持原义（覆盖率闸门仍管着辩论场内部）
  assert.equal(weightedScore({ agreement: 100, overlap: 50, trend: 0 }, 'stance').score, 55)
})

it('口径说明只在算不出的那一维上出现，两种让位原因要分开', () => {
  assert.equal(
    agreementDimNote({ agreementSource: 'no_stance' }),
    '本场没有可数的表态句式，这一维未计入综合分',
  )
  assert.equal(
    agreementDimNote({ agreementSource: 'stance' }, 'roundtable'),
    '本场不是辩论策略（没有指派正反方），零星的表态措辞不作为加权依据，这一维未计入综合分',
  )
  assert.equal(agreementDimNote({ agreementSource: 'stance' }, 'debate'), '')
  assert.equal(agreementDimNote({ agreementSource: 'stance' }), '')
  assert.equal(agreementDimNote(undefined), '')
})

console.log('\n=== 主持小结机械校验（PRD 6.7 防假收敛主防线）===')

const REAL_UTT = new Set(['u1', 'u2'])
const REAL_AGENT = new Set(['m1', 'm2', 'mod'])

function baseDigest(): ModeratorDigest {
  return {
    consensus_points: [
      { claim: '应引入缓存层', support: ['m1', 'm2'], confidence: 0.8, evidence_ref: ['u1', 'u2'] },
    ],
    open_disputes: [
      { claim: '是否需要双写', sides: [{ agent_id: 'm1', argument: '需要' }, { agent_id: 'm2', argument: '不需要' }] },
    ],
    score_dimensions: { agreement: 70, overlap: 60, trend: 50 },
    score: 61,
    next_round_order: ['m1', 'm2'],
    callout: null,
  }
}

it('合法小结通过校验', () => {
  const v = validateModeratorDigest(baseDigest(), REAL_UTT, REAL_AGENT)
  assert.equal(v.ok, true, v.errors.join('; '))
})

it('拦截凭空生成的共识：support 含不存在的模型', () => {
  const d = baseDigest()
  d.consensus_points[0]!.support = ['m1', 'ghost']
  const v = validateModeratorDigest(d, REAL_UTT, REAL_AGENT)
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /没有真实发言支撑/)
})

it('拦截 evidence_ref 指向不存在的发言', () => {
  const d = baseDigest()
  d.consensus_points[0]!.evidence_ref = ['u1', 'fake-id']
  const v = validateModeratorDigest(d, REAL_UTT, REAL_AGENT)
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /不存在的发言 id/)
})

it('拦截缺失 evidence_ref 的共识点', () => {
  const d = baseDigest()
  d.consensus_points[0]!.evidence_ref = []
  const v = validateModeratorDigest(d, REAL_UTT, REAL_AGENT)
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /不得凭空生成/)
})

it('单方分歧合法：只有一方存疑也是未决条目，不逼主持编出第二方', () => {
  const d = baseDigest()
  d.open_disputes = [{ claim: 'X', sides: [{ agent_id: 'm1', argument: 'only one' }] }]
  const v = validateModeratorDigest(d, REAL_UTT, REAL_AGENT)
  assert.equal(v.ok, true, v.errors.join('; '))
})

it('但空 sides 仍然拒绝 —— 放开的是「凑第二方」，不是「登记一条没有内容的分歧」', () => {
  const d = baseDigest()
  d.open_disputes = [{ claim: 'X', sides: [] }]
  const v = validateModeratorDigest(d, REAL_UTT, REAL_AGENT)
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /缺少任何一方论据/)
})

it('拦截缺失三维度中的任一维度', () => {
  const d = baseDigest()
  // @ts-expect-error 故意构造非法输入
  d.score_dimensions = { agreement: 70, overlap: 60 }
  const v = validateModeratorDigest(d, REAL_UTT, REAL_AGENT)
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /score_dimensions/)
})

console.log('\n=== 未决分歧只增不减（PRD 6.8 硬约束）===')

function dispute(claim: string, status: OpenDispute['status'] = 'open', ref?: string[]): OpenDispute {
  return {
    id: makeId('od'),
    claim,
    sides: [
      { agentId: 'm1', argument: 'A', utteranceIds: [] },
      { agentId: 'm2', argument: 'B', utteranceIds: [] },
    ],
    openedRound: 1,
    lastProgress: null,
    status,
    ...(ref ? { resolutionRef: ref } : {}),
  }
}

it('本轮未提及的历史分歧不得消失', () => {
  const prev = [dispute('争议A'), dispute('争议B')]
  const { merged } = mergeOpenDisputes(prev, [dispute('新争议C')], 2)
  assert.equal(openOnly(merged).length, 3)
  assert.ok(merged.some((d) => d.claim === '争议B'), '历史分歧 B 被静默抹掉了')
})

it('拒绝无消解依据的消解声明，保留为 open', () => {
  const prev = [dispute('争议A')]
  const { merged, rejected } = mergeOpenDisputes(prev, [dispute('争议A', 'resolved')], 2)
  assert.equal(merged[0]!.status, 'open')
  assert.equal(rejected.length, 1)
})

it('带消解依据时允许标记为 resolved', () => {
  const prev = [dispute('争议A')]
  const { merged } = mergeOpenDisputes(prev, [dispute('争议A', 'resolved', ['u9'])], 2)
  assert.equal(merged[0]!.status, 'resolved')
  assert.deepEqual(merged[0]!.resolutionRef, ['u9'])
})

it('丢弃 claim 为空的分歧', () => {
  const { rejected } = mergeOpenDisputes([], [{ ...dispute('  ') }], 1)
  assert.equal(rejected.length, 1)
})

console.log('\n=== 分歧处置：消解与搁置（条目级出口）===')

const UTT_IDS = new Set(['u1', 'u2'])

function update(d: Partial<NonNullable<ModeratorDigest['dispute_updates']>[number]> & { dispute: string }) {
  return { action: 'resolved', reason: '双方接受了同一个前提', evidence_ref: ['u1'], ...d }
}

it('带依据的消解：状态改、原文逐字留', () => {
  const target = dispute('争议A')
  const { merged, rejected } = applyDisputeUpdates([target], [update({ dispute: target.id })], 3, UTT_IDS)
  assert.equal(rejected.length, 0)
  assert.equal(merged[0]!.status, 'resolved')
  assert.deepEqual(merged[0]!.resolutionRef, ['u1'])
  assert.deepEqual(merged[0]!.sides, target.sides, '处置顺手改写了各方论点原文')
  assert.equal(merged[0]!.claim, '争议A')
})

it('搁置必须写缺什么证据：空着就是体面的弃权，拒绝', () => {
  const target = dispute('争议A')
  const noMissing = applyDisputeUpdates(
    [target],
    [update({ dispute: target.claim, action: 'shelved' })],
    3,
    UTT_IDS,
  )
  assert.equal(noMissing.merged[0]!.status, 'open')
  assert.match(noMissing.rejected[0] ?? '', /搁置不是体面的弃权/)

  const ok = applyDisputeUpdates(
    [target],
    [update({ dispute: target.claim, action: 'shelved', missing_evidence: '缺近 30 天的真实错误率' })],
    4,
    UTT_IDS,
  )
  assert.equal(ok.merged[0]!.status, 'shelved')
  assert.equal(ok.merged[0]!.shelve?.missing, '缺近 30 天的真实错误率')
  assert.equal(ok.merged[0]!.shelve?.round, 4)
  assert.deepEqual(shelvedOnly(ok.merged).map((d) => d.claim), ['争议A'])
  // 搁置不阻塞收束，所以它不能同时被算成「还开着」
  assert.equal(openOnly(ok.merged).length, 0)
})

it('凭空处置 / 重复处置 / 依据指向不存在的发言：都要留痕并丢弃', () => {
  const target = dispute('争议A')
  const phantom = applyDisputeUpdates([target], [update({ dispute: '争议Z' })], 3, UTT_IDS)
  assert.equal(phantom.merged[0]!.status, 'open')
  assert.match(phantom.rejected[0] ?? '', /不在清单里/)

  const twice = applyDisputeUpdates(
    [{ ...target, status: 'shelved', shelve: { reason: 'r', missing: 'm', round: 2 } }],
    [update({ dispute: target.id })],
    3,
    UTT_IDS,
  )
  assert.match(twice.rejected[0] ?? '', /不重复处置/)

  const bogusRef = applyDisputeUpdates([target], [update({ dispute: target.id, evidence_ref: ['u404'] })], 3, UTT_IDS)
  assert.equal(bogusRef.merged[0]!.status, 'open')
  assert.match(bogusRef.rejected[0] ?? '', /不存在的发言/)

  const noReason = applyDisputeUpdates([target], [update({ dispute: target.id, reason: '  ' })], 3, UTT_IDS)
  assert.equal(noReason.merged[0]!.status, 'open')
})

it('处置只改状态：没被点名的分歧一条不动', () => {
  const a = dispute('争议A')
  const b = dispute('争议B')
  const { merged } = applyDisputeUpdates([a, b], [update({ dispute: a.id })], 3, UTT_IDS)
  assert.equal(merged.length, 2)
  assert.equal(merged[1]!.status, 'open')
  assert.equal(merged[1]!.claim, '争议B')
})

console.log('\n=== 终局审校：决定必须落在真实结论与发言上 ===')

/** 主持看到的是带编号的清单，所以这里用两条已确认结论 + 两条真实发言搭台 */
const POINTS = [
  { id: 'p1', claim: '先把灰度比例压到 5%', support: ['a', 'b'], confidence: 0.9, evidenceRef: ['u1'], confirmedRound: 2, weight: 0.7 },
  { id: 'p2', claim: '回滚窗口定在 30 分钟', support: ['a'], confidence: 0.6, evidenceRef: ['u2'], confirmedRound: 3 },
]
const REVIEW_UTTS = new Set(['u1', 'u2'])

function decision(d: Record<string, unknown> = {}) {
  return {
    decision: '本季度只压灰度比例，不加人手',
    based_on: ['1'],
    premises: ['监控覆盖率达到 95%'],
    costs: ['发布节奏放慢一周'],
    actions: ['@sre 在本周五前改配置'],
    evidence_ref: ['u1'],
    ...d,
  }
}

it('编号能解析成真实条目，没被引用的结论进 uncovered', () => {
  const r = buildFinalReview([decision()], POINTS, REVIEW_UTTS)
  assert.equal(r.items.length, 1)
  assert.deepEqual(r.items[0]!.basedOn, ['p1'], 'based_on 要落成 ConsensusPoint.id，界面才点得回台账')
  assert.equal(r.rejected.length, 0)
  assert.deepEqual(r.uncovered, ['回滚窗口定在 30 分钟'])
})

it('id 与原文两种写法都认：主持换个说法不等于引用失效', () => {
  assert.deepEqual(buildFinalReview([decision({ based_on: ['p1'] })], POINTS, REVIEW_UTTS).items[0]!.basedOn, ['p1'])
  assert.deepEqual(
    buildFinalReview([decision({ based_on: ['先把灰度比例压到 5%'] })], POINTS, REVIEW_UTTS).items[0]!.basedOn,
    ['p1'],
  )
})

it('凭空编号的那一条忽略，其余保留；全部无效则整条丢弃', () => {
  const partial = buildFinalReview([decision({ based_on: ['1', '9'] })], POINTS, REVIEW_UTTS)
  assert.equal(partial.items.length, 1)
  assert.equal(partial.rejected.length, 1)
  assert.match(partial.rejected[0] ?? '', /不在本场结论清单里/)

  const allPhantom = buildFinalReview([decision({ based_on: ['9'] })], POINTS, REVIEW_UTTS)
  assert.equal(allPhantom.items.length, 0, '决定没有站在任何一条结论上，等于程序替模型编依据')
  assert.match(allPhantom.rejected.join('\n'), /凭空冒出的建议/)
})

it('依据发言为空或凭空：丢弃；缺前提缺代价：留下但不替它编', () => {
  assert.equal(buildFinalReview([decision({ evidence_ref: [] })], POINTS, REVIEW_UTTS).items.length, 0)
  assert.equal(buildFinalReview([decision({ evidence_ref: ['u404'] })], POINTS, REVIEW_UTTS).items.length, 0)
  const thin = buildFinalReview(
    [decision({ premises: [], costs: [], actions: undefined })],
    POINTS,
    REVIEW_UTTS,
  )
  assert.equal(thin.items.length, 1, '主持漏写代价是它的诚实度问题，不该让这条决定消失')
  assert.deepEqual(thin.items[0]!.costs, [])
})

it('没写出决定本身的条目丢弃；超出上限的部分留痕而不是静默截断', () => {
  const blank = buildFinalReview([decision({ decision: '  ' })], POINTS, REVIEW_UTTS)
  assert.equal(blank.items.length, 0)
  assert.match(blank.rejected[0] ?? '', /没写出决定本身/)

  const many = buildFinalReview(
    Array.from({ length: FINAL_REVIEW_CAP + 2 }, (_, i) => decision({ decision: `决定 ${i + 1}` })),
    POINTS,
    REVIEW_UTTS,
  )
  assert.equal(many.items.length, FINAL_REVIEW_CAP)
  assert.match(many.rejected.join('\n') ?? '', /超出 .* 条的部分未纳入/)
})

it('decisions 不是数组（主持整份跑偏）时不抛错，全部结论算未覆盖', () => {
  for (const bad of [undefined, null, {}, 'x']) {
    const r = buildFinalReview(bad, POINTS, REVIEW_UTTS)
    assert.equal(r.items.length, 0)
    assert.deepEqual(r.uncovered, POINTS.map((p) => p.claim))
  }
})

console.log('\n=== 上下文压缩保分歧（PRD 6.8）===')

it('压缩时 open 清单逐字保留，不经摘要器改写', () => {
  const full = {
    confirmed: [{ id: 'c1', claim: '共识1', support: ['m1'], confidence: 0.9, evidenceRef: ['u1'], confirmedRound: 1 }],
    open: [dispute('关键分歧：是否双写')],
    explored: ['方向A'],
    rounds: [],
  }
  let summarizerSawOpen = false
  const out = compressDigest(full, (input) => {
    // 摘要器根本拿不到 open，不存在改写机会
    if ('open' in (input as Record<string, unknown>)) summarizerSawOpen = true
    return { confirmed: [], explored: [] }
  })
  assert.equal(summarizerSawOpen, false, 'open 被暴露给了摘要器')
  assert.equal(out.open.length, 1)
  assert.equal(out.open[0]!.claim, '关键分歧：是否双写')
  assert.equal(out.confirmed.length, 0, 'confirmed 应被摘要')
  assert.equal(out.explored.length, 0, 'explored 应被摘要')
})

it('注入 prompt 时未决分歧显式呈现（防发言侧假收敛）', () => {
  const text = renderDigestForPrompt({
    confirmed: [],
    open: [dispute('是否双写')],
    explored: [],
    rounds: [],
  })
  assert.match(text, /当前仍存未决分歧/)
  assert.match(text, /是否双写/)
  assert.match(text, /m1：A/) // 双方论据都要给出
})

it('搁置的分歧离开未决清单，但换一节继续出现在 prompt 里', () => {
  const shelved = {
    ...dispute('需要线上错误率', 'shelved', ['u1']),
    shelve: { reason: '当场没有可核对的数据', missing: '近 30 天错误率', round: 3 },
  }
  const text = renderDigestForPrompt({
    confirmed: [],
    open: [dispute('还没谈完的'), shelved],
    explored: [],
    rounds: [],
  })
  assert.match(text, /【当前仍存未决分歧】[\s\S]*还没谈完的/)
  const unresolvedBlock = text.split('【当场判不了、已搁置')[0] ?? ''
  assert.ok(!unresolvedBlock.includes('需要线上错误率'), '搁置条目又被当成未决在催别人回应')
  assert.match(text, /当场判不了、已搁置/)
  assert.match(text, /缺：近 30 天错误率/)
})

it('已消解的分歧不进入 prompt 的未决清单', () => {
  const text = renderDigestForPrompt({
    confirmed: [],
    open: [dispute('已解决', 'resolved', ['u1'])],
    explored: [],
    rounds: [],
  })
  assert.match(text, /当前仍存未决分歧/)
  assert.ok(
    !text.includes('已解决'),
    '已消解的分歧不应出现在未决清单中',
  )
})

console.log('\n=== 人工介入是一等公民（PRD 5.5）===')

const statusMap = new Map<string, 'ready' | 'expired' | 'adapter-broken' | 'disabled'>([
  ['m1', 'ready'],
  ['m2', 'ready'],
  ['m3', 'adapter-broken'],
])

it('对全员的插话：标为已投递并记录生效轮次', () => {
  const it1 = createIntervention('interject', '请聚焦成本，别谈技术', 1)
  const out = deliverInterventions([it1], 2, statusMap)
  assert.equal(out.length, 1)
  assert.equal(it1.status, 'delivered')
  assert.equal(it1.deliveredRound, 2)
})

it('定向插话：缺席目标被剔除（规则 3）', () => {
  const it1 = createIntervention('interject', '只问你', 1, { targetAgentIds: ['m1', 'm3'] })
  deliverInterventions([it1], 2, statusMap)
  assert.deepEqual(it1.targetAgentIds, ['m1'])
  assert.equal(it1.status, 'delivered')
})

it('定向插话：目标全部缺席则作废，且不静默丢弃', () => {
  const it1 = createIntervention('interject', '只问失效模型', 1, { targetAgentIds: ['m3'] })
  const out = deliverInterventions([it1], 2, statusMap)
  assert.equal(out.length, 0)
  assert.equal(it1.status, 'cancelled')
  assert.match(it1.note ?? '', /全部缺席/)
})

it('定向追问：目标缺席则作废', () => {
  const it1 = createIntervention('followup', '解释一下', 1, {
    targetAgentId: 'm3',
    targetAgentIds: ['m3'],
  })
  const out = deliverInterventions([it1], 2, statusMap)
  assert.equal(out.length, 0)
  assert.equal(it1.status, 'cancelled')
})

it('定向追问：目标可用则投递', () => {
  const it1 = createIntervention('followup', '解释一下', 1, {
    targetAgentId: 'm1',
    targetAgentIds: ['m1'],
  })
  const out = deliverInterventions([it1], 2, statusMap)
  assert.equal(out.length, 1)
  assert.equal(it1.deliveredRound, 2)
})

it('已投递的介入不重复投递', () => {
  const it1 = createIntervention('interject', 'x', 1)
  deliverInterventions([it1], 2, statusMap)
  const second = deliverInterventions([it1], 3, statusMap)
  assert.equal(second.length, 0)
})

it('介入以独立区块渲染，不混入"已排除方向"', () => {
  const it1 = createIntervention('interject', '必须评估迁移成本', 1)
  const text = renderInterventions([it1])
  assert.match(text, /【人类参与者介入】/)
  assert.match(text, /必须评估迁移成本/)
  assert.ok(!text.includes('已充分讨论并排除'), '介入不得被渲染为已排除方向')
})

it('定向插话在 prompt 中标注仅给你', () => {
  const it1 = createIntervention('interject', '只回答我', 1, { targetAgentIds: ['m1'] })
  const text = renderInterventions([it1])
  assert.match(text, /仅给你的插话/)
})

it('对辩议题进入 prompt', () => {
  const it1 = createIntervention('duel', '缓存还是预计算', 1, {
    duelAgentIds: ['m1', 'm2'],
    topic: '缓存还是预计算',
  })
  const text = renderInterventions([it1])
  assert.match(text, /专项对辩/)
  assert.match(text, /缓存还是预计算/)
})

it('待生效的 set-stance / stop 不进入发言 prompt', () => {
  const a = createIntervention('set-stance', '风险审阅者', 1, { stanceAgentId: 'm1' })
  const b = createIntervention('stop', '停', 1)
  assert.equal(renderInterventions([a, b]), '')
})

console.log('\n=== 人类发言不计入共识度（PRD 5.5 / 6.7 规则 2）===')

it('人类发言被标记为 human', () => {
  const u = humanUtterance('我倾向方案 A', 1)
  assert.equal(u.human, true)
  assert.equal(u.agentId, HUMAN_AGENT_ID)
})

it('共识度核算只取模型发言，排除人类与缺席', () => {
  const list = [
    { ...utt('m1', 'support'), human: false },
    { ...utt('m2', 'support'), human: false },
    { ...utt('m3', 'oppose'), human: false },
    humanUtterance('我支持 A', 1), // 人类表态：支持
    { ...utt('m4'), absent: true }, // 缺席
  ] as Utterance[]
  const only = modelUtterancesOnly(list)
  assert.equal(only.length, 3)
  // 人类支持不影响模型间一致度：仍是 2:1，无论据时按 0.6 折 => 40
  assert.equal(computeAgreement(only).value, 40)
})

console.log('\n=== 介入在报告中的呈现（PRD 5.5 单列一章）===')

it('报告摘要逐条列出介入类型', () => {
  const list = [
    createIntervention('interject', '插话内容', 1),
    createIntervention('followup', '追问内容', 1, { targetAgentId: 'm1', targetAgentIds: ['m1'] }),
    createIntervention('duel', '对辩', 1, { duelAgentIds: ['m1', 'm2'], topic: '议题X' }),
    createIntervention('set-stance', 'risk', 1, {
      stanceAgentId: 'm2',
      stanceBefore: '默认',
      stanceAfter: 'risk',
    }),
  ]
  for (const x of list) x.status = 'delivered'
  const lines = summarizeInterventions(list)
  assert.equal(lines.length, 4)
  assert.ok(lines.some((l) => l.includes('插话内容')))
  assert.ok(lines.some((l) => l.includes('定向追问')))
  assert.ok(lines.some((l) => l.includes('专项对辩')))
  assert.ok(lines.some((l) => l.includes('调整')))
})

it('无介入时报告不产出该章节', () => {
  assert.deepEqual(summarizeInterventions([]), [])
})

console.log('\n=== 重试语义（PRD 7.2 / F6）===')

function src(over: Partial<RetrySource> = {}): RetrySource {
  return {
    sessionId: 's_prev',
    topic: {
      id: 't1',
      title: '议题',
      background: '',
      strategy: 'roundtable',
      attachments: [],
      createdAt: 0,
    },
    config: { maxRounds: 3, consensusThreshold: 85, participantIds: ['m1', 'm2'], moderatorId: 'mod', budgetLimitUsd: 2 },
    confirmed: [{ claim: '共识A', support: ['m1', 'm2'], confirmedRound: 1 }],
    open: [
      { id: 'od1', claim: '分歧B', sides: [{ agentId: 'm1', argument: 'x' }, { agentId: 'm2', argument: 'y' }], openedRound: 1 },
    ],
    absentAgentIds: ['m3'],
    spokenAgentIds: ['m1', 'm2'],
    finishedReason: 'max-rounds',
    reportSummary: '摘要',
    ...over,
  }
}

it('rerun 始终可用', () => {
  const v = validateRetryPlan({ mode: 'rerun' }, src())
  assert.equal(v.ok, true)
  assert.match(v.notices.join(), /不保留/)
})

it('fill-missing：无缺席模型时拒绝并给出替代方案', () => {
  const v = validateRetryPlan({ mode: 'fill-missing' }, src({ absentAgentIds: [] }))
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /整场重跑/)
})

it('fill-missing：有缺席模型时列出补跑对象', () => {
  const v = validateRetryPlan({ mode: 'fill-missing' }, src())
  assert.equal(v.ok, true)
  assert.match(v.notices.join(), /m3/)
})

it('dispute：未选分歧时拒绝', () => {
  const v = validateRetryPlan({ mode: 'dispute' }, src())
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /请选择要再辩的保留分歧/)
})

it('dispute：只选一个模型时拒绝', () => {
  const v = validateRetryPlan({ mode: 'dispute', disputeId: 'od1', duelAgentIds: ['m1'] }, src())
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /两个参与对辩的模型/)
})

it('dispute：分歧不存在时拒绝', () => {
  const v = validateRetryPlan({ mode: 'dispute', disputeId: 'nope', duelAgentIds: ['m1', 'm2'] }, src())
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /不存在/)
})

it('dispute：正常路径通过且提示不计入收敛度', () => {
  const v = validateRetryPlan({ mode: 'dispute', disputeId: 'od1', duelAgentIds: ['m1', 'm2'] }, src())
  assert.equal(v.ok, true)
  assert.match(v.notices.join(), /不计入收敛度判定/)
})

it('dispute：非原参与方对辩时给出提示', () => {
  const s = src({ open: [{ id: 'od1', claim: 'D', sides: [{ agentId: 'm1', argument: 'a' }], openedRound: 1 }] })
  const v = validateRetryPlan({ mode: 'dispute', disputeId: 'od1', duelAgentIds: ['m2', 'm3'] }, s)
  assert.equal(v.ok, true)
  assert.match(v.notices.join(), /不是该分歧的原参与方/)
})

it('continue：上一场无结论时退化为整场重跑并提示', () => {
  const v = validateRetryPlan({ mode: 'continue' }, src({ confirmed: [], open: [] }))
  assert.equal(v.ok, true)
  assert.match(v.notices.join(), /退化为整场重跑/)
})

console.log('\n=== 重试不得制造假共识（核心约束）===')

it('「已知前提」显式声明不可默认认同', () => {
  const text = renderPriorConclusion(src())
  assert.match(text, /参考前提而非本轮结论/)
  assert.match(text, /不要因为它们被列出就默认认同/)
  assert.match(text, /共识A/)
  assert.match(text, /分歧B/)
})

it('「已知前提」不混入讨论记录区块', () => {
  const text = renderPriorConclusion(src())
  assert.ok(!text.includes('已确认共识'), '前提不得伪装成本轮已确认共识')
  assert.ok(!text.includes('已充分讨论并排除'), '前提不得伪装成已排除方向')
})

it('无结论时不产生前提文本', () => {
  assert.equal(renderPriorConclusion(src({ confirmed: [], open: [] })), '')
})

it('已消解分歧不进入前提文本', () => {
  const s = src({ open: [{ id: 'od2', claim: '已解决', sides: [{ agentId: 'm1', argument: 'a' }, { agentId: 'm2', argument: 'b' }], openedRound: 1, status: 'resolved' }] })
  const text = renderPriorConclusion(s)
  assert.ok(!text.includes('已解决'))
})

it('可用重试模式随来源状态动态禁用', () => {
  const none = availableRetryModes(src({ absentAgentIds: [], open: [] }))
  assert.equal(none.find((m) => m.mode === 'fill-missing')?.enabled, false)
  assert.equal(none.find((m) => m.mode === 'dispute')?.enabled, false)
  assert.equal(none.find((m) => m.mode === 'rerun')?.enabled, true)

  const full = availableRetryModes(src())
  assert.equal(full.find((m) => m.mode === 'fill-missing')?.enabled, true)
  assert.equal(full.find((m) => m.mode === 'dispute')?.enabled, true)
})

// ---------------------------------------------------------------------------
// 注入脚本可执行性守卫
// ---------------------------------------------------------------------------

it('INJECT_SCRIPT 语法合法（模板字面量转义陷阱回归）', () => {
  // 背景：INJECT_SCRIPT 是 TS 模板字面量，其中的正则转义（如 /^\/auth\//）
  // 会被模板字面量折叠成 /，产出非法正则字面量，导致整个注入脚本抛
  // SyntaxError 而静默失效 —— 表现为「选择器丢失」，实为脚本从未注入成功。
  // 该类错误不会影响 tsc 类型检查，只能在运行时暴露，故在此设守卫。
  const js = INJECT_SCRIPT
  assert.ok(js.length > 0, 'INJECT_SCRIPT 不应为空')
  // 用 Function 构造做语法解析：构造成功即语法合法
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(`return (${js.trim().replace(/;$/, '')})`)
  }, 'INJECT_SCRIPT 存在语法错误（常见原因：模板字面量中的正则转义）')
})

it('登录墙判定早于选择器判定（避免未登录被误报为适配器失效）', () => {
  const js = INJECT_SCRIPT
  const loginIdx = js.indexOf('isLoginWall()')
  const inputIdx = js.indexOf('spec.selectors.input')
  assert.ok(loginIdx > 0, '应存在登录墙判定')
  assert.ok(inputIdx > 0, '应存在选择器查询')
  assert.ok(
    loginIdx < inputIdx,
    '登录墙判定必须早于选择器查询，否则未登录会被误判为适配器失效',
  )
})

// ---------------------------------------------------------------------------
// 侧栏拖动排序
// ---------------------------------------------------------------------------

console.log('\n=== 拖动排序：落盘的必须是刚排好的这一份 ===')

const M = (id: string) => ({ id })
const LIST = ['a', 'b', 'c', 'd'].map(M)

it('拖动后重新拉列表应得到新顺序（原 bug 的回归）', () => {
  const state = { order: ['a', 'b', 'c', 'd'], hidden: [] }
  const r = applyReorder(LIST, state, ['b', 'a', 'c', 'd'])
  if (!r.ok) throw new Error(r.reason)
  // 曾经写成 visibleInOrder(next, 旧 state)：order 里存的还是拖动前的 a,b,c,d，
  // 渲染层随后 listModels() 一拉就把卡片弹回原位 —— 这里钉住「拉回来 = 新顺序」。
  assert.deepEqual(r.order, ['b', 'a', 'c', 'd'])
  assert.deepEqual(visibleInOrder(r.models, { order: r.order, hidden: state.hidden }).map((m) => m.id), [
    'b',
    'a',
    'c',
    'd',
  ])
})

it('隐藏项不进 order，但也不能被排掉', () => {
  const state = { order: ['a', 'b', 'c', 'd'], hidden: ['b'] }
  // 渲染层只看得见未隐藏的模型，拖过来的是可见序列
  const r = applyReorder(LIST, state, ['d', 'c', 'a'])
  if (!r.ok) throw new Error(r.reason)
  assert.deepEqual(r.order, ['d', 'c', 'a'])
  assert.deepEqual(r.models.map((m) => m.id), ['d', 'c', 'a', 'b'])
  assert.deepEqual(visibleInOrder(r.models, { order: r.order, hidden: state.hidden }).map((m) => m.id), [
    'd',
    'c',
    'a',
  ])
})

it('未被这次排序点名的模型补到末尾，不丢失', () => {
  const r = applyReorder(LIST, { order: [], hidden: [] }, ['d', 'c'])
  if (!r.ok) throw new Error(r.reason)
  assert.deepEqual(r.models.map((m) => m.id), ['d', 'c', 'a', 'b'])
})

it('排序里出现不存在的 id 时忽略它，不塞进 order', () => {
  const r = applyReorder(LIST, { order: [], hidden: [] }, ['ghost', 'b', 'a'])
  if (!r.ok) throw new Error(r.reason)
  assert.deepEqual(r.models.map((m) => m.id), ['b', 'a', 'c', 'd'])
  assert.deepEqual(r.order, ['b', 'a', 'c', 'd'])
})

it('非法输入一律拒绝：非数组 / 非字符串 / 重复 id', () => {
  const state = { order: [], hidden: [] }
  assert.equal(applyReorder(LIST, state, 'a,b').ok, false)
  assert.equal(applyReorder(LIST, state, ['a', 3]).ok, false)
  assert.equal(applyReorder(LIST, state, ['a', 'a']).ok, false)
})

// ---------- 暂停 / 继续：顶栏那条「用户手动暂停」必须随点击消失 ----------

const PAUSE_TOPIC: Topic = {
  id: 't_pause',
  title: '暂停态该由谁来撤销',
  background: '',
  strategy: 'roundtable',
  attachments: [],
  createdAt: 1,
}

const PAUSE_CONFIG: SessionConfig = {
  maxRounds: 1,
  consensusThreshold: 99,
  participantIds: ['m_a'],
  moderatorId: null,
  budgetLimitUsd: 1,
}

function pauseHarness(): { o: Orchestrator; events: OrchestratorEvent[] } {
  const o = new Orchestrator(PAUSE_TOPIC, PAUSE_CONFIG, {
    getAgent: () => undefined,
    getModerator: () => null,
  })
  const events: OrchestratorEvent[] = []
  o.on('event', (e) => events.push(e))
  return { o, events }
}

/** 复现渲染层的推导口径：state 事件与 paused/resumed 任一都能翻动暂停态 */
function stillShowsPause(events: OrchestratorEvent[]): boolean {
  let paused = false
  for (const e of events) {
    if (e.type === 'state') paused = e.state === 'PAUSE_FOR_USER'
    else if (e.type === 'paused') paused = true
    else if (e.type === 'resumed') paused = false
  }
  return paused
}

it('暂停：状态机进 PAUSE_FOR_USER，并把原因带出来', () => {
  const { o, events } = pauseHarness()
  o.requestPause('用户手动暂停')
  const last = [...events].reverse().find((e) => e.type === 'state')
  assert(last?.type === 'state' && last.state === 'PAUSE_FOR_USER', '暂停没落到 PAUSE_FOR_USER')
  assert.equal(stillShowsPause(events), true)
})

it('继续：resume 必须自己发事件，不能等下一个 state 事件碰运气', () => {
  const { o, events } = pauseHarness()
  o.requestPause('用户手动暂停')
  o.resume()
  assert(events.some((e) => e.type === 'resumed'), 'resume 没发 resumed')
  const last = [...events].reverse().find((e) => e.type === 'state')
  assert(last?.type === 'state' && last.state !== 'PAUSE_FOR_USER', '最后一条 state 仍停在 PAUSE_FOR_USER')
  assert.equal(stillShowsPause(events), false)
})

it('暂停→继续→再暂停→再继续：不残留上一轮的暂停态', () => {
  const { o, events } = pauseHarness()
  o.requestPause('用户手动暂停')
  o.resume()
  o.requestPause('用户手动暂停')
  o.resume()
  assert.equal(stillShowsPause(events), false)
})

it('渲染层处理 resumed，且 done 会清掉 paused', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/store.ts'), 'utf8')
  assert.match(src, /case 'resumed':[\s\S]{0,240}?paused: false/, 'store 没处理 resumed 事件')
  assert.match(src, /case 'done':[\s\S]{0,900}?paused: false/, 'done 后仍带 paused：收尾的场次会永远挂着暂停提示')
})

it('放原生下拉的容器不得带 backdrop-filter：Chromium 弹层会渲染成纯黑', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // 注释里提一句 backdrop-filter 不该把守卫带跑
  // .interject-bar = 干预条的「选择模型 / 对辩方」，.modal-mask = 模型弹窗里每个 select
  for (const sel of ['.interject-bar', '.modal-mask']) {
    const blocks = [...css.matchAll(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`, 'g'))]
    assert.ok(blocks.length > 0, `${sel} 规则不见了：改名或删掉了，这条守卫要一起收拾`)
    for (const b of blocks) {
      assert.equal(
        /backdrop-filter/.test(b[1] ?? ''),
        false,
        `${sel} 里有原生 <select>，祖先一带 backdrop-filter，下拉弹层就是一块什么都没有的黑底`,
      )
    }
  }
})

console.log(`\n${'='.repeat(46)}`)
console.log(`  通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(46) + '\n')

process.exit(fail > 0 ? 1 : 0)
