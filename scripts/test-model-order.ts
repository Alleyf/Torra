/**
 * 模型顺序与启停的离线回归（纯函数 + esbuild SSR，不需要 Electron）
 *
 * 第 10 轮把「排序 / 停用」从侧栏独有补成设置页也能做。风险不在新代码，
 * 而在两处各算一遍顺序：拖动用 splice、按钮用另一种写法，就会长出
 * 「拖完再点箭头，顺序跳到第三个地方」这种只有用户能看见的错。
 *
 * 钉死四层：
 * - 纯函数层：moveBefore / moveStep 的语义、边界钳制、往返稳定、永不破坏原数组；
 * - 口径层：侧栏与设置页都必须经由这两个函数，不许再出现第三份 splice；
 * - 接线层：App 的既有 handler 真的接到了设置页，新组件不自己碰 IPC；
 * - 产物层：SSR 出来的行序、禁用态、停用标记与类名前缀符合既定样式约定。
 *
 * 运行：npm run test:model-order
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

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 只搬 nextTick 之前算得清的东西：这里全部是同步纯函数 */
import { moveBefore, moveStep } from '../src/renderer/modelOrder'

const BASE = ['a', 'b', 'c', 'd']
const isPerm = (xs: string[]) => xs.length === BASE.length && [...xs].sort().join() === BASE.slice().sort().join()

type Harness = {
  renderSection: (models: Array<Partial<{ id: string; displayName: string; transport: string; color: string; enabled: boolean }>>) => string
}

/**
 * 用 esbuild 把组件打成一整块 CJS 在内存里执行（与 test-markdown-memo 同一口径）：
 * ts-node 走 CommonJS，不必为一次渲染引入 jsdom 或测试框架。
 */
function loadHarness(): Harness {
  const esbuild = require('esbuild') as typeof import('esbuild')
  const entry = [
    "import React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { ModelManageSection } from './src/renderer/components/ModelManageSection'",
    'export function renderSection(models) {',
    '  return renderToStaticMarkup(React.createElement(ModelManageSection, {',
    '    models,',
    '    onReorder: () => {},',
    '    onToggleEnabled: () => {},',
    '  }))',
    '}',
  ].join('\n')
  const result = esbuild.buildSync({
    stdin: { contents: entry, loader: 'ts', resolveDir: ROOT, sourcefile: 'model-order-harness.ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    absWorkingDir: ROOT,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0]?.text
  if (!code) throw new Error('esbuild 没有产出代码')
  const m = new Module('model-order-harness')
  m.filename = path.join(ROOT, 'scripts', 'model-order-harness.js')
  m.paths = (Module as any)._nodeModulePaths(path.dirname(m.filename))
  ;(m as any)._compile(code, m.filename)
  return m.exports as unknown as Harness
}

function main(): void {
  console.log('\n── 模型顺序与启停（纯函数 + SSR 口径）')

  it('moveBefore：落在目标之前', () => {
    assert.deepEqual(moveBefore(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c'])
    assert.deepEqual(moveBefore(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'a', 'c', 'd'])
    // 拖动语义如实保留：把 a 放到紧跟着它的 b 之前 = 还在原地（所以侧栏相邻互拖不该跳位）
    assert.deepEqual(moveBefore(['a', 'b', 'c', 'd'], 'a', 'b'), ['a', 'b', 'c', 'd'])
  })

  it('moveBefore：目标不在列表里追加到末尾（与侧栏拖到空白处一致）', () => {
    assert.deepEqual(moveBefore(['a', 'b', 'c'], 'c', 'zzz'), ['a', 'b', 'c'])
    assert.deepEqual(moveBefore(['a', 'b', 'c'], 'x', 'a'), ['x', 'a', 'b', 'c'])
  })

  it('moveBefore：原地拖动等价于不变，且返回的是新数组', () => {
    const src = ['a', 'b', 'c']
    const out = moveBefore(src, 'b', 'b')
    assert.deepEqual(out, src)
    assert.notEqual(out, src, '不该把原数组交出去')
    out.push('z')
    assert.equal(src.length, 3, '改返回值不该影响入参')
  })

  it('moveBefore：绝不改动入参', () => {
    const src = ['a', 'b', 'c', 'd']
    moveBefore(src, 'd', 'a')
    moveBefore(src, 'a', 'd')
    assert.deepEqual(src, ['a', 'b', 'c', 'd'])
  })

  it('moveStep：相邻交换 + 往返稳定', () => {
    // 下移到紧邻的下一位必须真的换位：这一步若写成「插到下一位之前」就是原地不动
    assert.deepEqual(moveStep(BASE, 'a', 1), ['b', 'a', 'c', 'd'])
    const next = moveStep(BASE, 'b', 1)
    assert.deepEqual(next, ['a', 'c', 'b', 'd'])
    assert.deepEqual(moveStep(next, 'b', -1), BASE, '下一步再上一步该回到原样')
    assert.deepEqual(moveStep(BASE, 'c', -1), ['a', 'c', 'b', 'd'])
  })

  it('moveStep：重复 id 也只搬那一位（不靠 filter 全量摘除）', () => {
    assert.deepEqual(moveStep(['a', 'b', 'a', 'c'], 'a', 1), ['b', 'a', 'a', 'c'])
    assert.equal(moveStep(['a', 'b', 'a', 'c'], 'a', 1).length, 4)
  })

  it('moveStep：贴边钳制（首位上移、末位下移都不动）', () => {
    assert.deepEqual(moveStep(BASE, 'a', -1), BASE)
    assert.deepEqual(moveStep(BASE, 'd', 1), BASE)
    assert.deepEqual(moveStep([], 'a', 1), [])
    assert.deepEqual(moveStep(['only'], 'only', -1), ['only'])
  })

  it('moveStep：不认识的 id 原样返回（不凭空插入幽灵条目）', () => {
    assert.deepEqual(moveStep(BASE, 'ghost', 1), BASE)
    assert.deepEqual(moveStep(BASE, 'ghost', -1), BASE)
  })

  it('不变量：全枚举 4×4×2，结果永远是同集合的置换，且位置只挪一格', () => {
    let moved = 0
    let clamped = 0
    for (const id of BASE) {
      for (const delta of [-1, 1] as const) {
        const out = moveStep(BASE, id, delta)
        assert.ok(isPerm(out), `${id}/${delta} 结果不是置换：${out}`)
        const before = BASE.indexOf(id)
        const after = out.indexOf(id)
        if (after === before) {
          clamped++
          assert.ok(before === 0 ? delta === -1 : before === BASE.length - 1 ? delta === 1 : false, `${id}/${delta} 不该原地不动`)
        } else {
          moved++
          assert.equal(Math.abs(after - before), 1, `${id}/${delta} 一次挪了 ${Math.abs(after - before)} 格`)
          // 被挤开的那一位必须正好换到 id 原来的位置
          assert.equal(out[before], BASE[after], `${id}/${delta} 交换对象不对`)
        }
      }
    }
    assert.equal(moved, 6, `应有 6 种可动组合，实为 ${moved}`)
    assert.equal(clamped, 2, `应有 2 种贴边组合，实为 ${clamped}`)
  })

  it('不变量：moveBefore 全枚举同样保持集合不变', () => {
    for (const drag of BASE) {
      for (const target of BASE) {
        const out = moveBefore(BASE, drag, target)
        assert.ok(isPerm(out), `${drag}→${target} 结果不是置换：${out}`)
        if (drag !== target) {
          assert.equal(out.indexOf(drag), out.indexOf(target) - 1, `${drag} 应正好落在 ${target} 之前`)
        }
      }
    }
  })

  /* ── 口径层：两处只能用同一份实现 ───────────────────────────── */

  const rail = readSrc('src/renderer/components/ModelRail.tsx')
  const section = readSrc('src/renderer/components/ModelManageSection.tsx')
  const orderSrc = readSrc('src/renderer/modelOrder.ts')

  it('口径层：侧栏拖动改为调用共享函数，不再自带 splice', () => {
    assert.match(rail, /import \{ moveBefore \} from '\.\.\/modelOrder'/, '侧栏没接上共享实现')
    assert.match(rail, /onReorder\(moveBefore\(models\.map\(\(m\) => m\.id\), dragId, targetId\)\)/, '拖动落点没走 moveBefore')
    assert.doesNotMatch(rail, /rest\.splice\(/, '侧栏仍留着一份自己的 splice 排序')
  })

  it('口径层：设置页的上下移动都走 moveStep，不自己算下标', () => {
    assert.match(section, /import \{ moveStep \} from '\.\.\/modelOrder'/, '设置页没接上共享实现')
    assert.equal((section.match(/moveStep\(ids, m\.id, -1\)/g) ?? []).length, 1, '上移没调用 moveStep(-1)')
    assert.equal((section.match(/moveStep\(ids, m\.id, 1\)/g) ?? []).length, 1, '下移没调用 moveStep(1)')
    assert.doesNotMatch(section, /\.splice\(|\.indexOf\(.*\)\s*[-+]\s*1/, '设置页自己拼了下标算式')
  })

  it('口径层：modelOrder 里 moveBefore 是唯一 splice 语义的来源', () => {
    assert.equal((orderSrc.match(/export function moveBefore/g) ?? []).length, 1)
    assert.equal((orderSrc.match(/export function moveStep/g) ?? []).length, 1)
    assert.doesNotMatch(orderSrc, /\.splice\(/, '共享实现自己不该再写 splice')
    assert.match(orderSrc, /return \[\.\.\.ids\]/, '原地拖动要返回副本而不是原数组')
  })

  /* ── 接线层：写权限仍收在 App，新组件不碰 IPC ───────────────── */

  it('接线层：设置页把两个动作作为 props 交给 App 的既有 handler', () => {
    const settings = readSrc('src/renderer/components/SettingsPage.tsx')
    assert.match(settings, /import \{ ModelManageSection \} from '\.\/ModelManageSection'/)
    assert.match(settings, /onReorder: \(orderedIds: string\[\]\) => Promise<void> \| void/)
    assert.match(settings, /onToggleEnabled: \(id: string, enabled: boolean\) => Promise<void> \| void/)
    assert.match(settings, /<ModelManageSection[\s\S]{0,200}models=\{models\}/, '新 section 没拿到全量 models')

    const app = readSrc('src/renderer/App.tsx')
    const usage = app.slice(app.indexOf('<SettingsPage'), app.indexOf('/>', app.indexOf('<SettingsPage')))
    assert.match(usage, /onReorder=\{\(ids\) => void handleReorder\(ids\)\}/, 'App 没把排序 handler 传给设置页')
    assert.match(usage, /onToggleEnabled=\{\(id, enabled\) => void handleToggleEnabled\(id, enabled\)\}/, 'App 没把启停 handler 传给设置页')
  })

  it('接线层：新组件不自己打开 IPC（写盘与脱勾仍归 App 的 handler）', () => {
    assert.doesNotMatch(section, /window\.torra/, '组件里出现了直接 IPC 调用')
    // 停用必须顺带从参与名单/主持里摘掉 —— 这条不变量在 App 侧，指认它仍在
    const app = readSrc('src/renderer/App.tsx')
    assert.match(app, /if \(!enabled\) pruneForGone\(id\)/)
  })

  /* ── 产物层：SSR 结构 ───────────────────────────────────────── */

  const h = loadHarness()
  const MODELS = [
    { id: 'm1', displayName: '甲模型', transport: 'webview', color: '#333', enabled: true },
    { id: 'm2', displayName: '乙模型', transport: 'api', color: '#444', enabled: false },
    { id: 'm3', displayName: '丙模型', transport: 'webview', color: '#555', enabled: true },
  ]

  it('产物层：行序 = 传入顺序，并标出位次与通道', () => {
    const html = h.renderSection(MODELS)
    const pos = MODELS.map((m) => html.indexOf(m.displayName))
    assert.ok(pos.every((p) => p >= 0), '有模型没被渲染出来')
    assert.deepEqual([...pos].sort((a, b) => a - b), pos, '渲染顺序与侧栏顺序不一致')
    assert.ok(html.includes('第 1 位 · 网页'), '位次或通道口径没写进 meta')
    assert.ok(html.includes('第 2 位 · API'), 'API 通道该按 transport 标注')
    assert.equal((html.match(/class="st-row"/g) ?? []).length, 3)
  })

  it('产物层：首行禁上移、末行禁下移，中间两向可用', () => {
    const html = h.renderSection(MODELS)
    const rows = html.split('class="st-row"').slice(1)
    assert.equal(rows.length, 3)
    const disabledOf = (row: string) => (row.match(/disabled(?:="")?(?=[ >])/g) ?? []).length
    assert.equal(disabledOf(rows[0] as string), 1, '首行只该禁上移')
    assert.equal(disabledOf(rows[1] as string), 0, '中间行不该禁用任何方向')
    assert.equal(disabledOf(rows[2] as string), 1, '末行只该禁下移')
    assert.ok((rows[0] as string).indexOf('上移一位') >= 0 && (rows[0] as string).indexOf('下移一位') >= 0, '首行仍该能下移')
  })

  it('产物层：停用态有明确文字，启停按钮文案随之翻转', () => {
    const html = h.renderSection(MODELS)
    assert.ok(html.includes('已停用'), '停用态没有任何可见标记')
    assert.ok(html.includes('停用这个模型') && html.includes('启用这个模型'), '启停按钮文案没随状态翻转')
    assert.ok(html.includes('2/3 启用'), '抬头的小结没给出启用数')
  })

  it('产物层：沿用设置页既有类名，不新造卡片盒与彩色装饰', () => {
    const html = h.renderSection(MODELS)
    assert.ok(html.includes('class="st-section"') && html.includes('class="st-list"'), '没复用设置页的区块结构')
    assert.ok(!html.includes('st-actions quiet'), '行内按钮设成悬停才显示，键盘用户就找不到它们')
    assert.doesNotMatch(html, /class="[^"]*\bcard\b/, '引入了卡片盒类名')
    assert.doesNotMatch(html, /style="background:linear-gradient|box-shadow/, '引入了渐变/阴影装饰')
    assert.ok(html.includes('aria-label="把「甲模型」上移"'), '图标按钮没有可读名称')
  })

  it('产物层：空列表有兜底文案，不渲染出半截控件', () => {
    const html = h.renderSection([])
    assert.ok(html.includes('暂无模型'), '空态没有提示')
    assert.ok(!html.includes('st-row'), '空态不该出现行')
    assert.ok(html.includes('暂无'), '抬头小结没走空态口径')
  })

  it('接线层：套件已挂进 npm test 链', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    assert.match(String(pkg.scripts['test:model-order']), /scripts\/test-model-order\.ts/, '缺独立脚本项')
    assert.match(String(pkg.scripts.test), /run-tests/, 'npm test 必须走 scripts/run-tests.js 汇总跑法')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

main()
