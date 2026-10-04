/**
 * Torra 主进程入口
 *
 * 安全基线（PRD 11.2）：
 * - contextIsolation: true + sandbox: true
 * - 站点 WebView 零 Node 权限
 * - preload 仅通过 contextBridge 暴露白名单方法
 */

import { app, BrowserWindow, ipcMain, nativeTheme, session } from 'electron'
import path from 'node:path'
import { promises as fs, readFileSync } from 'node:fs'
import { AdapterRegistry } from './adapters/registry'
import { WebviewPool, probeSessionCookies } from './webview/pool'
import { ApiAgent } from './agents/api-agent'
import { WebviewAgent } from './agents/webview-agent'
import type { Agent } from './agents/agent'
import { Orchestrator, type OrchestratorEvent } from './orchestrator/orchestrator'
import { FileSessionStore } from './store/session-store'
import { KeychainSecretStore } from './store/keychain'
import { buildReport, reportToMarkdown } from './report/report'
import { buildTranscriptMarkdown } from '../shared/transcript'
import { makeId, nowMs } from '../shared/invariants'
import { PICKER_SCRIPT } from './webview/picker'
import { collectScan, createSmartAdd, scanWindow } from './setup/smart-add'
import type { AdapterSpec } from '../shared/adapter'
import { diag } from './diagnostics/log'
import { persistReport, runDoctor, type DoctorDeps } from './diagnostics/doctor'
import {
  DEFAULT_THEME_MODE,
  isThemeMode,
  resolveTheme,
  type ThemeMode,
  type ThemeResolved,
} from '../shared/theme'
import type { DoctorReport } from '../shared/diagnostics'
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
  TurnContext,
  Digest,
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
let models: ModelConfig[] = []
/** 初始化完成信号——渲染层首次 listModels 须等待，否则拿到空数组 */
let _bootResolve!: () => void
const bootDone = new Promise<void>((r) => { _bootResolve = r })
let orchestrator: Orchestrator | null = null
let currentTopic: Topic | null = null
let currentConfig: SessionConfig | null = null
/** 本场是否为重试及其上下文（null 表示全新讨论） */
let currentRetry: { retryMode: RetryMode; source: RetrySource; notices: string[] } | null = null
let sessionStartedAt = 0
let currentRunId = 0
let sessionFinalizing = false

function dataDir(): string {
  return path.join(app.getPath('userData'), 'torra')
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
  if (typeof c.consensusThreshold !== 'number' || !Number.isFinite(c.consensusThreshold) || c.consensusThreshold < 0 || c.consensusThreshold > 100) {
    return '共识阈值必须为 0~100'
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
  if (c.moderatorId && ids.includes(c.moderatorId)) return '主持模型不能同时作为参会模型'
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
  return null
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
      models.push({ ...m })
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

  // id 从名称派生：小写、非字母数字转连字符
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'custom'

  let id = `web-${slug}`
  let n = 2
  while (registry.get(id) || models.some((m) => m.id === id)) {
    id = `web-${slug}-${n}`
    n += 1
  }

  const sel = input.selectors ?? { input: '', stream: '' }
  const mode = input.completion_mode ?? 'dom_stable'
  const spec: AdapterSpec = {
    id,
    name,
    transport: 'webview',
    entry,
    selectors: {
      input: sel.input || 'textarea',
      ...(sel.send ? { send: sel.send } : {}),
      ...(sel.stop ? { stop: sel.stop } : {}),
      ...(sel.generating ? { generating: sel.generating } : {}),
      stream: sel.stream || 'div',
    },
    ...(input.input_kind ? { input_kind: input.input_kind } : {}),
    send_mode: input.send_mode ?? (sel.send ? 'click' : 'enter'),
    stream_mode: input.stream_mode ?? 'last',
    completion: {
      mode,
      timeout_s: Math.round((input.max_wait_s ?? 180) * 1.2),
      ...(mode === 'dom_stable' ? { stable_ms: input.stable_ms ?? 3000 } : {}),
    },
    automation: {
      typing_delay_ms: [80, 220],
      pre_send_pause_ms: [500, 1500],
      max_wait_s: input.max_wait_s ?? 180,
      jitter: true,
    },
    health_probe: sel.input || 'textarea',
    verified_at: new Date().toISOString().slice(0, 10),
    origin: 'user',
    note: '用户自建。站点改版后请在「网页版模型」界面重新校准选择器。',
    tos_notice: '你正在为该站点启用自动化访问。请自行确认不违反其服务条款，账号风险自负。',
  }

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

/** 新建用户自定义 API 模型 */
async function createApiModel(input: NewApiModelInput): Promise<{ ok: boolean; errors?: string[]; id?: string }> {
  if (!input || typeof input !== 'object') return { ok: false, errors: ['配置格式非法'] }
  const name = String(input.displayName ?? '').trim()
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/$/, '')
  const apiKey = String(input.apiKey ?? '').trim()
  const model = String(input.model ?? '').trim()
  if (!name) return { ok: false, errors: ['名称不能为空'] }
  try {
    const parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      return { ok: false, errors: ['Base URL 必须是有效的 http(s) 地址'] }
    }
  } catch {
    return { ok: false, errors: ['Base URL 必须是有效的 http(s) 地址'] }
  }
  if (!apiKey || apiKey.length > 20_000) return { ok: false, errors: ['API Key 不能为空且不能过长'] }
  if (!model) return { ok: false, errors: ['模型名不能为空'] }
  if (input.protocol !== undefined && !['openai', 'anthropic'].includes(input.protocol)) {
    return { ok: false, errors: ['API 协议非法'] }
  }
  for (const [label, value] of [
    ['输入价格', input.pricePerMTokIn],
    ['输出价格', input.pricePerMTokOut],
  ] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      return { ok: false, errors: [`${label}必须是非负数字`] }
    }
  }
  if (input.maxContextTokens !== undefined && (!Number.isInteger(input.maxContextTokens) || input.maxContextTokens < 1)) {
    return { ok: false, errors: ['上下文长度必须是正整数'] }
  }

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
  const color = input.color || USER_COLOR_POOL.find((c) => !usedColors.has(c)) || USER_COLOR_POOL[0]!

  const cfg: ModelConfig = {
    id,
    displayName: name,
    transport: 'api',
    api: {
      baseUrl,
      model,
      apiKeyRef,
      protocol: input.protocol ?? 'openai',
      pricePerMTokIn: input.pricePerMTokIn ?? 0,
      pricePerMTokOut: input.pricePerMTokOut ?? 0,
      maxContextTokens: input.maxContextTokens ?? 128_000,
    },
    color,
    supportsStructuredOutput: input.supportsStructuredOutput ?? (input.protocol ?? 'openai') === 'openai',
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
      : { likelyLoggedIn: false, hits: [], total: 0 }

    const state = probe.likelyLoggedIn ? 'unknown' : 'logged-out'
    const reason = probe.likelyLoggedIn
      ? '检测到登录凭据，实例按需启动'
      : '未检测到登录凭据，实例按需启动（点头像可登录并启动）'
    lastLoginState.set(m.id, state)
    lastLoginReason.set(m.id, reason)
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
  try {
    await fs.access(path.join(dataDir(), 'flags', 'risk-acknowledged'))
  } catch {
    mainWindow?.webContents.once('did-finish-load', () => {
      send('risk:show', {
        message:
          'Torra 通过浏览器自动化驱动你已登录的网页版 AI 服务。自动化访问可能触发平台风控甚至导致账号被封禁，风险由你自行承担。Torra 不提供任何规避验证码或风控的手段，检测到人机验证时会停下并交还你手动处理。',
      })
    })
  }
}

async function markRiskAcknowledged(): Promise<void> {
  const dir = path.join(dataDir(), 'flags')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'risk-acknowledged'), new Date().toISOString(), 'utf8')
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow(): void {
  // CSP 禁止内联脚本，引导代码塞不进 index.html；冷启动主题只能走
  // additionalArguments → preload，在页面第一帧之前写好 data-theme。
  const resolved = resolvedTheme()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'Torra',
    backgroundColor: resolved === 'dark' ? '#0f1115' : '#faf9f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--torra-theme=${resolved}`],
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

app.whenReady().then(() => {
  initTheme()
  createWindow()
  void bootstrap()
  registerIpc()

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
  ipcMain.handle('risk:acknowledge', async () => {
    await markRiskAcknowledged()
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
    return models.map((m) => {
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

  // ---- 用户自建网页版模型（修复「不支持自己配置可选网页 LLM」）----

  ipcMain.handle('models:create-web', async (_e, input: unknown) => createWebModel(input as NewModelInput))

  ipcMain.handle('models:delete-web', async (_e, modelId: string) => {
    if (typeof modelId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(modelId)) return { ok: false, reason: '模型 ID 非法' }
    return deleteWebModel(modelId)
  })

  // ---- 用户自建 API 模型 ----

  ipcMain.handle('models:create-api', async (_e, input: unknown) => createApiModel(input as NewApiModelInput))

  ipcMain.handle('models:delete-api', async (_e, modelId: string) => {
    if (typeof modelId !== 'string' || !/^api-user-[a-z0-9-]{1,64}$/.test(modelId)) return { ok: false, reason: '模型 ID 非法' }
    return deleteWebModel(modelId)
  })

  ipcMain.handle(
    'models:list-remote',
    async (_e, baseUrl: string, apiKey: string) => listRemoteModels(baseUrl, apiKey),
  )

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

  ipcMain.handle('doctor:run', async (_e, opts?: { modelId?: string; probeApi?: boolean }) => {
    const report = await runDoctor(doctorDeps(), {
      modelId: opts?.modelId,
      probeApi: opts?.probeApi ?? true,
    })
    await diag.flush()
    return report
  })

  ipcMain.handle('doctor:log', (_e, opts?: { n?: number; sessionId?: string; subject?: string }) => ({
    events: diag.tail(opts?.n ?? 200, { sessionId: opts?.sessionId, subject: opts?.subject }),
    file: diag.currentFile(),
  }))

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
    try {
      const cookies = await ses.cookies.get({})
      cookieTotal = cookies.length
      authCookies = cookies
        .filter((c) => /token|auth|session|jwt|bearer|uid|passport|__Secure/i.test(c.name))
        .map((c) => `${c.domain} :: ${c.name}`)
        .slice(0, 20)
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
     */
    pool.ensure(modelId, rt, cfg.partition)
    attachLoginWatcher(modelId)
    const ok = pool.present(modelId)
    if (ok) void syncPresentedModel(cfg).catch(() => undefined)
    return { ok, reason: ok ? '' : 'WebView 挂载失败' }
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
    orchestrator?.requestAbort()
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
  ipcMain.handle('chat:send', (_e, payload: unknown) => {
    const p = payload as {
      chatId?: unknown
      message?: unknown
      system?: unknown
      items?: unknown
    }
    const chatId = typeof p.chatId === 'string' ? p.chatId : ''
    const message = typeof p.message === 'string' ? p.message.trim() : ''
    const system = typeof p.system === 'string' ? p.system : undefined
    const items = Array.isArray(p.items) ? (p.items as Array<{ modelId?: unknown; history?: unknown }>) : []
    if (!chatId || !message) return { ok: false, reason: '聊天请求非法' }

    const emptyDigest: Digest = { confirmed: [], open: [], explored: [], rounds: [] }
    const stubTopic: Topic = {
      id: chatId,
      title: message,
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
      const history = [...prior, { role: 'user' as const, content: message }]
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

  // store 要到 bootstrap 才赋值，首次进入历史页可能早于它 —— 不 gate 会抛
  // 「store undefined」，IPC reject 后渲染层若没 catch 就永远停在「加载中」
  ipcMain.handle('session:list', async () => {
    await bootDone
    return (await buildHistoryList()).slice(0, 100)
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
        topic.background = [
          source.topic.background,
          '',
          '【本次仅就以下分歧点再辩】',
          d.claim,
          ...d.sides.map((s) => `${s.agentId} 曾主张：${s.argument}`),
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
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return { ok: false }
    const r = await store.loadReport(sessionId)
    if (!r) return { ok: false }
    const rec = await store.load(sessionId)
    const md = reportToMarkdown(r, rec?.topic ?? defaultTopic())
    const out = path.join(dataDir(), 'exports', `${safeFileName(r.sessionId)}.md`)
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, md, 'utf8')
    return { ok: true, path: out }
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
    const titlePart = safeFileName(rec.topic.title || sessionId).slice(0, 40)
    const out = path.join(dataDir(), 'exports', `${titlePart}-${safeFileName(sessionId)}.transcript.md`)
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, md, 'utf8')
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
  if (reason === 'converged') return '正常达成共识'
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
  config: SessionConfig,
  retryContext?: { retryMode: RetryMode; source: RetrySource; notices: string[]; disputeId?: string },
): Promise<void> {
  if (sessionFinalizing || (orchestrator && !['INIT', 'DONE', 'ABORTED', 'FAILED', 'REPORT_GEN'].includes(orchestrator.getState()))) {
    throw new Error('已有会话正在运行，请先终止或等待其完成')
  }
  const runId = ++currentRunId
  sessionFinalizing = false
  currentTopic = topic
  currentConfig = config
  currentRetry = retryContext ?? null
  sessionStartedAt = nowMs()

  orchestrator = new Orchestrator(topic, config, {
    getAgent,
    getModerator: () => buildModerator(config.moderatorId),
    extractStance,
    roundWallClockMs: 240_000,
  })

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
    // 编排关键节点进流水线日志：缺席/主持驳回/暂停是用户能看到的失败，
    // 只靠现场复现脚本无法回答「那一场到底发生了什么」。
    if (e.type === 'absent' || e.type === 'moderator-rejected' || e.type === 'paused' || e.type === 'error' || e.type === 'done') {
      diag.log({
        ts: Date.now(),
        layer: e.type === 'moderator-rejected' ? 'moderator' : e.type === 'done' ? 'output' : 'runtime',
        stage: e.type,
        subject: e.type === 'absent' ? e.utterance.agentId : undefined,
        sessionId: topic.id,
        ok: e.type === 'done',
        detail:
          e.type === 'absent'
            ? `${e.utterance.absentReason ?? '-'} · ${e.utterance.content.slice(0, 200)}`
            : e.type === 'moderator-rejected'
              ? `attempt=${e.attempt} ${e.errors.join(' | ').slice(0, 200)}`
              : e.type === 'paused'
                ? e.reason
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
 * 主持通道。
 * 主持需要独立的 system prompt（只输出 JSON），与参会模型的发言通道不同，
 * 因此这里直接走 ApiAgent 的底层 HTTP，不复用参会发言的 prompt 组装。
 */
function buildModerator(moderatorId: string | null) {
  if (!moderatorId) return null
  const cfg = models.find((m) => m.id === moderatorId)
  if (!cfg?.api) return null

  return {
    id: cfg.id,
    send: async ({ system, user }: { system: string; user: string }) => {
      const t0 = Date.now()
      const apiKey = secrets.get(cfg.api!.apiKeyRef)
      if (!apiKey) {
        diag.log({
          ts: t0,
          layer: 'moderator',
          stage: 'key-missing',
          subject: cfg.id,
          ok: false,
          detail: `apiKeyRef=${cfg.api!.apiKeyRef} 未配置 —— 这与网页通道的失败无关，改适配器不会修好它`,
        })
        throw new Error('主持模型缺少 API Key')
      }

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 180_000)
      try {
      const anthropic = cfg.api!.protocol === 'anthropic'
      const res = await fetch(
        `${cfg.api!.baseUrl.replace(/\/$/, '')}/${anthropic ? 'messages' : 'chat/completions'}`,
        {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(anthropic
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({
          model: cfg.api!.model,
          ...(anthropic ? { max_tokens: 4096, system } : { response_format: { type: 'json_object' } }),
          temperature: 0.2,
          messages: [
            ...(anthropic ? [] : [{ role: 'system', content: system }]),
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
        },
      )
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        diag.log({
          ts: t0,
          layer: 'moderator',
          stage: 'http',
          subject: cfg.id,
          ok: false,
          ms: Date.now() - t0,
          // 只记状态码与响应片段：响应体可能含请求回显，不整段落盘
          detail: `HTTP ${res.status} ${t.slice(0, 160)}`,
        })
        throw new Error(`主持模型 HTTP ${res.status}: ${t.slice(0, 200)}`)
      }
      diag.log({
        ts: t0,
        layer: 'moderator',
        stage: 'http',
        subject: cfg.id,
        ok: true,
        ms: Date.now() - t0,
        detail: `systemChars=${system.length} userChars=${user.length}`,
      })
      const json = (await res.json()) as {
        choices: Array<{ message: { content: string } }>
        content?: Array<{ type?: string; text?: string }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
        message?: { usage?: { input_tokens?: number; output_tokens?: number } }
      }
      const p = json.usage?.prompt_tokens ?? json.message?.usage?.input_tokens ?? 0
      const c = json.usage?.completion_tokens ?? json.message?.usage?.output_tokens ?? 0
      return {
        content: anthropic
          ? json.content?.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('') || '{}'
          : json.choices[0]?.message?.content ?? '{}',
        usage: {
          promptTokens: p,
          completionTokens: c,
          costUsd:
            Math.round(((p / 1e6) * cfg.api!.pricePerMTokIn + (c / 1e6) * cfg.api!.pricePerMTokOut) * 1e6) / 1e6,
        },
      }
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw new Error('主持模型请求超时')
        throw e
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

async function finalizeSession(
  reason: 'converged' | 'max-rounds' | 'aborted' | 'no-moderator' | 'failed',
  runId = currentRunId,
): Promise<void> {
  if (runId !== currentRunId || sessionFinalizing || !orchestrator || !currentTopic || !currentConfig) return
  sessionFinalizing = true
  try {
    pool.dismissAll()

  const utterances = orchestrator.getAllUtterances()
  const interventions = orchestrator.getInterventions()
  const duels = orchestrator.getDuels()
  // 编排器只在正常结局时走 finalize；异常路径不会到这里
  const report = buildReport({
    topic: currentTopic,
    config: currentConfig,
    utterances,
    confirmed: orchestrator.getConsensusPoints(),
    open: orchestrator.getOpenDisputes(),
    explored: [],
    scores: orchestrator.getScores(),
    modelNames: new Map(models.map((m) => [m.id, m.displayName])),
    totalCostUsd: orchestrator.getSpentUsd(),
    durationMs: nowMs() - sessionStartedAt,
    budgetLimited: orchestrator.isBudgetLimited(),
    moderatorUnavailable: orchestrator.isModeratorUnavailable(),
    finishedReason: reason,
    interventions,
    duels,
  })

  const sessionId = makeId('sess')
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
    open: orchestrator.getOpenDisputes(),
    explored: [],
    scores: orchestrator.getScores(),
    interventions,
    duels,
    finishedReason: reason,
    retryMode: currentRetry?.retryMode ?? null,
    retrySourceId: currentRetry?.source.sessionId ?? null,
    report: transformed,
    totalCostUsd: orchestrator.getSpentUsd(),
    createdAt: sessionStartedAt,
    updatedAt: nowMs(),
  })

    await diag.flush()
    // 本场日志切片随会话存档：失败不自证就必须能事后回看 ——
    // 复现脚本的分区/视口与真实运行并不等价，只有当场记录才可信。
    await diag.exportSession(currentTopic.id, path.join(dataDir(), 'sessions', `${sessionId}.diag.jsonl`))

    send('report:ready', { sessionId, report: transformed })
  } catch (e) {
    send('orchestrator:event', { type: 'error', message: `报告保存失败：${(e as Error).message}` })
  } finally {
    if (runId === currentRunId) sessionFinalizing = false
  }
}

/**
 * 立场标记抽取（供程序核算立场一致度，PRD 6.7）。
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

function safeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}
