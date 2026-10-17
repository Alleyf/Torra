/**
 * 数据备份与同步（GitHub 仓库）
 *
 * 为什么是「一个 JSON 包 + 一个仓库文件」而不是镜像整目录：
 * 1. 同步要能合。合的最小单位不是文件而是会话语义（同一场在两台机器上改过，
 *    按 updatedAt 取新的那一份）；镜像目录会把「哪些文件属于同一场」重新抛回调用方；
 * 2. GitHub 仓库自带版本历史。一个包每次提交都是一条可回看的记录，
 *    不需要我们再造一套快照目录；
 * 3. 一次请求就能拉全量，不存在「拉到一半」的中间态。
 *
 * 不可协商的一条：**密钥不进备份包**。Keys 存系统钥匙串（PRD 11.2），
 * models.json 里只有 `apiKeyRef` 这类引用名。这个文件里的 findSecretLeaks 是
 * 推送前的最后一道闸门 —— 它拦的正是「哪天有人把 Key 写回了 models.json」。
 *
 * 这一层是纯函数：不碰 fs、不碰 electron，脱机就能测。
 */

/** 存档结构版本。改语义或删字段才抬；加字段不抬。 */
export const BACKUP_SCHEMA_VERSION = 1

/**
 * 备份包的默认文件名。默认就放在仓库根 —— 仓库是用户自己的，别抢命名；
 * 想收进子目录由 normalizeBundlePath 拼出来（见下）。
 */
export const BUNDLE_FILE = 'torra-backup.json'

export const DEFAULT_BRANCH = 'main'

/**
 * 收纳清单（唯一口径）。主进程按它读盘、测试按它断言，
 * 两份名单一旦分开写，早晚出现「测试说收了、实际没收」。
 *
 * 有意不收的：keys/（密钥）、chat-assets/（图片二进制，单张上限 10 MB）、
 * exports/（导出件可由报告重生成）、flags/、logs、*.events.jsonl / *.diag.jsonl
 * （投影与诊断切片，体积随轮数增长，且都能由会话存档重建）。
 *
 * 覆盖到模型侧：models.json 里只有 `apiKeyRef` / `headersRef` 这类**引用名**，
 * 真正的 API Key 本体在系统钥匙串（keys/）；网页模型的登录态在 Electron 分区存储里，
 * 两者都不在 dataDir 的收纳清单中，因此都不会进备份包。这里再叠一层密钥闸门，
 * 只认引用名、凡是漏进来的明文 Cookie / 令牌一律剔掉并中止。
 */
const INCLUDE_DIRS = ['sessions', 'adapters'] as const
const INCLUDE_FILES = ['preferences.json', 'models.json'] as const
const SKIP_SUFFIXES = ['.events.jsonl', '.diag.jsonl'] as const

export interface BackupTarget {
  owner: string
  repo: string
  branch: string
  /** 备份包在仓库里的相对路径（含文件名），由 normalizeBundlePath 归一 */
  file: string
}

export interface BackupFileStat {
  sessions: number
  reports: number
  adapters: number
  bytes: number
}

/**
 * 一次备份 / 恢复的结果。
 *
 * 计数口径要在界面上说得出口，所以四个数分开留着：
 * added / pulled 是「这次从远端拿回来的」，pushed 是「只在本机、这次一并送上去的」，
 * same 是两边一样的。合成一个「同步了 N 项」等于把三种含义揉成一句没法核对的话。
 */
export interface BackupSyncResult {
  ok: boolean
  reason?: string
  /** 成功但需要带一句说明（例如跳过了几个不认识的路径） */
  note?: string
  added: number
  pulled: number
  pushed: number
  same: number
  bytes: number
  sessions: number
  remoteAt: number | null
  remoteDevice: string | null
  /** 推送前被剔掉的疑似密钥字段数（正常应为 0） */
  scrubbed: number
}

export interface BackupTestResult {
  ok: boolean
  reason?: string
  login?: string
  repo?: string
  created?: boolean
  hasBundle?: boolean
  remoteAt?: number | null
}

export interface BackupBundle {
  app: 'torra'
  schemaVersion: number
  generatedAt: number
  /** 产出这份包的机器名（多机同步时界面上说清「远端是谁」） */
  device: string
  /** 相对 dataDir 的路径（一律 / 分隔）→ 文件原文 */
  files: Record<string, string>
  /** 同名路径的最后修改时间（epoch ms），合并时按它取新的那一侧 */
  fileTimes: Record<string, number>
}

export interface BackupState {
  /** 仓库地址已填（不一定要能连上） */
  configured: boolean
  target: string
  branch: string
  /** 备份包在仓库里的存放路径（默认就是仓库根的 torra-backup.json） */
  path: string
  hasToken: boolean
  busy: null | 'test' | 'push' | 'pull'
  lastPushAt: number | null
  lastPullAt: number | null
  lastNote: string | null
  /** 最近一次操作的成败：界面据此决定那行字是绿还是红 */
  lastOk: boolean | null
  /** 远端包的信息（推送后 / 测试连接时顺手读到） */
  remoteAt: number | null
  remoteDevice: string | null
}

export function initialBackupState(): BackupState {
  return {
    configured: false,
    target: '',
    branch: DEFAULT_BRANCH,
    path: '',
    hasToken: false,
    busy: null,
    lastPushAt: null,
    lastPullAt: null,
    lastNote: null,
    lastOk: null,
    remoteAt: null,
    remoteDevice: null,
  }
}

/**
 * 备份包在仓库里的存放路径。
 *
 * 用户嘴里的「路径」就是两种东西，两种都收：
 *   `backups/` 或 `backups`（看着是目录）→ `backups/torra-backup.json`
 *   `notes/site-b.json`（完整文件名）→ 原样
 * 留空 = 仓库根下的 `torra-backup.json`（也是老行为，不改）。
 *
 * 归一必须在这一层做完：这个串会以「API 地址成分」的形态发出去，
 * `..`、绝对路径、盘符漏过去一个，就是往仓库外面写。
 */
export function normalizeBundlePath(input: string): { ok: true; path: string } | { ok: false; reason: string } {
  const raw = normalizeRel(input).trim()
  if (!raw) return { ok: true, path: BUNDLE_FILE }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, reason: '存放路径要写仓库里的相对路径：不能以 / 开头，也不能带盘符' }
  }
  if (raw.length > 200) return { ok: false, reason: '存放路径太长了（200 个字符以内）' }

  const segs = raw.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, reason: '存放路径里不能有空段、. 或 ..' }
  }
  if (!segs.every((s) => /^[A-Za-z0-9._-]+$/.test(s))) {
    return { ok: false, reason: '存放路径只能用字母、数字、点、横线、下划线和 /' }
  }

  const last = segs[segs.length - 1] ?? ''
  // 以 / 结尾、或者最后一段连个点都没有，就按目录理解，补上默认文件名
  const asDir = raw.endsWith('/') || !last.includes('.')
  const full = asDir ? [...segs, BUNDLE_FILE].join('/') : segs.join('/')
  if (!/\.json$/i.test(full)) {
    return { ok: false, reason: '备份包要是一个 .json 文件，例如 backups/torra-backup.json' }
  }
  return { ok: true, path: full }
}

/**
 * 仓库地址解析：接受 `owner/repo`、`https://github.com/owner/repo(.git)`、
 * 以及带 `/tree/<branch>` 的完整链接。分支不在地址里就取传入的默认分支；
 * 地址尾巴上那一截（`/tree/main/backups` 的 `backups`）当存放路径用。
 */
export function parseBackupTarget(
  input: string,
  fallbackBranch = DEFAULT_BRANCH,
  fallbackPath = '',
): { ok: true; target: BackupTarget } | { ok: false; reason: string } {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, reason: '请填写仓库，例如 Alleyf/torra-backup' }

  // 先剥掉 URL 外壳；只认 github.com 的地址，其它域名不猜
  let body = raw
  let branchFromUrl = ''
  let pathFromUrl = ''
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(raw)
  if (m) {
    body = m[1] ?? ''
  } else if (/^https?:\/\//i.test(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return { ok: false, reason: '只支持 github.com 上的仓库地址' }
  }
  const tree = /^([^/]+)\/([^/]+?)(?:\.git)?\/tree\/([^/]+)\/?(.*)$/.exec(body)
  if (tree) {
    body = `${tree[1]}/${tree[2]}`
    branchFromUrl = decodeURIComponent(tree[3] ?? '')
    pathFromUrl = decodeURIComponent((tree[4] ?? '').trim())
  }
  const plain = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(body)
  if (!plain) return { ok: false, reason: '仓库要写成 owner/repo 两段' }

  const owner = plain[1] ?? ''
  const repo = plain[2] ?? ''
  // GitHub 的命名规则比这更宽，但收紧在这里只有好处：这些字符一旦漏过去，
  // 就会以「路径成分」的形态出现在 API 地址里。
  const NAME = /^[A-Za-z0-9_.-]{1,100}$/
  if (!NAME.test(owner) || !NAME.test(repo)) {
    return { ok: false, reason: '仓库名里有不支持的字符' }
  }
  const branch = (branchFromUrl || String(fallbackBranch ?? '').trim() || DEFAULT_BRANCH).replace(/[^\w./-]/g, '')
  const file = normalizeBundlePath(pathFromUrl || fallbackPath)
  if (!file.ok) return file
  return { ok: true, target: { owner, repo, branch: branch || DEFAULT_BRANCH, file: file.path } }
}

/** 统一成相对路径：反斜杠转正斜杠，去掉前导 ./，拒绝越界与绝对路径 */
export function normalizeRel(input: string): string {
  const s = String(input ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  return s.replace(/\/{2,}/g, '/')
}

export function isBackupPath(input: string): boolean {
  const rel = normalizeRel(input)
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false
  if (rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false
  if (SKIP_SUFFIXES.some((s) => rel.endsWith(s))) return false
  const top = rel.split('/')[0] ?? ''
  if ((INCLUDE_DIRS as readonly string[]).includes(top)) return true
  return (INCLUDE_FILES as readonly string[]).includes(rel)
}

/** 这份 JSON 能不能当备份包读。比当前实现新的包一律拒读，理由同会话存档。 */
export function isReadableBundle(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const b = raw as Partial<BackupBundle>
  if (b.app !== 'torra') return false
  const v = b.schemaVersion
  if (typeof v !== 'number' || !Number.isFinite(v) || v > BACKUP_SCHEMA_VERSION) return false
  if (typeof b.files !== 'object' || b.files === null || Array.isArray(b.files)) return false
  for (const [k, val] of Object.entries(b.files)) {
    if (!isBackupPath(k)) return false
    if (typeof val !== 'string') return false
  }
  return true
}

export interface MergeStat {
  /** 本地没有、远端带来的 */
  added: string[]
  /** 两边都有，远端较新且内容不同 */
  pulled: string[]
  /** 本地较新（远端那侧被本地的覆盖） */
  pushed: string[]
  /** 两边都在、内容一致 */
  same: string[]
}

export interface MergeResult {
  bundle: BackupBundle
  stat: MergeStat
}

/**
 * 合并两份包。
 *
 * 口径：**按路径逐份取「较新的那一份」**，不做内容级三方合并。
 * 一场讨论的存档是整体对象（轮次、发言、台账相互引用），把两边字段拼起来
 * 只会造出一份谁也没见过的存档；宁可整份取新，也不要半新半旧。
 *
 * 已知边界：这里不传播「删除」。本地删掉的场次，远端还在，下一次拉取会把它带回来。
 * 会话存档是用户唯一的事后依据，宁可多留一份，也不要因为一次误删把它从所有机器上抹掉
 * —— 真要删，去远端仓库把那份删掉再拉。
 */
export function mergeBundles(local: BackupBundle, remote: BackupBundle | null): MergeResult {
  const stat: MergeStat = { added: [], pulled: [], pushed: [], same: [] }
  const files: Record<string, string> = {}
  const fileTimes: Record<string, number> = {}
  const paths = new Set([...Object.keys(local.files), ...(remote ? Object.keys(remote.files) : [])])

  for (const p of [...paths].sort()) {
    const l = local.files[p]
    const r = remote?.files[p]
    const lt = local.fileTimes[p] ?? 0
    const rt = remote?.fileTimes?.[p] ?? 0
    if (l !== undefined && r === undefined) {
      files[p] = l
      fileTimes[p] = lt
      stat.pushed.push(p)
      continue
    }
    if (l === undefined && r !== undefined) {
      files[p] = r
      fileTimes[p] = rt
      stat.added.push(p)
      continue
    }
    if (l === undefined || r === undefined) continue
    if (l === r) {
      files[p] = l
      fileTimes[p] = Math.max(lt, rt)
      stat.same.push(p)
      continue
    }
    // 同时间戳时本地胜出：冲突必须有一个确定的答案，不能靠遍历顺序
    const takeRemote = rt > lt
    files[p] = takeRemote ? r : l
    fileTimes[p] = takeRemote ? rt : lt
    ;(takeRemote ? stat.pulled : stat.pushed).push(p)
  }

  return {
    bundle: {
      app: 'torra',
      schemaVersion: BACKUP_SCHEMA_VERSION,
      generatedAt: Date.now(),
      device: local.device || remote?.device || '',
      files,
      fileTimes,
    },
    stat,
  }
}

/** 备份包里现在有什么（界面与诊断都要回答这一句，所以只算一次） */
export function bundleStat(bundle: BackupBundle): BackupFileStat {
  const paths = Object.keys(bundle.files)
  // TextEncoder 而不是 Buffer：这一份要被渲染层也读到，Buffer 在那里不存在
  const enc = new TextEncoder()
  const bytes = paths.reduce((acc, p) => acc + enc.encode(bundle.files[p] ?? '').length, 0)
  return {
    sessions: paths.filter((p) => /^sessions\/[^/]+\.json$/.test(p)).length,
    reports: paths.filter((p) => /^sessions\/reports\/[^/]+\.json$/.test(p)).length,
    adapters: paths.filter((p) => p.startsWith('adapters/')).length,
    bytes,
  }
}

/**
 * 明显像密钥的串。
 *
 * 这是最后一层兜底，不是第一层 —— 第一层是「Key 只进钥匙串」，
 * 第二层是 scrubBundle 把已知字段名剔掉。这一层拦的是我们没预见到的新字段名。
 */
const LEAK_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'GitHub 令牌', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { kind: 'GitHub 细粒度令牌', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'OpenAI 风格 Key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { kind: 'Anthropic Key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  {
    kind: '明文密钥字段',
    re: /"(?:apiKey|api_key|token|accessToken|password|secret|authorization)"\s*:\s*"[^"]{12,}"/,
  },
  {
    kind: 'Cookie 串',
    // 站点登录态常以整串 cookie 出现（sessionid=...; token=...）。它是登录凭据，
    // 备份包里不能出现 —— 只认系统钥匙串与分区存储里那份原值。
    re: /\b(?:sessionid|session_id|sid|token|access_token|auth|cookie)\s*=\s*[A-Za-z0-9_.\-]{16,}/,
  },
  {
    kind: 'Authorization 头',
    // `Authorization: Bearer xxxx` 这类整段落在备份里也是凭据裸奔
    re: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._\-+/]{16,}/,
  },
]

export interface SecretLeak {
  path: string
  kind: string
}

export function findSecretLeaks(files: Record<string, string>): SecretLeak[] {
  const out: SecretLeak[] = []
  for (const [p, text] of Object.entries(files)) {
    for (const { kind, re } of LEAK_PATTERNS) {
      if (re.test(text)) {
        out.push({ path: p, kind })
        break
      }
    }
  }
  return out
}

/** 会被整键剔除的字段名（大小写与下划线都归一过） */
const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'password',
  'secret',
  'clientsecret',
  'client_secret',
  'authorization',
  'http_headers',
  'cookie',
  'cookies',
  'setcookie',
  'set-cookie',
])

function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 24) return value
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1))
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k.toLowerCase())) continue
    out[k] = stripSecrets(v, depth + 1)
  }
  return out
}

export interface ScrubResult {
  bundle: BackupBundle
  /** 被剔掉的字段路径，诊断与界面据此说清「备份里少了什么」 */
  removed: string[]
}

/**
 * 剔掉一切像密钥的字段。
 *
 * 只对 JSON 且能解析的文件动手：解析不了就原样留着，交给 findSecretLeaks 判定 ——
 * 宁可整场备份被拦下报错，也不要悄悄把一份看不懂的文件「清洗」成半份。
 */
export function scrubBundle(bundle: BackupBundle): ScrubResult {
  const files: Record<string, string> = {}
  const removed: string[] = []
  for (const [p, text] of Object.entries(bundle.files)) {
    if (!p.endsWith('.json')) {
      files[p] = text
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      files[p] = text
      continue
    }
    const found = collectSecretPaths(parsed, p)
    if (found.length === 0) {
      files[p] = text
      continue
    }
    removed.push(...found)
    files[p] = JSON.stringify(stripSecrets(parsed), null, 2)
  }
  return { bundle: { ...bundle, files }, removed }
}

function collectSecretPaths(value: unknown, base: string, depth = 0): string[] {
  if (depth > 24) return []
  if (Array.isArray(value)) return value.flatMap((v, i) => collectSecretPaths(v, `${base}[${i}]`, depth + 1))
  if (typeof value !== 'object' || value === null) return []
  const out: string[] = []
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k.toLowerCase())) {
      out.push(`${base}.${k}`)
      continue
    }
    out.push(...collectSecretPaths(v, `${base}.${k}`, depth + 1))
  }
  return out
}

/**
 * 备份目标的默认名。用户没想法时要有一个能直接用的答案，
 * 否则「填一个仓库」这一步会卡住整条链路。
 */
export function defaultBackupRepoName(): string {
  return 'torra-backup'
}
