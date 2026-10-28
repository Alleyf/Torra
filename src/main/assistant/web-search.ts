/**
 * 在线搜索服务：Tavily / AnySearch 两个 Provider
 *
 * 设计约束（与 shared/assistant.ts 的搜索契约一一对应）：
 * - 本文件**不 import Electron**，所有外部依赖（fetch / 取 Key / 日志）都由调用方注入，
 *   便于 scripts/ 下的测试桩替换，也避免主进程模块在测试环境里被 Electron 拖垮。
 * - Key 只从钥匙串取，**绝不**写进 preferences、日志、异常信息、界面回显或模型上下文。
 * - 失败必须明确报错（搜索关闭 / 缺 Key / 超时 / 非 2xx / 空结果 / 解析失败），
 *   **不得凭记忆补造结果**：搜不到就说搜不到。
 * - 日志只记 Provider、成功/失败、结果数量；不记 query、Key、完整响应体。
 */

import {
  SEARCH_MAX_RESULTS_MAX,
  SEARCH_MAX_RESULTS_MIN,
  SEARCH_PREFS_DEFAULT,
  SEARCH_PROVIDER_LABEL,
  clampSearchMaxResults,
  isSearchProvider,
  type AssistantSearchPrefs,
  type AssistantSearchProvider,
  type AssistantSearchTestResult,
} from '../../shared/assistant'

/** 单个搜索结果，字段已截断，可直接进模型上下文 */
export interface WebSearchHit {
  title: string
  url: string
  /** 摘要 / 片段，可能为空串 */
  snippet: string
  /** 发布日期（能解析出来才有），ISO 或原始字符串 */
  published?: string
}

export interface WebSearchOutcome {
  ok: boolean
  provider: AssistantSearchProvider
  hits: WebSearchHit[]
  /** 失败原因；成功时为空。必须是能直接给用户看的中文说明 */
  reason?: string
  /** 端到端耗时（毫秒），日志与测试都会用到 */
  ms?: number
}

/** query 长度上限，超出直接拒绝而不是截断——截断会改变搜索语义 */
const QUERY_MAX = 500
const TITLE_MAX = 200
const SNIPPET_MAX = 600
/** 单次请求超时：搜索是同步等待用户的操作，不能拖太久 */
const TIMEOUT_MS = 15_000

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/mcp'

export interface WebSearchDeps {
  /** 取 Key；返回 null / undefined 视为未配置 */
  getKey(provider: AssistantSearchProvider): string | null | undefined
  /** 当前搜索偏好；未注入时按默认（关闭）处理 */
  getPrefs?(): AssistantSearchPrefs
  /** 日志；只允许传 Provider、成败、条数，**不要传 query / Key / 响应体** */
  log?(entry: { provider: AssistantSearchProvider; ok: boolean; count: number }): void
  /** 测试桩用；默认全局 fetch */
  fetch?: typeof fetch
}

/** 超时 abort，同时让调用方可以通过 signal 中止 */
function abortable(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
  const onOuter = () => ctrl.abort(new Error('aborted'))
  if (outer) {
    if (outer.aborted) ctrl.abort(new Error('aborted'))
    else outer.addEventListener('abort', onOuter, { once: true })
  }
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer)
      if (outer) outer.removeEventListener('abort', onOuter)
    },
  }
}

function isHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!/^https?:\/\//i.test(s)) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname) return null
    // 只小写协议和主机（这两段大小写不敏感，路径大小写敏感）。
    // 不用 u.toString()：它会给 https://x.cn 补成 https://x.cn/ 并重排查询串，
    // 用户点的链接就会和模型引用的对不上。
    const prefix = s.slice(0, u.protocol.length + 2)
    const rest = s.slice(prefix.length)
    const cut = rest.indexOf('/')
    const authority = cut === -1 ? rest : rest.slice(0, cut)
    const path = cut === -1 ? '' : rest.slice(cut)
    return prefix.toLowerCase() + authority.toLowerCase() + path
  } catch {
    return null
  }
}

function clipText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  const s = raw.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function normalizeDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim()
  if (!s) return undefined
  const t = Date.parse(s)
  if (Number.isFinite(t)) return new Date(t).toISOString()
  return s.slice(0, 40)
}

/** 统一清洗：丢非 HTTP(S) URL、按 URL 去重、截断字段、补齐上限 */
function normalizeHits(raw: unknown): WebSearchHit[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: WebSearchHit[] = []
  for (const item of raw) {
    if (out.length >= SEARCH_MAX_RESULTS_MAX) break
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const url = isHttpUrl(row.url)
    if (!url) continue // 非 HTTP(S) 或缺失 URL 的条目直接丢弃
    const key = url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const title = clipText(row.title, TITLE_MAX) || url
    out.push({
      title,
      url,
      snippet: clipText(row.snippet, SNIPPET_MAX),
      ...(row.published ? { published: normalizeDate(row.published) } : {}),
    })
  }
  return out
}

/** 只保留一行可读文字，长度上限 200：错误信息可能被服务端塞进整段 HTML */
function scrub(raw: string): string {
  const first = raw.split('\n')[0]?.trim() ?? ''
  return first.length > 200 ? first.slice(0, 199) + '…' : first
}

/** 兜底抹掉密钥：服务端偶尔会把请求头回显在错误里，宁可我多抹一次也不能漏 */
function redactKey(text: string, key: string): string {
  if (!key || !text.includes(key)) return text
  return text.split(key).join('***')
}

function resolvePrefs(deps: WebSearchDeps): AssistantSearchPrefs {
  const p = deps.getPrefs?.()
  if (!p || typeof p !== 'object') return SEARCH_PREFS_DEFAULT
  return {
    enabled: p.enabled === true,
    provider: isSearchProvider(p.provider) ? p.provider : SEARCH_PREFS_DEFAULT.provider,
  }
}

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<WebSearchHit[]> {
  const res = await doFetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    signal,
  })
  if (!res.ok) throw new Error(`Tavily 返回 HTTP ${res.status}`)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new Error('Tavily 响应不是合法 JSON')
  }
  const row = (json ?? {}) as Record<string, unknown>
  const raw = Array.isArray(row.results) ? row.results : []
  return normalizeHits(
    raw.map((r) => {
      const o = (r ?? {}) as Record<string, unknown>
      return {
        title: o.title,
        url: o.url,
        snippet: o.content ?? o.snippet ?? o.description,
        published: o.published_date,
      }
    }),
  )
}

// ---------------------------------------------------------------------------
// AnySearch（JSON-RPC over MCP）
// ---------------------------------------------------------------------------

/** 从纯文本/Markdown 里抽链接：AnySearch 有时不返回结构化 JSON，只给一段汇总 */
function hitsFromPlainText(text: string): WebSearchHit[] {
  const urls = text.match(/https?:\/\/[^\s)\]\[<>"'\u4e00-\u9fff]+/g) ?? []
  const clipped = clipText(text, SNIPPET_MAX)
  return normalizeHits(
    urls.map((url, i) => ({
      title: `AnySearch 检索结果 ${i + 1}`,
      url: url.replace(/[.,;:\u3002\uff0c\uff1b]+$/, ''), // 去掉句读，链接里没有这些
      snippet: clipped,
    })),
  )
}

/** AnySearch 的 result.content[] 是 {type:'text', text} 列表；正文可能还是 JSON 字符串 */
function parseAnySearchPayload(payload: unknown): unknown {
  const row = (payload ?? {}) as Record<string, unknown>
  const content = row.result && typeof row.result === 'object'
    ? (row.result as Record<string, unknown>).content
    : undefined
  if (Array.isArray(content)) {
    const textItem = content.find((c) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text')
    const text = textItem ? (textItem as Record<string, unknown>).text : undefined
    if (typeof text === 'string' && text.trim()) {
      try {
        return JSON.parse(text)
      } catch {
        // 正文不是 JSON（例如 Markdown 汇总）：抽出里面的链接当结果，抽不到就返回空数组，
        // 由上层判「没有可用结果」。不能造一条没有 URL 的结果——那等于给模型一个无法引用的来源。
        return hitsFromPlainText(text)
      }
    }
    return content
  }
  return row.result ?? payload
}

function anySearchHits(parsed: unknown): WebSearchHit[] {
  // 兼容三种形状：[ {...} ] / { results:[...] } / { items:[...] }
  let list: unknown[] = []
  if (Array.isArray(parsed)) list = parsed
  else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    for (const k of ['results', 'items', 'data', 'web_pages'] as const) {
      const v = o[k]
      if (Array.isArray(v)) {
        list = v
        break
      }
    }
    if (!list.length && o.webPages && typeof o.webPages === 'object') {
      const value = (o.webPages as Record<string, unknown>).value
      if (Array.isArray(value)) list = value
    }
  }
  return normalizeHits(
    list.map((r) => {
      const o = (r ?? {}) as Record<string, unknown>
      return {
        title: o.title ?? o.name,
        url: o.url ?? o.link,
        snippet: o.snippet ?? o.content ?? o.description ?? o.summary ?? o.text,
        published: o.published_date ?? o.date ?? o.published,
      }
    }),
  )
}

async function searchAnySearch(
  query: string,
  maxResults: number,
  apiKey: string | null,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<WebSearchHit[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // 匿名调用不带 Authorization；配了 Key 才带，避免空 Bearer 被服务端当成无效凭据
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await doFetch(ANYSEARCH_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search', arguments: { query, max_results: maxResults, freshness: 'week' } },
    }),
    signal,
  })
  if (!res.ok) throw new Error(`AnySearch 返回 HTTP ${res.status}`)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new Error('AnySearch 响应不是合法 JSON')
  }
  const row = (json ?? {}) as Record<string, unknown>
  if (row.error) {
    const err = row.error as Record<string, unknown>
    throw new Error(typeof err.message === 'string' ? err.message : 'AnySearch 返回错误')
  }
  return anySearchHits(parseAnySearchPayload(json))
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 输入校验：query 必须是非空字符串且不超过 QUERY_MAX；数量按契约夹紧 */
function checkInput(input: { query: unknown; maxResults?: unknown }): { query: string; maxResults: number } | { error: string } {
  const q = typeof input.query === 'string' ? input.query.trim() : ''
  if (!q) return { error: '搜索关键词为空' }
  if (q.length > QUERY_MAX) return { error: `搜索关键词过长（最多 ${QUERY_MAX} 字符）` }
  return { query: q, maxResults: clampSearchMaxResults(input.maxResults) }
}

/**
 * 执行一次在线搜索。
 *
 * 顺序：开关 -> Provider -> Key -> 请求 -> 解析。任何一步失败都返回 ok:false + 中文 reason，
 * 由上层（工具 / 设置页测试按钮）原样转述给用户。
 */
export async function runWebSearch(
  deps: WebSearchDeps,
  input: { query: string; maxResults?: number },
  outerSignal?: AbortSignal,
): Promise<WebSearchOutcome> {
  const started = Date.now()
  const prefs = resolvePrefs(deps)
  const provider = prefs.provider
  const log = (ok: boolean, count: number) => deps.log?.({ provider, ok, count })

  const fail = (reason: string): WebSearchOutcome => {
    log(false, 0)
    return { ok: false, provider, hits: [], reason, ms: Date.now() - started }
  }

  if (!prefs.enabled) return fail('在线搜索未开启，请到「设置 - 搜索」里打开开关')

  const checked = checkInput(input)
  if ('error' in checked) return fail(checked.error)
  const { query, maxResults } = checked

  const label = SEARCH_PROVIDER_LABEL[provider]
  const key = (deps.getKey(provider) ?? '').trim()
  if (provider === 'tavily' && !key) {
    return fail(`未配置 ${label} 的 API Key，请到「设置 - 搜索」里填写后保存`)
  }

  const doFetch = deps.fetch ?? fetch
  const { signal, done } = abortable(TIMEOUT_MS, outerSignal)
  try {
    let hits: WebSearchHit[]
    if (provider === 'tavily') {
      hits = await searchTavily(query, maxResults, key, doFetch, signal)
    } else {
      hits = await searchAnySearch(query, maxResults, key || null, doFetch, signal)
    }
    if (outerSignal?.aborted) return fail('搜索已取消')
    if (!hits.length) {
      log(false, 0)
      return {
        ok: false,
        provider,
        hits: [],
        reason: `${label} 没有返回可用结果（关键词：${clipText(query, 40)}）`,
        ms: Date.now() - started,
      }
    }
    log(true, hits.length)
    return { ok: true, provider, hits, ms: Date.now() - started }
  } catch (e) {
    if (outerSignal?.aborted) return fail('搜索已取消')
    const raw = (e as Error)?.message ?? ''
    // 超时与网络错误分别说明；其余（HTTP 状态、JSON 解析失败、服务端 error.message）
    // 原样带给用户——把它吞成一句「请求失败」等于让用户和模型都无从判断是密钥、
    // 网络还是关键词的问题。堆栈不带，密钥先抹掉。
    const generic = /abort|timeout/i.test(raw)
      ? `搜索超时（${TIMEOUT_MS / 1000} 秒内未响应），请稍后重试`
      : redactKey(scrub(raw), key)
    // 服务端的 error.message 可能很短或没有 provider 前缀，补上是谁报的；空则给兜底文案
    const reason = generic
      ? (generic.startsWith(label) ? generic : `${label}：${generic}`)
      : `${label} 请求失败，请检查网络或密钥配置`
    return fail(reason)
  } finally {
    done()
  }
}

/** 设置页「测试搜索」按钮用：成功时回一条标题，仅供确认连通性 */
export async function testWebSearch(
  deps: WebSearchDeps,
  providerInput?: unknown,
): Promise<AssistantSearchTestResult> {
  const prefs = resolvePrefs(deps)
  const provider = isSearchProvider(providerInput) ? providerInput : prefs.provider
  const r = await runWebSearch(
    { ...deps, getPrefs: () => ({ ...prefs, provider }) },
    { query: 'Torra 在线搜索连通性测试', maxResults: 1 },
  )
  const first = r.hits[0]
  return {
    ok: r.ok,
    provider,
    count: r.hits.length,
    ...(first ? { first: first.title } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.ms !== undefined ? { ms: r.ms } : {}),
  }
}
