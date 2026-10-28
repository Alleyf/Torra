/**
 * 记忆库服务：把「运行时 + 嵌入端点 + 库文件 + 收发」收成一个对象，供设置页、助手工具和
 * `kind:'memory'` 插件共用。
 *
 * 为什么是一个服务而不是三段散在各处的代码：
 *
 * - **状态只有一个来源**。可执行文件在哪儿、装到哪一步、嵌入配没配，设置页看到的就是
 *   工具与插件执行时用的那一份 —— 否则「设置里写着已就绪，对话里说找不到运行时」那种
 *   两副面孔会反复出现。
 * - **安装只跑一次**。一次点击开始下载后立刻返回，进度靠轮询 status()；重复点击不会
 *   并发下两份 137MB。
 * - **库文件只在 memoryDir 里**。名字先过 MEMORY_FILE_RE，路径再拼一次，插件清单无法把它
 *   指到别处。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  MEMORY_FILE_RE,
  MEMORY_PREFS_DEFAULT,
  clampMemoryTopK,
  embeddingsEndpoint,
  isMemoryMode,
  memoryModelIdentity,
  type AssistantMemoryPrefs,
  type AssistantMemoryView,
  type MemoryInstallProgress,
  type MemoryRuntimeView,
  type MemorySearchOutcome,
  type MemoryStoreView,
  type MemoryMode,
} from '../../shared/memory'
import {
  MEMVID_PKG_VERSION,
  downloadTo,
  exeNameFor,
  extractTarGz,
  locateMemvid,
  managedDirFor,
  memvidVersion,
  platformPackage,
  tarballUrl,
  type LocateResult,
} from './runtime'
import {
  chunkText,
  createStoreFile,
  embedTexts,
  formatSearchText,
  lexSearch,
  putChunks,
  readStats,
  vecSearch,
  type RunOpts,
} from './store'
export function memoryDirOf(dataDir: string): string {
  return path.join(dataDir, 'memory')
}

/** 托管二进制的落点（`<dataDir>/memory/bin`） */
export function memoryBinDirOf(dataDir: string): string {
  return path.join(memoryDirOf(dataDir), 'bin')
}

export interface MemoryServiceDeps {
  dataDir(): string
  getPrefs(): AssistantMemoryPrefs
  setPrefs(next: AssistantMemoryPrefs): Promise<void> | void
  /** 嵌入 Key：只在发请求那一瞬从钥匙串取出 */
  getKey(): string | null
  keychainAvailable(): boolean
  /** 测试桩用；默认全局 fetch */
  fetchImpl?: typeof fetch
  log(entry: { ok: boolean; detail?: string }): void
}

export interface MemorySearchInput {
  file: string
  query: string
  topK?: number
  mode?: MemoryMode
  timeoutMs?: number
  signal?: AbortSignal
}

export interface MemoryRememberInput {
  file: string
  title: string
  text: string
  tags?: string[]
}

export interface MemoryRememberResult {
  ok: boolean
  reason?: string
  chunks?: number
  /** 没配嵌入时写进去的块是「只能英文关键词命中」的，这句话要随结果回给模型 */
  lexicalOnly?: boolean
}

export interface MemoryService {
  status(): Promise<MemoryRuntimeView>
  install(): Promise<{ ok: boolean; reason: string }>
  view(): Promise<AssistantMemoryView>
  setExe(p: string): Promise<{ ok: boolean; reason: string }>
  setEmbedding(patch: { baseUrl?: unknown; model?: unknown; dims?: unknown }): Promise<{ ok: boolean; reason: string }>
  testEmbedding(): Promise<{ ok: boolean; reason?: string; dims?: number; ms?: number }>
  stores(): Promise<MemoryStoreView[]>
  /** 只读目录拿文件名（不跑 stats），给工具描述一类要同步结果的地方用 */
  listStoreFiles(): string[]
  createStore(name: string): Promise<{ ok: boolean; reason: string }>
  removeStore(file: string): Promise<{ ok: boolean; reason: string }>
  search(input: MemorySearchInput): Promise<MemorySearchOutcome>
  remember(input: MemoryRememberInput): Promise<MemoryRememberResult>
  /** 生成一份 `kind:'memory'` 的插件清单（由调用方负责落盘，见 bridge） */
  pluginManifest(file: string): { ok: boolean; reason: string; manifest?: Record<string, unknown> }
  /** 给「新建记忆库」用的名字校验（不含 .mv2 后缀） */
  normalizeStoreName(raw: string): string | null
}

/** 版本缓存：查一次 `--version` 要起一个进程，设置页轮询时不该每 700ms 起一次 */
interface Located {
  at: number
  result: LocateResult | null
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  let located: Located | null = null
  const versions = new Map<string, string | undefined>()
  let installing: MemoryInstallProgress | null = null
  let installPromise: Promise<{ ok: boolean; reason: string }> | null = null

  const log = (ok: boolean, detail: string) => deps.log({ ok, detail })
  const prefs = () => ({ ...MEMORY_PREFS_DEFAULT, ...deps.getPrefs() })

  /** 3 秒内复用同一次查找：设置页在安装/切换期间会连续轮询 */
  async function current(): Promise<LocateResult | null> {
    if (located && Date.now() - located.at < 3_000) return located.result
    const result = await locateMemvid({
      configured: prefs().exe,
      managedDir: managedDirFor(memoryBinDirOf(deps.dataDir()), platformPackage() ?? 'memvid'),
    })
    located = { at: Date.now(), result }
    return result
  }

  async function requireExe(): Promise<string> {
    const hit = await current()
    if (hit?.path) return hit.path
    throw new Error(
      '还没找到 memvid 运行时。到「设置 - 资源库 - 记忆」里点「下载运行时」，或手动指定一个 memvid 可执行文件。',
    )
  }

  async function status(): Promise<MemoryRuntimeView> {
    const managedDir = managedDirFor(memoryBinDirOf(deps.dataDir()), platformPackage() ?? 'memvid')
    const hit = await current()
    const base: MemoryRuntimeView = {
      ok: false,
      source: hit?.source ?? 'none',
      managedDir,
      ...(hit?.path ? { path: hit.path } : {}),
      ...(installing ? { install: { ...installing } } : {}),
    }
    if (hit?.configuredMissing) {
      base.reason = `你指定的路径不可用：${hit.configuredMissing}（它不存在，或不是文件）`
      if (!hit.path) return base
    }
    if (!hit?.path) {
      base.reason = platformPackage()
        ? '本机还没有 memvid：可以在这里直接下载，或指定已有的可执行文件。'
        : `不支持的平台（${process.platform}/${process.arch}）：只能手动指定 memvid 可执行文件。`
      return base
    }
    if (!versions.has(hit.path)) {
      const v = await memvidVersion(hit.path)
      versions.set(hit.path, v)
    }
    const version = versions.get(hit.path)
    return { ...base, ok: true, version, ...(version ? {} : { reason: '跑 `memvid --version` 没有输出，可执行文件可能不完整' }) }
  }

  function installedExe(): string | null {
    const pkg = platformPackage()
    if (!pkg) return null
    const exe = path.join(managedDirFor(memoryBinDirOf(deps.dataDir()), pkg), exeNameFor())
    return existsSync(exe) ? exe : null
  }

  function install(): Promise<{ ok: boolean; reason: string }> {
    if (installPromise) return installPromise
    const pkg = platformPackage()
    if (!pkg) {
      return Promise.resolve({
        ok: false,
        reason: `不支持的平台（${process.platform}/${process.arch}）：请手动指定 memvid 可执行文件`,
      })
    }
    installing = { phase: 'download', received: 0, total: 0 }
    installPromise = (async () => {
      const binRoot = memoryBinDirOf(deps.dataDir())
      const target = managedDirFor(binRoot, pkg)
      const tmpDir = path.join(memoryDirOf(deps.dataDir()), 'tmp')
      const tgz = path.join(tmpDir, `${pkg.split('/').pop()}-${MEMVID_PKG_VERSION}.tgz`)
      try {
        await fs.mkdir(tmpDir, { recursive: true })
        await downloadTo(tarballUrl(pkg), tgz, (p) => {
          installing = { phase: 'download', received: p.received, total: p.total }
        })
        installing = { phase: 'extract', received: installing?.received ?? 0, total: installing?.total ?? 0 }
        // 先解到暂存目录：解一半的目录不能被当成「已装好」
        const staging = `${target}.partial`
        rmSync(staging, { recursive: true, force: true })
        const r = await extractTarGz(tgz, staging)
        // 包内是 `package/memvid.exe`：把 package 提出来，其余丢弃
        const inner = path.join(staging, 'package')
        const root = existsSync(inner) ? inner : staging
        rmSync(target, { recursive: true, force: true })
        await fs.rename(root, target)
        if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
        installing = { phase: 'done', received: installing?.received ?? 0, total: installing?.total ?? 0 }
        located = null
        versions.clear()
        log(true, `memvid 已安装：${target}（${r.files} 个文件，${Math.round(r.bytes / 1048576)}MB）`)
        setTimeout(() => {
          installing = null
          installPromise = null
        }, 4_000)
        return { ok: true, reason: `已下载 memvid ${MEMVID_PKG_VERSION} 到 ${target}` }
      } catch (e) {
        const reason = (e as Error).message
        installing = { phase: 'failed', received: installing?.received ?? 0, total: installing?.total ?? 0, reason }
        log(false, `memvid 安装失败：${reason}`)
        installPromise = null
        return { ok: false, reason }
      } finally {
        rmSync(tgz, { force: true })
      }
    })()
    return installPromise
  }

  function listStoreFiles(): string[] {
    const dir = memoryDirOf(deps.dataDir())
    try {
      return readdirSync(dir).filter((f) => MEMORY_FILE_RE.test(f)).sort()
    } catch {
      return []
    }
  }

  /** 找不到库时把现有库名带上：模型否则只能反复试错 */
  function missingStoreReason(file: string): string {
    const names = listStoreFiles()
    return names.length
      ? `没有叫 ${file} 的记忆库。现在有：${names.join('、')}`
      : `没有叫 ${file} 的记忆库：先在「设置 - 资源库 - 记忆」里新建一个`
  }

  async function stores(): Promise<MemoryStoreView[]> {
    const dir = memoryDirOf(deps.dataDir())
    if (!existsSync(dir)) return []
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => MEMORY_FILE_RE.test(f))
    } catch {
      return []
    }
    const exe = (await current())?.path ?? null
    const out: MemoryStoreView[] = []
    for (const file of files.sort()) {
      const full = path.join(dir, file)
      const st = statSync(full, { throwIfNoEntry: false })
      const view: MemoryStoreView = { file, path: full, bytes: st?.size ?? 0, modifiedAt: st?.mtimeMs }
      if (exe) {
        try {
          const s = await readStats(exe, full)
          view.frames = s.frames
          view.usage = s.usage
        } catch (e) {
          view.error = (e as Error).message
        }
      } else {
        view.error = '没有运行时，读不出帧数'
      }
      out.push(view)
    }
    return out
  }

  async function view(): Promise<AssistantMemoryView> {
    const p = prefs()
    return {
      prefs: p,
      hasKey: deps.getKey() !== null,
      keychainAvailable: deps.keychainAvailable(),
      endpoint: embeddingsEndpoint(p.baseUrl),
      runtime: await status(),
      stores: await stores(),
    }
  }

  async function search(input: MemorySearchInput): Promise<MemorySearchOutcome> {
    const fail = (reason: string): MemorySearchOutcome => ({ ok: false, reason, hits: [], mode: 'lex', text: `检索失败：${reason}` })
    const file = String(input.file ?? '').trim()
    const query = String(input.query ?? '').trim()
    if (!MEMORY_FILE_RE.test(file)) return fail(`记忆库文件名不合法：${file || '(空)'}`)
    if (!query) return fail('查询是空的')
    const full = path.join(memoryDirOf(deps.dataDir()), file)
    if (!existsSync(full)) {
      return fail(missingStoreReason(file))
    }
    let exe: string
    try {
      exe = await requireExe()
    } catch (e) {
      return fail((e as Error).message)
    }
    const p = prefs()
    const configured = !!p.baseUrl.trim() && !!p.model.trim()
    const mode = isMemoryMode(input.mode) ? input.mode : 'auto'
    if (mode === 'sem' && !configured) {
      return fail('这个库要求语义检索，但还没有配置嵌入端点（设置 - 资源库 - 记忆）')
    }
    const topK = clampMemoryTopK(input.topK)
    const opts: RunOpts = { ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}), ...(input.signal ? { signal: input.signal } : {}) }
    const useVec = mode === 'sem' || (mode === 'auto' && configured)
    if (useVec) {
      try {
        const [q] = await embedTexts(
          { baseUrl: p.baseUrl, model: p.model, dims: p.dims, apiKey: deps.getKey() },
          [query],
          { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(input.signal ? { signal: input.signal } : {}) },
        )
        const hits = await vecSearch(exe, full, q!, topK, opts)
        log(true, `memory:search vec file=${file} hits=${hits.length}`)
        return { ok: true, hits, mode: 'vec', text: formatSearchText(file, query, 'vec', hits) }
      } catch (e) {
        const reason = (e as Error).message
        // auto 模式下不把整条路堵死：退回关键词，但把失败原因写在结果里（中文命中率为 0 是已知的）
        if (mode === 'auto') {
          try {
            const hits = await lexSearch(exe, full, query, topK, opts)
            const text = `（语义检索不可用：${reason}。下面退回关键词检索 —— 它按英文分词，中文查询基本命不中。）\n${formatSearchText(file, query, 'lex', hits)}`
            log(false, `memory:search vec-failed file=${file} fallback=lex`)
            return { ok: true, hits, mode: 'lex', text }
          } catch {
            return fail(reason)
          }
        }
        return fail(reason)
      }
    }
    try {
      const hits = await lexSearch(exe, full, query, topK, opts)
      log(true, `memory:search lex file=${file} hits=${hits.length}`)
      return { ok: true, hits, mode: 'lex', text: formatSearchText(file, query, 'lex', hits) }
    } catch (e) {
      return fail((e as Error).message)
    }
  }

  async function remember(input: MemoryRememberInput): Promise<MemoryRememberResult> {
    const file = String(input.file ?? '').trim()
    const text = String(input.text ?? '').trim()
    if (!MEMORY_FILE_RE.test(file)) return { ok: false, reason: `记忆库文件名不合法：${file || '(空)'}` }
    if (!text) return { ok: false, reason: '要记的内容是空的' }
    const full = path.join(memoryDirOf(deps.dataDir()), file)
    if (!existsSync(full)) {
      return { ok: false, reason: missingStoreReason(file) }
    }
    let exe: string
    try {
      exe = await requireExe()
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
    const p = prefs()
    const configured = !!p.baseUrl.trim() && !!p.model.trim()
    const chunks = chunkText(text)
    if (!chunks.length) return { ok: false, reason: '内容为空' }
    const title = (input.title || text.split(/\r?\n/)[0] || '未命名').trim().slice(0, 80)
    const tags = (input.tags ?? [])
      .map((t) => String(t).trim().slice(0, 32))
      .filter(Boolean)
      .slice(0, 8)
    try {
      const vectors = configured
        ? await embedTexts(
            { baseUrl: p.baseUrl, model: p.model, dims: p.dims, apiKey: deps.getKey() },
            chunks,
            deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
          )
        : null
      const r = await putChunks(exe, full, { title, tags, chunks, vectors, dims: p.dims })
      log(true, `memory:remember file=${file} chunks=${r.count} vec=${vectors ? 'yes' : 'no'}`)
      return { ok: true, chunks: r.count, ...(vectors ? {} : { lexicalOnly: true }) }
    } catch (e) {
      const reason = (e as Error).message
      log(false, `memory:remember failed file=${file}: ${reason}`)
      return { ok: false, reason }
    }
  }

  function pluginManifest(file: string): { ok: boolean; reason: string; manifest?: Record<string, unknown> } {
    if (!MEMORY_FILE_RE.test(file)) return { ok: false, reason: `记忆库文件名不合法：${file}` }
    const name = memoryPluginName(file)
    return {
      ok: true,
      reason: `已生成 ${name}.plugin.json`,
      manifest: {
        name,
        label: `记忆库 ${name}`,
        description: `检索本地记忆库「${name}」：用于回忆之前存进这个库的事实、结论与原文片段。`,
        kind: 'memory',
        memory: { file, mode: 'auto', topK: 5 },
      },
    }
  }

  function normalizeStoreName(raw: string): string | null {
    const name = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/\.mv2$/, '')
    if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(name)) return null
    return `${name}.mv2`
  }

  return {
    status,
    install,
    view,
    async setExe(p) {
      const next = typeof p === 'string' ? p.trim() : ''
      if (next && !path.isAbsolute(next)) return { ok: false, reason: '请给绝对路径' }
      if (next && !existsSync(next)) return { ok: false, reason: `这个路径不存在：${next}` }
      await deps.setPrefs({ ...prefs(), exe: next })
      located = null
      versions.clear()
      return { ok: true, reason: next ? `已指定运行时：${next}` : '已清空手动指定的运行时，改为自动查找' }
    },
    async setEmbedding(patch) {
      const cur = prefs()
      const baseUrl = patch.baseUrl === undefined ? cur.baseUrl : String(patch.baseUrl ?? '').trim()
      const model = patch.model === undefined ? cur.model : String(patch.model ?? '').trim()
      const dims = patch.dims === undefined ? cur.dims : Number(patch.dims)
      if (dims !== 384 && dims !== 768 && dims !== 1024 && dims !== 1536 && dims !== 3072) {
        return { ok: false, reason: '维度只能是 384 / 768 / 1024 / 1536 / 3072' }
      }
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return { ok: false, reason: '嵌入地址要以 http:// 或 https:// 开头' }
      if (cur.baseUrl === baseUrl && cur.model === model && cur.dims === dims) {
        return { ok: true, reason: '嵌入设置没有变化' }
      }
      await deps.setPrefs({ ...cur, baseUrl, model, dims })
      log(true, `memory:embed-prefs endpoint=${embeddingsEndpoint(baseUrl) || '(空)'} model=${model || '(空)'} dims=${dims} identity=${memoryModelIdentity(dims)}`)
      return { ok: true, reason: baseUrl && model ? '已保存嵌入设置' : '已清空嵌入设置：检索会退回关键词模式' }
    },
    async testEmbedding() {
      const p = prefs()
      if (!p.baseUrl.trim() || !p.model.trim()) return { ok: false, reason: '先填嵌入地址与模型' }
      const started = Date.now()
      try {
        const [v] = await embedTexts(
          { baseUrl: p.baseUrl, model: p.model, dims: p.dims, apiKey: deps.getKey() },
          ['Torra 记忆库连通性测试'],
          deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
        )
        const ms = Date.now() - started
        log(true, `memory:embed-test ok dims=${v!.length} ms=${ms}`)
        return { ok: true, dims: v!.length, ms }
      } catch (e) {
        const reason = (e as Error).message
        log(false, `memory:embed-test failed: ${reason}`)
        return { ok: false, reason }
      }
    },
    stores: () => stores(),
    listStoreFiles,
    async createStore(name) {
      const file = normalizeStoreName(name)
      if (!file) return { ok: false, reason: '名字不合法：只能用小写字母、数字、连字符，且不能以连字符开头或结尾' }
      const dir = memoryDirOf(deps.dataDir())
      await fs.mkdir(dir, { recursive: true })
      const full = path.join(dir, file)
      if (existsSync(full)) return { ok: false, reason: `已经有 ${file} 了` }
      let exe: string
      try {
        exe = await requireExe()
      } catch (e) {
        return { ok: false, reason: (e as Error).message }
      }
      try {
        await createStoreFile(exe, full)
      } catch (e) {
        return { ok: false, reason: (e as Error).message }
      }
      log(true, `memory:create ${file}`)
      return { ok: true, reason: `已新建记忆库 ${file}` }
    },
    async removeStore(file) {
      assertStoreFileNameByMsg(file)
      const full = path.join(memoryDirOf(deps.dataDir()), file)
      if (!existsSync(full)) return { ok: false, reason: `没有叫 ${file} 的记忆库` }
      try {
        rmSync(full)
      } catch (e) {
        return { ok: false, reason: `删不掉：${(e as Error).message}` }
      }
      log(true, `memory:remove ${file}`)
      return { ok: true, reason: `已删除 ${file}（只删这个库文件）` }
    },
    search,
    remember,
    pluginManifest,
    normalizeStoreName,
  }
}

function assertStoreFileNameByMsg(file: string): void {
  /*
   * 名字校验放这里而不是直接调用 store 的 assert：那个函数抛异常，
   * 设置页要的是一句能显示的话；两处都校验只是为了让误用早失败。
   */
  if (!MEMORY_FILE_RE.test(file)) throw new Error(`记忆库文件名不合法：${file}`)
}

/** 给别的模块拼插件清单时用：占位符取值不需要跑进程 */
export function memoryPluginName(file: string): string {
  return file.replace(/\.mv2$/, '')
}
