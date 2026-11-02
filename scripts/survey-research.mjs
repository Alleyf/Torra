// 设计体检：把科研工作台的每一页真拍下来，并量一份结构清单
//
// 为什么不用 dry-run 的 HTML 静态检查：布局是外壳用 rAF 量出来的，模块界面在
// 两层 frame 里，字号与密度只有真窗口才算得准。要看「太散 / 太密」这两个词
// 落在哪几屏，只能把每一屏都截下来、把字号色板摊开数。
//
// 数据来自真实配置的一份拷贝（只拷 research 插件的 store.json），
// 不写回用户目录：体检实例用临时 userData，用完即删。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'survey')
const REAL_STORE = path.join(process.env.APPDATA || '', 'torra', 'torra', 'plugin-data', 'research', 'store.json')
const PORT = await freePort(9481)
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-survey-'))

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let child = null

/* ---------- CDP ---------- */

function client(wsUrl) {
  const pending = new Map()
  const contexts = []
  let id = 0
  const ws = new WebSocket(wsUrl)
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(new Error('WS 连接失败: ' + (e.message || e.type))))
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    } else if (msg.method === 'Runtime.executionContextCreated') {
      contexts.push(msg.params.context)
    }
  })
  const api = {
    ready: opened,
    send(method, params = {}, timeoutMs = 30000) {
      const mid = ++id
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject })
        ws.send(JSON.stringify({ id: mid, method, params }))
        setTimeout(() => {
          if (pending.has(mid)) {
            pending.delete(mid)
            reject(new Error(`CDP 超时: ${method}`))
          }
        }, timeoutMs)
      })
    },
    async eval(expression, awaitPromise = true, timeoutMs = 30000) {
      const r = await api.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs)
      if (r.exceptionDetails) throw new Error('页内执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      return r.result.value
    },
    async frames() {
      const tree = await api.send('Page.getFrameTree')
      const out = []
      const walk = (node) => {
        out.push(node.frame)
        for (const kid of node.childFrames || []) walk(kid)
      }
      walk(tree.frameTree)
      return out
    },
    contextOf(frameId) {
      for (let i = contexts.length - 1; i >= 0; i--) {
        const ctx = contexts[i]
        if (ctx.auxData && ctx.auxData.frameId === frameId && ctx.auxData.isDefault) return ctx.id
      }
      return null
    },
    async evalIn(frameId, expression, awaitPromise = true) {
      const ctxId = api.contextOf(frameId)
      if (!ctxId) throw new Error('这一帧还没有执行上下文：' + frameId)
      const r = await api.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, contextId: ctxId })
      if (r.exceptionDetails) throw new Error('帧内执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      return r.result.value
    },
    async waitIn(frameId, selector, timeoutMs = 15000) {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        if (await api.evalIn(frameId, `!!document.querySelector(${JSON.stringify(selector)})`, false).catch(() => false)) return true
        await sleep(250)
      }
      return false
    },
    close() {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    },
  }
  return api
}

async function waitTarget(match, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const hit = list.find(match)
      if (hit) return hit
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  return null
}

/* ---------- 窗口与截图 ---------- */

let page = null
let panel = null

async function raiseWindow() {
  try {
    await page.send('Page.bringToFront').catch(() => {})
    await page.eval(
      `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;w.setAlwaysOnTop(true,'screen-saver');w.show();w.focus()}return 'ok'})()`,
      false,
    )
  } catch {
    /* 主进程里没有 electron 时就算了 */
  }
}

async function shot(name) {
  fs.mkdirSync(OUT, { recursive: true })
  await raiseWindow()
  await sleep(350)
  try {
    const r = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: false }, 30000)
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
    return true
  } catch (e) {
    console.log(`  截图失败 ${name}: ${e.message}`)
    return false
  }
}

/* ---------- 结构清单：一屏的字号、色板、密度 ---------- */

const INVENTORY = `(function(){
  var root = document.querySelector('.view.on') || document.body
  var nodes = [...root.querySelectorAll('*')].filter(function(n){
    return n.offsetParent !== null || n.tagName === 'BODY'
  })
  var fs = {}, color = {}, bg = {}, weights = {}
  var textNodes = 0
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], cs = getComputedStyle(n)
    var own = [...n.childNodes].some(function(c){ return c.nodeType === 3 && c.textContent.trim().length > 0 })
    if (!own) continue
    textNodes++
    fs[cs.fontSize] = (fs[cs.fontSize] || 0) + 1
    color[cs.color] = (color[cs.color] || 0) + 1
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') bg[cs.backgroundColor] = (bg[cs.backgroundColor] || 0) + 1
    weights[cs.fontWeight] = (weights[cs.fontWeight] || 0) + 1
  }
  var top = function(o){ return Object.entries(o).sort(function(a,b){return b[1]-a[1]}).slice(0, 6) }
  var scrollables = [...root.querySelectorAll('*')].filter(function(n){
    var s = getComputedStyle(n)
    return /(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 8
  }).length
  var radii = {}, shadows = 0, borders = 0
  for (var j = 0; j < nodes.length; j++) {
    var c = getComputedStyle(nodes[j])
    if (c.borderRadius && c.borderRadius !== '0px') radii[c.borderRadius] = (radii[c.borderRadius] || 0) + 1
    if (c.boxShadow && c.boxShadow !== 'none') shadows++
    if (parseFloat(c.borderTopWidth) > 0) borders++
  }
  return {
    textNodes: textNodes,
    cards: root.querySelectorAll('.card, .panel, section').length,
    buttons: root.querySelectorAll('button').length,
    inputs: root.querySelectorAll('input, select, textarea').length,
    tooltips: root.querySelectorAll('[title]').length,
    fontSizes: top(fs),
    colors: top(color),
    bgs: top(bg),
    weights: top(weights),
    radii: top(radii),
    shadows: shadows,
    borders: borders,
    scrollables: scrollables,
    box: { h: root.scrollHeight, ch: root.clientHeight, w: root.scrollWidth, cw: root.clientWidth },
    viewport: { w: innerWidth, h: innerHeight }
  }
})()`

/* ---------- 主流程 ---------- */

async function main() {
  // 真实数据的一份拷贝：只看、不改
  if (fs.existsSync(REAL_STORE)) {
    const dir = path.join(userData, 'torra', 'plugin-data', 'research')
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(REAL_STORE, path.join(dir, 'store.json'))
    console.log('已拷入真实 store.json（' + fs.statSync(REAL_STORE).size + ' 字节）')
  } else {
    console.log('没找到真实 store.json，跑空态')
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(
    electronBin,
    [
      ROOT,
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env },
  )
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|GPU|gpu|Warning|deprecat/i.test(s)) console.log('[app:err] ' + s.slice(0, 300))
  })

  const pageTarget = await waitTarget((t) => t.type === 'page' && /^file:\/\/.*index\.html/.test(t.url || ''))
  if (!pageTarget) throw new Error('未找到渲染层页面目标')
  page = client(await connect(pageTarget.webSocketDebuggerUrl))
  await page.ready
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  await raiseWindow()
  await sleep(1200)

  for (let i = 0; i < 6; i++) {
    const clicked = await page
      .eval(
        `(function(){var b=[...document.querySelectorAll('.modal-mask button, .start-intro-foot button, .intro-close')];if(!b.length)return false;b[b.length-1].click();return true})()`,
        false,
      )
      .catch(() => false)
    if (!clicked) break
    await sleep(300)
  }

  // 入口出现 ≠ 进程就绪；进程没起来时面板停在报错态、之后不会自己重试。
  // 这一段照抄 verify-lineage 的顺序：等 ready → 离开再回来 → 重挂载 → 等 OOPIF 目标。
  let navLabels = []
  for (let i = 0; i < 20; i++) {
    navLabels = await page.eval(`[...document.querySelectorAll('.app-nav-item')].map((b)=>b.getAttribute('aria-label')||b.textContent||'')`, false)
    if (navLabels.some((l) => l.indexOf('科研') >= 0)) break
    await sleep(300)
  }
  if (!navLabels.some((l) => l.indexOf('科研') >= 0)) {
    await page.eval(`window.torra.pluginsSetEnabled('research', true)`, false).catch(() => {})
    await page.eval(`window.dispatchEvent(new Event('torra:plugins-changed'))`, false).catch(() => {})
    for (let i = 0; i < 40; i++) {
      navLabels = await page.eval(`[...document.querySelectorAll('.app-nav-item')].map((b)=>b.getAttribute('aria-label')||b.textContent||'')`, false)
      if (navLabels.some((l) => l.indexOf('科研') >= 0)) break
      await sleep(400)
    }
  }
  await page.eval(
    `(function(){const b=[...document.querySelectorAll('.app-nav-item')].find((x)=>/科研/.test(x.getAttribute('aria-label')||x.textContent||''));if(!b)return 'no-nav';b.click();return 'ok'})()`,
    false,
  )
  let status = ''
  for (let i = 0; i < 40; i += 1) {
    status = await page.eval(`window.torra.pluginsList().then((r)=>((r&&r.plugins)||[]).map((p)=>p.id+':'+p.status).join(','))`, true).catch(() => '')
    if (/\bresearch:ready\b/.test(status)) break
    await sleep(500)
  }
  await page.eval(
    `(function(){const items=[...document.querySelectorAll('.app-nav-item')];const other=items.find((x)=>/科研/.test(x.getAttribute('aria-label')||x.textContent||'')?false:true);if(other)other.click();return !!other})()`,
    false,
  ).catch(() => {})
  await sleep(600)

  let panelTarget = null
  for (let i = 0; i < 8 && !panelTarget; i++) {
    await page.eval(
      `(function(){const b=[...document.querySelectorAll('.app-nav-item')].find((x)=>/科研/.test(x.getAttribute('aria-label')||x.textContent||''));if(b)b.click()})()`,
      false,
    ).catch(() => {})
    panelTarget = await waitTarget((t) => t.type === 'iframe' && /^torra-ui:\/\/frame\//.test(t.url || ''), 4000)
    if (!panelTarget) console.log(`    · 第 ${i + 1} 次没等到面板帧（进程状态 ${status}）`)
  }
  if (!panelTarget) throw new Error('科研工作台面板没出来')
  panel = client(await connect(panelTarget.webSocketDebuggerUrl))
  await panel.ready
  await panel.send('Runtime.enable')
  await panel.send('Page.enable')
  await sleep(2500)

  // 只拍浅色时：在面板建帧之前就切好主题。模块帧按建帧那一刻的明暗注入，
  // 跑完十屏再切主题，测到的要么是假的（帧没重建）、要么正好赶上窗口被盖住。
  const onlyLight = process.argv.includes('--light')
  if (onlyLight) {
    const nav = `(function(){const items=[...document.querySelectorAll('.app-nav-item')];const o=items.find(x=>/科研/.test(x.getAttribute('aria-label')||x.textContent||''));if(o)o.click();return !!o})()`
    await page.eval(`window.torra.setTheme('light')`, true).catch(() => {})
    await sleep(1000)
    await page.eval(nav, false).catch(() => {})
    await sleep(1200)
    await page.eval(nav, false).catch(() => {})
    await waitTarget((t) => t.type === 'iframe' && /^torra-ui:\/\/frame\//.test(t.url || ''), 8000)
    await sleep(2500)
  }

  const report = {}
  const panelFrame = (await panel.frames()).find((f) => f.url && /^torra-ui:\/\/frame\//.test(f.url))
  const fOuter = panelFrame ? panelFrame.id : (await page.frames()).find((f) => /torra-ui:\/\/frame\//.test(f.url || ''))?.id
  if (!fOuter) throw new Error('找不到面板外壳帧')
  const outer = panel

  // 模块界面在面板外壳帧里再套一层（srcdoc），属于面板那个 CDP target，
  // 主页面 target 的帧树里看不到它们，必须从 panel 这边找。
  async function moduleFrame(marker) {
    for (let i = 0; i < 40; i++) {
      for (const f of await panel.frames()) {
        if (await panel.evalIn(f.id, `!!document.querySelector(${JSON.stringify(marker)})`, false).catch(() => false)) return f.id
      }
      await sleep(400)
    }
    return null
  }

  async function goView(view) {
    await outer.evalIn(fOuter, `(function(){var b=document.querySelector('[data-view="${view}"]');if(b)b.click();return !!b})()`, false)
    await sleep(1200)
  }

  async function grab(name, frameId) {
    // 只拍浅色时给每张都加上前缀，免得和深色那几张同名覆盖、看着像没改
    name = (onlyLight ? 'light-' : '') + name
    const inv = frameId
      ? await panel.evalIn(frameId, INVENTORY, false).catch((e) => ({ error: String(e.message) }))
      : await panel.evalIn(fOuter, INVENTORY, false).catch((e) => ({ error: String(e.message) }))
    report[name] = inv
    const ok = await shot(name)
    console.log(`${ok ? '拍下' : '没拍到'} ${name} · 字号 ${JSON.stringify(inv.fontSizes || null)} · 颜色 ${(inv.colors || []).length}`)
    return ok
  }

  await goView('overview')
  await sleep(1500)
  await grab('shell-overview', null)

  await goView('scholar')
  const fScholar = await moduleFrame('#lib-card')
  await sleep(1800)
  await grab('scholar', fScholar)

  await goView('trajectory')
  await sleep(1200)
  const fTraj = await moduleFrame('#tj-graph')
  await sleep(1800)
  await grab('trajectory', fTraj)

  await goView('server')
  const fServer = await moduleFrame('#tab-obs')
  if (fServer) {
    await panel.evalIn(fServer, `document.querySelector('#tab-obs').click()`, false)
    await sleep(2500)
    await grab('server-obs', fServer)
    for (const [tab, name] of [
      ['#tab-history', 'server-history'],
      ['#tab-lineage', 'server-lineage'],
      ['#tab-manage', 'server-manage'],
    ]) {
      await panel.evalIn(fServer, `document.querySelector('${tab}').click()`, false)
      await sleep(2000)
      await grab(name, fServer)
    }
    await panel.evalIn(fServer, `document.querySelector('#tab-obs').click()`, false)
  }

  await goView('history')
  await sleep(1500)
  await grab('shell-history', null)

  // 浅色：只看外壳概览与实验机器观测两屏，确认两套 register 没跑偏。
  // 模块帧是按建帧那一刻的明暗注入的，光改主题不重建帧，测到的就是「外壳亮、模块黑」的假结果。
  // 「--light」模式下主题在建帧之前就切好了，这一段再关开面板切一次，只会把窗口折腾掉。
  if (!onlyLight) {
  const themed = await page.eval(`window.torra.setTheme('light')`, true).catch(() => null)
  if (themed && themed.ok !== false) {
    const nav = `(function(){const items=[...document.querySelectorAll('.app-nav-item')];const o=items.find(x=>/科研/.test(x.getAttribute('aria-label')||x.textContent||''));if(o)o.click();return !!o})()`
    await page.eval(nav, false).catch(() => {})
    await sleep(1200)
    await page.eval(nav, false).catch(() => {})
    await sleep(2500)
    await goView('overview')
    await sleep(1500)
    await grab('light-overview', null)
    await goView('server')
    await sleep(1800)
    await grab('light-server-obs', fServer)
    await page.eval(`window.torra.setTheme('dark')`, true).catch(() => {})
  } else {
    console.log('切浅色失败，跳过')
  }
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'inventory.json'), JSON.stringify(report, null, 2))
  console.log('\n清单写到 ' + path.join(OUT, 'inventory.json'))
}

/* ---------- 收尾 ---------- */

async function connect(wsUrl) {
  return wsUrl
}

let exitCode = 0
try {
  await main()
} catch (e) {
  console.error('体检失败：' + (e && e.stack ? e.stack : e))
  exitCode = 1
} finally {
  try {
    if (panel) panel.close()
    if (page) page.close()
  } catch {
    /* ignore */
  }
  try {
    child?.kill()
  } catch {
    /* ignore */
  }
  await sleep(600)
  try {
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {
    /* Temp 目录里，删不掉也无妨 */
  }
  process.exit(exitCode)
}
