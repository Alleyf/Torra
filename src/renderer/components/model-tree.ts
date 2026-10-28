/**
 * 模型 id → 多级树。议事厅座位选择与助手 ModelPicker 共用。
 *
 * 按每一段 `/` 建树：`a/b/x`、`a/b/y`、`a/c` 折成 a ▸ b ▸ {x, y} 与 a ▸ c。
 * 组排在前、叶子在后，同层内各自按字典序；空段（连续斜杠等脏 id）不进树。
 */

export interface ModelTreeNode {
  /** 这一段的名字（不含前缀路径） */
  seg: string
  /** 从根到该节点的段名路径，全局唯一 —— React key 与折叠状态都认它 */
  path: string
  /** 子组；空数组 = 叶子（一个可选的模型 id） */
  children: ModelTreeNode[]
  /** 叶子才有：完整模型 id（用于提交 pick 与默认标记） */
  leafId?: string
}

export function buildModelTree(models: string[]): ModelTreeNode[] {
  const root: ModelTreeNode[] = []
  for (const id of models) {
    const segs = id.split('/').filter(Boolean)
    if (segs.length === 0) continue
    let level = root
    let parentPath = ''
    let node: ModelTreeNode | undefined
    for (const seg of segs) {
      const path = parentPath ? `${parentPath}/${seg}` : seg
      node = level.find((n) => n.seg === seg)
      if (!node) {
        node = { seg, path, children: [] }
        level.push(node)
      }
      parentPath = path
      level = node.children
    }
    // 同段同名时叶子与组自然合并（如 `a/b` 与 `a/b/c` 共享 a ▸ b）
    if (node) node.leafId = id
  }
  const sortLevel = (nodes: ModelTreeNode[]): void => {
    nodes.sort((a, b) => {
      const ag = a.children.length > 0
      const bg = b.children.length > 0
      if (ag !== bg) return ag ? -1 : 1
      return a.seg.localeCompare(b.seg)
    })
    for (const n of nodes) sortLevel(n.children)
  }
  sortLevel(root)
  return root
}

/** 折叠徽标：该子树下一共有几个可选模型 */
export function countLeaves(n: ModelTreeNode): number {
  if (n.children.length === 0) return 1
  return n.children.reduce((sum, c) => sum + countLeaves(c), 0)
}
