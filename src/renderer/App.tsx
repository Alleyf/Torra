import { useEffect, useState } from 'react'
import { useStore, type OrchestratorEventPayload } from './store'
import { ModelRail, getFaviconUrls } from './components/ModelRail'
import { DiscussionFlow } from './components/DiscussionFlow'
import { RightPanel } from './components/RightPanel'
import { NewSession } from './components/NewSession'
import { ChatPage } from './components/ChatPage'
import { WebviewDock } from './components/WebviewDock'
import { SettingsPage } from './components/SettingsPage'
import { HistoryPage } from './components/HistoryPage'
import { InterventionBar, InterventionTicker } from './components/InterventionBar'
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
  Sun,
  Moon,
} from 'lucide-react'
import { toggleTheme, useResolvedTheme } from './theme'

type Section = 'discuss' | 'chat' | 'history' | 'settings'

const SECTIONS: Array<{ key: Section; label: string; icon: React.ReactNode }> = [
  { key: 'discuss', label: '研讨', icon: <MessagesSquare size={13} /> },
  { key: 'chat', label: '聊天', icon: <MessageCircle size={13} /> },
  { key: 'history', label: '历史', icon: <History size={13} /> },
  { key: 'settings', label: '设置', icon: <Settings size={13} /> },
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

export default function App() {
  const s = useStore()
  const resolvedTheme = useResolvedTheme()
  // 顶层导航：研讨 / 聊天 / 历史 / 设置，始终可见
  const [section, setSection] = useState<Section>('discuss')
  // started 仅对「研讨」有意义：首页配置中 vs 一场讨论进行中/回看
  const [started, setStarted] = useState(false)
  const [reportPath, setReportPath] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [toastAction, setToastAction] = useState<(() => void) | null>(null)

  /**
   * 切换顶层分区。
   * 离开「研讨」时若正挂着网页视图，必须先收起主进程内嵌的 WebContentsView ——
   * 它永远盖在渲染层之上，不收起会遮罩聊天/历史/设置。
   */
  const goSection = (next: Section) => {
    if (next !== 'discuss' && s.viewMode === 'broadcast') {
      void window.torra.dismissWebview(s.broadcastTarget ?? '')
      s.setViewMode('hall')
    }
    setSection(next)
  }

  /**
   * 提示条。action 用于需要用户确认后续动作的场景 ——
   * 如「登录窗口已打开」，登录完成时机由用户掌握，不该用固定 setTimeout 去猜。
   */
  const showToast = (m: string, action?: { actionLabel: string; onAction: () => void }) => {
    setToast(m)
    setToastAction(action ? () => action.onAction : null)
    setTimeout(() => {
      setToast(null)
      setToastAction(null)
    }, action ? 30_000 : 3600)
  }

  const handleRetry = async (plan: RetryPlan, sessionId: string) => {
    const r = await window.torra.retrySession(sessionId, plan)
    if (!r.ok) {
      showToast(`无法重试：${(r.errors ?? []).join('；')}`)
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
      showToast('无法载入该会话记录')
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
    const offEvent = window.torra.on('orchestrator:event', (p) => {
      s.applyEvent(p as OrchestratorEventPayload)
    })
    const offRisk = window.torra.on('risk:show', (p) => {
      s.setRiskNotice((p as { message: string }).message)
    })
    const offReport = window.torra.on('report:ready', (p) => {
      const { sessionId } = p as { sessionId: string }
      s.setReport(sessionId, null)
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
        showToast(`「${name}」登录成功，会话已生效`)
        return
      }
      // 仍未就绪：给出可执行的下一步，而不是让用户反复重试
      void window.torra.diagnoseLogin(modelId).then((d) => {
        if (!d.ok) {
          showToast(`「${name}」诊断失败：${d.reason ?? '未知原因'}`)
          return
        }
        showToast(`「${name}」${d.verdict}`, {
          actionLabel: '重新复核',
          onAction: async () => {
            await window.torra.refreshLogin(modelId)
            void window.torra.listModels().then((m) => s.setModels(m))
          },
        })
      })
      void reason
    })
    return () => {
      offEvent()
      offRisk()
      offReport()
      offAdapter()
      offModels()
      offLogin()
      offInventory()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const running =
    s.state !== 'INIT' && s.state !== 'READY' && s.state !== 'DONE' && s.state !== 'ABORTED'

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
    showToast(r.ok ? '登录态已确认' : (r.reason ?? '仍未就绪'))
  }

  const handleExport = async () => {
    if (!s.sessionId) return
    const r = await window.torra.exportMarkdown(s.sessionId)
    if (r.ok && r.path) setReportPath(r.path)
  }

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-brand">
          <span className="brand-mark">T</span>
          <strong>Torra</strong>
        </div>

        <nav className="app-nav" role="tablist" aria-label="主导航">
          {SECTIONS.map((sec) => (
            <button
              key={sec.key}
              role="tab"
              aria-selected={section === sec.key}
              className={`app-nav-item${section === sec.key ? ' active' : ''}`}
              onClick={() => goSection(sec.key)}
            >
              {sec.icon}
              <span>{sec.label}</span>
            </button>
          ))}
        </nav>

        {section === 'discuss' && (
          <div className="titlebar-context">
            <span>{started ? s.topicTitle || '未命名议题' : '多模型议事厅'}</span>
          </div>
        )}

        <div className="titlebar-spacer" />

        {section === 'discuss' && started && (
          <>
            <span className="round-pill">
              R{s.round}/{s.maxRounds}
            </span>
            <span className="state-tag">
              {STATE_ICON[s.state] ?? null}
              {STATE_LABEL[s.state] ?? s.state}
            </span>
            <span className="round-pill">${s.spentUsd.toFixed(4)}</span>
          </>
        )}
        {section === 'discuss' && started && running && (
          <button
            className="btn danger sm"
            onClick={async () => {
              await window.torra.abortSession()
            }}
          >
            <Square size={12} />
            终止
          </button>
        )}
        {section === 'discuss' && s.state === 'DONE' && s.sessionId && (
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
        <button
          className="btn icon theme-toggle"
          onClick={toggleTheme}
          title={resolvedTheme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'}
          aria-label={resolvedTheme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'}
        >
          {resolvedTheme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>

      {s.stalledNotice && (
        <div className="banner warn">
          <AlertTriangle size={14} />
          共识度连续 2 轮未上升。建议：要求某模型换角度反驳 / 提高阈值收束 / 手动插话纠偏
          <button className="btn sm" onClick={s.dismissStall}>
            知道了
          </button>
        </div>
      )}
      {s.paused && (
        <div className="banner danger">
          <AlertCircle size={14} />
          {s.moderatorNote ?? '已暂停'}
        </div>
      )}
      {s.budgetLimited && (
        <div className="banner warn">
          <AlertTriangle size={14} />
          已达预算上限，剩余轮次将不再发言，报告标注「预算受限」
        </div>
      )}
      {reportPath && (
        <div className="banner">
          <CheckCircle size={14} />
          报告已导出：<code style={{ fontFamily: 'var(--font-mono)' }}>{reportPath}</code>
          <button className="btn sm" onClick={() => setReportPath(null)}>
            <X size={12} />
          </button>
        </div>
      )}
      {toast && (
        <div className="banner">
          <CheckCircle size={14} />
          {toast}
          {toastAction && (
            <button
              className="btn sm"
              onClick={() => {
                toastAction()
                setToast(null)
                setToastAction(null)
              }}
            >
              刷新状态
            </button>
          )}
        </div>
      )}

      <div className="body-row">
        {(section === 'discuss' || section === 'chat') && (
          <ModelRail
            models={s.models}
            participantIds={s.participantIds}
            moderatorId={s.moderatorId}
            selected={s.broadcastTarget}
            onToggleParticipant={s.toggleParticipant}
            onSelectBroadcast={section === 'chat' ? s.toggleParticipant : (id) => void handleSelectBroadcast(id)}
            utterances={section === 'discuss' ? s.utterances : undefined}
            currentRound={section === 'discuss' ? s.round : undefined}
            orchestratorState={section === 'discuss' ? s.state : undefined}
            onDeleteModel={async (id) => {
              const m = s.models.find((x) => x.id === id)
              const r = await window.torra.deleteWebModel(id)
              if (!r.ok) {
                showToast(r.reason ?? '删除失败')
                return
              }
              showToast(`已移除「${m?.displayName ?? id}」`)
              void window.torra.listModels().then((x) => s.setModels(x))
            }}
          />
        )}

        <div className="center">
          {section === 'settings' ? (
            <SettingsPage
              models={s.models}
              onBack={() => goSection('discuss')}
              onModelsChanged={async () => {
                const m = await window.torra.listModels()
                s.setModels(m)
              }}
              onDeleteModel={async (id) => {
                const m = s.models.find((x) => x.id === id)
                const r = await window.torra.deleteWebModel(id)
                if (!r.ok) {
                  showToast(r.reason ?? '删除失败')
                  return
                }
                showToast(`已移除「${m?.displayName ?? id}」`)
              }}
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
          ) : s.viewMode === 'broadcast' && s.broadcastTarget ? (
            (() => {
              const bm = s.models.find((m) => m.id === s.broadcastTarget)
              return bm ? (
                <WebviewDock model={bm} onClose={closeBroadcast} onRecheck={recheckBroadcast} />
              ) : null
            })()
          ) : !started ? (
            <NewSession models={s.models} onStart={() => setStarted(true)} />
          ) : (
            <>
              <div className="view-subnav">
                <button className="vs-tab active" onClick={closeBroadcast}>
                  议事厅
                </button>
                <button
                  className="vs-tab"
                  onClick={() => {
                    const target = s.broadcastTarget ?? s.participantIds[0]
                    if (!target) return
                    openBroadcast(target)
                  }}
                >
                  网页视图
                </button>
              </div>

              <InterventionTicker models={s.models} />
              <DiscussionFlow
                models={s.models}
                onFollowup={(agentId, utteranceId, topic) => {
                  s.setPendingFollowup({ agentId, utteranceId, topic })
                  showToast(
                    `已选中 ${s.models.find((m) => m.id === agentId)?.displayName ?? agentId} 的发言，请切到「追问」输入问题`,
                  )
                }}
                onDuel={(agentId, topic) => {
                  showToast(
                    `已选中 ${s.models.find((m) => m.id === agentId)?.displayName ?? agentId}，请切到「对辩」补选对手并填入议题`,
                  )
                  s.setPendingFollowup({ agentId, utteranceId: '', topic })
                }}
              />

              <InterventionBar
                models={s.models}
                disabled={!running}
                onPaused={() => {}}
              />
            </>
          )}
        </div>

        {section === 'discuss' && started && <RightPanel models={s.models} />}
      </div>

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
    </div>
  )
}
