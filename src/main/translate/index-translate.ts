/**
 * Index-Translate 公开 API 客户端（主进程侧）
 *
 * 为什么放在主进程：这一层要发网络请求，而渲染层被限制在 contextBridge 白名单内，
 * 拿不到 fetch 之外的能力（也不该拿到）。放主进程还能顺手做失败归类，
 * 界面只拿到一句人话。
 *
 * 端点是哔哩哔哩开源项目的免费公开接口，**不校验密钥** —— 因此这里没有
 * 任何凭据处理逻辑，也没有计价。请求口径对齐官方 call_api.py。
 */

import {
  DEFAULT_TRANSLATE_MODEL,
  LANG_NAMES,
  TRANSLATE_IMAGE_MAX_BYTES,
  TRANSLATE_MODELS,
  TRANSLATE_PROMPT_FIELD_MAX_CHARS,
  TRANSLATE_REQUEST_MAX_CHARS,
  TRANSLATE_TEXT_MAX_CHARS,
  buildImageTranslatePrompt,
  buildTranslatePrompt,
  stripThink,
  type TranslateImageInput,
  type TranslateRequest,
  type TranslateResult,
} from '../../shared/translate'
import { diag } from '../diagnostics/log'

/** 官方公开端点 */
export const INDEX_TRANSLATE_BASE = 'https://index-translate.bilibili.com/v1'

/**
 * 真正要打的那个端点。
 *
 * 每次调用时现读，而不是在模块加载时定死 —— 测试要打本地假端点，
 * 改环境变量后不必重新 import 整个模块。
 */
export function indexTranslateBase(): string {
  return process.env.INDEX_TRANSLATE_BASE?.trim() || INDEX_TRANSLATE_BASE
}

/** 一次请求的上限：官方示例用 1024，长文按分批处理 */
const MAX_TOKENS = 4096

/** 官方文档要求关掉思考：开着时 CoT 正文可能顶掉译文 */
const REQUEST_TIMEOUT_MS = 120_000

/** 只放行官方公开端点上真实存在的模型 */
function resolveModel(id: string | undefined): string {
  const want = (id ?? '').trim()
  if (TRANSLATE_MODELS.some((m) => m.id === want)) return want
  return DEFAULT_TRANSLATE_MODEL
}

/** 上游整包响应里可能带的错误 */
function errorOf(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const o = payload as Record<string, unknown>
  if (!o.error) return ''
  const e = o.error
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const m = (e as Record<string, unknown>).message
    if (typeof m === 'string') return m
  }
  return JSON.stringify(e).slice(0, 200)
}

/** 从整包响应里取出正文 */
function textOf(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const o = payload as Record<string, unknown>
  const choices = Array.isArray(o.choices) ? o.choices : []
  const first = choices[0] as Record<string, unknown> | undefined
  const message = first?.message as Record<string, unknown> | undefined
  if (message && typeof message.content === 'string') return message.content
  const text = first?.text
  if (typeof text === 'string') return text
  return ''
}

type PromptContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'])

/** 只接受官方示例覆盖的图片格式，并限制长度，防止超大 IPC 载荷拖死主进程 */
function validImage(image: TranslateImageInput | undefined): image is TranslateImageInput {
  if (!image || typeof image.dataUrl !== 'string') return false
  if (image.mime && !IMAGE_MIMES.has(image.mime.toLowerCase())) return false
  if (image.dataUrl.length > Math.ceil((TRANSLATE_IMAGE_MAX_BYTES * 4) / 3) + 128) return false
  return /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,[a-z0-9+/]+={0,2}$/i.test(image.dataUrl)
}

/**
 * 调一次公开端点。
 *
 * 用非流式整包：翻译是一次性交付的文本，逐字流式只会让界面更复杂，
 * 而公开端点在流式下的分片格式并不稳定（vLLM 兼容层，偶有整包回 JSON）。
 */
async function callOnce(
  model: string,
  content: PromptContent,
): Promise<{ ok: true; text: string } | { ok: false; reason: string; detail?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const res = await fetch(`${indexTranslateBase()}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        temperature: 0,
        max_tokens: MAX_TOKENS,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: controller.signal,
    })

    const raw = await res.text()
    if (!res.ok) {
      /*
       * 504 是网关（openresty）在读超时后自己掐断的，不是模型报的错误。
       * 实测密集文字的大图常常算不完：4000×3000 要 8 秒以上，
       * 而网关读超时通常在 60s。用户拿到的是一个 504 HTML 页，
       * 背后真正的原因只是「这次没算完」。这里翻译成人话并指出可行下一步，
       * 而不是把一段 HTML 原样甩给用户。
       */
      if (res.status === 504) {
        return {
          ok: false,
          reason: '端点算不完这张图就超时了。裁掉无关部分、或换小一点的图再试一次',
          detail: `HTTP 504 来自网关（openresty）而非模型：本次耗时 ${Date.now() - startedAt} ms 仍未返回。通常是图片太大或文字太密，把图缩小或裁剪后重试会顺利得多。`,
        }
      }
      return {
        ok: false,
        reason: `公开端点返回 HTTP ${res.status}`,
        detail: raw.slice(0, 400),
      }
    }

    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return { ok: false, reason: '公开端点返回的不是 JSON', detail: raw.slice(0, 400) }
    }

    const upstreamError = errorOf(payload)
    if (upstreamError) {
      return { ok: false, reason: '公开端点报错', detail: upstreamError }
    }

    const text = stripThink(textOf(payload))
    if (!text) {
      return { ok: false, reason: '模型返回了空内容', detail: raw.slice(0, 400) }
    }
    return { ok: true, text }
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? '请求超时' : (e as Error).message
    return { ok: false, reason: `请求失败：${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 按自然段分批。
 *
 * 切点在空行上 —— 段落边界是最好的翻译单元；实在没有空行（整段一坨）
 * 才退回按字符数硬切，避免把一句话拦腰截断。
 */
export function splitForTranslate(text: string, maxChars = 12_000): string[] {
  if (text.length <= maxChars) return [text]
  const paras = text.split(/\n{2,}/)
  const out: string[] = []
  let cur = ''
  for (const p of paras) {
    if (p.length > maxChars) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      const lines = p.split('\n')
      let piece = ''
      for (const line of lines) {
        if (piece.length + line.length + 1 > maxChars) {
          if (piece.trim()) out.push(piece.trim())
          piece = ''
        }
        if (line.length > maxChars) {
          for (let i = 0; i < line.length; i += maxChars) {
            out.push(line.slice(i, i + maxChars))
          }
          piece = ''
          continue
        }
        piece = piece ? `${piece}\n${line}` : line
      }
      if (piece.trim()) cur = piece
      continue
    }
    if (cur.length + p.length + 2 > maxChars) {
      if (cur.trim()) out.push(cur.trim())
      cur = p
    } else {
      cur = cur ? `${cur}\n\n${p}` : p
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out.length > 0 ? out : [text]
}

/**
 * 翻译一段文本。
 *
 * 超长输入按段落分批：官方模型上下文够长，但一次塞进去几十万字会被
 * 上游静默截断 —— 分批 + 逐批拼接，译文才不会少一截。
 */
export async function translateText(req: TranslateRequest): Promise<TranslateResult> {
  const text = (req.text ?? '').trim()
  if (text.length > TRANSLATE_REQUEST_MAX_CHARS) {
    return { ok: false, text: '', reason: '原文超过 200,000 字，请拆成更小的几段再翻译' }
  }
  if ((req.instruction ?? '').length > TRANSLATE_PROMPT_FIELD_MAX_CHARS) {
    return { ok: false, text: '', reason: '自由指令过长，请控制在 8,000 字以内' }
  }
  if ((req.glossary ?? '').length > TRANSLATE_PROMPT_FIELD_MAX_CHARS) {
    return { ok: false, text: '', reason: '术语对照过长，请控制在 8,000 字以内' }
  }
  const image = validImage(req.image) ? req.image : undefined
  if (req.image && !image) {
    return { ok: false, text: '', reason: '图片格式不支持，或图片超过 12 MB' }
  }
  if (!text && !image) return { ok: false, text: '', reason: '没有待翻译的文本或图片' }

  const target = (req.target ?? '').trim().toLowerCase()
  if (!LANG_NAMES[target]) {
    return { ok: false, text: '', reason: `不认识的目标语言：${req.target}` }
  }

  const model = resolveModel(req.model)
  const t0 = Date.now()

  /*
   * 图片走一次调用就够：官方示例也是单图单请求，没有分批概念。
   * 这里额外加了日志，避免「图片没翻出来」时看不出到底发没发出去。
   */
  if (image) {
    if (text.length > TRANSLATE_TEXT_MAX_CHARS) {
      return {
        ok: false,
        text: '',
        model,
        reason: '图片旁的参考文字最多 12,000 字，请先精简',
      }
    }
    const built = buildImageTranslatePrompt({
      text,
      target,
      source: req.source,
      instruction: req.instruction,
      glossary: req.glossary,
    })
    if (built.error) return { ok: false, text: '', model, reason: built.error }

    const r = await callOnce(model, [
      { type: 'text', text: built.prompt },
      { type: 'image_url', image_url: { url: image.dataUrl } },
    ])
    if (!r.ok) {
      diag.log({
        ts: t0,
        layer: 'runtime',
        stage: 'translate',
        subject: model,
        ok: false,
        ms: Date.now() - t0,
        detail: `target=${target} image=${image.name} ${r.reason}${r.detail ? ` | ${r.detail}` : ''}`,
      })
      return { ok: false, text: '', model, reason: r.reason, detail: r.detail }
    }

    diag.log({
      ts: t0,
      layer: 'runtime',
      stage: 'translate',
      subject: model,
      ok: true,
      ms: Date.now() - t0,
      detail: `target=${target} image=${image.name} outChars=${r.text.length}`,
    })
    return { ok: true, text: r.text, model }
  }

  const chunks = splitForTranslate(text)
  const parts: string[] = []
  for (const chunk of chunks) {
    const built = buildTranslatePrompt({
      text: chunk,
      target,
      source: req.source,
      instruction: req.instruction,
      glossary: req.glossary,
    })
    if (built.error) {
      return { ok: false, text: '', model, reason: built.error }
    }
    const r = await callOnce(model, built.prompt)
    if (!r.ok) {
      diag.log({
        ts: t0,
        layer: 'runtime',
        stage: 'translate',
        subject: model,
        ok: false,
        ms: Date.now() - t0,
        detail: `target=${target} ${r.reason}${r.detail ? ` | ${r.detail}` : ''}`,
      })
      return { ok: false, text: '', model, reason: r.reason, detail: r.detail }
    }
    parts.push(r.text)
  }

  const out = parts.join('\n\n')
  diag.log({
    ts: t0,
    layer: 'runtime',
    stage: 'translate',
    subject: model,
    ok: true,
    ms: Date.now() - t0,
    detail: `target=${target} srcChars=${text.length} outChars=${out.length} chunks=${chunks.length}`,
  })
  return { ok: true, text: out, model }
}
