/**
 * 助手工具集的离线回归（假 caps，不需要 Electron，也不需要真实模型）
 *
 * 守住的三类「不会报错但后果很严重」的失败：
 * - 确认闸门失效：写操作没问用户就改了配置；
 * - 密钥泄漏：API Key 出现在给 LLM 的结果文本里，等于进了对话记录；
 * - 白名单与工具定义漂移：新增工具忘了加进 tools 数组，pi 会静默不启用它。
 *
 * 运行：npm run test:assistant-tools
 */

import assert from 'node:assert/strict'
import type { AdapterSpec } from '../src/shared/adapter'
import type { DoctorReport } from '../src/shared/diagnostics'
import type { WebPlan } from '../src/shared/smart-add'
import type { ModelConfig } from '../src/shared/types'
import {
  ASSISTANT_TOOL_NAMES,
  buildAssistantTools,
  type AssistantCaps,
  type ApprovalRequest,
  type ApprovalResult,
} from '../src/main/assistant/tools'

const SECRET = 'sk-live-abc123-never-in-output'

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
    userData: 'A:\\appdata\\torra',
    scope: '全部启用模型',
    summary: { pass: 5, warn: 1, fail: 1, skip: 0 },
    blockingLayer: 'selector',
    checks: [
      { id: 'a', layer: 'env', title: '目录可写', status: 'pass', ms: 1, evidence: [] },
      {
        id: 's',
        layer: 'selector',
        status: 'fail',
        ms: 3,
        title: '输入框命中',
        evidence: ['页面上 0 命中 textarea.x'],
        fix: '把 input 改成页面上真实存在的选择器',
        suggestion: 'textarea#chat',
      },
      {
        id: 'l',
        layer: 'login',
        status: 'warn',
        ms: 2,
        title: '登录态可疑',
        evidence: ['看到登录入口'],
      },
    ],
  }
}

/** 识别链返回的方案样本：只填了 input/stream，stop 与 generating 刻意缺着**/
function webPlan(over: Partial<WebPlan> = {}): WebPlan {
  return {
    planId: 'plan-1',
    entry: 'https://yuanbao.example/',
    name: '元宝',
    selectors: { input: 'textarea[placeholder]', send: '', stop: '', stream: 'div.msg', generating: '' },
    input_kind: 'contenteditable',
    send_mode: 'enter',
    stream_mode: 'all',
    completion_mode: 'dom_stable',
    stable_ms: 4000,
    confidence: { input: 0.9, stream: 0.7, overall: 0.8 },
    why: { stream: '每条回复都带该 class' },
    risks: ['回复容器可能随版本改动'],
    questions: [
      {
        id: 'q_kind',
        prompt: '输入框是哪种？',
        target: 'input_kind',
        options: [
          { value: 'textarea', label: '普通文本框' },
          { value: 'contenteditable', label: '富文本编辑器', hint: '需要按键盘事件发送' },
        ],
        free_text: true,
      },
    ],
    checks: {
      input: { selector: 'textarea[placeholder]', matches: 1, level: 'ok' },
      stream: { selector: 'div.msg', matches: 12, level: 'warn', note: '命中偏多' },
    },
    source: 'assistant',
    assistant: { modelId: 'api-user-glm', displayName: 'GLM' },
    login: { state: 'logged-in', reason: '页面存在对话输入框且无登录入口' },
    rounds: 2,
    ...over,
  }
}

/** 记录调用的假能力集：默认用户批准一切，needsKey 时给出真实 key */
function fakeCaps(over: Partial<AssistantCaps> = {}): AssistantCaps & { calls: string[]; approvals: ApprovalRequest[] } {
  const calls: string[] = []
  const approvals: ApprovalRequest[] = []
  return {
    calls,
    approvals,
    listModels: () => [
      { id: 'deepseek-web', displayName: 'DeepSeek 网页', transport: 'webview', enabled: true, adapterId: 'deepseek', status: 'ready' },
      {
        id: 'api-user-glm',
        displayName: 'GLM',
        transport: 'api',
        enabled: true,
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiModel: 'glm-4.6',
        protocol: 'openai',
        hasKey: true,
      },
    ],
    findModel: (id) =>
      id === 'api-user-glm'
        ? ({ id, displayName: 'GLM', transport: 'api', enabled: true } as ModelConfig)
        : id === 'deepseek-web'
          ? ({ id, displayName: 'DeepSeek 网页', transport: 'webview', enabled: true, adapterId: 'deepseek' } as ModelConfig)
          : undefined,
    runDoctor: async () => doctorReport(),
    readLog: () => [
      { ts: Date.UTC(2026, 9, 4, 1, 2, 3), layer: 'selector', stage: 'hits', subject: 'deepseek-web', ok: false, ms: 12, detail: '0 命中' },
      { ts: Date.UTC(2026, 9, 4, 1, 2, 4), layer: 'login', stage: 'probe', ok: true },
    ],
    pageFacts: async () => ({ ok: true, url: 'https://chat.deepseek.com/', title: 'DeepSeek', loginState: 'logged-in', chatInputs: 1 }),
    verifySelector: async (_m, sel) =>
      sel === 'main' ? { ok: true, matches: 1, covers: true } : { ok: true, matches: 3, covers: false },
    readAdapter: (id) =>
      id === 'deepseek'
        ? {
            id: 'deepseek',
            name: 'DeepSeek',
            origin: 'builtin',
            entry: 'https://chat.deepseek.com/',
            health: 'ok',
            stale: false,
            yaml: 'id: deepseek\nname: DeepSeek\n',
          }
        : undefined,
    saveAdapter: async (spec) => {
      calls.push(`saveAdapter:${spec.id}`)
      return { ok: true }
    },
    probeApiModel: async () => ({ ok: true, status: 200, modelCount: 2, models: ['glm-4.6', 'glm-4-air'] }),
    createApiModel: async (input, apiKey) => {
      calls.push(`createApiModel:${input.model}`)
      // 真实 key 必须能被主进程拿到（否则钥匙串写不进去）
      assert.equal(apiKey, SECRET)
      return { ok: true, id: 'api-user-new' }
    },
    createWebModel: async (input) => {
      calls.push(`createWebModel:${input.displayName}`)
      return { ok: true, id: 'web-new' }
    },
    runWebTurn: async (id, text) => {
      calls.push(`runWebTurn:${id}:${text}`)
      return { ok: true, chars: 42, preview: '我是 DeepSeek，……', ms: 9_000 }
    },
    deleteModel: async (id) => {
      calls.push(`deleteModel:${id}`)
      return { ok: true }
    },
    openLogin: async (id) => {
      calls.push(`openLogin:${id}`)
      return { ok: true }
    },
    scanSite: async (input) => {
      calls.push(`scanSite:${input.entry}`)
      return { ok: true, plan: webPlan({ entry: input.entry }) }
    },
    answerSiteQuestions: async (planId, answers) => {
      calls.push(`answerSiteQuestions:${planId}:${Object.keys(answers).join(',')}`)
      return { ok: true, plan: webPlan() }
    },
    checkSiteSelectors: async (planId, selectors) => {
      const ordered = (['input', 'send', 'stop', 'stream', 'generating'] as const)
        .map((k) => `${k}=${selectors[k] ?? ''}`)
        .join('|')
      calls.push(`checkSiteSelectors:${planId}|${ordered}`)
      return { ok: true, plan: webPlan() }
    },
    driveSite: async (planId, text) => {
      calls.push(`driveSite:${planId}:${text}`)
      return { ok: true, plan: webPlan({ rounds: 3 }) }
    },
    closeSiteScan: () => {
      calls.push('closeSiteScan')
    },
    approve: async (req) => {
      approvals.push(req)
      return { approved: true, ...(req.needsKey ? { apiKey: SECRET } : {}) } satisfies ApprovalResult
    },
    log: () => undefined,
    ...over,
  }
}

function out(result: { content: Array<{ text?: string }>; details?: unknown }): string {
  return result.content.map((c) => c.text ?? '').join('\n')
}

async function main(): Promise<void> {
  console.log('\n助手工具集回归\n' + '='.repeat(46))

  const tools = await buildAssistantTools(fakeCaps())
  const byName = new Map(tools.map((t) => [t.name, t]))

  await it('工具名与白名单完全一致（漏一个就会静默失效）', () => {
    assert.deepEqual(tools.map((t) => t.name).sort(), [...ASSISTANT_TOOL_NAMES].sort())
    assert.equal(new Set(tools.map((t) => t.name)).size, ASSISTANT_TOOL_NAMES.length)
  })

  await it('每个工具都有给 LLM 的 description 与 parameters schema', () => {
    for (const t of tools) {
      assert.ok(t.description.length > 20, `${t.name} description 太短`)
      assert.ok(t.label.length > 0, `${t.name} 缺 label`)
      assert.equal((t.parameters as { type?: string }).type, 'object', `${t.name} parameters 不是 object schema`)
    }
  })

  await it('list_models 返回真实 id，不返回任何 key 字段', async () => {
    const r = await byName.get('torra_list_models')!.execute('t1', {}, undefined, undefined, {} as never)
    const s = out(r)
    assert.match(s, /deepseek-web/)
    assert.match(s, /"hasKey": true/)
    assert.doesNotMatch(s, /sk-live/)
    assert.doesNotMatch(s, /apiKeyRef|pricePerMTok/)
  })

  await it('run_doctor 只回摘要 + 问题项，pass 项不占上下文', async () => {
    const r = await byName.get('torra_run_doctor')!.execute('t1', {}, undefined, undefined, {} as never)
    const s = out(r)
    assert.match(s, /1 fail \/ 1 warn/)
    assert.match(s, /输入框命中/)
    assert.match(s, /建议值：textarea#chat/)
    assert.doesNotMatch(s, /目录可写/)
  })

  await it('read_log 把过滤条件与条数上限传给主进程，并把 ok:false 标成 FAIL', async () => {
    let seen: { layer?: string; subject?: string; limit: number } | null = null
    const caps = fakeCaps({
      readLog: (f) => {
        seen = f
        return [{ ts: Date.UTC(2026, 9, 4, 1, 2, 3), layer: 'selector', stage: 'hits', subject: 'deepseek-web', ok: false, ms: 12, detail: '0 命中' }]
      },
    })
    const ts = await buildAssistantTools(caps)
    const r = await ts
      .find((t) => t.name === 'torra_read_log')!
      .execute('t1', { layer: 'selector', subject: 'deepseek-web', limit: 999 }, undefined, undefined, {} as never)
    // limit 必须在工具里封顶，否则模型一句「把日志都给我」就能塞满上下文窗口
    assert.deepEqual(seen, { layer: 'selector', subject: 'deepseek-web', limit: 200 })
    assert.match(out(r), /selector\/hits/)
    assert.match(out(r), /FAIL/)
  })

  await it('verify_selector 把「含着输入框的外壳」判为不可用', async () => {
    const bad = await byName.get('torra_verify_selector')!.execute('t1', { modelId: 'deepseek-web', selector: 'main' }, undefined, undefined, {} as never)
    assert.match(out(bad), /整页\/列表外壳/)
    const good = await byName.get('torra_verify_selector')!.execute('t1', { modelId: 'deepseek-web', selector: 'div.msg' }, undefined, undefined, {} as never)
    assert.match(out(good), /可用：命中 3 个/)
  })

  await it('读适配器：不存在的 id 明确报错，不静默返回空', async () => {
    await assert.rejects(
      () => byName.get('torra_read_adapter')!.execute('t1', { adapterId: 'nope' }, undefined, undefined, {} as never),
      /不存在/,
    )
    const ok = await byName.get('torra_read_adapter')!.execute('t1', { adapterId: 'deepseek' }, undefined, undefined, {} as never)
    assert.match(out(ok), /来源 builtin/)
  })

  await it('写操作全部要求确认，且确认卡片里写清了改什么', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    const m = new Map(ts.map((t) => [t.name, t]))
    const spec = { id: 'deepseek', name: 'DeepSeek', transport: 'webview' } as unknown as AdapterSpec
    await m.get('torra_save_adapter')!.execute('t1', { spec }, undefined, undefined, {} as never)
    await m.get('torra_delete_model')!.execute('t1', { modelId: 'api-user-glm' }, undefined, undefined, {} as never)
    await m.get('torra_open_login')!.execute('t1', { modelId: 'deepseek-web' }, undefined, undefined, {} as never)
    assert.deepEqual(
      caps.approvals.map((a) => a.action).sort(),
      ['delete_model', 'open_login', 'save_adapter'],
    )
    assert.match(caps.approvals.find((a) => a.action === 'save_adapter')!.detail, /deepseek/)
  })

  await it('只读工具不该触发确认', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    const m = new Map(ts.map((t) => [t.name, t]))
    await m.get('torra_list_models')!.execute('t1', {}, undefined, undefined, {} as never)
    await m.get('torra_run_doctor')!.execute('t1', {}, undefined, undefined, {} as never)
    await m.get('torra_probe_api_model')!.execute('t1', { modelId: 'api-user-glm' }, undefined, undefined, {} as never)
    // 识别链的三步都不改配置，逐条弹确认会把用户问烦（真正要确认的是下一步建模型）
    await m.get('torra_scan_site')!.execute('t1', { entry: 'https://yuanbao.example/' }, undefined, undefined, {} as never)
    await m
      .get('torra_answer_site_questions')!
      .execute('t1', { planId: 'plan-1', answers: { q_kind: 'contenteditable' } }, undefined, undefined, {} as never)
    await m
      .get('torra_check_site_selectors')!
      .execute('t1', { planId: 'plan-1', input: 'textarea', stream: 'div.msg' }, undefined, undefined, {} as never)
    await m.get('torra_close_site_scan')!.execute('t1', {}, undefined, undefined, {} as never)
    assert.equal(caps.approvals.length, 0)
  })

  // 这条链是助手第一次能「凭空」接一个新站点的原因：入参只有 URL，
  // 开页面、猜选择器、回测命中数全在主进程那侧（见 bridge 的 siteScan）。
  await it('纯 URL 就能起步：扫描结果里带回 planId、命中数与待澄清问题', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    const r = await ts
      .find((t) => t.name === 'torra_scan_site')!
      .execute('t1', { entry: 'https://yuanbao.example/' }, undefined, undefined, {} as never)
    const s = out(r)
    assert.deepEqual(caps.calls, ['scanSite:https://yuanbao.example/'])
    // 后续三步都靠 planId 续上，丢了它整条链就断
    assert.match(s, /plan-1/)
    assert.match(s, /输入框：textarea\[placeholder\] → ok · 命中 1/)
    assert.match(s, /停止按钮：未识别/)
    assert.match(s, /stream_mode=all/)
    assert.match(s, /stable_ms=4000/)
    assert.match(s, /q_kind → input_kind/)
    assert.match(s, /contenteditable（富文本编辑器，需要按键盘事件发送）/)
    assert.match(s, /也可自由说明/)
  })

  await it('扫描失败不等于站点接不了：把原因和「重试」交回模型', async () => {
    const ts = await buildAssistantTools(
      fakeCaps({ scanSite: async () => ({ ok: false, reason: '请在已打开的窗口里完成登录' }) }),
    )
    const r = await ts
      .find((t) => t.name === 'torra_scan_site')!
      .execute('t1', { entry: 'https://x/' }, undefined, undefined, {} as never)
    assert.match(out(r), /请在已打开的窗口里完成登录/)
    assert.match(out(r), /站点不支持接入/)
  })

  await it('回填答案按问题 id 提交（不是 target）', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    await ts
      .find((t) => t.name === 'torra_answer_site_questions')!
      .execute('t1', { planId: 'plan-1', answers: { q_kind: 'contenteditable', q_name: '元宝' } }, undefined, undefined, {} as never)
    assert.deepEqual(caps.calls, ['answerSiteQuestions:plan-1:q_kind,q_name'])
  })

  await it('非法 answers 直接拒掉，避免静默什么都不改', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    const tool = ts.find((t) => t.name === 'torra_answer_site_questions')!
    await assert.rejects(
      () => tool.execute('t1', { planId: 'plan-1', answers: 'contenteditable' }, undefined, undefined, {} as never),
      /对象/,
    )
    assert.deepEqual(caps.calls, [])
  })

  await it('回测是整套提交：漏传的角色会被清空', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    await ts
      .find((t) => t.name === 'torra_check_site_selectors')!
      .execute('t1', { planId: 'plan-1', input: 'textarea', stream: 'div.msg', stop: 'button.stop' }, undefined, undefined, {} as never)
    const sent = caps.calls.find((c) => c.startsWith('checkSiteSelectors'))
    assert.equal(sent, 'checkSiteSelectors:plan-1|input=textarea|send=|stop=button.stop|stream=div.msg|generating=')
  })

  // 代发消息是识别链里唯一会「写页面」的一步：它在用户账号下留下一条真实对话，
  // 所以确认闸门不能松，同时它也是打通「回复容器 0 候选」的唯一出路。
  await it('代发消息要过确认，卡片上讲清会在账号里留下记录', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    await ts
      .find((t) => t.name === 'torra_send_site_message')!
      .execute('t1', { planId: 'plan-1' }, undefined, undefined, {} as never)
    assert.equal(caps.approvals.length, 1)
    assert.equal(caps.approvals[0]?.action, 'drive_site')
    assert.match(caps.approvals[0]!.detail, /「你好」/)
    assert.match(caps.approvals[0]!.risk ?? '', /对话记录/)
    assert.deepEqual(caps.calls, ['driveSite:plan-1:你好'])
  })

  await it('用户拒绝时不碰页面', async () => {
    const caps = fakeCaps({ approve: async () => ({ approved: false, reason: '我自己发' }) })
    const ts = await buildAssistantTools(caps)
    const r = await ts
      .find((t) => t.name === 'torra_send_site_message')!
      .execute('t1', { planId: 'plan-1' }, undefined, undefined, {} as never)
    assert.match(out(r), /用户拒绝/)
    assert.match(out(r), /我自己发/)
    assert.deepEqual(caps.calls, [])
  })

  await it('代发内容限长：空用默认「你好」，超长截到 200 字', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    const tool = ts.find((t) => t.name === 'torra_send_site_message')!
    await tool.execute('t1', { planId: 'p', text: '   ' }, undefined, undefined, {} as never)
    await tool.execute('t1', { planId: 'p', text: '话'.repeat(300) }, undefined, undefined, {} as never)
    const bodies = caps.calls.filter((c) => c.startsWith('driveSite'))
    assert.equal(bodies[0], 'driveSite:p:你好')
    assert.equal(bodies[1]?.split(':')[2]?.length, 200)
  })

  await it('驱动成功后回的是重识别出来的新方案（带轮次与命中数）', async () => {
    const ts = await buildAssistantTools(fakeCaps())
    const r = await ts
      .find((t) => t.name === 'torra_send_site_message')!
      .execute('t1', { planId: 'plan-1' }, undefined, undefined, {} as never)
    const s = out(r)
    assert.match(s, /plan-1/)
    assert.match(s, /第 3 轮/)
    assert.match(s, /回复容器：div\.msg → warn/)
    assert.equal((r.details as { plan: WebPlan }).plan.rounds, 3)
  })

  await it('等了 90 秒没回复：把原因回给模型，不谎报成功', async () => {
    const ts = await buildAssistantTools(
      fakeCaps({ driveSite: async () => ({ ok: false, reason: '90s 内页面上没有出现回复' }) }),
    )
    const r = await ts
      .find((t) => t.name === 'torra_send_site_message')!
      .execute('t1', { planId: 'plan-1' }, undefined, undefined, {} as never)
    assert.match(out(r), /代发消息没成功/)
    assert.match(out(r), /没有出现回复/)
    assert.equal((r.details as { plan: WebPlan | null }).plan, null)
  })

  await it('回复容器还没着落时，方案文本直接指向代发消息这一步', async () => {
    const ts = await buildAssistantTools(
      fakeCaps({
        scanSite: async () => ({
          ok: true,
          plan: webPlan({
            selectors: { input: 'textarea', send: '', stop: '', stream: '', generating: '' },
            checks: { input: { selector: 'textarea', matches: 1, level: 'ok' } },
          }),
        }),
      }),
    )
    const r = await ts
      .find((t) => t.name === 'torra_scan_site')!
      .execute('t1', { entry: 'https://yuanbao.example/' }, undefined, undefined, {} as never)
    const s = out(r)
    assert.match(s, /torra_send_site_message/)
    assert.doesNotMatch(s, /全部 ok 就 torra_create_web_model/)
    assert.ok(!s.includes('下一步：仍有 fail/0 命中就 torra_check_site_selectors'))
  })

  await it('建模型要把方案里的 stream_mode/stable_ms 原样传下去', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    const r = await ts
      .find((t) => t.name === 'torra_create_web_model')!
      .execute(
        't1',
        { displayName: '元宝', entry: 'https://yuanbao.example/', input: 'textarea', stream: 'div.msg', stream_mode: 'all', stable_ms: 4000.6 },
        undefined,
        undefined,
        {} as never,
      )
    assert.deepEqual(caps.calls, ['createWebModel:元宝'])
    assert.match(out(r), /torra_test_web_model/)
  })

  await it('真机试发言：确认后才真发，并把回复开头带回给模型', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    const r = await ts
      .find((t) => t.name === 'torra_test_web_model')!
      .execute('t1', { modelId: 'deepseek-web', text: '你好' }, undefined, undefined, {} as never)
    assert.equal(caps.approvals[0]?.action, 'test_web_model')
    assert.deepEqual(caps.calls, ['runWebTurn:deepseek-web:你好'])
    assert.match(out(r), /通道可用/)
    assert.match(out(r), /我是 DeepSeek/)
  })

  await it('真机试发言失败要说清是运行时失败，并给出修适配器的下一步', async () => {
    const caps = fakeCaps({
      runWebTurn: async () => ({ ok: false, reason: '元宝 input vanished before send', ms: 12_000 }),
    })
    const ts = await buildAssistantTools(caps)
    const r = await ts
      .find((t) => t.name === 'torra_test_web_model')!
      .execute('t1', { modelId: 'deepseek-web' }, undefined, undefined, {} as never)
    assert.match(out(r), /input vanished before send/)
    assert.match(out(r), /torra_save_adapter/)
  })

  await it('用户拒绝试发言：页面一个字都不写', async () => {
    const caps = fakeCaps({ approve: async () => ({ approved: false, reason: '别花我的额度' }) })
    const ts = await buildAssistantTools(caps)
    const r = await ts
      .find((t) => t.name === 'torra_test_web_model')!
      .execute('t1', { modelId: 'deepseek-web' }, undefined, undefined, {} as never)
    assert.match(out(r), /用户拒绝/)
    assert.deepEqual(caps.calls, [])
  })

  await it('用户拒绝时不执行副作用，并告诉模型不要重试', async () => {
    const caps = fakeCaps({ approve: async () => ({ approved: false, reason: '先别动' }) })
    const ts = await buildAssistantTools(caps)
    const m = new Map(ts.map((t) => [t.name, t]))
    const r = await m.get('torra_delete_model')!.execute('t1', { modelId: 'api-user-glm' }, undefined, undefined, {} as never)
    assert.match(out(r), /用户拒绝/)
    assert.match(out(r), /先别动/)
    assert.deepEqual(caps.calls, [])
  })

  await it('新建 API 模型：key 来自确认卡片，且绝不出现在结果文本里', async () => {
    const caps = fakeCaps()
    const ts = await buildAssistantTools(caps)
    const m = new Map(ts.map((t) => [t.name, t]))
    const req = { displayName: '新模型', baseUrl: 'https://x.example/v1', model: 'm1' }
    const r = await m.get('torra_create_api_model')!.execute('t1', req, undefined, undefined, {} as never)
    assert.deepEqual(caps.calls, ['createApiModel:m1'])
    assert.doesNotMatch(out(r), /never-in-output/)
    assert.doesNotMatch(JSON.stringify(r.details), /never-in-output/)
    assert.equal(caps.approvals[0]?.needsKey, true)
  })

  await it('批准但没填 key：中止创建，并给出下一步', async () => {
    const caps = fakeCaps({ approve: async () => ({ approved: true }) })
    const ts = await buildAssistantTools(caps)
    const r = await ts
      .find((t) => t.name === 'torra_create_api_model')!
      .execute('t1', { displayName: 'x', baseUrl: 'https://y/v1', model: 'm' }, undefined, undefined, {} as never)
    assert.match(out(r), /没有填写 API Key/)
    assert.deepEqual(caps.calls, [])
  })

  console.log(`${'-'.repeat(46)}\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
