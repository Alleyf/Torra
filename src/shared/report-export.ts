/**
 * 报告导出的装配层（纯函数，主进程与渲染端共用）。
 *
 * 分工：渲染端只负责把已经画好的报告 DOM 和样式表原样交回来，
 * 这里负责拼成一份能离线打开的单文件文档。报告版式在 ReportViewer 里只有一份，
 * 导出不再另写一遍标记 —— 另写的那份必然会在界面改版后过期。
 *
 * 因为正文里含模型生成的文字，装配前先过一道清洗：导出的 HTML 会被用户双击打开，
 * 那一刻它就是一个本地页面，不该有任何东西跟着执行。
 */

export type ReportExportFormat = 'html' | 'pdf' | 'png'

/** 渲染端交回来的原材料：报告正文片段 + 当前生效的样式表 + 标题 */
export interface ReportExportPayload {
  sessionId: string
  format: ReportExportFormat
  title: string
  body: string
  css: string
}

export interface ReportExportResult {
  ok: boolean
  path?: string
  reason?: string
}

/** 复制为图片和导出走的是同一份装配结果，只是不落盘、直接进剪贴板 */
export type ReportCopyImagePayload = Omit<ReportExportPayload, 'format'>

const SCRIPT_BLOCK = /<script[\s\S]*?<\/script\s*>/gi
const NESTED_DOC = /<\/?(iframe|frame|object|embed|link|base)\b[^>]*>/gi
const INLINE_HANDLER = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const JS_URL = /\b(href|src)\s*=\s*(?:"|')?\s*javascript:[^"'>\s]*(?:"|')?/gi

/** 幂等：清洗过的文本再过一次不变。宁可删掉标签，也不留可执行的东西。 */
export function sanitizeExportFragment(html: string): string {
  return html
    .replace(SCRIPT_BLOCK, '')
    .replace(NESTED_DOC, '')
    .replace(INLINE_HANDLER, '')
    .replace(JS_URL, '$1="#"')
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 文件名里真不能出现的字符（Windows 保留集 + 控制字符） */
const ILLEGAL_IN_NAME = /[<>:"/\\|?*\x00-\x1f]/g
const SEP_RUN = /[-\s]{2,}/g

function dayKey(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 导出文件名主体：`日期-主题-会话短 id`。
 *
 * 两件事是刻意的。一是**保留中文**：把非 ASCII 一律换成下划线的老做法，
 * 一场「阶段性恋爱是奖励还是惩罚」的报告会导出成 `____________.md`，等于没名字。
 * 二是**带上日期**：导出目录里同一主题往往有好几场，只有主题排不出先后。
 * 主题截断按码点走，不在 emoji 或生僻字的代理对中间切开。
 */
export function exportFileBase(o: {
  title?: string | null
  date?: number | null
  sessionId: string
}): string {
  const title = Array.from(
    (o.title ?? '')
      .replace(ILLEGAL_IN_NAME, ' ')
      .replace(SEP_RUN, ' ')
      .trim()
      .replace(/[.\s]+$/, ''),
  )
    .slice(0, 48)
    .join('')
  const sid = o.sessionId.replace(/[^A-Za-z0-9]/g, '').slice(-8)
  const parts = [dayKey(o.date), title || '研讨报告', sid]
  return Array.from(parts.filter(Boolean).join('-')).slice(0, 120).join('')
}

/**
 * 导出文档自己的版式修正：屏幕上的报告是弹窗里滚动的，
 * 导出的是一份通栏长文档 —— 弹窗的 max-height/overflow/sticky 头在纸上会变成裁切。
 */
const EXPORT_OVERRIDE_CSS = `
@page { margin: 14mm; }
html, body { background: var(--bg, #fff); }
body.report-doc { margin: 0; padding: 26px 30px 40px; }
body.report-doc .report-modal {
  max-width: none; width: auto; margin: 0; padding: 0;
  max-height: none; overflow: visible; border: 0; box-shadow: none;
}
body.report-doc .report-head { position: static; margin: 0 0 16px; padding: 0 0 12px; }
body.report-doc .report-head-right,
body.report-doc .report-regen,
body.report-doc .report-export,
body.report-doc .report-export-note,
body.report-doc .report-regen-note { display: none !important; }
/* 导出是一份一次性快照。弹窗的 fade-up 入场动画会在文档加载后重放 0.25s，
   而 PNG/PDF 只等两帧就截 —— 不关掉就截到半透明的中间帧，整页发灰。 */
body.report-doc *,
body.report-doc *::before,
body.report-doc *::after { animation: none !important; transition: none !important; }
body.report-doc .rp-evidence { break-inside: avoid; }
body.report-doc .rp-item { break-inside: avoid; }
`

export function buildExportDoc(p: { title: string; css: string; body: string }): string {
  const body = sanitizeExportFragment(p.body)
  // 样式表按原样内联：里面没有标记只有 CSS，但 </style> 会截断文档，先掐掉
  const css = p.css.replace(/<\/style/gi, '<\\/style')
  const title = escapeText(p.title).slice(0, 200)
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="generator" content="Torra">
<title>${title}</title>
<style>${css}</style>
<style>${EXPORT_OVERRIDE_CSS}</style>
</head>
<body class="report-doc">
<div class="modal report-modal">
${body}
</div>
</body>
</html>
`
}
