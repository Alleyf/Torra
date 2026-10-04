/**
 * 会话存储（PRD 10）
 *
 * PRD 目标是 SQLite；此处先落地文件版实现，但接口按仓储语义设计，
 * 后续替换 SQLite 只需实现同一接口，上层无感。
 *
 * 写入策略：原子写（临时文件 + rename），避免崩溃产生半截文件。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Report, SessionRecord } from '../../shared/types'

export interface SessionStore {
  init(): Promise<void>
  save(rec: SessionRecord): Promise<void>
  load(id: string): Promise<SessionRecord | null>
  list(): Promise<SessionRecord[]>
  remove(id: string): Promise<void>
  saveReport(sessionId: string, report: Report): Promise<void>
  loadReport(sessionId: string): Promise<Report | null>
}

export class FileSessionStore implements SessionStore {
  private cache = new Map<string, SessionRecord>()
  private reportCache = new Map<string, Report>()

  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.mkdir(path.join(this.dir, 'reports'), { recursive: true })

    let files: string[] = []
    try {
      files = await fs.readdir(this.dir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(path.join(this.dir, f), 'utf8')
        const rec = JSON.parse(raw) as SessionRecord
        if (!isSafeId(rec.id)) continue
        this.cache.set(rec.id, rec)
      } catch {
        /* 跳过损坏文件 */
      }
    }
  }

  async save(rec: SessionRecord): Promise<void> {
    assertSafeId(rec.id)
    this.cache.set(rec.id, rec)
    await atomicWrite(path.join(this.dir, `${rec.id}.json`), JSON.stringify(rec, null, 2))
  }

  async load(id: string): Promise<SessionRecord | null> {
    if (!isSafeId(id)) return null
    const hit = this.cache.get(id)
    if (hit) return hit
    try {
      const raw = await fs.readFile(path.join(this.dir, `${id}.json`), 'utf8')
      const rec = JSON.parse(raw) as SessionRecord
      this.cache.set(id, rec)
      return rec
    } catch {
      return null
    }
  }

  async list(): Promise<SessionRecord[]> {
    return [...this.cache.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async remove(id: string): Promise<void> {
    if (!isSafeId(id)) return
    this.cache.delete(id)
    this.reportCache.delete(id)
    try {
      await fs.unlink(path.join(this.dir, `${id}.json`))
    } catch {
      /* 已删除 */
    }
    try {
      await fs.unlink(path.join(this.dir, 'reports', `${id}.json`))
    } catch {
      /* 报告可能尚未生成 */
    }
  }

  async saveReport(sessionId: string, report: Report): Promise<void> {
    assertSafeId(sessionId)
    this.reportCache.set(sessionId, report)
    const rec = this.cache.get(sessionId)
    if (rec) {
      rec.report = report
      rec.updatedAt = Date.now()
      await this.save(rec)
    }
    await atomicWrite(
      path.join(this.dir, 'reports', `${sessionId}.json`),
      JSON.stringify(report, null, 2),
    )
  }

  async loadReport(sessionId: string): Promise<Report | null> {
    if (!isSafeId(sessionId)) return null
    const hit = this.reportCache.get(sessionId)
    if (hit) return hit
    try {
      const raw = await fs.readFile(path.join(this.dir, 'reports', `${sessionId}.json`), 'utf8')
      const r = JSON.parse(raw) as Report
      this.reportCache.set(sessionId, r)
      return r
    } catch {
      return null
    }
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/

function isSafeId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_ID.test(id)
}

function assertSafeId(id: string): void {
  if (!isSafeId(id)) throw new Error('非法会话 ID')
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, file)
  } finally {
    await fs.unlink(tmp).catch(() => undefined)
  }
}

/**
 * 密钥存储（PRD 11.2）
 *
 * 契约：Key 仅存系统钥匙串，不落 SQLite、不进日志、不进诊断导出包。
 * 下方为接口定义；具体实现由 keychain 模块注入（避免主进程强依赖原生模块）。
 */
export interface SecretStore {
  get(ref: string): string | null
  set(ref: string, value: string): void
  delete(ref: string): void
  has(ref: string): boolean
}

/** 内存实现（开发态）。生产态须替换为 Electron safeStorage 或系统钥匙串。 */
export class MemorySecretStore implements SecretStore {
  private m = new Map<string, string>()
  get(ref: string): string | null {
    return this.m.get(ref) ?? null
  }
  set(ref: string, value: string): void {
    this.m.set(ref, value)
  }
  delete(ref: string): void {
    this.m.delete(ref)
  }
  has(ref: string): boolean {
    return this.m.has(ref)
  }
}
