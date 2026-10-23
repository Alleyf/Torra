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
  Search,
  Quote,
  Square,
  TrendingUp,
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
  claimStatusCounts,
  diffReportRevision,
  normalizeReport,
  rankClaims,
  type ReportClaimView,
  type ReportDecisionView,
  type ReportReaderMode,
} from '@shared/report-model'
import { reportShape, runFigures } from '@shared/report-shape'
import { clip, isMostlyLatin, oneLiner, shortTitle, splitClauses } from '@shared/report-text'
import { plainMd } from '../textFormat'
import { RevisionDiffPanel } from './ReportRevisionDiff'
import { CoverageRing, FoldText, StatusStack, StrengthMeter, TrendLine } from './report/ReportVisuals'
import { ModelAvatar } from './ModelAvatar'
import type { ModelSummary } from '../store'
import '../report-workspace.css'

export type ReportExportKind = 'html' | 'pdf' | 'md' | 'img'

const MODES: Array<{ key: ReportReaderMode; label: string; hint: string }> = [
  { key: 'brief', label: '决策版', hint: '只保留结论、理由、分歧与行动' },
  { key: 'full', label: '全景版', hint: '追加问题覆盖、结论台账、基线与过程' },
  { key: 'evidence', label: '证据版', hint: '以结论与原始发言为中心' },
]

const SECTIONS = [
  { id: 'brief', label: '研讨结论' },
  { id: 'answers', label: '议题回答' },
  { id: 'chain', label: '判断依据' },
  { id: 'decisions', label: '关键决策' },
  { id: 'claims', label: '结论清单' },
  { id: 'disputes', label: '未决分歧' },
  { id: 'actions', label: '下一步' },
  { id: 'baseline', label: '对比基线' },
  { id: 'process', label: '过程证据' },
  { id: 'diff', label: '版本变化' },
]

/**
 * 阅读模式决定目录，而不是只决定显示。
 * 简读保留“结论链/分歧/行动”；证据包只保留逐条结论、分歧和过程，
 * 避免用户切到证据模式后目录仍指向已隐藏的章节。
 */
const MODE_SECTIONS: Record<ReportReaderMode, string[]> = {
  brief: ['brief', 'chain', 'decisions', 'disputes', 'actions'],
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
  models = [],
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
  models?: ModelSummary[]
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
  const [query, setQuery] = useState('')
  const [checkedActions, setCheckedActions] = useState<Record<string, boolean>>({})
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const followInputRef = useRef<HTMLTextAreaElement>(null)

  const r = useMemo(() => (raw ? normalizeReport(raw) : null), [raw])
  const claims = useMemo(() => (r ? buildClaims(r) : []), [r])
  const decisions = useMemo(() => (r ? buildDecisions(r) : []), [r])
  const rankedClaims = useMemo(() => rankClaims(claims), [claims])
  const actions = useMemo(() => (r ? actionItemsFor(r) : []), [r])
  const diff = useMemo(() => (r ? diffReportRevision(r) : null), [r])
  const { shape } = reportShape(r?.meta?.strategy)

  const counts = useMemo(() => claimStatusCounts(claims), [claims])

  /** 全文搜索：结论、决策、分歧、行动四类，命中后跳到对应章节。 */
  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !r) return []
    const hits: Array<{ key: string; kind: string; text: string; sec: string; tone: string }> = []
    for (const c of claims) {
      if (`${c.claim} ${c.note}`.toLowerCase().includes(q)) {
        hits.push({ key: `c-${c.key}`, kind: '结论', text: c.title, sec: 'claims', tone: REPORT_STATUS_META[c.status].tone })
      }
    }
    for (const d of decisions) {
      if (`${d.decision.decision} ${(d.decision.premises ?? []).join(' ')}`.toLowerCase().includes(q)) {
        hits.push({ key: `d-${d.key}`, kind: '决策', text: d.title, sec: 'decisions', tone: 'ok' })
      }
    }
    for (const [i, d] of r.disputes.entries()) {
      if (`${d.claim} ${d.whyUnresolved}`.toLowerCase().includes(q)) {
        hits.push({ key: `x-${i}`, kind: '分歧', text: shortTitle(d.claim, 30), sec: 'disputes', tone: 'bad' })
      }
    }
    for (const a of actions) {
      if (a.action.toLowerCase().includes(q)) {
        hits.push({ key: `a-${a.id}`, kind: '行动', text: shortTitle(a.action, 30), sec: 'actions', tone: 'warn' })
      }
    }
    return hits.slice(0, 10)
  }, [query, r, claims, decisions, actions])

  const copyText = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1400)
    } catch {
      /* 剪贴板不可用时保持静默，页面不因一次复制失败中断 */
    }
  }, [])

  const modelNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of r?.meta?.models ?? []) map.set(m.id, m.displayName)
    return map
  }, [r])

  const nameOf = useCallback((id: string) => modelNames.get(id) ?? id, [modelNames])

  /** 模型头像：先找当前模型库里的品牌图标，找不到就用首字母 + 稳定色。 */
  const avatarFor = useCallback(
    (agentId: string): Pick<ModelSummary, 'id' | 'displayName' | 'color' | 'domain' | 'iconUrl' | 'homepage'> => {
      const live =
        models.find((m) => m.id === agentId) ??
        models.find((m) => m.displayName === agentId) ??
        models.find((m) => m.displayName === modelNames.get(agentId))
      if (live) return live
      const meta = (r?.meta?.models ?? []).find((m) => m.id === agentId || m.displayName === agentId)
      let hash = 0
      for (const ch of agentId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
      const colors = ['#6ea8fe', '#7bd88f', '#e3b341', '#d97b7b', '#b98cff', '#52c7b8']
      return {
        id: agentId,
        displayName: meta?.displayName ?? modelNames.get(agentId) ?? agentId,
        color: colors[hash % colors.length]!,
      }
    },
    [models, r, modelNames],
  )

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
      const prevMode = mode
      setMode('full')
      setModelFilter(null)
      setOnlyUnresolved(false)
      setOnlyActionable(false)
      setEvidence(null)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      // 导出取的是此刻的完整 DOM；抓完立刻把阅读模式还给用户
      onExport(kind)
      setMode(prevMode)
    },
    [mode, onExport],
  )

  const scrollTo = useCallback((id: string) => {
    setActive(id)
    const node = bodyRef.current?.querySelector<HTMLElement>(`[data-sec="${id}"]`)
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  /**
   * 筛选只作用于结论台账。简读版没有这一章时，点筛选必须把用户带到能看见结果的地方，
   * 否则按钮看起来毫无反应。
   */
  const revealClaims = useCallback(() => {
    if (!MODE_SECTIONS[mode].includes('claims')) setMode('full')
    scrollTo('claims')
  }, [mode, scrollTo])

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
      const max = root.scrollHeight - root.clientHeight
      setProgress(max > 0 ? Math.min(100, Math.round((root.scrollTop / max) * 100)) : 0)
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
  const headlineConclusion =
    decisions[0]?.title ?? rankedClaims[0]?.title ?? oneLiner(r.verdict.headline, r.executiveSummary, 44)
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
          <label className="rw-search">
            <Search size={13} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索结论、决策、分歧、行动"
              aria-label="搜索报告"
            />
            {query && (
              <button className="rw-search-clear" onClick={() => setQuery('')} aria-label="清空搜索">
                <X size={12} />
              </button>
            )}
            {query.trim() && (
              <div className="rw-search-pop">
                {searchHits.length === 0 ? (
                  <p className="rw-search-empty">没有命中。试试更短的关键词。</p>
                ) : (
                  searchHits.map((hit) => (
                    <button
                      key={hit.key}
                      className="rw-search-hit"
                      onClick={() => {
                        if (!MODE_SECTIONS[mode].includes(hit.sec)) setMode('full')
                        scrollTo(hit.sec)
                        setQuery('')
                      }}
                    >
                      <span className={`rw-search-kind tone-${hit.tone}`}>{hit.kind}</span>
                      <span>{hit.text}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </label>
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
      <div className="rw-progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>
      <div className="rw-conclusion-bar">
        <span className="rw-conclusion-label">
          <Target size={11} /> 研讨结论
        </span>
        <b className="rw-conclusion-text">{headlineConclusion}</b>
        <span className={`rw-level tone-${level.tone}`}>{level.label}</span>
        <button className="rw-conclusion-jump" onClick={() => scrollTo('brief')}>
          完整结论 <ChevronRight size={11} />
        </button>
      </div>
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
                if (!onlyUnresolved) revealClaims()
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
                if (!onlyActionable) revealClaims()
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
                  onClick={() => {
                    const next = modelFilter === m.id ? null : m.id
                    setModelFilter(next)
                    if (next) revealClaims()
                  }}
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
              claims={claims}
              rankedClaims={rankedClaims}
              topRisk={topRisk}
              openDisputeCount={openDisputeCount}
              actions={actions}
              onOpenEvidence={openEvidence}
              onCopy={copyText}
              copiedKey={copiedKey}
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
              <DecisionsSection decisions={decisions} n={num('decisions')} onOpenEvidence={openEvidence} onCopy={copyText} />
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
                onCopy={copyText}
              />
            </section>
          )}

          {sections.some((s) => s.id === 'disputes') && (
            <section className="rw-sec" data-sec="disputes">
              <DisputeMatrix
                r={r}
                n={num('disputes')}
                onOpenEvidence={openEvidence}
                avatarFor={avatarFor}
              />
            </section>
          )}

          {sections.some((s) => s.id === 'actions') && (
            <section className="rw-sec" data-sec="actions">
              <ActionSection
                r={r}
                actions={actions}
                n={num('actions')}
                checked={checkedActions}
                onToggle={(id) => setCheckedActions((cur) => ({ ...cur, [id]: !cur[id] }))}
                onOpenEvidence={openEvidence}
                onCopy={copyText}
              />
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
  decisions,
  claims,
  rankedClaims,
  topRisk,
  openDisputeCount,
  actions,
  onOpenEvidence,
  onCopy,
  copiedKey,
}: {
  r: Report
  level: { label: string; tone: 'ok' | 'warn' | 'bad'; hint: string }
  decisions: ReportDecisionView[]
  claims: ReportClaimView[]
  rankedClaims: ReportClaimView[]
  topRisk?: Report['disputes'][number]
  openDisputeCount: number
  actions: ReportActionItem[]
  onOpenEvidence: (t: EvidenceTarget) => void
  onCopy: (key: string, text: string) => void
  copiedKey: string | null
}) {
  const stats = claimStatusCounts(claims)
  const primary = decisions[0]
  const topClaim = rankedClaims[0]
  const answer = primary?.title || topClaim?.title || oneLiner(r.verdict.headline, r.executiveSummary, 44)
  const usable =
    level.tone === 'ok'
      ? '可以直接拿去做决定'
      : level.tone === 'warn'
        ? '可用于方向判断，落地前先补齐待验证项'
        : '只能当作议题清单，不能当成结论'
  /**
   * 没有终局决策时，首屏不能只显示“没有记录”。这时退到审校给出的档位判据
   * 和已知盲区，读者至少知道为什么只能信到这个程度。
   */
  const premises = primary ? primary.decision.premises : r.verdict.reasons
  const costs = primary ? primary.decision.costs : r.blindSpots
  const premiseLabel = primary ? '为什么这样判断' : '为什么只能信到这个程度'
  const costLabel = primary ? '代价和边界' : '还没覆盖的地方'
  const nextAction = actions[0]
  const nextText =
    nextAction?.action ?? r.nextActions[0] ?? '本场没有形成可执行行动；先把未决分歧补成问题清单。'
  return (
    <div className="rw-brief rw-hero">
      <div className="rw-hero-bar">
        <span className={`rw-level tone-${level.tone}`}>
          <Target size={13} />
          {level.label}
        </span>
        <span className="rw-hero-kicker">一句话结论</span>
        <button className="rw-hero-copy" onClick={() => onCopy('hero', answer)}>
          {copiedKey === 'hero' ? <Check size={12} /> : <Copy size={12} />}
          {copiedKey === 'hero' ? '已复制' : '复制'}
        </button>
      </div>
      <h3 className="rw-hero-answer">{answer}</h3>
      {primary ? (
        <FoldText text={primary.decision.decision} lines={2} threshold={44} className="rw-hero-detail" />
      ) : (
        topClaim && (
          <p className="rw-hero-note">
            终局审校没有产出单一决策。下面这条是本场证据最扎实的共识，可以直接拿去用；其余结论按可信度依次列出。
          </p>
        )
      )}
      <div className="rw-hero-topline">
        <CoverageRing value={r.verdict.coverage ?? 0} />
        <div className="rw-hero-metrics">
          <div className="rw-hero-metric tone-ok">
            <b>{stats.confirmed}</b>
            <span>条已确认</span>
          </div>
          <div className="rw-hero-metric tone-warn">
            <b>{stats.qualified}</b>
            <span>条要打折</span>
          </div>
          <div className="rw-hero-metric tone-bad">
            <b>{stats.contested + stats.unsupported}</b>
            <span>条未站住</span>
          </div>
          <div className="rw-hero-metric">
            <b>{actions.length}</b>
            <span>项可执行</span>
          </div>
        </div>
      </div>
      <StatusStack counts={stats} />
      <div className="rw-hero-legend">
        <span><i className="tone-ok" />可确认 {stats.confirmed}</span>
        <span><i className="tone-warn" />有条件 {stats.qualified}</span>
        <span><i className="tone-bad" />有争议 {stats.contested}</span>
        <span><i className="tone-bad" />证据不足 {stats.unsupported}</span>
      </div>
      <div className={`rw-usable tone-${level.tone}`}>
        <span>能不能直接用</span>
        <b>{usable}</b>
      </div>
      {rankedClaims.length > 0 && (
        <div className="rw-keypoints">
          <div className="rw-keypoints-head">
            <span>{primary ? '支撑这个结论的要点' : '本场能拿走的结论'}</span>
            <span className="rw-keypoints-count">{rankedClaims.length} 条共识</span>
          </div>
          <ol>
            {rankedClaims.slice(0, 3).map((claim, i) => (
              <li key={claim.key}>
                <button
                  className={`rw-keypoint tone-${REPORT_STATUS_META[claim.status].tone}`}
                  onClick={() => onOpenEvidence({ kind: 'claim', key: claim.key })}
                >
                  <span className="rw-keypoint-i">{i + 1}</span>
                  <span className="rw-keypoint-text">{claim.title}</span>
                  <em>{REPORT_STATUS_META[claim.status].label}</em>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="rw-brief-grid">
        <div className="rw-brief-cell">
          <span className="rw-brief-cell-k">{premiseLabel}</span>
          {premises.length > 0 ? (
            <ul>
              {premises.map((x, i) => (
                <li key={i}>
                  <FoldText text={x} lines={2} threshold={52} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="rw-muted">终局审校没有记录前提。这只能说明它没给出理由，不能当成理由不存在。</p>
          )}
        </div>
        <div className="rw-brief-cell">
          <span className="rw-brief-cell-k">{costLabel}</span>
          {costs.length > 0 ? (
            <ul>
              {costs.map((x, i) => (
                <li key={i}>
                  <FoldText text={x} lines={2} threshold={52} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="rw-muted">没有记录代价。选择意味着放弃什么，这里还没回答。</p>
          )}
        </div>
        <div className="rw-brief-cell rw-brief-cell-risk">
          <span className="rw-brief-cell-k">最大分歧</span>
          {topRisk ? (
            <>
              <p className="rw-brief-risk">{shortTitle(topRisk.claim, 46)}</p>
              <p className="rw-brief-risk-note">{clip(plainMd(topRisk.whyUnresolved), 96)}</p>
              <button
                className="rw-inline-link"
                onClick={() => onOpenEvidence({ kind: 'dispute', key: topRisk.claim })}
              >
                查看双方原话 <ChevronRight size={12} />
              </button>
            </>
          ) : (
            <p className="rw-muted">这次没有留下未收敛的争议。</p>
          )}
        </div>
        <div className="rw-brief-cell rw-brief-cell-next">
          <span className="rw-brief-cell-k">下一步</span>
          <p className="rw-brief-action">{shortTitle(nextText, 72)}</p>
          {nextAction && (
            <p className="rw-brief-action-meta">
              {nextAction.owner ?? '负责人待指定'} · {nextAction.due ?? '时间待定'}
            </p>
          )}
          {nextAction?.doneWhen && (
            <p className="rw-brief-action-done">
              完成标准：{clip(plainMd(nextAction.doneWhen), 60)}
            </p>
          )}
        </div>
      </div>
      {r.verdict.reasons.length > 0 && (
        <details className="rw-hero-more">
          <summary>为什么是这个置信档位（{r.verdict.reasons.length} 条判据）</summary>
          <ul>
            {r.verdict.reasons.map((reason, i) => (
              <li key={i}>{clip(plainMd(reason), 180)}</li>
            ))}
          </ul>
        </details>
      )}
      {r.executiveSummary && (
        <details className="rw-hero-more">
          <summary>完整摘要（{r.executiveSummary.length} 字）</summary>
          <p>{r.executiveSummary}</p>
        </details>
      )}
      <div className="rw-brief-foot">
        <span>
          <Users size={11} /> {(r.meta?.models ?? []).length} 个模型
        </span>
        <span>
          <CheckCircle size={11} /> {r.consensus.length} 条结论
        </span>
        <span className={openDisputeCount > 0 ? 'warn' : ''}>
          <Swords size={11} /> {openDisputeCount} 条分歧
        </span>
        <span>
          <ClipboardList size={11} /> {actions.length} 项行动
        </span>
        {r.blindSpots.length > 0 && (
          <span className="warn">
            <AlertTriangle size={11} /> {r.blindSpots.length} 个盲区
          </span>
        )}
      </div>
    </div>
  )
}

function AnswersSection({ r, n, onOpenEvidence }: { r: Report; n: string; onOpenEvidence: (t: EvidenceTarget) => void }) {
  const qs = r.questions
  if (!qs) {
    return (
      <div className="rw-block">
        <BlockHead n={n} title="问题回答" hint="这场研讨有没有把原始问题答完" />
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
      <BlockHead n={n} title="问题回答" hint="原始问题现在能不能据此行动" />
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
  n,
  claims,
  onOpenEvidence,
}: {
  r: Report
  n: string
  claims: ReportClaimView[]
  onOpenEvidence: (t: EvidenceTarget) => void
}) {
  const rawDecision = r.finalReview?.decisions[0]
  const base = splitClauses(r.executiveSummary, 2)
  const top = claims.slice(0, 4)
  return (
    <div className="rw-block">
      <BlockHead n={n} title="论证链" hint="从问题走到判断，中间只保留几个关键台阶" />
      <div className="rw-flow">
        <div className="rw-flow-step">
          <span className="rw-flow-k">1</span>
          <div className="rw-flow-main">
            <b>要回答什么</b>
            {(base.length > 0 ? base : [r.verdict.headline]).map((text, i) => (
              <p key={i} className="rw-flow-text">{clip(plainMd(text), 130)}</p>
            ))}
          </div>
        </div>
        <div className="rw-flow-step">
          <span className="rw-flow-k">2</span>
          <div className="rw-flow-main">
            <b>哪些结论撑住了判断</b>
            <div className="rw-flow-chips">
              {top.map((claim) => (
                <button
                  key={claim.key}
                  className={`rw-flow-chip tone-${REPORT_STATUS_META[claim.status].tone}`}
                  onClick={() => onOpenEvidence({ kind: 'claim', key: claim.key })}
                  title={REPORT_STATUS_META[claim.status].hint}
                >
                  {claim.title}
                </button>
              ))}
              {top.length === 0 && <p className="rw-muted">没有记录可支撑判断的结论。</p>}
            </div>
          </div>
        </div>
        <div className="rw-flow-step kind-decision">
          <span className="rw-flow-k">3</span>
          <div className="rw-flow-main">
            <b>所以怎么判断</b>
            <p className="rw-flow-text">
              {shortTitle(rawDecision?.decision ?? top[0]?.claim ?? r.verdict.headline, 58)}
            </p>
            {(rawDecision?.premises ?? []).length > 0 && (
              <div className="rw-flow-note">
                前提：{(rawDecision?.premises ?? []).map((p) => clip(plainMd(p), 38)).join('；')}
              </div>
            )}
          </div>
        </div>
        {(rawDecision?.costs ?? []).length > 0 && (
          <div className="rw-flow-step kind-cost">
            <span className="rw-flow-k">4</span>
            <div className="rw-flow-main">
              <b>代价和边界</b>
              <ul className="rw-flow-list">
                {(rawDecision?.costs ?? []).map((cost, i) => (
                  <li key={i}>{clip(plainMd(cost), 100)}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
      {rawDecision && (rawDecision.evidence ?? []).length > 0 && (
        <button
          className="rw-inline-link"
          onClick={() => onOpenEvidence({ kind: 'decision', key: rawDecision.id })}
        >
          查看支撑原话（{(rawDecision.evidence ?? []).length}） <ChevronRight size={12} />
        </button>
      )}
    </div>
  )
}

function DecisionsSection({
  decisions,
  n,
  onOpenEvidence,
  onCopy,
}: {
  decisions: ReportDecisionView[]
  n: string
  onOpenEvidence: (t: EvidenceTarget) => void
  onCopy: (key: string, text: string) => void
}) {
  return (
    <div className="rw-block">
      <BlockHead
        n={n}
        title="决策台账"
        hint={`${decisions.length} 个终局判断 · 先看标题，逐条展开依据和代价`}
      />
      {decisions.length === 0 ? (
        <p className="rw-muted">这次没有形成可持续追踪的终局决策。</p>
      ) : (
        <div className="rw-decisions">
          {decisions.map((view, index) => {
            const d = view.decision
            return (
              <article key={view.key} className="rw-decision">
                <header className="rw-decision-head">
                  <span className="rw-decision-n">D{String(index + 1).padStart(2, '0')}</span>
                  <div className="rw-decision-title">
                    <h4>{view.title}</h4>
                    <FoldText text={d.decision} lines={2} threshold={36} />
                  </div>
                  <button
                    className="rw-icon-btn"
                    onClick={() => onCopy(view.key, d.decision)}
                    title="复制这条决策"
                  >
                    <Copy size={12} />
                  </button>
                </header>
                <div className="rw-decision-facts">
                  <DecisionFact label="依据结论" items={d.basedOnClaims ?? []} />
                  <DecisionFact label="成立前提" items={d.premises ?? []} />
                  <DecisionFact label="代价与缺口" items={d.costs ?? []} tone="warn" />
                </div>
                {view.actionItems.length > 0 && (
                  <div className="rw-decision-actions">
                    <b>要走这一步</b>
                    {view.actionItems.map((item, actionIndex) => (
                      <p key={`${item.id}-${actionIndex}`}>
                        <Check size={11} />
                        <span className="rw-decision-action-text">{shortTitle(item.action, 80)}</span>
                        <span>
                          {item.owner ?? '负责人待定'} · {item.due ?? '时间待定'}
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
                    查看支撑原话（{(d.evidence ?? []).length}） <ChevronRight size={12} />
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
            <li key={index}>
              <FoldText text={item} lines={2} threshold={56} />
            </li>
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
  n,
  onOpenEvidence,
  onFollowUp,
  onCopy,
}: {
  claims: ReportClaimView[]
  total: number
  n: string
  onOpenEvidence: (t: EvidenceTarget) => void
  onFollowUp: (claim: ReportClaimView) => void
  onCopy: (key: string, text: string) => void
}) {
  const stats = claimStatusCounts(claims)
  return (
    <div className="rw-block">
      <BlockHead
        n={n}
        title="结论台账"
        hint={`${claims.length} / ${total} 条 · 每条标出能信到什么程度、证据够不够`}
      />
      <div className="rw-claim-summary">
        <span className="tone-ok">可确认 {stats.confirmed}</span>
        <span className="tone-warn">有条件 {stats.qualified}</span>
        <span className="tone-bad">有争议 {stats.contested}</span>
        <span className="tone-bad">证据不足 {stats.unsupported}</span>
      </div>
      {claims.length === 0 ? (
        <p className="rw-muted">当前筛选下没有结论。</p>
      ) : (
        <div className="rw-claims">
          {claims.map((claim, index) => {
            const meta = REPORT_STATUS_META[claim.status]
            return (
              <article key={claim.key} className={`rw-claim tone-${meta.tone}`}>
                <div className="rw-claim-row">
                  <span className="rw-claim-idx">{String(index + 1).padStart(2, '0')}</span>
                  <div className="rw-claim-main">
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
                      <h4>{claim.title}</h4>
                    </header>
                    {claim.gist && claim.gist !== claim.title && (
                      <p className="rw-claim-gist">{claim.gist}</p>
                    )}
                    <StrengthMeter
                      support={claim.supportRatio}
                      hardness={claim.hardness}
                      confidence={claim.confidence}
                    />
                    <div className="rw-claim-facts">
                      <span>
                        <Users size={11} /> 支持 {claim.supporters.length}
                      </span>
                      {claim.opposedBy.length > 0 && (
                        <span className="warn">
                          <Swords size={11} /> 反对 {claim.opposedBy.length}
                        </span>
                      )}
                      {claim.crossExamined && (
                        <span className="ok">
                          <GitBranch size={11} /> 交叉询问
                        </span>
                      )}
                      {claim.sourceRounds.length > 0 && (
                        <span>
                          <Layers size={11} /> R{claim.sourceRounds.join(' / R')}
                        </span>
                      )}
                      <span>
                        <Quote size={11} /> 原话 {claim.evidence.length}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="rw-claim-detail">
                  <FoldText text={claim.claim} lines={3} threshold={40} />
                  {claim.note && claim.note !== claim.claim && (
                    <div className="rw-claim-argument">
                      <span>为什么这样判断</span>
                      <FoldText text={claim.note} lines={2} threshold={96} />
                    </div>
                  )}
                  {isMostlyLatin(claim.claim) && (
                    <p className="rw-claim-lang">这段原话主要是英文，建议结合下方原话与模型名理解。</p>
                  )}
                  <footer className="rw-claim-foot">
                    <button
                      className="rw-inline-link"
                      onClick={() => onOpenEvidence({ kind: 'claim', key: claim.key })}
                    >
                      <Quote size={12} /> 查看原话（{claim.evidence.length}）
                    </button>
                    <button className="rw-inline-link" onClick={() => onCopy(claim.key, claim.claim)}>
                      <Copy size={12} /> 复制结论
                    </button>
                    <button className="rw-inline-link" onClick={() => onFollowUp(claim)}>
                      <MessageSquare size={12} /> 继续追问
                    </button>
                    {claim.supporters.length > 0 && (
                      <span className="rw-claim-who">{claim.supporters.join('、')}</span>
                    )}
                  </footer>
                </div>
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
  n,
  onOpenEvidence,
  avatarFor,
}: {
  r: Report
  n: string
  onOpenEvidence: (t: EvidenceTarget) => void
  avatarFor: (
    id: string,
  ) => Pick<ModelSummary, 'id' | 'displayName' | 'color' | 'domain' | 'iconUrl' | 'homepage'>
}) {
  const disputes = r.disputes
  const openCount = disputes.filter((d) => !d.shelved).length
  /**
   * 老报告可能只有 quotes 没有 sides。没有按模型整理的立场时，用原话兜底，
   * 至少让读者看清“谁说了什么”，而不是留一片空白。
   */
  const sidesOf = (d: Report['disputes'][number]) => {
    if (d.sides.length > 0) return d.sides
    const byAgent = new Map<string, { agentId: string; argument: string; sourceRounds: number[] }>()
    for (const q of d.quotes ?? []) {
      const cur = byAgent.get(q.agentId)
      if (cur) {
        if (!cur.argument.includes(q.quote)) cur.argument = `${cur.argument}\n${q.quote}`
        if (!cur.sourceRounds.includes(q.round)) cur.sourceRounds.push(q.round)
      } else {
        byAgent.set(q.agentId, { agentId: q.agentId, argument: q.quote, sourceRounds: [q.round] })
      }
    }
    return [...byAgent.values()]
  }
  return (
    <div className="rw-block">
      <BlockHead
        n={n}
        title="未决分歧"
        hint={
          disputes.length === 0
            ? '这场没有未决争议'
            : `${disputes.length} 条分歧，其中 ${openCount} 条仍未收敛 · 它们没有写进最终结论`
        }
      />
      {disputes.length === 0 ? (
        <p className="rw-muted">
          这场研讨没有留下未收敛的分歧记录。注意：这不等于“全员完全一致”，也可能只是分歧没有被结构化地记下来。
        </p>
      ) : (
        <div className="rw-disputes">
          {disputes.map((d, index) => {
            const sides = sidesOf(d)
            const absent = (r.meta?.models ?? []).filter(
              (m) => !sides.some((side) => side.agentId === m.id || side.agentId === m.displayName),
            )
            return (
              <article key={`${d.claim}-${index}`} className="rw-dispute">
                <header className="rw-dispute-head">
                  <span className="rw-dispute-n">X{String(index + 1).padStart(2, '0')}</span>
                  <div className="rw-dispute-title">
                    <h4>{shortTitle(d.claim, 36)}</h4>
                  </div>
                  <span className={d.shelved ? 'rw-chip' : 'rw-chip warn'}>
                    {d.shelved ? '暂缓' : `未收敛 · ${d.roundsEngaged} 轮`}
                  </span>
                </header>

                <div className="rw-dispute-question">
                  <span>争的是什么</span>
                  <FoldText text={d.claim} lines={2} threshold={32} />
                </div>

                <div className="rw-side-list">
                  {sides.map((side) => {
                    const model = avatarFor(side.agentId)
                    return (
                      <div key={side.agentId} className="rw-side">
                        <div className="rw-side-head">
                          <ModelAvatar model={model} size={22} className="rw-side-avatar" />
                          <b>{model.displayName}</b>
                          <span className="rw-side-round">
                            {side.sourceRounds.map((x) => `R${x}`).join(' · ') || '轮次未记录'}
                          </span>
                        </div>
                        <FoldText text={side.argument} lines={3} threshold={64} />
                      </div>
                    )
                  })}
                  {sides.length === 0 && (
                    <p className="rw-muted">这一轮没有按模型记录各自的立场，只能看下方原话。</p>
                  )}
                </div>

                <div className="rw-dispute-why">
                  <AlertTriangle size={12} />
                  <div>
                    <b>为什么还没谈拢</b>
                    <FoldText text={d.shelved ? d.shelved.reason : d.whyUnresolved} lines={2} threshold={64} />
                  </div>
                </div>

                <div className={`rw-dispute-outcome${d.shelved ? '' : ' tone-warn'}`}>
                  <span>对最终结论的影响</span>
                  <b>{d.shelved ? '已暂缓，没有写进决策' : '仍未收敛，最终决策只采纳了能核准的部分'}</b>
                </div>

                <footer className="rw-claim-foot">
                  <button
                    className="rw-inline-link"
                    onClick={() => onOpenEvidence({ kind: 'dispute', key: d.claim })}
                  >
                    <Quote size={12} /> 查看双方原话（{d.quotes.length}）
                  </button>
                  {absent.length > 0 && (
                    <span className="rw-dispute-absent">
                      未表态：{absent.map((m) => m.displayName).join('、')}
                    </span>
                  )}
                  {d.dueled && (
                    <span className="rw-claim-who">
                      <Swords size={11} /> 进行过专门对抗
                    </span>
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

function ActionSection({
  r,
  actions,
  n,
  checked,
  onToggle,
  onOpenEvidence,
  onCopy,
}: {
  r: Report
  actions: ReportActionItem[]
  n: string
  checked: Record<string, boolean>
  onToggle: (id: string) => void
  onOpenEvidence: (t: EvidenceTarget) => void
  onCopy: (key: string, text: string) => void
}) {
  const risks = r.nextActions.filter((text) => !actions.some((a) => a.action === text))
  const done = actions.filter((a) => checked[a.id]).length
  const groups = new Map<string, ReportActionItem[]>()
  for (const item of actions) {
    const owner = item.owner?.trim() || '负责人待指定'
    groups.set(owner, [...(groups.get(owner) ?? []), item])
  }
  return (
    <div className="rw-block">
      <BlockHead n={n} title="行动清单" hint="谁、什么时候、做到什么算完成；勾选只记在本机阅读状态" />
      {actions.length === 0 ? (
        <p className="rw-muted">这次没有形成结构化行动。下面的文字仍然需要人工判断怎么落地。</p>
      ) : (
        <>
          <div className="rw-action-progress">
            <span>
              已完成 <b>{done}</b> / {actions.length}
            </span>
            <i>
              <b style={{ width: `${(done / Math.max(1, actions.length)) * 100}%` }} />
            </i>
          </div>
          <div className="rw-action-groups">
            {[...groups.entries()].map(([owner, items]) => (
              <section key={owner} className="rw-action-group">
                <h4>
                  <Users size={12} /> {owner}
                  <span>{items.length} 项</span>
                </h4>
                {items.map((item) => {
                  const isDone = Boolean(checked[item.id])
                  return (
                    <article key={item.id} className={`rw-action${isDone ? ' done' : ''}`}>
                      <button
                        className="rw-check"
                        aria-pressed={isDone}
                        onClick={() => onToggle(item.id)}
                        title={isDone ? '标记为未完成' : '标记为已完成'}
                      >
                        {isDone ? <Check size={12} /> : <Square size={12} />}
                      </button>
                      <div className="rw-action-main">
                        <p className="rw-action-text">{shortTitle(item.action, 90)}</p>
                        <div className="rw-action-fields">
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
                      <div className="rw-action-tools">
                        <button className="rw-icon-btn" onClick={() => onCopy(item.id, item.action)} title="复制这项行动">
                          <Copy size={12} />
                        </button>
                        <button
                          className="rw-icon-btn"
                          onClick={() => onOpenEvidence({ kind: 'action', key: item.id })}
                          title="查看依据"
                        >
                          <ChevronRight size={12} />
                        </button>
                      </div>
                    </article>
                  )
                })}
              </section>
            ))}
          </div>
        </>
      )}
      {risks.length > 0 && (
        <div className="rw-risks">
          <span className="rw-risks-title">还需要人工判断怎么落地</span>
          <ul>
            {risks.map((text, i) => (
              <li key={i}>{clip(plainMd(text), 180)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function BaselineSection({ r, n }: { r: Report; n: string }) {
  const b = r.baseline
  const cmp = r.baselineCompare
  if (!b) {
    return (
      <div className="rw-block">
        <BlockHead n={n} title="基线对照" hint="这场研讨比单模型回答多出了什么" />
        <p className="rw-muted">本场没有跑单模型基线，因此无法说明“讨论带来了什么增量”。</p>
      </div>
    )
  }
  return (
    <div className="rw-block">
      <BlockHead n={n} title="基线对照" hint="这场研讨比单模型回答多出了什么" />
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

function ProcessSection({ r, n }: { r: Report; n: string }) {
  const figures = runFigures(r)
  const timeline = r.timeline
  return (
    <div className="rw-block">
      <BlockHead n={n} title="证据与过程" hint="这场讨论是怎么跑完的" />
      <div className="rw-figs">
        {figures.map((f) => (
          <span key={f.k} className={`rw-fstat${f.warn ? ' warn' : ''}`} title={f.note}>
            {f.k}
            <b>{f.v}</b>
          </span>
        ))}
      </div>
      {timeline.length > 1 && (
        <div className="rw-trend-wrap">
          <span className="rw-trend-title">
            <TrendingUp size={12} /> 累计共识
          </span>
          <TrendLine
            points={timeline.reduce<Array<{ round: number; value: number }>>((acc, row) => {
              acc.push({ round: row.round, value: (acc.at(-1)?.value ?? 0) + row.newConsensus })
              return acc
            }, [])}
          />
        </div>
      )}
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
