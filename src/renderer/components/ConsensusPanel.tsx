import { useMemo, useState, useEffect } from 'react'
import { useStore, type ModelSummary } from '../store'
import { ScoreChart } from './ScoreChart'
import { provenanceSummary } from '@shared/anonymity'
import { aggregateLeaderboard, agreementDimNote } from '@shared/invariants'
import { FINISH_REASON_LABEL } from '@shared/retry'
import { consensusWeightsFor } from '@shared/types'
import { ARG_BUCKETS, ARG_BUCKET_HINT, ARG_BUCKET_LABEL, ARG_BUCKET_TONE, buildArgumentMap, type ArgBucket, type ArgNode } from '@shared/argmap'
import type { ConsensusVerificationStatus } from '@shared/types'
import { getFaviconUrls, initials } from './ModelRail'
import { Markdown } from './Markdown'
import { mdExcerpt } from '../textFormat'
import { AlertTriangle, EyeOff, FileText, Layers, MapPin, ShieldCheck, Target } from 'lucide-react'

/**
 * 结论台账 —— 这一栏回答的是「这场讨论留下了什么」。
 *
 * 叫台账不叫共识结果：研讨完全可以不收敛，把没达成共识的部分也叫「共识结果」，
 * 等于界面替讨论宣布了一个主持都没敢宣布的结论。这一栏把立住的、还在争的、
 * 被消解的、质询后没人认领的四类并列记在同一本账上，顶部按状态可筛。
 *
 * 与左边的「论题演化」按角色分工：演化流看过程（谁接住谁、观点在哪儿被改写），
 * 它的落点清单只是图上的索引；这里看结论本身 —— 完整陈述、谁同意、依据能不能
 * 核对回去、还争着什么。所以这一栏不放「认同 X、Y · 第 N 轮」那种一句话摘要，
 * 而是把主持产出、此前被界面丢掉的字段摊开：evidence_ref 原文、confidence 与
 * weight 的分工、跨轮归并前的其他措辞、核验降级状态、分歧各方的 argument 正文与
 * 最近进展，以及每条的判断依据到底横跨了哪几轮。
 */

type Badge = { text: string; tone: string; title: string }

/**
 * 核验结论。关键约束：核验只会降级支持方，条目本身一定保留 ——
 * 「被证明没人说过」也是一条结论，静默删除是另一种幻觉。
 */
const VERIFY: Record<Exclude<ConsensusVerificationStatus, 'unverified'>, Badge> = {
  verified: { text: '已核验', tone: 'ok', title: '每位声称支持的模型，本人发言里都找得到对应原文' },
  disputed: { text: '有争议', tone: 'warn', title: '核验发现有人被主持代为表态，已在质询轮追问过' },
  vacated: {
    text: '无实质支持者',
    tone: 'bad',
    title: '质询后支持方归零。条目仍然保留 —— 「被证明没人说过」本身是一条结论',
  },
}

function verifyBadge(
  c: { verification?: { status: ConsensusVerificationStatus; checkedRound: number; attributed: string[]; confirmedBy: string[]; removed: string[] } },
  corrected: number,
): Badge | null {
  const v = c.verification
  if (!v || v.status === 'unverified') {
    // 一场核验都没跑过就不加徽标，免得每条都挂个「未核对」把真信号淹掉
    if (!v && corrected === 0) return null
    return { text: '未核对', tone: 'muted', title: '核验轮没有质询到这条（未达门槛）' }
  }
  const bits = [`第 ${v.checkedRound} 轮逐位核对本人原文`, `确认 ${v.confirmedBy.length} 家`]
  if (v.removed.length > 0) bits.push(`质询后撤回 ${v.removed.length} 家`)
  if (v.attributed.length > 0) bits.push(`核验时代答 ${v.attributed.length} 家`)
  return { ...VERIFY[v.status as Exclude<ConsensusVerificationStatus, 'unverified'>], title: `${VERIFY[v.status as Exclude<ConsensusVerificationStatus, 'unverified'>].title}（${bits.join(' · ')}）` }
}

/** 模型小图标：支持方用图标点阵，比一长串顿号名字省地方也好认 */
function Glyph({ model, size = 15 }: { model?: ModelSummary; size?: number }) {
  const [i, setI] = useState(0)
  const urls = model ? getFaviconUrls(model.domain) : []
  if (!model || urls.length === 0 || i >= urls.length) {
    return (
      <span className="cs-glyph-fb" style={{ width: size, height: size }}>
        {model ? initials(model.displayName).slice(0, 2) : '?'}
      </span>
    )
  }
  return (
    <img
      className="cs-glyph"
      style={{ width: size, height: size }}
      src={urls[i]}
      alt=""
      crossOrigin="anonymous"
      onError={() => setI(i + 1)}
    />
  )
}

/** 0~1 的细进度条：只用来比较相对高低，不装作能读出小数；excluded 表示这一维本轮没参与计分 */
function Meter({
  value,
  label,
  title,
  tone,
  excluded,
}: {
  value: number
  label: string
  title: string
  tone: string
  excluded?: boolean
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <span className="cs-meter" title={title}>
      <span className="cs-meter-label">{label}</span>
      <span className="cs-meter-track">
        {!excluded && <span className={`cs-meter-fill tone-${tone}`} style={{ width: `${pct}%` }} />}
      </span>
      <span className="cs-meter-num">{excluded ? '—' : pct}</span>
    </span>
  )
}

/**
 * 三档点亮，不印小数：confidence/weight 是主持给的粗判，摆成 0-100 的读数牌
 * 是界面在替它假装精度。三档够比较「哪几条更结实」，也一眼看得出错位 ——
 * 「多数认同」配「证据薄」正是该怀疑的那种组合，合成一条综合分就被抹平了。
 *
 * value 缺失走 missing 文案并画空：没记这一项和记了零是两回事，
 * 把「主持没给权重」画成 0 格等于替这条判了没分量。
 */
function Ladder({
  label,
  value,
  words,
  missing,
  title,
  tone,
}: {
  label: string
  value?: number
  words: [string, string, string]
  missing: string
  title: string
  tone: 'accent' | 'consensus'
}) {
  const level = typeof value !== 'number' ? 0 : value >= 2 / 3 ? 3 : value >= 1 / 3 ? 2 : 1
  const word = typeof value === 'number' ? (words[level - 1] ?? words[2]!) : missing
  return (
    <span
      className={`cs-ladder tone-${tone}${level === 0 ? ' none' : ''}`}
      title={`${title}（${typeof value === 'number' ? `原始值 ${Math.round(value * 100)}` : '未记录'}）`}
    >
      <span className="cs-ladder-label">{label}</span>
      <span className="cs-ladder-steps">
        {[1, 2, 3].map((n) => (
          <i key={n} className={n <= level ? 'on' : ''} />
        ))}
      </span>
      <span className="cs-ladder-word">{word}</span>
    </span>
  )
}

function Locate({ id, label, onLocate }: { id?: string; label: string; onLocate: (id: string) => void }) {
  if (!id) return null
  return (
    <button className="cs-locate" title={`在正文里点亮这条发言：${label}`} onClick={() => onLocate(id)}>
      <MapPin size={10} />
      定位
    </button>
  )
}

/** 依据横跨多轮时才有区间可说；单轮的写「第 N 轮」 */
function roundSpanLabel(rounds: ArgNode['rounds'], prefix: string): string | null {
  if (!rounds) return null
  if (rounds.from === rounds.to) return null
  return `${prefix}第 ${rounds.from}–${rounds.to} 轮`
}

/** 分歧卡同一行只放得下一句：争开了就报区间，没争开就报它是从哪轮挂上来的 */
function disputeRoundLabel(rounds: ArgNode['rounds'], openedRound: number): string {
  return roundSpanLabel(rounds, '交锋跨') ?? `始于第 ${openedRound} 轮`
}

/**
 * 把台账里被点中的那一条滚到眼前。「↓ 台账第 N 条」与刚换了聚焦对象两条路都走这里：
 * 指针既然说了「详版在台账」，看得见就是这一格的责任，不是用户自己找。
 * 折叠要先掀开再滚 —— 藏在 closed <details> 里的卡片没有盒子，滚不动它。
 */
export function revealFocusedClaim(): void {
  const el = document.querySelector('.cs-focus')
  if (!el) return
  for (const d of el.querySelectorAll('details')) d.open = true
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p instanceof HTMLDetailsElement) p.open = true
  }
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
}

export function ConsensusPanel({
  models,
  onLocate,
  focusedId,
}: {
  models: ModelSummary[]
  onLocate: (id: string) => void
  /** 正文图上被点中的那条：台账里同一条要跟着亮，不再另开一份详情卡 */
  focusedId?: string
}) {
  /** 状态条选中的桶；null=不设筛选，四类并排看 */
  const [bucketFilter, setBucketFilter] = useState<ArgBucket | null>(null)
  const scores = useStore((s) => s.scores)
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const utterances = useStore((s) => s.utterances)
  const audits = useStore((s) => s.moderatorAudit)
  const anonymousReview = useStore((s) => s.anonymousReview)
  const spentUsd = useStore((s) => s.spentUsd)
  const budgetLimitUsd = useStore((s) => s.budgetLimitUsd)
  const threshold = useStore((s) => s.consensusThreshold)
  const strategy = useStore((s) => s.strategy)
  const state = useStore((s) => s.state)
  const corrections = useStore((s) => s.corrections)
  const round = useStore((s) => s.round)
  const maxRounds = useStore((s) => s.maxRounds)
  const finishedReason = useStore((s) => s.finishedReason)
  const moderatorUnavailable = useStore((s) => s.moderatorUnavailable)
  const budgetLimited = useStore((s) => s.budgetLimited)
  const timeLimited = useStore((s) => s.timeLimited)
  const reportReady = useStore((s) => s.reportReady)
  const setReportOpen = useStore((s) => s.setReportOpen)

  const nameOf = (id: string) => (id === 'human' ? '人工' : models.find((m) => m.id === id)?.displayName ?? id)
  const modelOf = (id: string) => models.find((m) => m.id === id)
  /** 只有一方时明写「单方存疑」：光列一个名字，读的人会以为这条还缺另一方 */
  const disputeSides = (sides: Array<{ agentId: string }>) => {
    const only = sides.length === 1 ? sides[0] : undefined
    // 多方也不写「A vs B」：未决分歧常常是几方各留一个疑问，不是两派对垒
    return only ? `${nameOf(only.agentId)} 单方存疑` : sides.map((s) => nameOf(s.agentId)).join('、')
  }
  const last = scores.length > 0 ? scores[scores.length - 1]! : null

  /**
   * 认同溯源与名次都在渲染端即时计算：两者都能从已落盘的审计/发言推出，
   * 主进程不必为 UI 再算一遍，回放历史会话时也是同一套口径。
   */
  const prov = useMemo(() => provenanceSummary(consensus, utterances), [consensus, utterances])
  const provById = useMemo(() => new Map(prov.points.map((p) => [p.pointId, p])), [prov])
  const leaderboard = useMemo(() => aggregateLeaderboard(audits), [audits])
  const uttById = useMemo(() => new Map(utterances.map((u) => [u.id, u])), [utterances])

  const open = disputes.filter((d) => d.status === 'open')
  /**
   * 搁置的条目不阻塞收束，但它不是「已解决」，所以仍留在「保留分歧」这一节里，
   * 只是脚注换成「当场缺什么」—— 让它从这一节消失，等于界面替主持把搁置说成了放下。
   */
  const shelved = disputes.filter((d) => d.status === 'shelved')
  const pending = [...open, ...shelved]
  const resolved = disputes.filter((d) => d.status === 'resolved')

  /**
   * 四个状态桶按「现在有没有人认账」分，判据都在 argmap 里算好了。
   * 这里只拿来当筛选：一份清单，两种看法，不再另开一屏重排同样的条目。
   */
  const argMap = useMemo(
    () => buildArgumentMap({ consensus, disputes, utterances }),
    [consensus, disputes, utterances],
  )
  const nodeById = useMemo(() => new Map(argMap.nodes.map((n) => [n.id, n] as const)), [argMap])
  const inBucket = (id: string) => !bucketFilter || nodeById.get(id)?.bucket === bucketFilter
  const shownPoints = consensus.filter((c) => inBucket(c.id))
  const shownPending = pending.filter((d) => inBucket(d.id))
  const shownResolved = resolved.filter((d) => inBucket(d.id))

  /**
   * 正文点了落点 → 这一格要接得住：被桶筛选挡住时筛选先让路（否则指针指向一个
   * 没渲染的节点），已消解的分歧还压在折叠里就把它掀开、依据跟着展开，最后滚到眼前。
   * 只在换了对象时接一次：之后用户自己筛、自己折叠，界面不该再抢滚动。
   */
  useEffect(() => {
    if (!focusedId) return
    const n = nodeById.get(focusedId)
    if (!n) return
    if (bucketFilter && n.bucket !== bucketFilter) setBucketFilter(null)
    // 让路之后要多等一帧：那张卡片是这一帧之后才存在的
    const raf = requestAnimationFrame(revealFocusedClaim)
    return () => cancelAnimationFrame(raf)
  }, [focusedId])

  /**
   * 加权口径按策略走：只有辩论场指派了正反方，「谁表态支持谁」才是数得出的东西。
   * 圆桌与评审场里这一维让出权重，综合分只剩重合与趋势 —— 它照样不是收束条件，
   * 所以色调也不能跟着分数走：有没谈完的分歧才是这场「还没收住」的理由。
   */
  const weights = consensusWeightsFor(last?.agreementSource, strategy)
  const agreementExcluded = weights.agreement === 0
  const dimFormula =
    `综合分 = ${weights.agreement > 0 ? `${weights.agreement}×主张一致 + ` : ''}${weights.overlap}×论点重合 + ${weights.trend}×收敛趋势` +
    (agreementExcluded ? `（${agreementDimNote(last, strategy)}）` : '')
  const scoreTone = !last ? 'muted' : pending.length > 0 ? 'warn' : 'ok'
  const budgetPct = Math.min(100, (spentUsd / Math.max(budgetLimitUsd, 0.01)) * 100)

  /** 分数这句话在运行参数行里，hover 要能看懂它量的是什么、不量的是什么 */
  const scoreTitle = moderatorUnavailable
    ? '没有主持小结就没有评分'
    : !last
      ? '第一轮小结还没产出，这里不会用猜测的分数占位'
      : `综合分 ${last.score}。${dimFormula}。它只是运行参数，不决定本场是否收场：` +
        '低分说的是这场还没收住，不是「讨论失败」，也不代表没留下能站住的判断。'

  return (
    <div className="cs">
      {/* ── 主角：这一场留下了什么 ────────────────────────────────
          四桶计数 + 认同可核对率才是「结果」，综合分/阈值/花费是「怎么跑的」，
          不该由后者当标题：研讨完全可以不收敛，把加权分顶在最上面，
          界面就在替讨论宣布一个连主持都没宣布过的结论。 */}
      <section className="cs-lead">
        <header className="cs-head">
          <Layers size={12} />
          <span className="cs-head-title">这场留下了什么</span>
          <span className="cs-head-hint">
            {moderatorUnavailable
              ? '主持不可用：没有小结就没有判断'
              : bucketFilter
                ? `只看「${ARG_BUCKET_LABEL[bucketFilter]}」· ${argMap.byBucket[bucketFilter].length} 条`
                : '四类并排记，不保证收敛'}
          </span>
        </header>

        <div className="cs-buckets">
          {ARG_BUCKETS.map((b) => {
            const count = argMap.byBucket[b].length
            const active = bucketFilter === b
            return (
              <button
                key={b}
                className={`cs-bucket k-${b}${active ? ' active' : ''}${count === 0 ? ' zero' : ''}`}
                title={`${ARG_BUCKET_HINT[b]}${count === 0 ? '（本场没有）' : ' · 点击只看这一类'}`}
                onClick={() => setBucketFilter(active ? null : b)}
              >
                <span className="cs-bucket-n">{count}</span>
                <span className="cs-bucket-label">{ARG_BUCKET_LABEL[b]}</span>
              </button>
            )
          })}
        </div>

        {/*
          三句「这批判断有多结实」的诚实话，都来自程序自己算出来的量，不来自主持的形容词：
          认同可核对 = 声称的支持方里查得到本人原文的比例；
          一致性里带论据的比例 = 口号式一起点头会被它压低，综合分也按它折过价；
          来源标记 = 这一维是数出来的，还是没数到、拿主持自评兜的底。
        */}
        <div className="cs-lead-honest">
          <span
            className={`cs-honest${prov.coverageRate < 60 ? ' bad' : ''}`}
            title="把每条共识声称的支持方拿去本人发言里逐个核对：可核对的占多少。查不到原文的支持不算数"
          >
            认同可核对 {prov.coverageRate}%
          </span>
          {last && typeof last.independence === 'number' && (
            <span
              className="cs-honest"
              title={`主导阵营里 ${Math.round(last.independence * 100)}% 的发言带论据（够长、回应过别人，或被某条判断引为依据）。综合分已按 0.6 + 0.4×这一比例打折 —— 全是口号式附和时，一致度会被这一层压住`}
            >
              一致里带论据的 {Math.round(last.independence * 100)}%
            </span>
          )}
          {agreementExcluded && (
            <span className="cs-flag tone-muted" title={agreementDimNote(last, strategy)}>
              {strategy === 'debate' ? '本场无可数的表态' : '本场不按表态加权'}
            </span>
          )}
          {last?.overlapSource === 'moderator_fallback' && (
            <span
              className="cs-flag tone-warn"
              title="程序没数出两个以上模型共同提到的论点，这一维取的是主持自评 —— 看论点重合时要按此打折"
            >
              论点重合为自评
            </span>
          )}
        </div>

        {/* 运行参数：一行说完，不再用大号数字与进度条占住整屏 */}
        <div className="cs-run-line">
          <span>
            第 {round} / {Math.max(maxRounds, round)} 轮
          </span>
          <span className={`cs-run-score tone-${scoreTone}`} title={scoreTitle}>
            综合分 {last ? last.score : '—'}
            {typeof threshold === 'number' ? `（当年分数线 ${threshold}）` : ''}
          </span>
          {finishedReason ? (
            <span title="跑了 5 轮刚好用尽，和第 3 轮就收敛是两份可信度不同的结论">
              {FINISH_REASON_LABEL[finishedReason] ?? finishedReason}
            </span>
          ) : (
            <span>{round > 0 ? '进行中' : '未开始'}</span>
          )}
          <span title="网页通道走登录会话不计费，这里只算 API 侧的美元成本">
            ${spentUsd.toFixed(4)} / ${budgetLimitUsd.toFixed(2)}
          </span>
          {budgetLimited && (
            <span className="cs-flag tone-warn" title="费用触顶，讨论被提前收束 —— 结论的完整度要按此打折">
              费用触顶
            </span>
          )}
          {timeLimited && (
            <span className="cs-flag tone-warn" title="时长预算触顶，讨论被提前收束">
              时长触顶
            </span>
          )}
          {/* 报告入口放在这一行的末尾：参数行放不下第五个词，而它本来就会折行 */}
          <button
            className="btn sm cs-report"
            disabled={!reportReady}
            title={reportReady ? '打开本场纪要' : '报告要等讨论结束才产出'}
            onClick={() => reportReady && setReportOpen(true)}
          >
            <FileText size={11} />
            {!reportReady && (state === 'DONE' || state === 'ABORTED' || state === 'FAILED')
              ? '报告生成中…'
              : '查看报告'}
          </button>
        </div>

        {last && !moderatorUnavailable && (
          <div className="cs-dims" title={dimFormula}>
            <Meter
              value={last.agreement / 100}
              label="主张一致"
              tone="accent"
              excluded={agreementExcluded}
              title={
                agreementExcluded
                  ? agreementDimNote(last, strategy)
                  : '发言里显式表态的一致程度，由程序核算，并按主导阵营中「带论据」的比例打折'
              }
            />
            <Meter
              value={last.overlap / 100}
              label="论点重合"
              tone="consensus"
              title={
                last.overlapSource === 'moderator_fallback'
                  ? '被两个以上模型共同提到的论点占比 —— 程序没数到共同论点，本场取的是主持自评'
                  : '被两个以上模型共同提到的论点占比，由程序核算'
              }
            />
            <Meter
              value={last.trend / 100}
              label="收敛趋势"
              tone="warn"
              title="未决分歧数量的变化趋势，由程序计算、主持仅确认"
            />
          </div>
        )}

        {scores.length > 0 && <ScoreChart scores={scores} threshold={threshold} />}
      </section>

      {/* ── 关键判断：结论卡（正文 + 依据 + 核验状态）─────────────
          叫「关键判断」不叫共识点：这一份里连还开着、质询后没人认领的条目都在一起，
          名字盖不住内容就是界面替讨论判了案。可核对率挪到上面那一格，同一份数不印两遍。 */}
      <section className="cs-section">
        <header className="cs-head">
          <ShieldCheck size={12} />
          <span className="cs-head-title">关键判断</span>
          <span className="cs-head-n">
            {shownPoints.length}
            {bucketFilter && shownPoints.length !== consensus.length ? ` / ${consensus.length}` : ''}
          </span>
        </header>

        {consensus.length === 0 ? (
          <div className="cs-empty">
            <span className="pulse" />
            还没有判断被记下。条目由主持每轮小结产出并经程序回查，宁可晚，不编。
          </div>
        ) : shownPoints.length === 0 ? (
          <div className="cs-empty">这一桶里没有条目。</div>
        ) : (
          consensus.map((c, i) => {
            if (!inBucket(c.id)) return null
            const p = provById.get(c.id)
            const node = nodeById.get(c.id)
            /** 依据跨了不止一轮就说区间：一条「共识」是第 2 轮立的、第 4 轮还在被同样的话撑着，这跟当场定下来不是一回事 */
            const span = roundSpanLabel(node?.rounds ?? null, '依据跨')
            const spanTitle = node?.rounds
              ? `第 ${c.confirmedRound} 轮确认；被引用的发言分布在第 ${node.rounds.from}–${node.rounds.to} 轮`
              : undefined
            const verifiable =
              c.support.length === 0 || !p ? 0 : Math.round((p.covered.length / c.support.length) * 100)
            const v = verifyBadge(c, corrections.length)
            const evidence = c.evidenceRef.map((id) => uttById.get(id)).filter((u): u is NonNullable<typeof u> => !!u)
            const missing = c.evidenceRef.length - evidence.length
            return (
              <article key={c.id} className={`cs-point${v ? ` tone-${v.tone}` : ''}${c.id === focusedId ? ' cs-focus' : ''}`}>
                <div className="cs-point-top">
                  <span className="cs-idx">{String(i + 1).padStart(2, '0')}</span>
                  {v && (
                    <span className={`cs-badge tone-${v.tone}`} title={v.title}>
                      {v.text}
                    </span>
                  )}
                  <span className="cs-point-round" title={span ? spanTitle : undefined}>
                    {span ?? `第 ${c.confirmedRound} 轮确认`}
                  </span>
                </div>

                <div className="cs-claim">
                  <Markdown text={c.claim} />
                </div>

                <div className="cs-support">
                  {c.support.length === 0 ? (
                    <span className="cs-head-hint">没有模型被登记为支持方</span>
                  ) : (
                    c.support.map((id) => (
                      <span key={id} className="cs-support-who" title={`支持方：${nameOf(id)}`}>
                        <Glyph model={modelOf(id)} />
                        <span className="cs-support-name">{nameOf(id)}</span>
                      </span>
                    ))
                  )}
                </div>

                <div className="cs-meters">
                  {/*
                    硬（证据）与信（普遍）并排两格是故意的：合成一条就看不出
                    「主持说大家都同意，可没人给出依据」这种错位。
                  */}
                  <div className="cs-hb">
                    <Ladder
                      label="有多信"
                      tone="accent"
                      value={c.confidence}
                      words={['少数认同', '多数认同', '普遍认同']}
                      missing="未记置信"
                      title="confidence：主持评估的认同普遍程度"
                    />
                    <Ladder
                      label="有多硬"
                      tone="consensus"
                      value={c.weight}
                      words={['依据薄', '有支撑', '多路支撑']}
                      missing="主持没给权重"
                      title="weight：支撑它的独立论据有多硬。与「有多信」分列 —— 高置信低硬度就该怀疑"
                    />
                  </div>
                  <div className="cs-chips">
                    <span
                      className={`cs-chip${verifiable >= 60 ? ' ok' : verifiable > 0 ? ' warn' : ' bad'}`}
                      title="支持者中，本人在被引用的发言里有原文可核对的比例"
                    >
                      可核对 {verifiable}%
                    </span>
                    {/* 覆盖面：几条嘴在说同一件事。一家说的是洞见也是风险，三家说的是分布 */}
                    {node && node.modelCount <= 1 && c.support.length > 0 && (
                      <span
                        className="cs-chip warn"
                        title={`支持方列了 ${c.support.length} 家，可依据里只有 ${node.modelCount} 家真的说过话 —— 没人回应不等于大家都同意`}
                      >
                        仅 {node.modelCount} 家说过
                      </span>
                    )}
                    {node && node.modelCount > 1 && (
                      <span className="cs-chip" title="依据里出现过的不同模型数">
                        {node.modelCount} 家说过
                      </span>
                    )}
                    {p && p.attributed.length > 0 && (
                      <span className="cs-chip warn" title="主持替这些模型归因，证据里没有他们的发言">
                        代答 {p.attributed.map(nameOf).join('、')}
                      </span>
                    )}
                    {p?.crossExamined && (
                      <span className="cs-chip" title="证据发言里有被他人点名回应的">
                        挨过质询
                      </span>
                    )}
                  </div>
                </div>

                <details className="cs-fold">
                  <summary>
                    依据 {evidence.length}
                    {missing > 0 && `（另 ${missing} 条指向不在本场视图里的发言）`}
                  </summary>
                  {evidence.length === 0 ? (
                    <div className="cs-fold-empty">
                      {c.evidenceRef.length === 0
                        ? '主持这条小结没写 evidence_ref：没有原文可回查，按「未核对」看待'
                        : '引用的发言不在当前视图里（可能被截断，或不属于本场）'}
                    </div>
                  ) : (
                    <ul className="cs-evidence">
                      {evidence.map((u) => (
                        <li key={u.id}>
                          <span className="cs-ev-who">
                            <Glyph model={modelOf(u.agentId)} size={13} />
                            {nameOf(u.agentId)} · 第 {u.round} 轮
                          </span>
                          <span className="cs-ev-text">{mdExcerpt(u.content, 130)}</span>
                          <Locate id={u.id} label={`${nameOf(u.agentId)} 第 ${u.round} 轮发言`} onLocate={onLocate} />
                        </li>
                      ))}
                    </ul>
                  )}
                </details>

                {c.variants && c.variants.length > 0 && (
                  <details className="cs-fold">
                    <summary>归并前另有 {c.variants.length} 种说法</summary>
                    <ul className="cs-variants">
                      {c.variants.map((t, k) => (
                        <li key={k}>{t}</li>
                      ))}
                    </ul>
                    <div className="cs-fold-note">
                      主持每轮重新措辞，同一判断会被写成好几种说法。程序按内容归并成上面一条 ——
                      归并是压缩呈现，不是改写历史，原始说法逐条留在这里。
                    </div>
                  </details>
                )}
              </article>
            )
          })
        )}
      </section>

      {/* ── 保留分歧：未决 + 搁置（各方论点正文逐条列出，只有一方时就是单方存疑）── */}
      <section className="cs-section">
        <header className="cs-head">
          <AlertTriangle size={12} />
          <span className="cs-head-title">保留分歧</span>
          <span className="cs-head-n">
            {shownPending.length}
            {bucketFilter && shownPending.length !== pending.length ? ` / ${pending.length}` : ''}
          </span>
          <span className="cs-head-hint">
            {shelved.length > 0 ? `未决 ${open.length} · 搁置 ${shelved.length}` : '未决清单只增不减'}
          </span>
        </header>

        {pending.length === 0 ? (
          <div className="cs-empty">{consensus.length ? '没有悬而未决的分歧。' : '还没有登记过分歧。'}</div>
        ) : shownPending.length === 0 ? (
          <div className="cs-empty">这一桶里没有未决分歧。</div>
        ) : (
          shownPending.map((d) => (
            <article key={d.id} className={`cs-dispute${d.id === focusedId ? ' cs-focus' : ''}`}>
              <div className="cs-claim">
                <Markdown text={d.claim} />
              </div>
              <div className="cs-sides">
                {d.sides.map((s) => (
                  <div key={s.agentId} className="cs-side">
                    <div className="cs-side-who">
                      <Glyph model={modelOf(s.agentId)} size={13} />
                      <span className="cs-side-name">{nameOf(s.agentId)}</span>
                      <Locate
                        id={s.utteranceIds[s.utteranceIds.length - 1]}
                        label={`${nameOf(s.agentId)} 的发言`}
                        onLocate={onLocate}
                      />
                    </div>
                    <div className="cs-side-arg">
                      {s.argument || <span className="cs-head-hint">主持没记下这一方的论点原文</span>}
                    </div>
                  </div>
                ))}
              </div>
              {d.sides.length === 1 && (
                <div className="cs-head-hint">只有这一方在质疑。没人回应不等于大家都同意。</div>
              )}
              <div className="cs-dispute-foot">
                <span>{disputeRoundLabel(nodeById.get(d.id)?.rounds ?? null, d.openedRound)}</span>
                {d.shelve ? (
                  <span className="cs-progress" title={`${d.shelve.reason}（第 ${d.shelve.round} 轮搁置）`}>
                    当场判不了，缺：{d.shelve.missing}
                  </span>
                ) : d.lastProgress ? (
                  <span className="cs-progress" title={d.lastProgress}>
                    最近进展：{d.lastProgress}
                  </span>
                ) : (
                  <span className="cs-progress none">上一轮没有进展</span>
                )}
              </div>
            </article>
          ))
        )}

        {resolved.length > 0 && (
          <details className="cs-fold">
            <summary>
              已消解 {shownResolved.length} 项
              {bucketFilter && shownResolved.length !== resolved.length ? ` / ${resolved.length}` : ''}
            </summary>
            {shownResolved.length === 0 ? (
              <div className="cs-fold-empty">这一桶里没有消解记录。</div>
            ) : (
              <ul className="cs-resolved">
                {shownResolved.map((d) => (
                  <li key={d.id}>
                    <span className="cs-resolved-claim">{d.claim}</span>
                    <span className="cs-head-hint">
                      {disputeSides(d.sides)} · 第 {d.openedRound} 轮起
                    </span>
                    {(d.resolutionRef?.length ?? 0) === 0 && (
                      <span
                        className="cs-no-basis"
                        title="主持把它标成了 resolved，却没给出消解依据。清单只增不减，减的凭据是依据 —— 所以它上面仍记在「还开着」那一桶"
                      >
                        没给依据，仍算还开着
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
      </section>

      {/* ── 本场账本：审计材料，默认收起 ─────────────────────── */}
      <details className="cs-ledger">
        <summary>
          <Target size={12} />
          本场账本 · 程序校验 / 互评名次 / 花费
        </summary>

        <div className="cs-ledger-body">
          <div className="cs-ledger-block">
            <div className="cs-ledger-title">程序校验</div>
            {audits.length === 0 ? (
              <div className="cs-fold-empty">
                {moderatorUnavailable ? '无主持小结可校验' : '主持小结尚未产出'}
              </div>
            ) : (
              <>
                {anonymousReview && (
                  <div className="audit-mode">
                    <EyeOff size={10} />
                    匿名轨：主持与参会模型都只看到别名
                  </div>
                )}
                <div className="audit-chips">
                  <span className={`audit-chip${prov.coverageRate >= 60 ? ' ok' : ' warn'}`}>
                    认同可核对 {prov.coverageRate}%
                  </span>
                  <span className="audit-chip">挨过质询 {prov.crossExaminedRate}%</span>
                </div>
                {[...audits]
                  .sort((a, b) => b.round - a.round)
                  .map((a) => (
                    <details key={`${a.round}-${a.startedAt}`} className="rp-evidence">
                      <summary>
                        第 {a.round} 轮 ·{' '}
                        {a.accepted
                          ? a.attempts.length === 1
                            ? '一次通过'
                            : `${a.attempts.length} 次尝试后通过`
                          : `${a.attempts.length} 次尝试均未通过`}
                        {(a.unknownAliases.length > 0 || a.leakedRealIds.length > 0) && (
                          <span className="audit-chip bad">
                            {[a.unknownAliases.length > 0 && '凭空归因', a.leakedRealIds.length > 0 && '身份泄漏']
                              .filter(Boolean)
                              .join(' + ')}
                          </span>
                        )}
                      </summary>
                      {a.aliases && (
                        <div className="audit-alias">
                          {Object.entries(a.aliases).map(([alias, id]) => (
                            <span key={alias}>
                              {alias} = {nameOf(id)}
                            </span>
                          ))}
                        </div>
                      )}
                      {a.unknownAliases.length > 0 && (
                        <div className="audit-line bad">
                          小结引用了未登记的别名（已被拒绝）：{a.unknownAliases.join('、')}
                        </div>
                      )}
                      {a.leakedRealIds.length > 0 && (
                        <div className="audit-line warn">
                          匿名轨里写出了真实模型 id：{a.leakedRealIds.map(nameOf).join('、')}
                        </div>
                      )}
                      {a.attempts.map((at) => (
                        <div key={at.attempt} className="audit-attempt">
                          <div className="audit-attempt-head">
                            <span className={at.ok ? 'audit-ok' : 'audit-bad'}>
                              #{at.attempt} {at.ok ? '通过' : '驳回'}
                            </span>
                            <span>{(at.ms / 1000).toFixed(1)}s</span>
                            <span>${at.costUsd.toFixed(4)}</span>
                            {at.validation.warnings.length > 0 && (
                              <span title={at.validation.warnings.join('\n')}>警告 {at.validation.warnings.length}</span>
                            )}
                          </div>
                          {a.accepted && at.ok && (
                            <div className="audit-line">
                              程序抽出：共识 {a.accepted.consensus_points.length} 条 / 分歧{' '}
                              {a.accepted.open_disputes.length} 项 / 名次 {a.accepted.agent_quality?.length ?? 0} 条
                            </div>
                          )}
                          {!at.ok && (at.validation.errors.length > 0 || at.error) && (
                            <div className="audit-line bad">
                              {(at.error ? [at.error] : at.validation.errors).join('；')}
                            </div>
                          )}
                          <pre className="audit-raw">{at.raw || '（本次尝试没有拿到正文）'}</pre>
                        </div>
                      ))}
                    </details>
                  ))}
              </>
            )}
          </div>

          {leaderboard.length > 0 && (
            <div className="cs-ledger-block">
              <div className="cs-ledger-title">互评名次</div>
              {leaderboard.map((row) => (
                <div key={row.agentId} className="lb-row" title={row.rationale ?? undefined}>
                  <span className="lb-rank">{row.averageRank.toFixed(1)}</span>
                  <span className="lb-name">{nameOf(row.agentId)}</span>
                  <span className="lb-rounds">{row.rounds} 轮</span>
                </div>
              ))}
              <div className="audit-hint">跨轮平均名次，仅作相对参考，不参与共识度加权。</div>
            </div>
          )}

          <div className="cs-ledger-block">
            <div className="cs-ledger-title">花费与预算</div>
            <div className="cs-cost">
              <span className="cs-cost-num">${spentUsd.toFixed(4)}</span>
              <span className="cs-cost-limit">/ ${budgetLimitUsd.toFixed(2)}</span>
            </div>
            <div className="cs-cost-track">
              <div
                className="cs-cost-fill"
                style={{
                  width: `${budgetPct}%`,
                  background: budgetPct >= 100 ? 'var(--danger)' : budgetPct >= 80 ? 'var(--warn)' : 'var(--accent)',
                }}
              />
            </div>
            <div className="cs-fold-note">网页通道走登录会话、不按 token 计费，所以这里只是 API 侧成本。</div>
          </div>
        </div>
      </details>
    </div>
  )
}
