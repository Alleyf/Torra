/**
 * 观点演化视图 —— 研讨屏的中央动效区。
 *
 * 它回答一个问题：这一场讨论现在走到哪一步了。
 * 左侧是「谁在说」（参会模型与本轮状态），中间是四段真实流水线
 * （观点提取 → 观点聚类 → 共识发现 → 结论生成），下方是逐段耗时。
 *
 * 每个数字都来自 store 的同一份数据：发言条数来自 utterances，
 * 论点数来自 buildArgumentMap（共识 + 分歧），共识数来自 consensus，
 * 纪要状态来自 reportReady / finishedReason。这里不做任何估算，
 * 也不为了画面好看补一个「观点簇」之类的虚构指标。
 */
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useStore, type ModelSummary } from '../store'
import { ModelAvatar } from './ModelAvatar'
import { fmtSpan } from '../discussionDerived'
import { createLightLayer, type LightLayer } from '../lancerLight'
import { diffStage, TRUNK, type StageFlight, type StageSnap } from '../stageFlights'
import { asOfRound, replayMaxOf } from '../labReplay'
import { useLabAsOf } from './labAsOf'
import { useLabView } from './labView'
import { Boxes, Check, FileText, GitBranch, Maximize2, Radar, Sparkles } from 'lucide-react'

const NODE_ICON = [Sparkles, Boxes, Radar, FileText] as const

/**
 * 五段进度与下方时间轴共用的阶段口径。
 *
 * 页头的五步进度与这里的五段耗时必须是同一份：两处各写一套，
 * 就会出现「上面说已完成、下面说没跑过」的对不上。
 */
const TIMELINE: Array<{ key: string; name: string; sub: string; stages: string[]; live: string[] }> = [
  { key: 'launch', name: '独立回答', sub: '基线 / 首轮作答', stages: ['baseline'], live: ['READY', 'ROUND_START'] },
  { key: 'extract', name: '观点提取', sub: '抽取有效发言', stages: ['agent-batch'], live: ['AGENT_BATCH'] },
  { key: 'verify', name: '交叉质询', sub: '核验与定向追问', stages: ['verification'], live: [] },
  {
    key: 'consensus',
    name: '共识汇总',
    sub: '聚类与判断归并',
    stages: ['moderator', 'consensus'],
    live: ['MODERATOR_SUMMARY', 'MODERATOR_RETRY', 'CONSENSUS_EVAL'],
  },
  { key: 'report', name: '最终报告', sub: '收束与纪要', stages: ['report', 'final-review'], live: ['REPORT_GEN'] },
]

export type StageStep = {
  key: string
  name: string
  sub: string
  dur: number
  status: 'done' | 'on' | 'skip' | 'pending'
}

/**
 * 页头五步与中央时间轴共用这一份：同一场讨论只有一种阶段口径。
 *
 * 回放时它也得跟着游标走（页头五步和下方时间轴是同一屏的两处，一处回到 R1、
 * 另一处还写着「已跑完」就说不通了）：
 *   「跑过没有」按 `round <= 游标` 过滤耗时记录 —— 那一轮跑过的段才算跑过；
 *   「正在跑」在回放里一律关掉 —— 倒回去看的是过去，过去没有任何一段还在跑。
 */
export function useStageSteps(): StageStep[] {
  const stageTimings = useStore((s) => s.stageTimings)
  const state = useStore((s) => s.state)
  const replay = useLabView().replay

  return useMemo(() => {
    const mine = asOfRound(stageTimings, replay)
    const has = (keys: string[]) => mine.some((t) => keys.includes(t.stage))
    const sum = (keys: string[]) =>
      mine.filter((t) => keys.includes(t.stage)).reduce((a, t) => a + t.durationMs, 0)
    const onAt = (keys: string[]) => replay === null && keys.includes(state)

    const rows = TIMELINE.map((t) => ({
      key: t.key,
      name: t.name,
      sub: t.sub,
      dur: sum(t.stages),
      on: onAt(t.live),
      seen: has(t.stages),
    }))
    /** 走到过的最远一段：它之前的空段是「跳过」，不是「还没开始」 */
    let last = -1
    rows.forEach((r, i) => {
      if (r.on || r.seen) last = i
    })
    return rows.map((r, i) => ({
      key: r.key,
      name: r.name,
      sub: r.sub,
      dur: r.dur,
      status: r.on ? 'on' : r.seen ? 'done' : i < last ? 'skip' : 'pending',
    })) as StageStep[]
  }, [stageTimings, state, replay])
}

interface Props {
  models: ModelSummary[]
  /** 右上角的展开：切到协作视图（那张图能看全） */
  onExpand?: () => void

}
export function EvolutionStage({ models, onExpand }: Props) {
  /** 场次 id：换场次时飞光的基线要重记，不能拿上一场的发言比差 */
  const sessionId = useStore((s) => s.sessionId)
  const participantIds = useStore((s) => s.participantIds)
  const state = useStore((s) => s.state)
  const round = useStore((s) => s.round)
  const moderatorLive = useStore((s) => s.moderatorLive)
  const reportReady = useStore((s) => s.reportReady)
  const finishedReason = useStore((s) => s.finishedReason)
  const paused = useStore((s) => s.paused)

  /**
   * 这一屏的数一律取「游标为止」的那一份（`useLabAsOf`）：倒回 R1 之后，
   * 发言条数、论点、共识都得跟着少下去 —— 否则页头写着「回放 R1」，
   * 下面还是终局那几个数，回放就只是换了个标签。
   */
  const { replay, utterances, consensus, disputes, argmap, maxRound } = useLabAsOf()
  /** 画面上「此刻是第几轮」：回放时是游标，否则是真实的当前轮 */
  const shownRound = replay ?? round

  const steps = useStageSteps()
  /** 卡片右上角那一句：现在是哪一段、这段跑了多久（耗时数据与页头同源） */
  const current = steps.find((t) => t.status === 'on') ?? [...steps].reverse().find((t) => t.status === 'done') ?? null

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const modelOf = (id: string) => models.find((m) => m.id === id)

  /** 有效发言：非缺席、非人工、有正文。人工介入单列，不算模型共识 */
  const effective = useMemo(
    () => utterances.filter((u) => !u.absent && !u.human && u.content.trim().length > 0),
    [utterances],
  )

  /**
   * 本轮每家状态：说话中 / 已说完 / 缺席。
   *
   * 回放里没有「说话中」：那条发言在历史里早就说完了，`streaming` 是实时的现场感。
   * 这里按游标那一轮统计（`shownRound`），不是按真实的当前轮 —— 否则回放到 R1 时
   * 车道会去比 R3 的发言，一格都对不上。
   */
  const lanes = useMemo(
    () =>
      participantIds.map((id) => {
        const mine = utterances.filter((u) => u.agentId === id)
        const cur = mine.filter((u) => u.round === shownRound)
        const streaming = replay === null && cur.some((u) => u.streaming)
        const absent = cur.length > 0 && cur.every((u) => u.absent)
        const done = cur.length > 0 && cur.every((u) => !u.streaming && !u.absent)
        return { id, streaming, absent, done, rounds: new Set(mine.map((u) => u.round)).size }
      }),
    [participantIds, utterances, shownRound, replay],
  )

  /*
   * ── 飞光：从「谁说的」飞到「哪一步」 ───────────────────────────────
   *
   * 复用编码工作台那套 `lancerLight.ts`，不另起一套。差别只在两处：
   *   起点 —— 那边是正文气泡与工作树节点，这边是车道（模型色）与阶段卡；
   *   落点补光 —— 那边 .wtx-hit，这边 .cl-hit（同一个 `hitClass` 选项决定）。
   * 曲线、弯度种子、停帧、页面藏起来就冻结、reduced-motion 降级全部照用。
   *
   * 坐标一律现量。这张卡住在中间栏，宽度随容器变（见 consensusLab.css 的
   * @container 断点），任何缓存下来的坐标都会在换宽后错位。
   */
  const glowRef = useRef<SVGSVGElement | null>(null)
  const layerRef = useRef<LightLayer | null>(null)
  const snapRef = useRef<StageSnap | null>(null)
  /**
   * 待发的那批光：这一帧被取消时不能把工作一起丢掉。
   * 依赖里有 `models` 这种会在同一提交里换引用的值，重跑一次就会取消帧；
   * 若那几束只活在这一帧的闭包里，屏幕上就是「什么都没发生」。
   */
  const pendingRef = useRef<StageFlight[]>([])
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    const svg = glowRef.current
    if (!svg) return
    const layer = createLightLayer(svg, { hitClass: 'cl-hit' })
    layerRef.current = layer
    return () => {
      layer.destroy()
      layerRef.current = null
    }
  }, [])

  /** 回放里没有「正在说话」：那是实时的现场感，不是历史里的事实 */
  const streaming = useMemo(
    () => (replay === null ? utterances.filter((u) => u.streaming) : []),
    [utterances, replay],
  )

  /**
   * 轮次点阵的格子数 = 已经开过的轮数（当前轮与历史发言里最远的一轮取大）。
   * 不按计划轮数画空格：那会把「还没开始」和「这一轮没轮到」画成同一种空。
   */
  const roundCells = useMemo(
    () => Math.max(shownRound, ...utterances.map((u) => u.round), 0),
    [shownRound, utterances],
  )

  /** 四段流水线：值取真实计数，状态取「有没有走到」 */
  const nodes = useMemo(() => {
    const held = argmap.byBucket.held.length
    const contested = argmap.byBucket.contested.length
    const ended = state === 'DONE' || state === 'ABORTED' || state === 'FAILED'
    /**
     * 回放时四段里没有一段「在跑」：那是当下的事。倒回去看的是结果 ——
     * 结论那格要等游标走到最后一轮才算「有纪要」，否则倒回 R1 就显示终局的纪要状态。
     */
    const live = replay === null
    const extracting = live && (state === 'AGENT_BATCH' || state === 'ROUND_START')
    const judging =
      live &&
      (state === 'MODERATOR_SUMMARY' || state === 'MODERATOR_RETRY' || state === 'CONSENSUS_EVAL')
    const writing = live && state === 'REPORT_GEN'
    const reportDone = reportReady && (replay === null || replay >= maxRound)
    return [
      {
        name: '观点提取',
        value: effective.length,
        unit: '条有效观点',
        sub: `${participantIds.length} 家 · 第 ${Math.max(shownRound, 1)} 轮`,
        tone: extracting ? 'on' : effective.length > 0 ? 'done' : 'pending',
      },
      {
        name: '观点聚类',
        value: argmap.nodes.length,
        unit: '个论点',
        sub: `共识 ${consensus.length} · 分歧 ${disputes.length}`,
        tone:
          extracting && effective.length > 0 && argmap.nodes.length === 0
            ? 'on'
            : argmap.nodes.length > 0
              ? 'done'
              : 'pending',
      },
      {
        name: '共识发现',
        value: consensus.length,
        unit: '项共识',
        sub: `立住 ${held} · 还开着 ${contested}`,
        tone: judging ? 'on' : consensus.length > 0 ? 'done' : 'pending',
      },
      {
        name: '结论生成',
        value: reportDone ? 1 : 0,
        unit: '份纪要',
        sub: reportDone
          ? '纪要已生成'
          : replay !== null
            ? '回放里还没走到收束'
            : ended
              ? (finishedReason ?? '已收束')
              : writing
                ? '正在写纪要'
                : '等待收束',
        tone: reportDone ? 'done' : writing || (ended && replay === null) ? 'on' : 'pending',
      },
    ] as const
  }, [
    argmap,
    consensus.length,
    disputes.length,
    effective.length,
    participantIds.length,
    shownRound,
    replay,
    utterances,
    maxRound,
    state,
    reportReady,
    finishedReason,
  ])

  /*
   * 快照 → 光。触发条件只有一份：这一帧的数据和上一帧的差。
   *
   * 放到 rAF 里再量坐标，是因为 React 刚把新的阶段卡挂上 DOM，样式还没落定 ——
   * 同步量会读到入场动画起点的位移，光会落在偏上几像素的位置。
   */
  const nodeTones = nodes.map((n) => n.tone).join(',')
  /**
   * 主持小结的 startedAt 是「当下正在跑」的证据，回放里不该带进来 ——
   * 否则游标走到共识那一格时会从一条已经不存在的实时条上打出一束光。
   */
  const modKey = replay === null ? (moderatorLive?.startedAt ?? null) : null
  useEffect(() => {
    const snap: StageSnap = {
      sid: sessionId,
      replay,
      said: effective.map((u) => ({ id: u.id, agentId: u.agentId })),
      tones: nodeTones.split(','),
      mod: modKey,
    }
    const prev = snapRef.current
    /* 基准就是「上一帧」，必须同步推进；待发的光另排队，活过被取消的那一帧 */
    snapRef.current = snap
    const plans = diffStage(prev, snap)
    if (plans.length) {
      const seen = new Set(pendingRef.current.map((p) => p.eventId))
      for (const p of plans) if (!seen.has(p.eventId)) pendingRef.current.push(p)
    }
    if (!pendingRef.current.length) return
    if (frameRef.current !== null) return

    const raf = window.requestAnimationFrame(() => {
      frameRef.current = null
      const batch = pendingRef.current
      pendingRef.current = []

      const svg = glowRef.current
      const layer = layerRef.current
      const host = svg?.parentElement
      if (!svg || !layer || !host) return
      const base = svg.getBoundingClientRect()
      if (base.width < 1 || base.height < 1) return

      for (const p of batch) {
        const sel =
          p.kind === 'mod'
            ? '.cl-live'
            : p.kind === 'model'
              ? `[data-cl-lane="${p.agentId ?? ''}"]`
              : p.fromStage === TRUNK
                ? '.cl-fan-trunk'
                : `[data-cl-stage="${p.fromStage}"]`
        const fromEl = host.querySelector(sel)
        const toEl = host.querySelector(`[data-cl-stage="${p.stage}"]`)
        if (!fromEl || !toEl) continue
        const fr = fromEl.getBoundingClientRect()
        const tr = toEl.getBoundingClientRect()
        /*
         * 两端都得露在光线层里才发。卡片被滚出可视区（研讨屏下方还有台账与报告）
         * 时打光，用户看不见，却照样吃掉一次帧循环。
         */
        const visible = (r: DOMRect): boolean =>
          r.width > 0 && r.height > 0 && r.top < base.bottom && r.bottom > base.top
        if (!visible(fr) || !visible(tr)) continue
        layer.emit({
          eventId: p.eventId,
          fromId: p.fromId,
          toId: p.toId,
          /*
           * 两端取「边缘」，不取中心：取中心的话光会横穿整张卡，看上去像从卡里
           * 长出来又在卡里消失，「从哪到哪」反而读不出来。
           *
           * 三种关系各有一套锚点：
           *   车道 → 第一格：车道右缘 → 卡片左缘（横向）；
           *   阶段 → 下一格：左卡右缘 → 右卡左缘（横向）；
           *   主持小结 → 共识发现：实时条上缘 → 那张卡的下缘（纵向，因为实时条
           *   在下方横贯整行，取右缘会从最右边横着划回来）。
           */
          from:
            p.kind === 'mod'
              ? { x: tr.left + tr.width / 2 - base.left, y: fr.top - base.top }
              : { x: fr.right - base.left - 4, y: fr.top + fr.height / 2 - base.top },
          to:
            p.kind === 'mod'
              ? { x: tr.left + tr.width / 2 - base.left, y: tr.bottom - base.top }
              : { x: tr.left - base.left + 3, y: tr.top + tr.height / 2 - base.top },
          color:
            p.kind === 'model'
              ? (models.find((m) => m.id === p.agentId)?.color ?? '#3f6ef0')
              : p.tone === 'ok'
                ? 'var(--cl-ok)'
                : 'var(--cl-accent)',
          targetEl: toEl,
          // 阶段之间的光短一些：它交代的是「这一步过了」，不是「有一条新发言」
          durationMs: p.kind === 'stage' ? 820 : 1100,
        })
      }
    })
    return () => {
      window.cancelAnimationFrame(raf)
      frameRef.current = null
    }
  }, [effective, nodeTones, modKey, models, sessionId])

  /**
   * 主持小结的走秒。进度事件只在开始吐字之后才来，
   * 首字之前那几十秒靠这根针交代「还在等，不是卡住」。
   */
  const [liveNow, setLiveNow] = useState(() => Date.now())
  const liveOn = Boolean(moderatorLive)
  const liveStartedAt = moderatorLive?.startedAt ?? 0
  useEffect(() => {
    if (!liveOn) return
    setLiveNow(Date.now())
    const t = setInterval(() => setLiveNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [liveOn, liveStartedAt])

  return (
    <section className="cl-card">
      <header className="cl-card-head">
        <span className="cl-card-title">
          <GitBranch size={13} />
          观点演化视图
        </span>
        <span className="cl-card-tools">
          {current && (
            <span title={current.dur > 0 ? `这一段已跑 ${fmtSpan(current.dur)}` : '这一段还没跑过'}>
              {current.name}
              {current.dur > 0 ? ` · ${fmtSpan(current.dur)}` : current.status === 'on' ? ' · 进行中' : ''}
            </span>
          )}
          <span>
            {replay !== null ? `回放 R${replay}` : round > 0 ? `R${round}` : '未开轮'}
          </span>
          {onExpand && (
            <button className="cl-icon-btn" onClick={onExpand} title="展开协作视图">
              <Maximize2 size={12} />
            </button>
          )}
        </span>
      </header>

      <div className="cl-card-body">
        {/*
          光线层：铺满内容区，不吃鼠标。坐标以这一层左上角为原点 ——
          卡片随中间栏宽度变（见 consensusLab.css 的 @container 断点），
          坐标只在这一层里自洽，跨层借用就得每次换算一遍。
        */}
        <svg className="cl-glow" ref={glowRef} aria-hidden="true" />
        <div className="cl-flow-wrap">
          {/* 标题必须是 flow-wrap 的直接子节点：留在 .cl-lanes 里会变成第 n+1 个 flex 项，
              space-around 的中心就不再是 (i+0.5)/n，汇流弧线会整体错位 */}
          <span className="cl-lanes-cap">多模型观点输入</span>
          <div className="cl-lanes">
            {lanes.map((l) => (
              <div
                key={l.id}
                data-cl-lane={l.id}
                className={`cl-lane${l.streaming ? ' live' : ''}${l.absent ? ' absent' : ''}${l.done ? ' done' : ''}`}
                title={`${nameOf(l.id)} · ${l.rounds} 轮发言`}
                style={{ '--lane-tone': modelOf(l.id)?.color ?? 'var(--cl-text-3)' } as CSSProperties}
              >
                <span className="cl-chip-av" style={{ background: modelOf(l.id)?.color ?? 'var(--cl-text-3)' }}>
                  {modelOf(l.id) ? <ModelAvatar model={modelOf(l.id)!} fill fontSize={8} /> : null}
                </span>
                <span className="cl-lane-name">{nameOf(l.id)}</span>
                {/* 轮次点阵：这一家在几轮里真的开过口。比「已完成」两个字更早说明参与度 */}
                {roundCells > 0 && (
                  <span className="cl-lane-pips" aria-hidden>
                    {Array.from({ length: roundCells }, (_, i) => (
                      <i key={i} className={i < l.rounds ? 'on' : ''} />
                    ))}
                  </span>
                )}
                <span className="cl-lane-flag">
                  {l.streaming ? '发言中' : l.absent ? '缺席' : l.done ? '已完成' : '待发言'}
                </span>
              </div>
            ))}
            {lanes.length === 0 && <div className="cl-empty">还没有参会模型。</div>}
          </div>

          {/* 汇流总线：每条车道一根短线接到竖干线，干线中点再引一支进第一个阶段。
              干线两端各让出 1/(2n) 的行高 —— 车道列 space-around 的中心正好在 (i+0.5)/n，
              所以 n 必须是同一个数，写死在 CSS 里会和车道数脱节。 */}
          <div
            className="cl-fan"
            aria-hidden
            style={{ '--fan-n': lanes.length || 1 } as CSSProperties}
          >
            {lanes.map((l) => (
              <span
                key={l.id}
                className={`cl-fan-tap${l.streaming ? ' live' : ''}${l.absent ? ' absent' : ''}`}
                title={nameOf(l.id)}
              />
            ))}
            <span className="cl-fan-trunk" />
          </div>

          <div className="cl-flow">
            {nodes.map((nd, i) => {
              const Ico = NODE_ICON[i] ?? Sparkles
              return (
                <Fragment key={nd.name}>
                  <div
                    data-cl-stage={i}
                    className={`cl-node ${nd.tone}`}
                    style={{ '--cl-rise-delay': `${i * 70}ms` } as CSSProperties}
                  >
                    {nd.tone === 'on' && <span className="cl-node-scan" />}
                    <div className="cl-node-top">
                      <span className="cl-node-ico">
                        {nd.tone === 'done' ? <Check size={13} /> : <Ico size={13} />}
                      </span>
                      <span className="cl-node-name">{nd.name}</span>
                      <span className="cl-node-idx">{String(i + 1).padStart(2, '0')}</span>
                    </div>
                    <div className="cl-node-val">
                      {/* key 绑值：数变了就重挂一次，cl-tick 才会真的跑第二遍 */}
                      <b key={nd.value}>{nd.value}</b>
                      <span>{nd.unit}</span>
                    </div>
                    <div className="cl-node-sub">{nd.sub}</div>
                  </div>
                  {i < nodes.length - 1 && (
                    /* 连接器的状态跟着「下一格」走，不跟上一格：
                       下一格还在跑 = 正在流过去；下一格已完 = 这段走完了；还没开始 = 全暗 */
                    <span
                      className={`cl-link ${nodes[i + 1]!.tone === 'pending' ? 'dry' : nodes[i + 1]!.tone}`}
                      aria-hidden
                    >
                      <b />
                    </span>
                  )}
                </Fragment>
              )
            })}
          </div>
        </div>

        {/* 此刻：正在说话的人 / 主持小结的黑箱期。两者都是「还在跑」的证据，回放里一条都没有 */}
        {replay === null && moderatorLive ? (
          <div className="cl-live warm">
            <span className="cl-live-dot" />
            <div className="cl-live-main">
              <div className="cl-live-head">
                <b>主持小结</b>
                <span className="cl-live-tag">{moderatorLive.firstByteMs ? '已开始回包' : '还在等首字…'}</span>
                {moderatorLive.attempt > 1 && (
                  <span className="cl-live-time">第 {moderatorLive.attempt} 次</span>
                )}
                <span className="cl-live-time">小结已等 {fmtSpan(Math.max(0, liveNow - moderatorLive.startedAt))}</span>
              </div>
              {moderatorLive.tail && <div className="cl-live-tail">{moderatorLive.tail}</div>}
            </div>
          </div>
        ) : streaming[0] ? (
          <div className="cl-live">
            <span className="cl-live-dot" />
            <div className="cl-live-main">
              <div className="cl-live-head">
                <b>{nameOf(streaming[0].agentId)}</b>
                <span className="cl-live-tag">R{streaming[0].round} 正在作答</span>
                {streaming.length > 1 && <span className="cl-live-time">另有 {streaming.length - 1} 家</span>}
              </div>
              <div className="cl-live-tail">{streaming[0].content}</div>
            </div>
          </div>
        ) : paused && replay === null ? (
          <div className="cl-live">
            <span className="cl-live-dot" />
            <div className="cl-live-main">
              <div className="cl-live-head">
                <b>已暂停</b>
                <span>当前批次结束后停住，不会自己往下走</span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
