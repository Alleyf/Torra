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

const PICKER_PARTITION = 'persist:torra-picker'
const LOAD_TIMEOUT_MS = 25_000
const SETTLE_MS = 1_500
/** CSR 站点的输入框常在 load 之后数秒才挂载 */
const INPUT_WAIT_MS = 12_000
/** 喂给助手的页面快照上限，超出即截断 */
const MAX_SNAPSHOT_CHARS = 15_000
const MAX_REPAIR_ROUNDS = 2

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

function buildWebUser(entry: string, outline: OutlineJson, scan: PickScan, extra: string): string {
  const scanSlim = {
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
  closeScanWindow(): void
  probeApi(input: { address: string; apiKey?: string }): Promise<ApiProbe>
  apiMeta(input: { assistantModelId?: string; host: string; baseUrl: string; model: string; protocol: 'openai' | 'anthropic' }): Promise<ApiMetaResult>
}

export function createSmartAdd(deps: SmartAddDeps): SmartAdd {
  /** 同一时刻只保留一个扫描窗口：反复开新窗口会让用户搞不清该登录哪个 */
  let scanWin: BrowserWindow | null = null
  /** planId → 方案。澄清回答回来时靠它续上，不必重新扫页面 */
  const plans = new Map<string, WebPlan>()
  let seq = 0

  const stage = (stage_: SmartStage['stage'], text: string, kind: SmartStage['kind'] = 'web') =>
    deps.emit({ kind, stage: stage_, text })

  async function ensureScanWindow(entry: string): Promise<BrowserWindow> {
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
    scanWin = pool.openLoginWindow('picker', entry, { partition: PICKER_PARTITION })
    return scanWin
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
      w = await ensureScanWindow(parsed.toString())
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

    const assistant = await resolveAssistant(input.assistantModelId)
    let plan: WebPlan
    if (!assistant) {
      stage('ask', '未配置 API 模型，改用规则推断…')
      plan = heuristicPlan(parsed.toString(), cap.outline, cap.scan)
    } else {
      stage('ask', `请配置助手「${assistant.displayName}」分析页面…`)
      const first = await propose(
        deps,
        assistant,
        parsed.toString(),
        cap.outline,
        cap.scan,
        '请按快照推断，拿不准的写进 questions。',
      )
      if (!first.ok || !first.plan) {
        // 助手不可用时不整体失败：退回规则方案，用户至少还能手动确认
        deps.log({ stage: 'smart-add', ok: false, detail: first.reason, subject: assistant.id })
        plan = heuristicPlan(parsed.toString(), cap.outline, cap.scan)
        plan.risks.unshift(first.reason ?? '配置助手未返回可用方案')
      } else {
        plan = first.plan
        plan.assistant = { modelId: assistant.id, displayName: assistant.displayName }
        plan.source = 'assistant'
      }
    }

    plan.login = login
    plan.entry = parsed.toString()

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
        parsed.toString(),
        cap.outline,
        cap.scan,
        `上一轮你给出的方案在真实页面上校验失败：${bad.join('；')}。\n上一轮方案：${JSON.stringify(plan.selectors)}\n页面实际可用候选见 scan_candidates。请只改用其中确实存在的选择器，重新输出完整 JSON。禁止重复上面已失败的取值。`,
      )
      if (!retry.ok || !retry.plan) {
        plan.risks.push(`助手修正失败：${retry.reason ?? '未知错误'}`)
        break
      }
      plan = { ...retry.plan, login, entry: parsed.toString(), assistant: { modelId: assistant.id, displayName: assistant.displayName }, source: 'assistant', rounds: round + 2 }
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
              '页面上还没有助手的回复，所以回复容器只能靠你指认。更稳的做法：在已打开的窗口里先发一条消息，等回复出现后点「重新识别」。',
            )
          }
        } else {
          plan.risks.push(
            `${role === 'input' ? '输入框' : '回复容器'}无法从当前页面确认：页面上没有可校验的候选。请先进入一个对话页面（发过一条消息最好）再重新识别。`,
          )
        }
      }
    }

    plan.planId = `plan-${Date.now().toString(36)}-${seq++}`
    plans.set(plan.planId, plan)
    if (plans.size > 8) plans.delete(plans.keys().next().value as string)

    stage('done', '识别完成，请确认方案')
    deps.log({ stage: 'smart-add:web', ok: true, detail: `${plan.source} ${JSON.stringify(plan.selectors)}`, subject: plan.planId })
    // 扫描窗口刻意保留：用户改选择器时要就地复验，重开一次页面要好几秒。
    // 弹窗卸载时经 closeScanWindow 统一关闭。
    return { ok: true, plan }
  }

  /** 保证有一个可用的页面供复验；窗口被用户关掉就重开，不让他卡在「窗口已关闭」 */
  async function ensurePage(entry: string): Promise<BrowserWindow | null> {
    try {
      const w = await ensureScanWindow(entry)
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
    }
    const w = await ensurePage(next.entry)
    if (w) {
      next.checks = await verifySelectors(w.webContents, next.selectors)
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
    if (!w) return { ok: false, reason: '页面无法重新打开，请检查网络后重新识别' }
    plan.selectors = clean
    plan.checks = await verifySelectors(w.webContents, clean)
    return { ok: true, plan }
  }

  function closeScanWindow(): void {
    if (scanWin && !scanWin.isDestroyed()) scanWin.destroy()
    scanWin = null
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

  return { planWeb, refineWeb, verifyWeb, closeScanWindow, probeApi, apiMeta }
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
