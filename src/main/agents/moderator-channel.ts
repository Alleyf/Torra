import type { DiagEvent } from '../../shared/diagnostics'
import type { ApiConfig, TokenUsage } from '../../shared/types'
import { anthropicMessagesUrl } from './api-agent'

/**
 * 主持通道（API-only）。
 * 主持需要独立的 system prompt（只输出 JSON），与参会模型的发言通道不同，
 * 因此这里直接走底层 HTTP，不复用参会发言的 prompt 组装。
 *
 * 抽成独立模块有两个原因：
 * - 参会发言走 Agent.send，主持要的是「整份 JSON + 逐字进度」，两条通道的错误口径不同；
 * - 主持的等待闸门（空闲断流、总时长封顶、4xx 退整包）必须能被本地假端点复现，
 *   放在主进程入口里就只能靠真机真 token 才能验证。
 */
/** 主持小结的等待口径：45 秒没有任何字节就断，总时长仍封顶 180 秒 */
export const MODERATOR_IDLE_MS = 45_000
export const MODERATOR_CEILING_MS = 180_000
/** 与参会发言同档：主持要输出整份 JSON 小结，给少了会截断成非法 JSON，反而多跑一次往返 */
export const MODERATOR_MAX_TOKENS = 4_096

export interface ModeratorChannelDeps {
  id: string
  api: ApiConfig
  /** 取密钥：主进程走系统钥匙串，离线验证注入假值 */
  getSecret: (ref: string) => string | null
  /** 运行期日志，layer 由本模块补齐 */
  log?: (e: DiagEvent) => void
  /** 等待闸门，离线验证可缩短；默认 45s 空闲 / 180s 总时长 */
  idleMs?: number
  ceilingMs?: number
}

export interface ModeratorSendResult {
  content: string
  usage: TokenUsage
}

export function createModeratorChannel(deps: ModeratorChannelDeps): {
  id: string
  send: (
    raw: { system: string; user: string },
    onDelta?: (chunk: string) => void,
  ) => Promise<ModeratorSendResult>
} {
  const { id, api, getSecret } = deps
  const idleMs = deps.idleMs ?? MODERATOR_IDLE_MS
  const ceilingMs = deps.ceilingMs ?? MODERATOR_CEILING_MS
  const anthropic = api.protocol === 'anthropic'
  const url = anthropic ? anthropicMessagesUrl(api.baseUrl) : `${api.baseUrl.replace(/\/$/, '')}/chat/completions`
  const log = (e: Omit<DiagEvent, 'layer'>) => deps.log?.({ ...e, layer: 'moderator' })
  const costOf = (p: number, c: number) =>
    Math.round(((p / 1e6) * api.pricePerMTokIn + (c / 1e6) * api.pricePerMTokOut) * 1e6) / 1e6

  return {
    id,
    /**
     * 流式发一次主持小结。onDelta 只为把「还在吐字」交给 UI：主持输出是整份 JSON，
     * 半截内容读不通，但字数在涨与原文尾巴足以把等待和有故障区分开。
     */
    send: async (
      { system, user }: { system: string; user: string },
      onDelta?: (chunk: string) => void,
    ): Promise<ModeratorSendResult> => {
      const t0 = Date.now()
      const apiKey = getSecret(api.apiKeyRef)
      if (!apiKey) {
        log({
          ts: t0,
          stage: 'key-missing',
          subject: id,
          ok: false,
          detail: `apiKeyRef=${api.apiKeyRef} 未配置 —— 这与网页通道的失败无关，改适配器不会修好它`,
        })
        throw new Error('主持模型缺少 API Key')
      }

      const bodyFor = (stream: boolean) =>
        JSON.stringify(
          anthropic
            ? {
                model: api.model,
                max_tokens: MODERATOR_MAX_TOKENS,
                temperature: 0.2,
                system,
                messages: [{ role: 'user', content: user }],
                ...(stream ? { stream: true } : {}),
              }
            : {
                model: api.model,
                temperature: 0.2,
                max_tokens: MODERATOR_MAX_TOKENS,
                response_format: { type: 'json_object' },
                messages: [
                  { role: 'system', content: system },
                  { role: 'user', content: user },
                ],
                ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
              },
        )

      /** 一次往返：stream=false 时走整包 JSON，用于上游不认流式参数的退路 */
      const once = async (stream: boolean) => {
        const ctrl = new AbortController()
        let idle: ReturnType<typeof setTimeout> | undefined
        let idleFired = false
        const armIdle = () => {
          if (idle !== undefined) clearTimeout(idle)
          idle = setTimeout(() => {
            idleFired = true
            ctrl.abort()
          }, idleMs)
        }
        const ceiling = setTimeout(() => ctrl.abort(), ceilingMs)
        // 空闲闸门不在这里装：响应头都没回来之前，流式与整包长得一模一样，
        // 提前装会把「慢但正常」的整包回包误判成断流。首字节前由总时长封顶兜底。
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(anthropic
                ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
                : { Authorization: `Bearer ${apiKey}` }),
            },
            body: bodyFor(stream),
            signal: ctrl.signal,
          })

          if (!res.ok) {
            const t = await res.text().catch(() => '')
            log({
              ts: t0,
              stage: 'http',
              subject: id,
              ok: false,
              ms: Date.now() - t0,
              // 只记状态码与响应片段：响应体可能含请求回显，不整段落盘
              detail: `HTTP ${res.status} stream=${stream ? 1 : 0} ${t.slice(0, 160)}`,
            })
            const err = new Error(`主持模型 HTTP ${res.status}: ${t.slice(0, 200)}`) as Error & {
              httpStatus?: number
            }
            err.httpStatus = res.status
            throw err
          }

          const ctype = res.headers.get('content-type') ?? ''
          if (!stream || !res.body || !ctype.includes('text/event-stream')) {
            // 要了流式却拿到整包：不装空闲闸门，剩下的交给总时长封顶
            const json = (await res.json()) as {
              choices?: Array<{ message?: { content?: string } }>
              content?: Array<{ type?: string; text?: string }>
              usage?: { prompt_tokens?: number; completion_tokens?: number }
              message?: { usage?: { input_tokens?: number; output_tokens?: number } }
            }
            const p = json.usage?.prompt_tokens ?? json.message?.usage?.input_tokens ?? 0
            const c = json.usage?.completion_tokens ?? json.message?.usage?.output_tokens ?? 0
            const content = anthropic
              ? json.content?.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('') || '{}'
              : json.choices?.[0]?.message?.content ?? '{}'
            return { content, usage: { promptTokens: p, completionTokens: c, costUsd: costOf(p, c) }, stopReason: '', streamed: false }
          }

          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          let content = ''
          let p = 0
          let c = 0
          let stopReason = ''
          const feed = (line: string) => {
            const t = line.trim()
            if (!t.startsWith('data:')) return
            const payload = t.slice(5).trim()
            if (payload === '[DONE]') return
            let json: {
              type?: string
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
              delta?: { text?: string; stop_reason?: string }
              usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
              message?: { usage?: { input_tokens?: number; output_tokens?: number } }
            }
            try {
              json = JSON.parse(payload)
            } catch {
              return
            }
            const piece = anthropic
              ? json.type === 'content_block_delta'
                ? json.delta?.text ?? ''
                : ''
              : json.choices?.[0]?.delta?.content ?? ''
            if (piece) {
              content += piece
              onDelta?.(piece)
            }
            stopReason = json.delta?.stop_reason ?? json.choices?.[0]?.finish_reason ?? stopReason
            p = json.usage?.prompt_tokens ?? json.message?.usage?.input_tokens ?? p
            c = json.usage?.completion_tokens ?? json.usage?.output_tokens ?? json.message?.usage?.output_tokens ?? c
          }
          // 确认是事件流才开始计「没有动静」：首块之前也装一次，卡在头与首块之间同样要断
          armIdle()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            armIdle()
            buf += dec.decode(value, { stream: true })
            const nl = buf.lastIndexOf('\n')
            if (nl < 0) continue
            const lines = buf.slice(0, nl).split('\n')
            buf = buf.slice(nl + 1)
            for (const line of lines) feed(line)
          }
          buf += dec.decode()
          if (buf) feed(buf)
          return {
            content: content || '{}',
            usage: { promptTokens: p, completionTokens: c, costUsd: costOf(p, c) },
            stopReason,
            streamed: true,
          }
        } catch (e) {
          if ((e as Error).name === 'AbortError') {
            throw new Error(
              idleFired
                ? `主持模型 ${Math.round(idleMs / 1000)} 秒没有任何返回`
                : `主持模型请求超过 ${Math.round(ceilingMs / 1000)} 秒`,
            )
          }
          throw e
        } finally {
          if (idle !== undefined) clearTimeout(idle)
          clearTimeout(ceiling)
        }
      }

      let r: Awaited<ReturnType<typeof once>>
      try {
        r = await once(true)
      } catch (e) {
        // 少数网关不认 stream / stream_options 会直接回 4xx：退一次整包，别把整场主持打死。
        // 429 是限流，重发只会更糟，照原样冒泡给编排层按失败计次。
        const status = (e as { httpStatus?: number }).httpStatus
        if (status === undefined || status < 400 || status >= 500 || status === 429) throw e
        log({
          ts: t0,
          stage: 'stream-fallback',
          subject: id,
          ok: true,
          ms: Date.now() - t0,
          detail: `流式被 ${status} 拒绝，改整包重发一次（这一轮没有逐字进度）`,
        })
        r = await once(false)
      }

      log({
        ts: t0,
        stage: 'http',
        subject: id,
        ok: true,
        ms: Date.now() - t0,
        detail: `systemChars=${system.length} userChars=${user.length} chars=${r.content.length} stream=${r.streamed ? 1 : 0} stop=${r.stopReason || '-'}`,
      })
      return { content: r.content, usage: r.usage }
    },
  }
}
