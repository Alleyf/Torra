import { useEffect, useRef, useState } from 'react'
import { useStore, type ModelSummary, type UiUtterance } from '../store'
import { initials, getFaviconUrls } from './ModelRail'
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
  Send,
  MessageSquare,
  ArrowDownToLine,
  ArrowUpFromLine,
  DollarSign,
  Brain,
  Copy,
  Check,
} from 'lucide-react'

/**
 * 归一化模型发言文本用于展示。
 *
 * 网页通道抓取时，站点把内联引用编号渲染成独立元素，innerText 会在其前后
 * 各插一个换行，导致正文出现「……-\n4\n。……」这种引用号独占一行、句子竖排割裂。
 * 新抓取已在主进程侧清洗，这里兼容历史已落盘的记录，独占一行的纯数字合并回去。
 */
function cleanText(t: string): string {
  return t ? t.replace(/\n(\d{1,3})\n/g, '$1') : t
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
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [utterances, moderatorNote])

  const nameOf = (id: string) => models.find((m) => m.id === id)?.displayName ?? id
  const colorOf = (id: string) => models.find((m) => m.id === id)?.color ?? 'var(--text-3)'
  const domainOf = (id: string) => models.find((m) => m.id === id)?.domain

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
    <div className="discussion-flow" ref={ref}>
      {/* Discussion Status Bar */}
      {isRunning && (
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
                  nameOf={nameOf}
                  disputes={disputes.map((d) => d.claim)}
                  onFollowup={onFollowup}
                  onDuel={onDuel}
                />
              ))}
            </div>
          )
        })}
      {moderatorNote && (
        <div className="moderator-note">
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{moderatorNote}</span>
        </div>
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

function UtteranceCard({
  u,
  name,
  color,
  domain,
  nameOf,
  disputes,
  onFollowup,
  onDuel,
}: {
  u: UiUtterance
  name: string
  color: string
  domain?: string
  nameOf: (id: string) => string
  disputes: string[]
  onFollowup: (agentId: string, utteranceId: string, topic: string) => void
  onDuel: (agentId: string, topic: string) => void
}) {
  const [faviconIndex, setFaviconIndex] = useState(0)
  const [ioOpen, setIoOpen] = useState(false)
  const [thinkOpen, setThinkOpen] = useState(false)
  const [absentOpen, setAbsentOpen] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const faviconUrls = getFaviconUrls(domain)

  const duration = u.startedAt && u.endedAt ? u.endedAt - u.startedAt : undefined
  const hasInput = !!(u.input?.system || u.input?.user)
  const hasThinking = !!u.thinking?.trim()

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

  const renderAvatar = (extraStyle?: React.CSSProperties) => (
    <div className="u-avatar" style={{ background: 'transparent', border: `1.5px solid ${color}`, ...extraStyle }}>
      {faviconUrls.length > 0 && faviconIndex < faviconUrls.length ? (
        <img
          src={faviconUrls[faviconIndex]}
          alt=""
          crossOrigin="anonymous"
          style={{ width: '70%', height: '70%', objectFit: 'contain' }}
          onError={() => setFaviconIndex((prev) => prev + 1)}
        />
      ) : (
        <span style={{ fontSize: 13, fontWeight: 600, color }}>{initials(name)}</span>
      )}
    </div>
  )

  if (u.human) {
    return (
      <div className="utterance human">
        {renderAvatar({ border: '1.5px solid var(--text-3)', color: 'var(--text-2)' })}
        <div className="u-body" style={{ borderLeftColor: 'var(--text-3)' }}>
          <div className="u-meta">
            <span className="u-name">人类参与者</span>
            <span className="u-round">R{u.round}</span>
            <span className="u-flag">插话 · 不计入共识度</span>
          </div>
          <div className="u-content">{u.content}</div>
        </div>
      </div>
    )
  }

  if (u.absent) {
    const { main, detail } = splitAbsent(name, u.content)
    return (
      <div className="utterance absent">
        {renderAvatar({ opacity: 0.4 })}
        <div className="u-body">
          <div className="u-meta">
            <span className="u-name">{name}</span>
            <span className="u-round">第 {u.round} 轮</span>
            <span className="absent-tag">缺席 · 不计入共识度</span>
          </div>
          <div className="u-absent">
            <UserX size={12} />
            <span>{main}</span>
            {detail && (
              <button
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
      </div>
    )
  }

  return (
    <div className={`utterance${u.streaming ? ' live' : ''}`}>
      {renderAvatar()}
      <div className="u-body" style={{ borderLeftColor: color }}>
        <div className="u-head">
          <div className="u-meta">
            <span className="u-name">{name}</span>
            <span className="u-round">R{u.round}</span>
            {u.stance && (
              <span className={`stance-tag stance-${u.stance}`}>{STANCE_LABEL[u.stance]}</span>
            )}
            {u.streaming && (
              <span className="u-streaming"><Loader2 size={11} className="spin" /> 正在发言…</span>
            )}
          </div>
          {(hasInput || hasThinking) && !u.streaming && (
            <button
              className={`io-toggle${ioOpen ? ' open' : ''}`}
              onClick={() => setIoOpen((v) => !v)}
              title="查看这条发言的输入（发给模型的提示词）、思考与元数据"
            >
              <Code2 size={11} />
              输入/输出
              <ChevronDown size={11} className="io-chevron" />
            </button>
          )}
        </div>

        <div className={`u-content${u.streaming ? ' streaming' : ''}`}>{cleanText(u.content)}</div>

        {hasThinking && (
          <div className="think-box">
            <div className="think-head">
              <button className="think-toggle" onClick={() => setThinkOpen((v) => !v)}>
                <Brain size={11} />
                思考过程
                <ChevronDown size={11} className={`io-chevron${thinkOpen ? ' open' : ''}`} />
              </button>
              <CopyBtn label="思考" text={u.thinking!} />
            </div>
            {thinkOpen && <pre className="think-text">{u.thinking}</pre>}
          </div>
        )}

        {u.targets.length > 0 && (
          <div className="u-callout">
            <AlertTriangle size={12} style={{ flexShrink: 0 }} />
            主持人点名回应：{u.targets.map(nameOf).join('、')}
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

        {!u.streaming && (
          <div className="u-actions">
            <button
              className="btn sm"
              title="要求该模型针对这条发言再答一轮"
              onClick={() => onFollowup(u.agentId, u.id, u.content.slice(0, 60))}
            >
              <MessageCircle size={11} />
              追问
            </button>
            {disputes.length > 0 && (
              <button
                className="btn sm"
                title="就该议题与另一模型直接对辩，突破轮次上限"
                onClick={() => onDuel(u.agentId, disputes[0]!)}
              >
                <Swords size={11} />
                对辩
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
