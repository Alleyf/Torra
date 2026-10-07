/**
 * 共识度曲线（PRD 9）
 * 黑色主线 + 灰色坐标轴；只有旧存档带着当年的收束分数线时才画那条虚线。
 * 不使用渐变与阴影。
 */
export function ScoreChart({
  scores,
  threshold,
}: {
  scores: Array<{ round: number; score: number }>
  /** 那一场记录的收束分数线；新场次没有（收束已不看分数），传 null 就不画参考线 */
  threshold: number | null
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
      {/* 参考线：只有回放的旧存档才有一条真正生效过的收束线 */}
      {typeof threshold === 'number' && (
        <>
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
        </>
      )}

      {/* 坐标轴 */}
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--border)" strokeWidth="1" />

      {/* 主线：黑色 */}
      <path d={path} fill="none" stroke="var(--text)" strokeWidth="1.5" />

      {/* 数据点一律中性：绿点曾经是「到线」标记，分数线作废后它就是条折线，
          不该在图上宣布成败 —— 一场没打满轮次的探索型讨论不能被曲线判成失败。 */}
      {scores.map((s, i) => (
        <circle key={i} cx={x(i)} cy={y(s.score)} r="2.5" fill="var(--text-3)" />
      ))}
    </svg>
  )
}
