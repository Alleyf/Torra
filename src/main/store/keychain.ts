/**
 * Electron safeStorage 密钥存储（PRD 11.2）
 *
 * Key 经 OS 级加密后落盘，密文与明文分离存储。
 * 明文仅在发起请求的瞬间从内存取出，不写日志、不进诊断包。
 */

import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SecretStore } from './session-store'

export class KeychainSecretStore implements SecretStore {
  private cache = new Map<string, string>()

  constructor(private readonly file: string) {}

  get isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private filePath(ref: string): string {
    // encodeURIComponent 保留不同 ref 的一一映射，避免简单替换造成碰撞。
    const safe = encodeURIComponent(ref)
    return path.join(this.file, `${safe}.bin`)
  }

  private legacyFilePath(ref: string): string {
    const safe = ref.replace(/[^a-zA-Z0-9._-]/g, '_')
    return path.join(this.file, `${safe}.bin`)
  }

  get(ref: string): string | null {
    if (!ref || !this.isAvailable) return null
    const hit = this.cache.get(ref)
    if (hit) return hit
    try {
      // 同步读取仅在启动时少量发生；此处用 fs 同步 API 简化调用方
      let buf: Buffer
      try {
        buf = require('node:fs').readFileSync(this.filePath(ref)) as Buffer
      } catch {
        // Read keys written by older Torra versions; new writes always use the
        // collision-free encoded filename.
        buf = require('node:fs').readFileSync(this.legacyFilePath(ref)) as Buffer
      }
      const dec = safeStorage.decryptString(buf)
      this.cache.set(ref, dec)
      return dec
    } catch {
      return null
    }
  }

  async set(ref: string, value: string): Promise<void> {
    if (!this.isAvailable) {
      throw new Error('当前系统不支持安全存储，已拒绝明文保存 API Key')
    }
    await fs.mkdir(this.file, { recursive: true })
    const payload = safeStorage.encryptString(value)
    await fs.writeFile(this.filePath(ref), payload)
    this.cache.set(ref, value)
  }

  async delete(ref: string): Promise<void> {
    this.cache.delete(ref)
    // 两个文件名都删：旧版本写过的那份在另一条路径上。只删新的会让「清除」
    // 之后 get() 仍然从旧文件读回旧密钥 —— 界面上显示已清除，插件却还在用旧值。
    for (const file of [this.filePath(ref), this.legacyFilePath(ref)]) {
      try {
        await fs.unlink(file)
      } catch {
        /* 本来就不在 */
      }
    }
  }

  has(ref: string): boolean {
    return this.get(ref) !== null
  }

  /**
   * 本机存了哪些引用名 —— 只列名，一个值都不读。
   *
   * 文件名是 encodeURIComponent(ref) 加 .bin，所以反解是一一的；老版本用「把非法字符
   * 换成下划线」写过文件，那种名字反解不回原引用名（`a-b` 与 `a_b` 会撞成同一个），
   * 因此只在这里跳过、由 get(ref) 那条兼容路径继续能读到。
   * 列不出来的那条宁可少备份一条，也不猜一个名字出来把值写进错的引用下。
   */
  listRefs(): string[] {
    let names: string[]
    try {
      names = require('node:fs').readdirSync(this.file) as string[]
    } catch {
      return []
    }
    const out: string[] = []
    for (const n of names) {
      if (!n.endsWith('.bin')) continue
      try {
        const ref = decodeURIComponent(n.slice(0, -'.bin'.length))
        if (ref) out.push(ref)
      } catch {
        /* 反解不了的文件名：上面那段说的就是它 */
      }
    }
    return out.sort()
  }
}
