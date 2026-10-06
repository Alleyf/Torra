/**
 * 智能添加模型
 *
 * 目标：用户只给一个域名，Torra 自己完成「打开页面 → 读结构 → 推断适配器 →
 * 逐条回页面校验 → 拿不准的问用户」。推断交给一个已配置的 API 模型（配置助手），
 * 但**助手只有建议权，没有决定权**：每个选择器都必须在真实页面上验证命中数，
 * 未通过验证的配置不会进入创建流程。
 *
 * 为什么必须验证：LLM 面对 DOM 会犯两类错 —— 编造一个看着合理但页面根本不存在的
 * class，以及选中「div」这种命中全页的伪选择器。两类错误都会让适配器**静默失效**
 * （发不出消息或读不到回复），而静默失效正是本项目最不能接受的失败模式。
 *
 * 没有配置任何 API 模型时，整条链路降级为纯规则方案（heuristic），
 * 功能不缺失，只是不再"聪明"。
 */

import type { BrowserWindow, WebContents } from 'electron'
import { PICKER_SCRIPT } from '../webview/picker'
import type { WebviewPool } from '../webview/pool'
import type { Agent } from '../agents/agent'
import type { Digest, ModelConfig, Topic, TurnContext } from '../../shared/types'
import type { CompletionMode, InputKind, SendMode, StreamMode } from '../../shared/adapter'
import {
  WEB_ROLES,
  type ApiAttempt,
  type ApiMetaResult,
  type ApiProbe,
  type QuestionTarget,
  type SelectorCheck,
  type SmartQuestion,
  type SmartStage,
  type WebPlan,
  type WebPlanResult,
  type WebRole,
} from '../../shared/smart-add'

// ---------------------------------------------------------------------------
// 页面扫描结果类型（拾取脚本的返回契约）
// ---------------------------------------------------------------------------

export interface PickCandidate {
  selector: string
  candidates: Array<{ selector: string; matches: number }>
  tag: string
  text: string
  inViewport: boolean
}

/** 单次扫描的结果类型 */
export interface PickScan {
  input: PickCandidate[]
  send: PickCandidate[]
  stop: PickCandidate[]
  stream: PickCandidate[]
}

export type RawPick = {
  chosen?: string
  candidates?: Array<{ selector: string; matches: number }>
  tag?: string
  text?: string
  inViewport?: boolean
}

export type RawScan = Partial<Record<keyof PickScan, RawPick[]>>

interface OutlineJson {
  url: string
  title: string
  viewport: number[]
  login: { onLoginPath: boolean; cta: string[]; chatInputs: number }
  iframes: Array<{ host: string; box: number[] }>
  controls: Array<{
    tag: string
    sel: string
    box: number[]
    vis: boolean
    cls: string[]
    txt: string
    type?: string
    role?: string
    aria?: string
    ph?: string
    testid?: string
    id?: string
    ce?: 1
  }>
  lists: Array<{ sel: string; tag: string; kids: number; same: number; textLen: number; cls: string[]; childSel: string; last: string }>
}

/** 扫描窗口用的分区。--live 必须复用同一个分区，否则新分区没有登录态 */
export const PICKER_PARTITION = 'persist:torra-picker'
/** 独立识别窗口的标题：挡住站点的 <title>，让人知道这枚窗口是谁开的、什么时候可以关 */
export const SCAN_WINDOW_TITLE = 'Torra · 网页识别窗口（识别完成后可直接关闭）'
/**
 * 用户关掉识别窗口后，需要真页面的步骤统一的回话。
 * 必须点名「是你关的」和「怎么继续」，否则模型只会把它当成一次网络故障反复重试。
 */
const SCAN_CLOSED_HINT =
  '识别窗口已被关闭（关闭后 Torra 不会自动重开）。要在页面上继续验证或代发，请重新识别一次，或让用户在应用顶部的横幅里重新打开窗口。'
const LOAD_TIMEOUT_MS = 25_000
const SETTLE_MS = 1_500
/** CSR 站点的输入框常在 load 之后数秒才挂载 */
const INPUT_WAIT_MS = 12_000
/** 喂给助手的页面快照上限，超出即截断 */
const MAX_SNAPSHOT_CHARS = 15_000
const MAX_REPAIR_ROUNDS = 2
/**
 * 代发一次消息的结果。
 * left＝文本还留在框里；absent＝页面已跳走或输入框没了（误点别的按钮的 typical 后果），
 * 两者都算「这条消息没交出去」，绝不能当成「发了但没回」。
 */
interface DriveOutcome {
  ok: boolean
  via: string
  input: string
  left?: boolean
  absent?: boolean
  /** 这句话是否已作为页面上的一条消息出现（换 URL 的站点靠它区分「开了这轮对话」和「草稿被丢掉」） */
  echoed?: boolean
  url?: string
  reason?: string
}

/** 代发一条消息后，等页面上长出回复的上限 */
const REPLY_WAIT_MS = 90_000
/** 浏览器级按键发出后，留多久让站点清空输入框 */
const NATIVE_CHECK_MS = 700
/** 站点换了 URL 时，等用户气泡渲染出来的轮次（发消息是异步的，早一拍就白补发一条） */
const SEND_SETTLE_POLLS = 5
const SEND_SETTLE_MS = 800
/** 回复节点出现后再等一下，让气泡里的文字够识别用 */
const REPLY_SETTLE_MS = 2_500
const REPLY_POLL_MS = 800

/**
 * 把页面原始返回归一化成 UI 契约。
 * 页面侧用 chosen 表示「推荐项」，渲染层统一读 selector ——
 * 少了这一层改名，弹窗读到的就是 undefined。
 *
 * 本文件这几个纯函数导出仅供 npm run test:smart-add 回归：它们决定
 * 「扫描结果会不会崩 UI」「校验结论是否可信」，出错时页面上看不出来。
 */
export function toPickScan(raw: RawScan): PickScan {
  const map = (list?: RawPick[]) =>
    (list ?? []).map((c) => ({
      selector: c.chosen ?? '',
      candidates: c.candidates ?? [],
      tag: c.tag ?? '',
      text: c.text ?? '',
      inViewport: c.inViewport ?? false,
    }))
  return { input: map(raw.input), send: map(raw.send), stop: map(raw.stop), stream: map(raw.stream) }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 等页面真正可用：先等导航结束，再等输入框挂载 */
async function waitReady(wc: WebContents): Promise<void> {
  if (wc.isLoading()) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, LOAD_TIMEOUT_MS)
      wc.once('did-finish-load', () => {
        clearTimeout(t)
        setTimeout(resolve, SETTLE_MS)
      })
    })
  }
  const deadline = Date.now() + INPUT_WAIT_MS
  while (Date.now() < deadline) {
    const n = (await wc
      .executeJavaScript(`document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]').length`, true)
      .catch(() => 0)) as number
    if (n > 0) return
    await sleep(600)
  }
}

/** 注入拾取脚本并一次取回 scan() + outline() */
async function capturePage(
  wc: WebContents,
): Promise<{ ok: boolean; scan?: PickScan; outline?: OutlineJson; reason?: string }> {
  try {
    await wc.executeJavaScript(PICKER_SCRIPT, true)
    const raw = (await wc.executeJavaScript('window.__torraPicker.scan()', true)) as RawScan
    const outline = (await wc.executeJavaScript('window.__torraPicker.outline()', true)) as OutlineJson
    const scan = toPickScan(raw ?? {})
    const total = scan.input.length + scan.send.length + scan.stop.length + scan.stream.length
    if (total === 0 && (outline?.controls?.length ?? 0) === 0) {
      return { ok: false, reason: '页面中未找到候选元素。请确认已登录且停留在对话页面后重试。' }
    }
    return { ok: true, scan, outline }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}

/** 在给定 webContents 上执行拾取扫描（手动扫描路径，只取 scan） */
export async function collectScan(wc: WebContents): Promise<{ ok: boolean; scan?: PickScan; reason?: string }> {
  try {
    await waitReady(wc)
  } catch {
    /* 超时也继续扫，能扫到多少算多少 */
  }
  const cap = await capturePage(wc)
  if (!cap.ok) return { ok: false, reason: cap.reason }
  if (cap.scan && cap.scan.input.length + cap.scan.send.length + cap.scan.stop.length + cap.scan.stream.length === 0) {
    return { ok: false, reason: '页面中未找到候选元素。请确认已登录且停留在对话页面后重试。' }
  }
  return { ok: true, scan: cap.scan }
}

/** 打开一个临时窗口做扫描，扫完即关 */
export async function scanWindow(w: BrowserWindow): Promise<{ ok: boolean; scan?: PickScan; reason?: string }> {
  try {
    await waitReady(w.webContents)
    const res = await collectScan(w.webContents)
    if (!w.isDestroyed()) w.destroy()
    return res
  } catch (e) {
    if (!w.isDestroyed()) w.destroy()
    return { ok: false, reason: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// 依赖注入
// ---------------------------------------------------------------------------

export interface SmartAddDeps {
  pool: () => WebviewPool
  getAgent: (id: string) => Agent | undefined
  models: () => ModelConfig[]
  resolveKey: (ref: string) => string | null
  emit: (stage: SmartStage) => void
  log: (e: { stage: string; ok: boolean; detail?: string; subject?: string }) => void
  /**
   * 识别窗口的开 / 关要广播给界面。
   *
   * 那枚独立窗口会盖在应用之上，而它的标题栏不属于 Torra 的界面 ——
   * 用户找不到、也不敢关（关了怕前功尽弃）。所以在应用里给一条常驻横幅：
   * 窗口开着时看得见，关闭按钮在这儿也按得动。
   */
  onScanWindow: (st: { open: boolean; entry?: string }) => void
}

// ---------------------------------------------------------------------------
// 助手调用
// ---------------------------------------------------------------------------

const EMPTY_DIGEST: Digest = { confirmed: [], open: [], explored: [], rounds: [] }

function assistantCtx(user: string, system: string): TurnContext {
  const topic: Topic = {
    id: 'smart-add',
    title: user.slice(0, 120),
    background: '',
    strategy: 'roundtable',
    attachments: [],
    createdAt: Date.now(),
  }
  return {
    sessionId: 'smart-add',
    round: 1,
    topic,
    digest: EMPTY_DIGEST,
    callout: null,
    maxLenChars: 8_000,
    chat: { history: [{ role: 'user', content: user }], system },
  }
}

/**
 * 用配置助手做一次问答。
 *
 * 复用 ApiAgent 的 chat 通道而不是另写一个 fetch：这样鉴权、超时、
 * 思维链剥离、费用统计都走同一条已经验证过的路，不再制造第二套实现。
 */
async function askAssistant(
  deps: SmartAddDeps,
  modelId: string,
  system: string,
  user: string,
): Promise<{ ok: boolean; text?: string; name?: string; reason?: string }> {
  const agent = deps.getAgent(modelId)
  if (!agent) {
    return { ok: false, reason: `配置助手「${modelId}」不可用（缺少 API Key 或实例未就绪）` }
  }
  if (agent.transport !== 'api') {
    return { ok: false, reason: '配置助手必须是 API 模型：网页通道无法接收结构化的页面快照' }
  }
  try {
    const res = await agent.send(assistantCtx(user, system), () => {})
    return { ok: true, text: res.content, name: agent.displayName }
  } catch (e) {
    return { ok: false, reason: `配置助手调用失败：${(e as Error).message}` }
  }
}

/** 从模型回复里抠出 JSON —— 容忍 ```json 包裹和前后废话 */
function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced?.[1] ?? text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 方案清洗与校验
// ---------------------------------------------------------------------------

const INPUT_KINDS: InputKind[] = ['textarea', 'contenteditable']
const SEND_MODES: SendMode[] = ['click', 'enter']
const STREAM_MODES: StreamMode[] = ['last', 'all']
const COMPLETION_MODES: CompletionMode[] = ['dom_stable', 'stop_button_hidden', 'generating_absent']
const QUESTION_TARGETS = ['name', 'entry', 'input_kind', 'send_mode', 'stream_mode', 'completion_mode', ...WEB_ROLES.map((r) => `selectors.${r}`)]

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const enumOf = <T extends string>(v: unknown, allowed: T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback
const num01 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined)

/** 允许助手把 selector 写成快照里的原文；只拒绝超长与控制字符 */
export function sanitizeSelectors(raw: Record<string, unknown>): Record<WebRole, string> {
  const out = { input: '', send: '', stop: '', stream: '', generating: '' } as Record<WebRole, string>
  for (const role of WEB_ROLES) {
    const v = str(raw?.[role], 400)
    if (v && !/[\u0000-\u001f]/.test(v)) out[role] = v
  }
  return out
}

export function sanitizeQuestions(raw: unknown): SmartQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: SmartQuestion[] = []
  for (const q of raw.slice(0, 3)) {
    const prompt = str((q as SmartQuestion)?.prompt, 200)
    const target = str((q as SmartQuestion)?.target, 40)
    if (!prompt || !QUESTION_TARGETS.includes(target)) continue
    const record = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>
    const options = (Array.isArray(record.options) ? record.options : [])
      .map((o: unknown) => {
        const option = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
        return { value: str(option.value, 400), label: str(option.label, 80) }
      })
      .filter((o) => o.value && o.label)
      .slice(0, 6)
    if (options.length === 0) continue
    out.push({
      id: str((q as SmartQuestion)?.id, 40) || `q${out.length + 1}`,
      prompt,
      target: target as SmartQuestion['target'],
      options,
      free_text: !!(q as SmartQuestion)?.free_text,
    })
  }
  return out
}

/**
 * 用真实页面的命中数给每个选择器定级。
 *
 * 命中 0 一定是错的；命中全页（如 `div`）同样是错的 —— 它会"成功"读到
 * 整页文本，让适配器看起来工作正常，实际产出垃圾。所以宽匹配也判 warn。
 *
 * covers：命中元素里含着输入框。回复容器不可能包含提问框，一旦包含就说明
 * 选中的是整页外壳（main / body / 列表外层）。它常常只命中 1 个，
 * 光看命中数完全放行 —— 运行时会读到一片与回复无关的文本，
 * 表现为「生成结束，但未捕获到内容」，这是最难查的一类故障，所以直接判 fail。
 */
export function gradeCheck(role: WebRole, selector: string, matches: number, covers = false): SelectorCheck {
  if (!selector) {
    return { selector, matches: 0, level: role === 'input' || role === 'stream' ? 'fail' : 'ok', note: '未填写' }
  }
  if (matches === 0) return { selector, matches, level: 'fail', note: '页面上找不到该元素' }
  if (role === 'stream' && covers) {
    return { selector, matches, level: 'fail', note: `命中 ${matches} 个，但其中含着输入框 —— 它是整页/列表外壳，不是单条回复` }
  }
  const required = role === 'input' || role === 'stream'
  if (matches > (required ? 40 : 10)) {
    return { selector, matches, level: 'warn', note: `命中 ${matches} 个，过宽可能取错元素` }
  }
  if (matches > 1 && role === 'input') {
    return { selector, matches, level: 'warn', note: `命中 ${matches} 个，自动化会取第一个可见的` }
  }
  return { selector, matches, level: required || matches === 1 ? 'ok' : 'warn', note: matches > 1 ? `命中 ${matches} 个` : undefined }
}

async function verifySelectors(
  wc: WebContents,
  selectors: Record<WebRole, string>,
): Promise<Partial<Record<WebRole, SelectorCheck>>> {
  const out: Partial<Record<WebRole, SelectorCheck>> = {}
  for (const role of WEB_ROLES) {
    const sel = selectors[role]
    if (!sel) {
      out[role] = gradeCheck(role, '', 0)
      continue
    }
    const r = (await wc
      .executeJavaScript(`window.__torraPicker.verify(${JSON.stringify(sel)})`, true)
      .catch(() => ({ ok: false, matches: 0, covers: false, error: 'verify failed' }))) as { matches: number; covers?: boolean }
    out[role] = gradeCheck(role, sel, Number(r?.matches ?? 0), r?.covers === true)
  }
  return out
}

export function blockingFailRoles(checks: Partial<Record<WebRole, SelectorCheck>>): WebRole[] {
  return (['input', 'stream'] as WebRole[]).filter((role) => checks[role]?.level === 'fail')
}

export function blockingFailures(checks: Partial<Record<WebRole, SelectorCheck>>): string[] {
  return blockingFailRoles(checks).map((role) => `${role}: ${checks[role]?.note ?? '未命中'}`)
}

/** 页面上「助手回复」的观测值（由拾取脚本 reply() 返回） */
export interface ReplyProbe {
  bubbles: number
  last: string
  chars: number
  /** 每块文本的指纹，用于认出「多了一句以前没有的话」 */
  sig?: string[]
}

/**
 * 判断回复是否真的长出来了。
 *
 * 不能只看 body 文本长度：站点的计时器、侧栏、滚动加载都会让整页字数变化。
 * 所以优先看「像回复的气泡数」变多，其次按内容指纹找新增的那一块 ——
 * 新开对话常把示例面板整块换成真回复：块数不涨、整页字数还可能跌。
 */
export function replyAppeared(base: ReplyProbe, now: ReplyProbe): boolean {
  if (now.bubbles > base.bubbles) return true
  const known = new Set(base.sig ?? [])
  if ((now.sig ?? []).some((t) => t.length >= 24 && !known.has(t))) return true
  return !!now.last && now.last !== base.last && now.chars >= base.chars + 12
}

/** 代发方式的中文说法；enter+click = 回车没让站点收单，才退回去点候选按钮 */
export function viaLabel(via?: string): string {
  if (via === 'native') return '浏览器级输入（真实按键）'
  if (via === 'enter+click') return '按回车无效后点击发送按钮'
  return '按回车'
}

/**
 * 重新识别后，把人答过的字段保住。
 *
 * 驱动页面发消息会触发一整轮新的推断，新方案不知道哪些值是用户明确指定的。
 * 若直接采用新方案，用户上一轮的回答会被静默改掉 —— 而他要的恰恰是那个答案。
 */
export function preserveAnswers(old: WebPlan, fresh: WebPlan, answered: QuestionTarget[]): WebPlan {
  const next: WebPlan = { ...fresh, selectors: { ...fresh.selectors }, planId: old.planId, rounds: old.rounds + 1 }
  for (const target of answered) {
    if (target === 'entry') {
      next.entry = old.entry
    } else if (target === 'name') {
      next.name = old.name
    } else if (target.startsWith('selectors.')) {
      const role = target.slice('selectors.'.length) as WebRole
      if (WEB_ROLES.includes(role) && old.selectors[role]) next.selectors[role] = old.selectors[role]
    } else {
      const value = (old as unknown as Record<string, unknown>)[target]
      if (typeof value === 'string') applyAnswer(next, target, value)
    }
  }
  next.entry = old.entry
  // 答过的目标不该再问一遍
  next.questions = next.questions.filter((q) => !answered.includes(q.target))
  return next
}

/** 当场量一个选择器的命中数与「是否含输入框」；语法错误按 0 处理，不能让整轮识别崩掉 */
async function verifyOne(wc: WebContents, selector: string): Promise<{ matches: number; covers: boolean }> {
  const r = (await wc
    .executeJavaScript(`window.__torraPicker.verify(${JSON.stringify(selector)})`, true)
    .catch(() => ({ matches: 0, covers: false }))) as { matches?: number; covers?: boolean }
  return { matches: Number(r?.matches ?? 0), covers: r?.covers === true }
}

function editableControls(c: OutlineJson['controls'][number]): boolean {
  return c.ce === 1 || c.tag === 'textarea' || c.tag === 'input' || c.role === 'textbox'
}

/**
 * 助手修不动时，把「到底该选哪个元素」变成一道有真实依据的选择题。
 *
 * 选项不是猜的：每条都当场在页面上量过命中数，命中 0 的根本不会出现在这里。
 * 用户不必懂选择器，只要能认出「哪个是我平时打字的框」。
 */
async function clarificationFromPage(
  wc: WebContents,
  role: WebRole,
  outline: OutlineJson | undefined,
  scan: PickScan | undefined,
): Promise<SmartQuestion | null> {
  const raw: Array<{ value: string; label: string }> = []
  if (role === 'input') {
    for (const c of outline?.controls ?? []) {
      if (!editableControls(c)) continue
      const named = c.ph || c.aria || c.txt || c.testid || ''
      raw.push({ value: c.sel, label: `${c.tag}${named ? ` 「${named.slice(0, 24)}」` : ''}` })
    }
    for (const c of scan?.input ?? []) {
      if (c.selector) raw.push({ value: c.selector, label: `${c.tag}${c.text ? ` 「${c.text.slice(0, 24)}」` : ''}` })
    }
  } else {
    for (const l of outline?.lists ?? []) {
      if (l.childSel) raw.push({ value: l.childSel, label: `重复列表里的单条气泡（同类 ${l.same} 条）` })
      raw.push({ value: `${l.sel} > ${l.tag}`, label: `重复容器（同类子项 ${l.same} 个）里的最后一条` })
    }
    for (const c of scan?.stream ?? []) {
      if (c.selector) raw.push({ value: c.selector, label: `回复节点 ${c.tag} 「${(c.text ?? '').slice(0, 24)}」` })
    }
  }

  const seen = new Set<string>()
  const options: SmartQuestion['options'] = []
  for (const item of raw) {
    const value = item.value.trim().slice(0, 400)
    if (!value || seen.has(value)) continue
    seen.add(value)
    const { matches: hits, covers } = await verifyOne(wc, value)
    if (hits <= 0 || hits > 400) continue
    // 回复容器类选项如果罩住了输入框，选中它必然读错内容，不给用户这种坑
    if (role === 'stream' && covers) continue
    options.push({ value, label: `${item.label.slice(0, 56)}｜命中 ${hits}`, hint: value })
    if (options.length >= 6) break
  }
  if (options.length === 0) return null
  return {
    id: `page-${role}`,
    target: `selectors.${role}`,
    prompt:
      role === 'input'
        ? '这几个元素都确实在页面上。哪个是你平时输入提问的框？'
        : '助手的回复要从这些地方读取。哪一个（或哪一类）是单条回复？',
    options,
    free_text: true,
  }
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const WEB_SYSTEM = `你是浏览器自动化适配器的配置专家。你的任务：读一份网页结构快照，为 Torra 的网页版模型推断出一份可用的适配器配置。

Torra 的适配器字段含义：
- selectors.input：用户输入提问的输入框。textarea/input 或 contenteditable 元素。
- selectors.send：发送按钮。若该站按 Enter 发送，留空即可（留空即代表用键盘发送）。
- selectors.stop：生成过程中出现的「停止」按钮。很多站点没有独立停止按钮，留空。
- selectors.stream：单条「助手回复」的容器（不是整页、不是消息列表的外层容器）。自检标准：它内部绝不能包含输入框，包含输入框的一定是整页外壳（main/body 之类），一律不可用。站点没有语义类时，用 lists 里那条重复结构的 childSel（单条气泡的选择器）；childSel 缺失才退成「容器 sel > 重复子标签」。
- selectors.generating：仅生成过程中存在的元素（loading 指示器）。没有就留空。
- input_kind：textarea=原生输入框；contenteditable=Lexical/Slate 富文本。
- send_mode：enter=按 Enter 发送；click=点击发送按钮。
- stream_mode：last=读最后一个匹配节点；all=拼接全部匹配节点（回复被切成多段的站点）。
- completion_mode：dom_stable=回复文本连续若干秒不变即视为结束（最鲁棒，默认选它）；stop_button_hidden=停止按钮消失；generating_absent=生成标志消失。

硬性规则，违反即视为失败：
1. 所有 selector 必须逐字取自快照中已存在的 sel 字段或 scan_candidates 里的 selector。禁止自己拼一个看起来合理的 class。
2. 拿不准的字段不要猜，留空并在 questions 里向用户提问（最多 3 个问题，只问真正拿不准的）。
3. questions 里每个 option 的 value 必须是目标字段的合法取值；target 为 selectors.* 时 value 就是候选 selector 原文。
4. 快照里若显示停在登录页（login.onLoginPath 或 chatInputs=0），不要编配置，直接在 risks 里说明并结束。
5. 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块之外的内容。

输出结构：
{"name":"2-6字的站点简称","selectors":{"input":"","send":"","stop":"","stream":"","generating":""},"input_kind":"textarea","send_mode":"enter","stream_mode":"last","completion_mode":"dom_stable","stable_ms":3000,"confidence":{"input":0.0,"send":0.0,"stop":0.0,"stream":0.0,"overall":0.0},"why":{"input":"一句话依据","stream":"一句话依据","overall":"一句话总体判断"},"risks":["需要用户注意的点"],"questions":[]}`

/**
 * 代发消息之后追加给配置助手的指示。
 *
 * 第一轮识别最常见的死点是 stream：新对话页面上没有回复节点，模型只能留空。
 * 此刻回复已经真实存在，必须明确告诉它去读哪一处，否则它照抄上一轮的保守结论。
 */
const DRIVE_HINT = `页面上现在已经有一条真实的助手回复（见 scan_candidates.stream 与 lists 里尾部的气泡）。请从中选出「单条回复容器」填进 selectors.stream：它内部绝不能包含输入框，且要能指向最新那条回复；再按这条回复的实际结构确认 stream_mode 与 completion_mode。其余字段照旧，拿不准的写进 questions。`

function buildWebUser(entry: string, outline: OutlineJson, scan: PickScan, extra: string): string {  const scanSlim = {
    input: scan.input.map((c) => ({ sel: c.selector, tag: c.tag, text: c.text, vp: c.inViewport, cands: c.candidates.filter((x) => x.matches > 0).slice(0, 4) })),
    send: scan.send.map((c) => ({ sel: c.selector, tag: c.tag, text: c.text, cands: c.candidates.filter((x) => x.matches > 0).slice(0, 3) })),
    stop: scan.stop.map((c) => ({ sel: c.selector, text: c.text, cands: c.candidates.filter((x) => x.matches > 0).slice(0, 3) })),
    stream: scan.stream.map((c) => ({ sel: c.selector, tag: c.tag, text: c.text.slice(0, 40), cands: c.candidates.filter((x) => x.matches > 0).slice(0, 3) })),
  }
  const body = JSON.stringify({ entry, page: outline, scan_candidates: scanSlim }, null, 0)
  const clipped = body.length > MAX_SNAPSHOT_CHARS ? `${body.slice(0, MAX_SNAPSHOT_CHARS)}\n/* 快照过大已截断 */` : body
  return `${clipped}\n\n${extra}`
}

// ---------------------------------------------------------------------------
// 降级方案：纯规则推断
// ---------------------------------------------------------------------------

/** 从扫描候选里挑一个「唯一命中」的选择器 */
function uniqueSelector(list: PickCandidate[]): string {
  for (const c of list) {
    const hit = c.candidates.find((x) => x.matches === 1)
    if (hit) return hit.selector
  }
  return ''
}

/**
 * 站点没有语义类时，用「重复容器里的单条气泡」当回复节点。
 * 气泡自己的选择器（childSel）优先，拿不到才退到「容器 > 子标签」。
 * 取容器本身（如 main）是错的 —— 那是整页外壳，读到的是全部内容。
 */
function listBubbleSelector(outline: OutlineJson): string {
  const l = outline.lists[0]
  if (!l?.sel) return ''
  // nth-child 路径会把读取钉死在某一条历史回复上，宁可退回「容器 > 子标签」
  if (l.childSel && !l.childSel.includes(':nth-child(')) return l.childSel
  return l.tag ? `${l.sel} > ${l.tag}` : ''
}

function heuristicPlan(entry: string, outline: OutlineJson, scan: PickScan): WebPlan {
  const inputSel = uniqueSelector(scan.input)
  const sendSel = uniqueSelector(scan.send)
  const stopSel = uniqueSelector(scan.stop)
  const streamSel = uniqueSelector(scan.stream) || listBubbleSelector(outline)
  const inputEl = scan.input.find((c) => c.selector === inputSel) ?? scan.input[0]
  const isCe = /contenteditable/i.test(inputSel) || inputEl?.tag === 'div'
  return {
    planId: '',
    entry,
    name: siteName(entry, outline.title),
    selectors: { input: inputSel, send: sendSel, stop: stopSel, stream: streamSel, generating: '' },
    input_kind: isCe ? 'contenteditable' : 'textarea',
    send_mode: sendSel ? 'click' : 'enter',
    stream_mode: 'last',
    completion_mode: 'dom_stable',
    stable_ms: 3000,
    confidence: { overall: 0.35 },
    why: { overall: '未调用配置助手，本方案由「唯一命中」规则推断得出' },
    risks: [
      '未使用配置助手（需先在设置里添加一个 API 模型）。规则只能保证选择器存在，不能判断它是不是对话输入框。',
    ],
    questions: [],
    checks: {},
    source: 'heuristic',
    assistant: null,
    login: loginVerdict(outline),
    rounds: 1,
  }
}

function siteName(entry: string, title: string): string {
  const t = (title || '').replace(/[-—|·].*$/, '').trim()
  if (t && t.length <= 12) return t
  try {
    return new URL(entry).hostname.replace(/^www\./, '').split('.')[0] ?? '自定义站点'
  } catch {
    return '自定义站点'
  }
}

/**
 * 登录态粗判。
 *
 * 刻意保守：只有「停在登录路径」或「有登录按钮且没有对话输入框」才判未登录，
 * 其余情况一律 unknown —— 误报未登录会把用户挡在流程外，漏报只是多一步人工确认。
 */
function loginVerdict(o: OutlineJson): WebPlan['login'] {
  const l = o?.login
  if (!l) return { state: 'unknown', reason: '页面未返回登录线索' }
  if (l.onLoginPath) return { state: 'logged-out', reason: '页面停在登录/注册路径' }
  if (l.chatInputs === 0 && l.cta.length > 0) return { state: 'logged-out', reason: `页面上只有登录入口（${l.cta.join('、')}），没有对话输入框` }
  if (l.chatInputs > 0 && l.cta.length === 0) return { state: 'logged-in', reason: '页面存在对话输入框且无登录入口' }
  return { state: 'unknown', reason: `存在 ${l.chatInputs} 个输入框，同时看到 ${l.cta.join('、') || '无'} 登录入口` }
}

// ---------------------------------------------------------------------------
// 对外实现
// ---------------------------------------------------------------------------

export interface SmartAdd {
  planWeb(input: { entry: string; assistantModelId?: string }): Promise<WebPlanResult>
  refineWeb(planId: string, answers: Record<string, string>): Promise<WebPlanResult>
  verifyWeb(planId: string, selectors: Record<WebRole, string>): Promise<WebPlanResult>
  driveWeb(planId: string, input: { text?: string }): Promise<WebPlanResult>
  closeScanWindow(): void
  probeApi(input: { address: string; apiKey?: string }): Promise<ApiProbe>
  apiMeta(input: { assistantModelId?: string; host: string; baseUrl: string; model: string; protocol: 'openai' | 'anthropic' }): Promise<ApiMetaResult>
}

export function createSmartAdd(deps: SmartAddDeps): SmartAdd {
  /** 同一时刻只保留一个扫描窗口：反复开新窗口会让用户搞不清该登录哪个 */
  let scanWin: BrowserWindow | null = null
  /** 用户亲手关掉识别窗口后置为真，直到下一次「重新识别」才清掉 */
  let scanDismissed = false
  /** planId → 方案。澄清回答回来时靠它续上，不必重新扫页面 */
  const plans = new Map<string, WebPlan>()
  /**
   * planId → 用户已经答过的字段。
   * 驱动页面重识别会产出一份全新方案，靠这份记录才知道哪些值是人定的、不能被改掉。
   */
  const answeredTargets = new Map<string, QuestionTarget[]>()
  let seq = 0

  const stage = (stage_: SmartStage['stage'], text: string, kind: SmartStage['kind'] = 'web') =>
    deps.emit({ kind, stage: stage_, text })

  async function ensureScanWindow(entry: string, reopen = true): Promise<BrowserWindow | null> {
    // 用户已经把它关过一次：被动复验（答完问题 / 改完选择器的重扫）不再弹回来，
    // 否则「关闭」是无效操作，用户看到的是关不掉，于是学会不敢关。
    if (scanDismissed && !reopen) return null
    const pool = deps.pool()
    if (scanWin && !scanWin.isDestroyed()) {
      const cur = (() => {
        try {
          return new URL(scanWin!.webContents.getURL()).host
        } catch {
          return ''
        }
      })()
      // 用户可能正在这个窗口里登录：同站点就不重载，否则一切白干
      if (cur && cur === safeHost(entry)) {
        if (!scanWin.isVisible()) scanWin.show()
        return scanWin
      }
      void scanWin.loadURL(entry).catch(() => undefined)
      // loadURL 是异步的：稍等一下，免得 waitReady 误判「导航已结束」而扫到旧页面
      await sleep(600)
      return scanWin
    }
    const w = pool.openLoginWindow('picker', entry, {
      partition: PICKER_PARTITION,
      title: SCAN_WINDOW_TITLE,
    })
    scanWin = w
    scanDismissed = false
    w.on('closed', () => {
      // 还挂在 scanWin 上 = 不是 closeScanWindow 收的，是用户自己关的
      if (scanWin === w) {
        scanWin = null
        scanDismissed = true
      }
      deps.onScanWindow({ open: false })
    })
    deps.onScanWindow({ open: true, entry })
    return w
  }

  async function resolveAssistant(assistantModelId?: string): Promise<ModelConfig | null> {
    const apiModels = deps.models().filter((m) => m.transport === 'api')
    if (apiModels.length === 0) return null
    const picked =
      (assistantModelId && apiModels.find((m) => m.id === assistantModelId)) ||
      apiModels.find((m) => m.enabled && deps.resolveKey(m.api?.apiKeyRef ?? '')) ||
      null
    return picked
  }

  /**
   * 网页模型智能识别主流程。
   *
   * 三轮闭环：出方案 → 页面校验 → 带失败信息回修，最多 MAX_REPAIR_ROUNDS 次。
   * 闭环放在这里而不是交给模型自由发挥：只有 Torra 能在真实页面上验证，
   * 而模型看不到验证结果就不会自我纠正。
   */
  async function planWeb(input: { entry: string; assistantModelId?: string }): Promise<WebPlanResult> {
    const entry = String(input.entry ?? '').trim()
    const parsed = safeUrl(entry)
    if (!parsed) return { ok: false, reason: '地址必须是有效的 http(s) URL' }

    stage('open', '打开页面…')
    let w: BrowserWindow
    try {
      // 重新识别是一次明确的「我要看这个页面」，所以它有权把用户关掉的窗口再开起来
      const opened = await ensureScanWindow(parsed.toString())
      if (!opened) return { ok: false, reason: SCAN_CLOSED_HINT }
      w = opened
    } catch (e) {
      return { ok: false, reason: `无法打开页面：${(e as Error).message}` }
    }

    stage('wait', '等待页面渲染出对话界面…')
    try {
      await waitReady(w.webContents)
    } catch {
      /* 超时继续，让 capturePage 说明看到了什么 */
    }
    if (w.isDestroyed()) return { ok: false, reason: '扫描窗口被关闭，请重试' }

    const r = await inferOnPage(w, parsed.toString(), input.assistantModelId)
    if (!r.ok) return r
    const plan = r.plan
    plan.planId = `plan-${Date.now().toString(36)}-${seq++}`
    plans.set(plan.planId, plan)
    if (plans.size > 8) plans.delete(plans.keys().next().value as string)

    stage('done', '识别完成，请确认方案')
    deps.log({ stage: 'smart-add:web', ok: true, detail: `${plan.source} ${JSON.stringify(plan.selectors)}`, subject: plan.planId })
    // 扫描窗口刻意保留：用户改选择器时要就地复验，重开一次页面要好几秒。
    // 弹窗卸载时经 closeScanWindow 统一关闭。
    return { ok: true, plan }
  }

  /**
   * 在已经打开的页面上跑一次完整推断：读结构 → 出方案 → 回页面校验 → 回修 → 仍不确定就问用户。
   *
   * planWeb 与 driveWeb 共用它。后者代发一条消息、让回复气泡先长出来，然后必须走同一套闭环重识别 ——
   * 两条路径各判一次会出现「向导会问用户、助手不会」的分叉。
   */
  async function inferOnPage(
    w: BrowserWindow,
    entryUrl: string,
    assistantModelId?: string,
    askHint?: string,
  ): Promise<{ ok: false; reason: string } | { ok: true; plan: WebPlan }> {
    stage('snapshot', '读取页面结构…')
    const cap = await capturePage(w.webContents)
    if (!cap.ok || !cap.scan || !cap.outline) {
      return { ok: false, reason: cap.reason ?? '页面读取失败' }
    }

    const login = loginVerdict(cap.outline)
    if (login.state === 'logged-out') {
      return {
        ok: false,
        reason: `${login.reason}。请在已打开的窗口里完成登录，然后点「重新识别」—— 登录态会保留在这个扫描分区里。`,
      }
    }

    const assistant = await resolveAssistant(assistantModelId)
    let plan: WebPlan
    if (!assistant) {
      stage('ask', '未配置 API 模型，改用规则推断…')
      plan = heuristicPlan(entryUrl, cap.outline, cap.scan)
    } else {
      stage('ask', `请配置助手「${assistant.displayName}」分析页面…`)
      const first = await propose(
        deps,
        assistant,
        entryUrl,
        cap.outline,
        cap.scan,
        askHint ?? '请按快照推断，拿不准的写进 questions。',
      )
      if (!first.ok || !first.plan) {
        // 助手不可用时不整体失败：退回规则方案，用户至少还能手动确认
        deps.log({ stage: 'smart-add', ok: false, detail: first.reason, subject: assistant.id })
        plan = heuristicPlan(entryUrl, cap.outline, cap.scan)
        plan.risks.unshift(first.reason ?? '配置助手未返回可用方案')
      } else {
        plan = first.plan
        plan.assistant = { modelId: assistant.id, displayName: assistant.displayName }
        plan.source = 'assistant'
      }
    }

    plan.login = login
    plan.entry = entryUrl

    let lastTried = ''
    for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
      if (w.isDestroyed()) break
      stage('verify', `回页面校验选择器（第 ${round + 1} 轮）…`)
      plan.checks = await verifySelectors(w.webContents, plan.selectors)
      const bad = blockingFailures(plan.checks)
      if (bad.length === 0) break
      if (round === MAX_REPAIR_ROUNDS || plan.source !== 'assistant' || !assistant) {
        plan.risks.push(`仍有必需选择器未通过校验：${bad.join('；')}。请在下方手动改正后再创建。`)
        break
      }
      // 助手反复交同一个 0 命中的选择器时，再问一轮只会多烧 40 秒
      const tried = blockingFailRoles(plan.checks)
        .map((role) => `${role}=${plan.selectors[role]}`)
        .join('&')
      if (tried === lastTried) {
        plan.risks.push('配置助手连续两轮给出同一个未命中的选择器，继续问它没有意义，改由你从页面真实候选里指定。')
        break
      }
      lastTried = tried
      stage('ask', `校验未通过，请助手改正（第 ${round + 2} 轮）…`)
      const retry = await propose(
        deps,
        assistant,
        entryUrl,
        cap.outline,
        cap.scan,
        `上一轮你给出的方案在真实页面上校验失败：${bad.join('；')}。\n上一轮方案：${JSON.stringify(plan.selectors)}\n页面实际可用候选见 scan_candidates。请只改用其中确实存在的选择器，重新输出完整 JSON。禁止重复上面已失败的取值。`,
      )
      if (!retry.ok || !retry.plan) {
        plan.risks.push(`助手修正失败：${retry.reason ?? '未知错误'}`)
        break
      }
      plan = { ...retry.plan, login, entry: entryUrl, assistant: { modelId: assistant.id, displayName: assistant.displayName }, source: 'assistant', rounds: round + 2 }
    }

    // 仍未确认的必需角色：拿页面上真实存在的候选来问用户，而不是留一个死路
    if (!w.isDestroyed()) {
      for (const role of blockingFailRoles(plan.checks ?? {})) {
        if (plan.questions.some((q) => q.target === `selectors.${role}`)) continue
        const q = await clarificationFromPage(w.webContents, role, cap.outline, cap.scan)
        if (q) {
          plan.questions.push(q)
          stage('ask', `需要你确认${role === 'input' ? '输入框' : '回复容器'}，已列出页面真实候选…`)
          if (role === 'stream') {
            // 新开对话页面上根本没有助手回复节点，选择器无从验证 —— 这是最常见的卡点
            plan.risks.push(
              '页面上还没有助手的回复，所以回复容器无从验证。用 torra_send_site_message 代发一条消息，让回复长出来再重识别。',
            )
          }
        } else {
          plan.risks.push(
            `${role === 'input' ? '输入框' : '回复容器'}无法从当前页面确认：页面上没有可校验的候选。${role === 'stream' ? '先用 torra_send_site_message 发一条消息，' : ''}再重新识别。`,
          )
        }
      }
    }

    return { ok: true, plan }
  }

  /** 保证有一个可用的页面供复验；用户关掉的窗口不擅自重开 */
  async function ensurePage(entry: string): Promise<BrowserWindow | null> {
    try {
      const w = await ensureScanWindow(entry, false)
      if (!w) return null
      await waitReady(w.webContents)
      return w.isDestroyed() ? null : w
    } catch {
      return null
    }
  }

  /** 用户答完澄清问题后套用答案：人是最终裁判，答案直接覆盖推断值 */
  async function refineWeb(planId: string, answers: Record<string, string>): Promise<WebPlanResult> {
    const plan = plans.get(planId)
    if (!plan) return { ok: false, reason: '方案已过期，请重新识别' }
    const next: WebPlan = { ...plan, selectors: { ...plan.selectors }, questions: [...plan.questions], risks: [...plan.risks] }
    for (const [qid, value] of Object.entries(answers ?? {})) {
      const q = plan.questions.find((x) => x.id === qid)
      if (!q || !value) continue
      // 非法取值不能静默吞掉 —— 用户会以为已经生效，而方案其实没变
      if (!fitsTarget(q.target, value)) {
        next.risks.push(`回答「${value.slice(0, 60)}」不是 ${q.target} 的合法取值，该问题仍待确认`)
        continue
      }
      applyAnswer(next, q.target, value)
      next.questions = next.questions.filter((x) => x.id !== qid)
      const done = answeredTargets.get(planId) ?? []
      if (!done.includes(q.target)) answeredTargets.set(planId, [...done, q.target])
    }
    const w = await ensurePage(next.entry)
    if (w) {
      next.checks = await verifySelectors(w.webContents, next.selectors)
    } else {
      // 拿不到页面时不能把上一次的命中数继续当成本次的结论 —— 那是一套已经改过的选择器
      next.checks = {}
      next.risks.push('识别窗口已被关闭，本次回答没有在页面上复验；结论按未验证处理。')
    }
    plans.set(planId, next)
    return { ok: true, plan: next }
  }

  /** 用户手改了选择器，重新拿命中数 */
  async function verifyWeb(planId: string, selectors: Record<WebRole, string>): Promise<WebPlanResult> {
    const plan = plans.get(planId)
    if (!plan) return { ok: false, reason: '方案已过期，请重新识别' }
    const clean = sanitizeSelectors(selectors as unknown as Record<string, unknown>)
    const w = await ensurePage(plan.entry)
    if (!w) return { ok: false, reason: scanDismissed ? SCAN_CLOSED_HINT : '页面无法重新打开，请检查网络后重新识别' }
    plan.selectors = clean
    plan.checks = await verifySelectors(w.webContents, clean)
    return { ok: true, plan }
  }

  /**
   * 页面上「像助手回复」的观测值。
   * echo 是刚替用户发出去的那句话：它自己也会变成一条气泡，
   * 页面侧据此把它排掉，否则「发出去了」会被读成「回复回来了」。
   */
  async function probeReply(wc: WebContents, echo = ''): Promise<ReplyProbe> {
    const r = (await wc
      .executeJavaScript(`window.__torraPicker.reply(${JSON.stringify(echo)})`, true)
      .catch(() => null)) as Partial<ReplyProbe> | null
    return {
      bubbles: Number(r?.bubbles ?? 0),
      last: String(r?.last ?? ''),
      chars: Number(r?.chars ?? 0),
      sig: Array.isArray(r?.sig) ? r!.sig!.map(String) : [],
    }
  }

  /** 输入框里是否还留着那句话：留着＝这次发送没被站点接住 */
  async function composerHolds(wc: WebContents, inputSel: string, body: string): Promise<boolean> {
    const r = await wc
      .executeJavaScript(`window.__torraPicker.holds(${JSON.stringify(inputSel)}, ${JSON.stringify(body)})`, true)
      .catch(() => false)
    return r === true
  }

  /** 这句话是否已经以「用户气泡」的形式出现在页面上 —— 站点收下消息的正面证据 */
  async function pageBubble(wc: WebContents, body: string): Promise<boolean> {
    const r = await wc
      .executeJavaScript(`window.__torraPicker.bubble(${JSON.stringify(body)})`, true)
      .catch(() => false)
    return r === true
  }

  /**
   * 输入框还在不在。不在了＝页面被重置/跳走，这次操作不能算「站点把消息收走了」。
   *
   * 只看输入框，不看 URL：新开对话时站点正是靠换 URL（补上会话 id）来建这轮对话，
   * 拿 URL 变化当反证会把成功发送判死，接着补发第二遍。
   */
  async function composerGone(wc: WebContents, inputSel: string): Promise<boolean> {
    const focus = (await wc
      .executeJavaScript(`window.__torraPicker.focusComposer(${JSON.stringify(inputSel)})`, true)
      .catch(() => null)) as { ok?: boolean } | null
    return focus?.ok !== true
  }

  /**
   * 浏览器级输入通道：insertText + 真实回车。
   *
   * 这层非有不可：页内 new KeyboardEvent 造出来的事件 isTrusted=false，
   * 元宝（Quill）实测不认 —— 文本全留在框里，消息根本没出去。
   * 走浏览器输入管线的注入按键对站点而言就是真人敲键盘。
   *
   * 插入是否落地、回车是否被接住，全部由页面自己回答（holds 重新查询输入框），
   * 这里不拿「调用没抛异常」当成功。
   */
  async function driveNative(wc: WebContents, inputSel: string, body: string): Promise<DriveOutcome> {
    const focus = (await wc
      .executeJavaScript(`window.__torraPicker.focusComposer(${JSON.stringify(inputSel)})`, true)
      .catch(() => null)) as { ok?: boolean; reason?: string; input?: string } | null
    if (!focus?.ok) return { ok: false, via: '', input: focus?.input ?? '', reason: focus?.reason ?? '页面没有响应' }

    const url0 = wc.getURL()
    try {
      wc.focus()
      wc.insertText(body)
    } catch (e) {
      return { ok: false, via: '', input: focus.input ?? '', reason: `浏览器级输入不可用：${(e as Error).message}` }
    }
    await sleep(NATIVE_CHECK_MS)
    if (!(await composerHolds(wc, inputSel, body))) {
      // insertText 可能被整体丢掉（窗口没拿到系统焦点），也可能落点后站点立刻改写；
      // 两种都要和「页面被跳走」区分开，否则下一步该重试还是该重识别完全相反
      return {
        ok: false,
        via: 'native',
        input: focus.input ?? '',
        reason: '文本没能落进输入框（浏览器级插入被忽略）',
        absent: await composerGone(wc, inputSel),
      }
    }
    const press = (type: 'keyDown' | 'keyUp' | 'rawKeyDown') => {
      try {
        wc.sendInputEvent({ type, keyCode: 'Return' } as Electron.KeyboardInputEvent)
      } catch {
        /* 某些平台不接受 rawKeyDown，失败后仍按「框里还有字」处理 */
      }
    }
    press('keyDown')
    press('keyUp')
    await sleep(NATIVE_CHECK_MS)
    if (!(await composerHolds(wc, inputSel, body))) {
      return {
        ok: true,
        via: 'native',
        input: focus.input ?? '',
        left: false,
        absent: await composerGone(wc, inputSel),
        echoed: await pageBubble(wc, body),
        url: wc.getURL(),
      }
    }
    // 只监听 rawKeyDown 的编辑器（部分 Lexical 站点）在这一发之后才会走到发送分支
    press('rawKeyDown')
    press('keyUp')
    await sleep(NATIVE_CHECK_MS)
    const left = await composerHolds(wc, inputSel, body)
    return {
      ok: true,
      via: 'native',
      input: focus.input ?? '',
      left,
      absent: await composerGone(wc, inputSel),
      echoed: left ? undefined : await pageBubble(wc, body),
      url: wc.getURL(),
    }
  }

  /** 页内合成事件通道：改 value / execCommand 写文本，先按回车，字还在框里才点发送按钮 */
  async function driveDom(wc: WebContents, inputSel: string, sendSel: string, body: string): Promise<DriveOutcome> {
    const r = (await wc
      .executeJavaScript(
        `window.__torraPicker.drive(${JSON.stringify(inputSel)}, ${JSON.stringify(body)}, ${JSON.stringify(sendSel)})`,
        true,
      )
      .catch((e: Error) => ({ ok: false, reason: `页面无响应：${e.message}` }))) as {
      ok?: boolean
      reason?: string
      via?: string
      input?: string
      left?: boolean
      absent?: boolean
      echoed?: boolean
      url?: string
    }
    return {
      ok: r.ok === true,
      via: r.via ?? '',
      input: r.input ?? '',
      left: r.left,
      absent: r.absent,
      echoed: r.echoed,
      reason: r.reason,
      url: r.url,
    }
  }

  /**
   * 在扫描窗口里替用户发一条消息，等回复长出来，再用同一套闭环重新识别。
   *
   * 为什么必须有这一步：回复容器只能在「页面上已经有一条回复」时验证，
   * 而新开的对话页 stream 恒为 0 候选 —— 识别链卡在这里，原先只能靠人敲键盘。
   * 它会在用户账号下产生一条真实对话，所以调用方（助手工具）必须先过确认卡片。
   *
   * 发送按「浏览器级输入 → 页内合成事件」两个通道依次尝试，成败以输入框是否清空为准，
   * 不拿「脚本没报错」当成功：站点收没收下这条消息，只有页面自己说了算。
   */
  async function driveWeb(planId: string, input: { text?: string }): Promise<WebPlanResult> {
    const plan = plans.get(planId)
    if (!plan) return { ok: false, reason: '方案已过期，请重新识别' }
    const body = String(input.text ?? '').trim().slice(0, 500) || '你好'
    const w = await ensurePage(plan.entry)
    if (!w) return { ok: false, reason: scanDismissed ? SCAN_CLOSED_HINT : '页面无法重新打开，请检查网络后重新识别' }
    const wc = w.webContents
    await wc.executeJavaScript(PICKER_SCRIPT, true).catch(() => undefined)
    const url0 = wc.getURL()

    /**
     * 这条消息真的交出去了吗：框里没字 + 输入框还在。
     *
     * 站点换了 URL（新开对话就是靠换 URL 建这轮会话）时不能直接判死，也不能直接放行：
     * 必须看到页面上多出我们这句话的气泡。只看「框空了」会把误点的导航按钮当成发送成功，
     * 而 URL 一变就判失败又会补发第二遍 —— 元宝真机就重复发了两条「你好」。
     */
    async function delivered(d: DriveOutcome): Promise<boolean> {
      if (!d.ok || d.absent === true || d.left !== false) return false
      if (!d.url || d.url === url0) return true
      if (d.echoed === true) return true
      // 用户气泡是异步渲染的：回车已经生效、页面还在补那一块，先等几拍再下结论
      for (let i = 0; i < SEND_SETTLE_POLLS; i++) {
        await sleep(SEND_SETTLE_MS)
        if (await pageBubble(wc, body)) return true
      }
      return false
    }

    const missWhy = (d: DriveOutcome) =>
      !d.ok
        ? d.reason ?? '未知原因'
        : d.absent === true
          ? `页面被这次操作重置了（现在在 ${d.url || wc.getURL()}）—— 很可能把别的控件当成了发送按钮`
          : d.left === true
            ? '文本仍留在输入框，站点没接住这次发送'
            : `换了页面却找不到我们发出去的那句话（现在在 ${d.url || wc.getURL()}）—— 像是点到了导航控件而不是发送`

    const base = await probeReply(wc, body)
    stage('probe', `用浏览器级输入把「${body}」发出去…`)
    let drive = await driveNative(wc, plan.selectors.input, body)
    if (!(await delivered(drive))) {
      const why = missWhy(drive)
      stage('probe', `浏览器级输入没生效（${why}），改用页内事件补发…`)
      const dom = await driveDom(wc, plan.selectors.input, plan.selectors.send, body)
      drive = dom.ok ? dom : { ...dom, reason: `${dom.reason ?? '未知原因'}（浏览器级通道试过：${why}）` }
    }
    if (!(await delivered(drive))) {
      return {
        ok: false,
        reason: `代发消息失败：${missWhy(drive)}${drive.input ? `（输入框：${drive.input}）` : ''}。请在窗口里人工发一条，再重新识别。`,
      }
    }

    stage('probe', `已${viaLabel(drive.via)}送出「${body}」，等待回复…`)
    const deadline = Date.now() + REPLY_WAIT_MS
    let now = base
    for (;;) {
      if (w.isDestroyed()) return { ok: false, reason: '扫描窗口被关闭，识别中断' }
      now = await probeReply(wc, body)
      if (replyAppeared(base, now)) break
      if (Date.now() > deadline) {
        return {
          ok: false,
          reason:
            `已${viaLabel(drive.via)}把「${body}」发出去（输入框 ${drive.input ?? '?'} 已被站点清空），` +
            `但 ${Math.round(REPLY_WAIT_MS / 1000)}s 内页面上没出现新的长文本块：` +
            `当前 ${now.bubbles} 块、整页 ${now.chars} 字，最后一条「${now.last.slice(0, 40) || '空'}」，` +
            `页面停在 ${wc.getURL()}。若窗口里其实已经回了，说明这些块仍没被探针认出来，需要按页面实际情况再加判据。`,
        }
      }
      await sleep(REPLY_POLL_MS)
    }
    // 让气泡里的文字先长够：刚出现的第一帧常常只有一个字，识别不出容器结构
    await sleep(REPLY_SETTLE_MS)

    const r = await inferOnPage(w, plan.entry, undefined, DRIVE_HINT)
    if (!r.ok) return { ok: false, reason: r.reason }
    const merged = preserveAnswers(plan, r.plan, answeredTargets.get(planId) ?? [])
    // 代发这一步等于在真实页面上做过一次「怎么发送」的实验：哪条通道让站点收下了消息就用哪条。
    // 规则推断爱挑「页面上唯一的按钮」，元宝那次挑中的是「新建对话」——照它建模型，适配器会去开新会话。
    if (drive.via === 'native' || drive.via === 'enter') {
      merged.send_mode = 'enter'
      merged.selectors.send = ''
    }
    // 发出消息后页面标题变成了这轮对话的名字（元宝那次是「初次咨询与AI助手介绍」），
    // 站点名要沿用代发前量到的那一个
    if (plan.name) merged.name = plan.name
    // 人答过的值被保下来后，命中数得按最终这套重新量一遍
    merged.checks = await verifySelectors(wc, merged.selectors)
    merged.risks.push(`本轮由工具代发了一条测试消息「${body}」，站点的对话历史里会多这一条。`)
    plans.set(planId, merged)
    deps.log({
      stage: 'smart-add:drive',
      ok: true,
      detail: `${drive.via} bubbles=${now.bubbles} ${JSON.stringify(merged.selectors)}`,
      subject: planId,
    })
    stage('done', '已代发测试消息并重新识别，请确认方案')
    return { ok: true, plan: merged }
  }

  function closeScanWindow(): void {
    const w = scanWin
    // 先摘引用再 destroy：'closed' 回调靠「还挂在 scanWin 上」判断是不是用户自己关的
    scanWin = null
    scanDismissed = false
    if (w && !w.isDestroyed()) w.destroy()
    deps.onScanWindow({ open: false })
  }

  // ---- API 接入模型：先嗅探，再让助手补元信息 ----

  /**
   * 嗅探 OpenAI / Anthropic 端点。
   *
   * 只做 GET /models：它是唯一「不计费、不改状态」就能同时验证
   * 地址、协议与 Key 的调用。绝不做补全请求 —— 那要花用户的钱。
   */
  async function probeApi(input: { address: string; apiKey?: string }): Promise<ApiProbe> {
    const address = String(input.address ?? '').trim()
    const parsed = safeUrl(address)
    if (!parsed) return { ok: false, attempts: [], reason: '地址必须是有效的 http(s) URL' }

    let key = String(input.apiKey ?? '').trim()
    let reusedFrom: string | undefined
    if (!key) {
      const known = deps
        .models()
        .find((m) => m.transport === 'api' && safeHost(m.api?.baseUrl ?? '') === parsed.host && deps.resolveKey(m.api?.apiKeyRef ?? ''))
      if (known) {
        key = deps.resolveKey(known.api!.apiKeyRef) ?? ''
        reusedFrom = known.displayName
      }
    }

    const bases = candidateBases(parsed)
    stage('probe', `嗅探 ${bases.length} 个候选端点 × 2 种协议…`, 'api')

    const attempts: ApiAttempt[] = []
    const settled = await Promise.all(
      bases.flatMap((base) =>
        (['openai', 'anthropic'] as const).map(async (protocol): Promise<{ base: string; protocol: 'openai' | 'anthropic'; status: number | null; ids: string[]; error?: string }> => {
          const url = `${base.replace(/\/$/, '')}/models`
          try {
            const res = await fetch(url, {
              headers: key
                ? protocol === 'anthropic'
                  ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
                  : { Authorization: `Bearer ${key}` }
                : {},
              signal: AbortSignal.timeout(10_000),
            })
            const text = await res.text().catch(() => '')
            if (!res.ok) return { base, protocol, status: res.status, ids: [], error: `HTTP ${res.status}` }
            const json = JSON.parse(text) as { data?: Array<{ id?: unknown }> }
            const ids = Array.isArray(json?.data) ? json.data.map((d) => String(d?.id ?? '')).filter(Boolean) : []
            return { base, protocol, status: res.status, ids }
          } catch (e) {
            return { base, protocol, status: null, ids: [], error: (e as Error).message }
          }
        }),
      ),
    )

    for (const r of settled) {
      attempts.push({ base: r.base, protocol: r.protocol, status: r.status, ok: r.ids.length > 0, modelCount: r.ids.length, error: r.error })
    }
    const hit = settled.find((r) => r.ids.length > 0)
    if (!hit) {
      const denied = settled.some((r) => r.status === 401 || r.status === 403)
      return {
        ok: false,
        attempts,
        needsKey: denied && !key,
        reason: denied
          ? key
            ? '所有候选端点都拒绝了这把 Key（401/403）。请确认 Key 属于该站点，或改用该站点的控制台 Key。'
            : '端点可达但需要 API Key —— 填入 Key 后重试。'
          : '没有候选端点返回模型清单。它可能不是 API 端点（更像网页版），请改用「网页版」识别。',
      }
    }
    deps.log({ stage: 'smart-add:api', ok: true, detail: `${hit.base} ${hit.protocol} ${hit.ids.length}` })
    return {
      ok: true,
      attempts,
      baseUrl: hit.base,
      protocol: hit.protocol,
      models: hit.ids,
      ...(reusedFrom ? { reason: `已复用「${reusedFrom}」的密钥` } : {}),
    }
  }

  async function apiMeta(input: { assistantModelId?: string; host: string; baseUrl: string; model: string; protocol: 'openai' | 'anthropic' }): Promise<ApiMetaResult> {
    const assistant = await resolveAssistant(input.assistantModelId)
    if (!assistant) {
      return { ok: false, reason: '未配置 API 模型作为配置助手，价格与上下文将按 0 / 128k 占位，请稍后在设置里补全' }
    }
    stage('meta', `请助手补全「${input.model}」的价格与上下文…`, 'api')
    const system = `你在为一款多模型讨论工具登记 API 模型的计费信息。只输出一个 JSON 对象，不要解释。
字段：{"display_name":"中文简称（<=12字）","price_per_m_tok_in":数字, "price_per_m_tok_out":数字, "max_context_tokens":整数, "supports_structured_output":true/false, "confidence":0~1, "note":"一句话说明依据与不确定处"}
价格单位是 USD / 百万 tokens。不确定就给 0 并把 confidence 调低 —— 宁可少算钱，也不要用编造的高价污染费用统计。
supports_structured_output 指该模型能否稳定输出可解析 JSON（能担任主持人）。拿不准就填 false。`
    const user = JSON.stringify({ host: input.host, base_url: input.baseUrl, model: input.model, protocol: input.protocol })
    const res = await askAssistant(deps, assistant.id, system, user)
    if (!res.ok || !res.text) return { ok: false, reason: res.reason ?? '助手无响应' }
    const j = extractJson(res.text) as Record<string, unknown> | null
    if (!j) return { ok: false, reason: '助手返回的内容无法解析为 JSON' }
    const price = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
    return {
      ok: true,
      meta: {
        displayName: str(j.display_name, 40) || input.model,
        pricePerMTokIn: price(j.price_per_m_tok_in),
        pricePerMTokOut: price(j.price_per_m_tok_out),
        maxContextTokens: typeof j.max_context_tokens === 'number' && j.max_context_tokens >= 1 ? Math.round(j.max_context_tokens) : 128_000,
        supportsStructuredOutput: j.supports_structured_output === true,
        confidence: num01(j.confidence) ?? 0.3,
        note: str(j.note, 200),
      },
    }
  }

  return { planWeb, refineWeb, verifyWeb, driveWeb, closeScanWindow, probeApi, apiMeta }
}

// ---------------------------------------------------------------------------
// 助手方案解析
// ---------------------------------------------------------------------------

async function propose(
  deps: SmartAddDeps,
  assistant: ModelConfig,
  entry: string,
  outline: OutlineJson,
  scan: PickScan,
  extra: string,
): Promise<{ ok: boolean; plan?: WebPlan; reason?: string }> {
  const res = await askAssistant(deps, assistant.id, WEB_SYSTEM, buildWebUser(entry, outline, scan, extra))
  if (!res.ok || !res.text) return { ok: false, reason: res.reason ?? '助手无响应' }
  const j = extractJson(res.text) as Record<string, unknown> | null
  if (!j) return { ok: false, reason: '助手返回的内容不是合法 JSON' }
  const sel = sanitizeSelectors((j.selectors ?? {}) as Record<string, unknown>)
  const conf = (j.confidence ?? {}) as Record<string, unknown>
  const why = (j.why ?? {}) as Record<string, unknown>
  const plan: WebPlan = {
    planId: '',
    entry,
    name: str(j.name, 40) || siteName(entry, outline.title),
    selectors: sel,
    input_kind: enumOf(j.input_kind, INPUT_KINDS, /contenteditable/i.test(sel.input) ? 'contenteditable' : 'textarea'),
    send_mode: enumOf(j.send_mode, SEND_MODES, sel.send ? 'click' : 'enter'),
    stream_mode: enumOf(j.stream_mode, STREAM_MODES, 'last'),
    completion_mode: enumOf(j.completion_mode, COMPLETION_MODES, 'dom_stable'),
    stable_ms: typeof j.stable_ms === 'number' && j.stable_ms >= 1000 ? Math.min(15000, Math.round(j.stable_ms)) : 3000,
    confidence: {
      input: num01(conf.input),
      send: num01(conf.send),
      stop: num01(conf.stop),
      stream: num01(conf.stream),
      overall: num01(conf.overall) ?? 0.5,
    },
    why: {
      input: str(why.input, 200),
      send: str(why.send, 200),
      stop: str(why.stop, 200),
      stream: str(why.stream, 200),
      overall: str(why.overall, 200),
    },
    risks: (Array.isArray(j.risks) ? j.risks : []).map((r) => str(r, 200)).filter(Boolean).slice(0, 5),
    questions: sanitizeQuestions(j.questions),
    checks: {},
    source: 'assistant',
    assistant: { modelId: assistant.id, displayName: assistant.displayName },
    login: { state: 'unknown', reason: '' },
    rounds: 1,
  }
  return { ok: true, plan }
}

/** 回答是否是该字段的合法取值。非法值不允许静默套用 */
export function fitsTarget(target: SmartQuestion['target'], value: string): boolean {
  switch (target) {
    case 'input_kind':
      return INPUT_KINDS.includes(value as InputKind)
    case 'send_mode':
      return SEND_MODES.includes(value as SendMode)
    case 'stream_mode':
      return STREAM_MODES.includes(value as StreamMode)
    case 'completion_mode':
      return COMPLETION_MODES.includes(value as CompletionMode)
    case 'name':
      return !!value.trim()
    case 'entry':
      return !!safeUrl(value)
    default:
      return !!value.trim()
  }
}

export function applyAnswer(plan: WebPlan, target: SmartQuestion['target'], value: string): void {
  if (target === 'name') plan.name = value.trim().slice(0, 40)
  else if (target === 'entry') plan.entry = value.trim().slice(0, 500)
  else if (target === 'input_kind') plan.input_kind = enumOf(value, INPUT_KINDS, plan.input_kind)
  else if (target === 'send_mode') plan.send_mode = enumOf(value, SEND_MODES, plan.send_mode)
  else if (target === 'stream_mode') plan.stream_mode = enumOf(value, STREAM_MODES, plan.stream_mode)
  else if (target === 'completion_mode') plan.completion_mode = enumOf(value, COMPLETION_MODES, plan.completion_mode)
  else if (target.startsWith('selectors.')) {
    const role = target.slice('selectors.'.length) as WebRole
    if (WEB_ROLES.includes(role)) plan.selectors = { ...plan.selectors, [role]: value.trim().slice(0, 400) }
  }
}

function safeUrl(raw: string): URL | null {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(withScheme)
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) return null
    return u
  } catch {
    return null
  }
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}

/** 用户常把 https://api.x.com 当成 https://api.x.com/v1 填，这里把常见形态都试一遍 */
function candidateBases(u: URL): string[] {
  const given = u.toString().replace(/\/$/, '')
  const origin = u.origin
  const out: string[] = []
  const push = (s: string) => {
    if (!out.includes(s)) out.push(s)
  }
  push(given)
  if (!/\/v1$/.test(given)) push(`${given}/v1`)
  if (origin !== given) push(origin)
  if (!/\/v1$/.test(origin)) push(`${origin}/v1`)
  return out.slice(0, 4)
}
