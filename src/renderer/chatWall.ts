/**
 * 原生墙的窗格编排（纯函数，可单测）
 *
 * 聊天模式默认把参与聊天的网页模型一次全贴在右侧，每一格都是站点自己的页面。
 * 这里回答两件事：哪几枚真的挂上去（哪几枚退回标签），以及墙上每一格摆在哪个矩形里。
 *
 * 形状是一棵**切分树**（见 src/shared/wall-tree.ts），不再是共享轨道的栅格：
 * 栅格里一条列轨整墙共用，拖任意一条缝都会牵动同列（同行）的所有格子 ——
 * 那是「只能控制一整行/一整列」的根因。切分树把每一刀记在它自己的节点上：
 * 一条缝只属于一个切分节点，拖动它只改该节点下相邻两个子矩形的比例，
 * 子树之外的格子一像素都不动。
 *
 * 为什么要单独拎出来：这段判断的输入有四路（参与者、用户换进来的顺序、墙此刻多大、
 * 被放大的那格），而它的错误不是崩，是「点了没反应」和「多挂一枚多烧一个渲染进程」。
 * 留在组件里就得靠手点 Electron 才能覆盖，抽出来才有断言的地方。
 */

import type { WallNode } from '../shared/wall-tree'
import { wallLeafIds } from '../shared/wall-tree'

/**
 * 拿不到实测尺寸时的兜底格数（首帧、或墙还没挂出来）。
 * 常态下格数由 planGrid 按墙的实际像素算，这个常量只在「还没有尺寸可量」时顶一下。
 */
export const DEFAULT_LIVE_PANES = 4

/**
 * 舒适档：站点保住自己的桌面布局，一屏能读完一条回答连同它自己的输入框。
 * 达到这一档时 tier 记 0，界面不必提示「挤」。
 */
export const COMFY_PANE = { w: 560, h: 340 }

/**
 * 地板档：低于这个尺寸就不再分了 —— 再碎只是把内存花在看不到字的页面上。
 *
 * 它同时是「最多能挂几枚」的算尺：墙上摆几格由它定，形状再由舒适档去挑。
 * 判据含缝宽（c 格 + (c-1) 条 SEAM_PX 装得下才算摆得下），漏掉缝会多算一格然后横向溢出。
 * 为什么不拿舒适档当上限：1920 窗口下把左栏展开、墙拖到 950px 时，560 的下限只会
 * 算出「1 列 × 2 行」，四家参与者当场掉成两家 —— 用户要的是「放更多」，
 * 结果先变少了，那是把守卫做成了倒退。地板档在这里给出 2×2，与旧口径一模一样。
 *
 * 它同时是**拖动的下限**：`shiftSeam` 让最窄那一格拖到地板档就停手。曾经这里另有一个更小的
 * 「硬底」（180），意思是「先允许拖破地板、少挂一枚，再拦住压碎」—— 但那句话在实测里变成了
 * 锁死：拖破之后墙上只剩一格、连一条缝都不剩，点别的标签只是把那唯一一格顶掉，
 * 用户再也回不到并存。所以硬底取消，地板档就是底。
 * 想独占整面墙走「放大此窗格」，那是一条说得清楚、也还得回来的路。
 */
export const FLOOR_PANE = { w: 420, h: 240 }

/** 列数天花板：再碎就成了条，站点自己的导航栏都放不下 */
export const MAX_PANE_COLS = 4
/** 行数天花板：第四行起连站点标题栏都占满了 */
export const MAX_PANE_ROWS = 3

/**
 * 格与格之间那条缝的宽度 —— 它是一段真的命中带，不是 gap，也不是盖在窗格上的把手。
 *
 * 为什么不能做成盖在缝上的 DOM 把手：WebContentsView 永远画在渲染层之上，
 * 压在窗格上的那几像素收不到指针，用户只会觉得「缝拖不动」。所以缝自己占住这 7px，
 * 缝里没有视图，指针才落得下来。
 *
 * 这个数与 styles.css 必须一致：算格数时它是成本，画的时候它是命中带，
 * 两边不一致就会「算出来摆得下、实际摆不下」而溢出（回归测试把这条钉住了）。
 */
export const SEAM_PX = 7

export interface WallBox {
  /** 墙容器此刻的可用宽（CSS px） */
  w: number
  /** 同上的高 */
  h: number
}

/** 墙内的一块矩形（相对墙容器左上角，CSS px） */
export interface WallRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 一个切分节点的格权重：100 = 等分，长度必须等于该节点的子格数，否则按等分处理。
 *
 * 存比例而不是存像素：窗口一拉大，存像素的那套比例就变形了（旧的列宽守卫踩过这个坑），
 * 而「这一格比隔壁宽一半」是用户真正拖出来的东西。
 */
export type Weights = number[]

/** 权重能不能用：长度对、都是正有限数。长度不对就是换了形状 —— 交给等分 */
export function usableWeights(w: Weights | null | undefined, n: number): Weights | null {
  if (!Array.isArray(w) || w.length !== n) return null
  const ok = w.every((x) => Number.isFinite(x) && x > 0)
  return ok ? w : null
}

/** 等分权重：100 = 平均 */
export const equalW = (n: number): Weights => Array.from({ length: Math.max(0, n) }, () => 100)

/** 扣掉缝之后，这一排真正能分给格子的像素 */
export function freePx(total: number, n: number): number {
  return Math.max(0, total - Math.max(0, n - 1) * SEAM_PX)
}

/**
 * 按权重把「扣掉缝的空间」分给各格，返回每格的实际像素。
 * 权重不可用（没拖过 / 换了形状）就等分。
 */
export function trackPx(total: number, weights: Weights | null | undefined): number[] {
  const n = Math.max(0, Math.round(weights?.length ?? 0))
  if (n === 0) return []
  const free = freePx(total, n)
  const w = usableWeights(weights, n)
  if (!w) return Array.from({ length: n }, () => free / n)
  const sum = w.reduce((a, b) => a + b, 0)
  return w.map((x) => (sum > 0 ? (free * x) / sum : free / n))
}

/** 把像素数组换算回「100 = 等分」的权重，四舍五入到整数 */
function toWeights(sizes: number[]): Weights {
  const sum = sizes.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return sizes.map(() => 100)
  return sizes.map((s) => Math.max(1, Math.round((s / sum) * sizes.length * 100)))
}

/**
 * 拖动夹住地板档时留的舍入余量。
 *
 * `shiftSeam` 交出去的是**整数权重**（`toWeights` 四舍五入），换算回像素会差一两像素：
 * 1787 的两格等分，把右格正好夹在 420 → 权重 [153,47] → 再量回来是 418.1。
 * 差这 2px 不要紧，要紧的是界面认「低于地板档」这件事 —— 一认就报破档、
 * 墙头那颗复位钮跟着冒出来，而用户刚刚并没有拖破任何东西。
 * 所以让出的下限抬高几个像素，保证夹住之后按整数权重量回来仍在地板档之上。
 */
export const FLOOR_GUARD_PX = 6

/**
 * 拖一条缝：把缝右侧（/下侧）那个子格的一些像素转给左侧（/上侧），其余子格一动不动。
 *
 * 权重和保持不变 → 没参与的子格拿到的像素正好不变。而在切分树里，「其余子格」
 * 连同它们子树里的所有格子都在该节点之外或按自己的比例分 —— 这正是单格独立控制的含义：
 * 拖这一条缝，只有它两侧的子矩形在变。
 *
 * `floorPx` 是这一轴的地板档（宽轴 420 / 高轴 240）：谁都不许被拖到它以下，
 * 所以「把这一格放大」不会把墙拖塌成一格。
 * 已经在地板档以下的那一格（拖完之后墙变小把比例压破的）算 room=0：
 * 它不能再让出一像素，但另一格照样能让它变大 —— 手感是「拖得回来，拖不坏」。
 */
export function shiftSeam(
  total: number,
  weights: Weights,
  seam: number,
  deltaPx: number,
  floorPx: number,
): Weights {
  const n = weights.length
  if (n < 2 || seam < 0 || seam > n - 2) return [...weights]
  const sizes = trackPx(total, weights)
  // 左边能让出的 / 右边能让出的（两个方向的约束落在不同那格上）
  const room = (px: number) => (px >= floorPx + FLOOR_GUARD_PX ? px - floorPx - FLOOR_GUARD_PX : 0)
  const roomLeft = room(sizes[seam] ?? 0)
  const roomRight = room(sizes[seam + 1] ?? 0)
  let d = deltaPx
  if (d > 0) d = Math.min(d, roomRight)
  if (d < 0) d = Math.max(d, -roomLeft)
  return toWeights(sizes.map((s, k) => (k === seam ? s + d : k === seam + 1 ? s - d : s)))
}

/**
 * 「每格都不低于地板档」最多能开几列（几行）。
 * 判据是 c 格 + (c-1) 条缝装得下，漏掉缝就会多算一格然后横向溢出。
 */
function maxTracks(total: number, floor: number, ceiling: number): number {
  if (total <= 0) return 1
  return Math.max(1, Math.min(ceiling, Math.floor((total + SEAM_PX) / (floor + SEAM_PX))))
}

export interface WallGrid {
  cols: number
  rows: number
  /**
   * 这一屏摆得下几枚（地板档下的 maxCols × maxRows）。
   *
   * 它不等于 cols × rows —— 后者是「这次挑的摆法占几格」，前者是「墙还能塞几格」。
   * 界面那句「这一屏放得下 N 枚」要说的是前者：三枚参与者摆成 3×1 时，
   * 报 3 会让用户以为墙已经满了、拖宽没用，而它其实还剩大半。
   */
  cap: number
  /** 0 = 每格达到舒适档；1 = 已经让到地板档（界面可以据此说明「挤了一档」） */
  tier: number
}

/**
 * 按墙的实际像素算格数（自动摆法：没有用户拖出来的树时的默认形状）。
 *
 * 两步：先用地板档算「这一屏最多塞得下几枚」（cap，判据含缝宽），再用它挑一种摆法 ——
 * 在不超过 cap 的前提下，取空格最少、且每格形状最接近舒适档比例的那个列数。
 * 于是「参与者少」时格子会变大而不是留空位，「参与者多」时先分满、形状其次。
 * 拿不到尺寸（首帧 / 墙被收起来）退回旧的 2×2 口径。
 */
export function planGrid(box?: WallBox | null, want = 0): WallGrid {
  const w = box?.w ?? 0
  const h = box?.h ?? 0
  if (w <= 0 || h <= 0) {
    return { cols: 2, rows: 2, cap: DEFAULT_LIVE_PANES, tier: 0 }
  }
  const maxCols = maxTracks(w, FLOOR_PANE.w, MAX_PANE_COLS)
  const maxRows = maxTracks(h, FLOOR_PANE.h, MAX_PANE_ROWS)
  // 这一屏的容量：地板档下的满格数，跟最后挑了哪种摆法无关
  const cap = maxCols * maxRows
  const live = Math.min(Math.max(0, want), cap)
  if (live === 0) return { cols: 1, rows: 1, cap, tier: 0 }

  let best: WallGrid | null = null
  let bestEmpty = Number.POSITIVE_INFINITY
  let bestGap = Number.POSITIVE_INFINITY
  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.ceil(live / cols)
    if (rows > maxRows) continue
    const paneW = freePx(w, cols) / cols
    const paneH = freePx(h, rows) / rows
    /*
     * 第一判据是空格子数：四枚摆在三列里会留下两格空位（顶上三格、底下一格），
     * 看着像墙坏了一半 —— 宁可形状差一点，也不要那种缺口。
     * 第二判据才是形状：每格尽量接近舒适档的宽高比，太扁（读不完一条回答）
     * 和太瘦（站点内容横向滚动）都扣分。
     */
    const empty = cols * rows - live
    const gap = Math.abs(Math.log(paneW / paneH / (COMFY_PANE.w / COMFY_PANE.h)))
    if (empty < bestEmpty || (empty === bestEmpty && gap < bestGap)) {
      bestEmpty = empty
      bestGap = gap
      best = { cols, rows, cap, tier: paneW >= COMFY_PANE.w && paneH >= COMFY_PANE.h ? 0 : 1 }
    }
  }
  // 一行都摆不满（参与者多于格数）时按满格摆：多出来的那几枚退回标签条，点一下换进来
  return best ?? { cols: maxCols, rows: maxRows, cap, tier: 1 }
}

/**
 * 等分摆法的切分树：rows 行、每行最多 cols 格，按墙上顺序（先行后列）填。
 *
 * 行的顺序是**先行后列**（第 k 格在第 ⌊k/cols⌋ 行）—— 与参与者名单的读法一致，
 * 也让「换进来一枚新的」总是出现在大家认识的位置上。
 * 最后一行摆不满时那一行只有实际的格数，不留空洞。
 */
export function gridTree(ids: readonly string[], cols: number, rows: number): WallNode {
  const c = Math.max(1, cols)
  const rowCount = Math.max(1, Math.min(rows, Math.ceil(ids.length / c)))
  if (ids.length === 0) return { kind: 'leaf', ids: [] }
  /*
   * 列优先：先把名单切成 c 份，每一份**各自**再切成若干行。
   *
   * 为什么不是「先行后列」：那样切出来的是「上面一行三格、下面一行三格」，
   * 每一行的高度是整行共享的 —— 拖第 1、2 行之间那条缝，第 3 列那两格也跟着变高变矮。
   * 那正是「上下拖拉改高度只能控制一整行」的根因，与列方向的老毛病一模一样。
   * 列优先切出来的是「左边一列两格、右边一列两格」，两条横缝各属于自己那一列，
   * 拖其中一条，另一列一像素不动 —— 上下方向也就独立了。
   *
   * 代价是墙上第 k 格的排列变成「从上到下、从左到右」（一列读完再读下一列），
   * 与参与者名单的读法一致，也让「换进来一枚新的」出现在大家认识的位置上。
   */
  const perCol = Math.ceil(ids.length / c)
  const columns: WallNode[] = []
  for (let col = 0; col < c; col++) {
    const slice = ids.slice(col * perCol, (col + 1) * perCol)
    if (slice.length === 0) continue
    columns.push(columnTree(slice))
  }
  const first = columns[0]
  if (columns.length === 0 || !first) return { kind: 'leaf', ids: [] }
  if (columns.length === 1) return first
  return { kind: 'split', axis: 'x', weights: equalW(columns.length), children: columns }
}

/**
 * 一列内部的形状：这些页面竖着排，每一格的高度是这一列自己的。
 *
 * 一列只有一个页面时就是它自己（不再套一层无意义的切分）。
 */
function columnTree(ids: readonly string[]): WallNode {
  if (ids.length === 0) return { kind: 'leaf', ids: [] }
  if (ids.length === 1) return { kind: 'leaf', ids: [ids[0] as string] }
  return {
    kind: 'split',
    axis: 'y',
    weights: equalW(ids.length),
    children: ids.map((id) => ({ kind: 'leaf' as const, ids: [id] })),
  }
}


/**
 * 树上共有多少页（折起来的一叠按页数算，不按格子数算）。
 *
 * 「几枚」在折叠出现之后有了两种数法：页数（站点的会话有几页在场）
 * 与格子数（墙被切成几块）。折叠省下的正是格子数，页数一页不少 ——
 * 界面那句「这一屏放得下 N 枚」说的是格子数，内存与保活说的是页数。
 */
export function treePages(root: WallNode): number {
  if (root.kind === 'leaf') return root.ids.length
  return root.children.reduce((a, c) => a + treePages(c), 0)
}

/** 树上有几格（叶子数） */
export function treeCellCount(root: WallNode): number {
  if (root.kind === 'leaf') return 1
  return root.children.reduce((a, c) => a + treeCellCount(c), 0)
}

/** 树里有没有折起来的一叠（某个叶子叠着不止一页） */
export function hasGroups(root: WallNode): boolean {
  if (root.kind === 'leaf') return root.ids.length > 1
  return root.children.some(hasGroups)
}

/**
 * 把存下来的树对到新的参与者名单上：退场的摘掉，新来的补上。
 *
 * 切分树在这一版之后**自己就记着谁在哪一格**（叶子带 ids），
 * 所以名单与树不再是谁认领谁 —— 树是布局，名单是「此刻谁在场」。
 * 两边对不上时改的是树：
 * - 退场的那一页从叶子里摘掉；一格摘空了整格删掉，权重跟着少一条缝；
 * - 只剩一格的切分节点摊平（一个孩子的切分是纯噪声）；
 * - 新来的参与者补到墙上（挂在最后一格下面），但只在墙还装得下的时候 ——
 *   装不下的留在下方标签条里，点一下再进来（见 insertPane）。
 * 同一页在两个格子里（手改的偏好文件才会这样）只算第一次：
 * 两格挂同一家站点，两个贴合循环对着同一个原生视图各报自己的矩形，症状是那格一直在抖。
 *
 * 返回 null = 这棵树里一页不剩（参与者全换了），交给等分摆法重开。
 */
export function syncTree(root: WallNode, ids: readonly string[], cap: number): WallNode | null {
  const present = new Set(ids)
  const taken = new Set<string>()
  const prune = (n: WallNode): WallNode | null => {
    if (n.kind === 'leaf') {
      const keep: string[] = []
      for (const id of n.ids) {
        if (present.has(id) && !keep.includes(id)) keep.push(id)
      }
      // 全局去重：同一页只许占一格（keep 里先遇到的那位赢）
      const uniq = keep.filter((id) => {
        if (taken.has(id)) return false
        taken.add(id)
        return true
      })
      return uniq.length > 0 ? { kind: 'leaf', ids: uniq } : null
    }
    const kids: WallNode[] = []
    const keepIdx: number[] = []
    n.children.forEach((c, i) => {
      const sub = prune(c)
      if (sub) {
        kids.push(sub)
        keepIdx.push(i)
      }
    })
    if (kids.length === 0) return null
    // 只剩一个孩子：摊平，它顶替这一层（权重也得跟着这层一起消失）
    if (kids.length === 1) return kids[0] as WallNode
    return { kind: 'split', axis: n.axis, weights: keepIdx.map((i) => n.weights[i] as number), children: kids }
  }
  let out = prune(root)
  if (!out) return null
  const want = Math.min(ids.length, cap)
  /*
   * 没折过的那棵树：老规矩，格子数必须与「这一屏该挂的枚数」一样，
   * 对不上就整份作废、回到等分摆法。不许部分采信 —— 把三格的切法硬套到六枚上，
   * 会得到一个谁都没拖过的形状（这条契约从共享轨道那一版一路留到今天）。
   */
  if (!hasGroups(out)) return treeCellCount(out) === want ? out : null
  /*
   * 折过的那棵树：折叠省出来的空位要补上人，一格一页地挂到最后一格下面。
   * 为什么自动补而不是留在标签条：空位不补上人，用户看到的就是
   * 「我折起来一叠，另一枚却还躺在条里」—— 省地方的意义就是摆更多人。
   */
  const inTree = new Set(wallLeafIds(out))
  for (const id of ids) {
    if (inTree.has(id)) continue
    if (treeCellCount(out) >= cap) break
    out = appendLeaves(out, [id])
    inTree.add(id)
  }
  return out
}

/** 树上最后一格（DFS 里最后出现的那个叶子）的路径 */
function lastLeafPath(root: WallNode): number[] {
  const path: number[] = []
  let cur: WallNode = root
  while (cur.kind !== 'leaf') {
    const i = cur.children.length - 1
    path.push(i)
    cur = cur.children[i] as WallNode
  }
  return path
}

/**
 * 把几页新页面挂到树上（每页一格），挂在**最后一格下面**。
 *
 * 为什么是「下面」而不是「右边」或「新开一列」：新开一列会把整墙的列数改掉，
 * 用户刚刚拖出来的那些宽窄跟着一起重排，症状是「加一个人，半面墙搬家」。
 * 把最后一格的矩形竖着切两半（原格在上，新格在下）只动那一格自己 ——
 * 与切分树的承诺一致：每一刀只管自己这一层。
 */
export function appendLeaves(root: WallNode, ids: readonly string[]): WallNode {
  if (ids.length === 0) return root
  const path = lastLeafPath(root)
  const cell = nodeAt(root, path)
  if (!cell || cell.kind !== 'leaf') return root
  const kids: WallNode[] = [cell, ...ids.map((id) => ({ kind: 'leaf' as const, ids: [id] }))]
  return replaceAt(root, path, { kind: 'split', axis: 'y', weights: equalW(kids.length), children: kids })
}

/** 不可变地替换某个切分节点的权重（path 是从根出发的子下标序列） */
export function setNodeWeights(root: WallNode, path: readonly number[], weights: Weights): WallNode {
  if (root.kind === 'leaf') return root
  if (path.length === 0) return { ...root, weights: [...weights] }
  const head = path[0]
  const rest = path.slice(1)
  return {
    ...root,
    children: root.children.map((c, i) => (i === head ? setNodeWeights(c, rest, weights) : c)),
  }
}

/**
 * 墙上一格：露着的那页 + 它在墙内的矩形 + 墙上排位（DFS 序 = 树的阅读序）。
 *
 * 一格可能是「一页」也可能是「一叠标签」：
 * - `pages` 只有一项 = 就这一页（id 就是它）。
 * - `pages` 多项 = 这一格折叠着一叠页面（Obsidian 的工作区标签组），
 *   `id` 是当前露着的那一页（pages[0]），其余是折叠起来的标签。
 *
 * 两种形态都只占**一个**矩形：标签条画在格子头部，露着的那页填满格子其余部分。
 * 折叠的那些页并没有被销毁 —— 它们仍各自占一个 WebContentsView，
 * 只是此刻不在窗口上（见 pool.dismiss：摘的是爹，不是实例）。
 */
export interface WallCell extends WallRect {
  /** 当前露着的那一页 */
  id: string
  index: number
  /** 这一格上的全部页面（第一项是露着的那页） */
  pages: string[]
  /** 这一格所属节点在树里的路径（换位/折叠时要按它定位） */
  path: number[]
}

/**
 * 一条缝：某个切分节点里相邻两个子格之间的那段命中带。
 *
 * 它只覆盖这两个子格的公共边（不再是贯通整墙的轨道）—— 这正是单格独立控制
 * 在界面上的样子：一条缝属于一个节点，拖动只改该节点下相邻两格。
 */
export interface WallSeamSeg extends WallRect {
  key: string
  /** x = 竖直缝（拖它改宽），y = 水平缝（拖它改高） */
  axis: 'x' | 'y'
  /** 缝所属切分节点的路径（从根出发的子下标序列） */
  path: number[]
  /** 该节点里第 index 与第 index+1 个子格之间 */
  index: number
  /** 该节点沿自己轴方向的总像素（含缝）：位移换权重要用它 */
  totalPx: number
  /** 该节点当前生效的权重（长度 = 子格数） */
  weights: Weights
}

export interface WallLayout {
  cells: WallCell[]
  seams: WallSeamSeg[]
}

/**
 * 把切分树铺进墙：返回每格的矩形与每条缝的命中带。
 *
 * 递归定义：一个 split 节点沿自己的轴把可用空间按权重分成子矩形（子与子之间
 * 各留一条 SEAM_PX 的缝），再递归铺每个子。叶子拿到自己的矩形。
 * 缝的命中带取相邻两个子格的公共边段 —— 只盖住这条边，不横穿别人的格子。
 */
export function layoutWall(root: WallNode, box: WallBox): WallLayout {
  const cells: WallCell[] = []
  const seams: WallSeamSeg[] = []
  const walk = (node: WallNode, rect: WallRect, path: number[]): void => {
    if (node.kind === 'leaf') {
      const active = node.ids[0]
      if (!active) return
      cells.push({ id: active, index: cells.length, pages: [...node.ids], path, ...rect })
      return
    }
    const n = node.children.length
    if (n === 0) return
    const along = node.axis === 'x' ? rect.w : rect.h
    const weights = usableWeights(node.weights, n) ?? equalW(n)
    const sizes = trackPx(along, weights)
    const kids: WallRect[] = []
    let pos = node.axis === 'x' ? rect.x : rect.y
    for (let i = 0; i < n; i++) {
      const s = sizes[i] ?? 0
      kids.push(
        node.axis === 'x'
          ? { x: pos, y: rect.y, w: s, h: rect.h }
          : { x: rect.x, y: pos, w: rect.w, h: s },
      )
      pos += s + SEAM_PX
    }
    for (let i = 0; i < n; i++) {
      const kid = node.children[i]
      const kr = kids[i]
      if (kid && kr) walk(kid, kr, [...path, i])
    }
    for (let i = 0; i < n - 1; i++) {
      const a = kids[i] as WallRect
      const b = kids[i + 1] as WallRect
      seams.push(
        node.axis === 'x'
          ? {
              key: `x:${path.join('.')}:${i}`,
              axis: 'x',
              path,
              index: i,
              totalPx: along,
              weights,
              x: a.x + a.w,
              y: Math.min(a.y, b.y),
              w: SEAM_PX,
              h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y),
            }
          : {
              key: `y:${path.join('.')}:${i}`,
              axis: 'y',
              path,
              index: i,
              totalPx: along,
              weights,
              x: Math.min(a.x, b.x),
              y: a.y + a.h,
              w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
              h: SEAM_PX,
            },
      )
    }
  }
  walk(root, { x: 0, y: 0, w: box.w, h: box.h }, [])
  return { cells, seams }
}

/** 最窄的一格（界面那句「拖开后最窄一格 NNN×NNN」读它）；没有格子时 null */
export function tightestCell(cells: readonly WallCell[]): { w: number; h: number } | null {
  if (cells.length === 0) return null
  let w = Number.POSITIVE_INFINITY
  let h = Number.POSITIVE_INFINITY
  for (const c of cells) {
    w = Math.min(w, c.w)
    h = Math.min(h, c.h)
  }
  return { w: Math.round(w), h: Math.round(h) }
}

/** 有没有格子破了地板档（墙变小把拖出来的比例压破时会出现） */
export function treeBreached(cells: readonly WallCell[]): boolean {
  return cells.some((c) => c.w < FLOOR_PANE.w || c.h < FLOOR_PANE.h)
}

/** 有没有格子低于舒适档 */
export function treeTight(cells: readonly WallCell[]): boolean {
  return cells.some((c) => c.w < COMFY_PANE.w || c.h < COMFY_PANE.h)
}

/*
 * ── Obsidian 式的四件事：切到某一页 / 把一格折进另一格 / 把一页拆出去 / 两格对调 ──
 *
 * 这四件事都是纯树变换，界面那边只管发手势。
 * 「折进另一格」是 Obsidian 那个手势：把一页拖到另一格上，两页就合成一叠标签。
 * 合成之后两页仍各有一个 WebContentsView，登录态、滚动位置一概不动。
 *
 * 这里的「一叠」不是树里的一种节点，而是**一个叶子里叠着多页**：
 * 叶子 ids[0] 是露着的那页，其余是折叠着的标签。
 * 好处是折叠不占额外的几何层 —— 一叠页面共享同一个矩形，
 * 而树里每一层切分都对应一条真的缝（拖得动的那条）。
 */

/** 树里按路径取节点 */
export function nodeAt(root: WallNode, path: readonly number[]): WallNode | null {
  let cur: WallNode = root
  for (const i of path) {
    if (cur.kind === 'leaf') return null
    const next = cur.children[i]
    if (!next) return null
    cur = next
  }
  return cur
}

/** 树里按路径替换节点 */
export function replaceAt(root: WallNode, path: readonly number[], next: WallNode): WallNode {
  if (path.length === 0) return next
  const head = path[0] as number
  const rest = path.slice(1)
  if (root.kind === 'leaf') return root
  return {
    ...root,
    children: root.children.map((c, i) => (i === head ? replaceAt(c, rest, next) : c)),
  }
}

/** 路径下那一格叠着的全部页面（第一项是露着的那页） */
export function idsAt(root: WallNode, path: readonly number[]): string[] {
  const n = nodeAt(root, path)
  return n && n.kind === 'leaf' ? [...n.ids] : []
}

/**
 * 把 pathA 那一格折进 pathB 那一格（两格合成一叠标签）。
 *
 * 露着的那一页不变（用户正在看的不该因为他拖了个别的东西进来就换掉），
 * 折进来的接在后面。源那一格整个消失 —— 它的位置并入目标。
 *
 * 折不进去的情形（都返回原树，不报错）：
 * - 折自己（同一格）；
 * - 目标已经含源的第一页（已经是一叠了）；
 * - 源是目标的祖先（折进去会自噬）。
 */
export function foldInto(root: WallNode, pathA: readonly number[], pathB: readonly number[]): WallNode {
  if (pathA.length === 0 || pathB.length === 0) return root
  if (pathA.join('.') === pathB.join('.')) return root
  if (pathB.slice(0, pathA.length).join('.') === pathA.join('.')) return root
  const aIds = idsAt(root, pathA)
  const bIds = idsAt(root, pathB)
  if (aIds.length === 0 || bIds.length === 0) return root
  if (bIds.includes(aIds[0] as string)) return root
  const merged: WallNode = { kind: 'leaf', ids: [...bIds, ...aIds.filter((id) => !bIds.includes(id))] }
  const withB = replaceAt(root, pathB, merged)
  return removeAt(withB, pathA)
}

/**
 * 把某一**页**挪进另一格（拖标签到别的格子上：只搬这一页，不搬整格）。
 *
 * 源格子摘掉这一页后：还剩页就继续当格子，摘空了就整格消失（与 foldInto 同一条 removeAt）。
 * 目标那格露着的页面不变，挪进来的接在标签条末尾。
 */
export function movePageInto(
  root: WallNode,
  fromPath: readonly number[],
  pageId: string,
  toPath: readonly number[],
): WallNode {
  if (fromPath.join('.') === toPath.join('.')) return root
  const fromIds = idsAt(root, fromPath)
  const toIds = idsAt(root, toPath)
  if (!fromIds.includes(pageId) || toIds.length === 0) return root
  if (toIds.includes(pageId)) return root
  const withPage: WallNode = { kind: 'leaf', ids: [...toIds, pageId] }
  const moved = replaceAt(root, toPath, withPage)
  const rest = fromIds.filter((id) => id !== pageId)
  if (rest.length === 0) return removeAt(moved, fromPath)
  return replaceAt(moved, fromPath, { kind: 'leaf', ids: rest })
}

/** 把某个节点从树里摘掉（它的兄弟里少一个，权重跟着少一条缝） */
function removeAt(root: WallNode, path: readonly number[]): WallNode {
  if (path.length === 0) return root
  const head = path[0] as number
  const rest = path.slice(1)
  if (root.kind === 'leaf') return root
  if (rest.length === 0) {
    const kids = root.children.filter((_, i) => i !== head)
    const weights = root.weights.filter((_, i) => i !== head)
    // 摘到只剩一个：摊平这一层，别留一个孩子的切分节点
    if (kids.length === 1) return kids[0] as WallNode
    return { ...root, children: kids, weights }
  }
  return {
    ...root,
    children: root.children.map((c, i) => (i === head ? removeAt(c, rest) : c)),
  }
}

/**
 * 切到格子里的另一页（换露着的那一个）。
 *
 * 换的是「露着谁」，不是「谁活着」—— 折叠着的页仍各自占一个视图实例，
 * 切回去是 present 回去，不是重新加载（见 pool.dismiss：摘的是爹，不是实例）。
 */
export function setActiveTab(root: WallNode, path: readonly number[], pageId: string): WallNode {
  const node = nodeAt(root, path)
  if (!node || node.kind !== 'leaf') return root
  if (!node.ids.includes(pageId)) return root
  if (node.ids[0] === pageId) return root
  // 换露着谁 = 把那一页挪到队首（ids[0] 是露着的那页），其余保持相对次序
  const ids = [pageId, ...node.ids.filter((x) => x !== pageId)]
  return replaceAt(root, path, { kind: 'leaf', ids })
}

/**
 * 把某一页从格子里拆出来，在它**正下方**新开一格（把标签拖出标签组的效果）。
 *
 * 拆出来的那一页落在原格正下方（原格的矩形竖着切两半）——
 * 用户拖出来的东西就该落在他松手的地方附近，而不是飞到墙的末尾。
 * 原格只剩一页时它自然就是一页，不需要「摊平组」这种额外说法。
 */
export function splitLeafOut(root: WallNode, groupPath: readonly number[], pageId: string): WallNode {
  const node = nodeAt(root, groupPath)
  if (!node || node.kind !== 'leaf') return root
  if (!node.ids.includes(pageId)) return root
  if (node.ids.length <= 1) return root
  /*
   * 露着的那一页（ids[0]）拆出去时，被拆的那一页要顶替它露出来 ——
   * 否则这一格会露着一张「已经不在这一格」的页面（画面与标签条对不上）。
   * 所以拆出去的那一页排在前面，剩下的第一页接着露。
   */
  const rest = node.ids.filter((x) => x !== pageId)
  const out: WallNode = { kind: 'leaf', ids: [pageId] }
  const kept: WallNode = { kind: 'leaf', ids: rest }
  return replaceAt(root, groupPath, { kind: 'split', axis: 'y', weights: equalW(2), children: [kept, out] })
}

/**
 * 两格对调位置（Obsidian 里拖动一个窗格换到另一个窗格的地方）。
 *
 * 对调的是**整格**：一叠标签跟着搬家，不拆开。
 * 两格的矩形、比例、缝一概不动 —— 动的是格子里装的东西。
 * 祖孙关系不对调（那是把一格塞进自己），任一方不是叶子也不对调。
 */
export function swapCells(root: WallNode, pathA: readonly number[], pathB: readonly number[]): WallNode {
  if (pathA.join('.') === pathB.join('.')) return root
  const a = nodeAt(root, pathA)
  const b = nodeAt(root, pathB)
  if (!a || !b || a.kind !== 'leaf' || b.kind !== 'leaf') return root
  if (pathB.slice(0, pathA.length).join('.') === pathA.join('.')) return root
  if (pathA.slice(0, pathB.length).join('.') === pathB.join('.')) return root
  const withB = replaceAt(root, pathA, b)
  return replaceAt(withB, pathB, a)
}

/**
 * 把标签条里的一枚换进墙（点「未挂载」那枚标签时发生的事）。
 *
 * 墙还装得下 → 挂在最后一格下面（与 syncTree 自动补人同一条路）。
 * 墙装满了 → 折进最后一格：那一格多出一枚标签，而不是把谁挤下墙。
 *
 * 为什么满了是「折进去」而不是「顶掉谁」：旧口径是「换进来顶掉最后一格」——
 * 那一格的内容被换掉，被顶掉的那枚退回标签条。可现在折叠已经能一格装多页了，
 * 顶掉就纯属浪费：用户点了「换进来」，看到的是自己刚折好的那一叠少了一个标签。
 * 折进去则是什么都不丢：多一个标签，格子数不变（也就没有「半面墙搬家」）。
 *
 * 折进哪一格：最后一格。它是 DFS 序里最后一片，视觉上在最边角，
 * 新标签冒在那里最不打扰；折进第一格则会把那一格的内容整个换掉。
 */
export function insertPane(root: WallNode, pageId: string, cap: number): WallNode {
  if (wallLeafIds(root).includes(pageId)) return root
  if (treeCellCount(root) < cap) return appendLeaves(root, [pageId])
  const path = lastLeafPath(root)
  const cell = nodeAt(root, path)
  if (!cell || cell.kind !== 'leaf') return root
  /* 折进去的那一枚排在最前 = 它露出来；原来露着的那页退成折叠标签 */
  return replaceAt(root, path, { kind: 'leaf', ids: [pageId, ...cell.ids] })
}


export interface PanePlan {
  /**
   * 墙上的页面 id，按墙上顺序（DFS 序）。
   *
   * 折叠的一叠也算在内 —— 它们仍在墙上（各自占一个视图实例），
   * 只是此刻没露出来。真正贴在窗口上的是每格的第一页（layout.cells 的 id）。
   */
  live: string[]
  /** 没上墙的那些：渲染层把它们摆成能点进来的标签 */
  rest: string[]
  /**
   * 这一屏摆得下的**格数**（地板档下的 cols × rows），跟挂了几页无关。
   *
   * 界面拿它写「这一屏放得下 N 枚」那句提示，所以它必须回答「这堵墙能摆几格」。
   * 折叠会省出格子 —— 省出来的地方由 syncTree 自动补上候补页面。
   */
  cap: number
  /** 0 = 舒适档，1 = 已经挤到地板档 */
  tier: number
  /** 这一路实际生效的切分树（叶子带着每格是谁）；渲染层照它摆格子与缝 */
  root: WallNode
  /** 树铺出来的格子矩形与缝（与 root 同源算出，不会出现「形状与格子打架」） */
  layout: WallLayout
  /**
   * 有格子破了地板档：拖动本身拖不出这一种（shiftSeam 夹在地板档），
   * 它来自拖完之后墙变小 / 左栏展开把比例压破。
   * 界面据此给墙头那颗「恢复等分」，点未挂载标签时也先清树再加人。
   */
  seamBreached: boolean
}

/**
 * 把参与者名单摆上墙：哪几格挂哪几页、每格在哪个矩形、缝在哪。
 *
 * 这一版的关键变化是**树自己就记着每格是谁**（叶子带 ids），
 * 所以「换进来提到最前」那份名单顺序（wall.order）对墙不再需要了 ——
 * 位置是树的事，谁在场是名单的事，两者对不上时改树（syncTree）。
 * 于是 Obsidian 那四件事（对调 / 折叠 / 拆出 / 切页）都是一次纯树编辑，
 * 不必再同步两份可能打架的存值。
 */
export function planPanes(o: {
  /** 参与聊天的网页模型，按侧栏/参与者原有顺序 */
  ids: readonly string[]
  /** 显式上限；给了就不看墙尺寸（测试与「整面墙收起」这两路用得上） */
  cap?: number
  /** 墙此刻的可用像素。给了就按 planGrid 算，不给退回 DEFAULT_LIVE_PANES */
  box?: WallBox | null
  /** 被单独放大的那一格；不在 ids 里当没发生 */
  expanded?: string | null
  /** 用户拖出来 / 折叠出来的那棵树（叶子带着每格是谁） */
  tree?: WallNode | null
  /**
   * 正在拖的那条缝：{ 所属节点路径, 该节点的新权重 }。
   *
   * 它落在 planPanes 里而不是让调用方自己改树，是因为「没拖过时用哪棵树」
   * 要由这里的形状判断算出来 —— 调用方拿不到那一步，
   * 自己拼就会拼出「拖的是自动等分那棵树，画的是存值那棵」的两张皮。
   */
  drag?: { path: readonly number[]; weights: Weights } | null
}): PanePlan {
  const box: WallBox = o.box && o.box.w > 0 && o.box.h > 0 ? o.box : { w: 0, h: 0 }
  const grid = planGrid(o.box, o.ids.length)
  const cap = o.cap ?? grid.cap
  const present = new Set(o.ids)
  /*
   * 名单只兜一层脏：重复的 id 只算第一次。重复这一层不是洁癖 ——
   * 同一个 id 上两次墙，就是两格挂同一家站点，两个贴合循环对着同一个
   * 原生视图各报自己的矩形，症状是那格一直在抖。
   */
  const order = [...new Set(o.ids)]

  // 放大：只留那一枚真的挂载。其余不是「藏起来」而是从 DOM 卸载 ——
  // 窗格卸载会 dismiss 回离屏宿主，页面活着，切回来不重载（见 pool.dismiss）。
  if (o.expanded && present.has(o.expanded)) {
    const one: WallNode = { kind: 'leaf', ids: [o.expanded] }
    const laid = layoutWall(one, box)
    return {
      live: [o.expanded],
      rest: order.filter((id) => id !== o.expanded),
      cap,
      tier: box.w > 0 && treeTight(laid.cells) ? 1 : 0,
      root: one,
      layout: laid,
      // 放大态是一格满幅，比例根本没参与，也就无所谓破不破
      seamBreached: false,
    }
  }
  /*
   * 形状优先用用户拖出来 / 折叠出来的那棵树（把它对到当下的名单上），
   * 树里一页都不剩（参与者全换了）才回等分摆法。
   * 等分摆法的行列出自 planGrid 那一个判断，缝与格子也出自同一棵树，不会打架。
   */
  const synced = o.tree ? syncTree(o.tree, order, cap) : null
  const base = synced ?? gridTree(order.slice(0, Math.max(0, cap)), grid.cols, grid.rows)
  const root = o.drag ? setNodeWeights(base, o.drag.path, o.drag.weights) : base
  const layout = layoutWall(root, box)
  const live = wallLeafIds(root)
  /*
   * 破档按实际矩形判：拖动本身已经把地板档当下限（见 shiftSeam），所以今天只剩一条路会进来 ——
   * 拖的时候墙够宽，之后窗口缩小 / 左栏展开，把那份比例压到地板以下。
   */
  const measurable = box.w > 0 && box.h > 0
  return {
    live,
    rest: order.filter((id) => !live.includes(id)),
    cap,
    tier: measurable && treeTight(layout.cells) ? 1 : 0,
    root,
    layout,
    seamBreached: measurable && treeBreached(layout.cells),
  }
}
