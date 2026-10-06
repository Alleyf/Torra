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
 * 句末标点之后、且冒号前是不超过 12 字的短标签时断行；已经是 markdown
 * 标题/列表的内容原样通过。
 */
const INLINE_LABEL = /([。；;！!？?])\s*([^\n：:！!？?\s>#`]{1,12})(：)/g
const CIRCLED = /(?<=[。；;！!？?\s])\s*(?=[①②③④⑤⑥⑦⑧⑨⑩])/g
/** 段首若是 markdown 块标记（引用 / 列表 / 标题），不能再包粗体：粗体会把标记吃成正文字符 */
const BLOCK_MARK = /^\s*(?:[-*+]\s|>\s?|#{1,6}\s|\d+[.)、]\s)/
/** 段首标签不能跨过句末标点：否则「这一步很快完成了。例如：」会把整句抬成粗体 */
const LEAD_LABEL = /(^|\n\n)([^\n：:。；;！!？?，,、]{1,12})(：)/g
/** 句中的连接词后面带冒号只是引出例子，不是小标题，抬成一段会把句子劈成两截 */
const CONNECTIVE = /^(?:例如|比如|譬如|即|也就是说|换言之|总之|因此|所以|然而|但|不过|另外|此外|同时|其中|以及)/
/** 中英 / 中数交界处补一个空格：模型经常写成「多Agent协作」「2万次」，挤在一起阅读节奏很糙 */
const CJK_THEN_LATIN = /([\u4e00-\u9fff])([A-Za-z0-9])/g
const LATIN_THEN_CJK = /([A-Za-z0-9])([\u4e00-\u9fff])/g

function spaceCjk(t: string): string {
  return t.replace(CJK_THEN_LATIN, '$1 $2').replace(LATIN_THEN_CJK, '$1 $2')
}

export function formatSpeech(t: string): string {
  if (!t) return t
  let out = fixCjkEmphasis(cleanText(t)).replace(/\n{3,}/g, '\n\n')
  out = out.replace(INLINE_LABEL, (m, end: string, label: string, colon: string) =>
    CONNECTIVE.test(label) ? m : `${end}\n\n${label}${colon}`,
  )
  out = out.replace(CIRCLED, '\n\n')
  out = out.replace(LEAD_LABEL, (_m, pre: string, label: string, colon: string) => {
    const text = label.trim()
    if (!text || BLOCK_MARK.test(label) || label.includes('*') || CONNECTIVE.test(text)) {
      return `${pre}${label}${colon}`
    }
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

/** 会被 CommonMark 判成「标点后不能收尾」的全角/半角标点 */
const TRAIL_PUNCT = '：:，。！？、；;,.!?）)】」\'"'
/**
 * 把句末标点挪到闭合标记外面：`**立场：**支持` → `**立场**：支持`。
 *
 * CommonMark 的 right-flanking 规则要求「闭合竖线前面是标点时，后面必须是空白或标点」，
 * 而中文没有空格，`**小标题：**正文` 因此永远渲染不出来 —— 不是模型写错了，
 * 是这条规则按拉丁文分词写的。冒号移出粗体即可合规，视觉上仍然是加粗的小标题。
 * 后面已经接空白/标点时不动（那种写法本来就渲染正常），接 `*` 时也不动（避免拆坏 `***`）。
 */
function fixCjkEmphasis(t: string): string {
  return t.replace(
    new RegExp(`\\*\\*([^*\\n]+?)([${TRAIL_PUNCT}])\\*\\*(?![\\s*${TRAIL_PUNCT}])`, 'g'),
    '**$1**$2',
  )
}

/**
 * 压成单段行内文本：论点卡、摘要条这类位置只放得下一段连续的话。
 *
 * 不压的话 react-markdown 会把每段包成 `<p>`，而 MarkdownInline 摊平块级标记后
 * 段与段之间不留空格，两句会黏在一起。
 */
function mdInline(t: string): string {
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
  const at = s.lastIndexOf('**')
  const prev = at > 0 ? (s[at - 1] ?? '') : ''
  /** `a**b` 这种是文本里的星号，不是没闭合的粗体：前面贴着字母数字就不补 */
  const closeBold =
    (s.match(/\*\*/g) ?? []).length % 2 === 1 && (at === 0 || /[\s\p{P}]/u.test(prev)) ? '**' : ''
  const closeCode = (s.match(/`/g) ?? []).length % 2 === 1 ? '`' : ''
  return `${s}${closeBold}${closeCode}`
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
