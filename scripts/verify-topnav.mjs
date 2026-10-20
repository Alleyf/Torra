// 运行时验证：标题栏两端（左：分区导航；右：助手 / 主题开关）
//
// 盯七件只有真窗口里才看得见的事：
// 1. 导航确实收成了图标排 —— 单项接近 30×26 的方块，整块宽度远低于带文字的旧版；
// 2. 静止时文字不可见，hover / 键盘聚焦才浮出气泡，且气泡落在视口内不被裁掉；
// 3. 气泡压在正文之上 —— 标题栏没有定位时，正文列里带 z-index 的浮动手柄会盖住它；
// 4. 右端两枚开关与左端共用同一副玻璃外壳、同一档图标，不再是一枚带描边的圆角方块；
//    贴着窗口右缘的那枚，气泡必须贴右沿长出来，否则必然被裁掉一截；
// 5. 两套主题都拿到这些结构样式（本仓库犯过的老错：它们只写在深色覆盖里）；
// 6. 点图标仍能切分区、能开抽屉，且 aria-label / textContent 两条取名路径都还在 ——
//    前者给读屏，后者是其余 verify-* 与 smoke 脚本定位分区、按钮的既有写法；
// 7. 助手「开着」的高亮不许和导航的「当前分区」长成同一个实心青色块 ——
//    一栏里两枚实心，反而分不清人在哪。
//
// 用一份全新的临时 userData 启动，只管理本脚本 spawn 的 electron 进程，用完连目录一起删。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'topnav')
const PORT = await freePort(9461)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-topnav-'))

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

/** 真实鼠标移到第 i 枚导航图标中心；返回该中心 */
async function hoverNav(i) {
  const box = await evalJs(
    `(function(){const el=[...document.querySelectorAll('.app-nav-item')][${i}];if(!el)throw new Error('no nav item');const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
    false,
  )
  await mouse('mouseMoved', box.x, box.y)
  await sleep(320) // 气泡有 80ms 延迟 + 120ms 补间
  return box
}

/** 真实鼠标移到右端第 i 枚开关中心 */
async function hoverTool(i) {
  const box = await evalJs(
    `(function(){const el=[...document.querySelectorAll('.app-tools .assistant-toggle, .app-tools .theme-toggle')][${i}];if(!el)throw new Error('no tool');const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
    false,
  )
  await mouse('mouseMoved', box.x, box.y)
  await sleep(320)
  return box
}

async function leaveNav() {
  await mouse('mouseMoved', 800, 600)
  await sleep(260)
}

/** 导航整块的读数：几何 + 静止态文字 + 两套主题都该有的结构样式 */
const NAV_READ = `(function(){
  const cs=(el)=>getComputedStyle(el);
  const num=(v)=>parseFloat(v)||0;
  const bar=document.querySelector('.titlebar');
  const nav=document.querySelector('.app-nav');
  const items=[...document.querySelectorAll('.app-nav-item')];
  const labels=items.map((b)=>b.querySelector('.app-tip'));
  const navR=nav.getBoundingClientRect();
  return {
    theme: document.documentElement.dataset.theme,
    titlebarH: Math.round(bar.getBoundingClientRect().height),
    navW: Math.round(navR.width), navR: {x:Math.round(navR.x),y:Math.round(navR.y)},
    n: items.length,
    itemW: Math.round(items[0].getBoundingClientRect().width),
    itemH: Math.round(items[0].getBoundingClientRect().height),
    // 静止时：文字必须不可见，但仍留在 DOM 里（textContent 供旧脚本定位）
    labelHidden: labels.every((l)=>cs(l).visibility==='hidden' && num(cs(l).opacity)===0),
    labelInDom: labels.every((l)=>!!l && (l.textContent||'').trim().length>0),
    aria: items.map((b)=>(b.getAttribute('aria-label')||'').trim()),
    text: items.map((b)=>(b.textContent||'').trim()),
    active: (document.querySelector('.app-nav-item.active .app-tip')||{}).textContent,
    // 两套主题共用的结构样式：缺一条就是「切回白天导航失去样式」那个老错
    styled: {
      navBg: cs(nav).backgroundImage!=='none' || cs(nav).backgroundColor!=='rgba(0, 0, 0, 0)',
      navBorder: num(cs(nav).borderTopWidth)>0,
      itemRadius: /999|\\d\\dpx/.test(cs(items[0]).borderTopLeftRadius),
      labelBg: cs(labels[0]).backgroundColor,
      labelPos: cs(labels[0]).position,
    },
    // 层级：导航要盖过正文里最高的那个浮动手柄(col-split, 45)，又要在抽屉(120)之下
    navZ: cs(nav).zIndex, navPos: cs(nav).position,
    // 标题栏右端有没有溢出窗口
    barOverflow: Math.round(bar.scrollWidth - bar.clientWidth),

    /* ── 右端那一组开关：这一轮的主角 ──
     * 判据不是「好不好看」，而是「和左端是不是同一副外壳、同一档图标」——
     * 割裂感来自两处：容器（带描边的方块 vs 玻璃胶囊）和图标尺寸（14 vs 15）。 */
    tools: (() => {
      const g = document.querySelector('.app-tools');
      if (!g) return null;
      const kids = [...g.querySelectorAll('.assistant-toggle, .theme-toggle')];
      const shell = ['padding', 'border-top-width', 'border-top-left-radius', 'background-color', 'gap'];
      const item = ['width', 'height', 'border-top-width', 'border-top-left-radius', 'background-color'];
      // 拿「非选中」的两枚比：导航第 0 项是 active，主题开关永远不是
      const plain = items[1];
      const plainTool = kids[1];
      return {
        n: kids.length,
        w: Math.round(g.getBoundingClientRect().width),
        itemW: Math.round(kids[0].getBoundingClientRect().width),
        itemH: Math.round(kids[0].getBoundingClientRect().height),
        // 外壳与图标逐条对齐导航：任何一条不同，两端就是两种东西
        sameShell: shell.every((p) => cs(g)[p] === cs(nav)[p]),
        sameItem: item.every((p) => cs(plainTool)[p] === cs(plain)[p]),
        iconSize: kids.map((k) => Math.round(k.querySelector('svg').getBoundingClientRect().width)),
        aria: kids.map((k) => (k.getAttribute('aria-label') || '').trim()),
        tipText: kids.map((k) => (k.querySelector('.app-tip')?.textContent || '').trim()),
        tipHidden: kids.every((k) => cs(k.querySelector('.app-tip')).visibility === 'hidden'),
        stillBtn: kids.some((k) => k.classList.contains('btn')),
        navActiveBg: cs(items[0]).backgroundColor,
      };
    })(),
  };
})()`

/** 悬停右端第 i 枚开关时气泡的几何（右端要贴右沿，不能被窗口裁掉） */
function toolTipRead(i) {
  return `(function(){
    const kids=[...document.querySelectorAll('.app-tools .assistant-toggle, .app-tools .theme-toggle')];
    const el=kids[${i}]; const l=el.querySelector('.app-tip'); const s=getComputedStyle(l);
    const r=l.getBoundingClientRect(); const ir=el.getBoundingClientRect();
    return {
      text:(l.textContent||'').trim(),
      visible: s.visibility==='visible' && (parseFloat(s.opacity)||0)>0.9,
      belowItem: r.top > ir.bottom,
      rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
      inViewport: r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight,
      // 贴右沿：气泡右边应与按钮右边基本齐平，而不是居中探出窗口
      rightAligned: Math.abs(r.right - ir.right) <= 2,
    };
  })()`
}

/** 悬停第 i 枚时气泡的几何与可见性 */
function tipRead(i) {
  return `(function(){
    const el=[...document.querySelectorAll('.app-nav-item')][${i}];
    const l=el.querySelector('.app-tip'); const s=getComputedStyle(l);
    const r=l.getBoundingClientRect(); const ir=el.getBoundingClientRect();
    return {
      text:(l.textContent||'').trim(),
      visible: s.visibility==='visible' && (parseFloat(s.opacity)||0)>0.9,
      aboveItem: r.top > ir.bottom,
      rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
      inViewport: r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight,
      // 气泡中心那一点，最上面的元素应当就是它自己（pointer-events:none 时
      // elementFromPoint 会跳过它，所以这里比的是「导航块」而不是文字本身）
      topIsNav: (()=>{const e=document.elementFromPoint(r.left+r.width/2, ir.top+ir.height/2);return !!(e&&e.closest('.app-nav'))})(),
    };
  })()`
}

async function shot(name) {
  const r = await wsCdp.send('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
}

/** 只拍标题栏那一条，看排布看得更清楚 */
async function shotBar(name) {
  const clip = await evalJs(
    `(function(){const r=document.querySelector('.titlebar').getBoundingClientRect();return {x:0,y:0,width:Math.ceil(r.width),height:Math.ceil(r.height)+34}})()`,
    false,
  )
  const r = await wsCdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...clip, scale: 2 },
    captureBeyondViewport: false,
  })
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
}

async function dismissModals() {
  for (let i = 0; i < 5; i++) {
    const clicked = await evalJs(
      `(function(){const b=[...document.querySelectorAll('.modal-mask button, .start-intro-foot button')].find(x=>/我已理解|知道了|开始|跳过/.test(x.textContent||''));if(b){b.click();return true}return false})()`,
    )
    if (!clicked) return
    await sleep(400)
  }
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
  const argv = String((await mainEval(`(process.argv || []).join('\\n')`)) || '')
  check('连的是本脚本 spawn 的实例', argv.split('\n').includes(`--user-data-dir=${userData}`))
  await wsCdp.send('Runtime.enable')
  await wsCdp.send('Page.enable')

  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;if(w.isMinimized())w.restore();w.show();w.setContentSize(1600,950);w.moveTop();w.focus()}return 'ok'})()`,
  )
  await sleep(1500)
  await dismissModals()
  await leaveNav()

  // ── 1. 图标态的几何 ──
  let read = await evalJs(NAV_READ, false)
  await shotBar('bar-rest-dark')
  await shot('full-dark')
  check('四项导航齐全且当前分区有 active', read.n === 4 && !!read.active, { n: read.n, active: read.active })
  check('单项收成方块（宽 ≤ 34、高 ≤ 28）', read.itemW <= 34 && read.itemH <= 28, { w: read.itemW, h: read.itemH })
  check('整块导航宽度 ≤ 150px（旧版带文字约 290px）', read.navW <= 150, { navW: read.navW })
  check('标题栏收矮到 52±1px', Math.abs(read.titlebarH - 52) <= 1, { titlebarH: read.titlebarH })
  check('文字静止时不可见', read.labelHidden)
  check('文字仍在 DOM 里（旧脚本按 textContent 定位不破）', read.labelInDom && read.text.length === 4, { text: read.text })
  check('aria-label 四项齐备', read.aria.join('|') === '研讨|聊天|历史|设置', { aria: read.aria })
  check('标题栏无横向溢出', read.barOverflow <= 0, { overflow: read.barOverflow })

  // ── 1b. 右端开关：与左端同一副外壳，不再是一枚带描边的方块 ──
  const t = read.tools
  check('两枚开关收进 .app-tools 胶囊', !!t && t.n === 2 && !t.stillBtn, t && { n: t.n, stillBtn: t.stillBtn })
  check('开关外壳与导航外壳逐条一致（内距/描边/圆角/底色/间隙）', !!t && t.sameShell, t && { w: t.w })
  check('开关图标与导航图标同档（尺寸/描边/圆角/底）', !!t && t.sameItem, t && { itemW: t.itemW, itemH: t.itemH })
  check('开关图标 15px，与导航一致', !!t && t.iconSize.every((s) => s === 15), t && t.iconSize)
  check('开关文字静止时收起，且带 aria-label', !!t && t.tipHidden && t.aria.every(Boolean), t && { tipText: t.tipText, aria: t.aria })
  check('开关气泡文案不撞分区名（smoke 按 textContent 找按钮）', !!t && !t.tipText.some((x) => /研讨|聊天|历史|设置|返回/.test(x)), t && t.tipText)

  // ── 2. hover 出气泡 ──
  await hoverNav(1)
  const tip = await evalJs(tipRead(1), false)
  check('悬停第 2 项浮出「聊天」气泡', tip.visible && tip.text === '聊天', tip)
  check('气泡落在图标下方', tip.aboveItem, { rect: tip.rect, navR: read.navR })
  check('气泡完整在视口内（没被窗口裁掉）', tip.inViewport, { rect: tip.rect })
  check('气泡不被正文浮层截断（导航层高于正文手柄）', tip.topIsNav && Number(read.navZ) > 45, {
    navZ: read.navZ,
    navPos: read.navPos,
  })
  await shotBar('bar-hover-dark')

  // 右端那枚贴着窗口边，居中气泡必然被裁 —— 必须改成贴右沿
  await leaveNav()
  await hoverTool(1)
  const tTip = await evalJs(toolTipRead(1), false)
  check('悬停主题开关浮出气泡', tTip.visible && /主题/.test(tTip.text), tTip)
  check('右端气泡不被窗口右边裁掉', tTip.inViewport, { rect: tTip.rect })
  check('右端气泡贴右沿而非居中探出', tTip.rightAligned, { rect: tTip.rect })
  await shotBar('bar-hover-tool-dark')

  // 横扫不该每枚都闪：移开即收
  await leaveNav()
  const afterLeave = await evalJs(
    `(function(){const l=document.querySelectorAll('.app-nav .app-tip')[1];const s=getComputedStyle(l);return s.visibility==='hidden'})()`,
    false,
  )
  check('鼠标移开后气泡收起', afterLeave)

  // ── 3. 点击切分区 ──
  const box = await hoverNav(3)
  await mouse('mousePressed', box.x, box.y)
  await mouse('mouseReleased', box.x, box.y)
  await sleep(1200)
  const nowActive = await evalJs(
    `(function(){const a=document.querySelector('.app-nav-item.active');return a?(a.getAttribute('aria-label')||''):''})()`,
    false,
  )
  check('点击图标切到「设置」', nowActive === '设置', { nowActive })
  await shotBar('bar-settings-dark')

  // ── 4. 两套主题都要有结构样式 ──
  check('当前主题下导航有底、有描边、气泡有不透明底', read.styled.navBg && read.styled.navBorder && !/rgba\(0, 0, 0, 0\)/.test(read.styled.labelBg), read.styled)
  await evalJs(`(function(){const b=document.querySelector('.theme-toggle');if(b)b.click();return !!b})()`)
  await sleep(1200)
  await dismissModals()
  await leaveNav()
  const light = await evalJs(NAV_READ, false)
  check('切到白天后主题属性确实翻转', light.theme !== read.theme, { before: read.theme, after: light.theme })
  check('白天主题下导航样式没丢（底/描边/方块圆角/气泡底）', light.styled.navBg && light.styled.navBorder && light.styled.itemRadius && !/rgba\(0, 0, 0, 0\)/.test(light.styled.labelBg), light.styled)
  check('白天主题下几何与层级不变', light.navW === read.navW && light.navZ === read.navZ, {
    navW: light.navW,
    navZ: light.navZ,
  })
  await hoverNav(0)
  const lightTip = await evalJs(tipRead(0), false)
  check('白天主题下气泡同样可见', lightTip.visible && lightTip.text === '研讨', lightTip)
  check('白天主题下开关组几何不变', !!light.tools && light.tools.w === read.tools.w && light.tools.sameShell && light.tools.sameItem, {
    w: light.tools?.w,
    sameShell: light.tools?.sameShell,
    sameItem: light.tools?.sameItem,
  })
  await shotBar('bar-hover-light')

  // ── 5. 助手开着时不许冒充「当前分区」 ──
  const ab = await hoverTool(0)
  await mouse('mousePressed', ab.x, ab.y)
  await mouse('mouseReleased', ab.x, ab.y)
  await sleep(1200)
  const activeState = await evalJs(
    `(function(){
      const a=document.querySelector('.assistant-toggle'), n=document.querySelector('.app-nav-item.active');
      const g=getComputedStyle(a).backgroundColor, m=getComputedStyle(n).backgroundColor;
      return {drawer:!!document.querySelector('.assistant-drawer'), toolBg:g, navBg:m, differs:g!==m};
    })()`,
    false,
  )
  check('点助手图标真的开抽屉', activeState.drawer, activeState)
  check('助手开着 ≠ 当前分区（不与导航共用实心高亮）', activeState.differs, {
    toolBg: activeState.toolBg,
    navBg: activeState.navBg,
  })
  await shotBar('bar-assistant-open-light')
  await shot('full-light')

  console.log(failures.length ? `\n\x1b[31m${failures.length} 项未通过\x1b[0m ` + failures.join(', ') : `\n\x1b[32m全部通过\x1b[0m · 截图在 ${OUT}`)
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
