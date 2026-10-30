/**
 * ACP 层的公共类型。
 *
 * 这一层只描述「协议里有什么」，不掺任何一家 agent 的私有语义 ——
 * 四家返回的 modes / configOptions 含义互不相同（实测：claude 是权限模式、
 * codex 是沙箱档位、pi 是思考档、opencode 干脆没有 modes），所以这里一律
 * 按协议原样存成「一个通用的下拉项」，由界面按数据渲染，绝不替它猜含义。
 */

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
  category?: string
  /** 协议里的类型：目前见过 select */
  type: string
  currentValue?: string
  options: AcpSelectOption[]
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
}

/** 预检结果：能不能接上、接上之后是什么样 */
export interface AcpProbeResult {
  ok: boolean
  agentId: string
  agentTitle?: string
  elapsedMs: number
  error?: string
  capabilities?: AcpCapabilities
}

/**
 * 中性事件词表。
 *
 * ACP 的 session/update 有十来种形态，这里只保留渲染层真正要画的几类，
 * 其余归到 notice。刻意不比 Torra 现有的助手事件表更细 —— 界面要能同时
 * 画「内嵌助手」和「外部 agent」，两边就得共用一套最小词表。
 */
export type AcpEvent =
  | { kind: 'status'; text: string }
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool-call'; id: string; title: string; name?: string; toolKind?: string; status?: string }
  | { kind: 'tool-result'; id: string; status?: string; text?: string }
  | { kind: 'plan'; entries: { content: string; status: string; priority?: string }[] }
  | { kind: 'notice'; text: string }
  | { kind: 'usage'; input?: number; output?: number; totalTokens?: number; cost?: number }
  | { kind: 'mode'; optionId: string; value: string; name?: string }
  | { kind: 'error'; text: string }
  | { kind: 'settled'; stopReason?: string }

/** agent 请求授权：把它交给用户决定 */
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
