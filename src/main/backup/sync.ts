/**
 * 备份包的收集 / 落地 / 推拉。
 *
 * 三件事在这里拼起来，缺一件都会出现「看着同步成功、其实丢东西」：
 * 收集（按 shared/backup 的收纳清单走）、落地（写回本机并原子替换）、
 * 推拉（先在本地合并，再整份写回远端 —— 远端历史由 git 提交保管）。
 *
 * 为什么推送前一定要先读远端：备份的目的是「两台机器都有同一份」，
 * 后推的那台若直接覆盖，先推的那台新增的场次就没了。读一次的成本是一次 GET。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  BACKUP_SCHEMA_VERSION,
  bundleStat,
  findSecretLeaks,
  isBackupPath,
  isReadableBundle,
  mergeBundles,
  normalizeRel,
  scrubBundle,
  type BackupBundle,
  type BackupSyncResult,
  type BackupTestResult,
  type BackupTarget,
} from '../../shared/backup'
import { atomicWrite } from '../store/session-store'
import { ghCreateRepo, ghGetFile, ghPutFile, ghRepo, ghUser } from './github'

/** 单包上限：超过这个体量就不该塞进一个 JSON 文件，先让人去看眼盘上有什么 */
const MAX_BUNDLE_BYTES = 40 * 1024 * 1024
/** 文件数上限：拦住「误把大目录放进适配器目录」这类事故 */
const MAX_FILES = 6000

export type SyncOutcome = BackupSyncResult

function fail(reason: string): SyncOutcome {
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

/**
 * 收集本机数据。
 *
 * 只收 shared/backup 里那份清单认的路径，并且**不跟软链接走**：技能目录那条链
 * 就是靠 junction 指来指去的，跟着走会把别人的仓库内容也吞进备份。
 */
export async function collectBundle(dataDir: string, device: string): Promise<BackupBundle> {
  const files: Record<string, string> = {}
  const fileTimes: Record<string, number> = {}

  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        if (!isBackupPath(`${rel}/x`)) continue
        await walk(abs, rel)
        continue
      }
      if (!entry.isFile()) continue
      if (!isBackupPath(rel)) continue
      if (Object.keys(files).length >= MAX_FILES) continue
      try {
        const [text, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)])
        files[normalizeRel(rel)] = text
        fileTimes[normalizeRel(rel)] = st.mtimeMs
      } catch {
        /* 读不动的那一份跳过：备份不该因为一个坏文件整体失败 */
      }
    }
  }

  await walk(path.join(dataDir, 'sessions'), 'sessions')
  await walk(path.join(dataDir, 'adapters'), 'adapters')
  for (const name of ['preferences.json', 'models.json']) {
    const abs = path.join(dataDir, name)
    try {
      const [text, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)])
      files[name] = text
      fileTimes[name] = st.mtimeMs
    } catch {
      /* 还没生成过这个文件就当没有 */
    }
  }

  return { app: 'torra', schemaVersion: BACKUP_SCHEMA_VERSION, generatedAt: Date.now(), device, files, fileTimes }
}

/**
 * 把合并结果写回本机。
 *
 * 每个路径都要重新过一次 isBackupPath 与 path.resolve 的越界检查：
 * 备份包是从远端下来的**外部输入**，仓库一旦被换过内容，
 * 一串 `../` 就能写到 userData 外面去。
 */
export async function applyBundle(
  dataDir: string,
  bundle: BackupBundle,
): Promise<{ written: number; skipped: string[] }> {
  const root = path.resolve(dataDir)
  const skipped: string[] = []
  let written = 0
  for (const [rel, text] of Object.entries(bundle.files)) {
    const norm = normalizeRel(rel)
    if (!isBackupPath(norm)) {
      skipped.push(rel)
      continue
    }
    const abs = path.resolve(root, norm)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      skipped.push(rel)
      continue
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await atomicWrite(abs, text)
    written += 1
  }
  return { written, skipped }
}

function parseBundle(text: string): BackupBundle | null {
  try {
    const raw = JSON.parse(text) as unknown
    return isReadableBundle(raw) ? (raw as BackupBundle) : null
  } catch {
    return null
  }
}

/** 推送：读远端 → 本地合并 → 整份写回 */
export async function pushBackup(
  token: string,
  target: BackupTarget,
  dataDir: string,
  device: string,
): Promise<SyncOutcome> {
  const local = await collectBundle(dataDir, device)
  const { bundle: clean, removed } = scrubBundle(local)
  const leaks = findSecretLeaks(clean.files)
  if (leaks.length > 0) {
    const first = leaks.slice(0, 3).map((l) => `${l.path}（${l.kind}）`).join('、')
    return fail(`备份包里检测到疑似密钥：${first}。已中止推送 —— Key 只应存在系统钥匙串里`)
  }

  const remoteFile = await ghGetFile(token, target)
  if (!remoteFile.ok && remoteFile.status !== 404) return fail(remoteFile.reason)
  const remote = remoteFile.ok && remoteFile.data ? parseBundle(remoteFile.data.text) : null
  if (remoteFile.ok && remoteFile.data && !remote) {
    return fail(`${target.file} 存在但不是可读的 Torra 备份包（结构版本可能更新），已中止覆盖`)
  }

  const merged = mergeBundles({ ...clean, device }, remote)
  const text = JSON.stringify(merged.bundle, null, 2)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_BUNDLE_BYTES) {
    return fail(`备份包 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过 40 MB 上限：先清理历史场次或导出留档`)
  }

  const stamp = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const when = `${stamp.getFullYear()}-${p(stamp.getMonth() + 1)}-${p(stamp.getDate())} ${p(stamp.getHours())}:${p(stamp.getMinutes())}`
  const message = `Torra 备份 ${when}（${device || '本机'}）— ${bundleStat(merged.bundle).sessions} 场`
  const put = await ghPutFile(token, target, text, message, remoteFile.ok ? remoteFile.data?.sha : undefined)
  if (!put.ok) return fail(put.reason)

  const stat = bundleStat(merged.bundle)
  return {
    ok: true,
    added: merged.stat.added.length,
    pulled: merged.stat.pulled.length,
    pushed: merged.stat.pushed.length,
    same: merged.stat.same.length,
    bytes,
    sessions: stat.sessions,
    remoteAt: merged.bundle.generatedAt,
    remoteDevice: remote?.device ?? null,
    scrubbed: removed.length,
  }
}

/** 拉取：读远端 → 本地合并 → 写回本机（不推，避免一次点击改成两处） */
export async function pullBackup(
  token: string,
  target: BackupTarget,
  dataDir: string,
  device: string,
): Promise<SyncOutcome> {
  const remoteFile = await ghGetFile(token, target)
  if (!remoteFile.ok) return fail(remoteFile.reason)
  if (!remoteFile.data) {
    return fail(`仓库 ${target.owner}/${target.repo} 的 ${target.file} 还不存在，先在这台机器上做一次备份`)
  }
  const remote = parseBundle(remoteFile.data.text)
  if (!remote) return fail('远端备份包读不了：结构版本比本机新，或文件已损坏')

  const local = await collectBundle(dataDir, device)
  const merged = mergeBundles(local, remote)
  const applied = await applyBundle(dataDir, merged.bundle)
  const stat = bundleStat(merged.bundle)
  return {
    ok: true,
    added: merged.stat.added.length,
    pulled: merged.stat.pulled.length,
    pushed: merged.stat.pushed.length,
    same: merged.stat.same.length,
    bytes: Buffer.byteLength(JSON.stringify(merged.bundle), 'utf8'),
    sessions: stat.sessions,
    remoteAt: remote.generatedAt,
    remoteDevice: remote.device,
    scrubbed: 0,
    ...(applied.skipped.length > 0 ? { note: `已跳过 ${applied.skipped.length} 个不认识的路径` } : {}),
  }
}

export type TestOutcome = BackupTestResult


/**
 * 连通性检查：令牌是谁、仓库在不在、备份包有没有。
 *
 * `createIfMissing` 为真时会建一个**私有**仓库 —— 备份里是用户的全部讨论存档，
 * 建公开仓库这个动作不该由一次「测试连接」静默完成；界面上的文案也写清了这一点。
 */
export async function testTarget(
  token: string,
  target: BackupTarget,
  createIfMissing: boolean,
): Promise<TestOutcome> {
  const user = await ghUser(token)
  if (!user.ok) return { ok: false, reason: user.reason }

  let repo = await ghRepo(token, target.owner, target.repo)
  let created = false
  if (!repo.ok && repo.status === 404 && createIfMissing) {
    if (target.owner !== user.data.login) {
      return {
        ok: false,
        login: user.data.login,
        reason: `仓库 ${target.owner}/${target.repo} 不存在，且 owner 不是你本人（${user.data.login}），建不了`,
      }
    }
    const made = await ghCreateRepo(token, target.repo)
    if (!made.ok) return { ok: false, login: user.data.login, reason: made.reason }
    repo = made
    created = true
  }
  if (!repo.ok) return { ok: false, login: user.data.login, reason: repo.reason }
  if (repo.data.permissions && repo.data.permissions.push === false) {
    return { ok: false, login: user.data.login, repo: repo.data.full_name, reason: '令牌能读这个仓库但没有写权限' }
  }

  const file = await ghGetFile(token, target)
  const bundle = file.ok && file.data ? parseBundle(file.data.text) : null
  return {
    ok: true,
    login: user.data.login,
    repo: repo.data.full_name,
    created,
    hasBundle: !!bundle,
    remoteAt: bundle?.generatedAt ?? null,
  }
}
