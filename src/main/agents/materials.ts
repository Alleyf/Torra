import fs from 'node:fs'
import path from 'node:path'
import WordExtractor from 'word-extractor'
import * as XLSX from 'xlsx'
import {
  MATERIAL_COUNT_MAX,
  MATERIAL_FILE_BYTES_MAX,
  MATERIAL_FILE_CHARS_MAX,
  PDF_PAGE_MAX,
  isPdfDocument,
  isWordDocument,
  looksBinary,
  isSpreadsheetDocument,
} from '../../shared/materials'
import type { Attachment, MaterialItem } from '../../shared/types'
import { extractPdfText, extractPdfTextFromBytes } from './pdf-text'

const wordExtractor = new WordExtractor()

/**
 * 把用户附上的文件读成「能进 prompt 的那一份」。
 *
 * 只在**这一处**碰盘：读取发生在开场那一次，之后每一轮用的是同一份快照 ——
 * 中途文件被改会让不同模型看到不同内容，那种分歧没人能复现。
 * 正文不进会话存档（存档只留 Topic.attachments 的名字与路径），
 * 否则每轮增量写都要把几万字的材料整份重写一遍。
 */
export async function readTopicMaterials(attachments: Attachment[] | undefined): Promise<MaterialItem[]> {
  const list = Array.isArray(attachments) ? attachments : []
  const out: MaterialItem[] = []
  for (const a of list.slice(0, MATERIAL_COUNT_MAX)) {
    out.push(await readOne(a))
  }
  return out
}

async function readOne(a: Attachment): Promise<MaterialItem> {
  const base: Omit<MaterialItem, 'status' | 'text' | 'bytes' | 'truncated'> = {
    id: a.id,
    name: a.name || path.basename(a.ref),
    ref: a.ref,
  }
  /*
   * 只认 kind==='file'。link 类附件要联网、可能要先登录、内容还随时会变 ——
   * 那是另一个功能，不是这里的「把本地文档读给模型」。
   */
  if (a.kind !== 'file') return { ...base, status: 'unreadable', text: '', bytes: null, truncated: false }
  if (!path.isAbsolute(a.ref)) return { ...base, status: 'missing', text: '', bytes: null, truncated: false }
  if (looksBinary(a.ref)) return { ...base, status: 'binary', text: '', bytes: null, truncated: false }

  const st = fs.statSync(a.ref, { throwIfNoEntry: false })
  if (!st) return { ...base, status: 'missing', text: '', bytes: null, truncated: false }
  if (!st.isFile()) return { ...base, status: 'unreadable', text: '', bytes: st.size, truncated: false }
  if (st.size > MATERIAL_FILE_BYTES_MAX) {
    return { ...base, status: 'too-large', text: '', bytes: st.size, truncated: false }
  }
  try {
    if (isWordDocument(a.ref)) {
      return finish(base, (await wordExtractor.extract(a.ref)).getBody(), st.size)
    }
    if (isSpreadsheetDocument(a.ref)) {
      return finish(base, extractSpreadsheet(fs.readFileSync(a.ref)), st.size)
    }
    if (isPdfDocument(a.ref)) {
      const pdf = await extractPdfText(a.ref)
      if (!pdf.ok) return { ...base, status: pdf.reason, text: '', bytes: st.size, truncated: false }
      return finish(base, pdf.text, st.size)
    }
    return finish(base, fs.readFileSync(a.ref, 'utf8'), st.size)
  } catch {
    return { ...base, status: 'unreadable', text: '', bytes: st.size, truncated: false }
  }
}

/** 空内容归 empty，超长按排版上限截断；这段三种格式共用 */
function finish(
  base: Omit<MaterialItem, 'status' | 'text' | 'bytes' | 'truncated'>,
  raw: string,
  bytes: number,
): MaterialItem {
  if (!raw.trim()) return { ...base, status: 'empty', text: '', bytes, truncated: false }
  const truncated = raw.length > MATERIAL_FILE_CHARS_MAX
  return {
    ...base,
    status: 'read',
    text: truncated ? raw.slice(0, MATERIAL_FILE_CHARS_MAX) : raw,
    bytes,
    truncated,
  }
}
/**
 * 把 Excel 工作簿按「每张表一段 Markdown」排放，公式结果直接取缓存值。
 * 空表跳过，避免给模型塞一屏空白单元格。
 */
export function extractSpreadsheet(bytes: Buffer): string {
  const book = XLSX.read(bytes, { type: 'buffer' })
  const parts: string[] = []
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name]
    if (!sheet || !sheet['!ref']) continue
    const csv = XLSX.utils.sheet_to_csv(sheet)
    if (!csv.trim()) continue
    parts.push(`### ${name}`)
    parts.push(csv.trimEnd())
  }
  return parts.join(`\n`)
}

/**
 * 聊天附件按扩展名选解析器：Word / Excel 走专门库，其余按 UTF-8 直读。
 * 返回 null 表示不进正文（图片/压缩包由各自通道另外处理）。
 */
export async function extractAttachmentText(name: string, bytes: Buffer): Promise<string | null> {
  const lower = name.toLowerCase()
  // 聊天附件没有磁盘路径可查大小，只能对字节数设同一道闸：解析一份几十 MB 的文档
  // 会把主进程连着一起占住，而内联进 prompt 的正文本来也塞不下。
  if (bytes.length > MATERIAL_FILE_BYTES_MAX) {
    return `（${(bytes.length / 1_000_000).toFixed(1)}MB，超过单份 ${MATERIAL_FILE_BYTES_MAX / 1_000_000}MB 上限，未读取正文）`
  }
  if (isWordDocument(lower)) {
    try {
      const doc = await new WordExtractor().extract(bytes)
      return doc.getBody()
    } catch { return null }
  }
  if (isSpreadsheetDocument(lower)) {
    try { return extractSpreadsheet(bytes) } catch { return null }
  }
  if (isPdfDocument(lower)) {
    // 附件只有内存里的字节、没有磁盘路径，走 pdf-text 的字节版
    const pdf = await extractPdfTextFromBytes(bytes)
    if (pdf.ok) return pdf.text
    // 读不出来也要说清原因：静默回「二进制」会让人以为格式不支持
    if (pdf.reason === 'no-text') return '（扫描版 PDF，没有文字层，需要先 OCR）'
    if (pdf.reason === 'too-many-pages') return `（${pdf.pages ?? '?'} 页，超过 ${PDF_PAGE_MAX} 页上限，未读取正文）`
    return null
  }
  try { return bytes.toString('utf8') } catch { return null }
}
