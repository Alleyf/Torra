/**
 * ACP 事件流 → 界面上的一行行。
 *
 * 单独成文件而不是塞在抽屉组件里，理由跟聊天历史那次一样：
 * 这一段是纯函数，没有 DOM、没有 React，ts-node 直接就能测。
 * 而它恰恰是最该被测的一段 —— 文字要接上一段、工具结果要按 id 找回去、
 * 结束时要收尾，这三条规则错了界面上就表现为「agent 的话断在半截」，
 * 而那种错只在真跑一轮的时候才看得出来。
 */

import type { AcpDiff, AcpEvent } from '../shared/acp'

/**
 * 一步里带回来的一次文件改动，外加算好的增删行数。
 *
 * 行数在**收事件时**算一次，而不是每帧渲染时再数：一次编辑的原文可能上千行，
 * 折进状态里跟着流式文字一起重算，滚动就会发涩。原文留着，审查面板要按它画。
 */
export interface AcpEdit extends AcpDiff {
  added: number
  removed: number
}

/** 界面画出来的一行 */
export type AcpLine =
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

/**
 * 把一条协议事件折进行里。
 *
 * 抽成纯函数是为了能离线测：这条路径上每一类事件都有各自的合并规则
 * （文字要接上一段、工具结果要按 id 找回去），藏在组件里就没人能证明它对。
 */
export function applyAcpEvent(lines: AcpLine[], event: AcpEvent, nextId: () => number): AcpLine[] {
  switch (event.kind) {
    case 'text': {
      if (!event.delta) return lines
      const last = lines[lines.length - 1]
      // 接着上一段说就接上去，被别的内容隔开了就另起一段
      if (last && last.kind === 'say') {
        return [...lines.slice(0, -1), { ...last, text: last.text + event.delta }]
      }
      return [...lines, { id: nextId(), kind: 'say', text: event.delta }]
    }
    case 'thinking': {
      if (!event.delta) return lines
      const last = lines[lines.length - 1]
      if (last && last.kind === 'think') {
        return [...lines.slice(0, -1), { ...last, text: last.text + event.delta }]
      }
      return [...lines, { id: nextId(), kind: 'think', text: event.delta }]
    }
    case 'tool-call':
      return [
        ...lines,
        {
          id: nextId(),
          kind: 'tool',
          toolId: event.id,
          title: event.title || event.name || '工具调用',
          status: event.status,
          toolKind: event.toolKind,
          running: !event.status || event.status === 'pending' || event.status === 'in_progress',
        },
      ]
    case 'tool-result': {
      const idx = lines.findIndex((l) => l.kind === 'tool' && l.toolId === event.id)
      const edits: AcpEdit[] | undefined = event.diffs?.map((d) => ({
        ...d,
        ...diffStat(d.oldText, d.newText),
      }))
      const done: AcpLine = {
        id: nextId(),
        kind: 'tool',
        toolId: event.id,
        title: '工具调用',
        status: event.status,
        out: event.text,
        running: false,
        edits,
      }
      // 找得到就补在那一步上；找不到（agent 先报了结果）就另起一步
      if (idx < 0) return [...lines, done]
      const merged: AcpLine =
        lines[idx]!.kind === 'tool'
          ? {
              ...(lines[idx] as Extract<AcpLine, { kind: 'tool' }>),
              status: event.status,
              out: event.text,
              running: false,
              edits: edits ?? (lines[idx] as Extract<AcpLine, { kind: 'tool' }>).edits,
            }
          : done
      return [...lines.slice(0, idx), merged, ...lines.slice(idx + 1)]
    }
    case 'plan':
      return [
        ...lines,
        {
          id: nextId(),
          kind: 'plan',
          entries: event.entries.map((e) => ({ content: e.content, status: e.status })),
        },
      ]
    case 'status':
      return [...lines, { id: nextId(), kind: 'notice', text: event.text }]
    case 'notice':
      return [...lines, { id: nextId(), kind: 'notice', text: event.text }]
    case 'error':
      return [...lines, { id: nextId(), kind: 'error', text: event.text }]
    case 'usage': {
      const bits: string[] = []
      if (typeof event.input === 'number') bits.push(`输入 ${event.input}`)
      if (typeof event.output === 'number') bits.push(`输出 ${event.output}`)
      if (typeof event.totalTokens === 'number') bits.push(`共 ${event.totalTokens} token`)
      if (typeof event.cost === 'number') bits.push(`花费 ${event.cost}`)
      if (!bits.length) return lines
      return [...lines, { id: nextId(), kind: 'tally', text: bits.join(' · ') }]
    }
    case 'mode':
      return [...lines, { id: nextId(), kind: 'notice', text: `「${event.name ?? event.optionId}」改成 ${event.value}` }]
    case 'settled':
      return [
        ...lines,
        { id: nextId(), kind: 'tally', text: event.stopReason ? `这一轮结束（${event.stopReason}）` : '这一轮结束' },
      ]
    default:
      return lines
  }
}
