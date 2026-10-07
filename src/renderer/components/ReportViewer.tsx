import { cloneElement, useState } from 'react'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle,
  ClipboardList,
  Clock,
  Copy,
  Download,
  Eye,
  EyeOff,
  FlaskConical,
  GitBranch,
  Layers,
  ListChecks,
  Loader2,
  Megaphone,
  MessageSquare,
  Minus,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Sparkles,
  Swords,
  Target,
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
import type { JudgmentTier, Kpi, RpKpiKey, RpSectionKey } from '@shared/report-shape'
import {
  APPENDIX_SECTIONS,
  TIER_META,
  corroborationBreakdown,
  duelPairs,
  engagementStats,
  hardnessMedian,
  heroKpis,
  noBasisCount,
  reportShape,
  runFigures,
  tierGroups,
  verdictField,
} from '@shared/report-shape'
import { plainMd } from '../textFormat'
import { copyReportViewAsImage, exportReportView } from '../reportExport'
import type { ReportExportFormat } from '@shared/report-export'

/** 导出/复制的六种产物 */
type ExportKind = ReportExportFormat | 'md' | 'img'

/** 导出到文件的四种产物；复制为图片是另一个动作，单独一个图标按钮 */
const EXPORTS: { fmt: ExportKind; label: string; hint: string }[] = [
  { fmt: 'html', label: 'HTML', hint: '单文件网页，离线可打开，证据链保持展开' },
  { fmt: 'pdf', label: 'PDF', hint: 'A4 分页，适合打印和转发' },
  { fmt: 'md', label: 'MD', hint: '纯文本结论，便于再加工' },
  { fmt: 'png', label: '图片', hint: '整页长图存成 PNG 文件' },
]

const STAGE_LABEL: Record<DiscussionStage, string> = {
  'agent-batch': '并行发言',
  moderator: '主持小结',
  consensus: '收敛判定',
  report: '报告生成',
  baseline: '单模型基线',
  verification: '幻觉核验轮',
  'final-review': '终局审校',
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
 * 章节顺序、首屏主图、三个 KPI 都由 `reportShape(strategy)` 决定（`@shared/report-shape`），
 * renderer 与主进程的 Markdown 导出取同一张表，避免「看到的」和「转发的」不是同一份。
 * 策略本身只改提示词，不改调度与共识度核算，所以这里换的是**读法**，不造新指标。
 */

const LEVEL_META = {
  strong: { label: '结论稳固', color: 'var(--consensus)', hint: '可作为对外结论使用' },
  qualified: { label: '有条件成立', color: 'var(--accent)', hint: '只支持方向判断，不支持承诺落地' },
  weak: { label: '仅供参考', color: 'var(--warn)', hint: '缺少结构化复核或样本不足' },
  none: { label: '未形成共识', color: 'var(--text-3)', hint: '只有过程记录' },
} as const

/** 首屏那一张策略标识：图标负责一眼认出这是哪种组织方式，不靠色条 */
const STRATEGY_ICON = {
  roundtable: <Users size={15} />,
  debate: <Swords size={15} />,
  review: <ClipboardList size={15} />,
} as const

/** KPI 图标与 report-shape 的口径键一一对应：加新 KPI 时这里必须补，否则磁贴没有脸 */
const KPI_ICON: Record<RpKpiKey, React.ReactNode> = {
  standing: <ListChecks size={13} />,
  corroborated: <Users size={13} />,
  verifiable: <Check size={13} />,
  noBasis: <EyeOff size={13} />,
  hardness: <ShieldAlert size={13} />,
  blind: <EyeOff size={13} />,
  ranked: <Target size={13} />,
  engaged: <MessageSquare size={13} />,
  survived: <CheckCircle size={13} />,
  overturned: <AlertTriangle size={13} />,
  duel: <Swords size={13} />,
  risk: <ShieldAlert size={13} />,
}

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
  sessionId,
  onClose,
  onRegenerate,
  regenerating = false,
  regenNote = null,
}: {
  title: string
  report: unknown
  sessionId: string
  onClose: () => void
  onRegenerate?: () => void
  regenerating?: boolean
  regenNote?: string | null
}) {
  const [exporting, setExporting] = useState<ExportKind | null>(null)
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const runExport = async (fmt: ExportKind) => {
    if (exporting) return
    setExporting(fmt)
    setExportMsg(null)
    const startedAt = Date.now()
    let msg: { ok: boolean; text: string }
    try {
      const r =
        fmt === 'md'
          ? await window.torra.exportMarkdown(sessionId)
          : fmt === 'img'
            ? await copyReportViewAsImage(sessionId, title)
            : await exportReportView(sessionId, fmt, title)
      msg = r.ok
        ? fmt === 'img'
          ? { ok: true, text: '整页图片已在剪贴板里，直接粘贴即可。' }
          : { ok: true, text: `已导出：${r.path}` }
        : { ok: false, text: r.reason ?? '导出失败，请改用 HTML 导出。' }
    } catch (e) {
      msg = { ok: false, text: `导出失败：${(e as Error).message}` }
    }
    // 主进程写文件常常几十毫秒就回来：不到最短时长就结束，按钮会像没被按到
    const rest = 500 - (Date.now() - startedAt)
    if (rest > 0) await new Promise((r) => setTimeout(r, rest))
    setExportMsg(msg)
    setExporting(null)
  }

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
  const copyImgBtn = (
    <button
      className="btn icon report-copy-img"
      onClick={() => void runExport('img')}
      disabled={exporting !== null}
      title="把整页报告复制成图片，直接粘进聊天或文档（不调用模型）"
      aria-label="复制为图片"
    >
      {exporting === 'img' ? <Loader2 size={14} className="spin" /> : <Copy size={14} />}
    </button>
  )
  const exportBtns = (
    <div className="report-export" role="group" aria-label="导出报告">
      {EXPORTS.map((x) => (
        <button
          key={x.fmt}
          className="btn sm rp-exp"
          onClick={() => void runExport(x.fmt)}
          disabled={exporting !== null}
          title={x.hint}
        >
          {exporting === x.fmt ? <Loader2 size={11} className="spin" /> : <Download size={11} />}
          {exporting === x.fmt ? '导出中' : x.label}
        </button>
      ))}
    </div>
  )
  const regenBar = regenNote && <div className="report-regen-note">{regenNote}</div>
  const exportBar =
    exporting !== null || exportMsg ? (
      <div className={`report-export-note${exportMsg?.ok ? ' ok' : ''}`}>
        {exportMsg ? exportMsg.text : '正在导出…'}
      </div>
    ) : null
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
              {copyImgBtn}
              {exportBtns}
              {regenBtn}
              <button className="btn icon" onClick={onClose}>
                <X size={14} />
              </button>
            </div>
          </div>
          {regenBar}
          {exportBar}
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
  const { shape, recorded } = reportShape(r.meta?.strategy)
  const threshold = r.meta?.consensusThreshold ?? 0
  /** 搁置条数：它们不阻塞收束，但和未消解的分歧一样留在「保留分歧」里，计数要分开说 */
  const shelvedCount = r.disputes.filter((d) => d.shelved).length
  const openCount = r.disputes.length - shelvedCount
  const maxRounds = r.meta?.maxRounds ?? r.meta?.rounds ?? 0
  const budgetLimit = r.meta?.budgetLimitUsd ?? 0
  const nameById = new Map((r.meta?.models ?? []).map((m) => [m.id, m.displayName]))
  const rounds = roundList(r)

  const blocks: Record<RpSectionKey, (n: string) => React.ReactElement> = {
    summary: (n) => (
      <Sec n={n} title="执行摘要" icon={<ScrollText size={12} />}>
        <p className="rp-lead">{r.executiveSummary}</p>
      </Sec>
    ),
    /**
     * 终局审校排在共识结论之前：读者要的第一眼是「所以怎么做」，
     * 结论清单是它的出处，不是主角 —— 本轮改的就是这个主次关系。
     */
    decisions: (n) => {
      const fr = r.finalReview
      return (
        <Sec n={n} tier="key" accent="var(--accent)" title="终局审校 · 决定、前提与代价" icon={<ListChecks size={12} />}>
          {!fr ? (
            <Empty icon={<EyeOff size={12} />}>
              本场没有终局审校：这份报告由旧版本生成，或本场中止／无主持降级，没跑到收尾那一次审校调用。
              下面「下一步建议」是程序按分歧与预算推导的，不等于有人替您做过取舍。
            </Empty>
          ) : fr.decisions.length === 0 ? (
            <Empty icon={<AlertCircle size={12} />}>
              主持的终局审校没有产出可用的决定 —— 每一条的引用都没能落到本场真实存在的结论与发言上。
            </Empty>
          ) : (
            fr.decisions.map((d, i) => (
              <div key={d.id} className="rp-item">
                <div className="rp-item-head">
                  <span className="rp-idx">{String(i + 1).padStart(2, '0')}</span>
                  <span className="rp-item-claim">{plainMd(d.decision)}</span>
                </div>
                <div className="rp-tags">
                  <GitBranch size={11} /> 依据结论：{(d.basedOnClaims ?? []).join('；') || '引用未能解析，别直接采用'}
                </div>
                <div className="rp-sides">
                  <DecList label="成立前提" items={d.premises ?? []} missing="主持未写前提：前提不明的决定不宜直接落地" />
                  <DecList label="代价与未覆盖" items={d.costs ?? []} missing="主持未写代价：这条决定放弃了什么，报告里查不到" />
                  <DecList label="下一步动作" items={d.actions ?? []} missing="主持未给动作：没有可检查的下一步" />
                </div>
                {(d.evidence ?? []).length > 0 && (
                  <details className="rp-evidence">
                    <summary>
                      <GitBranch size={11} /> 原文依据 {d.evidence!.length} 条
                    </summary>
                    {d.evidence!.map((e) => (
                      <div key={e.utteranceId} className="rp-quote">
                        <span className="rp-quote-who">{e.displayName}</span>
                        <span className="rp-quote-round">R{e.round}</span>
                        <span className="rp-quote-text">
                          {e.quote}
                          <span className="rp-anchor">{e.utteranceId}</span>
                        </span>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))
          )}
          {fr && fr.rejected.length > 0 && (
            <div className="rp-note">
              <p>
                <ShieldAlert size={11} /> 以下审校条目因引用不成立被程序丢弃（不改写主持原文）：
              </p>
              <ul>{fr.rejected.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
          {fr && fr.uncovered.length > 0 && (
            <div className="rp-note">
              <p>
                <EyeOff size={11} /> {fr.uncovered.length} 条结论没有进入任何决定 —— 它们仍是结论，只是本场没给出「所以怎么做」：
                {fr.uncovered.join('；')}
              </p>
            </div>
          )}
        </Sec>
      )
    },
    consensus: (n) => (
      <Sec n={n} tier="key" accent="var(--consensus)" title={`逐条判断（${r.consensus.length}）`} icon={<CheckCircle size={12} />}>
        {((r.meta?.dedup?.merged ?? 0) > 0 || (r.meta?.dedup?.notes.length ?? 0) > 0) && (
          <div className="rp-note">
            {(r.meta?.dedup?.merged ?? 0) > 0 && (
              <p>
                <Layers size={11} /> 本场有 {r.meta!.dedup!.merged} 条说法与已有结论是同一个判断，已按内容并入（原措辞在每条下方可展开）。
              </p>
            )}
            {/* 主持标了「延续」但内容对不上的条目会按新条目登记；不写出来就成了界面上看不见的一句话 */}
            {(r.meta?.dedup?.notes.length ?? 0) > 0 && (
              <ul>{r.meta!.dedup!.notes.map((x, i) => <li key={i}>{x}</li>)}</ul>
            )}
          </div>
        )}
        {r.consensus.length === 0 && <Empty icon={<AlertCircle size={12} />}>本场没有由主持确认的判断条目。</Empty>}
        {/*
          * 按成色分节，而不是把整节叫「共识」：一家提出、主持记下的判断，
          * 过去和四家印证的判断排在同一个标题下，读者会以为全场都同意。
          * 每条保留它在台账里的原始序号 —— 终局审校引用的就是这个序号。
          */}
        {tierGroups(r.consensus).map((g) => (
          <div key={g.tier} className="rp-band">
            <div className="rp-band-head">
              <TierBadge tier={g.tier} />
              <span className="rp-band-n">{g.items.length} 条</span>
              <span className="rp-band-note">{TIER_META[g.tier].note}</span>
            </div>
            {g.items.map(({ index, c }) => (
              <div key={index} className="rp-item">
                <div className="rp-item-head">
                  <span className="rp-idx">{String(index + 1).padStart(2, '0')}</span>
                  <span className="rp-item-claim">{plainMd(c.claim)}</span>
                  <SupportDots on={c.supporterCount ?? 0} total={Math.max(1, r.stats.speakerCount)} />
                </div>
                <div className="rp-facts">
                  <Pips label="认同" icon={<Users size={11} />} pct={c.supportRatio} text={`${c.supporterCount}/${Math.max(1, r.stats.speakerCount)}`} />
                  <Pips label="置信度" icon={<Target size={11} />} pct={Math.round((c.confidence ?? 0) * 100)} text={(c.confidence ?? 0).toFixed(2)} />
                  <Pips label="认同可核对" icon={<Check size={11} />} pct={c.verifiedSupportRate} text={`${c.verifiedSupportRate}%`} tone="verifiable" />
                  {typeof c.weight === 'number' ? (
                    <Pips label="证据硬度" icon={<ShieldAlert size={11} />} pct={Math.round(c.weight * 100)} text={c.weight.toFixed(2)} tone="hardness" />
                  ) : (
                    <Unrecorded icon={<EyeOff size={11} />} label="证据硬度" note="主持未给 weight，与硬度 0 不是一回事" />
                  )}
                </div>
                <div className="rp-tags">
                  <Users size={11} /> 认同：{c.supporters.join('、') || '未记录'}
                  <span className="rp-dot">·</span>
                  <Activity size={11} /> 确认于第 {c.confirmedRound} 轮
                  <span className="rp-dot">·</span>
                  <GitBranch size={11} /> 证据轮次 {(c.sourceRounds ?? []).join('、') || '-'}
                </div>
                {(c.attributedSupport.length > 0 || c.crossExamined || c.verification) && (
                  <div className="rp-audit-tags">
                    {c.attributedSupport.length > 0 && (
                      <span className="audit-chip warn" title="主持声称这些模型支持，但被引用的证据里没有他们的发言">
                        <AlertTriangle size={11} /> 主持代答：{c.attributedSupport.join('、')}
                      </span>
                    )}
                    {c.crossExamined && (
                      <span className="audit-chip" title="证据发言里有被其他模型点名回应的">
                        <Swords size={11} /> 挨过质询
                      </span>
                    )}
                    {c.verification && (
                      <span
                        className={`audit-chip ${VERIFY_STATUS_META[c.verification.status].tone === 'ok' ? 'ok' : 'warn'}`}
                        title={`核验轮在第 ${c.verification.checkedRound} 轮质询了 ${c.verification.attributed.join('、') || '相关模型'}`}
                      >
                        <ShieldAlert size={11} /> 核验：{VERIFY_STATUS_META[c.verification.status].label}
                      </span>
                    )}
                  </div>
                )}
                {(c.variants?.length ?? 0) > 0 && (
                  <details className="rp-evidence">
                    <summary>
                      <Layers size={11} /> 同一判断的其他说法 {c.variants!.length} 条（已并入本条，非独立结论）
                    </summary>
                    {c.variants!.map((v, k) => (
                      <div key={k} className="rp-quote">
                        <span className="rp-quote-text">{plainMd(v)}</span>
                      </div>
                    ))}
                  </details>
                )}
                {c.evidence.length > 0 ? (
                  <details className="rp-evidence">
                    <summary>
                      <GitBranch size={11} /> 证据链 {c.evidence.length} 条原文
                    </summary>
                    {c.evidence.map((e) => (
                      <div key={e.utteranceId} className="rp-quote">
                        <span className="rp-quote-who">{e.displayName}</span>
                        <span className="rp-quote-round">R{e.round}</span>
                        <span className="rp-quote-text">
                          {e.quote}
                          {/* 锚点直接印在行内：导出那份纯文本也要能指回台账里的同一条发言 */}
                          <span className="rp-anchor">{e.utteranceId}</span>
                        </span>
                      </div>
                    ))}
                  </details>
                ) : (
                  <div className="rp-note">
                    <EyeOff size={11} /> 本场没有登记这条判断的原文依据 —— 它目前只有主持写下的一句话。
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </Sec>
    ),
    disputes: (n) => (
      <Sec n={n} tier="key" accent="var(--dispute)" title={`保留分歧（${r.disputes.length}）`} icon={<AlertTriangle size={12} />}>
        {r.disputes.length === 0 && (
          <Empty icon={<AlertCircle size={12} />}>
            无未消解分歧。注意：这不等于全员一致认同，只代表没有登记在案的不同意见。
          </Empty>
        )}
        {r.disputes.map((d, i) => (
          <div key={i} className="rp-item">
            <div className="rp-item-head">
              <span className="rp-idx">{String(i + 1).padStart(2, '0')}</span>
              <span className="rp-item-claim">{plainMd(d.claim)}</span>
              <span className="rp-eng-rail">
                <EngagePip on={d.dueled} icon={<Swords size={10} />} title="这条分歧在专项对辩轮里被正面对垒过" off="没有专项对垒" />
                <EngagePip
                  on={r.consensus.some((c) => c.crossExamined && c.claim === d.claim)}
                  icon={<MessageSquare size={10} />}
                  title="相关发言被点名回应过"
                  off="当场没人接话"
                />
                <EngagePip
                  on={!!d.shelved}
                  icon={<EyeOff size={10} />}
                  title="当场判不了，已按搁置登记"
                  off="仍在未消解队列"
                />
              </span>
              {d.dueled && <span className="rp-badge rp-badge-duel">已对辩</span>}
              {d.shelved && <span className="rp-badge">已搁置</span>}
            </div>
            <div className="rp-sides">
              {(d.sides ?? []).map((s, j) => (
                <div key={j} className="rp-side">
                  <b><Users size={10} /> {s.agentId}</b>
                  <span className="rp-side-rounds">
                    <Activity size={10} /> R{(s.sourceRounds ?? []).join(',R') || '-'}
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
            <div className="rp-why">
              {d.shelved ? `搁置原因：${d.whyUnresolved} · 当场缺什么：${d.shelved.missing}` : `未消解原因：${d.whyUnresolved}`}
            </div>
          </div>
        ))}
      </Sec>
    ),
    participation: (n) => (
      <Sec n={n} title="参与度与血缘" icon={<Users size={12} />}>
        {r.participation.length === 0 ? (
          <Empty icon={<Users size={12} />}>旧版报告未记录参与度统计。</Empty>
        ) : (
          <>
            <div className="rp-sub-title">
              <Users size={11} /> 谁在哪一轮缺席（缺席会少一份独立视角，不是噪声）
            </div>
            <PresenceGrid rows={r.participation} rounds={rounds} />
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
                  <th>缺席于</th>
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
                    <td>{absentText(p)}</td>
                    <td>${(p.costUsd ?? 0).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(r.meta?.leaderboard ?? []).length > 0 && (
              <>
                <div className="rp-sub-title">
                  <ListChecks size={11} /> 互评名次（跨轮平均，名次越小越靠前）
                </div>
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
                  <ListChecks size={11} /> 名次来自主持每轮的相对排序，只作参考、不参与共识度加权。
                  {r.meta?.anonymousReview && ' 本场为匿名轨：排序时主持只看到别名。'}
                </p>
              </>
            )}
          </>
        )}
      </Sec>
    ),
    process: (n) => (
      <Sec n={n} title="讨论进程" icon={<Activity size={12} />}>
        {r.timeline.length === 0 ? (
          <Empty icon={<Activity size={12} />}>本场没有逐轮记录。</Empty>
        ) : (
          <>
            <div className="rp-charts">
              <Chart title="共识度趋势" hint={threshold > 0 ? `虚线为那一场记录的收束分数线 ${threshold}` : '收束不看分数，故无参考线'}>
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
                  <th>分项（主张/重合/趋势）</th>
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
                <div className="rp-sub-title">
                  <Clock size={11} /> 阶段耗时（记录到报告生成为止）
                </div>
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
    ),
    intervention: (n) => (
      <Sec n={n} title="人类介入与专项对辩" icon={<Megaphone size={12} />}>
        {r.interventions.length === 0 && r.duels.length === 0 ? (
          <Empty icon={<Megaphone size={12} />}>
            本场没有人类介入，也没有专项对辩轮 —— 报告只能说明各家说了什么，说不出谁被问倒了。
          </Empty>
        ) : (
          <>
            {(r.meta?.interventionCount ?? r.interventions.length) > 0 && (
              <div className="rp-sub-title">
                <MessageSquare size={11} /> 人类介入
              </div>
            )}
            {r.interventions.map((x, i) => (
              <div key={`i${i}`} className="rp-line">
                <MessageSquare size={11} /> {x}
              </div>
            ))}
            {r.duels.length > 0 && (
              <div className="rp-sub-title">
                <Swords size={11} /> 专项对辩轮
              </div>
            )}
            {r.duels.map((d, i) => (
              <div key={`d${i}`} className="rp-line">
                <Swords size={11} /> 对辩「{d.topic}」：{(d.agentIds ?? []).join(' vs ')}（{d.utteranceCount} 条发言）
              </div>
            ))}
          </>
        )}
        <div className="rp-note">
          <AlertCircle size={11} /> 人类介入已计入讨论记录，但<b>不计入共识度核算</b> —— 人的表态不等于模型共识。
        </div>
      </Sec>
    ),
    blindSpots: (n) => (
      <Sec n={n} tier="risk" title="未覆盖风险与盲区" icon={<EyeOff size={12} />}>
        {r.blindSpots.length === 0 ? (
          <Empty icon={<EyeOff size={12} />}>
            主持没有登记在案的盲区。注意：这只说明本场没有把「没看到」写下来，不代表真的没有。
          </Empty>
        ) : (
          r.blindSpots.map((b, i) => (
            <div key={i} className="rp-line rp-line-risk">
              <EyeOff size={11} /> {b}
            </div>
          ))
        )}
      </Sec>
    ),
    hallucination: (n) => <HallucinationSec r={r} n={n} />,
    baseline: (n) => <BaselineSec r={r} n={n} />,
    actions: (n) => (
      <Sec n={n} tier="key" accent="var(--accent)" title="下一步建议" icon={<ListChecks size={12} />}>
        {r.nextActions.length === 0 ? (
          <Empty icon={<ListChecks size={12} />}>本场没有生成下一步建议。</Empty>
        ) : (
          <ol className="rp-actions">
            {r.nextActions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ol>
        )}
      </Sec>
    ),
  }

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
            {copyImgBtn}
            {exportBtns}
            {regenBtn}
            <button className="btn icon" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>
        {regenBar}
        {exportBar}

        <div className="report-body">
          <section className="rp-hero">
            <div className="rp-strategy-band">
              <span className="rp-strategy-mark">{STRATEGY_ICON[shape.strategy]}</span>
              <div className="rp-strategy-body">
                <div className="rp-strategy-line">
                  <b>研讨策略 · {shape.name}</b>
                  {!recorded && <span className="rp-badge rp-badge-warn">未记录策略，按圆桌口径呈现</span>}
                </div>
                <p className="rp-strategy-q">{shape.question}</p>
              </div>
              <span className="rp-verdict-chip">
                <LevelIcon level={r.verdict.level} />
                <span>
                  <b>{level.label}</b>
                  <i>{level.hint}</i>
                </span>
              </span>
            </div>

            <p className="rp-hero-headline">{r.verdict.headline}</p>

            <div className="rp-hero-grid">
              <div className="rp-hero-fig">
                {shape.heroFigure === 'corroboration' && <CorroborationFigure r={r} />}
                {shape.heroFigure === 'verdict-field' && <VerdictFieldFigure r={r} />}
                {shape.heroFigure === 'engagement' && <EngagementFigure r={r} />}
                <CoverageGauge coverage={r.verdict.coverage} total={r.consensus.length + r.disputes.length} />
              </div>
              <div className="rp-kpi-col">
                {heroKpis(r.meta?.strategy, r).map((k) => (
                  <KpiTile key={k.key} kpi={k} />
                ))}
              </div>
            </div>

            {/* 共识度是怎么来的：匿名还是署名、支持有没有原文可查 —— 不写出来，分数就只是断言 */}
            {(r.meta?.provenance || r.meta?.anonymousReview) && (
              <div className="rp-mode-band">
                <span className={`audit-chip${r.meta?.anonymousReview ? '' : ' warn'}`}
                  title={r.meta?.anonymousReview ? '主持与参会模型都只看到别名，身份不参与评判' : '主持与参会模型可见彼此身份，认同可能带身份偏置'}>
                  {r.meta?.anonymousReview ? <EyeOff size={11} /> : <Users size={11} />}
                  {r.meta?.anonymousReview ? '匿名互评轨' : '署名互评轨'}
                </span>
                {r.meta?.provenance && (
                  <>
                    <span className={`audit-chip${r.meta.provenance.coverageRate >= 60 ? ' ok' : ' warn'}`}>
                      <Check size={11} /> 认同可核对 {r.meta.provenance.coverageRate}%
                    </span>
                    <span className="audit-chip">
                      <Swords size={11} /> 挨过质询 {r.meta.provenance.crossExaminedRate}%
                    </span>
                  </>
                )}
              </div>
            )}

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

            <div className="rp-caveat">
              <AlertCircle size={12} />
              <span>{shape.caveat}</span>
            </div>
          </section>

          {shape.sections.map((key, i) => cloneElement(blocks[key](String(i + 1).padStart(2, '0')), { key }))}

          {/*
           * 末尾附录，默认折起：运行账目、进程、参与度、口径。
           * 这些数字原先出现在三处（hero 下的一排、九格表、溯源章节），
           * 而那一排就坐在报告第一屏 —— 打开报告先看见耗时与模型名，
           * 看不见任何一条判断凭什么成立。现在只在附录里出现一次。
           */}
          <details className="rp-appendix">
            <summary className="rp-appendix-sum">
              <Layers size={12} />
              <b>附：运行账目与溯源</b>
              <span className="rp-appendix-hint">
                进程 · 参与度 · 调用台账 · 费用 · 口径 —— 正文只放判断，这一节是它的花费
              </span>
            </summary>
            <div className="rp-figs">
              <div className="rp-figs-flow">
                {runFigures(r).map((f) => (
                  <Fstat key={f.k} k={f.k} v={f.v} warn={f.warn} note={f.note} />
                ))}
              </div>
            </div>
            {APPENDIX_SECTIONS.map((key) => cloneElement(blocks[key](''), { key }))}
            <Sec tier="meta" title="口径与设置" icon={<Layers size={12} />}>
              <div className="rp-meta-grid">
                <Meta k="议题策略" v={`${shape.name}${recorded ? '' : '（未记录，按圆桌口径）'}`} />
                <Meta k="参与模型" v={(r.meta?.models ?? []).map((m) => m.displayName).join('、') || '-'} />
                <Meta
                  k="主持"
                  v={r.meta?.moderatorUnavailable ? '无主持（降级）' : r.meta?.moderatorName || 'API 模型'}
                />
                <Meta k="轮次" v={`${r.meta?.rounds ?? 0} / ${maxRounds}`} />
                {/* 只有旧存档才有这条线：新场的收束判定不看分数，列出来会像一条没达标的及格线 */}
                {threshold > 0 && <Meta k="当年收束分数线" v={`${threshold}（现行口径不看分数）`} />}
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
                <Layers size={11} /> 策略只改变主持与参会者的角色提示，不改变底层调度与共识度核算；
                逐条判断按成色分档，每条都能溯源到具体轮次与发言 id；仅一家提出的判断与保留分歧都不应被读成已达成一致。
              </div>
            </Sec>
          </details>
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
function HallucinationSec({ r, n }: { r: Report; n: string }) {
  const h = r.hallucination
  if (!h) {
    return (
      <Sec n={n} tier="risk" title="幻觉治理" icon={<ShieldAlert size={12} />}>
        <Empty icon={<ShieldAlert size={12} />}>
          本场报告没有幻觉账本（旧版本生成）。重新生成一次即可按现行口径核算。
        </Empty>
      </Sec>
    )
  }
  const traj = TRAJECTORY_META[h.trajectory]
  const v = h.verification
  return (
    <Sec n={n} tier="risk" title="幻觉治理" icon={<ShieldAlert size={12} />}>
      <div className="rp-facts">
        <Pips label="风险分" icon={<ShieldAlert size={11} />} pct={h.riskScore} text={`${h.riskScore}`} tone="risk" />
        <Pips label="凭空引用" icon={<GitBranch size={11} />} pct={h.citationBogusRate} text={`${h.citationBogusRate}%`} tone="risk" />
        <Pips label="主持代答" icon={<MessageSquare size={11} />} pct={h.attributedRate} text={`${h.attributedRate}%`} tone="risk" />
        <Pips label="空心改写" icon={<Layers size={11} />} pct={h.hollowMutationRate} text={`${h.hollowMutationRate}%`} tone="risk" />
      </div>
      <div className="rp-audit-tags">
        <span className={`audit-chip${traj.tone === 'ok' ? ' ok' : ' warn'}`}>
          <TrendingUp size={11} /> 轨迹：{traj.label}
        </span>
        <span className="audit-chip" title="主持自评维度减程序核算维度的最大差值">
          <Target size={11} /> 最大抬分 {h.maxInflation.toFixed(1)}
        </span>
        {v.asked > 0 ? (
          <span className="audit-chip ok">
            <ShieldAlert size={11} /> 核验轮质询 {v.asked}：确认 {v.confirmed} / 否认 {v.denied} / 修正 {v.clarified} / 无应答 {v.noResponse}
          </span>
        ) : (
          <span className="audit-chip warn" title={v.triggeredBy}>
            <EyeOff size={11} /> 核验轮未触发
          </span>
        )}
        {v.vacatedPoints > 0 && (
          <span className="audit-chip warn">
            <AlertTriangle size={11} /> {v.vacatedPoints} 条共识失去实质支持（已撤回）
          </span>
        )}
      </div>
      <div className="rp-lead">{h.trajectoryNote}</div>
      {h.rounds.length === 0 ? (
        <Empty icon={<Activity size={12} />}>没有逐轮信号（不足两轮无法算轨迹）。</Empty>
      ) : (
        <table className="rp-table">
          <thead>
            <tr>
              <th>轮次</th>
              <th>凭空引用</th>
              <th>代答新增</th>
              <th>有据改写</th>
              <th>空心改写</th>
              <th>抬分</th>
              <th>错误信号合计</th>
            </tr>
          </thead>
          <tbody>
            {h.rounds.map((x) => (
              <tr key={x.round} className={x.errorCount > 0 ? 'rp-row-warn' : undefined}>
                <td>R{x.round}</td>
                <td className="rp-td-score">{x.badCitationUtterances}</td>
                <td className="rp-td-score">{x.attributedGrowth}</td>
                <td className="rp-td-score">{x.substantiatedRefinements}</td>
                <td className="rp-td-score">{x.hollowMutations}</td>
                <td className="rp-td-score">{x.inflation.toFixed(1)}</td>
                <td className="rp-td-score">{x.errorCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
                  {(c.removedSupport ?? []).length > 0 ? `｜移出支持：${c.removedSupport.join('、')}` : ''}
                </span>
              </div>
            )
          })}
        </details>
      )}
      {(h.flags ?? []).length > 0 && (
        <>
          <div className="rp-sub-title">
            <AlertTriangle size={11} /> 需人工查看
          </div>
          {h.flags.map((f, i) => (
            <div key={i} className="rp-line rp-line-risk">
              <AlertTriangle size={11} /> {f}
            </div>
          ))}
        </>
      )}
      <div className="rp-note">
        <ShieldAlert size={11} /> 这里只统计本场内部可判死的信号：引用是否真的存在、被声称的支持有没有本人原文、
        跨轮改写有没有新增证据。无人否认不等于确认 —— 被质询后无应答的条目保持「未核验」，不会被计入已核实共识。
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
function BaselineSec({ r, n }: { r: Report; n: string }) {
  const b = r.baseline
  if (!b) {
    return (
      <Sec n={n} title="对照：研讨 vs 单模型基线" icon={<FlaskConical size={12} />}>
        <Empty icon={<FlaskConical size={12} />}>
          本场未设单模型基线，因此只能说明「大家说了什么」，不能说明比直接问一个模型多出了什么。
          下一场在开始讨论页打开「单模型基线」即可对照。
        </Empty>
      </Sec>
    )
  }
  const cmp = r.baselineCompare
  return (
    <Sec n={n} title="对照：研讨 vs 单模型基线" icon={<FlaskConical size={12} />}>
      <div className="rp-audit-tags">
        <span className="audit-chip">
          <Users size={11} /> 基线：{b.displayName}（{b.transport === 'api' ? 'API' : '网页'} ·{' '}
          {fmtDuration(Math.max(0, b.endedAt - b.startedAt))}
          {b.costUsd > 0 ? ` · $${b.costUsd.toFixed(4)}` : ''}）
        </span>
        {cmp && (
          <span
            className={`audit-chip${cmp.verdict === 'council_better' ? ' ok' : ' warn'}`}
            title="主持按「研讨多出什么 / 基线有什么而研讨丢了什么」比对"
          >
            <Target size={11} /> {BASELINE_VERDICT_LABEL[cmp.verdict] ?? cmp.verdict}
          </span>
        )}
      </div>
      {b.absent ? (
        <div className="rp-line rp-line-risk">
          <AlertTriangle size={11} /> 基线未产出：{b.absentReason ?? '原因未记录'}。本场没有对照基准。
        </div>
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
                <div className="rp-sub-title">
                  <ListChecks size={11} /> {title}
                </div>
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
        <FlaskConical size={11} /> 基线在讨论开始前产生，不进入任何轮次、不写进纪要，也不参与共识度核算 —— 它是尺子，不是参会者。
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
  /** 章节序号；附录里的章节不编号，传空即不画编号 */
  n?: string
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
        {n ? <span className="rp-sec-n">{n}</span> : null}
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

/** 过程计数：靠文字标签认得出是什么数，排成一行扫读，不给每个数单独画一张色卡 */
function Fstat({
  k,
  v,
  warn = false,
  note,
}: {
  k: string
  v: string | number
  warn?: boolean
  note?: string
}) {
  return (
    <span className={`rp-fstat${warn ? ' warn' : ''}`} title={note}>
      {k}
      <b>{v}</b>
      {note && <i>{note}</i>}
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

function Empty({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rp-empty">
      {icon}
      <span>{children}</span>
    </div>
  )
}

/** 审校三列中的一列：主持没写的那一列要说出来，不能留个空盒子当「写过了」 */
function DecList({ label, items, missing }: { label: string; items: string[]; missing: string }) {
  return (
    <div className="rp-side">
      <b>{label}</b>
      {items.length === 0 ? <p className="rp-side-rounds">{missing}</p> : items.map((x, i) => <p key={i}>{x}</p>)}
    </div>
  )
}

/**
 * 成色档：整节叫「共识」会把一家提出的判断说成全场同意，
 * 所以档位由 report-shape 的同一份判据给出，视图与导出不会各说一套。
 */
function TierBadge({ tier }: { tier: JudgmentTier }) {
  const kind: Record<JudgmentTier, string> = { shared: 'all', thin: 'major', solo: 'minor', struck: 'warn' }
  return (
    <span className={`rp-badge rp-badge-${kind[tier]}`} title={TIER_META[tier].note}>
      {TIER_META[tier].label}
    </span>
  )
}

/** 认同面：一家一个点，实心=说过这句话，空心=没说过 —— 比一根百分比条更诚实 */
function SupportDots({ on, total }: { on: number; total: number }) {
  const n = Math.max(1, Math.min(12, total))
  return (
    <span className="rp-dots" title={`${on} 家认同 / 共 ${total} 家`}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < on ? 'rp-dot-on' : 'rp-dot-off'} />
      ))}
    </span>
  )
}

/**
 * 五格刻度代替百分比条：档位看得出，但不会像色条那样把「没数据」画成很短的一段。
 * tone 只影响描边强弱，不靠颜色单独承担含义。
 */
function Pips({
  label,
  icon,
  pct,
  text,
  tone = 'plain',
}: {
  label: string
  icon: React.ReactNode
  pct: number
  text: string
  tone?: 'plain' | 'verifiable' | 'hardness' | 'risk'
}) {
  const p = Math.max(0, Math.min(100, pct))
  const on = Math.round((p / 100) * 5)
  return (
    <span className={`rp-pips rp-pips-${tone}`} title={`${label} ${p}`}>
      {icon}
      <span className="rp-pips-k">{label}</span>
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={i < on ? 'rp-pip-on' : 'rp-pip-off'} />
      ))}
      <b>{text}</b>
    </span>
  )
}

/** 缺失就是缺失：画一个问号格子，不折算成 0，也不画一根很短的条 */
function Unrecorded({ icon, label, note }: { icon: React.ReactNode; label: string; note: string }) {
  return (
    <span className="rp-pips rp-pips-none" title={note}>
      {icon}
      <span className="rp-pips-k">{label}</span>
      <i className="rp-pip-none">?</i>
      <b>未记录</b>
    </span>
  )
}

/** 分歧的检验强度：三个灯位说明它被正面对待过没有，不靠徽章颜色 */
function EngagePip({ on, icon, title, off }: { on: boolean; icon: React.ReactNode; title: string; off: string }) {
  return (
    <span className={`rp-eng-pip${on ? ' on' : ''}`} title={on ? title : off}>
      {icon}
    </span>
  )
}

/** 缺席落点：模型×轮次。旧报告只有次数没有轮次，格子画成问号而不是全绿。 */
function PresenceGrid({ rows, rounds }: { rows: ReportParticipation[]; rounds: number[] }) {
  const known = rows.some((p) => Array.isArray(p.absentRoundList))
  if (rounds.length === 0) return <Empty icon={<Activity size={12} />}>没有轮次记录，无法定位缺席落在哪一轮。</Empty>
  return (
    <div className="rp-presence" style={{ '--rp-cols': rounds.length } as React.CSSProperties}>
      <div className="rp-presence-head">
        <span className="rp-presence-name">模型</span>
        {rounds.map((rn) => (
          <span key={rn} className="rp-presence-rh">R{rn}</span>
        ))}
      </div>
      {rows.map((p) => (
        <div key={p.agentId} className="rp-presence-row">
          <span className="rp-presence-name" title={p.displayName}>
            {p.displayName.length > 9 ? `${p.displayName.slice(0, 9)}…` : p.displayName}
          </span>
          {rounds.map((rn) => {
            if (!known) return <span key={rn} className="rp-presence-cell rp-presence-unknown">?</span>
            const absent = (p.absentRoundList ?? []).includes(rn)
            return (
              <span
                key={rn}
                className={`rp-presence-cell${absent ? ' rp-presence-absent' : ' rp-presence-live'}`}
                title={absent ? `${p.displayName} 第 ${rn} 轮缺席` : `${p.displayName} 第 ${rn} 轮在场`}
              >
                {absent ? <Minus size={10} /> : <Check size={10} />}
              </span>
            )
          })}
          <span className="rp-presence-sum">
            {absentText(p)}
          </span>
        </div>
      ))}
      {!known && (
        <div className="rp-note">
          <AlertCircle size={11} /> 这份报告只记录了缺席次数（旧版本），落在哪一轮没有存档；重新生成后即可定位。
        </div>
      )}
    </div>
  )
}

/** 共识度趋势：折线 + 参考线（仅旧存档带分数线时）+ 每轮点位；无主持的轮次断线，不补 0 */
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
            分数线 {threshold}
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

/** 圆桌主图：印证构成环 + 逐轮共识度轨迹 */
function CorroborationFigure({ r }: { r: Report }) {
  const { multi, single, total } = corroborationBreakdown(r)
  const hard = hardnessMedian(r)
  const nb = noBasisCount(r)
  const rad = 30
  const circ = 2 * Math.PI * rad
  const frac = (n: number) => (total === 0 ? 0 : (n / total) * circ)
  const multiLen = frac(multi)
  const scores = r.timeline.map((t) => t.score)
  return (
    <div className="rp-fig-wrap">
      <div className="rp-fig-head">
        <Users size={12} /> 印证构成
        <span className="rp-fig-hint">几家独立说过同一条判断</span>
      </div>
      <div className="rp-fig-body">
        <svg className="rp-ring" viewBox="0 0 76 76" role="img" aria-label="印证构成环">
          <circle cx="38" cy="38" r={rad} className="rp-ring-track" />
          {total > 0 && (
            <>
              <circle
                cx="38"
                cy="38"
                r={rad}
                className="rp-ring-multi"
                strokeDasharray={`${multiLen.toFixed(2)} ${circ.toFixed(2)}`}
                transform="rotate(-90 38 38)"
              />
              <circle
                cx="38"
                cy="38"
                r={rad}
                className="rp-ring-single"
                strokeDasharray={`${(circ - multiLen).toFixed(2)} ${circ.toFixed(2)}`}
                strokeDashoffset={(-multiLen).toFixed(2)}
                transform="rotate(-90 38 38)"
              />
            </>
          )}
          <text x="38" y="36" textAnchor="middle" className="rp-ring-n">{total}</text>
          <text x="38" y="48" textAnchor="middle" className="rp-ring-cap">条判断</text>
        </svg>
        <div className="rp-legend">
          <span className="rp-legend-row">
            <i className="rp-legend-swatch rp-sw-multi" />
            <span className="rp-legend-k"><Users size={10} /> ≥2 家印证</span>
            <b className="rp-legend-v">{multi}</b>
          </span>
          <span className="rp-legend-row">
            <i className="rp-legend-swatch rp-sw-single" />
            <span className="rp-legend-k"><Minus size={10} /> 仅一家说过</span>
            <b className="rp-legend-v">{single}</b>
          </span>
          <span className="rp-legend-row">
            <i className="rp-legend-swatch rp-sw-none" />
            <span className="rp-legend-k"><EyeOff size={10} /> 没给依据</span>
            <b className="rp-legend-v">{nb}</b>
          </span>
        </div>
      </div>
      <Sparkline values={scores} caption="共识度轨迹" empty="本场没有逐轮共识度记录。" />
      <div className="rp-fig-foot">
        <ShieldAlert size={10} /> 依据硬度中位数：{hard === null ? '未记录（主持未给 weight）' : hard.toFixed(2)}
      </div>
    </div>
  )
}

/**
 * 评审主图：认同度 × 依据硬度的落点图。
 * 空心点 = 主持没给 weight。把它们画在同一张图上，「判了但没依据」才看得见；
 * 如果只画实心点，那张图会替报告撒谎。
 */
function VerdictFieldFigure({ r }: { r: Report }) {
  const pts = verdictField(r)
  const W = 300
  const H = 132
  const L = 26
  const R = 10
  const T = 12
  const B = 22
  const innerW = W - L - R
  const innerH = H - T - B
  const x = (v: number) => L + (v / 100) * innerW
  const y = (v: number) => T + (1 - v) * innerH
  const none = pts.filter((p) => p.hardness === null).length
  return (
    <div className="rp-fig-wrap">
      <div className="rp-fig-head">
        <Target size={12} /> 判定落点
        <span className="rp-fig-hint">横=认同面，纵=依据硬度</span>
      </div>
      {pts.length === 0 ? (
        <Empty icon={<Target size={12} />}>本场没有可定位的判断。</Empty>
      ) : (
        <svg className="rp-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="判定落点图">
          {[0, 0.5, 1].map((g) => (
            <g key={g}>
              <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} className="rp-svg-grid" />
              <text x={0} y={y(g) + 3} className="rp-svg-tick">{g.toFixed(1)}</text>
            </g>
          ))}
          {[50, 100].map((g) => (
            <line key={g} x1={x(g)} x2={x(g)} y1={T} y2={H - B} className="rp-vf-guide" />
          ))}
          <text x={W - R} y={H - 8} textAnchor="end" className="rp-svg-tick">认同面 %</text>
          {pts.map((p, i) =>
            p.hardness === null ? (
              <rect
                key={i}
                x={x(p.support) - 2.6}
                y={y(0.04) - 2.6}
                width={5.2}
                height={5.2}
                className="rp-vf-none"
                rx={1}
              >
                <title>{`${p.claim.slice(0, 40)} —— 主持未给依据硬度`}</title>
              </rect>
            ) : (
              <circle key={i} cx={x(p.support)} cy={y(p.hardness)} r={3.2} className="rp-vf-pt">
                <title>{`${p.claim.slice(0, 40)} —— 认同 ${p.support}% · 硬度 ${p.hardness.toFixed(2)}`}</title>
              </circle>
            ),
          )}
        </svg>
      )}
      <div className="rp-fig-foot">
        <EyeOff size={10} /> 空心方块 = 未给依据，共 {none} 条（不是硬度 0）
      </div>
    </div>
  )
}

/** 辩论主图：检验强度轨道 + 对垒清单。没有对垒就直说没有，不画一根填满的假轨道。 */
function EngagementFigure({ r }: { r: Report }) {
  const eng = engagementStats(r)
  const total = (r.consensus ?? []).length
  const pairs = duelPairs(r)
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100))
  return (
    <div className="rp-fig-wrap">
      <div className="rp-fig-head">
        <Swords size={12} /> 检验强度
        <span className="rp-fig-hint">被正面对待过多少条判断</span>
      </div>
      <div className="rp-eng-row">
        <span className="rp-eng-label"><MessageSquare size={10} /> 被点名回应过</span>
        <span className="rp-eng-track">
          <i className="rp-eng-seg-on" style={{ width: `${pct(eng.crossExamined)}%` }} />
          <i className="rp-eng-seg-off" style={{ width: `${100 - pct(eng.crossExamined)}%` }} />
        </span>
        <b className="rp-eng-v">{eng.crossExamined}/{total}</b>
      </div>
      <div className="rp-eng-row">
        <span className="rp-eng-label"><Check size={10} /> 质询后仍立住</span>
        <span className="rp-eng-track">
          <i className="rp-eng-seg-ok" style={{ width: `${eng.crossExamined === 0 ? 0 : pct(eng.survived)}%` }} />
          <i className="rp-eng-seg-bad" style={{ width: `${eng.crossExamined === 0 ? 100 : 100 - pct(eng.survived)}%` }} />
        </span>
        <b className="rp-eng-v">{eng.survived}/{eng.crossExamined}</b>
      </div>
      {eng.duelRounds === 0 ? (
        <div className="rp-fig-foot">
          <EyeOff size={10} /> 本场没有专项对辩轮：报告说不出谁推翻谁，只能说谁被接了话。
        </div>
      ) : (
        <>
          <div className="rp-eng-duels">
            {pairs.map((d, i) => (
              <span key={i} className="rp-eng-duel" title={d.topic}>
                <Swords size={10} /> {d.a} vs {d.b}
                <i>{d.utterances} 条</i>
              </span>
            ))}
            {pairs.length === 0 && (
              <span className="rp-eng-duel rp-eng-none">
                <EyeOff size={10} /> 对辩轮没有可配对的两位模型
              </span>
            )}
          </div>
          <div className="rp-fig-foot">
            <Target size={10} /> 专项对辩 {eng.duelRounds} 场 · 压住分歧 {eng.dueledDisputes} 条 · 被否认或撤回 {eng.overturned} 条
          </div>
        </>
      )}
    </div>
  )
}

/** 主图下方的小环：覆盖率是「判断本身有多少落了地」，和认同面不是一回事 */
function CoverageGauge({ coverage, total }: { coverage: number; total: number }) {
  const rad = 15
  const circ = 2 * Math.PI * rad
  return (
    <span className="rp-gauge" title={`${total} 条判断里有 ${coverage}% 落成了结论`}>
      <svg viewBox="0 0 40 40" role="img" aria-label="结论覆盖率">
        <circle cx="20" cy="20" r={rad} className="rp-ring-track" />
        <circle
          cx="20"
          cy="20"
          r={rad}
          className="rp-ring-multi"
          strokeDasharray={`${((Math.max(0, Math.min(100, coverage)) / 100) * circ).toFixed(2)} ${circ.toFixed(2)}`}
          transform="rotate(-90 20 20)"
        />
        <text x="20" y="23" textAnchor="middle" className="rp-gauge-n">{coverage}</text>
      </svg>
      <span className="rp-gauge-k">结论覆盖率 %</span>
    </span>
  )
}

/** 迷你折线：null（无主持的轮次）断线，不补 0 —— 补 0 会把「没人打分」画成「打了几分」 */
function Sparkline({ values, caption, empty }: { values: Array<number | null>; caption: string; empty: string }) {
  const W = 260
  const H = 44
  const pts = values.map((v, i) => ({ v, x: values.length <= 1 ? W / 2 : (i * W) / (values.length - 1) }))
  const hit = pts.filter((p) => typeof p.v === 'number')
  const line = hit.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${(H - 4 - ((p.v as number) / 100) * (H - 10)).toFixed(1)}`).join(' ')
  return (
    <div className="rp-spark">
      <span className="rp-spark-k">{caption}</span>
      {hit.length === 0 ? (
        <span className="rp-spark-empty">{empty}</span>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="rp-spark-svg" role="img" aria-label={caption}>
          <line x1={0} x2={W} y1={H - 4} y2={H - 4} className="rp-svg-grid" />
          <path d={line} className="rp-svg-line" />
          {hit.map((p, i) => (
            <circle key={i} cx={p.x} cy={H - 4 - ((p.v as number) / 100) * (H - 10)} r={2} className="rp-svg-dot" />
          ))}
        </svg>
      )}
    </div>
  )
}

/** KPI 磁贴：图标 + 数值 + 一句口径，三个 KPI 用同一套排版，不靠颜色区分主次 */
function KpiTile({ kpi }: { kpi: Kpi }) {
  return (
    <span className={`rp-kpi rp-kpi-${kpi.tone}`}>
      <span className="rp-kpi-icon">{KPI_ICON[kpi.key]}</span>
      <span className="rp-kpi-body">
        <span className="rp-kpi-label">{kpi.label}</span>
        <b className="rp-kpi-value">{kpi.value}</b>
        <span className="rp-kpi-hint">{kpi.hint}</span>
      </span>
    </span>
  )
}

function LevelIcon({ level }: { level: Report['verdict']['level'] }) {
  if (level === 'strong') return <CheckCircle size={14} />
  if (level === 'none') return <Minus size={14} />
  if (level === 'weak') return <AlertCircle size={14} />
  return <Target size={14} />
}

function absentCell(p: ReportParticipation): string[] {
  return (p.absentRoundList ?? []).map((n) => `R${n}`)
}

/** 缺席列：有轮次就列轮次，只有次数就说明只有次数（旧报告画不出落点） */
function absentText(p: ReportParticipation): string {
  const cells = absentCell(p)
  if (cells.length > 0) return cells.join('、')
  return p.absentRounds ? `${p.absentRounds} 次（未记录轮次）` : '-'
}

/** 缺席网格用实际发生过的轮次；旧报告没有 timeline 时退回 1..轮次 */
function roundList(r: Report): number[] {
  if ((r.timeline ?? []).length > 0) return r.timeline.map((t) => t.round)
  const n = r.meta?.rounds ?? 0
  return Array.from({ length: Math.max(0, n) }, (_, i) => i + 1)
}

function finishLabel(r: Report): string {
  const reason = r.meta?.finishedReason
  const map: Record<string, string> = {
    converged: '未决分歧处置完毕（结构收束）',
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
