/**
 * 人工介入的不变量（PRD 5.5 / 8.2 / 8.3）
 *
 * 核心约束：介入是**一等公民**，不是普通上下文。
 *
 * 三条硬规则：
 * 1. 介入内容不得被摘要器稀释 —— 不得塞进 explored（会被当成"已排除方向"）；
 * 2. 人类发言不计入共识度核算 —— 人的表态不是模型共识的组成部分；
 * 3. 缺席模型上的定向追问必须改投 —— 不能静默丢弃用户的干预意图。
 */

import { makeId, round1 } from './invariants'
import {
  HUMAN_AGENT_ID,
  type AgentStatus,
  type Intervention,
  type InterventionKind,
  type Utterance,
} from './types'

export type { Intervention, InterventionKind }

/** 创建一条介入记录 */
export function createIntervention(
  kind: InterventionKind,
  text: string,
  atRound: number,
  extra: Partial<Intervention> = {},
): Intervention {
  return {
    id: makeId('itv'),
    kind,
    text: text.trim(),
    atRound,
    createdAt: Date.now(),
    targetAgentIds: extra.targetAgentIds ?? [],
    status: 'pending',
    ...extra,
  }
}

/**
 * 把待生效的介入渲染为注入模型的文本块。
 *
 * 关键：介入段落有独立小标题，不混入「已充分讨论并排除的方向」，
 * 主持与参会模型都能明确区分"这是人类的要求"与"这是讨论已排除的东西"。
 */
export function renderInterventions(list: Intervention[]): string {
  const active = list.filter((i) => i.status === 'pending' && i.kind !== 'stop' && i.kind !== 'set-stance')
  if (active.length === 0) return ''

  const lines: string[] = []
  lines.push('【人类参与者介入】')
  lines.push('以下内容由用户在你本轮发言前插入，请优先响应；若与你的判断冲突，请明确说明分歧。')

  for (const it of active) {
    switch (it.kind) {
      case 'interject':
        lines.push(
          it.targetAgentIds.length === 0
            ? `- 【对全体的插话】${it.text}`
            : `- 【仅给你的插话】${it.text}`,
        )
        break
      case 'followup':
        lines.push(`- 【定向追问】请针对以下内容作出回应：${it.text}`)
        break
      case 'duel':
        lines.push(`- 【专项对辩】议题：${it.topic ?? it.text}。请正面回应对方立场，不要重复此前已说过的论点。`)
        break
      default:
        break
    }
  }
  return lines.join('\n')
}

/**
 * 处置待生效的介入：把 pending 标为 delivered，并记录实际生效轮次。
 * 返回本批次实际应投递的介入（已按缺席模型剔除目标）。
 */
export function deliverInterventions(
  list: Intervention[],
  round: number,
  agentStatus: Map<string, AgentStatus>,
): Intervention[] {
  const out: Intervention[] = []

  for (const it of list) {
    if (it.status !== 'pending') continue
    if (it.kind === 'stop' || it.kind === 'set-stance') continue

    if (it.kind === 'interject') {
      if (it.targetAgentIds.length === 0) {
        it.status = 'delivered'
        it.deliveredRound = round
        out.push(it)
        continue
      }
      // 规则 3：目标缺席时改投全员，不静默丢弃
      const alive = it.targetAgentIds.filter((id) => {
        const s = agentStatus.get(id)
        return s !== 'expired' && s !== 'adapter-broken' && s !== 'disabled'
      })
      if (alive.length > 0) {
        it.targetAgentIds = alive
        it.status = 'delivered'
        it.deliveredRound = round
        out.push(it)
      } else {
        it.status = 'cancelled'
        it.note = '目标模型全部缺席，该插话已作废'
      }
      continue
    }

    if (it.kind === 'followup') {
      const s = it.targetAgentId ? agentStatus.get(it.targetAgentId) : undefined
      if (s === 'expired' || s === 'adapter-broken' || s === 'disabled') {
        it.status = 'cancelled'
        it.note = `目标模型 ${it.targetAgentId} 不可用，定向追问已作废`
        continue
      }
      it.status = 'delivered'
      it.deliveredRound = round
      out.push(it)
    }
  }

  return out
}

/** 构造人类介入的发言记录（计入记录与报告，但 human=true） */
export function humanUtterance(
  text: string,
  round: number,
  targets: string[] = [],
  at = Date.now(),
): Utterance {
  return {
    id: makeId('utt'),
    round,
    agentId: HUMAN_AGENT_ID,
    content: text,
    targets,
    human: true,
    startedAt: at,
    endedAt: at,
  }
}

/**
 * 共识度核算时必须排除人类发言与缺席发言。
 * 规则 2 的执行点：主持的 support 校验也只认模型发言。
 */
export function modelUtterancesOnly(list: Utterance[]): Utterance[] {
  return list.filter((u) => !u.absent && !u.human)
}

/** 报告中人类介入的呈现（PRD 5.5：单列一章，不混入模型发言） */
export function summarizeInterventions(list: Intervention[]): string[] {
  if (list.length === 0) return []
  const lines: string[] = []
  for (const it of list) {
    switch (it.kind) {
      case 'interject':
        lines.push(
          `第 ${it.deliveredRound ?? it.atRound} 轮插话：${it.text}${
            it.targetAgentIds.length > 0
              ? `（定向：${it.targetAgentIds.join('、')}）`
              : '（对全员）'
          }`,
        )
        break
      case 'followup':
        lines.push(`第 ${it.deliveredRound ?? it.atRound} 轮定向追问 ${it.targetAgentId ?? ''}：${it.text}`)
        break
      case 'duel':
        lines.push(
          `专项对辩「${it.topic ?? ''}」：${(it.duelAgentIds ?? []).join(' vs ')}`,
        )
        break
      case 'set-stance':
        lines.push(`第 ${it.deliveredRound ?? it.atRound} 轮调整 ${it.stanceAgentId} 立场：${it.stanceBefore} → ${it.stanceAfter}`)
        break
      case 'stop':
        lines.push(`用户中止讨论：${it.text || '（无附加说明）'}`)
        break
    }
  }
  return lines
}

/** 立场变更的展示文案 */
export function stanceLabel(key: string): string {
  const map: Record<string, string> = {
    support: '支持方',
    oppose: '反对方',
    risk: '风险审阅者',
    pragmatic: '务实执行者',
    neutral: '中立分析者',
  }
  return map[key] ?? key
}

export { round1 }
