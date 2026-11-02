/**
 * Host 账本 → 界面上的一行行。
 *
 * 单独成文件而不是塞在组件里，理由跟聊天历史那次一样：
 * 这一段是纯函数，没有 DOM、没有 React，ts-node 直接就能测。
 * 而它恰恰是最该被测的一段 —— 文字要接上一段、工具结果要按 id 找回去、
 * 结束时要收尾，这三条规则错了界面上就表现为「agent 的话断在半截」，
 * 而那种错只在真跑一轮的时候才看得出来。
 *
 * 这一版起，输入不再是协议事件而是 **Host 账本**（见 ../shared/host）。
 * 差别很实在：协议事件是「一片一片来的增量」，账本是「这一场到目前为止的全部」。
 * 界面上要画的是后者 —— 恢复一场旧会话时没有增量可听，只有一份账本。
 * 于是合并规则（文字接上一段、结果并回那一步）挪到了 shared 里，
 * 主进程与渲染层共用同一份，两边不会在「要不要另起一段」这种事上分叉。
 *
 * 这一层守着一件容易混的事：**改动**与**动过**是两回事。
 * 前者有改前改后（协议的 diff 内容块），能画对照、能数行数；
 * 后者只有路径（协议的 locations），只说明这一步碰过这个文件。
 * 两者分开折、分开画 —— 把只给了路径的当改动报，就是在替 agent 编一次改动。
 */

// 相对路径而不是 @shared 别名：这一段是纯逻辑，离线回归直接 ts-node 加载它，
// 而 ts-node 跑在主进程的 tsconfig 上，那里没有渲染层的别名。
import type { HostItem } from '../shared/host'

/**
 * 一步里带回来的一次文件改动，外加算好的增删行数。
 *
 * 行数在**收事件时**算一次，而不是每帧渲染时再数：一次编辑的原文可能上千行，
 * 折进状态里跟着流式文字一起重算，滚动就会发涩。原文留着，审查面板要按它画。
 */
export interface AcpEdit {
  path: string
  oldText: string
  newText: string
  added: number
  removed: number
}

/** 界面画出来的一行 */
export type AcpLine = AcpLineBase & {
  /**
   * 这一行属于哪一轮。
   *
   * 工作树要把光落回气泡，靠的就是这个值 —— 气泡上原样写成 `data-wtx-turn`，
   * 发光时按 id 查元素。按「第几个气泡」认人在并行步骤下一定认错。
   */
  turnId?: string
}

type AcpLineBase =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'say'; text: string }
  | { id: number; kind: 'think'; text: string }
  | {
      id: number
      kind: 'tool'
      toolId: string
      title: string
      status?: string
      out?: string
      running: boolean
      /** 协议里这一类的归类（edit / execute / read …），只用来挑图标 */
      toolKind?: string
      /** 这一步改过的文件 */
      edits?: AcpEdit[]
      /**
       * 这一步被点名「碰过」的文件。
       *
       * 它跟 edits 不是一回事，别拿去当改动用：locations 只有路径，
       * 没有改前改后 —— 有的 agent 只给路径不给 diff，这一类工具就是这种情况。
       * 所以界面上说「动过」，不说「改了」，也不拿它去数行数。
       */
      locations?: string[]
    }
  | { id: number; kind: 'notice'; text: string }
  | { id: number; kind: 'error'; text: string }
  | { id: number; kind: 'plan'; entries: { content: string; status: string }[] }
  | { id: number; kind: 'tally'; text: string }

/**
 * 改前改后各增删多少行。
 *
 * 按**行内容的重数**算（旧文里没有的行算新增，新文里没有的算删除），
 * 不跑 LCS：这个数字的用途是让人一眼看出改动的规模（要不要展开审查），
 * 不是生成补丁本身。重数口径下「改了三行」会记成 +3 −3，比「行数没变所以 +0 −0」
 * 诚实得多 —— 后者会把一次重写说成什么都没改。
 */
export function diffStat(oldText: string, newText: string): { added: number; removed: number } {
  const split = (s: string): string[] => {
    const arr = s ? s.split('\n') : []
    // 末行是否带换行会让 split 差一项：两边同口径地砍掉末尾空行
    if (arr.length && arr[arr.length - 1] === '') arr.pop()
    return arr
  }
  const oldLines = split(oldText)
  const newLines = split(newText)
  const tally = (lines: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const oldCount = tally(oldLines)
  const newCount = tally(newLines)
  let added = 0
  let removed = 0
  for (const [line, n] of newCount) {
    const before = oldCount.get(line) ?? 0
    if (n > before) added += n - before
  }
  for (const [line, n] of oldCount) {
    const after = newCount.get(line) ?? 0
    if (n > after) removed += n - after
  }
  return { added, removed }
}

/** 审查面板里的一行：类型 + 原文。类型只有「未动 / 删 / 增」三种 */
export type DiffRow = { t: ' ' | '-' | '+'; text: string }

/**
 * 画审查面板用的行。
 *
 * 保留相同的前缀与后缀，中间整段按「删光再加」摊开 —— 这不是补丁格式，
 * 是给人核对用的对照。真的按行对齐（LCS）会把「改了一个字」拆成
 * 均匀交错的增删，读起来更累；而中间整段摊开时，改前与改后各自是连续的，
 * 一眼就能看清换了哪一块。
 */
export function diffRows(oldText: string, newText: string): DiffRow[] {
  const split = (s: string): string[] => {
    const arr = s ? s.split('\n') : []
    if (arr.length && arr[arr.length - 1] === '') arr.pop()
    return arr
  }
  const a = split(oldText)
  const b = split(newText)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }
  const rows: DiffRow[] = []
  for (let i = 0; i < head; i++) rows.push({ t: ' ', text: a[i]! })
  for (let i = head; i < a.length - tail; i++) rows.push({ t: '-', text: a[i]! })
  for (let i = head; i < b.length - tail; i++) rows.push({ t: '+', text: b[i]! })
  for (let i = a.length - tail; i < a.length; i++) rows.push({ t: ' ', text: a[i]! })
  return rows
}

/**
 * 整个会话里改过的文件：同一条路径只留最后一次，增删数取那一回的。
 *
 * 一场会话改同一个文件五六次是常态。全部摊开会让审查面板变成一堆同名条目，
 * 用户要点五次才知道最后长什么样；只留最后一次，「现在是什么样」才是眼前的答案。
 */
export function sessionEdits(lines: AcpLine[]): AcpEdit[] {
  const byPath = new Map<string, AcpEdit>()
  for (const l of lines) {
    if (l.kind !== 'tool' || !l.edits) continue
    for (const e of l.edits) byPath.set(e.path, e)
  }
  return [...byPath.values()]
}

/**
 * 这一场里被碰过、却没拿到改动内容的文件。
 *
 * 有的 agent 只给路径不给 diff 内容块（协议里的 locations）。那时候审查面板
 * 画不出对照，可界面上仍然得说清这一轮动过哪些文件 —— 不说的话，
 * 「没画出来」会被读成「没动过」，而文件其实被动过。
 *
 * 判定是整场看的：某个路径在别处拿到了 diff，就按改动算，不再重复说「只动过」。
 * 顺序按第一次被点名的时间 —— 那是这件事发生的时间。
 */
export function sessionTouches(lines: AcpLine[]): string[] {
  const withDiff = new Set<string>()
  const touched: string[] = []
  const seen = new Set<string>()
  for (const l of lines) {
    if (l.kind !== 'tool') continue
    for (const e of l.edits ?? []) withDiff.add(e.path)
    for (const p of l.locations ?? []) {
      if (!p || seen.has(p)) continue
      seen.add(p)
      touched.push(p)
    }
  }
  return touched.filter((p) => !withDiff.has(p))
}

/** 渲染用的分组：连续的思考与工具合成一个步骤组，正文各自成段 */
export type AcpBlock =
  | { kind: 'user'; lines: AcpLine[] }
  | { kind: 'say'; lines: AcpLine[] }
  | { kind: 'steps'; lines: AcpLine[] }
  | { kind: 'single'; line: AcpLine }

/**
 * 把一行行事件收成一段段可读的内容。
 *
 * 收法跟助手那边一致：思考与工具折叠成一步，正文占一整段。
 * 外部 agent 的思考与工具常常穿插着来，不折叠的话一屏全是噪声。
 */
export function groupAcpLines(lines: AcpLine[]): AcpBlock[] {
  const blocks: AcpBlock[] = []
  for (const line of lines) {
    const last = blocks[blocks.length - 1]
    if (line.kind === 'think' || line.kind === 'tool') {
      if (last && last.kind === 'steps') last.lines.push(line)
      else blocks.push({ kind: 'steps', lines: [line] })
      continue
    }
    if (line.kind === 'user') {
      blocks.push({ kind: 'user', lines: [line] })
      continue
    }
    if (line.kind === 'say') {
      if (last && last.kind === 'say') last.lines.push(line)
      else blocks.push({ kind: 'say', lines: [line] })
      continue
    }
    blocks.push({ kind: 'single', line })
  }
  return blocks
}

/** 一条工具步骤还没跑完 */
function isRunning(status: string | undefined): boolean {
  return !status || status === 'pending' || status === 'in_progress'
}

/** 用量那一行的小结：跟账本里存的那几个数一一对应 */
function usageText(item: Extract<HostItem, { kind: 'usage' }>): string {
  const bits: string[] = []
  if (typeof item.input === 'number') bits.push(`输入 ${item.input}`)
  if (typeof item.output === 'number') bits.push(`输出 ${item.output}`)
  if (typeof item.totalTokens === 'number') bits.push(`共 ${item.totalTokens} token`)
  if (typeof item.cost === 'number') bits.push(`花费 ${item.cost}`)
  return bits.join(' · ')
}

/**
 * 把账本画成一行行。
 *
 * 这是「同一份内容、两种看法」里比较的那一种：账本管「发生了什么」，
 * 这一层管「怎么摆」。所以它是纯映射，没有合并规则 ——
 * 合并规则在 shared/host 的归约器里，那一处只有一份。
 */
export function linesFromItems(items: HostItem[]): AcpLine[] {
  const out: AcpLine[] = []
  for (const item of items) {
    const from = out.length
    switch (item.kind) {
      case 'message':
        out.push(
          item.role === 'user'
            ? { id: item.id, kind: 'user', text: item.text }
            : { id: item.id, kind: 'say', text: item.text },
        )
        break
      case 'thinking':
        out.push({ id: item.id, kind: 'think', text: item.text })
        break
      case 'tool': {
        const edits = item.edits?.map((e) => ({ ...e, ...diffStat(e.oldText, e.newText) }))
        const locations = item.locations?.filter(Boolean)
        out.push({
          id: item.id,
          kind: 'tool',
          toolId: item.itemId,
          title: item.title || item.name || '工具调用',
          status: item.status,
          out: item.out,
          running: isRunning(item.status),
          toolKind: item.toolKind,
          edits: edits?.length ? edits : undefined,
          locations: locations?.length ? locations : undefined,
        })
        break
      }
      case 'plan':
        out.push({
          id: item.id,
          kind: 'plan',
          entries: item.entries.map((e) => ({ content: e.content, status: e.status })),
        })
        break
      case 'notice':
        out.push({ id: item.id, kind: 'notice', text: item.text })
        break
      case 'usage': {
        const text = usageText(item)
        if (text) out.push({ id: item.id, kind: 'tally', text })
        break
      }
      case 'tally':
        out.push({ id: item.id, kind: 'tally', text: item.text })
        break
      case 'error':
        out.push({ id: item.id, kind: 'error', text: item.text })
        break
      default:
        break
    }
    // 轮号在这一层补：上面每一种只关心自己那一行的样子，
    // 而「属于哪一轮」对每一行都一样，写一遍比写十遍可靠。
    // notice / tally 这类不属于任何一轮的条目本来就没有轮号，照旧空着。
    if ('turnId' in item) {
      for (let i = from; i < out.length; i++) out[i]!.turnId = item.turnId
    }
  }
  return out
}
