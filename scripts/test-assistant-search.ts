/**
 * 在线搜索服务的离线回归（假 fetch，不联网、不需要 Electron）
 *
 * 守住的四类失败，全都属于「不报错但后果很严重」：
 * - 密钥泄漏：Key 进了日志、异常信息或返回给模型的正文，等于进了对话记录；
 * - 凭记忆补造：搜索失败时工具层不报错，模型就会拿训练数据糊弄用户；
 * - 开关失效：用户关了搜索，工具却照样发请求（花钱 + 越权）；
 * - 脏数据进上下文：非 HTTP(S) 链接、重复链接、超长字段直接把上下文打满。
 *
 * 运行：npm run test:assistant-search
 */

import assert from 'node:assert/strict'
import {
  SEARCH_KEY_REF,
  SEARCH_PREFS_DEFAULT,
  isSearchProvider,
  type AssistantSearchProvider,
} from '../src/shared/assistant'
import { runWebSearch, testWebSearch, type WebSearchDeps } from '../src/main/assistant/web-search'

/** 一个看起来像真 Key 的串：任何用例里它都不该出现在输出、日志或异常里 */
const KEY = 'tvly-SECRET-KEY-DO-NOT-LEAK'

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

interface Recorded {
  url: string
  init: RequestInit
  body: unknown
  logs: Array<{ provider: string; ok: boolean; count: number }>
}

/** 假 fetch：记录请求，按队列依次返回预设响应 */
function fakeFetch(
  handler: (url: string, init: RequestInit, body: unknown) => Response | Promise<Response>,
  sink: { logs: Recorded['logs'] } = { logs: [] },
) {
  const rec: Omit<Recorded, 'body'> & { body?: unknown } = { url: '', init: {}, logs: sink.logs }
  const fn = (async (url: string, init: RequestInit = {}) => {
    let body: unknown
    try {
      body = init.body ? JSON.parse(String(init.body)) : undefined
    } catch {
      body = undefined
    }
    rec.url = url
    rec.init = init
    rec.body = body
    return handler(url, init, body)
  }) as unknown as typeof fetch
  return { fn, rec: rec as Recorded }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 组装 deps：默认 Tavily + 已开 + 已配 Key */
function deps(
  over: Partial<WebSearchDeps> = {},
  sink: { logs: Recorded['logs'] } = { logs: [] },
): WebSearchDeps {
  return {
    getKey: () => KEY,
    getPrefs: () => ({ enabled: true, provider: 'tavily' }),
    log: (e) => sink.logs.push(e),
    ...over,
  }
}

/**
 * 组装带假 fetch 的 deps。
 *
 * 漏传 fetch 就会打到真网络上：失败路径全变成真网络错误，用例看似通过其实什么都没验证，
 * 所以统一从这里注入。
 */
function depsWith(
  f: { fn: typeof fetch },
  over: Partial<WebSearchDeps> = {},
  sink: { logs: Recorded['logs'] } = { logs: [] },
): WebSearchDeps {
  return deps({ fetch: f.fn, ...over }, sink)
}

const TAVILY_OK = {
  results: [
    { title: 'Torra 0.6.4 发布', url: 'https://example.com/a', content: '新增在线搜索。', published_date: '2026-10-20T00:00:00Z' },
    { title: '第二条', url: 'https://example.com/b', content: '内容 B' },
  ],
}

async function main(): Promise<void> {
  console.log('\n在线搜索回归\n' + '='.repeat(46))

  // ---------------------------------------------------------------- 开关与密钥

  await it('默认关闭：不发任何请求，明确说要去设置页开', async () => {
    const f = fakeFetch(() => jsonResponse(TAVILY_OK))
    const r = await runWebSearch(depsWith(f, { getPrefs: () => ({ ...SEARCH_PREFS_DEFAULT }) }, { logs: f.rec.logs }), { query: 'x' })
    assert.equal(r.ok, false)
    assert.match(r.reason!, /在线搜索未开启/)
    assert.equal(f.rec.url, '')
  })

  await it('Tavily 没配 Key：明确说缺 Key，不发请求', async () => {
    const f = fakeFetch(() => jsonResponse(TAVILY_OK))
    const r = await runWebSearch(depsWith(f, { getKey: () => null }), { query: 'x' })
    assert.equal(r.ok, false)
    assert.match(r.reason!, /API Key/)
    assert.equal(f.rec.url, '')
    assert.doesNotMatch(JSON.stringify(r), /SECRET/)
  })

  await it('AnySearch 匿名可用：不带 Authorization 头也能发请求', async () => {
    const f = fakeFetch(() =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify([{ title: 'A', url: 'https://a.cn', snippet: 's' }]) }] },
      }),
    )
    const r = await runWebSearch(depsWith(f, { getPrefs: () => ({ enabled: true, provider: 'anysearch' }), getKey: () => null }), { query: '量子计算' })
    assert.equal(r.ok, true)
    assert.equal(r.hits.length, 1)
    const headers = f.rec.init.headers as Record<string, string>
    assert.ok(!('Authorization' in headers), '匿名调用不该带 Authorization')
  })

  await it('AnySearch 配了 Key：带 Bearer 头', async () => {
    const f = fakeFetch(() =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify([{ title: 'A', url: 'https://a.cn', snippet: 's' }]) }] },
      }),
    )
    const r = await runWebSearch(depsWith(f, { getPrefs: () => ({ enabled: true, provider: 'anysearch' }) }), { query: 'x' })
    assert.equal(r.ok, true)
    const headers = f.rec.init.headers as Record<string, string>
    assert.equal(headers.Authorization, `Bearer ${KEY}`)
  })

  // ---------------------------------------------------------------- 请求形态

  await it('Tavily 请求：URL / Bearer / body 字段都对', async () => {
    const f = fakeFetch(() => jsonResponse(TAVILY_OK))
    const r = await runWebSearch(depsWith(f), { query: 'Torra 新版本', maxResults: 3 })
    assert.equal(r.ok, true)
    assert.equal(f.rec.url, 'https://api.tavily.com/search')
    const headers = f.rec.init.headers as Record<string, string>
    assert.equal(headers.Authorization, `Bearer ${KEY}`)
    assert.equal(headers['Content-Type'], 'application/json')
    assert.equal(f.rec.init.method, 'POST')
    assert.deepEqual(f.rec.body, { query: 'Torra 新版本', max_results: 3, search_depth: 'basic' })
  })

  await it('AnySearch 请求：JSON-RPC tools/call，参数含 query 与 max_results', async () => {
    const f = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '[]' }] } }))
    await runWebSearch(depsWith(f, { getPrefs: () => ({ enabled: true, provider: 'anysearch' }) }), { query: 'q', maxResults: 2 })
    assert.equal(f.rec.url, 'https://api.anysearch.com/mcp')
    const body = f.rec.body as Record<string, unknown>
    assert.equal(body.jsonrpc, '2.0')
    assert.equal(body.method, 'tools/call')
    const params = body.params as Record<string, unknown>
    assert.equal(params.name, 'search')
    assert.deepEqual(params.arguments, { query: 'q', max_results: 2, freshness: 'week' })
  })

  await it('数量夹紧：0 -> 1，99 -> 8，非数字 -> 默认 5', async () => {
    const f = fakeFetch(() => jsonResponse(TAVILY_OK))
    const r1 = await runWebSearch(depsWith(f), { query: 'x', maxResults: 0 })
    assert.equal(r1.ok, true)
    assert.equal((f.rec.body as { max_results: number }).max_results, 1)
    const r2 = await runWebSearch(depsWith(f), { query: 'x', maxResults: 99 })
    assert.equal(r2.ok, true)
    assert.equal((f.rec.body as { max_results: number }).max_results, 8)
    const r3 = await runWebSearch(depsWith(f), { query: 'x', maxResults: Number.NaN })
    assert.equal(r3.ok, true)
    assert.equal((f.rec.body as { max_results: number }).max_results, 5)
  })

  await it('query 为空或超长：直接拒绝，不发请求', async () => {
    const f = fakeFetch(() => jsonResponse(TAVILY_OK))
    const r1 = await runWebSearch(depsWith(f), { query: '   ' })
    assert.equal(r1.ok, false)
    assert.match(r1.reason!, /为空/)
    const r2 = await runWebSearch(depsWith(f), { query: 'x'.repeat(501) })
    assert.equal(r2.ok, false)
    assert.match(r2.reason!, /过长/)
    assert.equal(f.rec.url, '')
  })

  // ---------------------------------------------------------------- 失败路径

  await it('超时：报「超时」而不是把底层 abort 原文带给用户', async () => {
    const f = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const r = await runWebSearch(depsWith(f), { query: 'x' })
    assert.equal(r.ok, false)
    assert.match(r.reason!, /超时/)
    assert.doesNotMatch(r.reason!, /abort/i)
  })

  await it('非 2xx：报 HTTP 状态，不带 Key', async () => {
    const f = fakeFetch(() => jsonResponse({ detail: 'unauthorized' }, 401))
    const r = await runWebSearch(depsWith(f), { query: 'x' })
    assert.equal(r.ok, false)
    assert.match(r.reason!, /401/)
    assert.doesNotMatch(JSON.stringify(r), /SECRET/)
  })

  await it('非法 JSON：报解析失败', async () => {
    const f = fakeFetch(() => new Response('<html>nope', { status: 200 }))
    const r = await runWebSearch(depsWith(f), { query: 'x' })
    assert.equal(r.ok, false)
    assert.match(r.reason!, /JSON/)
  })

  await it('AnySearch 返回 json.error：把 message 翻成中文说明', async () => {
    const f = fakeFetch(() => jsonResponse({ jsonrpc: '2.0', id: 1, error: { message: 'quota exceeded' } }))
    const r = await runWebSearch(depsWith(f, { getPrefs: () => ({ enabled: true, provider: 'anysearch' }) }), { query: 'x' })
    assert.equal(r.ok, false)
    assert.match(r.reason!, /quota exceeded/)
  })

  await it('空结果：不算成功，明确说没搜到', async () => {
    const f = fakeFetch(() => jsonResponse({ results: [] }))
    const r = await runWebSearch(depsWith(f), { query: '不存在的词 xyz' })
    assert.equal(r.ok, false)
    assert.equal(r.hits.length, 0)
    assert.match(r.reason!, /没有返回可用结果/)
  })

  await it('结果里没有任何可用 URL：同样算没搜到', async () => {
    const f = fakeFetch(() => jsonResponse({ results: [{ title: '无链接', content: 'x' }, { title: '坏协议', url: 'ftp://a' }] }))
    const r = await runWebSearch(depsWith(f), { query: 'x' })
    assert.equal(r.ok, false)
    assert.equal(r.hits.length, 0)
  })

  // ---------------------------------------------------------------- 数据清洗

  await it('非 HTTP(S) URL 丢弃、重复 URL 去重', async () => {
    const f = fakeFetch(() =>
      jsonResponse({
        results: [
          { title: 'A', url: 'https://a.cn/1', content: 'a' },
          { title: 'javascript', url: 'javascript:alert(1)', content: 'x' },
          { title: '重复', url: 'https://a.cn/1', content: 'dup' },
          { title: 'B', url: 'HTTPS://B.CN/2', content: 'b' },
          { title: '无协议', url: 'example.com/c', content: 'c' },
        ],
      }),
    )
    const r = await runWebSearch(depsWith(f), { query: 'x' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.hits.map((h) => h.url), ['https://a.cn/1', 'https://b.cn/2'])
  })

  await it('字段截断：超长标题/摘要不会撑爆上下文', async () => {
    const f = fakeFetch(() =>
      jsonResponse({
        results: [{ title: 'T'.repeat(5000), url: 'https://a.cn', content: 'C'.repeat(9000) }],
      }),
    )
    const r = await runWebSearch(depsWith(f), { query: 'x' })
    assert.equal(r.ok, true)
    assert.ok(r.hits[0]!.title.length <= 200, `标题 ${r.hits[0]!.title.length} 字符`)
    assert.ok(r.hits[0]!.snippet.length <= 600, `摘要 ${r.hits[0]!.snippet.length} 字符`)
  })

  await it('发布日期归一成 ISO；解析不了的保留原文', async () => {
    const f = fakeFetch(() =>
      jsonResponse({
        results: [
          { title: 'A', url: 'https://a.cn/1', content: 'a', published_date: '2026-10-20T08:00:00+08:00' },
          { title: 'B', url: 'https://b.cn/2', content: 'b', published_date: '三天前' },
        ],
      }),
    )
    const r = await runWebSearch(depsWith(f), { query: 'x' })
    assert.equal(r.hits[0]!.published, '2026-10-20T00:00:00.000Z')
    assert.equal(r.hits[1]!.published, '三天前')
  })

  await it('AnySearch 的 result.content 文本是 JSON 字符串时会再解析一层', async () => {
    const f = fakeFetch(() =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                results: [
                  { title: 'X', url: 'https://x.cn', snippet: 'xs' },
                  { title: 'Y', link: 'https://y.cn', summary: 'ys' },
                ],
              }),
            },
          ],
        },
      }),
    )
    const r = await runWebSearch(depsWith(f, { getPrefs: () => ({ enabled: true, provider: 'anysearch' }) }), { query: 'x' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.hits.map((h) => h.url), ['https://x.cn', 'https://y.cn'])
    assert.equal(r.hits[1]!.snippet, 'ys')
  })

  await it('AnySearch 返回非 JSON 正文：抽出里面的链接当结果，没有链接就算没搜到', async () => {
    // 纯文本里没有可引用的 URL，就不能当作一条结果塞给模型 ——
    // 模型只能引用结果里的链接，没有链接的摘要等于逼它凭记忆编造。
    const noUrl = fakeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '# 摘要\n这里是纯文本。' }] } }),
    )
    const r0 = await runWebSearch(depsWith(noUrl, { getPrefs: () => ({ enabled: true, provider: 'anysearch' }) }), { query: 'x' })
    assert.equal(r0.ok, false)
    assert.equal(r0.hits.length, 0)

    const f = fakeFetch(() =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: '# 摘要\n参见 https://doc.cn/a 与 https://doc.cn/b，这里是纯文本。' }] },
      }),
    )
    const r = await runWebSearch(depsWith(f, { getPrefs: () => ({ enabled: true, provider: 'anysearch' }) }), { query: 'x' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.hits.map((h) => h.url), ['https://doc.cn/a', 'https://doc.cn/b'])
    assert.match(r.hits[0]!.snippet, /纯文本/)
  })

  // ---------------------------------------------------------------- 泄漏与日志

  await it('Key 不出现在结果、reason、日志里', async () => {
    const sink = { logs: [] as Recorded['logs'] }
    const f = fakeFetch(() => jsonResponse(TAVILY_OK), sink)
    const r = await runWebSearch(depsWith(f, { log: (e) => sink.logs.push(e) }, sink), { query: 'Torra 密钥测试 SECRET-KEY-DO-NOT-LEAK' })
    assert.equal(r.ok, true)
    assert.doesNotMatch(JSON.stringify(r), /SECRET-KEY-DO-NOT-LEAK/)
    assert.doesNotMatch(JSON.stringify(sink.logs), /SECRET-KEY-DO-NOT-LEAK/)
    assert.doesNotMatch(JSON.stringify(sink.logs), /tvly-/)
  })

  await it('日志只记 Provider / 成败 / 条数，不记 query', async () => {
    const sink = { logs: [] as Recorded['logs'] }
    const f = fakeFetch(() => jsonResponse(TAVILY_OK), sink)
    await runWebSearch(depsWith(f, { log: (e) => sink.logs.push(e) }, sink), { query: '一句很特别的查询词' })
    assert.deepEqual(sink.logs, [{ provider: 'tavily', ok: true, count: 2 }])
    assert.doesNotMatch(JSON.stringify(sink.logs), /很特别/)
  })

  await it('失败也落日志（count=0）', async () => {
    const sink = { logs: [] as Recorded['logs'] }
    const f = fakeFetch(() => jsonResponse({ results: [] }), sink)
    await runWebSearch(depsWith(f, { log: (e) => sink.logs.push(e) }, sink), { query: 'x' })
    assert.deepEqual(sink.logs, [{ provider: 'tavily', ok: false, count: 0 }])
  })

  // ---------------------------------------------------------------- 测试入口

  await it('testWebSearch：成功时回首条标题与耗时，失败时回原因', async () => {
    const okF = fakeFetch(() => jsonResponse(TAVILY_OK))
    const ok = await testWebSearch(depsWith(okF), 'tavily')
    assert.equal(ok.ok, true)
    assert.equal(ok.provider, 'tavily')
    assert.equal(ok.count, 2)
    assert.equal(ok.first, 'Torra 0.6.4 发布')
    assert.ok(typeof ok.ms === 'number')

    const f = fakeFetch(() => jsonResponse({}, 500))
    const bad = await testWebSearch(depsWith(f), 'tavily')
    assert.equal(bad.ok, false)
    assert.equal(bad.count, 0)
    assert.ok(bad.reason)
    assert.doesNotMatch(JSON.stringify(bad), /SECRET/)
  })

  await it('testWebSearch：开关关着时也要给出「去设置页开启」', async () => {
    const f = fakeFetch(() => jsonResponse(TAVILY_OK))
    const r = await testWebSearch(depsWith(f, { getPrefs: () => ({ ...SEARCH_PREFS_DEFAULT }) }), 'tavily')
    assert.equal(r.ok, false)
    assert.match(r.reason!, /在线搜索未开启/)
  })

  // ---------------------------------------------------------------- 契约自洽

  await it('共享契约：Provider 白名单、默认值、钥匙串 ref 都对得上', () => {
    assert.equal(SEARCH_PREFS_DEFAULT.enabled, false)
    assert.equal(SEARCH_PREFS_DEFAULT.provider, 'tavily')
    assert.equal(isSearchProvider('tavily'), true)
    assert.equal(isSearchProvider('bing'), false)
    assert.equal(isSearchProvider(42), false)
    for (const p of ['tavily', 'anysearch'] as AssistantSearchProvider[]) {
      assert.match(SEARCH_KEY_REF[p], /^assistant:search:[a-z]+$/)
    }
  })

  console.log(`${'-'.repeat(46)}\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
