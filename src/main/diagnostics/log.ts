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
import type { DiagEvent, DiagLayer } from '../../shared/diagnostics'

const RING_MAX = 1000
const DIAG_KEEP_DAYS = 14

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
  tail(n = 200, filter?: { sessionId?: string; subject?: string; layer?: DiagLayer }): DiagEvent[] {
    const out: DiagEvent[] = []
    for (let i = this.ring.length - 1; i >= 0 && out.length < n; i--) {
      const e = this.ring[i]
      if (!e) continue
      if (filter?.sessionId && e.sessionId !== filter.sessionId) continue
      if (filter?.subject && e.subject !== filter.subject) continue
      if (filter?.layer && e.layer !== filter.layer) continue
      out.push(e)
    }
    return out
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

  private async prune(): Promise<void> {
    if (!this.dir) return
    const cutoff = Date.now() - DIAG_KEEP_DAYS * 86400_000
    let files: string[] = []
    try {
      files = await fs.readdir(this.dir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.startsWith('pipeline-') || !f.endsWith('.jsonl')) continue
      const d = dayFromName(f)
      if (d !== null && d < cutoff) {
        try {
          await fs.rm(path.join(this.dir, f), { force: true })
        } catch {
          /* 文件被占用就留到下次 */
        }
      }
    }
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

export const diag = new PipelineLog()
