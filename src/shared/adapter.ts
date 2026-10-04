/**
 * 站点适配器规范（PRD 6.6）
 *
 * 声明式 YAML，与主程序分离、支持热更新。
 * 主程序不含任何站点专属逻辑 —— 全部由本文件描述的字段驱动。
 *
 * 设计原则（来自真实站点逆向的教训）：
 * 真实站点的 DOM 高度不统一，不能假设「一定有独立的停止按钮」。
 * DeepSeek 的发送与停止是同一个 button，且无 data-testid；
 * Kimi 用 Lexical（contenteditable），DeepSeek/Qwen/豆包用原生 textarea；
 * 豆包的发送与打断按钮同时在 DOM 中，靠 class 互斥隐藏。
 * 因此本规范把若干字段设计为可选，并提供多套完成判定兜底。
 */

export interface AdapterSelectors {
  /** 输入框。textarea 用 value 写入，contenteditable 走 execCommand */
  input: string
  /** 发送按钮（可选）。留空或缺失时按 send_mode=enter 走键盘 */
  send?: string
  /** 最新一条助手消息容器 */
  stream: string
  /** 停止生成按钮（可选）。仅 completion.mode=stop_button_hidden 时需要 */
  stop?: string
  /** 仅在生成过程中存在的元素（可选）。completion.mode=generating_absent 时需要 */
  generating?: string
  /**
   * 思考/推理过程容器（可选）。
   *
   * 声明后，网页通道会在读取正文的同时单独读取该容器，
   * 把思维链作为 thinking 与最终答案分开返回，UI 用折叠块区分展示。
   * 未声明则不抓取思考（多数站点不单独暴露，或折叠后 innerText 为空）。
   */
  reasoning?: string
}

/** 输入框实现形态 */
export type InputKind = 'textarea' | 'contenteditable'

/** 发送方式 */
export type SendMode = 'click' | 'enter'

/**
 * 回复文本的读取策略。
 * - last：取最后一个匹配节点（绝大多数站点）
 * - all：拼接全部匹配节点（Kimi 这类 segment 分段模型）
 */
export type StreamMode = 'last' | 'all'

export type CompletionMode =
  /** 停止按钮消失即完成（ChatGPT / Claude / Qwen） */
  | 'stop_button_hidden'
  /** 生成中标志消失即完成（适用于无独立停止按钮的站点） */
  | 'generating_absent'
  /** 回复文本在 stable_ms 内无变化即完成（兜底，最鲁棒） */
  | 'dom_stable'
  | 'custom'

export interface AdapterSpec {
  id: string
  name: string
  transport: 'webview'
  entry: string
  selectors: AdapterSelectors
  /** 输入框形态，默认按 input 标签自动推断 */
  input_kind?: InputKind
  /** 发送方式，默认 click */
  send_mode?: SendMode
  /** 回复读取策略，默认 last */
  stream_mode?: StreamMode
  /** 思考容器读取策略，默认 last（取本轮新增的最后一个思考节点） */
  reasoning_mode?: StreamMode
  /**
   * 完成判定（PRD 6.6 落地注意）：
   * 不建议用 CSS 伪类 :hidden —— WebContentsView 内样式计算时序不稳定。
   * 默认用 stop_button_hidden，由注入脚本用 offsetParent 判定。
   */
  completion: {
    mode: CompletionMode
    timeout_s: number
    /** dom_stable 模式下的稳定判定窗口（ms） */
    stable_ms?: number
  }
  automation: {
    /** 逐字键入延迟区间（ms） */
    typing_delay_ms: [number, number]
    /** 发送前停顿（ms） */
    pre_send_pause_ms: [number, number]
    max_wait_s: number
    /** 时间抖动开关 —— 仅用于避免异常请求模式，不用于伪装身份（PRD 11.3） */
    jitter: boolean
  }
  /** 健康探针：探测该选择器是否存在即视为会话可用 */
  health_probe: string
  /** 上次成功验证时间，供 UI 展示新鲜度 */
  verified_at: string
  /** Cookie 预检无法覆盖页面导航后才生成凭据的站点时，启动页面预检 */
  prewarm?: boolean
  /** 站点服务条款可能限制自动化，首次接入时向用户提示 */
  tos_notice?: string
  /** 标识来源：内置 or 用户自建（用户自建不可删除内置项） */
  origin?: 'builtin' | 'user'
  /** 自建适配器的备注 */
  note?: string
}

/** 适配器运行时状态 */
export type AdapterHealth = 'ok' | 'selector-missing' | 'login-required' | 'entry-unreachable' | 'unknown'

export interface AdapterRuntime {
  spec: AdapterSpec
  health: AdapterHealth
  lastCheckedAt: number
  lastError?: string
}

/** 超过该天数未成功验证，UI 提示"长期未验证"（PRD 6.6） */
export const ADAPTER_STALE_DAYS = 30

/** 完成判定的执行顺序：mode 不可用时逐级降级 */
export const COMPLETION_FALLBACKS: CompletionMode[] = [
  'generating_absent',
  'stop_button_hidden',
  'dom_stable',
]
