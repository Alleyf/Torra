/**
 * ChatAssetStore —— 聊天附件的字节仓库（主进程侧）。
 *
 * 为什么把字节放磁盘而不是 localStorage：图片 base64 动辄几百 KB，
 * 塞进渲染层 localStorage 很快撑爆配额、把整个会话历史写挂。渲染层只留
 * {id,kind,name,mime,size} 元数据，字节落在这里，凭 id 回捞。
 *
 * 每个附件两份文件：{id}.bin 是原始字节，{id}.json 是元数据。id 由渲染层
 * 生成，主进程只接受 [A-Za-z0-9_-] —— 挡住路径穿越。
 */

import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { ChatAttachmentKind } from '../../shared/types'

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export interface ChatAssetMeta {
  kind: ChatAttachmentKind
  name: string
  mime: string
}

export class ChatAssetStore {
  constructor(private readonly dir: string) {}

  private assertId(id: string): void {
    if (!ID_RE.test(id)) throw new Error('非法附件 id')
  }

  private binPath(id: string): string {
    return path.join(this.dir, `${id}.bin`)
  }

  private metaPath(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }

  async save(id: string, meta: ChatAssetMeta, data: Uint8Array): Promise<void> {
    this.assertId(id)
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(this.binPath(id), Buffer.from(data))
    await fs.writeFile(this.metaPath(id), JSON.stringify(meta), 'utf8')
  }

  async readMeta(id: string): Promise<ChatAssetMeta | null> {
    if (!ID_RE.test(id)) return null
    try {
      return JSON.parse(await fs.readFile(this.metaPath(id), 'utf8')) as ChatAssetMeta
    } catch {
      return null
    }
  }

  async readBytes(id: string): Promise<Buffer | null> {
    if (!ID_RE.test(id)) return null
    try {
      return await fs.readFile(this.binPath(id))
    } catch {
      return null
    }
  }

  async remove(id: string): Promise<void> {
    if (!ID_RE.test(id)) return
    await fs.rm(this.binPath(id), { force: true }).catch(() => undefined)
    await fs.rm(this.metaPath(id), { force: true }).catch(() => undefined)
  }
}
