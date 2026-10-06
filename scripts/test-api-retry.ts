/**
 * ApiAgent 截断重试回归：用一个会「掐流」的本地假端点验证真实代码路径
 *
 * 起因：议事厅里 minimax（走 api.53hk.cn 反代）偶发把 SSE 流提前结束，
 * 只回半截「(」，而旧版 ApiAgent 一次都不重试 —— 助手用 pi SDK（自带重试）却能用。
 * 这里不联网、不花 token，纯用本地 http 复现「第一次掐流、第二次正常」，
 * 断言：① 重试后拿到完整内容；② 每次都写运行期日志；③ 一直掐则如实抛缺席；
 * ④ openai 协议靠 finish_reason/[DONE] 判正常收尾。
 *
 * 运行：npx ts-node -P tsconfig.test.json scripts/test-api-retry.ts
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { ApiAgent, anthropicMessagesUrl } from '../src/main/agents/api-agent'
import { AgentError } from '../src/main/agents/agent'
import { diag } from '../src/main/diagnostics/log'
import type { ApiConfig, TurnContext } from '../src/shared/types'

let pass = 0
let fail = 0
async function it(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${(e as Error).message.split('\n')[0]}`)
  }
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

/** anthropic 正常收尾的一整条流 */
function anthropicFull(text: string): string {
  return (
    sse({ type: 'message_start', message: { id: 'x', usage: { input_tokens: 11, output_tokens: 0 } } }) +
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    sse({ type: 'content_block_stop', index: 0 }) +
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) +
    sse({ type: 'message_stop' })
  )
}

/** 只吐半截就结束（没有 message_stop）—— 复现代理掐流 */
function anthropicTruncated(): string {
  return (
    sse({ type: 'message_start', message: { id: 'x', usage: { input_tokens: 11, output_tokens: 0 } } }) +
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '(' } })
    // 到此 res.end()，流结束但从未 message_stop
  )
}

function openaiFull(text: string): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } })}\n\n` +
    `data: [DONE]\n\n`
  )
}

/** 起一个按脚本逐次应答的假端点，返回 baseUrl / 已收到请求数 / 实际请求路径 */
async function startServer(
  script: Array<(req: http.IncomingMessage) => { status?: number; body: string; contentType?: string }>,
) {
  let hits = 0
  const urls: string[] = []
  const server = http.createServer((req, res) => {
    const step = script[Math.min(hits, script.length - 1)]!
    hits++
    urls.push(req.url ?? '')
    const out = step(req)
    // 默认按事件流回；只有刻意模拟「网关把未匹配路径回成前端页」的用例会改写它
    res.writeHead(out.status ?? 200, { 'Content-Type': out.contentType ?? 'text/event-stream' })
    res.end(out.body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get urls() {
      return urls
    },
    get hits() {
      return hits
    },
    close: () => server.close(),
  }
}

function chatCtx(): TurnContext {
  return {
    sessionId: 'test-api-retry',
    round: 1,
    topic: { title: '', strategy: 'roundtable', attachments: [], createdAt: 0 } as TurnContext['topic'],
    digest: { open: [], explored: [], confirmed: [] } as TurnContext['digest'],
    callout: null,
    maxLenChars: 400,
    chat: { history: [{ role: 'user', content: '说句话' }], system: '测试' },
  }
}

function makeAgent(cfg: Partial<ApiConfig>): ApiAgent {
  const full: ApiConfig = {
    baseUrl: 'http://127.0.0.1:1',
    model: 'test-model',
    apiKeyRef: 'k',
    protocol: 'anthropic',
    pricePerMTokIn: 0,
    pricePerMTokOut: 0,
    maxContextTokens: 128000,
    ...cfg,
  }
  return new ApiAgent('api-test', '测试模型', '#fff', full, () => 'dummy-key')
}

/** 抓 diag 内存环里本次新增的 api-* 记录 */
function apiLogs(): string[] {
  return diag
    .tail(200, { subject: 'api-test' })
    .filter((e) => e.stage === 'api-request' || e.stage === 'api-response')
    .map((e) => `${e.stage}:${e.ok ? 'ok' : 'fail'}:${e.detail ?? ''}`)
}

async function main() {
  console.log('\nApiAgent 截断重试回归\n')

  await it('anthropic：首次掐流 → 重试拿到完整内容', async () => {
    const srv = await startServer([
      () => ({ body: anthropicTruncated() }),
      () => ({ body: anthropicFull('这是一段完整的发言内容。') }),
    ])
    const agent = makeAgent({ baseUrl: srv.baseUrl })
    const res = await agent.send(chatCtx(), () => {})
    srv.close()
    assert.equal(res.content, '这是一段完整的发言内容。')
    assert.equal(srv.hits, 2, '应当重试了一次')
  })

  await it('每次尝试都写运行期日志（api-request / api-response）', async () => {
    const srv = await startServer([
      () => ({ body: anthropicTruncated() }),
      () => ({ body: anthropicFull('好了') }),
    ])
    const agent = makeAgent({ baseUrl: srv.baseUrl })
    await agent.send(chatCtx(), () => {})
    srv.close()
    const logs = apiLogs()
    assert.ok(logs.some((l) => l.startsWith('api-request:ok')), '缺少请求日志')
    assert.ok(logs.some((l) => l.startsWith('api-response:fail') && l.includes('truncated')), '缺少截断日志')
    assert.ok(logs.some((l) => l.startsWith('api-response:ok')), '缺少成功日志')
  })

  await it('一直掐流 → 如实抛 AgentError（不再留下半截 "("）', async () => {
    const srv = await startServer([() => ({ body: anthropicTruncated() })])
    const agent = makeAgent({ baseUrl: srv.baseUrl })
    let threw: unknown = null
    try {
      const r = await agent.send(chatCtx(), () => {})
      threw = new Error(`未抛错，返回了 content=${JSON.stringify(r.content)}`)
    } catch (e) {
      threw = e
    }
    srv.close()
    assert.ok(threw instanceof AgentError, `应抛 AgentError，实为 ${String((threw as Error)?.name)}`)
    assert.ok(srv.hits >= 3, `应重试到上限，实收 ${srv.hits} 次`)
  })

  await it('openai：靠 finish_reason/[DONE] 判正常收尾', async () => {
    const srv = await startServer([() => ({ body: openaiFull('openai 的完整回答。') })])
    const agent = makeAgent({ baseUrl: srv.baseUrl, protocol: 'openai' })
    const res = await agent.send(chatCtx(), () => {})
    srv.close()
    assert.equal(res.content, 'openai 的完整回答。')
    assert.equal(srv.hits, 1, '正常收尾不该重试')
    assert.equal(res.usage.promptTokens, 3)
  })

  await it('鉴权 401：不重试，直接缺席', async () => {
    const srv = await startServer([() => ({ status: 401, body: 'nope' })])
    const agent = makeAgent({ baseUrl: srv.baseUrl })
    let threw: unknown = null
    try {
      await agent.send(chatCtx(), () => {})
    } catch (e) {
      threw = e
    }
    srv.close()
    assert.ok(threw instanceof AgentError, '应抛 AgentError')
    assert.equal(srv.hits, 1, '鉴权失败不应重试')
    assert.match((threw as Error).message, /鉴权/)
  })

  /*
   * 下面三条是 2026-10-07「minimax 议事厅一个字都没说」的回归。
   * 真实配置是 baseUrl=https://api.53hk.cn（不带 /v1）+ protocol=anthropic：
   * 助手（pi SDK）打到 /v1/messages 正常，发言通道打到 /messages 被网关的前端页接走，
   * 于是 HTTP 200 + 一段 HTML → 旧代码只看见「没有 data: 行」，报成上游不稳定并白重试三次。
   */
  await it('anthropic：baseUrl 不带 /v1 也打到 /v1/messages', async () => {
    const srv = await startServer([() => ({ body: anthropicFull('好') })])
    const agent = makeAgent({ baseUrl: srv.baseUrl })
    await agent.send(chatCtx(), () => {})
    srv.close()
    assert.deepEqual(srv.urls, ['/v1/messages'], `实际路径 ${JSON.stringify(srv.urls)}`)
  })

  await it('anthropic：baseUrl 已带 /v1 时不拼成 /v1/v1', async () => {
    const srv = await startServer([() => ({ body: anthropicFull('好') })])
    const agent = makeAgent({ baseUrl: `${srv.baseUrl}/v1` })
    await agent.send(chatCtx(), () => {})
    srv.close()
    assert.deepEqual(srv.urls, ['/v1/messages'], `实际路径 ${JSON.stringify(srv.urls)}`)
    assert.equal(anthropicMessagesUrl('https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1/messages')
  })

  await it('200 但不是流式接口：如实报地址/协议不对，且只发一次', async () => {
    const srv = await startServer([
      () => ({ body: '<!doctype html><html><head><title>53HK 中转站</title></head><body>…</body></html>', contentType: 'text/html; charset=utf-8' }),
    ])
    const agent = makeAgent({ baseUrl: srv.baseUrl })
    let threw: unknown = null
    try {
      await agent.send(chatCtx(), () => {})
    } catch (e) {
      threw = e
    }
    srv.close()
    assert.ok(threw instanceof AgentError, `应抛 AgentError，实为 ${(threw as Error)?.message}`)
    assert.equal(srv.hits, 1, '地址配错了，重试三次只是白等')
    const msg = (threw as Error).message
    assert.match(msg, /不是流式接口/)
    assert.match(msg, /text\/html/, '要把 content-type 原样带出来')
    assert.match(msg, /53HK/, '要把响应开头带出来，否则无从判断')
    assert.doesNotMatch(msg, /不稳定/, '不能再把用户往「上游抖动」的方向带')
  })

  await it('自称事件流却空 body：仍按截断重试（别把上游抖动误判成配置错）', async () => {
    const srv = await startServer([() => ({ body: '' })])
    const agent = makeAgent({ baseUrl: srv.baseUrl })
    let threw: unknown = null
    try {
      await agent.send(chatCtx(), () => {})
    } catch (e) {
      threw = e
    }
    srv.close()
    assert.ok(threw instanceof AgentError)
    assert.match((threw as Error).message, /未正常收尾/)
    assert.equal(srv.hits, 3, '这类才该重试到上限')
  })

  /*
   * 整包（非流式）退路：有些第三方网关收了 stream:true 却照旧回一段 application/json。
   * 这类模型不该因此缺席 —— 只该失去逐字效果。
   */
  await it('200 + OpenAI 整包 JSON：收下并计 usage，只发一次', async () => {
    const deltas: string[] = []
    const srv = await startServer([
      () => ({
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '整包回来的发言。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 21, completion_tokens: 8 },
        }),
      }),
    ])
    const agent = makeAgent({ baseUrl: srv.baseUrl, protocol: 'openai' })
    const res = await agent.send(chatCtx(), (d) => deltas.push(d))
    srv.close()
    assert.equal(res.content, '整包回来的发言。')
    assert.deepEqual(deltas, ['整包回来的发言。'], '整段要作为一次增量交给 UI，否则气泡是空的')
    assert.equal(res.usage.promptTokens, 21)
    assert.equal(res.usage.completionTokens, 8)
    assert.equal(srv.hits, 1, '整包本来就是完整响应，不该重试')
    assert.ok(apiLogs().some((l) => l.includes('whole=1')), '日志要标出这轮走的是整包退路')
  })

  await it('200 + Anthropic 整包 JSON：正文与 thinking 分家', async () => {
    const srv = await startServer([
      () => ({
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'x',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先想想' },
            { type: 'text', text: '结论是这样。' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 30, output_tokens: 12 },
        }),
      }),
    ])
    const agent = makeAgent({ baseUrl: srv.baseUrl })
    const thinks: string[] = []
    const res = await agent.send(chatCtx(), () => {}, (t) => thinks.push(t))
    srv.close()
    assert.equal(res.content, '结论是这样。')
    assert.deepEqual(thinks, ['先想想'])
    assert.equal(res.usage.promptTokens, 30)
    assert.equal(res.usage.completionTokens, 12)
    assert.equal(res.thinking, '先想想', '思维链要单独带上，别混进正文')
  })

  await it('200 + {"error":...}：把上游原话报出来，不重试、不套「不稳定」', async () => {
    const srv = await startServer([
      () => ({ contentType: 'application/json', body: JSON.stringify({ error: { message: 'model not found', type: 'invalid_request_error' } }) }),
    ])
    const agent = makeAgent({ baseUrl: srv.baseUrl })
    let threw: unknown = null
    try {
      await agent.send(chatCtx(), () => {})
    } catch (e) {
      threw = e
    }
    srv.close()
    assert.ok(threw instanceof AgentError, '请求本身写坏了，属硬失败')
    assert.equal(srv.hits, 1)
    assert.match((threw as Error).message, /model not found/)
    assert.match((threw as Error).message, /invalid_request_error/)
    assert.doesNotMatch((threw as Error).message, /不稳定/)
  })

  await it('200 + 整包但内容为空：按「模型返回空内容」重试，而不是报成地址错', async () => {
    const srv = await startServer([
      () => ({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }) }),
    ])
    const agent = makeAgent({ baseUrl: srv.baseUrl, protocol: 'openai' })
    let threw: unknown = null
    try {
      await agent.send(chatCtx(), () => {})
    } catch (e) {
      threw = e
    }
    srv.close()
    assert.ok(threw instanceof AgentError)
    assert.match((threw as Error).message, /空内容/)
    assert.doesNotMatch((threw as Error).message, /不是流式接口/)
    assert.equal(srv.hits, 3, '空内容有可能是上游抖动，留重试机会')
  })

  await it('助手侧与发言侧对 baseUrl 的口径一致（pi 会自己补 /v1/messages）', () => {
    // provider.ts 把 baseUrl 交给 pi 的 Anthropic 客户端，pi 补的是 {base}/v1/messages，
    // 所以它必须先把结尾的 /v1 摘掉 —— 两边不一致就会出现「助手能用、议事厅不能用」。
    const src = readFileSync(path.resolve(__dirname, '../src/main/assistant/provider.ts'), 'utf8')
    assert.match(src, /api: anthropic \? 'anthropic-messages' : 'openai-completions'/)
    assert.match(src, /baseUrl: piBaseUrl\(api\.baseUrl, anthropic\)/)
    assert.ok(src.includes('anthropic ? base.replace'), '摘掉结尾 /v1 的那一步要在')
    for (const b of ['https://api.53hk.cn', 'https://api.53hk.cn/', 'https://api.53hk.cn/v1', 'https://api.53hk.cn/v1/']) {
      const torra = anthropicMessagesUrl(b)
      const pi = `${b.trim().replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/messages`
      assert.equal(torra, pi, `${b} 两条通道打到了不同地址`)
    }
  })

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
