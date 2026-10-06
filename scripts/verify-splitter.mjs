// 运行时验证：可拖动的区域边界（会话栏 / 聊天↔网页视图列）。
//
// 盯四件只有真窗口里才看得见的事：
// 1. 手柄不占布局宽度 —— 一旦出现就吃掉 7px，会话栏会从 208 变 215，看着像拖动没生效；
// 2. 真实鼠标按下→移动→抬起能把列拖宽，越界被夹住，双击恢复默认；
// 3. 宽度落在主进程 preferences.layout 里，重载之后还在；恢复默认是「删键」，
//    不是把当时的像素写死 —— 写死会让网页视图列再也跟着不放大窗口；
// 4. 网页视图那一列的边界不破坏放大态：放大时手柄收起、列占满整窗。
//
// 用一份全新的临时 userData 启动（等价于第一次安装），只管理本脚本 spawn 的 electron 进程，
// 用完连临时 userData 一起删掉。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
// 端口不能写死：开发中的 Torra 若占了它，脚本会连到别人的窗口上，拖动就打在真身
const PORT = await freePort(9441)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-splitter-'))
const prefsFile = path.join(userData, 'torra', 'preferences.json')

let failures = []
const check = (name, ok, extra) => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? ` · ${JSON.stringify(extra)}` : ''}`)
  if (!ok) failures.push(name)
}
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
    send(method, params = {}, timeoutMs = 15000) {
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
  throw new Error(kind === 'page' ? '未找到渲染层页面目标' : '未找到主进程调试目标（--inspect 没起来？）')
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

/** 拖动/点击都走真实输入通道：合成 Event 骗得过 handler，骗不过 pointer capture */
async function mouse(type, x, y, extra = {}) {
  await wsCdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
}

/** 按住手柄水平拖 dx 像素（分多帧，模拟真实移动）；抬起后等补间走完再量 */
async function drag(handleSelector, dx, steps = 8) {
  const box = await handleBox(handleSelector)
  const sx = box.x + box.w / 2
  const sy = box.y + box.h / 2
  await mouse('mousePressed', sx, sy)
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', sx + (dx * i) / steps, sy)
  await mouse('mouseReleased', sx + dx, sy)
  await sleep(500)
}

async function handleBox(sel) {
  return evalJs(
    `(function(){const el=document.querySelector(${JSON.stringify(sel)});if(!el)throw new Error('no handle');const r=el.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`,
    false,
  )
}

/** 主进程写下的那份偏好（直接读盘：这比让渲染层复述一遍更接近真相） */
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile, 'utf8'))
  } catch {
    return null
  }
}

const COL = {
  sess: `.cx-sessions`,
  web: `.cx-webview`,
  sessHandle: `.col-split[aria-label="调整会话栏宽度"]`,
  webHandle: `.col-split[aria-label="调整网页视图宽度"]`,
}

/** 关键尺寸一次读全：列宽 + 手柄是否可见 + 有没有横向溢出 */
const geom = `(function(){
  const w=(s)=>{const e=document.querySelector(s);return e?Math.round(e.getBoundingClientRect().width):null};
  const root=document.querySelector('.cx-root');
  // 放大态下手柄是 display:none，节点还在 —— 要数的是「看得见的」
  const visible=[...document.querySelectorAll('.cx-root > .col-split')]
    .filter((e)=>getComputedStyle(e).display!=='none').length;
  return {
    sess: w('.cx-sessions'), web: w('.cx-webview'), main: w('.cx-main'),
    handles: visible,
    overflow: root ? root.scrollWidth - root.clientWidth : null,
    zoom: document.body.classList.contains('webview-zoom'),
  };
})()`

async function toChatPage() {
  await evalJs(
    `(function(){const b=[...document.querySelectorAll('.app-nav-item')].find(x=>/聊天/.test(x.textContent||''));if(b)b.click();return !!b})()`,
  )
  for (let i = 0; i < 20; i++) {
    if (await evalJs(`!!document.querySelector('.cx-root')`)) return true
    await sleep(300)
  }
  return false
}

/** 关掉首运行弹窗（如果这次安装还没看过） */
async function dismissModals() {
  for (let i = 0; i < 4; i++) {
    const clicked = await evalJs(
      `(function(){const b=[...document.querySelectorAll('.modal-mask button')].find(x=>/我已理解|知道了|开始/.test(x.textContent||''));if(b){b.click();return true}return false})()`,
    )
    if (!clicked) return
    await sleep(400)
  }
}

/**
 * 打开研讨页的网页浮层：点模型栏里第一张「网页」卡。
 *
 * 单点卡片就是界面本来的入口（打开那个站点给人登录），
 * 不需要先跑一场讨论、也不依赖这次安装有没有能发言的模型。
 */
async function openDiscussOverlay() {
  const dismissed = await evalJs(
    `(function(){const b=document.querySelector('.start-intro-foot button');if(b)b.click();return !!b})()`,
  )
  if (dismissed) await sleep(500)
  const total = await evalJs(`document.querySelectorAll('.model-rail .model-card').length`)
  if (!total) return { ok: false, why: 'no-model-cards' }
  let tried = 0
  for (let i = 0; i < total; i++) {
    const box = await evalJs(
      `(function(){
        const c=[...document.querySelectorAll('.model-rail .model-card')][${i}];
        if(!c || !/网页/.test(c.textContent||'')) return null;
        const r=c.getBoundingClientRect();
        if(!(r.width>0&&r.height>0)) return null;
        return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2),
                name:(c.querySelector('.model-card-name')?.textContent||'').trim().slice(0,24)};
      })()`,
    )
    if (!box) continue
    tried++
    await mouse('mousePressed', box.x, box.y, { clickCount: 1 })
    await mouse('mouseReleased', box.x, box.y, { clickCount: 1 })
    for (let k = 0; k < 12; k++) {
      if (await evalJs(`!!document.querySelector('.discuss-webview .webview-dock')`)) {
        return { ok: true, via: box.name }
      }
      await sleep(300)
    }
  }
  return { ok: false, why: 'overlay-not-rendered', tried, total }
}

/**
 * 让某个网页模型进入聊天名单，并点开它那一列。
 *
 * 全新安装没有 API 模型，默认名单是空的（一轮几十秒的网页模型不该被默认勾满），
 * 所以这里按模型卡逐个双击 —— 用界面本来的入口，不去改 store 内部状态。
 */
async function openChatWebview() {
  for (let i = 0; i < 14; i++) {
    if (await evalJs(`!!document.querySelector('.cx-chip.is-webview')`)) break
    // 双击第 i 张模型卡 = 加入聊天名单
    const box = await evalJs(
      `(function(){const c=[...document.querySelectorAll('.model-rail .model-card')][${i}];if(!c)return null;const r=c.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    )
    if (!box) break
    await mouse('mousePressed', box.x, box.y, { clickCount: 1 })
    await mouse('mouseReleased', box.x, box.y, { clickCount: 1 })
    await mouse('mousePressed', box.x, box.y, { clickCount: 2 })
    await mouse('mouseReleased', box.x, box.y, { clickCount: 2 })
    await sleep(250)
  }
  const clicked = await evalJs(
    `(function(){const c=document.querySelector('.cx-chip.is-webview');if(!c)return false;c.click();return true})()`,
  )
  for (let i = 0; i < 30; i++) {
    if (await evalJs(`!!document.querySelector('.cx-webview .webview-dock')`)) return true
    await sleep(300)
  }
  return clicked && (await evalJs(`!!document.querySelector('.cx-webview')`))
}

/** 窗口被完全挡住时 Chromium 不再产帧；顺便把窗口放大到确定性的尺寸再量 */
async function setupWindow() {
  return mainEval(
    `(function(){
      try {
        const el = require('electron')
        for (const w of el.BrowserWindow.getAllWindows()) {
          if (w.isDestroyed()) continue
          if (w.isMinimized()) w.restore()
          w.show(); w.setContentSize(1600, 950); w.moveTop(); w.focus()
        }
        return 'ok'
      } catch (e) { return 'ERR:' + e.message }
    })()`,
  )
}

async function main() {
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
  const nodeTarget = await findTarget('node')
  wsMainCdp = await connect(nodeTarget.webSocketDebuggerUrl)

  // 自证连的是本脚本起的实例
  const argv = String((await mainEval(`(process.argv || []).join('\\n')`)) || '')
  check('连的是本脚本 spawn 的实例', argv.split('\n').includes(`--user-data-dir=${userData}`))

  await wsCdp.send('Runtime.enable')
  await setupWindow()
  await sleep(1500)
  await dismissModals()
  check('进入聊天页', await toChatPage())
  await sleep(800)

  const g0 = await evalJs(geom)
  check('会话栏右缘有一条手柄', g0.handles === 1 && g0.sess === 208, g0)

  // 1) 拖动加宽
  await drag(COL.sessHandle, 90)
  const g1 = await evalJs(geom)
  check('向右拖 90px → 会话栏约 298px', Math.abs(g1.sess - 298) <= 2, g1)
  check('拖动没有把整行撑出横向滚动', g1.overflow === 0, g1)

  // 2) 夹取上限
  await drag(COL.sessHandle, 700)
  const g2 = await evalJs(geom)
  check('拖过边界被夹在 420px', g2.sess === 420, g2)
  // 3) 夹取下限
  await drag(COL.sessHandle, -900)
  const g3 = await evalJs(geom)
  check('拖过头被夹在下限 210px', g3.sess === 210, g3)

  // 4) 落盘（防抖 320ms 之后）
  await sleep(700)
  const p1 = readPrefs()
  check('宽度写进主进程偏好 layout.chat.sessions', p1?.layout?.['chat.sessions'] === 210, p1?.layout)

  // 5) 双击恢复默认 = 删键，而不是把当前像素写死
  const hb = await handleBox(COL.sessHandle)
  await mouse('mousePressed', hb.x, hb.y, { clickCount: 2 })
  await mouse('mouseReleased', hb.x, hb.y, { clickCount: 2 })
  await sleep(700)
  const g4 = await evalJs(geom)
  const p2 = readPrefs()
  check('双击恢复默认宽 208px', g4.sess === 208, g4)
  check('恢复默认走的是删键', !('chat.sessions' in (p2?.layout || {})), p2?.layout)

  // 6) 折叠态不该留一条拖不动的边界
  await evalJs(
    `(function(){const b=document.querySelector('.cx-sessions .cx-icon-btn');if(b)b.click();return !!b})()`,
  )
  await sleep(600)
  const gc = await evalJs(geom)
  check('会话栏折叠时手柄收起', gc.handles === 0, gc)
  await evalJs(
    `(function(){const b=document.querySelector('.cx-sessions-peek');if(b)b.click();return !!b})()`,
  )
  await sleep(600)
  check('展开后手柄回来', (await evalJs(geom)).handles === 1)

  // 7) 网页视图列
  const opened = await openChatWebview()
  const gw = await evalJs(geom)
  check('打开网页模型后出现第二条约界手柄', opened && gw.handles === 2 && gw.web > 0, { opened, ...gw })
  if (opened && gw.handles === 2) {
    const before = gw.web
    await drag(COL.webHandle, 160)
    const gd = await evalJs(geom)
    check('向右拖宽网页视图列', gd.web > before, { before, ...gd })
    check('聊天主区没有被挤没', gd.main >= 400, gd)
    check('网页视图列没有撑破整行', gd.overflow === 0, gd)
    await sleep(700)
    const pw = readPrefs()
    check('网页视图宽度也已落盘', typeof pw?.layout?.['chat.webview'] === 'number', pw?.layout)

    // 8) 放大态：手柄收起、列占满 —— 内联 style 会破坏这条，故宽度走 CSS 变量
    const zoomed = await evalJs(
      `(function(){const b=[...document.querySelectorAll('.webview-dock .wdh-actions button')].find(x=>/放大/.test(x.getAttribute('aria-label')||''));if(b){b.click();return true}return false})()`,
    )
    await sleep(700)
    const gz = await evalJs(geom)
    check('放大态下没有可拖边界', zoomed && gz.zoom && gz.handles === 0, { zoomed, ...gz })
    check('放大态下网页视图占满整窗', gz.web > 600 && gz.sess === 0 && gz.main === 0, gz)
    await evalJs(`(function(){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})()`)
    await sleep(700)
    const gu = await evalJs(geom)
    check('Esc 还原后手柄与列宽都回来了', !gu.zoom && gu.handles === 2 && gu.web === gd.web, gu)
  }

  // 9) 重载之后尺寸 remembered：持久化的全部意义就在这里
  await drag(COL.sessHandle, 60)
  await sleep(700)
  const preReload = await evalJs(geom)
  await wsCdp.send('Page.reload')
  await sleep(2500)
  const page2 = await findTarget('page')
  wsCdp = await connect(page2.webSocketDebuggerUrl)
  await wsCdp.send('Runtime.enable')
  await dismissModals()
  await toChatPage()
  await sleep(1200)
  const gr = await evalJs(geom)
  check('重载后会话栏保持拖出来的宽度', Math.abs(gr.sess - preReload.sess) <= 2, { before: preReload.sess, after: gr.sess })

  // 10) 研讨页的网页视图浮层：手柄在左缘，方向相反（向左拖才是变宽）
  // 先收掉聊天页那一列，再进研讨 —— goSection 会把 viewMode 重置为 hall，浮层必须在进入之后再打开
  await evalJs(`(function(){const c=document.querySelector('.cx-chip.is-webview');if(c)c.click();return !!c})()`)
  await sleep(600)
  await evalJs(
    `(function(){const b=[...document.querySelectorAll('.app-nav-item')].find(x=>/研讨/.test(x.textContent||''));if(b)b.click();return !!b})()`,
  )
  await sleep(900)
  await dismissModals()
  const overlayOpened = await openDiscussOverlay()
  const overlay = `(function(){
    const e=document.querySelector('.discuss-webview');
    if(!e) return {present:false};
    const center=document.querySelector('.center');
    const h=e.querySelector('.col-split');
    return {
      present: true,
      w: Math.round(e.getBoundingClientRect().width),
      handle: h && getComputedStyle(h).display!=='none' ? 1 : 0,
      overflow: center ? Math.round(center.scrollWidth - center.clientWidth) : null,
      zoom: document.body.classList.contains('webview-zoom'),
    };
  })()`
  const o0 = await evalJs(overlay)
  check('研讨页点网页模型卡能打开浮层', o0.present && o0.handle === 1 && o0.w > 300, { overlayOpened, ...o0 })
  if (o0.present) {
    await drag('.discuss-webview .col-split', -120)
    const o1 = await evalJs(overlay)
    check('向左拖 120px → 浮层变宽', o1.w >= o0.w + 118, { before: o0.w, ...o1 })
    check('浮层没有越出所在区域', o1.overflow === 0, o1)
    await sleep(700)
    const po = readPrefs()
    check('浮层宽度也已落盘', po?.layout?.['discuss.webview'] === o1.w, { stored: po?.layout?.['discuss.webview'], dom: o1.w })

    // 放大态：浮层铺满、没有可拖边界；Esc 回来后仍是用户拖出来的那一档
    await evalJs(
      `(function(){const b=[...document.querySelectorAll('.discuss-webview .wdh-actions button')].find(x=>/放大/.test(x.getAttribute('aria-label')||''));if(b){b.click();return true}return false})()`,
    )
    await sleep(700)
    const oz = await evalJs(overlay)
    check('浮层放大态：铺满、无可拖边界', oz.zoom && oz.handle === 0, oz)
    await evalJs(`(function(){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})()`)
    await sleep(700)
    const ou = await evalJs(overlay)
    check('Esc 还原后仍是拖出来的宽度', !ou.zoom && ou.handle === 1 && ou.w === o1.w, ou)

    // 双击恢复默认：删键，让浮层重新按容器的 56% 走
    const oh = await handleBox('.discuss-webview .col-split')
    await mouse('mousePressed', oh.x, oh.y, { clickCount: 2 })
    await mouse('mouseReleased', oh.x, oh.y, { clickCount: 2 })
    await sleep(800)
    const od = await evalJs(overlay)
    const pd = readPrefs()
    check('浮层双击恢复默认宽', od.w < o1.w && !('discuss.webview' in (pd?.layout || {})), { w: od.w, before: o1.w, layout: pd?.layout })
  }

  console.log(failures.length ? `\n\x1b[31m${failures.length} 项未通过\x1b[0m ` + failures.join(', ') : '\n\x1b[32m全部通过\x1b[0m')
}

try {
  await main()
} catch (e) {
  console.error('验证脚本异常：', e)
  failures.push('exception')
} finally {
  try {
    child?.kill()
  } catch {
    /* 已退出 */
  }
  await sleep(600)
  fs.rmSync(userData, { recursive: true, force: true })
}
process.exit(failures.length ? 1 : 0)
