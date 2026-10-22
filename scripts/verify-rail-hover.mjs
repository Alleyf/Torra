// 运行时验证：模型侧栏「常态窄轨 + hover 浮出面板」。
//
// 盯六件只有真窗口里才看得见的事（合成 Event 骗得过 handler，也永远量不到真实矩形）：
// 1. 静止态这一列只占 --rail-strip-w（64px），面板整块必须在窗口左缘之外；
// 2. 真实鼠标移上去 → 面板滑出、body 出现 rail-sheet-open、--rail-sheet-reserve 被写出；
// 3. 迟开（<70ms 不该开）与早关（移开后 100ms 还该开着，之后必须收回）；
// 4. 面板浮出来时整行不许横向溢出，也不许把正文挤窄（列宽不变 = 原生视图不抖）；
// 5. 钉住（点展开键）之后这一列真的占到 --rail-w，且刷新之后还钉着；
// 6. 聊天页窄窗口（原生墙探到左侧）时，主进程那一侧的真实视图矩形要给浮层让位 ——
//    这一条只能读主进程：原生视图永远画在渲染层之上，DOM 矩形看不出它到底贴在哪。
//
// 用一份全新的临时 userData 启动（等价于第一次安装），只管理本脚本 spawn 的进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = await freePort(9461)
const INSPECT_PORT = await freePort(PORT + 1)
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-rail-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = []
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

let ws = null
let cdp = null
let wsMain = null
let cdpMain = null
async function findPage() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const hit = list.find((t) => t.type === 'page' && /^file:\/\/.*index\.html/.test(t.url || ''))
      if (hit) return hit
    } catch {
      /* 尚未就绪 */
    }
    await sleep(400)
  }
  throw new Error('未找到渲染层页面目标')
}
async function findMainTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json()
      const hit = list.find((t) => t.type === 'node' && t.webSocketDebuggerUrl)
      if (hit) return hit
    } catch {
      /* 尚未就绪 */
    }
    await sleep(400)
  }
  throw new Error('未找到主进程调试目标（--inspect 没起来？）')
}
async function connect() {
  const page = await findPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  cdp = cdpClient(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
}

/** 主进程那条通道只连一次：重载页面不会换掉主进程 */
async function connectMain() {
  const hit = await findMainTarget()
  wsMain = new WebSocket(hit.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    wsMain.addEventListener('open', res)
    wsMain.addEventListener('error', rej)
  })
  cdpMain = cdpClient(wsMain)
  await cdpMain.send('Runtime.enable')
}
async function evalJs(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails)
    throw new Error('页内执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
async function mainEval(expression) {
  const r = await cdpMain.send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true })
  if (r.exceptionDetails)
    throw new Error('主进程执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
async function mouse(type, x, y, extra = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
}
async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(ROOT, 'output', name), Buffer.from(r.data, 'base64'))
  console.log(`  图: output/${name}`)
}

/**
 * 最窄的那一档：聊天页原生墙 + 窄轨态 + 会话栏收起。
 *
 * 墙是原生 WebContentsView，永远画在渲染层之上：不夹的话侧栏浮层会被站点页面切掉，
 * 看起来「只弹了一半」；夹过头则网页白瘦一截。这一档才是两侧都要验的形状。
 */
async function openNarrowWall() {
  // 把一个网页模型弄进聊天名单（合成 dblclick 落在 DOM 上，不要求卡片可见）
  for (let i = 0; i < 10; i++) {
    if (await evalJs(`!!document.querySelector('.cx-chip.is-webview')`)) break
    const added = await evalJs(
      `(function(){const c=[...document.querySelectorAll('.model-rail .model-card')][${i}];if(!c)return false;c.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window}));return true})()`,
    )
    if (!added) break
    await sleep(250)
  }
  await evalJs(`(function(){const c=document.querySelector('.cx-chip.is-webview');if(c)c.click();return !!c})()`)
  for (let i = 0; i < 30; i++) {
    if (await evalJs(`!!document.querySelector('.cx-webview .webview-dock')`)) break
    await sleep(300)
  }
  /*
   * 窄轨态只在原生视图下存在（顶栏那颗开关只在 viewMode==='native' 时渲染），
   * 而默认档会跟着参与者构成选；先按界面本来的入口把它按到原生墙，再探。
   */
  await evalJs(
    `(function(){const b=[...document.querySelectorAll('.cx-seg-btn')].find(x=>/\u539f\u751f/.test(x.textContent||''));if(b)b.click();return !!b})()`,
  )
  await sleep(800)
  /*
   * 窄轨态：轮次列收成一条 74px 的轨，墙才能探到 320px 以内 —— 不进入这一态，
   * 夹子根本没事可做，这一项就只是假绿。标题是动态的（「收起左栏」/「展开左栏」），
   * 所以按 .cx-row.lean 这个结果类判，不按按钮文案猜。
   */
  for (let i = 0; i < 12; i++) {
    if (await evalJs(`!!document.querySelector('.cx-row.lean')`)) break
    await evalJs(
      `(function(){const b=[...document.querySelectorAll('.cx-topbar-actions button')].find(x=>/左栏/.test(x.getAttribute('title')||''));if(b)b.click();return !!b})()`,
    )
    await sleep(400)
  }
  // 会话栏收起：再让出一档
  await evalJs(`(function(){const b=document.querySelector('.cx-sessions .cx-icon-btn');if(b)b.click();return !!b})()`)
  await sleep(600)
  return evalJs(
    `(function(){const b=document.querySelector('.cx-webview .webview-dock-body');if(!b)return null;const r=b.getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),w:Math.round(r.width),lean:!!document.querySelector('.cx-row.lean'),sess:Math.round(document.querySelector('.cx-sessions')?.getBoundingClientRect().width??-1)}})()`,
  )
}

/** 一次读全侧栏的状态：占位宽、面板矩形、类名、CSS 变量 */
const STATE = `(function(){
  const rail=document.querySelector('.model-rail');
  const sheet=document.querySelector('.rail-sheet');
  if(!rail||!sheet) return null;
  const rr=rail.getBoundingClientRect(), sr=sheet.getBoundingClientRect();
  const cs=getComputedStyle(document.documentElement);
  return {
    railW: Math.round(rr.width), railL: Math.round(rr.left),
    sheetR: Math.round(sr.right), sheetL: Math.round(sr.left), sheetW: Math.round(sr.width),
    railRight: Math.round(rr.right),
    open: rail.classList.contains('open'),
    pinned: rail.classList.contains('pinned'),
    bodyOpen: document.body.classList.contains('rail-sheet-open'),
    reserve: cs.getPropertyValue('--rail-sheet-reserve').trim(),
    sheetVis: getComputedStyle(sheet).visibility,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    mainW: Math.round(document.querySelector('.center-main')?.getBoundingClientRect().width ?? 0),
    stripItems: document.querySelectorAll('.rail-strip-item').length,
    cards: document.querySelectorAll('.model-rail .model-card').length,
  };
})()`

async function main() {
  const child = spawn(
    electronBin,
    [
      `--inspect=${INSPECT_PORT}`,
      ROOT,
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|Debugging suggestion|GPU|gpu|Warning|deprecat/i.test(s)) console.log('[app:err] ' + s)
  })
  try {
    await connect()
    await connectMain()
    // 窗口收到确定性尺寸：窄轨/浮层的像素判据与「钉住态是否挤正文」都要在已知宽度下才成立
    await mainEval(
      `(function(){ const el = require('electron'); for (const w of el.BrowserWindow.getAllWindows()) { if (w.isDestroyed()) continue; if (w.isMinimized()) w.restore(); w.show(); w.setContentSize(1600, 950); w.moveTop(); w.focus() } return 'ok' })()`,
    )
    await sleep(1500)
    await evalJs(
      `(function(){const b=[...document.querySelectorAll('.modal-mask button')].find(x=>/我已理解|知道了|开始|同意/.test(x.textContent||''));if(b)b.click();return !!b})()`,
    )
    // 等侧栏真的挂上去：主进程调试器接上之后首帧比之前慢，写死一个 sleep 就是一条偶发红
    let s0 = null
    for (let i = 0; i < 40; i++) {
      s0 = await evalJs(STATE)
      if (s0 && s0.stripItems > 0) break
      await sleep(500)
    }
    if (!s0 || !s0.stripItems) {
      console.log('STATE:', JSON.stringify(s0))
      const cls = await evalJs(
        `(function(){const r=document.querySelector('.model-rail');return {cls:r?r.className:null, strip:!!document.querySelector('.rail-strip'), items:document.querySelectorAll('.rail-strip-item').length, pinnedPref:(function(){try{return localStorage.getItem('torra.rail.pinned')}catch(e){return 'x'}})()}})()`,
      )
      console.log('侧栏节点:', JSON.stringify(cls))
      const diag = await evalJs(
        `(function(){const btns=[...document.querySelectorAll('button')].map(b=>(b.textContent||'').trim()).filter(Boolean).slice(0,20);return {href:location.href,rootChild:document.querySelector('#root')?.firstElementChild?.className||'', bodyChild:document.body.firstElementChild?.className||'', btns}})()`,
      )
      console.log('诊断:', JSON.stringify(diag))
      await shot('verify-rail-diag.png')
    }
    check('侧栏在页面上（含窄轨头像与卡片面板）', !!s0 && s0.stripItems > 0 && s0.cards > 0, s0)
    if (!s0) throw new Error('侧栏未挂载，后面的判据都无法取值')
    check('静止态这一列只占 64px 窄轨', s0.railW === 64, { railW: s0.railW })
    check(
      '静止态面板退到窗口左缘之外（连隐形盒子都不占）',
      s0.sheetR <= 0,
      { sheetR: s0.sheetR },
    )
    check('静止态没有 open 类与让位变量', !s0.open && !s0.bodyOpen && s0.reserve === '', s0)
    await shot('verify-rail-closed.png')

    // 2) 迟开：刚移进去 40ms 还不该开
    // 先把键盘/visibility 的事实记下来：hover 全靠指针事件，而 Chrome 在页面不可见或
    // 窗口失焦时不一定派发它们 —— 这是“时好时坏”的第一个该排除的原因。
    console.log(
      '  页面可见性:',
      JSON.stringify(await evalJs(`(function(){return {vis:document.visibilityState, hasFocus:document.hasFocus(), winW:window.innerWidth, winH:window.innerHeight}})()`)),
    )
    await evalJs(
      `(function(){window.__pe=[];const r=document.querySelector('.model-rail');for(const t of ['pointerenter','pointerleave','pointerover','pointerout','mouseenter','mousedown'])r.addEventListener(t,e=>window.__pe.push(t+':'+(e.pointerType||'')),true);return true})()`,
    )
    const box = await evalJs(
      `(function(){const e=document.querySelector('.rail-strip-item');const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
    )
    await mouse('mouseMoved', 900, 600)
    await mouse('mouseMoved', box.x, box.y)
    await sleep(40)
    const sFast = await evalJs(STATE)
    check('刚移进去 40ms 还没弹（迟开 70ms）', !sFast.open, { open: sFast.open })
    await sleep(120)
    const s1 = await evalJs(STATE)
    console.log('  指针事件:', JSON.stringify(await evalJs(`window.__pe`)))
    check('停了一会儿之后面板浮出', s1.open && s1.bodyOpen, s1)
    check('浮出后面板右缘探到 200px 外', s1.sheetR >= 200, { sheetR: s1.sheetR })
    check('浮出没有撑破整行（无横向溢出）', s1.overflowX === 0, { overflowX: s1.overflowX })
    /*
     * 让位量必须在第一帧就是落位值。面板靠 transform 滑出，拿 rect 会读到动画中间位，
     * 而原生视图已经在按这个值贴 —— 浮层底下一截网页先露出来、几百毫秒后再缩回去。
     * 落位值 = 窄轨右缘 + 面板宽，与 rect 此刻是多少无关（所以这里不拿 sheetR 当标准）。
     * 容差 4px：--rail-w 是 clamp 出来的非整数宽。
     */
    check('刚滑出时让位量已经是落位值（不是动画中间帧 64px）',
      s1.reserve !== '' && Math.abs(parseInt(s1.reserve) - (s1.railRight + s1.sheetW)) <= 4 && parseInt(s1.reserve) > s1.railRight + 150, {
      reserve: s1.reserve,
      expect: s1.railRight + s1.sheetW,
    })
    await sleep(400)
    const s1b = await evalJs(STATE)
    check('动画走完后面板右缘与让位量对得上（±4px）',
      s1b.reserve !== '' && Math.abs(parseInt(s1b.reserve) - s1b.sheetR) <= 4, {
      reserve: s1b.reserve,
      sheetR: s1b.sheetR,
    })
    check('浮出没有挤窄正文（列宽与静止态一致）', s1.mainW === s0.mainW, { closed: s0.mainW, open: s1.mainW })
    await shot('verify-rail-open.png')

    // 3) 面板里的卡片真的能点（浮层不是只有外观）
    const cardBox = await evalJs(
      `(function(){const c=document.querySelector('.model-rail .model-card');if(!c)return null;const r=c.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),t:(c.textContent||'').trim().slice(0,20)}})()`,
    )
    check('面板里的卡片在可视范围内', !!cardBox && cardBox.x > 0 && cardBox.x < 400, cardBox)
    if (cardBox) {
      await mouse('mouseMoved', cardBox.x, cardBox.y)
      await sleep(200)
      const s2 = await evalJs(STATE)
      check('鼠标移到面板上时面板保持展开', s2.open && s2.bodyOpen, s2)
    }

    // 4) 早关：移开后 100ms 内还该开着，之后必须收回
    await mouse('mouseMoved', 900, 600)
    await mouse('mouseMoved', 1200, 700)
    await sleep(100)
    const s3 = await evalJs(STATE)
    check('移开后 100ms 内还留着（早关 140ms）', s3.open, { open: s3.open })
    await sleep(400)
    const s4 = await evalJs(STATE)
    check('彻底移开之后面板收回', !s4.open && !s4.bodyOpen, s4)
    check('收回后让位变量被清掉', s4.reserve === '', { reserve: s4.reserve })
    check('收回后窄轨仍在原位（占位没变）', s4.railW === 64, { railW: s4.railW })

    // 5) 钉住：整列占到 --rail-w，且这一列真的挤了正文
    const pin = await evalJs(
      `(function(){const b=document.querySelector('.rail-strip-pin');if(!b)return false;b.click();return true})()`,
    )
    await sleep(500)
    const s5 = await evalJs(STATE)
    check('点展开键之后进入钉住态', pin && s5.pinned && s5.open, s5)
    check('钉住态这一列占到面板宽（≥212px）', s5.railW >= 212, { railW: s5.railW })
    check('钉住态面板与这一列同宽（不再外挂）', Math.abs(s5.sheetW - s5.railW) <= 1, { sheetW: s5.sheetW, railW: s5.railW })
    /*
     * 钉住改了面板的起点（64 → 0）却没改宽，而 ResizeObserver 只看尺寸不看位置：
     * 不跟着 pinned 重算，让位量就会永远多留一条窄轨宽，原生视图白瘦一截。
     */
    check('钉住态的让位量跟着起点重算（不多留窄轨宽）',
      s5.reserve !== '' && Math.abs(parseInt(s5.reserve) - s5.sheetR) <= 4, { reserve: s5.reserve, sheetR: s5.sheetR })
    check('钉住态也没有横向溢出', s5.overflowX === 0, { overflowX: s5.overflowX })
    await shot('verify-rail-pinned.png')

    // 钉住态：鼠标移开也不该收
    await mouse('mouseMoved', 1200, 700)
    await sleep(400)
    const s6 = await evalJs(STATE)
    check('钉住态移开鼠标仍然展开', s6.open && s6.pinned, s6)

    // 取消钉住 → 回窄轨，且落盘
    const unpin = await evalJs(
      `(function(){const b=[...document.querySelectorAll('.rail-sheet .rail-toggle')].find(x=>/取消固定/.test(x.getAttribute('title')||''));if(!b)return false;b.click();return true})()`,
    )
    await sleep(500)
    const s7 = await evalJs(STATE)
    check('取消钉住回到 64px 窄轨', unpin && !s7.pinned && s7.railW === 64, { railW: s7.railW, pinned: s7.pinned })
    const ls = await evalJs(`localStorage.getItem('torra.rail.pinned')`)
    check('钉住偏好写进 localStorage（这次是关）', ls === '0', { ls })

    // 重载后偏好仍在（先钉住再重载）
    await evalJs(`(function(){document.querySelector('.rail-strip-pin').click()})()`)
    await sleep(300)
    await cdp.send('Page.reload')
    await ws.close()
    await sleep(2500)
    await connect()
    await sleep(1200)
    const s8 = await evalJs(STATE)
    check('重载之后仍是钉住态（偏好跨刷新）', !!s8 && s8.pinned && s8.railW >= 212, s8 && { pinned: s8.pinned, railW: s8.railW })

    // 6) 聊天页原生墙 + 窄窗口：浮层与原生视图不能重叠
    await evalJs(
      `(function(){const b=[...document.querySelectorAll('.rail-sheet .rail-toggle')].find(x=>/取消固定/.test(x.getAttribute('title')||''));if(b)b.click();return !!b})()`,
    ) // 先取消钉住
    await sleep(400)
    await evalJs(
      `(function(){const b=[...document.querySelectorAll('.app-nav-item')].find(x=>/聊天/.test(x.textContent||''));if(b)b.click();return !!b})()`,
    )
    await sleep(1200)
    const wall = await openNarrowWall()
    check('聊天页原生墙已挂上', !!wall, wall)
    if (wall) {
      /*
       * 证据取主进程那一侧的真实矩形，不取 DOM：原生 WebContentsView 永远画在渲染层之上，
       * 「夹没夹」在页面上看不出来（DOM 矩形无论如何都是那块）。contentView 的子视图
       * 就是贴上去的那几块，getBounds() 是用户真正看到的位置。
       */
      const nativeBounds = async () => {
        const raw = await mainEval(
          `(function(){
            const el = require('electron')
            // 只要屏幕上那一枚主窗口：后台实例挂在宿主窗口里，它被故意摆在 -32000，
            // 子视图永远是 1280x900 的整窗尺寸 —— 拿它当证据会验不到任何东西。
            const main = el.BrowserWindow.getAllWindows().find((w) => {
              if (w.isDestroyed()) return false
              const b = w.getContentBounds()
              return b.x > -1000 && /index\.html/.test(w.webContents.getURL() || '')
            })
            if (!main) return '[]'
            const kids = main.contentView.children.filter((c) => c.getBounds().width > 0)
            return JSON.stringify(kids.map((c) => { const b = c.getBounds(); return { x: b.x, y: b.y, w: b.width, h: b.height } }))
          })()`,
        )
        return JSON.parse(String(raw))
      }
      const p = await evalJs(
        `(function(){const e=document.querySelector('.rail-strip-item');const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
      )
      // 先确认这一档真的窄到墙与浮层占同一段（否则下面两条是假绿）
      check('窄窗口下墙确实与浮层占同一段（夹子真的有事可做）', wall.left < 320, wall)
      await mouse('mouseMoved', 1200, 700)
      await sleep(700)
      const before = await nativeBounds()
      await mouse('mouseMoved', p.x, p.y)
      await sleep(900)
      const during = await nativeBounds()
      const w1 = await evalJs(STATE)
      console.log('  hover 后的侧栏状态:', JSON.stringify(w1))
      check('浮层在原生墙上也完整弹开', w1.open && parseInt(w1.reserve) > 200, { reserve: w1.reserve, open: w1.open })
      check('原生视图确实挂在窗口上（否则这一项验不到东西）', before.length > 0, before)
      /*
       * 夹过的判据：hover 期间每一块原生视图的左缘都不得落在浮层里（< 浮层右缘），
       * 同时不得被夹没（宽 >= 24，否则 dock 会直接摘掉视图，那就是另一种坏）。
       */
      const intruding = during.filter((b) => b.w >= 24 && b.x < w1.sheetR - 1)
      check(
        '原生墙让开浮层：没有一块视图压在浮层那一段上',
        during.length > 0 && intruding.length === 0,
        { views: during, sheetRight: w1.sheetR },
      )
      check(
        '让位是「挪边界」不是「摘视图」：视图仍在且没被夹没',
        during.length === before.length && during.every((b) => b.w >= 24 && b.h >= 24),
        { before: before.length, during: during.map((b) => b.w) },
      )
      await shot('verify-rail-wall.png')
      await mouse('mouseMoved', 1200, 700)
      await sleep(900)
      const after = await nativeBounds()
      check(
        '浮层收起后视图长回原位（让位不是单向的）',
        JSON.stringify(after) === JSON.stringify(before),
        { before, after },
      )
    }

    console.log(`\n${failures.length ? '失败：' + failures.join(' / ') : '全部通过'}`)
  } finally {
    child.kill()
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* Windows 上偶尔慢一拍，忽略 */ }
  }
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* */ }
  process.exit(1)
})
