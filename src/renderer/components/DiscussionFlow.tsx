import { useEffect, useRef, useState } from 'react'
import { useStore, type ModelSummary, type UiUtterance } from '../store'
import type { CitationAudit, DiscussionStage } from '@shared/types'
import { FINISH_REASON_LABEL } from '@shared/retry'
import { initials, getFaviconUrls } from './ModelRail'
import { Markdown } from './Markdown'
import { formatSpeech } from '../textFormat'
import {
  MessageCircle,
  Swords,
  AlertTriangle,
  Loader2,
  Clock,
  Users,
  Code2,
  ChevronDown,
  UserX,
  Shield,
  ShieldAlert,
  Send,
  MessageSquare,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowDown,
  DollarSign,
  Brain,
  Wrench,
  Copy,
  Check,
} from 'lucide-react'

/** 超过这个长度就折叠，让议事厅能一屏扫完而不是逐条滚 */
const CLAMP_CHARS = 460

/** 距底部不足这个像素视为「仍在跟读」，自动滚动才继续生效 */
const STICK_BOTTOM_PX = 64

/**
 * 结束原因 → 这份结论该怎么用。
 *
 * 「刚好跑完 5 轮」和「第 3 轮就收敛」在界面上此前长得一样，但前者意味着
 * 报告里的分歧是没谈完，后者才是谈完了。这一句必须在议事厅里说，不能等用户翻报告。
 */
const FINISH_HINT: Record<string, string> = {
  converged: '收敛判定过了阈值，结论可以直接采用',
  'max-rounds': '轮次用尽时仍未收敛，报告里的分歧是没谈完，不是谈不拢',
  aborted: '按了终止，结论不完整，报告按部分结果处理',
  'no-moderator': '主持不可用，本场没有共识度评估，只有发言记录',
  failed: '异常终止，已保存跑到当前的结果，可在历史里重试',
}

const STANCE_LABEL: Record<string, string> = {
  support: '支持',
  oppose: '反对',
  neutral: '中立',
  conditional: '有条件',
}
const PHASE_LABEL: Record<string, string> = {
  ROUND_START: '轮次开始',
  AGENT_BATCH: '并行发言中',
  MODERATOR_SUMMARY: '主持小结中',
  MODERATOR_RETRY: '主持重试中',
  CONSENSUS_EVAL: '收敛判定中',
  REPORT_GEN: '生成报告中',
}

const STAGE_LABEL: Record<DiscussionStage, string> = {
  'agent-batch': '并行发言',
  moderator: '主持小结',
  consensus: '收敛判定',
  report: '报告生成',
  baseline: '单模型基线',
  verification: '幻觉核验轮',
}

const PHASE_ICON: Record<string, React.ReactNode> = {
  ROUND_START: <Clock size={12} />,
  AGENT_BATCH: <Loader2 size={12} className="spin" />,
  MODERATOR_SUMMARY: <Loader2 size={12} className="spin" />,
  MODERATOR_RETRY: <AlertTriangle size={12} />,
  CONSENSUS_EVAL: <Loader2 size={12} className="spin" />,
  REPORT_GEN: <Loader2 size={12} className="spin" />,
}

export function DiscussionFlow({
  models,
  onFollowup,
  onDuel,
}: {
  models: ModelSummary[]
  onFollowup: (agentId: string, utteranceId: string, topic: string) => void
  onDuel: (agentId: string, topic: string) => void
}) {
  const utterances = useStore((s) => s.utterances)
  const moderatorNote = useStore((s) => s.moderatorNote)
  const disputes = useStore((s) => s.disputes)
  const state = useStore((s) => s.state)
  const round = useStore((s) => s.round)
  const maxRounds = useStore((s) => s.maxRounds)
  const participantIds = useStore((s) => s.participantIds)
  const stageTimings = useStore((s) => s.stageTimings)
  const convergenceNote = useStore((s) => s.convergenceNote)
  const finishedReason = useStore((s) => s.finishedReason)
  const ref = useRef<HTMLDivElement>(null)
  /**
   * 贴底才跟随。
   *
   * 早先每次 utterances 变化都无条件 scrollTo 底部：议事厅是逐字流，一秒重排好几回，
   * 用户往上翻看前几轮会被不停拽回来 —— 讨论越长越读不了，翻一次等于跟它抢滚动条。
   * 这里改成「离底就钉住」，滚动条归用户，底部归新发言。
   */
  const [pinned, setPinned] = useState(true)
  const seen = useRef(utterances.length)

  useEffect(() => {
    if (!pinned) return
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    seen.current = utterances.length
  }, [utterances, moderatorNote, pinned, finishedReason])

  const onFlowScroll = () => {
    const el = ref.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_PX)
  }

  const behind = pinned ? 0 : Math.max(0, utterances.length - seen.current)
  const jumpToBottom = () => {
    seen.current = utterances.length
    setPinned(true)
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const colorOf = (id: string) => models.find((m) => m.id === id)?.color ?? 'var(--text-3)'
  const domainOf = (id: string) => models.find((m) => m.id === id)?.domain
  /** 点名回应挂的是发言 id，直接印出来就是一串 u1/u2，这里换成「谁 · 第几轮」 */
  const authorOf = (utteranceId: string) => {
    const t = utterances.find((x) => x.id === utteranceId)
    if (!t) return utteranceId
    return `${t.human ? '人类' : nameOf(t.agentId)} · R${t.round}`
  }

  const rounds = new Map<number, UiUtterance[]>()
  for (const u of utterances) {
    const arr = rounds.get(u.round) ?? []
    arr.push(u)
    rounds.set(u.round, arr)
  }

  // Calculate current round progress
  const currentRoundUtterances = utterances.filter((u) => u.round === round)
  const streamingCount = currentRoundUtterances.filter((u) => u.streaming).length
  const doneCount = currentRoundUtterances.filter((u) => !u.streaming && !u.absent).length
  const absentCount = currentRoundUtterances.filter((u) => u.absent).length
  const totalParticipants = participantIds.length
  const roundProgress = totalParticipants > 0 ? ((doneCount + absentCount) / totalParticipants) * 100 : 0

  const isRunning = state !== 'INIT' && state !== 'READY' && state !== 'DONE' && state !== 'ABORTED' && state !== 'FAILED'
  const currentPhase = PHASE_LABEL[state] ?? null
  const currentPhaseIcon = PHASE_ICON[state] ?? null

  if (utterances.length === 0 && !moderatorNote) {
    return (
      <div className="discussion-flow">
        <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '32px 0', textAlign: 'center' }}>
          等待第一轮发言…
        </div>
      </div>
    )
  }

  return (
    <div className="discussion-flow" ref={ref} onScroll={onFlowScroll}>
      {/* Discussion Status Bar */}
      {/*
        粗粒度阶段耗时：逐字流只覆盖「正在输出的那几条」，而网页批动辄几十秒、
        各模型进度还不一，没有这一段时界面看着像卡死。和状态条一起吸顶，
        滚动到任何位置都能看到「上一批跑了多久、结果如何」。
      */}
      {isRunning && (
        <div className="dsb-wrap">
          <div className="discussion-status-bar">
            <div className="dsb-left">
              {currentPhaseIcon && <span className="dsb-phase-icon">{currentPhaseIcon}</span>}
              <span className="dsb-phase">{currentPhase ?? '进行中'}</span>
            </div>
            <div className="dsb-center">
              <span className="dsb-round">
                第 <b>{round}</b> / {maxRounds} 轮
              </span>
              <div className="dsb-progress-track">
                <div className="dsb-progress-fill" style={{ width: `${roundProgress}%` }} />
              </div>
            </div>
            <div className="dsb-right">
              <Users size={11} />
              <span>
                {doneCount} 已完成
                {streamingCount > 0 && <span className="dsb-streaming"> · {streamingCount} 发言中</span>}
                {absentCount > 0 && <span className="dsb-absent"> · {absentCount} 缺席</span>}
              </span>
            </div>
          </div>
          {stageTimings.length > 0 && (
            <div className="stage-strip">
              {stageTimings.slice(-5).map((t, i) => (
                <span
                  key={`${t.round}-${t.stage}-${t.startedAt}-${i}`}
                  className={`stage-chip${t.stage === 'verification' ? ' verify' : ''}`}
                  title={`${t.summary ?? ''} · 开始于 ${new Date(t.startedAt).toLocaleTimeString('zh-CN')}`}
                >
                  R{t.round} {STAGE_LABEL[t.stage]} · {(t.durationMs / 1000).toFixed(1)}s
                </span>
              ))}
            </div>
          )}
          {/*
            收敛判定每轮都发，无论收没收：没有这一行时「跑了 3 轮还没停」是个谜。
            判据（哪条路径、差多少）直接印出来，用户可以对着报告复算。
          */}
          {convergenceNote && (
            <div className="convergence-line">
              {convergenceNote.converged ? <Check size={11} /> : <AlertTriangle size={11} />}
              <b>第 {convergenceNote.round} 轮{convergenceNote.converged ? '判定收敛' : '未收敛'}</b>
              <span>{convergenceNote.text}</span>
            </div>
          )}
        </div>
      )}

      {[...rounds.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([r, list]) => {
          const isCurrentRound = r === round && isRunning
          return (
            <div key={r} className={`round-group${isCurrentRound ? ' current' : ''}`}>
              <div className={`round-divider${isCurrentRound ? ' active' : ''}`}>
                {isCurrentRound && <span className="round-live-dot" />}
                第 {r} 轮 · {list.length} 条发言
                {isCurrentRound && (
                  <span className="round-progress-text">
                    ({doneCount + absentCount}/{totalParticipants})
                  </span>
                )}
              </div>
              {list.map((u) => (
                <UtteranceCard
                  key={u.id}
                  u={u}
                  name={u.human ? '人类' : nameOf(u.agentId)}
                  color={u.human ? 'var(--text-2)' : colorOf(u.agentId)}
                  domain={u.human ? undefined : domainOf(u.agentId)}
                  authorOf={authorOf}
                  disputes={disputes.map((d) => d.claim)}
                  onFollowup={onFollowup}
                  onDuel={onDuel}
                />
              ))}
            </div>
          )
        })}
      {/*
        收尾说明挂在最后一轮之后：讨论结束时人就在底部，
        放在开头等于要他先滚上去才看得到「为什么停」。
      */}
      {!isRunning && finishedReason && (
        <div className={`flow-finish${finishedReason === 'converged' ? ' ok' : ''}`}>
          {finishedReason === 'converged' ? <Check size={13} /> : <AlertTriangle size={13} />}
          <b>
            第 {round} 轮结束 · {FINISH_REASON_LABEL[finishedReason] ?? finishedReason}
          </b>
          <span>{FINISH_HINT[finishedReason] ?? '本场已结束，结论以报告为准'}</span>
        </div>
      )}
      {moderatorNote && (
        <div className="moderator-note">
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{moderatorNote}</span>
        </div>
      )}
      {/* 钉住时不出这枚按钮；粘性定位让它浮在滚动区底部，点了立刻恢复跟随 */}
      {!pinned && (
        <button type="button" className="df-jump" onClick={jumpToBottom}>
          <ArrowDown size={12} />
          回到底部
          {behind > 0 && <span className="df-jump-count">{behind} 条新发言</span>}
        </button>
      )}
    </div>
  )
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 缺席文案拆成「人话」与「技术详情」两段。
 * 后端 content 形如「{name} 未登录… 请在左栏点击其头像重新登录（raw error）」：
 * 名字已在标题处显示，这里去掉冗余前缀；括号内的原始适配器诊断收进可展开区，
 * 主行只留可读、可操作的一句话。
 */
function splitAbsent(name: string, content: string): { main: string; detail?: string } {
  let rest = content.startsWith(name) ? content.slice(name.length).trim() : content
  const idx = rest.search(/[（(]/)
  if (idx > 0) {
    const detail = rest.slice(idx + 1).replace(/[）)]\s*$/, '').trim()
    return { main: rest.slice(0, idx).trim(), detail: detail || undefined }
  }
  return { main: rest }
}

/** 行内图标操作：议事厅里每条发言都有四五个动作，横排紧凑才不抢正文的注意力 */
function Tool({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`u-tool${active ? ' on' : ''}`}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

/**
 * 引用自审的行内摘要。
 *
 * 干净引用不打扰（返回 null）：一场讨论十几条发言，全绿等于全灰。
 * 只在程序判死出问题时出现，并把判据写进 title 供复算 —— 这是机械核验，不是模型自评。
 */
function citeIssue(c?: CitationAudit): { text: string; title: string } | null {
  if (!c || c.noCitations) return null
  const parts: string[] = []
  if (c.bogusUtteranceIds.length > 0) parts.push(`引用了不存在的发言 ${c.bogusUtteranceIds.join('、')}`)
  if (c.outOfRangeRounds.length > 0) parts.push(`引用了未发生的轮次 R${c.outOfRangeRounds.join('、R')}`)
  if (c.unknownLabels.length > 0) parts.push(`指名的对象不在本场：${c.unknownLabels.join('、')}`)
  if (parts.length === 0) return null
  return {
    text: `存疑引用 ${c.bogusUtteranceIds.length + c.outOfRangeRounds.length + c.unknownLabels.length} 处`,
    title: `程序机械核验：${parts.join('；')}。可引用 ${c.validUtteranceIds.length} 处。`,
  }
}

function UtteranceCard({
  u,
  name,
  color,
  domain,
  authorOf,
  disputes,
  onFollowup,
  onDuel,
}: {
  u: UiUtterance
  name: string
  color: string
  domain?: string
  authorOf: (utteranceId: string) => string
  disputes: string[]
  onFollowup: (agentId: string, utteranceId: string, topic: string) => void
  onDuel: (agentId: string, topic: string) => void
}) {
  const [faviconIndex, setFaviconIndex] = useState(0)
  const [ioOpen, setIoOpen] = useState(false)
  const [thinkOpen, setThinkOpen] = useState(false)
  const [stepsOpen, setStepsOpen] = useState(false)
  const [absentOpen, setAbsentOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const faviconUrls = getFaviconUrls(domain)

  const duration = u.startedAt && u.endedAt ? u.endedAt - u.startedAt : undefined
  const hasInput = !!(u.input?.system || u.input?.user)
  const hasThinking = !!u.thinking?.trim()
  const hasSteps = !!u.steps?.trim()
  /** 流式中的长文不折叠：折叠会和自动滚动打架，看着像卡在半截 */
  const clamped = !u.streaming && u.content.length > CLAMP_CHARS
  const cite = citeIssue(u.citations)

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1500)
    } catch {
      /* 剪贴板不可用时静默，UI 保持原状态 */
    }
  }

  const CopyBtn = ({ label, text }: { label: string; text: string }) => (
    <button
      className="io-copy"
      title={`复制${label}`}
      onClick={() => void copyText(label, text)}
    >
      {copiedKey === label ? <Check size={11} /> : <Copy size={11} />}
      {copiedKey === label ? '已复制' : '复制'}
    </button>
  )

  const renderAvatar = (extraStyle?: React.CSSProperties) => {
    const fav = faviconUrls[faviconIndex]
    return (
      <div className="u-avatar" style={{ '--u-color': color, ...extraStyle } as React.CSSProperties}>
        <span style={{ color }}>{initials(name)}</span>
        {/* 字母垫底、图标覆盖：内网站点拿不到 favicon 时不会留一个空盒子 */}
        {fav && (
          <img src={fav} alt="" crossOrigin="anonymous" onError={() => setFaviconIndex((prev) => prev + 1)} />
        )}
      </div>
    )
  }

  if (u.human) {
    return (
      <div className="utterance human">
        <div className="u-body" style={{ '--u-color': 'var(--text-3)' } as React.CSSProperties}>
          <div className="u-head">
            <div className="u-id">
              {renderAvatar({ borderColor: 'var(--text-4)' })}
              <div className="u-idtext">
                <span className="u-name">人类参与者</span>
                <span className="u-sub">
                  <span className="u-round">R{u.round}</span>
                  <span className="u-flag">插话 · 不计入共识度</span>
                </span>
              </div>
            </div>
          </div>
          <div className="u-content"><Markdown text={u.content} /></div>
        </div>
      </div>
    )
  }

  if (u.absent) {
    const { main, detail } = splitAbsent(name, u.content)
    return (
      <div className="utterance absent">
        <div className="u-absent-row">
          {renderAvatar({ opacity: 0.45 })}
          <span className="u-name">{name}</span>
          <span className="u-round">R{u.round}</span>
          <span className="absent-tag">缺席 · 不计入共识度</span>
          <span className="u-absent-main">
            <UserX size={11} />
            {main}
          </span>
          {detail && (
            <button
              type="button"
              className="absent-detail-toggle"
              onClick={() => setAbsentOpen((v) => !v)}
            >
              {absentOpen ? '收起详情' : '技术详情'}
              <ChevronDown size={10} className={`io-chevron${absentOpen ? ' open' : ''}`} />
            </button>
          )}
        </div>
        {detail && absentOpen && <pre className="absent-detail">{detail}</pre>}
      </div>
    )
  }

  return (
    <div className={`utterance${u.streaming ? ' live' : ''}`}>
      <div className="u-body" style={{ '--u-color': color } as React.CSSProperties}>
        <div className="u-head">
          <div className="u-id">
            {renderAvatar()}
            <div className="u-idtext">
              <span className="u-name">{name}</span>
              <span className="u-sub">
                <span className="u-round">R{u.round}</span>
                {u.stance && (
                  <span className={`stance-tag stance-${u.stance}`}>{STANCE_LABEL[u.stance]}</span>
                )}
                {u.streaming ? (
                  <span className="u-streaming"><Loader2 size={10} className="spin" /> 发言中</span>
                ) : (
                  <>
                    {duration ? <span className="u-metric">{formatDuration(duration)}</span> : null}
                    {u.usage?.costUsd ? (
                      <span className="u-metric">${u.usage.costUsd.toFixed(4)}</span>
                    ) : null}
                  </>
                )}
                {/* 半失败的轮次：答案照常给，但缺了什么必须写在脸上，
                    否则用户只会觉得「这模型答得驴唇不对马嘴」 */}
                {u.note && (
                  <span className="u-note" title={u.note}>
                    <AlertTriangle size={10} />
                    {u.note}
                  </span>
                )}
                {/* 程序机械核验出的凭空引用：当场标出来，不等报告。
                    幻觉越早可见，越不会被下一轮的别的模型当成既定事实接住 */}
                {cite && (
                  <span className="u-note cite-flag" title={cite.title}>
                    <ShieldAlert size={10} />
                    {cite.text}
                  </span>
                )}
              </span>
            </div>
          </div>
          {!u.streaming && (
            <div className="u-tools">
              {(hasInput || hasThinking || hasSteps) && (
                <Tool
                  icon={<Code2 size={13} />}
                  label="输入 / 输出 / 耗时与花费"
                  active={ioOpen}
                  onClick={() => setIoOpen((v) => !v)}
                />
              )}
              <Tool
                icon={copiedKey === '发言' ? <Check size={13} /> : <Copy size={13} />}
                label={copiedKey === '发言' ? '已复制' : '复制这条发言'}
                active={copiedKey === '发言'}
                onClick={() => void copyText('发言', u.content)}
              />
              <Tool
                icon={<MessageCircle size={13} />}
                label="追问：要求该模型就这条再答一轮"
                onClick={() => onFollowup(u.agentId, u.id, u.content.slice(0, 60))}
              />
              {disputes.length > 0 && (
                <Tool
                  icon={<Swords size={13} />}
                  label="对辩：就该议题与另一模型正面交锋"
                  onClick={() => onDuel(u.agentId, disputes[0]!)}
                />
              )}
            </div>
          )}
        </div>

        <div className={`u-content${u.streaming ? ' streaming' : ''}`}>
          <div className={clamped && !expanded ? 'u-clamp' : undefined}>
            <Markdown text={formatSpeech(u.content)} />
          </div>
          {clamped && (
            <button type="button" className="u-expand" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '收起' : `展开全文 · ${u.content.length} 字`}
              <ChevronDown size={11} className={`io-chevron${expanded ? ' open' : ''}`} />
            </button>
          )}
        </div>

        {hasThinking && (
          <div className="think-box">
            <div className="think-head">
              <button className="think-toggle" onClick={() => setThinkOpen((v) => !v)}>
                <Brain size={11} />
                思考过程
                <ChevronDown size={11} className={`io-chevron${thinkOpen || u.streaming ? ' open' : ''}`} />
              </button>
              {/* 收起时复制没意义，还会在行尾孤零零占一块 */}
              {(thinkOpen || u.streaming) && <CopyBtn label="思考" text={u.thinking!} />}
            </div>
            {(thinkOpen || u.streaming) && (
              <div className="think-text">
                <Markdown text={u.thinking!} />
              </div>
            )}
          </div>
        )}

        {hasSteps && (
          <div className="think-box steps-box">
            <div className="think-head">
              <button className="think-toggle" onClick={() => setStepsOpen((v) => !v)}>
                <Wrench size={11} />
                执行过程
                <ChevronDown size={11} className={`io-chevron${stepsOpen || u.streaming ? ' open' : ''}`} />
              </button>
              {(stepsOpen || u.streaming) && <CopyBtn label="步骤" text={u.steps!} />}
            </div>
            {(stepsOpen || u.streaming) && <pre className="think-text">{u.steps}</pre>}
          </div>
        )}

        {u.targets.length > 0 && (
          <div className="u-callout">
            <MessageSquare size={11} style={{ flexShrink: 0 }} />
            <span>回应</span>
            {u.targets.map((t) => (
              <span key={t} className="u-callout-chip">
                {authorOf(t)}
              </span>
            ))}
          </div>
        )}

        {ioOpen && !u.streaming && (
          <div className="io-panel">
            {u.input?.system && (
              <div className="io-block">
                <div className="io-label">
                  <span><Shield size={11} /> 系统提示 · System</span>
                  <CopyBtn label="系统提示" text={u.input.system} />
                </div>
                <pre className="io-text">{u.input.system}</pre>
              </div>
            )}
            {u.input?.user && (
              <div className="io-block">
                <div className="io-label">
                  <span><Send size={11} /> 用户消息 · 发给模型的输入</span>
                  <CopyBtn label="用户输入" text={u.input.user} />
                </div>
                <pre className="io-text">{u.input.user}</pre>
              </div>
            )}
            {hasThinking && (
              <div className="io-block">
                <div className="io-label">
                  <span><Brain size={11} /> 思考过程 · Thinking</span>
                  <CopyBtn label="思考(io)" text={u.thinking!} />
                </div>
                <pre className="io-text thinking">{u.thinking}</pre>
              </div>
            )}
            {hasSteps && (
              <div className="io-block">
                <div className="io-label">
                  <span><Wrench size={11} /> 执行过程 · Steps</span>
                  <CopyBtn label="步骤(io)" text={u.steps!} />
                </div>
                <pre className="io-text steps-text">{u.steps}</pre>
              </div>
            )}
            <div className="io-block">
              <div className="io-label">
                <span><MessageSquare size={11} /> 模型输出</span>
                <CopyBtn label="输出" text={u.content} />
              </div>
              <pre className="io-text output">{u.content}</pre>
            </div>
            <div className="io-stats">
              <span className="io-stat"><Clock size={11} /> {formatDuration(duration)}</span>
              {u.usage && (
                <>
                  <span className="io-stat"><ArrowDownToLine size={11} /> 输入 {u.usage.promptTokens || '—'} tok</span>
                  <span className="io-stat"><ArrowUpFromLine size={11} /> 输出 {u.usage.completionTokens || '—'} tok</span>
                  <span className="io-stat"><DollarSign size={11} /> ${u.usage.costUsd.toFixed(4)}</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
