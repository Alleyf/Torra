// 运行时验证：全新安装第一眼看到的两块东西 —— 一次性引导 + 就地体检。
//
// 一个刚装上 Torra 的人，研讨首页上那条「开始讨论」是按不动的 —— 内置网页模型全都要登录、
// 一个 API 模型都还没配。这块要钉住的是：
// 1. 第一次进来先讲清「研讨 / 聊天 / 助手」三条路各管什么，看过就记在那份安装里，不再挡路；
// 2. 引导收掉后接着说缺什么（而不是让人猜为什么按钮是灰的），出路按得动、按下去真的到那件事的现场；
// 3. 判定口径和 store 自动勾选参与名单用的是同一条 —— 一旦有了能发言的模型，体检自己收掉。
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
// 端口不能写死：开发中的 Torra 或另一场验证先占了它，脚本就会连到别人的窗口上
const PORT = await freePort(9431)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-firstrun-'))
const outDir = path.join(ROOT, 'docs')

let failures = []
const check = (name, ok, extra) => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? ` · ${JSON.stringify(extra)}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let ws = null
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

/** 主进程连的是不是本脚本起的实例：靠 argv 里那份临时 userData 自证 */
async function assertOwnInstance() {
  const argv = String((await mainEval(`(process.argv || []).join('\\n')`)) || '')
  return argv.split('\n').includes(`--user-data-dir=${userData}`)
}

/** 窗口被完全挡住时 Chromium 不再产帧，截图会一直等到超时 */
async function revealWindow() {
  return mainEval(
    `(function(){
      try {
        const el = require('electron')
        for (const w of el.BrowserWindow.getAllWindows()) {
          if (w.isDestroyed()) continue
          if (w.isMinimized()) w.restore()
          w.show(); w.moveTop(); w.focus()
        }
        return 'ok'
      } catch (e) { return 'ERR:' + e.message }
    })()`,
  )
}

async function shot(name) {
  const variants = [{}, { captureBeyondViewport: true }, {}, { captureBeyondViewport: true }]
  let lastErr = null
  for (const params of variants) {
    try {
      await revealWindow().catch(() => null)
      await wsCdp.send('Page.bringToFront').catch(() => {})
      const r = await wsCdp.send('Page.captureScreenshot', { format: 'png', ...params }, 30000)
      const file = path.join(outDir, name)
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
      console.log('  截图 →', file)
      return
    } catch (e) {
      lastErr = e
      await sleep(1200)
    }
  }
  console.log(`  截图跳过 ${name}: ${lastErr?.message}`)
}

/** 体检块的全部可见内容 */
const checkDom = `(function(){
  const box=document.querySelector('.start-check');
  if(!box) return { present:false };
  const rows=[...box.querySelectorAll('.start-check-row')].map(r=>({
    title: r.querySelector('.start-check-main b')?.textContent||'',
    note: r.querySelector('.start-check-main i')?.textContent||'',
    buttons: [...r.querySelectorAll('.start-check-chips button')].map(b=>b.textContent.trim()),
  }));
  return {
    present: true,
    head: box.querySelector('.start-check-head')?.textContent||'',
    rows,
    overflow: box.scrollWidth - box.clientWidth,
    // 一块体检不该把首页顶得看不见议题输入框
    height: Math.round(box.getBoundingClientRect().height),
  };
})()`

/** 一次性引导块的全部可见内容 */
const introDom = `(function(){
  const box=document.querySelector('.start-intro');
  if(!box) return { present:false };
  const rows=[...box.querySelectorAll('.start-intro-row')].map(r=>({
    name: r.querySelector('.start-intro-name')?.textContent.trim()||'',
    desc: r.querySelector('.start-intro-desc')?.textContent.trim()||'',
    button: r.querySelector('button')?.textContent.trim()||'',
  }));
  return {
    present: true,
    head: box.querySelector('.start-intro-head')?.textContent||'',
    rows,
    foot: box.querySelector('.start-intro-foot')?.textContent||'',
    overflow: box.scrollWidth - box.clientWidth,
    height: Math.round(box.getBoundingClientRect().height),
  };
})()`

const ACTIVE_NAV = `(function(){const a=document.querySelector('.app-nav-item.active');return a?a.textContent.trim():''})()`

/** 按文字点一个按钮（浮层、导航、块里的按钮都走这一条） */
async function clickText(scopeSelector, text) {
  const hit = await evalJs(
    `(function(){
      const scope=document.querySelector(${JSON.stringify(scopeSelector)});
      if(!scope) return false;
      const b=[...scope.querySelectorAll('button')].find(x=>(x.textContent||'').trim()===${JSON.stringify(text)});
      if(!b) return false;
      b.click();
      return true;
    })()`,
    false,
  )
  await sleep(900)
  return hit
}

/** 主导航切页：导航项文字就是那两个字，图标不产文字 */
async function gotoSection(label) {
  return clickText('nav.app-nav', label)
}

/** 轮询到某个 DOM 条件成立（模型清单靠 models:changed 事件异步回来，不能睡死） */
async function waitFor(expr, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs
  let last = null
  while (Date.now() < until) {
    last = await evalJs(expr, false).catch(() => null)
    if (last) return last
    await sleep(400)
  }
  return last
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

  // 先自证身份再动手：主进程调试口连错实例的话，后面每一步都打在别人身上
  wsMainCdp = await connect((await findTarget('node')).webSocketDebuggerUrl)
  if (!(await assertOwnInstance())) throw new Error('调试口连到的不是本脚本启动的实例，停手')
  const page = await findTarget('page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  wsCdp = cdpClient(ws)
  await wsCdp.send('Runtime.enable')
  await wsCdp.send('Page.enable')
  const pageErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push('EX: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
  })
  await sleep(5000)

  // 首运行先过那道风险确认墙。必须点遮罩里的按钮：JS 的 click 不看遮挡，
  // 用全文匹配会点到遮罩底下的引导按钮，把「第一次」这一步悄悄消耗掉。
  let sawMask = false
  for (let i = 0; i < 10; i++) {
    const clicked = await evalJs(
      `(function(){const b=[...document.querySelectorAll('.modal-mask button')].find(x=>/我已理解/.test(x.textContent||''));if(b){b.click();return true}return false})()`,
      false,
    )
    if (clicked) {
      sawMask = true
      await sleep(500)
      continue
    }
    if (sawMask) break
    await sleep(800)
  }
  check('首运行弹窗已经点掉', (await evalJs(`!document.querySelector('.modal-mask')`, false)) === true)
  console.log('-'.repeat(46))

  // 1) 全新安装第一眼：先讲清「三条路各管什么」
  let box = null
  let intro = await evalJs(introDom)
  for (let i = 0; i < 10 && !intro.present; i++) {
    await sleep(800)
    intro = await evalJs(introDom)
  }
  check('全新安装时研讨首页给出一次性引导', intro.present === true, intro)
  check('引导说的是「三条路」', /三条路/.test(intro.head || ''), intro.head)
  const paths = (intro.rows || []).map((r) => r.name)
  check(
    '三条路都在：研讨 / 聊天 / 助手',
    ['研讨', '聊天', '助手'].every((n) => paths.includes(n)),
    paths,
  )
  check(
    '每条路都说了干什么、并且给一个去处',
    (intro.rows || []).every((r) => r.desc.length > 16 && r.button.length > 0),
    (intro.rows || []).map((r) => `${r.name}→${r.button}`),
  )
  check('引导末尾交代了三条路的共同前提', /模型清单/.test(intro.foot || ''), intro.foot)
  check('引导块没有横向溢出、也没盖住整屏', intro.overflow === 0 && intro.height < 300, { overflow: intro.overflow, height: intro.height })
  await shot('verify-first-run-intro.png')

  // 2) 一次性：点掉之后不再出现，而且「看过没有」是记在主进程那份安装里的
  check('点「去聊天」', await clickText('.start-intro', '去聊天'))
  check('真的切到了聊天', (await evalJs(ACTIVE_NAV, false)) === '聊天', await evalJs(ACTIVE_NAV, false))
  check('回得到研讨首页', await gotoSection('研讨'))
  await sleep(900)
  intro = await evalJs(introDom)
  check('引导收掉了，不会再挡回来', intro.present === false)
  const flagFile = path.join(userData, 'torra', 'flags', 'onboarding-seen')
  check('已读标记落在那份安装的 dataDir 里（重启也不会再问）', fs.existsSync(flagFile), flagFile)
  // 引导和体检不同时出现，但必须无缝交接：讲完「有什么」紧接着说「你缺什么」
  box = await evalJs(checkDom)
  check('引导收掉后就地体检接上', box.present === true, box.head)

  // 3) 一块能发言的模型都没有，必须在这一屏上说出口
  check('说的是「还没有能发言的模型」', /没有能发言的模型/.test(box.head || ''), box.head)
  const titles = (box.rows || []).map((r) => r.title)
  check(
    '两条出路都在：登录网页模型 / 配 API 模型',
    titles.some((t) => /登录一个网页模型/.test(t)) && titles.some((t) => /配一个 API 模型/.test(t)),
    titles,
  )
  // 这块只在「一个能发言的模型都没有」时出现，而助手自己也要一个带 Key 的 API 模型才能跑：
  // 把「让助手替你查」摆进来，等于把新人领进另一条死路。
  check('不会给出助手这条走不通的出路', !titles.some((t) => /助手/.test(t)), titles)
  check('每行都说了选了会发生什么', (box.rows || []).every((r) => r.note.length > 12), (box.rows || []).map((r) => r.note.slice(0, 18)))
  await shot('verify-first-run-check.png')

  // 4) 网页模型那一排 chip 必须来自「真的被判未登录」的清单，不是界面自己编的
  const models = await evalJs(`window.torra.listModels()`)
  const loggedOut = models.filter((m) => m.transport === 'webview' && m.enabled && m.status !== 'ready')
  const chips = (box.rows || []).find((r) => /登录一个网页模型/.test(r.title))?.buttons || []
  check('chip 列的就是那些没登录的网页模型', chips.length > 0 && chips.every((c) => loggedOut.some((m) => m.displayName === c)), { chips, 未登录: loggedOut.map((m) => m.displayName) })
  check('体检块没有横向溢出、也没长成半屏', box.overflow === 0 && box.height < 420, { overflow: box.overflow, height: box.height })

  // 5) 点 chip：内嵌网页视图真的开出来（登录就在那里面做）
  check('点一个网页模型 chip', await clickText('.start-check', chips[0]))
  const dockName = await waitFor(`document.querySelector('.webview-dock .wdh-id b')?.textContent||''`)
  check('开出来的是那个模型的网页视图', dockName === chips[0], { dockName, 期望: chips[0] })
  // 网页视图是整块换掉首页的，关掉后要能回到同一块体检 —— 问题没解决不该把人带回「一切正常」
  check('关掉网页视图回到首页', await evalJs(`(function(){const b=document.querySelector('.webview-dock-head button[title="关闭网页视图"]');if(b){b.click();return true}return false})()`, false))
  check('回到首页时体检块还在（问题没解决就不该消失）', (await waitFor(`!!document.querySelector('.start-check')`)) === true)

  // 6) 「去设置页添加」真的把人送到设置页
  //    认「主导航当前停在设置」而不是设置页内部的类名：那一页正在被重做，类名会变，
  //    而「按完以后人站在哪儿」是这块体检要负责到底的事。
  check('点「去设置页添加」', await clickText('.start-check', '去设置页添加'))
  const activeNav = await waitFor(
    `(function(){const a=document.querySelector('.app-nav-item.active');return a&&/设置/.test(a.textContent)?'settings':null})()`,
  )
  check('到的是设置页', activeNav === 'settings', activeNav)
  await shot('verify-first-run-settings.png')
  check('回得到研讨首页', await gotoSection('研讨'))
  box = await evalJs(checkDom)
  check('回来时体检块还挂着', box.present === true)

  // 7) 口径要跟 store 的自动勾选一致：配出一个有 Key 的 API 模型，这块就该自己收掉
  const created = await evalJs(
    `window.torra.createApiModel({ displayName:'验证用模型', baseUrl:'https://api.invalid.test/v1', apiKey:'sk-fake-for-test', model:'fake-chat', protocol:'openai' })`,
  )
  check('造出一个带 Key 的 API 模型', created?.ok === true, created)
  // 主进程保存后会推 models:changed，渲染层自己重取清单 —— 等价于在设置页点保存
  check('有了能发言的模型，体检块自己收掉', (await waitFor(`!document.querySelector('.start-check')`)) === true, await evalJs(checkDom))
  check(
    '首页照常是那张议题表单',
    (await evalJs(`!!document.querySelector('.empty-card .field input[type="text"]')`, false)) === true,
  )
  await shot('verify-first-run-resolved.png')

  // 8) 反过来也要成立：把那个模型删掉，缺的东西要重新说出口
  const gone = await evalJs(
    `(async()=>{ const ms = await window.torra.listModels(); const t = ms.find((m)=>m.displayName==='验证用模型'); return t ? await window.torra.deleteApiModel(t.id) : { ok:false, reason:'没找到' } })()`,
  )
  check('删掉那个验证用模型', gone?.ok === true, gone)
  check('缺的东西重新说出口', (await waitFor(`!!document.querySelector('.start-check')`)) === true)

  check('全程没有页面异常', pageErrors.filter((e) => e.startsWith('EX:')).length === 0, pageErrors.slice(0, 3))

  console.log('-'.repeat(46))
  if (failures.length) {
    console.log(`失败 ${failures.length} 项：${failures.join(' / ')}`)
    process.exitCode = 1
  } else console.log('全部通过')
}

main()
  .catch((e) => {
    console.error('验证失败:', e.message)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      if (child && child.exitCode === null) child.kill('SIGTERM')
    } catch {
      /* 已经退了 */
    }
    await sleep(800)
    try {
      fs.rmSync(userData, { recursive: true, force: true })
    } catch {
      /* 留给系统清理 */
    }
  })
