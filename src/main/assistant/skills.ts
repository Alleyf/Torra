/**
 * 技能管理：扫描别的通用 agent 应用（Claude Code / Codex / Qoder / WorkBuddy / Trae…）
 * 放在自己目录里的技能，用软链接的方式接进 Torra 的技能加载目录。
 *
 * 为什么用链接而不是复制：这些技能是「别人家的」，用户会在原应用里继续更新它们，
 * 复制进 Torra 的那一刻就开始过期。链接还顺带解决了删除语义 —— 移除导入只断开链接，
 * 绝不碰源目录（rm -rf 一个指向用户主目录的链接，丢的是别人全部技能）。
 *
 * 三个实测出来的约束，代码按这个走：
 *
 * 1. **Windows 上免特权可用的目录链接只有 junction**。`symlink(target, p, 'dir')` 和
 *    `symlink(file, p, 'file')` 在未开启开发者模式时都是 EPERM。所以目录型技能一律建 junction；
 *    单文件技能（根目录下散放的 .md）只能「建目录 + 复制 SKILL.md」并留下标记文件 ——
 *    把它软链接成技能目录里的一个 .md 反而不对：pi 用父目录名当技能名，那样每条都会叫 skills。
 *
 * 2. **移除链接用 unlink，不能用 rmdir**。junction 的 lstat 报 isSymbolicLink()=true、
 *    isDirectory()=false；unlink 能干净地拆掉它，rmdir 才是留给真实目录的。
 *
 * 3. **发现和校验规则要跟 pi 一致**，否则「界面上导入成功、助手却用不了」：
 *    目录里有 SKILL.md 就把它当技能根且不再下钻；否则收集根下的直接 .md，再递归。
 *    名字取 frontmatter 的 name，缺省用父目录名；name/description 的规范校验只降级为
 *    警告（pi 也照样加载），唯独 description 缺失是真的用不了。
 *
 * 去重也和 pi 一样分两层：同一份文件被多个入口指到（Trae、CodeBuddy 的 skills 目录里
 * 全是指向 ~/.agents/skills 的链接）按 realpath 静默合并；不同文件但同名的只留先扫到的，
 * 其余计入 skipped —— 因为 pi 加载时也是这个名字先到先得。
 */

import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type {
  DiscoveredSkill,
  SkillAppView,
  SkillImportResult,
  SkillLinkKind,
  SkillScanView,
} from '../../shared/assistant'

/** 一个来源应用的根目录写法；`*` 是一段通配（插件缓存按 市场/插件/版本 分三层） */
export interface SkillRootSpec {
  pattern: string
  kind: 'user' | 'plugin'
}

export interface SkillAppSpec {
  id: string
  displayName: string
  roots: SkillRootSpec[]
}

/**
 * 已知应用的技能位置。顺序有意义：通用库排在最前，指向它的链接会被合并到通用库名下。
 * 用户目录先扫、插件缓存后扫，这样同名技能优先归属用户自己放的那份。
 */
export const SKILL_APPS: SkillAppSpec[] = [
  { id: 'agents', displayName: '通用技能库（~/.agents）', roots: [{ pattern: '.agents/skills', kind: 'user' }] },
  {
    id: 'claude',
    displayName: 'Claude Code',
    roots: [
      { pattern: '.claude/skills', kind: 'user' },
      { pattern: '.claude/plugins/cache/*/*/*/skills', kind: 'plugin' },
    ],
  },
  {
    id: 'codex',
    displayName: 'Codex',
    roots: [
      { pattern: '.codex/skills', kind: 'user' },
      { pattern: '.codex/plugins/cache/*/*/*/skills', kind: 'plugin' },
    ],
  },
  {
    id: 'qoder',
    displayName: 'Qoder',
    roots: [
      { pattern: '.qoder-cn/skills', kind: 'user' },
      { pattern: '.qoder-cn/plugins/cache/*/*/*/skills', kind: 'plugin' },
    ],
  },
  {
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    roots: [
      { pattern: '.workbuddy/skills', kind: 'user' },
      { pattern: '.workbuddy/plugins/cache/*/*/*/skills', kind: 'plugin' },
    ],
  },
  { id: 'trae', displayName: 'Trae', roots: [{ pattern: '.trae/skills', kind: 'user' }] },
  { id: 'codebuddy', displayName: 'CodeBuddy', roots: [{ pattern: '.codebuddy/skills', kind: 'user' }] },
]

/** 从根目录起最多下钻几层：再深就不是人的技能目录了，是在扫依赖 */
const MAX_DEPTH = 3
/** 单次扫描的条数上限，防止某个根意外指向超大目录树 */
const MAX_SKILLS = 600
/** 说明文字截到这么长就够界面用：整包技能说明进 IPC 会到几百 KB */
const DESC_MAX = 300
/** 通配展开出的根目录上限 */
const EXPAND_MAX = 60
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', 'build'])
/** 复制导入时在目录里留下的标记：只有它才允许被整目录删掉 */
const COPY_MARKER = '.torra-skill-copy.json'

export interface SkillScanOptions {
  /** Torra 的技能加载目录（userData/torra/pi/skills） */
  skillsDir: string
  /** 技能来源的搜索根；测试里指到一棵假树 */
  home?: string
  /** 只扫这几个应用；不给就是全部 */
  appIds?: string[]
}

/** 盘上读到的原始一条，还没做去重 */
interface RawSkill {
  appId: string
  appDisplayName: string
  key: string
  realpath: string
  name: string
  description: string
  baseDir?: string
  kind: 'dir' | 'file'
  loadable: boolean
  warnings: string[]
}

// ---------------------------------------------------------------------------
// frontmatter：只需要 name / description，但要支持块标量（>-、|）
// ---------------------------------------------------------------------------

export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== '---') return out
  let i = 1
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = line.trim()
    if (fence === '---' || fence === '...') break
    i += 1
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (!m) continue
    const key = m[1] ?? ''
    let value = (m[2] ?? '').trim()
    if (/^[|>][-+]?$/.test(value) || value === '') {
      const fold = value.startsWith('>')
      const block: string[] = []
      while (i < lines.length) {
        const cur = lines[i] ?? ''
        if (!/^\s+\S/.test(cur) && cur.trim() !== '') break
        block.push(cur.trim())
        i += 1
      }
      value = block.join(fold ? ' ' : '\n').trim()
    } else {
      value = value.replace(/^(['"])(.*)\1$/, '$2')
    }
    if (key && value) out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// 校验：照 pi 的 Agent Skills 规范
// ---------------------------------------------------------------------------

function nameWarnings(name: string): string[] {
  const errors: string[] = []
  if (name.length > 64) errors.push(`名称超过 64 字符（${name.length}）`)
  if (!/^[a-z0-9-]+$/.test(name)) errors.push('名称含规范外的字符（只允许小写字母、数字、连字符）')
  if (/^-|-$/.test(name)) errors.push('名称不能以连字符开头或结尾')
  if (name.includes('--')) errors.push('名称不能含连续连字符')
  return errors
}

function descriptionWarning(description: string): string | undefined {
  if (!description.trim()) return '缺少 description'
  if (description.length > 1024) return `description 超过 1024 字符（${description.length}）`
  return undefined
}

// ---------------------------------------------------------------------------
// 根目录展开与发现
// ---------------------------------------------------------------------------

/** 把带通配段的写法展开成实际存在的目录列表；通配段倒序排，让新版本先被扫到 */
async function expandRoot(home: string, pattern: string): Promise<string[]> {
  let current = [home]
  for (const seg of pattern.split('/')) {
    const next: string[] = []
    for (const base of current) {
      if (seg === '*') {
        const names = (await readDirNames(base)).slice().sort().reverse()
        for (const n of names) {
          if (n.startsWith('.')) continue
          const p = path.join(base, n)
          if (await isDirectory(p)) next.push(p)
          if (next.length >= EXPAND_MAX) break
        }
      } else {
        const p = path.join(base, seg)
        if (await isDirectory(p)) next.push(p)
      }
      if (next.length >= EXPAND_MAX) break
    }
    current = next
    if (current.length === 0) break
  }
  return current
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

function clipDesc(text: string): string {
  return text.length > DESC_MAX ? `${text.slice(0, DESC_MAX).trimEnd()}…` : text
}

/** 读一个技能主文件；解析失败不抛错，返回不可加载的条目，界面上才有话可说 */
async function readSkill(
  file: string,
  ctx: { appId: string; appDisplayName: string; kind: 'dir' | 'file'; baseDir?: string },
): Promise<RawSkill> {
  // 单文件技能的回落名用文件本身：pi 取的是父目录名，而根目录名叫 skills，
  // 照抄的话每条单文件技能都叫 skills，全撞在一起
  const dirName = ctx.kind === 'file' ? path.basename(file, '.md') : path.basename(ctx.baseDir ?? path.dirname(file))
  const base: RawSkill = {
    appId: ctx.appId,
    appDisplayName: ctx.appDisplayName,
    key: file,
    realpath: file,
    name: dirName,
    description: '',
    kind: ctx.kind,
    loadable: false,
    warnings: [],
    ...(ctx.baseDir ? { baseDir: ctx.baseDir } : {}),
  }
  let text: string
  try {
    text = await fs.readFile(file, 'utf-8')
  } catch (e) {
    return { ...base, warnings: [`读取失败：${(e as Error).message}`] }
  }
  const fm = parseFrontmatter(text)
  const name = (fm.name || dirName).trim()
  const description = (fm.description ?? '').trim()
  const warnings: string[] = []
  const descIssue = descriptionWarning(description)
  if (descIssue) warnings.push(descIssue)
  warnings.push(...nameWarnings(name))
  return {
    ...base,
    name,
    description: clipDesc(description),
    // 缺 description 时 pi 直接不加载这条技能，其余问题只是警告
    loadable: Boolean(description),
    warnings,
    realpath: await realpathSafe(file),
  }
}

async function realpathSafe(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

/**
 * 按 pi 的发现规则走一遍目录：
 * 有 SKILL.md 就是技能根、不再下钻；否则收根下的直接 .md，再递归子目录。
 */
async function walk(
  dir: string,
  ctx: { appId: string; appDisplayName: string },
  isRoot: boolean,
  depth: number,
  found: RawSkill[],
): Promise<void> {
  if (depth > MAX_DEPTH || found.length >= MAX_SKILLS) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const dirOf = (name: string) => path.join(dir, name)

  const skillMd = entries.find((e) => e.name === 'SKILL.md')
  if (skillMd && (await isFileOrLinkToFile(dirOf(skillMd.name)))) {
    found.push(await readSkill(dirOf(skillMd.name), { ...ctx, kind: 'dir', baseDir: dir }))
    return
  }

  for (const e of entries) {
    if (found.length >= MAX_SKILLS) return
    if (e.name.startsWith('.')) continue
    if (SKIP_DIRS.has(e.name)) continue
    const full = dirOf(e.name)
    // 链接要像 pi 那样先穿透再看它到底是什么；指不到东西的链接单独报出来
    let isDir = e.isDirectory()
    let isFile = e.isFile()
    if (e.isSymbolicLink()) {
      const target = await fs.stat(full).catch(() => null)
      if (!target) {
        // 链接指向的位置没了：不跳过，标成不可加载 —— 否则用户只看到「少了几个」却不知道为什么
        found.push({
          appId: ctx.appId,
          appDisplayName: ctx.appDisplayName,
          key: path.join(full, 'SKILL.md'),
          realpath: full,
          name: e.name.replace(/\.md$/i, ''),
          description: '',
          kind: 'dir',
          loadable: false,
          warnings: ['链接指向的位置已不存在'],
          baseDir: full,
        })
        continue
      }
      isDir = target.isDirectory()
      isFile = target.isFile()
    }
    if (isDir) {
      await walk(full, ctx, false, depth + 1, found)
      continue
    }
    if (isRoot && isFile && e.name.endsWith('.md')) {
      found.push(await readSkill(full, { ...ctx, kind: 'file' }))
    }
  }
}

async function isFileOrLinkToFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Torra 侧现状：已导入的链接、失效的链接、被占用的名字
// ---------------------------------------------------------------------------

interface ExistingLink {
  name: string
  kind: SkillLinkKind
  /** 链接指向的技能主文件真实路径；复制导入时是当初的来源文件 */
  sourceFile: string
  dangling: boolean
  target: string
}

async function readExisting(skillsDir: string): Promise<ExistingLink[]> {
  let names: string[]
  try {
    names = await fs.readdir(skillsDir)
  } catch {
    return []
  }
  const out: ExistingLink[] = []
  for (const name of names) {
    const p = path.join(skillsDir, name)
    const st = await fs.lstat(p).catch(() => null)
    if (!st) continue
    if (st.isSymbolicLink()) {
      const target = path.resolve(skillsDir, await fs.readlink(p).catch(() => ''))
      const real = await realpathSafe(target)
      const skillFile = path.join(real, 'SKILL.md')
      out.push({
        name,
        kind: process.platform === 'win32' ? 'junction' : 'symlink',
        sourceFile: await isFileOrLinkToFile(skillFile) ? skillFile : real,
        dangling: !(await fs.stat(target).catch(() => null)),
        target,
      })
      continue
    }
    if (!st.isDirectory()) continue
    // 只有带标记的目录才是 Torra 复制导入的，别的都是用户自己放的东西
    const marker = await fs.readFile(path.join(p, COPY_MARKER), 'utf-8').catch(() => null)
    if (!marker) continue
    let source = ''
    try {
      source = String((JSON.parse(marker) as { sourceFile?: unknown }).sourceFile ?? '')
    } catch {
      source = ''
    }
    out.push({ name, kind: 'copy', sourceFile: source || path.join(p, 'SKILL.md'), dangling: false, target: p })
  }
  return out
}

/**
 * 名字必须能当文件名用。这里只做「文件系统安全」的清洗，不按 Agent Skills 规范强改：
 * 名称不合规范是原技能的事（pi 也会加载），Torra 擅自改名反而让人找不到原来那条。
 */
export function safeLinkName(name: string): string {
  const cleaned = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 64)
  return cleaned || 'skill'
}

function occupiedName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; i <= 20; i += 1) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return ''
}

// ---------------------------------------------------------------------------
// 对外：扫描 / 导入 / 移除
// ---------------------------------------------------------------------------

export async function scanSkills(opts: SkillScanOptions): Promise<SkillScanView> {
  const home = opts.home ?? os.homedir()
  const skillsDir = path.resolve(opts.skillsDir)
  const apps = SKILL_APPS.filter((a) => !opts.appIds?.length || opts.appIds.includes(a.id))
  const rootsByApp = new Map<string, string[]>()
  const seenReal = new Set<string>()
  const seenName = new Set<string>()
  const perApp = new Map<string, RawSkill[]>()
  const skipped = new Map<string, number>()

  for (const kind of ['user', 'plugin'] as const) {
    for (const app of apps) {
      for (const spec of app.roots.filter((r) => r.kind === kind)) {
        const roots = await expandRoot(home, spec.pattern)
        for (const root of roots) {
          const found: RawSkill[] = []
          await walk(root, { appId: app.id, appDisplayName: app.displayName }, true, 0, found)
          for (const f of found) {
            // 同一份文件被多个入口指到：合并到先扫到的那条（Trae/CodeBuddy 全是 ~/.agents 的链接）
            if (seenReal.has(f.realpath)) {
              skipped.set(app.id, (skipped.get(app.id) ?? 0) + 1)
              continue
            }
            // 链接失效的技能不参与名字占用：它本来就该被清掉，别挡住同名技能
            if (f.loadable && seenName.has(f.name)) {
              skipped.set(app.id, (skipped.get(app.id) ?? 0) + 1)
              continue
            }
            seenReal.add(f.realpath)
            if (f.loadable) seenName.add(f.name)
            const list = perApp.get(app.id) ?? []
            list.push(f)
            perApp.set(app.id, list)
          }
          const acc = rootsByApp.get(app.id) ?? []
          acc.push(root)
          rootsByApp.set(app.id, acc)
        }
      }
    }
  }

  const existing = await readExisting(skillsDir)
  const bySource = new Map(existing.map((e) => [e.sourceFile, e]))

  const views: SkillAppView[] = apps.map((app) => {
    const raw = (perApp.get(app.id) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
    const skills: DiscoveredSkill[] = raw.map((r) => {
      const hit = bySource.get(r.realpath)
      return {
        key: r.key,
        name: r.name,
        description: r.description,
        path: r.key,
        ...(r.baseDir ? { baseDir: r.baseDir } : {}),
        appId: r.appId,
        appDisplayName: r.appDisplayName,
        kind: r.kind,
        loadable: r.loadable,
        warnings: r.warnings,
        imported: Boolean(hit),
        ...(hit ? { linkName: hit.name, linkKind: hit.kind } : {}),
      }
    })
    const roots = rootsByApp.get(app.id) ?? []
    return {
      id: app.id,
      displayName: app.displayName,
      roots,
      missing: roots.length === 0,
      skills,
      skipped: skipped.get(app.id) ?? 0,
    }
  })

  return {
    ok: true,
    home,
    skillsDir,
    apps: views,
    dangling: existing.filter((e) => e.dangling).map((e) => ({ name: e.name, target: e.target })),
    total: views.reduce((n, v) => n + v.skills.length, 0),
    imported: views.reduce((n, v) => n + v.skills.filter((s) => s.imported).length, 0),
    scannedAt: Date.now(),
  }
}

export interface SkillImportOptions extends SkillScanOptions {
  /** 扫描结果里的 key（技能主文件的绝对路径） */
  key: string
  /** 期望的链接名，缺省用技能的目录名 */
  name?: string
}

/**
 * 建链接。源目录绝不被修改；写操作只发生在 skillsDir 里。
 */
export async function importSkill(opts: SkillImportOptions): Promise<SkillImportResult> {
  const skillsDir = path.resolve(opts.skillsDir)
  const key = path.resolve(String(opts.key ?? ''))
  if (!path.isAbsolute(key)) return { ok: false, reason: '技能路径无效' }

  const fileBase = path.basename(key)
  const isSkillMd = fileBase === 'SKILL.md'
  if (!isSkillMd && !fileBase.toLowerCase().endsWith('.md')) {
    return { ok: false, reason: '只能导入技能主文件（SKILL.md 或单文件技能的 .md）' }
  }
  if (!(await isFileOrLinkToFile(key))) return { ok: false, reason: '技能文件已不存在，重新扫描后再试' }

  const realFile = await realpathSafe(key)
  const realSkills = await realpathSafe(skillsDir)
  if (realSkills && realFile.startsWith(realSkills + path.sep)) {
    return { ok: false, reason: '这个技能已经在 Torra 的技能目录里了' }
  }

  const existing = await readExisting(skillsDir)
  const hit = existing.find((e) => e.sourceFile === realFile && !e.dangling)
  if (hit) return { ok: true, name: hit.name, linkKind: hit.kind, reason: `已经导入过了：${hit.name}` }

  const taken = new Set(existing.map((e) => e.name))
  const wanted = safeLinkName(opts.name || (isSkillMd ? path.basename(path.dirname(key)) : fileBase.replace(/\.md$/i, '')))
  const name = occupiedName(wanted, taken)
  if (!name) return { ok: false, reason: `「${wanted}」附近的重名太多，先清理再导入` }

  const link = path.join(skillsDir, name)
  try {
    await fs.mkdir(skillsDir, { recursive: true })
    if (isSkillMd) {
      const target = path.resolve(path.dirname(key))
      const type = process.platform === 'win32' ? 'junction' : 'dir'
      await fs.symlink(target, link, type)
      return { ok: true, name, linkKind: type === 'junction' ? 'junction' : 'symlink' }
    }
    // 单文件技能只能建目录再复制：pi 认「目录名 = 技能名」，把 .md 直接软链接进技能目录的话
    // 它的名字会变成父目录名（skills），所有单文件技能会全撞在一起。
    await fs.mkdir(link, { recursive: true })
    await fs.copyFile(key, path.join(link, 'SKILL.md'))
    await fs.writeFile(path.join(link, COPY_MARKER), JSON.stringify({ sourceFile: realFile, importedAt: Date.now() }), 'utf-8')
    return { ok: true, name, linkKind: 'copy', reason: '单文件技能没有自己的目录可链接，已复制一份进来' }
  } catch (e) {
    return { ok: false, reason: '导入失败', detail: (e as Error).message }
  }
}

/**
 * 断开导入。只碰 Torra 目录里的链接和带标记的复制目录，
 * 其它一律拒绝 —— 卸载不该变成删库。
 */
export async function removeSkill(opts: { skillsDir: string; name: string }): Promise<SkillImportResult> {
  const skillsDir = path.resolve(opts.skillsDir)
  const name = String(opts.name ?? '')
  if (!name || name !== path.basename(name)) return { ok: false, reason: '名称不合法' }
  const p = path.join(skillsDir, name)
  const st = await fs.lstat(p).catch(() => null)
  if (!st) return { ok: false, reason: `「${name}」不在技能目录里` }
  try {
    if (st.isSymbolicLink()) {
      await fs.unlink(p)
      return { ok: true, name, linkKind: process.platform === 'win32' ? 'junction' : 'symlink' }
    }
    if (st.isDirectory() && (await fs.stat(path.join(p, COPY_MARKER)).catch(() => null))) {
      await fs.rm(p, { recursive: true, force: true })
      return { ok: true, name, linkKind: 'copy' }
    }
    return { ok: false, reason: `「${name}」不是 Torra 导入的链接，出于安全没有删除` }
  } catch (e) {
    return { ok: false, reason: '移除失败', detail: (e as Error).message }
  }
}

/**
 * Torra 技能目录里现在有什么（目录型取 <name>/SKILL.md，单文件型取 <name>.md）。
 *
 * 不走 capabilities() 那份快照：它是「上一次装配会话时 pi 读到的结果」，
 * 第一条消息之前是空的 —— 而 / 浮层在第一条消息之前就要能选技能。
 * 盘上读出来的这批正是下一次装配会加载的，所以两者 eventual 一致，
 * 差别只在这一刻：这里能立刻给用户看。
 */
export async function listImportedSkills(
  skillsDir: string,
): Promise<Array<{ name: string; description: string; path: string }>> {
  const dir = path.resolve(skillsDir)
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: Array<{ name: string; description: string; path: string }> = []
  const seen = new Set<string>()
  for (const e of entries) {
    const full = path.join(dir, e.name)
    const isDir = await fs
      .stat(full)
      .then((s) => s.isDirectory())
      .catch(() => false)
    // 技能主文件名固定是 SKILL.md；单文件技能就是那个 .md 本身
    const main = isDir ? path.join(full, 'SKILL.md') : e.name.toLowerCase().endsWith('.md') ? full : ''
    if (!main) continue
    const text = await fs.readFile(main, 'utf-8').catch(() => '')
    if (!text) continue
    const fm = parseFrontmatter(text)
    const name = (fm.name || (isDir ? e.name : e.name.replace(/\.md$/i, ''))).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, description: (fm.description ?? '').replace(/\s+/g, ' ').trim(), path: main })
    if (out.length >= 200) break
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 助手自己写一条技能：正文落进 Torra 技能目录里的 <name>/SKILL.md。
 *
 * 同名一律拒绝，不覆盖。技能目录里同名的那条很可能是指向别的应用的软链接，
 * 顺着写过去就不是「改 Torra 的配置」而是替用户改了 Claude Code / Codex 的文件。
 */
export async function writeAuthoredSkill(opts: {
  skillsDir: string
  name: string
  description: string
  body: string
}): Promise<SkillImportResult> {
  const name = safeLinkName(opts.name)
  const description = String(opts.description ?? '').replace(/\s+/g, ' ').trim()
  const body = String(opts.body ?? '')
  if (!description) return { ok: false, reason: '缺少 description：模型全靠这句话决定要不要用这条技能' }
  if (description.length > 500) return { ok: false, reason: 'description 超过 500 字符' }
  if (!body.trim()) return { ok: false, reason: '技能正文是空的' }
  if (body.length > 20_000) return { ok: false, reason: '技能正文超过 20000 字符，拆成引用文件再写' }
  const dir = path.join(path.resolve(opts.skillsDir), name)
  if (await fs.lstat(dir).catch(() => null)) {
    return { ok: false, reason: `技能目录里已有「${name}」，不覆盖（可能是导入的软链接）；换个名字，或先让它在设置页里移除` }
  }
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: "${description.replace(/"/g, '\'')}"\n---\n\n${body.trim()}\n`,
      'utf-8',
    )
  } catch (e) {
    return { ok: false, reason: '写入失败', detail: (e as Error).message }
  }
  return { ok: true, name, linkKind: 'copy', reason: `已写入技能「${name}」` }
}
