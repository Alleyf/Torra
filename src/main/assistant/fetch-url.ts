/**
 * 直接抓取一个 URL。
 *
 * 为什么要有它：助手原来的联网能力只有 torra_web_search —— 那需要用户先在设置页
 * 配 Provider 和 Key。用户给了一个确切的接口地址（日报 JSON、状态页、文档）时，
 * 再绕一层搜索引擎既慢又不准，模型只能回答「我没有 fetch 工具」。
 *
 * 三条边界：
 * - 只认 http/https，只做 GET/HEAD。不带任何钥匙串凭据，无法改配置，所以不过确认卡片。
 * - 有超时（20s）、响应体上限（1MB）与进上下文的字符上限（默认 8k）：
 *   一个几千行的 JSON 或整站 HTML 直接进窗口，比抓取失败更糟。
 * - 失败必须带原因（超时 / 网络 / 非法地址），不能拿记忆补内容。
 *
 * 本文件不 import Electron，也不依赖具体模型：离线测试直接替换 fetch。
 */

import { defineTool, Type, type TorraTool } from '../../shared/tool'

const TIMEOUT_MS = 20_000
/** 下载上限：只用来读一段数据，不是做镜像 */
const MAX_BYTES = 1_000_000
export const FETCH_TEXT_DEFAULT = 8000
const FETCH_TEXT_MAX = 24_000
/** 只认这两种方法：POST 会改外部世界状态，不在这个工具的语义里 */
const METHODS = ['GET', 'HEAD'] as const

export interface FetchUrlInput {
  url: string
  method?: 'GET' | 'HEAD'
  maxChars?: number
}

export interface FetchUrlResult {
  ok: boolean
  /** 服务端返回的状态码；网络层失败时没有 */
  status?: number
  /** 跟随重定向后的最终地址 */
  finalUrl?: string
  contentType?: string
  /** 实际读到的字节数（封顶 1MB） */
  bytes?: number
  /** 是否因为体积/字数上限被截断 */
  truncated?: boolean
  text?: string
  /** 失败原因：中文，能直接给用户看 */
  reason?: string
  /** 端到端耗时 */
  ms?: number
}

export interface FetchUrlDeps {
  /** 测试桩用；默认全局 fetch */
  fetch?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
}

/** 只接受 http(s)，且不允许把凭据写进 URL（会被日志、上下文、界面三处回显） */
export function normalizeFetchUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!/^https?:\/\//i.test(s)) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname) return null
    if (u.username || u.password) return null
    return s
  } catch {
    return null
  }
}

/** 字符集从 Content-Type 里取；TextDecoder 认不了就退回 utf-8，不因为编码标签写错而整条失败 */
function decodeBody(buf: Buffer, contentType: string): string {
  const m = /charset=([\w-]+)/i.exec(contentType)
  const label = (m?.[1] ?? 'utf-8').toLowerCase()
  try {
    return new TextDecoder(label).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

const ENTITY: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
}

/** 够用的 HTML → 文本：去掉脚本样式，块级元素换行，解常见实体 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const spaced = stripped
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const decoded = spaced.replace(/&(#x?[0-9a-f]+|\w+);/gi, (all, key: string) => {
    const k = key.toLowerCase()
    if (k.startsWith('#x')) {
      const code = Number.parseInt(k.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : all
    }
    if (k.startsWith('#')) {
      const code = Number.parseInt(k.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : all
    }
    return ENTITY[k] ?? all
  })
  return decoded
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** 一段文本的可读化：HTML 去标签，其余原样；统一换行并压掉行尾空白 */
function readable(body: string, contentType: string): string {
  const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /^\s*<(!doctype|html|head|body)\b/i.test(body)
  const out = isHtml ? htmlToText(body) : body
  return out.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

/** 按上限读流：不先 arrayBuffer() —— 那等于把整个响应先收进内存再截 */
async function readCapped(res: Response, cap: number): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!res.body) {
    const ab = await res.arrayBuffer()
    const buf = Buffer.from(ab)
    return { buf: buf.subarray(0, cap), truncated: buf.byteLength > cap }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    if (total + value.byteLength >= cap) {
      chunks.push(value.subarray(0, cap - total))
      total = cap
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  return { buf: Buffer.concat(chunks), truncated }
}

function scrubError(raw: string): string {
  const first = raw.split('\n')[0]?.trim() ?? ''
  return first.length > 200 ? `${first.slice(0, 199)}…` : first
}

/**
 * 执行一次抓取。
 *
 * 注意：HTTP 4xx/5xx 不算「抓取失败」—— 状态码本身就是模型需要的事实
 * （404 页面的正文常常写着「接口已迁移」）。只有网络层失败才回 ok:false。
 */
export async function runFetchUrl(input: FetchUrlInput, deps: FetchUrlDeps = {}): Promise<FetchUrlResult> {
  const started = Date.now()
  const url = normalizeFetchUrl(input.url)
  if (!url) {
    return {
      ok: false,
      reason: '只支持 http/https 地址，且不要把账号密码写进 URL。',
      ms: Date.now() - started,
    }
  }
  const method = METHODS.includes(input.method as (typeof METHODS)[number]) ? (input.method as 'GET' | 'HEAD') : 'GET'
  const maxChars = Math.min(
    FETCH_TEXT_MAX,
    Math.max(500, Math.round(Number(input.maxChars) || FETCH_TEXT_DEFAULT)),
  )
  const doFetch = deps.fetch ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), deps.timeoutMs ?? TIMEOUT_MS)
  const cap = deps.maxBytes ?? MAX_BYTES
  try {
    const res = await doFetch(url, {
      method,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        // 不少站点会拒绝没有 UA 的请求；说明自己是谁，别伪装成浏览器
        'user-agent': 'TorraAssistant/1.0 (+https://github.com/Alleyf/Torra)',
        accept: 'application/json, text/plain;q=0.9, text/html;q=0.8, */*;q=0.5',
      },
    })
    const contentType = res.headers.get('content-type') ?? ''
    if (method === 'HEAD') {
      const len = Number(res.headers.get('content-length') ?? 0)
      return {
        ok: true,
        status: res.status,
        finalUrl: res.url || url,
        contentType,
        bytes: Number.isFinite(len) ? len : 0,
        truncated: false,
        text: '',
        ms: Date.now() - started,
      }
    }
    const { buf, truncated: cut } = await readCapped(res, cap)
    const body = readable(decodeBody(buf, contentType), contentType)
    const clipped = body.length > maxChars
    const text = clipped ? `${body.slice(0, maxChars)}\n…（已截断，正文共 ${body.length} 字符）` : body
    return {
      ok: true,
      status: res.status,
      finalUrl: res.url || url,
      contentType,
      bytes: buf.byteLength,
      truncated: cut || clipped,
      text,
      ms: Date.now() - started,
    }
  } catch (e) {
    const raw = (e as Error)?.message ?? ''
    const reason = /abort|timeout/i.test(raw)
      ? `抓取超时（${Math.round((deps.timeoutMs ?? TIMEOUT_MS) / 1000)} 秒内没有完成），站点可能较慢或不可达`
      : `抓取失败：${scrubError(raw) || '网络错误'}`
    return { ok: false, reason, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 工具定义。普通会话与定时任务共用同一份 —— 两个入口各写一份的话，
 * 参数名或上限迟早分叉，而分叉的那一边没人测过。
 */
export function createFetchTool(
  /** 测试桩：替换请求实现与上限，不改全局 fetch */
  deps: FetchUrlDeps = {},
): TorraTool {
  return defineTool({
    name: 'torra_fetch_url',
    label: '抓取网页/接口',
    description:
      '直接 GET 一个 http/https 地址，拿回正文（JSON 原样、HTML 转纯文本）。' +
      '用户给的是确切地址（接口、日报源、状态页、文档）时用它，不要再绕去搜索。' +
      '只支持 GET/HEAD；有 20 秒超时与体积/字数上限，超限会标明「已截断」。' +
      'HTTP 4xx/5xx 不算抓取失败，状态码会原样返回；只有网络层失败才是 ok:false，失败就如实说明，不要编内容。',
    parameters: Type.Object({
      url: Type.String({ description: '完整地址，必须以 http:// 或 https:// 开头；不要把账号密码写进 URL' }),
      method: Type.Optional(Type.String({ description: "'GET'（默认）或 'HEAD'；只读探测用 HEAD" })),
      maxChars: Type.Optional(
        Type.Number({ description: '最多带回多少字符，默认 8000，上限 24000；够读关键部分就好' }),
      ),
    }),
    async execute(_id: string, params: { url: string; method?: 'GET' | 'HEAD'; maxChars?: number }) {
      const r = await runFetchUrl(params, deps)
      if (!r.ok) {
        return {
          content: [{ type: 'text' as const, text: r.reason ?? '抓取失败' }],
          details: { ok: false },
        }
      }
      const head = [
        `${params.method === 'HEAD' ? 'HEAD' : 'GET'} ${r.finalUrl ?? params.url} → HTTP ${r.status ?? '?'}`,
        r.contentType ? `类型：${r.contentType}` : '',
        typeof r.bytes === 'number' ? `大小：${(r.bytes / 1024).toFixed(1)} KB${r.truncated ? '（已截断）' : ''}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      const body = r.text ? `\n\n${r.text}` : ''
      return {
        content: [{ type: 'text' as const, text: `${head}${body}` }],
        details: {
          ok: true,
          status: r.status,
          contentType: r.contentType,
          bytes: r.bytes,
          truncated: r.truncated,
          ms: r.ms,
        },
      }
    },
  })
}
