/**
 * 崩溃文案的归一层。
 *
 * React 的组件栈帮不上忙：真出问题时用户面前只有一片白。所以这里把「任何被抛出来的东西」
 * 收敛成一行能给人看、也能被 scripts 里的源码断言钉住的话。纯函数，不碰 React，
 * 为的是 ts-node 就能测。
 */

/** 一行放不下第二行：标题栏之外没人滚动一段长堆栈 */
const LINE_MAX = 180
/** 距上一次崩溃多久以内算「紧接着」——窗口内的连续次数决定还要不要劝人重试 */
export const RAPID_WINDOW_MS = 5000
/** 达到这个连续次数，重试基本是徒劳，界面转向「重新载入」 */
export const RAPID_LIMIT = 3

export interface CrashState {
  readonly at: number
  /** 快速连续崩溃的计数；隔得够久的上一次崩溃不并入 */
  readonly count: number
}

/** 从堆栈里挑第一个调用帧，只留「哪个文件的第几行第几列」 */
function ownFrame(stack: string | undefined): string | undefined {
  const line = (stack ?? '').split('\n').find((l, i) => i > 0 && l.trim().startsWith('at '))
  if (!line) return undefined
  const loc = line.match(/([^\s()]+:\d+:\d+)\s*\)?\s*$/)?.[1]
  if (!loc) return undefined
  // 打包后是整条 URL，屏幕上没人关心协议和主机名
  return loc.replace(/^https?:\/\/[^/]*\//, '').replace(/^.*[\\/]/, '')
}

function stringifyOdd(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // 循环引用的对象、被 revoke 的 Proxy……说清「这是个没法显示的东西」就够了
    return '[无法显示的异常对象]'
  }
}

/** 把任何被抛出的值变成一行话：Error 带来源位置，其余原样转述 */
export function crashLine(err: unknown): string {
  const message =
    err instanceof Error ? err.message
      : typeof err === 'string' ? err
        : err === undefined || err === null ? '（未给出原因）'
          : stringifyOdd(err)
  const where = err instanceof Error ? ownFrame(err.stack) : undefined
  const text = where ? `${message}（${where}）` : message
  const oneLine = text.replace(/\s*\n\s*/g, ' ').trim() || '（未给出原因）'
  return oneLine.length > LINE_MAX ? oneLine.slice(0, LINE_MAX - 1) + '…' : oneLine
}

/**
 * 记一次崩溃并判断是不是「紧接着又崩了」。
 *
 * 计数只看时间距离：一场崩溃后用户去倒了杯水，回来再点重试不该被算成连续失败。
 */
export function noteCrash(prev: CrashState | null, now: number): CrashState {
  const chained = prev !== null && now - prev.at <= RAPID_WINDOW_MS
  return { at: now, count: chained ? prev.count + 1 : 1 }
}

/** 还要不要劝人重试：连续次数到上限就说明崩在装配阶段，重试只是原地再撞一次 */
export function isRapidCrash(state: CrashState): boolean {
  return state.count >= RAPID_LIMIT
}
