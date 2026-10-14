import fs from 'node:fs'
import path from 'node:path'
import {
  MATERIAL_COUNT_MAX,
  MATERIAL_FILE_BYTES_MAX,
  MATERIAL_FILE_CHARS_MAX,
  looksBinary,
} from '../../shared/materials'
import type { Attachment, MaterialItem } from '../../shared/types'

/**
 * 把用户附上的文件读成「能进 prompt 的那一份」。
 *
 * 只在**这一处**碰盘：读取发生在开场那一次，之后每一轮用的是同一份快照 ——
 * 中途文件被改会让不同模型看到不同内容，那种分歧没人能复现。
 * 正文不进会话存档（存档只留 Topic.attachments 的名字与路径），
 * 否则每轮增量写都要把几万字的材料整份重写一遍。
 */
export function readTopicMaterials(attachments: Attachment[] | undefined): MaterialItem[] {
  const list = Array.isArray(attachments) ? attachments : []
  const out: MaterialItem[] = []
  for (const a of list.slice(0, MATERIAL_COUNT_MAX)) {
    out.push(readOne(a))
  }
  return out
}

function readOne(a: Attachment): MaterialItem {
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
  let raw: string
  try {
    raw = fs.readFileSync(a.ref, 'utf8')
  } catch {
    return { ...base, status: 'unreadable', text: '', bytes: st.size, truncated: false }
  }
  if (!raw.trim()) return { ...base, status: 'empty', text: '', bytes: st.size, truncated: false }
  const truncated = raw.length > MATERIAL_FILE_CHARS_MAX
  return {
    ...base,
    status: 'read',
    text: truncated ? raw.slice(0, MATERIAL_FILE_CHARS_MAX) : raw,
    bytes: st.size,
    truncated,
  }
}
