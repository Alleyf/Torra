/**
 * 记忆库的读写实现：分块、嵌入、写入（put-many）、两种检索、结果排版。
 *
 * 这里的每一条命令都是对着真实二进制跑出来的，不是照文档猜的：
 *
 * - 写入：`put-many <file> --input <json> -m <identity> --dedup --json`。
 *   批量接口的每条请求可以带 `embedding`，所以向量由 Torra 自己算、一次进程调用写完所有块。
 *   （`put` 的单条接口也支持 `--embedding-vec`，但 N 块就要 N 次进程启动，且 CLI 会忽略
 *   `OPENAI_BASE_URL` —— 自算向量是唯一能接自定义端点的路。）
 * - 语义检索：`vec-search <file> --embedding <json> --limit N --json`，返回数组
 *   `[{frame_id, distance, preview}]`，distance 越小越近（0 = 完全一致）。
 * - 关键词检索：`find <file> --query Q --top-k N --mode lex --json`，返回
 *   `{metadata:{total_hits}, hits:[{title, text, score}]}`。**中文不命中**：tantivy 不分词，
 *   实测「缓存」0 条、「verify」1 条。
 * - 统计：`stats <file> --json` 的 summary 是给人看的字符串（"2 total (2 active)"），照抄不换算。
 *
 * 帧文本里会被 memvid 追加一段元数据尾巴（title/uri/tags/extractous_metadata…），
 * 检索结果必须剥掉它，否则模型看到的是「内容 + 一串属性行」。
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MEMORY_FILE_RE,
  clampMemoryTopK,
  embeddingsEndpoint,
  memoryModelIdentity,
  type MemorySearchHit,
} from '../../shared/memory'

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  maxChars?: number
  overlap?: number
}

/** 单块默认上限：800 字符 ≈ 中文 400~600 字，足够自洽又不至于把一条事实埋掉 */
export const CHUNK_MAX_CHARS = 800
export const CHUNK_OVERLAP = 120

/**
 * 按段落打包成块，相邻块之间留一段重叠。
 *
 * 重叠是有代价的（库里多存一份字），但它防的是「答案正好横跨切点」：不重叠时
 * 一条事实被切成两半，两块都检索得到、两块都不完整。
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const max = Math.max(200, opts.maxChars ?? CHUNK_MAX_CHARS)
  const overlap = Math.min(Math.max(0, opts.overlap ?? CHUNK_OVERLAP), Math.floor(max / 4))
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!clean) return []
  const pieces: string[] = []
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.trim()
    if (!p) continue
    if (p.length <= max) pieces.push(p)
    else pieces.push(...splitLong(p, max))
  }
  const chunks: string[] = []
  let cur = ''
  for (const p of pieces) {
    const next = cur ? `${cur}\n\n${p}` : p
    if (next.length <= max) {
      cur = next
      continue
    }
    chunks.push(cur)
    // 最后一段的重叠尾巴 + 新段落：重叠最多 overlap 字符，所以单块最长 max + overlap + 2
    cur = overlap > 0 ? `${cur.slice(-overlap)}\n\n${p}` : p
  }
  if (cur) chunks.push(cur)
  return chunks
}

/** 超长段落按句末切开；单句还是超长就硬切（宁可截断语义，也不能让一块无限大） */
function splitLong(p: string, max: number): string[] {
  const parts = p.split(/(?<=[。！？!?；;.\n])/).filter((s) => s.trim())
  const out: string[] = []
  let cur = ''
  for (const s of parts) {
    if (s.length > max) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max))
      continue
    }
    if ((cur + s).length <= max) cur += s
    else {
      if (cur) out.push(cur)
      cur = s
    }
  }
  if (cur) out.push(cur)
  return out.length ? out : [p.slice(0, max)]
}

/**
 * 剥掉 memvid 追加的元数据尾巴。
 *
 * 尾巴以 `extractous_metadata: ` 行开头（提取器固定会写），前面还有 title/uri/tags/labels。
 * 从第一个这类行整段切掉：它们全在末尾、且是注入的，不可能是用户内容。
 */
export function stripFrameMeta(text: string): string {
  const clean = String(text ?? '')
  const cut = clean.search(/\n(extractous_metadata|memvid\.[a-z0-9_.]+):\s/)
  const body = cut >= 0 ? clean.slice(0, cut) : clean
  // 尾巴即使没有 extractous 行，也可能只剩 title/uri/tags 这几行属性
  return body.replace(/\n(title|uri|tags|labels): [^\n]*$/g, '').trim()
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 单条结果的片段上限：够认出是哪条事实，又不让一条命中占满上下文 */
const SNIPPET_MAX = 500

export function frameSnippet(text: string, max = SNIPPET_MAX): string {
  const body = collapse(stripFrameMeta(text))
  if (body.length <= max) return body
  return `${body.slice(0, max)}…`
}

// ---------------------------------------------------------------------------
// 嵌入：OpenAI 兼容端点
// ---------------------------------------------------------------------------

export interface EmbedConfig {
  baseUrl: string
  model: string
  dims: number
  apiKey: string | null
}

export interface EmbedDeps {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

const EMBED_TIMEOUT_MS = 30_000

/** 解析 `/embeddings` 的两种常见形态：`{data:[{embedding}]}` 与 `{embedding}` */
export function parseEmbeddingResponse(json: unknown): number[][] {
  if (!json || typeof json !== 'object') throw new Error('嵌入响应不是 JSON 对象')
  const obj = json as { data?: unknown; embedding?: unknown }
  const rows: unknown[] = Array.isArray(obj.data) ? obj.data : obj.embedding !== undefined ? [obj] : []
  if (!rows.length) throw new Error('嵌入响应里没有 data[].embedding')
  return rows.map((row, i) => {
    const r = row as { embedding?: unknown; index?: unknown }
    const vec = r?.embedding
    if (!Array.isArray(vec) || vec.length === 0) throw new Error(`嵌入响应第 ${i + 1} 条没有向量`)
    if (!vec.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new Error(`嵌入响应第 ${i + 1} 条含非数字分量`)
    }
    return vec as number[]
  })
}

/**
 * 一次请求把所有块算完。
 *
 * 维度必须是配置里那一个：memvid 的库按维度索引，查询向量和写入向量不一致时
 * 检索直接失败（实测报 "Vector dimension mismatch"）。所以这里提前拦下并说清实际维度，
 * 免得用户看到一句「检索失败」却不知道该改模型还是改库。
 */
export async function embedTexts(cfg: EmbedConfig, texts: string[], deps: EmbedDeps = {}): Promise<number[][]> {
  if (!cfg.baseUrl.trim() || !cfg.model.trim()) throw new Error('还没有配置嵌入端点（地址 + 模型）')
  if (!texts.length) return []
  const url = embeddingsEndpoint(cfg.baseUrl)
  const fetchImpl = deps.fetchImpl ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), deps.timeoutMs ?? EMBED_TIMEOUT_MS)
  const onAbort = () => ctrl.abort(new Error('aborted'))
  deps.signal?.addEventListener('abort', onAbort, { once: true })
  if (deps.signal?.aborted) onAbort()
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: ctrl.signal,
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`嵌入端点返回 HTTP ${res.status}：${raw.slice(0, 300)}`)
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw new Error(`嵌入端点返回的不是 JSON：${raw.slice(0, 200)}`)
    }
    const vecs = parseEmbeddingResponse(json)
    if (vecs.length !== texts.length) {
      throw new Error(`嵌入端点返回 ${vecs.length} 条向量，期望 ${texts.length} 条`)
    }
    const bad = vecs.find((v) => v.length !== cfg.dims)
    if (bad) {
      throw new Error(
        `嵌入维度不匹配：端点为「${cfg.model}」返回 ${bad.length} 维，配置里写的是 ${cfg.dims} 维。` +
          `把设置里的维度改成 ${bad.length}（或换回 ${cfg.dims} 维的模型）—— 维度一变，旧库就查不动了。`,
      )
    }
    return vecs
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError' || /timeout|aborted/.test(err.message)) {
      throw new Error('嵌入请求超时或被取消')
    }
    throw err
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// memvid 命令
// ---------------------------------------------------------------------------

export interface RunOpts {
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_STORE_TIMEOUT_MS = 30_000

function run(exe: string, args: string[], opts: RunOpts = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      {
        cwd: path.dirname(exe),
        timeout: opts.timeoutMs ?? DEFAULT_STORE_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`找不到 memvid 可执行文件：${exe}`))
          return
        }
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as unknown as { code: number }).code
            : err
              ? 1
              : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

function failure(what: string, r: { code: number; stdout: string; stderr: string }): Error {
  const detail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(0, 6).join(' ')
  return new Error(`${what}失败（退出码 ${r.code}）${detail ? `：${detail}` : ''}`)
}

/** 库文件名必须是裸名：路径由调用方拼，插件清单写不进 `../` */
export function assertStoreFileName(file: string): void {
  if (!MEMORY_FILE_RE.test(file)) {
    throw new Error(`记忆库文件名「${file}」不合法：只能是小写字母/数字/连字符加 .mv2，且不能带目录`)
  }
}

export async function createStoreFile(exe: string, filePath: string, opts: RunOpts = {}): Promise<void> {
  const r = await run(exe, ['create', filePath], opts)
  if (r.code !== 0) throw failure('创建记忆库', r)
}

export interface StoreStats {
  frames?: string
  usage?: string
}

/** summary 是给人看的字符串，原样保留；解析不出来不算失败 */
export function parseStats(json: unknown): StoreStats {
  const summary = (json as { summary?: { frames?: unknown; usage?: unknown } } | null)?.summary
  return {
    frames: typeof summary?.frames === 'string' ? summary.frames : undefined,
    usage: typeof summary?.usage === 'string' ? summary.usage : undefined,
  }
}

export async function readStats(exe: string, filePath: string, opts: RunOpts = {}): Promise<StoreStats> {
  const r = await run(exe, ['stats', filePath, '--json'], opts)
  if (r.code !== 0) throw failure('读记忆库统计', r)
  try {
    return parseStats(JSON.parse(r.stdout))
  } catch {
    return {}
  }
}

export interface PutInput {
  title: string
  tags: string[]
  chunks: string[]
  /** null = 只做词法检索：不带向量写，检索也只能走 find */
  vectors: number[][] | null
  dims: number
}

export interface PutManyRequest {
  title: string
  text: string
  tags: string[]
  embedding?: number[]
}

export function buildPutManyRequests(input: PutInput): PutManyRequest[] {
  return input.chunks.map((text, i) => {
    const row: PutManyRequest = {
      title: input.chunks.length > 1 ? `${input.title} · ${i + 1}/${input.chunks.length}` : input.title,
      text,
      tags: input.tags,
    }
    const v = input.vectors?.[i]
    if (v?.length) row.embedding = v
    return row
  })
}

export function parsePutResult(json: unknown): { count: number } {
  const n = (json as { count?: unknown } | null)?.count
  return { count: typeof n === 'number' && Number.isFinite(n) ? n : 0 }
}

/**
 * 写入一个库。临时目录在 finally 里收掉：这两份 JSON 里有原文和向量，
 * 不该在系统临时目录里留到重启。
 */
export async function putChunks(
  exe: string,
  filePath: string,
  input: PutInput,
  opts: RunOpts = {},
): Promise<{ count: number }> {
  const requests = buildPutManyRequests(input)
  if (!requests.length) return { count: 0 }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'torra-mv-'))
  try {
    const jsonPath = path.join(tmp, 'batch.json')
    await fs.writeFile(jsonPath, JSON.stringify(requests), 'utf-8')
    // 没有向量就不声明模型：`-m` 是对这批向量来源的声明，没带向量还写它等于骗索引
    const args = ['put-many', filePath, '--input', jsonPath]
    if (input.vectors) args.push('-m', memoryModelIdentity(input.dims))
    args.push('--dedup', '--json')
    const r = await run(exe, args, opts)
    if (r.code !== 0) throw failure('写入记忆库', r)
    try {
      return parsePutResult(JSON.parse(r.stdout))
    } catch {
      return { count: requests.length }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export interface VecHit {
  frameId: number
  distance: number
  preview: string
}

/** vec-search 的 `--json` 是裸数组（和 find 的信封不同） */
export function parseVecHits(json: unknown): VecHit[] {
  if (!Array.isArray(json)) return []
  const out: VecHit[] = []
  for (const row of json) {
    const r = row as { frame_id?: unknown; distance?: unknown; preview?: unknown }
    const frameId = typeof r?.frame_id === 'number' ? r.frame_id : -1
    const distance = typeof r?.distance === 'number' && Number.isFinite(r.distance) ? r.distance : 1
    const preview = typeof r?.preview === 'string' ? r.preview : ''
    if (frameId < 0 || !preview) continue
    out.push({ frameId, distance, preview })
  }
  return out
}

export interface LexHit {
  title: string
  text: string
  score: number
}

/** find 的 `--json` 是 `{metadata,hits}` 信封；空结果时 hits 是 [] */
export function parseLexHits(json: unknown): LexHit[] {
  const hits = (json as { hits?: unknown } | null)?.hits
  if (!Array.isArray(hits)) return []
  const out: LexHit[] = []
  for (const row of hits) {
    const r = row as { title?: unknown; text?: unknown; score?: unknown }
    const text = typeof r?.text === 'string' ? r.text : ''
    if (!text) continue
    out.push({
      title: typeof r?.title === 'string' ? r.title : '',
      text,
      score: typeof r?.score === 'number' && Number.isFinite(r.score) ? r.score : 0,
    })
  }
  return out
}

export async function vecSearch(
  exe: string,
  filePath: string,
  vector: number[],
  topK: number,
  opts: RunOpts = {},
): Promise<MemorySearchHit[]> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'torra-mv-'))
  try {
    const qPath = path.join(tmp, 'q.json')
    await fs.writeFile(qPath, JSON.stringify(vector), 'utf-8')
    const r = await run(
      exe,
      ['vec-search', filePath, '--embedding', qPath, '--limit', String(clampMemoryTopK(topK)), '--json'],
      opts,
    )
    if (r.code !== 0) {
      // 维度不匹配是配置问题，原话比「检索失败」有用得多
      const msg = (r.stderr || r.stdout).trim().split(/\r?\n/)[0]
      throw new Error(`语义检索失败${msg ? `：${msg}` : ''}`)
    }
    let json: unknown
    try {
      json = JSON.parse(r.stdout)
    } catch {
      throw new Error('语义检索返回的不是 JSON')
    }
    return parseVecHits(json).map((h) => ({
      title: hitTitle(h.preview),
      snippet: frameSnippet(h.preview),
      score: Math.round((1 - h.distance) * 1000) / 1000,
      via: 'vec' as const,
    }))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * 命中标题：向量检索只回 preview，标题混在正文尾巴的 `title: …` 行里。
 * 剥尾巴前先把它捞出来 —— 没有标题的结果读起来全是「片段 1、片段 2」。
 */
export function hitTitle(preview: string): string {
  const m = String(preview ?? '').match(/\ntitle: ([^\n]*)/)
  if (m?.[1]?.trim()) return m[1].trim()
  const first = collapse(stripFrameMeta(preview)).split(/(?<=[。！？.!?])\s/)[0] ?? ''
  return first.slice(0, 60) || '（无标题）'
}

export async function lexSearch(
  exe: string,
  filePath: string,
  query: string,
  topK: number,
  opts: RunOpts = {},
): Promise<MemorySearchHit[]> {
  const r = await run(
    exe,
    ['find', filePath, '--query', query, '--top-k', String(clampMemoryTopK(topK)), '--mode', 'lex', '--json'],
    opts,
  )
  if (r.code !== 0) throw failure('关键词检索', r)
  let json: unknown
  try {
    json = JSON.parse(r.stdout)
  } catch {
    throw new Error('关键词检索返回的不是 JSON')
  }
  return parseLexHits(json).map((h) => ({
    title: h.title || '（无标题）',
    snippet: frameSnippet(h.text),
    score: Math.round(h.score * 1000) / 1000,
    via: 'lex' as const,
  }))
}

// ---------------------------------------------------------------------------
// 结果排版
// ---------------------------------------------------------------------------

const RESULT_MAX = 8000

export function formatSearchText(
  file: string,
  query: string,
  mode: 'vec' | 'lex',
  hits: MemorySearchHit[],
  maxChars = RESULT_MAX,
): string {
  if (!hits.length) {
    const hint =
      mode === 'lex'
        ? '关键词检索用的是英文分词索引：中文查询基本命不中。要查中文请配置嵌入端点后改用语义检索。'
        : '没有足够接近的片段。'
    return `记忆库 ${file} 里没有查到「${query}」：${hint}`
  }
  const head = `记忆库 ${file} 命中 ${hits.length} 条（${mode === 'vec' ? '语义检索' : '关键词检索'}）：`
  const lines = hits.map((h, i) => {
    const score = h.score === undefined ? '' : mode === 'vec' ? `相似度 ${h.score.toFixed(3)}` : `关键词分 ${h.score}`
    return [`[${i + 1}] ${h.title}${score ? `（${score}）` : ''}`, `    ${h.snippet}`].join('\n')
  })
  const text = [head, ...lines].join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}
