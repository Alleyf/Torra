/**
 * 助手桥接层的离线回归（假 deps，不需要 Electron，也不需要加载 pi）
 *
 * bridge.ts 是唯一碰 Electron 运行时的助手模块，但它的全部风险都在编排逻辑里，
 * 而不在 Electron API 里：确认卡片会不会泄漏 Key、清单变化后 runtime 会不会重建、
 * 页面实例不存在时工具会不会崩。这些都能用假 deps 钉死。
 *
 * 真正需要 app 的只有「pi 会话能不能跑起来」，那部分由
 * scripts/test-assistant-e2e.ts（faux provider）覆盖。
 * 涉及磁盘历史/会话列表的两条会顺带装载 pi（读盘用的就是它的 SessionManager），
 * 其余用例都不会。
 *
 * 运行：npm run test:assistant-bridge
 */

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AdapterSpec } from '../src/shared/adapter'
import type { DiagEvent, DoctorReport } from '../src/shared/diagnostics'
import type { ChatAttachmentMeta, ModelConfig } from '../src/shared/types'
import type { WebPlan } from '../src/shared/smart-add'
import {
  APPROVAL_PREFS_DEFAULT,
  GOAL_CONTINUE_MARK,
  GOAL_DONE_MARK,
  GOAL_MAX_ROUNDS,
  AT_FILE_CHARS_MAX,
  defaultModeState,
  type AssistantApprovalPrefs,
  type AssistantApprovalRequest,
  type AssistantApprovalResolved,
  type AssistantModeState,
  type AssistantStreamEvent,
} from '../src/shared/assistant'
import type { AdapterRegistry } from '../src/main/adapters/registry'
import type { WebviewPool } from '../src/main/webview/pool'
import { assistantSessionDir, assistantSkillsDir } from '../src/main/assistant/session'
import {
  pendingDirOf,
  pluginsDirOf,
  writePendingExtension,
  writePluginManifest,
} from '../src/main/assistant/plugins'
import { createAssistantBridge, type AssistantBridgeDeps } from '../src/main/assistant/bridge'
import { createModeEngine, type TurnOutcome } from '../src/main/assistant/modes'
import { expandAt } from '../src/main/assistant/atrefs'
import { friendlyError } from '../src/main/assistant/errors'

const SECRET = 'sk-live-never-echoed'

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

const apiModel: ModelConfig = {
  id: 'api-user-glm',
  displayName: 'GLM',
  transport: 'api',
  api: {
    baseUrl: 'https://api.example.com/v1',
    model: 'glm-4.6',
    apiKeyRef: 'api-user-glm:key',
    protocol: 'openai',
    pricePerMTokIn: 1,
    pricePerMTokOut: 2,
    maxContextTokens: 128000,
  },
  color: '#7b8cff',
  supportsStructuredOutput: true,
  enabled: true,
}

const webModel: ModelConfig = {
  id: 'deepseek-web',
  displayName: 'DeepSeek 网页',
  transport: 'webview',
  adapterId: 'deepseek',
  partition: 'persist:deepseek',
  color: '#4d6bff',
  supportsStructuredOutput: false,
  enabled: true,
}

function report(): DoctorReport {
  return {
    startedAt: 1,
    finishedAt: 2,
    userData: 'x',
    scope: '全部启用模型',
    summary: { pass: 1, warn: 0, fail: 0, skip: 0 },
    checks: [],
  }
}

/** 识别链的方案样本：桥这层只搬运它，不做判断 */
function fakePlan(entry: string): WebPlan {
  return {
    planId: 'plan-bridge',
    entry,
    name: '样本站点',
    selectors: { input: 'textarea', send: '', stop: '', stream: 'div.msg', generating: '' },
    input_kind: 'textarea',
    send_mode: 'click',
    stream_mode: 'last',
    completion_mode: 'dom_stable',
    stable_ms: 3000,
    confidence: {},
    why: {},
    risks: [],
    questions: [],
    checks: {},
    source: 'heuristic',
    assistant: null,
    login: { state: 'unknown', reason: '假方案' },
    rounds: 1,
  }
}

interface Harness {
  deps: AssistantBridgeDeps
  bridge: ReturnType<typeof createAssistantBridge>
  pushes: Array<{ channel: string; payload: unknown }>
  handlers: Map<string, (args: any) => any>
  calls: Record<string, unknown[]>
  setModels(list: ModelConfig[]): void
  /**
   * 排入「用户接下来会选中的目录」。
   * 目录选择框是 Electron 的活，桥只认它的返回值，所以这里用队列代替：
   * 每 grantDir() 一次消费一个，用完就返回「取消」。
   */
  pick(...dirs: string[]): void
  /** 本次 harness 的数据目录：磁盘历史相关的用例要往里写会话文件 */
  dir: string
}

/**
 * 假主进程。
 *
 * pool/registry 只实现桥接层真正用到的方法，其余用 `as` 蒙过去 ——
 * 这里要验的是编排是否正确，不是 Electron 是否能跑。
 */
function harness(over: Partial<AssistantBridgeDeps> = {}): Harness {
  let modelList: ModelConfig[] = [apiModel, webModel]
  // 一次 harness 一个固定目录：磁盘上的会话文件要能被同一个用例写到、读到
  const dir = mkdtempSync(path.join(os.tmpdir(), 'torra-bridge-'))
  const pushes: Array<{ channel: string; payload: unknown }> = []
  const handlers = new Map<string, (args: any) => any>()
  const calls: Record<string, unknown[]> = {
    doctor: [],
    log: [],
    saveAdapter: [],
    createApi: [],
    createWeb: [],
    scan: [],
    delete: [],
    present: [],
    remote: [],
    extensions: [],
    /** 「记住工作目录」的落盘动作：真实主进程写 preferences.json，这里只记调用 */
    workDir: [],
  }
  let extensions = false
  let selfAuthoring = false
  let approval: AssistantApprovalPrefs = { ...APPROVAL_PREFS_DEFAULT }
  /** 假的「上一场挑过的目录」：真实主进程把它存 preferences，这里存变量 */
  let lastWorkDir: string | undefined
  /** 假的目录选择框：用例把「用户会点哪个目录」排进来，grantDir 逐条消费 */
  const pickQueue: string[] = []
  const spec: AdapterSpec = {
    id: 'deepseek',
    name: 'DeepSeek',
    transport: 'webview',
    entry: 'https://chat.deepseek.com/',
    selectors: { input: 'textarea', stream: 'div.message' },
    send_mode: 'enter',
    stream_mode: 'last',
    completion: { mode: 'dom_stable', timeout_s: 200 },
    automation: { typing_delay_ms: [80, 220], pre_send_pause_ms: [500, 1500], max_wait_s: 180, jitter: true },
    health_probe: 'textarea',
    origin: 'builtin',
  }
  const deps: AssistantBridgeDeps = {
    dataDir: () => dir,
    models: () => modelList,
    // 桥不 import dialog：弹不弹目录选择框是主进程的事，这里只验它对返回值的处置
    pickDirectory: async () => {
      const next = pickQueue.shift()
      return next ? { ok: true, path: next } : { ok: false, reason: '已取消，工作目录没变' }
    },
    lastWorkDir: () => lastWorkDir,
    setLastWorkDir: async (value) => {
      lastWorkDir = value
      calls.workDir.push(value)
    },
    secrets: {
      get: (ref) => (ref === 'api-user-glm:key' ? SECRET : null),
      has: (ref) => ref === 'api-user-glm:key',
    },
    registry: () => ({
      get: (id: string) => (id === 'deepseek' ? { spec, health: 'ok', lastCheckedAt: 0 } : undefined),
      isStale: () => false,
      getYaml: () => 'id: deepseek\n',
      saveUser: async (s: AdapterSpec) => {
        calls.saveAdapter.push(s)
        return { ok: true }
      },
    }) as unknown as AdapterRegistry,
    pool: () => ({
      get: () => undefined,
      has: () => false,
      ensure: () => undefined,
      inspectLogin: async () => ({ state: 'unknown', reason: '实例未初始化，无法判定登录态', url: '', tokenKeys: [] }),
    }) as unknown as WebviewPool,
    runDoctor: async (opts) => {
      calls.doctor.push(opts)
      return report()
    },
    readLog: (limit, filter) => {
      calls.log.push({ limit, filter })
      return [{ ts: 1, layer: 'selector', stage: 'x' }] as DiagEvent[]
    },
    createApiModel: async (input) => {
      calls.createApi.push(input)
      return { ok: true, id: 'api-user-new' }
    },
    createWebModel: async (input) => {
      calls.createWeb.push(input)
      return { ok: true, id: 'web-new' }
    },
    // 假的是「开页面、猜选择器、页面回测」这段真实链路（它由 test-smart-add 覆盖）；
    // 这里要钉住的只有桥这一层的搬运活：planId、整套选择器、关闭动作有没有原样送到 deps。
    siteScan: {
      planWeb: async (input) => {
        calls.scan.push(input)
        return { ok: true, plan: fakePlan(input.entry) }
      },
      refineWeb: async (planId, answers) => {
        calls.scan.push({ planId, answers })
        return { ok: true, plan: fakePlan('') }
      },
      verifyWeb: async (planId, selectors) => {
        calls.scan.push({ planId, selectors })
        return { ok: true, plan: fakePlan('') }
      },
      driveWeb: async (planId, input) => {
        calls.scan.push({ planId, drive: input.text })
        return { ok: true, plan: fakePlan('') }
      },
      closeScanWindow: () => {
        calls.scan.push('close')
      },
    },
    deleteModel: async (id) => {
      calls.delete.push(id)
      return { ok: true }
    },
    presentModel: async (id) => {
      calls.present.push(id)
      return { ok: true }
    },
    listRemoteModels: async (baseUrl, apiKey) => {
      calls.remote.push({ baseUrl, apiKey })
      return { ok: true, models: [{ id: 'glm-4.6' }, { id: 'glm-4.7' }] }
    },
    send: (channel, payload) => {
      pushes.push({ channel, payload })
    },
    handle: (channel, fn) => {
      handlers.set(channel, fn)
    },
    log: () => undefined,
    extensionsEnabled: () => extensions,
    setExtensionsEnabled: async (on) => {
      extensions = on
      calls.extensions.push(on)
    },
    selfAuthoringEnabled: () => selfAuthoring,
    setSelfAuthoringEnabled: async (on) => {
      selfAuthoring = on
    },
    approvalPrefs: () => approval,
    setApprovalPrefs: async (p) => {
      approval = p
    },
    approvalTtlMs: 30,
    ...over,
  }
  const bridge = createAssistantBridge(deps)
  bridge.registerIpc()
  return {
    deps,
    bridge,
    pushes,
    handlers,
    calls,
    dir,
    setModels: (l) => (modelList = l),
    pick: (...dirs) => pickQueue.push(...dirs),
  }
}

/** 造一个真实存在的项目目录：授权读取的校验要用 statSync，假路径过不了闸门 */
function fakeProjectDir(parent: string, name = 'project'): string {
  const d = path.join(parent, name)
  mkdirSync(d, { recursive: true })
  return d
}

function lastPush(h: Harness, channel: string): unknown {
  const found = [...h.pushes].reverse().find((p) => p.channel === channel)
  return found?.payload
}

/**
 * 只含两个 Claude Code 技能的最小 home。
 * 技能管理用例要的是「桥把路径和提示语接对了」，不需要真的把那台机器扫一遍。
 */
function fakeSkillHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'torra-skill-home-'))
  for (const name of ['demo-a', 'demo-b']) {
    const dir = path.join(home, '.claude', 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'SKILL.md'), `---\ndescription: 演示技能 ${name}\n---\n# ${name}\n`, 'utf8')
  }
  return home
}

/** 一条足够真的文件附件：模式层只数它跟着哪一轮，不碰内容 */
const fileAtt = (name: string): ChatAttachmentMeta => ({ id: name, kind: 'file', name, mime: 'text/plain', size: 3 })

/**
 * 假的一轮对话。
 *
 * 自动推进的纪律（跑几轮、什么时候停、附件跟哪一轮）只能靠替身来钉：真会话要 pi、
 * 要模型、要钱。这里把送进模型的 prompt、随轮的附件、推出去的状态快照、
 * 进对话流的提示全部收集起来，用例就能同时断言「它做了什么」和「它说了什么」。
 */
function engineHarness(
  script: Array<{ text?: string; ok?: boolean; reason?: string }>,
  onRound: Record<number, () => void> = {},
) {
  const prompts: string[] = []
  const atts: Array<ChatAttachmentMeta[] | undefined> = []
  /** 每一轮拿到的 @ 引用内容：只该出现在人说的那第一轮 */
  const refs: Array<string | undefined> = []
  const notes: string[] = []
  const states: AssistantModeState[] = []
  let round = 0
  let aborts = 0
  const engine = createModeEngine({
    runTurn: async (prompt, opts): Promise<TurnOutcome> => {
      round++
      prompts.push(prompt)
      atts.push(opts.attachments)
      refs.push(opts.refs)
      onRound[round]?.()
      const step = script[round - 1]
      if (!step) throw new Error(`用例脚本里没有第 ${round} 轮`)
      return { ok: step.ok !== false, ...(step.reason ? { reason: step.reason } : {}), text: step.text ?? '' }
    },
    onState: (s) => states.push(s),
    onNote: (t) => notes.push(t),
    abortTurn: () => {
      aborts++
    },
  })
  return {
    engine,
    prompts,
    atts,
    refs,
    notes,
    states,
    aborted: () => aborts,
    last: () => states[states.length - 1],
  }
}

async function main(): void {
  console.log('\n助手桥接层回归（假 deps）\n' + '='.repeat(44))

  await it('注册渲染层需要的全部 IPC 通道', () => {
    const h = harness()
    // 按 registerIpc 的书写顺序列，比较时两边都排序：这里要的是「有没有少一条」，不是顺序
    assert.deepEqual(
      [...h.handlers.keys()].sort(),
      [
        'assistant:status',
        'assistant:models',
        'assistant:set-model',
        'assistant:send',
        'assistant:steer',
        'assistant:abort',
        'assistant:history',
        'assistant:stats',
        'assistant:sessions',
        'assistant:open-session',
        'assistant:delete-session',
        'assistant:capabilities',
        'assistant:set-extensions',
        'assistant:set-self-authoring',
        'assistant:skills-scan',
        'assistant:skills-import',
        'assistant:skills-remove',
        'assistant:plugins',
        'assistant:plugins-remove',
        'assistant:pending',
        'assistant:pending-enable',
        'assistant:pending-drop',
        'assistant:reset',
        'assistant:approval:respond',
        'assistant:approval-prefs',
        'assistant:set-approval-prefs',
        'assistant:overlay',
        'assistant:set-mode',
        'assistant:stop-mode',
        'assistant:execute-plan',
        'assistant:set-workdir',
        'assistant:at-list',
        'assistant:revoke-dir',
      ].sort(),
    )
  })

  await it('模型清单只报「有没有 Key」，绝不带出 Key 值', () => {
    const h = harness()
    const list = h.bridge.listModels()
    assert.equal(list.length, 2)
    assert.equal(list.find((m) => m.id === 'api-user-glm')?.hasKey, true)
    assert.equal(list.find((m) => m.id === 'deepseek-web')?.hasKey, true)
    assert.equal(JSON.stringify(list).includes(SECRET), false)
  })

  await it('体检/日志走注入的依赖，日志条数有硬上限', async () => {
    const h = harness()
    await h.bridge.caps.runDoctor({ modelId: 'deepseek-web', probeApi: true })
    assert.deepEqual(h.calls.doctor, [{ modelId: 'deepseek-web', probeApi: true }])
    h.bridge.caps.readLog({ limit: 9999, layer: 'selector', subject: 'deepseek-web' })
    assert.deepEqual(h.calls.log[0], { limit: 200, filter: { layer: 'selector', subject: 'deepseek-web' } })
  })

  await it('页面事实/选择器校验：拿不到页面时给原因，不抛错', async () => {
    const h = harness()
    const api = await h.bridge.caps.pageFacts('api-user-glm')
    assert.equal(api.ok, false)
    assert.match(api.reason ?? '', /API 通道/)
    const missing = await h.bridge.caps.pageFacts('nope')
    assert.match(missing.reason ?? '', /不存在/)
    const sel = await h.bridge.caps.verifySelector('deepseek-web', 'div.message')
    assert.equal(sel.ok, false)
    assert.match(sel.reason ?? '', /页面实例/)
  })

  await it('适配器读取：origin 缺省按内置，yaml 与 stale 一并回', () => {
    const h = harness()
    const v = h.bridge.caps.readAdapter('deepseek')
    assert.equal(v?.origin, 'builtin')
    assert.equal(v?.entry, 'https://chat.deepseek.com/')
    assert.equal(v?.yaml, 'id: deepseek\n')
    assert.equal(h.bridge.caps.readAdapter('nope'), undefined)
  })

  await it('API 探测用现场取出的 Key，结果里不含 Key', async () => {
    const h = harness()
    const r = await h.bridge.caps.probeApiModel('api-user-glm')
    assert.equal(r.ok, true)
    assert.equal(r.modelCount, 2)
    assert.equal(JSON.stringify(r).includes(SECRET), false)
    assert.equal((h.calls.remote[0] as { apiKey: string }).apiKey, SECRET)
    const web = await h.bridge.caps.probeApiModel('deepseek-web')
    assert.match(web.reason ?? '', /不是 API 通道/)
  })

  // 助手能不能「从一个纯网址凭空建出第一个网页模型」全看这四条 caps 有没有接上识别链。
  // 这里盯住两件容易写错的事：planId 要原样传下去，扫描窗口必须有关闭路径。
  await it('识别链：纯 URL 起步、planId 续接、窗口有关闭', async () => {
    const h = harness()
    const scanned = await h.bridge.caps.scanSite({ entry: 'https://yuanbao.demo/' })
    assert.equal(scanned.ok, true)
    assert.deepEqual(h.calls.scan[0], { entry: 'https://yuanbao.demo/', assistantModelId: undefined })

    const planId = scanned.plan!.planId
    await h.bridge.caps.answerSiteQuestions(planId, { q_kind: 'contenteditable' })
    assert.deepEqual(h.calls.scan[1], { planId, answers: { q_kind: 'contenteditable' } })

    await h.bridge.caps.checkSiteSelectors(planId, { input: 'textarea', stream: 'div.msg' })
    const verify = h.calls.scan[2] as { planId: string; selectors: Record<string, string> }
    assert.equal(verify.planId, planId)
    // 未提交的角色补空串：verifyWeb 要的是整套选择器，缺字段会在类型层就漏过去
    assert.deepEqual(verify.selectors, { input: 'textarea', send: '', stop: '', stream: 'div.msg', generating: '' })

    // 代发消息是识别链里唯一会写页面的一步：桥只负责把文本原样送到 driveWeb
    await h.bridge.caps.driveSite(planId, '你好')
    assert.deepEqual(h.calls.scan[3], { planId, drive: '你好' })

    // 没建过模型时助手用的是自动挑选的配置助手，不是自己
    h.bridge.caps.closeSiteScan()
    assert.equal(h.calls.scan[4], 'close')
  })

  await it('确认卡片：投递带 id，用户点允许后原样回到工具侧', async () => {
    const h = harness()
    const p = h.bridge.caps.approve({ action: 'create_api_model', title: '新建模型', detail: 'd', needsKey: true })
    const card = lastPush(h, 'assistant:approval:request') as AssistantApprovalRequest
    assert.ok(card.id, '卡片必须带 id')
    assert.equal(card.action, 'create_api_model')
    assert.equal(card.needsKey, true)
    assert.equal(JSON.stringify(card).includes(SECRET), false)
    const respond = h.handlers.get('assistant:approval:respond')!
    assert.deepEqual(respond({ id: card.id, decision: { approved: true, apiKey: SECRET } }), { ok: true })
    assert.equal((await p).apiKey, SECRET)
  })

  await it('确认卡片：未知 id 与重复点击都不会误放行', async () => {
    const h = harness()
    const respond = h.handlers.get('assistant:approval:respond')!
    assert.equal(respond({ id: 'nope', decision: { approved: true } }).ok, false)
    const p = h.bridge.caps.approve({ action: 'delete_model', title: 't', detail: 'd' })
    const card = lastPush(h, 'assistant:approval:request') as AssistantApprovalRequest
    assert.equal(respond({ id: card.id, decision: { approved: true } }).ok, true)
    assert.equal(respond({ id: card.id, decision: { approved: true } }).ok, false, '同一张卡片只能用一次')
    await p
  })

  await it('确认超时按拒绝处理：agent loop 不会等一个已经不存在的渲染层', async () => {
    const h = harness()
    const d = await h.bridge.caps.approve({ action: 'save_adapter', title: 't', detail: 'd' })
    assert.equal(d.approved, false)
    assert.match(d.reason ?? '', /超时/)
  })

  await it('只读模式：写操作不弹卡片就被拒绝，但对话流里必须看得见', async () => {
    const h = harness({ approvalPrefs: () => ({ mode: 'read_only', timeoutMs: 5000 }) })
    const d = await h.bridge.caps.approve({ action: 'delete_model', title: '删除模型', detail: 'd' })
    assert.equal(d.approved, false)
    assert.match(d.reason ?? '', /只读/)
    assert.equal(
      h.pushes.some((p) => p.channel === 'assistant:approval:request'),
      false,
      '只读模式不该弹出一张点了也没用的卡片',
    )
    const note = h.pushes
      .filter((p) => p.channel === 'assistant:stream')
      .map((p) => p.payload as AssistantStreamEvent)
      .find((e) => e.kind === 'status')
    assert.ok(note && note.kind === 'status' && /已拒绝/.test(note.text), '拒绝要在对话流里留一行，否则用户以为没执行过')
  })

  await it('免确认模式：直接批准并留可见回执；要 Key 的卡片仍然等人', async () => {
    const h = harness({ approvalPrefs: () => ({ mode: 'auto_all', timeoutMs: 5000 }) })
    const d = await h.bridge.caps.approve({ action: 'save_adapter', title: '写适配器', detail: 'd' })
    assert.equal(d.approved, true)
    assert.equal(
      h.pushes.some((p) => p.channel === 'assistant:approval:request'),
      false,
      '免确认不该弹卡片',
    )
    const note = h.pushes
      .filter((p) => p.channel === 'assistant:stream')
      .map((p) => p.payload as AssistantStreamEvent)
      .find((e) => e.kind === 'status')
    assert.ok(note && note.kind === 'status' && /自动执行/.test(note.text))

    // Key 只能由人给：这一条闸门任何自动模式都不放行
    const p2 = h.bridge.caps.approve({ action: 'create_api_model', title: '新建模型', detail: 'd', needsKey: true })
    const card = lastPush(h, 'assistant:approval:request') as AssistantApprovalRequest
    assert.ok(card, '要 Key 的卡片必须弹')
    assert.equal(card.autoApproveAt, undefined, '要 Key 的卡片不参与自动放行')
    h.handlers.get('assistant:approval:respond')!({ id: card.id, decision: { approved: true, apiKey: SECRET } })
    assert.equal((await p2).apiKey, SECRET)
  })

  await it('超时自动批准：卡片带截止时间，到点放行并广播结算', async () => {
    const h = harness({ approvalPrefs: () => ({ mode: 'auto_after_timeout', timeoutMs: 5000 }) })
    const p = h.bridge.caps.approve({ action: 'delete_model', title: '删除模型', detail: 'd' })
    const card = lastPush(h, 'assistant:approval:request') as AssistantApprovalRequest
    assert.ok(card.autoApproveAt !== undefined, '自动模式必须给界面一个截止时间')
    assert.ok(card.autoApproveAt <= Date.now() + 1000, '截止时间按注入的时限算，不是偏好里的原始值')
    const d = await p
    assert.equal(d.approved, true, '到点自动批准')
    const resolved = lastPush(h, 'assistant:approval:resolved') as AssistantApprovalResolved
    assert.equal(resolved.id, card.id)
    assert.equal(resolved.approved, true)
    assert.equal(resolved.auto, true, '界面要靠这个区分「到点放行」和「用户点的」')
  })

  await it('超时自动批准：倒计时期间人的点击优先，且只结算一次', async () => {
    const h = harness({ approvalPrefs: () => ({ mode: 'auto_after_timeout', timeoutMs: 5000 }) })
    const p = h.bridge.caps.approve({ action: 'save_adapter', title: '写适配器', detail: 'd' })
    const card = lastPush(h, 'assistant:approval:request') as AssistantApprovalRequest
    h.handlers.get('assistant:approval:respond')!({ id: card.id, decision: { approved: false, reason: '我自己来' } })
    const d = await p
    assert.equal(d.approved, false)
    await new Promise((res) => setTimeout(res, 80))
    const resolved = h.pushes.filter((x) => x.channel === 'assistant:approval:resolved')
    assert.equal(resolved.length, 1, '人点过了就不该再有第二次结算')
    assert.equal((resolved[0] as { payload: AssistantApprovalResolved }).payload.auto, false)
  })

  await it('审批偏好 IPC：非法值夹回可用范围', async () => {
    const h = harness()
    const get = () => (h.handlers.get('assistant:approval-prefs')!({}) as AssistantApprovalPrefs)
    assert.equal(get().mode, 'always_ask')
    assert.equal(get().timeoutMs, APPROVAL_PREFS_DEFAULT.timeoutMs)

    await h.handlers.get('assistant:set-approval-prefs')!({ mode: 'auto_after_timeout', timeoutMs: 99_999_999 })
    assert.equal(get().timeoutMs, 120_000, '秒数夹进上限，不能拿任意数字当定时器')

    await h.handlers.get('assistant:set-approval-prefs')!({ mode: 'whatever', timeoutMs: 'abc' })
    assert.equal(get().mode, 'always_ask', '不认识的 mode 退回默认')
    assert.equal(get().timeoutMs, APPROVAL_PREFS_DEFAULT.timeoutMs)
  })

  await it('审批模式一变，挂着的确认按拒绝作废并通知界面收卡片', async () => {
    const h = harness()
    const p = h.bridge.caps.approve({ action: 'delete_model', title: '删除模型', detail: 'd' })
    const card = lastPush(h, 'assistant:approval:request') as AssistantApprovalRequest
    const r = await h.handlers.get('assistant:set-approval-prefs')!({ mode: 'read_only', timeoutMs: 10_000 })
    assert.match(r.reason ?? '', /作废/)
    const d = await p
    assert.equal(d.approved, false)
    assert.match(d.reason ?? '', /模式/)
    const resolved = lastPush(h, 'assistant:approval:resolved') as AssistantApprovalResolved
    assert.equal(resolved.id, card.id)
    assert.equal(resolved.approved, false)
  })

  await it('拒绝时不执行任何写操作', async () => {
    const h = harness()
    const p = h.bridge.caps.approve({ action: 'delete_model', title: 't', detail: 'd' })
    h.handlers.get('assistant:approval:respond')!({ id: (lastPush(h, 'assistant:approval:request') as any).id, decision: { approved: false, reason: '先留着' } })
    const d = await p
    assert.equal(d.approved, false)
    assert.equal(d.reason, '先留着')
    assert.equal(h.calls.delete.length, 0)
  })

  await it('没有可用 API 模型时，发消息以返回值给出可执行原因', async () => {
    const h = harness()
    h.setModels([webModel])
    const r = await h.bridge.send('帮我看看 deepseek 的选择器')
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /设置页新建/)
    // 不推流：渲染层拿到 invoke 的失败返回值就够，再推一条同样的原因是重复信息
    assert.equal(h.pushes.length, 0)
  })

  await it('空消息/超长消息在入口就挡掉，不烧一轮模型调用', async () => {
    const h = harness()
    assert.equal((await h.bridge.send('   ')).ok, false)
    assert.equal((await h.bridge.send('x'.repeat(8001))).ok, false)
    assert.equal(h.pushes.length, 0)
  })

  await it('助手模型只能选可用的 API 模型，缺 Key 就拒绝', async () => {
    const h = harness()
    assert.match((await h.bridge.setModel('deepseek-web')).reason ?? '', /API 模型/)
    h.setModels([apiModel, { ...webModel, id: 'api-user-nokey', transport: 'api', adapterId: undefined, api: { ...apiModel.api!, apiKeyRef: 'api-user-nokey:key' } }])
    assert.match((await h.bridge.setModel('api-user-nokey')).reason ?? '', /API Key/)
    assert.equal((await h.bridge.setModel('api-user-glm')).ok, true)
  })

  await it('会话未建立时 abort/reset/history 给出状态而不是崩', async () => {
    const h = harness()
    assert.equal((await h.bridge.abort()).ok, false)
    assert.equal((await h.bridge.history()).length, 0)
    assert.equal((await h.bridge.stats()), null, '还没对话过就没有账')
    assert.equal((await h.bridge.sessions()).length, 0)
    assert.equal(h.bridge.status().ready, false)
    assert.equal(h.bridge.capabilities().note, '助手尚未开始对话')
  })

  await it('重启后没有会话也能回看上次对话：读盘上最近那一场', async () => {
    const h = harness()
    const root = assistantSessionDir(h.dir)
    mkdirSync(root, { recursive: true })
    const t0 = Date.parse('2026-01-02T03:04:05.000Z')
    const entries = [
      { type: 'session', version: 3, id: 'sess-1', timestamp: new Date(t0).toISOString(), cwd: h.dir },
      { id: 'e1', type: 'message', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: '上次聊了什么', timestamp: t0 } },
      {
        id: 'e2',
        parentId: 'e1',
        type: 'message',
        timestamp: new Date(t0 + 900).toISOString(),
        message: {
          role: 'assistant',
          timestamp: t0 + 900,
          responseModel: 'glm-4.6',
          usage: { input: 1200, output: 180, cost: { total: 0.0021 } },
          content: [{ type: 'thinking', thinking: '想想' }, { type: 'text', text: '聊了选择器' }],
        },
      },
    ]
    writeFileSync(path.join(root, '2026-01-02T03-04-05-000Z_sess-1.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')

    const history = await h.bridge.history()
    assert.deepEqual(history.map((x) => x.role), ['user', 'thinking', 'assistant'])
    const stats = history[2]?.stats
    assert.equal(stats?.totalTokens, 1380)
    assert.equal(stats?.ttftMs, undefined, '磁盘上没有逐字时刻，首字延迟不许编')
    assert.equal((await h.bridge.sessions())[0]?.id, 'sess-1')
    assert.equal(JSON.stringify(history).includes(SECRET), false)
  })

  await it('技能/扩展开关：落盘、拆会话、下一次对话才生效', async () => {
    const h = harness()
    assert.equal(h.bridge.capabilities().extensionsEnabled, false)
    assert.equal((await h.bridge.setExtensions(true)).ok, true)
    assert.deepEqual(h.calls.extensions, [true], '开关要交给主进程落盘')
    const caps = h.bridge.capabilities()
    assert.equal(caps.extensionsEnabled, true)
    assert.equal(caps.note, '下一次对话时才会加载', '清单要等下一次组装才有，不能假装已经加载')
    assert.equal(h.bridge.status().ready, false)
    // 关掉再打开不该重复落盘
    await h.bridge.setExtensions(true)
    assert.equal(h.calls.extensions.length, 1)
  })

  await it('第一轮对话之前：目录、插件清单、待审扩展都要看得见并能处置', async () => {
    const h = harness()
    // 目录是「手动把清单放哪儿」的唯一入口，不能等到装配过会话才报
    const caps = h.bridge.capabilities()
    assert.equal(caps.dirs?.plugins, path.join(h.dir, 'pi', 'plugins'))
    assert.equal(caps.dirs?.extensions, path.join(h.dir, 'pi', 'extensions'))
    assert.equal(caps.selfAuthoringEnabled, false)

    const dir = pluginsDirOf(h.dir)
    assert.deepEqual(h.bridge.plugins().plugins, [], '盘上没清单时是空列表，不是 undefined')
    writePluginManifest(dir, {
      name: 'p1',
      description: '桥层用例用的清单',
      kind: 'http',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      http: { url: 'https://example.com/?q={{q}}', method: 'GET' },
    })
    assert.equal(h.bridge.plugins().plugins[0]?.name, 'p1', '不发消息也要列得出来')

    writePendingExtension(pendingDirOf(h.dir), { name: 'e1', code: 'export default (pi) => {\n  pi.registerTool({ name: "x" })\n}\n' })
    const views = h.bridge.pendingExtensions()
    assert.equal(views[0]?.name, 'e1')
    assert.match(views[0]?.preview ?? '', /pi\.registerTool/, '预览必须是源码本身，不是描述')
    const enabled = await h.bridge.enablePendingExtension('e1')
    assert.equal(enabled.ok, true, enabled.reason)
    assert.ok(existsSync(path.join(h.dir, 'pi', 'extensions', 'e1.js')), '启用就是把文件搬进扩展目录')
    assert.equal(h.bridge.pendingExtensions().length, 0)
    assert.equal((await h.bridge.enablePendingExtension('e1')).ok, false, '搬走了就不该再启用第二次')

    assert.equal((await h.bridge.removePlugin('nope')).ok, false)
    assert.equal((await h.bridge.removePlugin('p1')).ok, true)
    assert.equal(h.bridge.plugins().plugins.length, 0)
  })

  await it('删除会话：越界与正在用的那场都挡在桥这一层', async () => {
    const h = harness()
    const root = assistantSessionDir(h.dir)
    mkdirSync(root, { recursive: true })
    const outside = path.join(h.dir, 'secrets.jsonl')
    writeFileSync(outside, '{}\n', 'utf8')
    assert.equal((await h.bridge.deleteSession(outside)).ok, false)
    assert.equal(existsSync(outside), true, '拒绝就不能真删')
    const file = path.join(root, 'x.jsonl')
    writeFileSync(file, '{"type":"session","version":3,"id":"s","cwd":' + JSON.stringify(h.dir) + '}\n', 'utf8')
    assert.equal((await h.bridge.deleteSession(file)).ok, true)
    assert.equal(existsSync(file), false)
  })

  // ---- 技能管理：桥只负责路径、开关状态和「什么时候才生效」的说法 ----

  await it('技能扫描：导入目标钉在 Torra 自己的 pi/skills，并带回开关状态', async () => {
    const home = fakeSkillHome()
    const h = harness({ skillsHome: () => home })
    const v = await h.bridge.scanSkills()
    assert.equal(v.skillsDir, assistantSkillsDir(h.dir))
    assert.equal(v.extensionsEnabled, false, '界面要靠这个字段提醒「导入了也不会加载」')
    assert.ok(v.total >= 2)
    assert.equal(v.apps.find((a) => a.id === 'claude')?.skills.length, 2)
  })

  await it('导入落在 pi/skills 下；开关没开时把「还没生效」说清楚', async () => {
    const home = fakeSkillHome()
    const h = harness({ skillsHome: () => home })
    const v = await h.bridge.scanSkills()
    const claude = v.apps.find((a) => a.id === 'claude')!
    const key = claude.skills.find((s) => s.name === 'demo-a')!.key
    const r = await h.bridge.importSkill({ key })
    assert.equal(r.ok, true)
    assert.equal(r.name, 'demo-a')
    const link = path.join(assistantSkillsDir(h.dir), 'demo-a')
    assert.equal(lstatSync(link).isSymbolicLink(), true, '目录型技能必须是链接')
    assert.match(r.reason ?? '', /开关还关着/)
    assert.equal(existsSync(path.join(home, '.claude', 'skills', 'demo-a', 'SKILL.md')), true, '源文件不能被动')
  })

  await it('开关开着时导入：提示下一次对话重新加载，且清单退回「待加载」', async () => {
    const home = fakeSkillHome()
    const h = harness({ skillsHome: () => home })
    await h.bridge.setExtensions(true)
    const v = await h.bridge.scanSkills()
    const key = v.apps.find((a) => a.id === 'claude')!.skills.find((s) => s.name === 'demo-b')!.key
    const r = await h.bridge.importSkill({ key })
    assert.equal(r.ok, true)
    assert.match(r.reason ?? '', /下一次对话/)
    assert.equal(h.bridge.capabilities().note, '下一次对话时才会加载')
    const rm = await h.bridge.removeSkill('demo-b')
    assert.equal(rm.ok, true)
    assert.equal(existsSync(path.join(assistantSkillsDir(h.dir), 'demo-b')), false)
    assert.equal(existsSync(path.join(home, '.claude', 'skills', 'demo-b', 'SKILL.md')), true)
  })

  await it('移除没导入过的名字只给原因，不碰目录里的任何东西', async () => {
    const h = harness({ skillsHome: () => fakeSkillHome() })
    const r = await h.bridge.removeSkill('不存在的')
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /不在技能目录/)
  })

  // ---- / 功能浮层：数据面（模式 + 技能 + 开关）与它背后的闸门 ----

  await it('/ 浮层的数据：模式快照 + 盘上的技能 + 开关状态', async () => {
    const h = harness()
    const sd = path.join(assistantSkillsDir(h.dir), 'demo-a')
    mkdirSync(sd, { recursive: true })
    writeFileSync(path.join(sd, 'SKILL.md'), '---\ndescription: 浮层用例用的技能\n---\n# demo-a\n', 'utf8')
    const data = await h.bridge.overlay()
    assert.ok(data.skills.some((s) => s.name === 'demo-a'), '第一条消息之前就要列得出刚导入的技能，浮层不能是空的')
    assert.deepEqual(data.mode, defaultModeState())
    assert.equal(data.extensionsEnabled, false, '开关关着要如实报，界面靠它把技能行置灰')
    await h.bridge.setExtensions(true)
    assert.equal((await h.bridge.overlay()).extensionsEnabled, true)
  })

  await it('模式 IPC：非法值挡在入口，切模式要推进对话流', async () => {
    const h = harness()
    const set = (a: Record<string, unknown>) => h.handlers.get('assistant:set-mode')!(a)
    assert.equal(set({}).ok, false)
    assert.equal(set({ mode: 'yolo' }).ok, false)
    assert.equal(set({ mode: 'goal', goal: '把选择器修好' }).ok, true)
    assert.equal((await h.bridge.overlay()).mode.goal, '把选择器修好')
    // 状态是主进程一份、渲染层镜像：不同步出去界面就永远显示「普通对话」
    assert.ok(
      h.pushes.some(
        (p) => p.channel === 'assistant:stream' && (p.payload as AssistantStreamEvent).kind === 'mode',
      ),
    )
    assert.equal(set({ mode: 'plan' }).ok, true)
    assert.equal(set({ mode: 'chat' }).ok, true)
    const st = (await h.bridge.overlay()).mode
    assert.equal(st.mode, 'chat')
    assert.equal(st.goal, undefined, '切回普通对话要连目标一起清，留着下一条会莫名自续跑')
  })

  await it('计划模式的写闸门在确认卡片这一层，不在提示词里', async () => {
    const h = harness()
    h.handlers.get('assistant:set-mode')!({ mode: 'plan' })
    assert.equal((await h.bridge.overlay()).mode.planLocked, true)
    const d = await h.bridge.caps.approve({ action: 'save_adapter', title: '写适配器', detail: 'd' })
    assert.equal(d.approved, false)
    assert.match(d.reason ?? '', /计划模式/)
    assert.equal(
      h.pushes.some((p) => p.channel === 'assistant:approval:request'),
      false,
      '锁着的时候弹一张只能点「拒绝」的卡片是骗人',
    )
    // 认新站的建模型动作同样被锁：计划模式唯一的产出是那份计划文本
    assert.equal((await h.bridge.caps.approve({ action: 'create_web_model', title: '建模型', detail: 'd' })).approved, false)
  })

  await it('目标模式：完成标记停轮，没写标记也停 —— 认不出就不猜', async () => {
    const done = engineHarness([
      { text: `第一步做完了\n${GOAL_CONTINUE_MARK}` },
      { text: `都改好了\n${GOAL_DONE_MARK}` },
    ])
    done.engine.setMode({ mode: 'goal', goal: '把 deepseek 的选择器修好' })
    assert.equal((await done.engine.submit('开始')).ok, true)
    assert.equal(done.prompts.length, 2, '标了完成就不该再跑第三轮')
    assert.match(done.prompts[0], /总目标：把 deepseek 的选择器修好/)
    assert.match(done.prompts[0], /我的原话/, '第一轮带着人说的那句')
    assert.match(done.prompts[1], /接着上一轮/, '续跑轮没有原话，靠指令自己接上下文')
    assert.equal(done.last()?.running, false)
    assert.match(done.notes.join('\n'), /已完成/)

    const noMark = engineHarness([{ text: '我话说到一半' }])
    noMark.engine.setMode({ mode: 'goal', goal: 'x' })
    await noMark.engine.submit('x')
    assert.equal(noMark.prompts.length, 1, '猜「大概是完成了」要赌上剩下七轮')
    assert.match(noMark.notes.join('\n'), /没写自评标记/)
  })

  await it('目标模式：某一轮失败就整体停，上限是硬闸', async () => {
    const broke = engineHarness([{ text: GOAL_CONTINUE_MARK }, { ok: false, reason: 'API Key 无效或已过期' }])
    broke.engine.setMode({ mode: 'goal', goal: 'x' })
    const r = await broke.engine.submit('x')
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /第 2 轮失败/)
    assert.match(broke.notes.join('\n'), /自动推进在第 2 轮停下：API Key 无效或已过期/, '停因要当场进对话流，不能只躺在状态里')

    const capped = engineHarness(
      Array.from({ length: GOAL_MAX_ROUNDS }, () => ({ text: GOAL_CONTINUE_MARK })),
    )
    capped.engine.setMode({ mode: 'goal', goal: '永远做不完' })
    await capped.engine.submit('开工')
    assert.equal(capped.prompts.length, GOAL_MAX_ROUNDS, '一轮都不许多烧')
    assert.match(capped.notes.join('\n'), new RegExp(`上限（${GOAL_MAX_ROUNDS} 轮）`))
    assert.equal(capped.last()?.running, false)
  })

  await it('目标模式：附件只跟着人说的那第一轮；中途按停止就停在当前轮', async () => {
    const withAtt = engineHarness([{ text: GOAL_CONTINUE_MARK }, { text: GOAL_DONE_MARK }])
    withAtt.engine.setMode({ mode: 'goal', goal: '看这张图' })
    await withAtt.engine.submit('看这张图', [fileAtt('a.png')])
    assert.equal(withAtt.atts[0]?.length, 1)
    assert.deepEqual(withAtt.atts[1], [], '续跑轮重复附图就是重复付费')

    const stopped = engineHarness(
      [{ text: GOAL_CONTINUE_MARK }, { text: GOAL_DONE_MARK }],
      // 第一轮还在跑的时候人按了停止
      { 1: () => stopped.engine.stop() },
    )
    stopped.engine.setMode({ mode: 'goal', goal: 'x' })
    const r = await stopped.engine.submit('x')
    assert.equal(stopped.aborted(), 1, '按停止要真的去中止正在跑的那一轮')
    assert.equal(stopped.prompts.length, 1, '停了就不续跑')
    assert.equal(r.ok, true)
    assert.match(r.reason ?? '', /已停止自动推进/)
    // 循环已经停了，模式才允许再切
    assert.equal((await stopped.engine.setMode({ mode: 'plan' })).ok, true)
  })

  await it('目标只属于目标模式：切去计划模式要把它丢下', async () => {
    const h = engineHarness([{ text: GOAL_DONE_MARK }, { text: '计划：略' }])
    h.engine.setMode({ mode: 'goal', goal: '把 x 修好' })
    assert.equal(h.engine.state().goal, '把 x 修好')
    h.engine.setMode({ mode: 'plan', goal: '把 x 修好' } as { mode: 'plan'; goal: string })
    assert.equal(h.engine.state().goal, undefined, '带着旧目标进计划模式，再回目标模式时会顶掉人当下写的消息')
    h.engine.setMode({ mode: 'goal' })
    assert.equal(h.engine.state().goal, undefined, '没给新目标就是「下一条消息即目标」，不能捡回旧的')
    await h.engine.submit('其实是要修 y')
    assert.match(h.prompts[0], /总目标：其实是要修 y/)
  })

  await it('计划模式 → 执行：闸门只在人按下「执行计划」时放开，计划原文交回模型', async () => {    const h = engineHarness([{ text: '计划：1) 读 yaml 2) 改 stream 选择器' }, { text: '按计划做完了' }])
    assert.match(h.engine.setMode({ mode: 'plan' }).reason ?? '', /写操作会被拒绝/)
    await h.engine.submit('帮我接入豆包')
    assert.match(h.prompts[0], /不执行任何改动/)
    assert.equal(h.engine.state().planLocked, true, '计划成形不等于放行，必须等人确认')
    assert.match(h.engine.state().plan ?? '', /^计划：/)

    assert.equal((await h.engine.execute()).ok, true)
    assert.match(h.prompts[1], /已经过我的确认/)
    assert.match(h.prompts[1], /2\) 改 stream 选择器/, '执行轮拿到的是那份计划，不是重新描述一遍需求')
    assert.equal(h.engine.state().planLocked, false)
    assert.equal(h.engine.state().mode, 'chat')

    // 没出文字就没有执行项：闸门保持锁着，execute 只给原因
    const empty = engineHarness([{ text: '   ' }])
    empty.engine.setMode({ mode: 'plan' })
    await empty.engine.submit('要一份计划')
    assert.equal(empty.engine.state().plan, undefined)
    assert.equal(empty.engine.state().planLocked, true)
    assert.match((await empty.engine.execute()).reason ?? '', /还没有可执行的计划/)
  })

  // ---- 工作目录：一次点击就能把整块盘交出去，所以闸门必须在这里 ----

  await it('工作目录：取消、盘根、主目录、非目录全部挡下', async () => {
    const h = harness()
    assert.match((await h.bridge.setWorkDir()).reason ?? '', /取消|没有选择目录/, '选择框取消要有一句说法')

    const file = path.join(h.dir, 'a.txt')
    writeFileSync(file, 'x', 'utf8')
    const cases: Array<[string, RegExp]> = [
      // 相对路径要在跨盘时仍然相对：用 path.relative 算出来的会是绝对路径（cwd 在 A 盘、临时目录在 C 盘）
      [path.join('.', 'repo-a'), /绝对路径/],
      [path.join(h.dir, 'not-there'), /不存在/],
      [file, /不是目录/],
      [path.parse(path.resolve(h.dir)).root, /磁盘根目录/],
      [os.homedir(), /主目录/],
    ]
    for (const [dir, expect] of cases) {
      h.pick(dir)
      assert.match((await h.bridge.setWorkDir()).reason ?? '', expect, `${dir} 本该被挡下`)
    }
    assert.deepEqual((await h.bridge.overlay()).mode.readDirs, [], '被挡下的目录一条都不许进读取授权')
    const o = await h.bridge.overlay()
    assert.equal(o.workDir, o.defaultWorkDir, '挡下的目录不能当工作目录：@ 应留在助手目录里')
    assert.deepEqual(h.calls.workDir, [], '挡下的目录也不许被记住，否则下一场会给出一行点了就报错的「继续用」')
  })

  await it('工作目录：落地即并进读取授权，撤销它会把 @ 的起点一起收掉', async () => {
    const h = harness()
    const a = fakeProjectDir(h.dir, 'repo-a')
    const b = fakeProjectDir(h.dir, 'repo-b')
    const readDirs = async () => (await h.bridge.overlay()).mode.readDirs

    h.pick(a)
    assert.match((await h.bridge.setWorkDir()).reason ?? '', /@ 引用现在从/, '挑完要说清引用从哪儿开始找')
    assert.equal((await h.bridge.overlay()).workDir, a)
    assert.deepEqual(await readDirs(), [a], '工作目录要同时是能被 read 到的目录')
    assert.deepEqual(h.calls.workDir, [a], '挑过的项目目录要记住：下一场那行「继续用」靠它')

    // 同一个目录再挑一次：不占第二个授权名额
    h.pick(a)
    await h.bridge.setWorkDir()
    assert.deepEqual(await readDirs(), [a])

    h.pick(b)
    assert.equal((await h.bridge.setWorkDir()).ok, true)
    assert.deepEqual(await readDirs(), [a, b], '换过工作目录，旧的那个还在授权列表里（撤销项看得见）')

    assert.match((await h.bridge.revokeDir(path.join(h.dir, '别处的'))).reason ?? '', /不在这场会话的授权列表里/)
    assert.equal((await h.bridge.revokeDir(b)).ok, true)
    assert.equal((await readDirs()).includes(b), false)
    // 撤销的正是当前工作目录：@ 的起点要一起收，否则界面还在往里挑、助手已经读不到
    const back = await h.bridge.overlay()
    assert.equal(back.workDir, back.defaultWorkDir, '收掉项目目录后 @ 回到助手目录，而不是没有起点')
    assert.match((await h.bridge.revokeDir(a)).reason ?? '', /工作目录/, '收掉工作目录时得告诉人是连带收的')

    // 授权变化必须推进流：界面徽标和浮层里的「撤销」项都靠这份镜像
    const modeEvents = h.pushes
      .filter((p) => p.channel === 'assistant:stream')
      .map((p) => p.payload as AssistantStreamEvent)
      .filter((e): e is Extract<AssistantStreamEvent, { kind: 'mode' }> => e.kind === 'mode')
    assert.ok(modeEvents.some((e) => e.state.readDirs.length === 2), '落地后的快照要推出去')
    assert.ok(modeEvents.some((e) => e.state.readDirs.length === 1), '撤销后的快照也要推出去')
  })

  await it('工作目录满了：@ 还能引用，但要说清助手自己 read 不到', async () => {
    const h = harness()
    const dirs = [0, 1, 2, 3, 4].map((i) => fakeProjectDir(h.dir, `repo-${i}`))
    h.pick(...dirs.slice(0, 4))
    for (let i = 0; i < 4; i++) assert.equal((await h.bridge.setWorkDir()).ok, true)
    assert.equal((await h.bridge.overlay()).mode.readDirs.length, 4, 'MAX_READ_DIRS 之内的名额都要落得下')
    h.pick(dirs[4] as string)
    const r = await h.bridge.setWorkDir()
    assert.equal(r.ok, true, '满了不该拦人挑工作目录：引用本身是自己读盘展开的')
    assert.match(r.reason ?? '', /@ 引用现在从/)
    assert.equal((await h.bridge.overlay()).workDir, dirs[4])
    assert.equal((await h.bridge.overlay()).mode.readDirs.length, 4, '挤不进去的目录不能占位')
    assert.match((await h.bridge.overlay()).mode.note ?? '', /读取授权已满/)
  })

  // ---- @ 引用：候选列举 ----

  await it('@ 候选：默认根下也能列，且 keys/ 这类凭据目录既列不出也引用不了', async () => {
    const h = harness({ models: () => [webModel] })
    mkdirSync(path.join(h.dir, 'keys'), { recursive: true })
    writeFileSync(path.join(h.dir, 'keys', 'api-user-glm_key.bin'), '密文', 'utf8')
    writeFileSync(path.join(h.dir, 'models.json'), '{}', 'utf8')

    const top = h.bridge.atList('')
    assert.equal(top.ok, true, '没挑过项目目录也要列得出来：默认根是助手自己的目录')
    const paths = top.entries.map((e) => e.path)
    assert.ok(paths.includes('models.json'), `助手目录里的东西要能引用：${JSON.stringify(paths)}`)
    assert.ok(!paths.some((p) => p.startsWith('keys')), 'keys/ 不该出现在候选里')
    assert.match(h.bridge.atList('keys/api').reason ?? '', /不在 @ 可引用的范围/, '绕过界面直接打 keys/ 也要挡下')

    const sent = await h.bridge.send('看 @keys/api-user-glm_key.bin')
    assert.equal(sent.ok, false, '这一场没有可用的 API 模型，发送本来就该失败')
    const statuses = h.pushes
      .filter((p) => p.channel === 'assistant:stream')
      .map((p) => p.payload as AssistantStreamEvent)
      .filter((e): e is Extract<AssistantStreamEvent, { kind: 'status' }> => e.kind === 'status')
      .map((e) => e.text)
    assert.ok(statuses.some((t) => /不对外引用/.test(t)), `凭据目录必须被挡在展开之外：${JSON.stringify(statuses)}`)
  })

  await it('@ 候选：目录在前、按前缀过滤、越界一律不列', async () => {
    const h = harness()
    const root = fakeProjectDir(h.dir, 'proj')
    mkdirSync(path.join(root, 'src', 'main'), { recursive: true })
    mkdirSync(path.join(root, 'docs'), { recursive: true })
    writeFileSync(path.join(root, 'src', 'bridge.ts'), 'x', 'utf8')
    writeFileSync(path.join(root, 'src', 'main', 'modes.ts'), 'x', 'utf8')
    writeFileSync(path.join(root, 'readme.md'), 'x', 'utf8')
    h.pick(root)
    await h.bridge.setWorkDir()

    const top = h.bridge.atList('')
    assert.deepEqual(top.entries.map((e) => e.path), ['docs/', 'src/', 'readme.md'], '目录排在文件前面，其余按名字排')
    assert.equal(top.entries[1]?.dir, true)
    assert.equal(top.ok && h.bridge.atList('rea').entries.map((e) => e.path).join(), 'readme.md', '前缀过滤只认这一段')
    assert.deepEqual(h.bridge.atList('src/').entries.map((e) => e.path), ['src/main/', 'src/bridge.ts'])
    assert.equal(h.bridge.atList('src/ma').entries.length, 1)
    assert.equal(h.bridge.atList('nope').entries.length, 0, '对不上就是空，不要退回去列整个目录')

    // 越界：候选不能变成一次目录遍历
    for (const q of ['../', 'src/../../etc/', '/etc/passwd', `${root.replace(/\\/g, '/')}/`]) {
      const r = h.bridge.atList(q)
      assert.equal(r.entries.length, 0, `${q} 本该什么都列不出来`)
    }
  })

  // ---- @ 引用：发送时展开成模型看得见的块 ----
  //
  // 展开本身直接喂 atrefs（真临时目录，不碰 pi）；走 bridge 的那两条只验「接线」：
  // 离线 harness 里没有可用的 API 模型，send 会在组会话那步失败，
  // 但展开发生在它之前 —— 所以 notes 推没推进流，验得到、也不会真烧一轮。

  await it('@ 引用展开：文件贴内容、目录给清单、越界的原样挡下', async () => {
    const root = fakeProjectDir(mkdtempSync(path.join(os.tmpdir(), 'torra-at-')), 'proj2')
    mkdirSync(path.join(root, 'src', 'main'), { recursive: true })
    writeFileSync(path.join(root, 'src', 'a.ts'), 'const x = 1\nconst y = 2\n', 'utf8')
    mkdirSync(path.join(root, 'docs'), { recursive: true })
    writeFileSync(path.join(root, 'docs', 'note.md'), 'z', 'utf8')
    writeFileSync(path.join(root, 'src', 'main', 'modes.ts'), 'm', 'utf8')

    const got = expandAt(root, '先看 @src/a.ts 再说 @docs/ 里有什么')
    assert.equal(got.used, 2)
    assert.equal(got.notes.length, 0, '两个都展开成了，不该有补充说明')
    assert.match(got.blocks[0] ?? '', /【引用文件 @src\/a\.ts】\nconst x = 1\nconst y = 2/, '文件要连着内容一起给')
    assert.match(got.blocks[1] ?? '', /^【引用目录 @docs\/（[^\n]*往下 2 层）】\nnote\.md$/)
    // 目录清单往下走两层：项目的骨架要看得清，深了就该用 read
    const deep = expandAt(root, '@src/')
    assert.match(deep.blocks[0] ?? '', /】\nmain\/\n {2}modes\.ts\na\.ts$/, '目录排在文件前面，下一层的条目要缩进')
    // 越界与不存在：一个都不展开，但每一句都要还回来
    const bad = expandAt(root, '@../outside/x.ts @nope.ts')
    assert.equal(bad.used, 0)
    assert.equal(bad.notes.length, 2)
    assert.match(bad.notes.join('\n'), /不在工作目录里面/)
    assert.match(bad.notes.join('\n'), /找不到/)
    // 没有工作目录时不是「静默什么都不做」
    const noRoot = expandAt(undefined, '@src/a.ts')
    assert.equal(noRoot.used, 0)
    assert.match(noRoot.notes.join(''), /还没选工作目录/)
    // 长文件截断，并且说清还剩多少
    const big = fakeProjectDir(path.dirname(root), 'proj3')
    writeFileSync(path.join(big, 'long.ts'), 'y'.repeat(AT_FILE_CHARS_MAX + 500), 'utf8')
    const cut = expandAt(big, '@long.ts')
    assert.match(cut.blocks[0] ?? '', /后面还有 500 字没有贴进来/)
  })

  await it('@ 引用展开：图片指向附件、超大文件不贴进内存', async () => {
    const root = fakeProjectDir(mkdtempSync(path.join(os.tmpdir(), 'torra-at2-')), 'proj4')
    writeFileSync(path.join(root, 'shot.png'), 'fake', 'utf8')
    writeFileSync(path.join(root, 'huge.ts'), 'y'.repeat(3 * 1024 * 1024), 'utf8')
    const r = expandAt(root, '@shot.png @huge.ts')
    assert.equal(r.used, 0)
    assert.match(r.notes.join('\n'), /图片或二进制.*附件/, '图片要指向附件那条路')
    assert.match(r.notes.join('\n'), /太大/)
  })

  await it('@ 引用：没展开成的那些会进对话流说一句，消息照发', async () => {
    // 只有网页模型的清单：组会话必失败，所以真模型一次也不会被调到，
    // 而展开发生在提交之前 —— notes 推没推进流验得到。
    const h = harness({ models: () => [webModel] })
    const root = fakeProjectDir(h.dir, 'proj5')
    writeFileSync(path.join(root, 'ok.ts'), 'x', 'utf8')
    h.pick(root)
    await h.bridge.setWorkDir()

    const r = await h.bridge.send('看 @ok.ts 和 @gone.ts')
    assert.equal(r.ok, false, '这一场没有可用的 API 模型，发送本来就该失败')
    const statuses = h.pushes
      .filter((p) => p.channel === 'assistant:stream')
      .map((p) => p.payload as AssistantStreamEvent)
      .filter((e): e is Extract<AssistantStreamEvent, { kind: 'status' }> => e.kind === 'status')
      .map((e) => e.text)
    assert.ok(statuses.some((t) => /@gone\.ts 在盘上找不到/.test(t)), `丢掉一个引用不能是静默的：${JSON.stringify(statuses)}`)
    assert.ok(!statuses.some((t) => /@ok\.ts/.test(t)), '展开成了就不用再多说一句')
  })

  await it('@ 引用只跟着第一轮：目标模式不能每轮重贴同一个文件', async () => {
    const h = engineHarness([{ text: '做完了 [GOAL:DONE]' }, { text: 'x' }])
    h.engine.setMode({ mode: 'goal' })
    await h.engine.submit('修好它', [fileAtt('a.png')], '【引用文件 @src/a.ts】\ncode')
    assert.equal(h.refs[0], '【引用文件 @src/a.ts】\ncode')
    assert.equal(h.refs[1] ?? '', '', '续跑的轮次拿的是模型自己的上下文，不是重贴一遍')
  })

  await it('换一场会话：模式、计划锁、读取授权、工作目录一起清零（记住的那个只当候选）', async () => {
    // 用只有网页模型的清单跑这次 reset：它会在开新会话时失败并返回原因，
    // 但「清零」发生在开新会话之前 —— 我们要钉的正是这一步已经做过了。
    const h = harness({ models: () => [webModel] })
    const dir = fakeProjectDir(h.dir)
    h.pick(dir)
    await h.bridge.setWorkDir()
    h.handlers.get('assistant:set-mode')!({ mode: 'plan' })
    assert.equal((await h.bridge.overlay()).mode.readDirs.length, 1)
    assert.equal((await h.bridge.overlay()).mode.planLocked, true)
    assert.equal((await h.bridge.overlay()).workDir, dir)

    await h.bridge.reset()
    assert.deepEqual((await h.bridge.overlay()).mode, defaultModeState(), '上一场攒下的读权限不能跟到下一场')
    const next = await h.bridge.overlay()
    assert.equal(next.workDir, next.defaultWorkDir, '上一场的工作目录不能跟到下一场：@ 回到助手目录')
    assert.equal(next.recentWorkDir, dir, '但那个目录要被记住，浮层才给得出「继续用」那一下')
  })

  await it('一键「继续用」：只认记住的那个，点它才算这一场的授权', async () => {
    const a = fakeProjectDir(mkdtempSync(path.join(os.tmpdir(), 'torra-mem-')), 'repo-mine')
    const other = fakeProjectDir(path.dirname(a), 'repo-other')
    const h = harness({ lastWorkDir: () => a })

    assert.equal((await h.bridge.overlay()).recentWorkDir, a, '上一场挑过的要出现在浮层上')
    assert.match((await h.bridge.setWorkDir({ dir: other })).reason ?? '', /只能继续沿用/, '递一个没记过的路径就当授权，这条通道成了后门')
    assert.deepEqual((await h.bridge.overlay()).mode.readDirs, [], '被拒的那一下不许留下任何授权')

    const r = await h.bridge.setWorkDir({ dir: a })
    assert.equal(r.ok, true)
    assert.match(r.reason ?? '', /继续用/, '点的是「继续用」，回的话也要按这个来说')
    assert.deepEqual((await h.bridge.overlay()).mode.readDirs, [a], '一键下去的是这一场的读取授权')
    assert.equal((await h.bridge.overlay()).workDir, a)
  })

  await it('记住的目录已经不在了：浮层不再给出那一行', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'torra-gone-'))
    const a = fakeProjectDir(parent, 'repo-gone')
    const h = harness({ lastWorkDir: () => a })
    assert.equal((await h.bridge.overlay()).recentWorkDir, a)
    rmSync(a, { recursive: true, force: true })
    assert.equal((await h.bridge.overlay()).recentWorkDir, undefined, '点了必报错的行不该留在界面上')
  })

  await it('/技能 的名字读盘校验：认不出就不烧那一轮', async () => {
    const h = harness()
    const r = await h.bridge.send('/技能 没有这条 帮我看看')
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /技能目录里没有「没有这条」/)
    assert.equal(h.pushes.length, 0, '入口就拒，不给半截流')
  })

  // ---- 错误翻译：界面给人话，日志与折叠留原文 ----

  await it('认得出的症状翻成人话 + 下一步', () => {
    const cases: Array<[string, RegExp]> = [
      ["TypeError: webidl.util.markAsUncloneable is not a function", /Node 里缺失/],
      ['Error [ERR_REQUIRE_ESM]: require() of ES Module', /推理引擎没能装载/],
      ['401 unauthorized: Incorrect API key provided', /API Key 无效或已过期/],
      ['请求被拒：403 Forbidden', /权限或套餐限制/],
      ['HTTP 429 Too Many Requests', /限流或繁忙/],
      ['insufficient_quota: no balance', /额度不足/],
      ['This model maximum context length is 8192 tokens', /上下文窗口/],
      ['fetch failed: ENOTFOUND api.example.com', /连不上模型端点/],
      ['404: glm-4.6 is not supported by this endpoint', /模型端点上找不到/],
      ['502 Bad Gateway', /模型服务侧出错/],
    ]
    for (const [raw, expect] of cases) {
      const got = friendlyError(raw)
      assert.match(got, expect, `${raw} → ${got}`)
      // 每条人话都得给出动作，不能只描述现象
      assert.match(got, /设置页|重启|重试|稍等|换|检查|核对|充值|反馈|新会话|安装|构建|启动/, `${raw} 没给下一步`)
    }
  })

  await it('认不出的原文照抄，绝不把线索翻译成猜测', () => {
    const raw = 'AssertionError: ledger offset mismatch (block 12500)'
    assert.equal(friendlyError(raw), raw)
    // 状态码词边界：12500 不能被当成 5xx 服务故障
    assert.doesNotMatch(friendlyError('处理 12500 tokens 后返回空'), /模型服务侧出错/)
    assert.match(friendlyError(''), /没有拿到具体原因/)
    assert.match(friendlyError(undefined), /没有拿到具体原因/)
    const long = 'x'.repeat(400)
    const cut = friendlyError(long)
    assert.equal(cut.length < 400, true)
    assert.match(cut, /原文已截断/)
  })

  await it('多行堆栈压成一行，界面不会长出半屏错误', () => {
    assert.equal(friendlyError('a\n    b\n  c'), 'a b c')
  })

  await it('发消息失败：reason 给人看，detail 留原文，日志记 detail', async () => {
    const logged: Array<{ stage: string; detail?: string }> = []
    const h = harness({
      models: () => [webModel],
      log: (e) => logged.push({ stage: e.stage, detail: e.detail }),
    })
    const r = await h.bridge.send('随便说点什么')
    assert.equal(r.ok, false)
    // 这条本来就是可执行的中文原因，翻译必须原样放行
    assert.match(r.reason ?? '', /设置页新建/)
    assert.equal(r.detail, '没有可供助手使用的 API 模型。请在设置页新建一个 API 模型并填入 API Key。')
    assert.equal(logged.find((l) => l.stage === 'assistant:boot')?.detail, r.detail, '日志要留原文')
    assert.equal(h.pushes.length, 0, '失败只走返回值，不能再推一条同样的流事件')
  })

  console.log(`${'-'.repeat(44)}\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
