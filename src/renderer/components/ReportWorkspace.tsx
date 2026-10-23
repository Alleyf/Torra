import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle,
  ChevronRight,
  ClipboardList,
  Copy,
  Download,
  Eye,
  FileText,
  GitBranch,
  Layers,
  ListChecks,
  Loader2,
  MessageSquare,
  Minus,
  RefreshCw,
  ScrollText,
  Send,
  ShieldAlert,
  Sparkles,
  Swords,
  Target,
  Users,
  X,
} from 'lucide-react'
import type { Report, ReportActionItem, ReportEvidence, ReportParticipation, ReportRoundRow } from '@shared/types'
import {
  REPORT_STATUS_META,
  actionItemsFor,
  buildClaims,
  buildDecisions,
  diffReportRevision,
  normalizeReport,
  type ReportClaimView,
  type ReportDecisionView,
  type ReportReaderMode,
} from '@shared/report-model'
import { reportShape, runFigures } from '@shared/report-shape'
import { plainMd } from '../textFormat'
import { RevisionDiffPanel } from './ReportRevisionDiff'
import '../report-workspace.css'

export type ReportExportKind = 'html' | 'pdf' | 'md' | 'img'

const MODES: Array<{ key: ReportReaderMode; label: string; hint: string }> = [
  { key: 'brief', label: '决策版', hint: '只保留结论、理由、分歧与行动' },
  { key: 'full', label: '全景版', hint: '追加问题覆盖、结论台账、基线与过程' },
  { key: 'evidence', label: '证据版', hint: '以结论与原始发言为中心' },
]

const SECTIONS = [
  { id: 'brief', label: '决策摘要' },
  { id: 'answers', label: '问题回答' },
  { id: 'chain', label: '论证链' },
  { id: 'decisions', label: '决策台账' },
  { id: 'claims', label: '结论台账' },
  { id: 'disputes', label: '分歧地图' },
  { id: 'actions', label: '行动方案' },
  { id: 'baseline', label: '基线对照' },
  { id: 'process', label: '证据与过程' },
  { id: 'diff', label: '版本变化' },
]

/**
 * 阅读模式决定目录，而不是只决定显示。
 * 简读保留“结论链/分歧/行动”；证据包只保留逐条结论、分歧和过程，
 * 避免用户切到证据模式后目录仍指向已隐藏的章节。
 */
const MODE_SECTIONS: Record<ReportReaderMode, string[]> = {
  brief: ['brief', 'chain', 'disputes', 'actions'],
  full: SECTIONS.map((s) => s.id),
  evidence: ['brief', 'claims', 'disputes', 'process', 'diff'],
}

export type EvidenceTarget =
  | { kind: 'claim'; key: string }
  | { kind: 'dispute'; key: string }
  | { kind: 'action'; key: string }
  | { kind: 'decision'; key: string }
  | { kind: 'quote'; key: string; title: string; evidence: ReportEvidence[] }
  | null

const LEVEL_META = {
  strong: { label: '结论稳固', tone: 'ok' as const, hint: '可以作为对外结论使用' },
  qualified: { label: '有条件成立', tone: 'warn' as const, hint: '只支持带条件的结论' },
  weak: { label: '仅供参考', tone: 'bad' as const, hint: '缺少结构化依据' },
  none: { label: '未形成结论', tone: 'bad' as const, hint: '本场没有可对外的结论' },
}

export function ReportWorkspace({
  title,
  report,
  sessionId,
  onClose,
  onRegenerate,
  regenerating = false,
  regenNote = null,
  onExport,
  onAskAssistant,
}: {
  title: string
  report: unknown
  sessionId: string
  onClose: () => void
  onRegenerate?: () => void
  regenerating?: boolean
  regenNote?: string | null
  onExport?: (kind: ReportExportKind) => void
  onAskAssistant?: (prompt: string) => void
}) {
  const raw = report as Report | null
  const [mode, setMode] = useState<ReportReaderMode>('brief')
  const [active, setActive] = useState('brief')
  const [evidence, setEvidence] = useState<EvidenceTarget>(null)
  const [modelFilter, setModelFilter] = useState<string | null>(null)
  const [onlyUnresolved, setOnlyUnresolved] = useState(false)
  const [onlyActionable, setOnlyActionable] = useState(false)
  const [followUp, setFollowUp] = useState<{ key: string; text: string } | null>(null)
  const [followUpNote, setFollowUpNote] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const followInputRef = useRef<HTMLTextAreaElement>(null)

  const r = useMemo(() => (raw ? normalizeReport(raw) : null), [raw])
  const claims = useMemo(() => (r ? buildClaims(r) : []), [r])
  const decisions = useMemo(() => (r ? buildDecisions(r) : []), [r])
  const actions = useMemo(() => (r ? actionItemsFor(r) : []), [r])
  const diff = useMemo(() => (r ? diffReportRevision(r) : null), [r])
  const { shape } = reportShape(r?.meta?.strategy)

  const modelNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of r?.meta?.models ?? []) map.set(m.id, m.displayName)
    return map
  }, [r])

  const nameOf = useCallback((id: string) => modelNames.get(id) ?? id, [modelNames])

  const visibleClaims = useMemo(() => {
    let list = claims
    if (modelFilter) {
      list = list.filter((c) => c.supporters.includes(modelFilter) || c.opposedBy.includes(modelFilter))
    }
    if (onlyUnresolved) list = list.filter((c) => c.status === 'contested' || c.status === 'unsupported')
    if (onlyActionable) list = list.filter((c) => c.status === 'confirmed' || c.status === 'qualified')
    return list
  }, [claims, modelFilter, onlyUnresolved, onlyActionable])

  const sections = useMemo(
    () =>
      SECTIONS.filter(
        (s) => MODE_SECTIONS[mode].includes(s.id) && (s.id !== 'diff' || Boolean(diff)),
      ),
    [diff, mode],
  )

  const openEvidence = useCallback((target: EvidenceTarget) => setEvidence(target), [])

  const runExport = useCallback(
    async (kind: ReportExportKind) => {
      if (!onExport) return
      setMode('full')
      setModelFilter(null)
      setOnlyUnresolved(false)
      setOnlyActionable(false)
      setEvidence(null)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      onExport(kind)
    },
    [onExport],
  )

  const scrollTo = useCallback((id: string) => {
    setActive(id)
    const node = bodyRef.current?.querySelector<HTMLElement>(`[data-sec="${id}"]`)
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  /** 章节编号跟随当前阅读模式：目录里的序号和正文标题必须一致 */
  const num = useCallback(
    (id: string) => String(sections.findIndex((s) => s.id === id) + 1).padStart(2, '0'),
    [sections],
  )

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
    const root = bodyRef.current
    if (!root) return
    const update = () => {
      const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-sec]'))
      const viewportTop = 90
      let current = nodes[0]?.dataset.sec ?? 'brief'
      for (const node of nodes) {
        if (node.offsetTop - root.offsetTop <= viewportTop) current = node.dataset.sec ?? current
        else break
      }
      setActive(current)
    }
    root.addEventListener('scroll', update, { passive: true })
    update()
    return () => root.removeEventListener('scroll', update)
  }, [mode, sections])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'j' || e.key === 'k') {
        const idx = sections.findIndex((s) => s.id === active)
        const next = e.key === 'j' ? Math.min(sections.length - 1, idx + 1) : Math.max(0, idx - 1)
        const target = sections[next]
        if (target) scrollTo(target.id)
      }
      if (e.key === 'Escape') setEvidence(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, scrollTo, sections])

  useEffect(() => {
    if (followUp) followInputRef.current?.focus()
  }, [followUp])

  if (!r) {
    return (
      <div className="rw-shell rw-shell-empty">
        <header className="rw-top">
          <div className="rw-top-left">
            <span className="rw-mark">
              <FileText size={15} />
            </span>
            <div className="rw-top-title">
              <h2>{title}</h2>
              <span className="rw-top-meta">这场研讨没有生成报告</span>
            </div>
          </div>
          <div className="rw-top-right">
            <button className="btn icon" onClick={onClose} aria-label="关闭报告">
              <X size={14} />
            </button>
          </div>
        </header>
        <div className="rw-empty">
          <Eye size={22} />
          <p>这场研讨没有留下可读取的报告。</p>
          {onRegenerate && (
            <button className="btn sm" onClick={onRegenerate} disabled={regenerating}>
              {regenerating ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
              按当前记录重新生成
            </button>
          )}
        </div>
      </div>
    )
  }

  const level = LEVEL_META[r.verdict.level]
  const decision = decisions[0]?.decision.decision
  const topRisk = r.disputes[0]
  const openDisputeCount = r.disputes.filter((d) => !d.shelved).length

  return (
    <div className="rw-shell" data-session={sessionId}>
      <header className="rw-top">
        <div className="rw-top-left">
          <span className="rw-mark">
            <FileText size={15} />
          </span>
          <div className="rw-top-title">
            <h2>{title}</h2>
            <span className="rw-top-meta">
              {shape.name} · {r.meta?.rounds ?? 0} 轮 · {(r.meta?.models ?? []).length} 个模型
              {r.generatedAt ? ` · ${new Date(r.generatedAt).toLocaleString('zh-CN')}` : ''}
            </span>
          </div>
        </div>
        <div className="rw-modes" role="tablist" aria-label="阅读模式">
          {MODES.map((m) => (
            <button
              key={m.key}
              role="tab"
              aria-selected={mode === m.key}
              className={`rw-mode${mode === m.key ? ' on' : ''}`}
              title={m.hint}
              onClick={() => setMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="rw-top-right">
          {onRegenerate && (
            <button
              className="btn icon"
              onClick={onRegenerate}
              disabled={regenerating}
              title="按当前记录重新生成报告"
              aria-label="重新生成报告"
            >
              {regenerating ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            </button>
          )}
          {onExport && (
            <>
              <button className="btn sm" onClick={() => void runExport('md')} title="导出 Markdown">
                <Download size={12} /> MD
              </button>
              <button className="btn sm" onClick={() => void runExport('html')} title="导出 HTML">
                <Download size={12} /> HTML
              </button>
              <button className="btn sm" onClick={() => void runExport('pdf')} title="导出 PDF">
                <Download size={12} /> PDF
              </button>
              <button className="btn sm" onClick={() => void runExport('img')} title="复制报告图片">
                <Copy size={12} /> 图片
              </button>
            </>
          )}
          <button className="btn icon" onClick={onClose} aria-label="关闭报告">
            <X size={14} />
          </button>
        </div>
      </header>
      {regenNote && <div className="rw-banner">{regenNote}</div>}

      <div className="rw-mobile-nav">
        <label htmlFor="rw-mobile-section">跳到章节</label>
        <select
          id="rw-mobile-section"
          value={active}
          onChange={(e) => scrollTo(e.target.value)}
        >
          {sections.map((s, i) => (
            <option key={s.id} value={s.id}>
              {String(i + 1).padStart(2, '0')} {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="rw-layout">
        <nav className="rw-nav" aria-label="报告目录">
          {sections.map((s, i) => (
            <button
              key={s.id}
              className={`rw-nav-item${active === s.id ? ' on' : ''}`}
              onClick={() => scrollTo(s.id)}
            >
              <span className="rw-nav-n">{String(i + 1).padStart(2, '0')}</span>
              <span>{s.label}</span>
            </button>
          ))}
          <div className="rw-nav-filters">
            <span className="rw-nav-filter-label">筛选</span>
            <button
              className={`rw-chip${onlyUnresolved ? ' on' : ''}`}
              onClick={() => {
                setOnlyUnresolved((v) => !v)
                setOnlyActionable(false)
              }}
              title="只看仍在争议或证据不足的结论"
            >
              未解决
            </button>
            <button
              className={`rw-chip${onlyActionable ? ' on' : ''}`}
              onClick={() => {
                setOnlyActionable((v) => !v)
                setOnlyUnresolved(false)
              }}
              title="只看可以据此行动的结论"
            >
              可行动
            </button>
            <div className="rw-model-list">
              {(r.meta?.models ?? []).map((m) => (
                <button
                  key={m.id}
                  className={`rw-chip${modelFilter === m.id ? ' on' : ''}`}
                  onClick={() => setModelFilter((cur) => (cur === m.id ? null : m.id))}
                  title={`只看 ${m.displayName} 参与过的结论`}
                >
                  {m.displayName}
                </button>
              ))}
            </div>
            {modelFilter && (
              <button className="rw-chip rw-chip-clear" onClick={() => setModelFilter(null)}>
                清除模型筛选
              </button>
            )}
          </div>
        </nav>

        <main className="rw-body" ref={bodyRef}>
          <section className="rw-sec" data-sec="brief">
            <DecisionBrief
              r={r}
              level={level}
              decisions={decisions}
              decision={decision}
              topRisk={topRisk}
              openDisputeCount={openDisputeCount}
              actions={actions}
              onOpenEvidence={openEvidence}
            />
          </section>

          {sections.some((s) => s.id === 'answers') && (
            <section className="rw-sec" data-sec="answers">
              <AnswersSection r={r} n={num('answers')} onOpenEvidence={openEvidence} />
            </section>
          )}

          {sections.some((s) => s.id === 'chain') && (
            <section className="rw-sec" data-sec="chain">
              <ReasoningChain r={r} n={num('chain')} claims={visibleClaims} onOpenEvidence={openEvidence} />
            </section>
          )}

          {sections.some((s) => s.id === 'decisions') && (
            <section className="rw-sec" data-sec="decisions">
              <DecisionsSection decisions={decisions} n={num('decisions')} onOpenEvidence={openEvidence} />
            </section>
          )}

          {sections.some((s) => s.id === 'claims') && (
            <section className="rw-sec" data-sec="claims">
              <ClaimsSection
                claims={visibleClaims}
                total={claims.length}
                n={num('claims')}
                onOpenEvidence={openEvidence}
                onFollowUp={(claim) => {
                  setFollowUp({ key: claim.key, text: '' })
                  setFollowUpNote(null)
                }}
              />
            </section>
          )}

          {sections.some((s) => s.id === 'disputes') && (
            <section className="rw-sec" data-sec="disputes">
              <DisputeMatrix r={r} n={num('disputes')} onOpenEvidence={openEvidence} />
            </section>
          )}

          {sections.some((s) => s.id === 'actions') && (
            <section className="rw-sec" data-sec="actions">
              <ActionSection r={r} actions={actions} n={num('actions')} onOpenEvidence={openEvidence} />
            </section>
          )}

          {sections.some((s) => s.id === 'baseline') && (
            <section className="rw-sec" data-sec="baseline">
              <BaselineSection r={r} n={num('baseline')} />
            </section>
          )}

          {sections.some((s) => s.id === 'process') && (
            <section className="rw-sec" data-sec="process">
              <ProcessSection r={r} n={num('process')} />
            </section>
          )}

          {diff && sections.some((s) => s.id === 'diff') && (
            <section className="rw-sec" data-sec="diff">
              <RevisionDiffPanel diff={diff} n={num('diff')} />
            </section>
          )}
        </main>

        <EvidenceDrawer
          target={evidence}
          r={r}
          claims={claims}
          decisions={decisions}
          actions={actions}
          nameOf={nameOf}
          onClose={() => setEvidence(null)}
        />
      </div>

      {followUp && (
        <div className="rw-followup">
          <div className="rw-followup-head">
            <Sparkles size={13} />
            <b>针对这条结论继续追问</b>
            <button className="btn icon" onClick={() => setFollowUp(null)} aria-label="关闭追问">
              <X size={13} />
            </button>
          </div>
          <p className="rw-followup-claim">
            {claims.find((c) => c.key === followUp.key)?.claim ?? '（该结论已不在当前筛选中）'}
          </p>
          <textarea
            ref={followInputRef}
            value={followUp.text}
            placeholder="例如：这条结论在什么条件下会失效？谁来验证？"
            onChange={(e) => setFollowUp((cur) => (cur ? { ...cur, text: e.target.value } : cur))}
          />
          <div className="rw-followup-foot">
            {followUpNote && <span className="rw-followup-note">{followUpNote}</span>}
            <button
              className="btn sm primary"
              disabled={!followUp.text.trim()}
              onClick={() => {
                const claim = claims.find((c) => c.key === followUp.key)
                if (!claim || !onAskAssistant) {
                  setFollowUpNote('助手没有就绪，可以先复制原话再自行追问。')
                  return
                }
                onAskAssistant(
                  [
                    `针对研讨结论追问：${claim.claim}`,
                    `依据：${claim.note}`,
                    claim.evidence.length > 0
                      ? `原话：${claim.evidence
                          .slice(0, 3)
                          .map((e) => `${e.displayName}（R${e.round}）：${e.quote}`)
                          .join(' / ')}`
                      : '',
                    `我的追问：${followUp.text.trim()}`,
                  ]
                    .filter(Boolean)
                    .join('\n'),
                )
                setFollowUpNote('已把这条结论和追问交给助手。')
              }}
            >
              <Send size={12} />
              交给助手
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function DecisionBrief({
  r,
  level,
  decision,
  decisions,
  topRisk,
  openDisputeCount,
  actions,
  onOpenEvidence,
}: {
  r: Report
  level: { label: string; tone: 'ok' | 'warn' | 'bad'; hint: string }
  decision?: string
  decisions: ReportDecisionView[]
  topRisk?: Report['disputes'][number]
  openDisputeCount: number
  actions: ReportActionItem[]
  onOpenEvidence: (t: EvidenceTarget) => void
}) {
  const scope = decisions[0]?.decision.premises ?? []
  const costs = decisions[0]?.decision.costs ?? []
  return (
    <div className="rw-brief">
      <div className="rw-brief-head">
        <span className={`rw-level tone-${level.tone}`}>
          <Target size={13} />
          {level.label}
        </span>
        <span className="rw-brief-scope">{level.hint}</span>
      </div>
      <h3 className="rw-brief-decision">{decision ?? r.verdict.headline}</h3>
      <p className="rw-brief-summary">{r.executiveSummary}</p>
      <div className="rw-brief-grid">
        <div className="rw-brief-cell">
          <span className="rw-brief-cell-k">为什么成立</span>
          {scope.length > 0 ? (
            <ul>
              {scope.map((x, i) => (
                <li key={i}>{plainMd(x)}</li>
              ))}
            </ul>
          ) : (
            <p className="rw-muted">终局审校没有记录前提。报告只能说明结论本身，不能说明它在什么条件下成立。</p>
          )}
        </div>
        <div className="rw-brief-cell">
          <span className="rw-brief-cell-k">代价与未覆盖</span>
          {costs.length > 0 ? (
            <ul>
              {costs.map((x, i) => (
                <li key={i}>{plainMd(x)}</li>
              ))}
            </ul>
          ) : (
            <p className="rw-muted">没有记录代价。选它意味着接受什么，报告没有回答。</p>
          )}
        </div>
        <div className="rw-brief-cell rw-brief-cell-risk">
          <span className="rw-brief-cell-k">最大不确定性</span>
          {topRisk ? (
            <>
              <p className="rw-brief-risk">{plainMd(topRisk.claim)}</p>
              <button
                className="rw-inline-link"
                onClick={() => onOpenEvidence({ kind: 'dispute', key: topRisk.claim })}
              >
                查看分歧证据 <ChevronRight size={12} />
              </button>
            </>
          ) : (
            <p className="rw-muted">本场没有留下未解决分歧。</p>
          )}
        </div>
        <div className="rw-brief-cell rw-brief-cell-next">
          <span className="rw-brief-cell-k">下一步</span>
          {actions.length > 0 ? (
            <>
              <p className="rw-brief-action">{plainMd(actions[0]!.action)}</p>
              <p className="rw-brief-action-meta">
                {actions[0]!.owner ?? '负责人待指定'} · {actions[0]!.due ?? '时间待定'}
              </p>
            </>
          ) : (
            <p className="rw-muted">报告没有形成可执行的下一步。</p>
          )}
        </div>
      </div>
      <div className="rw-brief-foot">
        <span>
          <Users size={11} /> {(r.meta?.models ?? []).length} 个模型
        </span>
        <span>
          <CheckCircle size={11} /> {r.consensus.length} 条结论
        </span>
        <span className={openDisputeCount > 0 ? 'warn' : ''}>
          <Swords size={11} /> {openDisputeCount} 处分歧
        </span>
        <span>
          <ClipboardList size={11} /> {actions.length} 项行动
        </span>
        {r.blindSpots.length > 0 && (
          <span className="warn">
            <AlertTriangle size={11} /> {r.blindSpots.length} 处盲区
          </span>
        )}
      </div>
    </div>
  )
}

function AnswersSection({ r, onOpenEvidence }: { r: Report; onOpenEvidence: (t: EvidenceTarget) => void }) {
  const qs = r.questions
  if (!qs) {
    return (
      <div className="rw-block">
        <BlockHead n="02" title="问题回答" hint="这场研讨有没有把原始问题答完" />
        <p className="rw-muted">这份报告由旧版本生成，没有记录原始问题台账，无法逐题核对。</p>
      </div>
    )
  }
  const bands = [
    { key: 'answered', label: '已回答', tone: 'ok' as const, items: qs.filter((q) => q.status === 'answered') },
    { key: 'shelved', label: '暂缓', tone: 'warn' as const, items: qs.filter((q) => q.status === 'shelved') },
    { key: 'open', label: '未回答', tone: 'bad' as const, items: qs.filter((q) => q.status === 'open') },
  ]
  return (
    <div className="rw-block">
      <BlockHead n="02" title="问题回答" hint="原始问题现在能不能据此行动" />
      <div className="rw-answer-grid">
        {bands.map((band) => (
          <div key={band.key} className={`rw-answer-col tone-${band.tone}`}>
            <div className="rw-answer-col-head">
              <b>{band.label}</b>
              <span>{band.items.length}</span>
            </div>
            {band.items.length === 0 ? (
              <p className="rw-muted">无</p>
            ) : (
              <ul>
                {band.items.map((q) => (
                  <li key={q.id}>
                    <p className="rw-answer-q">{plainMd(q.text)}</p>
                    <p className="rw-answer-meta">
                      R{q.addedRound} 登记
                      {q.disposition?.round ? ` · R${q.disposition.round} 处理` : ''}
                      {q.disposition?.reason ? ` · ${plainMd(q.disposition.reason)}` : ''}
                    </p>
                    {q.status === 'shelved' && q.disposition?.missing && (
                      <p className="rw-answer-missing">缺：{plainMd(q.disposition.missing)}</p>
                    )}
                    {q.evidence.length > 0 && (
                      <button
                        className="rw-inline-link"
                        onClick={() =>
                          onOpenEvidence({
                            kind: 'quote',
                            key: q.id,
                            title: plainMd(q.text),
                            evidence: q.evidence,
                          })
                        }
                      >
                        {q.evidence.length} 条原话 <ChevronRight size={12} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function ReasoningChain({
  r,
  claims,
  onOpenEvidence,
}: {
  r: Report
  claims: ReportClaimView[]
  onOpenEvidence: (t: EvidenceTarget) => void
}) {
  const rawDecision = r.finalReview?.decisions[0]
  const steps: Array<{ label: string; text: string; kind: 'base' | 'premise' | 'decision' | 'cost' }> = [
    { label: '要解决的问题', text: r.executiveSummary, kind: 'base' },
    ...(rawDecision?.premises ?? []).map((p) => ({ label: '前提', text: p, kind: 'premise' as const })),
    ...(rawDecision
      ? [{ label: '结论', text: rawDecision.decision, kind: 'decision' as const }]
      : claims.slice(0, 1).map((c) => ({ label: '结论', text: c.claim, kind: 'decision' as const }))),
    ...(rawDecision?.costs ?? []).map((c) => ({ label: '代价', text: c, kind: 'cost' as const })),
  ]
  return (
    <div className="rw-block">
      <BlockHead n="03" title="论证链" hint="结论是怎么一步步得出的" />
      {steps.length === 0 ? (
        <p className="rw-muted">报告没有记录论证过程。</p>
      ) : (
        <ol className="rw-chain">
          {steps.map((step, i) => (
            <li key={i} className={`rw-chain-step kind-${step.kind}`}>
              <span className="rw-chain-label">{step.label}</span>
              <p className="rw-chain-text">{plainMd(step.text)}</p>
              {i < steps.length - 1 && <ArrowRight size={13} className="rw-chain-arrow" />}
            </li>
          ))}
        </ol>
      )}
      {rawDecision && (rawDecision.evidence ?? []).length > 0 && (
        <button
          className="rw-inline-link"
          onClick={() => onOpenEvidence({ kind: 'decision', key: rawDecision.id })}
        >
          查看支撑原话 <ChevronRight size={12} />
        </button>
      )}
    </div>
  )
}

function DecisionsSection({
  decisions,
  onOpenEvidence,
}: {
  decisions: ReportDecisionView[]
  onOpenEvidence: (t: EvidenceTarget) => void
}) {
  return (
    <div className="rw-block">
      <BlockHead
        n="04"
        title="决策台账"
        hint={`${decisions.length} 项终局决策 · 前提、代价和行动并列展示`}
      />
      {decisions.length === 0 ? (
        <p className="rw-muted">本场没有形成可单独追踪的终局决策。</p>
      ) : (
        <div className="rw-decisions">
          {decisions.map((view, index) => {
            const d = view.decision
            return (
              <article key={view.key} className="rw-decision">
                <header className="rw-decision-head">
                  <span className="rw-decision-n">D{String(index + 1).padStart(2, '0')}</span>
                  <h4>{plainMd(d.decision)}</h4>
                </header>
                <div className="rw-decision-facts">
                  <DecisionFact label="依据结论" items={d.basedOnClaims ?? []} />
                  <DecisionFact label="成立前提" items={d.premises ?? []} />
                  <DecisionFact label="代价与缺口" items={d.costs ?? []} tone="warn" />
                </div>
                {view.actionItems.length > 0 && (
                  <div className="rw-decision-actions">
                    <b>行动</b>
                    {view.actionItems.map((item, actionIndex) => (
                      <p key={`${item.id}-${actionIndex}`}>
                        <Check size={11} />
                        {plainMd(item.action)}
                        <span>
                          {item.owner ?? '负责人待指定'} · {item.due ?? '时间待确认'}
                        </span>
                      </p>
                    ))}
                  </div>
                )}
                <footer className="rw-claim-foot">
                  <button
                    className="rw-inline-link"
                    onClick={() => onOpenEvidence({ kind: 'decision', key: view.key })}
                  >
                    查看支撑原文 <ChevronRight size={12} />
                  </button>
                  <span className="rw-claim-who">{d.id}</span>
                </footer>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DecisionFact({
  label,
  items,
  tone,
}: {
  label: string
  items: string[]
  tone?: 'warn'
}) {
  return (
    <div className={`rw-decision-fact${tone ? ` tone-${tone}` : ''}`}>
      <span>{label}</span>
      {items.length > 0 ? (
        <ul>
          {items.map((item, index) => (
            <li key={index}>{plainMd(item)}</li>
          ))}
        </ul>
      ) : (
        <p>报告未记录</p>
      )}
    </div>
  )
}

function ClaimsSection({
  claims,
  total,
  onOpenEvidence,
  onFollowUp,
}: {
  claims: ReportClaimView[]
  total: number
  onOpenEvidence: (t: EvidenceTarget) => void
  onFollowUp: (claim: ReportClaimView) => void
}) {
  return (
    <div className="rw-block">
      <BlockHead
        n="05"
        title="结论台账"
        hint={`${claims.length} / ${total} 条结论 · 每条都标状态、来源和证据`}
      />
      {claims.length === 0 ? (
        <p className="rw-muted">当前筛选下没有结论。</p>
      ) : (
        <div className="rw-claims">
          {claims.map((claim) => {
            const meta = REPORT_STATUS_META[claim.status]
            return (
              <article key={claim.key} className={`rw-claim tone-${meta.tone}`}>
                <header className="rw-claim-head">
                  <span className={`rw-status tone-${meta.tone}`} title={meta.hint}>
                    {meta.tone === 'ok' ? (
                      <Check size={11} />
                    ) : meta.tone === 'bad' ? (
                      <ShieldAlert size={11} />
                    ) : (
                      <AlertTriangle size={11} />
                    )}
                    {meta.label}
                  </span>
                  <h4>{plainMd(claim.claim)}</h4>
                </header>
                <p className="rw-claim-note">{plainMd(claim.note)}</p>
                <div className="rw-claim-facts">
                  <span>
                    <Users size={11} /> 支持 {claim.supporters.length}
                  </span>
                  {claim.opposedBy.length > 0 && (
                    <span className="warn">
                      <Swords size={11} /> 存在异议 {claim.opposedBy.length}
                    </span>
                  )}
                  <span>
                    <Target size={11} /> 把握 {Math.round(claim.confidence * 100)}%
                  </span>
                  <span>
                    <ShieldAlert size={11} /> 证据硬度{' '}
                    {claim.hardness === null ? '未记录' : claim.hardness.toFixed(2)}
                  </span>
                  {claim.crossExamined && (
                    <span className="ok">
                      <GitBranch size={11} /> 经受质询
                    </span>
                  )}
                  {claim.sourceRounds.length > 0 && (
                    <span>
                      <Layers size={11} /> R{claim.sourceRounds.join(' / R')}
                    </span>
                  )}
                </div>
                <footer className="rw-claim-foot">
                  <button
                    className="rw-inline-link"
                    onClick={() => onOpenEvidence({ kind: 'claim', key: claim.key })}
                  >
                    展开证据 <ChevronRight size={12} />
                  </button>
                  <button className="rw-inline-link" onClick={() => onFollowUp(claim)}>
                    <MessageSquare size={12} /> 继续追问
                  </button>
                  {claim.supporters.length > 0 && (
                    <span className="rw-claim-who">{claim.supporters.join('、')}</span>
                  )}
                </footer>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DisputeMatrix({
  r,
  onOpenEvidence,
}: {
  r: Report
  onOpenEvidence: (t: EvidenceTarget) => void
}) {
  const disputes = r.disputes
  const agents = (r.meta?.models ?? []).map((m) => m.id)
  return (
    <div className="rw-block">
      <BlockHead n="06" title="分歧地图" hint="谁站在哪一边、为什么没有收敛" />
      {disputes.length === 0 ? (
        <p className="rw-muted">
          本场没有留下分歧记录。注意这不等于“全员意见一致”，也可能只是分歧没有被结构化。
        </p>
      ) : (
        <div className="rw-disputes">
          {disputes.map((d) => (
            <article key={d.claim} className="rw-dispute">
              <header className="rw-dispute-head">
                <h4>{plainMd(d.claim)}</h4>
                <span className={d.shelved ? 'rw-chip' : 'rw-chip warn'}>
                  {d.shelved ? `暂缓 · 缺 ${d.shelved.missing}` : `未解决 · 争了 ${d.roundsEngaged} 轮`}
                </span>
              </header>
              {agents.length > 0 && (
                <div className="rw-dispute-grid">
                  {agents.map((agentId) => {
                    const sides = d.sides.filter((s) => s.agentId === agentId)
                    const name = r.meta?.models.find((m) => m.id === agentId)?.displayName ?? agentId
                    return (
                      <div key={agentId} className={`rw-dispute-cell${sides.length > 0 ? ' on' : ''}`}>
                        <span className="rw-dispute-who">{name}</span>
                        {sides.length > 0 ? (
                          <p>{plainMd(sides[0]!.argument)}</p>
                        ) : (
                          <p className="rw-muted">未在此分歧中表态</p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              <p className="rw-dispute-why">
                <AlertTriangle size={11} /> {plainMd(d.shelved ? d.shelved.reason : d.whyUnresolved)}
              </p>
              <footer className="rw-claim-foot">
                <button
                  className="rw-inline-link"
                  onClick={() => onOpenEvidence({ kind: 'dispute', key: d.claim })}
                >
                  展开原话 <ChevronRight size={12} />
                </button>
                {d.dueled && (
                  <span className="rw-claim-who">
                    <Swords size={11} /> 经过专门对抗
                  </span>
                )}
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

function ActionSection({
  r,
  actions,
  onOpenEvidence,
}: {
  r: Report
  actions: ReportActionItem[]
  onOpenEvidence: (t: EvidenceTarget) => void
}) {
  const risks = r.nextActions.filter((text) => !actions.some((a) => a.action === text))
  return (
    <div className="rw-block">
      <BlockHead n="07" title="行动方案" hint="谁在什么时候前做什么、怎么算完成" />
      {actions.length === 0 ? (
        <p className="rw-muted">报告没有形成结构化行动。下面是仍然需要人工处理的风险项。</p>
      ) : (
        <div className="rw-actions">
          {actions.map((item) => (
            <article key={item.id} className="rw-action">
              <div className="rw-action-main">
                <p className="rw-action-text">{plainMd(item.action)}</p>
                <div className="rw-action-fields">
                  <span>
                    <Users size={11} /> {item.owner ?? '负责人待指定'}
                  </span>
                  <span>
                    <Layers size={11} /> {item.due ?? '时间待定'}
                  </span>
                  <span>
                    <Check size={11} /> {item.doneWhen ?? '完成标准未记录'}
                  </span>
                  {item.depends && (
                    <span>
                      <GitBranch size={11} /> 依赖 {item.depends}
                    </span>
                  )}
                  {item.fallback && (
                    <span className="warn">
                      <AlertTriangle size={11} /> 失败分支 {item.fallback}
                    </span>
                  )}
                </div>
              </div>
              <button
                className="rw-inline-link"
                onClick={() => onOpenEvidence({ kind: 'action', key: item.id })}
              >
                依据 <ChevronRight size={12} />
              </button>
            </article>
          ))}
        </div>
      )}
      {risks.length > 0 && (
        <div className="rw-risks">
          <span className="rw-risks-title">仍需人工处理的风险</span>
          <ul>
            {risks.map((text, i) => (
              <li key={i}>{plainMd(text)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function BaselineSection({ r }: { r: Report }) {
  const b = r.baseline
  const cmp = r.baselineCompare
  if (!b) {
    return (
      <div className="rw-block">
        <BlockHead n="08" title="基线对照" hint="这场研讨比单模型回答多出了什么" />
        <p className="rw-muted">本场没有跑单模型基线，因此无法说明“讨论带来了什么增量”。</p>
      </div>
    )
  }
  return (
    <div className="rw-block">
      <BlockHead n="08" title="基线对照" hint="这场研讨比单模型回答多出了什么" />
      <div className="rw-baseline">
        <div className="rw-baseline-head">
          <span className="rw-chip">
            <Users size={11} /> {b.displayName} · {b.transport === 'api' ? 'API' : '网页'}
          </span>
          {cmp && (
            <span className={`rw-chip ${cmp.verdict === 'council_better' ? 'on' : 'warn'}`}>
              {cmp.verdict === 'council_better'
                ? '研讨优于基线'
                : cmp.verdict === 'baseline_better'
                  ? '基线优于研讨'
                  : cmp.verdict === 'mixed'
                    ? '各有胜负'
                    : '无法判定'}
            </span>
          )}
        </div>
        {cmp && <p className="rw-lead">{plainMd(cmp.note)}</p>}
        {cmp && (
          <div className="rw-baseline-cols">
            {(
              [
                ['研讨多出来的', cmp.councilAdds, 'ok'],
                ['研讨丢掉的', cmp.councilDrops, 'bad'],
                ['研讨反而变差的', cmp.regressions, 'warn'],
              ] as const
            ).map(([title, items, tone]) => (
              <div key={title} className={`rw-baseline-col tone-${tone}`}>
                <b>{title}</b>
                {items.length === 0 ? (
                  <p className="rw-muted">无</p>
                ) : (
                  <ul>
                    {items.map((x, i) => (
                      <li key={i}>{plainMd(x)}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ProcessSection({ r }: { r: Report }) {
  const figures = runFigures(r)
  const timeline = r.timeline
  return (
    <div className="rw-block">
      <BlockHead n="09" title="证据与过程" hint="这场讨论是怎么跑完的" />
      <div className="rw-figs">
        {figures.map((f) => (
          <span key={f.k} className={`rw-fstat${f.warn ? ' warn' : ''}`} title={f.note}>
            {f.k}
            <b>{f.v}</b>
          </span>
        ))}
      </div>
      {timeline.length > 0 && <RoundTimeline rows={timeline} />}
      <PresenceGrid rows={r.participation} rounds={timeline.map((t) => t.round)} />
      {r.blindSpots.length > 0 && (
        <div className="rw-blind">
          <span className="rw-risks-title">这份报告没覆盖的地方</span>
          <ul>
            {r.blindSpots.map((b, i) => (
              <li key={i}>{plainMd(b)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function RoundTimeline({ rows }: { rows: ReportRoundRow[] }) {
  const max = Math.max(1, ...rows.map((x) => x.utterances + x.absent))
  return (
    <div className="rw-timeline">
      {rows.map((row) => (
        <div key={row.round} className="rw-timeline-row">
          <span className="rw-timeline-round">R{row.round}</span>
          <div className="rw-timeline-bar">
            <i className="rw-timeline-utt" style={{ width: `${(row.utterances / max) * 100}%` }} />
            {row.absent > 0 && (
              <i className="rw-timeline-abs" style={{ width: `${(row.absent / max) * 100}%` }} />
            )}
          </div>
          <span className="rw-timeline-score">{row.score === null ? '—' : row.score}</span>
          <span className="rw-timeline-delta">
            +{row.newConsensus} 结论 / {row.newDisputes} 分歧
          </span>
        </div>
      ))}
    </div>
  )
}

function PresenceGrid({ rows, rounds }: { rows: ReportParticipation[]; rounds: number[] }) {
  if (rounds.length === 0 || rows.length === 0) return null
  const known = rows.some((p) => Array.isArray(p.absentRoundList))
  return (
    <div className="rw-presence" style={{ '--rp-cols': rounds.length } as React.CSSProperties}>
      <div className="rw-presence-head">
        <span className="rw-presence-name">模型</span>
        {rounds.map((rn) => (
          <span key={rn} className="rw-presence-rh">
            R{rn}
          </span>
        ))}
      </div>
      {rows.map((p) => (
        <div key={p.agentId} className="rw-presence-row">
          <span className="rw-presence-name" title={p.displayName}>
            {p.displayName}
          </span>
          {rounds.map((rn) => {
            const absent = known && (p.absentRoundList ?? []).includes(rn)
            return (
              <span
                key={rn}
                className={`rw-presence-cell${absent ? ' absent' : ' live'}`}
                title={absent ? `${p.displayName} R${rn} 缺席` : `${p.displayName} R${rn} 在场`}
              >
                {absent ? <Minus size={10} /> : <Check size={10} />}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function EvidenceDrawer({
  target,
  r,
  claims,
  decisions,
  actions,
  nameOf,
  onClose,
}: {
  target: EvidenceTarget
  r: Report
  claims: ReportClaimView[]
  decisions: ReportDecisionView[]
  actions: ReportActionItem[]
  nameOf: (id: string) => string
  onClose: () => void
}) {
  if (!target) return null
  let title = ''
  let evidence: ReportEvidence[] = []
  let extra: React.ReactNode = null

  if (target.kind === 'claim') {
    const claim = claims.find((c) => c.key === target.key)
    title = claim?.claim ?? '结论'
    evidence = claim?.evidence ?? []
    extra = claim ? (
      <div className="rw-drawer-meta">
        <span>支持：{claim.supporters.map(nameOf).join('、') || '未记录'}</span>
        {claim.opposedBy.length > 0 && <span>异议：{claim.opposedBy.map(nameOf).join('、')}</span>}
        <span>把握：{Math.round(claim.confidence * 100)}%</span>
        <span>证据硬度：{claim.hardness === null ? '未记录' : claim.hardness.toFixed(2)}</span>
      </div>
    ) : null
  } else if (target.kind === 'dispute') {
    const dispute = r.disputes.find((d) => d.claim === target.key)
    title = dispute?.claim ?? '分歧'
    evidence = dispute?.quotes ?? []
    extra = dispute ? (
      <div className="rw-drawer-meta">
        {dispute.sides.map((s) => (
          <span key={s.agentId}>
            {nameOf(s.agentId)}：{plainMd(s.argument)}
          </span>
        ))}
      </div>
    ) : null
  } else if (target.kind === 'decision') {
    const view = decisions.find((d) => d.key === target.key)
    title = view?.decision.decision ?? '决定'
    evidence = view?.decision.evidence ?? []
  } else if (target.kind === 'quote') {
    title = target.title
    evidence = target.evidence
  } else {
    const action = actions.find((a) => a.id === target.key)
    title = action?.action ?? '行动'
    const view = decisions.find((d) => d.key === action?.decisionId)
    evidence = view?.decision.evidence ?? []
    extra = action ? (
      <div className="rw-drawer-meta">
        <span>负责人：{action.owner ?? '待指定'}</span>
        <span>时间：{action.due ?? '待定'}</span>
        <span>完成标准：{action.doneWhen ?? '未记录'}</span>
      </div>
    ) : null
  }

  return (
    <aside className="rw-drawer" aria-label="证据抽屉">
      <header className="rw-drawer-head">
        <b>证据</b>
        <button className="btn icon" onClick={onClose} aria-label="关闭证据抽屉">
          <X size={13} />
        </button>
      </header>
      <p className="rw-drawer-title">{plainMd(title)}</p>
      {extra}
      <div className="rw-drawer-body">
        {evidence.length === 0 ? (
          <p className="rw-muted">这一条没有记录原话。报告不编造来源。</p>
        ) : (
          evidence.map((e) => (
            <blockquote key={e.utteranceId} className="rw-quote">
              <p>{plainMd(e.quote)}</p>
              <footer>
                <span>{e.displayName}</span>
                <span>R{e.round}</span>
                <code>{e.utteranceId}</code>
              </footer>
            </blockquote>
          ))
        )}
      </div>
      {evidence.length > 0 && (
        <button
          className="btn sm rw-drawer-copy"
          onClick={() => {
            const text = evidence
              .map((e) => `${e.displayName}（R${e.round}）：${e.quote}`)
              .join('\n\n')
            void navigator.clipboard.writeText(`${title}\n\n${text}`)
          }}
        >
          <Copy size={12} /> 复制原话
        </button>
      )}
    </aside>
  )
}

function BlockHead({ n, title, hint }: { n: string; title: string; hint: string }) {
  return (
    <header className="rw-block-head">
      <span className="rw-block-n">{n}</span>
      <div>
        <h3>{title}</h3>
        <p>{hint}</p>
      </div>
    </header>
  )
}
