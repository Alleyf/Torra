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
import { buildReport, reportToMarkdown } from '../src/main/report/report'
import type { Agent, SendResult } from '../src/main/agents/agent'
import type { HallucinationReport, SessionConfig, Topic, TransportKind, TurnContext, Utterance } from '../src/shared/types'

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
  onPrompt?: (user: string, system: string, kind: 'digest' | 'final-review') => void,
) {
  let round = 0
  return {
    id: 'm_m',
    send: async (raw: { system: string; user: string }, onDelta?: (chunk: string) => void) => {
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
      /**
       * 终局审校：一条合规、一条引用不存在的结论编号 ——
       * 夹具故意混一条假的，才验得出落盘的是主持真说过的，不是程序补出来的。
       */
      if (raw.system.includes('终局审校')) {
        onPrompt?.(raw.user, raw.system, 'final-review')
        const refs = [...raw.user.matchAll(/\butt_[A-Za-z0-9_]+/g)].map((m) => m[0])
        return {
          content: JSON.stringify({
            decisions: [
              {
                decision: '先按方案X上线，监控分级并行推进',
                based_on: ['1'],
                premises: ['迁移周期确实为两周'],
                costs: ['上线节奏比基线慢一周'],
                actions: ['@甲模型 本周五前提交回滚预案'],
                evidence_ref: refs.slice(0, 1),
              },
              {
                decision: '把供应商合同改为季度评审',
                based_on: ['99'],
                premises: ['合同按年签署'],
                costs: [],
                actions: [],
                evidence_ref: refs,
              },
            ],
          }),
          usage,
        }
      }
      const bracketed = [...raw.user.matchAll(/^-\s+\[([^\]]+)\]/gm)].map((m) => m[1] as string)
      onPrompt?.(raw.user, raw.system, 'digest')
      round += 1
      const content = digestRound(
        bracketed.filter((x) => !x.startsWith('cp_')),
        round,
        bracketed.filter((x) => x.startsWith('cp_')),
      )
      // 真通道是流式的：分两段回，主持进度事件才有东西可发
      onDelta?.(content.slice(0, 40))
      onDelta?.(content.slice(40))
      return { content, usage }
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

/**
 * 条目级处置的夹具：第一轮登记三条分歧，第二轮给出三种处置结果 ——
 * 一条写清了缺什么（该搁置）、一条漏写缺什么证据（该拒）、一条依据指向不存在的发言（该拒）。
 * 三种结果同场出现，才验得出「处置」既不是一按就结案，也不是少写一个字段就整轮作废。
 */
function shelveDigestJson(ids: string[], round: number): string {
  const idA = ids[0] ?? ''
  const idB = ids[1] ?? idA
  const lines = [
    {
      claim: '上线节奏',
      sides: [
        { agent_id: 'm_a', argument: '先方案X，监控并行' },
        { agent_id: 'm_b', argument: '先监控分级，再上线' },
      ],
    },
    { claim: '回滚窗口', sides: [{ agent_id: 'm_b', argument: '回滚要占同一个发布窗口' }] },
    { claim: '成本口径', sides: [{ agent_id: 'm_a', argument: '成本差在迁移周期上' }] },
  ]
  return JSON.stringify({
    consensus_points:
      round === 1
        ? [{ claim: '采用方案X', support: ['m_a', 'm_b'], confidence: 0.8, weight: 0.7, evidence_ref: [idA] }]
        : [{ claim: '监控分级并行推进', support: ['m_a', 'm_b'], confidence: 0.7, weight: 0.6, evidence_ref: [idA] }],
    open_disputes: round === 1 ? lines : [],
    ...(round === 2
      ? {
          dispute_updates: [
            {
              dispute: '上线节奏',
              action: 'shelved',
              reason: '当场没有可核对的线上错误率，判不了谁的前提更硬',
              missing_evidence: '近 30 天线上错误率',
              evidence_ref: [idA],
            },
            { dispute: '回滚窗口', action: 'shelved', reason: '等发布窗口表', missing_evidence: '', evidence_ref: [idB] },
            { dispute: '成本口径', action: 'resolved', reason: '双方认了同一个口径', evidence_ref: ['utt_phantom'] },
          ],
        }
      : {}),
    score_dimensions: { agreement: 55, overlap: 40, trend: 50 },
    score: 50,
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
  /**
   * 终局审校的提示词单独收一份：它和「两轮小结」是两套口径，
   * 混进 prompts 会让所有按轮次数断言的用例误判。
   */
  const reviewPrompts: string[] = []
  const agents = new Map<string, Agent>([
    ['m_a', makeAgent('m_a', '甲模型', A_TEXT, seen)],
    ['m_b', makeAgent('m_b', '乙模型', B_TEXT, seen)],
  ])
  // 主持只建一次：它自己记着「第几次小结 = 第几轮」，每次 getModerator 新建会把轮次重置
  const moderator = makeModerator(digest, (user, system, kind) => {
    if (kind === 'final-review') {
      reviewPrompts.push(user)
      return
    }
    prompts.push(user)
    systems.push(system)
  })
  const orch = new Orchestrator(topic, config, {
    getAgent: (id) => agents.get(id),
    getModerator: () => moderator,
    // 署名轨的真实接线（见 main/index.ts 的 nameOf: modelName）：
    // 不接这里，提示词里只会看到内部 id，兼岗与命名两条口径都验不到
    nameOf: (id) => agents.get(id)?.displayName,
  })
  const events: OrchestratorEvent[] = []
  orch.on('event', (e: OrchestratorEvent) => events.push(e))
  await orch.run()
  return { orch, events, seen, prompts, systems, reviewPrompts }
}

const typeOf = (e: OrchestratorEvent) => e.type
const byId = (list: Utterance[], claim: (u: Utterance) => boolean) => list.find(claim)

async function main() {
  console.log('\n编排器离线端到端回归（假通道跑满一场）')
  console.log('='.repeat(46))

  const { orch, events, seen, systems, reviewPrompts } = await runSession(baseConfig)

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

  await it('主持小结有实时进度事件：整份 JSON 落回来之前，UI 就知道它在吐字', async () => {
    const progress = events.filter((e) => e.type === 'moderator-progress')
    assert.ok(progress.length >= 2, `每轮小结都该发过进度，实际 ${progress.length} 条`)
    const p = progress[0]
    if (p.type !== 'moderator-progress') return
    assert.ok(p.chars > 0 && p.tail.length > 0, '进度要带字数与原文尾巴，否则界面只能显示「等待中」')
    assert.ok(p.firstByteMs >= 0, '首字延迟不能是负数')
    assert.equal(p.attempt, 1, '一次通过时不该出现第二次尝试')
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
    assert.match(dual.prompts[0]!, /^- 甲模型（主持兼任参会，本场也在发言）/m)
    // 署名轨用模型名称指代，内部 id 不进提示词（id 形如 api-user-*，对模型没有语义）
    assert.ok(!/^- m_a$/m.test(dual.prompts[0]!), `名单里漏出了内部 id：${dual.prompts[0]}`)
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
    assert.equal(run.prompts.length, 2, `两轮小结各发一次，实际 ${run.prompts.length}`)
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
    // 两轮小结 + 一次对照 + 一次终局审校：加了收尾调用就必须进台账，否则「主持调了几次」是假的
    assert.equal(ledger.moderatorCalls, 4, `两轮小结 + 对照 + 终局审校，实际 ${ledger.moderatorCalls}`)
    assert.ok(ledger.apiCalls >= 6, `发言/基线/核验调用都该记账，实际 ${ledger.apiCalls}`)
    assert.ok(ledger.totalMs >= 0)
    const compare = orch.getBaselineCompare()
    assert.equal(compare?.verdict, 'mixed')
    assert.deepEqual(compare?.councilAdds, ['把监控分级列为并行项'])
    assert.ok(orch.getStageTimings().some((t) => t.stage === 'verification'), '核验轮要进阶段耗时')
  })

  /**
   * 终局审校是报告里唯一的「加工层」，所以两件事都要成立：
   * 合规的决定落地并带真实依据；引用不成立的那条被丢弃且留下理由 —— 
   * 程序宁可少一条决定，也不能替模型把依据补出来。
   */
  await it('终局审校：决定落在真实结论上，假引用丢弃留痕', async () => {
    assert.ok(events.some((e) => e.type === 'final-review'), '审校结果要发事件，议事厅不等报告')
    const review = orch.getFinalReview()
    assert.ok(review, '终局审校没产出')
    assert.equal(review!.decisions.length, 1)
    const d = review!.decisions[0]!
    const points = orch.getConsensusPoints()
    assert.ok(points.some((p) => p.id === d.basedOn[0]), `basedOn 要指向真实结论 id，实际 ${d.basedOn.join(',')}`)
    assert.ok(orch.getAllUtterances().some((u) => u.id === d.evidenceRef[0]), '决定的依据必须是本场真发过言的条目')
    assert.deepEqual(d.premises, ['迁移周期确实为两周'])
    assert.match(review!.rejected.join('\n'), /不在本场结论清单里/)
    assert.equal(review!.decisions.length, 1, '只有合规的那条能留下')
    assert.ok(review!.uncovered.length > 0, '没被任何决定引用的结论要点名，不能假装全覆盖')
    assert.ok(
      orch.getStageTimings().some((t) => t.stage === 'final-review' && /纳入 1 条决定/.test(t.summary)),
      '审校要进阶段耗时并说得出落了几条',
    )

    /** 提示词里必须给出现实可引用的结论编号与发言 id —— 不给就等于要求模型凭空引用 */
    assert.equal(reviewPrompts.length, 1, `终局审校只该发起一次，实际 ${reviewPrompts.length}`)
    const reviewUser = reviewPrompts[0] ?? ''
    assert.ok(/\butt_[A-Za-z0-9_]+/.test(reviewUser), '审校提示词没列出可引用的发言 id')
    assert.match(reviewUser, /仍未消解的分歧/, '未决条目要交给审校，它只能出现在代价里')
    assert.match(reviewUser, /已确认结论/, '审校要拿到结论清单才能加工')
  })

  /**
   * 报告层拿到的就是这场跑完的台账本身：装配层一旦丢字段，
   * 分档、锚点、审校引用全部跟着错位，而单测函数看不出来。
   */
  await it('报告读的是同一本台账：档位、发言锚点、审校序号都能对上', async () => {
    const rep = buildReport({
      topic,
      config: baseConfig,
      utterances: orch.getAllUtterances(),
      confirmed: orch.getConsensusPoints(),
      open: orch.getDisputes(),
      explored: orch.getExplored(),
      scores: orch.getScores(),
      modelNames: new Map([['m_a', '甲模型'], ['m_b', '乙模型'], ['m_m', '主持']]),
      modelTransports: new Map<string, TransportKind>([['m_a', 'api'], ['m_b', 'api'], ['m_m', 'api']]),
      totalCostUsd: orch.getSpentUsd(),
      durationMs: 1000,
      budgetLimited: false,
      moderatorUnavailable: false,
      finishedReason: 'max-rounds',
      interventions: [],
      duels: [],
      moderatorAudit: [],
      stageTimings: orch.getStageTimings(),
      baseline: orch.getBaseline(),
      baselineCompare: orch.getBaselineCompare(),
      hallucination: orch.getHallucinationReport(),
      finalReview: orch.getFinalReview(),
      ledger: orch.getLedger(),
    })
    const md = reportToMarkdown(rep, topic)
    const ids = new Set(orch.getAllUtterances().map((u) => u.id))
    const anchors = [...md.matchAll(/- (utt_[A-Za-z0-9_]+) · R/g)].map((m) => m[1] as string)
    assert.ok(anchors.length > 0, '证据行没有带出发言锚点，导出的那份就指不回台账')
    assert.ok(anchors.every((x) => ids.has(x)), `锚点里出现本场不存在的发言：${anchors.filter((x) => !ids.has(x)).join(',')}`)

    // 档位来自最终台账：被核验否认的条目不许还站在「多家印证」那一档
    const struck = rep.consensus.filter((c) => c.verification && ['disputed', 'vacated'].includes(c.verification.status))
    if (struck.length > 0) {
      assert.ok(md.includes('被否认或撤回'), '核验否认的条目要单独成档，不能混在结论里')
    }
    // 审校引用的是台账原始序号：两边编号对不上，报告就成了两句互相看不懂的话
    const review = orch.getFinalReview()
    assert.ok(review && review.decisions.length > 0, '这场该有终局审校产出')
    const ledgerList = orch.getConsensusPoints()
    const idx = ledgerList.findIndex((c) => c.id === review!.decisions[0]!.basedOn[0])
    assert.ok(idx >= 0, `审校依据要指向本场真实结论，实际 ${review!.decisions[0]!.basedOn.join(',')}`)
    assert.equal(
      rep.consensus[idx]?.claim,
      ledgerList[idx]!.claim,
      '报告条目与台账必须同序同条，否则序号会指到别家判断上',
    )
    assert.ok(
      md.includes(`\n${idx + 1}. **${ledgerList[idx]!.claim}**`),
      `审校引用的第 ${idx + 1} 条没按原始序号印出来`,
    )
    assert.ok(
      (rep.finalReview?.decisions[0]?.basedOnClaims ?? []).some((x) => x.startsWith(`${idx + 1}. `)),
      '审校章节要把引用解析成「第 N 条 · 原话」，只给 id 读者对不上',
    )

    // 运行账目降噪：九格表退役，进程与参与度挪进末尾附录
    assert.ok(!md.includes('## 关键数字'), '九格表要退役：那九个数字同时出现在 hero、正文表和溯源章节里')
    assert.ok(md.indexOf('## 附：运行账目与溯源') > md.indexOf('下一步建议'), '进程与参与度排在正文之后、附录之内')
    assert.ok(md.includes('### 讨论进程') && md.includes('### 参与度与血缘'), '附录仍要给出这两节，降噪不是删除')
    assert.equal(
      (md.match(/墙钟耗时/g) ?? []).length,
      1,
      '耗时这类数字不许在 hero、九格、溯源里各写一遍',
    )
  })

  /**
   * 收束不看加权分：这条 fixture 里 `consensusThreshold: 99` 已经只是个没人读的字段。
   * 判据只剩结构条件，所以理由必须说得出卡在哪一条（还剩几条没处置），
   * 而不是像旧口径那样报「分数没到」。
   */
  await it('没谈完就不谎称收敛，理由点名卡在哪条结构条件上', async () => {
    const conv = events.filter((e) => e.type === 'convergence') as Array<{ converged: boolean; path: string; round: number; reason: string }>
    assert.equal(conv.length, 2)
    assert.ok(conv.every((c) => !c.converged), '还有未处置的分歧，不该收敛')
    assert.ok(conv.every((c) => c.path === 'none'))
    assert.ok(conv.every((c) => c.reason.length > 0))
    assert.equal(events.some((e) => e.type === 'converged'), false)
    assert.ok(conv.every((c) => !/阈值|分数线/.test(c.reason)), `收敛理由还在拿分数线说话：${conv.map((c) => c.reason).join(' | ')}`)
    const last = conv[conv.length - 1]!
    assert.match(last.reason, /未决 1 条/, '第 2 轮卡的是那一条还没处置的分歧')
  })

  await it('条目级处置：搁置要写清缺什么，缺依据的处置只留痕不结案', async () => {
    const run = await runSession(
      { ...baseConfig, baseline: false, baselineCompare: false, verifyPass: 'off' },
      shelveDigestJson,
    )
    const list = run.orch.getDisputes()
    const shelved = list.find((d) => d.status === 'shelved')
    assert.ok(shelved, '写清了「当场判不了 + 缺什么证据」的搁置必须落地，否则条目只能拖到轮数用尽')
    assert.equal(shelved?.claim, '上线节奏')
    assert.equal(shelved?.shelve?.missing, '近 30 天线上错误率')
    assert.equal(shelved?.sides.length, 2, '搁置只改状态，双方论据要逐字留着')

    // 漏写缺什么证据、依据指向不存在的发言：两条处置都该被拒，条目留在 open
    assert.equal(list.find((d) => d.claim === '回滚窗口')?.status, 'open', '没写缺什么证据的搁置＝体面的弃权，不许生效')
    assert.equal(list.find((d) => d.claim === '成本口径')?.status, 'open', '依据指向不存在的发言，处置不许生效')
    // 被拒的是那一条处置，不是整份小结
    assert.ok(
      run.orch.getConsensusPoints().some((p) => p.claim === '监控分级并行推进'),
      '一条处置被拒就驳回整轮小结：其他结论跟着作废，代价落在程序上',
    )

    // 处置通道要真出现在主持的提示词里，否则主持根本不知道有这条路
    assert.ok(run.prompts[1]!.includes('此前已登记且仍未处置的分歧'), '第二轮小结没拿到待处置清单')
    assert.match(run.prompts[1]!, /dispute_updates/)
    assert.ok(run.prompts[1]!.includes('上线节奏'), '已登记的分歧要能被下一轮主持点名')

    // 搁置解除的是「还要求别人回应」，不是「从清单里消失」
    const conv = run.events.filter((e) => e.type === 'convergence') as Array<{ converged: boolean; reason: string }>
    assert.match(conv[conv.length - 1]!.reason, /未决 2 条/, '搁置的条目不再算未决，另两条被拒的处置还留着')
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
