/**
 * 成稿 HTML（src/main/report/report-html.ts）自测。
 *
 * 只钉住读文件的人会真的碰到的事：
 * - 模型写的文字不是可信 HTML：题目/判断里带标签也必须原样显示，不能进标记；
 * - 终局审校没有时，文件要写明「本场没有终局审校」，不能整节省略（UI 同一条口径）；
 * - 有终局审校时，前提/代价/动作要印出来，不能只印决定那一句；
 * - 缺席轮次要写到轮号（R1、R3），只写次数读者对不上是哪几轮；
 * - 离线承诺：文档里不许有 <script> 和外部资源引用；
 * - 一大坨只有换行的摘要要切成可读段落。
 *
 * 运行：npm run test:report-html
 */

import assert from 'node:assert/strict'
import { normalizeReport } from '../src/shared/report-model'
import type { Report, Topic } from '../src/shared/types'
import { reportToHtml } from '../src/main/report/report-html'

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

const topic = (title: string): Topic => ({ title, kind: 'custom' } as unknown as Topic)

/** 最小可渲染的报告；normalizeReport 负责补缺字段，所以只写测试关心的那几项 */
function report(over: Record<string, unknown> = {}): Report {
  return normalizeReport({
    sessionId: 'sess_html',
    executiveSummary: '这一场讨论结束了。',
    verdict: { level: 'qualified', headline: '可以往前走一步', reasons: ['有两家同意'], coverage: 80 },
    stats: { utterances: 6, humanUtterances: 0, replyEdges: 4, absentCount: 0, speakerCount: 2 },
    timeline: [{ round: 1 }],
    consensus: [],
    disputes: [],
    participation: [],
    blindSpots: [],
    baseline: null,
    baselineCompare: null,
    ...over,
  } as unknown as Report)
}

const claim = {
  claim: '先冻结评测协议，再比较模型',
  supporters: ['a', 'b'],
  supporterCount: 2,
  confidence: 0.9,
  supportRatio: 100,
  sourceRounds: [1],
  sourceUtteranceIds: ['u1'],
  evidence: [{ utteranceId: 'u1', agentId: 'a', text: '我坚持先冻结协议。' }],
  verifiedSupportRate: 1,
  crossExamined: true,
}

console.log('\n[report-html] 成稿 HTML')

it('模型文字里的标签原样转义，不进标记', () => {
  const html = reportToHtml(
    report({ consensus: [{ ...claim, claim: '<img src=x onerror=alert(1)>结论' }] }),
    topic('<script>alert(2)</script> 题目'),
  )
  assert.ok(!html.includes('<script>'), '题目里的 <script> 必须被转义')
  assert.ok(!html.includes('<img src=x'), '判断里的 <img> 必须被转义')
  assert.ok(html.includes('&lt;script&gt;'), '应保留原样文字的可读形式')
})

it('没有终局审校时写明原因，不整节省略', () => {
  const html = reportToHtml(report({ finalReview: null }), topic('题目'))
  assert.ok(html.includes('id="decisions"'), '决定一节要在')
  assert.ok(html.includes('本场没有终局审校'), '要写明这一节为什么是空的')
})

it('有终局审校时印全前提、代价与动作', () => {
  const html = reportToHtml(
    report({
      finalReview: {
        decisions: [
          {
            id: 'd1',
            decision: '把 TKG 当中间层，不端到端替代领域模型',
            premises: ['下游保留领域模型与人工复核'],
            costs: ['要额外开发接入接口'],
            actions: ['架构负责人两周内提交接入规范'],
          },
        ],
      },
    }),
    topic('题目'),
  )
  assert.ok(html.includes('下游保留领域模型与人工复核'), '前提要印出来')
  assert.ok(html.includes('要额外开发接入接口'), '代价要印出来')
  assert.ok(html.includes('架构负责人两周内提交接入规范'), '动作要印出来')
  assert.ok(!html.includes('undefined'), '不得漏字段留 undefined')
})

it('缺席轮次写到轮号', () => {
  const html = reportToHtml(
    report({
      participation: [
        {
          agentId: 'a',
          displayName: '模型甲',
          transport: 'api',
          utterances: 3,
          replies: 2,
          citedBy: 1,
          absentRounds: 2,
          absentRoundList: [1, 3],
        },
      ],
    }),
    topic('题目'),
  )
  assert.ok(html.includes('（R1、R3）'), '应写出缺席的轮号')
})

it('不外链、不带脚本：离线打开是同一份', () => {
  const html = reportToHtml(report(), topic('题目'))
  assert.ok(!/<script/i.test(html), '不许有脚本')
  assert.ok(!/\ssrc=/i.test(html), '不许内嵌外部资源')
  assert.ok(!/<link\b/i.test(html), '不许外链样式')
  assert.ok(!/url\(\s*['"]?https?:/i.test(html), 'CSS 里不许拉远程字体')
})

it('正文里不再复读封面上的题目', () => {
  const html = reportToHtml(report({ executiveSummary: '围绕「题目」的讨论已结束（达到最大轮次）。' }), topic('题目'))
  const answer = html.slice(html.indexOf('id="answer"'), html.indexOf('<section class="kpis"'))
  assert.ok(!answer.includes('「题目」'), '正文里不该再把整题抄一遍')
  assert.ok(answer.includes('讨论已结束'), '剩下的那句要还在，不能整段被吃掉')
})
it('题目引在句中时，句首的字不动', () => {
  const html = reportToHtml(report({ executiveSummary: '围绕这一方案，「题目」还差一组对照实验。' }), topic('题目'))
  assert.ok(html.includes('围绕这一方案，'), '引号段不在句首，不该动它前面的字')
})

it('题目没被原文引用时正文照原样保留', () => {
  const html = reportToHtml(report({ executiveSummary: '先说结论：这条路走得通。' }), topic('题目'))
  assert.ok(html.includes('先说结论：这条路走得通。'), '没有复读就不该动原文')
})
it('附录在文件里是展开的：折叠态打印时不进纸面', () => {
  const html = reportToHtml(
    report({
      participation: [
        { agentId: 'a', displayName: '模型甲', transport: 'api', utterances: 3, replies: 2, citedBy: 1, absentRounds: 0 },
      ],
    }),
    topic('题目'),
  )
  assert.ok(/<details class="appendix" open>/.test(html), '折叠的 details 在打印时会被整个裁掉')
  assert.ok(html.includes('参与度'), '台账要确实在文档里')
})


it('整段摘要切成可读段落', () => {
  const html = reportToHtml(report({ executiveSummary: '甲认为应先冻结协议。'.repeat(30) }), topic('题目'))
  const answer = html.slice(html.indexOf('id="answer"'), html.indexOf('<section class="kpis"'))
  const count = (answer.match(/<p>/g) ?? []).length
  assert.ok(count >= 2, `长摘要应拆成多段，实际 ${count} 段`)
})

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
