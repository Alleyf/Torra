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
            detail: `attempt=${attempt} chars=${r.content.length} thinkChars=${r.thinking.length} tok=${r.usage.promptTokens}/${r.usage.completionTokens} stop=${r.stopReason || '-'}`,
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
  ): Promise<{ content: string; thinking: string; usage: TokenUsage; finished: boolean; stopReason: string }> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 180_000)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const res = await fetch(
        `${this.cfg.baseUrl.replace(/\/$/, '')}/${anthropic ? 'messages' : 'chat/completions'}`,
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

      reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let acc = ''
      let thinkingAcc = ''
      let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 }
      let finished = false
      let stopReason = ''

      const processLine = (line: string) => {
        const t = line.trim()
        if (!t.startsWith('data:')) return
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
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) processLine(line)
      }

      // Some providers close the stream without a final newline; retain that last SSE event.
      buffer += decoder.decode()
      if (buffer.trim()) processLine(buffer)

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
