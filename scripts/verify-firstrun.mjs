// 运行时验证：第一次打开时人看到的那张脸
//
// 盯五件只有真窗口里才看得见的事：
// 1. 开场引导里确实有「编码」与「工作台」两行 —— 而且不再按数量说话（「三条路」这类写法不许残留）；
// 2. 「编码」那一行说清了它接的是外部编码智能体，并且点「去编码」真的落到编码那一屏；
// 3. 「工作台」默认只有一行摘要（渐进式展开），展开后才逐个列出内置工作台与一句说明；
// 4. 点「启用」真的写进了插件状态（主进程落盘那份 state），顶栏也多出插件入口；
//    点刚冒出来的「去科研工作台」不会落在空白屏上 —— 顶栏清单是异步刷新的，
//    这里等它出现（pendingPluginId），不是赌它已经在；
// 5. 模型侧栏底部那枚「添加模型」常驻且够大（≥24px），点开是两条路，
//    两条路各自通向现成的弹窗（智能添加 / 手配 API 模型），不是空按钮。
//
// 顺带量一遍对比度：深浅两套皮肤里引导文字都得读得下去（正文 4.5:1）。
//
// 用一份全新的临时 userData 启动，只管理本脚本 spawn 的 electron 进程，用完连目录一起删。
// 前提：dist/renderer 是最新的（npm run build:renderer）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'firstrun')
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-firstrun-'))

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

async function mouse(type, x, y, extra = {}) {
  await wsCdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
}

/** 真实鼠标点某个元素（按选择器 + 可选文本过滤），返回点到的那个元素的矩形 */
async function clickEl(selector, textRe) {
  const box = await evalJs(
    `(function(){
      const els=[...document.querySelectorAll(${JSON.stringify(selector)})];
      const el=${textRe ? `els.find(e=>new RegExp(${JSON.stringify(textRe)}).test(e.textContent||''))` : 'els[0]'};
      if(!el) return null;
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height),text:(el.textContent||'').replace(/\\s+/g,' ').trim()};
    })()`,
    false,
  )
  if (!box) return null
  if (box.w <= 0 || box.h <= 0) return { ...box, offscreen: true }
  if (box.y < 0 || box.y > 2000) return { ...box, offscreen: true }
  await mouse('mouseMoved', box.x, box.y)
  await sleep(120)
  await mouse('mousePressed', box.x, box.y)
  await mouse('mouseReleased', box.x, box.y)
  await sleep(200)
  return box
}

/** 轮询一个页内表达式，等它变成真值；返回最后一次读到的值 */
async function waitFor(expression, timeoutMs = 15000, step = 250) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await evalJs(expression, true)
      if (last) return last
    } catch (e) {
      last = 'ERR ' + (e.message || e)
    }
    await sleep(step)
  }
  return last
}

/** 把窗口叫醒：截图要一帧真的画出来，被别的窗口盖住时 Chromium 不会出帧 */
async function wake() {
  try {
    await mainEval(
      `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;if(w.isMinimized())w.restore();w.show();w.moveTop();w.focus()}return 'ok'})()`,
    )
    await sleep(250)
    await wsCdp.send('Page.bringToFront')
  } catch (e) {
    console.log('[wake] ' + (e.message || e))
  }
}

async function shot(name) {
  fs.mkdirSync(OUT, { recursive: true })
  let r = null
  for (let i = 0; i < 3 && !r; i++) {
    await wake()
    try {
      r = await wsCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 25000)
    } catch (e) {
      console.log(`[shot:${name}] 第 ${i + 1} 次失败 · ${e.message || e}`)
      await sleep(600)
    }
  }
  if (!r) throw new Error(`截图失败：${name}`)
  const p = path.join(OUT, `${name}.png`)
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'))
  return p
}

/** 顶栏导航的分区名（插件入口也在这里） */
const NAV_LABELS = `(function(){return [...document.querySelectorAll('.app-nav-item')].map(b=>(b.getAttribute('aria-label')||'').trim())})()`

/** 引导块的结构：行名、说明、按钮 */
const INTRO_READ = `(function(){
  const el=document.querySelector('.start-intro');
  if(!el) return null;
  const r=el.getBoundingClientRect();
  const rows=[...el.querySelectorAll('.start-intro-row')].map(row=>({
    cls: row.className,
    name:(row.querySelector('.start-intro-name')?.textContent||'').replace(/\\s+/g,' ').trim(),
    desc:(row.querySelector('.start-intro-desc')?.textContent||'').replace(/\\s+/g,' ').trim(),
    buttons:[...row.querySelectorAll('button')].map(b=>(b.textContent||'').replace(/\\s+/g,' ').trim()),
    svg: row.querySelectorAll('svg').length,
  }));
  return {
    head:(el.querySelector('.start-intro-head')?.textContent||'').replace(/\\s+/g,' ').trim(),
    foot:(el.querySelector('.start-intro-foot')?.textContent||'').replace(/\\s+/g,' ').trim(),
    text:(el.textContent||'').replace(/\\s+/g,' ').trim(),
    rows,
    visible: r.height>0 && r.width>0,
    h: Math.round(r.height),
    expanded: !!el.querySelector('.start-intro-work-panel'),
  };
})()`

/**
 * 对比度：把祖先链上的半透明底色一层层叠起来，得到这块文字脚下的实际背景。
 * 只取 background-color —— 玻璃层那点背景图不算进来（只当近似值用）。
 */
/**
 * 对比度按「真的画出来的像素」算，不靠 getComputedStyle 猜背景：
 * 这套界面大量用渐变与半透明玻璃，背景色算出来的值跟眼睛看到的不一样。
 * 做法：截一小块元素区域 → 解 PNG → 去掉与文字色接近的像素（字形与抗锯齿边缘）→
 * 剩下的众数就是这块文字脚下的实际背景。
 */
function decodePng(buf) {
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 6
  let bitDepth = 8
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error('只处理 8bit 位深，实际 ' + bitDepth)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0
  if (!channels) throw new Error('不支持的色型 ' + colorType)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = channels
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const f = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width, height, channels, data: out }
}

function parseColor(c) {
  const s = String(c).trim()
  const m = s.match(/[\d.]+/g) || []
  // color-mix 的计算值是 color(srgb r g b)，分量是 0..1，不是 0..255
  if (s.startsWith('color(')) {
    return {
      r: Math.round((+m[0] || 0) * 255),
      g: Math.round((+m[1] || 0) * 255),
      b: Math.round((+m[2] || 0) * 255),
      a: m[3] === undefined ? 1 : +m[3],
    }
  }
  return { r: +m[0] || 0, g: +m[1] || 0, b: +m[2] || 0, a: m[3] === undefined ? 1 : +m[3] }
}

function luminance(c) {
  const s = [c.r, c.g, c.b].map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]
}

function contrastRatio(a, b) {
  const L1 = luminance(a)
  const L2 = luminance(b)
  return Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100
}

/** 众数背景色：先把与文字色接近的像素（字形）剔掉 */
function dominantBg(img, fg) {
  const hist = new Map()
  const { width, height, channels, data } = img
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
      hist.set(key, (hist.get(key) || 0) + 1)
    }
  }
  const total = width * height
  let best = null
  let fallback = null
  let fallbackN = 0
  for (const [key, n] of hist) {
    const c = { r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255 }
    if (n > fallbackN) {
      fallbackN = n
      fallback = c
    }
    const d = Math.abs(c.r - fg.r) + Math.abs(c.g - fg.g) + Math.abs(c.b - fg.b)
    if (d < 60) continue
    if (!best || n > best.n) {
      best = { ...c, n }
    }
  }
  // 剔得太狠（前景背景本来就接近）时退回全体众数，宁可粗一点也别读成 0
  if (!best || best.n < total * 0.15) return fallback
  return best
}

/** 量一段文字与它脚下背景的对比度 */
async function contrastOf(sel) {
  const info = await evalJs(
    `(function(){
      const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null;
      const r=el.getBoundingClientRect();
      const cs=getComputedStyle(el);
      return {x:Math.round(r.left+window.scrollX),y:Math.round(r.top+window.scrollY),w:Math.round(r.width),h:Math.round(r.height),color:cs.color,text:(el.textContent||'').replace(/\s+/g,' ').trim().slice(0,24)};
    })()`,
    false,
  )
  if (!info || info.w <= 0 || info.h <= 0) return null
  const fg = parseColor(info.color)
  const shotBuf = await wsCdp.send(
    'Page.captureScreenshot',
    { format: 'png', clip: { x: info.x, y: info.y, width: info.w, height: info.h, scale: 1 }, captureBeyondViewport: true },
    25000,
  )
  const img = decodePng(Buffer.from(shotBuf.data, 'base64'))
  const bg = dominantBg(img, fg)
  if (!bg) return { fg: info.color, bg: null, ratio: null, size: { w: info.w, h: info.h } }
  return {
    fg: info.color,
    bg: `rgb(${bg.r},${bg.g},${bg.b})`,
    ratio: contrastRatio(fg, bg),
    size: { w: info.w, h: info.h },
    text: info.text,
  }
}

/** 关掉当前弹窗：优先点标题旁边那枚 ✕（文字按钮未必在首屏） */
async function closeModal() {
  const hit = await evalJs(
    `(function(){
      const m=document.querySelector('.modal-mask'); if(!m) return null;
      const h2=m.querySelector('h2');
      const x=h2&&h2.parentElement&&h2.parentElement.querySelector('button');
      const b=x||m.querySelector('.btn.icon')||[...m.querySelectorAll('button')].find(e=>/取消|关闭/.test(e.textContent||''));
      if(!b) return null; b.click(); return (b.getAttribute('aria-label')||b.textContent||'x').trim();
    })()`,
    false,
  )
  await sleep(600)
  const gone = await evalJs(`!document.querySelector('.modal-mask')`)
  return { hit, gone }
}

async function dismissModals() {
  for (let i = 0; i < 5; i++) {
    const clicked = await evalJs(
      `(function(){const b=[...document.querySelectorAll('.modal-mask button')].find(x=>/我已理解|知道了|开始|跳过/.test(x.textContent||''));if(b){b.click();return true}return false})()`,
    )
    if (!clicked) return
    await sleep(400)
  }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'renderer', 'index.html'))) {
    throw new Error('dist/renderer/index.html 不存在 —— 先跑 npm run build:renderer')
  }
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
  const argv = String((await mainEval(`(process.argv || []).join('\\n')`)) || '')
  check('连的是本脚本 spawn 的实例', argv.split('\n').includes(`--user-data-dir=${userData}`))
  await wsCdp.send('Runtime.enable')
  await wsCdp.send('Page.enable')

  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;if(w.isMinimized())w.restore();w.show();w.setContentSize(1600,950);w.moveTop();w.focus()}return 'ok'})()`,
  )
  await sleep(1800)
  await dismissModals()

  // ── 1. 引导块：它得自己先出现 ──
  const gotIntro = await waitFor(`!!document.querySelector('.start-intro')`, 20000)
  check('开场引导自己就出现了（全新 userData）', !!gotIntro, { gotIntro })
  const intro = await evalJs(INTRO_READ, false)
  if (!intro) {
    check('引导块可读', false, { intro })
    return
  }
  const names = intro.rows.map((r) => r.name)
  check(
    '引导里依次是 研讨/聊天/编码/工作台/助手',
    names.join('|') === '研讨|聊天|编码|工作台|助手',
    { names },
  )
  check('不再按数量说话（没有「三条路」这类写法）', !/三条路|三条去处|三个去处/.test(intro.text), {
    head: intro.head,
    foot: intro.foot,
  })
  check('标题不再报数量', !/[一二三四五六七八九十\d]\s*(条|处|个|屏)/.test(intro.head), { head: intro.head })

  const codeRow = intro.rows.find((r) => r.name.includes('编码'))
  const workRow = intro.rows.find((r) => r.name.includes('工作台'))
  const theme0 = await evalJs(`(function(){return document.documentElement.dataset.theme||'light'})()`, false)
  check(
    '「编码」那一行说清了接的是外部编码智能体',
    !!codeRow && ['Claude Code', 'Codex', 'pi', 'OpenCode'].every((k) => codeRow.desc.includes(k)),
    codeRow && { desc: codeRow.desc },
  )
  check(
    '「编码」那一行说明了不用在 Torra 里配 API Key',
    !!codeRow && /不用[^。]*API Key/.test(codeRow.desc),
    codeRow && { desc: codeRow.desc },
  )
  check(
    '「编码」那一行有「去编码」按钮和真 SVG 图标',
    !!codeRow && codeRow.buttons.some((b) => b.includes('去编码')) && codeRow.svg >= 1,
    codeRow && { buttons: codeRow.buttons, svg: codeRow.svg },
  )
  check(
    '「工作台」那一行说清了默认是关着的',
    !!workRow && /默认/.test(workRow.desc) && /关/.test(workRow.desc),
    workRow && { desc: workRow.desc },
  )
  check(
    '「工作台」默认只有一行摘要与一个启用按钮（渐进式展开）',
    !!workRow && !intro.expanded && workRow.buttons.some((b) => /启用/.test(b)),
    { expanded: intro.expanded, buttons: workRow?.buttons },
  )
  await shot(`01-intro-${theme0}`)

  // ── 2. 展开后逐个列出内置工作台 ──
  const toggle = await clickEl('.start-intro-work .start-intro-toggle')
  check('工作台那一行有展开开关', !!toggle, toggle)
  const panel = await waitFor(
    `(function(){const p=document.querySelector('.start-intro-work-panel');if(!p)return null;const cs=getComputedStyle(p);return {
      items:[...p.querySelectorAll('.start-intro-work-item')].map(it=>({
        name:(it.querySelector('b')?.textContent||'').trim(),
        desc:(it.querySelector('i')?.textContent||'').trim(),
        buttons:[...it.querySelectorAll('button')].map(b=>(b.textContent||'').trim()),
      })),
      bg:cs.backgroundColor, shadow:cs.boxShadow, radius:cs.borderTopLeftRadius, border:cs.borderTopWidth}})()`,
    8000,
  )
  const plugins = await evalJs(`window.torra.pluginsList().then(r=>r.plugins.map(p=>({id:p.id,name:p.name,enabled:p.enabled,panel:!!p.panel})))`)
  check(
    '展开后列出两个内置工作台，各带一句说明',
    !!panel && panel.items.length === 2 && panel.items.every((i) => i.name && i.desc.length > 8),
    panel && { items: panel.items.map((i) => ({ name: i.name, desc: i.desc.slice(0, 24) })) },
  )
  check(
    '列出来的名字与插件清单里的一致（id 读自清单，不是抄的）',
    !!panel && plugins.filter((p) => p.panel).every((p) => panel.items.some((i) => i.name === p.name)),
    { panel: panel?.items.map((i) => i.name), plugins: plugins.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled })) },
  )
  check(
    '展开面板是圆角 + 浮起阴影，不是描边',
    !!panel && panel.radius !== '0px' && panel.shadow !== 'none' && parseFloat(panel.border) === 0,
    panel && { radius: panel.radius, shadow: panel.shadow, border: panel.border },
  )
  await shot(`02-workbench-expanded-${theme0}`)

  // ── 3. 点启用：写状态 + 顶栏多出入口 ──
  const navBefore = await evalJs(NAV_LABELS, false)
  const spy = await evalJs(
    `(function(){
      try{
        const orig=window.torra.pluginsSetEnabled;
        window.__firstrunCalls=[];
        window.torra.pluginsSetEnabled=async function(...a){window.__firstrunCalls.push(a);return await orig.apply(this,a)};
        return {patched: window.torra.pluginsSetEnabled!==orig};
      }catch(e){return {patched:false,err:String(e)}}
    })()`,
    false,
  )
  const enableBtn = await clickEl('.start-intro-work-acts button', '启用')
  check('工作台那一行有一键启用的按钮', !!enableBtn, enableBtn)
  const calls = await waitFor(
    `(function(){const c=window.__firstrunCalls||[];return c.length?c:null})()`,
    10000,
  )
  const listed = await waitFor(
    `(function(){return window.torra.pluginsList().then(r=>{const p=r.plugins.filter(x=>x.enabled);return p.length?p.map(x=>({id:x.id,name:x.name,enabled:x.enabled})):null})})()`,
    15000,
  )
  check(
    'pluginsSetEnabled 真的被调用了',
    spy.patched ? !!calls : true,
    { patched: spy.patched, calls, listed },
  )
  if (spy.patched) {
    check(
      '调用参数是 (插件 id, true)',
      Array.isArray(calls) && calls.length >= 1 && calls.every((c) => c[1] === true),
      { calls },
    )
  }
  check(
    '两个内置工作台都变成已启用',
    !!listed && listed.length === 2 && listed.every((p) => p.enabled === true),
    { listed },
  )
  // 主进程落盘的那份状态：证明写是穿过 IPC 落到主进程的，不是页内自己画的
  const stateFile = path.join(userData, 'torra', 'plugins-state.json')
  let state = null
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch (e) {
    state = { readError: String(e.message || e), dir: fs.readdirSync(path.join(userData, 'torra')).slice(0, 20) }
  }
  check(
    '主进程把启用状态写进了 plugins-state.json',
    !!state?.plugins && Object.values(state.plugins).every((p) => p?.enabled === true),
    { file: stateFile, plugins: state?.plugins, readError: state?.readError, dir: state?.dir },
  )
  const navAfter = await waitFor(
    `(function(){const l=${NAV_LABELS};return l.length>${navBefore.length}?l:null})()`,
    15000,
  )
  check(
    '顶栏真的多出了插件入口',
    !!navAfter && navAfter.length === navBefore.length + 2,
    { before: navBefore, after: navAfter },
  )
  check(
    '多出来的入口就是那两个工作台',
    !!navAfter && navAfter.filter((l) => !navBefore.includes(l)).length === 2,
    { added: navAfter?.filter((l) => !navBefore.includes(l)) },
  )
  const rowNow = await evalJs(INTRO_READ, false)
  const workNow = rowNow?.rows.find((r) => r.name.includes('工作台'))
  check(
    '启用之后，那一行就地变成「去科研工作台 / 去技术工作台」',
    !!workNow && ['科研工作台', '技术工作台'].every((n) => workNow.buttons.some((b) => b.includes(`去${n}`))),
    workNow && { buttons: workNow.buttons },
  )
  check(
    '启用过程没有报过错（原因为空）',
    !!rowNow && !/启用失败|不存在|超时/.test(rowNow.text),
    { text: rowNow?.text?.slice(-80) },
  )
  await shot(`03-enabled-${theme0}`)

  // ── 4. 点刚出现的入口：不能落在空白屏上 ──
  const goBtn = await clickEl('.start-intro-work-acts button', '去科研工作台')
  check('启用过的那一行上就有「去科研工作台」按钮', !!goBtn, goBtn)
  const landed = await waitFor(
    `(function(){
      const p=document.querySelector('.plugin-page');
      const active=document.querySelector('.app-nav-item.active');
      return p ? {plugin:true, active:(active?.getAttribute('aria-label')||'').trim(), frames:document.querySelectorAll('.plugin-page iframe').length} : null;
    })()`,
    15000,
  )
  check('点「去科研工作台」落到插件屏，不是空白屏', !!landed && landed.plugin, landed)
  check('落在的正是科研工作台（顶栏高亮对得上）', !!landed && /科研工作台/.test(landed.active), landed && { active: landed.active })
  await shot(`04-plugin-screen-${theme0}`)

  // 回到研讨：引导没被启用动作关掉，回来看得见那两枚「去X」
  await clickEl('.app-nav-item', '研讨')
  const back = await waitFor(`!!document.querySelector('.start-intro')`, 8000)
  check('回到研讨后引导还在（启用不等于看过）', !!back, { back })
  const rowBack = await evalJs(INTRO_READ, false)
  const workBack = rowBack?.rows.find((r) => r.name.includes('工作台'))
  check(
    '回到研讨后那两枚入口还在原位',
    !!workBack && workBack.buttons.filter((b) => b.startsWith('去')).length === 2,
    workBack && { buttons: workBack.buttons },
  )

  // ── 5. 两套皮肤：先量当前这套，再翻到另一套量一遍 ──
  const THEME_NOW = `(function(){return document.documentElement.dataset.theme||'light'})()`
  const themeA = await evalJs(THEME_NOW, false)
  const CONTRAST_TARGETS = [
    ['.start-intro-desc', '引导说明文字'],
    ['.start-intro-name', '引导行名'],
    ['.start-intro-foot', '引导脚注'],
  ]
  const cA = {}
  for (const [sel, label] of CONTRAST_TARGETS) cA[sel] = await contrastOf(sel)
  await clickEl('.theme-toggle')
  const themeB = await waitFor(
    `(function(){const t=document.documentElement.dataset.theme||'light';return t!==${JSON.stringify(themeA)}?t:null})()`,
    8000,
  )
  check('主题切换真的翻了', !!themeB, { before: themeA, after: themeB })
  await sleep(700)
  const cB = {}
  for (const [sel] of CONTRAST_TARGETS) cB[sel] = await contrastOf(sel)
  for (const [theme, bag] of [
    [themeA, cA],
    [themeB || '?', cB],
  ]) {
    for (const [sel, label] of CONTRAST_TARGETS) {
      const c = bag[sel]
      check(`${theme} 主题下${label}读得下去（≥4.5:1）`, !!c && c.ratio >= 4.5, c)
    }
  }
  // 截图要一张浅色的：不在浅色就再翻回去
  if ((themeB || '') !== 'light') {
    await clickEl('.theme-toggle')
    await sleep(700)
  }
  const themeNow = await evalJs(THEME_NOW, false)
  check('截图那一刻是浅色皮肤', themeNow === 'light', { themeNow })
  const shotLight = await shot('05-intro-light')

  // ── 6. 侧栏底部的「添加模型」 ──
  const pinnedBefore = await evalJs(`(function(){const r=document.querySelector('.model-rail');return !!(r&&r.classList.contains('pinned'))})()`, false)
  if (!pinnedBefore) await clickEl('.rail-strip-pin')
  const rail = await waitFor(
    `(function(){const r=document.querySelector('.model-rail');if(!r)return null;return {cls:r.className, open:r.classList.contains('open')||r.classList.contains('pinned')}})()`,
    8000,
  )
  check('侧栏面板能打开（钉住）', !!rail && rail.open, rail)
  const add = await waitFor(
    `(function(){const b=document.querySelector('.model-add');if(!b)return null;const r=b.getBoundingClientRect();const cs=getComputedStyle(b);return {
      text:(b.textContent||'').replace(/\\s+/g,' ').trim(), svg:b.querySelectorAll('svg').length,
      w:Math.round(r.width), h:Math.round(r.height), visible:cs.visibility!=='hidden'&&cs.display!=='none'&&r.width>0}})()`,
    8000,
  )
  check(
    '侧栏底部有「添加模型」入口（图标 + 文字）',
    !!add && add.text.includes('添加模型') && add.svg >= 1 && add.visible,
    add,
  )
  check('那枚按钮的点击面积够大（≥24×24）', !!add && add.w >= 24 && add.h >= 24, add && { w: add.w, h: add.h })
  await clickEl('.model-add')
  const menu = await waitFor(
    `(function(){const m=document.querySelector('.model-add-menu');if(!m)return null;const cs=getComputedStyle(m);return {
      buttons:[...m.querySelectorAll('button')].map(b=>({text:(b.textContent||'').replace(/\\s+/g,' ').trim(), svg:b.querySelectorAll('svg').length})),
      bg:cs.backgroundColor, shadow:cs.boxShadow, radius:cs.borderTopLeftRadius, border:cs.borderTopWidth}})()`,
    8000,
  )
  const menuTexts = (menu?.buttons ?? []).map((b) => b.text)
  check('点开是两条路：智能添加 / 配一个 API 模型', menuTexts.length === 2 && /智能添加/.test(menuTexts[0] ?? '') && /API 模型/.test(menuTexts[1] ?? ''), { menuTexts })
  check('两条路都带真 SVG 图标', (menu?.buttons ?? []).every((b) => b.svg >= 1), menu?.buttons)
  check(
    '那个小面板是圆角 + 浮起阴影，不是描边',
    !!menu && menu.radius !== '0px' && menu.shadow !== 'none' && parseFloat(menu.border) === 0,
    menu && { radius: menu.radius, shadow: menu.shadow, border: menu.border },
  )
  const menuDesc = await contrastOf('.model-add-menu i')
  check('侧栏小面板里的说明文字读得下去（≥4.5:1）', !!menuDesc && menuDesc.ratio >= 4.5, menuDesc)
  await shot('06-add-model-light')

  // 两条路都要通向现成的弹窗，不许是空按钮
  await clickEl('.model-add-menu button', '智能添加')
  const smart = await waitFor(
    `(function(){const m=document.querySelector('.modal-mask');if(!m)return null;return {title:(m.querySelector('h2')?.textContent||'').trim()}})()`,
    10000,
  )
  check('「智能添加」通向现成的智能添加弹窗', !!smart && /智能添加/.test(smart.title), smart)
  await shot('07-smart-add-light')
  const closed = await closeModal()
  check('弹窗能关上', !!closed, { closed })

  await clickEl('.model-add')
  await clickEl('.model-add-menu button', 'API 模型')
  const api = await waitFor(
    `(function(){const m=document.querySelector('.modal-mask');if(!m)return null;return {title:(m.querySelector('h2')?.textContent||'').trim()}})()`,
    10000,
  )
  check('「配一个 API 模型」通向现成的 API 模型弹窗', !!api && /API 模型/.test(api.title), api)
  await closeModal()

  // ── 7. 「去编码」真的落到编码那一屏 ──
  await clickEl('.app-nav-item', '研讨')
  await waitFor(`!!document.querySelector('.start-intro')`, 8000)
  const codeBtn = await clickEl('.start-intro-row button', '去编码')
  check('引导里那枚「去编码」按钮在', !!codeBtn, codeBtn)
  const agents = await waitFor(
    `(function(){
      const active=document.querySelector('.app-nav-item.active');
      const label=(active?.getAttribute('aria-label')||'').trim();
      if(label!=='编码') return null;
      const body=document.body.innerText||'';
      return {active:label, intro:!!document.querySelector('.start-intro'), text:body.replace(/\\s+/g,' ').slice(0,120)};
    })()`,
    12000,
  )
  check('点「去编码」落到编码那一屏', !!agents && agents.active === '编码', agents)
  check('跳过去之后引导不再挡着', !!agents && agents.intro === false, agents && { intro: agents.intro })
  await shot('08-coding-screen-light')

  console.log(
    failures.length
      ? `\n\x1b[31m${failures.length} 项未通过\x1b[0m ` + failures.join(', ')
      : `\n\x1b[32m全部通过\x1b[0m · 截图在 ${OUT}`,
  )
  console.log('截图清单: ' + fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).join(', '))
  console.log('浅色引导截图: ' + shotLight)
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
