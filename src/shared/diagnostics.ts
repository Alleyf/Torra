/**
 * 端到端诊断的共享契约。
 *
 * 之所以放在 shared：诊断结果的消费者同时有主进程（产生）、设置页（展示）
 * 和离线 CLI（落盘报告）。三方对「一次检查问了什么问题、答案是什么、
 * 用户下一步该做什么」必须用同一套字段，否则 UI 与报告会各自漂移。
 */

/**
 * 流水线层次，按一次真实讨论的因果顺序排列。
 * 上层坏了必然在下层表现为失败，所以报告要按层排序、按层归因 ——
 * 把「选择器查不到」报成「适配器失效」就是没做归因的后果。
 */
export type DiagLayer =
  | 'env' // 运行环境：userData、目录可写性
  | 'adapter' // 适配器静态内容：YAML 结构、选择器是否易漂
  | 'api' // API 接入通道：配置、Key、端点可达、模型名是否在清单里
  | 'login' // 分区登录态：cookie / localStorage / 是否被重定向
  | 'channel' // 通道就绪：实例存在、视口非 0、脚本已注入、导航成功
  | 'selector' // 选择器命中：页面里到底有没有那些元素、输入框能否写入
  | 'moderator' // 主持角色：谁有资格当主持（通道本身的问题归 api 层）
  | 'output' // 结果产出：会话落盘、记录可解析、报告可生成
  | 'runtime' // 真实运行期埋点（不属于体检，属于日志）

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface CheckResult {
  /** 稳定标识，形如 selector:hits:deepseek-web，用于跨次体检对比 */
  id: string
  layer: DiagLayer
  /** 这项检查回答的问题，一句话说清；用户只看这行就能判断严重性 */
  title: string
  subject?: string
  status: CheckStatus
  ms: number
  /** 原始观测，逐条。断言必须可自证 —— 没有证据的「适配器失效」是噪音 */
  evidence: string[]
  /** 失败/警告时用户要做的动作，要具体到「点哪里」或「改成什么」 */
  fix?: string
  /** 机器算出的可直接套用的值（例如页面上真实存在的选择器） */
  suggestion?: string
  /** UI 一键套用：把 suggestion 写进指定模型的适配器字段 */
  apply?: { modelId: string; adapterId: string; field: 'input' | 'stream' | 'health_probe'; value: string }
}

export interface DoctorSummary {
  pass: number
  warn: number
  fail: number
  skip: number
}

export interface DoctorReport {
  startedAt: number
  finishedAt: number
  /** 体检进程实际使用的 userData —— 历史误判的头号来源 */
  userData: string
  scope: string
  checks: CheckResult[]
  summary: DoctorSummary
  /** 首个失败层的名称，用于「先修哪个」的排序 */
  blockingLayer?: DiagLayer
  files?: { json: string; md: string }
}

/** 运行期埋点条目 */
export interface DiagEvent {
  ts: number
  layer: DiagLayer
  stage: string
  subject?: string
  sessionId?: string
  ok?: boolean
  ms?: number
  detail?: string
}

/** 日志目录里的一天。名称就是文件名去掉扩展，界面只认这个口径 */
export interface LogFileInfo {
  /** 形如 20261007 */
  day: string
  name: string
  bytes: number
  mtimeMs: number
}

/** 读盘结果。scanned 是这次实际解析的行数 —— 截断时必须让用户看得见 */
export interface LogReadResult {
  events: DiagEvent[]
  scanned: number
  /** 因为体积上限或行数上限被截断时为 true */
  truncated: boolean
  file: string | null
}

/** 日志筛选条件。内存视图与按天文件视图共用同一套 */
export interface LogFilter {
  layer?: DiagLayer
  sessionId?: string
  subject?: string
  /** 对 detail / stage / subject 做小写子串匹配 */
  text?: string
  /** 只留 ok === false */
  failedOnly?: boolean
  n?: number
}

export function summarize(checks: CheckResult[]): DoctorSummary {
  const s: DoctorSummary = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const c of checks) s[c.status] += 1
  return s
}

/**
 * 层的因果顺序。导出它而不是各处抄一份：
 * 离线 CLI、设置页、体检本身对「第几层」的编号必须同源，
 * 否则新增一层就会有一份副本落后，报告里的层序号开始说谎。
 */
export const LAYER_ORDER: DiagLayer[] = [
  'env',
  'adapter',
  'api',
  'login',
  'channel',
  'selector',
  'moderator',
  'output',
  'runtime',
]

export function layerRank(layer: DiagLayer): number {
  return LAYER_ORDER.indexOf(layer)
}

export const LAYER_LABEL: Record<DiagLayer, string> = {
  env: '运行环境',
  adapter: '适配器',
  api: 'API 接入',
  login: '登录态',
  channel: '通道',
  selector: '选择器',
  moderator: '主持角色',
  output: '结果产出',
  runtime: '运行期',
}

/** 体检结论的人话摘要，报告与 UI 共用同一份措辞 */
export function headline(r: DoctorReport): string {
  if (r.summary.fail === 0 && r.summary.warn === 0) return '全链路通过'
  if (r.summary.fail === 0) return `${r.summary.warn} 项提醒，无阻断`
  const first = r.checks.find((c) => c.status === 'fail')
  return `${r.summary.fail} 项失败，最先阻断在「${first ? LAYER_LABEL[first.layer] : '?'}」层`
}
