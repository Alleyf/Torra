import { useMemo } from 'react'
import { useStore, type ModelSummary } from '../store'
import { ARG_BUCKET_HINT, ARG_BUCKET_LABEL, ARG_BUCKET_TONE, buildArgumentMap } from '@shared/argmap'
import { ConsensusPanel, revealFocusedClaim } from './ConsensusPanel'
import { Markdown } from './Markdown'
import { digestStrips, fmtSpan, fmtUsd, roundStats } from '../discussionDerived'
import { formatSpeech, mdExcerpt } from '../textFormat'
import { Activity, AlertTriangle, ArrowDown, MessageCircle, ShieldAlert, Swords } from 'lucide-react'
import '../roundband.css'

/**
 * 研讨屏右栏：聚焦 + 这场怎么跑的（抽屉）+ 结论台账。
 *
 * 原先这里是「论题演化 / 论证地图 / 结论台账」三屏。F4 把前两者收进正文那张图：
 * 落点就是结论轴上的点，依据关系靠点亮讲，不再另开一屏重排同一批判断。
 * 台账留在原位 —— 它是这批判断唯一的可读全文，图上只给点位与跨轮。
 * 运行时/待核/轮次原来各占一屏，把成本和大号分数顶在用户第一眼的位置，
 * 于是这一栏看着像流水账、不像结论：现在它们收进一个抽屉，标题让给台账。
 *
 * 聚焦状态挂在 store（见 FocusRef）：正文点落点要在这里讲它，这里点落点要把正文
 * 那几条依据亮起来 —— 放在任一側的组件里，另一跳就丢。
 */
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
  const setPendingFollowup = useStore((s) => s.setPendingFollowup)

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const colorOf = (id: string) => models.find((m) => m.id === id)?.color ?? 'var(--rb-quiet)'

  const argmap = useMemo(
    () => buildArgumentMap({ consensus, disputes, utterances }),
    [consensus, disputes, utterances],
  )
  const stats = useMemo(() => roundStats(utterances, moderatorAudit), [utterances, moderatorAudit])
  const strips = useMemo(() => digestStrips(moderatorAudit), [moderatorAudit])

  const focusUtt = focus?.kind === 'utt' ? utterances.find((u) => u.id === focus.id) : undefined
  const focusClaim = focus?.kind === 'claim' ? argmap.nodes.find((n) => n.id === focus.id) : undefined
  /** 被引用次数：这条发言成了几条判断的依据 */
  const citedBy = (id: string) => argmap.nodes.filter((n) => n.evidence.some((e) => e.utteranceId === id)).length

  /**
   * 协作贡献：每家有几条判断是拿它的话立起来的。
   * 同一家在同一判断里说几次都只算一条 —— 这里量的是「撑住了几条结论」，不是话量；
   * 一家刷了五轮没人接，另一家一句话被三条判断引用，在这本账上是后者重。
   * 只算依据里查得到原文的（missingEvidence 那几条不认，免得把幻觉记成分量）。
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

  /**
   * 指针要报得出全文在哪一格。编号跟台账左上角 .cs-idx 同一个算法：关键判断按全量
   * 顺序编号，分歧不编号，就报它所在的段（已消解那批压在折叠里，打开由台账负责）。
   */
  const ledgerWhere = !focusClaim
    ? ''
    : focusClaim.kind === 'consensus'
      ? `台账第 ${String(consensus.findIndex((c) => c.id === focusClaim.id) + 1).padStart(2, '0')} 条`
      : focusClaim.bucket === 'settled'
        ? '台账「已消解」里这一条'
        : '台账「保留分歧」里这一条'

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

  return (
    <div className="rb-aside">
      <div className="rb-aside-scroll">
        {/* ── 聚焦 ── */}
        <section className="rb-sec">
          <h4>聚焦</h4>
          {!focus && (
            <p className="rb-muted">
              点图上任一节点或结论轴上的落点，这里就讲它：谁说的、代价多少、依据查不查得到、能对它做什么。
            </p>
          )}

          {focusUtt && (
            <>
              <div className="rb-who" style={{ ['--k' as string]: colorOf(focusUtt.agentId) }}>
                <i className="rb-dot" />
                <b>{nameOf(focusUtt.agentId)}</b>
                <span className="rb-sub">第 {focusUtt.round} 轮</span>
              </div>
              {focusUtt.targets.length > 0 && (
                <p className="rb-sub">回应 {focusUtt.targets.map((t) => labelOf(utterances, models, t)).join('、')}</p>
              )}
              {/*
                全文只在这一份：正文锁定后收成一行指针，读长文的地方就是这里 ——
                中栏窄、卡内 240px 自己滚，都不适合把上千字的发言读完。
              */}
              <div className="rb-speech" style={{ ['--k' as string]: colorOf(focusUtt.agentId) }}>
                <Markdown text={formatSpeech(focusUtt.content)} />
              </div>
              <div className="rb-kv">
                <span>成了几条判断的依据</span>
                <span className="rb-num">{citedBy(focusUtt.id)}</span>
              </div>
              <div className="rb-kv">
                <span>代价</span>
                <span className="rb-num">
                  {focusUtt.startedAt && focusUtt.endedAt ? fmtSpan(focusUtt.endedAt - focusUtt.startedAt) : '—'} ·{' '}
                  {fmtUsd(focusUtt.usage?.costUsd ?? 0)}
                </span>
              </div>
              {focusUtt.citations && !focusUtt.citations.noCitations && (
                <div className="rb-kv">
                  <span>程序核验引用</span>
                  <span className={`rb-num${bogusCount(focusUtt) ? ' bad' : ''}`}>
                    {focusUtt.citations.validUtteranceIds.length} 条可核对
                    {bogusCount(focusUtt) > 0 && ` · ${bogusCount(focusUtt)} 条无来源`}
                  </span>
                </div>
              )}
              <div className="rb-acts">
                <button
                  type="button"
                  className="rb-btn pri"
                  onClick={() =>
                    setPendingFollowup({
                      agentId: focusUtt.agentId,
                      utteranceId: focusUtt.id,
                      topic: focusUtt.content.slice(0, 60),
                      kind: 'followup',
                    })
                  }
                >
                  <MessageCircle size={11} /> 追问 {nameOf(focusUtt.agentId)}
                </button>
                {disputes[0] && (
                  <button
                    type="button"
                    className="rb-btn"
                    onClick={() =>
                      setPendingFollowup({
                        agentId: focusUtt.agentId,
                        utteranceId: '',
                        topic: disputes[0]!.claim,
                        kind: 'duel',
                      })
                    }
                  >
                    <Swords size={11} /> 就 ⊘ 对辩
                  </button>
                )}
              </div>
            </>
          )}

          {focusClaim && (
            <>
              {/*
                结论在这一格只到「认得出是哪一条」：全文、有多硬、谁认账，台账那一条
                只有一份 —— 与发言那侧「正文收指针 / 全文在右栏」是同一条分工。
                所以这里不截断也不铺满，就是一张名片加一个指路按钮。
              */}
              <div className="rb-pin">
                <div className="rb-pin-kind">
                  <span className={`cs-badge tone-${ARG_BUCKET_TONE[focusClaim.bucket]}`} title={ARG_BUCKET_HINT[focusClaim.bucket]}>
                    {ARG_BUCKET_LABEL[focusClaim.bucket]}
                  </span>
                  <span className="rb-pin-who">
                    {focusClaim.kind === 'dispute'
                      ? `${focusClaim.agents.length} 方在争`
                      : `${focusClaim.modelCount} 家认账`}
                    {focusClaim.humanCount > 0 && ` · 人工 ${focusClaim.humanCount} 条`}
                  </span>
                </div>
                <p className="rb-pin-claim">{mdExcerpt(focusClaim.claim, 64)}</p>
                <p className="rb-pin-facts">
                  依据 {focusClaim.evidence.length} 条
                  {focusClaim.missingEvidence > 0 && (
                    <>
                      {' · '}
                      <span className="rb-num bad">{focusClaim.missingEvidence} 条查不到原文</span>
                    </>
                  )}
                </p>
                <div className="rb-acts">
                  <button type="button" className="rb-btn pri" onClick={revealFocusedClaim}>
                    <ArrowDown size={11} /> {ledgerWhere}
                  </button>
                  {focusClaim.bucket === 'contested' && focusClaim.agents.length > 0 && (
                    <button
                      type="button"
                      className="rb-btn"
                      onClick={() =>
                        setPendingFollowup({
                          agentId: focusClaim.agents[0]!,
                          utteranceId: '',
                          topic: focusClaim.claim,
                          kind: 'duel',
                        })
                      }
                    >
                      <Swords size={11} /> 就这条发起对辩
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          {focus && !focusUtt && !focusClaim && (
            <p className="rb-muted">这条聚焦的对象已经不在这场讨论里了。</p>
          )}
        </section>

        {/*
          这场怎么跑的：成本、通道、逐轮花销、待核、协作贡献，全部收进一个抽屉。
          它们回答的是「这场讨论花了什么、谁在出力、哪儿查不到原文」，不是「留下了什么」
          —— 后者才是这一栏的主角，已经在下面的台账里逐条写着。参数摊开在最上面时，
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

            {/*
              协作贡献：谁的发言真的成了判断的依据。研讨的产出不是谁赢了，
              是这些被引用出来的支撑 —— 一条没人引用的长发言和三条被接住短发言，
              在这本账上不是同一个分量。
            */}
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
              <p className="rb-sub">轮次 · {maxRounds} 轮 · 分数线 {consensusThreshold}</p>
              {Array.from({ length: maxRounds }, (_, i) => i + 1).map((r) => {
                const sc = scores.find((x) => x.round === r)
                const st = stats.get(r)
                const dg = strips.get(r)
                const off = !sc
                return (
                  <div className={`rb-rd${off ? ' off' : ''}`} key={r}>
                    <span className="rb-rl">R{r}</span>
                    <span className="rb-rt">
                      <i
                        className={sc ? (sc.score >= consensusThreshold ? 'hit' : r === scores.length ? 'now' : '') : ''}
                        style={{ width: sc ? `${Math.round(Math.min(1, sc.score / consensusThreshold) * 100)}%` : 0 }}
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
                  最后一轮 {scores[scores.length - 1]!.score.toFixed(1)}，分数线 {consensusThreshold} ——
                  要不要就此收口，看的是这条线还差多少，不是「跑了挺久了」。分数低只说明还没收住，
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
                      <span className="rb-issue-text">
                        {nameOf(p.u.agentId)} · R{p.u.round} 有 {bogusCount(p.u)} 处凭空引用
                      </span>
                      <button
                        type="button"
                        className="rb-link"
                        onClick={() =>
                          setPendingFollowup({
                            agentId: p.u.agentId,
                            utteranceId: p.u.id,
                            topic: '你引用的内容在本场查不到原文，请给出真实来源或撤回',
                            kind: 'followup',
                          })
                        }
                      >
                        要求补来源
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        </details>

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
      </div>
    </div>
  )
}

function bogusCount(u: { citations?: { bogusUtteranceIds: string[]; outOfRangeRounds: number[]; unknownLabels: string[] } }): number {
  const c = u.citations
  if (!c) return 0
  return c.bogusUtteranceIds.length + c.outOfRangeRounds.length + c.unknownLabels.length
}

/** 引用 id → 「谁 · 第几轮」，右栏不印裸 id */
function labelOf(
  utterances: { id: string; agentId: string; round: number; human?: boolean }[],
  models: ModelSummary[],
  id: string,
) {
  const t = utterances.find((x) => x.id === id)
  if (!t) return id
  const name = t.human ? '人类' : models.find((m) => m.id === t.agentId)?.displayName ?? t.agentId
  return `${name} · R${t.round}`
}

