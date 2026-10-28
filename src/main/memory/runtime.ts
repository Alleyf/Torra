/**
 * memvid 运行时：找可执行文件、问版本、按需下载。
 *
 * 为什么 Torra 自己托管这份二进制，而不是让用户 `npm i -g`：
 * memvid 的 npm 包拆成平台子包（`@memvid/cli-win32-x64` 等），每个包是 27MB 的 exe
 * 加一批 DLL（JVM / Tika，解包约 137MB）。用户机器上有没有 Node、npm 前缀在不在 PATH、
 * 全局安装权限够不够，全是不可控的；而这块能力要能在第一次打开设置页时就自证可用。
 * 所以：优先用用户指定的、其次用托管目录、最后才找 PATH —— 三条路都失败时界面会说清楚。
 *
 * 三条实测约束：
 *
 * 1. **exe 必须和 DLL 待在一起**。运行时按自身目录解析 DLL，单独把 memvid.exe 抄出来跑不起来。
 * 2. **CLI 版本会漂**。包里报的是 2.0.140，而 npm 包版本是 2.0.160 —— 版本号以实际 `--version`
 *    输出为准，界面上不拿包版本冒充。
 * 3. **tgz 解包不能一把梭在字符串上**。137MB 的 tar 里有 pax 头（mtime 精度），
 *    名字可能由 pax 的 `path=` 覆盖；解析器必须处理它，否则会把文件写到截断的名字上。
 */

import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { promises as fs, mkdirSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import type { MemoryRuntimeSource } from '../../shared/memory'

/** 固定版本而不是 latest：托管目录里的二进制与库文件格式已经验证过，不受上游发版影响 */
export const MEMVID_PKG_VERSION = '2.0.160'

export interface MemvidRunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 跑一次 memvid。
 *
 * cwd 设在 exe 所在目录：Windows 的 DLL 搜索路径包含可执行文件目录，但显式对齐一次
 * 可以避免「从别的目录启动就找不到 jvm.dll」这类只在打包后出现的差异。
 */
export function runMemvid(
  exe: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<MemvidRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      {
        cwd: path.dirname(exe),
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`找不到 memvid 可执行文件：${exe}`))
          return
        }
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as unknown as { code: number }).code
            : err
              ? 1
              : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

export function exeNameFor(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'memvid.exe' : 'memvid'
}

/** 平台子包名；不支持的平台返回 null（宁可在界面上说「这台机器没有」，也不去猜包名） */
export function platformPackage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'win32' && arch === 'x64') return '@memvid/cli-win32-x64'
  if (platform === 'linux' && arch === 'x64') return '@memvid/cli-linux-x64'
  if (platform === 'darwin' && arch === 'arm64') return '@memvid/cli-darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return '@memvid/cli-darwin-x64'
  return null
}

export function tarballUrl(pkg: string, version = MEMVID_PKG_VERSION): string {
  const short = pkg.split('/').pop() ?? pkg
  return `https://registry.npmjs.org/${pkg}/-/${short}-${version}.tgz`
}

/** `where` / `which` 找 PATH 上的 memvid；找不到返回 null（不是错误） */
export async function findOnPath(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const finder = platform === 'win32' ? 'where' : 'which'
  const exe = exeNameFor(platform)
  try {
    const r = await runMemvid(finder, [exe], { timeoutMs: 5_000 })
    if (r.code !== 0) return null
    const first = r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && existsSync(s))
    return first ?? null
  } catch {
    return null
  }
}

export interface LocateResult {
  path: string
  source: MemoryRuntimeSource
  /** 用户手填了路径但那个文件不存在 —— 界面要报出来，不能悄悄回落到别处 */
  configuredMissing?: string
}

export async function locateMemvid(opts: {
  configured: string
  managedDir: string
  platform?: NodeJS.Platform
}): Promise<LocateResult | null> {
  const platform = opts.platform ?? process.platform
  const configured = opts.configured.trim()
  if (configured) {
    if (path.isAbsolute(configured) && existsSync(configured) && isFile(configured)) {
      return { path: configured, source: 'configured' }
    }
    // 填了但不可用：继续往托管/PATH 找，同时把「你填的那个不对」带回去
    const fallback = await locateFallback(opts.managedDir, platform)
    return fallback ? { ...fallback, configuredMissing: configured } : { path: '', source: 'none', configuredMissing: configured }
  }
  return locateFallback(opts.managedDir, platform)
}

async function locateFallback(managedDir: string, platform: NodeJS.Platform): Promise<LocateResult | null> {
  const managed = path.join(managedDir, exeNameFor(platform))
  if (existsSync(managed) && isFile(managed)) return { path: managed, source: 'managed' }
  const onPath = await findOnPath(platform)
  return onPath ? { path: onPath, source: 'path' } : null
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** 版本只取 `--version` 的第一行；读不出来返回 undefined，界面显示「未知」 */
export async function memvidVersion(exe: string): Promise<string | undefined> {
  try {
    const r = await runMemvid(exe, ['--version'], { timeoutMs: 10_000 })
    const line = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    return line || undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// tar.gz 解包
// ---------------------------------------------------------------------------

export interface TarEntry {
  name: string
  type: 'file' | 'dir' | 'other'
  data: Buffer
}

function readStr(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len)
  const zero = slice.indexOf(0)
  return (zero >= 0 ? slice.subarray(0, zero) : slice).toString('utf8')
}

function octal(buf: Buffer, start: number, len: number): number {
  const s = readStr(buf, start, len).trim()
  if (!s) return 0
  const n = Number.parseInt(s, 8)
  return Number.isFinite(n) ? n : 0
}

/** pax 记录形如 `27 path=package/memvid.exe\n`：只认 path，其余键（mtime 等）不用 */
function paxPath(body: Buffer): string | null {
  const text = body.toString('utf8')
  const m = text.match(/(?:^|\n)\d+ path=([^\n]*)\n/)
  return m?.[1] ?? null
}

/**
 * 解析 tar（已在内存里，且已解压）。
 *
 * 只认普通文件与目录：链接、设备文件一律跳过 —— 这个包是 npm 打的，里面不该有，
 * 真出现了也不该由我们去还原一个「指向哪儿都行」的链接。
 */
export function parseTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = []
  let off = 0
  let nextPath: string | null = null
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const size = octal(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156] || 48)
    const name = nextPath ?? [readStr(header, 345, 155), readStr(header, 0, 100)].filter(Boolean).join('/')
    const dataStart = off + 512
    const dataEnd = Math.min(dataStart + size, tar.length)
    const data = tar.subarray(dataStart, dataEnd)
    off = dataStart + size + ((512 - (size % 512)) % 512)

    if (typeFlag === 'x' || typeFlag === 'g') {
      const p = paxPath(data)
      if (typeFlag === 'x' && p) nextPath = p
      continue
    }
    nextPath = null
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '7') out.push({ name, type: 'file', data })
    else if (typeFlag === '5') out.push({ name, type: 'dir', data: Buffer.alloc(0) })
    else out.push({ name, type: 'other', data: Buffer.alloc(0) })
  }
  return out
}

/** 把条目名归一成目标目录里的相对路径；越界（绝对路径 / `..`）直接拒绝 */
export function safeEntryPath(destDir: string, name: string): string | null {
  const parts = name.split('/').filter((s) => s && s !== '.')
  if (!parts.length) return null
  if (parts.some((s) => s === '..') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null
  const dest = path.resolve(destDir, ...parts)
  const rel = path.relative(path.resolve(destDir), dest)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return dest
}

/** 解到目标目录；返回写出的文件数。失败抛出（调用方负责收尾临时目录） */
export async function extractTar(tar: Buffer, destDir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const e of parseTar(tar)) {
    if (e.type === 'dir') {
      const dest = safeEntryPath(destDir, e.name)
      if (dest) mkdirSync(dest, { recursive: true })
      continue
    }
    if (e.type !== 'file') continue
    const dest = safeEntryPath(destDir, e.name)
    if (!dest) throw new Error(`压缩包里有一条越界路径：${e.name}`)
    mkdirSync(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, e.data)
    files++
    bytes += e.data.length
  }
  return { files, bytes }
}

/** 解压 .tgz（读盘 → gunzip → 解包）。逐段回调进度的只有下载那一段 */
export async function extractTarGz(tgzPath: string, destDir: string): Promise<{ files: number; bytes: number }> {
  const gz = await fs.readFile(tgzPath)
  const tar = await new Promise<Buffer>((resolve, reject) => {
    const gunzip = createGunzip()
    const chunks: Buffer[] = []
    gunzip.on('data', (c: Buffer) => chunks.push(c))
    gunzip.on('end', () => resolve(Buffer.concat(chunks)))
    gunzip.on('error', reject)
    Readable.from(gz).pipe(gunzip)
  })
  return extractTar(tar, destDir)
}

export interface DownloadProgress {
  received: number
  total: number
}

/** 下载到文件并回调进度；返回字节数。非 2xx 直接报错（不把错误页当成包解） */
export async function downloadTo(
  url: string,
  destFile: string,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<number> {
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`)
  }
  const total = Number(res.headers.get('content-length') ?? 0) || 0
  mkdirSync(path.dirname(destFile), { recursive: true })
  let received = 0
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress?.({ received, total })
  })
  await pipeline(body, createWriteStream(destFile))
  onProgress?.({ received, total })
  return received
}

/** 托管目录：`<dataDir>/memory/bin/<pkg 短名>-<版本>/` */
export function managedDirFor(binRoot: string, pkg: string, version = MEMVID_PKG_VERSION): string {
  return path.join(binRoot, `${pkg.split('/').pop() ?? 'memvid'}-${version}`)
}
