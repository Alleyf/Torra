/**
 * 模型顺序的唯一口径。
 * 侧栏拖动落点走这里，设置页不再另配一份排序入口
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
