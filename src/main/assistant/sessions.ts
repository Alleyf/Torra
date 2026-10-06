/**
 * 助手会话的磁盘视角：列清单、读历史、删一场。
 *
 * 为什么要单独一层：会话文件由 pi 的 SessionManager 写，但「还没聊过的会话也要能列出
 * 历史」「重启后没建 pi 会话也要能回看上次的对话」这些动作只需要读盘。
 * 把读盘收在这里，session.ts 就只管活着的那一场，桥接层在两者之间挑。
 *
 * 删除是唯一不可逆的动作，所以先验路径：只允许删 Torra 自己的会话目录里的 .jsonl，
 * 并且不能删正在用的那场 —— 否则一次误点丢的是用户的全部助手对话。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AssistantHistoryItem, AssistantSessionView } from '../../shared/assistant'
import { entriesToMessages, messagesToHistory } from './recorder'
import { assistantSessionDir } from './session'
import { loadPiSdk } from './pi-sdk'

/** 最多列多少场：列表是给人翻的，不是给磁盘做镜像的 */
const LIST_MAX = 60

/** 旧版本按作用域分子目录存会话，SessionManager.list 不递归，所以要先把它们提上来 */
export async function hoistScopedSessions(dataDir: string): Promise<void> {
  const root = assistantSessionDir(dataDir)
  let names: string[] = []
  try {
    names = await fs.readdir(root)
  } catch {
    return
  }
  for (const name of names) {
    const dir = path.join(root, name)
    const st = await fs.stat(dir).catch(() => null)
    if (!st?.isDirectory()) continue
    const files = await fs.readdir(dir).catch(() => [])
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      // 目标已存在就不动：宁可留一份重复的旧文件，也不能覆盖新的那场对话
      const to = path.join(root, f)
      if (await fs.stat(to).catch(() => null)) continue
      await fs.rename(path.join(dir, f), to).catch(() => undefined)
    }
    await fs.rmdir(dir).catch(() => undefined)
  }
}

/**
 * 只认 Torra 会话目录里的 .jsonl，别的路径一律拒绝。
 * 导出给桥接层：凡是拿渲染层传进来的路径去动磁盘的动作，都得先过这一道。
 */
export function assertOwnSessionFile(dataDir: string, file: string): void {
  const root = path.resolve(assistantSessionDir(dataDir))
  const target = path.resolve(file)
  if (!target.startsWith(root + path.sep)) throw new Error('会话文件不在助手的存储目录里')
  if (!target.endsWith('.jsonl')) throw new Error('不是助手会话文件')
}

export async function listSessions(dataDir: string, currentFile?: string): Promise<AssistantSessionView[]> {
  await hoistScopedSessions(dataDir)
  const sdk = await loadPiSdk()
  const infos = await sdk.SessionManager.list(dataDir, assistantSessionDir(dataDir))
  const current = currentFile ? path.resolve(currentFile) : undefined
  return infos
    .map((s: (typeof infos)[number]) => {
      const abs = path.resolve(s.path)
      return {
        id: s.id,
        path: abs,
        ...(s.name ? { name: s.name } : {}),
        created: toMs(s.created),
        modified: toMs(s.modified),
        messageCount: s.messageCount,
        firstMessage: String(s.firstMessage ?? '').slice(0, 120),
        current: current ? abs === current : false,
      }
    })
    .sort((a, b) => b.modified - a.modified)
    .slice(0, LIST_MAX)
}

/** 读一场历史会话的对话内容（会话未建立时的历史来源） */
export async function readSessionHistory(dataDir: string, file: string): Promise<AssistantHistoryItem[]> {
  assertOwnSessionFile(dataDir, file)
  const sdk = await loadPiSdk()
  const sm = sdk.SessionManager.open(file, assistantSessionDir(dataDir))
  return messagesToHistory(entriesToMessages(sm.getBranch()))
}

export async function deleteSession(dataDir: string, file: string, currentFile?: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    assertOwnSessionFile(dataDir, file)
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
  if (currentFile && path.resolve(file) === path.resolve(currentFile)) {
    return { ok: false, reason: '这是当前正在用的会话，先开一场新的再删' }
  }
  await fs.unlink(file).catch((e: Error) => {
    throw new Error(`删除失败：${e.message}`)
  })
  return { ok: true }
}

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? 0 : t
  }
  return 0
}
