/**
 * 编排器离线端到端回归：用注入的假通道跑满一场真讨论
 *
 * 为什么需要这一层：幻觉治理、基线对照、核验轮的每一段计算都有单元测试，
 * 但「串起来之后还能不能用」从没验证过 —— 事件是否真发出来、质询是否真回灌到
 * 下一轮、否认是否真的改掉了共识点的 support，这些都只在编排器的装配处成立。
 * 真实模型跑一场要花钱、要联网、不可复现，所以这里用假通道把整条链走通。
 *
 * 运行：npm run test:orchestrator-e2e
 */

import assert from 'node:assert/strict'
import { Orchestrator, type OrchestratorEvent } from '../src/main/orchestrator/orchestrator'
import type { Agent, SendResult } from '../src/main/agents/agent'
import type { HallucinationReport, SessionConfig, Topic, TurnContext, Utterance } from '../src/shared/types'

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void>): Promise<void> {
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

const usage = { promptTokens: 20, completionTokens: 30, costUsd: 0.002 }

const A_TEXT = {
  1: '第1轮甲：应当采用方案X，理由是落地成本更低，迁移只需两周，回滚路径也清楚。这条判断我在 utt_ghost001 里论证过，第 9 轮已经复算。',
  2: '第2轮甲：坚持方案X，成本差在迁移周期上；监控分级可以作为并行项，但不该挡在上线前面。',
}
const B_TEXT = {
  1: '第1轮乙：先补齐监控与回滚预案，否则任何方案上线都是风险；建议按服务分级设置告警阈值。',
  2: '第2轮乙：仍然主张先做监控分级，方案X 的成本优势要能核对才成立。',
}

const BASELINE_TEXT = '基线：直接选方案X，落地成本低、迁移两周、回滚可控。供应商合同期限按年评审。'

/**
 * 假主持：按系统提示词分辨自己被叫去做什么。
 * 小结必须引用真实发言 id，所以从用户提示词里把本轮发言的 id 抄出来 ——
 * 真模型看到的也正是这一份清单。
 */
function makeModerator(digestRound: (ids: string[], round: number) => string) {
  let round = 0
  return {
    id: 'm_m',
    send: async (raw: { system: string; user: string }) => {
      if (raw.system.includes('对照审校')) {
        return {
          content: JSON.stringify({
            verdict: 'mixed',
            council_adds: ['把监控分级列为并行项'],
            council_drops: ['供应商合同期限'],
            regressions: [],
            note: '研讨补上了执行顺序，基线的合同期限没人接',
          }),
          usage,
        }
      }
      const ids = [...raw.user.matchAll(/^-\s+\[([^\]]+)\]/gm)].map((m) => m[1] as string)
      round += 1
      return { content: digestRound(ids, round), usage }
    },
  }
}

function digestJson(ids: string[], round: number): string {
  const idA = ids[0] ?? ''
  const idB = ids[1] ?? idA
  const points =
    round === 1
      ? [
          // 只拿甲的发言当证据却把乙列为支持方 → 程序应判为「代答」
          { claim: '采用方案X', support: ['m_a', 'm_b'], confidence: 0.8, weight: 0.7, evidence_ref: [idA] },
          // 反向再来一次：这条只有乙说过，甲也被列进 support
          { claim: '上线前冻结数据库变更', support: ['m_a', 'm_b'], confidence: 0.6, weight: 0.4, evidence_ref: [idB] },
        ]
      : [
          { claim: '采用方案X', support: ['m_a', 'm_b'], confidence: 0.8, weight: 0.7, evidence_ref: [idA] },
          { claim: '按服务分级设置告警阈值', support: ['m_b'], confidence: 0.7, weight: 0.6, evidence_ref: [idB] },
        ]
  return JSON.stringify({
    consensus_points: points,
    open_disputes: [
      {
        claim: '上线节奏',
        sides: [
          { agent_id: 'm_a', argument: '先方案X，监控并行' },
          { agent_id: 'm_b', argument: '先监控分级，再上线' },
        ],
      },
    ],
    score_dimensions: { agreement: 55, overlap: 40, trend: 50 },
    score: 50,
    next_round_order: ['m_a', 'm_b'],
    agent_quality: [
      { agent_id: 'm_a', rank: 1, rationale: '给出了可核对的成本依据' },
      { agent_id: 'm_b', rank: 2, rationale: '论点成立但未回应成本' },
    ],
    explored_directions: ['按季度评审供应商'],
    callout: null,
  })
}

function makeAgent(id: string, name: string, text: Record<number, string>, seen: Array<{ id: string; ctx: TurnContext }>): Agent {
  return {
    id,
    displayName: name,
    transport: 'api',
    color: '#888888',
    status: 'ready',
    send: async (ctx: TurnContext, onDelta): Promise<SendResult> => {
      seen.push({ id, ctx })
      // 真通道一条发言动辄几秒，这里睡几毫秒让「墙钟预算」这类判据有可能被触发
      await new Promise((r) => setTimeout(r, 3))
      let content: string
      if (ctx.systemChallenge?.includes('【共识核验】')) {
        // 两位被质询的模型都否认：这正是核验轮要抓的「主持替模型点头」
        content = '这不是我的立场，我没有说过这句话；我的实际主张见本轮发言原文。'
      } else if (ctx.round === 0) {
        content = BASELINE_TEXT
      } else {
        content = text[ctx.round] ?? `第${ctx.round}轮${name}：维持此前判断。`
      }
      onDelta(content.slice(0, 8))
      return { content, usage, targets: [] }
    },
    healthCheck: async () => true,
    dispose: () => undefined,
  }
}

const topic: Topic = {
  id: 'topic_e2e',
  title: '上线该选方案X还是先补监控',
  background: '现网只有一次发布窗口。',
  strategy: 'roundtable',
  attachments: [],
  createdAt: 1,
}

const baseConfig: SessionConfig = {
  maxRounds: 2,
  consensusThreshold: 99,
  participantIds: ['m_a', 'm_b'],
  moderatorId: 'm_m',
  budgetLimitUsd: 5,
  baseline: true,
  baselineCompare: true,
  verifyPass: 'always',
  timeBudgetMs: 120_000,
}

async function runSession(config: SessionConfig) {
  const seen: Array<{ id: string; ctx: TurnContext }> = []
  const agents = new Map<string, Agent>([
    ['m_a', makeAgent('m_a', '甲模型', A_TEXT, seen)],
    ['m_b', makeAgent('m_b', '乙模型', B_TEXT, seen)],
  ])
  // 主持只建一次：它自己记着「第几次小结 = 第几轮」，每次 getModerator 新建会把轮次重置
  const moderator = makeModerator((ids, round) => digestJson(ids, round))
  const orch = new Orchestrator(topic, config, {
    getAgent: (id) => agents.get(id),
    getModerator: () => moderator,
  })
  const events: OrchestratorEvent[] = []
  orch.on('event', (e: OrchestratorEvent) => events.push(e))
  await orch.run()
  return { orch, events, seen }
}

const typeOf = (e: OrchestratorEvent) => e.type
const byId = (list: Utterance[], claim: (u: Utterance) => boolean) => list.find(claim)

async function main() {
  console.log('\n编排器离线端到端回归（假通道跑满一场）')
  console.log('='.repeat(46))

  const { orch, events, seen } = await runSession(baseConfig)

  await it('整场链路的事件都真发出来了：基线 / 逐轮账本 / 核验质询 / 治理汇总 / 对照 / 收尾', async () => {
    const types = events.map(typeOf)
    for (const t of ['baseline', 'hallucination-round', 'verification', 'hallucination', 'baseline-compare', 'done']) {
      assert.ok(types.includes(t), `事件流里缺少 ${t}：${[...new Set(types)].join(',')}`)
    }
    const done = events.find((e) => e.type === 'done')
    assert.equal(done && done.type === 'done' ? done.reason : null, 'max-rounds')
    assert.equal(events.filter((e) => e.type === 'hallucination-round').length, 2, '每轮都该有一笔幻觉账本')
    assert.equal(events.filter((e) => e.type === 'verification').length, 2, '两位被代答的模型各该被质询一次')
  })

  await it('基线只作对照，绝不进讨论上下文', async () => {
    const baseline = orch.getBaseline()
    assert.ok(baseline && baseline.content.includes('方案X'), '基线没产出')
    assert.equal(orch.getUtterances().some((u) => u.round === 0), false, '基线混进了发言流')
    assert.ok(orch.getUtterances().every((u) => !u.content.includes('供应商合同期限')), '基线内容漏进了参会者上下文')
  })

  await it('凭空引用当场被机械核验，并回灌到下一轮质询', async () => {
    const first = byId(orch.getUtterances(), (u) => u.round === 1 && u.agentId === 'm_a')
    assert.ok(first?.citations, '第一条发言没带引用审计结果')
    assert.deepEqual(first!.citations!.bogusUtteranceIds, ['utt_ghost001'])
    assert.deepEqual(first!.citations!.outOfRangeRounds, [9])
    const second = seen.find((x) => x.id === 'm_a' && x.ctx.round === 2)
    assert.ok(second?.ctx.systemChallenge, '第二轮没收到上一轮的引用质询')
    assert.ok(second!.ctx.systemChallenge!.includes('utt_ghost001'), `质询里没点出被编造的 id：${second!.ctx.systemChallenge}`)
  })

  await it('代答归因被质询、本人否认后只降级不删除', async () => {
    const report = events.find((e) => e.type === 'hallucination') as { report: HallucinationReport } | undefined
    assert.ok(report, '没有幻觉治理汇总')
    assert.equal(report!.report.verification.asked, 2)
    assert.equal(report!.report.verification.denied, 2)
    assert.ok(report!.report.verification.triggeredBy.includes('always'), `触发口径没如实记录：${report!.report.verification.triggeredBy}`)
    const points = orch.getConsensusPoints()
    const p1 = points.find((p) => p.claim === '采用方案X')
    assert.ok(p1, '被否认的共识点不该从报告里消失')
    assert.ok(!p1!.support.includes('m_b'), '否认后乙不该还挂在这个点上')
    assert.ok(p1!.support.includes('m_a'), '本人说过的支持不该被一起抹掉')
    assert.equal(p1!.verification?.status, 'disputed')
    assert.equal(report!.report.verification.vacatedPoints, 0, '还剩一个支持者，不该标成 vacated')
  })

  await it('逐轮账本只记本轮新增的误差：跨轮沿用的代答不重复计入', async () => {
    const report = orch.getHallucinationReport()
    assert.ok(report, '没有幻觉治理汇总')
    assert.equal(report!.rounds.length, 2)
    assert.ok(report!.rounds[0]!.errorCount > 0, '首轮有凭空引用与代答，不该是零错误')
    assert.equal(
      report!.rounds[1]!.errorCount,
      0,
      `第二轮既没凭空引用、代答也是上一轮就暴露的，误差应归零，实际 ${report!.rounds[1]!.errorCount}`,
    )
    assert.ok(report!.riskScore > 0, '有凭空引用又有代答，风险分不该是 0')
    assert.equal(report!.trajectory, 'self_correcting', '误差从首轮到次轮归零 = 自我矫正轨迹')
    assert.ok(report!.trajectoryNote.length > 0 && /\d/.test(report!.trajectoryNote), '轨迹说明必须带具体数字')
    assert.ok(report!.flags.length > 0, '风险点要逐条摊给用户看')
  })

  await it('主持登记的「已排除方向」真被落进台账并会注入后续轮', async () => {
    assert.ok(orch.getExplored().includes('按季度评审供应商'), `explored 没接上：${orch.getExplored().join('|')}`)
    const isVerify = (x: { ctx: TurnContext }) => x.ctx.systemChallenge?.includes('【共识核验】') === true
    const round2 = seen.filter((x) => x.ctx.round === 2 && !isVerify(x))
    assert.equal(round2.length, 2, '第二轮两位都该被正常调用')
    assert.ok(
      round2.every((x) => JSON.stringify(x.ctx.digest).includes('按季度评审供应商')),
      '排除方向没随纪要注入下一轮，模型会重新论证已经聊透的东西',
    )
  })

  await it('分通道台账与基线对照如实结算', async () => {
    const ledger = orch.getLedger()
    assert.equal(ledger.moderatorCalls, 3, '两轮小结 + 一次对照')
    assert.ok(ledger.apiCalls >= 6, `发言/基线/核验调用都该记账，实际 ${ledger.apiCalls}`)
    assert.ok(ledger.totalMs >= 0)
    const compare = orch.getBaselineCompare()
    assert.equal(compare?.verdict, 'mixed')
    assert.deepEqual(compare?.councilAdds, ['把监控分级列为并行项'])
    assert.ok(orch.getStageTimings().some((t) => t.stage === 'verification'), '核验轮要进阶段耗时')
  })

  await it('阈值没达到就不谎称收敛，且理由说得出走了哪条路', async () => {
    const conv = events.filter((e) => e.type === 'convergence') as Array<{ converged: boolean; path: string; round: number; reason: string }>
    assert.equal(conv.length, 2)
    assert.ok(conv.every((c) => !c.converged), '共识阈值 99 且分歧未消解，不该收敛')
    assert.ok(conv.every((c) => c.path === 'none'))
    assert.ok(conv.every((c) => c.reason.length > 0))
    assert.equal(events.some((e) => e.type === 'converged'), false)
  })

  await it('verifyPass=off 时只测量不矫正，报告要写明没核对', async () => {
    const off = await runSession({ ...baseConfig, verifyPass: 'off' })
    assert.equal(off.events.some((e) => e.type === 'verification'), false, '关掉核验轮就不该发出质询')
    const rep = off.orch.getHallucinationReport()
    assert.ok(rep, '测量本身不能跟着关掉')
    assert.ok(rep!.attributedRate > 0, '代答率仍要算出来')
    assert.equal(rep!.verification.asked, 0)
    assert.ok(rep!.verification.triggeredBy.toLowerCase().includes('off') || rep!.verification.triggeredBy.includes('关'), `触发口径没记录：${rep!.verification.triggeredBy}`)
  })

  await it('时长预算触顶：立刻收束并标注，不等金额熔断', async () => {
    const tight = await runSession({ ...baseConfig, timeBudgetMs: 1 })
    assert.ok(tight.orch.isTimeLimited(), '墙钟闸门没生效')
    assert.ok(tight.events.some((e) => e.type === 'time-limited'), '触顶必须发事件')
    assert.equal(tight.orch.getRound(), 0, '预算已经用完，一轮都不该再开')
    assert.equal(tight.events.filter((e) => e.type === 'utterance-done').length, 0)
  })

  console.log('-'.repeat(46))
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46))
  if (fail > 0) process.exit(1)
}

main()
