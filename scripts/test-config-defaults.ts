/**
 * 讨论参数「两层默认值」的离线回归（纯函数 + store 运行时 + esbuild SSR，不需要 Electron）
 *
 * 这轮把默认值从代码常量改成了用户可配置的东西，风险也跟着变了。原来怕的是
 * 「默认值长成两份」，现在怕的是这三件事：
 *
 * 1. **三份真相**：出厂值、我的默认、开场页草稿，任何一个自己抄了一份数字或区间，
 *    就会出现「设置页显示 9，起草用的是 3，主进程拒掉的是 20」这种三方都没错的错乱；
 * 2. **覆盖表变成垃圾桶**：偏好文件里塞进非法值、未知键、或跟出厂值一模一样的项，
 *    于是「恢复出厂」清不干净，抬头也说不清到底改了几项；
 * 3. **跟随规则含糊**：改默认值时把用户手动拧过的草稿一起覆盖掉，或者反过来
 *    设了默认却对开场页毫无影响 —— 两个方向都要钉住。
 *
 * 所以分层钉：
 * - 纯函数层：区间/钳制/覆盖表只在 @shared/discussion-defaults 一处，且行为可预期；
 * - 口径层：草稿、默认槽、开场页兜底、输入框 min/max 全部从那一处取，没有第二份字面量；
 * - 状态层：真的跑 hydrate / 改默认 / 恢复默认 / 恢复出厂 / reset，验证跟随判据与副作用边界；
 * - 接线层：设置页六个入参齐、App 走 IPC、主进程读写两侧都 sanitize、preload 通道名对得上；
 * - 产物层：SSR 出来的控件种类、可访问名、区间属性、chip 与 tally 文案符合既定样式约定。
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
  // Windows 签出的源码是 CRLF：带 \n 的标记与正则在这里会静默失配，一律先归一
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

type Config = Record<string, any>

type Harness = {
  /** 出厂默认表 */
  DEFAULTS: Config
  ROWS: Array<{ key: string; name: string; hint: string }>
  diffFromDefaults: (c: Config, base?: Config) => Array<{ key: string; name: string; current: string; def: string }>
  formatConfigValue: (k: string, v: unknown) => string
  customizedDefaults: (patch: Config) => string[]
  SHARED: { TIME_BUDGET_DEFAULT_MS: number; VERIFY_PASS_DEFAULT: string; TIME_BUDGET_MIN_MS: number; TIME_BUDGET_MAX_MS: number }
  S: {
    DISCUSSION_DEFAULTS: Config
    DISCUSSION_CONFIG_KEYS: string[]
    normalizeDefault: (k: string, raw: unknown) => unknown
    sanitizeDiscussionDefaults: (raw: unknown) => Config
    resolveDiscussionDefaults: (patch: unknown) => Config
    numberBound: (k: string) => { min: number; max: number; step: number } | null
    enumValues: (k: string) => string[]
  }
  /** patch = 偏好里那份「我的默认」覆盖表 */
  renderSection: (config: Config, patch?: Config) => string
  store: () => { getState: () => Config; setState: (p: Config) => void }
}

/**
 * 用 esbuild 把渲染层打成一整块 CJS 在内存里执行：
 * configDefaults 与 store 都走 @shared 别名，不必让 ts-node 去解析路径别名。
 */
function loadHarness(): Harness {
  const esbuild = require('esbuild') as typeof import('esbuild')
  const entry = [
    "import { CONFIG_DEFAULTS, CONFIG_ROWS, diffFromDefaults, formatConfigValue, customizedDefaults } from './src/renderer/configDefaults'",
    "import { DISCUSSION_DEFAULTS, DISCUSSION_CONFIG_KEYS, normalizeDefault, sanitizeDiscussionDefaults, resolveDiscussionDefaults, numberBound, enumValues } from './src/shared/discussion-defaults'",
    "import { TIME_BUDGET_DEFAULT_MS, VERIFY_PASS_DEFAULT, TIME_BUDGET_MIN_MS, TIME_BUDGET_MAX_MS } from './src/shared/types'",
    "import React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { ConfigDefaultsSection } from './src/renderer/components/ConfigDefaultsSection'",
    "import { useStore } from './src/renderer/store'",
    'export const DEFAULTS = CONFIG_DEFAULTS',
    'export const ROWS = CONFIG_ROWS',
    'export { diffFromDefaults, formatConfigValue, customizedDefaults }',
    'export const SHARED = { TIME_BUDGET_DEFAULT_MS, VERIFY_PASS_DEFAULT, TIME_BUDGET_MIN_MS, TIME_BUDGET_MAX_MS }',
    'export const S = { DISCUSSION_DEFAULTS, DISCUSSION_CONFIG_KEYS, normalizeDefault, sanitizeDiscussionDefaults, resolveDiscussionDefaults, numberBound, enumValues }',
    'export function renderSection(config, patch) {',
    '  const overrides = sanitizeDiscussionDefaults(patch)',
    '  const defaults = { ...CONFIG_DEFAULTS, ...overrides }',
    '  return renderToStaticMarkup(React.createElement(ConfigDefaultsSection, {',
    '    config, defaults, customized: customizedDefaults(overrides),',
    '    onReset: () => {}, onSetDefault: () => {}, onRestoreFactory: () => {},',
    '  }))',
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
  // Windows 签出的源码是 CRLF，带换行的标记会静默失配
  const text = src.replace(/\r\n/g, '\n')
  const s = text.indexOf(startMarker)
  assert.ok(s >= 0, `找不到 ${label} 的起始标记 ${startMarker}`)
  const e = text.indexOf(endMarker, s + startMarker.length)
  assert.ok(e > s, `找不到 ${label} 的结束标记 ${endMarker}`)
  return text.slice(s, e)
}

/** 给一个「一定不等于默认值」的探针 */
function probe(key: string, current: unknown): unknown {
  if (key === 'strategy') return current === 'debate' ? 'review' : 'debate'
  if (key === 'verifyPass') return current === 'off' ? 'always' : 'off'
  if (typeof current === 'boolean') return !current
  if (typeof current === 'number') return current + 1
  return current
}

/** 解析一个 HTML 开始标签上的属性 */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]!] = m[2]!
  return out
}

function main(): void {
  console.log('\n── 讨论参数默认值（shared 钳制 + store 运行时 + SSR 口径）')

  const h = loadHarness()
  const D = h.DEFAULTS
  const keys = Object.keys(D)
  const SH = h.S

  /* ── 纯函数层：出厂表与区间 ─────────────────────────────────── */

  it('默认表就是 shared 的那一份：渲染层没有另建一张', () => {
    assert.deepEqual(D, SH.DISCUSSION_DEFAULTS, 'configDefaults 的默认表与 shared 不同源')
    assert.deepEqual(Object.keys(SH.DISCUSSION_DEFAULTS).sort(), [...SH.DISCUSSION_CONFIG_KEYS].sort())
    assert.equal(D.timeBudgetMin, Math.round(h.SHARED.TIME_BUDGET_DEFAULT_MS / 60_000), '时长默认值不是从 shared 常量换算来的')
    assert.equal(D.verifyPass, h.SHARED.VERIFY_PASS_DEFAULT, '核验轮默认值不是从 shared 常量来的')
    assert.equal(D.timeBudgetMin, 12, '默认 12 分钟的口径变了要同步文档与校验区间')
  })

  it('不变量：默认表本身能通过主进程的会话校验区间', () => {
    // 默认值落在区间外，用户开机第一场讨论就被主进程拒掉，而拒掉的理由看起来像代码写错了
    assert.ok(D.maxRounds >= 1 && D.maxRounds <= 20, `maxRounds=${D.maxRounds} 越界`)
    assert.ok(D.budgetLimitUsd > 0 && D.budgetLimitUsd <= 100_000, `budgetLimitUsd=${D.budgetLimitUsd} 越界`)
    const tMs = D.timeBudgetMin * 60_000
    assert.ok(tMs >= h.SHARED.TIME_BUDGET_MIN_MS && tMs <= h.SHARED.TIME_BUDGET_MAX_MS, '时长默认值会被主进程夹紧，界面显示的就不是它')
    assert.ok(['roundtable', 'debate', 'review'].includes(String(D.strategy)), '策略默认值非法')
    assert.ok(['off', 'auto', 'always'].includes(String(D.verifyPass)), '核验轮默认值非法')
    for (const key of keys) assert.notEqual(SH.normalizeDefault(key, D[key]), undefined, `${key} 的默认值过不了自己的钳制`)
  })

  it('收束分数线整个退出：既不是参数，也不再是常量', () => {
    // 阈值曾是第九项，后来收成内部常量由主进程注入。两步都不够：
    // 分数路径能在还剩未决分歧时宣布收束（实测 87.5 分散会、质询覆盖 0%），
    // 于是「把线调低」和「线由程序定」都还是拿天花板当结论。现在收束只看结构。
    assert.ok(!('consensusThreshold' in D), '出厂表里还留着共识阈值，设置页就会出现一个能改它的控件')
    assert.ok(!keys.includes('consensusThreshold'))
    assert.ok(!h.ROWS.some((r) => r.key === 'consensusThreshold'), '界面行表还在展示共识阈值')
    assert.doesNotMatch(
      readSrc('src/shared/types.ts'),
      /CONSENSUS_SCORE_THRESHOLD/,
      '还留着一个收束分数线常量：留着就迟早有人拿它当终止条件',
    )
    const mainSrc = readSrc('src/main/index.ts')
    assert.doesNotMatch(mainSrc, /out\.consensusThreshold\s*=/, '主进程还在给本场注入分数线')
    assert.match(mainSrc, /delete out\.consensusThreshold/, '渲染端传上来的旧分数线必须被丢掉，否则界面会画出一条没人遵守的线')
    assert.doesNotMatch(mainSrc, /共识阈值必须为/, '校验还在要求用户提供一个已经不存在的参数')
  })

  it('控件种类互斥完备：每项恰好一种控件，且区间就是主进程那一组', () => {
    let numeric = 0
    let en = 0
    let bool = 0
    for (const key of keys) {
      const b = SH.numberBound(key)
      const e = SH.enumValues(key)
      assert.ok(Number(Boolean(b)) + (e.length > 0 ? 1 : 0) + (b === null && e.length === 0 ? 1 : 0) === 1, `${key} 的控件种类不止一种或为零`)
      if (b) {
        numeric++
        assert.ok(b.min < b.max && b.step > 0, `${key} 的区间不成立`)
      } else if (e.length > 0) en++
      else bool++
    }
    assert.equal(numeric, 3, '数字项应有 3 个（轮次/预算/时长）')
    assert.equal(en, 2, '枚举项应有 2 个（策略/核验轮）')
    assert.equal(bool, 3, '开关项应有 3 个')
    // 时长区间是从毫秒常量换算来的，不是界面自己抄的第二个真相
    const tb = SH.numberBound('timeBudgetMin')!
    assert.equal(tb.min, Math.round(h.SHARED.TIME_BUDGET_MIN_MS / 60_000))
    assert.equal(tb.max, Math.round(h.SHARED.TIME_BUDGET_MAX_MS / 60_000))
  })

  it('normalizeDefault：越界夹紧、整数取整、非法丢弃', () => {
    assert.equal(SH.normalizeDefault('maxRounds', 999), 20, '上界没夹紧')
    assert.equal(SH.normalizeDefault('maxRounds', -5), 1, '下界没夹紧')
    assert.equal(SH.normalizeDefault('maxRounds', 4.6), 5, '整数项该取整，否则会话校验会拒掉小数轮次')
    assert.equal(SH.normalizeDefault('budgetLimitUsd', 0), 0.1, '预算下界不是 0.1')
    // 老偏好文件里可能还留着当年自己填的阈值：它已不在白名单，清洗时必须整个丢弃
    assert.deepEqual(SH.sanitizeDiscussionDefaults({ consensusThreshold: 70 }), {}, '退出参数表的键还能从偏好里灌回来')
    for (const bad of ['abc', null, undefined, NaN, Infinity, {}, [], true]) {
      assert.equal(SH.normalizeDefault('maxRounds', bad), undefined, `maxRounds 收到 ${String(bad)} 不该有结果`)
    }
    assert.equal(SH.normalizeDefault('strategy', 'nope'), undefined, '枚举外的值必须丢弃，不能写进偏好')
    assert.equal(SH.normalizeDefault('strategy', 'debate'), 'debate')
    assert.equal(SH.normalizeDefault('baseline', 'true'), undefined, '布尔项不接受字符串')
    assert.equal(SH.normalizeDefault('baseline', true), true)
  })

  it('sanitizeDiscussionDefaults：未知键丢弃、非法丢弃、与出厂相同的项不进表', () => {
    const p = SH.sanitizeDiscussionDefaults({
      maxRounds: 9,
      budgetLimitUsd: D.budgetLimitUsd, // 与出厂一致 → 不该进表
      strategy: 'nope', // 非法 → 丢弃
      topicTitle: '串场了的键', // 不在白名单 → 丢弃
      anonymousReview: true,
    })
    assert.deepEqual(Object.keys(p).sort(), ['anonymousReview', 'maxRounds'], `覆盖表内容为 ${JSON.stringify(p)}`)
    assert.deepEqual(SH.sanitizeDiscussionDefaults(null), {}, 'null 要收成空表而不是抛异常')
    assert.deepEqual(SH.sanitizeDiscussionDefaults('字符串'), {})
    assert.deepEqual(SH.sanitizeDiscussionDefaults([1, 2]), {}, '数组不是覆盖表')
    assert.deepEqual(SH.sanitizeDiscussionDefaults(SH.sanitizeDiscussionDefaults(p)), p, 'sanitize 不幂等')
  })

  it('resolveDiscussionDefaults：永远是完整八项，缺项回落出厂值', () => {
    const r = SH.resolveDiscussionDefaults({ maxRounds: 9 })
    assert.deepEqual(Object.keys(r).sort(), [...keys].sort())
    assert.equal(r.maxRounds, 9)
    assert.equal(r.budgetLimitUsd, D.budgetLimitUsd)
    assert.ok(!('consensusThreshold' in r), '分数线不该出现在解析出的讨论参数里')
    assert.deepEqual(SH.resolveDiscussionDefaults(null), D, '空偏好就该等于出厂表')
    // 旧偏好带着已经不存在的键：解析结果必须既没有它，也不因为它而作废
    assert.deepEqual(SH.resolveDiscussionDefaults({ consensusThreshold: 40 } as any), D, '一个过期键能让整份偏好失效')
  })

  /* ── 纯函数层：界面比对与文案 ───────────────────────────────── */

  it('白名单完整：界面行表恰好覆盖默认表的每个键（多一项少一项都算失控）', () => {
    const rowKeys = h.ROWS.map((r) => r.key)
    assert.equal(new Set(rowKeys).size, rowKeys.length, '行表里有重复键')
    assert.deepEqual([...rowKeys].sort(), [...keys].sort(), '设置页可见范围与恢复作用域不一致')
    for (const r of h.ROWS) {
      assert.ok(r.name.trim().length > 0 && r.hint.trim().length > 0, `${r.key} 缺少名称或说明`)
    }
  })

  it('差异比对：base 缺省是出厂表，也可以传「我的默认」', () => {
    assert.deepEqual(h.diffFromDefaults({ ...D }), [], '出厂表跟自己比不该有差异')
    const base = { ...D, maxRounds: 9 }
    // 草稿 = 我的默认 时不该判为「有差异」，否则恢复按钮永远是亮着的
    assert.deepEqual(h.diffFromDefaults({ ...D, maxRounds: 9 }, base), [], '草稿等于我的默认，却还判为需要恢复')
    assert.deepEqual(h.diffFromDefaults({ ...D, maxRounds: 9 }).map((x) => x.key), ['maxRounds'], '与出厂比时又该有差异')
  })

  it('逐项单改：每项恰好一条差异，改回 base 后差异清零', () => {
    const base = { ...D, anonymousReview: true }
    for (const key of keys) {
      const cur = { ...base, [key]: probe(key, base[key]) }
      const diff = h.diffFromDefaults(cur, base)
      assert.equal(diff.length, 1, `${key} 改了却有 ${diff.length} 条差异`)
      assert.equal(diff[0]!.key, key)
      assert.equal(diff[0]!.name, h.ROWS.find((r) => r.key === key)!.name, `${key} 的差异行没带界面名称`)
      assert.notEqual(diff[0]!.current, diff[0]!.def, `${key} 的当前值与默认值文案相同，用户看不出自己改过`)
      assert.deepEqual(h.diffFromDefaults({ ...base, [key]: base[key] }, base), [], `${key} 改回去以后还判为有差异`)
    }
  })

  it('多项同改：条数正确，顺序按界面行表而不是改动顺序', () => {
    const cur = { ...D, strategy: 'debate', maxRounds: 7, anonymousReview: true, verifyPass: 'off' }
    const diff = h.diffFromDefaults(cur)
    assert.deepEqual(diff.map((x) => x.key), ['strategy', 'maxRounds', 'anonymousReview', 'verifyPass'], '差异顺序应与 CONFIG_ROWS 的界面顺序一致')
  })

  it('customizedDefaults 认覆盖表，不认草稿', () => {
    assert.deepEqual(h.customizedDefaults({}), [])
    assert.deepEqual(h.customizedDefaults({ maxRounds: 9, verifyPass: 'off' }), ['maxRounds', 'verifyPass'], '顺序该按界面行表')
    assert.deepEqual(h.customizedDefaults({ maxRounds: undefined }), [], '值为 undefined 的键不算被改过')
    // 与出厂相同的值进不了覆盖表（sanitize 已丢弃），所以这里不会误报
    assert.deepEqual(h.customizedDefaults(SH.sanitizeDiscussionDefaults({ maxRounds: D.maxRounds })), [])
  })

  it('比对只看值，不改入参', () => {
    const cur = { ...D, maxRounds: 9 }
    const snapshot = JSON.stringify(cur)
    h.diffFromDefaults(cur)
    assert.equal(JSON.stringify(cur), snapshot, 'diffFromDefaults 改动了传进来的配置')
  })

  it('文案口径：开关说人话、数字带单位，每一项都能读', () => {
    const unit: Record<string, string> = {
      maxRounds: '轮',
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
    assert.equal(h.formatConfigValue('verifyPass', 'always'), '逐条')
  })

  /* ── 口径层：真相只有一处 ───────────────────────────────────── */

  const storeSrc = readSrc('src/renderer/store.ts')
  const newSession = readSrc('src/renderer/components/NewSession.tsx')
  const defaultsSrc = readSrc('src/renderer/configDefaults.ts')
  const sectionSrc = readSrc('src/renderer/components/ConfigDefaultsSection.tsx')

  it('口径层：store 初值展开默认表，草稿与默认槽同源', () => {
    assert.match(storeSrc, /import \{ CONFIG_DEFAULTS \} from '\.\/configDefaults'/, 'store 没接上默认表')
    const initial = slice(storeSrc, 'const initial = {', '\n/**\n * 「新建一场」', 'store 初值')
    assert.match(initial, /\.\.\.CONFIG_DEFAULTS/, '初值块没展开默认表')
    assert.match(initial, /discussionDefaults: \{ \.\.\.CONFIG_DEFAULTS \}/, '默认槽没从出厂表起')
    // 分数线整个作废：新场次没有值可种，只有回放旧存档时才换成那一场自己落盘的数
    assert.match(initial, /consensusThreshold: null/, 'store 还在给新场次种一条没人遵守的分数线')
    assert.doesNotMatch(storeSrc, /CONSENSUS_SCORE_THRESHOLD/, 'store 还在从 shared 引入收束常量')
    for (const forbidden of ['consensusThreshold: 85', 'maxRounds: 3', 'budgetLimitUsd: 2', 'timeBudgetMin: 12']) {
      assert.ok(!initial.includes(forbidden), `初值块仍留着手写字面量 ${forbidden}`)
    }
  })

  it('口径层：渲染层的 configDefaults 不抄值，只抄顺序与叫法', () => {
    assert.match(defaultsSrc, /export const CONFIG_DEFAULTS = DISCUSSION_DEFAULTS/, '默认表不是直接引用 shared')
    assert.deepEqual(
      (defaultsSrc.match(/export const \w+/g) ?? []).sort(),
      ['export const CONFIG_DEFAULTS', 'export const CONFIG_ROWS'],
      'configDefaults 里冒出了第三份默认常量'
    )
    assert.doesNotMatch(defaultsSrc, /consensusThreshold:\s*\d|maxRounds:\s*\d|budgetLimitUsd:\s*\d/, '界面口径表里抄了默认值数字')
  })

  it('口径层：钳制只在 shared 一处，store 与主进程都用它', () => {
    assert.match(storeSrc, /normalizeDefault/, 'store 没走 shared 的钳制')
    assert.match(storeSrc, /sanitizeDiscussionDefaults/, 'store 的 hydrate 没走 shared 的清洗')
    assert.doesNotMatch(storeSrc, /Math\.min\(20|Math\.max\(1,\s*Math\.min/, 'store 自己写了一套区间')
    const mainSrc = readSrc('src/main/index.ts')
    assert.match(mainSrc, /import \{ sanitizeDiscussionDefaults \} from '\.\.\/shared\/discussion-defaults'/, '主进程没用同一份清洗')
    assert.doesNotMatch(sectionSrc, /min=\{\s*\d|max=\{\s*\d/, '配置区自己抄了区间数字')
    assert.match(sectionSrc, /numberBound\(r\.key\)/, '数字区间不是从 shared 取的')
    assert.match(sectionSrc, /enumValues\(r\.key\)/, '枚举取值不是从 shared 取的')
  })

  it('口径层：开场页的兜底读「我的默认」，不读出厂表', () => {
    assert.doesNotMatch(newSession, /CONFIG_DEFAULTS/, '开场页还直接引用出厂表，用户设的默认到不了这一屏')
    assert.match(newSession, /s\.discussionDefaults\.budgetLimitUsd/, '预算兜底不跟随我的默认')
    assert.match(newSession, /fallback=\{s\.discussionDefaults\.timeBudgetMin\}/, '时长兜底不跟随我的默认')
    assert.doesNotMatch(newSession, /fallback=\{12\}/, '时长兜底还留着 12 的字面量')
  })

  it('口径层：开场页没有阈值滑块，配置里也不带这一项', () => {
    assert.doesNotMatch(newSession, /discussionDefaults\.consensusThreshold/, '开场页还在读「我的默认」里的阈值')
    assert.doesNotMatch(newSession, /consensusThreshold/, '开场页的配置里还带着这一项')
    assert.doesNotMatch(newSession, /type="range"/, '开场页还有滑杆')
    assert.doesNotMatch(newSession, /宽松|严苛/, '阈值刻度的两个锚点名还留着')
    const css = readSrc('src/renderer/newsession.css')
    assert.doesNotMatch(css, /\.ns-range/, '滑块样式成了没人用的死规则')
  })

  it('口径层：分数线只剩旧存档的历史值，展示层按它有没有来画', () => {
    // 收束不看分数，但旧场次自己记着当年那条线：回放时照原样显示，新场次一条都不画。
    const panel = readSrc('src/renderer/components/ConsensusPanel.tsx')
    const chart = readSrc('src/renderer/components/ScoreChart.tsx')
    const report = readSrc('src/main/report/report.ts')
    const mainSrc = readSrc('src/main/index.ts')
    assert.match(panel, /useStore\(\(s\) => s\.consensusThreshold\)/, '台账不再读分数线，旧存档回放时也认不出它')
    assert.match(panel, /typeof threshold === 'number'/, '台账无条件显示分数线')
    assert.match(chart, /threshold: number \| null/, '曲线还把它当必填参数')
    assert.match(chart, /typeof threshold === 'number' &&/, '参考线被无条件画出来 —— 新场次根本没有这条线')
    assert.match(report, /typeof r\.meta\?\.consensusThreshold === 'number'/, '报告无条件打印分数线')
    assert.match(mainSrc, /currentConfig = config/, '主进程给编排器/投影的不是归一化后的那一份')
    // 历史会话回放必须用那一场自己落盘的数，否则旧存档的曲线会按今天的线重画
    assert.match(storeSrc, /consensusThreshold: rec\.config\.consensusThreshold \?\? null/, '回放没把历史分数线接住')
  })

  it('口径层：跟随判据在 store 里只有一种写法', () => {
    // 三处跟随（改单项 / 恢复出厂 / 灌偏好）必须同判据，否则「没手动拧过」在三处意思不同
    const n = (storeSrc.match(/=== s\.discussionDefaults\[key\]/g) ?? []).length
    assert.equal(n, 3, `草稿跟随判据出现 ${n} 次，应为 3 次（改单项、恢复出厂、灌偏好）`)
    // 出厂值只许参与一处判据：这项值是否等于出厂值 —— 决定它该不该留在覆盖表里
    assert.equal((storeSrc.match(/=== CONFIG_DEFAULTS\[key\]/g) ?? []).length, 1, '出厂值参与判据的地方不止一处')
  })

  it('口径层：新建一场与回放历史都带走我的默认', () => {
    const keep = slice(storeSrc, 'const keepAcrossSession =', '\nexport const useStore', '跨场保留')
    assert.match(keep, /discussionDefaults: s\.discussionDefaults/, 'keepAcrossSession 没保留默认槽')
    assert.match(keep, /discussionDefaultOverrides: s\.discussionDefaultOverrides/, 'keepAcrossSession 没保留覆盖表')
    assert.match(keep, /\.\.\.\(s\.discussionDefaults/, '新建一场的起点不是我的默认')
    assert.match(storeSrc, /reset: \(\): void => set\(\{ \.\.\.initial, \.\.\.keepAcrossSession/, 'reset 没走跨场保留')
    assert.match(storeSrc, /\.\.\.initial,\n\s*\.\.\.keepAcrossSession/, '回放历史没走跨场保留')
  })

  /* ── 状态层：真的跑一遍 ─────────────────────────────────────── */

  const S = h.store()
  const get = (): Config => S.getState()
  const cfgOf = (st: Config) => Object.fromEntries(keys.map((k) => [k, st[k]]))
  const defaultsOf = (st: Config) => st.discussionDefaults as Config
  const overridesOf = (st: Config) => st.discussionDefaultOverrides as Config
  const act = (name: string) => get()[name] as (...a: any[]) => void
  /** 冷启动：草稿与默认槽都从出厂起，然后灌入偏好 */
  const coldBoot = (patch: Config = {}) => {
    S.setState({ ...D, discussionDefaults: { ...D }, discussionDefaultOverrides: {} })
    act('hydrateDiscussionDefaults')(patch)
  }

  it('状态层：冷启动时「我的默认」就是开场页的起点', () => {
    coldBoot({ maxRounds: 9, verifyPass: 'off' })
    const st = get()
    assert.equal(st.maxRounds, 9, '偏好里的默认没进草稿 —— 设了默认却对开场页毫无影响')
    assert.equal(st.verifyPass, 'off')
    assert.equal(st.strategy, D.strategy, '没设的项不该被顺手改掉')
    assert.deepEqual(defaultsOf(st), { ...D, maxRounds: 9, verifyPass: 'off' })
  })

  it('状态层：冷启动前已拧过的草稿，偏好灌入时不覆盖它', () => {
    S.setState({ ...D, discussionDefaults: { ...D }, discussionDefaultOverrides: {}, maxRounds: 5 })
    act('hydrateDiscussionDefaults')({ maxRounds: 9 })
    assert.equal(get().maxRounds, 5, '用户手动拧过的草稿被偏好覆盖了')
    assert.equal(defaultsOf(get()).maxRounds, 9, '默认槽该照偏好走')
  })

  it('状态层：灌偏好时丢弃非法项，草稿与默认槽都不被脏值污染', () => {
    coldBoot({ maxRounds: 'abc', strategy: 'nope', topicTitle: '串场的键', budgetLimitUsd: 1e9 })
    const st = get()
    assert.deepEqual(Object.keys(overridesOf(st)), ['budgetLimitUsd'], `覆盖表被脏值污染：${JSON.stringify(overridesOf(st))}`)
    assert.equal(defaultsOf(st).budgetLimitUsd, 100_000, '越界的预算没夹紧')
    assert.equal(defaultsOf(st).maxRounds, D.maxRounds, '非法项被当成 0 写了进去')
    assert.equal(st.strategy, D.strategy)
    assert.equal(st.topicTitle, '', '偏好里的脏键漏进了运行态')
  })

  it('状态层：草稿没拧过时跟着新默认走', () => {
    coldBoot()
    act('setDiscussionDefault')('budgetLimitUsd', 5)
    const st = get()
    assert.equal(st.budgetLimitUsd, 5, '没手动拧过，草稿该跟随默认')
    assert.equal(defaultsOf(st).budgetLimitUsd, 5)
    assert.deepEqual(overridesOf(st), { budgetLimitUsd: 5 })
  })

  it('状态层：草稿拧过时保留用户拧的值', () => {
    coldBoot()
    S.setState({ budgetLimitUsd: 1 })
    act('setDiscussionDefault')('budgetLimitUsd', 7)
    const st = get()
    assert.equal(st.budgetLimitUsd, 1, '在设置页调默认值，把人手动拧过的预算覆盖掉了')
    assert.equal(defaultsOf(st).budgetLimitUsd, 7)
    assert.equal(overridesOf(st).budgetLimitUsd, 7)
  })

  it('状态层：默认值改回出厂值就退出覆盖表', () => {
    coldBoot({ maxRounds: 9 })
    assert.deepEqual(Object.keys(overridesOf(get())), ['maxRounds'])
    act('setDiscussionDefault')('maxRounds', D.maxRounds)
    const st = get()
    assert.deepEqual(overridesOf(st), {}, '与出厂相同的值还留在覆盖表里，恢复出厂就清不干净')
    assert.equal(defaultsOf(st).maxRounds, D.maxRounds)
    assert.equal(st.maxRounds, D.maxRounds, '草稿还留着旧默认')
  })

  it('状态层：非法值被丢弃，状态一动不动', () => {
    coldBoot()
    const before = JSON.stringify({ d: defaultsOf(get()), o: overridesOf(get()), c: cfgOf(get()) })
    for (const bad of ['abc', null, undefined, {}, true]) {
      act('setDiscussionDefault')('maxRounds', bad)
      act('setDiscussionDefault')('baseline', 'true')
    }
    assert.equal(JSON.stringify({ d: defaultsOf(get()), o: overridesOf(get()), c: cfgOf(get()) }), before, '非法值写坏了默认表')
  })

  it('状态层：越界输入落回区间边界', () => {
    coldBoot()
    act('setDiscussionDefault')('maxRounds', 999)
    assert.equal(defaultsOf(get()).maxRounds, 20, '上界没夹紧')
    assert.equal(get().maxRounds, 20, '草稿没跟着夹紧值走')
    act('setDiscussionDefault')('timeBudgetMin', 0)
    assert.equal(defaultsOf(get()).timeBudgetMin, SH.numberBound('timeBudgetMin')!.min, '下界没夹紧')
  })

  it('状态层：恢复默认值回到「我的默认」，不是出厂值', () => {
    coldBoot({ maxRounds: 9, budgetLimitUsd: 5 })
    S.setState({ budgetLimitUsd: 1 })
    act('resetDiscussionConfig')()
    const st = get()
    assert.equal(st.maxRounds, 9, '恢复到了出厂值而不是我的默认')
    assert.equal(st.budgetLimitUsd, 5, '手动拧过的草稿该被拉回我的默认')
    assert.deepEqual(cfgOf(st), defaultsOf(st), '恢复后的草稿与我的默认不一致')
    assert.notDeepEqual(cfgOf(st), D, '这里就不该等于出厂表')
  })

  it('状态层：恢复只回「怎么讨论」，用户写下的东西一概不动', () => {
    coldBoot({ strategy: 'debate' })
    S.setState({
      topicTitle: '写了半天的议题',
      topicBackground: '背景材料',
      participantIds: ['m1', 'm2'],
      moderatorId: 'm1',
      round: 2,
      state: 'DISCUSSING',
      utterances: [{ id: 'u1' }],
    })
    const keep = cfgOf(get())
    const before = get()
    act('resetDiscussionConfig')()
    const after = get()
    assert.deepEqual(cfgOf(after), keep, '恢复动作把草稿改到了别处')
    assert.equal(after.topicTitle, before.topicTitle, '议题标题被清掉了')
    assert.equal(after.topicBackground, before.topicBackground, '背景材料被清掉了')
    assert.deepEqual(after.participantIds, before.participantIds, '参与名单被动了')
    assert.equal(after.moderatorId, before.moderatorId, '主持指认被动了')
    assert.equal(after.round, before.round, '轮次被动了')
    assert.deepEqual(after.utterances, before.utterances, '发言被动了')
    assert.deepEqual(overridesOf(after), overridesOf(before), '恢复草稿不该顺带清掉我的默认')
  })

  it('状态层：恢复幂等，连点两次不是两次操作', () => {
    coldBoot({ maxRounds: 9 })
    const once = JSON.stringify(cfgOf(get()))
    act('resetDiscussionConfig')()
    act('resetDiscussionConfig')()
    assert.equal(JSON.stringify(cfgOf(get())), once)
    assert.deepEqual(h.diffFromDefaults(cfgOf(get()), defaultsOf(get())), [], '第二次进设置页仍显示有差异')
  })

  it('状态层：恢复出厂清掉覆盖表，只带走没手动拧过的草稿', () => {
    coldBoot({ maxRounds: 9, budgetLimitUsd: 5 })
    // maxRounds 的草稿还等于我的默认；budgetLimitUsd 被用户拧成了 1
    S.setState({ budgetLimitUsd: 1 })
    act('restoreFactoryDiscussionDefaults')()
    const st = get()
    assert.deepEqual(overridesOf(st), {}, '覆盖表没被清空')
    assert.deepEqual(defaultsOf(st), D, '默认槽没回到出厂表')
    assert.equal(st.maxRounds, D.maxRounds, '一直跟着默认的草稿该回到出厂值')
    assert.equal(st.budgetLimitUsd, 1, '用户手动拧过的草稿不该被动')
  })

  it('状态层：恢复出厂在没设过默认时是无操作', () => {
    coldBoot()
    const snapshot = JSON.stringify(get())
    act('restoreFactoryDiscussionDefaults')()
    assert.equal(JSON.stringify(get()), snapshot, '没有覆盖项时恢复出厂动了状态')
  })

  it('状态层：落盘失败重灌偏好时，把没成功的乐观值一起回滚', () => {
    coldBoot()
    act('setDiscussionDefault')('maxRounds', 9)
    // 主进程拒收后 App 从盘上读回真实的那份
    act('hydrateDiscussionDefaults')({})
    const st = get()
    assert.deepEqual(overridesOf(st), {})
    assert.equal(defaultsOf(st).maxRounds, D.maxRounds)
    assert.equal(st.maxRounds, D.maxRounds, '盘上没有，界面却还留着没存上的 9 —— 下次启动它会自己回滚')
  })

  it('状态层：reset() 清整场草稿，但不带走我的默认与模型阵容', () => {
    coldBoot({ maxRounds: 9 })
    S.setState({ models: [{ id: 'm1', displayName: 'A' }] as any, topicTitle: '草稿', participantIds: ['m1'], maxRounds: 15 })
    act('reset')()
    const st = get()
    assert.equal(st.topicTitle, '', 'reset() 该清议题')
    assert.deepEqual(st.participantIds, [], 'reset() 该清名单')
    assert.deepEqual(overridesOf(st), { maxRounds: 9 }, '新建一场把用户设的默认清掉了')
    assert.equal(defaultsOf(st).maxRounds, 9)
    assert.equal(st.maxRounds, 9, '新建一场的起点该是我的默认，不是出厂值')
    assert.deepEqual(st.models, [{ id: 'm1', displayName: 'A' }], 'reset() 不该清模型阵容')
  })

  /* ── 接线层 ─────────────────────────────────────────────────── */

  it('接线层：设置页把六样都传给配置区，组件仍不碰 IPC', () => {
    const settings = readSrc('src/renderer/components/SettingsPage.tsx')
    assert.match(settings, /id: 'discussion', label: '讨论参数'/, '讨论参数没进设置页导航')
    assert.match(settings, /import \{ ConfigDefaultsSection \} from '\.\/ConfigDefaultsSection'/, '设置页没引入配置区组件')
    for (const decl of [
      /config: DiscussionConfig/,
      /defaults: DiscussionConfig/,
      /customizedDefaults: DiscussionConfigKey\[\]/,
      /onResetConfig: \(\) => void/,
      /onSetDefault: \(key: DiscussionConfigKey, value: unknown\) => void/,
      /onRestoreFactoryDefaults: \(\) => void/,
    ]) {
      assert.match(settings, decl, `设置页少了一个入参声明：${decl}`)
    }
    const usage = slice(settings, '<ConfigDefaultsSection', '/>', '配置区用法')
    for (const wire of ['config={config}', 'defaults={defaults}', 'customized={customizedDefaults}', 'onReset={onResetConfig}', 'onSetDefault={onSetDefault}', 'onRestoreFactory={onRestoreFactoryDefaults}']) {
      assert.ok(usage.includes(wire), `配置区没接上 ${wire}`)
    }
    assert.doesNotMatch(sectionSrc, /window\.torra/, '配置区自己调 IPC，写权限就漏出 store 了')
    assert.doesNotMatch(sectionSrc, /useStore/, '配置区绕过 props 直接读写 store')
  })

  it('接线层：App 启动灌偏好、改动即落盘、失败重灌', () => {
    const app = readSrc('src/renderer/App.tsx')
    assert.match(app, /s\.hydrateDiscussionDefaults\(await window\.torra\.getDiscussionDefaults\(\)\)/, '启动时没把偏好里的默认灌进 store')
    const persist = slice(app, 'const persistDiscussionDefaults =', '\n  const handleSetDiscussionDefault', '落盘函数')
    assert.match(persist, /window\.torra\.setDiscussionDefaults\(useStore\.getState\(\)\.discussionDefaultOverrides\)/, '落盘写的不是覆盖表')
    assert.match(persist, /if \(!r\.ok\)/, '写失败没处理')
    assert.match(persist, /warnToast/, '写失败只静默回滚，不告诉用户')
    assert.match(persist, /s\.hydrateDiscussionDefaults\(await window\.torra\.getDiscussionDefaults\(\)\)/, '写失败没从主进程读回真实值')
    assert.match(app, /s\.setDiscussionDefault\(key, value\)\n\s*await persistDiscussionDefaults/, '改单项没先更状态再落盘')
    assert.match(app, /s\.restoreFactoryDiscussionDefaults\(\)\n\s*await persistDiscussionDefaults/, '恢复出厂没落盘')
    const usage = slice(app, '<SettingsPage', '\n            />', 'SettingsPage 用法')
    for (const wire of ['defaults={s.discussionDefaults}', 'customizedDefaults={customizedDefaults(s.discussionDefaultOverrides)}', 'onSetDefault={(key, value) => void handleSetDiscussionDefault(key, value)}', 'onRestoreFactoryDefaults={() => void handleRestoreFactoryDefaults()}', 'onResetConfig={() => s.resetDiscussionConfig()}']) {
      assert.ok(usage.includes(wire), `App 没把 ${wire} 交给设置页`)
    }
    assert.doesNotMatch(app, /setDiscussionDefaults\(\{[^}]*strategy:/, 'App 把整份草稿当默认表写盘')
  })

  it('接线层：主进程两个通道都 sanitize，preload 通道名对得上', () => {
    const mainSrc = readSrc('src/main/index.ts')
    const preload = readSrc('src/preload/index.ts')
    const get = slice(mainSrc, "ipcMain.handle('discussion-defaults:get'", '\n  ipcMain.handle(\'discussion-defaults:set\'', 'get 通道')
    const setH = slice(mainSrc, "ipcMain.handle('discussion-defaults:set'", "// ---- 区域尺寸", 'set 通道')
    assert.match(get, /sanitizeDiscussionDefaults\(\(await readPreferences\(\)\)\.discussionDefaults\)/, '读偏好没过 sanitize')
    assert.match(setH, /patchPreferences\(\{ discussionDefaults: sanitizeDiscussionDefaults\(patch\) \}\)/, '写偏好没过 sanitize')
    assert.match(preload, /'discussion-defaults:get'/, 'preload 的读通道名与主进程不一致')
    assert.match(preload, /'discussion-defaults:set'/, 'preload 的写通道名与主进程不一致')
    assert.match(preload, /getDiscussionDefaults: \(\): Promise<DiscussionDefaultsPatch>/, 'preload 读方法的类型不是覆盖表')
    assert.match(preload, /setDiscussionDefaults: \(patch: DiscussionDefaultsPatch\): Promise<\{ ok: boolean; reason\?: string \}>/, 'preload 写方法没声明返回 ok')
  })

  it('接线层：套件已挂进 npm test 链', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    assert.match(String(pkg.scripts['test:config-defaults']), /scripts\/test-config-defaults\.ts/, '缺独立脚本项')
    assert.match(String(pkg.scripts.test), /run-tests/, 'npm test 必须走 scripts/run-tests.js 汇总跑法')
  })

  /* ── 产物层：SSR 结构 ───────────────────────────────────────── */

  it('产物层：每一行都给名称、说明与出厂值', () => {
    const html = h.renderSection({ ...D })
    assert.equal((html.match(/class="st-row"/g) ?? []).length, h.ROWS.length, '行数与界面行表不一致')
    const positions = h.ROWS.map((r) => html.indexOf(r.name))
    assert.ok(positions.every((p) => p >= 0), '有参数行没被渲染出来')
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '渲染顺序与行表顺序不一致')
    for (const r of h.ROWS) {
      assert.ok(html.includes(r.hint), `${r.name} 的说明没显示`)
      assert.ok(html.includes(`出厂 ${h.formatConfigValue(r.key, D[r.key])}`), `${r.name} 没给出厂值`)
    }
    assert.equal((html.match(/出厂 /g) ?? []).length, h.ROWS.length, '每行都该有出厂值锚点')
  })

  it('产物层：数字行用输入框，区间与 step 来自 shared', () => {
    const html = h.renderSection({ ...D })
    const tags = (html.match(/<input[^>]*>/g) ?? []).map(attrs)
    assert.equal(tags.length, 3, `数字输入框应有 3 个，实为 ${tags.length}`)
    for (const r of h.ROWS) {
      const b = SH.numberBound(r.key)
      if (!b) continue
      const t = tags.find((x) => x['aria-label'] === `${r.name}默认值`)
      assert.ok(t, `${r.name} 的默认值输入框找不到可访问名`)
      assert.equal(t!.type, 'number')
      assert.equal(t!.class, 'st-num')
      assert.equal(t!.min, String(b.min), `${r.name} 的下界不是 shared 的`)
      assert.equal(t!.max, String(b.max), `${r.name} 的上界不是 shared 的`)
      assert.equal(t!.step, String(b.step), `${r.name} 的步长不是 shared 的`)
    }
  })

  it('产物层：枚举行用分段按钮、开关行用 switch，都带可访问名', () => {
    const html = h.renderSection({ ...D })
    const strategy = SH.enumValues('strategy')
    const segs = (html.match(/<button class="st-seg-item[^"]*"[^>]*>/g) ?? []).map(attrs)
    assert.equal(segs.length, strategy.length + SH.enumValues('verifyPass').length, '分段按钮数不等于两个枚举的取值数')
    assert.ok(segs.some((s) => s.class === 'st-seg-item on' && s['aria-pressed'] === 'true'), '当前默认值那一段没高亮')
    assert.ok(/<div class="st-seg" role="group" aria-label="讨论策略默认值"/.test(html), '分段按钮组没有可访问名')
    const switches = (html.match(/<button class="st-switch[^"]*"[^>]*>/g) ?? []).map(attrs)
    assert.equal(switches.length, 3, `开关应有 3 个，实为 ${switches.length}`)
    for (const t of switches) assert.equal(t.role, 'switch', '开关缺 role，读屏念不出状态')
    assert.ok(switches.every((t) => /默认值$/.test(t['aria-label'] ?? '')), '开关没有可访问名')
    assert.doesNotMatch(html, /<select/, '原生 <select> 的弹层会被带 backdrop-filter 的祖先渲染成纯黑')
  })

  it('产物层：显示的是「我的默认」，出厂值只作对照', () => {
    const html = h.renderSection({ ...D }, { maxRounds: 9 })
    const tag = (html.match(/<input[^>]*aria-label="最大轮次默认值"[^>]*>/g) ?? []).map(attrs)[0]
    assert.equal(tag!.value, '9', '输入框显示的还是出厂值')
    assert.ok(html.includes('出厂 3 轮'), '出厂值没作为对照显示')
    assert.equal((html.match(/我的默认/g) ?? []).length, 1, 'chip 数应等于被改过的项数')
    assert.ok(html.includes('1 项默认已被你改过'), '抬头没说明有几项默认被改过')
    assert.ok(!html.includes('默认值全部为出厂值'), '有覆盖项时抬头不该报「全为出厂值」')
  })

  it('产物层：草稿差异按「我的默认」判，不按出厂判', () => {
    // 我的默认 = 9、草稿 = 9：没有可恢复的东西，尽管草稿与出厂不同
    const aligned = h.renderSection({ ...D, maxRounds: 9 }, { maxRounds: 9 })
    assert.equal((aligned.match(/草稿未改/g) ?? []).length, h.ROWS.length, '草稿与我的默认一致却整页报差异')
    assert.ok(/<button class="st-btn"[^>]*disabled=""[^>]*aria-label="把开场页的讨论参数恢复为默认值"/.test(aligned), '无差异时恢复按钮还亮着')
    const off = h.renderSection({ ...D, maxRounds: 5, verifyPass: 'off' }, { maxRounds: 9 })
    assert.ok(off.includes('草稿 5 轮'), '差异行没显示草稿值')
    assert.ok(off.includes('草稿 关闭'), '核验轮的草稿值没显示成人话')
    assert.equal((off.match(/草稿未改/g) ?? []).length, h.ROWS.length - 2, '「草稿未改」标记数不对')
    assert.ok(off.includes('把开场页的 2 项拉回你的默认值'), '恢复按钮没说明它会改几项')
  })

  it('产物层：两个按钮各有名字与解释，出厂态只禁「恢复出厂默认」', () => {
    const html = h.renderSection({ ...D })
    const btns = (html.match(/<button class="st-btn"[^>]*>/g) ?? []).map(attrs)
    assert.equal(btns.length, 2, '该有两个按钮：恢复出厂默认与恢复默认值')
    const labels = btns.map((b) => b['aria-label'])
    assert.deepEqual([...labels].sort(), ['把开场页的讨论参数恢复为默认值', '把讨论参数的默认值清回出厂值'].sort(), '两个按钮的可访问名不够区分')
    const factoryBtn = btns.find((b) => b['aria-label']!.includes('清回出厂值'))!
    assert.equal(factoryBtn.disabled, '', '没设过默认时「恢复出厂」还亮着')
    assert.equal(factoryBtn.title, '没有自设默认值，当前就是出厂值', '禁用态没给出原因')
    assert.ok(/<span class="wm-tally ok">默认值全部为出厂值/.test(html), '出厂态抬头没走 ok 样式')
  })

  it('产物层：数字框敲键盘期间不落盘，离开输入框或回车才提交', () => {
    // 每敲一个字符就写一次偏好，中间那次还是用户从没打算要过的默认值
    assert.match(sectionSrc, /onChange=\{\(e\) => setText\(e\.target\.value\)\}/, '数字框的 onChange 不该直接提交')
    assert.match(sectionSrc, /onBlur=\{\(\) => \{\s*setFocused\(false\)\s*commit\(\)/, '离开输入框没提交')
    assert.match(sectionSrc, /if \(e\.key === 'Enter'\)/, '回车没提交')
    assert.match(sectionSrc, /if \(!focused\) setText\(String\(value\)\)/, '聚焦期间外部值回填，会把半截输入打回去')
    assert.match(sectionSrc, /if \(raw === '' \|\| !Number\.isFinite\(n\)\)/, '空框/读不出数没退回现值（Number("") 是 0，会被当成把预算改成 0）')
  })

  it('产物层：沿用设置页既有类名，不新造卡片盒与彩色装饰', () => {
    const html = h.renderSection({ ...D, budgetLimitUsd: 9 })
    assert.ok(html.includes('class="st-section"') && html.includes('class="st-list"'), '没复用设置页的区块结构')
    assert.ok(html.includes('class="st-sec-head"') && html.includes('class="st-sec-actions"'), '没用设置页的抬头结构')
    assert.ok(html.includes('class="st-muted"'), '出厂值没走弱化的说明样式')
    // 8 行「未改」+ 抬头那枚「默认值全部为出厂值」
    assert.equal((html.match(/class="wm-tally ok"/g) ?? []).length, h.ROWS.length, 'ok 态 tally 数不对')
    assert.doesNotMatch(html, /class="[^"]*\bcard\b/, '引入了卡片盒类名')
    assert.doesNotMatch(html, /linear-gradient|box-shadow/, '引入了渐变/阴影装饰')
    assert.ok(!html.includes('st-inline-msg'), '没点过就不该有提示')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

main()
