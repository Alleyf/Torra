/**
 * 助手 agent 的离线端到端回归（faux provider，不联网、不花 token、不需要 Electron）
 *
 * 这条测试存在的理由：SDK 是 ESM-only、跑不起来就要等到 Electron 升级完才知道，
 * 而组装层（provider → 工具 → resourceLoader → session）里最危险的几个失败
 * 都是「不报错但行为不对」：
 * - 没 reload resourceLoader → 助手用 pi 的编码助手人设回答 Torra 的问题；
 * - tools 白名单漏了自定义工具名 → 工具静默不注册，助手只会空谈；
 * - 确认闸门接错 → 写操作绕过用户直接改配置。
 * 这里用脚本化的假模型响应把整条链路跑通，把这些都钉死。
 *
 * 运行：npm run test:assistant-e2e
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AssistantCaps, ApprovalRequest } from '../src/main/assistant/tools'
import { ASSISTANT_TOOL_NAMES } from '../src/main/assistant/tools'
import { assistantSkillsDir, createAssistant } from '../src/main/assistant/session'
import type { AssistantStreamEvent, AssistantTurnStats } from '../src/shared/assistant'
import type { DoctorReport } from '../src/shared/diagnostics'
import type { WebPlan } from '../src/shared/smart-add'

const ROOT = path.resolve(__dirname, '..')

/**
 * 取 SDK 自带的那一份 pi-ai。
 *
 * 必须是同一个实例：faux provider 注册进 pi-ai 的 api-registry，
 * 装了第二份就注册到另一个注册表里，表现为「faux 响应永远不生效」。
 * pi-ai 没有从包根导出，所以直接按路径加载 SDK 依赖目录下的 dist。
 *
 * 用 new Function 拿原生 import：ts-node 是 commonjs，写 `import()` 会被降级成
 * require()，而 require 不接受 file: URL —— 报「Cannot find module」。
 */
const nativeImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>

async function loadPiAiPart(rel: string): Promise<any> {
  const dirs = [
    path.join(ROOT, 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist'),
    path.join(ROOT, 'node_modules/@earendil-works/pi-ai/dist'),
  ]
  const dir = dirs.find((d) => existsSync(path.join(d, rel)))
  if (!dir) throw new Error(`找不到 pi-ai 的 ${rel}，检查 node_modules 结构`)
  return nativeImport(pathToFileURL(path.join(dir, rel)).href)
}

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

function doctorReport(): DoctorReport {
  return {
    startedAt: 1,
    finishedAt: 2,
    userData: 'C:\\fake\\torra',
    scope: '全部启用模型',
    summary: { pass: 4, warn: 0, fail: 1, skip: 0 },
    blockingLayer: 'selector',
    checks: [
      {
        id: 'x',
        layer: 'selector',
        status: 'fail',
        ms: 5,
        title: '回复容器命中',
        evidence: ['div.message 命中 3 个，但其中含着输入框'],
        fix: '把 stream 改成单条回复容器',
        suggestion: 'div.markdown-body',
      },
    ],
  }
}

/** 识别链的方案样本：scan 是「stream 还没着落」的那一轮，drive 是代发完消息重识别出来的那一轮 */
function webPlans(): { scan: WebPlan; drive: WebPlan } {
  const base: Omit<WebPlan, 'selectors' | 'checks' | 'risks'> = {
    planId: 'plan-1',
    entry: 'https://yuanbao.demo/',
    name: '元宝',
    input_kind: 'textarea',
    send_mode: 'enter',
    stream_mode: 'last',
    completion_mode: 'dom_stable',
    stable_ms: 3000,
    confidence: {},
    why: {},
    questions: [],
    source: 'assistant',
    assistant: null,
    login: { state: 'logged-in', reason: '页面存在对话输入框' },
    rounds: 1,
  }
  return {
    scan: {
      ...base,
      selectors: { input: 'textarea.chat-input', send: '', stop: '', stream: '', generating: '' },
      checks: { input: { selector: 'textarea.chat-input', matches: 1, level: 'ok' } },
      risks: ['页面上还没有助手的回复，回复容器无从验证'],
    },
    drive: {
      ...base,
      rounds: 2,
      selectors: { input: 'textarea.chat-input', send: '', stop: '', stream: 'div.reply-body', generating: '' },
      checks: {
        input: { selector: 'textarea.chat-input', matches: 1, level: 'ok' },
        stream: { selector: 'div.reply-body', matches: 4, level: 'ok' },
      },
      risks: [],
    },
  }
}

function makeCaps(
  state: {
    calls: string[]
    approvals: ApprovalRequest[]
    approve?: (req: ApprovalRequest) => Promise<{ approved: boolean; reason?: string }>
  },
  web?: { scan: WebPlan; drive: WebPlan },
): AssistantCaps {
  return {
    listModels: () => [
      { id: 'deepseek-web', displayName: 'DeepSeek 网页', transport: 'webview', enabled: true, adapterId: 'deepseek', status: 'ready' },
      { id: 'api-user-glm', displayName: 'GLM', transport: 'api', enabled: true, baseUrl: 'https://x/v1', apiModel: 'glm-4.6', protocol: 'openai', hasKey: true },
    ],
    findModel: (id) =>
      id ? ({ id, displayName: id, transport: 'webview', enabled: true } as never) : undefined,
    runDoctor: async () => {
      state.calls.push('runDoctor')
      return doctorReport()
    },
    readLog: () => [],
    pageFacts: async () => ({ ok: true, url: 'https://chat.deepseek.com/', loginState: 'logged-in', chatInputs: 1 }),
    verifySelector: async () => ({ ok: true, matches: 2, covers: false }),
    readAdapter: () => undefined,
    saveAdapter: async () => {
      state.calls.push('saveAdapter')
      return { ok: true }
    },
    probeApiModel: async () => ({ ok: true, status: 200, modelCount: 1, models: ['glm-4.6'] }),
    createApiModel: async () => {
      state.calls.push('createApiModel')
      return { ok: true, id: 'api-user-new' }
    },
    createWebModel: async (input) => {
      // 建模型真正吃进去的那几个值：验好的 stream 与判定参数一路不能变形
      state.calls.push(`createWebModel:${input.selectors.stream}:${input.stream_mode}:${input.stable_ms}`)
      return { ok: true, id: 'web-new' }
    },
    runWebTurn: async (modelId, text) => {
      state.calls.push(`runWebTurn:${modelId}:${text}`)
      return { ok: true, chars: 36, preview: '我是元宝，腾讯的 AI 助手……', ms: 8_000 }
    },
    deleteModel: async () => {
      state.calls.push('deleteModel')
      return { ok: true }
    },
    openLogin: async () => ({ ok: true }),
    scanSite: async (input) => {
      state.calls.push('scanSite')
      // 没给方案样本时保持原来的「假能力集不真开页面」，其他用例依赖这条失败信息
      return web ? { ok: true, plan: web.scan } : { ok: false, reason: `假能力集不真开页面（${input.entry}）` }
    },
    answerSiteQuestions: async () => ({ ok: false, reason: '假能力集' }),
    checkSiteSelectors: async () => ({ ok: false, reason: '假能力集' }),
    driveSite: async (_planId, text) => {
      state.calls.push(`driveSite:${text}`)
      return web ? { ok: true, plan: web.drive } : { ok: false, reason: '假能力集' }
    },
    closeSiteScan: () => {
      state.calls.push('closeSiteScan')
    },
    approve: async (req) => {
      state.approvals.push(req)
      if (state.approve) return state.approve(req)
      return { approved: true }
    },
    log: () => undefined,
  }
}

async function main(): Promise<void> {
  console.log('\n助手 agent 端到端回归（faux）\n' + '='.repeat(46))

  const sdkMod = await import('../src/main/assistant/pi-sdk').then((m) => m.loadPiSdk())
  const compat = await loadPiAiPart('compat.js')
  const fauxMod = await loadPiAiPart('providers/faux.js')

  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'torra-assistant-e2e-'))
  // 这台机器可能本来就装过 pi CLI，~/.pi 里已有会话；只断言「这次没有往那儿新增」
  const piSessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions')
  const piHomeBefore = existsSync(piSessionsDir) ? readdirSync(piSessionsDir).length : 0

  async function startAssistant(caps: AssistantCaps, opts: { extensions?: boolean } = {}) {
    // 实测约束（不是文档想当然）：
    // - registerFauxProvider 每次调用生成唯一 api 串（faux:<ts>:<rand>）；
    // - 它只写进 pi-ai 的全局 api 注册表，ModelRuntime.create 看不见 → 必须自己 registerProvider；
    // - registerProvider 必须给 api 字段，传 stream/auth 实现反而被拒（"api" is required）。
    // 所以：faux 的 api 串 + 模型清单交给 ModelRuntime，流式实现由全局注册表按 api 反查。
    const faux = compat.registerFauxProvider({ tokensPerSecond: 100000 })
    const runtime = await sdkMod.ModelRuntime.create({
      authPath: path.join(dataDir, 'pi', 'auth.json'),
      modelsPath: null,
      allowModelNetwork: false,
    })
    const providerId = faux.models[0]!.provider
    runtime.registerProvider(providerId, {
      name: 'Faux',
      baseUrl: faux.models[0]!.baseUrl,
      apiKey: 'faux-key',
      api: faux.api,
      models: faux.models.map((m: any) => ({
        id: m.id,
        name: m.name ?? m.id,
        api: faux.api,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
        baseUrl: m.baseUrl,
      })),
    })
    await runtime.setRuntimeApiKey(providerId, 'faux-key')
    const model = runtime.getModel(providerId, faux.models[0]!.id)
    assert.ok(model, 'faux 模型没注册进 ModelRuntime')
    const events: AssistantStreamEvent[] = []
    const assistant = await createAssistant({
      dataDir,
      caps,
      runtime,
      model: model!,
      extensions: opts.extensions,
      emit: (e) => events.push(e),
    })
    return { reg: faux, assistant, events }
  }

  await it('组装成功：系统提示词是我们的，工具白名单全注册', async () => {
    const caps = makeCaps({ calls: [], approvals: [] })
    const { assistant } = await startAssistant(caps)
    try {
      assert.match(assistant.systemPromptText(), /Torra 的内置运维助手/)
      assert.doesNotMatch(assistant.systemPromptText(), /expert coding assistant/)
      assert.deepEqual(
        [...assistant.activeTools()].sort(),
        // 直接对白名单本身比对：新增工具只要注册了就不会漏，不必再维护第二份名单
        [...ASSISTANT_TOOL_NAMES].sort(),
      )
    } finally {
      assistant.dispose()
    }
  })

  await it('一轮对话：两次工具调用 → 文本 → settled，顺序与内容都对', async () => {
    const state = { calls: [] as string[], approvals: [] as ApprovalRequest[] }
    const { reg, assistant, events } = await startAssistant(makeCaps(state))
    try {
      reg.setResponses([
        fauxMod.fauxAssistantMessage([fauxMod.fauxToolCall('torra_list_models', {})], { stopReason: 'toolUse' }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxToolCall('torra_run_doctor', {})], { stopReason: 'toolUse' }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxText('有两个模型；选择器层有一项失败，建议改成 div.markdown-body。')]),
      ])
      await assistant.send('现在的模型都能用吗？')

      const starts = events.filter((e) => e.kind === 'tool-start').map((e) => (e as any).name)
      assert.deepEqual(starts, ['torra_list_models', 'torra_run_doctor'])
      assert.equal(events.filter((e) => e.kind === 'tool-end').length, 2)
      assert.equal(events.filter((e) => e.kind === 'settled').length, 1, 'settled 必须恰好一次')
      assert.equal(events.some((e) => e.kind === 'tool-end' && e.ok === false), false, '工具不应报错')
      const streamed = events.filter((e) => e.kind === 'text').map((e) => (e as any).delta).join('')
      assert.match(streamed, /选择器层有一项失败/)
      assert.deepEqual(state.calls, ['runDoctor'], '体检必须真的打到主进程')
      assert.equal(state.approvals.length, 0, '只读工具不该弹确认')
      assert.equal(reg.getPendingResponseCount(), 0)

      // ---- 本轮的账 ----
      const idx = events.findIndex((e) => e.kind === 'turn-stats')
      assert.ok(idx >= 0, '必须有一条 turn-stats')
      assert.equal(events[idx + 1]?.kind, 'settled', '统计要在 settled 之前送达，界面才不会少一轮')
      const stats = events[idx] as { stats: AssistantTurnStats }
      assert.equal(stats.stats.steps, 2)
      assert.deepEqual(stats.stats.byGroup, { tool: 2 })
      assert.equal(stats.stats.output > 0, true, 'faux 会按文本长度估 token，输出不该是 0')
      assert.equal(stats.stats.totalTokens, stats.stats.input + stats.stats.output + stats.stats.cacheRead + stats.stats.cacheWrite)
      assert.equal('ttftMs' in stats.stats, true, '直播的一轮一定有首字延迟')
      assert.equal(stats.stats.model, 'faux-1')

      // ---- 整场累计 + 从活着的那场还原历史 ----
      const all = assistant.stats()
      assert.ok(all, '跑过一轮就该有账')
      assert.equal(all.userMessages, 1)
      assert.equal(all.toolCalls, 2)
      assert.equal(all.contextWindow, 128000)
      assert.equal(all.tokens.total > 0, true)
      assert.equal(all.lastTurn?.steps, 2, '最近一轮要能单独解释「刚才花了多少」')
      assert.deepEqual(
        assistant.history().map((x) => x.role),
        ['user', 'tool', 'tool', 'assistant'],
        '历史要按思考/工具/正文分开，统计挂在正文上',
      )
      assert.equal(assistant.history()[3]?.stats?.steps, 2)
    } finally {
      assistant.dispose()
    }
  })

  await it('写操作被用户拒绝时不产生副作用，助手仍能拿到拒绝理由继续说', async () => {
    const state = {
      calls: [] as string[],
      approvals: [] as ApprovalRequest[],
      approve: async () => ({ approved: false, reason: '先别删' }),
    }
    const { reg, assistant, events } = await startAssistant(makeCaps(state))
    try {
      reg.setResponses([
        fauxMod.fauxAssistantMessage([fauxMod.fauxToolCall('torra_delete_model', { modelId: 'api-user-glm' })], {
          stopReason: 'toolUse',
        }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxText('好的，先不删。')]),
      ])
      await assistant.send('把 GLM 删掉')
      assert.equal(state.approvals.length, 1)
      assert.equal(state.approvals[0]!.action, 'delete_model')
      assert.deepEqual(state.calls, [], '拒绝后绝不能执行删除')
      const ended = events.find((e) => e.kind === 'tool-end') as { excerpt: string } | undefined
      assert.ok(ended && /用户拒绝/.test(ended.excerpt), '拒绝理由要回传给模型')
      assert.match(events.filter((e) => e.kind === 'text').map((e) => (e as any).delta).join(''), /先不删/)
    } finally {
      assistant.dispose()
    }
  })

  // 这条是「缺啥工具补啥」的终点验收：一个新站点从一个纯 URL 起步，
  // 全程由 agent 走完 —— 包括原先只能靠人敲键盘的那一下（发出第一条消息）。
  await it('agent 自己打通网页模型：扫描 → 代发第一条消息 → 建模型 → 体检 → 真机试发言 → 收窗口', async () => {
    const state = { calls: [] as string[], approvals: [] as ApprovalRequest[] }
    const { reg, assistant, events } = await startAssistant(makeCaps(state, webPlans()))
    try {
      reg.setResponses([
        fauxMod.fauxAssistantMessage([fauxMod.fauxToolCall('torra_scan_site', { entry: 'https://yuanbao.demo/' })], {
          stopReason: 'toolUse',
        }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxToolCall('torra_send_site_message', { planId: 'plan-1' })], {
          stopReason: 'toolUse',
        }),
        fauxMod.fauxAssistantMessage(
          [
            fauxMod.fauxToolCall('torra_create_web_model', {
              displayName: '元宝',
              entry: 'https://yuanbao.demo/',
              input: 'textarea.chat-input',
              stream: 'div.reply-body',
              input_kind: 'textarea',
              send_mode: 'enter',
              stream_mode: 'last',
              completion_mode: 'dom_stable',
              stable_ms: 3000,
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxMod.fauxAssistantMessage([fauxMod.fauxToolCall('torra_run_doctor', {})], { stopReason: 'toolUse' }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxToolCall('torra_test_web_model', { modelId: 'web-new', text: '你好' })], {
          stopReason: 'toolUse',
        }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxToolCall('torra_close_site_scan', {})], { stopReason: 'toolUse' }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxText('元宝已接入：输入框与回复容器都在真实页面验过，真发一轮也回出了内容。')]),
      ])
      await assistant.send('帮我把元宝接进来')

      assert.deepEqual(
        state.calls,
        [
          'scanSite',
          'driveSite:你好',
          'createWebModel:div.reply-body:last:3000',
          'runDoctor',
          'runWebTurn:web-new:你好',
          'closeSiteScan',
        ],
        '顺序就是这条链的因果：拿到回复容器才能建模型；实际 ' + JSON.stringify(state.calls),
      )
      // 只有「写页面」和「改配置」两步该问用户，其余步骤不打扰
      assert.deepEqual(
        state.approvals.map((a) => a.action).sort(),
        ['create_web_model', 'drive_site', 'test_web_model'],
      )
      assert.equal(state.approvals.find((a) => a.action === 'drive_site')!.risk?.includes('对话记录'), true)

      const ends = events.filter((e) => e.kind === 'tool-end') as Array<{ name?: string; ok: boolean; excerpt?: string }>
      assert.equal(ends.length, 6)
      assert.equal(ends.every((e) => e.ok), true, JSON.stringify(ends.find((e) => !e.ok)))
      // 扫描那一轮必须把「下一步是代发消息」讲出来，否则模型就会回头麻烦用户手动发
      assert.match(ends[0]?.excerpt ?? '', /torra_send_site_message/)
      assert.match(ends[1]?.excerpt ?? '', /回复容器：div\.reply-body → ok/)
      // 建完模型要拿真机试发言下结论：体检绿灯证明不了这条链发得出去
      assert.match(ends[4]?.excerpt ?? '', /通道可用/)
      assert.match(events.filter((e) => e.kind === 'text').map((e) => (e as any).delta).join(''), /元宝已接入/)
    } finally {
      assistant.dispose()
    }
  })

  await it('用户拒绝代发消息：页面一个字都不写，助手拿到理由后继续说', async () => {
    const state = {
      calls: [] as string[],
      approvals: [] as ApprovalRequest[],
      approve: async () => ({ approved: false, reason: '我自己在那个窗口里发' }),
    }
    const { reg, assistant, events } = await startAssistant(makeCaps(state, webPlans()))
    try {
      reg.setResponses([
        fauxMod.fauxAssistantMessage([fauxMod.fauxToolCall('torra_send_site_message', { planId: 'plan-1' })], {
          stopReason: 'toolUse',
        }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxText('好，那你在窗口里发一条，发好了我重新识别。')]),
      ])
      await assistant.send('给我接元宝')
      assert.deepEqual(state.calls, [], '拒绝后绝不能碰页面')
      const ended = events.find((e) => e.kind === 'tool-end') as { excerpt?: string } | undefined
      assert.match(ended?.excerpt ?? '', /用户拒绝/)
      assert.match(ended?.excerpt ?? '', /我自己在那个窗口里发/)
    } finally {
      assistant.dispose()
    }
  })

  await it('模型侧请求失败（stopReason=error）必须变成界面上的错误，而不是静默无响应', async () => {
    const state = { calls: [] as string[], approvals: [] as ApprovalRequest[] }
    const { reg, assistant, events } = await startAssistant(makeCaps(state))
    try {
      reg.setResponses([
        fauxMod.fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: '404: glm-4.6 is not supported by this endpoint',
        }),
      ])
      await assistant.send('最近哪场讨论有模型没发言，为什么')

      const errs = events.filter((e) => e.kind === 'error')
      assert.equal(errs.length, 1, '失败要说一次，不能不说也不能说两遍')
      // 界面看到人话 + 下一步；原文只能在折叠里出现
      assert.match((errs[0] as { text: string }).text, /模型端点上找不到/)
      assert.doesNotMatch((errs[0] as { text: string }).text, /is not supported/)
      assert.match((errs[0] as { detail?: string }).detail ?? '', /is not supported/)
      assert.equal(events.filter((e) => e.kind === 'settled').length, 1, '失败也要收尾，否则界面一直转')
    } finally {
      assistant.dispose()
    }
  })

  await it('技能开关决定可见性：开了才有 <available_skills> 和 read，越界读被闸门拦下', async () => {
    // 这条是「技能管理」和「助手真用得上技能」之间的接缝：盘上放了 SKILL.md，
    // 但白名单缺 read 时 pi 根本不会把 <available_skills> 拼进提示词 —— 不报错的哑火。
    const skillDir = path.join(assistantSkillsDir(dataDir), 'e2e-demo')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: e2e-demo\ndescription: 供端到端验证技能可见性的假技能\n---\n\n先取证再下结论。\n',
    )

    const off = await startAssistant(makeCaps({ calls: [], approvals: [] }))
    try {
      assert.equal(off.assistant.capabilities().skills.length, 0, '开关关着时不该加载技能')
      // 认 pi 拼进去的那句说明，不认 <available_skills> —— 这个词 Torra 自己的提示词里也有
      assert.doesNotMatch(off.assistant.systemPromptText(), /provide specialized instructions/)
      assert.equal(off.assistant.activeTools().includes('read'), false, '没开开关就不该给读文件的能力')
    } finally {
      off.assistant.dispose()
    }

    const state = { calls: [] as string[], approvals: [] as ApprovalRequest[] }
    const { reg, assistant, events } = await startAssistant(makeCaps(state), { extensions: true })
    try {
      assert.match(assistant.systemPromptText(), /provide specialized instructions/)
      assert.match(assistant.systemPromptText(), /<name>e2e-demo<\/name>/)
      assert.ok(assistant.activeTools().includes('read'), '白名单缺 read 时技能永远不会被读到')
      // Torra 自己注入的闸门宿主不是用户装的扩展，不该混进设置页的「已加载」列表
      assert.equal(assistant.capabilities().extensions.some((e) => e.path.includes('inline')), false)

      // 闸门装了没生效是最坏的情况：真调一次，越界的失败、界内的成功
      reg.setResponses([
        fauxMod.fauxAssistantMessage(
          [
            fauxMod.fauxToolCall('read', { path: path.join(dataDir, 'pi', 'auth.json') }),
            fauxMod.fauxToolCall('read', { path: path.join(skillDir, 'SKILL.md') }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxMod.fauxAssistantMessage([fauxMod.fauxText('技能读到了，凭据文件没读到。')]),
      ])
      await assistant.send('按 e2e-demo 技能做一遍')

      const ends = events.filter((e) => e.kind === 'tool-end') as Array<{ ok: boolean; excerpt?: string }>
      assert.equal(ends.length, 2, '两次 read 都该有结束事件')
      assert.equal(ends[0]?.ok, false, '越界读必须失败')
      assert.match(ends[0]?.excerpt ?? '', /技能目录/)
      assert.equal(ends[1]?.ok, true, '技能目录内的读必须成功')
      assert.match(ends[1]?.excerpt ?? '', /先取证再下结论/)
      assert.equal(state.approvals.length, 0, '受限 read 不该弹确认卡片')
    } finally {
      assistant.dispose()
    }
  })

  await it('声明式插件在组装期进白名单：activeTools 有它、capabilities 认它、宿主不外泄', async () => {
    // 这条锁死的是最阴的失败模式：pi 的显式 tools 白名单会把没登记的名字整个滤掉，
    // 内联扩展的工具名少合并一步就是「装好了但永远调不到」，而且一个字都不报。
    const pluginsDir = path.join(dataDir, 'pi', 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(
      path.join(pluginsDir, 'e2e-ping.plugin.json'),
      JSON.stringify({
        name: 'e2e-ping',
        description: '端到端验证插件注册的假工具',
        kind: 'http',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        http: { method: 'GET', url: 'http://127.0.0.1:9/ping' },
        confirm: 'never',
      }),
    )

    const state = { calls: [] as string[], approvals: [] as ApprovalRequest[] }
    const { reg, assistant, events } = await startAssistant(makeCaps(state), { extensions: true })
    try {
      assert.ok(assistant.activeTools().includes('e2e-ping'), '插件工具名没并进白名单就等于没注册 —— 本用例的全部意义')
      const capsNow = assistant.capabilities()
      const view = capsNow.plugins.find((p) => p.name === 'e2e-ping')
      assert.ok(view, '设置页要靠 capabilities.plugins 列出已加载插件')
      assert.equal(view!.kind, 'http')
      assert.equal(view!.confirm, 'never')
      assert.equal(
        capsNow.extensions.some((e) => e.tools.includes('e2e-ping') || String(e.path).includes('inline')),
        false,
        '插件走 Torra 自己的宿主，不该混进用户扩展列表',
      )
      assert.equal(capsNow.errors.some((e) => String(e.path).includes('e2e-ping')), false, '合法清单不该出现在错误里')

      // 回合一致性：模型这轮不调它，就不该凭空冒出执行事件，更不该弹确认
      reg.setResponses([fauxMod.fauxAssistantMessage([fauxMod.fauxText('在的。')])])
      await assistant.send('你好')
      assert.equal(events.filter((e) => e.kind === 'tool-start').length, 0, '没被调用就不许出现工具事件')
      assert.equal(events.filter((e) => e.kind === 'settled').length, 1)
      assert.equal(state.approvals.length, 0, 'confirm=never 且没被调用，任何卡片都不该弹')
    } finally {
      assistant.dispose()
    }
  })

  await it('会话落在 Torra 的 userData 下，不写 ~/.pi', () => {
    // 平铺在一个目录里：SessionManager.list 不递归，分作用域建子目录历史列表就列不到
    const files = readdirSync(path.join(dataDir, 'assistant-sessions'))
    assert.ok(files.some((f) => f.endsWith('.jsonl')), `期望有会话文件，实际：${files.join(',')}`)
    assert.equal(files.some((f) => !f.endsWith('.jsonl')), false, '会话目录下不该再有子目录')
    const after = existsSync(piSessionsDir) ? readdirSync(piSessionsDir).length : 0
    assert.equal(after, piHomeBefore, '助手会话不该落到 CLI 的 ~/.pi 目录')
  })

  console.log(`${'-'.repeat(46)}\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
