import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  EyeOff,
  MapPin,
  ShieldCheck,
  Swords,
} from 'lucide-react'
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
import { plainMd } from '../textFormat'
import '../argmap.css'

/**
 * 论证地图 —— 一个节点 = 一个判断，看的是「现在剩下什么」。
 *
 * 与同栏的「论题演化」按粒度分工：那张图一个节点是一次发言，看过程；这里看结论的
 * 结构：已确认 / 争议中 / 已消解 / 无人认领 四个分区，连线只有真实存在的那一种 ——
 * 判断 → 本场发言。数据里没有 claim 级的「支持/反对某命题」边，所以不画跨区曲线，
 * 一个判断的依据就挂在它自己卡片下方的证据树里。点「定位」跳到演化图亮出那条线。
 *
 * 分区纵向排而不是横向四列：右栏常态宽度是 280px，四列并排每列只剩 60px，
 * 判断正文一个字都放不下。顶部的计数 chips 承担「一眼看清分布」这件事。
 */

const VERIFY_TONE: Record<Exclude<ConsensusVerificationStatus, 'unverified'>, string> = {
  verified: 'ok',
  disputed: 'warn',
  vacated: 'bad',
}

const VERIFY_TEXT: Record<Exclude<ConsensusVerificationStatus, 'unverified'>, string> = {
  verified: '已核验',
  disputed: '有代答',
  vacated: '无人认领',
}

function verifyOf(n: ArgNode): { text: string; tone: string; title: string } | null {
  const v = n.verify
  if (!v || v === 'unverified') return null
  const key = v as Exclude<ConsensusVerificationStatus, 'unverified'>
  return {
    text: VERIFY_TEXT[key],
    tone: VERIFY_TONE[key],
    title:
      key === 'verified'
        ? '每位声称支持者本人发言里都找得到原文'
        : key === 'disputed'
          ? '核验发现有人的表态是被代答的，已在质询轮追问'
          : '质询后支持方归零；条目保留 —— 「被证明没人说过」也是一条结论',
  }
}

/** 支持者用小图标，比一长串名字省地方 */
function Dot({ model }: { model?: ModelSummary }) {
  const [i, setI] = useState(0)
  const urls = model ? getFaviconUrls(model.domain) : []
  if (!model || i >= urls.length) {
    return <span className="am-dot-fb">{model ? initials(model.displayName).slice(0, 2) : '?'}</span>
  }
  return <img className="am-dot" src={urls[i]} alt="" crossOrigin="anonymous" onError={() => setI(i + 1)} />
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
  const anonymousReview = useStore((s) => s.anonymousReview)

  const [sel, setSel] = useState<string | null>(null)

  const map = useMemo(
    () => buildArgumentMap({ consensus, disputes, utterances }),
    [consensus, disputes, utterances],
  )

  const utteranceOf = useMemo(() => {
    const m = new Map<string, { content: string; absent: boolean; streaming: boolean }>()
    for (const u of utterances) m.set(u.id, { content: u.content, absent: u.absent, streaming: u.streaming })
    return m
  }, [utterances])

  const nameOf = (id: string) =>
    id === 'human' ? '人工' : models.find((m) => m.id === id)?.displayName ?? id

  const selected = sel ? map.nodes.find((n) => n.id === sel) ?? null : null

  // 「无人认领」「已消解」只在真有其事时占位，否则四段里有两段常年是空的
  const shown = ARG_BUCKETS.filter(
    (b) => map.byBucket[b].length > 0 || b === 'held' || b === 'contested',
  )

  return (
    <div className="arg-map">
      <div className="am-head">
        <div className="am-title">论证地图</div>
        <div className="am-sub">一个节点 = 一个判断。连线只有「依据 → 本场发言」这一种真实关系。</div>
      </div>

      <div className="am-chips">
        {ARG_BUCKETS.map((b) => (
          <span key={b} className={`am-chip am-chip-${b}`} title={`${ARG_BUCKET_LABEL[b]}：${map.byBucket[b].length} 条`}>
            {ARG_BUCKET_LABEL[b]} <b>{map.byBucket[b].length}</b>
          </span>
        ))}
        {anonymousReview && (
          <span className="am-chip am-chip-anon" title="主持与参会模型只看别名；这里显示的是反匿名后的名字">
            <EyeOff size={10} /> 匿名轨
          </span>
        )}
      </div>

      {map.nodes.length === 0 && (
        <div className="am-empty">
          还没有可画的判断。主持每轮小结产出「已确认共识 / 未决分歧」之后，这里才会成图。
        </div>
      )}

      {shown.map((b: ArgBucket) => (
        <section className={`am-sec am-sec-${b}`} key={b}>
          <div className="am-sec-head">
            <span>{ARG_BUCKET_LABEL[b]}</span>
            <span className="am-sec-n">{map.byBucket[b].length}</span>
          </div>

          {map.byBucket[b].length === 0 && (
            <div className="am-sec-empty">
              {b === 'held' ? '还没有被主持确认的共识' : '没有还争着的判断题'}
            </div>
          )}

          {map.byBucket[b].map((n) => {
            const v = verifyOf(n)
            const open = sel === n.id
            return (
              <button
                key={n.id}
                className={`am-node${open ? ' open' : ''}`}
                onClick={() => setSel(open ? null : n.id)}
                title={plainMd(n.claim)}
              >
                <span className="am-node-kind">
                  {n.kind === 'dispute' ? <Swords size={11} /> : <ShieldCheck size={11} />}
                </span>
                <span className="am-node-main">
                  <span className="am-node-claim">{plainMd(n.claim, 96)}</span>
                  <span className="am-node-foot">
                    <span className="am-node-dots">
                      {n.agents.slice(0, 4).map((a, k) => (
                        <Dot key={`${a}-${k}`} model={models.find((m) => m.id === a)} />
                      ))}
                      {n.agents.length > 4 && <span className="am-more">+{n.agents.length - 4}</span>}
                      {n.agents.length === 0 && <span className="am-more">无支持方</span>}
                    </span>
                    {n.rounds && (
                      <span className="am-node-round">
                        R{n.rounds.from}
                        {n.rounds.to > n.rounds.from ? `–R${n.rounds.to}` : ''}
                      </span>
                    )}
                    <span className="am-node-round">{n.evidence.length} 依据</span>
                    {v && (
                      <span className={`am-badge tone-${v.tone}`} title={v.title}>
                        {v.text}
                      </span>
                    )}
                    {n.variants.length > 0 && (
                      <span className="am-badge tone-muted" title="跨轮换说法的同一判断，已按内容并成一条">
                        同判断 {n.variants.length + 1} 说
                      </span>
                    )}
                    {n.missingEvidence > 0 && (
                      <span
                        className="am-badge tone-bad"
                        title={`主持引了 ${n.missingEvidence} 条本场不存在的发言，所以没画成线`}
                      >
                        <AlertTriangle size={9} /> 查无 {n.missingEvidence}
                      </span>
                    )}
                  </span>
                </span>
                <span className="am-node-caret">
                  <ChevronDown size={11} className={open ? 'rot' : ''} />
                </span>
              </button>
            )
          })}
        </section>
      ))}

      {selected && (
        <div className="am-detail">
          <div className="am-detail-claim">{plainMd(selected.claim)}</div>

          {selected.sides && selected.sides.length > 0 && (
            <div className="am-sides">
              {selected.sides.map((s, k) => (
                <div className="am-side" key={`${s.agentId}-${k}`}>
                  <div className="am-side-who">
                    <Dot model={models.find((m) => m.id === s.agentId)} />
                    {nameOf(s.agentId)}
                  </div>
                  <div className="am-side-text">{plainMd(s.argument)}</div>
                </div>
              ))}
            </div>
          )}

          {selected.lastProgress && <div className="am-progress">最近进展：{selected.lastProgress}</div>}

          {selected.variants.length > 0 && (
            <div className="am-variants">
              <div className="am-ev-title">被并入的其他说法</div>
              {selected.variants.map((v, k) => (
                <div className="am-variant" key={k}>
                  {v}
                </div>
              ))}
            </div>
          )}

          <div className="am-ev-title">
            依据（{selected.evidence.length}）
            {selected.humanCount > 0 && (
              <span className="am-human-note">含人工介入 {selected.humanCount} 条，不计入共识度</span>
            )}
          </div>
          {selected.evidence.length === 0 ? (
            <div className="am-empty">
              这条判断没有可核对的原文依据 —— 报告与核验轮都按「未核对」处理它。
            </div>
          ) : (
            <div className="am-tree">
              {selected.evidence.map((e) => {
                const u = utteranceOf.get(e.utteranceId)
                return (
                  <div className="am-leaf" key={e.utteranceId}>
                    <div className="am-leaf-who">
                      <Dot model={models.find((m) => m.id === e.agentId)} />
                      {e.human ? '人工' : nameOf(e.agentId)} · 第 {e.round} 轮
                      {u?.absent ? ' · 缺席占位' : ''}
                      {u?.streaming ? ' · 正在写' : ''}
                    </div>
                    <div className="am-leaf-text">
                      {u ? plainMd(u.content, 140) || '（这条发言还没有正文）' : '（本场找不到这条发言的原文）'}
                    </div>
                    <button
                      className="cs-locate"
                      onClick={() => onLocate(e.utteranceId)}
                      title="在论题演化图上定位这条发言"
                    >
                      <MapPin size={10} />
                      定位
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
