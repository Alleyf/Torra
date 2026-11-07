/**
 * 回放游标的离线契约：截到第几轮、上限是多少、右栏哪几条算「刚落下来」。
 *
 * 这些错在界面上都表现为「看着像卡了一下」：倒回 R1 但右栏还列着 R3 的结论、
 * 回放一开就自己停、或者一进研讨屏满屏光。截图看不出来，只能在这里钉。
 *
 * 运行：npm run test:lab-replay
 */
import assert from 'node:assert/strict'
import {
  asOfBorn,
  asOfRound,
  diffRailPoints,
  REPLAY_CALM_MS,
  REPLAY_MAX_EXTRA_MS,
  REPLAY_SETTLE_MS,
  replayDwellMs,
  replayMaxOf,
  stepContentOf,
  type RailSnap,
} from '../src/renderer/labReplay'

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

const snap = (sid: string | null, replay: number | null, ids: string[]): RailSnap => ({ sid, replay, ids })

console.log('\n上限')

it('一条数据都没有：上限是 0，回放不该开播', () => {
  assert.equal(replayMaxOf([]), 0)
  assert.equal(replayMaxOf([0, 0]), 0, '只有基线那一轮时没有可回放的格子')
})

it('取最远的一轮，不取条数', () => {
  assert.equal(replayMaxOf([1, 3, 3, 2]), 3)
})

console.log('\n按轮次截断')

it('不在回放：原样返回同一个引用', () => {
  const list = [{ round: 1 }, { round: 3 }]
  assert.equal(asOfRound(list, null), list, '回放结束若换成新数组，整张图会白重排一次')
})

it('倒回 R1：第 2、3 轮都不在', () => {
  const list = [{ round: 1 }, { round: 2 }, { round: 3 }]
  assert.deepEqual(asOfRound(list, 1), [{ round: 1 }])
})

it('截断含边界：游标那一轮算在画面里', () => {
  const list = [{ round: 2 }, { round: 3 }]
  assert.deepEqual(asOfRound(list, 2), [{ round: 2 }])
})

console.log('\n按出生轮次截断（共识 / 分歧）')

it('出生轮次超过游标：不显示', () => {
  const list = [{ born: 1 }, { born: 3 }]
  assert.deepEqual(asOfBorn(list, 1, (x) => x.born), [{ born: 1 }])
})

it('出生轮次缺失：不因为回放而消失', () => {
  const list: Array<{ born: number | null }> = [{ born: null }, { born: 3 }]
  assert.deepEqual(
    asOfBorn(list, 1, (x) => x.born),
    [{ born: null }],
    '旧存档没有轮次字段，藏起来等于凭空删掉一条真结论',
  )
})

it('出生轮次为 0（基线那一段）：一直算存在', () => {
  const list = [{ born: 0 }, { born: 2 }]
  assert.deepEqual(asOfBorn(list, 1, (x) => x.born), [{ born: 0 }])
})

console.log('\n右栏飞光：基线')

it('没有基线：一束都不放', () => {
  assert.deepEqual(diffRailPoints(null, snap('s1', null, ['c1', 'c2'])), [])
})

it('同一帧重渲：一束都不放', () => {
  const a = snap('s1', null, ['c1'])
  assert.deepEqual(diffRailPoints(a, snap('s1', null, ['c1'])), [])
})

it('换了场次：不拿上一场的结论比差', () => {
  assert.deepEqual(diffRailPoints(snap('s1', null, ['c1']), snap('s2', null, ['c1', 'c9'])), [])
})

console.log('\n右栏飞光：实时')

it('实时新确认一条结论 → 那一条放光', () => {
  const out = diffRailPoints(snap('s1', null, ['c1']), snap('s1', null, ['c1', 'c2']))
  assert.deepEqual(out, ['c2'])
})

it('一帧落下多条：受上限约束，不糊成一片', () => {
  const out = diffRailPoints(snap('s1', null, ['c1']), snap('s1', null, ['c1', 'c2', 'c3', 'c4', 'c5']))
  assert.equal(out.length, 3)
})

it('退出回放（游标变 null）：当换基准，不放光', () => {
  assert.deepEqual(diffRailPoints(snap('s1', 2, ['c1']), snap('s1', null, ['c1', 'c2'])), [])
})

console.log('\n右栏飞光：回放')

it('游标前进一格 → 那一格带回的结论放光', () => {
  const out = diffRailPoints(snap('s1', 1, ['c1']), snap('s1', 2, ['c1', 'c2']))
  assert.deepEqual(out, ['c2'])
})

it('走进回放的第一格（null → 1）：R1 的结论要放光', () => {
  /*
   * 回放是从「还没有任何一轮」开始演的：R1 这一格带回的结论就是第 1 轮形成的。
   * 多数会话的结论集中在 R1 —— 入口若静默，整场回放右栏一束光都没有，
   * 用户看到的就是「回放没有动画」（真实会话 sess_mw666cjq_1，7 条结论全在 R1）。
   */
  const out = diffRailPoints(snap('s1', null, ['c1']), snap('s1', 1, ['c1', 'c2']))
  assert.deepEqual(out, ['c1', 'c2'])
})

it('走进回放时上一帧当作第 0 轮：live 里已存在的那几条也重放', () => {
  const out = diffRailPoints(snap('s1', null, ['c1', 'c2', 'c3']), snap('s1', 1, ['c1']))
  assert.deepEqual(out, ['c1'])
})

it('手动跳到任意一轮（null → 3）：仍是换基准，不放光', () => {
  assert.deepEqual(diffRailPoints(snap('s1', null, ['c1']), snap('s1', 3, ['c1', 'c9'])), [])
})

it('跨了不止一格（手动跳轮）：不放光', () => {
  assert.deepEqual(diffRailPoints(snap('s1', 1, []), snap('s1', 3, ['c1', 'c2'])), [])
})

it('游标原地不动、结论也没变：不放光', () => {
  const a = snap('s1', 2, ['c1'])
  assert.deepEqual(diffRailPoints(a, snap('s1', 2, ['c1'])), [])
})

console.log('\n每格停留多久（回放节奏）')

/*
 * 这一组钉的是「回放看起来像不像在演化」。原来是一个死的 1400ms，比光飞行
 * （1000–1200ms）加落点成形（900ms）还短，于是下一格总在上一格还没落地时切进来 ——
 * 每一格都像被掐断。停留时长必须比那一格自己的动画长。
 */
const data = {
  utterances: [{ round: 1 }, { round: 1 }, { round: 2 }],
  consensus: [{ confirmedRound: 1 }, { confirmedRound: 2 }],
  disputes: [{ openedRound: 1 }, { openedRound: null }],
}

it('数这一格真的发生了什么：发言 + 新结论 + 新争议', () => {
  assert.deepEqual(stepContentOf(1, data), { said: 2, born: 1, opened: 1 })
  assert.deepEqual(stepContentOf(2, data), { said: 1, born: 1, opened: 0 })
})

it('缺轮次字段的旧条目不计入任何一格', () => {
  assert.equal(
    stepContentOf(1, { utterances: [], consensus: [], disputes: [{ openedRound: null }] }).opened,
    0,
    '不知道属于第几轮，算进某一格等于替它编一个',
  )
})

it('空轮只停收尾那一段，不按件数加长', () => {
  const empty = { said: 0, born: 0, opened: 0 }
  assert.equal(replayDwellMs(empty), REPLAY_SETTLE_MS)
})

it('件数越多停越久，但封顶', () => {
  const one = replayDwellMs({ said: 1, born: 0, opened: 0 })
  const many = replayDwellMs({ said: 8, born: 8, opened: 8 })
  assert.ok(one > REPLAY_SETTLE_MS, '多一件就该多停一会儿')
  assert.equal(many, REPLAY_SETTLE_MS + REPLAY_MAX_EXTRA_MS, '上限只防一格拖到十秒')
})

it('停留必须长过这一格自己的动画：光飞行 + 落点成形', () => {
  /*
   * 1000ms 是右栏那束横跨整屏的光（InsightRail 给 1000），900ms 是判断卡的 cl-form。
   * 两者之和就是「上一格看起来还在动」的下限；短于它，下一格一定切在半路上。
   */
  const floor = 1000 + 900
  assert.ok(REPLAY_SETTLE_MS >= floor, `收尾那一段 ${REPLAY_SETTLE_MS}ms 短于 ${floor}ms`)
  assert.ok(replayDwellMs({ said: 0, born: 0, opened: 0 }) >= floor)
})

it('reduced-motion：不等飞行，只留读完新数字的时间', () => {
  const busy = { said: 5, born: 3, opened: 2 }
  assert.equal(replayDwellMs(busy, true), REPLAY_CALM_MS)
  assert.ok(replayDwellMs(busy, true) < replayDwellMs(busy, false), '降级后不该反而更慢')
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
if (fail > 0) process.exit(1)
