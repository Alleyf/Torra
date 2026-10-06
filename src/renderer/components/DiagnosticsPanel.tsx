/**
 * 链路体检 + 流水线日志。
 *
 * UI 只做三件事：按层展示结论、展开证据、把「建议」变成一键动作；
 * 外加把日志按条件摊开来读。判定逻辑全部在主进程 —— 面板里不重算任何状态，
 * 否则 CLI 报告与界面会出现两套结论，而用户只会相信屏幕上那个。
 */

import { useCallback, useEffect, useState } from 'react'
import type { CheckResult, DiagEvent, DoctorReport, LogFileInfo } from '../../shared/diagnostics'
import { LAYER_LABEL, LAYER_ORDER, layerRank, type DiagLayer } from '../../shared/diagnostics'
import {
  Stethoscope,
  Play,
  Download,
  ChevronDown,
  ChevronRight,
  Wrench,
  FileText,
  FolderOpen,
  Copy,
  Trash2,
  RefreshCw,
} from 'lucide-react'

const STATUS_ICON: Record<CheckResult['status'], string> = { pass: '✓', warn: '!', fail: '✕', skip: '·' }

export function DiagnosticsPanel({ modelIds }: { modelIds: Array<{ id: string; displayName: string; transport: 'webview' | 'api' }> }) {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [scope, setScope] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<Set<string>>(new Set())

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const r = await window.torra.runDoctor(scope ? { modelId: scope } : undefined)
      setReport(r)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const toggle = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  const apply = async (c: CheckResult) => {
    if (!c.apply) return
    const r = await window.torra.patchAdapterSelector(c.apply)
    if (r.ok) {
      setApplied((prev) => new Set(prev).add(c.id))
      await run()
    } else {
      setError(r.reason ?? '套用失败')
    }
  }

  const exportReport = async () => {
    if (!report) return
    const r = await window.torra.exportDoctorReport(report)
    setError(r.ok ? null : '导出失败')
  }

  const grouped = groupByLayer(report?.checks ?? [])

  return (
    <section className="st-section">
      <div className="st-sec-head">
        <h3 className="st-sec-title">
          <Stethoscope size={13} />
          链路体检
        </h3>
        <select className="st-input st-fit" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="体检范围">
          <option value="">全部模型</option>
          {modelIds.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
              {m.transport === 'api' ? '（API）' : ''}
            </option>
          ))}
        </select>
        <button className="st-btn" onClick={() => void run()} disabled={running}>
          <Play size={11} />
          {running ? '体检中…' : '开始体检'}
        </button>
        <button
          className="st-icon"
          onClick={() => void exportReport()}
          disabled={!report}
          aria-label="导出体检报告"
          title="导出体检报告"
        >
          <Download size={11} />
        </button>
      </div>
      <p className="st-desc">
        沿「运行环境 → 适配器 → API 接入 → 登录 → 通道 → 选择器 → 主持角色 → 结果产出」逐层检查并归因。
        全程只读：不发送任何消息；API 侧只发一次免费的模型清单请求（不计费、不产生对话）。
      </p>

      {error && <div className="diag-error">{error}</div>}

      {report && (
        <div className="diag-summary">
          <span className="diag-pill ok">通过 {report.summary.pass}</span>
          <span className="diag-pill warn">提醒 {report.summary.warn}</span>
          <span className="diag-pill fail">失败 {report.summary.fail}</span>
          {report.blockingLayer && (
            <span className="diag-block">最先阻断：{LAYER_LABEL[report.blockingLayer]}</span>
          )}
        </div>
      )}

      {report &&
        grouped.map(([layer, checks]) => (
          <div key={layer} className="diag-layer">
            <div className="diag-layer-title">
              {LAYER_LABEL[layer]}
              <span className="diag-layer-count">{checks.length}</span>
            </div>
            {checks.map((c) => (
              <CheckRow
                key={c.id}
                c={c}
                open={expanded.has(c.id)}
                onToggle={() => toggle(c.id)}
                onApply={() => void apply(c)}
                applied={applied.has(c.id)}
              />
            ))}
          </div>
        ))}

      <LogConsole modelIds={modelIds} />
    </section>
  )
}

/**
 * 流水线日志台。
 *
 * 两个视图不是一个功能的重复印证：「本次运行」读主进程内存 ring（只覆盖本次启动、
 * 上限 1000 条，一场讨论就占掉几十条），「按天文件」读盘上的 jsonl —— 查昨天那一场
 * 只有后者能给答案。所以视图必须切、截断必须说：只扫了末尾 4MB 就谎称「没有记录」，
 * 会把人引向「日志丢了」的错误结论。
 */
function LogConsole({ modelIds }: { modelIds: Array<{ id: string; displayName: string; transport: 'webview' | 'api' }> }) {
  const [source, setSource] = useState<'live' | 'day'>('live')
  const [day, setDay] = useState('')
  const [files, setFiles] = useState<LogFileInfo[]>([])
  const [dir, setDir] = useState<string | null>(null)
  const [keepDays, setKeepDays] = useState(14)
  const [events, setEvents] = useState<DiagEvent[]>([])
  const [scanned, setScanned] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [layer, setLayer] = useState<DiagLayer | ''>('')
  const [subject, setSubject] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [text, setText] = useState('')
  const [failedOnly, setFailedOnly] = useState(false)
  const [auto, setAuto] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [openRow, setOpenRow] = useState<string | null>(null)

  const loadFiles = useCallback(async () => {
    const r = await window.torra.listLogFiles()
    setFiles(r.files)
    setDir(r.dir)
    setKeepDays(r.keepDays)
    setDay((prev) => (prev && r.files.some((f) => f.day === prev) ? prev : (r.files[0]?.day ?? '')))
  }, [])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const f = {
        layer: layer || undefined,
        subject: subject || undefined,
        sessionId: sessionId || undefined,
        text: text || undefined,
        failedOnly: failedOnly || undefined,
        n: 500,
      }
      const r =
        source === 'live'
          ? { ...(await window.torra.doctorLog(f)), scanned: f.n, truncated: false }
          : await window.torra.readLogFile(day, f)
      setEvents(r.events)
      setScanned(r.scanned)
      setTruncated(r.truncated)
    } finally {
      setBusy(false)
    }
  }, [source, day, layer, subject, sessionId, text, failedOnly])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, day, layer, subject, sessionId, text, failedOnly])

  /** 「跟着滚」只能是轮询：日志没有推送通道，主进程那边是纯追加写盘 */
  useEffect(() => {
    if (!auto || source !== 'live') return
    const t = setInterval(() => void load(), 2000)
    return () => clearInterval(t)
  }, [auto, source, load])

  const totalBytes = files.reduce((a, f) => a + f.bytes, 0)

  const openFolder = async () => {
    const r = await window.torra.openLogFolder()
    setNote(r.ok ? null : (r.reason ?? '打开日志目录失败'))
  }

  const copyPath = async () => {
    const p = source === 'live' ? dir : dir && day ? `${dir}\\pipeline-${day}.jsonl` : dir
    if (!p) return setNote('日志目录不可用，本次运行只有内存日志')
    try {
      await navigator.clipboard.writeText(p)
      setNote('路径已复制')
    } catch {
      setNote('复制失败，路径见上方')
    }
  }

  const prune = async () => {
    const r = await window.torra.pruneLogs()
    await loadFiles()
    setNote(r.removed.length ? `已清理 ${r.removed.length} 个过期文件` : `${keepDays} 天以内没有可清理的文件`)
  }

  return (
    <div className="lg-root">
      <div className="st-sec-head">
        <h4 className="st-sec-title">
          <FileText size={11} />
          流水线日志
        </h4>
        <div className="lg-seg" role="group" aria-label="日志来源">
          <button className={`lg-seg-btn${source === 'live' ? ' on' : ''}`} onClick={() => setSource('live')}>
            本次运行
          </button>
          <button className={`lg-seg-btn${source === 'day' ? ' on' : ''}`} onClick={() => setSource('day')}>
            按天文件
          </button>
        </div>
        {source === 'day' && (
          <select className="st-input st-fit" value={day} onChange={(e) => setDay(e.target.value)} aria-label="选择日志日期">
            {files.length === 0 && <option value="">没有日志文件</option>}
            {files.map((f) => (
              <option key={f.day} value={f.day}>
                {f.day} · {(f.bytes / 1024).toFixed(0)} KB
              </option>
            ))}
          </select>
        )}
        <label className="lg-check">
          <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />
          仅失败
        </label>
        {source === 'live' && (
          <label className="lg-check" title="日志没有推送通道，这里是 2 秒轮询">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            跟着滚
          </label>
        )}
        <button className="st-btn" onClick={() => void load()} disabled={busy}>
          <RefreshCw size={11} className={busy ? 'spin' : ''} />
          {busy ? '读取中…' : '刷新'}
        </button>
      </div>

      <div className="lg-filters">
        <select className="st-input st-fit" value={layer} onChange={(e) => setLayer(e.target.value as DiagLayer | '')} aria-label="按层筛选">
          <option value="">全部层</option>
          {LAYER_ORDER.map((l) => (
            <option key={l} value={l}>
              {LAYER_LABEL[l]}
            </option>
          ))}
        </select>
        <select className="st-input st-fit" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="按模型筛选">
          <option value="">全部模型</option>
          {modelIds.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
        <input
          className="st-input lg-session"
          placeholder="会话 id（如 topic_1791…）"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          aria-label="按会话筛选"
        />
        <input
          className="st-input lg-search"
          placeholder="关键词：阶段 / 模型 / 详情"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="关键词"
        />
        <span className="lg-count">
          {events.length} 条{truncated ? '（已到上限）' : ''}
          {source === 'day' ? ` · 扫过 ${scanned} 行` : ' · 内存 ring 上限 1000'}
        </span>
      </div>

      <div className="lg-meta">
        <code className="lg-path" title={dir ?? ''}>
          {dir ?? '日志目录不可用（本次运行只有内存日志）'}
        </code>
        <button className="st-icon" onClick={() => void openFolder()} aria-label="打开日志目录" title="打开日志目录">
          <FolderOpen size={11} />
        </button>
        <button className="st-icon" onClick={() => void copyPath()} aria-label="复制日志路径" title="复制路径">
          <Copy size={11} />
        </button>
        <span className="lg-retire">
          保留 {keepDays} 天 · {files.length} 个文件 · {(totalBytes / 1024).toFixed(0)} KB
        </span>
        <button className="st-btn" onClick={() => void prune()} title={`删除早于 ${keepDays} 天的日志文件，当天文件不动`}>
          <Trash2 size={11} />
          清理过期
        </button>
      </div>
      {note && <div className="lg-note">{note}</div>}

      <div className="lg-table">
        <div className="lg-tr lg-th">
          <span>时间</span>
          <span>层</span>
          <span>阶段</span>
          <span>主体</span>
          <span>会话</span>
          <span>耗时</span>
          <span>结论</span>
          <span>详情</span>
        </div>
        {events.length === 0 && <div className="st-empty">没有符合条件的记录</div>}
        {events.map((e, i) => {
          const key = `${e.ts}-${i}`
          const open = openRow === key
          return (
            <div key={key} className={`lg-tr lg-row${e.ok === false ? ' bad' : ''}${open ? ' open' : ''}`} onClick={() => setOpenRow(open ? null : key)}>
              <span className="lg-time">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="lg-layer">{LAYER_LABEL[e.layer] ?? e.layer}</span>
              <span className="lg-stage">{e.stage}</span>
              <span className="lg-subject" title={e.subject}>
                {e.subject ?? ''}
              </span>
              <span className="lg-session-c" title={e.sessionId}>
                {e.sessionId ? e.sessionId.slice(-6) : ''}
              </span>
              <span className="lg-ms">{e.ms != null ? `${e.ms}ms` : ''}</span>
              <span className={`lg-ok ${e.ok === false ? 'bad' : e.ok === true ? 'good' : ''}`}>
                {e.ok === false ? '✕' : e.ok === true ? '✓' : '·'}
              </span>
              <span className="lg-detail">{open ? e.detail ?? '—' : e.detail ?? ''}</span>
            </div>
          )
        })}
      </div>
      <p className="lg-foot">
        点任意一行看完整详情。日志只记录观测事实（cookie 只记名称与域名），但失败条目会带上发言片段，属于本机文件、不外传。
      </p>
    </div>
  )
}

/**
 * 单条体检结论。设置页的「API 模型检查」复用它：同一套状态色、同一段
 * 「证据 + 修复」的排版，免得两处对同一个 fail 给出两种观感。
 * onApply/applied 只有体检面板用得上（选择器建议的一键套用），别处可不传。
 */
export function CheckRow({
  c,
  open,
  onToggle,
  onApply,
  applied = false,
}: {
  c: CheckResult
  open: boolean
  onToggle: () => void
  onApply?: () => void
  applied?: boolean
}) {
  return (
    <div className={`diag-check ${c.status}`}>
      <div className="diag-check-head" onClick={onToggle}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className={`diag-status ${c.status}`}>{STATUS_ICON[c.status]}</span>
        <span className="diag-check-title">{c.title}</span>
        {c.apply && c.suggestion && !applied && onApply && (
          <button
            className="st-btn"
            onClick={(e) => {
              e.stopPropagation()
              onApply()
            }}
            title="写入用户适配器目录，即刻生效且可撤销"
          >
            <Wrench size={10} />
            套用建议
          </button>
        )}
        {applied && <span className="diag-applied">已套用</span>}
      </div>
      {open && (
        <div className="diag-check-body">
          {c.evidence.map((e, i) => (
            <div key={i} className="diag-evidence">
              {e}
            </div>
          ))}
          {c.fix && <div className="diag-fix">修复：{c.fix}</div>}
          {c.suggestion && <div className="diag-suggestion">建议选择器：<code>{c.suggestion}</code></div>}
        </div>
      )}
    </div>
  )
}

function groupByLayer(checks: CheckResult[]): Array<[CheckResult['layer'], CheckResult[]]> {
  // 层顺序只在 src/shared/diagnostics.ts 定义一次。这里曾经抄过一份常量，
  // 新增 api 层时那份副本就把 API 结论塞进了「运行期」分组。
  const out: Array<[CheckResult['layer'], CheckResult[]]> = []
  for (const layer of LAYER_ORDER) {
    const items = checks.filter((c) => c.layer === layer)
    if (items.length > 0) out.push([layer, items])
  }
  const known = new Set<string>(LAYER_ORDER)
  const extra = checks.filter((c) => !known.has(c.layer))
  if (extra.length > 0) out.push(['runtime', extra])
  return out.sort((a, b) => layerRank(a[0]) - layerRank(b[0]))
}
