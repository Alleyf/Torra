/**
 * Host 领域层：agent 无关的那一套词表。
 *
 * 为什么要有这一层：ACP 协议讲的是「消息长什么样」，不回答「这一轮发生了什么」。
 * 直接把协议的 session/update 摊给界面，界面就得替每一家猜含义 ——
 * 而四家返回的 mode 各不相同、有的根本不给 turn 标识，猜出来的结论没法信。
 *
 * 所以中间加一层，把协议事件收成有身份的事件：
 *   - 每一轮有 turnId，每一步有 itemId，工具结果能按 id 找回去；
 *   - 文件改动只认协议里的 diff 内容块，不靠工具名猜；
 *   - 一轮结束时如果 agent 给了跨重启对得上的原生标识，就带上它（nativeTurnRef），
 *     没给就不给 —— 宁可空着，也不能塞一个「大概是这一轮」的假标识。
 *
 * 归约器（applyHostEvent）只有一份，主进程与渲染层共用：
 * 主进程拿它维护权威的那份内容，渲染层拿它维护眼前这份。
 * 两边各写一套合并规则，迟早会在「文字被别的内容隔开要不要另起一段」这种地方
 * 分叉，然后界面和历史对不上。
 */

import type { AcpMatrixCell } from './acp'

/** 一次文件改动：路径 + 改前 + 改后 */
export interface HostFileChange {
  path: string
  oldText: string
  newText: string
}

/** 计划里的一项 */
export interface HostPlanEntry {
  content: string
  status: string
  priority?: string
}

/**
 * 内容里的一条。
 *
 * 这套条目就是「一场会话发生过什么」的最小完整表示：谁说了什么、哪一步做了什么、
 * 改过哪些文件。协议事件收成它，界面画它，落盘的也是它。
 *
 * 每一条都带一个编号：它是这一条在账本里的位置，只增不改。
 * 编号存在的理由很实际 —— 界面用它当 React 的 key，而工具结果会**就地**补回
 * 原来那一步（不新开一条）。要是 key 会因为「补回」而变，那一步的展开状态
 * 会在每次工具返回时被打断。
 */
export type HostItem =
  /** 用户说的一句 / agent 的一段正文 */
  | { id: number; kind: 'message'; role: 'user' | 'agent'; turnId: string; text: string }
  /** agent 的思考 */
  | { id: number; kind: 'thinking'; turnId: string; text: string }
  /** 一步工具调用（结果回到同一步上） */
  | {
      id: number
      kind: 'tool'
      turnId: string
      itemId: string
      title: string
      name?: string
      toolKind?: string
      status?: string
      out?: string
      edits?: HostFileChange[]
      locations?: string[]
    }
  | { id: number; kind: 'plan'; turnId: string; entries: HostPlanEntry[] }
  | { id: number; kind: 'notice'; text: string }
  | { id: number; kind: 'usage'; turnId: string; input?: number; output?: number; totalTokens?: number; cost?: number }
  | { id: number; kind: 'tally'; text: string }
  | { id: number; kind: 'error'; text: string }

/**
 * Host 事件：带身份的中性事件。
 *
 * 事件是「流」，条目是「账本」：事件往界面推，条目进快照。
 * 两者分开，是因为界面要的是及时的增量，而恢复历史要的是一份完整的账本。
 */
export type HostEvent =
  /** 开一轮。text 是用户那一句 */
  | { kind: 'turn.started'; turnId: string; text: string; nativeTurnRef?: string }
  /** 正文或思考来了一片 */
  | { kind: 'message.delta'; turnId: string; channel: 'text' | 'thinking'; delta: string }
  /**
   * 用户那一句来了一片。
   *
   * 正常对话里用户那句是 Torra 自己发出去的（turn.started 带的就是它），
   * agent 回声一般不用管；但读回历史时只剩回声 —— 那一段只能从回放里找回来。
   */
  | { kind: 'user.delta'; turnId: string; delta: string }
  /** 一步开始 */
  | {
      kind: 'item.started'
      turnId: string
      itemId: string
      title: string
      name?: string
      toolKind?: string
      status?: string
    }
  /** 一步结束（结果回到同一步上） */
  | {
      kind: 'item.completed'
      turnId: string
      itemId: string
      status?: string
      text?: string
      edits?: HostFileChange[]
      locations?: string[]
    }
  | { kind: 'plan.updated'; turnId: string; entries: HostPlanEntry[] }
  /** 某一档变了 */
  | { kind: 'option.changed'; optionId: string; value: string; name?: string }
  | {
      kind: 'usage.updated'
      turnId: string
      input?: number
      output?: number
      totalTokens?: number
      cost?: number
    }
  | { kind: 'notice'; text: string }
  /** 一轮结束。nativeTurnRef 只在 agent 真的给了的时候才有 */
  | { kind: 'turn.completed'; turnId: string; stopReason?: string; nativeTurnRef?: string }
  /** 这一家出事了（进程退了、连接断了） */
  | { kind: 'session.faulted'; text: string }

/** 一轮的身份 */
export interface HostTurn {
  turnId: string
  /**
   * 这一轮在 agent 那边的原生标识。
   *
   * 只有 agent 自己给的才算：Torra 自己编的号（t1、t2）只在本进程里成立，
   * 重开之后对不上任何东西 —— 拿它当「持久身份」就是在承诺一件验不了的事。
   */
  nativeTurnRef?: string
}

/** 一场会话的快照：内容 + 每一轮的身份 */
export interface HostSnapshot {
  /** agent 那边的会话号（跨重启稳定的那一个） */
  nativeSessionId: string
  items: HostItem[]
  turns: HostTurn[]
}

/** 事件的包装：谁发来的 */
export interface HostEventPayload {
  agentId: string
  event: HostEvent
}

/**
 * 能不能接着聊 —— 三个档。
 *
 * 之所以要分三档而不是一个「支持/不支持」：ACP 协议给了 session/load，
 * 但「能读回历史」和「读回来的历史能和当时那一轮对上」是两件事。
 * 后者要跨进程验证，验证不了就不能说。
 */
export type HostResumeLevel =
  /** 能读回历史，而且每一轮都有跨重启对得上的标识 */
  | 'durable'
  /** 能读回历史，但轮次对不对得上没验过 */
  | 'history'
  /** 这一家不给历史 */
  | 'none'

export interface HostResume {
  level: HostResumeLevel
  /** 这一家给不给原生轮标识 */
  identity: 'durable' | 'ephemeral' | 'none'
  /** 人话：界面上照它说，别自己编 */
  reason: string
}

/**
 * 把一条事件收进账本。
 *
 * 合并规则只有三条，但每一条都有讲究：
 *   - 文字接着上一段就接上，被别的内容隔开了才另起一段；
 *   - 工具结果按 itemId 找回去，找不到就另起一步（有的 agent 先报结果）；
 *   - 收尾与用量各成一行小结，不混进正文。
 *
 * 纯函数，没有 DOM 也没有 React —— 所以它能被离线测。
 */
export function applyHostEvent(items: HostItem[], event: HostEvent): HostItem[] {
  switch (event.kind) {
    case 'turn.started':
      return [...items, { id: items.length, kind: 'message', role: 'user', turnId: event.turnId, text: event.text }]
    case 'message.delta': {
      if (!event.delta) return items
      const last = items[items.length - 1]
      if (event.channel === 'thinking') {
        // 接着上一段思考就接上，被别的内容隔开了才另起一段
        if (last && last.kind === 'thinking' && last.turnId === event.turnId) {
          return [...items.slice(0, -1), { ...last, text: last.text + event.delta }]
        }
        return [...items, { id: items.length, kind: 'thinking', turnId: event.turnId, text: event.delta }]
      }
      if (last && last.kind === 'message' && last.role === 'agent' && last.turnId === event.turnId) {
        return [...items.slice(0, -1), { ...last, text: last.text + event.delta }]
      }
      return [...items, { id: items.length, kind: 'message', role: 'agent', turnId: event.turnId, text: event.delta }]
    }
    case 'user.delta': {
      if (!event.delta) return items
      const last = items[items.length - 1]
      if (last && last.kind === 'message' && last.role === 'user' && last.turnId === event.turnId) {
        return [...items.slice(0, -1), { ...last, text: last.text + event.delta }]
      }
      return [...items, { id: items.length, kind: 'message', role: 'user', turnId: event.turnId, text: event.delta }]
    }
    case 'item.started':
      return [
        ...items,
        {
          id: items.length,
          kind: 'tool',
          turnId: event.turnId,
          itemId: event.itemId,
          title: event.title || event.name || '工具调用',
          name: event.name,
          toolKind: event.toolKind,
          status: event.status,
        },
      ]
    case 'item.completed': {
      const idx = items.findIndex((l) => l.kind === 'tool' && l.itemId === event.itemId)
      const done: HostItem = {
        id: items.length,
        kind: 'tool',
        turnId: event.turnId,
        itemId: event.itemId,
        title: '工具调用',
        status: event.status,
        out: event.text,
        edits: event.edits,
        locations: event.locations,
      }
      if (idx < 0) return [...items, done]
      const prev = items[idx]!
      if (prev.kind !== 'tool') return [...items.slice(0, idx), done, ...items.slice(idx + 1)]
      // 就地补回原来那一步：编号与展开状态都不变
      const merged: HostItem = {
        ...prev,
        status: event.status ?? prev.status,
        out: event.text ?? prev.out,
        edits: event.edits ?? prev.edits,
        locations: event.locations ?? prev.locations,
      }
      return [...items.slice(0, idx), merged, ...items.slice(idx + 1)]
    }
    case 'plan.updated':
      return [...items, { id: items.length, kind: 'plan', turnId: event.turnId, entries: event.entries }]
    case 'option.changed':
      return [
        ...items,
        { id: items.length, kind: 'notice', text: `「${event.name ?? event.optionId}」改成 ${event.value}` },
      ]
    case 'usage.updated': {
      const bits: string[] = []
      if (typeof event.input === 'number') bits.push(`输入 ${event.input}`)
      if (typeof event.output === 'number') bits.push(`输出 ${event.output}`)
      if (typeof event.totalTokens === 'number') bits.push(`共 ${event.totalTokens} token`)
      if (typeof event.cost === 'number') bits.push(`花费 ${event.cost}`)
      if (!bits.length) return items
      return [
        ...items,
        {
          id: items.length,
          kind: 'usage',
          turnId: event.turnId,
          input: event.input,
          output: event.output,
          totalTokens: event.totalTokens,
          cost: event.cost,
        },
      ]
    }
    case 'notice':
      return [...items, { id: items.length, kind: 'notice', text: event.text }]
    case 'turn.completed':
      return [
        ...items,
        { id: items.length, kind: 'tally', text: event.stopReason ? `这一轮结束（${event.stopReason}）` : '这一轮结束' },
      ]
    case 'session.faulted':
      return [...items, { id: items.length, kind: 'error', text: event.text }]
    default:
      return items
  }
}

/** 一场会话的名字：第一句用户输入压成一行 */
export function hostSessionTitle(items: HostItem[]): string {
  for (const item of items) {
    if (item.kind !== 'message' || item.role !== 'user') continue
    const one = item.text.replace(/\s+/g, ' ').trim()
    if (!one) continue
    return one.length > 36 ? `${one.slice(0, 36)}…` : one
  }
  return '新会话'
}

/**
 * 形状上就明显不是持久标识的，直接不认。
 *
 * 禁掉的是「位置编号」这一类：纯数字、replay-1、turn-2 这种。
 * 它们在一次执行里当然唯一，可重启之后指不回原来那一轮 —— 当成持久身份用，
 * 就是在承诺一件验不了的事。
 *
 * 随机 UUID 不在这里被禁：UUID 本身可能是持久存下来的，也可能是每次现生成的，
 * 光看形状分不出来。分出来的是跨进程比对那一步。
 */
export function looksUnstableTurnRef(value: string | undefined): boolean {
  if (!value) return true
  const v = value.trim()
  if (!v) return true
  if (/^\d+$/.test(v)) return true
  if (/^(replay|seq|sequence|index|counter|turn|msg|message|n)[-_]?\d+$/i.test(v)) return true
  return false
}

/**
 * 能不能接着聊：给界面一句话，外加一个能落进矩阵的结论。
 *
 * 三档的来历：
 *   - 这一家压根不提供读历史的能力 → 没有（none）。它的子进程一退，那一场就没了；
 *   - 提供了，但跨重启能不能和当时那一轮对上没验过 → 只有历史（history）；
 *   - 矩阵里验过了（换一台进程读回来，轮标识对得上） → 接着聊没问题（durable）。
 *
 * 为什么要靠矩阵而不是靠运行时：跨重启这件事在一次运行里根本验不出来 ——
 * 只能另起一个进程读回一遍再比。这件事只能在测量里做，界面照测量结果说。
 *
 * 放在 shared 而不是主进程：主进程算它是为了给界面一个结论，
 * 渲染层算它是为了给「归档的那一场」也有一致的说法 —— 两边必须同口径。
 */
export function judgeResume(input: {
  /** 协商结果里有没有读历史的能力 */
  loadSession: boolean
  /** 兼容矩阵里实测过的那一格（按 id + 版本） */
  cell?: AcpMatrixCell
  /** 这一轮实际看到的原生轮标识 */
  observedNativeTurnRef?: string
}): HostResume {
  const canLoad = input.loadSession
  if (!canLoad) {
    return {
      level: 'none',
      identity: 'none',
      reason: '这一家不提供历史：它的进程一退，那一场就没了，Torra 只能留一份自己画的记录。',
    }
  }
  const measured = input.cell?.resume
  if (measured?.identity === true) {
    return {
      level: 'durable',
      identity: 'durable',
      reason: '这一家支持读回历史，而且每一轮都有跨重启对得上的标识 —— 可以接着聊。',
    }
  }
  if (measured?.session === false) {
    return {
      level: 'none',
      identity: 'none',
      reason: '这一家说能读回历史，实测读不回来 —— 只能看 Torra 自己留下的记录。',
    }
  }
  const reason =
    measured?.identity === false
      ? '这一家支持读回历史，但轮次标识跨重启对不上 —— 历史能看，不能保证接得上原来那一轮。'
      : '这一家支持读回历史；跨重启能不能接上原来那一轮，还没验过。'
  return {
    level: 'history',
    identity: input.observedNativeTurnRef && !looksUnstableTurnRef(input.observedNativeTurnRef) ? 'ephemeral' : 'none',
    reason,
  }
}
