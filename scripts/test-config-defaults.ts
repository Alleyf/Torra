/**
 * 讨论参数默认值与「恢复默认值」的离线回归（纯函数 + store 运行时 + esbuild SSR，不需要 Electron）
 *
 * 第 11 轮补的是「拧坏了怎么回去」。风险不在按钮，在那份默认值会不会长成两份：
 * store 的初值写一份、开场页的占位写一份、恢复逻辑再写一份，于是「恢复默认」
 * 恢复出来的不是首次启动时那一组 —— 用户点完发现数字更陌生。
 *
 * 钉死五层：
 * - 纯函数层：默认表自洽（与主进程常量同源、落在主进程校验区间内）、差异比对的往返稳定；
 * - 口径层：store 初值、开场页的兜底值都从 configDefaults 取，不再各写一份字面量；
 * - 接线层：设置页拿到 config 与 onResetConfig，写动作仍收在 store，组件不碰 IPC；
 * - 状态层：真的调 resetDiscussionConfig，验证它只回白名单键、用户写的内容一概不动；
 * - 产物层：SSR 出来的行序、默认/当前文案、禁用态与类名前缀符合既定样式约定。
 *
 * 运行：npm run test:config-defaults
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

type Config = Record<string, unknown>

type Harness = {
  DEFAULTS: Config
  ROWS: Array<{ key: string; name: string; hint: string }>
  diffFromDefaults: (c: Config) => Array<{ key: string; name: string; current: string; def: string }>
  formatConfigValue: (k: string, v: unknown) => string
  SHARED: { TIME_BUDGET_DEFAULT_MS: number; VERIFY_PASS_DEFAULT: string; TIME_BUDGET_MIN_MS: number; TIME_BUDGET_MAX_MS: number }
  renderSection: (config: Config) => string
  store: () => { getState: () => Config; setState: (p: Config) => void }
}

/**
 * 用 esbuild 把渲染层打成一整块 CJS 在内存里执行：
 * configDefaults 走 @shared 别名，store 走 zustand，都不必让 ts-node 去解析路径。
 */
function loadHarness(): Harness {
  const esbuild = require('esbuild') as typeof import('esbuild')
  const entry = [
    "import { CONFIG_DEFAULTS, CONFIG_ROWS, diffFromDefaults, formatConfigValue } from './src/renderer/configDefaults'",
    "import { TIME_BUDGET_DEFAULT_MS, VERIFY_PASS_DEFAULT, TIME_BUDGET_MIN_MS, TIME_BUDGET_MAX_MS } from './src/shared/types'",
    "import React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { ConfigDefaultsSection } from './src/renderer/components/ConfigDefaultsSection'",
    "import { useStore } from './src/renderer/store'",
    'export const DEFAULTS = CONFIG_DEFAULTS',
    'export const ROWS = CONFIG_ROWS',
    'export { diffFromDefaults, formatConfigValue }',
    'export const SHARED = { TIME_BUDGET_DEFAULT_MS, VERIFY_PASS_DEFAULT, TIME_BUDGET_MIN_MS, TIME_BUDGET_MAX_MS }',
    'export function renderSection(config) {',
    '  return renderToStaticMarkup(React.createElement(ConfigDefaultsSection, { config, onReset: () => {} }))',
    '}',
    'export function store() { return useStore }',
  ].join('\n')
  const result = esbuild.buildSync({
    stdin: { contents: entry, loader: 'ts', resolveDir: ROOT, sourcefile: 'config-defaults-harness.ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    absWorkingDir: ROOT,
    logLevel: 'silent',
    alias: { '@shared': path.join(ROOT, 'src', 'shared') },
  })
  const code = result.outputFiles[0]?.text
  if (!code) throw new Error('esbuild 没有产出代码')
  const m = new Module('config-defaults-harness')
  m.filename = path.join(ROOT, 'scripts', 'config-defaults-harness.js')
  m.paths = (Module as any)._nodeModulePaths(path.dirname(m.filename))
  ;(m as any)._compile(code, m.filename)
  return m.exports as unknown as Harness
}

/** 从源码里切出一段：右边界用下一个声明名，不用固定行号（并行会话会加函数） */
function slice(src: string, startMarker: string, endMarker: string, label: string): string {
  const s = src.indexOf(startMarker)
  assert.ok(s >= 0, `找不到 ${label} 的起始标记 ${startMarker}`)
  const e = src.indexOf(endMarker, s + startMarker.length)
  assert.ok(e > s, `找不到 ${label} 的结束标记 ${endMarker}`)
  return src.slice(s, e)
}

function main(): void {
  console.log('\n── 讨论参数默认值（纯函数 + store 运行时 + SSR 口径）')

  const h = loadHarness()
  const D = h.DEFAULTS
  const keys = Object.keys(D)

  /* ── 纯函数层 ───────────────────────────────────────────────── */

  it('默认值与主进程常量同源：时长与核验轮不各写一份', () => {
    assert.equal(D.timeBudgetMin, Math.round(h.SHARED.TIME_BUDGET_DEFAULT_MS / 60_000), '时长默认值不是从 shared 常量来的')
    assert.equal(D.verifyPass, h.SHARED.VERIFY_PASS_DEFAULT, '核验轮默认值不是从 shared 常量来的')
    assert.equal(D.timeBudgetMin, 12, '默认 12 分钟的口径变了要同步文档与校验区间')
  })

  it('不变量：默认值本身能通过主进程的会话校验区间', () => {
    // 主进程 validateSessionInput 会拒非法配置；默认值若落在区间外，用户开机第一场讨论就被拒
    assert.ok(D.maxRounds >= 1 && D.maxRounds <= 20, `maxRounds=${D.maxRounds} 越界`)
    assert.ok(D.consensusThreshold >= 0 && D.consensusThreshold <= 100, `consensusThreshold=${D.consensusThreshold} 越界`)
    assert.ok(D.budgetLimitUsd > 0 && D.budgetLimitUsd <= 100_000, `budgetLimitUsd=${D.budgetLimitUsd} 越界`)
    const tMs = (D.timeBudgetMin as number) * 60_000
    assert.ok(tMs >= h.SHARED.TIME_BUDGET_MIN_MS && tMs <= h.SHARED.TIME_BUDGET_MAX_MS, '时长默认值被主进程夹紧，界面显示的就不是它')
    assert.ok(['roundtable', 'debate', 'review'].includes(String(D.strategy)), '策略默认值非法')
    assert.ok(['off', 'auto', 'always'].includes(String(D.verifyPass)), '核验轮默认值非法')
  })

  it('白名单完整：界面行表恰好覆盖默认表的每个键（多一项少一项都算失控）', () => {
    const rowKeys = h.ROWS.map((r) => r.key)
    assert.equal(new Set(rowKeys).size, rowKeys.length, '行表里有重复键')
    assert.deepEqual([...rowKeys].sort(), [...keys].sort(), '恢复默认值的作用域与界面所见不一致')
    for (const r of h.ROWS) {
      assert.ok(r.name.trim().length > 0 && r.hint.trim().length > 0, `${r.key} 缺少名称或说明`)
    }
  })

  it('空差异：默认表自己与默认表比，永远是「没有可恢复的东西」', () => {
    assert.deepEqual(h.diffFromDefaults({ ...D }), [], '默认值被判成有差异，按钮会在首次进入时就能点')
  })

  it('逐项单改：每项恰好一条差异，且改回默认后差异清零', () => {
    for (const key of keys) {
      const cur = { ...D, [key]: probe(key, D[key]) }
      const diff = h.diffFromDefaults(cur)
      assert.equal(diff.length, 1, `${key} 改了却有 ${diff.length} 条差异`)
      const d = diff[0]!
      assert.equal(d.key, key)
      assert.equal(d.name, h.ROWS.find((r) => r.key === key)!.name, `${key} 的差异行没带界面名称`)
      assert.notEqual(d.current, d.def, `${key} 的当前值与默认值文案相同，用户看不出自己改过`)
      assert.deepEqual(h.diffFromDefaults({ ...D, [key]: D[key] }), [], `${key} 改回去以后还判为有差异`)
    }
  })

  it('多项同改：条数正确，顺序按界面行表而不是改动顺序', () => {
    const cur = { ...D, strategy: 'debate', maxRounds: 7, anonymousReview: true, verifyPass: 'off' }
    const diff = h.diffFromDefaults(cur)
    assert.deepEqual(diff.map((x) => x.key), ['strategy', 'maxRounds', 'anonymousReview', 'verifyPass'], '差异顺序应与 CONFIG_ROWS 的界面顺序一致')
    assert.deepEqual(h.diffFromDefaults(cur).map((x) => x.key), diff.map((x) => x.key), '同一份配置两次比对结果不该变')
  })

  it('比对只看值，不改入参、不外泄内部对象', () => {
    const cur = { ...D, maxRounds: 9 }
    const snapshot = JSON.stringify(cur)
    const diff = h.diffFromDefaults(cur)
    assert.equal(JSON.stringify(cur), snapshot, 'diffFromDefaults 改动了传进来的配置')
    for (const d of diff) assert.ok(d !== (cur as Record<string, unknown>)[d.key], '差异项不该把配置里的值直接交出去')
  })

  it('文案口径：开关说人话、数字带单位，每一项都能读', () => {
    const unit: Record<string, string> = {
      maxRounds: '轮',
      consensusThreshold: '%',
      budgetLimitUsd: '美元',
      timeBudgetMin: '分钟',
    }
    for (const key of keys) {
      const s = h.formatConfigValue(key, D[key])
      assert.ok(typeof s === 'string' && s.length > 0, `${key} 的默认值没法显示`)
      const suffix = unit[key]
      if (suffix) assert.ok(s.endsWith(suffix), `${key} 的数字值该带单位「${suffix}」，实为 ${s}`)
      if (['anonymousReview', 'baseline', 'baselineCompare'].includes(key)) {
        assert.ok(s === '开' || s === '关', `${key} 的开关值要说人话，实为 ${s}`)
      }
    }
    assert.equal(h.formatConfigValue('strategy', 'roundtable'), '圆桌')
    assert.equal(h.formatConfigValue('strategy', 'debate'), '辩论')
    assert.equal(h.formatConfigValue('verifyPass', 'always'), '逐条')
  })

  /* ── 口径层：默认值只有一份 ─────────────────────────────────── */

  const storeSrc = readSrc('src/renderer/store.ts')
  const newSession = readSrc('src/renderer/components/NewSession.tsx')
  const defaultsSrc = readSrc('src/renderer/configDefaults.ts')

  it('口径层：store 的初值展开默认表，不重抄一遍数字', () => {
    assert.match(storeSrc, /import \{ CONFIG_DEFAULTS \} from '\.\/configDefaults'/, 'store 没接上默认表')
    const initial = slice(storeSrc, 'const initial = {', '\nexport const useStore', 'store 初值')
    assert.match(initial, /\.\.\.CONFIG_DEFAULTS/, '初值块里没有展开默认表 —— 恢复出来的就和首次启动的不是同一组')
    for (const forbidden of ['consensusThreshold: 85', 'maxRounds: 3', 'budgetLimitUsd: 2', 'timeBudgetMin: 12']) {
      assert.ok(!initial.includes(forbidden), `初值块仍留着手写字面量 ${forbidden}`)
    }
  })

  it('口径层：开场页的三处默认引用同一份表', () => {
    assert.match(newSession, /import \{ CONFIG_DEFAULTS \} from '\.\.\/configDefaults'/, '开场页没接上默认表')
    assert.match(newSession, /at: CONFIG_DEFAULTS\.consensusThreshold/, '共识阈值刻度仍写死')
    assert.match(newSession, /fallback=\{CONFIG_DEFAULTS\.timeBudgetMin\}/, '时长兜底仍写死')
    assert.match(newSession, /CONFIG_DEFAULTS\.budgetLimitUsd/, '预算兜底仍写死')
    assert.doesNotMatch(newSession, /fallback=\{12\}/, '时长兜底还留着 12 的字面量')
  })

  it('口径层：恢复动作是白名单覆盖，不复用整场 reset()', () => {
    const body = slice(storeSrc, 'resetDiscussionConfig: () =>', '\n  toggleParticipant', '恢复默认值实现')
    assert.match(body, /set\(\{ \.\.\.CONFIG_DEFAULTS \}/, '恢复动作没走默认表')
    assert.doesNotMatch(body, /topicTitle|participantIds|utterances/, '恢复动作碰了用户内容')
    assert.match(storeSrc, /reset: \(\): void => set\(\{ \.\.\.initial/, 'reset() 的既有语义不该被改')
    // 默认表只许导出两份常量：一份值、一份界面顺序；长出第三份就意味着又有人另起了一套默认
    assert.deepEqual(
      (defaultsSrc.match(/export const \w+/g) ?? []).sort(),
      ['export const CONFIG_DEFAULTS', 'export const CONFIG_ROWS'],
      'configDefaults 里冒出了第三份默认常量'
    )
  })

  /* ── 状态层：真的跑一次恢复 ─────────────────────────────────── */

  const S = h.store()
  const cfgOf = (st: Config) => Object.fromEntries(keys.map((k) => [k, st[k]]))

  it('状态层：刚建好的会话就是默认值（界面无需先改后恢复）', () => {
    assert.deepEqual(cfgOf(S.getState()), D, 'store 初值与默认表不一致')
  })

  it('状态层：恢复只回「怎么讨论」，用户写下的东西一概不动', () => {
    S.setState({
      ...D,
      strategy: 'review',
      maxRounds: 19,
      consensusThreshold: 12,
      budgetLimitUsd: 7,
      anonymousReview: true,
      baseline: false,
      baselineCompare: false,
      verifyPass: 'always',
      timeBudgetMin: 45,
      topicTitle: '写了半天的议题',
      topicBackground: '背景材料',
      participantIds: ['m1', 'm2'],
      moderatorId: 'm1',
      round: 2,
      state: 'DISCUSSING',
    })
    const before = S.getState()
    const keep = {
      topicTitle: before.topicTitle,
      topicBackground: before.topicBackground,
      participantIds: [...(before.participantIds as string[])],
      moderatorId: before.moderatorId,
      round: before.round,
      state: before.state,
      models: before.models,
    }
    const act = S.getState().resetDiscussionConfig as () => void
    act()
    const after = S.getState()
    assert.deepEqual(cfgOf(after), D, '九项参数没有全部回到默认值')
    assert.equal(after.topicTitle, keep.topicTitle, '议题标题被清掉了')
    assert.equal(after.topicBackground, keep.topicBackground, '背景材料被清掉了')
    assert.deepEqual(after.participantIds, keep.participantIds, '参与名单被动了')
    assert.equal(after.moderatorId, keep.moderatorId, '主持指认被动了')
    assert.equal(after.round, keep.round, '轮次被动了')
    assert.equal(after.state, keep.state, '运行态被动了')
    assert.equal(after.models, keep.models, '模型阵容被动了')
  })

  it('状态层：恢复幂等，连点两次不是两次操作', () => {
    const act = S.getState().resetDiscussionConfig as () => void
    act()
    assert.deepEqual(cfgOf(S.getState()), D)
    assert.deepEqual(h.diffFromDefaults(cfgOf(S.getState())), [], '第二次进设置页仍显示有差异')
  })

  it('状态层：reset() 的既有整场清空语义没被改弱', () => {
    S.setState({ topicTitle: '草稿', participantIds: ['m1'], maxRounds: 15 })
    ;(S.getState().reset as () => void)()
    const st = S.getState()
    assert.equal(st.topicTitle, '', 'reset() 该清议题')
    assert.deepEqual(st.participantIds, [], 'reset() 该清名单')
    assert.deepEqual(cfgOf(st), D, 'reset() 之后也该是默认配置')
  })

  /* ── 接线层 ─────────────────────────────────────────────────── */

  it('接线层：设置页多一个 tab，出口仍收在设置页内', () => {
    const settings = readSrc('src/renderer/components/SettingsPage.tsx')
    assert.match(settings, /id: 'discussion', label: '讨论参数'/, '讨论参数没进设置页导航')
    assert.match(settings, /import \{ ConfigDefaultsSection \} from '\.\/ConfigDefaultsSection'/, '设置页没引入配置区组件')
    assert.match(settings, /config: DiscussionConfig/, '设置页没声明配置入参')
    assert.match(settings, /onResetConfig: \(\) => void/, '设置页没声明恢复动作入参')
    assert.match(settings, /\{tab === 'discussion' && <ConfigDefaultsSection[\s\S]{0,160}config=\{config\}/, '新 tab 没渲染配置区')
    assert.match(settings, /onReset=\{onResetConfig\}/, '恢复按钮没接到 props')
  })

  it('接线层：App 把 store 的恢复动作接给设置页', () => {
    const app = readSrc('src/renderer/App.tsx')
    const usage = slice(app, '<SettingsPage', '\n            />', 'SettingsPage 用法')
    assert.match(usage, /config=\{\{[\s\S]*strategy: s\.strategy[\s\S]*timeBudgetMin: s\.timeBudgetMin,?\s*\}\}/, 'App 没把九项参数交给设置页')
    assert.match(usage, /onResetConfig=\{\(\) => s\.resetDiscussionConfig\(\)\}/, 'App 没接上 store 的恢复动作')
    const section = readSrc('src/renderer/components/ConfigDefaultsSection.tsx')
    assert.doesNotMatch(section, /window\.torra/, '配置区自己调 IPC，写权限就漏出 store 了')
  })

  it('接线层：套件已挂进 npm test 链', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    assert.match(String(pkg.scripts['test:config-defaults']), /scripts\/test-config-defaults\.ts/, '缺独立脚本项')
    assert.match(String(pkg.scripts.test), /run-tests/, 'npm test 必须走 scripts/run-tests.js 汇总跑法')
  })

  /* ── 产物层：SSR 结构 ───────────────────────────────────────── */

  it('产物层：每一行都给名称、说明与默认值', () => {
    const html = h.renderSection({ ...D })
    assert.equal((html.match(/class="st-row"/g) ?? []).length, h.ROWS.length, '行数与界面行表不一致')
    const positions = h.ROWS.map((r) => html.indexOf(r.name))
    assert.ok(positions.every((p) => p >= 0), '有参数行没被渲染出来')
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '渲染顺序与行表顺序不一致')
    for (const r of h.ROWS) {
      assert.ok(html.includes(r.hint), `${r.name} 的说明没显示`)
      assert.ok(html.includes(`默认 ${h.formatConfigValue(r.key, D[r.key])}`), `${r.name} 没给出默认值`)
    }
  })

  it('产物层：全是默认值时按钮禁点，并说明原因', () => {
    const html = h.renderSection({ ...D })
    assert.match(html, /<button[^>]*disabled=""/, '没有可恢复的东西时按钮还亮着')
    assert.ok(html.includes('全部为默认值'), '抬头没给出「无需恢复」的结论')
    assert.ok(html.includes('当前已经全是默认值'), '禁用态没有可解释的 title')
    assert.equal((html.match(/未改/g) ?? []).length, h.ROWS.length, '未改的行都该标「未改」')
    assert.ok(!html.includes('当前 '), '默认态不该出现「当前 X」')
    assert.ok(!html.includes('st-inline-msg'), '没点过就不该有提示')
  })

  it('产物层：有差异时给出条数、当前值，按钮随状态可用', () => {
    const html = h.renderSection({ ...D, maxRounds: 5, verifyPass: 'off' })
    assert.ok(html.includes('2 项与默认不同'), '差异条数没写进抬头')
    assert.ok(html.includes('当前 5 轮') && html.includes('当前 关闭'), '差异行的当前值没显示')
    assert.ok(html.includes('把 2 项改回默认值'), '按钮 title 没说明它会改几项')
    assert.doesNotMatch(html, /<button[^>]*disabled=""/, '有差异时按钮不该禁用')
    assert.equal((html.match(/未改/g) ?? []).length, h.ROWS.length - 2, '「未改」标记数不对')
  })

  it('产物层：沿用设置页既有类名，不新造卡片盒与彩色装饰', () => {
    const html = h.renderSection({ ...D, budgetLimitUsd: 9 })
    assert.ok(html.includes('class="st-section"') && html.includes('class="st-list"'), '没复用设置页的区块结构')
    assert.ok(html.includes('aria-label="把讨论参数恢复为默认值"'), '按钮没有可读名称')
    assert.ok(html.includes('class="wm-tally ok"'), '未改的行没走 ok 态样式')
    assert.doesNotMatch(html, /class="[^"]*\bcard\b/, '引入了卡片盒类名')
    assert.doesNotMatch(html, /linear-gradient|box-shadow/, '引入了渐变/阴影装饰')
    assert.doesNotMatch(html, /<input|<select/, '配置区是查看与恢复，不该在这里长出第二套编辑控件')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

/** 给一个「一定不等于默认值」的探针 */
function probe(key: string, current: unknown): unknown {
  if (key === 'strategy') return current === 'debate' ? 'review' : 'debate'
  if (key === 'verifyPass') return current === 'off' ? 'always' : 'off'
  if (typeof current === 'boolean') return !current
  if (typeof current === 'number') return current + 1
  return current
}

main()
