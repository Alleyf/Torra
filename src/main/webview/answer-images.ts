/**
 * 回答图片落库（网页通道的 AI 生图）
 *
 * 为什么要在主进程下载再入库：渲染层 CSP 的 img-src 只放行 self/torra-icon/data/blob，
 * 各家图床域名不可能逐个加白名单；而且图床 URL 常带时效签名，几小时后就是碎图。
 * 所以下载成字节存进 ChatAssetStore，渲染层照旧走 attachmentRead 拿 data: URL。
 *
 * 下载用站点自己的 session.fetch：CDN 常常校验 Referer/Cookie，
 * 用主进程裸 fetch 会被 403 —— 这跟网页里能看到图、我们却抓不到是同一类问题。
 */
import { session } from 'electron'
import { sniffMime } from '../net/favicon-cache'
import type { ChatAssetStore } from '../store/chat-assets'
import { diag } from '../diagnostics/log'
import { makeId } from '../../shared/invariants'

/** 单张图上限：生图很少超过 10 MB，超了多半是抓错东西（视频封面等） */
const MAX_BYTES = 10 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

export interface SavedAnswerImage {
  id: string
  name: string
  mime: string
  size: number
}

function extFor(mime: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/svg+xml') return 'svg'
  return 'img'
}

/** data: URL 直接解码，省一次网络往返（部分站点把结果图内联成 base64） */
function decodeDataUrl(url: string): { buf: Buffer; mime: string } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url)
  if (!m) return null
  const mime = m[1] ?? ''
  try {
    const buf = m[2] ? Buffer.from(m[3] ?? '', 'base64') : Buffer.from(decodeURIComponent(m[3] ?? ''), 'utf8')
    return { buf, mime }
  } catch {
    return null
  }
}

/**
 * 把本轮回答里的图片下载并存盘。
 *
 * 单张失败不影响其余：宁可少一张图，也不要让整轮回答看起来失败。
 */
export async function saveAnswerImages(
  urls: string[],
  store: ChatAssetStore,
  partition: string,
  modelId: string,
  sessionId: string,
): Promise<SavedAnswerImage[]> {
  const out: SavedAnswerImage[] = []
  for (let i = 0; i < urls.length && out.length < 12; i++) {
    const url = urls[i]
    if (!url) continue
    try {
      let buf: Buffer | null = null
      let mime = ''
      if (url.startsWith('data:')) {
        const d = decodeDataUrl(url)
        if (d) { buf = d.buf; mime = d.mime }
      } else if (/^https?:/i.test(url)) {
        const ses = session.fromPartition(partition)
        const res = await withTimeout(ses.fetch(url), FETCH_TIMEOUT_MS)
        if (res.ok) {
          const ab = await res.arrayBuffer()
          const bytes = Buffer.from(ab)
          // 只看 Content-Type 会被 200 的 HTML 错误页骗过去，所以以魔数为准；
          // 魔数不认识的图片格式（AVIF 等）再退回 Content-Type，别整张丢掉。
          const ct = ((res.headers.get('content-type') || '').split(';')[0] ?? '').trim().toLowerCase()
          const sniffed = sniffMime(bytes) ?? (ct.startsWith('image/') ? ct : null)
          if (bytes.length > 0 && bytes.length <= MAX_BYTES && sniffed) {
            buf = bytes
            mime = sniffed
          }
        }
      }
      if (!buf || !mime || !mime.startsWith('image/')) continue
      const id = makeId('att')
      const name = `生成图片-${out.length + 1}.${extFor(mime)}`
      await store.save(id, { kind: 'image', name, mime }, buf)
      out.push({ id, name, mime, size: buf.length })
    } catch (e) {
      diag.log({
        ts: Date.now(),
        layer: 'runtime',
        stage: 'answer-image',
        subject: modelId,
        sessionId,
        ok: false,
        detail: `第 ${i + 1} 张落库失败：${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }
  // 全部落空通常不是「这一轮没图」，而是下载被拦（Referer / 分区不对）：
  // 留一条汇总，省得下次又靠猜。
  if (urls.length && !out.length) {
    diag.log({
      ts: Date.now(),
      layer: 'runtime',
      stage: 'answer-image',
      subject: modelId,
      sessionId,
      ok: false,
      detail: `抓到的 ${urls.length} 张图一张都没落库（分区 ${partition}）`,
    })
  }
  return out
}

function withTimeout(p: Promise<Response>, ms: number): Promise<Response> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('图片下载超时')), ms)),
  ])
}
