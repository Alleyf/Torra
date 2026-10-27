/**
 * Torra 对话内交互视图协议。
 *
 * 模型只在 ```torra-ui 代码块里输出 JSON，渲染层按白名单投影成 React 组件。
 * html 块会被放进无同源权限的 sandbox iframe 中执行。
 */

export const TORRA_UI_FENCE = 'torra-ui'
export const TORRA_UI_MAX_BYTES = 256 * 1024

const MAX_BLOCKS = 6
const MAX_METRICS = 8
const MAX_CHART_ITEMS = 12
const MAX_LINE_POINTS = 50
const MAX_TABLE_COLUMNS = 6
const MAX_TABLE_ROWS = 50
const MAX_HTML_BYTES = 128 * 1024
const MIN_HTML_HEIGHT = 160
const MAX_HTML_HEIGHT = 800
const DEFAULT_HTML_HEIGHT = 320
const MAX_ACTIONS = 4

export type TorraUiMetric = {
  label: string
  value: string
  hint?: string
}

export type TorraUiChartItem = {
  label: string
  value: number
  detail?: string
}

export type TorraUiLinePoint = {
  label: string
  value: number
}

export type TorraUiMetricsBlock = {
  type: 'metrics'
  title?: string
  items: TorraUiMetric[]
}

export type TorraUiBarBlock = {
  type: 'bar'
  title?: string
  items: TorraUiChartItem[]
}

export type TorraUiLineBlock = {
  type: 'line'
  title?: string
  points: TorraUiLinePoint[]
}

export type TorraUiDonutBlock = {
  type: 'donut'
  title?: string
  items: TorraUiChartItem[]
}

export type TorraUiTableBlock = {
  type: 'table'
  title?: string
  columns: string[]
  rows: string[][]
}

export type TorraUiHtmlBlock = {
  type: 'html'
  title?: string
  html: string
  height?: number
}

export type TorraUiBlock =
  | TorraUiMetricsBlock
  | TorraUiBarBlock
  | TorraUiLineBlock
  | TorraUiDonutBlock
  | TorraUiTableBlock
  | TorraUiHtmlBlock

export type TorraUiAction = {
  label: string
  prompt: string
}

export type TorraUiDocument = {
  version: 1
  title?: string
  description?: string
  blocks: TorraUiBlock[]
  actions?: TorraUiAction[]
}

export type TorraUiParseResult =
  | { ok: true; value: TorraUiDocument }
  | { ok: false; reason: string }

export type TorraUiFence = {
  content: string
  closed: boolean
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*torra-ui(?:[ \t]+[^\r\n]*)?$/i
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/

class UiShapeError extends Error {}

function fail(path: string, message: string): never {
  throw new UiShapeError(`${path} ${message}`)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是对象')
  return value as Record<string, unknown>
}

function array(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) fail(path, '必须是数组')
  if (value.length < min || value.length > max) {
    fail(path, `数量必须在 ${min}-${max} 之间`)
  }
  return value
}

function text(value: unknown, path: string, max: number, required = true): string | undefined {
  if (value == null) {
    if (required) fail(path, '不能为空')
    return undefined
  }
  if (typeof value !== 'string') fail(path, '必须是字符串')
  const out = value.trim()
  if (required && !out) fail(path, '不能为空')
  if (out.length > max) fail(path, `长度不能超过 ${max}`)
  if (CONTROL_CHARS.test(out)) fail(path, '包含控制字符')
  return out
}

function number(value: unknown, path: string, nonNegative = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '必须是有限数字')
  if (nonNegative && value < 0) fail(path, '不能为负数')
  return value
}

function optionalText(value: unknown, path: string, max: number): string | undefined {
  return text(value, path, max, false)
}

function htmlSource(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, '必须是字符串')
  if (!value.trim()) fail(path, '不能为空')
  if (new TextEncoder().encode(value).length > MAX_HTML_BYTES) {
    fail(path, `不能超过 ${MAX_HTML_BYTES} 字节`)
  }
  if (CONTROL_CHARS.test(value)) fail(path, '包含控制字符')
  return value
}

function htmlHeight(value: unknown, path: string): number {
  if (value == null) return DEFAULT_HTML_HEIGHT
  const height = number(value, path)
  if (!Number.isInteger(height) || height < MIN_HTML_HEIGHT || height > MAX_HTML_HEIGHT) {
    fail(path, `必须是 ${MIN_HTML_HEIGHT}-${MAX_HTML_HEIGHT} 之间的整数`)
  }
  return height
}

function guardJsonSafety(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  while (stack.length) {
    const current = stack.pop()!
    if (!current.value || typeof current.value !== 'object') continue
    if (current.depth > 12) fail('UI', 'JSON 嵌套过深')
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 })
      continue
    }
    for (const [key, item] of Object.entries(current.value)) {
      if (DANGEROUS_KEYS.has(key)) fail('UI', `不允许字段 ${key}`)
      stack.push({ value: item, depth: current.depth + 1 })
    }
  }
}

function parseMetric(value: unknown, path: string): TorraUiMetric {
  const row = record(value, path)
  const hint = optionalText(row.hint, `${path}.hint`, 80)
  return {
    label: text(row.label, `${path}.label`, 60)!,
    value: text(row.value, `${path}.value`, 40)!,
    ...(hint ? { hint } : {}),
  }
}

function parseChartItem(value: unknown, path: string): TorraUiChartItem {
  const row = record(value, path)
  const detail = optionalText(row.detail, `${path}.detail`, 60)
  return {
    label: text(row.label, `${path}.label`, 60)!,
    value: number(row.value, `${path}.value`),
    ...(detail ? { detail } : {}),
  }
}

function parseLinePoint(value: unknown, path: string): TorraUiLinePoint {
  const row = record(value, path)
  return {
    label: text(row.label, `${path}.label`, 60)!,
    value: number(row.value, `${path}.value`),
  }
}

function parseBlock(value: unknown, path: string): TorraUiBlock | null {
  const row = record(value, path)
  const type = text(row.type, `${path}.type`, 20)!
  const title = optionalText(row.title, `${path}.title`, 80)

  if (type === 'metrics') {
    return {
      type,
      ...(title ? { title } : {}),
      items: array(row.items, `${path}.items`, 1, MAX_METRICS).map((item, i) =>
        parseMetric(item, `${path}.items[${i}]`),
      ),
    }
  }
  if (type === 'bar' || type === 'donut') {
    const items = array(row.items, `${path}.items`, 1, MAX_CHART_ITEMS).map((item, i) =>
      parseChartItem(item, `${path}.items[${i}]`),
    )
    if (type === 'donut' && items.every((item) => item.value === 0)) {
      fail(`${path}.items`, '环形图至少需要一个大于 0 的值')
    }
    return { type, ...(title ? { title } : {}), items }
  }
  if (type === 'line') {
    const points = row.points ?? row.items
    return {
      type,
      ...(title ? { title } : {}),
      points: array(points, `${path}.points`, 2, MAX_LINE_POINTS).map((point, i) =>
        parseLinePoint(point, `${path}.points[${i}]`),
      ),
    }
  }
  if (type === 'table') {
    const columns = array(row.columns, `${path}.columns`, 1, MAX_TABLE_COLUMNS).map((column, i) =>
      text(column, `${path}.columns[${i}]`, 80)!,
    )
    const rows = array(row.rows, `${path}.rows`, 0, MAX_TABLE_ROWS).map((line, rowIndex) => {
      const cells = array(line, `${path}.rows[${rowIndex}]`, columns.length, columns.length)
      return cells.map((cell, cellIndex) => text(cell, `${path}.rows[${rowIndex}][${cellIndex}]`, 160, false) ?? '')
    })
    return { type, ...(title ? { title } : {}), columns, rows }
  }
  if (type === 'html') {
    return {
      type,
      ...(title ? { title } : {}),
      html: htmlSource(row.html, `${path}.html`),
      height: htmlHeight(row.height, `${path}.height`),
    }
  }

  // 新版本可能增加块类型。旧客户端跳过，不把未知结构带进 DOM。
  return null
}

export function parseTorraUi(raw: string): TorraUiParseResult {
  if (typeof raw !== 'string') return { ok: false, reason: '交互视图内容必须是文本' }
  if (new TextEncoder().encode(raw).length > TORRA_UI_MAX_BYTES) {
    return { ok: false, reason: '交互视图数据过大' }
  }
  const source = raw.trim()
  if (!source) return { ok: false, reason: '交互视图内容为空' }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return { ok: false, reason: '交互视图 JSON 无效' }
  }

  try {
    guardJsonSafety(parsed)
    const root = record(parsed, 'UI')
    if (root.version !== 1) fail('UI.version', '仅支持 1')
    const title = optionalText(root.title, 'UI.title', 80)
    const description = optionalText(root.description, 'UI.description', 240)
    const blocks = array(root.blocks, 'UI.blocks', 1, MAX_BLOCKS)
      .map((block, i) => parseBlock(block, `UI.blocks[${i}]`))
      .filter((block): block is TorraUiBlock => block !== null)
    if (blocks.length === 0) fail('UI.blocks', '没有可渲染的块')

    const actions = root.actions == null
      ? undefined
      : array(root.actions, 'UI.actions', 0, MAX_ACTIONS).map((action, i) => {
          const item = record(action, `UI.actions[${i}]`)
          return {
            label: text(item.label, `UI.actions[${i}].label`, 40)!,
            prompt: text(item.prompt, `UI.actions[${i}].prompt`, 300)!,
          }
        })

    return {
      ok: true,
      value: {
        version: 1,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        blocks,
        ...(actions && actions.length ? { actions } : {}),
      },
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof UiShapeError ? error.message : '交互视图结构无效',
    }
  }
}

/**
 * 扫描协议围栏，保留未闭合的最后一块，供流式渲染显示“正在生成”。
 */
export function extractTorraUiFences(source: string): TorraUiFence[] {
  if (!source) return []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: TorraUiFence[] = []
  let open: { char: string; length: number; content: string[] } | null = null

  for (const line of lines) {
    if (!open) {
      const match = OPEN_FENCE.exec(line)
      if (!match) continue
      const marker = match[1] ?? ''
      open = { char: marker[0] ?? '`', length: marker.length, content: [] }
      continue
    }

    const close = new RegExp(`^ {0,3}${open.char === '`' ? '`' : '~'}{${open.length},}[ \\t]*$`)
    if (close.test(line)) {
      out.push({ content: open.content.join('\n'), closed: true })
      open = null
      continue
    }
    open.content.push(line)
  }

  if (open) out.push({ content: open.content.join('\n'), closed: false })
  return out
}

export function hasUnclosedTorraUiFence(source: string): boolean {
  return extractTorraUiFences(source).some((fence) => !fence.closed)
}

/** 复制回答时移除协议块，普通 Markdown 代码块原样保留。 */
export function stripTorraUiBlocks(source: string): string {
  if (!source) return ''
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  let open: { char: string; length: number } | null = null

  for (const line of lines) {
    if (!open) {
      const match = OPEN_FENCE.exec(line)
      if (match) {
        const marker = match[1] ?? ''
        open = { char: marker[0] ?? '`', length: marker.length }
        continue
      }
      kept.push(line)
      continue
    }

    const close = new RegExp(`^ {0,3}${open.char === '`' ? '`' : '~'}{${open.length},}[ \\t]*$`)
    if (close.test(line)) open = null
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
