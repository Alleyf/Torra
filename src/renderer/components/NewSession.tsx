import { useState } from 'react'
import { useStore, type ModelSummary } from '../store'
import { initials, getFaviconUrls } from './ModelRail'
import { MessageSquare, Users, Crown, Settings2, Play, AlertTriangle, Zap, Target, DollarSign } from 'lucide-react'

const STRATEGY_LABEL: Record<string, string> = {
  roundtable: '圆桌',
  debate: '辩论',
  review: '评审',
}

const STRATEGY_ICONS: Record<string, React.ReactNode> = {
  roundtable: <Users size={12} />,
  debate: <Zap size={12} />,
  review: <Target size={12} />,
}

function FaviconCheckItem({
  m,
  on,
  blocked,
  faviconUrls,
  onToggle,
}: {
  m: ModelSummary
  on: boolean
  blocked: boolean
  faviconUrls: string[]
  onToggle: () => void
}) {
  const [faviconIndex, setFaviconIndex] = useState(0)

  return (
    <div
      className={`check-item${on ? ' on' : ''}${blocked ? ' disabled' : ''}`}
      title={
        blocked
          ? '该模型会话过期或适配器失效，需先在左栏点击头像重新登录'
          : m.adapterStale
            ? '适配器长期未验证，可能已失效'
            : ''
      }
      onClick={onToggle}
    >
      {faviconUrls.length > 0 && faviconIndex < faviconUrls.length ? (
        <img
          src={faviconUrls[faviconIndex]}
          alt=""
          crossOrigin="anonymous"
          style={{ width: 14, height: 14, flex: '0 0 14px' }}
          onError={() => setFaviconIndex((prev) => prev + 1)}
        />
      ) : (
        <span className="check-dot" style={{ background: m.color }} />
      )}
      <span style={{ flex: 1 }}>{m.displayName}</span>
      <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
        {m.transport === 'webview' ? '网页' : m.hasKey ? 'API' : '无Key'}
      </span>
    </div>
  )
}

export function NewSession({ models, onStart }: { models: ModelSummary[]; onStart: () => void }) {
  const s = useStore()

  const webviewBlocked = models.filter(
    (m) => m.transport === 'webview' && (m.status === 'expired' || m.status === 'adapter-broken'),
  )

  /**
   * 主持候选：只有 API 模型能担任。
   * 网页通道无法产出结构化小结；缺 Key 的 API 模型一调用就抛错。
   * 二者都保留在列表里但置灰，否则用户会以为「没有这个选项」而不是「这个选项不能用」。
   */
  const moderatorOptions = models.filter(
    (m) => m.transport === 'api' && m.supportsStructuredOutput,
  )

  const canStart = s.topicTitle.trim().length > 0 && s.participantIds.length > 0

  const handleStart = async () => {
    const result = await window.torra.startSession(
      {
        id: `topic_${Date.now()}`,
        title: s.topicTitle.trim(),
        background: s.topicBackground.trim(),
        strategy: s.strategy,
        attachments: [],
        createdAt: Date.now(),
      },
      {
        maxRounds: s.maxRounds,
        consensusThreshold: s.consensusThreshold,
        participantIds: s.participantIds,
        moderatorId: s.moderatorId,
        budgetLimitUsd: s.budgetLimitUsd,
      },
    )
    if (!result.ok) return
    onStart()
  }

  return (
    <div className="discussion-flow start-scroll">
      <div className="empty-card">
        <div className="start-kicker">TORRA / 多模型议事厅</div>
        <h2>把一个问题，变成一场有结论的讨论</h2>
        <p className="start-lede">让多个模型分别分析、互相质疑，再由主持模型整理出共识与保留分歧。</p>

        <div className="field">
          <label>
            <MessageSquare size={11} />
            议题标题
          </label>
          <input
            type="text"
            value={s.topicTitle}
            placeholder="评估为报表系统引入实时计算层的必要性"
            onChange={(e) => s.patchConfig({ topicTitle: e.target.value })}
          />
        </div>
        <div className="field">
          <label>背景材料</label>
          <textarea
            value={s.topicBackground}
            placeholder="可选。当前系统日均查询 2 万次，报表生成延迟 P95 约 8 秒…"
            onChange={(e) => s.patchConfig({ topicBackground: e.target.value })}
          />
        </div>

        <div className="field">
          <label>
            <Users size={11} />
            参与模型
          </label>
          <div className="check-grid">
            {models.map((m) => {
              const on = s.participantIds.includes(m.id)
              const blocked =
                m.transport === 'webview' && (m.status === 'expired' || m.status === 'adapter-broken')
              const faviconUrls = getFaviconUrls(m.domain)
              return (
                <FaviconCheckItem
                  key={m.id}
                  m={m}
                  on={on}
                  blocked={blocked}
                  faviconUrls={faviconUrls}
                  onToggle={() => {
                    if (!blocked) s.toggleParticipant(m.id)
                  }}
                />
              )
            })}
          </div>
        </div>

        <div className="field">
          <label>
            <Crown size={11} />
            主持模型（默认不参与发言）
          </label>
          <select
            value={s.moderatorId ?? ''}
            onChange={(e) => s.patchConfig({ moderatorId: e.target.value || null })}
          >
            <option value="">无主持（跑满轮次直接出报告）</option>
            {moderatorOptions.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.hasKey}>
                {m.displayName}
                {m.hasKey ? '' : '（未填 API Key）'}
              </option>
            ))}
          </select>
          {/* 网页通道不进列表：它无法产出结构化小结，选中后讨论会在结尾静默降级成无主持 */}
          {moderatorOptions.length === 0 && (
            <p className="field-hint">
              主持只能由 API 模型担任。在设置页「API 模型」中自建并填好 Key，这里才会出现可用项。
            </p>
          )}
        </div>

        <div className="field">
          <label>
            <Settings2 size={11} />
            策略
          </label>
          <div className="strategy-grid">
            {(['roundtable', 'debate', 'review'] as const).map((k) => (
              <button
                key={k}
                className={`strategy-choice${s.strategy === k ? ' active' : ''}`}
                onClick={() => s.patchConfig({ strategy: k })}
              >
                <span className="strategy-icon">{STRATEGY_ICONS[k]}</span>
                <span>{STRATEGY_LABEL[k]}</span>
                <small>{k === 'roundtable' ? '并行发言' : k === 'debate' ? '互相反驳' : '审阅与打分'}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>最大轮次</label>
            <input
              type="number"
              min={1}
              max={8}
              value={s.maxRounds}
              onChange={(e) => s.patchConfig({ maxRounds: Number(e.target.value) || 3 })}
            />
          </div>
          <div className="field">
            <label>共识阈值 (%)</label>
            <input
              type="number"
              min={50}
              max={100}
              value={s.consensusThreshold}
              onChange={(e) => s.patchConfig({ consensusThreshold: Number(e.target.value) || 85 })}
            />
          </div>
          <div className="field">
            <label>
              <DollarSign size={11} />
              预算上限 ($)
            </label>
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={s.budgetLimitUsd}
              onChange={(e) => s.patchConfig({ budgetLimitUsd: Number(e.target.value) || 2 })}
            />
          </div>
        </div>

        {webviewBlocked.length > 0 && (
          <div className="banner warn" style={{ marginBottom: 12, borderRadius: 'var(--radius-sm)', display: 'flex' }}>
            <AlertTriangle size={14} />
            {webviewBlocked.map((m) => m.displayName).join('、')} 会话过期或适配器失效，请先在左栏点击其头像重新登录
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className="btn primary" onClick={handleStart} disabled={!canStart}>
            <Play size={13} />
            开始讨论
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.8 }}>
          轮内模型并行发言，轮间串行小结。默认配置下约 2~4 分钟出报告。
          <br />
          已选 {s.participantIds.length} 个参与模型
          {s.participantIds.length > 0 && (
            <>
              ：{s.participantIds.map((id) => models.find((m) => m.id === id) && initials(models.find((m) => m.id === id)!.displayName)).join(' ')}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
