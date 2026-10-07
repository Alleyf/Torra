import type { ConsensusReportItem, Report, StrategyKind } from './types'
import { HUMAN_AGENT_ID } from './types'

/**
 * 报告骨架的单一来源：同一场研讨换一种策略，读者要拿到的东西不一样。
 *
 * 为什么需要这张表 —— 策略目前只改主持与参会者的角色提示（api-agent.ts:498-503），
 * 底层调度、共识度核算、台账字段三者完全相同。所以「按策略不同」只能是这样：
 * **同一批数据换个主角、换个顺序、换个首要图形**，而不是造出策略专属的指标。
 * 因此这里每个字段都必须能对上一个真实存在的 Report 字段；加不上的就别画。
 *
 * 主进程 Markdown 导出与 renderer 的 ReportViewer 都从这里取，否则会出现
 * 「界面按策略排、导出的 MD 按固定顺序排」—— 用户转发的报告和看到的不是同一份。
 */

/** 报告可重排的章节；「附：运行账目与溯源」永远在末尾，不参与分支 */
export type RpSectionKey =
  | 'summary'
  /** 终局审校加工出的决定/前提/代价/动作。三种策略都要它：换策略换的是看什么，不是要不要落地 */
  | 'decisions'
  | 'consensus'
  | 'disputes'
  | 'participation'
  | 'process'
  | 'intervention'
  | 'blindSpots'
  | 'hallucination'
  | 'baseline'
  | 'actions'

/**
 * 附录固定收纳的章节：它们回答的是「这一场怎么跑的」，不是「所以怎么做」。
 *
 * 留在正文里，一份六千字的报告有三分之一是模型名、轮次和耗时，
 * 而读者打开报告要找的是那条判断凭什么成立。所以它们从策略骨架里移出，
 * 进同一个末尾附录 —— 视图默认折起来，Markdown 没有折叠语法就仍排在最后。
 */
export const APPENDIX_SECTIONS: RpSectionKey[] = ['process', 'participation']

/** hero 上那张主图是哪一种 */
export type RpHeroFigure = 'corroboration' | 'verdict-field' | 'engagement'

/** KPI 的取法：只列真有字段支撑的口径，具体算式在同名函数里 */
export type RpKpiKey =
  | 'standing'
  | 'corroborated'
  | 'verifiable'
  | 'noBasis'
  | 'hardness'
  | 'blind'
  | 'ranked'
  | 'engaged'
  | 'survived'
  | 'overturned'
  | 'duel'
  | 'risk'

export interface ReportShape {
  strategy: StrategyKind
  /** 策略名，界面与导出共用同一个叫法 */
  name: string
  /** 印在 hero 上的那个问题：这份报告存在的理由 */
  question: string
  /** 章节顺序。只重排，不新增没有数据支撑的章节 */
  sections: RpSectionKey[]
  heroFigure: RpHeroFigure
  kpis: RpKpiKey[]
  /** 一句诚实话：这套框架回答不了什么 */
  caveat: string
}

export const REPORT_SHAPES: Record<StrategyKind, ReportShape> = {
  roundtable: {
    strategy: 'roundtable',
    name: '圆桌',
    question: '几家模型各自独立看过之后，互相印证下来了什么？',
    // 参与度与进程进了附录：圆桌的血缘本来就画在 hero 的印证构成上，
    // 再摆一张「谁说了几次」的表只会把同一件事说第三遍
    sections: ['summary', 'decisions', 'consensus', 'disputes', 'hallucination', 'baseline', 'intervention', 'blindSpots', 'actions'],
    heroFigure: 'corroboration',
    kpis: ['standing', 'corroborated', 'verifiable'],
    caveat: '圆桌不安排正面对垒：一条判断没人反驳，可能只是没人接话，不等于它经检验过。',
  },
  review: {
    strategy: 'review',
    name: '评审',
    question: '逐项判定下来，哪些站得住、哪些缺依据、哪些根本没被看到？',
    // 评审的价值一半在「漏了什么」：盲区紧跟结论，不排到末尾去
    sections: ['summary', 'decisions', 'consensus', 'blindSpots', 'disputes', 'hallucination', 'baseline', 'intervention', 'actions'],
    heroFigure: 'verdict-field',
    kpis: ['standing', 'hardness', 'noBasis'],
    // 评审策略在提示词里要求「按既定维度」，但主持输出的 schema 没有 dimension 字段，
    // 报告画不出维度矩阵。这句话必须跟着上屏，否则读者以为逐项判定被跳过了。
    caveat: '本场没有逐维度判定：主持的产出里没有维度标签，报告只能按判断本身归类。',
  },
  debate: {
    strategy: 'debate',
    name: '辩论',
    question: '被正面质询过之后，哪条立场还站得住、哪几条被推翻了？',
    // 辩论场要看的不是说了多少，而是检验得多狠：核验账本紧跟分歧
    sections: ['summary', 'decisions', 'consensus', 'disputes', 'hallucination', 'intervention', 'process', 'participation', 'baseline', 'blindSpots', 'actions'],
    heroFigure: 'engagement',
    kpis: ['standing', 'engaged', 'overturned'],
    caveat: '被反驳过没垮，不等于结论正确：这里的「站住」只指对手没能当场推翻它。',
  },
}

/**
 * 旧存档没有 strategy 字段（`ReportMeta` 是后来才加的这个键）。
 * 按圆桌口径呈现，但要把「未记录」说出来 —— 悄悄当成圆桌，等于替用户宣布他当年选了啥。
 */
export function reportShape(strategy: StrategyKind | null | undefined): { shape: ReportShape; recorded: boolean } {
  const shape = strategy ? REPORT_SHAPES[strategy] : REPORT_SHAPES.roundtable
  return { shape, recorded: Boolean(strategy) }
}

const mid = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

const itemsOf = (r: Report) => r.consensus ?? []

/**
 * 印证构成：多家印证 / 仅一家 / 没给依据，三档互斥且覆盖全部共识条目。
 * 「没给依据」指主持没给 weight（null），不是给了 0 —— 0 是「有依据但薄」，要算进前两档。
 */
export function corroborationBreakdown(r: Report): { multi: number; single: number; total: number } {
  const cs = itemsOf(r)
  const multi = cs.filter((c) => (c.supporterCount ?? 0) >= 2).length
  return { multi, single: cs.length - multi, total: cs.length }
}

/** 依据硬度中位数：0-1；一条 weight 都没有时为 null，界面要显示「未记录」而不是 0 */
export function hardnessMedian(r: Report): number | null {
  const w = itemsOf(r).map((c) => c.weight).filter((w): w is number => typeof w === 'number')
  const m = mid(w)
  return m === null ? null : Math.round(m * 100) / 100
}

/** 没给依据的条目数：评审场最需要看它，因为「判了但没依据」是最容易被读成「判了就行」的那部分 */
export function noBasisCount(r: Report): number {
  return itemsOf(r).filter((c) => c.weight === null || c.weight === undefined).length
}

/**
 * 交锋账本。本场的「交锋」有两处来源：主持记录的挨过质询（crossExamined）、
 * 专项对辩轮（duels / dueled）。被否认或撤回按核验轮结算状态算 —— 查了没答案与没查过要分开。
 */
export function engagementStats(r: Report): {
  crossExamined: number
  survived: number
  overturned: number
  duelRounds: number
  dueledDisputes: number
} {
  const cs = itemsOf(r)
  const denied = (c: (typeof cs)[number]) =>
    !!c.verification && (c.verification.status === 'disputed' || c.verification.status === 'vacated')
  const crossExamined = cs.filter((c) => c.crossExamined).length
  return {
    crossExamined,
    survived: cs.filter((c) => c.crossExamined && !denied(c)).length,
    overturned: cs.filter(denied).length,
    duelRounds: r.meta?.duelCount ?? (r.duels?.length ?? 0),
    dueledDisputes: (r.disputes ?? []).filter((d) => d.dueled).length,
  }
}

export interface Kpi {
  key: RpKpiKey
  label: string
  /** 已是可显示的字符串：数字、百分比或「未记录」，界面不再自行换算 */
  value: string
  hint: string
  tone: 'ok' | 'warn' | 'neutral'
}

function kpiOf(key: RpKpiKey, r: Report): Kpi {
  const cs = itemsOf(r)
  const eng = engagementStats(r)
  switch (key) {
    case 'standing':
      return {
        key,
        label: '立住的判断',
        value: String(cs.length),
        hint: '主持确认过的条目数；台账里逐条能点回原文',
        tone: 'neutral',
      }
    case 'corroborated': {
      const { multi, total } = corroborationBreakdown(r)
      return {
        key,
        label: '被 ≥2 家印证',
        value: total ? `${Math.round((multi / total) * 100)}%` : '无可数的条目',
        hint: '按认同模型数算，1 家说过即算单方，不看主持措辞',
        tone: total === 0 ? 'warn' : multi / Math.max(1, total) >= 0.5 ? 'ok' : 'warn',
      }
    }
    case 'verifiable': {
      const rate = r.meta?.provenance?.coverageRate
      return {
        key,
        label: '认同可核对',
        value: typeof rate === 'number' ? `${rate}%` : '未记录',
        hint: '声称支持的模型里，本人有发言被引为证据的占比',
        tone: typeof rate !== 'number' ? 'warn' : rate >= 60 ? 'ok' : 'warn',
      }
    }
    case 'noBasis':
      return {
        key,
        label: '没给依据',
        value: String(noBasisCount(r)),
        hint: '主持未给证据硬度（weight 为空）的条目，与「硬度为 0」不是一回事',
        tone: noBasisCount(r) > 0 ? 'warn' : 'ok',
      }
    case 'hardness': {
      const m = hardnessMedian(r)
      return {
        key,
        label: '依据硬度中位数',
        value: m === null ? '未记录' : m.toFixed(2),
        hint: '全场 weight 的中位数：一条没给就是没给，不折算成 0',
        tone: m === null ? 'warn' : m >= 0.5 ? 'ok' : 'warn',
      }
    }
    case 'blind':
      return {
        key,
        label: '盲区与未覆盖',
        value: String((r.blindSpots ?? []).length),
        hint: '主持在本场明确登记为「没看到」的方向，不是统计口径外的猜测',
        tone: (r.blindSpots ?? []).length > 0 ? 'warn' : 'neutral',
      }
    case 'ranked':
      return {
        key,
        label: '互评有名次',
        value: `${(r.meta?.leaderboard ?? []).length} 家`,
        hint: '主持给出 agent_quality 名次的模型数；为空表示本场没有名次数据',
        tone: (r.meta?.leaderboard ?? []).length > 0 ? 'neutral' : 'warn',
      }
    case 'engaged':
      return {
        key,
        label: '被正面质询过',
        value: `${eng.crossExamined} / ${cs.length}`,
        hint: '证据发言里被其他模型点名回应过的条目数',
        tone: eng.crossExamined > 0 ? 'ok' : 'warn',
      }
    case 'survived':
      return {
        key,
        label: '质询后仍立住',
        value: `${eng.survived} / ${eng.crossExamined}`,
        hint: '被质询过、且核验轮没有把它否认或撤回',
        tone: eng.crossExamined === 0 ? 'warn' : 'ok',
      }
    case 'overturned':
      return {
        key,
        label: '被否认或撤回',
        value: String(eng.overturned),
        hint: '核验轮结算为「被否认/存疑」或「已撤回」的条目',
        tone: eng.overturned > 0 ? 'warn' : 'ok',
      }
    case 'duel':
      return {
        key,
        label: '专项对辩轮',
        value: String(eng.duelRounds),
        hint: eng.dueledDisputes ? `其中压住 ${eng.dueledDisputes} 条登记的分歧` : '没有分歧在专项对辩里被正面对垒',
        tone: eng.duelRounds > 0 ? 'neutral' : 'warn',
      }
    case 'risk': {
      const v = r.hallucination
      return {
        key,
        label: '错误信号',
        value: v ? String(v.riskScore) : '未测量',
        hint: v ? '本场内部可判死的信号合计（凭空引用、主持代答、空心改写）' : '旧报告未包含幻觉账本',
        tone: !v ? 'warn' : v.riskScore >= 30 ? 'warn' : 'ok',
      }
    }
  }
}

/**
 * 逐条判断的分档：印证家数 × 证据硬度，核验结果作为降档项。
 *
 * 为什么不能再拿「共识结论」兜住整节：一家提出、主持记下的判断，
 * 在台账里和四家印证的判断长得一模一样，读者会以为全场都同意。
 * 分档只读台账已有的字段（supporterCount / weight / verification），
 * 不引入新算式 —— 硬度没给就是没给，不折算成 0。
 */
export type JudgmentTier = 'shared' | 'thin' | 'solo' | 'struck'

export const TIER_ORDER: JudgmentTier[] = ['shared', 'thin', 'solo', 'struck']

export const TIER_META: Record<JudgmentTier, { label: string; note: string }> = {
  shared: { label: '多家印证', note: '≥2 家认同，且主持给的证据硬度不低于 0.5' },
  thin: { label: '多家认同、依据偏薄', note: '家数够，但证据硬度低于 0.5 或主持没给硬度 —— 别按「都同意所以成立」读' },
  solo: { label: '仅一家提出', note: '只有一家的判断，本节不称其为共识' },
  struck: { label: '被否认或撤回', note: '核验轮里本人否认或依据被撤回；仍留在台账里，不让结论静默消失' },
}

export function judgmentTier(c: ConsensusReportItem): JudgmentTier {
  const status = c.verification?.status
  if (status === 'disputed' || status === 'vacated') return 'struck'
  if ((c.supporterCount ?? 0) <= 1) return 'solo'
  if (typeof c.weight !== 'number' || c.weight < 0.5) return 'thin'
  return 'shared'
}

/** 按档分组，保留每条在清单里的原始序号 —— 「依据结论」那一句引用的就是这个序号 */
export function tierGroups(cs: ConsensusReportItem[]): Array<{ tier: JudgmentTier; items: Array<{ index: number; c: ConsensusReportItem }> }> {
  return TIER_ORDER.map((tier) => ({
    tier,
    items: cs.map((c, index) => ({ index, c })).filter((x) => judgmentTier(x.c) === tier),
  })).filter((g) => g.items.length > 0)
}

/**
 * 运行账目：进程、参与度、花了多少、缺席几次。
 *
 * 单份来源 —— 视图与 Markdown 都从这里取。这九个数字过去同时出现在
 * hero 下面的一排、九格表和溯源章节里，还占了报告最靠前的位置：
 * 打开报告先看见「模型名 + 轮次」，看不见任何一条判断凭什么成立。
 */
export function runFigures(r: Report): Array<{ k: string; v: string; warn?: boolean; note?: string }> {
  const cs = r.consensus ?? []
  const ds = r.disputes ?? []
  const shelved = ds.filter((d) => d.shelved).length
  const open = ds.length - shelved
  const out: Array<{ k: string; v: string; warn?: boolean; note?: string }> = [
    { k: '立住的判断', v: String(cs.length) },
    {
      k: '未消解分歧',
      v: String(ds.length),
      warn: ds.length > 0,
      note: ds.length === 0 ? '没有登记在案的不同意见' : shelved > 0 ? `未消解 ${open} · 当场判不了 ${shelved}` : '未消解，需人工裁决',
    },
    { k: '有效发言', v: String(r.stats?.utterances ?? 0) },
    { k: '点名回应', v: String(r.stats?.replyEdges ?? 0) },
    { k: '缺席事件', v: String(r.stats?.absentCount ?? 0), warn: (r.stats?.absentCount ?? 0) > 0 },
    { k: '人工介入', v: String(r.meta?.interventionCount ?? (r.interventions?.length ?? 0)) },
    { k: '专项对辩', v: String(r.meta?.duelCount ?? (r.duels?.length ?? 0)) },
    { k: '墙钟耗时', v: fmtMs(r.meta?.durationMs ?? 0) },
    { k: '费用', v: `$${(r.meta?.totalCostUsd ?? 0).toFixed(4)}`, note: r.meta?.budgetLimited ? '预算触顶' : undefined },
  ]
  // 单方判断的条数直接进账目：它是「这份报告有多少东西其实只有一人看过」的答案
  const solo = cs.filter((c) => judgmentTier(c) === 'solo').length
  if (solo > 0) out.splice(1, 0, { k: '其中仅一家提出', v: String(solo), warn: true })
  return out
}

function fmtMs(ms: number): string {
  if (!ms) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const left = s % 60
  return left ? `${m}m${left}s` : `${m}m`
}

export function heroKpis(strategy: StrategyKind | null | undefined, r: Report): Kpi[] {
  const { shape } = reportShape(strategy)
  return shape.kpis.map((k) => kpiOf(k, r))
}

/** hero 主图的数据：落点图需要每条判断自己的坐标，缺失的点也要返回（画成空心，不隐藏） */
export function verdictField(r: Report): Array<{ claim: string; support: number; hardness: number | null }> {
  return itemsOf(r).map((c) => ({
    claim: c.claim,
    support: Math.max(0, Math.min(100, c.supportRatio ?? 0)),
    hardness: typeof c.weight === 'number' ? Math.max(0, Math.min(1, c.weight)) : null,
  }))
}

/** 对垒弧线：duels 里每一场的双方 id（人类介入不在内，那不是模型间的对撞） */
export function duelPairs(r: Report): Array<{ topic: string; a: string; b: string; utterances: number }> {
  const out: Array<{ topic: string; a: string; b: string; utterances: number }> = []
  for (const d of r.duels ?? []) {
    const ids = (d.agentIds ?? []).filter((x) => x && x !== HUMAN_AGENT_ID).slice(0, 2)
    if (ids.length < 2) continue
    out.push({ topic: d.topic, a: ids[0]!, b: ids[1]!, utterances: d.utteranceCount })
  }
  return out
}

/**
 * Markdown 导出用的行：界面靠图形与图标传达的东西，纯文本里得写成字，
 * 否则导出的那份报告丢了策略，只剩一串并列条目。
 * 返回的行已按 Markdown 段落要求带空行，调用方直接 push 即可。
 */
export function shapeLines(strategy: StrategyKind | null | undefined, r: Report): string[] {
  const { shape, recorded } = reportShape(strategy)
  const out: string[] = [
    `研讨策略：**${shape.name}**${recorded ? '' : '（该报告未记录策略，按圆桌口径呈现）'} —— ${shape.question}`,
    '',
  ]
  for (const k of heroKpis(strategy, r)) out.push(`- ${k.label} **${k.value}** —— ${k.hint}`)
  out.push('', `> ${shape.caveat}`, '')
  return out
}
