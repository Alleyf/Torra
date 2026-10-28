/**
 * 应用插件清单的解析与校验。
 *
 * 一次把错误全列出来：装一个插件失败时，作者最烦的是「改一条报一条」。
 * 未知字段一律判错 —— 清单里写了 `hooks` 而宿主没实现，静默忽略会让作者
 * 以为中间件已经生效，最后查的是模型为什么没被改写。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  type PluginManifest,
  type PluginPermission,
  type PluginToolDecl,
} from '../../shared/plugins'

const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const TOOL_NAME_RE = /^[a-z0-9][a-z0-9_]{2,63}$/
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$|^localhost$/
const MAX_PROMPT_CHARS = 4000
const MAX_DESCRIPTION_CHARS = 1024

const TOP_KEYS = ['id', 'name', 'version', 'apiVersion', 'description', 'main', 'ui', 'permissions', 'contributes']
const CONTRIBUTES_KEYS = ['panel', 'tools', 'prompts']
const PANEL_KEYS = ['title', 'icon']
const TOOL_KEYS = ['name', 'label', 'description', 'parameters']
const PROMPT_KEYS = ['id', 'title', 'text']

export type ManifestEntry =
  | { ok: true; manifest: PluginManifest; dir: string }
  | { ok: false; id: string; dir: string; errors: string[] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 相对路径只认插件目录内部的写法：绝对路径和 `..` 都能把入口指到别处 */
function safeRelative(raw: unknown, field: string, errors: string[]): string | undefined {
  if (raw === undefined) return undefined
  const value = str(raw).trim()
  if (!value) {
    errors.push(`${field} 不能是空字符串`)
    return undefined
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    errors.push(`${field} 必须是相对插件目录的路径`)
    return undefined
  }
  const normalized = value.replace(/\\/g, '/')
  if (normalized.split('/').some((seg) => seg === '..')) {
    errors.push(`${field} 不能跳出插件目录`)
    return undefined
  }
  return normalized
}

function withinDir(dir: string, rel: string): string {
  return path.resolve(dir, rel)
}

function validPermission(raw: unknown, errors: string[]): PluginPermission | null {
  const value = str(raw).trim()
  if (!value) {
    errors.push('permissions 里有一项不是字符串')
    return null
  }
  if (value === 'storage' || value === 'panel' || value === 'tools' || value === 'secrets' || value === 'ai') return value
  if (value.startsWith('net:')) {
    const host = value.slice(4).trim().toLowerCase()
    if (!HOST_RE.test(host)) {
      errors.push(`net 权限的域名不合法：「${value}」；写 net:example.com`)
      return null
    }
    return `net:${host}`
  }
  errors.push(`不认识的能力「${value}」：只支持 storage / panel / tools / secrets / ai / net:<域名>`)
  return null
}

function checkSchemaNode(node: Record<string, unknown>, where: string, isRoot: boolean, errors: string[]): void {
  const allowed = isRoot
    ? ['type', 'properties', 'required', 'additionalProperties', 'description']
    : ['type', 'description', 'enum', 'items', 'properties', 'required', 'additionalProperties']
  const extra = Object.keys(node).filter((k) => !allowed.includes(k))
  if (extra.length) {
    errors.push(`${where} 有没实现的字段：${extra.join('、')}（只支持 type/description/enum/items/properties/required/additionalProperties）`)
  }
  const t = str(node.type)
  if (isRoot || t === 'object') {
    const props = node.properties
    if (!isPlainObject(props) || Object.keys(props).length === 0) {
      errors.push(isRoot ? 'tools[].parameters.properties 至少要有一个字段' : `${where} 声明是 object 却没有 properties`)
      return
    }
    for (const [key, sub] of Object.entries(props)) {
      if (!isPlainObject(sub)) {
        errors.push(`${where}.properties.${key} 必须是个对象`)
        continue
      }
      checkSchemaNode(sub, `${where}.properties.${key}`, false, errors)
    }
    if (isRoot && node.required !== undefined && !Array.isArray(node.required)) {
      errors.push('tools[].parameters.required 必须是数组')
    }
    return
  }
  if (t === 'array') {
    if (!isPlainObject(node.items)) {
      errors.push(`${where} 是 array，必须给出 items`)
      return
    }
    checkSchemaNode(node.items, `${where}.items`, false, errors)
    return
  }
  if (!['string', 'number', 'integer', 'boolean'].includes(t)) {
    errors.push(`${where} 的 type「${t || '(空)'}」不在支持范围内`)
  }
}

function parseTools(raw: unknown, id: string, errors: string[]): PluginToolDecl[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    errors.push('contributes.tools 必须是数组')
    return []
  }
  const out: PluginToolDecl[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    const where = `contributes.tools[${index}]`
    if (!isPlainObject(item)) {
      errors.push(`${where} 必须是对象`)
      return
    }
    const extra = Object.keys(item).filter((k) => !TOOL_KEYS.includes(k))
    if (extra.length) errors.push(`${where} 有没实现的字段：${extra.join('、')}`)
    const name = str(item.name).trim()
    if (!TOOL_NAME_RE.test(name)) {
      errors.push(`${where}.name 不合法：「${name}」；只能用小写字母、数字、下划线`)
    } else if (!name.startsWith(`${id}_`)) {
      errors.push(`${where}.name 必须以「${id}_」开头：模型看到的是全局工具名单，撞名会静默覆盖`)
    } else if (seen.has(name)) {
      errors.push(`${where}.name 重复：「${name}」`)
    }
    seen.add(name)
    const description = str(item.description).trim()
    if (!description) errors.push(`${where}.description 不能为空：模型全靠这句话决定要不要用`)
    if (description.length > MAX_DESCRIPTION_CHARS) errors.push(`${where}.description 超过 ${MAX_DESCRIPTION_CHARS} 字符`)
    const parameters = item.parameters
    if (!isPlainObject(parameters) || parameters.type !== 'object') {
      errors.push(`${where}.parameters 必须是 { type: 'object', properties: {…} }`)
    } else {
      checkSchemaNode(parameters, `${where}.parameters`, true, errors)
    }
    out.push({
      name,
      label: str(item.label).trim() || name,
      description,
      parameters: (parameters ?? {}) as Record<string, unknown>,
    })
  })
  return out
}

function parsePrompts(raw: unknown, errors: string[]): Array<{ id: string; title: string; text: string }> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    errors.push('contributes.prompts 必须是数组')
    return []
  }
  const out: Array<{ id: string; title: string; text: string }> = []
  raw.forEach((item, index) => {
    const where = `contributes.prompts[${index}]`
    if (!isPlainObject(item)) {
      errors.push(`${where} 必须是对象`)
      return
    }
    const extra = Object.keys(item).filter((k) => !PROMPT_KEYS.includes(k))
    if (extra.length) errors.push(`${where} 有没实现的字段：${extra.join('、')}`)
    const id = str(item.id).trim()
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) errors.push(`${where}.id 不合法：「${id}」`)
    const text = str(item.text).trim()
    if (!text) errors.push(`${where}.text 不能为空`)
    if (text.length > MAX_PROMPT_CHARS) errors.push(`${where}.text 超过 ${MAX_PROMPT_CHARS} 字符`)
    out.push({ id, title: str(item.title).trim() || id, text })
  })
  return out
}

/**
 * 读一个插件目录的清单。目录不存在、清单读不出来、文件缺失都在这里一次性报完。
 */
export function loadManifest(dir: string): ManifestEntry {
  const idFromDir = path.basename(path.resolve(dir))
  const errors: string[] = []
  const file = path.join(dir, PLUGIN_MANIFEST_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? `缺少 ${PLUGIN_MANIFEST_FILE}` : `读不出来：${(error as Error).message}`
    return { ok: false, id: idFromDir, dir, errors: [reason] }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, id: idFromDir, dir, errors: ['清单必须是一个 JSON 对象'] }
  }

  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.includes(k))
  if (unknown.length) errors.push(`有没实现的字段：${unknown.join('、')}（只支持 ${TOP_KEYS.join(' / ')}）`)

  const id = str(raw.id).trim()
  if (!ID_RE.test(id)) errors.push('id 只能是 2–32 位小写字母、数字、连字符')
  if (id && idFromDir !== id) errors.push(`id「${id}」和目录名「${idFromDir}」不一致：插件身份只能有一个来源`)
  const name = str(raw.name).trim()
  if (!name) errors.push('name 不能为空：界面上要有个能读的名字')
  const version = str(raw.version).trim()
  if (!VERSION_RE.test(version)) errors.push('version 要是 0.1.0 这种形式')
  const apiVersion = Number(raw.apiVersion)
  if (!Number.isInteger(apiVersion) || apiVersion !== PLUGIN_API_VERSION) {
    errors.push(`apiVersion 必须是 ${PLUGIN_API_VERSION}：版本不认识的清单不按旧字段猜`)
  }
  const description = str(raw.description).trim()
  if (!description) errors.push('description 不能为空')
  if (description.length > MAX_DESCRIPTION_CHARS) errors.push(`description 超过 ${MAX_DESCRIPTION_CHARS} 字符`)

  const main = safeRelative(raw.main, 'main', errors)
  const ui = safeRelative(raw.ui, 'ui', errors)

  const permissions: PluginPermission[] = []
  if (raw.permissions !== undefined && !Array.isArray(raw.permissions)) {
    errors.push('permissions 必须是数组')
  } else {
    for (const item of (raw.permissions as unknown[] | undefined) ?? []) {
      const p = validPermission(item, errors)
      if (p && !permissions.includes(p)) permissions.push(p)
    }
  }

  let contributes: PluginManifest['contributes'] = {}
  if (raw.contributes !== undefined) {
    if (!isPlainObject(raw.contributes)) {
      errors.push('contributes 必须是对象')
    } else {
      const extra = Object.keys(raw.contributes).filter((k) => !CONTRIBUTES_KEYS.includes(k))
      if (extra.length) errors.push(`contributes 有没实现的字段：${extra.join('、')}（只支持 panel / tools / prompts）`)
      let panel: { title: string; icon?: string } | undefined
      if (raw.contributes.panel !== undefined) {
        const p = raw.contributes.panel
        if (!isPlainObject(p)) errors.push('contributes.panel 必须是对象')
        else {
          const extraPanel = Object.keys(p).filter((k) => !PANEL_KEYS.includes(k))
          if (extraPanel.length) errors.push(`contributes.panel 有没实现的字段：${extraPanel.join('、')}`)
          const title = str(p.title).trim()
          if (!title) errors.push('contributes.panel.title 不能为空')
          panel = { title, ...(str(p.icon).trim() ? { icon: str(p.icon).trim() } : {}) }
          if (!permissions.includes('panel')) errors.push("contributes.panel 需要 permissions 里声明 'panel'")
          if (!ui) errors.push('contributes.panel 需要同时给出 ui 文档')
        }
      }
      const tools = parseTools(raw.contributes.tools, id, errors)
      if (tools.length && !permissions.includes('tools')) errors.push("contributes.tools 需要 permissions 里声明 'tools'")
      const prompts = parsePrompts(raw.contributes.prompts, errors)
      contributes = {
        ...(panel ? { panel } : {}),
        ...(tools.length ? { tools } : {}),
        ...(prompts.length ? { prompts } : {}),
      }
    }
  }

  if (main && !existsSync(withinDir(dir, main))) errors.push(`main 指向的文件不存在：${main}`)
  if (ui) {
    const uiPath = withinDir(dir, ui)
    if (!existsSync(uiPath) || !statSync(uiPath).isFile()) errors.push(`ui 指向的文件不存在：${ui}`)
  }

  if (errors.length) return { ok: false, id: id || idFromDir, dir, errors }
  return {
    ok: true,
    dir,
    manifest: {
      id,
      name,
      version,
      apiVersion,
      description,
      ...(main ? { main } : {}),
      ...(ui ? { ui } : {}),
      permissions,
      contributes,
    },
  }
}
