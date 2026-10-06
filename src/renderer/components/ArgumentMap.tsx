import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Activity, AlertTriangle, ChevronDown, ChevronRight, EyeOff, MapPin } from 'lucide-react'
import { useStore, type ModelSummary } from '../store'
import {
  ARG_BUCKETS,
  ARG_BUCKET_LABEL,
  buildArgumentMap,
  type ArgBucket,
  type ArgNode,
} from '@shared/argmap'
import type { ConsensusVerificationStatus } from '@shared/types'
import { getFaviconUrls, initials } from './ModelRail'
import { mdExcerpt, plainMd } from '../textFormat'
import '../argmap.css'

/**
 * 论证地图 —— 一个节点 = 一个判断，回答「现在剩下什么、凭什么剩下」。
 *
 * 与「结论台账」不是同一份东西的两种排版：台账按条目记账，地图按状态摆位置。
 * 这里唯一的真实连线是 判断 → 发言（数据里没有 claim 级的支持/反对边，
 * 所以不画跨卡曲线），因此「地图性」由轮次轴承担：每条判断的支撑发言
 * 分布在第几轮，就是它在轴上占的那一段 —— 一条横跨 5 轮的共识和当场立的共识
 * 不是一回事，这个差别只有轴能一眼看出来。
 *
 * 版面按信息量分三档，不是一律同款：
 *   lead 争议中 —— 只有它带双方论点原文，所以给它卡面、实色尺、15px 正文；
 *   std  已确认 —— 带 confidence / weight 两个数值，只留色尺不套盒；
 *   quiet 已消解 / 无人认领 —— 偶回事，收成窄带，点开才是一条一行。
 */

const VERIFY: Record<Exclude<ConsensusVerificationStatus, 'unverified'>, { text: string; tone: string; title: string }> = {
  verified: { text: '已核验', tone: 'ok', title: '每位声称支持者本人发言里都找得到原文' },
  disputed: { text: '有代答', tone: 'warn', title: '有人被主持代为表态，已在质询轮追问过' },
  vacated: { text: '无人认领', tone: 'bad', title: '质询后支持方归零；条目保留 —— 「被证明没人说过」也是一条结论' },
}

const COL_DESC: Record<ArgBucket, string> = {
  held: '有人认领、程序回查过的判断',
  contested: '还争着的：未决分歧，以及核验发现有争议的判断',
  settled: '带着依据消解的分歧',
  vacated: '质询后支持方归零 —— 这本身也是一条结论',
}

/** 轴上一段：这条判断的支撑发言覆盖了哪几轮 */
function segStyle(rounds: { from: number; to: number }, maxRound: number): CSSProperties {
  return {
    left: `${((rounds.from - 1) / maxRound) * 100}%`,
    width: `${((rounds.to - rounds.from + 1) / maxRound) * 100}%`,
  }
}

/** 有图标就只放图标，取不到退回首字母 */
function Dot({ model }: { model?: ModelSummary }) {
  const [i, setI] = useState(0)
  const urls = model ? getFaviconUrls(model.domain) : []
  if (!model || i >= urls.length) {
    return <span className="am-dot fb">{model ? initials(model.displayName).slice(0, 2) : '?'}</span>
  }
  return <img className="am-dot" src={urls[i]} alt="" title={model.displayName} crossOrigin="anonymous" onError={() => setI(i + 1)} />
}

function Rail({ bucket }: { bucket: ArgBucket }) {
  return <span className={`am-rail c-${bucket}`} aria-hidden="true" />
}

/** 两条细条分列：一个说「多少人认」，一个说「撑它的证据多硬」 */
function Bars({ n }: { n: ArgNode }) {
  const items: Array<{ k: string; cls: string; v: number; title: string }> = []
  if (n.confidence !== null) {
    items.push({ k: '普遍', cls: 'f-conf', v: n.confidence, title: 'confidence：主持自报的认同普遍程度，是估计值不是统计量' })
  }
  if (n.weight !== null) {
    items.push({ k: '硬度', cls: 'f-wt', v: n.weight, title: 'weight：支撑它的论据有多硬。与「普遍」分列 —— 高普遍低硬度就该怀疑' })
  }
  if (items.length === 0) return null
  return (
    <span className="am-bars">
      {items.map((it) => (
        <span className="am-bar" key={it.k} title={it.title}>
          <span className="am-bar-k">{it.k}</span>
          <span className="am-bar-track">
            <span className={`am-bar-fill ${it.cls}`} style={{ width: `${Math.round(it.v * 100)}%` }} />
          </span>
          <b>{Math.round(it.v * 100)}</b>
        </span>
      ))}
    </span>
  )
}

function NodeCard({
  n,
  tier,
  models,
  open,
  onToggle,
  nameOf,
  contentOf,
  onLocate,
}: {
  n: ArgNode
  tier: 'lead' | 'std' | 'quiet'
  models: ModelSummary[]
  open: boolean
  onToggle: () => void
  nameOf: (id: string) => string
  contentOf: (id: string) => { text: string; absent: boolean } | null
  onLocate: (id: string) => void
}) {
  const v = n.verify && n.verify !== 'unverified' ? VERIFY[n.verify as Exclude<ConsensusVerificationStatus, 'unverified'>] : null
  const modelOf = (id: string) => models.find((m) => m.id === id)

  return (
    <div className={`am-card t-${tier} c-${n.bucket}${open ? ' open' : ''}`}>
      <button className="am-head" onClick={onToggle} aria-expanded={open} title={plainMd(n.claim)}>
        <Rail bucket={n.bucket} />
        <span className="am-head-body">
          <span className="am-topline">
            <span className={`am-kind k-${n.kind}`}>{n.kind === 'dispute' ? '争点' : '共识'}</span>
            {n.agents.length > 0 ? (
              <span className="am-dots">
                {n.agents.slice(0, 5).map((a, k) => (
                  <Dot key={`${a}-${k}`} model={modelOf(a)} />
                ))}
                {n.agents.length > 5 && <span className="am-plus">+{n.agents.length - 5}</span>}
              </span>
            ) : (
              <span className="am-none-tag">无支持方</span>
            )}
          </span>

          <span className="am-claim">{open ? plainMd(n.claim) : plainMd(n.claim, tier === 'lead' ? 84 : 110)}</span>

          {tier === 'lead' && n.sides && (
            <span className="am-vs">
              {n.sides.map((s, k) => (
                <span className="am-side" key={`${s.agentId}-${k}`}>
                  <span className="am-side-who">
                    <Dot model={modelOf(s.agentId)} />
                    {nameOf(s.agentId)}
                  </span>
                  <span className="am-side-text">{plainMd(s.argument, 70) || '（没记下这一方的论点原文）'}</span>
                </span>
              ))}
            </span>
          )}

          <Bars n={n} />

          <span className="am-meta">
            {n.rounds ? (
              <span className="am-num" title={n.rounds.to > n.rounds.from ? '支撑它的发言分布在这几轮' : undefined}>
                R{n.rounds.from}
                {n.rounds.to > n.rounds.from ? `–${n.rounds.to}` : ''}
              </span>
            ) : (
              <span className="am-num">轮次不明</span>
            )}
            <span className="am-num">
              {n.modelCount} 家 · {n.evidence.length} 依据
              {n.humanCount > 0 && <span className="h-human"> · 人工 {n.humanCount}</span>}
            </span>
            {n.variants.length > 0 && (
              <span className="am-num" title="跨轮换说法的同一判断，已按内容并成一条">
                同判断 {n.variants.length + 1} 说
              </span>
            )}
            {v && (
              <span className={`am-flag f-${v.tone}`} title={v.title}>
                {v.text}
              </span>
            )}
            {n.bucket === 'settled' && (
              <span className="am-flag f-settled" title="带着依据消解：那条依据就列在下面">
                已消解
              </span>
            )}
            {n.missingEvidence > 0 && (
              <span className="am-flag f-bad" title={`主持引了 ${n.missingEvidence} 条本场不存在的发言，所以没算作依据`}>
                <AlertTriangle size={11} /> 查无 {n.missingEvidence}
              </span>
            )}
          </span>
        </span>
        <span className="am-caret">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      </button>

      {open && (
        <div className="am-open">
          {tier !== 'lead' && <p className="am-full">{plainMd(n.claim)}</p>}

          {n.sides && (!n.sides.every((s) => !s.argument) || tier === 'lead') && (
            <div className="am-side-row">
              <span className="am-sub-h">双方论点</span>
              {n.sides.map((s, k) => (
                <div className="am-side" key={`${s.agentId}-${k}`}>
                  <span className="am-who">
                    <Dot model={modelOf(s.agentId)} />
                    {nameOf(s.agentId)}
                  </span>
                  <span className="am-side-text">{plainMd(s.argument) || '（主持没记下这一方的论点原文）'}</span>
                </div>
              ))}
            </div>
          )}

          {n.lastProgress !== null && (
            <p className="am-progress">
              <Activity size={12} />
              最近进展：{n.lastProgress || '上一轮没有进展'}
            </p>
          )}

          {n.variants.length > 0 && (
            <div className="am-variants">
              <span className="am-sub-h">被并入的其他说法</span>
              {n.variants.map((t, k) => (
                <p className="am-variant" key={k}>
                  「{t}」
                </p>
              ))}
            </div>
          )}

          <span className="am-sub-h">
            依据 {n.evidence.length}
            {n.resolution && n.resolution.length > 0 && ' · 含消解依据'}
            {n.humanCount > 0 && <span className="am-human">人工介入不计入共识度</span>}
          </span>

          {n.evidence.length === 0 ? (
            <p className="am-none">没有可核对的原文依据 —— 报告与核验轮都按「未核对」处理它。</p>
          ) : (
            n.evidence.map((e) => {
              const u = contentOf(e.utteranceId)
              return (
                <div className="am-ev" key={e.utteranceId}>
                  <span className="am-who">
                    <Dot model={modelOf(e.agentId)} />
                    {e.human ? '人工' : nameOf(e.agentId)} · R{e.round}
                    {u?.absent ? ' · 缺席占位' : ''}
                  </span>
                  <span className="am-ev-text">
                    {u ? mdExcerpt(u.text, 150) || '（这条发言还没有正文）' : '（本场找不到这条发言的原文）'}
                  </span>
                  <button
                    className="btn icon sm am-locate"
                    onClick={() => onLocate(e.utteranceId)}
                    title="在论题演化图上定位这条发言"
                    aria-label="定位到论题演化图"
                  >
                    <MapPin size={12} />
                  </button>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

/** 偶回事的两档收成窄带：常驻会稀释前面两档的注意力 */
function Band({
  bucket,
  nodes,
  models,
  sel,
  onToggle,
  nameOf,
  contentOf,
  onLocate,
}: {
  bucket: ArgBucket
  nodes: ArgNode[]
  models: ModelSummary[]
  sel: string | null
  onToggle: (id: string | null) => void
  nameOf: (id: string) => string
  contentOf: (id: string) => { text: string; absent: boolean } | null
  onLocate: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <section className={`am-band c-${bucket}`} aria-label={ARG_BUCKET_LABEL[bucket]}>
      <button className="am-band-h" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <Rail bucket={bucket} />
        <b>{nodes.length}</b>
        {ARG_BUCKET_LABEL[bucket]}
        <span className="am-band-hint">{expanded ? '收起' : COL_DESC[bucket]}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {expanded && (
        <div className="am-band-body">
          {nodes.map((n) => (
            <NodeCard
              key={n.id}
              n={n}
              tier="quiet"
              models={models}
              open={sel === n.id}
              onToggle={() => onToggle(sel === n.id ? null : n.id)}
              nameOf={nameOf}
              contentOf={contentOf}
              onLocate={onLocate}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export function ArgumentMap({
  models,
  onLocate,
}: {
  models: ModelSummary[]
  onLocate: (id: string) => void
}) {
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const utterances = useStore((s) => s.utterances)
  const round = useStore((s) => s.round)
  const anonymousReview = useStore((s) => s.anonymousReview)

  const [sel, setSel] = useState<string | null>(null)

  const map = useMemo(() => buildArgumentMap({ consensus, disputes, utterances }), [consensus, disputes, utterances])

  const uttById = useMemo(() => new Map(utterances.map((u) => [u.id, u])), [utterances])
  const contentOf = (id: string) => {
    const u = uttById.get(id)
    return u ? { text: u.content, absent: u.absent } : null
  }
  const nameOf = (id: string) => (id === 'human' ? '人工' : models.find((m) => m.id === id)?.displayName ?? id)

  /**
   * 轴的上界取「这场实际走到第几轮」，发言与节点的轮次只把它往上顶：
   * 一条判断落在轴的什么位置，取决于整场有多少轮，而不是取决于它自己。
   */
  const maxRound = Math.max(
    1,
    round,
    ...utterances.map((u) => u.round),
    ...map.nodes.map((n) => n.rounds?.to ?? 0),
  )

  const lanes = ARG_BUCKETS.map((b) => ({ bucket: b, segs: map.byBucket[b].filter((n) => n.rounds) })).filter(
    (l) => l.segs.length > 0
  )

  return (
    <div className="arg-map">
      <div className="am-over" style={{ '--am-rounds': maxRound } as CSSProperties}>
        <div className="am-tallies">
          {ARG_BUCKETS.map((b) => (
            <span className={`am-tally c-${b}`} key={b}>
              <b>{map.byBucket[b].length}</b>
              <i>{ARG_BUCKET_LABEL[b]}</i>
            </span>
          ))}
          {anonymousReview && (
            <span className="am-anon" title="主持与参会模型只看别名；这里显示的是反匿名后的名字">
              <EyeOff size={11} /> 匿名轨
            </span>
          )}
        </div>

        <div className="am-axis-head">
          <span className="am-axis-k">轮次轴</span>
          <span className="am-axis-ticks">
            {Array.from({ length: maxRound }, (_, i) => (
              <span className="am-tick" key={i}>
                {i + 1}
              </span>
            ))}
          </span>
        </div>

        {lanes.map((l) => (
          <div className="am-lane" key={l.bucket}>
            <span className={`am-lane-k c-${l.bucket}`}>{ARG_BUCKET_LABEL[l.bucket]}</span>
            <span className={`am-lane-track c-${l.bucket}`}>
              {l.segs.map((n) => (
                <span
                  className={`am-seg c-${n.bucket}`}
                  key={n.id}
                  style={segStyle(n.rounds!, maxRound)}
                  title={`${plainMd(n.claim, 60)} · 依据覆盖第 ${n.rounds!.from}–${n.rounds!.to} 轮`}
                />
              ))}
            </span>
          </div>
        ))}

        {lanes.length === 0 && map.nodes.length > 0 && (
          <p className="am-none">节点都定位不到原文轮次，轴上就没有可画的段 —— 宁可不画，不猜位置。</p>
        )}
      </div>

      {map.nodes.length === 0 && (
        <p className="am-none">
          还没有可画的判断。主持每轮小结产出「已确认共识 / 未决分歧」之后，这里才会成图。
        </p>
      )}

      <div className="am-board">
        {(['contested', 'held'] as ArgBucket[]).map((b) => (
          <section className={`am-col c-${b}`} key={b} aria-label={ARG_BUCKET_LABEL[b]}>
            <h3 className="am-col-h">
              <Rail bucket={b} />
              {ARG_BUCKET_LABEL[b]}
              <span className="am-col-n">{map.byBucket[b].length}</span>
            </h3>
            <p className="am-col-desc">{COL_DESC[b]}</p>
            {map.byBucket[b].length === 0 ? (
              <p className="am-col-none">{b === 'held' ? '还没有被确认的共识' : '没有还争着的判断题'}</p>
            ) : (
              map.byBucket[b].map((n) => (
                <NodeCard
                  key={n.id}
                  n={n}
                  tier={b === 'contested' ? 'lead' : 'std'}
                  models={models}
                  open={sel === n.id}
                  onToggle={() => setSel(sel === n.id ? null : n.id)}
                  nameOf={nameOf}
                  contentOf={contentOf}
                  onLocate={onLocate}
                />
              ))
            )}
          </section>
        ))}
      </div>

      {(['settled', 'vacated'] as ArgBucket[]).map((b) =>
        map.byBucket[b].length > 0 ? (
          <Band
            key={b}
            bucket={b}
            nodes={map.byBucket[b]}
            models={models}
            sel={sel}
            onToggle={setSel}
            nameOf={nameOf}
            contentOf={contentOf}
            onLocate={onLocate}
          />
        ) : null
      )}
    </div>
  )
}
