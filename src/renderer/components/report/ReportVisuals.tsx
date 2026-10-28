import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { ReportClaimCounts } from '@shared/report-model'
import { clip, stripReportNoise } from '@shared/report-text'
import { MarkdownInline } from '../Markdown'

/**
 * 报告用的小型可视化组件。
 *
 * 全部用手写 SVG / DOM 完成：报告需要离线导出成 HTML 和长图，
 * 引入图表库会把运行动态和样式一起带出去，导出之后反而容易失真。
 */

const TONE_VAR = {
  ok: 'var(--ok, #4fb477)',
  warn: 'var(--warn, #d8a13a)',
  bad: 'var(--bad, #d9625c)',
}

export function CoverageRing({
  value,
  label = '证据覆盖',
  size = 86,
}: {
  value: number
  label?: string
  size?: number
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  const stroke = 7
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <div className="rw-ring" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${pct}%`}>
        <circle cx={size / 2} cy={size / 2} r={r} className="rw-ring-track" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="rw-ring-fill"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="rw-ring-text">
        <b>{pct}%</b>
        <span>{label}</span>
      </div>
    </div>
  )
}

/** 结论状态堆叠条：一眼看出“能用的 / 要打折的 / 不能用的”各占多少。 */
export function StatusStack({ counts }: { counts: ReportClaimCounts }) {
  const total = Math.max(1, counts.total)
  const segs = [
    { key: 'confirmed', n: counts.confirmed, tone: 'ok' as const },
    { key: 'qualified', n: counts.qualified, tone: 'warn' as const },
    { key: 'contested', n: counts.contested, tone: 'bad' as const },
    { key: 'unsupported', n: counts.unsupported, tone: 'bad' as const },
  ].filter((s) => s.n > 0)
  if (segs.length === 0) return null
  return (
    <div className="rw-stack" role="img" aria-label={segs.map((s) => `${s.key} ${s.n}`).join('，')}>
      {segs.map((s) => (
        <i
          key={s.key}
          className={`rw-stack-seg tone-${s.tone}`}
          style={{ width: `${(s.n / total) * 100}%` }}
          title={`${s.key} ${s.n}`}
        />
      ))}
    </div>
  )
}

/** 单一结论的强度：支持面、证据硬度、模型置信度。 */
export function StrengthMeter({
  support,
  hardness,
  confidence,
}: {
  support: number
  hardness: number | null
  confidence: number
}) {
  const rows = [
    { k: '支持', v: Math.max(0, Math.min(100, support)), tone: 'ok' },
    {
      k: '硬度',
      v: hardness === null ? null : Math.round(hardness * 100),
      tone: 'warn',
    },
    { k: '置信', v: Math.round(confidence * 100), tone: 'ok' },
  ]
  return (
    <div className="rw-strength">
      {rows.map((row) => (
        <div key={row.k} className="rw-strength-row">
          <span>{row.k}</span>
          <i className="rw-strength-track">
            {row.v !== null && (
              <b className={`tone-${row.v >= 60 ? row.tone : 'bad'}`} style={{ width: `${row.v}%` }} />
            )}
          </i>
          <em>{row.v === null ? '未记录' : `${row.v}%`}</em>
        </div>
      ))}
    </div>
  )
}

/** 轮次趋势：累计共识数量折线，让“越谈越清楚还是越谈越散”看得见。 */
export function TrendLine({ points }: { points: Array<{ round: number; value: number; label?: string }> }) {
  if (points.length < 2) return null
  const w = 260
  const h = 64
  const pad = 8
  const max = Math.max(1, ...points.map((p) => p.value))
  const xs = points.map((_, i) => pad + (i * (w - pad * 2)) / Math.max(1, points.length - 1))
  const ys = points.map((p) => h - pad - (p.value / max) * (h - pad * 2))
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(' ')
  return (
    <svg className="rw-trend" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="累计共识趋势">
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} className="rw-trend-axis" />
      <path d={path} className="rw-trend-line" />
      {xs.map((x, i) => (
        <g key={points[i]!.round}>
          <circle cx={x} cy={ys[i]!} r={3} className="rw-trend-dot" />
          <text x={x} y={h - 1} className="rw-trend-label" textAnchor="middle">
            R{points[i]!.round}
          </text>
        </g>
      ))}
    </svg>
  )
}

/**
 * 长文本折叠。超过阈值才出现“展开全文”，避免短句也挂一个按钮。
 * 展开后正文用 MarkdownInline 渲染，加粗和行内代码不会被抹平。
 */
export function FoldText({
  text,
  lines = 2,
  threshold = 56,
  className = '',
}: {
  text: string
  lines?: number
  threshold?: number
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const body = stripReportNoise(text)
  const long = body.length > threshold
  return (
    <div
      className={`rw-fold${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
      style={{ ['--rw-lines' as string]: String(lines) }}
    >
      <MarkdownInline text={text} />
      {long && (
        <button className="rw-fold-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? (
            <>
              收起 <ChevronUp size={11} />
            </>
          ) : (
            <>
              展开全文 <ChevronDown size={11} />
            </>
          )}
        </button>
      )}
    </div>
  )
}

/** 给长文本做一个“首句 + 折叠”的组合，标题下面的副标题常用。 */
export function GistLine({ text, max = 96 }: { text: string; max?: number }) {
  const short = clip(stripReportNoise(text), max)
  if (!short) return null
  return <p className="rw-gist">{short}</p>
}

export { TONE_VAR }
