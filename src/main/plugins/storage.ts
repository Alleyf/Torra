/**
 * 插件私有存储：一个插件一个 JSON 文件，键值对。
 *
 * 为什么不是数据库：插件数据量按 KB 算，装一个 SQLite 只会让「备份/迁移」多一条路径。
 * 写入走 tmp + rename，避免进程被杀时留下半截 JSON —— 那会让插件下次启动直接读不出来。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/
/** 单值上限：工具结果可以大，但存储是给状态用的，不是给文件用的 */
const MAX_VALUE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024

export class PluginStorage {
  private cache: Record<string, unknown> | null = null

  constructor(private readonly file: string) {}

  private load(): Record<string, unknown> {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      this.cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  private flush(next: Record<string, unknown>): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(next), 'utf8')
    renameSync(tmp, this.file)
    this.cache = next
  }

  private key(raw: unknown): string {
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (!KEY_RE.test(key)) throw new Error('存储键只能用小写/大写字母、数字、点、下划线、冒号、连字符')
    return key
  }

  get(raw: unknown): unknown {
    return this.load()[this.key(raw)]
  }

  set(raw: unknown, value: unknown): void {
    const key = this.key(raw)
    const bytes = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
    if (bytes > MAX_VALUE_BYTES) throw new Error(`单个值超过 ${MAX_VALUE_BYTES / 1024}KB`)
    const next = { ...this.load(), [key]: value ?? null }
    const total = Buffer.byteLength(JSON.stringify(next), 'utf8')
    if (total > MAX_TOTAL_BYTES) throw new Error(`插件存储超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB`)
    this.flush(next)
  }

  delete(raw: unknown): boolean {
    const key = this.key(raw)
    const current = this.load()
    if (!(key in current)) return false
    const next = { ...current }
    delete next[key]
    this.flush(next)
    return true
  }

  list(): string[] {
    return Object.keys(this.load()).sort()
  }
}
