/**
 * 真窗口验收：回放一份**真实**历史会话，量右栏那两处布局。
 *
 * 冒烟里的夹具只有两条共识点，压不扁任何东西；用户现场那场（sess_mw4nbaym_1）有 10 条，
 * 正是「判断卡被挤成空胶囊」「台账只占上半屏」两处失效的真实形状。所以这里不用夹具，
 * 直接把磁盘上那份会话记录复制进一枚临时 userData，走「历史 → 回放」这条真路径。
 *
 * 回放不调模型、不花钱：`hydrateFromRecord` 只重建界面状态。
 *
 * 运行：node scripts/verify-rail-geometry.mjs [sessionId]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = await freePort(9501)
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 用户真实数据目录：只读复制，绝不在原地跑第二枚实例（Chromium 缓存锁会打架） */
const REAL = path.join(os.homedir(), 'AppData', 'Roaming', 'torra', 'torra')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-rail-geom-'))
const SESSION = process.argv[2] || 'sess_mw4nbaym_1'

const failures = []
const check = (name, ok, extra) => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? ` · ${JSON.stringify(extra)}` : ''}`)
  if (!ok) failures.push(name)
}

function freePort(from) {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(from, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

function cdpClient(socket) {
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })
  return {
    send(method, params = {}, timeoutMs = 20000) {
      const mid = ++id
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject })
        socket.send(JSON.stringify({ id: mid, method, params }))
        setTimeout(() => {
          if (pending.has(mid)) {
            pending.delete(mid)
            reject(new Error(`CDP 超时: ${method}`))
          }
        }, timeoutMs)
      })
    },
  }
}

/** 把那份真实会话的四个伴生文件搬进临时目录（会话列表读的就是它们） */
function seed() {
  const dst = path.join(userData, 'torra', 'sessions')
  fs.mkdirSync(dst, { recursive: true })
  const src = path.join(REAL, 'sessions')
  const names = fs.readdirSync(src).filter((f) => f.startsWith(SESSION))
  if (!names.length) throw new Error(`真实目录里没有 ${SESSION}：${src}`)
  for (const f of names) fs.copyFileSync(path.join(src, f), path.join(dst, f))
  // 模型清单：回放要拿它显示发言者名字与颜色
  for (const f of ['models.json', 'preferences.json']) {
    const from = path.join(REAL, f)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(userData, 'torra', f))
  }
  return names
}

let ws = null
let cdp = null
async function connect() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const hit = list.find((t) => t.type === 'page' && /^file:\/\/.*index\.html/.test(t.url || ''))
      if (hit) {
        ws = new WebSocket(hit.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.addEventListener('open', res)
          ws.addEventListener('error', rej)
        })
        cdp = cdpClient(ws)
        await cdp.send('Runtime.enable')
        await cdp.send('Page.enable')
        return
      }
    } catch {
      /* 尚未就绪 */
    }
    await sleep(400)
  }
  throw new Error('未找到渲染层页面目标')
}

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本抛错')
  return r.result?.value
}

/** 点一个元素：先滚动到可见，再走真实鼠标事件（合成 click 骗得过 handler，骗不过 hover/布局） */
async function clickByText(selector, text) {
  const box = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = nodes.find((n) => n.textContent.trim().includes(${JSON.stringify(text)}))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!box) throw new Error(`找不到可点的元素：${selector} / ${text}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
}

async function shot(file) {
  const OUT = path.join(ROOT, 'output')
  fs.mkdirSync(OUT, { recursive: true })
  const png = await cdp.send('Page.captureScreenshot', { format: 'png' }, 30000)
  fs.writeFileSync(path.join(OUT, file), Buffer.from(png.data, 'base64'))
  return file
}

async function main() {
  const seeded = seed()
  console.log(`会话 ${SESSION}：${seeded.length} 个文件已复制到临时 userData`)

  const child = spawn(
    electronBin,
    [ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'],
    { stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT },
  )
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|Debugging suggestion|GPU|gpu|Warning|deprecat/i.test(s)) console.log('[app:err] ' + s)
  })

  try {
    await connect()
    // 窗口必须抬起来：最小化/遮挡时每个 getBoundingClientRect 都读成 0
    await evaluate(`(async () => { await new Promise((r) => setTimeout(r, 1200)); return document.visibilityState })()`)
    await sleep(1200)

    /*
     * 开场片子会盖满整屏（「点击或按 Esc 跳过」）。它不挡测量 —— 底层 DOM 照样在，
     * 但它挡截图：拍出来是一张封面，看不出右栏长什么样。先按 Esc 收掉。
     */
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await sleep(900)
    /*
     * 开场引导层会盖住导航：它属于第一次启动的那一屏，回放验收跟它无关。
     * 先按它自己的「收掉」按钮关掉，再点导航 —— 否则真实鼠标事件全落在浮层上，
     * 看上去像「点了没反应」，实际是点错了对象。
     */
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('button')].find((b) => /收掉|知道了|开始/.test(b.textContent || ''))
      if (el) el.click()
      return !!el
    })()`)
    await sleep(400)
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('.app-nav-item')].find((n) => n.textContent.trim() === '历史')
      if (!el) return false
      el.click()
      return true
    })()`)
    await sleep(1600)
    /*
     * 历史列表里那一行的回放键：按 title 找，不按序号（列表按时间倒序，序号会变）。
     * 用元素自己的 click()：React 的 onClick 挂在根节点上，原生 click 事件一样会走到；
     * 而合成坐标的鼠标事件在这枚小图标上曾经整颗打空（浮层刚撤、坐标还按旧布局算）。
     */
    const clicked = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button[title*="回放此会话"]')][0]
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (!clicked) throw new Error('历史列表里没有回放键')
    await sleep(1400)

    const rail = await evaluate(`(() => {
      const scroll = document.querySelector('.cl-rail-scroll')
      if (!scroll) return { missing: true, html: document.body.innerHTML.slice(0, 200) }
      const cards = [...scroll.querySelectorAll('.cl-point')]
      const heights = cards.map((c) => Math.round(c.getBoundingClientRect().height))
      const clipped = cards.filter((c) => c.scrollHeight > c.clientHeight + 1).length
      return {
        cards: cards.length,
        minH: heights.length ? Math.min(...heights) : 0,
        clipped,
        scrollable: scroll.scrollHeight > scroll.clientHeight,
        viewport: Math.round(scroll.clientHeight),
        content: Math.round(scroll.scrollHeight),
        claims: [...document.querySelectorAll('.cl-point-claim')].map((n) => (n.textContent || '').trim().length).slice(0, 3),
      }
    })()`)
    if (rail.missing) throw new Error(`回放没进议事厅：${rail.html}`)

    check(`真实会话的 ${rail.cards} 张判断卡都装得下内容（被裁 ${rail.clipped} 张）`, rail.clipped === 0 && rail.cards > 0, rail)
    check(
      `右栏条目溢出时会滚，而不是把卡片压扁（内容 ${rail.content}px / 可视 ${rail.viewport}px）`,
      rail.scrollable && rail.minH >= 60,
      { minH: rail.minH },
    )
    check('判断卡正文有字（不是被裁掉的空胶囊）', rail.claims.every((n) => n > 10), rail.claims)
    const file = await shot('verify-rail-geometry-view.png')
    console.log(`  截图：output/${file}`)

    // 台账视图：同一批数据的另一种切面，量的是「有没有占满右栏」
    const toLedger = await evaluate(`(() => {
      const el = [...document.querySelectorAll('.cl-rail button')].find((b) => /完整台账/.test(b.textContent || ''))
      if (!el) return false
      el.click()
      return true
    })()`)
    if (!toLedger) throw new Error('右栏里没有「完整台账」入口')
    await sleep(900)
    const ledger = await evaluate(`(() => {
      const railEl = document.querySelector('.cl-rail')
      const aside = document.querySelector('.cl-rail .rb-aside')
      const scroll = document.querySelector('.cl-rail .rb-aside-scroll')
      if (!railEl || !aside || !scroll) return { missing: true }
      const h = Math.round(railEl.getBoundingClientRect().height)
      return {
        railH: h,
        asideH: Math.round(aside.getBoundingClientRect().height),
        scrollH: Math.round(scroll.clientHeight),
        avail: h - 60,
      }
    })()`)
    if (ledger.missing) throw new Error('台账视图没找到 .rb-aside')
    check(
      `台账占满右栏剩余高度（滚动区 ${ledger.scrollH}px / 右栏 ${ledger.railH}px）`,
      ledger.scrollH >= ledger.railH * 0.75,
      ledger,
    )
    const file2 = await shot('verify-rail-geometry-ledger.png')
    console.log(`  截图：output/${file2}`)
  } finally {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
    await sleep(600)
    fs.rmSync(userData, { recursive: true, force: true })
  }

  console.log(`\n${failures.length ? `失败 ${failures.length} 项` : '全部通过'}`)
  if (failures.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
