import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Eye,
  FlaskConical,
  GitBranch,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Swords,
  TrendingUp,
  Users,
  X,
} from 'lucide-react'
import type {
  ConsensusReportItem,
  ConsensusVerificationStatus,
  CorrectionOutcome,
  DiscussionStage,
  HallucinationTrajectory,
  Report,
  ReportParticipation,
  ReportRoundRow,
} from '@shared/types'
import { plainMd } from '../textFormat'

const STAGE_LABEL: Record<DiscussionStage, string> = {
  'agent-batch': '并行发言',
  moderator: '主持小结',
  consensus: '收敛判定',
  report: '报告生成',
  baseline: '单模型基线',
  verification: '幻觉核验轮',
}

const TRAJECTORY_META: Record<HallucinationTrajectory, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  self_correcting: { label: '跨轮自我矫正', tone: 'ok' },
  flat: { label: '跨轮持平', tone: 'warn' },
  compounding: { label: '跨轮累积恶化', tone: 'bad' },
  insufficient_data: { label: '轮次不足', tone: 'warn' },
}

const VERIFY_STATUS_META: Record<ConsensusVerificationStatus, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  unverified: { label: '未核验', tone: 'warn' },
  verified: { label: '本人确认', tone: 'ok' },
  disputed: { label: '被否认/存疑', tone: 'bad' },
  vacated: { label: '已撤回', tone: 'bad' },
}

const CORRECTION_OUTCOME_META: Record<CorrectionOutcome, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  confirmed: { label: '确认', tone: 'ok' },
  denied: { label: '否认', tone: 'bad' },
  clarified: { label: '修正', tone: 'warn' },
  no_response: { label: '无应答', tone: 'warn' },
}

const BASELINE_VERDICT_LABEL: Record<string, string> = {
  council_better: '研讨优于基线',
  baseline_better: '基线反而更好',
  mixed: '互有胜负',
  inconclusive: '无法判定',
}

/**
 * 报告正文视图。历史详情与议事厅共用一份：
 * 议事厅结束后如果只能「导出到磁盘」，用户会以为报告没生成。
 *
 * 分层固定为「结论 → 依据 → 过程 → 风险 → 下一步 → 口径」：
 * 读报告的人第一屏要拿到判断和它的可信度，而不是一堆并列的条目。
 */

const LEVEL_META = {
  strong: { label: '结论稳固', color: 'var(--consensus)', hint: '可作为对外结论使用' },
  qualified: { label: '有条件成立', color: 'var(--accent)', hint: '只支持方向判断，不支持承诺落地' },
  weak: { label: '仅供参考', color: 'var(--warn)', hint: '缺少结构化复核或样本不足' },
  none: { label: '未形成共识', color: 'var(--text-3)', hint: '只有过程记录' },
} as const

/** 早期落盘的报告缺 verdict/timeline 等字段，逐个补默认值，否则整页白屏 */
function normalize(raw: Report): Report {
  const speakers = Math.max(
    1,
    new Set((raw.meta?.models ?? []).map((m) => m.id)).size,
  )
  const consensus: ConsensusReportItem[] = (raw.consensus ?? []).map((c) => ({
    ...c,
    supporters: c.supporters ?? [],
    sourceRounds: c.sourceRounds ?? [],
    sourceUtteranceIds: c.sourceUtteranceIds ?? [],
    evidence: c.evidence ?? [],
    confidence: c.confidence ?? 0,
    confirmedRound: c.confirmedRound ?? (c.sourceRounds ?? [0])[0] ?? 0,
    supportRatio:
      c.supportRatio ?? Math.round(((c.supporterCount ?? 0) / speakers) * 100),
    weight: c.weight ?? null,
    verifiedSupportRate: c.verifiedSupportRate ?? 0,
    attributedSupport: c.attributedSupport ?? [],
    crossExamined: c.crossExamined ?? false,
  }))
  const timeline: ReportRoundRow[] = raw.timeline ?? []
  const coverage =
    raw.verdict?.coverage ??
    Math.round(
      (consensus.length / Math.max(1, consensus.length + (raw.disputes ?? []).length)) * 100,
    )
  return {
    ...raw,
    consensus,
    disputes: (raw.disputes ?? []).map((d) => ({
      ...d,
      sides: d.sides ?? [],
      roundsEngaged: d.roundsEngaged ?? 1,
      dueled: d.dueled ?? false,
      quotes: d.quotes ?? [],
    })),
    timeline,
    participation: raw.participation ?? [],
    nextActions: raw.nextActions ?? [],
    stats:
      raw.stats ?? {
        utterances: 0,
        humanUtterances: 0,
        replyEdges: 0,
        absentCount: 0,
        speakerCount: speakers,
        avgRoundMs: 0,
        hub: null,
      },
    verdict:
      raw.verdict ?? {
        level: (raw.meta?.consensusAvailable ? 'qualified' : 'weak') as Report['verdict']['level'],
        headline: raw.executiveSummary,
        reasons: ['该报告由旧版本生成，未包含结论强度核算。'],
        coverage,
      },
  }
}

export function ReportViewer({
  title,
  report,
  onClose,
  onRegenerate,
  regenerating = false,
  regenNote = null,
}: {
  title: string
  report: unknown
  onClose: () => void
  onRegenerate?: () => void
  regenerating?: boolean
  regenNote?: string | null
}) {
  const regenBtn = onRegenerate && (
    <button
      className="btn icon report-regen"
      onClick={onRegenerate}
      disabled={regenerating}
      title="用当前格式重新生成报告（不调用模型、零成本）"
      aria-label="重新生成报告"
    >
      {regenerating ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
    </button>
  )
  const regenBar = regenNote && <div className="report-regen-note">{regenNote}</div>
  const raw = report as Report | null
  if (!raw) {
    return (
      <div className="modal-mask" onClick={onClose}>
        <div className="modal report-modal" onClick={(e) => e.stopPropagation()}>
          <div className="report-head">
            <h2>
              <Eye size={16} />
              {title}
            </h2>
            <div className="report-head-right">
              {regenBtn}
              <button className="btn icon" onClick={onClose}>
                <X size={14} />
              </button>
            </div>
          </div>
          {regenBar}
          <div className="history-empty">
            该会话没有报告
            {onRegenerate && <div className="history-empty-hint">点上方刷新按钮，可从记录重算一份。</div>}
          </div>
        </div>
      </div>
    )
  }
  const r = normalize(raw)
  const level = LEVEL_META[r.verdict.level]
  const threshold = r.meta?.consensusThreshold ?? 0
  const maxRounds = r.meta?.maxRounds ?? r.meta?.rounds ?? 0
  const budgetLimit = r.meta?.budgetLimitUsd ?? 0
  const nameById = new Map((r.meta?.models ?? []).map((m) => [m.id, m.displayName]))

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <h2>
            <Eye size={16} />
            {title}
          </h2>
          <div className="report-head-right">
            <span className="report-level" style={{ color: level.color, borderColor: level.color }}>
              {level.label}
            </span>
            {regenBtn}
            <button className="btn icon" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>
        {regenBar}

        <div className="report-body">
          <section className="rp-hero" style={{ borderLeftColor: level.color }}>
            <p className="rp-hero-headline">{r.verdict.headline}</p>
            <p className="rp-hero-hint">
              <b style={{ color: level.color }}>{level.label}</b>
              <span className="rp-hero-hint-sep">·</span>
              <span style={{ color: level.color }}>{level.hint}</span>
            </p>
            {r.verdict.reasons.length > 0 && (
              <div className="rp-hero-why">
                <div className="rp-hero-why-label">判定依据</div>
                <ul className="rp-hero-reasons">
                  {r.verdict.reasons.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="rp-coverage">
              <span className="rp-coverage-label">结论覆盖率</span>
              <div className="rp-bar">
                <span style={{ width: `${r.verdict.coverage}%`, background: level.color }} />
              </div>
              <b className="rp-coverage-n">{r.verdict.coverage}%</b>
            </div>
            {/* 共识度是怎么来的：匿名还是署名、支持有没有原文可查 —— 不写出来，分数就只是断言 */}
            {(r.meta?.provenance || r.meta?.anonymousReview) && (
              <div className="rp-mode-band">
                <span className={`audit-chip${r.meta?.anonymousReview ? '' : ' warn'}`}
                  title={r.meta?.anonymousReview ? '主持与参会模型都只看到别名，身份不参与评判' : '主持与参会模型可见彼此身份，认同可能带身份偏置'}>
                  {r.meta?.anonymousReview ? '匿名互评轨' : '署名互评轨'}
                </span>
                {r.meta?.provenance && (
                  <>
                    <span className={`audit-chip${r.meta.provenance.coverageRate >= 60 ? ' ok' : ' warn'}`}>
                      认同可核对 {r.meta.provenance.coverageRate}%
                    </span>
                    <span className="audit-chip">挨过质询 {r.meta.provenance.crossExaminedRate}%</span>
                  </>
                )}
              </div>
            )}
          </section>

          <div className="rp-figs">
            <div className="rp-figs-outcome">
              <Outcome
                kind="consensus"
                label="共识结论"
                value={r.consensus.length}
                hint={`${r.stats.speakerCount} 个模型参与`}
              />
              <Outcome
                kind="dispute"
                label="保留分歧"
                value={r.disputes.length}
                hint={r.disputes.length ? '未消解，需人工裁决' : '无登记在案的对立论点'}
              />
            </div>
            <div className="rp-figs-flow">
              <Fstat k="有效发言" v={r.stats.utterances} />
              <Fstat k="点名回应" v={r.stats.replyEdges} />
              <Fstat k="缺席事件" v={r.stats.absentCount} warn={r.stats.absentCount > 0} />
              <Fstat k="人工介入" v={r.meta?.interventionCount ?? r.interventions.length} />
              <Fstat k="专项对辩" v={r.meta?.duelCount ?? r.duels.length} />
              <Fstat k="耗时" v={fmtDuration(r.meta?.durationMs ?? 0)} />
              <Fstat k="成本" v={`$${(r.meta?.totalCostUsd ?? 0).toFixed(4)}`} />
            </div>
          </div>

          <Sec n="01" title="执行摘要">
            <p className="rp-lead">{r.executiveSummary}</p>
          </Sec>

          <Sec n="02" tier="key" accent="var(--consensus)" title={`共识结论（${r.consensus.length}）`} icon={<CheckCircle size={12} />}>
            {((r.meta?.dedup?.merged ?? 0) > 0 || (r.meta?.dedup?.notes.length ?? 0) > 0) && (
              <div className="rp-note">
                {(r.meta?.dedup?.merged ?? 0) > 0 && (
                  <p>本场有 {r.meta!.dedup!.merged} 条说法与已有结论是同一个判断，已按内容并入（原措辞在每条下方可展开）。</p>
                )}
                {/* 主持标了「延续」但内容对不上的条目会按新条目登记；不写出来就成了界面上看不见的一句话 */}
                {(r.meta?.dedup?.notes.length ?? 0) > 0 && (
                  <ul>{r.meta!.dedup!.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                )}
              </div>
            )}
            {r.consensus.length === 0 && <Empty>本场没有由主席确认的共识条目。</Empty>}
            {r.consensus.map((c, i) => (
              <div key={i} className="rp-item rp-item-consensus">
                <div className="rp-item-head">
                  <span className="rp-idx">{String(i + 1).padStart(2, '0')}</span>
                  <span className="rp-item-claim">{plainMd(c.claim)}</span>
                  <SupportBadge ratio={c.supportRatio} />
                </div>
                <div className="rp-meters">
                  <Meter label="认同" value={`${c.supporterCount}/${Math.max(1, r.stats.speakerCount)}`} pct={c.supportRatio} />
                  <Meter
                    label="置信度"
                    value={(c.confidence ?? 0).toFixed(2)}
                    pct={Math.round((c.confidence ?? 0) * 100)}
                  />
                  <Meter
                    label="认同可核对"
                    value={`${c.verifiedSupportRate}%`}
                    pct={c.verifiedSupportRate}
                  />
                  {typeof c.weight === 'number' && (
                    <Meter label="证据硬度" value={c.weight.toFixed(2)} pct={Math.round(c.weight * 100)} />
                  )}
                </div>
                <div className="rp-tags">
                  认同：{c.supporters.join('、') || '未记录'}
                  <span className="rp-dot">·</span>
                  确认于第 {c.confirmedRound} 轮
                  <span className="rp-dot">·</span>
                  证据轮次 {(c.sourceRounds ?? []).join('、') || '-'}
                </div>
                {(c.attributedSupport.length > 0 || c.crossExamined || c.verification) && (
                  <div className="rp-audit-tags">
                    {c.attributedSupport.length > 0 && (
                      <span className="audit-chip warn" title="主持声称这些模型支持，但被引用的证据里没有他们的发言">
                        主持代答：{c.attributedSupport.join('、')}
                      </span>
                    )}
                    {c.crossExamined && (
                      <span className="audit-chip" title="证据发言里有被其他模型点名回应的">
                        挨过质询
                      </span>
                    )}
                    {c.verification && (
                      <span
                        className={`audit-chip ${VERIFY_STATUS_META[c.verification.status].tone === 'ok' ? 'ok' : 'warn'}`}
                        title={`核验轮在第 ${c.verification.checkedRound} 轮质询了 ${c.verification.attributed.join('、') || '相关模型'}`}
                      >
                        核验：{VERIFY_STATUS_META[c.verification.status].label}
                      </span>
                    )}
                  </div>
                )}
                {(c.variants?.length ?? 0) > 0 && (
                  <details className="rp-evidence">
                    <summary>同一判断的其他说法 {c.variants!.length} 条（已并入本条，非独立结论）</summary>
                    {c.variants!.map((v, k) => (
                      <div key={k} className="rp-quote">
                        <span className="rp-quote-text">{plainMd(v)}</span>
                      </div>
                    ))}
                  </details>
                )}
                {c.evidence.length > 0 && (
                  <details className="rp-evidence">
                    <summary>
                      <GitBranch size={11} /> 证据链 {c.evidence.length} 条原文
                    </summary>
                    {c.evidence.map((e) => (
                      <div key={e.utteranceId} className="rp-quote">
                        <span className="rp-quote-who">{e.displayName}</span>
                        <span className="rp-quote-round">R{e.round}</span>
                        <span className="rp-quote-text">{e.quote}</span>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
          </Sec>

          <Sec n="03" tier="key" accent="var(--dispute)" title={`保留分歧（${r.disputes.length}）`} icon={<AlertTriangle size={12} />}>
            {r.disputes.length === 0 && <Empty>无未消解分歧。注意：这不等于全员一致认同，只代表没有登记在案的对立论点。</Empty>}
            {r.disputes.map((d, i) => (
              <div key={i} className="rp-item rp-item-dispute">
                <div className="rp-item-head">
                  <span className="rp-idx">{String(i + 1).padStart(2, '0')}</span>
                  <span className="rp-item-claim">{plainMd(d.claim)}</span>
                  {d.dueled && <span className="rp-badge rp-badge-duel">已对辩</span>}
                </div>
                <div className="rp-sides">
                  {(d.sides ?? []).map((s, j) => (
                    <div key={j} className="rp-side">
                      <b>{s.agentId}</b>
                      <span className="rp-side-rounds">
                        R{(s.sourceRounds ?? []).join(',R') || '-'}
                      </span>
                      <p>{s.argument}</p>
                    </div>
                  ))}
                </div>
                {d.quotes.length > 0 && (
                  <details className="rp-evidence">
                    <summary>
                      <GitBranch size={11} /> 交锋原文 {d.quotes.length} 条 · 持续 {d.roundsEngaged} 轮
                    </summary>
                    {d.quotes.map((e) => (
                      <div key={e.utteranceId} className="rp-quote">
                        <span className="rp-quote-who">{e.displayName}</span>
                        <span className="rp-quote-round">R{e.round}</span>
                        <span className="rp-quote-text">{e.quote}</span>
                      </div>
                    ))}
                  </details>
                )}
                <div className="rp-why">未消解原因：{d.whyUnresolved}</div>
              </div>
            ))}
          </Sec>

          <Sec n="04" title="讨论进程" icon={<TrendingUp size={12} />}>
            {r.timeline.length === 0 ? (
              <Empty>本场没有逐轮记录。</Empty>
            ) : (
              <>
                <div className="rp-charts">
                  <Chart title="共识度趋势" hint={threshold > 0 ? `虚线为阈值 ${threshold}` : undefined}>
                    <TrendChart rows={r.timeline} threshold={threshold} />
                  </Chart>
                  <Chart title="逐轮发言构成" hint="发言 / 缺席 / 介入">
                    <RoundBars rows={r.timeline} />
                  </Chart>
                </div>
                <table className="rp-table">
                  <thead>
                    <tr>
                      <th>轮次</th>
                      <th>发言</th>
                      <th>缺席</th>
                      <th>介入</th>
                      <th>新共识</th>
                      <th>新分歧</th>
                      <th>共识度</th>
                      <th>分项（立场/重合/趋势）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.timeline.map((row) => (
                      <tr key={row.round} className={row.converged ? 'rp-row-hit' : undefined}>
                        <td>
                          R{row.round}
                          {row.converged && <span className="rp-badge rp-badge-hit">收敛</span>}
                        </td>
                        <td>{row.utterances}</td>
                        <td>{row.absent || ''}</td>
                        <td>{row.interventions || ''}</td>
                        <td>{row.newConsensus || ''}</td>
                        <td>{row.newDisputes || ''}</td>
                        <td className="rp-td-score">{row.score ?? '-'}</td>
                        <td className="rp-td-dims">
                          {row.dims ? `${row.dims.agreement} / ${row.dims.overlap} / ${row.dims.trend}` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(r.stageTimings ?? []).length > 0 && (
                  <>
                    <div className="rp-sub-title">阶段耗时（记录到报告生成为止）</div>
                    <div className="rp-stage-strip">
                      {(r.stageTimings ?? []).map((t, i) => (
                        <span
                          key={`${t.round}-${t.stage}-${t.startedAt}-${i}`}
                          className="stage-chip"
                          title={`${t.summary ?? ''} · ${new Date(t.startedAt).toLocaleTimeString('zh-CN')}`}
                        >
                          R{t.round} {STAGE_LABEL[t.stage]} · {(t.durationMs / 1000).toFixed(1)}s
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </Sec>

          <Sec n="05" title="参与度与血缘" icon={<Users size={12} />}>
            {r.participation.length === 0 ? (
              <Empty>旧版报告未记录参与度统计。</Empty>
            ) : (
              <>
                <Chart title="各模型发言 / 回应 / 被引用" hint="条长按同一比例">
                  <ParticipationBars rows={r.participation} />
                </Chart>
                {r.stats.hub && (
                  <div className="rp-hub">
                    <Sparkles size={12} />
                    被引用最多的论点：
                    <b>
                      {r.stats.hub.displayName} R{r.stats.hub.round}（{r.stats.hub.citedBy} 次）
                    </b>
                    <span className="rp-hub-quote">{r.stats.hub.quote}</span>
                  </div>
                )}
                <table className="rp-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>通道</th>
                      <th>发言</th>
                      <th>主动回应</th>
                      <th>被引用</th>
                      <th>缺席轮</th>
                      <th>成本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.participation.map((p) => (
                      <tr key={p.agentId} className={p.utterances === 0 ? 'rp-row-muted' : undefined}>
                        <td>{p.displayName}</td>
                        <td>{p.transport === 'api' ? 'API' : '网页'}</td>
                        <td>{p.utterances}</td>
                        <td>{p.replies}</td>
                        <td>{p.citedBy}</td>
                        <td>{p.absentRounds || ''}</td>
                        <td>${(p.costUsd ?? 0).toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(r.meta?.leaderboard ?? []).length > 0 && (
                  <>
                    <div className="rp-sub-title">互评名次（跨轮平均，名次越小越靠前）</div>
                    <table className="rp-table">
                      <thead>
                        <tr>
                          <th>模型</th>
                          <th>平均名次</th>
                          <th>参评轮次</th>
                          <th>主持理由</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(r.meta?.leaderboard ?? []).map((row) => (
                          <tr key={row.agentId}>
                            <td>{nameById.get(row.agentId) ?? row.agentId}</td>
                            <td className="rp-td-score">{row.averageRank.toFixed(2)}</td>
                            <td>{row.rounds}</td>
                            <td className="rp-td-dims">{row.rationale ?? '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="rp-note">
                      名次来自主持每轮的相对排序，只作参考、不参与共识度加权。
                      {r.meta?.anonymousReview && ' 本场为匿名轨：排序时主持只看到别名。'}
                    </p>
                  </>
                )}
              </>
            )}
          </Sec>

          {(r.interventions.length > 0 || r.duels.length > 0) && (
            <Sec n="06" title="人类介入与专项对辩" icon={<MessageSquare size={12} />}>
              {(r.meta?.interventionCount ?? r.interventions.length) > 0 && (
                <div className="rp-sub-title">人类介入</div>
              )}
              {r.interventions.map((x, i) => (
                <div key={`i${i}`} className="rp-line">
                  · {x}
                </div>
              ))}
              {r.duels.length > 0 && <div className="rp-sub-title">专项对辩轮</div>}
              {r.duels.map((d, i) => (
                <div key={`d${i}`} className="rp-line">
                  <Swords size={11} /> 对辩「{d.topic}」：{(d.agentIds ?? []).join(' vs ')}（{d.utteranceCount} 条发言）
                </div>
              ))}
              <div className="rp-note">
                人类介入已计入讨论记录，但<b>不计入共识度核算</b> —— 人的表态不等于模型共识。
              </div>
            </Sec>
          )}

          {r.blindSpots.length > 0 && (
            <Sec n="07" tier="risk" title="未覆盖风险与盲区" icon={<AlertCircle size={12} />}>
              {r.blindSpots.map((b, i) => (
                <div key={i} className="rp-line rp-line-risk">
                  · {b}
                </div>
              ))}
            </Sec>
          )}

          <HallucinationSec r={r} />
          <BaselineSec r={r} />

          {r.nextActions.length > 0 && (
            <Sec n="10" tier="key" accent="var(--accent)" title="下一步建议" icon={<TrendingUp size={12} />}>
              <ol className="rp-actions">
                {r.nextActions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ol>
            </Sec>
          )}

          <Sec n="11" tier="meta" title="溯源与口径">
            <div className="rp-meta-grid">
              <Meta k="参与模型" v={(r.meta?.models ?? []).map((m) => m.displayName).join('、') || '-'} />
              <Meta
                k="主持"
                v={r.meta?.moderatorUnavailable ? '无主持（降级）' : r.meta?.moderatorName || 'API 模型'}
              />
              <Meta k="轮次" v={`${r.meta?.rounds ?? 0} / ${maxRounds}`} />
              <Meta k="共识阈值" v={threshold ? String(threshold) : '未记录'} />
              <Meta k="结束原因" v={finishLabel(r)} />
              <Meta k="共识度" v={r.meta?.finalConsensusScore ? `${r.meta.finalConsensusScore.score}` : '不可用'} />
              <Meta
                k="预算"
                v={`${r.meta?.budgetLimited ? '触顶 ' : ''}$${(r.meta?.totalCostUsd ?? 0).toFixed(4)}${budgetLimit ? ` / $${budgetLimit.toFixed(2)}` : ''}`}
              />
              <Meta k="耗时" v={fmtDuration(r.meta?.durationMs ?? 0)} />
              <Meta k="生成时间" v={r.generatedAt ? new Date(r.generatedAt).toLocaleString('zh-CN') : '-'} />
              <Meta k="互评模式" v={r.meta?.anonymousReview ? '匿名轨（别名互评）' : '署名轨（可见身份）'} />
              {r.meta?.provenance && (
                <Meta
                  k="认同溯源"
                  v={`可核对 ${r.meta.provenance.coverageRate}% · 挨过质询 ${r.meta.provenance.crossExaminedRate}%`}
                />
              )}
              {r.meta?.channels && (
                <Meta
                  k="调用台账"
                  v={`API ${r.meta.channels.apiCalls} 次 · 网页 ${r.meta.channels.webCalls} 次 · 主持 ${r.meta.channels.moderatorCalls} 次 · 墙钟 ${fmtDuration(r.meta.channels.totalMs)}`}
                />
              )}
              {(r.meta?.timeBudgetMs ?? 0) > 0 && (
                <Meta
                  k="时长预算"
                  v={`${fmtDuration(r.meta!.timeBudgetMs!)}${r.meta!.timeLimited ? '（触顶收束）' : '（未触顶）'}`}
                />
              )}
              <Meta k="已排除方向" v={`${r.meta?.exploredCount ?? 0} 条${r.meta?.digestCompacted ? ' · 纪要已压缩' : ''}`} />
              {(r.meta?.dedup?.merged ?? 0) > 0 && (
                <Meta k="共识点归并" v={`${r.meta!.dedup!.merged} 条近义说法并入已有结论`} />
              )}
            </div>
            <div className="rp-note">
              共识结论均可溯源至具体轮次与发言；保留分歧项不应被视为已达成一致。
            </div>
          </Sec>
        </div>
      </div>
    </div>
  )
}

/**
 * 幻觉治理章节。
 *
 * 这一章回答的是「结论有多少成分是被编出来的」：全部信号都来自本场内部可判死的事实
 * —— 引用的发言/轮次是否存在、被声称的支持有没有本人原文、改写有没有新增证据。
 * 外部事实对错不在射程内，所以措辞只说「可疑」，不说「错误」。
 */
function HallucinationSec({ r }: { r: Report }) {
  const h = r.hallucination
  if (!h) return null
  const traj = TRAJECTORY_META[h.trajectory]
  const v = h.verification
  return (
    <Sec n="08" tier="risk" title="幻觉治理" icon={<ShieldAlert size={12} />}>
      <div className="rp-meters">
        <Meter label="风险分" value={`${h.riskScore}`} pct={h.riskScore} />
        <Meter label="凭空引用" value={`${h.citationBogusRate}%`} pct={h.citationBogusRate} />
        <Meter label="主持代答" value={`${h.attributedRate}%`} pct={h.attributedRate} />
        <Meter label="空心改写" value={`${h.hollowMutationRate}%`} pct={h.hollowMutationRate} />
      </div>
      <div className="rp-audit-tags">
        <span className={`audit-chip${traj.tone === 'ok' ? ' ok' : ' warn'}`}>轨迹：{traj.label}</span>
        <span className="audit-chip" title="主持自评维度减程序核算维度的最大差值">
          最大抬分 {h.maxInflation.toFixed(1)}
        </span>
        {v.asked > 0 ? (
          <span className="audit-chip ok">
            核验轮质询 {v.asked}：确认 {v.confirmed} / 否认 {v.denied} / 修正 {v.clarified} / 无应答 {v.noResponse}
          </span>
        ) : (
          <span className="audit-chip warn" title={v.triggeredBy}>
            核验轮未触发
          </span>
        )}
        {v.vacatedPoints > 0 && (
          <span className="audit-chip warn">{v.vacatedPoints} 条共识失去实质支持（已撤回）</span>
        )}
      </div>
      <div className="rp-lead">{h.trajectoryNote}</div>
      <div className="rp-tags">逐轮信号</div>
      {h.rounds.map((x) => (
        <div key={x.round} className="rp-line">
          R{x.round}：凭空引用 {x.badCitationUtterances} · 代答新增 {x.attributedGrowth} ·
          有据改写 {x.substantiatedRefinements} / 空心改写 {x.hollowMutations} · 抬分{' '}
          {x.inflation.toFixed(1)} · 错误信号合计 {x.errorCount}
        </div>
      ))}
      {(h.corrections ?? []).length > 0 && (
        <details className="rp-evidence">
          <summary>
            <GitBranch size={11} /> 核验轮的质询与答复（{h.corrections.length} 条）
          </summary>
          {h.corrections.map((c) => {
            const meta = CORRECTION_OUTCOME_META[c.outcome]
            return (
              <div key={c.id} className="rp-quote">
                <span className="rp-quote-who">{`R${c.round} ${c.outcome} ${meta.label}`}</span>
                <span className="rp-quote-round">{c.pointClaim ? '代答' : '引用'}</span>
                <span className="rp-quote-text">
                  {`${c.pointClaim ?? '（引用类问题）'} —— 问：${c.question.slice(0, 90)}｜答：${(c.answer ?? '（无应答）').slice(0, 140)}`}
                  {c.removedSupport.length > 0 ? `｜移出支持：${c.removedSupport.join('、')}` : ''}
                </span>
              </div>
            )
          })}
        </details>
      )}
      {(h.flags ?? []).length > 0 && (
        <>
          <div className="rp-tags">需人工查看</div>
          {h.flags.map((f, i) => (
            <div key={i} className="rp-line rp-line-risk">
              · {f}
            </div>
          ))}
        </>
      )}
      <div className="rp-note">
        这里只统计本场内部可判死的信号：引用是否真的存在、被声称的支持有没有本人原文、跨轮改写有没有新增证据。
        无人否认不等于确认 —— 被质询后无应答的条目保持「未核验」，不会被计入已核实共识。
      </div>
    </Sec>
  )
}

/**
 * 单模型基线对照。
 *
 * 这是全报告里唯一能证伪「研讨有用」的一章：同一议题、同一个模型、没有互相 heard。
 * 基线更好，就说明本场的组织方式在制造冗余而不是判断。
 */
function BaselineSec({ r }: { r: Report }) {
  const b = r.baseline
  if (!b) {
    return (
      <Sec n="09" title="对照：研讨 vs 单模型基线" icon={<FlaskConical size={12} />}>
        <Empty>
          本场未设单模型基线，因此只能说明「大家说了什么」，不能说明比直接问一个模型多出了什么。
          下一场在开始讨论页打开「单模型基线」即可对照。
        </Empty>
      </Sec>
    )
  }
  const cmp = r.baselineCompare
  return (
    <Sec n="09" title="对照：研讨 vs 单模型基线" icon={<FlaskConical size={12} />}>
      <div className="rp-audit-tags">
        <span className="audit-chip">
          基线：{b.displayName}（{b.transport === 'api' ? 'API' : '网页'} ·{' '}
          {fmtDuration(Math.max(0, b.endedAt - b.startedAt))}
          {b.costUsd > 0 ? ` · $${b.costUsd.toFixed(4)}` : ''}）
        </span>
        {cmp && (
          <span
            className={`audit-chip${cmp.verdict === 'council_better' ? ' ok' : ' warn'}`}
            title="主持按「研讨多出什么 / 基线有什么而研讨丢了什么」比对"
          >
            {BASELINE_VERDICT_LABEL[cmp.verdict] ?? cmp.verdict}
          </span>
        )}
      </div>
      {b.absent ? (
        <div className="rp-line rp-line-risk">基线未产出：{b.absentReason ?? '原因未记录'}。本场没有对照基准。</div>
      ) : (
        <details className="rp-evidence">
          <summary>
            <Eye size={11} /> 基线原文（{b.content.length} 字，讨论开始前独立作答）
          </summary>
          <div className="rp-quote">
            <span className="rp-quote-text">{b.content}</span>
          </div>
        </details>
      )}
      {cmp && (
        <>
          <div className="rp-lead">{cmp.note}</div>
          {([
            ['研讨多出、基线没有的要点', cmp.councilAdds],
            ['基线提到、研讨反而丢掉的要点', cmp.councilDrops],
            ['研讨中被削弱或跑偏的判断', cmp.regressions],
          ] as const).map(([title, items]) =>
            items.length === 0 ? null : (
              <div key={title}>
                <div className="rp-tags">{title}</div>
                {items.map((x, i) => (
                  <div key={i} className="rp-line">
                    {i + 1}. {x}
                  </div>
                ))}
              </div>
            ),
          )}
        </>
      )}
      <div className="rp-note">
        基线在讨论开始前产生，不进入任何轮次、不写进纪要，也不参与共识度核算 —— 它是尺子，不是参会者。
      </div>
    </Sec>
  )
}

/**
 * 章节按重要度分四档，档位决定标题字号、颜色与是否带主轴：
 * key = 读者必须看的（结论/分歧/下一步），risk = 会削弱结论的，plain = 过程记录，meta = 口径附注。
 */
function Sec({
  n,
  title,
  icon,
  tier = 'plain',
  accent,
  children,
}: {
  n: string
  title: string
  icon?: React.ReactNode
  tier?: 'key' | 'risk' | 'plain' | 'meta'
  accent?: string
  children: React.ReactNode
}) {
  return (
    <section
      className={`rp-sec rp-sec-${tier}`}
      style={accent ? ({ '--rp-accent': accent } as React.CSSProperties) : undefined}
    >
      <div className="rp-sec-title">
        <span className="rp-sec-n">{n}</span>
        {icon}
        {title}
      </div>
      {children}
    </section>
  )
}

function Chart({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="rp-chart">
      <div className="rp-chart-title">
        {title}
        {hint && <span className="rp-chart-hint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** 结果级数字：全场只有「共识 / 分歧」两个数决定这份报告能用来做什么，所以它们最大、带类型色。 */
function Outcome({
  kind,
  label,
  value,
  hint,
}: {
  kind: 'consensus' | 'dispute'
  label: string
  value: number
  hint: string
}) {
  return (
    <div className={`rp-outcome rp-outcome-${kind}`}>
      <span className="rp-outcome-n">{value}</span>
      <span className="rp-outcome-body">
        <span className="rp-outcome-label">{label}</span>
        <span className="rp-outcome-hint">{hint}</span>
      </span>
    </div>
  )
}

/** 过程计数：读的人只需要扫一眼，不需要逐个对照，所以排成一行而不是九个等大的格子 */
function Fstat({ k, v, warn = false }: { k: string; v: string | number; warn?: boolean }) {
  return (
    <span className={`rp-fstat${warn ? ' warn' : ''}`}>
      {k}
      <b>{v}</b>
    </span>
  )
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="rp-meta">
      <span className="rp-meta-k">{k}</span>
      <span className="rp-meta-v">{v}</span>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rp-empty">{children}</div>
}

function SupportBadge({ ratio }: { ratio: number }) {
  const kind = ratio >= 100 ? 'all' : ratio >= 60 ? 'major' : 'minor'
  const label = ratio >= 100 ? '全员认同' : ratio >= 60 ? `多数认同 ${ratio}%` : `少数认同 ${ratio}%`
  return <span className={`rp-badge rp-badge-${kind}`}>{label}</span>
}

function Meter({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="rp-meter">
      <span className="rp-meter-label">{label}</span>
      <div className="rp-bar">
        <span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
      <span className="rp-meter-value">{value}</span>
    </div>
  )
}

/** 共识度趋势：折线 + 阈值参考线 + 每轮点位；无主持的轮次断线，不补 0 */
function TrendChart({ rows, threshold }: { rows: ReportRoundRow[]; threshold: number }) {
  const W = 320
  const H = 118
  const L = 26
  const R = 6
  const T = 8
  const B = 18
  const innerW = W - L - R
  const innerH = H - T - B
  const x = (i: number) => (rows.length <= 1 ? L + innerW / 2 : L + (i * innerW) / (rows.length - 1))
  const y = (v: number) => T + (1 - v / 100) * innerH
  const pts = rows.map((row, i) => ({ row, i, x: x(i), y: row.score === null ? null : y(row.score) }))
  const hit = pts.filter((p) => p.y !== null)
  const line = hit.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${(p.y as number).toFixed(1)}`).join(' ')
  const area = hit.length > 1 ? `${line} L${hit[hit.length - 1]!.x.toFixed(1)},${(H - B).toFixed(1)} L${hit[0]!.x.toFixed(1)},${(H - B).toFixed(1)} Z` : ''

  return (
    <svg className="rp-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="共识度趋势">
      {[0, 50, 100].map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="rp-svg-grid" />
          <text x={0} y={y(v) + 3} className="rp-svg-tick">
            {v}
          </text>
        </g>
      ))}
      {threshold > 0 && threshold <= 100 && (
        <g>
          <line x1={L} x2={W - R} y1={y(threshold)} y2={y(threshold)} className="rp-svg-threshold" />
          <text x={L + 2} y={y(threshold) - 3} className="rp-svg-tick">
            阈值 {threshold}
          </text>
        </g>
      )}
      {area && <path d={area} className="rp-svg-area" />}
      {line && <path d={line} className="rp-svg-line" />}
      {hit.map((p) => (
        <circle key={p.i} cx={p.x} cy={p.y as number} r={2.6} className="rp-svg-dot" />
      ))}
      {rows.map((row, i) => (
        <text key={row.round} x={x(i)} y={H - 4} textAnchor="middle" className="rp-svg-tick">
          R{row.round}
        </text>
      ))}
    </svg>
  )
}

/** 逐轮发言构成：发言 / 缺席 / 介入 的堆叠柱 */
function RoundBars({ rows }: { rows: ReportRoundRow[] }) {
  const W = 320
  const H = 118
  const B = 18
  const T = 8
  const innerH = H - T - B
  const slot = W / Math.max(1, rows.length)
  const bw = Math.min(26, slot * 0.5)
  const max = Math.max(1, ...rows.map((r) => r.utterances + r.absent + r.interventions))

  return (
    <svg className="rp-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="逐轮发言构成">
      <line x1={0} x2={W} y1={H - B} y2={H - B} className="rp-svg-grid" />
      {rows.map((row, i) => {
        const cx = slot * (i + 0.5)
        const seg = [
          { n: row.utterances, cls: 'rp-bar-utt' },
          { n: row.absent, cls: 'rp-bar-abs' },
          { n: row.interventions, cls: 'rp-bar-iv' },
        ]
        let acc = 0
        return (
          <g key={row.round}>
            {seg.map((s, j) => {
              if (!s.n) return null
              const h = (s.n / max) * innerH
              const yTop = H - B - h - acc
              acc += h
              return <rect key={j} x={cx - bw / 2} y={yTop} width={bw} height={h} className={s.cls} rx={1.5} />
            })}
            <text x={cx} y={H - 4} textAnchor="middle" className="rp-svg-tick">
              R{row.round}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** 参与度：每个模型一组三格条，共用同一比例，避免「看起来差不多」的错觉 */
function ParticipationBars({ rows }: { rows: ReportParticipation[] }) {
  const L = 92
  const R = 30
  const rowH = 26
  const W = 660
  const H = Math.max(40, rows.length * rowH + 8)
  const max = Math.max(1, ...rows.flatMap((p) => [p.utterances, p.replies, p.citedBy]))
  /** 0 就真不画：给 0 留一格stub，看起来反而像「有一点点」 */
  const barW = (v: number) => (v <= 0 ? 0 : Math.max(2, ((W - L - R) * v) / max))

  return (
    <svg className="rp-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="参与度">
      {rows.map((p, i) => {
        const y0 = i * rowH + 6
        const bars = [
          { v: p.utterances, y: y0, cls: 'rp-bar-utt' },
          { v: p.replies, y: y0 + 7, cls: 'rp-bar-reply' },
          { v: p.citedBy, y: y0 + 14, cls: 'rp-bar-cite' },
        ]
        return (
          <g key={p.agentId}>
            <text x={0} y={y0 + 10} className="rp-svg-name">
              {p.displayName.length > 8 ? `${p.displayName.slice(0, 8)}…` : p.displayName}
            </text>
            {bars.map((b) =>
              b.v > 0 ? (
                <rect key={b.cls} x={L} y={b.y} width={barW(b.v)} height={6} rx={3} className={b.cls} />
              ) : null,
            )}
            <text x={W - R + 4} y={y0 + 12} className="rp-svg-tick">
              {p.utterances}/{p.replies}/{p.citedBy}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function finishLabel(r: Report): string {
  const reason = r.meta?.finishedReason
  const map: Record<string, string> = {
    converged: '已达共识阈值',
    'max-rounds': '达到最大轮次',
    aborted: '用户终止',
    'no-moderator': '主持不可用（无主持降级）',
    failed: '异常终止（已保存部分结果）',
  }
  return reason ? (map[reason] ?? reason) : '-'
}

function fmtDuration(ms: number): string {
  if (!ms) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
