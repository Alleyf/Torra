/**
 * 助手 agent 的工具集：把 Torra 主进程已有的能力包装成 pi 工具。
 *
 * 三条不可让步的规则，决定了下面每个工具的写法：
 *
 * 1. **工具只收 Torra 的 id，不收密钥**。所有需要 key 的操作都在主进程里
 *    现场从钥匙串取（caps.resolveKey），LLM 既看不到也无需看到 key 值。
 *    创建 API 模型时 key 由用户在确认卡片里直接填给主进程，
 *    不经过 agent、不进对话记录、不进结果。
 *
 * 2. **写操作必须过用户确认闸门**。pi 的 `ctx.ui.confirm` 在这里不可用
 *    ——本应用没有 TUI/RPC，hasUI=false 时它静默返回 false，
 *    既会误拦正常操作，也会让模型以为「用户拒绝了」。
 *    所以确认走 caps.approve()：主进程 → 渲染层卡片 → 用户点允许/拒绝。
 *
 * 3. **输出必须有上限**。工具结果直接进上下文窗口，一次体检全量报告
 *    就能吃掉几万 token。这里只回「摘要 + 失败项 + 可执行建议」，
 *    并把长字段截断。
 *
 * 所有外部依赖都通过 AssistantCaps 注入，本模块不 import electron，
 * 因此可以在系统 Node 下用假 caps 做离线回归（scripts/test-assistant-tools.ts）。
 */

import type { TorraTool } from '../../shared/tool'
import type { AdapterSpec } from '../../shared/adapter'
import { WEB_ROLES, type WebPlan, type WebPlanResult, type WebRole } from '../../shared/smart-add'
import type {
  AssistantAdapterView,
  AssistantApiProbeResult,
  AssistantApprovalDecision,
  AssistantApprovalRequest,
  AssistantLogFilter,
  AssistantModelView,
  AssistantPageFacts,
  AssistantPluginView,
  AssistantSelectorFacts,
  ScheduledTaskInput,
  ScheduledTaskResult,
  ScheduledTaskView,
} from '../../shared/assistant'
import { isScheduleTime, SCHEDULE_RETENTION_DEFAULT } from '../../shared/assistant'
import type { DiagEvent, DiagLayer, DoctorReport } from '../../shared/diagnostics'
import type { MemoryMode, MemorySearchOutcome } from '../../shared/memory'
import type { ModelConfig } from '../../shared/types'
import { defineTool, Type } from '../../shared/tool'
import { compileParameters } from './plugins'
import { runWebSearch } from './web-search'
import { createFetchTool } from './fetch-url'

/** 单个工具结果文本的上限：约 8k 字符，够放一份失败清单又不至于吞掉窗口 */
const MAX_TEXT = 8000

// ---------------------------------------------------------------------------
// 主进程需要提供的能力
// ---------------------------------------------------------------------------

/** 确认卡片内容：id 由主进程投递时生成，工具侧不关心 */
export type ApprovalRequest = Omit<AssistantApprovalRequest, 'id'>
export type ApprovalResult = AssistantApprovalDecision
export type ModelView = AssistantModelView
export type PageFacts = AssistantPageFacts
export type SelectorFacts = AssistantSelectorFacts
export type AdapterView = AssistantAdapterView
export type ApiProbeResult = AssistantApiProbeResult
export type LogFilter = AssistantLogFilter

export interface AssistantCaps {
  listModels(): ModelView[]
  findModel(id: string): ModelConfig | undefined
  runDoctor(opts: { modelId?: string; probeApi: boolean }): Promise<DoctorReport>
  readLog(filter: LogFilter): DiagEvent[]
  pageFacts(modelId: string): Promise<PageFacts>
  verifySelector(modelId: string, selector: string): Promise<SelectorFacts>
  readAdapter(adapterId: string): AdapterView | undefined
  saveAdapter(spec: AdapterSpec): Promise<{ ok: boolean; errors?: string[] }>
  probeApiModel(modelId: string): Promise<ApiProbeResult>
  createApiModel(
    input: {
      displayName: string
      baseUrl: string
      model: string
      protocol?: 'openai' | 'anthropic'
      pricePerMTokIn?: number
      pricePerMTokOut?: number
      maxContextTokens?: number
    },
    apiKey: string,
  ): Promise<{ ok: boolean; errors?: string[]; id?: string }>
  createWebModel(input: {
    displayName: string
    entry: string
    selectors: { input: string; stream: string; send?: string; stop?: string; generating?: string }
    input_kind?: 'textarea' | 'contenteditable'
    send_mode?: 'click' | 'enter'
    stream_mode?: 'last' | 'all'
    completion_mode?: 'stop_button_hidden' | 'generating_absent' | 'dom_stable'
    stable_ms?: number
  }): Promise<{ ok: boolean; errors?: string[]; id?: string }>
  /**
   * 真机试发言：完整跑一轮「键入 → 发送 → 等回复 → 读回复」。
   * 静态体检只能证明选择器命中，证明不了这条链发得出去。
   */
  runWebTurn(
    modelId: string,
    text: string,
  ): Promise<{ ok: boolean; reason?: string; chars?: number; preview?: string; ms?: number }>
  deleteModel(modelId: string): Promise<{ ok: boolean; reason?: string }>
  openLogin(modelId: string): Promise<{ ok: boolean; reason?: string }>
  /**
   * 智能添加的识别链（与设置页向导同一条通道）。
   * 输入只是一个纯 URL —— 这正是「凭空建出第一个网页模型」的那一步。
   */
  scanSite(input: { entry: string }): Promise<WebPlanResult>
  answerSiteQuestions(planId: string, answers: Record<string, string>): Promise<WebPlanResult>
  checkSiteSelectors(planId: string, selectors: Partial<Record<WebRole, string>>): Promise<WebPlanResult>
  /**
   * 在扫描窗口里替用户发一条消息，等回复长出来后重新识别。
   * 回复容器只有在「页面上已有一条回复」时才验得了 —— 没有这一步，新站点的第一次识别必然卡在 stream。
   */
  driveSite(planId: string, text: string): Promise<WebPlanResult>
  closeSiteScan(): void
  approve(req: ApprovalRequest): Promise<ApprovalResult>
  /**
   * 应用插件提供的工具（启用的插件才有）。由 index.ts 注入，桥本身不 import 插件服务。
   * 返回空数组 = 没有插件；插件坏了的原因在插件视图里，不在这里重复。
   */
  appPluginTools?(): Array<{
    pluginId: string
    name: string
    label: string
    description: string
    parameters: Record<string, unknown>
    invoke(params: Record<string, unknown>): Promise<unknown>
  }>
  /** 启用插件的提示词段落（工具说明 + 工作方式）；空串表示没有 */
  appPluginPrompt?(): string
  /**
   * 在线搜索。可选：老 bridge / 测试桩没注入时，工具会明确告诉模型「搜索不可用」，
   * 而不是让模型改用记忆回答——那正是搜索功能要防的事。
   */
  searchWeb?(input: {
    query: string
    maxResults?: number
  }): Promise<import('./web-search').WebSearchOutcome>
  /**
   * 本地记忆库检索。kind=memory 的插件靠它执行；不注入时那类插件调用会明确报错。
   * 检索本身是只读的（查询文本在语义模式下会发往用户配置的嵌入端点）。
   */
  memorySearch?(input: {
    file: string
    query: string
    topK?: number
    mode?: MemoryMode
    signal?: AbortSignal
  }): Promise<MemorySearchOutcome>
  /** 往记忆库写一段内容。写入过确认卡片，所以工具层只负责组装卡片与回执。 */
  memoryRemember?(input: {
    file: string
    title: string
    text: string
    tags?: string[]
  }): Promise<{ ok: boolean; reason?: string; chunks?: number; lexicalOnly?: boolean }>
  /** 现有记忆库（给写入工具的描述用）；不注入时描述里就不列库名 */
  memoryStores?(): Array<{ file: string }>
  /**
   * 定时任务：清单读盘，新建 / 删除落盘。
   * 定时执行本身不经过这些工具 —— 到点由主进程用受限工具集跑一轮，
   * 所以这三个动作都不会让模型获得「随时触发一次任务」的能力。
   */
  listScheduled?(): Promise<ScheduledTaskView[]>
  scheduleTask?(input: ScheduledTaskInput): Promise<ScheduledTaskResult>
  removeScheduledTask?(id: string): Promise<ScheduledTaskResult>
  /**
   * 声明式插件的 {{secrets:REF}} 取值：只在调用那一瞬间存在。
   * 不给的话清单里引用钥匙串就是空值 —— 宁可让插件失败，也不能把 Key 放进配置对象。
   */
  pluginSecret?(ref: string): string | null
  /**
   * 「允许助手自建工具」开关。关着（默认）时那四个 authoring 工具连注册都不会注册 ——
   * 白名单里没有名字，模型调不到；把它写成运行时的 if 才是真的省掉一整类幻觉。
   */
  selfAuthoring?(): boolean
  /** 插件目录盘上的现状：有效的 + 无效的 + 目录本身 */
  listPlugins?(): { dir: string; plugins: AssistantPluginView[]; invalid: Array<{ name: string; file: string; errors: string[] }> }
  /**
   * 写入一条工具：kind=js 时 code 是必填的源码，会进待审区；
   * 其它种类只写清单，下一次装配就生效。
   */
  authorTool?(manifest: Record<string, unknown>, code?: string): Promise<{ ok: boolean; reason: string; pending?: boolean }>
  authorSkill?(input: { name: string; description: string; body: string }): Promise<{ ok: boolean; reason?: string }>
  removePlugin?(name: string): Promise<{ ok: boolean; reason: string }>
  /**
   * 「刚改完能力，什么时候生效」这句话由桥层说：它知道会话此刻能不能拆。
   * 工具层不自己拼句子，否则界面和模型看到的说法会分叉。
   */
  capabilityNote?(verb: string): string
  log(entry: { stage: string; subject?: string; ok: boolean; detail?: string }): void
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const ROLE_LABEL: Record<WebRole, string> = {
  input: '输入框',
  send: '发送按钮',
  stop: '停止按钮',
  stream: '回复容器',
  generating: '生成中容器',
}

/**
 * 把识别方案翻成模型据以行动的一段文本。
 *
 * 不直接 dump JSON：方案里 checks/why/confidence 是分散的几张贴图，
 * 模型要的是「哪个角色没验过、下一步改什么」。这里按可行动的顺序重排。
 */
function sitePlanText(plan: WebPlan): string {
  const lines: string[] = []
  const loginHint =
    plan.login.state === 'logged-out'
      ? '；未登录的站点根本没有对话 DOM，必须请用户在弹出的扫描窗口里本人登录，再重新 torra_scan_site'
      : ''
  lines.push(`方案 ${plan.planId}（第 ${plan.rounds} 轮，${plan.source === 'assistant' ? '配置助手推断' : '纯规则推断'}）`)
  lines.push(`站点：${plan.name} · ${plan.entry}`)
  lines.push(`登录态：${plan.login.state} —— ${plan.login.reason}${loginHint}`)
  lines.push('')
  lines.push('选择器与页面命中：')
  for (const role of WEB_ROLES) {
    const sel = plan.selectors[role]
    if (!sel) {
      lines.push(`- ${ROLE_LABEL[role]}：未识别`)
      continue
    }
    const c = plan.checks[role]
    lines.push(
      `- ${ROLE_LABEL[role]}：${sel} → ${c ? `${c.level} · 命中 ${c.matches}${c.note ? ` · ${c.note}` : ''}` : '尚未在页面校验'}`,
    )
  }
  lines.push('')
  lines.push(
    `取值：input_kind=${plan.input_kind} send_mode=${plan.send_mode} stream_mode=${plan.stream_mode} completion_mode=${plan.completion_mode} stable_ms=${plan.stable_ms}`,
  )
  const conf = Object.entries(plan.confidence).filter(([, v]) => typeof v === 'number')
  if (conf.length > 0) {
    lines.push(`置信：${conf.map(([k, v]) => `${k} ${Math.round(Number(v) * 100)}%`).join(' / ')}`)
  }
  const why = Object.entries(plan.why).filter(([, v]) => typeof v === 'string' && v)
  if (why.length > 0) {
    lines.push('依据：' + why.map(([k, v]) => `${k}：${v}`).join('；'))
  }
  if (plan.risks.length > 0) {
    lines.push('')
    lines.push('风险：')
    for (const r of plan.risks) lines.push(`- ${r}`)
  }
  if (plan.questions.length > 0) {
    lines.push('')
    lines.push(`待澄清 ${plan.questions.length} 项 —— 用 torra_answer_site_questions 回填，key 用问题 id，value 用选项 value：`)
    for (const q of plan.questions) {
      const opts = q.options.map((o) => `${o.value}（${o.label}${o.hint ? `，${o.hint}` : ''}）`).join(' / ')
      lines.push(`- ${q.id} → ${q.target}：${q.prompt}${opts ? `\n    可选：${opts}${q.free_text ? ' / 也可自由说明' : ''}` : ''}`)
    }
  }
  lines.push('')
  const streamBad = plan.checks.stream?.level === 'fail' || !plan.selectors.stream
  if (streamBad) {
    lines.push(
      '下一步：回复容器还没有着落 —— 先 torra_send_site_message 代发一条消息让回复长出来（会自动重识别）；之后仍有 fail 就 torra_check_site_selectors 换选择器回测（整套提交）。',
    )
  } else {
    lines.push(
      '下一步：仍有 fail/0 命中就 torra_check_site_selectors 换选择器回测（整套提交）；全部 ok 就 torra_create_web_model 建模型，再 torra_test_web_model 真发一轮确认通道可用，最后 torra_run_doctor 体检并 torra_close_site_scan 收窗口。',
    )
  }
  return lines.join('\n')
}

function clip(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n…（已截断 ${s.length - MAX_TEXT} 字符）` : s
}

/** 定时任务的时间都按本地时区显示：用户写的是 08:00，看到的也必须是 08:00 */
function formatTaskTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function text(body: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: body }]
}

function notFound(what: string, id: string): never {
  throw new Error(`${what}「${id}」不存在。先用 torra_list_models 看清单里的真实 id。`)
}

/**
 * 识别链三步（扫描 / 回填 / 回测）共用的返回形状。
 *
 * details 必须始终带同样的字段：pi 的泛型从 handler 的返回类型推断 details，
 * 失败分支给 { ok:false }、成功分支给整个 WebPlan，会被判成两个不相容的形状。
 */
function siteOutcome(
  r: WebPlanResult,
  onFail: (reason: string) => string,
): { content: ReturnType<typeof text>; details: { ok: boolean; plan: WebPlan | null } } {
  if (!r.ok || !r.plan) return { content: text(onFail(r.reason ?? '未知原因')), details: { ok: false, plan: null } }
  return { content: text(clip(sitePlanText(r.plan))), details: { ok: true, plan: r.plan } }
}

/** 拒绝时不抛错：把「用户不同意」当成正常结果回给模型，它才能改方案或追问 */
function denied(result: ApprovalResult): { content: ReturnType<typeof text>; details: Record<string, unknown> } {
  const why = result.reason ? `（${result.reason}）` : ''
  return {
    content: text(`用户拒绝了这个操作${why}。不要重试同一动作，请解释影响或询问用户想要什么。`),
    details: { approved: false },
  }
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export async function buildAssistantTools(caps: AssistantCaps): Promise<TorraTool[]> {
  const tools: TorraTool[] = [
    defineTool({
      name: 'torra_list_models',
      label: '列出模型',
      description:
        '列出 Torra 里全部模型（网页通道与 API 通道）及其 id、适配器、启用状态、是否配了 Key、当前状态灯。' +
        '任何按 id 操作的工具都要先用它拿到真实 id，不要凭记忆猜。',
      parameters: Type.Object({
        transport: Type.Optional(Type.String({ description: "只看某一通道：'api' 或 'webview'，缺省全部" })),
      }),
      async execute(_id, params) {
        const all = caps.listModels()
        const list = params.transport
          ? all.filter((m) => m.transport === params.transport)
          : all
        return {
          content: text(clip(JSON.stringify(list, null, 1))),
          details: { count: list.length },
        }
      },
    }),

    defineTool({
      name: 'torra_run_doctor',
      label: '运行体检',
      description:
        '跑一次全链路体检（环境→适配器→API→登录→通道→选择器→主持→产出），返回摘要与所有 warn/fail 项的证据、' +
        '修法和建议值。排查「为什么不能用」永远先跑它，不要直接猜。',
      parameters: Type.Object({
        modelId: Type.Optional(Type.String({ description: '只体检某个模型；缺省体检全部启用模型' })),
        probeApi: Type.Optional(Type.Boolean({ description: '是否向 API 端点发一次 /models 探测（需联网），默认 true' })),
      }),
      async execute(_id, params, signal) {
        const report = await caps.runDoctor({
          modelId: params.modelId,
          probeApi: params.probeApi !== false,
        })
        if (signal?.aborted) throw new Error('体检被取消')
        const bad = report.checks.filter((c) => c.status === 'warn' || c.status === 'fail')
        const lines = bad.map((c) =>
          [
            `[${c.status.toUpperCase()}] ${c.layer} · ${c.title}`,
            c.evidence.length ? `  证据：${c.evidence.join('；').slice(0, 400)}` : '',
            c.fix ? `  修法：${c.fix.slice(0, 300)}` : '',
            c.suggestion ? `  建议值：${c.suggestion.slice(0, 200)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
        return {
          content: text(
            [
              `结论：${report.summary.fail} fail / ${report.summary.warn} warn / ${report.summary.pass} pass / ${report.summary.skip} skip`,
              `范围：${report.scope}；userData：${report.userData}`,
              bad.length ? '需要处理的项目：\n' + lines.join('\n') : '没有失败或警告项。',
            ].join('\n'),
          ),
          details: { summary: report.summary, blockingLayer: report.blockingLayer },
        }
      },
    }),

    defineTool({
      name: 'torra_read_log',
      label: '读流水线日志',
      description:
        '读常驻流水线日志的最近条目（每一跳的层、阶段、耗时、成败与细节）。体检给不出「刚刚那次为什么失败」时用它。',
      parameters: Type.Object({
        layer: Type.Optional(
          Type.String({ description: '按层过滤：env/adapter/api/login/channel/selector/moderator/output/runtime' }),
        ),
        subject: Type.Optional(Type.String({ description: '按对象过滤，通常是模型 id' })),
        limit: Type.Optional(Type.Number({ description: '最多返回多少条，默认 60，上限 200' })),
      }),
      async execute(_id, params) {
        const limit = Math.min(200, Math.max(1, params.limit ?? 60))
        const layer = params.layer as DiagLayer | undefined
        const events = caps.readLog({ layer, subject: params.subject, limit })
        const lines = events.map((e) => {
          const t = new Date(e.ts).toISOString().slice(11, 19)
          const ok = e.ok === undefined ? '' : e.ok ? 'ok' : 'FAIL'
          return `${t} ${e.layer}/${e.stage}${e.subject ? ` ${e.subject}` : ''} ${ok}${e.ms ? ` ${e.ms}ms` : ''} ${e.detail ?? ''}`.trimEnd()
        })
        return {
          content: text(lines.length ? clip(lines.join('\n')) : '（最近没有匹配日志）'),
          details: { count: lines.length },
        }
      },
    }),

    defineTool({
      name: 'torra_page_facts',
      label: '查看页面实况',
      description:
        '读取某个网页模型当前页面的客观事实：地址、标题、登录态判定、输入框数量。' +
        '判断「是没登录还是选择器坏了」必须先看它，两者修法完全不同。',
      parameters: Type.Object({
        modelId: Type.String({ description: '网页通道模型 id' }),
      }),
      async execute(_id, params) {
        const facts = await caps.pageFacts(params.modelId)
        return {
          content: text(clip(JSON.stringify(facts, null, 1))),
          details: facts,
        }
      },
    }),

    defineTool({
      name: 'torra_verify_selector',
      label: '校验选择器',
      description:
        '在真实页面上校验一个 CSS 选择器：返回命中数，以及 covers（命中集合是否含着输入框）。' +
        '改 stream 选择器前后都要用它。covers=true 说明那是整页外壳，读出来会混进用户自己的提问。',
      parameters: Type.Object({
        modelId: Type.String({ description: '网页通道模型 id' }),
        selector: Type.String({ description: '待校验的 CSS 选择器' }),
      }),
      async execute(_id, params) {
        const facts = await caps.verifySelector(params.modelId, params.selector)
        const verdict = !facts.ok
          ? `校验失败：${facts.reason ?? '未知原因'}`
          : !facts.matches
            ? '页面上 0 命中，这个选择器现在不可用'
            : facts.covers
              ? '命中了，但里面包含输入框 —— 是整页/列表外壳，不能当回复容器'
              : `可用：命中 ${facts.matches} 个`
        return { content: text(verdict), details: facts }
      },
    }),

    defineTool({
      name: 'torra_read_adapter',
      label: '读适配器配置',
      description:
        '读取某个网页适配器的完整 YAML、来源（内置/用户）、健康状态与是否过期。改配置前先读原文，不要凭印象改。',
      parameters: Type.Object({
        adapterId: Type.String({ description: '适配器 id，来自 torra_list_models 的 adapterId' }),
      }),
      async execute(_id, params) {
        const view = caps.readAdapter(params.adapterId)
        if (!view) notFound('适配器', params.adapterId)
        return {
          content: text(
            [
              `# ${view.id}（来源 ${view.origin}，健康 ${view.health}${view.healthError ? `：${view.healthError}` : ''}${view.stale ? '，已过期' : ''}）`,
              view.yaml,
            ].join('\n'),
          ),
          details: { id: view.id, origin: view.origin, health: view.health, stale: view.stale },
        }
      },
    }),

    defineTool({
      name: 'torra_save_adapter',
      label: '保存适配器（需确认）',
      description:
        '保存一个网页适配器配置。整份覆盖：必须先 torra_read_adapter 拿到原 YAML，改掉要改的字段再提交。' +
        '写入的是用户目录副本（同 id 覆盖内置），内置文件不会被改坏；但漏掉的字段会退回校验默认值。',
      parameters: Type.Object({
        spec: Type.Any({ description: '完整的 AdapterSpec 对象：id/name/transport/entry/selectors/completion/automation/health_probe/verified_at' }),
      }),
      async execute(_id, params, signal) {
        const spec = params.spec as AdapterSpec
        if (!spec || typeof spec !== 'object') throw new Error('spec 必须是一个对象')
        const before = caps.readAdapter(String(spec.id ?? ''))
        const detail = before
          ? `将覆盖用户目录下的适配器「${spec.id}」（当前来源 ${before.origin}）。修改后立即热更新，影响该站点的所有后续对话。`
          : `将新建适配器「${spec.id}」（${spec.name ?? ''}），入口 ${spec.entry ?? '?'}`
        const decision = await caps.approve({
          action: 'save_adapter',
          title: '保存适配器',
          detail,
          risk: '选择器写错会让该站点通道静默读错内容，比直接报错更难发现。',
        })
        if (!decision.approved) return denied(decision)
        const saved = await caps.saveAdapter(spec)
        if (signal?.aborted) throw new Error('已取消')
        caps.log({ stage: 'assistant:save-adapter', subject: String(spec.id ?? ''), ok: saved.ok })
        return {
          content: text(
            saved.ok
              ? `已保存。下一次对话即生效（YAML 热更新约 300ms）。建议接着用 torra_verify_selector 复核关键选择器。`
              : `校验未通过，未写入：\n${(saved.errors ?? []).join('\n')}`,
          ),
          details: { ok: saved.ok, errors: saved.errors },
        }
      },
    }),

    defineTool({
      name: 'torra_probe_api_model',
      label: '探测 API 模型',
      description:
        '用某个 API 模型已保存的 Key 向它的端点发一次只读探测（GET /models 或等价接口），' +
        '返回可达性、状态码与模型清单。验证「Key 对不对、baseUrl 少没少 /v1」用它，不要让用户手动试。',
      parameters: Type.Object({
        modelId: Type.String({ description: 'API 通道模型 id' }),
      }),
      async execute(_id, params) {
        const r = await caps.probeApiModel(params.modelId)
        return {
          content: text(clip(JSON.stringify({ ...r, models: (r.models ?? []).slice(0, 60) }, null, 1))),
          details: r,
        }
      },
    }),

    defineTool({
      name: 'torra_create_api_model',
      label: '新建 API 模型（需确认）',
      description:
        '新建一个 API 通道模型并写入模型清单。Key 不在这里传：确认卡片会请用户自己填写，' +
        '直接进钥匙串，不经过对话记录。创建后模型出现在设置页。',
      parameters: Type.Object({
        displayName: Type.String({ description: '显示名' }),
        baseUrl: Type.String({ description: '端点，OpenAI 兼容通常以 /v1 结尾' }),
        model: Type.String({ description: '模型名，需在端点清单里' }),
        protocol: Type.Optional(Type.String({ description: "'openai'（默认）或 'anthropic'" })),
        pricePerMTokIn: Type.Optional(
          Type.Number({ description: '输入单价 USD/百万 token；省略则查内置公开价目表，认不出仍为 0，不确定时不要瞎填' }),
        ),
        pricePerMTokOut: Type.Optional(
          Type.Number({ description: '输出单价 USD/百万 token；省略则查内置公开价目表，认不出仍为 0，不确定时不要瞎填' }),
        ),
        maxContextTokens: Type.Optional(Type.Number({ description: '上下文窗口 token，默认 128000' })),
      }),
      async execute(_id, params, signal) {
        const decision = await caps.approve({
          action: 'create_api_model',
          title: '新建 API 模型',
          detail: `${params.displayName} · ${params.protocol ?? 'openai'} · ${params.baseUrl} · ${params.model}`,
          risk: '需要你在卡片里填写 API Key；Key 只会进入系统钥匙串，不会写入配置或对话。',
          needsKey: true,
        })
        if (!decision.approved) return denied(decision)
        if (!decision.apiKey) {
          return {
            content: text('用户批准了但没有填写 API Key，创建已中止。请让用户在设置页补填，或改用已有模型。'),
            details: { ok: false, reason: 'no-key' },
          }
        }
        const created = await caps.createApiModel(
          {
            displayName: params.displayName,
            baseUrl: params.baseUrl,
            model: params.model,
            protocol: params.protocol === 'anthropic' ? 'anthropic' : 'openai',
            pricePerMTokIn: params.pricePerMTokIn,
            pricePerMTokOut: params.pricePerMTokOut,
            maxContextTokens: params.maxContextTokens,
          },
          decision.apiKey,
        )
        if (signal?.aborted) throw new Error('已取消')
        caps.log({ stage: 'assistant:create-api-model', subject: created.id, ok: created.ok })
        return {
          content: text(
            created.ok
              ? `已创建模型 ${created.id}。建议接着用 torra_probe_api_model 验证端点可达。`
              : `创建失败：${(created.errors ?? []).join('；')}`,
          ),
          details: created,
        }
      },
    }),

    defineTool({
      name: 'torra_scan_site',
      label: '识别新站点',
      description:
        '给一个纯 URL 就能识别网页站点：打开扫描窗口、读真实页面、产出候选选择器并当场回测命中数，' +
        '同时列出拿不准的澄清问题。这是新建网页模型的第一步，不需要先存在模型。' +
        '会在用户屏幕上弹出一个临时窗口（应用顶部有横幅可以直接关掉它），向用户说明一下。' +
        '若某一步回「识别窗口已被关闭」，那是用户主动关的：不要连续重试，先问用户要不要继续识别。',
      parameters: Type.Object({
        entry: Type.String({ description: '站点入口 URL（http/https）' }),
      }),
      async execute(_id, params, signal) {
        caps.log({ stage: 'assistant:scan-site', subject: params.entry, ok: true })
        const r = await caps.scanSite({ entry: params.entry })
        if (signal?.aborted) throw new Error('已取消')
        return siteOutcome(r, (why) => `${why}。不要把失败当成「站点不支持接入」，先按原因处理再重试。`)
      },
    }),

    defineTool({
      name: 'torra_answer_site_questions',
      label: '回填澄清问题',
      description:
        '把 torra_scan_site 列出的澄清问题答案回填，回填后会重新在页面上回测。' +
        'key 用问题的 id（不是 target），value 用选项的 value。' +
        '能从页面事实判断的就自己答；只有需要用户决定的（如站点名称、合规取舍）才去问用户。',
      parameters: Type.Object({
        planId: Type.String({ description: 'torra_scan_site 返回的方案 id' }),
        answers: Type.Any({
          description: '形如 { "q_ab12": "contenteditable" }；一次可答多条，未答的保持待确认',
        }),
      }),
      async execute(_id, params, signal) {
        const raw = params.answers as unknown
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('answers 必须是 { 问题 id: 选项 value } 这样的对象')
        }
        const answers: Record<string, string> = {}
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === 'string' && v.trim()) answers[k] = v.slice(0, 400)
        }
        if (Object.keys(answers).length === 0) throw new Error('answers 里没有有效的字符串答案')
        const r = await caps.answerSiteQuestions(params.planId, answers)
        if (signal?.aborted) throw new Error('已取消')
        return siteOutcome(r, (why) => `回填失败：${why}`)
      },
    }),

    defineTool({
      name: 'torra_check_site_selectors',
      label: '回测候选选择器',
      description:
        '手工改选择器后在真实页面上重新回测，返回每个角色的命中数与 ok/warn/fail。' +
        '**整套提交**：没传的角色会被清空，所以先照上一次的输出把要保留的选择器一并带上。' +
        'stream 命中集合里若含输入框（covers/fail），说明那是整页外壳，绝不能拿去当回复容器。',
      parameters: Type.Object({
        planId: Type.String({ description: '方案 id' }),
        input: Type.String({ description: '输入框选择器' }),
        stream: Type.String({ description: '单条回复容器选择器' }),
        send: Type.Optional(Type.String({ description: '发送按钮；用回车发送就不填' })),
        stop: Type.Optional(Type.String({ description: '停止按钮' })),
        generating: Type.Optional(Type.String({ description: '生成中容器' })),
      }),
      async execute(_id, params, signal) {
        const r = await caps.checkSiteSelectors(params.planId, {
          input: params.input,
          stream: params.stream,
          ...(params.send ? { send: params.send } : {}),
          ...(params.stop ? { stop: params.stop } : {}),
          ...(params.generating ? { generating: params.generating } : {}),
        })
        if (signal?.aborted) throw new Error('已取消')
        return siteOutcome(r, (why) => `回测失败：${why}`)
      },
    }),

    defineTool({
      name: 'torra_send_site_message',
      label: '代发消息并重识别（需确认）',
      description:
        '在识别用的扫描窗口里替用户输入并发送一条消息，等站点回出一段文字，然后用同一套闭环重新识别一遍。' +
        '这一步专门解「回复容器 0 候选」：新开的对话页面上没有助手回复，stream 永远验不出来，' +
        '光靠只读工具卡住时不要再去麻烦用户手动发，用它。' +
        '消息会真的发进用户账号下的对话里，所以必须过确认卡片；正文用一句无意义短话即可（默认「你好」），不要贴敏感内容。',
      parameters: Type.Object({
        planId: Type.String({ description: '方案 id（torra_scan_site 返回的）' }),
        text: Type.Optional(Type.String({ description: '代发的内容，默认「你好」；一句话就够' })),
      }),
      async execute(_id, params, signal) {
        const body = String(params.text ?? '').trim().slice(0, 200) || '你好'
        const decision = await caps.approve({
          action: 'drive_site',
          title: '代发消息给站点',
          detail: `将在识别窗口里输入并发送：「${body}」，然后等回复出现并重新识别。`,
          risk: '这条消息会真的发到该站点，并在你的账号下留下一条对话记录。',
        })
        if (!decision.approved) return denied(decision)
        caps.log({ stage: 'assistant:send-site-message', subject: params.planId, ok: true })
        const r = await caps.driveSite(params.planId, body)
        if (signal?.aborted) throw new Error('已取消')
        return siteOutcome(r, (why) => `代发消息没成功：${why}。`)
      },
    }),

    defineTool({
      name: 'torra_close_site_scan',
      label: '关闭识别窗口',
      description:
        '关掉智能识别用的临时扫描窗口。识别结束（建好模型或决定放弃）就收掉，' +
        '别把窗口留在用户桌面上；登录态保存在独立分区里，关掉不会丢。',
      parameters: Type.Object({}),
      async execute() {
        caps.closeSiteScan()
        caps.log({ stage: 'assistant:close-site-scan', ok: true })
        return { content: text('扫描窗口已关闭。'), details: { ok: true } }
      },
    }),

    defineTool({
      name: 'torra_create_web_model',
      label: '新建网页模型（需确认）',
      description:
        '用一组已验证的选择器新建网页通道模型。选择器必须先在真实页面验过：已有模型用 torra_verify_selector，' +
        '新站点用 torra_scan_site / torra_check_site_selectors 出的方案。' +
        '方案里的 stream_mode 与 stable_ms 要照抄过来，漏填会退回默认值，等于把刚验好的判定改掉。',
      parameters: Type.Object({
        displayName: Type.String({ description: '显示名' }),
        entry: Type.String({ description: '入口 URL' }),
        input: Type.String({ description: '提问输入框选择器（页面上必须唯一命中）' }),
        stream: Type.String({ description: '单条回复容器选择器（covers 必须为 false）' }),
        send: Type.Optional(Type.String({ description: '发送按钮选择器；用回车发送时留空' })),
        stop: Type.Optional(Type.String({ description: '停止按钮选择器（completion_mode=stop_button_hidden 时必填）' })),
        generating: Type.Optional(Type.String({ description: '生成中容器选择器（completion_mode=generating_absent 时必填）' })),
        input_kind: Type.Optional(Type.String({ description: "'textarea' 或 'contenteditable'" })),
        send_mode: Type.Optional(Type.String({ description: "'click'（默认）或 'enter'" })),
        stream_mode: Type.Optional(Type.String({ description: "'last'（默认，只取最后一条）或 'all'" })),
        completion_mode: Type.Optional(
          Type.String({ description: 'dom_stable | stop_button_hidden | generating_absent，默认 dom_stable' }),
        ),
        stable_ms: Type.Optional(Type.Number({ description: 'dom_stable 的无变化判定时长（ms），默认 3000' })),
      }),
      async execute(_id, params, signal) {
        const decision = await caps.approve({
          action: 'create_web_model',
          title: '新建网页模型',
          detail: `${params.displayName} · ${params.entry}\ninput=${params.input}\nstream=${params.stream}`,
          risk: '自动化访问站点可能违反其服务条款，账号风险由使用者承担。',
        })
        if (!decision.approved) return denied(decision)
        const created = await caps.createWebModel({
          displayName: params.displayName,
          entry: params.entry,
          selectors: {
            input: params.input,
            stream: params.stream,
            ...(params.send ? { send: params.send } : {}),
            ...(params.stop ? { stop: params.stop } : {}),
            ...(params.generating ? { generating: params.generating } : {}),
          },
          ...(params.input_kind === 'contenteditable' || params.input_kind === 'textarea'
            ? { input_kind: params.input_kind }
            : {}),
          ...(params.send_mode === 'enter' || params.send_mode === 'click' ? { send_mode: params.send_mode } : {}),
          ...(params.stream_mode === 'last' || params.stream_mode === 'all' ? { stream_mode: params.stream_mode } : {}),
          ...(typeof params.stable_ms === 'number' && params.stable_ms > 0
            ? { stable_ms: Math.round(params.stable_ms) }
            : {}),
          ...(params.completion_mode === 'dom_stable' ||
          params.completion_mode === 'stop_button_hidden' ||
          params.completion_mode === 'generating_absent'
            ? { completion_mode: params.completion_mode }
            : {}),
        })
        if (signal?.aborted) throw new Error('已取消')
        caps.log({ stage: 'assistant:create-web-model', subject: created.id, ok: created.ok })
        return {
          content: text(
            created.ok
              ? `已创建模型 ${created.id}。接着 torra_test_web_model 真发一轮确认通道可用（体检全绿不等于发得出去）；识别过的话再 torra_close_site_scan 收掉临时窗口。`
              : `创建失败：${(created.errors ?? []).join('；')}`,
          ),
          details: created,
        }
      },
    }),

    defineTool({
      name: 'torra_test_web_model',
      label: '真机试发言（需确认）',
      description:
        '给已注册的网页模型真发一条消息，完整走一遍「键入 → 发送 → 等回复 → 读回复」，把站点回出的正文开头带回来。' +
        '体检各层都是静态观测，「选择器命中」不等于「发得出去」—— 元宝就在全绿之后报过 input vanished before send。' +
        '新建网页模型后要拿它下「能用」的结论，不要只看 torra_run_doctor。消息会真的发进用户账号下的对话，必须过确认卡片。',
      parameters: Type.Object({
        modelId: Type.String({ description: '模型 id（torra_list_models 或 torra_create_web_model 返回的）' }),
        text: Type.Optional(
          Type.String({ description: '试发言内容，默认「用一句话介绍你自己」；一句话就够，不要贴敏感内容' }),
        ),
      }),
      async execute(_id, params, signal) {
        const m = caps.findModel(params.modelId)
        if (!m) notFound('模型', params.modelId)
        const body = String(params.text ?? '').trim().slice(0, 200) || '用一句话介绍你自己'
        const decision = await caps.approve({
          action: 'test_web_model',
          title: '真机试发言',
          detail: `将在「${m?.displayName ?? params.modelId}」的页面上输入并发送：「${body}」，然后等它回一条。`,
          risk: '这条消息会真的发进该站点的一次对话里，并消耗一次生成。',
        })
        if (!decision.approved) return denied(decision)
        const r = await caps.runWebTurn(params.modelId, body)
        if (signal?.aborted) throw new Error('已取消')
        caps.log({ stage: 'assistant:test-web-model', subject: params.modelId, ok: r.ok })
        return {
          content: text(
            r.ok
              ? `通道可用：收到 ${r.chars} 字回复，耗时 ${Math.round((r.ms ?? 0) / 1000)}s。开头：${clip(r.preview ?? '')}`
              : `通道不可用：${r.reason ?? '未知原因'}。这是运行时的真实失败，选择器命中数解释不了 —— 按这条原因改适配器（torra_read_adapter → torra_save_adapter），改完再试一次。`,
          ),
          details: r,
        }
      },
    }),

    defineTool({
      name: 'torra_delete_model',
      label: '删除模型（需确认）',
      description: '删除一个用户自建模型。内置模型不可删除。这是破坏性操作，删除前必须向用户说明失去什么。',
      parameters: Type.Object({
        modelId: Type.String({ description: '要删除的模型 id' }),
      }),
      async execute(_id, params, signal) {
        const m = caps.findModel(params.modelId)
        if (!m) notFound('模型', params.modelId)
        const decision = await caps.approve({
          action: 'delete_model',
          title: '删除模型',
          detail: `将删除「${m.displayName}」（${m.id}）。`,
          risk: '模型清单与钥匙串里的对应 Key 都会移除，历史讨论记录保留但无法复现该模型。',
          modelId: m.id,
        })
        if (!decision.approved) return denied(decision)
        const r = await caps.deleteModel(params.modelId)
        if (signal?.aborted) throw new Error('已取消')
        caps.log({ stage: 'assistant:delete-model', subject: m.id, ok: r.ok })
        return {
          content: text(r.ok ? `已删除 ${m.displayName}。` : `删除失败：${r.reason ?? '未知原因'}`),
          details: r,
        }
      },
    }),

    defineTool({
      name: 'torra_open_login',
      label: '打开登录页（需确认）',
      description:
        '把某个网页模型的页面在应用的「网页视图」里打开（那块视图自带关闭按钮），让用户自己完成登录（含验证码、扫码）。' +
        'agent 永远不能替用户输入凭据；登录判定只在用户点「我已登录完成」后由主进程复核。',
      parameters: Type.Object({
        modelId: Type.String({ description: '网页通道模型 id' }),
      }),
      async execute(_id, params, signal) {
        const m = caps.findModel(params.modelId)
        if (!m) notFound('模型', params.modelId)
        const decision = await caps.approve({
          action: 'open_login',
          title: '打开登录页',
          detail: `将在应用的「网页视图」里打开「${m.displayName}」的页面，需要你亲自完成登录；看完点该视图右上角 × 关闭。`,
          modelId: m.id,
        })
        if (!decision.approved) return denied(decision)
        const r = await caps.openLogin(params.modelId)
        if (signal?.aborted) throw new Error('已取消')
        return {
          content: text(
            r.ok
              ? '页面已在应用的「网页视图」里打开（右上角 × 关闭）。请告诉用户完成登录后点「我已登录完成」；期间不要再调用工具，等待用户下一条消息。'
              : `打开失败：${r.reason ?? '未知原因'}`,
          ),
          details: r,
        }
      },
    }),
  ]

    // 抓取工具与搜索不同：它不需要任何 Provider 配置，只要有网就能用。
  // 地址、方法、体积上限都在 fetch-url.ts 里守；这里只负责把它挂进工具集。
  tools.push(createFetchTool())

  // 搜索工具始终注册，但实际能不能用由 caps.searchWeb 在调用时判断：
    // 系统提示词里会说明开关状态，模型知道有这条路，调用时再得到明确失败原因。
    tools.push(
      defineTool({
        name: 'torra_web_search',
        label: '联网搜索',
        description:
          '搜索互联网获取最新信息（新闻、文档、价格、软件版本、近期事件等）。' +
          '当用户问到训练数据可能不知道的内容，或明确要求「查一下 / 最新 / 今天 / 现在」时使用。' +
          '返回的链接是唯一信息来源：回答必须基于这些结果，禁止凭记忆补充或编造；' +
          '搜索失败时如实说明原因，不要假装搜过。',
        parameters: Type.Object({
          query: Type.String({ description: '搜索关键词，1-500 字符，用能命中原文的短句' }),
          maxResults: Type.Optional(
            Type.Number({ description: '返回条数，1-8，缺省 5；够用就好，不要贪多' }),
          ),
        }),
        async execute(_id, params, signal) {
          if (!caps.searchWeb) {
            return {
              content: text(
                '在线搜索当前不可用（主进程未接入搜索服务）。请让用户到「设置 - 搜索」检查开关与密钥。',
              ),
              details: { ok: false, count: 0 },
            }
          }
          const r = await caps.searchWeb({ query: params.query, maxResults: params.maxResults })
          if (signal?.aborted) throw new Error('搜索已取消')
          if (!r.ok) {
            return {
              content: text(`搜索失败：${r.reason ?? '未知原因'}`),
              details: { ok: false, count: 0 },
            }
          }
          const lines = r.hits.map((h, i) =>
            [
              `[${i + 1}] ${h.title}`,
              `    ${h.url}`,
              h.snippet ? `    ${h.snippet}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          )
          return {
            content: text(
              [
                `已通过 ${r.provider === 'tavily' ? 'Tavily' : 'AnySearch'} 找到 ${r.hits.length} 条结果：`,
                ...lines,
                '回答时只引用上面这些来源，不要引入结果里没有出现的结论。',
              ].join('\n'),
            ),
            details: { ok: true, count: r.hits.length },
          }
        },
      }),
    )

  // 记忆库：检索走 kind=memory 的声明式插件；写入留在这里 —— 它是唯一会改动
  // 磁盘上记忆库的操作，必须过确认卡片，而闸门只有内置工具这一层挂得住。
  const memoryStores = caps.memoryStores?.() ?? []
  tools.push(
    defineTool({
      name: 'torra_memory_remember',
      label: '写入记忆库（需确认）',
      description:
        '把一段值得以后复用的内容写进本地记忆库（结论、事实、用户偏好、查证过的数据）。' +
        (memoryStores.length
          ? `现有记忆库：${memoryStores.map((s) => s.file).join('、')}。`
          : '当前还没有记忆库，需要用户先在「设置 - 资源库 - 记忆」里新建一个。') +
        '写入前必须把原文给出并得到用户确认；不要写闲聊、临时状态或别处一查就有的一般常识。',
      parameters: Type.Object({
        file: Type.String({ description: '目标记忆库文件名，如 notes.mv2' }),
        title: Type.String({ description: '这条记忆的标题，一句话说清它是什么' }),
        text: Type.String({ description: '要写入的完整内容：保留关键数字与原文，不要只写摘要' }),
        tags: Type.Optional(Type.Array(Type.String(), { description: '可选标签，最多 8 个' })),
      }),
      async execute(_id, params, signal) {
        if (!caps.memoryRemember) {
          return {
            content: text('本地记忆库当前不可用（主进程没有接入记忆服务）。'),
            details: { ok: false },
          }
        }
        const bytes = Buffer.byteLength(params.text, 'utf8')
        const lines = params.text.split(/\r?\n/).length
        const shown =
          params.text.length > 1200 ? `${params.text.slice(0, 1200)}\n…（已截断，共 ${params.text.length} 字符）` : params.text
        const decision = await caps.approve({
          action: 'memory_write',
          title: `写入记忆库 ${params.file}`,
          detail: [
            `记忆库：${params.file}`,
            `标题：${params.title}`,
            `规模：${bytes} 字节，${lines} 行`,
            ...(params.tags?.length ? [`标签：${params.tags.join('、')}`] : []),
            '',
            '内容：',
            shown,
          ].join('\n'),
          risk: '写入后这段内容会长期留在本地库里，以后整场对话都可能检索到它；配了嵌入端点时这段文字会发往该端点。',
        })
        if (!decision.approved) return denied(decision)
        const r = await caps.memoryRemember({
          file: params.file,
          title: params.title,
          text: params.text,
          ...(params.tags?.length ? { tags: params.tags } : {}),
        })
        if (signal?.aborted) throw new Error('已取消')
        caps.log({ stage: 'assistant:memory-remember', subject: params.file, ok: r.ok, detail: r.reason })
        return {
          content: text(
            r.ok
              ? `已写入 ${params.file}（${r.chunks ?? 0} 段）${r.lexicalOnly ? '；还没配嵌入端点，这条暂时只能按词法检索。' : '。'}`
              : `写入失败：${r.reason ?? '未知原因'}`,
          ),
          details: r,
        }
      },
    }),
  )

  /*
   * 定时任务：清单、新建、删除。
   *
   * 新建必须过确认卡片 —— 后台那一轮没有人坐在旁边点确认，闸门只能设在「定义任务」
   * 这一步：地址、产出目录、保留期在这一刻由人看清，之后每一轮才敢在无人值守下跑。
   */
  tools.push(
    defineTool({
      name: 'torra_list_scheduled',
      label: '列出定时任务',
      description:
        '列出本机配置的定时任务：时间、开关、产出目录、保留天数、最近一次运行结果。' +
        '改或删任务前先用它拿真实 id，不要凭记忆猜。',
      parameters: Type.Object({}),
      async execute() {
        const tasks = (await caps.listScheduled?.()) ?? []
        if (!tasks.length) {
          return { content: text('还没有定时任务。'), details: { count: 0 } }
        }
        const lines = tasks.map((t) => {
          const last = t.lastRun
            ? `${formatTaskTime(t.lastRun.startedAt)} ${t.lastRun.ok ? '成功' : `失败：${t.lastRun.error ?? '未知'}`}`
            : '还没跑过'
          const next = t.nextRunAt ? `下次 ${formatTaskTime(t.nextRunAt)}` : '已停用'
          return `- ${t.id} · ${t.title} · 每天 ${t.time} · ${next} · 产出 ${t.outDir} · 保留 ${t.retentionDays} 天 · 最近 ${last}`
        })
        return { content: text(clip(lines.join('\n'))), details: { count: tasks.length } }
      },
    }),
    defineTool({
      name: 'torra_schedule_task',
      label: '新建定时任务（需确认）',
      description:
        '把一件每天要做的事固定下来：到点后后台助手用受限工具抓取地址、整理内容、把成品写进任务目录。' +
        'prompt 必须是一条能独立执行的完整指令（含地址、整理成什么样、文件名怎么写）—— 到点时没有人在场补充说明。' +
        '只在用户明确要求「每天/定时/自动」时使用；只做一次就直接做，不要建任务。',
      parameters: Type.Object({
        title: Type.String({ description: '任务名，最多 60 字' }),
        prompt: Type.String({ description: '完整指令：抓哪个地址、整理成什么、文件怎么写；最多 8000 字' }),
        time: Type.String({ description: "每天几点执行，HH:MM（24 小时制，本地时间），例如 08:00" }),
        retentionDays: Type.Optional(Type.Number({ description: '产出保留天数，默认 30；0 = 不清理' })),
        outDir: Type.Optional(Type.String({ description: '产出目录（绝对路径）；留空用应用默认目录' })),
        modelId: Type.Optional(Type.String({ description: '用哪个模型跑；留空用当前助手模型' })),
      }),
      async execute(_id, params, signal) {
        if (!caps.scheduleTask) {
          return { content: text('当前环境没有接入定时任务。'), details: { ok: false, id: '' } }
        }
        if (!isScheduleTime(params.time)) {
          return { content: text('时间要写成 HH:MM（24 小时制），例如 08:00'), details: { ok: false, id: '' } }
        }
        const keep = params.retentionDays ?? SCHEDULE_RETENTION_DEFAULT
        const decision = await caps.approve({
          action: 'schedule_task',
          title: `每天 ${params.time} 运行「${params.title}」`,
          detail: [
            `时间：每天 ${params.time}（本地时间；只在 Torra 运行时触发，关机错过的一天会在下次启动时补跑一次）`,
            params.outDir ? `产出目录：${params.outDir}` : '产出目录：应用默认目录（每个任务一个子目录）',
            `保留：${keep} 天${keep === 0 ? '（不清理）' : ''}`,
            '',
            '指令：',
            params.prompt.length > 1200 ? `${params.prompt.slice(0, 1200)}\n…（已截断，共 ${params.prompt.length} 字）` : params.prompt,
          ].join('\n'),
          risk: '到点后这一轮不需要你再确认：它会联网抓取上面的地址，并把内容写进产出目录。请确认地址与目录无误。',
        })
        if (!decision.approved) return denied(decision)
        const r = await caps.scheduleTask({ ...params, retentionDays: keep })
        if (signal?.aborted) throw new Error('已取消')
        caps.log({ stage: 'assistant:schedule-task', subject: r.id, ok: r.ok, detail: r.reason })
        return {
          content: text(
            r.ok
              ? `已创建 ${r.id}：每天 ${params.time} 运行。${r.task?.outDir ? `产出写入 ${r.task.outDir}。` : ''}每次运行会作为独立会话出现在助手历史里，结果也能在「资源库 - 定时」里看；想先验一次就在那一页点「立即运行」。`
              : `创建失败：${r.reason ?? '未知原因'}`,
          ),
          details: { ok: r.ok, id: r.id ?? '' },
        }
      },
    }),
    defineTool({
      name: 'torra_remove_scheduled',
      label: '删除定时任务（需确认）',
      description:
        '删除一条定时任务的定义。已经写出的产出文件不动。删除前先 torra_list_scheduled 确认 id 与任务名。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id，来自 torra_list_scheduled' }),
      }),
      async execute(_id, params, signal) {
        if (!caps.removeScheduledTask) {
          return { content: text('当前环境没有接入定时任务。'), details: { ok: false } }
        }
        const tasks = (await caps.listScheduled?.()) ?? []
        const t = tasks.find((x) => x.id === params.id)
        if (!t) {
          throw new Error(`定时任务「${params.id}」不存在。先用 torra_list_scheduled 看清单里的真实 id。`)
        }
        const decision = await caps.approve({
          action: 'remove_scheduled_task',
          title: `删除定时任务「${t.title}」`,
          detail: `将删除每天 ${t.time} 的那条任务定义。已经写出的文件保留在 ${t.outDir} 里，不会被删除。`,
        })
        if (!decision.approved) return denied(decision)
        const r = await caps.removeScheduledTask(params.id)
        if (signal?.aborted) throw new Error('已取消')
        caps.log({ stage: 'assistant:remove-scheduled', subject: params.id, ok: r.ok, detail: r.reason })
        return {
          content: text(r.ok ? `已删除 ${params.id}。` : `删除失败：${r.reason ?? '未知原因'}`),
          details: { ok: r.ok },
        }
      },
    }),
  )

  const selfAuthoring = caps.selfAuthoring?.() === true
  // 开关关着时这五个工具连注册都没有：白名单里没名字、系统提示词里也不提。
  // 只在运行时加 if 会让模型看到工具说明却调不到，那是最难查的一类幻觉。
  if (selfAuthoring) tools.push(...authoringTools(caps))

  // 名字表与定义表必须同源：漏一项就是「工具注册了却被白名单过滤掉，而且不报错」
  // （session.ts 坑 2 的那类哑火）。宁可在这里响一声。
  const declared = [...ASSISTANT_TOOL_NAMES, ...(selfAuthoring ? AUTHORING_TOOL_NAMES : [])]
  const built = tools.map((t) => t.name)
  const onlyBuilt = built.filter((n) => !declared.includes(n))
  const onlyDeclared = declared.filter((n) => !built.includes(n))
  if (onlyBuilt.length || onlyDeclared.length) {
    throw new Error(
      `工具名白名单与定义不同步：${onlyBuilt.length ? `清单缺 ${onlyBuilt.join('、')}` : ''}${onlyDeclared.length ? ` 定义缺 ${onlyDeclared.join('、')}` : ''}`,
    )
  }

  /*
   * 应用插件工具。
   *
   * 必须在上面那次对账之后追加：那张对账表说的是「静态定义 vs 静态名单」，
   * 插件工具是运行时才存在的第三类名字，塞进去只会让每次对账都报假警。
   * 名字前缀由清单校验保证（`<插件 id>_`），但仍要挡住重名：插件 id 取 `torra`
   * 就能声明出 `torra_run_doctor`，与内置工具同名时模型点谁都是猜。
   */
  const taken = new Set(built)
  for (const spec of caps.appPluginTools?.() ?? []) {
    if (taken.has(spec.name)) {
      caps.log({
        stage: 'assistant:plugin-tool',
        subject: spec.name,
        ok: false,
        detail: '与已有工具重名，已跳过',
      })
      continue
    }
    let parameters: unknown
    try {
      parameters = compileParameters(spec.parameters)
    } catch (error) {
      // 一条编不过就跳过这一条：整批失败会让「别的插件也不能用」变成连带伤害
      caps.log({
        stage: 'assistant:plugin-tool',
        subject: spec.name,
        ok: false,
        detail: `参数 schema 编译失败：${(error as Error).message}`,
      })
      continue
    }
    tools.push(
      defineTool({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: parameters as never,
        async execute(_id: string, params: Record<string, unknown>) {
          const value = await spec.invoke(params)
          const body = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 1)
          return {
            content: text(clip(body)),
            details: { plugin: spec.pluginId },
          }
        },
      }),
    )
    taken.add(spec.name)
  }
  return tools
}

/** 自建能力的工具名；和下面 authoringTools() 里的定义必须同步 */
export const AUTHORING_TOOL_NAMES = [
  'torra_list_plugins',
  'torra_author_tool',
  'torra_author_skill',
  'torra_remove_plugin',
]

/**
 * 助手自建能力：工具清单、技能，各一个写操作 + 一个只读查询。
 *
 * 三条刻意的不对称：
 * —— 写数据类清单和写技能都是「写一份数据」，卡片看完就点头；
 * —— kind=js 的卡片放的是**源码本身**（行数 + 前 40 行），不是助手对它的描述；
 * —— 三个写操作都不等于生效：工具名在装配会话时才进白名单，
 *    kind=js 还多一道人造的待审闸门，所以每次都把「下一次对话才生效」如实带回。
 */
function authoringTools(caps: AssistantCaps): TorraTool[] {
  const nextStep = (verb: string) => caps.capabilityNote?.(verb) ?? `${verb}完成。下一次对话才会加载`

  return [
    defineTool({
      name: 'torra_list_plugins',
      label: '列出工具',
      description:
        '列出 Torra 自建工具目录里的条目：已生效的、被禁用的、以及清单或源码读不出来时附的原因。' +
        '写新工具前先看它，别和已有的撞名字；排查「为什么这个工具没生效」也靠它。',
      parameters: Type.Object({}),
      async execute() {
        const r = caps.listPlugins?.()
        if (!r) return { content: text('主进程没有提供插件目录'), details: { ok: false } }
        const lines = [`工具目录：${r.dir}`]
        lines.push(r.plugins.length ? `有效清单：${r.plugins.length} 条` : '有效清单：0 条')
        for (const p of r.plugins) {
          lines.push(`- ${p.name}（${p.kind}·${p.confirm}${p.enabled ? '' : '·已禁用'}）：${p.description}`)
        }
        for (const bad of r.invalid) {
          lines.push(`- ✗ ${bad.name}：${bad.errors.join('；')}`)
        }
        return {
          content: text(clip(lines.join('\n'))),
          details: { ok: true, count: r.plugins.length, invalid: r.invalid.length },
        }
      },
    }),

    defineTool({
      name: 'torra_author_tool',
      label: '新建工具（需确认）',
      description:
        '写一条工具清单（一个 *.plugin.json = 一个工具）。kind=http 用请求模板，kind=shell 用固定 argv + 参数槽；' +
        '清单确实表达不了逻辑时才用 kind=js，并把 JS 源码放在 code 参数里。' +
        'kind=js 的源码不会当场生效：先进待审区，用户在设置页读过源码点启用的下一次对话才加载。' +
        '写之前先用手头的工具把这件事真跑一遍，拿到确切的地址和参数。',
      parameters: Type.Object({
        manifest: Type.Object(
          {},
          {
            additionalProperties: true,
            description:
              '完整清单对象：name（小写字母数字连字符，同时是文件名）、label、description、kind(http|shell|js)、' +
              "parameters（{type:'object',properties:{...}}，只支持 string/number/integer/boolean/array/object）、" +
              'http（{method,url,headers?,body?}，占位符写 {{参数名}} 或 {{参数名|urlencode}} 或 {{secrets:plugin:条目}}）、' +
              "shell（{argv:[程序,参数...],cwd?('plugin'|'data')}，argv[0] 不能含占位符）、" +
              "confirm?('always'|'once'|'never'，shell 和 js 不许 never)、timeoutMs?、enabled?",
          },
        ),
        code: Type.Optional(
          Type.String({
            description:
              'kind=js 的源码（其它 kind 不要填）：CommonJS，module.exports = async function run(params, ctx) { … }；' +
              'ctx 提供 secrets(ref)、cwd、signal、tool。',
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        const m = params.manifest as Record<string, unknown>
        const name = typeof m.name === 'string' ? m.name : '(无名)'
        const isJs = m.kind === 'js'
        const code = typeof params.code === 'string' ? params.code : ''
        const lines = code.split(/\r?\n/)
        const shown = lines.slice(0, 40).join('\n')
        const decision = await caps.approve({
          action: isJs ? 'propose_extension' : 'author_tool',
          title: isJs ? `提交待审工具 ${name}` : `新建工具 ${name}`,
          detail: isJs
            ? [
                '清单：',
                clip(JSON.stringify(m, null, 1)),
                '',
                `源码 ${lines.length} 行，写入待审区后由用户在设置页审阅。前 40 行：`,
                '---',
                shown,
                ...(lines.length > 40 ? [`…（其余 ${lines.length - 40} 行在文件里）`] : []),
              ].join('\n')
            : clip(JSON.stringify(m, null, 1)),
          risk: isJs
            ? '这段脚本会跑在 Torra 主进程里，能读写本机文件。这一步只是把清单和源码放进待审区，不执行；' +
              '是否启用由用户在设置页读过源码决定，启用后每次调用还会弹一次确认。'
            : m.kind === 'shell'
              ? '这会在本机添加一个能启动外部程序的工具。要跑哪个程序由清单定死，模型只能填参数槽；此后每次运行还会再弹一次确认。'
              : '这会在本机添加一个能对外发请求的工具。此后每次运行（GET/HEAD 除外）还会再弹一次确认。',
        })
        if (!decision.approved) return denied(decision)
        const r = (await caps.authorTool?.(m, isJs ? code : undefined)) ?? {
          ok: false,
          reason: '主进程没有提供写入能力',
        }
        caps.log({ stage: 'assistant:author-tool', subject: name, ok: r.ok, detail: r.reason })
        return {
          content: text(
            r.ok
              ? isJs
                ? `${r.reason}。它现在还不会运行 —— 让用户去设置页「自建工具」的待审区读过源码后点启用，启用之后下一次对话才会加载。`
                : `${r.reason}。${nextStep('写入')}`
              : `写入失败：${r.reason}`,
          ),
          details: r,
        }
      },
    }),

    defineTool({
      name: 'torra_author_skill',
      label: '新建技能（需确认）',
      description:
        '把一套做法写成 SKILL.md 放进 Torra 技能目录（正文是 Markdown，不含可执行代码）。' +
        'description 决定下一次的你会不会用它，所以写清「什么时候该用」而不是「这是什么」。',
      parameters: Type.Object({
        name: Type.String({ description: '技能名；会被清洗成目录名' }),
        description: Type.String({ description: '一句话：什么情况下该用这条技能' }),
        body: Type.String({ description: 'SKILL.md 正文（Markdown，不含 frontmatter）' }),
      }),
      async execute(_id: string, params: any) {
        const decision = await caps.approve({
          action: 'author_skill',
          title: `新建技能 ${params.name}`,
          detail: `说明：${params.description}\n正文 ${params.body.length} 字符：\n---\n${clip(params.body)}`,
          risk: '技能不会执行代码，但它会在之后每次对话里影响助手的做法。装错方向的技能比没技能更糟。',
        })
        if (!decision.approved) return denied(decision)
        const r = (await caps.authorSkill?.(params)) ?? { ok: false, reason: '主进程没有提供写入能力' }
        caps.log({ stage: 'assistant:author-skill', subject: params.name, ok: r.ok, detail: r.reason })
        return {
          content: text(r.ok ? `${r.reason ?? '已写入'}。${nextStep('写入技能')}` : `写入失败：${r.reason ?? '未知原因'}`),
          details: r,
        }
      },
    }),

    defineTool({
      name: 'torra_remove_plugin',
      label: '删除工具（需确认）',
      description: '按名字删除一条自建工具。只删 Torra 工具目录里的那份清单（kind=js 连同同名源码），不动技能、不动模型。',
      parameters: Type.Object({
        name: Type.String({ description: '工具名（清单文件名去掉 .plugin.json）' }),
      }),
      async execute(_id: string, params: any) {
        const decision = await caps.approve({
          action: 'remove_plugin',
          title: `删除工具 ${params.name}`,
          detail: `将删除工具「${params.name}」的清单；如果是 kind=js，连同同名源码一起删。`,
          risk: '删掉后这个工具就没了；下一次对话重新装配时不再注册它。',
        })
        if (!decision.approved) return denied(decision)
        const r = (await caps.removePlugin?.(params.name)) ?? { ok: false, reason: '主进程没有提供删除能力' }
        caps.log({ stage: 'assistant:remove-plugin', subject: params.name, ok: r.ok, detail: r.reason })
        return {
          content: text(r.ok ? `${r.reason}。${nextStep('删除')}` : `删除失败：${r.reason}`),
          details: r,
        }
      },
    }),

  ]
}

/** 助手可用的工具名白名单——和上面定义必须同步，改一处就要改另一处 */
export const ASSISTANT_TOOL_NAMES = [
  'torra_list_models',
  'torra_run_doctor',
  'torra_read_log',
  'torra_page_facts',
  'torra_verify_selector',
  'torra_read_adapter',
  'torra_save_adapter',
  'torra_probe_api_model',
  'torra_create_api_model',
  'torra_scan_site',
  'torra_answer_site_questions',
  'torra_check_site_selectors',
  'torra_send_site_message',
  'torra_close_site_scan',
  'torra_create_web_model',
  'torra_test_web_model',
  'torra_delete_model',
  'torra_open_login',
  'torra_web_search',
  'torra_fetch_url',
  'torra_memory_remember',
  'torra_list_scheduled',
  'torra_schedule_task',
  'torra_remove_scheduled',
]
