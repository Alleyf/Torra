import type { ReportCopyImagePayload, ReportExportFormat, ReportExportResult } from '@shared/report-export'

/**
 * 把屏幕上的报告取成一份可导出的原材料。
 *
 * 只取 `.report-modal` 的内部：弹窗遮罩、关闭/重新生成按钮、应用状态提示都是
 * 界面的一部分而不是报告的一部分。`<details>` 全部展开 —— 证据链和交锋原文收着
 * 的时候不参与排版，PDF 与图片会把它们整个丢掉。
 */
function collectBody(modal: Element): string {
  const clone = modal.cloneNode(true) as HTMLElement
  clone
    .querySelectorAll('button, input, textarea, select, .report-head-right, .report-regen-note, .report-export')
    .forEach((n) => n.remove())
  clone.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''))
  return clone.innerHTML
}

/** 内联当前生效的全部样式：跨域样式表读 cssRules 会抛，跳过（本项目样式都在本地） */
function collectCss(): string {
  const rules: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const list = sheet.cssRules
      if (list) rules.push(...Array.from(list, (r) => r.cssText))
    } catch {
      /* 读不到的那张表不参与导出 */
    }
  }
  return rules.join('\n')
}

type Collected = { doc: ReportCopyImagePayload } | { fail: ReportExportResult }

function collectDoc(sessionId: string, title: string): Collected {
  const modal = document.querySelector('.report-modal')
  if (!modal) return { fail: { ok: false, reason: '报告正文不在页面上，关掉再打开一次试试。' } }
  const body = collectBody(modal)
  if (!body.trim()) return { fail: { ok: false, reason: '报告正文为空，无法导出。' } }
  return { doc: { sessionId, title, body, css: collectCss() } }
}

export function exportReportView(
  sessionId: string,
  format: ReportExportFormat,
  title: string,
): Promise<ReportExportResult> {
  const c = collectDoc(sessionId, title)
  if ('fail' in c) return Promise.resolve(c.fail)
  return window.torra.exportReport({ ...c.doc, format })
}

/** 复制为图片：和导出同一份原料，只是产物进剪贴板，不落在磁盘上 */
export function copyReportViewAsImage(sessionId: string, title: string): Promise<ReportExportResult> {
  const c = collectDoc(sessionId, title)
  if ('fail' in c) return Promise.resolve(c.fail)
  return window.torra.copyReportImage(c.doc)
}
