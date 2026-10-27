export const TORRA_UI_FRAME_SCHEME = 'torra-ui'
export const TORRA_UI_FRAME_HOST = 'frame'
export const TORRA_UI_FRAME_MAX_BYTES = 160 * 1024

export const TORRA_UI_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
].join('; ')

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function torraUiFrameUrl(document: string): string {
  const bytes = utf8Bytes(document)
  if (!bytes.length || bytes.length > TORRA_UI_FRAME_MAX_BYTES) {
    throw new Error(`Torra UI frame must be 1-${TORRA_UI_FRAME_MAX_BYTES} bytes`)
  }
  return `${TORRA_UI_FRAME_SCHEME}://${TORRA_UI_FRAME_HOST}/${bytesToBase64Url(bytes)}`
}

export type TorraUiFrameDecodeResult =
  | { ok: true; document: string }
  | { ok: false; status: 400 | 413; reason: string }

export function decodeTorraUiFrameUrl(requestUrl: string): TorraUiFrameDecodeResult {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return { ok: false, status: 400, reason: 'Invalid frame URL' }
  }
  if (url.protocol !== `${TORRA_UI_FRAME_SCHEME}:` || url.hostname !== TORRA_UI_FRAME_HOST) {
    return { ok: false, status: 400, reason: 'Invalid frame URL' }
  }

  const payload = url.pathname.replace(/^\/+/, '')
  if (!payload || !BASE64URL_RE.test(payload)) {
    return { ok: false, status: 400, reason: 'Invalid frame payload' }
  }

  let binary: string
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      payload.length + ((4 - (payload.length % 4)) % 4),
      '=',
    )
    binary = atob(padded)
  } catch {
    return { ok: false, status: 400, reason: 'Invalid frame payload' }
  }

  if (binary.length > TORRA_UI_FRAME_MAX_BYTES) {
    return { ok: false, status: 413, reason: 'Frame payload too large' }
  }

  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  let document: string
  try {
    document = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, status: 400, reason: 'Invalid frame encoding' }
  }
  if (!document.trim()) {
    return { ok: false, status: 400, reason: 'Empty frame document' }
  }
  return { ok: true, document }
}

const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

export function torraUiFrameResponse(requestUrl: string): Response {
  const decoded = decodeTorraUiFrameUrl(requestUrl)
  if (!decoded.ok) {
    return new Response(decoded.reason, {
      status: decoded.status,
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'text/plain; charset=utf-8',
      },
    })
  }

  return new Response(decoded.document, {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      'Content-Security-Policy': TORRA_UI_FRAME_CSP,
      'Content-Type': 'text/html; charset=utf-8',
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=()',
    },
  })
}
