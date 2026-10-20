import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore, type ModelSummary } from '../store'
import { getFaviconUrls } from './ModelRail'
import { WebviewDock } from './WebviewDock'
import { WallSeam, type SeamAxis } from './WallSeam'
import { COMFY_PANE, FLOOR_PANE, planPanes, swapAt, trackIndex, trackPx, wallTracks, type Weights } from '../chatWall'
import { Splitter } from './Splitter'
import { useElementBox, useStoredOrder, useStoredWeights, useStoredWidth, widthVar } from '../layout'
import { pushNotice } from '../notice'
import { createChatsSaver } from '../chatPersistence'
import { openImageZoom } from './ImageZoom'
import { Markdown } from './Markdown'
import type { ChatAttachmentMeta } from '@shared/types'
import {
  Send, Loader2, AlertCircle, ChevronDown, Plus, Minus, Trash2, MessageSquare, Copy,
  Sparkles, Check, Brain, Wrench, ExternalLink, Maximize2, X, Paperclip, RefreshCw, Pencil,
  PanelLeftClose, PanelLeftOpen, LayoutGrid, Rows3, Monitor, ScrollText, Minimize2, Grid2x2,
  MessageSquarePlus,
} from 'lucide-react'

type Role = 'user' | 'assistant'

/** 单个模型在某一轮的回答状态 */
interface AnswerCell {
  content: string
  thinking?: string
  /** agent 型网页站的执行过程（检索/跑代码/写文件等步骤） */
  steps?: string
  streaming: boolean
  error?: string
  /** 本轮的非致命异常（如「附件未送达」）：照常给了答案，但必须让用户看见 */
  note?: string
  /**
   * 本轮网页模型生成的图片（AI 生图）。字节已在主进程落库，这里只存元数据。
   *
   * 为什么不走 Markdown 的 `![]()`：图床域名不可枚举，渲染层 CSP 不放行任意 https 图，
   * 而且这类 URL 多带时效签名，几小时后就是碎图。
   */
  images?: ChatAttachmentMeta[]
  /**
   * 这一轮走的是网页通道的「原生」那半条：只把话送进站点，不读回复容器。
   *
   * 记在单元格上而不是当场读顶栏开关 —— 用户事后切回提取模式再重生成，
   * 这一轮的展示口径仍该按它投递时的那条链路来，否则卡片会对着空正文等增量。
   */
  native?: boolean
  /** 站点接走了这一轮（原生模式唯一的产出：一张收据，不是正文） */
  delivered?: boolean
  /**
   * 这一轮落在站点里的会话地址（原生模式，随收据一起记下）。
   *
   * 「点左侧第 N 问 → 那一格滚到这一问」靠它兜底：ChatGPT / DeepSeek 的消息列表是
   * 虚拟化的，DOM 只挂最近一两个回合，更早那轮根本不在页面上 —— 按文本找必然找不到。
   * 但那场会话 URL 里，这一轮正是它当前的最新一轮，一定挂着，所以先跳回去再找。
   * 旧存档没这个字段，缺省即「只能就地找」，找不到就照实说。
   */
  siteUrl?: string
}

/** 一轮 = 一个用户问题 + 各模型的并行回答 */
interface Turn {
  id: string
  question: string
  cells: Record<string, AnswerCell>
  /** 本轮问题携带的附件元数据（字节存主进程，这里只留引用） */
  attachments?: ChatAttachmentMeta[]
  /** 发问时刻（旧数据可能没有，渲染时按缺省处理） */
  at?: number
}

/** 一个聊天会话（侧边栏一项） */
interface Chat {
  id: string
  title: string
  createdAt: number
  turns: Turn[]
}

const STORE_KEY = 'torra.chat.v1'
const DENSITY_KEY = 'torra.chat.density'
const SESS_OPEN_KEY = 'torra.chat.sessionsOpen'
const VIEW_MODE_KEY = 'torra.chat.viewMode'
/** 窗格头部拖出多少像素才算「要交换位置」：不到这个数就还是一次点击 */
const SWAP_SLOP_PX = 6

/**
 * 输入坞下方那句提示的分量。
 * 原先只有一种颜色，于是「这一场已经是空的了」这种说明和「网页那几格没开回来」这种故障
 * 长得一模一样 —— 读者只能靠读完整个句子才知道要不要担心。
 */
type NoteTone = 'warn' | 'info'

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function newChat(): Chat {
  return { id: uid('chat'), title: '新对话', createdAt: Date.now(), turns: [] }
}

function loadChats(): Chat[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Chat[]
    if (!Array.isArray(parsed)) return []
    // 重启后不存在进行中的流式：把残留的 streaming 标记复位，避免卡住发送锁
    return parsed.map((c) => ({
      ...c,
      turns: (c.turns ?? []).map((t) => ({
        ...t,
        cells: Object.fromEntries(
          Object.entries(t.cells ?? {}).map(([k, v]) => [k, { ...v, streaming: false }]),
        ),
      })),
    }))
  } catch {
    return []
  }
}

function fmtClock(ts?: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/**
 * 把一格的定位结论说成一句人话 —— 重点不是「成功/失败」，而是下一步该谁动手。
 *
 * `hasPointer` 为假时那句必须跟「当时没记下会话地址」绑在一起：同样的「没找到」，
 * 有指针的还能跳回会话再找一次，没指针的（旧存档、或站点发送后压根不换路由）
 * 就真没辙了，混成一句会让人以为功能坏了。
 */
function locateVerdict(
  r: { ok: boolean; found?: number; index?: number; mode?: string; navigated?: boolean; reason?: string },
  hasPointer: boolean,
): string {
  if (r.ok) {
    const via = r.navigated ? '跳回那一问所在的会话，' : ''
    const where = r.mode === 'user_turn' ? '用户气泡' : '排除助手正文后的文本匹配'
    const nth = (r.found ?? 1) > 1 ? `（同句在页面上有 ${r.found} 处，取第 ${r.index ?? 1} 处）` : ''
    return `${via}已滚到那一问 · ${where}${nth}`
  }
  if (r.navigated) return '已跳回那一问所在的会话，页面上仍没找到这句话'
  if (!hasPointer) return '这一问没留在页面上：站点只挂最近几轮，这一轮当时也没记下会话地址'
  return `没定位到（${r.reason || 'unknown'}）`
}

/** 导出给外部（此处仅组件内部使用） */
function modelHistory(chat: Chat, modelId: string): Array<{ role: Role; content: string }> {
  const h: Array<{ role: Role; content: string }> = []
  for (const t of chat.turns) {
    const c = t.cells[modelId]
    h.push({ role: 'user', content: t.question })
    if (c && !c.error && c.content) h.push({ role: 'assistant', content: c.content })
  }
  return h
}

/**
 * 重生成用的历史：只取第 idx 轮之前（不含 idx）的各轮问答。
 *
 * 重发第 idx 轮的问题时，那条问题本身作为本轮 message 传下去，
 * 历史里不能再有它，否则模型会看到重复提问。
 */
function historyBefore(chat: Chat, modelId: string, idx: number): Array<{ role: Role; content: string }> {
  const h: Array<{ role: Role; content: string }> = []
  for (let i = 0; i < idx; i++) {
    const t = chat.turns[i]!
    const c = t.cells[modelId]
    h.push({ role: 'user', content: t.question })
    if (c && !c.error && c.content) h.push({ role: 'assistant', content: c.content })
  }
  return h
}

/** 待发送附件：元数据 + 图片的即时预览 URL（object URL，仅在本次编辑期存在） */
interface Pending {
  att: ChatAttachmentMeta
  url?: string
}

/** 归类附件：图片走多模态，其余按文本处理 */
function classifyKind(mime: string): 'image' | 'text' {
  return mime.startsWith('image/') ? 'image' : 'text'
}

/**
 * 聊天模式（沉浸对比流）：把同一个问题并行发给多个模型，逐轮并排对比各自回答。
 *
 * 支持多个会话（左侧栏，可折叠/双击重命名），会话持久化到本机 localStorage。
 * 回答卡支持并排网格 / 单列细读两种密度；网页模型可点开右侧网页视图。
 * 与研讨模式的区别：没有主持、轮次收敛或共识核算 —— 每个模型只是各自作答。
 */
export function ChatPage({ models }: { models: ModelSummary[] }) {
  // 逐字增量只落在 `utterances` 上：整份订阅会让聊天页在研讨流式期跟着一起重渲染
  const s = useStore(
    useShallow((st) => ({
      chatWebviewTarget: st.chatWebviewTarget,
      participantIds: st.participantIds,
      setChatWebview: st.setChatWebview,
      setModels: st.setModels,
      toggleChatWebview: st.toggleChatWebview,
    })),
  )
  const [chats, setChats] = useState<Chat[]>(() => {
    const loaded = loadChats()
    return loaded.length > 0 ? loaded : [newChat()]
  })
  const [activeId, setActiveId] = useState<string>(() => '')
  const [input, setInput] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  // 待发送附件 + 文件选择器 + 一次性提示
  const [pending, setPending] = useState<Pending[]>([])
  const [composerNote, setComposerNote] = useState<{ msg: string; tone: NoteTone } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 视图形态：并排网格 / 单列细读；会话栏折叠；拖拽悬停
  const [density, setDensity] = useState<'grid' | 'stack'>(() =>
    localStorage.getItem(DENSITY_KEY) === 'stack' ? 'stack' : 'grid',
  )
  /**
   * 网页模型的两种看法。默认原生（'native'），这是聊天模式的立场：
   * 对比「谁答得好」不需要我们先把答案搬回来，站点自己的页面就是答案，
   * 而且它不依赖任何回复容器选择器 —— 站点改版打断不了这一轮。
   * 'extract' 保留旧行为：投递 + 读回正文进卡片，能复制、能进历史、能被导出，
   * 代价是跟着站点结构走。研讨模式不受这里影响（那边必须要正文）。
   */
  const [viewMode, setViewMode] = useState<'native' | 'extract'>(() =>
    localStorage.getItem(VIEW_MODE_KEY) === 'extract' ? 'extract' : 'native',
  )
  /** 原生墙里被单独放大的那一格；null = 按网格并排 */
  const [expandedPane, setExpandedPane] = useState<string | null>(null)
  /**
   * 左栏要不要收成窄轨（只留 Q1..Qn 编号）。null = 跟随默认，true/false = 用户手动选过。
   * 默认口径见下面 lean 的注释：手动选择一旦做出就不再被参与者构成改回去，
   * 但切回提取模式时它整个失效 —— 那边左栏是正文唯一的容身之处。
   */
  const [leanPinned, setLeanPinned] = useState<boolean | null>(null)
  /**
   * 原生底部输入条此刻是「一行」还是「展开面板」。焦点记在坞上而不是输入框上：
   * 点附件那颗按钮会让 textarea 先失焦，只盯 textarea 的话条会在用户眼皮底下缩回去一次。
   * 失焦时问一句「新焦点还在不在坞里」，在就不收 —— 附件、发送、参与者徽章都在坞里。
   */
  const [barFocus, setBarFocus] = useState(false)
  /*
   * 墙上这几枚的顺序（id 数组，落盘）。它同时承担两件事：
   * 从标签换进来 = 把它提到最前，拖动交换 = 两格对调。
   * 存在盘上而不是 useState：位置是用户一格一格拖出来的布局，刷新一下就没等于没做。
   * 不在场的 id 会被 planPanes 忽略、新加入的按侧栏顺序补到末尾，所以这份名单不需要清理逻辑。
   */
  const [paneOrder, setPaneOrder] = useStoredOrder('wall.order')
  const [sessionsOpen, setSessionsOpen] = useState<boolean>(() =>
    localStorage.getItem(SESS_OPEN_KEY) !== '0',
  )
  const [dragOver, setDragOver] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // 可拖动列宽：null 表示用户没拖过，交给 CSS 的默认宽度（会话栏 208px、网页视图列 44%）
  const rootRef = useRef<HTMLDivElement>(null)
  const sessionsRef = useRef<HTMLElement>(null)
  const webviewRef = useRef<HTMLElement>(null)
  /** 从窄轨点进来时想去看的那一轮：展开之后由 effect 补一次滚动 */
  const pendingScrollRef = useRef<string | null>(null)
  const [sessW, setSessW] = useStoredWidth('chat.sessions')
  const [webW, setWebW] = useStoredWidth('chat.webview')

  useEffect(() => {
    localStorage.setItem(DENSITY_KEY, density)
  }, [density])
  useEffect(() => {
    localStorage.setItem(VIEW_MODE_KEY, viewMode)
  }, [viewMode])
  useEffect(() => {
    localStorage.setItem(SESS_OPEN_KEY, sessionsOpen ? '1' : '0')
  }, [sessionsOpen])

  /*
   * 原生模式的输入条：没聚焦、也还没打字时收成一行细条，其余时间是跟着内容长高的输入框。
   * 高度只能在这儿定 —— 下面那两行 inline 赋值会盖过样式表里的任何高度声明，
   * 想让 CSS 单独收起它，就得连这条自动长高一起废掉，不值。
   */
  const barOpen = viewMode !== 'native' || barFocus || input.trim().length > 0 || pending.length > 0
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (!barOpen) {
      el.style.height = '22px'
      return
    }
    // 输入框跟着内容长高，最多 6 行：长问题被挤在一行里左右滚动，比正文还难读
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [input, barOpen])

  /*
   * 点墙上的站点页面时，焦点交给的是那一格原生视图，不是本页面的某个元素 ——
   * DOM 里不会有 blur 落到 dock 上，输入条会一直摊开着挡在网页前面。
   * 这条路只能由 window 失焦来收尾（原生视图抢焦点时本渲染进程会失去焦点）。
   */
  useEffect(() => {
    if (viewMode !== 'native') return
    const drop = () => setBarFocus(false)
    window.addEventListener('blur', drop)
    return () => window.removeEventListener('blur', drop)
  }, [viewMode])

  // 每个模型当前正在接收增量的轮次（in-flight 唯一），用于把事件归位到正确卡片
  const activeTurnRef = useRef<Record<string, string>>({})
  // ChatGPT 有时会在完成事件中回传空内容；保留增量快照，避免空 done 覆盖已收到的文本。
  const streamedContentRef = useRef<Record<string, string>>({})
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  // 网页视图目标收口到全局 store：左栏模型卡片（由 App 渲染）与底部参与者 chip
  // 要指向同一个「当前打开的网页模型」，本地 state 会让两处各说各话。
  const webviewTarget = s.chatWebviewTarget
  const setWebviewTarget = s.setChatWebview
  // 放大查看：记录当前展开的轮次 + 模型，正文与思考随流式更新实时放大呈现
  const [focus, setFocus] = useState<{ turnId: string; modelId: string } | null>(null)

  // 右侧问题锚点导航：滚动容器 + 当前定位轮 + 钉住展开态
  // 默认收起（只留短横），鼠标移到浮层上临时展开；点选某个问题后钉住展开，便于连续跳转。
  const turnsRef = useRef<HTMLDivElement>(null)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  const [navPinned, setNavPinned] = useState(false)

  /**
   * 上一次「点某一问 → 各格定位」的结论，按模型记，只在窗格头部亮 8 秒。
   *
   * 为什么不是一条全局 toast：一格一个原因（这家滚到了、那家只挂最近两轮、
   * 还有一家压根没记下会话地址），合成一句必然把其中两条说丢。
   */
  const [locateNote, setLocateNote] = useState<Record<string, string>>({})
  const locateNoteAt = useRef<Record<string, number>>({})

  /** 网页视图内登录完成后复核：复检结果交给统一提示层（自己浮在页面上会被原生视图盖住） */
  const recheckChatModel = async (id: string) => {
    const r = await window.torra.refreshLogin(id)
    void window.torra.listModels().then((m) => s.setModels(m))
    pushNotice(r.ok ? '登录态已确认' : (r.reason ?? '仍未就绪'), {
      tone: r.ok ? 'success' : 'warn',
      ttl: r.ok ? 3200 : 8000,
    })
  }

  const targets = useMemo(
    () => models.filter((m) => s.participantIds.includes(m.id)),
    [models, s.participantIds],
  )

  const webviewTargetModel = useMemo(
    () => (webviewTarget ? models.find((m) => m.id === webviewTarget) : undefined),
    [models, webviewTarget],
  )

  /** 所有走网页通道的模型：标签条与 Alt+←/→ 循环都用这一份口径 */
  const webModels = useMemo(() => models.filter((m) => m.transport === 'webview'), [models])

  /** 参与本轮比较的网页模型 —— 原生墙只挂这些，没参加聊天的不进墙 */
  const webTargets = useMemo(() => targets.filter((m) => m.transport === 'webview'), [targets])
  const apiTargets = useMemo(() => targets.filter((m) => m.transport === 'api'), [targets])

  /**
   * 原生墙的编排（哪几格挂载、哪几格退回标签、开几列）。
   *
   * 判断本身住在 chatWall.ts 那个纯函数里 —— 输入有四路（参与者、换进来的顺序、
   * 墙此刻多大、被放大的那格），错了又不崩，只是「点了没反应」和「多烧一个渲染进程」，
   * 那种账最适合留在能断言的地方，而不是靠手点 Electron。
   *
   * 尺寸来自网格容器本身（回调 ref：墙只在原生模式下存在，节点是后挂上来的）。
   * 量的是容器不是单格，所以「按尺寸定格数、格数又改格子尺寸」这条回环不成立。
   */
  const [wallGridEl, setWallGridEl] = useState<HTMLDivElement | null>(null)
  const wallBox = useElementBox(wallGridEl)
  /**
   * 被内存回收掉的保活实例。
   *
   * 只在系统内存真的吃紧时才会走到这里（见 pool-memory 的 pinned 三条豁免），
   * 但走到了就必须说：那一格的实例已经没了，点它进墙 = 站点重新落地一遍，
   * 上一场对话的页面找不回来。这种账不能等用户自己发现，得写在标签上。
   */
  const [recycled, setRecycled] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    return window.torra.on('webview:recycled', (payload) => {
      const id = (payload as { modelId?: string } | null)?.modelId
      if (!id) return
      setRecycled((cur) => {
        if (cur.has(id)) return cur
        const next = new Set(cur)
        next.add(id)
        return next
      })
    })
  }, [])
  /**
   * 用户拖开的缝（每轴的格权重，100 = 等分）。
   *
   * 存比例而不是存像素：窗口一拉大，存像素的那套就变形（列宽守卫踩过这个坑），
   * 而「这一格比隔壁宽一半」才是用户真正拖出来的东西。形状一换（列数不再等于
   * 权重长度）就自动作废、重新等分 —— 那正是「拖破地板档就少挂一枚」的落点。
   */
  const [colStored, setColStored] = useStoredWeights('wall.colw')
  const [rowStored, setRowStored] = useStoredWeights('wall.roww')
  /**
   * 正在拖的那条缝。拖动期间钉住格数与形状：不钉的话，把某一格拖到破地板档的
   * 那一瞬间列数就退了，这根把手所属的格子当场从墙上消失，手感像「拖到一半被弹开」。
   * 松手（这里变回 null）才让 planPanes 按新的最窄格重算。
   */
  const [seamDrag, setSeamDrag] = useState<{
    axis: SeamAxis
    index: number
    weights: Weights
    hold: { cols: number; rows: number; cap: number }
  } | null>(null)

  const wall = useMemo(() => {
    const byId = new Map(webTargets.map((m) => [m.id, m]))
    const p = planPanes({
      ids: [...byId.keys()],
      promoted: paneOrder ?? undefined,
      expanded: expandedPane,
      box: wallBox,
      seams: {
        cols: seamDrag?.axis === 'col' ? seamDrag.weights : colStored,
        rows: seamDrag?.axis === 'row' ? seamDrag.weights : rowStored,
      },
      cap: seamDrag ? seamDrag.hold.cap : undefined,
      hold: seamDrag ? { cols: seamDrag.hold.cols, rows: seamDrag.hold.rows } : null,
    })
    const pick = (ids: string[]) => ids.map((id) => byId.get(id)!).filter(Boolean)
    return {
      cols: p.cols,
      rows: p.rows,
      cap: p.cap,
      tier: p.tier,
      colW: p.colW,
      rowW: p.rowW,
      seamPinned: p.seamPinned,
      seamBreached: p.seamBreached,
      breachCols: p.breachCols,
      breachRows: p.breachRows,
      live: pick(p.live),
      rest: pick(p.rest),
    }
  }, [webTargets, paneOrder, expandedPane, wallBox, seamDrag, colStored, rowStored])

  /**
   * 墙上这几格的当下顺序（第 k 格 ↔ 第 k 个 id）。拖动交换读的是这份、写回的也是它，
   * 而不是那份可能已经缺了新参与者的存值 —— 对调必须发生在「用户看到的那一排」上。
   */
  const wallIds = useMemo(() => [...wall.live, ...wall.rest].map((m) => m.id), [wall])

  /**
   * 独占中的那一枚。墙上只剩一格时有两种成因，界面得说清是哪一种：
   * 一种是比例把墙切坏了（下面 seamBreached），另一种是用户自己点了放大 ——
   * 后者若也说「这一屏只放得下 12 枚」，他读到的是「墙明明摆得下，却没给我摆」，
   * 而真实情况是这一格正被他自己要的独占占满，点别的该说的是「退出独占、两格一起回来」。
   */
  const solo = expandedPane ? (webTargets.find((m) => m.id === expandedPane) ?? null) : null

  /** 按下缝：从当下真正生效的那一组权重开始转，并把这一路的格数/形状钉住 */
  const seamDown = (axis: SeamAxis, index: number) => {
    if (axis === 'col' ? wall.cols < 2 : wall.rows < 2) return
    setSeamDrag({
      axis,
      index,
      weights: axis === 'col' ? wall.colW : wall.rowW,
      hold: { cols: wall.cols, rows: wall.rows, cap: wall.cap },
    })
  }
  const seamMove = (next: Weights) => setSeamDrag((d) => (d ? { ...d, weights: next } : d))
  const seamUp = (axis: SeamAxis, next: Weights | null) => {
    if (next) (axis === 'col' ? setColStored : setRowStored)(next)
    setSeamDrag(null)
  }
  /** 双击缝：删掉存值 = 恢复等分（与那几条列宽分隔条同一套手势） */
  const seamReset = (axis: SeamAxis) => {
    ;(axis === 'col' ? setColStored : setRowStored)(null)
    setSeamDrag(null)
  }
  /** 两个轴一起复位：墙头那颗钮用（比例压到只剩一格时，墙上已经没有缝可双击了） */
  const seamResetBoth = () => {
    setColStored(null)
    setRowStored(null)
    setSeamDrag(null)
  }
  /**
   * 「把这一枚换进墙」有两个入口 —— 下方参与者徽章、墙上那条「未挂载」标签 ——
   * 它们必须做同一件事，否则同一句话在两个地方给出两种结果，而其中一种正是死状态。
   *
   * 墙被破档的比例压到只剩一格时，「点另一枚」的意思是**我要把它加回来**，
   * 不是「换进来顶掉这一格」：那一格已经没得换了，用户看到的正是「并存没了」。
   * 于是先把破了的那一轴清掉（没破的那一轴留着，那是他故意拖宽的），再换进来 ——
   * 容量一恢复，两格同时回到墙上。
   */
  const promotePane = (id: string) => {
    if (wall.breachCols) setColStored(null)
    if (wall.breachRows) setRowStored(null)
    setExpandedPane(null)
    setPaneOrder([id, ...wallIds.filter((x) => x !== id)])
  }

  /*
   * 拖动交换两格的位置。
   *
   * 手势只能从窗格头部起手：格子里那一大片是原生视图，画在渲染层之上，指针一进去
   * 就归站点，渲染层连 pointermove 都收不到 —— 缝之所以要占一条自己的轨道，是同一个原因。
   * 所以越过阈值的第一件事是把墙上所有视图摘回离屏宿主：摘掉之后整格才又是 DOM，
   * 「松手落在哪一格」才量得到；松手后由各格的贴合循环把它们贴回来，
   * 页面、登录态、滚动位置一概不动（pool.dismiss 换的是爹，不是实例）。
   *
   * 起手之前一律不动手：没越过阈值的那一下就是普通点击，头部那颗放大按钮还得照常工作。
   */
  const [paneSwap, setPaneSwap] = useState<{ from: number; over: number | null } | null>(null)
  const swapDown = (from: number, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || expandedPane || wall.live.length < 2) return
    const pid = e.pointerId
    const x0 = e.clientX
    const y0 = e.clientY
    /** 松手要照着它交换的那份顺序：拖期间没人改它，按下时快照够用 */
    const order = wallIds
    let live = false
    let over: number | null = null
    const hit = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y)?.closest('[data-wall-index]')
      const i = Number.parseInt(el?.getAttribute('data-wall-index') ?? '', 10)
      if (Number.isFinite(i)) return i
      /*
       * 命中不到具体格子（落在缝上、落在墙上那点空隙里）不等于「不在墙上」。
       * 按格子的矩形判：包含这一点的那一格优先，其次取中心最近的那一格 ——
       * 等于把「我在缝的哪一边」接着判下去，而不是让松手那一下凭空失效。
       * 出了墙界一律算没命中：拖到聊天区松手是「取消」，不该把两格换了。
       */
      const grid = document.querySelector('.cx-wall')?.getBoundingClientRect()
      if (!grid || x < grid.left || x > grid.right || y < grid.top || y > grid.bottom) return null
      let fallback: { i: number; d: number } | null = null
      for (const c of document.querySelectorAll('[data-wall-index]')) {
        const k = Number.parseInt(c.getAttribute('data-wall-index') ?? '', 10)
        if (!Number.isFinite(k)) continue
        const r = c.getBoundingClientRect()
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) {
          const d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y)
          if (!fallback || d < fallback.d) fallback = { i: k, d }
          continue
        }
        return k
      }
      return fallback?.i ?? null
    }
    const nameOf = (id: string) => webTargets.find((m) => m.id === id)?.displayName ?? id
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      if (!live) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < SWAP_SLOP_PX) return
        live = true
        document.body.classList.add('wall-swapping')
        setPaneSwap({ from, over: null })
      }
      const next = hit(ev.clientX, ev.clientY)
      const cand = next === from ? null : next
      if (cand !== over) {
        over = cand
        setPaneSwap({ from, over })
      }
    }
    const done = (commit: boolean, x = 0, y = 0) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', cancel)
      document.body.classList.remove('wall-swapping')
      setPaneSwap(null)
      if (!commit || !live) return
      const to = hit(x, y)
      if (to === null || to === from || !order[to] || !order[from]) return
      setPaneOrder(swapAt(order, from, to))
      pushNotice(`已交换「${nameOf(order[from])}」与「${nameOf(order[to])}」的位置`, { tone: 'success', ttl: 2600 })
    }
    const up = (ev: PointerEvent) => done(true, ev.clientX, ev.clientY)
    const cancel = () => done(false)
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') done(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', cancel)
  }
  /** 是不是拖开过（某一轴不再等分）：那句「每格不低于 420×240」得跟着换成真实最窄格 */
  const seamUsed =
    wall.colW.some((x) => x !== wall.colW[0]) || wall.rowW.some((x) => x !== wall.rowW[0])
  /**
   * 墙头要不要给一颗复位钮：某一轴被拖开过（含被拖破地板档）。
   * 光靠「双击缝」不够 —— 比例把列数压到 1 之后墙上连一条缝都不剩，
   * 那句指引就成了死路，用户只能看着一整屏摆一格。
   */
  const seamStuck = seamUsed || wall.seamBreached
  const tightPx = useMemo(() => {
    if (wallBox.w <= 0 || wallBox.h <= 0) return null
    const cs = trackPx(wallBox.w, wall.colW)
    const rs = trackPx(wallBox.h, wall.rowW)
    if (cs.length === 0 || rs.length === 0) return null
    return { w: Math.round(Math.min(...cs)), h: Math.round(Math.min(...rs)) }
  }, [wallBox, wall.colW, wall.rowW])
  // 那一枚重新挂上墙（present 会 ensure 重建实例），或它退出了参与者，标记就要摘掉：
  // 留着的话，用户会在一个已经加载好好的窗格（或一个根本不参与的标签）上看到「已回收」，比不写更误导。
  useEffect(() => {
    if (recycled.size === 0) return
    const live = new Set(wall.live.map((m) => m.id))
    const targets = new Set(webTargets.map((m) => m.id))
    const kept = [...recycled].filter((id) => targets.has(id) && !live.has(id))
    if (kept.length === recycled.size) return
    setRecycled(new Set(kept))
  }, [wall.live, webTargets, recycled])

  // 参与者变了（掉出一个模型）就别让放大位指着一枚已经不在墙上的视图
  useEffect(() => {
    setExpandedPane((cur) => (cur && webTargets.some((m) => m.id === cur) ? cur : null))
    /*
     * 存着的那份顺序也要把掉出去的那位摘掉：planPanes 本来就会忽略不在场的 id，
     * 所以不换也不会画错 —— 但名单只增不减地留在盘上，几场之后就成了读不懂的化石。
     */
    if (paneOrder?.some((id) => !webTargets.some((m) => m.id === id))) {
      setPaneOrder(paneOrder.filter((id) => webTargets.some((m) => m.id === id)))
    }
  }, [webTargets])

  /*
   * 保活名单：原生模式下 = 这一场全部的网页参与者，不只是贴在墙上的那几格。
   *
   * 为什么必须整批报：墙上摆不下的那几枚住在「未挂载」标签条里，既不算 attached
   * 又常十几分钟不碰 —— 正好是常驻上限（3 枚）和空闲回收（10 分钟）最爱清理的形状。
   * 一旦被拆，用户点它换进墙时看到的是站点重新落地那一页，上一场对话当场没了；
   * 而「切过去不刷新」正是原生模式唯一的承诺。
   *
   * 切回提取模式要传空数组放开：那时没人点名要它们在后台活着，继续占着是纯浪费。
   */
  useEffect(() => {
    const ids = viewMode === 'native' ? webTargets.map((m) => m.id) : []
    void window.torra.webviewPin(ids).catch(() => undefined)
  }, [viewMode, webTargets])

  /**
   * 快速切换网页模型：Alt+←/→ 在网页模型之间循环。
   * 只在视图已经开着时接管按键 —— 没开的时候这两个键属于浏览器/输入框的历史行为。
   */
  useEffect(() => {
    if (!webviewTarget || webModels.length < 2) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const i = webModels.findIndex((m) => m.id === webviewTarget)
      if (i < 0) return
      e.preventDefault()
      const n = webModels.length
      const next = webModels[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n]!
      setWebviewTarget(next.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [webviewTarget, webModels])

  // 首次渲染后确定活动会话
  useEffect(() => {
    setActiveId((cur) => cur || chats[0]?.id || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 持久化：chats 在逐字流里每个 token 换一次引用，落盘不能跟着每帧全量 stringify
  const chatsSaver = useMemo(
    () =>
      createChatsSaver(STORE_KEY, (k, json) => {
        try {
          localStorage.setItem(k, json)
        } catch {
          /* 存储不可用时静默跳过 */
        }
      }),
    [],
  )
  useEffect(() => {
    chatsSaver.schedule(chats)
  }, [chats, chatsSaver])
  useEffect(() => {
    // 关窗、切走、卸载都补一次：防抖窗口里最多丢几百毫秒，不该丢到最后一步
    const onSavePoint = (): void => chatsSaver.flush()
    window.addEventListener('beforeunload', onSavePoint)
    document.addEventListener('visibilitychange', onSavePoint)
    return () => {
      window.removeEventListener('beforeunload', onSavePoint)
      document.removeEventListener('visibilitychange', onSavePoint)
      chatsSaver.flush()
    }
  }, [chatsSaver])

  const active = chats.find((c) => c.id === activeId) ?? chats[0]

  /*
   * 原生模式把整屏让给网页：左栏收成一条只有轮次编号的窄轨，输入条压成底部一行细条。
   * 默认只在「左栏本来就没东西可看」时收 —— 网页模型的回答就在墙上，左栏留着只是复述问题；
   * 而 API 模型的回答只有本地卡片这一份，收起来等于把它唯一可见的地方藏掉。
   * 用户手动展开/收起过（leanPinned）就以他的选择为准，不再被参与者构成改回去。
   */
  const lean = viewMode === 'native' && (leanPinned ?? apiTargets.length === 0)
  /** 真的收起来了没有：一轮都没问过时没东西可收，别拿一条空轨对着用户 */
  const leanOn = lean && (active?.turns.length ?? 0) > 0

  /**
   * 标签条末尾那句要说的是当下的真相，五者不能混：
   * 有人在独占（用户自己点了放大）→ 说「退出独占」，别念那个对不上号的容量；
   * 比例破了地板档（拖的时候墙够宽，之后窗口缩小 / 左栏展开把它压破的）→ 容量是按最窄
   * 那一格折算的，得说破，并给出两条复位路：墙头那颗钮，或直接点没挂上的标签；
   * 墙摆满了 → 劝拖宽（窄轨态下这句是假话：墙已经吃满整屏，也没有把手可拖了）；
   * 参与者比格数少 → 报余量；
   * 没摆满却还有候补 → 是缝的比例把列数钉住了，不说的话用户只看到「墙放得下 6 枚，
   * 墙上却只有 4 格」，以为这墙坏了一半。
   */
  const stripTail = solo
    ? `，${solo.displayName} 正在独占整面墙：点这枚标签退出独占、两格一起回到墙上`
    : wall.seamBreached
      ? `，格子的比例破了地板档：这一屏按最窄那一格算只剩 ${wall.cols}×${wall.rows}，点右上「恢复等分」，或直接点没挂上的标签复位`
      : wall.rest.length > 0
        ? wall.seamPinned
          ? `，缝的比例把这一屏钉成 ${wall.cols} 列：双击任意缝恢复等分，等分才会按墙宽多开格`
          : '，点标签换进墙里'
        : wall.live.length >= wall.cap
          ? leanOn
            ? '，墙已占满这一屏，再要多一格只能先摘一位参与者'
            : '，把墙拖宽或收起左栏还能多挂'
          : `，${wall.live.length} 位参与者已全部挂上，腾出的 ${wall.cap - wall.live.length} 格是余量`

  /**
   * 每格窗格右上角的状态位：取自当前会话最近一轮、该模型的投递结果。
   *
   * 原生模式没有正文可看，「话到底送进去没有」是这一格唯一还能替用户回答的问题。
   * 只看最近一轮：墙上贴的是站点当前页面，更早那轮的收据已经没有指示意义了。
   */
  const paneStatus = useMemo(() => {
    const out: Record<string, { tone: 'live' | 'ok' | 'error'; text: string; turnId: string }> = {}
    const t = active?.turns[active.turns.length - 1]
    if (!t) return out
    for (const m of webTargets) {
      const c = t.cells[m.id]
      if (!c) continue
      // turnId 一起带出去：原生视图下左栏不给网页模型放卡片，重试这颗按钮只能长在窗格头部
      if (c.streaming) out[m.id] = { tone: 'live', text: '投递中', turnId: t.id }
      else if (c.error) out[m.id] = { tone: 'error', text: '需处理', turnId: t.id }
      else if (c.delivered) out[m.id] = { tone: 'ok', text: '已投递', turnId: t.id }
    }
    return out
  }, [active, webTargets])

  const anyStreaming = chats.some((c) =>
    c.turns.some((t) => Object.values(t.cells).some((cell) => cell.streaming)),
  )

  const showAnchors = !leanOn && targets.length > 0 && !!active && active.turns.length >= 2

  /** 这一问在哪些格子里有原生页面可定位：只认投递过的网页模型（没发出去的不必找） */
  const webCellsOf = (t: Turn) =>
    webTargets
      .map((m) => ({ m, cell: t.cells[m.id] }))
      .filter((x) => !!x.cell && (x.cell.native || x.cell.delivered))

  const noteLocate = (modelId: string, text: string) => {
    const at = Date.now()
    locateNoteAt.current[modelId] = at
    setLocateNote((cur) => ({ ...cur, [modelId]: text }))
    window.setTimeout(() => {
      // 只清自己这一次：8 秒内又点了别的问题，就别把新结论擦掉
      if (locateNoteAt.current[modelId] === at) {
        setLocateNote((cur) => {
          const next = { ...cur }
          delete next[modelId]
          return next
        })
      }
    }, 8000)
  }

  /**
   * 点左侧那一问：让墙上每一格原生页面把自己那一份找出来、滚到视野中间。
   *
   * 先就地找，找不到才跳回这一轮所在的会话再找 —— 后者会换掉用户正在看的页面，
   * 所以只在「这一问确实不在当前 DOM 里」时才做（消息列表虚拟化的站点只挂最近
   * 一两个回合，更早那轮压根不在页面上），且主进程只认适配器入口同源的那个地址。
   */
  const locateInPanes = (turnId: string) => {
    if (!active || viewMode !== 'native') return
    const t = active.turns.find((x) => x.id === turnId)
    if (!t) return
    for (const { m, cell } of webCellsOf(t)) {
      const c = cell as AnswerCell
      void window.torra
        .chatLocate({ modelId: m.id, prompt: t.question, ...(c.siteUrl ? { url: c.siteUrl } : {}) })
        .then((r) => noteLocate(m.id, locateVerdict(r, !!c.siteUrl)))
        .catch((e: unknown) => noteLocate(m.id, `定位没走通：${String((e as Error)?.message ?? e)}`))
    }
  }

  /** 点击锚点：把对应轮次滚到滚动区顶部，并钉住导航便于连续跳转 */
  const scrollToTurn = (id: string) => {
    // 网页模型在原生视图下没有本地卡片，下面那个「本地卡片没挂出来就返回」会先挡掉它们，
    // 所以定位必须走在返回之前，而不是挂在滚动成功的那条路上。
    locateInPanes(id)
    const box = turnsRef.current
    const el = box?.querySelector<HTMLElement>(`[data-turn="${id}"]`)
    if (!box || !el) return
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top
    box.scrollTo({ top: box.scrollTop + delta - 8, behavior: 'smooth' })
    setActiveTurn(id)
    setNavPinned(true)
  }

  // 窄轨上点进来的那一轮：等展开后的轮次流真的挂出来，再补这一次滚动
  useEffect(() => {
    const id = pendingScrollRef.current
    if (!id || leanOn) return
    pendingScrollRef.current = null
    scrollToTurn(id)
  })

  // 滚动时高亮当前视口顶部所在的那一轮
  useEffect(() => {
    const box = turnsRef.current
    if (!box) return
    const compute = () => {
      const nodes = Array.from(box.querySelectorAll<HTMLElement>('[data-turn]'))
      if (nodes.length === 0) {
        setActiveTurn(null)
        return
      }
      const top = box.getBoundingClientRect().top
      let cur = nodes[0]!.dataset.turn ?? null
      for (const n of nodes) {
        if (n.getBoundingClientRect().top - top <= 12) cur = n.dataset.turn ?? cur
        else break
      }
      setActiveTurn(cur)
    }
    box.addEventListener('scroll', compute, { passive: true })
    compute()
    return () => box.removeEventListener('scroll', compute)
  }, [activeId, active?.turns.length])

  const patchCell = (chatId: string, modelId: string, turnId: string, patch: Partial<AnswerCell>) => {
    setChats((prev) =>
      prev.map((c) =>
        c.id !== chatId
          ? c
          : {
              ...c,
              turns: c.turns.map((t) =>
                t.id === turnId && t.cells[modelId]
                  ? { ...t, cells: { ...t.cells, [modelId]: { ...t.cells[modelId]!, ...patch } } }
                  : t,
              ),
            },
      ),
    )
  }

  // 事件订阅：按 chatId + modelId 归位
  useEffect(() => {
    const offDelta = window.torra.on('chat:delta', (p) => {
      const { chatId, modelId, chunk } = p as { chatId: string; modelId: string; chunk: string }
      const turnId = activeTurnRef.current[modelId]
      if (!turnId) return
      const streamKey = `${chatId}:${modelId}:${turnId}`
      streamedContentRef.current[streamKey] = `${streamedContentRef.current[streamKey] ?? ''}${chunk}`
      setChats((prev) =>
        prev.map((c) =>
          c.id !== chatId
            ? c
            : {
                ...c,
                turns: c.turns.map((t) =>
                  t.id === turnId && t.cells[modelId]
                    ? {
                        ...t,
                        cells: {
                          ...t.cells,
                          [modelId]: { ...t.cells[modelId]!, content: t.cells[modelId]!.content + chunk },
                        },
                      }
                    : t,
                ),
              },
        ),
      )
    })

    const offThink = window.torra.on('chat:thinking-delta', (p) => {
      const { chatId, modelId, chunk } = p as { chatId: string; modelId: string; chunk: string }
      const turnId = activeTurnRef.current[modelId]
      if (!turnId) return
      setChats((prev) =>
        prev.map((c) =>
          c.id !== chatId
            ? c
            : {
                ...c,
                turns: c.turns.map((t) =>
                  t.id === turnId && t.cells[modelId]
                    ? {
                        ...t,
                        cells: {
                          ...t.cells,
                          [modelId]: {
                            ...t.cells[modelId]!,
                            thinking: (t.cells[modelId]!.thinking ?? '') + chunk,
                          },
                        },
                      }
                    : t,
                ),
              },
        ),
      )
    })

    const offSteps = window.torra.on('chat:steps-delta', (p) => {
      const { chatId, modelId, chunk } = p as { chatId: string; modelId: string; chunk: string }
      const turnId = activeTurnRef.current[modelId]
      if (!turnId) return
      setChats((prev) =>
        prev.map((c) =>
          c.id !== chatId
            ? c
            : {
                ...c,
                turns: c.turns.map((t) =>
                  t.id === turnId && t.cells[modelId]
                    ? {
                        ...t,
                        cells: {
                          ...t.cells,
                          [modelId]: {
                            ...t.cells[modelId]!,
                            steps: (t.cells[modelId]!.steps ?? '') + chunk,
                          },
                        },
                      }
                    : t,
                ),
              },
        ),
      )
    })

    const offDone = window.torra.on('chat:done', (p) => {
      const { chatId, modelId, content, thinking, steps, note, images } = p as {
        chatId: string
        modelId: string
        content: string
        thinking?: string
        steps?: string
        note?: string
        images?: ChatAttachmentMeta[]
      }
      const turnId = activeTurnRef.current[modelId]
      if (!turnId) return
      const streamKey = `${chatId}:${modelId}:${turnId}`
      const streamed = streamedContentRef.current[streamKey] ?? ''
      const reported = typeof content === 'string' ? content : ''
      const gotImages = Array.isArray(images) && images.length > 0
      /**
       * 生图轮主进程读空正文时，增量里剩下的那点文字是站点自己的出图进度标签
       * （元宝实测「13%…Image3.5 preview」），不是回答 —— 有图就以图为产出，
       * 不能回退到 streamed，否则占位文案会留在卡片上。
       * 增量的长度上限是护栏：真写了一大段说明只是收尾读取失败时，宁可保留全文。
       */
      const finalContent = reported.trim()
        ? streamed.length > reported.length
          ? streamed
          : reported
        : gotImages && streamed.length < 600
          ? ''
          : streamed
      const donePatch: Partial<AnswerCell> = {
        content: finalContent,
        streaming: false,
        // 生图那一轮可以一个字都没有，只有图：有图就算有产出，不报「未捕获到回复」
        error: finalContent || gotImages ? undefined : '生成已结束，但未捕获到回复内容',
      }
      // done 未必再带全文思考：缺省时不覆盖，保留已实时流出的 thinking
      if (thinking) donePatch.thinking = thinking
      if (steps) donePatch.steps = steps
      if (note) donePatch.note = note
      if (gotImages) donePatch.images = images
      patchCell(chatId, modelId, turnId, donePatch)
      delete streamedContentRef.current[streamKey]
      delete activeTurnRef.current[modelId]
    })

    const offErr = window.torra.on('chat:error', (p) => {
      const { chatId, modelId, reason } = p as { chatId: string; modelId: string; reason: string }
      const turnId = activeTurnRef.current[modelId]
      if (!turnId) return
      patchCell(chatId, modelId, turnId, { streaming: false, error: reason })
      delete streamedContentRef.current[`${chatId}:${modelId}:${turnId}`]
      delete activeTurnRef.current[modelId]
    })

    /**
     * 原生模式的一轮：主进程只递话、不读回正文，所以这里收到的是一张收据。
     *
     * accepted=true 表示站点输入框被清空、这一轮真的发出去了；正文留在右侧那格
     * 原生页面里由用户自己读。false 也不代表模型没答 —— 只代表我们没能把话送进去，
     * 而那恰好是原生视图存在的意义：用户当场看得见，也能当场接手。
     */
    const offDelivered = window.torra.on('chat:delivered', (p) => {
      const { chatId, modelId, accepted, note, url } = p as {
        chatId: string
        modelId: string
        accepted?: boolean
        note?: string
        url?: string
      }
      const turnId = activeTurnRef.current[modelId]
      if (!turnId) return
      patchCell(chatId, modelId, turnId, {
        streaming: false,
        native: true,
        delivered: !!accepted,
        ...(accepted ? {} : { error: '站点没接走这一轮：输入框失效、需要登录或被拦截。右侧原生页面里能当场接手。' }),
        ...(note ? { note } : {}),
        // 会话指针：这一轮落在站点哪一场会话里，日后点左侧那一问就靠它跳回来。
        // 站点没换路由（会话地址等于入口）时主进程给空串，那时只认「就地找」。
        ...(url ? { siteUrl: url } : {}),
      })
      delete streamedContentRef.current[`${chatId}:${modelId}:${turnId}`]
      delete activeTurnRef.current[modelId]
    })

    return () => {
      offDelta()
      offThink()
      offSteps()
      offDone()
      offErr()
      offDelivered()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flash = (msg: string, tone: NoteTone = 'warn') => {
    setComposerNote({ msg, tone })
    window.setTimeout(() => setComposerNote((cur) => (cur?.msg === msg ? null : cur)), 3200)
  }

  /** 读入用户选/粘贴/拖拽的文件：字节交给主进程存，渲染层只留元数据 + 即时预览 */
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return
    for (const f of files) {
      const kind = classifyKind(f.type || '')
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

  /**
   * 触发一批模型：登记 in-flight 归位键 → 发送 → 处理整体失败/逐个拒绝。
   *
   * 新提问、重生成、编辑重发都走这里 —— 事件流按 (chatId,modelId)→turnId
   * 归位到既有单元格，因此重生成不需要额外一条事件通道。
   *
   * 出口事件有两条：提取模式等 chat:done（带正文），原生模式等 chat:delivered
   * （只带收据）。同一模型不会两条都发，所以归位键的清理在两处各自做一次即可。
   */
  const launch = async (
    chatId: string,
    turnId: string,
    question: string,
    items: Array<{ modelId: string; history: Array<{ role: Role; content: string }> }>,
    attachments?: ChatAttachmentMeta[],
  ) => {
    for (const it of items) {
      activeTurnRef.current[it.modelId] = turnId
      streamedContentRef.current[`${chatId}:${it.modelId}:${turnId}`] = ''
    }
    const fail = (modelId: string, reason: string) => {
      patchCell(chatId, modelId, turnId, { streaming: false, error: reason })
      delete streamedContentRef.current[`${chatId}:${modelId}:${turnId}`]
      delete activeTurnRef.current[modelId]
    }
    const r = await window.torra.chatSend({
      chatId,
      message: question,
      items,
      attachments,
      // 只影响网页通道的模型：原生 = 递话即收工，提取 = 再把正文读回卡片。API 通道两边同一条链路。
      webMode: viewMode,
    })
    if (!r.ok) {
      for (const it of items) fail(it.modelId, r.reason ?? '发送失败')
      return
    }
    for (const { modelId, reason } of r.rejected ?? []) fail(modelId, reason)
  }

  const send = async () => {
    const q = input.trim()
    if (anyStreaming || targets.length === 0 || !active) return
    if (!q && pending.length === 0) return
    const attachments = pending.map((p) => p.att)

    const chatId = active.id
    const turnId = uid('t')
    const cells: Record<string, AnswerCell> = {}
    targets.forEach((m) => {
      // 原生那一轮的卡片从登记起就知道自己不会有正文，渲染时按「投递收据」而不是「等待回答」说话
      cells[m.id] = {
        content: '',
        streaming: true,
        native: viewMode === 'native' && m.transport === 'webview',
      }
    })

    setChats((prev) =>
      prev.map((c) =>
        c.id !== chatId
          ? c
          : {
              ...c,
              title: c.title === '新对话' ? (q || attachments[0]?.name || '新对话').slice(0, 24) : c.title,
              turns: [...c.turns, { id: turnId, question: q, cells, attachments, at: Date.now() }],
            },
      ),
    )
    setInput('')
    setPending([])
    // 预览用的 object URL 只为 dock 服务；轮次展示走 attachmentRead，回收避免泄漏
    for (const p of pending) if (p.url) URL.revokeObjectURL(p.url)

    const items = targets.map((m) => ({ modelId: m.id, history: modelHistory(active, m.id) }))
    await launch(chatId, turnId, q, items, attachments)
  }

  /** 重新生成：只重跑该模型这一轮的回答，原位替换那个单元格 */
  const regenerateCell = (chatId: string, turnId: string, modelId: string) => {
    const chat = chats.find((c) => c.id === chatId)
    if (!chat) return
    const idx = chat.turns.findIndex((t) => t.id === turnId)
    const turn = idx >= 0 ? chat.turns[idx] : undefined
    if (!turn || turn.cells[modelId]?.streaming) return
    // 重跑按「现在」的视图模式重投：上一轮是原生、这一轮切了提取，是用户主动换的链路，
    // 收据与正文两种形态都只跟这一轮自己走，所以要连 delivered 一起清掉。
    patchCell(chatId, modelId, turnId, {
      content: '',
      thinking: '',
      steps: '',
      streaming: true,
      error: undefined,
      delivered: undefined,
      note: undefined,
      native: viewMode === 'native' && models.some((m) => m.id === modelId && m.transport === 'webview'),
    })
    const history = historyBefore(chat, modelId, idx)
    void launch(chatId, turnId, turn.question, [{ modelId, history }], turn.attachments)
  }

  /** 编辑问题：截断该轮及其后所有对话，作为新一轮重新发给当前参与者 */
  const editTurn = (chatId: string, turnId: string, newText: string) => {
    const chat = chats.find((c) => c.id === chatId)
    if (!chat || anyStreaming || targets.length === 0) return
    const idx = chat.turns.findIndex((t) => t.id === turnId)
    if (idx < 0) return
    const atts = chat.turns[idx]!.attachments
    if (!newText.trim() && (!atts || atts.length === 0)) return

    const prior = chat.turns.slice(0, idx)
    const priorChat: Chat = { ...chat, turns: prior }
    const newTurnId = uid('t')
    const cells: Record<string, AnswerCell> = {}
    targets.forEach((m) => {
      // 原生那一轮的卡片从登记起就知道自己不会有正文，渲染时按「投递收据」而不是「等待回答」说话
      cells[m.id] = {
        content: '',
        streaming: true,
        native: viewMode === 'native' && m.transport === 'webview',
      }
    })
    setChats((prev) =>
      prev.map((c) =>
        c.id !== chatId
          ? c
          : { ...c, turns: [...prior, { id: newTurnId, question: newText.trim(), cells, attachments: atts, at: Date.now() }] },
      ),
    )
    const items = targets.map((m) => ({ modelId: m.id, history: modelHistory(priorChat, m.id) }))
    void launch(chatId, newTurnId, newText.trim(), items, atts)
  }

  /**
   * 一键另起一场会话（会话栏那颗「新对话」与输入框旁那颗共用这一段）。
   *
   * 为什么要有它：每一轮发出去时都会把这一场的前几轮一起带上（modelHistory），
   * 换个新话题接着问，模型是拿着上一题的上下文答这一题 —— 用户看到的
   * 「答着答着跑偏」多半就是这个，而不是模型不行。
   *
   * 网页那几格必须跟着送回站点入口：原生模式下上下文根本住在站点那一页里，
   * 本地换一场而页面不动，DeepSeek / 元宝 照旧带着上一场全部内容，
   * 这颗按钮对它们就是空的。
   */
  const addChat = () => {
    // 已经站在空会话上就别叠空壳：连点五下会留下五个要一个个删的壳子
    if (active && active.turns.length === 0) {
      flash('这一场已经是空的了，直接问就行', 'info')
      inputRef.current?.focus()
      return
    }
    const c = newChat()
    setChats((prev) => [c, ...prev])
    setActiveId(c.id)
    /*
     * 草稿不清：点「新会话」的人十有八九已经把下一个问题打在框里了，清掉等于让他
     * 重打一遍。旧那场也不删、不弹确认 —— 它原样留在会话栏里，随时点得回去。
     */
    void openFreshWebPanes()
  }

  /** 把在场网页模型的这一格开回站点新会话；谁没开回来就说得出是谁、为什么 */
  const openFreshWebPanes = async () => {
    const ids = webTargets.map((m) => m.id)
    if (ids.length === 0) return
    const failed: string[] = []
    let reopened = 0
    for (const id of ids) {
      try {
        const r = await window.torra.webviewFresh(id)
        if (r?.reopened) reopened++
        if (!r?.ok && r?.reason) failed.push(r.reason)
      } catch (e) {
        failed.push(`${webTargets.find((m) => m.id === id)?.displayName ?? id}：${String((e as Error)?.message ?? e)}`)
      }
    }
    if (failed.length) {
      flash(`已另起一场，但网页那几格没全开回来：${failed.join('；')}`, 'warn')
      return
    }
    /*
     * 只在真的动过页面时说话。原生模式墙上摆的就是用户正在读的那几页，
     * 一次没人认领的点击把它们刷回站点首页，得留下一句「上一场还找得回来」——
     * 靠的正是刚做的会话指针：点旧问题，那一格会跳回那一问。
     */
    if (reopened > 0) flash(`已另起一场，网页那 ${reopened} 格开回了站点首页；上一场的问题点一下就能跳回去`, 'info')
  }

  const removeChat = (id: string) => {
    setConfirmDel(null)
    setChats((prev) => {
      const next = prev.filter((c) => c.id !== id)
      if (next.length === 0) {
        const c = newChat()
        setActiveId(c.id)
        return [c]
      }
      if (id === activeId) setActiveId(next[0]!.id)
      return next
    })
  }

  const commitRename = () => {
    if (!renamingId) return
    const t = renameDraft.trim()
    if (t) setChats((prev) => prev.map((c) => (c.id === renamingId ? { ...c, title: t.slice(0, 40) } : c)))
    setRenamingId(null)
  }

  const clearActiveChat = () => {
    if (!active || anyStreaming) return
    setChats((prev) => prev.map((c) => (c.id === active.id ? { ...c, title: '新对话', turns: [] } : c)))
    setInput('')
  }

  const copyAnswer = async (key: string, content: string) => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1600)
    } catch {
      setCopiedKey(null)
    }
  }

  return (
    <div className="cx-root" ref={rootRef}>
      {/* ── 会话栏：可折叠，双击重命名 ── */}
      <aside
        className={`cx-sessions${sessionsOpen ? '' : ' collapsed'}`}
        ref={sessionsRef}
        style={widthVar('--cx-sess-w', sessW)}
      >
        <div className="cx-sess-head">
          <span className="cx-sess-title">会话</span>
          <button
            className="cx-icon-btn"
            onClick={() => setSessionsOpen(false)}
            title="折叠会话栏"
            aria-label="折叠会话栏"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
        <button className="cx-new" onClick={addChat}>
          <Plus size={13} />
          新对话
        </button>
        <div className="cx-sess-list">
          {chats.map((c) => (
            <div
              key={c.id}
              className={`cx-sess${c.id === active?.id ? ' active' : ''}`}
              onClick={() => setActiveId(c.id)}
              onDoubleClick={() => {
                setRenamingId(c.id)
                setRenameDraft(c.title)
              }}
              title={`${c.title}（双击重命名）`}
            >
              {renamingId === c.id ? (
                <input
                  className="cx-sess-rename"
                  value={renameDraft}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    else if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onBlur={commitRename}
                />
              ) : (
                <>
                  <MessageSquare size={12} className="cx-sess-icon" />
                  <span className="cx-sess-name">{c.title}</span>
                  {confirmDel === c.id ? (
                    <span className="cx-sess-confirm" onClick={(e) => e.stopPropagation()}>
                      <button className="cx-icon-btn danger" title="确认删除" onClick={() => removeChat(c.id)}>
                        <Trash2 size={12} />
                      </button>
                      <button className="cx-icon-btn" title="取消" onClick={() => setConfirmDel(null)}>
                        <X size={12} />
                      </button>
                    </span>
                  ) : (
                    <button
                      className="cx-sess-del"
                      title="删除此对话"
                      aria-label="删除此对话"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmDel(c.id)
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </aside>

      {sessionsOpen && (
        <Splitter
          dir={1}
          label="调整会话栏宽度"
          measure={() => sessionsRef.current?.offsetWidth || 208}
          min={210}
          max={420}
          onResize={setSessW}
        />
      )}

      {/* ── 主体：整宽顶栏 + 一行（轮次列 | 网页墙）+ 整宽输入条 ── */}
      <div className="cx-body">
        <header className="cx-topbar">
          <div className="cx-topbar-id">
            {!sessionsOpen && (
              <button
                className="cx-sessions-peek"
                onClick={() => setSessionsOpen(true)}
                title="展开会话栏"
                aria-label="展开会话栏"
              >
                <PanelLeftOpen size={14} />
              </button>
            )}
            <h2>{active?.title ?? '并行对话'}</h2>
            <span className="cx-meta">
              {targets.length > 0 ? `${targets.length} 个目标 · ${active?.turns.length ?? 0} 轮` : '尚未选择模型'}
            </span>
          </div>
          <div className="cx-topbar-actions">
            <span className={`cx-state${anyStreaming ? ' live' : ''}`}>
              <span className="state-pulse" />
              {anyStreaming ? '回答生成中' : '会话就绪'}
            </span>
            {viewMode === 'native' && (
              /*
               * 收起/展开左栏。默认口径自己会选（没有 API 参与者就收成窄轨），这颗按钮
               * 是让用户否决它的那一下 —— 手动选过之后就不再被参与者构成改回去。
               * 置灰只看「收成窄轨也没东西可摆」那一种：窄轨已经收起来了的时候绝不能 disabled，
               * 否则这一栏只剩「点某个编号」一条回头路，收起态就成了出不来的坑。
               */
              <button
                className={`cx-icon-btn${leanOn ? ' active' : ''}`}
                disabled={lean && !leanOn}
                onClick={() => setLeanPinned(!leanOn)}
                title={leanOn ? '展开左栏：读问题原文、编辑重发、看 API 模型的回答' : '收起左栏：整屏让给各家网页'}
                aria-label={leanOn ? '展开轮次栏' : '收起轮次栏'}
              >
                {leanOn ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
              </button>
            )}
            <div className="cx-seg" role="group" aria-label="网页模型的展示方式">
              <button
                className={`cx-seg-btn has-label${viewMode === 'native' ? ' active' : ''}`}
                onClick={() => setViewMode('native')}
                title="原生：网页模型的回答就留在它自己的页面上，右侧一次看全部。不解析站点结构，改版也打断不了这一轮（聊天模式默认）"
                aria-label="原生视图"
              >
                <Monitor size={13} />
                原生
              </button>
              <button
                className={`cx-seg-btn has-label${viewMode === 'extract' ? ' active' : ''}`}
                onClick={() => setViewMode('extract')}
                title="提取：把各家回答读回本地存成卡片，能复制、进历史、参与导出。依赖站点结构，站点改版可能读不到正文"
                aria-label="提取视图"
              >
                <ScrollText size={13} />
                提取
              </button>
            </div>
            <div className="cx-seg" role="group" aria-label="视图密度">
              <button
                className={`cx-seg-btn${density === 'grid' ? ' active' : ''}`}
                onClick={() => setDensity('grid')}
                title="并排对比"
                aria-label="并排对比"
              >
                <LayoutGrid size={13} />
              </button>
              <button
                className={`cx-seg-btn${density === 'stack' ? ' active' : ''}`}
                onClick={() => setDensity('stack')}
                title="单列细读"
                aria-label="单列细读"
              >
                <Rows3 size={13} />
              </button>
            </div>
            <button
              className="cx-icon-btn"
              onClick={clearActiveChat}
              disabled={!active || anyStreaming || active.turns.length === 0}
              title="清空当前对话"
              aria-label="清空当前对话"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </header>

        <div className={`cx-row${leanOn ? ' lean' : ''}`}>
          <div
            className={`cx-main${showAnchors ? ' anchors' : ''}${leanOn ? ' lean' : ''}`}
            onDragOver={(e) => {
              if (e.dataTransfer?.types?.includes('Files')) {
                e.preventDefault()
                setDragOver(true)
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              void addFiles(Array.from(e.dataTransfer?.files ?? []))
            }}
          >
            <div className="cx-stage">
              <div className="cx-scroll" ref={turnsRef}>
                {targets.length === 0 ? (
                  <div className="cx-hero">
                    <div className="cx-hero-badge"><Sparkles size={22} /></div>
                    <h3>先选几个模型，再开始比较</h3>
                    <p>在左侧模型栏双击卡片加入参与者。网页模型和 API 模型可以一起横向对比。</p>
                  </div>
                ) : !active || active.turns.length === 0 ? (
                  <div className="cx-hero">
                    <div className="cx-hero-badge"><Sparkles size={22} /></div>
                    <h3>准备好了，问一个值得比较的问题</h3>
                    <p>已连接 {targets.length} 个模型。回答按轮次保留，方便追问和横向比较。</p>
                    <div className="cx-hero-keys">
                      <span><kbd>Enter</kbd>发送</span>
                      <span><kbd>Shift+Enter</kbd>换行</span>
                      <span><kbd>Ctrl+V</kbd>粘贴图片</span>
                      <span><kbd>拖拽</kbd>添加附件</span>
                    </div>
                  </div>
                ) : leanOn ? (
                  /*
                   * 窄轨：整屏让给网页，左栏只留「问过几轮」。
                   * 原文走 title 而不是自绘弹层 —— 原生网页视图永远画在渲染层之上，
                   * 往右探出去的半透明层会被那一格站点页面直接切掉，系统 tooltip 才压得过它。
                   * 点一下把这一轮摊开：读全文、编辑重发、看 API 模型的回答，都只在展开态里。
                   */
                  <div className="cx-rail">
                    {active.turns.map((t, i) => {
                      const live = Object.values(t.cells).some((c) => c.streaming)
                      const bad = Object.values(t.cells).filter((c) => c.error).length
                      return (
                        <button
                          key={t.id}
                          className={`cx-rail-dot${t.id === activeTurn ? ' active' : ''}`}
                          title={`第 ${i + 1} 轮 · ${t.question || '（只有附件）'}${t.attachments?.length ? ` · ${t.attachments.length} 个附件` : ''}`}
                          onClick={() => {
                            setLeanPinned(false)
                            pendingScrollRef.current = t.id
                          }}
                        >
                          Q{i + 1}
                          {live && <span className="cx-rail-mark live" />}
                          {!live && bad > 0 && <span className="cx-rail-mark error" />}
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  active.turns.map((t, i) => (
                    <TurnBlock
                      key={t.id}
                      turn={t}
                      index={i + 1}
                      density={density}
                      models={models}
                      copiedKey={copiedKey}
                      onCopy={copyAnswer}
                      onEnlarge={(modelId) => setFocus({ turnId: t.id, modelId })}
                      onRegenerate={(modelId) => regenerateCell(active.id, t.id, modelId)}
                      onEdit={(newText) => editTurn(active.id, t.id, newText)}
                      onOpenNative={(modelId) => {
                        // 用户切去提取模式后回看这一张原生收据：把它请回墙上，顺带独占一格
                        setViewMode('native')
                        setPaneOrder([modelId, ...wallIds.filter((x) => x !== modelId)])
                        setExpandedPane(modelId)
                      }}
                      hideWeb={viewMode === 'native'}
                    />
                  ))
                )}
              </div>

              {showAnchors && active && (
                <div className={`cx-nav${!navPinned ? ' collapsed' : ''}`}>
                  <div className="cx-nav-list">
                    {active.turns.map((t, i) => (
                      <button
                        key={t.id}
                        className={`cx-nav-item${t.id === activeTurn ? ' active' : ''}`}
                        onClick={() => scrollToTurn(t.id)}
                        title={t.question}
                      >
                        <span className="cx-nav-bar" />
                        <span className="cx-nav-body">
                          <span className="cx-nav-idx">Q{i + 1}</span>
                          <span className="cx-nav-text">{t.question}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <button
                    className="cx-nav-toggle"
                    onClick={() => setNavPinned((v) => !v)}
                    title={!navPinned ? '展开问题导航' : '收起问题导航'}
                    aria-label="切换问题导航"
                  >
                    {!navPinned ? <Plus size={12} /> : <Minus size={12} />}
                  </button>
                </div>
              )}
            </div>

            {dragOver && <div className="cx-drop-mask"><span>松开鼠标，把文件发给所有目标</span></div>}
          </div>

          {viewMode === 'native' ? (
            webTargets.length > 0 && (
              <>
                {/* 窄轨态把这条把手藏掉：墙吃满整屏（样式表 .cx-row.lean），拖它不动任何东西，
                    留着只会让人以为右边那条死区还能被拖没。藏法沿用 zoom 态那条
                    body.webview-zoom .col-split —— 组件留在树上，收起/展开不重建它，
                    把手上的双击恢复默认与 aria 状态一路跟着这一列走。 */}
                <Splitter
                  dir={-1}
                  label="调整原生墙宽度"
                  style={leanOn ? { display: 'none' } : undefined}
                  measure={() =>
                    webviewRef.current?.offsetWidth ||
                    Math.round((rootRef.current?.clientWidth || 1200) * 0.56)
                  }
                  min={380}
                  /* 墙上每一格都是一个真的站点页面，宽度直接决定能不能看清字。
                     展开态给轮次流留 420px（样式表再替它封顶 1240），拖出来的像素宽
                     在窗口缩小时由 max-width 那条夹住，不会把聊天列吃光。 */
                  max={() =>
                    Math.max(
                      380,
                      (rootRef.current?.clientWidth || 1200) -
                        (sessionsRef.current?.offsetWidth || 208) -
                        420,
                    )
                  }
                  onResize={setWebW}
                />
                {/* 列数/比例/行数全由 planPanes 写成轨道（格 缝 格 缝 格）：
                    缝必须占自己的轨道才收得到指针，见 chatWall.SEAM_PX 与 WallSeam。 */}
                <aside
                  className="cx-webview wall"
                  ref={webviewRef}
                  style={widthVar('--cx-web-w', webW)}
                >
                  <div className="cx-wall-head">
                    <span className="cx-wall-title">
                      <Monitor size={12} />
                      原生页面
                      <b>{wall.live.length}</b>
                      {expandedPane ? ' 格 · 独占' : ' 格'}
                    </span>
                    <span className="cx-wall-note">
                      {wall.tier > 0 && (
                        <b className="cx-wall-tier" title={`这一屏摆满 ${wall.cols}×${wall.rows} 后每格低于舒适档 ${COMFY_PANE.w}×${COMFY_PANE.h}，但仍在地板档 ${FLOOR_PANE.w}×${FLOOR_PANE.h} 之上 —— 再切一刀就只剩站点自己的导航栏，宁可挤这一档，也不把参与者从墙上摘掉。`}>
                          每格低于舒适档 · {wall.cols}×{wall.rows}
                        </b>
                      )}
                      {wall.seamBreached && (
                        <b className="cx-wall-tier" title={`拖出来的格子比例此刻在地板档 ${FLOOR_PANE.w}×${FLOOR_PANE.h} 以下（拖的时候墙比现在宽）：这一屏改按最窄那一格算容量，所以只摆 ${wall.cols}×${wall.rows}。点右上「恢复等分」，或直接点没挂上的那枚标签，都会把破了的那一轴复位。`}>
                          格子比例破了地板档 · {wall.cols}×{wall.rows}
                        </b>
                      )}
                      {paneSwap && (
                        <b
                          className="cx-wall-tier swapping"
                          title="交换的只是这两格的位置：页面不重载、登录态不动，其余格一像素不变"
                        >
                          {paneSwap.over === null
                            ? '拖动中 · 松手落在哪一格就和它交换'
                            : `松手：与「${wall.live[paneSwap.over]?.displayName ?? '这一格'}」交换位置`}
                        </b>
                      )}
                      回答留在各家自己的页面上，这一侧不提取正文 —— 站点改版打断不了这一轮。
                      格之间的缝能拖：拖开一格、其余不动，最窄拖到地板档就停手，双击恢复等分；要一格占满整面墙用窗格头上的放大；要换位置就按住窗格头部拖到另一格上。要复制/进历史请切「提取」。
                    </span>
                    {seamStuck && (
                      <button
                        className="cx-icon-btn"
                        onClick={seamResetBoth}
                        title="恢复等分：把拖过的格子比例清掉，格数交回墙宽说了算"
                        aria-label="恢复等分"
                      >
                        <Grid2x2 size={12} />
                      </button>
                    )}
                    {expandedPane && (
                      <button className="cx-icon-btn" onClick={() => setExpandedPane(null)} title="还原并排" aria-label="还原并排">
                        <Minimize2 size={12} />
                      </button>
                    )}
                  </div>
                  <div
                    className="cx-wall"
                    ref={setWallGridEl}
                    style={{
                      gridTemplateColumns: wallTracks(wall.colW),
                      gridTemplateRows: wallTracks(wall.rowW),
                    }}
                  >
                    {wall.live.map((m, k) => {
                      const st = paneStatus[m.id]
                      const note = locateNote[m.id]
                      const role = paneSwap ? (paneSwap.from === k ? 'src' : paneSwap.over === k ? 'target' : null) : null
                      return (
                        <div
                          key={m.id}
                          className={`cx-cell${role ? ` swap-${role}` : ''}`}
                          /* 松手时靠它认「落在哪一格」：交换按的是这一排的当下位置 */
                          data-wall-index={k}
                          style={{
                            gridColumn: trackIndex(k % wall.cols),
                            gridRow: trackIndex(Math.floor(k / wall.cols)),
                          }}
                        >
                          <WebviewDock
                            model={m}
                            variant="pane"
                            status={
                              st || note
                                ? (
                                  <>
                                    {st ? (
                                      <>
                                        <span className={`cx-pane-st ${st.tone}`}>{st.text}</span>
                                        {/* 左栏不给网页模型放卡片了，「重试这一轮」就只能从这一格的头部走 */}
                                        {st.tone === 'error' && active && (
                                          <button
                                            className="btn sm"
                                            onClick={() => regenerateCell(active.id, st.turnId, m.id)}
                                            title="重试这一轮：把同一个问题再送一次给这一家"
                                          >
                                            重试
                                          </button>
                                        )}
                                      </>
                                    ) : null}
                                    {note && (
                                      <span
                                        className="cx-pane-st locate"
                                        title={`${note}｜点左侧的问题轨可以让这一格去找它自己那一份；站点只把最近几轮留在页面上时，这里会说清楚`}
                                      >
                                        {note}
                                      </span>
                                    )}
                                  </>
                                )
                                : undefined
                            }
                            expanded={expandedPane === m.id}
                            onExpand={() => setExpandedPane((cur) => (cur === m.id ? null : m.id))}
                            onSwapGrip={wall.live.length > 1 ? (e) => swapDown(k, e) : undefined}
                            swapRole={role}
                            swapHold={!!paneSwap}
                          />
                        </div>
                      )
                    })}
                    {/*
                     * 缝自己是一条轨道（第 2i+2 轨），格在奇数轨上。竖缝跨满所有行、
                     * 横缝跨满所有列 —— 交点让竖缝先画、横缝盖在上面，跟表格的画法一致。
                     */}
                    {Array.from({ length: Math.max(0, wall.cols - 1) }, (_, i) => (
                      <WallSeam
                        key={`seam-col-${i}`}
                        axis="col"
                        index={i}
                        total={wallBox.w}
                        weights={wall.colW}
                        onDragStart={() => seamDown('col', i)}
                        onDrag={seamMove}
                        onEnd={(next) => seamUp('col', next)}
                        onReset={() => seamReset('col')}
                        style={{ gridColumn: 2 * i + 2, gridRow: `1 / span ${2 * wall.rows - 1}` }}
                      />
                    ))}
                    {Array.from({ length: Math.max(0, wall.rows - 1) }, (_, j) => (
                      <WallSeam
                        key={`seam-row-${j}`}
                        axis="row"
                        index={j}
                        total={wallBox.h}
                        weights={wall.rowW}
                        onDragStart={() => seamDown('row', j)}
                        onDrag={seamMove}
                        onEnd={(next) => seamUp('row', next)}
                        onReset={() => seamReset('row')}
                        style={{ gridRow: 2 * j + 2, gridColumn: `1 / span ${2 * wall.cols - 1}` }}
                      />
                    ))}
                  </div>
                  {wall.rest.length > 0 && (
                    <div className="cx-wall-strip">
                      <span className="cx-wall-strip-k">未挂载</span>
                      {wall.rest.map((m) => (
                        <button
                          key={m.id}
                          className={`cx-wall-chip${recycled.has(m.id) ? ' recycled' : ''}`}
                          onClick={() => promotePane(m.id)}
                          title={
                            recycled.has(m.id)
                              ? `${m.displayName} 的网页实例已被系统回收：点它会重新加载站点页面，上一场对话的页面回不来（登录态不丢）`
                              : solo
                                ? `点这枚退出「${solo.displayName}」的独占：${m.displayName} 跟着回到墙上，两格并存`
                                : wall.seamBreached
                                  ? `${m.displayName} 被破了地板档的比例挤下了墙（这一屏只放得下 ${wall.cap} 枚），点击把比例复位并加回来`
                                  : `换进墙里${wall.live.length >= wall.cap || wall.seamPinned ? '（最后一格让位）' : ''}：${m.displayName}`
                          }
                        >
                          <ModelFavicon m={m} />
                          {m.displayName}
                          {recycled.has(m.id) && <span className="cx-wall-chip-tag">已回收·点击重新加载</span>}
                        </button>
                      ))}
                      <span className="cx-wall-strip-hint">
                        {seamUsed && tightPx
                          ? `这一屏放得下 ${wall.cap} 枚：拖开后最窄一格 ${tightPx.w}×${tightPx.h}（地板档 ${FLOOR_PANE.w}×${FLOOR_PANE.h}，缝拖到这一格剩地板档就停手）`
                          : `这一屏放得下 ${wall.cap} 枚：每格不低于 ${FLOOR_PANE.w}×${FLOOR_PANE.h}`}
                        {stripTail}
                      </span>
                    </div>
                  )}
                </aside>
              </>
            )
          ) : (
            webviewTarget &&
            webviewTargetModel && (
              <>
                <Splitter
                  dir={-1}
                  label="调整网页视图宽度"
                  measure={() => webviewRef.current?.offsetWidth || Math.round((rootRef.current?.clientWidth || 1200) * 0.44)}
                  min={340}
                  /* 最宽也不能把聊天区挤没：要留出会话栏本身 + 420px 轮次流，
                     只从整行宽度里扣一个数会让主区先被吃掉（列宽是三条抢同一行）  */
                  max={() =>
                    Math.min(
                      880,
                      Math.max(340, (rootRef.current?.clientWidth || 1200) - (sessionsRef.current?.offsetWidth || 208) - 420),
                    )
                  }
                  onResize={setWebW}
                />
                <aside className="cx-webview" ref={webviewRef} style={widthVar('--cx-web-w', webW)}>
                  <WebviewDock
                    model={webviewTargetModel}
                    tabs={webModels}
                    onPickTab={(id) => setWebviewTarget(id)}
                    zoomable
                    onClose={() => setWebviewTarget(null)}
                    onRecheck={() => void recheckChatModel(webviewTargetModel.id)}
                  />
                </aside>
              </>
            )
          )}
        </div>

        {targets.length > 0 && (
          /*
           * 原生模式下它是横贯底部的一行细条：网页是主角，输入不该带着大阴影压在墙上。
           * 展开与否交给 barOpen（记在 dock 上，不是 textarea 上）：点附件那颗按钮
           * 会让输入框先失焦，只盯 textarea 的条会在用户眼皮底下当场缩回去一次。
           */
          <div
            className={`cx-dock${viewMode === 'native' ? ` bar${barOpen ? ' open' : ''}` : ''}`}
            onFocus={() => setBarFocus(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setBarFocus(false)
            }}
          >
            {composerNote && (
              <div className={`cx-dock-note${composerNote.tone === 'info' ? ' info' : ''}`}>{composerNote.msg}</div>
            )}
            {pending.length > 0 && (
              <div className="cx-att-strip">
                {pending.map((p) => (
                  <span key={p.att.id} className="cx-att-chip" title={p.att.name}>
                    {p.att.kind === 'image' && p.url ? (
                      <img
                        className="cx-att-thumb"
                        src={p.url}
                        alt={p.att.name}
                        title={`${p.att.name}（点击放大）`}
                        onClick={() => openImageZoom(p.url!, p.att.name)}
                      />
                    ) : (
                      <Paperclip size={11} className="cx-att-icon" />
                    )}
                    <span className="cx-att-name">{p.att.name}</span>
                    <button className="cx-att-x" onClick={() => removePending(p.att.id)} title="移除" aria-label="移除附件">
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="cx-input-row">
              <button
                className="cx-icon-btn cx-attach"
                onClick={() => fileInputRef.current?.click()}
                title="添加文件或图片"
                aria-label="添加附件"
              >
                <Paperclip size={15} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.markdown,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.java,.go,.rs,.c,.cpp,.h,.yaml,.yml,.toml,.sql,.sh,.html,.css"
                style={{ display: 'none' }}
                onChange={(e) => {
                  void addFiles(Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />
              <textarea
                ref={inputRef}
                className="cx-input"
                value={input}
                placeholder="输入问题，回车发送（Shift+Enter 换行 · 可直接 Ctrl+V 粘贴图片）"
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData?.files ?? [])
                  if (files.length > 0) {
                    e.preventDefault()
                    void addFiles(files)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <button
                className="cx-send"
                onClick={() => void send()}
                disabled={anyStreaming || (input.trim().length === 0 && pending.length === 0)}
                title="同时发送给所选模型"
              >
                {anyStreaming ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                发送
              </button>
              {/*
                原生模式下上下文住在站点那一页，只换本地这场等于什么都没换 ——
                所以这颗按钮的语义是「两边一起换」，title 里必须说清旧那场没丢、网页格会开回入口。
              */}
              <button
                className="cx-icon-btn cx-new-chat"
                onClick={addChat}
                title="另起一场：旧会话留在列表里可以随时切回，墙上网页那几格会开回站点新会话"
                aria-label="另起一场"
              >
                <MessageSquarePlus size={15} />
              </button>
            </div>
            <div className="cx-dock-foot">
              <div className="cx-participants">
                {targets.map((m) => {
                  const isWeb = m.transport === 'webview'
                  const inWall = isWeb && viewMode === 'native'
                  const onWall = inWall && wall.live.some((p) => p.id === m.id)
                  const st = inWall ? paneStatus[m.id] : undefined
                  /**
                   * 一颗 chip 三种落点（原生模式）：已在墙上→独占放大；已被放大→还原并排；
                   * 没在墙上（超出枚数上限）→换进来顶掉最后一格。
                   * 提取模式保持旧语义：点开右侧那一枚单窗视图。
                   */
                  const onClick = () => {
                    if (!isWeb) return
                    if (!inWall) return s.toggleChatWebview(m.id)
                    if (expandedPane === m.id) return setExpandedPane(null)
                    if (onWall) return setExpandedPane(m.id)
                    promotePane(m.id)
                  }
                  return (
                    <span
                      key={m.id}
                      className={
                        `cx-chip${isWeb ? ' is-webview' : ''}` +
                        `${inWall ? ' is-native' : ''}` +
                        `${onWall || (!inWall && webviewTarget === m.id) ? ' active' : ''}` +
                        `${inWall && !onWall ? ' off-wall' : ''}${expandedPane === m.id ? ' expanded' : ''}`
                      }
                      onClick={isWeb ? onClick : undefined}
                      title={
                        inWall
                          ? expandedPane === m.id
                            ? `还原 ${m.displayName}（退出独占）`
                            : onWall
                              ? `让 ${m.displayName} 独占整面墙`
                              : solo
                                ? `点这枚退出「${solo.displayName}」的独占：${m.displayName} 跟着回到墙上，两格并存`
                                : wall.seamBreached
                                  ? `${m.displayName} 被破了地板档的比例挤下了墙（这一屏只放得下 ${wall.cap} 枚），点击把比例复位并加回来`
                                  : `${m.displayName} 没在墙上（这一屏只放得下 ${wall.cap} 枚），点击换进来`
                          : isWeb
                            ? webviewTarget === m.id
                              ? '关闭网页视图'
                              : '点击查看该模型的网页对话记录'
                            : m.displayName
                      }
                    >
                      {st && <span className={`cx-chip-dot ${st.tone}`} />}
                      <ModelFavicon m={m} />
                      <span className="cx-chip-name">{m.displayName}</span>
                      {inWall && st && <span className="cx-chip-state">{st.text}</span>}
                      {isWeb && !inWall && <ExternalLink size={10} className="cx-chip-link" />}
                    </span>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {focus &&
        (() => {
          const t = active?.turns.find((x) => x.id === focus.turnId)
          const cell = t?.cells[focus.modelId]
          if (!t || !cell) return null
          const m = models.find((x) => x.id === focus.modelId)
          return (
            <FocusModal
              cell={cell}
              question={t.question}
              name={m?.displayName ?? focus.modelId}
              transport={m?.transport}
              model={m ?? ({ id: focus.modelId, displayName: focus.modelId, color: '#888' } as ModelSummary)}
              copiedKey={copiedKey}
              onCopy={copyAnswer}
              onRegenerate={() => {
                if (active) regenerateCell(active.id, t.id, focus.modelId)
              }}
              onClose={() => setFocus(null)}
            />
          )
        })()}
    </div>
  )
}

function FocusModal({
  cell,
  question,
  name,
  transport,
  model,
  copiedKey,
  onCopy,
  onRegenerate,
  onClose,
}: {
  cell: AnswerCell
  question: string
  name: string
  transport?: 'webview' | 'api'
  model: ModelSummary
  copiedKey: string | null
  onCopy: (key: string, content: string) => void
  onRegenerate: () => void
  onClose: () => void
}) {
  const [thinkOpen, setThinkOpen] = useState(true)
  const [stepsOpen, setStepsOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const hasThinking = !!cell.thinking?.trim()
  const hasSteps = !!cell.steps?.trim()
  const thinkKey = `focus:${model.id}:think`
  const copyKey = `focus:${model.id}`

  return (
    <div className="cx-focus-mask" onClick={onClose}>
      <div
        className="cx-focus"
        role="dialog"
        aria-modal="true"
        aria-label={`${name} 的回答`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cx-focus-head">
          <ModelFavicon m={model} />
          <div className="cx-focus-title">
            <b>{name}</b>
            <span>{transport === 'api' ? 'API' : '网页'}</span>
          </div>
          <div className="cx-focus-q" title={question}>{question}</div>
          {cell.streaming && (
            <span className="cx-status live"><span className="state-pulse live" />生成中</span>
          )}
          <button
            className="cx-icon-btn"
            title="仅重跑这个模型本轮的回答"
            aria-label="重新生成"
            disabled={cell.streaming}
            onClick={onRegenerate}
          >
            {cell.streaming ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          </button>
          <button className="cx-focus-close" title="关闭 (Esc)" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {cell.note && (
          <div className="cx-note" title={cell.note}>
            <AlertCircle size={12} />
            <span>{cell.note}</span>
          </div>
        )}

        {(hasThinking || hasSteps) && (
          <div className="cx-probes focus">
            {hasThinking && (
              <button className="cx-probe" onClick={() => setThinkOpen((v) => !v)} aria-expanded={thinkOpen}>
                <Brain size={11} />
                思考过程
                <ChevronDown size={11} className={`io-chevron${thinkOpen ? ' open' : ''}`} />
              </button>
            )}
            {hasSteps && (
              <button className="cx-probe" onClick={() => setStepsOpen((v) => !v)} aria-expanded={stepsOpen}>
                <Wrench size={11} />
                执行过程
                <ChevronDown size={11} className={`io-chevron${stepsOpen ? ' open' : ''}`} />
              </button>
            )}
          </div>
        )}
        {hasThinking && thinkOpen && (
          <div className="cx-fold">
            <pre className="focus">{cell.thinking}</pre>
            <button
              className={`cx-icon-btn${copiedKey === thinkKey ? ' done' : ''}`}
              title="复制思考过程"
              aria-label="复制思考过程"
              onClick={() => onCopy(thinkKey, cell.thinking!)}
            >
              {copiedKey === thinkKey ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
        )}
        {hasSteps && stepsOpen && (
          <div className="cx-fold steps">
            <pre className="focus">{cell.steps}</pre>
            <button
              className={`cx-icon-btn${copiedKey === `${thinkKey}:steps` ? ' done' : ''}`}
              title="复制执行过程"
              aria-label="复制执行过程"
              onClick={() => onCopy(`${thinkKey}:steps`, cell.steps!)}
            >
              {copiedKey === `${thinkKey}:steps` ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
        )}

        <div className="cx-focus-body">
          {cell.error ? (
            <div className="cx-ans-error">
              <strong>{cell.error}</strong>
              <small>可用标题栏的「重新生成」只重跑这个模型，或先打开该模型网页检查页面状态。</small>
            </div>
          ) : cell.content ? (
            <Markdown text={cell.content} />
          ) : (
            <span className="cx-ans-pending">等待回答…</span>
          )}
          {cell.images?.length ? <AnswerImages images={cell.images} /> : null}
        </div>

        <div className="cx-focus-foot">
          <button className="cx-btn" disabled={!cell.content} onClick={() => onCopy(copyKey, cell.content)}>
            {copiedKey === copyKey ? <Check size={12} /> : <Copy size={12} />}
            {copiedKey === copyKey ? '已复制' : '复制回答'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModelFavicon({ m }: { m: ModelSummary }) {
  const urls = getFaviconUrls(m.domain)
  const [idx, setIdx] = useState(0)
  if (urls.length > 0 && idx < urls.length) {
    return (
      <img
        src={urls[idx]}
        alt=""
        crossOrigin="anonymous"
        className="cx-avatar"
        onError={() => setIdx((p) => p + 1)}
      />
    )
  }
  return <span className="cx-avatar dot" style={{ background: m.color }} />
}

function TurnBlock({
  turn,
  index,
  density,
  models,
  copiedKey,
  onCopy,
  onEnlarge,
  onRegenerate,
  onEdit,
  onOpenNative,
  hideWeb,
}: {
  turn: Turn
  index: number
  density: 'grid' | 'stack'
  models: ModelSummary[]
  copiedKey: string | null
  onCopy: (key: string, content: string) => void
  onEnlarge: (modelId: string) => void
  onRegenerate: (modelId: string) => void
  onEdit: (newText: string) => void
  /** 原生收据卡片上的「在墙上单独看」 */
  onOpenNative: (modelId: string) => void
  /** 原生视图：网页模型的卡片整列不渲染，见下面 shown 的注释 */
  hideWeb: boolean
}) {
  const order = Object.keys(turn.cells)
  /*
   * 原生视图不给网页模型放卡片。回答就在右侧那一格里，左栏再复述一遍等于立第二份真相：
   * 提取来的正文会过期、会缺席、会判完得不对，而墙上那页永远是站点自己写的。
   * 隐藏按「当下的视图模式」而不是按「这一轮当初走的哪条链路」：切到原生，
   * 连此前在提取模式下拿到的正文一起收起来，切回提取又全在 —— 数据一个字没动。
   */
  const isWebCell = (id: string): boolean => models.find((m) => m.id === id)?.transport === 'webview'
  const shown = hideWeb ? order.filter((id) => !isWebCell(id)) : order
  const anyStreaming = order.some((id) => turn.cells[id]?.streaming)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(turn.question)
  const [qOpen, setQOpen] = useState(false)
  const qRef = useRef<HTMLParagraphElement>(null)
  const [qOverflow, setQOverflow] = useState(false)
  const qKey = `${turn.id}:q`
  const atts = turn.attachments ?? []
  const hasAtt = atts.length > 0
  // 只有真的被裁掉的问题才给「展开全文」，短问题保持一颗干净的气泡
  useEffect(() => {
    const el = qRef.current
    if (el) setQOverflow(el.scrollHeight - el.clientHeight > 4)
  }, [turn.question, qOpen])

  const startEdit = () => {
    setDraft(turn.question)
    setEditing(true)
  }
  const saveEdit = () => {
    const t = draft.trim()
    if (t || hasAtt) onEdit(t)
    setEditing(false)
  }

  return (
    <div className="cx-turn" data-turn={turn.id}>
      <div className={`cx-q${editing ? ' editing' : ''}`}>
        {editing ? (
          <div className="cx-q-edit">
            <textarea
              className="cx-q-edit-area"
              value={draft}
              rows={2}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  saveEdit()
                } else if (e.key === 'Escape') {
                  setEditing(false)
                }
              }}
            />
            <div className="cx-q-edit-actions">
              <button className="cx-btn" onClick={() => setEditing(false)}>取消</button>
              <button className="cx-btn primary" onClick={saveEdit} disabled={!draft.trim() && !hasAtt}>
                保存并重新发送
              </button>
            </div>
          </div>
        ) : (
          <>
            <span className="cx-q-no">Q{index}</span>
            <div className={`cx-q-body${qOpen ? '' : ' is-clamped'}`}>
              <p className="cx-q-text" ref={qRef}>{turn.question}</p>
              {hasAtt && (
                <div className="cx-q-atts">
                  {atts.map((a) =>
                    a.kind === 'image' ? (
                      <ChatImageAtt key={a.id} att={a} />
                    ) : (
                      <span key={a.id} className="cx-q-att-file" title={a.name}>
                        <Paperclip size={11} /> {a.name}
                      </span>
                    ),
                  )}
                </div>
              )}
              {(qOverflow || qOpen) && (
                <button className="cx-q-open" onClick={() => setQOpen((v) => !v)}>
                  {qOpen ? '收起' : '展开全文'}
                </button>
              )}
            </div>
            <span className="cx-q-side">
              {anyStreaming ? (
                <Loader2 size={12} className="spin" />
              ) : (
                <span className="cx-q-time">{fmtClock(turn.at)}</span>
              )}
              <span className="cx-q-actions">
                <button className={`cx-icon-btn${copiedKey === qKey ? ' done' : ''}`} title="复制问题" aria-label="复制问题" onClick={() => onCopy(qKey, turn.question)}>
                  {copiedKey === qKey ? <Check size={12} /> : <Copy size={12} />}
                </button>
                <button className="cx-icon-btn" title="编辑并重发（截断其后轮次）" aria-label="编辑问题" onClick={startEdit}>
                  <Pencil size={12} />
                </button>
              </span>
            </span>
          </>
        )}
      </div>

      {/* 一格都不剩时连网格容器都不放：那是个带边框的栅格，空着就是一块假面板 */}
      {shown.length > 0 && (
        <div className={`cx-grid ${density}`}>
          {shown.map((id) => {
            const cell = turn.cells[id]!
            const m = models.find((x) => x.id === id)
            return (
              <ChatCard
                key={id}
                cell={cell}
                name={m?.displayName ?? id}
                transport={m?.transport}
                dense={density === 'grid'}
                model={m ?? ({ id, displayName: id, color: '#888' } as ModelSummary)}
                copiedKey={copiedKey}
                copyKey={`${turn.id}:${id}`}
                thinkKey={`${turn.id}:${id}:think`}
                onCopy={onCopy}
                onEnlarge={() => onEnlarge(id)}
                onRegenerate={() => onRegenerate(id)}
                onOpenNative={m?.transport === 'webview' ? () => onOpenNative(id) : undefined}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 轮次里的图片附件：凭 id 回主进程读回字节做预览（重启后仍能显示） */
function ChatImageAtt({ att }: { att: ChatAttachmentMeta }) {
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
        className="cx-q-att-img"
        src={url}
        alt={att.name}
        title={`${att.name}（点击放大）`}
        onClick={() => openImageZoom(url, att.name)}
      />
    )
  return (
    <span className="cx-q-att-file" title={att.name}>
      <Paperclip size={11} /> {att.name}
    </span>
  )
}

/**
 * 模型生成的图片（AI 生图）：与用户上传附件一样凭 id 回主进程读字节，
 * 但尺寸按「作品」而不是「缩略图」给，点击放大走全局 ImageZoom。
 */
function AnswerImages({ images }: { images: ChatAttachmentMeta[] }) {
  return (
    <div className="cx-ans-imgs">
      {images.map((im) => (
        <AnswerImage key={im.id} att={im} />
      ))}
    </div>
  )
}

function AnswerImage({ att }: { att: ChatAttachmentMeta }) {
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
  if (!url) return <div className="cx-ans-img-slot" aria-label="图片加载中" />
  return (
    <img
      className="cx-ans-img"
      src={url}
      alt={att.name}
      title={`${att.name}（点击放大）`}
      onClick={() => openImageZoom(url, att.name)}
    />
  )
}

function ChatCard({
  cell,
  name,
  transport,
  model,
  dense,
  copiedKey,
  copyKey,
  thinkKey,
  onCopy,
  onEnlarge,
  onRegenerate,
  onOpenNative,
}: {
  cell: AnswerCell
  name: string
  transport?: 'webview' | 'api'
  model: ModelSummary
  dense: boolean
  copiedKey: string | null
  copyKey: string
  thinkKey: string
  onCopy: (key: string, content: string) => void
  onEnlarge: () => void
  onRegenerate: () => void
  /** 原生那一轮的「在墙上单独看」：把这格窗格独占整面墙。没有墙（提取模式）就不给这个按钮 */
  onOpenNative?: () => void
}) {
  const [thinkOpen, setThinkOpen] = useState(false)
  const [stepsOpen, setStepsOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const hasThinking = !!cell.thinking?.trim()
  const hasSteps = !!cell.steps?.trim()
  const clamped = dense && !cell.streaming && !cell.error && !!cell.content && !expanded
  // 封顶只在内容真的被裁掉时才亮出「展开全文」，短回答不该挂着没用的按钮
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    setOverflowing(el.scrollHeight - el.clientHeight > 4)
  }, [cell.content, clamped])

  return (
    <section
      className={`cx-ans${cell.error ? ' has-error' : ''}${cell.streaming ? ' is-live' : ''}${clamped ? ' is-clamped' : ''}${clamped && overflowing ? ' is-faded' : ''}`}
    >
      <header className="cx-ans-label">
        <ModelFavicon m={model} />
        <b>{name}</b>
        <span className="cx-ans-tag">{transport === 'api' ? 'API' : cell.native ? '原生' : '网页'}</span>
        {cell.streaming ? (
          <span className="cx-status live">
            <span className="state-pulse live" />
            {/* 原生模式这一轮没有正文可等，等的只是「站点把话接走」这张收据 */}
            {cell.native ? '投递中' : '生成中'}
          </span>
        ) : cell.error ? (
          <span className="cx-status error"><AlertCircle size={10} />需处理</span>
        ) : cell.delivered ? (
          <span className="cx-status ok"><Check size={10} />已投递</span>
        ) : null}
        <span className="cx-ans-tools">
          {(cell.content || cell.error) && (
            <button className="cx-icon-btn" title="放大查看" aria-label="放大查看" onClick={onEnlarge}>
              <Maximize2 size={12} />
            </button>
          )}
          <button
            className={`cx-icon-btn${copiedKey === copyKey ? ' done' : ''}`}
            title={copiedKey === copyKey ? '已复制' : '复制回答'}
            aria-label="复制回答"
            disabled={!cell.content}
            onClick={() => onCopy(copyKey, cell.content)}
          >
            {copiedKey === copyKey ? <Check size={12} /> : <Copy size={12} />}
          </button>
          <button
            className="cx-icon-btn"
            title="仅重跑这个模型本轮的回答"
            aria-label="重新生成"
            disabled={cell.streaming}
            onClick={onRegenerate}
          >
            {cell.streaming ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          </button>
        </span>
      </header>

      {cell.note && (
        <p className="cx-note" title={cell.note}>
          <AlertCircle size={12} />
          <span>{cell.note}</span>
        </p>
      )}

      {(hasThinking || hasSteps) && (
        <div className="cx-probes">
          {hasThinking && (
            <button className="cx-probe" onClick={() => setThinkOpen((v) => !v)} aria-expanded={thinkOpen}>
              <Brain size={11} />
              思考过程
              <ChevronDown size={11} className={`io-chevron${thinkOpen || cell.streaming ? ' open' : ''}`} />
            </button>
          )}
          {hasSteps && (
            <button className="cx-probe" onClick={() => setStepsOpen((v) => !v)} aria-expanded={stepsOpen}>
              <Wrench size={11} />
              执行过程
              <ChevronDown size={11} className={`io-chevron${stepsOpen || cell.streaming ? ' open' : ''}`} />
            </button>
          )}
        </div>
      )}
      {hasThinking && (thinkOpen || cell.streaming) && (
        <div className="cx-fold">
          <pre>{cell.thinking}</pre>
          <button
            className={`cx-icon-btn${copiedKey === thinkKey ? ' done' : ''}`}
            title="复制思考过程"
            aria-label="复制思考过程"
            onClick={() => onCopy(thinkKey, cell.thinking!)}
          >
            {copiedKey === thinkKey ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </div>
      )}
      {hasSteps && (stepsOpen || cell.streaming) && (
        <div className="cx-fold steps">
          <pre>{cell.steps}</pre>
          <button
            className={`cx-icon-btn${copiedKey === `${thinkKey}:steps` ? ' done' : ''}`}
            title="复制执行过程"
            aria-label="复制执行过程"
            onClick={() => onCopy(`${thinkKey}:steps`, cell.steps!)}
          >
            {copiedKey === `${thinkKey}:steps` ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </div>
      )}

      <div className="cx-ans-body" ref={bodyRef}>
        {cell.error ? (
          <div className="cx-ans-error">
            <strong>{cell.error}</strong>
            <small>可只重试这个模型这一条回答，或先打开该模型网页检查页面状态。</small>
            <button className="cx-link-btn" onClick={onRegenerate}>
              <RefreshCw size={11} /> 重试这个模型
            </button>
          </div>
        ) : cell.native ? (
          /*
           * 原生模式的一轮：卡片不装正文，只装这张收据和一个回去的路。
           * 「已投递」不等于「答完了」—— 我们只确认站点输入框被清空，
           * 生成与否由页面自己说话，用户在同一格窗格里当场看得见。
           */
          <div className={`cx-ans-native${cell.streaming ? ' is-live' : ''}`}>
            {cell.streaming ? (
              <>
                <Loader2 size={12} className="spin" />
                正在把这一轮送进 {name} 的页面…
              </>
            ) : (
              <>
                <Monitor size={12} className="cx-ans-native-ic" />
                <span>回答在 {name} 自己的页面上，本地不留正文。要复制、进历史或导出，切到顶栏的「提取」。</span>
                {onOpenNative && (
                  <button className="cx-link-btn" onClick={onOpenNative}>
                    <Maximize2 size={11} /> 在墙上单独看
                  </button>
                )}
              </>
            )}
          </div>
        ) : cell.content ? (
          <Markdown text={cell.content} />
        ) : cell.streaming ? (
          <div className="cx-skeleton" aria-label="正在生成回答">
            <i style={{ width: '86%' }} />
            <i style={{ width: '64%' }} />
          </div>
        ) : cell.images?.length ? null : (
          <span className="cx-ans-pending">等待回答…</span>
        )}
      </div>
      {/* 图片放在正文容器之外：正文在 grid 密度下会被 max-height 裁切，图不该跟着被裁 */}
      {cell.images?.length ? <AnswerImages images={cell.images} /> : null}
      {clamped && overflowing && (
        <button className="cx-more" onClick={() => setExpanded(true)}>展开全文</button>
      )}
    </section>
  )
}
