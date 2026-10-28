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
  /**
   * 最终答案：对用户那个问题的答复本身 + 程序核算的置信档位。
   *
   * 三套框架都排第一位，因为这一章就是这场研讨的交付物 —— 用户翻开报告要拿走的
   * 是它，不是「大家商量出了哪些决定」。摘要、台账、审校都在它之后：
   * 那是它的摘要，不是它的替身。
   */
  | 'finalAnswer'
  | 'summary'
  /**
   * 原问题答到了哪一步：逐条子问题的答上／搁置／仍未答。
   *
   * 排在执行摘要之后、终局审校之前 —— 读者翻开报告要找的第一件事是
   * 「我那个问题怎么样了」，不是「大家商量出了哪些决定」。
   */
  | 'answers'
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
 * 介入/核验/对照同理：没有它们结论依然成立，有需要再展开查证。
 */
export const APPENDIX_SECTIONS: RpSectionKey[] = ['process', 'participation', 'intervention', 'hallucination', 'baseline']

/** hero 上那张主图是哪一种 */
export type RpHeroFigure = 'corroboration' | 'verdict-field' | 'engagement'

/** KPI 的取法：只列真有字段支撑的口径，具体算式在同名函数里 */
export type RpKpiKey =
  | 'standing'
  /** 原问题的子问题有几条真答上了：唯一直接对着「用户的问题」算的 KPI */
  | 'answered'
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
    // 正文只留「问题本身答成什么样」：进程/参与度/介入/核验/对照都在附录里，
    // 圆桌的血缘本来就画在 hero 的印证构成上，再摆一张「谁说了几次」只会把同一件事说第三遍
    sections: ['finalAnswer', 'summary', 'answers', 'decisions', 'consensus', 'disputes', 'blindSpots', 'actions'],
    heroFigure: 'corroboration',
    kpis: ['standing', 'corroborated', 'verifiable', 'answered'],
    caveat: '圆桌不安排正面对垒：一条判断没人反驳，可能只是没人接话，不等于它经检验过。',
  },
  review: {
    strategy: 'review',
    name: '评审',
    question: '逐项判定下来，哪些站得住、哪些缺依据、哪些根本没被看到？',
    // 评审的价值一半在「漏了什么」：盲区紧跟结论，不排到末尾去。
    // 核验账本与对照进附录 —— 评审的主图（判定落点）已经把「判了但没依据」画出来了
    sections: ['finalAnswer', 'summary', 'answers', 'decisions', 'consensus', 'blindSpots', 'disputes', 'actions'],
    heroFigure: 'verdict-field',
    kpis: ['standing', 'hardness', 'noBasis', 'answered'],
    // 评审策略在提示词里要求「按既定维度」，但主持输出的 schema 没有 dimension 字段，
    // 报告画不出维度矩阵。这句话必须跟着上屏，否则读者以为逐项判定被跳过了。
    caveat: '本场没有逐维度判定：主持的产出里没有维度标签，报告只能按判断本身归类。',
  },
  debate: {
    strategy: 'debate',
    name: '辩论',
    question: '被正面质询过之后，哪条立场还站得住、哪几条被推翻了？',
    // 辩论场要看的是检验得多狠：主图（检验强度轨道）已经画了质询账，
    // 核验明细与对照进附录 —— 正文只留「哪条立场还站得住」
    sections: ['finalAnswer', 'summary', 'answers', 'decisions', 'consensus', 'disputes', 'blindSpots', 'actions'],
    heroFigure: 'engagement',
    kpis: ['standing', 'engaged', 'overturned', 'answered'],
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

/**
 * 答案覆盖：原问题被拆成的子问题各自答到哪一步。
 *
 * `recorded` 与 `total` 分两件事：旧报告根本没有台账字段，新报告可能有台账但主持
 * 一条子问题都没拆。两者都不能被读成「问题答完了」，但要说的话不一样。
 */
export function answerCoverage(r: Report): {
  recorded: boolean
  total: number
  answered: number
  shelved: number
  open: number
} {
  const qs = r.questions ?? []
  const answered = qs.filter((q) => q.status === 'answered').length
  const shelved = qs.filter((q) => q.status === 'shelved').length
  return { recorded: r.questions !== undefined, total: qs.length, answered, shelved, open: qs.length - answered - shelved }
}

/**
 * 「原问题答到了哪一步」一章的 Markdown 行。
 *
 * 与视图共用 `answerCoverage` 的口径，只在措辞上分头写：条目原文一律逐字，
 * 概括一次就回到「没人对得上一句问」的那个状态。
 */
export function answerLines(r: Report): string[] {
  const qs = r.questions ?? []
  if (r.questions === undefined) {
    return [
      '（这份报告出自**没有问题台账**的版本：当年没有把原问题拆成子问题，报告无法核对它答到了哪一步。）',
    ]
  }
  if (qs.length === 0) {
    return [
      '（本场没有把原问题拆成子问题：下面的结论说明模型之间谈到了哪里，**不说明它们回答了您问的那件事**。）',
    ]
  }
  const open = qs.filter((q) => q.status === 'open')
  const shelved = qs.filter((q) => q.status === 'shelved')
  const answered = qs.filter((q) => q.status === 'answered')
  const out: string[] = [
    `> 原问题拆成 ${qs.length} 条子问题：答上 ${answered.length} 条、当场答不了 ${shelved.length} 条、仍未回答 ${open.length} 条。`,
    '',
  ]
  const group = (title: string, note: string, items: NonNullable<Report['questions']>, kind: 'open' | 'shelved' | 'answered'): void => {
    if (items.length === 0) return
    out.push(`**${title}（${items.length} 条）** —— ${note}`)
    out.push('')
    items.forEach((q, i) => {
      out.push(`${i + 1}. **${q.text}**`)
      if (q.variants && q.variants.length > 0) {
        out.push(`   - 主持换过说法：${q.variants.map((x) => x.replace(/\s+/g, ' ').trim()).join('；')}（同一问题的另一种措辞，未另立条目）`)
      }
      if (kind === 'open') {
        out.push(`   - 第 ${q.addedRound} 轮登记，截至本场结束没有任何一条发言被认定为回答了它`)
      } else if (kind === 'shelved') {
        out.push(
          `   - 第 ${q.disposition?.round ?? q.addedRound} 轮搁置：${q.disposition?.reason ?? '未给理由'}；缺 ${q.disposition?.missing ?? '主持未写明缺什么证据'}`,
        )
      } else {
        out.push(
          `   - 第 ${q.disposition?.round ?? q.addedRound} 轮结案：${q.disposition?.reason ?? '主持未给理由'}`,
        )
        if ((q.resolutionRef ?? []).length === 0) {
          out.push('   - 依据发言：未记录 —— 这条结案无据可查，按未答对待')
        } else if ((q.evidence ?? []).length === 0) {
          out.push('   - 依据发言引用的 id 在本场查不到 —— 这条结案无据可查，按未答对待')
        }
        for (const e of q.evidence ?? []) {
          out.push(`     - ${e.utteranceId} · R${e.round} ${e.displayName}：${e.quote}`)
        }
      }
    })
    out.push('')
  }
  group('仍未回答', '它们不会因为没有结论就消失；报告不把「谈完了」写成「答完了」', open, 'open')
  group('当场答不了', '已搁置，写明缺什么证据 —— 补齐之前，任何声称回答了它的结论都只是推测', shelved, 'shelved')
  group('已答上', '每条由主持指回本场真实发言', answered, 'answered')
  return out
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
    case 'answered': {
      const a = answerCoverage(r)
      if (!a.recorded) {
        return {
          key,
          label: '原问题答上的子问题',
          value: '未登记',
          hint: '这份报告出自没有问题台账的版本，无法核对原问题答到了哪一步',
          tone: 'warn',
        }
      }
      if (a.total === 0) {
        return {
          key,
          label: '原问题答上的子问题',
          value: '未拆出',
          hint: '主持本场没有把原问题拆成子问题：结论再多也不代表它回答了您问的那件事',
          tone: 'warn',
        }
      }
      return {
        key,
        label: '原问题答上的子问题',
        value: `${a.answered} / ${a.total}`,
        hint:
          a.open > 0
            ? `仍有 ${a.open} 条未答` + (a.shelved ? `、${a.shelved} 条当场答不了已搁置` : '')
            : a.shelved
              ? `全部处置完毕，其中 ${a.shelved} 条当场答不了、缺证据`
              : '逐条答上，且每条都指向真实发言',
        tone: a.open > 0 ? 'warn' : 'ok',
      }
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
 * 综合答案摘要：读者打开报告要找的第一件事 —— 「我那个问题怎么样了」。
 *
 * 口径只复用本文件已有的函数（answerCoverage / tierGroups）与 Report 现成字段，
 * 不引入新算式：视图 hero 的答案条与 Markdown 结论区的摘要行都从这里取数，
 * 两边不会一个说「答上 2 条」、另一个说「答上 3 条」。
 */
export interface AnswerDigest {
  recorded: boolean
  total: number
  answered: number
  shelved: number
  open: number
  /** 终局决定条数；没有审校就是 0，但要不要写「无审校」由 hasReview 定 */
  decisions: number
  hasReview: boolean
  /** 被至少一条决定引用的结论数 = 全部结论 − 审校点名的未覆盖 */
  covered: number
  consensusTotal: number
  tiers: Record<JudgmentTier, number>
  disputes: number
  blind: number
}

export function answerDigest(r: Report): AnswerDigest {
  const a = answerCoverage(r)
  const cs = itemsOf(r)
  const tiers: Record<JudgmentTier, number> = { shared: 0, thin: 0, solo: 0, struck: 0 }
  for (const g of tierGroups(cs)) tiers[g.tier] = g.items.length
  const fr = r.finalReview
  const uncovered = fr ? (fr.uncovered ?? []).length : 0
  return {
    recorded: a.recorded,
    total: a.total,
    answered: a.answered,
    shelved: a.shelved,
    open: a.open,
    decisions: fr ? fr.decisions.length : 0,
    hasReview: !!fr,
    covered: Math.max(0, cs.length - uncovered),
    consensusTotal: cs.length,
    tiers,
    disputes: (r.disputes ?? []).length,
    blind: (r.blindSpots ?? []).length,
  }
}

/**
 * 结论区的综合答案行：Markdown 没有 hero 图形，读者靠这几行先拿到「问题本身的综合答案」。
 *
 * 口径与视图的 AnswerStrip 共用 `answerDigest` —— 同一场，两边数字一致。
 * 返回的行已按 Markdown 段落要求带空行，调用方直接 push 即可。
 */
export function answerDigestLines(r: Report): string[] {
  const d = answerDigest(r)
  const out: string[] = ['**综合答案**', '']
  if (!d.recorded) {
    out.push('这份报告出自**没有问题台账**的版本：无法核对原问题答到了哪一步，下面的结论只说明模型之间谈到了哪里。')
  } else if (d.total === 0) {
    out.push('本场没有把原问题拆成子问题：结论再多也不代表它回答了您问的那件事。')
  } else if (d.open > 0) {
    out.push(
      `原问题拆成 ${d.total} 条子问题：答上 ${d.answered} 条、仍有 ${d.open} 条没有回答${d.shelved > 0 ? `、${d.shelved} 条当场答不了` : ''} —— 未答的逐条列在「原问题答到了哪一步」。`,
    )
  } else {
    out.push(
      `原问题拆成的 ${d.total} 条子问题已全部处置：答上 ${d.answered} 条${d.shelved > 0 ? `、当场答不了 ${d.shelved} 条` : ''}。`,
    )
  }
  out.push('')
  const tierBits = TIER_ORDER.map((t) => (d.tiers[t] > 0 ? `${TIER_META[t].label}${d.tiers[t]}条` : null)).filter(
    (x): x is string => x !== null,
  )
  const verdictBits = [
    d.hasReview ? `终局决定 ${d.decisions} 条（覆盖 ${d.covered}/${d.consensusTotal} 条判断）` : '本场没有终局审校',
    d.disputes > 0 ? `未消解分歧 ${d.disputes} 条` : '无保留分歧',
    d.blind > 0 ? `盲区 ${d.blind} 处` : null,
  ].filter((x): x is string => x !== null)
  out.push(`- 判断成色：${tierBits.length > 0 ? tierBits.join(' · ') : '本场没有确认的判断'}`)
  out.push(`- 落地与缺口：${verdictBits.join(' · ')}`)
  out.push('')
  return out
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
  const a = answerCoverage(r)
  const out: Array<{ k: string; v: string; warn?: boolean; note?: string }> = [
    { k: '立住的判断', v: String(cs.length) },
    {
      k: '原问题未答的子问题',
      v: a.recorded ? String(a.open) : '未登记',
      warn: !a.recorded || a.open > 0 || a.shelved > 0,
      note: !a.recorded
        ? '这份报告出自没有问题台账的版本'
        : a.total === 0
          ? '主持未把原问题拆成子问题'
          : a.open > 0
            ? `未答 ${a.open} · 已答 ${a.answered}` + (a.shelved ? ` · 搁置 ${a.shelved}` : '')
            : a.shelved > 0
              ? `无未答，${a.shelved} 条当场答不了、缺证据`
              : '拆出的子问题逐条答上',
    },
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
