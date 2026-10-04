import { useStore, type ModelSummary } from '../store'
import { ScoreChart } from './ScoreChart'
import { BarChart3, CheckCircle, AlertTriangle, DollarSign, Sparkles } from 'lucide-react'

export function ConsensusPanel({ models }: { models: ModelSummary[] }) {
  const scores = useStore((s) => s.scores)
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const spentUsd = useStore((s) => s.spentUsd)
  const budgetLimitUsd = useStore((s) => s.budgetLimitUsd)
  const threshold = useStore((s) => s.consensusThreshold)
  const state = useStore((s) => s.state)
  const moderatorUnavailable = useStore((s) => s.moderatorUnavailable)

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const last = scores.length > 0 ? scores[scores.length - 1]! : null

  const budgetPct = Math.min(100, (spentUsd / Math.max(budgetLimitUsd, 0.01)) * 100)
  const budgetColor = budgetPct >= 100 ? 'var(--danger)' : budgetPct >= 80 ? 'var(--warn)' : 'var(--text-3)'

  const scorePct = last ? Math.min(100, (last.score / threshold) * 100) : 0
  const scoreColor = last
    ? last.score >= threshold
      ? 'var(--consensus)'
      : last.score >= threshold * 0.7
        ? 'var(--accent)'
        : 'var(--text-3)'
    : 'var(--text-3)'

  return (
    <div className="rp-consensus">
      <div className="panel-section">
        <div className="panel-title">
          <BarChart3 size={12} />
          共识度
        </div>
        {last && !moderatorUnavailable ? (
          <div className="score-hero">
            <div className="score-hero-num" style={{ color: scoreColor }}>
              {last.score}
            </div>
            <div className="score-hero-meta">
              <div className="score-hero-label">综合 / 阈值 {threshold}</div>
              <div className="score-hero-track">
                <div
                  className="score-hero-fill"
                  style={{ width: `${scorePct}%`, background: scoreColor }}
                />
              </div>
            </div>
          </div>
        ) : (
          <ScoreChart scores={scores} threshold={threshold} />
        )}
        {last && !moderatorUnavailable ? (
          <div className="dims">
            <div className="dim-box">
              <div className="dim-label">立场一致</div>
              <div className="dim-value">{last.agreement}</div>
            </div>
            <div className="dim-box">
              <div className="dim-label">论点重合</div>
              <div className="dim-value">{last.overlap}</div>
            </div>
            <div className="dim-box">
              <div className="dim-label">收敛趋势</div>
              <div className="dim-value">{last.trend}</div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
            {moderatorUnavailable ? '主持不可用，共识度不可用' : '尚无评分'}
          </div>
        )}
        {last && !moderatorUnavailable && <ScoreChart scores={scores} threshold={threshold} />}
      </div>

      <div className="panel-section">
        <div className="panel-title">
          <CheckCircle size={12} />
          共识点 ({consensus.length})
        </div>
        {consensus.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="pulse" />
            形成中
          </div>
        ) : (
          consensus.map((c) => (
            <div key={c.id} className="point-item consensus">
              {c.claim}
              <div className="point-meta">
                认同 {c.support.map(nameOf).join('、')} · 第 {c.confirmedRound} 轮
              </div>
            </div>
          ))
        )}
      </div>

      <div className="panel-section">
        <div className="panel-title">
          <AlertTriangle size={12} />
          保留分歧 ({disputes.filter((d) => d.status === 'open').length})
        </div>
        {disputes.filter((d) => d.status === 'open').length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>暂无</div>
        ) : (
          disputes
            .filter((d) => d.status === 'open')
            .map((d) => (
              <div key={d.id} className="point-item dispute">
                {d.claim}
                <div className="point-meta">
                  {d.sides.map((s) => nameOf(s.agentId)).join(' vs ')} · 始于第 {d.openedRound} 轮
                </div>
              </div>
            ))
        )}
      </div>

      <div className="panel-section">
        <div className="panel-title">
          <DollarSign size={12} />
          费用
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span style={{ color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
            ${spentUsd.toFixed(4)}
          </span>
          <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
            / ${budgetLimitUsd.toFixed(2)}
          </span>
        </div>
        <div style={{ height: 3, background: 'var(--border)', marginTop: 8, borderRadius: 2 }}>
          <div
            style={{
              height: '100%',
              width: `${budgetPct}%`,
              background: budgetColor,
              borderRadius: 2,
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      </div>

      {state === 'DONE' && (
        <div className="panel-section">
          <div className="panel-title">
            <Sparkles size={12} />
            状态
          </div>
          <div style={{ fontSize: 11, color: 'var(--consensus)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <CheckCircle size={12} />
            讨论已结束，报告已生成
          </div>
        </div>
      )}
    </div>
  )
}
