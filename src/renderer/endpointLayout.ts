/**
 * 结论轴上落点的横向排布。
 *
 * 单独成模块只为了一件事：这条边界要能用数字测。它曾经只在「落点多到挤不下」
 * 那一支有上界，聚簇那一支一路往右推 —— 五个落点（远没到挤不下的门槛）就能把
 * 最后两个推到 380 之外、其中一个到 447，直接落在 viewBox（宽 400）外面，
 * 用户看到的就是「结论轴右边的点没有了」。
 */

/**
 * 给每个落点定一个横坐标，结果**保证**收在 [left, right] 内。
 *
 * 落点数 × minGap 放不下整条可用区间时等距排开；放得下就顺着来源聚簇，
 * 但聚簇产生的整体右移一旦越界，就把整排往回平移 —— 平移保得住点与点之间的
 * 疏密（那正是聚簇想表达的信息），只有绝对位置让位给画布边界。
 */
export function placeEndpoints(naturalXs: number[], left: number, right: number, minGap: number): number[] {
  const xs = [...naturalXs].sort((a, b) => a - b)
  const span = right - left
  if (!xs.length || span <= 0) return xs
  if (xs.length * minGap > span) {
    return xs.map((_, i) => left + ((i + 0.5) * span) / xs.length)
  }
  let prev = left
  const clustered = xs.map((x) => {
    const v = Math.max(x, prev)
    prev = v + minGap
    return v
  })
  const over = (clustered[clustered.length - 1] ?? 0) - right
  return over > 0 ? clustered.map((v) => v - over) : clustered
}
