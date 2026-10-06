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
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { ApprovalRequest } from './tools'
import {
  loadPluginManifests,
  compileParameters,
  interpolate,
  runPlugin,
  toPluginView,
  type InvalidPlugin,
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

export interface CapabilityHostOptions {
  /** read 允许读的目录集合 */
  readRoots: string[]
  /** 相对路径的解析基准，和 pi 的 cwd 保持一致 */
  cwd: string
  /** 声明式插件清单目录；不传就不注册任何插件 */
  pluginsDir?: string
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
          title: `运行插件 ${m.label}`,
          detail: `${targetSummary(m, params)}\n入参：${JSON.stringify(params)}\n清单：${m.file}`,
          risk:
            m.kind === 'shell'
              ? '这个插件会在本机执行外部程序，参数来自模型的回答；拒绝即不做任何事。'
              : '这个插件会向上面那个地址发出请求，参数来自模型的回答。',
        })
        if (!decision.approved) {
          return {
            content: [{ type: 'text' as const, text: `用户拒绝运行插件「${m.name}」${decision.reason ? `：${decision.reason}` : ''}` }],
            details: { approved: false },
          }
        }
        approvedOnce.add(m.name)
      }
      const r = await runPlugin(m, params, { cwd: opts.cwd, secrets: opts.secrets, signal })
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
        if (event.toolName !== 'read') return undefined
        const verdict = checkReadablePath(opts.readRoots, opts.cwd, (event.input as { path?: unknown }).path)
        return verdict.ok ? undefined : { block: true, reason: verdict.reason }
      })
      const approvedOnce = new Set<string>()
      const { manifests, invalid } = opts.pluginsDir
        ? loadPluginManifests(opts.pluginsDir)
        : { manifests: [], invalid: [] as InvalidPlugin[] }
      return (async () => {
        const registered: PluginManifest[] = []
        for (const m of manifests) {
          try {
            pi.registerTool(await toToolDefinition(m, opts, approvedOnce) as never)
            registered.push(m)
          } catch (e) {
            // 编译不过的清单要留痕：静默少注册一个工具，比设置页多一行红字难查得多
            invalid.push({ ok: false, name: m.name, file: m.file, errors: [`注册失败：${(e as Error).message}`] })
          }
        }
        // 只报注册成功的：设置页上「已加载」却调不到工具，是最难查的一种不一致
        opts.onPlugins?.(registered.map(toPluginView), invalid)
        opts.log?.(`宿主加载：${registered.length} 个插件，${invalid.length} 条无效清单`)
      })()
    },
  }
}
