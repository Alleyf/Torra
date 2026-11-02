/**
 * ACP → Host 的投影器：把协议事件收成有身份的中性事件。
 *
 * 这一层是「谁家的 agent 都不特殊」的落点。它只做翻译，不做判断：
 *   - 协议给了什么就收什么（diff 内容块、locations、usage）；
 *   - agent 自己给的原生轮标识就带上，没给就不给；
 *   - 四家语义不同的东西（mode、config option）一律按数据原样传下去。
 *
 * 唯一需要动脑的地方是**原生轮标识**：它决定「这一场能不能在重开之后接着聊」。
 * 判断的依据有两条：
 *   1. 形状上就明显不是持久标识的（序号、replay-1 这种位置编号）直接不认；
 *   2. 形状上像不像不算数 —— 跨进程对不对得上，要靠重新读回一遍来比。
 *      那一步在活体测量里做（scripts/test-acp.ts --live-full），结果记进兼容矩阵。
 */
import {
  applyHostEvent,
  looksUnstableTurnRef,
  type HostEvent,
  type HostFileChange,
  type HostItem,
  type HostPlanEntry,
  type HostSnapshot,
  type HostTurn,
} from '../../shared/host'

/** 从协议的内容块里取能显示的字：文本直取，资源取内嵌文本，其余给个占位 */
export function contentText(content: unknown): string {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).join('')
  if (typeof content !== 'object') return ''
  const c = content as Record<string, unknown>
  if (typeof c.text === 'string') return c.text
  /*
   * 套一层的内容块：{type:'content', content:{type:'text', text:…}}
   *
   * 这一层不是多余的 —— 协议早年的工具结果就是这么包的，各家至今两种都有。
   * 不拆开的话，工具跑完的那句话会变成一个没头没尾的「[content]」，
   * 界面上只剩一个标签，看不到它到底干了什么。
   */
  if (c.content !== undefined && c.content !== null) return contentText(c.content)
  if (c.resource && typeof c.resource === 'object') {
    const r = c.resource as Record<string, unknown>
    if (typeof r.text === 'string') return r.text
    if (typeof r.uri === 'string') return `[${r.uri}]`
  }
  if (typeof c.type === 'string') return `[${c.type}]`
  return ''
}

/**
 * 工具调用结果拆成两样东西：给人看的一段话，和能画成审查面板的改动。
 *
 * diff 块既算正文（一行行折在步骤后面），也单独留一份 —— 审查面板要的是
 * 路径与改前改后原文，而不是把三种东西缝在一起的字符串。
 */
export function toolOutputParts(content: unknown): { text: string; diffs: HostFileChange[] } {
  if (!Array.isArray(content)) return { text: contentText(content), diffs: [] }
  const diffs: HostFileChange[] = []
  const text = content
    .map((item) => {
      if (item && typeof item === 'object' && 'type' in item) {
        const t = (item as Record<string, unknown>).type
        if (t === 'diff') {
          const d = item as Record<string, unknown>
          const path = typeof d.path === 'string' ? d.path : ''
          const oldText = typeof d.oldText === 'string' ? d.oldText : ''
          const newText = typeof d.newText === 'string' ? d.newText : ''
          if (path) diffs.push({ path, oldText, newText })
          return `--- ${path}\n${oldText}\n+++\n${newText}`
        }
      }
      return contentText(item)
    })
    .filter(Boolean)
    .join('\n')
  return { text, diffs }
}

/**
 * 原生轮标识可能藏在哪些字段名里。
 *
 * 协议没有规定这一项 —— 各家 agent 自己带出来的，命名也就五花八门。
 * 所以这里按「末段名字」认：turnId / turn_id / nativeTurnRef / turnRef 都算，
 * 带命名空间的（x.ai/turnId、acp/turnId）拆出末段再认。
 */
const TURN_REF_FIELDS = new Set(['turnid', 'turn_id', 'nativeturnref', 'turnref', 'turn_ref'])

/**
 * 从一块 _meta 里读原生轮标识。
 *
 * 只认字符串，且不能是空串 —— 一个空标识等于没有标识。
 */
export function readNativeTurnRef(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (typeof value !== 'string' || !value) continue
    const tail = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    if (TURN_REF_FIELDS.has(tail.toLowerCase())) return value
  }
  return undefined
}

/**
 * ACP → Host 的投影器。
 *
 * 它同时是这一场会话的账本：事件进来，账本跟着长；需要恢复时，账本就是快照。
 */
export class AcpHostProjector {
  #items: HostItem[] = []
  #turns: HostTurn[] = []
  #turnSeq = 0
  #current?: HostTurn
  /**
   * 当前这一轮是不是「Torra 亲手开的」。
   *
   * 这个区别只为一件事服务：原生标识在什么情况下算「变了」。
   *   - 亲手开的一轮里标识变了 → 同一轮里它变了，说明它不是稳定标识，记漂移；
   *   - 回放时标识变了 → 那是换了一轮，开新一轮。
   * 两种情况都叫「标识不一样了」，但结论完全相反，不能混着处理。
   */
  #currentExplicit = false
  /**
   * 这一轮里原生标识换过几次。
   *
   * 同一轮里换过，说明它不是稳定标识 —— 这种要记下来，不能当持久身份用。
   */
  #refDrift = false
  /**
   * 这是不是回放模式。
   *
   * 读回历史与实时对话有两处不一样：
   *   - 实时时用户那句是 Torra 自己发的，agent 的回声照收会在界面上多出一句重复；
   *   - 回放时没有「现在这一轮」，轮的边界只能靠原生标识切出来。
   * 所以回放要用另一个投影器，不能拿实时那套硬套。
   */
  readonly #replay: boolean

  constructor(opts: { replay?: boolean } = {}) {
    this.#replay = opts.replay === true
  }

  /** 这一场的账本 */
  get items(): HostItem[] {
    return this.#items
  }

  /** 每一轮的身份 */
  get turns(): HostTurn[] {
    return this.#turns
  }

  /** 当前这一轮（没有就 undefined） */
  get currentTurn(): HostTurn | undefined {
    return this.#current
  }

  /** 开一轮 */
  beginTurn(text: string, nativeTurnRef?: string): HostEvent[] {
    const turn = this.#openTurn(true, nativeTurnRef)
    return this.#apply([{ kind: 'turn.started', turnId: turn.turnId, text, nativeTurnRef: turn.nativeTurnRef }])
  }

  /** 收尾一轮 */
  completeTurn(stopReason?: string, nativeTurnRef?: string): HostEvent[] {
    const turn = this.#current ?? this.#implicitTurn()
    if (nativeTurnRef && !looksUnstableTurnRef(nativeTurnRef)) {
      if (turn.nativeTurnRef && turn.nativeTurnRef !== nativeTurnRef) this.#refDrift = true
      else turn.nativeTurnRef = nativeTurnRef
    }
    const events: HostEvent[] = [
      { kind: 'turn.completed', turnId: turn.turnId, stopReason, nativeTurnRef: turn.nativeTurnRef },
    ]
    this.#current = undefined
    this.#currentExplicit = false
    return this.#apply(events)
  }

  /**
   * 收一条协议事件（session/update）。
   *
   * 返回的是 Host 事件：调用方拿去推给界面，投影器自己也把它们记进账本。
   */
  project(params: Record<string, unknown>): HostEvent[] {
    const update = (params.update ?? {}) as Record<string, unknown>
    const kind = String(update.sessionUpdate ?? '')
    // 原生轮标识可能挂在这一条通知的 _meta 上；认出来就记到当前这一轮
    const ref = readNativeTurnRef(params._meta) ?? readNativeTurnRef(update._meta)
    if (ref) this.#noteRef(ref)
    const turnId = (this.#current ?? this.#implicitTurn()).turnId

    switch (kind) {
      case 'agent_message_chunk':
        return this.#apply([{ kind: 'message.delta', turnId, channel: 'text', delta: contentText(update.content) }])
      case 'agent_thought_chunk':
        return this.#apply([{ kind: 'message.delta', turnId, channel: 'thinking', delta: contentText(update.content) }])
      case 'user_message_chunk': {
        /*
         * 实时时这一句要略过：用户那句是 Torra 自己发出去的（turn.started 带的就是它），
         * agent 再回声一次，界面上就会多出一句重复的话。
         * 回放时相反 —— 那时没有「Torra 发的」那一份，只剩 agent 存下来的回声，
         * 用户那半边只能从回放里找回来。
         */
        if (!this.#replay) return []
        return this.#apply([{ kind: 'user.delta', turnId, delta: contentText(update.content) }])
      }
      case 'tool_call':
        return this.#apply([
          {
            kind: 'item.started',
            turnId,
            itemId: String(update.toolCallId ?? ''),
            title: String(update.title ?? ''),
            name: typeof update.name === 'string' ? update.name : undefined,
            toolKind: typeof update.kind === 'string' ? update.kind : undefined,
            status: typeof update.status === 'string' ? update.status : undefined,
          },
        ])
      case 'tool_call_update': {
        const { text, diffs } = toolOutputParts(update.content)
        // locations 是协议给的「这一步碰了哪些文件」：有的 agent 不给 diff 只给路径，
        // 那时审查面板没东西可画，但界面上仍要说清这一轮动过哪些文件
        const locations = Array.isArray(update.locations)
          ? update.locations
              .map((l) => String((l as Record<string, unknown>).path ?? ''))
              .filter(Boolean)
          : []
        return this.#apply([
          {
            kind: 'item.completed',
            turnId,
            itemId: String(update.toolCallId ?? ''),
            status: typeof update.status === 'string' ? update.status : undefined,
            text: text || undefined,
            edits: diffs.length ? diffs : undefined,
            locations: locations.length ? locations : undefined,
          },
        ])
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : []
        const plan: HostPlanEntry[] = entries.map((e) => {
          const item = e as Record<string, unknown>
          return {
            content: String(item.content ?? ''),
            status: String(item.status ?? 'pending'),
            priority: typeof item.priority === 'string' ? item.priority : undefined,
          }
        })
        return this.#apply([{ kind: 'plan.updated', turnId, entries: plan }])
      }
      case 'current_mode_update':
        return this.#apply([
          { kind: 'option.changed', optionId: 'mode', value: String(update.currentModeId ?? '') },
        ])
      case 'config_option_update': {
        // 协议给的是「一份选项清单」，不是「某一项变了」：逐项发，界面按 id 覆盖自己的当前值
        const list = Array.isArray(update.configOptions) ? update.configOptions : []
        const events: HostEvent[] = []
        for (const raw of list) {
          const opt = raw as Record<string, unknown>
          const id = String(opt.id ?? '')
          if (!id) continue
          events.push({
            kind: 'option.changed',
            optionId: id,
            value: typeof opt.currentValue === 'boolean' ? String(opt.currentValue) : String(opt.currentValue ?? ''),
            name: typeof opt.name === 'string' ? opt.name : undefined,
          })
        }
        return this.#apply(events)
      }
      case 'usage_update':
        return this.#apply([
          {
            kind: 'usage.updated',
            turnId,
            input: numberOrUndef(update.inputTokens ?? update.input),
            output: numberOrUndef(update.outputTokens ?? update.output),
            totalTokens: numberOrUndef(update.totalTokens),
            cost: numberOrUndef(update.cost),
          },
        ])
      case 'notice':
        return this.#apply([{ kind: 'notice', text: contentText(update.content) || String(update.message ?? '') }])
      case 'session_info_update':
      case 'available_commands_update':
      case 'compaction_update':
      case 'compaction_summary_chunk':
      default:
        return []
    }
  }

  /** 快照：内容 + 每一轮的身份 */
  snapshot(nativeSessionId: string): HostSnapshot {
    return { nativeSessionId, items: [...this.#items], turns: [...this.#turns] }
  }

  /**
   * 接着上一份账本往下编号。
   *
   * 恢复一场之后接着聊，新的轮次不能跟旧的重号：界面按 turnId 认「这是哪一轮」，
   * 重号会让两轮的正文粘在一起 —— 旧账在前、新账在后，编号却一样。
   */
  continueAfter(snapshot: HostSnapshot): void {
    const n = snapshot.turns.length
    if (n > this.#turnSeq) this.#turnSeq = n
  }

  /**
   * 记一个原生轮标识。
   *
   * 「标识变了」有两种意思，结论完全相反，所以必须分开看：
   *   - 亲手开的一轮（实时对话）里变了 → 同一轮它换了个说法，说明它不是稳定标识，记漂移；
   *   - 回放时变了 → 那是换了一轮，开新一轮。
   *
   * 只认形状上稳定的标识（序号、replay-1 那种直接不认）：位置编号在重启之后
   * 指不回原来那一轮，拿它当持久身份就是在承诺一件验不了的事。
   */
  #noteRef(ref: string): void {
    if (looksUnstableTurnRef(ref)) return
    const turn = this.#current
    if (!turn) {
      // 还没有轮：这一条通知自己开一轮（回放时的第一轮就是这样来的）
      this.#openTurn(false, ref)
      return
    }
    if (turn.nativeTurnRef === ref) return
    if (!turn.nativeTurnRef) {
      turn.nativeTurnRef = ref
      return
    }
    if (this.#currentExplicit) {
      this.#refDrift = true
      return
    }
    this.#openTurn(false, ref)
  }

  /** 认下一条原生轮标识（答复里的 _meta） */
  noteTurnRef(ref: string | undefined): void {
    if (ref) this.#noteRef(ref)
  }

  /** 这一轮里原生标识有没有漂移过 */
  get refDrifted(): boolean {
    return this.#refDrift
  }

  /** 没有当前轮时临时开一轮：读回历史时 agent 直接开始回放，不会先发 prompt */
  #implicitTurn(): HostTurn {
    if (this.#current) return this.#current
    return this.#openTurn(false)
  }

  /** 开一轮并记进账本。explicit 表示这是 Torra 亲手开的那一轮 */
  #openTurn(explicit: boolean, nativeTurnRef?: string): HostTurn {
    const turn: HostTurn = { turnId: `t${++this.#turnSeq}` }
    if (nativeTurnRef && !looksUnstableTurnRef(nativeTurnRef)) turn.nativeTurnRef = nativeTurnRef
    this.#turns.push(turn)
    this.#current = turn
    this.#currentExplicit = explicit
    this.#refDrift = false
    return turn
  }

  /** 把事件记进账本，同时交还给调用方 */
  #apply(events: HostEvent[]): HostEvent[] {
    for (const event of events) this.#items = applyHostEvent(this.#items, event)
    return events
  }
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
