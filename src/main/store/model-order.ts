/**
 * 侧栏模型阵容的排序逻辑（纯函数）。
 *
 * 抽到 store 层而不是留在 index.ts，理由只有一个：拖动排序的 bug 本身就是纯逻辑 bug ——
 * 排好之后再按「还没更新的旧 order」读一遍，新顺序立刻被旧顺序覆盖，界面弹回原位，
 * 用户看到的就是「拖了没反应」。IPC 处理器在单测里调不动，不抽出来就钉不住这条不变量。
 */

export interface ModelOrderState {
  /** 拖动后的可见模型 id 序列；未收录的模型（如刚新增）按原序补到末尾 */
  order: string[]
  /** 从侧栏「移除」的模型 id：内置项不可真删，隐藏后不参与排序，恢复显示时补尾 */
  hidden: string[]
}

/** 可见模型按 order 排列；order 为空时保持原序 */
export function visibleInOrder<T extends { id: string }>(models: T[], state: ModelOrderState): T[] {
  const hidden = new Set(state.hidden)
  const visible = models.filter((m) => !hidden.has(m.id))
  if (state.order.length === 0) return visible
  const byId = new Map(visible.map((m) => [m.id, m]))
  const ordered: T[] = []
  for (const id of state.order) {
    const m = byId.get(id)
    if (m) {
      ordered.push(m)
      byId.delete(id)
    }
  }
  for (const m of visible) if (byId.has(m.id)) ordered.push(m)
  return ordered
}

/**
 * 应用一次拖动排序：返回新的模型数组与应当持久化的 order。
 *
 * order 必须来自**这一次排好的结果**。曾经写成 `visibleInOrder(next, 旧 state)`，
 * 而 state.order 还是拖动前的序列 —— 于是持久化的是旧顺序，
 * 渲染层随后重新拉列表就把卡片弹回去，拖动看起来完全不生效。
 */
export function applyReorder<T extends { id: string }>(
  models: T[],
  state: ModelOrderState,
  orderedIds: unknown,
): { ok: true; models: T[]; order: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(orderedIds) || orderedIds.some((x) => typeof x !== 'string')) {
    return { ok: false, reason: '顺序格式非法' }
  }
  const ids = orderedIds as string[]
  if (new Set(ids).size !== ids.length) return { ok: false, reason: '顺序含重复项' }
  const byId = new Map(models.map((m) => [m.id, m]))
  const next: T[] = []
  for (const id of ids) {
    const m = byId.get(id)
    if (m) {
      next.push(m)
      byId.delete(id)
    }
  }
  // 没被这次排序点名的模型（新加的、或隐藏的）按原序补到末尾，绝不能被排掉
  for (const m of models) if (byId.has(m.id)) next.push(m)
  const hidden = new Set(state.hidden)
  return { ok: true, models: next, order: next.filter((m) => !hidden.has(m.id)).map((m) => m.id) }
}
