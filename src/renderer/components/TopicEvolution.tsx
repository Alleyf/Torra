import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  MessageCircle,
  MessageSquare,
  Pin,
  Play,
  Shield,
  ShieldAlert,
  Square,
  Swords,
  User,
  UserX,
} from 'lucide-react'
import { useStore, type ModelSummary, type UiUtterance } from '../store'
import type { CitationAudit, DiscussionStage } from '@shared/types'
import { FINISH_REASON_LABEL } from '@shared/retry'
import { getFaviconUrls, initials } from './ModelRail'
import { Markdown, MarkdownInline } from './Markdown'
import { formatSpeech, mdExcerpt, plainMd } from '../textFormat'
import { digestStrips, fmtSpan, fmtTokens, fmtUsd, roundStats } from '../discussionDerived'

/**
 * 研讨屏正文：论题演化流（自上而下）+ 一条跟随条。
 *
 * 一条线 = 一次发言，走向来自真实的「点名回应」关系（Utterance.targets）：
 * 往下一格就是一轮，横向挪一格就是观点被另一个模型接住，
 * 线两端各取说话方配色，颜色在哪儿换手就是观点在哪儿被改写。
 * 节点用模型自己的图标，人工介入从左侧虚线插入，最后收到底部的结论轴上。
 *
 * 图是这一屏的主体，正文不再在图底下把同一批发言铺第二遍：跟随条只讲「此刻该看的那一条」——
 * 悬停抢位、离开回落到正在流的最新一条、点击锁定，逐字流就在图上跟着长。
 * 落点（共识 / 分歧）在图上只是结论轴上的点：它的全文、认账的人与核验状态只有右栏台账那一份。
 */

const W = 400
/** 顶部模型图标行：车道图标 + 它下面那行名字。带高由**真正画出来的**图标决定，
 *  不固定留 84vb —— 那是最大图标（56vb）的处方，图标缩到 28vb 时多出来的三十来 vb 是一段空带 */
const LANE_HEAD_Y = 34
const LANE_NAME_H = 17
/** 车道图标比节点图标大一档 */
const LANE_ICO_K = 1.18
const icoOf = (rowH: number) => Math.max(28, Math.min(56, rowH * 0.44))
/** 节点图标的最小可辨尺寸：低于这个像素就不再缩图，改成让舞台滚 */
const MIN_ICO_PX = 24
const headBand = (icoVb: number) => LANE_HEAD_Y + (icoVb * LANE_ICO_K) / 2 + LANE_NAME_H
const X_LABEL = 13
/** 发言列的可使用区间 */
const X_LEFT = 46
const X_RIGHT = 384
/** 行高会按面板可用高度在 [MIN_ROW_H, MAX_ROW_H] 之间拉伸：轮次少时铺满，轮次多时先压缩再滚 */
const MIN_ROW_H = 48
const MAX_ROW_H = 176
const PAD_B = 34
/** 汇入结论轴前的拧股长度 */
const TRUNK_H = 26
/** 人工介入的支线从这里注入 */
const X_IV = 36
/** 落点之间的最小横向间隔 */
const MIN_END_X = 58
/** 每往下一轮，入场推迟这么多毫秒；整张图像水一样从上向下铺开 */
const ROUND_STEP = 140
/** 跟随条正文距底不足这个像素才算「仍在跟读」，逐字流才自动滚到底 */
const STICK_BOTTOM_PX = 40

type Kind = 'consensus' | 'dispute' | 'resolved'

interface Endpoint {
  id: string
  kind: Kind
  claim: string
  meta: string
  sources: string[]
  x: number
}

interface Lane {
  agentId: string
  x: number
  w: number
}

interface Row {
  round: number
  y: number
  h: number
}

interface Edge {
  key: string
  d: string
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
  /** 起点取上一条论点的配色，终点取这条线汇入处的配色 */
  c1: string
  c2: string
  w: number
  dashed: boolean
  kind: 'lineage' | 'seed' | 'human' | Kind
  delay: number
}

const KIND_LABEL: Record<Kind, string> = {
  consensus: '关键判断',
  dispute: '保留分歧',
  resolved: '已消解',
}

const KIND_COLOR: Record<Kind, string> = {
  consensus: 'var(--consensus)',
  dispute: 'var(--dispute)',
  resolved: 'var(--text-4)',
}

const KIND_W: Record<Kind, number> = { consensus: 2.4, dispute: 2.1, resolved: 1.5 }

/** 轴上三种落点的图例顺序：清单退役后，图自己要说清点是什么颜色 */
const KINDS: Kind[] = ['consensus', 'dispute', 'resolved']

const LIVE_STATES = new Set([
  'ROUND_START',
  'AGENT_BATCH',
  'MODERATOR_SUMMARY',
  'MODERATOR_RETRY',
  'CONSENSUS_EVAL',
])

const PHASE_LABEL: Record<string, string> = {
  ROUND_START: '轮次开始',
  AGENT_BATCH: '并行发言中',
  MODERATOR_SUMMARY: '主持小结中',
  MODERATOR_RETRY: '主持重试中',
  CONSENSUS_EVAL: '收敛判定中',
  REPORT_GEN: '生成报告中',
}

/** 粗粒度阶段名：网页批动辄几十秒，没有这一段时界面看着像卡死 */
const STAGE_LABEL: Record<DiscussionStage, string> = {
  'agent-batch': '并行发言',
  moderator: '主持小结',
  consensus: '收敛判定',
  report: '报告生成',
  baseline: '单模型基线',
  verification: '幻觉核验轮',
}

const STANCE_LABEL: Record<string, string> = {
  support: '支持',
  oppose: '反对',
  neutral: '中立',
  conditional: '有条件',
}

/**
 * 结束原因 → 这份结论该怎么用。
 *
 * 「刚好跑完 5 轮」和「第 3 轮就收敛」此前长得一样，但前者意味着报告里的分歧
 * 是没谈完，后者才是谈完了。这一句必须在正文里说，不能等用户翻报告。
 */
const FINISH_HINT: Record<string, string> = {
  converged: '收敛判定过了阈值，结论可以直接采用',
  'max-rounds': '轮次用尽时仍未收敛，报告里的分歧是没谈完，不是谈不拢',
  aborted: '按了终止，结论不完整，报告按部分结果处理',
  'no-moderator': '主持不可用，本场没有共识度评估，只有发言记录',
  failed: '异常终止，已保存跑到当前的结果，可在历史里重试',
}

/** 纵向贝塞尔：先垂直走，再水平换手，读起来才是「往下长」而不是「往右倒」 */
function curve(x1: number, y1: number, x2: number, y2: number, vertical = true): string {
  if (vertical) {
    const my = (y1 + y2) / 2
    return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`
  }
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}

/** 模型图标：优先 favicon，逐源回退，最后落到首字母 */
function ModelIco({ model, size = 11 }: { model?: ModelSummary; size?: number }) {
  const [idx, setIdx] = useState(0)
  const urls = model ? getFaviconUrls(model.domain) : []
  if (!model) return <User size={size} strokeWidth={2.2} />
  if (urls.length > 0 && idx < urls.length) {
    return (
      <img
        src={urls[idx]}
        alt=""
        crossOrigin="anonymous"
        onError={() => setIdx((prev) => prev + 1)}
      />
    )
  }
  return <span className="te-ico-init">{initials(model.displayName)}</span>
}

/** ⏱：单条发言要看得到毫秒级，一轮的墙钟才用 fmtSpan */
function fmtDur(ms?: number): string {
  if (!ms || ms <= 0) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 引用自审的行内摘要。
 *
 * 干净引用不打扰（返回 null）：一场讨论十几条发言，全绿等于全灰。
 * 只在程序判死出问题时出现，判据写进 title 供复算 —— 这是机械核验，不是模型自评。
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

/**
 * 缺席文案拆成「人话」与「技术详情」两段。
 * 后端 content 形如「{name} 未登录… 请在左栏点击其头像重新登录（raw error）」：
 * 名字已在标题处显示，这里去掉冗余前缀；括号内的原始适配器诊断收进可展开区。
 */
function splitAbsent(name: string, content: string): { main: string; detail?: string } {
  const rest = content.startsWith(name) ? content.slice(name.length).trim() : content
  const idx = rest.search(/[（(]/)
  if (idx > 0) {
    const detail = rest.slice(idx + 1).replace(/[）)]\s*$/, '').trim()
    return { main: rest.slice(0, idx).trim(), detail: detail || undefined }
  }
  return { main: rest }
}

/**
 * 选中项挂在 store.focus 上，不由本组件持有：
 * 台账的「定位」要能跨区把图上这条线亮出来，图上点中的落点反过来要让台账同一条描边 ——
 * 状态放在任一側，一切页就丢。kind=claim 时 id 就是结论轴上那个落点。
 */
export function TopicEvolution({
  models,
  onFollowup,
  onDuel,
}: {
  models: ModelSummary[]
  onFollowup: (agentId: string, utteranceId: string, topic: string) => void
  onDuel: (agentId: string, topic: string) => void
}) {
  const allUtterances = useStore((s) => s.utterances)
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const interventions = useStore((s) => s.interventions)
  const participantIds = useStore((s) => s.participantIds)
  const state = useStore((s) => s.state)
  const round = useStore((s) => s.round)
  const maxRounds = useStore((s) => s.maxRounds)
  const focus = useStore((s) => s.focus)
  const setFocus = useStore((s) => s.setFocus)
  const stageTimings = useStore((s) => s.stageTimings)
  const convergenceNote = useStore((s) => s.convergenceNote)
  const finishedReason = useStore((s) => s.finishedReason)
  const moderatorAudit = useStore((s) => s.moderatorAudit)
  const moderatorId = useStore((s) => s.moderatorId)
  const moderatorNote = useStore((s) => s.moderatorNote)

  const [hover, setHover] = useState<string | null>(null)
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)
  const [replayUpto, setReplayUpto] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  /** 跟随条里展开的那一段（思考 / 执行 / 实发输入）：连着发言 id 存，换人时不残留 */
  const [fold, setFold] = useState<{ id: string; key: string } | null>(null)

  const selId = focus?.id ?? null
  const pinUtt = (id: string) =>
    setFocus(focus?.kind === 'utt' && focus.id === id ? null : { kind: 'utt', id })
  const pinEnd = (id: string) =>
    setFocus(focus?.kind === 'claim' && focus.id === id ? null : { kind: 'claim', id })

  /** Esc 是「别再看选中的了」的通用手势：松开锁定，也收起悬停态 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setHover(null)
      setHoverEdge(null)
      setFocus(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setFocus])

  const modelOf = (id: string) => models.find((m) => m.id === id)
  const nameOf = (id: string) => (id === 'human' ? '人工' : modelOf(id)?.displayName ?? id)
  const colorOf = (id: string) =>
    id === 'human' ? 'var(--text-3)' : modelOf(id)?.color ?? 'var(--text-4)'

  /** 缺席占位不是观点，不进图；回放时按轮次截断 */
  const utterances = useMemo(() => {
    const real = allUtterances.filter((u) => !u.absent)
    return replayUpto === null ? real : real.filter((u) => u.round <= replayUpto)
  }, [allUtterances, replayUpto])

  const isEmpty = utterances.length === 0

  const maxRoundInData = useMemo(
    () => allUtterances.reduce((a, u) => Math.max(a, u.round), 0),
    [allUtterances],
  )

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      setReplayUpto((r) => {
        if (r === null) return r
        if (r >= maxRoundInData) {
          setPlaying(false)
          return null
        }
        return r + 1
      })
    }, 1400)
    return () => clearInterval(timer)
  }, [playing, maxRoundInData])

  const startReplay = () => {
    if (playing) {
      setPlaying(false)
      setReplayUpto(null)
      return
    }
    setFocus(null)
    setHover(null)
    setReplayUpto(1)
    setPlaying(true)
  }

  /** 行数按 maxRounds 固定，避免每来一轮整张图重排；回放时轴跟着长回去 */
  const rounds = useMemo(() => {
    const cap = replayUpto ?? round
    const set = new Set<number>(utterances.map((u) => u.round))
    for (let i = 1; i <= Math.max(maxRounds, cap); i++) if (i <= cap) set.add(i)
    return [...set].sort((a, b) => a - b)
  }, [utterances, maxRounds, round, replayUpto])

  /** 量到的可视区域尺寸（px）：用它把图撑满面板，而不是让几行内容缩成一条细线 */
  const stageRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      /** clientWidth 扣掉滚动条槽，才和 .te-flow 的真实宽度一致，图标层才不会偏 */
      const w = el.clientWidth
      const h = el.clientHeight
      setBox((prev) => (Math.abs(prev.w - w) < 3 && Math.abs(prev.h - h) < 3 ? prev : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [isEmpty])

  const { nodes, lanes, rows, trunkTop, axisY, H, ico, laneIco, padT } = useMemo(() => {
    const order: string[] = []
    for (const id of participantIds) if (utterances.some((u) => u.agentId === id)) order.push(id)
    for (const u of utterances) if (!order.includes(u.agentId)) order.push(u.agentId)

    /** 单模型时把车道压到左侧，右边留给发言摘要，不然整张图偏在中间一条线上 */
    const regionR = order.length === 1 ? W * 0.34 : X_RIGHT
    const laneW = order.length ? (regionR - X_LEFT) / order.length : regionR - X_LEFT
    const laneX = (id: string) => {
      const i = order.indexOf(id)
      return X_LEFT + laneW * ((i < 0 ? 0 : i) + 0.5)
    }
    const out: Lane[] = order.map((agentId) => ({ agentId, x: laneX(agentId), w: laneW }))

    /** 把 viewBox 当成「和面板同比例的画布」：先按可用高度定行高，再把余量摊给拧股和轴下 */
    const perPx = box.w > 0 ? W / box.w : 1
    const availVb = box.h > 0 ? box.h * perPx : 0
    const n = Math.max(1, rounds.length)
    const band = (icoVb: number) => headBand(icoVb) + TRUNK_H + PAD_B + 12
    const rowAt = (icoVb: number) => Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, (availVb - band(icoVb)) / n))
    /** 行高→图标→带高是互相引用的：先按最小图标的带估一次行高，定出图标后再回算一次 */
    const nodeIco = icoOf(rowAt(icoOf(MIN_ROW_H)))
    const padT = headBand(nodeIco)
    const rowH = rowAt(nodeIco)
    const nodeSub = nodeIco * 0.78

    const most = rounds.map((r) =>
      Math.max(1, ...order.map((a) => utterances.filter((u) => u.round === r && u.agentId === a).length)),
    )
    const contentH = most.reduce((acc, m) => acc + rowH + (m - 1) * nodeSub, 0)
    const slack = Math.max(0, availVb - band(nodeIco) - contentH)

    const pos = new Map<string, { x: number; y: number }>()
    const rowList: Row[] = []
    let y = padT
    rounds.forEach((r, i) => {
      const inRound = utterances.filter((u) => u.round === r)
      const h = rowH + (most[i]! - 1) * nodeSub
      rowList.push({ round: r, y: y + h / 2, h })
      for (const agentId of order) {
        const mine = inRound
          .filter((u) => u.agentId === agentId)
          .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
        mine.forEach((u, k) => {
          pos.set(u.id, { x: laneX(agentId), y: y + h / 2 + (k - (mine.length - 1) / 2) * nodeSub })
        })
      }
      y += h
    })

    const trunk = y + 12 + slack * 0.45
    const axis = trunk + TRUNK_H + slack * 0.2
    return {
      nodes: pos,
      lanes: out,
      rows: rowList,
      trunkTop: trunk,
      axisY: axis,
      /** 顶部图标带的实际高度：车道图标行和轴上的落点都从这条线以下开始排 */
      padT,
      /** 内容多高就画多高，交给外层的缩放去贴合面板：过去这里垫了 360 的下限，
       *  轮次少的时候是轴底下一段空白 */
      H: axis + PAD_B + slack * 0.3,
      ico: nodeIco,
      laneIco: nodeIco * LANE_ICO_K,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [utterances, rounds, participantIds, box])

  /** 结论行：共识点 / 未决分歧 / 已消解的分歧，沿轴横向排开 */
  const endpoints = useMemo<Endpoint[]>(() => {
    const list: Omit<Endpoint, 'x'>[] = []
    const lastOfAgentInRound = (agentId: string, r: number): string | undefined => {
      const cands = utterances
        .filter((u) => u.agentId === agentId && u.round <= r)
        .sort((a, b) => a.round - b.round)
      return cands[cands.length - 1]?.id
    }
    for (const c of consensus) {
      if (replayUpto !== null && c.confirmedRound > replayUpto) continue
      const known = c.evidenceRef.filter((id) => nodes.has(id))
      const sources = known.length
        ? known
        : c.support.map((a) => lastOfAgentInRound(a, c.confirmedRound)).filter((x): x is string => !!x)
      list.push({
        id: c.id,
        kind: 'consensus',
        claim: c.claim,
        // 落点清单是图的索引，不是结论的副本：谁认同、依据能不能核对，归「共识结果」页说，
        // 这里只给「在第几轮收住、几家点头」，配合车道配色就够定位了。
        meta: `第 ${c.confirmedRound} 轮 · 认同 ${c.support.length} 家`,
        sources,
      })
    }
    for (const d of disputes) {
      if (replayUpto !== null && d.openedRound > replayUpto) continue
      const known = d.sides.flatMap((s) => s.utteranceIds).filter((id) => nodes.has(id))
      const sources = known.length
        ? known
        : d.sides
            .map((s) => lastOfAgentInRound(s.agentId, d.openedRound))
            .filter((x): x is string => !!x)
      list.push({
        id: d.id,
        kind: d.status === 'resolved' ? 'resolved' : 'dispute',
        claim: d.claim,
        meta:
          d.status === 'resolved'
            ? `已消解 · ${d.sides.length} 方`
            : `第 ${d.openedRound} 轮起 · ${d.sides.length} 方${d.lastProgress ? ' · 有新进展' : ''}`,
        sources,
      })
    }
    const withX = list.map((e) => {
      const xs = e.sources.map((id) => nodes.get(id)?.x).filter((v): v is number => v !== undefined)
      return { ...e, x: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : (X_LEFT + X_RIGHT) / 2 }
    })
    withX.sort((a, b) => a.x - b.x)
    const lo = X_LEFT + 4
    const hi = X_RIGHT - 4
    const span = hi - lo
    if (withX.length * MIN_END_X > span) {
      /** 落点挤不下就等距排开，挤得下就顺着来源聚簇走 */
      withX.forEach((e, i) => {
        e.x = lo + ((i + 0.5) * span) / withX.length
      })
    } else {
      let prev = lo
      for (const e of withX) {
        e.x = Math.max(e.x, prev)
        prev = e.x + MIN_END_X
      }
    }
    return withX
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consensus, disputes, nodes, replayUpto, utterances])

  const roundOf = new Map(utterances.map((u) => [u.id, u.round]))
  const maxVisibleRound = rounds.length ? rounds[rounds.length - 1]! : 0
  const live = LIVE_STATES.has(state) && replayUpto === null
  /** 血缘层按轮次推迟，结论层最后收束，读起来才是「演化」而不是一次性铺满 */
  const delayOfRound = (r: number | undefined): number => {
    /** 实时到的那一轮不该再排队：新论点要立刻长出来 */
    if (r !== undefined && live && r === maxVisibleRound) return 200
    return 140 + Math.min(9, Math.max(0, r === undefined ? rounds.length : rounds.indexOf(r))) * ROUND_STEP
  }
  const endIndex = new Map(endpoints.map((e, i) => [e.id, i]))
  const tailBase = delayOfRound(undefined) + 220
  const delayOfEndpoint = (id: string): number => tailBase + (endIndex.get(id) ?? 0) * 90
  /** 图放大时线要跟着变粗，否则大图配细线看着像没画完 */
  const lw = (base: number) => base * Math.min(1.5, Math.max(1, ico / 30))
  /** 起点 strands 从上一格「滴」下来，长度随节点尺寸走 */
  const seedLen = Math.max(16, ico * 0.62)

  const edges = useMemo<Edge[]>(() => {
    const byId = new Map<string, UiUtterance>()
    for (const u of utterances) byId.set(u.id, u)
    const out: Edge[] = []
    const push = (e: Omit<Edge, 'delay'> & { delay?: number }) => {
      out.push({ ...e, delay: e.delay ?? delayOfRound(roundOf.get(e.to)) })
    }

    for (const u of utterances) {
      const to = nodes.get(u.id)
      if (!to) continue
      const named = u.targets
        .map((id) => byId.get(id))
        .filter((p): p is UiUtterance => !!p && !!nodes.get(p.id) && p.round < u.round)
        .slice(0, 3)
      const fallback = utterances
        .filter((p) => p.agentId === u.agentId && p.round < u.round && nodes.has(p.id))
        .sort((a, b) => a.round - b.round)
      const parents = named.length ? named : fallback.length ? [fallback[fallback.length - 1]!] : []

      if (parents.length === 0) {
        const sy = Math.max(12, to.y - seedLen)
        push({
          key: `seed-${u.id}`,
          d: `M ${to.x} ${sy} L ${to.x} ${to.y}`,
          from: `edge-${u.id}`,
          to: u.id,
          x1: to.x,
          y1: sy,
          x2: to.x,
          y2: to.y,
          c1: colorOf(u.agentId),
          c2: colorOf(u.agentId),
          w: lw(1.5),
          dashed: false,
          kind: 'seed',
        })
        continue
      }
      for (const p of parents) {
        const from = nodes.get(p.id)!
        push({
          key: `lin-${p.id}-${u.id}`,
          d: curve(from.x, from.y, to.x, to.y),
          from: p.id,
          to: u.id,
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          c1: colorOf(p.agentId),
          c2: colorOf(u.agentId),
          w: lw(1.8),
          dashed: false,
          kind: 'lineage',
        })
      }
    }

    /** 人类介入：不是模型观点，用虚线支线表示「从这里被外力改写」 */
    for (const iv of interventions) {
      if (iv.status === 'cancelled') continue
      const targetRound = iv.deliveredRound ?? iv.atRound
      if (replayUpto !== null && targetRound > replayUpto) continue
      const row = rows.find((r) => r.round === targetRound)
      const into = utterances.filter(
        (u) =>
          u.round === targetRound &&
          (iv.targetAgentIds.length === 0 ||
            iv.targetAgentIds.includes(u.agentId) ||
            u.agentId === iv.targetAgentId ||
            (iv.duelAgentIds ?? []).includes(u.agentId)),
      )
      const y = row?.y ?? padT + 12
      for (const u of into.slice(0, 4)) {
        const to = nodes.get(u.id)
        if (!to) continue
        push({
          key: `iv-${iv.id}-${u.id}`,
          d: curve(X_IV, y, to.x, to.y, false),
          from: `iv-${iv.id}`,
          to: u.id,
          x1: X_IV,
          y1: y,
          x2: to.x,
          y2: to.y,
          c1: 'var(--accent)',
          c2: colorOf(u.agentId),
          w: lw(1.6),
          dashed: true,
          kind: 'human',
          delay: delayOfRound(targetRound) - 60,
        })
      }
    }

    for (const e of endpoints) {
      const d = delayOfEndpoint(e.id)
      for (const id of e.sources) {
        const from = nodes.get(id)
        if (!from) continue
        out.push({
          key: `end-${id}-${e.id}`,
          d: curve(from.x, from.y, e.x, trunkTop),
          from: id,
          to: e.id,
          x1: from.x,
          y1: from.y,
          x2: e.x,
          y2: trunkTop,
          c1: colorOf(byId.get(id)?.agentId ?? ''),
          c2: KIND_COLOR[e.kind],
          w: lw(1.9),
          dashed: e.kind === 'resolved',
          kind: e.kind,
          delay: d,
        })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [utterances, nodes, interventions, endpoints, replayUpto, rounds, rows, trunkTop, padT])

  const hi = hover ?? selId
  /** 悬停某条线时这条线自己就是焦点：两端一起亮，跟随条并排对照 */
  const focusEdge = hoverEdge ? edges.find((e) => e.key === hoverEdge) : undefined
  const connected = (e: Edge) => e.key === hoverEdge || (hi !== null && (e.from === hi || e.to === hi))
  const looking = hi !== null || focusEdge !== undefined
  /** 线的一端可能是落点而不是发言：两端都是发言时才谈得上「A → B」对照 */
  const pair = (() => {
    if (!focusEdge || hover !== null || focusEdge.kind !== 'lineage') return undefined
    const a = utterances.find((u) => u.id === focusEdge.from)
    const b = utterances.find((u) => u.id === focusEdge.to)
    return a && b ? ([a, b] as const) : undefined
  })()
  const hiEndpoint = pair
    ? undefined
    : endpoints.find((e) => e.id === hi) ??
      (focusEdge ? endpoints.find((e) => e.id === focusEdge.to) : undefined)
  /** 悬停/锁定的是某个发言时，跟随条直接给那条发言的全文，而不是只亮线 */
  const focusUtterance = hiEndpoint ? undefined : utterances.find((u) => u.id === hi)
  const focusAgent = focusUtterance?.agentId
  /** 点名回应挂的是发言 id，印出来就是一串 u1/u2，这里换成「谁 · 第几轮」 */
  const authorOf = (utteranceId: string) => {
    const t = utterances.find((x) => x.id === utteranceId)
    if (!t) return utteranceId
    return `${t.human ? '人类' : nameOf(t.agentId)} · R${t.round}`
  }
  /** 线上挂的人话名字：发言取说话者，落点取类型，介入支线取「人工介入」 */
  const whoOf = (id: string) => {
    const u = utterances.find((x) => x.id === id)
    if (u) return u.human ? '人类' : nameOf(u.agentId)
    const ep = endpoints.find((x) => x.id === id)
    if (ep) return KIND_LABEL[ep.kind]
    return id.startsWith('iv-') ? '人工介入' : '起点'
  }
  /** 发光只给焦点血缘和当前轮，同时亮太多会糊成一团 */
  const isLit = (e: Edge) =>
    connected(e) || (live && e.kind === 'lineage' && roundOf.get(e.to) === maxVisibleRound)
  const lit = edges.filter(isLit)
  /** 虚线支线的出发点：图上要看得见「外力是从哪里插进来的」 */
  const ivMarks = useMemo(() => {
    const m = new Map<string, { id: string; x: number; y: number }>()
    for (const e of edges) if (e.kind === 'human') m.set(e.from, { id: e.from, x: e.x1, y: e.y1 })
    return [...m.values()]
  }, [edges])
  /** 多股血缘在轴上拧成一股：线宽随汇入的发言数增长 */
  const trunks = endpoints.map((e) => ({
    id: e.id,
    kind: e.kind,
    x: e.x,
    w: lw(KIND_W[e.kind]) + Math.min(2.6, e.sources.length * 0.55),
    delay: delayOfEndpoint(e.id) + 240,
  }))
  /** 焦点的直接相连者：压暗时只留这一批 */
  const hiSet = useMemo(() => {
    const set = new Set<string>()
    for (const e of edges) if (connected(e)) set.add(e.from).add(e.to)
    return set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hi, hoverEdge, edges])

  const latestUtt = utterances.length ? utterances[utterances.length - 1] : undefined
  /** 跟随条的空位永远留给「正在流的最新一条」：线对照 > 落点 > 锁定的发言 > 最新 */
  const followUtt = focusUtterance ?? (hiEndpoint ? undefined : latestUtt)
  const card = hiEndpoint ?? (selId ? endpoints.find((e) => e.id === selId) : undefined)

  /** 上方那条状态行：图占了正文，跑批的动静只能收在这一行里 */
  const stats = useMemo(
    () => roundStats(allUtterances, moderatorAudit),
    [allUtterances, moderatorAudit],
  )
  const strips = useMemo(() => digestStrips(moderatorAudit), [moderatorAudit])
  const isRunning = LIVE_STATES.has(state)
  const currentPhase = PHASE_LABEL[state] ?? null
  const currentBatch = allUtterances.filter((u) => u.round === round && !u.human)
  const doneCount = currentBatch.filter((u) => !u.streaming && !u.absent).length
  /** 缺席的发言不进图（它不是一个观点），但「谁没回来、为什么」必须写在脸上 */
  const absentEntries = currentBatch.filter((u) => u.absent)
  const stat = stats.get(round)
  /** 主持那一条：这一轮没有就退回最近一次登记过小结的轮，不编数 */
  const hostStrip = strips.get(round) ?? [...strips.values()].slice(-1)[0]
  const hostWaiting = isRunning && !strips.has(round)
  /**
   * 主持那一条只能由条数与点名指令拼出来：附录 A 里没有「一句话摘要」字段，
   * 编一句散文就是替主持宣布它没说过的事。总数是累计口径，新增数单独算（见 digestStrips）。
   */
  const hostLine = (() => {
    const host = moderatorId ? nameOf(moderatorId) : '主持'
    if (!hostStrip) {
      if (hostWaiting) {
        return (
          <>
            <b>{host}</b> 小结待出：并行发言全部返回后，先过程序校验再登记落点
          </>
        )
      }
      /** 暂停/收束时主持没产出，把它停在哪一句话直接印出来，别留一个空位让人猜 */
      if (moderatorNote) {
        return (
          <>
            <b>{host}</b> 第 {round} 轮没有可登记的小结 · {moderatorNote}
          </>
        )
      }
      return null
    }
    if (!hostStrip.accepted) {
      return (
        <>
          <b>{host}</b> R{hostStrip.round} · 试了 {hostStrip.attempts} 次仍被程序校验拒绝：
          {hostStrip.errors.join('；') || '没有可接受的小结'}，本轮不登记任何落点
        </>
      )
    }
    return (
      <>
        <b>
          {host} R{hostStrip.round}
        </b>
        <span className="te-hf held" title="本轮小结里立住的判断（累计）">
          ◈ {hostStrip.points}
          {hostStrip.newPoints > 0 && <em> +{hostStrip.newPoints} 新</em>}
        </span>
        <span className="te-hf contested" title="本轮小结里的争点（累计）">
          ⊘ {hostStrip.disputes}
          {hostStrip.newDisputes > 0 && <em> +{hostStrip.newDisputes} 新</em>}
        </span>
        {hostStrip.explored > 0 && (
          <span className="te-hf" title="本轮被充分讨论后排除的方向">
            排除 {hostStrip.explored} 向
          </span>
        )}
        {hostStrip.unknownAliases.length > 0 && (
          <span className="te-hf bad" title="主持指名的对象不在本场参会表里">
            指名失效 {hostStrip.unknownAliases.length}
          </span>
        )}
        {hostStrip.callout && (
          <span className="te-hf callout" title={`点名 ${hostStrip.calloutTarget ? nameOf(hostStrip.calloutTarget) : ''}`}>
            <MessageSquare size={10} />
            {hostStrip.calloutTarget ? nameOf(hostStrip.calloutTarget) : '点名'}：{hostStrip.callout}
          </span>
        )}
        <span className="te-hf cost">
          {hostStrip.attempts > 1 && <em title="小结被程序校验驳回后重打">重打 {hostStrip.attempts} 次 · </em>}
          {fmtSpan(hostStrip.ms)} · {fmtUsd(hostStrip.costUsd)}
          {hostStrip.costUsd === 0 && ' 不计费'}
        </span>
      </>
    )
  })()

  /** 跟随条左上角那句「现在给你看的是哪一条」——抢位/锁定/跟读必须说得出区别 */
  const followWhat = pair
    ? `对照：${nameOf(pair[0].agentId)} → ${nameOf(pair[1].agentId)}`
    : hiEndpoint
      ? `${KIND_LABEL[hiEndpoint.kind]} · 落点本身不是一段发言`
      : selId !== null && focusUtterance
        ? `已锁定 ${nameOf(focusUtterance.agentId)} 第 ${focusUtterance.round} 轮`
        : hover && focusUtterance
          ? `悬停预览 ${nameOf(focusUtterance.agentId)}`
          : latestUtt
            ? `跟随最新 · ${nameOf(latestUtt.agentId)} 第 ${latestUtt.round} 轮`
            : '还没有发言'

  const renderCard = (u: UiUtterance, compact: boolean) => {
    const node = nodes.get(u.id)
    return (
      <FollowCard
        key={`${u.id}${compact ? '-pair' : ''}`}
        u={u}
        name={u.human ? '人工' : nameOf(u.agentId)}
        color={colorOf(u.agentId)}
        domain={modelOf(u.agentId)?.domain}
        authorOf={authorOf}
        selected={selId === u.id}
        isLatest={latestUtt?.id === u.id}
        compact={compact}
        anchorX={node ? Math.min(94, Math.max(6, (node.x / W) * 100)) : 50}
        fold={fold?.id === u.id ? fold.key : null}
        onFold={(k) => setFold(k ? { id: u.id, key: k } : null)}
        onLock={() => pinUtt(u.id)}
        onFollowup={onFollowup}
        onDuel={onDuel}
        disputeClaims={disputes.map((d) => d.claim).filter((c) => !!c)}
      />
    )
  }

  /**
   * 缩放取「按宽铺满」和「按高装得下」里小的那个。
   *
   * 过去只按宽定尺（viewBox 宽 400 摊到面板宽）：1390px 的面板就是 3.5 倍，
   * 于是画布高 288vb 要画到 1000px，而舞台只有 330px —— 第二轮以后全在舞台底下，
   * 看起来像被底下的卡片挡住了。行高预算是按高度算的，缩放却是按宽度算的，
   * 这两把尺子必须闭环，否则面板越宽图越大。
   *
   * 闭环之后轮次多的那一场会一路缩到看不清（10 轮时节点只剩 17px），
   * 所以下限按「节点图标不小于 MIN_ICO_PX」收：再装不下就退回舞台自己滚。
   */
  const fit = box.w > 0 && box.h > 0 ? Math.min(box.w / W, box.h / H) : box.w > 0 ? box.w / W : 1
  const s = Math.max(MIN_ICO_PX / ico, fit)
  /** viewBox 映射到像素的同一把尺子：图标层要用 px 才能和 SVG 里的坐标对齐 */
  const px = (vb: number) => vb * s
  /** 只有一条车道时才在节点旁边挂发言摘要，多车道会撞在一起 */
  const showTags = lanes.length === 1
  const tagSize = Math.max(9.5, ico * 0.26)
  const endR = Math.max(5.4, ico * 0.16)
  const tagOf = (u: UiUtterance) => plainMd(u.content, 14)

  return (
    <div className="te">
      <div className="te-head">
        <span className="te-cap">
          {isEmpty
            ? '论题还没有开始分叉'
            : `${utterances.length} 次发言 · ${endpoints.length} 个落点${
                replayUpto !== null ? ` · 回放至 R${replayUpto}` : ''
              }`}
        </span>
        {/* 落点清单退役后，轴上那三种颜色得自己在图上说出名字 */}
        <span className="te-legend">
          {KINDS.map((k) => (
            <span key={k} className={`te-lg te-${k}`}>
              <i className="te-lg-dot" />
              {KIND_LABEL[k]}
            </span>
          ))}
        </span>
        {live && !isEmpty && (
          <span className="te-live">
            <span className="te-blip" />
            正在生长
          </span>
        )}
        {isEmpty ? null : (
          <button className="btn sm te-replay" onClick={startReplay} title="按轮次重放演化过程">
            {playing ? (
              <>
                <Square size={11} /> 停止
              </>
            ) : (
              <>
                <Play size={11} /> 回放
              </>
            )}
          </button>
        )}
      </div>

      {/*
        跑批的动静收在这一行：正文换成图之后，「谁还没回来」「这一轮跑到哪儿」
        「主持登记了什么」都没有了原来的横栏可站，但一条都不许丢。
        逐字流只覆盖正在输出的那几条，网页批动辄几十秒 —— 没有这一段时界面看着像卡死。
      */}
      {(isRunning || finishedReason || hostLine) && (
        <div className="te-status">
          {isRunning && (
            <>
              <span className={`te-phase${currentPhase ? ' live' : ''}`}>
                {currentPhase ? <Loader2 size={11} className="spin" /> : <Check size={11} />}
                {currentPhase ?? '进行中'}
              </span>
              <span className="te-roundnum">
                第 <b>{round}</b> / {maxRounds} 轮
              </span>
              <span className="te-count">
                {doneCount}/{participantIds.length} 已返回
                {stat && !stat.unknown && ` · ⏱ ${fmtSpan(stat.ms)}${stat.partial ? ' 估' : ''}`}
              </span>
              {absentEntries.map((u) => {
                const { main, detail } = splitAbsent(nameOf(u.agentId), u.content)
                return (
                  <span key={u.id} className="te-absent" title={detail ? `${main}\n\n${detail}` : main}>
                    <UserX size={10} /> {nameOf(u.agentId)} 缺席 · {main}
                  </span>
                )
              })}
            </>
          )}
          {stageTimings.length > 0 && (
            <span className="te-timings">
              {stageTimings.slice(-4).map((t, i) => (
                <span
                  key={`${t.round}-${t.stage}-${t.startedAt}-${i}`}
                  className={`te-timing${t.stage === 'verification' ? ' verify' : ''}`}
                  title={`${t.summary ?? ''} · 开始于 ${new Date(t.startedAt).toLocaleTimeString('zh-CN')}`}
                >
                  R{t.round} {STAGE_LABEL[t.stage]} {(t.durationMs / 1000).toFixed(1)}s
                </span>
              ))}
            </span>
          )}
          {/* 收敛判定每轮都发，无论收没收：判据印出来，用户可以对着报告复算 */}
          {convergenceNote && (
            <span className="te-converge">
              {convergenceNote.converged ? <Check size={10} /> : <AlertTriangle size={10} />}
              第 {convergenceNote.round} 轮{convergenceNote.converged ? '判定收敛' : '未收敛'} ·{' '}
              {convergenceNote.text}
            </span>
          )}
          {hostLine && <span className={`te-host${hostStrip && !hostStrip.accepted ? ' bad' : ''}`}>{hostLine}</span>}
        </div>
      )}

      <div className={`te-canvas${live ? ' live' : ''}${looking ? ' focused' : ''}`}>
        {isEmpty ? (
          <div className="te-empty">
            <svg viewBox="0 0 60 200" className="te-empty-svg">
              {[0, 1, 2, 3].map((i) => (
                <path
                  key={i}
                  d={`M ${10 + i * 12} 4 C ${10 + i * 12} ${70 + i * 12}, ${26 - i * 6} ${110 + i * 8}, 30 198`}
                  className="te-drift"
                  style={{ animationDelay: `${i * 0.45}s` }}
                />
              ))}
            </svg>
            <div className="te-empty-text">
              <span className="pulse" />
              等待第一轮发言，之后论题会往下生长
            </div>
          </div>
        ) : (
          <div className="te-stage" ref={stageRef}>
            <div className="te-flow" style={{ width: `${W * s}px`, height: `${H * s}px` }}>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="te-svg"
              onMouseLeave={() => {
                setHover(null)
                setHoverEdge(null)
              }}
              role="img"
              aria-label="论题演化流程图"
            >
              <defs>
                {edges.map((e) => (
                  <linearGradient
                    key={e.key}
                    id={`teg-${e.key}`}
                    gradientUnits="userSpaceOnUse"
                    x1={e.x1}
                    y1={e.y1}
                    x2={e.x2}
                    y2={e.y2}
                  >
                    <stop offset="0%" stopColor={e.c1} stopOpacity={0.55} />
                    <stop offset="58%" stopColor={e.c2} stopOpacity={0.9} />
                    <stop offset="100%" stopColor={e.c2} stopOpacity={1} />
                  </linearGradient>
                ))}
                {endpoints.map((e) => (
                  <linearGradient
                    key={`tet-${e.id}`}
                    id={`tet-${e.id}`}
                    gradientUnits="userSpaceOnUse"
                    x1={e.x}
                    y1={trunkTop}
                    x2={e.x}
                    y2={axisY}
                  >
                    <stop offset="0%" stopColor={KIND_COLOR[e.kind]} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={KIND_COLOR[e.kind]} stopOpacity={1} />
                  </linearGradient>
                ))}
                <linearGradient id="te-axis-grad" gradientUnits="userSpaceOnUse" x1={26} y1={axisY} x2={W - 16} y2={axisY}>
                  <stop offset="0%" stopColor="var(--text-4)" stopOpacity={0} />
                  <stop offset="12%" stopColor="var(--text-4)" stopOpacity={0.55} />
                  <stop offset="88%" stopColor="var(--text-4)" stopOpacity={0.55} />
                  <stop offset="100%" stopColor="var(--text-4)" stopOpacity={0} />
                </linearGradient>
                {/* 当前轮是一横带光，不是一块灰底 */}
                <linearGradient id="te-live-grad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0} />
                  <stop offset="50%" stopColor="var(--accent)" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
                <filter id="te-soft" x="-30%" y="-30%" width="160%" height="160%">
                  <feGaussianBlur stdDeviation="2.6" />
                </filter>
              </defs>

              <g className="te-under">
                {live && (
                  <rect
                    className="te-live-col"
                    x={X_LEFT - 16}
                    y={(rows[rows.length - 1]?.y ?? padT) - (rows[rows.length - 1]?.h ?? MIN_ROW_H) / 2}
                    width={X_RIGHT - X_LEFT + 32}
                    height={rows[rows.length - 1]?.h ?? MIN_ROW_H}
                    rx={18}
                    fill="url(#te-live-grad)"
                  />
                )}
                {lanes.map((l) => (
                  <rect
                    key={`b-${l.agentId}`}
                    className={`te-lane-band${focusAgent && l.agentId !== focusAgent ? ' dim' : ''}`}
                    x={l.x - Math.min(l.w * 0.42, 46)}
                    y={padT - 12}
                    width={Math.min(l.w * 0.84, 92)}
                    height={trunkTop - padT + 4}
                    rx={14}
                    fill={colorOf(l.agentId)}
                  />
                ))}
                {lanes.map((l) => (
                  <line
                    key={l.agentId}
                    className="te-lane-line"
                    x1={l.x}
                    y1={padT - 6}
                    x2={l.x}
                    y2={trunkTop - 4}
                    stroke={colorOf(l.agentId)}
                  />
                ))}
                {rows.map((r, i) => (
                  <line
                    key={`g${r.round}`}
                    className="te-guide"
                    x1={X_LABEL + 14}
                    y1={r.y}
                    x2={X_RIGHT + 8}
                    y2={r.y}
                    style={{ animationDelay: `${100 + Math.min(9, i) * ROUND_STEP}ms` }}
                  />
                ))}
                <line className="te-axis" x1={26} y1={axisY} x2={W - 16} y2={axisY} />
              </g>

              <g className="te-auras">
                {trunks.map((t) => (
                  <path
                    key={`ta-${t.id}`}
                    className={`te-aura te-${t.kind}`}
                    d={`M ${t.x} ${trunkTop} L ${t.x} ${axisY}`}
                    stroke={KIND_COLOR[t.kind]}
                    filter="url(#te-soft)"
                    style={{ animationDelay: `${t.delay + 200}ms` }}
                  />
                ))}
                {lit.map((e) => (
                  <path
                    key={`a-${e.key}`}
                    className={`te-aura te-${e.kind}`}
                    d={e.d}
                    stroke={`url(#teg-${e.key})`}
                    filter="url(#te-soft)"
                    style={{ animationDelay: `${e.delay + 420}ms` }}
                  />
                ))}
              </g>

              <g className="te-lines">
                {edges.map((e) => (
                  <g
                    key={e.key}
                    className={`te-wrap${e.dashed ? ' dashed' : ''}`}
                    style={{ animationDelay: `${e.delay + 200}ms` }}
                  >
                    <path
                      className={`te-edge te-${e.kind}${connected(e) ? ' hi' : ''}`}
                      d={e.d}
                      pathLength={1}
                      stroke={`url(#teg-${e.key})`}
                      strokeWidth={e.w}
                      style={{ animationDelay: `${e.delay}ms` }}
                    />
                    {/* 线只有 1-2px，直接悬停几乎点不中：叠一条透明的宽命中路径 */}
                    <path
                      className="te-hit"
                      d={e.d}
                      strokeWidth={Math.max(12, e.w * 5)}
                      onMouseEnter={() => setHoverEdge(e.key)}
                      onMouseLeave={() => setHoverEdge((cur) => (cur === e.key ? null : cur))}
                    >
                      <title>{`${whoOf(e.from)} → ${whoOf(e.to)}`}</title>
                    </path>
                  </g>
                ))}
              </g>

              <g className="te-flows">
                {lit.map((e) => (
                  <path
                    key={`f-${e.key}`}
                    className={`te-comet te-${e.kind}`}
                    d={e.d}
                    pathLength={1}
                    stroke={`url(#teg-${e.key})`}
                    style={{ animationDelay: `${e.delay + 820}ms` }}
                  />
                ))}
              </g>

              <g className="te-trunks">
                {trunks.map((t) => (
                  <path
                    key={`t-${t.id}`}
                    className={`te-trunk te-${t.kind}${hi === t.id || hiSet.has(t.id) ? ' hi' : ''}`}
                    d={`M ${t.x} ${trunkTop} L ${t.x} ${axisY}`}
                    stroke={`url(#tet-${t.id})`}
                    strokeWidth={t.w}
                    pathLength={1}
                    style={{ animationDelay: `${t.delay}ms` }}
                  />
                ))}
              </g>

              <g className="te-ivs">
                {ivMarks.map((m) => (
                  <g key={m.id}>
                    <circle className="te-iv-dot" cx={m.x} cy={m.y} r={Math.max(4.4, ico * 0.14)} />
                    <text
                      className="te-iv-label"
                      x={m.x}
                      y={m.y + Math.max(16, ico * 0.42)}
                      textAnchor="middle"
                      style={{ fontSize: Math.max(9, ico * 0.28) }}
                    >
                      人
                    </text>
                  </g>
                ))}
              </g>

              <g className="te-ends">
                {endpoints.map((e) => {
                  const active = card?.id === e.id
                  const d = delayOfEndpoint(e.id) + 260
                  const color = KIND_COLOR[e.kind]
                  const r = active ? endR * 1.3 : endR
                  return (
                    <g key={e.id}>
                      <circle
                        className={`te-halo-dot${active || hiSet.has(e.id) ? ' hi' : ''}`}
                        cx={e.x}
                        cy={axisY}
                        r={r * 2.4}
                        fill={color}
                        style={{ animationDelay: `${d}ms` }}
                      />
                      {active && (
                        <>
                          <circle
                            className="te-ripple"
                            cx={e.x}
                            cy={axisY}
                            r={r * 1.7}
                            stroke={color}
                            fill="none"
                            style={{ animationDelay: `${d + 700}ms` }}
                          />
                          <circle
                            className="te-ripple"
                            cx={e.x}
                            cy={axisY}
                            r={r * 1.7}
                            stroke={color}
                            fill="none"
                            style={{ animationDelay: `${d + 2000}ms` }}
                          />
                        </>
                      )}
                      <circle
                        cx={e.x}
                        cy={axisY}
                        r={r}
                        fill={color}
                        fillOpacity={e.kind === 'resolved' ? 0.42 : 1}
                        className={`te-end te-${e.kind}${active ? ' active' : ''}${
                          selId === e.id ? ' sel' : ''
                        }${hiSet.has(e.id) ? ' hi' : ''}`}
                        style={{ animationDelay: `${d}ms` }}
                        tabIndex={0}
                        role="button"
                        aria-pressed={selId === e.id}
                        onFocus={() => setHover(e.id)}
                        onBlur={() => setHover(null)}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter' || ev.key === ' ') {
                            ev.preventDefault()
                            pinEnd(e.id)
                          }
                        }}
                        onMouseEnter={() => setHover(e.id)}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => pinEnd(e.id)}
                      >
                        <title>{`${KIND_LABEL[e.kind]} · ${plainMd(e.claim)}\n点亮它的依据，全文在右侧台账`}</title>
                      </circle>
                    </g>
                  )
                })}
              </g>

              {/* 车道少的时候把发言摘要就挂在节点旁边，图才不会空 */}
              {showTags && (
                <g className="te-tags">
                  {utterances.map((u) => {
                    const p = nodes.get(u.id)
                    if (!p) return null
                    const right = p.x < W / 2
                    return (
                      <text
                        key={`tag-${u.id}`}
                        className={`te-tag${hi === u.id ? ' hi' : ''}`}
                        x={p.x + (right ? ico * 0.72 : -ico * 0.72)}
                        y={p.y + tagSize * 0.34}
                        textAnchor={right ? 'start' : 'end'}
                        style={{
                          fontSize: tagSize,
                          animationDelay: `${delayOfRound(u.round) + 340}ms`,
                        }}
                      >
                        {tagOf(u)}
                        <title>{`${nameOf(u.agentId)} · 第 ${u.round} 轮`}</title>
                      </text>
                    )
                  })}
                </g>
              )}

              {rows.map((r, i) => (
                <text
                  key={r.round}
                  x={X_LABEL}
                  y={r.y + 3}
                  className="te-label"
                  textAnchor="middle"
                  style={{ fontSize: Math.max(11, ico * 0.3), animationDelay: `${80 + Math.min(9, i) * ROUND_STEP}ms` }}
                >
                  R{r.round}
                </text>
              ))}
              <text
                x={26}
                y={axisY - Math.max(9, ico * 0.2)}
                className="te-label strong"
                textAnchor="start"
                style={{ fontSize: Math.max(10, ico * 0.2), animationDelay: `${tailBase}ms` }}
              >
                结论轴
              </text>
              {endpoints.length === 0 && (
                <text
                  x={X_LEFT + 2}
                  y={axisY + Math.max(6, ico * 0.16)}
                  className="te-axis-hint"
                  textAnchor="start"
                  style={{ fontSize: Math.max(10, ico * 0.2) }}
                >
                  还不会有落点：论点先在下方排队，等主席确认共识或分歧才收上来
                </text>
              )}
            </svg>

            {/* 节点用模型自己的图标：一眼看出这条论点是谁说的、被谁接走 */}
            <div className="te-icos">
              {lanes.map((l) => (
                <div
                  key={`h-${l.agentId}`}
                  className="te-lane-head"
                  style={{
                    left: `${(l.x / W) * 100}%`,
                    top: `${((LANE_HEAD_Y - laneIco / 2) / H) * 100}%`,
                  }}
                >
                  <span
                    className="te-ico te-lane-ico"
                    style={{
                      width: `${px(laneIco)}px`,
                      height: `${px(laneIco)}px`,
                      fontSize: `${px(laneIco)}px`,
                      color: colorOf(l.agentId),
                      borderColor: colorOf(l.agentId),
                    }}
                  >
                    <ModelIco model={modelOf(l.agentId)} />
                  </span>
                  <span className="te-lane-name" style={{ fontSize: `${px(Math.max(9.5, ico * 0.24))}px` }}>
                    {nameOf(l.agentId).slice(0, 6)}
                  </span>
                </div>
              ))}
              {utterances.map((u) => {
                const p = nodes.get(u.id)
                if (!p) return null
                const isHuman = u.agentId === 'human' || u.human
                const color = colorOf(u.agentId)
                const isHi = hi === u.id || hiSet.has(u.id)
                const newest = live && u.round === maxVisibleRound
                return (
                  <span
                    key={u.id}
                    className={`te-ico${isHuman ? ' human' : ''}${isHi ? ' hi' : ''}${newest ? ' newest' : ''}${u.streaming ? ' streaming' : ''}${selId === u.id ? ' sel' : ''}`}
                    style={{
                      left: `${(p.x / W) * 100}%`,
                      top: `${(p.y / H) * 100}%`,
                      width: `${px(ico)}px`,
                      height: `${px(ico)}px`,
                      fontSize: `${px(ico)}px`,
                      borderColor: color,
                      animationDelay: `${delayOfRound(u.round) + 240}ms`,
                    }}
                    tabIndex={0}
                    role="button"
                    aria-pressed={selId === u.id}
                    onFocus={() => setHover(u.id)}
                    onBlur={() => setHover(null)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault()
                        pinUtt(u.id)
                      }
                    }}
                    onMouseEnter={() => setHover(u.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => pinUtt(u.id)}
                    title={`${isHuman ? '人类介入' : nameOf(u.agentId)} · 第 ${u.round} 轮\n${plainMd(u.content, 90)}\n点击锁定，跟随条就停在这条`}
                  >
                    <ModelIco model={isHuman ? undefined : modelOf(u.agentId)} />
                    {u.streaming && <span className="te-stream-ring" style={{ borderColor: color }} />}
                  </span>
                )
              })}
            </div>
            </div>
          </div>
        )}

        {!isEmpty && (
        <div className="te-notes">
          <div className="te-follow-head">
            <span className="te-follow-label">{followWhat}</span>
            {selId !== null && (
              <button
                type="button"
                className="te-follow-unpin"
                onClick={() => setFocus(null)}
                title="解除锁定，回到跟随正在流的最新一条（Esc 同）"
              >
                <Pin size={10} /> 取消锁定
              </button>
            )}
          </div>
          <div className={`te-follow${pair ? ' pair' : ''}`}>
            {pair ? (
              <>
                {renderCard(pair[0], true)}
                <span className="te-pair-arrow" aria-hidden="true">
                  →
                </span>
                {renderCard(pair[1], true)}
              </>
            ) : hiEndpoint ? (
              <div
                key={hiEndpoint.id}
                className={`te-card te-point te-${hiEndpoint.kind}`}
                style={
                  {
                    animationDelay: `${delayOfEndpoint(hiEndpoint.id) + 320}ms`,
                    '--anchor-x': `${Math.min(94, Math.max(6, (hiEndpoint.x / W) * 100))}%`,
                  } as CSSProperties
                }
              >
                <div className="te-card-kind">
                  <span className="te-card-mark" />
                  {KIND_LABEL[hiEndpoint.kind]} · 结论轴上的落点，不是一次发言
                </div>
                <div className="te-card-claim">
                  <MarkdownInline text={mdExcerpt(hiEndpoint.claim)} />
                </div>
                <div className="te-card-meta">
                  {hiEndpoint.meta} · 它的 {hiEndpoint.sources.length} 条依据已在图上点亮，其余压暗
                </div>
                <div className="te-card-note">
                  全文、认账的人和依据查不查得到，只在右侧台账这一份 —— 图上不另开详情。
                </div>
              </div>
            ) : followUtt ? (
              selId === followUtt.id && !followUtt.streaming ? (
                /*
                  锁定 = 「这条我要认真读」：正文收成一行指针，全文交给右侧「聚焦」。
                  跟落点同一套规矩 —— 图上给点位，全文只有一份。
                  正在逐字流的那条不收：人得看着它长出来，挪走就等于打断。
                */
                <div
                  key={`pin-${followUtt.id}`}
                  className="te-card te-point te-utt-pin"
                  style={
                    {
                      animationDelay: `${delayOfRound(followUtt.round) + 240}ms`,
                      '--k': colorOf(followUtt.agentId),
                      '--anchor-x': `${Math.min(94, Math.max(6, ((nodes.get(followUtt.id)?.x ?? W / 2) / W) * 100))}%`,
                    } as CSSProperties
                  }
                >
                  <div className="te-card-kind">
                    <span className="te-card-mark" />
                    {followUtt.human ? '人工' : nameOf(followUtt.agentId)} · 第 {followUtt.round} 轮 · 已锁定
                  </div>
                  <div className="te-card-claim">
                    <MarkdownInline text={mdExcerpt(followUtt.content, 72)} />
                  </div>
                  <div className="te-card-note">
                    全文在右侧「聚焦」这一节。取消锁定就回到跟随最新一条。
                  </div>
                </div>
              ) : (
                renderCard(followUtt, false)
              )
            ) : (
              <div className="te-follow-idle">这一场还没有发言。</div>
            )}
          </div>
        </div>
        )}
      </div>

      {/*
        收尾说明挂在图与跟随条之后：讨论结束时人就在底部，
        放到开头等于要他先滚上去才看得到「为什么停」。
      */}
      {!isRunning && finishedReason && (
        <div className={`te-finish${finishedReason === 'converged' ? ' ok' : ''}`}>
          {finishedReason === 'converged' ? <Check size={13} /> : <AlertTriangle size={13} />}
          <b>
            第 {round} 轮结束 · {FINISH_REASON_LABEL[finishedReason] ?? finishedReason}
          </b>
          <span>{FINISH_HINT[finishedReason] ?? '本场已结束，结论以报告为准'}</span>
        </div>
      )}
    </div>
  )
}

/**
 * 跟随条里的那一张卡：图上只有节点，正文只有这一条。
 *
 * 它承担原来「点开才看全文」的全部职责，所以正文不夹断 —— 装得下就整段铺开，
 * 装不下就在卡内滚，只有正在逐字流的那条会自动滚到底（用户往上翻了就归他）。
 * compact 是悬停线上时的并排对照态：这时要读的是两端各说了什么，操作交回单条态。
 */
function FollowCard({
  u,
  name,
  color,
  domain,
  authorOf,
  selected,
  isLatest,
  compact,
  anchorX,
  fold,
  onFold,
  onLock,
  onFollowup,
  onDuel,
  disputeClaims,
}: {
  u: UiUtterance
  name: string
  color: string
  domain?: string
  authorOf: (id: string) => string
  selected: boolean
  isLatest: boolean
  compact: boolean
  anchorX: number
  fold: string | null
  onFold: (key: string | null) => void
  onLock: () => void
  onFollowup: (agentId: string, utteranceId: string, topic: string) => void
  onDuel: (agentId: string, topic: string) => void
  disputeClaims: string[]
}) {
  const [faviconIndex, setFaviconIndex] = useState(0)
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  /** 只有正在流的那条一挂载就跟随；锁定的旧发言停在开头，不把人往下拽 */
  const stickRef = useRef(u.streaming)
  const faviconUrls = getFaviconUrls(domain)
  const duration = u.startedAt && u.endedAt ? u.endedAt - u.startedAt : undefined
  const cite = citeIssue(u.citations)

  const onFollowScroll = () => {
    const el = bodyRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_PX
  }

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const stick = stickRef.current
    if (!stick) return
    el.scrollTop = el.scrollHeight
  }, [u.content])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(u.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用时静默，UI 保持原状态 */
    }
  }

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

  const folds: { key: string; label: string; has: boolean; icon?: ReactNode }[] = [
    { key: 'thinking', label: '思考过程', has: !!u.thinking?.trim() },
    { key: 'steps', label: '执行过程', has: !!u.steps?.trim() },
    {
      key: 'input',
      label: '实发输入',
      has: !!(u.input?.system || u.input?.user),
      icon: <Shield size={10} />,
    },
  ]
  const visibleFolds = folds.filter((f) => f.has)

  return (
    <article
      className={`te-card te-utt${u.streaming ? ' live' : ''}${selected ? ' sel' : ''}${compact ? ' compact' : ''}${u.human ? ' human' : ''}`}
      style={{ '--k': color, '--anchor-x': `${anchorX}%` } as CSSProperties}
      onClick={onLock}
      title={selected ? '已锁定 · 再点回到跟随最新（Esc 同）' : '点击锁定这一条，跟随条不再被新流抢走'}
    >
      <header className="te-card-head">
        <span className="te-card-av" style={{ '--u-color': color } as CSSProperties}>
          <span style={{ color }}>{initials(name)}</span>
          {/* 字母垫底、图标覆盖：内网站点拿不到 favicon 时不会留一个空盒子 */}
          {faviconUrls[faviconIndex] && (
            <img
              src={faviconUrls[faviconIndex]}
              alt=""
              crossOrigin="anonymous"
              onError={() => setFaviconIndex((p) => p + 1)}
            />
          )}
        </span>
        <b className="te-card-name">{name}</b>
        <span className="te-card-round">R{u.round}</span>
        {u.human && <span className="te-card-tag">人工 · 不计入共识度</span>}
        {u.stance && (
          <span className={`te-card-stance te-stance-${u.stance}`}>{STANCE_LABEL[u.stance] ?? u.stance}</span>
        )}
        {u.streaming ? (
          <span className="te-card-tag live">
            <Loader2 size={10} className="spin" /> 流入中
          </span>
        ) : isLatest ? (
          <span className="te-card-tag">最新</span>
        ) : null}
        {selected && (
          <span className="te-card-tag sel">
            <Pin size={9} /> 已锁定
          </span>
        )}
        {u.note && (
          <span className="te-card-warn" title={u.note}>
            <AlertTriangle size={10} />
            {u.note}
          </span>
        )}
        {cite && (
          <span className="te-card-warn bad" title={cite.title}>
            <ShieldAlert size={10} />
            {cite.text}
          </span>
        )}
      </header>

      <div className="te-card-body" ref={bodyRef} onScroll={onFollowScroll}>
        <Markdown text={formatSpeech(u.content)} />
        {u.streaming && <span className="te-caret" />}
      </div>

      {u.targets.length > 0 && <div className="te-card-ref">← 回应 {u.targets.map(authorOf).join('、')}</div>}

      {(visibleFolds.length > 0 || !compact) && (
        <div className="te-card-acts">
          {visibleFolds.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`te-fold-btn${fold === f.key ? ' open' : ''}`}
              onClick={(e) => {
                stop(e)
                onFold(fold === f.key ? null : f.key)
              }}
              title={f.key === 'input' ? '实际发给模型的输入' : undefined}
            >
              {f.icon}
              {f.label}
              <ChevronDown size={10} className={fold === f.key ? 'open' : ''} />
            </button>
          ))}
          {!compact && (
            <span className="te-card-ops">
              <button
                type="button"
                className="te-op"
                onClick={(e) => {
                  stop(e)
                  void copy()
                }}
              >
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {copied ? '已复制' : '复制全文'}
              </button>
              <button
                type="button"
                className="te-op"
                onClick={(e) => {
                  stop(e)
                  onFollowup(u.agentId, u.id, u.content.slice(0, 60))
                }}
              >
                <MessageCircle size={11} /> 就这条追问
              </button>
              {disputeClaims.length > 0 && (
                <button
                  type="button"
                  className="te-op"
                  onClick={(e) => {
                    stop(e)
                    onDuel(u.agentId, disputeClaims[0]!)
                  }}
                >
                  <Swords size={11} /> 对辩
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {fold === 'thinking' && u.thinking?.trim() && (
        <div className="te-fold">
          <div className="te-fold-head">思考过程</div>
          <div className="te-fold-body">
            <Markdown text={u.thinking} />
          </div>
        </div>
      )}
      {fold === 'steps' && u.steps?.trim() && (
        <div className="te-fold">
          <div className="te-fold-head">执行过程</div>
          <pre className="te-fold-pre">{u.steps}</pre>
        </div>
      )}
      {fold === 'input' && (u.input?.system || u.input?.user) && (
        <div className="te-fold">
          <div className="te-fold-head">
            <Shield size={10} /> 实际发给模型的输入
          </div>
          {u.input?.system && <pre className="te-fold-pre">{u.input.system}</pre>}
          {u.input?.user && <pre className="te-fold-pre">{u.input.user}</pre>}
        </div>
      )}

      <footer className="te-card-cost">
        {u.streaming ? (
          <span className="te-num">流式输出中</span>
        ) : (
          <>
            <span className="te-num">⏱ {fmtDur(duration)}</span>
            {/* 网页通道 costUsd 恒为 0：$0 要写成「不计费」，不能看着像这场免费 */}
            <span className={`te-num${(u.usage?.costUsd ?? 0) === 0 ? ' free' : ''}`}>
              {fmtUsd(u.usage?.costUsd ?? 0)}
              {(u.usage?.costUsd ?? 0) === 0 ? ' 不计费' : ''}
            </span>
            <span className="te-num">{fmtTokens((u.usage?.promptTokens ?? 0) + (u.usage?.completionTokens ?? 0))} tok</span>
          </>
        )}
      </footer>
    </article>
  )
}
