/**
 * 最小 ZIP 解包（store / deflate），只服务于「从 zip 安装插件」。
 *
 * 为什么自己解而不用依赖：仓库里现成的 unzipper / extract-zip 都是传递依赖，
 * 哪天上游换版本就静默消失；而这里需要的东西很少 —— 中央目录 + local header，
 * 一百多行能写完，还能把三道闸门写死在一起：路径穿越、符号链接、解压炸弹。
 *
 * 不支持 ZIP64（插件包不该有 4GB），遇到就明确报错，不猜。
 */

import { inflateRawSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const MAX_ZIP_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 512
const MAX_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
/** 解压比上限：正常文本包远低于它，超了按炸弹处理 */
const MAX_RATIO = 400

export class ZipError extends Error {}

interface Entry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
  externalAttrs: number
}

function findEocd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

function readEntries(buf: Buffer): Entry[] {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new ZipError('不是有效的 zip：找不到中央目录')
  const count = buf.readUInt16LE(eocd + 10)
  if (count > MAX_ENTRIES) throw new ZipError(`zip 里文件太多（${count} 个，上限 ${MAX_ENTRIES}）`)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff || cdOffset >= buf.length) throw new ZipError('ZIP64 或损坏的中央目录不受支持')

  const entries: Entry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new ZipError('中央目录损坏（条目签名不对）')
    }
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const externalAttrs = buf.readUInt32LE(p + 38)
    const localOffset = buf.readUInt32LE(p + 42)
    if (compressedSize === 0xffffffff || size === 0xffffffff) throw new ZipError('不支持 ZIP64 条目')
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ name, method, compressedSize, size, localOffset, externalAttrs })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 入口路径只允许落在目标目录内部；`..`、绝对路径、盘符都拒绝 */
function safeTarget(root: string, name: string): string {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ZipError(`zip 里有绝对路径条目：${name}`)
  }
  if (normalized.split('/').some((seg) => seg === '..')) {
    throw new ZipError(`zip 里有跳出目录的条目：${name}`)
  }
  const target = path.resolve(root, normalized)
  const rel = path.relative(path.resolve(root), target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ZipError(`zip 条目落在了目标目录外：${name}`)
  return target
}

/**
 * 解到 destDir。返回写出的文件数：0 个文件等于装了个空壳，调用方应当当失败处理。
 */
export function extractZip(zipPath: string, destDir: string): { files: number } {
  const buf = readFileSync(zipPath)
  if (buf.length > MAX_ZIP_BYTES) throw new ZipError(`zip 超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB 上限`)
  const entries = readEntries(buf)
  let total = 0
  let files = 0
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    // 高 16 位是 unix mode：0xA000 是符号链接，写出来等于把目标指到任意路径
    const mode = (entry.externalAttrs >>> 16) & 0xf000
    if (mode === 0xa000) throw new ZipError(`zip 里有符号链接：${entry.name}`)
    if (entry.size > MAX_ENTRY_BYTES) throw new ZipError(`条目「${entry.name}」超过 ${MAX_ENTRY_BYTES / 1024 / 1024}MB`)
    total += entry.size
    if (total > MAX_TOTAL_BYTES) throw new ZipError(`解压后总大小超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB`)
    if (entry.compressedSize > 0 && entry.size / entry.compressedSize > MAX_RATIO) {
      throw new ZipError(`条目「${entry.name}」解压比异常，按压缩炸弹拒绝`)
    }

    const local = entry.localOffset
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIG) {
      throw new ZipError(`条目「${entry.name}」的本地头损坏`)
    }
    const nameLen = buf.readUInt16LE(local + 26)
    const extraLen = buf.readUInt16LE(local + 28)
    const start = local + 30 + nameLen + extraLen
    const end = start + entry.compressedSize
    if (end > buf.length) throw new ZipError(`条目「${entry.name}」的数据越界`)
    const raw = buf.subarray(start, end)

    let data: Buffer
    if (entry.method === 0) data = Buffer.from(raw)
    else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw)
      } catch (error) {
        throw new ZipError(`条目「${entry.name}」解压失败：${(error as Error).message}`)
      }
    } else {
      throw new ZipError(`条目「${entry.name}」用了不支持的压缩方式（${entry.method}）`)
    }
    if (data.length !== entry.size) throw new ZipError(`条目「${entry.name}」解压后大小对不上`)

    const target = safeTarget(destDir, entry.name)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, data)
    files += 1
  }
  return { files }
}
