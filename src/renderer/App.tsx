import { useEffect, lazy, Suspense, useRef, useState, type ComponentProps } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useStore,
  type DeltaBatchItem,
  type LiveSessionSnapshot,
  type OrchestratorEventPayload,
} from './store'
import { customizedDefaults, type DiscussionConfigKey } from './configDefaults'
import { ModelRail } from './components/ModelRail'
import { TopicEvolution } from './components/TopicEvolution'
import { RightPanel } from './components/RightPanel'
import { NewSession } from './components/NewSession'
import { WebviewDock } from './components/WebviewDock'
import { PluginNav, PluginPage, usePluginPanels } from './components/PluginPanels'
import { Splitter } from './components/Splitter'
import { useStoredWidth, widthVar } from './layout'
import { TitlebarNotice } from './components/TitlebarNotice'
import { pushNotice, type NoticeItem, type NoticeTone } from './notice'
import { BrandTile } from './components/BrandMark'
import { InterventionBar, InterventionTicker } from './components/InterventionBar'
import { ImageZoomHost } from './components/ImageZoom'
/*
 * 首屏之外的那几屏按需加载。
 *
 * 开场落在「研讨」，且未开始时画的是 NewSession —— 设置页、历史、聊天页、报告浮层、
 * 助手抽屉在这一刻一行代码都不该跑。它们五个加起来近 8000 行，全静态引进 App 就是
 * 首屏 JS 的全部成本；拆成动态 import 后 Vite 会给每个一枚 chunk，点到了才下载。
 *
 * 名字沿用原来的导出名：JSX 标签不变，切片断言与调用点都不用跟着改。
 */
const SettingsPage = lazy(() => import('./components/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const HistoryPage = lazy(() => import('./components/HistoryPage').then((m) => ({ default: m.HistoryPage })))
const ChatPage = lazy(() => import('./components/ChatPage').then((m) => ({ default: m.ChatPage })))
const ReportWorkspace = lazy(() =>
  import('./components/ReportWorkspace').then((m) => ({ default: m.ReportWorkspace })),
)
const AssistantDrawer = lazy(() => import('./components/AssistantDrawer').then((m) => ({ default: m.AssistantDrawer })))
const AgentsPage = lazy(() => import('./components/AgentsPage').then((m) => ({ default: m.AgentsPage })))
const TranslatePage = lazy(() => import('./components/TranslatePage').then((m) => ({ default: m.TranslatePage })))
import type { RetryPlan } from '@shared/retry'
import { RETRY_MODE_LABEL } from '@shared/retry'
import type { SessionRecord } from '@shared/types'
import {
  History,
  Plus,
  Download,
  Square,
  AlertTriangle,
  AlertCircle,
  CheckCircle,
  X,
  Loader2,
  Settings,
  MessagesSquare,
  MessageCircle,
  Languages,
  FileText,
  Sparkles,
  Sun,
  Moon,
  Terminal,
} from 'lucide-react'
import { toggleTheme, useResolvedTheme } from './theme'
import { copyReportViewAsImage, exportReportView } from './reportExport'

type Section = 'discuss' | 'chat' | 'agents' | 'translate' | 'history' | 'settings' | 'plugin'

/*
 * 导航现在是纯图标，label 只在 hover 时以气泡出现 —— 图标因此从 13 提到 15：
 * 13 那档是「图标给文字当定语」的尺寸，一旦独自代表整项就小到认不出来。
 * 研讨用双气泡（多方同桌），聊天用单气泡（一对一），刻意不共用一枚，
 * 否则去掉文字后这两项在标题栏里会长得一模一样。
 */
const SECTIONS: Array<{ key: Section; label: string; icon: React.ReactNode }> = [
  { key: 'discuss', label: '研讨', icon: <MessagesSquare size={15} /> },
  { key: 'chat', label: '聊天', icon: <MessageCircle size={15} /> },
  // 编码工作台单独成一屏，不再挂在标题栏的抽屉上：它要同时摆出会话、正文与改动，
  // 抽屉那点宽度放不下其中两样（见 components/AgentsPage）。
  { key: 'agents', label: '编码', icon: <Terminal size={15} /> },
  { key: 'translate', label: '翻译', icon: <Languages size={15} /> },
  { key: 'history', label: '历史', icon: <History size={15} /> },
  { key: 'settings', label: '设置', icon: <Settings size={15} /> },
]

const STATE_LABEL: Record<string, string> = {
  INIT: '初始化',
  LOGIN_CHECK: '检查登录态',
  READY: '就绪',
  ROUND_START: '轮次开始',
  AGENT_BATCH: '并行发言',
  MODERATOR_SUMMARY: '主持小结',
  MODERATOR_RETRY: '主持重试',
  PAUSE_FOR_USER: '已暂停',
  CONSENSUS_EVAL: '收敛判定',
  REPORT_GEN: '生成报告',
  DONE: '已完成',
  ABORTED: '已终止',
  FAILED: '失败',
}

const STATE_ICON: Record<string, React.ReactNode> = {
  INIT: <Loader2 size={11} />,
  LOGIN_CHECK: <Loader2 size={11} />,
  READY: <CheckCircle size={11} />,
  ROUND_START: <Loader2 size={11} />,
  AGENT_BATCH: <Loader2 size={11} />,
  MODERATOR_SUMMARY: <Loader2 size={11} />,
  MODERATOR_RETRY: <AlertTriangle size={11} />,
  PAUSE_FOR_USER: <AlertCircle size={11} />,
  CONSENSUS_EVAL: <Loader2 size={11} />,
  REPORT_GEN: <Loader2 size={11} />,
  DONE: <CheckCircle size={11} />,
  ABORTED: <X size={11} />,
  FAILED: <AlertCircle size={11} />,
}

/** 横幅上只放域名：整条 URL 又长又含路径参数，会把真正要说的提示挤没 */
function safeHost(u?: string): string {
  try {
    return u ? new URL(u).host : ''
  } catch {
    return ''
  }
}

/** 流式增量的合并窗口：比一帧略长，看着仍是连续流出 */
const DELTA_FLUSH_MS = 60

/**
 * 顶层要读的字段一次列全，但不订 `utterances`：逐字增量只改那一个键，
 * 整份 store 订阅（`useStore()`）会让每 60ms 一次的 flush 重渲染整棵树 ——
 * 包括 1700 行的论题演化图和聊天页。发言流由它自己的消费者订（见 DiscussModelRail）。
 */
const useAppSlice = () =>
  useStore(
    useShallow((st) => ({
      anonymousReview: st.anonymousReview,
      adoptLiveSession: st.adoptLiveSession,
      applyDeltas: st.applyDeltas,
      applyEvent: st.applyEvent,
      baseline: st.baseline,
      baselineCompare: st.baselineCompare,
      broadcastTarget: st.broadcastTarget,
      budgetLimitUsd: st.budgetLimitUsd,
      budgetLimited: st.budgetLimited,
      chatWebviewTarget: st.chatWebviewTarget,
      clearSessionState: st.clearSessionState,
      discussionDefaults: st.discussionDefaults,
      discussionDefaultOverrides: st.discussionDefaultOverrides,
      dismissStall: st.dismissStall,
      hydrateDiscussionDefaults: st.hydrateDiscussionDefaults,
      hydrateFromRecord: st.hydrateFromRecord,
      maxRounds: st.maxRounds,
      moderatorId: st.moderatorId,
      moderatorNote: st.moderatorNote,
      models: st.models,
      paused: st.paused,
      participantIds: st.participantIds,
      regenerateReport: st.regenerateReport,
      report: st.report,
      reportOpen: st.reportOpen,
      reportRegenNote: st.reportRegenNote,
      reportRegenerating: st.reportRegenerating,
      reset: st.reset,
      resetDiscussionConfig: st.resetDiscussionConfig,
      restoreFactoryDiscussionDefaults: st.restoreFactoryDiscussionDefaults,
      riskNotice: st.riskNotice,
      round: st.round,
      sessionId: st.sessionId,
      setDiscussionDefault: st.setDiscussionDefault,
      setModels: st.setModels,
      setPendingFollowup: st.setPendingFollowup,
      setReport: st.setReport,
      setReportOpen: st.setReportOpen,
      setRiskNotice: st.setRiskNotice,
      setViewMode: st.setViewMode,
      spentUsd: st.spentUsd,
      stalledNotice: st.stalledNotice,
      state: st.state,
      strategy: st.strategy,
      timeBudgetMin: st.timeBudgetMin,
      toggleChatWebview: st.toggleChatWebview,
      toggleParticipant: st.toggleParticipant,
      topicTitle: st.topicTitle,
      verifyPass: st.verifyPass,
      viewMode: st.viewMode,
    })),
  )

/** 左栏的「谁在说话」自己订增量：全场每 60ms 变一次的只有 `utterances` 这一个键 */
function DiscussModelRail(props: Omit<ComponentProps<typeof ModelRail>, 'utterances'>) {
  const utterances = useStore((st) => st.utterances)
  return <ModelRail {...props} utterances={utterances} />
}

export default function App() {
  const s = useAppSlice()
  const resolvedTheme = useResolvedTheme()
  // 顶层导航：研讨 / 聊天 / 历史 / 设置，始终可见
  const [section, setSection] = useState<Section>('discuss')
  /** 插件也占一条屏：入口和上面几个分屏同一排，但它自己不属于 SECTIONS */
  const [pluginId, setPluginId] = useState<string | null>(null)
  const { panels: pluginPanels, loaded: pluginsLoaded } = usePluginPanels()
  // started 仅对「研讨」有意义：首页配置中 vs 一场讨论进行中/回看
  const [started, setStarted] = useState(false)
  /** 已发出终止请求、还在等主流程收束。见 handleAbort：飞行中的那次调用掐不掉，这段等待必须可见 */
  const [aborting, setAborting] = useState(false)
  const [reportPath, setReportPath] = useState<string | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  /**
   * 识别用的独立窗口是否开着（主进程告诉我们）。
   * 那枚窗口不属于 Torra 的界面，用户找不到它归谁管、也不敢关 ——
   * 所以在应用里留一条常驻提示：看得见它在开，也按得动关闭。
   */
  const [scanWin, setScanWin] = useState<{ open: boolean; entry?: string } | null>(null)

  // 研讨页网页视图列的可拖宽度（null = 没拖过，用 CSS 的 44% 默认）。
  // 上限要按整行算：.center 是 flex:1，拖宽的一刻它自己就变窄，拿它当尺子会越拖越缩
  const discWebRef = useRef<HTMLElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const [discWebW, setDiscWebW] = useStoredWidth('discuss.webview')

  /**
   * 打开助手前先收起内嵌网页视图。
   * WebContentsView 永远盖在渲染层之上，不收起的话抽屉会被它整片遮掉，
   * 用户看到的是「点了没反应」。
   */
  const toggleAssistant = () => {
    if (!assistantOpen && s.viewMode === 'broadcast') {
      void window.torra.dismissWebview(s.broadcastTarget ?? '')
      s.setViewMode('hall')
    }
    setAssistantOpen((v) => !v)
  }

  /**
   * 切换顶层分区。
   * 离开「研讨」时若正挂着网页视图，必须先收起主进程内嵌的 WebContentsView ——
   * 它永远盖在渲染层之上，不收起会遮罩聊天/历史/设置。
   */
  /**
   * 报告导出：统一走 reportExport 的 DOM 抓取，Markdown 走主进程。
   *
   * 报告工作区是全屏覆盖层，导出时要把 .rw-shell 抓成静态文档；
   * 失败时只提示原因，不静默失败。
   */
  const handleReportExport = async (
    kind: 'html' | 'pdf' | 'md' | 'img',
    sessionId: string,
    title: string,
  ) => {
    try {
      if (kind === 'md') {
        const r = await window.torra.exportMarkdown(sessionId)
        if (!r.ok) pushNotice(r.reason ?? '导出 Markdown 失败', { tone: 'danger' })
        return
      }
      if (kind === 'img') {
        const r = await copyReportViewAsImage(sessionId, title)
        if (!r.ok) pushNotice(r.reason ?? '导出图片失败', { tone: 'danger' })
        return
      }
      const r = await exportReportView(sessionId, kind, title)
      if (!r.ok) pushNotice(r.reason ?? '导出失败', { tone: 'danger' })
    } catch (e) {
      pushNotice(`导出失败：${(e as Error).message}`, { tone: 'danger' })
    }
  }

  const goSection = (next: Section) => {
    if (next !== 'discuss' && s.viewMode === 'broadcast') {
      void window.torra.dismissWebview(s.broadcastTarget ?? '')
      s.setViewMode('hall')
    }
    // 抽屉贴在正文右侧、盖住半屏：换一屏还让它撑着，用户会以为自己没切成功
    setAssistantOpen(false)
    setPluginId(null)
    setSection(next)
  }

  /**
   * 打开一条插件屏。插件面板占的是正文，内嵌网页视图必须让位
   * （WebContentsView 永远盖在渲染层之上），助手抽屉同理：两者叠在一起会挡住面板上半屏。
   */
  const openPlugin = (id: string) => {
    if (s.viewMode === 'broadcast') {
      void window.torra.dismissWebview(s.broadcastTarget ?? '')
      s.setViewMode('hall')
    }
    setAssistantOpen(false)
    setPluginId(id)
    setSection('plugin')
  }

  /* 在设置页把正在看的插件停用/卸载后，顶部那一格会消失：不能把人留在一条已经没有的屏上 */
  useEffect(() => {
    if (section !== 'plugin' || !pluginsLoaded) return
    if (pluginId && pluginPanels.some((p) => p.id === pluginId)) return
    setPluginId(null)
    setSection('discuss')
  }, [section, pluginId, pluginPanels, pluginsLoaded])

  /**
   * 一次性提示。action 用于需要用户确认后续动作的场景 ——
   * 如「登录窗口已打开」，登录完成时机由用户掌握，不该用固定 setTimeout 去猜。
   * 走 notice 总线而不是本地 state：聊天页、网页视图也要往同一个出口说话。
   */
  const showToast = (
    m: string,
    action?: { actionLabel?: string; onAction?: () => void },
    tone: NoticeTone = 'info',
  ) => {
    pushNotice(m, {
      tone,
      action:
        action?.actionLabel && action.onAction ? { label: action.actionLabel, run: action.onAction } : undefined,
      ttl: action?.onAction ? 30_000 : 4200,
    })
  }
  /** 失败/需要用户处理的路径必须显式标黄 —— 全绿等于把警告混进了确认音 */
  const warnToast = (m: string, action?: { actionLabel?: string; onAction?: () => void }) =>
    showToast(m, action, 'warn')
  /**
   * 一次性上手引导。已读标记存在主进程：重载页面、换窗口都不该再问第二遍。
   */
  const [intro, setIntro] = useState(false)
  useEffect(() => {
    void window.torra.onboardingState().then((r) => setIntro(r.show))
  }, [])
  const dismissIntro = () => {
    setIntro(false)
    void window.torra.onboardingDismiss()
  }

  const handleRetry = async (plan: RetryPlan, sessionId: string) => {
    const r = await window.torra.retrySession(sessionId, plan)
    if (!r.ok) {
      warnToast(`无法重试：${(r.errors ?? []).join('；')}`)
      return
    }
    setSection('discuss')
    setStarted(true)
    showToast(
      `已按「${RETRY_MODE_LABEL[plan.mode]}」创建新讨论${r.notices?.length ? '：' + r.notices[0] : ''}`,
    )
  }

  /**
   * 回放到议事厅：把历史会话灌进运行态重现，不新建会话、不产生费用。
   *
   * 与重试的区别：重试是「拿它当素材再开一场」，回放是「原样看当时发生了什么」。
   * 因此这里只 hydrate + 切视图，编排器不参与 —— state 为已结束，介入条自动禁用。
   */
  const handleReplay = async (sessionId: string) => {
    const d = (await window.torra.getSessionDetail(sessionId)) as
      | { record: SessionRecord }
      | null
    if (!d?.record) {
      warnToast('无法载入该会话记录')
      return
    }
    s.hydrateFromRecord(d.record)
    setSection('discuss')
    setStarted(true)
    showToast('已进入回放模式 · 只读重现当时的议事厅')
  }

  useEffect(() => {
    void (async () => {
      // 先加载持久化的偏好设置，再加载模型列表
      const prefs = await window.torra.loadPreferences()
      // 「我的默认」只灌默认槽，不碰草稿：此刻用户还没开始调这一场，
      // 把覆盖刷进草稿会让上次那场的数值像是这一场的起点
      s.hydrateDiscussionDefaults(await window.torra.getDiscussionDefaults())
      void window.torra.listModels().then((m) => {
        s.setModels(m)
        // 主持只认 API 通道：偏好里可能存着历史遗留的网页模型 id，
        // 那种值会让主持通道在跑到最后一步时静默失效，恢复时直接丢弃。
        const savedModerator =
          prefs.moderatorId && m.some((x) => x.id === prefs.moderatorId && x.transport === 'api')
            ? prefs.moderatorId
            : useStore.getState().moderatorId
        // 如果有持久化的选择，覆盖默认的健康检测选择
        if (prefs.participantIds && prefs.participantIds.length > 0) {
          // 只保留当前仍然存在的模型
          const validIds = prefs.participantIds.filter((id) => m.some((x) => x.id === id) && id !== savedModerator)
          if (validIds.length > 0) {
            useStore.setState({ participantIds: validIds, moderatorId: savedModerator })
          }
        }
        useStore.setState({ moderatorId: savedModerator })
      })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 渲染层重载后，把进行中的那一场重新接回来。
   *
   * 事件是单向推送、不会重播：渲染层一旦重载（崩溃自愈、手动重新载入、dev 热更新），
   * 它的 store 就是空的 —— 而主进程还握着本场已经跑完的发言。用户看到的是
   * 「0/N 已返回」加一张空画布，和「内容真的没了」完全分不出来。
   *
   * 冷启动时没有进行中的会话（live:false），所以这条不会把上一场的残留拽回来；
   * 判据是主进程手里有没有活的编排器，不是本进程记着什么。
   */
  useEffect(() => {
    void (async () => {
      let snap: LiveSessionSnapshot | null = null
      try {
        snap = (await window.torra.sessionState()) as LiveSessionSnapshot
      } catch {
        return
      }
      if (!snap?.live) return
      s.adoptLiveSession(snap)
      setSection('discuss')
      setStarted(true)
      showToast('已重新接入进行中的讨论')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 偏好变化时自动持久化
  useEffect(() => {
    if (s.participantIds.length === 0 && !s.moderatorId) return
    void window.torra.savePreferences({
      participantIds: s.participantIds,
      moderatorId: s.moderatorId,
    })
  }, [s.participantIds, s.moderatorId])

  /**
   * 登录态轮询。
   *
   * 登录是在内嵌页面里完成的（同一个 WebContents），但登录成功后
   * 主进程不会主动重测 —— 状态灯会一直停在「未登录」，
   * 让人以为登录没生效而反复重登。
   *
   * 这里周期性探测：只在存在不可用的 webview 型模型时轮询，
   * 全部就绪后自动停止，不做无谓开销。
   */
  useEffect(() => {
    const needProbe = s.models.some(
      (m) => m.transport === 'webview' && (m.status === 'expired' || m.status === 'adapter-broken'),
    )
    if (!needProbe) return

    let cancelled = false
    const timer = setInterval(() => {
      if (cancelled) return
      void window.torra.probeModels().then(() => {
        if (cancelled) return
        void window.torra.listModels().then((m) => s.setModels(m))
      })
    }, 8000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // 仅在「是否存在不可用模型」这一位翻转时重建轮询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.models.some((m) => m.transport === 'webview' && (m.status === 'expired' || m.status === 'adapter-broken'))])

  useEffect(() => {
    /*
     * 逐 token 的增量先攒一个窗口再落一次更新：一条 1500 字的回答原样是
     * 750 次 set，每次 set 都让整棵树重排。非增量事件必须先冲账再看状态，
     * 否则 utterance-done 会把还没落地的 chunk 覆盖掉。
     */
    const buf = new Map<string, DeltaBatchItem>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flushDeltas = () => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (buf.size === 0) return
      const batch = [...buf.values()]
      buf.clear()
      s.applyDeltas(batch)
    }
    const offEvent = window.torra.on('orchestrator:event', (p) => {
      const e = p as OrchestratorEventPayload
      if (e.type !== 'utterance-delta' && e.type !== 'thinking-delta' && e.type !== 'steps-delta') {
        flushDeltas()
        s.applyEvent(e)
        return
      }
      const cur: DeltaBatchItem = buf.get(e.utteranceId) ?? { utteranceId: e.utteranceId, agentId: e.agentId }
      if (e.type === 'utterance-delta') cur.content = (cur.content ?? '') + e.chunk
      else if (e.type === 'thinking-delta') cur.thinking = (cur.thinking ?? '') + e.chunk
      else cur.steps = (cur.steps ?? '') + e.chunk
      buf.set(e.utteranceId, cur)
      flushTimer ??= setTimeout(flushDeltas, DELTA_FLUSH_MS)
    })
    /*
     * 新一场开始：把上一场的发言、结论、分歧从界面上撤掉。
     *
     * 主进程在派发本场第一条编排器事件之前推这一条，
     * 所以清场一定早于新一场的头几句，不会把新内容一起清掉。
     */
    const offReset = window.torra.on('session:reset', () => {
      flushDeltas()
      s.clearSessionState()
    })
    const offRisk = window.torra.on('risk:show', (p) => {
      s.setRiskNotice((p as { message: string }).message)
    })
    const offReport = window.torra.on('report:ready', (p) => {
      const { sessionId, report } = p as { sessionId: string; report: unknown }
      s.setReport(sessionId, report)
      /** 报告落盘即弹出：只留一个「导出」按钮，用户会以为报告没生成 */
      s.setReportOpen(true)
    })
    const offAdapter = window.torra.on('adapters:changed', () => {
      void window.torra.listModels().then((m) => s.setModels(m))
    })
    const offModels = window.torra.on('models:changed', () => {
      void window.torra.listModels().then((m) => s.setModels(m))
    })
    /*
     * 启动登录态盘点。
     *
     * 重启后最关心的就是「上次登录的还在不在」。已恢复的不用打扰，
     * 未恢复的一次说清，避免逐个点开试。
     */
    const offInventory = window.torra.on('login:inventory', (p) => {
      const { loggedIn, loggedOut } = p as {
        loggedIn: string[]
        loggedOut: Array<{ modelId: string; displayName: string }>
      }
      const names = loggedOut.map((x) => x.displayName).join('、')
      const kept = loggedIn.length > 0 ? `（${loggedIn.join('、')} 已自动恢复）` : ''
      showToast(
        loggedOut.length > 0
          ? `${names} 需要重新登录${kept}。点对应头像即可登录，登录成功会自动转绿。`
          : `全部 ${loggedIn.length} 个站点登录态已自动恢复`,
        { actionLabel: '刷新状态', onAction: () => { void window.torra.listModels().then((m) => s.setModels(m)) } },
        loggedOut.length > 0 ? 'warn' : 'success',
      )
    })
    /*
     * 登录态变化通知。
     *
     * 内嵌视图下用户直接在页面里登录，主进程在检测到登录态由
     * 未登录变为已登录时推送一条消息，这里转成提示并刷新状态灯 ——
     * 不必让用户手动点「复核状态」才能确认登录成功。
     */
    const offLogin = window.torra.on('login:result', (p) => {
      const { modelId, ok, reason } = p as { modelId: string; ok: boolean; reason?: string }
      const name = useStore.getState().models.find((m) => m.id === modelId)?.displayName ?? modelId
      void window.torra.listModels().then((m) => s.setModels(m))
      if (ok) {
        showToast(`「${name}」登录成功，会话已生效`, undefined, 'success')
        return
      }
      // 仍未就绪：给出可执行的下一步，而不是让用户反复重试
      void window.torra.diagnoseLogin(modelId).then((d) => {
        if (!d.ok) {
          warnToast(`「${name}」诊断失败：${d.reason ?? '未知原因'}`)
          return
        }
        showToast(`「${name}」${d.verdict}`, {
          actionLabel: '重新复核',
          onAction: async () => {
            await window.torra.refreshLogin(modelId)
            void window.torra.listModels().then((m) => s.setModels(m))
          },
        }, 'warn')
      })
      void reason
    })
    /*
     * 主进程请我们把某个模型的页面摆出来（助手「打开页面登录」、模型头像点进来的都是这条）。
     * 必须由渲染层挂 <WebviewDock> 来呈现：主进程自己按固定基线贴出来的原生视图
     * 没有表头、没有关闭按钮，用户只能看着一整片网页压住应用。
     */
    const offRequest = window.torra.on('webview:request', (p) => {
      const { modelId } = (p ?? {}) as { modelId?: string }
      if (!modelId) return
      setSection('discuss')
      s.setViewMode('broadcast', modelId)
    })
    const offScan = window.torra.on('smartadd:scan-window', (p) => {
      setScanWin((p ?? null) as { open: boolean; entry?: string } | null)
    })
    return () => {
      flushDeltas()
      offEvent()
      offReset()
      offRisk()
      offReport()
      offAdapter()
      offModels()
      offLogin()
      offInventory()
      offRequest()
      offScan()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const running =
    s.state !== 'INIT' &&
    s.state !== 'READY' &&
    s.state !== 'DONE' &&
    s.state !== 'ABORTED' &&
    s.state !== 'FAILED'

  /**
   * 收口态：记录已落盘，报告和全文导出都拿得到。
   * 中止/失败同样收口 —— 用户按终止要的正是「立刻给我这场跑到哪算哪的报告」。
   */
  const settled = s.state === 'DONE' || s.state === 'ABORTED' || s.state === 'FAILED'

  /**
   * 终止请求发出后，收束要等当前那次调用回来（网页通道可能几十秒），
   * 所以「还在跑」和「已请求终止」必须都能从状态里推出来。
   */
  useEffect(() => {
    if (!running) setAborting(false)
  }, [running])

  const handleAbort = async () => {
    setAborting(true)
    try {
      const r = await window.torra.abortSession()
      if (!r.ok) {
        /** 没有会话可终止时不能默默返回成功：用户会以为按钮坏了 */
        setAborting(false)
        warnToast(r.reason ?? '终止请求没有送达')
        return
      }
      showToast('已请求终止：正在收束当前调用并生成部分报告', undefined, 'warn')
    } catch (e) {
      setAborting(false)
      warnToast(`终止失败：${(e as Error).message}`)
    }
  }

  /**
   * 网页视图的开关。真正的「贴合 + 呈现 + 收起」由 <WebviewDock> 在挂载/卸载时负责，
   * 这里只切换视图状态并挑定目标模型。
   */
  const openBroadcast = (id: string) => s.setViewMode('broadcast', id)
  const closeBroadcast = () => s.setViewMode('hall')

  const handleSelectBroadcast = (id: string) => {
    if (s.viewMode === 'broadcast' && s.broadcastTarget === id) closeBroadcast()
    else openBroadcast(id)
  }

  /** 网页视图里完成登录后，复核并刷新状态灯 */
  const recheckBroadcast = async () => {
    const id = s.broadcastTarget
    if (!id) return
    const r = await window.torra.refreshLogin(id)
    void window.torra.listModels().then((m) => s.setModels(m))
    showToast(r.ok ? '登录态已确认' : (r.reason ?? '仍未就绪'), undefined, r.ok ? 'success' : 'warn')
  }

  const refreshModels = () => void window.torra.listModels().then((m) => s.setModels(m))

  /** 模型停用/移除后，把它从参与名单/主持/转播目标里一并摘掉，避免残留导致开场校验失败 */
  const pruneForGone = (id: string) => {
    const st = useStore.getState()
    if (st.participantIds.includes(id)) st.toggleParticipant(id)
    if (st.moderatorId === id) st.patchConfig({ moderatorId: null })
    if (st.viewMode === 'broadcast' && st.broadcastTarget === id) st.setViewMode('hall')
  }

  const handleReorder = async (ids: string[]) => {
    // 先本地重排让拖动即时生效，再落盘并向主进程对齐
    const byId = new Map(s.models.map((m) => [m.id, m]))
    const next = ids.map((id) => byId.get(id)).filter((m): m is typeof s.models[number] => !!m)
    s.setModels(next)
    await window.torra.reorderModels(ids)
    refreshModels()
  }

  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    const r = await window.torra.setModelEnabled(id, enabled)
    if (!r.ok) {
      warnToast(r.reason ?? '操作失败')
      return
    }
    if (!enabled) pruneForGone(id)
    refreshModels()
  }

  const handleRemoveModel = async (id: string) => {
    const m = s.models.find((x) => x.id === id)
    const r = await window.torra.removeModel(id)
    if (!r.ok) {
      warnToast(r.reason ?? '移除失败')
      return
    }
    pruneForGone(id)
    refreshModels()
    showToast(
      m?.userDefined
        ? `已删除「${m.displayName}」`
        : `已从侧栏移除「${m?.displayName ?? id}」，可在设置页恢复`,
      undefined,
      'success',
    )
  }

  /**
   * 讨论参数「我的默认」落盘。
   *
   * 状态先行，所以界面立刻就是新默认；写盘失败时从主进程读回真实的那份重新灌入 ——
   * 本地留着新值、盘上是旧值，下次启动会看到数值自己「回滚」，
   * 而那看起来像代码写错了，没人会怀疑是一次没成功的保存。
   */
  const persistDiscussionDefaults = async () => {
    const r = await window.torra.setDiscussionDefaults(useStore.getState().discussionDefaultOverrides)
    if (!r.ok) {
      warnToast(`默认值没能存上：${r.reason ?? '未知原因'}`)
      s.hydrateDiscussionDefaults(await window.torra.getDiscussionDefaults())
    }
  }

  const handleSetDiscussionDefault = async (key: DiscussionConfigKey, value: unknown) => {
    s.setDiscussionDefault(key, value)
    await persistDiscussionDefaults()
  }

  const handleRestoreFactoryDefaults = async () => {
    s.restoreFactoryDiscussionDefaults()
    await persistDiscussionDefaults()
  }

  const handleClearDisabled = async () => {
    const gone = s.models.filter((x) => !x.enabled)
    if (gone.length === 0) return
    for (const m of gone) {
      const r = await window.torra.removeModel(m.id)
      if (r.ok) pruneForGone(m.id)
    }
    refreshModels()
    showToast(`已清除 ${gone.length} 个停用模型`)
  }

  const handleExport = async () => {
    if (!s.sessionId) return
    const r = await window.torra.exportMarkdown(s.sessionId)
    if (r.ok && r.path) setReportPath(r.path)
  }

  /*
   * 常驻提示：从状态推导，按优先级排好（终止中 > 暂停 > 停滞 > 预算 > 识别窗口 > 导出结果）。
   * 同一时刻 chip 只显示最高优先级那条，其余用页码轮看 —— 既不再叠成一条横幅墙，
   * 也不把哪条悄悄藏掉。文案压到一行，完整说法放 hint 里悬停看。
   */
  const persistent: NoticeItem[] = []
  if (aborting) {
    /**
     * 终止优先于暂停：正在收束的那场不叫「等待你的指示」，
     * 继续挂着暂停红条会让人以为按下去的终止没被接住。
     */
    persistent.push({
      key: 'aborting',
      tone: 'warn',
      text: '正在终止：等当前这次调用收束，随后生成部分报告',
      hint: '飞行中的模型调用没法从外面掐掉，所以终止会在它返回后的第一个检查点生效。',
    })
  } else if (s.paused) {
    persistent.push({
      key: 'paused',
      tone: 'danger',
      text: s.moderatorNote ?? '已暂停，等待你的指示',
      hint: s.moderatorNote ?? '已暂停：在下方介入条里给出指示后继续',
    })
  }
  if (s.stalledNotice) {
    persistent.push({
      key: 'stall',
      tone: 'warn',
      text: '综合分连续 2 轮没再上升：多半是在原地换措辞。让某个模型换个角度反驳 / 插话补一条外部证据 / 直接收口看报告',
      action: { label: '知道了', run: () => s.dismissStall() },
    })
  }
  if (s.budgetLimited) {
    persistent.push({
      key: 'budget',
      tone: 'warn',
      text: '已达预算上限，剩余轮次不再发言，报告将标注「预算受限」',
    })
  }
  if (scanWin?.open) {
    const host = safeHost(scanWin.entry)
    persistent.push({
      key: 'scanwin',
      tone: 'warn',
      text: `Torra 打开了独立识别窗口${host ? `（${host}）` : ''}：登录、看页面都在那边做`,
      hint: '识别完可以直接关掉。关掉之后 Torra 不会自作主张再弹出来。',
      action: { label: '关闭窗口', run: () => void window.torra.smartAddClose() },
    })
  }
  if (reportPath) {
    persistent.push({
      key: 'report',
      tone: 'success',
      text: `报告已导出：${reportPath}`,
      hint: reportPath,
      action: { label: '收起', run: () => setReportPath(null) },
    })
  }
  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-brand">
          <BrandTile />
          <strong>Torra</strong>
        </div>

        {/*
          * 图标常驻，文字压成 hover 气泡 —— 导航从 4 枚胶囊收成 4 个方块。
          * label 留在 DOM 里而不是删掉：它既是气泡的内容，也让
          * verify-* 脚本按 textContent 定位分区的写法继续成立。
          * 但气泡靠 visibility 隐藏，隐藏态的文字不进无障碍树，
          * 所以可访问名改由 aria-label 显式提供，两者不是一回事。
          */}
        <nav className="app-nav" role="tablist" aria-label="主导航">
          {SECTIONS.map((sec) => (
            <button
              key={sec.key}
              role="tab"
              aria-selected={section === sec.key}
              aria-label={sec.label}
              className={`app-nav-item${section === sec.key ? ' active' : ''}`}
              onClick={() => goSection(sec.key)}
            >
              {sec.icon}
              <span className="app-tip">{sec.label}</span>
            </button>
          ))}
          <PluginNav
            panels={pluginPanels}
            activeId={section === 'plugin' ? pluginId : null}
            onOpen={openPlugin}
          />
        </nav>

        {section === 'discuss' && (
          <div className="titlebar-context">
            <span>{started ? s.topicTitle || '未命名议题' : '多模型议事厅'}</span>
          </div>
        )}

        {/*
          * 提示 chip 住在标题栏的空档里：左边是导航、右边是操作按钮，中间本来就没有内容。
          * 它是 flex 项而不是浮层，所以既压不住菜单也挡不住按钮，body-row 更是一动不动。
          */}
        <div className="titlebar-band">
          <TitlebarNotice persistent={persistent} />
        </div>

        {section === 'discuss' && started && (
          <>
            <span className="round-pill">
              R{s.round}/{s.maxRounds}
            </span>
            <span className="state-tag">
              {aborting ? <Loader2 size={11} className="spin" /> : STATE_ICON[s.state] ?? null}
              {aborting ? '正在终止…' : STATE_LABEL[s.state] ?? s.state}
            </span>
            <span className="round-pill">${s.spentUsd.toFixed(4)}</span>
          </>
        )}
        {section === 'discuss' && started && running && (
          <button
            className="btn danger sm"
            onClick={() => void handleAbort()}
            disabled={aborting}
            title={aborting ? '已发出终止，正在等当前调用收束' : '终止本场并生成部分报告'}
          >
            <Square size={12} />
            {aborting ? '终止中…' : '终止'}
          </button>
        )}
        {section === 'discuss' && settled && s.sessionId && (
          <button className="btn sm primary" onClick={() => s.setReportOpen(true)}>
            <FileText size={12} />
            报告
          </button>
        )}
        {section === 'discuss' && settled && s.sessionId && (
          <button className="btn sm" onClick={handleExport}>
            <Download size={12} />
            导出
          </button>
        )}
        {section === 'discuss' && started && (
          <button
            className="btn sm"
            disabled={running}
            title={running ? '请先终止或等待当前会话完成' : '新建会话'}
            onClick={() => {
              if (running) return
              void window.torra.dismissWebview(s.broadcastTarget ?? '')
              s.reset()
              setStarted(false)
              setReportPath(null)
            }}
          >
            <Plus size={12} />
            新建
          </button>
        )}
        {/*
          * 右端这一组与左端导航共用同一套玻璃胶囊外壳：之前它们是两枚带描边的
          * 圆角方块直接坐在标题栏上，和左边的导航是两种视觉语言，看着像漏在那儿的。
          *
          * 但这两枚不照抄导航的选中态。导航的实心高亮说的是「你在这一屏」，
          * 助手开关说的是「抽屉开着」—— 同一栏里出现两枚实心青色块，
          * 反而分不清哪个才是位置。所以 active 只给一档 accent-soft。
          *
          * title 属性一并去掉：气泡已经承担提示职责，留着会叠出系统白框。
          * 可访问名走 aria-label，助手的长说明（体检 / 接入模型 / 改配置）留在里面。
          */}
        <div className="app-tools">
          <button
            className={`assistant-toggle${assistantOpen ? ' active' : ''}`}
            onClick={toggleAssistant}
            aria-label="助手（体检 / 接入模型 / 改配置）"
          >
            <Sparkles size={15} />
            <span className="app-tip">助手</span>
          </button>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={resolvedTheme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'}
          >
            {resolvedTheme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            <span className="app-tip">{resolvedTheme === 'dark' ? '白天主题' : '黑夜主题'}</span>
          </button>
        </div>
      </div>

      <div className="body-row" ref={rowRef}>
        {(section === 'discuss' || section === 'chat') && (
          <DiscussModelRail
            models={s.models}
            participantIds={s.participantIds}
            moderatorId={s.moderatorId}
            selected={section === 'chat' ? s.chatWebviewTarget : s.broadcastTarget}
            onToggleParticipant={s.toggleParticipant}
            onSelectBroadcast={section === 'chat' ? (id) => s.toggleChatWebview(id) : (id) => void handleSelectBroadcast(id)}
            onReorder={(ids) => void handleReorder(ids)}
            onToggleEnabled={(id, enabled) => void handleToggleEnabled(id, enabled)}
            onRemove={(id) => void handleRemoveModel(id)}
            onClearDisabled={() => void handleClearDisabled()}
            currentRound={section === 'discuss' ? s.round : undefined}
            orchestratorState={section === 'discuss' ? s.state : undefined}
          />
        )}

        <div className="center">
          {/* 内容列：与右边的网页视图列同属 .center 这一行，靠分隔条抢宽度 */}
          <div className="center-main">
            <Suspense fallback={<div className="pane-loading">正在载入这一屏…</div>}>
              {section === 'plugin' ? (
                <PluginPage plugin={pluginPanels.find((p) => p.id === pluginId)} theme={resolvedTheme} />
              ) : section === 'settings' ? (
                <SettingsPage
                  models={s.models}
                  config={{
                    strategy: s.strategy,
                    maxRounds: s.maxRounds,
                    budgetLimitUsd: s.budgetLimitUsd,
                    anonymousReview: s.anonymousReview,
                    baseline: s.baseline,
                    baselineCompare: s.baselineCompare,
                    verifyPass: s.verifyPass,
                    timeBudgetMin: s.timeBudgetMin,
                  }}
                  defaults={s.discussionDefaults}
                  customizedDefaults={customizedDefaults(s.discussionDefaultOverrides)}
                  onSetDefault={(key, value) => void handleSetDiscussionDefault(key, value)}
                  onRestoreFactoryDefaults={() => void handleRestoreFactoryDefaults()}
                  onBack={() => goSection('discuss')}
                  onModelsChanged={async () => {
                    const m = await window.torra.listModels()
                    s.setModels(m)
                  }}
                  onDeleteModel={async (id) => {
                    const m = s.models.find((x) => x.id === id)
                    const r = await window.torra.deleteWebModel(id)
                    if (!r.ok) {
                      warnToast(r.reason ?? '删除失败')
                      return
                    }
                    showToast(`已移除「${m?.displayName ?? id}」`, undefined, 'success')
                  }}
                  onResetConfig={() => s.resetDiscussionConfig()}
                />
              ) : section === 'history' ? (
                <HistoryPage
                  models={s.models}
                  onRetry={(plan, id) => void handleRetry(plan, id)}
                  onReplay={(id) => void handleReplay(id)}
                  onClose={() => goSection('discuss')}
                />
              ) : section === 'chat' ? (
                <ChatPage models={s.models} />
              ) : section === 'agents' ? (
                <AgentsPage />
              ) : section === 'translate' ? (
                <TranslatePage />
              ) : !started ? (
                <NewSession
                  models={s.models}
                  onStart={(notices) => {
                    setStarted(true)
                    /* 材料读不进来必须在议事厅说一声：切屏会把配置页上的提示带走 */
                    if (notices.length > 0) warnToast(`材料：${notices.join('；')}`)
                  }}
                  onPickWebModel={(id) => void handleSelectBroadcast(id)}
                  onGotoSettings={() => goSection('settings')}
                  showIntro={intro}
                  onDismissIntro={dismissIntro}
                  onOpenChat={() => goSection('chat')}
                  onOpenAssistant={() => {
                    if (!assistantOpen) toggleAssistant()
                  }}
                />
              ) : (
                <>
                  <InterventionTicker models={s.models} />
                  <TopicEvolution
                    models={s.models}
                    onFollowup={(agentId, utteranceId, topic) => {
                      // 一键直达：干预条自己切到「追问」、选好目标、聚焦输入框
                      s.setPendingFollowup({ agentId, utteranceId, topic, kind: 'followup' })
                    }}
                    onDuel={(agentId, topic) => {
                      s.setPendingFollowup({ agentId, utteranceId: '', topic, kind: 'duel' })
                    }}
                  />

                  <InterventionBar
                    models={s.models}
                    disabled={!running}
                    onPaused={() => {}}
                  />
                </>
              )}
            </Suspense>
          </div>
        </div>

        {/*
          * 网页列：研讨屏的第三栏位置（F4 定稿）。
          *
          * 它原先浮在议事厅右侧、与正文抢 .center 的宽度；正文改成论题演化图以后，
          * 图要吃的是中间这一整块 —— 再挤一次就是两层叠在同一条竖线上。
          * 所以这一列接管右栏槽位：网页开着时它顶替 aside，关掉时 aside 回来，
          * 同一时刻只有一份内容，宽度也只由这一条分隔管。
          */}
        {section === 'discuss' && s.viewMode === 'broadcast' && s.broadcastTarget
          ? (() => {
              const bm = s.models.find((m) => m.id === s.broadcastTarget)
              return bm ? (
                <>
                  <Splitter
                    dir={-1}
                    label="调整网页视图宽度"
                    measure={() => discWebRef.current?.offsetWidth || 432}
                    min={340}
                    /* 最宽也不能把正文挤没：这一列的上限按整行算，不按会被拖窄的 .center 算 */
                    max={() => Math.min(760, Math.max(340, (rowRef.current?.clientWidth || 1440) - 700))}
                    onResize={setDiscWebW}
                  />
                  <aside className="discuss-webview" ref={discWebRef} style={widthVar('--disc-web-w', discWebW)}>
                    {/* 不给 tabs：这一列是「看这一个模型在干什么」，换模型回左栏点 */}
                    <WebviewDock model={bm} zoomable onClose={closeBroadcast} onRecheck={recheckBroadcast} />
                  </aside>
                </>
              ) : null
            })()
          : section === 'discuss' && started && <RightPanel models={s.models} />}
      </div>

      {assistantOpen && (
        /*
          * 抽屉本体是懒加载的，缺这一格就没有边界 —— React 会一路往上找，
          * 找不到的时候不是「空白」而是整棵树抛错。
          * 兜底用同一个 .assistant-drawer 外壳：位置和宽度由它自己定，
          * 换过去的时候不会看见面板跳一下。
          */
        <Suspense
          fallback={
            <aside className="assistant-drawer" aria-busy="true">
              <div className="pane-loading">正在载入助手…</div>
            </aside>
          }
        >
          <AssistantDrawer
            onClose={() => setAssistantOpen(false)}
            onOpenSettings={() => {
              setAssistantOpen(false)
              goSection('settings')
            }}
          />
        </Suspense>
      )}

      {s.reportOpen && s.sessionId && (
        <Suspense
          fallback={
            <div className="modal-mask">
              <div className="modal report-modal">
                <div className="pane-loading">正在载入报告…</div>
              </div>
            </div>
          }
        >
          <ReportWorkspace
            title={s.topicTitle || '讨论报告'}
            report={s.report}
            sessionId={s.sessionId}
            models={s.models}
            onRegenerate={() => void s.regenerateReport()}
            regenerating={s.reportRegenerating}
            regenNote={s.reportRegenNote}
            onClose={() => s.setReportOpen(false)}
            onExport={(kind) => void handleReportExport(kind, s.sessionId ?? '', s.topicTitle || '未命名研讨')}
            onAskAssistant={(prompt) => {
              if (!assistantOpen) toggleAssistant()
              void window.torra.assistantSend(prompt)
            }}
          />
        </Suspense>
      )}

      {s.riskNotice && (
        <div className="modal-mask">
          <div className="modal">
            <h2>
              <AlertTriangle size={18} />
              使用前须知：网页自动化风险
            </h2>
            <p>{s.riskNotice}</p>
            <p>
              Torra 采用 API 优先原则：若你同时配置了某模型的 API Key 与网页登录，产品默认走 API
              通道，网页仅作备用。API 通道不涉及第三方账号自动化。
            </p>
            <p>
              所有讨论数据、报告与密钥均存储在本机。密钥经操作系统级加密，Torra 不上传、不代管。
            </p>
            <div className="modal-actions">
              <button
                className="btn primary"
                onClick={async () => {
                  await window.torra.acknowledgeRisk()
                  s.setRiskNotice(null)
                }}
              >
                我已理解，继续使用
              </button>
            </div>
          </div>
        </div>
      )}

      <ImageZoomHost />
    </div>
  )
}
