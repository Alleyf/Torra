import type {
  ConsensusReportItem,
  DisputeReportItem,
  Report,
  ReportActionItem,
  ReportDecision,
  ReportEvidence,
  ReportRevisionSnapshot,
} from './types'

export type ReportReaderMode = 'brief' | 'full' | 'evidence'
export type ReportClaimStatus = 'confirmed' | 'qualified' | 'contested' | 'unsupported'

export interface ReportClaimView {
  key: string
  claim: string
  status: ReportClaimStatus
  supporters: string[]
  opposedBy: string[]
  sourceRounds: number[]
  confidence: number
  supportRatio: number
  hardness: number | null
  verifiedSupportRate: number
  crossExamined: boolean
  evidence: ReportEvidence[]
  note: string
  raw: ConsensusReportItem
}

export interface ReportDecisionView {
  key: string
  decision: ReportDecision
  actionItems: ReportActionItem[]
}

export interface ReportRevisionDiff {
  current: ReportRevisionSnapshot
  previous: ReportRevisionSnapshot
  /** 展开后的决策文本列表，供面板直接显示条数变化 */
  currentDecisions: string[]
  previousDecisions: string[]
  verdictChanged: boolean
  headlineChanged: boolean
  decisionChanged: boolean
  addedDecisions: string[]
  removedDecisions: string[]
  actionFieldsChanged: boolean
  /** 同一条行动的负责人/时间/完成标准被改写时的说明 */
  actionChanges: string[]
  addedClaims: string[]
  removedClaims: string[]
  addedDisputes: string[]
  removedDisputes: string[]
  addedActions: string[]
  removedActions: string[]
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const unique = (values: string[]): string[] => [...new Set(values.map((x) => x.trim()).filter(Boolean))]

const actionField = (text: string, labels: string[]): { text: string; value: string | null } => {
  for (const label of labels) {
    const hit = new RegExp(`(?:^|[；;，,|])\\s*${label}\\s*[:：]\\s*([^；;|\\n]+)`, 'i').exec(text)
    if (hit?.[1]) return { text: text.replace(hit[0], '').trim(), value: hit[1].trim() }
  }
  return { text, value: null }
}

function legacyAction(text: string, index: number, decisionId?: string): ReportActionItem {
  const owner = actionField(text, ['负责人', '执行人', 'owner'])
  const due = actionField(owner.text, ['时间', '截止', '期限', 'due', 'deadline'])
  const done = actionField(due.text, ['完成标准', '验收标准', 'done when'])
  const depends = actionField(done.text, ['依赖', '前置条件', 'depends'])
  const fallback = actionField(depends.text, ['失败分支', '回退方案', 'fallback'])
  return {
    id: `legacy-act-${index}`,
    action: fallback.text || `行动 ${index + 1}`,
    ...(owner.value ? { owner: owner.value } : {}),
    ...(due.value ? { due: due.value } : {}),
    ...(done.value ? { doneWhen: done.value } : {}),
    ...(depends.value ? { depends: depends.value } : {}),
    ...(fallback.value ? { fallback: fallback.value } : {}),
    ...(decisionId ? { decisionId } : {}),
  }
}

export function actionItemsFor(report: Report): ReportActionItem[] {
  const out: ReportActionItem[] = []
  const seen = new Set<string>()
  const add = (item: ReportActionItem) => {
    const key = [item.action, item.owner, item.due, item.doneWhen].map((x) => x ?? '').join('|')
    if (!item.action || seen.has(key)) return
    seen.add(key)
    out.push(item)
  }
  for (const decision of report.finalReview?.decisions ?? []) {
    if (decision.actionItems?.length) {
      decision.actionItems.forEach(add)
    } else {
      decision.actions.forEach((text, index) => add(legacyAction(text, out.length + index, decision.id)))
    }
  }
  for (const item of report.actionItems ?? []) add(item)
  if (out.length === 0) {
    report.nextActions.forEach((text, index) => add(legacyAction(text, index)))
  }
  return out
}

function claimNote(claim: ConsensusReportItem): string {
  const verification = claim.verification
  if (verification?.status === 'vacated') {
    return `条目仍保留，但核验后已失去全部可确认支持；原支持者：${verification.removed.join('、') || '未记录'}。`
  }
  if (verification?.status === 'disputed') {
    return `核验在第 ${verification.checkedRound} 轮出现争议；确认方：${verification.confirmedBy.join('、') || '未记录'}。`
  }
  if (claim.crossExamined) return '这条判断经过对手质询后仍然保留。'
  if (claim.weight === null || claim.weight === undefined) return '没有记录证据硬度，不能把缺失值当成低分。'
  return claim.argument || '报告没有记录额外说明。'
}

function claimStatus(claim: ConsensusReportItem): ReportClaimStatus {
  const status = claim.verification?.status
  if (status === 'vacated' || status === 'disputed') return 'contested'
  if (status === 'verified' || ((claim.supporterCount ?? 0) >= 2 && (claim.weight ?? 0) >= 0.6)) {
    return 'confirmed'
  }
  if ((claim.evidence?.length ?? 0) === 0 || claim.weight === null || claim.weight === undefined) {
    return 'unsupported'
  }
  return 'qualified'
}

export function buildClaims(report: Report): ReportClaimView[] {
  const disputes = report.disputes ?? []
  return (report.consensus ?? []).map((raw, index) => {
    const against = disputes.flatMap((dispute) =>
      dispute.sides
        .filter((side) => !raw.supporters.includes(side.agentId))
        .map((side) => side.agentId),
    )
    return {
      key: raw.sourceUtteranceIds[0] ?? `claim-${index}`,
      claim: raw.claim,
      status: claimStatus(raw),
      supporters: raw.supporters ?? [],
      opposedBy: unique(against),
      sourceRounds: raw.sourceRounds ?? [],
      confidence: raw.confidence ?? 0,
      supportRatio: raw.supportRatio ?? 0,
      hardness: raw.weight,
      verifiedSupportRate: raw.verifiedSupportRate ?? 0,
      crossExamined: Boolean(raw.crossExamined),
      evidence: raw.evidence ?? [],
      note: claimNote(raw),
      raw,
    }
  })
}

export function buildDecisions(report: Report): ReportDecisionView[] {
  return (report.finalReview?.decisions ?? []).map((decision, index) => ({
    key: decision.id || `decision-${index}`,
    decision,
    actionItems: decision.actionItems?.length
      ? decision.actionItems
      : decision.actions.map((text, i) => legacyAction(text, i, decision.id)),
  }))
}

export function reportRevisionSnapshot(report: Report): ReportRevisionSnapshot {
  const actions = actionItemsFor(report)
  const decisions = unique((report.finalReview?.decisions ?? []).map((x) => x.decision))
  return {
    generatedAt: report.generatedAt ?? Date.now(),
    verdictLevel: report.verdict?.level ?? 'none',
    headline: report.verdict?.headline || report.executiveSummary || '',
    decision: decisions[0] ?? null,
    decisions,
    claims: unique((report.consensus ?? []).map((x) => x.claim)),
    disputes: unique((report.disputes ?? []).map((x) => x.claim)),
    actions: unique(actions.map((x) => x.action)),
    actionItems: actions.map(({ decisionId: _decisionId, ...fields }) => fields),
  }
}

const diffSet = (current: string[], previous: string[]): { added: string[]; removed: string[] } => {
  const now = new Set(current)
  const before = new Set(previous)
  return {
    added: current.filter((x) => !before.has(x)),
    removed: previous.filter((x) => !now.has(x)),
  }
}

export function diffReportRevision(report: Report): ReportRevisionDiff | null {
  const previous = report.meta?.previousRevision
  if (!previous) return null
  const current = reportRevisionSnapshot(report)
  const claims = diffSet(current.claims, previous.claims)
  const disputes = diffSet(current.disputes, previous.disputes)
  const actions = diffSet(current.actions, previous.actions)
  const currentDecisions = current.decisions ?? (current.decision ? [current.decision] : [])
  const previousDecisions = previous.decisions ?? (previous.decision ? [previous.decision] : [])
  const decisions = diffSet(currentDecisions, previousDecisions)
  const fieldsOf = (items: ReportRevisionSnapshot['actionItems']) =>
    JSON.stringify((items ?? []).map((x) => [x.action, x.owner, x.due, x.doneWhen, x.depends, x.fallback]))
  /**
   * 行动字段按行动文本对齐比较：同名行动只改了负责人或期限时，
   * 旧的增删集合不会发现，面板会误报"与上一版一致"。
   */
  const beforeItems = new Map((previous.actionItems ?? []).map((x) => [x.action, x] as const))
  const FIELD_LABELS: Array<[keyof ReportActionItem, string]> = [
    ['owner', '负责人'],
    ['due', '时间'],
    ['doneWhen', '完成标准'],
    ['depends', '依赖'],
    ['fallback', '失败分支'],
  ]
  const actionChanges: string[] = []
  for (const item of current.actionItems ?? []) {
    const old = beforeItems.get(item.action)
    if (!old) continue
    const changed = FIELD_LABELS.filter(([key]) => (item[key] ?? '') !== (old[key] ?? ''))
    if (changed.length > 0) {
      actionChanges.push(
        `${item.action}：${changed
          .map(([key, label]) => `${label}「${old[key] ?? '未记录'}」→「${item[key] ?? '未记录'}」`)
          .join('，')}`,
      )
    }
  }
  return {
    current,
    previous,
    currentDecisions,
    previousDecisions,
    verdictChanged: current.verdictLevel !== previous.verdictLevel,
    headlineChanged: current.headline !== previous.headline,
    decisionChanged: JSON.stringify(currentDecisions) !== JSON.stringify(previousDecisions),
    addedDecisions: decisions.added,
    removedDecisions: decisions.removed,
    actionFieldsChanged: fieldsOf(current.actionItems) !== fieldsOf(previous.actionItems),
    actionChanges,
    addedClaims: claims.added,
    removedClaims: claims.removed,
    addedDisputes: disputes.added,
    removedDisputes: disputes.removed,
    addedActions: actions.added,
    removedActions: actions.removed,
  }
}

/**
 * 旧报告没有新增字段，页面不能因此白屏。所有缺省只补“未记录”，不推断内容。
 */
export function normalizeReport(raw: Report): Report {
  const report = raw ?? ({} as Report)
  const speakers = Math.max(1, new Set((report.meta?.models ?? []).map((x) => x.id)).size)
  const consensus = (report.consensus ?? []).map((item) => ({
    ...item,
    supporters: item.supporters ?? [],
    sourceRounds: item.sourceRounds ?? [],
    sourceUtteranceIds: item.sourceUtteranceIds ?? [],
    evidence: item.evidence ?? [],
    confidence: item.confidence ?? 0,
    confirmedRound: item.confirmedRound ?? item.sourceRounds?.[0] ?? 0,
    supportRatio: item.supportRatio ?? Math.round(((item.supporterCount ?? 0) / speakers) * 100),
    weight: item.weight ?? null,
    verifiedSupportRate: item.verifiedSupportRate ?? 0,
    attributedSupport: item.attributedSupport ?? [],
    crossExamined: Boolean(item.crossExamined),
  }))
  const disputes = (report.disputes ?? []).map(
    (item): DisputeReportItem => ({
      ...item,
      sides: item.sides ?? [],
      roundsEngaged: item.roundsEngaged ?? 1,
      dueled: Boolean(item.dueled),
      quotes: item.quotes ?? [],
    }),
  )
  const coverage =
    report.verdict?.coverage ??
    Math.round((consensus.length / Math.max(1, consensus.length + disputes.length)) * 100)
  return {
    ...report,
    executiveSummary: report.executiveSummary ?? '',
    consensus,
    disputes,
    timeline: report.timeline ?? [],
    participation: report.participation ?? [],
    blindSpots: report.blindSpots ?? [],
    nextActions: report.nextActions ?? [],
    interventions: report.interventions ?? [],
    duels: report.duels ?? [],
    verdict: report.verdict ?? {
      level: report.meta?.consensusAvailable ? 'qualified' : 'weak',
      headline: report.executiveSummary ?? '旧报告没有生成最终判断。',
      reasons: ['该报告由旧版生成，没有记录最终判断的计算依据。'],
      coverage,
    },
    stats:
      report.stats ?? {
        utterances: 0,
        humanUtterances: 0,
        replyEdges: 0,
        absentCount: 0,
        speakerCount: speakers,
        avgRoundMs: 0,
        hub: null,
      },
    meta: report.meta ?? {
      models: [],
      rounds: 0,
      maxRounds: 0,
      totalCostUsd: 0,
      budgetLimitUsd: 0,
      durationMs: 0,
      absentAgents: [],
      budgetLimited: false,
      moderatorUnavailable: true,
      consensusAvailable: false,
      finalConsensusScore: null,
      finishedReason: 'failed',
      moderatorName: null,
      interventionCount: 0,
      duelCount: 0,
      anonymousReview: false,
      leaderboard: [],
      provenance: { coverageRate: 0, crossExaminedRate: 0 },
    },
  }
}

export const REPORT_STATUS_META: Record<
  ReportClaimStatus,
  { label: string; hint: string; tone: 'ok' | 'warn' | 'bad' }
> = {
  confirmed: { label: '已确认', hint: '至少有两个来源相互印证，且证据足够硬。', tone: 'ok' },
  qualified: { label: '有条件成立', hint: '有直接证据，但只支持当前范围内的判断。', tone: 'warn' },
  contested: { label: '仍在争议', hint: '条目保留，但质询或核验没有收敛。', tone: 'bad' },
  unsupported: { label: '证据不足', hint: '报告没有记录足够证据，不能据此行动。', tone: 'warn' },
}

export function evidenceFromDispute(dispute: DisputeReportItem): ReportEvidence[] {
  return dispute.quotes ?? []
}
