/**
 * 统一 Agent 抽象（PRD 6.4）
 *
 * 编排引擎不感知传输方式。webview 与 api 对外暴露完全相同的接口，
 * 因此讨论中可随时切换通道而不中断会话。
 */

import type { AgentStatus, ModelConfig, TokenUsage, TurnContext, UtteranceInput } from '../../shared/types'

export interface SendResult {
  content: string
  usage: TokenUsage
  /** 本条发言回应的发言 id 列表 */
  targets: string[]
  /** 实际发给模型的输入，供 UI 展示「输入/输出」 */
  input?: UtteranceInput
  /** 推理模型的思维链/思考内容，与最终答案分开返回 */
  thinking?: string
}

export interface Agent {
  readonly id: string
  readonly displayName: string
  readonly transport: 'webview' | 'api'
  readonly color: string
  status: AgentStatus

  /** 流式发送；onDelta 收到正文增量，onThinking 收到思维链增量（推理模型才有） */
  send(
    ctx: TurnContext,
    onDelta: (chunk: string) => void,
    onThinking?: (chunk: string) => void,
  ): Promise<SendResult>
  healthCheck(): Promise<boolean>
  /** 手动接管/交还（仅 webview） */
  takeover?(on: boolean): void
  dispose(): void
}

/** 缺席原因分类，对应 PRD 6.2 通道降级规则 */
export type AbsentReason =
  | 'timeout'
  | 'adapter-broken'
  | 'login-required'
  | 'channel-error'
  | 'not-started'

export class AgentError extends Error {
  constructor(
    readonly reason: AbsentReason,
    message: string,
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

export function describeStatus(s: AgentStatus): string {
  switch (s) {
    case 'ready':
      return '就绪'
    case 'busy':
      return '发言中'
    case 'expired':
      return '会话过期'
    case 'adapter-broken':
      return '适配器失效'
    case 'disabled':
      return '已禁用'
    case 'absent':
      return '本轮缺席'
  }
}

/** 缺席时生成占位说明（PRD 8.3：不静默消失） */
export function absentText(name: string, reason: AbsentReason): string {
  switch (reason) {
    case 'timeout':
      return `${name} 本轮超时未响应 · 已跳过，不影响其他模型`
    case 'adapter-broken':
      return `${name} 适配器失效 · 本轮缺席，请检查适配器更新`
    case 'login-required':
      return `${name} 未登录或需人机验证 · 本轮缺席，请在左栏点击其头像重新登录`
    case 'channel-error':
      return `${name} 通道异常 · 本轮缺席`
    case 'not-started':
      return `${name} 未开始发言`
  }
}

export type { ModelConfig }
