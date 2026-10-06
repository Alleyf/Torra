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
import type { AddressInfo } from 'node:net'
import { ApiAgent } from '../src/main/agents/api-agent'
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

/** 起一个按脚本逐次应答的假端点，返回 baseUrl 与已收到请求数 */
async function startServer(script: Array<(req: http.IncomingMessage) => { status?: number; body: string }>) {
  let hits = 0
  const server = http.createServer((req, res) => {
    const step = script[Math.min(hits, script.length - 1)]!
    hits++
    const out = step(req)
    res.writeHead(out.status ?? 200, { 'Content-Type': 'text/event-stream' })
    res.end(out.body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
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

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
