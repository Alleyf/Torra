import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type ModelSummary } from '../store'
import { getFaviconUrls } from './ModelRail'
import { WebviewDock } from './WebviewDock'
import { Send, Loader2, AlertCircle, ChevronDown, Plus, Minus, Trash2, MessageSquare, Copy, RotateCcw, Sparkles, Users, Check, Brain, ExternalLink } from 'lucide-react'

type Role = 'user' | 'assistant'

/** 单个模型在某一轮的回答状态 */
interface AnswerCell {
  content: string
  thinking?: string
  streaming: boolean
  error?: string
}

/** 一轮 = 一个用户问题 + 各模型的并行回答 */
interface Turn {
  id: string
  question: string
  cells: Record<string, AnswerCell>
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
 * 聊天模式：把同一个问题并行发给多个模型，逐轮并排对比各自回答。
 *
 * 支持多个会话（左侧栏），会话持久化到本机 localStorage，重启恢复。
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

  // 每个模型当前正在接收增量的轮次（in-flight 唯一），用于把事件归位到正确卡片
  const activeTurnRef = useRef<Record<string, string>>({})
  // ChatGPT 有时会在完成事件中回传空内容；保留增量快照，避免空 done 覆盖已收到的文本。
  const streamedContentRef = useRef<Record<string, string>>({})
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [webviewTarget, setWebviewTarget] = useState<string | null>(null)
  const [webviewNote, setWebviewNote] = useState<string | null>(null)

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

    const offDone = window.torra.on('chat:done', (p) => {
      const { chatId, modelId, content, thinking } = p as {
        chatId: string
        modelId: string
        content: string
        thinking?: string
      }
      const turnId = activeTurnRef.current[modelId]
      if (!turnId) return
      const streamKey = `${chatId}:${modelId}:${turnId}`
      const streamed = streamedContentRef.current[streamKey] ?? ''
      const reported = typeof content === 'string' ? content : ''
      const finalContent = reported.trim() ? (streamed.length > reported.length ? streamed : reported) : streamed
      patchCell(chatId, modelId, turnId, {
        content: finalContent,
        thinking: thinking || undefined,
        streaming: false,
        error: finalContent ? undefined : '生成已结束，但未捕获到回复内容',
      })
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
      offDone()
      offErr()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = async () => {
    const q = input.trim()
    if (!q || anyStreaming || targets.length === 0 || !active) return

    const chatId = active.id
    const turnId = uid('t')
    const cells: Record<string, AnswerCell> = {}
    targets.forEach((m) => {
      cells[m.id] = { content: '', streaming: true }
      activeTurnRef.current[m.id] = turnId
      streamedContentRef.current[`${chatId}:${m.id}:${turnId}`] = ''
    })

    setChats((prev) =>
      prev.map((c) =>
        c.id !== chatId
          ? c
          : {
              ...c,
              title: c.title === '新对话' ? q.slice(0, 24) : c.title,
              turns: [...c.turns, { id: turnId, question: q, cells }],
            },
      ),
    )
    setInput('')

    const items = targets.map((m) => ({ modelId: m.id, history: modelHistory(active, m.id) }))

    const r = await window.torra.chatSend({
      chatId,
      message: q,
      system: active.system.trim() || undefined,
      items,
    })

    if (!r.ok) {
      targets.forEach((m) => {
        patchCell(chatId, m.id, turnId, { streaming: false, error: r.reason ?? '发送失败' })
        delete streamedContentRef.current[`${chatId}:${m.id}:${turnId}`]
        delete activeTurnRef.current[m.id]
      })
      return
    }
    const rejected = r.rejected ?? []
    if (rejected.length > 0) {
      for (const { modelId, reason } of rejected) {
        patchCell(chatId, modelId, turnId, { streaming: false, error: reason })
        delete streamedContentRef.current[`${chatId}:${modelId}:${turnId}`]
        delete activeTurnRef.current[modelId]
      }
    }
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
    <div className="chat-page">
      <div className="chat-sidebar">
        <button className="btn primary sm chat-new" onClick={addChat}>
          <Plus size={13} />
          新对话
        </button>
        <div className="chat-list">
          {chats.map((c) => (
            <div
              key={c.id}
              className={`chat-item${c.id === active?.id ? ' active' : ''}`}
              onClick={() => setActiveId(c.id)}
              title={c.title}
            >
              <MessageSquare size={12} className="chat-item-icon" />
              <span className="chat-item-title">{c.title}</span>
              {confirmDel === c.id ? (
                <span className="chat-item-confirm" onClick={(e) => e.stopPropagation()}>
                  <button className="btn sm icon danger" title="确认删除" onClick={() => removeChat(c.id)}>
                    <Trash2 size={12} />
                  </button>
                  <button className="btn sm icon" title="取消" onClick={() => setConfirmDel(null)}>
                    ✕
                  </button>
                </span>
              ) : (
                <button
                  className="chat-item-del"
                  title="删除此对话"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmDel(c.id)
                  }}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className={`chat-main${showAnchors ? ' anchors' : ''}`}>
        <div className="chat-head">
          <div>
            <div className="chat-kicker">TORRA / CHAT ROOM</div>
            <h2>{active?.title ?? '并行对话'}</h2>
            <p>同一个问题，多个视角。每个模型保留自己的上下文，回答并排呈现。</p>
          </div>
          <div className="chat-head-actions">
            <span className="chat-session-state"><span className={`state-pulse${anyStreaming ? ' live' : ''}`} />{anyStreaming ? '回答生成中' : '会话就绪'}</span>
            <button className="btn sm" onClick={clearActiveChat} disabled={!active || anyStreaming || active.turns.length === 0} title="清空当前对话">
              <Trash2 size={12} /> 清空
            </button>
          </div>
        </div>
        <div className="chat-target-strip">
          <div className="chat-strip-label"><Users size={13} /> 本轮目标</div>
          <div className="chat-target-chips">
            {targets.map((m) => (
              <span
                className={`chat-target-chip${m.transport === 'webview' ? ' is-webview' : ''}${webviewTarget === m.id ? ' active' : ''}`}
                key={m.id}
                onClick={m.transport === 'webview' ? () => {
                  setWebviewTarget((cur) => (cur === m.id ? null : m.id))
                } : undefined}
                title={m.transport === 'webview' ? (webviewTarget === m.id ? '关闭网页视图' : '点击查看该模型的网页对话记录') : undefined}
              >
                <ModelFavicon m={m} /><span>{m.displayName}</span>
                {m.transport === 'webview' && <ExternalLink size={10} className="chip-link-icon" />}
              </span>
            ))}
          </div>
          {targets.length === 0 && <span className="muted">请从左侧模型抽屉勾选参与者</span>}
        </div>
        <div className="chat-content-area">
          {targets.length === 0 ? (
            <div className="empty-card chat-empty-card">
              <Sparkles size={22} className="chat-empty-icon" />
              <h3>先选几个模型，再开始比较</h3>
              <p>从左侧模型抽屉勾选参与者。网页模型和 API 模型可以一起进行横向对比。</p>
            </div>
          ) : !active || active.turns.length === 0 ? (
            <div className="empty-card chat-empty-card ready">
              <Sparkles size={22} className="chat-empty-icon" />
              <h3>准备好了，问一个值得比较的问题</h3>
              <p className="muted">已连接 {targets.length} 个模型。回答会按轮次保留，方便追问和横向比较。</p>
              <div className="chat-hint-row"><span>Enter</span><em>发送问题</em><span>Shift + Enter</span><em>换行</em></div>
            </div>
          ) : (
            <div className="chat-turns" ref={turnsRef}>
              {active.turns.map((t) => (
                <TurnBlock
                  key={t.id}
                  turn={t}
                  models={models}
                  copiedKey={copiedKey}
                  onCopy={copyAnswer}
                  onRetry={(question) => setInput(question)}
                />
              ))}
            </div>
          )}

          {showAnchors && active && (
            <div className={`chat-anchors${!navPinned ? ' collapsed' : ''}`}>
              <div className="chat-anchors-list">
                {active.turns.map((t, i) => (
                  <button
                    key={t.id}
                    className={`chat-anchor${t.id === activeTurn ? ' active' : ''}`}
                    onClick={() => scrollToTurn(t.id)}
                    title={t.question}
                  >
                    <span className="ca-bar" />
                    <span className="ca-body">
                      <span className="ca-idx">{i + 1}/{active.turns.length}</span>
                      <span className="ca-text">{t.question}</span>
                    </span>
                  </button>
                ))}
              </div>
              <button
                className="chat-anchors-toggle"
                onClick={() => setNavPinned((v) => !v)}
                title={!navPinned ? '展开问题导航' : '收起问题导航'}
              >
                {!navPinned ? <Plus size={12} /> : <Minus size={12} />}
              </button>
            </div>
          )}
        </div>

        {targets.length > 0 && (
          <div className="chat-composer">
            <div className="chat-composer-row">
              <textarea
                className="chat-input"
                value={input}
                placeholder="输入问题，回车发送（Shift+Enter 换行）"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <button
                className="btn primary chat-send"
                onClick={() => void send()}
                disabled={anyStreaming || input.trim().length === 0}
                title="同时发送给所选模型"
              >
                {anyStreaming ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                发送
              </button>
            </div>
            <div className="chat-composer-foot">
              <button className="chat-sys-toggle" onClick={() => setShowSystem((v) => !v)}>
                <ChevronDown size={12} style={{ transform: showSystem ? 'rotate(180deg)' : 'none' }} />
                系统提示（可选）
              </button>
              <span className="chat-targets">目标：{targets.map((m) => m.displayName).join('、')}</span>
            </div>
            {showSystem && (
              <textarea
                className="chat-sys-input"
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
        {webviewNote && <div className="chat-webview-note">{webviewNote}</div>}
      </div>
      {webviewTarget && webviewTargetModel && (
        <aside className="chat-webview-slot">
          <WebviewDock
            model={webviewTargetModel}
            onClose={() => setWebviewTarget(null)}
            onRecheck={() => void recheckChatModel(webviewTargetModel.id)}
          />
        </aside>
      )}
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
        className="chat-avatar"
        onError={() => setIdx((p) => p + 1)}
      />
    )
  }
  return <span className="chat-avatar dot" style={{ background: m.color }} />
}

function TurnBlock({
  turn,
  models,
  copiedKey,
  onCopy,
  onRetry,
}: {
  turn: Turn
  models: ModelSummary[]
  copiedKey: string | null
  onCopy: (key: string, content: string) => void
  onRetry: (question: string) => void
}) {
  const order = Object.keys(turn.cells)
  const anyStreaming = order.some((id) => turn.cells[id]?.streaming)

  return (
    <div className="chat-turn" data-turn={turn.id}>
      <div className="chat-question">
        <span className="cq-text">{turn.question}</span>
        {anyStreaming && <Loader2 size={12} className="spin" />}
      </div>

      <div className="chat-grid">
        {order.map((id) => {
          const cell = turn.cells[id]!
          const m = models.find((x) => x.id === id)
          return (
            <ChatCard
              key={id}
              cell={cell}
              name={m?.displayName ?? id}
              transport={m?.transport}
              model={m ?? ({ id, displayName: id, color: '#888' } as ModelSummary)}
              copiedKey={copiedKey}
              copyKey={`${turn.id}:${id}`}
              thinkKey={`${turn.id}:${id}:think`}
              onCopy={onCopy}
              onRetry={() => onRetry(turn.question)}
            />
          )
        })}
      </div>
    </div>
  )
}

function ChatCard({
  cell,
  name,
  transport,
  model,
  copiedKey,
  copyKey,
  thinkKey,
  onCopy,
  onRetry,
}: {
  cell: AnswerCell
  name: string
  transport?: 'webview' | 'api'
  model: ModelSummary
  copiedKey: string | null
  copyKey: string
  thinkKey: string
  onCopy: (key: string, content: string) => void
  onRetry: () => void
}) {
  const [thinkOpen, setThinkOpen] = useState(false)
  const hasThinking = !!cell.thinking?.trim()

  return (
    <div className={`chat-card${cell.error ? ' has-error' : ''}${cell.streaming ? ' is-live' : ''}`}>
      <div className="chat-card-head">
        <ModelFavicon m={model} />
        <div className="chat-card-title">
          <b>{name}</b>
          <span>{transport === 'api' ? 'API' : '网页'}</span>
        </div>
        {cell.streaming ? (
          <span className="chat-live"><span className="state-pulse live" />生成中</span>
        ) : cell.error ? (
          <span className="chat-card-status error">需处理</span>
        ) : (
          <span className="chat-card-status">已完成</span>
        )}
      </div>

      {hasThinking && (
        <div className="chat-think">
          <button className="chat-think-toggle" onClick={() => setThinkOpen((v) => !v)}>
            <Brain size={11} />
            思考过程
            <ChevronDown size={11} className={`io-chevron${thinkOpen ? ' open' : ''}`} />
          </button>
          <button className="chat-card-action" onClick={() => onCopy(thinkKey, cell.thinking!)}>
            {copiedKey === thinkKey ? <Check size={11} /> : <Copy size={11} />}
            {copiedKey === thinkKey ? '已复制' : '复制'}
          </button>
          {thinkOpen && <pre className="chat-think-text">{cell.thinking}</pre>}
        </div>
      )}

      <div className="chat-card-body">
        {cell.error ? (
          <div className="chat-card-error">
            <AlertCircle size={14} />
            <div>
              <strong>{cell.error}</strong>
              <small>可重新发送本轮问题，或先打开该模型网页检查页面状态。</small>
            </div>
          </div>
        ) : cell.content ? (
          <span className="chat-card-text">{cell.content}</span>
        ) : (
          <span className="chat-card-pending muted">等待回答…</span>
        )}
      </div>

      <div className="chat-card-foot">
        <button
          className="chat-card-action"
          disabled={!cell.content}
          onClick={() => onCopy(copyKey, cell.content)}
        >
          {copiedKey === copyKey ? <Check size={11} /> : <Copy size={11} />}
          {copiedKey === copyKey ? '已复制' : '复制回答'}
        </button>
        {cell.error && (
          <button className="chat-card-action primary" onClick={onRetry}>
            <RotateCcw size={11} /> 重试本轮
          </button>
        )}
      </div>
    </div>
  )
}
