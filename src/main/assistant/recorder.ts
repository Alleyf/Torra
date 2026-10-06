/**
 * 回合记账：把「这一轮花了多少、等了多久、调了谁」从 pi 的事件和消息里剥出来。
 *
 * 单独成一个纯模块的原因和 tools.ts 一样：这里不 import electron，也不 import pi
 * （只吃鸭子类型的对象），所以能在系统 Node 下用假事件做断言 —— TTFT、token 累加
 * 这种逻辑一旦只能靠起 app 来验，就没人验。
 *
 * 两条刻意的取舍：
 *
 * 1. **时钟从外面灌**。`begin(now)` / `finish(now)` 收时间戳，测试里传假时钟就能
 *    精确断言 ttftMs；真实调用不传，走 Date.now()。
 * 2. **历史恢复出来的统计没有 ttftMs**。首字延迟只有直播时才观测得到 ——
 *    会话文件里存的是整条消息，不是逐字到达的时刻。字段留空，界面显示「—」，
 *    不去编一个看起来合理的数。
 */

import type { AssistantHistoryItem, AssistantToolGroup, AssistantTurnStats } from '../../shared/assistant'

// ---------------------------------------------------------------------------
// 分组
// ---------------------------------------------------------------------------

/**
 * 一步调用是谁提供的。
 *
 * Torra 自己的工具统一带 `torra_` 前缀，剩下的名字都来自外部（技能 / 扩展 /
 * MCP 桥）。MCP 只能靠约定识别：pi 运行时不接 MCP，MCP 工具只可能是某个扩展
 * 桥进来的，而桥接器普遍把工具命名成 `mcp__server__tool`。技能同理，两条线索：
 * 工具名里带 skill，或这一步在读某个技能的 SKILL.md（技能被使用时的典型动作）。
 */
export function classifyTool(name: string, args?: unknown): AssistantToolGroup {
  const n = String(name ?? '').toLowerCase()
  if (n.startsWith('torra_')) return 'tool'
  if (n.startsWith('mcp') || n.includes('__mcp__') || n.includes('_mcp_')) return 'mcp'
  if (n.startsWith('skill') || n.startsWith('use_skill') || n.includes('_skill') || n.includes('_skills')) {
    return 'skill'
  }
  return readsSkillFile(args) ? 'skill' : 'tool'
}

const SKILL_FILE = /(^|[\\/])skills[\\/]|skill\.md/

function readsSkillFile(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false
  for (const v of Object.values(args as Record<string, unknown>)) {
    if (typeof v === 'string' && SKILL_FILE.test(v.toLowerCase())) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 实时回合
// ---------------------------------------------------------------------------

/** pi 的 Usage 形状：数值可能缺省，cost 是嵌套对象 */
interface UsageLike {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  cost?: { total?: number } | number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function costOf(u: UsageLike): number {
  const c = u.cost
  return typeof c === 'number' ? c : num(c?.total)
}

export interface TurnContext {
  contextTokens?: number | null
  contextWindow?: number
}

/**
 * 单轮计时器。一轮 = 一次 send 触发到 agent_settled，
 * 中间可能有多条 assistant 消息（思考→调工具→再看结果→说话），
 * token 与步数按整轮累加，不是按单条消息。
 */
export class TurnRecorder {
  private startAt = 0
  private firstTextAt: number | null = null
  private steps = 0
  private byGroup: Partial<Record<AssistantToolGroup, number>> = {}
  private usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  private model = ''

  constructor(private readonly displayName = '') {}

  begin(now = Date.now()): void {
    this.startAt = now
    this.firstTextAt = null
    this.steps = 0
    this.byGroup = {}
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  }

  /** 模型换了（一轮里可能换）以最后一次为准 */
  noteModel(name?: string): void {
    if (name) this.model = name
  }

  /** 第一个正文字符：只认第一次 */
  noteText(now = Date.now()): void {
    if (this.firstTextAt === null) this.firstTextAt = now
  }

  noteTool(group: AssistantToolGroup): void {
    this.steps += 1
    this.byGroup[group] = (this.byGroup[group] ?? 0) + 1
  }

  addUsage(u?: UsageLike): void {
    if (!u) return
    this.usage.input += num(u.input)
    this.usage.output += num(u.output)
    this.usage.cacheRead += num(u.cacheRead)
    this.usage.cacheWrite += num(u.cacheWrite)
    this.usage.cost += costOf(u)
  }

  finish(ctx: TurnContext = {}, now = Date.now()): AssistantTurnStats {
    const { input, output, cacheRead, cacheWrite, cost } = this.usage
    return {
      model: this.model || this.displayName,
      ms: Math.max(0, now - this.startAt),
      ...(this.firstTextAt === null ? {} : { ttftMs: Math.max(0, this.firstTextAt - this.startAt) }),
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost,
      steps: this.steps,
      byGroup: this.byGroup,
      ...(ctx.contextTokens == null ? {} : { contextTokens: ctx.contextTokens }),
      ...(ctx.contextWindow ? { contextWindow: ctx.contextWindow } : {}),
    }
  }
}

// ---------------------------------------------------------------------------
// 历史还原
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string }
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      const x = b as { type?: string; thinking?: string; text?: string }
      return x?.type === 'thinking' ? String(x.thinking ?? x.text ?? '') : ''
    })
    .join('')
    .trim()
}

/** 会话条目的 timestamp 是 ISO 串，消息对象上是毫秒数 */
function atOf(m: { timestamp?: unknown }): number | undefined {
  const t = m.timestamp
  if (typeof t === 'number' && Number.isFinite(t)) return t
  if (typeof t === 'string') {
    const parsed = Date.parse(t)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

function joinExcerpt(content: unknown): string {
  const t = textOf(content)
  return t.length > 300 ? `${t.slice(0, 300)}…` : t
}

/**
 * pi 的消息列表 → 渲染层历史。
 *
 * 和实时流不同的是，这里要把 toolResult 一起吃下来：它是磁盘上唯一记录
 * 「这一步成功还是失败、返回了什么」的地方，不读就还原不出工具卡片的状态。
 * 但不单独产出一条历史项 —— 结果已经挂在该步的 excerpt 上，再单列会把
 * 大段 JSON 泼到界面上。
 */
export function messagesToHistory(messages: readonly unknown[]): AssistantHistoryItem[] {
  const out: AssistantHistoryItem[] = []
  /** toolCallId → 该步在 out 里的下标，供 toolResult 回填状态 */
  const stepIndex = new Map<string, number>()
  let turn:
    | { startAt?: number; endAt?: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; steps: number; byGroup: Partial<Record<AssistantToolGroup, number>>; model?: string; anchor: number | null; lastStep: number | null }
    | null = null

  const openTurn = (at?: number) => {
    turn = { startAt: at, endAt: at, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, steps: 0, byGroup: {}, anchor: null, lastStep: null }
  }

  /** 把这一轮的账挂到它最后一条正文上；没有正文就挂到最后一条工具步上 */
  const closeTurn = () => {
    const t = turn
    turn = null
    if (!t) return
    const total = t.input + t.output + t.cacheRead + t.cacheWrite
    if (total === 0 && t.steps === 0 && !t.model) return
    const stats: AssistantTurnStats = {
      model: t.model ?? '',
      // 只有首尾时刻可依据：跨多条消息的一轮，ms 是这条链的时间差
      ms: t.startAt != null && t.endAt != null ? Math.max(0, t.endAt - t.startAt) : 0,
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
      totalTokens: total,
      cost: t.cost,
      steps: t.steps,
      byGroup: t.byGroup,
    }
    const anchor = t.anchor ?? t.lastStep ?? -1
    const head = anchor >= 0 ? out[anchor] : undefined
    if (head) head.stats = stats
  }

  for (const raw of messages) {
    const m = raw as {
      role?: string
      content?: unknown
      timestamp?: unknown
      usage?: UsageLike
      model?: string
      responseModel?: string
      toolCallId?: string
      isError?: boolean
    }
    const at = atOf(m)

    if (m?.role === 'user') {
      closeTurn()
      const t = textOf(m.content)
      if (!t) continue
      out.push({ role: 'user', text: t, ...(at == null ? {} : { at }) })
      openTurn(at)
      continue
    }

    if (m?.role === 'assistant') {
      if (!turn) openTurn(at)
      const cur = turn!
      cur.endAt = at ?? cur.endAt
      const u = m.usage
      if (u) {
        cur.input += num(u.input)
        cur.output += num(u.output)
        cur.cacheRead += num(u.cacheRead)
        cur.cacheWrite += num(u.cacheWrite)
        cur.cost += costOf(u)
      }
      const modelName = m.responseModel ?? m.model
      if (typeof modelName === 'string' && modelName) cur.model = modelName

      const blocks = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []
      const thought = thinkingOf(m.content)
      if (thought) out.push({ role: 'thinking', text: thought, ...(at == null ? {} : { at }) })
      for (const b of blocks) {
        if (b?.type === 'toolCall') {
          const name = String(b.name ?? '')
          const group = classifyTool(name, b.arguments ?? b.args)
          const idx = out.length
          out.push({ role: 'tool', text: '', toolName: name, group, ...(at == null ? {} : { at }) })
          const id = String(b.id ?? b.toolCallId ?? '')
          if (id) stepIndex.set(id, idx)
          cur.lastStep = idx
          cur.steps += 1
          cur.byGroup[group] = (cur.byGroup[group] ?? 0) + 1
        }
      }
      const t = textOf(m.content)
      if (t) {
        cur.anchor = out.length
        out.push({ role: 'assistant', text: t, ...(at == null ? {} : { at }) })
      }
      continue
    }

    if (m?.role === 'toolResult') {
      const idx = m.toolCallId ? stepIndex.get(String(m.toolCallId)) : undefined
      if (idx == null) continue
      const item = out[idx]
      if (!item) continue
      item.ok = m.isError !== true
      const excerpt = joinExcerpt(m.content)
      if (excerpt) item.excerpt = excerpt
      continue
    }
  }

  closeTurn()
  return out
}

/**
 * 会话文件里的条目 → 消息列表。
 *
 * SessionManager.getBranch() 返回的是混合条目（message / model_change / compaction /
 * custom…），只有 message 条目参与对话还原；compaction 条目后面的消息才是压缩后的
 * 上下文，直接顺着 branch 走就能拿到当前有效路径。
 */
export function entriesToMessages(entries: readonly unknown[]): unknown[] {
  return (entries as Array<{ type?: string; message?: unknown }>)
    .filter((e) => e?.type === 'message' && e.message)
    .map((e) => e.message)
}
