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
  `https://api.iowen.cn/favicon/${domain}.png`,
  `https://favicon.im/${domain}`,
  `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
  `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  `https://favicon.yandex.net/favicon/v2/${domain}?size=32`,
  `https://logo.clearbit.com/${domain}`,
]

// 只允许纯域名：杜绝路径穿越与 Windows 非法文件名字符
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i
const NEG_TTL_MS = 30 * 60_000
const FETCH_TIMEOUT_MS = 6_000

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
    let domain = ''
    try {
      domain = new URL(request.url).hostname
    } catch {
      /* 非法 URL 走下面的 400 */
    }
    if (!DOMAIN_RE.test(domain) || domain.length > 253) {
      return new Response('bad domain', { status: 400 })
    }
    const buf = await getFavicon(domain)
    if (!buf) return new Response('not found', { status: 404 })
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': sniffMime(buf) ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=604800',
        // 渲染层部分 <img> 带 crossOrigin="anonymous"，缺这个头会被 CORS 拦
        'Access-Control-Allow-Origin': '*',
      },
    })
  })
}

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'torra', 'icons')
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
