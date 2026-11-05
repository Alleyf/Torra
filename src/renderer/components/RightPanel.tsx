/**
 * 研讨屏右栏：此刻 + 结论台账 + 这场怎么跑的（抽屉）。
 *
 * 原先这里是「论题演化 / 论证地图 / 结论台账」三屏。F4 把前两者收进正文那张图：
 * 落点就是结论轴上的点，依据关系靠点亮讲，不再另开一屏重排同一批判断。
 * 台账留在原位 —— 它是这批判断唯一的可读全文，图上只给点位与跨轮。
 *
 * 顺序是「此刻 → 台账 → 跑动」：
 * - 此刻讲中间区正在讲的那一条，指针在图上扫过它就跟过去，这是右栏与正文唯一的联动面；
 * - 台账讲这场留下了什么，是这一栏的主角；
 * - 跑动（成本、通道、逐轮花销、待核、协作贡献）收进一个抽屉 —— 参数摊开在最上面时，
 *   用户第一眼读到的是花费和分数，正是把研讨读成考试的那种错位。
 *
 * 聚焦状态挂在 store（见 FocusRef）：正文点落点要在这里讲它，这里点落点要把正文
 * 那几条依据亮起来 —— 放在任一側的组件里，另一跳就丢。
 * 指针悬停也挂 store（hover），理由同上：中间区与右栏是两个组件树。
 */
import { useMemo } from 'react'
import { useStore, type ModelSummary } from '../store'
import { buildArgumentMap } from '@shared/argmap'
import { ConsensusPanel } from './ConsensusPanel'
import { NowCard } from './NowCard'
import { digestStrips, fmtSpan, fmtUsd, roundStats } from '../discussionDerived'
import { Activity, AlertTriangle, ShieldAlert } from 'lucide-react'
import '../roundband.css'

export function RightPanel({ models }: { models: ModelSummary[] }) {
  const utterances = useStore((s) => s.utterances)
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const scores = useStore((s) => s.scores)
  const focus = useStore((s) => s.focus)
  const setFocus = useStore((s) => s.setFocus)
  const moderatorAudit = useStore((s) => s.moderatorAudit)
  const spentUsd = useStore((s) => s.spentUsd)
  const budgetLimitUsd = useStore((s) => s.budgetLimitUsd)
  const consensusThreshold = useStore((s) => s.consensusThreshold)
  const maxRounds = useStore((s) => s.maxRounds)
  const participantIds = useStore((s) => s.participantIds)

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const colorOf = (id: string) => models.find((m) => m.id === id)?.color ?? 'var(--rb-quiet)'

  const argmap = useMemo(
    () => buildArgumentMap({ consensus, disputes, utterances }),
    [consensus, disputes, utterances],
  )
  const stats = useMemo(() => roundStats(utterances, moderatorAudit), [utterances, moderatorAudit])
  const strips = useMemo(() => digestStrips(moderatorAudit), [moderatorAudit])

  const pending = useMemo(
    () => [
      ...argmap.nodes
        .filter((n) => n.missingEvidence > 0)
        .map((n) => ({ kind: 'claim' as const, n })),
      ...utterances
        .filter(
          (u) =>
            u.citations &&
            !u.citations.noCitations &&
            u.citations.bogusUtteranceIds.length + u.citations.outOfRangeRounds.length + u.citations.unknownLabels.length > 0,
        )
        .map((u) => ({ kind: 'utt' as const, u })),
    ],
    [argmap, utterances],
  )

  const webCount = participantIds.filter((id) => models.find((m) => m.id === id)?.transport === 'webview').length
  const totalMs = [...stats.values()].reduce((s, v) => s + v.ms, 0)

  /**
   * 协作贡献：谁的发言真的成了判断的依据。研讨的产出不是谁赢了，
   * 是这些被引用出来的支撑 —— 一条没人引用的长发言和三条被接住短发言，
   * 在这本账上不是同一个分量。
   */
  const contrib = useMemo(() => {
    const cited = new Map<string, number>()
    const spoken = new Map<string, number>()
    for (const u of utterances) {
      if (u.human) continue
      spoken.set(u.agentId, (spoken.get(u.agentId) ?? 0) + 1)
    }
    for (const n of argmap.nodes) {
      const once = new Set(n.evidence.filter((e) => !e.human).map((e) => e.agentId))
      for (const id of once) cited.set(id, (cited.get(id) ?? 0) + 1)
    }
    return [...spoken.keys()]
      .map((id) => ({ id, cited: cited.get(id) ?? 0, spoken: spoken.get(id) ?? 0 }))
      .sort((a, b) => b.cited - a.cited || b.spoken - a.spoken)
  }, [argmap, utterances])
  const contribMax = contrib.length > 0 ? Math.max(1, contrib[0]!.cited) : 1

  return (
    <div className="rb-aside">
      <div className="rb-aside-scroll">
        <NowCard models={models} />

        {/*
          结论台账：这批判断唯一的全文视图。图上只给点位与跨轮，这里给全文、
          认账的人、依据原文与核验状态。台账里的「定位」把正文那条发言点亮，
          正文的落点反过来让这里同一条描边 —— 一份数据，两处各有分工，不重复画一遍。
        */}
        <ConsensusPanel
          models={models}
          focusedId={focus?.kind === 'claim' ? focus.id : undefined}
          onLocate={(id) => setFocus(focus?.kind === 'utt' && focus.id === id ? null : { kind: 'utt', id })}
        />

        {/*
          这场怎么跑的：成本、通道、逐轮花销、待核、协作贡献，全部收进一个抽屉。
          它们回答的是「这场讨论花了什么、谁在出力、哪儿查不到原文」，不是「留下了什么」
          —— 后者才是这一栏的主角，已经在上面的台账里逐条写着。参数摊开在最上面时，
          用户第一眼读到的是花费和分数，正是把研讨读成考试的那种错位。
        */}
        <details className="rb-run">
          <summary className="rb-run-sum">
            <Activity size={12} />
            <span>这场怎么跑的</span>
            <span className="rb-run-brief">
              {fmtUsd(spentUsd)} · {participantIds.length} 家 ·{' '}
              {pending.length > 0 ? `${pending.length} 条待核` : '引用全部可核对'}
            </span>
          </summary>

          <div className="rb-run-body">
            <div className="rb-kv">
              <span>成本</span>
              <span className="rb-num">
                {fmtUsd(spentUsd)} / {budgetLimitUsd.toFixed(2)}
              </span>
            </div>
            <div className="rb-kv">
              <span>各轮耗时合计</span>
              <span className="rb-num" title="只算轮内的并行批：轮与轮之间的等待与主持另计">
                {fmtSpan(totalMs)}
              </span>
            </div>
            <div className="rb-kv">
              <span>通道</span>
              <span className="rb-num">
                {participantIds.length - webCount} 家 API
                {webCount > 0 && ` · ${webCount} 家网页不计费`}
              </span>
            </div>

            {contrib.length > 0 && (
              <div className="rb-contrib">
                <p className="rb-sub">谁的话成了判断的依据（同一条判断里同一人只算一次）</p>
                {contrib.map((c) => (
                  <div className="rb-contrib-row" key={c.id} style={{ ['--k' as string]: colorOf(c.id) }}>
                    <span className="rb-contrib-who">{nameOf(c.id)}</span>
                    <span className="rb-contrib-bar">
                      <i style={{ width: `${c.cited === 0 ? 0 : Math.round((c.cited / contribMax) * 100)}%` }} />
                    </span>
                    <span className={`rb-num${c.cited === 0 ? ' dim' : ''}`} title={`发言 ${c.spoken} 条`}>
                      {c.cited} 条
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="rb-rds">
              <p className="rb-sub">
                轮次 · {maxRounds} 轮 · 收束看未决分歧是否处置完
                {typeof consensusThreshold === 'number' ? `（当年分数线 ${consensusThreshold}）` : ''}
              </p>
              {Array.from({ length: maxRounds }, (_, i) => i + 1).map((r) => {
                const sc = scores.find((x) => x.round === r)
                const st = stats.get(r)
                const dg = strips.get(r)
                const off = !sc
                return (
                  <div className={`rb-rd${off ? ' off' : ''}${sc && r === scores.length ? ' now' : ''}`} key={r}>
                    <span className="rb-rl">R{r}</span>
                    <span className="rb-rt">
                      <i
                        className={sc && r === scores.length ? 'now' : ''}
                        style={{ width: sc ? `${Math.round(Math.min(1, sc.score / 100) * 100)}%` : 0 }}
                      />
                    </span>
                    <span className="rb-num">{sc ? sc.score.toFixed(1) : '—'}</span>
                    <span className="rb-num">{st && !st.unknown ? fmtSpan(st.ms) : '—'}</span>
                    <span className="rb-num" title={dg ? `小结：◈${dg.points} ⊘${dg.disputes} · 主持 ${fmtUsd(dg.costUsd)}` : '本轮小结的花费未计入了发言账'}>
                      {st ? fmtUsd(st.utteranceUsd + (dg?.costUsd ?? 0)) : '—'}
                    </span>
                  </div>
                )
              })}
              {scores.length > 0 && (
                <p className="rb-sub">
                  最后一轮 {scores[scores.length - 1]!.score.toFixed(1)} —— 这条线只是三维度加权的运行读数，
                  要不要就此收口看的是未决分歧还剩几条、交叉质询有没有发生。分数低只说明还没收住，
                  不说明这场没留下东西：留下的东西在台账里逐条记着。
                </p>
              )}
            </div>

            {pending.length > 0 && (
              <div className="rb-pending">
                <p className="rb-sub">待核 · 引用查不到原文</p>
                {pending.map((p, i) =>
                  p.kind === 'claim' ? (
                    <div className="rb-issue" key={`c-${p.n.id}`}>
                      <ShieldAlert size={11} />
                      <span className="rb-issue-text" title={p.n.claim}>
                        落点「{p.n.claim}」有 {p.n.missingEvidence} 条依据在本场发言里查不到原文
                      </span>
                      <button type="button" className="rb-link" onClick={() => setFocus({ kind: 'claim', id: p.n.id })}>
                        查看
                      </button>
                    </div>
                  ) : (
                    <div className="rb-issue" key={`${p.u.id}-${i}`}>
                      <AlertTriangle size={11} />
                      <span className="rb-issue-text" title={p.u.content}>
                        {nameOf(p.u.agentId)} 第 {p.u.round} 轮有 {bogusCount(p.u)} 处凭空引用
                      </span>
                      <button type="button" className="rb-link" onClick={() => setFocus({ kind: 'utt', id: p.u.id })}>
                        查看
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        </details>
      </div>
    </div>
  )
}

function bogusCount(u: { citations?: { bogusUtteranceIds: string[]; outOfRangeRounds: number[]; unknownLabels: string[] } }): number {
  const c = u.citations
  if (!c) return 0
  return c.bogusUtteranceIds.length + c.outOfRangeRounds.length + c.unknownLabels.length
}
