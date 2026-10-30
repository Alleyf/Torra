/**
 * ACP agent 注册表：Torra 能驱动哪些编码智能体，各自怎么起、先装什么、登录怎么走。
 *
 * 为什么要有这张表：接入一家 agent 要知道的东西是固定的四样 —— 启动命令、
 * 适配器包、登录方式、已知的坑。把它们写成代码而不是让用户每次现填，
 * 是因为「一键」的成败全在预检这一步：命令拼错、包没装、没登录，
 * 三件事各有一句人话，而这三句人话在表里。
 *
 * 版本钉死是刻意的：适配器包跟着上游走，用户本机随时可能 `npm update`
 * 到别的版本 —— 协议层能不能通，要靠「这一家 + 这个版本」这张矩阵来保证，
 * 而不是靠「ACP 是标准」这句话。矩阵在 scripts/test-acp.ts。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AcpAgentEntry } from '../../shared/acp'

/** 内置的四家。命令一律走 npx（适配器包），opencode 自带入口 */
export const BUILTIN_ACP_AGENTS: AcpAgentEntry[] = [
  {
    id: 'claude',
    title: 'Claude Code',
    blurb: 'Anthropic 的编码智能体，经官方 ACP 适配器接入',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.99.1'],
    package: { name: '@agentclientprotocol/claude-agent-acp', version: '0.99.1' },
    authHint: '适配器直接读你本机已有的 Claude Code 登录态与设置；没登录过就先在终端里登录一次',
    notes: [
      'Torra 里显示为「Claude Code」，但界面与文案不会自称 Anthropic 产品 —— 品牌条款要求如此',
      '它自带权限模式（Manual / Plan / Accept edits / Auto / Bypass），Torra 默认不提供最后一档',
    ],
    source: 'builtin',
  },
  {
    id: 'codex',
    title: 'Codex',
    blurb: 'OpenAI 的编码智能体，经官方 ACP 适配器接入',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@2.5.0'],
    package: { name: '@agentclientprotocol/codex-acp', version: '2.5.0' },
    authHint: '协议给了两种登录方式：ChatGPT 账号或 API Key',
    notes: [
      '它的 mode 是沙箱档位（只读 / 工作区可写 / 自动审查 / 完全放开），与权限不是一回事',
      '「完全放开」这一档 Torra 不提供 —— 等于把整台机器交给 agent',
    ],
    source: 'builtin',
  },
  {
    id: 'pi',
    title: 'pi',
    blurb: 'pi 编码智能体，经社区 ACP 适配器接入',
    command: 'npx',
    args: ['-y', 'pi-acp@0.0.34'],
    package: { name: 'pi-acp', version: '0.0.34' },
    authHint: '协议给的方式是「在终端里启动一次 pi 完成登录」',
    notes: [
      '它的 mode 是思考档（low / high / xhigh / max），不是权限档 —— 界面照数据渲染，不替它解释',
      '这一家拿不到 Torra 的工具包，卡住的是适配器不是 pi：pi-acp 声明的能力里没有 http/sse 形态的 MCP，' +
        '而且它把会话里给的 mcpServers 声明整个丢掉了（读过它的 dist/index.js：声明收下了，转发给 pi 时没带上）。' +
        'pi 自己两种形态都支持 —— 所以这是适配器版本的问题，换一版 pi-acp 可能就通了',
      '这一家没有会话恢复能力：它的 capabilities 里只有 list 与 delete',
    ],
    source: 'builtin',
  },
  {
    id: 'opencode',
    title: 'OpenCode',
    blurb: '开源编码智能体，自带 ACP 入口',
    command: 'opencode',
    args: ['acp'],
    authHint: '协议给的方式是「在终端里执行 opencode auth login」',
    notes: [
      '原生说 ACP，不需要适配器；其余四家都是靠适配器',
      '它没有 modes 字段，只在 configOptions 里给一个 mode',
    ],
    source: 'builtin',
  },
]

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
/** Windows 下要经 cmd.exe 起进程，参数里出现这些字符会被解释成命令连接符 */
const UNSAFE_ARG_RE = /["&|<>^%!]/

export interface AcpRegistryOverride {
  id: string
  title: string
  blurb: string
  command: string
  args: string[]
  package?: { name: string; version: string }
  authHint?: string
  notes: string[]
}

/**
 * 校验一条用户自定义条目。
 * 为什么要这么严：这些字符串会被拼进一条命令行。参数里带 & 或 | 就能在
 * 用户机器上多跑一条命令 —— 这不是「不友好」，是安全洞。
 */
export function validateOverride(raw: unknown): { ok: true; entry: AcpRegistryOverride } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '条目不是一个对象' }
  const o = raw as Record<string, unknown>
  const id = String(o.id ?? '').trim()
  if (!ID_RE.test(id)) return { ok: false, reason: `id「${id}」不合法：只允许小写字母、数字、连字符` }
  const command = String(o.command ?? '').trim()
  if (!command || command.length > 200) return { ok: false, reason: 'command 不能为空且不超过 200 字符' }
  if (/["&|<>^%!]/.test(command)) return { ok: false, reason: 'command 里含有 shell 特殊字符' }
  const argsRaw = Array.isArray(o.args) ? o.args : []
  if (argsRaw.length > 16) return { ok: false, reason: 'args 最多 16 项' }
  const args: string[] = []
  for (const a of argsRaw) {
    const s = String(a)
    if (s.length > 200) return { ok: false, reason: '单个参数不超过 200 字符' }
    if (UNSAFE_ARG_RE.test(s)) return { ok: false, reason: `参数「${s}」含有 shell 特殊字符` }
    args.push(s)
  }
  const title = o.title === undefined ? undefined : String(o.title).slice(0, 60)
  const blurb = o.blurb === undefined ? undefined : String(o.blurb).slice(0, 200)
  const authHint = o.authHint === undefined ? undefined : String(o.authHint).slice(0, 200)
  const notes = Array.isArray(o.notes) ? o.notes.slice(0, 8).map((n) => String(n).slice(0, 200)) : []
  const pkgRaw = o.package
  let pkg: { name: string; version: string } | undefined
  if (pkgRaw && typeof pkgRaw === 'object') {
    const p = pkgRaw as Record<string, unknown>
    const name = String(p.name ?? '').trim()
    const version = String(p.version ?? '').trim()
    if (!/^(@[^/]+\/)?[a-z0-9._-]{1,64}$/i.test(name)) return { ok: false, reason: '包名不合法' }
    if (!/^[0-9][0-9A-Za-z.\-+]{0,40}$/.test(version)) return { ok: false, reason: '版本号不合法' }
    pkg = { name, version }
  }
  return {
    ok: true,
    entry: {
      id,
      title: title || id,
      blurb: blurb || '用户自定义的 ACP agent',
      command,
      args,
      package: pkg,
      authHint,
      notes,
    },
  }
}

/**
 * 读用户自定义条目。
 *
 * 放 `<userData>/torra/acp.json`，格式照 Windsurf / Devin 的 registry.json：
 * `{"agents":[{...}]}`。用户同 id 的条目会盖掉内置那一条 —— 这样既能改内置
 * 家的启动方式（比如指向本机已经装好的适配器），也能加全新的一家。
 */
export function readOverrides(userDataDir: string): { entries: AcpAgentEntry[]; problems: string[] } {
  const file = path.join(userDataDir, 'torra', 'acp.json')
  const problems: string[] = []
  const entries: AcpAgentEntry[] = []
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { entries, problems }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { entries, problems: [`${file} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`] }
  }
  const list = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).agents : null
  if (!Array.isArray(list)) return { entries, problems: [`${file} 里没有 agents 数组`] }
  list.forEach((raw, i) => {
    const v = validateOverride(raw)
    if (!v.ok) {
      problems.push(`第 ${i + 1} 条：${v.reason}`)
      return
    }
    entries.push({ ...v.entry, source: 'user' })
  })
  return { entries, problems }
}

/** 内置 + 用户覆盖（用户同 id 覆盖内置） */
export function listAgents(userDataDir: string): { entries: AcpAgentEntry[]; problems: string[] } {
  const { entries: user, problems } = readOverrides(userDataDir)
  const map = new Map<string, AcpAgentEntry>()
  for (const e of BUILTIN_ACP_AGENTS) map.set(e.id, e)
  for (const e of user) map.set(e.id, e)
  return { entries: [...map.values()], problems }
}

/** 按 id 取一家；取不到返回 undefined（调用方要自己写清楚「没有这一家」） */
export function findAgent(userDataDir: string, id: string): AcpAgentEntry | undefined {
  return listAgents(userDataDir).entries.find((e) => e.id === id)
}

/** 用户自定义条目落在哪儿 —— 界面上要告诉用户「自己改这个文件也行」 */
export function overridesPath(userDataDir: string): string {
  return path.join(userDataDir, 'torra', 'acp.json')
}

/**
 * 写一条用户自定义条目。
 *
 * 写之前先过一遍校验 —— 这些字符串会被拼进一条命令行，
 * 界面上的输入框不能成为绕过校验的口子。
 *
 * 已经有一条同 id 的就整条换掉，不做字段级合并：合并出来的条目
 * 有一半是旧值，用户看着会以为是自己刚填的那份。
 */
export function saveOverride(
  userDataDir: string,
  raw: unknown,
): { ok: true; entry: AcpAgentEntry } | { ok: false; reason: string } {
  const v = validateOverride(raw)
  if (!v.ok) return { ok: false, reason: v.reason }
  const file = overridesPath(userDataDir)
  const list = readUserList(userDataDir)
  const next = list.filter((item) => String((item as Record<string, unknown>).id ?? '') !== v.entry.id)
  next.push(v.entry)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ agents: next }, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, entry: { ...v.entry, source: 'user' } }
}

/** 删掉一条用户自定义条目；内置那几条删不掉 —— 删了用户就少一家可接 */
export function removeOverride(
  userDataDir: string,
  id: string,
): { ok: true } | { ok: false; reason: string } {
  const list = readUserList(userDataDir)
  const next = list.filter((item) => String((item as Record<string, unknown>).id ?? '') !== id)
  if (next.length === list.length) return { ok: true }
  try {
    const file = overridesPath(userDataDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ agents: next }, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true }
}

/**
 * 读文件里那一串原始条目（不校验）。
 *
 * 校验过的版本是 listAgents 的事；这里要的是「用户原来写了什么」，
 * 写回的时候才能保留他自己那些字段。
 */
function readUserList(userDataDir: string): unknown[] {
  const file = overridesPath(userDataDir)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(text) as { agents?: unknown }
    return Array.isArray(parsed.agents) ? parsed.agents : []
  } catch {
    return []
  }
}
