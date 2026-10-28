/**
 * 记忆库契约：memvid 单文件（.mv2）的跨进程类型与纯函数。
 *
 * 记忆库在 Torra 里是「一块可以检索的本地资料」：写入走 Torra 自己的嵌入与
 * `put-many`，检索走 `vec-search`（语义）或 `find`（关键词）。它被两层使用：
 *
 * - 设置页：配置运行时、嵌入端点、库列表；
 * - 助手工具 / `kind:'memory'` 插件：检索与写入。
 *
 * 三条不可丢的口径：
 *
 * 1. **库文件只能落在 dataDir 里**。文件名由 MEMORY_FILE_RE 限制成裸名（没有分隔符），
 *    路径一律由主进程拼出来，插件清单里写不进 `../`。
 * 2. **维度 = 向量空间的标识**。memvid 对维度敏感：拿 384 维的查询去查 1536 维的库会直接报错
 *    （实测「Vector dimension mismatch (expected 1536, got 384)」），所以维度跟着一次写入走，
 *    改配置后旧库就查不动了 —— 这件事必须写在界面上，不能靠用户自己猜。
 * 3. **中文关键词检索不可用**。memvid 的词法索引是 tantivy，不做中文分词：
 *    实测「缓存」命中 0 条、「verify」命中 1 条。所以没配嵌入时中文只能靠语义检索，
 *    这一点要在提示里说清楚，否则用户会以为「库是空的」。
 */

/** 库文件名：小写字母/数字/连字符 + `.mv2`。既是文件名也是插件清单里引用的身份 */
export const MEMORY_FILE_RE = /^[a-z0-9][a-z0-9-]{0,62}\.mv2$/

/** 检索方式：auto = 配了嵌入就走语义、否则关键词；sem 强制语义（没配就报错而不是悄悄降级） */
export type MemoryMode = 'auto' | 'lex' | 'sem'
export const MEMORY_MODES: MemoryMode[] = ['auto', 'lex', 'sem']
export function isMemoryMode(v: unknown): v is MemoryMode {
  return typeof v === 'string' && (MEMORY_MODES as string[]).includes(v)
}

/** 钥匙串里的嵌入 Key：值只进钥匙串，prefs 里只有 baseUrl / model / dims */
export const MEMORY_KEY_REF = 'assistant:memory:embed'

export interface AssistantMemoryPrefs {
  /** 手动指定的 memvid 可执行文件（绝对路径）；空 = 托管目录或 PATH */
  exe: string
  /** OpenAI 兼容端点根地址（不带 /embeddings；带了也会被归一） */
  baseUrl: string
  /** 嵌入模型名 */
  model: string
  /** 向量维度：决定写入时的 memvid 模型身份，也决定查询向量必须多长 */
  dims: number
}

export const MEMORY_PREFS_DEFAULT: AssistantMemoryPrefs = { exe: '', baseUrl: '', model: '', dims: 1536 }

/** memvid 认识的模型身份只有这几个维度；顶上的选择项就是这张表 */
export const MEMORY_DIMS = [384, 768, 1024, 1536, 3072] as const

export function isMemoryDims(v: unknown): v is number {
  return typeof v === 'number' && (MEMORY_DIMS as readonly number[]).includes(v)
}

/**
 * 维度 → memvid 的模型身份。
 *
 * 这个字符串只用来给向量空间贴标签：写入与查询必须用同一个，否则同维不同空间的结果没有意义。
 * 768 维取 bge-base（nomic 也是 768，两者等价），其余按各自身份。
 */
export function memoryModelIdentity(dims: number): string {
  switch (dims) {
    case 384:
      return 'bge-small'
    case 768:
      return 'bge-base'
    case 1024:
      return 'gte-large'
    case 3072:
      return 'openai'
    case 1536:
    default:
      return 'openai-small'
  }
}

/**
 * 用户可能把完整地址贴进来（`.../v1/embeddings`）。
 * 这里统一成「根地址 + /embeddings」：重复后缀不叠加，末尾斜杠去掉。
 */
export function embeddingsEndpoint(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return ''
  if (/\/embeddings$/i.test(base)) return base
  return `${base}/embeddings`
}

export const MEMORY_TOP_K_MIN = 1
export const MEMORY_TOP_K_MAX = 20
export const MEMORY_TOP_K_DEFAULT = 5

export function clampMemoryTopK(v: unknown, fallback = MEMORY_TOP_K_DEFAULT): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(MEMORY_TOP_K_MAX, Math.max(MEMORY_TOP_K_MIN, Math.round(n)))
}

/** memvid 可执行文件的来路：手填 > 托管目录 > PATH */
export type MemoryRuntimeSource = 'configured' | 'managed' | 'path' | 'none'

export interface MemoryInstallProgress {
  phase: 'download' | 'extract' | 'done' | 'failed'
  received: number
  /** 拿不到 Content-Length 时为 0，界面按「已下载 X MB」显示 */
  total: number
  reason?: string
}

export interface MemoryRuntimeView {
  ok: boolean
  path?: string
  /** `memvid --version` 的原话 */
  version?: string
  source: MemoryRuntimeSource
  /** 自动下载会落在这个目录（设置页要把路径写出来） */
  managedDir: string
  /** 找不到 / 跑不起来时的原因 */
  reason?: string
  /** 安装进行中或刚失败时的进度；空闲时没有 */
  install?: MemoryInstallProgress
}

/** 一个库的现状。frames/usage 直接取 `stats --json` 的 summary 原话，不自己编数字 */
export interface MemoryStoreView {
  file: string
  path: string
  bytes: number
  frames?: string
  usage?: string
  modifiedAt?: number
  /** 读不动的库在这里说原因，不许从列表里静默消失 */
  error?: string
}

/** 设置页「记忆」页一次读到的全部现状 */
export interface AssistantMemoryView {
  prefs: AssistantMemoryPrefs
  hasKey: boolean
  keychainAvailable: boolean
  /** 归一后的嵌入地址，空串 = 没配 */
  endpoint: string
  runtime: MemoryRuntimeView
  stores: MemoryStoreView[]
}

export interface MemorySearchHit {
  title: string
  snippet: string
  /** 语义检索是 1 - distance（越大越近）；关键词检索是原始 score */
  score?: number
  /** 命中方式，界面与工具文本都用它说明「这条是怎么找到的」 */
  via: 'vec' | 'lex'
}

export interface MemorySearchOutcome {
  ok: boolean
  reason?: string
  hits: MemorySearchHit[]
  /** 实际用的检索方式：auto 模式下可能是 lex（没配嵌入） */
  mode: 'vec' | 'lex'
  /** 已经排版好的文本，工具与插件直接回给模型 */
  text: string
}
