/**
 * favicon 磁盘缓存：torra-icon://<domain>
 *
 * 渲染层过去每次挂载都直连 6 个外部 favicon 源（无持久缓存，Electron 磁盘缓存
 * 对这类第三方响应不保证留存）。这里由主进程抓一次、落盘到
 * userData/torra/icons/<domain>，之后所有页面（模型栏/聊天/设置/网页坞）
 * 都从本地读。抓取失败记 30 分钟负缓存，避免每帧重打外网；
 * 渲染层保留原 https 链作为兜底，行为不回退。
 */
import { app, net, protocol } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const SOURCES = (domain: string): string[] => [
  // favicon.im 在实测环境里最稳定，放在经常超时的第三方源前面
  `https://favicon.im/${domain}?size=64`,
  `https://api.iowen.cn/favicon/${domain}.png`,
  `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
  `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  `https://favicon.yandex.net/favicon/v2/${domain}?size=64`,
  `https://logo.clearbit.com/${domain}`,
]

// 只允许纯域名：杜绝路径穿越与 Windows 非法文件名字符
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i
const MODEL_ID_RE = /^[a-z0-9-]{1,64}$/
const NEG_TTL_MS = 30 * 60_000
const FETCH_TIMEOUT_MS = 6_000
const CUSTOM_ICON_MAX_BYTES = 2 * 1024 * 1024

const failedAt = new Map<string, number>()
const inflight = new Map<string, Promise<Buffer | null>>()

export function registerFaviconScheme(): void {
  // 必须在 app ready 之前注册特权方案
  protocol.registerSchemesAsPrivileged([
    { scheme: 'torra-icon', privileges: { standard: true, secure: true, stream: true } },
  ])
}

export function installFaviconProtocol(): void {
  protocol.handle('torra-icon', async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    if (url.hostname === 'custom') {
      const modelId = url.pathname.replace(/^\/+/, '')
      if (!MODEL_ID_RE.test(modelId)) return new Response('bad model id', { status: 400 })
      const custom = await readCustomIcon(modelId)
      if (!custom) return new Response('not found', { status: 404 })
      return imageResponse(custom, 'no-cache')
    }
    const domain = url.hostname
    if (!DOMAIN_RE.test(domain) || domain.length > 253) {
      return new Response('bad domain', { status: 400 })
    }
    const buf = await getFavicon(domain)
    if (!buf) return new Response('not found', { status: 404 })
    return imageResponse(buf, 'public, max-age=604800')
  })
}

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'torra', 'icons')
}

function customIconDir(): string {
  return path.join(cacheDir(), 'custom')
}

function customIconFile(modelId: string): string {
  return path.join(customIconDir(), modelId)
}

function imageResponse(buf: Buffer, cacheControl: string): Response {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': sniffMime(buf) ?? 'application/octet-stream',
      'Cache-Control': cacheControl,
      // 渲染层部分 <img> 带 crossOrigin="anonymous"，缺这个头会被 CORS 拦
      'Access-Control-Allow-Origin': '*',
    },
  })
}

async function readCustomIcon(modelId: string): Promise<Buffer | null> {
  if (!MODEL_ID_RE.test(modelId)) return null
  try {
    const buf = await fs.readFile(customIconFile(modelId))
    return buf.length && sniffMime(buf) ? buf : null
  } catch {
    return null
  }
}

/** 从用户选中的图片复制一份到本机图标目录；只接受可识别的图片格式。 */
export async function saveCustomIcon(
  modelId: string,
  source: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!MODEL_ID_RE.test(modelId)) return { ok: false, reason: '模型 ID 非法' }
  try {
    const stat = await fs.stat(source)
    if (!stat.isFile()) return { ok: false, reason: '请选择图片文件' }
    if (stat.size > CUSTOM_ICON_MAX_BYTES) return { ok: false, reason: '图标不能超过 2 MB' }
    const buf = await fs.readFile(source)
    if (!sniffMime(buf)) return { ok: false, reason: '只支持 PNG、JPEG、GIF、WebP、ICO 或 SVG 图片' }
    await fs.mkdir(customIconDir(), { recursive: true })
    await fs.writeFile(customIconFile(modelId), buf)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}

export async function deleteCustomIcon(modelId: string): Promise<void> {
  if (!MODEL_ID_RE.test(modelId)) return
  await fs.rm(customIconFile(modelId), { force: true }).catch(() => undefined)
}

/** mtime 作为查询串，换图后不会继续命中 Chromium 的旧图片缓存。 */
export async function customIconUrl(modelId: string): Promise<string | undefined> {
  if (!MODEL_ID_RE.test(modelId)) return undefined
  try {
    const stat = await fs.stat(customIconFile(modelId))
    if (!stat.isFile() || stat.size === 0) return undefined
    return `torra-icon://custom/${modelId}?v=${Math.floor(stat.mtimeMs)}`
  } catch {
    return undefined
  }
}

async function getFavicon(domain: string): Promise<Buffer | null> {
  const file = path.join(cacheDir(), domain)
  try {
    const cached = await fs.readFile(file)
    if (cached.length) return cached
  } catch {
    /* 未缓存 */
  }
  const neg = failedAt.get(domain)
  if (neg && Date.now() - neg < NEG_TTL_MS) return null
  let job = inflight.get(domain)
  if (!job) {
    job = fetchAndSave(domain, file).finally(() => inflight.delete(domain))
    inflight.set(domain, job)
  }
  return job
}

async function fetchAndSave(domain: string, file: string): Promise<Buffer | null> {
  for (const url of SOURCES(domain)) {
    try {
      const res = await net.fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'image/*' },
      })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (!sniffMime(buf)) continue // 200 回 HTML 的假图源直接跳过
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, buf)
      return buf
    } catch {
      /* 换下一个源 */
    }
  }
  failedAt.set(domain, Date.now())
  return null
}

/** 按魔数识别图片类型；认不出来就视为非图片（不缓存、不渲染） */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x8950_4e47) return 'image/png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif'
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.length > 4 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) return 'image/x-icon'
  const head = buf.toString('utf8', 0, Math.min(buf.length, 64)).trim()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  return null
}
