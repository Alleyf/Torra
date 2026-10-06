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

/** 一次假通道调用：带时间区间，用来证伪「基线到底有没有和第一轮并行」 */
interface AgentCall {
  id: string
  ctx: TurnContext
  startedAt: number
  endedAt?: number
}

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
 * 真模型看到的也正是这一份清单。提示词里同样列了「此前已确认的共识」，
 * 那些 cp_ 开头的 id 一并交出去，用例才能模拟「主持点名延续某条已有结论」。
 */
function makeModerator(
  digestRound: (ids: string[], round: number, pointIds: string[]) => string,
  onPrompt?: (user: string, system: string) => void,
) {
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
      const bracketed = [...raw.user.matchAll(/^-\s+\[([^\]]+)\]/gm)].map((m) => m[1] as string)
      onPrompt?.(raw.user, raw.system)
      round += 1
      return {
        content: digestRound(
          bracketed.filter((x) => !x.startsWith('cp_')),
          round,
          bracketed.filter((x) => x.startsWith('cp_')),
        ),
        usage,
      }
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

/**
 * 第二轮把同一个判断换个说法重列 —— 主持看不到已登记条目原文时必然发生的事。
 * 归并链路要验的就是这一份：程序要把它并回第一轮那条，并把旧措辞留在 variants 上。
 */
function rewordDigestJson(ids: string[], round: number, pointIds: string[]): string {
  const idA = ids[0] ?? ''
  const idB = ids[1] ?? idA
  const points =
    round === 1
      ? [
          { claim: '采用方案X以降低落地成本', support: ['m_a'], confidence: 0.7, weight: 0.6, evidence_ref: [idA] },
          { claim: '按服务分级设置告警阈值', support: ['m_b'], confidence: 0.7, weight: 0.6, evidence_ref: [idB] },
        ]
      : [
          {
            claim: '采用方案X，落地成本更低',
            support: ['m_a', 'm_b'],
            confidence: 0.85,
            weight: 0.7,
            evidence_ref: [idA],
            continues: pointIds[0] ?? null,
          },
          // 逐字重列：该并，但不算「换说法」
          { claim: '按服务分级设置告警阈值', support: ['m_b'], confidence: 0.7, weight: 0.6, evidence_ref: [idB] },
        ]
  return JSON.stringify({
    consensus_points: points,
    open_disputes: [],
    score_dimensions: { agreement: 60, overlap: 55, trend: 50 },
    score: 55,
    next_round_order: ['m_a', 'm_b'],
    agent_quality: [],
    explored_directions: [],
    callout: null,
  })
}

function makeAgent(id: string, name: string, text: Record<number, string>, seen: AgentCall[]): Agent {
  return {
    id,
    displayName: name,
    transport: 'api',
    color: '#888888',
    status: 'ready',
    send: async (ctx: TurnContext, onDelta): Promise<SendResult> => {
      const entry: AgentCall = { id, ctx, startedAt: Date.now() }
      seen.push(entry)
      // 真通道一条发言动辄几秒，这里睡几毫秒让「墙钟预算」这类判据有可能被触发；
      // 基线睡得久一些，好让「它有没有跟第一轮并行」这件事能被时间区间证伪。
      await new Promise((r) => setTimeout(r, ctx.round === 0 ? 60 : 3))
      entry.endedAt = Date.now()
      let content: string
      if (ctx.systemChallenge?.includes('【共识核验】')) {
        // 两位被质询的模型都否认：这正是核验轮要抓的「主持替模型点头」
        content = '这不是我的立场，我没有说过这句话；我的实际主张见本轮发言原文。'
      } else if (ctx.round === 0) {
        content = BASELINE_TEXT
      } else {
        content = text[ctx.round] ?? `第${ctx.round}轮${name}：维持此前判断。`
      }
      /*
       * 拿到「他人论点原话」就按编号点名回应 —— 合规参会者在真实提示词下的行为，
       * 也是交锋能不能落成 targets 血缘的唯一判据。
       */
      const peer = ctx.peers?.[0]
      if (peer && ctx.round > 0 && !ctx.systemChallenge && !content.includes(peer.utteranceId)) {
        content += `（回应 [${peer.utteranceId}]）`
      }
      onDelta(content.slice(0, 8))
      return {
        content,
        usage,
        targets: ctx.callout?.quoteFromUtterance ? [ctx.callout.quoteFromUtterance] : [],
      }
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

async function runSession(
  config: SessionConfig,
  digest: (ids: string[], round: number, pointIds: string[]) => string = digestJson,
) {
  const seen: AgentCall[] = []
  const prompts: string[] = []
  const systems: string[] = []
  const agents = new Map<string, Agent>([
    ['m_a', makeAgent('m_a', '甲模型', A_TEXT, seen)],
    ['m_b', makeAgent('m_b', '乙模型', B_TEXT, seen)],
  ])
  // 主持只建一次：它自己记着「第几次小结 = 第几轮」，每次 getModerator 新建会把轮次重置
  const moderator = makeModerator(digest, (user, system) => {
    prompts.push(user)
    systems.push(system)
  })
  const orch = new Orchestrator(topic, config, {
    getAgent: (id) => agents.get(id),
    getModerator: () => moderator,
  })
  const events: OrchestratorEvent[] = []
  orch.on('event', (e: OrchestratorEvent) => events.push(e))
  await orch.run()
  return { orch, events, seen, prompts, systems }
}

const typeOf = (e: OrchestratorEvent) => e.type
const byId = (list: Utterance[], claim: (u: Utterance) => boolean) => list.find(claim)

async function main() {
  console.log('\n编排器离线端到端回归（假通道跑满一场）')
  console.log('='.repeat(46))

  const { orch, events, seen, systems } = await runSession(baseConfig)

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

  await it('API 基线与第一轮发言并行跑，不再串在开场前面', async () => {
    const base = seen.find((x) => x.ctx.round === 0)
    const r1 = seen.filter((x) => x.ctx.round === 1)
    assert.ok(base?.endedAt, '基线没记账时间区间')
    assert.ok(r1.length >= 1, '第一轮没有调用记录')
    const overlapped = r1.some((x) => x.startedAt < base!.endedAt! && base!.startedAt < (x.endedAt ?? Date.now()))
    assert.ok(overlapped, '基线仍在串行占位：开场要先等它答完')
    assert.ok(orch.getBaseline(), '并行之后基线仍要落到台账里')
  })

  await it('主持兼参会：基线交给名单里的另一位，提示词带上自审护栏', async () => {
    /*
     * 校验层放开硬禁之后，兼岗是否真走得通、以及「不选主持答基线」这条纪律
     * 有没有被静默绕过，只有把一场真讨论跑完才算得数 ——
     * 名单第一位恰好是主持，正是最容易漏的那一种。
     */
    const dual = await runSession({ ...baseConfig, moderatorId: 'm_a' })
    assert.equal(dual.orch.getBaseline()?.agentId, 'm_b', '兼岗时基线仍落在主持身上：它会先入为主')
    assert.ok(
      dual.orch.getUtterances().some((u) => u.agentId === 'm_a' && u.round >= 1),
      '主持作为参会者的发言没进讨论流',
    )
    assert.ok(dual.systems.length > 0, '主持一次小结都没被叫到')
    assert.match(dual.systems[0]!, /本场你同时是参会者/)
    assert.match(dual.prompts[0]!, /^- m_a（甲模型）（主持兼任参会，本场也在发言）/m)
    // 不兼岗的场次不该凭空多出一条无关约束（就是本文件开头那一场）
    assert.ok(!systems[0]!.includes('本场你同时是参会者'), '普通场次也被注入了兼岗护栏')
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

  await it('交锋落地：第二轮能看到他人论点原话，点名回应落成发言 id 血缘', async () => {
    const all = orch.getUtterances()
    const r2 = seen.filter((x) => x.ctx.round === 2 && !x.ctx.systemChallenge)
    assert.ok(r2.length > 0, '第二轮没有正常发言可比')
    for (const call of r2) {
      const peers = call.ctx.peers ?? []
      assert.ok(peers.length > 0, `${call.id} 的第二轮没拿到「他人论点原话」：digest 只有转述，模型无从反驳`)
      // 只能看到别人的、批次开始前就存在的发言
      for (const p of peers) {
        const src = all.find((u) => u.id === p.utteranceId)
        assert.ok(src, `peers 给出了本场不存在的编号：${p.utteranceId}`)
        assert.notEqual(src!.agentId, call.id, `${call.id} 拿到了自己的发言当「他人论点」`)
        assert.ok(src!.round < call.ctx.round, '本轮同批次刚生成的发言不该互为可反驳对象')
      }
    }

    const utteranceIds = new Set(all.map((u) => u.id))
    const replies = all.filter((u) => u.targets.length > 0)
    assert.ok(replies.length > 0, '整场没有任何点名回应 —— targets 又空了')
    for (const u of replies) {
      for (const t of u.targets) {
        assert.ok(utteranceIds.has(t), `targets 里出现非发言 id（模型 id 会被四个读取方全部查丢）：${t}`)
        const src = all.find((x) => x.id === t)!
        assert.notEqual(src.agentId, u.agentId, `${u.id} 的 targets 里混进了自己写的发言`)
      }
    }
    // 提示词侧：编号必须真印出来了，否则「复制编号反驳」无从做起
    const promptWithIds = r2.find((x) => (x.ctx.peers ?? []).length > 0)
    assert.ok(
      promptWithIds && (promptWithIds.ctx.peers ?? []).every((p) => p.text.length > 0 && p.label.length > 0),
      '他人论点原话缺署名或正文',
    )
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

  await it('跨轮近义重列并成一条：原措辞留在 variants，报告说得出并掉了几条', async () => {
    const run = await runSession(
      { ...baseConfig, baseline: false, baselineCompare: false, verifyPass: 'off' },
      rewordDigestJson,
    )
    assert.equal(run.prompts.length, 2, '两轮小结各发一次')
    assert.ok(
      run.prompts[1]!.includes('此前已确认的共识'),
      '主持提示词里没有已确认清单，它只能凭记忆重新措辞 —— 这正是重复结论的来源',
    )
    assert.match(run.prompts[1]!, /\[cp_[a-z0-9_]+] 采用方案X以降低落地成本/, '清单要带上 id，主持才可能点名延续')

    const points = run.orch.getConsensusPoints()
    assert.equal(points.length, 2, `同一个判断不该占两个条目：${points.map((p) => p.claim).join(' | ')}`)
    const folded = points.find((p) => p.claim === '采用方案X以降低落地成本')!
    assert.ok(folded, '应保留首轮那条的措辞')
    assert.deepEqual([...folded.support].sort(), ['m_a', 'm_b'], '第二轮新加入的支持方要并进来')
    assert.deepEqual(folded.variants, ['采用方案X，落地成本更低'], '被并掉的措辞不能丢')
    assert.equal(folded.confidence, 0.85, '置信取各轮最高')
    assert.equal(folded.confirmedRound, 1, '首次确认轮次不被第二轮改写')
    const dedup = run.orch.getDedup()
    assert.equal(dedup.merged, 2, '换说法的一条和逐字重列的一条都算并入')
    assert.equal(dedup.notes.length, 0, 'continues 指的是真实存在的条目，不该被拒')
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
    // 闸门查在轮与轮之间（轮内由 roundWallClockMs 兜底）。基线并行后开场那一刻预算还没花完，
    // 所以这里锁的是「触顶之后绝不再开下一轮」，而不是「一轮都不许跑」。
    assert.ok(tight.orch.getRound() < baseConfig.maxRounds, `触顶后还开到了第 ${tight.orch.getRound()} 轮`)
    assert.equal(tight.orch.getUtterances().filter((u) => u.round >= 2).length, 0, '第二轮根本不该发生')
    assert.equal(tight.events.filter((e) => e.type === 'hallucination-round').length < 2, true, '逐轮账本也要跟着停')
  })

  console.log('-'.repeat(46))
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46))
  if (fail > 0) process.exit(1)
}

main()
