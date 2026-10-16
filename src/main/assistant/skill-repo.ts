/**
 * 技能资源库：把「发现的技能」与「加载技能的目录」分开。
 *
 * 此前技能只有一条路：本机扫描 → 软链接进技能目录。来源是别的 agent 应用放在
 * 磁盘上的目录。资源库补上另一半：GitHub 仓库（或任意本地文件夹）作为来源登记，
 * 技能**缓存一份**在本机资源库目录里，再按需链接进技能目录 —— 缓存只存一份，
 * 链接跟着资源库走，更新后各链接自动指向新内容（junction 指目录，不拷贝）。
 *
 * GitHub 拉取用 tarball：一次请求拿全仓，避免逐文件 hit API（rate limit 60/h）。
 * 更新检查走 git ls-remote 式的公开端点 /commits/<branch>（同样无鉴权，60/h 够用）：
 * 记住上次缓存的 commit sha，不同就是有更新。本地来源按根目录 mtime 粗判。
 *
 * 安全边界：tarball 解包只写进资源库目录；路径穿越（成员名带 ../ 或绝对路径）
 * 的条目直接跳过；单仓库条数上限与扫描同款（MAX_SKILLS），防止把磁盘塞满。
 */

import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import {
  type RepoSkillView,
  type SkillRepoView,
  type SkillSourceView,
} from '../../shared/assistant'
import { parseFrontmatter } from './skills'

/** 单来源缓存的技能上限：与目录扫描同量级，防 tarball 炸盘 */
const MAX_SKILLS = 600
/** description 截断：整包说明进 IPC 会到几百 KB */
const DESC_MAX = 300
/** 来源登记文件名（repoDir 根下） */
const SOURCES_FILE = 'sources.json'
/** 每个来源的元数据文件（repoDir/github/<id>/meta.json） */
const META_FILE = 'meta.json'

export interface SkillRepoOptions {
  /** 资源库缓存根目录（userData/skill-repo） */
  repoDir: string
  /** Torra 技能目录：判断「已导入」要拿链接 realpath 与库内路径比对 */
  skillsDir: string
}

interface StoredSource {
  id: string
  kind: 'github' | 'local'
  ref: string
  /** github：最近缓存的 commit sha；local：缓存时刻源根 mtimeMs */
  version: string
  fetchedAt: number
  lastError?: string
}

interface SourceMeta {
  version: string
  fetchedAt: number
  lastError?: string
}

// ---------------------------------------------------------------------------
// 路径与序列化小件
// ---------------------------------------------------------------------------

function normalizeRepoName(input: string): string {
  const s = String(input || '').trim()
  // owner/repo
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/[^/]+(?:\/.*)?)?$/.exec(s)
  if (m) return `${m[1]}/${m[2]}`
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s
  return ''
}

/** <owner>/<repo> → 目录名：字符集收紧，杜绝路径成分 */
function sourceDirName(kind: 'github' | 'local', ref: string): string {
  if (kind === 'github') {
    const [owner = '', repo = ''] = ref.split('/')
    return `github--${owner}--${repo}`.toLowerCase().replace(/[^a-z0-9._-]/g, '_')
  }
  const base = path.basename(ref) || 'local'
  return `local--${base}`.toLowerCase().replace(/[^a-z0-9._-]/g, '_')
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T
  } catch {
    return null
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf-8')
}

// ---------------------------------------------------------------------------
// GitHub tarball：下载 + 安全解包
// ---------------------------------------------------------------------------

interface TarEntry {
  name: string
  kind: 'file' | 'dir'
  size: number
  /** data 的切片范围（buf 内偏移） */
  start: number
}

/**
 * 解析 ustar tar 流（GitHub tarball 是 POSIX ustar / GNU 长名混合；长名前缀
 * 类型 'L' 的条目先到，紧跟真实条目）。只关心 file / dir 两类，其它（链接、
 * FIFO、pax 头）跳过。
 */
export function parseTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = []
  let off = 0
  let pendingLongName: string | null = null
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const rawName = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '')
    const sizeField = header.subarray(124, 136).toString('utf-8').replace(/[\0 ]/g, '')
    const size = Number.parseInt(sizeField || '0', 8) || 0
    const typeflag = String.fromCharCode(header[156] ?? 48)
    const prefix = header.subarray(345, 500).toString('utf-8').replace(/\0.*$/, '')
    off += 512
    const dataStart = off
    off += Math.ceil(size / 512) * 512

    if (typeflag === 'L') {
      pendingLongName = buf.subarray(dataStart, dataStart + size).toString('utf-8').replace(/\0.*$/, '')
      continue
    }
    let name = rawName
    if (pendingLongName !== null) {
      name = pendingLongName
      pendingLongName = null
    } else if (prefix) {
      name = `${prefix}/${rawName}`
    }
    if (typeflag === '5') {
      out.push({ name, kind: 'dir', size: 0, start: dataStart })
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      out.push({ name, kind: 'file', size, start: dataStart })
    }
  }
  return out
}

/** 解包条目名是否安全：不带绝对路径与穿越成分 */
function safeEntryName(name: string): string | null {
  const n = name.replace(/\\/g, '/')
  if (path.isAbsolute(n) || n.split('/').includes('..')) return null
  return n
}

async function fetchGithubTarball(ref: string): Promise<{ buf: Buffer; commit: string }> {
  const res = await fetch(`https://codeload.github.com/${ref}/tar.gz/HEAD`, {
    headers: { 'User-Agent': 'torra-skill-repo' },
  })
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}（仓库不存在或网络不可达）`)
  const ab = await res.arrayBuffer()
  const gz = Buffer.from(ab)
  const { gunzipSync } = await import('node:zlib')
  const buf = gunzipSync(gz)
  // HEAD tarball 的根目录名带短 sha（<repo>-<7位>），从首个条目名里提出来当版本号
  const first = parseTar(buf)[0]
  const m = /^[^/]+-([0-9a-f]{7,40})\//.exec(first?.name ?? '')
  const commit = m?.[1] ?? String(Date.now())
  return { buf, commit }
}

// ---------------------------------------------------------------------------
// 来源管理
// ---------------------------------------------------------------------------

function sourcesFile(repoDir: string): string {
  return path.join(repoDir, SOURCES_FILE)
}

async function readSources(repoDir: string): Promise<StoredSource[]> {
  return (await readJson<StoredSource[]>(sourcesFile(repoDir))) ?? []
}

async function writeSources(repoDir: string, sources: StoredSource[]): Promise<void> {
  await writeJson(sourcesFile(repoDir), sources)
}

function toView(stored: StoredSource, skillCount: number): SkillSourceView {
  return {
    id: stored.id,
    kind: stored.kind,
    name: stored.kind === 'github' ? stored.ref : path.basename(stored.ref) || stored.ref,
    ref: stored.ref,
    skillCount,
    fetchedAt: stored.fetchedAt,
    ...(stored.lastError ? { lastError: stored.lastError } : {}),
  }
}

/** github:<owner>/<repo> / local:<绝对路径> */
export function makeSourceId(kind: 'github' | 'local', ref: string): string {
  return `${kind}:${ref}`
}

// ---------------------------------------------------------------------------
// 缓存目录里发现技能：与 pi 同判据 —— 有 SKILL.md 即技能根（不再下钻），否则收集直接 .md
// ---------------------------------------------------------------------------

interface RepoSkillRaw {
  relPath: string
  name: string
  description: string
  /** SKILL.md 的库内路径（目录型）或单文件 .md 路径 */
  file: string
  baseDir?: string
  kind: 'dir' | 'file'
  loadable: boolean
  warnings: string[]
}

const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', 'build', '.git'])

async function discoverSkillsInDir(root: string): Promise<RepoSkillRaw[]> {
  const out: RepoSkillRaw[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (out.length >= MAX_SKILLS || depth > 4) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const skillMd = entries.find((e) => e.isFile() && e.name === 'SKILL.md')
    if (skillMd) {
      const file = path.join(rel, 'SKILL.md')
      const fm = parseFrontmatter(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8').catch(() => ''))
      const name = fm.name?.trim() || path.basename(rel) || path.basename(dir)
      const description = (fm.description ?? '').slice(0, DESC_MAX)
      out.push({
        relPath: rel || path.basename(dir),
        name,
        description,
        file,
        baseDir: rel || undefined,
        kind: 'dir',
        loadable: Boolean(fm.description?.trim()),
        warnings: fm.description?.trim() ? [] : ['缺 description：助手不会加载这条技能'],
      })
      return // 技能根不再下钻
    }
    for (const e of entries) {
      if (out.length >= MAX_SKILLS) return
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name !== 'README.md') {
        const fm = parseFrontmatter(await fs.readFile(path.join(dir, e.name), 'utf-8').catch(() => ''))
        const description = (fm.description ?? '').slice(0, DESC_MAX)
        if (!description) continue // 散 .md 没有 frontmatter 说明的，当普通文档不收
        out.push({
          relPath: rel ? `${rel}/${e.name}` : e.name,
          name: fm.name?.trim() || e.name.replace(/\.md$/i, ''),
          description,
          file: rel ? `${rel}/${e.name}` : e.name,
          kind: 'file',
          loadable: true,
          warnings: [],
        })
      }
    }
  }
  await walk(root, '', 0)
  return out
}

// ---------------------------------------------------------------------------
// 主视图：来源 + 缓存技能 + 已导入判定
// ---------------------------------------------------------------------------

/** Torra 技能目录里现有链接 → realpath 集合，判定「已导入」用 */
async function importedRealpaths(skillsDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(skillsDir, e.name)
    const real = await fs.realpath(p).catch(() => null)
    if (real) out.set(real.toLowerCase(), e.name)
  }
  return out
}

export async function viewSkillRepo(opts: SkillRepoOptions): Promise<SkillRepoView> {
  const repoDir = path.resolve(opts.repoDir)
  const sources = await readSources(repoDir)
  const imported = await importedRealpaths(opts.skillsDir)
  const views: SkillSourceView[] = []
  const skills: RepoSkillView[] = []
  const updates: SkillRepoView['updates'] = []

  for (const st of sources) {
    const dirName = sourceDirName(st.kind, st.ref)
    const srcDir = path.join(repoDir, dirName)
    const meta = await readJson<SourceMeta>(path.join(srcDir, META_FILE))
    const cachedAt = meta?.fetchedAt ?? st.fetchedAt

    // 更新检查：github 查最新短 sha；local 查根目录 mtime。失败不算失败，标 unknown
    let upToDate = true
    let latest: string | undefined
    if (st.kind === 'github' && st.version) {
      try {
        const res = await fetch(`https://api.github.com/repos/${st.ref}/commits/HEAD`, {
          headers: { 'User-Agent': 'torra-skill-repo', Accept: 'application/vnd.github+json' },
        })
        if (res.ok) {
          const j = (await res.json()) as { sha?: string }
          latest = j.sha?.slice(0, 10)
          upToDate = !latest || st.version.startsWith(latest.slice(0, 7))
        }
      } catch {
        /* 网络不通：保持 upToDate，别把离线当成「有更新」 */
      }
    } else if (st.kind === 'local') {
      const mt = await fs.stat(st.ref).then((s) => s.mtimeMs).catch(() => 0)
      upToDate = !mt || Math.abs(mt - Number(st.version || 0)) < 1000
      if (!upToDate) latest = new Date(mt).toISOString()
    }

    let count = 0
    const exists = await fs.stat(srcDir).then((s) => s.isDirectory()).catch(() => false)
    if (exists) {
      const found = await discoverSkillsInDir(srcDir)
      for (const f of found) {
        count++
        const absDir = f.baseDir ? path.join(srcDir, f.baseDir) : undefined
        const real = absDir ? await fs.realpath(absDir).catch(() => null) : null
        const hit = real ? imported.get(real.toLowerCase()) : undefined
        skills.push({
          key: `${st.id}::${f.relPath}`,
          sourceId: st.id,
          sourceName: toView(st, count).name,
          name: f.name,
          description: f.description,
          relPath: f.relPath,
          loadable: f.loadable,
          warnings: f.warnings,
          imported: Boolean(hit),
          ...(hit ? { linkName: hit } : {}),
        })
      }
    }
    views.push(toView({ ...st, ...(meta ?? {}), fetchedAt: cachedAt }, count))
    updates.push({ sourceId: st.id, upToDate, ...(latest ? { latest } : {}) })
  }

  return { ok: true, repoDir, sources: views, skills, updates, checkedAt: Date.now() }
}

// ---------------------------------------------------------------------------
// 添加来源 + 拉取缓存
// ---------------------------------------------------------------------------

export async function addSkillSource(
  opts: SkillRepoOptions & { input: string },
): Promise<{ ok: boolean; reason?: string; sourceId?: string; addedSkills?: number }> {
  const repoDir = path.resolve(opts.repoDir)
  const raw = String(opts.input || '').trim()
  if (!raw) return { ok: false, reason: '来源为空' }

  // 本地目录：存在且是个目录就登记
  if (!/^https?:\/\//.test(raw) && !/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    const abs = path.resolve(raw)
    const st = await fs.stat(abs).catch(() => null)
    if (!st?.isDirectory()) return { ok: false, reason: `本地目录不存在：${abs}` }
    return await cacheLocal({ ...opts, repoDir, abs })
  }

  const ref = normalizeRepoName(raw)
  if (!ref) return { ok: false, reason: '识别不了来源：给 owner/repo、GitHub 链接或本地目录' }

  const id = makeSourceId('github', ref)
  const sources = await readSources(repoDir)
  const existing = sources.find((s) => s.id === id)

  // 拉取 tarball 并解包到 <repoDir>/github--<owner>--<repo>/
  let payload: { buf: Buffer; commit: string }
  try {
    payload = await fetchGithubTarball(ref)
  } catch (e) {
    const reason = (e as Error).message || '拉取失败'
    // 已登记过的保留登记并记下错误，别让一次网络抖动把来源弄丢
    if (existing) {
      await writeSources(
        repoDir,
        sources.map((s) => (s.id === id ? { ...s, lastError: reason } : s)),
      )
    }
    return { ok: false, reason }
  }

  const dirName = sourceDirName('github', ref)
  const dest = path.join(repoDir, dirName)
  await fs.rm(dest, { recursive: true, force: true })
  await fs.mkdir(dest, { recursive: true })

  const tar = parseTar(payload.buf)
  let written = 0
  for (const entry of tar) {
    if (entry.kind !== 'file') continue
    const name = safeEntryName(entry.name)
    if (!name) continue
    // 剥掉 tarball 根目录（<repo>-<sha>/），缓存里直接就是仓库内容
    const stripped = name.split('/').slice(1).join('/')
    if (!stripped || stripped === META_FILE || stripped === SOURCES_FILE) continue
    if (written >= MAX_SKILLS * 5) break // 文件数上限：技能目录不该有几万文件
    const target = path.join(dest, stripped)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, buf_slice(payload.buf, entry))
    written++
  }

  const meta: SourceMeta = { version: payload.commit, fetchedAt: Date.now() }
  await writeJson(path.join(dest, META_FILE), meta)
  const found = await discoverSkillsInDir(dest)
  const next: StoredSource = {
    id,
    kind: 'github',
    ref,
    version: payload.commit,
    fetchedAt: meta.fetchedAt,
  }
  await writeSources(
    repoDir,
    existing ? sources.map((s) => (s.id === id ? next : s)) : [...sources, next],
  )
  return { ok: true, sourceId: id, addedSkills: found.length }
}

function buf_slice(buf: Buffer, entry: TarEntry): Buffer {
  return buf.subarray(entry.start, entry.start + entry.size)
}

async function cacheLocal(
  opts: SkillRepoOptions & { repoDir: string; abs: string },
): Promise<{ ok: boolean; reason?: string; sourceId?: string; addedSkills?: number }> {
  const id = makeSourceId('local', opts.abs)
  const dirName = sourceDirName('local', opts.abs)
  const dest = path.join(opts.repoDir, dirName)
  await fs.rm(dest, { recursive: true, force: true })
  await fs.mkdir(dest, { recursive: true })
  let copied = 0
  const copy = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 4 || copied >= MAX_SKILLS * 5) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (copied >= MAX_SKILLS * 5) return
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const src = path.join(dir, e.name)
      const target = rel ? path.join(dest, rel, e.name) : path.join(dest, e.name)
      if (e.isDirectory()) {
        await fs.mkdir(target, { recursive: true })
        await copy(src, rel ? `${rel}/${e.name}` : e.name, depth + 1)
      } else if (e.isFile()) {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(src, target)
        copied++
      }
    }
  }
  try {
    await copy(opts.abs, '', 0)
  } catch (e) {
    return { ok: false, reason: `复制失败：${(e as Error).message}` }
  }
  const st = await fs.stat(opts.abs).catch(() => null)
  const meta: SourceMeta = { version: String(st?.mtimeMs ?? Date.now()), fetchedAt: Date.now() }
  await writeJson(path.join(dest, META_FILE), meta)
  const found = await discoverSkillsInDir(dest)
  const sources = await readSources(opts.repoDir)
  const next: StoredSource = {
    id,
    kind: 'local',
    ref: opts.abs,
    version: meta.version,
    fetchedAt: meta.fetchedAt,
  }
  await writeSources(
    opts.repoDir,
    sources.some((s) => s.id === id) ? sources.map((s) => (s.id === id ? next : s)) : [...sources, next],
  )
  return { ok: true, sourceId: id, addedSkills: found.length }
}

/** 按来源 id 重新拉取（更新检查发现落后时用） */
export async function refreshSkillSource(
  opts: SkillRepoOptions & { sourceId: string },
): Promise<{ ok: boolean; reason?: string }> {
  const st = (await readSources(path.resolve(opts.repoDir))).find((s) => s.id === opts.sourceId)
  if (!st) return { ok: false, reason: '来源不存在' }
  if (st.kind === 'github') {
    const r = await addSkillSource({ ...opts, input: st.ref })
    return { ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) }
  }
  const r = await cacheLocal({ ...opts, repoDir: path.resolve(opts.repoDir), abs: st.ref })
  return { ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) }
}

/**
 * 移除来源及其缓存。**已链接进技能目录的导入不受影响**：junction 指向的缓存目录
 * 被删后链接会变 dangling，界面本就有「失效链接」清理 —— 但更好的口径是先提示。
 * 这里只删缓存与登记，导入交给用户自己处置（移除导入 = 断链接，绝不 rm -rf 源）。
 */
export async function removeSkillSource(
  opts: SkillRepoOptions & { sourceId: string },
): Promise<{ ok: boolean; reason?: string }> {
  const repoDir = path.resolve(opts.repoDir)
  const sources = await readSources(repoDir)
  const st = sources.find((s) => s.id === opts.sourceId)
  if (!st) return { ok: false, reason: '来源不存在' }
  const dirName = sourceDirName(st.kind, st.ref)
  await fs.rm(path.join(repoDir, dirName), { recursive: true, force: true })
  await writeSources(repoDir, sources.filter((s) => s.id !== opts.sourceId))
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 从资源库导入进技能目录 / 移除
// ---------------------------------------------------------------------------

export async function importRepoSkill(
  opts: SkillRepoOptions & { key: string; name?: string },
): Promise<{ ok: boolean; reason?: string; linkName?: string }> {
  const repoDir = path.resolve(opts.repoDir)
  const src = String(opts.key || '')
  const sep = src.indexOf('::')
  if (sep < 0) return { ok: false, reason: 'key 不合法' }
  const sourceId = src.slice(0, sep)
  const rel = src.slice(sep + 2)
  if (rel.includes('..') || path.isAbsolute(rel)) return { ok: false, reason: 'key 不合法' }
  const st = (await readSources(repoDir)).find((s) => s.id === sourceId)
  if (!st) return { ok: false, reason: '来源已不存在，先刷新资源库' }
  const dirName = sourceDirName(st.kind, st.ref)
  const file = path.join(repoDir, dirName, ...rel.split('/'))
  const real = await fs.realpath(file).catch(() => null)
  if (!real) return { ok: false, reason: '技能文件不在缓存里，先刷新资源库' }
  // 复用既有导入：目录型 junction 指向缓存目录，单文件复制 + 标记。
  // 缓存只存一份，多个导入共享同一份真身。
  const { importSkill } = await import('./skills')
  return await importSkill({
    skillsDir: opts.skillsDir,
    key: real,
    ...(opts.name ? { name: opts.name } : {}),
  })
}
