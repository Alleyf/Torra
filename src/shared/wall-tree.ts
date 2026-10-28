/**
 * 原生墙的切分树 —— 墙上那几格的形状与比例，唯一的一份数据结构。
 *
 * 为什么要从「共享轨道的栅格」换成切分树：栅格里一条列轨是整墙共用的，
 * 拖动任意一条缝都会牵动同一列（行）的所有格子，用户想调小的那一格
 * 和只想保持不动的那几格被绑在一起 —— 这正是「只能控制一整行/一整列」的根因。
 * 切分树把每一刀记在**它自己的那个节点**上：一条缝只属于一个切分节点，
 * 拖动它只改变该节点下相邻两个子矩形的比例，子树之外的格子一像素都不动。
 *
 * 这一层只有「形状」没有「像素」：像素、地板档、缝宽都在渲染层的 chatWall 里算，
 * 因为主进程只负责把这份结构存住（见 src/main/index.ts 的 layout:set 闸门）。
 *
 * 校验放这里而不是各写一份：渲染层要拒脏值、主进程要挡手改的偏好文件、
 * preload 要知道值的类型 —— 三处同一个判据才不会「改得动、重启就没了」。
 */

/** 一格的权重：100 = 等分。区间与旧的格权重同口径（主进程那条 20~500 的闸门） */
export const WALL_WEIGHT_MIN = 20
export const WALL_WEIGHT_MAX = 500

/**
 * 叶子：一格窗格。
 *
 * 一格可以只放一页（ids 只有一个），也可以折叠着一叠页面（ids 多个，
 * 就像 Obsidian 里一个窗格叠着几个标签）。露着的是 active 那页，
 * 其余是折叠起来的标签（画在格子头部）。
 *
 * 为什么叶子要带 id，而切分节点不带：切分节点只管形状与比例（谁在哪、谁多宽），
 * 叶子管的是「这一格里是谁」。分开放，两件事各改各的 ——
 * 拖一条缝只改节点比例，页面换位置只改叶子内容。
 *
 * 旧格式（{ kind: 'leaf', id }）由 walkNode 迁移：单页的格子是绝大多数，
 * 为它单开一套字段只会让存值与判据都变复杂。
 */
export interface WallLeaf {
  kind: 'leaf'
  /** 这一格上的页面（按标签条上的次序，第一项是露着的那页）。空数组 = 这一格空着 */
  ids: string[]
}

/**
 * 切分节点：把一块矩形按 axis 切成 children 个格子。
 *
 * axis = 'x' 时从左到右排（竖缝在它们之间），'y' 时从上到下排（横缝）。
 * weights.length 必须等于 children.length；不等时按等分处理（见渲染层）。
 * 子节点本身也可以是切分节点 —— 「这一列里再切两行」就是这么表达的，
 * 也是「单格独立控制」能成立的原因：每一刀只管自己这一层。
 */
export interface WallSplit {
  kind: 'split'
  axis: 'x' | 'y'
  weights: number[]
  children: WallNode[]
}

export type WallNode = WallLeaf | WallSplit

/** 整棵树的根。null / 结构不合法 = 从没拖过 = 交给墙宽自动等分 */
export interface WallTree {
  root: WallNode
}

/** 落盘的完整值：树 + 它对应的挂载枚数（形状与格数对不上时整份作废） */
export interface WallLayout {
  /** 树里叶子的顺序（左到右、上到下）就是墙上第 0..n-1 格的顺序 */
  root: WallNode
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const okWeight = (n: unknown): boolean =>
  typeof n === 'number' && Number.isFinite(n) && n >= WALL_WEIGHT_MIN && n <= WALL_WEIGHT_MAX

/**
 * 递归校验一棵节点树。
 *
 * `seen` 收集叶子 id 用于查重：同一个模型上两次墙就是两格挂同一家站点，
 * 两个贴合循环对着同一个原生视图各报自己的矩形，症状是那格一直在抖。
 * `maxLeaves` 是叶子总数天花板（跟参与者规模走），超限整份作废而不是截断 ——
 * 截断会留下「比例还在、格子没了」的半吊子状态，比直接等分更难解释。
 */
function walkNode(v: unknown, seen: Set<string>, maxLeaves: number, depth: number): WallNode | null {
  if (!isRecord(v) || typeof v.kind !== 'string') return null
  if (v.kind === 'leaf') {
    /*
     * 叶子有两种写法：新格式 { ids: [...] }，旧格式 { id }。
     * 旧格式是「一格一页」的形状，迁移过来是 { ids: [id] } ——
     * 用户存值里那份不该因为改了一次数据结构就作废。
     */
    let ids: string[]
    if (Array.isArray(v.ids)) {
      const raw = v.ids as unknown[]
      ids = raw.map((x) => (typeof x === 'string' ? x.trim() : ''))
    } else if (typeof v.id === 'string') {
      ids = [v.id.trim()]
    } else {
      return null
    }
    if (ids.length === 0) return null
    if (ids.some((x) => !x || x.length > 64 || seen.has(x))) return null
    if (ids.length > 8) return null
    for (const id of ids) seen.add(id)
    if (seen.size > maxLeaves) return null
    return { kind: 'leaf', ids }
  }
  if (v.kind === 'split' && depth < 8) {
    if (v.axis !== 'x' && v.axis !== 'y') return null
    if (!Array.isArray(v.children) || !Array.isArray(v.weights)) return null
    const kids = v.children as unknown[]
    const weights = v.weights as unknown[]
    // 至少切两刀才有意义：一个孩子的切分节点是纯粹的噪声，等分与它同形
    if (kids.length < 2 || kids.length > 8 || weights.length !== kids.length) return null
    if (!weights.every(okWeight)) return null
    const out: WallNode[] = []
    for (const c of kids) {
      const node = walkNode(c, seen, maxLeaves, depth + 1)
      if (!node) return null
      out.push(node)
    }
    return {
      kind: 'split',
      axis: v.axis,
      weights: weights.map((n) => Math.round(n as number)),
      children: out,
    }
  }
  return null
}

/**
 * 把外部来的值（偏好文件、IPC 入参、localStorage 里的化石）收成合法树。
 * 不合法就返回 null —— 调用方一律按「没拖过、等分」处理，不许部分采信。
 */
export function sanitizeWallLayout(v: unknown, maxLeaves = 12): WallLayout | null {
  if (!isRecord(v)) return null
  const seen = new Set<string>()
  /*
   * 收两种形状：{ root }（落盘的值）与裸节点（渲染层手里那棵树）。
   * 分派靠「有没有 root 这个键」，不是靠猜 —— 裸节点自己也有 kind/children，
   * 靠猜的话两种形状会互相误判成脏值，而症状是「拖得动、重启就没了」。
   */
  const raw = 'root' in v ? v.root : v
  const root = walkNode(raw, seen, maxLeaves, 0)
  if (!root) return null
  return { root }
}

/**
 * 树里全部叶子的 id，按墙上顺序（左到右、上到下）。
 *
 * 一格折叠着一叠页面时，它贡献的是**全部**那些 id —— 墙上的「几枚」按页面数算，
 * 不按格子数算：四页折成一格，墙上的位置还是四个（其中三个折着）。
 */
export function wallLeafIds(root: WallNode): string[] {
  if (root.kind === 'leaf') return [...root.ids]
  return root.children.flatMap(wallLeafIds)
}

/** 深度优先找某个切分节点（按「第 depth 层的第 idx 个同轴节点」定位用） */
export function countLeaves(root: WallNode): number {
  return wallLeafIds(root).length
}
