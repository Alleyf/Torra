/**
 * 编码工作台：把外面写好的编码智能体接进来，在一个地方说事。
 *
 * 这一屏的形状是照「agent 干活的工作台」来排的，不是照「设置里的一个面板」：
 * 左边是人和家（智能体与会话），中间是这一场做了什么，右边是改过的文件。
 * 标题栏里那一枚「外部智能体」的开关因此撤掉了 —— 一个工作台不该藏在抽屉里，
 * 关掉抽屉就看不见它改了哪些文件。
 *
 * 三条边界照旧画在界面上：
 * - 免掉全部授权的那一档不画（主进程也不发），免得看起来像「Torra 支持这个」；
 * - agent 反过来要授权时，选项照它给的列出来，Torra 不替用户选；
 * - 工具包挂不挂得上要说清为什么 —— 那是能力差异，不是这家 agent 坏了。
 *
 * 会话历史存在渲染层（见 ../agentSessions）：ACP 的子进程一退，协议层面就
 * 没有这一场了，四家里没有一家把对话留在外面。所以「上次那场」是 Torra 自己
 * 留下的行，只能看不能接着跑 —— 界面上照实说，并给一个在同一家上新开一场的出口。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Loader2,
  Plus,
  RotateCcw,
  ShieldCheck,
  Square,
  Terminal,
  Unplug,
  X,
} from 'lucide-react'
import { Markdown } from './Markdown'
import { RegistryEditor, dirLeaf } from './AgentRegistry'
import {
  applyAcpEvent,
  diffRows,
  groupAcpLines,
  sessionEdits,
  type AcpBlock,
  type AcpEdit,
  type AcpLine,
} from '../acpLines'
import {
  CWD_KEY,
  loadSessions,
  newSession,
  pruneLines,
  relTime,
  saveSessions,
  sessionTitle,
  upsertSession,
  type AgentSession,
} from '../agentSessions'
import '../agents.css'
import type {
  AcpAgentEntry,
  AcpCapabilities,
  AcpEventPayload,
  AcpListView,
  AcpMatrixStatus,
  AcpPermissionPayload,
  AcpPermissionRequest,
  AcpProbeResult,
  AcpSelectGroup,
} from '@shared/acp'
import { isBlockedAcpOption } from '@shared/acp'

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

let seq = 0
const uid = (): string => `${Date.now().toString(36)}-${(seq++).toString(36)}`

/**
 * 一家的标识：一枚带首字母的色块。
 *
 * 不画各家的官方图标 —— 那些商标不能当作 Torra 自己的资源分发，
 * 而首字母 + 家族色已经足够在侧栏里区分四家。
 */
const AGENT_HUE: Record<string, string> = {
  claude: '#c96442',
  codex: '#33383f',
  pi: '#55606e',
  opencode: '#2f6feb',
}

function AgentMark({ id, title, size = 28 }: { id: string; title?: string; size?: number }) {
  const letter =
    id === 'pi' ? 'π' : id === 'opencode' ? 'O' : (title?.trim()?.[0] ?? id[0] ?? '?').toUpperCase()
  return (
    <span
      className="agx-mark"
      style={{ ['--agx-hue' as string]: AGENT_HUE[id] ?? '#5b6470', width: size, height: size, fontSize: Math.round(size * 0.46) }}
      aria-hidden
    >
      {letter}
    </span>
  )
}

/** 「验过没有」：三档，跟矩阵同一口径（绿=整轮通过，中性=只测到握手，灰=没测） */
function statusOf(m?: AcpMatrixStatus): { cls: string; text: string } {
  if (!m) return { cls: 'none', text: '还没验过' }
  if (m.green) return { cls: 'ok', text: '已验过' }
  if (m.tested && m.cell?.handshake && m.cell?.session) return { cls: 'mid', text: '接得上' }
  return { cls: 'none', text: '还没验过' }
}

/** 预检结果压成一句话 */
function probeLine(r: AcpProbeResult): string {
  if (!r.ok) return `接不上：${r.verdict?.text ?? r.error ?? '未知原因'}${r.verdict?.hint ? ` · ${r.verdict.hint}` : ''}`
  const bits = [`接得上（${r.elapsedMs}ms）`]
  if (r.capabilities?.agentVersion) bits.push(`v${r.capabilities.agentVersion}`)
  if (r.capabilities?.toolPack) {
    bits.push(r.capabilities.toolPack.attached ? `工具包 ${r.capabilities.toolPack.tools} 个` : '工具包挂不上')
  }
  return bits.join(' · ')
}

/** 一个协商出来的档位：紧凑下拉，含义看它自己给的名字 */
function OptionChip({ group, onPick }: { group: AcpSelectGroup; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const current = group.options.find((o) => o.value === String(group.currentValue))
  const withheld = isBlockedAcpOption(String(group.currentValue ?? ''))
  if (group.options.length === 0) return null

  return (
    <div className={`agx-sel${open ? ' open' : ''}`} ref={boxRef}>
      <button
        type="button"
        className="agx-sel-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${group.name}：这一家自己给的档位，含义看它自己的说法`}
      >
        <span>{current?.name ?? group.name}</span>
        {withheld && <AlertTriangle size={10} className="agx-sel-warn" />}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="agx-pop up agx-sel-pop" role="listbox" aria-label={group.name}>
          <div className="agx-pop-title">{group.name}</div>
          {group.options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === String(group.currentValue)}
              className={`agx-pop-item${o.value === String(group.currentValue) ? ' active' : ''}`}
              onClick={() => {
                onPick(o.value)
                setOpen(false)
              }}
            >
              <span className="agx-pop-main">
                <b>{o.name}</b>
                {o.description ? <i>{o.description}</i> : null}
              </span>
              {o.value === String(group.currentValue) && <Check size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface LiveSession {
  sessionId: string
  entry: AcpAgentEntry
  caps: AcpCapabilities | null
  startedAt: number
  cwd?: string
}

// ---------------------------------------------------------------------------
// 工作台
// ---------------------------------------------------------------------------

export function AgentsPage() {
  const [list, setList] = useState<AcpListView | null>(null)
  const [sessions, setSessions] = useState<AgentSession[]>(() => loadSessions())
  const [live, setLive] = useState<LiveSession | null>(null)
  const [archive, setArchive] = useState<AgentSession | null>(null)
  const [lines, setLines] = useState<AcpLine[]>([])
  const [perm, setPerm] = useState<AcpPermissionRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [cwd, setCwd] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(CWD_KEY) ?? undefined
    } catch {
      return undefined
    }
  })
  const [pickId, setPickId] = useState<string>('claude')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [probing, setProbing] = useState<string | null>(null)
  const [agentNote, setAgentNote] = useState<Record<string, string>>({})
  const [banner, setBanner] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewPath, setReviewPath] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)

  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pickRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<LiveSession | null>(null)
  const nextId = useRef(0)
  const id = useCallback(() => ++nextId.current, [])

  const setLiveBoth = useCallback((v: LiveSession | null) => {
    liveRef.current = v
    setLive(v)
  }, [])

  // 注册表：内置四家 + 用户自己加的
  const reloadList = useCallback(async () => {
    const v = await window.torra.acpList()
    setList(v)
    // 已经挂着一家（比如切屏回来）：把身份摆出来，事件流还在主进程那边
    if (v.active && !liveRef.current) {
      const found = v.entries.find((e) => e.id === v.active!.agentId)
      if (found) {
        setLiveBoth({
          sessionId: uid(),
          entry: found,
          caps: v.active.capabilities,
          startedAt: Date.now(),
        })
      }
    }
    return v
  }, [setLiveBoth])

  useEffect(() => {
    void reloadList()
  }, [reloadList])

  // 事件流与授权请求
  useEffect(() => {
    const offEvent = window.torra.on('acp:event', (p) => {
      const payload = p as AcpEventPayload
      if (!payload?.event) return
      if (payload.agentId !== liveRef.current?.entry.id) return
      setLines((l) => applyAcpEvent(l, payload.event, id))
      if (payload.event.kind === 'settled' || payload.event.kind === 'error') setBusy(false)
      if (payload.event.kind === 'mode') {
        const optionId = payload.event.optionId
        const value = payload.event.value
        setLive((cur) =>
          cur?.caps
            ? {
                ...cur,
                caps: {
                  ...cur.caps,
                  selects: cur.caps.selects.map((s) => (s.id === optionId ? { ...s, currentValue: value } : s)),
                },
              }
            : cur,
        )
        if (liveRef.current) {
          liveRef.current = {
            ...liveRef.current,
            caps: liveRef.current.caps
              ? {
                  ...liveRef.current.caps,
                  selects: liveRef.current.caps.selects.map((s) =>
                    s.id === optionId ? { ...s, currentValue: value } : s,
                  ),
                }
              : liveRef.current.caps,
          }
        }
      }
    })
    const offPerm = window.torra.on('acp:permission', (p) => {
      const payload = p as AcpPermissionPayload
      if (!payload?.request) return
      if (liveRef.current && payload.agentId !== liveRef.current.entry.id) return
      setPerm(payload.request)
      setBusy(true)
    })
    return () => {
      offEvent()
      offPerm()
    }
  }, [id])

  // 会话落盘：流式文字每来一片都存一遍太糟，攒一下再写
  useEffect(() => {
    if (!live) return
    const t = window.setTimeout(() => {
      const { lines: kept, truncated } = pruneLines(lines)
      const record: AgentSession = {
        id: live.sessionId,
        agentId: live.entry.id,
        agentTitle: live.entry.title,
        title: sessionTitle(lines),
        cwd: live.cwd,
        createdAt: live.startedAt,
        updatedAt: Date.now(),
        lines: kept,
        truncated,
        live: true,
      }
      setSessions((prev) => {
        const next = upsertSession(prev, record)
        saveSessions(next)
        return next
      })
    }, 450)
    return () => window.clearTimeout(t)
  }, [lines, live])

  // 往下滚：视线跟着 agent 走，但用户往上翻的时候不要把他拽回来
  useEffect(() => {
    if (!atBottom) return
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, atBottom])

  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent) => {
      if (!pickRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  const activeLines = archive ? archive.lines : lines
  const blocks = useMemo(() => groupAcpLines(activeLines), [activeLines])
  const edits = useMemo(() => sessionEdits(activeLines), [activeLines])
  const shownEdits = useMemo(() => {
    // 审查面板打开时，选中的那一份得跟着改过文件走：上一次选的那个可能已经不在列表里
    const hit = edits.find((e) => e.path === reviewPath)
    return hit ?? edits[edits.length - 1] ?? null
  }, [edits, reviewPath])

  useEffect(() => {
    if (edits.length === 0) setReviewOpen(false)
  }, [edits.length])

  const entryById = useCallback(
    (agentId: string): AcpAgentEntry | null => list?.entries.find((e) => e.id === agentId) ?? null,
    [list],
  )
  const pickEntry = entryById(pickId) ?? list?.entries[0] ?? null
  const entry = live?.entry ?? null
  const caps = live?.caps ?? null
  const groups = (caps?.selects ?? []).filter((g) => g.options.length > 0)

  /** 把挂着的那一家送走，并把会话在库里标成已结束 */
  const stopLive = useCallback(async () => {
    const cur = liveRef.current
    if (!cur) return
    await window.torra.acpStop()
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === cur.sessionId ? { ...s, live: false } : s))
      saveSessions(next)
      return next
    })
    setLiveBoth(null)
    setPerm(null)
    setBusy(false)
  }, [setLiveBoth])

  const startAgent = useCallback(
    async (e: AcpAgentEntry): Promise<boolean> => {
      if (liveRef.current) await stopLive()
      setConnecting(e.id)
      setAgentNote((n) => ({ ...n, [e.id]: '' }))
      const r = await window.torra.acpStart(e.id, cwd)
      setConnecting(null)
      if (!r.ok) {
        const v = r.verdict
        setAgentNote((n) => ({ ...n, [e.id]: v ? `${v.text}${v.hint ? ` · ${v.hint}` : ''}` : (r.error ?? '接不上这一家') }))
        return false
      }
      const next: LiveSession = {
        sessionId: uid(),
        entry: e,
        caps: r.capabilities ?? null,
        startedAt: Date.now(),
        cwd,
      }
      setLiveBoth(next)
      setLines([])
      setArchive(null)
      setPerm(null)
      setBusy(false)
      setBanner(null)
      setSessions((prev) => {
        const rec = newSession(next.sessionId, e.id, e.title, cwd, next.startedAt)
        rec.live = true
        const out = upsertSession(prev, rec)
        saveSessions(out)
        return out
      })
      // 工具包挂不上要说清：不是这家人坏了，是它不收 http 形态的 MCP
      if (r.capabilities?.toolPack && !r.capabilities.toolPack.attached) {
        setBanner(r.capabilities.toolPack.reason ?? '这一家不收 Torra 的工具包，它只能用自己的工具干活。')
      }
      return true
    },
    [cwd, setLiveBoth, stopLive],
  )

  const newChat = useCallback(async () => {
    await stopLive()
    setLines([])
    setArchive(null)
    setPerm(null)
    setDraft('')
    setBanner(null)
    setReviewOpen(false)
    inputRef.current?.focus()
  }, [stopLive])

  const openSession = useCallback(
    async (s: AgentSession) => {
      if (liveRef.current?.sessionId === s.id) {
        setArchive(null)
        return
      }
      await stopLive()
      setArchive(s)
      setPerm(null)
      setReviewOpen(false)
    },
    [stopLive],
  )

  const probe = useCallback(async (e: AcpAgentEntry) => {
    setProbing(e.id)
    const r = await window.torra.acpProbe(e.id, cwd)
    setProbing(null)
    setAgentNote((n) => ({ ...n, [e.id]: probeLine(r) }))
  }, [cwd])

  const pickDir = useCallback(async () => {
    const r = await window.torra.acpPickDir()
    if (r.ok && r.path) {
      setCwd(r.path)
      try {
        localStorage.setItem(CWD_KEY, r.path)
      } catch {
        // 存不下不影响这一场：目录照样传给 agent
      }
    }
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || archive) return
    let cur = liveRef.current
    if (!cur) {
      const e = pickEntry
      if (!e) return
      const ok = await startAgent(e)
      if (!ok) return
      cur = liveRef.current
      if (!cur) return
    }
    setDraft('')
    setLines((l) => [...l, { id: id(), kind: 'user', text }])
    // 会话名当场就改：侧栏跟着第一句走，不能等攒稿那一步 ——
    // 流式期间每来一片都会把攒稿的定时器往后推，名字能拖到整轮结束才变。
    const sid = cur.sessionId
    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === sid ? { ...s, title: sessionTitle([{ id: 0, kind: 'user', text }]), updatedAt: Date.now() } : s,
      )
      saveSessions(next)
      return next
    })
    setBusy(true)
    setAtBottom(true)
    const r = await window.torra.acpPrompt(text)
    if (!r.ok) {
      setBusy(false)
      setLines((l) => [...l, { id: id(), kind: 'error', text: r.error ?? '没送出去' }])
    }
  }, [archive, draft, id, pickEntry, startAgent])

  const respond = useCallback(
    async (optionId: string | null) => {
      if (!perm) return
      const pid = perm.id
      setPerm(null)
      await window.torra.acpRespondPermission(pid, optionId ? { optionId } : { optionId: null, reason: '用户拒绝了这一步' })
    },
    [perm],
  )

  const pickOption = useCallback(async (groupId: string, value: string) => {
    const r = await window.torra.acpSetOption(groupId, value)
    if (!r.ok) return
    const patch = (c: AcpCapabilities | null) =>
      c ? { ...c, selects: c.selects.map((s) => (s.id === groupId ? { ...s, currentValue: value } : s)) } : c
    setLive((cur) => (cur ? { ...cur, caps: patch(cur.caps) } : cur))
    if (liveRef.current) liveRef.current = { ...liveRef.current, caps: patch(liveRef.current.caps) }
  }, [])

  const status = live ? (busy ? '正在干活' : '就绪') : archive ? '已结束' : '未连接'
  const totalAdded = edits.reduce((n, e) => n + e.added, 0)
  const totalRemoved = edits.reduce((n, e) => n + e.removed, 0)
  const title = archive ? archive.title : live ? sessionTitle(lines) : '编码工作台'
  // 这一家自己给了「拒绝」就别再补一个：并排两个拒绝，没人知道该按哪个。
  // 补的那个只在它没给的时候出现 —— 用户总得有一条退路。
  const rejectOffered =
    !!perm && perm.options.some((o) => /reject|deny/i.test(o.kind) || /reject|deny/i.test(o.optionId))

  return (
    <div className="agx">
      {/* 左：智能体与会话 */}
      <aside className="agx-rail" aria-label="智能体与会话">
        <div className="agx-rail-top">
          <div className="agx-rail-brand">
            <Terminal size={14} />
            <b>编码工作台</b>
          </div>
          <button className="agx-icon-btn" onClick={() => void newChat()} title="新的一场" aria-label="新的一场">
            <Plus size={15} />
          </button>
        </div>

        <div className="agx-rail-scroll">
          <div className="agx-group">智能体</div>
          {list?.entries.map((e) => {
            const st = statusOf(list.matrix?.[e.id])
            const isLive = live?.entry.id === e.id
            return (
              <div key={e.id} className={`agx-agent${isLive ? ' live' : ''}`}>
                <button
                  type="button"
                  className="agx-agent-main"
                  onClick={() => void startAgent(e)}
                  disabled={connecting === e.id}
                  title={`${e.blurb}${e.notes.length ? `\n${e.notes.join('\n')}` : ''}`}
                >
                  <AgentMark id={e.id} title={e.title} size={26} />
                  <span className="agx-agent-text">
                    <b>{e.title}</b>
                    <i>{isLive ? (busy ? '正在干活' : '就绪') : e.source === 'user' ? '自定义' : st.text}</i>
                  </span>
                  {connecting === e.id ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    <span className={`agx-dot ${st.cls}${isLive ? ' on' : ''}`} title={st.text} />
                  )}
                </button>
                <button
                  type="button"
                  className="agx-icon-btn sm"
                  title="预检（不送话，只看能不能接上）"
                  aria-label={`预检 ${e.title}`}
                  onClick={() => void probe(e)}
                >
                  {probing === e.id ? <Loader2 size={11} className="spin" /> : <RotateCcw size={11} />}
                </button>
              </div>
            )
          })}
          {list?.entries.map((e) =>
            agentNote[e.id] ? (
              <p key={`n-${e.id}`} className={`agx-agent-note${/接不上|没挂|不对/.test(agentNote[e.id]!) ? ' bad' : ''}`}>
                {agentNote[e.id]}
              </p>
            ) : null,
          )}
          {list?.problems.map((p, i) => (
            <p key={`p-${i}`} className="agx-agent-note bad">
              {p}
            </p>
          ))}
          <RegistryEditor onSaved={() => void reloadList()} />

          <div className="agx-group">会话</div>
          {sessions.length === 0 && <p className="agx-empty-line">还没有会话。选一家，把要做的事说清楚。</p>}
          {sessions.map((s) => {
            const on = live?.sessionId === s.id ? !archive : archive?.id === s.id
            return (
              <button
                key={s.id}
                type="button"
                className={`agx-session${on ? ' on' : ''}`}
                onClick={() => void openSession(s)}
                title={s.cwd ? `工作目录：${s.cwd}` : undefined}
              >
                <AgentMark id={s.agentId} title={s.agentTitle} size={20} />
                <span className="agx-session-text">
                  <b>{s.title}</b>
                  <i>
                    {s.agentTitle} · {relTime(s.updatedAt)}
                    {s.live ? ' · 进行中' : ''}
                  </i>
                </span>
                {s.live && <span className="agx-dot ok on" />}
              </button>
            )
          })}
        </div>
      </aside>

      {/* 中：这一场 */}
      <section className="agx-main">
        <header className="agx-top">
          <div className="agx-top-title">
            {entry || archive ? (
              <>
                <AgentMark id={entry?.id ?? archive!.agentId} title={entry?.title ?? archive?.agentTitle} size={26} />
                <div>
                  <b>{title}</b>
                  <span>
                    {entry?.title ?? archive?.agentTitle} · {status}
                    {cwd ? ` · ${dirLeaf(cwd)}` : ''}
                  </span>
                </div>
              </>
            ) : (
              <div>
                <b>编码工作台</b>
                <span>接一家外部写好的编码智能体，在你看得见的地方干活</span>
              </div>
            )}
          </div>
          <div className="agx-top-right">
            {caps?.toolPack && (
              <span className={`agx-chip${caps.toolPack.attached ? '' : ' warn'}`} title={caps.toolPack.reason ?? 'Torra 的工具包已挂上'}>
                {caps.toolPack.attached ? `工具包 ${caps.toolPack.tools}` : '工具包未挂'}
              </span>
            )}
            {edits.length > 0 && (
              <button
                type="button"
                className={`agx-chip btn${reviewOpen ? ' on' : ''}`}
                onClick={() => setReviewOpen((v) => !v)}
              >
                审查 {edits.length} 个文件
                <span className="agx-add">+{totalAdded}</span>
                <span className="agx-del">−{totalRemoved}</span>
              </button>
            )}
            {live && (
              <button type="button" className="agx-icon-btn" onClick={() => void stopLive()} title="送走这一家" aria-label="送走这一家">
                <Unplug size={14} />
              </button>
            )}
          </div>
        </header>

        <div
          className="agx-thread"
          ref={threadRef}
          onScroll={() => {
            const el = threadRef.current
            if (!el) return
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
          }}
        >
          {blocks.length === 0 && !archive ? (
            <div className="agx-welcome">
              <div className="agx-welcome-mark">
                <AgentMark id={pickEntry?.id ?? 'claude'} title={pickEntry?.title} size={44} />
              </div>
              <h2>
                你想让 {pickEntry?.title ?? '编码智能体'} 做点什么？
              </h2>
              <p>
                {cwd ? `它会在 ${dirLeaf(cwd)} 里干活。` : '先选一个工作目录，它只能碰那个目录里的文件。'}
                每一步做了什么、改了哪些文件，都留在这场会话里。
              </p>
              <div className="agx-cards">
                {[
                  { t: '探索并理解代码', d: '把这个目录的结构与关键路径讲清楚', p: '先把这个目录的结构理一遍，讲清楚入口、主要模块和它们之间的调用关系。' },
                  { t: '构建新功能', d: '从一句话到能跑的改动', p: '帮我实现一个新功能：' },
                  { t: '审查代码并提修改', d: '看改动、找风险、给具体建议', p: '审查当前工作区里的改动，指出风险并给出具体改法。' },
                  { t: '修复问题和失败', d: '复现、定位、修掉', p: '有一个问题需要修：' },
                ].map((c) => (
                  <button
                    key={c.t}
                    type="button"
                    className="agx-card"
                    onClick={() => {
                      setDraft(c.p)
                      inputRef.current?.focus()
                    }}
                  >
                    <b>{c.t}</b>
                    <span>{c.d}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="agx-thread-inner">
              {blocks.map((b, i) => {
                const prev = blocks[i - 1]
                const head = prev && prev.kind === 'user' && b !== prev
                const agentId = (archive?.agentId ?? live?.entry.id) ?? 'x'
                const agentTitle = archive?.agentTitle ?? live?.entry.title ?? '智能体'
                return (
                  <div key={i} className="agx-turn">
                    {head && b.kind !== 'user' && (
                      <div className="agx-turn-head">
                        <AgentMark id={agentId} title={agentTitle} size={20} />
                        <b>{agentTitle}</b>
                      </div>
                    )}
                    <AcpBlockView block={b} live={busy && i === blocks.length - 1} onReview={(p) => {
                      setReviewPath(p)
                      setReviewOpen(true)
                    }} />
                  </div>
                )
              })}
              {busy && !perm && (
                <div className="agx-working">
                  <span className="agx-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  这一家正在干活…
                </div>
              )}
              {archive && (
                <div className="agx-archived">
                  <b>这一场已经结束了</b>
                  <span>
                    ACP 的子进程退出后，这一家在协议层面就没有这一场了；上面是 Torra 当时留下的记录
                    {archive.truncated ? '（更早的内容没有留下）' : ''}。
                  </span>
                  <button
                    type="button"
                    className="agx-btn primary"
                    onClick={() => {
                      const e = entryById(archive.agentId)
                      if (e) void startAgent(e)
                    }}
                  >
                    在 {archive.agentTitle} 上新开一场
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {banner && (
          <div className="agx-banner">
            <AlertTriangle size={12} />
            <span>{banner}</span>
            <button type="button" className="agx-icon-btn sm" onClick={() => setBanner(null)} aria-label="知道了">
              <X size={11} />
            </button>
          </div>
        )}

        {perm && (
          <div className="agx-perm" role="alertdialog" aria-label={perm.title}>
            <div className="agx-perm-head">
              <span className="agx-perm-kind">
                <ShieldCheck size={11} />
                这一家要你点头
              </span>
              <b>{perm.title}</b>
            </div>
            {perm.rawInput != null && <pre className="agx-perm-detail">{safeJson(perm.rawInput)}</pre>}
            <div className="agx-perm-actions">
              {perm.options
                .filter((o) => o.optionId)
                .map((o) => (
                  <button
                    key={o.optionId}
                    type="button"
                    className={`agx-btn${/reject|deny/i.test(o.optionId) ? ' danger' : ' primary'}`}
                    onClick={() => void respond(o.optionId)}
                  >
                    {o.name}
                  </button>
                ))}
              {!rejectOffered && (
                <button type="button" className="agx-btn" onClick={() => void respond(null)}>
                  拒绝
                </button>
              )}
            </div>            <div className="agx-perm-foot">选项是这一家自己给的，Torra 不替你挑；不点就一直等着。</div>
          </div>
        )}

        <div className="agx-composer">
          <div className="agx-input">
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              disabled={!!archive}
              placeholder={
                archive ? '这一场已经结束 · 上面可以把同一家重新开一场' : busy ? '它还在忙；要打断就点右边的方块' : '把这一轮要做的事说清楚 · Enter 送出'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <div className="agx-bar">
              <button
                type="button"
                className="agx-dir"
                onClick={() => void pickDir()}
                disabled={!!live}
                title={
                  live
                    ? '这一场开始时就定了 —— 要换目录，开新的一场'
                    : cwd
                      ? `工作目录：${cwd}`
                      : '选一个给 agent 用的工作目录（它能碰哪些文件由这个目录决定）'
                }
              >
                <FolderOpen size={13} />
                {cwd ? dirLeaf(cwd) : '选工作目录'}
              </button>

              <div className="agx-bar-mid">
                {groups.map((g) => (
                  <OptionChip key={g.id} group={g} onPick={(v) => void pickOption(g.id, v)} />
                ))}
              </div>

              <div className="agx-agentpick-wrap" ref={pickRef}>
                <button
                  type="button"
                  className="agx-agentpick"
                  onClick={() => setPickerOpen((v) => !v)}
                  aria-expanded={pickerOpen}
                  title="换一家（同一时刻只挂一家，换之前会先把上一家送走）"
                >
                  <AgentMark id={entry?.id ?? pickEntry?.id ?? 'claude'} title={entry?.title ?? pickEntry?.title} size={16} />
                  <span>{entry?.title ?? pickEntry?.title ?? '选一家'}</span>
                  <ChevronUp size={12} className={`agx-caret${pickerOpen ? ' up' : ''}`} />
                </button>
                {pickerOpen && (
                  <div className="agx-pop up agx-pick-pop" role="menu" aria-label="选一家智能体">
                    <div className="agx-pop-title">换一家</div>
                    {list?.entries.map((e) => {
                      const on = (entry?.id ?? pickEntry?.id) === e.id
                      return (
                        <button
                          key={e.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={on}
                          className={`agx-pop-item${on ? ' active' : ''}`}
                          onClick={() => {
                            setPickerOpen(false)
                            setPickId(e.id)
                            if (live) void startAgent(e)
                          }}
                        >
                          <AgentMark id={e.id} title={e.title} size={18} />
                          <span className="agx-pop-main">
                            <b>{e.title}</b>
                            <i>{statusOf(list.matrix?.[e.id]).text}</i>
                          </span>
                          {on && <Check size={12} />}
                        </button>
                      )
                    })}
                    <div className="agx-pop-foot">换一家会先把当前这一家送走；会话记录留在左边。</div>
                  </div>
                )}
              </div>

              {busy ? (
                <button
                  type="button"
                  className="agx-send stop"
                  onClick={() => void window.torra.acpCancel()}
                  title="打断当前这一轮"
                  aria-label="打断"
                >
                  <Square size={12} />
                </button>
              ) : (
                <button
                  type="button"
                  className="agx-send"
                  disabled={!!archive || !draft.trim()}
                  onClick={() => void send()}
                  title="送出（Enter）"
                  aria-label="送出"
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
          <div className="agx-composer-foot">
            {live ? '同一时刻只挂一家 · 它要动手前会先问你' : '先说清楚要做什么；第一次送出时会把这家的进程拉起来'}
          </div>
        </div>
      </section>

      {/* 右：改过的文件 */}
      {reviewOpen && shownEdits && (
        <aside className="agx-review" aria-label="审查改动">
          <header className="agx-review-head">
            <b>审查</b>
            <span>
              {edits.length} 个文件 · <span className="agx-add">+{totalAdded}</span>{' '}
              <span className="agx-del">−{totalRemoved}</span>
            </span>
            <button type="button" className="agx-icon-btn sm" onClick={() => setReviewOpen(false)} aria-label="收起审查">
              <X size={13} />
            </button>
          </header>
          <div className="agx-files">
            {edits.map((e) => (
              <button
                key={e.path}
                type="button"
                className={`agx-file${e.path === shownEdits.path ? ' on' : ''}`}
                onClick={() => setReviewPath(e.path)}
                title={e.path}
              >
                <span className="agx-file-name">{e.path.split(/[\\/]/).pop()}</span>
                <span className="agx-file-dir">{e.path.split(/[\\/]/).slice(0, -1).join('/')}</span>
                <span className="agx-add">+{e.added}</span>
                <span className="agx-del">−{e.removed}</span>
              </button>
            ))}
          </div>
          <DiffView edit={shownEdits} />
        </aside>
      )}
    </div>
  )
}

/** 一块内容：用户那句 / 正文 / 步骤组 / 单行 */
function AcpBlockView({
  block,
  live,
  onReview,
}: {
  block: AcpBlock
  live: boolean
  onReview: (path: string) => void
}) {
  if (block.kind === 'user') {
    return (
      <div className="agx-user">
        {block.lines.map((l) => (
          <div key={l.id} className="agx-user-text">
            {(l as Extract<AcpLine, { kind: 'user' }>).text}
          </div>
        ))}
      </div>
    )
  }
  if (block.kind === 'say') {
    return (
      <div className={`agx-say${live ? ' live' : ''}`}>
        {block.lines.map((l) => (
          <Markdown key={l.id} text={(l as Extract<AcpLine, { kind: 'say' }>).text} streaming={live} />
        ))}
      </div>
    )
  }
  if (block.kind === 'steps') {
    const tools = block.lines.filter((l): l is Extract<AcpLine, { kind: 'tool' }> => l.kind === 'tool')
    const running = tools.some((l) => l.running)
    const bad = tools.some((l) => l.status === 'failed')
    const thinks = block.lines.filter((l) => l.kind === 'think').length
    const changed = tools.flatMap((l) => l.edits ?? [])
    return (
      <div className="agx-steps-wrap">
        <details className={`agx-steps${running ? ' running' : ''}${bad ? ' bad' : ''}`} open={running || undefined}>
          <summary>
            <ChevronDown size={12} className="agx-chev" />
            <span className="agx-steps-ic">
              {running ? <Loader2 size={11} className="spin" /> : bad ? <AlertTriangle size={11} /> : <Check size={11} />}
            </span>
            <span className="agx-steps-title">{running ? '正在执行' : bad ? '有一步没通过' : '执行完成'}</span>
            <span className="agx-steps-meta">
              {tools.length} 步{thinks > 0 ? ` · 思考 ${thinks}` : ''}
            </span>
          </summary>
          <div className="agx-steps-list">
            {block.lines.map((l) => {
              if (l.kind === 'think') {
                return (
                  <div key={l.id} className="agx-step think">
                    <span className="agx-step-ic">
                      <ChevronDown size={10} />
                    </span>
                    <span className="agx-step-out">{l.text}</span>
                  </div>
                )
              }
              if (l.kind !== 'tool') return null
              return (
                <div key={l.id} className={`agx-step${l.running ? ' running' : ''}${l.status === 'failed' ? ' bad' : ''}`}>
                  <span className="agx-step-ic">
                    {l.running ? <Loader2 size={11} className="spin" /> : l.status === 'failed' ? <X size={11} /> : <Check size={11} />}
                  </span>
                  <span className="agx-step-name">{l.title}</span>
                  {l.status && l.status !== 'pending' && <span className="agx-step-tag">{l.status}</span>}
                  {l.out && l.edits?.length ? null : l.out ? <span className="agx-step-out">{oneLine(l.out)}</span> : null}
                </div>
              )
            })}
          </div>
        </details>
        {changed.length > 0 && <EditCard edits={changed} onReview={onReview} />}
      </div>
    )
  }
  const line = block.line
  if (line.kind === 'plan') {
    return (
      <div className="agx-note">
        {line.entries.map((e, j) => (
          <div key={j} className={`agx-plan-item ${e.status}`}>
            <span className="agx-plan-dot" />
            {e.content}
          </div>
        ))}
      </div>
    )
  }
  if (line.kind === 'error') {
    return (
      <div className="agx-alert">
        <AlertTriangle size={12} />
        <span>{line.text}</span>
      </div>
    )
  }
  if (line.kind === 'tally') return <div className="agx-tally">{line.text}</div>
  if (line.kind === 'notice') return <div className="agx-note">{line.text}</div>
  return null
}

/** 一步里改过的文件：汇总成一张卡，点「审查」看原文 */
function EditCard({ edits, onReview }: { edits: AcpEdit[]; onReview: (path: string) => void }) {
  const added = edits.reduce((n, e) => n + e.added, 0)
  const removed = edits.reduce((n, e) => n + e.removed, 0)
  return (
    <div className="agx-editcard">
      <div className="agx-editcard-head">
        <b>已编辑 {edits.length} 个文件</b>
        <span className="agx-add">+{added}</span>
        <span className="agx-del">−{removed}</span>
        <button type="button" className="agx-btn sm" onClick={() => onReview(edits[edits.length - 1]!.path)}>
          审查
        </button>
      </div>
      {edits.map((e) => (
        <button key={e.path} type="button" className="agx-editrow" onClick={() => onReview(e.path)} title={e.path}>
          <span>{e.path.split(/[\\/]/).pop()}</span>
          <span className="agx-add">+{e.added}</span>
          <span className="agx-del">−{e.removed}</span>
        </button>
      ))}
    </div>
  )
}

/** 改前改后的对照。行号两边各数各的，删的行不留新号、增的行不留旧号 */
function DiffView({ edit }: { edit: AcpEdit }) {
  const rows = useMemo(() => diffRows(edit.oldText, edit.newText), [edit])
  let oldNo = 0
  let newNo = 0
  return (
    <div className="agx-diff">
      <div className="agx-diff-head" title={edit.path}>
        <span>{edit.path}</span>
        <span className="agx-add">+{edit.added}</span>
        <span className="agx-del">−{edit.removed}</span>
      </div>
      <div className="agx-diff-body">
        {rows.length === 0 && <div className="agx-diff-empty">两边都是空的</div>}
        {rows.map((r, i) => {
          if (r.t !== '+') oldNo++
          if (r.t !== '-') newNo++
          return (
            <div key={i} className={`agx-diff-row ${r.t === ' ' ? 'same' : r.t === '-' ? 'del' : 'add'}`}>
              <span className="agx-ln">{r.t === '+' ? '' : oldNo}</span>
              <span className="agx-ln">{r.t === '-' ? '' : newNo}</span>
              <span className="agx-sign">{r.t === ' ' ? ' ' : r.t}</span>
              <span className="agx-code">{r.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 工具结果压成一行：步骤行里只放得下一句 */
function oneLine(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 160 ? `${one.slice(0, 160)}…` : one
}

/** agent 给的入参：可能是任意 JSON，截一段给人看，别把整屏塞满 */
function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v, null, 1) ?? ''
    return s.length > 800 ? `${s.slice(0, 800)}…` : s
  } catch {
    return String(v)
  }
}
