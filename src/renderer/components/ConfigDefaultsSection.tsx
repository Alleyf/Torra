/**
 * 讨论参数区：默认值就地可调 + 草稿回到默认。
 *
 * 两层默认：出厂值（@shared/discussion-defaults 的常量）与「我的默认」（这里调出来的，
 * 只存差异，落 preferences.json）。开场页的兜底值与刻度读的是「我的默认」，
 * 所以在这里设过一次，之后每场都从这组数开始，不必每场重拧。
 *
 * 两个按钮不是一回事，别混：
 * - 「恢复默认值」把开场页当前的草稿拉回我的默认 —— 治的是「这场拧乱了」；
 * - 「恢复出厂默认」清掉整张覆盖表 —— 治的是「我设的默认本身不对」。
 *
 * 作用域仍由出厂表的键集合决定：只有「怎么讨论」被恢复，
 * 议题文字、参与名单、模型阵容、历史会话一概不动。
 * 落盘不在这里：组件只接 props，写偏好由 App 走 store 的动作之后做。
 */

import { useEffect, useRef, useState } from 'react'
import {
  CONFIG_DEFAULTS,
  CONFIG_ROWS,
  diffFromDefaults,
  formatConfigValue,
  type DiscussionConfig,
  type DiscussionConfigKey,
} from '../configDefaults'
import { enumValues, numberBound } from '@shared/discussion-defaults'
import { RotateCcw, SlidersHorizontal } from 'lucide-react'

/** 提示留多久：足够读完，又不会挂在页面上假装还在处理 */
const NOTE_MS = 4000

/** 一行能取的值：组件内部用它把 onSetDefault 的 unknown 边界挡在 App 那一层 */
type ConfigValue = DiscussionConfig[DiscussionConfigKey]

/**
 * 数字输入框：敲键盘期间只在本地缓冲，离开输入框（或按回车）才提交。
 *
 * 每敲一个字符就提交的话，「把预算从 2 改成 20」会先写一次 2、再写一次 20 ——
 * 每次写都是一趟 IPC 加一次落盘，中间那次还是用户从没打算要过的默认值。
 * 聚焦期间不用外部值回填，否则半截输入会被自己打回去。
 */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onCommit: (n: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])

  const commit = () => {
    const raw = text.trim()
    const n = Number(raw)
    // 空框和「1e9」这类读不出数的写法都退回现值：Number('') 是 0，会被当成「把预算改成 0」
    if (raw === '' || !Number.isFinite(n)) {
      setText(String(value))
      return
    }
    onCommit(n)
  }

  return (
    <input
      className="st-num"
      type="number"
      aria-label={label}
      value={text}
      min={min}
      max={max}
      step={step}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

export function ConfigDefaultsSection({
  config,
  defaults,
  customized,
  onReset,
  onSetDefault,
  onRestoreFactory,
}: {
  /** 开场页此刻的草稿 */
  config: DiscussionConfig
  /** 生效默认（我的默认）：这里编辑的就是它 */
  defaults: DiscussionConfig
  /** 与出厂值不同的那几项 */
  customized: DiscussionConfigKey[]
  onReset: () => void
  onSetDefault: (key: DiscussionConfigKey, value: unknown) => void
  onRestoreFactory: () => void
}) {
  const [note, setNote] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const say = (text: string) => {
    setNote(text)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setNote(null), NOTE_MS)
  }

  // 草稿与「我的默认」的差异：恢复默认值按钮只对它起作用
  const draftDiff = diffFromDefaults(config, defaults)
  const changed = new Set(draftDiff.map((d) => d.key))
  const isCustom = (key: DiscussionConfigKey) => customized.includes(key)

  const set = (key: DiscussionConfigKey, value: ConfigValue) => {
    const before = defaults[key]
    onSetDefault(key, value)
    if (value !== before) say(`已设为默认 · ${formatConfigValue(key, before)} → ${formatConfigValue(key, value)}`)
  }

  const restoreFactory = () => {
    const n = customized.length
    if (n === 0) return
    onRestoreFactory()
    say(`已恢复出厂默认 ${n} 项 · 议题文字与参与名单没动`)
  }

  const resetDraft = () => {
    const n = draftDiff.length
    if (n === 0) return
    onReset()
    say(`已把 ${n} 项拉回你的默认值 · 议题文字与参与名单没动`)
  }

  return (
    <section className="st-section">
      <div className="st-sec-head">
        <h3 className="st-sec-title">
          <SlidersHorizontal size={13} />
          讨论参数
          <span className={`wm-tally${customized.length === 0 ? ' ok' : ''}`}>
            {customized.length === 0 ? '默认值全部为出厂值' : `${customized.length} 项默认已被你改过`}
          </span>
        </h3>
        <div className="st-sec-actions">
          {note && <span className="st-inline-msg">{note}</span>}
          <button
            className="st-btn"
            onClick={restoreFactory}
            disabled={customized.length === 0}
            title={customized.length === 0 ? '没有自设默认值，当前就是出厂值' : `把 ${customized.length} 项默认值清回出厂值`}
            aria-label="把讨论参数的默认值清回出厂值"
          >
            <RotateCcw size={12} />
            恢复出厂默认
          </button>
          <button
            className="st-btn"
            onClick={resetDraft}
            disabled={draftDiff.length === 0}
            title={draftDiff.length === 0 ? '开场页当前就是默认值，无需恢复' : `把开场页的 ${draftDiff.length} 项拉回你的默认值`}
            aria-label="把开场页的讨论参数恢复为默认值"
          >
            <RotateCcw size={12} />
            恢复默认值
          </button>
        </div>
      </div>
      <p className="st-desc">
        这里调的是<strong>下一场的起点</strong>：改完记在本机，之后每场讨论都从这组数开始，不必在开场页重拧。
        「恢复默认值」只管把开场页此刻的草稿拉回来，「恢复出厂默认」才是清掉你设的默认。
        议题标题、背景材料、参与模型名单、主持指认、历史会话与报告都不在这张表里。
      </p>

      <div className="st-list">
        {CONFIG_ROWS.map((r) => {
          const factory = CONFIG_DEFAULTS[r.key]
          const effective = defaults[r.key]
          const draft = config[r.key]
          const bound = numberBound(r.key)
          const enums = enumValues(r.key)
          return (
            <div key={r.key} className="st-row">
              <div className="st-grow">
                <div className="st-name">
                  {r.name}
                  {isCustom(r.key) && <span className="st-chip">我的默认</span>}
                </div>
                <div className="st-meta">
                  {r.hint}
                  <span className="st-muted">{`出厂 ${formatConfigValue(r.key, factory)}`}</span>
                </div>
              </div>
              <div className="st-actions">
                {bound ? (
                  <>
                    <NumberField
                      label={`${r.name}默认值`}
                      value={effective as number}
                      min={bound.min}
                      max={bound.max}
                      step={bound.step}
                      onCommit={(n) => set(r.key, n)}
                    />
                    <span className="st-unit">
                      {r.key === 'maxRounds' ? '轮' : r.key === 'budgetLimitUsd' ? '美元' : '分钟'}
                    </span>
                  </>
                ) : enums.length > 0 ? (
                  <div className="st-seg" role="group" aria-label={`${r.name}默认值`}>
                    {enums.map((v) => (
                      <button
                        key={v}
                        className={`st-seg-item${effective === v ? ' on' : ''}`}
                        aria-pressed={effective === v}
                        onClick={() => set(r.key, v as ConfigValue)}
                      >
                        {formatConfigValue(r.key, v as ConfigValue)}
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    className={`st-switch${effective ? ' on' : ''}`}
                    role="switch"
                    aria-checked={Boolean(effective)}
                    aria-label={`${r.name}默认值`}
                    onClick={() => set(r.key, !effective)}
                  />
                )}
                <span className={`wm-tally${changed.has(r.key) ? '' : ' ok'}`}>
                  {changed.has(r.key) ? `草稿 ${formatConfigValue(r.key, draft)}` : '草稿未改'}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
