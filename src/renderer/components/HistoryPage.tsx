import { useCallback, useEffect, useState } from 'react'
import {
  FINISH_REASON_LABEL,
  RETRY_MODE_HINT,
  RETRY_MODE_LABEL,
  type HistoryEntry,
  type RetryMode,
  type RetryPlan,
} from '@shared/retry'
import { buildTranscriptMarkdown } from '@shared/transcript'
import type { SessionRecord } from '@shared/types'
import type { ModelSummary } from '../store'
import {
  Search,
  ArrowLeft,
  RotateCcw,
  X,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Eye,
  DollarSign,
  MessageSquare,
  Swords,
  Users,
  Trash2,
  Check,
  Play,
  Copy,
  FileDown,
} from 'lucide-react'

export function HistoryPage({
  models,
  onRetry,
  onReplay,
  onClose,
}: {
  models: ModelSummary[]
  onRetry: (plan: RetryPlan, sessionId: string) => void
  onReplay: (sessionId: string) => void
  onClose: () => void
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<HistoryEntry | null>(null)
  const [record, setRecord] = useState<SessionRecord | null>(null)
  const [report, setReport] = useState<unknown>(null)
  const [q, setQ] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ id: string; msg: string } | null>(null)

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id

  const showFlash = (id: string, msg: string) => {
    setFlash({ id, msg })
    setTimeout(() => setFlash((cur) => (cur?.id === id ? null : cur)), 2400)
  }

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    window.torra
      .listHistory()
      .then((list) => setEntries(list as HistoryEntry[]))
      .catch((e) => setLoadError((e as Error).message || '加载历史失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = q.trim()
    ? entries.filter(
        (e) =>
          e.title.includes(q.trim()) || e.statusNote.includes(q.trim()),
      )
    : entries

  const openDetail = async (e: HistoryEntry) => {
    setSelected(e)
    setRecord(null)
    setReport(null)
    try {
      const d = (await window.torra.getSessionDetail(e.id)) as
        | { record: SessionRecord; report: unknown }
        | null
      setRecord(d?.record ?? null)
      setReport(d?.report ?? null)
    } catch {
      setRecord(null)
      setReport(null)
    }
  }

  const loadRecord = async (sessionId: string): Promise<SessionRecord | null> => {
    if (record?.id === sessionId) return record
    const d = (await window.torra.getSessionDetail(sessionId)) as
      | { record: SessionRecord }
      | null
    return d?.record ?? null
  }

  const copyTranscript = async (sessionId: string) => {
    const rec = await loadRecord(sessionId)
    if (!rec) {
      showFlash(sessionId, '记录载入失败')
      return
    }
    const md = buildTranscriptMarkdown(rec, nameOf)
    try {
      await navigator.clipboard.writeText(md)
      showFlash(sessionId, '完整记录已复制到剪贴板')
    } catch {
      showFlash(sessionId, '复制失败，请改用导出文件')
    }
  }

  const exportTranscript = async (sessionId: string) => {
    const r = await window.torra.exportTranscript(sessionId)
    showFlash(sessionId, r.ok ? `已导出：${r.path}` : '导出失败')
  }

  const handleDelete = async (id: string) => {
    setConfirmDelete(null)
    setDeleting(id)
    setDeleteError(null)
    try {
      const r = await window.torra.removeSession(id)
      if (!r.ok) {
        setDeleteError('删除失败，请重试')
        return
      }
      setEntries((prev) => prev.filter((e) => e.id !== id))
      setSelected((cur) => (cur?.id === id ? null : cur))
    } catch (e) {
      setDeleteError((e as Error).message || '删除失败')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="history-page">
      <div className="history-head">
        <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
          <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
          <input
            className="history-search"
            type="text"
            placeholder="搜索议题标题或状态"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <span className="history-count">{filtered.length} 场</span>
        <button className="btn sm" onClick={onClose}>
          <ArrowLeft size={12} />
          返回讨论
        </button>
      </div>

      {loading && <div className="history-empty">加载中…</div>}
      {!loading && loadError && (
        <div className="history-empty">
          {loadError}
          <button className="btn sm" style={{ marginLeft: 10 }} onClick={load}>
            <RotateCcw size={11} />
            重试
          </button>
        </div>
      )}
      {!loading && !loadError && filtered.length === 0 && (
        <div className="history-empty">还没有讨论记录，去发起第一场吧</div>
      )}

      {deleteError && (
        <div className="history-error">
          {deleteError}
          <button className="btn sm icon" style={{ marginLeft: 8 }} onClick={() => setDeleteError(null)}>
            <X size={11} />
          </button>
        </div>
      )}

      <div className="history-list">
        {filtered.map((e) => (
          <div key={e.id} className={`history-item${selected?.id === e.id ? ' active' : ''}`}>
            <div className="history-item-main" onClick={() => void openDetail(e)}>
              <div className="history-title">
                {e.title || '未命名议题'}
                <span className={`hist-badge ${e.finishedReason ?? 'running'}`}>
                  {e.finishedReason ? (FINISH_REASON_LABEL[e.finishedReason] ?? '已结束') : '进行中'}
                </span>
                {e.retryModeTag && <span className="hist-badge retry">重试</span>}
              </div>
              <div className="history-meta">
                <span>{e.statusNote}</span>
                <span>{new Date(e.updatedAt).toLocaleString('zh-CN')}</span>
              </div>
              <div className="history-stats">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <CheckCircle size={10} /> {e.consensusCount}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <AlertTriangle size={10} /> {e.openDisputeCount}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <MessageSquare size={10} /> {e.interventionCount}
                </span>
                {e.duelCount > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <Swords size={10} /> {e.duelCount}
                  </span>
                )}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <DollarSign size={10} /> ${e.totalCostUsd.toFixed(4)}
                </span>
                {e.absentAgentIds.length > 0 && (
                  <span className="warn" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <Users size={10} /> 缺席 {e.absentAgentIds.map(nameOf).join('、')}
                  </span>
                )}
              </div>
            </div>
            <div className="history-actions">
              <button
                className="btn sm icon"
                title="回放此会话（只读重现议事厅）"
                onClick={() => onReplay(e.id)}
              >
                <Play size={13} />
              </button>
              <button
                className="btn sm icon"
                title="复制完整讨论记录到剪贴板"
                onClick={() => void copyTranscript(e.id)}
              >
                <Copy size={13} />
              </button>
              <button
                className="btn sm icon"
                title="导出完整讨论记录为 Markdown"
                onClick={() => void exportTranscript(e.id)}
              >
                <FileDown size={13} />
              </button>
              <RetryMenu entry={e} models={models} onRetry={onRetry} />
              {confirmDelete === e.id ? (
                <>
                  <button
                    className="btn sm icon danger"
                    title="确认删除"
                    onClick={() => void handleDelete(e.id)}
                    disabled={deleting === e.id}
                  >
                    <Check size={13} />
                  </button>
                  <button
                    className="btn sm icon"
                    title="取消"
                    onClick={() => setConfirmDelete(null)}
                  >
                    <X size={13} />
                  </button>
                </>
              ) : (
                <button
                  className="btn sm icon danger-hover"
                  title="删除此记录"
                  onClick={() => setConfirmDelete(e.id)}
                  disabled={deleting === e.id}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            {flash?.id === e.id && <div className="history-flash">{flash.msg}</div>}
          </div>
        ))}
      </div>

      {selected && (
        <ReportViewer entry={selected} report={report} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

function RetryMenu({
  entry,
  models,
  onRetry,
}: {
  entry: HistoryEntry
  models: ModelSummary[]
  onRetry: (plan: RetryPlan, sessionId: string) => void
}) {
  const [open, setOpen] = useState<RetryMode | null>(null)

  const modes: Array<{ mode: RetryMode; enabled: boolean; reason?: string }> = [
    { mode: 'rerun', enabled: true },
    { mode: 'continue', enabled: true },
    {
      mode: 'fill-missing',
      enabled: entry.absentAgentIds.length > 0,
      reason: entry.absentAgentIds.length === 0 ? '上一场无缺席模型' : undefined,
    },
    {
      mode: 'dispute',
      enabled: entry.openDisputeCount > 0,
      reason: entry.openDisputeCount === 0 ? '上一场无保留分歧' : undefined,
    },
  ]

  const run = (mode: RetryMode) => {
    setOpen(null)
    onRetry({ mode, usePriorConclusion: mode === 'continue' }, entry.id)
  }

  return (
    <div className="retry-wrap">
      <button
        className="btn sm icon"
        title="重试此会话"
        onClick={() => setOpen(open ? null : ('rerun' as RetryMode))}
      >
        <RotateCcw size={13} />
      </button>
      {open && (
        <div className="retry-menu" onMouseLeave={() => setOpen(null)}>
          {modes.map((m) => (
            <div
              key={m.mode}
              className={`retry-item${m.enabled ? '' : ' disabled'}`}
              onClick={() => m.enabled && run(m.mode)}
              title={m.enabled ? RETRY_MODE_HINT[m.mode] : m.reason}
            >
              <div className="retry-item-label">{RETRY_MODE_LABEL[m.mode]}</div>
              <div className="retry-item-hint">
                {m.enabled ? RETRY_MODE_HINT[m.mode] : m.reason}
              </div>
            </div>
          ))}
          <div className="retry-item-note">
            重试会创建新会话，原报告保留。
          </div>
        </div>
      )}
    </div>
  )
}

function ReportViewer({
  entry,
  report,
  onClose,
}: {
  entry: HistoryEntry
  report: unknown
  onClose: () => void
}) {
  const r = report as
    | {
        executiveSummary: string
        consensus: Array<{ claim: string; supporters: string[]; sourceRounds: number[] }>
        disputes: Array<{
          claim: string
          sides: Array<{ agentId: string; argument: string; sourceRounds: number[] }>
          whyUnresolved: string
        }>
        blindSpots: string[]
        interventions: string[]
        duels: Array<{ topic: string; agentIds: string[]; utteranceCount: number }>
        meta: { rounds: number; totalCostUsd: number; finalConsensusScore: { score: number } | null }
      }
    | null

  // 早期落盘的报告缺 interventions/duels 等字段，逐个归一化，
  // 否则单条老记录会让详情弹窗渲染崩溃、整页白屏
  const consensus = r?.consensus ?? []
  const disputes = r?.disputes ?? []
  const interventions = r?.interventions ?? []
  const duels = r?.duels ?? []
  const blindSpots = r?.blindSpots ?? []
  const meta = r?.meta ?? { rounds: 0, totalCostUsd: 0, finalConsensusScore: null }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <h2>
            <Eye size={16} />
            {entry.title}
          </h2>
          <button className="btn icon" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {!r ? (
          <div className="history-empty">该会话没有报告</div>
        ) : (
          <div className="report-body">
            <div className="report-sec">
              <div className="report-sec-title">执行摘要</div>
              <p>{r.executiveSummary}</p>
            </div>

            {consensus.length > 0 && (
              <div className="report-sec">
                <div className="report-sec-title">
                  <CheckCircle size={11} />
                  共识结论（{consensus.length}）
                </div>
                {consensus.map((c, i) => (
                  <div key={i} className="report-consensus">
                    <div className="report-claim">{c.claim}</div>
                    <div className="report-sub">
                      认同 {(c.supporters ?? []).join('、')} · 第 {(c.sourceRounds ?? []).join('、')} 轮
                    </div>
                  </div>
                ))}
              </div>
            )}

            {disputes.length > 0 && (
              <div className="report-sec">
                <div className="report-sec-title">
                  <AlertTriangle size={11} />
                  保留分歧（{disputes.length}）
                </div>
                {disputes.map((d, i) => (
                  <div key={i} className="report-dispute">
                    <div className="report-claim">{d.claim}</div>
                    {(d.sides ?? []).map((s, j) => (
                      <div key={j} className="report-side">
                        <b>{s.agentId}</b>：{s.argument}
                      </div>
                    ))}
                    <div className="report-sub">未消解原因：{d.whyUnresolved}</div>
                  </div>
                ))}
              </div>
            )}

            {interventions.length > 0 && (
              <div className="report-sec">
                <div className="report-sec-title">
                  <MessageSquare size={11} />
                  人类介入（{interventions.length}）
                </div>
                {interventions.map((x, i) => (
                  <div key={i} className="report-sub">
                    · {x}
                  </div>
                ))}
              </div>
            )}

            {duels.length > 0 && (
              <div className="report-sec">
                <div className="report-sec-title">
                  <Swords size={11} />
                  专项对辩（{duels.length}）
                </div>
                {duels.map((d, i) => (
                  <div key={i} className="report-sub">
                    · {d.topic}：{(d.agentIds ?? []).join(' vs ')}（{d.utteranceCount} 条）
                  </div>
                ))}
              </div>
            )}

            {blindSpots.length > 0 && (
              <div className="report-sec">
                <div className="report-sec-title">
                  <AlertCircle size={11} />
                  盲区与风险
                </div>
                {blindSpots.map((b, i) => (
                  <div key={i} className="report-sub">
                    · {b}
                  </div>
                ))}
              </div>
            )}

            <div className="report-foot">
              {meta.rounds} 轮 · ${(meta.totalCostUsd ?? 0).toFixed(4)} ·{' '}
              {meta.finalConsensusScore
                ? `共识度 ${meta.finalConsensusScore.score}`
                : '共识度不可用'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
