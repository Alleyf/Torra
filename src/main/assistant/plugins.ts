/**
 * 自建工具：一条工具 = 一份清单，解释器只有一个。
 *
 * 清单与脚本扩展是**同一种格式**：kind=http/shell/memory 的实现是数据，
 * kind=js 的实现是同目录同名的 <name>.js。写入、装载、确认、删除都走同一条路，
 * 差别只在信任级别 —— 数据写完下一次装配就能用；代码先落待审区，人看过源码才启用。
 *
 * 为什么不让脚本直接当 pi 扩展：pi 扩展能绕开工具层的一切约束（钩子、任意代码、
 * 自己注册工具），而这里换来的是「助手自己造的工具也逃不出这一个解释器」——
 * 名称、参数 schema、确认策略都由清单定，脚本只实现 run(params, ctx)。
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
import {
  MEMORY_FILE_RE,
  MEMORY_TOP_K_DEFAULT,
  MEMORY_TOP_K_MAX,
  MEMORY_TOP_K_MIN,
  clampMemoryTopK,
  isMemoryMode,
  type MemoryMode,
  type MemorySearchOutcome,
} from '../../shared/memory'
import { Type, type JsonSchema } from '../../shared/tool'

/** 清单文件名后缀：一个插件一个文件，文件名就是它的身份 */
export const PLUGIN_SUFFIX = '.plugin.json'
/** 回给模型的文本上限，和 tools.ts 的 MAX_TEXT 同量级 */
const MAX_TEXT = 8000
/** 响应体读取硬上限：超了直接截断，防止一个接口把上下文窗口灌满 */
const MAX_BODY_BYTES = 200_000
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 120_000

export type PluginKind = 'http' | 'shell' | 'memory' | 'js'
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

/**
 * 记忆库插件的实现段：只指一个本地 .mv2，不写查询逻辑。
 *
 * 为什么不给 parameters：检索的参数永远只有「查什么、要几条」，由解释器固定生成；
 * 允许清单自填 schema 就会出现「清单声明一套、解释器按另一套取参」的静默错位。
 */
export interface MemoryImpl {
  file: string
  mode: MemoryMode
  topK: number
}

/** kind=memory 的工具参数：清单不能改它，见 MemoryImpl 的说明 */
export const MEMORY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要检索的内容（自然语言或关键词都行）' },
    topK: { type: 'integer', description: `返回几条结果，1-${MEMORY_TOP_K_MAX}，默认 ${MEMORY_TOP_K_DEFAULT}` },
  },
  required: ['query'],
}

export interface PluginManifest {
  name: string
  label: string
  description: string
  kind: PluginKind
  parameters: Record<string, unknown>
  http?: HttpImpl
  shell?: ShellImpl
  memory?: MemoryImpl
  /** kind=js：与清单同目录、同名的源码文件（装载时填） */
  codeFile?: string
  /** kind=js：源码行数，设置页卡片用 */
  lines?: number
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

/** 默认确认策略：写操作、本地命令和脚本必须问，GET/HEAD 与只读检索放行 */
function defaultConfirm(kind: PluginKind, method: string): PluginConfirm {
  if (kind === 'shell' || kind === 'js') return 'always'
  if (kind === 'memory') return 'never'
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

  const kindRaw = str(raw.kind)
  const kind: PluginKind | null =
    kindRaw === 'http' || kindRaw === 'shell' || kindRaw === 'memory' || kindRaw === 'js' ? kindRaw : null
  if (!kind) {
    errors.push(`kind 只能是 'http' / 'shell' / 'memory' / 'js'，现在是「${kindRaw || '(空)'}」`)
  }

  const parameters = raw.parameters
  if (kind === 'memory') {
    // 参数由解释器固定生成（query / topK），清单自己再写一份只会两边说法不一致
    if (parameters !== undefined) errors.push('kind=memory 不接受 parameters：query / topK 由 Torra 生成')
  } else if (!isPlainObject(parameters) || parameters.type !== 'object') {
    errors.push("parameters 必须是 { type: 'object', properties: {...} } 形式的 JSON Schema")
  } else {
    errors.push(...checkJsonSchema(parameters))
  }

  let http: HttpImpl | undefined
  let shell: ShellImpl | undefined
  let memory: MemoryImpl | undefined
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
  } else if (kind === 'memory') {
    const mem = raw.memory
    if (!isPlainObject(mem)) {
      errors.push('kind=memory 需要 memory 段：{ file: "<名字>.mv2" }')
    } else {
      const file = str(mem.file).trim()
      if (!MEMORY_FILE_RE.test(file)) {
        errors.push(`memory.file 必须是 <名字>.mv2 形式的记忆库文件名，现在是「${file || '(空)'}」`)
      }
      const modeRaw = mem.mode === undefined ? 'auto' : str(mem.mode)
      if (!isMemoryMode(modeRaw)) errors.push("memory.mode 只能是 'auto' / 'lex' / 'sem'")
      let topK = MEMORY_TOP_K_DEFAULT
      if (mem.topK !== undefined) {
        const n = Number(mem.topK)
        if (!Number.isInteger(n) || n < MEMORY_TOP_K_MIN || n > MEMORY_TOP_K_MAX) {
          errors.push(`memory.topK 得是 ${MEMORY_TOP_K_MIN} 到 ${MEMORY_TOP_K_MAX} 之间的整数`)
        } else topK = n
      }
      memory = { file, mode: isMemoryMode(modeRaw) ? modeRaw : 'auto', topK: clampMemoryTopK(topK) }
    }
  } else if (kind === 'js') {
    // 源码位置由名字定死：清单里再写一个 file 只会出现「清单说 A、装载器找 B」的错位
    if (raw.js !== undefined) {
      if (!isPlainObject(raw.js)) {
        errors.push('js 段必须是一个对象；源码固定叫 <名字>.js，可以不写这一段')
      } else {
        const jsFile = str(raw.js.file).trim()
        if (jsFile && jsFile !== `${name}.js`) {
          errors.push(`js.file 只能是「${name}.js」：源码位置由工具名定死，不另外指路`)
        }
      }
    }
  }

  const confirm = str(raw.confirm)
  if (confirm && !['always', 'once', 'never'].includes(confirm)) {
    errors.push("confirm 只能是 'always' / 'once' / 'never'")
  }
  /*
   * shell 和 js 都不许自填 'never'。argv[0] 由清单定死、执行不过 shell 解析，但**参数是模型写的**：
   * 「一次调用不询问就 execFile 一个本机二进制 / 跑一段脚本」和 http 的同类豁免不是一个量级 ——
   * 前者能写盘、能删数据，后者最多发个请求。默认值本来就是 'always'，可只要允许手写覆盖，
   * 自我装配那条路径上模型就能把「问一次」写成「永远不问」，把闸门自己关掉。
   */
  if ((kind === 'shell' || kind === 'js') && confirm === 'never') {
    errors.push(`kind=${kind} 的 confirm 不能是 'never'：参数来自模型，每次都要人确认；要免确认请改成 http 插件`)
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
      parameters:
        kind === 'memory' ? MEMORY_TOOL_PARAMETERS : (parameters as Record<string, unknown>),
      http,
      shell,
      memory,
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
 * JSON Schema 子集 → Torra 的参数说明（一份纯 JSON Schema）。
 *
 * 只认校验里已经过一遍的那几种类型；额外塞的东西（format、pattern、anyOf）
 * 一律拒绝，因为「清单写了但被静默忽略」比「编译失败」危险得多 ——
 * 作者以为加了 ^\\d+$ 的约束，实际模型传什么都行。
 *
 * 产物是纯 JSON Schema：pi 收下它（它的校验认 JSON Schema 这一支），
 * MCP 也收下它（MCP 的原生形态就是这个）。中间不再经过任何 TypeBox。
 */
export function compileParameters(schema: Record<string, unknown>): JsonSchema {
  return compileObject(schema)
}

function compileObject(schema: Record<string, unknown>): JsonSchema {
  const props = schema.properties as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : [])
  const shape: Record<string, JsonSchema> = {}
  for (const [key, sub] of Object.entries(props)) {
    const node = compileNode(sub, `parameters.properties.${key}`)
    shape[key] = required.has(key) ? node : Type.Optional(node)
  }
  // 默认关掉未知字段：模型多塞一个参数时，宁可报 schema 错也不要它以为生效了。
  // 只有清单显式写 additionalProperties: true 才放行 —— 真值判断而不是取反，
  // 省得写成字符串/缺省时反而变成「全放开」。
  return Type.Object(shape, { additionalProperties: schema.additionalProperties === true })
}

function compileNode(sub: Record<string, unknown>, where: string): JsonSchema {
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
    return Type.Array(compileNode(items, `${where}.items`), opts)
  }
  if (t === 'object') {
    if (!isPlainObject(sub.properties)) throw new Error(`${where} 是 object 但没有 properties`)
    return compileObject(sub)
  }
  throw new Error(`${where} 的 type「${t}」编译不了`)
}

// ---------------------------------------------------------------------------
// 磁盘读写
// ---------------------------------------------------------------------------

export function pluginsDirOf(dataDir: string): string {
  return path.join(dataDir, 'pi', 'plugins')
}

/** kind=js 的源码文件名：由工具名定死，清单里不另存路径 */
export function codeFileOf(dir: string, name: string): string {
  return path.join(dir, `${name}.js`)
}

/** 源码太长不放进卡片：行数 + 首若干行，剩下的看文件 */
const PREVIEW_LINES = 40
const MAX_CODE_BYTES = 200_000

/** 读一份脚本的行数与字节数；读不出来或超限就带上原因 */
function readScript(file: string): { ok: true; lines: number; bytes: number; src: string } | { ok: false; reason: string } {
  let src = ''
  try {
    src = readFileSync(file, 'utf-8')
  } catch (e) {
    return { ok: false, reason: `源码读不出来：${(e as Error).message}` }
  }
  const bytes = Buffer.byteLength(src)
  if (!src.trim()) return { ok: false, reason: '源码是空的' }
  if (bytes > MAX_CODE_BYTES) return { ok: false, reason: `源码超过 ${MAX_CODE_BYTES} 字节，不接受这么大的脚本` }
  return { ok: true, lines: src.split(/\r?\n/).length, bytes, src }
}

/**
 * 读整个目录：有效的进列表，无效的单独带原因 —— 静默丢掉一条清单是最难查的。
 *
 * kind=js 的源码也在这一步读：清单和源码是同一个工具的两半，缺一半就不该注册，
 * 否则设置页会显示一个「已生效」但一调就炸的工具。
 */
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
    const m = entry.manifest
    if (seen.has(m.name)) {
      invalid.push({ ok: false, name: m.name, file, errors: ['已有同名插件：一个名字只能有一条清单'] })
      continue
    }
    if (m.kind === 'js') {
      const codeFile = codeFileOf(dir, m.name)
      if (!existsSync(codeFile)) {
        invalid.push({ ok: false, name: m.name, file, errors: [`kind=js 但缺少源码文件：${codeFile}`] })
        continue
      }
      const s = readScript(codeFile)
      if (!s.ok) {
        invalid.push({ ok: false, name: m.name, file, errors: [s.reason] })
        continue
      }
      m.codeFile = codeFile
      m.lines = s.lines
    }
    if (!m.enabled) continue
    seen.add(m.name)
    manifests.push(m)
  }
  return { manifests, invalid }
}

/** 一条工具给设置页看的视图；loaded 来自最近一次会话装配 */
export function toPluginView(m: PluginManifest, loaded: boolean): PluginView {
  return {
    name: m.name,
    label: m.label,
    description: m.description,
    kind: m.kind,
    confirm: m.confirm,
    enabled: m.enabled,
    file: m.file,
    ...(m.codeFile ? { codeFile: m.codeFile } : {}),
    ...(m.lines !== undefined ? { lines: m.lines } : {}),
    loaded,
  }
}

/**
 * 写一条工具：先校验再落盘，非法清单一律不写。
 *
 * kind=js 必须同时给源码；普通工具给了源码就判错 —— 一条清单只描述一个实现，
 * 「清单是 http、旁边却躺着一份脚本」正是这次合并要消掉的那种歧义。
 */
export function writePluginManifest(
  dir: string,
  raw: unknown,
  code?: string,
): { ok: boolean; reason: string; file?: string; pending?: boolean } {
  return writeToolPair(dir, raw, code, false)
}

/** 待审区：同样的清单 + 源码，只是人还没看过 */
export function writePendingPlugin(dir: string, raw: unknown, code?: string): { ok: boolean; reason: string; file?: string; pending?: boolean } {
  return writeToolPair(dir, raw, code, true)
}

function writeToolPair(
  dir: string,
  raw: unknown,
  code: string | undefined,
  pending: boolean,
): { ok: boolean; reason: string; file?: string; pending?: boolean } {
  const name = str(isPlainObject(raw) ? raw.name : undefined).trim()
  if (!name) return { ok: false, reason: '清单必须带 name' }
  if (!NAME_RE.test(name)) return { ok: false, reason: `名字「${name}」不合法：只能小写字母、数字、连字符` }
  const file = path.join(dir, `${name}${PLUGIN_SUFFIX}`)
  const entry = validateManifest(raw, file)
  if (!entry.ok) return { ok: false, reason: entry.errors.join('；') }
  const isJs = entry.manifest.kind === 'js'
  let src = ''
  if (isJs) {
    src = typeof code === 'string' ? code : ''
    if (!src.trim()) return { ok: false, reason: `kind=js 需要同时给出源码：module.exports = async function run(params, ctx) { … }` }
    if (Buffer.byteLength(src) > MAX_CODE_BYTES) return { ok: false, reason: `源码超过 ${MAX_CODE_BYTES} 字节，不接受这么大的脚本` }
  } else if (code !== undefined && String(code).trim()) {
    return { ok: false, reason: '只有 kind=js 才附带源码；其它种类的实现写在清单里' }
  }
  const codeFile = codeFileOf(dir, name)
  if (existsSync(file) || (isJs && existsSync(codeFile))) {
    return { ok: false, reason: `工具「${name}」已经存在，要改就先删掉它` }
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
  if (isJs) writeFileSync(codeFile, src.endsWith('\n') ? src : src + '\n', 'utf-8')
  const lines = isJs ? src.split(/\r?\n/).length : 0
  return {
    ok: true,
    reason: pending ? `已写入待审区（${lines} 行源码）` : `已写入 ${name}`,
    file,
    ...(pending ? { pending: true } : {}),
  }
}

/** 删一条工具：清单和它的源码一起删；只删清单会留下一份没人认领的脚本 */
export function removePluginManifest(dir: string, name: string): { ok: boolean; reason: string } {
  if (!NAME_RE.test(name)) return { ok: false, reason: `名字「${name}」不合法` }
  const file = path.join(dir, `${name}${PLUGIN_SUFFIX}`)
  if (!existsSync(file)) return { ok: false, reason: `没有叫「${name}」的工具清单` }
  const codeFile = codeFileOf(dir, name)
  const hasCode = existsSync(codeFile)
  try {
    rmSync(file)
    if (hasCode) rmSync(codeFile)
  } catch (e) {
    return { ok: false, reason: `删不掉：${(e as Error).message}` }
  }
  return { ok: true, reason: `已删除工具「${name}」（${hasCode ? '清单与源码' : '清单'}一起删）` }
}

// ---------------------------------------------------------------------------
// 待审区：同一种格式，只是人还没看过源码
// ---------------------------------------------------------------------------

/**
 * 待审目录。
 *
 * 为什么代码要先落这里：kind=js 的脚本会直接跑进主进程，助手写出来的东西绝不能
 * 落进装载目录就自动生效。放在 pending 里它只是一个普通文件，读它、审它、删它都安全；
 * 要生效必须由人在设置页看过源码点「启用」，那一步做的是把清单和源码一起搬进去。
 *
 * 卡片上放的是源码本身，不是助手对源码的描述 —— 让被审查者写审查意见不叫审查。
 */
export function pendingDirOf(dataDir: string): string {
  return path.join(dataDir, 'pi', 'pending')
}

/** 旧版独立扩展目录：只用来在设置页提示「这些文件已不再加载」，不再从它装载任何东西 */
export function legacyExtensionsDirOf(dataDir: string): string {
  return path.join(dataDir, 'pi', 'extensions')
}

export function listLegacyExtensions(dir: string): Array<{ name: string; file: string }> {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .sort()
      .map((f) => ({ name: f.replace(/\.js$/, ''), file: path.join(dir, f) }))
  } catch {
    return []
  }
}

/** 待审区里的一条工具：清单 + 可选源码，附预览 */
export interface PendingPlugin {
  name: string
  file: string
  kind: PluginKind
  label: string
  description: string
  codeFile?: string
  lines: number
  bytes: number
  preview: string
  truncated: boolean
}

export function listPendingPlugins(dir: string): { pending: PendingPlugin[]; invalid: InvalidPlugin[] } {
  const pending: PendingPlugin[] = []
  const invalid: InvalidPlugin[] = []
  if (!existsSync(dir)) return { pending, invalid }
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(PLUGIN_SUFFIX))
  } catch {
    return { pending, invalid }
  }
  for (const f of files.sort()) {
    const file = path.join(dir, f)
    let entry: PluginEntry
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8'))
      entry = validateManifest(raw, file)
    } catch (e) {
      invalid.push({ ok: false, name: f.replace(new RegExp(`${PLUGIN_SUFFIX}$`), ''), file, errors: [`JSON 解析失败：${(e as Error).message}`] })
      continue
    }
    if (!entry.ok) {
      invalid.push(entry)
      continue
    }
    const m = entry.manifest
    let lines = 0
    let bytes = 0
    let preview = ''
    let truncated = false
    let codeFile: string | undefined
    if (m.kind === 'js') {
      codeFile = codeFileOf(dir, m.name)
      if (!existsSync(codeFile)) {
        invalid.push({ ok: false, name: m.name, file, errors: [`kind=js 但缺少源码文件：${codeFile}`] })
        continue
      }
      const s = readScript(codeFile)
      if (!s.ok) {
        invalid.push({ ok: false, name: m.name, file, errors: [s.reason] })
        continue
      }
      const all = s.src.split(/\r?\n/)
      lines = s.lines
      bytes = s.bytes
      preview = all.slice(0, PREVIEW_LINES).join('\n')
      truncated = all.length > PREVIEW_LINES
    } else {
      // 数据类清单一般不走待审；万一被放进来，审查对象就是清单原文
      const text = JSON.stringify(raw, null, 1)
      const all = text.split('\n')
      lines = all.length
      bytes = Buffer.byteLength(text)
      preview = all.slice(0, PREVIEW_LINES).join('\n')
      truncated = all.length > PREVIEW_LINES
    }
    pending.push({
      name: m.name,
      file,
      kind: m.kind,
      label: m.label,
      description: m.description,
      ...(codeFile ? { codeFile } : {}),
      lines,
      bytes,
      preview,
      truncated,
    })
  }
  return { pending, invalid }
}

export function removePendingPlugin(dir: string, name: string): { ok: boolean; reason: string } {
  if (!NAME_RE.test(name)) return { ok: false, reason: `名字「${name}」不合法` }
  const file = path.join(dir, `${name}${PLUGIN_SUFFIX}`)
  if (!existsSync(file)) return { ok: false, reason: `待审区没有叫「${name}」的工具` }
  const codeFile = codeFileOf(dir, name)
  try {
    rmSync(file)
    if (existsSync(codeFile)) rmSync(codeFile)
  } catch (e) {
    return { ok: false, reason: `删不掉：${(e as Error).message}` }
  }
  return { ok: true, reason: `已丢弃待审工具「${name}」` }
}

/**
 * 启用：把清单（和源码）从待审区搬进工具目录。
 *
 * 搬（不是复制）是关键 —— 留在待审里的那份下次还会出现在列表里，
 * 用户会看到同一个工具既「已启用」又「待审」。目标同名文件已存在时拒绝覆盖：
 * 那多半是用户自己放的清单，悄悄顶掉它等于改动来路不明的东西。
 * 源码搬失败时把清单搬回去：只搬一半会让一个 kind=js 工具永久缺源码、每次装配都报错。
 */
export function promotePendingPlugin(pendingDir: string, toolsDir: string, name: string): { ok: boolean; reason: string } {
  if (!NAME_RE.test(name)) return { ok: false, reason: `名字「${name}」不合法` }
  const fromManifest = path.join(pendingDir, `${name}${PLUGIN_SUFFIX}`)
  if (!existsSync(fromManifest)) return { ok: false, reason: `待审区没有叫「${name}」的工具` }
  let entry: PluginEntry
  try {
    entry = validateManifest(JSON.parse(readFileSync(fromManifest, 'utf-8')), fromManifest)
  } catch (e) {
    return { ok: false, reason: `待审清单读不出来：${(e as Error).message}` }
  }
  if (!entry.ok) return { ok: false, reason: `待审清单不合法：${entry.errors.join('；')}` }
  const isJs = entry.manifest.kind === 'js'
  const fromCode = codeFileOf(pendingDir, name)
  if (isJs && !existsSync(fromCode)) return { ok: false, reason: `待审区缺少源码文件：${fromCode}` }
  const toManifest = path.join(toolsDir, `${name}${PLUGIN_SUFFIX}`)
  const toCode = codeFileOf(toolsDir, name)
  if (existsSync(toManifest) || (isJs && existsSync(toCode))) {
    return { ok: false, reason: `工具目录里已有同名工具「${name}」，不覆盖` }
  }
  mkdirSync(toolsDir, { recursive: true })
  try {
    renameSync(fromManifest, toManifest)
  } catch (e) {
    return { ok: false, reason: `搬不过去：${(e as Error).message}` }
  }
  if (isJs) {
    try {
      renameSync(fromCode, toCode)
    } catch (e) {
      // 只搬一半就会留下一个缺源码的 kind=js 清单，每次装配都报错 —— 宁可整体退回
      let rolledBack = false
      try {
        renameSync(toManifest, fromManifest)
        rolledBack = true
      } catch {
        /* 回滚失败时下面把真实路径写进原因 */
      }
      return {
        ok: false,
        reason: `源码搬不过去：${(e as Error).message}（清单${rolledBack ? '已搬回待审区' : `停在 ${toManifest}，请手动移回`}）`,
      }
    }
  }
  return { ok: true, reason: `已启用「${name}」，下一次对话加载它` }
}

// ---------------------------------------------------------------------------
// 解释器：占位符替换 + 四种实现（http / shell / memory / js）
// ---------------------------------------------------------------------------

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

/**
 * 记忆库检索的最小接口。插件层不依赖 memory/service.ts —— session 层把那一面传进来，
 * 解释器和托管服务各自可测。
 */
export interface MemoryQuery {
  search(input: {
    file: string
    query: string
    topK?: number
    mode?: MemoryMode
    signal?: AbortSignal
  }): Promise<MemorySearchOutcome>
}

export interface RunContext {
  cwd: string
  secrets: (ref: string) => string | null
  signal?: AbortSignal
  /** kind=memory 的插件靠它检索；没装配时会明确报错而不是静默返回空 */
  memory?: MemoryQuery
}

export interface PluginRunResult {
  text: string
  details: { kind: PluginKind; status?: number; ms: number; bytes: number }
}

/** kind=js 的脚本拿到的上下文：钥匙串取值、清单所在目录、取消信号 */
export interface JsRunContext {
  secrets: (ref: string) => string | null
  cwd: string
  signal?: AbortSignal
  tool: { name: string; label: string }
}

export type JsToolFn = (params: Record<string, unknown>, ctx: JsRunContext) => unknown

/**
 * 装载一份 kind=js 的源码。
 *
 * 约定是 CommonJS 的 `module.exports = async function run(params, ctx)`，也接受
 * `module.exports.run`。不写 ESM：主进程整体编译成 CommonJS，动态 import() 会被降级成
 * require，写 `export default` 的脚本反而拿不到导出。
 *
 * 每次装载前清 require 缓存：用户改完源码（或人在设置页替换了文件）下一次调用就该生效，
 * 不需要重启 Torra。
 */
export function loadJsTool(m: PluginManifest, codeFile?: string): JsToolFn {
  const file = codeFile ?? m.codeFile
  if (!file) throw new Error(`${m.name} 缺少源码文件路径`)
  let mod: unknown
  try {
    const resolved = require.resolve(file)
    delete require.cache[resolved]
    mod = require(resolved)
  } catch (e) {
    throw new Error(`${m.name} 源码装载失败：${(e as Error).message}`)
  }
  const fn = typeof mod === 'function' ? mod : isPlainObject(mod) && typeof mod.run === 'function' ? mod.run : null
  if (typeof fn !== 'function') {
    throw new Error(`${m.name} 的源码没有导出函数：需要 module.exports = async function run(params, ctx) { … }`)
  }
  return fn as JsToolFn
}

/**
 * 跑一段脚本。
 *
 * 超时与取消都经同一个 AbortController 传给脚本：脚本自己听 signal 就能提前收手，
 * 不听也不会挂住回合 —— 外面还有一层 Promise.race 兜着。
 */
async function runJsTool(
  m: PluginManifest,
  params: Record<string, unknown>,
  ctx: RunContext,
  started: number,
): Promise<PluginRunResult> {
  const fn = loadJsTool(m)
  const ac = new AbortController()
  let reason: 'timeout' | 'cancel' | null = null
  const aborted = new Promise<never>((_, reject) => {
    ac.signal.addEventListener(
      'abort',
      () => reject(new Error(reason === 'timeout' ? `超过 ${m.timeoutMs}ms 没返回` : '已被取消')),
      { once: true },
    )
  })
  const timer = setTimeout(() => {
    reason = 'timeout'
    ac.abort()
  }, m.timeoutMs)
  const onAbort = () => {
    reason ??= 'cancel'
    ac.abort()
  }
  if (ctx.signal?.aborted) onAbort()
  else ctx.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const jsCtx: JsRunContext = {
      secrets: ctx.secrets,
      cwd: path.dirname(m.file),
      signal: ac.signal,
      tool: { name: m.name, label: m.label },
    }
    // 包一层 Promise：同步 throw 和异步 reject 走同一条路
    const value = await Promise.race([Promise.resolve().then(() => fn(params, jsCtx)), aborted])
    const raw = stringifyResult(value)
    return {
      text: raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) + '…' : raw || '（没有任何输出）',
      details: { kind: 'js', ms: Date.now() - started, bytes: raw.length },
    }
  } catch (e) {
    throw new Error(`${m.name} 执行失败：${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', onAbort)
  }
}

function stringifyResult(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** 跑一条插件工具。失败一律 throw：pi 的约定是把错误编码进异常，让回合里看得见 */
export async function runPlugin(m: PluginManifest, params: Record<string, unknown>, ctx: RunContext): Promise<PluginRunResult> {
  const started = Date.now()
  if (m.kind === 'js') return runJsTool(m, params, ctx, started)
  if (m.kind === 'memory') {
    const impl = m.memory!
    const query = typeof params.query === 'string' ? params.query.trim() : ''
    if (!query) throw new Error(`${m.name} 缺少 query 参数`)
    if (!ctx.memory) throw new Error(`${m.name} 需要记忆服务，但当前会话没有装配它`)
    const topK = clampMemoryTopK(params.topK, impl.topK)
    const out = await ctx.memory.search({
      file: impl.file,
      query,
      topK,
      mode: impl.mode,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    if (!out.ok) throw new Error(`${m.name} 检索失败：${out.reason ?? '未知原因'}`)
    const text = out.text.length > MAX_TEXT ? out.text.slice(0, MAX_TEXT) + '…' : out.text
    return { text, details: { kind: 'memory', ms: Date.now() - started, bytes: out.text.length } }
  }
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
