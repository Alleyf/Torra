/**
 * 流水线日志 —— 常驻、被动、只追加。
 *
 * 为什么需要它：此前每次站点失败都要现写一个一次性脚本来复现，
 * 而脚本复现的现场（分区、userData、视口）与真实运行时的现场并不等价 ——
 * 有过脚本在 %APPDATA%\Electron 里测出「未登录」、而 app 用的是
 * %APPDATA%\torra 的情况，结论完全无效。
 *
 * 常驻日志把「事后复现」变成「事前记录」：登录、通道、选择器、发送、
 * 完成判定、主持、落盘每一跳都留一条带耗时与证据的记录。
 * 失败发生时不需要再猜，直接读那一场讨论的日志切片。
 *
 * 设计约束：
 * - 只追加、不覆盖，写失败绝不抛回业务流程（诊断不能成为新的故障源）；
 * - 只记录观测事实，不记录任何凭据值（cookie 只记名称与域名）；
 * - 按天分片，保留 DIAG_KEEP_DAYS 天，超期在启动时清理。
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DiagEvent, DiagLayer, LogFileInfo, LogFilter, LogReadResult } from '../../shared/diagnostics'

const RING_MAX = 1000
const DIAG_KEEP_DAYS = 14
/** 单日日志可能长到几 MB：读盘只从末尾取这么多字节，够界面用，也不会把主进程拖住 */
const READ_TAIL_BYTES = 4_000_000
/** 一次最多交给渲染层这么多条事件；超出只在 truncated 里如实标注 */
const READ_MAX_EVENTS = 3000

class PipelineLog {
  private dir: string | null = null
  private ring: DiagEvent[] = []
  /** 串行写盘，避免并发 append 把行交错打断 */
  private chain: Promise<void> = Promise.resolve()

  /** 由主进程在拿到 dataDir 后调用；CLI 里同样调用，保证两条路径同构 */
  async init(rootDir: string): Promise<void> {
    this.dir = path.join(rootDir, 'logs')
    try {
      await fs.mkdir(this.dir, { recursive: true })
      await this.prune()
    } catch (e) {
      this.dir = null
      console.error('[diag] 日志目录不可用，本次运行仅保留内存日志：', (e as Error).message)
    }
    this.log({ ts: Date.now(), layer: 'env', stage: 'boot', detail: `userData=${app.getPath('userData')}` })
  }

  log(ev: DiagEvent): DiagEvent {
    const withId: DiagEvent = { ...ev }
    this.ring.push(withId)
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX)
    if (this.dir) {
      const line = JSON.stringify(withId)
      this.chain = this.chain.then(() => this.appendLine(line)).catch(() => undefined)
    }
    return withId
  }

  /**
   * 记录一次带耗时的跳点。
   * 用它包业务流程，异常照样往外抛，只是先留下「哪一跳、多久、为什么」。
   */
  async time<T>(
    layer: DiagLayer,
    stage: string,
    subject: string | undefined,
    fn: () => Promise<T>,
    extra?: (r: T) => string,
  ): Promise<T> {
    const t0 = Date.now()
    try {
      const r = await fn()
      this.log({ ts: t0, layer, stage, subject, ok: true, ms: Date.now() - t0, detail: extra ? safe(extra(r)) : undefined })
      return r
    } catch (e) {
      this.log({ ts: t0, layer, stage, subject, ok: false, ms: Date.now() - t0, detail: (e as Error).message })
      throw e
    }
  }

  /** 供 UI 展示的最近日志；按时间倒序，最新的在前 */
  tail(n = 200, filter?: LogFilter): DiagEvent[] {
    return this.match(this.ring, filter, n)
  }

  /** 倒序取，命中即止：日志条数多时不必把整个 ring 走一遍 */
  private match(src: DiagEvent[], filter: LogFilter | undefined, n: number): DiagEvent[] {
    const cap = Math.min(n > 0 ? n : 0, READ_MAX_EVENTS)
    const out: DiagEvent[] = []
    for (let i = src.length - 1; i >= 0 && out.length < cap; i--) {
      const e = src[i]
      if (e && matchesFilter(e, filter)) out.push(e)
    }
    return out
  }

  /** 日志目录；init 之前或目录不可用时为 null，界面据此说明「本次运行只有内存日志」 */
  logsDir(): string | null {
    return this.dir
  }

  /** 目录里每一天：只认 pipeline-YYYYMMDD.jsonl，别的文件一概不列 */
  async listFiles(): Promise<{ dir: string | null; keepDays: number; files: LogFileInfo[] }> {
    if (!this.dir) return { dir: null, keepDays: DIAG_KEEP_DAYS, files: [] }
    let names: string[] = []
    try {
      names = await fs.readdir(this.dir)
    } catch {
      return { dir: this.dir, keepDays: DIAG_KEEP_DAYS, files: [] }
    }
    const files: LogFileInfo[] = []
    for (const name of names) {
      const day = dayFromName(name)
      if (day === null) continue
      try {
        const st = await fs.stat(path.join(this.dir, name))
        if (!st.isFile()) continue
        files.push({ day: name.slice('pipeline-'.length, -'.jsonl'.length), name, bytes: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* 单个文件读不到属性不影响清单，跳过它 */
      }
    }
    files.sort((a, b) => (a.day < b.day ? 1 : -1))
    return { dir: this.dir, keepDays: DIAG_KEEP_DAYS, files }
  }

  /**
   * 读某一天的日志。
   *
   * 只接受 YYYYMMDD 形式的 day，文件名在这里重新拼出来 —— 渲染层永远拿不到
   * 一条可以指向 dataDir 之外的路径，也就没有 ../ 拼进 fs.readFile 的机会。
   */
  async readDay(day: string, filter?: LogFilter): Promise<LogReadResult> {
    if (!this.dir || !/^\d{8}$/.test(day)) return { events: [], scanned: 0, truncated: false, file: null }
    const file = path.join(this.dir, `pipeline-${day}.jsonl`)
    const { text, truncated: sizeCut } = await readTail(file, READ_TAIL_BYTES)
    const events: DiagEvent[] = []
    let scanned = 0
    for (let i = text.length - 1; i >= 0; i--) {
      const line = text[i]
      if (!line || !line.trim()) continue
      scanned++
      const ev = parseLine(line)
      if (ev && matchesFilter(ev, filter)) {
        if (events.length >= (filter?.n && filter.n > 0 ? Math.min(filter.n, READ_MAX_EVENTS) : READ_MAX_EVENTS)) {
          return { events, scanned, truncated: true, file }
        }
        events.push(ev)
      }
    }
    return { events, scanned, truncated: sizeCut, file }
  }

  /** 立即执行保留策略（启动时那次的对外版本），返回删掉的文件名 */
  async pruneNow(): Promise<{ removed: string[]; dir: string | null }> {
    const removed = await this.prune()
    return { removed, dir: this.dir }
  }

  /** 会话结束后把该场日志切片单独存档，报告与历史页都能直接引用 */
  async exportSession(sessionId: string, file: string): Promise<{ written: number; file: string } | null> {
    const evs = this.ring.filter((e) => e.sessionId === sessionId).reverse()
    if (!this.dir && evs.length === 0) return null
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, evs.map((e) => JSON.stringify(e)).join('\n'), 'utf8')
      return { written: evs.length, file }
    } catch {
      return null
    }
  }

  currentFile(): string | null {
    return this.dir ? path.join(this.dir, `pipeline-${dayName(Date.now())}.jsonl`) : null
  }

  /** 等所有挂起的写盘完成，用于退出与 CLI 收尾 */
  async flush(): Promise<void> {
    await this.chain
  }

  private async appendLine(line: string): Promise<void> {
    if (!this.dir) return
    try {
      await fs.appendFile(path.join(this.dir, `pipeline-${dayName(Date.now())}.jsonl`), line + '\n', 'utf8')
    } catch {
      /* 磁盘异常不外抛：诊断日志不能影响业务 */
    }
  }

  private async prune(): Promise<string[]> {
    if (!this.dir) return []
    const cutoff = Date.now() - DIAG_KEEP_DAYS * 86400_000
    let files: string[] = []
    try {
      files = await fs.readdir(this.dir)
    } catch {
      return []
    }
    const removed: string[] = []
    for (const f of files) {
      if (!f.startsWith('pipeline-') || !f.endsWith('.jsonl')) continue
      const d = dayFromName(f)
      if (d !== null && d < cutoff) {
        try {
          await fs.rm(path.join(this.dir, f), { force: true })
          removed.push(f)
        } catch {
          /* 文件被占用就留到下次 */
        }
      }
    }
    return removed
  }

}

function dayName(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

function dayFromName(file: string): number | null {
  const m = /^pipeline-(\d{4})(\d{2})(\d{2})\.jsonl$/.exec(file)
  if (!m) return null
  const [, y, mo, da] = m
  return Date.UTC(Number(y), Number(mo) - 1, Number(da))
}

function safe(fn: string): string {
  return fn.length > 400 ? fn.slice(0, 400) + '…' : fn
}

/** 界面与内存视图共用同一套筛选语义，避免「同一个勾选在两个视图里给两种结果」 */
function matchesFilter(e: DiagEvent, f: LogFilter | undefined): boolean {
  if (!f) return true
  if (f.layer && e.layer !== f.layer) return false
  if (f.sessionId && e.sessionId !== f.sessionId) return false
  if (f.subject && e.subject !== f.subject) return false
  if (f.failedOnly && e.ok !== false) return false
  if (f.text) {
    const q = f.text.toLowerCase()
    const hay = `${e.stage} ${e.subject ?? ''} ${e.detail ?? ''}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

/** 坏行只跳过：日志读盘不能因为某一行被截断就让整个面板报错 */
function parseLine(line: string): DiagEvent | null {
  try {
    const o = JSON.parse(line) as DiagEvent
    if (typeof o?.ts !== 'number' || typeof o?.stage !== 'string') return null
    return o
  } catch {
    return null
  }
}

/** 从末尾最多读 maxBytes；首行可能是半条，丢掉 */
async function readTail(file: string, maxBytes: number): Promise<{ text: string[]; truncated: boolean }> {
  try {
    const st = await fs.stat(file)
    if (st.size === 0) return { text: [], truncated: false }
    const start = Math.max(0, st.size - maxBytes)
    if (start === 0) {
      const all = await fs.readFile(file, 'utf8')
      return { text: all.split('\n'), truncated: false }
    }
    const fh = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(st.size - start)
      await fh.read(buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n')
      lines.shift()
      return { text: lines, truncated: true }
    } finally {
      await fh.close()
    }
  } catch {
    return { text: [], truncated: false }
  }
}

export const diag = new PipelineLog()
