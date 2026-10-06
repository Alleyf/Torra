/**
 * 模型文本 → 展示文本。议事厅、右侧论点卡、报告共用同一套口径，
 * 避免「主时间线渲染了 markdown，侧栏却露出 ** 星号」这种同一句话两种样子。
 */

/**
 * 归一化模型发言文本用于展示。
 *
 * 网页通道抓取时，站点把内联引用编号渲染成独立元素，innerText 会在其前后
 * 各插一个换行，导致正文出现「……-\n4\n。……」这种引用号独占一行、句子竖排割裂。
 * 新抓取已在主进程侧清洗，这里兼容历史已落盘的记录，独占一行的纯数字合并回去。
 */
export function cleanText(t: string): string {
  return t ? t.replace(/\n(\d{1,3})\n/g, '$1') : t
}

/**
 * 把「立场：… 论据：… 建议：…」这种一行的行内小标题拆成段落并加粗。
 *
 * 网页通道里模型经常把整段论证压成一行，卡片就变成一面墙。这里只在
 * 句末标点之后、且冒号前是不超过 12 字的短标签时断行，正常句子里的
 * 「例如：」不会被误伤；已经是 markdown 标题/列表的内容原样通过。
 */
const INLINE_LABEL = /(?<=[。；;！!？?])\s*(?=[^：:！!？?\n>#`]{1,12}：)/g
const CIRCLED = /(?<=[。；;！!？?\s])\s*(?=[①②③④⑤⑥⑦⑧⑨⑩])/g
/** 段首若是 markdown 块标记（引用 / 列表 / 标题），不能再包粗体：粗体会把标记吃成正文字符 */
const BLOCK_MARK = /^\s*(?:[-*+]\s|>\s?|#{1,6}\s|\d+[.)、]\s)/
const LEAD_LABEL = /(^|\n\n)([^\n：:]{1,12})(：)/g
/** 中英 / 中数交界处补一个空格：模型经常写成「多Agent协作」「2万次」，挤在一起阅读节奏很糙 */
const CJK_THEN_LATIN = /([\u4e00-\u9fff])([A-Za-z0-9])/g
const LATIN_THEN_CJK = /([A-Za-z0-9])([\u4e00-\u9fff])/g

function spaceCjk(t: string): string {
  return t.replace(CJK_THEN_LATIN, '$1 $2').replace(LATIN_THEN_CJK, '$1 $2')
}

export function formatSpeech(t: string): string {
  if (!t) return t
  let out = fixCjkEmphasis(cleanText(t)).replace(/\n{3,}/g, '\n\n')
  out = out.replace(INLINE_LABEL, '\n\n').replace(CIRCLED, '\n\n')
  out = out.replace(LEAD_LABEL, (_m, pre: string, label: string, colon: string) => {
    const text = label.trim()
    if (!text || BLOCK_MARK.test(label) || label.includes('*')) return `${pre}${label}${colon}`
    // 已经加粗过就不再叠一层，避免出现 `****`
    return `${pre}**${text}**${colon}`
  })
  return spaceCjk(out)
}

/** 压掉 markdown 的块级标记：一行摘要里不想要 `##`、`-`、`>` 这些脚手架 */
function stripBlocks(t: string): string {
  return t
    .replace(/^[ \t]*(?:#{1,6}|>)[ \t]+/gm, '')
    .replace(/(?:^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]+/g, ' ')
}

/**
 * 把句末标点挪到闭合标记外面：`**立场：**支持` → `**立场**：支持`。
 *
 * CommonMark 的 right-flanking 规则认为「前一个字符是标点、后一个字符不是标点/空白」
 * 的闭合竖线无效，所以中文里最常见的 `**小标题：**正文` 会被原样印出来 ——
 * 不是模型写错了，是这套规则按英文空格分词写的。把冒号移出粗体就合规了。
 */
const CJK_PUNCT = '：:，。！？、；;,.!?)'
function fixCjkEmphasis(t: string): string {
  const close = new RegExp(`(\\*\\*|\\*)([^*\\n]+?)([${CJK_PUNCT}])\\1(?![\\s${CJK_PUNCT}])`, 'g')
  return t.replace(close, '$1$2$1$3')
}

/**
 * 压成单段行内文本：论点卡、共识点条目这类位置只放得下一段连续的话。
 *
 * 不压的话 react-markdown 会把每段包成 `<p>`，而 MarkdownInline 摊平块级标记后
 * 段与段之间不留空格，两句会黏在一起。
 */
export function mdInline(t: string): string {
  if (!t) return ''
  return spaceCjk(
    stripBlocks(fixCjkEmphasis(cleanText(t)).replace(/```[\s\S]*?```/g, ' ').replace(/`{3,}/g, ' '))
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

/**
 * 补上没闭合的行内标记。
 *
 * 截断可能正好切在 `**粗体**` 中间，流式中的发言更是天生半截：
 * 少了闭合标记，react-markdown 不当它是强调，星号就原样印到卡上。
 * 单个 `*` 不补：它更可能是「3*4」这种字面量，硬补反而斜掉半句。
 */
function closeInline(s: string): string {
  const bold = (s.match(/\*\*/g) ?? []).length
  const code = (s.match(/`/g) ?? []).length
  return `${s}${bold % 2 ? '**' : ''}${code % 2 ? '`' : ''}`
}

/** 行内 markdown 渲染用的截断摘要：压成单段、按句末收口、补齐闭合。 */
export function mdExcerpt(t: string, max = 160): string {
  const s = mdInline(t)
  if (s.length <= max) return closeInline(s)
  let cut = s.slice(0, max)
  const stop = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('；'),
    cut.lastIndexOf(';'),
  )
  if (stop > max * 0.55) cut = cut.slice(0, stop + 1)
  return `${closeInline(cut)}…`
}

/**
 * 纯文本化的 markdown：图形节点、chip、原生 title 这些塞不进 HTML 的地方用。
 * 保留正文与链接文字，只去掉标记。
 */
export function plainMd(t: string, max?: number): string {
  if (!t) return ''
  const s = spaceCjk(
    stripBlocks(
      cleanText(t)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`{3,}/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]*)\*\*/g, '$1')
        .replace(/__([^_]*)__/g, '$1')
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
        .replace(/~~([^~]*)~~/g, '$1')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        // 流式中的发言只剩半个标记对：纯文本位置没有「未闭合」可言，直接摘掉
        .replace(/\*\*/g, ''),
    )
      .replace(/\s+/g, ' ')
      .trim(),
  )
  return max && s.length > max ? `${s.slice(0, max)}…` : s
}
