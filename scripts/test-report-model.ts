/**
 * 报告视图模型（src/shared/report-model.ts）自测。
 *
 * 覆盖三件屏幕与导出都依赖的事：
 * - 旧报告的纯文本 actions 能否兜底拆成结构化行动卡（负责人/时间/完成标准）；
 * - 版本快照与差异是否包含全部决策和字段级改写，而不是只比第一条；
 * - normalizeReport 对缺字段的旧存档是否会补出可渲染的空态而不是崩溃。
 *
 * 运行：npm run test:report-model
 */

import assert from 'node:assert/strict'
import {
  actionItemsFor,
  buildClaims,
  buildDecisions,
  diffReportRevision,
  normalizeReport,
  reportRevisionSnapshot,
} from '../src/shared/report-model'
import type { FinalReview, Report } from '../src/shared/types'

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

/** 只填视图模型会用到的字段，其余交给 normalizeReport 兜底 */
function report(over: Partial<Report> = {}): Report {
  return normalizeReport({
    sessionId: 's1',
    executiveSummary: '先用灰度，再谈全量。',
    verdict: { level: 'qualified', headline: '有条件成立', reasons: [], coverage: 80 },
    consensus: [],
    disputes: [],
    timeline: [],
    participation: [],
    blindSpots: [],
    nextActions: [],
    interventions: [],
    duels: [],
    baseline: null,
    baselineCompare: null,
    generatedAt: 1_000,
    ...over,
  } as Report)
}

function review(decisions: FinalReview['decisions']): FinalReview {
  return { decisions, rejected: [], uncovered: [], raw: '' }
}

console.log('\n=== 行动卡：结构化与旧文本兜底 ===')

it('结构化 actionItems 原样带出，不重复', () => {
  const r = report({
    finalReview: review([
      {
        id: 'd1',
        decision: '先做灰度',
        basedOn: [],
        premises: [],
        costs: [],
        actions: [],
        evidenceRef: [],
        actionItems: [
          { id: 'a1', action: '开灰度开关', owner: '平台组', due: '本周', decisionId: 'd1' },
        ],
      },
    ]),
  })
  const items = actionItemsFor(r)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.owner, '平台组')
  assert.equal(items[0]!.due, '本周')
})

it('旧纯文本 actions 拆出负责人/时间/完成标准，且不编造缺失字段', () => {
  const r = report({
    finalReview: review([
      {
        id: 'd1',
        decision: '先做灰度',
        basedOn: [],
        premises: [],
        costs: [],
        evidenceRef: [],
        actions: ['负责人：平台组；时间：本周内；完成标准：错误率低于基线'],
      },
    ]),
  })
  const items = actionItemsFor(r)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.owner, '平台组')
  assert.equal(items[0]!.due, '本周内')
  assert.equal(items[0]!.doneWhen, '错误率低于基线')
  assert.equal(items[0]!.depends, undefined)
})

it('没有终局审校时退回顶层 nextActions，字段空缺不编造', () => {
  const r = report({ nextActions: ['负责人：主持；时间：下次会前；补一轮专项对辩'] })
  const items = actionItemsFor(r)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.owner, '主持')
  assert.equal(items[0]!.due, '下次会前')
  assert.equal(items[0]!.depends, undefined)
})

console.log('\n=== 决策台账 ===')

it('buildDecisions 为每条决策兜底生成 actionItems', () => {
  const r = report({
    finalReview: review([
      {
        id: 'd1',
        decision: 'A',
        basedOn: [],
        premises: [],
        costs: [],
        evidenceRef: [],
        actions: ['负责人：甲；时间：Q3'],
      },
      { id: 'd2', decision: 'B', basedOn: [], premises: [], costs: [], actions: [], evidenceRef: [] },
    ]),
  })
  const views = buildDecisions(r)
  assert.equal(views.length, 2)
  assert.equal(views[0]!.actionItems.length, 1)
  assert.equal(views[0]!.actionItems[0]!.owner, '甲')
  assert.equal(views[1]!.actionItems.length, 0)
})

it('结论状态：被撤回=contested，多来源=confirmed，无证据=unsupported', () => {
  const r = report({
    consensus: [
      {
        claim: '被撤回',
        supporterCount: 0,
        supporters: [],
        argument: '',
        sourceRounds: [2],
        sourceUtteranceIds: ['u1'],
        supportRatio: 0,
        confidence: 0,
        confirmedRound: 2,
        evidence: [],
        weight: 0,
        verifiedSupportRate: 0,
        attributedSupport: [],
        crossExamined: false,
        verification: { status: 'vacated', checkedRound: 2, confirmedBy: [], removed: ['m2'] },
      },
      {
        claim: '双来源',
        supporterCount: 2,
        supporters: ['m1', 'm2'],
        argument: '',
        sourceRounds: [1, 2],
        sourceUtteranceIds: ['u2'],
        supportRatio: 100,
        confidence: 0.9,
        confirmedRound: 2,
        evidence: [{ utteranceId: 'u2', agentId: 'm1', displayName: 'm1', round: 2, quote: 'q' }],
        weight: 0.8,
        verifiedSupportRate: 100,
        attributedSupport: [],
        crossExamined: true,
      },
      {
        claim: '无证据',
        supporterCount: 1,
        supporters: ['m1'],
        argument: '',
        sourceRounds: [1],
        sourceUtteranceIds: [],
        supportRatio: 50,
        confidence: 0.4,
        confirmedRound: 1,
        evidence: [],
        weight: null,
        verifiedSupportRate: 0,
        attributedSupport: [],
        crossExamined: false,
      },
    ] as Report['consensus'],
  })
  const claims = buildClaims(r)
  assert.equal(claims[0]!.status, 'contested')
  assert.equal(claims[1]!.status, 'confirmed')
  assert.equal(claims[2]!.status, 'unsupported')
})

console.log('\n=== 版本快照与差异 ===')

it('快照保存全部决策文本和结构化行动字段', () => {
  const r = report({
    finalReview: review([
      {
        id: 'd1',
        decision: 'A',
        basedOn: [],
        premises: [],
        costs: [],
        evidenceRef: [],
        actions: ['负责人：甲；时间：Q3'],
      },
      {
        id: 'd2',
        decision: 'B',
        basedOn: [],
        premises: [],
        costs: [],
        evidenceRef: [],
        actionItems: [{ id: 'a2', action: '做 B', owner: '乙', due: '下周' }],
      },
    ]),
  })
  const snap = reportRevisionSnapshot(r)
  assert.deepEqual(snap.decisions, ['A', 'B'])
  assert.equal(snap.actionItems?.length, 2)
  assert.equal(snap.actionItems?.[1]?.owner, '乙')
})

it('同名行动只改负责人也会被 diff 抓到', () => {
  const before = report({
    finalReview: review([
      {
        id: 'd1',
        decision: 'A',
        basedOn: [],
        premises: [],
        costs: [],
        evidenceRef: [],
        actionItems: [{ id: 'a1', action: '开灰度', owner: '甲', due: 'Q3' }],
      },
    ]),
  })
  const snapshot = reportRevisionSnapshot(before)
  const after = report({
    meta: { ...before.meta, previousRevision: snapshot },
    finalReview: review([
      {
        id: 'd1',
        decision: 'A',
        basedOn: [],
        premises: [],
        costs: [],
        evidenceRef: [],
        actionItems: [{ id: 'a1', action: '开灰度', owner: '乙', due: 'Q4' }],
      },
    ]),
  })
  const diff = diffReportRevision(after)
  assert.ok(diff)
  assert.equal(diff!.actionFieldsChanged, true)
  assert.equal(diff!.addedActions.length, 0)
  assert.ok(diff!.actionChanges.length > 0, '应给出字段级改写说明')
  assert.match(diff!.actionChanges[0]!, /负责人/)
})

it('新增第二条决策会被算作决策数量变化', () => {
  const one = report({
    finalReview: review([
      { id: 'd1', decision: 'A', basedOn: [], premises: [], costs: [], actions: [], evidenceRef: [] },
    ]),
  })
  const snapshot = reportRevisionSnapshot(one)
  const two = report({
    meta: { ...one.meta, previousRevision: snapshot },
    finalReview: review([
      { id: 'd1', decision: 'A', basedOn: [], premises: [], costs: [], actions: [], evidenceRef: [] },
      { id: 'd2', decision: 'B', basedOn: [], premises: [], costs: [], actions: [], evidenceRef: [] },
    ]),
  })
  const diff = diffReportRevision(two)
  assert.equal(diff!.decisionChanged, true)
  assert.deepEqual(diff!.addedDecisions, ['B'])
  assert.equal(diff!.removedDecisions.length, 0)
})

it('没有 previousRevision 时返回 null，而不是伪造差异', () => {
  assert.equal(diffReportRevision(report()), null)
})

it('旧快照缺 decisions/actionItems 字段时仍按单条兼容', () => {
  const legacy = report({
    meta: {
      ...report().meta,
      previousRevision: {
        generatedAt: 1,
        verdictLevel: 'weak',
        headline: '旧结论',
        decision: '旧决策',
        claims: [],
        disputes: [],
        actions: [],
      },
    },
    finalReview: review([
      { id: 'd1', decision: '新决策', basedOn: [], premises: [], costs: [], actions: [], evidenceRef: [] },
    ]),
  })
  const diff = diffReportRevision(legacy)
  assert.equal(diff!.previousDecisions.length, 1)
  assert.equal(diff!.previousDecisions[0], '旧决策')
  assert.deepEqual(diff!.addedDecisions, ['新决策'])
})

console.log('\n=== normalizeReport 对旧存档补空态 ===')

it('完全缺字段的旧存档补出 verdict/consensus/disputes，页面可渲染', () => {
  const r = normalizeReport({} as Report)
  assert.ok(r.verdict)
  assert.equal(r.verdict.level, 'weak')
  assert.deepEqual(r.consensus, [])
  assert.deepEqual(r.disputes, [])
  assert.deepEqual(r.timeline, [])
  assert.equal(actionItemsFor(r).length, 0)
  assert.equal(buildDecisions(r).length, 0)
  assert.equal(buildClaims(r).length, 0)
})

console.log('\n' + '='.repeat(46))
console.log(`  通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(46))
process.exitCode = fail > 0 ? 1 : 0
