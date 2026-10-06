/**
 * styles.css 与标记层契约的离线守卫（纯静态扫描，不需要 Electron）
 *
 * 这条守卫要防的错，本仓库自己犯了 11 轮：backlog 长期把
 * 「.utterance-card / .u-card / .msg-card 无消费方」和「深色主题里混了浅色 #f7f6f3」
 * 记成美观性/可维护性的扣分证据。第 12 轮实测把两条都推翻了：
 * - 应用本来就是双主题（styles.css:64 写明「白天=纸白玻璃；黑夜见 [data-theme='dark']」），
 *   #f7f6f3 是浅色层的纸白，不是混进深色里的错色；
 * - 867 个类名里 34 个「字面零引用」，其中 26 个是 `tone-${tone}` / `te-${kind}` 这类
 *   拼接出来的现役样式。照旧证据删它们，会把论题演化连线、右栏徽章、立场配色整片弄坏。
 * 旧扫描看不出这一点的原因很具体：拼接前缀只从「紧跟引号的前缀」里找，
 * 而 `cs-meter-fill tone-${tone}` 这种前缀在字符串中段 —— 漏检。
 *
 * 钉四层：
 * - 解析层：只认「选择器位」上的类名（属性值里的点、注释里的选择器不算），@media 内的要收到；
 * - 拼接层：前缀检测覆盖字符串任意位置，`${}` 与 `"…" +` 两种写法都认；
 * - 现状层：src 里既无字面引用、又不落在拼接前缀下的类名，只允许出现在登记过的例外里；
 * - 反向层：本轮删掉的类名确实没了，被误判为死规则的那批必须还在。
 *
 * 运行：npm run test:css-dead-rules
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const CSS_REL = 'src/renderer/styles.css'

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

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 去掉块注释，免得注释里的示例选择器被当成规则 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 只从「选择器位」取类名：自上一个 { 、} 或 ; 以来、紧挨着 { 的那段才是选择器。
 * 这样 content: '.x' 与 font-size: 1.5rem 都不会被误认成类名。
 */
function classSelectors(css: string): Set<string> {
  const text = stripComments(css)
  const out = new Set<string>()
  let pending = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      for (const m of pending.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) out.add(m[1])
      pending = ''
    } else if (ch === '}' || ch === ';') pending = ''
    else pending += ch
  }
  return out
}

/**
 * 动态拼接出来的类名前缀：xxx-${…} 或 "xxx-" + …。
 * 关键是不要求前缀紧跟引号 —— 现役代码大半写的是 ``… tone-${tone}`` 这种中段形式。
 */
function dynamicPrefixes(source: string): Set<string> {
  const out = new Set<string>()
  for (const m of source.matchAll(/([A-Za-z_][A-Za-z0-9_-]*-)(?=\s*\$\{)/g)) out.add(m[1])
  for (const m of source.matchAll(/([A-Za-z_][A-Za-z0-9_-]*-)(?=\s*["'`]\s*\+)/g)) out.add(m[1])
  return out
}

/**
 * 死选择器：字面在消费方文本里一次都不出现，且不属于任何拼接前缀。
 * 两个条件都不满足才算死 —— 判据宁可漏删，不可误删。
 */
function deadSelectors(classes: Iterable<string>, consumers: string, prefixes: Set<string>): string[] {
  const dead: string[] = []
  for (const name of classes) {
    if (consumers.includes(name)) continue
    let composed = false
    for (const p of prefixes) {
      if (name.startsWith(p)) { composed = true; break }
    }
    if (!composed) dead.push(name)
  }
  return dead
}

/** 消费方 = src 下的 ts/tsx/js/html：className 只可能出现在这里，用例文本不算消费方 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) collectSources(rel, out)
    else if (/\.(ts|tsx|js|html)$/.test(e.name)) out.push(rel)
  }
  return out
}

const SRC_FILES = collectSources('src')
const SRC_TEXT = SRC_FILES.map(read).join('\n')

const CSS = read(CSS_REL)
const CLASSES = classSelectors(CSS)
const PREFIXES = dynamicPrefixes(SRC_TEXT)

/**
 * 已登记例外：广播提示条一族的 4 个类名。
 * src 侧确实已经没有标记了，但这一族不能由本轮删：
 * - scripts/test-session.ts:388-395 正在断言 `.broadcast-hint { flex: 0 0 44px }`，
 *   它守的是「提示条不与原生 WebContentsView 重叠」这条布局口径（与 pool 的 BOTTOM=44 成对）；
 * - 网页视图那一列此刻正被另一个会话重排（RightPanel.tsx 在其暂存区）。
 * 结论待定后，把名字从这份清单里删掉即可让守卫继续生效。
 */
const KNOWN_PENDING = ['bh-row', 'bh-sub', 'broadcast-hint', 'broadcast-slot']

/** 本轮删掉的：卡片盒三名（项目既定「不用卡片盒」后就没有标记了）、modal 的旧别名、首页页签旧名 */
const REMOVED = ['home-mode-tabs', 'msg-card', 'modal-backdrop', 'u-card', 'utterance-card']

/** 曾被 backlog 当作「死规则」，实际由拼接生成的现役样式：它们必须还在 */
const COMPOSED_STILL_LIVE = ['k-held', 'rp-badge-all', 'stance-support', 'te-human', 'tl-consensus', 'tn-warn', 'tone-muted']

main()

function main(): void {
  console.log('\n=== styles.css 死选择器守卫 ===\n')

  it('解析层：只认选择器位，属性值里的点不算类名', () => {
    const css = ".real { content: '.fake'; background: url(a.b.c) }\n.other { top: 1.5px; }"
    assert.deepEqual([...classSelectors(css)].sort(), ['other', 'real'])
  })

  it('解析层：注释里的选择器不算，@media 里的要算', () => {
    const css = '/* .doc { color:red } */\n@media (max-width: 600px) { .in-media { display:none } }\n.live { color: blue }'
    const got = [...classSelectors(css)].sort()
    assert.ok(!got.includes('doc'), '注释里的选择器被当成了规则')
    assert.deepEqual(got, ['in-media', 'live'])
  })

  it('解析层：真文件确实读到了量级（防解析器退化）', () => {
    assert.ok(CLASSES.size > 500, `只解析出 ${CLASSES.size} 个类名，解析器多半坏了`)
    assert.ok(SRC_FILES.length > 90, `只读到 ${SRC_FILES.length} 个源文件`)
  })

  it('拼接层：${} 与 "…" + 两种写法都认，且不看引号在不在前面', () => {
    const src = [
      'const a = <i className={`cs-meter-fill tone-${tone}`} />',
      "const b = <i className={'bh-' + k} />",
      'const c = <i className="plain-name" />',
    ].join('\n')
    const p = dynamicPrefixes(src)
    assert.ok(p.has('tone-'), '模板字面量中段的前缀没认出来')
    assert.ok(p.has('bh-'), '字符串相加的前缀没认出来')
    assert.ok(!p.has('plain-name'), '非拼接名字不该被当成前缀')
  })

  it('拼接层：同一名字，有前缀就不算死，没前缀才算死', () => {
    const consumers = 'className={`x tone-${t}`}'
    assert.deepEqual(deadSelectors(['tone-muted', 'u-card'], consumers, dynamicPrefixes(consumers)), ['u-card'])
  })

  it('拼接层：旧扫描的漏检写法现在能认出来（本轮翻案的依据）', () => {
    // 只从引号后找前缀的写法会漏掉这一段，于是 26 个现役类名被当成死规则
    assert.ok(PREFIXES.has('tone-'), 'tone- 前缀没被识别：中段的 `${}` 拼接又看不见了')
    for (const n of COMPOSED_STILL_LIVE) {
      const pfx = n.replace(/-[^-]*$/, '-')
      assert.ok(PREFIXES.has(pfx), `${pfx} 不再是拼接前缀，这批名字要重新逐个核实`)
    }
  })

  it('现状层：src 里无引用、又非拼接的类名，只剩登记过的那批例外', () => {
    const dead = deadSelectors(CLASSES, SRC_TEXT, PREFIXES).sort()
    assert.deepEqual(dead, KNOWN_PENDING, '死选择器与登记例外不一致：' + dead.join(' '))
  })

  it('现状层：登记例外必须仍在样式表里（有人删了就要同步清单）', () => {
    for (const n of KNOWN_PENDING) {
      assert.ok(new RegExp('\\.' + n + '(?![A-Za-z0-9_-])').test(CSS), `.  ${n} 已不在样式表里，请把它从 KNOWN_PENDING 删掉`)
    }
  })

  it('反向层：本轮删掉的 5 个类名，规则确实不在样式表里了', () => {
    for (const n of REMOVED) {
      assert.ok(!new RegExp('\\.' + n + '(?![A-Za-z0-9_-])').test(CSS), `.  ${n} 还在`)
      // 也不该在 src 里复活成消费方，否则这条用例是假通过
      assert.ok(!SRC_TEXT.includes(n), `${n} 在 src 里又出现了，REMOVED 清单要同步`)
    }
  })

  it('反向层：被误判为死规则的 7 个拼接类名必须还在（防止照旧证据二次删除）', () => {
    for (const n of COMPOSED_STILL_LIVE) {
      assert.ok(new RegExp('\\.' + n + '(?![A-Za-z0-9_-])').test(CSS), `.  ${n} 被删掉了 —— 它是由前缀拼出来的现役样式`)
    }
  })

  it('反向层：现役替代名没被顺手删掉', () => {
    assert.match(CSS, /\.modal-mask\s*[.,{]/, '.modal-mask 规则不见了（App.tsx:823 在用）')
    assert.match(CSS, /\.mode-tabs\s*[.,{]/, '.mode-tabs 规则不见了')
    assert.match(CSS, /\.io-panel\s*,/, '.io-panel 与本无关，被连带删了')
    assert.match(CSS, /\.te-card\s\*\s\{/, '.te-card 与本无关，被连带删了')
  })

  it('接线层：套件已挂进 npm test 链', () => {
    const pkg = JSON.parse(read('package.json'))
    assert.match(String(pkg.scripts['test:css-dead-rules']), /scripts\/test-css-dead-rules\.ts/, '缺独立脚本项')
    assert.match(String(pkg.scripts.test), /run-tests/, 'npm test 必须走 scripts/run-tests.js 汇总跑法')
    assert.ok(!String(pkg.scripts.test).includes('&&'), 'npm test 不该回到 && 串链')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}
