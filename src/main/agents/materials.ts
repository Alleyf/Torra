import fs from 'node:fs'
import path from 'node:path'
import WordExtractor from 'word-extractor'
import {
  MATERIAL_COUNT_MAX,
  MATERIAL_FILE_BYTES_MAX,
  MATERIAL_FILE_CHARS_MAX,
  isPdfDocument,
  isWordDocument,
  looksBinary,
} from '../../shared/materials'
import type { Attachment, MaterialItem } from '../../shared/types'
import { extractPdfText } from './pdf-text'

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
