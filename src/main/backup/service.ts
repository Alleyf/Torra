/**
 * 备份服务：状态、配置、 密钥引用，以及三个动作（测试 / 备份 / 恢复）。
 *
 * 状态在内存里由主进程独占生产，渲染层只画拿到的那一格 —— 与更新、快捷键同一套口径。
 * 配置（仓库地址、分支、上次同步时间）落 preferences.json 的 backup 键；
 * **令牌走钥匙串**（ref 固定 `github:backup`），偏好文件里只有「有没有令牌」这件事。
 */

import {
  DEFAULT_BRANCH,
  autoBackupGateBlocked,
  dueForAutoBackup,
  initialBackupState,
  normalizeAutoBackupConfig,
  normalizeBundlePath,
  parseBackupTarget,
  type AutoBackupConfig,
  type BackupState,
  type BackupTarget,
} from '../../shared/backup'
import type { SecretStore } from '../store/session-store'
import { pullBackup, pushBackup, testTarget, type SyncOutcome, type TestOutcome } from './sync'

/** 令牌的钥匙串引用名。固定一个：备份只对应用户一个 GitHub 账号，多开一个 ref 只会多一处漏配。 */
export const BACKUP_TOKEN_REF = 'github:backup'

interface StoredBackup {
  repo?: string
  branch?: string
  /** 备份包在仓库里的存放路径；没存过就是仓库根 */
  path?: string
  lastPushAt?: number
  lastPullAt?: number
  lastNote?: string | null
  lastOk?: boolean | null
  remoteAt?: number | null
  remoteDevice?: string | null
  /** 定时自动备份的持久化配置（旧版本没这个键，读出来按默认关处理） */
  auto?: unknown
}

export interface BackupServiceDeps {
  dataDir: string
  /** 机器名：多机同步时界面要说清「远端那份是谁推的」 */
  device: string
  secrets: SecretStore
  readPreferences: () => Promise<Record<string, unknown>>
  patchPreferences: (patch: Record<string, unknown>) => Promise<void>
  send: (channel: string, payload: unknown) => void
  /** 拉取落地后让上层重建会话存储（读盘缓存与磁盘不再一致） */
  reloadData: () => Promise<void>
  /** 有没有讨论在跑：自动备份要给它让路，判据由上层给（服务层不碰编排器） */
  discussionActive: () => boolean
  /** 第二参标成败：备份的日志里成功与失败都会落，不能一律当错误 */
  log?: (detail: string, ok: boolean) => void
}

export class BackupService {
  private state: BackupState = initialBackupState()
  /** 内存里也留一份：push/pull 每次都要用，不值得每次都去解引用名 */
  private token: string | null = null
  /**
   * 上一次自动备份「动手」的时刻（不论成败）。
   *
   * 失败不会更新 lastPushAt，于是「到点没到点」会一直判到点 —— 没有这一格，
   * 没配好仓库或令牌过期时会按节拍无限重试，把日志和远端请求都刷爆。
   */
  private lastAutoAttemptAt = 0

  constructor(private readonly deps: BackupServiceDeps) {}

  snapshot(): BackupState {
    return { ...this.state }
  }

  async init(): Promise<void> {
    const prefs = await this.deps.readPreferences().catch((): Record<string, unknown> => ({}))
    const stored = (prefs.backup ?? {}) as StoredBackup
    const repo = typeof stored.repo === 'string' ? stored.repo : ''
    const rawPath = typeof stored.path === 'string' ? stored.path : ''
    const parsed = repo ? parseBackupTarget(repo, stored.branch, rawPath) : null
    const token = this.deps.secrets.get(BACKUP_TOKEN_REF)
    this.token = token
    this.state = {
      ...initialBackupState(),
      configured: !!(parsed && parsed.ok),
      target: repairDisplay(repo, parsed),
      branch: parsed && parsed.ok ? parsed.target.branch : (stored.branch || DEFAULT_BRANCH),
      path: displayPath(rawPath),
      hasToken: !!token,
      lastPushAt: numOrNull(stored.lastPushAt),
      lastPullAt: numOrNull(stored.lastPullAt),
      lastNote: typeof stored.lastNote === 'string' ? stored.lastNote : null,
      lastOk: typeof stored.lastOk === 'boolean' ? stored.lastOk : null,
      remoteAt: numOrNull(stored.remoteAt),
      remoteDevice: typeof stored.remoteDevice === 'string' ? stored.remoteDevice : null,
      auto: normalizeAutoBackupConfig(stored.auto),
    }
    this.publish()
  }

  /**
   * 定时自动备份的开关与频率。改完立刻落 preferences ——
   * 定时器按节拍问的是内存里的这一格，重启前不落盘等于设置白点一次。
   */
  async setAutoConfig(patch: {
    enabled?: boolean
    /** IPC 传来的是普通 number：非法值交给 normalize 收回默认，不在这里抛 */
    intervalHours?: number
    pullToo?: boolean
  }): Promise<{ ok: boolean; reason?: string; auto: AutoBackupConfig }> {
    // 逐字段挑掉 undefined：对象展开会把 undefined 原样盖上去，
    // 于是「只改频率」会变成「顺手把开关关掉」（normalize 把 undefined 读成 false）
    const merged: AutoBackupConfig = { ...this.state.auto }
    if (patch.enabled !== undefined) merged.enabled = patch.enabled
    if (patch.intervalHours !== undefined) merged.intervalHours = patch.intervalHours as AutoBackupConfig['intervalHours']
    if (patch.pullToo !== undefined) merged.pullToo = patch.pullToo
    const next = normalizeAutoBackupConfig(merged)
    this.state = { ...this.state, auto: next }
    await this.persist({ auto: next })
    this.publish()
    return { ok: true, auto: next }
  }

  /**
   * 定时节拍问一句：到点且能跑就跑一次推送。
   *
   * 三条让路：没开 / 讨论在跑 / 有手动动作没结束。跑失败不弹窗 ——
   * 静默任务的失败写进 lastNote 与日志，用户在备份页看得见，
   * 不该在干活干到一半时被一个定时器的错误框打断。
   */
  async autoTick(now = Date.now()): Promise<{ ran: boolean; reason?: string }> {
    const due = dueForAutoBackup(this.state.auto, now, this.state.lastPushAt, this.state.lastPullAt)
    if (!due.run) return { ran: false, reason: due.reason }
    // 先问「到没到点」再问「该不该让路」：反过来会把「根本没开」报成「为讨论让路」，
    // 日志里看着像功能在跑只是被挡住了，查的人会往错方向找
    const blocked = autoBackupGateBlocked({ discussionActive: this.deps.discussionActive(), busy: this.state.busy !== null })
    if (blocked) return { ran: false, reason: blocked }
    // 上一拍刚试过但没成（失败不更新 lastPushAt）：等满一个周期再来，别按节拍轰炸
    const retryFloor = this.lastAutoAttemptAt + this.state.auto.intervalHours * 3_600_000
    if (this.lastAutoAttemptAt > 0 && now < retryFloor) {
      return { ran: false, reason: `上次自动备份没成功，${Math.ceil((retryFloor - now) / 60_000)} 分钟后再试` }
    }
    this.lastAutoAttemptAt = now
    const out = await this.push()
    if (!out.ok) {
      this.deps.log?.(`自动备份没跑成：${out.reason ?? '原因未知'}（下一拍再试）`, false)
      return { ran: true, reason: out.reason }
    }
    if (this.state.auto.pullToo) {
      const pulled = await this.pull()
      if (!pulled.ok) this.deps.log?.(`自动备份的拉取没跑成：${pulled.reason ?? '原因未知'}`, false)
    }
    return { ran: true }
  }

  /**
   * 保存配置。token 传 undefined 表示「不动现有令牌」，
   * 传空串表示「清掉令牌」—— 两者在界面上是两个不同的动作（没改 / 删除）。
   */
  async saveConfig(input: {
    repo?: string
    branch?: string
    path?: string
    token?: string
  }): Promise<{ ok: boolean; reason?: string }> {
    const repo = String(input.repo ?? this.state.target).trim()
    const branch = String(input.branch ?? this.state.branch ?? DEFAULT_BRANCH).trim() || DEFAULT_BRANCH
    const rawPath = String(input.path ?? this.state.path ?? '').trim()
    if (!repo) {
      await this.persist({ repo: '', branch, path: rawPath })
      this.state = { ...this.state, configured: false, target: '', branch, path: displayPath(rawPath) }
      this.publish()
      return { ok: true }
    }
    const parsed = parseBackupTarget(repo, branch, rawPath)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }

    if (input.token !== undefined) {
      const token = input.token.trim()
      if (!token) {
        // SecretStore.delete 契约上返回 void（钥匙串那份实现是异步的），所以不用 .catch
        await this.deps.secrets.delete(BACKUP_TOKEN_REF)
        this.token = null
      } else {
        try {
          await this.deps.secrets.set(BACKUP_TOKEN_REF, token)
        } catch (e) {
          return { ok: false, reason: (e as Error).message }
        }
        this.token = token
      }
    }

    const display = `${parsed.target.owner}/${parsed.target.repo}`
    await this.persist({ repo: display, branch: parsed.target.branch, path: parsed.target.file })
    this.state = {
      ...this.state,
      configured: true,
      target: display,
      branch: parsed.target.branch,
      path: parsed.target.file,
      hasToken: !!this.token,
      lastNote: null,
      lastOk: null,
    }
    this.publish()
    return { ok: true }
  }

  /** 连通性检查。createIfMissing 只在界面明确点了「连不上就建一个」时才为真 */
  async test(createIfMissing: boolean): Promise<TestOutcome> {
    const ready = this.ready()
    if (!ready.ok) return { ok: false, reason: ready.reason }
    this.setBusy('test')
    try {
      const out = await testTarget(ready.token, ready.target, createIfMissing)
      if (out.ok) {
        await this.persist({
          remoteAt: out.remoteAt ?? null,
          lastNote: out.created
            ? `已创建私有仓库 ${out.repo}`
            : out.hasBundle
              ? `连上了 ${out.repo}，远端已有备份包`
              : `连上了 ${out.repo}，远端还没有备份包`,
          lastOk: true,
        })
        this.state = {
          ...this.state,
          remoteAt: out.remoteAt ?? null,
          lastNote: out.created
            ? `已创建私有仓库 ${out.repo}`
            : out.hasBundle
              ? `连上了 ${out.repo}，远端已有备份包`
              : `连上了 ${out.repo}，远端还没有备份包`,
          lastOk: true,
        }
      } else {
        await this.note(false, out.reason ?? '连接失败')
      }
      return out
    } finally {
      this.setBusy(null)
    }
  }

  async push(): Promise<SyncOutcome> {
    const ready = this.ready()
    if (!ready.ok) return failOutcome(ready.reason)
    this.setBusy('push')
    try {
      const out = await pushBackup(ready.token, ready.target, this.deps.dataDir, this.deps.device)
      if (!out.ok) {
        await this.note(false, out.reason ?? '备份失败')
        return out
      }
      const text = `已备份 ${out.sessions} 场（新增 ${out.pushed} · 取回 ${out.added + out.pulled} · 未变 ${out.same}）`
      await this.persist({ lastPushAt: Date.now(), lastOk: true, lastNote: text, remoteAt: out.remoteAt })
      this.state = { ...this.state, lastPushAt: Date.now(), lastOk: true, lastNote: text, remoteAt: out.remoteAt }
      this.deps.log?.(`备份推送完成：${text}`, true)
      return out
    } finally {
      this.setBusy(null)
    }
  }

  async pull(): Promise<SyncOutcome> {
    const ready = this.ready()
    if (!ready.ok) return failOutcome(ready.reason)
    this.setBusy('pull')
    try {
      const out = await pullBackup(ready.token, ready.target, this.deps.dataDir, this.deps.device)
      if (!out.ok) {
        await this.note(false, out.reason ?? '恢复失败')
        return out
      }
      // 磁盘换了内容，内存里的会话缓存必须重建：否则历史列表还是旧的，
      // 而界面上那行「已恢复」已经绿了 —— 这种不一致比报错更难查。
      await this.deps.reloadData().catch((e) => this.deps.log?.(`拉取后重建失败：${(e as Error).message}`, false))
      const text = `已恢复：新增 ${out.added} · 覆盖 ${out.pulled}（本地较新保留 ${out.pushed} · 一致 ${out.same}）`
      await this.persist({
        lastPullAt: Date.now(),
        lastOk: true,
        lastNote: text,
        remoteAt: out.remoteAt,
        remoteDevice: out.remoteDevice,
      })
      this.state = {
        ...this.state,
        lastPullAt: Date.now(),
        lastOk: true,
        lastNote: text,
        remoteAt: out.remoteAt,
        remoteDevice: out.remoteDevice,
      }
      this.deps.log?.(`备份拉取完成：${text}`, true)
      return out
    } finally {
      this.setBusy(null)
    }
  }

  repoUrl(): string {
    if (!this.state.configured) return ''
    return `https://github.com/${this.state.target}`
  }

  private ready(): { ok: true; token: string; target: BackupTarget } | { ok: false; reason: string } {
    if (!this.state.configured) return { ok: false, reason: '先在设置里填一个备份仓库（owner/repo）' }
    const parsed = parseBackupTarget(this.state.target, this.state.branch, this.state.path)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    const token = this.token ?? this.deps.secrets.get(BACKUP_TOKEN_REF)
    if (!token) return { ok: false, reason: '还没有填 GitHub 令牌（需要 repo 范围：私有仓库的读写）' }
    this.token = token
    return { ok: true, token, target: parsed.target }
  }

  private setBusy(busy: BackupState['busy']): void {
    this.state = { ...this.state, busy }
    this.publish()
  }

  private async note(ok: boolean, text: string): Promise<void> {
    this.deps.log?.(`备份：${text}`, ok)
    await this.persist({ lastOk: ok, lastNote: text }).catch(() => undefined)
    this.state = { ...this.state, lastOk: ok, lastNote: text }
  }

  private async persist(patch: Partial<StoredBackup>): Promise<void> {
    const prefs = await this.deps.readPreferences().catch((): Record<string, unknown> => ({}))
    const prev = (prefs.backup ?? {}) as StoredBackup
    await this.deps.patchPreferences({ backup: { ...prev, ...patch } })
  }

  private publish(): void {
    this.deps.send('backup:state', this.snapshot())
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 存过的地址原样显示（用户可能存的是完整链接），解析失败时也要能看见自己填了什么 */
function repairDisplay(raw: string, parsed: ReturnType<typeof parseBackupTarget> | null): string {
  if (parsed && parsed.ok) return `${parsed.target.owner}/${parsed.target.repo}`
  return raw
}

/** 路径同理：能归一就显示归一后的（用户一眼能看出最终落到哪个文件），归不了就原样留着让他改 */
function displayPath(raw: string): string {
  if (!String(raw ?? '').trim()) return ''
  const norm = normalizeBundlePath(raw)
  return norm.ok ? norm.path : raw
}

function failOutcome(reason: string): SyncOutcome {
  return {
    ok: false,
    reason,
    added: 0,
    pulled: 0,
    pushed: 0,
    same: 0,
    bytes: 0,
    sessions: 0,
    remoteAt: null,
    remoteDevice: null,
    scrubbed: 0,
  }
}
