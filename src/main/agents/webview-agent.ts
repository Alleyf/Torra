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

import { clipboard, nativeImage, webContents, type WebContentsView } from 'electron'
import type { AdapterRuntime } from '../../shared/adapter'
import type { AgentStatus, TurnContext, TokenUsage, ChatImage } from '../../shared/types'
import { INJECT_SCRIPT } from '../webview/inject'
import type { WebviewPool } from '../webview/pool'
import { AgentError, type Agent, type SendResult } from './agent'
import { diag } from '../diagnostics/log'
import { renderDigestForPrompt, renderPeersForPrompt } from '../../shared/invariants'

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

      // 未登录 / 人机验证 / 风控拦截 → expired（都要用户在网页里人工处理）；
      // 选择器不存在 → adapter-broken（站点改版，需更新适配器）。
      // 三者混为一谈会让用户误以为要更新适配器，实则只需重新登录或换网络环境。
      const reason = res?.reason ?? ''
      if (reason === 'login-required' || reason === 'risk-blocked') {
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
    onSteps?: (chunk: string) => void,
  ): Promise<SendResult> {
    this.status = 'busy'
    const spec = this.adapter.spec
    const streamSel = JSON.stringify(spec.selectors.stream)
    const streamMode = JSON.stringify(spec.stream_mode ?? 'last')
    // 思考/步骤容器为可选声明：未声明则不抓取，避免给每个站点强加一套脆弱的选择器。
    const hasReasoning = !!spec.selectors.reasoning
    const reasoningSel = hasReasoning ? JSON.stringify(spec.selectors.reasoning) : ''
    const reasoningMode = JSON.stringify(spec.reasoning_mode ?? 'last')
    const hasSteps = !!spec.selectors.steps
    const stepsSel = hasSteps ? JSON.stringify(spec.selectors.steps) : ''
    const stepsMode = JSON.stringify(spec.steps_mode ?? 'all')

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
      let stepsBase = -1
      if (hasSteps) {
        stepsBase = (await view.webContents.executeJavaScript(
          `window.__torra.count(${stepsSel})`,
          true,
        )) as number
      }

      // 键入 → 贴附件 → 按发送。这个顺序不能换：
      // clearInput 是键入阶段的第一步，先贴图片会被它连同文本一起抹掉
      // （实测：contenteditable 里 blob 图片节点 1 → 0）。
      const chatImages = ctx.chat?.history.filter((m) => m.role === 'user').pop()?.images

      const typeT0 = Date.now()
      const typed = (await view.webContents.executeJavaScript(
        `window.__torra.typePrompt(${JSON.stringify(spec)}, ${JSON.stringify(prompt)})`,
        true,
      )) as { ok: boolean; reason: string; mode?: string }
      let pasteNote: string | undefined
      if (chatImages && chatImages.length > 0) {
        // 粘贴失败不能让整轮飞掉：文本对网页模型本身就是有效的一轮。
        // 但「附件默默没了」必须让用户看见 —— 否则只会得到一个答非所问的回复。
        const paste = await pasteImages(view.webContents, spec, chatImages, this.id, ctx.sessionId).catch(
          (e: unknown) => ({ placed: 0, dropped: [`全部 ${chatImages.length} 张（${String((e as Error)?.message ?? e)}）`] }),
        )
        if (paste.dropped.length > 0) {
          pasteNote = `附件未送达（${paste.dropped.join('、')}），文本已正常发送`
        }
      }

      const sendT0 = Date.now()
      // 显式标注：补刀成功后要回写 ok/streamCount，两个分支必须同形
      const sendRes: {
        ok: boolean
        reason: string
        accepted?: boolean
        streamCount?: number
        streamBaselineText?: string
      } = typed.ok
        ? ((await view.webContents.executeJavaScript(
            `window.__torra.pressSend(${JSON.stringify(spec)}, ${JSON.stringify(prompt)}, ${chatImages?.length ?? 0})`,
            true,
          )) as { ok: boolean; reason: string; accepted?: boolean; streamCount?: number; streamBaselineText?: string })
        : { ok: false, reason: typed.reason }
      diag.log({
        ts: typeT0,
        layer: 'selector',
        stage: 'type',
        subject: this.id,
        sessionId: ctx.sessionId,
        ok: typed.ok,
        ms: sendT0 - typeT0,
        detail: `${typed.ok ? `typed=${typed.mode || 'char'}` : typed.reason} | promptChars=${prompt.length}`,
      })
      diag.log({
        ts: sendT0,
        layer: 'selector',
        stage: 'send',
        subject: this.id,
        sessionId: ctx.sessionId,
        ok: sendRes.ok,
        ms: Date.now() - sendT0,
        detail: `${sendRes.ok ? (sendRes.accepted ? 'accepted=composer-cleared' : 'started=stream') : sendRes.reason} | attachments=${chatImages?.length ?? 0} | promptChars=${prompt.length}`,
      })

      if (!sendRes.ok && sendRes.reason === 'risk-blocked') {
        this.status = 'expired'
        throw new AgentError(
          'login-required',
          `${this.displayName} 判定当前访问环境异常并拦截了页面（要求改用官方产品）。这不是适配器故障 —— 请在网页里手动完成验证或切换网络环境后再重试。`,
        )
      }

      if (!sendRes.ok && sendRes.reason === 'login-required') {
        this.status = 'expired'
        throw new AgentError('login-required', `${this.displayName} 需要登录或人机验证`)
      }

      /**
       * 浏览器级补刀：页内 new KeyboardEvent 派出来的回车 isTrusted=false，
       * Quill 一类编辑器（元宝）会整条忽略 —— 文本全留在框里，站点根本没收到，
       * 20s 后只能报「生成未开始」。这里改走浏览器输入管线补一次真实按键。
       *
       * 前提是文本确实还留在框里：站点已经收下单时再按一次回车，等于把同一句话发两遍。
       * 补刀成功时把「本轮之前的回复节点数」写回 sendRes，读取照旧只取本轮新增节点。
       */
      if (!sendRes.ok && String(sendRes.reason ?? '').startsWith('generation did not start')) {
        /**
         * 「文本还在不在框里」不能按 spec.selectors.input 反查：Quill 的 .ql-blank
         * 只在编辑器为空时存在，字一落地这个 class 就被移除，选择器指向的节点查无此人
         * （元宝就是这么把补刀判死的）。holdsPrompt 扫描通用可编辑候选，
         * 谁装着本轮提示词就补刀谁，并把该节点留在 window.__torraHold 上供聚焦。
         */
        const holdsJs = `window.__torra.holdsPrompt(${JSON.stringify(prompt)})`
        const stillHolds = (await view.webContents.executeJavaScript(holdsJs, true).catch(() => false)) as boolean
        if (stillHolds) {
          const rescueT0 = Date.now()
          const baseline = spec.selectors.stream
            ? ((await view.webContents
                .executeJavaScript(`window.__torra.count(${JSON.stringify(spec.selectors.stream)})`, true)
                .catch(() => -1)) as number)
            : -1
          try {
            await view.webContents.executeJavaScript(
              `(() => { var el = window.__torraHold;` +
              ` if (el && document.contains(el)) { el.focus(); return true } return false })()`,
              true,
            )
            view.webContents.focus()
            view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' } as Electron.KeyboardInputEvent)
            view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' } as Electron.KeyboardInputEvent)
          } catch {
            /* 注入按键在个别平台会被拒；下面照样以「框里还有没有字」为准 */
          }
          await sleep(1_500)
          const cleared = (await view.webContents.executeJavaScript(holdsJs, true).catch(() => true)) !== true
          diag.log({
            ts: rescueT0,
            layer: 'selector',
            stage: 'send-native',
            subject: this.id,
            sessionId: ctx.sessionId,
            ok: cleared,
            ms: Date.now() - rescueT0,
            detail: cleared ? 'trusted Enter accepted' : 'composer still holds prompt',
          })
          if (cleared) {
            sendRes.ok = true
            if (baseline >= 0) sendRes.streamCount = baseline
          }
        }
      }

      if (!sendRes.ok) {
        /**
         * 「站点根本没接走这一轮」与「适配器指错了元素」必须是两条结论：
         * 前者多半是上传期间 Enter 被吞（DeepSeek 图片轮实测），下一轮往往就好，
         * 判成 adapter-broken 会把没坏的适配器标红，用户照着提示去体检什么也修不好；
         * 后者才真的需要改选择器。
         */
        const notStarted = String(sendRes.reason ?? '').startsWith('generation did not start')
        if (!notStarted) this.status = 'adapter-broken'
        throw new AgentError(notStarted ? 'not-started' : 'adapter-broken', `${this.displayName} ${humanizeSendFailure(sendRes.reason)}`)
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
      let stepsAcc = ''
      // dom_stable 下，文本静止但页面仍在变化时最多再宽限多久。
      // 超过后即使页面还在动也放行 —— 宁可答案偏早收敛，也不能因无关的
      // 页面心跳（计时器/轮播）把回合拖到 max_wait 超时、整轮丢失。
      const ACTIVITY_MAX_WAIT_MS = 45000
      /**
       * 「站点收下了这一轮」（输入框已清空）却一个字都没产出时的止损线。
       * 不设这条就会拖到 max_wait_s（DeepSeek 240s）才报一句笼统超时，
       * 而真相是「这一轮被吃了」—— 早停 + 说清是哪一段，用户才知道该重发还是该改适配器。
       */
      const NO_CONTENT_MS = 90_000
      /** 空正文时「判定完成」的最小可信年龄（见下方 read-empty） */
      const FIRST_TOKEN_GRACE_MS = 25_000

      while (Date.now() < deadline) {
        const snap = (await view.webContents.executeJavaScript(
          `(() => { const d = window.__torra.done(${JSON.stringify(spec)}); return { complete: d.complete, method: d.method, act: (function () { try { return window.__torra.activity(); } catch (e) { return -1; } })(), obs: window.__torra.observe(${JSON.stringify(spec)}), text: window.__torra.read(${streamSel}, ${streamMode}, ${sinceCount}, ${JSON.stringify(baselineTail)}, ${excludeJson})${hasReasoning ? `, reasoning: window.__torra.read(${reasoningSel}, ${reasoningMode}, ${reasoningBase})` : ''}${hasSteps ? `, steps: window.__torra.read(${stepsSel}, ${stepsMode}, ${stepsBase})` : ''} }; })()`,
          true,
        )) as {
          complete: boolean
          method: string
          act: number
          text: string
          reasoning: string
          steps: string
          obs?: { riskWall?: boolean; loginWall?: boolean; visibility?: string; inputPresent?: boolean }
        }

        /**
         * 风控墙会落在回合中途：站点先收下这一轮，再把整页换成「使用环境异常」
         * （实测 DeepSeek 用 Electron 默认 UA 时必现）。此时消息容器永远 0 命中，
         * 而键入阶段那道检查早就过去了 —— 不复查就只能报「生成结束但未捕获到内容」，
         * 把用户引去改一个根本没坏的适配器。
         */
        if (snap.obs && snap.obs.riskWall) {
          this.status = 'expired'
          diag.log({
            ts: turnT0,
            layer: 'runtime',
            stage: 'risk-wall',
            subject: this.id,
            sessionId: ctx.sessionId,
            ok: false,
            ms: Date.now() - turnT0,
            detail: `回合中途出现风控拦截页 | vis=${snap.obs.visibility ?? '?'} chars=${lastText.length}`,
          })
          throw new AgentError('login-required', `${this.displayName} ${humanizeSendFailure('risk-blocked')}`)
        }

        if (typeof snap.text === 'string' && snap.text.length > 0 && snap.text !== lastText) {
          if (snap.text.startsWith(lastText)) {
            onDelta(snap.text.slice(lastText.length))
            lastText = snap.text
            lastChanged = Date.now()
          } else if (snap.text.length > lastText.length) {
            // 非前缀但更长：站点换容器/基线偏移导致重写。作为权威文本采纳，
            // 但不发 delta —— 订阅方是累加式渲染，重发全文会造成重复。
            lastText = snap.text
            lastChanged = Date.now()
          }
          // 变短：多半是虚拟化的瞬态丢帧（离屏节点被回收），不回退已观测的最长文本。
        }

        if (typeof snap.reasoning === 'string' && snap.reasoning.length > thinkingAcc.length) {
          // 思考容器 innerText 是累积快照：只在变长时把新增部分作为增量发出，
          // 生成结束后站点会把思考折叠成摘要（变短），故不回收已发出的内容。
          const delta = snap.reasoning.startsWith(thinkingAcc)
            ? snap.reasoning.slice(thinkingAcc.length)
            : snap.reasoning
          if (onThinking) onThinking(delta)
          thinkingAcc = snap.reasoning
          // 思考/步骤增长同样说明回合仍在产出：dom_stable 的空正文宽限期据此顺延，
          // 否则「先出思考/工具块、很久之后才出正文」的站会被判成生成结束但无内容。
          lastChanged = Date.now()
        }

        if (typeof snap.steps === 'string' && snap.steps.length > stepsAcc.length) {
          // 步骤通道与思考同理：累积快照、只增不减（all 模式按节点拼接）。
          const delta = snap.steps.startsWith(stepsAcc)
            ? snap.steps.slice(stepsAcc.length)
            : snap.steps
          if (onSteps) onSteps(delta)
          stepsAcc = snap.steps
          lastChanged = Date.now()
        }

        /**
         * 降级链：
         * 页面侧返回 method='dom_stable' 说明声明的判定手段不适用
         * （选择器为空，或元素始终可见 —— DeepSeek 就是后者），
         * 此时改用「回复文本在 stable_ms 内无变化」作为兜底完成信号。
         * dom_stable 还须要求页面同样安静：Kimi 这类 agent 站在执行工具
         * （跑代码/检索/写文件）时正文会静止几十秒，只凭文本静止判完成，
         * 会把截断的中间过程当成最终答案返回。
         */
        const quietFor = Date.now() - lastChanged
        const pageIdle = snap.act < 0 || snap.act > stableWindow
        const settled = snap.complete
          ? true
          : snap.method === 'dom_stable' && quietFor > stableWindow && (pageIdle || quietFor > ACTIVITY_MAX_WAIT_MS)

        /**
         * 站点收了单（输入框已清空）却一个字都没产出：90s 止损。
         * 附件轮次尤其需要这条 —— 上传 + 视觉理解的等待全发生在
         * 「已接收」与「首个字」之间，光看回复容器会一直空着。
         */
        if (
          sendRes.accepted &&
          lastText.length === 0 &&
          thinkingAcc.length === 0 &&
          stepsAcc.length === 0 &&
          Date.now() - turnT0 > NO_CONTENT_MS
        ) {
          this.status = 'ready'
          diag.log({
            ts: turnT0,
            layer: 'runtime',
            stage: 'no-content',
            subject: this.id,
            sessionId: ctx.sessionId,
            ok: false,
            ms: Date.now() - turnT0,
            detail: `站点已接收本轮（输入框已清空）但 ${Math.round(NO_CONTENT_MS / 1000)}s 内没有任何产出 | attachments=${chatImages?.length ?? 0} stream=${spec.selectors.stream}`,
          })
          throw new AgentError('no-reply', `${this.displayName} 已接收本轮但未出现回复`)
        }

        if (settled && lastText.length > 0) {
          // 收敛确认：连续多次读到同一文本才返回。
          // 单次短暂等待防不住「停一下又继续写」的 agent 节奏。
          let stableReads = 0
          while (stableReads < 3 && Date.now() < deadline) {
            await sleep(700)
            const s = (await view.webContents.executeJavaScript(
              `window.__torra.read(${streamSel}, ${streamMode}, ${sinceCount}, ${JSON.stringify(baselineTail)}, ${excludeJson})`,
              true,
            )) as string
            if (typeof s === 'string' && s.length > lastText.length) {
              if (s.startsWith(lastText)) onDelta(s.slice(lastText.length))
              lastText = s
              stableReads = 0
            } else {
              // 未变长（含变短的虚拟化瞬态）：计一次稳定读数，不回退权威文本
              stableReads++
            }
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
            detail: `chars=${lastText.length} method=${snap.method} quietFor=${quietFor} act=${snap.act} round=${ctx.round}`,
          })
          return {
            content: lastText,
            usage: estimateWebviewUsage(lastText),
            targets:
              ctx.callout && ctx.callout.targetAgent === this.id && ctx.callout.quoteFromUtterance
                ? [ctx.callout.quoteFromUtterance]
                : [],
            input: { user: prompt },
            ...(thinkingAcc ? { thinking: thinkingAcc } : {}),
            ...(stepsAcc ? { steps: stepsAcc } : {}),
            ...(pasteNote ? { note: pasteNote } : {}),
          }
        }

        // 判定完成但始终没抓到内容：给宽限期，超时判缺席（不静默消失）。
        // 首字宽限期不能省：带附件的一轮在「站点收下」与「第一个字」之间页面
        // 可以完全静止（上传在后台、理解在服务端），dom_stable 会在 3~9s 就判完成，
        // 于是把还在出结果的回合判成「未捕获到内容」。
        if (
          settled &&
          lastText.length === 0 &&
          Date.now() - lastChanged > stableWindow + 6000 &&
          Date.now() - turnT0 > FIRST_TOKEN_GRACE_MS
        ) {
          /**
           * 「空正文」有两种完全不同的病因，结论不能共用一句：
           * ① 选择器指错 —— 站点已经把答案渲染出来，只是我们读的地方不对；
           * ② 后台实例没拿到渲染帧 —— 页面停在 visibility:hidden，Chromium 不出帧，
           *    靠 IntersectionObserver / rAF 挂载消息列表的站点（DeepSeek 实测）
           *    连历史消息都不会进 DOM，读到的自然是空。此时改选择器毫无意义。
           *    判据：DOM 长时间零变化（act 远超 stable_ms）且页面仍在隐藏态。
           */
          const noFrame = snap.obs?.visibility === 'hidden' && snap.act > stableWindow
          this.status = 'ready'
          diag.log({
            ts: turnT0,
            layer: 'selector',
            stage: noFrame ? 'read-no-frame' : 'read-empty',
            subject: this.id,
            sessionId: ctx.sessionId,
            ok: false,
            ms: Date.now() - turnT0,
            detail: `stream=${spec.selectors.stream} mode=${spec.stream_mode ?? 'last'} vis=${snap.obs?.visibility ?? '?'} quietFor=${quietFor} —— ` +
              (noFrame ? '后台实例处于隐藏态且页面零变化，正文从未落到 DOM' : '生成已结束但读取为空，多半是回复容器选择器指错了元素'),
          })
          throw new AgentError(
            'timeout',
            noFrame
              ? `${this.displayName} 后台页面没有拿到渲染帧（隐藏态下站点不落地正文）。请先打开该模型网页让它前台渲染一次，再重试本轮。`
              : `${this.displayName} 生成结束但未捕获到内容`,
          )
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

    const peersText = renderPeersForPrompt(ctx.peers ?? [])
    if (peersText) {
      parts.push('')
      parts.push(peersText)
    }

    if (ctx.callout && ctx.callout.targetAgent === this.id) {
      parts.push('')
      parts.push(
        `主持人要求你针对性回应 ${ctx.callout.quoteFromLabel ?? ctx.callout.quoteFromAgent} 的观点："${ctx.callout.quote}"`,
      )
    }

    parts.push('')
    parts.push(
      peersText
        ? `请输出你的立场与论据（≤${ctx.maxLenChars} 字）。优先反驳上面「他人论点原话」里的某一条，` +
          `并原样复制它的编号 [utt_…] 或写明「第N轮」—— 程序会核对这些引用在本场是否真实存在，` +
          `核对通过才算一次点名回应。只补充新论据、不针对他人论点，视为未交锋。`
        : `请输出你的立场与论据（≤${ctx.maxLenChars} 字）。引用他人观点时写明「第N轮」或发言编号 [utt_…] —— 程序会核对这些引用在本场是否真实存在。`,
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

/**
 * 网页通道的图片注入：写系统剪贴板 → 聚焦真实输入框 → 走浏览器粘贴。
 *
 * 实测（本地探针）：
 * - webContents.paste() 派发的是**受信任**的 paste 事件，clipboardData.files 里有 File，
 *   ChatGPT/豆包这类站点认这条通道；
 * - pasteAndMatchStyle() 派发的事件 files 为空，别用；
 * - 页面自己 new ClipboardEvent 能带上 File，但 isTrusted=false，站点随时可以不认。
 * 所以只能"借"一次系统剪贴板，用完必须还原 —— 每轮都覆盖用户刚复制的东西不可接受。
 *
 * 不阻断：附件没落地也照发文本，文本对网页模型本身就是有效的一轮。
 * 但确定没送达的张数要写进 note —— 用户看到的不能只是一个答非所问的回复。
 * 导出成模块级函数是为了让冒烟能拿真函数打真页面（见 scripts/fixtures/web-attach.html）。
 */
/**
 * 系统剪贴板是全局唯一资源：一轮讨论里几个网页模型会同时贴图，
 * 不排队的话 A 写进去的图会被 B 覆盖，A 粘到的就是 B 那张（或者谁都没粘上）。
 */
let clipboardTurn: Promise<void> = Promise.resolve()

export async function pasteImages(
  wc: Electron.WebContents,
  spec: AdapterRuntime['spec'],
  images: ChatImage[],
  subject: string,
  sessionId: string,
): Promise<PasteReport> {
  const run = clipboardTurn.then(() => pasteInto(wc, spec, images, subject, sessionId))
  // 无论成败都要把队列续上：一次抛错不能把后面所有轮的贴图永久卡死
  clipboardTurn = run.then(
    () => {},
    () => {},
  )
  return run
}

/** 图片粘贴结果：dropped 只收「确定没送达」的图，没把握的一律不进（宁可少报，不要误报） */
export interface PasteReport {
  placed: number
  dropped: string[]
}

async function pasteInto(
  wc: Electron.WebContents,
  spec: AdapterRuntime['spec'],
  images: ChatImage[],
  subject: string,
  sessionId: string,
): Promise<PasteReport> {
  const list = images.slice(0, 4)
  const t0 = Date.now()
  const savedText = clipboard.readText()
  const savedHtml = clipboard.readHTML()
  const savedImage = clipboard.readImage()
  let placed = 0
  const notes: string[] = []
  const dropped: string[] = []
  // 第 5 张起根本没尝试，这是确定的丢失
  if (images.length > list.length) dropped.push(`${images.length - list.length} 张（单轮最多 4 张）`)
  const count = () => wc.executeJavaScript('window.__torra.attachCount()', true).catch(() => -1) as Promise<number>
  try {
    for (let n = 0; n < list.length; n++) {
      const img = list[n]!
      const native = nativeImage.createFromDataURL(`data:${img.mime};base64,${img.base64}`)
      // nativeImage 只保证 png/jpeg：webp、gif 会解成空图，写进剪贴板等于什么都没粘
      if (native.isEmpty()) {
        notes.push(`${img.mime} 无法解码`)
        dropped.push(`1 张（${img.mime} 无法解码）`)
        continue
      }
      const before = await count()
      clipboard.writeImage(native)
      const focused = (await wc
        .executeJavaScript(`window.__torra.focusInput(${JSON.stringify(spec)})`, true)
        .catch(() => false)) as boolean
      if (!focused) {
        notes.push('输入框拿不到焦点')
        // 焦点拿不到 → 这张和它后面的一张都没碰过剪贴板，是确定的丢失
        dropped.push(`${list.length - n} 张（输入框拿不到焦点）`)
        break
      }
      wc.paste()
      // 站点接图要时间（上传/生成预览），轮询到 blob 节点出现再走，最多 2.5s
      let landed = false
      for (let k = 0; k < 10; k++) {
        await sleep(250)
        if ((await count()) > before) {
          landed = true
          break
        }
      }
      if (landed) placed += 1
      else notes.push('页面无附件预览（textarea 型站点可能仍已接收）')
    }
  } finally {
    if (!savedImage.isEmpty()) clipboard.writeImage(savedImage)
    else if (savedHtml) clipboard.writeHTML(savedHtml)
    else if (savedText) clipboard.writeText(savedText)
  }
  /**
   * 粘上 ≠ 能发：站点拿到 File 后还要上传，上传期间 composer 常吞掉回车
   * （DeepSeek 带图时就是这么把 Enter 吃掉的）。粘贴通道只能证明页面收到了文件，
   * 证明不了站点已经允许发送 —— 所以等页面安静下来再交回发送阶段。
   */
  if (placed > 0) await waitQuiet(wc, 400, 4_000)
  diag.log({
    ts: t0,
    layer: 'selector',
    stage: 'paste',
    subject,
    sessionId,
    ok: placed > 0,
    ms: Date.now() - t0,
    detail: `${placed}/${list.length} 张已粘到输入框 | ${notes.join('; ') || 'ok'}`,
  })
  return { placed, dropped }
}

/**
 * 把页面侧原始 reason（含 pageSnapshot，一大坨 DOM 现场）翻译成给人看的短句。
 *
 * 现场快照对排障有用，但它属于诊断日志，不属于用户界面：错误卡里塞满
 * `{url=... viewport=... candidates=[...]}` 只会让人以为程序坏了。原始 reason
 * 仍完整写进 diag.log，这里只回结论 + 下一步动作。
 */
function humanizeSendFailure(reason: string): string {
  const r = String(reason ?? '')
  if (r.startsWith('login-required')) return '需要登录或人机验证，请在网页里手动完成后重试'
  if (r.startsWith('risk-blocked')) return '判定当前访问环境异常并拦截了页面（要求改用官方产品），这不是适配器故障，请在网页里手动处理后重试'
  // ChatGPT 截图那类失败：页面根本没加载出来（chrome-error://），
  // 选择器必然查不到 —— 这是网络/站点拦截，不是适配器坏了，别误导用户改选择器。
  if (r.includes('chrome-error://') || r.includes('snapshot unavailable')) return '网页没能加载出来，请检查网络后在网页里重试'
  if (r.startsWith('input vanished')) return '发送时输入框消失了，请重试本轮'
  if (r.startsWith('generation did not start')) return '网页没有开始回答（可能是上传占用或发送被吞），请重试本轮'
  if (r.startsWith('input selector missing')) return '没找到输入框，站点可能改版或尚未加载完成，请在网页里确认后再试'
  return '发送失败，请稍后重试'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 等页面 DOM 安静下来：activity() 是「距最后一次 DOM 变化的毫秒数」 */
async function waitQuiet(wc: Electron.WebContents, quietMs: number, maxMs: number): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const act = (await wc
      .executeJavaScript('(() => { try { return window.__torra.activity() } catch (e) { return -1 } })()', true)
      .catch(() => -1)) as number
    // 拿不到活跃度（页面刚跳转、注入未生效）就别把这一轮卡在等待上
    if (act < 0 || act >= quietMs) return
    await sleep(200)
  }
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
