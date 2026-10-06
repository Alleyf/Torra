import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type ModelSummary } from '../store'
import { getFaviconUrls } from './ModelRail'
import { WebviewDock } from './WebviewDock'
import { openImageZoom } from './ImageZoom'
import { Markdown } from './Markdown'
import type { ChatAttachmentMeta } from '@shared/types'
import {
  Send, Loader2, AlertCircle, ChevronDown, Plus, Minus, Trash2, MessageSquare, Copy,
  Sparkles, Check, Brain, Wrench, ExternalLink, Maximize2, X, Paperclip, RefreshCw, Pencil,
  PanelLeftClose, PanelLeftOpen, LayoutGrid, Rows3,
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
  system: string
  turns: Turn[]
}

const STORE_KEY = 'torra.chat.v1'
const DENSITY_KEY = 'torra.chat.density'
const SESS_OPEN_KEY = 'torra.chat.sessionsOpen'

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function newChat(): Chat {
  return { id: uid('chat'), title: '新对话', createdAt: Date.now(), system: '', turns: [] }
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
  const s = useStore()
  const [chats, setChats] = useState<Chat[]>(() => {
    const loaded = loadChats()
    return loaded.length > 0 ? loaded : [newChat()]
  })
  const [activeId, setActiveId] = useState<string>(() => '')
  const [input, setInput] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  // 待发送附件 + 文件选择器 + 一次性提示
  const [pending, setPending] = useState<Pending[]>([])
  const [composerNote, setComposerNote] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 视图形态：并排网格 / 单列细读；会话栏折叠；拖拽悬停
  const [density, setDensity] = useState<'grid' | 'stack'>(() =>
    localStorage.getItem(DENSITY_KEY) === 'stack' ? 'stack' : 'grid',
  )
  const [sessionsOpen, setSessionsOpen] = useState<boolean>(() =>
    localStorage.getItem(SESS_OPEN_KEY) !== '0',
  )
  const [dragOver, setDragOver] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  useEffect(() => {
    localStorage.setItem(DENSITY_KEY, density)
  }, [density])
  useEffect(() => {
    localStorage.setItem(SESS_OPEN_KEY, sessionsOpen ? '1' : '0')
  }, [sessionsOpen])

  // 输入框跟着内容长高，最多 6 行：长问题被挤在一行里左右滚动，比正文还难读
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [input])

  // 每个模型当前正在接收增量的轮次（in-flight 唯一），用于把事件归位到正确卡片
  const activeTurnRef = useRef<Record<string, string>>({})
  // ChatGPT 有时会在完成事件中回传空内容；保留增量快照，避免空 done 覆盖已收到的文本。
  const streamedContentRef = useRef<Record<string, string>>({})
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [webviewTarget, setWebviewTarget] = useState<string | null>(null)
  const [webviewNote, setWebviewNote] = useState<string | null>(null)
  // 放大查看：记录当前展开的轮次 + 模型，正文与思考随流式更新实时放大呈现
  const [focus, setFocus] = useState<{ turnId: string; modelId: string } | null>(null)

  // 右侧问题锚点导航：滚动容器 + 当前定位轮 + 钉住展开态
  // 默认收起（只留短横），鼠标移到浮层上临时展开；点选某个问题后钉住展开，便于连续跳转。
  const turnsRef = useRef<HTMLDivElement>(null)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  const [navPinned, setNavPinned] = useState(false)

  /** 网页视图内登录完成后复核：真正的应用是"贴合呈现"，这里只复检登录态 */
  const recheckChatModel = async (id: string) => {
    const r = await window.torra.refreshLogin(id)
    void window.torra.listModels().then((m) => s.setModels(m))
    setWebviewNote(r.ok ? '登录态已确认' : (r.reason ?? '仍未就绪'))
    window.setTimeout(() => setWebviewNote(null), 3200)
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

  // 持久化
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(chats))
    } catch {
      /* 存储不可用时静默跳过 */
    }
  }, [chats])

  const active = chats.find((c) => c.id === activeId) ?? chats[0]

  const anyStreaming = chats.some((c) =>
    c.turns.some((t) => Object.values(t.cells).some((cell) => cell.streaming)),
  )

  const showAnchors = targets.length > 0 && !!active && active.turns.length >= 2

  /** 点击锚点：把对应轮次滚到滚动区顶部，并钉住导航便于连续跳转 */
  const scrollToTurn = (id: string) => {
    const box = turnsRef.current
    const el = box?.querySelector<HTMLElement>(`[data-turn="${id}"]`)
    if (!box || !el) return
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top
    box.scrollTo({ top: box.scrollTop + delta - 8, behavior: 'smooth' })
    setActiveTurn(id)
    setNavPinned(true)
  }

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
      const { chatId, modelId, content, thinking, steps, note } = p as {
        chatId: string
        modelId: string
        content: string
        thinking?: string
        steps?: string
        note?: string
      }
      const turnId = activeTurnRef.current[modelId]
      if (!turnId) return
      const streamKey = `${chatId}:${modelId}:${turnId}`
      const streamed = streamedContentRef.current[streamKey] ?? ''
      const reported = typeof content === 'string' ? content : ''
      const finalContent = reported.trim() ? (streamed.length > reported.length ? streamed : reported) : streamed
      const donePatch: Partial<AnswerCell> = {
        content: finalContent,
        streaming: false,
        error: finalContent ? undefined : '生成已结束，但未捕获到回复内容',
      }
      // done 未必再带全文思考：缺省时不覆盖，保留已实时流出的 thinking
      if (thinking) donePatch.thinking = thinking
      if (steps) donePatch.steps = steps
      if (note) donePatch.note = note
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

    return () => {
      offDelta()
      offThink()
      offSteps()
      offDone()
      offErr()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flash = (msg: string) => {
    setComposerNote(msg)
    window.setTimeout(() => setComposerNote((cur) => (cur === msg ? null : cur)), 3200)
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
   */
  const launch = async (
    chatId: string,
    turnId: string,
    question: string,
    system: string | undefined,
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
    const r = await window.torra.chatSend({ chatId, message: question, system, items, attachments })
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
      cells[m.id] = { content: '', streaming: true }
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
    await launch(chatId, turnId, q, active.system.trim() || undefined, items, attachments)
  }

  /** 重新生成：只重跑该模型这一轮的回答，原位替换那个单元格 */
  const regenerateCell = (chatId: string, turnId: string, modelId: string) => {
    const chat = chats.find((c) => c.id === chatId)
    if (!chat) return
    const idx = chat.turns.findIndex((t) => t.id === turnId)
    const turn = idx >= 0 ? chat.turns[idx] : undefined
    if (!turn || turn.cells[modelId]?.streaming) return
    patchCell(chatId, modelId, turnId, { content: '', thinking: '', steps: '', streaming: true, error: undefined })
    const history = historyBefore(chat, modelId, idx)
    void launch(chatId, turnId, turn.question, chat.system.trim() || undefined, [{ modelId, history }], turn.attachments)
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
      cells[m.id] = { content: '', streaming: true }
    })
    setChats((prev) =>
      prev.map((c) =>
        c.id !== chatId
          ? c
          : { ...c, turns: [...prior, { id: newTurnId, question: newText.trim(), cells, attachments: atts, at: Date.now() }] },
      ),
    )
    const items = targets.map((m) => ({ modelId: m.id, history: modelHistory(priorChat, m.id) }))
    void launch(chatId, newTurnId, newText.trim(), chat.system.trim() || undefined, items, atts)
  }

  const addChat = () => {
    const c = newChat()
    setChats((prev) => [c, ...prev])
    setActiveId(c.id)
    setShowSystem(false)
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
    setShowSystem(false)
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
    <div className="cx-root">
      {/* ── 会话栏：可折叠，双击重命名 ── */}
      <aside className={`cx-sessions${sessionsOpen ? '' : ' collapsed'}`}>
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

      {/* ── 主区：顶栏 + 轮次流 + 悬浮输入坞 ── */}
      <div
        className={`cx-main${showAnchors ? ' anchors' : ''}`}
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

        {targets.length > 0 && (
          <div className="cx-dock">
            {composerNote && <div className="cx-dock-note">{composerNote}</div>}
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
            </div>
            <div className="cx-dock-foot">
              <div className="cx-participants">
                {targets.map((m) => (
                  <span
                    key={m.id}
                    className={`cx-chip${m.transport === 'webview' ? ' is-webview' : ''}${webviewTarget === m.id ? ' active' : ''}`}
                    onClick={m.transport === 'webview' ? () => setWebviewTarget((cur) => (cur === m.id ? null : m.id)) : undefined}
                    title={m.transport === 'webview' ? (webviewTarget === m.id ? '关闭网页视图' : '点击查看该模型的网页对话记录') : m.displayName}
                  >
                    <ModelFavicon m={m} />
                    <span className="cx-chip-name">{m.displayName}</span>
                    {m.transport === 'webview' && <ExternalLink size={10} className="cx-chip-link" />}
                  </span>
                ))}
              </div>
              <button className="cx-sys-toggle" onClick={() => setShowSystem((v) => !v)}>
                <ChevronDown size={12} style={{ transform: showSystem ? 'rotate(180deg)' : 'none' }} />
                系统提示{active?.system.trim() ? '（已设定）' : '（可选）'}
              </button>
            </div>
            {showSystem && (
              <textarea
                className="cx-sys-input"
                value={active?.system ?? ''}
                placeholder="为本对话设定统一的角色或要求，例如「用中文，给出可执行的步骤」。留空则用默认助手提示。"
                onChange={(e) => {
                  const v = e.target.value
                  setChats((prev) => prev.map((c) => (c.id === active?.id ? { ...c, system: v } : c)))
                }}
              />
            )}
          </div>
        )}
        {webviewNote && <div className="cx-webview-note">{webviewNote}</div>}
      </div>

      {webviewTarget && webviewTargetModel && (
        <aside className="cx-webview">
          <WebviewDock
            model={webviewTargetModel}
            tabs={webModels}
            onPickTab={(id) => setWebviewTarget(id)}
            zoomable
            onClose={() => setWebviewTarget(null)}
            onRecheck={() => void recheckChatModel(webviewTargetModel.id)}
          />
        </aside>
      )}

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
}) {
  const order = Object.keys(turn.cells)
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

      <div className={`cx-grid ${density}`}>
        {order.map((id) => {
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
            />
          )
        })}
      </div>
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
        <span className="cx-ans-tag">{transport === 'api' ? 'API' : '网页'}</span>
        {cell.streaming ? (
          <span className="cx-status live"><span className="state-pulse live" />生成中</span>
        ) : cell.error ? (
          <span className="cx-status error"><AlertCircle size={10} />需处理</span>
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
        ) : cell.content ? (
          <Markdown text={cell.content} />
        ) : cell.streaming ? (
          <div className="cx-skeleton" aria-label="正在生成回答">
            <i style={{ width: '86%' }} />
            <i style={{ width: '64%' }} />
          </div>
        ) : (
          <span className="cx-ans-pending">等待回答…</span>
        )}
      </div>
      {clamped && overflowing && (
        <button className="cx-more" onClick={() => setExpanded(true)}>展开全文</button>
      )}
    </section>
  )
}
