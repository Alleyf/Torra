// 科研工作台设计 token 的对比度核对器
//
// 「层级靠明暗」这件事可以用两个数判死：文字色在自己那块底上的比值。
// 这套色板是手工调出来的，改动靠眼睛；眼睛会把 3.3:1 看成「差不多」，
// 所以这里把每个文字色都量一遍，低于正文门槛（4.5:1）的直接报出来。
//
// 用法：
//   node scripts/check-contrast.mjs                    # 查现有两套 register
//   node scripts/check-contrast.mjs --help             # 看可用的色板生成命令
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SHELL = path.join(ROOT, 'plugins', 'research', 'ui.html')

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

const usage = `科研工作台 token 对比度核对器

  node scripts/check-contrast.mjs                 # 核对四份 ui.html 里现有色板
  node scripts/check-contrast.mjs --palette dark  # 生成一套候选色板（每档都过门槛）
  node scripts/check-contrast.mjs --palette light

门槛：正文 4.5:1（WCAG 2.2 AA），大字 3:1。只报文字色，不判装饰色。
`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage)
  process.exit(0)
}

const themes = process.argv.includes('--palette') ? [process.argv[process.argv.indexOf('--palette') + 1]] : ['dark', 'light']

// 已定的四档墨色（改色板时这里是要跟着动的清单，不是历史记录）
const INK = {
  dark: { '--rw-ink': '#e5e9ef', '--rw-ink-2': '#c2c5cb', '--rw-ink-3': '#a3a6ab', '--rw-ink-4': '#83868a' },
  light: { '--rw-ink': '#1c2026', '--rw-ink-2': '#373a40', '--rw-ink-3': '#4c4f54', '--rw-ink-4': '#676a6e' },
}
const PAPER = {
  dark: { bg: '#10151b', surface: '#161d25', rail: '#0f1419' },
  light: { bg: '#f4f6f9', surface: '#ffffff', rail: '#f7f9fc' },
}

// 文字色要在它可能落的每一块底上过门槛：纸面、卡片、左轨。
// 只对纸面量，等于把卡片上的那一半放过了——而卡片才是文字最常待的地方。
if (process.argv.includes('--verify')) {
  let bad = 0
  for (const theme of themes) {
    console.log(`\n== ${theme}：文字色对三块底（纸面 / 卡片 / 左轨）`)
    for (const [name, hex] of Object.entries(INK[theme])) {
      for (const [where, paper] of Object.entries(PAPER[theme])) {
        const r = ratio(hex, paper)
        const ok = r >= 4.5
        if (!ok) bad++
        console.log(`  ${ok ? ' ok ' : 'FAIL'} ${name} ${hex} 对 ${where} ${paper}：${r.toFixed(2)}:1`)
      }
    }
  }
  console.log(`\n未过 4.5:1 的搭配：${bad}`)
  // 汇总行要对上 scripts/run-tests.js 的解析口径（「通过 N · 失败 M」），
  // 否则套件本身过了，报表里却写着「无汇总行」，看不出它到底是过是没过。
  console.log(`全部通过：${bad ? 0 : 1} 通过 · ${bad} 失败`)
  process.exit(bad ? 1 : 0)
}

if (process.argv.includes('--palette')) {
  const BG = { dark: '#10151b', light: '#f4f6f9' }
  const RAILED = { dark: '#161d25', light: '#ffffff' }
  for (const theme of themes) {
    const bg = BG[theme]
    console.log(`\n== ${theme}（底 ${bg} / 卡片 ${RAILED[theme]}）`)
    const tiers = [
      ['ink', 15.0, [12, 16, 22]],
      ['ink-2', 10.5, [10, 13, 19]],
      ['ink-3', 7.5, [8, 11, 16]],
      ['ink-4', 5.0, [6, 9, 13]], // 标签与角标：仍按正文门槛，不许拿「小字」当借口降到 3:1
    ]
    for (const [name, target, bias] of tiers) {
      const hit = pickInk(bg, target, bias, theme === 'dark' ? 'down' : 'up')
      if (!hit) {
        console.log(`  --rw-${name}: 找不到过 ${target} 的色（偏色参数 ${bias.join(',')}）`)
        continue
      }
      console.log(`  --rw-${name}: ${hit.hex}  ${hit.ratio.toFixed(2)}:1（门槛 ${target}）`)
    }
    // 分隔线：装饰性的细线按 2:1 走，能当控件边界的（输入框、按钮、关键分隔）按 3:1 走。
    // 线条不是文字，不需要 4.5:1，但「分不出结构」正是这套界面的毛病之一。
    for (const [name, target] of Object.entries({ subtle: 2.0, strong: 3.0 })) {
      const hit = pickInk(RAILED[theme], target, theme === 'dark' ? [8, 11, 16] : [-16,-11,-8], theme === 'dark' ? 'down' : 'up')
      const label = hit ? `  --rw-line-${name}: ${hit.hex}  ${hit.ratio.toFixed(2)}:1（对卡片底，门槛 ${target}）` : `  --rw-line-${name}: 找不到过 ${target} 的色`
      console.log(label)
    }
  }
  process.exit(0)
}

// 核对现有色板：从四份 ui.html 里把 :root 与 :root[data-theme=light] 的色值抠出来
let failed = 0
for (const file of [
  'plugins/research/ui.html',
  'plugins/research/modules/scholar/ui.html',
  'plugins/research/modules/trajectory/ui.html',
  'plugins/research/modules/server/ui.html',
]) {
  const full = path.join(ROOT, file)
  if (!fs.existsSync(full)) continue
  const src = fs.readFileSync(full, 'utf8')
  const blocks = [...src.matchAll(/:root\[?[^{]*?\{([^}]*)\}/g)].map((m) => m[1])
  if (!blocks.length) continue
  const vars = {}
  for (const block of blocks) {
    for (const [k, v] of [...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])) {
      const isColor = /^(#|rgb|hsl|color\(|var\(--)/.test(v)
      vars[k] = vars[k] || []
      if (isColor) vars[k].push(v)
    }
  }
  const theme = [...src.matchAll(/:root\[data-theme="light"\]/g)].length > 0
  console.log(`\n== ${file}（${theme ? '深浅两套' : '只有深色'}）`)
  for (const [k, vs] of Object.entries(vars)) {
    const isInk = /ink/.test(k) || /muted/.test(k)
    if (!isInk || k.startsWith('--p-')) continue
    for (const v of vs) {
      if (!/^#[0-9a-f]{6}$/i.test(v)) continue
      const bg = /^#1[01]/.test(v) ? '#10151b' : '#10151b'
      const r = ratio(v, bg)
      const mark = r >= 4.5 ? '  ok ' : '  FAIL'
      if (r < 4.5) failed++
      console.log(`${mark} ${k} = ${v}  ${r.toFixed(2)}:1（对 #10151b）`)
    }
  }
}
console.log(`\n低于 4.5:1 的文字色：${failed}`)
process.exit(0)
