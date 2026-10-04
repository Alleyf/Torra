/**
 * WebviewAgent —— 驱动后台网页版 LLM（PRD 6.4 / 6.3 / 6.6）
 *
 * 流程：注入 → 键入 → 发送 → 轮询流式文本 → 完成判定 → 返回
 *
 * 完成判定是这里最容易出错的地方。真实站点的停止按钮形态差异极大：
 * - ChatGPT / Claude / Qwen：独立停止按钮，按钮隐藏即完成；
 * - 豆包：发送与打断按钮同时在 DOM，靠 class 互斥隐藏 —— 必须判可见性；
 * - DeepSeek：发送与停止是同一个 button，且无 testid/aria-label，
 *   「按钮消失」永远不成立，只能靠「生成中标志」或文本稳定兜底。
 * 因此不在页面侧做单点判定，而是逐级降级，每级都带可用性检查。
 */

import { webContents, type WebContentsView } from 'electron'
import type { AdapterRuntime } from '../../shared/adapter'
import type { AgentStatus, TurnContext, TokenUsage } from '../../shared/types'
import { INJECT_SCRIPT } from '../webview/inject'
import type { WebviewPool } from '../webview/pool'
import { AgentError, type Agent, type SendResult } from './agent'
import { diag } from '../diagnostics/log'
import { renderDigestForPrompt } from '../../shared/invariants'

export class WebviewAgent implements Agent {
  readonly transport = 'webview' as const
  status: AgentStatus = 'ready'

  constructor(
    readonly id: string,
    readonly displayName: string,
    readonly color: string,
    private readonly pool: WebviewPool,
    private adapter: AdapterRuntime,
    private readonly partition: string,
  ) {}

  private get view() {
    const v = this.pool.get(this.id)
    if (!v) throw new AgentError('channel-error', `${this.displayName} WebView 未初始化`)
    return v
  }

  /**
   * 取实例，缺失则重建后等待就绪。
   *
   * 实例可能因内存预算 LRU 回收而消失，但 agent 对象仍被缓存 ——
   * 此时直接抛「未初始化」会让模型白白缺席一整场。重建是廉价的
   * （partition 数据保留，登录态不丢），没有理由不试一次。
   */
  private async ensureView(): Promise<WebContentsView> {
    const existing = this.pool.get(this.id)
    if (existing) return existing
    // Rebuilds must use the original declared partition.  Falling back to the
    // model-id-derived partition breaks login persistence for user models.
    this.pool.ensure(this.id, this.adapter, this.partition)
    await this.pool.waitReady(this.id)
    const v = this.pool.get(this.id)
    if (!v) throw new AgentError('channel-error', `${this.displayName} WebView 重建失败`)
    return v
  }

  async healthCheck(): Promise<boolean> {
    try {
      const view = await this.ensureView()
      await this.ensureInjected()
      const res = (await view.webContents.executeJavaScript(
        `window.__torra.probe(${JSON.stringify(this.adapter.spec.health_probe)})`,
        true,
      )) as { ok: boolean; reason: string } | null

      if (res?.ok === true) {
        this.status = 'ready'
        return true
      }

      // 未登录 / 人机验证 → expired（可引导用户重新登录）；
      // 选择器不存在 → adapter-broken（站点改版，需更新适配器）。
      // 两者混为一谈会让用户误以为要更新适配器，实则只需重新登录。
      const reason = res?.reason ?? ''
      if (reason === 'login-required') {
        this.status = 'expired'
      } else {
        this.status = 'adapter-broken'
        this.adapter.lastError = reason
      }
      return false
    } catch {
      // executeJavaScript 在页面尚未完成导航时会抛，这通常是「还没加载完」
      // 而非适配器失效。此处判 expired 而非 adapter-broken ——
      // 标错会让用户去更新一个根本没坏的适配器。
      this.status = 'expired'
      return false
    }
  }

  private async ensureInjected(): Promise<void> {
    const view = await this.ensureView()
    const already = await view.webContents.executeJavaScript('!!window.__torra', true).catch(() => false)
    if (already === true) return
    await view.webContents.executeJavaScript(INJECT_SCRIPT, true)
  }

  async send(
    ctx: TurnContext,
    onDelta: (chunk: string) => void,
    onThinking?: (chunk: string) => void,
  ): Promise<SendResult> {
    this.status = 'busy'
    const spec = this.adapter.spec
    const streamSel = JSON.stringify(spec.selectors.stream)
    const streamMode = JSON.stringify(spec.stream_mode ?? 'last')
    // 思考容器为可选声明：未声明则不抓取，避免给每个站点强加一套脆弱的选择器。
    const hasReasoning = !!spec.selectors.reasoning
    const reasoningSel = hasReasoning ? JSON.stringify(spec.selectors.reasoning) : ''
    const reasoningMode = JSON.stringify(spec.reasoning_mode ?? 'last')

    try {
      // 实例缺失时重建（LRU 回收后自愈），而不是直接判缺席
      const view = await this.ensureView()
      await this.ensureInjected()

      // 组装 prompt（PRD 附录 B）
      const prompt = this.buildPrompt(ctx)

      // 思考容器基线：必须在「触发发送之前」抓取本轮之前的节点数，
      // 读取时只取本轮新增的思考节点，避免把上一轮的思维链当成本轮思考。
      let reasoningBase = -1
      if (hasReasoning) {
        reasoningBase = (await view.webContents.executeJavaScript(
          `window.__torra.count(${reasoningSel})`,
          true,
        )) as number
      }

      // 键入 + 发送
      const sendT0 = Date.now()
      const sendRes = (await view.webContents.executeJavaScript(
        `window.__torra.send(${JSON.stringify(spec)}, ${JSON.stringify(prompt)})`,
        true,
      )) as { ok: boolean; reason: string; streamCount?: number; streamBaselineText?: string }
      diag.log({
        ts: sendT0,
        layer: 'selector',
        stage: 'send',
        subject: this.id,
        sessionId: ctx.sessionId,
        ok: sendRes.ok,
        ms: Date.now() - sendT0,
        detail: `${sendRes.ok ? 'accepted' : sendRes.reason} | promptChars=${prompt.length}`,
      })

      if (!sendRes.ok) {
        if (sendRes.reason === 'login-required') {
          this.status = 'expired'
          throw new AgentError('login-required', `${this.displayName} 需要登录或人机验证`)
        }
        this.status = 'adapter-broken'
        throw new AgentError('adapter-broken', `${this.displayName} ${sendRes.reason}`)
      }

      // 轮询流式 + 完成判定
      const turnT0 = Date.now()
      const deadline = Date.now() + spec.automation.max_wait_s * 1000
      const stableWindow = spec.completion.stable_ms ?? 2500
      let lastText = ''
      let lastChanged = Date.now()
      // 本轮发送前的回复节点数：read 只取该索引之后的新增节点，
      // 既避开 ChatGPT 尾部的空占位节点，也不会把上一轮误当本轮发言
      const sinceCount = typeof sendRes.streamCount === 'number' ? sendRes.streamCount : -1
      const baselineTail = typeof sendRes.streamBaselineText === 'string' ? sendRes.streamBaselineText : ''
      const excludeJson = JSON.stringify(prompt)
      // 思维链取「最长的一次观测」：ChatGPT 这类站点在生成结束后会把思考折叠成
      // 一句摘要，若取末次值会把完整推理换成「思考了 N 秒」，故保留生成过程中最长的那份。
      let thinkingAcc = ''

      while (Date.now() < deadline) {
        const snap = (await view.webContents.executeJavaScript(
          `(() => { const d = window.__torra.done(${JSON.stringify(spec)}); return { complete: d.complete, method: d.method, text: window.__torra.read(${streamSel}, ${streamMode}, ${sinceCount}, ${JSON.stringify(baselineTail)}, ${excludeJson})${hasReasoning ? `, reasoning: window.__torra.read(${reasoningSel}, ${reasoningMode}, ${reasoningBase})` : ''} }; })()`,
          true,
        )) as { complete: boolean; method: string; text: string; reasoning: string }

        if (typeof snap.text === 'string' && snap.text.length > 0 && snap.text !== lastText) {
          const delta = snap.text.startsWith(lastText) ? snap.text.slice(lastText.length) : snap.text
          onDelta(delta)
          lastText = snap.text
          lastChanged = Date.now()
        }

        if (typeof snap.reasoning === 'string' && snap.reasoning.length > thinkingAcc.length) {
          // 思考容器 innerText 是累积快照：只在变长时把新增部分作为增量发出，
          // 生成结束后站点会把思考折叠成摘要（变短），故不回收已发出的内容。
          const delta = snap.reasoning.startsWith(thinkingAcc)
            ? snap.reasoning.slice(thinkingAcc.length)
            : snap.reasoning
          if (onThinking) onThinking(delta)
          thinkingAcc = snap.reasoning
        }

        /**
         * 降级链：
         * 页面侧返回 method='dom_stable' 说明声明的判定手段不适用
         * （选择器为空，或元素始终可见 —— DeepSeek 就是后者），
         * 此时改用「回复文本在 stable_ms 内无变化」作为兜底完成信号。
         */
        const quiet = Date.now() - lastChanged > stableWindow
        const settled = snap.complete || snap.method === 'dom_stable' ? snap.complete || quiet : false

        if (settled && lastText.length > 0) {
          // 完成后短暂等待，避免抓到截断的尾巴
          await sleep(500)
          const finalSnap = (await view.webContents.executeJavaScript(
            `window.__torra.read(${streamSel}, ${streamMode}, ${sinceCount}, ${JSON.stringify(baselineTail)}, ${excludeJson})`,
            true,
          )) as string
          if (finalSnap.length > 0 && finalSnap !== lastText) {
            const delta = finalSnap.startsWith(lastText) ? finalSnap.slice(lastText.length) : finalSnap
            onDelta(delta)
            lastText = finalSnap
          }
          this.status = 'ready'
          diag.log({
            ts: turnT0,
            layer: 'runtime',
            stage: 'settle',
            subject: this.id,
            sessionId: ctx.sessionId,
            ok: true,
            ms: Date.now() - turnT0,
            detail: `chars=${lastText.length} method=${snap.method} round=${ctx.round}`,
          })
          return {
            content: lastText,
            usage: estimateWebviewUsage(lastText),
            targets: ctx.callout && ctx.callout.targetAgent === this.id ? [ctx.callout.quoteFromAgent] : [],
            input: { user: prompt },
            ...(thinkingAcc ? { thinking: thinkingAcc } : {}),
          }
        }

        // 判定完成但始终没抓到内容：给宽限期，超时判缺席（不静默消失）
        if (settled && lastText.length === 0 && Date.now() - lastChanged > stableWindow + 6000) {
          this.status = 'ready'
          diag.log({
            ts: turnT0,
            layer: 'selector',
            stage: 'read-empty',
            subject: this.id,
            sessionId: ctx.sessionId,
            ok: false,
            ms: Date.now() - turnT0,
            detail: `stream=${spec.selectors.stream} mode=${spec.stream_mode ?? 'last'} —— 生成已结束但读取为空，多半是回复容器选择器指错了元素`,
          })
          throw new AgentError('timeout', `${this.displayName} 生成结束但未捕获到内容`)
        }

        await sleep(400)
      }

      this.status = 'ready'
      diag.log({
        ts: turnT0,
        layer: 'runtime',
        stage: 'wait-timeout',
        subject: this.id,
        sessionId: ctx.sessionId,
        ok: false,
        ms: Date.now() - turnT0,
        detail: `chars=${lastText.length} max_wait_s=${spec.automation.max_wait_s}`,
      })
      throw new AgentError('timeout', `${this.displayName} 超过 max_wait_s 未完成`)
    } catch (e) {
      if (this.status === 'busy') this.status = 'ready'
      if (e instanceof AgentError) throw e
      throw new AgentError('channel-error', `${this.displayName} 通道异常：${(e as Error).message}`)
    }
  }

  /** PRD 附录 B：参会模型发言 Prompt */
  private buildPrompt(ctx: TurnContext): string {
    /*
     * 聊天直连：只把最新一条用户消息键入站点输入框。
     * 网页通道没有 system prompt，多轮上下文由站点自身的会话维持
     * （同一个 WebContents 连续对话），无需我们重复携带历史。
     */
    if (ctx.chat) {
      const lastUser = [...ctx.chat.history].reverse().find((m) => m.role === 'user')
      return lastUser?.content ?? ''
    }

    const parts: string[] = []
    parts.push(`议题：${ctx.topic.title}`)
    if (ctx.topic.background) {
      parts.push(`背景材料：${ctx.topic.background}`)
    }

    // 用户中途指定的立场（PRD 5.5）。webview 通道无 system prompt，
    // 立场必须写进 user prompt 才能生效。
    if (ctx.stanceOverride) {
      parts.push('')
      parts.push(
        `【用户已调整你的角色】${ctx.stanceOverride}\n该指令由人类参与者在讨论过程中下达，优先于常规角色设定。请按新立场发言。`,
      )
    }

    // 人类介入：独立区块，优先于常规上下文
    if (ctx.humanIntervention) {
      parts.push('')
      parts.push('【人类参与者介入】')
      parts.push('以下内容由用户在你本轮发言前插入，请优先响应；若与你的判断冲突，请明确说明分歧所在。')
      parts.push(ctx.humanIntervention)
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
        `主持人要求你针对性回应 ${ctx.callout.quoteFromAgent} 的观点："${ctx.callout.quote}"`,
      )
    }

    parts.push('')
    parts.push(`请输出你的立场与论据（≤${ctx.maxLenChars} 字）。引用他人观点时标注来源轮次。`)
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

  takeover(on: boolean): void {
    // 用转播区整块尺寸：10×10 的视口会让站点退回移动端布局，
    // 用户在接管态看到的和自动化用的都不是同一个页面形态。
    if (on) this.pool.present(this.id)
    else this.pool.dismiss(this.id)
    this.status = on ? 'busy' : 'ready'
  }

  dispose(): void {
    this.pool.disposeEntry(this.id)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Webview 通道拿不到精确 token 数（站点未暴露），
 * 用字符数做保守估算，仅用于费用面板的量级参考。
 */
function estimateWebviewUsage(text: string): TokenUsage {
  const completionTokens = Math.ceil(text.length / 2.2)
  return {
    promptTokens: 0,
    completionTokens,
    costUsd: 0,
  }
}

export { webContents }
