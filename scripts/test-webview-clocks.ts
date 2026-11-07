/**
 * 网页通道的两条时钟：`max_wait_s` 量「有没有动静」，3× 才是绝对上限。
 *
 * 为什么必须有这一项：2026-11-06 的现场里，清言·网页 在页面上逐字生成、思考计数器
 * 还在跳，界面却写着「本轮超时未响应」。病因是 `max_wait_s` 被当成「从发出算起的
 * 墙钟」—— 一个还没说完的模型被读成「不会说了」。这种错在源码里看着完全合理
 * （`deadline = t0 + max_wait_s` 是一句人话），只有真的跑一遍轮询循环才分得出来。
 *
 * 所以这里不读源码，直接把 `send()` 的轮询段接到一枚假页面上，按毫秒跑三种局面：
 * - 一直在动、晚于 `max_wait_s` 才出字 → 必须收下（旧写法在这里判死）；
 * - 彻底没动静 → 按停滞判死，措辞点明「没有任何动静」；
 * - 一直在动、永远不出字 → 3× 绝对上限收口，措辞点明「一直有动静」。
 *
 * `max_wait_s` 是秒，所以取最小值 1s：停滞闸 1s、绝对上限 3s，真跑几秒钟。
 *
 * 运行：npm run test:webview-clocks
 */
import assert from 'node:assert/strict'
import { WebviewAgent } from '../src/main/agents/webview-agent'
import { AgentError } from '../src/main/agents/agent'

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    fail++
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${(e as Error).message.split('\n').slice(0, 6).join('\n         ')}`)
  }
}

/**
 * 假页面：`executeJavaScript` 按「问的是哪一支探针」回答。
 *
 * 只实现轮询段真正会调到的六支（done / growth / activity / observe / read / readImages），
 * 其余一律抛 —— 顺手拉起别的页面动作应当当场暴露，而不是悄悄返回 undefined 让循环空转。
 */
function makePage(plan: {
  /** 距最后一次 DOM 变化的毫秒数（页面活性证据） */
  act: () => number
  /** 这一拍回复容器里的正文 */
  text?: (elapsed: number) => string
  /** 站点有没有说「生成完了」 */
  complete?: (elapsed: number) => boolean
}) {
  const t0 = Date.now()
  const elapsed = () => Date.now() - t0
  const view = {
    webContents: {
      getURL: () => 'https://example.chat/',
      executeJavaScript: async (code: string) => {
        const isFull = code.includes('observe(')
        const body = plan.text ? plan.text(elapsed()) : ''
        const complete = plan.complete ? plan.complete(elapsed()) : false
        if (isFull) {
          return {
            complete,
            method: 'stop_button_hidden',
            act: plan.act(),
            text: body,
            reasoning: '',
            steps: '',
            imgs: [],
            obs: { visibility: 'visible', inputPresent: true },
          }
        }
        if (code.includes('growth(')) {
          // 正文长过 = 有动静；这里只报「末尾节点字符数」，与真实现同口径
          return { complete, method: 'stop_button_hidden', act: plan.act(), nodes: body ? 1 : 0, chars: body.length }
        }
        throw new Error(`假页面没实现这一支：${code.slice(0, 60)}`)
      },
    },
  }
  return { view, elapsed }
}

function makeAgent(view: unknown) {
  const spec = {
    entry: 'https://example.chat/',
    selectors: { input: '#i', stream: '.a', send: '#s' },
    completion: { mode: 'stop_button_hidden', stable_ms: 2500 },
    automation: { typing_delay_ms: [0, 0] as [number, number], pre_send_pause_ms: [0, 0] as [number, number], max_wait_s: 1, jitter: false },
    health_probe: '#i',
    verified_at: '2026-11-06',
  }
  const pool = {
    markSuspended: () => undefined,
    setBusy: () => undefined,
    get: () => view,
    ensure: () => {
      throw new Error('不该为这一轮重建实例')
    },
    waitReady: async () => undefined,
  }
  const agent = Object.create(WebviewAgent.prototype) as Record<string, unknown>
  Object.assign(agent, {
    id: 'web_a',
    displayName: '示例站',
    transport: 'webview',
    status: 'ready',
    partition: 'persist:torra-web_a',
    adapter: { spec, lastError: undefined },
    pool,
    // 投递段与本次判据无关（键入/按发送/附件），换成一张收据，轮询段照跑真的
    deliverTurn: async () => ({
      view,
      prompt: '这一轮想说的话',
      sendRes: { ok: true, accepted: true, streamCount: 0, streamBaselineText: '' },
      reasoningBase: -1,
      stepsBase: -1,
    }),
  })
  return agent as unknown as WebviewAgent
}

const CTX = {
  sessionId: 'sess_clocks',
  round: 1,
  topic: { title: '议题', background: '' },
  digest: { consensus_points: [], open_disputes: [], summary: '' },
  callout: null,
  maxLenChars: 1200,
} as never

async function main(): Promise<void> {
  console.log('==============================================')
  console.log('  webview 通道：停滞预算 vs 绝对上限')
  console.log('==============================================')

  await it('页面一直在动、晚于 max_wait_s 才出字：这一轮必须收下', async () => {
    /*
     * 旧写法在这一条上必红：`deadline = turnT0 + max_wait_s*1000`，1s 一到就抛
     * 「超过 max_wait_s 未完成」，而这里正文在 1.4s 才出现。
     */
    const page = makePage({
      act: () => 0,
      text: (ms) => (ms >= 1400 ? '它一直在写，只是写得慢' : ''),
      complete: (ms) => ms >= 1400,
    })
    const agent = makeAgent(page.view)
    const t0 = Date.now()
    const res = await agent.send(CTX, () => undefined, undefined, undefined, () => undefined)
    assert.match(res.content, /一直在写/, `正文没收下：${res.content}`)
    assert.ok(Date.now() - t0 >= 1000, '这条用例本身要真的跨过 max_wait_s，否则量不到那条旧死线')
  })

  await it('彻底没动静：按停滞判死，措辞点明「没有任何动静」', async () => {
    const page = makePage({ act: () => 60_000 })
    const agent = makeAgent(page.view)
    const t0 = Date.now()
    await assert.rejects(
      () => agent.send(CTX, () => undefined, undefined, undefined, () => undefined),
      (e: unknown) => {
        assert.ok(e instanceof AgentError, `抛出的不是 AgentError：${String(e)}`)
        assert.equal(e.reason, 'timeout')
        assert.match(e.message, /没有任何动静/, `措辞没点明是「没动静」：${e.message}`)
        return true
      },
    )
    const ms = Date.now() - t0
    assert.ok(ms >= 900 && ms < 2_500, `停滞闸没在 max_wait_s 附近收口：${ms}ms`)
  })

  await it('一直在动、永远不出字：3× 绝对上限收口，且与停滞那条分得开', async () => {
    const page = makePage({ act: () => 0 })
    const agent = makeAgent(page.view)
    const t0 = Date.now()
    await assert.rejects(
      () => agent.send(CTX, () => undefined, undefined, undefined, () => undefined),
      (e: unknown) => {
        assert.ok(e instanceof AgentError, `抛出的不是 AgentError：${String(e)}`)
        assert.equal(e.reason, 'timeout')
        assert.match(e.message, /一直有动静/, `没把「页面一直在动」说清：${e.message}`)
        assert.doesNotMatch(e.message, /没有任何动静/, '两种病因的措辞串了')
        return true
      },
    )
    const ms = Date.now() - t0
    assert.ok(ms >= 2_700, `绝对上限提前收口了：${ms}ms（停滞闸 1s 不该先到）`)
  })

  console.log(`\n通过 ${pass} · 失败 ${fail}`)
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
