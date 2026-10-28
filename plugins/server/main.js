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

const MAX_SERVERS = 50
const PROBE_TIMEOUT_MS = 10_000
const PROBE_CONCURRENCY = 5
/** 工具调用在宿主侧 30 秒超时：留 8 秒给 IPC 与序列化 */
const PROBE_BUDGET_MS = 22_000

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
let state = { servers: [] }

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
  checkTarget(server)
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'LogLevel=ERROR',
    '-p', String(server.port),
  ]
  if (server.keyPath) args.push('-i', server.keyPath)
  args.push(`${server.user}@${server.host}`, PROBE_SCRIPT)
  return args
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

/** ssh 的英文报错翻成人能动手的说法；翻不出来的保留最后一行，别只说「失败了」 */
function explainFailure(code, stderr) {
  const text = str(stderr)
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return '主机密钥变了：确认是不是重装过机器，再更新 known_hosts'
  if (/Host key verification failed/i.test(text)) return '主机密钥校验失败：先在终端手动 ssh 一次确认指纹'
  if (/Permission denied|no such identity/i.test(text)) return '认证失败：目标机不接受当前密钥（确认公钥在 authorized_keys 里，或先用 ssh-add 加进 agent）'
  if (/Could not resolve hostname/i.test(text)) return '主机名解析失败'
  if (/Connection refused/i.test(text)) return '连接被拒绝：端口不对，或 sshd 没在跑'
  if (/Connection timed out|Operation timed out|timed out/i.test(text)) return '连接超时'
  if (/No route to host/i.test(text)) return '网络不可达（No route to host）'
  const last = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()
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
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 200_000) child.kill()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 40_000) child.kill()
    })
    child.on('error', (error) => {
      finish(reject, error && error.code === 'ENOENT' ? new Error('找不到 ssh 命令（装 OpenSSH 客户端，或确认它在 PATH 里）') : error)
    })
    child.on('close', (code) => finish(resolve, { code: typeof code === 'number' ? code : -1, stdout, stderr }))
  })
}

/**
 * 探测一台机器。runner 是注入点：测试用假 runner 覆盖 ssh，生产走 spawnRunner。
 * 返回值同时写回 server.last —— 面板与工具看到的是同一份结果。
 */
async function probeWith(runner, server) {
  const started = Date.now()
  let result
  try {
    const out = await runner(buildProbeArgs(server), PROBE_TIMEOUT_MS)
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
}

async function load() {
  const raw = await ctx.storage.get('servers')
  const list = Array.isArray(raw) ? raw : []
  state.servers = list
    .filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.host === 'string')
    .slice(0, MAX_SERVERS)
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
  await save()
  return { removed: server.id }
}

async function probeServer(params) {
  const server = findServer(str(params.serverId))
  await probeWith(spawnRunner, server)
  await save()
  return { server: viewOf(server) }
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

  ctx.log('info', `服务器看板就绪：${state.servers.length} 台机器（探针超时 ${PROBE_TIMEOUT_MS / 1000}s）`)
}

module.exports = { activate, probeWith, spawnRunner, buildProbeArgs, parseReport, explainFailure, scanSshConfig, parseSshEntries }
