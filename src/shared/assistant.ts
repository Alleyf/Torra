/**
 * 助手 agent 的跨进程契约（主进程 / preload / 渲染层共用）。
 *
 * 放在 shared 的原因和 diagnostics.ts 一样：确认卡片、流式事件、历史条目
 * 这三样东西主进程在产生、渲染层在消费，字段一旦各写各的，
 * 表现就是「卡片少一个按钮」或「流式文字断在半句」这类不报错的错位。
 */

import type { DiagLayer } from './diagnostics'

/**
 * 需要用户确认的写操作种类。
 *
 * run_plugin 是声明式插件的执行：模型填的参数会进外部请求的 URL 或本机进程的命令行，
 * 所以「要不要跑」由人决定，而不是由清单作者或模型决定。
 */
export type AssistantAction =
  | 'save_adapter'
  | 'create_api_model'
  | 'create_web_model'
  | 'delete_model'
  | 'open_login'
  | 'drive_site'
  /** 真机试发言：往站点真发一条消息，和 drive_site 同样是对外可见的动作 */
  | 'test_web_model'
  | 'run_plugin'
  /** author_* / propose_extension 写的只是数据或待审文件；真正让它生效的是启用那一步 */
  | 'author_tool'
  | 'author_skill'
  | 'remove_plugin'
  | 'propose_extension'

/** 主进程 → 渲染层的确认卡片 */
export interface AssistantApprovalRequest {
  /** 由主进程在投递时生成，用于把用户的点击结果对回这次工具调用 */
  id: string
  action: AssistantAction
  title: string
  detail: string
  risk?: string
  /** 卡片里要放安全输入框收 API Key（Key 只回主进程，绝不回流给模型） */
  needsKey?: boolean
  modelId?: string
  /**
   * 自动批准的时刻（epoch ms）。只有「超时自动批准」模式会带上：
   * 到点由主进程结算，界面只负责把剩下的秒数显示出来 —— 两边都以主进程为准，
   * 卡片在队列里排队时也不会出现「界面还在数、那边已经放行」。
   */
  autoApproveAt?: number
}

/** 主进程 → 渲染层：某张确认卡片已经结算（人点的 / 到点的 / 被丢弃的） */
export interface AssistantApprovalResolved {
  id: string
  approved: boolean
  /** true 表示这一张不是人点的，是超时或模式自动结算的 */
  auto: boolean
  reason?: string
}

/**
 * 助手写操作的审批模式。
 *
 * 四种模式只差在「卡片要不要等人」，能做的动作范围一模一样：
 * - always_ask：卡片一直等，超过确认时限自动取消（默认）；
 * - auto_after_timeout：卡片倒计时若干秒，到点自动执行；期间点拒绝、按 Esc、
 *   关抽屉都照旧生效 —— 这是「不反对就放行」，不是「不问就做」；
 * - auto_all：不弹卡片直接执行，但每一步都在对话流里留一行可见记录；
 * - read_only：不弹卡片，写操作一律拒绝，助手只查不改。
 *
 * 无论哪种模式，需要人工输入 API Key 的卡片都不会自动批准：Key 只能由人给。
 */
export type AssistantApprovalMode = 'always_ask' | 'auto_after_timeout' | 'auto_all' | 'read_only'

export const APPROVAL_MODES: AssistantApprovalMode[] = ['always_ask', 'auto_after_timeout', 'auto_all', 'read_only']

/** 模式名要同时出现在设置页、助手头部徽标和切换结果里，所以收在共享层，别各写一份 */
export const APPROVAL_MODE_LABEL: Record<AssistantApprovalMode, string> = {
  always_ask: '每次询问',
  auto_after_timeout: '超时自动批准',
  auto_all: '全部自动批准',
  read_only: '只读（不改动）',
}

/** 自动批准倒计时的可设范围：太短等于没给反应时间，太长不如直接人工确认 */
export const APPROVE_TIMEOUT_MIN_MS = 3_000
export const APPROVE_TIMEOUT_MAX_MS = 120_000
export const APPROVE_TIMEOUT_DEFAULT_MS = 10_000

/** 给日志与结果提示用的一行式描述；界面上要展开说明的走设置页 */
export function describeApprovalPrefs(p: AssistantApprovalPrefs): string {
  const label = APPROVAL_MODE_LABEL[p.mode]
  return p.mode === 'auto_after_timeout' ? `${label} · ${Math.round(p.timeoutMs / 1000)} 秒` : label
}

/** 主进程持久化、渲染层读写的审批偏好 */
export interface AssistantApprovalPrefs {
  mode: AssistantApprovalMode
  /** 只有 auto_after_timeout 用；越界会被 clampApprovalTimeout 夹回范围 */
  timeoutMs: number
}

export const APPROVAL_PREFS_DEFAULT: AssistantApprovalPrefs = {
  mode: 'always_ask',
  timeoutMs: APPROVE_TIMEOUT_DEFAULT_MS,
}

export function isApprovalMode(v: unknown): v is AssistantApprovalMode {
  return typeof v === 'string' && (APPROVAL_MODES as string[]).includes(v)
}

/** 渲染层传来的数字一律夹取：偏好文件是外部输入，不能直接当定时器用 */
export function clampApprovalTimeout(ms: unknown): number {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : APPROVE_TIMEOUT_DEFAULT_MS
  return Math.min(APPROVE_TIMEOUT_MAX_MS, Math.max(APPROVE_TIMEOUT_MIN_MS, Math.round(n)))
}

/** 渲染层 → 主进程的确认结果 */
export interface AssistantApprovalDecision {
  approved: boolean
  apiKey?: string
  reason?: string
}

/**
 * 渲染层调用助手动作的统一返回。
 *
 * 两个字段是刻意分开的：reason 给使用者看（说清「怎么了 + 下一步去哪儿」），
 * detail 给排查的人看（原始报错，界面上收在「查看原始信息」里）。
 * 只留原文，用户看不懂；只留人话，开发者查不动。
 */
export interface AssistantResult {
  ok: boolean
  reason?: string
  detail?: string
}

/** 主进程 → 渲染层的流式事件 */
export type AssistantStreamEvent =
  | { kind: 'user'; text: string }
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool-start'; id: string; name: string; label: string; args: unknown; group: AssistantToolGroup }
  | { kind: 'tool-end'; id: string; name: string; ok: boolean; excerpt: string; group: AssistantToolGroup }
  | { kind: 'status'; text: string }
  /** text 是人话结论，detail 是模型/运行时原文 */
  | { kind: 'error'; text: string; detail?: string }
  /** 一轮跑完的账：耗时、TTFT、token、费用、步数。放在 settled 之前送达 */
  | { kind: 'turn-stats'; stats: AssistantTurnStats }
  /**
   * 运行模式快照。目标模式的自动续跑由主进程驱动，每轮都会先 settled 一次，
   * 渲染层不能靠「收到 settled」判断到底说完没有 —— 以这条的 running 为准。
   */
  | { kind: 'mode'; state: AssistantModeState }
  | { kind: 'settled' }

/**
 * 一步调用的来源分组。
 *
 * 界面上「工具 / 技能 / MCP」的用处不是好看：一条 `torra_run_doctor` 只改本机
 * 状态、一个技能或 MCP 工具却可能带外部副作用（技能自带脚本、MCP 连着外部系统），
 * 用户扫一眼就要能分辨这一步是谁提供的。
 */
export type AssistantToolGroup = 'tool' | 'skill' | 'mcp'

/** 一轮对话的统计。ttftMs 只有实时跑的轮次有，从磁盘恢复的历史拿不到首字时刻 */
export interface AssistantTurnStats {
  /** 展示用模型名 */
  model: string
  /** 从发出到本轮结束的墙钟耗时 */
  ms: number
  /** 首字延迟：第一个正文字符距发出去多久 */
  ttftMs?: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  /** 按模型定价算出的本轮花费（美元） */
  cost: number
  steps: number
  /** 各分组的步数，缺项按 0 看 */
  byGroup?: Partial<Record<AssistantToolGroup, number>>
  contextTokens?: number
  contextWindow?: number
}

/** 整场会话的累计统计 + 上下文占用 */
export interface AssistantSessionStats {
  sessionId: string
  sessionName?: string
  sessionFile?: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  totalMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  /** null 表示刚压缩完还没新回复，估不出来 */
  contextTokens: number | null
  contextWindow: number
  contextPercent: number | null
  /** 最近一轮的账，界面上用来解释「刚才那一下花了多少」 */
  lastTurn?: AssistantTurnStats
}

/** 历史会话列表的一项 */
export interface AssistantSessionView {
  id: string
  path: string
  name?: string
  created: number
  modified: number
  messageCount: number
  firstMessage: string
  /** 是否就是当前正在用的那场 */
  current: boolean
}

export interface AssistantHistoryItem {
  role: 'user' | 'assistant' | 'thinking' | 'tool'
  text: string
  toolName?: string
  group?: AssistantToolGroup
  ok?: boolean
  excerpt?: string
  /** 回合级统计，只挂在每轮最后一条正文上 */
  stats?: AssistantTurnStats
  /** 条目产生时刻（epoch ms），恢复历史时用来显示时间 */
  at?: number
}

export interface AssistantModelView {
  id: string
  displayName: string
  transport: 'api' | 'webview'
  enabled: boolean
  adapterId?: string
  baseUrl?: string
  apiModel?: string
  protocol?: 'openai' | 'anthropic'
  /** 只说明有没有配 Key，不返回 Key 的任何部分 */
  hasKey?: boolean
  /** 该模型能否接受图片输入：助手抽屉据此决定要不要放开图片附件/粘贴 */
  vision?: boolean
  status?: string
}

export interface AssistantPageFacts {
  ok: boolean
  url?: string
  title?: string
  loginState?: string
  loginReason?: string
  chatInputs?: number
  reason?: string
}

export interface AssistantSelectorFacts {
  ok: boolean
  matches?: number
  /** 命中集合里是否含着输入框：true 表示那是整页外壳，不能当回复容器 */
  covers?: boolean
  reason?: string
}

export interface AssistantAdapterView {
  id: string
  name: string
  origin: 'builtin' | 'user'
  entry: string
  health: string
  healthError?: string
  stale: boolean
  yaml: string
}

export interface AssistantApiProbeResult {
  ok: boolean
  status?: number
  modelCount?: number
  models?: string[]
  reason?: string
}

export interface AssistantLogFilter {
  layer?: DiagLayer
  subject?: string
  limit: number
}

/** 助手当前状态；渲染层用它决定「发消息」按钮与忙碌态 */
export interface AssistantStatus {
  /** pi 会话是否已经建好（首次发消息时才建） */
  ready: boolean
  modelId: string | null
  streaming: boolean
  /** 尚未就绪时的说明，不是错误 */
  reason?: string
}

/**
 * 一条声明式插件清单的展示视图（跨进程契约，主进程 plugins.ts 直接复用它）。
 *
 * 这里刻意不放 parameters / url / argv：设置页要的是「有这么个工具、它是谁、
 * 会不会问我」，具体清单细节点开文件看。把整条 JSON 传进渲染层等于多一条
 * 数据通路，而清单里可能写着 {{secrets:REF}} 这种指代。
 */
export interface AssistantPluginView {
  name: string
  label: string
  description: string
  kind: 'http' | 'shell'
  /** 每次运行前要不要弹确认卡片 */
  confirm: 'always' | 'once' | 'never'
  enabled: boolean
  file: string
}

/**
 * 助手的扩展能力现状：技能 / 扩展开关与已加载清单。
 *
 * 开关默认关：扩展是 JS 代码，跑在主进程里，绕开确认卡片那套闸门。
 * 打开后能用什么、从哪个文件来的，必须在这个结构里看得见，
 * 否则「助手突然会做某件事」就成了无法追溯的黑盒。
 *
 * plugins 不受这个开关影响：清单只是数据，执行时照样过确认卡片。
 */
export interface AssistantCapabilitiesView {
  extensionsEnabled: boolean
  /** 「允许助手自建工具」开关：关着时那五个工具连注册都没有 */
  selfAuthoringEnabled: boolean
  skills: Array<{ name: string; description?: string; path: string }>
  extensions: Array<{ name: string; tools: string[]; path: string }>
  /** 磁盘上读到的声明式插件（有效的都已注册为工具） */
  plugins: AssistantPluginView[]
  /** 加载失败的技能/扩展：不报错就会以为它们生效了 */
  errors: Array<{ path: string; error: string }>
  /** 开关开着但清单还是空时的解释（会话没建立前读不到盘上的加载结果） */
  note?: string
  /** 技能/扩展/插件的加载目录，开关打开后要往这里放文件 */
  dirs?: { skills: string; extensions: string; plugins: string }
}

// ---------------------------------------------------------------------------
// 技能管理：扫描别的 agent 应用的技能，软链接进 Torra
// ---------------------------------------------------------------------------

/**
 * 扫描结果里的一条技能。
 *
 * warnings 与 loadable 是分开的两件事：不符合 Agent Skills 命名规范的技能 pi 照样
 * 加载（只是模型可能调不动），缺 description 的才真的用不了。合成一个布尔的话，
 * 界面上就没法解释「为什么这条是灰的、那条只是标黄」。
 */
export interface DiscoveredSkill {
  /** 稳定标识 = 盘上的 SKILL.md（或单文件技能的那份 .md）路径 */
  key: string
  name: string
  description: string
  /** 技能主文件 */
  path: string
  /** 目录型技能的所在目录；单文件型没有 */
  baseDir?: string
  appId: string
  appDisplayName: string
  kind: 'dir' | 'file'
  loadable: boolean
  warnings: string[]
  imported: boolean
  /** 已导入时：Torra 技能目录里那个链接（或复制目录）的名字 */
  linkName?: string
  linkKind?: SkillLinkKind
}

/** 导入方式：junction 是 Windows 上唯一免特权可用的目录链接；复制只用于单文件技能 */
export type SkillLinkKind = 'junction' | 'symlink' | 'copy'

/** 一个来源应用（Claude Code / Codex / Qoder…）的扫描结果 */
export interface SkillAppView {
  id: string
  displayName: string
  /** 实际展开并扫描过的根目录 */
  roots: string[]
  /** 一个根目录都不存在：多半是本机没装这个应用 */
  missing: boolean
  skills: DiscoveredSkill[]
  /** 因为重名或同一份文件被多个入口指到而跳过的条数 */
  skipped: number
}

export interface SkillScanView {
  ok: boolean
  reason?: string
  detail?: string
  /** 技能来源的搜索根（用户主目录） */
  home: string
  /** 导入目标目录 */
  skillsDir: string
  apps: SkillAppView[]
  /** Torra 技能目录里指向已消失目标的链接：不清掉就一直占着名字 */
  dangling: Array<{ name: string; target: string }>
  total: number
  imported: number
  scannedAt: number
  /** 技能/扩展总开关：关着的话导入只是把链接放好，助手并不会加载 */
  extensionsEnabled?: boolean
}

export interface SkillImportResult extends AssistantResult {
  name?: string
  linkKind?: SkillLinkKind
}

// ---------------------------------------------------------------------------
// 自建能力：声明式插件与待审扩展
// ---------------------------------------------------------------------------

/** 插件目录的现状：直接读盘，所以会话还没装配过时也看得到 */
export interface PluginListView {
  dir: string
  plugins: AssistantPluginView[]
  /** 读不出来的清单：名字 + 文件 + 全部原因，不静默丢弃 */
  invalid: Array<{ name: string; file: string; errors: string[] }>
}

/**
 * 待审区里的一份 JS 扩展。
 *
 * preview 是源码的前若干行：审查的依据必须是代码本身，不是助手对它的描述。
 */
export interface PendingExtensionView {
  name: string
  file: string
  lines: number
  bytes: number
  preview: string
  truncated: boolean
}

// ---------------------------------------------------------------------------
// 运行模式：输入框打 / 唤醒的功能浮层
// ---------------------------------------------------------------------------

/**
 * 助手的三种运行模式。
 *
 * 之所以是「模式」而不是三条不同的按钮：它们改的是**同一场对话的推进方式**，
 * 而且都必须让主进程说了算 —— 界面上的徽标要是与主进程各算各的，
 * 就会出现「看着像目标模式，实际每轮都要人推」。
 */
export type AssistantRunMode = 'chat' | 'goal' | 'plan'

export const RUN_MODES: AssistantRunMode[] = ['chat', 'goal', 'plan']

export const RUN_MODE_LABEL: Record<AssistantRunMode, string> = {
  chat: '普通对话',
  goal: '目标模式',
  plan: '计划模式',
}

export function isRunMode(v: unknown): v is AssistantRunMode {
  return typeof v === 'string' && (RUN_MODES as string[]).includes(v)
}

/** 目标模式自动推进的轮数上限：没有上限的自主循环只是把失控变得昂贵 */
export const GOAL_MAX_ROUNDS = 8

/**
 * 自评标记由模型自己在回复末尾写。
 *
 * 不用「问模型完了没」的自然语言再判一次：那要多一次调用，而且它照样可能自说自话。
 * 固定标记让主进程能机械地认下来，认不到就停下来 —— 猜错的代价是白跑七轮。
 */
export const GOAL_DONE_MARK = '[GOAL:DONE]'
export const GOAL_CONTINUE_MARK = '[GOAL:CONTINUE]'

export type GoalVerdict = 'done' | 'continue' | 'none'

/** 只认回复末尾的标记：正文里举例提到标记，不该被当成这一轮的判定 */
export function parseGoalVerdict(text: string): GoalVerdict {
  const tail = String(text ?? '').slice(-400)
  if (tail.includes(GOAL_DONE_MARK)) return 'done'
  if (tail.includes(GOAL_CONTINUE_MARK)) return 'continue'
  return 'none'
}

/** 执行计划时带过去的计划文本上限：再长就不像计划，像把对话复制了一遍 */
export const PLAN_TEXT_MAX = 6000

/** 目标一句话的长度上限：超过这个数的通常是任务清单，不是目标 */
export const GOAL_TEXT_MAX = 2000

/** 目标模式的轮首指令。first=false 是自动续跑那一轮：没有用户原话，得自己交代上下文 */
export function goalRoundPrompt(
  goal: string,
  round: number,
  max: number,
  opts: { first: boolean; request?: string },
): string {
  const head = [
    `【目标模式】总目标：${String(goal ?? '').trim()}`,
    `这是为达成该目标自动推进的第 ${round}/${max} 轮。`,
    '自己判断还缺什么，直接动手补上；不要把问题抛回给我，也不要停下来等我确认。',
    `回复的最后一行只写一个标记：目标已经达成写 ${GOAL_DONE_MARK}；还需要继续写 ${GOAL_CONTINUE_MARK}。`,
  ]
  if (opts.first) {
    const req = String(opts.request ?? '').trim()
    return [...head, '', req ? `我的原话：\n${req}` : '（这条只给了目标，没有别的原话：按目标本身推进。）'].join('\n')
  }
  return [...head, '', '接着上一轮的进展继续，不要重做已经完成的事。'].join('\n')
}

/** 计划模式的轮首指令：只出计划，别动手 */
export function planRoundPrompt(request: string): string {
  return [
    '【计划模式】这一轮只做调研和规划，不执行任何改动。',
    '需要看文件就读，但任何写操作、外部调用、配置改动都不要做（系统会拒绝它们，重试也没有）。',
    '产出一份可执行的计划：目标、步骤（每步做什么、怎么验证）、风险与前置条件、需要我提供的东西。',
    '步骤要写到「照着做就能做」的程度，不要写成方向。',
    '',
    '需求：',
    String(request ?? '').trim(),
  ].join('\n')
}

/** 计划 → 动手：把上一轮那份计划交回去执行，同时撤掉只读闸门 */
export function executionPrompt(plan: string): string {
  const p = String(plan ?? '').trim().slice(0, PLAN_TEXT_MAX)
  return [
    '【开始执行计划】下面这份计划已经过我的确认，可以执行写操作了。',
    '按计划从第一步开始，做完一步自检一步；某步做不下去就说清卡在哪，别跳过。',
    '',
    '计划：',
    p,
  ].join('\n')
}

/** `/技能 <名字> <原话>` 的行首写法 */
export const SKILL_CMD_RE = /^\/(?:技能|skill)\s+(\S+)\s*/i

/**
 * 把 `/技能 X …` 展开成模型看得懂的指令。
 *
 * 技能在 pi 那边是靠提示词里那份清单被模型自己挑用的，打名字并不会「调用」它 ——
 * 所以这层的价值是把人的显式意图翻译成一段稳定措辞，并且保证名字不在清单里时
 * 当场说「没这个技能」，而不是让模型对一个不存在的名字产生联想。
 */
export function expandSkillCall(
  text: string,
  skills: ReadonlyArray<{ name: string }>,
): { text: string; skill?: string; unknown?: string } {
  const body = String(text ?? '')
  const m = SKILL_CMD_RE.exec(body)
  if (!m) return { text: body }
  const name = m[1] ?? ''
  const hit = skills.find((s) => s.name === name)
  if (!hit) return { text: body, unknown: name }
  const rest = body.slice(m[0].length).trim()
  return {
    text: [
      `请使用技能「${hit.name}」来处理下面这件事，按它写明的流程执行（技能文档用 read 读它自己的 SKILL.md）。`,
      rest ? `需求：${rest}` : '（这条只指定了技能，没有别的要求：先说明这个技能能做什么，再按流程走一遍最小示例。）',
    ].join('\n'),
    skill: hit.name,
  }
}

/** 主进程持有、渲染层只读镜像的运行模式状态 */
export interface AssistantModeState {
  mode: AssistantRunMode
  /** 目标模式的目标原文 */
  goal?: string
  /** 目标模式已推进到第几轮 */
  round: number
  maxRounds: number
  /** true = 主进程还在自动续跑；渲染层的忙碌态以它为准，不靠本地猜 */
  running: boolean
  /** 停下来时的人话原因（达成 / 到轮数上限 / 没给判定 / 你按了停止） */
  note?: string
  /** 计划模式下 true 表示写操作正被闸门拒绝 */
  planLocked?: boolean
  /** 计划模式产出的那份计划（截到 PLAN_TEXT_MAX）：有它浮层才给「执行计划」这一项 */
  plan?: string
  /** 已授权的读取目录，只在这场助手会话期间有效 */
  readDirs: string[]
}

export function defaultModeState(): AssistantModeState {
  return { mode: 'chat', round: 0, maxRounds: GOAL_MAX_ROUNDS, running: false, readDirs: [] }
}

/** 浮层里的一条技能：直接读盘，所以第一条消息之前也列得到 */
export interface OverlaySkillEntry {
  name: string
  description: string
  /** SKILL.md 的路径，界面上的「来源」提示用 */
  path: string
}

/**
 * 渲染层组浮层要的全部数据。
 *
 * 一次给齐（模式 + 技能 + 开关），而不是让界面为每一项各调一次：浮层是跟着输入
 * 逐字刷新的，多次 invoke 会让它一半能渲染一半在转圈。
 */
export interface AssistantOverlayData {
  mode: AssistantModeState
  skills: OverlaySkillEntry[]
  /** 技能与扩展总开关：关着时选技能只会得到「技能没加载」，浮层要说实话 */
  extensionsEnabled: boolean
  /**
   * @ 引用当前从哪个目录开始浏览。
   *
   * 恒有值：没挑过项目目录时就是 defaultWorkDir（助手自己的数据目录）——
   * 打 @ 不该需要先做一件准备工作，但真正的项目范围仍要人亲手挑那一下。
   */
  workDir: string
  /** 兜底的浏览根，界面上「当前在助手目录里挑」这句话的依据 */
  defaultWorkDir: string
  /**
   * 上一场亲手挑过的项目目录（跨会话记住的那一个）。
   *
   * 只负责让浮层多出一行「继续用「X」」：点下去才算这一场的授权，
   * 所以权限的作用域仍然是一场会话。与当前浏览根相同、或目录已不在时不给。
   */
  recentWorkDir?: string
}

/** 浮层的一项：kind 决定渲染层选中后调哪个动作 */
export type OverlayItemKind = 'skill' | 'mode' | 'files' | 'ref' | 'workdir' | 'revoke' | 'flag' | 'settings'

/**
 * 浮层里的一条。
 *
 * label/hint 是给人在键盘上按两下就过去用的短文本，所以 hint 要说清「选了之后会发生什么」：
 * 目标模式那种会自己连续跑八轮的动作，看不出来后果就不该让人按回车。
 */
export interface OverlayItem {
  id: string
  label: string
  hint: string
  kind: OverlayItemKind
  /** skill=技能名；mode=goal/plan/chat/execute/stop；revoke=要撤销的目录；workdir=要直接沿用的目录（留空则开选择器）；flag=要打开的开关 */
  value?: string
  disabled?: boolean
  note?: string
}

// ---------------------------------------------------------------------------
// @ 引用：把「看这个文件 / 这个目录」写成消息里的一个词
// ---------------------------------------------------------------------------

/** 一次列出的候选上限：再多就不是给人挑的，是给人翻的 */
export const AT_LIST_MAX = 40
/** 一条消息最多展开几个引用：引用不是越多越好，六个已经够把上下文挤满 */
export const AT_REF_MAX = 6
/** 单个文件内联的字符上限 */
export const AT_FILE_CHARS_MAX = 20_000
/** 目录清单最多列多少条 */
export const AT_DIR_LINES_MAX = 200
/** 一条消息里所有引用加起来的上限：这是模型的输入预算，不是磁盘的 */
export const AT_TOTAL_CHARS_MAX = 60_000

/** @ 后面正在打的那半条路径（界面用它去问主进程要候选） */
export interface AtToken {
  /** @ 在草稿里的下标，选中候选时要从这里替换 */
  start: number
  /** @ 之后已经打出来的部分，可以是 src/main/brid 这种带斜杠的 */
  query: string
}

/**
 * 光标前是不是一条正在输入的 @ 引用。
 *
 * 两条收紧：@ 前面必须是空白或行首（邮箱和 a@b 不该弹文件列表），
 * @ 到光标之间不能有空白（写完的那一段属于上一条引用，不再算「正在输入」）。
 */
export function atTokenAt(text: string, caret: number): AtToken | undefined {
  const before = String(text ?? '').slice(0, Math.max(0, caret))
  const at = before.lastIndexOf('@')
  if (at < 0) return undefined
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return undefined
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return undefined
  return { start: at, query }
}

/**
 * 一条消息里写完的 @ 引用（按出现顺序、去重）。
 *
 * 路径后面紧跟着中文标点是常态（「看 @src/a.ts，为什么报错」），所以尾巴上的标点要削掉，
 * 否则这条引用会因为一个逗号变成「不存在」。
 */
export function extractAtRefs(text: string): string[] {
  const out: string[] = []
  const re = /(^|\s)@([^\s@]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(String(text ?? '')))) {
    const p = (m[2] ?? '').replace(/[，。、；：！？,.;:!?)]+$/, '')
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** 一条 @ 引用的候选 */
export interface AtEntry {
  /** 相对工作目录的路径，统一用 /；目录以 / 结尾，选中后继续往里钻 */
  path: string
  dir: boolean
  /** 文件字节数，目录没有 */
  size?: number
}

/** 候选列举的结果（主进程读盘，界面只负责列出来） */
export interface AtListing {
  ok: boolean
  reason?: string
  workDir?: string
  entries: AtEntry[]
  /** 命中太多被截断：界面要提示「再打几个字缩小范围」 */
  truncated?: boolean
}

