/**
 * ACP 层的公共类型：主进程、preload、渲染层共用的那一套词表。
 *
 * 这一层只描述「协议里有什么」，不掺任何一家 agent 的私有语义 ——
 * 四家返回的 modes / configOptions 含义互不相同（实测：claude 是权限模式、
 * codex 是沙箱档位、pi 是思考档、opencode 干脆没有 modes），所以这里一律
 * 按协议原样存成「一个通用的下拉项」，由界面按数据渲染，绝不替它猜含义。
 *
 * 放在 shared 而不是 main：界面要画的就是这些东西，渲染层不能 import 主进程的模块。
 */

import type { HostResume, HostSnapshot } from './host'

/** 注册表里的一家 agent：怎么起它、要先装什么、有什么坑 */
export interface AcpAgentEntry {
  /** 稳定标识，落盘用它 */
  id: string
  /** 展示名 */
  title: string
  /** 一句话说清它是什么 */
  blurb: string
  /** 启动命令 */
  command: string
  /** 启动参数 */
  args: string[]
  /** 需要先装上的适配器包；没有这一项说明 agent 自带 ACP 入口 */
  package?: { name: string; version: string }
  /** 登录指引：协议给了 authMethods 时以协议为准，这里是兜底 */
  authHint?: string
  /** 已知的坑，展示给用户看 */
  notes: string[]
  /** 内置还是用户自己加的 */
  source: 'builtin' | 'user'
}

/**
 * 目录里的一家：可以接进来的外部编码智能体。
 *
 * 这一份与 AcpAgentEntry 的分工：AcpAgentEntry 是「已经接上了，怎么起它」，
 * AcpCatalogItem 是「还没接上，它是什么、怎么起、本机有没有装」。
 * 两者共用同一套启动规格（command + args），所以接上的时候不用再翻译一遍。
 */
export interface AcpCatalogItem {
  /** 稳定标识；接上之后就用它落盘 */
  id: string
  /** 展示名 */
  title: string
  /** 谁家的 */
  vendor: string
  /** 一句话说清它是什么 */
  blurb: string
  /** 启动命令 */
  command: string
  /** 启动参数 */
  args: string[]
  /**
   * 怎么接：
   * - local：命令在本机 PATH 上（复用已有的那一份）
   * - npx：用 npx 临时跑这个包（不写进全局环境，第一次用会把它下下来）
   */
  mode: 'local' | 'npx'
  /** 本机没装时，用户照着敲的那一行 */
  install: string
  /** npm 包（版本钉死）；官方目录给的多半是这一种 */
  package?: { name: string; version: string }
  /** 不装全局包时的备用方式：npx 临时跑 */
  npx?: { package: string; args: string[] }
  /** 登录指引 */
  authHint?: string
  /** 已知的坑，展示给用户看 */
  notes: string[]
  /** 来源：Torra 精选 / 官方目录 */
  origin: 'curated' | 'official'
  /** 官方图标（官方目录那侧才有；图标本身由主进程取回后以 data URI 交给界面） */
  iconUrl?: string
  /**
   * 官方目录里的那个 id：图标是按它取的。
   *
   * 精选那几家在官方目录里的叫法常常跟 Torra 的不一样（WorkBuddy 在官方目录里
   * 叫 codebuddy-code），所以要单记一个「图标按谁去取」。
   */
  iconId?: string
  /** 本机有没有装好（local 型才有意义：命令在不在 PATH 上） */
  installed: boolean
  /** 装在哪 / 为什么这么说，一句话 */
  presence: string
  /** 官方没给启动方式：接不了，但要说清楚 */
  unsupported?: string
  /**
   * 接上之后落在注册表里的 id。
   *
   * 官方目录叫「claude-acp」，Torra 内置那一条叫「claude」—— 同一家的两种叫法。
   * 不映射的话，用户从官方目录接一次，工作台里会同时出现两条 Claude。
   */
  torraId?: string
  /** 已经接上没有（Torra 内置的那四家也算接上了） */
  registered?: boolean
}

/** 官方目录那一栏 */
export interface AcpOfficialCatalog {
  /** 拉过没有 */
  fetched: boolean
  /** 什么时候拉的 */
  fetchedAt?: number
  /** 拉的是哪儿 */
  source?: string
  items: AcpCatalogItem[]
  /** 拉不到时照实说 */
  error?: string
}

/** 目录视图：精选 + 官方 */
export interface AcpCatalogView {
  curated: AcpCatalogItem[]
  official: AcpOfficialCatalog
}

/** 协议里的登录方式 */
export interface AcpAuthMethod {
  id: string
  name: string
  description?: string
}

/** 一个通用下拉项（协议里的 mode / config option 都归它） */
export interface AcpSelectOption {
  value: string
  name: string
  description?: string
}

export interface AcpSelectGroup {
  id: string
  name: string
  /**
   * 协议给的语义分类（mode / model / thought_level …）。
   *
   * 它是「给界面排版用的提示」，不是「这是不是协议里的 mode」的判据 ——
   * 协议把 mode 本身也列进了保留分类里，按它分派会把请求发错方法。
   * 要分派看 kind。
   */
  category?: string
  /**
   * 这一组来自协议里的哪一处：mode 还是 config option。
   *
   * 分开记是因为协议把它们做成两个方法（session/set_mode 与
   * session/set_config_option），而各家都爱把自己的那一组叫「mode」——
   * opencode 的 config option 就叫 mode，codex 的 mode 却是沙箱档位。
   * 按 id 或名字猜都会把请求发到错误的方法上，所以这里记的是来源。
   */
  kind: 'mode' | 'config'
  /** 协议里的类型：见过 select 与 boolean */
  type: string
  /** 当前值：select 是字符串，boolean 是真假 */
  currentValue?: string | boolean
  options: AcpSelectOption[]
}

/**
 * Torra 自己的工具包挂上去没有。
 *
 * 挂不上去不是 bug，是协商的结果：只有肯收 http 形态 MCP 的 agent 才拿得到工具包
 * （实测 pi 的适配器根本不读 mcpServers，codex 遇到不认识的形态会直接报错）。
 * 所以这里既报状态，也报一句人话 —— 界面要说清「为什么这一家没有工具」。
 */
export interface AcpToolPackView {
  /** 工具包真的挂上去了 */
  attached: boolean
  /** 挂上去的工具条数 */
  tools: number
  /** 没挂上去的原因（一句话） */
  reason?: string
}

/**
 * 永不开放的档位：免掉全部授权、或给 agent 全量访问。
 *
 * 这些是各家自己定义的权限档位（Claude Code 的 bypassPermissions、codex 的
 * 全量访问档之类）。协议把它们和普通模式一样列在 availableModes 里 ——
 * Torra 不替用户点那个按钮，也不把它画出来。
 *
 * 判据是「这一项会不会让 agent 不再问就把所有事做完」，所以匹配的是语义词根，
 * 不是某一家的具体叫法：叫法会变，语义不会。
 *
 * 挡在两处：主进程拒绝发这类值（这是真边界），界面也不显示这类项（这是诚实）。
 */
const BLOCKED_OPTION_WORDS = [
  'bypass',
  'skip-permission',
  'skippermission',
  'skip_permission',
  'danger',
  'full-access',
  'fullaccess',
  'full_access',
  'yolo',
  'no-permission',
  'nopermission',
  'no_permission',
  'allow-all',
  'allowall',
]

export function isBlockedAcpOption(value: string | null | undefined): boolean {
  if (!value) return false
  const v = String(value).toLowerCase()
  return BLOCKED_OPTION_WORDS.some((w) => v.includes(w))
}

/** 握手协商出来的东西：这一家能干什么、要用户怎么登录 */
export interface AcpCapabilities {
  protocolVersion: number
  agentName?: string
  agentTitle?: string
  agentVersion?: string
  /** 能不能读回历史会话 */
  loadSession: boolean
  /** 吃不吃 http 形态的 MCP 服务（Torra 的工具包靠这条） */
  mcpHttp: boolean
  mcpSse: boolean
  /** 会话相关能力名（resume / fork / list …） */
  sessionCapabilities: string[]
  /** 提示类能力（image / audio / embeddedContext …） */
  promptCapabilities: string[]
  authMethods: AcpAuthMethod[]
  /** 通用下拉组：modes 与 configOptions 合并后按 id 归并 */
  selects: AcpSelectGroup[]
  /** Torra 的工具包挂上去了没有 */
  toolPack?: AcpToolPackView
  /**
   * 能不能接着聊的结论。
   *
   * 它不是纯协商结果：能不能读回历史是协商出来的，跨重启能不能对上
   * 是实测出来的（见兼容矩阵）。两边合起来才是结论，所以由主进程算好再给。
   */
  resume?: HostResume
}

/** 预检结果：能不能接上、接上之后是什么样 */
export interface AcpProbeResult {
  ok: boolean
  agentId: string
  agentTitle?: string
  elapsedMs: number
  error?: string
  /**
   * 失败时给的结论：分门别类，界面照它给一句话加一句怎么办。
   *
   * 「接不上」三个字没法行动 —— 用户看到它只能干瞪眼。
   */
  verdict?: AcpVerdict
  capabilities?: AcpCapabilities
}

/** 预检结论的类别 */
export type AcpVerdictKind =
  | 'ok'
  /** 命令都找不到：agent 没装，或者不在 PATH 上 */
  | 'not-installed'
  /** agent 在跑，但没登录 / 没有凭据 */
  | 'not-logged-in'
  /** 起来了，但协议对不上 */
  | 'incompatible'
  /** 起不来，原因不明 */
  | 'unknown'

export interface AcpVerdict {
  kind: AcpVerdictKind
  /** 一句话结论 */
  text: string
  /** 该怎么办 */
  hint?: string
}

/**
 * agent 请求授权：把它交给用户决定
 *
 * 事件词表不在这里了：协议那边的话由 `src/main/acp/host.ts` 翻成 Host 领域事件
 * （`src/shared/host.ts`），界面只认那一层，不认 ACP 的原话。
 */
export interface AcpPermissionRequest {
  id: string
  sessionId: string
  title: string
  toolKind?: string
  rawInput?: unknown
  options: { optionId: string; name: string; kind: string }[]
}

/** 用户的决定：选了哪一项，或者取消 */
export interface AcpPermissionDecision {
  optionId: string | null
  reason?: string
}

/** 授权请求的包装 */
export interface AcpPermissionPayload {
  agentId: string
  request: AcpPermissionRequest
}

/**
 * 接着聊一场旧会话的结果。
 *
 * 快照里是这一家自己留下的历史 —— 读回来的，不是 Torra 自己那份记录。
 */
export interface AcpResumeResult extends AcpStartResult {
  snapshot?: HostSnapshot
}

/** 挂上/摘下某一家的结果 */
export interface AcpStartResult {
  ok: boolean
  agentId?: string
  capabilities?: AcpCapabilities
  error?: string
  /** 接不上时给的结论：分门别类，界面照它说 */
  verdict?: AcpVerdict
  /**
   * agent 那边的会话号。
   *
   * 「接着聊」唯一的凭据：只有这一家自己给的、跨重启还认的号才算数。
   * Torra 自己编的号留在本地，重开就对不上任何东西。
   */
  sessionId?: string
}

/** 列表视图：注册表 + 用户自定义条目里的毛病 + 现在挂着谁 */
export interface AcpListView {
  entries: AcpAgentEntry[]
  problems: string[]
  active?: { agentId: string; capabilities: AcpCapabilities }
  /** 每一家验过没有：键是 agent id */
  matrix?: Record<string, AcpMatrixStatus>
  /** 这份矩阵是怎么来的（哪条命令生成的） */
  provenance?: { generatedBy?: string; note?: string }
}

/**
 * 一「家 + 一个版本」的实测结果。
 *
 * 这是把「ACP 是标准，所以接谁都行」换成能验的东西：标准只管方法名与消息形状，
 * 不管 agent 会不会回来要授权、收不收 http 形态的 MCP、它的「模式」是什么含义。
 * 这些只能一家一家试出来 —— 试出来的结果记在这里，界面照着它说话。
 *
 * 键是「id + version」：适配器包跟着上游走，用户本机随时可能 npm update 到别的版本，
 * 换了版本这一格就不再作数，得重测。
 */
export interface AcpMatrixCell {
  id: string
  /**
   * 钉死的版本：适配器包就是包版本，自带入口的那一家写 'self'。
   *
   * 'self' 不是「版本不重要」，是「这一家没有适配器包可钉」——
   * 它真正的版本由 agent 自己报（见 agentVersion），换了版本要重测，
   * 但离线时拿不到那个版本，所以这一格只能由用户自己判断要不要重测。
   */
  version: string
  /** agent 自报的版本（实测时记下来，好让用户看出本机的版本漂了） */
  agentVersion?: string
  /** 测的日期，ISO 短日期 */
  checkedAt: string
  /** 握手（initialize） */
  handshake: boolean
  /** 建会话（session/new） */
  session: boolean
  /** 发一轮（session/prompt） */
  prompt: boolean
  /** 打断（session/cancel） */
  cancel: boolean
  /** 会先问用户再动手（session/request_permission） */
  permission: boolean
  /** Torra 的工具包挂上去了没有 */
  toolPack: boolean
  /**
   * 整轮往返测过没有。
   *
   * 没有它，「发一轮没测」和「发一轮没过」在表里长得一模一样 ——
   * 前者是这次没花钱，后者是这一家真的不行。混起来等于把「没量」写成「不行」。
   */
  full?: boolean
  /**
   * 能不能接着聊：实测出来的那一格。
   *
   * session 是「读得回历史吗」，identity 是「读回来的那一轮，和当时那一轮对得上吗」。
   * 后者只能另起一个进程读一遍再比 —— 一次运行里验不出来，所以它进矩阵，不进代码。
   */
  resume?: {
    /** 读得回历史 */
    session: boolean
    /** 轮次标识跨重启对得上 */
    identity: boolean
    /** 测的日期 */
    checkedAt: string
    /** 测的时候记下的说明 */
    note?: string
  }
  /** 测的时候记下的说明 */
  notes: string[]
}

/**
 * 一家在界面上的验过状态。
 *
 * 「绿」的定义很窄：握手、建会话、发一轮、打断，四样都通才算绿。
 * 工具包挂不挂得上不算 —— 那是能力差异（有的 agent 压根不收 http 形态的 MCP），
 * 不是兼容性问题，混进去会让矩阵看起来比实际更严。
 */
export interface AcpMatrixStatus {
  /** 测过没有 */
  tested: boolean
  /** 注册表里钉死的这一版，测过没有 */
  currentVersionTested: boolean
  /** 可以直接接（绿） */
  green: boolean
  /** 测出来的那一格 */
  cell?: AcpMatrixCell
  /** 没绿的原因，一句话 */
  reason?: string
}

