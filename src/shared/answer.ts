/**
 * 最终答案：草稿校验 + **程序算**置信度。
 *
 * 这一章是整个项目的交付物 —— 用户把一个问题丢进来，要拿走的是这个对象，
 * 不是一堆并列的结论。所以它和别处最大的不同是：**模型只许写内容，分数不归它写**。
 * 理由很具体：一场只有一家公司说过、没有人质询过的判断，模型照样会写「非常有把握」。
 * 这里每一分都来自台账、印证家数、核验结果、错误信号这些已经存在的事实，
 * 每一分都能点回一条可核对的东西 —— 「可信」不能靠自称。
 *
 * 本文件不碰 node:fs，脱机就能测。
 */

import type {
  BaselineVerdict,
  ConsensusReportItem,
  FinalAnswer,
  FinalAnswerConfidence,
  FinalAnswerDraft,
  FinalAnswerLevel,
  FinalAnswerSignal,
  HallucinationTrajectory,
  ReportEvidence,
  ReportFinishedReason,
} from './types'
import { judgmentTier } from './report-shape'

/** 结论正文的长度闸门：超了截断并在末尾标明「已截断」，不装作那就是原文 */
export const FINAL_ANSWER_CONCLUSION_MAX = 1_200
/** 成立/失效条件各最多收几条（与终局审校的决定数同一量级） */
export const FINAL_ANSWER_ITEMS_MAX = 6

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

const trimList = (v: unknown, cap: number): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0)
    .slice(0, cap)

/**
 * 把主持写来的答案落成草稿：引用能解析多少算多少，解析不上的**留痕不编**。
 *
 * 与 `buildFinalReview` 的两点不同，都是有意为之：
 * 1. 依据全空也**不整条丢弃** —— 这是全场唯一的交付物，丢了等于报告里没有答案；
 *    改为置信度直接判 `unrated`，让人看得见「它说了什么」和「它一处都对不上」这两件事；
 * 2. 没有「第二份答案」：只取一份，写多了一律只认第一份并在 rejectedRefs 里说明。
 */
export function buildFinalAnswerDraft(
  raw: unknown,
  points: Array<{ id: string; claim: string }>,
  realUtteranceIds: Set<string>,
): { draft: FinalAnswerDraft | null; rejected: string[] } {
  const rejected: string[] = []
  if (!raw || typeof raw !== 'object') return { draft: null, rejected }
  const row = raw as Record<string, unknown>
  const conclusion = typeof row.conclusion === 'string' ? row.conclusion.trim() : ''
  if (!conclusion) return { draft: null, rejected }

  /** 依据结论：编号 / id / 原文三种写法都认，与决定那条同口径 */
  const byHandle = new Map<string, { id: string; index: number }>()
  points.forEach((p, i) => {
    byHandle.set(String(i + 1), { id: p.id, index: i + 1 })
    byHandle.set(p.id, { id: p.id, index: i + 1 })
    byHandle.set(p.claim.trim(), { id: p.id, index: i + 1 })
  })
  const bases: string[] = []
  for (const handle of trimList(row.based_on, 20)) {
    const hit = byHandle.get(handle.trim())
    if (!hit) {
      rejected.push(`答案引用的结论「${handle}」不在本场清单里，该引用已忽略`)
      continue
    }
    if (!bases.includes(hit.id)) bases.push(hit.id)
  }

  const citations: string[] = []
  for (const id of trimList(row.evidence_ref, 20)) {
    if (!realUtteranceIds.has(id)) {
      rejected.push(`答案引用的发言「${id}」在本场找不到原文，该引用已忽略`)
      continue
    }
    if (!citations.includes(id)) citations.push(id)
  }
  if (bases.length === 0 && citations.length === 0) {
    rejected.push('答案一处依据都没能对上本场的原话：置信度按「无依据可核」计，不作任何升档')
  }

  return {
    draft: {
      conclusion:
        conclusion.length > FINAL_ANSWER_CONCLUSION_MAX
          ? `${conclusion.slice(0, FINAL_ANSWER_CONCLUSION_MAX)}…（此处已截断）`
          : conclusion,
      holds: trimList(row.holds_if, FINAL_ANSWER_ITEMS_MAX),
      breaks: trimList(row.breaks_if, FINAL_ANSWER_ITEMS_MAX),
      bases,
      citations,
      gap: typeof row.gap === 'string' && row.gap.trim() ? row.gap.trim() : null,
      rejectedRefs: rejected,
    },
    rejected,
  }
}

export interface FinalAnswerConfidenceInput {
  draft: FinalAnswerDraft
  /** 已解析成原文的引用（署名与轮次在内） */
  evidence: ReportEvidence[]
  /** 已解析成的结论条目；顺序与 bases 一致 */
  bases: ConsensusReportItem[]
  ledger: { recorded: boolean; total: number; answered: number; shelved: number; open: number }
  riskScore: number | null
  trajectory: HallucinationTrajectory | null
  /** 认同可核对占比 0~100；旧报告没有为 null */
  provenanceCoverage: number | null
  absentCount: number
  budgetLimited: boolean
  timeLimited: boolean
  finishedReason: ReportFinishedReason
  baselineVerdict: BaselineVerdict | null
  speakerCount: number
}

/**
 * 置信度 = 六组判据加分 + 三组过程减分，再套硬性压级。
 *
 * 加分项一律按「占比」给，不按「有没有」给：一条判断被两家印证和被五家印证
 * 不该拿到同一个分。压级单独一列：分数够高但还有子问题没答上时，
 * 读者要看见的是「为什么这条不能当定论用」，不是一串扣掉的数字。
 */
export function computeFinalAnswerConfidence(i: FinalAnswerConfidenceInput): FinalAnswerConfidence {
  const signals: FinalAnswerSignal[] = []
  const caps: string[] = []
  const add = (
    key: string,
    label: string,
    value: string,
    detail: string,
    delta: number,
    tone: FinalAnswerSignal['tone'],
  ): void => {
    signals.push({ key, label, value, detail, delta, tone })
  }

  /** 结论条目本身的档次：多家印证满值，单方提出三折，被否认的不给值 */
  if (i.bases.length > 0) {
    const factor = (b: ConsensusReportItem): number => {
      const t = judgmentTier(b)
      return t === 'shared' ? 1 : t === 'thin' ? 0.6 : t === 'solo' ? 0.3 : 0
    }
    const avg = i.bases.reduce((a, b) => a + factor(b), 0) / i.bases.length
    const delta = Math.round(avg * 30)
    const tiers = i.bases.map((b) => judgmentTier(b))
    add(
      'corroboration',
      '依据的印证广度',
      `${i.bases.length} 条结论 · 折算 ${delta}/30`,
      `其中多家印证 ${tiers.filter((t) => t === 'shared').length} 条、多家但依据偏薄 ${tiers.filter((t) => t === 'thin').length} 条、仅一家提出 ${tiers.filter((t) => t === 'solo').length} 条、被否认或撤回 ${tiers.filter((t) => t === 'struck').length} 条`,
      delta,
      delta >= 20 ? 'ok' : 'warn',
    )
  } else {
    add('corroboration', '依据的印证广度', '没有一条对得上本场结论', '答案没有引用任何一条已确认的结论，无从谈印证', 0, 'warn')
  }

  /** 出处：引用到几家、跨几轮、声称的支持能不能核对上 */
  const agents = new Set(i.evidence.map((e) => e.agentId))
  const rounds = new Set(i.evidence.map((e) => e.round))
  if (i.evidence.length > 0) {
    const breadth = clamp(agents.size / Math.max(2, Math.ceil(i.speakerCount / 2)), 0, 1)
    const spread = rounds.size >= 2 ? 5 : 2
    const prov = typeof i.provenanceCoverage === 'number' ? Math.round((i.provenanceCoverage / 100) * 5) : 0
    const delta = Math.round(breadth * 10) + spread + prov
    add(
      'provenance',
      '出处的覆盖',
      `${agents.size} 家 · ${rounds.size} 轮 · 折算 ${delta}/20`,
      `引用了 ${i.evidence.length} 条原话${typeof i.provenanceCoverage === 'number' ? `；全场「认同可核对」占比 ${i.provenanceCoverage}%` : '；这份报告没有登记认同可核对占比'}${i.draft.rejectedRefs.length > 0 ? `；另有 ${i.draft.rejectedRefs.length} 条引用没能对上原文` : ''}`,
      delta,
      agents.size >= 2 && rounds.size >= 2 ? 'ok' : 'warn',
    )
  } else {
    add('provenance', '出处的覆盖', '无可核对出处', '答案没有一条引用能落回本场的真实发言，报告只能原样转述它', 0, 'warn')
  }

  /** 核验：被本人确认 / 被否认撤回 / 压根没查，三种必须给不同的分 */
  if (i.bases.length > 0) {
    const confirmed = i.bases.filter((b) => b.verification?.status === 'verified').length
    const denied = i.bases.filter((b) => b.verification?.status === 'disputed' || b.verification?.status === 'vacated').length
    const delta = Math.round(((confirmed - denied) / i.bases.length) * 15)
    add(
      'verification',
      '本人核验',
      `确认 ${confirmed} · 否认或撤回 ${denied} · 未核验 ${i.bases.length - confirmed - denied}`,
      delta <= 0
        ? '查了没有一条被本人确认，或确认的被否认抵消：这一项不加'
        : `${confirmed} 条依据在核验轮里被其本人确认`,
      Math.max(0, delta),
      denied > 0 ? 'warn' : confirmed > 0 ? 'ok' : 'neutral',
    )
    if (denied > 0) caps.push(`答案引用的结论里有 ${denied} 条在核验轮被否认或撤回，不能按已核实使用`)
  }

  /** 质询：没人接话的判断，只是「还没被问到」 */
  if (i.bases.length > 0) {
    const cross = i.bases.filter((b) => b.crossExamined).length
    const delta = Math.round((cross / i.bases.length) * 10)
    add(
      'cross-examined',
      '被正面质询过',
      `${cross} / ${i.bases.length} 条`,
      cross === 0 ? '答案脚下这些结论没有一条被其他模型点名回应过：没人反驳可能只是没人接话' : `${cross} 条的依据被其他模型正面回应过`,
      delta,
      cross === 0 ? 'warn' : 'ok',
    )
  }

  /** 问题台账：这是唯一对着「用户那句话」算的一项 */
  const L = i.ledger
  if (!L.recorded) {
    add('question-coverage', '原问题的覆盖', '未登记台账', '这份报告出自没有问题台账的版本，无法核对原问题被答到哪一步', 0, 'warn')
    caps.push('本场没有问题台账：报告无法核对这段答案对应您最初那句问题的哪一部分')
  } else if (L.total === 0) {
    add('question-coverage', '原问题的覆盖', '未拆出子问题', '主持没有把原问题拆成子问题，答案与问题之间没有可核对的对应关系', 0, 'warn')
    caps.push('本场没有把原问题拆成子问题：这段答案没有任何一处被核对过是在回答您的那句问')
  } else {
    const delta = Math.round((L.answered / L.total) * 15)
    add(
      'question-coverage',
      '原问题的覆盖',
      `答上 ${L.answered} / ${L.total} · 折算 ${delta}/15`,
      L.open > 0
        ? `仍有 ${L.open} 条子问题未回答${L.shelved ? `、${L.shelved} 条当场答不了已搁置` : ''}：这段答案覆盖的是已答上的那部分`
        : L.shelved > 0
          ? `全部处置完毕，其中 ${L.shelved} 条当场答不了、缺证据`
          : '拆出的子问题逐条答上，且每条都指向真实发言',
      delta,
      L.open > 0 || L.shelved > 0 ? 'warn' : 'ok',
    )
    if (L.open > 0) caps.push(`原问题还有 ${L.open} 条子问题没有答上：这段答案不能当完整答案转述`)
    if (L.shelved > 0) caps.push(`有 ${L.shelved} 条子问题当场答不了、已搁置：补齐证据前，涉及它们的部分只是推测`)
  }

  /** 错误信号：凭空引用、代答归因、空心改写 */
  if (typeof i.riskScore === 'number') {
    const delta = i.riskScore >= 40 ? -15 : i.riskScore >= 25 ? -8 : 0
    add(
      'risk',
      '本场错误信号',
      `${i.riskScore} 分${delta ? ` · 折算 ${delta}` : ''}`,
      i.trajectory === 'compounding'
        ? '跨轮累积：后半段错误信号高于前半段，讨论在给自造的内容加固'
        : delta < 0
          ? '本场内部可判死的信号偏多（凭空引用、主持代答、空心改写）'
          : `错误信号处于低位（轨迹：${TRAJECTORY_TEXT[i.trajectory ?? 'insufficient_data']}）`,
      delta,
      delta < 0 ? 'warn' : 'ok',
    )
    if (i.trajectory === 'compounding') caps.push('本场错误信号跨轮累积：讨论在为自造的内容加固，这段答案的可信度按低档对待')
  } else {
    add('risk', '本场错误信号', '未测量', '这份报告出自没有幻觉账本的版本，错误信号无从核对', 0, 'warn')
  }

  /** 硬度与对照 */
  const weights = i.bases.map((b) => b.weight).filter((w): w is number => typeof w === 'number')
  if (weights.length > 0) {
    const m = weights.reduce((a, b) => a + b, 0) / weights.length
    const delta = Math.round(m * 5)
    add('hardness', '依据硬度', `${m.toFixed(2)} · 折算 ${delta}/5`, `主持登记的证据硬度均值；没登记的条数 ${i.bases.length - weights.length} 条不计入`, delta, m >= 0.5 ? 'ok' : 'warn')
  }
  if (i.baselineVerdict) {
    const map: Record<BaselineVerdict, { delta: number; text: string; tone: FinalAnswerSignal['tone'] }> = {
      council_better: { delta: 5, text: '研讨比单模型基线多出可核对的新要点', tone: 'ok' },
      mixed: { delta: 2, text: '研讨与基线互有胜负：有新增，也丢了基线说清过的东西', tone: 'warn' },
      baseline_better: { delta: -10, text: '基线反而更好：研讨把单家已经说清的要点弄丢了', tone: 'warn' },
      inconclusive: { delta: 0, text: '与基线的对照无法判定：样本或证据不足', tone: 'neutral' },
    }
    const v = map[i.baselineVerdict]
    add('baseline', '相对单模型基线', `${v.delta >= 0 ? '+' : ''}${v.delta}`, v.text, v.delta, v.tone)
  }

  /** 过程减分：这场是否跑完 */
  const process: string[] = []
  let processDelta = 0
  if (i.absentCount > 0) {
    const d = -Math.min(9, i.absentCount * 3)
    processDelta += d
    process.push(`${i.absentCount} 次缺席`)
  }
  if (i.budgetLimited) {
    processDelta += -6
    process.push('预算触顶')
  }
  if (i.timeLimited) {
    processDelta += -6
    process.push('时长触顶')
  }
  if (i.finishedReason !== 'converged') {
    processDelta += -5
    process.push('未按判据收束')
  }
  if (processDelta !== 0) {
    add('process', '这场跑完了吗', `折算 ${processDelta}`, `${process.join(' · ')}：收束是被上限或异常拦下的，不是谈完的`, processDelta, 'warn')
  }

  if (i.evidence.length === 0 && i.bases.length === 0) {
    caps.push('这段答案没有任何一条依据能对回本场的原话')
  }

  const score = clamp(signals.reduce((a, s) => a + s.delta, 0), 0, 100)
  /**
   * 一处依据都对不上时给的是 `unrated`，不是 `low`：
   * 前者说「这套判据没用上」，后者说「用上了，但结果不好」，混成一个就是撒谎。
   */
  const noEvidence = i.evidence.length === 0 && i.bases.length === 0
  return {
    score,
    level: noEvidence ? 'unrated' : levelFromScore(score, caps.length),
    signals: [...signals].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
    caps,
  }
}

const TRAJECTORY_TEXT: Record<HallucinationTrajectory, string> = {
  self_correcting: '跨轮自我矫正',
  flat: '跨轮持平',
  compounding: '跨轮累积',
  insufficient_data: '轮次不足',
}

/**
 * 档位由分数定，但**有压级理由就不许是 high**：
 * 这些理由（未答子问题、被撤回的依据、无台账）都是「别当定论用」，
 * 与分数高低无关 —— 一场证据漂亮、只剩两条子问题没答上的讨论，
 * 拿到 82 分也只能是「有保留」。
 */
function levelFromScore(score: number, capCount: number): FinalAnswerLevel {
  if (capCount > 0) return score >= 50 ? 'medium' : 'low'
  if (score >= 75) return 'high'
  if (score >= 50) return 'medium'
  return 'low'
}

/**
 * 档位判词说的是「这段答案能被用到哪儿」，不是模型觉得自己多有把握。
 * 分数另列 —— 界面与 Markdown 都写成「档位 + 分数」两样，别把档位名里的「高/中/低」和分数混读。
 */
export const FINAL_ANSWER_LEVEL_TEXT: Record<FinalAnswerLevel, string> = {
  high: '可对外使用',
  medium: '有保留',
  low: '仅供内部参考',
  unrated: '无从评级',
}

/**
 * 「最终答案」一章的 Markdown 行。
 *
 * 顺序固定为：答案本身 → 有多确信（含为什么不更确信）→ 什么条件下成立 / 失效 → 依据原话。
 * 置信度放在成立条件之前：读者要先知道这段话能用到什么程度，再看它的边界。
 */
export function finalAnswerLines(a: FinalAnswer): string[] {
  const c = a.confidence
  const out: string[] = [a.conclusion, '']
  out.push(
    `**置信档位：${FINAL_ANSWER_LEVEL_TEXT[c.level]}**${c.level === 'unrated' ? '' : `（${c.score}/100）`} —— 由程序按台账、印证家数、核验结果与错误信号算出，不是模型自评。`,
    '',
  )
  if (c.caps.length > 0) {
    out.push('为什么不止于此：')
    out.push('')
    for (const cap of c.caps) out.push(`- ${cap}`)
    out.push('')
  }
  if (a.holds.length > 0) {
    out.push('成立条件：')
    out.push('')
    for (const h of a.holds) out.push(`- ${h}`)
    out.push('')
  } else {
    out.push('（主持未写成立条件：这段答案的适用边界不明，采用前请自己补上一条判据。）', '')
  }
  if (a.breaks.length > 0) {
    out.push('失效条件：')
    out.push('')
    for (const b of a.breaks) out.push(`- ${b}`)
    out.push('')
  } else {
    out.push('（主持未写失效条件：出现哪种情况该推翻重问，报告里没有任何交代。）', '')
  }
  if (a.gap) out.push(`主持自述的缺口：${a.gap}`, '')
  if (a.evidence.length > 0) {
    out.push('依据的原话：')
    out.push('')
    for (const e of a.evidence) out.push(`- ${e.utteranceId} · R${e.round} ${e.displayName}：${e.quote}`)
    out.push('')
  } else {
    out.push('（这段答案没有一条引用能落回本场的真实发言 —— 它可以读，但没有任何东西可以核对。）', '')
  }
  if (a.baseIndexes.length > 0) {
    out.push(`依据的结论条目：${a.baseIndexes.map((n) => `${n}`).join('、')}（逐条见「结论清单」）`, '')
  }
  const scored = c.signals.filter((s) => s.delta !== 0)
  if (scored.length > 0) {
    out.push('这一分是怎么来的：')
    out.push('')
    for (const s of scored) out.push(`- ${s.label} ${s.delta > 0 ? `+${s.delta}` : s.delta} —— ${s.value}；${s.detail}`)
    out.push('')
  }
  for (const r of a.rejectedRefs) out.push(`> 已忽略：${r}`)
  if (a.rejectedRefs.length > 0) out.push('')
  return out
}
