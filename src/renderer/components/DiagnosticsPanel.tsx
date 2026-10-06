/**
 * 链路体检面板。
 *
 * UI 只做三件事：按层展示结论、展开证据、把「建议」变成一键动作。
 * 判定逻辑全部在主进程 —— 面板里不重算任何状态，否则 CLI 报告与界面
 * 会出现两套结论，而用户只会相信屏幕上那个。
 */

import { useCallback, useEffect, useState } from 'react'
import type { CheckResult, DiagEvent, DoctorReport } from '../../shared/diagnostics'
import { LAYER_LABEL, LAYER_ORDER, layerRank } from '../../shared/diagnostics'
import { Stethoscope, Play, Download, ChevronDown, ChevronRight, Wrench, FileText } from 'lucide-react'

const STATUS_ICON: Record<CheckResult['status'], string> = { pass: '✓', warn: '!', fail: '✕', skip: '·' }

export function DiagnosticsPanel({ modelIds }: { modelIds: Array<{ id: string; displayName: string; transport: 'webview' | 'api' }> }) {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [events, setEvents] = useState<DiagEvent[]>([])
  const [logFile, setLogFile] = useState<string | null>(null)
  const [scope, setScope] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<Set<string>>(new Set())

  const loadLog = useCallback(async () => {
    const r = await window.torra.doctorLog({ n: 120 })
    setEvents(r.events)
    setLogFile(r.file)
  }, [])

  useEffect(() => {
    void loadLog()
  }, [loadLog])

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const r = await window.torra.runDoctor(scope ? { modelId: scope } : undefined)
      setReport(r)
      await loadLog()
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

      <div className="diag-log">
        <div className="st-sec-head">
          <h4 className="st-sec-title">
            <FileText size={11} />
            流水线日志
          </h4>
          <button className="st-btn" onClick={() => void loadLog()}>
            刷新
          </button>
        </div>
        {logFile && <div className="diag-logfile">{logFile}</div>}
        <div className="diag-loglist">
          {events.length === 0 && <div className="st-empty">暂无记录</div>}
          {events.map((e, i) => (
            <div key={`${e.ts}-${i}`} className={`diag-logrow ${e.ok === false ? 'bad' : ''}`}>
              <span className="diag-logtime">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="diag-logstage">{e.stage}</span>
              <span className="diag-logsubject">{e.subject ?? ''}</span>
              <span className="diag-logdetail" title={e.detail ?? ''}>
                {e.detail ?? ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
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
