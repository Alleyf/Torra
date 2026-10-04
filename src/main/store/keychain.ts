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
    try {
      await fs.unlink(this.filePath(ref))
    } catch {
      /* 已删除 */
    }
  }

  has(ref: string): boolean {
    return this.get(ref) !== null
  }
}
