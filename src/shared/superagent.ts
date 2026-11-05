/**
 * 超智能体（super agent）任务台的共享词表。
 *
 * 这一层只有一个主进程实现，但界面要知道这些名字才能画出来，所以词表放在
 * `src/shared/`：同一份类型，主进程与渲染层各引一次，不允许在两边各抄一份。
 *
 * 阶段名是**封闭集合**：界面上的分组、Router 汇报里的措辞都按这一组来，
 * 加阶段要同时改界面与提示词，不是这里加个 union 成员就完事。
 */

/** 任务阶段 */
export type TaskStage =
  /** 已分派，还没起进程 */
  | 'pending'
  /** 正在跑 */
  | 'working'
  /** 在等用户回授权/插话 */
  | 'waiting_input'
  /** 跑完了 */
  | 'done'
  /** 起不来或中途崩了（保留 error 原因，别静默消失） */
  | 'failed'
  /** 人取消的 */
  | 'cancelled'

/** 一条已发生的动作轨迹 */
export interface TaskToolCall {
  id: string
  title: string
  status: string
  text?: string
}

/** 一个 Worker 任务 */
export interface SuperTask {
  id: string
  title: string
  /** 交给 Worker 的完整目标 */
  goal: string
  agentId: string
  agentTitle: string
  cwd: string
  stage: TaskStage
  createdAt: number
  updatedAt: number
  /** 输出尾巴：不是全文 —— 界面要的是「它现在说到哪儿」 */
  outputTail: string
  toolCalls: TaskToolCall[]
  /** 等用户输入时，那一句问的是什么 */
  waitingText?: string
  error?: string
  rounds: number
}

/** Router 推给界面的一件事 */
export type RouterEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'error'; text: string }
  | { kind: 'done' }
  | { kind: 'status'; text: string }

/** 任务台一整份状态（superagent:state 的回包） */
export interface SuperAgentState {
  routerBusy: boolean
  /** Router 这一轮的转述：工具结果不外泄，只留它给界面的那几句 */
  transcript: string[]
  tasks: SuperTask[]
  /** 路由模型名；null 表示还没配，界面要说清该配哪个 */
  routerModel: string | null
  /** 路由模型所属条目 id（"条目id::模型名" 里那半截）：头部选择器靠它回填当前项 */
  routerModelId: string | null
  agents: Array<{ id: string; title: string; blurb: string }>
}

/** 阶段在界面上的一句中文：写死的只有这一处 */
export function stageLabel(stage: TaskStage): string {
  switch (stage) {
    case 'pending':
      return '排队'
    case 'working':
      return '进行中'
    case 'waiting_input':
      return '等你'
    case 'done':
      return '完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
  }
}

/** 阶段在任务板上的分组顺序：未完成的在前，完成的收在下面 */
export const STAGE_GROUPS: Array<{ label: string; stages: TaskStage[] }> = [
  { label: '进行中', stages: ['pending', 'working', 'waiting_input'] },
  { label: '已收口', stages: ['done', 'failed', 'cancelled'] },
]
