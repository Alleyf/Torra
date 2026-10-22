// 运行时验证原生墙的切分树：真实 DOM 里量格子的矩形、拖一条缝、确认只有那两格在变。
// 用 Node 24 自带 fetch/WebSocket，无需额外依赖。只管理本脚本 spawn 的 electron 进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = 9413
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-wall-'))
const outDir = path.join(ROOT, 'docs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let ws = null

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
    send(method, params = {}) {
      const mid = ++id
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject })
        socket.send(JSON.stringify({ id: mid, method, params }))
      })
    },
  }
}

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && /index\.html|file:\/\//.test(t.url || ''))
      if (page) return page
    } catch {
      /* 尚未就绪 */
    }
    await sleep(500)
  }
  throw new Error('未找到渲染层页面目标')
}

async function evalJs(cdp, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) {
    throw new Error('页内执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(outDir, name)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  截图 →', file)
}

async function mouseDrag(cdp, from, to, steps = 6) {
  const base = { button: 'left', buttons: 1, clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, ...base })
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps
    const y = from.y + ((to.y - from.y) * i) / steps
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, ...base })
    await sleep(30)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, ...base, buttons: 0 })
}

async function main() {
  child = spawn(electronBin, [ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write('[app] ' + d))
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|GPU|gpu|Warning|deprecat/i.test(s)) process.stdout.write('[app:err] ' + s)
  })

  console.log('等待 CDP 目标…')
  const page = await findPageTarget()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = cdpClient(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(6000)

  // 关掉首次运行弹窗，进 Chat 页
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('button')].find(x=>/我已理解|继续使用|知道了|同意/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`,
    false,
  )
  await sleep(600)
  await evalJs(cdp, `(function(){ const b=[...document.querySelectorAll('button')].find(x=>/聊天/.test(x.textContent||'')); if(b) b.click(); return true; })()`, false)
  await sleep(1200)

  // 把几个模型加进参与者，墙才有好几格可拖
  const added = await evalJs(
    cdp,
    `(async function(){
      const cards=[...document.querySelectorAll('.model-card:not(.disabled)')].slice(0,3);
      for(const c of cards){ c.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window})); await new Promise(r=>setTimeout(r,400)); }
      return cards.length;
    })()`,
  )
  console.log('加入参与者:', added)
  await sleep(2500)

  const before = await evalJs(
    cdp,
    `(function(){
      const wall=document.querySelector('.cx-wall');
      if(!wall) return { ok:false, why:'没有 .cx-wall' };
      const wr=wall.getBoundingClientRect();
      const cells=[...document.querySelectorAll('[data-wall-index]')].map(el=>{
        const r=el.getBoundingClientRect();
        return { i:el.getAttribute('data-wall-index'), x:Math.round(r.x-wr.x), y:Math.round(r.y-wr.y), w:Math.round(r.width), h:Math.round(r.height) };
      });
      const seams=[...document.querySelectorAll('.cx-wall-seam')].map(el=>{
        const r=el.getBoundingClientRect();
        return { cls:el.className, x:Math.round(r.x-wr.x), y:Math.round(r.y-wr.y), w:Math.round(r.width), h:Math.round(r.height) };
      });
      const cs=getComputedStyle(wall);
      return { ok:true, wall:{w:Math.round(wr.width),h:Math.round(wr.height), pos:cs.position, display:cs.display}, cells, seams };
    })()`,
  )
  console.log('墙几何:', JSON.stringify(before, null, 1))
  await shot(cdp, 'verify-wall-before.png')

  if (!before.ok || before.cells.length < 2) {
    console.log('墙上的格数不足，跳过拖动验证')
    return
  }

  // 拖第一条竖缝：只允许它两侧那两格变，其余格必须一像素不动
  const dragged = await evalJs(
    cdp,
    `(async function(){
      const wall=document.querySelector('.cx-wall');
      const wr=wall.getBoundingClientRect();
      const seam=document.querySelector('.cx-wall-seam.seam-col');
      if(!seam) return { ok:false, why:'没有竖缝' };
      const sr=seam.getBoundingClientRect();
      const snap=()=>[...document.querySelectorAll('[data-wall-index]')].map(el=>{
        const r=el.getBoundingClientRect();
        return { i:el.getAttribute('data-wall-index'), w:Math.round(r.width), h:Math.round(r.height) };
      });
      const a=snap();
      const cx=sr.x+sr.width/2, cy=sr.y+sr.height/2;
      const opts={bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',button:0,buttons:1,clientX:cx,clientY:cy};
      seam.dispatchEvent(new PointerEvent('pointerdown',opts));
      await new Promise(r=>setTimeout(r,120));
      seam.dispatchEvent(new PointerEvent('pointermove',{...opts,clientX:cx+120,clientY:cy}));
      await new Promise(r=>setTimeout(r,300));
      const mid=snap();
      seam.dispatchEvent(new PointerEvent('pointerup',{...opts,clientX:cx+120,clientY:cy,buttons:0}));
      await new Promise(r=>setTimeout(r,600));
      const b=snap();
      return { ok:true, a, mid, b, seamRect:{x:Math.round(sr.x-wr.x),y:Math.round(sr.y-wr.y),w:Math.round(sr.width),h:Math.round(sr.height)} };
    })()`,
  )
  console.log('拖缝结果:', JSON.stringify(dragged, null, 1))
  await shot(cdp, 'verify-wall-after.png')

  // ── 上下方向也要独立：拖一条横缝，只有它上下那两格变 ──
  // 用 CDP 的真实鼠标事件（合成 PointerEvent 不带 capture 手势，实测拖不动横缝）
  const rowInfo = await evalJs(
    cdp,
    `(function(){
      const wall=document.querySelector('.cx-wall');
      const wr=wall.getBoundingClientRect();
      const seam=document.querySelector('.cx-wall-seam.seam-row');
      if(!seam) return { ok:false, why:'没有横缝' };
      const sr=seam.getBoundingClientRect();
      const snap=()=>[...document.querySelectorAll('[data-wall-index]')].map(el=>{
        const r=el.getBoundingClientRect();
        return { i:el.getAttribute('data-wall-index'), w:Math.round(r.width), h:Math.round(r.height) };
      });
      return { ok:true, a:snap(), from:{ x:sr.x+sr.width/2, y:sr.y+sr.height/2 } };
    })()`,
  )
  if (rowInfo.ok) {
    await mouseDrag(cdp, rowInfo.from, { x: rowInfo.from.x, y: rowInfo.from.y + 90 })
    await sleep(700)
  }
  const vertical = await evalJs(
    cdp,
    `(function(){
      const cells=[...document.querySelectorAll('[data-wall-index]')].map(el=>{
        const r=el.getBoundingClientRect();
        return { i:el.getAttribute('data-wall-index'), w:Math.round(r.width), h:Math.round(r.height) };
      });
      return { ok:true, b:cells };
    })()`,
  )
  if (rowInfo.ok) vertical.a = rowInfo.a
  console.log('拖横缝结果:', JSON.stringify(vertical, null, 1))
  await shot(cdp, 'verify-wall-vertical.png')

  // ── Obsidian 式：把一格拖到另一格的标题条上 → 合成一叠标签 ──
  const foldInfo = await evalJs(
    cdp,
    `(function(){
      const cells=[...document.querySelectorAll('[data-wall-index]')];
      if(cells.length<2) return { ok:false, why:'格数不足' };
      const grip=cells[0].querySelector('.wdh-grip');
      if(!grip) return { ok:false, why:'没有拖动把手' };
      const gr=grip.getBoundingClientRect();
      const target=cells[1].getBoundingClientRect();
      const head=cells[1].querySelector('.webview-dock-head');
      const hr=head?head.getBoundingClientRect():target;
      return { ok:true,
        from:{ x:gr.x+gr.width/2, y:gr.y+gr.height/2 },
        to:{ x:hr.x+Math.min(120,hr.width/2), y:hr.y+hr.height/2 },
        cellsBefore:cells.length };
    })()`,
  )
  let folded = { ok: false, why: '夹具失败' }
  if (foldInfo.ok) {
    await mouseDrag(cdp, foldInfo.from, foldInfo.to)
    await sleep(800)
    folded = await evalJs(
      cdp,
      `(function(){
        const tabs=[...document.querySelectorAll('.wdh-foldtab')].map(el=>el.textContent.trim());
        const cellsAfter=[...document.querySelectorAll('[data-wall-index]')];
        const names=[...document.querySelectorAll('[data-wall-index] .wdh-id b')].map(el=>el.textContent.trim());
        return { ok:true, tabs, cellsAfter:cellsAfter.length, names };
      })()`,
    )
    folded.cellsBefore = foldInfo.cellsBefore
  }
  console.log('折叠结果:', JSON.stringify(folded, null, 1))
  await shot(cdp, 'verify-wall-folded.png')

  // ── 折叠出来的那一叠：点标签切页、拖标签拆出去 ──
  const tabOps = await evalJs(
    cdp,
    `(async function(){
      const tab=document.querySelector('.wdh-foldtab');
      if(!tab) return { ok:false, why:'没有折叠标签' };
      const nameBefore=document.querySelector('[data-wall-index] .wdh-id b')?.textContent||null;
      tab.click();
      await new Promise(r=>setTimeout(r,500));
      const nameAfter=document.querySelector('[data-wall-index] .wdh-id b')?.textContent||null;
      return { ok:true, nameBefore, nameAfter, switched:nameBefore!==nameAfter };
    })()`,
  )
  console.log('切标签结果:', JSON.stringify(tabOps, null, 1))
  await shot(cdp, 'verify-wall-tab.png')
}

main()
  .catch((e) => {
    console.error('验证失败:', e.message)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    if (child) child.kill()
    await sleep(500)
    process.exit(process.exitCode ?? 0)
  })
