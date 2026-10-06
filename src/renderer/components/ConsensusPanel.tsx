import { useMemo } from 'react'
import { useStore, type ModelSummary } from '../store'
import { ScoreChart } from './ScoreChart'
import { provenanceSummary } from '@shared/anonymity'
import { aggregateLeaderboard } from '@shared/invariants'
import { BarChart3, CheckCircle, AlertTriangle, DollarSign, Sparkles, ShieldCheck, EyeOff, ListOrdered } from 'lucide-react'
import { Markdown } from './Markdown'

export function ConsensusPanel({ models }: { models: ModelSummary[] }) {
  const scores = useStore((s) => s.scores)
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const utterances = useStore((s) => s.utterances)
  const audits = useStore((s) => s.moderatorAudit)
  const anonymousReview = useStore((s) => s.anonymousReview)
  const spentUsd = useStore((s) => s.spentUsd)
  const budgetLimitUsd = useStore((s) => s.budgetLimitUsd)
  const threshold = useStore((s) => s.consensusThreshold)
  const state = useStore((s) => s.state)
  const moderatorUnavailable = useStore((s) => s.moderatorUnavailable)
  const reportReady = useStore((s) => s.reportReady)
  const setReportOpen = useStore((s) => s.setReportOpen)

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const last = scores.length > 0 ? scores[scores.length - 1]! : null

  /**
   * 认同溯源与名次都在渲染端即时计算：两者都能从已落盘的审计/发言推出，
   * 主进程不必为 UI 再算一遍，回放历史会话时也是同一套口径。
   */
  const prov = useMemo(() => provenanceSummary(consensus, utterances), [consensus, utterances])
  const provById = useMemo(() => new Map(prov.points.map((p) => [p.pointId, p])), [prov])
  const leaderboard = useMemo(() => aggregateLeaderboard(audits), [audits])

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
          consensus.map((c) => {
            const p = provById.get(c.id)
            const verifiable =
              c.support.length === 0 || !p ? 0 : Math.round((p.covered.length / c.support.length) * 100)
            return (
              <div key={c.id} className="point-item consensus">
                <Markdown text={c.claim} />
                <div className="point-meta">
                  认同 {c.support.map(nameOf).join('、')} · 第 {c.confirmedRound} 轮
                </div>
                <div className="point-audit">
                  {typeof c.weight === 'number' && (
                    <span className="audit-chip" title="主持评估的证据硬度（0~1），与置信度分列：置信度是「有多确信」，硬度是「有多少独立论据」">
                      硬度 {c.weight.toFixed(2)}
                    </span>
                  )}
                  <span
                    className={`audit-chip${verifiable >= 60 ? ' ok' : verifiable > 0 ? ' warn' : ' bad'}`}
                    title="支持者中，本人在被引用的发言里有原文可核对的比例"
                  >
                    可核对 {verifiable}%
                  </span>
                  {p && p.attributed.length > 0 && (
                    <span className="audit-chip warn" title="主持替这些模型归因，证据里没有他们的发言">
                      代答 {p.attributed.map(nameOf).join('、')}
                    </span>
                  )}
                  {p?.crossExamined && (
                    <span className="audit-chip" title="证据发言里有被他人点名回应的">
                      挨过质询
                    </span>
                  )}
                </div>
              </div>
            )
          })
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
                <Markdown text={d.claim} />
                <div className="point-meta">
                  {d.sides.map((s) => nameOf(s.agentId)).join(' vs ')} · 始于第 {d.openedRound} 轮
                </div>
              </div>
            ))
        )}
      </div>

      <div className="panel-section">
        <div className="panel-title">
          <ShieldCheck size={12} />
          程序校验
        </div>
        {audits.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {moderatorUnavailable ? '无主持小结可校验' : '主持小结尚未产出'}
          </div>
        ) : (
          <>
            {anonymousReview && (
              <div className="audit-mode">
                <EyeOff size={10} />
                匿名轨：主持与参会模型都只看到别名
              </div>
            )}
            <div className="audit-chips">
              <span className={`audit-chip${prov.coverageRate >= 60 ? ' ok' : ' warn'}`}>
                认同可核对 {prov.coverageRate}%
              </span>
              <span className="audit-chip">挨过质询 {prov.crossExaminedRate}%</span>
            </div>
            {[...audits]
              .sort((a, b) => b.round - a.round)
              .map((a) => (
                <details key={`${a.round}-${a.startedAt}`} className="rp-evidence">
                  <summary>
                    第 {a.round} 轮 ·{' '}
                    {a.accepted
                      ? a.attempts.length === 1
                        ? '一次通过'
                        : `${a.attempts.length} 次尝试后通过`
                      : `${a.attempts.length} 次尝试均未通过`}
                    {(a.unknownAliases.length > 0 || a.leakedRealIds.length > 0) && (
                      <span className="audit-chip bad">
                        {[a.unknownAliases.length > 0 && '凭空归因', a.leakedRealIds.length > 0 && '身份泄漏']
                          .filter(Boolean)
                          .join(' + ')}
                      </span>
                    )}
                  </summary>
                  {a.aliases && (
                    <div className="audit-alias">
                      {Object.entries(a.aliases).map(([alias, id]) => (
                        <span key={alias}>
                          {alias} = {nameOf(id)}
                        </span>
                      ))}
                    </div>
                  )}
                  {a.unknownAliases.length > 0 && (
                    <div className="audit-line bad">
                      小结引用了未登记的别名（已被拒绝）：{a.unknownAliases.join('、')}
                    </div>
                  )}
                  {a.leakedRealIds.length > 0 && (
                    <div className="audit-line warn">
                      匿名轨里写出了真实模型 id：{a.leakedRealIds.map(nameOf).join('、')}
                    </div>
                  )}
                  {a.attempts.map((at) => (
                    <div key={at.attempt} className="audit-attempt">
                      <div className="audit-attempt-head">
                        <span className={at.ok ? 'audit-ok' : 'audit-bad'}>#{at.attempt} {at.ok ? '通过' : '驳回'}</span>
                        <span>{(at.ms / 1000).toFixed(1)}s</span>
                        <span>${at.costUsd.toFixed(4)}</span>
                        {at.validation.warnings.length > 0 && (
                          <span title={at.validation.warnings.join('\n')}>警告 {at.validation.warnings.length}</span>
                        )}
                      </div>
                      {a.accepted && at.ok && (
                        <div className="audit-line">
                          程序抽出：共识 {a.accepted.consensus_points.length} 条 / 分歧{' '}
                          {a.accepted.open_disputes.length} 项 / 名次 {a.accepted.agent_quality?.length ?? 0} 条
                        </div>
                      )}
                      {!at.ok &&
                        (at.validation.errors.length > 0 || at.error) && (
                          <div className="audit-line bad">{(at.error ? [at.error] : at.validation.errors).join('；')}</div>
                        )}
                      <pre className="audit-raw">{at.raw || '（本次尝试没有拿到正文）'}</pre>
                    </div>
                  ))}
                </details>
              ))}
          </>
        )}
      </div>

      {leaderboard.length > 0 && (
        <div className="panel-section">
          <div className="panel-title">
            <ListOrdered size={12} />
            互评名次
          </div>
          {leaderboard.map((row) => (
            <div key={row.agentId} className="lb-row" title={row.rationale ?? undefined}>
              <span className="lb-rank">{row.averageRank.toFixed(1)}</span>
              <span className="lb-name">{nameOf(row.agentId)}</span>
              <span className="lb-rounds">{row.rounds} 轮</span>
            </div>
          ))}
          <div className="audit-hint">跨轮平均名次，仅作相对参考，不参与共识度加权。</div>
        </div>
      )}

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
          <div className="rp-report-row">
            <span style={{ fontSize: 11, color: 'var(--consensus)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle size={12} />
              {reportReady ? '讨论已结束，报告已生成' : '讨论已结束，报告生成中…'}
            </span>
            {reportReady && (
              <button className="btn sm" onClick={() => setReportOpen(true)}>
                查看报告
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
