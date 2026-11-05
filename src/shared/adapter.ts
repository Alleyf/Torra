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
  /**
   * 最新一条助手消息容器（可选）。
   *
   * 只有「把正文读回本地」的通路才需要它：研讨模式、聊天模式的提取视图、
   * 以及生图/思考/步骤抓取。聊天模式的原生视图只投递、不回收，
   * 因此一个只配了 input（+ send）的适配器照样能用 —— 接入一个新站点的成本
   * 从「逆向出回复容器 + 完成判定语义」降到「找到输入框并能按发送」。
   * 缺它时提取通路会明确报错（见 WebviewAgent.send），不会静默读成空回复。
   */
  stream?: string
  /**
   * 正文渲染在 iframe 里的站点（灵光实测）：`stream` 命中的是主文档里的回合外壳，
   * 正文在它内部的一个帧里，外壳自己的文本只剩「已思考 Ns」状态条与页脚。
   *
   * 关键前提：灵光的帧是**跨源**的（`*.lingguang.uniocontent.com`），页面侧的
   * `iframe.contentDocument` 抛 SecurityError —— 注入脚本怎么写都读不到正文，
   * 那是同源策略，不是选择器问题。所以正文改由**主进程**进子帧读
   * （`WebFrameMain.executeJavaScript`，见 `src/main/webview/frames.ts`），
   * 页面侧只负责报「最后一个 stream 节点里挂了哪几个帧」。
   *
   * 本字段因此是**帧文档内**的选择器（灵光实测：`#render-finalAnswer`），
   * 不是主文档的。主进程按它执行同一份注入脚本取文，Markdown 保真与主文档一致。
   * 帧里取不到时退回页面侧的读法，于是选择器写错表现为「读到状态条」，
   * 比整轮读空好定位。
   */
  stream_frame?: string
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
  /**
   * 执行过程容器（可选）。
   *
   * agent 型站点（Kimi 等）把检索/跑代码/写文件等步骤渲染成独立块。
   * 声明后正文通道与步骤通道分开抓取，UI 用「执行过程」折叠块展示，
   * 正式回答里不再混着中间过程文本。
   */
  steps?: string
  /**
   * 用户气泡容器（可选）。只服务一件事：把「点左侧第 N 问 → 页面滚到那一问」
   * 从启发式升级成精确匹配。
   *
   * 留空也能定位，走的是注入脚本里的排除式启发：在全页文本里找我们打过的那句话，
   * 但把命中节点落在 `stream`（助手正文容器）或 `input`（输入框）子树里的排除掉 ——
   * 不这么排除会先命中对方的引用：站家常把问题原文复述一遍。
   * 配上这个字段就只在真气泡里找，并允许按序号取第 N 处命中。
   *
   * 与 `stream` 一样，它属于「会被站点改版打断」的那类知识，宁缺毋滥：
   * 没在浏览器里对着真实会话核验过就别填（实测样本：元宝的
   * `[data-conv-speaker="human"]` 带 `data-conv-idx` / `data-conv-id`，语义类名稳定；
   * DeepSeek 的用户气泡只有 CSS Module 哈希类名，随构建漂移，不配）。
   */
  user_turn?: string
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
  /** 步骤容器读取策略，默认 all（agent 站的步骤天然是多块流水账） */
  steps_mode?: StreamMode
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

/**
 * 适配器健康值 → 界面上的一句话。
 *
 * 放在 shared 里是因为现在有两个地方要显示它：设置页那块体检总表，
 * 以及**每个网页模型行内**的适配器状态。翻译抄成两份，就会出现
 * 「总表说选择器失效、行里说未体检」这种自相矛盾。
 */
export type AdapterTone = 'ok' | 'warn' | 'bad' | 'idle'

export interface AdapterHealthMeta {
  /** 给人看的中文状态词 */
  text: string
  /** 一句话说清「这意味着什么」 */
  detail: string
  tone: AdapterTone
}

const HEALTH_META: Record<AdapterHealth, AdapterHealthMeta> = {
  ok: { text: '正常', detail: '探测命中了页面里声明的元素，这个站点集成现在可用。', tone: 'ok' },
  'selector-missing': {
    text: '选择器失效',
    detail: '页面里找不到 YAML 声明的元素 —— 多半是站点改版了，需要更新 selectors。',
    tone: 'bad',
  },
  'login-required': {
    text: '需要登录',
    detail: '站点要求先登录才能探测；登录完再重测。',
    tone: 'warn',
  },
  'entry-unreachable': {
    text: '站点打不开',
    detail: '入口地址连不上：可能是网络问题，也可能站点地址变了。',
    tone: 'bad',
  },
  unknown: { text: '未体检', detail: '这个适配器还没有探测过。点「重测」跑一次。', tone: 'idle' },
}

/** 认不出的值原样显示，并说明「这是什么」——不编一个中文名 */
export function adapterHealthMeta(raw: string | undefined): AdapterHealthMeta {
  const key = raw ?? 'unknown'
  const known = HEALTH_META[key as AdapterHealth]
  if (known) return known
  return { text: key, detail: '这是主进程返回的原始状态值，暂时没有对应的中文解释。', tone: 'idle' }
}

/** 「有问题」= 明确坏了或需要登录；「未体检」单算一档，因为它不是故障 */
export const adapterToneBroken = (tone: AdapterTone): boolean => tone === 'bad' || tone === 'warn'

export interface AdapterRuntime {
  spec: AdapterSpec
  health: AdapterHealth
  lastCheckedAt: number
  lastError?: string
}

/** 超过该天数未成功验证，UI 提示"长期未验证"（PRD 6.6） */
export const ADAPTER_STALE_DAYS = 30

/** 适配器日期按用户本地日历记，不能用 UTC 切日把“今天”写成昨天 */
export function localDateStamp(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 完成判定的执行顺序：mode 不可用时逐级降级 */
export const COMPLETION_FALLBACKS: CompletionMode[] = [
  'generating_absent',
  'stop_button_hidden',
  'dom_stable',
]
