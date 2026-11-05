/**
 * 研讨屏右栏第一格：「此刻」。
 *
 * 中间区是过程（谁接住谁、观点在哪儿被改写），右栏是结果。但结果得先有一句
 * 「现在讲的是哪一条」才接得上 —— 这一格就是那句。
 *
 * 读法优先级：点一下锁住的 focus > 指针压着的 hover > 最新一条发言。
 * 三份都挂 store（见 FocusRef），因为中间区与右栏是两个组件树，指针事件只能往 store 送；
 * 放本组件里，鼠标一挪出中间区，这一格就没人更新了。
 *
 * 锁定与悬停在视觉上是两种状态：悬停是预览（细轨、不扫光），锁定是定住（铜轨 + 扫光）。
 * 不分开的话，用户分不清「我点过了」和「我只是路过」—— 而这是右栏唯一的动作来源。
 *
 * 这一格自己订阅 store，不靠父组件传 props：指针扫过中间区时每一格都在换，
 * 让父组件连着整棵台账树一起重渲染，换一次指针就抖一次。
 */
import { useMemo, useState, type CSSProperties } from 'react'
import { useStore, type ModelSummary } from '../store'
import { ARG_BUCKET_HINT, ARG_BUCKET_LABEL, ARG_BUCKET_TONE, buildArgumentMap } from '@shared/argmap'
import { revealFocusedClaim } from './ConsensusPanel'
import { Markdown } from './Markdown'
import { formatSpeech, mdExcerpt } from '../textFormat'
import { fmtSpan, fmtUsd } from '../discussionDerived'
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  Languages,
  MessageCircle,
  Swords,
} from 'lucide-react'
import { useUtteranceTranslation } from '../useUtteranceTranslation'

/** 发言立场 → 一个词。中间区节点上已经有同样一枚，这里是它在右栏的说法 */
const STANCE_LABEL: Record<string, string> = {
  support: '支持',
  oppose: '反驳',
  neutral: '中立',
  conditional: '有条件',
}

/** 折叠阈值：按折起来那几行能装下的字数估，短于它折了也还是全文，就别多一个按钮 */
const FOLD_MIN_CHARS = 160

export function NowCard({ models }: { models: ModelSummary[] }) {
  const utterances = useStore((s) => s.utterances)
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const focus = useStore((s) => s.focus)
  const hover = useStore((s) => s.hover)
  const setFocus = useStore((s) => s.setFocus)
  const setPendingFollowup = useStore((s) => s.setPendingFollowup)

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const colorOf = (id: string) =>
    id === 'human' ? 'var(--rb-quiet)' : models.find((m) => m.id === id)?.color ?? 'var(--rb-quiet)'

  const argmap = useMemo(
    () => buildArgumentMap({ consensus, disputes, utterances }),
    [consensus, disputes, utterances],
  )

  /** 被引用次数：这条发言成了几条判断的依据 */
  const citedBy = (id: string) => argmap.nodes.filter((n) => n.evidence.some((e) => e.utteranceId === id)).length

  /**
   * 此刻讲哪一条。focus 与 hover 共用同一个 FocusRef，但只有 focus 是用户点过的；
   * 两者都没有、或者那个对象已经不在这场讨论里时，退到最新一条 ——
   * 空着的话，右栏第一屏就是一句说明。
   */
  const ref = focus ?? hover
  const pinned = focus !== null
  const stale = ref !== null && !utterances.some((u) => u.id === ref.id) && !argmap.nodes.some((n) => n.id === ref.id)
  const latestUtt = [...utterances].reverse().find((u) => !u.absent)
  const shownUtt =
    ref?.kind === 'utt'
      ? utterances.find((u) => u.id === ref.id) ?? latestUtt
      : stale || ref === null
        ? latestUtt
        : undefined
  const shownClaim = ref?.kind === 'claim' && !stale ? argmap.nodes.find((n) => n.id === ref.id) : undefined

  /** 换人时划一道铜线：读者知道这一格刚被换过，不是自己看漏了。只有锁定时扫。 */
  const sweepKey = focus?.id ?? focus?.kind ?? 'none'

  return (
    <section className="rb-sec rb-now-sec">
      <h4>
        <span className={`rb-now-dot${pinned ? ' on' : ''}`} aria-hidden />
        此刻
        {ref === null && utterances.length > 0 && <span className="rb-now-hint">最新一条</span>}
      </h4>
      {pinned && <i className="rb-sweep" key={sweepKey} aria-hidden />}

      {ref === null && (
        <p className="rb-muted rb-now-lead">
          指针在中间区点一条发言或结论轴上的落点，这一格就讲它：谁说的、依据查不查得到、能对它做什么。
        </p>
      )}

      {shownClaim && (
        <div
          className={`rb-now claim${pinned ? ' pinned' : ' preview'}`}
          style={{ ['--k' as string]: toneColor(shownClaim.bucket) } as CSSProperties}
        >
          <div className="rb-now-kind">
            <span
              className={`cs-badge tone-${ARG_BUCKET_TONE[shownClaim.bucket]}`}
              title={ARG_BUCKET_HINT[shownClaim.bucket]}
            >
              {ARG_BUCKET_LABEL[shownClaim.bucket]}
            </span>
            <span className="rb-now-who">
              {shownClaim.kind === 'dispute'
                ? `${shownClaim.agents.length} 方在争`
                : `${shownClaim.modelCount} 家认账`}
              {shownClaim.humanCount > 0 && ` · 人工 ${shownClaim.humanCount} 条`}
            </span>
          </div>

          <div className="rb-now-claim">
            <Markdown text={shownClaim.claim} />
          </div>

          {shownClaim.kind === 'dispute' && shownClaim.lastProgress && (
            <p className="rb-now-progress">{shownClaim.lastProgress}</p>
          )}

          <div className="rb-now-support">
            {shownClaim.agents.map((id) => (
              <span key={id} className="rb-now-chip" title={`${shownClaim.kind === 'dispute' ? '交锋方' : '支持方'}：${nameOf(id)}`}>
                <i className="rb-dot" style={{ ['--k' as string]: colorOf(id) } as CSSProperties} />
                {nameOf(id)}
              </span>
            ))}
          </div>

          <div className="rb-kv">
            <span>依据</span>
            <span className={`rb-num${shownClaim.missingEvidence > 0 ? ' bad' : ''}`}>
              {shownClaim.evidence.length} 条
              {shownClaim.missingEvidence > 0 && ` · ${shownClaim.missingEvidence} 条查不到原文`}
            </span>
          </div>
          {shownClaim.rounds && (
            <div className="rb-kv">
              <span>覆盖轮次</span>
              <span className="rb-num">
                第 {shownClaim.rounds.from}–{shownClaim.rounds.to} 轮
              </span>
            </div>
          )}

          <div className="rb-acts">
            <button type="button" className="rb-btn pri" onClick={revealFocusedClaim}>
              <ArrowDown size={11} /> 台账里看全文
            </button>
          </div>
        </div>
      )}

      {shownUtt && ref?.kind === 'utt' && (
        <div
          className={`rb-now utt${pinned ? ' pinned' : ' preview'}`}
          style={{ ['--k' as string]: colorOf(shownUtt.agentId) } as CSSProperties}
        >
          <div className="rb-who">
            <i className="rb-dot" />
            <b>{nameOf(shownUtt.agentId)}</b>
            <span className="rb-sub">第 {shownUtt.round} 轮</span>
            {shownUtt.stance && <span className="rb-stance">{STANCE_LABEL[shownUtt.stance] ?? shownUtt.stance}</span>}
          </div>

          {shownUtt.targets.length > 0 && (
            <p className="rb-sub">
              回应 {shownUtt.targets.map((t) => labelOf(utterances, models, t)).join('、')}
            </p>
          )}

          {/*
            全文只在这一份：正文锁定后收成一行指针，读长文的地方就是这里 ——
            中栏窄、卡内自己滚，都不适合把上千字的发言读完。
            key 挂在发言 id 上：换一条就重新折起来，长文不会一路撑开右栏。
          */}
          <SpeechBlock
            key={shownUtt.id}
            utteranceId={shownUtt.id}
            color={colorOf(shownUtt.agentId)}
            text={shownUtt.content}
            streaming={shownUtt.streaming}
            absent={shownUtt.absent}
            human={shownUtt.human}
          />

          <div className="rb-kv">
            <span>成了几条判断的依据</span>
            <span className="rb-num">{citedBy(shownUtt.id)}</span>
          </div>
          <div className="rb-kv">
            <span>代价</span>
            <span className="rb-num">
              {shownUtt.startedAt && shownUtt.endedAt ? fmtSpan(shownUtt.endedAt - shownUtt.startedAt) : '—'} ·{' '}
              {fmtUsd(shownUtt.usage?.costUsd ?? 0)}
            </span>
          </div>
          {shownUtt.citations && !shownUtt.citations.noCitations && (
            <div className="rb-kv">
              <span>程序核验引用</span>
              <span className={`rb-num${bogusCount(shownUtt) ? ' bad' : ''}`}>
                {shownUtt.citations.validUtteranceIds.length} 条可核对
                {bogusCount(shownUtt) > 0 && ` · ${bogusCount(shownUtt)} 条无来源`}
              </span>
            </div>
          )}

          <div className="rb-acts">
            <button
              type="button"
              className="rb-btn pri"
              onClick={() =>
                setPendingFollowup({
                  agentId: shownUtt.agentId,
                  utteranceId: shownUtt.id,
                  topic: shownUtt.content.slice(0, 60),
                  kind: 'followup',
                })
              }
            >
              <MessageCircle size={11} /> 追问 {nameOf(shownUtt.agentId)}
            </button>
            {disputes[0] && (
              <button
                type="button"
                className="rb-btn"
                onClick={() =>
                  setPendingFollowup({
                    agentId: shownUtt.agentId,
                    utteranceId: shownUtt.id,
                    topic: disputes[0]!.claim.slice(0, 60),
                    kind: 'duel',
                  })
                }
              >
                <Swords size={11} /> 对辩
              </button>
            )}
            <button
              type="button"
              className="rb-btn"
              onClick={() => setFocus(focus?.kind === 'utt' && focus.id === shownUtt.id ? null : { kind: 'utt', id: shownUtt.id })}
            >
              <ChevronDown size={11} /> {pinned ? '取消锁定' : '锁定'}
            </button>
          </div>
        </div>
      )}
      {shownUtt && ref === null && (
        <div className="rb-now-peek">
          <span className="rb-now-peek-who">
            <i className="rb-dot" style={{ ['--k' as string]: colorOf(shownUtt.agentId) } as CSSProperties} />
            {nameOf(shownUtt.agentId)} · 第 {shownUtt.round} 轮
            {shownUtt.stance && <span className="rb-stance">{STANCE_LABEL[shownUtt.stance] ?? shownUtt.stance}</span>}
          </span>
          <p className="rb-now-peek-text">{mdExcerpt(shownUtt.content, 72)}</p>
          <button type="button" className="rb-link" onClick={() => setFocus({ kind: 'utt', id: shownUtt.id })}>
            锁定这条
          </button>
        </div>
      )}


      {!shownUtt && !shownClaim && (
        <p className="rb-muted">这场还没有发言 —— 中间区一旦开始流字，这一格就跟着讲。</p>
      )}
    </section>
  )
}

/** 落点轨道色：与台账里那枚徽章同一个 tone，别在这里另起一套 */
function toneColor(bucket: string): string {
  return `var(--rb-${bucket === 'held' ? 'held' : bucket === 'contested' ? 'dispute' : 'quiet'})`
}

/**
 * 此刻里的发言全文：长文默认折成几行，点开才铺满。
 *
 * 折的是高度，不给内滚条 —— 内滚那种读法已经否过一次了；
 * 右栏还要留着给依据、代价这些账，一条上千字的发言先把它们顶出屏外不合理。
 */
function SpeechBlock({
  utteranceId,
  color,
  text,
  streaming,
  absent,
  human,
}: {
  utteranceId: string
  color: string
  text: string
  streaming?: boolean
  absent?: boolean
  human?: boolean
}) {
  const [open, setOpen] = useState(false)
  const translation = useUtteranceTranslation({
    id: utteranceId,
    text,
    streaming,
    absent,
    human,
  })
  const shown = translation.showTranslated && translation.translated ? translation.translated : text
  const foldable = shown.length > FOLD_MIN_CHARS
  return (
    <>
      {(translation.eligible || translation.translated) && (
        <div className={`rb-trans${translation.showTranslated ? ' on' : ''}`}>
          <Languages size={10} />
          <span>
            {translation.busy
              ? '正在译成中文…'
              : translation.failed
                ? '自动译文没出来 —— 原文仍显示在下方，点「重试」再试一次。'
                : translation.showTranslated
                  ? '中文译文'
                  : '模型原文'}
          </span>
          {!translation.busy && translation.translated && (
            <button type="button" className="rb-trans-btn" onClick={translation.toggle}>
              {translation.showTranslated ? '看原文' : '看译文'}
            </button>
          )}
          {!translation.busy && translation.failed && (
            <button type="button" className="rb-trans-btn" onClick={translation.retry}>
              重试
            </button>
          )}
        </div>
      )}
      <div
        className={`rb-speech${foldable && !open ? ' folded' : ''}${streaming ? ' live' : ''}`}
        style={{ ['--k' as string]: color }}
      >
        {/* 流式期间同样渲染 Markdown：逐字读原始 ## / ** 比排版更累人 */}
        <Markdown text={formatSpeech(shown)} />
      </div>
      {foldable && (
        <button type="button" className="rb-fold" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {open ? '收起' : '展开全文'}
        </button>
      )}
    </>
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

