/**
 * 匿名互评 / 认同溯源 / 互评名次自测
 *
 * 覆盖从 llm-council 移植过来的五点里的三条机械部分：
 * - 别名映射的正反双向：匿名轨里主持看到的是「参会者A」，程序必须能还原成真实 id，
 *   还原不了的别名要留给既有校验拒绝（凭空归因不能悄悄放过）；
 * - 论点证据硬度与名次这类附加信号：格式错误只警示，不能否掉一次合法小结；
 * - 认同溯源：主持声称的「支持」有没有本人发言可核对。
 *
 * 运行：npm run test:anonymity
 */

import assert from 'node:assert/strict'
import {
  aliasLabel,
  anonymizeDigest,
  buildAliasMap,
  deanonymizeModeratorDigest,
  endorsementProvenance,
  provenanceSummary,
} from '../src/shared/anonymity'
import {
  aggregateLeaderboard,
  makeId,
  renderDigestForPrompt,
  validateModeratorDigest,
} from '../src/shared/invariants'
import type {
  ConsensusPoint,
  Digest,
  ModeratorAuditEntry,
  ModeratorDigest,
  OpenDispute,
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

const AGENTS = ['gpt-x', 'claude-y', 'qwen-z']

/** 模型名称表：署名轨的提示词标签由它给出（内部 id 对模型没有语义） */
const NAMES = new Map<string, string>([
  ['gpt-x', 'GPT X'],
  ['claude-y', 'Claude Y'],
  ['qwen-z', 'Qwen Z'],
])
const nameOf = (id: string): string | undefined => NAMES.get(id)

function utt(agentId: string, overrides: Partial<Utterance> = {}): Utterance {
  return {
    id: overrides.id ?? makeId('u'),
    round: 1,
    agentId,
    content: '论据',
    targets: [],
    startedAt: 0,
    endedAt: 0,
    ...overrides,
  }
}

function moderatorDigest(overrides: Partial<ModeratorDigest> = {}): ModeratorDigest {
  return {
    consensus_points: [
      { claim: '应当引入实时层', support: [AGENTS[0]!], confidence: 0.8, evidence_ref: [] },
    ],
    open_disputes: [],
    score_dimensions: { agreement: 70, overlap: 60, trend: 50 },
    score: 66,
    // 默认名单留空：需要点名时才显式给出，否则「下一个该谁说」也会算成一次身份泄漏
    next_round_order: [],
    callout: null,
    ...overrides,
  }
}

function digestFixture(): Digest {
  const confirmed: ConsensusPoint[] = [
    {
      id: 'cp1',
      claim: '应当引入实时层',
      support: [AGENTS[0]!, AGENTS[1]!],
      confidence: 0.8,
      evidenceRef: ['u1', 'u2'],
      confirmedRound: 1,
    },
  ]
  const open: OpenDispute[] = [
    {
      id: 'od1',
      claim: '成本是否可控',
      sides: [
        { agentId: AGENTS[1]!, argument: '可控', utteranceIds: ['u2'] },
        { agentId: AGENTS[2]!, argument: '不可控', utteranceIds: ['u3'] },
      ],
      openedRound: 1,
      lastProgress: null,
      status: 'open',
    },
  ]
  return { confirmed, open, explored: [], rounds: [] }
}

console.log('\n匿名互评 / 认同溯源 / 互评名次\n')

// ---------------------------------------------------------------------------
// 别名映射
// ---------------------------------------------------------------------------

it('别名按参会顺序稳定生成，超过 26 个退化为序号', () => {
  const map = buildAliasMap(AGENTS, true)
  assert.equal(map.aliasToAgent['参会者A'], AGENTS[0])
  assert.equal(map.agentToAlias[AGENTS[2]!], '参会者C')
  assert.equal(aliasLabel(0), '参会者A')
  assert.equal(aliasLabel(25), '参会者Z')
  assert.equal(aliasLabel(26), '参会者27')
})

it('署名轨不产生别名，labelFor 给模型名称且名称可反查回真实 id', () => {
  const map = buildAliasMap(AGENTS, false, nameOf)
  assert.equal(map.anonymous, false)
  assert.equal(map.resolve('gpt-x'), 'gpt-x')
  assert.equal(map.isAlias('参会者A'), false)
  assert.equal(map.labelFor('gpt-x'), 'GPT X')
  assert.equal(map.resolveByName('GPT X'), 'gpt-x')
  assert.equal(map.resolveByName('  gpt-x  '), null)
  // 没给名称表时退回 id —— 等于改动前的行为，不会凭空造出称呼
  assert.equal(buildAliasMap(AGENTS, false).labelFor('gpt-x'), 'gpt-x')
})

it('重名时标签退化：带 id 后缀供人辨认，反查表不收这个名字', () => {
  const map = buildAliasMap(['a1', 'a2'], false, (id) => (id === 'a1' ? 'GLM' : 'glm'))
  assert.equal(map.labelFor('a1'), 'GLM（a1）')
  assert.equal(map.labelFor('a2'), 'glm（a2）')
  // 反查会撞车，宁缺毋滥：认不出就交给校验驳回，不能把两份支持记到一个人头上
  assert.equal(map.resolveByName('GLM'), null)
})

it('匿名轨的 labelFor 只给别名，连模型 id 都不外泄', () => {
  const map = buildAliasMap(AGENTS, true, nameOf)
  assert.equal(map.labelFor('gpt-x'), '参会者A')
  // 不在本场名单里的 id 不能被编造成某个别名
  assert.equal(map.labelFor('unknown-model'), '参会者?')
})

// ---------------------------------------------------------------------------
// 纪要脱敏
// ---------------------------------------------------------------------------

it('纪要改写只换「谁说的」，不换「说了什么」，也不碰原始纪要', () => {
  const map = buildAliasMap(AGENTS, true)
  const anon = anonymizeDigest(digestFixture(), map)
  assert.deepEqual(anon.confirmed[0]!.support, ['参会者A', '参会者B'])
  assert.deepEqual(
    anon.open[0]!.sides.map((s) => s.agentId),
    ['参会者B', '参会者C'],
  )
  assert.equal(anon.confirmed[0]!.claim, '应当引入实时层')
  assert.equal(anon.open[0]!.sides[0]!.argument, '可控')
  // 署名轨换成模型名称；原始纪要仍存真实 id，报告与血缘不受影响
  const signed = anonymizeDigest(digestFixture(), buildAliasMap(AGENTS, false, nameOf))
  assert.deepEqual(signed.confirmed[0]!.support, ['GPT X', 'Claude Y'])
  assert.deepEqual(signed.open[0]!.sides.map((s) => s.agentId), ['Claude Y', 'Qwen Z'])
  assert.deepEqual(digestFixture().confirmed[0]!.support, [AGENTS[0]!, AGENTS[1]!])
})

it('渲染给模型的纪要不再出现 api-user- 前缀的内部 id', () => {
  const ids = ['api-user-minimax', 'api-user-intern-ai']
  const map = buildAliasMap(ids, false, (id) => id.replace(/^api-user-/, ''))
  const digest: Digest = {
    confirmed: [
      {
        id: 'cp1',
        claim: '阶段性恋爱是奖励',
        support: [...ids],
        confidence: 0.8,
        evidenceRef: ['u1'],
        confirmedRound: 2,
      },
    ],
    open: [
      {
        id: 'od1',
        claim: '是否导致防御性疏离',
        sides: [{ agentId: ids[0]!, argument: '会', utteranceIds: ['u1'] }],
        openedRound: 1,
        lastProgress: null,
        status: 'open',
      },
    ],
    explored: [],
    rounds: [],
  }
  const text = renderDigestForPrompt(anonymizeDigest(digest, map))
  assert.equal(text.includes('api-user-'), false, text)
  assert.ok(text.includes('minimax'), text)
})

it('脱敏后的纪要渲染给模型时不再出现任何真实 id', () => {
  const map = buildAliasMap(AGENTS, true)
  const anon = anonymizeDigest(digestFixture(), map)
  const json = JSON.stringify(anon)
  for (const id of AGENTS) assert.equal(json.includes(id), false, `泄漏 ${id}`)
})

// ---------------------------------------------------------------------------
// 反匿名化 + 与既有校验的衔接
// ---------------------------------------------------------------------------

it('反匿名化把主持输出的别名还原为真实 id，并通过既有校验', () => {
  const map = buildAliasMap(AGENTS, true)
  const utterances = [utt(AGENTS[0]!, { id: 'u1' }), utt(AGENTS[1]!, { id: 'u2' })]
  const raw = moderatorDigest({
    consensus_points: [
      {
        claim: '应当引入实时层',
        support: ['参会者A', '参会者B'],
        confidence: 0.8,
        evidence_ref: ['u1', 'u2'],
        weight: 0.6,
      },
    ],
    open_disputes: [
      { claim: '成本', sides: [{ agent_id: '参会者B', argument: '可控' }, { agent_id: '参会者C', argument: '不可控' }] },
    ],
    next_round_order: ['参会者C'],
    agent_quality: [{ agent_id: '参会者A', rank: 1, rationale: '论据最完整' }],
    callout: { target_agent: '参会者C', quote_from_agent: '参会者A', instruction: '回应成本质疑' },
  })
  const out = deanonymizeModeratorDigest(raw, map)
  assert.deepEqual(out.digest.consensus_points[0]!.support, [AGENTS[0], AGENTS[1]])
  assert.deepEqual(out.digest.open_disputes[0]!.sides.map((s) => s.agent_id), [AGENTS[1], AGENTS[2]])
  assert.deepEqual(out.digest.next_round_order, [AGENTS[2]])
  assert.equal(out.digest.agent_quality?.[0]?.agent_id, AGENTS[0])
  assert.equal(out.digest.callout?.target_agent, AGENTS[2])
  assert.equal(out.digest.callout?.quote_from_agent, AGENTS[0])
  assert.deepEqual(out.unknownAliases, [])
  assert.deepEqual(out.leakedRealIds, [])

  const v = validateModeratorDigest(
    out.digest,
    new Set(utterances.map((u) => u.id)),
    new Set(AGENTS),
  )
  assert.equal(v.ok, true, v.errors.join('；'))
})

it('未登记的别名原样透传，由既有校验按凭空归因拒绝', () => {
  const map = buildAliasMap(AGENTS, true)
  const raw = moderatorDigest({
    consensus_points: [
      { claim: '假共识', support: ['参会者Z'], confidence: 0.9, evidence_ref: ['u1'] },
    ],
  })
  const out = deanonymizeModeratorDigest(raw, map)
  assert.deepEqual(out.unknownAliases, ['参会者Z'])
  assert.deepEqual(out.digest.consensus_points[0]!.support, ['参会者Z'])

  const v = validateModeratorDigest(out.digest, new Set(['u1']), new Set(AGENTS))
  assert.equal(v.ok, false)
  assert.match(v.errors.join(), /support 含不存在的模型/)
})

it('匿名轨里写出真实 id：结论可用，但要留下身份泄漏痕迹', () => {
  const map = buildAliasMap(AGENTS, true)
  const raw = moderatorDigest({
    consensus_points: [
      { claim: '真共识', support: ['gpt-x'], confidence: 0.7, evidence_ref: ['u1'] },
    ],
  })
  const out = deanonymizeModeratorDigest(raw, map)
  assert.deepEqual(out.digest.consensus_points[0]!.support, ['gpt-x'])
  assert.deepEqual(out.leakedRealIds, ['gpt-x'])
  assert.deepEqual(out.unknownAliases, [])
})

it('callout 为 null 时反匿名化不报错', () => {
  const out = deanonymizeModeratorDigest(moderatorDigest(), buildAliasMap(AGENTS, true))
  assert.equal(out.digest.callout, null)
})

it('署名轨：主持照抄模型名称要还原成真实 id，照抄 id 也照样可用', () => {
  const map = buildAliasMap(AGENTS, false, nameOf)
  const raw = moderatorDigest({
    consensus_points: [
      {
        claim: '应当引入实时层',
        support: ['GPT X', 'claude-y', 'QWEN-Z'.toLowerCase()],
        confidence: 0.8,
        evidence_ref: ['u1'],
      },
    ],
  })
  const out = deanonymizeModeratorDigest(raw, map)
  assert.deepEqual(out.digest.consensus_points[0]!.support, ['gpt-x', 'claude-y', 'qwen-z'])
  assert.deepEqual(out.unknownAliases, [])
  assert.deepEqual(out.leakedRealIds, [])
  // 名单外的引用（兼岗主持自己）原样透传，交给 validateModeratorDigest 判合法与否
  const selfRef = deanonymizeModeratorDigest(
    moderatorDigest({
      consensus_points: [{ claim: '主持自评', support: ['mod-m'], confidence: 0.5, evidence_ref: ['u1'] }],
    }),
    map,
  )
  assert.deepEqual(selfRef.digest.consensus_points[0]!.support, ['mod-m'])
  assert.deepEqual(selfRef.unknownAliases, [])
})

// ---------------------------------------------------------------------------
// 附加信号：能观测，但不否决
// ---------------------------------------------------------------------------

it('weight / agent_quality 格式非法只产生警告，不驳回小结', () => {
  const digest = moderatorDigest({
    consensus_points: [
      { claim: '共识', support: [AGENTS[0]!], confidence: 0.5, evidence_ref: ['u1'], weight: 7 },
    ],
    agent_quality: [
      { agent_id: 'ghost', rank: 0, rationale: 'x' },
      { agent_id: AGENTS[1]!, rank: 1.5, rationale: 'y' },
    ],
  })
  const v = validateModeratorDigest(digest, new Set(['u1']), new Set(AGENTS))
  assert.equal(v.ok, true, v.errors.join('；'))
  assert.ok(v.warnings.some((w) => w.includes('weight')))
  assert.ok(v.warnings.some((w) => w.includes('不存在的模型')))
  assert.ok(v.warnings.some((w) => w.includes('rank')))
})

it('重复名次给出警告，提示平均名次会偏', () => {
  const digest = moderatorDigest({
    consensus_points: [
      { claim: '共识', support: [AGENTS[0]!], confidence: 0.5, evidence_ref: ['u1'] },
    ],
    agent_quality: [
      { agent_id: AGENTS[0]!, rank: 1, rationale: 'a' },
      { agent_id: AGENTS[1]!, rank: 1, rationale: 'b' },
    ],
  })
  const v = validateModeratorDigest(digest, new Set(['u1']), new Set(AGENTS))
  assert.equal(v.ok, true, v.errors.join('；'))
  assert.ok(v.warnings.some((w) => w.includes('重复名次')))
})

// ---------------------------------------------------------------------------
// 名次聚合
// ---------------------------------------------------------------------------

function audit(round: number, accepted: ModeratorDigest | null): ModeratorAuditEntry {
  return {
    round,
    anonymous: true,
    aliases: { 参会者A: AGENTS[0]! },
    attempts: [],
    unknownAliases: [],
    leakedRealIds: [],
    accepted,
    startedAt: round * 1000,
  }
}

it('平均名次只取通过校验的小结，按名次升序排列', () => {
  const withQuality = (rows: ModeratorDigest['agent_quality']): ModeratorDigest =>
    moderatorDigest({ agent_quality: rows })

  const rows = aggregateLeaderboard([
    audit(1, withQuality([{ agent_id: AGENTS[0]!, rank: 2, rationale: '首轮一般' }, { agent_id: AGENTS[1]!, rank: 1, rationale: '首轮最硬' }])),
    // 被驳回的一轮：模型可能正乱序，不能进平均
    audit(2, null),
    audit(3, withQuality([{ agent_id: AGENTS[0]!, rank: 1, rationale: '论据最完整' }, { agent_id: AGENTS[2]!, rank: 2, rationale: '有重复' }])),
  ])

  assert.deepEqual(
    rows.map((r) => [r.agentId, r.averageRank, r.rounds]),
    [
      [AGENTS[1], 1, 1],
      [AGENTS[0], 1.5, 2],
      [AGENTS[2], 2, 1],
    ],
  )
  assert.equal(rows[0]!.agentId, AGENTS[1])
  // rationale 取最后一次非空说明
  assert.equal(rows.find((r) => r.agentId === AGENTS[0])!.rationale, '论据最完整')
})

it('非法名次条目被丢弃，不影响其余模型聚合', () => {
  const rows = aggregateLeaderboard([
    audit(1, moderatorDigest({
      agent_quality: [
        { agent_id: AGENTS[0]!, rank: 1, rationale: 'ok' },
        { agent_id: AGENTS[1]!, rank: 0, rationale: '坏' },
        { agent_id: AGENTS[2]!, rank: 2.5, rationale: '坏' },
      ],
    })),
  ])
  assert.deepEqual(rows.map((r) => r.agentId), [AGENTS[0]])
})

it('主持未输出名次时聚合为空数组（报告不编造名次）', () => {
  assert.deepEqual(aggregateLeaderboard([audit(1, moderatorDigest())]), [])
  assert.deepEqual(aggregateLeaderboard([]), [])
})

// ---------------------------------------------------------------------------
// 认同溯源
// ---------------------------------------------------------------------------

it('支持者有无本人原文可核对，分别计入 covered 与 attributed', () => {
  const utterances = [
    utt(AGENTS[0]!, { id: 'u1' }),
    utt(AGENTS[1]!, { id: 'u2' }),
    utt(AGENTS[2]!, { id: 'u3' }),
  ]
  const points: ConsensusPoint[] = [
    {
      id: 'cp1',
      claim: '有两人原文',
      support: [AGENTS[0]!, AGENTS[1]!, AGENTS[2]!],
      confidence: 0.9,
      evidenceRef: ['u1', 'u2'],
      confirmedRound: 1,
    },
  ]
  const [p] = endorsementProvenance(points, utterances)!
  assert.deepEqual(p!.covered, [AGENTS[0], AGENTS[1]])
  // 第三位被主持声称支持，但证据里没有他的发言 —— 这就是主持代答
  assert.deepEqual(p!.attributed, [AGENTS[2]])
  assert.equal(p!.crossExamined, false)

  const sum = provenanceSummary(points, utterances)
  assert.equal(sum.coverageRate, 67)
  assert.equal(sum.crossExaminedRate, 0)
})

it('证据发言被他人点名回应，才算「挨过质询」', () => {
  const utterances = [
    utt(AGENTS[0]!, { id: 'u1' }),
    utt(AGENTS[1]!, { id: 'u2', targets: ['u1'] }),
    // 自己的发言被自己回应不算
    utt(AGENTS[2]!, { id: 'u3', targets: ['u3'] }),
    utt(AGENTS[2]!, { id: 'u4', absent: true, targets: ['u1'] }),
  ]
  const points: ConsensusPoint[] = [
    {
      id: 'cp1',
      claim: '被反驳过的共识',
      support: [AGENTS[0]!],
      confidence: 0.7,
      evidenceRef: ['u1'],
      confirmedRound: 1,
    },
  ]
  const [p] = endorsementProvenance(points, utterances)!
  assert.equal(p!.crossExamined, true)
  assert.equal(provenanceSummary(points, utterances).crossExaminedRate, 100)
})

it('没有共识点时溯源为 0，不出现除零', () => {
  const sum = provenanceSummary([], [])
  assert.equal(sum.coverageRate, 0)
  assert.equal(sum.crossExaminedRate, 0)
  assert.deepEqual(sum.points, [])
})

it('共识点没有任何支持方时不计入覆盖率分母', () => {
  const points: ConsensusPoint[] = [
    { id: 'cp1', claim: '空支持', support: [], confidence: 0.5, evidenceRef: ['u1'], confirmedRound: 1 },
  ]
  const sum = provenanceSummary(points, [utt(AGENTS[0]!, { id: 'u1' })])
  assert.equal(sum.coverageRate, 0)
  assert.equal(sum.crossExaminedRate, 0)
})

// ---------------------------------------------------------------------------
// 匿名前提下的溯源仍然成立（别名只存在于提示词，落库必须是真实 id）
// ---------------------------------------------------------------------------

it('反匿名化后的 support 能对上真实发言，溯源不会因别名失效', () => {
  const map = buildAliasMap(AGENTS, true)
  const u1 = utt(AGENTS[0]!, { id: 'u1' })
  const out = deanonymizeModeratorDigest(
    moderatorDigest({
      consensus_points: [
        { claim: '共识', support: ['参会者A'], confidence: 0.8, evidence_ref: ['u1'] },
      ],
    }),
    map,
  )
  const point: ConsensusPoint = {
    id: 'cp1',
    claim: '共识',
    support: out.digest.consensus_points[0]!.support,
    confidence: 0.8,
    evidenceRef: ['u1'],
    confirmedRound: 1,
  }
  const [p] = endorsementProvenance([point], [u1])!
  assert.deepEqual(p!.covered, [AGENTS[0]])
  assert.deepEqual(p!.attributed, [])
})

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
