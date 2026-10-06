import { useMemo, useState } from 'react'
import { useStore, type ModelSummary } from '../store'
import { ScoreChart } from './ScoreChart'
import { provenanceSummary } from '@shared/anonymity'
import { aggregateLeaderboard } from '@shared/invariants'
import { FINISH_REASON_LABEL } from '@shared/retry'
import type { ConsensusVerificationStatus } from '@shared/types'
import { getFaviconUrls, initials } from './ModelRail'
import { Markdown } from './Markdown'
import { mdExcerpt } from '../textFormat'
import { AlertTriangle, EyeOff, FileText, MapPin, ShieldCheck, Target } from 'lucide-react'

/**
 * 共识结果 —— 这一栏回答的是「这场讨论能拿走什么」。
 *
 * 与左边的「论题演化」按角色分工：演化流看过程（谁接住谁、观点在哪儿被改写），
 * 它的落点清单只是图上的索引；这里看结论本身 —— 完整陈述、谁同意、依据能不能
 * 核对回去、还争着什么。所以这一栏不放「认同 X、Y · 第 N 轮」那种一句话摘要，
 * 而是把主持产出、此前被界面丢掉的字段摊开：evidence_ref 原文、confidence 与
 * weight 的分工、跨轮归并前的其他措辞、核验降级状态、分歧双方的 argument 正文与最近进展。
 */

type Badge = { text: string; tone: string; title: string }

/**
 * 核验结论。关键约束：核验只会降级支持方，条目本身一定保留 ——
 * 「被证明没人说过」也是一条结论，静默删除是另一种幻觉。
 */
const VERIFY: Record<Exclude<ConsensusVerificationStatus, 'unverified'>, Badge> = {
  verified: { text: '已核验', tone: 'ok', title: '每位声称支持的模型，本人发言里都找得到对应原文' },
  disputed: { text: '有争议', tone: 'warn', title: '核验发现有人被主持代为表态，已在质询轮追问过' },
  vacated: {
    text: '无实质支持者',
    tone: 'bad',
    title: '质询后支持方归零。条目仍然保留 —— 「被证明没人说过」本身是一条结论',
  },
}

function verifyBadge(
  c: { verification?: { status: ConsensusVerificationStatus; checkedRound: number; attributed: string[]; confirmedBy: string[]; removed: string[] } },
  corrected: number,
): Badge | null {
  const v = c.verification
  if (!v || v.status === 'unverified') {
    // 一场核验都没跑过就不加徽标，免得每条都挂个「未核对」把真信号淹掉
    if (!v && corrected === 0) return null
    return { text: '未核对', tone: 'muted', title: '核验轮没有质询到这条（未达门槛）' }
  }
  const bits = [`第 ${v.checkedRound} 轮逐位核对本人原文`, `确认 ${v.confirmedBy.length} 家`]
  if (v.removed.length > 0) bits.push(`质询后撤回 ${v.removed.length} 家`)
  if (v.attributed.length > 0) bits.push(`核验时代答 ${v.attributed.length} 家`)
  return { ...VERIFY[v.status as Exclude<ConsensusVerificationStatus, 'unverified'>], title: `${VERIFY[v.status as Exclude<ConsensusVerificationStatus, 'unverified'>].title}（${bits.join(' · ')}）` }
}

/** 模型小图标：支持方用图标点阵，比一长串顿号名字省地方也好认 */
function Glyph({ model, size = 15 }: { model?: ModelSummary; size?: number }) {
  const [i, setI] = useState(0)
  const urls = model ? getFaviconUrls(model.domain) : []
  if (!model || urls.length === 0 || i >= urls.length) {
    return (
      <span className="cs-glyph-fb" style={{ width: size, height: size }}>
        {model ? initials(model.displayName).slice(0, 2) : '?'}
      </span>
    )
  }
  return (
    <img
      className="cs-glyph"
      style={{ width: size, height: size }}
      src={urls[i]}
      alt=""
      crossOrigin="anonymous"
      onError={() => setI(i + 1)}
    />
  )
}

/** 0~1 的细进度条：只用来比较相对高低，不装作能读出小数 */
function Meter({ value, label, title, tone }: { value: number; label: string; title: string; tone: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <span className="cs-meter" title={title}>
      <span className="cs-meter-label">{label}</span>
      <span className="cs-meter-track">
        <span className={`cs-meter-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="cs-meter-num">{pct}</span>
    </span>
  )
}

function Locate({ id, label, onLocate }: { id?: string; label: string; onLocate: (id: string) => void }) {
  if (!id) return null
  return (
    <button className="cs-locate" title={`在论题演化图上定位：${label}`} onClick={() => onLocate(id)}>
      <MapPin size={10} />
      定位
    </button>
  )
}

export function ConsensusPanel({
  models,
  onLocate,
}: {
  models: ModelSummary[]
  onLocate: (id: string) => void
}) {
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
  const corrections = useStore((s) => s.corrections)
  const round = useStore((s) => s.round)
  const maxRounds = useStore((s) => s.maxRounds)
  const finishedReason = useStore((s) => s.finishedReason)
  const moderatorUnavailable = useStore((s) => s.moderatorUnavailable)
  const budgetLimited = useStore((s) => s.budgetLimited)
  const timeLimited = useStore((s) => s.timeLimited)
  const reportReady = useStore((s) => s.reportReady)
  const setReportOpen = useStore((s) => s.setReportOpen)

  const nameOf = (id: string) => (id === 'human' ? '人工' : models.find((m) => m.id === id)?.displayName ?? id)
  const modelOf = (id: string) => models.find((m) => m.id === id)
  const last = scores.length > 0 ? scores[scores.length - 1]! : null

  /**
   * 认同溯源与名次都在渲染端即时计算：两者都能从已落盘的审计/发言推出，
   * 主进程不必为 UI 再算一遍，回放历史会话时也是同一套口径。
   */
  const prov = useMemo(() => provenanceSummary(consensus, utterances), [consensus, utterances])
  const provById = useMemo(() => new Map(prov.points.map((p) => [p.pointId, p])), [prov])
  const leaderboard = useMemo(() => aggregateLeaderboard(audits), [audits])
  const uttById = useMemo(() => new Map(utterances.map((u) => [u.id, u])), [utterances])

  const open = disputes.filter((d) => d.status === 'open')
  const resolved = disputes.filter((d) => d.status === 'resolved')

  const scorePct = last ? Math.min(100, (last.score / threshold) * 100) : 0
  const reached = !!last && last.score >= threshold
  const scoreColor = !last
    ? 'var(--text-3)'
    : reached
      ? 'var(--consensus)'
      : last.score >= threshold * 0.7
        ? 'var(--accent)'
        : 'var(--warn)'
  const budgetPct = Math.min(100, (spentUsd / Math.max(budgetLimitUsd, 0.01)) * 100)

  const verdict: Badge = moderatorUnavailable
    ? { text: '主持不可用', tone: 'muted', title: '没有主持小结就没有评分，下面的共识点与分歧都取不到' }
    : !last
      ? { text: '尚未评分', tone: 'muted', title: '第一轮小结还没产出，此处不会用猜测的分数占位' }
      : reached
        ? { text: '已达阈值', tone: 'ok', title: `综合分 ${last.score} ≥ 阈值 ${threshold}` }
        : {
            text: '未达阈值',
            tone: 'warn',
            title: `综合分 ${last.score} < 阈值 ${threshold}：讨论还在进行，或跑满轮数时仍未收束`,
          }

  return (
    <div className="cs">
      {/* ── 判定卡：这份结论有多可信，一屏之内说清 ───────────── */}
      <section className="cs-verdict">
        <header className="cs-verdict-head">
          <span className="cs-verdict-num" style={{ color: scoreColor }}>
            {last ? last.score : '—'}
          </span>
          <span className="cs-verdict-thr">/ 阈值 {threshold}</span>
          <span className={`cs-badge tone-${verdict.tone}`}>{verdict.text}</span>
        </header>

        <div className="cs-verdict-track">
          <div className="cs-verdict-fill" style={{ width: `${scorePct}%`, background: scoreColor }} />
        </div>

        <div className="cs-verdict-meta">
          <span>
            第 {round} / {Math.max(maxRounds, round)} 轮
          </span>
          {finishedReason ? (
            <span title="跑了 5 轮刚好用尽，和第 3 轮就收敛是两份可信度不同的结论">
              {FINISH_REASON_LABEL[finishedReason] ?? finishedReason}
            </span>
          ) : (
            <span>{round > 0 ? '进行中' : '未开始'}</span>
          )}
          <span title="网页通道走登录会话不计费，这里只算 API 侧的美元成本">
            ${spentUsd.toFixed(4)} / ${budgetLimitUsd.toFixed(2)}
          </span>
          {budgetLimited && (
            <span className="cs-flag tone-warn" title="费用触顶，讨论被提前收束 —— 结论的完整度要按此打折">
              费用触顶
            </span>
          )}
          {timeLimited && (
            <span className="cs-flag tone-warn" title="时长预算触顶，讨论被提前收束">
              时长触顶
            </span>
          )}
          {/* 报告入口放在这一行的末尾：判定行放不下第四个词，而这一行本来就会折行 */}
          <button
            className="btn sm cs-report"
            disabled={!reportReady}
            title={reportReady ? '打开本场纪要' : '报告要等讨论结束才产出'}
            onClick={() => reportReady && setReportOpen(true)}
          >
            <FileText size={11} />
            {state === 'DONE' && !reportReady ? '报告生成中…' : '查看报告'}
          </button>
        </div>

        {last && !moderatorUnavailable && (
          <div className="cs-dims" title="综合分 = 0.4×立场一致 + 0.3×论点重合 + 0.3×收敛趋势">
            <Meter
              value={last.agreement / 100}
              label="立场一致"
              tone="accent"
              title="各模型立场的重合程度，程序可直接核算"
            />
            <Meter
              value={last.overlap / 100}
              label="论点重合"
              tone="consensus"
              title="被两个以上模型共同提到的论点占比"
            />
            <Meter
              value={last.trend / 100}
              label="收敛趋势"
              tone="warn"
              title="未决分歧数量的变化趋势，由程序计算、主持仅确认"
            />
          </div>
        )}

        {scores.length > 0 && <ScoreChart scores={scores} threshold={threshold} />}
      </section>

      {/* ── 共识点：结论卡（正文 + 依据 + 核验状态）───────────── */}
      <section className="cs-section">
        <header className="cs-head">
          <ShieldCheck size={12} />
          <span className="cs-head-title">共识点</span>
          <span className="cs-head-n">{consensus.length}</span>
          <span className="cs-head-hint">认同可核对 {prov.coverageRate}%</span>
        </header>

        {consensus.length === 0 ? (
          <div className="cs-empty">
            <span className="pulse" />
            还没有条目被确认。共识点由主持每轮小结产出并经程序回查，宁可晚，不编。
          </div>
        ) : (
          consensus.map((c, i) => {
            const p = provById.get(c.id)
            const verifiable =
              c.support.length === 0 || !p ? 0 : Math.round((p.covered.length / c.support.length) * 100)
            const v = verifyBadge(c, corrections.length)
            const evidence = c.evidenceRef.map((id) => uttById.get(id)).filter((u): u is NonNullable<typeof u> => !!u)
            const missing = c.evidenceRef.length - evidence.length
            return (
              <article key={c.id} className={`cs-point${v ? ` tone-${v.tone}` : ''}`}>
                <div className="cs-point-top">
                  <span className="cs-idx">{String(i + 1).padStart(2, '0')}</span>
                  {v && (
                    <span className={`cs-badge tone-${v.tone}`} title={v.title}>
                      {v.text}
                    </span>
                  )}
                  <span className="cs-point-round">第 {c.confirmedRound} 轮确认</span>
                </div>

                <div className="cs-claim">
                  <Markdown text={c.claim} />
                </div>

                <div className="cs-support">
                  {c.support.length === 0 ? (
                    <span className="cs-head-hint">没有模型被登记为支持方</span>
                  ) : (
                    c.support.map((id) => (
                      <span key={id} className="cs-support-who" title={`支持方：${nameOf(id)}`}>
                        <Glyph model={modelOf(id)} />
                        <span className="cs-support-name">{nameOf(id)}</span>
                      </span>
                    ))
                  )}
                </div>

                <div className="cs-meters">
                  <Meter
                    value={c.confidence}
                    label="有多确信"
                    tone="accent"
                    title="confidence：主持评估的认同普遍程度"
                  />
                  {typeof c.weight === 'number' && (
                    <Meter
                      value={c.weight}
                      label="有多少证据"
                      tone="consensus"
                      title="weight：支撑它的独立论据有多硬。与「有多确信」分列 —— 高置信低硬度就该怀疑"
                    />
                  )}
                  <div className="cs-chips">
                    <span
                      className={`cs-chip${verifiable >= 60 ? ' ok' : verifiable > 0 ? ' warn' : ' bad'}`}
                      title="支持者中，本人在被引用的发言里有原文可核对的比例"
                    >
                      可核对 {verifiable}%
                    </span>
                    {p && p.attributed.length > 0 && (
                      <span className="cs-chip warn" title="主持替这些模型归因，证据里没有他们的发言">
                        代答 {p.attributed.map(nameOf).join('、')}
                      </span>
                    )}
                    {p?.crossExamined && (
                      <span className="cs-chip" title="证据发言里有被他人点名回应的">
                        挨过质询
                      </span>
                    )}
                  </div>
                </div>

                <details className="cs-fold">
                  <summary>
                    依据 {evidence.length}
                    {missing > 0 && `（另 ${missing} 条指向不在本场视图里的发言）`}
                  </summary>
                  {evidence.length === 0 ? (
                    <div className="cs-fold-empty">
                      {c.evidenceRef.length === 0
                        ? '主持这条小结没写 evidence_ref：没有原文可回查，按「未核对」看待'
                        : '引用的发言不在当前视图里（可能被截断，或不属于本场）'}
                    </div>
                  ) : (
                    <ul className="cs-evidence">
                      {evidence.map((u) => (
                        <li key={u.id}>
                          <span className="cs-ev-who">
                            <Glyph model={modelOf(u.agentId)} size={13} />
                            {nameOf(u.agentId)} · 第 {u.round} 轮
                          </span>
                          <span className="cs-ev-text">{mdExcerpt(u.content, 130)}</span>
                          <Locate id={u.id} label={`${nameOf(u.agentId)} 第 ${u.round} 轮发言`} onLocate={onLocate} />
                        </li>
                      ))}
                    </ul>
                  )}
                </details>

                {c.variants && c.variants.length > 0 && (
                  <details className="cs-fold">
                    <summary>归并前另有 {c.variants.length} 种说法</summary>
                    <ul className="cs-variants">
                      {c.variants.map((t, k) => (
                        <li key={k}>{t}</li>
                      ))}
                    </ul>
                    <div className="cs-fold-note">
                      主持每轮重新措辞，同一判断会被写成好几种说法。程序按内容归并成上面一条 ——
                      归并是压缩呈现，不是改写历史，原始说法逐条留在这里。
                    </div>
                  </details>
                )}
              </article>
            )
          })
        )}
      </section>

      {/* ── 保留分歧：对峙卡（双方论点正文并排）──────────────── */}
      <section className="cs-section">
        <header className="cs-head">
          <AlertTriangle size={12} />
          <span className="cs-head-title">保留分歧</span>
          <span className="cs-head-n">{open.length}</span>
          <span className="cs-head-hint">未决清单只增不减</span>
        </header>

        {open.length === 0 ? (
          <div className="cs-empty">{consensus.length ? '没有悬而未决的分歧。' : '还没有登记过分歧。'}</div>
        ) : (
          open.map((d) => (
            <article key={d.id} className="cs-dispute">
              <div className="cs-claim">
                <Markdown text={d.claim} />
              </div>
              <div className="cs-sides">
                {d.sides.map((s) => (
                  <div key={s.agentId} className="cs-side">
                    <div className="cs-side-who">
                      <Glyph model={modelOf(s.agentId)} size={13} />
                      <span className="cs-side-name">{nameOf(s.agentId)}</span>
                      <Locate
                        id={s.utteranceIds[s.utteranceIds.length - 1]}
                        label={`${nameOf(s.agentId)} 的发言`}
                        onLocate={onLocate}
                      />
                    </div>
                    <div className="cs-side-arg">
                      {s.argument || <span className="cs-head-hint">主持没记下这一方的论点原文</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="cs-dispute-foot">
                <span>始于第 {d.openedRound} 轮</span>
                {d.lastProgress ? (
                  <span className="cs-progress" title={d.lastProgress}>
                    最近进展：{d.lastProgress}
                  </span>
                ) : (
                  <span className="cs-progress none">上一轮没有进展</span>
                )}
              </div>
            </article>
          ))
        )}

        {resolved.length > 0 && (
          <details className="cs-fold">
            <summary>已消解 {resolved.length} 项</summary>
            <ul className="cs-resolved">
              {resolved.map((d) => (
                <li key={d.id}>
                  <span className="cs-resolved-claim">{d.claim}</span>
                  <span className="cs-head-hint">
                    {d.sides.map((s) => nameOf(s.agentId)).join(' vs ')} · 第 {d.openedRound} 轮起
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* ── 本场账本：审计材料，默认收起 ─────────────────────── */}
      <details className="cs-ledger">
        <summary>
          <Target size={12} />
          本场账本 · 程序校验 / 互评名次 / 花费
        </summary>

        <div className="cs-ledger-body">
          <div className="cs-ledger-block">
            <div className="cs-ledger-title">程序校验</div>
            {audits.length === 0 ? (
              <div className="cs-fold-empty">
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
                            <span className={at.ok ? 'audit-ok' : 'audit-bad'}>
                              #{at.attempt} {at.ok ? '通过' : '驳回'}
                            </span>
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
                          {!at.ok && (at.validation.errors.length > 0 || at.error) && (
                            <div className="audit-line bad">
                              {(at.error ? [at.error] : at.validation.errors).join('；')}
                            </div>
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
            <div className="cs-ledger-block">
              <div className="cs-ledger-title">互评名次</div>
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

          <div className="cs-ledger-block">
            <div className="cs-ledger-title">花费与预算</div>
            <div className="cs-cost">
              <span className="cs-cost-num">${spentUsd.toFixed(4)}</span>
              <span className="cs-cost-limit">/ ${budgetLimitUsd.toFixed(2)}</span>
            </div>
            <div className="cs-cost-track">
              <div
                className="cs-cost-fill"
                style={{
                  width: `${budgetPct}%`,
                  background: budgetPct >= 100 ? 'var(--danger)' : budgetPct >= 80 ? 'var(--warn)' : 'var(--accent)',
                }}
              />
            </div>
            <div className="cs-fold-note">网页通道走登录会话、不按 token 计费，所以这里只是 API 侧成本。</div>
          </div>
        </div>
      </details>
    </div>
  )
}
