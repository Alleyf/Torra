/**
 * Torra 品牌标记 —— 三段弧围成圆桌，中心一点是共识。
 *
 * 为什么是这个图形：产品的内核不是"一个助手"，而是多个模型同桌讨论并收敛，
 * 所以标记天生就该是「环 + 缺席的缺口 + 中心」。三段而非四段，
 * 是为了在小尺寸下仍能看出旋转感，同时留出呼吸的缺口。
 *
 * 几何与 src/renderer/assets/brand/mark.svg（favicon / 应用图标）同源：
 * 圆心 (12,12)、半径 8、每段 90°、每缺口 30°。两处一旦漂移，
 * 标签页图标和应用内标记就会长成两个牌子，scripts/test-invariants.ts 会拦。
 */

/** 三段弧 + 中心点，24×24 视图盒 */
const ARC_D = [
  'M19.73 14.07A8 8 0 0 1 9.93 19.73',
  'M6.34 17.66A8 8 0 0 1 6.34 6.34',
  'M9.93 4.27A8 8 0 0 1 19.73 9.93',
]

export function BrandMark({
  size = 24,
  mono = false,
  className,
}: {
  size?: number
  /** 单色版：印刷/压印在品牌底上时用，中心点不再另起一色 */
  mono?: boolean
  className?: string
}) {
  return (
    <svg
      className={`brand-mark-svg${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Torra"
    >
      <g fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round">
        {ARC_D.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <circle cx="12" cy="12" r="3" fill={mono ? 'currentColor' : 'var(--brand-b)'} />
    </svg>
  )
}

/** 标题栏与抽屉头用的品牌方块：渐变底 + 反白标记 */
export function BrandTile({ size = 28 }: { size?: number }) {
  return (
    <span className="brand-tile" style={{ width: size, height: size }}>
      <BrandMark size={Math.round(size * 0.64)} mono />
    </span>
  )
}
