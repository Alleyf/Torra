import { useState } from 'react'
import { useStore, type ModelSummary } from '../store'
import { MessageSquare, Target, Swords, RefreshCw, Pause, Play, Send, CheckCircle } from 'lucide-react'

const STANCE_OPTIONS = [
  { key: 'support', label: '支持方', desc: '论证议题成立' },
  { key: 'oppose', label: '反对方', desc: '主动寻找论证不成立的理由' },
  { key: 'risk', label: '风险审阅者', desc: '专门寻找失败条件与边界情况' },
  { key: 'pragmatic', label: '务实执行者', desc: '只关心落地成本与可操作性' },
  { key: 'neutral', label: '中立分析者', desc: '不站队，只做证据梳理与归因' },
]

const MODE_ICONS = {
  interject: <MessageSquare size={12} />,
  followup: <Target size={12} />,
  duel: <Swords size={12} />,
  stance: <RefreshCw size={12} />,
}

export function InterventionBar({
  models,
  disabled,
  onPaused,
}: {
  models: ModelSummary[]
  disabled: boolean
  onPaused: (paused: boolean) => void
}) {
  const s = useStore()
  const [text, setText] = useState('')
  const [target, setTarget] = useState('')
  const [mode, setMode] = useState<'interject' | 'followup' | 'duel' | 'stance'>('interject')
  const [duelB, setDuelB] = useState('')
  const [stance, setStance] = useState('risk')
  const [note, setNote] = useState<string | null>(null)

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const pending = s.pendingFollowup

  const flash = (m: string) => {
    setNote(m)
    setTimeout(() => setNote(null), 2600)
  }

  const submit = async () => {
    const t = text.trim()
    if (!t) return

    if (mode === 'interject') {
      await window.torra.interject(t, target || undefined)
      flash(target ? `已插入，下一批次投递给 ${nameOf(target)}` : '已插入，下一批次对全员生效')
    } else if (mode === 'followup') {
      if (!target) {
        flash('请先选择要追问的模型')
        return
      }
      await window.torra.followup(target, t, pending?.utteranceId)
      flash(`已要求 ${nameOf(target)} 针对性回应，将作为下一批次首个发言`)
    } else if (mode === 'duel') {
      const other = s.participantIds.find((id) => id !== target && id !== duelB)
      const b = duelB || other
      if (!target || !b) {
        flash('请选择两个对辩模型')
        return
      }
      const r = await window.torra.requestDuel([target, b], t)
      flash(r.ok ? `已安排 ${nameOf(target)} vs ${nameOf(b)} 就该议题对辩` : (r.reason ?? '对辩请求失败'))
    } else {
      if (!target) {
        flash('请先选择要调整立场的模型')
        return
      }
      const label = STANCE_OPTIONS.find((x) => x.key === stance)?.label ?? stance
      await window.torra.setStance(target, label)
      flash(`${nameOf(target)} 立场已改为「${label}」，下一轮生效`)
    }
    setText('')
    s.setPendingFollowup(null)
  }

  const doPause = async () => {
    if (s.paused) {
      await window.torra.resumeSession()
      onPaused(false)
      flash('已继续')
    } else {
      await window.torra.pauseSession('用户手动暂停')
      onPaused(true)
      flash('已暂停，当前批次结束后生效')
    }
  }

  return (
    <div className="interject-bar">
      <div className="iv-tabs">
        {([
          ['interject', '插话'],
          ['followup', '追问'],
          ['duel', '对辩'],
          ['stance', '调立场'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            className={`iv-tab${mode === k ? ' active' : ''}`}
            onClick={() => setMode(k)}
            disabled={disabled}
            title={
              k === 'interject'
                ? '内容进入下一批次所有（或指定）模型的上下文'
                : k === 'followup'
                  ? '指定模型就某条发言再答一轮'
                  : k === 'duel'
                    ? '两个模型就某议题点追加专项轮次，突破轮次上限'
                    : '中途改某模型立场，下一轮生效'
            }
          >
            {MODE_ICONS[k]}
            {label}
          </button>
        ))}
      </div>

      <select
        className="iv-select"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        disabled={disabled}
      >
        <option value="">{mode === 'duel' ? '选择对辩方 A' : mode === 'interject' ? '对全员' : '选择模型'}</option>
        {s.participantIds.map((id) => (
          <option key={id} value={id}>
            @{models.find((m) => m.id === id)?.displayName ?? id}
            {s.stanceOverrides[id] ? `（已调：${s.stanceOverrides[id]}）` : ''}
          </option>
        ))}
      </select>

      {mode === 'duel' && (
        <select
          className="iv-select"
          value={duelB}
          onChange={(e) => setDuelB(e.target.value)}
          disabled={disabled}
        >
          <option value="">选择对辩方 B</option>
          {s.participantIds
            .filter((id) => id !== target)
            .map((id) => (
              <option key={id} value={id}>
                @{models.find((m) => m.id === id)?.displayName ?? id}
              </option>
            ))}
        </select>
      )}

      {mode === 'stance' && (
        <select
          className="iv-select"
          value={stance}
          onChange={(e) => setStance(e.target.value)}
          disabled={disabled}
        >
          {STANCE_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label} — {o.desc}
            </option>
          ))}
        </select>
      )}

      <textarea
        value={text}
        disabled={disabled}
        placeholder={
          disabled
            ? '讨论未在进行中'
            : mode === 'interject'
              ? '插话内容将作为「人类参与者」进入下一批次模型的分析依据'
              : mode === 'followup'
                ? pending
                  ? `针对 ${nameOf(pending.agentId)} 的这条发言提问…`
                  : '指定一个模型，要求它针对某个观点再答一轮'
                : mode === 'duel'
                  ? '对辩议题：两个模型将就该议题直接交锋，不得重复此前论点'
                  : '说明要调整的立场方向，将覆盖默认角色设定'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) void submit()
        }}
      />

      <button className="btn primary" disabled={disabled || !text.trim()} onClick={submit}>
        <Send size={12} />
        {mode === 'interject' ? '插话' : mode === 'followup' ? '追问' : mode === 'duel' ? '对辩' : '应用'}
      </button>
      <button
        className={`btn${s.paused ? ' danger' : ''}`}
        onClick={() => void doPause()}
        disabled={disabled && !s.paused}
        title={s.paused ? '继续讨论' : '暂停讨论，当前批次结束后生效'}
      >
        {s.paused ? <Play size={12} /> : <Pause size={12} />}
        {s.paused ? '继续' : '暂停'}
      </button>

      {note && (
        <span className="iv-note">
          <CheckCircle size={11} />
          {note}
        </span>
      )}
    </div>
  )
}

export function InterventionTicker({ models }: { models: ModelSummary[] }) {
  const interventions = useStore((s) => s.interventions)
  const duelActive = useStore((s) => s.duelActive)
  if (interventions.length === 0 && !duelActive) return null

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const recent = interventions.slice(0, 4)

  return (
    <div className="iv-ticker">
      {duelActive && (
        <span className="iv-chip duel">
          <Swords size={10} />
          专项对辩：{duelActive.topic}（{duelActive.agentIds.map(nameOf).join(' vs ')}）
        </span>
      )}
      {recent.map((i) => (
        <span key={i.id} className={`iv-chip ${i.kind}`}>
          {i.kind === 'interject' && <><MessageSquare size={10} /> 插话 · 第{ i.deliveredRound ?? i.atRound}轮</>}
          {i.kind === 'followup' && <><Target size={10} /> 追问 {i.targetAgentId ? nameOf(i.targetAgentId) : ''}</>}
          {i.kind === 'duel' && <><Swords size={10} /> 对辩 · {i.topic ?? ''}</>}
          {i.kind === 'set-stance' && <><RefreshCw size={10} /> 调立场 {i.stanceAgentId ? nameOf(i.stanceAgentId) : ''}</>}
          {i.status === 'pending' && <em> 待生效</em>}
          {i.status === 'cancelled' && <em> 已作废</em>}
        </span>
      ))}
      {interventions.length > 4 && <span className="iv-chip">+{interventions.length - 4}</span>}
    </div>
  )
}
