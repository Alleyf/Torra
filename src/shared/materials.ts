import type { Attachment, MaterialItem } from './types'

/**
 * 研讨材料的读取与排版。
 *
 * 放 shared 是因为「哪些文件读得进来、按什么顺序出现、在哪一处被截断」这两件事
 * 同时被主进程（读取）和两侧 prompt 装配（排版）需要，而这条口径只许有一份。
 * 本文件不 import node:fs —— 读取留在主进程，这里只做纯函数，脱机就能测。
 */

/** 单文件最多读这么多字节；超了不读，让用户看见原因而不是拿到半份文档 */
export const MATERIAL_FILE_BYTES_MAX = 200_000
/** 一场讨论最多带几份材料 */
export const MATERIAL_COUNT_MAX = 8
/** 一轮最多花多少字符讲材料（API 通道）：所有模型每轮都重读一遍，不是只发一次 */
export const MATERIAL_TURN_CHARS_MAX = 24_000
/** 单文件进正文的排版上限 */
export const MATERIAL_FILE_CHARS_MAX = 12_000
/**
 * 网页通道的材料预算。
 *
 * 这个 prompt 是被**逐字键入**到第三方站点输入框里的，九成墙钟花在敲字上 ——
 * 两万字的内容会把一轮从一分钟拖成十几分钟。所以这一路只给一份能读完的摘要，
 * 并且把「全文没送到」这件事写在 prompt 里，不悄悄丢掉。
 */
export const MATERIAL_WEB_CHARS_MAX = 1_500
/** 网页通道里每份材料最多占的字符 */
export const MATERIAL_WEB_PER_FILE_CHARS_MAX = 600

/** 这些后缀按文字读出来一定是乱码；和 @ 引用那套用同一判据 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.pdf',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.mp3', '.mp4', '.avi', '.mov', '.bin',
])

export function looksBinary(ref: string): boolean {
  return BINARY_EXT.has(extOf(ref))
}

export function extOf(ref: string): string {
  const base = ref.split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i < 0 ? '' : base.slice(i).toLowerCase()
}

/**
 * 一份材料的标题行：让模型能在发言里引用「材料 2 · spec.md」而不是复述整段路径。
 */
function header(i: number, m: MaterialItem): string {
  const size = m.bytes === null ? '' : `，${(m.bytes / 1024).toFixed(0)}KB`
  return `【材料 ${i + 1} · ${m.name}${size}${m.truncated ? '，已截断' : ''}】`
}

/**
 * 把读到的材料排成进 prompt 的那一段。
 *
 * 预算用尽后剩下的材料**不静默消失**：仍然按名字列出来，说明没送过去。
 * 否则模型会以为「用户只给了前三份」，而用户以为六份都在场。
 */
export function renderMaterialBlock(items: MaterialItem[], budgetChars: number): string {
  const readable = items.filter((m) => m.status === 'read' && m.text.trim().length > 0)
  if (readable.length === 0) return ''
  const chunks: string[] = []
  let used = 0
  const dropped: MaterialItem[] = []
  for (const [i, m] of readable.entries()) {
    const head = header(i, m)
    const body = m.text.trim()
    const piece = `${head}\n${body}`
    if (used + piece.length + 2 > budgetChars) {
      dropped.push(m)
      continue
    }
    chunks.push(piece)
    used += piece.length + 2
  }
  if (dropped.length > 0) {
    const names = dropped.map((m) => `${m.name}`).join('、')
    chunks.push(
      `【未送达的材料】受单轮篇幅限制，以下 ${dropped.length} 份没有随本轮发出：${names}。` +
        `若你需要其中任何一份的内容才能判断，请明确指出，不要凭文件名推测。`,
    )
  }
  return chunks.join('\n\n')
}

/**
 * 网页通道的版本：每份只给开头一截，合计不超过 MATERIAL_WEB_CHARS_MAX。
 *
 * 与 API 通道不是「同一份内容砍短」而是两种交付：这里必须让模型知道全文没来，
 * 否则它会拿摘要里的半句话当整份文档的结论。
 */
export function renderMaterialExcerpt(items: MaterialItem[]): string {
  const readable = items.filter((m) => m.status === 'read' && m.text.trim().length > 0)
  if (readable.length === 0) return ''
  const chunks: string[] = []
  let used = 0
  let omitted = 0
  for (const m of readable) {
    if (used >= MATERIAL_WEB_CHARS_MAX) {
      omitted++
      continue
    }
    const room = Math.min(MATERIAL_WEB_PER_FILE_CHARS_MAX, MATERIAL_WEB_CHARS_MAX - used)
    const body = m.text.trim().slice(0, room)
    chunks.push(`【材料 ${chunks.length + 1} · ${m.name}（节选）】\n${body}`)
    used += body.length
  }
  const tail =
    omitted > 0
      ? `另有 ${omitted} 份材料因篇幅没有列出。`
      : ''
  return (
    `【材料（受输入框篇幅限制，以下只是每份的节选，全文没有送达）】\n` +
    chunks.join('\n\n') +
    (tail ? `\n${tail}` : '')
  )
}

/**
 * 读不到的那些要给用户一句话，不是只给模型。
 *
 * 「附件选了却像没选」是这一条最坏的失败方式：用户以为模型在看文档讨论，
 * 实际上模型只看得到一个文件名。
 */
export function materialNotices(items: MaterialItem[]): string[] {
  const out: string[] = []
  for (const m of items) {
    switch (m.status) {
      case 'too-large':
        out.push(`「${m.name}」有 ${(m.bytes ?? 0) / 1024 / 1024 >= 1 ? `${((m.bytes ?? 0) / 1024 / 1024).toFixed(1)}MB` : `${Math.round((m.bytes ?? 0) / 1024)}KB`}，超过单份上限 ${MATERIAL_FILE_BYTES_MAX / 1000}KB，没有读进讨论。请摘出要讨论的那一节再附。`)
        break
      case 'binary':
        out.push(`「${m.name}」是图片或二进制文件，文字化只会是乱码，没有读进讨论。`)
        break
      case 'missing':
        out.push(`「${m.name}」在盘上找不到了，这一轮没有它的内容。`)
        break
      case 'empty':
        out.push(`「${m.name}」是空的。`)
        break
      case 'unreadable':
        out.push(`「${m.name}」读不出来（权限或被占用），这一轮没有它的内容。`)
        break
      case 'read':
        if (m.truncated) out.push(`「${m.name}」只取了前 ${MATERIAL_FILE_CHARS_MAX} 字进讨论，后面被裁掉。`)
        break
    }
  }
  return out
}
