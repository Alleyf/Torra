// 运行时验证：入口与更新（全局快捷键 · 系统托盘 · 自动更新）。
//
// 这三样东西原本都在界面上找不到：托盘只存在于系统托盘里、快捷键只有一个默认的
// Ctrl+Alt+T 且改不了、更新状态在另一个页签深处。这里盯五件事：
//
//   1. 设置页真的有「入口与更新」这一页，里面能看到全局快捷键这一块；
//   2. 那一块显示的是运行时真相 —— 状态与主进程 globalShortcut.isRegistered 的回答一致，
//      停用后界面也得跟着改（不是写死的字符串）；
//   3. 改一次快捷键：旧的那条被注销、新的那条被注册上（主进程里查 isRegistered）；
//   4. 删掉的 preload API 确实不再暴露（window.torra 上查不到），
//      而留下的那些还在用。
//   5. 出厂默认的那条键本身挂得上 —— 这一条是被真坑出来的：原来的默认值
//      Ctrl+Alt+T 在 Windows 上是系统保留的（开新控制台），register 永远返回
//      false，于是「默认快捷键」生下来就是条死键。断言查的是运行时真相，不是配置文件。
//
// 用一份全新的临时 userData 启动，只管理本脚本 spawn 的 electron 进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'entries')
const PORT = await freePort(9583)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-entries-'))

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
    throw new Error('页内执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}

async function mainEval(expression) {
  const r = await wsMainCdp.send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true })
  if (r.exceptionDetails) throw new Error('主进程执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

/** 主进程里跑一个返回 Promise 的表达式，等它出结果 */
async function mainEvalAsync(expression) {
  const r = await wsMainCdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    includeCommandLineAPI: true,
  })
  if (r.exceptionDetails) throw new Error('主进程执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function shot(name) {
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}.png`)
  // 截图前把窗口顶到最前：别的进程（这台机器上常常还有别的验证脚本在跑 Electron）
  // 开着窗口时，被完全盖住的窗口不会再产生新的一帧，Page.captureScreenshot 会一直等下去。
  try {
    await wsCdp.send('Page.bringToFront', {}, 5000)
  } catch {
    /* 顶不到就算了，接着走下面的兜底 */
  }
  try {
    await mainEval(
      `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;w.setAlwaysOnTop(true,'screen-saver');w.show();w.focus()}return 'ok'})()`,
    )
  } catch {
    /* 主进程探不到就算了 */
  }
  await sleep(500)
  try {
    const r = await wsCdp.send('Page.captureScreenshot', { format: 'png' }, 15000)
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return true
  } catch {
    // 兜底：让主进程直接抓这一帧（capturePage 会自己强制重绘，不依赖窗口有没有被盖住）
    try {
      const data = await mainEval(
        `(function(){const w=require('electron').BrowserWindow.getAllWindows()[0];if(!w)return '';return w.webContents.capturePage().then(i=>i.toPNG().toString('base64'))})()`,
      )
      if (data) {
        fs.writeFileSync(file, Buffer.from(data, 'base64'))
        return true
      }
    } catch {
      /* 兜底也没成 */
    }
    console.log(`  \x1b[33mWARN\x1b[0m 截图没抓到：${name}`)
    return false
  }
}

/** 点一个按钮（按文案找），返回点到了没有 */
async function clickByText(selector, re) {
  return evalJs(
    `(function(){const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>${re}.test(x.textContent||''));if(!b)return false;b.click();return true})()`,
    false,
  )
}

/** 主进程里查一条全局快捷键此刻挂上没有（非法 accelerator 会抛，按「没挂上」算） */
function isRegistered(accel) {
  return mainEval(
    `(function(){try{return !!require('electron').globalShortcut.isRegistered(${JSON.stringify(accel)})}catch(e){return false}})()`,
  )
}

/** 读「入口与更新」这一页里三块的内容 */
async function readEntriesPage() {
  return evalJs(
    `(function(){
      const sec=(title)=>[...document.querySelectorAll('.st-section')].find(s=>{
        const h=s.querySelector('.st-sec-title');
        return h && (h.textContent||'').includes(title);
      });
      const hot=sec('全局快捷键');
      const tray=sec('系统托盘');
      const upd=sec('自动更新');
      const cap=hot&&hot.querySelector('.st-capture');
      const sw=hot&&hot.querySelector('.st-switch');
      return {
        hasHotkey: !!hot,
        hotkeyStatus: hot ? ((hot.querySelector('.st-meta span')||{}).textContent||'').trim() : null,
        hotkeyLabel: cap ? (cap.textContent||'').trim() : null,
        hotkeyEnabled: sw ? sw.getAttribute('aria-checked') : null,
        hasTray: !!tray,
        // 按菜单顺序把条目与分隔线都取出来：分隔线画成 .st-sep，条目画成 .st-row
        trayLabels: tray
          ? [...tray.querySelectorAll('.st-row, .st-sep')].map((n) =>
              n.classList.contains('st-sep') ? '---' : ((n.querySelector('.st-name') || {}).textContent || '').trim(),
            )
          : [],
        hasUpdate: !!upd,
        updateText: upd ? (upd.textContent||'').replace(/\\s+/g,' ').trim() : null,
        tabs: [...document.querySelectorAll('.st-nav-item')].map(b=>(b.textContent||'').trim()),
      };
    })()`,
    false,
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
  wsMainCdp = await connect((await findTarget('node')).webSocketDebuggerUrl)
  await wsCdp.send('Runtime.enable')
  await wsCdp.send('Page.enable')
  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;if(w.isMinimized())w.restore();w.show();w.setContentSize(1600,950);w.moveTop();w.focus()}return 'ok'})()`,
  )
  await sleep(1800)

  // 首次引导会挡住界面，先把它收掉
  await clickByText('.start-intro-foot button', /知道了|不再显示|开始/)
  await sleep(400)

  // ── 走到设置页 ──
  const wentSettings = await evalJs(
    `(function(){const b=document.querySelector('.app-nav-item[aria-label="设置"]');if(!b)return false;b.click();return true})()`,
    false,
  )
  check('进得去设置页', wentSettings === true)
  await sleep(1200)

  const wentEntries = await clickByText('.st-nav-item', /入口与更新/)
  check('设置页里有「入口与更新」这一页', wentEntries === true)
  await sleep(900)

  const page1 = await readEntriesPage()
  check('导航里确实有「入口与更新」', (page1.tabs || []).some((t) => t.includes('入口与更新')), { tabs: page1.tabs })
  check('这一页里有「全局快捷键」这一块', page1.hasHotkey === true)
  check('这一页里有「系统托盘」这一块', page1.hasTray === true)
  check('这一页里有「自动更新」这一块', page1.hasUpdate === true)

  // ── 托盘菜单条目：设置页写的 = 主进程建菜单用的那一份 ──
  const traySource = await mainEval(
    `(function(){try{return require(${JSON.stringify(path.join(ROOT, 'dist', 'main', 'tray.js'))}).TRAY_ENTRIES.map(e=>e.kind==='separator'?'---':e.label)}catch(e){return 'err:'+e.message}})()`,
  )
  const trayLive = await evalJs(
    `(function(){return window.torra.trayInfo().then(i=>({alive:i.alive,labels:i.entries.map(e=>e.kind==='separator'?'---':e.label)}))})()`,
    true,
  )
  check(
    '托盘条目与主进程那份一致（设置页 / 主进程 / 运行时三处同一份）',
    Array.isArray(traySource) &&
      Array.isArray(trayLive?.labels) &&
      JSON.stringify(traySource) === JSON.stringify(trayLive.labels) &&
      JSON.stringify(traySource) === JSON.stringify(page1.trayLabels),
    { traySource, trayLive, onScreen: page1.trayLabels },
  )
  check('托盘图标此刻真的挂着', trayLive?.alive === true, { alive: trayLive?.alive })

  // ── 快捷键：显示的是运行时真相 ──
  const hot0 = await evalJs(`(function(){return window.torra.getHotkey()})()`, true)
  const reg0 = await isRegistered(hot0.accel)
  check('主进程说这条键挂着', reg0 === true, { accel: hot0.accel, isRegistered: reg0 })
  check('界面写的是「生效中」', /生效中/.test(page1.hotkeyStatus || ''), { status: page1.hotkeyStatus })
  check('界面显示的键就是主进程挂的那条', (page1.hotkeyLabel || '').includes('T'), {
    label: page1.hotkeyLabel,
    accel: hot0.accel,
  })

  // 停用：运行时立刻不挂，界面也得跟着改（不是写死的字符串）
  await evalJs(`(function(){return window.torra.setHotkey({enabled:false,accel:${JSON.stringify(hot0.accel)}})})()`, true)
  await sleep(2600) // 界面上那一格是定期回主进程问的，等它下一轮
  const regOff = await isRegistered(hot0.accel)
  const pageOff = await readEntriesPage()
  check('停用后运行时真的注销了', regOff === false, { accel: hot0.accel, isRegistered: regOff })
  check('停用后界面写的是「已停用」', /已停用/.test(pageOff.hotkeyStatus || ''), { status: pageOff.hotkeyStatus })
  await shot('entries-hotkey-off')

  // ── 改键：旧键注销、新键注册 ──
  const NEW_ACCEL = 'CommandOrControl+Alt+K'
  const recStarted = await evalJs(
    `(function(){const b=document.querySelector('.st-capture');if(!b)return false;b.click();return true})()`,
    false,
  )
  check('点得到「录制快捷键」那颗按钮', recStarted === true)
  await sleep(300)
  await evalJs(
    `(function(){window.dispatchEvent(new KeyboardEvent('keydown',{key:'K',ctrlKey:true,altKey:true,bubbles:true}));return 'sent'})()`,
    false,
  )
  await sleep(900)

  const regNew = await isRegistered(NEW_ACCEL)
  const regOld = await isRegistered(hot0.accel)
  const hot1 = await evalJs(`(function(){return window.torra.getHotkey()})()`, true)
  const pageNew = await readEntriesPage()
  check('新键注册上了', regNew === true, { accel: NEW_ACCEL, isRegistered: regNew })
  check('旧键注销了', regOld === false, { accel: hot0.accel, isRegistered: regOld })
  check('主进程记下的就是新键', hot1.accel === NEW_ACCEL, { accel: hot1.accel })
  check('界面显示的键换成了新键', (pageNew.hotkeyLabel || '').includes('K'), { label: pageNew.hotkeyLabel })
  check('界面状态是「生效中」', /生效中/.test(pageNew.hotkeyStatus || ''), { status: pageNew.hotkeyStatus })

  // 换不成的键要说话，并且换回原来挂着的那条
  const BAD_ACCEL = 'CommandOrControl+NotAKey'
  const busy = await evalJs(
    `(function(){return window.torra.setHotkey({enabled:true,accel:${JSON.stringify(BAD_ACCEL)}}).then(r=>({ok:r.ok,reason:r.reason||'',accel:r.accel,registered:r.registered}))})()`,
    true,
  )
  await sleep(400)
  const regBusy = await isRegistered(BAD_ACCEL)
  const regKept = await isRegistered(NEW_ACCEL)
  check('换不成时有话说（不是静默失败）', typeof busy.reason === 'string' && busy.reason.length > 0, { busy })
  check('换不成的那条没有挂上', regBusy === false, { isRegistered: regBusy })
  check('换不成时原来那条还在', regKept === true, { isRegistered: regKept })
  check('配置与运行时一致（记的还是挂着的那条）', busy.accel === NEW_ACCEL, { accel: busy.accel })

  // ── 自动更新的当前状态 ──
  const upd = await evalJs(`(function(){return window.torra.getUpdateState()})()`, true)
  check('这一页露的是主进程那份更新状态', !!upd && typeof upd.phase === 'string', {
    phase: upd?.phase,
    current: upd?.current,
    note: upd?.note,
  })
  check('界面上的更新文字来自主进程那句', (pageNew.updateText || '').includes(upd?.note || '___no_note___'), {
    onScreen: pageNew.updateText,
    note: upd?.note,
  })

  await shot('entries-dark')

  // ── 浅色主题下同样在 ──
  await evalJs(
    `(function(){const b=document.querySelector('.theme-toggle');if(b){b.click();return true}return false})()`,
    false,
  )
  await sleep(1200)
  const pageLight = await readEntriesPage()
  check('浅色下这一页仍在', pageLight.hasHotkey === true && pageLight.hasTray === true, {
    hasHotkey: pageLight.hasHotkey,
    hasTray: pageLight.hasTray,
  })
  await shot('entries-light')

  // ── 删掉的 preload API 确实不再暴露 ──
  const api = await evalJs(
    `(function(){return {
      getGoogleClientData: typeof window.torra.getGoogleClientData,
      setGoogleClientData: typeof window.torra.setGoogleClientData,
      bootDiag: typeof window.torra.bootDiag,
      trayInfo: typeof window.torra.trayInfo,
    }})()`,
    false,
  )
  check('window.torra 上不再有 getGoogleClientData', api.getGoogleClientData === 'undefined', { api })
  check('window.torra 上不再有 setGoogleClientData', api.setGoogleClientData === 'undefined', { api })
  check('留着的那几个还在（bootDiag 仍被 scripts/smoke.js 调用）', api.bootDiag === 'function', { api })
  check('新加的 trayInfo 已暴露', api.trayInfo === 'function', { api })

  // 主进程那边，删掉的 IPC 通道也不该再有 handler 了。
  // 探法是功能性的：ipcMain.handle 对同一通道注册两次会抛错 ——
  // 抛了说明旧 handler 还在；没抛说明真的删干净了（顺手把自己装的那个拆掉）。
  const channels = await mainEval(
    `(function(){
      const { ipcMain } = require('electron');
      const probe = (ch) => {
        try { ipcMain.handle(ch, () => 'probe'); ipcMain.removeHandler(ch); return false }
        catch (e) { return /second handler|already registered/i.test(String(e.message)) ? true : 'err:' + e.message }
      };
      return {
        clientDataGet: probe('client-data:get'),
        clientDataSet: probe('client-data:set'),
        trayInfo: probe('tray:info'),
        hotkeyGet: probe('hotkey:get'),
      };
    })()`,
  )
  check('主进程里 client-data:get 的 handler 没了', channels.clientDataGet === false, { channels })
  check('主进程里 client-data:set 的 handler 没了', channels.clientDataSet === false, { channels })
  check('主进程里 tray:info 的 handler 在（新的那条）', channels.trayInfo === true, { channels })
  check('主进程里 hotkey:get 的 handler 在', channels.hotkeyGet === true, { channels })

  console.log(
    failures.length
      ? `\n\x1b[31m${failures.length} 项未通过\x1b[0m ` + failures.join(', ')
      : `\n\x1b[32m全部通过\x1b[0m · 截图在 ${OUT}`,
  )
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
