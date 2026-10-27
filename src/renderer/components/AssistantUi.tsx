import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react'
import { parseTorraUi, type TorraUiBlock, type TorraUiLinePoint } from '@shared/ui-protocol'
import { TORRA_UI_FRAME_CSP, torraUiFrameUrl } from '@shared/ui-frame'

type AssistantUiProps = {
  raw: string
  streaming: boolean
  onAction: (prompt: string) => void
}

const SERIES_COLORS = [
  'var(--brand-a)',
  'var(--accent)',
  'var(--consensus)',
  'var(--warn)',
  'var(--danger)',
  'var(--text-3)',
]

const HTML_FRAME_DEFAULT_HEIGHT = 320

const HTML_FRAME_BASE_CSS = `
:root { color-scheme: light dark; }
html, body { min-height: 100%; margin: 0; }
body {
  padding: 12px;
  color: CanvasText;
  background: transparent;
  font: 12px/1.5 ui-sans-serif, system-ui, sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
canvas, svg, img, video { max-width: 100%; }
input, button, select, textarea { font: inherit; }
`

function fmtValue(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString('zh-CN')
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function BlockTitle({ children }: { children?: string }) {
  return children ? <h4 className="aui-block-title">{children}</h4> : null
}

function MetricsBlock({ block }: { block: Extract<TorraUiBlock, { type: 'metrics' }> }) {
  return (
    <section className="aui-block">
      <BlockTitle>{block.title}</BlockTitle>
      <div className="aui-metrics">
        {block.items.map((item, i) => (
          <div key={`${item.label}-${i}`} className="aui-metric">
            <span className="aui-metric-label">{item.label}</span>
            <strong className="aui-metric-value">{item.value}</strong>
            {item.hint && <span className="aui-metric-hint">{item.hint}</span>}
          </div>
        ))}
      </div>
    </section>
  )
}

function BarBlock({ block }: { block: Extract<TorraUiBlock, { type: 'bar' }> }) {
  const max = Math.max(1, ...block.items.map((item) => item.value))
  return (
    <section className="aui-block">
      <BlockTitle>{block.title}</BlockTitle>
      <div className="aui-bars">
        {block.items.map((item, i) => {
          const pct = Math.max(item.value > 0 ? 2 : 0, (item.value / max) * 100)
          return (
            <div key={`${item.label}-${i}`} className="aui-bar-row">
              <span className="aui-bar-label" title={item.label}>
                {item.label}
              </span>
              <span
                className="aui-bar-track"
                role="img"
                aria-label={`${item.label} ${fmtValue(item.value)}${item.detail ? ` ${item.detail}` : ''}`}
              >
                <i className="aui-bar-fill" style={{ width: `${pct}%`, background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              </span>
              <span className="aui-bar-value">
                {fmtValue(item.value)}
                {item.detail && <small>{item.detail}</small>}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function LineBlock({ block }: { block: Extract<TorraUiBlock, { type: 'line' }> }) {
  const points: TorraUiLinePoint[] = block.points
  const w = 340
  const h = 136
  const left = 14
  const right = 14
  const top = 16
  const bottom = 26
  const values = points.map((point) => point.value)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const flat = max === min
  const span = max - min
  const xs = points.map((_, i) => left + (i * (w - left - right)) / Math.max(1, points.length - 1))
  const ys = values.map((value) =>
    flat ? top + (h - top - bottom) / 2 : top + ((max - value) / span) * (h - top - bottom),
  )
  const line = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(' ')
  const area = `${line} L${xs[xs.length - 1]!.toFixed(1)},${h - bottom} L${xs[0]!.toFixed(1)},${h - bottom} Z`
  const labelIndexes = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])

  return (
    <section className="aui-block">
      <BlockTitle>{block.title}</BlockTitle>
      <div className="aui-line-chart">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          role="img"
          aria-label={`${block.title ?? '趋势'}：${points.map((point) => `${point.label} ${fmtValue(point.value)}`).join('，')}`}
        >
          {[0, 0.5, 1].map((part) => {
            const y = top + part * (h - top - bottom)
            return <line key={part} className="aui-line-grid" x1={left} y1={y} x2={w - right} y2={y} />
          })}
          <path className="aui-line-area" d={area} />
          <path className="aui-line-path" d={line} />
          {xs.map((x, i) => (
            <g key={`${points[i]!.label}-${i}`}>
              <circle className="aui-line-dot" cx={x} cy={ys[i]} r={3.2} />
              {labelIndexes.has(i) && (
                <text
                  className="aui-line-label"
                  x={x}
                  y={h - 7}
                  textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
                >
                  {points[i]!.label}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
    </section>
  )
}

function DonutBlock({ block }: { block: Extract<TorraUiBlock, { type: 'donut' }> }) {
  const total = block.items.reduce((sum, item) => sum + item.value, 0)
  const radius = 38
  const circumference = 2 * Math.PI * radius
  let offset = 0

  return (
    <section className="aui-block">
      <BlockTitle>{block.title}</BlockTitle>
      <div className="aui-donut-wrap">
        <div className="aui-donut" role="img" aria-label={block.items.map((item) => `${item.label} ${fmtValue(item.value)}`).join('，')}>
          <svg viewBox="0 0 104 104" aria-hidden="true">
            <circle className="aui-donut-track" cx="52" cy="52" r={radius} />
            {block.items.map((item, i) => {
              const length = total > 0 ? (item.value / total) * circumference : 0
              const dashOffset = -offset
              offset += length
              if (length <= 0) return null
              return (
                <circle
                  key={`${item.label}-${i}`}
                  className="aui-donut-seg"
                  cx="52"
                  cy="52"
                  r={radius}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  strokeDasharray={`${length} ${circumference - length}`}
                  strokeDashoffset={dashOffset}
                  transform="rotate(-90 52 52)"
                />
              )
            })}
          </svg>
          <div className="aui-donut-center">
            <strong>{fmtValue(total)}</strong>
            <span>总计</span>
          </div>
        </div>
        <div className="aui-legend">
          {block.items.map((item, i) => (
            <div key={`${item.label}-${i}`} className="aui-legend-row">
              <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              <span>{item.label}</span>
              <b>{fmtValue(item.value)}</b>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function TableBlock({ block }: { block: Extract<TorraUiBlock, { type: 'table' }> }) {
  return (
    <section className="aui-block">
      <BlockTitle>{block.title}</BlockTitle>
      {block.rows.length ? (
        <div className="aui-table-wrap">
          <table className="aui-table">
            <thead>
              <tr>
                {block.columns.map((column, i) => (
                  <th key={`${column}-${i}`} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="aui-empty">没有可展示的行。</p>
      )}
    </section>
  )
}

function HtmlBlock({ block }: { block: Extract<TorraUiBlock, { type: 'html' }> }) {
  const document = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${TORRA_UI_FRAME_CSP}">
<style>${HTML_FRAME_BASE_CSS}</style>
</head>
<body>${block.html}</body>
</html>`
  const src = torraUiFrameUrl(document)

  return (
    <section className="aui-block">
      <BlockTitle>{block.title}</BlockTitle>
      <iframe
        className="aui-html-frame"
        title={block.title ?? '交互式 HTML 视图'}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="eager"
        src={src}
        style={{ height: block.height ?? HTML_FRAME_DEFAULT_HEIGHT }}
      />
    </section>
  )
}

function UiBlock({ block }: { block: TorraUiBlock }) {
  if (block.type === 'metrics') return <MetricsBlock block={block} />
  if (block.type === 'bar') return <BarBlock block={block} />
  if (block.type === 'line') return <LineBlock block={block} />
  if (block.type === 'donut') return <DonutBlock block={block} />
  if (block.type === 'html') return <HtmlBlock block={block} />
  return <TableBlock block={block} />
}

export function AssistantUi({ raw, streaming, onAction }: AssistantUiProps) {
  const parsed = parseTorraUi(raw)

  if (!parsed.ok) {
    if (streaming) {
      return (
        <div className="aui-shell aui-state aui-generating" role="status" aria-live="polite">
          <Loader2 size={15} className="aui-spin" />
          <span>正在生成交互视图</span>
        </div>
      )
    }
    return (
      <div className="aui-shell aui-state" role="status">
        <AlertTriangle size={15} />
        <div>
          <strong>交互视图暂不可用</strong>
          <span>{parsed.reason}。上面的正文仍可正常阅读。</span>
        </div>
      </div>
    )
  }

  const doc = parsed.value
  return (
    <section className={`aui-shell${streaming ? ' aui-streaming' : ''}`} aria-label={doc.title ?? '交互结果'}>
      <header className="aui-head">
        <div className="aui-kicker">
          <span>Torra View</span>
          {streaming && (
            <span className="aui-pending">
              <Loader2 size={11} className="aui-spin" />
              生成中
            </span>
          )}
        </div>
        {doc.title && <h3 className="aui-title">{doc.title}</h3>}
        {doc.description && <p className="aui-description">{doc.description}</p>}
      </header>

      <div className="aui-blocks">
        {doc.blocks.map((block, i) => (
          <UiBlock key={i} block={block} />
        ))}
      </div>

      {doc.actions && doc.actions.length > 0 && (
        <div className="aui-actions" aria-label="建议下一步">
          {doc.actions.map((action, i) => (
            <button
              key={`${action.label}-${i}`}
              type="button"
              className="aui-action"
              title={action.prompt}
              onClick={() => onAction(action.prompt)}
            >
              {action.label}
              <ArrowRight size={12} />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
