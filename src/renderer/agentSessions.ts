/**
 * 编码工作台的会话库。
 *
 * 为什么要自己存一份：ACP 协议只活在一条 stdio 管道上 —— 子进程一退，
 * 那一场对话在协议层面就不存在了（四家里没有一家把历史留在外面）。
 * 参考的那套工作台之所以能把「昨天的会话」点开，是因为它把 agent 自己的
 * 会话目录也接进来了；Torra 这一版只做 ACP，所以历史由渲染层自己留，
 * 存的就是画出来的那些行 —— 正文、步骤、改动，一个不少。
 *
 * 存的是**界面行**而不是协议事件：事件流里分片的文字、成对的工具调用与结果
 * 都需要重放一遍才能变成可读的一段；存已经折好的结果，读回来就能直接画。
 *
 * 容量按浏览器的 localStorage 给：一场最多留 240 行，整库最多 30 场。
 * 超出时从最旧的整场开始丢，而不是从某一场的中间截断 —— 半场对话比没有更误导。
 * 被截过头的那一场会记一个 truncated，界面照实说「更早的内容没留下」。
 */

import type { AcpLine } from './acpLines'

export interface AgentSession {
  id: string
  agentId: string
  agentTitle: string
  /** 会话名：取第一句用户输入，没有就叫「新会话」 */
  title: string
  /** 工作目录：agent 能碰哪些文件由它决定，要在会话上记下来 */
  cwd?: string
  createdAt: number
  updatedAt: number
  lines: AcpLine[]
  /** 这一场是不是眼下挂着的那一场（只在内存里有意义，不落盘） */
  live?: boolean
  /** 超过保留上限被截过头 */
  truncated?: boolean
}

export const SESSIONS_KEY = 'torra.agents.sessions.v1'
export const CWD_KEY = 'torra.agents.cwd.v1'

/** 一场最多留多少行、整库最多几场 */
export const MAX_LINES = 240
export const MAX_SESSIONS = 30

/** 会话名：第一句用户输入压成一行 */
export function sessionTitle(lines: AcpLine[]): string {
  for (const l of lines) {
    if (l.kind !== 'user') continue
    const one = l.text.replace(/\s+/g, ' ').trim()
    if (!one) continue
    return one.length > 36 ? `${one.slice(0, 36)}…` : one
  }
  return '新会话'
}

/** 只留最后 n 行；截过头了要记下来 */
export function pruneLines(lines: AcpLine[], max = MAX_LINES): { lines: AcpLine[]; truncated: boolean } {
  if (lines.length <= max) return { lines, truncated: false }
  return { lines: lines.slice(lines.length - max), truncated: true }
}

/** 新开场：一条空会话 */
export function newSession(id: string, agentId: string, agentTitle: string, cwd?: string, now = Date.now()): AgentSession {
  return {
    id,
    agentId,
    agentTitle,
    title: '新会话',
    cwd,
    createdAt: now,
    updatedAt: now,
    lines: [],
  }
}

/**
 * 把一场会话放回库里：同 id 覆盖，按更新时间倒序。
 *
 * 排序在写入时做，而不是读的时候做：侧栏要的是「最近说过的在最上面」，
 * 这个顺序跟文件里存的顺序一致，读回来就不用再排一遍。
 */
export function upsertSession(list: AgentSession[], session: AgentSession): AgentSession[] {
  const next = list.filter((s) => s.id !== session.id)
  next.unshift(session)
  return next.slice(0, MAX_SESSIONS)
}

/** 从存档里读回来：坏掉的记录整条丢掉，不让一条脏数据把整库带崩 */
export function parseSessions(raw: string | null): AgentSession[] {
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: AgentSession[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    if (typeof s.id !== 'string' || !s.id) continue
    if (typeof s.agentId !== 'string' || !s.agentId) continue
    if (typeof s.agentTitle !== 'string') continue
    if (!Array.isArray(s.lines)) continue
    const lines = s.lines.filter((l): l is AcpLine => !!l && typeof l === 'object' && typeof (l as { id?: unknown }).id === 'number')
    out.push({
      id: s.id,
      agentId: s.agentId,
      agentTitle: s.agentTitle,
      title: typeof s.title === 'string' && s.title ? s.title : sessionTitle(lines),
      cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
      lines,
      truncated: s.truncated === true,
    })
  }
  return out.slice(0, MAX_SESSIONS)
}

export function loadSessions(store: Pick<Storage, 'getItem'> = localStorage): AgentSession[] {
  try {
    return parseSessions(store.getItem(SESSIONS_KEY))
  } catch {
    return []
  }
}

export function saveSessions(list: AgentSession[], store: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    const plain = list.map((s) => {
      const { live: _live, ...rest } = s
      return rest
    })
    store.setItem(SESSIONS_KEY, JSON.stringify(plain))
  } catch {
    // 配额满了不吵用户：这一场还画在屏幕上，只是下次打开点不回来
  }
}

/** 相对时间：侧栏上的会话时间要一眼看出新旧，不写完整年月日 */
export function relTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts)
  const min = Math.floor(d / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const day = Math.floor(h / 24)
  if (day < 30) return `${day} 天前`
  const dt = new Date(ts)
  return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日`
}
