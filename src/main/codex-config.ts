/**
 * 窄范围 TOML 读取器：只为读取 Codex 的 ~/.codex/config.toml 中
 * [model_providers.*] / [profiles.*] 所需的子集，不引入第三方 TOML 依赖。
 *
 * 支持：注释、[table] / [table.sub]（含引号键段）、key = 基本字符串 / 字面量字符串 /
 * 布尔 / 数字 / 单行 inline table（值限字符串、数字、布尔）。
 * 数组、多行字符串等不支持的语法按出错处理 —— 位置信息足够用户自查，
 * 错误文本不含原文行内容，避免把 Codex 配置里的敏感值带进日志。
 */

/** 去掉行注释：# 只有在引号外才算注释起点 */
function stripComment(line: string): string {
  let inBasic = false
  let inLiteral = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inBasic) {
      if (ch === '\\') i++
      else if (ch === '"') inBasic = false
    } else if (inLiteral) {
      if (ch === "'") inLiteral = false
    } else if (ch === '"') inBasic = true
    else if (ch === "'") inLiteral = true
    else if (ch === '#') return line.slice(0, i)
  }
  return line
}

/** 找到引号外的第一个 '='（键与值的分界） */
function findTopLevelEquals(line: string): number {
  let inBasic = false
  let inLiteral = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inBasic) {
      if (ch === '\\') i++
      else if (ch === '"') inBasic = false
    } else if (inLiteral) {
      if (ch === "'") inLiteral = false
    } else if (ch === '"') inBasic = true
    else if (ch === "'") inLiteral = true
    else if (ch === '=') return i
  }
  return -1
}

/** 解析基本字符串（处理常见转义），start 位置指向开引号 */
function parseBasicString(line: string, start: number, lineNo: number): { value: string; end: number } {
  let out = ''
  let i = start + 1
  while (i < line.length) {
    const ch = line[i]
    if (ch === '"') return { value: out, end: i + 1 }
    if (ch === '\\') {
      const next = line[i + 1]
      if (next === 'u' || next === 'U') {
        const width = next === 'u' ? 4 : 8
        const hex = line.slice(i + 2, i + 2 + width)
        if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`第 ${lineNo} 行：无效的 Unicode 转义`)
        out += String.fromCodePoint(parseInt(hex, 16))
        i += 2 + width
        continue
      }
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }
      const mapped = next !== undefined ? map[next] : undefined
      if (mapped === undefined) throw new Error(`第 ${lineNo} 行：不支持的转义符`)
      out += mapped
      i += 2
      continue
    }
    out += ch
    i++
  }
  throw new Error(`第 ${lineNo} 行：字符串未闭合`)
}

function parseScalar(raw: string, lineNo: number): unknown {
  const v = raw.trim()
  if (v.startsWith('"')) {
    const r = parseBasicString(v, 0, lineNo)
    if (v.slice(r.end).trim()) throw new Error(`第 ${lineNo} 行：字符串后有多余内容`)
    return r.value
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1)
    if (end < 0) throw new Error(`第 ${lineNo} 行：字符串未闭合`)
    if (v.slice(end + 1).trim()) throw new Error(`第 ${lineNo} 行：字符串后有多余内容`)
    return v.slice(1, end)
  }
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^[+-]?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return Number(v.replace(/_/g, ''))
  if (v.startsWith('{')) return parseInlineTable(v, lineNo)
  // 字符串数组（Codex 的 notify 等常见配置）：值仍限字符串，忽略元素间空白与尾逗号
  if (v.startsWith('[')) return parseStringArray(v, lineNo)
  throw new Error(`第 ${lineNo} 行：暂不支持该值的写法（多行字符串、混合数组等未实现）`)
}

/** 解析单行 inline table：{ key = value, ... }，值限标量 */
function parseInlineTable(raw: string, lineNo: number): Record<string, unknown> {
  const inner = raw.trim()
  if (!inner.startsWith('{') || !inner.endsWith('}')) throw new Error(`第 ${lineNo} 行：inline table 不完整`)
  const body = inner.slice(1, -1)
  const out: Record<string, unknown> = {}
  let i = 0
  let inBasic = false
  let inLiteral = false
  let depth = 0
  let segStart = 0
  const segments: string[] = []
  while (i < body.length) {
    const ch = body[i]
    if (inBasic) {
      if (ch === '\\') i++
      else if (ch === '"') inBasic = false
    } else if (inLiteral) {
      if (ch === "'") inLiteral = false
    } else if (ch === '"') inBasic = true
    else if (ch === "'") inLiteral = true
    else if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      segments.push(body.slice(segStart, i))
      segStart = i + 1
    }
    i++
  }
  const tail = body.slice(segStart).trim()
  if (tail) segments.push(tail)
  for (const seg of segments) {
    const eq = findTopLevelEquals(seg)
    if (eq < 0) throw new Error(`第 ${lineNo} 行：inline table 缺少键值分隔`)
    const key = seg.slice(0, eq).trim().replace(/^["']|["']$/g, '')
    if (!key || key === '__proto__') throw new Error(`第 ${lineNo} 行：inline table 键名非法`)
    out[key] = parseScalar(seg.slice(eq + 1), lineNo)
  }
  return out
}

/** 解析单行字符串数组：[ "a", 'b' ]；元素限字符串（导入用不到其他元素类型） */
function parseStringArray(raw: string, lineNo: number): string[] {
  const inner = raw.trim()
  if (!inner.startsWith('[') || !inner.endsWith(']')) throw new Error(`第 ${lineNo} 行：数组不完整`)
  const body = inner.slice(1, -1)
  const out: string[] = []
  let i = 0
  while (i < body.length) {
    const ch = body[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === ',') {
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      if (ch === '"') {
        const r = parseBasicString(body, i, lineNo)
        out.push(r.value)
        i = r.end
      } else {
        const end = body.indexOf("'", i + 1)
        if (end < 0) throw new Error(`第 ${lineNo} 行：字符串未闭合`)
        out.push(body.slice(i + 1, end))
        i = end + 1
      }
      continue
    }
    throw new Error(`第 ${lineNo} 行：数组元素仅支持字符串`)
  }
  return out
}

/** 解析 [table.sub] 表头（含引号键段），返回落点表对象 */
function resolveTable(root: Record<string, unknown>, header: string, lineNo: number): Record<string, unknown> {
  const parts: string[] = []
  let buf = ''
  let inQuote: '"' | "'" | null = null
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]
    if (inQuote) {
      if (ch === inQuote) inQuote = null
      else buf += ch
    } else if (ch === '"' || ch === "'") inQuote = ch
    else if (ch === '.') {
      parts.push(buf.trim())
      buf = ''
    } else buf += ch
  }
  parts.push(buf.trim())
  if (parts.some((p) => !p)) throw new Error(`第 ${lineNo} 行：表头包含空键段`)
  // 表头段同样禁用 __proto__，杜绝借 [model_providers.__proto__] 污染原型链
  if (parts.some((p) => p === '__proto__')) throw new Error(`第 ${lineNo} 行：表头包含非法键段`)

  let current = root
  for (const part of parts) {
    // 只认 own property：`__proto__` 等危险键不能通过原型链取到 Object.prototype
    const existing = Object.prototype.hasOwnProperty.call(current, part) ? current[part] : undefined
    if (existing === undefined) {
      const next: Record<string, unknown> = {}
      current[part] = next
      current = next
    } else if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>
    } else {
      throw new Error(`第 ${lineNo} 行：表 ${part} 与已有键冲突`)
    }
  }
  return current
}

export function parseCodexToml(content: string): Record<string, unknown> {
  // 无原型根对象：即使某条赋值路径漏拦，也无法污染 Object.prototype
  const root: Record<string, unknown> = Object.create(null)
  let current = root
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = stripComment(lines[i] ?? '').trim()
    if (!line) continue
    if (line.startsWith('[[')) throw new Error(`第 ${lineNo} 行：暂不支持数组表 [[...]]`)
    if (line.startsWith('[')) {
      const end = line.indexOf(']')
      if (end < 0) throw new Error(`第 ${lineNo} 行：表头未闭合`)
      current = resolveTable(root, line.slice(1, end).trim(), lineNo)
      continue
    }
    const eq = findTopLevelEquals(line)
    if (eq < 0) throw new Error(`第 ${lineNo} 行：无法识别的配置行`)
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '')
    if (!key || key === '__proto__') throw new Error(`第 ${lineNo} 行：键名非法`)
    current[key] = parseScalar(line.slice(eq + 1), lineNo)
  }
  return root
}
