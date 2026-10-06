/**
 * 助手抽屉 —— 通用运维助手的唯一界面。
 *
 * 为什么是右侧抽屉而不是弹窗：助手会长时间挂在那里等确认、等登录，
 * 模态弹窗会把主界面锁死；抽屉能一边聊一边让网页视图继续工作。
 *
 * 界面按「一轮 = 你问一句 → 它做几步 → 它说一句 → 一行账」组织：
 * 工具调用和思考过程收进同一步骤组，不然大段结论里会夹着一堆执行噪声；
 * 只有真正回给你的话才占一整段；每轮结束补一条统计（耗时/首字/token/费用/步数），
 * 步数按来源分成 工具 / 技能 / MCP 三类标注 —— 后两者的副作用范围和内置工具不同。
 *
 * 四条和主进程约定好的边界，反映在界面上：
 * - 写操作必经确认卡片（卡片在输入框上方，不允许点空白跳过）；
 * - 新建 API 模型时 Key 由这里直接交给主进程：不进对话、不回流给模型，
 *   所以日志里永远不会出现 Key 输入过的痕迹；
 * - 忙碌态以 settled 事件为唯一终点；发送失败走 invoke 返回值，
 *   两条路都会把忙碌态收掉，不会出现「转圈转到天荒地老」；
 * - 历史不靠界面记着：重开面板读主进程（会话没建立时直接读磁盘上最近的一场），
 *   头部的历史按钮还能翻到往场的会话接着聊。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FileCode,
  Folder,
  Hammer,
  History,
  Lightbulb,
  Loader2,
  LogIn,
  Maximize2,
  Minimize2,
  Paperclip,
  Pencil,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Square,
  Target,
  ClipboardList,
  Trash2,
  X,
} from 'lucide-react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { Markdown } from './Markdown'
import { BrandMark } from './BrandMark'
import { Pager, pageSlice } from './Pager'
import { openImageZoom } from './ImageZoom'
import type { ChatAttachmentMeta } from '@shared/types'
import { APPROVAL_MODE_LABEL, RUN_MODE_LABEL, atTokenAt, defaultModeState } from '@shared/assistant'
import type {
  AssistantAction,
  AssistantApprovalPrefs,
  AssistantApprovalRequest,
  AssistantApprovalResolved,
  AssistantHistoryItem,
  AssistantModeState,
  AssistantModelView,
  AssistantOverlayData,
  AssistantSessionStats,
  AssistantSessionView,
  AssistantStatus,
  AssistantStreamEvent,
  AssistantToolGroup,
  AssistantTurnStats,
  AtEntry,
  OverlayItem,
} from '@shared/assistant'

type ThinkingLine = { id: number; kind: 'thinking'; text: string }
type ToolLine = {
  id: number
  kind: 'tool'
  text: string
  toolId: string
  running: boolean
  ok?: boolean
  excerpt?: string
  group: AssistantToolGroup
  /** 开始/结束的墙钟毫秒。历史里没有这两个字段 —— 旧存档不记时间，缺了就不编造耗时 */
  at?: number
  doneAt?: number
  /** 关键入参的一行摘要，渲染成等宽 chip；密钥类参数永远不进这里 */
  brief?: string
}

type Line =
  | { id: number; kind: 'user'; text: string; attachments?: ChatAttachmentMeta[] }
  | { id: number; kind: 'assistant'; text: string }
  | ThinkingLine
  | ToolLine
  | { id: number; kind: 'status'; text: string }
  | { id: number; kind: 'turn-stats'; stats: AssistantTurnStats }
  | { id: number; kind: 'error'; text: string; detail?: string }

/** 渲染用的分组：连续的思考/工具合成一个步骤组，连续的正文合成一段回答 */
type Block =
  | { id: number; kind: 'user'; text: string; attachments?: ChatAttachmentMeta[] }
  | { id: number; kind: 'say'; lines: { id: number; text: string }[] }
  | { id: number; kind: 'steps'; lines: (ToolLine | ThinkingLine)[] }
  | { id: number; kind: 'tally'; stats: AssistantTurnStats }
  | { id: number; kind: 'note'; text: string }
  | { id: number; kind: 'alert'; text: string; detail?: string }

/** Omit 作用在联合类型上只保留公共键，error 支的 detail 会被抹掉，所以要逐支分发 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 一步调用是谁提供的：技能/MCP 的副作用范围和内置工具不同，必须看得出来 */
const GROUP_LABEL: Record<AssistantToolGroup, string> = { tool: '工具', skill: '技能', mcp: 'MCP' }
// 类名写全而不是拼前缀：CSS 里缺哪个，回归守卫（test:session 的类名检查）就报哪个
const GROUP_CLASS: Record<AssistantToolGroup, string> = {
  tool: 'a-tag-tool',
  skill: 'a-tag-skill',
  mcp: 'a-tag-mcp',
}

function fmtMs(n: number): string {
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))
}

function fmtCost(n: number): string {
  if (n <= 0) return '—'
  return n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`
}

function fmtTime(ts: number): string {
  if (!ts) return '未知时间'
  const d = new Date(ts)
  const sameDay = new Date().toDateString() === d.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/**
 * 这一步「对谁做的」：从入参里挑最多两个能认出对象的标量，拼成一行等宽摘要。
 *
 * 名字里带 key/token/secret 的一律跳过 —— 工具参数偶尔会捎带凭据（例如探测远端模型），
 * 而这一行是要显示在界面上、留在会话行里的，不能变成 Key 的落脚处。
 */
const BRIEF_PRIORITY = ['path', 'file', 'filePath', 'command', 'url', 'modelId', 'model', 'id', 'name', 'subject', 'layer', 'query', 'q', 'limit', 'transport']
const BRIEF_SECRET = /key|token|secret|password|cookie|authorization|credential/i

function argsBrief(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([k, v]) => !BRIEF_SECRET.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'),
  )
  if (entries.length === 0) return undefined
  const rank = ([k]: [string, unknown]): number => {
    const i = BRIEF_PRIORITY.indexOf(k.toLowerCase())
    return i < 0 ? BRIEF_PRIORITY.length : i
  }
  const picked = entries.sort((a, b) => rank(a) - rank(b)).slice(0, 2)
  const text = picked
    .map(([k, v]) => {
      const s = String(v)
      return `${k}=${s.length > 30 ? `${s.slice(0, 29)}…` : s}`
    })
    .join(' ')
  return text.length > 78 ? `${text.slice(0, 77)}…` : text
}

/** 归类附件：图片走多模态，其余按文本处理（与 ChatPage 同一套判据） */
function classifyKind(mime: string): 'image' | 'text' {
  return mime.startsWith('image/') ? 'image' : 'text'
}
function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 全屏档：视图偏好，和左栏折叠一样存本机（不进主进程 —— 它不影响任何业务状态）。
 * 关掉应用不该把用户放大出来的宽度悄悄记着，所以这里存的是「下次也这样」。
 */
const FULL_KEY = 'torra.assistant.full'
const readFullPref = (): boolean => {
  try {
    return localStorage.getItem(FULL_KEY) === '1'
  } catch {
    return false
  }
}
const writeFullPref = (on: boolean): void => {
  try {
    localStorage.setItem(FULL_KEY, on ? '1' : '0')
  } catch {
    /* 隐私模式下 localStorage 不可用，忽略 */
  }
}

/**
 * 全屏档的左把手位置（离视口左缘多少像素）。0 = 铺满。
 * 存的是「下次也留这么多」，所以放大不等于把应用锁死。
 */
const INSET_KEY = 'torra.assistant.inset'
/** 再往右拖也要留够能用的助手宽度，否则确认卡片会挤成一列竖字 */
const MIN_FULL_W = 420
/** 夹到「[0, 视口宽 - 最小可用宽]」；窗口本身比最小宽还窄时贴 0 */
function clampInset(px: number, vw = window.innerWidth): number {
  const max = Math.max(0, vw - MIN_FULL_W)
  return Math.round(Math.min(Math.max(px, 0), max))
}
const readInsetPref = (): number => {
  try {
    return clampInset(Number(localStorage.getItem(INSET_KEY) ?? 0) || 0)
  } catch {
    return 0
  }
}
const writeInsetPref = (px: number): void => {
  try {
    localStorage.setItem(INSET_KEY, String(px))
  } catch {
    /* 同上 */
  }
}

/** 待发送附件：元数据 + 图片的即时预览 URL（object URL，仅在本次编辑期存在） */
interface Pending {
  att: ChatAttachmentMeta
  url?: string
}

/** 已发送图片附件：凭 id 走 attachmentRead 回捞预览（字节在主进程资源目录） */
function ImageAtt({ att }: { att: ChatAttachmentMeta }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.torra
      .attachmentRead(att.id)
      .then((r) => {
        if (alive && r.ok && r.base64) setUrl(`data:${r.mime};base64,${r.base64}`)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [att.id])
  if (url)
    return (
      <img
        className="a-att-img"
        src={url}
        alt={att.name}
        title={`${att.name}（点击放大）`}
        onClick={() => openImageZoom(url, att.name)}
      />
    )
  return (
    <span className="a-att-file" title={att.name}>
      <Paperclip size={11} /> {att.name}
    </span>
  )
}

function groupBlocks(lines: Line[]): Block[] {
  const out: Block[] = []
  for (const l of lines) {
    const tail = out[out.length - 1]
    if (l.kind === 'user') {
      out.push({ id: l.id, kind: 'user', text: l.text, attachments: l.attachments })
      continue
    }
    if (l.kind === 'status') {
      out.push({ id: l.id, kind: 'note', text: l.text })
      continue
    }
    if (l.kind === 'turn-stats') {
      out.push({ id: l.id, kind: 'tally', stats: l.stats })
      continue
    }
    if (l.kind === 'error') {
      out.push({ id: l.id, kind: 'alert', text: l.text, detail: l.detail })
      continue
    }
    if (l.kind === 'assistant') {
      if (tail && tail.kind === 'say') tail.lines.push({ id: l.id, text: l.text })
      else out.push({ id: l.id, kind: 'say', lines: [{ id: l.id, text: l.text }] })
      continue
    }
    if (l.kind === 'thinking' || l.kind === 'tool') {
      if (tail && tail.kind === 'steps') tail.lines.push(l)
      else out.push({ id: l.id, kind: 'steps', lines: [l] })
    }
  }
  return out
}

/**
 * 历史条目 → 渲染行。
 *
 * 主进程把每轮的统计挂在「该轮最后一条正文」上（磁盘上只有这一个稳定锚点），
 * 这里还原成独立的统计行，跟实时流出来的样子一致。
 */
function historyToLines(items: AssistantHistoryItem[], nid: () => number): Line[] {
  const out: Line[] = []
  for (const h of items) {
    const id = nid()
    if (h.role === 'user') out.push({ id, kind: 'user', text: h.text })
    else if (h.role === 'thinking') out.push({ id, kind: 'thinking', text: h.text })
    else if (h.role === 'tool') {
      out.push({
        id,
        kind: 'tool',
        text: h.toolName ?? '工具',
        toolId: `h${id}`,
        running: false,
        ok: h.ok,
        excerpt: h.excerpt,
        group: h.group ?? 'tool',
      })
    } else out.push({ id, kind: 'assistant', text: h.text })
    // 统计挂在每轮最后一条有内容的话上：一轮没说完就停在工具步时，锚点是那条工具
    if (h.stats) out.push({ id: nid(), kind: 'turn-stats', stats: h.stats })
  }
  return out
}

/** 确认卡片上的动作种类：让用户一眼看出这次要点的是什么 */
const ACTION_LABEL: Record<AssistantAction, string> = {
  save_adapter: '改配置',
  create_api_model: '新建模型',
  create_web_model: '新建网页模型',
  delete_model: '删除模型',
  open_login: '开登录窗口',
  drive_site: '代发消息',
  test_web_model: '真机试发言',
  run_plugin: '运行插件',
  author_tool: '新建插件工具',
  author_skill: '新建技能',
  remove_plugin: '移除插件',
  propose_extension: '提交待审扩展',
}
const ACTION_ICON: Record<AssistantAction, typeof Pencil> = {
  save_adapter: Pencil,
  create_api_model: Plus,
  create_web_model: Plus,
  delete_model: Trash2,
  open_login: LogIn,
  drive_site: Send,
  test_web_model: ShieldCheck,
  run_plugin: Puzzle,
  author_tool: Hammer,
  author_skill: Puzzle,
  remove_plugin: X,
  propose_extension: FileCode,
}

/** 空状态给的三个起点：助手最擅长回答的第一批问题 */
const QUICK_ASKS = ['先做一次链路体检', '最近哪场讨论有模型没发言，为什么', '帮我把一个新的 API 模型接进来']

function ModelPicker({
  models,
  modelId,
  disabled,
  onPick,
}: {
  models: AssistantModelView[]
  modelId: string
  disabled: boolean
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const selectable = models.filter((m) => m.transport === 'api' && m.enabled)
  const current = selectable.find((m) => m.id === modelId)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className={`a-picker${open ? ' open' : ''}`} ref={boxRef}>
      <button
        type="button"
        className="a-picker-btn"
        disabled={disabled || selectable.length === 0}
        onClick={() => setOpen((v) => !v)}
        title="助手自身用的推理模型（只能选已配置的 API 模型）"
      >
        <span className={`a-dot ${current ? (current.hasKey ? 'ok' : 'warn') : 'off'}`} />
        <span className="a-picker-name">{current ? current.displayName : '无可用 API 模型'}</span>
        {current && !current.hasKey && <span className="a-chip warn">缺 Key</span>}
        <ChevronDown size={12} className="a-picker-caret" />
      </button>
      {open && (
        <div className="a-picker-pop" role="listbox">
          <div className="a-pop-title">助手用哪个模型推理</div>
          {selectable.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === modelId}
              className={`a-pop-item${m.id === modelId ? ' active' : ''}`}
              onClick={() => {
                onPick(m.id)
                setOpen(false)
              }}
            >
              <span className={`a-dot ${m.hasKey ? 'ok' : 'warn'}`} />
              <span className="a-pop-main">
                <b>{m.displayName}</b>
                <i>{m.baseUrl ? `${m.protocol ?? 'openai'} · ${m.apiModel ?? m.baseUrl}` : '未配置端点'}</i>
              </span>
              {m.hasKey ? null : <span className="a-chip warn">缺 Key</span>}
              {m.id === modelId && <Check size={13} className="a-pop-check" />}
            </button>
          ))}
          {selectable.length === 0 && <div className="a-pop-empty">设置页里还没有可用的 API 模型</div>}
        </div>
      )}
    </div>
  )
}

/** 目录路径的最后一段：Windows 和 POSIX 的分隔符都要认，浮层里放不下整条路径 */
function dirLeaf(p: string): string {
  const parts = String(p ?? '').split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** 浮层左侧那一小格分类标签：扫一眼就知道这条是按下去会发消息、还是只改状态 */
const OVERLAY_KIND_LABEL: Record<OverlayItem['kind'], string> = {
  skill: '技能',
  mode: '模式',
  files: '附件',
  ref: '引用',
  workdir: '工作目录',
  revoke: '撤销',
  flag: '开关',
  settings: '设置',
}

/** @ 浮层的一行：盘上的一个候选，或者「先挑一个项目目录」那条可点的补救 */
/** @ 浮层的一行：文件或目录候选，末尾那两条是「继续用上次的」和「换一个工作目录」 */
type AtRow = { kind: 'entry'; entry: AtEntry } | { kind: 'workdir'; dir?: string }

/** 文件大小的一行短写法：0 字节也要说得出字，不能因为 falsy 就变成空 */
function sizeText(n: number | undefined): string {
  if (n === undefined) return '回车把内容贴进这条消息'
  if (n < 1024) return `${n} B · 回车贴进这条消息`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB · 回车贴进这条消息`
  return `${(n / 1024 / 1024).toFixed(1)} MB · 太大可能只贴得进前半段`
}

/**
 * / 浮层里的项：按「模式 → 往里加东西 → 能力（技能）→ 范围（@ / 工作目录 / 授权）」排，
 * 技能从盘上现读，读取授权跟着本场会话。
 *
 * hint 一律写「选了会发生什么」而不是再念一遍 label —— 目标模式会自己连续跑八轮，
 * 看不出来后果的那一下回车是最贵的。
 */
function buildOverlayItems(
  mode: AssistantModeState,
  skills: AssistantOverlayData['skills'],
  extensionsEnabled: boolean,
  query: string,
  workDir: string,
  defaultWorkDir: string,
  recentWorkDir?: string,
): OverlayItem[] {
  const items: OverlayItem[] = []
  // 三种模式都摆在浮层上（除了当前这一种）。只给一条「回到普通对话」的出路是不够的：
  // 目标模式跑到一半想改成只出计划，还得先退普通对话再进来了 —— 白按两次。
  if (mode.mode !== 'goal') {
    items.push({
      id: 'mode-goal',
      kind: 'mode',
      value: 'goal',
      label: '目标模式',
      hint:
        mode.mode === 'chat'
          ? `发出去后自己连续推进，最多 ${mode.maxRounds} 轮；每轮末尾要写完成标记才会提前停`
          : `现在是「${RUN_MODE_LABEL[mode.mode]}」，切过来会清掉上一档的目标和计划`,
    })
  }
  if (mode.mode !== 'plan') {
    items.push({
      id: 'mode-plan',
      kind: 'mode',
      value: 'plan',
      label: '计划模式',
      hint: '只读：可以看文件、出计划，写操作会被直接拒；计划成形后这里会出现「执行计划」',
    })
  }
  if (mode.mode !== 'chat') {
    items.push({
      id: 'mode-chat',
      kind: 'mode',
      value: 'chat',
      label: '回到普通对话',
      hint: `当前是「${RUN_MODE_LABEL[mode.mode]}」；切回来才会按审批设置放行写操作`,
    })
  }
  if (mode.running) {
    items.push({ id: 'mode-stop', kind: 'mode', value: 'stop', label: '停止自动推进', hint: '正在跑的这一轮会中止，循环不再续跑' })
  }
  if (mode.plan) {
    items.push({
      id: 'mode-exec',
      kind: 'mode',
      value: 'execute',
      label: '执行这份计划',
      hint: `按上一轮那份计划（${mode.plan.length} 字）发起执行，写操作闸门同时放开`,
    })
  }
  items.push({ id: 'files', kind: 'files', label: '添加文件或图片', hint: '图片走视觉输入，文字类并进这一问题里' })
  // 技能这一层有三种「没有」，界面上必须长得不一样，否则人只能猜是哪一种：
  // 盘上没东西 → 给一条去设置页的出路；有东西但开关关着 → 给一条就地打开的开关。
  // 摆在引用/工作目录那组之前：浮层一屏装不下全部项，能力类的不能被范围类的挤到看不见
  if (skills.length === 0) {
    items.push({
      id: 'skill-none',
      kind: 'settings',
      label: '技能 · 一条都还没有',
      hint: '设置页可以从本机其它 agent（Claude Code / Codex / Qoder…）的技能目录里挑着导入，也可以让助手自己写一条 · 点一下过去',
    })
  } else {
    if (!extensionsEnabled) {
      items.push({
        id: 'flag-extensions',
        kind: 'flag',
        value: 'extensions',
        label: '打开「加载技能 / 扩展」',
        hint: '下面这几条要装配进提示词得看这个开关；点一下就地打开，下一场对话起生效',
      })
    }
    for (const s of skills) {
      items.push({
        id: `skill-${s.name}`,
        kind: 'skill',
        value: s.name,
        label: `技能 · ${s.name}`,
        hint: s.description || s.path,
        // 开关关着时技能根本不会装配进提示词，选了也只是让模型对一个看不见的名字产生联想
        disabled: !extensionsEnabled,
        note: extensionsEnabled ? undefined : '「加载技能 / 扩展」还关着 —— 点上面那条开关',
      })
    }
  }
  // 兜底根是助手自己的目录：@ 开箱能用，但那一层里没有用户真正想引用的项目文件，
  // 所以话要说清楚「现在挑的是哪儿」，否则第一条 @ 出来的内容会让人以为选错了目录
  const rootIsDefault = workDir === defaultWorkDir
  items.push({
    id: 'at-ref',
    kind: 'ref',
    label: '引用文件或目录（@）',
    hint: rootIsDefault
      ? `在消息里打 @ 从「${dirLeaf(workDir)}」里挑 —— 这是助手的目录，要引用项目文件先把工作目录换过去`
      : `在消息里打 @ 从「${dirLeaf(workDir)}」里挑，选中后内容贴进这一条`,
  })
  if (recentWorkDir) {
    items.push({
      id: 'at-resume',
      kind: 'workdir',
      value: recentWorkDir,
      label: `继续用「${dirLeaf(recentWorkDir)}」`,
      hint: '上一场挑过的那个项目目录；点这一下才算这一场的授权，出了这场会话就收回',
    })
  }
  items.push({
    id: 'at-workdir',
    kind: 'workdir',
    label: '换一个工作目录',
    hint: `现在从「${workDir}」里挑；换了它，读取授权也跟着走`,
  })
  for (const d of mode.readDirs) {
    items.push({ id: `revoke-${d}`, kind: 'revoke', value: d, label: `撤销授权 · ${dirLeaf(d)}`, hint: d })
  }
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((it) => `${it.label} ${it.hint} ${it.value ?? ''}`.toLowerCase().includes(q))
}

export function AssistantDrawer({
  onClose,
  onOpenSettings,
}: {
  onClose: () => void
  onOpenSettings: () => void
}) {
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  /**
   * 运行模式快照（主进程是唯一权威，这里只是镜像）。
   *
   * 忙碌态必须参考它：目标模式在两轮之间也会各 settled 一次，
   * 只按「收到 settled 就不忙」会让界面在自动推进的过程中反复闪成待命。
   */
  const [mode, setMode] = useState<AssistantModeState>(defaultModeState)
  const modeRef = useRef<AssistantModeState>(mode)
  /** / 浮层：开着没有、过滤词、技能清单（打开那一次从主进程读） */
  const [slash, setSlash] = useState<{ open: boolean; query: string }>({ open: false, query: '' })
  const [overlaySkills, setOverlaySkills] = useState<AssistantOverlayData['skills']>([])
  const [overlayExtOn, setOverlayExtOn] = useState(true)
  const [slashIdx, setSlashIdx] = useState(0)
  /**
   * @ 引用浮层：光标前正在打的那半条路径（start 是 @ 的下标，替换时要用它定位）。
   *
   * 候选来自主进程读盘，不是界面自己攒的：渲染层没有枚举目录的能力，
   * 也不该有 —— 能挑到哪些路径，边界由主进程那个工作目录说了算。
   */
  const [at, setAt] = useState<{ open: boolean; query: string; start: number }>({ open: false, query: '', start: 0 })
  const [atEntries, setAtEntries] = useState<AtEntry[]>([])
  const [atIdx, setAtIdx] = useState(0)
  /** 列举失败/被截断时的那句话；挑不出东西时也走它，浮层要给出可点的那一条 */
  const [atNote, setAtNote] = useState<string | undefined>()
  /**
   * @ 当前的浏览根、它的兜底值、以及上一场记住的那个项目目录。
   *
   * 三个都读自 overlay() 快照：谁是默认根、该不该给「继续用」那一行，判定都在主进程，
   * 界面再算一遍就会和「发出去时展开用的是哪个根」分叉。
   */
  const [workDir, setWorkDir] = useState('')
  const [defaultWorkDir, setDefaultWorkDir] = useState('')
  const [recentWorkDir, setRecentWorkDir] = useState<string | undefined>()
  /** 逐字打 @path 会并发多次列举，只有最后一次的结果能落地 */
  const atSeq = useRef(0)
  /**
   * 有没有一条消息发出去但 invoke 还没回来。
   *
   * 忙碌态需要两个依据：主进程还在不在自动推进（mode.running），
   * 以及这一次发送落没落地。只看 settled 会在目标模式的轮次之间闪回收尾，
   * 只看 mode.running 又会在「切模式但正发着消息」时把忙碌态错误撤掉。
   */
  const turnInFlight = useRef(false)
  const [models, setModels] = useState<AssistantModelView[]>([])
  const [modelId, setModelId] = useState<string>('')
  const [note, setNote] = useState<string | null>(null)
  const [queue, setQueue] = useState<AssistantApprovalRequest[]>([])
  /** 审批偏好：决定卡片上有没有倒计时、头部徽标写什么（存盘在主进程） */
  const [prefs, setPrefs] = useState<AssistantApprovalPrefs | null>(null)
  /** 只在卡片带 autoApproveAt 时走秒，用来把「几秒后自动执行」数给人看 */
  const [now, setNow] = useState(() => Date.now())
  const [keyInput, setKeyInput] = useState('')
  const [keyHint, setKeyHint] = useState<string | null>(null)
  const [sessStats, setSessStats] = useState<AssistantSessionStats | null>(null)
  const [sessions, setSessions] = useState<AssistantSessionView[]>([])
  const [histOpen, setHistOpen] = useState(false)
  const [histQ, setHistQ] = useState('')
  const [histPage, setHistPage] = useState(1)
  /** 删除要二次确认：点一下只是把「确认删除」亮出来 */
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  /** 待发送附件（composer 里的 chip 条） */
  const [pending, setPending] = useState<Pending[]>([])
  /** 附件相关的即时提示：保存失败 / 模型不支持图片，3 秒后自动收 */
  const [composerNote, setComposerNote] = useState<string | null>(null)
  /** 刚复制过的那一行 id：按钮短暂显示对勾，给用户「复制到了」的反馈 */
  const [copiedId, setCopiedId] = useState<number | null>(null)
  /**
   * 放大到全屏：440px 装得下闲聊，装不下一条长链路的工具步骤和确认卡片里的源码 ——
   * 那些正是最需要看全的东西，看不全就只能靠猜，猜错了就是一张被误批的卡片。
   */
  const [full, setFull] = useState(readFullPref)
  const fullRef = useRef(full)
  fullRef.current = full
  const toggleFull = () => {
    const next = !fullRef.current
    fullRef.current = next
    writeFullPref(next)
    setFull(next)
  }
  /**
   * 把手拖动只写 CSS 变量，不走 setState：
   * 一次 mousemove 重排整棵消息树会掉帧，而变量改的是合成阶段。
   */
  const insetRef = useRef<number | null>(null)
  const onResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault()
    const move = (ev: MouseEvent) => {
      const px = clampInset(ev.clientX)
      insetRef.current = px
      document.documentElement.style.setProperty('--a-full-inset', `${px}px`)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (insetRef.current !== null) writeInsetPref(insetRef.current)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  // 把手位置要在重开抽屉 / 换窗口尺寸后仍然成立：变量写在根元素上，这里只负责补上初值与夹取
  useEffect(() => {
    const apply = () => {
      const px = insetRef.current ?? readInsetPref()
      insetRef.current = px
      document.documentElement.style.setProperty('--a-full-inset', `${clampInset(px)}px`)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  /**
   * 抽屉占掉多宽，网页视图就得让出多宽。
   *
   * WebContentsView 是原生视图，永远画在渲染层之上：不让位的话它会连抽屉一起压住，
   * 用户看到「助手突然不能点了」—— 而关闭按钮恰好在被压住的那块 DOM 上。
   * 宽度由这里实测出来（全屏档、拖过把手都自动跟上），CSS 只负责用。
   */
  useEffect(() => {
    document.body.classList.add('assistant-open')
    return () => document.body.classList.remove('assistant-open')
  }, [])

  /**
   * 让位宽度跟着「打开 / 全屏档 / 拖过把手 / 改窗口尺寸」四种变化走。
   *
   * 曾经只挂一次 ResizeObserver：全屏档翻上去之后变量还停在 452px，
   * 网页视图于是照旧压在抽屉身上 —— 测量这件事必须每次重新绑定，
   * 不能只在挂载时测一次。
   */
  useEffect(() => {
    const sync = () => {
      const el = rootRef.current
      const w = el ? Math.ceil(el.getBoundingClientRect().width) : 440
      document.documentElement.style.setProperty('--a-drawer-reserve', `${w + 12}px`)
    }
    sync()
    const ro = new ResizeObserver(sync)
    if (rootRef.current) ro.observe(rootRef.current)
    window.addEventListener('resize', sync)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [full])
  const fileRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  /** 正在流式累加的那一行；工具调用/新回合都会关掉它 */
  const openRef = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const queueRef = useRef<AssistantApprovalRequest[]>([])
  queueRef.current = queue

  const nid = () => {
    seq.current += 1
    return seq.current
  }

  const push = useCallback((line: DistributiveOmit<Line, 'id'>) => {
    setLines((l) => [...l, { ...line, id: nid() } as Line])
  }, [])

  const appendStream = useCallback((kind: 'assistant' | 'thinking', delta: string) => {
    setBusy(true)
    setLines((l) => {
      const cur = openRef.current === null ? undefined : l.find((x) => x.id === openRef.current)
      if (cur && cur.kind === kind) {
        return l.map((x) =>
          x.id === cur.id && (x.kind === 'assistant' || x.kind === 'thinking') ? { ...x, text: x.text + delta } : x,
        )
      }
      const id = ++seq.current
      openRef.current = id
      return [...l, { id, kind, text: delta } as Line]
    })
  }, [])

  const closeStream = () => {
    openRef.current = null
  }

  /** 累计账：每轮结束都要重新问一次，主进程那边才是权威值 */
  const refreshStats = useCallback(async () => {
    setSessStats(await window.torra.assistantStats())
  }, [])

  const refreshSessions = useCallback(async () => {
    setSessions(await window.torra.assistantSessions())
  }, [])

  // 流式事件 + 确认卡片订阅
  useEffect(() => {
    const offStream = window.torra.on('assistant:stream', (p) => {
      const e = p as AssistantStreamEvent
      // 助手真的开始干活了，「去设置页建模型」这类前置提示就该让位；
      // 反过来，发送失败时提示要留着 —— 那正是需要那个入口的时候。
      if (e.kind !== 'error') setNote(null)
      switch (e.kind) {
        case 'text':
          appendStream('assistant', e.delta)
          break
        case 'thinking':
          appendStream('thinking', e.delta)
          break
        case 'tool-start':
          closeStream()
          setLines((l) => [
            ...l,
            {
              id: ++seq.current,
              kind: 'tool',
              text: e.label,
              toolId: e.id,
              running: true,
              group: e.group,
              at: Date.now(),
              brief: argsBrief(e.args),
            },
          ])
          break
        case 'tool-end':
          setLines((l) =>
            l.map((x) =>
              x.kind === 'tool' && x.toolId === e.id
                ? { ...x, running: false, ok: e.ok, excerpt: e.excerpt, group: e.group, doneAt: Date.now() }
                : x,
            ),
          )
          break
        case 'turn-stats':
          setLines((l) => [...l, { id: ++seq.current, kind: 'turn-stats', stats: e.stats }])
          void refreshStats()
          break
        case 'status':
          setLines((l) => [...l, { id: ++seq.current, kind: 'status', text: e.text }])
          break
        case 'mode': {
          // 主进程那份状态是唯一权威：徽标、轮数、忙碌态都从它抄，界面不自己数
          modeRef.current = e.state
          setMode(e.state)
          if (e.state.running) setBusy(true)
          else if (!turnInFlight.current) setBusy(false)
          break
        }
        case 'error':
          closeStream()
          if (!modeRef.current.running) setBusy(false)
          setLines((l) => [...l, { id: ++seq.current, kind: 'error', text: e.text, detail: e.detail }])
          break
        case 'settled':
          closeStream()
          // 目标/计划模式每轮之间都会 settled 一次：那时候不撤忙碌态，
          // 撤了界面就会在自动推进的过程中闪回「待命」
          if (!modeRef.current.running) setBusy(false)
          break
        default:
          break
      }
    })
    const offApproval = window.torra.on('assistant:approval:request', (p) => {
      const card = p as AssistantApprovalRequest
      setQueue((q) => (q.some((x) => x.id === card.id) ? q : [...q, card]))
      setBusy(true)
      // 卡片什么时候出现，就顺手取一次偏好：徽标要说的是主进程刚刚用的那套规则
      void window.torra.assistantApprovalPrefs().then(setPrefs)
    })
    // 结算事件必须监听：超时/自动放行的卡片没有人点，靠这条把卡片从界面上收掉，
    // 否则用户回来看到的是一张还能点、但主进程早就不认的旧卡片
    const offResolved = window.torra.on('assistant:approval:resolved', (p) => {
      const r = p as AssistantApprovalResolved
      setQueue((q) => q.filter((x) => x.id !== r.id))
    })
    return () => {
      offStream()
      offApproval()
      offResolved()
    }
  }, [appendStream, refreshStats])

  // 打开时读取状态、模型与历史
  useEffect(() => {
    let alive = true
    void (async () => {
      const [ms, st]: [AssistantModelView[], AssistantStatus] = await Promise.all([
        window.torra.assistantModels(),
        window.torra.assistantStatus(),
      ])
      if (!alive) return
      setModels(ms)
      const usable = ms.filter((m) => m.transport === 'api' && m.enabled)
      setModelId(st.modelId ?? usable.find((m) => m.hasKey)?.id ?? usable[0]?.id ?? '')
      if (!st.ready && usable.length > 0) setNote(null)
      if (usable.length === 0) {
        setNote('助手需要一个已填 API Key 的 API 模型才能工作。在设置页建好后回来即可。')
      }
      const ap = await window.torra.assistantApprovalPrefs()
      if (alive) setPrefs(ap)
      // 模式与技能清单也在这一次读回来：面板关掉再打开，主进程那侧的目标模式还在跑着
      const ov = await window.torra.assistantOverlay()
      if (alive) {
        modeRef.current = ov.mode
        setMode(ov.mode)
        setOverlaySkills(ov.skills)
        setOverlayExtOn(ov.extensionsEnabled)
      }
      // 忙碌态同样要从主进程抄回来：重新挂载时 'mode' 流事件不会重发，
      // 只补 mode 不补 busy，正在跑的回合就会显示成「待命」—— 用户照着待命
      // 重发消息，反被主进程按「上一句还在处理」拒掉，看起来像卡死。
      if (alive && (st.streaming || modeRef.current.running)) setBusy(true)
      const h = await window.torra.assistantHistory()
      if (!alive || h.length === 0) return
      setLines((prev) => (prev.length ? prev : historyToLines(h, nid)))
    })()
    void refreshStats()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 新内容自动滚到底
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, queue])

  const card = queue[0]

  // 卡片换人时把焦点交给卡片：键盘用户不必再猜焦点在哪
  useEffect(() => {
    if (card) cardRef.current?.focus()
  }, [card?.id])

  /**
   * 「超时自动批准」的倒计时显示。
   *
   * 秒数由卡片自带的 autoApproveAt 决定，而不是渲染层自己再算一遍时长 ——
   * 卡片在队列里排队时，主进程的定时器早就开始走了，两边各算各的会出现
   * 「界面还在数 8 秒，那边已经放行」。到点也是主进程结算，这里只负责数。
   */
  const autoAt = card?.autoApproveAt
  useEffect(() => {
    if (autoAt === undefined) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(t)
  }, [autoAt])
  const autoLeftMs = autoAt === undefined ? 0 : Math.max(0, autoAt - now)
  const autoTotalMs = Math.max(1, prefs?.timeoutMs ?? autoLeftMs)
  const autoPct = autoAt === undefined ? 0 : Math.min(100, Math.round((autoLeftMs / autoTotalMs) * 100))
  const autoSecs = Math.ceil(autoLeftMs / 1000)

  /**
   * 活动组的秒表读数。
   *
   * 只在「正在执行」时走，一秒一次：正在跑的那一组要让用户看到已经花了多久，
   * 但每秒重排整棵消息树是有代价的，所以一轮结束后立刻停表 —— 停表后显示的是
   * 每一步自己记下的起止时间，不再依赖这个读数。
   */
  const [tickBase, setTickBase] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return
    setTickBase(Date.now())
    const t = window.setInterval(() => setTickBase(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [busy])

  const dismissCard = useCallback((id: string, approved: boolean, reason?: string) => {
    setQueue((q) => q.filter((x) => x.id !== id))
    void window.torra.assistantApprove(id, { approved, reason })
  }, [])

  // 关抽屉时不能把确认卡片丢在主进程里干等超时
  const handleClose = () => {
    for (const c of queueRef.current) {
      void window.torra.assistantApprove(c.id, { approved: false, reason: '用户关闭了助手面板' })
    }
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Esc 逐层退：先退卡片，再退全屏，最后退抽屉，不越级
      const head = queueRef.current[0]
      if (head) {
        e.stopPropagation()
        dismissCard(head.id, false, '用户按 Esc 取消了这次操作')
        return
      }
      if (fullRef.current) {
        e.stopPropagation()
        toggleFull()
        return
      }
      handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const approveCard = () => {
    if (!card) return
    if (card.needsKey && !keyInput.trim()) {
      setKeyHint('新建 API 模型必须填入 Key')
      return
    }
    const apiKey = card.needsKey ? keyInput.trim() : undefined
    setKeyInput('')
    setKeyHint(null)
    setLines((l) => [...l, { id: ++seq.current, kind: 'status', text: `已允许：${card.title}` }])
    setQueue((q) => q.filter((x) => x.id !== card.id))
    void window.torra.assistantApprove(card.id, { approved: true, apiKey })
  }

  const sendText = async (raw: string, attachments?: ChatAttachmentMeta[]) => {
    const text = raw.trim()
    const atts = attachments ?? []
    if (!text && atts.length === 0) return
    if (busy) {
      // 回合进行中：这条是插话，不是新提问。插话只递文字，附件留给下一轮
      if (atts.length) push({ kind: 'status', text: '助手正忙，附件留到下一轮再发' })
      if (!text) return
      setLines((l) => [...l, { id: ++seq.current, kind: 'user', text: `插话：${text}` }])
      const r = await window.torra.assistantSteer(text)
      if (!r.ok) push({ kind: 'error', text: r.reason ?? '插话未被接受', detail: r.detail })
      return
    }
    closeStream()
    setBusy(true)
    turnInFlight.current = true
    setLines((l) => [...l, { id: ++seq.current, kind: 'user', text, attachments: atts.length ? atts : undefined }])
    const r = await window.torra.assistantSend(text, atts.length ? atts : undefined)
    turnInFlight.current = false
    if (!r.ok) {
      setBusy(false)
      push({ kind: 'error', text: r.reason ?? '发送失败', detail: r.detail })
      return
    }
    // 目标/计划模式跑完整个循环才会返回，中间每一轮的 settled 都不能撤忙碌态；
    // 所以收尾的另一半在这里：invoke 回来了、且主进程不再推进，才真的算闲下来
    if (!modeRef.current.running) setBusy(false)
  }

  const submit = async () => {
    const text = draft.trim()
    if (!text && pending.length === 0) return
    const atts = pending.map((p) => p.att)
    setDraft('')
    // 清空后必须把内联高度一起撤掉，否则输入框停在撑开的那一档
    if (taRef.current) taRef.current.style.height = ''
    setPending([])
    for (const p of pending) if (p.url) URL.revokeObjectURL(p.url)
    await sendText(text, atts)
  }

  const flash = (msg: string) => {
    setComposerNote(msg)
    window.setTimeout(() => setComposerNote((cur) => (cur === msg ? null : cur)), 3200)
  }

  // ---------------------------------------------------------------------------
  // / 功能浮层
  // ---------------------------------------------------------------------------

  /** 从主进程取回模式快照与技能清单（打开浮层那一次、以及授权变化之后） */
  const refreshOverlay = useCallback(async () => {
    try {
      const d = await window.torra.assistantOverlay()
      modeRef.current = d.mode
      setMode(d.mode)
      setOverlaySkills(d.skills)
      setOverlayExtOn(d.extensionsEnabled)
      setWorkDir(d.workDir)
      setDefaultWorkDir(d.defaultWorkDir)
      setRecentWorkDir(d.recentWorkDir)
    } catch {
      // 读不到就留着上一次的内容：浮层宁可用旧清单，也不要整块空白看起来像应用坏了
    }
  }, [])

  // 浏览根一开场就要能显示（卡片下面那行写的是「@ 在哪儿挑」），不能等第一次打开浮层
  useEffect(() => {
    void refreshOverlay()
  }, [refreshOverlay])

  /**
   * 输入框里的 / 怎么才算「要唤醒浮层」。
   *
   * 收紧成「整条草稿就是一个斜杠加过滤词」：写 Windows 路径 C:/、或者正文里提到
   * /help 的时候把输入框挡住，用户只会以为打字丢了。
   */
  const syncSlash = (v: string): void => {
    const want = /^\/\S*$/.test(v)
    // 关着→开着的那一次要重新取快照：人在设置页刚开完技能开关，
    // 回到抽屉打 / 不该看见上一份清单（按钮那条路本来就带 refreshOverlay）
    if (want && !slash.open) {
      setSlashIdx(0)
      void refreshOverlay()
    }
    if (want) setSlash({ open: true, query: v.slice(1) })
    else setSlash({ open: false, query: '' })
  }

  const overlayItems = useMemo(
    () => (slash.open ? buildOverlayItems(mode, overlaySkills, overlayExtOn, slash.query, workDir, defaultWorkDir, recentWorkDir) : []),
    [slash, mode, overlaySkills, overlayExtOn, workDir, defaultWorkDir, recentWorkDir],
  )

  // -------------------------------------------------------------------------
  // @ 引用：光标前那条正在打的路径
  // -------------------------------------------------------------------------

  /**
   * 问主进程要候选，并且只认最后一次请求的结果。
   *
   * 逐字打 src/ma → src/main 会并发两次列举；先发出的那次后回来会把新结果盖掉，
   * 表现就是「候选列表慢半拍，按回车插进去一个我没挑的路径」。
   */
  const askAtList = async (query: string): Promise<void> => {
    const seq = ++atSeq.current
    let r: Awaited<ReturnType<typeof window.torra.assistantAtList>>
    try {
      r = await window.torra.assistantAtList(query)
    } catch {
      if (seq !== atSeq.current) return
      setAtEntries([])
      setAtNote('列不出候选：主进程没答上这句')
      return
    }
    if (seq !== atSeq.current) return
    setAtEntries(r.entries)
    // 主进程报回来的是它这次真正列举过的根：换了目录后这一行先新鲜起来，卡片下面那行才跟着改
    if (r.workDir) setWorkDir(r.workDir)
    setAtNote(r.ok ? (r.truncated ? `命中太多，只列前 ${r.entries.length} 条：再打几个字缩小范围` : undefined) : r.reason)
    if (!r.ok) setAtIdx(0)
  }

  const closeAt = (): void => {
    atSeq.current++
    setAt({ open: false, query: '', start: 0 })
    setAtEntries([])
    setAtNote(undefined)
  }

  /**
   * 「这个 @ 算不算正在引用一个路径」的判定在共享层（atTokenAt）。
   *
   * 必须共享：发送时主进程要用同一套规则把 @路径 找出来展开，两边各写一份正则，
   * 迟早会出现「界面挑得好好的，发出去说不认识这个路径」。
   */
  const syncAt = (v: string, caret: number): void => {
    const tok = atTokenAt(v, caret)
    if (!tok) {
      if (at.open) closeAt()
      return
    }
    const moved = !at.open || tok.start !== at.start
    if (moved) setAtIdx(0)
    setAt({ open: true, query: tok.query, start: tok.start })
    if (moved || tok.query !== at.query) void askAtList(tok.query)
  }

  const atRows = useMemo<AtRow[]>(
    () => [
      ...atEntries.map((entry) => ({ kind: 'entry', entry } as AtRow)),
      // 挑不出东西时给出路，而且把「继续用上次那个」摆在选择器前面：
      // 多数时候人就是回到了同一个项目，让他点两下不如点一下
      ...(atEntries.length === 0 && recentWorkDir ? [{ kind: 'workdir', dir: recentWorkDir } as AtRow] : []),
      ...(atEntries.length === 0 ? [{ kind: 'workdir' } as AtRow] : []),
    ],
    [atEntries, recentWorkDir],
  )

  /** 把光标前那条 @token 换成选中的路径：目录留着斜杠继续往里钻，文件补一个空格收尾 */
  const applyAt = (p: string, keepOpen: boolean): void => {
    const head = draft.slice(0, at.start)
    const tail = draft.slice(at.start + 1 + at.query.length)
    // 文件后面不补一个空格，接着打的下一个词会长在路径里（发送时按空白切 token）
    const gap = keepOpen || /^\s/.test(tail) ? '' : ' '
    const caret = head.length + 1 + p.length + gap.length
    setDraft(`${head}@${p}${gap}${tail}`)
    setAtIdx(0)
    if (keepOpen) {
      setAt({ open: true, query: p, start: at.start })
      void askAtList(p)
    } else {
      closeAt()
    }
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(caret, caret)
      grow()
    })
  }

  /**
   * 换 @ 的浏览根：不传 dir 走原生选择器，传了就是浮层里那行「继续用「X」」。
   *
   * 两条路都要人点一下：记住的目录只是记性，授权必须留在这一场里重新给。
   */
  const switchWorkDir = async (dir?: string): Promise<boolean> => {
    const r = await window.torra.assistantSetWorkDir(dir ? { dir } : undefined)
    if (!r.ok) {
      push({ kind: 'error', text: r.reason ?? '工作目录没变', detail: r.detail })
      return false
    }
    flash(r.reason ?? '工作目录已切换')
    void refreshOverlay()
    return true
  }

  const pickAt = async (row: AtRow): Promise<void> => {
    if (row.kind === 'workdir') {
      if (await switchWorkDir(row.dir)) void askAtList(at.query)
      return
    }
    applyAt(row.entry.path, row.entry.dir)
  }

  const pickOverlay = async (item: OverlayItem): Promise<void> => {
    setSlash({ open: false, query: '' })
    if (item.disabled) {
      // 灰掉不是没有原因，原因要说出来，否则用户只会反复点同一条
      flash(item.note ?? '这一项现在不可用')
      setDraft('')
      return
    }
    if (item.kind === 'files') {
      fileRef.current?.click()
      return
    }
    if (item.kind === 'skill') {
      setDraft(`/技能 ${item.value ?? ''} `)
      taRef.current?.focus()
      return
    }
    if (item.kind === 'flag') {
      // 浮层里点一下就把开关打开：为了一个开关把人甩回设置页，等于让他重新找一遍自己在干什么
      const r = await window.torra.assistantSetExtensions(true)
      if (!r.ok) push({ kind: 'error', text: r.reason ?? '开关没打开', detail: r.detail })
      else flash('已打开「加载技能 / 扩展」，下一场对话起装配')
      void refreshOverlay()
      return
    }
    if (item.kind === 'settings') {
      onOpenSettings()
      return
    }
    if (item.kind === 'ref') {
      // 只把 @ 写进草稿，真正的挑选由 @ 浮层接手：那条路要逐字问主进程列候选，
      // 在这里替人挑完等于把「打两个字再回车」变成翻一个列表。
      const base = draft.startsWith('/') ? '' : draft
      setDraft(`${base}${base && !/\s$/.test(base) ? ' ' : ''}@`)
      taRef.current?.focus()
      const ta = taRef.current
      if (ta) {
        const c = ta.value.length
        ta.setSelectionRange(c, c)
        syncAt(ta.value, c)
      }
      return
    }
    if (item.kind === 'workdir') {
      void switchWorkDir(item.value)
      return
    }
    if (item.kind === 'revoke') {
      const r = await window.torra.assistantRevokeDir(item.value ?? '')
      if (!r.ok) push({ kind: 'error', text: r.reason ?? '读取授权没变', detail: r.detail })
      else flash(r.reason ?? '读取授权已更新')
      void refreshOverlay()
      return
    }
    const v = item.value ?? ''
    if (v === 'execute') {
      // 这一条是唯一「选中即发出」的：计划已经摆在对话里给人看过，执行才是它的下一步
      setBusy(true)
      const r = await window.torra.assistantExecutePlan()
      if (!r.ok) {
        setBusy(false)
        push({ kind: 'error', text: r.reason ?? '计划没能开始执行', detail: r.detail })
      } else if (r.reason) flash(r.reason)
      return
    }
    if (v === 'stop') {
      const r = await window.torra.assistantStopMode()
      flash(r.reason ?? '已停止自动推进')
      void refreshOverlay()
      return
    }
    // 换模式不替人发消息：会自己连跑若干轮的动作，至少要留一下这次回车
    const carry = draft.startsWith('/') ? '' : draft.trim()
    const r = await window.torra.assistantSetMode({ mode: v, ...(carry ? { goal: carry } : {}) })
    if (!r.ok) {
      push({ kind: 'error', text: r.reason ?? '模式切换失败', detail: r.detail })
      return
    }
    flash(r.reason ?? '模式已切换')
    if (draft.startsWith('/')) setDraft('')
    void refreshOverlay()
  }

  /** 浮层开着时接管按键：上下选、Enter 用、Esc 收 —— 这时候 Enter 不是发送 */
  const onComposerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (at.open) {
      // @ 浮层排在 / 浮层之前：两者不会同开（/ 要求整条草稿就是一个斜杠，@ 要求前面是空白），
      // 但顺序写反会让「打 @ 挑文件」时按回车变成发送半条路径
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeAt()
        return
      }
      const n = atRows.length
      if (n > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        setAtIdx((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n))
        return
      }
      // Tab 是路径补全的惯例键，Enter 在这里也是选中而不是发送
      if (n > 0 && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) {
        e.preventDefault()
        void pickAt(atRows[Math.min(atIdx, n - 1)] as AtRow)
        return
      }
    }
    if (slash.open) {
      // Esc 收浮层这一条不看清单：过滤到 0 项时面板还开着，这时候按 Esc 应该是关面板，
      // 而不是让抽屉那层的 window 监听把整个助手关掉
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setSlash({ open: false, query: '' })
        return
      }
      const n = overlayItems.length
      if (n > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          setSlashIdx((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n))
          return
        }
        if (e.key === 'Enter' && !e.altKey) {
          e.preventDefault()
          void pickOverlay(overlayItems[Math.min(slashIdx, n - 1)] as OverlayItem)
          return
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const toggleSlash = (): void => {
    if (slash.open) {
      setSlash({ open: false, query: '' })
      return
    }
    // 按钮唤起的浮层过滤词是空的（草稿里那句正常文字不该被当成筛选）
    setSlash({ open: true, query: draft.startsWith('/') ? draft.slice(1) : '' })
    setSlashIdx(0)
    void refreshOverlay()
    taRef.current?.focus()
  }

  /** 一行「现在是什么模式」，浮层顶部和徽标的 title 都用它 */
  const modeLine = (m: AssistantModeState): string => {
    const dirs = m.readDirs.length ? ` · 已授权 ${m.readDirs.length} 个读取目录` : ''
    if (m.mode === 'goal') return `目标模式 · 第 ${m.round}/${m.maxRounds} 轮${m.running ? ' · 自动推进中' : ''}`
    if (m.mode === 'plan') return `计划模式 · ${m.planLocked ? '写操作锁定' : '可执行'}${m.plan ? ' · 计划已成形' : ''}${dirs}`
    return `普通对话${dirs}`
  }

  /** 读入选/粘贴的文件：图片先过视觉闸门，字节交给主进程存，渲染层只留元数据 + 预览 */
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return
    for (const f of files) {
      const kind = classifyKind(f.type || '')
      if (kind === 'image' && !models.find((m) => m.id === modelId)?.vision) {
        flash('当前助手模型不支持图片，请在设置里勾选「支持图片输入」或换一个视觉模型')
        continue
      }
      const att: ChatAttachmentMeta = {
        id: uid('att'),
        kind,
        name: f.name || (kind === 'image' ? '图片' : '文件'),
        mime: f.type || (kind === 'image' ? 'image/png' : 'text/plain'),
        size: f.size,
      }
      try {
        const buf = new Uint8Array(await f.arrayBuffer())
        const r = await window.torra.attachmentSave({ id: att.id, kind, name: att.name, mime: att.mime, data: buf })
        if (!r.ok) {
          flash(`附件「${att.name}」保存失败：${r.reason ?? '未知错误'}`)
          continue
        }
      } catch {
        flash(`附件「${att.name}」保存失败`)
        continue
      }
      const url = kind === 'image' ? URL.createObjectURL(f) : undefined
      setPending((p) => [...p, { att, url }])
    }
  }

  const removePending = (id: string) => {
    setPending((p) => {
      const hit = p.find((x) => x.att.id === id)
      if (hit?.url) URL.revokeObjectURL(hit.url)
      return p.filter((x) => x.att.id !== id)
    })
  }

  const copyText = async (id: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1600)
    } catch {
      setCopiedId(null)
    }
  }

  /** 重发一条历史用户消息（编辑后重发 / 重新生成共用）：作为新一轮发出，不截断既有会话 */
  const resend = (text: string, attachments?: ChatAttachmentMeta[]) => {
    if (busy) {
      flash('助手正在工作，等这一轮结束再重发')
      return
    }
    void sendText(text, attachments)
  }

  const pickModel = async (next: string) => {
    setModelId(next)
    const r = await window.torra.assistantSetModel(next)
    if (!r.ok) {
      // 切失败要退回原来那个，并把原因写进对话：
      // 藏进已经收起的下拉里，等于没说
      setModelId(modelId)
      push({ kind: 'error', text: r.reason ?? '切换模型失败', detail: r.detail })
      return
    }
    push({ kind: 'status', text: `助手模型已切换为「${models.find((m) => m.id === next)?.displayName ?? next}」` })
  }

  const resetSession = async () => {
    const r = await window.torra.assistantReset()
    setLines([])
    closeStream()
    setBusy(false)
    void refreshStats()
    void refreshSessions()
    if (!r.ok) push({ kind: 'error', text: r.reason ?? '新会话未能开始', detail: r.detail })
    else push({ kind: 'status', text: '已开始新会话，旧的还在历史列表里' })
  }

  /** 历史列表是按需读的：每次展开都重新拉，刚聊完的那场才会立刻出现在最上面 */
  const toggleHistory = () => {
    setConfirmDel(null)
    setHistQ('')
    setHistPage(1)
    setHistOpen((v) => {
      const next = !v
      if (next) void refreshSessions()
      return next
    })
  }

  const switchSession = async (s: AssistantSessionView) => {
    setHistOpen(false)
    const r = await window.torra.assistantOpenSession(s.path)
    closeStream()
    setBusy(false)
    if (!r.ok) {
      push({ kind: 'error', text: r.reason ?? '切换会话失败', detail: r.detail })
      return
    }
    const h = await window.torra.assistantHistory()
    setLines(historyToLines(h, nid))
    void refreshStats()
    void refreshSessions()
  }

  const removeSession = async (s: AssistantSessionView) => {
    setConfirmDel(null)
    const r = await window.torra.assistantDeleteSession(s.path)
    if (!r.ok) push({ kind: 'error', text: r.reason ?? '删除会话失败', detail: r.detail })
    await refreshSessions()
  }

  const abort = async () => {
    await window.torra.assistantAbort()
    closeStream()
    setBusy(false)
    void refreshStats()
  }

  /** 输入框跟着内容长高，最多 5 行 —— 长问题不该被 44px 的口挤成马赛克 */
  const grow = () => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }

  const blocks = useMemo(() => groupBlocks(lines), [lines])
  const lastBlock = blocks[blocks.length - 1]
  const stateLabel = card ? '等你确认' : busy ? '正在工作' : note ? '未配置' : '待命'
  const stateTone = card ? 'warn' : busy ? 'run' : note ? 'off' : 'ok'

  const HIST_SIZE = 8
  const histKw = histQ.trim().toLowerCase()
  const histFiltered = histKw
    ? sessions.filter((s) => `${s.name ?? ''} ${s.firstMessage ?? ''}`.toLowerCase().includes(histKw))
    : sessions
  const { rows: histRows, safePage: histSafePage } = pageSlice(histFiltered, histPage, HIST_SIZE)
  useEffect(() => setHistPage(1), [histQ])

  return (
    <aside ref={rootRef} className={`assistant-drawer${full ? ' full' : ''}`} role="dialog" aria-label="助手">
      <header className="assistant-head">
        <span className="assistant-id">
          <span className={`assistant-id-mark${busy ? ' live' : ''}`}>
            <BrandMark size={20} mono />
          </span>
          <span className="assistant-id-text">
            <b>助手</b>
            <i className={`assistant-state ${stateTone}`}>{stateLabel}</i>
          </span>
        </span>
        {/* 模型与审批模式收进输入卡片的工具栏：头部只留「谁在干活 / 干什么」 */}
        <span className="assistant-head-actions">
          <button
            className="btn icon sm"
            onClick={toggleFull}
            title={full ? '退出全屏' : '全屏显示（长链路和确认卡片看得更全）'}
            aria-label={full ? '退出全屏' : '全屏显示'}
            aria-pressed={full}
          >
            {full ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            className={`btn icon sm${histOpen ? ' active' : ''}`}
            onClick={toggleHistory}
            title="历史会话"
            aria-label="历史会话"
          >
            <History size={12} />
          </button>
          <button className="btn icon sm" onClick={() => void resetSession()} title="开始新会话">
            <RotateCcw size={12} />
          </button>
          <button className="btn icon sm" onClick={handleClose} title="关闭（Esc）">
            <X size={12} />
          </button>
        </span>
      </header>

      {/* 全屏时给一条可拖的左把手：放大是为了看全，不该变成回不去的牢 */}
      {full && <span className="assistant-resize-handle" onMouseDown={onResizeStart} title="拖动调整宽度" />}

      {histOpen && (
        <div className="a-hist" role="dialog" aria-label="历史会话">
          <div className="a-hist-head">
            <b>历史会话</b>
            <button className="btn icon sm" onClick={() => setHistOpen(false)} title="关闭" aria-label="关闭历史列表">
              <X size={11} />
            </button>
          </div>
          {sessions.length > 0 && (
            <div className="search-box">
              <Search size={12} />
              <input
                placeholder="搜索会话…"
                value={histQ}
                onChange={(e) => setHistQ(e.target.value)}
              />
            </div>
          )}
          <div className="a-hist-list">
            {sessions.length === 0 && <div className="a-hist-empty">还没有存档的会话</div>}
            {sessions.length > 0 && histFiltered.length === 0 && (
              <div className="a-hist-empty">没有匹配的会话</div>
            )}
            {histRows.map((s) => (
              <div key={s.path} className={`a-hist-item${s.current ? ' current' : ''}`}>
                <button type="button" className="a-hist-main" onClick={() => void switchSession(s)}>
                  <b>{s.name || s.firstMessage || '未命名会话'}</b>
                  <i>
                    {fmtTime(s.modified)} · {s.messageCount} 条{s.current ? ' · 当前' : ''}
                  </i>
                </button>
                {confirmDel === s.path ? (
                  <span className="a-hist-confirm">
                    <button className="btn sm danger" onClick={() => void removeSession(s)}>
                      确认删除
                    </button>
                    <button className="btn sm" onClick={() => setConfirmDel(null)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn icon sm"
                    disabled={s.current}
                    onClick={() => setConfirmDel(s.path)}
                    title={s.current ? '当前会话不能删，先开一场新的' : '删除这场会话'}
                    aria-label="删除会话"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <Pager page={histSafePage} pageSize={HIST_SIZE} total={histFiltered.length} onPage={setHistPage} />
          <div className="a-hist-foot">点开任意一场即可接着聊；「开始新会话」不会删掉旧的。</div>
        </div>
      )}

      <div className="assistant-body" ref={bodyRef}>
        {lines.length === 0 && (
          <div className="assistant-empty">
            <span className="assistant-empty-mark">
              <BrandMark size={40} />
            </span>
            <p className="assistant-empty-title">有什么要查的，直接说</p>
            <div className="assistant-chips">
              {QUICK_ASKS.map((q) => (
                <button key={q} type="button" className="assistant-chip" onClick={() => void sendText(q)}>
                  {q}
                </button>
              ))}
            </div>
            <p className="assistant-empty-hint">
              助手只调用列出的工具，任何改配置、删模型、开登录的动作都会先弹卡片问你。
            </p>
          </div>
        )}
        {note && (
          <div className="assistant-note">
            <AlertTriangle size={12} />
            <span>{note}</span>
            <button className="btn sm" onClick={onOpenSettings}>
              去设置页
            </button>
          </div>
        )}
        {blocks.map((b, i) => {
          const live = busy && i === blocks.length - 1
          if (b.kind === 'user') {
            return (
              <UserBlock
                key={b.id}
                line={b}
                copied={copiedId === b.id}
                busy={busy}
                onCopy={copyText}
                onResend={resend}
              />
            )
          }
          if (b.kind === 'alert') {
            return (
              <div key={b.id} className="a-block a-alert">
                <AlertTriangle size={12} />
                <span>{b.text}</span>
                {/* 原文默认收起：它只对开发者有用，但用户真要去查日志时得拿得到 */}
                {b.detail && b.detail !== b.text ? (
                  <details className="a-alert-raw">
                    <summary>查看原始信息</summary>
                    <code>{b.detail}</code>
                  </details>
                ) : null}
              </div>
            )
          }
          if (b.kind === 'note') {
            return (
              <div key={b.id} className="a-block a-note">
                {b.text}
              </div>
            )
          }
          if (b.kind === 'tally') {
            const s = b.stats
            return (
              <div key={b.id} className="a-block a-turn-stats" title="本轮统计：耗时 / 首字延迟 / token / 花费 / 步数">
                <span>耗时 {fmtMs(s.ms)}</span>
                <span>首字 {s.ttftMs == null ? '—' : fmtMs(s.ttftMs)}</span>
                <span>
                  ↑{fmtTok(s.input)} ↓{fmtTok(s.output)}
                </span>
                {s.cacheRead + s.cacheWrite > 0 && <span>缓存 {fmtTok(s.cacheRead + s.cacheWrite)}</span>}
                <span>{fmtCost(s.cost)}</span>
                {s.steps > 0 && (
                  <span>
                    {s.steps} 步
                    {s.byGroup?.skill ? ` · 技能 ${s.byGroup.skill}` : ''}
                    {s.byGroup?.mcp ? ` · MCP ${s.byGroup.mcp}` : ''}
                  </span>
                )}
                {s.model && <span className="a-stats-model">{s.model}</span>}
              </div>
            )
          }
          if (b.kind === 'steps') {
            const tools = b.lines.filter((x) => x.kind === 'tool')
            const running = tools.some((x) => x.running)
            const bad = tools.filter((x) => x.ok === false).length
            const skills = tools.filter((x) => x.group === 'skill').length
            const mcps = tools.filter((x) => x.group === 'mcp').length
            const thinks = b.lines.filter((x) => x.kind === 'thinking').length
            // 耗时从「最早那一步开始」算到「最晚那一步结束」；还在跑就按当前秒表读数
            const starts = tools.map((x) => x.at).filter((v): v is number => v != null)
            const ends = tools.map((x) => x.doneAt).filter((v): v is number => v != null)
            const beganAt = starts.length ? Math.min(...starts) : null
            const ranMs = beganAt == null ? null : running ? tickBase - beganAt : ends.length ? Math.max(...ends) - beganAt : null
            return (
              <details
                key={b.id}
                className={`a-block a-steps${running ? ' running' : ''}${bad ? ' bad' : ''}`}
                // 只有「正在跑」时强制展开；一旦交给用户手动折叠，后续重渲染不能再抢回去
                open={running ? true : undefined}
              >
                <summary>
                  <ChevronDown size={12} className="a-steps-chev" />
                  <span className="a-steps-icon">
                    {running ? <Loader2 size={11} className="spin" /> : bad ? <AlertTriangle size={11} /> : <Check size={11} />}
                  </span>
                  <span className="a-steps-title">
                    {running ? '正在执行中' : bad ? `${bad} 步没通过` : '执行完成'}
                    {ranMs != null && <em className="a-steps-clock">{fmtMs(ranMs)}</em>}
                  </span>
                  <span className="a-steps-meta">
                    <span className="a-steps-count">{tools.length} 步</span>
                    {skills > 0 && <span className="a-steps-kind">技能 {skills}</span>}
                    {mcps > 0 && <span className="a-steps-kind">MCP {mcps}</span>}
                    {thinks > 0 && <span className="a-steps-kind">思考 {thinks}</span>}
                  </span>
                </summary>
                <div className="a-steps-list">
                  {b.lines.map((s) =>
                    s.kind === 'tool' ? (
                      <div key={s.id} className={`a-step${s.running ? ' running' : ''}${s.ok === false ? ' bad' : ''}`}>
                        <span className="a-step-ic">
                          {s.running ? <Loader2 size={11} className="spin" /> : s.ok === false ? <X size={11} /> : <Check size={11} />}
                        </span>
                        <span className="a-step-name">{s.text}</span>
                        {s.brief && (
                          <code className="a-step-brief" title={s.brief}>
                            {s.brief}
                          </code>
                        )}
                        {/* 内置工具是默认来源，不占一列；技能/MCP 的副作用范围不同，必须标出来 */}
                        {s.group !== 'tool' && (
                          <span className={`a-step-tag ${GROUP_CLASS[s.group]}`}>{GROUP_LABEL[s.group]}</span>
                        )}
                        {s.excerpt && <span className="a-step-out">{s.excerpt}</span>}
                      </div>
                    ) : (
                      <div key={s.id} className="a-step a-think">
                        <span className="a-step-ic">
                          <Lightbulb size={11} />
                        </span>
                        <span className="a-step-name">已思考</span>
                        <span className="a-step-out">{s.text}</span>
                      </div>
                    ),
                  )}
                </div>
              </details>
            )
          }
          return (
            <div key={b.id} className={`a-block a-say${live ? ' live' : ''}`}>
              <span className="a-say-mark">
                <BrandMark size={13} />
              </span>
              <div className="a-say-body">
                {b.lines.map((l) => (
                  <Markdown key={l.id} text={l.text} />
                ))}
              </div>
              {!live && (
                <button
                  className="a-say-copy"
                  title="复制回答"
                  onClick={() => copyText(b.id, b.lines.map((l) => l.text).join('\n\n'))}
                >
                  {copiedId === b.id ? <Check size={11} /> : <Copy size={11} />}
                </button>
              )}
            </div>
          )
        })}
        {busy && !card && !lastBlockIsWorking(blocks) && (
          <div className="a-block a-busy">
            <span className="a-dots"><i /><i /><i /></span>
            助手正在思考…
          </div>
        )}
      </div>

      {card && (
        <div
          className={`assistant-approve${autoAt !== undefined ? ' auto' : ''}`}
          ref={cardRef}
          tabIndex={-1}
          role="alertdialog"
          aria-label={card.title}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              approveCard()
            }
          }}
        >
          <div className="a-ap-head">
            {(() => {
              const Icon = ACTION_ICON[card.action] ?? AlertTriangle
              return (
                <span className="a-ap-kind">
                  <Icon size={11} />
                  {ACTION_LABEL[card.action] ?? '写操作'}
                </span>
              )
            })()}
            <b>{card.title}</b>
          </div>
          <div className="a-ap-detail">{card.detail}</div>
          {autoAt !== undefined && (
            <div className="a-ap-auto" role="timer" aria-label={`${autoSecs} 秒后自动执行`}>
              <div className="a-ap-auto-bar">
                <i style={{ width: `${autoPct}%` }} />
              </div>
              <span>
                <b>{autoSecs}</b> 秒后自动执行 · 点「拒绝」或按 Esc 都能立刻拦下
              </span>
            </div>
          )}
          {card.needsKey && prefs && prefs.mode !== 'always_ask' && autoAt === undefined && (
            <div className="a-ap-auto is-note">
              <ShieldCheck size={12} />
              <span>这张要人工填 API Key：Key 只能由人给，自动模式也不会替你放行。</span>
            </div>
          )}
          {card.risk && (
            <div className="a-ap-risk">
              <AlertTriangle size={12} />
              <span>{card.risk}</span>
            </div>
          )}
          {card.needsKey && (
            <label className="a-ap-key">
              <span>API Key</span>
              <input
                type="password"
                autoComplete="off"
                placeholder="只交给主进程加密保存，不进对话"
                value={keyInput}
                onChange={(e) => {
                  setKeyInput(e.target.value)
                  setKeyHint(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    approveCard()
                  }
                }}
              />
            </label>
          )}
          {keyHint && <div className="a-ap-hint">{keyHint}</div>}
          <div className="a-ap-actions">
            <button
              className="btn sm"
              onClick={() => dismissCard(card.id, false, '用户在确认卡片里拒绝了')}
            >
              拒绝
              <kbd>Esc</kbd>
            </button>
            <button className="btn sm primary" onClick={approveCard}>
              <Check size={12} />
              允许执行
              <kbd>Ctrl+Enter</kbd>
            </button>
          </div>
          <div className="a-ap-foot">
            {autoAt !== undefined
              ? '倒计时结束就自动执行；这期间你点什么都优先于它。'
              : card.needsKey
                ? '这张需要你填 Key 并点「允许执行」，超时未处理则本轮自动取消。'
                : '未处理前这一轮不会继续；超时会自动取消，不会改动任何东西。'}
          </div>
        </div>
      )}

      <footer className="assistant-foot">
        {/* 输入区是一张卡片：附件条 → 无边框输入 → 工具栏，模型与审批模式都在工具栏上 */}
        <div className="ac">
          {pending.length > 0 && (
            <div className="ac-atts">
              {pending.map((p) => (
                <span key={p.att.id} className="ac-att" title={p.att.name}>
                  {p.att.kind === 'image' && p.url ? (
                    <img
                      className="ac-att-thumb"
                      src={p.url}
                      alt=""
                      title={`${p.att.name}（点击放大）`}
                      onClick={() => openImageZoom(p.url!, p.att.name)}
                    />
                  ) : (
                    <Paperclip size={11} className="ac-att-icon" />
                  )}
                  <span className="ac-att-name">{p.att.name}</span>
                  <button className="ac-att-x" onClick={() => removePending(p.att.id)} title="移除" aria-label="移除附件">
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {composerNote && <div className="ac-note">{composerNote}</div>}
          {slash.open && (
            <div className="a-slash-pop" role="listbox" aria-label="助手功能">
              <div className="a-slash-title">
                <span className="a-slash-cmd">/{slash.query}</span>
                <span className="a-slash-state" title={mode.note ?? ''}>
                  {modeLine(mode)}
                </span>
              </div>
              {overlayItems.map((it, i) => (
                <button
                  key={it.id}
                  type="button"
                  role="option"
                  aria-selected={i === Math.min(slashIdx, overlayItems.length - 1)}
                  className={`a-pop-item a-slash-item${i === Math.min(slashIdx, overlayItems.length - 1) ? ' active' : ''}${it.disabled ? ' off' : ''}`}
                  onMouseEnter={() => setSlashIdx(i)}
                  onClick={() => void pickOverlay(it)}
                >
                  <span className={`a-slash-kind ${it.kind}`}>{OVERLAY_KIND_LABEL[it.kind]}</span>
                  <span className="a-pop-main">
                    <b>{it.label}</b>
                    <i>{it.disabled && it.note ? it.note : it.hint}</i>
                  </span>
                </button>
              ))}
              {overlayItems.length === 0 && <div className="a-pop-empty">没有匹配「{slash.query}」的功能</div>}
              <div className="a-slash-foot">↑↓ 选择 · Enter 使用 · Esc 收起</div>
            </div>
          )}
          {at.open && (
            <div className="a-slash-pop a-at-pop" role="listbox" aria-label="@ 引用候选">
              <div className="a-slash-title">
                <span className="a-slash-cmd">@{at.query}</span>
                {workDir && (
                  <span className="a-slash-state" title={workDir}>
                    {workDir === defaultWorkDir ? `助手目录 · ${dirLeaf(workDir)}` : dirLeaf(workDir)}
                  </span>
                )}
              </div>
              {(atNote || atEntries.length === 0) && (
                <div className="a-pop-empty">{atNote ?? `「${at.query}」里没有对得上的文件或目录`}</div>
              )}
              {atRows.map((row, i) =>
                row.kind === 'entry' ? (
                  <button
                    key={row.entry.path}
                    type="button"
                    role="option"
                    aria-selected={i === Math.min(atIdx, atRows.length - 1)}
                    className={`a-pop-item a-slash-item${i === Math.min(atIdx, atRows.length - 1) ? ' active' : ''}`}
                    onMouseEnter={() => setAtIdx(i)}
                    onClick={() => void pickAt(row)}
                  >
                    <span className={`a-slash-kind ${row.entry.dir ? 'workdir' : 'ref'}`}>{row.entry.dir ? '目录' : '文件'}</span>
                    <span className="a-pop-main">
                      <b>{row.entry.path}</b>
                      <i>{row.entry.dir ? '回车继续往里挑' : sizeText(row.entry.size)}</i>
                    </span>
                  </button>
                ) : (
                  <button
                    key={row.dir ? '__workdir-recent' : '__workdir-pick'}
                    type="button"
                    role="option"
                    aria-selected={i === Math.min(atIdx, atRows.length - 1)}
                    className={`a-pop-item a-slash-item${i === Math.min(atIdx, atRows.length - 1) ? ' active' : ''}`}
                    onMouseEnter={() => setAtIdx(i)}
                    onClick={() => void pickAt(row)}
                  >
                    <span className="a-slash-kind workdir">{row.dir ? '上次' : '选目录'}</span>
                    <span className="a-pop-main">
                      <b>{row.dir ? `继续用「${dirLeaf(row.dir)}」` : '挑一个项目目录'}</b>
                      <i>{row.dir ? '上一场挑过的那个目录；点这一下才给它这一场的读取授权' : '原生选择器换一个，@ 引用只在新范围里找文件'}</i>
                    </span>
                  </button>
                ),
              )}
              <div className="a-slash-foot">↑↓ 选择 · Enter/Tab 选中 · Esc 收起</div>
            </div>
          )}
          <textarea
            ref={taRef}
            className="ac-input"
            rows={1}
            placeholder={busy ? '插话：把新信息递给正在工作的助手' : '描述现象或目标 · 打 / 用功能，打 @ 引用文件'}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              grow()
              syncSlash(e.target.value)
              syncAt(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onClick={(e) => syncAt(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? [])
              if (files.length > 0) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
            onKeyDown={onComposerKey}
          />
          <div className="ac-bar">
            <div className="ac-tools">
              {/* + 是「往里加东西」的总入口：文件、@ 引用、两种运行模式、技能都在那一层里 */}
              <button
                type="button"
                className={`ac-btn ac-add${slash.open ? ' open' : ''}`}
                onClick={toggleSlash}
                title="添加：文件或图片、@ 引用、目标 / 计划模式、技能（也可以在输入框开头打 /）"
                aria-label="添加"
                aria-expanded={slash.open}
              >
                <Plus size={15} />
              </button>
              <button
                type="button"
                className="ac-btn"
                onClick={() => fileRef.current?.click()}
                title={models.find((m) => m.id === modelId)?.vision ? '添加文件或图片（也可以直接 Ctrl+V 粘贴）' : '添加文件（当前模型不支持图片）'}
                aria-label="添加附件"
              >
                <Paperclip size={13} />
              </button>
              {prefs && (
                <button
                  type="button"
                  className="ac-chip"
                  data-mode={prefs.mode}
                  onClick={onOpenSettings}
                  title={`审批模式：${APPROVAL_MODE_LABEL[prefs.mode]}${
                    prefs.mode === 'auto_after_timeout' ? ` · 倒计时 ${Math.round(prefs.timeoutMs / 1000)} 秒` : ''
                  } · 点击到设置页更改`}
                >
                  <ShieldCheck size={12} />
                  {APPROVAL_MODE_LABEL[prefs.mode]}
                  <ChevronDown size={11} className="ac-chip-caret" />
                </button>
              )}
              {mode.mode !== 'chat' && (
                <button
                  type="button"
                  className="ac-chip ac-run"
                  data-run={mode.mode}
                  onClick={toggleSlash}
                  title={`${modeLine(mode)}${mode.note ? ` · ${mode.note}` : ''} · 点击打开 / 浮层`}
                >
                  {mode.mode === 'goal' ? <Target size={12} /> : <ClipboardList size={12} />}
                  {RUN_MODE_LABEL[mode.mode]}
                  {mode.mode === 'goal' && <i>{`${mode.round}/${mode.maxRounds}`}</i>}
                  {mode.mode === 'plan' && mode.planLocked && <i>只读</i>}
                  <ChevronDown size={11} className="ac-chip-caret" />
                </button>
              )}
            </div>
            <div className="ac-go">
              <ModelPicker
                models={models}
                modelId={modelId}
                disabled={busy}
                onPick={(id) => void pickModel(id)}
              />
              {/* 忙碌时发送键变成停止键（主流一致）；插话另给一枚小键，鼠标用户也还能递进去 */}
              {busy && (
                <button
                  type="button"
                  className="ac-chip ac-queue"
                  onClick={() => void submit()}
                  disabled={!draft.trim()}
                  title="把这一句递进正在跑的这一轮（Enter）"
                >
                  插话
                  <ArrowUp size={11} />
                </button>
              )}
              <button
                type="button"
                className={`ac-send${busy ? ' stop' : ''}`}
                disabled={busy ? false : !draft.trim() && pending.length === 0}
                onClick={() => (busy ? void abort() : void submit())}
                title={busy ? '中止本轮' : '送出（Enter）'}
                aria-label={busy ? '中止本轮' : '送出'}
              >
                {busy ? <Square size={12} /> : <ArrowUp size={16} />}
              </button>
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={
              models.find((m) => m.id === modelId)?.vision
                ? 'image/*,.txt,.md,.markdown,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.java,.go,.rs,.c,.cpp,.h,.yaml,.yml,.toml,.sql,.sh,.html,.css'
                : '.txt,.md,.markdown,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.java,.go,.rs,.c,.cpp,.h,.yaml,.yml,.toml,.sql,.sh,.html,.css'
            }
            style={{ display: 'none' }}
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
        </div>
        <div className="assistant-foot-row">
          {/* 本场的账贴在输入卡片下方：它属于「现在的状态」，不该浮在对话顶上 */}
          {sessStats && (sessStats.totalMessages > 0 || sessStats.cost > 0) ? (
            <div className="a-tally" title="本场会话累计（含技能/扩展调用）">
              <span className="a-tally-mark">本场</span>
              <span className="a-tally-k">{sessStats.userMessages} 问</span>
              <span className="a-tally-k">{sessStats.toolCalls} 步</span>
              {/* 缓存 token 收进 title：这一条要占满一行，多一项就把进度条挤下去了 */}
              <span
                className="a-tally-k"
                title={`输入 ${fmtTok(sessStats.tokens.input)} / 输出 ${fmtTok(sessStats.tokens.output)} / 缓存 ${fmtTok(sessStats.tokens.cacheRead + sessStats.tokens.cacheWrite)}`}
              >
                ↑{fmtTok(sessStats.tokens.input)} ↓{fmtTok(sessStats.tokens.output)}
              </span>
              <span className="a-tally-k" title="累计花费">
                {fmtCost(sessStats.cost)}
              </span>
              {sessStats.contextPercent != null && (
                <span
                  className="a-tally-ctx"
                  title={`上下文占用 ${fmtTok(sessStats.contextTokens ?? 0)} / ${fmtTok(sessStats.contextWindow)}`}
                >
                  <b className="a-tally-track">
                    <i style={{ width: `${Math.max(2, Math.min(100, sessStats.contextPercent))}%` }} />
                  </b>
                  <em>{Math.round(sessStats.contextPercent)}%</em>
                </span>
              )}
            </div>
          ) : null}
          {/* @ 的浏览根常驻在这一行：第一次打 @ 之前就该看得见「现在从哪儿挑」，点一下进 / 浮层换 */}
          {workDir && (
            <button
              type="button"
              className="a-root"
              onClick={toggleSlash}
              title={`@ 引用现在从「${workDir}」里挑 · 点一下换目录${
                workDir === defaultWorkDir ? '（这是助手自己的目录，项目文件不在这里）' : ''
              }`}
            >
              <Folder size={11} />
              <b>{dirLeaf(workDir)}</b>
              {workDir === defaultWorkDir && <em>助手目录</em>}
            </button>
          )}
          <span className="assistant-hint a-hint-key">
            {busy ? 'Enter 递插话' : 'Enter 送出 · Shift+Enter 换行 · 开头打 / 唤醒功能 · 打 @ 引用文件'}
          </span>
        </div>
      </footer>
    </aside>
  )
}

/** 最后一个块已经是「正在做的事」时，就不再叠一条「正在思考」，否则两条转圈同屏 */
function lastBlockIsWorking(blocks: Block[]): boolean {
  const last = blocks[blocks.length - 1]
  if (!last) return false
  if (last.kind === 'steps') return last.lines.some((x) => x.kind === 'tool' && x.running)
  if (last.kind === 'say') return true
  return false
}

/**
 * 用户消息块：复制 / 编辑后重发 / 重发这一条。
 *
 * 编辑和重发都是「作为新一轮发出」，不截断既有会话 —— 助手是带工具副作用的有状态会话，
 * 没有可回退的锚点，重发只能往后追加。
 */
function UserBlock({
  line,
  copied,
  busy,
  onCopy,
  onResend,
}: {
  line: { id: number; text: string; attachments?: ChatAttachmentMeta[] }
  copied: boolean
  busy: boolean
  onCopy: (id: number, text: string) => void
  onResend: (text: string, attachments?: ChatAttachmentMeta[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(line.text)
  const atts = line.attachments ?? []
  const hasAtt = atts.length > 0
  const save = () => {
    const t = draft.trim()
    if (!t && !hasAtt) return
    onResend(t, atts.length ? atts : undefined)
    setEditing(false)
  }
  if (editing) {
    return (
      <div className="a-block a-user editing">
        <textarea
          className="a-edit-area"
          rows={2}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              save()
            } else if (e.key === 'Escape') {
              setEditing(false)
            }
          }}
        />
        <div className="a-edit-actions">
          <button className="btn sm" onClick={() => setEditing(false)}>
            取消
          </button>
          <button className="btn sm primary" onClick={save} disabled={!draft.trim() && !hasAtt}>
            保存并重新发送
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="a-block a-user">
      {line.text && <div className="a-user-text">{line.text}</div>}
      {hasAtt && (
        <div className="a-att-row">
          {atts.map((a) =>
            a.kind === 'image' ? (
              <ImageAtt key={a.id} att={a} />
            ) : (
              <span key={a.id} className="a-att-file" title={a.name}>
                <Paperclip size={11} /> {a.name}
              </span>
            ),
          )}
        </div>
      )}
      <div className="a-user-actions">
        <button className="a-act" title="复制" onClick={() => onCopy(line.id, line.text)}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
        <button
          className="a-act"
          title="编辑后重发"
          onClick={() => {
            setDraft(line.text)
            setEditing(true)
          }}
        >
          <Pencil size={11} />
        </button>
        <button className="a-act" title="重发这一条" onClick={() => onResend(line.text, atts.length ? atts : undefined)} disabled={busy}>
          <RefreshCw size={11} />
        </button>
      </div>
    </div>
  )
}
