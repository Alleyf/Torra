/**
 * 启动动画与主背景的落盘、寻址与投递。
 *
 * 为什么由主进程复制文件而不是记住原路径：用户在设置里挑的是「桌面上的那个
 * mp4」。原文件会被移动、改名、丢进回收站 —— 存一条绝对路径，下次启动就是
 * 一块打不开的黑屏，而设置页还显示「已设置」。复制一份进 userData 之后，
 * 选择即刻成为应用的资产，原文件随用户处置。
 *
 * 为什么走 `torra-media://` 而不是 `file://`：渲染层是 sandbox + contextIsolation，
 * CSP 只放行具名方案；`file://` 还会把 `C:\Users\…` 这类本机路径写进 DOM。
 * 自定义方案同时给了我们一件事：文件名由主进程生成，路径穿越在方案层就断了。
 *
 * 视频必须支持 Range：Chromium 的 <video> 用 206 分段读，不认「一次性 200 全量」，
 * 300 MB 的片子也不能先读进内存再吐。
 */
import { app, dialog, protocol } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import {
  MEDIA_DIM_DEFAULT,
  clampMediaDim,
  isMediaFileName,
  mediaKindFor,
  normalizeAppearance,
  parseByteRange,
  sniffMediaKind,
  type AppearanceState,
  type AppearanceView,
  type MediaKind,
  type MediaRef,
  type MediaSlot,
} from '../../shared/appearance'

import { findPreset, isPresetFile } from '../../shared/media-presets'

/** 图片型上限：启动动画与背景图都吃不满这个数 */
const IMAGE_MAX_BYTES = 40 * 1024 * 1024
/** 视频型上限：足够放一支 4K 十秒的片头，又不至于把 userData 撑爆 */
const VIDEO_MAX_BYTES = 300 * 1024 * 1024

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
}

const PICK_FILTERS = [
  { name: '动图 / 视频', extensions: ['gif', 'webp', 'apng', 'png', 'mp4', 'm4v', 'webm'] },
  { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] },
  { name: '视频', extensions: ['mp4', 'm4v', 'webm'] },
]

export interface AppearanceDeps {
  /** userData/torra/media */
  dir: string
  /** 内置预设目录（resources/media/），只读 */
  presetDir: string
  read: () => Promise<Record<string, unknown>>
  patch: (patch: Record<string, unknown>) => Promise<void>
}

let deps: AppearanceDeps | null = null

/** 必须在 app ready 之前调用（与 favicon 那条同一条规矩） */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'torra-media',
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
    },
  ])
}

export function initAppearance(next: AppearanceDeps): void {
  deps = next
  protocol.handle('torra-media', serveMedia)
}

function requireDeps(): AppearanceDeps {
  if (!deps) throw new Error('appearance 尚未初始化')
  return deps
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------


function extOf(file: string): string {
  return file.slice(file.lastIndexOf('.') + 1).toLowerCase()
}

/**
 * 读偏好里的外观状态。
 *
 * 缺键（从来没设置过）→ 出厂默认：内置的启动动画与主背景。
 * 有键（哪怕值是 null，即用户点过「移除」）→ 完全以用户为准，不再塞回默认 ——
 * 否则「移除背景」按下去，下一次启动它又回来了。
 *
 * 判据是 `appearance` 这一段存不存在，不是两个槽位各自有没有值：
 * 用户移除启动动画、只留背景时，写下去的也是 `{startup: null, background: {...}}`，
 * 那一段存在就说明这个人已经表过态了。
 */
async function readState(): Promise<AppearanceState> {
  const prefs = await requireDeps().read()
  if (prefs.appearance === undefined) return factoryAppearance()
  return normalizeAppearance(prefs.appearance)
}

/** 出厂默认：随程序分发的那两支，用户可一键切走，也随时切得回来 */
export function factoryAppearance(): AppearanceState {
  const startup = findPreset('startup-default')
  const background = findPreset('background-default')
  return {
    startup: startup ? { preset: startup.id, kind: startup.kind } : null,
    background: background
      ? { preset: background.id, kind: background.kind, dim: background.dim ?? MEDIA_DIM_DEFAULT }
      : null,
  }
}

async function writeState(state: AppearanceState): Promise<void> {
  await requireDeps().patch({ appearance: state })
}

/** 同名槽位只留一份：换格式时把上一份删掉，否则 userData 里会攒下几百兆死文件 */
async function sweepSlot(slot: MediaSlot, keep: string): Promise<void> {
  const dir = requireDeps().dir
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((n) => n !== keep && n.startsWith(`${slot}-`))
      .map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => undefined)),
  )
}

export async function saveAppearanceMedia(
  slot: MediaSlot,
  source: string,
): Promise<{ ok: true; state: AppearanceState } | { ok: false; reason: string }> {
  if (slot !== 'startup' && slot !== 'background') return { ok: false, reason: '未知的位置' }
  try {
    const stat = await fs.stat(source)
    if (!stat.isFile()) return { ok: false, reason: '请选择文件' }
    // 先按扩展名给一个上限，再按真实字节复核 —— 反过来会让 300 MB 的文件先被整个读进来
    const kind = mediaKindFor(path.basename(source))
    if (!kind) return { ok: false, reason: '只支持 GIF、WebP、PNG、JPEG、AVIF 或 MP4、M4V、WebM' }
    const cap = kind === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES
    if (stat.size > cap) {
      return { ok: false, reason: `文件超过 ${Math.round(cap / 1024 / 1024)} MB` }
    }
    if (stat.size === 0) return { ok: false, reason: '文件是空的' }
    const head = Buffer.alloc(32)
    const fh = await fs.open(source, 'r')
    try {
      await fh.read(head, 0, head.length, 0)
    } finally {
      await fh.close()
    }
    if (sniffMediaKind(head) !== kind) return { ok: false, reason: '文件内容与扩展名对不上' }

    const dir = requireDeps().dir
    await fs.mkdir(dir, { recursive: true })
    // 换一份新名字再落盘：正在播放的 <video> 指着旧文件，原地覆盖会让画面断在半路
    const stamp = Date.now().toString(36)
    const name = `${slot}-${stamp}.${extOf(source)}`
    await fs.copyFile(source, path.join(dir, name))
    await sweepSlot(slot, name)

    const state = await readState()
    const next: AppearanceState = {
      startup: slot === 'startup' ? { file: name, kind } : state.startup,
      background:
        slot === 'background'
          ? { file: name, kind, dim: state.background?.dim ?? clampMediaDim(undefined) }
          : state.background,
    }
    await writeState(next)
    return { ok: true, state: next }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    // 原始 ENOENT 会带着整条绝对路径出现在设置页上；用户只需要知道「那个文件不在了」
    if (err.code === 'ENOENT') return { ok: false, reason: '文件已经不在那个位置了' }
    return { ok: false, reason: err.message }
  }
}

export async function clearAppearanceMedia(slot: MediaSlot): Promise<AppearanceState> {
  const state = await readState()
  const next: AppearanceState = {
    startup: slot === 'startup' ? null : state.startup,
    background: slot === 'background' ? null : state.background,
  }
  await writeState(next)
  await sweepSlot(slot, '')
  return next
}

export async function setAppearanceDim(raw: unknown): Promise<AppearanceState> {
  const state = await readState()
  if (!state.background) return state
  const next: AppearanceState = { ...state, background: { ...state.background, dim: clampMediaDim(raw) } }
  await writeState(next)
  return next
}

// ---------------------------------------------------------------------------
// 投递
// ---------------------------------------------------------------------------

/**
 * mtime 进查询串：换一份背景后 Chromium 不会继续命中旧文件的缓存。
 * 文件名本身每次都是新的，这一层是给「手改 preferences.json 指回旧文件」留的。
 */
async function viewOf(state: AppearanceState): Promise<AppearanceView> {
  const dir = requireDeps().dir
  const presetDir = requireDeps().presetDir
  /**
   * 一条引用 → 可播放地址。预设走 `torra-media://preset/<file>`，
   * 用户上传的走 `torra-media://media/<file>` —— 两条目录不同，
   * 所以地址里必须写明是哪一种，不能靠文件名去猜。
   */
  const url = async (ref: MediaRef): Promise<string | undefined> => {
    const preset = findPreset(ref.preset)
    const base = preset ? presetDir : dir
    const file = preset ? preset.file : ref.file
    if (!file) return undefined
    try {
      const stat = await fs.stat(path.join(base, file))
      if (!stat.isFile() || stat.size === 0) return undefined
      const seg = preset ? 'preset' : 'media'
      return `torra-media://${seg}/${encodeURIComponent(file)}?v=${Math.floor(stat.mtimeMs)}`
    } catch {
      return undefined
    }
  }
  const startupUrl = state.startup ? await url(state.startup) : undefined
  const bgUrl = state.background ? await url(state.background) : undefined
  return {
    startup:
      startupUrl && state.startup
        ? { url: startupUrl, kind: state.startup.kind, preset: state.startup.preset }
        : null,
    background:
      bgUrl && state.background
        ? { url: bgUrl, kind: state.background.kind, dim: state.background.dim, preset: state.background.preset }
        : null,
  }
}

export async function appearanceView(): Promise<AppearanceView> {
  return viewOf(await readState())
}

/**
 * 只负责弹窗，不碰文件。
 *
 * 选文件与「把文件收进来」拆成两步，是因为前者是系统对话框（跑不了自动验证）、
 * 后者是纯文件操作（能）。合在一起时，那条复制路径永远只有人手点过一次。
 */
export async function pickAppearanceFile(slot: MediaSlot): Promise<{ ok: boolean; path?: string }> {
  const picked = await dialog.showOpenDialog({
    title: slot === 'startup' ? '选择启动动画' : '选择主背景',
    properties: ['openFile'],
    filters: PICK_FILTERS,
  })
  if (picked.canceled || !picked.filePaths[0]) return { ok: false }
  return { ok: true, path: picked.filePaths[0] }
}

/** 把用户选中的文件收进 media 目录并写进偏好 */
export async function applyAppearanceMedia(
  slot: MediaSlot,
  source: string,
): Promise<{ ok: boolean; view: AppearanceView; reason?: string }> {
  const saved = await saveAppearanceMedia(slot, source)
  if (!saved.ok) return { ok: false, view: await appearanceView(), reason: saved.reason }
  return { ok: true, view: await viewOf(saved.state) }
}

/**
 * 套用一份内置预设。
 *
 * 写进偏好的是 `preset: <id>`，不是「把预设复制一份到 media/ 再指过去」：
 * 复制会留下一份永远不更新的副本，程序升级换了预设文件之后，
 * 用户看到的还是旧的那一支。清空时只需把那一格置 null，不动用户自己的文件。
 */
export async function applyAppearancePreset(
  slot: MediaSlot,
  presetId: unknown,
): Promise<{ ok: boolean; view: AppearanceView; reason?: string }> {
  const preset = findPreset(presetId)
  if (!preset) return { ok: false, view: await appearanceView(), reason: '没有这个预设' }
  if (preset.slot !== slot) {
    return { ok: false, view: await appearanceView(), reason: `这个预设属于「${preset.slot}」，不能装到「${slot}」` }
  }
  // 文件不在（打包漏了）就不要写进偏好：写了之后界面会显示「已设置」却播放不出来
  try {
    const stat = await fs.stat(path.join(requireDeps().presetDir, preset.file))
    if (!stat.isFile() || stat.size === 0) {
      return { ok: false, view: await appearanceView(), reason: `预设文件缺失：${preset.file}` }
    }
  } catch {
    return { ok: false, view: await appearanceView(), reason: `预设文件缺失：${preset.file}` }
  }
  const state = await readState()
  const next: AppearanceState = {
    startup: slot === 'startup' ? { preset: preset.id, kind: preset.kind } : state.startup,
    background:
      slot === 'background'
        ? { preset: preset.id, kind: preset.kind, dim: preset.dim ?? MEDIA_DIM_DEFAULT }
        : state.background,
  }
  await writeState(next)
  return { ok: true, view: await viewOf(next) }
}

async function serveMedia(request: Request): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response('bad url', { status: 400 })
  }
  /**
   * 两段路径：`media/<file>` 是用户上传的，`preset/<file>` 是内置预设。
   * 预设只认清单里出现过的文件名 —— 少了这一道，`torra-media://preset/`
   * 就等于把 resources/ 目录整个暴露给渲染层。
   */
  const seg = url.hostname
  const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (!isMediaFileName(file)) return new Response('bad file', { status: 400 })
  const base =
    seg === 'preset'
      ? isPresetFile(file)
        ? requireDeps().presetDir
        : null
      : seg === 'media'
        ? requireDeps().dir
        : null
  if (!base) return new Response('bad path', { status: 400 })
  const full = path.join(base, file)
  // 方案层已经只认纯文件名，这一行挡的是「拼出来还是跑到目录外面」
  if (path.dirname(path.resolve(full)) !== path.resolve(base)) {
    return new Response('bad path', { status: 400 })
  }
  let size: number
  try {
    const stat = await fs.stat(full)
    if (!stat.isFile()) return new Response('not found', { status: 404 })
    size = stat.size
  } catch {
    return new Response('not found', { status: 404 })
  }

  const type = MIME[extOf(file)] ?? 'application/octet-stream'
  const range = parseByteRange(request.headers.get('Range'), size)
  if (range === null) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    })
  }
  if (!range) {
    return new Response(Readable.toWeb(createReadStream(full)) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }
  return new Response(Readable.toWeb(createReadStream(full, { start: range.start, end: range.end })) as ReadableStream, {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

/** 让 `app.getPath` 在模块加载期不被动用：目录在 app ready 之后才可问 */
export function mediaDir(): string {
  return path.join(app.getPath('userData'), 'torra', 'media')
}
