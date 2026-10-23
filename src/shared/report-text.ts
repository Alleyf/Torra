/**
 * 报告文本的短句化与去噪层。
 *
 * 报告里的字段是模型原文：一句话常有一百多字，中间夹着 [utt_xxx] 引用、
 * **加粗**、列表符号和英文原话。阅读页如果把这些原样铺开，读者第一眼
 * 看到的就是一堵墙。这里统一做三件事：
 *   1. 去掉只对内部链路有意义的痕迹（发言 id、markdown 符号）；
 *   2. 从长句里抽出可以当标题的短句；
 *   3. 把整段切成可以逐条扫读的分句。
 *
 * 纯函数，不带 DOM；生成端、视图层和导出共用同一套口径。
 */

const UTT_REF = /\[?\s*utt_[A-Za-z0-9_]+\s*\]?/g
const BARE_UTT_REF = /(?<![\w])utt_[A-Za-z0-9_]+/g
const NUM_REF = /\[\d{1,3}\]/g
const BLOCK_MARK = /^\s*(?:[-*+]\s+|>\s?|#{1,6}\s+)/gm
const LEAD_NUM = /^\s*(?:[（(]?\d{1,2}[)）.、]|[一二三四五六七八九十]{1,2}[、.])\s*/
const LEAD_FILLER =
  /^(?:本报告认为|本报告主张|报告认为|综合来看|综上(?:所述)?|结论是|因此|所以|可以说|需要注意的一点是)[，,：:\s]*/
const QUOTE_WRAP = /^[「“"'‘《]|[」”"'’》]$/g
const TRAILING = /[，,；;。.!！？：:\s]+$/

export function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 去掉发言引用、markdown 标记与列表符号；保留正文里的普通括号引用。 */
export function stripReportNoise(input: string | null | undefined): string {
  if (!input) return ''
  return collapse(
    String(input)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(UTT_REF, ' ')
      .replace(BARE_UTT_REF, ' ')
      .replace(NUM_REF, ' ')
      .replace(BLOCK_MARK, '')
      .replace(/\*\*/g, '')
      .replace(/__/g, '')
      .replace(/`/g, '')
      .replace(/^\s*[-*+]\s+/gm, ''),
  )
}

/** 抽出来的发言引用，用于“引用了 N 段发言”这类可同时展示的元信息。 */
export function evidenceRefs(input: string | null | undefined): string[] {
  if (!input) return []
  const found = String(input).match(/utt_[A-Za-z0-9_]+/g) ?? []
  return [...new Set(found)]
}

export function countCjk(input: string): number {
  return (input.match(/[\u3400-\u9fff]/g) ?? []).length
}

/** 整段几乎不是中文时，说明模型回了英文原文，页面要单独提示。 */
export function isMostlyLatin(input: string): boolean {
  const text = stripReportNoise(input)
  if (!text) return false
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  const cjk = countCjk(text)
  return latin > 40 && latin > cjk * 1.5
}

/**
 * 取前 N 个字符，尽量停在标点或空格的边界上，避免把英文单词切断。
 * 中文没有词边界，截在标点或直接截断都读得通。
 */
export function clip(input: string, max: number): string {
  const text = input.trim()
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const stop = Math.max(
    head.lastIndexOf('，'),
    head.lastIndexOf('；'),
    head.lastIndexOf('。'),
    head.lastIndexOf('、'),
    head.lastIndexOf(' '),
  )
  const cut = stop > max * 0.55 ? head.slice(0, stop) : head
  return `${cut.replace(TRAILING, '')}…`
}

/** 第一句，够短就直接用；太长再压缩。 */
export function firstSentence(input: string | null | undefined, max = 120): string {
  const text = stripReportNoise(input)
  if (!text) return ''
  const end = text.search(/[。！？!?]/)
  const head = end >= 0 ? text.slice(0, end + 1) : text
  return clip(head.replace(TRAILING, ''), max)
}

/**
 * 从长句里抽一个能当卡片标题的短语。
 *
 * 优先取第一个语义完整的短分句（六个字以上、不超过上限），取不到就退到
 * 第一分句再退到整句截断。模型爱写“本报告主张……”，这一步也顺手去掉。
 */
export function shortTitle(input: string | null | undefined, max = 24): string {
  const text = stripReportNoise(input).replace(LEAD_NUM, '').replace(LEAD_FILLER, '').replace(QUOTE_WRAP, '')
  if (!text) return ''
  const parts = text
    .split(/[，,；;。！？!?\n]+/)
    .map((x) => x.trim().replace(QUOTE_WRAP, '').replace(TRAILING, ''))
    .filter(Boolean)
  const pick =
    parts.find((part) => countCjk(part) >= 5 && part.length <= max) ??
    parts.find((part) => part.length >= 8) ??
    text
  return clip(pick, max).replace(/[：:]+$/, '')
}

/** 给卡片做一行补充说明：整句如果比标题长不了多少就返回空，避免重复。 */
export function gist(input: string | null | undefined, title?: string, max = 96): string {
  const text = stripReportNoise(input)
  if (!text) return ''
  const head = firstSentence(text, max)
  if (title && head.replace(TRAILING, '') === title.replace(TRAILING, '')) return ''
  return head
}

/** 把长段切成可以当列表项读的分句；过短的分句忽略。 */
export function splitClauses(input: string | null | undefined, limit = 8): string[] {
  const text = stripReportNoise(input)
  if (!text) return []
  return text
    .split(/(?<=[。；;！？!?])\s*|\n+/)
    .map((x) => x.trim().replace(TRAILING, ''))
    .filter((x) => x.length >= 4)
    .slice(0, limit)
}

/** 报告首屏的一句话答案：优先用结论标题，没有就退到摘要第一句。 */
export function oneLiner(headline: string | null | undefined, fallback: string | null | undefined, max = 46): string {
  const head = stripReportNoise(headline)
  if (head) return clip(head.replace(TRAILING, ''), max)
  return firstSentence(fallback, max)
}
