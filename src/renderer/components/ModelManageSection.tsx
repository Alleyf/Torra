/**
 * 模型管理区：侧栏顺序与启停在设置页这一处收口。
 *
 * 此前这两件事只长在侧栏上（拖动 + 卡片上的电源按钮），设置页能加模型、能配密钥、
 * 能恢复被隐藏的模型，却唯独调不了顺序、停不了用 —— 而「谁是第一个发言的」「不想再看到哪个」
 * 是配置，不是浏览动作。拖动依赖鼠标且只能一次挪一格距离，这里给同一件事一个可点、
 * 可键盘操作、能看清全序的出口。
 *
 * 顺序口径不自己实现：与侧栏拖动共用 modelOrder 的纯函数，两处算不出两种结果。
 * 落盘仍走 App 里已有的 handleReorder / handleToggleEnabled，本组件不直接碰 IPC。
 */

import { useCallback, useState } from 'react'
import type { ModelSummary } from '../store'
import { moveStep } from '../modelOrder'
import { ArrowDown, ArrowUp, ArrowUpDown, Power } from 'lucide-react'

export function ModelManageSection({
  models,
  onReorder,
  onToggleEnabled,
}: {
  models: ModelSummary[]
  onReorder: (orderedIds: string[]) => Promise<void> | void
  onToggleEnabled: (id: string, enabled: boolean) => Promise<void> | void
}) {
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  // 一行的动作要串行：连点两次会用同一份旧顺序算出两个新顺序，后者把前者覆盖掉。
  const run = useCallback(async (id: string, fn: () => Promise<void> | void) => {
    if (busy[id]) return
    setBusy((p) => ({ ...p, [id]: true }))
    try {
      await fn()
    } finally {
      setBusy((p) => ({ ...p, [id]: false }))
    }
  }, [busy])

  const ids = models.map((m) => m.id)
  const enabledCount = models.filter((m) => m.enabled).length

  return (
    <section className="st-section">
      <div className="st-sec-head">
        <h3 className="st-sec-title">
          <ArrowUpDown size={13} />
          顺序与启停
          <span className={`wm-tally${enabledCount === models.length && models.length > 0 ? ' ok' : ''}`}>
            {models.length === 0 ? '暂无' : `${enabledCount}/${models.length} 启用`}
          </span>
        </h3>
      </div>
      <p className="st-desc">
        这里的顺序就是侧栏从上到下的顺序，上下键逐个挪，不用拖动。停用只是让模型退出可选名单，登录态、密钥与历史发言都保留，随时可以再启用。
      </p>

      {models.length === 0 ? (
        <div className="st-empty">暂无模型</div>
      ) : (
        <div className="st-list">
          {models.map((m, i) => (
            <div key={m.id} className="st-row">
              <div className="st-avatar" style={{ background: m.color }}>
                {m.displayName.slice(0, 1)}
              </div>
              <div className="st-grow">
                <div className="st-name">{m.displayName}</div>
                <div className="st-meta">
                  {`第 ${i + 1} 位 · ${m.transport === 'api' ? 'API' : '网页'}`}
                  {!m.enabled && <span className="wm-tally">已停用</span>}
                  {busy[m.id] && <span className="wm-tally">处理中…</span>}
                </div>
              </div>
              <div className="st-actions">
                <button
                  className="st-icon"
                  title="上移一位"
                  aria-label={`把「${m.displayName}」上移`}
                  disabled={i === 0 || !!busy[m.id]}
                  onClick={() => void run(m.id, () => onReorder(moveStep(ids, m.id, -1)))}
                >
                  <ArrowUp size={11} />
                </button>
                <button
                  className="st-icon"
                  title="下移一位"
                  aria-label={`把「${m.displayName}」下移`}
                  disabled={i === ids.length - 1 || !!busy[m.id]}
                  onClick={() => void run(m.id, () => onReorder(moveStep(ids, m.id, 1)))}
                >
                  <ArrowDown size={11} />
                </button>
                <button
                  className="st-icon"
                  title={m.enabled ? '停用这个模型' : '启用这个模型'}
                  aria-label={m.enabled ? `停用「${m.displayName}」` : `启用「${m.displayName}」`}
                  disabled={!!busy[m.id]}
                  onClick={() => void run(m.id, () => onToggleEnabled(m.id, !m.enabled))}
                >
                  <Power size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
