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
  /** agent 型网页站的执行过程（检索/跑代码/写文件等步骤），与答案分开返回 */
  steps?: string
  /** 本轮的非致命异常提示（如附件没送达）：不缺席，但必须让用户看见 */
  note?: string
  /**
   * 本轮回答里生成的图片 URL（网页通道的 AI 生图）。
   *
   * 生图那一轮正文常常一个字都没有，只有 <img>，所以图片必须单独成一条通道，
   * 否则整轮会被读成「空回复」。URL 由主进程下载入库后再交给渲染层。
   */
  images?: string[]
}

export interface Agent {
  readonly id: string
  readonly displayName: string
  readonly transport: 'webview' | 'api'
  readonly color: string
  status: AgentStatus

  /** 流式发送；onDelta 收到正文增量，onThinking 收到思维链增量（推理模型才有），
   *  onSteps 收到执行过程增量（agent 型网页站才有）。
   *  本轮生成的图片不进回调，随 SendResult.images 一次性返回。 */
  send(
    ctx: TurnContext,
    onDelta: (chunk: string) => void,
    onThinking?: (chunk: string) => void,
    onSteps?: (chunk: string) => void,
  ): Promise<SendResult>
  /**
   * 只投递、不回收（仅 webview，聊天模式的原生模式）。
   *
   * 键入问题 + 交付附件 + 按发送，然后立刻返回；回答留在站点自己的页面上，
   * 由用户在同一块原生视图里读。因此它不依赖回复容器选择器，
   * 站点改版打断不了这一轮 —— 代价是本地拿不到正文。
   */
  deliverNative?(
    ctx: TurnContext,
  ): Promise<{ accepted: boolean; note?: string; url?: string }>
  /**
   * 把这一轮的问题在站点页面上找出来并滚到视野中间（仅 webview，聊天模式的原生视图）。
   *
   * 两条路：先在当前页面上按文本找（排除助手容器与输入框的子树，因为站家常把问题
   * 原文复述进回答里）；找不到就把面板导航回 `url` 那一场会话再找一次 —— 消息列表
   * 虚拟化的站点只挂最近一两个回合，更早那轮不在 DOM 里，但那场会话 URL 里它正是最新一轮。
   * `url` 是投递时记下的会话指针，来自渲染层的存档，所以实现侧必须按适配器入口判源。
   * 一律返回结论不抛错：定位失败只该让那一格说一句「没找到」。
   */
  locateTurn?(
    prompt: string,
    url?: string,
  ): Promise<{
    ok: boolean
    found: number
    index?: number
    mode?: string
    navigated: boolean
    reason: string
  }>
  healthCheck(): Promise<boolean>
  /**
   * 把这一格开回站点自己的新会话（导航到适配器入口），仅 webview，聊天模式「新会话」用。
   *
   * 原生模式下上下文根本住在站点那一页里：本地另起一场而页面不动，DeepSeek / 元宝
   * 照旧带着上一场全部内容答这一题 —— 那这颗「新会话」按钮对网页模型就是空的。
   * 只换地址不重建实例：recreate 会换掉整份 WebContents（约 250MB 起），而分区数据
   * 原样保留，登录态不该为换个地址陪葬。实例不在场时什么都不做，返回 ok:true。
   */
  openFreshConversation?(): Promise<{ ok: boolean; reopened?: boolean; reason?: string }>
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
  | 'no-reply'
  | 'over-budget'

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
      return `${name} 本轮没发出去（输入框里的话还在）· 站点可能拒收，可重发或在设置页体检该模型`
    case 'no-reply':
      return `${name} 站点已收到这一轮，但始终没有回复 · 本轮缺席，不影响其他模型`
    case 'over-budget':
      return `${name} 已达发言预算上限 · 本轮不再发言`
  }
}

export type { ModelConfig }
