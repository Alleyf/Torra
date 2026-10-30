/**
 * 应用插件的跨进程契约。
 *
 * 和助手那套 `.plugin.json`（一条清单 = 一个 http/shell 工具）不是一个层级：
 * 这里是「应用插件」—— 能挂右侧面板、往设置页加一节、把自己的工具交给助手。
 * 代价是它能跑代码，所以清单必须先把**能力**写清楚（见 PluginPermission），
 * 用户勾选后主进程才放行；没声明的能力在宿主侧直接拒绝，不靠插件自觉。
 *
 * 三个纪律：
 * 1. 代码只跑在独立 utilityProcess 里，崩溃不影响应用；
 * 2. 面板 UI 只走 torra-ui 沙箱帧（无网络、无 Node、独立源），通过 postMessage + 一次性
 *    token 调宿主；token 由主进程签发并绑定插件 id，伪造别人的 token 没有意义；
 * 3. 工具名前缀必须是插件 id：模型看到的是一张全局名单，两个插件撞名会静默覆盖。
 */

export const PLUGIN_MANIFEST_FILE = 'torra-plugin.json'
/** 清单协议版本：不认识的版本宁可判无效，也不要按旧字段猜 */
export const PLUGIN_API_VERSION = 1

export type PluginPermission =
  | 'storage'
  | 'panel'
  | 'tools'
  | 'secrets'
  /** 借用用户已配置的 API 模型做一次性补全；会产生模型费用，宿主按调用记日志 */
  | 'ai'
  | `net:${string}`

export interface PluginPanelDecl {
  title: string
  /** 图标名走渲染层白名单，认不出的一律 Puzzle */
  icon?: string
}

export interface PluginToolDecl {
  /** 必须以 `${插件 id}_` 开头，见文件头第 3 条 */
  name: string
  label: string
  description: string
  /** JSON Schema 子集，和助手声明式插件同一套约束 */
  parameters: Record<string, unknown>
}

export interface PluginPromptDecl {
  id: string
  title: string
  /** 注入助手系统提示词的一段说明；启用后模型就能看到 */
  text: string
}

export interface PluginContributes {
  panel?: PluginPanelDecl
  tools?: PluginToolDecl[]
  prompts?: PluginPromptDecl[]
}

/**
 * 插件要用的密钥。
 *
 * 放在顶层而不是 contributes：它是「用户配置」而不是「插件贡献的东西」，
 * 设置页在插件停用时也要能看到「配没配」。这里只声明用途与出处，
 * 值只进系统钥匙串，插件自己通过 ctx.secret(name) 取，宿主从不回读给界面。
 */
export interface PluginSecretDecl {
  /** 插件内的引用名；宿主拼成 plugin:<插件 id>:<name> 后再落钥匙串 */
  name: string
  label: string
  /** 一句话说清没有它会怎样、去哪拿；设置页原样显示 */
  hint?: string
  /** 申请页地址，只收 http(s) */
  url?: string
  /** 不填也能用（走匿名额度或本地默认）：界面上只提示，不标成缺配置 */
  optional?: boolean
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  apiVersion: number
  description: string
  /** 相对插件目录的入口文件；纯 UI 插件可以不给 */
  main?: string
  /** 面板文档，相对插件目录；必须是自包含 HTML */
  ui?: string
  permissions: PluginPermission[]
  secrets?: PluginSecretDecl[]
  contributes?: PluginContributes
}

export type PluginOrigin = 'builtin' | 'user'
export type PluginRuntimeStatus = 'stopped' | 'starting' | 'ready' | 'failed'

export interface PluginView {
  id: string
  name: string
  version: string
  description: string
  origin: PluginOrigin
  dir: string
  enabled: boolean
  /** 配置里开着但进程没起来时，这里必须说原因，否则界面只剩一个灰点 */
  status: PluginRuntimeStatus
  error?: string
  panel?: PluginPanelDecl
  tools: Array<{ name: string; label: string; description: string }>
  prompts: Array<{ id: string; title: string }>
  permissions: PluginPermission[]
  /** 声明的密钥：ref 是钥匙串里的完整引用，configured 只表示「有没有存值」 */
  secrets: Array<PluginSecretDecl & { ref: string; configured: boolean }>
  /** 声明的入口/面板文件是否存在；缺了要明说，不要等点击时才炸 */
  files: { main: boolean; ui: boolean }
}

export interface PluginListResult {
  plugins: PluginView[]
  /** 读不出来或校验失败的目录：路径 + 全部原因 */
  invalid: Array<{ dir: string; errors: string[] }>
  /** 用户插件目录（安装来源说明用） */
  userDir: string
}

export interface PluginActionResult {
  ok: boolean
  reason?: string
  plugin?: PluginView
}

export interface PluginPanelResult {
  ok: boolean
  reason?: string
  /** torra-ui://frame/... 的沙箱文档地址 */
  url?: string
  /** 一次性会话 token；面板里的脚本用它调宿主 */
  token?: string
  title?: string
  icon?: string
}

/**
 * 面板脚本 → 宿主 的调用结果。
 * 失败不抛到渲染层：面板自己要知道「刚才那步为什么没成」，而不是收到一个 string。
 */
export interface PluginInvokeResult {
  ok: boolean
  value?: unknown
  error?: string
}
