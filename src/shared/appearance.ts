/**
 * 外观媒体：启动动画与主背景。
 *
 * 两件事共用同一套「用户选了本机一个文件」的路径：主进程把它复制进
 * `userData/torra/media/`，渲染层只拿到 `torra-media://` 地址。
 * 复制而不是记住原路径，是因为原文件会被移动、改名、删除 —— 设置里存一条
 * 早就失效的绝对路径，重启后用户看到的是「我明明选过」的黑屏。
 *
 * 这里只放两端都要认的词与归一化：主进程据此校验落盘，渲染层据此决定
 * 挂 `<video>` 还是 `<img>`。任何一端自己再猜一次格式，就会有两套口径。
 */

export type MediaSlot = 'startup' | 'background'
export type MediaKind = 'video' | 'image'

/** 落盘的那一条：文件名是主进程生成的，渲染层不拼路径 */
export interface MediaRef {
  file: string
  kind: MediaKind
}

export interface AppearanceState {
  startup: MediaRef | null
  background: (MediaRef & { dim: number }) | null
}

/** 交给渲染层的形态：地址已经带好缓存击穿串，渲染层不碰协议与 mtime */
export interface MediaView {
  url: string
  kind: MediaKind
}

export interface AppearanceView {
  startup: MediaView | null
  background: (MediaView & { dim: number }) | null
}

export const APPEARANCE_EMPTY: AppearanceState = { startup: null, background: null }

/** 遮罩浓度：太淡会吃掉正文对比度，太浓等于没设背景 */
export const MEDIA_DIM_MIN = 0.35
export const MEDIA_DIM_MAX = 0.92
export const MEDIA_DIM_DEFAULT = 0.62

/** 渲染层的初始值：还没问到主进程之前，一律当作「没设过」 */
export const APPEARANCE_VIEW_EMPTY: AppearanceView = { startup: null, background: null }

/**
 * 图片型启动动画停留多久。
 *
 * gif / webp 没有「播完了」这个事件，只能给一个时长。2.6s 是「看清了」
 * 与「别挡路」之间的一拍：比开议那块幕长一倍，因为它后面没有正在跑的讨论
 * 需要被揭开 —— 它只是开场。
 */
export const STARTUP_HOLD_MS = 2600
/** 视频型启动动画的上限：用户选了一支两分钟的片子，不该把应用锁两分钟 */
export const STARTUP_VIDEO_MAX_MS = 8000

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] as const
const VIDEO_EXT = ['mp4', 'm4v', 'webm'] as const

/** 只认小写扩展名，不认路径：调用方传进来的必须是纯文件名 */
export function mediaKindFor(file: unknown): MediaKind | null {
  if (typeof file !== 'string' || !file) return null
  const dot = file.lastIndexOf('.')
  if (dot < 0) return null
  const ext = file.slice(dot + 1).toLowerCase()
  if ((IMAGE_EXT as readonly string[]).includes(ext)) return 'image'
  if ((VIDEO_EXT as readonly string[]).includes(ext)) return 'video'
  return null
}

/** 文件名合法性：落盘文件名由主进程生成，这里挡的是手改过的 preferences.json */
export function isMediaFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(value) &&
    mediaKindFor(value) !== null
  )
}

export function clampMediaDim(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return MEDIA_DIM_DEFAULT
  return Math.min(MEDIA_DIM_MAX, Math.max(MEDIA_DIM_MIN, Math.round(n * 100) / 100))
}

/**
 * 偏好文件里那一段 → 可信状态。
 *
 * 坏了就整条当没设过：一个半截的 `{file:'x'}`（没有 kind）会在渲染层
 * 变成 `<video src>` 打不开的黑块，比没有背景更糟。
 */
export function normalizeAppearance(raw: unknown): AppearanceState {
  const o = (raw ?? {}) as Record<string, unknown>
  const ref = (v: unknown): MediaRef | null => {
    const r = (v ?? {}) as Record<string, unknown>
    const file = r.file
    if (!isMediaFileName(file)) return null
    const kind = mediaKindFor(file)
    if (!kind || r.kind !== kind) return null
    return { file, kind }
  }
  const background = ref(o.background)
  return {
    startup: ref(o.startup),
    background: background ? { ...background, dim: clampMediaDim((o.background as Record<string, unknown>).dim) } : null,
  }
}

/**
 * 解析 `Range: bytes=a-b`（视频播放要 206 分段，Chromium 不认一次性全量）。
 *
 * 三种结果分开，因为调用方要回不同的状态码：
 * `undefined` = 没有 Range / 读不懂 → 整份 200；`null` = 范围越界 → 416；
 * 否则就是该切哪一段。读不懂时给 200 而不是 416：一个古怪的 Range 头
 * 不该让整个文件变成「不可播放」。
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): { start: number; end: number } | null | undefined {
  if (!header) return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return undefined
  const a = m[1] ?? ''
  const b = m[2] ?? ''
  if (!a && !b) return undefined
  let start: number
  let end: number
  if (!a) {
    // bytes=-N：最后 N 个字节
    const n = Number(b)
    if (!Number.isFinite(n) || n <= 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(a)
    end = b ? Number(b) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start >= size) return null
  end = Math.min(end, size - 1)
  if (end < start) return null
  return { start, end }
}

/**
 * 按文件头认格式：扩展名可以被随手改，字节不会。
 *
 * 与 `mediaKindFor` 是一对：前者看名字，后者看内容，主进程要求两者一致 ——
 * 一个改了扩展名的 mkv 会在 `<video>` 里静默失败，不如在选择时就拒掉。
 */
export function sniffMediaKind(buf: Uint8Array): MediaKind | null {
  if (buf.length < 12) return null
  const at = (from: number, to: number): string =>
    Array.from(buf.slice(from, to))
      .map((b) => String.fromCharCode(b))
      .join('')
  if (buf[0] === 0x89 && at(1, 4) === 'PNG') return 'image'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image'
  if (at(0, 4) === 'GIF8') return 'image'
  if (at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return 'image'
  if (at(4, 8) === 'ftyp') {
    // ftyp 同时是 HEIC/AVIF 的容器头，按 major brand 分开
    const brand = at(8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image'
    return 'video'
  }
  // EBML：webm / mkv 共用
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video'
  return null
}
