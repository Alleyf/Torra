/**
 * 能力宿主：Torra 自己注入的一个内联 pi 扩展。两件事 —— 给 read 关闸、把声明式清单注册成工具。
 *
 * 为什么需要它：pi 只在活跃工具集里含 read 时才把 <available_skills> 拼进系统提示词
 * （core/system-prompt.js 的 customPromptHasRead 分支）。助手的白名单里没有 read，
 * 于是技能管理导入的 SKILL.md 会出现在设置页的「已加载」列表里，模型却一个字都看不到
 * —— 一个不报错的哑火。要让它可见就得给 read，给了 read 就得有关闸的地方。
 *
 * 三条实测约束，决定了下面为什么长这样：
 *
 * 1. **闸门只能挂在扩展上**。pi 的 tool_call 事件在执行前触发，返回 { block, reason }
 *    即阻止执行（core/extensions/types.d.ts 的 ToolCallEventResult），这是唯一能拦住
 *    内置工具的入口 —— 内置 read 的实现我们改不动。
 * 2. **判定必须走词法包含，不能 realpath**。导入的技能是指向 ~/.claude/skills 之类的
 *    软链接，realpath 一出技能目录就全被拦了，等于把功能关掉。代价说清楚：
 *    链接指向哪儿，read 就能读到哪儿；而那条链接是用户自己在设置页点的导入。
 * 3. **pi 的 project_trust 在这条路径上不生效**（resolveProjectTrusted 只被 CLI 入口
 *    调用，SettingsManager 默认 projectTrusted=true），所以别指望 SDK 自带信任机制，
 *    这里就是唯一的一道防线。
 *
 * 插件注册的另一半约束在白名单上：pi 的 _refreshToolRegistry 会把不在 allowedToolNames
 * 里的扩展工具整个滤掉，所以运行时 pi.registerTool 加不进新名字。插件必须在
 * loader.reload() 这一步注册完，session 组装时才能把名字补进白名单 —— 换句话说，
 * 改清单必然要重组会话，界面上那句「下一次对话生效」是唯一的真话。
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import { clampMemoryTopK } from '../../shared/memory'
import type { ApprovalRequest } from './tools'
import {
  loadPluginManifests,
  loadJsTool,
  compileParameters,
  interpolate,
  runPlugin,
  toPluginView,
  type InvalidPlugin,
  type MemoryQuery,
  type PluginManifest,
  type PluginView,
} from './plugins'

export type ReadVerdict = { ok: true } | { ok: false; reason: string }

/** Windows 上大小写不敏感，两边统一后再比，别让 C:\Skills 和 C:\skills 各算一个目录 */
function key(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** target 是否落在 root 内部（含 root 本身）；用 relative 而不是 startsWith，避免 skills-evil 命中 skills */
function within(root: string, target: string): boolean {
  const rel = path.relative(key(root), key(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * read 能不能读这个路径。
 *
 * 相对路径按 cwd 解析 —— 必须和 pi 自己的解析基准一致（内置 read 用的是
 * resolveReadPathAsync(path, cwd)），否则会出现「模型看到的 location 和闸门算出来的
 * 落点不是同一个文件」。
 */
export function checkReadablePath(roots: string[], cwd: string, raw: unknown): ReadVerdict {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'read 缺少 path 参数' }
  }
  if (raw.includes('\0')) {
    return { ok: false, reason: '路径含非法字符' }
  }
  const target = path.resolve(cwd, raw)
  if (roots.some((r) => within(r, target))) return { ok: true }
  return {
    ok: false,
    // 白名单现在有两类来路：技能目录（开扩展）和人亲手授权的目录。
    // 把两类都列出来，模型才知道「换一条路径」有没有意义，而不是原地重试。
    reason: `read 只能读技能目录或人授权的目录（${roots.join('、')}），「${raw}」不在其中`,
  }
}

/** 确认卡片上的内容预览上限：路径和规模足够让人判断，又不把整个文件送进渲染层 */
const PREVIEW_MAX = 1200

function preview(text: string, max = PREVIEW_MAX): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

/** 模型常把路径写成 @foo、file:///... 或 ~/foo；写入闸门接受这些写法，但必须先还原成真实路径 */
function expandRawPath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('@')) p = p.slice(1)
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p)
    } catch {
      // 让后面的解析给出统一的非法路径错误
    }
  }
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * 把「可能还不存在」的目标路径解析成真实路径。
 *
 * 已存在的那一段必须 realpath，否则 `work/link -> /etc` 这样的软链接会让词法包含
 * 看起来一切正常，实际写入却跑到目录外面。尾部不存在的部分按字面拼接，因为
 * write 的父目录可能正是这一步要新建的。
 */
function realTargetPath(target: string): string {
  let cursor = target
  const tail: string[] = []
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    tail.unshift(path.basename(cursor))
    cursor = parent
  }
  let base = cursor
  try {
    base = fs.realpathSync.native(cursor)
  } catch {
    base = path.resolve(cursor)
  }
  return path.join(base, ...tail)
}

function invalidPathReason(raw: unknown, tool: 'write' | 'edit'): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return `${tool} 缺少 path 参数`
  if (raw.includes('\0')) return '路径含非法字符'
  return undefined
}

function resolveWritableTarget(
  roots: string[],
  cwd: string,
  raw: string,
): { ok: true; target: string } | { ok: false; reason: string } {
  const expanded = expandRawPath(raw)
  const target = path.resolve(cwd, expanded)
  const lexicalRoot = roots.find((r) => within(r, target))
  if (!lexicalRoot) {
    return {
      ok: false,
      reason: `写入只能发生在当前工作目录（${roots.join('、')}），「${raw}」不在其中`,
    }
  }
  if (samePath(lexicalRoot, target)) {
    return { ok: false, reason: '目标是目录本身，write/edit 只能写具体文件' }
  }
  const realRoot = realTargetPath(lexicalRoot)
  const real = realTargetPath(target)
  if (!within(realRoot, real)) {
    return { ok: false, reason: '目标路径经软链接解析后越出了当前工作目录，已拒绝' }
  }
  return { ok: true, target: real }
}

function samePath(a: string, b: string): boolean {
  return key(a) === key(b)
}

interface ParsedEdit {
  edits: Array<{ oldText: string; newText: string }>
}

/** 兼容 SDK 支持的数组、JSON 字符串和 legacy oldText/newText 三种写法，校验在审批前完成 */
function parseEdits(input: Record<string, unknown>): ParsedEdit | string {
  let raw = input.edits
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return 'edits 不是合法的 JSON 数组'
    }
  }
  let edits: unknown[] = Array.isArray(raw) ? raw : []
  if (
    edits.length === 0 &&
    typeof input.oldText === 'string' &&
    typeof input.newText === 'string'
  ) {
    edits = [{ oldText: input.oldText, newText: input.newText }]
  }
  if (edits.length === 0) return 'edit 至少需要一段 edits'
  const parsed: Array<{ oldText: string; newText: string }> = []
  for (const [i, item] of edits.entries()) {
    const e = item as { oldText?: unknown; newText?: unknown }
    if (typeof e?.oldText !== 'string' || typeof e?.newText !== 'string') {
      return `edits[${i}] 必须同时包含 oldText 和 newText 字符串`
    }
    if (!e.oldText) return `edits[${i}].oldText 不能为空`
    parsed.push({ oldText: e.oldText, newText: e.newText })
  }
  return { edits: parsed }
}

function verificationForWrite(
  roots: string[],
  cwd: string,
  input: Record<string, unknown>,
): { ok: true; target: string; content: string } | { ok: false; reason: string } {
  const invalid = invalidPathReason(input.path, 'write')
  if (invalid) return { ok: false, reason: invalid }
  if (typeof input.content !== 'string') return { ok: false, reason: 'write 缺少 content 字符串参数' }
  const target = resolveWritableTarget(roots, cwd, input.path as string)
  if (!target.ok) return target
  const st = fs.statSync(target.target, { throwIfNoEntry: false })
  if (st?.isDirectory()) return { ok: false, reason: '目标是一个目录，不能当作文件覆盖' }
  return { ok: true, target: target.target, content: input.content }
}

function verificationForEdit(
  roots: string[],
  cwd: string,
  input: Record<string, unknown>,
): { ok: true; target: string; edits: ParsedEdit['edits'] } | { ok: false; reason: string } {
  const invalid = invalidPathReason(input.path, 'edit')
  if (invalid) return { ok: false, reason: invalid }
  const parsed = parseEdits(input)
  if (typeof parsed === 'string') return { ok: false, reason: parsed }
  const target = resolveWritableTarget(roots, cwd, input.path as string)
  if (!target.ok) return target
  const st = fs.statSync(target.target, { throwIfNoEntry: false })
  if (!st) return { ok: false, reason: `edit 的目标文件不存在：${target.target}` }
  if (!st.isFile()) return { ok: false, reason: 'edit 的目标不是普通文件' }
  return { ok: true, target: target.target, edits: parsed.edits }
}

/** 写操作确认卡片：写完整路径、规模和有限预览；拒绝时直接返回 block，不执行 SDK 工具 */
async function approveWrite(
  opts: CapabilityHostOptions,
  input: Record<string, unknown>,
): Promise<{ block: true; reason: string } | undefined> {
  const root = opts.writeRoots ?? []
  const cwd = opts.writeCwd ?? opts.cwd
  if (root.length === 0) {
    return { block: true, reason: '当前没有可写的工作目录。请用户先在 / 浮层里选择工作目录。' }
  }
  const checked = verificationForWrite(root, cwd, input)
  if (!checked.ok) return { block: true, reason: checked.reason }
  const exists = fs.existsSync(checked.target)
  const bytes = Buffer.byteLength(checked.content, 'utf8')
  const lines = checked.content === '' ? 0 : checked.content.split(/\r?\n/).length
  const decision = await opts.approve({
    action: 'write_file',
    title: `${exists ? '覆盖文件' : '创建文件'} ${path.basename(checked.target)}`,
    detail: [
      `路径：${checked.target}`,
      `方式：${exists ? '完整覆盖现有文件' : '新建文件（父目录不存在时自动创建）'}`,
      `规模：${bytes} 字节，${lines} 行`,
      '',
      '内容预览：',
      preview(checked.content),
    ].join('\n'),
    risk: '这会真实改动磁盘上的文件。拒绝即不写入任何内容。',
  })
  return decision.approved
    ? undefined
    : { block: true, reason: `用户拒绝写入文件${decision.reason ? `：${decision.reason}` : ''}` }
}

async function approveEdit(
  opts: CapabilityHostOptions,
  input: Record<string, unknown>,
): Promise<{ block: true; reason: string } | undefined> {
  const root = opts.writeRoots ?? []
  const cwd = opts.writeCwd ?? opts.cwd
  if (root.length === 0) {
    return { block: true, reason: '当前没有可写的工作目录。请用户先在 / 浮层里选择工作目录。' }
  }
  const checked = verificationForEdit(root, cwd, input)
  if (!checked.ok) return { block: true, reason: checked.reason }
  const perEdit = Math.max(120, Math.floor(PREVIEW_MAX / Math.max(1, checked.edits.length)))
  const detail = checked.edits
    .map(
      (e, i) =>
        `第 ${i + 1} 段旧文本：\n${preview(e.oldText, perEdit)}\n第 ${i + 1} 段新文本：\n${preview(e.newText, perEdit)}`,
    )
    .join('\n\n')
  const decision = await opts.approve({
    action: 'edit_file',
    title: `修改文件 ${path.basename(checked.target)}`,
    detail: [`路径：${checked.target}`, `替换段数：${checked.edits.length}`, '', detail].join('\n'),
    risk: '这会真实改动磁盘上的文件；每段旧文本必须与原文精确匹配。拒绝即不修改。',
  })
  return decision.approved
    ? undefined
    : { block: true, reason: `用户拒绝修改文件${decision.reason ? `：${decision.reason}` : ''}` }
}

export interface CapabilityHostOptions {
  /** read 允许读的目录集合 */
  readRoots: string[]
  /** 相对路径的解析基准，和 pi 的 cwd 保持一致 */
  cwd: string
  /** write/edit 允许写的目录集合；空表示当前没有写权限 */
  writeRoots?: string[]
  /** write/edit 相对路径的解析基准；缺省沿用 cwd */
  writeCwd?: string
  /** 声明式插件清单目录；不传就不注册任何插件 */
  pluginsDir?: string
  /** kind=memory 的插件靠它检索本地记忆库；不传则这类插件调用时明确报错 */
  memory?: MemoryQuery
  /** 确认卡片：写操作和 confirm=always/once 的插件都走它 */
  approve: (req: ApprovalRequest) => Promise<{ approved: boolean; reason?: string }>
  /** 钥匙串取值：清单里写 {{secrets:REF}}，值只在调用的这一瞬间存在 */
  secrets: (ref: string) => string | null
  /** 加载结果回传给 session 层，设置页要靠它列出插件和坏清单 */
  onPlugins?: (plugins: PluginView[], invalid: InvalidPlugin[]) => void
  log?: (text: string) => void
}

/**
 * 卡片上给人看的「这一跑会去哪儿」。
 *
 * 模板套上模型填的实参，但 {{secrets:...}} 只换成引用名 —— 用户要点开才能判断
 * 「这个 Key 会被发到哪个域名」，而把值印在卡片上等于把它交给了渲染层和日志。
 */
function targetSummary(m: PluginManifest, params: Record<string, unknown>): string {
  const redacted = (ref: string) => `‹钥匙串 ${ref}›`
  if (m.kind === 'http') {
    const h = m.http!
    const url = interpolate(h.url, params, redacted).text
    const body = h.body === undefined ? '' : `\n请求体：${interpolate(h.body, params, redacted).text}`
    return `${h.method} ${url}${body}`
  }
  if (m.kind === 'memory') {
    const impl = m.memory!
    const query = typeof params.query === 'string' ? params.query : ''
    const topK = clampMemoryTopK(params.topK, impl.topK)
    return `检索记忆库 ${impl.file}（${impl.mode}，前 ${topK} 条）：${query}`
  }
  if (m.kind === 'js') {
    // 脚本卡片要让人知道「跑的是哪份文件」；源码本身在启用审查时看过一遍
    return `执行本地脚本：${m.codeFile ?? '(源码缺失)'}（${m.lines ?? '?'} 行）`
  }
  const argv = m.shell!.argv.map((a) => interpolate(a, params, redacted).text)
  return `执行：${JSON.stringify(argv)}`
}

/** 清单 → pi 的工具定义。解释器只有 runPlugin 这一个入口 */
async function toToolDefinition(m: PluginManifest, opts: CapabilityHostOptions, approvedOnce: Set<string>) {
  const parameters = (await compileParameters(m.parameters)) as Record<string, unknown>
  return {
    name: m.name,
    label: m.label,
    description: m.description,
    parameters,
    async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined) {
      const needsAsk = m.confirm === 'always' || (m.confirm === 'once' && !approvedOnce.has(m.name))
      if (needsAsk) {
        const decision = await opts.approve({
          action: 'run_plugin',
          title: `运行工具 ${m.label}`,
          detail: `${targetSummary(m, params)}\n入参：${JSON.stringify(params)}\n清单：${m.file}`,
          risk:
            m.kind === 'shell'
              ? '这个插件会在本机执行外部程序，参数来自模型的回答；拒绝即不做任何事。'
              : m.kind === 'js'
                ? '这个插件会在主进程里执行本地脚本。脚本体在启用前已由人审过，但参数来自模型的回答；拒绝即不执行。'
                : m.kind === 'memory'
                  ? '这个插件会检索本地记忆库；语义模式下查询文本会发给你在设置页配置的嵌入端点（库内容不出去）。'
                  : '这个插件会向上面那个地址发出请求，参数来自模型的回答。',
        })
        if (!decision.approved) {
          return {
            content: [{ type: 'text' as const, text: `用户拒绝运行工具「${m.name}」${decision.reason ? `：${decision.reason}` : ''}` }],
            details: { approved: false },
          }
        }
        approvedOnce.add(m.name)
      }
      const r = await runPlugin(m, params, {
        cwd: opts.cwd,
        secrets: opts.secrets,
        signal,
        ...(opts.memory ? { memory: opts.memory } : {}),
      })
      return { content: [{ type: 'text' as const, text: r.text }], details: { approved: true, ...r.details } }
    },
  }
}

/**
 * 造宿主扩展。
 *
 * 开关关着时也照样装上 —— 那时 read 不在白名单里，钩子内不会命中，
 * 但「闸门只在开关打开时才存在」本身就是一种脆弱。
 */
export function capabilityHost(opts: CapabilityHostOptions): InlineExtension {
  return {
    name: 'torra-capability-host',
    factory: (pi: ExtensionAPI) => {
      pi.on('tool_call', async (event) => {
        if (event.toolName === 'read') {
          const verdict = checkReadablePath(opts.readRoots, opts.cwd, (event.input as { path?: unknown }).path)
          return verdict.ok ? undefined : { block: true, reason: verdict.reason }
        }
        if (event.toolName === 'write') {
          return approveWrite(opts, (event.input ?? {}) as Record<string, unknown>)
        }
        if (event.toolName === 'edit') {
          return approveEdit(opts, (event.input ?? {}) as Record<string, unknown>)
        }
        return undefined
      })
      const approvedOnce = new Set<string>()
      const { manifests, invalid } = opts.pluginsDir
        ? loadPluginManifests(opts.pluginsDir)
        : { manifests: [], invalid: [] as InvalidPlugin[] }
      return (async () => {
        const registered: PluginManifest[] = []
        for (const m of manifests) {
          try {
            // kind=js 在装配时就 require 一遍：语法错、导出不对当场变成 invalid，
            // 而不是设置页显示「已加载」、模型一调才发现是坏脚本。
            // 顶层代码会跑 —— 脚本被人审查过并点了启用，这一层已经算授权过了。
            if (m.kind === 'js') loadJsTool(m)
            pi.registerTool(await toToolDefinition(m, opts, approvedOnce) as never)
            registered.push(m)
          } catch (e) {
            // 编译不过的清单要留痕：静默少注册一个工具，比设置页多一行红字难查得多
            invalid.push({ ok: false, name: m.name, file: m.file, errors: [`注册失败：${(e as Error).message}`] })
          }
        }
        // 只报注册成功的：设置页上「已加载」却调不到工具，是最难查的一种不一致
        opts.onPlugins?.(registered.map((m) => toPluginView(m, true)), invalid)
        opts.log?.(`宿主加载：${registered.length} 个插件，${invalid.length} 条无效清单`)
      })()
    },
  }
}
