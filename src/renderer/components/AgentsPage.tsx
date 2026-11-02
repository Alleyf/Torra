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
 * 这一版起，界面上画的东西是 **Host 账本**（见 @shared/host），不是协议事件。
 * 差别在「恢复」上：协议事件是一片一片来的增量，而恢复一场旧会话时
 * 只有一份整的账本可画。合并规则因此挪到了 shared 里，主进程与渲染层共用一份。
 *
 * 真源在 agent 那边：Torra 存的那份只是一份索引（哪一家、哪一场、能不能接着聊），
 * 外加一份兜底正文 —— 只有在「这一家压根读不回历史」时，那份兜底才是唯一的一份。
 * 所以归档的那一场能接着聊时，界面上给的是「接着聊」，不是「重新开一场」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDashed,
  Fingerprint,
  FolderOpen,
  GitBranch,
  Info,
  KeyRound,
  Loader2,
  Package,
  Plug,
  Plus,
  RotateCcw,
  ShieldCheck,
  Square,
  Table2,
  Terminal,
  Unplug,
  X,
} from 'lucide-react'
import { Markdown } from './Markdown'
import { UserEntries, dirLeaf } from './AgentRegistry'
import { AgentCatalogPanel } from './AgentCatalog'
import { WorkTreePanel, type TreeMode, type WorkTreeHandle } from './WorkTreePanel'
import { buildWorkTree, demoTrees, diffNodes, planFlights, type WorkNode, type WorkTree } from '../workTree'
import { createLightLayer, type LightLayer } from '../lancerLight'
import {
  diffRows,
  groupAcpLines,
  linesFromItems,
  sessionEdits,
  sessionTouches,
  type AcpBlock,
  type AcpEdit,
  type AcpLine,
} from '../acpLines'
import {
  CWD_KEY,
  canResume,
  loadSessions,
  newSession,
  pruneItems,
  relTime,
  saveSessions,
  sessionTitle,
  upsertSession,
  type AgentSession,
} from '../agentSessions'
import { AgentMark, agentLook } from '../agentMarks'
import '../agents.css'
import type {
  AcpAgentEntry,
  AcpAuthMethod,
  AcpCapabilities,
  AcpListView,
  AcpMatrixCell,
  AcpMatrixStatus,
  AcpPermissionPayload,
  AcpPermissionRequest,
  AcpProbeResult,
  AcpSelectGroup,
} from '@shared/acp'
import { isBlockedAcpOption } from '@shared/acp'
import { applyHostEvent, type HostEventPayload, type HostItem } from '@shared/host'

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

let seq = 0
const uid = (): string => `${Date.now().toString(36)}-${(seq++).toString(36)}`

/** 节点 id 里有冒号；塞进属性选择器时引号与反斜杠要转义 */
const cssAttr = (s: string): string => s.replace(/["\\]/g, '\\$&')

// 一家的标识（官方标记 + 家族色）住在 @renderer/agentMarks ——
// 侧栏、输入坞、回合头、正中央那枚，都是同一枚。

/**
 * 「验过没有」：三档，跟矩阵同一口径（绿=整轮通过，中性=只测到握手，灰=没测）。
 *
 * title 那一栏是把这句话讲成人话：光一颗点子说不清「没量」和「不行」的差别，
 * 悬停一下得能读出是哪一种 —— 用户不能靠猜。
 */
function statusOf(m?: AcpMatrixStatus): { cls: string; text: string; title: string } {
  if (!m) {
    return { cls: 'none', text: '还没验过', title: '这一家还没进过兼容矩阵：Torra 没量过它，接之前先预检。' }
  }
  if (m.green) {
    return {
      cls: 'ok',
      text: '已验过',
      title: `整轮实测通过${m.cell?.checkedAt ? `（${m.cell.checkedAt}）` : ''}：握手、建会话、发一轮、打断都通了`,
    }
  }
  if (m.tested && m.cell?.handshake && m.cell?.session) {
    const full = m.cell.full === true
    return {
      cls: 'mid',
      text: '接得上',
      title: full
        ? `握手与建会话实测通过，但整轮里有几步没过${m.cell.checkedAt ? `（${m.cell.checkedAt}）` : ''}`
        : `只测到握手与建会话，后面的步骤这次没量过 —— 不是不行，是没测${m.cell.checkedAt ? `（${m.cell.checkedAt}）` : ''}`,
    }
  }
  return {
    cls: 'none',
    text: '还没验过',
    title: m.reason ? `这一家还没量过：${m.reason}` : '这一家还没进过兼容矩阵：Torra 没量过它。',
  }
}

/**
 * 一项能力是三档，不是两档。
 *
 * 「没测」与「没过」长得不一样，是这张表最要紧的一件事：前者是这次没花钱去量，
 * 后者是这一家真的不行。混起来等于把「没量」写成「不行」。
 */
function capVerdict(passed: boolean, full: boolean): { cls: string; word: string; hint: string } {
  if (passed) return { cls: 'ok', word: '通过', hint: '量过了，通过' }
  if (full) return { cls: 'bad', word: '没过', hint: '量过了，没通过' }
  return { cls: 'none', word: '没测', hint: '这一轮没跑到这一项 —— 是没量，不是不行' }
}

/** 六项能力：名字照用户看得懂的说法，顺序就是一轮走下来的顺序 */
const MATRIX_CAPS = [
  { key: 'handshake', label: '握手' },
  { key: 'session', label: '建会话' },
  { key: 'prompt', label: '发一轮' },
  { key: 'cancel', label: '打断' },
  { key: 'permission', label: '授权' },
  { key: 'toolPack', label: '工具包' },
] as const satisfies ReadonlyArray<{ key: keyof AcpMatrixCell; label: string }>

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
  /** agent 那边的会话号：跨重启稳定的那一个，「接着聊」靠它 */
  nativeSessionId?: string
  /**
   * 这一场的正文归这一家管着。
   *
   * 读回历史验过之后就归它了：Torra 不再留第二份正文。留两份迟早分叉，
   * 而分叉的那一份最后会被当成真的 —— 用户看到的就不是 agent 那边的事实。
   */
  harnessOwned?: boolean
}

// ---------------------------------------------------------------------------
// 工作台
// ---------------------------------------------------------------------------

export function AgentsPage() {
  const [list, setList] = useState<AcpListView | null>(null)
  const [sessions, setSessions] = useState<AgentSession[]>(() => loadSessions())
  const [live, setLive] = useState<LiveSession | null>(null)
  const [archive, setArchive] = useState<AgentSession | null>(null)
  /** 眼前这一场的账本：Host 条目，界面从它画出一行行 */
  const [items, setItems] = useState<HostItem[]>([])
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
  const [resuming, setResuming] = useState<string | null>(null)
  const [agentNote, setAgentNote] = useState<Record<string, string>>({})
  /**
   * 每一家协议报上来的登录方式。
   *
   * 只装协议给的东西：没给就不画这一栏。拿兜底文案填上去，
   * 等于让用户以为协议说了话 —— 而它没有。
   */
  const [agentAuth, setAgentAuth] = useState<Record<string, AcpAuthMethod[]>>({})
  const [banner, setBanner] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewPath, setReviewPath] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  /** 兼容矩阵摊开着没有：默认收着，工作台首屏不能变样 */
  const [matrixOpen, setMatrixOpen] = useState(false)
  /** 目录摊开着没有：接一家新的，从目录里点一下 */
  const [catalogOpen, setCatalogOpen] = useState(false)

  /**
   * 右侧那栏：会话工作树。
   *
   * 默认开着 —— 这是「看得到 agent 在往哪走」的地方，不是调试面板。
   * 但它跟「审查」不能同时占右边：两栏一起摆，1280 的窗口里正文只剩两百来像素。
   * 所以审查开着的时候，工作树让位（不是拆掉，关掉审查就回来）。
   */
  const [treeOpen, setTreeOpen] = useState(true)
  const [treeMode, setTreeMode] = useState<TreeMode>('focus')
  const [treeFollow, setTreeFollow] = useState(true)
  /** 演示树：默认不开。开了面板上会明说这是摆出来的，不是真跑过 */
  const [treeDemo, setTreeDemo] = useState(false)
  /** 这一场出过事（进程退了、连接断了）：还在跑的节点要标成失败 */
  const [faulted, setFaulted] = useState(false)

  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pickRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<LiveSession | null>(null)
  const matrixToggleRef = useRef<HTMLButtonElement>(null)
  const catalogToggleRef = useRef<HTMLButtonElement>(null)
  /** 光线层：铺在 .agx 上，节点和气泡都由它来量坐标 */
  const glowRef = useRef<SVGSVGElement | null>(null)
  const layerRef = useRef<LightLayer | null>(null)
  const treeRef = useRef<WorkTreeHandle | null>(null)
  /** 上一次的节点表：光线只认差，重渲染不该再放一遍光 */
  const prevNodes = useRef<WorkNode[]>([])
  /** 这一批 items 是整体换上的（切会话、读回历史）：只对基线，不发光 */
  const hydrating = useRef(false)

  /** 打开矩阵：记住来处，关上时把焦点还回去 */
  const openMatrix = useCallback(() => setMatrixOpen(true), [])
  const closeMatrix = useCallback(() => {
    setMatrixOpen(false)
    window.requestAnimationFrame(() => matrixToggleRef.current?.focus())
  }, [])

  /** 目录也一样：开的时候把兼容矩阵收起来，两层浮层叠着没有意义 */
  const openCatalog = useCallback(() => {
    setMatrixOpen(false)
    setCatalogOpen(true)
  }, [])
  const closeCatalog = useCallback(() => {
    setCatalogOpen(false)
    window.requestAnimationFrame(() => catalogToggleRef.current?.focus())
  }, [])

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
      const payload = p as HostEventPayload
      if (!payload?.event) return
      if (payload.agentId !== liveRef.current?.entry.id) return
      // 合并规则只有一份（在 shared 里），界面不自己再写一套
      setItems((cur) => applyHostEvent(cur, payload.event))
      if (payload.event.kind === 'turn.completed' || payload.event.kind === 'session.faulted') setBusy(false)
      // 这一场出过事：还在跑的节点要标成失败，不能一直转下去
      if (payload.event.kind === 'session.faulted') setFaulted(true)
      if (payload.event.kind === 'turn.started') setFaulted(false)
      if (payload.event.kind === 'turn.started') {
        // 会话名当场就改：侧栏跟着第一句走，不能等攒稿那一步 ——
        // 流式期间每来一片都会把攒稿的定时器往后推，名字能拖到整轮结束才变。
        const sid = liveRef.current?.sessionId
        if (sid) {
          const one = sessionTitle([
            { id: 0, kind: 'message', role: 'user', turnId: payload.event.turnId, text: payload.event.text },
          ])
          setSessions((prev) => {
            const cur = prev.find((s) => s.id === sid)
            if (!cur || cur.title !== '新会话') return prev
            const next = prev.map((s) => (s.id === sid ? { ...s, title: one, updatedAt: Date.now() } : s))
            saveSessions(next)
            return next
          })
        }
      }
      if (payload.event.kind === 'option.changed') {
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
  }, [])

  // 会话落盘：流式文字每来一片都存一遍太糟，攒一下再写
  useEffect(() => {
    if (!live) return
    const t = window.setTimeout(() => {
      const { items: kept, truncated } = pruneItems(items)
      /*
       * 真源在这一家那边时，Torra 只留索引，不留第二份正文。
       *
       * 这一条得守住：读回历史验过之后那一份兜底就该丢掉，
       * 而这个落盘效果会在下一轮字来的时候再跑一遍 —— 不特意避开的话，
       * 刚丢掉的兜底转眼又被写回去，两份就又齐了。
       */
      const harnessOwns = live.harnessOwned === true
      const record: AgentSession = {
        id: live.sessionId,
        agentId: live.entry.id,
        agentTitle: live.entry.title,
        title: sessionTitle(items),
        cwd: live.cwd,
        createdAt: live.startedAt,
        updatedAt: Date.now(),
        // 这一家的会话号：没有它就接不上，所以要一起存
        nativeSessionId: live.nativeSessionId,
        // 能不能接着聊是这一家的能力，不是这一场的：记下来，归档时才有的说
        resume: live.caps?.resume,
        items: harnessOwns ? undefined : kept,
        harnessOwned: harnessOwns,
        truncated: harnessOwns ? undefined : truncated,
      }
      setSessions((prev) => {
        const next = upsertSession(prev, record)
        saveSessions(next)
        return next
      })
    }, 450)
    return () => window.clearTimeout(t)
  }, [items, live])

  // 往下滚：视线跟着 agent 走，但用户往上翻的时候不要把他拽回来
  useEffect(() => {
    if (!atBottom) return
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items, atBottom])

  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent) => {
      if (!pickRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  const activeLines = useMemo(
    () => (archive ? linesFromItems(archive.items ?? []) : linesFromItems(items)),
    [archive, items],
  )
  const blocks = useMemo(() => groupAcpLines(activeLines), [activeLines])
  const edits = useMemo(() => sessionEdits(activeLines), [activeLines])
  /**
   * 只说了动过、没给改动内容的文件。
   *
   * 跟 edits 分开算，不是为了好看：locations 只有路径，没有改前改后。
   * 混进 edits 就等于替这一家编了一次改动，而审查面板会拿它画对照。
   */
  const touches = useMemo(() => sessionTouches(activeLines), [activeLines])
  const touchSet = useMemo(() => new Set(touches), [touches])
  /**
   * 面板当前摊着哪个文件。
   *
   * 两种文件都在这份列表里，但它们是两种东西：给了改动内容的画对照，
   * 只说了动过的画一句实话。默认挑改动的那一份 —— 它才是要先看的东西。
   */
  const shownPath = useMemo(() => {
    if (reviewPath && (edits.some((e) => e.path === reviewPath) || touchSet.has(reviewPath))) {
      return reviewPath
    }
    return edits.length ? edits[edits.length - 1]!.path : (touches[touches.length - 1] ?? null)
  }, [edits, reviewPath, touchSet, touches])
  /** 摊着的那一份有没有改动内容：没有就只能画一句实话，不能画对照 */
  const shownEdit = useMemo(() => edits.find((e) => e.path === shownPath) ?? null, [edits, shownPath])

  useEffect(() => {
    if (edits.length === 0 && touches.length === 0) setReviewOpen(false)
  }, [edits.length, touches.length])

  const entryById = useCallback(
    (agentId: string): AcpAgentEntry | null => list?.entries.find((e) => e.id === agentId) ?? null,
    [list],
  )
  const pickEntry = entryById(pickId) ?? list?.entries[0] ?? null
  const entry = live?.entry ?? null
  const caps = live?.caps ?? null
  const groups = (caps?.selects ?? []).filter((g) => g.options.length > 0)

  /** 把挂着的那一家送走 */
  const stopLive = useCallback(async () => {
    const cur = liveRef.current
    if (!cur) return
    await window.torra.acpStop()
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
        // 这一家给的会话号：跨重启稳定的那一个，是「接着聊」的凭据
        nativeSessionId: r.sessionId,
      }
      setLiveBoth(next)
      // 新开一场：旧那一场的光不该跟过来
      hydrating.current = true
      setItems([])
      setArchive(null)
      setPerm(null)
      setBusy(false)
      setBanner(null)
      setSessions((prev) => {
        const rec = newSession(next.sessionId, e.id, e.title, cwd, next.startedAt)
        rec.nativeSessionId = r.sessionId
        rec.resume = r.capabilities?.resume
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

  /**
   * 接着聊一场旧的：让这一家把那一场的历史重播一遍。
   *
   * 真源在它那边 —— 读回来的正文是它自己留下的历史，不是 Torra 另存的一份。
   * 读得回来就把本地那份兜底正文丢掉（不留第二份真源）；
   * 读不回来就照实说，不拿本地那份冒充历史。
   */
  const resumeSession = useCallback(
    async (s: AgentSession) => {
      const e = entryById(s.agentId)
      if (!e || !s.nativeSessionId) return
      setResuming(s.id)
      setBanner(null)
      const r = await window.torra.acpResume(e.id, s.nativeSessionId, s.cwd ?? cwd)
      setResuming(null)
      if (!r.ok) {
        setBanner(r.verdict?.text ?? r.error ?? '这一家读不回这一场。')
        return
      }
      const replayed = r.snapshot?.items ?? []
      const next: LiveSession = {
        sessionId: s.id,
        entry: e,
        caps: r.capabilities ?? null,
        startedAt: s.createdAt,
        cwd: s.cwd ?? cwd,
        nativeSessionId: r.sessionId ?? s.nativeSessionId,
        // 重播出来了就说明这一家自己留着那一份：Torra 这边不必再留一份
        harnessOwned: replayed.length > 0,
      }
      setLiveBoth(next)
      setArchive(null)
      setPerm(null)
      setBusy(false)
      setReviewOpen(false)
      // 读回历史：这一屏是把旧的账本重新摆出来，不是刚刚发生过
      hydrating.current = true
      setItems(replayed.length ? replayed : (s.items ?? []))
      if (!replayed.length) {
        setBanner('这一家接上了，但没有把这一场重播出来 —— 上面是 Torra 当时留下的记录。')
        return
      }
      // 真源验过了：本地那份兜底正文就没用了，丢掉，不留第二份。
      // 标记当场就写上 —— 不等攒稿那一步：万一这之后立刻就退出应用，
      // 下一轮再进来时得知道这一场正文归它自己管，别又拿兜底那份顶上去。
      setSessions((prev) => {
        const out = prev.map((x) =>
          x.id === s.id ? { ...x, items: undefined, harnessOwned: true, updatedAt: Date.now() } : x,
        )
        saveSessions(out)
        return out
      })
    },
    [cwd, entryById, setLiveBoth],
  )

  const newChat = useCallback(async () => {
    await stopLive()
    // 新的一场：上一场的节点全不在这一屏里了，不发光（基线在 effect 里对）
    hydrating.current = true
    setItems([])
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
      // 切到一场旧会话：那一屏是把旧账本重新摆出来，不是刚刚发生 —— 只对基线
      hydrating.current = true
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
    // 登录方式照协议原样收：协议报了哪几种就说哪几种，一句都不多。
    // 没有 name 也没有 id 的那一项不算一种方式 —— 说不出它是什么。
    setAgentAuth((n) => ({
      ...n,
      [e.id]: (r.capabilities?.authMethods ?? []).filter((m) => m.name || m.id),
    }))
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
    setBusy(true)
    setAtBottom(true)
    // 用户那一句由主进程的开轮事件带回来（turn.started）。
    // 界面不自己添一条 —— 两处都添，同一句话会在界面上出现两次。
    const r = await window.torra.acpPrompt(text)
    if (!r.ok) {
      setBusy(false)
      setItems((cur) => applyHostEvent(cur, { kind: 'session.faulted', text: r.error ?? '没送出去' }))
    }
  }, [archive, draft, pickEntry, startAgent])

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

  // 归档那一场能不能接着聊：结论是这一家的能力，不是这一场的运气
  const archiveResumable = !!archive && canResume(archive)
  // 归档的说明照「能不能接着聊」的结论说，别自己编一套
  const archiveNote = (() => {
    if (!archive) return ''
    const base = archive.resume?.reason ?? '这一家给不给历史没有验过；上面是 Torra 当时留下的记录。'
    // 正文归那一家的时候得说清楚：上面为什么是空的
    const head = archive.harnessOwned
      ? '这一场的正文在那一家自己那儿，Torra 这边只留了一份索引。'
      : ''
    return archive.truncated ? `${head}${base}（更早的内容没有留下）` : `${head}${base}`
  })()
  const status = live ? (busy ? '正在干活' : '就绪') : archive ? (archiveResumable ? '可以接着聊' : '已结束') : '未连接'
  const totalAdded = edits.reduce((n, e) => n + e.added, 0)
  const totalRemoved = edits.reduce((n, e) => n + e.removed, 0)
  /** 审查面板里一共摊着几个文件：改了内容的与只说了动过的都算 */
  const totalFiles = edits.length + touches.length
  /**
   * 面板头上那句话：两种文件分开报。
   *
   * 并成「N 个文件」会把「没给改动内容」的那几个也算成改动 ——
   * 用户点进去一看没有对照，就会以为白改了。
   */
  const reviewSummary = (() => {
    const bits: string[] = []
    if (edits.length) bits.push(`${edits.length} 个有改动内容`)
    if (touches.length) bits.push(`${touches.length} 个只说了动过`)
    return bits.join(' · ') || '没有改动'
  })()
  const title = archive ? archive.title : live ? sessionTitle(items) : '编码工作台'

  // ── 会话工作树 ──────────────────────────────────────────────────
  //
  // 节点全部由账本投影出来（workTree.ts），不另存一份；光只由「真的新发生」
  // 驱动（diffNodes → planFlights），重渲染、切会话、读回历史都不发光。
  const activeItems = useMemo(() => (archive ? (archive.items ?? []) : items), [archive, items])
  /**
   * 正在跑的那一轮。
   *
   * 以账本为准而不是只看 busy：真发出去时 busy 当然是真的，但事件也可能从别处来
   * （续聊、插件推的、冒烟推的）。最后一条自己说「还在跑」，那一轮就是在跑 ——
   * 反过来，账本都收尾了还挂着 busy，会是界面自己的状态没跟上。
   */
  const liveTurnId = useMemo(() => {
    const last = activeItems[activeItems.length - 1]
    if (!last || !('turnId' in last)) return null
    if (busy) return last.turnId
    const open = last.kind === 'tool' && /run|start|pending|progress/i.test(last.status ?? '')
    return open ? last.turnId : null
  }, [busy, activeItems])
  const activeMeta = useMemo(
    () =>
      archive
        ? { id: archive.id, title: archive.title, agentId: archive.agentId, updatedAt: archive.updatedAt }
        : live
          ? { id: live.sessionId, title, agentId: live.entry.id, updatedAt: live.startedAt }
          : null,
    [archive, live, title],
  )

  const trees = useMemo<WorkTree[]>(() => {
    const out: WorkTree[] = []
    const seen = new Set<string>()
    if (activeMeta) {
      out.push(buildWorkTree(activeMeta, activeItems, { liveTurnId, faulted }))
      seen.add(activeMeta.id)
    }
    for (const s of sessions) {
      if (seen.has(s.id)) continue
      out.push(
        buildWorkTree(
          { id: s.id, title: s.title, agentId: s.agentId, updatedAt: s.updatedAt },
          s.items ?? [],
        ),
      )
    }
    // 演示树只在打开演示时混进来，而且它们自己带 demo 标记：卡片上有「演示」二字
    return treeDemo ? [...out, ...demoTrees(Date.now())] : out
  }, [activeMeta, activeItems, liveTurnId, faulted, sessions, treeDemo])

  const primaryTree = activeMeta ? (trees.find((t) => t.id === activeMeta.id) ?? null) : null

  // 光线层：跟着工作台建一次、拆一次。坐标以它自己的 rect 为原点
  useEffect(() => {
    const svg = glowRef.current
    if (!svg) return
    const layer = createLightLayer(svg)
    layerRef.current = layer
    return () => {
      layer.destroy()
      layerRef.current = null
    }
  }, [])

  // 事件 → 节点 → 光。先让新节点出现并滚到眼前，再发射
  useEffect(() => {
    if (!activeMeta) {
      prevNodes.current = []
      hydrating.current = false
      return
    }
    const next = primaryTree?.nodes ?? []
    const diff = diffNodes(prevNodes.current, next)
    prevNodes.current = next
    // 整体换掉的那一批（切会话 / 读回历史）只对基线，不放光。
    // 这里不看「有没有新节点」：历史一上来就是一大片新节点，全放光等于重播了一遍
    if (hydrating.current) {
      hydrating.current = false
      return
    }
    if (!diff.added.length && !diff.finished.length && !diff.failed.length) return

    if (diff.added.length && treeFollow) {
      const last = diff.added[diff.added.length - 1]
      if (last) treeRef.current?.reveal(last.id)
    }

    const treeNow = primaryTree
    if (!treeNow) return
    const plans = planFlights(diff, [treeNow], activeMeta.agentId)
    if (!plans.length) return
    const raf = window.requestAnimationFrame(() => {
      const svg = glowRef.current
      const layer = layerRef.current
      if (!svg || !layer) return
      const base = svg.getBoundingClientRect()
      /*
       * 「在眼前」要分两种来说，因为两端在不同的滚动容器里：
       *   - 终点是工作树的节点，得整个落在那一栏的视口里（被滚动裁掉的不算）；
       *   - 起点是顶栏的模型标记或正文里的气泡，得落在正文的滚动区里。
       * 两边共用一条判据的话，模型标记永远「不在工作树视口里」，光就一束都打不出去。
       */
      const inner = (r: DOMRect, box: DOMRect | null): boolean =>
        r.width > 0 &&
        r.height > 0 &&
        (!box || (r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1))
      const treeBox = document.querySelector('.wtx-viewport')?.getBoundingClientRect() ?? null
      const chatBox = document.querySelector('.agx-thread')?.getBoundingClientRect() ?? null
      const topBox = document.querySelector('.agx-top')?.getBoundingClientRect() ?? null
      const nodeEl = (id: string): Element | null =>
        document.querySelector(`[data-wtx-node="${cssAttr(id)}"]`)
      const fromEl = (id: string): Element | null => {
        if (id.startsWith('node:')) return nodeEl(id.slice(5))
        if (id.startsWith('anchor:')) {
          const a = id.slice(7)
          return document.querySelector(`[data-wtx-turn="${cssAttr(a)}"]`)
        }
        if (id.startsWith('model:')) {
          return document.querySelector(`[data-wtx-src="${cssAttr(id)}"]`)
        }
        return null
      }
      for (const p of plans) {
        const a = fromEl(p.fromId)
        const b = nodeEl(p.toId.slice(5))
        // 源或目标不在眼前（收了面板、聚焦到别的会话）就不发射 ——
        // 从屏幕外飞进来的光，比没有光更难理解
        if (!a || !b) continue
        const ar = a.getBoundingClientRect()
        const br = b.getBoundingClientRect()
        // 起点按它自己所在的那块容器算：顶栏的标记看顶栏，气泡看正文滚动区
        const srcBox = p.fromId.startsWith('model:') ? topBox : p.fromId.startsWith('anchor:') ? chatBox : treeBox
        if (!inner(br, treeBox) || !inner(ar, srcBox)) continue
        layer.emit({
          eventId: p.eventId,
          fromId: p.fromId,
          toId: p.toId,
          from: { x: ar.left + ar.width / 2 - base.left, y: ar.top + ar.height / 2 - base.top },
          to: { x: br.left + br.width / 2 - base.left, y: br.top + br.height / 2 - base.top },
          color: agentLook(p.agentId)?.hue ?? '#5b6470',
          targetEl: b,
        })
      }
    })
    return () => window.cancelAnimationFrame(raf)
  }, [primaryTree, activeMeta, treeFollow])

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
          <div className="agx-group agx-group-head">
            <span>智能体</span>
            <div className="agx-group-actions">
              <button
                type="button"
                ref={catalogToggleRef}
                className={`agx-matrix-toggle agx-cat-toggle${catalogOpen ? ' on' : ''}`}
                aria-expanded={catalogOpen}
                aria-haspopup="dialog"
                onClick={() => (catalogOpen ? closeCatalog() : openCatalog())}
                title="接一家新的：目录里点一下，不用自己填配置"
              >
                <Plug size={12} />
                <span>接一家</span>
              </button>
              <button
                type="button"
                ref={matrixToggleRef}
                className={`agx-matrix-toggle${matrixOpen ? ' on' : ''}`}
                aria-expanded={matrixOpen}
                aria-haspopup="dialog"
                onClick={() => (matrixOpen ? closeMatrix() : openMatrix())}
                title="兼容矩阵：实测过的结果摊开给你看"
              >
                <Table2 size={12} />
                <span>兼容矩阵</span>
              </button>
            </div>
          </div>
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
                    <span className={`agx-dot ${st.cls}${isLive ? ' on' : ''}`} title={st.title} />
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
          {list?.entries.map((e) => {
            const note = agentNote[e.id]
            const auths = agentAuth[e.id] ?? []
            // 预检结论与登录方式各自独立：接上以后结论会被清掉（那是「上一次预检」），
            // 登录方式却是这一家的属性 —— 跟着结论一起消失，就等于把协议说过的话收回去了。
            if (!note && auths.length === 0) return null
            return (
              <div key={`n-${e.id}`} className="agx-agent-note-wrap">
                {note ? <p className={`agx-agent-note${/接不上|没挂|不对/.test(note) ? ' bad' : ''}`}>{note}</p> : null}
                {/*
                 * 登录方式：协议给了几种就说几种，每种附上它自己的说明。
                 * 协议没给就整栏不画 —— 留一栏兜底文案，用户会以为那是协议说的。
                 */}
                {auths.length > 0 && (
                  <div className="agx-auth">
                    <span className="agx-auth-label">
                      <KeyRound size={10} />
                      登录方式
                    </span>
                    <ul className="agx-auth-list">
                      {auths.map((m, i) => (
                        <li key={m.id || `${m.name}-${i}`}>
                          <b>{m.name || m.id}</b>
                          {m.description ? <i>{m.description}</i> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )
          })}
          {list?.problems.map((p, i) => (
            <p key={`p-${i}`} className="agx-agent-note bad">
              {p}
            </p>
          ))}
          {/*
           * 已经接进来的那几条：能加也得能删。
           * 从目录里一键加进来的那些，得能顺手就撤掉 —— 删除不用系统那个弹窗，
           * 就地两步确认（见 AgentRegistry）。
           */}
          <UserEntries
            userEntries={list?.entries.filter((e) => e.source === 'user') ?? []}
            onChanged={() => void reloadList()}
          />

          <div className="agx-group">会话</div>
          {sessions.length === 0 && <p className="agx-empty-line">还没有会话。选一家，把要做的事说清楚。</p>}
          {sessions.map((s) => {
            const on = live?.sessionId === s.id ? !archive : archive?.id === s.id
            const running = live?.sessionId === s.id && !archive
            const resumable = canResume(s)
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
                    {running ? ' · 进行中' : resumable ? ' · 可接着聊' : ''}
                  </i>
                </span>
                {running && <span className="agx-dot ok on" />}
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
                <span className="agx-srcmark" data-wtx-src={`model:${entry?.id ?? archive!.agentId}`}>
                  <AgentMark id={entry?.id ?? archive!.agentId} title={entry?.title ?? archive?.agentTitle} size={26} />
                </span>
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
            {/* 能力声明降为素字：顶栏只有「审查」一枚带框的 chip，出了问题才升 warn */}
            {caps?.toolPack && (
              <span
                className={`agx-chip${caps.toolPack.attached ? ' quiet' : ' warn'}`}
                title={caps.toolPack.reason ?? 'Torra 的工具包已挂上'}
              >
                {caps.toolPack.attached ? `工具包 ${caps.toolPack.tools}` : '工具包未挂'}
              </span>
            )}
            {caps?.resume && (
              <span
                className={`agx-chip${caps.resume.level === 'none' ? ' warn' : ' quiet'}`}
                title={caps.resume.reason}
              >
                {caps.resume.level === 'durable' ? '能接着聊' : caps.resume.level === 'history' ? '能看历史' : '不留历史'}
              </span>
            )}
            {totalFiles > 0 && (
              <button
                type="button"
                className={`agx-chip btn${reviewOpen ? ' on' : ''}`}
                onClick={() => setReviewOpen((v) => !v)}
                title={`${reviewSummary}（增删行数只算有改动内容的那几个）`}
              >
                审查 {totalFiles} 个文件
                {edits.length > 0 && (
                  <>
                    <span className="agx-add">+{totalAdded}</span>
                    <span className="agx-del">−{totalRemoved}</span>
                  </>
                )}
              </button>
            )}
            {live && (
              <button type="button" className="agx-icon-btn" onClick={() => void stopLive()} title="送走这一家" aria-label="送走这一家">
                <Unplug size={14} />
              </button>
            )}
            <button
              type="button"
              className={`agx-chip btn${treeOpen ? ' on' : ''}`}
              aria-pressed={treeOpen}
              onClick={() => setTreeOpen((v) => !v)}
              title="会话工作树：这一步从哪来、往哪去。只占右栏，不动正文"
            >
              <GitBranch size={12} />
              工作树
            </button>
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
                // 「正在跑」认轮号，不认 busy：事件可能从别处来（续聊、插件、测试），
                // 而 busy 只记录「这一屏自己发出去的那一轮」—— 两者分开，气泡就会该亮不亮
                const turnIdOf =
                  b.kind === 'single' ? b.line.turnId : b.lines[b.lines.length - 1]?.turnId
                const runningTurn = !!turnIdOf && turnIdOf === liveTurnId && b.kind !== 'user'
                return (
                  <div
                    key={i}
                    className={`agx-turn${runningTurn ? ' running' : ''}`}
                    style={runningTurn ? { ['--wtx-hue' as string]: agentLook(agentId)?.hue ?? '#5b6470' } : undefined}
                    // 光线从这里起飞：轮号原样写进属性，取源点时按 id 查，不按第几个气泡认人。
                    // 用户自己那句不挂锚 —— 光源该是 agent 这一侧的气泡与它的标记
                    data-wtx-turn={
                      b.kind === 'user'
                        ? undefined
                        : b.kind === 'single'
                          ? b.line.turnId
                          : b.lines[b.lines.length - 1]?.turnId
                    }
                  >
                    {head && b.kind !== 'user' && (
                      <div className="agx-turn-head">
                        <AgentMark id={agentId} title={agentTitle} size={20} />
                        <b>{agentTitle}</b>
                      </div>
                    )}
                    <AcpBlockView
                      block={b}
                      live={busy && i === blocks.length - 1}
                      touchOnly={touchSet}
                      onReview={(p) => {
                        setReviewPath(p)
                        setReviewOpen(true)
                      }}
                    />
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
                  <b>{archiveResumable ? '这一场还在' : '这一场已经结束了'}</b>
                  <span>{archiveNote}</span>
                  <div className="agx-archived-actions">
                    {archiveResumable && (
                      <button
                        type="button"
                        className="agx-btn primary"
                        disabled={resuming === archive.id}
                        onClick={() => void resumeSession(archive)}
                      >
                        {resuming === archive.id ? '正在读回…' : `在 ${archive.agentTitle} 上接着聊`}
                      </button>
                    )}
                    <button
                      type="button"
                      className={archiveResumable ? 'agx-btn' : 'agx-btn primary'}
                      onClick={() => {
                        const e = entryById(archive.agentId)
                        if (e) void startAgent(e)
                      }}
                    >
                      在 {archive.agentTitle} 上新开一场
                    </button>
                  </div>
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
                archive
                  ? archiveResumable
                    ? '这一场还在 · 上面点「接着聊」就能接着说'
                    : '这一场已经结束 · 上面可以把同一家重新开一场'
                  : busy
                    ? '它还在忙；要打断就点右边的方块'
                    : '把这一轮要做的事说清楚 · Enter 送出'
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

      {/* 右：改过的文件；没在审查就让位给工作树 */}
      {reviewOpen && shownPath ? (
        <aside className="agx-review" aria-label="审查改动">
          <header className="agx-review-head">
            <b>审查</b>
            <span>
              {reviewSummary}
              {edits.length > 0 && (
                <>
                  {' · '}
                  <span className="agx-add">+{totalAdded}</span>{' '}
                  <span className="agx-del">−{totalRemoved}</span>
                </>
              )}
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
                className={`agx-file${e.path === shownPath ? ' on' : ''}`}
                onClick={() => setReviewPath(e.path)}
                title={e.path}
              >
                <span className="agx-file-name">{e.path.split(/[\\/]/).pop()}</span>
                <span className="agx-file-dir">{e.path.split(/[\\/]/).slice(0, -1).join('/')}</span>
                <span className="agx-add">+{e.added}</span>
                <span className="agx-del">−{e.removed}</span>
              </button>
            ))}
            {/* 只说了动过的那几个：不画增删数 —— 画了就等于替它编了一次改动 */}
            {touches.map((p) => (
              <button
                key={p}
                type="button"
                className={`agx-file touch${p === shownPath ? ' on' : ''}`}
                onClick={() => setReviewPath(p)}
                title={`${p}（这一家只说了动过这个文件，没给改动内容）`}
              >
                <span className="agx-file-name">{p.split(/[\\/]/).pop()}</span>
                <span className="agx-file-dir">{p.split(/[\\/]/).slice(0, -1).join('/')}</span>
                <span className="agx-file-touch">动过</span>
              </button>
            ))}
          </div>
          {shownEdit ? <DiffView edit={shownEdit} /> : <TouchNotice path={shownPath} />}
        </aside>
      ) : treeOpen ? (
        /*
         * 右栏只有一个位置：审查开着就让审查，关掉就还回工作树。
         * 两栏并排在这个窗口宽度里会把正文压到两百来像素，那不是「保持原布局」。
         */
        <WorkTreePanel
          ref={treeRef}
          trees={trees}
          mode={treeMode}
          focusId={activeMeta?.id}
          follow={treeFollow}
          demo={treeDemo}
          onMode={setTreeMode}
          onFollow={setTreeFollow}
          onOpenFile={(p) => {
            setReviewPath(p)
            setReviewOpen(true)
          }}
          onDemo={(v) => {
            setTreeDemo(v)
            // 演示树要多列才看得出「并行会话」，所以顺手切到全部
            if (v) setTreeMode('all')
          }}
          emptyHint={
            archive?.harnessOwned && !(archive.items ?? []).length
              ? '这一场的正文留在那一家自己那儿，Torra 这边只有索引 —— 工作树只摆得出会话根。点「接着聊」把历史读回来之后，树才长得出枝。'
              : undefined
          }
        />
      ) : null}

      {/* 兼容矩阵：摊开给用户逐项核对 */}
      {matrixOpen && list && <MatrixPanel list={list} onClose={closeMatrix} />}
      {catalogOpen && <AgentCatalogPanel onClose={closeCatalog} onAdded={() => void reloadList()} />}

      {/* 光线层：铺满整个工作台，不吃鼠标；光只往这里画 */}
      <svg className="agx-glow" ref={glowRef} aria-hidden="true" />
    </div>
  )
}

/** 一块内容：用户那句 / 正文 / 步骤组 / 单行 */
function AcpBlockView({
  block,
  live,
  onReview,
  touchOnly,
}: {
  block: AcpBlock
  live: boolean
  onReview: (path: string) => void
  /** 这一场里「只说了动过、没给改动内容」的路径 */
  touchOnly: Set<string>
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
    /**
     * 这一组步骤里被点名碰过、却没拿到改动内容的文件。
     *
     * 判据是整场给的（touchOnly）：某个路径在别处拿到了 diff，
     * 它就是「改了」的那一类，不该在这里又被说成「只动过」。
     */
    const touched = [...new Set(tools.flatMap((l) => l.locations ?? []).filter((p) => touchOnly.has(p)))]
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
                  {/* 「动过」是协议给的路径，不带改动内容 —— 不跟状态标签混成一个词 */}
                  {l.locations?.length ? (
                    <span className="agx-step-touch" title={`这一步动过：${l.locations.join('、')}`}>
                      动过 {l.locations.length} 个文件
                    </span>
                  ) : null}
                  {l.out && l.edits?.length ? null : l.out ? <span className="agx-step-out">{oneLine(l.out)}</span> : null}
                </div>
              )
            })}
          </div>
        </details>
        {changed.length > 0 && <EditCard edits={changed} onReview={onReview} />}
        {touched.length > 0 && <TouchCard paths={touched} onReview={onReview} />}
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

/**
 * 一步里被点名碰过、却没拿到改动内容的文件。
 *
 * 这张卡跟上面那张「已编辑」不是一回事，所以措辞也不能一样：
 * 这里只说「它动过这些文件」，改动内容这一家没给回来。
 * 写成「已编辑」或者配上增删数，都是替它编了一次改动。
 */
function TouchCard({ paths, onReview }: { paths: string[]; onReview: (path: string) => void }) {
  return (
    <div className="agx-touchcard">
      <div className="agx-touchcard-head">
        <b>动过 {paths.length} 个文件</b>
        <span className="agx-touchcard-note">这一家没给改动内容</span>
        <button type="button" className="agx-btn sm" onClick={() => onReview(paths[0]!)}>
          审查
        </button>
      </div>
      {paths.map((p) => (
        <button key={p} type="button" className="agx-editrow touch" onClick={() => onReview(p)} title={p}>
          <span>{p}</span>
          <span className="agx-touch-tag">只说了动过</span>
        </button>
      ))}
    </div>
  )
}

/**
 * 只说了动过、没给改动内容的那个文件。
 *
 * 这里不能画一张空的对照面板：空面板会被读成「什么都没改」，
 * 而事实是这一家动过它、只是没把改了什么带回来。两句话得说清楚。
 */
function TouchNotice({ path }: { path: string }) {
  return (
    <div className="agx-touchnotice">
      <Info size={13} />
      <div className="agx-touchnotice-text">
        <b>这一家没给出改动内容</b>
        <span>它只说了动过这个文件：{path}</span>
        <span className="dim">
          协议只给了路径，没给改前改后 —— 这里画不出对照，也不能据此说它没改。
        </span>
      </div>
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

// ---------------------------------------------------------------------------
// 兼容矩阵：把实测过的那张表摊开，让人逐项核对
// ---------------------------------------------------------------------------

/**
 * 一家一张卡。
 *
 * 卡上只放三样：量的是哪一版、六项能力各自什么结果、什么时候量的。
 * 说明、备注、能不能接着聊都折在「展开」后面 —— 首屏要的是能一眼扫完，
 * 不是把所有东西一次倒在桌面上。
 */
function MatrixCard({ entry, status }: { entry: AcpAgentEntry; status?: AcpMatrixStatus }) {
  const [open, setOpen] = useState(false)
  const cell = status?.cell
  const user = entry.source === 'user'
  const full = cell?.full === true
  // 钉的版本：适配器包就是包版本，自带入口的那一家写 'self'
  const pinned = entry.package?.version ?? 'self'
  const resume = cell?.resume

  /** 整张卡的一句话结论：同样要分清「没量」与「不行」 */
  const verdict = (() => {
    if (user) return { cls: 'none', word: '没量过' }
    if (!status || !status.tested) return { cls: 'none', word: '没量过' }
    if (status.green) return { cls: 'ok', word: '整轮通过' }
    if (full) return { cls: 'bad', word: '有步骤没过' }
    return { cls: 'mid', word: '只测到一半' }
  })()

  return (
    <section className="agx-matrix-card" aria-label={`${entry.title} 的实测结果`}>
      <header className="agx-matrix-card-head">
        <AgentMark id={entry.id} title={entry.title} size={22} />
        <div className="agx-matrix-card-name">
          <b>{entry.title}</b>
          <i>{user ? '自家接入的条目' : `实测版本 ${cell?.version ?? '—'}`}</i>
        </div>
        <span className={`agx-matrix-verdict ${verdict.cls}`}>{verdict.word}</span>
      </header>

      {user ? (
        /* 自家加的条目压根没有格子：不画能力片，也不假装测过 */
        <p className="agx-matrix-untested">自家接入的条目，Torra 没测过</p>
      ) : (
        <>
          <div className="agx-matrix-caps">
            {MATRIX_CAPS.map((c) => {
              const v = capVerdict(cell ? cell[c.key] : false, full)
              return (
                <span key={c.key} className={`agx-cap ${v.cls}`} title={`${c.label}：${v.hint}`}>
                  {v.cls === 'ok' ? (
                    <Check size={11} />
                  ) : v.cls === 'bad' ? (
                    <X size={11} />
                  ) : (
                    <CircleDashed size={11} />
                  )}
                  <span className="agx-cap-name">{c.label}</span>
                  <span className="agx-cap-word">{v.word}</span>
                </span>
              )
            })}
          </div>
          <div className="agx-matrix-meta">
            {cell ? (
              <>
                <span title="矩阵里量的是这一版">
                  <Package size={11} />
                  {cell.version}
                </span>
                {cell.agentVersion && (
                  <span title="这一家自己报的版本">
                    <Fingerprint size={11} />
                    {cell.agentVersion}
                  </span>
                )}
                <span title="实测的日期">
                  <CalendarDays size={11} />
                  {cell.checkedAt}
                </span>
              </>
            ) : (
              <span className="dim">
                <CircleDashed size={11} />
                还没有实测记录
              </span>
            )}
          </div>
        </>
      )}

      {!user && (
        <>
          <button
            type="button"
            className="agx-matrix-more-btn"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <ChevronRight size={11} className={`agx-matrix-caret${open ? ' open' : ''}`} />
            {open ? '收起' : '展开'}
          </button>
          {open && (
            /* 只在展开时挂上去：动画跟着这一段走，别的卡不会跟着重画一遍 */
            <div className="agx-matrix-more">
              {status?.reason && (
                <p className="agx-matrix-line">
                  <Info size={11} />
                  <span>{status.reason}</span>
                </p>
              )}
              {status && status.currentVersionTested === false && (
                <p className="agx-matrix-line warn">
                  <AlertTriangle size={11} />
                  <span>
                    {cell
                      ? `矩阵里量的是 ${cell.version}，现在钉的 ${pinned} 不是它 —— 这一格不替现在这一版背书。`
                      : `现在钉的 ${pinned} 这一版还没量过。`}
                  </span>
                </p>
              )}
              {cell?.agentVersion && cell.agentVersion !== pinned && (
                <p className="agx-matrix-line warn">
                  <AlertTriangle size={11} />
                  <span>
                    这一家自己报的是 {cell.agentVersion}，跟钉的 {pinned} 不一样 —— 本机装的那一版可能已经漂了。
                  </span>
                </p>
              )}
              {cell && cell.notes.length > 0 && (
                <div className="agx-matrix-notes">
                  {cell.notes.map((n, i) => (
                    <p key={i}>{n}</p>
                  ))}
                </div>
              )}
              {resume ? (
                <>
                  <p className="agx-matrix-line">
                    <RotateCcw size={11} />
                    <span>读得回历史：{resume.session ? '能' : '不能'}</span>
                  </p>
                  <p className="agx-matrix-line">
                    <Fingerprint size={11} />
                    <span>轮次标识跨重启对得上：{resume.identity ? '对得上' : '对不上'}</span>
                  </p>
                  <p className="agx-matrix-line">
                    <CalendarDays size={11} />
                    <span>这一项测于 {resume.checkedAt}</span>
                  </p>
                  {resume.note && (
                    <p className="agx-matrix-line">
                      <Info size={11} />
                      <span>{resume.note}</span>
                    </p>
                  )}
                </>
              ) : (
                /* 没测过就写没测过：不能拿「不行」顶替 */
                <p className="agx-matrix-line">
                  <CircleDashed size={11} />
                  <span>能不能接着聊：这一项没测过</span>
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/**
 * 兼容矩阵的浮层。
 *
 * 自绘的，不借原生 <dialog> 的默认皮 —— 这一屏要跟工作台是同一套皮，
 * 原生那圈系统按钮会把它拽到另一个世界里去了。
 */
function MatrixPanel({ list, onClose }: { list: AcpListView; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 焦点进面板；Tab 圈在里面，Esc 出去
    const root = panelRef.current
    root?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !root) return
      const nodes = [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((n) => !n.hasAttribute('disabled') && n.offsetParent !== null)
      if (nodes.length === 0) return
      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
      const cur = document.activeElement
      if (e.shiftKey && (cur === first || !root.contains(cur))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const prov = list.provenance

  return (
    <div
      className="agx-matrix-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="agx-matrix-panel"
        role="dialog"
        aria-modal="true"
        aria-label="兼容矩阵"
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="agx-matrix-head">
          <div className="agx-matrix-head-text">
            <b>兼容矩阵</b>
            <span>兼容性能不能被测出来，而不是被承诺 —— 下面每一格都是量过的。</span>
          </div>
          <button
            type="button"
            className="agx-icon-btn"
            onClick={onClose}
            title="收起（Esc）"
            aria-label="收起兼容矩阵"
          >
            <X size={14} />
          </button>
        </header>

        <div className="agx-matrix-legend">
          <span className="agx-cap ok">
            <Check size={11} />
            <span className="agx-cap-word">通过</span>
          </span>
          <span className="agx-cap none">
            <CircleDashed size={11} />
            <span className="agx-cap-word">没测</span>
          </span>
          <span className="agx-cap bad">
            <X size={11} />
            <span className="agx-cap-word">没过</span>
          </span>
          <span className="agx-matrix-legend-note">
            「没测」是这一轮没跑到，不是这一家不行；「没过」才是真的量过了不通过。
          </span>
        </div>

        <div className="agx-matrix-body">
          {list.entries.length === 0 ? (
            <p className="agx-matrix-empty">还没有登记任何一家。</p>
          ) : (
            <div className="agx-matrix-grid">
              {list.entries.map((e) => (
                <MatrixCard key={e.id} entry={e} status={list.matrix?.[e.id]} />
              ))}
            </div>
          )}
        </div>

        {prov && (prov.generatedBy || prov.note) && (
          <footer className="agx-matrix-foot">
            {prov.generatedBy && (
              <span>
                这份表由 <code>{prov.generatedBy}</code> 生成
              </span>
            )}
            {prov.note && <span>{prov.note}</span>}
          </footer>
        )}
      </div>
    </div>
  )
}
