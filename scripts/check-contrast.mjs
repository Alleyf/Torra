// 工作台设计 token 的对比度与色相核对器
//
// 「层级靠明暗、语义靠色相」这两件事都能用数判死，所以别靠眼睛：
// 眼睛会把 3.3:1 看成「差不多」，也会把差 2° 的两个黄橙看成「一个品牌色一个警告色」。
//
// 色值一律从各自的 register 里读出来量。本脚本不存第二份色板 —— 存了就等于允许它
// 和界面各走各的，那种门禁只会自我安慰。
//
// 两套色板是两回事，所以各有各的量法：
//   · 科研工作台外壳与嵌套的 scholar / trajectory / server 共用同一份墨。外壳出 token，
//     模块只许引用 —— 模块自带一份色板就是第二块屏幕，改一处亮一处暗。
//   · 技术工作台（日历）是另一个产品，保留自己的青绿主色，但门槛与科研一致：
//     对它逐项测量，而不是禁止它有色板。
//
// 用法：
//   node scripts/check-contrast.mjs                  # 核对两套色板的两个 register（npm test 走同一条）
//   node scripts/check-contrast.mjs --palette dark   # 生成一套候选墨色（每档都过门槛）
//   node scripts/check-contrast.mjs --palette dark --for tech
//   node scripts/check-contrast.mjs --help
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** 模块只认外壳注进来的量表，不许自己落颜色；tech 有自己的 register，走下面的 PALETTES。 */
const NESTED_MODULES = ['scholar', 'trajectory', 'server'].map(
  (m) => `plugins/research/modules/${m}/ui.html`,
)

// 正文门槛 4.5:1（WCAG 2.2 AA）：小字不拿「大字 3:1」当借口，压在色块上的字同理。
const TEXT_MIN = 4.5
const FILL_TEXT_MIN = 4.5
// 控件边界是非文本元素，按 1.4.11 的 3:1；容器装饰线本来就该轻，只报数不判死。
const LINE_STRONG_MIN = 3
// 一个色相不许兼两个语义：accent 与 amber 从前只差 2°，于是整屏的「主色」和「警告」
// 是同一个颜色，看着就是一片黄。这条就是防它回来的。
const MIN_HUE_GAP = 20

const PALETTES = [
  {
    id: 'research',
    name: '科研工作台外壳',
    file: 'plugins/research/ui.html',
    prefix: '--rw-',
    // 文字色要在它可能落的每一块底上过门槛：纸面、卡片、次级面、凸起、左轨。
    // 只对纸面量，等于把卡片上的那一半放过了 —— 而卡片才是文字最常待的地方。
    surfaces: ['--rw-bg', '--rw-surface', '--rw-surface-2', '--rw-raised', '--rw-rail'],
    text: [
      '--rw-ink', '--rw-ink-2', '--rw-ink-3', '--rw-ink-4', '--p-muted',
      '--rw-accent', '--rw-accent-ink', '--rw-hot', '--rw-amber', '--rw-ok',
    ],
    // 实心色块上的字：按钮、状态徽标。这块最容易漏 —— 色板好看，字压上去就糊了。
    fills: [
      ['--rw-accent', '--rw-accent-contrast'],
      ['--rw-hot', '--rw-hot-contrast'],
      ['--rw-amber', '--rw-amber-contrast'],
      ['--rw-ok', '--rw-ok-contrast'],
    ],
    // 语义色做成浅底徽标时的字：soft 是带 alpha 的染色，量之前得先跟真底混一次。
    softs: [
      ['--rw-accent-ink', '--rw-accent-soft'],
      ['--rw-hot', '--rw-hot-soft'],
      ['--rw-amber', '--rw-amber-soft'],
      ['--rw-ok', '--rw-ok-soft'],
    ],
    badgePapers: ['--rw-surface', '--rw-raised'],
    semantic: ['--rw-accent', '--rw-hot', '--rw-amber', '--rw-ok'],
    lineStrong: ['--rw-line-strong', '--rw-surface'],
    line: ['--rw-line', '--rw-surface'],
  },
  {
    id: 'tech',
    name: '技术工作台',
    file: 'plugins/tech/ui.html',
    prefix: '--wb-',
    surfaces: ['--wb-bg', '--wb-surface', '--wb-surface-2', '--wb-raised', '--wb-sidebar'],
    text: [
      '--wb-ink', '--wb-ink-2', '--wb-ink-3', '--wb-ink-4', '--p-muted',
      '--wb-accent', '--wb-accent-ink', '--wb-hot', '--wb-amber', '--wb-ok',
    ],
    fills: [
      ['--wb-accent', '--wb-accent-contrast'],
      ['--wb-hot', '--wb-hot-contrast'],
      ['--wb-amber', '--wb-amber-contrast'],
      ['--wb-ok', '--wb-ok-contrast'],
    ],
    softs: [
      ['--wb-accent-ink', '--wb-accent-soft'],
      ['--wb-hot', '--wb-hot-soft'],
      ['--wb-amber', '--wb-amber-soft'],
      ['--wb-ok', '--wb-ok-soft'],
    ],
    badgePapers: ['--wb-surface', '--wb-raised'],
    semantic: ['--wb-accent', '--wb-hot', '--wb-amber', '--wb-ok'],
    lineStrong: ['--wb-line-strong', '--wb-surface'],
    line: ['--wb-line', '--wb-surface'],
  },
]

function lum(hex) {
  const c = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16))
  const f = (x) => {
    const s = x / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function ratio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
function hue(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255)
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  if (!d) return null
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return Math.round((((h * 60) % 360) + 360) % 360)
}
/** 色相是个环：350° 与 10° 只差 20°，不能直接相减。 */
function hueGap(a, b) {
  if (a === null || b === null) return 999
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}
/** 带 alpha 的染色层要先跟真底混一次才可比 —— 直接拿 rgba 算亮度等于把它当透明。 */
function blend(fore, alpha, back) {
  const a = fore.replace('#', '').match(/../g).map((x) => parseInt(x, 16))
  const b = back.replace('#', '').match(/../g).map((x) => parseInt(x, 16))
  return `#${a.map((x, i) => Math.round(x * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}
function parseRgba(text) {
  const m = String(text).match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map((x) => Number(x))
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null
  const alpha = parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1
  return { hex: `#${parts.slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join('')}`, alpha }
}

/**
 * 抠出 :root 块里的纯色值，按主题分成两组。
 * 深色那份是基础，`:root[data-theme="light"]` 在它上面覆盖 —— 按浏览器的方式合并，
 * 这样浅档量的每个颜色都是「真会被用上那一个」；反过来，浅档漏盖的那一条会被量成深色的值，
 * 直接报红 —— 那正是界面会坏的地方，不该被「这个 token 没读到」悄悄放过。
 * 缩写（#fff）在这里就展开成 6 位：后面所有算法只按 6 位走，少一次「切出 #1」的坑。
 */
function registers(src) {
  const dark = {}
  const lightOverride = {}
  for (const m of src.matchAll(/:root(\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    const to = /data-theme="light"/.test(m[1] || '') ? lightOverride : dark
    for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\s*;/g)) {
      const hex = d[2].toLowerCase()
      to[d[1]] = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
    }
  }
  return { dark, light: { ...dark, ...lightOverride } }
}

/** 原始声明（含 rgba）也按主题合并，供 softs 取那几条带 alpha 的染色。 */
function rawRegisters(src) {
  const dark = {}
  const lightOverride = {}
  for (const m of src.matchAll(/:root(\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    const to = /data-theme="light"/.test(m[1] || '') ? lightOverride : dark
    for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) to[d[1]] = d[2].trim()
  }
  return { dark, light: { ...dark, ...lightOverride } }
}

// 色板生成：给定底色与目标比值，沿中性轴走，并用每通道的固定偏移压一个偏色方向
// （蓝灰偏冷）。每档都取「正好过门槛的那个极值」：深底从亮侧往下找（主文最亮），
// 亮底从暗侧往上找（主文最暗）。这样四档是单调的，不会各档打架。
function pickInk(bg, target, bias = [0, 0, 0], dir = 'down') {
  const step = dir === 'down' ? -1 : 1
  const start = dir === 'down' ? 255 : 0
  const stop = dir === 'down' ? 0 : 255
  let hit = null
  for (let v = start; step < 0 ? v >= stop : v <= stop; v += step) {
    const c = [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(v + bias[i]))))
    const hex = '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('')
    // 走完全程，留最后一个过关的：向下找就是「过门槛的最暗」，向上找就是「过门槛的最亮」。
    if (ratio(hex, bg) >= target) hit = { hex, ratio: ratio(hex, bg) }
  }
  return hit
}

const usage = `工作台 token 对比度核对器

  node scripts/check-contrast.mjs                         # 核对两套色板（科研外壳 + 技术工作台）
  node scripts/check-contrast.mjs --palette dark          # 为科研外壳生成候选墨色
  node scripts/check-contrast.mjs --palette light --for tech

门槛：正文、标签、压在色块上的字都是 4.5:1（WCAG 2.2 AA）；控件边界 3:1（1.4.11）；
容器装饰线只报数。语义色两两色相相差 ≥20°。
`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage)
  process.exit(0)
}

let bad = 0
let checks = 0
const report = (ok, line) => {
  checks += 1
  if (!ok) bad += 1
  console.log(`  ${ok ? ' ok ' : 'FAIL'} ${line}`)
}

function verifyTheme(palette, theme, vars, raw) {
  console.log(`\n== ${palette.name} ${theme} register（文字对多块底 / 色块与徽标上的字 / 描边 / 色相分离）`)
  const missing = palette.text.filter((k) => !vars[k])
  if (missing.length) {
    report(false, `${palette.file} 的 ${theme} 里缺文字色 token：${missing.join('、')}`)
    return
  }
  const papers = palette.surfaces
    .filter((k) => vars[k])
    .map((k) => [k.replace(palette.prefix, ''), vars[k]])
  for (const name of palette.text) {
    for (const [where, paper] of papers) {
      const r = ratio(vars[name], paper)
      report(r >= TEXT_MIN, `${name} ${vars[name]} 对 ${where} ${paper}：${r.toFixed(2)}:1（门槛 ${TEXT_MIN}）`)
    }
  }
  for (const [fill, ink] of palette.fills) {
    if (!vars[fill] || !vars[ink]) {
      report(false, `${fill} 要压字就得配套 ${ink}（深底近黑、浅底纯白），别让界面自己挑一个 #fff`)
      continue
    }
    const r = ratio(vars[ink], vars[fill])
    report(r >= FILL_TEXT_MIN, `${ink} 压在 ${fill} ${vars[fill]} 上：${r.toFixed(2)}:1（按钮与实心徽标里那行字最容易漏量）`)
  }
  for (const [ink, soft] of palette.softs) {
    const layer = parseRgba(raw[soft] || '')
    if (!vars[ink] || !layer) continue
    for (const name of palette.badgePapers) {
      if (!vars[name]) continue
      const paper = blend(layer.hex, layer.alpha, vars[name])
      const r = ratio(vars[ink], paper)
      report(
        r >= TEXT_MIN,
        `${ink} 对 ${soft} 铺在 ${name.replace(palette.prefix, '')} 上（混色后 ${paper}）：${r.toFixed(2)}:1（浅底徽标的字）`,
      )
    }
  }
  const [strong, strongPaper] = palette.lineStrong
  if (vars[strong] && vars[strongPaper]) {
    const r = ratio(vars[strong], vars[strongPaper])
    report(r >= LINE_STRONG_MIN, `${strong} 对卡片 ${vars[strongPaper]}：${r.toFixed(2)}:1（输入框与按钮的边是非文本元素，需 ${LINE_STRONG_MIN}）`)
  }
  const [line, linePaper] = palette.line
  if (vars[line] && vars[linePaper]) {
    console.log(`  ··  ${line} 对卡片：${ratio(vars[line], vars[linePaper]).toFixed(2)}:1（容器装饰线，本来就该轻）`)
  }
  for (let i = 0; i < palette.semantic.length; i += 1) {
    for (let j = i + 1; j < palette.semantic.length; j += 1) {
      const a = vars[palette.semantic[i]]
      const b = vars[palette.semantic[j]]
      if (!a || !b) continue
      const gap = hueGap(hue(a), hue(b))
      report(gap >= MIN_HUE_GAP, `${palette.semantic[i]}(${hue(a)}°) 与 ${palette.semantic[j]}(${hue(b)}°) 相差 ${gap}°（一个色相不许兼两个语义，需 ≥${MIN_HUE_GAP}°）`)
    }
  }
}

/**
 * 描边按角色分档，从上往下逐档变轻：
 * 控件 3:1（空着的输入框、下拉、文本域）→ 主分隔与浮层的边 2:1（顶栏底线、模态 / toast /
 * 命令面板的边、带字按钮的轮廓）→ 卡片面片的边 1.33:1（card-line）→ 行与格的重复细分 1.33:1。
 * 卡片面片的整圈边从 2:1 降到卡片档是这一版的要害：满屏一圈 2:1 硬边 + 每行一条发丝线，
 * 读起来是方格纸；卡片只留一档极淡的边，层次交给底色台阶与那层很淡的 sh-1。
 * 模块可以把档位起成本地别名（scholar 的 --s-control、trajectory 的 --tj-card-line），
 * 但别名必须指回对的来源 —— 「card-line 又指回 --p-line」意味着卡片边悄悄回到 2:1，
 * 那正是这次改版要治的那条毛病，所以用数钉住，不靠下一个人记得。
 */
const TIER_SOURCE = {
  control: '--p-border',
  border: '--p-line',
  line: '--p-line',
  'card-line': '--p-line-soft',
  'line-soft': '--p-line-soft',
}
function checkStrokeTiers() {
  console.log('\n== 描边各档的来源（控件 3:1 / 主分隔与浮层 2:1 / 卡片面片与行细分 1.33:1）')
  for (const file of [ ...NESTED_MODULES, 'plugins/research/ui.html' ]) {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) continue
    const text = fs.readFileSync(full, 'utf8')
    const aliases = [...text.matchAll(/(--[a-z0-9-]+-(?:control|border|line|line-soft))\s*:\s*var\((--p-[a-z-]+)/g)]
    let checked = 0
    for (const [_, name, source] of aliases) {
      const tier = name.replace(/^--[a-z0-9]+-/, '')
      const want = TIER_SOURCE[tier]
      if (!want) continue
      checked += 1
      report(source === want, `${file}：${name} → ${source}（${tier} 档应指 ${want}）`)
    }
    if (!checked) console.log(`   ok  ${file}：没有本地描边别名，直接用外壳的三档`)
  }
}

/**
 * 上一条只管别名指得对不对，管不到「用在谁身上」。这里补另一面：
 * 空着的输入框、下拉、文本域靠描边才看得出是个控件，压在容器档 2:1 上就等于
 * 把控件藏进底里（1.4.11 要的非文本对比是 3:1）。带字标签的按钮与胶囊不同 ——
 * 字本身已经把「这是控件」说清楚了，那圈边是装饰，留在容器档反而更像这套界面。
 */
const CONTROL_TIER = new Set(['--p-border', '--rw-line-strong', '--wb-line-strong', '--s-control', '--tj-control'])
const FIELD_SELECTOR = /(^|[\s,>+])(input|textarea|select)\b/
function checkControlTier() {
  console.log('\n== 输入控件的描边落在控件档（带字标签的按钮不算，它靠字自己站住）')
  for (const file of ['plugins/research/ui.html', ...NESTED_MODULES]) {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) continue
    const text = fs.readFileSync(full, 'utf8')
    let checked = 0
    const offenders = []
    for (const [_, sel, decls] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = sel.replace(/\s+/g, ' ').trim()
      if (!FIELD_SELECTOR.test(selector) || selector.startsWith('@') || selector.includes('::')) continue
      const strokes = [...decls.matchAll(/\bborder(?:-color|-bottom|-top|-left|-right)?\s*:\s*([^;]+)/g)]
        .map((m) => m[1])
        .filter((v) => v.includes('var('))
      if (!strokes.length) continue
      checked += 1
      for (const value of strokes) {
        const vars = [...value.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])
        // 语义色（选中、报错）与 color-mix 里的 accent 是有意的强调，不是分级失误
        const ok = vars.every((v) => CONTROL_TIER.has(v) || !/-line$|-line-soft$|-border$/.test(v))
        if (!ok) offenders.push(`${selector} → ${vars.join(' ')}（${value.trim()}）`)
      }
    }
    if (!checked) {
      console.log(`   ok  ${file}：没有需要边界线的输入控件`)
      continue
    }
    report(!offenders.length, `${file}：${offenders.length}/${checked} 处输入控件的描边压在容器档`)
    if (!offenders.length) console.log(`   ok  ${file}：${checked} 处输入控件的描边都在控件档`)
    for (const o of offenders.slice(0, 8)) console.log(`      ${o}`)
  }
}

function listModuleColors() {
  console.log('\n== 嵌套模块自己硬编码的颜色（外壳已经注进来了，这些是不该存在的第二份色板）')
  for (const file of NESTED_MODULES) {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) continue
    const text = fs.readFileSync(full, 'utf8')
    const own = [...text.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/gm)].map((m) => `${m[1]}=${m[2]}`)
    const inline = [...text.matchAll(/(?:color|background-color|border-color|fill|stroke)\s*:\s*#[0-9a-fA-F]{3,6}/gi)]
    if (!own.length && !inline.length) {
      console.log(`   ok  ${file}：只用量表，没有自带色板`)
      continue
    }
    report(false, `${file}：自己定义了 ${own.length} 个色变量、内联 ${inline.length} 处`)
    if (own.length) console.log(`      ${own.slice(0, 10).join(' ')}${own.length > 10 ? ' …' : ''}`)
  }
}

/**
 * 行列表的栏数必须等于行里的件数。
 *
 * 这条是补的：资料库里「逐行编号」被去掉时，DOM 少了一个子元素，
 * 但 grid-template-columns 还留着四栏 —— 三件东西按四栏摆，正文落进 20px 那条缝，
 * 整列标题一个字一行地往下掉。样式表本身完全合法，色值、残留、指空 var 都查不出来，
 * 只有真在浏览器里看一眼才发现。所以把「几栏 = 几件」用数钉住：
 * 栏数从赢的那条声明里数，件数从渲染函数的行模板里数。
 */
const ROW_GRIDS = [
  {
    file: 'plugins/research/modules/scholar/ui.html',
    sel: '.lib-row',
    render: 'renderLibrary',
    parts: ['class="star', 'class="lib-main', 'class="lib-side'],
  },
]
function checkRowGrids() {
  console.log('\n== 行列表的栏数对得上行里的件数（删了元素忘了改栏数，整列会挤成一条缝）')
  for (const row of ROW_GRIDS) {
    const text = fs.readFileSync(path.join(ROOT, row.file), 'utf8')
    const esc = row.sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 同一个选择器写了两遍，后写的胜出 —— 但窄屏那条 @media 也算了「后」，
    // 它故意少一栏（右侧动作换行），不能拿它当基准，所以先量出 @media 的范围再排掉
    const media = []
    for (const m of text.matchAll(/@media[^{]*\{/g)) {
      let i = m.index + m[0].length
      let depth = 1
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth += 1
        else if (text[i] === '}') depth -= 1
        i += 1
      }
      media.push([m.index, i])
    }
    const decls = [...text.matchAll(new RegExp('(?:^|[\\s,>])' + esc + '\\s*\\{([^}]*)\\}', 'g'))]
      .filter((m) => !media.some(([a, b]) => m.index > a && m.index < b))
    const grid = decls.map((m) => m[1]).filter((b) => /grid-template-columns/.test(b)).pop()
    if (!grid) {
      report(false, `${row.file}：${row.sel} 找不到 grid-template-columns`)
      continue
    }
    const tracks = grid.match(/grid-template-columns\s*:([^;]+)/)[1].trim().split(/\s+(?![^(]*\))/).length
    const start = text.indexOf('function ' + row.render)
    const body = start < 0 ? '' : text.slice(start, text.indexOf('\n  function ', start))
    const parts = row.parts.filter((p) => body.includes(p)).length
    report(
      tracks === parts,
      `${row.file}：${row.sel} 摆了 ${tracks} 栏，行模板里有 ${parts} 件（${row.parts.length} 个标记全部认到才行）`,
    )
  }
}

/** 模块引用了外壳没发的 token 时，浏览器不报错，只退成兜底色 —— 那是最难发现的一种坏。 */
function checkDanglingVars() {
  console.log('\n== 模块里指空的 var(--x)（既不在外壳量表里，也没有本地定义）')
  const shell = path.join(ROOT, 'plugins', 'research', 'ui.html')
  const shared = new Set(Object.keys(rawRegisters(fs.readFileSync(shell, 'utf8')).dark))
  for (const file of NESTED_MODULES) {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) continue
    const text = fs.readFileSync(full, 'utf8')
    const local = new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    for (const m of text.matchAll(/setProperty\(\s*['"`]--([a-z0-9-]+)/g)) local.add(`--${m[1]}`)
    const refs = new Set([...text.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]))
    const dangling = [...refs].filter((k) => !shared.has(k) && !local.has(k))
    if (!dangling.length) {
      console.log(`   ok  ${file}：引用的 token 都有出处`)
      continue
    }
    report(false, `${file}：${dangling.length} 个引用没有出处 → ${dangling.slice(0, 12).join('、')}${dangling.length > 12 ? ' …' : ''}`)
  }
}

function finish() {
  console.log(`\n合计 ${checks} 项检查，未过 ${bad}`)
  // 汇总行的口径要对上 scripts/run-tests.js 的解析（「通过 N · 失败 M」），
  // 否则套件本身过了，报表里却写着「无汇总行」——276 项检查在总表里缩成一行空白，
  // 看不出它到底量了东西还是压根没跑。
  console.log(`通过 ${checks - bad} · 失败 ${bad}`)
  process.exit(bad ? 1 : 0)
}

const loaded = PALETTES.map((p) => {
  const src = fs.readFileSync(path.join(ROOT, p.file), 'utf8')
  return { palette: p, regs: registers(src), raw: rawRegisters(src) }
})

if (process.argv.includes('--palette')) {
  // 底色与卡片底都从现有 register 读：换季时候选墨色是照着真的底生成的，不是照着记忆里那块底
  const wanted = (process.argv[process.argv.indexOf('--palette') + 1] || 'dark').trim()
  const theme = ['dark', 'light'].includes(wanted) ? wanted : 'dark'
  const forId = (process.argv.find((a, i) => process.argv[i - 1] === '--for') || '').trim()
  const palette = PALETTES.find((p) => p.id === forId) || PALETTES[0]
  const vars = loaded.find((l) => l.palette === palette).regs[theme]
  const bg = vars[`${palette.prefix}bg`] || (theme === 'dark' ? '#10151b' : '#f4f6f9')
  const card = vars[`${palette.prefix}surface`] || (theme === 'dark' ? '#161d25' : '#ffffff')
  console.log(`\n== ${palette.name} ${theme}（底 ${bg} / 卡片 ${card}）`)
  const tiers = [
    ['ink', 15.0, [12, 16, 22]],
    ['ink-2', 10.5, [10, 13, 19]],
    ['ink-3', 7.5, [8, 11, 16]],
    ['ink-4', 5.0, [6, 9, 13]], // 标签与角标：仍按正文门槛，不许拿「小字」当借口降到 3:1
  ]
  for (const [name, target, bias] of tiers) {
    const hit = pickInk(bg, target, bias, theme === 'dark' ? 'down' : 'up')
    if (!hit) {
      console.log(`  ${palette.prefix}${name}: 找不到过 ${target} 的色（偏色参数 ${bias.join(',')}）`)
      continue
    }
    console.log(`  ${palette.prefix}${name}: ${hit.hex}  ${hit.ratio.toFixed(2)}:1（门槛 ${target}）`)
  }
  // 描边分三级：行与格的重复细分最轻，容器边按 2:1（装饰），能当控件边界的按 3:1。
  // 线条不是文字，不需要 4.5:1，但「分不出结构」正是这套界面的毛病之一。
  for (const [name, target] of Object.entries({ 'line-soft': 1.3, line: 2.0, 'line-strong': 3.0 })) {
    const hit = pickInk(card, target, theme === 'dark' ? [8, 11, 16] : [-16, -11, -8], theme === 'dark' ? 'down' : 'up')
    console.log(hit ? `  ${palette.prefix}${name}: ${hit.hex}  ${hit.ratio.toFixed(2)}:1（对卡片底，门槛 ${target}）` : `  ${palette.prefix}${name}: 找不到过 ${target} 的色`)
  }
  process.exit(0)
}

for (const { palette, regs, raw } of loaded) {
  for (const theme of ['dark', 'light']) {
    if (!Object.keys(regs[theme]).length) {
      report(false, `${palette.file} 里没读到 ${theme} 的 :root，色板可能挪走了`)
      continue
    }
    verifyTheme(palette, theme, regs[theme], raw[theme])
  }
}

// 模块审计每次跑都查：它不该是「记得加参数才查」的那一半。
// 指空的 var(--x) 同理 —— 浏览器不会报错，只会安静退成兜底色，那是最难发现的一种坏。
listModuleColors()
checkStrokeTiers()
checkControlTier()
checkRowGrids()
checkDanglingVars()
finish()
