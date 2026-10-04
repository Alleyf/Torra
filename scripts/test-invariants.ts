/**
 * 核心不变量自测（M1 出口标准的可自动化部分）
 *
 * 覆盖 PRD 6.7 / 6.8 的硬约束：
 * - 机械校验能否拦住「凭空生成的共识」
 * - 立场一致度 / 论点重合度 / 收敛趋势的核算是否正确
 * - 未决分歧是否真的只增不减
 * - 压缩时 open 是否逐字保留
 *
 * 运行：npm run test:invariants
 */

import assert from 'node:assert/strict'
import {
  computeAgreement,
  computeOverlap,
  computeTrend,
  compressDigest,
  makeId,
  mergeOpenDisputes,
  openOnly,
  renderDigestForPrompt,
  validateModeratorDigest,
  weightedScore,
} from '../src/shared/invariants'
import type { ModeratorDigest, OpenDispute, Utterance } from '../src/shared/types'
import { INJECT_SCRIPT } from '../src/main/webview/inject'

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

function utt(agentId: string, stance?: Utterance['stance']): Utterance {
  return {
    id: makeId('u'),
    round: 1,
    agentId,
    content: 'x',
    targets: [],
    ...(stance ? { stance } : {}),
    startedAt: 0,
    endedAt: 0,
  }
}

console.log('\n=== 共识度核算（PRD 6.7）===')

it('立场一致度：三方同立场 = 100', () => {
  const us = [utt('a', 'support'), utt('b', 'support'), utt('c', 'support')]
  assert.equal(computeAgreement(us), 100)
})

it('立场一致度：二对一 = 66.7（不是 50）', () => {
  const us = [utt('a', 'support'), utt('b', 'support'), utt('c', 'oppose')]
  assert.equal(computeAgreement(us), 66.7)
})

it('立场一致度：无立场标记 = 0（不计入分母）', () => {
  assert.equal(computeAgreement([utt('a'), utt('b')]), 0)
})

it('论点重合度：被 >=2 模型共同提及才计入', () => {
  const points = [
    { id: '1', claim: 'A', support: ['m1', 'm2'], confidence: 0.9, evidenceRef: ['u1'], confirmedRound: 1 },
    { id: '2', claim: 'B', support: ['m1'], confidence: 0.8, evidenceRef: ['u2'], confirmedRound: 1 },
  ]
  assert.equal(computeOverlap(points), 50)
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

it('拦截单方分歧（至少需两方论据）', () => {
  const d = baseDigest()
  d.open_disputes = [{ claim: 'X', sides: [{ agent_id: 'm1', argument: 'only one' }] }]
  const v = validateModeratorDigest(d, REAL_UTT, REAL_AGENT)
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /至少需要两方论据/)
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
  // 人类支持不影响模型间一致度：仍是 2:1 = 66.7
  assert.equal(computeAgreement(only), 66.7)
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

console.log(`\n${'='.repeat(46)}`)
console.log(`  通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(46) + '\n')

process.exit(fail > 0 ? 1 : 0)
