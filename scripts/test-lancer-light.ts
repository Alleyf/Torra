/**
 * 光线层的离线契约。
 *
 * 要钉的是四件在界面上很难看出来的事：
 *
 * 1. **一次飞行一条路径**。弯度由 eventId 定种子 —— 同一件事重放，路径必须一模一样；
 *    换一件事，路径才该变。逐帧随机会让光抖，抖动看起来像信号不好，不像光。
 * 2. **慢起、加速、慢落**。1.2 秒里最容易写错的是缓动：线性匀速看着像机械臂，
 *    而「快起慢落」又不叫落地。这里按三点验曲线形状，不按截图验。
 * 3. **该停就停**。没有光在飞时必须没有待跑的帧；页面藏起来要冻结，且回来时
 *    不能把过站的光一次画完。空闲还在跑帧循环，是在拿电池换什么都不做。
 * 4. **卸载要干净**。层销毁后：节点没了、监听摘了、再 emit 也不该画。
 *
 * 这些都不需要真 Electron：给一个最小的 DOM 桩 + 假时钟就够了。
 * 真界面上的落点由冒烟那一侧验（那边量的是真实 rect）。
 *
 * 运行：npm run test:lancer-light
 */

import assert from 'node:assert/strict'
import {
  FLIGHT_MS,
  createLightLayer,
  curveD,
  curvePoints,
  easeInOutCubic,
  pointOnCurve,
  seedOf,
  type LightLayer,
} from '../src/renderer/lancerLight'

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

// ── 最小 DOM 桩 ─────────────────────────────────────────────────────

interface FakeEl {
  tag: string
  attrs: Record<string, string>
  children: FakeEl[]
  parent: FakeEl | null
  removed: boolean
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean }
  setAttribute(k: string, v: string): void
  getAttribute(k: string): string | null
  appendChild(c: FakeEl): FakeEl
  remove(): void
}

function makeEl(tag: string): FakeEl {
  const classes = new Set<string>()
  const el: FakeEl = {
    tag,
    attrs: {},
    children: [],
    parent: null,
    removed: false,
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) {
      this.attrs[k] = v
    },
    getAttribute(k) {
      return this.attrs[k] ?? null
    },
    appendChild(c) {
      c.parent = this
      this.children.push(c)
      return c
    },
    remove() {
      this.removed = true
      if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this)
    },
  }
  return el
}

interface Rig {
  svg: FakeEl
  layer: LightLayer
  /** 推进假时钟并跑一遍排着的帧 */
  step(ms: number): void
  frames(): number
  clock(): number
  fire(name: string): void
  setVisible(v: boolean): void
}

/**
 * 全局定时器的最小形状：这条测试要换掉它数时长。
 * 单独起名而不就地断言，是因为 Node 的 `setTimeout` 返回 `Timeout`，
 * 与浏览器签名不同 —— 就地写会得到一个「能编译但读错字段」的形状。
 */
interface TimerHost {
  setTimeout: (fn: () => void, ms?: number) => number
}
function rig(opts: { reduceMotion?: boolean; hitClass?: string; hitMs?: number } = {}): Rig {
  const listeners: Record<string, Array<() => void>> = {}
  const doc = {
    createElementNS: (_ns: string, tag: string) => makeEl(tag),
    addEventListener: (n: string, f: () => void) => {
      ;(listeners[n] ??= []).push(f)
    },
    removeEventListener: (n: string, f: () => void) => {
      listeners[n] = (listeners[n] ?? []).filter((x) => x !== f)
    },
    visibilityState: 'visible',
  }
  ;(globalThis as unknown as { document: unknown }).document = doc
  if (!(globalThis as unknown as { window?: unknown }).window) {
    ;(globalThis as unknown as { window: unknown }).window = globalThis
  }

  const clock = { t: 0 }
  const queue = new Map<number, (t: number) => void>()
  let seq = 0
  const svg = makeEl('svg')
  const layer = createLightLayer(svg as never, {
    reduceMotion: opts.reduceMotion,
    hitClass: opts.hitClass,
    hitMs: opts.hitMs,
    now: () => clock.t,
    raf: (cb) => {
      const id = ++seq
      queue.set(id, cb)
      return id
    },
    cancelRaf: (id) => void queue.delete(id),
  })
  return {
    svg,
    layer,
    step(ms) {
      clock.t += ms
      const cbs = [...queue.values()]
      queue.clear()
      for (const cb of cbs) cb(clock.t)
    },
    frames: () => queue.size,
    clock: () => clock.t,
    fire(name) {
      for (const f of listeners[name] ?? []) f()
    },
    setVisible(v) {
      doc.visibilityState = v ? 'visible' : 'hidden'
    },
  }
}

const A = { x: 10, y: 20 }
const B = { x: 310, y: 220 }

// ── 曲线与缓动（纯函数） ────────────────────────────────────────────

console.log('\n光线曲线')

it('缓动：起落慢、中段快，0→0、1→1', () => {
  assert.equal(easeInOutCubic(0), 0)
  assert.equal(easeInOutCubic(1), 1)
  assert.equal(easeInOutCubic(0.5), 0.5)
  assert.ok(easeInOutCubic(0.1) < 0.1, '开头的 10% 里不该走完 10% 的路')
  assert.ok(easeInOutCubic(0.9) > 0.9, '结尾的 10% 里只剩很少的路')
  let prev = -1
  for (let i = 0; i <= 100; i++) {
    const v = easeInOutCubic(i / 100)
    assert.ok(v >= prev, `缓动必须单调：t=${i / 100} 处倒退了`)
    prev = v
  }
})

it('种子：同一串永远同一个数，不同串不一样', () => {
  assert.equal(seedOf('turn:t1'), seedOf('turn:t1'))
  assert.notEqual(seedOf('turn:t1'), seedOf('turn:t2'))
})

it('同一次飞行：同种子同路径；换事件换弧线', () => {
  const a = curvePoints(A, B, seedOf('step:abc'))
  const b = curvePoints(A, B, seedOf('step:abc'))
  assert.equal(curveD(a), curveD(b))
  const c = curvePoints(A, B, seedOf('step:xyz'))
  assert.notEqual(curveD(a), curveD(c), '两个事件的弧线完全一样，等于路径不会变')
})

it('曲线端点就是源与目标：落点不靠猜', () => {
  const c = curvePoints(A, B, 12345)
  const p0 = pointOnCurve(c, 0)
  const p1 = pointOnCurve(c, 1)
  assert.ok(Math.abs(p0.x - A.x) < 1e-9 && Math.abs(p0.y - A.y) < 1e-9)
  assert.ok(Math.abs(p1.x - B.x) < 1e-9 && Math.abs(p1.y - B.y) < 1e-9)
})

it('默认 1.2 秒', () => {
  assert.equal(FLIGHT_MS, 1200)
})

// ── 层的生命周期 ────────────────────────────────────────────────────

console.log('\n光线层')

it('打一束：节点进 svg、记下语义 id、循环开始跑', () => {
  const r = rig()
  const ok = r.layer.emit({ eventId: 'turn-start:turn:1', fromId: 'model:claude', toId: 'node:turn:turn:1', from: A, to: B, color: '#c96442' })
  assert.equal(ok, true)
  assert.equal(r.svg.children.length, 1)
  assert.equal(r.frames(), 1, '有光在飞时必须排着帧')
  assert.equal(r.layer.busy(), true)
  const rec = r.layer.flights()[0]
  assert.equal(rec?.fromId, 'model:claude')
  assert.equal(rec?.toId, 'node:turn:turn:1')
  assert.equal(rec?.still, false)
  r.layer.destroy()
})

it('1.2 秒后落地：描边走满、目标补一下高亮', () => {
  const r = rig()
  const target = makeEl('div')
  r.layer.emit({ eventId: 'e1', fromId: 'anchor:t1', toId: 'node:step:s1', from: A, to: B, color: '#c96442', targetEl: target as never })
  r.step(600)
  const head = r.svg.children[0]?.children[1]
  assert.ok(head, '飞到一半时那束光还在')
  const mid = Number(head.getAttribute('stroke-dashoffset'))
  r.step(700)
  assert.equal(head.getAttribute('stroke-dashoffset'), '0', '落地时必须走满')
  assert.ok(mid > 0, '半路不该已经走满')
  assert.equal(target.classList.contains('wtx-hit'), true, '落点上要补一下')
  r.layer.destroy()
})

it('落点补光的类名可以换：别的屏不必蹭工作台的长相', () => {
  const r = rig({ hitClass: 'cl-hit' })
  const target = makeEl('div')
  r.layer.emit({ eventId: 'e1', fromId: 'trunk', toId: 'stage:0', from: A, to: B, color: '#3f6ef0', targetEl: target as never })
  r.step(1300)
  assert.equal(target.classList.contains('cl-hit'), true, '给 hitClass 就该用这个类名')
  assert.equal(target.classList.contains('wtx-hit'), false, '给了新类名就不该再补工作台那个')
  r.layer.destroy()
})

it('高亮留多久可以按屏给：关键帧比 420ms 长时必须传 hitMs', () => {
  /*
   * 右栏判断卡的 cl-form 是 0.9s。默认 420ms 摘类会把柔光切在 47% 处 ——
   * 屏幕上看着像「亮了一下就灭了」，读不出「这条判断成形了」。
   * 这里只看排出去的时长：真等 900ms 会把这条测试拖慢，而它要钉的是那个数字。
   */
  const delays: number[] = []
  /* 桩要替换全局定时器，所以先起个具名宿主；理由：Node 的 setTimeout 返回 Timeout，与浏览器签名不同 */
  const timers = globalThis as unknown as TimerHost
  const realSet = timers.setTimeout
  timers.setTimeout = (_fn: () => void, ms?: number) => {
    delays.push(ms ?? 0)
    return delays.length
  }
  try {
    const r = rig({ hitClass: 'cl-hit', hitMs: 900 })
    const target = makeEl('div')
    r.layer.emit({ eventId: 'e1', fromId: 'model:x', toId: 'point:p', from: A, to: B, color: '#33383f', targetEl: target as never })
    r.step(1300)
    assert.equal(target.classList.contains('cl-hit'), true, '落地时补上')
    assert.deepEqual(delays, [900], '摘类要等满 900ms，不是默认的 420')
    r.layer.destroy()

    /* 不传就用工作台的 420：那边 wtx-hit 正好 0.42s，两边都不必再声明一次 */
    delays.length = 0
    const d = rig()
    const t2 = makeEl('div')
    d.layer.emit({ eventId: 'e2', fromId: 'model:x', toId: 'node:t', from: A, to: B, color: '#33383f', targetEl: t2 as never })
    d.step(1300)
    assert.deepEqual(delays, [420], '默认仍是 420')
    d.layer.destroy()
  } finally {
    timers.setTimeout = realSet
  }
})

it('weight 放大整束光：长途那条不能细成一道划痕', () => {
  const r = rig()
  r.layer.emit({ eventId: 'rail:r3:p:model:chatgpt', fromId: 'model:chatgpt', toId: 'point:p', from: A, to: B, color: '#5aa9e6', weight: 2.2 })
  const g = r.svg.children[0]
  assert.ok(g, '光必须画出来')
  const trail = g.children[0]
  const head = g.children[1]
  const dot = g.children[3]
  assert.equal(Number(trail.getAttribute('stroke-width')).toFixed(2), '2.42')
  assert.equal(Number(head.getAttribute('stroke-width')).toFixed(2), '3.74')
  assert.equal(Number(dot.getAttribute('r')).toFixed(2), '5.72')
  r.layer.destroy()
})

it('不给 weight 就还是工作台那套粗细', () => {
  const r = rig()
  r.layer.emit({ eventId: 'e1', fromId: 'model:x', toId: 'node:t', from: A, to: B, color: '#33383f' })
  const trail = r.svg.children[0]?.children[0]
  assert.equal(trail?.getAttribute('stroke-width'), '1.10')
  r.layer.destroy()
})

it('飞完就停帧：没有光了不排帧', () => {
  const r = rig()
  r.layer.emit({ eventId: 'e1', fromId: 'model:x', toId: 'node:turn:t', from: A, to: B, color: '#33383f' })
  r.step(1200)
  r.step(200)
  assert.equal(r.svg.children.length, 0)
  assert.equal(r.layer.busy(), false)
  assert.equal(r.frames(), 0, '空闲还在排帧，就是在拿电池换什么都不做')
  r.layer.destroy()
})

it('页面藏起来：冻结，不排帧；回来接着飞，不一次画完', () => {
  const r = rig()
  r.layer.emit({ eventId: 'e1', fromId: 'model:x', toId: 'node:turn:t', from: A, to: B, color: '#33383f' })
  r.step(300)
  r.setVisible(false)
  r.fire('visibilitychange')
  assert.equal(r.frames(), 0, '藏起来就不该再排帧')
  assert.equal(r.layer.busy(), true, '光还在，只是冻住')
  // 藏着的十分钟不该算进飞行时间
  r.step(600_000)
  r.setVisible(true)
  r.fire('visibilitychange')
  assert.equal(r.frames(), 1, '回来要接着飞')
  r.step(901)
  assert.equal(r.svg.children.length, 1, '刚回来就落地说明冻结没生效（过站了）')
  r.layer.destroy()
})

it('尊重 prefers-reduced-motion：不飞，只留一条静止的线', () => {
  const r = rig({ reduceMotion: true })
  r.layer.emit({ eventId: 'e1', fromId: 'model:x', toId: 'node:turn:t', from: A, to: B, color: '#2f6feb' })
  assert.equal(r.layer.busy(), false, '降级时不该有在飞的')
  assert.equal(r.frames(), 0, '降级时不该有帧循环')
  assert.equal(r.svg.children[0]?.getAttribute('class'), 'lg-flight still')
  assert.equal(r.layer.flights()[0]?.still, true)
  r.layer.destroy()
})

it('销毁：节点清空、监听摘掉、再打也不画', () => {
  const r = rig()
  r.layer.emit({ eventId: 'e1', fromId: 'model:x', toId: 'node:t', from: A, to: B, color: '#33383f' })
  r.layer.destroy()
  assert.equal(r.svg.children.length, 0)
  assert.equal(r.layer.busy(), false)
  assert.equal(r.frames(), 0)
  assert.equal(r.layer.emit({ eventId: 'e2', fromId: 'model:x', toId: 'node:t', from: A, to: B, color: '#33383f' }), false)
  // 监听摘了：再触发 hidden 也不该抛
  r.setVisible(false)
  r.fire('visibilitychange')
})

it('日志留最近的那些：诊断只认语义 id 和落点', () => {
  const r = rig({ reduceMotion: true })
  for (let i = 0; i < 30; i++) {
    r.layer.emit({ eventId: `e${i}`, fromId: 'model:x', toId: `node:n${i}`, from: A, to: B, color: '#33383f' })
  }
  const log = r.layer.flights()
  assert.equal(log.length, 24)
  assert.equal(log[log.length - 1]?.eventId, 'e29')
  r.layer.destroy()
})

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail) process.exit(1)
