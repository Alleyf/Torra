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

/**
 * 存档结构版本。改语义或删字段才抬；加字段不抬。
 *
 * 这一条抬到 2 是因为**包里出现的文件范围变了**：旧版本手里那份 isBackupPath 不认识
 * `plugin-data/…`，读新包时会整包拒收（isReadableBundle 逐路径判）。两种后果挑一种：
 * 旧版拒收并说清「结构版本比本机新」，还是旧版按自己的旧清单只恢复一半、
 * 界面上那行「已恢复」却是绿的？选前者。反方向不受影响：新版读 v1 包照常
 * （isReadableBundle 只拒「比本机新」的），已有仓库里的旧包不需要迁移。
 */
export const BACKUP_SCHEMA_VERSION = 2

/**
 * 备份包的默认文件名。默认就放在仓库根 —— 仓库是用户自己的，别抢命名；
 * 想收进子目录由 normalizeBundlePath 拼出来（见下）。
 */
export const BUNDLE_FILE = 'torra-backup.json'

export const DEFAULT_BRANCH = 'main'

/**
 * 备份收纳清单（唯一口径）。主进程按它读盘、测试按它断言，
 * 两份名单一旦分开写，早晚出现「测试说收了、实际没收」。
 *
 * 这一版的目标是**所有不可再生的用户数据**都在包里：除原有的会话存档与适配器，
 * 新增 plugin-data（应用插件的落库数据：文献条目、轨迹、记忆）、
 * assistant-sessions（助手会话逐条）、models.snapshot.json、plugins-state.json。
 *
 * 有意不收的：keys/（密钥本体，改由口令密钥袋走，见 SecretsBag 那一段）、
 * pi/（auth.json 是第三方 agent SDK 的**明文**凭据文件，skills 又是指向别人仓库的
 * junction 链，两样都不该进包）、chat-assets/（图片二进制，单张上限 10 MB）、
 * exports/（导出件可由报告重生成）、flags/、logs、*.events.jsonl / *.diag.jsonl
 * （投影与诊断切片，体积随轮数增长，且都能由会话存档重建）。
 * 可再生那一类不进包不是偷懒：Git 历史会因为一次覆盖永久留下每一版图片与日志，
 * 而它们丢了随时能长回来。
 *
 * 覆盖到模型侧：models.json 里只有 `apiKeyRef` / `headersRef` 这类**引用名**，
 * 真正的 API Key 本体在系统钥匙串（keys/）；网页模型的登录态在 Electron 分区存储里，
 * 两者都不在 dataDir 的收纳清单中，因此都不会进备份包。这里再叠一层密钥闸门，
 * 只认引用名、凡是漏进来的明文 Cookie / 令牌一律剔掉并中止。
 */
const INCLUDE_DIRS = ['sessions', 'adapters', 'plugin-data', 'assistant-sessions'] as const
const INCLUDE_FILES = ['preferences.json', 'models.json', 'models.snapshot.json', 'plugins-state.json'] as const
const SKIP_SUFFIXES = ['.events.jsonl', '.diag.jsonl'] as const

/**
 * 黑名单压在白名单前面：`keys` 与 `pi` 这两个名字一旦哪天被顺手加进 INCLUDE_DIRS，
 * 光看白名单是拦不住的（密钥本体与明文凭据文件就在那两棵树下）。
 * 于是这里只留一条路 —— 无论白名单怎么改，这些顶层目录永远进不了包。
 */
const NEVER_DIRS = ['keys', 'pi', 'logs', 'chat-assets', 'exports', 'flags'] as const

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
  /** 应用插件落库的数据文件数（科研工作台的文献、轨迹、记忆都在这里） */
  pluginData: number
  /** 助手会话文件数 */
  assistantSessions: number
  /** 包里一共多少份文件——「收了什么」要说得出总数，不能只报场次 */
  entries: number
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
  /** 密钥袋这一趟的下落：只报条数与「有没有写上远端」，内容一个字符都不露 */
  bag: BagOutcome
}

export interface BagOutcome {
  /** 装进袋里 / 从袋里解出的条数 */
  refs: number
  /** 这一次有没有真的把袋子写上远端 */
  wrote: boolean
  /** 没带上、没解开、远端没有袋子时的人话原因 */
  note?: string
}

/** 什么都没做时的那一格：留着它，SyncOutcome 就不必把 bag 写成可选再到处判空 */
export const NO_BAG_OUTCOME: BagOutcome = { refs: 0, wrote: false }

/**
 * 袋子的下落并成一句人话。
 *
 * 主进程写 lastNote、界面写动作回执都走这一份：两边各写一遍，
 * 早晚出现「一处说已更新、另一处说没写上」，而用户只能挑一句信。
 *
 * 三种「没带上」必须分得开：没开（正常，这句不该出现）、开着但这一轮没口令、
 * 开了也输了口令但远端写失败。第三种最要命 —— 数据已经在远端了，
 * 换机器的人按数据恢复却拿不到 Key。
 */
export function bagWord(bag: BagOutcome, kind: 'push' | 'pull'): string {
  if (kind === 'push') {
    if (bag.wrote) return `，密钥袋已更新（${bag.refs} 条）`
    if (bag.refs > 0) return `，密钥袋没写上（${bag.refs} 条还留在本机）`
    return bag.note ? `，${bag.note}` : ''
  }
  // 恢复这一侧没有「写上远端」这件事，只有「本机钥匙串里多了几条」
  if (bag.refs > 0) return `，密钥写回本机钥匙串 ${bag.refs} 条${bag.note ? `（${bag.note}）` : ''}`
  return bag.note ? `，${bag.note}` : ''
}

export interface BackupTestResult {
  ok: boolean
  reason?: string
  login?: string
  repo?: string
  created?: boolean
  hasBundle?: boolean
  remoteAt?: number | null
  /** 远端有没有密钥袋（只报有没有与生成时间，内容不在这一层） */
  hasBag?: boolean
  bagAt?: number | null
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

/* ── 定时自动备份 ────────────────────────────────────────────────
 * 调度判定全放在这里：纯函数、不碰 fs 与 electron，脱机就能把
 * 「什么时候该跑、什么时候必须让路」逐条断言。主进程只负责按节拍问一句。
 */

/** 支持的自动备份频率（小时）。没有「每分钟」这种选项：备份是写远端仓库的提交，太密只会淹掉历史。 */
export const AUTO_BACKUP_INTERVALS = [1, 6, 24] as const
export type AutoBackupInterval = (typeof AUTO_BACKUP_INTERVALS)[number]

export const DEFAULT_AUTO_BACKUP_INTERVAL: AutoBackupInterval = 24

export function isAutoBackupInterval(v: unknown): v is AutoBackupInterval {
  return (AUTO_BACKUP_INTERVALS as readonly number[]).includes(Number(v))
}

export interface AutoBackupConfig {
  enabled: boolean
  /** 间隔小时数，取值受 AUTO_BACKUP_INTERVALS 约束 */
  intervalHours: AutoBackupInterval
  /**
   * 自动跑的时候要不要顺带拉取（双向同步）。
   * 默认关：定时任务悄悄覆盖本机文件的风险，比「另一台机器的新场次晚一点到手」大得多。
   */
  pullToo: boolean
}

export function initialAutoBackupConfig(): AutoBackupConfig {
  return { enabled: false, intervalHours: DEFAULT_AUTO_BACKUP_INTERVAL, pullToo: false }
}

/** 偏好文件里读出来的东西不可信，逐字段归一；坏值回默认而不是整段作废。 */
export function normalizeAutoBackupConfig(raw: unknown): AutoBackupConfig {
  const o = (raw ?? {}) as Partial<AutoBackupConfig>
  const hours = Number(o.intervalHours)
  return {
    enabled: o.enabled === true,
    intervalHours: isAutoBackupInterval(hours) ? (hours as AutoBackupInterval) : DEFAULT_AUTO_BACKUP_INTERVAL,
    pullToo: o.pullToo === true,
  }
}

export interface AutoBackupDecision {
  run: boolean
  /** 不跑时的人话原因（进日志，不进错误弹窗：静默任务失败也要查得出为什么） */
  reason?: string
}

/**
 * 到点没有？—— 纯判据，「现在该不该动手」只在这一处回答。
 *
 * 以最近一次动过数据的时间（lastPushAt / lastPullAt 取大）为基准：
 * 刚手动备份过就不必立刻再来一次；从没备份过则视为「到点」，第一次节拍就跑。
 */
export function dueForAutoBackup(cfg: AutoBackupConfig, now: number, lastPushAt: number | null, lastPullAt: number | null): AutoBackupDecision {
  if (!cfg.enabled) return { run: false, reason: '自动备份没开' }
  const last = Math.max(lastPushAt ?? 0, lastPullAt ?? 0)
  if (last <= 0) return { run: true }
  const intervalMs = cfg.intervalHours * 3_600_000
  const elapsed = now - last
  if (elapsed < intervalMs) return { run: false, reason: `距上次同步还差 ${Math.ceil((intervalMs - elapsed) / 60_000)} 分钟` }
  return { run: true }
}

export interface AutoBackupGate {
  /** 有讨论在跑：存档正在连续变化，此刻打包等于备份一份「说到一半」的现场 */
  discussionActive: boolean
  /** 主进程 busy 非 null：手动动作正在进行，不重入 */
  busy: boolean
}

/** 让路判据：忙的时候宁可不跑，等下一个节拍 —— 自动任务不该跟用户抢同一份数据。 */
export function autoBackupGateBlocked(gate: AutoBackupGate): string | null {
  if (gate.discussionActive) return '有讨论正在进行，这一拍跳过'
  if (gate.busy) return '上一次备份还没结束，这一拍跳过'
  return null
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
  /** 定时自动备份的配置（界面直接照着画，不再另开一条 IPC） */
  auto: AutoBackupConfig
  /** 密钥袋这一格的状态（开关落盘，口令不落盘） */
  bag: SecretsBagState
}

export interface SecretsBagState {
  /** 用户有没有要求「备份时把密钥也带上」。落 preferences */
  enabled: boolean
  /**
   * 这一次会话里主进程手里有没有口令。
   * 没有口令时数据照备份、远端那份袋子保持原样 —— 界面上必须区分这两种，
   * 否则用户会以为密钥刚同步过。
   */
  passphraseHeld: boolean
  /** 本机钥匙串里有几条密钥（只报条数；引用名与值都不越 IPC） */
  localRefs: number
  /** 远端那份袋子生成于什么时候；没读到过就是 null */
  remoteAt: number | null
}

export function initialSecretsBagState(): SecretsBagState {
  return { enabled: false, passphraseHeld: false, localRefs: 0, remoteAt: null }
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
    auto: initialAutoBackupConfig(),
    bag: initialSecretsBagState(),
  }
}

/** preferences 里那一格读出来不可信：只认 enabled === true，其它一律回默认关 */
export function normalizeSecretsBagConfig(raw: unknown): { enabled: boolean } {
  const o = (raw ?? {}) as Partial<{ enabled: boolean }>
  return { enabled: o.enabled === true }
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
  // 先否黑名单：密钥本体与 pi/auth.json 那类明文凭据，一旦混进包里就是整包级别的泄露，
  // 这一层不靠白名单写得多正确，只靠它比白名单先回答
  if ((NEVER_DIRS as readonly string[]).includes(top)) return false
  if ((INCLUDE_DIRS as readonly string[]).includes(top)) return true
  return (INCLUDE_FILES as readonly string[]).includes(rel)
}

/* ── 口令加密的密钥袋 ────────────────────────────────────────────
 *
 * 为什么要有这一层：`keys/` 里那堆 .bin 是 Electron safeStorage 的密文，
 * Windows 上就是 DPAPI —— 官方口径是「只有拥有相同登录凭据的用户通常才能解密」，
 * 于是把 keys/ 原样同步过去是个假选项：换机器照样解不开，却把密文放上他人服务器。
 * 要能跨机恢复，只能客户端自己再封一层：口令 → scrypt 派生 → AES-256-GCM。
 *
 * 三条不可协商的：
 * 1. 袋子是**另一个文件**，不混进 torra-backup.json。讨论存档可以给别人看，
 *    密钥袋不该跟着走；混在一个包里就等于每次分享数据都顺带分享凭据。
 * 2. 口令只在主进程内存里活一次会话，不落盘、不进偏好、不进日志。
 *    忘了就是永久解不开 —— 这一句必须写在界面上，不是免责条款。
 * 3. 私有仓库不等于加密：GitHub 服务端仍持有这份可离线爆破的密文，
 *    而 git 历史不会因为一次覆盖就消失。所以袋子的内容只放钥匙串里的值，
 *    网页模型登录态（活会话，被拿到就能登号）与备份令牌本身都不进袋。
 *
 * 这一层仍是纯判据：信封结构、口令下限、路径推导都能脱机断言，
 * 真正的 scrypt 与 AES 在 src/main/backup/secrets-bag.ts（要碰 node:crypto）。
 */

/** 密钥袋的默认文件名（与备份包同目录、不同文件） */
export const SECRETS_FILE = 'torra-backup.secrets.json'

/** 袋子的大小上限：钥匙串里就那几条 Key，超了这个数一定是哪里把不该塞的东西放进来了 */
export const MAX_BAG_BYTES = 512 * 1024

/**
 * 派生参数写死在这里，不进信封的可调字段之外的口径。
 * N=2^15、r=8、p=1 单次约 32 MB 内存 / 几十毫秒：够慢到让在线爆破没意义，
 * 又不至于让每次备份等上一秒。参数会随信封一起下发，验签时按信封里那份算，
 * 将来要改 cost 也不用把旧袋子作废。
 */
export const SCRYPT_KDF = { name: 'scrypt', N: 32768, r: 8, p: 1, keyLen: 32 } as const

/** 备份令牌自己的引用名：它不参与装袋（见上面第三条） */
export const BAG_EXCLUDED_REFS: readonly string[] = ['github:backup']

export interface SecretsEnvelope {
  app: 'torra'
  kind: 'secrets-bag'
  version: 1
  kdf: { name: 'scrypt'; N: number; r: number; p: number; keyLen: number; salt: string }
  cipher: 'aes-256-gcm'
  /** base64：IV / 认证标签 / 密文 */
  iv: string
  tag: string
  data: string
  /** 袋里几条密钥。只有条数可以露面，引用名与值都不进信封 */
  refs: number
  createdAt: number
  device: string
}

/**
 * 远端下来的袋子能不能读。这一层只判形状，解不开是口令的事。
 * 参数一坏就当不可读：拿陌生 cost 去跑 scrypt，等于让远端决定我们分配多少内存。
 */
export function isReadableSecretsEnvelope(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const e = raw as Partial<SecretsEnvelope>
  if (e.app !== 'torra' || e.kind !== 'secrets-bag' || e.version !== 1) return false
  if (e.cipher !== 'aes-256-gcm') return false
  const k = e.kdf
  if (!k || k.name !== 'scrypt') return false
  if (k.N !== SCRYPT_KDF.N || k.r !== SCRYPT_KDF.r || k.p !== SCRYPT_KDF.p) return false
  // keyLen 也钉死：AES-256-GCM 只吃 32 字节密钥，别的长度解出来是另一把钥匙，
  // 与其报「口令不对」不如在这里判不可读 —— 少这一格，形状判定就漏了一个可调字段
  if (k.keyLen !== SCRYPT_KDF.keyLen) return false
  for (const field of [k.salt, e.iv, e.tag, e.data]) {
    if (typeof field !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(field)) return false
  }
  if (typeof e.refs !== 'number' || !Number.isInteger(e.refs) || e.refs < 0 || e.refs > 2000) return false
  if (typeof e.createdAt !== 'number' || !Number.isFinite(e.createdAt)) return false
  return true
}

/** 口令下限：短口令在离线爆破面前等于没加密；上限防的是把整段文本粘进来当口令 */
export const PASSPHRASE_MIN = 10
export const PASSPHRASE_MAX = 512

export function checkPassphrase(pw: string): { ok: true } | { ok: false; reason: string } {
  const s = String(pw ?? '')
  if (s.length < PASSPHRASE_MIN) return { ok: false, reason: `备份口令至少 ${PASSPHRASE_MIN} 个字符：短口令在离线爆破面前等于没加密` }
  if (s.length > PASSPHRASE_MAX) return { ok: false, reason: `备份口令太长了（${PASSPHRASE_MAX} 个字符以内）` }
  if (/^(.)\1+$/.test(s)) return { ok: false, reason: '备份口令不能是同一个字符重复' }
  return { ok: true }
}

/**
 * 袋子落在哪：跟着备份包走同一个目录，只换文件名。
 * 用户在「存放路径」里填的 `backups/` 或 `notes/site-b.json` 对两个文件同时生效，
 * 不会出现数据在子目录、密钥袋在仓库根这种两头找的情况。
 */
export function secretsFileFor(bundleFile: string): string {
  const rel = normalizeRel(String(bundleFile ?? ''))
  const i = rel.lastIndexOf('/')
  return i < 0 ? SECRETS_FILE : `${rel.slice(0, i + 1)}${SECRETS_FILE}`
}

/**
 * 备份包与密钥袋各自的存放路径能不能同时成立。
 * 判据只有一条：袋子不许落在数据包自己身上（那是个 .json，被覆盖就同时毁了备份）。
 */
export function bagPathUsable(bundleFile: string): { ok: true; file: string } | { ok: false; reason: string } {
  const file = secretsFileFor(bundleFile)
  if (file === normalizeRel(bundleFile)) return { ok: false, reason: '密钥袋与备份包不能同名' }
  return { ok: true, file }
}

/**
 * 这份 JSON 能不能当备份包读。比当前实现新的包一律拒读，理由同会话存档。
 */
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
    pluginData: paths.filter((p) => p.startsWith('plugin-data/')).length,
    assistantSessions: paths.filter((p) => p.startsWith('assistant-sessions/')).length,
    entries: paths.length,
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
