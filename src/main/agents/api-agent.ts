/**
 * ApiAgent —— OpenAI 兼容协议直连（PRD 6.4）
 *
 * 支持 SSE 流式与 usage 统计（webview 通道拿不到精确 token）。
 * API 优先原则：同时配置了 Key 与网页登录时，默认走本通道（PRD 6.4）。
 */

import type { ApiConfig, AgentStatus, ChatImage, TokenUsage, TurnContext } from '../../shared/types'
import { AgentError, type Agent, type SendResult } from './agent'
import { renderDigestForPrompt } from '../../shared/invariants'
import { diag } from '../diagnostics/log'

/**
 * 一次 API 发言的尝试上限。第三方兼容端点（尤其反代）常偶发把 SSE 流提前掐断，
 * 只回半截甚至空串 —— 助手用的 pi SDK 会自行重试扛过去，而这条手写通道此前
 * 一次都不重试，于是议事厅里表现为「模型一个字都没说」。这里补有限次重试。
 */
const MAX_API_ATTEMPTS = 3

/** 上游可重试的软失败（网络断开 / 超时 / 5xx / 429 / 流被掐断）；区别于鉴权等硬失败 */
class RetryableApiError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 去掉结尾斜杠：拼路径时少一类「双斜杠」事故 */
const trimBase = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '')

/**
 * Anthropic 兼容端点的完整路径。
 *
 * 助手用的 pi SDK 把 baseUrl 当作「不含 /v1 的站点根」，自己补 /v1/messages；
 * 这条通道过去补的是 {baseUrl}/messages，于是同一个配置在两条通道上打到两个地址 ——
 * 助手聊得好好的，议事厅里一个字都没说（网关把未匹配的 POST 回成 200 的前端页）。
 * 统一到 UI/doctor 宣称的 OpenAI 口径：带 /v1 就用它，没带就补，两边都拼不出 /v1/v1。
 */
export function anthropicMessagesUrl(baseUrl: string): string {
  const base = trimBase(baseUrl)
  return `${/\/v1$/.test(base) ? base : `${base}/v1`}/messages`
}

/** 整包（非流式）响应的解析结果 */
export type WholeReply =
  | { kind: 'text'; text: string; thinking: string; promptTokens: number; completionTokens: number; stop: string }
  | { kind: 'error'; message: string }

/**
 * 有些网关收了 stream:true 却照旧整包回一段 JSON（第三方反代很常见）。
 * 这类响应里一个 data: 行都没有，按流解析等于把能用的模型判成哑巴，
 * 所以在这里补一条退路：认得 OpenAI 与 Anthropic 两种整包形态，含 usage 与思维链。
 * 不是 JSON（前端页、纯文本报错）时返回 null，交给调用方如实报错。
 */
export function parseWholeReply(raw: string, anthropic: boolean): WholeReply | null {
  const t = raw.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null
  let j: unknown
  try {
    j = JSON.parse(t)
  } catch {
    return null
  }
  const o = (j ?? {}) as Record<string, any>
  if (o.error) {
    const e = o.error
    const msg = typeof e === 'string' ? e : String(e.message ?? e.msg ?? JSON.stringify(e).slice(0, 200))
    return { kind: 'error', message: `${msg}${e.type ? `（${e.type}）` : ''}` }
  }
  if (anthropic) {
    const blocks = Array.isArray(o.content) ? o.content : []
    const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('')
    const thinking = blocks.filter((b: any) => b?.type === 'thinking').map((b: any) => String(b.thinking ?? '')).join('')
    if (!text && !thinking && !o.stop_reason) return null
    return {
      kind: 'text',
      text,
      thinking,
      promptTokens: Number(o.usage?.input_tokens) || 0,
      completionTokens: Number(o.usage?.output_tokens) || 0,
      stop: String(o.stop_reason ?? ''),
    }
  }
  const ch = Array.isArray(o.choices) ? o.choices[0] : undefined
  if (!ch?.message && !ch?.finish_reason) return null
  const msg = ch.message ?? {}
  return {
    kind: 'text',
    text: String(msg.content ?? ''),
    thinking: String(msg.reasoning_content ?? msg.reasoning ?? ''),
    promptTokens: Number(o.usage?.prompt_tokens) || 0,
    completionTokens: Number(o.usage?.completion_tokens) || 0,
    stop: String(ch.finish_reason ?? ''),
  }
}

export class ApiAgent implements Agent {
  readonly transport = 'api' as const
  status: AgentStatus = 'ready'

  constructor(
    readonly id: string,
    readonly displayName: string,
    readonly color: string,
    private readonly cfg: ApiConfig,
    private readonly resolveKey: (ref: string) => string | null,
  ) {}

  async healthCheck(): Promise<boolean> {
    if (!this.resolveKey(this.cfg.apiKeyRef)) {
      this.status = 'disabled'
      return false
    }
    this.status = 'ready'
    return true
  }

  async send(
    ctx: TurnContext,
    onDelta: (chunk: string) => void,
    onThinking?: (chunk: string) => void,
  ): Promise<SendResult> {
    this.status = 'busy'
    const apiKey = this.resolveKey(this.cfg.apiKeyRef)
    if (!apiKey) {
      this.status = 'disabled'
      throw new AgentError('channel-error', `${this.displayName} 缺少 API Key`)
    }

    const anthropic = this.cfg.protocol === 'anthropic'
    const { body, sysText, userText } = this.buildRequest(ctx)

    let lastError = ''
    for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt++) {
      /*
       * 只有首轮把增量实时喂给 UI。重试若也流式，半截内容会先渲染出来、
       * 再被下一轮的整段覆盖 —— 观感就是「说了个开头又吞回去」。
       * 编排层取的是 res.content（优先于它自己累积的 acc），所以静默重试
       * 不影响最终落定的正文，只是让重来的那几次别在屏幕上留残影。
       */
      const stream = attempt === 1 ? onDelta : () => {}
      const think = attempt === 1 ? onThinking : undefined
      const t0 = Date.now()
      diag.log({
        ts: t0,
        layer: 'runtime',
        stage: 'api-request',
        subject: this.id,
        ok: true,
        detail: `proto=${anthropic ? 'anthropic' : 'openai'} model=${this.cfg.model} attempt=${attempt} sysChars=${sysText.length} userChars=${userText.length} history=${ctx.chat ? ctx.chat.history.length : 0}`,
      })
      try {
        const r = await this.rawCall(anthropic, apiKey, body, stream, think)
        const hasText = r.content.trim().length > 0 || r.thinking.trim().length > 0
        if (r.finished && hasText) {
          diag.log({
            ts: t0,
            layer: 'runtime',
            stage: 'api-response',
            subject: this.id,
            ok: true,
            ms: Date.now() - t0,
            detail: `attempt=${attempt} chars=${r.content.length} thinkChars=${r.thinking.length} tok=${r.usage.promptTokens}/${r.usage.completionTokens} stop=${r.stopReason || '-'}${r.nonStream ? ' whole=1' : ''}`,
          })
          this.status = 'ready'
          return {
            content: r.content,
            usage: r.usage,
            targets: ctx.callout && ctx.callout.targetAgent === this.id ? [ctx.callout.quoteFromAgent] : [],
            input: { system: sysText, user: userText },
            ...(r.thinking ? { thinking: r.thinking } : {}),
          }
        }
        // 收尾缺失或空返回：按上游抖动处理，交给下一轮重试
        lastError = r.finished ? '模型返回空内容' : `流未正常收尾（stop=${r.stopReason || '无'} chars=${r.content.length}）`
        diag.log({
          ts: t0,
          layer: 'runtime',
          stage: 'api-response',
          subject: this.id,
          ok: false,
          ms: Date.now() - t0,
          detail: `attempt=${attempt} truncated finished=${r.finished} chars=${r.content.length} thinkChars=${r.thinking.length} stop=${r.stopReason || '-'}`,
        })
      } catch (e) {
        if (e instanceof AgentError) {
          // 鉴权 / 4xx 这类硬失败：重试没意义，如实冒泡让上层标记缺席
          diag.log({ ts: t0, layer: 'runtime', stage: 'api-response', subject: this.id, ok: false, ms: Date.now() - t0, detail: `attempt=${attempt} fatal ${e.message}` })
          if (this.status === 'busy') this.status = 'ready'
          throw e
        }
        lastError = (e as Error).message
        diag.log({ ts: t0, layer: 'runtime', stage: 'api-response', subject: this.id, ok: false, ms: Date.now() - t0, detail: `attempt=${attempt} error ${e instanceof RetryableApiError ? 'retryable' : (e as Error).name} ${lastError}` })
      }
      if (attempt < MAX_API_ATTEMPTS) await sleep(600 * attempt)
    }

    if (this.status === 'busy') this.status = 'ready'
    throw new AgentError(
      'channel-error',
      `${this.displayName} 未返回有效内容（上游连接不稳定，已重试 ${MAX_API_ATTEMPTS} 次）：${lastError || '未知原因'}`,
    )
  }

  /** 组装一次发言/聊天的请求体与实际发给模型的输入文本 */
  private buildRequest(ctx: TurnContext): {
    body: Record<string, unknown>
    sysText: string
    userText: string
  } {
    const anthropic = this.cfg.protocol === 'anthropic'
    let body: Record<string, unknown>
    let sysText: string
    let userText: string

    if (ctx.chat) {
      // 聊天直连：多轮 history 逐字携带，不使用圆桌发言格式
      const msgs = ctx.chat.history
      sysText = ctx.chat.system ?? '你是一个乐于助人的 AI 助手。请直接、准确、简洁地回答用户的问题。'
      userText = msgs.filter((m) => m.role === 'user').pop()?.content ?? ''
      body = anthropic
        ? {
            model: this.cfg.model,
            max_tokens: 4_096,
            stream: true,
            temperature: 0.7,
            system: sysText,
            messages: msgs.map((m) => ({ role: m.role, content: this.chatContent(m, true) })),
          }
        : {
            model: this.cfg.model,
            stream: true,
            stream_options: { include_usage: true },
            temperature: 0.7,
            messages: [
              { role: 'system', content: sysText },
              ...msgs.map((m) => ({ role: m.role, content: this.chatContent(m, false) })),
            ],
          }
    } else {
      const system = this.systemPrompt(ctx)
      const user = this.userPrompt(ctx)
      sysText = system
      userText = user
      body = anthropic
        ? {
            model: this.cfg.model,
            max_tokens: 4_096,
            stream: true,
            temperature: 0.7,
            system,
            messages: [{ role: 'user', content: user }],
          }
        : {
            model: this.cfg.model,
            stream: true,
            stream_options: { include_usage: true },
            temperature: 0.7,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }
    }
    return { body, sysText, userText }
  }

  /**
   * 单次请求：fetch + SSE 解析。
   * 返回 finished/stopReason 供上层判断流是否「正常收尾」——这是区分
   * 「模型真的只说这么点」与「代理把流掐了」的唯一依据，不能靠内容长度猜。
   * 抛错约定：AgentError = 硬失败（不重试）；RetryableApiError = 软失败（可重试）。
   */
  private async rawCall(
    anthropic: boolean,
    apiKey: string,
    body: Record<string, unknown>,
    onDelta: (chunk: string) => void,
    onThinking?: (chunk: string) => void,
  ): Promise<{ content: string; thinking: string; usage: TokenUsage; finished: boolean; stopReason: string; nonStream?: boolean }> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 180_000)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const res = await fetch(
        anthropic
          ? anthropicMessagesUrl(this.cfg.baseUrl)
          : `${trimBase(this.cfg.baseUrl)}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(anthropic
              ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
              : { Authorization: `Bearer ${apiKey}` }),
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        },
      )

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if (res.status === 401 || res.status === 403) {
          this.status = 'disabled'
          throw new AgentError('channel-error', `${this.displayName} 鉴权失败（${res.status}）`)
        }
        const msg = `${this.displayName} HTTP ${res.status}: ${text.slice(0, 200)}`
        // 429/5xx 是上游临时故障，重试有意义；其余 4xx 是请求本身写坏了，重试没意义
        if (res.status === 429 || res.status >= 500) throw new RetryableApiError(msg)
        throw new AgentError('channel-error', msg)
      }

      if (!res.body) throw new RetryableApiError('响应无 body')

      const ctype = res.headers.get('content-type') ?? ''
      reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      /** 整段响应里有没有出现过 SSE 的 data: 行；一次都没有 = 这根本不是一个流式接口 */
      let sawData = false
      /** 出现 data: 行前累计的原文，用于「整包回一段 JSON」和报错时带出上游原话 */
      let rawAll = ''
      let acc = ''
      let thinkingAcc = ''
      let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 }
      let finished = false
      let stopReason = ''

      const processLine = (line: string) => {
        const t = line.trim()
        if (!t.startsWith('data:')) return
        sawData = true
        const payload = t.slice(5).trim()
        if (payload === '[DONE]') {
          finished = true
          return
        }
        try {
          const json = JSON.parse(payload) as {
            type?: string
            choices?: Array<{
              delta?: { content?: string; reasoning?: string; reasoning_content?: string }
              finish_reason?: string | null
            }>
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              input_tokens?: number
              output_tokens?: number
            }
            delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string }
            message?: { usage?: { input_tokens?: number; output_tokens?: number } }
          }
          // 正常收尾信号：OpenAI 用 finish_reason 或 [DONE]；Anthropic 用 message_stop
          if (!anthropic) {
            const fr = json.choices?.[0]?.finish_reason
            if (fr) {
              finished = true
              stopReason = fr
            }
          } else if (json.type === 'message_stop') {
            finished = true
          }
          if (anthropic && json.type === 'message_delta' && json.delta?.stop_reason) {
            stopReason = json.delta.stop_reason
          }
          const delta = anthropic ? json.delta?.text : json.choices?.[0]?.delta?.content
          if (delta) {
            acc += delta
            onDelta(delta)
          }
          // 思维链：OpenAI 兼容用 delta.reasoning_content / reasoning（deepseek-r1、qwen 等）；
          // Anthropic 用 content_block_delta 的 thinking_delta.thinking。与正文分开累计。
          const reason = anthropic
            ? json.delta?.type === 'thinking_delta'
              ? json.delta.thinking
              : undefined
            : json.choices?.[0]?.delta?.reasoning_content ?? json.choices?.[0]?.delta?.reasoning
          if (reason) {
            thinkingAcc += reason
            onThinking?.(reason)
          }
          if (json.usage) {
            usage = this.calcUsage(json.usage.prompt_tokens ?? 0, json.usage.completion_tokens ?? 0)
          }
          if (anthropic && json.message?.usage) {
            usage = this.calcUsage(json.message.usage.input_tokens ?? 0, json.message.usage.output_tokens ?? 0)
          }
          if (anthropic && json.usage) {
            usage = this.calcUsage(json.usage.input_tokens ?? 0, json.usage.output_tokens ?? 0)
          }
        } catch {
          /* 跳过无法解析的分片 */
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        buffer += text
        // 一旦确认是事件流就不再留原文：整包退路只服务于「一个 data: 行都没有」的响应
        if (!sawData && rawAll.length < 512_000) rawAll += text

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) processLine(line)
      }

      // Some providers close the stream without a final newline; retain that last SSE event.
      buffer += decoder.decode()
      if (buffer.trim()) processLine(buffer)

      if (!sawData) {
        const whole = parseWholeReply(rawAll, anthropic)
        if (whole?.kind === 'error') {
          // 200 + {"error":...}：上游把真实原因写在整包里，别再套「不稳定」这层壳
          throw new AgentError('channel-error', `${this.displayName} 端点报错：${whole.message}`)
        }
        if (whole?.kind === 'text') {
          /*
           * 端点忽略了 stream:true，整包回了一段 JSON。收下它，代价只是这个模型
           * 没有逐字打字机效果；空内容仍交给上层按「模型返回空内容」重试。
           */
          if (whole.text) onDelta(whole.text)
          if (whole.thinking) onThinking?.(whole.thinking)
          return {
            content: whole.text,
            thinking: whole.thinking,
            usage: this.calcUsage(whole.promptTokens, whole.completionTokens),
            finished: true,
            stopReason: whole.stop,
            nonStream: true,
          }
        }
        if (!ctype.includes('event-stream')) {
          /*
           * HTTP 200 但整段响应没有一个 data: 行、不是事件流、也不是 JSON：这是地址或协议
           * 配错了（网关把未匹配的路径回成前端页）。当成「流未正常收尾」重试三次，
           * 只会把用户引向「minimax 不稳定」这种错方向。
           */
          const head = rawAll.replace(/\s+/g, ' ').trim().slice(0, 160)
          throw new AgentError(
            'channel-error',
            `${this.displayName} 端点返回的不是流式接口（HTTP 200，content-type=${ctype || '未声明'}）：${
              head ? `响应开头「${head}」` : '响应体为空'
            }。请核对 baseUrl 与协议是否配对`,
          )
        }
      }

      return { content: acc, thinking: thinkingAcc, usage, finished, stopReason }
    } catch (e) {
      if (reader) await reader.cancel().catch(() => undefined)
      if (e instanceof AgentError || e instanceof RetryableApiError) throw e
      const msg = (e as Error).name === 'AbortError' ? '请求超时' : (e as Error).message
      throw new RetryableApiError(msg)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 聊天消息 → 请求 content。纯文本时保持字符串；
   * 带图片时改成内容分片数组（Anthropic image source / OpenAI image_url data URL）。
   * 文本-only 端点收到 image_url 会自行报错，由上层通道异常透出 —— 这是
   * 「给纯文本模型发图」这一用户选择的必然结果。
   */
  private chatContent(m: { content: string; images?: ChatImage[] }, anthropic: boolean): string | unknown[] {
    if (!m.images || m.images.length === 0) return m.content
    if (anthropic) {
      const parts: unknown[] = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      for (const img of m.images)
        parts.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } })
      return parts
    }
    const parts: unknown[] = []
    if (m.content) parts.push({ type: 'text', text: m.content })
    for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } })
    return parts
  }

  private calcUsage(promptTokens: number, completionTokens: number): TokenUsage {
    const costUsd =
      (promptTokens / 1_000_000) * this.cfg.pricePerMTokIn +
      (completionTokens / 1_000_000) * this.cfg.pricePerMTokOut
    return {
      promptTokens,
      completionTokens,
      costUsd: Math.round(costUsd * 10_000) / 10_000,
    }
  }

  private systemPrompt(ctx: TurnContext): string {
    const strategyHint =
      ctx.topic.strategy === 'debate'
        ? '你被分配为反方，应主动寻找对方论证不成立的理由。'
        : ctx.topic.strategy === 'review'
          ? '你被分配为评审角色，应按既定维度给出可验证的判断。'
          : '你参与圆桌讨论，应提供独立的立场与论据。'

    // 用户中途指定的立场优先于策略默认（PRD 5.5 调整立场）
    const stanceHint = ctx.stanceOverride
      ? `\n\n【用户已调整你的立场】${ctx.stanceOverride}\n该指令由人类参与者在讨论过程中下达，优先于上述默认角色设定。请按新立场发言。`
      : ''

    return `你是多模型圆桌讨论的参会者。${strategyHint}${stanceHint}你的发言须可被其他模型引用与反驳。`
  }

  private userPrompt(ctx: TurnContext): string {
    const parts: string[] = []
    parts.push(`议题：${ctx.topic.title}`)
    if (ctx.topic.background) parts.push(`背景材料：${ctx.topic.background}`)

    // 人类介入：独立区块，优先于常规上下文
    if (ctx.humanIntervention) {
      parts.push('')
      parts.push('【人类参与者介入】')
      parts.push('以下内容由用户在你本轮发言前插入，请优先响应；若与你的判断冲突，请明确说明分歧所在。')
      parts.push(ctx.humanIntervention)
    }

    // 程序质询：独立成块，且明确不是人类发言也不是主持观点
    if (ctx.systemChallenge) {
      parts.push('')
      parts.push('【系统核验】')
      parts.push('以下内容由程序在本场发言记录里核对后提出，请先回应它，再继续你的论证。')
      parts.push(ctx.systemChallenge)
    }

    // 上一场结论作为已知前提（continue 重试模式）
    if (ctx.priorConclusion) {
      parts.push('')
      parts.push(ctx.priorConclusion)
    }

    parts.push('')
    parts.push('【讨论记录】')
    parts.push(renderDigestForPrompt(ctx.digest))

    if (ctx.callout && ctx.callout.targetAgent === this.id) {
      parts.push('')
      parts.push(
        `主持人要求你针对性回应 ${ctx.callout.quoteFromLabel ?? ctx.callout.quoteFromAgent} 的观点："${ctx.callout.quote}"`,
      )
    }

    parts.push('')
    parts.push(
      `请输出你的立场与论据（≤${ctx.maxLenChars} 字）。引用他人观点时写明「第N轮」或发言编号 [utt_…] —— 程序会核对这些引用在本场是否真实存在。`,
    )
    parts.push('若你改变立场，说明被什么论据说服。')

    const opens = ctx.digest.open.filter((d) => d.status === 'open')
    if (opens.length > 0) {
      parts.push('')
      parts.push(
        `当前仍存未决分歧：${opens.map((d) => d.claim).join('；')}。若你能消解其中某项，请直接论证；不能则明确指出分歧为何仍在。`,
      )
    }

    return parts.join('\n')
  }

  dispose(): void {
    /* 无需释放资源 */
  }
}
