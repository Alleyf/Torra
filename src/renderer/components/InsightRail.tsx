/**
 * 共识洞察 —— 研讨屏右栏的主视图。
 *
 * 与旧右栏的分工没变，只是把「读结论」这一侧按参考稿重排：
 * 顶部一格是这场讨论现在的共识度与最硬的一条判断，往下逐条列出判断，
 * 点开一条就地展开**证据溯源**：这条判断引了哪几句原话、谁说的、第几轮、
 * 查不到原文的有几条、跨轮归并掉的其他措辞是什么。
 *
 * 证据只画真实外键（evidenceRef → utterance），没有原文就显式写「查不到」，
 * 不补一句看起来像证据的话。判断按有没有人认账分桶，口径来自 shared/argmap，
 * 与台账、报告同源。
 *
 * 底部四个入口（观点聚类 / 交叉质询 / 运行记录 / 成本统计）是同一批数据的
 * 另外三种切面；「完整台账」保留旧右栏（此刻 + 台账 + 这场怎么跑的），
 * 它是这批判断唯一的可读全文。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { setRailView, useLabView, type RailView } from './labView'
import { useLabAsOf } from './labAsOf'
import { useStore, type ModelSummary } from '../store'
import { ARG_BUCKET_HINT, type ArgBucket, type ArgNode } from '@shared/argmap'
import { diffRailPoints, REPLAY_RAIL_DELAY_MS, type RailSnap } from '../labReplay'
import { createLightLayer, type LightLayer } from '../lancerLight'
import { prefersReducedMotion } from '../motion'
import { revealDelta } from '../railScroll'
import { ModelAvatar } from './ModelAvatar'
import { RightPanel } from './RightPanel'
import { fmtSpan, fmtUsd } from '../discussionDerived'
import { plainMd } from '../textFormat'
import '../consensusLab.css'
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  Coins,
  ListTree,
  Radar,
  ShieldCheck,
} from 'lucide-react'

/** 摘要位置是纯文本节点：行内 markdown 摊平，星号不会原样印在 span 里 */
const excerpt = (t: string, max: number) => plainMd(t, max)

const RAIL_TABS: Array<{ key: RailView; label: string; icon: typeof Radar }> = [
  { key: 'insight', label: '观点聚类', icon: Radar },
  { key: 'verify', label: '交叉质询', icon: ShieldCheck },
  { key: 'run', label: '运行记录', icon: Activity },
  { key: 'cost', label: '成本统计', icon: Coins },
]

const BUCKET_TONE: Record<ArgBucket, 'ok' | 'warn' | 'muted' | 'bad'> = {
  held: 'ok',
  contested: 'warn',
  settled: 'muted',
  vacated: 'bad',
}

/**
 * 一条判断成形时，最多几束光、最多从几家起飞。
 *
 * 上限不是性能考虑：一帧里跑出八条新结论是常事（并行作答 + 主持一次归并），
 * 十几束光同时横穿屏幕会糊成一片，「谁落到哪一条」反而看不清。
 * 四条 = 一次归并里最常见的「两家支持 + 一条新判断」还留了余量。
 */
const RAIL_FLIGHT_MAX = 4
const RAIL_SOURCES_MAX = 3
/*
 * 判断卡的「到了」要演完整：`.cl-point.cl-hit` 里最长的是 cl-form 0.9s。
 * 沿用 lancerLight 的默认 420ms 会在 47% 处把动画摘掉，卡面柔光硬切回底色。
 * 取 1000 而不是刚好 900：与关键帧等长时，摘类与动画收尾会抢同一帧。
 */
const RAIL_HIT_MS = 1000

/** 一束光的起点：语义 id（`model:<agentId>` 或 `stage:2`）+ 以右栏为原点的坐标 */
interface Source {
  key: string
  x: number
  y: number
  color: string
}

export function InsightRail({ models }: { models: ModelSummary[] }) {
  /**
   * 判断、证据、发言一律取「游标为止」的那一份（`useLabAsOf`）：回放倒回 R1 时
   * 右栏必须只剩 R1 的结论 —— 否则中央写着「回放 R1」，右边还在列终局的五条共识，
   * 两处说的是两个时刻。
   */
  const { replay, utterances, argmap } = useLabAsOf()
  const participantIds = useStore((s) => s.participantIds)
  const stageTimings = useStore((s) => s.stageTimings)
  const moderatorAudit = useStore((s) => s.moderatorAudit)
  const corrections = useStore((s) => s.corrections)
  const convergenceNote = useStore((s) => s.convergenceNote)
  const spentUsd = useStore((s) => s.spentUsd)
  const budgetLimitUsd = useStore((s) => s.budgetLimitUsd)
  const round = useStore((s) => s.round)
  const state = useStore((s) => s.state)
  const focus = useStore((s) => s.focus)
  const setFocus = useStore((s) => s.setFocus)

  const { rail: view } = useLabView()
  const [open, setOpen] = useState<string | null>(null)

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const modelOf = (id: string) => models.find((m) => m.id === id)

  const uttById = useMemo(() => new Map(utterances.map((u) => [u.id, u])), [utterances])
  /** 判断按「认账的人够不够过半」分两类：这是计数，不是重新判定 */
  const half = Math.max(1, Math.ceil(participantIds.length / 2))
  const held = argmap.byBucket.held
  const contested = argmap.byBucket.contested
  const fullSupport = held.filter((n) => n.agents.length >= half)
  const partialSupport = held.filter((n) => n.agents.length < half)

  /** 最硬的一条：支持的人最多、证据最全；并列时取证据更多的那条 */
  const lead = useMemo(() => {
    const pool = [...held, ...contested]
    if (pool.length === 0) return null
    return pool.sort(
      (a, b) => b.agents.length - a.agents.length || b.evidence.length - a.evidence.length,
    )[0]
  }, [held, contested])

  const heldRatio = held.length + contested.length > 0 ? held.length / (held.length + contested.length) : 0
  const ringLen = 2 * Math.PI * 30

  const perModelCost = useMemo(() => {
    const acc = new Map<string, number>()
    for (const u of utterances) {
      const c = u.usage?.costUsd ?? 0
      if (c > 0) acc.set(u.agentId, (acc.get(u.agentId) ?? 0) + c)
    }
    return [...acc.entries()].sort((a, b) => b[1] - a[1])
  }, [utterances])

  const toggle = (id: string) => {
    setOpen((cur) => (cur === id ? null : id))
    setFocus(focus?.kind === 'claim' && focus.id === id ? null : { kind: 'claim', id })
  }

  const live = state !== 'DONE' && state !== 'ABORTED' && state !== 'FAILED'

  /*
   * ── 飞光：从「把这条判断顶上来」的模型，飞到右栏刚落下来的那张判断卡 ──────
   *
   * 复用中央那套 `lancerLight.ts`（全项目只有这一套）。起点不是「共识发现」那张卡，
   * 而是左栏里支持这条判断的几个模型头像：一条判断是「谁把它顶上来」的，
   * 从它们的头像起飞才读得出这句；从阶段卡起飞只说明「这一段跑完了」。
   * 几家各飞一束、落到同一张卡上，就是「这条观点成形」的那一下。
   *
   * 只在两种时刻发：主持刚确认下一条结论（实时），或回放游标前进一格带回了它
   * （口径在 `labReplay.ts` 的 `diffRailPoints`）。换基准一律不发 —— 一进研讨屏
   * 就是满屏光，等于把历史重播一遍。
   *
   * 坐标以右栏这一层为原点，起点在左栏，所以 from.x 是负数（能到 -900）：
   * `.cl-rail-glow` 必须 `overflow: visible`（见 consensusLab.css），否则光从栏外
   * 起飞那一截会被裁掉，看起来像从栏边凭空出现。
   */
  const glowRef = useRef<SVGSVGElement | null>(null)
  /** 判断卡实际被裁切的那一层（`overflow: auto`）：光要落在它里面才看得见 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<LightLayer | null>(null)
  const snapRef = useRef<RailSnap | null>(null)
  /**
   * 待发的判断 id：这一帧被取消时不能把工作一起丢掉（见下面 effect 里的注释）。
   * `frameRef` 只记当前挂着的那一帧，避免重复排帧。
   */
  const pendingRef = useRef<string[]>([])
  const frameRef = useRef<number | null>(null)
  const sessionId = useStore((s) => s.sessionId)

  useEffect(() => {
    const svg = glowRef.current
    if (!svg) return
    const layer = createLightLayer(svg, { hitClass: 'cl-hit', hitMs: RAIL_HIT_MS })
    layerRef.current = layer
    return () => {
      layer.destroy()
      layerRef.current = null
    }
  }, [])

  /** 判断 id → 支持它的模型：与右栏分桶同一份 argmap，不另算一次「谁认账」 */
  const agentsOf = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const n of [...held, ...contested, ...argmap.byBucket.settled, ...argmap.byBucket.vacated]) {
      map.set(n.id, n.agents)
    }
    return map
  }, [held, contested, argmap])

  const heldIds = useMemo(() => held.map((n) => n.id), [held])
  useEffect(() => {
    const snap: RailSnap = { sid: sessionId, replay, ids: heldIds }
    const prev = snapRef.current
    const fresh = diffRailPoints(prev, snap)
    /*
     * 基准必须同步推进：它就是「上一帧」，晚一步记，下一次比较会拿自己跟自己比。
     */
    snapRef.current = snap
    /*
     * 待发的光单独排队，不能只挂在这一次的帧上。
     * 这一帧还没跑，effect 就可能因为别的依赖（agentsOf / models）重跑一次，
     * 清理函数会把帧取消 —— 若那几束光只存在于这一帧的闭包里，它们就一声不响地没了。
     * 队列活过取消，下一帧照发。
     */
    if (fresh.length) {
      const seen = new Set(pendingRef.current)
      for (const id of fresh) if (!seen.has(id)) pendingRef.current.push(id)
    }
    if (!pendingRef.current.length) return
    if (frameRef.current !== null) return

    const raf = window.requestAnimationFrame(() => {
      frameRef.current = null
      const ids = pendingRef.current
      pendingRef.current = []
      const svg = glowRef.current
      const layer = layerRef.current
      if (!svg || !layer) return
      const base = svg.getBoundingClientRect()
      if (base.width < 1 || base.height < 1) return
      /*
       * 两条可见性口径，不能合并：
       * - `visible` 只按整栏的纵向范围判，用于起点锚点（模型车道、中央阶段卡）——
       *   它们在中央栏，横向根本不在右栏里，量横向会把每一条都判掉。
       * - `inRail` 按真正裁切卡片的那一层判。`.cl-rail-scroll` 是 overflow:auto，
       *   卡片滚到折线以下时相对整栏仍在范围内，按整栏判会照发不误，
       *   光飞到页签底下，用户看不到落点。
       */
      const visible = (r: DOMRect): boolean =>
        r.width > 0 && r.height > 0 && r.top < base.bottom && r.bottom > base.top
      const clipEl = scrollRef.current
      const clip = clipEl ? clipEl.getBoundingClientRect() : base
      const inRail = (r: DOMRect): boolean =>
        r.width > 0 && r.height > 0 && r.top < clip.bottom && r.bottom > clip.top

      /*
       * 先定位再发光：新判断落在折线以下时，把那一层滚到它跟前，光才有地方可落。
       *
       * 定位目标是**最新那一张**（`ids` 末位，渲染顺序即新旧），不是这一批的并集：
       * 一次推进可能带回两三条，右栏只有一屏高，并集根本装不下 ——
       * 对齐并集顶部会把最新那张压在折线下，而那正是用户要看的落点。
       * 宁可只保证最新的那张可见，也不假装整批都在屏幕上。
       *
       * 要循环补差，不能只算一次：卡片挂上来那一帧，上方内容的高度可能还在变，
       * 按第一帧的矩形滚完会差几十像素。每轮重新量、只补差，最多三轮。
       */
      const newestId = ids[ids.length - 1]
      const newestEl = newestId ? document.querySelector(`[data-cl-point="${newestId}"]`) : null
      if (clipEl && newestEl) {
        for (let pass = 0; pass < 3; pass++) {
          const r = newestEl.getBoundingClientRect()
          if (r.height <= 0) break
          const delta = revealDelta({ top: clip.top, bottom: clip.bottom }, r)
          if (!delta) break
          clipEl.scrollTop += delta
        }
      }

      let budget = RAIL_FLIGHT_MAX
      for (const id of ids) {
        if (budget <= 0) break
        const toEl = document.querySelector(`[data-cl-point="${id}"]`)
        if (!toEl) continue
        const tr = toEl.getBoundingClientRect()
        if (!inRail(tr)) continue

        /*
         * 起点取头像的右缘、落点取卡片左缘：取中心会让光横穿整张卡，
         * 「从哪来、落到哪」反而读不出来（中央那三条光同一套口径）。
         */
        const sources: Source[] = []
        for (const agentId of (agentsOf.get(id) ?? []).slice(0, RAIL_SOURCES_MAX)) {
          const lane = document.querySelector(`[data-cl-lane="${agentId}"]`)
          if (!lane) continue
          const av = lane.querySelector('.cl-chip-av') ?? lane
          const ar = av.getBoundingClientRect()
          if (!visible(ar)) continue
          sources.push({
            key: `model:${agentId}`,
            x: ar.right - base.left - 2,
            y: ar.top + ar.height / 2 - base.top,
            color: models.find((m) => m.id === agentId)?.color ?? 'var(--cl-accent)',
          })
        }
        /*
         * 一行车道都没有（协作视图 / 台账 / 车道被滚出视野）时退回「共识发现」那张卡：
         * 那一段确实跑完了，光仍说得通。两者都不在就不发 —— 不发一条没有起点的光。
         */
        if (!sources.length) {
          const stageEl = document.querySelector('[data-cl-stage="2"]')
          if (stageEl) {
            const sr = stageEl.getBoundingClientRect()
            if (visible(sr)) {
              sources.push({
                key: 'stage:2',
                x: sr.right - base.left - 4,
                y: sr.top + sr.height / 2 - base.top,
                color: 'var(--cl-accent)',
              })
            }
          }
        }

        for (const s of sources) {
          if (budget-- <= 0) break
          layer.emit({
            eventId: `rail:${replay === null ? 'live' : `r${replay}`}:${id}:${s.key}`,
            fromId: s.key,
            toId: `point:${id}`,
            from: { x: s.x, y: s.y },
            to: { x: tr.left - base.left + 3, y: tr.top + tr.height / 2 - base.top },
            color: s.color,
            durationMs: 1000,
            /*
             * 这一束横跨整屏（实测 835px）：按工作台那套 1.1px 画，屏幕上就是一道
             * 几乎看不见的划痕。加粗到 2.2 倍，它才像「一束光指过去」。
             */
            weight: 2.2,
            targetEl: toEl,
          })
        }
      }
    })
    return () => {
      window.cancelAnimationFrame(raf)
      frameRef.current = null
    }
  }, [agentsOf, heldIds, models, replay, sessionId])
  return (
    <aside className="cl-rail">
      <header className="cl-rail-head">
        {view === 'ledger' ? (
          <>
            <button className="cl-icon-btn" onClick={() => setRailView('insight')} title="回到共识洞察">
              <ArrowLeft size={13} />
            </button>
            <span className="cl-rail-title">
              <ListTree size={13} />
              完整台账
            </span>
          </>
        ) : (
          <>
            <span className="cl-rail-title">
              <Radar size={13} />
              共识洞察
            </span>
            <span className="cl-rail-badge">
              <i />
              {replay !== null ? `回放至 R${replay}` : live ? '实时更新' : '已收束'}
            </span>
          </>
        )}
      </header>

      {view === 'ledger' ? (
        <RightPanel models={models} />
      ) : (
        <>
          <div className="cl-rail-scroll" ref={scrollRef}>
            {view === 'insight' && (
              <>
                <section className="cl-insight">
                  <div className="cl-insight-top">
                    <div className="cl-ring">
                      <svg viewBox="0 0 78 78">
                        <defs>
                          <linearGradient id="cl-ring-grad" x1="0" y1="0" x2="1" y2="1">
                            <stop offset="0%" stopColor="var(--cl-accent)" />
                            <stop offset="100%" stopColor="var(--cl-accent-2)" />
                          </linearGradient>
                        </defs>
                        <circle className="cl-ring-track" cx="39" cy="39" r="30" />
                        <circle
                          className="cl-ring-val"
                          cx="39"
                          cy="39"
                          r="30"
                          strokeDasharray={ringLen}
                          strokeDashoffset={ringLen * (1 - heldRatio)}
                        />
                      </svg>
                      <div className="cl-ring-num">
                        <b>{String(held.length).padStart(2, '0')}</b>
                        <span>共识观点</span>
                      </div>
                    </div>
                    <div className="cl-insight-lead">
                      {lead ? (
                        <>
                          {excerpt(lead.claim, 120)}
                          {lead.agents.length > 0 && (
                            <i>
                              {' '}
                              · {lead.agents.length}/{participantIds.length} 家认账
                            </i>
                          )}
                        </>
                      ) : (
                        <i>还没有形成可认账的判断。等第一轮小结落回来。</i>
                      )}
                    </div>
                  </div>
                  <div className="cl-stats">
                    <div className="cl-stat ok">
                      <b className={fullSupport.length === 0 ? 'zero' : undefined}>{fullSupport.length}</b>
                      <span>共同支持</span>
                    </div>
                    <div className="cl-stat warn">
                      <b className={partialSupport.length === 0 ? 'zero' : undefined}>{partialSupport.length}</b>
                      <span>部分支持</span>
                    </div>
                    <div className="cl-stat bad">
                      <b className={contested.length === 0 ? 'zero' : undefined}>{contested.length}</b>
                      <span>存在分歧</span>
                    </div>
                  </div>
                </section>

                <div className="cl-sec-head">
                  <b>核心共识观点</b>
                  <span className="cl-sec-n">{held.length}</span>
                  <button onClick={() => setRailView('ledger')}>完整台账 →</button>
                </div>

                {held.length === 0 ? (
                  <div className="cl-empty">还没有立住的判断。质询与归并都写在台账里。</div>
                ) : (
                  held.map((node, i) => (
                    <PointCard
                      key={node.id}
                      node={node}
                      idx={i + 1}
                      open={open === node.id}
                      focused={focus?.kind === 'claim' && focus.id === node.id}
                      onToggle={() => toggle(node.id)}
                      participantTotal={participantIds.length}
                      nameOf={nameOf}
                      modelOf={modelOf}
                      uttById={uttById}
                      onEvidence={(id) =>
                        setFocus(focus?.kind === 'utt' && focus.id === id ? null : { kind: 'utt', id })
                      }
                    />
                  ))
                )}

                <div className="cl-sec-head">
                  <b>未解决的争议</b>
                  <span className="cl-sec-n">{contested.filter((n) => n.kind === 'dispute').length}</span>
                </div>
                {contested.filter((n) => n.kind === 'dispute').length === 0 ? (
                  <div className="cl-empty">没有悬而未决的分歧。</div>
                ) : (
                  contested
                    .filter((n) => n.kind === 'dispute')
                    .map((node) => (
                      <div key={node.id} className="cl-dispute">
                        <div className="cl-dispute-q">{excerpt(node.claim, 120)}</div>
                        <div className="cl-dispute-sides">
                          {(node.sides ?? []).map((s) => (
                            <span key={s.agentId} className="cl-side" title={excerpt(s.argument, 160)}>
                              <i style={{ background: modelOf(s.agentId)?.color ?? 'var(--cl-text-3)' }} />
                              {nameOf(s.agentId)}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))
                )}
              </>
            )}

            {view === 'verify' && (
              <>
                <div className="cl-sec-head">
                  <b>核验与质询</b>
                  <span className="cl-sec-n">{corrections.length} 次答复</span>
                </div>
                {corrections.length === 0 ? (
                  <div className="cl-empty">本场还没有发出过定向质询。</div>
                ) : (
                  corrections.map((c) => (
                    <div key={c.id} className="cl-dispute">
                      <div className="cl-dispute-q">
                        R{c.round} · {nameOf(c.agentId)} · {c.issue}
                      </div>
                      <div className="cl-ev-text">{excerpt(c.question, 120)}</div>
                      <div className="cl-dispute-sides">
                        <span className="cl-side">
                          <i style={{ background: 'var(--cl-ok)' }} />
                          {c.outcome}
                          {c.addedEvidenceRef.length > 0 && ` · 补依据 ${c.addedEvidenceRef.length}`}
                          {c.removedSupport.length > 0 && ` · 移出支持 ${c.removedSupport.length}`}
                        </span>
                      </div>
                    </div>
                  ))
                )}

                <div className="cl-sec-head">
                  <b>还开着的分歧</b>
                  <span className="cl-sec-n">{contested.filter((n) => n.kind === 'dispute').length}</span>
                </div>
                {contested
                  .filter((n) => n.kind === 'dispute')
                  .map((node) => (
                    <div key={node.id} className="cl-dispute">
                      <div className="cl-dispute-q">{excerpt(node.claim, 140)}</div>
                      {node.lastProgress && <div className="cl-ev-text">{node.lastProgress}</div>}
                      <div className="cl-dispute-sides">
                        {(node.sides ?? []).map((s) => (
                          <span key={s.agentId} className="cl-side" title={excerpt(s.argument, 160)}>
                            <i style={{ background: modelOf(s.agentId)?.color ?? 'var(--cl-text-3)' }} />
                            {nameOf(s.agentId)}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                {contested.filter((n) => n.kind === 'dispute').length === 0 && (
                  <div className="cl-empty">没有悬而未决的分歧。</div>
                )}
              </>
            )}

            {view === 'run' && (
              <>
                <div className="cl-sec-head">
                  <b>逐段耗时</b>
                  <span className="cl-sec-n">{stageTimings.length}</span>
                </div>
                {stageTimings.length === 0 ? (
                  <div className="cl-empty">还没有记录到阶段耗时。</div>
                ) : (
                  stageTimings.map((t, i) => (
                    <div key={`${t.round}-${t.stage}-${i}`} className="cl-kv">
                      <span>
                        R{t.round} · {t.stage}
                        {t.summary && <em style={{ fontStyle: 'normal', color: 'var(--cl-text-3)' }}> · {t.summary}</em>}
                      </span>
                      <span>{fmtSpan(t.durationMs)}</span>
                    </div>
                  ))
                )}

                {convergenceNote && (
                  <>
                    <div className="cl-sec-head">
                      <b>收敛判定</b>
                      <span className="cl-sec-n">R{convergenceNote.round}</span>
                    </div>
                    <div className="cl-dispute">
                      <div className="cl-dispute-q">{convergenceNote.text}</div>
                    </div>
                  </>
                )}

                <div className="cl-sec-head">
                  <b>主持小结审计</b>
                  <span className="cl-sec-n">{moderatorAudit.length}</span>
                </div>
                {moderatorAudit.length === 0 ? (
                  <div className="cl-empty">没有需要记下的拒收或改判。</div>
                ) : (
                  moderatorAudit.map((a, i) => (
                    <div key={i} className="cl-kv">
                      <span>
                        R{a.round} · {a.accepted ? '已接受' : '被拒收'} · {a.attempts.length} 次尝试
                        {a.unknownAliases.length > 0 && ` · 未登记别名 ${a.unknownAliases.length}`}
                        {a.leakedRealIds.length > 0 && ` · 匿名外泄 ${a.leakedRealIds.length}`}
                      </span>
                      <span>{a.accepted ? 'ok' : 'reject'}</span>
                    </div>
                  ))
                )}
              </>
            )}

            {view === 'cost' && (
              <>
                <div className="cl-sec-head">
                  <b>本场花费</b>
                  <span className="cl-sec-n">R{Math.max(round, 0)}</span>
                </div>
                <div className="cl-insight">
                  <div className="cl-stats" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <div className="cl-stat">
                      <b>{fmtUsd(spentUsd)}</b>
                      <span>已花</span>
                    </div>
                    <div className="cl-stat">
                      <b>{budgetLimitUsd.toFixed(2)}</b>
                      <span>预算上限</span>
                    </div>
                  </div>
                  <div className="cl-bar">
                    <i style={{ width: `${Math.min(100, (spentUsd / Math.max(budgetLimitUsd, 0.01)) * 100)}%` }} />
                  </div>
                </div>

                <div className="cl-sec-head">
                  <b>按模型</b>
                  <span className="cl-sec-n">{perModelCost.length}</span>
                </div>
                {perModelCost.length === 0 ? (
                  <div className="cl-empty">网页模型不计费；这一场还没有可折算的花销。</div>
                ) : (
                  perModelCost.map(([id, usd]) => (
                    <div key={id} className="cl-kv">
                      <span>{nameOf(id)}</span>
                      <span>{fmtUsd(usd)}</span>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
          {/*
            光线层：铺满右栏、不吃鼠标。坐标以它左上角为原点 ——
            起点是中央那张阶段卡，落在这一栏之外，所以必须 overflow: visible。
          */}
          <svg className="cl-rail-glow" ref={glowRef} aria-hidden="true" />

          <nav className="cl-rail-tabs">
            {RAIL_TABS.map((t) => {
              const Ico = t.icon
              return (
                <button
                  key={t.key}
                  className={`cl-rail-tab${view === t.key ? ' active' : ''}`}
                  onClick={() => setRailView(t.key)}
                >
                  <Ico size={13} />
                  {t.label}
                </button>
              )
            })}
          </nav>
        </>
      )}
    </aside>
  )
}

function PointCard({
  node,
  idx,
  open,
  focused,
  onToggle,
  participantTotal,
  nameOf,
  modelOf,
  uttById,
  onEvidence,
}: {
  node: ArgNode
  idx: number
  open: boolean
  focused: boolean
  onToggle: () => void
  participantTotal: number
  nameOf: (id: string) => string
  modelOf: (id: string) => ModelSummary | undefined
  uttById: Map<string, { id: string; round: number; agentId: string; content: string; human?: boolean }>
  onEvidence: (id: string) => void
}) {
  const tone = BUCKET_TONE[node.bucket]
  const full = node.agents.length >= Math.max(1, Math.ceil(participantTotal / 2))

  return (
    <article
      data-cl-point={node.id}
      className={`cl-point${open ? ' open' : ''}${focused ? ' focus' : ''}`}
    >
      <button className="cl-point-btn" onClick={onToggle} aria-expanded={open}>
        <div className="cl-point-top">
          <span className="cl-point-idx">{String(idx).padStart(2, '0')}</span>
          <span className={`cl-point-tag ${full ? 'ok' : 'warn'}`}>{full ? '共同支持' : '部分支持'}</span>
          {node.verify && node.verify !== 'verified' && (
            <span className={`cl-point-tag ${node.verify === 'vacated' ? 'bad' : 'muted'}`}>
              {node.verify === 'vacated'
                ? '无人认领'
                : node.verify === 'disputed'
                  ? '有争议'
                  : '未核验'}
            </span>
          )}
          <span className="cl-point-chev">
            <ChevronDown size={12} />
          </span>
        </div>
        <div className="cl-point-claim">{node.claim}</div>
        <div className="cl-point-foot">
          <span className="cl-avs">
            {node.agents.slice(0, 5).map((id) => {
              const m = modelOf(id)
              return (
                <span key={id} className="cl-av" style={{ background: m?.color ?? 'var(--cl-text-3)' }} title={nameOf(id)}>
                  {m ? <ModelAvatar model={m} fill fontSize={7} /> : null}
                </span>
              )
            })}
          </span>
          <span>
            {node.agents.length}/{participantTotal} 模型支持
          </span>
          <span>· 依据 {node.evidence.length}</span>
          {node.missingEvidence > 0 && <span style={{ color: 'var(--cl-warn)' }}>· 查不到 {node.missingEvidence}</span>}
          {node.rounds && (
            <span>
              · R{node.rounds.from}
              {node.rounds.to !== node.rounds.from ? `–R${node.rounds.to}` : ''}
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="cl-point-body">
          <div className="cl-ev-cap">
            <b>证据溯源</b>
            <span>
              {node.evidence.length > 0 ? `${node.evidence.length} 条原文` : '没有可回查的原文'}
              {node.humanCount > 0 && ` · 含人工 ${node.humanCount}`}
            </span>
          </div>

          {node.evidence.length === 0 ? (
            <div className="cl-ev-empty">
              这条判断引用的发言不在本场记录里 —— {ARG_BUCKET_HINT[node.bucket]}。点开台账可以看核验结论。
            </div>
          ) : (
            node.evidence.map((ev) => {
              const u = uttById.get(ev.utteranceId)
              const m = modelOf(ev.agentId)
              return (
                <button key={ev.utteranceId} className="cl-ev" onClick={() => onEvidence(ev.utteranceId)}>
                  <span className="cl-ev-av" style={{ background: m?.color ?? 'var(--cl-text-3)' }}>
                    {m ? <ModelAvatar model={m} fill fontSize={7} /> : null}
                  </span>
                  <span className="cl-ev-main">
                    <span className="cl-ev-head">
                      <b>{nameOf(ev.agentId)}</b>
                      <span>R{ev.round}</span>
                      {ev.human && <span>· 人工</span>}
                    </span>
                    <span className="cl-ev-text">
                      {u ? excerpt(u.content, 180) : '这条发言已不在本场记录里'}
                    </span>
                  </span>
                </button>
              )
            })
          )}

          {node.missingEvidence > 0 && (
            <div className="cl-ev-miss">另有 {node.missingEvidence} 条引用查不到原文，未画进依据。</div>
          )}

          {node.variants.length > 0 && (
            <>
              <div className="cl-ev-cap">
                <b>跨轮归并掉的措辞</b>
                <span>{node.variants.length}</span>
              </div>
              <div className="cl-variants">
                {node.variants.map((v, i) => (
                  <span key={i} className="cl-variant">
                    {excerpt(v, 120)}
                  </span>
                ))}
              </div>
            </>
          )}

          <div className="cl-ev-cap">
            <b>状态</b>
            <span>
              {ARG_BUCKET_HINT[node.bucket]}
              {node.confidence !== null && ` · 主持自评 ${Math.round(node.confidence * 100)}%`}
              {node.weight !== null && ` · 证据硬度 ${Math.round(node.weight * 100)}%`}
            </span>
          </div>
        </div>
      )}
    </article>
  )
}
