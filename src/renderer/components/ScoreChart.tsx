/**
 * 共识度曲线（PRD 9）
 * 黑色主线 + 越过收敛阈值的点标绿，其余留灰。
 * 不使用渐变与阴影。
 */
export function ScoreChart({
  scores,
  threshold,
}: {
  scores: Array<{ round: number; score: number }>
  threshold: number
}) {
  const W = 196
  const H = 64
  const PAD = 4

  if (scores.length === 0) {
    return (
      <svg className="score-chart" viewBox={`0 0 ${W} ${H}`}>
        <line
          x1={PAD}
          y1={H - PAD}
          x2={W - PAD}
          y2={H - PAD}
          stroke="var(--border)"
          strokeWidth="1"
        />
        <text x={W / 2} y={H / 2} textAnchor="middle" fill="var(--text-3)" fontSize="10">
          尚无评分
        </text>
      </svg>
    )
  }

  const x = (i: number) =>
    scores.length === 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (scores.length - 1)
  const y = (v: number) => H - PAD - (v / 100) * (H - PAD * 2)

  const path = scores.map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(s.score)}`).join(' ')

  return (
    <svg className="score-chart" viewBox={`0 0 ${W} ${H}`}>
      {/* 阈值参考线 */}
      <line
        x1={PAD}
        y1={y(threshold)}
        x2={W - PAD}
        y2={y(threshold)}
        stroke="var(--border)"
        strokeWidth="1"
        strokeDasharray="3 3"
      />
      <text x={W - PAD} y={y(threshold) - 2} textAnchor="end" fill="var(--text-3)" fontSize="8">
        {threshold}
      </text>

      {/* 坐标轴 */}
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--border)" strokeWidth="1" />

      {/* 主线：黑色 */}
      <path d={path} fill="none" stroke="var(--text)" strokeWidth="1.5" />

      {/* 数据点：过阈值的绿点只是「到线」标记；未过阈值的点保持中性，
          不涂红 —— 红是留给真实分歧的色，一场没打满轮次的探索型讨论不该被曲线判成失败。 */}
      {scores.map((s, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(s.score)}
          r="2.5"
          fill={s.score >= threshold ? 'var(--consensus)' : 'var(--text-3)'}
        />
      ))}
    </svg>
  )
}
