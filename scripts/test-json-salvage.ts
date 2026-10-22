/**
 * 被输出上限截断的 JSON 抢救 —— 离线回归（不联网、不花 token）
 *
 * 起因是一次真实故障：主持小结两次都被端点按输出上限切在半路，
 * 整份 JSON 读不通，于是整场以 no-moderator 收场 —— 共识、分歧、台账全空。
 * 修法是把**已经完整写出来**的那部分取回来，而不是整份丢掉。
 *
 * 这里钉住两件事：
 * - 该救的救得回来（含现场那两份真实的截断样本）；
 * - 不该救的救不回来，且**绝不编内容** —— 判据只有「那一段自身是合法 JSON」。
 *
 * 运行：npm run test:json-salvage
 */

import assert from 'node:assert/strict'
import { salvageTruncatedJson } from '../src/shared/jsonSalvage'

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
    console.log(`         ${(e as Error).message.split('\n').slice(0, 4).join('\n         ')}`)
  }
}

console.log('\n被输出上限截断的 JSON 抢救')
console.log('='.repeat(40))

it('完整 JSON 原样返回，不该被抢救逻辑动过', () => {
  const full = { a: 1, b: 'two', c: [1, 2, 3], d: { e: true } }
  assert.deepEqual(salvageTruncatedJson(JSON.stringify(full)), full)
})

it('markdown 代码块包裹的完整 JSON 也认', () => {
  const full = { a: 1, b: 'two' }
  assert.deepEqual(salvageTruncatedJson('```json\n' + JSON.stringify(full) + '\n```'), full)
})

it('切在顶层第二个键：第一个键必须保住', () => {
  const got = salvageTruncatedJson('{"consensus_points":[{"claim":"A"}],"score_dimensions":{"agreement":60,"over') as any
  assert.ok(got, '整份丢掉就是最坏结果')
  assert.deepEqual(got.consensus_points, [{ claim: 'A' }], '完整写出的第一个键没保住')
  /**
   * score_dimensions 被切在 agreement 之后：**已经写出来的那个维度要保住**。
   * 丢掉它等于「这一轮没有任何分数可算」，而那半句 agreement 是模型真的写了出来的。
   * 校验层仍会因缺 overlap/trend 驳回整份 —— 抢救只负责还原，判据不动。
   */
  assert.deepEqual(got.score_dimensions, { agreement: 60 })
})

it('切在数组中间：已写完的元素保住，末尾半个元素丢掉', () => {
  const got = salvageTruncatedJson('{"points":[{"id":1},{"id":2},{"id":3},{"id":') as any
  assert.ok(got)
  assert.deepEqual(got.points, [{ id: 1 }, { id: 2 }, { id: 3 }], '完整的第三个元素不该被丢')
})

it('现场样本一号：停在 "continues": 上（第一次尝试的真实形态）', () => {
  /**
   * sess_mvityhpl_1 第一次尝试的原文尾部：第二个共识点写到 "continues": 就没了。
   * 第一个共识点完整且合法（claim/support/confidence/weight/evidence_ref 齐全）。
   */
  const raw = `{
  "consensus_points": [
    {
      "claim": "两个领域目前都没有可直接适配标准外推评测的现成 TKGR 数据集或基准，因此应采用双阶段方案。",
      "support": ["ChatGPT", "元宝"],
      "confidence": 0.85,
      "weight": 0.8,
      "evidence_ref": ["utt_mvityhq8_4", "utt_mvityhq9_5"],
      "continues": null
    },
    {
      "claim": "标准外推链接预测必须按时间切分，以 MRR、Hits@1/3/10 为主要指标。",
      "support": ["ChatGPT"],
      "confidence": 0.8,
      "weight": 0.7,
      "evidence_ref": ["utt_mvityhq8_4"],
      "continues":`
  const got = salvageTruncatedJson(raw) as any
  assert.ok(got, '真实样本都救不回来，这个函数没用')
  assert.equal(got.consensus_points.length, 2, '两条共识的实质内容都写完了，该都保住')
  assert.ok(got.consensus_points[0].claim.startsWith('两个领域目前都没有'))
  assert.deepEqual(got.consensus_points[0].support, ['ChatGPT', '元宝'])
  assert.equal(got.consensus_points[0].continues, null, '完整的 continues:null 也该保住')
  /**
   * 第二条的 "continues": 后面没有值 —— 那个键丢掉，
   * 但这条共识本身（claim / support / confidence / weight / evidence_ref）写完了，保住。
   *
   * continues 是「承接第几条旧共识」的标记，补成 null 等于替模型断言「它不承接任何东西」，
   * 而报告会把这句话印给用户看。所以丢键、不丢结论。
   */
  assert.ok(got.consensus_points[1].claim.startsWith('标准外推链接预测'))
  assert.deepEqual(got.consensus_points[1].evidence_ref, ['utt_mvityhq8_4'])
  assert.equal(got.consensus_points[1].continues, undefined, '没写值的键不该被补成 null')
})

it('现场样本二号：切在 callout 指令中间（第二次尝试的真实形态）', () => {
  /**
   * 第二次尝试的现场原文（2969 字，被输出上限切在 instruction 中间）。
   * 前面那些键全都完整写完了 —— 共识 3 条、分歧 2 条、三维分数、综合分都在，
   * 只有 callout 的指令没说完。
   */
  const raw = `{"consensus_points":[{"claim":"C1","support":["ChatGPT","magpie"],"confidence":0.78,"weight":0.7,"evidence_ref":["utt_1"],"continues":null},{"claim":"C2","support":["ChatGPT"],"confidence":0.75,"weight":0.65,"evidence_ref":["utt_1","utt_2"],"continues":null}],"open_disputes":[],"score_dimensions":{"agreement":60,"overlap":35,"trend":55},"score":52,"callout":{"target_agent":"元宝","quote_from_agent":"元宝","instruction":"你本轮把发言写成了对任务本身的元推理`
  const got = salvageTruncatedJson(raw) as any
  assert.ok(got)
  assert.equal(got.consensus_points.length, 2, '两条完整共识都在，该全保住')
  assert.deepEqual(got.open_disputes, [], '空的数组是完整值，该保住')
  assert.deepEqual(got.score_dimensions, { agreement: 60, overlap: 35, trend: 55 })
  assert.equal(got.score, 52, 'callout 之前写完的键都该保住')
  /**
   * callout 只写完了 target_agent 就被切了。留下半个 callout 比丢掉更糟：
   * 它会被当成「主持点名了谁」，而 instruction 恰好是决定点名内容的那一段。
   * 校验层只查 target_agent 是否在参会名单里，查不出这句话其实是空的 ——
   * 所以这一层要自己决定：没写完的嵌套对象整体丢弃。
   */
  assert.equal(got.callout, undefined, '只写了一半的嵌套对象不该留下半个')
})

it('截得太早（连一个完整键都没有）：老实认输，不返回空壳', () => {
  assert.equal(salvageTruncatedJson('{"consensus_points":[{"claim":"半句'), null)
})

it('没有对象、没有括号：不是 JSON 就别硬救', () => {
  assert.equal(salvageTruncatedJson('完全不是 JSON 的解释文字'), null)
  assert.equal(salvageTruncatedJson(''), null)
})

it('字符串里的括号与逗号不算结构符号', () => {
  const got = salvageTruncatedJson('{"a":"里面有个 } 和逗号, 都不能信","b":2,"c":') as any
  assert.ok(got)
  assert.equal(got.a, '里面有个 } 和逗号, 都不能信', '字符串内容被结构扫描吃坏了')
  assert.equal(got.b, 2, '字符串里的 } 把后面完整的一对判成了截断')
  assert.equal(got.c, undefined)
})

it('转义引号不结束字符串', () => {
  const got = salvageTruncatedJson('{"a":"他说\\"引号\\"，然后继续","b":7,"c":') as any
  assert.ok(got)
  assert.equal(got.a, '他说"引号"，然后继续')
  assert.equal(got.b, 7)
})

it('分数与共识都写完了、只有末尾 callout 写一半：前面那些必须全保住', () => {
  const raw = [
    '{',
    '  "consensus_points": [{"claim":"A","support":["m_a"],"confidence":0.8,"evidence_ref":["u1"]}],',
    '  "open_disputes": [],',
    '  "score_dimensions": {"agreement":60,"overlap":35,"trend":55},',
    '  "score":52,',
    '  "callout":{"target_agent":"m_a","quote_from_agent":"m_a","instruction":"接着说',
  ].join('\n')
  const got = salvageTruncatedJson(raw) as any
  assert.ok(got, '这一份该救得回来')
  assert.equal(got.consensus_points.length, 1)
  assert.deepEqual(got.score_dimensions, { agreement: 60, overlap: 35, trend: 55 })
  assert.equal(got.score, 52)
  assert.equal(got.callout, undefined, '半个 callout 不该留下')
})

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail) process.exitCode = 1
