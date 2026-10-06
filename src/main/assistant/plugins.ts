/**
 * 声明式插件：一条工具 = 一个 JSON 清单，解释器只有一个。
 *
 * 为什么是「清单 + 解释器」而不是「让助手直接写 JS 扩展」：清单是数据，
 * 一张确认卡片就看得完；JS 扩展是跑在主进程里的任意代码，审的是源码本身。
 * 所以能力分层 —— 这一层故意不支持自定义渲染、不支持工具调工具，
 * 换来的是「助手自己造的工具也逃不出这一个解释器」。
 *
 * 三条实测约束：
 *
 * 1. **只能在会话组装时注册**。pi 的显式 tools 白名单会在 _refreshToolRegistry 里
 *    把不在名单上的扩展工具整个滤掉（连 _toolRegistry 都进不去），运行时
 *    pi.registerTool 加新名字必然被吞 —— 所以清单变了必须重组会话，
 *    界面上那句「下一次对话生效」不是客气话，是唯一的真话。
 * 2. **参数 schema 是 TypeBox，不是裸 JSON Schema**。所以这里只接受一个明确
 *    的子集，编译不过就整条判无效 —— 宁可少注册，不能静默放宽成 any。
 * 3. **shell 只走 execFile + argv 数组**。过 shell 解析等于把 {{param}} 变成命令注入。
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { AssistantPluginView } from '../../shared/assistant'
import { loadTypeBox } from './pi-sdk'

/** 清单文件名后缀：一个插件一个文件，文件名就是它的身份 */
export const PLUGIN_SUFFIX = '.plugin.json'
/** 回给模型的文本上限，和 tools.ts 的 MAX_TEXT 同量级 */
const MAX_TEXT = 8000
/** 响应体读取硬上限：超了直接截断，防止一个接口把上下文窗口灌满 */
const MAX_BODY_BYTES = 200_000
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 120_000

export type PluginKind = 'http' | 'shell'
export type PluginConfirm = 'always' | 'once' | 'never'
export interface HttpImpl {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
}

export interface ShellImpl {
  argv: string[]
  /** 工作目录：'plugin' 表示清单所在目录（默认），'data' 表示 Torra 的 dataDir */
  cwd?: 'plugin' | 'data'
}

export interface PluginManifest {
  name: string
  label: string
  description: string
  kind: PluginKind
  parameters: Record<string, unknown>
  http?: HttpImpl
  shell?: ShellImpl
  confirm: PluginConfirm
  timeoutMs: number
  enabled: boolean
  /** 清单文件路径，报错和设置页都要用 */
  file: string
}

/** 一条清单读不出来的结果：名字 + 文件 + 全部原因 */
export interface InvalidPlugin {
  ok: false
  name: string
  file: string
  errors: string[]
}

/** 磁盘上一条清单的判定结果：有效的给清单，无效的给名字 + 原因 */
export type PluginEntry = { ok: true; manifest: PluginManifest } | InvalidPlugin

/**
 * 给设置页/面板看的视图：类型直接取跨进程契约那份，
 * 免得主进程和渲染层各写一个字段表，最后错位的是界面。
 * 只包含有效的清单；无效的走 capabilities.errors，界面上按文件路径解释。
 */
export type PluginView = AssistantPluginView

// ---------------------------------------------------------------------------
// 校验与编译
// ---------------------------------------------------------------------------

/** 工具名要进 pi 的注册表，也进文件名：只留小写字母、数字、连字符 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/

/**
 * 清单能引用的钥匙串条目：只认 plugin: 前缀。
 *
 * 一条清单可以把值发往它自己写的 URL，所以 REF 绝不能是模型的 `<id>:key` ——
 * 否则助手自造的插件就成了把 Torra 的 API Key 外送的一条通道。
 */
export const PLUGIN_SECRET_RE = /^plugin:[A-Za-z0-9._-]{1,64}$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 默认确认策略：写操作和 shell 必须问，GET/HEAD 放行 */
function defaultConfirm(kind: PluginKind, method: string): PluginConfirm {
  if (kind === 'shell') return 'always'
  return method === 'GET' || method === 'HEAD' ? 'never' : 'always'
}

/**
 * 校验一条清单。
 *
 * 错误一次全收集，不分批报：设置页和助手都要靠这几行字判断「我刚才写错了什么」，
 * 一次只报一个错会让人连改三轮。
 */
export function validateManifest(raw: unknown, file: string): PluginEntry {
  const errors: string[] = []
  const base = path.basename(file).replace(new RegExp(`${PLUGIN_SUFFIX}$`), '')
  if (!isPlainObject(raw)) {
    return { ok: false, name: base, file, errors: ['清单必须是一个 JSON 对象'] }
  }
  const name = str(raw.name).trim() || base
  if (!NAME_RE.test(name)) {
    errors.push(`名字「${name}」不合法：只能用小写字母、数字、连字符，且不能以连字符开头或结尾`)
  }
  if (name !== base) {
    errors.push(`名字「${name}」和文件名「${base}」不一致：一个插件的身份只能有一个来源`)
  }
  const description = str(raw.description).trim()
  if (!description) errors.push('缺少 description：模型全靠这句话决定要不要用这个工具')
  if (description.length > 1024) errors.push('description 超过 1024 字符')

  const kind = str(raw.kind)
  if (kind !== 'http' && kind !== 'shell') {
    errors.push(`kind 只能是 'http' 或 'shell'，现在是「${kind || '(空)'}」`)
  }

  const parameters = raw.parameters
  if (!isPlainObject(parameters) || parameters.type !== 'object') {
    errors.push("parameters 必须是 { type: 'object', properties: {...} } 形式的 JSON Schema")
  } else {
    errors.push(...checkJsonSchema(parameters))
  }

  let http: HttpImpl | undefined
  let shell: ShellImpl | undefined
  if (kind === 'http') {
    const h = raw.http
    if (!isPlainObject(h)) {
      errors.push('kind=http 但缺少 http 段')
    } else {
      const method = str(h.method).toUpperCase() || 'GET'
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        errors.push(`http.method 不支持「${method}」`)
      }
      const url = str(h.url).trim()
      if (!url) errors.push('http.url 不能为空')
      else if (!parseUrl(url)) errors.push(`http.url 不是合法的 http(s) 绝对地址：「${url}」`)
      else if (!/^https?:/i.test(url)) errors.push('http.url 只能是 http(s)')
      if (h.headers !== undefined && !isStringMap(h.headers)) errors.push('http.headers 必须是字符串到字符串')
      if (h.body !== undefined && typeof h.body !== 'string') errors.push('http.body 只能是字符串')
      http = { method, url, headers: h.headers as Record<string, string> | undefined, body: h.body as string | undefined }
    }
  } else if (kind === 'shell') {
    const s = raw.shell
    if (!isPlainObject(s) || !Array.isArray(s.argv) || s.argv.length === 0) {
      errors.push('kind=shell 需要 shell.argv：一个非空的字符串数组，不过 shell 解析')
    } else {
      const argv = s.argv.map((a) => String(a))
      if (argv.some((a) => !a.trim())) errors.push('shell.argv 里有空参数')
      // argv[0] 是「执行哪个程序」，绝不能由模型填：否则一次调用就能换任意二进制
      if (/\{\{/.test(argv[0] ?? '')) errors.push('shell.argv[0] 不能含占位符：要执行哪个程序由清单定死，不由模型定')
      const cwd = str(s.cwd)
      if (cwd && cwd !== 'plugin' && cwd !== 'data') errors.push("shell.cwd 只能是 'plugin' 或 'data'")
      shell = { argv, cwd: (cwd || undefined) as ShellImpl['cwd'] }
    }
  }

  const confirm = str(raw.confirm)
  if (confirm && !['always', 'once', 'never'].includes(confirm)) {
    errors.push("confirm 只能是 'always' / 'once' / 'never'")
  }
  for (const ref of secretRefsIn(raw.http, raw.shell)) {
    if (!PLUGIN_SECRET_RE.test(ref)) {
      errors.push(`占位符 secrets:${ref} 不合法：只能引用 plugin: 前缀的钥匙串条目，模型的 API Key 不允许经插件外送`)
    }
  }
  const timeoutRaw = raw.timeoutMs
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (timeoutRaw !== undefined) {
    const n = Number(timeoutRaw)
    if (!Number.isFinite(n) || n < 100 || n > MAX_TIMEOUT_MS) {
      errors.push(`timeoutMs 得是 100 到 ${MAX_TIMEOUT_MS} 之间的数字`)
    } else timeoutMs = n
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push('enabled 只能是 true / false')
  }

  if (errors.length) return { ok: false, name, file, errors }
  return {
    ok: true,
    manifest: {
      name,
      label: str(raw.label).trim() || name,
      description,
      kind: kind as PluginKind,
      parameters: parameters as Record<string, unknown>,
      http,
      shell,
      confirm: (confirm || defaultConfirm(kind as PluginKind, http?.method ?? '')) as PluginConfirm,
      timeoutMs,
      enabled: raw.enabled !== false,
      file,
    },
  }
}

function isStringMap(v: unknown): boolean {
  return isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string')
}

/** 从实现的各段字符串里挑出 {{secrets:REF}} 的 REF */
function secretRefsIn(...nodes: unknown[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n === undefined) continue
    for (const m of JSON.stringify(n).matchAll(/\{\{\s*secrets:([^{}]+?)\s*\}\}/g)) out.push((m[1] ?? '').trim())
  }
  return out
}

/**
 * 先按 JSON 结构粗查一遍，编译留到 manifestToToolDef（那时才有 Type 可用）。
 *
 * 递归而不是一层：object/array 可以嵌，只查一层的话，嵌套节点里「编译时才会炸」的写法
 * （object 没有 properties、array 没有 items）会先通过校验、再在注册阶段报「注册失败」——
 * 那份清单于是同时出现在「已加载」和「无效」两处，等于在骗用户。
 */
function checkJsonSchema(schema: Record<string, unknown>): string[] {
  return checkSchemaNode(schema, 'parameters', true)
}

function checkSchemaNode(node: Record<string, unknown>, where: string, isRoot: boolean): string[] {
  const out: string[] = []
  out.push(...unknownKeys(node, isRoot ? ROOT_SCHEMA_KEYS : NODE_SCHEMA_KEYS, where))
  const t = str(node.type)
  if (isRoot || t === 'object') {
    const props = node.properties
    if (!isPlainObject(props) || Object.keys(props).length === 0) {
      out.push(
        isRoot
          ? 'parameters.properties 至少要有一个字段：没有参数的工具直接写内置工具就行'
          : `${where} 声明是 object 却没有 properties，编译时会失败`,
      )
      return out
    }
    for (const [key, sub] of Object.entries(props)) {
      const subWhere = `${where}.properties.${key}`
      if (!isPlainObject(sub)) {
        out.push(`${subWhere} 必须是个对象`)
        continue
      }
      out.push(...checkSchemaNode(sub, subWhere, false))
    }
    if (isRoot && node.required !== undefined && !Array.isArray(node.required)) {
      out.push('parameters.required 必须是数组')
    }
    return out
  }
  if (t === 'array') {
    const items = node.items
    if (!isPlainObject(items)) {
      out.push(`${where} 是 array，必须给出 items`)
      return out
    }
    out.push(...checkSchemaNode(items, `${where}.items`, false))
    return out
  }
  if (!['string', 'number', 'integer', 'boolean'].includes(t)) {
    out.push(`${where} 的 type「${t || '(空)'}」不在支持范围内`)
  }
  return out
}

const ROOT_SCHEMA_KEYS = ['type', 'properties', 'required', 'additionalProperties', 'description']
const NODE_SCHEMA_KEYS = ['type', 'description', 'enum', 'items', 'properties', 'required', 'additionalProperties']

/**
 * 列出 schema 节点上没实现的字段。
 *
 * 这一道是「宁可判无效」的落点：JSON Schema 的 format/pattern/minLength/anyOf
 * 这里都不实现，如果放着不管，作者以为加了 ^\\d+$ 的约束，实际模型传什么都行 ——
 * 静默放宽比报错危险得多。
 */
function unknownKeys(node: Record<string, unknown>, allowed: string[], where: string): string[] {
  const extra = Object.keys(node).filter((k) => !allowed.includes(k))
  return extra.length ? [`${where} 有没实现的字段：${extra.join('、')}（只支持 type/description/enum/items/properties/required/additionalProperties）`] : []
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/**
 * JSON Schema 子集 → TypeBox。
 *
 * 只认校验里已经过一遍的那几种类型；额外塞的东西（format、pattern、anyOf）
 * 一律拒绝，因为「清单写了但被静默忽略」比「编译失败」危险得多 ——
 * 作者以为加了 ^\\d+$ 的约束，实际模型传什么都行。
 */
export async function compileParameters(schema: Record<string, unknown>): Promise<unknown> {
  const { Type } = await loadTypeBox()
  return compileObject(Type, schema)
}

function compileObject(Type: any, schema: Record<string, unknown>): unknown {
  const props = schema.properties as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : [])
  const shape: Record<string, unknown> = {}
  for (const [key, sub] of Object.entries(props)) {
    const node = compileNode(Type, sub, `parameters.properties.${key}`)
    shape[key] = required.has(key) ? node : Type.Optional(node)
  }
  // 默认关掉未知字段：模型多塞一个参数时，宁可报 schema 错也不要它以为生效了。
  // 只有清单显式写 additionalProperties: true 才放行 —— 真值判断而不是取反，
  // 省得写成字符串/缺省时反而变成「全放开」。
  return Type.Object(shape, { additionalProperties: schema.additionalProperties === true })
}

function compileNode(Type: any, sub: Record<string, unknown>, where: string): unknown {
  const t = str(sub.type)
  const desc = str(sub.description)
  const opts = desc ? { description: desc } : undefined
  if (t === 'string') {
    const enumValues = Array.isArray(sub.enum) ? (sub.enum as unknown[]).map(String) : undefined
    return enumValues?.length ? Type.String({ ...opts, enum: enumValues }) : Type.String(opts)
  }
  if (t === 'number') return Type.Number(opts)
  if (t === 'integer') return Type.Integer(opts)
  if (t === 'boolean') return Type.Boolean(opts)
  if (t === 'array') {
    const items = sub.items as Record<string, unknown>
    return Type.Array(compileNode(Type, items, `${where}.items`), opts)
  }
  if (t === 'object') {
    if (!isPlainObject(sub.properties)) throw new Error(`${where} 是 object 但没有 properties`)
    return compileObject(Type, sub)
  }
  throw new Error(`${where} 的 type「${t}」编译不了`)
}

// ---------------------------------------------------------------------------
// 磁盘读写
// ---------------------------------------------------------------------------

export function pluginsDirOf(dataDir: string): string {
  return path.join(dataDir, 'pi', 'plugins')
}

/** 读整个目录：有效的进列表，无效的单独带原因 —— 静默丢掉一条清单是最难查的 */
export function loadPluginManifests(dir: string): { manifests: PluginManifest[]; invalid: InvalidPlugin[] } {
  const manifests: PluginManifest[] = []
  const invalid: InvalidPlugin[] = []
  if (!existsSync(dir)) return { manifests, invalid }
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(PLUGIN_SUFFIX))
  } catch {
    return { manifests, invalid }
  }
  const seen = new Set<string>()
  for (const f of files.sort()) {
    const file = path.join(dir, f)
    let entry: PluginEntry
    try {
      entry = validateManifest(JSON.parse(readFileSync(file, 'utf-8')), file)
    } catch (e) {
      entry = { ok: false, name: f.replace(new RegExp(`${PLUGIN_SUFFIX}$`), ''), file, errors: [`JSON 解析失败：${(e as Error).message}`] }
    }
    if (!entry.ok) {
      invalid.push(entry)
      continue
    }
    if (seen.has(entry.manifest.name)) {
      invalid.push({ ok: false, name: entry.manifest.name, file, errors: ['已有同名插件：一个名字只能有一条清单'] })
      continue
    }
    if (!entry.manifest.enabled) continue
    seen.add(entry.manifest.name)
    manifests.push(entry.manifest)
  }
  return { manifests, invalid }
}

export function toPluginView(m: PluginManifest): PluginView {
  return {
    name: m.name,
    label: m.label,
    description: m.description,
    kind: m.kind,
    confirm: m.confirm,
    enabled: m.enabled,
    file: m.file,
  }
}

/** 写清单：先校验再落盘，非法清单永远进不了目录（目录里只可能有用户手写的坏文件） */
export function writePluginManifest(dir: string, raw: unknown): { ok: boolean; reason: string; file?: string } {
  const name = str(isPlainObject(raw) ? raw.name : undefined).trim()
  if (!name) return { ok: false, reason: '清单必须带 name' }
  if (!NAME_RE.test(name)) return { ok: false, reason: `名字「${name}」不合法：只能小写字母、数字、连字符` }
  const file = path.join(dir, `${name}${PLUGIN_SUFFIX}`)
  const entry = validateManifest(raw, file)
  if (!entry.ok) return { ok: false, reason: entry.errors.join('；') }
  if (existsSync(file)) return { ok: false, reason: `插件「${name}」已经存在，要改就先删掉它` }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
  return { ok: true, reason: `已写入 ${name}`, file }
}

export function removePluginManifest(dir: string, name: string): { ok: boolean; reason: string } {
  if (!NAME_RE.test(name)) return { ok: false, reason: `名字「${name}」不合法` }
  const file = path.join(dir, `${name}${PLUGIN_SUFFIX}`)
  if (!existsSync(file)) return { ok: false, reason: `没有叫「${name}」的插件清单` }
  try {
    rmSync(file)
  } catch (e) {
    return { ok: false, reason: `删不掉：${(e as Error).message}` }
  }
  return { ok: true, reason: `已删除插件「${name}」（只删清单文件，不动别的）` }
}

// ---------------------------------------------------------------------------
// Tier C：助手写的 JS 扩展
// ---------------------------------------------------------------------------

/**
 * 待审扩展目录。
 *
 * 为什么单独一个目录：pi 只从 agentDir/extensions 加载扩展，而扩展是直接跑进主进程的
 * 任意代码 —— 助手写出来的东西绝不能落进那个目录就自动生效。放在 pending 里，
 * 它就是一个普通文件，读它、审它、删它都安全；要生效必须由人在设置页点「启用」，
 * 那一步做的是把文件搬进 extensions/。
 *
 * 卡片上放的是源码本身，不是助手对源码的描述 —— 让被审查者写审查意见不叫审查。
 */
export function pendingDirOf(dataDir: string): string {
  return path.join(dataDir, 'pi', 'pending')
}

export function extensionsDirOf(dataDir: string): string {
  return path.join(dataDir, 'pi', 'extensions')
}

/** 源码太长不放进卡片：行数 + 首若干行，剩下的看文件 */
const PREVIEW_LINES = 40
const MAX_CODE_BYTES = 200_000

export interface PendingExtension {
  name: string
  file: string
  lines: number
  bytes: number
  /** 首若干行，确认卡片直接用它 */
  preview: string
  truncated: boolean
}

function toPendingView(file: string): PendingExtension {
  const src = readFileSync(file, 'utf-8')
  const all = src.split(/\r?\n/)
  return {
    name: path.basename(file).replace(/\.js$/, ''),
    file,
    lines: all.length,
    bytes: Buffer.byteLength(src),
    preview: all.slice(0, PREVIEW_LINES).join('\n'),
    truncated: all.length > PREVIEW_LINES,
  }
}

export function listPendingExtensions(dir: string): PendingExtension[] {
  if (!existsSync(dir)) return []
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.js'))
  } catch {
    return []
  }
  return files.sort().map((f) => toPendingView(path.join(dir, f)))
}

export function writePendingExtension(dir: string, input: { name: string; code: string }): { ok: boolean; reason: string; file?: string } {
  const name = input.name.trim()
  if (!NAME_RE.test(name)) return { ok: false, reason: `名字「${name}」不合法：只能小写字母、数字、连字符` }
  const code = input.code
  if (!code.trim()) return { ok: false, reason: '源码是空的' }
  if (Buffer.byteLength(code) > MAX_CODE_BYTES) return { ok: false, reason: `源码超过 ${MAX_CODE_BYTES} 字节，不接受这么大的扩展` }
  const file = path.join(dir, `${name}.js`)
  if (existsSync(file)) return { ok: false, reason: `待审区已有「${name}」，要改就先删掉它` }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, code.endsWith('\n') ? code : code + '\n', 'utf-8')
  const v = toPendingView(file)
  return { ok: true, reason: `已写入待审区（${v.lines} 行）`, file }
}

export function removePendingExtension(dir: string, name: string): { ok: boolean; reason: string } {
  if (!NAME_RE.test(name)) return { ok: false, reason: `名字「${name}」不合法` }
  const file = path.join(dir, `${name}.js`)
  if (!existsSync(file)) return { ok: false, reason: `待审区没有叫「${name}」的扩展` }
  try {
    rmSync(file)
  } catch (e) {
    return { ok: false, reason: `删不掉：${(e as Error).message}` }
  }
  return { ok: true, reason: `已丢弃待审扩展「${name}」` }
}

/**
 * 启用：把文件从 pending 搬进 extensions。
 *
 * 搬（不是复制）是关键 —— 留在 pending 里的那份下次还会出现在待审列表，
 * 用户会看到同一个扩展既「已启用」又「待审」。目标同名文件已存在时拒绝覆盖：
 * 那多半是用户自己放的代码，悄悄顶掉它等于改动来路不明的东西。
 */
export function promotePendingExtension(pendingDir: string, extDir: string, name: string): { ok: boolean; reason: string } {
  if (!NAME_RE.test(name)) return { ok: false, reason: `名字「${name}」不合法` }
  const from = path.join(pendingDir, `${name}.js`)
  if (!existsSync(from)) return { ok: false, reason: `待审区没有叫「${name}」的扩展` }
  const to = path.join(extDir, `${name}.js`)
  if (existsSync(to)) return { ok: false, reason: `扩展目录里已有同名文件「${name}.js」，不覆盖` }
  mkdirSync(extDir, { recursive: true })
  try {
    renameSync(from, to)
  } catch (e) {
    return { ok: false, reason: `搬不过去：${(e as Error).message}` }
  }
  return { ok: true, reason: `已启用「${name}」，下一次对话加载它` }
}

// ---------------------------------------------------------------------------
// 解释器：占位符替换 + 两种执行
// ---------------------------------------------------------------------------

/**
/**
 * 字符串里的 {{x}} 换成参数值。
 *
 * 三种写法：{{q}} 原样替换、{{q|urlencode}} 百分号编码后替换、{{secrets:REF}} 取钥匙串。
 * 原样替换是默认，因为 URL 里该编码的清单作者会自己写 |urlencode ——
 * 悄悄替用户编码会破坏 body 里的 JSON。
 */
export function interpolate(
  text: string,
  params: Record<string, unknown>,
  secrets: (ref: string) => string | null,
): { text: string; missing: string[] } {
  const missing: string[] = []
  const out = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_all, exprRaw: string) => {
    const expr = exprRaw.trim()
    if (expr.startsWith('secrets:')) {
      const ref = expr.slice('secrets:'.length)
      const v = secrets(ref)
      if (v === null) {
        missing.push(`secrets:${ref}`)
        return ''
      }
      return v
    }
    const parts = expr.split('|').map((s) => s.trim())
    const keyRaw = parts[0] ?? ''
    const mod = parts[1]
    if (!keyRaw || !(keyRaw in params)) {
      missing.push(keyRaw || '(空)')
      return ''
    }
    const value = stringifyParam(params[keyRaw])
    return mod === 'urlencode' ? encodeURIComponent(value) : value
  })
  return { text: out, missing }
}

function stringifyParam(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export interface RunContext {
  cwd: string
  secrets: (ref: string) => string | null
  signal?: AbortSignal
}

export interface PluginRunResult {
  text: string
  details: { kind: PluginKind; status?: number; ms: number; bytes: number }
}

/** 跑一条插件工具。失败一律 throw：pi 的约定是把错误编码进异常，让回合里看得见 */
export async function runPlugin(m: PluginManifest, params: Record<string, unknown>, ctx: RunContext): Promise<PluginRunResult> {
  const started = Date.now()
  const missing: string[] = []
  const fill = (s: string) => {
    const r = interpolate(s, params, ctx.secrets)
    missing.push(...r.missing)
    return r.text
  }
  if (m.kind === 'http') {
    const impl = m.http!
    const url = fill(impl.url)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(impl.headers ?? {})) headers[fill(k)] = fill(v)
    const body = impl.body !== undefined ? fill(impl.body) : undefined
    // 占位符引用了 schema 里没有的字段：清单写错了，不能拿空串继续打后端
    if (missing.length) throw new Error(`清单里的占位符没有对应参数：${[...new Set(missing)].join('、')}`)
    const parsed = parseUrl(url)
    if (!parsed || !/^https?:/i.test(parsed.protocol)) throw new Error(`替换占位符后 URL 不合法：${url}`)
    if (body !== undefined && !headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json'
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), m.timeoutMs)
    const external = ctx.signal
    const onAbort = () => ac.abort()
    external?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetch(url, { method: impl.method, headers, body, signal: ac.signal })
      const raw = await res.text()
      const clipped = raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES) : raw
      const text = `HTTP ${res.status} ${res.statusText}\n${clipped}`
      return {
        text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text,
        details: { kind: 'http', status: res.status, ms: Date.now() - started, bytes: raw.length },
      }
    } catch (e) {
      throw new Error(`${m.name} 请求失败：${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }
  const impl = m.shell!
  const argv = impl.argv.map(fill)
  if (missing.length) throw new Error(`清单里的占位符没有对应参数：${[...new Set(missing)].join('、')}`)
  const cwd = impl.cwd === 'data' ? ctx.cwd : path.dirname(m.file)
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string; err?: Error }>((resolve) => {
    execFile(
      argv[0]!,
      argv.slice(1),
      { cwd, timeout: m.timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: false, signal: ctx.signal },
      (err, stdout, stderr) =>
        resolve({ code: err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0, stdout, stderr, err: err ?? undefined }),
    )
  })
  const text = [out.stdout, out.stderr].filter(Boolean).join('\n---stderr---\n').trim()
  if (out.err && !text) throw new Error(`${m.name} 执行失败：${out.err.message}`)
  return {
    text: (out.err ? `退出码非 0：${text || out.err.message}` : text) || '（没有任何输出）',
    details: { kind: 'shell', status: out.code ?? undefined, ms: Date.now() - started, bytes: text.length },
  }
}
