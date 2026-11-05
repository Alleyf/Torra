/**
 * 超智能体任务台：Router 管分派，Worker 各起各的会话。
 *
 * 三栏各管一件事，口径跟编码工作台的三栏一样 —— 左边是人和 Router（说一句，
 * 看它怎么拆），中间是任务板（每张卡是一份台账），右边是选中那一张的详情
 * （目标、目录、工具轨迹、输出尾部）。
 *
 * 状态只有两个来路，渲染层不自己攒第二份：
 * - 面板挂上来时拉一次 `superagentState()`；
 * - 之后靠 `superagent:router`（Router 的转述）与 `superagent:tasks`（整份清单）
 *   两条推送。任务清单尤其直接吃推送里那一整份 —— 主进程是台账的唯一真源，
 *   界面上不合并、不补全、不按自己的判断重排。
 *
 * Router 的转述是唯一一处「增量」：`text` 是一片一片来的 delta，`done` 到了
 * 这一轮收口，下一片 delta 另起一段。工具结果不外泄，只摆 Router 给界面的那一句。
 *
 * 颜色照旧只走 token：面板在白天与黑夜共用同一批选择器，两套主题的差异全部在
 * styles.css 的 :root / [data-theme='dark'] 里，这里不写一个字面色。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, CircleStop, Loader2, ShieldCheck, ShieldX } from 'lucide-react'
import {
  STAGE_GROUPS,
  stageLabel,
  type RouterEvent,
  type SuperAgentState,
  type SuperTask,
} from '@shared/superagent'
import type { AssistantModelView } from '@shared/assistant'

/** Router 转述最多留多少行：早先几轮说完就收口了，不必一直摆在那儿占地方 */
const MAX_ROUTER_LINES = 40

/** 一屏里输入框最多长到多高（像素），再长就在框里滚 */
const COMPOSER_MAX_HEIGHT = 140

/** 追着任务还在跑的阶段：只有这些还能取消，收口了再摆一枚取消键就是空的 */
const LIVE_STAGES: readonly SuperTask['stage'][] = ['pending', 'working', 'waiting_input']

/** Router 推过来的一件事，落到界面上的一行 */
type RouterLine =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'status'; text: string }
  | { kind: 'error'; text: string }

/** 往转述尾部加一行，超出上限就从最前面裁掉 */
function pushLine(cur: RouterLine[], line: RouterLine): RouterLine[] {
  const next = [...cur, line]
  return next.length > MAX_ROUTER_LINES ? next.slice(next.length - MAX_ROUTER_LINES) : next
}

function RouterLineView({ line }: { line: RouterLine }) {
  if (line.kind === 'text') return <p className="sa-line sa-line-text">{line.text}</p>
  if (line.kind === 'tool') {
    return (
      <div className="sa-line sa-line-tool" title={`${line.name} → ${line.detail}`}>
        <span className="sa-tool-name">{line.name}</span>
        <span className="sa-arrow">→</span>
        <span className="sa-tool-detail">{line.detail}</span>
      </div>
    )
  }
  if (line.kind === 'status') return <p className="sa-line sa-line-status">{line.text}</p>
  return <p className="sa-line sa-line-err">{line.text}</p>
}

export function SuperAgentPanel() {
  const [state, setState] = useState<SuperAgentState | null>(null)
  const [lines, setLines] = useState<RouterLine[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [interveneDraft, setInterveneDraft] = useState('')
  /**
   * 界面自己记的「我这句话送出去了还没回来」。
   * routerBusy 只在 state 里，推送的 RouterEvent 不带这一位，所以送出的那一刻要就地摆出来。
   */
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  /**
   * 路由模型就是助手用的那个 API 模型（`routerApi()` 跟着 `preferredModelId()` 走），
   * 所以这里列的是助手的可用 API 条目，切换走同一个 `assistantSetModel`：
   * 两处各选一遍，迟早会出现「面板说 A、实际跑 B」。
   */
  const [models, setModels] = useState<AssistantModelView[]>([])
  const routerInputRef = useRef<HTMLTextAreaElement>(null)
  const interveneRef = useRef<HTMLTextAreaElement>(null)
  /** 这一轮收口了没有：收口后下一片 delta 必须另起一段，不能接在上一轮尾巴上 */
  const roundClosed = useRef(true)
  /** 清单推送可能比首次 `superagentState()` 的回包先到：先搁着，回包来了再并进去 */
  const pushedTasks = useRef<SuperTask[] | null>(null)

  // Router 的转述：text 累积、tool 一行、error/status 各自一套样式、done 收口
  const onRouterEvent = useCallback((ev: RouterEvent) => {
    if (ev.kind === 'text') {
      if (roundClosed.current) {
        roundClosed.current = false
        setLines((cur) => pushLine(cur, { kind: 'text', text: ev.delta }))
      } else {
        // 一片 delta 接在最后一段正文后面；最后一段不是正文就另起一段
        setLines((cur) => {
          const last = cur[cur.length - 1]
          if (!last || last.kind !== 'text') return pushLine(cur, { kind: 'text', text: ev.delta })
          const next = [...cur]
          next[next.length - 1] = { kind: 'text', text: last.text + ev.delta }
          return next
        })
      }
      return
    }
    if (ev.kind === 'tool') {
      setLines((cur) => pushLine(cur, { kind: 'tool', name: ev.name, detail: ev.detail }))
      return
    }
    if (ev.kind === 'status') {
      setLines((cur) => pushLine(cur, { kind: 'status', text: ev.text }))
      return
    }
    if (ev.kind === 'error') {
      setLines((cur) => pushLine(cur, { kind: 'error', text: ev.text }))
      setNote(ev.text)
      return
    }
    // done：这一轮说完了。下一片 delta 另起一段，界面上的「进行中」也该撤了
    roundClosed.current = true
    setSending(false)
  }, [])

  useEffect(() => {
    const offRouter = window.torra.on('superagent:router', (p) => onRouterEvent(p as RouterEvent))
    const offTasks = window.torra.on('superagent:tasks', (p) => {
      const tasks = p as SuperTask[]
      pushedTasks.current = tasks
      setState((cur) => (cur ? { ...cur, tasks } : cur))
      // 选中的那张被收口或挪走了，右栏不能一直指着一张已经不在的卡
      setSelectedId((cur) => {
        if (cur && tasks.some((t) => t.id === cur)) return cur
        return tasks[0]?.id ?? null
      })
    })
    return () => {
      offRouter()
      offTasks()
    }
  }, [onRouterEvent])

  // 首次打开：整份状态一次拿回来，转述与任务板各自就位
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [s, ms] = await Promise.all([
          window.torra.superagentState(),
          window.torra.assistantModels(),
        ])
        if (!alive) return
        setModels(ms)
        const merged = pushedTasks.current ? { ...s, tasks: pushedTasks.current } : s
        pushedTasks.current = null
        setState(merged)
        setLines(merged.transcript.map((text) => ({ kind: 'text', text })))
        setSelectedId(merged.tasks[0]?.id ?? null)
      } catch (e) {
        if (alive) setNote(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 两个输入框都跟着内容长高，长到上限就在框里滚
  useEffect(() => {
    for (const el of [routerInputRef.current, interveneRef.current]) {
      if (!el) continue
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
    }
  }, [draft, interveneDraft])

  const tasks = state?.tasks ?? []
  const routerModel = state?.routerModel ?? null
  const routerModelId = state?.routerModelId ?? null
  /** 只列启用的 API 条目：网页模型当不了 Router（它要发工具调用，得是 API 通道） */
  const routerModels = models.filter((m) => m.transport === 'api' && m.enabled)
  /**
   * 下拉的选项：条目 + 该条目的可切换模型。
   *
   * 只列条目的话，同一家服务里换模型（deepseek-flash → deepseek-chat）就没处点；
   * 值统一成 `条目id` 或 `条目id::模型名`，与 `assistantSetModel` 的入参同形。
   */
  const routerOptions = routerModels.flatMap((m) => {
    const base = [{ value: m.id, label: m.displayName }]
    if (!m.availableModels || m.availableModels.length <= 1) return base
    return [...base, ...m.availableModels.map((sub) => ({ value: `${m.id}::${sub}`, label: `${m.displayName} · ${sub}` }))]
  })
  /**
   * 当前值：主进程给的是「条目 id + 正在跑的模型名」。
   * 该条目有多档模型时回填成 `条目id::模型名`，否则单看条目 —— 回填错了，
   * 下拉会显示成另一项，看着像「切了没生效」。
   */
  const routerValue =
    routerModelId && routerModel && models.find((m) => m.id === routerModelId)?.availableModels?.includes(routerModel)
      ? `${routerModelId}::${routerModel}`
      : routerModelId ?? ''
  const selected = tasks.find((t) => t.id === selectedId) ?? null
  const routerBusy = sending || state?.routerBusy === true

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    setNote(null)
    setDraft('')
    setSending(true)
    // 新一轮：下一片 delta 另起一段，别接在上一轮的尾巴上
    roundClosed.current = true
    const res = await window.torra.superagentSend(text)
    if (!res.ok) {
      setNote(res.error ?? '送不出去')
      setSending(false)
      return
    }
    // routerBusy 只在 state 里，推送不带这一位：送完核一遍，进行中才撤得掉
    try {
      const s = await window.torra.superagentState()
      setState((cur) => (cur ? { ...cur, routerBusy: s.routerBusy } : cur))
    } catch {
      /* 核不到就留着「进行中」—— 宁可多摆一会儿，别把还在跑的说成闲着 */
    }
  }, [draft, sending])

  const intervene = useCallback(async () => {
    const text = interveneDraft.trim()
    if (!selected || !text) return
    setNote(null)
    const res = await window.torra.superagentTaskIntervene(selected.id, text)
    setInterveneDraft('')
    if (!res.ok) setNote(res.error ?? '插不进去')
  }, [interveneDraft, selected])

  const decide = useCallback(
    async (decision: 'allow' | 'deny') => {
      if (!selected) return
      setNote(null)
      const res = await window.torra.superagentPermission(selected.id, decision)
      if (!res.ok) setNote('这份授权回不去了')
    },
    [selected],
  )

  const cancel = useCallback(async () => {
    if (!selected) return
    setNote(null)
    const res = await window.torra.superagentTaskCancel(selected.id)
    if (!res.ok) setNote(res.error ?? '取消不了')
  }, [selected])

  /** 叫停 Router 这一轮：主进程断掉连接、后续工具不再派，界面收手靠 done 推送 */
  const stopRouter = useCallback(async () => {
    setNote(null)
    await window.torra.superagentRouterAbort()
  }, [])

  /**
   * 切换路由模型。走助手那条 `assistantSetModel`：Router 的模型就是助手当前的模型，
   * 切换成功后重新读一次 state，头部显示的是主进程认定的那个，不是这里猜的。
   * 值形如 `条目id::模型名`（条目内还可再选具体模型）。
   */
  const pickRouterModel = useCallback(async (next: string) => {
    setNote(null)
    const r = await window.torra.assistantSetModel(next)
    if (!r.ok) {
      setNote(r.reason ?? '切换模型失败')
      return
    }
    try {
      const s = await window.torra.superagentState()
      setState(s)
    } catch {
      /* 读不到就让用户重开面板，不在界面上编一个模型名 */
    }
  }, [])

  return (
    <div className="sa">
      {/* ── 左：Router 对话 ───────────────────────────────────────── */}
      <section className="sa-col sa-router" aria-label="Router 对话">
        <header className="sa-head">
          <b>Router</b>
          {/*
            头部就是模型开关：Router 用哪个模型由这里定（跟助手是同一个）。
            条目带可切换清单时，选项摊成「条目 · 模型」—— 只列条目的话，
            用户在 deepseek-flash 上换不到 deepseek-chat。
          */}
          <select
            className="sa-model"
            aria-label="路由模型"
            value={routerValue}
            disabled={routerBusy || routerModels.length === 0}
            onChange={(e) => void pickRouterModel(e.target.value)}
          >
            {routerOptions.length === 0 && <option value="">设置页里还没有可用的 API 模型</option>}
            {routerValue === '' && routerOptions.length > 0 && <option value="">选一个路由模型</option>}
            {routerOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </header>

        <div className="sa-lines">
          {state === null && <p className="sa-empty">正在读任务台…</p>}
          {state !== null && lines.length === 0 && (
            <p className="sa-empty">还没有转述。给它一句活，它会把怎么拆说给你听。</p>
          )}
          {lines.map((line, i) => (
            <RouterLineView key={i} line={line} />
          ))}
        </div>

        {routerModel === null && state !== null && (
          <div className="sa-note sa-note-warn">还没配路由模型，去设置里挑一个 API 模型。</div>
        )}
        {note && <div className="sa-note sa-note-err">{note}</div>}

        <div className="sa-composer">
          <div className="sa-composer-in">
            <textarea
              ref={routerInputRef}
              rows={1}
              value={draft}
              placeholder={routerModel === null ? '先配路由模型' : '给 Router 说一句 · Enter 送出'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {/*
              忙的时候这个键就是「停下」：Router 一轮可能转十几次工具，
              没有中断键就只能等它自己收口 —— 那正是「发布任务停不下来」。
            */}
            <button
              type="button"
              className={`agx-send${routerBusy ? ' stop' : ''}`}
              disabled={routerBusy ? false : routerModel === null || !draft.trim()}
              onClick={() => void (routerBusy ? stopRouter() : send())}
              title={routerBusy ? '叫停这一轮' : '送出（Enter）'}
              aria-label={routerBusy ? '叫停' : '送出'}
            >
              {routerBusy ? <CircleStop size={15} /> : <ArrowUp size={16} />}
            </button>
          </div>
          <div className="sa-composer-foot">
            {routerBusy ? 'Router 正在拆活' : '说一句要做什么的，剩下的由它分派'}
          </div>
        </div>
      </section>

      {/* ── 中：任务板 ───────────────────────────────────────────── */}
      <section className="sa-col sa-board" aria-label="任务板">
        <header className="sa-head">
          <b>任务板</b>
          <span>
            共 {tasks.length} 张
            {state !== null && state.agents.length > 0 ? ` · ${state.agents.length} 家可分派` : ''}
          </span>
        </header>

        <div className="sa-board-scroll">
          {state === null && <p className="sa-empty">正在读任务台…</p>}
          {/* 一张卡都没有时只摆这一句：再往下摆两组「0 · 还没有」是同一句话说两遍 */}
          {state !== null && tasks.length === 0 && (
            <div className="sa-board-empty">还没有任务。给 Router 说一句，它会把活拆下去。</div>
          )}
          {state !== null && tasks.length > 0 &&
            STAGE_GROUPS.map((group) => {
              const items = tasks.filter((t) => group.stages.includes(t.stage))
              return (
                <div key={group.label}>
                  <div className="sa-group">
                    <span>{group.label}</span>
                    {/* 条数就是这一组里摆出来的那几张：不估、不补、不按阶段凑数 */}
                    <span className="sa-group-count">{items.length}</span>
                  </div>
                  {items.length === 0 && <div className="sa-group-empty">还没有</div>}
                  {items.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`sa-card${selectedId === t.id ? ' on' : ''}`}
                      onClick={() => setSelectedId(t.id)}
                      aria-pressed={selectedId === t.id}
                    >
                      <div className="sa-card-top">
                        <b>{t.title}</b>
                        <span className={`sa-card-stage sa-stage-${t.stage}`}>{stageLabel(t.stage)}</span>
                      </div>
                      <div className="sa-card-meta">
                        <span>{t.agentTitle}</span>
                        <span>· {t.rounds} 轮</span>
                      </div>
                      {t.stage === 'waiting_input' && t.waitingText && (
                        <div className="sa-card-wait">{t.waitingText}</div>
                      )}
                      {t.stage === 'failed' && t.error && <div className="sa-card-err">{t.error}</div>}
                    </button>
                  ))}
                </div>
              )
            })}
        </div>
      </section>

      {/* ── 右：选中那一张的详情 ─────────────────────────────────── */}
      <section className="sa-col sa-detail" aria-label="任务详情">
        {selected ? (
          <>
            <header className="sa-head">
              <b>{selected.title}</b>
              <span>{selected.agentTitle}</span>
              {LIVE_STAGES.includes(selected.stage) && (
                <button type="button" className="sa-btn danger" onClick={() => void cancel()}>
                  <CircleStop size={12} />
                  取消
                </button>
              )}
            </header>

            <div className="sa-detail-scroll">
              {selected.stage === 'waiting_input' && (
                <div className="sa-perm" role="group" aria-label="授权">
                  <p>{selected.waitingText ?? '它在等你说一句话。'}</p>
                  <div className="sa-perm-actions">
                    <button type="button" className="sa-btn primary" onClick={() => void decide('allow')}>
                      <ShieldCheck size={12} />
                      允许
                    </button>
                    <button type="button" className="sa-btn danger" onClick={() => void decide('deny')}>
                      <ShieldX size={12} />
                      拒绝
                    </button>
                  </div>
                </div>
              )}

              <dl className="sa-facts">
                <div className="sa-fact">
                  <dt>目标</dt>
                  <dd>{selected.goal}</dd>
                </div>
                <div className="sa-fact">
                  <dt>工作目录</dt>
                  <dd className="sa-mono">{selected.cwd}</dd>
                </div>
                <div className="sa-fact">
                  <dt>智能体</dt>
                  <dd>{selected.agentTitle}</dd>
                </div>
                <div className="sa-fact">
                  <dt>阶段</dt>
                  <dd>{stageLabel(selected.stage)}</dd>
                </div>
                <div className="sa-fact">
                  <dt>轮次</dt>
                  <dd>{selected.rounds}</dd>
                </div>
                {selected.error && (
                  <div className="sa-fact">
                    <dt>原因</dt>
                    <dd className="sa-err-text">{selected.error}</dd>
                  </div>
                )}
              </dl>

              <div className="sa-section">
                <h4>工具调用 · {selected.toolCalls.length}</h4>
                {selected.toolCalls.length === 0 ? (
                  <p className="sa-muted">还没有</p>
                ) : (
                  <ul className="sa-tools">
                    {selected.toolCalls.map((c) => (
                      <li key={c.id}>
                        <span className="sa-tool-t">{c.title}</span>
                        <span className="sa-tool-s">{c.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="sa-section">
                <h4>输出尾部</h4>
                <pre className="sa-tail">{selected.outputTail || '（还没有输出）'}</pre>
              </div>

              <div className="sa-section">
                <h4>插话</h4>
                <div className="sa-intervene">
                  <textarea
                    ref={interveneRef}
                    rows={1}
                    value={interveneDraft}
                    placeholder="直接跟这一张说一句话"
                    onChange={(e) => setInterveneDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void intervene()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="sa-btn primary"
                    disabled={!interveneDraft.trim()}
                    onClick={() => void intervene()}
                  >
                    送出
                  </button>
                </div>
                <p className="sa-muted">插话只进这一张，别的任务不受影响。</p>
              </div>
            </div>
          </>
        ) : (
          <>
            <header className="sa-head">
              <b>任务详情</b>
              <span>{tasks.length === 0 ? '还没有任务' : '在左边点一张卡'}</span>
            </header>
            <div className="sa-detail-scroll">
              <p className="sa-empty">
                {state === null
                  ? '正在读任务台…'
                  : tasks.length === 0
                    ? '还没有任务。给 Router 说一句，它会把活拆下去。'
                    : '在中间的任务板上点一张卡，这一栏摆它的目标、目录与工具轨迹。'}
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
