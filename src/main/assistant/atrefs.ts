/**
 * @ 引用的读盘侧：列候选、把 @路径 展开成消息里的内容块。
 *
 * 单独成模块的理由和 modes.ts 一样：这两件事只碰磁盘，不碰 pi 也不碰 Electron，
 * 所以离线测试拿一个临时目录就能跑完，不必起会话、不必烧模型。
 *
 * 一条边界：@ 能到之处 = 人亲手挑的那个项目目录。绝对路径和 `..` 一律挡掉 ——
 * 打两个字就能读到任意路径不叫引用，叫目录遍历。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  AT_DIR_LINES_MAX,
  AT_FILE_CHARS_MAX,
  AT_LIST_MAX,
  AT_REF_MAX,
  AT_TOTAL_CHARS_MAX,
  extractAtRefs,
  type AtEntry,
  type AtListing,
} from '../../shared/assistant'

/** 超过这个字节数就不整个读进内存了：展开引用不该把主进程卡住 */
const AT_FILE_BYTES_MAX = 2 * 1024 * 1024
/** 目录清单往下走几层：两层够看清一个项目的骨架，更深就该用 read 工具 */
const AT_DIR_DEPTH = 2

/**
 * 二进制/图片类扩展名。
 *
 * 它们不是「读不出来」，是读出来是一堆乱码占满上下文 —— 所以直接挡在展开之前，
 * 并把话指向附件那条路（图片本来就该走视觉输入）。
 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
  '.zip', '.7z', '.rar', '.gz', '.tar', '.exe', '.dll', '.so', '.dylib',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.mp3', '.mp4',
  '.wav', '.avi', '.mov', '.woff', '.woff2', '.ttf', '.otf', '.pyc', '.node',
])

/**
 * @ 浏览根下不对外露出的顶层目录名。
 *
 * 只有「默认根 = 助手自己的数据目录」时才传：那里挨着放钥匙串密文，
 * 而 @ 引用是主进程直接读盘、绕开 read 闸门的，界面藏不住就等于没藏。
 */
export type AtHidden = readonly string[]

/** 路径里第一个命中隐藏名单的段：root 之下的部分才算数，落到 root 外就整条查 */
function hiddenSegment(rootAbs: string, target: string, hidden: AtHidden): string | undefined {
  const rel = path.relative(rootAbs, target)
  const scoped = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : target
  return String(scoped)
    .split(/[\\/]+/)
    .filter(Boolean)
    .find((seg) => hidden.some((h) => h.toLowerCase() === seg.toLowerCase()))
}

/**
 * 这个引用是不是落在隐藏目录里。
 *
 * 判定必须建立在「解析之后」的位置上：只看输入的第一段，`x/../keys/a.bin` 就绕过去了；
 * 一个指向 keys 的链接同理。@ 引用是主进程直接读盘、绕开 read 闸门的，
 * 绕过去一次就等于把钥匙串密文贴进模型上下文。
 *
 * 名单为空（人亲手挑的项目目录）时整个判定跳过 —— 那里可能正经有个 keys/ 就是要引用的。
 */
function hiddenHit(root: string, rel: string, hidden: AtHidden): string | undefined {
  if (hidden.length === 0) return undefined
  const abs = insideRoot(root, rel)
  if (!abs) return undefined
  const rootAbs = path.resolve(root)
  const here = hiddenSegment(rootAbs, abs, hidden)
  if (here) return here
  try {
    return hiddenSegment(fs.realpathSync(rootAbs), fs.realpathSync(abs), hidden)
  } catch {
    // 链接断了、没有权限读真实落点：读盘那一步自会给出「找不到」这句更准的话
    return undefined
  }
}

/** 相对工作目录的路径落到绝对路径；越界（含跨盘符）返回 undefined */
export function insideRoot(root: string, rel: string): string | undefined {
  const clean = String(rel ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!clean) return undefined
  if (clean.startsWith('/') || path.isAbsolute(clean)) return undefined
  const absBase = path.resolve(root)
  const abs = path.resolve(absBase, clean)
  const back = path.relative(absBase, abs)
  if (!back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) return undefined
  return abs
}

function sizeOf(file: string): number | undefined {
  const st = fs.statSync(file, { throwIfNoEntry: false })
  return st?.isFile() ? st.size : undefined
}

/**
 * 列 @ 后面的候选：只看一层，目录在前，按前缀过滤。
 *
 * 不递归、不搜内容：这一层要的是「打两个字就能按回车」，全树扫描会把浮层变成一次搜索。
 */
export function listAt(root: string, query: string, hidden: AtHidden = []): AtListing {
  const q = String(query ?? '').replace(/\\/g, '/')
  const slash = q.lastIndexOf('/')
  const sub = q.slice(0, slash + 1)
  const prefix = q.slice(slash + 1)
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    return { ok: false, reason: '工作目录已经不在了，重新选一个', entries: [] }
  }
  const blocked = hiddenHit(root, sub, hidden)
  if (blocked) return { ok: false, reason: `「${blocked}」不在 @ 可引用的范围内`, entries: [], workDir: root }
  const base = sub ? insideRoot(root, sub) : root
  if (!base) return { ok: false, reason: '引用只能落在工作目录里面', entries: [], workDir: root }
  let rows: fs.Dirent[]
  try {
    rows = fs.readdirSync(base, { withFileTypes: true })
  } catch (e) {
    return { ok: false, reason: `列不出这个目录：${e instanceof Error ? e.message : String(e)}`, entries: [], workDir: root }
  }
  const lp = prefix.toLowerCase()
  const hit = rows
    .filter((d) => !hidden.some((h) => h.toLowerCase() === d.name.toLowerCase()))
    .filter((d) => !lp || d.name.toLowerCase().startsWith(lp))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  const entries: AtEntry[] = hit.slice(0, AT_LIST_MAX).map((d) => ({
    path: `${sub}${d.name}${d.isDirectory() ? '/' : ''}`,
    dir: d.isDirectory(),
    ...(d.isFile() ? { size: sizeOf(path.join(base, d.name)) } : {}),
  }))
  return { ok: true, workDir: root, entries, truncated: hit.length > AT_LIST_MAX }
}

export interface AtExpansion {
  /** 拼到消息后面的内容块（没有可用引用时为空） */
  blocks: string[]
  /** 给人看的一句话：为什么某个引用没展开、展开到一半被截断了 */
  notes: string[]
  /** 真正展开的引用数 */
  used: number
}

function dirListing(abs: string): string {
  const lines: string[] = []
  const walk = (dir: string, depth: number, indent: string): void => {
    if (depth > AT_DIR_DEPTH || lines.length >= AT_DIR_LINES_MAX) return
    let rows: fs.Dirent[]
    try {
      rows = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    rows
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .forEach((d) => {
        if (lines.length >= AT_DIR_LINES_MAX) return
        lines.push(`${indent}${d.name}${d.isDirectory() ? '/' : ''}`)
        if (d.isDirectory()) walk(path.join(dir, d.name), depth + 1, `${indent}  `)
      })
  }
  walk(abs, 1, '')
  if (lines.length >= AT_DIR_LINES_MAX) lines.push(`…（只列前 ${AT_DIR_LINES_MAX} 条）`)
  return lines.join('\n')
}

/**
 * 把消息里的 @路径 展开成模型看得见的块。
 *
 * 展开发生在发送时、进模式之前，所以三种模式（普通 / 目标 / 计划）拿到的是同一份内容 ——
 * 目标模式续跑的那几轮不再带引用：那是模型自己接管上下文，人只说了一次要引用什么。
 */
export function expandAt(root: string | undefined, text: string, hidden: AtHidden = []): AtExpansion {
  const refs = extractAtRefs(text)
  if (refs.length === 0) return { blocks: [], notes: [], used: 0 }
  if (!root) {
    return { blocks: [], notes: [`这条消息里有 ${refs.length} 个 @ 引用，但还没选工作目录：引用是从那个目录里找文件的`], used: 0 }
  }
  const blocks: string[] = []
  const notes: string[] = []
  let total = 0
  if (refs.length > AT_REF_MAX) notes.push(`一条消息最多展开 ${AT_REF_MAX} 个引用，多出来的按路径原样给出`)
  for (const ref of refs.slice(0, AT_REF_MAX)) {
    const abs = insideRoot(root, ref)
    if (!abs) {
      notes.push(`@${ref} 不在工作目录里面，没有展开`)
      continue
    }
    const blocked = hiddenHit(root, ref, hidden)
    if (blocked) {
      notes.push(`@${ref} 落在「${blocked}」这类不对外引用的目录里，没有展开`)
      continue
    }
    const st = fs.statSync(abs, { throwIfNoEntry: false })
    if (!st) {
      notes.push(`@${ref} 在盘上找不到，没有展开`)
      continue
    }
    if (st.isDirectory()) {
      const body = dirListing(abs)
      blocks.push(`【引用目录 @${ref}（相对 ${root}，往下 ${AT_DIR_DEPTH} 层）】\n${body || '（空目录）'}`)
      total += body.length
      continue
    }
    const ext = path.extname(ref).toLowerCase()
    if (BINARY_EXT.has(ext)) {
      notes.push(`@${ref} 是图片或二进制，展开成文字只会是乱码：要给它就用附件`)
      continue
    }
    if (st.size > AT_FILE_BYTES_MAX) {
      notes.push(`@${ref} 有 ${(st.size / 1024 / 1024).toFixed(1)}MB，太大没有展开：让它用 read 看关键片段`)
      continue
    }
    if (total >= AT_TOTAL_CHARS_MAX) {
      notes.push(`引用累计到 ${AT_TOTAL_CHARS_MAX} 字就停了，@${ref} 没有展开`)
      continue
    }
    let raw: string
    try {
      raw = fs.readFileSync(abs, 'utf8')
    } catch (e) {
      notes.push(`@${ref} 读不出来：${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (raw.includes('\u0000')) {
      notes.push(`@${ref} 看着不像文本文件，没有展开`)
      continue
    }
    const cut = raw.slice(0, AT_FILE_CHARS_MAX)
    const rest = raw.length - cut.length
    blocks.push(`【引用文件 @${ref}】\n${cut}${rest > 0 ? `\n…（后面还有 ${rest} 字没有贴进来）` : ''}`)
    total += cut.length
  }
  return { blocks, notes, used: blocks.length }
}
