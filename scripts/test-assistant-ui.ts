/**
 * 助手交互视图（torra-ui 围栏协议）静态测试，esbuild + react-dom/server 渲染，不需要 Electron
 *
 * 覆盖：
 * - 解析：合法文档、未知 block 跳过、全未知失败、超长 JSON、超量数据、非有限数字、负数、未闭合围栏
 * - 复制：stripTorraUiBlocks() 只删协议块，不动普通代码块
 * - 安全：内置 block 不插入原始 HTML；html block 只进入严格 sandbox 的 torra-ui: iframe
 * - 结构：AssistantUi.tsx 不含 dangerouslySetInnerHTML / eval / window.torra
 * - 接线：Markdown 只在 ui 存在时替换 pre，AssistantDrawer 传入 ui 并在复制时剥离协议块
 * - 提示词：prompt.ts 已声明协议、数据真实性与审批边界
 * - 样式：aui-* 类在 styles.css 中真实存在且 token 齐全
 *
 * 用法：npm run test:assistant-ui
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    fail++
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${(e as Error).message.split('\n').slice(0, 4).join('\n         ')}`)
  }
}

async function itAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    fail++
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${(e as Error).message.split('\n').slice(0, 4).join('\n         ')}`)
  }
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

type Harness = {
  preload: () => Promise<void>
  render: (text: string) => string
  renderUi: (text: string, streaming?: boolean) => string
  frameUrl: (document: string) => string
  decodeFrameUrl: (url: string) => {
    ok: boolean
    document?: string
    status?: number
    reason?: string
  }
  frameResponse: (url: string) => {
    status: number
    headers: { get: (name: string) => string | null }
    text: () => Promise<string>
  }
  frameCsp: string
  frameMaxBytes: number
}

function loadHarness(): Harness {
  const esbuild = require('esbuild') as typeof import('esbuild')
  const entry = [
    "import React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { Markdown, preloadMarkdown } from './src/renderer/components/Markdown'",
    "import { decodeTorraUiFrameUrl, torraUiFrameResponse, torraUiFrameUrl, TORRA_UI_FRAME_CSP, TORRA_UI_FRAME_MAX_BYTES } from './src/shared/ui-frame'",
    "export function preload(): Promise<void> { return preloadMarkdown() }",
    'const ui = { onAction: (p: string) => { void p } }',
    'export function render(text: string): string {',
    '  return renderToStaticMarkup(React.createElement(Markdown, { text }))',
    '}',
    'export function renderUi(text: string, streaming: boolean): string {',
    '  return renderToStaticMarkup(React.createElement(Markdown, { text, ui, streaming }))',
    '}',
    'export const frameUrl = torraUiFrameUrl',
    'export const decodeFrameUrl = decodeTorraUiFrameUrl',
    'export const frameResponse = torraUiFrameResponse',
    'export const frameCsp = TORRA_UI_FRAME_CSP',
    'export const frameMaxBytes = TORRA_UI_FRAME_MAX_BYTES',
  ].join('\n')
  const result = esbuild.buildSync({
    stdin: { contents: entry, loader: 'ts', resolveDir: ROOT, sourcefile: 'aui-harness.ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    absWorkingDir: ROOT,
    // AssistantUi.tsx 用 @shared/assistant-ui，与 vite 的别名保持一致
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    logLevel: 'silent',
  })
  const code = result.outputFiles[0]?.text
  if (!code) throw new Error('esbuild 没有产出 bundle')
  const m = new Module('aui-harness')
  m.filename = path.join(ROOT, 'scripts', 'aui-harness.js')
  m.paths = (Module as any)._nodeModulePaths(path.dirname(m.filename))
  ;(m as any)._compile(code, m.filename)
  return m.exports as unknown as Harness
}

function doc(extra: string): string {
  return `~~~torra-ui\n${extra}\n~~~`
}

function validDoc(): string {
  return doc(`{
  "version": 1,
  "title": "模型对比",
  "description": "本轮工具返回的三条记录",
  "blocks": [
    { "type": "metrics", "title": "关键指标", "items": [{ "label": "可用模型", "value": "3", "hint": "已配置 Key" }] },
    { "type": "bar", "title": "耗时对比", "items": [{ "label": "模型 A", "value": 1.8, "detail": "秒" }, { "label": "模型 B", "value": 0 }] },
    { "type": "line", "title": "趋势", "points": [{ "label": "周一", "value": 2 }, { "label": "周二", "value": 5 }, { "label": "周三", "value": 3 }] },
    { "type": "donut", "title": "占比", "items": [{ "label": "成功", "value": 7 }, { "label": "失败", "value": 3 }] },
    { "type": "table", "title": "明细", "columns": ["模型", "状态"], "rows": [["A", "可用"], ["B", "可用"]] }
  ],
  "actions": [{ "label": "查看详细诊断", "prompt": "请继续检查这几个模型的连接状态" }]
}`)
}

async function main(): Promise<void> {
  const h = loadHarness()
  // react-markdown 是动态 import，先取到位再比对渲染结果
  await h.preload()

  console.log('\n助手交互视图（torra-ui）测试\n')

  it('解析：合法文档渲染出 aui-* 组件与全部 block 类型', () => {
    const html = h.renderUi(validDoc())
    assert.match(html, /class="md"/, '没有落在 .md 容器里')
    assert.match(html, /aui-shell/, '缺交互视图外壳')
    assert.match(html, /aui-metric-value">3</, 'metrics 没渲染')
    assert.match(html, /aui-bar-fill/, 'bar 没渲染')
    assert.match(html, /aui-line-chart/, 'line 的容器没渲染')
    assert.match(html, /aui-donut-seg/, 'donut 没渲染')
    assert.match(html, /<table class="aui-table"/, 'table 没渲染')
    assert.match(html, /aui-action[^>]*>查看详细诊断/, '动作按钮没渲染')
  })

  it('渲染：未闭合围栏在流式下只显示受控的生成中提示，不泄露 JSON', () => {
    const html = h.renderUi('~~~torra-ui\n{ "version": 1, "blocks": [{ "type": "metrics"', true)
    assert.match(html, /aui-generating/, '流式未完成时应显示生成中提示')
    assert.ok(!html.includes('"version"'), '流式时把原始 JSON 泄露出去了')
  })

  it('渲染：无效协议块在非流式下降级为错误提示，正文不受影响', () => {
    const html = h.renderUi(doc('{ "version": 1, "blocks": [') + '\n\n正文仍然可读')
    assert.match(html, /上面的正文仍可正常阅读/, '无效协议块没有降级提示')
    assert.match(html, /正文仍然可读/, '协议块失败影响了正文')
  })

  it('解析：未知 block 类型被跳过，已知 block 仍渲染', () => {
    const html = h.renderUi(doc(`{
      "version": 1,
      "blocks": [
        { "type": "metrics", "items": [{ "label": "可用模型", "value": "3" }] },
        { "type": "unknown-future", "items": [{ "label": "x", "value": 1 }] }
      ]
    }`))
    assert.match(html, /aui-metric-value">3</, '已知 block 应该照常渲染')
    assert.ok(!html.includes('unknown-future'), '未知 block 的 type 泄露出去了')
  })

  it('解析：全部 block 未知时报错而不是渲染空壳', () => {
    const html = h.renderUi(doc(`{
      "version": 1,
      "blocks": [{ "type": "unknown-future", "items": [{ "label": "x", "value": 1 }] }]
    }`))
    assert.match(html, /上面的正文仍可正常阅读/, '全未知时应该报错')
    assert.ok(!html.includes('aui-blocks'), '全未知时不应渲染成功内容')
  })

  it('解析：超长 JSON 被拒绝', () => {
    const long = JSON.stringify({
      version: 1,
      blocks: [{ type: 'table', columns: ['A'], rows: [['x'.repeat(40 * 1024)]] }],
    })
    const html = h.renderUi(doc(long))
    assert.match(html, /上面的正文仍可正常阅读|超大/, '超长 JSON 应该被拒')
  })

  it('解析：超量数据被拒绝', () => {
    const tooMany = JSON.stringify({
      version: 1,
      blocks: Array.from({ length: 7 }, () => ({
        type: 'metrics',
        items: [{ label: 'L', value: '1' }],
      })),
    })
    assert.match(h.renderUi(doc(tooMany)), /上面的正文仍可正常阅读/, '超过 6 个 blocks 应被拒')

    const tooWide = JSON.stringify({
      version: 1,
      blocks: [
        { type: 'table', columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], rows: [['1', '2', '3', '4', '5', '6', '7']] },
      ],
    })
    assert.match(h.renderUi(doc(tooWide)), /上面的正文仍可正常阅读/, '超过 6 列应被拒')
  })

  it('解析：非有限数字与负数被拒绝', () => {
    for (const bad of ['NaN', 'Infinity', '-Infinity']) {
      const html = h.renderUi(doc(`{ "version": 1, "blocks": [{ "type": "bar", "items": [{ "label": "A", "value": ${bad} }] }] }`))
      assert.match(html, /上面的正文仍可正常阅读/, `${bad} 应被拒`)
    }
    const negative = h.renderUi(doc(`{ "version": 1, "blocks": [{ "type": "bar", "items": [{ "label": "A", "value": -3 }] }] }`))
    assert.match(negative, /上面的正文仍可正常阅读/, '负数应被拒')
  })

  it('解析：结构错误（缺 version / 空 blocks / 坏 JSON）被拒绝', () => {
    const cases = [
      '{ "blocks": [{ "type": "metrics", "items": [{ "label": "a", "value": "1" }] }] }',
      '{ "version": 1, "blocks": [] }',
      '{ "version": 1, "blocks": [{ "type": "metrics", "items": [] }] }',
      '{ "version": 1, "blocks": [{ "type": "line", "points": [{ "label": "a", "value": 1 }] }] }',
      '{ "version": 1, "blocks": [{ "type": "donut", "items": [{ "label": "a", "value": 0 }] }] }',
      'not json at all',
    ]
    for (const raw of cases) {
      const html = h.renderUi(doc(raw))
      assert.match(html, /上面的正文仍可正常阅读/, `应该拒绝：${raw.slice(0, 40)}`)
    }
  })

  it('复制：stripTorraUiBlocks() 只删协议块，普通代码块与正文原样保留', () => {
    const esbuild = require('esbuild') as typeof import('esbuild')
    const entry = [
      "import { stripTorraUiBlocks, hasUnclosedTorraUiFence } from './src/shared/ui-protocol'",
      'export const strip = stripTorraUiBlocks',
      'export const unclosed = hasUnclosedTorraUiFence',
    ].join('\n')
    const result = esbuild.buildSync({
      stdin: { contents: entry, loader: 'ts', resolveDir: ROOT, sourcefile: 'aui-strip.ts' },
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'es2022',
      write: false,
      absWorkingDir: ROOT,
      logLevel: 'silent',
    })
    const m = new Module('aui-strip')
    m.filename = path.join(ROOT, 'scripts', 'aui-strip.js')
    m.paths = (Module as any)._nodeModulePaths(path.dirname(m.filename))
    ;(m as any)._compile(result.outputFiles[0]!.text, m.filename)
    const { strip, unclosed } = m.exports as {
      strip: (s: string) => string
      unclosed: (s: string) => boolean
    }

    const source = [
      '结论先说：三个模型可用。',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      doc('{ "version": 1, "blocks": [{ "type": "metrics", "items": [{ "label": "a", "value": "1" }] }] }'),
      '',
      '补充说明。',
    ].join('\n')
    const out = strip(source)
    assert.ok(!out.includes('torra-ui'), '复制结果里还有协议围栏')
    assert.ok(!out.includes('"version"'), '复制结果里还有协议 JSON')
    assert.ok(out.includes('结论先说：三个模型可用。'), '正文被误删')
    assert.ok(out.includes('补充说明。'), '正文被误删')
    assert.ok(out.includes('```ts'), '普通代码块被误删')
    assert.ok(out.includes('const x = 1'), '普通代码块内容被误删')

    assert.equal(unclosed('~~~torra-ui\n{ "a": 1'), true)
    assert.equal(unclosed('~~~torra-ui\n{ "a": 1 }\n~~~'), false)
  })

  it('安全：SSR 输出无 script/iframe/内联事件，原始 HTML 被转义', () => {
    const evil = doc(JSON.stringify({
      version: 1,
      blocks: [{ type: 'table', columns: ['<img src=x onerror=alert(1)>'], rows: [['<script>alert(2)</script>']] }],
      actions: [{ label: '<svg onload=alert(3)>', prompt: '<a href=javascript:alert(4)>x</a>' }],
    }))
    const html = h.renderUi(evil, false)
    // 只查未转义的真实标签/属性；&lt;img onerror=...&gt; 这种文本是安全的
    assert.ok(!/<script/i.test(html), '渲染结果里出现了未转义的 <script>')
    assert.ok(!/<iframe/i.test(html), '渲染结果里出现了未转义的 <iframe>')
    assert.ok(!/<img/i.test(html), '渲染结果里出现了未转义的 <img>')
    assert.ok(!/<svg\s+onload/i.test(html), '渲染结果里出现了带 onload 的 <svg>')
    assert.ok(!/href="javascript:/i.test(html), '渲染结果里出现了 javascript: 链接')
    assert.ok(!/href='javascript:/i.test(html), '渲染结果里出现了 javascript: 链接')
    // 危险字符串必须被转义成文本节点，而不是变成可执行标签
    assert.ok(html.includes('&lt;script&gt;'), '原始 HTML 没有被转义')
    assert.ok(html.includes('&lt;img'), '原始 HTML 没有被转义')
  })

  it('安全：html 块经沙箱 iframe 输出，src 为 torra-ui: URL 且无 same-origin', () => {
    const evil = doc(JSON.stringify({
      version: 1,
      blocks: [{ type: 'html', title: 'x', html: '<b>hi</b>' }],
    }))
    const html = h.renderUi(evil, false)
    const frame = html.match(/<iframe\b[^>]*>/i)
    assert.ok(frame, 'html 块没有渲染出 iframe')
    assert.match(frame[0], /sandbox="allow-scripts"/, 'iframe 必须只放开 allow-scripts')
    assert.doesNotMatch(
      frame[0],
      /allow-same-origin|allow-forms|allow-popups|allow-top-navigation/,
      'iframe 不能拿到同源、表单提交、弹窗或父页导航权限',
    )
    const src = frame[0].match(/\bsrc="([^"]+)"/)?.[1]
    assert.ok(src, 'iframe 缺少 src')
    assert.match(src, /^torra-ui:\/\/frame\//, 'iframe 只能加载 torra-ui: 文档')
    const decoded = h.decodeFrameUrl(src)
    assert.equal(decoded.ok, true, 'torra-ui: URL 无法解码')
    assert.match(decoded.document ?? '', /<b>hi<\/b>/, 'iframe 文档缺少用户 HTML')
    assert.match(frame[0], /referrerpolicy="no-referrer"/i, 'iframe 必须不外泄 referrer')
  })

  it('渲染：html 块支持自包含 HTML、Canvas、表单与内联脚本', () => {
    const source = [
      '<form>',
      '<label>倍数 <input id="n" type="number" value="2"></label>',
      '<canvas id="c" width="320" height="120"></canvas>',
      '</form>',
      '<script>const c=document.getElementById("c");c.getContext("2d").fillRect(8,8,80,40)</script>',
    ].join('')
    const html = h.renderUi(doc(JSON.stringify({
      version: 1,
      blocks: [{ type: 'html', title: '自定义画布', height: 260, html: source }],
    })), false)
    const frame = html.match(/<iframe\b[^>]*>/i)
    assert.ok(frame, 'html 块没有渲染成 iframe')
    assert.match(frame[0], /style="height:260px"/, '自定义高度没有应用')
    assert.ok(!html.includes('<canvas'), 'html 块不能直接插入父页面 DOM')
    assert.ok(!html.includes('<script>'), 'html 块脚本不能直接插入父页面 DOM')

    const src = frame[0].match(/\bsrc="([^"]+)"/)?.[1]
    assert.ok(src, 'iframe 缺少 src')
    assert.match(src, /^torra-ui:\/\/frame\//, 'iframe src 必须是 torra-ui: 文档')
    const decoded = h.decodeFrameUrl(src)
    assert.equal(decoded.ok, true, 'iframe src 无法解出文档')
    const frameDoc = decoded.document ?? ''
    assert.match(frameDoc, /<form>/, '表单没有进入 iframe 文档')
    assert.match(frameDoc, /<input id="n" type="number"/, '表单控件没有进入 iframe 文档')
    assert.match(frameDoc, /<canvas id="c"/, 'Canvas 没有进入 iframe 文档')
    assert.match(frameDoc, /getContext\("2d"\)/, '内联绘制脚本没有进入 iframe 文档')
    assert.match(frameDoc, /Content-Security-Policy/, 'iframe 文档缺少 CSP')
    assert.match(frameDoc, /default-src 'none'/, 'iframe CSP 必须默认拒绝资源')
    assert.match(frameDoc, /script-src 'unsafe-inline'/, 'iframe CSP 应允许本地内联脚本')
    assert.match(frameDoc, /connect-src 'none'/, 'iframe 必须禁止网络请求')
    assert.match(frameDoc, /form-action 'none'/, 'iframe 必须禁止表单外发')
    assert.match(frameDoc, /base-uri 'none'/, 'iframe 必须禁止 base URL 改写')
    assert.match(frameDoc, /frame-src 'none'/, 'iframe 必须禁止嵌套 frame')
    assert.match(frameDoc, /object-src 'none'/, 'iframe 必须禁止插件对象')
    assert.match(frameDoc, /worker-src 'none'/, 'iframe 必须禁止 worker')
  })

  await itAsync('协议：torra-ui: 响应返回严格 CSP，并拒绝非法与超限文档', async () => {
    const source = '<!doctype html><html><body><canvas></canvas></body></html>'
    const url = h.frameUrl(source)
    const response = h.frameResponse(url)
    assert.equal(response.status, 200, '合法 torra-ui 文档应返回 200')
    assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8', '响应类型不正确')
    assert.equal(response.headers.get('Cache-Control'), 'no-store', '响应不得被缓存')
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer', '响应不得泄露 referrer')
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', '响应缺少 nosniff')
    assert.equal(response.headers.get('Content-Security-Policy'), h.frameCsp, '响应 CSP 与渲染端不一致')
    assert.match(h.frameCsp, /script-src 'unsafe-inline'/, '协议 CSP 必须允许 iframe 自己的内联脚本')
    assert.match(h.frameCsp, /connect-src 'none'/, '协议 CSP 必须禁止联网')
    assert.match(h.frameCsp, /form-action 'none'/, '协议 CSP 必须禁止表单外发')
    assert.match(h.frameCsp, /frame-src 'none'/, '协议 CSP 必须禁止子 frame')
    assert.equal(await response.text(), source, '响应正文与生成的文档不一致')

    assert.equal(h.frameResponse('torra-ui://frame/%').status, 400, '非法 payload 应返回 400')
    assert.equal(h.frameResponse('torra-ui://other/abc').status, 400, '非法 host 应返回 400')
    assert.equal(h.frameResponse('https://frame/abc').status, 400, '非 torra-ui 协议应返回 400')

    const oversized = Buffer.alloc(h.frameMaxBytes + 1, 0x78).toString('base64url')
    assert.equal(h.frameResponse(`torra-ui://frame/${oversized}`).status, 413, '超限文档应返回 413')
  })

  it('解析：html 块拒绝空内容、超长内容与非法高度', () => {
    const cases = [
      { html: '' },
      { html: ' '.repeat(20) },
      { html: 'x'.repeat(128 * 1024 + 1) },
      { html: '<b>x</b>', height: 159 },
      { html: '<b>x</b>', height: 801 },
      { html: '<b>x</b>', height: 200.5 },
      { html: '<b>x</b>', height: '200' },
    ]
    for (const block of cases) {
      const html = h.renderUi(doc(JSON.stringify({
        version: 1,
        blocks: [{ type: 'html', ...block }],
      })))
      assert.match(html, /上面的正文仍可正常阅读/, `非法 html 块应被拒绝：${JSON.stringify(block).slice(0, 80)}`)
    }
  })

  it('安全：父页面只允许 torra-ui: frame，不放宽脚本来源', () => {
    const index = readSrc('src/renderer/index.html')
    assert.match(index, /frame-src torra-ui:/, '父页面 CSP 未允许必要的 torra-ui: iframe')
    assert.match(index, /script-src 'self'(?:;|")/, '父页面脚本来源不应被放宽')
    assert.doesNotMatch(index, /script-src[^";]*'unsafe-inline'/, '父页面不应允许内联脚本')
  })

  it('接线：主进程在 ready 前注册 torra-ui scheme，在 ready 后安装处理器', () => {
    const index = readSrc('src/main/index.ts')
    assert.match(index, /import \{ installTorraUiProtocol, registerTorraUiScheme \} from '\.\/net\/torra-ui-protocol'/)
    const registerAt = index.indexOf('registerTorraUiScheme()')
    const readyAt = index.indexOf('app.whenReady()')
    const installAt = index.indexOf('installTorraUiProtocol()')
    assert.ok(registerAt >= 0, '主进程未注册 torra-ui scheme')
    assert.ok(readyAt >= 0, '主进程缺少 whenReady')
    assert.ok(installAt >= 0, '主进程未安装 torra-ui 协议')
    assert.ok(registerAt < readyAt, 'torra-ui scheme 必须在 ready 前注册')
    assert.ok(installAt > readyAt, 'torra-ui 协议必须在 ready 后安装')

    const protocol = readSrc('src/main/net/torra-ui-protocol.ts')
    assert.match(protocol, /registerSchemesAsPrivileged/, '协议缺少特权 scheme 注册')
    assert.match(protocol, /protocol\.handle\(TORRA_UI_FRAME_SCHEME/, '协议缺少 handler 安装')
    assert.match(protocol, /request\.method !== 'GET'/, '协议应拒绝非 GET 请求')
  })

  it('安全：AssistantUi.tsx 不使用危险渲染路径', () => {
    const src = readSrc('src/renderer/components/AssistantUi.tsx')
    assert.doesNotMatch(src, /dangerouslySetInnerHTML/, '禁止 dangerouslySetInnerHTML')
    assert.doesNotMatch(src, /\beval\s*\(/, '禁止 eval')
    /*
     * html 块是唯一需要执行脚本的 block，承载它的是沙箱 iframe：
     * 不能禁掉 iframe（那就只剩静态图表），但必须钉死它的权限面 ——
     * 无 allow-same-origin（碰不到父页的 storage/cookie）、
     * src 只允许 torra-ui: 文档，不加载任何外部资源。
     */
    const frames = src.match(/<iframe\b[^>]*>/g) ?? []
    for (const frame of frames) {
      assert.match(frame, /sandbox=\{?"allow-scripts"\}?/, 'iframe 必须显式 sandbox 且只放开 allow-scripts')
      assert.doesNotMatch(frame, /allow-same-origin/, 'iframe 禁止 allow-same-origin')
      assert.doesNotMatch(frame, /allow-forms|allow-popups|allow-top-navigation/, 'iframe 禁止表单提交/开新窗/改父页地址')
      assert.match(frame, /src=\{src\}/, 'iframe 必须使用生成的 torra-ui: 文档地址')
    }
    assert.doesNotMatch(src, /window\.torra/, '禁止向 window 挂全局对象')
    assert.doesNotMatch(src, /innerHTML/, '禁止 innerHTML')
  })

  it('结构：协议块只在传入 ui 时替换 pre，普通 Markdown 走原路径', () => {
    const md = readSrc('src/renderer/components/Markdown.tsx')
    assert.match(md, /if \(!ui\) return components/, 'ui 缺失时应回落到原 components')
    assert.match(md, /language-torra-ui/, '缺协议围栏识别')
    assert.match(md, /components=\{uiComponents\}/, 'ReactMarkdown 没用上 uiComponents')
    // 没有 ui 时 torra-ui 围栏必须仍是普通代码块
    const plain = h.render(validDoc())
    assert.ok(!plain.includes('aui-shell'), '没传 ui 时不应渲染交互视图')
    assert.match(plain, /<pre><code class="language-torra-ui">/, '没传 ui 时协议块应保持普通代码块')
  })

  it('接线：AssistantDrawer 传入 ui 并在复制时剥离协议块', () => {
    const src = readSrc('src/renderer/components/AssistantDrawer.tsx')
    assert.match(src, /<Markdown key=\{l\.id\} text=\{l\.text\} ui=\{ui\} streaming=\{live\} \/>/, '回答渲染没传 ui')
    assert.match(src, /stripTorraUiBlocks\(/, '复制回答没有剥离协议块')
    assert.match(src, /const sendTextRef = useRef\(sendText\)/, '动作按钮应复用现有 sendText')
  })

  it('提示词：prompt.ts 声明了协议、数据真实性与审批边界', () => {
    const src = readSrc('src/main/assistant/prompt.ts')
    assert.match(src, /"type": "html"/, 'prompt 缺少 html block 示例')
    assert.match(src, /<canvas id='c'/, 'prompt 缺少 Canvas 示例')
    assert.match(src, /<script>/, 'prompt 缺少内联脚本示例')
    assert.match(src, /160-800/, 'prompt 缺少 html 高度边界')
    assert.match(src, /不能访问父页面/, 'prompt 缺少父页面隔离说明')
    assert.match(src, /line[\s\S]{0,160}points[\s\S]{0,160}items/, 'prompt 未说明 line 使用 points')
    assert.match(src, /## 交互视图/, '缺交互视图章节')
    assert.match(src, /torra-ui/, 'prompt 里没给出围栏名')
    assert.match(src, /禁止编造数值/, '没约束数据真实性')
    assert.match(src, /审批/, '没声明审批边界')
    assert.match(src, /metrics[\s\S]{0,300}bar[\s\S]{0,300}line[\s\S]{0,300}donut[\s\S]{0,300}table/, '没列全 block 类型')
  })

  it('样式：aui-* 类齐全且带窄屏与动效降级', () => {
    const css = readSrc('src/renderer/styles.css')
    const required = [
      'aui-shell', 'aui-state', 'aui-generating', 'aui-spin', 'aui-head', 'aui-kicker',
      'aui-pending', 'aui-title', 'aui-description', 'aui-blocks', 'aui-block', 'aui-block-title',
      'aui-metrics', 'aui-metric', 'aui-metric-label', 'aui-metric-value', 'aui-metric-hint',
      'aui-bars', 'aui-bar-row', 'aui-bar-label', 'aui-bar-track', 'aui-bar-fill', 'aui-bar-value',
      'aui-line-chart', 'aui-line-grid', 'aui-line-area', 'aui-line-path', 'aui-line-dot', 'aui-line-label',
      'aui-donut-wrap', 'aui-donut', 'aui-donut-track', 'aui-donut-seg', 'aui-donut-center',
      'aui-legend', 'aui-legend-row', 'aui-table-wrap', 'aui-table', 'aui-empty',
      'aui-actions', 'aui-action', 'aui-html-frame',
    ]
    assert.match(
      css,
      /\.aui-html-frame\s*\{[^}]*min-height:\s*160px;[^}]*max-height:\s*800px;/,
      'html iframe 缺少 160-800px 高度约束',
    )
    for (const cls of required) {
      assert.ok(new RegExp('\\.' + cls + '(?![A-Za-z0-9_-])').test(css), `.${cls} 缺样式`)
    }
    assert.match(css, /@media \(max-width: 520px\)[\s\S]{0,500}aui-bar-row/, '缺窄抽屉适配')
    assert.match(css, /prefers-reduced-motion[\s\S]{0,400}aui-shell/, '缺动效降级')
  })

  it('脚本：package.json 注册了 test:assistant-ui', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    assert.match(String(pkg.scripts['test:assistant-ui']), /scripts\/test-assistant-ui\.ts/, '缺脚本入口')
  })

  it('兼容模型误用 items 表示 line 数据点', () => {
    const html = h.renderUi(doc(`{
      "version": 1,
      "blocks": [{
        "type": "line",
        "title": "Round timing",
        "items": [
          { "label": "Round 1", "value": 18 },
          { "label": "Round 2", "value": 15 },
          { "label": "Round 3", "value": 16 }
        ]
      }]
    }`))
    assert.match(html, /aui-line-chart/, 'line items alias should render')
    assert.match(html, /Round 1/, 'line items labels should be preserved')
  })

  it('line items 兼容仍要求至少两个合法数据点', () => {
    const cases = [
      '{ "version": 1, "blocks": [{ "type": "line", "items": [{ "label": "A", "value": 1 }] }] }',
      '{ "version": 1, "blocks": [{ "type": "line", "items": [{ "label": "A" }, { "label": "B", "value": 2 }] }] }',
      '{ "version": 1, "blocks": [{ "type": "line", "items": [{ "label": "A", "value": "1" }, { "label": "B", "value": 2 }] }] }',
      '{ "version": 1, "blocks": [{ "type": "line", "items": "not-an-array" }] }',
    ]
    for (const raw of cases) {
      const html = h.renderUi(doc(raw))
      assert.match(html, /上面的正文仍可正常阅读/, `invalid line items should be rejected: ${raw.slice(0, 80)}`)
    }
  })

  console.log(`\n  通过 ${pass} 项，失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

main()
