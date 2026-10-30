/**
 * 备份包的收集 / 落地 / 推拉。
 *
 * 三件事在这里拼起来，缺一件都会出现「看着同步成功、其实丢东西」：
 * 收集（按 shared/backup 的收纳清单走）、落地（写回本机并原子替换）、
 * 推拉（先在本地合并，再整份写回远端 —— 远端历史由 git 提交保管）。
 *
 * 为什么推送前一定要先读远端：备份的目的是「两台机器都有同一份」，
 * 后推的那台若直接覆盖，先推的那台新增的场次就没了。读一次的成本是一次 GET。
 *
 * 密钥袋走同一条链上的**另一个文件**（secretsFileFor 推导，与数据包同目录）：
 * 数据包按路径合并，袋子是整份覆盖 —— 两条语义混在一个包里，
 * 就会出现「分享讨论存档时顺手把密钥也分享了」这种没法挽回的事。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  BACKUP_SCHEMA_VERSION,
  bundleStat,
  bagPathUsable,
  findSecretLeaks,
  isBackupPath,
  isReadableBundle,
  isReadableSecretsEnvelope,
  mergeBundles,
  normalizeRel,
  NO_BAG_OUTCOME,
  scrubBundle,
  secretsFileFor,
  type BackupBundle,
  type BackupSyncResult,
  type BackupTestResult,
  type BackupTarget,
} from '../../shared/backup'
import { atomicWrite } from '../store/session-store'
import { buildBag, openBag, type RefValue } from './secrets-bag'
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
    bag: { ...NO_BAG_OUTCOME },
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
  // 插件落库的数据与助手会话都是「丢了就长不回来」的那一类，跟场次同级
  await walk(path.join(dataDir, 'plugin-data'), 'plugin-data')
  await walk(path.join(dataDir, 'assistant-sessions'), 'assistant-sessions')
  for (const name of ['preferences.json', 'models.json', 'models.snapshot.json', 'plugins-state.json']) {
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

/**
 * 袋子同样「解析不了就当不可读」：远端那一份是外部输入，
 * 一句 `JSON.parse` 抛出来会把整个拉取吊死在异常里，界面连原因都拿不到。
 */
function envelopeReadable(text: string): boolean {
  try {
    return isReadableSecretsEnvelope(JSON.parse(text) as unknown)
  } catch {
    return false
  }
}

/** 推送：读远端 → 本地合并 → 整份写回；开了密钥袋就在同一个事务窗口里再写一个袋子 */
export interface PushBagInput {
  /** 空串表示「开着袋但这次手里没口令」—— 数据照推，远端那份袋子一个字都不动 */
  passphrase: string
  /** 钥匙串里读出来的条目（已由调用方按 BAG_EXCLUDED_REFS 过滤过） */
  entries: RefValue[]
}

export async function pushBackup(
  token: string,
  target: BackupTarget,
  dataDir: string,
  device: string,
  bag?: PushBagInput,
): Promise<SyncOutcome> {
  const local = await collectBundle(dataDir, device)
  const { bundle: clean, removed } = scrubBundle(local)
  const leaks = findSecretLeaks(clean.files)
  if (leaks.length > 0) {
    const first = leaks.slice(0, 3).map((l) => `${l.path}（${l.kind}）`).join('、')
    return fail(`备份包里检测到疑似密钥：${first}。已中止推送 —— Key 只应存在系统钥匙串里`)
  }

  /*
   * 袋子的落点排在动手之前判：它只依赖「存放路径」这一格配置，
   * 判不过说明配置本身有毛病，那就一个字节都别发出去 ——
   * 数据推成功了再说「密钥袋写不了」是最难查的一种半完成状态。
   */
  const bagPath = bag ? bagPathUsable(target.file) : null
  if (bagPath && !bagPath.ok) return fail(bagPath.reason)
  const bagFile = bagPath && bagPath.ok ? bagPath.file : ''

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

  /*
   * 密钥袋排在数据包之后：数据没推成就不该把钥匙挂上去。
   * 覆盖远端袋子前同样要先拿它的 sha —— 袋子是「整份覆盖」而不是合并，
   * 另一台机器刚换过 Key 而这里看不见，就会把它的密钥静默回滚成旧的一袋。
   */
  let bagOutcome: BackupSyncResult['bag'] = { ...NO_BAG_OUTCOME }
  if (bag) {
    if (!bag.passphrase) {
      bagOutcome = { refs: 0, wrote: false, note: '密钥袋开着，但这一次没输入口令：远端那份保持原样' }
    } else {
      const built = await buildBag(bag.passphrase, bag.entries, device)
      if (!built.ok) {
        bagOutcome = { refs: 0, wrote: false, note: `密钥袋没装上：${built.reason}` }
      } else {
        const remoteBag = await ghGetFile(token, target, bagFile)
        const bagPut = remoteBag.ok
          ? await ghPutFile(token, target, built.text, `Torra 密钥袋 ${when}（${device || '本机'}）`, remoteBag.data?.sha, bagFile)
          : await ghPutFile(token, target, built.text, `Torra 密钥袋 ${when}（${device || '本机'}）`, undefined, bagFile)
        bagOutcome = bagPut.ok
          ? { refs: built.refs, wrote: true }
          : { refs: built.refs, wrote: false, note: `数据已备份，密钥袋没写上：${bagPut.reason}` }
      }
    }
  }

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
    bag: bagOutcome,
  }
}

/**
 * 拉取：读远端 → 本地合并 → 写回本机（不推，避免一次点击改成两处）。
 *
 * 返回值里的 `entries` 是给 backup/service.ts 就地写进钥匙串用的，
 * 它**不许**跟着结果一起过 IPC 到渲染层：渲染层要的是「恢复了几条」这个数字，
 * 不是值本身。调用方读完立刻 delete。
 */
export type PullOutcome = SyncOutcome & { entries?: RefValue[] }

export async function pullBackup(
  token: string,
  target: BackupTarget,
  dataDir: string,
  device: string,
  bagPassphrase = '',
): Promise<PullOutcome> {
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

  /*
   * 密钥袋单独一次 GET，失败不影响数据恢复：远端没袋子是常态（没开过），
   * 有袋子而这里没口令也是常态（口令不落盘，重启就没了）。
   * 「远端根本没袋子」不问一句、不说一句 —— 没开过密钥袋的用户每次恢复都看到
   * 「这次没带密钥袋」，会把一句正常状态读成一个待办。只有真出事才留话。
   */
  let bagOutcome: BackupSyncResult['bag'] = { ...NO_BAG_OUTCOME }
  let entries: RefValue[] | undefined
  const bagFile = secretsFileFor(target.file)
  const remoteBag = await ghGetFile(token, target, bagFile)
  if (remoteBag.ok && remoteBag.data) {
    if (!envelopeReadable(remoteBag.data.text)) {
      bagOutcome = { refs: 0, wrote: false, note: '远端密钥袋的信封不认识（版本或参数比本机新），已跳过' }
    } else if (!bagPassphrase) {
      bagOutcome = { refs: 0, wrote: false, note: '远端有密钥袋，但本机还没输入备份口令：只恢复了数据' }
    } else {
      const opened = await openBag(remoteBag.data.text, bagPassphrase)
      // 解开成功这句不写 note：条数是上层写进钥匙串时才数得准的，
      // 这里抢先说「已写回」会在写失败时留下一句假话。
      bagOutcome = opened.ok
        ? { refs: opened.entries.length, wrote: false }
        : { refs: 0, wrote: false, note: opened.reason }
      if (opened.ok) entries = opened.entries
    }
  } else if (!remoteBag.ok && remoteBag.status !== 404) {
    bagOutcome = { refs: 0, wrote: false, note: `密钥袋没读到：${remoteBag.reason}` }
  }

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
    bag: bagOutcome,
    ...(entries ? { entries } : {}),
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
  /*
   * 顺手读一眼袋子在不在：用户点「测试连接」时想知道的其实是
   * 「这台机器能不能原样复活」，而没带密钥袋的复活要重贴一遍 Key，是另一回事。
   * 只读 createdAt 一个数字，口令与值都不碰。
   */
  const bagFile = secretsFileFor(target.file)
  const bagFileRes = await ghGetFile(token, target, bagFile)
  let bagAt: number | null = null
  if (bagFileRes.ok && bagFileRes.data && envelopeReadable(bagFileRes.data.text)) {
    try {
      const env = JSON.parse(bagFileRes.data.text) as { createdAt?: number }
      bagAt = typeof env.createdAt === 'number' ? env.createdAt : null
    } catch {
      bagAt = null
    }
  }
  return {
    ok: true,
    login: user.data.login,
    repo: repo.data.full_name,
    created,
    hasBundle: !!bundle,
    remoteAt: bundle?.generatedAt ?? null,
    hasBag: bagAt !== null,
    bagAt,
  }
}
