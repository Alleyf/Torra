/**
 * 讨论参数区：默认值一览 + 一键回到默认。
 *
 * 这些参数都在开场页调（轮次、阈值、预算、三个治理开关），但那里只有「往哪个方向拧」，
 * 没有「回到原位」—— 拧坏了只能靠记忆逐项拧回去，或者重启应用赌它不落盘。
 * 这里给同一批参数一个看得到默认值、也能一次退回的出口。
 *
 * 作用域由 configDefaults 的白名单决定：只有「怎么讨论」被恢复，
 * 议题文字、参与名单、模型阵容、历史会话一概不动。
 * 落盘不在这个组件里：它只接 props，状态由 App 用 store 的 resetDiscussionConfig 兜。
 */

import { useEffect, useRef, useState } from 'react'
import { CONFIG_DEFAULTS, CONFIG_ROWS, diffFromDefaults, formatConfigValue, type DiscussionConfig } from '../configDefaults'
import { RotateCcw, SlidersHorizontal } from 'lucide-react'

/** 恢复之后把提示留多久：足够读完，又不会挂在页面上假装还在处理 */
const NOTE_MS = 4000

export function ConfigDefaultsSection({
  config,
  onReset,
}: {
  config: DiscussionConfig
  onReset: () => void
}) {
  const [note, setNote] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const diff = diffFromDefaults(config)
  const changed = new Set(diff.map((d) => d.key))

  const handleReset = () => {
    const n = diff.length
    if (n === 0) return
    onReset()
    setNote(`已恢复 ${n} 项默认值 · 议题文字与参与名单没动`)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setNote(null), NOTE_MS)
  }

  return (
    <section className="st-section">
      <div className="st-sec-head">
        <h3 className="st-sec-title">
          <SlidersHorizontal size={13} />
          讨论参数
          <span className={`wm-tally${diff.length === 0 ? ' ok' : ''}`}>
            {diff.length === 0 ? '全部为默认值' : `${diff.length} 项与默认不同`}
          </span>
        </h3>
        <div className="st-sec-actions">
          {note && <span className="st-inline-msg">{note}</span>}
          <button
            className="st-btn"
            onClick={handleReset}
            disabled={diff.length === 0}
            title={diff.length === 0 ? '当前已经全是默认值' : `把 ${diff.length} 项改回默认值`}
            aria-label="把讨论参数恢复为默认值"
          >
            <RotateCcw size={12} />
            恢复默认值
          </button>
        </div>
      </div>
      <p className="st-desc">
        这些参数在「新建讨论」页里逐个拧，这里能看到每一项的默认值，改乱了可以一次退回。恢复只影响讨论怎么开：议题标题、背景材料、参与模型名单、主持指认、历史会话与报告都不在范围内。
      </p>

      <div className="st-list">
        {CONFIG_ROWS.map((r) => {
          const current = formatConfigValue(r.key, config[r.key])
          const def = formatConfigValue(r.key, CONFIG_DEFAULTS[r.key])
          return (
            <div key={r.key} className="st-row">
              <div className="st-grow">
                <div className="st-name">{r.name}</div>
                <div className="st-meta">{r.hint}</div>
              </div>
              <div className="st-actions">
                <span className="wm-tally">默认 {def}</span>
                <span className={`wm-tally${changed.has(r.key) ? '' : ' ok'}`}>
                  {changed.has(r.key) ? `当前 ${current}` : '未改'}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
