import { Plus, X, PanelLeftClose, PanelLeftOpen, Shield } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ModelSummary, UiUtterance } from '../store'

const STATUS_COLOR: Record<string, string> = {
  ready: 'var(--consensus)',
  busy: 'var(--warn)',
  expired: 'var(--warn)',
  'adapter-broken': 'var(--danger)',
  disabled: 'var(--text-3)',
  absent: 'var(--text-3)',
}

const STATUS_TEXT: Record<string, string> = {
  ready: '可发言',
  busy: '发言中',
  expired: '需要登录',
  'adapter-broken': '适配器异常',
  disabled: '未启用',
  absent: '本轮缺席',
}

function statusHint(m: { transport: string; status: string; hasKey: boolean }): string {
  // 诊断理由透传约定：判定依据：${m.loginNote}
  if (m.transport === 'api' && m.status === 'disabled') {
    return m.hasKey ? 'API 不可用' : '未配置 API Key · 请在设置页配置密钥'
  }
  return STATUS_TEXT[m.status] ?? m.status
}

export function initials(name: string): string {
  const trimmed = name.trim()
  if (/^[\u4e00-\u9fa5]/.test(trimmed)) return trimmed.slice(0, 1)
  return trimmed.slice(0, 2).toUpperCase()
}

export function getFaviconUrls(domain?: string): string[] {
  if (!domain) return []
  return [
    `https://api.iowen.cn/favicon/${domain}.png`,
    `https://favicon.im/${domain}`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://favicon.yandex.net/favicon/v2/${domain}?size=32`,
    `https://logo.clearbit.com/${domain}`,
  ]
}

function AvatarWithFavicon({ m }: { m: ModelSummary }) {
  const [faviconIndex, setFaviconIndex] = useState(0)
  const faviconUrls = getFaviconUrls(m.domain)

  if (faviconUrls.length === 0 || faviconIndex >= faviconUrls.length) {
    return <span className="model-initials">{initials(m.displayName)}</span>
  }

  return (
    <img
      src={faviconUrls[faviconIndex]}
      alt=""
      crossOrigin="anonymous"
      onError={() => setFaviconIndex((prev) => prev + 1)}
    />
  )
}

export function ModelRail({
  models,
  participantIds,
  moderatorId,
  selected,
  onToggleParticipant,
  onSelectBroadcast,
  onAddModel,
  onDeleteModel,
  utterances,
  currentRound,
  orchestratorState,
}: {
  models: ModelSummary[]
  participantIds: string[]
  moderatorId: string | null
  selected: string | null
  onToggleParticipant: (id: string) => void
  onSelectBroadcast: (id: string) => void
  onAddModel?: () => void
  onDeleteModel?: (id: string) => void
  utterances?: UiUtterance[]
  currentRound?: number
  orchestratorState?: string
}) {
  const getAgentSpeakingStatus = (agentId: string): 'streaming' | 'done' | 'pending' | null => {
    if (!utterances || !currentRound) return null
    const isRunning = orchestratorState && !['INIT', 'READY', 'DONE', 'ABORTED', 'FAILED'].includes(orchestratorState)
    if (!isRunning) return null
    const agentUtterances = utterances.filter((u) => u.agentId === agentId && u.round === currentRound)
    if (agentUtterances.length === 0) return 'pending'
    const latest = agentUtterances[agentUtterances.length - 1]
    if (!latest) return 'pending'
    return latest.streaming ? 'streaming' : 'done'
  }

  // 折叠态持久化：跨刷新保留，纯本地 UI 偏好，不进 store。
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('torra.rail.collapsed') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('torra.rail.collapsed', collapsed ? '1' : '0')
    } catch {
      /* 隐私模式下 localStorage 不可用，忽略 */
    }
  }, [collapsed])

  const statusFor = (m: ModelSummary) => {
    const inPanel = participantIds.includes(m.id)
    const isModerator = moderatorId === m.id
    const speakingStatus = getAgentSpeakingStatus(m.id)
    let statusDotColor = STATUS_COLOR[m.status] ?? 'var(--text-3)'
    if (speakingStatus === 'streaming') statusDotColor = 'var(--warn)'
    if (speakingStatus === 'done') statusDotColor = 'var(--consensus)'
    if (speakingStatus === 'pending') statusDotColor = 'var(--text-3)'
    const statusText =
      speakingStatus === 'streaming' ? '正在发言'
        : speakingStatus === 'done' ? '本轮完成'
          : speakingStatus === 'pending' ? '等待发言'
            : STATUS_TEXT[m.status] ?? m.status
    return { inPanel, isModerator, speakingStatus, statusDotColor, statusText }
  }

  const onCardActivate = (m: ModelSummary) => {
    if (m.transport === 'webview') onSelectBroadcast(m.id)
    else onToggleParticipant(m.id)
  }

  if (collapsed) {
    return (
      <aside className="model-rail collapsed">
        <button
          className="rail-toggle"
          title="展开模型栏"
          onClick={() => setCollapsed(false)}
        >
          <PanelLeftOpen size={16} />
        </button>
        <span className="rail-count-sm">{participantIds.length}</span>
        <div className="rail-collapsed-list">
          {models.map((m) => {
            const { inPanel, isModerator, speakingStatus, statusDotColor } = statusFor(m)
            return (
              <div
                key={m.id}
                className={[
                  'rail-collapsed-item',
                  inPanel ? 'in-panel' : '',
                  selected === m.id ? 'selected' : '',
                  isModerator ? 'moderator' : '',
                ].filter(Boolean).join(' ')}
                title={`${m.displayName} · ${statusFor(m).statusText}${isModerator ? ' · 主持' : ''}${inPanel ? ' · 已加入' : ' · 点击加入'}`}
                onClick={() => onCardActivate(m)}
                onDoubleClick={() => onToggleParticipant(m.id)}
              >
                <div className="model-card-avatar" style={{ borderColor: statusDotColor }}>
                  <AvatarWithFavicon m={m} />
                  <span
                    className={`status-dot${speakingStatus === 'streaming' ? ' streaming' : ''}`}
                    style={{ background: statusDotColor }}
                  />
                </div>
                {isModerator && <span className="rail-collapsed-shield" title="主持"><Shield size={8} /></span>}
              </div>
            )
          })}
        </div>
      </aside>
    )
  }

  return (
    <aside className="model-rail">
      <div className="model-rail-head">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <strong>模型</strong>
        </div>
        <div className="rail-head-right">
          <span className="rail-count">{participantIds.length} 已选</span>
          <button
            className="rail-toggle"
            title="收起模型栏"
            onClick={() => setCollapsed(true)}
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
      </div>

      <div className="rail-section-label">可用模型</div>
      <div className="rail-list">
        {models.map((m) => {
          const { inPanel, isModerator, speakingStatus, statusDotColor, statusText } = statusFor(m)

          return (
            <div key={m.id} className="model-card-wrap">
              <div
                className={[
                  'model-card',
                  selected === m.id ? 'selected' : '',
                  inPanel ? 'in-panel' : '',
                  m.status === 'expired' || m.status === 'adapter-broken' ? 'needs-attention' : '',
                ].filter(Boolean).join(' ')}
                title={`${m.displayName} · ${statusHint(m)}${isModerator ? ' · 主持' : ''}${inPanel ? '' : ' · 双击加入本场'}`}
                onClick={() => onCardActivate(m)}
                // invariant: onClick={() => onSelectBroadcast(m.id)} remains the single webview entry
                onDoubleClick={() => onToggleParticipant(m.id)}
              >
                <div className="model-card-avatar" style={{ borderColor: statusDotColor }}>
                  <AvatarWithFavicon m={m} />
                  <span className={`status-dot${speakingStatus === 'streaming' ? ' streaming' : ''}`} style={{ background: statusDotColor }} />
                </div>
                <div className="model-card-copy">
                  <div className="model-card-name">
                    <span>{m.displayName}</span>
                    {isModerator && <span className="model-role">主持</span>}
                  </div>
                  <div className="model-card-meta">
                    <span className={`model-status status-${m.status}`}>
                      <span className="status-mini-dot" style={{ background: statusDotColor }} />
                      {statusText}
                    </span>
                    <span>{m.transport === 'webview' ? '网页' : 'API'}</span>
                  </div>
                </div>
                <span className={`model-check${inPanel ? ' checked' : ''}`} aria-hidden="true">{inPanel ? '✓' : '+'}</span>
              </div>
              {m.userDefined && onDeleteModel && (
                <button className="rail-del" title={`移除自建模型「${m.displayName}」`} onClick={() => onDeleteModel(m.id)}>
                  <X size={9} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {onAddModel && (
        <button className="model-add" title="添加网页版模型" onClick={onAddModel}>
          <Plus size={14} />
          添加模型
        </button>
      )}
      <div className="rail-footnote">单击网页模型查看页面 · 双击加入讨论</div>
    </aside>
  )
}
