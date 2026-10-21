// 落地页配图：把当前构建的真实界面截成 site/assets/*.png
//
// 与 verify-* 系列的区别只有一条：这里不判对错，只出图。
// 用一份全新的临时 userData 启动，因此拍到的都是「零数据」状态：
// 研讨首页是引导态（还没有能发言的模型），设置页是未配置态。
// 需要「讨论进行中」那种带真实会话的图，请从本机数据目录另拍，别拿这里的凑。
//
// 用法：node scripts/capture-site.mjs [视图名...]
// 不带参数 = 全拍。视图名见 VIEWS。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'site', 'assets')
const PORT = await freePort(9471)
const INSPECT_PORT = await freePort(PORT + 1)
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
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-capture-site-'))

// 图标预置：临时 userData 意味着 app 自己的 favicon 磁盘缓存是空的，
// 主进程只能去够那 6 个公共 favicon 源 —— 出图就变成「看这台机器今天通不通」，
// 不通的话模型栏全画成首字母。把 scripts/fixtures/icons/ 里的真实图标
// 直接塞进 userData/torra/icons/<domain>（favicon-cache.ts 读的就是这个路径），
// 走的是 app 自己的正常分支，不改一行应用逻辑。
// 将来适配器加了新站点而夹具里没有它，这里不会报错，只是那一个仍然画成首字母。
function seedIconCache() {
  const src = path.join(ROOT, 'scripts', 'fixtures', 'icons')
  const dst = path.join(userData, 'torra', 'icons')
  fs.mkdirSync(dst, { recursive: true })
  let names = []
  try {
    names = fs.readdirSync(src)
  } catch {
    console.log('\x1b[33m!\x1b[0m 没有 scripts/fixtures/icons/，图标会画成首字母（跑一次 scripts/make-icon-fixtures.ps1）')
    return
  }
  for (const n of names) {
    const f = path.join(src, n)
    if (fs.statSync(f).isFile()) fs.copyFileSync(f, path.join(dst, n))
  }
  console.log(`\x1b[32m✓\x1b[0m 已预置 ${names.length} 枚模型图标`)
}
seedIconCache()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let wsCdp = null
let wsMainCdp = null

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

async function findTarget(kind) {
  for (let i = 0; i < 60; i++) {
    const port = kind === 'page' ? PORT : INSPECT_PORT
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const hit =
        kind === 'page'
          ? list.find((t) => t.type === 'page' && /^file:\/\/.*index\.html/.test(t.url || ''))
          : list.find((t) => t.type === 'node' && t.webSocketDebuggerUrl)
      if (hit) return hit
    } catch {
      /* 尚未就绪 */
    }
    await sleep(400)
  }
  throw new Error(kind === 'page' ? '未找到渲染层页面目标' : '未找到主进程调试目标')
}

async function connect(url) {
  const sock = new WebSocket(url)
  await new Promise((res, rej) => {
    sock.addEventListener('open', res)
    sock.addEventListener('error', rej)
  })
  return cdpClient(sock)
}

async function evalJs(expression, awaitPromise = true) {
  const r = await wsCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) {
    throw new Error('页内执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}

async function mainEval(expression) {
  const r = await wsMainCdp.send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true })
  if (r.exceptionDetails) throw new Error('主进程执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function mouse(type, x, y, extra = {}) {
  await wsCdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
}

async function click(sel) {
  const box = await evalJs(
    `(function(){const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
    false,
  )
  if (!box) return false
  await mouse('mouseMoved', box.x, box.y)
  await mouse('mousePressed', box.x, box.y)
  await mouse('mouseReleased', box.x, box.y)
  return true
}

/** 按 aria-label 点导航图标（图标态下没有可读文字，只能靠 aria-label） */
async function goSection(label) {
  const box = await evalJs(
    `(function(){const el=[...document.querySelectorAll('.app-nav-item')].find(b=>(b.getAttribute('aria-label')||'')===${JSON.stringify(label)});if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
    false,
  )
  if (!box) throw new Error(`找不到分区按钮：${label}`)
  await mouse('mouseMoved', box.x, box.y)
  await mouse('mousePressed', box.x, box.y)
  await mouse('mouseReleased', box.x, box.y)
  await sleep(900)
}

async function setTheme(want) {
  const cur = await evalJs(`document.documentElement.dataset.theme||'light'`, false)
  if (cur === want) return
  await click('.theme-toggle')
  await sleep(1000)
  await dismissModals()
}

async function dismissModals() {
  for (let i = 0; i < 6; i++) {
    const clicked = await evalJs(
      `(function(){const b=[...document.querySelectorAll('.modal-mask button, .start-intro-foot button')].find(x=>/我已理解|知道了|开始|跳过/.test(x.textContent||''));if(b){b.click();return true}return false})()`,
    )
    if (!clicked) return
    await sleep(450)
  }
}

/** 整窗截图。clip 给定时只拍那块矩形（用于标题栏特写） */
async function shot(name, clipSel) {
  let clip
  if (clipSel) {
    const box = await evalJs(
      `(function(){const r=document.querySelector(${JSON.stringify(clipSel)}).getBoundingClientRect();return {x:0,y:0,width:Math.ceil(r.width),height:Math.ceil(r.height)+34}})()`,
      false,
    )
    clip = { ...box, scale: 2 }
  }
  const r = await wsCdp.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip, captureBeyondViewport: false } : {}),
  })
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  const b = fs.readFileSync(file)
  console.log(`  \x1b[32m✓\x1b[0m ${path.relative(ROOT, file)}  ${b.readUInt32BE(16)}×${b.readUInt32BE(20)}`)
}

// 每份视图：先摆到那个状态，再出图。名字就是产物文件名。
const VIEWS = {
  'app-discuss-dark': async () => {
    await setTheme('dark')
    await goSection('研讨')
    await mouse('mouseMoved', 900, 700)
    await sleep(500)
  },
  'app-discuss-light': async () => {
    await setTheme('light')
    await goSection('研讨')
    await mouse('mouseMoved', 900, 700)
    await sleep(500)
  },
  'app-settings-dark': async () => {
    await setTheme('dark')
    await goSection('设置')
    await mouse('mouseMoved', 900, 700)
    await sleep(500)
  },
  'bar-dark': async () => {
    await setTheme('dark')
    await goSection('研讨')
    await hoverToolTip()
  },
  'bar-light': async () => {
    await setTheme('light')
    await goSection('研讨')
    await hoverToolTip()
  },
}

/** 标题栏特写：让第 2 枚导航图标的气泡开着，好把「hover 出文字」拍进去 */
async function hoverToolTip() {
  const box = await evalJs(
    `(function(){const el=[...document.querySelectorAll('.app-nav-item')][1];const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
    false,
  )
  await mouse('mouseMoved', box.x, box.y)
  await sleep(400)
}

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const names = wanted.length ? wanted : Object.keys(VIEWS)
  for (const n of names) if (!VIEWS[n]) throw new Error(`未知视图：${n}（可选：${Object.keys(VIEWS).join(', ')}）`)

  child = spawn(
    electronBin,
    [`--inspect=${INSPECT_PORT}`, ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|Debugger listening|Debugging suggestion|GPU|gpu|Warning|deprecat/i.test(s)) console.log('[app:err] ' + s)
  })

  const page = await findTarget('page')
  wsCdp = await connect(page.webSocketDebuggerUrl)
  wsMainCdp = await connect((await findTarget('node')).webSocketDebuggerUrl)
  await wsCdp.send('Runtime.enable')
  await wsCdp.send('Page.enable')

  // 1600×1000：落地页配图要够宽才压得住 1200px 的内容列
  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;if(w.isMinimized())w.restore();w.show();w.setContentSize(1600,1000);w.moveTop();w.focus()}return 'ok'})()`,
  )
  await sleep(2000)
  await dismissModals()

  for (const n of names) {
    const base = n.replace(/-(dark|light)$/, '')
    const isBar = base === 'bar'
    await VIEWS[n]()
    await shot(n, isBar ? '.titlebar' : null)
  }
  console.log(`\n截图在 ${OUT}`)
}

try {
  await main()
} catch (e) {
  console.error('出图异常：', e)
  process.exitCode = 1
} finally {
  try {
    child?.kill()
  } catch {
    /* 已退出 */
  }
  await sleep(600)
  fs.rmSync(userData, { recursive: true, force: true })
}
