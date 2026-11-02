/**
 * 编码工作台的会话库。
 *
 * 这一版起，这里存的是**索引**，不是第二份正文。
 *
 * 为什么要拆：ACP 协议只活在一条 stdio 管道上 —— 子进程一退，那一场对话
 * 在协议层面就不存在了（四家里没有一家把历史留在外面）。所以「接着聊上次那场」
 * 这件事只能靠 agent 自己留下的历史：Torra 拿一个**跨重启稳定的会话号**去问它，
 * 它把那一场重播一遍。
 *
 * 于是分工就清楚了：
 *   - 真源在 agent 那边。Torra 存的那份只是一份索引（哪一家、哪一场、
 *     什么时间、能不能接着聊），外加一份**兜底**正文 ——
 *     只有在「这一家压根读不回历史」时，那份兜底才是唯一的一份。
 *   - 凡是读得回来的场次，兜底正文验过之后就丢掉：不留第二份真源。
 *
 * 容量按浏览器的 localStorage 给：一场最多留 240 条，整库最多 30 场。
 * 超出时从最旧的整场开始丢，而不是从某一场的中间截断 —— 半场对话比没有更误导。
 * 被截过头的那一场会记一个 truncated，界面照实说「更早的内容没留下」。
 */

// 相对路径而不是 @shared 别名：这一段是纯逻辑，离线回归直接 ts-node 加载它，
// 而 ts-node 跑在主进程的 tsconfig 上，那里没有渲染层的别名。
import { hostSessionTitle, type HostItem, type HostResume } from '../shared/host'

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
  /**
   * agent 那边的会话号：跨重启稳定的那一个。
   *
   * 没有它就接不上 —— 它是「接着聊」唯一的凭据。
   */
  nativeSessionId?: string
  /** 这一家能不能接着聊：能力差异，跟具体哪一场无关 */
  resume?: HostResume
  /**
   * Torra 自己留下的正文（兜底用）。
   *
   * 读得回历史的话，这份会被丢掉 —— 真源在 agent 那边，留着两份只会分叉。
   */
  items?: HostItem[]
  /**
   * 这一场的正文归那一家管：Torra 只留了索引。
   *
   * 读回历史验过之后就归它了。留两份迟早分叉，而分叉的那一份
   * 最后会被当成真的 —— 用户看到的就不是 agent 那边的事实。
   */
  harnessOwned?: boolean
  /** 超过保留上限被截过头 */
  truncated?: boolean
}

export const SESSIONS_KEY = 'torra.agents.sessions.v2'
/** 旧版的键：只用来迁移一次（那时存的是画好的行，不是账本） */
const LEGACY_KEY = 'torra.agents.sessions.v1'
export const CWD_KEY = 'torra.agents.cwd.v1'

/** 一场最多留多少条、整库最多几场 */
export const MAX_ITEMS = 240
export const MAX_SESSIONS = 30

/** 会话名：第一句用户输入压成一行 */
export function sessionTitle(items: HostItem[]): string {
  return hostSessionTitle(items)
}

/** 只留最后 n 条；截过头了要记下来 */
export function pruneItems(items: HostItem[], max = MAX_ITEMS): { items: HostItem[]; truncated: boolean } {
  if (items.length <= max) return { items, truncated: false }
  return { items: items.slice(items.length - max), truncated: true }
}

/** 新开场：一条空会话 */
export function newSession(
  id: string,
  agentId: string,
  agentTitle: string,
  cwd?: string,
  now = Date.now(),
): AgentSession {
  return {
    id,
    agentId,
    agentTitle,
    title: '新会话',
    cwd,
    createdAt: now,
    updatedAt: now,
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

/**
 * 能不能接着聊这一场。
 *
 * 两个条件都要：得有 agent 那边的会话号（没有就无从问起），
 * 而且这一家得给得出历史（它压根不给的话，问了也是白问）。
 */
export function canResume(session: AgentSession): boolean {
  if (!session.nativeSessionId) return false
  return session.resume?.level !== 'none'
}

/**
 * 旧版记录迁移：那时候存的是画好的行，现在存的是账本。
 *
 * 迁移保留能留的：谁、哪一场、什么时间、那些行。转不了的（跨重启稳定的会话号
 * 旧版根本没记）就让它空着 —— 宁可少一个「接着聊」的入口，也不要编一个号出来。
 */
function migrateLegacy(raw: string | null): AgentSession[] {
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
    const items = legacyLinesToItems(s.lines as unknown[])
    out.push({
      id: s.id,
      agentId: s.agentId,
      agentTitle: s.agentTitle,
      title: typeof s.title === 'string' && s.title ? s.title : sessionTitle(items),
      cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
      items,
      truncated: s.truncated === true,
    })
  }
  return out.slice(0, MAX_SESSIONS)
}

/** 旧版的一行 → 账本里的一条 */
function legacyLinesToItems(lines: unknown[]): HostItem[] {
  const out: HostItem[] = []
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue
    const l = raw as Record<string, unknown>
    const text = typeof l.text === 'string' ? l.text : ''
    switch (l.kind) {
      case 'user':
        out.push({ id: out.length, kind: 'message', role: 'user', turnId: 't1', text })
        break
      case 'say':
        out.push({ id: out.length, kind: 'message', role: 'agent', turnId: 't1', text })
        break
      case 'think':
        out.push({ id: out.length, kind: 'thinking', turnId: 't1', text })
        break
      case 'tool': {
        const edits = Array.isArray(l.edits)
          ? (l.edits as unknown[])
              .map((e) => {
                const d = (e ?? {}) as Record<string, unknown>
                if (typeof d.path !== 'string') return null
                return {
                  path: d.path,
                  oldText: typeof d.oldText === 'string' ? d.oldText : '',
                  newText: typeof d.newText === 'string' ? d.newText : '',
                }
              })
              .filter((e): e is { path: string; oldText: string; newText: string } => e !== null)
          : undefined
        out.push({
          id: out.length,
          kind: 'tool',
          turnId: 't1',
          itemId: typeof l.toolId === 'string' ? l.toolId : `legacy-${out.length}`,
          title: typeof l.title === 'string' ? l.title : '工具调用',
          status: typeof l.status === 'string' ? l.status : undefined,
          out: typeof l.out === 'string' ? l.out : undefined,
          toolKind: typeof l.toolKind === 'string' ? l.toolKind : undefined,
          edits: edits?.length ? edits : undefined,
        })
        break
      }
      case 'notice':
        out.push({ id: out.length, kind: 'notice', text })
        break
      case 'error':
        out.push({ id: out.length, kind: 'error', text })
        break
      case 'plan': {
        const entries = Array.isArray(l.entries)
          ? (l.entries as unknown[]).map((e) => {
              const x = (e ?? {}) as Record<string, unknown>
              return { content: String(x.content ?? ''), status: String(x.status ?? 'pending') }
            })
          : []
        out.push({ id: out.length, kind: 'plan', turnId: 't1', entries })
        break
      }
      case 'tally':
        out.push({ id: out.length, kind: 'tally', text })
        break
      default:
        break
    }
  }
  return out
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
    const items = Array.isArray(s.items)
      ? (s.items as unknown[]).filter(
          (i): i is HostItem => !!i && typeof i === 'object' && typeof (i as { id?: unknown }).id === 'number',
        )
      : undefined
    out.push({
      id: s.id,
      agentId: s.agentId,
      agentTitle: s.agentTitle,
      title: typeof s.title === 'string' && s.title ? s.title : sessionTitle(items ?? []),
      cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
      nativeSessionId: typeof s.nativeSessionId === 'string' && s.nativeSessionId ? s.nativeSessionId : undefined,
      resume: readResume(s.resume),
      items,
      harnessOwned: s.harnessOwned === true,
      truncated: s.truncated === true,
    })
  }
  return out.slice(0, MAX_SESSIONS)
}

/** 存着的「能不能接着聊」结论：坏了就当没有，别拿一份瞎编的说出去 */
function readResume(raw: unknown): HostResume | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const level = r.level
  if (level !== 'durable' && level !== 'history' && level !== 'none') return undefined
  const identity = r.identity
  if (identity !== 'durable' && identity !== 'ephemeral' && identity !== 'none') return undefined
  return {
    level,
    identity,
    reason: typeof r.reason === 'string' && r.reason ? r.reason : '这一家能不能接着聊，没有验过。',
  }
}

export function loadSessions(store: Pick<Storage, 'getItem' | 'setItem'> = localStorage): AgentSession[] {
  try {
    const raw = store.getItem(SESSIONS_KEY)
    if (raw !== null) return parseSessions(raw)
    // 第一次进来：把旧版那批行迁过来，迁完就落到新键上
    const legacy = migrateLegacy(store.getItem(LEGACY_KEY))
    if (legacy.length) saveSessions(legacy, store)
    return legacy
  } catch {
    return []
  }
}

export function saveSessions(list: AgentSession[], store: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    store.setItem(SESSIONS_KEY, JSON.stringify(list))
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
