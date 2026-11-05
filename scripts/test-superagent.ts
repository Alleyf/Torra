/**
 * 超智能体任务台的不变量。
 *
 * 这一层最怕的是「静默降级」：任务派下去了、Worker 还在跑，界面却显示已完成；
 * 或者工具清单里加了个名字，execute 里却没有那个分支 —— 模型以为派下去了，
 * 实际什么都没有发生。这两类错代码都能编译、都能启动，只有把状态机与工具清单
 * 按真数据走一遍才看得见。
 *
 * 运行：npm run test:superagent
 */

import assert from 'node:assert/strict'
import { SuperAgentTasks, describePermission, type WorkerHooks } from '../src/main/superagent/tasks'
import { SuperRouter, parseRouterStream, ROUTER_TOOLS, shapeTools, shapeMessages } from '../src/main/superagent/router'
import type { AcpService } from '../src/main/acp'
import type { ApiConfig } from '../src/shared/types'
import type { HostEvent } from '../src/shared/host'
import type { AcpPermissionRequest } from '../src/shared/acp'
import { stageLabel } from '../src/shared/superagent'

let passed = 0
let failed = 0
const it = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve(fn()).then(
    () => {
      passed++
      console.log(`  ok  ${name}`)
    },
    (e: unknown) => {
      failed++
      console.error(`  FAIL ${name}`)
      console.error(`       ${(e as Error)?.message ?? e}`)
    },
  )

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

interface FakeWorker {
  hooks: WorkerHooks
  started?: string
  prompted?: string[]
  lastDecision?: { optionId: string | null }
  /** 被叫停了几次：取消必须真的打到 Worker 上，光翻 stage 是假的 */
  stops?: number
}

function makeHarness(
  opts: { failStartFor?: string; spawnDelayMs?: number } = {},
): { tasks: SuperAgentTasks; workers: FakeWorker[] } {
  const workers: FakeWorker[] = []
  const tasks = new SuperAgentTasks({
    service: (hooks: WorkerHooks) => {
      const w: FakeWorker = { hooks }
      // 一边记下挂起的授权号，一边照旧把任务推到 waiting_input
      const onPermission = hooks.onPermission
      hooks.onPermission = (req) => {
        w.pending = req
        onPermission(req)
      }
      workers.push(w)
      const svc = {
        start: async (id: string) => {
          // 慢启动：让「工具执行期间被叫停」有确定的时序，不必靠 sleep 猜
          if (opts.spawnDelayMs) await sleep(opts.spawnDelayMs)
          if (opts.failStartFor && id === opts.failStartFor) return { ok: false, error: '这一家没装' }
          w.started = id
          return { ok: true, sessionId: 'sess', capabilities: {} }
        },
        prompt: async (text: string) => {
          w.prompted ??= []
          w.prompted.push(text)
          return { ok: true }
        },
        stop: async () => {
          w.stops = (w.stops ?? 0) + 1
        },
        respondPermission: (id: string, d: { optionId: string | null }) => {
          if (id !== w.pending?.id) return false
          w.lastDecision = d
          return true
        },
      }
      return svc as unknown as AcpService
    },
    agentTitleOf: (id) => `${id} 的标题`,
    cwdOf: () => '/tmp/torra-work',
    tailChars: 40,
  })
  return { tasks, workers }
}

/** 把一条 HostEvent 的 kind 与必要字段凑齐（类型上只要求 kind 是合法值） */
function ev(kind: HostEvent['kind'], extra: Record<string, unknown> = {}): HostEvent {
  return { turnId: 't', ...extra, kind } as unknown as HostEvent
}

const PERM: AcpPermissionRequest = {
  id: 'p1',
  sessionId: 's',
  title: '删掉 src/legacy',
  toolKind: 'edit',
  options: [{ optionId: 'once', name: '仅这一次', kind: 'once' }],
}

const API: ApiConfig = {
  baseUrl: 'http://router.invalid/v1',
  model: 'router-model',
  apiKeyRef: 'router:key',
  pricePerMTokIn: 1,
  pricePerMTokOut: 1,
  maxContextTokens: 8192,
}

/** 一段 SSE 文本 -> Response（流式） */
function sseResponse(raw: string): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(raw))
      c.close()
    },
  })
  return new Response(body, { status: 200 })
}

const chunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const DONE = 'data: [DONE]\n\n'

async function main(): Promise<void> {
  console.log('超智能体任务台')

  // ---- 阶段词表：界面分组只认这一组，加阶段必须两边一起改 ----
  await it('阶段词表有中文标签，没有一个阶段是没说法的', () => {
    const stages = ['pending', 'working', 'waiting_input', 'done', 'failed', 'cancelled'] as const
    for (const s of stages) assert.ok(stageLabel(s).length > 0, `${s} 没有标签`)
    assert.equal(stageLabel('waiting_input'), '等你')
    assert.equal(stageLabel('cancelled'), '已取消')
  })

  // ---- 任务层：状态机 ----
  await it('spawn：起来之后是 working，目标原样发给 Worker，目录用默认的', async () => {
    const { tasks, workers } = makeHarness()
    const t = await tasks.spawn({ title: '写一个解析器', goal: '解析 CSV', agentId: 'claude' })
    assert.equal(t.stage, 'working')
    assert.equal(t.agentTitle, 'claude 的标题')
    assert.equal(t.cwd, '/tmp/torra-work')
    assert.equal(workers[0].started, 'claude')
    assert.deepEqual(workers[0].prompted, ['解析 CSV'])
  })

  await it('起不来要判 failed 并写清原因，不能假装 working', async () => {
    const { tasks } = makeHarness({ failStartFor: 'claude' })
    const t = await tasks.spawn({ title: '写一个解析器', goal: 'g', agentId: 'claude' })
    assert.equal(t.stage, 'failed')
    assert.match(t.error ?? '', /这一家没装/)
  })

  await it('正文按 delta 累积，尾巴只留最后一段', async () => {
    const { tasks, workers } = makeHarness()
    await tasks.spawn({ title: 'x', goal: 'g', agentId: 'claude' })
    workers[0].hooks.onEvent(ev('message.delta', { channel: 'text', delta: '第一段' }))
    workers[0].hooks.onEvent(ev('message.delta', { channel: 'text', delta: '第二段' }))
    const t = tasks.list()[0]
    assert.equal(t.outputTail, '第一段第二段')
    workers[0].hooks.onEvent(ev('message.delta', { channel: 'text', delta: 'X'.repeat(100) }))
    assert.equal(t.outputTail.length, 40, '尾巴要截断，不能把整场正文都堆在任务上')
  })

  await it('思考频道不进正文', async () => {
    const { tasks, workers } = makeHarness()
    await tasks.spawn({ title: 'x', goal: 'g', agentId: 'claude' })
    workers[0].hooks.onEvent(ev('message.delta', { channel: 'thinking', delta: '我在想' }))
    assert.equal(tasks.list()[0].outputTail, '')
  })

  await it('工具轨迹：started 加一条，completed 把结果写回同一条', async () => {
    const { tasks, workers } = makeHarness()
    await tasks.spawn({ title: 'x', goal: 'g', agentId: 'claude' })
    workers[0].hooks.onEvent(ev('item.started', { itemId: 'i1', title: '读文件' }))
    workers[0].hooks.onEvent(ev('item.completed', { itemId: 'i1', status: 'done', text: 'ok' }))
    const t = tasks.list()[0]
    assert.equal(t.toolCalls.length, 1)
    assert.equal(t.toolCalls[0].title, '读文件')
    assert.equal(t.toolCalls[0].status, 'done')
    assert.equal(t.toolCalls[0].text, 'ok')
  })

  await it('授权请求：转成 waiting_input 与一句摘要，不是整份 JSON', async () => {
    const { tasks, workers } = makeHarness()
    await tasks.spawn({ title: 'x', goal: 'g', agentId: 'claude' })
    workers[0].hooks.onPermission(PERM)
    const t = tasks.list()[0]
    assert.equal(t.stage, 'waiting_input')
    assert.equal(t.waitingText, 'edit · 删掉 src/legacy')
    assert.equal(t.pendingPermission?.id, 'p1')
  })

  await it('允许按它给的第一项回，拒绝回 null，两种都把任务带回 working', async () => {
    const { tasks, workers } = makeHarness()
    const t = await tasks.spawn({ title: 'x', goal: 'g', agentId: 'claude' })
    workers[0].hooks.onPermission(PERM)
    assert.equal(tasks.respondPermission(t.id, 'p1', 'allow'), true)
    assert.deepEqual(workers[0].lastDecision, { optionId: 'once' })
    assert.equal(tasks.detail(t.id)?.stage, 'working')
    assert.equal(tasks.detail(t.id)?.waitingText, undefined)

    workers[0].hooks.onPermission({ ...PERM, id: 'p2' })
    assert.equal(tasks.detail(t.id)?.stage, 'waiting_input')
    assert.equal(tasks.respondPermission(t.id, 'p2', 'deny'), true)
    assert.deepEqual(workers[0].lastDecision, { optionId: null })
    assert.equal(tasks.detail(t.id)?.stage, 'working')
  })

  await it('回一个不存在的授权号要失败，不能把别人的请求放过去', async () => {
    const { tasks, workers } = makeHarness()
    const t = await tasks.spawn({ title: 'x', goal: 'g', agentId: 'claude' })
    workers[0].hooks.onPermission(PERM)
    assert.equal(tasks.respondPermission(t.id, '别的号', 'allow'), false)
    assert.equal(workers[0].lastDecision, undefined)
  })

  await it('取消一个任务，不影响别的任务', async () => {
    const { tasks, workers } = makeHarness()
    const a = await tasks.spawn({ title: 'A', goal: 'g', agentId: 'claude' })
    const b = await tasks.spawn({ title: 'B', goal: 'g', agentId: 'codex' })
    workers[0].hooks.onEvent(ev('message.delta', { channel: 'text', delta: 'A 在跑' }))
    workers[1].hooks.onEvent(ev('message.delta', { channel: 'text', delta: 'B 在跑' }))
    tasks.cancel(a.id)
    assert.equal(tasks.detail(a.id)?.stage, 'cancelled')
    assert.equal(tasks.detail(b.id)?.stage, 'working')
    assert.equal(tasks.detail(b.id)?.outputTail, 'B 在跑')
  })

  await it('取消要真的叫停 Worker，而且迟到的事件不许把它复活', async () => {
    const { tasks, workers } = makeHarness()
    const a = await tasks.spawn({ title: 'A', goal: 'g', agentId: 'claude' })
    tasks.cancel(a.id)
    assert.equal(workers[0].stops, 1, '取消必须打到 Worker 的 stop() 上')
    assert.equal(tasks.detail(a.id)?.stage, 'cancelled')
    // 被杀那一家死之前还会吐几条：这些事件到这里时已经收摊，不许把 stage 改回去
    workers[0].hooks.onEvent(ev('turn.completed', {}))
    workers[0].hooks.onEvent(ev('message.delta', { channel: 'text', delta: '还在吐' }))
    workers[0].hooks.onEvent(ev('turn.started', {}))
    assert.equal(tasks.detail(a.id)?.stage, 'cancelled', '迟到的活事件不能把 cancelled 改回 working')
    assert.equal(tasks.detail(a.id)?.outputTail, '', '收摊之后不再追加输出尾巴')
  })

  await it('一轮结束就判 done：不能永远挂在「进行中」', async () => {
    const { tasks, workers } = makeHarness()
    const t = await tasks.spawn({ title: 'A', goal: 'g', agentId: 'claude' })
    workers[0].hooks.onEvent(ev('turn.started', {}))
    workers[0].hooks.onEvent(ev('turn.completed', {}))
    assert.equal(tasks.detail(t.id)?.stage, 'done')
  })

  await it('取消时挂着的授权要一起撤掉，不留一张等人点头的卡', async () => {
    const { tasks, workers } = makeHarness()
    const t = await tasks.spawn({ title: 'A', goal: 'g', agentId: 'claude' })
    workers[0].hooks.onPermission({
      id: 'p1',
      sessionId: 's',
      title: '要写文件',
      toolKind: 'write',
      options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }],
    } as AcpPermissionRequest)
    assert.equal(tasks.detail(t.id)?.stage, 'waiting_input')
    tasks.cancel(t.id)
    const d = tasks.detail(t.id)
    assert.equal(d?.stage, 'cancelled')
    assert.equal(d?.pendingPermission, undefined, '挂起的授权要撤掉')
    assert.equal(d?.waitingText, undefined, '界面上那句「等你点头」也要撤掉')
  })

  await it('崩了要判 failed 并写清原因', async () => {
    const { tasks, workers } = makeHarness()
    const t = await tasks.spawn({ title: 'A', goal: 'g', agentId: 'claude' })
    workers[0].hooks.onEvent(ev('session.faulted', { text: '进程退了' }))
    const d = tasks.detail(t.id)
    assert.equal(d?.stage, 'failed')
    assert.equal(d?.error, '进程退了')
  })

  await it('插话走 prompt，并把轮次记上', async () => {
    const { tasks, workers } = makeHarness()
    const t = await tasks.spawn({ title: 'A', goal: 'g', agentId: 'claude' })
    assert.equal(t.rounds, 0)
    assert.equal((await tasks.intervene(t.id, '先别动那个文件')).ok, true)
    assert.deepEqual(workers[0].prompted, ['g', '先别动那个文件'])
    assert.equal(tasks.detail(t.id)?.rounds, 1)
  })

  await it('插话给一个不存在的任务要失败', async () => {
    const { tasks } = makeHarness()
    assert.equal((await tasks.intervene('没有', 'x')).ok, false)
  })

  await it('任务列表按更新时间排：刚动过的在上面', async () => {
    const { tasks, workers } = makeHarness()
    const a = await tasks.spawn({ title: 'A', goal: 'g', agentId: 'claude' })
    const b = await tasks.spawn({ title: 'B', goal: 'g', agentId: 'codex' })
    await sleep(5)
    workers[1].hooks.onEvent(ev('message.delta', { channel: 'text', delta: 'x' }))
    assert.deepEqual(tasks.list().map((t) => t.id), [b.id, a.id])
  })

  // ---- Router ----
  await it('工具清单就是这六个，多一个少一个都算改动', () => {
    const names = ROUTER_TOOLS.map((t) => (t as { name: string }).name).sort()
    assert.deepEqual(names, ['cancel_task', 'finish', 'intervene', 'list_tasks', 'spawn_task', 'task_output'])
  })

  // ---- 工具声明按 wire 摊开：三家各认各的字段，送错就是 422 ----
  await it('工具清单按 wire 摊开：条数一致，每条都是那三家之一的形状', () => {
    for (const wire of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
      const shaped = shapeTools(wire)
      assert.equal(shaped.length, ROUTER_TOOLS.length, `${wire} 的工具条数要和清单一致`)
      for (const t of shaped) {
        if ('function' in t) {
          assert.equal(t.type, 'function', `${wire} 要带 function 层`)
        } else if ('parameters' in t) {
          assert.equal(t.type, 'function', `${wire} 要带扁平 parameters`)
        } else {
          assert.ok('input_schema' in t, `${wire} 要用 input_schema`)
        }
      }
    }
  })
// ---- 消息历史按 wire 摊开：内部存结构化 calls，出口处摊成各家字段 ----
await it('消息历史按 wire 摊开：tool_call_id / tool_calls / function_call 各归各家', () => {
  const history = [
    { role: 'user' as const, content: '拆活' },
    {
      role: 'assistant' as const,
      content: '我来派一个',
      calls: [{ id: 'c1', name: 'spawn_task', args: { title: 'T', goal: 'G' } }],
    },
    { role: 'tool' as const, content: '已分派「T」', callId: 'c1', name: 'spawn_task' },
  ]
  const cc = shapeMessages('chat-completions', history)
  assert.equal(cc[1].role, 'assistant')
  assert.deepEqual(cc[1].tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'spawn_task', arguments: '{"title":"T","goal":"G"}' } },
  ])
  assert.equal(cc[2].role, 'tool')
  assert.equal(cc[2].tool_call_id, 'c1', 'tool 结果要带 tool_call_id（蛇形）：OpenAI 网关认不到 camelCase 就 422')
  const rs = shapeMessages('responses', history)
  assert.equal(rs[2].type, 'function_call')
  assert.equal(rs[2].call_id, 'c1')
  assert.equal(rs[3].type, 'function_call_output')
  assert.equal(rs[3].call_id, 'c1')
  const ap = shapeMessages('anthropic-messages', history)
  assert.equal(ap[1].content[1].type, 'tool_use')
  assert.equal(ap[2].content[0].type, 'tool_result')
  assert.equal(ap[2].content[0].tool_use_id, 'c1')
})

  await it('chat-completions 的 tool 声明带 function 层：{ type, function: { name, description, parameters } }', () => {
    const [first] = shapeTools('chat-completions')
    assert.equal(first.type, 'function')
    if ('function' in first) {
      assert.equal(first.function.name, 'spawn_task')
      assert.equal(first.function.description.length > 0, true)
      assert.deepEqual(first.function.parameters, ROUTER_TOOLS[0].parameters)
    } else {
      assert.fail('chat-completions 的 tool 声明要带 function 层')
    }
  })

  await it('responses wire：tool 声明是扁平的 { type, name, description, parameters }', () => {
    const [first] = shapeTools('responses')
    assert.equal(first.type, 'function')
    if ('parameters' in first) {
      assert.equal(first.name, 'spawn_task')
      assert.deepEqual(first.parameters, ROUTER_TOOLS[0].parameters)
    } else {
      assert.fail('responses 的 tool 声明要带扁平 parameters')
    }
  })

  await it('anthropic wire：tool 声明用 input_schema，不用 parameters', () => {
    const [first] = shapeTools('anthropic-messages')
    if ('input_schema' in first) {
      assert.equal(first.name, 'spawn_task')
      assert.deepEqual(first.input_schema, ROUTER_TOOLS[0].parameters)
    } else {
      assert.fail('anthropic 的 tool 声明要用 input_schema')
    }
  })

  await it('Router 一轮：spawn_task → list_tasks → finish，工具结果只进历史不进正文', async () => {
    const { tasks } = makeHarness()
    const events: Array<{ kind: string; text?: string; name?: string }> = []
    const router = new SuperRouter({
      model: () => API,
      resolveKey: () => 'k',
      tasks,
      agents: () => [{ id: 'claude', title: 'Claude' }],
      cwdOf: () => '/tmp',
      emit: (e) => events.push({ kind: e.kind, text: e.delta ?? e.text, name: e.name }),
    })

    const turns = [
      // 1: 派活
      [
        chunk({ choices: [{ delta: { content: '我把它拆成一块。', tool_calls: [{ id: 'c1', index: 0, function: { name: 'spawn_task', arguments: '{"title":"写解析器","goal":"解析 CSV"}' } }] } }] }),
        DONE,
      ],
      // 2: 问进度
      [
        chunk({ choices: [{ delta: { tool_calls: [{ id: 'c2', index: 0, function: { name: 'list_tasks', arguments: '{}' } }] } }] }),
        DONE,
      ],
      // 3: 收口
      [
        chunk({ choices: [{ delta: { content: '活已派下去。', tool_calls: [{ id: 'c3', index: 0, function: { name: 'finish', arguments: '{"summary":"已派一个任务"}' } }] } }] }),
        DONE,
      ],
    ]
    let next = 0
    /** 每一轮真正发出去的 messages：配对不变式只能从线上那一份验，不能只看内部历史 */
    const sent: Array<Array<Record<string, unknown>>> = []
    ;(globalThis as { fetch: unknown }).fetch = (async (_url: unknown, init?: { body?: string }) => {
      assert.ok(next < turns.length, '模型要的工具轮次比预期多了')
      sent.push(JSON.parse(String(init?.body ?? '{}')).messages ?? [])
      return sseResponse(turns[next++].join(''))
    }) as unknown as typeof fetch

    await router.handle('帮我把那个 CSV 解析器写了')

    assert.equal(tasks.list().length, 1, 'spawn_task 应该真的派出一个任务')
    assert.equal(tasks.list()[0].title, '写解析器')
    assert.equal(tasks.list()[0].agentId, 'claude', '没填 agent_id 时要用第一家')
    assert.deepEqual(
      events.filter((e) => e.kind === 'text').map((e) => e.text),
      ['我把它拆成一块。', '活已派下去。', '已派一个任务\n'],
      '正文要逐段推给界面',
    )
    assert.deepEqual(
      events.filter((e) => e.kind === 'tool').map((e) => e.name),
      ['spawn_task', 'list_tasks', 'finish'],
    )

    // 前提：这一轮确实转了三趟，第二趟起历史里就带着 tool_calls —— 否则下面那圈
    // 会一次都不进，用例看着过其实是空转。
    assert.equal(sent.length, 3, '三轮请求都要发出去')
    assert.ok(
      sent[1]!.some((m) => (m as { tool_calls?: unknown }).tool_calls),
      '第二轮请求的历史里要带着上一轮的 tool_calls',
    )

    // 必须紧跟同数量、同 id 的 tool 消息 —— 少一条就是
    // 400「An assistant message with 'tool_calls' must be followed by tool messages」。
    for (const [i, msgs] of sent.entries()) {
      for (let k = 0; k < msgs.length; k += 1) {
        const m = msgs[k] as { role?: string; tool_calls?: Array<{ id: string }> }
        if (m.role !== 'assistant' || !m.tool_calls?.length) continue
        const want = m.tool_calls.map((c) => c.id)
        const got = msgs.slice(k + 1, k + 1 + want.length).map((x) => (x as { tool_call_id?: string }).tool_call_id)
        assert.deepEqual(got, want, `第 ${i + 1} 次请求：tool_calls ${want.join(',')} 后面缺了对应的 tool 消息`)
      }
    }
    const final = router.transcript().join('\n')
    assert.match(final, /已派一个任务/, 'finish 的 summary 要进历史，下一次轮次还能看见')
    assert.doesNotMatch(final, /"title"/, '工具结果不进正文，界面只看到转述')
  })

  // 这一轮同时给出 finish 与另一个调用：两个都得回填 tool 结果，
  // 少了另一个就是 400（这正是用户截图里那条错误的形态）。
  await it('一轮里 finish 与别的调用同时出现：每个 tool_call 都要有回音', async () => {
    const { tasks } = makeHarness()
    const router = new SuperRouter({
      model: () => API,
      resolveKey: () => 'k',
      tasks,
      agents: () => [{ id: 'claude', title: 'Claude' }],
      cwdOf: () => '/tmp',
      emit: () => {},
    })
    const sent: Array<Array<{ role?: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>> = []
    const turns = [
      [
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: 'f1', index: 0, function: { name: 'finish', arguments: '{"summary":"收工"}' } },
                  { id: 'l1', index: 1, function: { name: 'list_tasks', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
        DONE,
      ],
      [chunk({ choices: [{ delta: { content: '好。' } }] }), DONE],
      [chunk({ choices: [{ delta: { content: '知道了。' } }] }), DONE],
    ]
    let next = 0
    ;(globalThis as { fetch: unknown }).fetch = (async (_u: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')).messages ?? [])
      // 第一轮 finish 收口后停一次；「再说一句」是第二轮，要再给一份回包
      assert.ok(next < turns.length, '回包比预期要的多了')
      return sseResponse(turns[next++].join(''))
    }) as unknown as typeof fetch

    await router.handle('收工吧')

    assert.equal(next, 1, 'finish 到了就收口，不再进下一轮')
    // 真正的故障面是**下一轮**：收口这一轮的回填要留在历史里，否则
    // 下一次请求就是「tool_calls 后面跟着另一个 assistant」——用户撞的就是这个 400。
    await router.handle('再说一句')
    const last = sent[sent.length - 1]!
    const asst = last.filter((m) => m.role === 'assistant' && m.tool_calls?.length).pop()
    assert.ok(asst, '历史里要留着带 tool_calls 的那一轮')
    const want = asst!.tool_calls!.map((c) => c.id)
    assert.deepEqual(want.slice().sort(), ['f1', 'l1'], '两个调用都要记进历史')
    const tail = last.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
    assert.deepEqual(tail.slice().sort(), ['f1', 'l1'], '每个 tool_call 都要有一条同 id 的 tool 回音')
  })

  await it('叫停：断掉正在等的回包，报「已停下」而不是一条红错误', async () => {
    const { tasks } = makeHarness()
    const events: Array<{ kind: string; text?: string }> = []
    const router = new SuperRouter({
      model: () => API,
      resolveKey: () => 'k',
      tasks,
      agents: () => [{ id: 'claude', title: 'Claude' }],
      cwdOf: () => '/tmp',
      emit: (e) => events.push({ kind: e.kind, text: e.delta ?? e.text }),
    })
    // 永不回包的 fetch：模拟模型卡在那儿一直想
    ;(globalThis as { fetch: unknown }).fetch = ((_u: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })) as unknown as typeof fetch

    const running = router.handle('拆活')
    await sleep(20)
    assert.equal(router.isBusy(), true)
    router.abort()
    await running

    assert.equal(router.isBusy(), false, '叫停之后不能再挂着「忙」')
    const errs = events.filter((e) => e.kind === 'error')
    assert.equal(errs.length, 0, '人叫停不算错误，不摆红字')
    assert.ok(events.some((e) => e.kind === 'status' && /已停下/.test(e.text ?? '')), '要写一行「已停下」')
    assert.ok(events.some((e) => e.kind === 'done'), '界面靠 done 收手')
  })

  await it('叫停时已声明的 tool_call 也要有回音，不留半截历史', async () => {
    // 第一个调用（spawn_task）故意慢：在它执行期间叫停，第二个调用就只留回音、
    // 不真去跑。用 spawnDelayMs 而不是 sleep 猜时序。
    const { tasks } = makeHarness({ spawnDelayMs: 60 })
    const router = new SuperRouter({
      model: () => API,
      resolveKey: () => 'k',
      tasks,
      agents: () => [{ id: 'claude', title: 'Claude' }],
      cwdOf: () => '/tmp',
      emit: () => {},
    })
    let sent: Array<Array<{ role?: string; tool_call_id?: string }>> = []
    ;(globalThis as { fetch: unknown }).fetch = (async (_u: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')).messages ?? [])
      return sseResponse(
        [
          chunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { id: 'a1', index: 0, function: { name: 'spawn_task', arguments: '{"title":"A","goal":"g"}' } },
                    { id: 'a2', index: 1, function: { name: 'list_tasks', arguments: '{}' } },
                  ],
                },
              },
            ],
          }),
          DONE,
        ].join(''),
      )
    }) as unknown as typeof fetch

    const running = router.handle('派活')
    await sleep(20)
    router.abort()
    await running

    const tr = router.transcript()
    assert.ok(tr.some((l) => /tool\(list_tasks\): 已停下，这一步没有执行。/.test(l)), '没执行的调用也要留一条回音')
    assert.ok(tr.some((l) => /tool\(spawn_task\): 已分派/.test(l)), '已经开始执行的那个要跑完')
    assert.equal(sent.length, 1, '叫停之后不再发请求')
  })

  await it('模型直接给正文时不再调工具，这一轮就结束', async () => {
    const { tasks } = makeHarness()
    const events: Array<{ kind: string }> = []
    const router = new SuperRouter({
      model: () => API,
      resolveKey: () => 'k',
      tasks,
      agents: () => [{ id: 'claude', title: 'Claude' }],
      cwdOf: () => '/tmp',
      emit: (e) => events.push({ kind: e.kind }),
    })
    let calls = 0
    ;(globalThis as { fetch: unknown }).fetch = (async () => {
      calls++
      return sseResponse(chunk({ choices: [{ delta: { content: '我直接说了' } }] }) + DONE)
    }) as unknown as typeof fetch

    await router.handle('问个简单的')
    assert.equal(calls, 1, '没有工具调用就不该再问模型')
    assert.equal(tasks.list().length, 0)
    assert.deepEqual(events.map((e) => e.kind), ['text', 'done'])
  })

  await it('没配路由模型时直接说清，不猜一个模型上去', async () => {
    const events: Array<{ kind: string; text?: string }> = []
    const router = new SuperRouter({
      model: () => null,
      resolveKey: () => null,
      tasks: makeHarness().tasks,
      agents: () => [],
      cwdOf: () => '/tmp',
      emit: (e) => events.push({ kind: e.kind, text: e.delta ?? e.text }),
    })
    await router.handle('干活')
    assert.equal(events[0].kind, 'error')
    assert.match(events[0].text ?? '', /路由模型/)
  })

  await it('上游 500 要报 HTTP 状态，不能当空回包', async () => {
    const original = (globalThis as { fetch: unknown }).fetch
    ;(globalThis as { fetch: unknown }).fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    try {
      const events: Array<{ kind: string; text?: string }> = []
      const router = new SuperRouter({
        model: () => API,
        resolveKey: () => 'k',
        tasks: makeHarness().tasks,
        agents: () => [],
        cwdOf: () => '/tmp',
        emit: (e) => events.push({ kind: e.kind, text: e.delta ?? e.text }),
      })
      await router.handle('干活')
      assert.equal(events[0].kind, 'error')
      assert.match(events[0].text ?? '', /500/)
    } finally {
      ;(globalThis as { fetch: unknown }).fetch = original
    }
  })

  await it('缺 Key 时要报清楚，不能拿空串去撞端点', async () => {
    const events: Array<{ kind: string; text?: string }> = []
    const router = new SuperRouter({
      model: () => API,
      resolveKey: () => null,
      tasks: makeHarness().tasks,
      agents: () => [],
      cwdOf: () => '/tmp',
      emit: (e) => events.push({ kind: e.kind, text: e.delta ?? e.text }),
    })
    await router.handle('干活')
    assert.equal(events[0].kind, 'error')
    assert.match(events[0].text ?? '', /凭据/)
  })

  // ---- 三种 wire 的流式解析 ----
  await it('chat-completions：正文 delta 与工具调用分片都要攒齐', async () => {
    const raw = [
      chunk({ choices: [{ delta: { content: '好' } }] }),
      chunk({ choices: [{ delta: { tool_calls: [{ id: 'c1', index: 0, function: { name: 'list_tasks', arguments: '{"tit' } } ] } }] }),
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'le":"x"}' } } ] } }] }),
    ].join('')
    const r = await parseRouterStream(sseResponse(raw), false, 'chat-completions')
    assert.equal(r.text, '好')
    assert.equal(r.calls.length, 1)
    assert.equal(r.calls[0].name, 'list_tasks')
    assert.deepEqual(r.calls[0].args, { title: 'x' })
  })

  await it('responses wire：正文走 output_text.delta，工具调用走 output_item', async () => {
    const raw = [
      chunk({ type: 'response.output_text.delta', delta: '在想' }),
      chunk({ type: 'response.output_item.added', item: { type: 'function_call', name: 'spawn_task', call_id: 'c9' } }),
      chunk({ type: 'response.function_call_arguments.delta', item_id: 'c9', delta: '{"title"' }),
      chunk({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'c9', name: 'spawn_task', arguments: '{"title":"解析"}' },
      }),
    ].join('')
    const r = await parseRouterStream(sseResponse(raw), true, 'responses')
    assert.equal(r.text, '在想')
    assert.equal(r.calls.length, 1)
    assert.equal(r.calls[0].name, 'spawn_task')
    assert.deepEqual(r.calls[0].args, { title: '解析' })
  })

  await it('anthropic wire：text 块与 tool_use 块都要认，入参分片要攒齐', async () => {
    const raw = [
      chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '嗯' } }),
      chunk({ type: 'content_block_stop', index: 0 }),
      chunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'task_output', input: {} } }),
      chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"task_id"' } }),
      chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"tk-1"}' } }),
      chunk({ type: 'content_block_stop', index: 1 }),
      chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      chunk({ type: 'message_stop' }),
    ].join('')
    const r = await parseRouterStream(sseResponse(raw), false, 'anthropic-messages')
    assert.equal(r.text, '嗯')
    assert.equal(r.calls.length, 1)
    assert.equal(r.calls[0].name, 'task_output')
    assert.equal(r.calls[0].id, 't1')
    assert.deepEqual(r.calls[0].args, { task_id: 'tk-1' })
  })

  await it('半个 JSON 与非 JSON 行要跳过，不能把整轮判死', async () => {
    const raw = [
      chunk({ choices: [{ delta: { content: '好' } }] }),
      'data: not json at all\n\n',
      'data: { 半截\n\n',
      chunk({ choices: [{ delta: { content: '，收到' } }] }),
    ].join('')
    const r = await parseRouterStream(sseResponse(raw), false, 'chat-completions')
    assert.equal(r.text, '好，收到')
    assert.equal(r.calls.length, 0)
  })

  await it('同一帧里正文与工具调用一起回来也要认', async () => {
    const raw = chunk({
      choices: [
        {
          delta: {
            content: '派活',
            tool_calls: [{ id: 'c1', index: 0, function: { name: 'finish', arguments: '{"summary":"完事"}' } }],
          },
        },
      ],
    }) + DONE
    const r = await parseRouterStream(sseResponse(raw), false, 'chat-completions')
    assert.equal(r.text, '派活')
    assert.equal(r.calls[0].name, 'finish')
  })

  await it('describePermission：界面只看到一句，看不到整份请求', () => {
    assert.equal(
      describePermission({ id: 'a', sessionId: 's', title: '删文件', toolKind: 'edit', options: [] }),
      'edit · 删文件',
    )
    assert.equal(
      describePermission({ id: 'a', sessionId: 's', title: '删文件', options: [] }),
      '工具 · 删文件',
    )
    assert.equal(
      describePermission({ id: 'a', sessionId: 's', toolKind: 'bash', options: [] }),
      'bash',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
