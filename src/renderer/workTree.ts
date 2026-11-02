/**
 * 会话工作树：把一场编码会话的账本画成树。
 *
 * 这棵树是**投影**，不是第二份数据。节点全部由 HostItem 推导出来：
 * 会话是根，轮（turnId）是第二层，步骤（itemId）是第三层，带改动的轮长出一个交付节点。
 * 不另存一份 `tree.json` —— 两份真源迟早分叉，而分叉之后被当成「事实」的
 * 往往是旧的那份（用户看到的就不是 agent 那边真正发生过的事）。
 *
 * 连接只认三种稳定 id：会话 id、turnId、itemId。
 * 不按「最近的那个节点」「坐标离得近」去猜父子 —— 猜出来的关系在并行分支上
 * 一定是错的，而错了没有任何东西会报错。
 *
 * 分支与合并同样落在数据上：`mergeInto` 是显式字段，只有「真的完成」才写上。
 * 还在跑的、失败的分支不往回连 —— 画一条回连线等于宣称它交付过了。
 */

import type { HostItem } from '../shared/host'

export type WorkNodeKind = 'session' | 'turn' | 'step' | 'delivery'
export type WorkStatus = 'running' | 'done' | 'failed'

/** 交付里的一张文件卡 */
export interface WorkFile {
  path: string
  added: number
  removed: number
}

export interface WorkNode {
  /** 语义 id：`session:<会话 id>` / `turn:<turnId>` / `step:<itemId>` / `deliver:<turnId>` */
  id: string
  kind: WorkNodeKind
  parentId: string | null
  /**
   * 完成后连回哪个节点。
   *
   * 只有「真的完成」才写。跑着的和失败的不写 —— 那两种都不是交付。
   */
  mergeInto?: string
  label: string
  status: WorkStatus
  /** 属于哪一场（颜色按这一场里的 agent 定） */
  treeId: string
  agentId: string
  /**
   * 正文里的锚，用来把光线落到气泡上。
   *
   * 轮是 turnId，步骤是账本里的序号（HostItem.id）。渲染层把这两个值原样写进
   * `data-wtx-turn` / `data-wtx-item`，取源点时按属性查，不按 DOM 次序认人。
   */
  anchor?: string
  /** 交付的结论：那一轮最后一段 agent 正文 */
  detail?: string
  files?: WorkFile[]
  /** 演示数据：界面上要挂「演示」标记，不许冒充真跑过 */
  demo?: boolean
}

export interface WorkTree {
  /** 会话 id（根节点的 treeId） */
  id: string
  title: string
  agentId: string
  nodes: WorkNode[]
  updatedAt: number
  demo?: boolean
}

export interface BuildOpts {
  /** 当前正在跑的那一轮；null / 不给 = 没有在跑 */
  liveTurnId?: string | null
  /** 这一场出过事（进程退了、连接断了）：还在跑的节点标成 failed */
  faulted?: boolean
  demo?: boolean
}

/** 步骤状态：协议那边的词各家不同，这里只认三类 */
export function stepStatus(raw: string | undefined, turnRunning: boolean): WorkStatus {
  const s = (raw ?? '').toLowerCase()
  if (/fail|error|cancel|reject|abort/.test(s)) return 'failed'
  // 「还在跑」只在那一轮真的还在跑时成立。轮已经收尾了还挂着 in_progress，
  // 是账本里没补完的一步 —— 照实画成 done，比留一个永远转的圈好
  if (/run|start|pending|progress/.test(s)) return turnRunning ? 'running' : 'done'
  if (!s) return turnRunning ? 'running' : 'done'
  return 'done'
}

/** 一行正文压成一个能放进窄节点的标签 */
export function clip(text: string, max = 22): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  return `${one.slice(0, max - 1)}…`
}

/** 一句话的结论：取第一句，去掉多余空白 */
export function conclusionOf(text: string, max = 80): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!one) return ''
  const stop = one.search(/[。！？!?；;]/)
  const first = stop >= 0 ? one.slice(0, stop + 1) : one
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`
}

/**
 * 从账本推出一棵树。
 *
 * 顺序按账本来（只增不改），所以同一份账本推两次结果完全一样 ——
 * 界面重渲染不会让节点换位置，也不会让「新节点」凭空多出一个。
 */
export function buildWorkTree(
  meta: { id: string; title: string; agentId: string; updatedAt?: number },
  items: HostItem[],
  opts: BuildOpts = {},
): WorkTree {
  const treeId = meta.id
  const liveTurnId = opts.liveTurnId ?? null
  const faulted = !!opts.faulted
  const rootId = `session:${treeId}`

  const turnIds: string[] = []
  const turnLabel = new Map<string, string>()
  const turnLastSay = new Map<string, string>()
  const turnFiles = new Map<string, Map<string, WorkFile>>()
  const steps: WorkNode[] = []
  const turnRunning = new Map<string, boolean>()

  for (const it of items) {
    // notice / tally 这类不属于任何一轮的条目，不进树：没有轮号就没有父亲，
    // 硬塞一个「最近那一轮」等于替它编关系
    if (!('turnId' in it)) continue
    if (!turnIds.includes(it.turnId)) {
      turnIds.push(it.turnId)
      turnRunning.set(it.turnId, !liveTurnId ? false : it.turnId === liveTurnId)
    }
    if (it.kind === 'message' && it.role === 'user' && !turnLabel.has(it.turnId)) {
      turnLabel.set(it.turnId, clip(it.text))
    }
    if (it.kind === 'message' && it.role === 'agent') {
      turnLastSay.set(it.turnId, it.text)
    }
    if (it.kind === 'tool') {
      const status = stepStatus(it.status, turnRunning.get(it.turnId) ?? false)
      const node: WorkNode = {
        id: `step:${it.itemId}`,
        kind: 'step',
        parentId: `turn:${it.turnId}`,
        label: clip(it.title || it.name || '工具调用', 20),
        status,
        treeId,
        agentId: meta.agentId,
        anchor: String(it.id),
        ...(status === 'done' ? { mergeInto: `turn:${it.turnId}` } : {}),
        ...(opts.demo ? { demo: true } : {}),
      }
      steps.push(node)
      if (it.edits?.length) {
        const byPath = turnFiles.get(it.turnId) ?? new Map<string, WorkFile>()
        for (const e of it.edits) {
          const stat = countDelta(e.oldText, e.newText)
          byPath.set(e.path, { path: e.path, ...stat })
        }
        turnFiles.set(it.turnId, byPath)
      }
    }
  }

  const nodes: WorkNode[] = [
    {
      id: rootId,
      kind: 'session',
      parentId: null,
      label: clip(meta.title || '会话', 24),
      /*
       * 会话根不标「正在跑」。
       *
       * 它在跑是事实，但把流动边框也套到根上，一屏就会同时亮三圈
       * （根、这一轮、这一步），最想看的那一步反而被稀释了。
       * 忙不忙由「正在跑的那一轮」说；根只在出事时升成失败。
       */
      status: faulted ? 'failed' : 'done',
      treeId,
      agentId: meta.agentId,
      ...(opts.demo ? { demo: true } : {}),
    },
  ]

  turnIds.forEach((turnId, i) => {
    const running = !faulted && turnId === liveTurnId
    const status: WorkStatus = faulted && turnId === liveTurnId ? 'failed' : running ? 'running' : 'done'
    nodes.push({
      id: `turn:${turnId}`,
      kind: 'turn',
      parentId: rootId,
      label: turnLabel.get(turnId) || `第 ${i + 1} 轮`,
      status,
      treeId,
      agentId: meta.agentId,
      anchor: turnId,
      ...(status === 'done' ? { mergeInto: rootId } : {}),
      ...(opts.demo ? { demo: true } : {}),
    })
    for (const s of steps) if (s.parentId === `turn:${turnId}`) nodes.push(s)

    const files = turnFiles.get(turnId)
    if (files && files.size) {
      const say = turnLastSay.get(turnId) ?? ''
      nodes.push({
        id: `deliver:${turnId}`,
        kind: 'delivery',
        parentId: `turn:${turnId}`,
        label: '交付',
        status,
        treeId,
        agentId: meta.agentId,
        files: [...files.values()],
        ...(conclusionOf(say) ? { detail: conclusionOf(say) } : {}),
        ...(status === 'done' ? { mergeInto: `turn:${turnId}` } : {}),
        ...(opts.demo ? { demo: true } : {}),
      })
    }
  })

  return {
    id: treeId,
    title: meta.title || '会话',
    agentId: meta.agentId,
    nodes,
    updatedAt: meta.updatedAt ?? 0,
    ...(opts.demo ? { demo: true } : {}),
  }
}

/** 增删行：按内容重数算，跟 acpLines 的 diffStat 同一口径（这里不重复实现，保持简单版） */
function countDelta(oldText: string, newText: string): { added: number; removed: number } {
  const split = (s: string): string[] => (s ? s.split('\n') : [])
  const a = split(oldText)
  const b = split(newText)
  const before = new Map<string, number>()
  const after = new Map<string, number>()
  for (const l of a) before.set(l, (before.get(l) ?? 0) + 1)
  for (const l of b) after.set(l, (after.get(l) ?? 0) + 1)
  let added = 0
  let removed = 0
  for (const [l, n] of after) added += Math.max(0, n - (before.get(l) ?? 0))
  for (const [l, n] of before) removed += Math.max(0, n - (after.get(l) ?? 0))
  return { added, removed }
}

// ── 布局 ───────────────────────────────────────────────────────────

/**
 * 节点的尺寸与间距。
 *
 * 摆法是**缩进式竖向树**：深度往右缩进，兄弟往下排。
 *
 * 为什么不是「同一层横着铺开」：那样一列里有三个兄弟，行宽就是三张卡片，
 * 而右栏只有三百来像素 —— 于是每三五个步骤就得横向滚一次，滚完之后
 * 会话根被推出左边界，只剩半截标签。竖向摆的话，深度最多四层、
 * 每层只缩进一格，一张卡片宽就够；历史长了往下滚，那才是真的「长」。
 * 分支仍然各占一整张卡（不缩成细线），只是方向从横改成了竖。
 */
export const NODE_W = 176
export const NODE_H = 34
export const DELIVERY_H = 78
export const INDENT = 15
export const ROW_GAP = 12
export const TREE_MIN_W = 212
/** 合流那条回弯要绕出去的宽度：不留这一格，虚线会被画布右边裁掉 */
export const MERGE_GUTTER = 16
export const TREE_GAP = 22
export const PAD = 10

export interface PlacedNode extends WorkNode {
  x: number
  y: number
  w: number
  h: number
  /** 这一节点在第几层（缩进格数），连线用它画竖干 */
  depth: number
}

export interface Edge {
  id: string
  from: string
  to: string
  /** 完成后连回父节点的那一条：画成虚线回弯 */
  merge: boolean
  treeId: string
}

export interface PlacedTree {
  id: string
  x: number
  width: number
  height: number
  nodes: PlacedNode[]
}

export interface Layout {
  width: number
  height: number
  trees: PlacedTree[]
  edges: Edge[]
}

function heightOf(n: WorkNode): number {
  return n.kind === 'delivery' ? DELIVERY_H : NODE_H
}

/**
 * 摆树。纯函数：同一份树，摆出来的坐标永远一样。
 *
 * 一棵会话占一列；列内按深度优先的次序往下排，每深一层右缩一格。
 * 多会话（「全部」）横向并排，总宽超出就横向滚 —— 横向滚动留给会话数，
 * 不再用来装一个会话里的兄弟。
 */
export function layoutTrees(trees: WorkTree[], mode: 'focus' | 'all', focusId?: string): Layout {
  const picked = mode === 'focus' ? trees.filter((t) => t.id === focusId).slice(0, 1) : trees
  const placedTrees: PlacedTree[] = []
  const edges: Edge[] = []
  let cursorX = PAD
  let maxH = PAD * 2

  for (const t of picked) {
    const nodes = t.nodes
    const byId = new Map(nodes.map((n) => [n.id, n]))
    /** 每个节点的深度 / 孩子表 / DFS 次序 */
    const depthOf = new Map<string, number>()
    const kids = new Map<string, WorkNode[]>()
    const order: WorkNode[] = []
    const seen = new Set<string>()

    const depthOfNode = (n: WorkNode): number => {
      let d = 0
      let p = n.parentId
      let guard = 0
      while (p && byId.has(p) && guard++ < 32) {
        d += 1
        p = byId.get(p)?.parentId ?? null
      }
      return d
    }

    const walk = (n: WorkNode): void => {
      if (seen.has(n.id)) return
      seen.add(n.id)
      order.push(n)
      depthOf.set(n.id, depthOfNode(n))
      for (const c of nodes) {
        if (c.parentId === n.id) {
          const arr = kids.get(n.id) ?? []
          arr.push(c)
          kids.set(n.id, arr)
          walk(c)
        }
      }
    }
    for (const n of nodes) if (!n.parentId) walk(n)
    // 父亲不在表里的（不该有，但别让它凭空消失）：当成根补在后面
    for (const n of nodes) if (!seen.has(n.id)) walk(n)

    let maxDepth = 0
    for (const d of depthOf.values()) maxDepth = Math.max(maxDepth, d)
    const treeW = Math.max(TREE_MIN_W, PAD * 2 + maxDepth * INDENT + NODE_W + MERGE_GUTTER)

    const placed: PlacedNode[] = []
    let y = PAD
    for (const n of order) {
      const depth = depthOf.get(n.id) ?? 0
      const h = heightOf(n)
      placed.push({ ...n, x: cursorX + PAD + depth * INDENT, y, w: NODE_W, h, depth })
      y += h + ROW_GAP
    }
    const treeH = Math.max(0, y - ROW_GAP + PAD)

    for (const n of nodes) {
      if (n.parentId && byId.has(n.parentId)) {
        edges.push({ id: `${n.parentId}->${n.id}`, from: n.parentId, to: n.id, merge: !!n.mergeInto, treeId: t.id })
      }
      // 收口到一个不是父节点的节点（跨层合并）：这条关系没有别的线能代表，单独画
      if (n.mergeInto && n.mergeInto !== n.parentId && byId.has(n.mergeInto)) {
        edges.push({ id: `${n.id}=>${n.mergeInto}`, from: n.id, to: n.mergeInto, merge: true, treeId: t.id })
      }
    }
    placedTrees.push({ id: t.id, x: cursorX, width: treeW, height: treeH, nodes: placed })
    cursorX += treeW + TREE_GAP
    maxH = Math.max(maxH, treeH)
  }

  return {
    width: Math.max(PAD * 2, cursorX - TREE_GAP + PAD),
    height: maxH,
    trees: placedTrees,
    edges,
  }
}

// ── 节点差：只有「新长出来的」和「状态变了」才该发光 ────────────────

export interface NodeDiff {
  added: WorkNode[]
  finished: WorkNode[]
  failed: WorkNode[]
  removed: string[]
}

/**
 * 比两份节点表。
 *
 * 光线只认这个差 —— 重新推一遍树（比如窗口重渲染）不该再放一遍光，
 * 切会话、读历史更不该。所以「有差」和「有事件」必须分开：差是事实，
 * 只有真的在跑的那一场，差才被当成事件。
 */
export function diffNodes(prev: WorkNode[], next: WorkNode[]): NodeDiff {
  const old = new Map(prev.map((n) => [n.id, n]))
  const added: WorkNode[] = []
  const finished: WorkNode[] = []
  const failed: WorkNode[] = []
  for (const n of next) {
    const was = old.get(n.id)
    if (!was) {
      added.push(n)
      continue
    }
    if (was.status !== n.status) {
      if (n.status === 'done') finished.push(n)
      if (n.status === 'failed') failed.push(n)
    }
  }
  const now = new Set(next.map((n) => n.id))
  const removed = prev.filter((n) => !now.has(n.id)).map((n) => n.id)
  return { added, finished, failed, removed }
}

// ── 光线的起飞计划 ─────────────────────────────────────────────────

export type FlightKind = 'new' | 'done' | 'fail' | 'delivery'

export interface FlightPlan {
  /** 稳定事件 id（同一件事重放不会得到第二个 id） */
  eventId: string
  /** 起点：`model:<agentId>` / `anchor:<turnId>` / `node:<节点 id>` */
  fromId: string
  /** 终点：`node:<节点 id>` */
  toId: string
  kind: FlightKind
  treeId: string
  agentId: string
}

/**
 * 把一次节点差翻成几条光线。
 *
 * 上限六条：一轮里同时冒出十个步骤时，十条光一起飞只会糊成一团，
 * 「哪一步刚发生」反而看不清。多出来的那条由节点自己的状态说明。
 */
export function planFlights(diff: NodeDiff, trees: WorkTree[], agentId: string, max = 6): FlightPlan[] {
  const plans: FlightPlan[] = []
  const parentOf = new Map<string, string | null>()
  const anchorOf = new Map<string, string>()
  const treeOf = new Map<string, string>()
  for (const t of trees) {
    for (const n of t.nodes) {
      parentOf.set(n.id, n.parentId)
      if (n.anchor) anchorOf.set(n.id, n.anchor)
      treeOf.set(n.id, t.id)
    }
  }
  const turnAnchor = (nodeId: string): string | undefined => {
    const p = parentOf.get(nodeId)
    return p ? anchorOf.get(p) : undefined
  }

  for (const n of diff.added) {
    if (plans.length >= max) break
    const treeId = treeOf.get(n.id) ?? n.treeId
    if (n.kind === 'turn') {
      plans.push({ eventId: `turn-start:${n.id}`, fromId: `model:${agentId}`, toId: `node:${n.id}`, kind: 'new', treeId, agentId })
    } else if (n.kind === 'step' || n.kind === 'delivery') {
      const a = turnAnchor(n.id)
      plans.push({
        eventId: `${n.kind}:${n.id}`,
        fromId: a ? `anchor:${a}` : `model:${agentId}`,
        toId: `node:${n.id}`,
        kind: n.kind === 'delivery' ? 'delivery' : 'new',
        treeId,
        agentId,
      })
    }
  }
  for (const n of diff.finished) {
    if (plans.length >= max) break
    if (!n.mergeInto) continue
    plans.push({
      eventId: `merge:${n.id}`,
      fromId: `node:${n.id}`,
      toId: `node:${n.mergeInto}`,
      kind: 'done',
      treeId: treeOf.get(n.id) ?? n.treeId,
      agentId,
    })
  }
  for (const n of diff.failed) {
    if (plans.length >= max) break
    const up = n.mergeInto ?? n.parentId
    if (!up) continue
    plans.push({
      eventId: `fail:${n.id}`,
      fromId: `node:${n.id}`,
      toId: `node:${up}`,
      kind: 'fail',
      treeId: treeOf.get(n.id) ?? n.treeId,
      agentId,
    })
  }
  return plans
}

// ── 演示数据 ───────────────────────────────────────────────────────

/**
 * 演示树：分叉、孙分支、并行会话、合并。
 *
 * 为什么需要它：真实的 ACP 一场只挂一家，Torra 今天也还没有子 agent 的嵌套事件，
 * 所以「孙分支」「并行会话」这两档在真数据里造不出来。可它们正是这棵树最容易画错的地方
 * （兄弟挤成一条线、合并连错父节点），不能不验。这里给一份标了 demo 的，
 * 界面上必须挂「演示」二字 —— 演示数据冒充真跑过，比没有演示更坏。
 */
export function demoTrees(now = 0): WorkTree[] {
  const mk = (
    id: string,
    title: string,
    agentId: string,
    nodes: Array<Partial<WorkNode> & { id: string; kind: WorkNodeKind; parentId: string | null; label: string }>,
  ): WorkTree => ({
    id,
    title,
    agentId,
    demo: true,
    updatedAt: now,
    nodes: nodes.map((n) => ({
      status: 'done',
      treeId: id,
      agentId,
      demo: true,
      ...n,
    })) as WorkNode[],
  })

  return [
    mk('demo-branch', '演示 · 分叉与孙分支', 'claude', [
      { id: 'session:demo-branch', kind: 'session', parentId: null, label: '演示 · 分叉', status: 'done' },
      { id: 'turn:t1', kind: 'turn', parentId: 'session:demo-branch', label: '拆一下这个仓库', mergeInto: 'session:demo-branch', anchor: 't1' },
      { id: 'step:a', kind: 'step', parentId: 'turn:t1', label: '读依赖清单', mergeInto: 'turn:t1', anchor: 'a' },
      { id: 'step:b', kind: 'step', parentId: 'turn:t1', label: '跑一遍测试', status: 'running' },
      { id: 'step:b1', kind: 'step', parentId: 'step:b', label: '子进程：单测' },
      { id: 'turn:t2', kind: 'turn', parentId: 'session:demo-branch', label: '把失败的那两个修掉', mergeInto: 'session:demo-branch', anchor: 't2' },
      {
        id: 'deliver:t2',
        kind: 'delivery',
        parentId: 'turn:t2',
        label: '交付',
        mergeInto: 'turn:t2',
        detail: '两处断言改成按集合比较，测试全绿。',
        files: [
          { path: 'src/a.test.ts', added: 6, removed: 3 },
          { path: 'src/b.test.ts', added: 2, removed: 2 },
        ],
      },
    ]),
    mk('demo-parallel', '演示 · 并行会话', 'codex', [
      { id: 'session:demo-parallel', kind: 'session', parentId: null, label: '演示 · 并行', status: 'running' },
      { id: 'turn:p1', kind: 'turn', parentId: 'session:demo-parallel', label: '补一条 CLI 参数', status: 'running', anchor: 'p1' },
      { id: 'step:p1a', kind: 'step', parentId: 'turn:p1', label: '改参数解析', status: 'running' },
      { id: 'step:p1b', kind: 'step', parentId: 'turn:p1', label: '补帮助文本', status: 'failed' },
    ]),
    mk('demo-merge', '演示 · 合并回主线', 'pi', [
      { id: 'session:demo-merge', kind: 'session', parentId: null, label: '演示 · 合并', status: 'done' },
      { id: 'turn:m1', kind: 'turn', parentId: 'session:demo-merge', label: '两个方向各试一次', mergeInto: 'session:demo-merge', anchor: 'm1' },
      { id: 'step:m1a', kind: 'step', parentId: 'turn:m1', label: '方案 A', mergeInto: 'turn:m1' },
      { id: 'step:m1b', kind: 'step', parentId: 'turn:m1', label: '方案 B', mergeInto: 'turn:m1' },
      { id: 'step:m1c', kind: 'step', parentId: 'step:m1a', label: 'A 的收尾', mergeInto: 'step:m1a' },
    ]),
  ]
}
