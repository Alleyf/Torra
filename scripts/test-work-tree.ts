/**
 * 会话工作树的离线契约。
 *
 * 这棵树最容易错在三个地方，界面上一时半会儿还看不出来：
 *
 * 1. **关系怎么来的**。只能靠 session / turnId / itemId 这三种稳定 id 连。
 *    按「最近出现的那个节点」或坐标去猜，在并行分支上一定猜错，而且错了不报错 ——
 *    光会飞到别人家那一步上，看着还挺顺。这里断言每条边的两端都在节点表里、
 *    每个 parentId 都是显式写出来的。
 * 2. **什么时候算「连回了父亲」**。只有真的完成才写 mergeInto。跑着的、失败的不写 ——
 *    写上去等于替它宣称交付过了。
 * 3. **重算不能有副作用**。同一份账本推两次必须完全一样；否则重渲染会让节点换位置，
 *    甚至让「新节点」凭空多出来，光就会重放。
 *
 * 运行：npm run test:work-tree
 */

import assert from 'node:assert/strict'
import {
  NODE_W,
  buildWorkTree,
  demoTrees,
  diffNodes,
  layoutTrees,
  planFlights,
  type WorkTree,
} from '../src/renderer/workTree'
import type { HostItem } from '../src/shared/host'

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

const META = { id: 's1', title: '把构建跑一遍', agentId: 'claude', updatedAt: 1 }

/** 一轮里：两个并列步骤（分叉）、一段正文、一个带改动的步骤，外加一条不属于任何一轮的通知 */
const ITEMS: HostItem[] = [
  { id: 1, kind: 'message', role: 'user', turnId: 't1', text: '把构建跑一遍' },
  { id: 2, kind: 'tool', turnId: 't1', itemId: 'run-build', title: 'npm run build', status: 'completed' },
  { id: 3, kind: 'tool', turnId: 't1', itemId: 'run-test', title: 'npm test', status: 'in_progress' },
  { id: 4, kind: 'message', role: 'agent', turnId: 't1', text: '两个断言失败，我修一下。后面还有一句不该进结论。' },
  {
    id: 5,
    kind: 'tool',
    turnId: 't1',
    itemId: 'fix-a',
    title: 'edit src/a.ts',
    status: 'completed',
    edits: [{ path: 'src/a.ts', oldText: 'a\nb', newText: 'a\nc' }],
  },
  { id: 6, kind: 'notice', text: '上下文接近上限' },
  { id: 7, kind: 'message', role: 'user', turnId: 't2', text: '好了吗' },
]

const tree = () => buildWorkTree(META, ITEMS, { liveTurnId: 't1' })
const nodeOf = (t: WorkTree, id: string) => t.nodes.find((n) => n.id === id)

// ── 连接只认稳定 id ────────────────────────────────────────────────

console.log('\n节点的身份')

it('会话是根，轮挂在会话下，步骤挂在轮下 —— 全是显式 id', () => {
  const t = tree()
  assert.equal(t.nodes[0]?.id, 'session:s1')
  assert.equal(t.nodes[0]?.parentId, null)
  assert.equal(nodeOf(t, 'turn:t1')?.parentId, 'session:s1')
  assert.equal(nodeOf(t, 'step:run-build')?.parentId, 'turn:t1')
  assert.equal(nodeOf(t, 'step:run-test')?.parentId, 'turn:t1')
})

it('没有轮号的条目（notice）不进树：不替它编一个父亲', () => {
  const t = tree()
  assert.equal(t.nodes.some((n) => n.label.includes('上下文')), false)
  assert.equal(t.nodes.length, 7, `期望 1 根 + 2 轮 + 3 步 + 1 交付，实际 ${t.nodes.length}`)
})

it('每条边的两端都在节点表里，每个父节点都是写出来的', () => {
  const t = tree()
  const ids = new Set(t.nodes.map((n) => n.id))
  for (const n of t.nodes) {
    if (n.parentId) assert.ok(ids.has(n.parentId), `${n.id} 的父节点 ${n.parentId} 不在表里`)
    if (n.mergeInto) assert.ok(ids.has(n.mergeInto), `${n.id} 的合流目标 ${n.mergeInto} 不在表里`)
  }
})

it('同一份账本推两次，结果一模一样', () => {
  assert.deepEqual(tree(), tree())
})

// ── 完成才合流 ─────────────────────────────────────────────────────

console.log('\n分支与合流')

it('跑着的步骤不写合流；完成的步骤才连回它那一轮', () => {
  const t = tree()
  assert.equal(nodeOf(t, 'step:run-build')?.mergeInto, 'turn:t1')
  assert.equal(nodeOf(t, 'step:run-test')?.mergeInto, undefined)
  assert.equal(nodeOf(t, 'step:run-test')?.status, 'running')
})

it('一轮跑完才连回会话；还在跑的那一轮不连', () => {
  const settled = buildWorkTree(META, ITEMS, { liveTurnId: null })
  assert.equal(nodeOf(settled, 'turn:t1')?.mergeInto, 'session:s1')
  assert.equal(nodeOf(settled, 'turn:t2')?.mergeInto, 'session:s1')

  const running = buildWorkTree(META, ITEMS, { liveTurnId: 't2' })
  assert.equal(nodeOf(running, 'turn:t1')?.mergeInto, 'session:s1')
  assert.equal(nodeOf(running, 'turn:t2')?.mergeInto, undefined)
  assert.equal(nodeOf(running, 'turn:t2')?.status, 'running')
})

it('失败了就标失败，也不冒充合流', () => {
  const bad: HostItem[] = [
    { id: 1, kind: 'message', role: 'user', turnId: 't1', text: '跑一下' },
    { id: 2, kind: 'tool', turnId: 't1', itemId: 'boom', title: 'npm test', status: 'failed' },
  ]
  const t = buildWorkTree(META, bad, { liveTurnId: 't1' })
  const n = nodeOf(t, 'step:boom')
  assert.equal(n?.status, 'failed')
  assert.equal(n?.mergeInto, undefined)
})

// ── 交付 ───────────────────────────────────────────────────────────

console.log('\n交付节点')

it('有改动的轮长出一个交付节点：结论取第一句，文件按路径去重', () => {
  const withTwo: HostItem[] = [
    ...ITEMS,
    {
      id: 8,
      kind: 'tool',
      turnId: 't1',
      itemId: 'fix-a2',
      title: 'edit src/a.ts again',
      status: 'completed',
      edits: [{ path: 'src/a.ts', oldText: 'a\nc\nd', newText: 'a\nc\ne' }],
    },
  ]
  const t = buildWorkTree(META, withTwo, { liveTurnId: 't1' })
  const d = nodeOf(t, 'deliver:t1')
  assert.ok(d, '带改动的轮必须长出交付节点')
  assert.equal(d.parentId, 'turn:t1')
  assert.equal(d.detail, '两个断言失败，我修一下。')
  assert.equal(d.files?.length, 1, '同一个文件改两次只留一张卡')
  assert.equal(d.files?.[0]?.path, 'src/a.ts')
})

it('没改动就没有交付节点：不能凭空造一张文件卡', () => {
  const t = buildWorkTree(META, [ITEMS[0]!, ITEMS[5]!], {})
  assert.equal(t.nodes.some((n) => n.kind === 'delivery'), false)
})

it('交付文件卡带上增删行数', () => {
  const d = nodeOf(tree(), 'deliver:t1')
  assert.deepEqual(d?.files?.[0], { path: 'src/a.ts', added: 1, removed: 1 })
})

// ── 布局 ───────────────────────────────────────────────────────────

console.log('\n布局')

const other = () =>
  buildWorkTree({ id: 's2', title: '另一场', agentId: 'codex', updatedAt: 2 }, [
    { id: 1, kind: 'message', role: 'user', turnId: 'p1', text: '补一条参数' },
    { id: 2, kind: 'tool', turnId: 'p1', itemId: 'step-x', title: '改解析', status: 'in_progress' },
  ], { liveTurnId: 'p1' })

it('聚焦：只摆当前那一场，宽度就是它自己的宽度', () => {
  const L = layoutTrees([tree(), other()], 'focus', 's1')
  assert.equal(L.trees.length, 1)
  assert.equal(L.trees[0]?.id, 's1')
})

it('全部：每场一棵，横着排，列与列不重叠', () => {
  const L = layoutTrees([tree(), other()], 'all')
  assert.equal(L.trees.length, 2)
  const [a, b] = L.trees
  assert.ok(a && b)
  assert.ok(b.x >= a.x + a.width, '第二列压在第一列上了')
})

it('兄弟往下排、各占一整张卡：缩进一格，不压成细线', () => {
  const L = layoutTrees([tree()], 'focus', 's1')
  const placed = L.trees[0]!.nodes
  const steps = placed.filter((n) => n.parentId === 'turn:t1' && n.kind === 'step')
  assert.ok(steps.length >= 2)
  // 同父亲的兄弟：y 不同（往下排），x 相同（同一层缩进）
  for (let i = 1; i < steps.length; i++) {
    const cur = steps[i]!
    const prev = steps[i - 1]!
    assert.ok(cur.y >= prev.y + prev.h, '兄弟节点叠在一起了')
    assert.equal(cur.x, prev.x, '同一层的兄弟缩进不一致')
    assert.equal(cur.w, NODE_W, '节点被压窄了')
  }
})

it('一棵树里任意两个节点都不重叠', () => {
  const L = layoutTrees([tree()], 'focus', 's1')
  const nodes = L.trees[0]!.nodes
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!
      const b = nodes[j]!
      const apart = a.y + a.h <= b.y || b.y + b.h <= a.y || a.x + a.w <= b.x || b.x + b.w <= a.x
      assert.ok(apart, `${a.id} 与 ${b.id} 叠在一起`)
    }
  }
})

it('一列会话的宽度装得下最深的缩进：窄栏里也读得全', () => {
  const L = layoutTrees([tree()], 'focus', 's1')
  const t = L.trees[0]!
  for (const n of t.nodes) assert.ok(n.x + n.w <= t.x + t.width + 0.5, `${n.id} 超出这一列的宽度`)
})

it('下层的 y 严格大于上层：父子不会画在同一行', () => {
  const L = layoutTrees([tree()], 'focus', 's1')
  const byId = new Map(L.trees[0]!.nodes.map((n) => [n.id, n]))
  for (const n of L.trees[0]!.nodes) {
    if (!n.parentId) continue
    const p = byId.get(n.parentId)
    assert.ok(p && n.y > p.y + p.h - 1, `${n.id} 没有落在父亲下面`)
  }
})

it('边：合流的单独标出来，且每条边两端都能落到坐标', () => {
  const L = layoutTrees([tree()], 'focus', 's1')
  const byId = new Map(L.trees[0]!.nodes.map((n) => [n.id, n]))
  assert.ok(L.edges.length > 0)
  for (const e of L.edges) {
    assert.ok(byId.has(e.from), `边的起点 ${e.from} 没有坐标`)
    assert.ok(byId.has(e.to), `边的终点 ${e.to} 没有坐标`)
  }
  assert.ok(L.edges.some((e) => e.merge), '完成的节点应当有一条合流边')
  assert.equal(L.edges.filter((e) => e.merge).every((e) => byId.get(e.to)?.status !== undefined), true)
})

// ── 差与光线计划 ───────────────────────────────────────────────────

console.log('\n差与光线')

it('重新推一遍不算事件：没有新增、没有状态变化', () => {
  const d = diffNodes(tree().nodes, tree().nodes)
  assert.equal(d.added.length, 0)
  assert.equal(d.finished.length + d.failed.length, 0)
})

it('新步骤算新增；跑完算完成', () => {
  const before = buildWorkTree(META, ITEMS.slice(0, 2), { liveTurnId: 't1' })
  const after = buildWorkTree(META, ITEMS.slice(0, 3), { liveTurnId: 't1' })
  const d = diffNodes(before.nodes, after.nodes)
  assert.equal(d.added.length, 1)
  assert.equal(d.added[0]?.id, 'step:run-test')

  const done = buildWorkTree(META, [
    ITEMS[0]!,
    { ...(ITEMS[2] as Extract<HostItem, { kind: 'tool' }>), status: 'completed' },
  ], { liveTurnId: 't1' })
  const d2 = diffNodes(after.nodes, done.nodes)
  assert.equal(d2.finished.some((n) => n.id === 'step:run-test'), true)
})

it('光线：新轮从模型图标出发，新步骤从那一轮的气泡出发', () => {
  const before = buildWorkTree(META, [], {})
  const after = tree()
  const d = diffNodes(before.nodes, after.nodes)
  const plans = planFlights(d, [after], 'claude')
  const turn = plans.find((p) => p.toId === 'node:turn:t1')
  assert.equal(turn?.fromId, 'model:claude')
  const step = plans.find((p) => p.toId === 'node:step:run-build')
  assert.equal(step?.fromId, 'anchor:t1', '步骤的光要从它那一轮的气泡起飞')
  assert.equal(step?.kind, 'new')
})

it('交付有自己的 kind：跟普通步骤区分得开', () => {
  const before = buildWorkTree(META, ITEMS.filter((i) => !(i.kind === 'tool' && i.edits)), { liveTurnId: 't1' })
  const after = tree()
  const plans = planFlights(diffNodes(before.nodes, after.nodes), [after], 'claude')
  assert.equal(plans.some((p) => p.kind === 'delivery' && p.toId === 'node:deliver:t1'), true)
})

it('完成时打一条合流光；失败时打一条失败光', () => {
  const run = buildWorkTree(META, [ITEMS[0]!, ITEMS[2]!], { liveTurnId: 't1' })
  const done = buildWorkTree(META, [
    ITEMS[0]!,
    { ...(ITEMS[2] as Extract<HostItem, { kind: 'tool' }>), status: 'completed' },
  ], {})
  const plans = planFlights(diffNodes(run.nodes, done.nodes), [done], 'claude')
  const merge = plans.find((p) => p.fromId === 'node:step:run-test')
  assert.equal(merge?.kind, 'done')
  assert.equal(merge?.toId, 'node:turn:t1')

  const failed = buildWorkTree(META, [
    ITEMS[0]!,
    { ...(ITEMS[2] as Extract<HostItem, { kind: 'tool' }>), status: 'failed' },
  ], {})
  const fp = planFlights(diffNodes(run.nodes, failed.nodes), [failed], 'claude')
  assert.equal(fp.some((p) => p.kind === 'fail'), true)
})

it('一轮里冒出太多步骤：光最多六条', () => {
  const many: HostItem[] = [
    { id: 1, kind: 'message', role: 'user', turnId: 't1', text: '一起跑' },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: i + 2,
      kind: 'tool' as const,
      turnId: 't1',
      itemId: `s${i}`,
      title: `步骤 ${i}`,
      status: 'in_progress',
    })),
  ]
  const t = buildWorkTree(META, many, { liveTurnId: 't1' })
  const plans = planFlights(diffNodes([], t.nodes), [t], 'claude')
  assert.equal(plans.length, 6)
})

// ── 演示数据 ───────────────────────────────────────────────────────

console.log('\n演示数据')

it('演示树标着 demo，不冒充真跑过', () => {
  const demo = demoTrees(1)
  assert.ok(demo.length >= 2, '并行会话至少要两棵')
  for (const t of demo) {
    assert.equal(t.demo, true)
    assert.equal(t.nodes.every((n) => n.demo === true), true)
  }
})

it('演示里分叉、孙分支、合流三样都有', () => {
  const demo = demoTrees(1)
  const all = demo.flatMap((t) => t.nodes)
  // 分叉：同一父亲下至少两个兄弟
  const byParent = new Map<string, number>()
  for (const n of all) if (n.parentId) byParent.set(n.parentId, (byParent.get(n.parentId) ?? 0) + 1)
  assert.ok([...byParent.values()].some((c) => c >= 2), '没有分叉')
  // 孙分支：父亲的父亲还在
  const ids = new Map(all.map((n) => [n.id, n]))
  assert.ok(all.some((n) => n.parentId && ids.get(n.parentId)?.parentId), '没有孙分支')
  // 合流
  assert.ok(all.some((n) => n.mergeInto), '没有合流')
})

it('演示树摆出来也不重叠', () => {
  const L = layoutTrees(demoTrees(1), 'all')
  assert.equal(L.trees.length >= 2, true)
  for (let i = 1; i < L.trees.length; i++) {
    const prev = L.trees[i - 1]!
    const cur = L.trees[i]!
    assert.ok(cur.x >= prev.x + prev.width)
  }
})

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail) process.exit(1)
