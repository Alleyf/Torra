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
 *
 * 研讨屏重做（正文 = 论题演化图 + 跟随条）之后，旧登记的那 50 个名字已经随组件一起清了：
 * df- / discussion-flow / discussion-status-bar / dsb- / flow-finish / round-group|divider|live-dot|progress-text /
 * io-panel|block|label|text|copy|stat(s) / think-* / steps-box / rp-tabs|count|body / right-panel / wide /
 * consensus-panel / convergence-line / absent-* / cite-flag / stance- 一族。
 * 「删规则与删组件是同一个决定」—— 组件定了，规则就跟着走，只留上面这一族还没定的。
 * 保留的替代名：立场徽标走 `te-stance-${stance}`，思考/执行折叠走 `.te-fold`，
 * 缺席 chip 走 `.te-absent`，状态条走 `.te-status`；右栏收成单列滚动（`.rb-aside`），不再分屏。
 */
const KNOWN_PENDING = ['bh-row', 'bh-sub', 'broadcast-hint', 'broadcast-slot']

/**
 * 删掉的类名：规则和标记一起走。
 * 前 5 个是上一轮（卡片盒三名 + modal 旧别名 + 首页页签旧名）；
 * 后面这一批随研讨屏重做下线 —— 正文换成论题演化图 + 跟随条后，
 * 旧议事厅（DiscussionFlow）、旧右栏三屏（right-panel / rp- / consensus-panel）
 * 与旧折叠面（think- / steps-box / io-panel 一族）连 DOM 带规则一起退役。
 * 替代名必须还活着，所以它们在上面那条用例里单独盯。
 */
const REMOVED = [
  'home-mode-tabs', 'msg-card', 'modal-backdrop', 'u-card', 'utterance-card',
  'absent-detail', 'absent-detail-toggle', 'absent-tag', 'cite-flag',
  'consensus-panel', 'convergence-line', 'df-jump', 'df-jump-count',
  'discussion-flow', 'discussion-status-bar', 'dsb-absent', 'dsb-center', 'dsb-left',
  'dsb-phase', 'dsb-phase-icon', 'dsb-progress-fill', 'dsb-progress-track', 'dsb-right',
  'dsb-round', 'dsb-streaming', 'dsb-wrap', 'flow-finish',
  'io-block', 'io-copy', 'io-label', 'io-panel', 'io-stat', 'io-stats', 'io-text',
  'right-panel', 'round-divider', 'round-group', 'round-live-dot', 'round-progress-text',
  'rp-body', 'rp-count', 'rp-tabs',
  'stance-conditional', 'stance-oppose', 'stance-support', 'stance-tag',
  'steps-box', 'think-box', 'think-head', 'think-text', 'think-toggle', 'wide',
  // 发言卡本体：正文只剩跟随条那一张卡，排版已搬进 .te-card .te-card-body
  'u-absent-main', 'u-absent-row', 'u-avatar', 'u-body', 'u-callout', 'u-callout-chip',
  'u-clamp', 'u-content', 'u-expand', 'u-flag', 'u-head', 'u-id', 'u-idtext',
  'u-metric', 'u-name', 'u-note', 'u-round', 'u-streaming', 'u-sub', 'u-tool', 'u-tools',
  // 报告层重做（三套策略框架）：纯色彩卡片一族连规则带标记一起走。
  // `.rp-bar` 也删了，但它不能进这份清单 —— 它是活着的 rp-bar-utt / rp-bar-cite 的子串，
  // 那条用例会因「src 里还出现这个名字」而假失败。
  'rp-coverage', 'rp-coverage-label', 'rp-coverage-n',
  'rp-figs-outcome', 'rp-hero-hint', 'rp-hero-hint-sep',
  'rp-meter', 'rp-meter-label', 'rp-meter-value', 'rp-meters',
  'rp-outcome', 'rp-outcome-body', 'rp-outcome-consensus', 'rp-outcome-dispute',
  'rp-outcome-hint', 'rp-outcome-label', 'rp-outcome-n',
  // 条目卡与章节的左侧彩条：识别交给序号、图标与徽标，彩条一族不再回来
  'rp-item-consensus', 'rp-item-dispute',
]

/** 曾被 backlog 当作「死规则」，实际由拼接生成的现役样式：它们必须还在 */
const COMPOSED_STILL_LIVE = ['k-held', 'rp-badge-all', 'rp-kpi-ok', 'te-human', 'te-consensus', 'tn-warn', 'tone-muted']

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
    assert.ok(PREFIXES.has('te-stance-'), '正文跟随条上的立场徽标是 `te-stance-${u.stance}` 拼出来的，别当死规则')
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

  it(`反向层：删掉的 ${REMOVED.length} 个类名，规则确实不在样式表里了`, () => {
    for (const n of REMOVED) {
      assert.ok(!new RegExp('\\.' + n + '(?![A-Za-z0-9_-])').test(CSS), `.  ${n} 还在`)
      // 也不该在 src 里复活成消费方，否则这条用例是假通过
      assert.ok(!SRC_TEXT.includes(n), `${n} 在 src 里又出现了，REMOVED 清单要同步`)
    }
  })

  it(`反向层：被误判为死规则的 ${COMPOSED_STILL_LIVE.length} 个拼接类名必须还在（防止照旧证据二次删除）`, () => {
    for (const n of COMPOSED_STILL_LIVE) {
      assert.ok(new RegExp('\\.' + n + '(?![A-Za-z0-9_-])').test(CSS), `.  ${n} 被删掉了 —— 它是由前缀拼出来的现役样式`)
    }
  })

  it('反向层：替代名没被顺手删掉', () => {
    assert.match(CSS, /\.modal-mask\s*[.,{]/, '.modal-mask 规则不见了（App.tsx:823 在用）')
    assert.match(CSS, /\.mode-tabs\s*[.,{]/, '.mode-tabs 规则不见了')
    // 收窄过的共用选择器：删掉退役的那段，留下的那段还得在
    assert.match(CSS, /\.history-page\s*[.,{]/, '.discussion-flow 与它同一条选择器，收窄时把它一起弄丢了')
    assert.match(CSS, /\.cx-q-text\s*[.,{]/, '.cx-q-text 与 u-content 同一条选择器，收窄时得留着它')
    assert.doesNotMatch(CSS, /\.utterance(?![A-Za-z0-9_-])/, '.utterance 的规则不见了？它该随旧发言卡一起没了')
    // 跟随条接过了发言排版：这些替代名要在，否则正文只剩裸文本
    assert.match(CSS, /\.te-card \.te-card-body \.md strong \{/, '.te-card-body 的 .md 排版没接上（旧 .u-content 那套）')
    assert.match(CSS, /\.te-card \.te-card-body \.md p:has\(/, '段首带标签的段落丢了左侧短轨')
    // 旧议事厅那一层的职责由正文接手：这几名要是也没了，明暗两版就得各写一套
    assert.match(CSS, /\.te-status\s*[.,{]/, '.te-status 不见了（状态条：轮次 / 缺席 / 阶段耗时）')
    assert.match(CSS, /\.te-absent\s*[.,{]/, '.te-absent 不见了（缺席 chip 的替代名）')
    assert.match(CSS, /\.te-fold\s*[.,{]/, '.te-fold 不见了（思考/执行折叠的替代名）')
    assert.match(CSS, /\.te-stance-support\s*[.,{]/, '.te-stance-* 不见了（立场徽标的替代名）')
    assert.match(CSS, /\.te-card\s\*\s\{/, '.te-card 深色兜底不在，卡片子元素会失去继承色')
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
