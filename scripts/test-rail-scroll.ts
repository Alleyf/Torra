/**
 * 右栏滚动定位的离线契约。
 *
 * 这件事在界面上表现为「光飞出去了，但不知道落在哪」：新结论在折线以下时
 * 根本没有落点，或者滚过头把上一条正在读的判断顶出屏幕。
 * 算术是纯的，所以在这里钉住三种边：往下补、往上补、比可视区还高。
 *
 * 运行：npm run test:rail-scroll
 */
import assert from 'node:assert/strict'
import { revealDelta } from '../src/renderer/railScroll'

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

/** 可视区固定 400 高 */
const view = { top: 100, bottom: 500 }

console.log('\n右栏滚动定位')

it('已经整条可见：一点都不动', () => {
  assert.equal(revealDelta(view, { top: 200, bottom: 300 }), 0)
  assert.equal(revealDelta(view, { top: 100, bottom: 500 }), 0, '正好贴边也算可见')
})

it('落在折线以下：只补超出的那一截，不把卡片顶到顶部', () => {
  // 卡片 460..580，超出底边 80
  assert.equal(revealDelta(view, { top: 460, bottom: 580 }), 80)
})

it('落在折线以上：往上补，同样只补差的那一截', () => {
  // 卡片 40..140，顶边超出 60
  assert.equal(revealDelta(view, { top: 40, bottom: 140 }), -60)
})

it('比可视区还高：对齐顶部', () => {
  /*
   * 展开一条长证据的判断卡会高过整栏。这时若按「底部对齐」算，
   * 标题行会被滚到折线以上，屏幕上只剩一段正文 —— 读的人找不到这张卡是什么。
   */
  const tall = { top: 300, bottom: 300 + 700 }
  assert.equal(revealDelta(view, tall), 300 - view.top)
})

it('顶部超出且同样过高：仍然对齐顶部', () => {
  const tall = { top: 20, bottom: 20 + 700 }
  assert.equal(revealDelta(view, tall), 20 - view.top)
})

it('高度刚好等于可视区：按普通卡片处理，不动', () => {
  assert.equal(revealDelta(view, { top: 100, bottom: 500 }), 0)
})

console.log(`\n${pass} 通过 · ${fail} 失败`)
if (fail > 0) process.exit(1)
