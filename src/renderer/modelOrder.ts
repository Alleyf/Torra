/**
 * 模型顺序的唯一口径。
 * 侧栏的拖动落点和设置页的上下移动共用这里的函数，避免两处各写一遍 splice
 * （两处一旦语义分家，就会出现「拖动后顺序与箭头调出的顺序不一致」）。
 */

/** 把 dragId 插到 targetId 之前；targetId 不在列表里就追加到末尾。 */
export function moveBefore(ids: readonly string[], dragId: string, targetId: string): string[] {
  if (dragId === targetId) return [...ids]
  const rest = ids.filter((x) => x !== dragId)
  const found = rest.indexOf(targetId)
  const at = found < 0 ? rest.length : found
  return [...rest.slice(0, at), dragId, ...rest.slice(at)]
}

/**
 * 上下移动一步：贴边或 id 不在列表里都原样返回（调用方据此把按钮置灰）。
 * 这里不能复用 moveBefore 去「插到下一位之前」—— 把 a 插到紧跟着它的 b 之前仍是原样，
 * 点 ↓ 就会看着没反应。所以先摘掉自己，再按目标下标插回去。
 */
export function moveStep(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const at = ids.indexOf(id)
  const to = at + delta
  if (at < 0 || to < 0 || to >= ids.length) return [...ids]
  const rest = [...ids.slice(0, at), ...ids.slice(at + 1)]
  return [...rest.slice(0, to), id, ...rest.slice(to)]
}
