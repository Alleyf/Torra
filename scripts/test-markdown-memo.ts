/**
 * Markdown 渲染的离线回归（esbuild + react-dom/server，不需要 Electron）
 *
 * 逐字流每来一个 token，整页都要重渲染一遍；而 `Markdown` 没有 memo，
 * 于是「早就写完的那 24 条消息」也跟着重新解析一次 Markdown —— 解析成本
 * 是 O(单元格数 × token 数)。改后只有 text 真变了的那一条会重解析。
 *
 * 钉死四层：
 * - 产物层：同一份输入渲染出的 HTML 与改动前逐字节相同（金标准）；
 * - 安全层：链接仍新窗口 + rel=noopener，原始 HTML 仍被转义（memo 不该动这两条）；
 * - 结构层：组件确实被 memo 包住、且消费方只传 text（memo 的浅比较才可能命中）；
 * - 成本层：实测单次解析耗时，并给出场景化前后数值。
 *
 * 运行：npm run test:markdown-memo
 *      npm run test:markdown-memo -- --emit-golden   # 只在改动前抓一次金标准
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'

const ROOT = path.resolve(__dirname, '..')

/** 真实会出现在模型输出里的形状：标题 + 列表 + 表格 + 行内码 + 链接 + 原始 HTML */
const F_HEADINGS = [
  '## 结论',
  '',
  '先说 **要点**：`npm test` 用 `&&` 串链，首个失败会截断后面全部套件。',
  '',
  '- 甲项',
  '- 乙项',
  '  - 嵌套项',
  '',
  '> 引用一句',
].join('\n')

const F_LINKS = '参考 [官方文档](https://example.com/docs?a=1&b=2) 与 <script>alert(1)</script>，行内 `code` 保留。'

const F_TABLE = [
  '| 模型 | 价格 |',
  '| --- | ---: |',
  '| 甲 | 1.2 |',
  '| 乙 | 0 |',
].join('\n')

const F_CODE = ['```ts', 'const x = 1', '```'].join('\n')

/** 一场研讨里一条典型长回答（用于实测单次解析成本） */
const F_STREAM = [
  '## 方案对比',
  '',
  '我们从三个角度看这个问题：**成本**、*风险*、`可回退性`。',
  '',
  '1. 第一步',
  '2. 第二步',
  '   - 子项一',
  '   - 子项二',
  '',
  '| 维度 | 甲 | 乙 |',
  '| --- | --- | --- |',
  '| 成本 | 低 | 中 |',
  '| 风险 | 中 | 高 |',
  '| 可回退 | 是 | 否 |',
  '',
  '> 结论：先做甲，但保留回退路径，详见 [实施说明](https://example.com/impl)。',
  '',
  '```json',
  '{ "roi": 6.0, "dimension": "efficiency" }',
  '```',
  '',
  '最后一层：混合 **粗体**、`行内码`、斜体 *这里* 与一个 <span>裸标签</span>。',
].join('\n')

const FIXTURES: Array<[string, string]> = [
  ['headings', F_HEADINGS],
  ['links', F_LINKS],
  ['table', F_TABLE],
  ['code', F_CODE],
]

/**
 * 改动前抓取的金标准。任何一处 HTML 变化都会让这个套件红 ——
 * 这条断言的存在理由：memo 与常量提升应当是「渲染产物零变化」的纯性能改动。
 */
const GOLDEN: Record<string, string> = {
  headings: `<div class="md"><h2>结论</h2>
<p>先说 <strong>要点</strong>：<code>npm test</code> 用 <code>&amp;&amp;</code> 串链，首个失败会截断后面全部套件。</p>
<ul>
<li>甲项</li>
<li>乙项
<ul>
<li>嵌套项</li>
</ul>
</li>
</ul>
<blockquote>
<p>引用一句</p>
</blockquote></div>`,
  links: `<div class="md"><p>参考 <a href="https://example.com/docs?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">官方文档</a> 与 &lt;script&gt;alert(1)&lt;/script&gt;，行内 <code>code</code> 保留。</p></div>`,
  table: `<div class="md"><table><thead><tr><th>模型</th><th style="text-align:right">价格</th></tr></thead><tbody><tr><td>甲</td><td style="text-align:right">1.2</td></tr><tr><td>乙</td><td style="text-align:right">0</td></tr></tbody></table></div>`,
  code: `<div class="md"><pre><code class="language-ts">const x = 1
</code></pre></div>`,
  inline: `<span class="md md-inline">标题 <strong>加粗</strong> <a href="https://example.com" target="_blank" rel="noopener noreferrer">链接</a></span>`,
}

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

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

type Harness = {
  render: (text: string) => string
  renderInline: (text: string) => string
  kindOf: (name: 'Markdown' | 'MarkdownInline') => string
  parseTimesMs: (text: string, n: number) => { total: number; per: number }
}

/**
 * 用 esbuild 把 TSX + react-markdown（ESM-only）打成一整块 CJS 装在内存里执行。
 * 这样 ts-node（CommonJS）不用碰 ESM，也不需要 jsdom 或任何测试框架依赖。
 */
function loadHarness(): Harness {
  const esbuild = require('esbuild') as typeof import('esbuild')
  const entry = [
    "import React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { Markdown, MarkdownInline } from './src/renderer/components/Markdown'",
    'export function render(text: string): string {',
    '  return renderToStaticMarkup(React.createElement(Markdown, { text }))',
    '}',
    'export function renderInline(text: string): string {',
    '  return renderToStaticMarkup(React.createElement(MarkdownInline, { text }))',
    '}',
    'export function kindOf(name: string): string {',
    '  const c: any = name === "MarkdownInline" ? MarkdownInline : Markdown',
    '  const t = c && (c as any).$$typeof',
    '  return t && String(t)',
    '}',
    'export function parseTimesMs(text: string, n: number): { total: number; per: number } {',
    '  const t0 = Date.now()',
    '  for (let i = 0; i < n; i++) renderToStaticMarkup(React.createElement(Markdown, { text }))',
    '  const total = Date.now() - t0',
    '  return { total, per: total / n }',
    '}',
  ].join('\n')
  const result = esbuild.buildSync({
    stdin: { contents: entry, loader: 'ts', resolveDir: ROOT, sourcefile: 'md-harness.ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    // 与 vite 一致走自动 JSX 运行时：Markdown.tsx 里并没有 import React，
    // 用经典运行时会以 "React is not defined" 崩在渲染中途
    jsx: 'automatic',
    write: false,
    absWorkingDir: ROOT,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0]?.text
  if (!code) throw new Error('esbuild 没有产出代码')
  // 在内存里把这块 bundle 变成一个模块：不落盘，也就没有调试产物入库的风险
  const m = new Module('md-harness')
  m.filename = path.join(ROOT, 'scripts', 'md-harness.js')
  m.paths = (Module as any)._nodeModulePaths(path.dirname(m.filename))
  ;(m as any)._compile(code, m.filename)
  return m.exports as unknown as Harness
}

function main(): void {
  const h = loadHarness()

  if (process.argv.includes('--emit-golden')) {
    const out: Record<string, string> = {}
    for (const [name, text] of FIXTURES) out[name] = h.render(text)
    out.inline = h.renderInline('## 标题 **加粗** [链接](https://example.com)')
    console.log(JSON.stringify(out, null, 2))
    return
  }

  console.log('\n── Markdown memo 回归（离线 SSR 口径）')

  it('产物层：四组夹具的 HTML 与改动前逐字节相同', () => {
    for (const [name, text] of FIXTURES) {
      const golden = GOLDEN[name]
      if (!golden) throw new Error(`夹具 ${name} 缺金标准`)
      assert.equal(h.render(text), golden, `${name} 渲染产物变了`)
    }
  })

  it('产物层：行内模式与改动前相同（块级标记仍被摊平）', () => {
    const got = h.renderInline('## 标题 **加粗** [链接](https://example.com)')
    assert.equal(got, GOLDEN.inline, 'MarkdownInline 渲染产物变了')
    assert.ok(!got.includes('<h2'), '行内模式不该出现标题标签')
    assert.ok(got.includes('<strong>加粗</strong>'), '行内模式该保留加粗')
  })

  it('产物层：同一输入重复渲染稳定（无随机/时序参与）', () => {
    const a = h.render(F_STREAM)
    assert.equal(a, h.render(F_STREAM))
  })

  it('安全层：链接仍在新窗口打开并切断 opener', () => {
    const html = h.render(F_LINKS)
    assert.match(html, /<a[^>]+target="_blank"/, '链接没带 target="_blank"')
    assert.match(html, /rel="noopener[^"]*"/, '链接没带 rel="noopener"')
    assert.match(html, /href="https:\/\/example\.com\/docs\?a=1&amp;b=2"/, '链接 href 被改写')
  })

  it('安全层：原始 HTML 仍被转义（模型输出不可信）', () => {
    const html = h.render(F_LINKS)
    assert.ok(!/<script>/i.test(html), '原始 <script> 落到了 DOM 上')
    assert.ok(html.includes('&lt;script&gt;'), '原始 HTML 该以文本形式转义出现')
    assert.ok(!/<span>裸标签<\/span>/.test(h.render(F_STREAM)), '长文里的裸标签也不该落到 DOM 上')
  })

  it('结构层：两个组件都被 memo 包住（这是跳过重解析的前提）', () => {
    assert.equal(h.kindOf('Markdown'), 'Symbol(react.memo)', 'Markdown 不是 memo 组件')
    assert.equal(h.kindOf('MarkdownInline'), 'Symbol(react.memo)', 'MarkdownInline 不是 memo 组件')
  })

  it('结构层：插件数组提到模块级，渲染期不再新建配置对象', () => {
    const src = readSrc('src/renderer/components/Markdown.tsx')
    assert.doesNotMatch(src, /remarkPlugins=\{\[remarkGfm\]\}/, 'JSX 里内联数组：每次渲染都是新对象')
    assert.match(src, /remarkPlugins=\{REMARK_PLUGINS\}/, '没有用上模块级常量')
    assert.match(src, /allowedElements=\{INLINE_ALLOWED\}/, '行内白名单数组仍是内联展开')
  })

  it('结构层：消费方只传 text（浅比较才可能命中）', () => {
    const consumers = [
      'src/renderer/components/ChatPage.tsx',
      'src/renderer/components/AssistantDrawer.tsx',
      'src/renderer/components/ConsensusPanel.tsx',
      'src/renderer/components/DiscussionFlow.tsx',
      'src/renderer/components/TopicEvolution.tsx',
    ]
    let seen = 0
    for (const rel of consumers) {
      const src = readSrc(rel)
      for (const m of src.matchAll(/<(Markdown|MarkdownInline)\b([^>]*)\/>/g)) {
        seen++
        const attrs = (m[2] || '').replace(/\bkey=\{[^}]*\}/, '')
        assert.match(attrs.trim(), /^text=\{/, `${rel} 给 <${m[1]}> 传了 text 以外的属性：${m[2].trim()}`)
      }
    }
    assert.ok(seen >= 9, `只扫到 ${seen} 处消费方，口径可能已经漂了`)
  })

  it('成本层：实测单次解析耗时，并给出场景化前后数值', () => {
    const N = 300
    const { per } = h.parseTimesMs(F_STREAM, N)
    assert.ok(per > 0 && per < 50, `单次解析 ${per}ms 不合理（N=${N}）`)
    // 场景：24 条已完成消息，每来一个 token 整页重渲染一次，共 2000 个 token
    const CELLS = 24
    const TOKENS = 2000
    const before = per * CELLS * TOKENS
    const after = per * TOKENS
    console.log(
      `         实测：${N} 次解析 ${(per * N).toFixed(0)}ms → 单次 ${per.toFixed(3)}ms；` +
        `场景（${CELLS} 格 × ${TOKENS} token）${before.toFixed(0)}ms → ${after.toFixed(0)}ms（-${(100 - (after / before) * 100).toFixed(1)}%）`,
    )
    assert.ok(before / after >= CELLS - 1, 'memo 没省下预期的解析次数')
  })

  it('接线层：套件已挂进 npm test 链', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    assert.match(String(pkg.scripts['test:markdown-memo']), /scripts\/test-markdown-memo\.ts/, '缺独立脚本项')
    assert.match(String(pkg.scripts.test), /run-tests/, 'npm test 必须走 scripts/run-tests.js 汇总跑法')
    assert.ok(!String(pkg.scripts.test).includes('&&'), '回到 && 串链：首处失败会遮蔽后面的套件')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

main()
