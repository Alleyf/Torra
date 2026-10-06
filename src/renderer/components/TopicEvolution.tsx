import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Play, Pin, Square, User } from 'lucide-react'
import { useStore, type ModelSummary, type UiUtterance } from '../store'
import { getFaviconUrls, initials } from './ModelRail'
import { MarkdownInline } from './Markdown'
import { mdExcerpt, plainMd } from '../textFormat'

/**
 * 论题演化流（自上而下）。
 *
 * 一条线 = 一次发言，走向来自真实的「点名回应」关系（Utterance.targets）：
 * 往下一格就是一轮，横向挪一格就是观点被另一个模型接住，
 * 线两端各取说话方配色，颜色在哪儿换手就是观点在哪儿被改写。
 * 节点用模型自己的图标，人工介入从左侧虚线插入，最后收到底部的结论轴上。
 */

const W = 400
/** 顶部模型图标行 */
const PAD_T = 84
const LANE_HEAD_Y = 34
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
  consensus: '共识点',
  dispute: '保留分歧',
  resolved: '已消解',
}

const KIND_COLOR: Record<Kind, string> = {
  consensus: 'var(--consensus)',
  dispute: 'var(--dispute)',
  resolved: 'var(--text-4)',
}

const KIND_W: Record<Kind, number> = { consensus: 2.4, dispute: 2.1, resolved: 1.5 }

const LIVE_STATES = new Set([
  'ROUND_START',
  'AGENT_BATCH',
  'MODERATOR_SUMMARY',
  'MODERATOR_RETRY',
  'CONSENSUS_EVAL',
])

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

/**
 * 锁定项由外层（RightPanel）持有：共识结果页点「定位」要跨页把图上这条线亮出来，
 * 自己拿状态的话一切页就丢了。
 */
export function TopicEvolution({
  models,
  pinned,
  onPin,
}: {
  models: ModelSummary[]
  pinned: string | null
  onPin: (id: string | null) => void
}) {
  const allUtterances = useStore((s) => s.utterances)
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const interventions = useStore((s) => s.interventions)
  const participantIds = useStore((s) => s.participantIds)
  const state = useStore((s) => s.state)
  const round = useStore((s) => s.round)
  const maxRounds = useStore((s) => s.maxRounds)

  const [hover, setHover] = useState<string | null>(null)
  const [replayUpto, setReplayUpto] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)

  const togglePin = (id: string) => onPin(pinned === id ? null : id)

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
    onPin(null)
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

  const { nodes, lanes, rows, trunkTop, axisY, H, ico, laneIco } = useMemo(() => {
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
    const fixed = PAD_T + TRUNK_H + PAD_B + 12
    const rowH = Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, (availVb - fixed) / n))
    const nodeIco = Math.max(28, Math.min(56, rowH * 0.44))
    const nodeSub = nodeIco * 0.78

    const most = rounds.map((r) =>
      Math.max(1, ...order.map((a) => utterances.filter((u) => u.round === r && u.agentId === a).length)),
    )
    const contentH = most.reduce((acc, m) => acc + rowH + (m - 1) * nodeSub, 0)
    const slack = Math.max(0, availVb - fixed - contentH)

    const pos = new Map<string, { x: number; y: number }>()
    const rowList: Row[] = []
    let y = PAD_T
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
      /** 内容比面板高就让它滚，比面板矮就正好铺满，不再缩成一条细线 */
      H: Math.max(360, axis + PAD_B + slack * 0.3),
      ico: nodeIco,
      laneIco: nodeIco * 1.18,
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
      const y = row?.y ?? PAD_T + 12
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
  }, [utterances, nodes, interventions, endpoints, replayUpto, rounds, rows, trunkTop])

  const hi = hover ?? pinned
  const hiEndpoint = endpoints.find((e) => e.id === hi)
  /** 悬停/锁定的是某个发言时，卡片直接给那条发言的内容，而不是只亮线 */
  const focusUtterance = hi ? utterances.find((u) => u.id === hi) : undefined
  const focusAgent = focusUtterance?.agentId
  const connected = (e: Edge) => hi !== null && (e.from === hi || e.to === hi)
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
  /** 悬停某个节点时，只留下与它直接相连的那一段血缘 */
  const hiSet = useMemo(() => {
    const set = new Set<string>()
    if (hi) for (const e of edges) if (connected(e)) set.add(e.from).add(e.to)
    return set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hi, edges])

  const latest = useMemo(() => {
    const liveEps = endpoints.filter((e) => e.kind !== 'resolved')
    return liveEps.length ? liveEps[liveEps.length - 1]! : endpoints[0]
  }, [endpoints])
  const card = hiEndpoint ?? (pinned ? endpoints.find((e) => e.id === pinned) : latest)
  const pinnedEndpoint = pinned !== null && endpoints.some((e) => e.id === pinned)
  /** 落点按类型归组：清单先回答「收敛到哪几处、还争什么」，同类内部保留图上从左到右的顺序 */
  const groups = useMemo(() => {
    const order: Kind[] = ['consensus', 'dispute', 'resolved']
    return order
      .map((kind) => ({ kind, items: endpoints.filter((e) => e.kind === kind) }))
      .filter((g) => g.items.length > 0)
  }, [endpoints])
  /** 还没有落点时卡片区显示最新论点，而不是留一块空白 */
  const latestUtt = utterances.length ? utterances[utterances.length - 1] : undefined
  const noteUtt = focusUtterance ?? (card ? undefined : latestUtt)
  /** viewBox 宽 W 映射到实测的像素宽，图标层要用 px 才能和 SVG 里的坐标对齐 */
  const px = (vb: number) => (box.w > 0 ? (vb * box.w) / W : vb)
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

      <div className={`te-canvas${live ? ' live' : ''}${hi ? ' focused' : ''}`}>
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
            <div className="te-flow">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="te-svg"
              onMouseLeave={() => setHover(null)}
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
                    y={(rows[rows.length - 1]?.y ?? PAD_T) - (rows[rows.length - 1]?.h ?? MIN_ROW_H) / 2}
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
                    y={PAD_T - 12}
                    width={Math.min(l.w * 0.84, 92)}
                    height={trunkTop - PAD_T + 4}
                    rx={14}
                    fill={colorOf(l.agentId)}
                  />
                ))}
                {lanes.map((l) => (
                  <line
                    key={l.agentId}
                    className="te-lane-line"
                    x1={l.x}
                    y1={PAD_T - 6}
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
                        className={`te-end te-${e.kind}${active ? ' active' : ''}${hiSet.has(e.id) ? ' hi' : ''}`}
                        style={{ animationDelay: `${d}ms` }}
                        onMouseEnter={() => setHover(e.id)}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => togglePin(e.id)}
                      >
                        <title>{`${KIND_LABEL[e.kind]} · ${plainMd(e.claim)}`}</title>
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
                const focus = hi === u.id || hiSet.has(u.id)
                const newest = live && u.round === maxVisibleRound
                return (
                  <span
                    key={u.id}
                    className={`te-ico${isHuman ? ' human' : ''}${focus ? ' hi' : ''}${newest ? ' newest' : ''}${u.streaming ? ' streaming' : ''}`}
                    style={{
                      left: `${(p.x / W) * 100}%`,
                      top: `${(p.y / H) * 100}%`,
                      width: `${px(ico)}px`,
                      height: `${px(ico)}px`,
                      fontSize: `${px(ico)}px`,
                      borderColor: color,
                      animationDelay: `${delayOfRound(u.round) + 240}ms`,
                    }}
                    onMouseEnter={() => setHover(u.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => togglePin(u.id)}
                    title={`${isHuman ? '人类介入' : nameOf(u.agentId)} · 第 ${u.round} 轮\n${plainMd(u.content, 90)}`}
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
          {noteUtt ? (
            <div
              className="te-card te-utter"
              style={
                {
                  '--k': colorOf(noteUtt.agentId),
                  '--anchor-x': `${Math.min(94, Math.max(6, ((nodes.get(noteUtt.id)?.x ?? W / 2) / W) * 100))}%`,
                } as CSSProperties
              }
            >
              <div className="te-card-kind">
                <span className="te-card-mark" />
                {noteUtt === focusUtterance ? '' : '最新论点 · '}
                {noteUtt.agentId === 'human' || noteUtt.human
                  ? '人类介入'
                  : nameOf(noteUtt.agentId)}
                {` · 第 ${noteUtt.round} 轮`}
              </div>
              <div className="te-card-claim">
                <MarkdownInline text={mdExcerpt(noteUtt.content)} />
              </div>
              <div className="te-card-meta">
                {noteUtt.targets.length
                  ? `回应了 ${noteUtt.targets.length} 条论点`
                  : '这一支的起点'}
              </div>
            </div>
          ) : card ? (
            <div
              key={card.id}
              className={`te-card te-${card.kind}`}
              style={
                {
                  animationDelay: `${delayOfEndpoint(card.id) + 320}ms`,
                  '--anchor-x': `${Math.min(94, Math.max(6, (card.x / W) * 100))}%`,
                } as CSSProperties
              }
            >
              <div className="te-card-kind">
                <span className="te-card-mark" />
                {KIND_LABEL[card.kind]}
              </div>
              <div className="te-card-claim">
                <MarkdownInline text={mdExcerpt(card.claim)} />
              </div>
              <div className="te-card-meta">{card.meta}</div>
            </div>
          ) : null}
        </div>
        )}
      </div>

      {!isEmpty && endpoints.length > 0 && (
        <div className="tl">
          <div className="tl-head">
            <span className="tl-title">结论落点</span>
            {pinnedEndpoint && (
              <button className="tl-unpin" onClick={() => onPin(null)} title="解除锁定，回到跟随最新落点">
                取消锁定
              </button>
            )}
          </div>
          <div className="tl-scroll">
            {groups.map((g) => (
              <section key={g.kind} className={`tl-group tl-${g.kind}`} aria-label={KIND_LABEL[g.kind]}>
                <div className="tl-group-head">
                  <i className="tl-group-dot" />
                  {KIND_LABEL[g.kind]}
                  <span className="tl-group-n">{g.items.length}</span>
                </div>
                <ul className="tl-list">
                  {g.items.map((e) => {
                    const active = card?.id === e.id
                    const isPinned = pinned === e.id
                    return (
                      <li key={e.id}>
                        <button
                          className={`tl-item${active ? ' active' : ''}${isPinned ? ' pinned' : ''}`}
                          aria-pressed={isPinned}
                          style={{ animationDelay: `${delayOfEndpoint(e.id) + 300}ms` }}
                          onMouseEnter={() => setHover(e.id)}
                          onMouseLeave={() => setHover(null)}
                          onFocus={() => setHover(e.id)}
                          onBlur={() => setHover(null)}
                          onClick={() => togglePin(e.id)}
                        >
                          <span className="tl-rail" />
                          <span className="tl-text">
                            <span className="tl-claim">
                              <MarkdownInline text={mdExcerpt(e.claim, 96)} />
                            </span>
                          </span>
                          {isPinned && <Pin className="tl-pin" size={11} strokeWidth={2.2} />}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
