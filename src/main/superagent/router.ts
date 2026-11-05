/**
 * 超智能体的 Router 层：人只跟它说话，它负责拆解、分派、回收。
 *
 * 这是 dsh 那篇《Super-agent 设计探索》的第一层：人能同时盯的会话数是有上限的
 * （他们的经验是三到五个），再往上瓶颈就不在模型而在人。所以要有一个常驻的
 * Router 替人盯着所有 Worker，人只需要给它一句指令。
 *
 * 两个硬规矩：
 * - **Router 不动手。** 它手里没有编辑文件、跑命令的工具，只有分派与回收。
 *   执行一律交给 Worker —— 否则「并行推进几个任务」退化成「一个人在几个会话里来回切」，
 *   加出来的架构一个字节都没省。
 * - **它只输出人能直接读的话。** 工具结果不外泄给界面：人看到的是 Router 转述的一句，
 *   想看 Worker 的原文就去点那一块活。
 */
import type { ApiConfig } from '../../shared/types'
import type { RouterEvent } from '../../shared/superagent'
import { SuperAgentTasks, describePermission, type SuperTask } from './tasks'

export type { RouterEvent }

export interface RouterDeps {
  /** 路由模型；没配就这一轮直接报清楚，不猜一个模型上去 */
  model: () => ApiConfig | null
  /** 凭据：与其它 API 通道一样只拿引用，Key 只从钥匙串走 */
  resolveKey: (ref: string) => string | null
  tasks: SuperAgentTasks
  agents: () => Array<{ id: string; title: string }>
  cwdOf: () => string
  emit: (ev: RouterEvent) => void
  log?: (e: { layer: string; stage: string; ok: boolean; detail: string; ts: number }) => void
}

const ROUTER_SYSTEM = `你是 Torra 编码工作台里的 Router（超智能体的协调层）。
人只跟你说一句话，你负责把这件事拆成几块互不干扰的活，分派给下面的 Worker，再把结果收回来讲清楚。

你手里的工具只有分派与回收，没有编辑文件、跑命令的能力 —— 执行一律交给 Worker。

做事的规矩：
- 先看清人要什么、在哪个目录里做。人没说目录就用默认工作目录。
- 能一次说完的活就派一个任务；需要并行验证、互相对照的活，就拆成几个任务，
  每个任务只做它自己那一块，别在任务里塞「顺便把另一个也看看」。
- 每个任务的目标要写成 Worker 照着就能动手的一句：做什么、边界在哪、做完什么样算成。
- 任务派下去之后用 task_output 看进度，不是干等。
- 有任务在等授权（waiting_input）时，先告诉人它在问什么，再决定要不要继续派新的活。
- 最后一定要用 finish 收一句人能直接读的结论：做了什么、还在跑什么、下一步是什么。`

/** 给模型的工具清单：与 execute 里的分支一一对应，改一处必须两处都改（测试守着这条） */
export const ROUTER_TOOLS = [
  {
    name: 'spawn_task',
    description: '分派一个 Worker 去干一件事。多个互不干扰的活应该拆成多个任务。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '这一块活的名字，人要能一眼认出来' },
        goal: { type: 'string', description: '交给 Worker 的完整目标：做什么、边界、做完什么样算成' },
        agent_id: { type: 'string', description: '用哪一家 Worker；不填就用默认那一家' },
        cwd: { type: 'string', description: '工作目录；不填就用默认目录' },
      },
      required: ['title', 'goal'],
    },
  },
  { name: 'list_tasks', description: '看所有任务的阶段与进度（分派后先看这个，不要干等）。', parameters: { type: 'object', properties: {} } },
  {
    name: 'task_output',
    description: '取某个任务的输出尾巴，看它现在说到哪儿了。',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' }, chars: { type: 'number', description: '取多少字，默认 1200' } },
      required: ['task_id'],
    },
  },
  {
    name: 'intervene',
    description: '往某个任务里插一句话（人追问时用）。',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' }, text: { type: 'string' } },
      required: ['task_id', 'text'],
    },
  },
  { name: 'cancel_task', description: '取消一个任务。', parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
  {
    name: 'finish',
    description: '向人汇报这一轮：做了什么、还在跑什么、下一步。说完这一轮就结束。',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
] as const

/**
 * 工具声明要按 wire 摊开：三家对 tools 的写法不一样，送错就是 422。
 *
 * chat-completions 要求 `{ type: 'function', function: { name, description, parameters } }`，
 * responses 要求扁平的 `{ type: 'function', name, description, parameters }`，
 * anthropic-messages 用 `input_schema` 而不是 `parameters`。
 * 内部只存一份（ROUTER_TOOLS），出口处按 wire 摊。
 */
type ToolParams = (typeof ROUTER_TOOLS)[number]['parameters']

export type WireTool =
  | { type: 'function'; function: { name: string; description: string; parameters: ToolParams } }
  | { type: 'function'; name: string; description: string; parameters: ToolParams }
  | { name: string; description: string; input_schema: ToolParams }

export function shapeTools(
  wire: 'chat-completions' | 'responses' | 'anthropic-messages',
): WireTool[] {
  if (wire === 'anthropic-messages') {
    return ROUTER_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }
  if (wire === 'responses') {
    return ROUTER_TOOLS.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  }
  return ROUTER_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
}))
}

/**
 * 历史消息也要按 wire 摊开 —— 和 tools 同一个道理，送错就是 422。
 *
 * chat-completions：assistant 带 `tool_calls` 数组，tool 结果用 `tool_call_id`（蛇形）。
 * responses：function_call / function_call_output 是顶层 item，配 call_id。
 * anthropic-messages：tool_use 是 assistant 的 content block，结果必须包进
 * 下一条 user 消息的 `tool_result` block。
 *
 * 内部历史只存一份结构化数据（calls / callId），出口处按 wire 摊。
 */
export type RouterHistory = Array<{
  role: 'user' | 'assistant' | 'tool'
  content: string
  calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  callId?: string
  name?: string
}>

export function shapeMessages(
  wire: 'chat-completions' | 'responses' | 'anthropic-messages',
  history: RouterHistory,
): Array<Record<string, unknown>> {
  if (wire === 'responses') {
    const out: Array<Record<string, unknown>> = []
    for (const m of history) {
      if (m.role === 'tool') {
        out.push({ type: 'function_call_output', call_id: m.callId, output: m.content })
        continue
      }
      if (m.role === 'assistant' && m.calls?.length) {
        if (m.content) out.push({ role: 'assistant', content: m.content })
        for (const c of m.calls) {
          out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) })
        }
        continue
      }
      out.push({ role: m.role, content: m.content })
    }
    return out
  }
  if (wire === 'anthropic-messages') {
    const out: Array<Record<string, unknown>> = []
    for (const m of history) {
      if (m.role === 'tool') {
        out.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.callId, content: m.content }],
        })
        continue
      }
      if (m.role === 'assistant' && m.calls?.length) {
        const blocks: Array<Record<string, unknown>> = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const c of m.calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
        out.push({ role: 'assistant', content: blocks })
        continue
      }
      out.push({ role: m.role, content: m.content })
    }
    return out
  }
  return history.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.callId, content: m.content }
    }
    if (m.role === 'assistant' && m.calls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      }
    }
    return { role: m.role, content: m.content }
  })
}

export class SuperRouter {
  private readonly deps: RouterDeps
  /** 一条历史。assistant 带工具调用的那轮存结构化 calls，发送时按 wire 摊开 */
  private history: Array<{
    role: 'user' | 'assistant' | 'tool'
    content: string
    calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
    callId?: string
    name?: string
  }> = []
  private busy = false
  /** 人点了「停下」：这一轮的 abort 控制器，也用来让循环在下一步之前收手 */
  private ctrl: AbortController | null = null
  private aborted = false

  constructor(deps: RouterDeps) {
    this.deps = deps
  }

  isBusy(): boolean {
    return this.busy
  }

  transcript(): string[] {
    return this.history.map((m) => `${m.role}${m.name ? `(${m.name})` : ''}: ${m.content}`)
  }

  /** 人发来的一句话：进入一轮 Router 循环 */
  async handle(text: string): Promise<void> {
    if (this.busy) {
      this.deps.emit({ kind: 'status', text: 'Router 还在上一轮里。它跑完会接着处理这句。' })
    }
    this.history.push({ role: 'user', content: text })
    this.busy = true
    this.aborted = false
    this.ctrl = new AbortController()
    try {
      await this.loop()
    } catch (e) {
      // 人叫停不算出错：界面上写一行「已停」就够了，不摆一条红色错误
      if (this.aborted) this.deps.emit({ kind: 'status', text: '已停下。' })
      else this.deps.emit({ kind: 'error', text: (e as Error).message })
    } finally {
      this.busy = false
      this.ctrl = null
      this.deps.emit({ kind: 'done' })
    }
  }

  /**
   * 人叫停这一轮。
   *
   * 正在等模型回包就断掉那条连接；已经在执行工具就等这一步收尾、下一步之前收手。
   * 历史照实留着 —— 停下不等于这一轮没发生过，但没回填的 tool_calls 不能留在
   * 历史里，所以循环每步之前都查这一位（见下面 `this.aborted` 的两处）。
   */
  abort(): void {
    this.aborted = true
    this.ctrl?.abort()
  }

  private async loop(): Promise<void> {
    for (let step = 0; step < 12; step++) {
      if (this.aborted) return
      const api = this.deps.model()
      if (!api) {
        this.deps.emit({ kind: 'error', text: '还没配路由模型。在设置里挑一个做 Router 的 API 模型。' })
        return
      }
      const reply = await this.call(api, this.history)
      // 正文一律先交给界面：模型这一轮可能只回正文（收口），也可能带着工具调用边想边做
      if (reply.text) this.deps.emit({ kind: 'text', delta: reply.text })
      if (reply.calls.length === 0) {
        this.history.push({ role: 'assistant', content: reply.text ?? '' })
        return
      }
      // 带工具调用的一轮：正文已经推出去了，接着执行工具。
      // calls 必须结构化存着 —— 发送时按 wire 摊成 tool_calls / tool_use / function_call；
      // 存成单薄的 toolCallId 字符串，下一轮请求就是「missing field tool_call_id」。
      this.history.push({
        role: 'assistant',
        content: reply.text ?? '',
        calls: reply.calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      })
      // 记账只在这一处：每条 tool_call 都必须回一条同 id 的 tool 消息，少一条就是
      // 400「insufficient tool messages following tool_calls」。所以先全部执行、全部回填，
      // 再决定要不要收口 —— 模型一轮里给出多个调用时，finish 之外的那几个也得有回音。
      let finished: { summary: string } | null = null
      for (const call of reply.calls) {
        if (this.aborted) {
          // 已经停下就不再真去派活，但**回音不能少**：这条 assistant 已经在历史里
          // 声明了这些 tool_call，少一条就是下一次请求的
          // 400「must be followed by tool messages」。所以补一条「没执行」。
          this.history.push({ role: 'tool', content: '已停下，这一步没有执行。', callId: call.id, name: call.name })
          continue
        }
        const r = await this.execute(call.name, call.args)
        this.deps.emit({ kind: 'tool', name: call.name, detail: r.detail })
        this.history.push({ role: 'tool', content: r.detail, callId: call.id, name: call.name })
        if (r.finish) finished = { summary: String(call.args.summary ?? '').trim() }
      }
      if (this.aborted) return
      if (finished) {
        // 收口那一句也要留在历史里（下一次轮次还看得见），但它必须排在所有 tool
        // 回填之后、且不带 calls —— 紧跟着 tool_calls 的必须先是 tool 消息。
        if (finished.summary) this.history.push({ role: 'assistant', content: finished.summary })
        return
      }
    }
    this.deps.emit({ kind: 'status', text: 'Router 转了 12 步还没收口，这一轮先停在这里。' })
  }

  private async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; detail: string; finish?: boolean }> {
    try {
      if (name === 'spawn_task') {
        const title = String(args.title ?? '').trim()
        const goal = String(args.goal ?? '').trim()
        const agentId = String(args.agent_id ?? '').trim()
        const known = this.deps.agents().find((a) => a.id === agentId)
        const target = known ?? this.deps.agents()[0]
        if (!title || !goal) return { ok: false, detail: 'spawn_task 需要 title 与 goal。' }
        if (!target) return { ok: false, detail: '没有可用的 Worker：先把一家编码智能体接进来。' }
        const t: SuperTask = await this.deps.tasks.spawn({
          title,
          goal,
          agentId: target.id,
          cwd: typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined,
        })
        return { ok: t.stage !== 'failed', detail: `已分派「${t.title}」给 ${t.agentTitle}（${t.stage}）。` }
      }
      if (name === 'list_tasks') {
        const rows = this.deps.tasks.list().map((t) => `${t.stage} · ${t.title}（${t.agentTitle}，第 ${t.rounds} 轮）`)
        return { ok: true, detail: rows.length ? rows.join('\n') : '还没有任务。' }
      }
      if (name === 'task_output') {
        const id = String(args.task_id ?? '')
        const t = this.deps.tasks.detail(id)
        if (!t) return { ok: false, detail: `没有任务 ${id}。` }
        const chars = typeof args.chars === 'number' && args.chars > 0 ? Math.min(args.chars, 4000) : 1200
        return { ok: true, detail: `${t.stage} · ${t.title}\n${t.outputTail.slice(-chars) || '（还没有输出）'}` }
      }
      if (name === 'intervene') {
        const r = await this.deps.tasks.intervene(String(args.task_id ?? ''), String(args.text ?? ''))
        return r.ok
          ? { ok: true, detail: '已插话。' }
          : { ok: false, detail: r.error ?? '插话没送进去。' }
      }
      if (name === 'cancel_task') {
        const id = String(args.task_id ?? '')
        const t = this.deps.tasks.detail(id)
        this.deps.tasks.cancel(id)
        return t ? { ok: true, detail: `已取消「${t.title}」。` } : { ok: false, detail: `没有任务 ${id}。` }
      }
      if (name === 'finish') {
        const summary = String(args.summary ?? '').trim()
        if (summary) this.deps.emit({ kind: 'text', delta: summary + '\n' })
        // 这里不碰历史：loop 已经记下了 assistant 的 calls，并在本轮回填 tool 结果。
        // 曾经在这里再塞一对 assistant+tool，等于给同一个 tool_call_id 记了两次账，
        // 下一条请求里 tool_calls 后面跟的是另一个 assistant —— 直接 400。
        return { ok: true, detail: '已向人汇报完毕。', finish: true }
      }
      return { ok: false, detail: `没有这个工具：${name}` }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  /**
   * 与模型的一次往返。
   *
   * 流式要的是「还在想」这件事本身：Router 一轮里可能要转好几步工具，
   * 不流式的话界面上是一段死等。正文走 delta，工具调用攒齐再执行。
   */
  private async call(
    api: ApiConfig,
    history: RouterHistory,
  ): Promise<{ text: string; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }> {
    const wire = api.wireApi ?? (api.protocol === 'anthropic' ? 'anthropic-messages' : 'chat-completions')
    const isResponses = wire === 'responses'
    const base = api.baseUrl.replace(/\/+$/, '')
    const url = wire === 'responses' ? `${base}/responses` : wire === 'anthropic-messages' ? anthropicMessagesUrl(api.baseUrl) : `${base}/chat/completions`
    const key = this.deps.resolveKey(api.apiKeyRef) ?? ''
    if (!key && !api.headersRef) throw new Error('路由模型缺少 API 凭据')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (wire === 'anthropic-messages') {
      headers['x-api-key'] = key ?? ''
      headers['anthropic-version'] = '2023-06-01'
    } else if (key) {
      headers.Authorization = `Bearer ${key}`
    }

    const tools = shapeTools(wire)
    const messages = shapeMessages(wire, history)
    const bodyFor = (stream: boolean) =>
      JSON.stringify(
        isResponses
          ? {
              model: api.model,
              input: [
                { role: 'system', content: [{ type: 'input_text', text: ROUTER_SYSTEM }] },
                ...messages,
              ],
              tools,
              ...(stream ? { stream: true } : {}),
            }
          : wire === 'anthropic-messages'
            ? {
                model: api.model,
                max_tokens: 4096,
                system: ROUTER_SYSTEM,
                messages,
                tools,
                ...(stream ? { stream: true } : {}),
              }
            : {
                model: api.model,
                messages: [{ role: 'system', content: ROUTER_SYSTEM }, ...messages],
                tools,
                tool_choice: 'auto',
                ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
              },
      )

    // 整轮封顶 5 分钟：Router 一轮里要转几步工具，但卡住不动的时候不能让人一直等。
    // 人点「停下」也走同一个信号：两条理由合成一条 signal，谁先到都算数。
    const timeout = AbortSignal.timeout(300_000)
    const signal = this.ctrl ? AbortSignal.any([timeout, this.ctrl.signal]) : timeout
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body: bodyFor(true), signal })
    } catch (e) {
      const err = e as Error
      if (this.aborted) throw new Error('已停下')
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error('路由模型 5 分钟内没有回完这一轮（可能卡住了）')
      }
      throw err
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`路由模型 HTTP ${res.status}: ${t.slice(0, 160)}`)
    }
    return parseRouterStream(res, isResponses, wire)
  }
}

/**
 * 把一次流式回包拆成「正文 + 工具调用」。
 *
 * 三种 wire 的事件形状不一样，但目标一样：正文要实时给界面，工具调用要攒齐。
 */
export async function parseRouterStream(
  res: Response,
  isResponses: boolean,
  wire: string,
): Promise<{ text: string; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let text = ''
  const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
  // 键用下标而不是调用 id：OpenAI 的流里 id 只在第一片出现，后面几片只带 index
  const byId = new Map<string, { id: string; name: string; args: string }>()
  // Anthropic 的块状态要跨事件留着：它是一块一块推进来的，
  // 放在 handle 里面的话每来一个事件就重建一次，后面的片永远对不上前面那块
  const anBlocks = new Map<number, { type: string; id?: string; name?: string; args: string; streamed?: boolean }>()
  const handle = (obj: Record<string, unknown>): void => {
    if (isResponses) {
      if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') {
        text += obj.delta
      }
      if (obj.type === 'response.output_item.added') {
        const item = obj.item as { type?: string; name?: string; call_id?: string } | undefined
        if (item?.type === 'function_call') {
          const key = String(item.call_id ?? '')
          byId.set(key, { id: key, name: String(item.name ?? ''), args: '' })
        }
      } else if (obj.type === 'response.function_call_arguments.delta') {
        const key = String(obj.item_id ?? '')
        const cur = byId.get(key)
        if (cur && typeof obj.delta === 'string') cur.args += obj.delta
      }
      if (obj.type === 'response.output_item.done') {
        const item = obj.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined
        if (item?.type === 'function_call') {
          const key = String(item.call_id ?? '')
          byId.set(key, { id: key, name: String(item.name ?? ''), args: String(item.arguments ?? '') })
        }
      }
      return
    }
    if (wire === 'anthropic-messages') {
      // Anthropic 的流式不是「一次性给整份 message」，而是一块一块推进来：
      // 一块 text 逐步给正文，一块 tool_use 逐步给入参。只认 message.content 的话，
      // 流式回包里一个字符都取不到 —— 界面会看着模型「一个字都没说」。
      const idxOf = (): number => (typeof obj.index === 'number' ? obj.index : -1)
      if (obj.type === 'content_block_start') {
        const cb = (obj.content_block ?? {}) as { type?: string; text?: string; id?: string; name?: string; input?: unknown }
        const i = idxOf()
        if (cb.type === 'text') {
          if (cb.text) text += cb.text
          anBlocks.set(i, { type: 'text', args: '' })
        } else if (cb.type === 'tool_use') {
          anBlocks.set(i, {
            type: 'tool_use',
            id: String(cb.id ?? `${i}`),
            name: String(cb.name ?? ''),
            args: cb.input !== undefined ? JSON.stringify(cb.input) : '',
          })
        }
      } else if (obj.type === 'content_block_delta') {
        const d = (obj.delta ?? {}) as { type?: string; text?: string; partial_json?: string }
        const blk = anBlocks.get(idxOf())
        if (d.type === 'text_delta' && d.text) text += d.text
        else if (d.type === 'input_json_delta' && blk?.type === 'tool_use') {
          // 分片才是入参的真源：start 里给的 input 通常只是占位 {}，
          // 拿它打底再拼分片会拼出一段谁都解析不了的 JSON
          if (blk.streamed) blk.args += d.partial_json ?? ''
          else {
            blk.streamed = true
            blk.args = d.partial_json ?? ''
          }
        }
      } else if (obj.type === 'content_block_stop') {
        const i = idxOf()
        const blk = anBlocks.get(i)
        if (blk?.type === 'tool_use') byId.set(blk.id ?? '', { id: blk.id ?? '', name: blk.name ?? '', args: blk.args })
        anBlocks.delete(i)
      } else if (obj.type === 'message') {
        // 整包形态：有些反代收了 stream:true 照旧一次回完
        const parts = (obj.message as { content?: unknown } | undefined)?.content
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const b = (part ?? {}) as { type?: string; text?: string; id?: string; name?: string; input?: string }
            if (b.type === 'text' && b.text) text += b.text
            if (b.type === 'tool_use') byId.set(String(b.id ?? ''), { id: String(b.id ?? ''), name: String(b.name ?? ''), args: String(b.input ?? '') })
          }
        }
      }
      return
    }
    const choice = (obj.choices as Array<{ delta?: { content?: string; tool_calls?: Array<{ id?: string; index?: number; function?: { name?: string; arguments?: string } }> } }> | undefined)?.[0]
    if (!choice) return
    if (typeof choice.delta?.content === 'string') text += choice.delta.content
    for (const tc of choice.delta?.tool_calls ?? []) {
      const key = String(tc.index ?? calls.length)
      const cur = byId.get(key)
      byId.set(key, {
        id: tc.id ?? cur?.id ?? key,
        name: (cur?.name ?? tc.function?.name ?? '').trim(),
        args: (cur?.args ?? '') + (tc.function?.arguments ?? ''),
      })
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const nl = buf.lastIndexOf('\n')
    if (nl < 0) continue
    const lines = buf.slice(0, nl).split('\n')
    buf = buf.slice(nl + 1)
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      // 半个 JSON 是流式里常有的事：解析不出来就丢这一帧，下一帧会补上。
      // 但 handle 自己出错不能一起吞掉 —— 那样会表现为「模型一个字都没说」，而且查不到原因。
      let frame: Record<string, unknown> | null = null
      try {
        frame = JSON.parse(payload) as Record<string, unknown>
      } catch {
        continue
      }
      handle(frame)
    }
  }
  for (const [key, c] of byId) calls.push({ id: c.id || key, name: c.name, args: safeJson(c.args) })
  return { text, calls }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Anthropic 兼容端点的完整路径：与 ApiAgent 同一份口径（带 /v1 就用它，没带就补）。
 */
function anthropicMessagesUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return `${/\/v1$/.test(base) ? base : `${base}/v1`}/messages`
}
export { describePermission }
