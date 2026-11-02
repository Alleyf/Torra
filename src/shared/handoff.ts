/**
 * 研讨 → 研究主线的交接稿。
 *
 * 一场研讨结束时，那些已经认账的结论和还没谈完的分歧不该只停在报告里：
 * 它们得能变成研究工作台里的真实节点。这一份结构就是那条路上的唯一契约 ——
 * 渲染层照它拼，插件照它收，两边都不必猜对方的字段名。
 *
 * 字段刻意做得很薄：只有议题、轮次、谁在场、认账了什么、还差在哪。
 * 置信度、证据引用、权重这些留在研讨自己的存档里：主线接的是结论本身，
 * 不是研讨过程的全部内情。
 */

/** 一条已认账的结论：说了什么，谁点头 */
export interface HandoffConsensusPoint {
  claim: string
  /** 支持方的显示名（不是 agentId —— 交接稿要能直接给人看） */
  support: string[]
}

/** 分歧的一方：谁、怎么说 */
export interface HandoffDisputeSide {
  agent: string
  argument: string
}

/** 一条还没谈完的分歧 */
export interface HandoffDispute {
  claim: string
  sides: HandoffDisputeSide[]
}

/** 整份交接稿 */
export interface HandoffPayload {
  /** 议题标题 */
  topic: string
  /** 结束原因的键，如 'converged' / 'max-rounds' */
  reason: string
  /** 人话标签，如「结论收敛」 */
  reasonLabel: string
  /** 结束时的轮次 */
  round: number
  /** 本场允许多少轮 */
  maxRounds: number
  /** 参与模型的显示名 */
  participants: string[]
  /** 已经认账的结论 */
  consensus: HandoffConsensusPoint[]
  /** 还没谈完的分歧 */
  disputes: HandoffDispute[]
  /** 交接稿的生成时间（毫秒） */
  createdAt: number
}
