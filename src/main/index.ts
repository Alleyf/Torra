/**
 * Torra 主进程入口
 *
 * 安全基线（PRD 11.2）：
 * - contextIsolation: true + sandbox: true
 * - 站点 WebView 零 Node 权限
 * - preload 仅通过 contextBridge 暴露白名单方法
 */

import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, session, shell, Tray } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { promises as fs, readFileSync } from 'node:fs'
import { AdapterRegistry } from './adapters/registry'
import {
  WebviewPool,
  probeSessionCookies,
  credentialExpiry,
  summarizeAuthCookies,
  type AuthCookie,
  type CredentialExpiry,
} from './webview/pool'
import { ApiAgent } from './agents/api-agent'
import { createModeratorChannel } from './agents/moderator-channel'
import { WebviewAgent } from './agents/webview-agent'
import type { Agent } from './agents/agent'
import { Orchestrator, type OrchestratorEvent } from './orchestrator/orchestrator'
import { FileSessionStore } from './store/session-store'
import { ChatAssetStore } from './store/chat-assets'
import { SessionProjection, type DigestSnapshot } from './store/projection'
import { KeychainSecretStore } from './store/keychain'
import { type ModelOrderState, visibleInOrder, applyReorder } from './store/model-order'
import { buildReport, reportToMarkdown } from './report/report'
import { buildExportDoc, exportFileBase, type ReportCopyImagePayload, type ReportExportPayload } from '../shared/report-export'
import { buildTranscriptMarkdown } from '../shared/transcript'
import { sanitizeDiscussionDefaults } from '../shared/discussion-defaults'
import { lookupPublicPrice } from '../shared/model-prices'
import { makeId, nowMs } from '../shared/invariants'
import { PICKER_SCRIPT } from './webview/picker'
import { claimInAppPopup, denyNote, isLoginWindow, loginPopupTitle, popupDisposition, popupNote } from './webview/guards'
import { collectScan, createSmartAdd, scanWindow } from './setup/smart-add'
import { webModelSlug, webSpecFromPlan } from './setup/web-spec'
import { createUpdater } from './setup/updater'
import type { AboutInfo } from '../shared/update'
import { createAssistantBridge } from './assistant/bridge'
import { installFaviconProtocol, registerFaviconScheme } from './net/favicon-cache'
import {
  APPROVAL_PREFS_DEFAULT,
  clampApprovalTimeout,
  isApprovalMode,
  type AssistantApprovalPrefs,
} from '../shared/assistant'
import type { AdapterSpec } from '../shared/adapter'
import { roundWallClockMs } from '../shared/participants'
import { diag } from './diagnostics/log'
import { persistReport, runDoctor, type DoctorDeps } from './diagnostics/doctor'
import {
  DEFAULT_THEME_MODE,
  isThemeMode,
  resolveTheme,
  type ThemeMode,
  type ThemeResolved,
} from '../shared/theme'
import type { DoctorReport, LogFilter } from '../shared/diagnostics'
import {
  FINISH_REASON_LABEL,
  validateRetryPlan,
  type HistoryEntry,
  type RetryMode,
  type RetryPlan,
  type RetrySource,
} from '../shared/retry'
import type {
  ModelConfig,
  SessionConfig,
  SessionRecord,
  Topic,
  TransportKind,
  ReportFinishedReason,
  TurnContext,
  Utterance,
  Digest,
  ChatAttachmentMeta,
  ChatImage,
  HotkeyConfig,
  HotkeyState,
} from '../shared/types'
import {
  TIME_BUDGET_DEFAULT_MS,
  TIME_BUDGET_MAX_MS,
  TIME_BUDGET_MIN_MS,
  VERIFY_PASS_DEFAULT,
} from '../shared/types'

const ROOT = path.resolve(__dirname, '..', '..')
/** 端口由 scripts/dev.js 探测空闲端口后经 TORRA_DEV_PORT 注入；两端必须一致 */
const DEV_SERVER = `http://127.0.0.1:${process.env.TORRA_DEV_PORT ?? '5273'}`
/** 开发模式由 scripts/dev.js 注入；未设置时加载 dist 构建产物 */
const isDev = process.env.TORRA_DEV === '1'

let mainWindow: BrowserWindow | null = null
let registry: AdapterRegistry
let pool: WebviewPool
let store: FileSessionStore
let secrets: KeychainSecretStore

const agents = new Map<string, Agent>()

/**
 * 各模型最近一次的登录态判定结果。
 *
 * 状态灯必须反映「此刻能不能发言」，而 agent.status 是有状态的缓存：
 * 它只在被显式改写时才变，早期版本没人改它，于是登录成功后灯仍是红的。
 * 这里额外记一份无状态快照，models:list 直接读它，
 * 保证「登录成功 → 立刻变绿」而不依赖任何一次偶然的 agent 重建。
 */
const lastLoginState = new Map<string, 'logged-in' | 'logged-out' | 'unknown'>()

/** 各模型最近一次判定的理由，用于状态灯悬停提示 */
const lastLoginReason = new Map<string, string>()
/**
 * 各网页模型最近一次读到的凭据有效期。
 *
 * 只有「最早到期的那条认证 cookie」这一个数字，因为用户要回答的问题是
 * 「下次什么时候又要登录」。它是提示不是保证：站点可以在到期前就在服务端
 * 注销会话，所以界面上必须连着依据一起显示（见 ModelRail 的 title）。
 */
const lastCredExpiry = new Map<string, CredentialExpiry>()
let models: ModelConfig[] = []
/** 初始化完成信号——渲染层首次 listModels 须等待，否则拿到空数组 */
let _bootResolve!: () => void
const bootDone = new Promise<void>((r) => { _bootResolve = r })
let orchestrator: Orchestrator | null = null
let currentTopic: Topic | null = null
let currentConfig: SessionConfig | null = null
/**
 * 本场会话 ID 与对外投影。
 *
 * ID 在开场就定下来，不再等收尾时才造：投影文件是运行中就在被外部读的，
 * 若「进行中的名字」和「存档后的名字」不一致，读者就没法把两者对上。
 */
let currentSessionId = ''
let projection: SessionProjection | null = null
/** 本场是否为重试及其上下文（null 表示全新讨论） */
let currentRetry: { retryMode: RetryMode; source: RetrySource; notices: string[] } | null = null
let sessionStartedAt = 0
let currentRunId = 0
let sessionFinalizing = false

function dataDir(): string {
  return path.join(app.getPath('userData'), 'torra')
}

/** 聊天附件字节仓库，惰性初始化（dataDir 依赖 app.getPath，需等 app ready 后才有意义） */
let _chatAssets: ChatAssetStore | null = null
function chatAssets(): ChatAssetStore {
  if (!_chatAssets) _chatAssets = new ChatAssetStore(path.join(dataDir(), 'chat-assets'))
  return _chatAssets
}

/**
 * 导出后在文件管理器里选中该文件。
 *
 * 只在 OS 调用外侧兜住异常：文件已经写成功了，reveal 失败绝不能反过来
 * 让 IPC 报「导出失败」。
 */
function revealExport(file: string): void {
  try {
    shell.showItemInFolder(file)
  } catch {
    /* 路径已由界面文案给出，打不开目录不影响导出结果 */
  }
}

/**
 * 用一个一次性窗口把导出的 HTML 渲染成 PDF 或图片。
 *
 * 窗口摆到屏幕外再 showInactive：隐藏窗口不绘制，capturePage 会拿到空帧
 * （printToPDF 走另一条绘制路径，不受影响，但两条共用同一份装配好的文档）。
 * 沙箱与 contextIsolation 照主窗口的基线走 —— 载入的是本机生成的文档，也不需要任何 Node 权限。
 */
async function withExportPage<T>(
  htmlFile: string,
  width: number,
  fn: (win: BrowserWindow) => Promise<T>,
): Promise<T> {
  const win = new BrowserWindow({
    width,
    height: 900,
    show: false,
    x: -32_000,
    y: -32_000,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  try {
    await win.loadFile(htmlFile)
    return await fn(win)
  } finally {
    win.destroy()
  }
}

async function renderExportPdf(htmlFile: string, out: string): Promise<void> {
  await withExportPage(htmlFile, 1000, async (win) => {
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      // A4 纵向：报告是要打印和转发的，不预设屏幕宽度
      pageSize: { width: 8.27, height: 11.69 },
      margins: { top: 0.55, bottom: 0.55, left: 0.5, right: 0.5 },
    })
    await fs.writeFile(out, buf)
  })
}

/** Chromium 的单帧高度上限约 16384px，超长报告改走 PDF，不做静默截断 */
const PNG_MAX_HEIGHT = 16_000
/** 图片导出的排版宽度：和报告弹窗在常见屏幕上的最大内容宽度对齐 */
const PNG_WIDTH = 1240

/** 把导出的 HTML 渲染成整页 PNG。导出文件和复制为图片共用这一条路径 */
async function renderExportPngBuffer(htmlFile: string): Promise<Buffer> {
  return withExportPage(htmlFile, PNG_WIDTH, async (win) => {
    const measured = await win.webContents.executeJavaScript(
      'Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))',
      true,
    )
    const height = Math.max(800, Math.ceil(Number(measured) || 0))
    if (height > PNG_MAX_HEIGHT) {
      throw new Error(`报告长 ${height}px，超出图片上限 ${PNG_MAX_HEIGHT}px，请改用 PDF。`)
    }
    win.setContentSize(PNG_WIDTH, height)
    win.showInactive()
    // 等两帧真实绘制，不等固定时长：隐藏窗口翻上来这一趟的耗时本来就说不准
    await win.webContents
      .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))', true)
      .catch(() => undefined)
    const img = await win.webContents.capturePage()
    if (img.isEmpty()) throw new Error('渲染结果为空，请改用 PDF 或 HTML 导出。')
    return img.toPNG()
  })
}

async function renderExportPng(htmlFile: string, out: string): Promise<void> {
  await fs.writeFile(out, await renderExportPngBuffer(htmlFile))
}

/** 渲染端交回来的报告原料校验：三种导出和复制为图片共用同一道闸门 */
function parseReportDoc(
  payload: unknown,
): { ok: true; doc: ReportCopyImagePayload } | { ok: false; reason: string } {
  const p = payload as Partial<ReportExportPayload> | null
  if (!p || typeof p.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.sessionId)) {
    return { ok: false, reason: '会话标识非法' }
  }
  if (typeof p.body !== 'string' || typeof p.css !== 'string') {
    return { ok: false, reason: '导出内容格式非法' }
  }
  if (p.body.length === 0) return { ok: false, reason: '报告正文为空' }
  if (p.body.length > 12_000_000 || p.css.length > 6_000_000) {
    return { ok: false, reason: '报告内容过大，未导出' }
  }
  return { ok: true, doc: { sessionId: p.sessionId, title: p.title ?? '研讨报告', body: p.body, css: p.css } }
}

/**
 * 导出文件名主体：主题 + 日期 + 会话短 id，从存档里取，不信渲染端传来的标题。
 *
 * 存档读不到时（例如刚重算完还没落盘的边界）退回渲染端标题，日期段整个省掉而不是补一个假的。
 */
async function exportBaseFor(sessionId: string, rec?: SessionRecord | null): Promise<string> {
  const r = rec ?? (await store.load(sessionId))
  return exportFileBase({
    title: r?.topic?.title ?? '',
    date: r?.updatedAt || r?.createdAt || null,
    sessionId,
  })
}

function validateSessionInput(topic: unknown, config: unknown): string | null {
  if (!topic || typeof topic !== 'object' || !config || typeof config !== 'object') {
    return '议题或会话配置格式非法'
  }
  const t = topic as Partial<Topic>
  const c = config as Partial<SessionConfig>
  if (typeof t.title !== 'string' || t.title.trim().length === 0 || t.title.length > 10_000) {
    return '议题标题不能为空且不能超过 10000 个字符'
  }
  if (typeof t.background !== 'string' || t.background.length > 200_000) {
    return '背景材料格式非法或过长'
  }
  if (!['roundtable', 'debate', 'review'].includes(String(t.strategy))) return '议题策略非法'
  if (typeof c.maxRounds !== 'number' || !Number.isInteger(c.maxRounds) || c.maxRounds < 1 || c.maxRounds > 20) {
    return '最大轮次必须为 1~20 的整数'
  }
  if (typeof c.budgetLimitUsd !== 'number' || !Number.isFinite(c.budgetLimitUsd) || c.budgetLimitUsd <= 0 || c.budgetLimitUsd > 100_000) {
    return '预算必须为 0~100000 的数字'
  }
  if (!Array.isArray(c.participantIds) || c.participantIds.length === 0 || c.participantIds.length > 20) {
    return '参与模型数量必须为 1~20'
  }
  const ids = c.participantIds
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) {
    return '参与模型 ID 非法或重复'
  }
  const known = new Set(models.map((m) => m.id))
  if (ids.some((id) => !known.has(id))) return '参与模型中包含不存在的模型'
  if (c.moderatorId !== null && typeof c.moderatorId !== 'string') return '主持模型 ID 非法'
  if (c.moderatorId && !known.has(c.moderatorId)) return '主持模型不存在'
  /**
   * 主持可以同时在参会名单里（兼发言）。校验只保留一条相关的硬限制：
   * **主持必须是 API 通道** —— 见下面那段注释。兼岗带来的「自己判自己」
   * 风险不在校验层拦，而是在编排层处理：基线不选主持、主持提示词带双重角色护栏。
   */
  /**
   * 主持必须是 API 通道。
   * 网页通道无法担任（主持需要独立 system prompt + 结构化 JSON 输出，
   * 见 buildModerator），但旧版校验只查「模型存在」，于是偏好里存了
   * 一个网页模型时校验通过、buildModerator 静默返回 null，
   * 用户看到的是一场跑到结尾才降级成无主持的讨论 —— 中间全程无提示。
   */
  if (c.moderatorId && !models.find((m) => m.id === c.moderatorId)?.api) {
    return '主持模型必须是 API 模型：网页通道无法产出结构化小结，请在设置页新建一个 API 模型后指认它'
  }
  /**
   * 匿名互评开关只认严格布尔：渲染端一旦传成字符串 'false'，
   * 真值会让整场讨论误入匿名轨，而报告上看不出来。
   */
  if (c.anonymousReview !== undefined && typeof c.anonymousReview !== 'boolean') {
    return '匿名互评开关必须是布尔值'
  }
  for (const key of ['baseline', 'baselineCompare'] as const) {
    if (c[key] !== undefined && typeof c[key] !== 'boolean') {
      return `${key} 开关必须是布尔值`
    }
  }
  if (c.verifyPass !== undefined && !['off', 'auto', 'always'].includes(String(c.verifyPass))) {
    return '幻觉核验模式非法（off / auto / always）'
  }
  if (c.timeBudgetMs !== undefined) {
    if (typeof c.timeBudgetMs !== 'number' || !Number.isFinite(c.timeBudgetMs) || c.timeBudgetMs < 0 || c.timeBudgetMs > TIME_BUDGET_MAX_MS) {
      return `时长预算必须为 0~${Math.round(TIME_BUDGET_MAX_MS / 60000)} 分钟的毫秒数`
    }
  }
  return null
}

/**
 * 补齐并夹紧本场配置。
 *
 * 三个治理开关都是**新字段**，旧偏好与旧存档里根本没有；
 * 主进程不能假设渲染端一定会传 —— 传了非法值走上面的校验拒绝，
 * 没传则在这里给明确的缺省，避免 undefined 在编排器里被当成 falsy 而语义漂移。
 * 时长预算同理：过小等于没有闸门，直接抬到下限。
 */
function normalizeSessionConfig(config: SessionConfig): SessionConfig {
  const out: SessionConfig = { ...config }
  // 收束不再看分数线：判定只认结构条件，所以本场配置不带阈值。
  // 渲染端就算传来旧值也一并丢掉 —— 留着它，界面就会画出一条没人遵守的参考线。
  // 旧存档里各自记着当年的那条线，只在回看时显示。
  delete out.consensusThreshold
  out.baseline = out.baseline ?? true
  out.baselineCompare = out.baselineCompare ?? true
  out.verifyPass = out.verifyPass ?? VERIFY_PASS_DEFAULT
  const t = out.timeBudgetMs
  out.timeBudgetMs =
    typeof t === 'number' && Number.isFinite(t) && t > 0
      ? Math.max(TIME_BUDGET_MIN_MS, Math.min(TIME_BUDGET_MAX_MS, Math.round(t)))
      : TIME_BUDGET_DEFAULT_MS
  return out
}

// ---------------------------------------------------------------------------
// 模型阵容
// ---------------------------------------------------------------------------

/** 用户自建适配器目录 */
function userAdaptersDir(): string {
  return path.join(dataDir(), 'adapters')
}

/** 用户自建模型清单 */
function userModelsFile(): string {
  return path.join(dataDir(), 'models.json')
}

/** 偏好设置（参与者/主持人的上次选择、主题） */
function preferencesFile(): string {
  return path.join(dataDir(), 'preferences.json')
}

/** 读偏好文件，坏了或不存在就当空对象 */
async function readPreferences(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(preferencesFile(), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 只合并传入的键，不整份覆盖。
 *
 * 偏好文件同时装着参与者选择与主题，任何一处按「我关心的那个字段」写文件
 * 都会把另一处刚存的东西抹掉 —— 主题曾因此被一次普通的偏好保存清掉。
 */
async function patchPreferences(patch: Record<string, unknown>): Promise<void> {
  const merged = { ...(await readPreferences()), ...patch }
  await fs.mkdir(dataDir(), { recursive: true })
  await fs.writeFile(preferencesFile(), JSON.stringify(merged, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// 模型侧栏状态：顺序 / 停用 / 隐藏
//
// 三类都是「用户对本机模型阵容的偏好」，与 participantIds 一样存 preferences，
// 单独收在一个键下，避免和主题、上次选择互相覆盖：
// - order：拖动排序后的 id 序列（未知 id 在列表时按原序补到末尾）
// - disabled：被「停用」的 id —— 仍显示但灰显、不参与讨论，可随时恢复
// - hidden：从侧栏「移除」的内置模型 id —— 内置不可真删，隐藏后设置页可恢复
// ---------------------------------------------------------------------------

interface ModelState extends ModelOrderState {
  disabled: string[]
}

let modelState: ModelState = { order: [], disabled: [], hidden: [] }

function normalizeModelState(raw: unknown): ModelState {
  const o = (raw ?? {}) as Partial<ModelState>
  const strs = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []
  return { order: strs(o.order), disabled: strs(o.disabled), hidden: strs(o.hidden) }
}

async function loadModelState(): Promise<void> {
  const prefs = await readPreferences()
  modelState = normalizeModelState(prefs.modelState)
}

async function persistModelState(): Promise<void> {
  await patchPreferences({ modelState })
}

// ---------------------------------------------------------------------------
// 全局快捷键：一键唤起 / 最小化应用
//
// 配置存进 preferences.json 的 hotkey 键（与主题、模型阵容同文件不同键，靠
// patchPreferences 的合并写避免互相覆盖）。Accelerator 是 Electron 的字符串格式，
// 如 'CommandOrControl+Alt+T'；真正能不能挂上以 globalShortcut.register 的返回为准。
// ---------------------------------------------------------------------------

const DEFAULT_HOTKEY_ACCEL = 'CommandOrControl+Alt+T'

let hotkey: HotkeyConfig = { enabled: true, accel: DEFAULT_HOTKEY_ACCEL }
let hotkeyRegistered = false
let hotkeyError: string | undefined

function hotkeyState(): HotkeyState {
  return { ...hotkey, registered: hotkeyRegistered, error: hotkeyError }
}

function normalizeHotkey(raw: unknown): HotkeyConfig {
  const o = (raw ?? {}) as Partial<HotkeyConfig>
  const accel = typeof o.accel === 'string' ? o.accel.trim() : ''
  return { enabled: o.enabled !== false, accel: accel || DEFAULT_HOTKEY_ACCEL }
}

/** 唤起 / 最小化的切换：当前正显示且已聚焦就最小化，否则拉到前台 */
function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  const frontmost = mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()
  if (frontmost) {
    mainWindow.minimize()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 按当前配置重挂全局快捷键。
 *
 * 先 unregisterAll 再注册：改键时若不撤旧的，两条 accelerator 会同时挂着 ——
 * 老键还能唤起、设置页却显示新键，用户两头对不上。globalShortcut 只在 app ready
 * 后可用，调用点都满足（启动在 whenReady 里，改键走 IPC）。
 */
function applyHotkey(): void {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* 尚未 ready 时无副作用 */
  }
  hotkeyRegistered = false
  hotkeyError = undefined
  if (!hotkey.enabled) return
  if (!hotkey.accel) {
    hotkeyError = '还没设置快捷键'
    return
  }
  try {
    hotkeyRegistered = globalShortcut.register(hotkey.accel, toggleMainWindow)
  } catch {
    hotkeyRegistered = false
    // 不把原始 accel 拼进提示：那是 Electron 的写法（CommandOrControl+…），
    // 设置页会按当前系统渲染成 ⌘ / Ctrl，两处各说各的只会让人以为是两个键。
    hotkeyError = '快捷键格式无效，至少要带一个修饰键'
  }
  if (!hotkeyRegistered && !hotkeyError) {
    hotkeyError = '快捷键注册失败，可能已被其它程序占用'
  }
}

async function loadHotkey(): Promise<void> {
  hotkey = normalizeHotkey((await readPreferences()).hotkey)
}

async function persistHotkey(): Promise<void> {
  await patchPreferences({ hotkey })
}

// ---------------------------------------------------------------------------
// 助手能力开关：技能 / 扩展
//
// 默认关。扩展是 JS 代码，一旦加载就直接在主进程里跑，绕开确认卡片那道写操作
// 闸门 —— 所以开关放在设置页，且改开关会把助手会话拆掉重开（见 assistant/bridge）。
// ---------------------------------------------------------------------------

let assistantExtensions = false
/** 「允许助手自建工具」：默认关。开着时助手能往本机加清单 / 技能 / 待审扩展，每一步都有确认卡片 */
let assistantSelfAuthoring = false
/**
 * 助手写操作的审批偏好：默认「每次询问」。
 * 放在主进程而不是渲染层，是因为确认卡片由主进程结算 —— 界面刷新了、
 * 抽屉关了，倒计时该不该放行都得照旧执行，偏好不能跟着渲染层一起没。
 */
let assistantApproval: AssistantApprovalPrefs = { ...APPROVAL_PREFS_DEFAULT }
/**
 * 上一场挑过的项目目录（@ 引用的默认候选根）。
 *
 * 记住 ≠ 授权：它只让浮层能给出一行「继续用「X」」，点下去才算这一场的授权。
 */
let assistantLastWorkDir: string | undefined

async function loadAssistantExtensions(): Promise<void> {
  const prefs = await readPreferences()
  const o = prefs.assistantPrefs as
    | { extensions?: unknown; selfAuthoring?: unknown; approvalMode?: unknown; approveTimeoutMs?: unknown; lastWorkDir?: unknown }
    | undefined
  assistantExtensions = o?.extensions === true
  assistantSelfAuthoring = o?.selfAuthoring === true
  const mode = o?.approvalMode
  assistantApproval = {
    mode: isApprovalMode(mode) ? mode : APPROVAL_PREFS_DEFAULT.mode,
    timeoutMs: clampApprovalTimeout(o?.approveTimeoutMs),
  }
  // 只认绝对路径：相对路径意味着这份文件被手改过，而「相对到谁」没人说得清
  const last = typeof o?.lastWorkDir === 'string' ? o.lastWorkDir.trim() : ''
  assistantLastWorkDir = last && path.isAbsolute(last) ? last : undefined
}

/** 开关和审批偏好合存在同一个 preferences 对象里，所以任一 setter 都要把其余项的当前值一并写回 */
function persistAssistantFlags(): Promise<unknown> {
  return patchPreferences({
    assistantPrefs: {
      extensions: assistantExtensions === true,
      selfAuthoring: assistantSelfAuthoring === true,
      approvalMode: assistantApproval.mode,
      approveTimeoutMs: assistantApproval.timeoutMs,
      // 没有就整个不给：这一键缺席即「没记住过」，留空字符串会被读成一个坏路径
      ...(assistantLastWorkDir ? { lastWorkDir: assistantLastWorkDir } : {}),
    },
  })
}

async function persistAssistantExtensions(on: boolean): Promise<void> {
  assistantExtensions = on
  await persistAssistantFlags()
}

async function persistSelfAuthoring(on: boolean): Promise<void> {
  assistantSelfAuthoring = on
  await persistAssistantFlags()
}

/** 把停用态同步回内存模型数组（list/编排都以 m.enabled 为准） */
function applyModelStateToMemory(): void {
  const disabled = new Set(modelState.disabled)
  for (const m of models) m.enabled = !disabled.has(m.id)
}

/** 侧栏可见模型：剔除隐藏项，按 order 排序，未收录的新模型按原序补到末尾 */
function visibleOrderedModels(): ModelConfig[] {
  return visibleInOrder(models, modelState)
}

const isUserModel = (m: ModelConfig): boolean =>
  !!m.partition?.startsWith('persist:torra-user-') || m.id.startsWith('api-user-')

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

let themeMode: ThemeMode = DEFAULT_THEME_MODE

/** 冷启动就要知道主题，所以这里用同步读；调用点在建窗口之前 */
function loadThemeMode(): ThemeMode {
  try {
    const raw = readFileSync(preferencesFile(), 'utf8') as string
    const parsed = JSON.parse(raw) as { theme?: unknown }
    return isThemeMode(parsed.theme) ? parsed.theme : DEFAULT_THEME_MODE
  } catch {
    return DEFAULT_THEME_MODE
  }
}

function resolvedTheme(): ThemeResolved {
  return resolveTheme(themeMode, nativeTheme.shouldUseDarkColors)
}

/** 窗口底色 + 渲染层 data-theme 一起换：只改 CSS 的话，切换瞬间会闪一下旧底色 */
function applyThemeToWindows(resolved: ThemeResolved): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(resolved === 'dark' ? '#0f1115' : '#faf9f7')
    win.webContents.send('theme:resolved', resolved)
  }
}

function initTheme(): void {
  themeMode = loadThemeMode()
  // 交给 Chromium 当 themeSource，「跟随系统」时系统切换会回调我们
  nativeTheme.themeSource = themeMode === 'system' ? 'system' : themeMode
  nativeTheme.on('updated', () => {
    if (themeMode !== 'system') return
    applyThemeToWindows(resolvedTheme())
  })
  // preload 在页面第一帧之前要同步问到明暗（CSP script-src 'self' 塞不进内联引导脚本）。
  // 必须在这里注册而不是 registerIpc()：那个 handler 建窗口之后才挂上，
  // sendSync 问不到就只能回落到默认值，切了白天仍会黑一下开场。
  ipcMain.on('theme:boot', (e) => {
    e.returnValue = resolvedTheme()
  })
}

/**
 * 体检依赖注入。
 *
 * 会话进行中以本场的主持为准，否则读偏好 —— 否则体检会把「马上要开始的那场」
 * 判成无主持，用户看到的结论与他即将经历的失败不一致。
 */
function doctorDeps(): DoctorDeps {
  return {
    pool,
    registry,
    models: () => models,
    secrets,
    store,
    moderatorId: () => currentConfig?.moderatorId ?? prefsModeratorId(),
    rootDir: dataDir(),
  }
}

function prefsModeratorId(): string | null {
  try {
    const raw = readFileSync(preferencesFile(), 'utf8') as string
    const p = JSON.parse(raw) as { moderatorId?: string | null }
    return p.moderatorId ?? null
  } catch {
    return null
  }
}

/**
 * 头像标识色轮转池。用户新建模型时按顺序取色，
 * 避免所有人默认同一个颜色而失去区分度（PRD 9 色彩纪律）。
 */
const USER_COLOR_POOL = [
  '#e8734a', '#3fb8a4', '#b57edc', '#e0a33e',
  '#5c9ded', '#d2649c', '#6fbf5f', '#c26a6a',
]

function loadDefaultModels(): ModelConfig[] {
  return [
    {
      id: 'chatgpt',
      displayName: 'ChatGPT',
      transport: 'webview',
      partition: 'persist:torra-chatgpt',
      adapterId: 'chatgpt',
      color: '#5aa9e6',
      supportsStructuredOutput: true,
      enabled: true,
    },
    {
      id: 'claude',
      displayName: 'Claude',
      transport: 'webview',
      partition: 'persist:torra-claude',
      adapterId: 'claude',
      color: '#d97757',
      supportsStructuredOutput: true,
      enabled: true,
    },
    {
      id: 'gemini',
      displayName: 'Gemini',
      transport: 'webview',
      partition: 'persist:torra-gemini',
      adapterId: 'gemini',
      color: '#3fb950',
      supportsStructuredOutput: true,
      enabled: true,
    },
    {
      // DeepSeek 网页版。此前 DeepSeek 仅配置为 api 通道，
      // 导致点击头像走 webview:present 时池中无实例、直接返回 {ok:false} ——
      // 表现就是「网页版打不开」。
      id: 'deepseek-web',
      displayName: 'DeepSeek·网页',
      transport: 'webview',
      partition: 'persist:torra-deepseek-web',
      adapterId: 'deepseek',
      color: '#4d6bfe',
      supportsStructuredOutput: true,
      enabled: true,
    },
    {
      id: 'qwen',
      displayName: '通义千问·网页',
      transport: 'webview',
      partition: 'persist:torra-qwen',
      adapterId: 'qwen',
      color: '#7c5cff',
      supportsStructuredOutput: true,
      enabled: true,
    },
    {
      id: 'doubao',
      displayName: '豆包·网页',
      transport: 'webview',
      partition: 'persist:torra-doubao',
      adapterId: 'doubao',
      color: '#2f7fd1',
      supportsStructuredOutput: true,
      enabled: true,
    },
    {
      id: 'kimi',
      displayName: 'Kimi·网页',
      transport: 'webview',
      partition: 'persist:torra-kimi',
      adapterId: 'kimi',
      color: '#1f9e8f',
      supportsStructuredOutput: true,
      enabled: true,
    },
  ]
}

/**
 * 合并用户自建模型。
 * 单独存 models.json 而非混入代码，是为了不改 TypeScript 源码
 * 就能新增网页版 LLM —— 这是「不支持自己配置」的核心修复点。
 */
async function mergeUserModels(): Promise<void> {
  let list: ModelConfig[] = []
  try {
    list = JSON.parse(await fs.readFile(userModelsFile(), 'utf8')) as ModelConfig[]
  } catch {
    return
  }
  if (!Array.isArray(list)) return
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(m.id)) continue
    if (models.some((x) => x.id === m.id)) continue // 不覆盖内置
    // API 模型不需要 partition
    if (m.transport === 'api') {
      if (
        !m.id.startsWith('api-user-') ||
        !m.api ||
        typeof m.api.baseUrl !== 'string' ||
        typeof m.api.model !== 'string' ||
        (m.api.protocol !== undefined && !['openai', 'anthropic'].includes(m.api.protocol)) ||
        !Number.isFinite(m.api.pricePerMTokIn) ||
        !Number.isFinite(m.api.pricePerMTokOut)
      ) continue
      try {
        const u = new URL(m.api.baseUrl)
        if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) continue
      } catch {
        continue
      }
      // 手工维护 models.json 或旧版本落盘的 0 单价：按公开价目补齐。
      // 只补两个 0 都算「没配过价」的条目，用户显式写过的数字一律不动。
      const noPrice = !(m.api.pricePerMTokIn > 0) && !(m.api.pricePerMTokOut > 0)
      const listed = noPrice ? lookupPublicPrice(m.api.model) : null
      models.push(
        listed
          ? { ...m, api: { ...m.api, pricePerMTokIn: listed.pricePerMTokIn, pricePerMTokOut: listed.pricePerMTokOut } }
          : { ...m },
      )
    } else if (m.transport === 'webview' && m.id.startsWith('web-')) {
      const partition = m.partition ?? `persist:torra-user-${m.id}`
      if (!partition.startsWith('persist:torra-user-')) continue
      models.push({ ...m, partition })
    }
  }
}

/** 持久化用户自建模型（webview 型 + api 型） */
async function persistUserModels(): Promise<void> {
  const userModels = models.filter(
    (m) => m.partition?.startsWith('persist:torra-user-') || m.id.startsWith('api-user-'),
  )
  await fs.mkdir(dataDir(), { recursive: true })
  await fs.writeFile(userModelsFile(), JSON.stringify(userModels, null, 2), 'utf8')
}

interface NewModelInput {
  displayName: string
  entry: string
  color?: string
  selectors?: {
    input: string
    send?: string
    stop?: string
    generating?: string
    stream: string
  }
  input_kind?: 'textarea' | 'contenteditable'
  send_mode?: 'click' | 'enter'
  stream_mode?: 'last' | 'all'
  completion_mode?: 'stop_button_hidden' | 'generating_absent' | 'dom_stable'
  stable_ms?: number
  max_wait_s?: number
}

interface NewApiModelInput {
  displayName: string
  baseUrl: string
  apiKey: string
  model: string
  protocol?: 'openai' | 'anthropic'
  color?: string
  pricePerMTokIn?: number
  pricePerMTokOut?: number
  maxContextTokens?: number
  /** 能否稳定输出可解析 JSON —— 决定它有没有资格当主持人。缺省按协议推断 */
  supportsStructuredOutput?: boolean
  /** 端点是否接受图片输入（视觉）。缺省 false */
  vision?: boolean
}

/** 编辑已有 API 模型：缺省的字段沿用当前配置，apiKey 缺省/空串表示不动钥匙串 */
interface EditApiModelInput extends Partial<Omit<NewApiModelInput, 'apiKey'>> {
  apiKey?: string
}

/** 校验通过后的 API 模型字段，价格与上限已补齐默认值 */
interface NormalizedApiModelInput {
  displayName: string
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic'
  apiKey?: string
  pricePerMTokIn: number
  pricePerMTokOut: number
  maxContextTokens: number
  vision: boolean
  supportsStructuredOutput: boolean
  color?: string
}

/** 站点地址必须是带 host 的 http(s) —— file:/data: 之类不允许写进配置 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname
  } catch {
    return false
  }
}

/**
 * 新建网页版模型：一条命令同时建适配器 YAML 与模型条目。
 * 选择器全部缺省时生成一个 dom_stable 的骨架（可运行），
 * 而非拒绝创建 —— 用户随后可在页面上拾取校准。
 */
async function createWebModel(input: NewModelInput): Promise<{ ok: boolean; errors?: string[]; id?: string }> {
  if (!input || typeof input !== 'object') return { ok: false, errors: ['配置格式非法'] }
  const name = String(input.displayName ?? '').trim()
  const entry = String(input.entry ?? '').trim()
  if (!name) return { ok: false, errors: ['名称不能为空'] }
  try {
    const parsed = new URL(entry)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      return { ok: false, errors: ['入口地址必须是有效的 http(s) URL'] }
    }
  } catch {
    return { ok: false, errors: ['入口地址必须是有效的 http(s) URL'] }
  }

  // id 与规格映射都在 setup/web-spec.ts，与离线真机验证（doctor --live）共用一份
  const slug = webModelSlug(name)

  let id = `web-${slug}`
  let n = 2
  while (registry.get(id) || models.some((m) => m.id === id)) {
    id = `web-${slug}-${n}`
    n += 1
  }

  const spec = webSpecFromPlan(id, input)

  const saved = await registry.saveUser(spec)
  if (!saved.ok) return { ok: false, errors: saved.errors }

  const usedColors = new Set(models.map((m) => m.color))
  const color = input.color || USER_COLOR_POOL.find((c) => !usedColors.has(c)) || USER_COLOR_POOL[0]!

  const cfg: ModelConfig = {
    id,
    displayName: name,
    transport: 'webview',
    // 用 user- 前缀标记，使其能被 persistUserModels 识别为用户自建
    partition: `persist:torra-user-${id}`,
    adapterId: id,
    color,
    supportsStructuredOutput: false, // 网页版无 system prompt，无法保证 JSON 结构化输出
    enabled: true,
  }
  models.push(cfg)
  try {
    await persistUserModels()
  } catch (e) {
    models.pop()
    pool.disposeEntry(id)
    await registry.removeUser(id)
    return { ok: false, errors: [(e as Error).message] }
  }

  const rt = registry.get(id)
  if (rt) pool.ensure(id, rt, cfg.partition)

  send('models:changed', {})
  return { ok: true, id }
}

/** 删除用户自建模型（连同其适配器） */
async function deleteWebModel(modelId: string): Promise<{ ok: boolean; reason?: string }> {
  const idx = models.findIndex((m) => m.id === modelId)
  if (idx < 0) return { ok: false, reason: '模型不存在' }
  const cfg = models[idx]!
  const isUserWeb = cfg.partition?.startsWith('persist:torra-user-')
  const isUserApi = cfg.id.startsWith('api-user-')
  if (!isUserWeb && !isUserApi) {
    return { ok: false, reason: '内置模型不可删除' }
  }
  agents.get(modelId)?.dispose()
  agents.delete(modelId)
  if (isUserWeb) pool.disposeEntry(modelId)
  models.splice(idx, 1)
  try {
    await persistUserModels()
  } catch (e) {
    models.splice(idx, 0, cfg)
    return { ok: false, reason: (e as Error).message }
  }
  if (isUserApi && cfg.api) await secrets.delete(cfg.api.apiKeyRef).catch(() => undefined)
  if (cfg.adapterId) await registry.removeUser(cfg.adapterId)
  send('models:changed', {})
  return { ok: true }
}

/**
 * API 模型可编辑字段的校验与规整，新建与编辑共用一份。
 * 分成两处写同样的规则，迟早会变成「能创建、却改不成同样的值」这类难查的差异。
 *
 * requireKey=true 用于新建（此刻钥匙串里还没有值）；编辑时缺省表示沿用旧 Key。
 */
function normalizeApiModelInput(
  input: Partial<NewApiModelInput>,
  requireKey: boolean,
): { errors: string[] } | { value: NormalizedApiModelInput } {
  const errors: string[] = []
  const name = String(input.displayName ?? '').trim()
  if (!name) errors.push('名称不能为空')

  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/$/, '')
  if (!isHttpUrl(baseUrl)) errors.push('Base URL 必须是有效的 http(s) 地址')

  const model = String(input.model ?? '').trim()
  if (!model) errors.push('模型名不能为空')

  const protocol = input.protocol ?? 'openai'
  if (!['openai', 'anthropic'].includes(protocol)) errors.push('API 协议非法')

  const apiKey = input.apiKey === undefined ? undefined : String(input.apiKey).trim()
  if (requireKey && !apiKey) errors.push('API Key 不能为空')
  if (apiKey && apiKey.length > 20_000) errors.push('API Key 过长')

  for (const [label, value] of [
    ['输入价格', input.pricePerMTokIn],
    ['输出价格', input.pricePerMTokOut],
  ] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      errors.push(`${label}必须是非负数字`)
    }
  }
  if (input.maxContextTokens !== undefined && (!Number.isInteger(input.maxContextTokens) || input.maxContextTokens < 1)) {
    errors.push('上下文长度必须是正整数')
  }

  if (errors.length > 0) return { errors }
  // 单价：调用方给的正数优先；没给或给 0 时按各家公开价目兜底（src/shared/model-prices.ts）。
  // 认不出的一律留 0 —— 留 0 会被 doctor 报成「未配置单价」，比拿猜测的高价污染费用口径好诊断。
  const pos = (v?: number) => (typeof v === 'number' && v > 0 ? v : undefined)
  const listed = lookupPublicPrice(model)
  return {
    value: {
      displayName: name,
      baseUrl,
      model,
      protocol,
      apiKey,
      pricePerMTokIn: pos(input.pricePerMTokIn) ?? listed?.pricePerMTokIn ?? 0,
      pricePerMTokOut: pos(input.pricePerMTokOut) ?? listed?.pricePerMTokOut ?? 0,
      maxContextTokens: input.maxContextTokens ?? 128_000,
      vision: input.vision ?? false,
      // 不支持结构化输出的端点不能当主持人；Anthropic 兼容层不保证 JSON，按协议推断
      supportsStructuredOutput: input.supportsStructuredOutput ?? protocol === 'openai',
      color: input.color,
    },
  }
}

/** 新建用户自定义 API 模型 */
async function createApiModel(input: NewApiModelInput): Promise<{ ok: boolean; errors?: string[]; id?: string }> {
  if (!input || typeof input !== 'object') return { ok: false, errors: ['配置格式非法'] }
  const normalized = normalizeApiModelInput(input, true)
  if ('errors' in normalized) return { ok: false, errors: normalized.errors }
  const v = normalized.value
  const name = v.displayName
  const baseUrl = v.baseUrl
  const model = v.model
  const apiKey = v.apiKey ?? ''

  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'custom'

  let id = `api-user-${slug}`
  let n = 2
  while (models.some((m) => m.id === id)) {
    id = `api-user-${slug}-${n}`
    n += 1
  }

  const apiKeyRef = `${id}:key`
  try {
    await secrets.set(apiKeyRef, apiKey)
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] }
  }

  const usedColors = new Set(models.map((m) => m.color))
  const color = v.color || USER_COLOR_POOL.find((c) => !usedColors.has(c)) || USER_COLOR_POOL[0]!

  const cfg: ModelConfig = {
    id,
    displayName: name,
    transport: 'api',
    api: {
      baseUrl,
      model,
      apiKeyRef,
      protocol: v.protocol,
      pricePerMTokIn: v.pricePerMTokIn,
      pricePerMTokOut: v.pricePerMTokOut,
      maxContextTokens: v.maxContextTokens,
      vision: v.vision,
    },
    color,
    supportsStructuredOutput: v.supportsStructuredOutput,
    enabled: true,
  }
  models.push(cfg)
  try {
    await persistUserModels()
  } catch (e) {
    models.pop()
    await secrets.delete(apiKeyRef).catch(() => undefined)
    return { ok: false, errors: [(e as Error).message] }
  }
  send('models:changed', {})
  return { ok: true, id }
}

/**
 * 编辑已有 API 模型。
 *
 * id 与钥匙串引用（`${id}:key`）保持不变 —— 讨论记录、已存 Key、侧栏顺序都挂在 id 上；
 * 改名只改 displayName。apiKey 缺省或空串表示不动钥匙串：渲染层拿不到旧 Key，
 * 也就无处回显，界面上只能填新值。
 */
async function updateApiModel(
  modelId: string,
  patch: EditApiModelInput,
): Promise<{ ok: boolean; errors?: string[] }> {
  if (!patch || typeof patch !== 'object') return { ok: false, errors: ['配置格式非法'] }
  const idx = models.findIndex((m) => m.id === modelId)
  if (idx < 0) return { ok: false, errors: ['模型不存在'] }
  const cfg = models[idx]!
  if (cfg.transport !== 'api' || !cfg.api || !cfg.id.startsWith('api-user-')) {
    return { ok: false, errors: ['仅用户自建的 API 模型可编辑'] }
  }

  const merged: Partial<NewApiModelInput> = {
    displayName: patch.displayName ?? cfg.displayName,
    baseUrl: patch.baseUrl ?? cfg.api.baseUrl,
    model: patch.model ?? cfg.api.model,
    protocol: patch.protocol ?? cfg.api.protocol ?? 'openai',
    pricePerMTokIn: patch.pricePerMTokIn ?? cfg.api.pricePerMTokIn,
    pricePerMTokOut: patch.pricePerMTokOut ?? cfg.api.pricePerMTokOut,
    maxContextTokens: patch.maxContextTokens ?? cfg.api.maxContextTokens,
    vision: patch.vision ?? cfg.api.vision ?? false,
    supportsStructuredOutput: patch.supportsStructuredOutput ?? cfg.supportsStructuredOutput,
    color: patch.color ?? cfg.color,
    apiKey: typeof patch.apiKey === 'string' && patch.apiKey.trim() ? patch.apiKey.trim() : undefined,
  }
  const normalized = normalizeApiModelInput(merged, false)
  if ('errors' in normalized) return { ok: false, errors: normalized.errors }
  const v = normalized.value

  const prev: ModelConfig = { ...cfg, api: { ...cfg.api! } }
  const keyRef = cfg.api.apiKeyRef
  const prevKey = v.apiKey ? secrets.get(keyRef) : null
  if (v.apiKey) {
    try {
      await secrets.set(keyRef, v.apiKey)
    } catch (e) {
      return { ok: false, errors: [(e as Error).message] }
    }
  }

  // 原地改字段而非替换数组项：其他持有 ModelConfig 引用的地方（池、状态表）不用跟着换
  const apply = (src: ModelConfig): void => {
    Object.assign(cfg, src)
    cfg.api = { ...src.api! }
  }
  apply({
    ...cfg,
    displayName: v.displayName,
    color: v.color ?? cfg.color,
    supportsStructuredOutput: v.supportsStructuredOutput,
    api: {
      ...cfg.api,
      baseUrl: v.baseUrl,
      model: v.model,
      protocol: v.protocol,
      pricePerMTokIn: v.pricePerMTokIn,
      pricePerMTokOut: v.pricePerMTokOut,
      maxContextTokens: v.maxContextTokens,
      vision: v.vision,
    },
  })

  try {
    await persistUserModels()
  } catch (e) {
    apply(prev)
    if (v.apiKey) {
      // 新 Key 已经落进钥匙串但配置没写进去 —— 回滚成旧值，原先没有就删掉
      if (prevKey === null) await secrets.delete(keyRef).catch(() => undefined)
      else await secrets.set(keyRef, prevKey).catch(() => undefined)
    }
    return { ok: false, errors: [(e as Error).message] }
  }

  /*
   * ApiAgent 在构造时抓走了 displayName 与 api 对象，留着旧实例就会继续打旧端点。
   * 这里必须丢弃缓存（与删除模型同理），下一次 getAgent 用新配置重建。
   */
  agents.get(modelId)?.dispose()
  agents.delete(modelId)
  send('models:changed', {})
  return { ok: true }
}

/** 供编辑弹窗预填：只给可编辑的配置字段，Key 本身永不出主进程 */
function apiModelConfig(modelId: string): { ok: boolean; errors?: string[]; config?: ApiModelEditableConfig } {
  const cfg = models.find((m) => m.id === modelId)
  if (!cfg) return { ok: false, errors: ['模型不存在'] }
  if (cfg.transport !== 'api' || !cfg.api || !cfg.id.startsWith('api-user-')) {
    return { ok: false, errors: ['仅用户自建的 API 模型可编辑'] }
  }
  return {
    ok: true,
    config: {
      displayName: cfg.displayName,
      baseUrl: cfg.api.baseUrl,
      model: cfg.api.model,
      protocol: cfg.api.protocol ?? 'openai',
      color: cfg.color,
      pricePerMTokIn: cfg.api.pricePerMTokIn,
      pricePerMTokOut: cfg.api.pricePerMTokOut,
      maxContextTokens: cfg.api.maxContextTokens,
      supportsStructuredOutput: cfg.supportsStructuredOutput,
      vision: cfg.api.vision ?? false,
      hasKey: secrets.has(cfg.api.apiKeyRef),
    },
  }
}

interface ApiModelEditableConfig {
  displayName: string
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic'
  color: string
  pricePerMTokIn: number
  pricePerMTokOut: number
  maxContextTokens: number
  supportsStructuredOutput: boolean
  vision: boolean
  hasKey: boolean
}

/** 从远程 API 拉取可用模型列表（OpenAI /models 端点） */
async function listRemoteModels(baseUrl: string, apiKey: string): Promise<{
  ok: boolean
  models?: Array<{ id: string; name?: string }>
  error?: string
}> {
  if (typeof baseUrl !== 'string' || typeof apiKey !== 'string' || apiKey.length === 0) {
    return { ok: false, error: 'Base URL 或 API Key 非法' }
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('invalid URL')
  } catch {
    return { ok: false, error: 'Base URL 必须是有效的 http(s) 地址' }
  }
  const url = `${parsed.toString().replace(/\/$/, '')}/models`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { data?: Array<{ id: string }> }
    const list = (body.data ?? []).map((m) => ({ id: m.id, name: m.id }))
    return { ok: true, models: list }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function getAgent(id: string): Agent | undefined {
  const cached = agents.get(id)
  if (cached) return cached

  const cfg = models.find((m) => m.id === id)
  if (!cfg) return undefined

  let a: Agent
  if (cfg.transport === 'webview') {
    const rt = registry.get(cfg.adapterId ?? '')
    if (!rt) return undefined
    pool.ensure(cfg.id, rt, cfg.partition)
    a = new WebviewAgent(
      cfg.id,
      cfg.displayName,
      cfg.color,
      pool,
      rt,
      cfg.partition ?? `persist:torra-${cfg.id}`,
    )
  } else {
    if (!cfg.api) return undefined
    a = new ApiAgent(cfg.id, cfg.displayName, cfg.color, cfg.api, (ref) => secrets.get(ref))
  }
  agents.set(id, a)
  return a
}

function modelName(id: string): string {
  return models.find((m) => m.id === id)?.displayName ?? id
}

/**
 * 真机试发言：让已注册的网页模型完整跑一轮（键入 → 发送 → 等回复 → 读取）。
 *
 * 为什么非要真发一次：体检各层都是静态观测，「选择器命中」不等于「这条链发得出去」——
 * 元宝就是在体检全绿的情况下报「input vanished before send」的（Quill 的 .ql-blank
 * 随文本落地被移除，发送阶段按选择器重查找不到框）。建完模型只有跑通一轮才算验过。
 */
async function runWebTurn(
  modelId: string,
  text: string,
): Promise<{ ok: boolean; reason?: string; chars?: number; preview?: string; ms?: number }> {
  const agent = getAgent(modelId)
  if (!agent) return { ok: false, reason: `${modelId} 没有可用通道（模型不存在、已停用或适配器缺失）` }
  if (agent.transport !== 'webview') {
    return { ok: false, reason: `${agent.displayName} 走 API 通道，不需要真机试发言` }
  }
  const prompt = String(text ?? '').trim().slice(0, 200) || '用一句话介绍你自己'
  const sessionId = `verify:${modelId}`
  const t0 = Date.now()
  const ctx: TurnContext = {
    sessionId,
    round: 1,
    topic: { id: sessionId, title: prompt, background: '', strategy: 'roundtable', attachments: [], createdAt: t0 },
    digest: { confirmed: [], open: [], explored: [], rounds: [] },
    callout: null,
    maxLenChars: 400,
    chat: { history: [{ role: 'user', content: prompt }] },
  }
  try {
    const res = await agent.send(ctx, () => {})
    const content = String(res.content ?? '')
    if (!content.trim()) {
      return { ok: false, reason: '生成结束但读取为空 —— 回复容器选择器多半指向了错的元素', ms: Date.now() - t0 }
    }
    return { ok: true, chars: content.length, preview: content.slice(0, 160), ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, reason: (e as Error).message, ms: Date.now() - t0 }
  }
}

/**
 * 适配器热更新（PRD 6.6）：registry 已原地替换 spec，持有同一对象的 agent
 * 下一次发言即用新选择器；这里清掉缓存是为了丢弃旧的 adapter-broken 状态，
 * 并在 entry 变化时把后台 WebView 导航到新地址。
 */
function applyAdapterChange(adapterId: string): void {
  const rt = registry.get(adapterId)
  for (const m of models) {
    if (m.adapterId !== adapterId) continue
    agents.delete(m.id)
    if (rt) pool.refreshEntry(m.id, rt)
  }
  console.log(`[adapter] ${adapterId} 已热更新${rt ? '' : '（文件已移除）'}`)
  send('adapters:changed', { adapterId })
}

/**
 * 探测各 webview 实例的真实状态并同步到适配器注册表。
 *
 * 此前从不探测，状态灯一律取 Agent 的初始值 'ready'（绿）——
 * 无论该分区是否真的登录过。未登录的站点显示「就绪」，
 * 用户只能等讨论开始后才发现缺席，而缺席原因还被误报为适配器失效。
 */
/**
 * 复检全部 webview 模型。
 *
 * 只在状态真正翻转时才 send('models:changed')。
 * 这一点很关键：渲染层收到该事件会调 listModels，而 listModels
 * 又会触发 kickBackgroundProbe —— 若无条件推送，两者会互相触发
 * 形成无限刷新循环，表现为界面持续闪烁、CPU 占用飙升。
 */
async function probeAllAgents(): Promise<void> {
  const jobs = models
    .filter((m) => m.transport === 'webview')
    .map(async (m) => {
      const before = lastLoginState.get(m.id)
      try {
        await syncModelState(m, { notify: false })
      } catch {
        /* 单个探测失败不影响其他 */
      }
      const after = lastLoginState.get(m.id)
      return before !== after
    })
  const results = await Promise.all(jobs)
  if (results.some(Boolean)) send('models:changed', {})
}

/**
 * 同步单个模型的登录态与状态灯。
 *
 * 这是状态灯能否如实反映「能否发言」的唯一权威入口。
 *
 * 关键：必须同时更新 agent.status ——
 * 状态灯读的是 `getAgent(m.id)?.status`，而 agent 会被 agents Map 缓存。
 * 此前只更新 registry 的 health，agent.status 一直停在首次探测时的
 * 'expired' / 'adapter-broken'，于是登录成功后状态灯仍是红的，
 * 用户只能看着红色反复登录 —— 而实际登录早已成功。
 *
 * 判定顺序也重要：登录态优先于选择器。
 * 未登录时页面根本没有输入框，若先判选择器会把「未登录」误报成「适配器失效」，
 * 引导用户去更新一个根本没坏的适配器。
 */
async function syncModelState(
  m: ModelConfig,
  opts: { notify?: boolean; allowCreate?: boolean } = {},
): Promise<{ loggedIn: boolean; state: string }> {
  /*
   * 是否允许在探测时补建实例。
   *
   * 关键取舍：后台巡检必须传 allowCreate=false，否则「只启动已登录模型」
   * 的按需预热会被巡检第一轮击穿 —— 未登录模型被逐个 ensure() 出来，
   * 等于又回到启动即预热全部实例的老问题。
   *
   * 实例缺失时用 cookie 轻量判定给出结论即可（unknown = 未登录/未启动），
   * 不需要真实页面。用户点开页面或模型进入讨论时，ensureView() 会补建。
   */
  if (opts.allowCreate && !pool.has(m.id)) {
    const rt = m.adapterId ? registry.get(m.adapterId) : undefined
    if (rt) pool.ensure(m.id, rt, m.partition)
  }

  if (!pool.has(m.id)) {
    // 未预热：cookie 预检足以区分「从未登录」与「已登录待启动」
    let host = ''
    try {
      host = m.adapterId && registry.get(m.adapterId)
        ? new URL(registry.get(m.adapterId)!.spec.entry).hostname
        : ''
    } catch {
      host = ''
    }
    const probe = host
      ? await probeSessionCookies(m.partition ?? `persist:torra-${m.id}`, host)
      : { likelyLoggedIn: false, hits: [], total: 0, expiry: { authCookies: 0, sessionOnly: false } }

    const state = probe.likelyLoggedIn ? 'unknown' : 'logged-out'
    const reason = probe.likelyLoggedIn
      ? '检测到登录凭据，实例按需启动'
      : '未检测到登录凭据，实例按需启动（点头像可登录并启动）'
    lastLoginState.set(m.id, state)
    lastLoginReason.set(m.id, reason)
    lastCredExpiry.set(m.id, probe.expiry)
    const agent0 = getAgent(m.id)
    if (agent0 && agent0.status !== 'busy') agent0.status = 'expired'
    if (m.adapterId) registry.setHealth(m.adapterId, 'login-required', reason)
    if (opts.notify) {
      send('login:result', { modelId: m.id, ok: false, reason, state })
      send('models:changed', {})
    }
    return { loggedIn: false, state }
  }

  const loggedIn = await pool.inspectLogin(m.id)
  const isIn = loggedIn.state === 'logged-in'
  lastLoginState.set(m.id, loggedIn.state)
  lastLoginReason.set(m.id, loggedIn.reason)

  /*
   * 凭据有效期：inspectLogin 看的是页面，这里只看 cookie 的到期时间，所以未登录时
   * 也照读 —— 「凭据还没到期却被判未登录」和「根本没有凭据」在界面上必须分得开，
   * 前者是站点风控，后者才该去登录。
   * 读失败就清掉旧值：拿着上一轮的到期时间显示，比不显示更容易误导人。
   */
  try {
    const rt = m.adapterId ? registry.get(m.adapterId) : undefined
    const host = rt ? new URL(rt.spec.entry).hostname : ''
    const partition = pool.getPartition(m.id) ?? m.partition ?? `persist:torra-${m.id}`
    if (host) lastCredExpiry.set(m.id, await credentialExpiry(partition, host))
    else lastCredExpiry.delete(m.id)
  } catch {
    lastCredExpiry.delete(m.id)
  }

  // 适配器健康度：登录态直接决定，未登录不牵强解释为选择器问题
  if (m.adapterId) {
    registry.setHealth(
      m.adapterId,
      isIn ? 'ok' : 'login-required',
      isIn ? '' : loggedIn.reason,
    )
  }

  // 把结论写回 agent —— 状态灯读的就是这个值。
  // 登录成功时必须显式置 'ready'，否则状态灯不会翻绿。
  const agent = getAgent(m.id)
  if (agent && agent.status !== 'busy') {
    agent.status = isIn ? 'ready' : 'expired'
  }

  // 判定为已登录的瞬间立刻把凭据刷盘。
  // Chromium 的 cookie 走延迟写缓冲，不主动 flush 的话，
  // 用户刚登录完就关掉应用，登录凭据会随进程退出一起丢失 ——
  // 表现正是「重启后又要重新登录」。
  if (isIn) {
    try {
      await session.fromPartition(m.partition ?? `persist:torra-${m.id}`).flushStorageData()
    } catch {
      /* 分区不可用时忽略 */
    }
  }

  if (opts.notify) {
    send('login:result', { modelId: m.id, ok: isIn, reason: loggedIn.reason, state: loggedIn.state })
    send('models:changed', {})
  }

  return { loggedIn: isIn, state: loggedIn.state }
}

/**
 * 周期性复检登录态。
 *
 * 登录可能发生在 Torra 之外（用户自己在浏览器登录、或用同一分区登录过），
 * 也可能在没有任何导航事件的情况下自然失效（cookie 过期、站点改版）。
 * 只靠事件驱动会让状态灯长期停留在过期前的状态。
 */
function startLoginWatchdog(): void {
  const timer = setInterval(() => {
    void (async () => {
      for (const m of models.filter((x) => x.transport === 'webview')) {
        try {
          const before = getAgent(m.id)?.status
          const r = await syncModelState(m, { notify: false })
          const after = getAgent(m.id)?.status
          // 只在状态真的翻转时通知，避免每分钟弹一次提示
          if (before !== after) {
            const name = m.displayName
            send('login:result', {
              modelId: m.id,
              ok: r.loggedIn,
              reason: loggedIn2Reason(m),
              state: r.state,
            })
            console.log(`[watchdog] ${name}: ${before} -> ${after}`)
            send('models:changed', {})
          }
        } catch {
          /* 单个失败不影响其他 */
        }
      }
    })()
  }, 60_000)

  // 不阻止进程退出
  timer.unref?.()
}

function loggedIn2Reason(m: ModelConfig): string {
  return getAgent(m.id)?.status === 'ready' ? '已登录' : '登录态已失效，请重新登录'
}

/**
 * 前台展示与后台巡检必须复用同一个 WebContents。
 *
 * 页面可能已经在池中完成加载，但主进程的登录快照仍是启动时的旧值；
 * 仅调用 pool.present() 不会触发导航事件，状态灯就会继续显示红色。
 * 展示后等待当前实例就绪，再用同一实例做一次权威复核。
 */
async function syncPresentedModel(m: ModelConfig): Promise<void> {
  await pool.waitReady(m.id, 12_000)
  await syncModelState(m, { notify: true })
}

/**
 * 等各 WebView 首次加载完成后再探测。
 *
 * 站点为 SPA：did-finish-load 之后输入框还可能延迟数秒才挂载，
 * 过早探测会把「还在渲染」判成「适配器失效」，比不探测更糟。
 */
async function probeAllAgentsWhenReady(): Promise<void> {
  const deadline = Date.now() + 30_000
  const views = models
    .filter((m) => m.transport === 'webview')
    .map((m) => pool.get(m.id))
    .filter((v): v is NonNullable<typeof v> => !!v)

  await Promise.all(
    views.map(
      (v) =>
        new Promise<void>((resolve) => {
          if (!v.webContents.isLoading()) {
            resolve()
            return
          }
          const t = setTimeout(resolve, 15_000)
          v.webContents.once('did-finish-load', () => {
            clearTimeout(t)
            resolve()
          })
        }),
    ),
  )

  // 留出 SPA 挂载输入框的时间
  const remain = deadline - Date.now()
  if (remain > 0) await sleep(Math.min(remain, 2500))

  await probeAllAgents()
  reportLoginInventory()
}

/**
 * 按需预热：优先实例化 cookie 显示「可能已登录」的模型；
 * 对显式声明 prewarm 的站点，额外加载页面核验 localStorage/导航后凭据。
 *
 * 不创建实例也能判断登录态 —— cookie 在 session 层，
 * 读它不需要 WebContentsView。因此未登录模型可以完全跳过实例化，
 * 省下 250MB 内存与数秒加载时间。
 *
 * 未预热不等于不可用：用户点开页面、或模型进入讨论名单时，
 * 都会走 ensure() 补建实例（见 WebviewAgent.ensureView）。
 */
async function warmLikelyLoggedIn(): Promise<void> {
  const webviews = models.filter((m) => m.transport === 'webview')
  const warmed: string[] = []
  const skipped: string[] = []

  for (const m of webviews) {
    const rt = registry.get(m.adapterId ?? '')
    if (!rt) continue
    const partition = m.partition ?? `persist:torra-${m.id}`
    let host = ''
    try {
      host = new URL(rt.spec.entry).hostname
    } catch {
      host = ''
    }

    if (!host) {
      // 地址异常时不做启发式判断，直接跳过（用到时会补建）
      skipped.push(m.displayName ?? m.id)
      continue
    }

    const probe = await probeSessionCookies(partition, host)
    // 某些站点（当前 DeepSeek）会在页面导航后才写入认证 Cookie，
    // 或把登录态放在 localStorage。适配器可显式要求页面预检，避免
    // 仅依赖启动前的 Cookie 启发式而漏掉真实已登录会话。
    if (probe.likelyLoggedIn || rt.spec.prewarm === true) {
      pool.ensure(m.id, rt, m.partition)
      warmed.push(m.displayName ?? m.id)
    } else {
      // 标记为「按需启动」：状态灯据此显示为灰色待命，而非「未初始化」
      lastLoginState.set(m.id, 'unknown')
      skipped.push(m.displayName ?? m.id)
    }
  }

  console.log(
    `[warm] 按需预热：${warmed.length}/${webviews.length} 个模型判定为已登录并已启动` +
      (warmed.length ? `（${warmed.join('、')}）` : ''),
  )
  if (skipped.length > 0) {
    console.log(`[warm] 未登录，按需启动：${skipped.join('、')}`)
  }
}

/**
 * 启动后汇报登录态盘点。
 *
 * 用户重启后最关心的就是「我上次登录的还在不在」。
 * 静默恢复好，但没登录的站点要一次说清，避免用户逐个点开试。
 * 同时把已登录分区的凭据重新刷盘一次 —— 修复历史遗留的
 * 「进程退出时写缓冲未落盘」造成的登录态丢失。
 */
function reportLoginInventory(): void {
  const webviews = models.filter((m) => m.transport === 'webview')
  const loggedIn: string[] = []
  const loggedOut: Array<{ name: string; id: string }> = []

  for (const m of webviews) {
    const name = m.displayName ?? m.id
    const state = lastLoginState.get(m.id)
    if (state === 'logged-in') loggedIn.push(name)
    // unknown = 未登录且未预热（按需启动），归入「需登录」一类提示
    else loggedOut.push({ name, id: m.id })
  }

  // 已登录的分区顺手再刷一次盘，把上次可能未落盘的凭据固化下来
  if (loggedIn.length > 0) void flushAllSessions()

  console.log(
    `[login] 启动盘点：已登录 ${loggedIn.length}/${webviews.length}` +
      (loggedIn.length ? `（${loggedIn.join('、')}）` : ''),
  )
  if (loggedOut.length > 0) {
    console.log(`[login] 需重新登录：${loggedOut.map((x) => x.name).join('、')}`)
    send('login:inventory', {
      loggedIn,
      loggedOut: loggedOut.map((x) => ({ modelId: x.id, displayName: x.name })),
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// 引导
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  await diag.init(dataDir())

  // 双目录：内置适配器只读语义，用户自建适配器位于 userData，
  // 同 id 时用户配置覆盖内置 —— 用户可自行适配站点改版，无需改代码。
  registry = new AdapterRegistry(path.join(ROOT, 'adapters'), userAdaptersDir())
  await registry.loadAll()
  registry.watch()
  /*
   * 内置适配器是随包分发的资源，读不出来就等于「所有网页模型都没有可用通道」。
   * 这类失败过去不留痕迹 —— 目录不可读只在控制台说话，用户那边是一片空壳。
   * 这里把计数落进流水线日志，诊断页与离线 CLI 都能看到它断在哪一步。
   */
  if (registry.list().length === 0) {
    diag.log({
      ts: Date.now(),
      layer: 'adapter',
      stage: 'load',
      subject: 'builtin',
      ok: false,
      detail: `内置适配器目录读出 0 条：${path.join(ROOT, 'adapters')}`,
    })
  }

  // 不传则用 WebviewPool 的默认预算（3072MB）。
  // 此前硬编码 1536MB，而内置网页版模型已达 9 个（9×250=2250MB），
  // 启动预热时必然超预算触发 LRU 回收，把刚创建的实例销毁 ——
  // 表现为该模型整场缺席、原因报「WebView 未初始化」。
  pool = new WebviewPool()
  if (mainWindow) pool.attachToWindow(mainWindow)
  registry.onChanged(applyAdapterChange)

  store = new FileSessionStore(path.join(dataDir(), 'sessions'))
  await store.init()

  secrets = new KeychainSecretStore(path.join(dataDir(), 'keys'))
  models = loadDefaultModels()
  // 合并用户自建模型（此前硬编码，导致「不支持自己配置可选网页 LLM」）
  await mergeUserModels()
  // 应用侧栏状态：停用/隐藏/顺序都来自 preferences，须在首次 listModels 前就位
  await loadModelState()
  await loadAssistantExtensions()
  applyModelStateToMemory()
  // 通知渲染层：模型列表已就绪（bootstrap 与渲染层首次 listModels 可能竞态）
  _bootResolve()
  send('models:changed', {})

  /*
   * 落一份生效模型清单，供离线体检 CLI 使用。
   * 不这么做的话 CLI 只能自己再抄一份内置清单 —— 两处清单一旦漂移，
   * 体检结论就和真实运行对不上，正是这批一次性脚本作废的原因。
   * 清单只含分区名与 apiKeyRef 引用名，不含任何密钥值。
   */
  await fs
    .writeFile(path.join(dataDir(), 'models.snapshot.json'), JSON.stringify(models, null, 2), 'utf8')
    .catch(() => undefined)

  /*
   * 按需预热：只实例化「cookie 显示可能已登录」的模型。
   *
   * 过去无条件预热全部 9 个 WebView 型模型，等于开机就吃掉 ~2GB 内存、
   * 拖慢数秒，而且把内存预算顶穿（进而触发 LRU 自毁，导致模型莫名缺席）。
   *
   * 未登录的模型创建实例毫无意义 —— 用户不会用它。
   * 它会在两种时刻被补建：
   *   1. 用户点开该模型的页面（转播/登录）→ ensure()
   *   2. 该模型进入本场讨论名单 → WebviewAgent.ensureView() 自愈重建
   *
   * cookie 判定是启发式，适配器 prewarm 可覆盖页面态认证，误判代价极低：
   * 漏判（已登录却没预热）会在用到时补建；错判（未登录却预热）只是多占一份内存。
   */
  await warmLikelyLoggedIn()

  // 预热后探测真实状态：等各实例 did-finish-load 再探，否则页面尚未挂载
  // 输入框，会把「还在加载」误判成「适配器失效」。
  void probeAllAgentsWhenReady()

  // 周期性复检：登录可能发生在 Torra 之外，也可能无事件地自然失效
  startLoginWatchdog()

  // 首次启动：风险确认墙（PRD 11.3）
  await fs.mkdir(path.join(dataDir(), 'flags'), { recursive: true })
  if (!(await flagExists('risk-acknowledged'))) {
    mainWindow?.webContents.once('did-finish-load', () => {
      send('risk:show', {
        message:
          'Torra 通过浏览器自动化驱动你已登录的网页版 AI 服务。自动化访问可能触发平台风控甚至导致账号被封禁，风险由你自行承担。Torra 不提供任何规避验证码或风控的手段，检测到人机验证时会停下并交还你手动处理。',
      })
    })
  }
}

/** 「这件事这个人已经做过一次」的标记，落在 dataDir/flags 下 */
async function flagExists(name: string): Promise<boolean> {
  try {
    await fs.access(path.join(dataDir(), 'flags', name))
    return true
  } catch {
    return false
  }
}

async function markFlag(name: string): Promise<void> {
  const dir = path.join(dataDir(), 'flags')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), new Date().toISOString(), 'utf8')
}

async function markRiskAcknowledged(): Promise<void> {
  await markFlag('risk-acknowledged')
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

/**
 * 窗口 / 托盘图标。Windows 下没有 AppUserModelId 任务栏会退回 Electron 默认图标，
 * 所以两者必须一起设；PNG 由 `npm run icons` 从品牌标记光栅化而来。
 *
 * 用 createFromBuffer 而不是 createFromPath：打包后这张图在 app.asar 里，
 * nativeImage 走的是系统文件 API，读不到 asar 虚拟路径 —— 结果是「不报错、图标空白」。
 * BrowserWindow.icon 只收单张图（不支持多尺寸数组），窗口取 256 由系统缩放。
 */
function brandIcon(size = 256): Electron.NativeImage | undefined {
  try {
    const file = path.join(ROOT, 'resources', 'brand', `icon-${size}.png`)
    const img = nativeImage.createFromBuffer(readFileSync(file))
    return img.isEmpty() ? undefined : img
  } catch {
    return undefined
  }
}

function createWindow(): void {
  // 冷启动的明暗由 preload 在页面第一帧之前同步向主进程取（见 initTheme 的 theme:boot）；
  // 底色则要在此处就定下来 —— 窗口在内容画完之前会先用 backgroundColor 铺一次。
  const resolved = resolvedTheme()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'Torra',
    icon: brandIcon(),
    backgroundColor: resolved === 'dark' ? '#0a0b14' : '#faf9f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    // 后台宿主窗口必须随之关闭：它本身算一枚存活窗口，留着的话
    // window-all-closed 永不触发，应用会僵在后台退不出去。
    pool?.disposeHost()
  })
  // 主窗口重建（macOS activate）后，池里的转播目标要跟着换
  pool?.attachToWindow(mainWindow)

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER)
  } else {
    void mainWindow.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'))
  }
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

let tray: Tray | null = null

/** 把主窗口带回前台；窗口已经被关掉过（macOS）就重建一个 */
function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady()) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 托盘的定位是「快捷入口」，不是「常驻后台」：
 * 关掉主窗口仍然照原样退出应用（见 window-all-closed），托盘只在应用活着时
 * 提供隐藏／找回窗口的出口 —— 避免出现「进程在、界面无从下手」的幽灵状态。
 */
function createTray(): void {
  if (tray) return
  const icon = brandIcon(process.platform === 'win32' ? 32 : 16)
  if (!icon) return // 品牌资源缺失时宁可不挂托盘，也不要留一枚白块让人点不出东西
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Torra')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: revealMainWindow },
      { label: '隐藏主窗口', click: () => mainWindow?.hide() },
      { type: 'separator' },
      { label: '退出 Torra', click: () => app.quit() },
    ]),
  )
  tray.on('click', revealMainWindow)
}

/**
 * 把所有分区的 cookie / localStorage 强制刷盘。
 *
 * Chromium 对 cookie 采用延迟写盘（默认几十秒的写缓冲），
 * 进程在缓冲未落盘时退出会静默丢掉刚拿到的登录凭据 ——
 * 表现就是「明明登录了，重启又要重登」。
 *
 * 两个时机必须刷：
 * - 登录成功后立刻刷（不等缓冲自然写）
 * - 退出前刷（will-quit 是同步收尾的最后一环）
 */
async function flushAllSessions(): Promise<void> {
  const jobs = models
    .filter((m) => m.transport === 'webview')
    .map(async (m) => {
      const part = m.partition ?? `persist:torra-${m.id}`
      try {
        await session.fromPartition(part).flushStorageData()
      } catch {
        /* 分区尚未创建等情况可忽略 */
      }
    })
  await Promise.all(jobs)
}

/**
 * 内嵌页面的两道闸门：站点权限、站点弹窗。
 *
 * 装在 app.on('web-contents-created') 而不是各创建点：一处覆盖全部 webContents，
 * 包括 window.open 之后 Electron 自己造出来的那些 —— 漏掉一个就等于没关。
 * 必须在任何窗口创建之前登记，否则第一枚 webContents 会带着无 handler 的状态出生。
 *
 * 不装就是默认放行：Electron 安全文档原文是「未自定义 handler 时权限请求一律自动批准」。
 * 池里跑的是站点自己的页面，于是任何一站都能静默拿到通知 / 麦克风 / 摄像头 / 地理位置，
 * 用户既没有提示，也没有撤销的出口 —— Torra 没有任何功能需要站点权限，所以一律拒。
 *
 * 弹窗按来源分档：登录窗口放行（不少站点 OAuth 靠弹窗续接，一刀切就登不进去），
 * 但放行有额度、且窗口身份由 Torra 钉死 —— 整窗无限放行等于把「谁能顶着 Torra 的外壳说话」
 * 交给登录页里嵌的任意文档；其余页面不在应用内开窗 —— 应用内子窗会复用同一个 persist: 分区，
 * 一个仿冒页就能带着用户的登录态显示钓鱼内容。http(s) 链接交系统浏览器，
 * 功能不丢，窗口不失控；javascript: / data: 这类连系统浏览器都不给。
 */
function hardenEmbeddedContents(): void {
  // 权限 handler 挂在 session 上、且是按 session 覆盖式注册：同一分区第二次注册会把
  // 第一个闭包替换掉，日志里的来源就会串到别的视图。按 session 去重，只装一次。
  const hardened = new Set<Electron.Session>()
  app.on('web-contents-created', (_ev, contents) => {
    const ses = contents.session
    if (!hardened.has(ses)) {
      hardened.add(ses)
      ses.setPermissionCheckHandler(() => false)
      ses.setPermissionRequestHandler((requester, permission, callback, details) => {
        callback(false)
        diag.log({
          ts: Date.now(),
          layer: 'runtime',
          stage: 'permission-deny',
          subject: permission,
          ok: false,
          detail: denyNote(permission, details?.requestingUrl || requester.getURL()),
        })
      })
    }
    contents.setWindowOpenHandler(({ url }) => {
      // 额度用 isLoginWindow 与 claimInAppPopup 分两步判：前者说「这是登录窗口」，
      // 后者才说「还让不让再开一枚」—— 日志要能区分「不是登录窗口」和「额度已用尽」
      const claim = isLoginWindow(contents.id) ? claimInAppPopup(contents.id) : null
      const d = popupDisposition(url, { loginWindow: claim !== null })
      diag.log({
        ts: Date.now(),
        layer: 'runtime',
        stage: `popup-${d}`,
        ok: d !== 'block',
        detail: popupNote(
          d,
          url,
          contents.getURL(),
          claim === null && isLoginWindow(contents.id) && d === 'external' ? '登录弹窗额度已用尽' : undefined,
        ),
      })
      if (d === 'in-app' && claim !== null) {
        const title = loginPopupTitle(claim)
        // 标题由 Torra 钉死并挡住站点的 <title>：这类窗口一旦让站点自己改名，
        // 用户就分不清是 Torra 开的临时弹窗、还是自己点的链接，仿冒页要的正是这层混淆
        contents.once('did-create-window', (child) => {
          child.setTitle(title)
          child.on('page-title-updated', (e) => e.preventDefault())
        })
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, title } }
      }
      if (d === 'external') void shell.openExternal(url).catch(() => undefined)
      return { action: 'deny' }
    })
  })
}

// 特权方案必须在 app ready 前声明（模块顶层即求值，一定早于 whenReady 回调）
registerFaviconScheme()

// 应用名钉死为小写：Electron 默认会读 package.json 的 productName，
// 打包后 productName 是「Torra」，userData 就会从 %APPDATA%\torra 变成 %APPDATA%\Torra，
// 表现是「装了新版本突然全部未登录」。显示名由窗口标题与安装包负责，这里只保住数据目录。
app.setName('torra')

// 单实例锁只给打包后的应用用。开发模式与 doctor / verify-* 这类诊断脚本共用同一个
// userData，在这里一并抢锁会让第二个进程直接被退出 —— 表现是「脚本没有任何输出」，
// 而不是一个能读懂的错误。
if (app.isPackaged) {
  if (!app.requestSingleInstanceLock()) app.quit()
  else app.on('second-instance', revealMainWindow)
}

// 闸门要在第一枚 webContents 出现之前登记 —— whenReady 回调里就会建主窗口
hardenEmbeddedContents()

app.whenReady().then(() => {
  // Windows 按 AppUserModelId 归并任务栏图标；不设它，通知与任务栏都会显示 Electron 默认牌子
  if (process.platform === 'win32') app.setAppUserModelId('com.torra.app')
  installFaviconProtocol()
  initTheme()
  createWindow()
  createTray()
  void bootstrap()
  registerIpc()
  // 快捷键须在 app ready 之后挂（globalShortcut 的硬要求），这里读盘 + 注册一气呵成；
  // 注册失败（多为被占用）不打断启动，状态留给设置页显示。
  void (async () => {
    await loadHotkey()
    applyHotkey()
  })()

  app.on('activate', () => {
    // 不能判 getAllWindows()：隐藏宿主窗口常驻，窗口数永不为 0
    if (!mainWindow) createWindow()
  })
})

// 退出前刷盘。will-quit 在 window-all-closed 之后触发，
// 必须在此拦住 —— 否则 cookie 写缓冲随进程一起消失。
let flushedBeforeQuit = false
app.on('before-quit', (e) => {
  if (flushedBeforeQuit || !models.length) return
  e.preventDefault()
  flushedBeforeQuit = true
  void flushAllSessions().finally(() => {
    app.quit()
  })
})

app.on('window-all-closed', () => {
  pool?.disposeAll()
  registry?.dispose()
  if (process.platform !== 'darwin') app.quit()
})

// 退出前务必撤掉全局快捷键：不 unregisterAll 的话，快捷键在进程退出的瞬间还可能
// 触发回调，且部分平台上会残留到下一次启动。
app.on('will-quit', () => {
  // 托盘图标是原生句柄，进程退了系统栏却可能继续画着它，显式撤掉。
  tray?.destroy()
  tray = null
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* 未注册过也无副作用 */
  }
})

// ---------------------------------------------------------------------------
// IPC 白名单
// ---------------------------------------------------------------------------

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

// ---------------------------------------------------------------------------
// 智能添加：把「读页面 → 推断 → 校验」交给配置助手，人只回答拿不准的问题
// ---------------------------------------------------------------------------

const smartAdd = createSmartAdd({
  pool: () => pool,
  getAgent,
  models: () => models,
  resolveKey: (ref) => secrets.get(ref),
  emit: (stage) => send('smartadd:stage', stage),
  onScanWindow: (st) => send('smartadd:scan-window', st),
  log: (e) =>
    diag.log({
      ts: Date.now(),
      layer: 'runtime',
      stage: e.stage,
      subject: e.subject,
      ok: e.ok,
      detail: e.detail,
    }),
})

// ---------------------------------------------------------------------------
// 助手 agent：把体检、改配置、建模型这些已有能力交给通用 agent 循环
// ---------------------------------------------------------------------------

/**
 * 助手用主进程的真实能力组 caps（定义见 assistant/bridge.ts）。
 *
 * registry/pool/secrets 在 bootstrap() 里才被赋值，所以这里全部按 smartAdd
 * 的老规矩传取值函数，而不是在模块加载时抓一份引用 —— 抓到的会是 undefined。
 *
 * 会话是**懒创建**的：只有第一次发消息时才 import pi SDK。这既让 app 启动
 * 不被 agent 运行时拖累，也让「这台机器的 Node 撑不起 SDK」这类环境问题
 * 表现为助手打不开，而不是整个 app 起不来。
 */
const assistantBridge = createAssistantBridge({
  dataDir,
  models: () => models,
  secrets: {
    get: (ref) => secrets.get(ref),
    has: (ref) => secrets.has(ref),
  },
  registry: () => registry,
  pool: () => pool,
  runDoctor: (opts) => runDoctor(doctorDeps(), { modelId: opts.modelId, probeApi: opts.probeApi }),
  readLog: (limit, filter) => diag.tail(limit, { layer: filter.layer, subject: filter.subject }),
  createApiModel: (input) => createApiModel(input),
  createWebModel: (input) => createWebModel(input),
  runWebTurn: (modelId, text) => runWebTurn(modelId, text),
  siteScan: {
    planWeb: (input) => smartAdd.planWeb(input),
    refineWeb: (planId, answers) => smartAdd.refineWeb(planId, answers),
    verifyWeb: (planId, selectors) => smartAdd.verifyWeb(planId, selectors),
    driveWeb: (planId, input) => smartAdd.driveWeb(planId, input),
    closeScanWindow: () => smartAdd.closeScanWindow(),
  },
  deleteModel: (modelId) => deleteWebModel(modelId),
  presentModel: async (modelId) => {
    const cfg = models.find((m) => m.id === modelId)
    if (!cfg) return { ok: false, reason: '模型不存在' }
    if (cfg.transport !== 'webview') return { ok: false, reason: `${cfg.displayName} 走 API 通道，没有需要登录的页面` }
    const rt = registry.get(cfg.adapterId ?? '')
    if (!rt) return { ok: false, reason: `适配器「${cfg.adapterId ?? '?'}」不存在` }
    pool.ensure(modelId, rt, cfg.partition)
    /*
     * 不在这里直接 pool.present()：那是把原生视图按老基线拍在主窗口上，
     * 而它永远盖在渲染层之上 —— 结果是一页没有关闭按钮、又挡住整个应用的网页。
     * 改成请渲染层挂载 <WebviewDock>：由它量矩形、贴合，并在卸载时收起，
     * 关闭入口和视图同源，不会出现「看得见却关不掉」。
     */
    send('webview:request', { modelId })
    return { ok: true, reason: '已在应用的「网页视图」里打开，带关闭按钮；需要时让用户点该视图右上角的 ×' }
  },
  listRemoteModels,
  send,
  handle: (channel, fn) => {
    ipcMain.handle(channel, (_e, args) => fn(args))
  },
  readAttachment: async (id) => {
    if (typeof id !== 'string') return null
    const meta = await chatAssets().readMeta(id)
    const bytes = await chatAssets().readBytes(id)
    if (!meta || !bytes) return null
    return { kind: meta.kind, name: meta.name, mime: meta.mime, base64: bytes.toString('base64') }
  },
  log: (e) => diag.log({ ts: Date.now(), layer: e.layer, stage: e.stage, subject: e.subject, ok: e.ok, detail: e.detail }),
  extensionsEnabled: () => assistantExtensions,
  setExtensionsEnabled: (on) => persistAssistantExtensions(on),
  selfAuthoringEnabled: () => assistantSelfAuthoring,
  setSelfAuthoringEnabled: (on) => persistSelfAuthoring(on),
  approvalPrefs: () => assistantApproval,
  setApprovalPrefs: async (prefs) => {
    // 桥那边已经夹取过，这里只负责落盘；再夹一次是为了手改偏好文件也越不了界
    assistantApproval = { mode: prefs.mode, timeoutMs: clampApprovalTimeout(prefs.timeoutMs) }
    await persistAssistantFlags()
  },
  /**
   * 原生目录选择器：助手 / 浮层的「挑一个工作目录（@ 引用的起点）」。
   *
   * 只能在主进程做 —— 渲染层拿不到目录的绝对路径（Electron 已废弃 File.path），
   * 而「让助手能读哪个目录」这件事也不该由网页界面代劳。
   * 这里只负责把人选中的路径原样交出去，能不能要由桥那层的闸门判断。
   */
  pickDirectory: async () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const opts: Electron.OpenDialogOptions = {
      title: '选一个项目目录（@ 引用从这里开始找）',
      buttonLabel: '就用这个目录',
      message: '@ 引用只在这个目录里挑文件，助手也会同时拿到它的读取权限；只在这场助手会话期间有效',
      properties: ['openDirectory'],
      defaultPath: os.homedir(),
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled) return { ok: false, reason: '已取消，工作目录没变' }
    const picked = r.filePaths[0]
    if (!picked) return { ok: false, reason: '没有选中目录' }
    return { ok: true, path: picked }
  },
  lastWorkDir: () => assistantLastWorkDir,
  setLastWorkDir: async (dir) => {
    assistantLastWorkDir = dir
    await persistAssistantFlags()
  },
})

/**
 * 应用内自动升级。建在模块加载时是安全的：electron-updater 读 app 的版本号、
 * userData 都在方法里，构造那一轮不碰。
 *
 * 只有设置页「关于」那一格会驱动它，启动时不静默检查 —— 弹一句「有新版本」
 * 然后自己去啃用户的下载流量，不是这里的设计。
 */
const updater = createUpdater({
  send,
  log: (detail) =>
    diag.log({ ts: Date.now(), layer: 'runtime', stage: 'update', subject: 'electron-updater', ok: false, detail }),
})

/** 渲染层传来的澄清答案：只收字符串键值，长度封顶 */
function sanitizeStringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(k)) out[k] = val.slice(0, 500)
  }
  return out
}

function registerIpc(): void {
  // 助手的通道在 app ready 之后统一挂载（模块加载时 ipcMain 还不应接收注册）
  assistantBridge.registerIpc()

  ipcMain.handle('risk:acknowledge', async () => {
    await markRiskAcknowledged()
    return { ok: true }
  })

  /**
   * 一次性上手引导的已读标记。
   *
   * 存主进程而不是 localStorage：同一台机器上换窗口、重载页面都不该再问第二遍，
   * 而「看过没有」这件事跟这份安装绑定，跟某个渲染进程无关。
   */
  ipcMain.handle('onboarding:state', async () => ({ show: !(await flagExists('onboarding-seen')) }))

  ipcMain.handle('onboarding:dismiss', async () => {
    await markFlag('onboarding-seen')
    return { ok: true }
  })

  /**
   * 状态灯后台复检。
   *
   * 必须在每次列表读取时触发，否则会出现「用户已登录、灯还是红的」：
   * 渲染层拿 models:list 刷新列表，此时顺手在后台复检一次，
   * 下一轮刷新就能拿到真实状态。
   *
   * 做成异步「不等待」是有意的 —— 登录判定要执行页面 JS，
   * 同步等待会让列表接口卡住数百毫秒。首帧可能仍显示旧状态，
   * 但复检完成会推 models:changed 触发第二次刷新。
   */
  let listProbeInFlight = false
  function kickBackgroundProbe(): void {
    if (listProbeInFlight) return
    listProbeInFlight = true
    setTimeout(() => {
      void probeAllAgents()
        .catch(() => undefined)
        .finally(() => {
          listProbeInFlight = false
        })
    }, 150)
  }

  ipcMain.handle('models:list', async () => {
    await bootDone
    kickBackgroundProbe()
    return visibleOrderedModels().map((m) => {
      const rt = m.adapterId ? registry.get(m.adapterId) : undefined
      const entry = rt?.spec.entry
      let domain: string | undefined
      if (entry) {
        try {
          domain = new URL(entry).hostname
        } catch {
          // ignore invalid URLs
        }
      }
      const ce = m.transport === 'webview' ? lastCredExpiry.get(m.id) : undefined
      return {
        id: m.id,
        displayName: m.displayName,
        transport: m.transport,
        color: m.color,
        enabled: m.enabled,
        supportsStructuredOutput: m.supportsStructuredOutput,
        adapterHealth: rt?.health ?? 'unknown',
        adapterStale: m.adapterId ? registry.isStale(m.adapterId) : false,
        hasKey: m.api ? secrets.has(m.api.apiKeyRef) : true,
        /*
         * 状态灯取值：busy 优先（发言中不该被复检打断），
         * 其次读登录态快照 —— 它是「此刻能否发言」的直接依据。
         * 快照缺失时才退回 agent.status，再退到 disabled。
         */
        status: (() => {
          const a = getAgent(m.id)
          if (a?.status === 'busy') return 'busy'
          const st = lastLoginState.get(m.id)
          if (m.transport === 'api') return a?.status ?? 'disabled'
          if (st === 'logged-in') return 'ready'
          if (st === 'logged-out') return 'expired'
          // unknown 不能回退到 WebviewAgent 的初始 ready；Agent 尚未完成
          // 登录态复核时，绿色会把游客页/未初始化页误报成可用。
          return 'expired'
        })(),
        domain,
        userDefined: m.partition?.startsWith('persist:torra-user-') || m.id.startsWith('api-user-'),
        adapterLastError: rt?.lastError,
        // 把判定理由透给 UI：用户悬停即可知道「为什么是这个颜色」，
        // 而不必猜是未登录、选择器失效还是页面没加载完
        loginNote: m.transport === 'webview' ? lastLoginReason.get(m.id) : undefined,
        loginState: m.transport === 'webview' ? lastLoginState.get(m.id) : undefined,
        /*
         * 凭据有效期：只给「最早到期」这一个时刻（epoch 毫秒），加上它属于哪条 cookie，
         * 界面就能把话说清楚 —— 数字是提示，依据才是可信的部分。
         */
        credExpiresAt: ce?.earliest ? ce.earliest.exp * 1000 : undefined,
        credExpiresCookie: ce?.earliest?.name,
        credSessionOnly: ce?.sessionOnly,
      }
    })
  })

  /** 手动/登录后重新探测全部模型状态，供 UI 刷新状态灯 */
  ipcMain.handle('models:probe', async () => {
    await bootDone
    await probeAllAgents()
    return { ok: true }
  })

  // ---- 偏好设置持久化 ----

  ipcMain.handle('preferences:load', async () => {
    return (await readPreferences()) as { participantIds?: string[]; moderatorId?: string | null }
  })

  ipcMain.handle('preferences:save', async (_e, prefs: { participantIds: string[]; moderatorId: string | null }) => {
    if (
      !prefs ||
      !Array.isArray(prefs.participantIds) ||
      prefs.participantIds.length > 20 ||
      prefs.participantIds.some((id) => typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) ||
      (prefs.moderatorId !== null && (typeof prefs.moderatorId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(prefs.moderatorId)))
    ) {
      return { ok: false, reason: '偏好设置格式非法' }
    }
    await patchPreferences({ participantIds: prefs.participantIds, moderatorId: prefs.moderatorId })
    return { ok: true }
  })

  // ---- 讨论参数的「我的默认」 ----
  //
  // 存 preferences.json 的 discussionDefaults 键，只装**与出厂值不同的那几项**：
  // 键不在就等于用出厂值，恢复出厂因此就是「把整张覆盖表清空」，不需要另存一份状态。
  // 读写两侧都过一遍 sanitize —— 区间与出厂表在 @shared/discussion-defaults，
  // 与这里的会话校验同源。手改偏好文件塞进 maxRounds: 999，不该表现成
  // 「开机第一场讨论被拒」，而该表现成该项回到可用区间。
  // set 是整表替换（渲染层每次提交完整的覆盖表），不是增量合并。
  ipcMain.handle('discussion-defaults:get', async () => {
    return sanitizeDiscussionDefaults((await readPreferences()).discussionDefaults)
  })

  ipcMain.handle('discussion-defaults:set', async (_e, patch: unknown) => {
    await patchPreferences({ discussionDefaults: sanitizeDiscussionDefaults(patch) })
    return { ok: true }
  })

  // ---- 区域尺寸（拖动分隔条调宽的列）----
  //
  // 收在一个 map 里而不是每个区域开一个键：新增一列不必再动主进程。
  // 值只可能是「某一列的像素宽」，故在这里就夹进合理区间 —— 渲染层传回
  // NaN 或负数（拖出视口、读到 0 宽的隐藏列）会存下一个把布局压垮的尺寸，
  // 而那时看起来像是代码写错了，没人会怀疑偏好文件。
  // value 传 null 表示「恢复默认」：删掉这个键，让列重新跟随 CSS 里的
  // 相对宽度（如 44%）—— 把默认值算成像素存下来，窗口一拉就变形。
  ipcMain.handle('layout:get', async () => {
    const l = (await readPreferences()).layout
    return l && typeof l === 'object' ? l : {}
  })

  ipcMain.handle('layout:set', async (_e, input: unknown) => {
    const o = (input ?? {}) as { key?: unknown; value?: unknown }
    if (typeof o.key !== 'string' || !/^[a-z][a-z0-9.]{0,47}$/i.test(o.key)) {
      return { ok: false, reason: '区域名非法' }
    }
    const prefs = await readPreferences()
    const cur = prefs.layout && typeof prefs.layout === 'object' ? { ...(prefs.layout as Record<string, unknown>) } : {}
    if (o.value === null) {
      delete cur[o.key]
      await patchPreferences({ layout: cur })
      return { ok: true }
    }
    const px = Number(o.value)
    if (!Number.isFinite(px) || px < 120 || px > 4000) return { ok: false, reason: '尺寸超出可用范围' }
    await patchPreferences({ layout: { ...cur, [o.key]: Math.round(px) } })
    return { ok: true }
  })

  // ---- 主题 ----

  ipcMain.handle('theme:get', async () => ({ mode: themeMode, resolved: resolvedTheme() }))

  ipcMain.handle('theme:set', async (_e, mode: unknown) => {
    if (!isThemeMode(mode)) return { ok: false, reason: '主题取值非法' }
    themeMode = mode
    nativeTheme.themeSource = mode === 'system' ? 'system' : mode
    const resolved = resolvedTheme()
    await patchPreferences({ theme: mode })
    applyThemeToWindows(resolved)
    return { ok: true, mode, resolved }
  })

  // ---- 全局快捷键：唤起 / 最小化 ----

  ipcMain.handle('hotkey:get', () => hotkeyState())

  ipcMain.handle('hotkey:set', async (_e, input: unknown) => {
    const o = (input ?? {}) as Partial<HotkeyConfig>
    const enabled = typeof o.enabled === 'boolean' ? o.enabled : hotkey.enabled
    const accel = typeof o.accel === 'string' ? o.accel.trim() : hotkey.accel
    hotkey = { enabled, accel }
    applyHotkey()
    await persistHotkey()
    // 开着却没挂上（被占用/格式无效）必须回 ok:false：否则设置页显示「已生效」，
    // 用户按了没反应，还以为是自己记错了键。
    if (enabled && !hotkeyRegistered) {
      return { ok: false, reason: hotkeyError ?? '快捷键注册失败', ...hotkeyState() }
    }
    return { ok: true, ...hotkeyState() }
  })

  // ---- 用户自建网页版模型（修复「不支持自己配置可选网页 LLM」）----

  ipcMain.handle('models:create-web', async (_e, input: unknown) => createWebModel(input as NewModelInput))

  ipcMain.handle('models:delete-web', async (_e, modelId: string) => {
    if (typeof modelId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(modelId)) return { ok: false, reason: '模型 ID 非法' }
    return deleteWebModel(modelId)
  })

  // ---- 用户自建 API 模型 ----

  ipcMain.handle('models:create-api', async (_e, input: unknown) => createApiModel(input as NewApiModelInput))

  ipcMain.handle('models:update-api', async (_e, modelId: unknown, patch: unknown) => {
    if (typeof modelId !== 'string' || !/^api-user-[a-z0-9-]{1,64}$/.test(modelId)) {
      return { ok: false, errors: ['模型 ID 非法'] }
    }
    return updateApiModel(modelId, patch as EditApiModelInput)
  })

  ipcMain.handle('models:get-api', async (_e, modelId: unknown) => {
    if (typeof modelId !== 'string' || !/^api-user-[a-z0-9-]{1,64}$/.test(modelId)) {
      return { ok: false, errors: ['模型 ID 非法'] }
    }
    return apiModelConfig(modelId)
  })

  ipcMain.handle('models:delete-api', async (_e, modelId: string) => {
    if (typeof modelId !== 'string' || !/^api-user-[a-z0-9-]{1,64}$/.test(modelId)) return { ok: false, reason: '模型 ID 非法' }
    return deleteWebModel(modelId)
  })

  ipcMain.handle(
    'models:list-remote',
    async (_e, baseUrl: string, apiKey: string) => listRemoteModels(baseUrl, apiKey),
  )

  /**
   * 侧栏拖动排序。orderedIds 为可见模型的完整 id 序列；隐藏项不参与排序，
   * 未收录进来的模型（如刚新增）在 list 时按原序补到末尾，不会被排掉。
   */
  ipcMain.handle('models:reorder', async (_e, orderedIds: unknown) => {
    await bootDone
    const r = applyReorder(models, modelState, orderedIds)
    if (!r.ok) return r
    models = r.models
    // order 必须来自刚排好的这一份。走 visibleOrderedModels() 会用「还没更新的旧 order」
    // 再排一遍，于是旧顺序被写进偏好，渲染层随后 listModels() 一拉就弹回原位。
    // 隐藏项不参与排序，恢复显示时由 visibleInOrder 按原序补尾。
    modelState.order = r.order
    await persistModelState()
    send('models:changed', {})
    return { ok: true }
  })

  /** 停用/启用某模型（灰显、不参与讨论，可恢复） */
  ipcMain.handle('models:set-enabled', async (_e, modelId: unknown, enabled: unknown) => {
    await bootDone
    if (typeof modelId !== 'string' || typeof enabled !== 'boolean') return { ok: false, reason: '参数非法' }
    const m = models.find((x) => x.id === modelId)
    if (!m) return { ok: false, reason: '模型不存在' }
    m.enabled = enabled
    const set = new Set(modelState.disabled)
    if (enabled) set.delete(modelId)
    else set.add(modelId)
    modelState.disabled = [...set]
    await persistModelState()
    send('models:changed', {})
    return { ok: true }
  })

  /**
   * 从侧栏移除某模型。
   * 自建模型 → 真删（连适配器与密钥一起清）；内置模型 → 持久隐藏，可在设置页恢复。
   */
  ipcMain.handle('models:remove', async (_e, modelId: unknown) => {
    await bootDone
    if (typeof modelId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(modelId)) {
      return { ok: false, reason: '模型 ID 非法' }
    }
    const m = models.find((x) => x.id === modelId)
    if (!m) return { ok: false, reason: '模型不存在' }
    if (isUserModel(m)) return deleteWebModel(modelId)
    if (!modelState.hidden.includes(modelId)) modelState.hidden.push(modelId)
    // 隐藏项一并从停用集移除，避免恢复时又是灰的
    modelState.disabled = modelState.disabled.filter((x) => x !== modelId)
    await persistModelState()
    send('models:changed', {})
    return { ok: true }
  })

  /** 列出被隐藏的内置模型，供设置页恢复 */
  ipcMain.handle('models:list-hidden', async () => {
    await bootDone
    const hidden = new Set(modelState.hidden)
    return models
      .filter((m) => hidden.has(m.id))
      .map((m) => {
        const rt = m.adapterId ? registry.get(m.adapterId) : undefined
        let domain: string | undefined
        try {
          if (rt?.spec.entry) domain = new URL(rt.spec.entry).hostname
        } catch {
          /* 入口非法就省略域名 */
        }
        return { id: m.id, displayName: m.displayName, transport: m.transport, color: m.color, domain }
      })
  })

  /** 恢复被隐藏的内置模型回侧栏 */
  ipcMain.handle('models:restore', async (_e, modelId: unknown) => {
    await bootDone
    if (typeof modelId !== 'string') return { ok: false, reason: '模型 ID 非法' }
    modelState.hidden = modelState.hidden.filter((x) => x !== modelId)
    await persistModelState()
    send('models:changed', {})
    return { ok: true }
  })

  /**
   * 选择器拾取：在目标页面上注入拾取脚本并扫描候选。
   * 站点 WebView 无 Node 权限，只能经 executeJavaScript 与页面通信。
   */
  ipcMain.handle('adapters:scan', async (_e, entry: string) => {
    let entryUrl: URL
    try {
      entryUrl = new URL(String(entry ?? ''))
      if (!['http:', 'https:'].includes(entryUrl.protocol) || !entryUrl.hostname) throw new Error('invalid URL')
    } catch {
      return { ok: false, reason: '入口地址必须是 http(s) URL' }
    }
    // 用一次性会话扫描，避免污染正式模型的登录分区
    const partition = 'persist:torra-picker'
    const w = pool.openLoginWindow('picker', entryUrl.toString(), { partition })
    return await scanWindow(w)
  })

  /** 在指定模型的 WebView 上扫描（复用其登录态） */
  ipcMain.handle('adapters:scan-model', async (_e, modelId: string) => {
    const cfg = models.find((m) => m.id === modelId)
    if (!cfg || cfg.transport !== 'webview') return { ok: false, reason: '该模型不是网页通道' }
    const rt = registry.get(cfg.adapterId ?? '')
    if (!rt) return { ok: false, reason: '适配器缺失' }
    pool.ensure(modelId, rt, cfg.partition)
    const view = pool.get(modelId)
    if (!view) return { ok: false, reason: 'WebView 未初始化' }
    const wc = view.webContents
    await wc.executeJavaScript(PICKER_SCRIPT, true).catch(() => undefined)
    return await collectScan(wc)
  })

  // ---- 智能添加：给一个域名，产出经过页面校验的适配器方案 ----

  ipcMain.handle('smartadd:web-plan', async (_e, input: unknown) => {
    const p = (input ?? {}) as { entry?: unknown; assistantModelId?: unknown }
    if (typeof p.entry !== 'string' || !p.entry.trim()) return { ok: false, reason: '缺少站点地址' }
    return await smartAdd.planWeb({
      entry: p.entry,
      assistantModelId: typeof p.assistantModelId === 'string' ? p.assistantModelId : undefined,
    })
  })

  /** 用户答完澄清问题：答案直接覆盖推断值，人是最终裁判 */
  ipcMain.handle('smartadd:web-refine', async (_e, planId: unknown, answers: unknown) => {
    if (typeof planId !== 'string') return { ok: false, reason: '方案已失效，请重新识别' }
    return await smartAdd.refineWeb(planId, sanitizeStringMap(answers))
  })

  /** 用户手改选择器后重新取命中数 */
  ipcMain.handle('smartadd:web-verify', async (_e, planId: unknown, selectors: unknown) => {
    if (typeof planId !== 'string') return { ok: false, reason: '方案已失效，请重新识别' }
    const sel = (selectors ?? {}) as Record<string, unknown>
    const roles = ['input', 'send', 'stop', 'stream', 'generating'] as const
    const clean: Record<(typeof roles)[number], string> = { input: '', send: '', stop: '', stream: '', generating: '' }
    for (const role of roles) {
      if (typeof sel[role] === 'string') clean[role] = (sel[role] as string).slice(0, 400)
    }
    return await smartAdd.verifyWeb(planId, clean)
  })

  ipcMain.handle('smartadd:close', () => {
    smartAdd.closeScanWindow()
    return { ok: true }
  })

  ipcMain.handle('smartadd:api-probe', async (_e, input: unknown) => {
    const p = (input ?? {}) as { address?: unknown; apiKey?: unknown }
    if (typeof p.address !== 'string' || !p.address.trim()) return { ok: false, attempts: [], reason: '缺少 API 地址' }
    return await smartAdd.probeApi({
      address: p.address,
      apiKey: typeof p.apiKey === 'string' ? p.apiKey.slice(0, 20_000) : undefined,
    })
  })

  ipcMain.handle('smartadd:api-meta', async (_e, input: unknown) => {
    const p = (input ?? {}) as { assistantModelId?: unknown; host?: unknown; baseUrl?: unknown; model?: unknown; protocol?: unknown }
    const model = typeof p.model === 'string' ? p.model.slice(0, 200) : ''
    if (!model) return { ok: false, reason: '缺少模型名' }
    return await smartAdd.apiMeta({
      assistantModelId: typeof p.assistantModelId === 'string' ? p.assistantModelId : undefined,
      host: typeof p.host === 'string' ? p.host.slice(0, 200) : '',
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.slice(0, 500) : '',
      model,
      protocol: p.protocol === 'anthropic' ? 'anthropic' : 'openai',
    })
  })

  ipcMain.handle('adapters:list', () =>
    registry.list().map((r) => ({
      id: r.spec.id,
      name: r.spec.name,
      health: r.health,
      verifiedAt: r.spec.verified_at,
      stale: registry.isStale(r.spec.id),
      tosNotice: r.spec.tos_notice,
      origin: r.spec.origin ?? 'builtin',
      entry: r.spec.entry,
      selectors: r.spec.selectors,
      lastError: r.lastError,
    })),
  )

  ipcMain.handle('adapters:check', async (_e, adapterId: string) => {
    const model = models.find((m) => m.adapterId === adapterId)
    if (!model) return { ok: false, reason: 'no model bound' }
    const agent = getAgent(model.id)
    const ok = (await agent?.healthCheck()) ?? false
    registry.setHealth(adapterId, ok ? 'ok' : 'selector-missing')
    return { ok, health: registry.get(adapterId)?.health }
  })

  // ---- 端到端体检 ----

  ipcMain.handle('doctor:run', async (_e, opts?: { modelId?: string; probeApi?: boolean; probeCompletion?: boolean }) => {
    const report = await runDoctor(doctorDeps(), {
      modelId: opts?.modelId,
      probeApi: opts?.probeApi ?? true,
      // 补全探测按 token 计费：只认渲染层这一次显式点击，缺省一律不发。
      // 助手侧的体检能力（bridge）压根没有这个参数，模型自己花不了用户的钱。
      probeCompletion: opts?.probeCompletion === true,
    })
    await diag.flush()
    return report
  })

  ipcMain.handle('doctor:log', (_e, opts?: LogFilter) => ({
    events: diag.tail(opts?.n ?? 200, opts),
    file: diag.currentFile(),
  }))

  /**
   * 日志管理。ring 只装得下本次进程的最后 1000 条，所以查「昨天那场」必须读盘 ——
   * 而读盘只走 diag 自己的入口：目录、文件名格式、保留天数都归它，界面碰不到路径。
   */
  ipcMain.handle('logs:files', async () => await diag.listFiles())

  ipcMain.handle('logs:read', async (_e, day: string, opts?: LogFilter) =>
    await diag.readDay(typeof day === 'string' ? day : '', opts),
  )

  ipcMain.handle('logs:open', async () => {
    const dir = diag.logsDir()
    if (!dir) return { ok: false, reason: '日志目录不可用，本次运行只有内存日志' }
    try {
      const err = await shell.openPath(dir)
      return err ? { ok: false, reason: err } : { ok: true, path: dir }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  })

  ipcMain.handle('logs:prune', async () => await diag.pruneNow())

  ipcMain.handle('doctor:export', async (_e, report: DoctorReport) => {
    const files = await persistReport(report, dataDir())
    return { ok: true, ...files }
  })

  /**
   * 套用体检建议：把某个选择器字段写进用户适配器目录。
   *
   * 走 saveUser 而不是改内置 YAML：用户目录会覆盖同 id 内置项，
   * 于是「站点改版」可以用配置修好，不需要改代码也不需要等发版。
   */
  ipcMain.handle('adapters:patch', async (_e, input: { adapterId: string; field: 'input' | 'stream' | 'health_probe'; value: string }) => {
    if (
      !input ||
      typeof input.adapterId !== 'string' ||
      !/^[a-z0-9-]{1,64}$/.test(input.adapterId) ||
      !['input', 'stream', 'health_probe'].includes(input.field) ||
      typeof input.value !== 'string' ||
      input.value.length > 2_000
    ) return { ok: false, reason: '适配器修补参数非法' }
    const rt = registry.get(input.adapterId)
    if (!rt) return { ok: false, reason: '适配器不存在' }
    if (typeof input.value !== 'string' || !input.value.trim()) return { ok: false, reason: '选择器为空' }
    const next: AdapterSpec = {
      ...rt.spec,
      selectors: { ...rt.spec.selectors },
      origin: 'user',
      note: `由体检套用建议 ${new Date().toISOString()}`,
    }
    if (input.field === 'health_probe') next.health_probe = input.value
    else next.selectors[input.field] = input.value
    const saved = await registry.saveUser(next)
    if (!saved.ok) return { ok: false, reason: saved.errors?.join('; ') ?? '写入失败' }
    diag.log({
      ts: Date.now(),
      layer: 'adapter',
      stage: 'patch',
      subject: input.adapterId,
      ok: true,
      detail: `${input.field} -> ${input.value}`,
    })
    return { ok: true }
  })

  /**
   * 登录态诊断：直接回答「cookie 存了没、存在哪、为什么没生效」。
   *
   * 只读，且只回报 cookie 的域名与名称，绝不回传值 —— 凭据不外泄。
   * 同时报 localStorage / sessionStorage 的 key 名：DeepSeek、Kimi 这类
   * 站点把登录凭据放在 localStorage 而非 cookie，只查 cookie 会误判为未登录。
   */
  ipcMain.handle('login:diagnose', async (_e, modelId: string) => {
    const cfg = models.find((m) => m.id === modelId)
    if (!cfg || cfg.transport !== 'webview') return { ok: false, reason: '该模型不是网页通道' }
    const part = cfg.partition ?? `persist:torra-${modelId}`

    // 后台实例若已在跑，实例上的分区才是实际生效的那个
    const actual = pool.getPartition(modelId) ?? part
    const ses = session.fromPartition(actual)

    let cookieTotal = 0
    let authCookies: string[] = []
    /** 严格口径（与状态灯同一个判定）：属于该站点域、且名字确实像认证凭据的那些 */
    let cred: { auth: AuthCookie[]; expiry: CredentialExpiry } = { auth: [], expiry: { authCookies: 0, sessionOnly: false } }
    try {
      const cookies = await ses.cookies.get({})
      cookieTotal = cookies.length
      authCookies = cookies
        .filter((c) => /token|auth|session|jwt|bearer|uid|passport|__Secure/i.test(c.name))
        .map((c) => `${c.domain} :: ${c.name}`)
        .slice(0, 20)
      const rt = cfg.adapterId ? registry.get(cfg.adapterId) : undefined
      let host = ''
      try {
        host = rt ? new URL(rt.spec.entry).hostname : ''
      } catch {
        host = ''
      }
      if (host) cred = summarizeAuthCookies(cookies, host)
    } catch (e) {
      return { ok: false, reason: `读取 cookie 失败：${(e as Error).message}` }
    }

    // 页面内存储：只在实例已加载时才有意义
    let storage: { localKeys: string[]; sessionKeys: string[] } | null = null
    const view = pool.get(modelId)
    if (view) {
      try {
        const r = (await view.webContents.executeJavaScript(
          `(() => {
            const grab = (s) => { try { const a = []; for (let i = 0; i < s.length; i++) a.push(s.key(i)); return a.slice(0, 20); } catch { return []; } };
            return { localKeys: grab(localStorage), sessionKeys: grab(sessionStorage) };
          })()`,
          true,
        )) as { localKeys: string[]; sessionKeys: string[] }
        storage = { localKeys: r.localKeys, sessionKeys: r.sessionKeys }
      } catch {
        storage = null
      }
    }

    // 登录态用 inspectLogin 判定；health_probe 只代表「输入框在不在」，
    // 与「是否登录」不是一回事（Kimi 未登录时也有输入框）
    const st = await pool.inspectLogin(modelId)
    const probeOk = (await getAgent(modelId)?.healthCheck()) ?? false

    return {
      ok: true,
      partition: actual,
      /** 分区声明与实际不一致会导致登录态互不可见，必须暴露出来 */
      partitionMismatch: actual !== part,
      declaredPartition: part,
      cookieTotal,
      authCookies,
      /*
       * 有效期明细：面板上要能逐条看到「哪条凭据什么时候到期」，
       * 因为单看一个「剩 N 天」没法判断它说的是不是真的登录态。
       * exp 统一换算成 epoch 毫秒 —— Electron 原生给的是秒，跨进程时两种单位混着用最容易出错。
       */
      credCookies: cred.auth.map((c) => ({ name: c.name, domain: c.domain, exp: c.exp * 1000 })),
      credExpiresAt: cred.expiry.earliest ? cred.expiry.earliest.exp * 1000 : undefined,
      credExpiresCookie: cred.expiry.earliest?.name,
      credSessionOnly: cred.expiry.sessionOnly,
      storage,
      probeOk,
      loginState: st.state,
      pageUrl: st.url,
      // 原始证据：让「为什么判成未登录」可自查，
      // 而不必猜是选择器失效、凭据识别失败还是页面未就绪
      evidence: st.evidence ?? null,
      // 结论：区分「没存」与「存了但没生效」——两者修复方向完全不同
      verdict:
        st.state === 'logged-in'
          ? '已登录：' + st.reason
          : st.state === 'logged-out'
            ? `未登录：${st.reason}` +
              (cookieTotal > 0 ? '（分区内有 cookie，但页面未接受，可能站点已改用其他凭据方式）' : '（分区为空，登录确实未落盘）')
            : `无法判定：${st.reason}` +
              (probeOk ? '。注意：输入框存在不等于已登录' : ''),
    }
  })

  /**
   * 强制刷新后台实例并复核 —— 登录后手动补救用。
   *
   * 注意不能 agents.delete(modelId)：那会把 agent 丢掉，
   * 状态灯读 getAgent()?.status 会退化成 'disabled'（灰），
   * 反而比红色更难懂。syncModelState 会原地把 status 更新为 ready/expired。
   */
  ipcMain.handle('login:refresh', async (_e, modelId: string) => {
    const cfg = models.find((m) => m.id === modelId)
    if (!cfg || cfg.transport !== 'webview') return { ok: false, reason: '该模型不是网页通道' }
    const rt = registry.get(cfg.adapterId ?? '')
    if (!rt) return { ok: false, reason: '适配器缺失' }
    pool.ensure(modelId, rt, cfg.partition)
    pool.reloadEntry(modelId)
    const ready = await pool.waitReady(modelId)
    const r = await syncModelState(cfg, { notify: false })
    const st = await pool.inspectLogin(modelId)
    send('models:changed', {})
    return { ok: r.loggedIn, ready, reason: st.reason, state: st.state }
  })

  /**
   * 打开网页版模型。
   *
   * 登录与查看统一走这一条内嵌路径。此前对需要登录的模型弹独立窗口，
   * 造成两个问题：
   * 1. 同一模型因状态不同而行为不一致（已登录内嵌 / 需登录弹窗），
   *    用户需要记两套操作方式；
   * 2. 弹窗与后台实例互不可见，登录态无法生效。
   */
  ipcMain.handle('login:open', async (_e, modelId: string) => {
    const cfg = models.find((m) => m.id === modelId)
    if (!cfg) return { ok: false, reason: '模型不存在' }
    if (cfg.transport !== 'webview') {
      return { ok: false, reason: `${cfg.displayName} 走 API 通道，无需网页登录` }
    }
    const rt = registry.get(cfg.adapterId ?? '')
    if (!rt) {
      return { ok: false, reason: `适配器「${cfg.adapterId ?? '?'}」不存在，请检查 adapters 目录` }
    }
    /*
     * 一律内嵌：登录与查看共用同一个 WebContents 与同一份登录态。
     *
     * 此前对需登录的模型弹独立 BrowserWindow，是「登录了还要反复登录」的根源 ——
     * 弹窗与后台实例互不可见：用户在弹窗里登录成功，
     * 而自动化读取的那份文档仍停留在登录前，且不会自行重渲染。
     * 现在页面本身就是登录界面，登录完即被自动化直接复用。
     *
     * 具体贴哪儿交给渲染层（见 webview:request）：主进程按老基线自己 present 出来的视图
     * 没有表头也没有关闭按钮，用户只能看着一整片网页压住应用。
     */
    pool.ensure(modelId, rt, cfg.partition)
    attachLoginWatcher(modelId)
    send('webview:request', { modelId })
    return { ok: true, reason: '' }
  })

  /**
   * 给模型挂上登录态观察器。
   *
   * 内嵌视图下没有「关闭登录窗口」这个终点，只能靠页面导航完成来推断
   * 用户是否已完成登录。状态一变就通知 UI，用户不必手动点复核。
   */
  function attachLoginWatcher(modelId: string): void {
    const cfg = models.find((m) => m.id === modelId)
    if (!cfg || cfg.transport !== 'webview') return
    /*
     * 复用 syncModelState：登录判定与状态灯更新必须是同一套逻辑。
     * 此前 watchLogin 自己更新 registry 却没碰 agent.status ——
     * 而状态灯读的是 agent.status，于是登录成功后灯仍是红的。
     */
    pool.watchLogin(modelId, () => {
      const m = models.find((x) => x.id === modelId)
      if (!m) return
      void syncModelState(m, { notify: true })
    })
  }

  ipcMain.handle('webview:present', (_e, modelId: string, bounds?: { x: number; y: number; width: number; height: number }) => {
    if (!mainWindow) return { ok: false, reason: '主窗口未就绪' }
    const cfg = models.find((m) => m.id === modelId)
    if (!cfg) return { ok: false, reason: '模型不存在' }
    if (cfg.transport !== 'webview') {
      return { ok: false, reason: `${cfg.displayName} 走 API 通道，没有可转播的网页` }
    }
    const rt = registry.get(cfg.adapterId ?? '')
    if (!rt) return { ok: false, reason: '适配器缺失，无法打开页面' }
    // 关键修复：present 前必须 ensure。此前直接 present，
    // 池里没有实例时返回 false —— 这正是「点头像打不开页面」的直接原因。
    pool.ensure(modelId, rt, cfg.partition)
    attachLoginWatcher(modelId)
    const ok = pool.present(modelId, bounds)
    if (ok) void syncPresentedModel(cfg).catch(() => undefined)
    return { ok, reason: ok ? '' : 'WebView 挂载失败' }
  })

  ipcMain.handle('webview:dismiss', (_e, modelId: string) => {
    pool.dismiss(modelId)
    return { ok: true }
  })

  ipcMain.handle('webview:memory', () => ({ estimatedMb: pool.estimateMemoryMb(), count: pool.listModelIds().length }))

  /**
   * 网页视图「全屏独立使用」：把主窗口切到无边框全屏。
   *
   * 布局层的放大（隐藏模型栏/会话栏/主区）由渲染层自己加 body 类完成，
   * 这里只负责窗口本身 —— 两件事分开，退出时才不会互相漏掉一半。
   */
  ipcMain.handle('webview:fullscreen', (_e, on: boolean) => {
    if (!mainWindow) return { ok: false, reason: '主窗口未就绪' }
    mainWindow.setSimpleFullScreen(on)
    return { ok: true, fullscreen: mainWindow.isSimpleFullScreen() }
  })

  /**
   * 刷新某个模型的页面。实例不存在时不顺手 ensure：
   * 那会拉起一个 250MB 的 WebView 去"刷新"一屏用户根本没看的页面。
   * 而是回 needsOpen，让 dock 把那颗按钮换成「重新打开」—— 走的正是 present() 那条会 ensure 的路。
   */
  ipcMain.handle('webview:reload', async (_e, modelId: string) => pool.reload(modelId))

  /**
   * 重建网页实例（刷新救不回来时的第二颗按钮）。
   *
   * 这里只换实例，不顺手 present：新视图由渲染层的贴合循环重新贴上窗口
   * （WebviewDock 在拿到 ok 后作废上一次矩形）。登录观察器必须重新挂，
   * 它监听的是 WebContents，换实例等于换了一批事件源。
   */
  ipcMain.handle('webview:recreate', (_e, modelId: string) => {
    const cfg = typeof modelId === 'string' ? models.find((m) => m.id === modelId) : undefined
    if (!cfg) return { ok: false, reason: '模型不存在' }
    if (cfg.transport !== 'webview') {
      return { ok: false, reason: `${cfg.displayName} 走 API 通道，没有可重建的网页实例` }
    }
    /*
     * 正在发言时不重建：自动化抓的是这一份 WebContents，换掉它等于把正在跑的
     * 那一轮抽走。只读 agents 缓存（getAgent 会顺手建实例，不该由这颗按钮触发）。
     */
    if (agents.get(modelId)?.status === 'busy') {
      return { ok: false, reason: `${cfg.displayName} 正在发言中，等这一轮结束再重建` }
    }
    const r = pool.recreate(modelId)
    if (r.ok) attachLoginWatcher(modelId)
    return r
  })

  ipcMain.handle('session:start', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: '请求格式非法' }
    const p = payload as { topic?: unknown; config?: unknown }
    const validation = validateSessionInput(p.topic, p.config)
    if (validation) return { ok: false, reason: validation }
    try {
      await startSession(p.topic as Topic, p.config as SessionConfig)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  })

  ipcMain.handle('session:interject', (_e, text: string, target?: string) => {
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > 20_000) return { ok: false }
    if (target !== undefined && (typeof target !== 'string' || !models.some((m) => m.id === target))) return { ok: false }
    const it = orchestrator?.interject(text, target)
    return { ok: !!it, intervention: it ?? null }
  })

  // ---- 人工介入（PRD 5.5）----
  ipcMain.handle('session:followup', (_e, targetAgentId: string, text: string, targetUtteranceId?: string) => {
    if (typeof targetAgentId !== 'string' || !models.some((m) => m.id === targetAgentId)) return { ok: false }
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > 20_000) return { ok: false }
    const it = orchestrator?.followup(targetAgentId, text, targetUtteranceId)
    return { ok: !!it, intervention: it ?? null }
  })

  ipcMain.handle('session:duel', (_e, agentIds: string[], topic: string) => {
    if (!Array.isArray(agentIds) || agentIds.length < 2 || agentIds.length > 2) return { ok: false, reason: '需要选择两个模型进行对辩' }
    if (agentIds.some((id) => typeof id !== 'string' || !models.some((m) => m.id === id))) return { ok: false, reason: '对辩模型不存在' }
    if (typeof topic !== 'string' || topic.trim().length === 0 || topic.length > 20_000) return { ok: false, reason: '对辩议题非法' }
    const it = orchestrator?.requestDuel(agentIds, topic)
    return { ok: !!it, intervention: it ?? null }
  })

  ipcMain.handle('session:set-stance', (_e, agentId: string, stance: string) => {
    if (typeof agentId !== 'string' || !models.some((m) => m.id === agentId)) return { ok: false }
    if (typeof stance !== 'string' || stance.trim().length === 0 || stance.length > 2_000) return { ok: false }
    const it = orchestrator?.setStance(agentId, stance)
    return { ok: !!it, intervention: it ?? null }
  })

  ipcMain.handle('session:stance', (_e, agentId: string) => ({
    stance: orchestrator?.getStance(agentId) ?? null,
  }))

  ipcMain.handle('session:pause', (_e, reason?: string) => {
    orchestrator?.requestPause(reason ?? '用户手动暂停')
    return { ok: true }
  })

  ipcMain.handle('session:resume', () => {
    orchestrator?.resume()
    return { ok: true }
  })

  ipcMain.handle('session:interventions', () => ({
    interventions: orchestrator?.getInterventions() ?? [],
    duels: orchestrator?.getDuels() ?? [],
  }))

  ipcMain.handle('session:abort', () => {
    if (!orchestrator) return { ok: false, reason: '当前没有进行中的会话' }
    orchestrator.requestAbort()
    return { ok: true }
  })

  ipcMain.handle('session:state', () => ({
    state: orchestrator?.getState() ?? 'INIT',
    round: orchestrator?.getRound() ?? 0,
    spentUsd: orchestrator?.getSpentUsd() ?? 0,
    budgetLimited: orchestrator?.isBudgetLimited() ?? false,
    moderatorUnavailable: orchestrator?.isModeratorUnavailable() ?? false,
  }))

  /**
   * 聊天直连广播：把同一个问题并行发给多个模型，各自独立作答。
   *
   * 与「研讨模式」的区别：无主持、无轮次、无共识核算 —— 每个模型只是
   * 回答用户，UI 组合并排展示各家的回答供对比。
   *
   * 结果通过 chat:delta / chat:done / chat:error 事件回推（fire-and-forget），
   * 渲染层按 modelId 归位到对应卡片。API 通道逐字携带该模型的对话历史；
   * 网页通道只键入最新问题，多轮上下文由站点自身会话维持。
   */
  ipcMain.handle('chat:send', async (_e, payload: unknown) => {
    const p = payload as {
      chatId?: unknown
      message?: unknown
      system?: unknown
      items?: unknown
      attachments?: unknown
    }
    const chatId = typeof p.chatId === 'string' ? p.chatId : ''
    let message = typeof p.message === 'string' ? p.message.trim() : ''
    const system = typeof p.system === 'string' ? p.system : undefined
    const items = Array.isArray(p.items) ? (p.items as Array<{ modelId?: unknown; history?: unknown }>) : []
    const attachments = Array.isArray(p.attachments) ? (p.attachments as ChatAttachmentMeta[]) : []
    if (!chatId || (!message && attachments.length === 0)) return { ok: false, reason: '聊天请求非法' }

    // 解析附件：文本/代码类并入问题（API、网页两条通道都受益），
    // 图片类读成 base64 挂到最后一条 user 消息上（只带当前这条，历史轮次的图不回传）。
    const images: ChatImage[] = []
    const textBlocks: string[] = []
    for (const a of attachments) {
      const meta = await chatAssets().readMeta(a.id)
      const bytes = await chatAssets().readBytes(a.id)
      if (!meta || !bytes) {
        textBlocks.push(`【附件读取失败：${a.name}】`)
        continue
      }
      if (meta.kind === 'image') {
        images.push({ mime: meta.mime, base64: bytes.toString('base64') })
      } else {
        textBlocks.push(`【附件：${meta.name}】\n${bytes.toString('utf8')}`)
      }
    }
    if (textBlocks.length) message = `${message}${message ? '\n\n' : ''}${textBlocks.join('\n\n')}`

    const emptyDigest: Digest = { confirmed: [], open: [], explored: [], rounds: [] }
    const stubTopic: Topic = {
      id: chatId,
      title: message || '（附件）',
      background: '',
      strategy: 'roundtable',
      attachments: [],
      createdAt: Date.now(),
    }

    const accepted: string[] = []
    const rejected: Array<{ modelId: string; reason: string }> = []

    for (const it of items) {
      const modelId = typeof it.modelId === 'string' ? it.modelId : ''
      if (!modelId) continue
      const agent = getAgent(modelId)
      if (!agent) {
        rejected.push({ modelId, reason: `${modelName(modelId)} 不可用（缺 Key 或未登录）` })
        continue
      }
      const prior = Array.isArray(it.history)
        ? (it.history as Array<{ role: 'user' | 'assistant'; content: string }>).filter(
            (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
          )
        : []
      const lastUser = { role: 'user' as const, content: message, ...(images.length ? { images } : {}) }
      const history = [...prior, lastUser]
      const ctx: TurnContext = {
        sessionId: chatId,
        round: 1,
        topic: stubTopic,
        digest: emptyDigest,
        callout: null,
        maxLenChars: 4_000,
        chat: { history, system },
      }
      accepted.push(modelId)
      let streamed = ''
      void agent
        .send(
          ctx,
          (chunk) => {
            if (typeof chunk === 'string') streamed += chunk
            send('chat:delta', { chatId, modelId, chunk })
          },
          (chunk) => send('chat:thinking-delta', { chatId, modelId, chunk }),
          (chunk) => send('chat:steps-delta', { chatId, modelId, chunk }),
        )
        .then((res) =>
          send('chat:done', {
            chatId,
            modelId,
            // 某些网页通道的最终 DOM 读取可能为空，但增量已经成功回传；
            // 不允许空 done 覆盖前端已展示的回答。
            content: streamed.length > (res.content?.length ?? 0) ? streamed : (res.content || streamed),
            usage: res.usage,
            input: res.input,
            thinking: res.thinking,
            steps: res.steps,
            note: res.note,
          }),
        )
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err)
          send('chat:error', { chatId, modelId, reason })
          diag.log({
            ts: Date.now(),
            layer: 'runtime',
            stage: 'chat-send',
            subject: modelId,
            sessionId: chatId,
            ok: false,
            detail: reason,
          })
        })
    }

    return { ok: true, accepted, rejected }
  })

  /**
   * 存一个聊天附件的字节到资源目录。渲染层只保留元数据，
   * 发送/预览时凭 id 回捞，避免 base64 撑爆 localStorage。
   */
  ipcMain.handle('attachment:save', async (_e, payload: unknown) => {
    const p = payload as { id?: unknown; kind?: unknown; name?: unknown; mime?: unknown; data?: unknown }
    const id = typeof p.id === 'string' ? p.id : ''
    const kind = p.kind === 'image' || p.kind === 'text' ? p.kind : null
    const name = typeof p.name === 'string' ? p.name : ''
    const mime = typeof p.mime === 'string' ? p.mime : 'application/octet-stream'
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !kind || !name) return { ok: false, reason: '附件参数非法' }
    const data =
      p.data instanceof Uint8Array
        ? p.data
        : p.data instanceof ArrayBuffer
          ? new Uint8Array(p.data)
          : null
    if (!data) return { ok: false, reason: '附件数据缺失' }
    try {
      await chatAssets().save(id, { kind, name, mime }, data)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  /** 回捞附件字节：图片返回 base64 供预览，文本类渲染层一般不需要（发送时由主进程读）。 */
  ipcMain.handle('attachment:read', async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, reason: '非法附件 id' }
    const meta = await chatAssets().readMeta(id)
    const bytes = await chatAssets().readBytes(id)
    if (!meta || !bytes) return { ok: false, reason: '附件不存在或已清理' }
    return { ok: true, kind: meta.kind, name: meta.name, mime: meta.mime, base64: bytes.toString('base64') }
  })

  // store 要到 bootstrap 才赋值，首次进入历史页可能早于它 —— 不 gate 会抛
  // 「store undefined」，IPC reject 后渲染层若没 catch 就永远停在「加载中」
  ipcMain.handle('session:list', async () => {
    await bootDone
    // 不再截断到 100：历史列表在渲染层分页展示，这里返回全量摘要，
    // buildHistoryList 本就已加载全部记录到内存，多返回的都是轻量条目。
    return await buildHistoryList()
  })

  ipcMain.handle('session:detail', async (_e, sessionId: string) => {
    await bootDone
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null
    const rec = await store.load(sessionId)
    if (!rec) return null
    const report = await store.loadReport(sessionId)
    return { record: rec, report }
  })

  ipcMain.handle('session:remove', async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return { ok: false }
    await store.remove(sessionId)
    return { ok: true }
  })

  /**
   * 重试已结束的会话。
   *
   * 四种模式的装配逻辑各不相同，但都遵循一条硬规则：
   * 重试产生**新会话**，不覆盖原记录 —— 原报告是决策依据，必须保留。
   */
  ipcMain.handle('session:retry', async (_e, sessionId: string, plan: RetryPlan) => {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      return { ok: false, errors: ['会话 ID 非法'] }
    }
    if (!plan || typeof plan !== 'object' || !['rerun', 'continue', 'fill-missing', 'dispute'].includes(String(plan.mode))) {
      return { ok: false, errors: ['重试计划格式非法'] }
    }
    const rec = await store.load(sessionId)
    if (!rec) return { ok: false, errors: ['会话不存在'] }

    const source = toRetrySource(rec)
    const v = validateRetryPlan(plan, source)
    if (!v.ok) return { ok: false, errors: v.errors, notices: v.notices }

    // 构造新议题：重试不污染原会话
    const topic: Topic = {
      ...source.topic,
      id: `topic_${Date.now()}`,
      createdAt: nowMs(),
    }
    if (plan.mode === 'continue') {
      // 背景材料追加上一场报告摘要，让模型有上下文
      topic.background = [source.topic.background, '', '【上一场讨论摘要】', source.reportSummary]
        .filter(Boolean)
        .join('\n')
    }
    if (plan.mode === 'dispute' && plan.disputeId) {
      const d = source.open.find((x) => x.id === plan.disputeId)
      if (d) {
        // 背景材料同样会发给模型：匿名轨里写出名称等于把身份说回去，
        // 所以只按「第 N 方」陈述立场；署名轨用可读名称，内部 id 对模型没有语义
        const who = (agentId: string, i: number): string =>
          source.config.anonymousReview ? `第${i + 1}方` : modelName(agentId)
        topic.background = [
          source.topic.background,
          '',
          '【本次仅就以下分歧点再辩】',
          d.claim,
          ...d.sides.map((s, i) => `${who(s.agentId, i)} 曾主张：${s.argument}`),
        ]
          .filter(Boolean)
          .join('\n')
      }
    }

    const config: SessionConfig = {
      ...source.config,
      ...(plan.maxRoundsOverride ? { maxRounds: plan.maxRoundsOverride } : {}),
      // 补跑模式只让缺席模型参与；dispute 模式只让两个对辩方参与
      ...(plan.mode === 'fill-missing'
        ? { participantIds: [...source.absentAgentIds] }
        : plan.mode === 'dispute' && plan.duelAgentIds
          ? { participantIds: [...plan.duelAgentIds] }
        : {}),
    }

    const retryInputError = validateSessionInput(topic, config)
    if (retryInputError) return { ok: false, errors: [retryInputError], notices: v.notices }

    try {
      await startSession(topic, config, {
        retryMode: plan.mode,
        source,
        notices: v.notices,
        disputeId: plan.disputeId,
      })
      return { ok: true, notices: v.notices, topic: topic.title }
    } catch (e) {
      return { ok: false, errors: [(e as Error).message], notices: v.notices }
    }
  })

  ipcMain.handle('report:get', async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null
    const r = await store.loadReport(sessionId)
    return r
  })

  ipcMain.handle('report:export-markdown', async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      return { ok: false, reason: '会话标识非法' }
    }
    const r = await store.loadReport(sessionId)
    if (!r) return { ok: false, reason: '找不到该会话的报告，可先重新生成一份。' }
    const rec = await store.load(sessionId)
    const md = reportToMarkdown(r, rec?.topic ?? defaultTopic())
    const base = await exportBaseFor(sessionId, rec)
    const out = path.join(dataDir(), 'exports', `${base}.md`)
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, md, 'utf8')
    revealExport(out)
    return { ok: true, path: out }
  })

  /**
   * 导出报告为 HTML / PDF / 图片。
   *
   * 与 Markdown 导出的分工：MD 由主进程从存档重排，适合再加工；这三种是渲染端把
   * 屏幕上那份报告原样取回来（见 shared/report-export 的装配），所以版式只有一份，
   * 界面改版后导出自动跟着变。文档先落成 .report.html 再由一次性窗口转格式，
   * 出问题时磁盘上始终留着一份可读的中间产物。
   */
  ipcMain.handle('report:export', async (_e, payload: unknown) => {
    const parsed = parseReportDoc(payload)
    if (!parsed.ok) return parsed
    const doc = parsed.doc
    const format = (payload as ReportExportPayload).format
    if (format !== 'html' && format !== 'pdf' && format !== 'png') {
      return { ok: false, reason: '不支持的导出格式' }
    }
    const dir = path.join(dataDir(), 'exports')
    await fs.mkdir(dir, { recursive: true })
    const base = await exportBaseFor(doc.sessionId)
    const htmlPath = path.join(dir, `${base}.report.html`)
    await fs.writeFile(htmlPath, buildExportDoc(doc), 'utf8')
    if (format === 'html') {
      revealExport(htmlPath)
      return { ok: true, path: htmlPath }
    }
    const out = path.join(dir, `${base}.report.${format}`)
    try {
      if (format === 'pdf') await renderExportPdf(htmlPath, out)
      else await renderExportPng(htmlPath, out)
    } catch (e) {
      // 中间文档已经写成功：把它的存在一并说出来，别让人以为什么都没留下
      return { ok: false, reason: `${(e as Error).message}（HTML 版已导出：${htmlPath}）` }
    }
    revealExport(out)
    return { ok: true, path: out }
  })

  /**
   * 复制报告整页为图片到剪贴板。
   *
   * 走的是 png 导出同一条渲染路径，只是产物不落盘 —— 中间文档写到 exports 下的
   * 临时名，渲染完即删；留着的话会和真正的 .report.html 混在一起，看不出哪份是导过的。
   */
  ipcMain.handle('report:copy-image', async (_e, payload: unknown) => {
    const parsed = parseReportDoc(payload)
    if (!parsed.ok) return parsed
    const doc = parsed.doc
    const dir = path.join(dataDir(), 'exports')
    await fs.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `${await exportBaseFor(doc.sessionId)}.clipboard.tmp.html`)
    try {
      await fs.writeFile(tmp, buildExportDoc(doc), 'utf8')
      const buf = await renderExportPngBuffer(tmp)
      const img = nativeImage.createFromBuffer(buf)
      if (img.isEmpty()) return { ok: false, reason: '渲染结果为空，请改用导出图片。' }
      clipboard.writeImage(img)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    } finally {
      await fs.unlink(tmp).catch(() => undefined)
    }
  })

  /**
   * 重新生成已结束研讨的报告。
   *
   * buildReport 是纯函数：只吃持久化的 SessionRecord（发言/共识/分歧/分数/介入/对辩），
   * 不调用任何模型。所以「重新生成」= 用当前报告渲染逻辑重算一遍并覆写落盘，
   * 零成本、可反复、不受模型可用性影响。用于渲染逻辑升级后刷新旧会话，
   * 或补一场因早期错误而残缺的报告。
   */
  ipcMain.handle('report:regenerate', async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      return { ok: false, reason: '会话标识非法' }
    }
    // 正在进行的当前会话没有可信的落盘快照，拒绝重算
    if (sessionId === currentSessionId && orchestrator && !sessionFinalizing) {
      return { ok: false, reason: '研讨仍在进行，结束之后再重新生成。' }
    }
    const rec = await store.load(sessionId)
    if (!rec) return { ok: false, reason: '找不到该会话的记录。' }
    if (rec.state !== 'DONE' && rec.state !== 'ABORTED' && rec.state !== 'FAILED') {
      return { ok: false, reason: '该研讨尚未结束。' }
    }
    try {
      const prev = rec.report ?? (await store.loadReport(sessionId).catch(() => null))
      const modelNames = new Map<string, string>()
      const modelTransports = new Map<string, TransportKind>()
      // 先用旧报告记账的名字/通道兜底，再用当前模型表覆盖：
      // 被移除或改名的模型仍要有可读署名，不能落回原始 id。
      for (const m of prev?.meta?.models ?? []) {
        modelNames.set(m.id, m.displayName)
        modelTransports.set(m.id, m.transport)
      }
      for (const m of models) {
        modelNames.set(m.id, m.displayName)
        modelTransports.set(m.id, m.transport)
      }
      const finishedReason = (rec.finishedReason ??
        prev?.meta?.finishedReason ??
        'failed') as ReportFinishedReason
      const report = buildReport({
        topic: rec.topic,
        config: rec.config,
        utterances: rec.utterances,
        confirmed: rec.confirmed,
        open: rec.open,
        explored: rec.explored ?? [],
        scores: rec.scores,
        modelNames,
        modelTransports,
        totalCostUsd: rec.totalCostUsd,
        durationMs:
          prev?.meta?.durationMs ?? Math.max(0, (rec.updatedAt ?? 0) - (rec.createdAt ?? 0)),
        budgetLimited: prev?.meta?.budgetLimited ?? false,
        moderatorUnavailable: prev?.meta?.moderatorUnavailable ?? finishedReason === 'no-moderator',
        finishedReason,
        interventions: rec.interventions ?? [],
        duels: rec.duels ?? [],
        // 重算不能把审计与阶段耗时丢了：互评名次、认同可核对率都从它们聚合而来
        moderatorAudit: rec.moderatorAudit ?? [],
        stageTimings: rec.stageTimings ?? [],
        // 基线与幻觉账本都是一次真实调用的产物，只能来自存档；缺了就显式标注「无」
        baseline: rec.baseline ?? prev?.baseline ?? null,
        baselineCompare: rec.baselineCompare ?? prev?.baselineCompare ?? null,
        hallucination: rec.hallucination ?? prev?.hallucination ?? null,
        finalReview: rec.finalReview ?? prev?.finalReview ?? null,
        ledger: rec.ledger,
        timeLimited: rec.timeLimited ?? prev?.meta?.timeLimited ?? false,
        digestCompacted: rec.digestCompacted ?? prev?.meta?.digestCompacted ?? false,
        dedup: rec.dedup ?? prev?.meta?.dedup,
      })
      const transformed = { ...report, sessionId }
      await store.saveReport(sessionId, transformed)
      return { ok: true, report: transformed }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  })

  /**
   * 导出完整讨论记录（逐条发言 + 每条的输入提示词）。
   *
   * 与报告导出的分工：报告是「结论」，这个是「过程」。用户复盘某个模型为什么
   * 这么说时，需要看到的是它当时收到的上下文，而非主持人概括后的摘要。
   */
  ipcMain.handle('session:export-transcript', async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return { ok: false }
    const rec = await store.load(sessionId)
    if (!rec) return { ok: false }
    const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
    const md = buildTranscriptMarkdown(rec, nameOf)
    const titlePart = await exportBaseFor(sessionId, rec)
    const out = path.join(dataDir(), 'exports', `${titlePart}.transcript.md`)
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, md, 'utf8')
    revealExport(out)
    return { ok: true, path: out }
  })

  ipcMain.handle('secrets:set', async (_e, ref: string, value: string) => {
    if (typeof ref !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(ref)) {
      return { ok: false, encrypted: false, reason: '密钥引用非法' }
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 20_000) {
      return { ok: false, encrypted: false, reason: '密钥不能为空且不能过长' }
    }
    try {
      await secrets.set(ref, value)
      return { ok: true, encrypted: secrets.isAvailable }
    } catch (e) {
      return { ok: false, encrypted: false, reason: (e as Error).message }
    }
  })

  ipcMain.handle('secrets:has', (_e, ref: string) => ({
    has: typeof ref === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(ref) ? secrets.has(ref) : false,
  }))

  /*
   * 更新与「关于」。状态在内存里，渲染层挂载时先取一次快照、之后接 update:state 的推送 ——
   * 事件流不会因为谁没在看就重放，所以「离开再回来」必须靠这条 get 补回当前阶段。
   */
  ipcMain.handle('update:state', () => updater.state())
  ipcMain.handle('update:check', async () => updater.check())
  ipcMain.handle('update:download', async () => updater.download())
  ipcMain.handle('update:install', () => updater.install())
  ipcMain.handle('update:open-release', () => {
    updater.openReleasePage()
    return { ok: true }
  })
  ipcMain.handle('about:info', async (): Promise<AboutInfo> => ({
    version: app.getVersion(),
    dataDir: app.getPath('userData'),
    packaged: app.isPackaged,
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
  }))
  ipcMain.handle('about:open-data-dir', () => {
    void shell.openPath(app.getPath('userData'))
    return { ok: true }
  })
}

/** 装配历史列表条目：把 SessionRecord 压成渲染层直接可用的结构 */
async function buildHistoryList(): Promise<HistoryEntry[]> {
  const all = await store.list()
  const out: HistoryEntry[] = []
  for (const r of all) {
    const report = r.report ?? (await store.loadReport(r.id).catch(() => null))
    // 早期落盘的记录没有 interventions/duels 等字段，读取时归一化，
    // 否则单条老会话就会让整个历史列表抛错
    const utterances = r.utterances ?? []
    const absent = [...new Set(utterances.filter((u) => u.absent).map((u) => u.agentId))]
    const reason = r.finishedReason
    out.push({
      id: r.id,
      title: r.topic.title,
      background: r.topic.background,
      strategy: r.topic.strategy,
      state: r.state,
      finishedReason: reason,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      rounds: (r.scores ?? []).length,
      totalCostUsd: r.totalCostUsd,
      consensusCount: (r.confirmed ?? []).length,
      openDisputeCount: (r.open ?? []).filter((d) => d.status === 'open').length,
      absentAgentIds: absent,
      interventionCount: (r.interventions ?? []).length,
      duelCount: (r.duels ?? []).length,
      hasReport: report !== null,
      retryModeTag: r.retryMode,
      statusNote: statusNoteOf(r.state, reason),
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 会话状态的一句话说明，供用户判断"为何要重试" */
function statusNoteOf(state: string, reason: SessionRecord['finishedReason']): string {
  const finished = state === 'DONE' || state === 'ABORTED' || state === 'FAILED'
  if (!finished) return '进行中'
  if (reason === 'aborted') return '用户中止，结论可能不完整'
  if (reason === 'no-moderator') return '主持不可用，共识度未评估'
  if (reason === 'max-rounds') return '轮次用尽仍未收敛'
  if (reason === 'converged') return '结论收敛'
  if (reason === 'failed') return '异常终止'
  return FINISH_REASON_LABEL[reason ?? ''] ?? '已结束'
}

function toRetrySource(rec: SessionRecord): RetrySource {
  const absent = [...new Set(rec.utterances.filter((u) => u.absent).map((u) => u.agentId))]
  const spoken = [
    ...new Set(rec.utterances.filter((u) => !u.absent && !u.human).map((u) => u.agentId)),
  ]
  return {
    sessionId: rec.id,
    topic: rec.topic,
    config: rec.config,
    confirmed: rec.confirmed.map((c) => ({
      claim: c.claim,
      support: c.support,
      confirmedRound: c.confirmedRound,
    })),
    open: rec.open.map((d) => ({
      id: d.id,
      claim: d.claim,
      sides: d.sides.map((s) => ({ agentId: s.agentId, argument: s.argument })),
      openedRound: d.openedRound,
    })),
    absentAgentIds: absent,
    spokenAgentIds: spoken,
    finishedReason:
      rec.finishedReason === 'failed' ? 'aborted' : (rec.finishedReason ?? 'max-rounds'),
    reportSummary: rec.report?.executiveSummary ?? '（上一场无报告摘要）',
  }
}

// ---------------------------------------------------------------------------
// 会话驱动
// ---------------------------------------------------------------------------

/**
 * 启动一场会话。
 * retryContext 非空表示这是一次重试，会透传给编排器以启用对应语义。
 */
async function startSession(
  topic: Topic,
  incoming: SessionConfig,
  retryContext?: { retryMode: RetryMode; source: RetrySource; notices: string[]; disputeId?: string },
): Promise<void> {
  if (sessionFinalizing || (orchestrator && !['INIT', 'DONE', 'ABORTED', 'FAILED', 'REPORT_GEN'].includes(orchestrator.getState()))) {
    throw new Error('已有会话正在运行，请先终止或等待其完成')
  }
  /*
   * 先归一化，再让函数体只认这一份：投影、编排器、落盘必须看的是同一个配置。
   * 以前它们收的是渲染端原样传上来的对象，于是「主进程注入的收束分数线」只在落盘里生效 ——
   * 阈值一旦不再是用户填的数，编排器就会拿到 undefined。
   */
  const config = normalizeSessionConfig(incoming)
  const runId = ++currentRunId
  sessionFinalizing = false
  currentTopic = topic
  currentConfig = config
  currentRetry = retryContext ?? null
  sessionStartedAt = nowMs()
  currentSessionId = makeId('sess')

  /**
   * 对外投影开场即建：外部消费者要的是「正在进行」的可见性，
   * 等收尾才有文件就退化成报告导出了。
   */
  projection = new SessionProjection(path.join(dataDir(), 'sessions'), {
    sessionId: currentSessionId,
    topic,
    config,
    names: Object.fromEntries(models.map((m) => [m.id, m.displayName])),
    startedAt: sessionStartedAt,
  })
  projection.append({
    type: 'session-start',
    topicId: topic.id,
    sessionId: currentSessionId,
    retryMode: retryContext?.retryMode ?? null,
    retrySourceId: retryContext?.source.sessionId ?? null,
  })

  orchestrator = new Orchestrator(topic, config, {
    getAgent,
    nameOf: modelName,
    getModerator: () => buildModerator(config.moderatorId),
    extractStance,
    // 纯 API 场不该等满 4 分钟：一个卡住的请求拖住整轮，比判它缺席更糟。
    // 有网页模型才留 240s —— 那是在等一个真人页面把答案打完。
    roundWallClockMs: roundWallClockMs(
      config.participantIds.map((id) => models.find((m) => m.id === id)?.transport ?? 'webview'),
    ),
  })
  // 开场快照必须在编排器就位之后：liveDigest 读的是它的状态，
  // 提前写会把上一场的结论当成本场的开场。
  applyLiveDigest()

  // dispute 模式：把用户选中的分歧登记为专项对辩，随后由编排器执行
  if (retryContext?.retryMode === 'dispute') {
    const d = retryContext.source.open.find((x) => x.id === retryContext.disputeId)
    if (d) {
      orchestrator.requestDuel(
        d.sides.map((s) => s.agentId).slice(0, 2),
        d.claim,
      )
    }
  }

  // 重试模式需在 run() 之前设定（编排器据此短路或注入前提）
  if (retryContext) {
    orchestrator.startAsRetry(retryContext.retryMode, retryContext.source, retryContext.notices)
  }

  orchestrator.on('event', (e: OrchestratorEvent) => {
    send('orchestrator:event', e)
    /**
     * 对外投影只收结构性事件：*-delta 是逐字流（一秒几十条），
     * 主持进度同理（150ms 一条，一场几百条），落进事件流会把读者淹没，
     * 而每条发言的完整文本本来就随 utterance-done 落盘。
     * 每个结构事件都重写一次快照 —— 一场讨论也就几十次、每次几 KB，串行队列排得下。
     */
    if (!e.type.endsWith('-delta') && e.type !== 'moderator-progress') {
      projection?.append(e)
      applyLiveDigest()
    }
    // 编排关键节点进流水线日志：缺席/主持驳回/暂停是用户能看到的失败，
    // 只靠现场复现脚本无法回答「那一场到底发生了什么」。
    if (e.type === 'absent' || e.type === 'moderator-rejected' || e.type === 'paused' || e.type === 'resumed' || e.type === 'error' || e.type === 'done') {
      diag.log({
        ts: Date.now(),
        layer: e.type === 'moderator-rejected' ? 'moderator' : e.type === 'done' ? 'output' : 'runtime',
        stage: e.type,
        subject: e.type === 'absent' ? e.utterance.agentId : undefined,
        sessionId: topic.id,
        ok: e.type === 'done' || e.type === 'resumed',
        detail:
          e.type === 'absent'
            ? `${e.utterance.absentReason ?? '-'} · ${e.utterance.content.slice(0, 200)}`
            : e.type === 'moderator-rejected'
              ? `attempt=${e.attempt} ${e.errors.join(' | ').slice(0, 200)}`
              : e.type === 'paused'
                ? e.reason
                : e.type === 'resumed'
                  ? '用户继续'
                  : e.type === 'error'
                    ? e.message
                    : e.reason,
      })
    }
    if (e.type === 'done') {
      void finalizeSession(e.reason, runId)
    }
  })

  void orchestrator.run().catch((e) => {
    send('orchestrator:event', { type: 'error', message: (e as Error).message })
    void finalizeSession('failed', runId)
  })
}

/**
 * 主持通道。真实实现在 agents/moderator-channel.ts —— 抽出去是为了让 45 秒空闲断流、
 * 总时长封顶、4xx 退整包这三条闸门能用本地假端点复现，不必真机真 token。
 */
function buildModerator(moderatorId: string | null) {
  if (!moderatorId) return null
  const cfg = models.find((m) => m.id === moderatorId)
  if (!cfg?.api) return null
  return createModeratorChannel({
    id: cfg.id,
    api: cfg.api,
    getSecret: (ref) => secrets.get(ref),
    log: (e) => diag.log(e),
  })
}

/**
 * 从编排器现取一份「此刻的结论」，用于对外快照。
 *
 * 只读内存状态、不触发任何模型调用；拿不到编排器就返回 null（调用方自行跳过）。
 */
function liveDigest(finishedReason?: string | null): DigestSnapshot | null {
  if (!orchestrator || !currentConfig) return null
  const latestByAgent = new Map<string, Utterance>()
  for (const u of orchestrator.getAllUtterances()) {
    const prev = latestByAgent.get(u.agentId)
    if (!prev || u.round >= prev.round) latestByAgent.set(u.agentId, u)
  }
  return {
    state: orchestrator.getState(),
    round: orchestrator.getRound(),
    confirmed: orchestrator.getConsensusPoints(),
    open: orchestrator.getDisputes(),
    scores: orchestrator.getScores(),
    latest: [...latestByAgent.values()]
      .sort((a, b) => b.round - a.round || a.startedAt - b.startedAt)
      .map((u) => ({
        round: u.round,
        agent: u.human ? '人类参与者' : modelName(u.agentId),
        snippet: u.content.slice(0, 160),
        absent: !!u.absent,
      })),
    spentUsd: orchestrator.getSpentUsd(),
    finishedReason: finishedReason ?? null,
  }
}

/** 用此刻的状态刷新对外快照；编排器/投影还没就位就静默跳过 */
function applyLiveDigest(finishedReason?: string | null): void {
  if (!projection) return
  const snap = liveDigest(finishedReason)
  if (snap) projection.writeDigest(snap)
}

async function finalizeSession(
  reason: 'converged' | 'max-rounds' | 'aborted' | 'no-moderator' | 'failed',
  runId = currentRunId,
): Promise<void> {
  if (runId !== currentRunId || sessionFinalizing || !orchestrator || !currentTopic || !currentConfig) return
  const reportStartedAt = nowMs()
  sessionFinalizing = true
  try {
    pool.dismissAll()

  const utterances = orchestrator.getAllUtterances()
  const interventions = orchestrator.getInterventions()
  const duels = orchestrator.getDuels()
  const moderatorAudit = orchestrator.getModeratorAudit()
  const hallucination = orchestrator.getHallucinationReport()
  const ledger = orchestrator.getLedger()
  // 编排器只在正常结局时走 finalize；异常路径不会到这里
  const report = buildReport({
    topic: currentTopic,
    config: currentConfig,
    utterances,
    confirmed: orchestrator.getConsensusPoints(),
    open: orchestrator.getDisputes(),
    explored: orchestrator.getExplored(),
    scores: orchestrator.getScores(),
    modelNames: new Map(models.map((m) => [m.id, m.displayName])),
    modelTransports: new Map(models.map((m) => [m.id, m.transport])),
    totalCostUsd: orchestrator.getSpentUsd(),
    durationMs: nowMs() - sessionStartedAt,
    budgetLimited: orchestrator.isBudgetLimited(),
    moderatorUnavailable: orchestrator.isModeratorUnavailable(),
    finishedReason: reason,
    interventions,
    duels,
    moderatorAudit,
    // 此刻还没有 report 阶段自身的耗时（报告正在生成），存档里的 stageTimings 才是全量
    stageTimings: orchestrator.getStageTimings(),
    baseline: orchestrator.getBaseline(),
    baselineCompare: orchestrator.getBaselineCompare(),
    finalReview: orchestrator.getFinalReview(),
    hallucination,
    ledger,
    timeLimited: orchestrator.isTimeLimited(),
    digestCompacted: orchestrator.isDigestCompacted(),
    dedup: orchestrator.getDedup(),
  })
  orchestrator.recordStage('report', reportStartedAt, `生成报告（${reason}）`)

  const sessionId = currentSessionId
  const transformed = { ...report, sessionId }
  const persistedState = reason === 'failed' ? 'FAILED' : reason === 'aborted' ? 'ABORTED' : 'DONE'

  await store.saveReport(sessionId, transformed)
  await store.save({
    id: sessionId,
    topic: currentTopic,
    config: currentConfig,
    state: persistedState,
    rounds: [],
    utterances,
    confirmed: orchestrator.getConsensusPoints(),
    open: orchestrator.getDisputes(),
    explored: orchestrator.getExplored(),
    scores: orchestrator.getScores(),
    interventions,
    duels,
    finishedReason: reason,
    retryMode: currentRetry?.retryMode ?? null,
    retrySourceId: currentRetry?.source.sessionId ?? null,
    report: transformed,
    totalCostUsd: orchestrator.getSpentUsd(),
    moderatorAudit,
    stageTimings: orchestrator.getStageTimings(),
    baseline: orchestrator.getBaseline(),
    baselineCompare: orchestrator.getBaselineCompare(),
    hallucination,
    finalReview: orchestrator.getFinalReview(),
    ledger,
    timeLimited: orchestrator.isTimeLimited(),
    digestCompacted: orchestrator.isDigestCompacted(),
    dedup: orchestrator.getDedup(),
    createdAt: sessionStartedAt,
    updatedAt: nowMs(),
  })

    /**
     * 通知必须紧跟落盘：日志切片只是事后回看的便利品，
     * 它一旦抛错就把「报告已生成」吞掉，用户看到的是一动不动的「正在生成报告…」。
     */
    send('report:ready', { sessionId, report: transformed })

    // 投影以终态收尾：补一条结束事件和一份标明结局的快照，排空写入队列后停笔。
    // close() 不会抛 —— 队列每一环都自带兜底，投影坏了不该让报告背锅。
    projection?.append({ type: 'session-end', reason, sessionId })
    applyLiveDigest(reason)
    await projection?.close()
    projection = null

    try {
      await diag.flush()
      // 本场日志切片随会话存档：失败不自证就必须能事后回看 ——
      // 复现脚本的分区/视口与真实运行并不等价，只有当场记录才可信。
      await diag.exportSession(currentTopic.id, path.join(dataDir(), 'sessions', `${sessionId}.diag.jsonl`))
    } catch (e) {
      send('orchestrator:event', { type: 'error', message: `本场诊断日志导出失败：${(e as Error).message}` })
    }
  } catch (e) {
    send('orchestrator:event', { type: 'error', message: `报告保存失败：${(e as Error).message}` })
  } finally {
    if (runId === currentRunId) sessionFinalizing = false
  }
}

/**
 * 立场标记抽取（供程序核算主张一致度，PRD 6.7）。
 * MVP 阶段用轻量启发式，只识别显式表态句式；不做 NLU。
 */
function extractStance(
  _agentId: string,
  content: string,
): 'support' | 'oppose' | 'neutral' | 'conditional' | undefined {
  const t = content.slice(0, 800)
  if (/(我(们)?(强烈)?(反对|不赞成|不同意|不建议)|反对这一|concede? no)/i.test(t)) return 'oppose'
  if (/(我(们)?(强烈)?(支持|赞成|同意|推荐)|应当采用|应该采用|endors(e|ed))/i.test(t)) return 'support'
  if (/(取决于|前提是|在.{0,12}前提下|conditional|trade-?off|需要权衡)/i.test(t)) return 'conditional'
  if (/(中立|客观来看|两边都有|each has)/i.test(t)) return 'neutral'
  return undefined
}

function defaultTopic(): Topic {
  return {
    id: 'unknown',
    title: '未命名议题',
    background: '',
    strategy: 'roundtable',
    attachments: [],
    createdAt: nowMs(),
  }
}
