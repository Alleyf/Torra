/**
 * 网页模型的「方案 → 适配器规格」映射，创建路径唯一定义处。
 *
 * 为什么要单独成模块：设置页「直接创建」、助手的 torra_create_web_model、
 * 离线真机验证（doctor --live）必须拿到**同一份** spec。映射若在各处各写一遍，
 * 命令行验证的就是另一套配置 —— 「doctor 说能跑」和「app 里能不能跑」失去等价关系。
 */

import type { AdapterSpec, CompletionMode, InputKind, SendMode, StreamMode } from '../../shared/adapter'
import type { WebPlan } from '../../shared/smart-add'

/** 建模型入参：渲染层「直接创建」按钮发过来的就是这一份 */
export interface WebModelInput {
  displayName: string
  entry: string
  color?: string
  selectors?: {
    input: string
    send?: string
    stop?: string
    generating?: string
    stream: string
  }
  input_kind?: InputKind
  send_mode?: SendMode
  stream_mode?: StreamMode
  completion_mode?: CompletionMode
  stable_ms?: number
  max_wait_s?: number
}

/**
 * 智能添加方案 → 建模型入参。
 *
 * 完成策略这里统一落到 dom_stable 兜底：custom 只是推断阶段的中间表达，
 * 运行时不认，传进去会让回合永远等不到完成判定。
 */
export function webModelInputFromPlan(p: WebPlan): WebModelInput {
  const sel = p.selectors
  return {
    displayName: p.name,
    entry: p.entry,
    selectors: {
      input: sel.input,
      ...(sel.send ? { send: sel.send } : {}),
      ...(sel.stop ? { stop: sel.stop } : {}),
      ...(sel.generating ? { generating: sel.generating } : {}),
      stream: sel.stream,
    },
    input_kind: p.input_kind,
    send_mode: p.send_mode,
    stream_mode: p.stream_mode,
    completion_mode: p.completion_mode === 'custom' ? 'dom_stable' : p.completion_mode,
    stable_ms: p.stable_ms,
  }
}

/** id 由名称派生（小写、非字母数字转连字符），两处生成模型 id 时走同一条规则 */
export function webModelSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'custom'
  )
}

/**
 * 建模型入参 → 适配器规格。
 *
 * 选择器全缺省时也要产出一个可运行的骨架（dom_stable + 通用兜底选择器），
 * 而不是拒绝创建：用户随后可以在页面上拾取校准。
 */
export function webSpecFromPlan(id: string, input: WebModelInput): AdapterSpec {
  const sel = input.selectors ?? { input: '', stream: '' }
  const mode: CompletionMode = input.completion_mode === 'custom' ? 'dom_stable' : (input.completion_mode ?? 'dom_stable')
  return {
    id,
    name: String(input.displayName ?? '').trim(),
    transport: 'webview',
    entry: String(input.entry ?? '').trim(),
    selectors: {
      input: sel.input || 'textarea',
      ...(sel.send ? { send: sel.send } : {}),
      ...(sel.stop ? { stop: sel.stop } : {}),
      ...(sel.generating ? { generating: sel.generating } : {}),
      stream: sel.stream || 'div',
    },
    ...(input.input_kind ? { input_kind: input.input_kind } : {}),
    send_mode: input.send_mode ?? (sel.send ? 'click' : 'enter'),
    stream_mode: input.stream_mode ?? 'last',
    completion: {
      mode,
      timeout_s: Math.round((input.max_wait_s ?? 180) * 1.2),
      ...(mode === 'dom_stable' ? { stable_ms: input.stable_ms ?? 3000 } : {}),
    },
    automation: {
      typing_delay_ms: [80, 220],
      pre_send_pause_ms: [500, 1500],
      max_wait_s: input.max_wait_s ?? 180,
      jitter: true,
    },
    health_probe: sel.input || 'textarea',
    verified_at: new Date().toISOString().slice(0, 10),
    origin: 'user',
    note: '用户自建。站点改版后请在「网页版模型」界面重新校准选择器。',
    tos_notice: '你正在为该站点启用自动化访问。请自行确认不违反其服务条款，账号风险自负。',
  }
}
