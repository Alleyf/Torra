/**
 * 系统是否要求减少动效。
 *
 * 样式那边有一条全局规则会把所有时长压到 0，但「靠 JS 定时器撑住的一块遮罩」
 * 不受它管：关掉动画之后，幕会变成一块静止 1.2 秒的板子。所以这类由脚本
 * 计时的仪式动作要自己问一句，问不到就当没开。
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
