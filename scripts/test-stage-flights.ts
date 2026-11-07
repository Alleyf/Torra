/**
 * 研讨屏飞光的离线契约：哪一帧该放光、放几束、从哪到哪。
 *
 * 钉的是「光跟着真事件走」这条：这三种来源之外一律不出光，
 * 同一事件重复渲染只出一次，换场次不出光，没基线不出光。
 * 这些错在界面上表现为「闪一下但说不清为什么」，截图看不出来 —— 只能在这里钉。
 *
 * 运行：npm run test:stage-flights
 */
import assert from 'node:assert/strict'
import { diffStage, TRUNK, type StageSnap } from '../src/renderer/stageFlights'

let pass = 0
let fail = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    fail++
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${(e as Error).message.split('\n').slice(0, 4).join('\n         ')}`)
  }
}

const snap = (
  sid: string | null,
  said: string[],
  tones: string[],
  mod: number | null,
  replay: number | null = null,
): StageSnap => ({
  sid,
  replay,
  said: said.map((id) => ({ id, agentId: id.split(':')[0] ?? 'x' })),
  tones,
  mod,
})

console.log('\n基线')

it('没有基线：一束都不放', () => {
  const out = diffStage(null, snap('s1', ['chatgpt:u1', 'claude:u2'], ['on', 'pending', 'pending', 'pending'], 1000))
  assert.equal(out.length, 0, '第一次拿到快照只能记基线，否则一进研讨屏就是满屏光')
})

it('同一帧重渲：一束都不放', () => {
  const a = snap('s1', ['chatgpt:u1'], ['on', 'pending', 'pending', 'pending'], null)
  assert.equal(diffStage(a, { ...a }).length, 0)
})

it('换了场次：不拿上一场的发言比差', () => {
  const before = snap('s1', ['chatgpt:u1', 'claude:u2'], ['done', 'done', 'pending', 'pending'], null)
  const after = snap('s2', ['gemini:u3'], ['pending', 'pending', 'pending', 'pending'], null)
  assert.equal(diffStage(before, after).length, 0, '新场次第一帧不该冒出旧场次的差')
})

console.log('\n新发言')

it('一条新发言 → 从那个模型飞到第一格', () => {
  const before = snap('s1', ['chatgpt:u1'], ['pending', 'pending', 'pending', 'pending'], null)
  const after = snap('s1', ['chatgpt:u1', 'claude:u2'], ['pending', 'pending', 'pending', 'pending'], null)
  const out = diffStage(before, after)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.kind, 'model')
  assert.equal(out[0]!.fromId, 'model:claude')
  assert.equal(out[0]!.toId, 'stage:0')
  assert.equal(out[0]!.stage, 0)
  assert.equal(out[0]!.fromStage, TRUNK, '起点是汇流口，不是上一张卡')
  assert.equal(out[0]!.tone, 'model', '颜色要用那家模型的品牌色')
  assert.equal(out[0]!.eventId, 'say:claude:u2')
})

it('同一发言重复出现在下一帧：只放一次光', () => {
  const before = snap('s1', ['chatgpt:u1'], ['pending', 'pending', 'pending', 'pending'], null)
  const mid = snap('s1', ['chatgpt:u1', 'claude:u2'], ['pending', 'pending', 'pending', 'pending'], null)
  assert.equal(diffStage(before, mid).length, 1)
  // 第三帧里那条还在，但已经不是新事件了
  assert.equal(diffStage(mid, snap('s1', ['chatgpt:u1', 'claude:u2'], ['on', 'pending', 'pending', 'pending'], null)).length, 1)
})

it('一帧冒出多条：受上限约束，不糊成一片', () => {
  const before = snap('s1', [], ['pending', 'pending', 'pending', 'pending'], null)
  const after = snap(
    's1',
    ['a:1', 'b:2', 'c:3', 'd:4', 'e:5', 'f:6'],
    ['pending', 'pending', 'pending', 'pending'],
    null,
  )
  assert.equal(diffStage(before, after).length, 4, '默认一帧最多 4 束')
  assert.equal(diffStage(before, after, 2).length, 2)
})

console.log('\n阶段推进')

it('pending → on：从上一格飞到这一格', () => {
  const before = snap('s1', [], ['done', 'pending', 'pending', 'pending'], null)
  const after = snap('s1', [], ['done', 'on', 'pending', 'pending'], null)
  const out = diffStage(before, after)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.kind, 'stage')
  assert.equal(out[0]!.fromStage, 0)
  assert.equal(out[0]!.stage, 1)
  assert.equal(out[0]!.tone, 'accent', '正在跑用强调色，不是完成色')
})

it('on → done：同一段走完，颜色换成完成色', () => {
  const before = snap('s1', [], ['done', 'on', 'pending', 'pending'], null)
  const after = snap('s1', [], ['done', 'done', 'pending', 'pending'], null)
  const out = diffStage(before, after)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.tone, 'ok')
  assert.equal(out[0]!.eventId, 'stage:1:done')
})

it('pending → done 直接跳过（一步跑完）：照样放光', () => {
  const before = snap('s1', [], ['pending', 'pending', 'pending', 'pending'], null)
  const after = snap('s1', [], ['done', 'pending', 'pending', 'pending'], null)
  assert.equal(diffStage(before, after).length, 1)
})

it('退回 pending（重跑一场）：不放光', () => {
  const before = snap('s1', [], ['done', 'done', 'pending', 'pending'], null)
  const after = snap('s1', [], ['pending', 'pending', 'pending', 'pending'], null)
  assert.equal(diffStage(before, after).length, 0, '倒退不是「走到下一格」')
})

it('第一格从汇流口起飞', () => {
  const before = snap('s1', [], ['pending', 'pending', 'pending', 'pending'], null)
  const after = snap('s1', [], ['on', 'pending', 'pending', 'pending'], null)
  const out = diffStage(before, after)
  assert.equal(out[0]!.fromId, 'trunk')
  assert.equal(out[0]!.fromStage, TRUNK)
})

it('走进回放第一格（null → 1）：R1 带回的发言要放光', () => {
  /*
   * 回放从「还没有任何一轮」开始演。多数会话的发现集中在 R1，
   * 入口若静默，整场回放前半段就是一张静止图（真实会话 sess_mw666cjq_1 的实测）。
   */
  const before = snap('s1', [], ['pending', 'pending', 'pending', 'pending'], null, null)
  const after = snap('s1', ['a:x1', 'b:x2'], ['done', 'done', 'done', 'done'], null, 1)
  const out = diffStage(before, after)
  assert.ok(out.filter((f) => f.kind === 'model').length >= 2, `发言落地的光不能少，实际 ${out.length}`)
  /* 四段的 tone 从 pending 走到 R1 的状态也是真事件；不得挤掉发言 */
  assert.ok(out.every((f) => f.kind === 'model' || f.kind === 'stage'))
})

it('走进回放时上一帧当作第 0 轮：live 里已有的发言也重放', () => {
  const live = snap('s1', ['a:x1', 'b:x2'], ['done', 'done', 'done', 'done'], null, null)
  const r1 = snap('s1', ['a:x1'], ['done', 'pending', 'pending', 'pending'], null, 1)
  const out = diffStage(live, r1)
  assert.ok(out.some((f) => f.eventId === 'say:a:x1'), 'live 里已有的那条在 R1 也要落地')
  assert.ok(out.some((f) => f.eventId === 'stage:0:done'), '第 0 轮起四段从 pending 走起')
})

it('回放里退出（→ null）：不放光', () => {
  const r1 = snap('s1', ['a:x1'], ['done', 'pending', 'pending', 'pending'], null, 1)
  const live = snap('s1', ['a:x1', 'b:x2'], ['done', 'done', 'done', 'done'], null, null)
  assert.equal(diffStage(r1, live).length, 0)
})

it('回放里跨了不止一格：不放光', () => {
  const r1 = snap('s1', ['a:x1'], ['done', 'pending', 'pending', 'pending'], null, 1)
  const r3 = snap('s1', ['a:x1', 'b:x2'], ['done', 'done', 'done', 'done'], null, 3)
  assert.equal(diffStage(r1, r3).length, 0)
})

console.log('\n主持小结')

it('主持开跑：从实时条冲向共识那一格', () => {
  const before = snap('s1', [], ['done', 'done', 'pending', 'pending'], null)
  const after = snap('s1', [], ['done', 'done', 'on', 'pending'], 1234)
  const out = diffStage(before, after)
  assert.equal(out.length, 1, '一次开跑只放一束')
  assert.equal(out[0]!.kind, 'mod')
  assert.equal(out[0]!.toId, 'stage:2')
  assert.equal(out[0]!.eventId, 'mod:1234')
})

it('主持小结换了 startedAt（重试）：也算新的一次', () => {
  const before = snap('s1', [], ['done', 'done', 'on', 'pending'], 1234)
  const after = snap('s1', [], ['done', 'done', 'on', 'pending'], 5678)
  const out = diffStage(before, after)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.eventId, 'mod:5678')
})

it('主持小结结束（回到 null）：不放光', () => {
  const before = snap('s1', [], ['done', 'done', 'done', 'pending'], 1234)
  const after = snap('s1', [], ['done', 'done', 'done', 'pending'], null)
  assert.equal(diffStage(before, after).length, 0)
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
if (fail > 0) process.exit(1)
