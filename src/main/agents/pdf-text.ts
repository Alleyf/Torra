/**
 * PDF 正文提取：把 PDF 的文字层读成字符串。
 *
 * 走 unpdf（内置 PDF.js 的 serverless 打包）。这里解决三件只有主进程才会遇到的事：
 *
 * 1. **ESM-only**：主进程编译目标是 CommonJS，`await import('unpdf')` 会被 tsc 降级成
 *    `require()` 而直接失败。用 `new Function('return import(...)')` 拿一个不被降级的原生
 *    import，和 `assistant/pi-sdk.ts` 里的 loader 同一个套路。
 * 2. **中文 cMap**：中文 PDF 的字符编码几乎都是 `UniGB-UCS2-H` 之类的 CMap，没有对应
 *    `.bcmap` 就只能拿到空白。PDF.js 在 Node 下按**文件系统路径**读 cMap（`fs.readFile`），
 *    不是 fetch，所以这里给的是 asar 内部路径而不是 file:// URL。
 * 3. **页数兜底**：几百页的 PDF 会把 `extractText` 的并发一次性全展开。材料本来只看前面
 *    一小段，页数超限就当读不出来，别在开场那一下把主进程卡死。
 */

import fs from 'node:fs'
import path from 'node:path'

import { PDF_PAGE_MAX } from '../../shared/materials'

type UnpdfDocument = {
  numPages: number
  loadingTask: { destroy: () => Promise<void> }
}

type Unpdf = {
  getDocumentProxy: (data: Uint8Array, options?: Record<string, unknown>) => Promise<UnpdfDocument>
  extractText: (
    data: UnpdfDocument,
    options?: { mergePages?: boolean },
  ) => Promise<{ text: string | string[] }>
}

const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Unpdf>

let loadPromise: Promise<Unpdf> | undefined

/** 首次调用时才装载 ESM 包，之后复用同一实例（PDF.js 单实例占几 MB）。 */
function loadUnpdf(): Promise<Unpdf> {
  loadPromise ??= nativeImport('unpdf') as Promise<Unpdf>
  return loadPromise
}

/**
 * PDF.js 在 Node 下按文件系统路径读 cMap 与标准字体，所以要定位到 asar 内的
 * `pdfjs-dist` 目录。`__dirname` 在 asar 运行时就是 asar 内部路径，node_modules 与
 * 主进程产物同在 asar 根部 —— 不能用 `process.resourcesPath`，开发期它指向
 * `node_modules/electron/dist/resources`，那里没有 node_modules。
 */
function pdfjsResourceDir(sub: 'cmaps' | 'standard_fonts'): string {
  const req = require('module').createRequire(path.join(__dirname, 'index.js'))
  const base = path.dirname(req.resolve('pdfjs-dist/package.json'))
  // PDF.js 认「必须以 / 结尾」，Windows 上 path.sep 是反斜杠，它直接拒
  return `${path.join(base, sub).split(path.sep).join('/')}/`
}

export type PdfTextResult =
  | { ok: true; text: string; pages: number }
  | { ok: false; reason: 'too-many-pages' | 'no-text' | 'unreadable'; pages?: number }

/**
 * 读出 PDF 的文字层。只支持「有文字层」的 PDF —— 扫描件整页都是图片，文字层是空的，
 * 那种得先 OCR，调用方会拿到 `ok: false`。
 */
export async function extractPdfText(ref: string): Promise<PdfTextResult> {
  try {
    return await extractPdfTextFromBytes(fs.readFileSync(ref))
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

/**
 * 字节版：聊天附件只在内存里（渲染层传来的 Buffer），没有磁盘路径，走同一个解析器。
 */
export async function extractPdfTextFromBytes(bytes: Uint8Array): Promise<PdfTextResult> {
  try {
    const unpdf = await loadUnpdf()
    // 必须换一份独立的 ArrayBuffer：PDF.js 会移交（transfer）它拿到的缓冲，
    // 而 Node 的 Buffer 常常共用一个池化的 ArrayBuffer，移交会把别人的数据一起带走。
    const data = new Uint8Array(bytes.byteLength)
    data.set(bytes)
    const pdf = await unpdf.getDocumentProxy(data, {
      cMapUrl: pdfjsResourceDir('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: pdfjsResourceDir('standard_fonts'),
      // 单张声明尺寸过大的图片会让 PDF.js 按声明值直接分配内存
      maxImageSize: 16_777_216,
    })
    if (pdf.numPages > PDF_PAGE_MAX) {
      await pdf.loadingTask.destroy()
      return { ok: false, reason: 'too-many-pages', pages: pdf.numPages }
    }
    const { text } = await unpdf.extractText(pdf, { mergePages: true })
    await pdf.loadingTask.destroy()
    const body = typeof text === 'string' ? text : text.join('\n')
    // 扫描件整页是图片，文字层是空的：这种情况不是「空文件」，要说清要 OCR
    if (!body.trim()) return { ok: false, reason: 'no-text', pages: pdf.numPages }
    return { ok: true, text: body, pages: pdf.numPages }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}
