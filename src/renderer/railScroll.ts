/**
 * 右栏滚动的一点算术：要把某张判断卡滚进可视区，`scrollTop` 该加多少。
 *
 * 为什么单独成文件：这条判断有三个容易写错的边 —— 卡在折线以下要往下滚、
 * 卡在折线以上要往上滚、卡比可视区还高时不能对齐底部（那样标题行永远看不见）。
 * 三个都能只用两个矩形算出来，不碰 DOM，因此可以离线钉住。
 * 真正动手滚的那一下在 `InsightRail`：只有它知道滚的是哪一层。
 */

/** 一段竖直区间（视口的 top/bottom 或元素的 top/bottom） */
export interface VSpan {
  top: number
  bottom: number
}

/**
 * 把 `box` 滚进 `view` 需要给 `scrollTop` 加的增量（0 = 已经在里面，不用动）。
 *
 * 只做最小移动（等价于 `block: 'nearest'`）：部分可见时只补差的那一截。
 * 对中或对齐顶部都会把上一条读了一半的判断顶出屏幕 —— 定位是为了让人看见
 * 落点，不是把别人的阅读位置清掉。
 */
export function revealDelta(view: VSpan, box: VSpan): number {
  const viewH = view.bottom - view.top
  const boxH = box.bottom - box.top
  /* 比可视区还高：对齐顶部。对齐底部会让标题行滚到折线以上，只露出一条尾巴 */
  if (boxH >= viewH) return box.top - view.top
  if (box.top < view.top) return box.top - view.top
  if (box.bottom > view.bottom) return box.bottom - view.bottom
  return 0
}
