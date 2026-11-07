import type { DiagEvent } from '../../shared/diagnostics'
import type { ApiConfig, TokenUsage } from '../../shared/types'
import { DISCUSSION_DEFAULTS, numberBound } from '../../shared/discussion-defaults'
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
/**
 * 主持要输出整份 JSON 小结，给少了会被端点按输出上限截断。
 *
 * 4096 实测不够：一场 4 模型、议题较宽的第 1 轮，两次尝试分别吐了 553 字与 2969 字就断，
 * 两次都停在半个键名上（`"continues":` / callout 的指令中间），流里连 stop_reason 都没有 ——
 * 典型的硬截断。截断的 JSON 读不通，编排器判它非法、重打一次仍旧截断，最后整场以
 * no-moderator 收场，用户看到的就是「跑完了却什么都没留下」。
 *
 * 现在这个数是**出厂默认**，每场可在「设置 → 讨论参数 → 主持输出上限」里调
 * （SessionConfig.moderatorMaxTokens）。数值只留一处真源：shared 的出厂表。
 */
export const MODERATOR_MAX_TOKENS = DISCUSSION_DEFAULTS.moderatorMaxTokens
/**
 * 「预算被思考烧满」时重打一次的上限：按**本次实际用量上限**翻倍，再夹回设置区间。
 *
 * 不能写成一个固定数：每场都能在「设置 → 讨论参数 → 主持输出上限」里调，
 * 固定数会把调大过上限的场次反而**调小**（比如设置 30k 的场次被压回 16k）。
 * 思考长度不是线性可估的，但一次翻倍足以覆盖实测里的 8192 全烧
 * （sess_mw2b9bao_1 四轮全是 8192/8192 的空正文）。
 */
export function escalateModeratorTokens(capTokens: number): number {
  const ceiling = numberBound('moderatorMaxTokens')?.max ?? 65_536
  return Math.min(Math.max(capTokens, MODERATOR_MIN_TOKENS) * 2, ceiling)
}
/** 下限：比它更小的预算连一份最小 JSON 小结都装不下，重打只会立刻再撞上限 */
export const MODERATOR_MIN_TOKENS = numberBound('moderatorMaxTokens')?.min ?? 1_024
/** 上限：常见端点的单次输出天花板，超过它的请求多半直接 400 */
export const MODERATOR_MAX_TOKENS_CEILING = numberBound('moderatorMaxTokens')?.max ?? 65_536

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
  /**
   * 输出 token 上限。缺省取出厂值（8192）；每场可调，见 SessionConfig.moderatorMaxTokens。
   * 端点语义不同：responses 的 max_output_tokens 含推理 token，推理模型可能全烧在
   * 思考上、可见正文为空；调大这一项是那类端点的第一条处置手段。
   */
  maxTokens?: number
}

export interface ModeratorSendResult {
  content: string
  usage: TokenUsage
  /**
   * 正文是闸门掐断时抢回来的半份：内容可能停在半个键名上。
   * 调用方据此把「格式不对」改判成「写太长被切了」，提示语才拦得住模型原样重写。
   */
  truncated?: boolean
}

/**
 * 一次往返的原始结果，通道内部用（对外只有 `ModeratorSendResult`）。
 *
 * 写成具名类型而不是 `Awaited<ReturnType<typeof once>>`：后者把调用方的类型绑在
 * 内部闭包名上，闭包一改名签名就跟着漂，读签名的人还看不出它是什么。
 */
interface ModeratorWireResult {
  content: string
  usage: TokenUsage
  stopReason: string
  streamed: boolean
  /** 见 ModeratorSendResult.truncated */
  truncated: boolean
}

/**
 * 端点回了 200 却零可见文本。
 *
 * 两种成因必须分开，因为处置完全不同：
 * - `hitCap`：输出用量正好撞上这一场的 maxTokens 上限 —— 推理模型的思考把预算烧光了，
 *   正文一个字都没轮到。这是**预算**问题，调大上限再打一次有机会拿到正文；
 * - 未撞上限：端点确实什么都没给（网关只回用量与完成事件）。重打同一份提示词不会变好。
 *
 * 旧实现把两种混成一句「空正文不重试」，于是 8192 全烧在思考里的那一类永远拿不到小结，
 * 每轮都留缺口（实测 sess_mw2b9bao_1 四轮 4/4、sess_mw35mx53_1 两轮 2/2）。
 */
export class ModeratorEmptyBodyError extends Error {
  readonly code = 'empty-body'
  /** 输出用量是否撞上了本次请求的 maxTokens 上限 */
  readonly hitCap: boolean
  /** 本次请求实际用的输出上限：编排器按它算翻倍后的重试预算，不必自己猜配置值 */
  readonly capTokens: number
  constructor(message: string, hitCap = false, capTokens = 0) {
    super(message)
    this.hitCap = hitCap
    this.capTokens = capTokens
  }
}

function parseModeratorHeaders(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

function mergeModeratorHeaders(defaults: Record<string, string>, custom: Record<string, string>): Record<string, string> {
  const headers = { ...defaults }
  for (const [name, value] of Object.entries(custom)) {
    const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
    if (existing) delete headers[existing]
    headers[name] = value
  }
  return headers
}

function responsesOutputText(json: { output_text?: unknown; output?: unknown }): string {
  if (typeof json.output_text === 'string' && json.output_text) return json.output_text
  if (!Array.isArray(json.output)) return ''
  return json.output
    .flatMap((item) => {
      if (!item || typeof item !== 'object' || !Array.isArray((item as { content?: unknown }).content)) return []
      return (item as { content: unknown[] }).content
    })
    .filter((item): item is { type: string; text: string } =>
      !!item && typeof item === 'object' && (item as { type?: unknown }).type === 'output_text' && typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('')
}

export function createModeratorChannel(deps: ModeratorChannelDeps): {
  id: string
  /**
   * `maxTokens` 单次覆盖：编排器发现「预算被思考烧满」时，第二次打这一份提示词
   * 要一个更大的上限。缺省用这一场的设置值 —— 覆盖只作用于这一次请求，
   * 不写回设置，也不改变下一次的默认。
   */
  send: (
    raw: { system: string; user: string; maxTokens?: number },
    onDelta?: (chunk: string) => void,
  ) => Promise<ModeratorSendResult>
} {
  const { id, api, getSecret } = deps
  const idleMs = deps.idleMs ?? MODERATOR_IDLE_MS
  const ceilingMs = deps.ceilingMs ?? MODERATOR_CEILING_MS
  // 每场可调（SessionConfig.moderatorMaxTokens）；没给就用出厂值
  const maxTokens = deps.maxTokens ?? MODERATOR_MAX_TOKENS
  const wireApi = api.wireApi ?? ((api.protocol ?? 'openai') === 'anthropic' ? 'anthropic-messages' : 'chat-completions')
  const anthropic = wireApi === 'anthropic-messages'
  const url = anthropic
    ? anthropicMessagesUrl(api.baseUrl)
    : `${api.baseUrl.replace(/\/+$/, '')}/${wireApi === 'responses' ? 'responses' : 'chat/completions'}`
  const customHeaders = parseModeratorHeaders(api.headersRef ? getSecret(api.headersRef) : null)
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
      { system, user, maxTokens: capOverride }: { system: string; user: string; maxTokens?: number },
      onDelta?: (chunk: string) => void,
    ): Promise<ModeratorSendResult> => {
      /**
       * 本次请求实际使用的输出上限。
       * 覆盖值只在「重打一次、预算翻倍」那条路上出现，且夹在通道自己的区间里：
       * 端点对超出模型天花板的 max_tokens 会直接 400，那等于把一次可救的失败变成不可救。
       */
      const cap = Math.min(
        Math.max(capOverride ?? maxTokens, MODERATOR_MIN_TOKENS),
        MODERATOR_MAX_TOKENS_CEILING,
      )
      const t0 = Date.now()
      const apiKey = getSecret(api.apiKeyRef)
      // Codex 复用 provider 可以只靠自定义请求头鉴权（无 Bearer Key），
      // 与 ApiAgent 的判定口径保持一致：apiKey 或 headers 凭据有其一即可。
      if (!apiKey && Object.keys(customHeaders).length === 0) {
        log({
          ts: t0,
          stage: 'key-missing',
          subject: id,
          ok: false,
          detail: `apiKeyRef=${api.apiKeyRef} 与 headersRef=${api.headersRef ?? '(无)'} 均未提供凭据 —— 这与网页通道的失败无关，改适配器不会修好它`,
        })
        throw new Error('主持模型缺少 API Key 或鉴权请求头')
      }

      const bodyFor = (stream: boolean) =>
        JSON.stringify(
          anthropic
            ? {
                model: api.model,
                max_tokens: cap,
                temperature: 0.2,
                system,
                messages: [{ role: 'user', content: user }],
                ...(stream ? { stream: true } : {}),
              }
            : wireApi === 'responses'
              ? {
                  model: api.model,
                  instructions: system,
                  input: user,
                  max_output_tokens: cap,
                  text: { format: { type: 'json_object' } },
                  ...(stream ? { stream: true } : {}),
                }
              : {
                  model: api.model,
                  temperature: 0.2,
                  max_tokens: cap,
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
        const onceT0 = Date.now()
        let idle: ReturnType<typeof setTimeout> | undefined
        let idleFired = false
        let ceiling: ReturnType<typeof setTimeout> | undefined
        let ceilingFired = false
        /** 本次封顶实际用的总时长：非流式是 ceilingMs，流式确认后换成 absoluteMs */
        let ceilingLimitMs = ceilingMs
        /**
         * 流式累积量必须活到 catch 里。
         *
         * 旧写法把它们声明在 try 内部：封顶一到，catch 看不到已经写出的正文，
         * 只能整包丢掉重打 —— 实测 sess_mva8gp5k_1 第 3 轮首试烧满 360s、174s 后才拿到
         * 一份合格小结，用户看到的是「5 分多钟没结果，然后失败重试」。
         * 写出来又没写完的那半份 JSON 本身就是证据：salvageTruncatedJson 能把它
         * 修成一份可校验的小结，丢掉才是真的浪费。
         */
        let content = ''
        let promptTokens = 0
        let completionTokens = 0
        let stopReason = ''
        const armIdle = () => {
          if (idle !== undefined) clearTimeout(idle)
          idle = setTimeout(() => {
            idleFired = true
            ctrl.abort()
          }, idleMs)
        }
        /*
         * 总时长封顶有两个形态，因为两种病不一样：
         *
         * - 首字节之前（含整包回包）：没有任何可观测的活性，只能按墙钟算，`ceilingMs` 一刀切。
         * - 事件流确认之后：字节还在流就说明这一位**没死**，只是慢 —— 推理模型把 8192 的输出
         *   预算先花在思考上时，180s 会把它当成失败掐掉（实测 sess_mva8gp5k_1 第 2、3 轮
         *   首试都死在「超过 180 秒」，重试才通过，用户看到的就是「主持总结失败重试」）。
         *   所以流式路径换成 `absoluteMs`（ceilingMs 的两倍），只兜住「永远吐不完」。
         *   真断流由空闲闸门（45s 无字节）更快地判掉，这条只负责不死循环。
         */
        const absoluteMs = ceilingMs * 2
        /**
         * 装一次封顶。`limitMs` 是**从 onceT0 起算**的总时长语义，
         * 剩余量在这里换算 —— 报错文案要写的是那个总时长，不是此刻还剩多少。
         */
        const armCeiling = (limitMs: number) => {
          if (ceiling !== undefined) clearTimeout(ceiling)
          ceilingLimitMs = limitMs
          const wait = Math.max(0, limitMs - (Date.now() - onceT0))
          ceiling = setTimeout(() => {
            ceilingFired = true
            ctrl.abort()
          }, wait)
        }
        armCeiling(ceilingMs)
        // 空闲闸门不在这里装：响应头都没回来之前，流式与整包长得一模一样，
        // 提前装会把「慢但正常」的整包回包误判成断流。首字节前由总时长封顶兜底。
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: mergeModeratorHeaders(
              {
                'Content-Type': 'application/json',
                // 纯 headers 凭据的 provider 没有 Bearer Key：anthropic 侧降级为只发版本头，
                // openai 侧不发 Authorization，交由自定义头（可能含 x-api-key/Authorization）接管
                ...(anthropic
                  ? { ...(apiKey ? { 'x-api-key': apiKey } : {}), 'anthropic-version': '2023-06-01' }
                  : apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
              },
              customHeaders,
            ),
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
              output_text?: unknown
              output?: unknown
              error?: { message?: string }
              status?: string
              usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
              message?: { usage?: { input_tokens?: number; output_tokens?: number } }
            }
            if (wireApi === 'responses' && (json.status === 'failed' || json.error)) {
              throw new Error(`主持模型 Responses 错误: ${json.error?.message ?? 'response failed'}`)
            }
            promptTokens = json.usage?.prompt_tokens ?? json.usage?.input_tokens ?? json.message?.usage?.input_tokens ?? 0
            completionTokens = json.usage?.completion_tokens ?? json.usage?.output_tokens ?? json.message?.usage?.output_tokens ?? 0
            /**
             * 这里绝不能补 '{}'：空正文是「端点没有给出可见文本」，
             * 补一个空对象会把它伪装成「模型写了一份缺字段的 JSON」，
             * 编排器于是按格式问题重打一次，再拿同一份空回包，最后以
             * 「score_dimensions 缺失」收场 —— 报的病因和真实病因毫无关系。
             */
            content = anthropic
              ? json.content?.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('') ?? ''
              : wireApi === 'responses'
                ? responsesOutputText(json)
                : json.choices?.[0]?.message?.content ?? ''
            return {
              content,
              usage: { promptTokens, completionTokens, costUsd: costOf(promptTokens, completionTokens) },
              stopReason: '',
              streamed: false,
              // 整包回包没有「被掐断的半份」这回事：JSON 要么完整要么根本没有
              truncated: false,
            }
          }

          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          let responsesCompleted = false
          const feed = (line: string) => {
            const t = line.trim()
            if (!t.startsWith('data:')) return
            const payload = t.slice(5).trim()
            if (payload === '[DONE]') return
            let json: {
              type?: string
              status?: string
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
              delta?: { text?: string; stop_reason?: string } | string
              response?: {
                output_text?: unknown
                output?: unknown
                error?: { message?: string }
                usage?: { input_tokens?: number; output_tokens?: number }
              }
              error?: { message?: string }
              /** Responses 的 error 事件里 message 是字符串；Anthropic 的 message_start 里 message 是带 usage 的对象 */
              message?: string | { usage?: { input_tokens?: number; output_tokens?: number } }
              usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
            }
            try {
              json = JSON.parse(payload)
            } catch {
              return
            }
            if (wireApi === 'responses') {
              if (json.type === 'response.failed' || json.type === 'error' || json.status === 'failed') {
                const detail = typeof json.message === 'string' ? json.message : json.response?.error?.message ?? json.error?.message
                throw new Error(`主持模型 Responses 错误: ${detail ?? 'response failed'}`)
              }
              if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') {
                content += json.delta
                onDelta?.(json.delta)
              }
              // incomplete（输出预算截断）也算收到收尾：拿已有正文结账，别按断流报错
              if (json.type === 'response.completed' || json.type === 'response.incomplete') {
                responsesCompleted = true
                promptTokens = json.response?.usage?.input_tokens ?? promptTokens
                completionTokens = json.response?.usage?.output_tokens ?? completionTokens
                if (!content && json.response) {
                  const completedText = responsesOutputText(json.response)
                  if (completedText) {
                    content = completedText
                    onDelta?.(completedText)
                  }
                }
              }
              return
            }
            const piece = anthropic
              ? json.type === 'content_block_delta' && typeof json.delta === 'object'
                ? json.delta.text ?? ''
                : ''
              : json.choices?.[0]?.delta?.content ?? ''
            if (piece) {
              content += piece
              onDelta?.(piece)
            }
            stopReason = (typeof json.delta === 'object' ? json.delta?.stop_reason : undefined) ?? json.choices?.[0]?.finish_reason ?? stopReason
            // Anthropic：输入量在 message_start 的 message.usage，输出量在 message_delta 的 usage；
            // OpenAI 兼容：两者都在顶层 usage（prompt_tokens/completion_tokens）
            const msgUsage = json.message && typeof json.message === 'object' ? json.message.usage : undefined
            promptTokens = json.usage?.prompt_tokens ?? json.usage?.input_tokens ?? msgUsage?.input_tokens ?? promptTokens
            completionTokens = json.usage?.completion_tokens ?? json.usage?.output_tokens ?? msgUsage?.output_tokens ?? completionTokens
          }
          // 确认是事件流才开始计「没有动静」：首块之前也装一次，卡在头与首块之间同样要断
          armIdle()
          // 流式确认后换成绝对上限：字节还在流就不算死，只兜「永远吐不完」，见上面的注释
          armCeiling(absoluteMs)
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
          if (wireApi === 'responses' && !responsesCompleted) {
            throw new Error('主持模型 Responses 流未收到完成事件（completed/incomplete）')
          }
          return {
            content,
            usage: { promptTokens, completionTokens, costUsd: costOf(promptTokens, completionTokens) },
            stopReason,
            streamed: true,
            truncated: false,
          }
        } catch (e) {
          if ((e as Error).name !== 'AbortError') throw e
          /*
           * 两种掐断必须分开处置，判据是「谁先到」而不是「有没有正文」：
           *
           * - 空闲闸门（idleFired）：45s 一个字节都没来 —— 连接真的断了。这时交回半份
           *   等于把断流说成「模型写短了」，编排器会拿着半份重试，而真实病因是网络/端点。
           *   照旧抛出可上屏的原因。
           * - 总时长封顶（ceilingFired）：字节一直在流，只是永远收不了尾。已经写出的
           *   正文是**真的产出**：旧做法整包丢弃，360s 的时间与 token 一起作废，编排器
           *   再从零重打一次（实测第 3 轮首试 360s 丢弃 + 重试 174s = 534s，用户看到
           *   「5 分多钟没结果，然后失败重试」）。现在按「写到这里为止」结账，
           *   由 parseModeratorJson 的 salvage 分支补闭合再照常过机械校验。
           *   校验不过该重试还是重试，但至少那一次不是白烧。
           */
          const reason = idleFired
            ? `主持模型 ${Math.round(idleMs / 1000)} 秒没有任何返回`
            : `主持模型请求超过 ${Math.round(ceilingLimitMs / 1000)} 秒`
          if (!idleFired && content.includes('{')) {
            log({
              ts: t0,
              stage: 'ceiling-salvage',
              subject: id,
              ok: true,
              ms: Date.now() - t0,
              detail: `${reason}，但已写出 ${content.length} 字 —— 按截断结果交回，交给 salvage 补闭合`,
            })
            return {
              content,
              usage: { promptTokens, completionTokens, costUsd: costOf(promptTokens, completionTokens) },
              stopReason,
              streamed: true,
              truncated: true,
            }
          }
          throw new Error(reason)
        } finally {
          if (idle !== undefined) clearTimeout(idle)
          clearTimeout(ceiling)
        }
      }

      let r: ModeratorWireResult
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
      /*
       * 空正文不是「格式不对」：这一轮花的输出 token（成本照计）落在了思考/推理里，
       * 端点一个可见字符都没给。
       *
       * 但「预算被思考烧满」与「端点什么都没给」是两种病：前者调大 maxTokens 再打一次
       * 有机会拿到正文（推理模型少想一点、或预算翻倍），后者重打只会拿到同样的空回包
       * （实测两次 75s 都是空的）。判据是输出用量有没有撞上本次请求的上限。
       */
      if (r.content.trim().length === 0) {
        const hitCap = r.usage.completionTokens >= cap
        throw new ModeratorEmptyBodyError(
          `主持模型返回了空正文：完成原因 ${r.stopReason || '未知'}，输出 ${r.usage.completionTokens}/${cap} tokens（${r.streamed ? '流式' : '整包'}）。` +
            (hitCap
              ? '输出预算被思考过程烧满了，正文一个字都没轮到 —— 这一轮会按「预算不足」重打一次，上限翻倍。'
              : '端点只给了思考过程或什么都没给，重发同一份提示词不会变好 —— 请更换主持模型或改用无主持降级。'),
          hitCap,
          cap,
        )
      }
      return { content: r.content, usage: r.usage, ...(r.truncated ? { truncated: true } : {}) }
    },
  }
}
