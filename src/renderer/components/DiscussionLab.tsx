/**
 * 研讨屏 —— Consensus Lab 主视觉。
 *
 * 结构（自上而下）：
 *   页头：品牌 + 参会模型 + 回放 / 设置
 *   当前问题 + 五步进度（与中央时间轴同源，见 EvolutionStage 的 useStageSteps）
 *   主卡片：观点视图（演化动效）/ 协作视图（论题演化图）/ 时间视图（逐段耗时）
 *   阶段性成果：从真实判断桶里取三条 —— 立住的 / 还开着的 / 已消解或无人认领
 *
 * 「协作视图」不是新画的一张图：论题演化图原样保留，它是看「谁回应了谁」的那一屏。
 * 默认落在观点视图，因为这一屏回答的是「讨论走到哪一步」，不是「谁说了什么」。
 */
import { useEffect, useMemo } from 'react'
import { useStore, type ModelSummary } from '../store'
import { buildArgumentMap, ARG_BUCKET_LABEL, ARG_BUCKET_TONE } from '@shared/argmap'
import { TopicEvolution, type HandoffOutcome } from './TopicEvolution'
import { EvolutionStage, useStageSteps } from './EvolutionStage'
import { ModelAvatar } from './ModelAvatar'
import { fmtSpan } from '../discussionDerived'
import { mdExcerpt } from '../textFormat'
import type { HandoffPayload } from '@shared/handoff'
import { ArrowUpRight, Play, Settings2, Sparkles, Square } from 'lucide-react'
import '../consensusLab.css'
import { prefersReducedMotion } from '../motion'
import { replayDwellMs, replayMaxOf, stepContentOf } from '../labReplay'
import { advanceReplay, setLabTab, stopReplay, toggleReplay, useLabView } from './labView'

export function DiscussionLab({
  models,
  onFollowup,
  onDuel,
  onHandoffToWorkbench,
  onGotoSettings,
}: {
  models: ModelSummary[]
  onFollowup: (agentId: string, utteranceId: string, topic: string) => void
  onDuel: (agentId: string, topic: string) => void
  onHandoffToWorkbench?: (payload: HandoffPayload) => HandoffOutcome
  onGotoSettings: () => void
}) {
  const topicTitle = useStore((s) => s.topicTitle)
  const strategy = useStore((s) => s.strategy)
  const participantIds = useStore((s) => s.participantIds)
  const utterances = useStore((s) => s.utterances)
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const state = useStore((s) => s.state)
  const round = useStore((s) => s.round)
  const paused = useStore((s) => s.paused)
  const stageTimings = useStore((s) => s.stageTimings)
  const focus = useStore((s) => s.focus)
  const setFocus = useStore((s) => s.setFocus)

  const { tab, replay, playing } = useLabView()
  const steps = useStageSteps()
  /** 回放上限：这一场的数据自己说到第几轮（不按计划轮数，见 labReplay.ts） */
  const maxRound = useMemo(() => replayMaxOf([...utterances.map((u) => u.round), round]), [utterances, round])

  /*
   * 回放只有这一根走针。三个视图与右栏共用同一个游标（labView.ts），
   * 各自开一根定时器就会有三根针同时推它 —— 回放会快三倍，而且各自先停一处。
   *
   * 用自排期的 `setTimeout` 而不是 `setInterval`：每一格该停多久取决于**这一格
   * 里发生了什么**（说了几句、落了几条结论），固定周期要么切在半路上、
   * 要么让空轮白等。停留口径见 `replayDwellMs`。
   *
   * 这一格停留多久只算一次：走针用它排下一次推进，页头那根节奏条用同一个数当
   * 动画时长。两处各算一遍就会各答一次「这格该停多久」，条走到头了游标还没动。
   */
  const dwellMs = useMemo(
    () =>
      replay === null
        ? 0
        : replayDwellMs(stepContentOf(replay, { utterances, consensus, disputes }), prefersReducedMotion()),
    [replay, utterances, consensus, disputes],
  )
  useEffect(() => {
    if (!playing || replay === null) return
    const t = window.setTimeout(() => advanceReplay(maxRound), dwellMs)
    return () => window.clearTimeout(t)
  }, [playing, replay, maxRound, dwellMs])

  /** 换场次：上一场的游标不能带过来（那一场没有第 3 轮） */
  const sessionId = useStore((s) => s.sessionId)
  useEffect(() => {
    stopReplay()
  }, [sessionId])

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const modelOf = (id: string) => models.find((m) => m.id === id)

  const argmap = useMemo(
    () => buildArgumentMap({ consensus, disputes, utterances }),
    [consensus, disputes, utterances],
  )

  /** 每家这一轮走到哪了：说话中 / 已说完 / 缺席 */
  const chipState = (id: string) => {
    const cur = utterances.filter((u) => u.agentId === id && u.round === round)
    if (cur.some((u) => u.streaming)) return 'live'
    if (cur.length > 0 && cur.every((u) => u.absent)) return 'absent'
    if (cur.length > 0 && cur.every((u) => !u.streaming)) return 'done'
    return ''
  }

  const ended = state === 'DONE' || state === 'ABORTED' || state === 'FAILED'
  const live = !ended

  /** 阶段性成果：三条都从真实判断桶里取，取不到就留空，不补位 */
  const outcomes = useMemo(() => {
    const held = argmap.byBucket.held
    const contested = argmap.byBucket.contested
    const settled = argmap.byBucket.settled
    const vacated = argmap.byBucket.vacated
    const top = (pool: typeof held, by: (n: (typeof held)[number]) => number) =>
      [...pool].sort((a, b) => by(b) - by(a))[0] ?? null
    return [
      { node: top(held, (n) => n.agents.length * 10 + n.evidence.length), bucket: 'held' as const, hint: '核心共识' },
      { node: top(contested, (n) => n.agents.length), bucket: 'contested' as const, hint: '需进一步讨论' },
      {
        node: top(settled, (n) => n.evidence.length) ?? top(vacated, (n) => n.evidence.length),
        bucket: (settled.length > 0 ? 'settled' : 'vacated') as 'settled' | 'vacated',
        hint: settled.length > 0 ? '已带着依据消解' : '质询后无人认领',
      },
    ].filter((o) => o.node !== null) as Array<{
      node: (typeof held)[number]
      bucket: 'held' | 'contested' | 'settled' | 'vacated'
      hint: string
    }>
  }, [argmap])

  /** 时间视图：逐轮汇总，行数等于真实跑过的轮次 */
  const roundRows = useMemo(() => {
    const rounds = new Set<number>()
    for (const t of stageTimings) if (t.round > 0) rounds.add(t.round)
    for (const u of utterances) if (u.round > 0) rounds.add(u.round)
    return [...rounds].sort((a, b) => a - b).map((r) => {
      const mine = utterances.filter((u) => u.round === r)
      const absent = mine.filter((u) => u.absent).length
      const dur = stageTimings.filter((t) => t.round === r).reduce((a, t) => a + t.durationMs, 0)
      return {
        round: r,
        spoken: mine.filter((u) => !u.absent).length,
        absent,
        dur,
        stages: stageTimings.filter((t) => t.round === r),
      }
    })
  }, [stageTimings, utterances])

  const jumpTo = (id: string) => {
    setFocus({ kind: 'claim', id })
    setLabTab('graph')
  }

  return (
    <div className={`cl-page ${tab}`}>
      <header className="cl-top">
        <div className="cl-brand">
          <span className="cl-mark">
            <Sparkles size={16} />
          </span>
          <span className="cl-brand-text">
            <span className="cl-brand-name">Consensus Lab</span>
            <span className="cl-brand-sub">多模型协同推理 · 共识发现工作台</span>
          </span>
        </div>

        <div className="cl-chips">
          {participantIds.map((id) => {
            const st = chipState(id)
            const m = modelOf(id)
            return (
              <span key={id} className={`cl-chip${st ? ` ${st}` : ''}`} title={nameOf(id)}>
                <span className="cl-chip-av" style={{ background: m?.color ?? 'var(--cl-text-3)' }}>
                  {m ? <ModelAvatar model={m} fill fontSize={8} /> : null}
                </span>
                {nameOf(id)}
                <i className="cl-chip-dot" />
              </span>
            )
          })}
        </div>

        <div className="cl-actions">
          <span className={`cl-state${live && !paused ? ' live' : ''}`}>
            {live && !paused && <i />}
            {paused ? '已暂停' : live ? '讨论中' : '已收束'}
          </span>
          {/*
            节奏条：回放正在自动走时，把「这一格还剩多久」画出来。
            没有它，一格停多久全靠猜 —— 用户只觉得画面在莫名其妙地等，或者一闪就过去了。
            宽度按 dwellMs 走 CSS 动画，不逐帧重渲染：key 绑游标，每进一格重挂一次，
            条就跟着重新从 0 走到 100%。走到上限停住时 playing 转 false，条一起消失。
          */}
          {replay !== null && playing && (
            <span className="cl-pace" aria-hidden title={`这一格停留 ${Math.round(dwellMs / 100) / 10} 秒`}>
              <i key={replay} style={{ animationDuration: `${dwellMs}ms` }} />
            </span>
          )}
          <button
            className="cl-ghost"
            onClick={() => toggleReplay(maxRound)}
            /* 判据是游标在不在，不是走针在不在：走到最后一格会停住不再往前，
               那时按钮仍得是「停止」，否则用户找不到回现在的那一下 */
            title={replay !== null ? '停止回放，回到现在' : '按轮次重放演化过程'}
          >
            {replay !== null ? <Square size={11} /> : <Play size={11} />}
            {replay !== null ? '停止' : '回放'}
          </button>
          <button className="cl-ghost" onClick={onGotoSettings} title="打开设置">
            <Settings2 size={11} />
            设置
          </button>
        </div>
      </header>

      <section className="cl-question">
        <div className="cl-q-row">
          <span className="cl-q-label">当前问题</span>
          <span className="cl-q-title" title={topicTitle}>
            {topicTitle || '未命名议题'}
          </span>
          <span className="cl-q-meta">
            {strategy} · {replay !== null ? `回放 R${replay}` : `R${round}`} · {participantIds.length} 家
          </span>
        </div>
        <div className="cl-steps">
          {steps.map((t, i) => (
            <div
              key={t.key}
              className={`cl-step${t.status === 'done' ? ' done' : t.status === 'on' ? ' current' : ''}`}
            >
              <span className="cl-step-dot">{t.status === 'done' ? '✓' : i + 1}</span>
              <span className="cl-step-label">{t.name}</span>
            </div>
          ))}
        </div>
      </section>

      {/* 三视图：同一批数据的三种切面。默认落在观点视图 —— 这一屏回答的是「走到哪一步」 */}
      <div className="cl-viewbar">
        <div className="cl-tabs">
          {(
            [
              ['flow', '观点视图'],
              ['graph', '协作视图'],
              ['time', '时间视图'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`cl-tab${tab === k ? ' active' : ''}`}
              onClick={() => setLabTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="cl-viewbar-hint">
          {tab === 'flow'
            ? '谁在说 · 走到哪一步'
            : tab === 'graph'
              ? '谁回应了谁 · 判断落在哪一轮'
              : '逐轮耗时与缺席'}
        </span>
      </div>
      {tab === 'flow' ? (
        <EvolutionStage models={models} onExpand={() => setLabTab('graph')} />
      ) : tab === 'graph' ? (
        <TopicEvolution
          models={models}
          onFollowup={onFollowup}
          onDuel={onDuel}
          onHandoffToWorkbench={onHandoffToWorkbench}
        />
      ) : (
        <section className="cl-card">
          <header className="cl-card-head">
            <span className="cl-card-title">时间视图</span>
            <span className="cl-card-tools">{roundRows.length} 轮</span>
          </header>
          <div className="cl-card-body">
            {roundRows.length === 0 ? (
              <div className="cl-empty">还没有跑过任何一轮。</div>
            ) : (
              roundRows.map((r) => (
                <div key={r.round} className="cl-dispute" style={{ marginBottom: 8 }}>
                  <div className="cl-dispute-q">
                    第 {r.round} 轮 · 发言 {r.spoken}
                    {r.absent > 0 && ` · 缺席 ${r.absent}`} · 合计 {fmtSpan(r.dur)}
                  </div>
                  {r.stages.map((t, i) => (
                    <div key={`${t.stage}-${i}`} className="cl-kv">
                      <span>
                        {t.stage}
                        {t.summary && ` · ${t.summary}`}
                      </span>
                      <span>{fmtSpan(t.durationMs)}</span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* 成果条只在观点视图里出现：协作视图的右栏就是台账，同一批判断已在那边逐条展开，
          再摆一排摘要既重复又要把图挤矮 —— 那三条在那边点得开、看得到全文。 */}
      {outcomes.length > 0 && tab !== 'graph' && (
        <section className="cl-outcomes">
          <div className="cl-outcomes-cap">
            <b>阶段性成果</b>
            <span>取自当前判断桶，与台账同一份</span>
          </div>
          <div className="cl-outcome-row">
            {outcomes.map((o) => {
              const tone = ARG_BUCKET_TONE[o.bucket]
              const focused = focus?.kind === 'claim' && focus.id === o.node.id
              return (
                <button
                  key={o.node.id}
                  className="cl-outcome"
                  onClick={() => jumpTo(o.node.id)}
                  title={focused ? '已在协作视图里点亮' : '在协作视图里点亮这条判断'}
                >
                  <div className="cl-outcome-head">
                    <span className={`cl-outcome-tag ${tone}`}>{ARG_BUCKET_LABEL[o.bucket]}</span>
                    {o.hint}
                  </div>
                  <div className="cl-outcome-claim">{mdExcerpt(o.node.claim, 110)}</div>
                  <div className="cl-outcome-foot">
                    <ArrowUpRight size={11} />
                    {o.node.agents.length} 家认账 · 依据 {o.node.evidence.length}
                    {o.node.rounds && ` · R${o.node.rounds.from}`}
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
