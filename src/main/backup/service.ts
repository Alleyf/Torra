/**
 * 备份服务：状态、配置、 密钥引用，以及三个动作（测试 / 备份 / 恢复）。
 *
 * 状态在内存里由主进程独占生产，渲染层只画拿到的那一格 —— 与更新、快捷键同一套口径。
 * 配置（仓库地址、分支、上次同步时间）落 preferences.json 的 backup 键；
 * **令牌走钥匙串**（ref 固定 `github:backup`），偏好文件里只有「有没有令牌」这件事。
 */

import {
  DEFAULT_BRANCH,
  initialBackupState,
  normalizeBundlePath,
  parseBackupTarget,
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
  /** 第二参标成败：备份的日志里成功与失败都会落，不能一律当错误 */
  log?: (detail: string, ok: boolean) => void
}

export class BackupService {
  private state: BackupState = initialBackupState()
  /** 内存里也留一份：push/pull 每次都要用，不值得每次都去解引用名 */
  private token: string | null = null

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
    }
    this.publish()
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
