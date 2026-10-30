/**
 * 服务器看板：用本机 ssh 读几台 Linux 机器。
 *
 * 边界写在前面，改的时候别松：
 * - 只跑下面这一条固定探针，不提供「执行任意命令」的工具。给模型一个 shell，
 *   等于把机器交出去，而且事后从调用记录里很难看出被拿去做了什么。
 * - 不保存密码或口令短语。认证只有 ssh-agent 与 `-i` 指定的密钥文件两条路；
 *   带口令的密钥请先用 ssh-add 加进 agent。
 * - 主机 / 用户 / 端口 / 密钥路径都过白名单再拼 argv，防止被当成 ssh 选项
 *   （`-oProxyCommand=…` 这种值进了 argv 就是本机执行任意命令）。
 * - 读 ~/.ssh/config 只取主机 / 用户 / 端口 / 密钥路径当导入候选，探针始终是
 *   显式 user@host；配置里的 ProxyJump / ProxyCommand 不会被照抄执行。
 *
 * 面板与工具共用同一份状态；探测结果（含上次的值）存进插件存储，重开应用还能看到
 * 最后一次的状态，但每条都带时间戳 —— 旧数据不许冒充现在。
 */

'use strict'

const { spawn } = require('node:child_process')
const { existsSync, readFileSync, readdirSync, realpathSync, statSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
// 族谱是纯数据 + 纯函数：家族表内置在插件里，不读远端，也不往远端写
const { buildLineage } = require('./lineage.js')

const MAX_SERVERS = 50
const PROBE_TIMEOUT_MS = 12_000
const PROBE_CONCURRENCY = 5
/** 工具调用在宿主侧 30 秒超时：留 8 秒给 IPC 与序列化 */
const PROBE_BUDGET_MS = 22_000
/** 一次远程调用的总预算，含一次重连 */
const WORKSPACE_TIMEOUT_MS = 20_000
/**
 * 单次尝试的上限。必须小于总预算，否则第一次卡死就把预算吃光，重连没得跑。
 * 也必须大于 ssh 自己的 ConnectTimeout，这样拿到的是 ssh 明确报出来的连接错误，
 * 而不是我们这边 kill 掉进程、只剩一个没有退出码的「异常终止」。
 */
const WORKSPACE_ATTEMPT_MS = 12_000
const READ_DEFAULT_BYTES = 64 * 1024
const READ_MAX_BYTES = 256 * 1024
/**
 * 一次 ssh 最多收多少字节。这个上限必须容得下脚本能产出的最大载荷：
 * 读日志最多带 256KB 尾部，base64 后约 350KB，再算上 16KB 头部与标记。
 * 早先写死 200KB，比载荷上限还小，稍长一点的训练日志必然被中途 kill，
 * 而 kill 之后既没有退出码也没有 stderr，面板只能显示「退出码 -1，没有输出」。
 */
const WORKSPACE_MAX_OUTPUT = 2 * 1024 * 1024
const WORKSPACE_MAX_STDERR = 64 * 1024
const LOG_DEFAULT_LINES = 160
const LOG_MAX_LINES = 800
const ROOT_MAX_CHARS = 1024
const ROOT_FRESH_MS = 15 * 60 * 1000

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/

/** 固定探针：只读，输出用 `@@key=value` 标好，远端少一个命令也能降级解析 */
const PROBE_SCRIPT = [
  'LC_ALL=C; export LC_ALL',
  'echo "@@host=$(hostname 2>/dev/null)"',
  `echo "@@os=$(. /etc/os-release 2>/dev/null && printf %s "$PRETTY_NAME")"`,
  'echo "@@cpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)"',
  'echo "@@uptime=$(cut -d. -f1 /proc/uptime 2>/dev/null)"',
  'echo "@@load=$(cut -d" " -f1-3 /proc/loadavg 2>/dev/null)"',
  `echo "@@mem=$(free -b 2>/dev/null | awk 'NR==2 {print $2" "$3" "$7}')"`,
  `echo "@@disk=$(df -P -B1 / 2>/dev/null | awk 'NR==2 {print $2" "$3" "$4" "$5}')"`,
].join('\n')

let ctx = null
let state = { servers: [], roots: {} }

function str(value) {
  return typeof value === 'string' ? value : ''
}

function cap(value, max) {
  return str(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

function uid() {
  return 'srv-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3)
}

function checkTarget(server) {
  if (!HOST_RE.test(server.host)) throw new Error(`主机不合法：${server.host || '(空)'}`)
  if (!USER_RE.test(server.user)) throw new Error(`用户不合法：${server.user || '(空)'}`)
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    throw new Error(`端口不合法：${server.port}`)
  }
  if (server.keyPath && /[\u0000\r\n]/.test(server.keyPath)) throw new Error('密钥路径里有控制字符')
}

function checkKey(raw, errors) {
  const value = str(raw).trim()
  if (!value) return ''
  if (!path.isAbsolute(value)) {
    errors.push('密钥路径要写绝对路径')
    return ''
  }
  if (/[\u0000\r\n]/.test(value)) {
    errors.push('密钥路径里有控制字符')
    return ''
  }
  if (!existsSync(value) || !statSync(value).isFile()) {
    errors.push(`密钥文件不存在：${value}`)
    return ''
  }
  return value
}

/** 新增时的整组校验；返回值里 errors 非空就当失败，别静默用半份配置 */
function readServerInput(params, base) {
  const errors = []
  const label = cap(params.label, 60)
  const host = str(params.host).trim()
  const user = str(params.user).trim()
  const portRaw = params.port
  const port = portRaw === undefined || portRaw === null || portRaw === '' ? 22 : Number(portRaw)
  const keyPath = params.keyPath === undefined ? (base ? base.keyPath : '') : checkKey(params.keyPath, errors)

  if (!label) errors.push('名称不能为空')
  if (!HOST_RE.test(host)) errors.push('主机名只能用字母、数字、点、下划线和连字符，且不能以连字符开头')
  if (!USER_RE.test(user)) errors.push('用户名只能用字母、数字、点、下划线和连字符')
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('端口要在 1-65535 之间')

  return { errors, value: { label, host, user, port, keyPath } }
}

function sameBox(a, b) {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.user === b.user && a.port === b.port
}

function findServer(id) {
  const found = state.servers.find((s) => s.id === id)
  if (!found) throw new Error(`服务器不存在：${id}`)
  return found
}

function resolveTarget(target) {
  const value = str(target).trim()
  if (!value) return null
  const byId = state.servers.find((s) => s.id === value)
  if (byId) return byId
  const byLabel = state.servers.find((s) => s.label === value) || state.servers.find((s) => s.label.toLowerCase() === value.toLowerCase())
  if (!byLabel) throw new Error(`没有这台服务器：${value}`)
  return byLabel
}

/* ---------- ssh 配置 ---------- */

/**
 * 把 ~/.ssh/config 里「具体主机」的配置读成候选，给面板一键导入。
 *
 * 只取能落到看板字段上的项：HostName / User / Port / IdentityFile。通配 Host
 * （含 * ? !）与前面没有 Host 的全局项只当默认值兜底，不单独变成候选；Match
 * 块跳过。ProxyJump / ProxyCommand 不照抄：探针走显式 user@host 直连，这里
 * 只给一句提醒。
 */

const SSH_MAX_ENTRIES = 200
const SSH_MAX_LINES = 4000
const SSH_MAX_INCLUDE_FILES = 32
const SSH_MAX_CONFIG_BYTES = 512 * 1024
const SSH_INCLUDE_DEPTH = 4
const SSH_TOKEN_RE = /%([dhru])/g
const SSH_GLOB_SPECIAL_RE = /[\\^$.|+()[\]{}]/g

function unquote(value) {
  const text = str(value).trim()
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1)
  }
  return text
}

/** ssh 配置里 # 开头的注释；引号里的 # 不算注释 */
function stripComment(line) {
  let quote = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#') return line.slice(0, i)
  }
  return line
}

/** `Key value` 与 `Key=value` 都认，键名大小写不敏感（ssh 本身如此） */
function splitConfigLine(line) {
  const text = stripComment(line).replace(/^\uFEFF/, '').trim()
  if (!text) return null
  const withEquals = text.match(/^([A-Za-z]+)\s*=\s*(.*)$/)
  if (withEquals) return { key: withEquals[1].toLowerCase(), value: withEquals[2].trim() }
  const spaced = text.match(/^([A-Za-z]+)(?:\s+(.*))?$/)
  if (!spaced) return null
  return { key: spaced[1].toLowerCase(), value: (spaced[2] || '').trim() }
}

/** Host / Include 行的空格分隔参数；引号包住的值算一个参数 */
function splitArguments(value) {
  const out = []
  let buffer = ''
  let quote = ''
  for (const ch of str(value)) {
    if (quote) {
      if (ch === quote) quote = ''
      else buffer += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (buffer) {
        out.push(buffer)
        buffer = ''
      }
      continue
    }
    buffer += ch
  }
  if (buffer) out.push(buffer)
  return out
}

function expandTokens(value, vars) {
  let text = str(value)
  if (text === '~') text = vars.home
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = vars.home + text.slice(1)
  return text.replace(SSH_TOKEN_RE, (_match, token) => {
    if (token === 'd') return vars.home
    if (token === 'h') return vars.host
    if (token === 'r') return vars.user
    return vars.localUser
  })
}

/** Host 通配（* ? !）；匹配时大小写不敏感，与 ssh 一致 */
function wildcardLayerMatches(layer, alias) {
  if (!layer.patterns.length) return true
  const positives = []
  const negatives = []
  for (const raw of layer.patterns) {
    const pattern = unquote(raw)
    if (pattern.startsWith('!')) negatives.push(pattern.slice(1))
    else positives.push(pattern)
  }
  const name = alias.toLowerCase()
  for (const pattern of negatives) {
    if (globToRegExp(pattern.toLowerCase()).test(name)) return false
  }
  if (!positives.length) return false
  return positives.some((pattern) => globToRegExp(pattern.toLowerCase()).test(name))
}

/** 通配块越具体越先兜底：`prod-*` 的默认值要压过 `*` */
function wildcardSpecificity(layer) {
  if (!layer.patterns.length) return -1
  let best = -1
  for (const raw of layer.patterns) {
    const pattern = unquote(raw).replace(/^!/, '')
    const wildcards = (pattern.match(/[*?]/g) || []).length
    const literal = pattern.length - wildcards
    best = Math.max(best, literal * 100 - wildcards)
  }
  return best
}

function globToRegExp(pattern) {
  let source = '^'
  for (const ch of pattern) {
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(SSH_GLOB_SPECIAL_RE, '\\$&')
  }
  return new RegExp(source + '$')
}

function resolveIncludePaths(pattern, homeDir) {
  let value = expandTokens(unquote(pattern), { home: homeDir, host: '', user: '', localUser: '' })
  if (!path.isAbsolute(value)) value = path.join(homeDir, '.ssh', value)
  if (!/[*?]/.test(value)) return existsSync(value) ? [value] : []
  const dir = path.dirname(value)
  const matcher = globToRegExp(path.basename(value))
  try {
    return readdirSync(dir)
      .filter((name) => matcher.test(name))
      .sort()
      .slice(0, SSH_MAX_INCLUDE_FILES)
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/** 展开 Include（相对路径按 ~/.ssh 解析），保留每行来自哪个文件 */
function readConfigLines(file, homeDir, depth, seen, errors, out) {
  if (depth > SSH_INCLUDE_DEPTH) return
  let identity
  try {
    identity = realpathSync(file)
  } catch {
    identity = path.resolve(file)
  }
  if (seen.has(identity)) return
  seen.add(identity)

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = error && error.code ? error.code : '未知错误'
    errors.push('读不了 ssh 配置 ' + file + '（' + code + '）')
    return
  }
  if (Buffer.byteLength(text) > SSH_MAX_CONFIG_BYTES) text = text.slice(0, SSH_MAX_CONFIG_BYTES)
  for (const raw of text.split(/\r?\n/)) {
    if (out.length >= SSH_MAX_LINES) return
    const parsed = splitConfigLine(raw)
    if (parsed && parsed.key === 'include') {
      for (const pattern of splitArguments(parsed.value)) {
        for (const included of resolveIncludePaths(pattern, homeDir)) {
          readConfigLines(included, homeDir, depth + 1, seen, errors, out)
        }
      }
      continue
    }
    out.push({ text: raw, file: path.resolve(file) })
  }
}

/** 先出现的值生效（ssh 的规则）；IdentityFile 可以有多条 */
function applyOption(options, key, value) {
  if (key === 'identityfile') {
    const list = options.identityfile || (options.identityfile = [])
    if (!list.includes(value)) list.push(value)
    return
  }
  if (options[key] === undefined) options[key] = value
}

function mergeOptions(target, source) {
  for (const key of Object.keys(source)) {
    if (key === 'identityfile') {
      const list = target.identityfile || (target.identityfile = [])
      for (const item of source.identityfile) if (!list.includes(item)) list.push(item)
      continue
    }
    if (target[key] === undefined) target[key] = source[key]
  }
}

function firstOption(options, key) {
  const value = options[key]
  if (Array.isArray(value)) return value[0] || ''
  return str(value)
}

function sshSource(file, homeDir) {
  if (!file) return 'config'
  const relative = path.relative(path.join(homeDir, '.ssh'), file)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/')
  }
  return path.basename(file)
}

function parseSshEntries(lines, opts) {
  const home = opts.homeDir
  const localUser = opts.localUser || ''
  const layers = []
  let current = null
  let global = null

  for (const line of lines) {
    const parsed = splitConfigLine(line.text)
    if (!parsed) continue
    if (parsed.key === 'host') {
      const patterns = splitArguments(parsed.value)
      const concrete = patterns.filter((pattern) => HOST_RE.test(unquote(pattern)))
      current = { kind: 'exact', patterns: concrete, options: {}, file: line.file }
      if (concrete.length) layers.push(current)
      // `Host *` / `Host foo bar*`：通配部分只当默认值兜底，不当成一台具体的机器
      const wildcard = patterns.filter((pattern) => !HOST_RE.test(unquote(pattern)))
      if (wildcard.length) layers.push({ kind: 'wild', patterns: wildcard, options: current.options, file: line.file })
      continue
    }
    if (parsed.key === 'match') {
      current = { kind: 'ignored', patterns: [], options: {}, file: line.file }
      layers.push(current)
      continue
    }
    if (!parsed.value) continue
    if (!current) {
      if (!global) {
        global = { kind: 'wild', patterns: [], options: {}, file: line.file }
        layers.unshift(global)
      }
      current = global
    }
    if (current.kind === 'ignored') continue
    applyOption(current.options, parsed.key, parsed.value)
  }

  const byAlias = new Map()
  for (const layer of layers) {
    if (layer.kind !== 'exact') continue
    for (const raw of layer.patterns) {
      const alias = unquote(raw)
      if (!HOST_RE.test(alias)) continue
      let record = byAlias.get(alias)
      if (!record) {
        record = { alias, options: {}, files: [] }
        byAlias.set(alias, record)
      }
      mergeOptions(record.options, layer.options)
      if (!record.files.includes(layer.file)) record.files.push(layer.file)
    }
  }

  const wildcards = layers
    .filter((layer) => layer.kind === 'wild')
    .sort((a, b) => wildcardSpecificity(b) - wildcardSpecificity(a))
  for (const record of byAlias.values()) {
    for (const layer of wildcards) {
      if (wildcardLayerMatches(layer, record.alias)) mergeOptions(record.options, layer.options)
    }
  }

  const entries = []
  for (const record of byAlias.values()) {
    const options = record.options
    const hostName = unquote(firstOption(options, 'hostname'))
    const user = unquote(firstOption(options, 'user')) || localUser
    const portText = unquote(firstOption(options, 'port'))
    const port = portText ? Number(portText) : 22
    const host = hostName ? expandTokens(hostName, { home, host: record.alias, user, localUser }) : record.alias

    const identities = Array.isArray(options.identityfile) ? options.identityfile : []
    let keyPath = ''
    let keyMissing = false
    for (const raw of identities) {
      let candidate = expandTokens(unquote(raw), { home, host, user, localUser })
      if (!path.isAbsolute(candidate)) candidate = path.join(home, '.ssh', candidate)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          keyPath = path.resolve(candidate)
          break
        }
      } catch {
        /* 读不到就当不存在，退回 agent / 默认密钥 */
      }
      keyMissing = true
    }

    const problems = []
    if (!HOST_RE.test(host)) problems.push('主机名不合法')
    if (!USER_RE.test(user)) problems.push('用户名不合法')
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('端口不合法')

    const notes = []
    if (keyMissing && !keyPath) notes.push('配置里的密钥不存在，改用 agent / 默认密钥')
    if (options.proxyjump || options.proxycommand) notes.push('配置里有 ProxyJump / ProxyCommand，看板按主机直连')

    const safePort = Number.isFinite(port) ? port : 22
    entries.push({
      key: [record.alias, host, user, safePort].join('|'),
      alias: cap(record.alias, 60),
      host,
      user,
      port: safePort,
      keyPath,
      keyNote: notes.join('；'),
      source: sshSource(record.files[0] || '', home),
      valid: problems.length === 0,
      problem: problems.join('；'),
    })
    if (entries.length >= SSH_MAX_ENTRIES) break
  }
  return entries
}

function scanSshConfig(opts) {
  const options = opts || {}
  let localUser = options.localUser || ''
  if (!localUser) {
    try {
      localUser = os.userInfo().username
    } catch {
      localUser = str(process.env.USER || process.env.USERNAME)
    }
  }
  // Git Bash 等环境里 HOME 可能和 USERPROFILE 不同，两边都看一下；测试传入的 homeDir 只认它自己
  const homes = options.homeDir ? [options.homeDir] : [os.homedir(), process.env.HOME, process.env.USERPROFILE]
  const candidates = []
  for (const home of homes) {
    if (!home) continue
    const configPath = path.join(home, '.ssh', 'config')
    if (!candidates.some((item) => item.configPath === configPath)) candidates.push({ home, configPath })
  }
  const found = candidates.find((item) => existsSync(item.configPath))
  if (!found) {
    return {
      configPath: candidates.length ? candidates[0].configPath : path.join(os.homedir(), '.ssh', 'config'),
      configExists: false,
      entries: [],
      error: '',
      note: '没有找到 ~/.ssh/config',
    }
  }
  const homeDir = found.home
  const configPath = found.configPath
  const lines = []
  const errors = []
  readConfigLines(configPath, homeDir, 0, new Set(), errors, lines)
  const entries = parseSshEntries(lines, { homeDir, localUser })
  return {
    configPath,
    configExists: true,
    entries,
    error: errors[0] || '',
    note: entries.length ? '' : '配置里没有可导入的具体主机（只有通配 Host 或 Match）',
  }
}

function sshScanView() {
  const scan = scanSshConfig(null)
  return {
    configPath: scan.configPath,
    configExists: scan.configExists,
    error: scan.error,
    note: scan.note,
    entries: scan.entries.map((entry) => ({
      ...entry,
      exists: state.servers.some((server) => sameBox(server, entry)),
    })),
  }
}

async function importSshServers(params) {
  const keys = new Set((Array.isArray(params.keys) ? params.keys : []).map((key) => str(key)).filter(Boolean))
  if (!keys.size) throw new Error('没有选中任何配置')
  const scan = scanSshConfig(null)
  const wanted = scan.entries.filter((entry) => keys.has(entry.key))
  if (!wanted.length) throw new Error('选中的配置已经不在 ssh 配置里了，重新扫描一下')
  const added = []
  const skipped = []
  for (const entry of wanted) {
    if (!entry.valid) {
      skipped.push({ key: entry.key, alias: entry.alias, reason: entry.problem })
      continue
    }
    if (state.servers.some((server) => sameBox(server, entry))) {
      skipped.push({ key: entry.key, alias: entry.alias, reason: '已经在看板里' })
      continue
    }
    if (state.servers.length >= MAX_SERVERS) {
      skipped.push({ key: entry.key, alias: entry.alias, reason: '最多 ' + MAX_SERVERS + ' 台' })
      continue
    }
    const server = {
      id: uid(),
      label: entry.alias,
      host: entry.host,
      user: entry.user,
      port: entry.port,
      keyPath: entry.keyPath,
      createdAt: Date.now(),
      last: null,
    }
    state.servers.push(server)
    added.push(server)
  }
  if (added.length) await save()
  return { added: added.map(viewOf), skipped, servers: state.servers.map(viewOf) }
}

/* ---------- 探针 ---------- */

function buildProbeArgs(server) {
  return buildSshArgs(server, PROBE_SCRIPT)
}

function buildSshArgs(server, script) {
  checkTarget(server)
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'LogLevel=ERROR',
    '-p', String(server.port),
  ]
  if (server.keyPath) args.push('-i', server.keyPath)
  args.push(`${server.user}@${server.host}`, script)
  return args
}

function b64(value) {
  return Buffer.from(str(value), 'utf8').toString('base64')
}

function quotedB64(value) {
  return `'${b64(value)}'`
}

function decodeB64(value) {
  try {
    return Buffer.from(str(value), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/** 远程路径先做词法归一；真实软链接边界由固定脚本在目标机上再查一次。 */
function normalizeRemoteRoot(value) {
  const text = str(value).trim()
  if (!text) throw new Error('项目目录不能为空')
  if (text.length > ROOT_MAX_CHARS) throw new Error('项目目录过长')
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('项目目录里有控制字符')
  if (!text.startsWith('/')) throw new Error('远程项目目录要写绝对路径')
  const normalized = path.posix.normalize(text)
  if (normalized === '/' || normalized === '.') throw new Error('请绑定具体项目目录，不要绑定根目录 /')
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

function isInsideRoot(root, target) {
  return target === root || target.startsWith(root.endsWith('/') ? root : root + '/')
}

/**
 * 所有远程路径都先落到绑定根目录内。绝对路径必须已经在根内；相对路径按根解析。
 * 这里不做字符串拼接进 shell，固定脚本只接收路径的 base64。
 */
function resolveRemotePath(rootValue, maybePath, allowRoot) {
  const root = normalizeRemoteRoot(rootValue)
  const raw = str(maybePath).trim()
  if (!raw && allowRoot) return root
  if (!raw) throw new Error('路径不能为空')
  if (raw.length > ROOT_MAX_CHARS) throw new Error('路径过长')
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('路径里有控制字符')
  const target = raw.startsWith('/') ? path.posix.normalize(raw) : path.posix.resolve(root, raw)
  if (!isInsideRoot(root, target)) throw new Error('路径超出已绑定的项目目录')
  if (!allowRoot && target === root) throw new Error('这里要选具体文件或子目录')
  return target
}

function rootFor(serverId) {
  const server = findServer(serverId)
  const root = state.roots[server.id]
  if (!root || !root.root) throw new Error(`「${server.label}」还没有绑定项目目录`)
  return { server, binding: root }
}

function remotePathPrelude(root, target) {
  return [
    `root=$(printf %s ${quotedB64(root)} | base64 -d 2>/dev/null) || exit 41`,
    `target=$(printf %s ${quotedB64(target)} | base64 -d 2>/dev/null) || exit 41`,
    '[ -n "$root" ] && [ -n "$target" ] || exit 41',
    'root=$(cd "$root" 2>/dev/null && pwd -P) || exit 42',
    'target=$(readlink -f -- "$target" 2>/dev/null || true)',
    '[ -n "$target" ] || exit 42',
    'case "$target" in "$root"|"$root"/*) : ;; *) exit 43 ;; esac',
  ].join('\n')
}

function buildRootCheckScript(root) {
  return [
    `root=$(printf %s ${quotedB64(root)} | base64 -d 2>/dev/null) || exit 41`,
    'dir=$(cd "$root" 2>/dev/null && pwd -P) || exit 42',
    '[ -d "$dir" ] || exit 42',
    `echo "@@root=$(printf %s "$dir" | base64 | tr -d '\\n')"`,
  ].join('\n')
}

/**
 * GPU 探测：PATH 里找不到 nvidia-smi 时再翻常见目录，并区分「没装 / 装了但驱动报错」。
 * 有输出时每行一条 `@@gpu=`，没有则给 `@@gpuerr=`，面板据此说清是哪一种。
 */
function smiLines() {
  return [
    'NS=$(command -v nvidia-smi 2>/dev/null || true)',
    'if [ -z "$NS" ]; then for p in /usr/local/nvidia/bin/nvidia-smi /usr/lib/nvidia/bin/nvidia-smi /opt/nvidia/bin/nvidia-smi /usr/local/bin/nvidia-smi; do [ -x "$p" ] && NS=$p && break; done; fi',
    `echo "@@smi=$(printf %s "$NS" | base64 | tr -d '\\n')"`,
    'if [ -n "$NS" ]; then',
    '  if csv=$("$NS" --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits 2>/dev/null); then',
    '    printf "%s\\n" "$csv" | while IFS= read -r line; do',
    '      [ -n "$line" ] || continue',
    `      printf '%s\\n' "$line" | base64 | tr -d '\\n' | sed 's/^/@@gpu=/'; echo`,
    '    done',
    '  else',
    '    msg=$("$NS" 2>&1 >/dev/null | head -n 1)',
    `    printf '%s' "$msg" | base64 | tr -d '\\n' | sed 's/^/@@gpuerr=/'; echo`,
    '  fi',
    'fi',
  ]
}

/**
 * 全机扫描实验进程。
 *
 * 早先只认 cwd 落在绑定根目录里的进程，结果机器上真在跑的实验（比如 cwd 是
 * /root/AdaTKG）全被滤掉。现在回传所有候选进程，由 parseExperiments 标注
 * `insideRoot`；日志路径不在绑定目录内就只展示路径、不提供面板内读取。
 */
function buildExperimentScript(root) {
  const base = [
    `root=$(printf %s ${quotedB64(root)} | base64 -d 2>/dev/null) || exit 41`,
    'root=$(cd "$root" 2>/dev/null && pwd -P) || exit 42',
    `echo "@@root=$(printf %s "$root" | base64 | tr -d '\\n')"`,
    'echo "@@host=$(hostname 2>/dev/null)"',
    `echo "@@os=$(. /etc/os-release 2>/dev/null && printf %s "$PRETTY_NAME")"`,
    'echo "@@cpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)"',
    'echo "@@uptime=$(cut -d. -f1 /proc/uptime 2>/dev/null)"',
    'echo "@@load=$(cut -d" " -f1-3 /proc/loadavg 2>/dev/null)"',
    `echo "@@mem=$(free -b 2>/dev/null | awk 'NR==2 {print $2" "$3" "$7}')"`,
    `echo "@@disk=$(df -P -B1 "$root" 2>/dev/null | awk 'NR==2 {print $2" "$3" "$4" "$5}')"`,
    'echo "@@now=$(date +%s)"',
    'ps -eo pid=,ppid=,etimes=,args= 2>/dev/null | while read pid ppid etimes command; do',
    // 自己这条探针（外层 sh 与管道子 shell）也在进程表里，命令行里带着 python 之类的关键词
    '  [ "$pid" = "$$" ] && continue',
    '  [ "$ppid" = "$$" ] && continue',
    '  [ "$pid" = "$PPID" ] && continue',
    // `bash -c` 只是启动器：不当成一条实验，但它的输出重定向往往是子进程真正在写的日志
    '  launcher=0',
    '  case "$command" in "bash -c"*|"sh -c"*|*"/bash -c"*|*"/sh -c"*) launcher=1 ;; esac',
    // 登录 shell 自己会拉一个 `conda shell.posix activate`，etimes 常常是 0，别当成实验
    '  case "$command" in *"conda shell"*) continue ;; esac',
    '  if [ "$launcher" = 0 ]; then',
    '    case "$command" in *[pP]ython*|*[tT]orchrun*|*[dD]eepspeed*|*[aA]ccelerate*|*[jJ]upyter*|*[tT]ensorboard*|*run_*.sh*|*[tT]rain*.sh*|*launch*.sh*) : ;; *) continue ;; esac',
    '  fi',
    '  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)',
    '  [ -n "$cwd" ] || continue',
    '  case "$cwd" in "$root"|"$root"/*) inroot=1 ;; *) inroot=0 ;; esac',
    // 日志归属按可靠性从高到低找，同时记下来源（fd / arg / name / guess）：
    // 猜出来的日志常常是同一个文件，两个实验才会画出同一组曲线。
    '  log=""',
    '  logsrc=""',
    // 进程自己的 stdout/stderr 落在哪个文件，就是它真正在写的日志。
    // `bash run.sh > a.log` 的重定向不会出现在子进程命令行里，但 fd 会继承下来。
    '  for fd in 1 2; do',
    '    fdpath=$(readlink -f "/proc/$pid/fd/$fd" 2>/dev/null || true)',
    '    case "$fdpath" in *.log|*.out|*.txt) if [ -f "$fdpath" ]; then log="$fdpath"; logsrc=fd; break; fi ;; esac',
    '  done',
    // 再看命令行里写的重定向（`> /workspace/.../x.log`）
    '  if [ -z "$log" ]; then',
    '    redir=$(printf %s "$command" | sed -n \'s/.*>[ >]*\\([^ &;|<>]*\\.\\(log\\|out\\|txt\\)\\).*/\\1/p\' | tail -n 1)',
    '    case "$redir" in "") : ;; /*) if [ -f "$redir" ]; then log="$redir"; logsrc=arg; fi ;; *) if [ -f "$cwd/$redir" ]; then log="$cwd/$redir"; logsrc=arg; fi ;; esac',
    '  fi',
    '  if [ "$launcher" = 1 ] && [ -z "$log" ]; then continue; fi',
    '  if [ -z "$log" ]; then',
    '    for rel in nohup.out train.log output.log out.log run/train.log run/output.log logs/train.log logs/output.log; do',
    '      if [ -f "$cwd/$rel" ]; then log="$cwd/$rel"; logsrc=name; break; fi',
    '    done',
    '  fi',
    // 最后才按修改时间猜一个。猜的日志必须比进程启动更新，否则多半是上一轮留下的
    '  if [ -z "$log" ]; then',
    '    newest=$(ls -t "$cwd"/*.log "$cwd"/*.out "$cwd"/logs/*.log "$cwd"/runs/*.log 2>/dev/null | head -n 1)',
    '    if [ -n "$newest" ]; then',
    '      started=$(( $(date +%s) - etimes ))',
    '      if [ "$(stat -c %Y "$newest" 2>/dev/null || echo 0)" -ge "$started" ]; then log="$newest"; logsrc=guess; fi',
    '    fi',
    '  fi',
    '  envname=""',
    `  if [ "$launcher" = 0 ]; then envname=$(tr '\\000' '\\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^CONDA_DEFAULT_ENV=//p' | head -n 1); fi`,
    `  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$pid" "$ppid" "$etimes" "$envname" "$cwd" "$inroot" "$log" "$launcher" "$logsrc" "$command" | base64 | tr -d '\\n' | sed 's/^/@@exp=/'; echo`,
    'done',
    ...smiLines(),
  ]
  return base.join('\n')
}

function buildMetricsScript(root) {
  return [
    `root=$(printf %s ${quotedB64(root)} | base64 -d 2>/dev/null) || exit 41`,
    'root=$(cd "$root" 2>/dev/null && pwd -P) || exit 42',
    'echo "@@host=$(hostname 2>/dev/null)"',
    `echo "@@os=$(. /etc/os-release 2>/dev/null && printf %s "$PRETTY_NAME")"`,
    'echo "@@cpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)"',
    'echo "@@uptime=$(cut -d. -f1 /proc/uptime 2>/dev/null)"',
    'echo "@@load=$(cut -d" " -f1-3 /proc/loadavg 2>/dev/null)"',
    `echo "@@mem=$(free -b 2>/dev/null | awk 'NR==2 {print $2" "$3" "$7}')"`,
    `echo "@@disk=$(df -P -B1 "$root" 2>/dev/null | awk 'NR==2 {print $2" "$3" "$4" "$5}')"`,
    ...smiLines(),
  ].join('\n')
}

function buildFilesScript(root, target) {
  return [
    remotePathPrelude(root, target),
    'echo "@@root=$(printf %s "$root" | base64 | tr -d \'\\n\')"',
    'echo "@@path=$(printf %s "$target" | base64 | tr -d \'\\n\')"',
    'find "$target" -mindepth 1 -maxdepth 1 -printf \'%f\\0%y\\0%s\\0%T@\\0\' 2>/dev/null | base64 | tr -d \'\\n\' | sed \'s/^/@@data=/\'',
  ].join('\n')
}

function buildReadScript(root, target, maxBytes, lines) {
  const size = Math.max(1, Math.min(READ_MAX_BYTES, Math.floor(Number(maxBytes) || READ_DEFAULT_BYTES)))
  const tailLines = lines === null ? 0 : Math.max(1, Math.min(LOG_MAX_LINES, Math.floor(Number(lines) || LOG_DEFAULT_LINES)))
  const body =
    tailLines > 0
      ? `tail -n ${tailLines} -- "$target" 2>/dev/null | tail -c ${size}`
      : `head -c ${size} -- "$target" 2>/dev/null`
  return [
    remotePathPrelude(root, target),
    '[ -f "$target" ] || exit 44',
    'echo "@@root=$(printf %s "$root" | base64 | tr -d \'\\n\')"',
    'echo "@@path=$(printf %s "$target" | base64 | tr -d \'\\n\')"',
    'echo "@@size=$(wc -c < "$target" 2>/dev/null | tr -d \' \')"',
    `${body} | base64 | tr -d '\\n' | sed 's/^/@@data=/\'; echo`,
  ].join('\n')
}

/**
 * 曲线读尾部，总轮数常常只写在日志开头（`Namespace(... epochs=1000 ...)`），
 * 所以顺手把头几行也带回，省一次 ssh。
 */
function buildProgressScript(root, target, maxBytes, lines) {
  const size = Math.max(1, Math.min(READ_MAX_BYTES, Math.floor(Number(maxBytes) || READ_DEFAULT_BYTES)))
  const tailLines = Math.max(1, Math.min(LOG_MAX_LINES, Math.floor(Number(lines) || LOG_DEFAULT_LINES)))
  return [
    remotePathPrelude(root, target),
    '[ -f "$target" ] || exit 44',
    'echo "@@root=$(printf %s "$root" | base64 | tr -d \'\\n\')"',
    'echo "@@path=$(printf %s "$target" | base64 | tr -d \'\\n\')"',
    'echo "@@size=$(wc -c < "$target" 2>/dev/null | tr -d \' \')"',
    'head -n 40 -- "$target" 2>/dev/null | head -c 16384 | base64 | tr -d \'\\n\' | sed \'s/^/@@head=/\'; echo',
    `tail -n ${tailLines} -- "$target" 2>/dev/null | tail -c ${size} | base64 | tr -d '\\n' | sed 's/^/@@data=/\'; echo`,
  ].join('\n')
}

function markers(text) {
  const out = {}
  for (const chunk of str(text).split(/(?=@@[a-z]+=)/)) {
    if (!chunk.startsWith('@@')) continue
    const eq = chunk.indexOf('=')
    if (eq < 0) continue
    const key = chunk.slice(2, eq)
    if (!/^[a-z]+$/.test(key)) continue
    out[key] = chunk.slice(eq + 1).trim()
  }
  return out
}

/**
 * 取同类二进制标记的全部载荷。
 * 老版本脚本在 `sed` 后没补换行，多条 `@@exp=` 会挤在同一行；按标记切开才不会整块丢掉。
 */
function b64Markers(text, name) {
  const re = new RegExp('@@' + name + '=([A-Za-z0-9+/=]*)', 'g')
  const out = []
  let hit
  while ((hit = re.exec(str(text)))) out.push(hit[1])
  return out
}

/** 远程脚本自己定的退出码：让「路径不合法」和「ssh 连不上」分得清清楚楚 */
function explainWorkspaceFailure(code, stderr) {
  if (code === 41) return '远程路径参数无效'
  if (code === 42) return '远程目录不存在或无法访问'
  if (code === 43) return '远程路径超出已绑定目录（可能是符号链接）'
  if (code === 44) return '远程目标不是普通文件'
  if (code === 45) return '远程目录没有读取权限，换一个'
  return explainFailure(code, stderr)
}

/**
 * 跑一次远程脚本。冷启动时第一次 ssh 可能卡满握手才超时，重连一次通常就好，
 * 所以这里留一次重连的机会；总预算封顶，不会把宿主的 30 秒 RPC 超时耗光。
 * runner 是注入点：测试用假 runner 覆盖 ssh，生产走 spawnRunner。
 */
async function runWorkspaceWith(runner, server, script) {
  const args = buildSshArgs(server, script)
  const deadline = Date.now() + WORKSPACE_TIMEOUT_MS
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const left = deadline - Date.now()
    if (left <= 0) break
    let out = null
    let failure = null
    try {
      out = await runner(args, Math.min(WORKSPACE_ATTEMPT_MS, left))
    } catch (error) {
      failure = error
    }
    if (out) {
      if (out.code === 0) return out
      const reason = explainWorkspaceFailure(out.code, out.stderr)
      if (attempt === 0 && isTransientConnectFailure(out.stderr)) {
        lastError = new Error(reason)
        continue
      }
      throw new Error(reason)
    }
    // runner 自己超时：ssh 没在预算内拿到结果。连接卡住也会这样，值得再试一次。
    if (attempt === 0 && failure && /超时/.test(String(failure.message || ''))) {
      lastError = failure
      continue
    }
    throw failure
  }
  throw lastError || new Error('连接目标机失败')
}

function runWorkspace(server, script) {
  return runWorkspaceWith(spawnRunner, server, script)
}

function parseFileListing(text) {
  const fields = markers(text)
  const raw = Buffer.from(str(fields.data), 'base64')
  const parts = raw.toString('utf8').split('\u0000')
  const pathValue = decodeB64(fields.path)
  const entries = []
  for (let i = 0; i + 3 < parts.length; i += 4) {
    const name = parts[i]
    if (!name) continue
    const kind = parts[i + 1] || '?'
    const size = Number(parts[i + 2]) || 0
    const modified = Math.round((Number(parts[i + 3]) || 0) * 1000)
    entries.push({
      name: cap(name, 240),
      path: path.posix.join(pathValue, name),
      type: kind === 'd' ? 'dir' : kind === 'f' ? 'file' : kind === 'l' ? 'link' : 'other',
      size,
      modified,
    })
  }
  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.name.localeCompare(b.name)
  })
  return { root: decodeB64(fields.root), path: pathValue, entries }
}

/* ---------- 绑定前的目录浏览 ---------- */

/**
 * 挑项目目录这一步必须能走整个文件系统 —— 根目录正是要挑的东西，没有可依附的根。
 * 所以这里和 resolveRemotePath 不同：只校验「绝对路径、无控制字符、长度上限」，
 * 存在性与软链接都交给远端 `cd && pwd -P` 判，软链接在那一步就解析成真实路径。
 * 空值表示家目录：仓库十有八九在 ~ 下面，先落在那里比先落在 / 有用。
 */
function normalizeBrowsePath(value) {
  const raw = str(value).trim()
  if (!raw || raw === '~' || raw === '~/') return ''
  if (raw.length > ROOT_MAX_CHARS) throw new Error('路径过长')
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('路径里有控制字符')
  if (raw[0] !== '/' && raw.slice(0, 2) !== '~/') throw new Error('远程目录要写绝对路径')
  return raw
}

function buildDirsScript(target) {
  return [
    `target=$(printf %s ${quotedB64(target)} | base64 -d 2>/dev/null) || exit 41`,
    // 空串与 ~ 都指向家目录；波浪号只认开头这一种写法，展开后跟绝对路径一样往下走
    '[ -n "$target" ] || target=$HOME',
    'case "$target" in "~") target=$HOME ;; "~/"*) target="$HOME/${target#\\~}" ;; esac',
    'dir=$(cd "$target" 2>/dev/null && pwd -P) || exit 42',
    '[ -r "$dir" ] && [ -x "$dir" ] || exit 45',
    'dir=${dir%/}; [ -n "$dir" ] || dir=/',
    'echo "@@home=$(printf %s "$HOME" | base64 | tr -d \'\\n\')"',
    'echo "@@path=$(printf %s "$dir" | base64 | tr -d \'\\n\')"',
    'echo "@@parent=$(printf %s "$(dirname -- "$dir")" | base64 | tr -d \'\\n\')"',
    'find "$dir" -mindepth 1 -maxdepth 1 -type d -printf \'%f\\0\' 2>/dev/null | base64 | tr -d \'\\n\' | sed \'s/^/@@data=/\'',
    'echo',
  ].join('\n')
}

function parseDirListing(text) {
  const fields = markers(text)
  const dir = decodeB64(fields.path) || '/'
  const parent = decodeB64(fields.parent) || dir
  const raw = Buffer.from(str(fields.data), 'base64').toString('utf8')
  const dirs = raw
    .split('\u0000')
    .filter(Boolean)
    .map((name) => ({
      // name 只用于显示，path 必须拿原始名拼：截断过的名字点进去就是另一个目录
      name: cap(name, 240),
      path: dir === '/' ? '/' + name : dir + '/' + name,
      hidden: name[0] === '.',
    }))
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  return {
    home: decodeB64(fields.home) || '',
    path: dir,
    parent,
    canUp: !!parent && parent !== dir,
    dirs,
  }
}

function commandArgv(command) {
  return str(command).split(/\s+/).filter(Boolean)
}

/** 实验名取脚本名：`python -u main.py` 要得到 main.py，而不是 `-u` */
function commandName(command) {
  const tokens = commandArgv(command)
  if (!tokens.length) return 'python'
  const bin = path.posix.basename(tokens[0].replace(/^["']|["']$/g, ''))
  const strip = (token) => token.replace(/^["']|["']$/g, '')
  if (/^(bash|sh|zsh|dash|ksh|nohup|time|env)$/.test(bin)) {
    const script = tokens.slice(1).map(strip).find((token) => /\.(sh|py)$/.test(token))
    return cap(script ? path.posix.basename(script) : bin, 120)
  }
  if (/^(python|python\d(?:\.\d+)?|pypy3?|conda|torchrun|deepspeed|accelerate)$/.test(bin)) {
    const script = tokens.slice(1).map(strip).find((token) => !token.startsWith('-'))
    return cap(script ? path.posix.basename(script) : bin, 120)
  }
  const script = tokens.slice(1).map(strip).find((token) => /\.(py|sh)$/.test(token))
  return cap(script ? path.posix.basename(script) : bin, 120)
}

/** 命令行里写了 `--epochs 200` 就拿来当总轮数；日志里再出现 `Epoch 3/200` 会覆盖它 */
function epochsFromCommand(command) {
  const text = str(command)
  const hit = text.match(/--?epochs?[ =](\d{1,6})/i) || text.match(/\bepochs?\s*[:=]\s*(\d{1,6})/i)
  return hit ? Number(hit[1]) : 0
}

/**
 * 解析实验进程清单。
 *
 * 全机扫描，不再按 cwd 丢弃：`insideRoot` 只决定面板能不能读它的日志 / 文件。
 * `bash -c` 启动器不当成实验，但它的输出重定向会传给同一棵树里的子进程。
 */
function parseExperiments(text, root, now) {
  const fields = markers(text)
  const remoteNow = Number(fields.now) || now
  const rows = []
  for (const payload of b64Markers(text, 'exp')) {
    const parts = decodeB64(payload).split('\t')
    if (parts.length < 10) continue
    const pid = Number(parts[0]) || 0
    const cwd = parts[4]
    if (!pid || !cwd) continue
    const command = cap(parts.slice(9).join('\t'), 1200)
    if (!command) continue
    rows.push({
      pid,
      ppid: Number(parts[1]) || 0,
      runtimeSec: Math.max(0, Number(parts[2]) || 0),
      condaEnv: cap(parts[3], 120),
      cwd,
      insideRoot: isInsideRoot(root, cwd),
      logPath: cap(parts[6], 500),
      launcher: parts[7] === '1',
      logSource: cap(parts[8], 16),
      command,
    })
  }

  const byPid = new Map(rows.map((row) => [row.pid, row]))
  // 树上层的那个进程才是「一个实验」；DataLoader worker、脚本与 python 都归到它名下
  const topOf = (row) => {
    let current = row
    for (let depth = 0; depth < 8; depth += 1) {
      const parent = byPid.get(current.ppid)
      if (!parent || parent.launcher) break
      current = parent
    }
    return current
  }
  // 日志通常是启动器重定向出来的，子进程自己命令行里没有
  const logOf = (row) => {
    if (row.logPath) return { path: row.logPath, source: row.logSource }
    let current = row
    for (let depth = 0; depth < 8; depth += 1) {
      const parent = byPid.get(current.ppid)
      if (!parent) return { path: '', source: '' }
      if (parent.logPath) return { path: parent.logPath, source: parent.logSource || 'parent' }
      current = parent
    }
    return { path: '', source: '' }
  }

  const children = new Map()
  for (const row of rows) {
    if (row.launcher) continue
    const top = topOf(row)
    children.set(top.pid, (children.get(top.pid) || 0) + 1)
  }

  const experiments = []
  const seen = new Set()
  for (const row of rows) {
    if (row.launcher) continue
    if (topOf(row).pid !== row.pid) continue
    if (seen.has(row.pid)) continue
    seen.add(row.pid)

    const lower = row.command.toLowerCase()
    const bin = path.posix.basename(commandArgv(row.command)[0] || '')
    const kind = /torchrun|deepspeed|accelerate/.test(lower)
      ? 'distributed'
      : lower.includes('jupyter')
        ? 'notebook'
        : lower.includes('tensorboard')
          ? 'tensorboard'
          : /^(python|python\d(?:\.\d+)?|pypy3?)$/.test(bin)
            ? 'training'
            : /\.sh$/.test(bin) || bin === 'bash' || bin === 'sh'
              ? 'script'
              : 'process'
    const log = logOf(row)
    const logPath = log.path
    experiments.push({
      id: [row.pid, row.cwd, row.command].join('|'),
      pid: row.pid,
      name: commandName(row.command),
      condaEnv: row.condaEnv,
      command: row.command,
      cwd: row.cwd,
      insideRoot: row.insideRoot,
      startedAt: Math.max(0, remoteNow - row.runtimeSec) * 1000,
      runtimeSec: row.runtimeSec,
      kind,
      totalEpochs: epochsFromCommand(row.command),
      logPath,
      logSource: logPath ? log.source : '',
      logReadable: !!logPath && isInsideRoot(root, logPath),
      logShared: false,
      logPeers: [],
      children: Math.max(0, (children.get(row.pid) || 1) - 1),
      status: 'running',
      gpu: [],
    })
  }

  // 两个实验解析到同一个日志时，曲线必然一模一样：标出来，别让人以为读错了
  const byLog = new Map()
  for (const exp of experiments) {
    if (!exp.logPath) continue
    const list = byLog.get(exp.logPath) || []
    list.push(exp)
    byLog.set(exp.logPath, list)
  }
  for (const list of byLog.values()) {
    if (list.length < 2) continue
    for (const exp of list) {
      exp.logShared = true
      exp.logPeers = list.filter((item) => item.pid !== exp.pid).map((item) => item.pid)
    }
  }

  experiments.sort((a, b) => {
    if (a.insideRoot !== b.insideRoot) return a.insideRoot ? -1 : 1
    return a.startedAt - b.startedAt
  })
  return { metrics: parseReport(text), experiments, gpu: parseGpu(text), gpuError: parseGpuError(text), smiPath: decodeB64(fields.smi) }
}

function parseGpu(text) {
  const gpu = []
  for (const payload of b64Markers(text, 'gpu')) {
    const line = decodeB64(payload)
    const match = line.match(/^\s*(\d+)\s*,\s*(.*?)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/)
    if (match) {
      gpu.push({
        index: Number(match[1]),
        name: cap(match[2], 120),
        usedMiB: Number(match[3]),
        totalMiB: Number(match[4]),
        util: Number(match[5]),
      })
    }
  }
  return gpu
}

function parseGpuError(text) {
  const payload = b64Markers(text, 'gpuerr')[0]
  if (payload === undefined) return ''
  return cap(decodeB64(payload), 200)
}

/* ---------- 实验进度 ---------- */

/** 只收训练 / 评测里常见的指标名，避免把时间戳、seed、路径里的数字当曲线画 */
const PROGRESS_KEYS = new Set([
  'epoch', 'step', 'iter', 'iteration', 'batch',
  'loss', 'train_loss', 'trainloss', 'val_loss', 'valloss', 'valid_loss', 'eval_loss', 'test_loss', 'total_loss', 'avg_loss',
  'acc', 'accuracy', 'train_acc', 'val_acc', 'valid_acc', 'test_acc', 'top1', 'top5', 'top10',
  'auc', 'aupr', 'auprc', 'mrr', 'mr', 'f1', 'f1_score', 'precision', 'recall',
  'hits', 'hit', 'ndcg', 'ap', 'map',
  'lr', 'learning_rate', 'ppl', 'perplexity', 'reward', 'score', 'bleu', 'rouge', 'rougel',
])
const PROGRESS_MAX_POINTS = 240
const PROGRESS_MAX_SERIES = 40

function normalizeProgressKey(key) {
  const value = String(key || '').toLowerCase()
  if (value === 'trainloss') return 'train_loss'
  if (value === 'valloss' || value === 'valid_loss') return 'val_loss'
  if (value === 'learning_rate') return 'lr'
  return value
}

/** `hits@10` / `hits_at_10` / `H@1` 统一成 hits@k，方便面板按名字排序 */
function progressKeyOf(raw) {
  let key = normalizeProgressKey(raw)
  const hits = key.match(/^hits?(?:er)?[_@]?(\d{1,3})$/) || key.match(/^h@(\d{1,3})$/)
  if (hits) key = 'hits@' + hits[1]
  if (!PROGRESS_KEYS.has(key) && !/^hits@\d{1,3}$/.test(key)) return ''
  return key
}

/**
 * 指标属于哪一段：`[Valid Emergent]`、`Epoch: 0, Train Loss:` 都能认出来。
 * 训练集和验证集的同名指标差得很远，混成一条曲线等于没画。
 */
function progressPhaseOf(line) {
  const bracket = line.match(/\[\s*(train|valid|val|test|eval|dev)(\s+[A-Za-z]+)?\s*\]/i)
  if (bracket) {
    const phase = (bracket[1] + (bracket[2] || '')).toLowerCase().replace(/\s+/g, '_')
    return phase === 'val' ? 'valid' : phase
  }
  const word = line.match(/\b(train|valid|val|test|eval)\s*(?:loss|mrr|hit|acc|auc|f1)/i)
  if (word) return word[1].toLowerCase() === 'val' ? 'valid' : word[1].toLowerCase()
  return ''
}

/**
 * 从日志尾部抽指标曲线。日志本身就是历史，不做跨轮次累积；
 * 每个指标最多 PROGRESS_MAX_POINTS 个点，够画近况就好。
 */
function parseProgress(text) {
  const series = new Map()
  let epochNow = 0
  let epochTotal = 0
  let percent = -1
  let phase = ''
  const push = (key, value) => {
    let list = series.get(key)
    if (!list) {
      if (series.size >= PROGRESS_MAX_SERIES) return
      list = []
      series.set(key, list)
    }
    list.push(value)
    if (list.length > PROGRESS_MAX_POINTS) list.splice(0, list.length - PROGRESS_MAX_POINTS)
  }

  // tqdm 用 `\r` 原地刷新，一行里可能压了几千次进度；按 `\r` 也要切开
  for (const line of str(text).split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue
    const linePhase = progressPhaseOf(line)
    if (linePhase) phase = linePhase
    // Epoch i/N、Epoch i、epochs=200 三种写法都认
    const slash = line.match(/\bepoch(?!s)\s*[\[\(:#= ]*\s*(\d{1,6})\s*[\/|]\s*(\d{1,6})/gi)
    if (slash) {
      const hit = slash[slash.length - 1].match(/(\d{1,6})\s*[\/|]\s*(\d{1,6})/)
      if (hit) {
        epochNow = Number(hit[1])
        epochTotal = Number(hit[2]) || epochTotal
      }
    } else {
      const single = line.match(/\bepoch(?!s)\s*[\[\(:#= ]*\s*(\d{1,6})\b/gi)
      if (single) {
        const hit = single[single.length - 1].match(/(\d{1,6})\s*$/)
        if (hit) epochNow = Number(hit[1])
      }
    }
    const total = line.match(/\bepochs\s*[=:]\s*(\d{1,6})/gi)
    if (total) {
      const hit = total[total.length - 1].match(/(\d{1,6})/)
      if (hit) epochTotal = Number(hit[1])
    }
    const pair = /([A-Za-z][A-Za-z0-9_@.\-]{0,24})\s*[=:]\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g
    let hit
    while ((hit = pair.exec(line)) !== null) {
      const base = progressKeyOf(hit[1])
      if (!base) continue
      const value = Number(hit[2])
      if (!Number.isFinite(value) || Math.abs(value) >= 1e12) continue
      if (base === 'epoch' && Number.isInteger(value)) {
        epochNow = value
        continue
      }
      push(phase ? phase + '.' + base : base, value)
    }
    const pct = line.match(/(\d{1,3})%\|/g)
    if (pct) percent = Number(pct[pct.length - 1].slice(0, -2))
  }

  const out = []
  for (const [key, points] of series) {
    if (!points.length) continue
    let min = Infinity
    let max = -Infinity
    for (const value of points) {
      if (value < min) min = value
      if (value > max) max = value
    }
    const last = points[points.length - 1]
    const prev = points.length > 1 ? points[points.length - 2] : last
    out.push({ key, points, min, max, first: points[0], last, delta: last - prev })
  }
  // loss 类排前面，其余保持日志里的出现顺序
  out.sort((a, b) => (a.key.includes('loss') ? 0 : 1) - (b.key.includes('loss') ? 0 : 1))
  return { series: out, epoch: { current: epochNow, total: epochTotal }, percent: percent < 0 ? null : percent }
}

function numbers(value) {
  return str(value)
    .split(/\s+/)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n))
}

/**
 * 把 `@@key=value` 输出解析成指标。缺 /proc 的主机（macOS、BSD）直接报错，
 * 不拿 0 冒充「负载为空」。
 */
function parseReport(text) {
  const fields = {}
  for (const raw of str(text).split(/\r?\n/)) {
    if (!raw.startsWith('@@')) continue
    const eq = raw.indexOf('=')
    if (eq < 0) continue
    fields[raw.slice(2, eq)] = raw.slice(eq + 1).trim()
  }
  const load = numbers(fields.load)
  if (load.length < 3) throw new Error('这台机器没有 /proc/loadavg：服务器看板目前只解析 Linux')

  const mem = numbers(fields.mem)
  const memTotal = mem[0] || 0
  const memUsed = mem[1] || 0
  const memAvailable = mem[2] || 0

  const diskParts = str(fields.disk).split(/\s+/).filter(Boolean)
  const diskPercent = diskParts.length >= 4 ? parseInt(diskParts[3].replace('%', ''), 10) : NaN

  return {
    hostname: cap(fields.host, 120),
    os: cap(fields.os, 120),
    cpu: numbers(fields.cpu)[0] || 0,
    uptimeSec: numbers(fields.uptime)[0] || 0,
    load: load.slice(0, 3),
    mem: {
      total: memTotal,
      used: memUsed,
      available: memAvailable,
      percent: memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0,
    },
    disk: {
      total: numbers(diskParts[0])[0] || 0,
      used: numbers(diskParts[1])[0] || 0,
      available: numbers(diskParts[2])[0] || 0,
      percent: Number.isFinite(diskPercent)
        ? diskPercent
        : numbers(diskParts[0])[0] > 0
          ? Math.round(((numbers(diskParts[1])[0] || 0) / numbers(diskParts[0])[0]) * 100)
          : 0,
    },
  }
}

/* ---------- 历史实验 ---------- */

/**
 * 跑完的实验去哪了。
 *
 * 「实验进程」只看得见此刻还在跑的进程；跑完的那些，痕迹全在目录里：
 * 一次运行是一个目录，里面有启动脚本、日志、results/ 和源码快照。
 * 所以溯源靠的是扫目录树，不是看进程表。
 *
 * 扫的是绑定根目录底下的 02_runs（按 /workspace 的规矩，一次运行一个目录），
 * 另外把 _logs 这个历史存档也算进去：整理之前的日志都堆在那儿，
 * 它们没有对应的 run 目录，却同样是一次跑过的实验。
 */

/** 目录里出现这些名字，就说明这是一次运行，而不是中间目录 */
const RUN_MARKERS = ['results', 'src', 'runlogs', 'logs', 'configs', 'evidence']
/** 目录里直接放着这些文件，也算一次运行 */
const RUN_FILE_RE = /\.(log|out|json|csv)$/i
/** 一个 run 最多带多少条日志 / 结果文件进面板 */
const HISTORY_MAX_LOGS = 8
const HISTORY_MAX_RESULTS = 12
/** 扫多深：run 目录再往下就是数据集与源码快照，不是结果 */
const HISTORY_MAX_DEPTH = 7

/**
 * 一次 ssh 把历史扫回来。
 *
 * 全部是只读命令：find / du / grep / base64，参数只有绑定根目录。
 * 体积用一次 du 批量算（逐个目录 fork 的话几百个 run 要跑好几秒）；
 * 指标只取每个日志里最后一条带 MRR 的行——那一条才是这次跑的最终成绩。
 */
function buildHistoryScript(root) {
  return [
    'LC_ALL=C; export LC_ALL',
    `root=$(printf %s ${quotedB64(root)} | base64 -d 2>/dev/null) || exit 41`,
    'root=$(cd "$root" 2>/dev/null && pwd -P) || exit 42',
    `echo "@@root=$(printf %s "$root" | base64 | tr -d '\\n')"`,
    'echo "@@now=$(date +%s)"',
    'cd "$root" || exit 42',
    // 目录与文件：数据集、证据、源码快照又大又不是结果，只记名字不进去
    '{',
    '  find 02_runs -mindepth 1 -maxdepth 7 \\( -type d \\( -name data -o -name evidence -o -name src -o -name .git \\) -prune \\) -o -printf \'%y\\t%s\\t%T@\\t%p\\n\' 2>/dev/null',
    '  find _logs -mindepth 1 -maxdepth 2 -printf \'%y\\t%s\\t%T@\\t%p\\n\' 2>/dev/null',
    '} | base64 | tr -d \'\\n\' | sed \'s/^/@@tree=/\'',
    'echo',
    // 一次 du 覆盖所有 run 目录，嵌套目录不会重复计入
    'runs=$({ find 02_runs -mindepth 2 -maxdepth 5 \\( -type d \\( -name results -o -name src -o -name runlogs -o -name logs -o -name configs -o -name evidence \\) -printf \'%h\\n\' \\) -o \\( -type f \\( -name \'*.log\' -o -name \'*.sh\' \\) -printf \'%h\\n\' \\) ; } | sort -u)',
    'if [ -n "$runs" ]; then printf \'%s\\n\' "$runs" | tr \'\\n\' \'\\0\' | xargs -0 du -sk 2>/dev/null; fi | base64 | tr -d \'\\n\' | sed \'s/^/@@sizes=/\'',
    'echo',
    // 每个日志只留最后一条带 MRR 的行；_logs 存档先扫，否则会被 02_runs 的日志挤掉。
    // 上限按现有日志总量（约 1000 份）留足：早先卡在 700，最新那几批实验的日志
    // 根本没进候选，面板上就显示成「没有指标」。取成绩时优先非 checkpoint 的评测日志。
    'cand=$( { find _logs -type f -name \'*.log\' 2>/dev/null | head -n 300; find 02_runs -type f -name \'*.log\' 2>/dev/null | head -n 1500; } )',
    'if [ -n "$cand" ]; then printf \'%s\\n\' "$cand" | tr \'\\n\' \'\\0\' | xargs -0 grep -H -a -E \'MRR\' 2>/dev/null | awk -F: \'{last[$1]=$0} END {for (f in last) print last[f]}\'; fi | base64 | tr -d \'\\n\' | sed \'s/^/@@metrics=/\'',
    'echo',
    // 迁移账本：搬动前叫什么、什么时候搬的，都还记着
    'for f in _migration/MANIFEST.tsv _migration/DELETED_*.tsv _migration/family_map_*.tsv; do',
    '  [ -f "$f" ] || continue',
    '  echo "@@ledgername=$(printf %s "$f" | base64 | tr -d \'\\n\')"',
    '  base64 < "$f" | tr -d \'\\n\' | sed \'s/^/@@ledger=/\'',
    '  echo',
    'done',
    // 账本目录里还有别的文件（族谱、规则），列出来让人能直接打开看
    'find _migration -mindepth 1 -maxdepth 1 -type f -printf \'%y\\t%s\\t%T@\\t%p\\n\' 2>/dev/null | base64 | tr -d \'\\n\' | sed \'s/^/@@ledgerfiles=/\'',
    'echo',
    // 根目录下的说明文件（RULES.md、README.md）：实验为什么这么摆，规则写在里头
    'find . -mindepth 1 -maxdepth 1 -type f -printf \'%y\\t%s\\t%T@\\t%p\\n\' 2>/dev/null | base64 | tr -d \'\\n\' | sed \'s/^/@@rootfiles=/\'',
    'echo',
  ].join('\n')
}

/**
 * 一行指标：MR / MRR / H@1 / H@3 / H@10
 *
 * 两种写法都要认：
 *   `Raw test_time_filter MR: 731.12 | MRR: 0.5132 | H@1: 0.4290 | H@3: ... | H@10: ...`
 *   `TEST :  {'MRR': 0.1508, 'hits@[1,3,10]': tensor([0.0734, 0.1512, 0.3104])}`（老日志）
 */
function parseMetricLine(text) {
  const line = str(text)
  const pick = (re) => {
    const hit = line.match(re)
    if (!hit) return null
    const value = Number(hit[1])
    return Number.isFinite(value) ? value : null
  }
  const metrics = {
    mr: pick(/\bMR[:=]\s*([0-9]+(?:\.[0-9]+)?)/),
    mrr: pick(/['"]?MRR['"]?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/),
    h1: pick(/\bH@1[:=]\s*([0-9]+(?:\.[0-9]+)?)/),
    h3: pick(/\bH@3[:=]\s*([0-9]+(?:\.[0-9]+)?)/),
    h10: pick(/\bH@10[:=]\s*([0-9]+(?:\.[0-9]+)?)/),
  }
  if (metrics.h1 === null && metrics.h3 === null && metrics.h10 === null) {
    // 老日志把三个命中数写成 tensor([h1, h3, h10])，跟在 hits@[1,3,10] 后面
    const hits = line.match(/hits?@\s*\[\s*1\s*,\s*3\s*,\s*10\s*\][^0-9-]*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/)
    if (hits) {
      const values = [hits[1], hits[2], hits[3]].map((value) => Number(value))
      if (values.every((value) => Number.isFinite(value))) {
        metrics.h1 = values[0]
        metrics.h3 = values[1]
        metrics.h10 = values[2]
      }
    }
  }
  if (metrics.mr === null && metrics.mrr === null && metrics.h1 === null) return null
  return metrics
}

/** 把树拍平成目录 / 文件两张表 */
function parseTree(text) {
  const dirs = new Map()
  const files = []
  for (const line of str(text).split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 4) continue
    const type = parts[0]
    const size = Number(parts[1]) || 0
    const modified = Math.round((Number(parts[2]) || 0) * 1000)
    const path = parts.slice(3).join('\t')
    if (!path) continue
    const slash = path.lastIndexOf('/')
    const parent = slash > 0 ? path.slice(0, slash) : ''
    const name = slash > 0 ? path.slice(slash + 1) : path
    if (type === 'd') {
      if (!dirs.has(path)) dirs.set(path, { path, parent, name, type: 'd', size, modified, kids: [] })
    } else {
      files.push({ path, parent, name, size, modified, type })
    }
  }
  // 把子节点挂到父目录上
  const byPath = new Map()
  for (const dir of dirs.values()) byPath.set(dir.path, dir)
  for (const dir of dirs.values()) {
    const parent = byPath.get(dir.parent)
    if (parent) parent.kids.push({ name: dir.name, type: dir.type, size: dir.size, modified: dir.modified, path: dir.path })
  }
  for (const file of files) {
    const parent = byPath.get(file.parent)
    if (parent) parent.kids.push({ name: file.name, type: file.type, size: file.size, modified: file.modified, path: file.path })
  }
  return { dirs: byPath, files }
}

/** 这个目录像不像一次运行 */
function looksLikeRun(dir) {
  for (const kid of dir.kids) {
    if (kid.type === 'd' || kid.type === 'l') {
      if (RUN_MARKERS.includes(kid.name)) return true
    } else if (RUN_FILE_RE.test(kid.name)) {
      return true
    }
  }
  return false
}

/** du 出来的体积表：相对路径 → 字节 */
function parseSizes(text) {
  const out = new Map()
  for (const line of str(text).split('\n')) {
    if (!line) continue
    const hit = line.match(/^(\d+)\s+(.+)$/)
    if (!hit) continue
    const bytes = Number(hit[1]) * 1024
    out.set(hit[2].trim(), bytes)
  }
  return out
}

/** 每个日志最后一条带 MRR 的行 */
function parseMetricIndex(text) {
  const out = new Map()
  for (const line of str(text).split('\n')) {
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const file = line.slice(0, colon)
    const body = line.slice(colon + 1)
    const metrics = parseMetricLine(body)
    if (metrics) out.set(file, { metrics, line: cap(body.trim(), 400) })
  }
  return out
}

/** 迁移账本：新路径 → 搬动前叫什么 */
function parseManifest(text) {
  const map = new Map()
  for (const line of str(text).split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const to = parts[2].trim()
    if (!to) continue
    map.set(to, { from: parts[1].trim(), at: parts[0].trim() })
  }
  return map
}

/** 删除账本：删过什么、多大、什么时候删的 */
function parseDeleted(text) {
  const out = []
  for (const line of str(text).split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 4) continue
    if (parts[0] === 'type') continue
    out.push({
      type: cap(parts[0], 60),
      size: Number(parts[1]) || 0,
      at: cap(parts[2], 40),
      path: cap(parts[3], 400),
    })
  }
  return out
}

/**
 * 把扫回来的东西整理成「跑过的实验」清单。
 *
 * 一个 run = 一个目录，所以每条记录都带自己的路径、启动脚本、日志、结果文件，
 * 以及从日志末尾抽出来的最终指标——回头看结果要的就是这三样。
 */
function parseHistory(text, root, now) {
  const fields = markers(text)
  const remoteNow = Number(fields.now) || now
  const rootPath = decodeB64(fields.root) || root
  const { dirs, files } = parseTree(decodeB64(fields.tree))
  const sizes = parseSizes(decodeB64(fields.sizes))
  const metricIndex = parseMetricIndex(decodeB64(fields.metrics))

  const ledgerNames = []
  const ledgerTexts = []
  for (const payload of b64Markers(text, 'ledgername')) {
    ledgerNames.push(decodeB64(payload))
  }
  for (const payload of b64Markers(text, 'ledger')) {
    ledgerTexts.push(decodeB64(payload))
  }
  const manifest = new Map()
  const deleted = []
  ledgerNames.forEach((name, index) => {
    const body = ledgerTexts[index] || ''
    if (/MANIFEST\.tsv$/.test(name)) {
      for (const [key, value] of parseManifest(body)) manifest.set(key, value)
    } else if (/DELETED/i.test(name)) {
      deleted.push(...parseDeleted(body))
    }
  })

  // 账本目录里的其他文件（族谱、规则）：让人能直接打开看
  const ledgerFiles = []
  for (const line of decodeB64(fields.ledgerfiles).split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 4) continue
    ledgerFiles.push({
      path: `${rootPath}/${parts.slice(3).join('\t')}`,
      name: parts[3].slice(parts[3].lastIndexOf('/') + 1),
      size: Number(parts[1]) || 0,
      modified: Math.round((Number(parts[2]) || 0) * 1000),
    })
  }

  // 根目录的说明文件：RULES.md 写着「一次运行一个目录」这类规矩
  const rootFiles = []
  for (const line of decodeB64(fields.rootfiles).split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 4) continue
    const rel = parts.slice(3).join('\t').replace(/^\.\//, '')
    rootFiles.push({
      path: `${rootPath}/${rel}`,
      name: rel,
      size: Number(parts[1]) || 0,
      modified: Math.round((Number(parts[2]) || 0) * 1000),
    })
  }

  /**
   * 只认最外层的运行目录。
   *
   * run 里面还有 `checkpoint/`、`run/`、`logs/` 这类目录，它们自己带着日志和 json，
   * 单看内容同样「像一次运行」。早先逐个判断，结果 182 次实验被数成 382 次：
   * 每份 checkpoint 都成了独立实验，MRR 也各自重复一遍。
   * 所以按路径从浅到深接受，落在已接受目录之下的候选直接跳过。
   */
  const candidates = []
  for (const dir of dirs.values()) {
    if (!dir.path.startsWith('02_runs/')) continue
    // 只有代码快照的目录不算跑过：`*_src` 是源码工作树，没有启动脚本也没有评测日志
    if (/_src$/.test(dir.path)) continue
    const name = dir.path.slice(dir.path.lastIndexOf('/') + 1)
    // results/、src/、logs/ 是「一次运行里面的子目录」，它们自己不是一次实验
    if (RUN_MARKERS.includes(name)) continue
    if (!looksLikeRun(dir)) continue
    candidates.push(dir)
  }
  candidates.sort((a, b) => {
    const left = a.path.split('/').length
    const right = b.path.split('/').length
    if (left !== right) return left - right
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
  const accepted = []
  for (const dir of candidates) {
    let nested = false
    for (const run of accepted) {
      if (dir.path.startsWith(run.path + '/')) { nested = true; break }
    }
    if (!nested) accepted.push(dir)
  }

  const runs = []
  for (const dir of accepted) {
    const parts = dir.path.split('/')
    const name = parts[parts.length - 1]
    const project = parts[1] || ''
    const group = parts.slice(2, -1).join('/')

    // 这个 run 底下都属于它：日志、结果、启动脚本
    const own = []
    const stack = [dir]
    while (stack.length) {
      const current = stack.pop()
      for (const kid of current.kids) {
        if (kid.type === 'd') {
          const child = dirs.get(kid.path)
          if (child) stack.push(child)
          continue
        }
        own.push(kid)
      }
    }
    // 指标索引是按相对路径建的，所以先拿相对路径去对，最后再拼成完整路径给人看
    const logFiles = own
      .filter((file) => /\.log$/i.test(file.name))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, HISTORY_MAX_LOGS)
    const resultFiles = own
      .filter((file) => file.path.includes('/results/'))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, HISTORY_MAX_RESULTS)
    const launch = own
      .filter((file) => /\.sh$/i.test(file.name))
      .sort((a, b) => (a.name === 'launch.sh' ? -1 : b.name === 'launch.sh' ? 1 : a.name.localeCompare(b.name)))[0]
    const modified = own.reduce((max, file) => Math.max(max, file.modified), dir.modified)

    // 最终指标：先找有成绩的日志，再按「像不像一次评测」排序。
    // 同一个 run 里什么日志都有：`*_test.log` 是最终评测，`train.log` 是训练中的验证，
    // `frequency_slices.log` 是分频段切片（里面也有一个 "MRR" 字段，但不是整体成绩），
    // checkpoint 底下那份是续跑中间产物。取错一份，0.34 的 run 会显示成 0.001。
    const hasMetric = (file) => metricIndex.has(file.path)
    const logScore = (file) => {
      let score = 0
      if (/frequency_slices|slices?\.log$/i.test(file.name)) score -= 6
      if (file.path.includes('/checkpoint/')) score -= 3
      if (/test|eval/i.test(file.name)) score += 4
      if (/valid|train/i.test(file.name)) score += 1
      if (file.path.includes('/results/')) score += 2
      return score
    }
    const scored = logFiles.filter(hasMetric).sort((a, b) => logScore(b) - logScore(a))
    const primary =
      scored[0] ||
      logFiles.find((log) => log.path.includes('/results/')) ||
      logFiles[0] ||
      null
    const metric = primary ? metricIndex.get(primary.path) : null

    // 面板上要显示能直接复制去用的完整路径，不能是「相对绑定目录」的半截路径
    const logs = logFiles.map((file) => ({
      path: `${rootPath}/${file.path}`,
      name: file.name,
      size: file.size,
      modified: file.modified,
    }))
    const results = resultFiles.map((file) => ({
      path: `${rootPath}/${file.path}`,
      name: file.name,
      size: file.size,
      modified: file.modified,
      text: /\.(log|json|csv|txt|yaml|yml|tsv|md|sh|py)$/i.test(file.name),
    }))

    const moved = manifest.get(dir.path) || null
    // 整理前是一次平铺：目录直接在根底下，名字多半没变，位置变了
    const oldPath = moved && moved.from ? `${rootPath}/${moved.from}` : ''
    runs.push({
      id: dir.path,
      path: `${rootPath}/${dir.path}`,
      rel: dir.path,
      name,
      project,
      group,
      family: group ? group.split('/')[group.split('/').length - 1] : '',
      modified,
      size: sizes.get(dir.path) || 0,
      metrics: metric ? metric.metrics : null,
      metricLine: metric ? metric.line : '',
      metricFrom: primary ? `${rootPath}/${primary.path}` : '',
      logs,
      results,
      resultCount: results.length,
      launch: launch ? { path: `${rootPath}/${launch.path}`, name: launch.name, size: launch.size } : null,
      movedFrom: moved ? moved.from : '',
      movedAt: moved ? moved.at : '',
      // 旧路径和现在一样就没必要当成「搬过」来显示
      movedFromPath: oldPath,
    })
  }

  runs.sort((a, b) => b.modified - a.modified)

  // _logs：整理之前的日志存档。它们没有 run 目录，但同样是一次跑过的实验
  const archives = []
  for (const file of files) {
    if (!file.path.startsWith('_logs/')) continue
    const metric = metricIndex.get(file.path)
    archives.push({
      id: file.path,
      path: `${rootPath}/${file.path}`,
      rel: file.path,
      name: file.name,
      size: file.size,
      modified: file.modified,
      metrics: metric ? metric.metrics : null,
      metricLine: metric ? metric.line : '',
    })
  }
  archives.sort((a, b) => b.modified - a.modified)

  const withMetrics = runs.filter((run) => run.metrics).length
  const withResults = runs.filter((run) => run.resultCount > 0).length
  return {
    root: rootPath,
    at: Date.now(),
    remoteNow,
    runs,
    archives,
    deleted,
    ledgerFiles,
    rootFiles,
    stats: {
      runs: runs.length,
      withMetrics,
      withResults,
      archives: archives.length,
      deleted: deleted.length,
      moved: runs.filter((run) => run.movedFrom).length,
    },
  }
}

/**
 * 连都没连上：主机刚被唤醒、ARP/路由缓存过期、端口转发的宿主机刚启动，
 * 都会卡在握手阶段。实测这种冷启动第一次会耗掉 5~10 秒，第二次连接立刻就快。
 * 所以这类失败值得重连一次，而不是直接把「连接超时」甩给用户。
 */
const TRANSIENT_CONNECT_RE = /Connection timed out during banner exchange|Connection timed out|Operation timed out|Connection reset by peer|Connection closed by remote host|No route to host|Broken pipe/i

function isTransientConnectFailure(stderr) {
  return TRANSIENT_CONNECT_RE.test(str(stderr))
}

/** ssh 的英文报错翻成人能动手的说法；翻不出来的保留最后一行，别只说「失败了」 */
function explainFailure(code, stderr) {
  const text = str(stderr)
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return '主机密钥变了：确认是不是重装过机器，再更新 known_hosts'
  if (/Host key verification failed/i.test(text)) return '主机密钥校验失败：先在终端手动 ssh 一次确认指纹'
  if (/Permission denied|no such identity/i.test(text)) return '认证失败：目标机不接受当前密钥（确认公钥在 authorized_keys 里，或先用 ssh-add 加进 agent）'
  if (/Could not resolve hostname/i.test(text)) return '主机名解析失败'
  if (/Connection refused/i.test(text)) return '连接被拒绝：端口不对，或 sshd 没在跑'
  if (/Connection timed out|Operation timed out|timed out/i.test(text)) return '连接超时：目标机没在握手阶段应答，多半是刚被唤醒或网络抖动，重试一次通常就好'
  if (/No route to host/i.test(text)) return '网络不可达（No route to host）'
  const last = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()
  // 没有退出码说明 ssh 是被信号终止的（连接断了、或本地把它 kill 了），说成「退出码 -1」只会让人猜
  if (typeof code !== 'number' || code < 0) {
    return last ? `ssh 被异常终止：${last}`.slice(0, 220) : 'ssh 被异常终止（拿不到退出码，也没有错误输出）：连接可能已中断，重试一次或在终端手动 ssh 看看'
  }
  return last ? `ssh 退出码 ${code}：${last}`.slice(0, 220) : `ssh 退出码 ${code}，没有输出`
}

/** 真探针：ssh 直接 spawn，argv 传参，不经过 shell */
function spawnRunner(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let overflow = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 进程已经没了 */
      }
      finish(reject, new Error(`探测超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    const abort = () => {
      try {
        child.kill()
      } catch {
        /* 进程已经没了 */
      }
    }
    child.stdout.on('data', (chunk) => {
      if (settled) return
      stdout += chunk
      if (stdout.length > WORKSPACE_MAX_OUTPUT) {
        overflow = `远程返回过大（超过 ${Math.round(WORKSPACE_MAX_OUTPUT / 1024 / 1024)} MB），已中止；日志过大时先缩小读取范围`
        abort()
      }
    })
    child.stderr.on('data', (chunk) => {
      if (settled) return
      stderr += chunk
      if (stderr.length > WORKSPACE_MAX_STDERR) abort()
    })
    child.on('error', (error) => {
      finish(reject, error && error.code === 'ENOENT' ? new Error('找不到 ssh 命令（装 OpenSSH 客户端，或确认它在 PATH 里）') : error)
    })
    child.on('close', (code) => {
      // 超限被 kill 时 code 是 null、stderr 是空的，照旧回 -1 只会得到一句看不懂的「没有输出」
      if (overflow) {
        finish(reject, new Error(overflow))
        return
      }
      finish(resolve, { code: typeof code === 'number' ? code : -1, stdout, stderr })
    })
  })
}

/**
 * 探测一台机器。runner 是注入点：测试用假 runner 覆盖 ssh，生产走 spawnRunner。
 * 返回值同时写回 server.last —— 面板与工具看到的是同一份结果。
 * 冷启动握手超时值得重连一次：第一次耗掉十几秒，第二次几乎立刻就通。
 */
async function probeWith(runner, server) {
  const started = Date.now()
  let result
  try {
    let out = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      out = await runner(buildProbeArgs(server), PROBE_TIMEOUT_MS)
      if (out.code === 0) break
      if (attempt === 0 && isTransientConnectFailure(out.stderr)) continue
      throw new Error(explainFailure(out.code, out.stderr))
    }
    const ms = Date.now() - started
    if (out.code !== 0) throw new Error(explainFailure(out.code, out.stderr))
    result = { ok: true, at: Date.now(), ms, metrics: parseReport(out.stdout) }
  } catch (error) {
    result = {
      ok: false,
      at: Date.now(),
      ms: Date.now() - started,
      error: error && error.message ? error.message : String(error),
    }
  }
  server.last = result
  return result
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      out[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return out
}

/** 多台一起探：并发受限 + 总预算，避免宿主 30 秒超时把结果全丢掉 */
async function probeMany(servers) {
  const deadline = Date.now() + PROBE_BUDGET_MS
  let skipped = 0
  await mapLimit(servers, PROBE_CONCURRENCY, async (server) => {
    if (Date.now() >= deadline) {
      skipped += 1
      server.last = { ok: false, at: Date.now(), ms: 0, error: '这一轮时间预算用完了，稍后再探' }
      return
    }
    await probeWith(spawnRunner, server)
  })
  if (skipped > 0) await save()
  return skipped
}

/* ---------- 视图 ---------- */

function viewOf(server) {
  return {
    id: server.id,
    label: server.label,
    host: server.host,
    port: server.port,
    user: server.user,
    keyPath: server.keyPath || '',
    createdAt: server.createdAt,
    last: server.last || null,
  }
}

function toolViewOf(server) {
  return {
    id: server.id,
    label: server.label,
    host: server.host,
    port: server.port,
    user: server.user,
    last: server.last || null,
  }
}

function counts() {
  const total = state.servers.length
  const ok = state.servers.filter((s) => s.last && s.last.ok).length
  const bad = state.servers.filter((s) => s.last && s.last.ok === false).length
  return { total, ok, bad, unchecked: total - ok - bad }
}

function listView() {
  return { servers: state.servers.map(viewOf), counts: counts() }
}

/* ---------- 持久化 ---------- */

async function save() {
  await ctx.storage.set('servers', state.servers)
  await ctx.storage.set('roots', state.roots)
}

/** 绑定的根目录只接受能通过同一套路径校验的值；坏掉的旧数据直接丢掉。 */
function cleanRootBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  let root = ''
  try {
    root = normalizeRemoteRoot(value.root)
  } catch {
    return null
  }
  const at = Number(value.at)
  if (!Number.isFinite(at) || at <= 0) return null
  return { root, at: Math.floor(at) }
}

async function load() {
  const raw = await ctx.storage.get('servers')
  const list = Array.isArray(raw) ? raw : []
  state.servers = list
    .filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.host === 'string')
    .slice(0, MAX_SERVERS)

  const known = new Set(state.servers.map((s) => s.id))
  const rawRoots = await ctx.storage.get('roots')
  const roots = {}
  if (rawRoots && typeof rawRoots === 'object' && !Array.isArray(rawRoots)) {
    for (const [serverId, value] of Object.entries(rawRoots)) {
      if (!known.has(serverId)) continue
      const binding = cleanRootBinding(value)
      if (binding) roots[serverId] = binding
    }
  }
  state.roots = roots
}

/* ---------- RPC（面板） ---------- */

async function addServer(params) {
  if (state.servers.length >= MAX_SERVERS) throw new Error(`最多 ${MAX_SERVERS} 台`)
  const input = readServerInput(params, null)
  if (input.errors.length) throw new Error(input.errors.join('；'))
  const dup = state.servers.find((s) => sameBox(s, input.value))
  if (dup) throw new Error(`已经有同一台机器：${dup.label}`)
  const server = { id: uid(), ...input.value, createdAt: Date.now(), last: null }
  state.servers.push(server)
  await save()
  return server
}

async function updateServer(params) {
  const server = findServer(str(params.serverId))
  const merged = {
    label: params.label === undefined ? server.label : params.label,
    host: params.host === undefined ? server.host : params.host,
    user: params.user === undefined ? server.user : params.user,
    port: params.port === undefined ? server.port : params.port,
    keyPath: params.keyPath === undefined ? server.keyPath : params.keyPath,
  }
  const input = readServerInput(merged, server)
  if (input.errors.length) throw new Error(input.errors.join('；'))
  const dup = state.servers.find((s) => s.id !== server.id && sameBox(s, input.value))
  if (dup) throw new Error(`已经有同一台机器：${dup.label}`)
  if (sameBox(server, input.value) && server.keyPath === input.value.keyPath && server.label === input.value.label) {
    return server
  }
  // 连接信息变了，旧的探测结果就不能再挂着冒充现状
  const moved = !sameBox(server, input.value) || server.keyPath !== input.value.keyPath
  Object.assign(server, input.value)
  if (moved) server.last = null
  await save()
  return server
}

async function removeServer(params) {
  const server = findServer(str(params.serverId))
  state.servers = state.servers.filter((s) => s.id !== server.id)
  delete state.roots[server.id]
  await save()
  return { removed: server.id }
}

async function probeServer(params) {
  const server = findServer(str(params.serverId))
  await probeWith(spawnRunner, server)
  await save()
  return { server: viewOf(server) }
}

/* ---------- 研究工作台（只读） ---------- */

function rootView(serverId, binding) {
  return {
    serverId,
    root: binding.root,
    at: binding.at,
    fresh: Date.now() - binding.at < ROOT_FRESH_MS,
  }
}

function listRoots() {
  const roots = []
  for (const server of state.servers) {
    const binding = state.roots[server.id]
    if (binding) roots.push(rootView(server.id, binding))
  }
  return { roots }
}

async function setRoot(params) {
  const server = findServer(str(params.serverId))
  const requested = normalizeRemoteRoot(params.root)
  const out = await runWorkspace(server, buildRootCheckScript(requested))
  const canonical = decodeB64(markers(out.stdout).root)
  if (!canonical) throw new Error('远端没有返回项目目录')
  const binding = { root: normalizeRemoteRoot(canonical), at: Date.now() }
  state.roots[server.id] = binding
  await save()
  return { root: rootView(server.id, binding) }
}

async function removeRoot(params) {
  const server = findServer(str(params.serverId))
  delete state.roots[server.id]
  await save()
  return { removed: server.id }
}

async function listExperiments(params) {
  const { server, binding } = rootFor(str(params.serverId))
  const out = await runWorkspace(server, buildExperimentScript(binding.root))
  const parsed = parseExperiments(out.stdout, binding.root, Math.floor(Date.now() / 1000))
  return { root: binding.root, at: Date.now(), ...parsed }
}

/**
 * 历史实验：跑完的那些。
 *
 * 与「实验进程」分开：进程表只有此刻还在跑的东西，历史靠扫目录树找回来。
 */
async function listHistory(params) {
  const { server, binding } = rootFor(str(params.serverId))
  const out = await runWorkspace(server, buildHistoryScript(binding.root))
  const parsed = parseHistory(out.stdout, binding.root, Math.floor(Date.now() / 1000))
  // 族谱在内置家族表上算：一次扫描同时带回来，面板不用再跑第二趟 ssh
  parsed.lineage = buildLineage(parsed.runs)
  return parsed
}

/** 实验进度：读日志尾部，抽指标曲线；只允许读绑定目录内的文件 */
async function logProgress(params) {
  const { server, binding } = rootFor(str(params.serverId))
  const target = resolveRemotePath(binding.root, params.path, false)
  const lines = Math.max(60, Math.min(LOG_MAX_LINES, Math.floor(Number(params.lines) || 1200)))
  const out = await runWorkspace(server, buildProgressScript(binding.root, target, READ_MAX_BYTES, lines))
  const fields = markers(out.stdout)
  const text = decodeB64(fields.data)
  const head = decodeB64(fields.head)
  const size = Number(fields.size) || 0
  const parsed = parseProgress(text)
  if (!parsed.epoch.total && head) {
    const opening = parseProgress(head)
    if (opening.epoch.total) parsed.epoch.total = opening.epoch.total
    if (!parsed.epoch.current && opening.epoch.current) parsed.epoch.current = opening.epoch.current
  }
  return {
    root: decodeB64(fields.root) || binding.root,
    path: decodeB64(fields.path) || target,
    size,
    truncated: size > Buffer.byteLength(text, 'utf8'),
    at: Date.now(),
    ...parsed,
  }
}

async function listFiles(params) {
  const { server, binding } = rootFor(str(params.serverId))
  const target = resolveRemotePath(binding.root, params.path, true)
  const out = await runWorkspace(server, buildFilesScript(binding.root, target))
  return { ...parseFileListing(out.stdout), at: Date.now() }
}

/**
 * 给「绑定项目目录」那个下拉用：列一台机器上某一层有哪些子目录。
 * 与 server.files 的区别就是没有根目录可依附 —— 这里挑的就是根目录本身。
 */
async function listDirs(params) {
  const server = findServer(str(params.serverId))
  const target = normalizeBrowsePath(params.path)
  const out = await runWorkspace(server, buildDirsScript(target))
  return { ...parseDirListing(out.stdout), at: Date.now() }
}

async function readText(params) {
  const { server, binding } = rootFor(str(params.serverId))
  const target = resolveRemotePath(binding.root, params.path, false)
  const out = await runWorkspace(server, buildReadScript(binding.root, target, params.maxBytes, null))
  const fields = markers(out.stdout)
  const text = decodeB64(fields.data)
  const size = Number(fields.size) || 0
  return {
    root: decodeB64(fields.root) || binding.root,
    path: decodeB64(fields.path) || target,
    size,
    truncated: size > Buffer.byteLength(text, 'utf8'),
    text,
    at: Date.now(),
  }
}

async function logTail(params) {
  const { server, binding } = rootFor(str(params.serverId))
  const target = resolveRemotePath(binding.root, params.path, false)
  const out = await runWorkspace(server, buildReadScript(binding.root, target, params.maxBytes, params.lines))
  const fields = markers(out.stdout)
  const text = decodeB64(fields.data)
  const size = Number(fields.size) || 0
  return {
    root: decodeB64(fields.root) || binding.root,
    path: decodeB64(fields.path) || target,
    size,
    truncated: size > Buffer.byteLength(text, 'utf8'),
    text,
    at: Date.now(),
  }
}

async function readMetrics(params) {
  const { server, binding } = rootFor(str(params.serverId))
  const out = await runWorkspace(server, buildMetricsScript(binding.root))
  return {
    root: binding.root,
    at: Date.now(),
    metrics: parseReport(out.stdout),
    gpu: parseGpu(out.stdout),
    gpuError: parseGpuError(out.stdout),
  }
}

/* ---------- 入口 ---------- */

async function activate(context) {
  ctx = context
  await load()

  const tool = (name, fn) => ctx.tools.handle(name, fn)
  const rpc = (name, fn) => ctx.rpc.handle(name, fn)

  tool('server_list', async (p) => {
    if (p && p.refresh === true && state.servers.length) {
      const skipped = await probeMany(state.servers.slice())
      const view = { servers: state.servers.map(toolViewOf), counts: counts() }
      return skipped > 0 ? { ...view, budgetExceeded: skipped } : view
    }
    return { servers: state.servers.map(toolViewOf), counts: counts() }
  })

  tool('server_probe', async (p) => {
    const one = resolveTarget(p && p.target)
    if (one) {
      await probeWith(spawnRunner, one)
      await save()
      return { servers: [toolViewOf(one)] }
    }
    if (!state.servers.length) return { servers: [] }
    const skipped = await probeMany(state.servers.slice())
    const view = { servers: state.servers.map(toolViewOf) }
    return skipped > 0 ? { ...view, budgetExceeded: skipped } : view
  })

  tool('server_add', async (p) => ({ server: toolViewOf(await addServer(p || {})) }))
  tool('server_update', async (p) => ({ server: toolViewOf(await updateServer(p || {})) }))
  tool('server_remove', (p) => removeServer(p || {}))

  rpc('meta', () => ({ counts: counts() }))
  rpc('server.list', () => listView())
  rpc('server.add', async (p) => ({ server: viewOf(await addServer(p || {})) }))
  rpc('server.update', async (p) => ({ server: viewOf(await updateServer(p || {})) }))
  rpc('server.remove', (p) => removeServer(p || {}))
  rpc('server.probe', (p) => probeServer(p || {}))
  rpc('ssh.scan', () => sshScanView())
  rpc('ssh.import', (p) => importSshServers(p || {}))
  rpc('server.roots.list', () => listRoots())
  rpc('server.roots.set', (p) => setRoot(p || {}))
  rpc('server.roots.remove', (p) => removeRoot(p || {}))
  rpc('server.dirs', (p) => listDirs(p || {}))
  rpc('server.experiments', (p) => listExperiments(p || {}))
  rpc('server.history', (p) => listHistory(p || {}))
  rpc('server.progress', (p) => logProgress(p || {}))
  rpc('server.files', (p) => listFiles(p || {}))
  rpc('server.read_text', (p) => readText(p || {}))
  rpc('server.log_tail', (p) => logTail(p || {}))
  rpc('server.metrics', (p) => readMetrics(p || {}))

  ctx.log('info', `服务器看板就绪：${state.servers.length} 台机器（探针超时 ${PROBE_TIMEOUT_MS / 1000}s）`)
}

module.exports = {
  activate,
  probeWith,
  runWorkspaceWith,
  spawnRunner,
  WORKSPACE_MAX_OUTPUT,
  WORKSPACE_MAX_STDERR,
  READ_MAX_BYTES,
  buildProbeArgs,
  parseReport,
  explainFailure,
  scanSshConfig,
  parseSshEntries,
  normalizeRemoteRoot,
  resolveRemotePath,
  normalizeBrowsePath,
  parseFileListing,
  parseDirListing,
  parseExperiments,
  parseGpu,
  parseGpuError,
  parseProgress,
  commandName,
  epochsFromCommand,
  buildExperimentScript,
  buildHistoryScript,
  parseHistory,
  parseMetricLine,
  buildLineage,
  buildRootCheckScript,
  buildDirsScript,
  buildFilesScript,
  buildReadScript,
  buildProgressScript,
  buildMetricsScript,
}
