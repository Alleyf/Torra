/**
 * 翻译层自测：提示词口径 + 分批 + 主进程客户端的真实请求路径
 *
 * 分三段：
 * - 纯函数：提示词拼装、术语解析、思维链剥离（不联网）
 * - 分批：超长输入按自然段切开，边界不丢字
 * - 客户端：打本地假端点，验证请求体字段（enable_thinking=false 等）与失败归类
 *
 * 运行：npm run test:translate
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  DEFAULT_TRANSLATE_MODEL,
  LANG_NAMES,
  DISCUSSION_TRANSLATION_INSTRUCTION,
  buildImageTranslatePrompt,
  buildTranslatePrompt,
  parseGlossaryTerms,
  shouldTranslateDiscussionSpeech,
  stripThink,
} from '../src/shared/translate'
import { splitForTranslate } from '../src/main/translate/index-translate'

let pass = 0
let fail = 0
async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${(e as Error).message.split('\n')[0]}`)
  }
}

/** 起一个假端点：记录收到的请求体，按脚本回响应 */
async function startServer(
  reply: (body: Record<string, unknown>) => { status?: number; body: string; contentType?: string },
) {
  const received: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = { __raw: raw }
      }
      received.push(body)
      const out = reply(body)
      res.writeHead(out.status ?? 200, { 'Content-Type': out.contentType ?? 'application/json' })
      res.end(out.body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}/v1`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

async function main(): Promise<void> {
  console.log('\n\x1b[1m翻译层 · 提示词口径\x1b[0m')

  await it('无约束时用最简提示词（与官方 build_prompt 一致）', () => {
    const r = buildTranslatePrompt({ text: '今天天气真好。', target: 'en' })
    assert.equal(r.error, undefined)
    assert.equal(
      r.prompt,
      '请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n今天天气真好。',
    )
  })

  await it('指定源语言时提示词带上源语言名', () => {
    const r = buildTranslatePrompt({ text: 'hello', target: 'zh', source: 'en' })
    assert.equal(r.prompt, '请将以下英语文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\nhello')
  })

  await it('未知目标语言被拒，不发出请求', () => {
    const r = buildTranslatePrompt({ text: 'x', target: 'klingon' })
    assert.ok(r.error)
    assert.equal(r.prompt, '')
  })

  await it('术语对照进【硬性要求】，自由指令进【注意】', () => {
    const r = buildTranslatePrompt({
      text: '碳纤维的好处就是它抗裂缝。',
      target: 'en',
      glossary: '碳纤维:carbon fiber, 抗裂缝→crack resistance',
      instruction: '语气正式',
    })
    assert.ok(r.prompt.includes('【硬性要求】专名/术语对照: 碳纤维→carbon fiber、抗裂缝→crack resistance'))
    assert.ok(r.prompt.includes('【注意】语气正式'))
    assert.ok(r.prompt.endsWith('只输出译文，不要有任何额外说明。'))
  })

  await it('JSON 输入 + JSON 约束 → 追加保持 JSON 结构的收尾句', () => {
    const r = buildTranslatePrompt({
      text: '{"title": "用户协议"}',
      target: 'en',
      instruction: '严格保留合法 JSON 语法格式，仅翻译 value 文本',
    })
    assert.ok(r.prompt.includes('请以相同的 JSON 格式输出翻译结果，key 保持不变'))
  })

  await it('术语解析支持三种分隔符，坏行被忽略', () => {
    assert.deepEqual(parseGlossaryTerms('a->b, c:d, e→f'), ['a→b', 'c→d', 'e→f'])
    assert.deepEqual(parseGlossaryTerms('a：b，c:d'), ['a→b', 'c→d'])
    assert.deepEqual(parseGlossaryTerms('garbage'), [])
  })

  await it('图片提示词对齐官方 --image 分支', () => {
    const r = buildImageTranslatePrompt({ target: 'en' })
    assert.equal(r.error, undefined)
    assert.equal(r.prompt, '请将图片中的文本翻译为英语，直接输出翻译结果，不要进行任何解释。')
  })

  await it('图片提示词带上参考文本、指令与术语', () => {
    const r = buildImageTranslatePrompt({
      target: 'zh',
      source: 'en',
      text: '只看图表标题',
      instruction: '保持换行',
      glossary: '碳纤维:carbon fiber',
    })
    assert.ok(r.prompt.includes('请将图片中的英语文本翻译为中文'))
    assert.ok(r.prompt.includes('【参考文本/关注内容】\n只看图表标题'))
    assert.ok(r.prompt.includes('【指令要求】保持换行'))
    assert.ok(r.prompt.includes('【术语对照】碳纤维→carbon fiber'))
    assert.ok(r.prompt.endsWith('只输出翻译结果，不要进行任何解释。'))
  })

  await it('图片提示词对未知目标语言同样报错', () => {
    assert.ok(buildImageTranslatePrompt({ target: 'klingon' }).error)
  })
  await it('思维链残留被剥掉', () => {
    assert.equal(stripThink('<think>想了很久</think>译文'), '译文')
    assert.equal(stripThink('<think>直接就是译文'), '直接就是译文')
    assert.equal(stripThink('  译文  '), '译文')
  })

  await it('语言表覆盖官方 LANG_NAMES 的全部代码', () => {
    for (const code of ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'ukr_cyrl', 'bul_cyrl']) {
      assert.ok(LANG_NAMES[code], `缺语言 ${code}`)
    }
  })

  await it('detects Latin-dominant discussion speech for inline Chinese translation', () => {
    assert.equal(
      shouldTranslateDiscussionSpeech(
        'The council should keep the current rollout plan because the evidence is still incomplete and the risks are not yet understood.',
      ),
      true,
    )
    assert.equal(shouldTranslateDiscussionSpeech('Short answer.'), false)
    assert.equal(
      shouldTranslateDiscussionSpeech(
        '这是一段中文论证，虽然引用了 API、JSON 和 Markdown 这些术语，但主体仍然是中文，不应自动翻译。',
      ),
      false,
    )
    assert.equal(
      shouldTranslateDiscussionSpeech(
        '```ts\nconst council = buildCouncil({ rounds: 3, models: 5 })\nconsole.log(council)\n```',
      ),
      false,
    )
  })

  await it('keeps Markdown and code intact in the inline translation prompt', () => {
    const r = buildTranslatePrompt({
      text: '## Decision\n\nKeep `retryMode` unchanged.',
      target: 'zh',
      instruction: DISCUSSION_TRANSLATION_INSTRUCTION,
    })
    assert.ok(r.prompt.includes('Markdown'))
    assert.ok(r.prompt.includes('代码块、行内代码、公式、URL、文件路径和模型名保持原样'))
  })

  console.log('\n\x1b[1m翻译层 · 分批\x1b[0m')

  await it('短文本原样成一块', () => {
    assert.deepEqual(splitForTranslate('abc', 10), ['abc'])
  })

  await it('超长文本按自然段切，且内容一字不丢', () => {
    const para = 'x'.repeat(40)
    const text = `${para}\n\n${para}\n\n${para}`
    const parts = splitForTranslate(text, 100)
    assert.ok(parts.length > 1, '应当切成多块')
    assert.equal(parts.join('\n\n'), text)
  })

  await it('没有空行的一坨长文本也不会丢字', () => {
    const text = 'y'.repeat(500)
    const parts = splitForTranslate(text, 100)
    assert.equal(parts.join(''), text)
  })

  console.log('\n\x1b[1m翻译层 · 客户端请求\x1b[0m')

  const prevBase = process.env.INDEX_TRANSLATE_BASE
  try {
    const srv = await startServer(() => ({
      body: JSON.stringify({
        choices: [{ message: { content: 'The weather is great today.' } }],
      }),
    }))
    process.env.INDEX_TRANSLATE_BASE = srv.base
    const { translateText } = await import('../src/main/translate/index-translate')

    await it('请求体带对字段：model / stream=false / enable_thinking=false', async () => {
      const r = await translateText({ text: '今天天气真好。', target: 'en' })
      assert.equal(r.ok, true, r.reason)
      assert.equal(r.text, 'The weather is great today.')
      const body = srv.received[0]!
      assert.equal(body.model, DEFAULT_TRANSLATE_MODEL)
      assert.equal(body.stream, false)
      assert.equal(body.temperature, 0)
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
    })

    await it('空文本不发出请求', async () => {
      const before = srv.received.length
      const r = await translateText({ text: '   ', target: 'en' })
      assert.equal(r.ok, false)
      assert.equal(srv.received.length, before)
    })

    await it('未知目标语言被拒，不发出请求', async () => {
      const before = srv.received.length
      const r = await translateText({ text: 'x', target: 'klingon' })
      assert.equal(r.ok, false)
      assert.equal(srv.received.length, before)
    })

    await it('带图片时走多模态 image_url，不带图时仍是纯文本', async () => {
      const before = srv.received.length
      const r = await translateText({
        text: '',
        target: 'zh',
        image: { name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      })
      assert.equal(r.ok, true, r.reason)
      const content = (srv.received[before]!.messages as Array<{ content: unknown }>)[0]!.content
      assert.ok(Array.isArray(content), '图片请求的 content 应是数组')
      const parts = content as Array<Record<string, unknown>>
      assert.equal(parts[0]!.type, 'text')
      assert.ok(String(parts[0]!.text).includes('图片中的文本翻译为中文'))
      assert.equal(parts[1]!.type, 'image_url')
    })

    await it('非法图片 data URL 直接拒，不发请求', async () => {
      const before = srv.received.length
      const r = await translateText({
        text: 'hello',
        target: 'zh',
        image: { name: 'x.png', mime: 'image/png', dataUrl: 'file:///etc/passwd' },
      })
      assert.equal(r.ok, false)
      assert.equal(srv.received.length, before)
    })

    await it('既没有文本也没有图片时不消耗请求', async () => {
      const before = srv.received.length
      const r = await translateText({ text: '', target: 'zh' })
      assert.equal(r.ok, false)
      assert.equal(srv.received.length, before)
    })
    await it('超长原文直接拒，不拆成几十次串行请求', async () => {
      const before = srv.received.length
      const r = await translateText({ text: 'x'.repeat(200_001), target: 'en' })
      assert.equal(r.ok, false)
      assert.ok(r.reason?.includes('200,000'), r.reason)
      assert.equal(srv.received.length, before)
    })

    await it('指令与术语过长时拒，不发请求', async () => {
      const before = srv.received.length
      const long = 'x'.repeat(8_001)
      assert.equal((await translateText({ text: 'hi', target: 'zh', instruction: long })).ok, false)
      assert.equal((await translateText({ text: 'hi', target: 'zh', glossary: long })).ok, false)
      assert.equal(srv.received.length, before)
    })

    await it('图片参考文本不超过单批上限', async () => {
      const before = srv.received.length
      const r = await translateText({
        text: 'y'.repeat(12_001),
        target: 'zh',
        image: { name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      })
      assert.equal(r.ok, false)
      assert.ok(r.reason?.includes('12,000'), r.reason)
      assert.equal(srv.received.length, before)
    })

    await it('不在白名单里的图片 mime 在主进程被拒', async () => {
      const before = srv.received.length
      const r = await translateText({
        text: 'hi',
        target: 'zh',
        image: { name: 'a.svg', mime: 'image/svg+xml', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      })
      assert.equal(r.ok, false)
      assert.equal(srv.received.length, before)
    })
    await srv.close()
  } finally {
    if (prevBase === undefined) delete process.env.INDEX_TRANSLATE_BASE
    else process.env.INDEX_TRANSLATE_BASE = prevBase
  }

  const errSrv = await startServer(() => ({
    status: 500,
    body: 'upstream exploded',
    contentType: 'text/plain',
  }))
  try {
    process.env.INDEX_TRANSLATE_BASE = errSrv.base
    const { translateText } = await import('../src/main/translate/index-translate')
    await it('上游 5xx 归类成一句人话并带原文', async () => {
      const r = await translateText({ text: 'hello', target: 'zh' })
      assert.equal(r.ok, false)
      assert.ok(r.reason?.includes('500'), r.reason)
      assert.ok(r.detail?.includes('upstream exploded'), r.detail)
    })
  } finally {
    delete process.env.INDEX_TRANSLATE_BASE
    await errSrv.close()
  }

  const gwSrv = await startServer(() => ({
    status: 504,
    body: '<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>openresty</center></body></html>',
    contentType: 'text/html',
  }))
  try {
    process.env.INDEX_TRANSLATE_BASE = gwSrv.base
    const { translateText } = await import('../src/main/translate/index-translate')
    await it('504 网关超时转成人话，不把 HTML 页原样串给用户', async () => {
      const r = await translateText({
        text: 'x',
        target: 'zh',
        image: { name: 'huge.png', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      })
      assert.equal(r.ok, false)
      assert.ok(!r.reason?.includes('504'), `不应直接报错误码：${r.reason}`)
      assert.ok(r.reason?.includes('端点算不完'), r.reason)
      assert.ok(!r.detail?.includes('<html>'), '详情里不应转恋原始 HTML 页')
      assert.ok(!r.reason?.includes('<'), '原因里不应转恋原始 HTML 页')
      assert.ok(r.detail?.includes('缩小'), r.detail)
    })
  } finally {
    delete process.env.INDEX_TRANSLATE_BASE
    await gwSrv.close()
  }
  console.log(`\n通过 ${pass} · 失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
