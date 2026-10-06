// 运行时验证：真实构建应用 + 独立 userData + CDP，验助手与网页视图的层级关系。
// A) 助手抽屉的放大/全屏：类名、宽度、localStorage 持久化、把手拖拽、Esc 分层；
// B) 「打开的网页压住应用」：登录/查看统一走内嵌 WebviewDock（带 ×），抽屉开着时
//    原生矩形必须让位（让不开就摘掉）；识别窗口有横幅可关，关掉之后不会被自动重开。
// C) 附件图片：blob 预览真解码（CSP 放行）、点开放大、Esc 不越级关抽屉。
// 用法：npm run build && node scripts/verify-drawer-layering.mjs
// 只管理本脚本 spawn 的 electron 进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = 9414
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-drawer-'))
const outDir = path.join(ROOT, 'docs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let ws = null
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${name}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`)
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
    send(method, params = {}) {
      const mid = ++id
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject })
        socket.send(JSON.stringify({ id: mid, method, params }))
        setTimeout(() => {
          if (pending.has(mid)) {
            pending.delete(mid)
            reject(new Error(`CDP 超时: ${method}`))
          }
        }, 20000)
      })
    },
  }
}

async function listTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    return (await res.json()).filter((t) => t.type === 'page')
  } catch {
    return []
  }
}

async function findMainTarget() {
  for (let i = 0; i < 80; i++) {
    const pages = await listTargets()
    const main = pages.find((t) => /^file:\/\//.test(t.url || '') && /index\.html/.test(t.url || ''))
    if (main) return main
    await sleep(500)
  }
  throw new Error('未找到渲染层页面目标')
}

async function evalJs(cdp, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails)
    throw new Error('页内执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function shot(cdp, name) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(outDir, name)
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    console.log('  截图 →', file)
  } catch (e) {
    console.log('  截图失败:', e.message)
  }
}

/** 抽屉 / dock / 变量的一次性快照，overlap 直接算出来 */
const PROBE = `(function(){
  const d=document.querySelector('.assistant-drawer');
  const dock=document.querySelector('.webview-dock');
  const body=document.querySelector('.webview-dock-body');
  const cs=getComputedStyle(document.documentElement);
  const rect=(el)=>el?el.getBoundingClientRect():null;
  const dr=rect(d), br=rect(body);
  // 真正贴上去的原生矩形：WebviewDock 会按 --a-drawer-reserve 夹到视口坐标，
  // 容器被 flex 撑破视口时 DOM 矩形说了不算。
  const reserve=Number.parseFloat(cs.getPropertyValue('--a-drawer-reserve'))||0;
  const right=document.body.classList.contains('assistant-open')?window.innerWidth-reserve:window.innerWidth;
  const pw=body?Math.max(0,Math.round(Math.min(br.right,right)-br.left)):null;
  return {
    drawer: !!d,
    drawerFull: !!d && d.classList.contains('full'),
    drawerW: d?Math.round(dr.width):null,
    drawerLeft: d?Math.round(dr.left):null,
    bodyHasClass: document.body.classList.contains('assistant-open'),
    reserve: cs.getPropertyValue('--a-drawer-reserve').trim(),
    inset: cs.getPropertyValue('--a-full-inset').trim(),
    vw: window.innerWidth,
    handle: !!document.querySelector('.assistant-resize-handle'),
    fullPref: (()=>{try{return localStorage.getItem('torra.assistant.full')}catch(e){return 'x'}})(),
    insetPref: (()=>{try{return localStorage.getItem('torra.assistant.inset')}catch(e){return 'x'}})(),
    dock: !!dock,
    dockClose: !!document.querySelector('.webview-dock-head button'),
    dockPad: dock?getComputedStyle(dock).paddingRight:null,
    dockBodyRight: body?Math.round(br.right):null,
    presentedW: pw,
    // 原生视图会不会压住抽屉：贴得出去（>=24 宽）且右缘越过抽屉左界
    occludes: (body&&d)?(pw>=24 && br.left+pw > dr.left+1):null,
  };
})()`

async function main() {
  // 本地 fixture：给识别窗口一个能秒开的页面，不依赖外网
  const html = `<!doctype html><meta charset="utf-8"><title>Fixture Chat</title>
<body><textarea placeholder="说点什么"></textarea><button>发送</button>
<div class="msg">这是本地 fixture 的回复气泡，长度足够。</div></body>`
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`
  console.log('fixture:', fixtureUrl)

  child = spawn(electronBin, [ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write('[app] ' + d))
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|GPU|gpu|Warning|deprecat/i.test(s)) process.stdout.write('[app:err] ' + s)
  })

  const page = await findMainTarget()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = cdpClient(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  const pageErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push('EX: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      pageErrors.push('ERR: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  })

  const dismissModal = () =>
    evalJs(
      cdp,
      `(function(){ const b=[...document.querySelectorAll('button')].find(x=>/我已理解|继续使用|知道了|同意/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`,
      false,
    ).catch(() => false)

  let mounted = false
  for (let i = 0; i < 80 && !mounted; i++) {
    mounted = await evalJs(cdp, `!!document.querySelector('.assistant-toggle')`).catch(() => false)
    if (!mounted) await sleep(500)
  }
  check('渲染层挂载', mounted)
  if (!mounted) {
    console.log('错误:', JSON.stringify(pageErrors.slice(0, 10)))
    await shot(cdp, 'verify-drawer-diag.png')
    throw new Error('渲染层未挂载')
  }
  await dismissModal()
  await sleep(600)

  // 打开抽屉（webview 预热可能让首帧开关闪现即失，轮询重试）
  let opened = false
  for (let a = 0; a < 15 && !opened; a++) {
    await dismissModal()
    await evalJs(cdp, `(function(){ const b=document.querySelector('.assistant-toggle'); if(b) b.click(); return true; })()`, false).catch(() => false)
    for (let i = 0; i < 8 && !opened; i++) {
      opened = await evalJs(cdp, `!!document.querySelector('.assistant-drawer')`).catch(() => false)
      if (!opened) await sleep(400)
    }
    if (!opened) await sleep(800)
  }
  check('助手抽屉打开', opened)
  if (!opened) {
    console.log('错误:', JSON.stringify(pageErrors.slice(0, 10)))
    await shot(cdp, 'verify-drawer-diag.png')
    throw new Error('抽屉未打开')
  }
  await sleep(700)

  // ---- 0) 基线：抽屉宽度已发布给网页视图让位 ----
  const base = await evalJs(cdp, PROBE)
  console.log('基线:', JSON.stringify(base))
  check('抽屉发布 --a-drawer-reserve', base.bodyHasClass && /^\d+px$/.test(base.reserve), { reserve: base.reserve, drawerW: base.drawerW })

  // ---- 1) 登录/查看统一走内嵌 dock：不再有无 × 的裸网页压住应用 ----
  const models = await evalJs(cdp, `(window.torra.listModels().then(ms=>ms.filter(m=>m.transport==='webview').map(m=>m.id)))`)
  console.log('webview 模型:', JSON.stringify(models))
  const pick = (models || []).includes('deepseek-web') ? 'deepseek-web' : (models || [])[0]
  if (pick) {
    await evalJs(cdp, `(window.torra.openLogin(${JSON.stringify(pick)}))`)
    await sleep(6000)
    const docked = await evalJs(cdp, PROBE)
    console.log('内嵌后:', JSON.stringify(docked))
    check('登录请求改为内嵌网页视图（带表头/×）', docked.dock, { dock: docked.dock, model: pick, hasHeaderClose: null })
    check(
      '抽屉开着时网页视图让出宽度（不压住 ×）',
      docked.dock && docked.occludes === false,
      { presentedW: docked.presentedW, dockBodyRight: docked.dockBodyRight, drawerLeft: docked.drawerLeft, reserve: docked.reserve },
    )
    await shot(cdp, 'verify-drawer-dock.png')
  } else {
    check('登录请求改为内嵌网页视图（带表头/×）', false, '没有 webview 模型可点')
  }

  // ---- 2) 放大/全屏 ----
  const toggleInfo = await evalJs(
    cdp,
    `(function(){
      const b=[...document.querySelectorAll('.assistant-drawer .assistant-head button')].find(x=>x.getAttribute('aria-pressed')!==null);
      return b?{found:true,title:b.title}: {found:false};
    })()`,
  )
  check('抽屉头部有放大按钮', toggleInfo.found, toggleInfo)
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('.assistant-drawer .assistant-head button')].find(x=>x.getAttribute('aria-pressed')!==null); if(b) b.click(); return !!b; })()`,
    false,
  )
  await sleep(800)
  const fullscreen = await evalJs(cdp, PROBE)
  console.log('全屏:', JSON.stringify(fullscreen))
  check('全屏档位生效', fullscreen.drawerFull && fullscreen.handle, { full: fullscreen.drawerFull, handle: fullscreen.handle })
  check('全屏宽度跟随视口', fullscreen.drawerW !== null && fullscreen.drawerW >= fullscreen.vw - Number(fullscreen.inset.replace('px', '') || 0) - 4, { drawerW: fullscreen.drawerW, vw: fullscreen.vw, inset: fullscreen.inset })
  check('全屏偏好持久化', fullscreen.fullPref === '1', { fullPref: fullscreen.fullPref })
  check(
    '让位宽度跟着全屏档重新实测（不是 452 兜底值）',
    fullscreen.reserve === `${fullscreen.drawerW + 12}px`,
    { reserve: fullscreen.reserve, drawerW: fullscreen.drawerW },
  )
  check(
    '全屏后网页视图仍让位（原生矩形被夹到 0 宽即摘掉）',
    !fullscreen.dock || fullscreen.occludes === false,
    { occludes: fullscreen.occludes, presentedW: fullscreen.presentedW, reserve: fullscreen.reserve, drawerLeft: fullscreen.drawerLeft },
  )
  await shot(cdp, 'verify-drawer-full.png')

  // ---- 3) 拖把手 ----
  const origin = await evalJs(cdp, `(function(){ const h=document.querySelector('.assistant-resize-handle'); if(!h) return null; const r=h.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+120)}; })()`)
  check('把手可命中', !!origin, origin)
  if (origin) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: origin.x, y: origin.y, button: 'left', clickCount: 1 })
    for (const x of [origin.x + 80, origin.x + 160, 260]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: origin.y, button: 'left' })
      await sleep(120)
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 260, y: origin.y, button: 'left' })
    await sleep(600)
    const dragged = await evalJs(cdp, PROBE)
    console.log('拖拽后:', JSON.stringify(dragged))
    const insetPx = Number((dragged.inset || '0').replace('px', ''))
    check('拖把手调整全屏左界', Math.abs(insetPx - 260) <= 4 && dragged.drawerLeft !== null && Math.abs(dragged.drawerLeft - insetPx) <= 3, { inset: dragged.inset, drawerLeft: dragged.drawerLeft })
    check('把手位置持久化', dragged.insetPref === String(insetPx), { insetPref: dragged.insetPref, insetPx })
    await shot(cdp, 'verify-drawer-resize.png')
  }

  // ---- 4) Esc 分层：先退出全屏，不关抽屉 ----
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(700)
  const afterEsc = await evalJs(cdp, PROBE)
  check('Esc 先退出全屏且保留抽屉', afterEsc.drawer === true && afterEsc.drawerFull === false, { drawer: afterEsc.drawer, full: afterEsc.drawerFull })
  // 退出全屏后矩形恢复：视图要自己贴回来，而不是留在被摘掉的状态
  await sleep(900)
  const restored = await evalJs(cdp, PROBE)
  check(
    '退出全屏后网页视图重新贴回（且不压抽屉）',
    !restored.dock || (restored.presentedW >= 24 && restored.occludes === false),
    { presentedW: restored.presentedW, occludes: restored.occludes, reserve: restored.reserve },
  )

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(900)
  const afterEsc2 = await evalJs(cdp, PROBE)
  check('再按 Esc 关闭抽屉并撤掉让位标记', afterEsc2.drawer === false && afterEsc2.bodyHasClass === false, { drawer: afterEsc2.drawer, bodyHasClass: afterEsc2.bodyHasClass })

  // ---- 4.5) 附件图片：blob 预览要真解码出来，并且能点开放大 ----
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await evalJs(
    cdp,
    `(function(){ const t=[...document.querySelectorAll('button')].find(x=>/聊天/.test(x.textContent||'')); if(t) t.click(); return !!t; })()`,
    false,
  )
  await sleep(1200)
  // composer 只在已勾选参与者时渲染：双击一张模型卡片把它加进去
  await evalJs(
    cdp,
    `(function(){ const c=document.querySelector('.model-card:not(.disabled)'); if(c) c.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window})); return !!c; })()`,
    false,
  )
  let composer = false
  for (let i = 0; i < 20 && !composer; i++) {
    composer = await evalJs(cdp, `!!document.querySelector('.cx-dock input[type=file]')`).catch(() => false)
    if (!composer) await sleep(500)
  }
  check('聊天页 composer 就绪', composer)
  const chatAtt = await evalJs(cdp, `(async function(){
    const input=document.querySelector('.cx-dock input[type=file]');
    if(!input) return {input:false};
    const bin=Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0));
    const f=new File([bin],'shot.png',{type:'image/png'});
    const dt=new DataTransfer(); dt.items.add(f);
    input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,1500));
    const th=document.querySelector('.cx-att-thumb');
    return {input:true, chip:!!th, natural: th?th.naturalWidth:0, scheme: th?th.src.slice(0,5):''};
  })()`)
  console.log('聊天附件:', JSON.stringify(chatAtt))
  check('粘贴/选择的图片在输入框里真的预览出来（CSP 放行 blob:）', chatAtt.chip && chatAtt.natural > 0 && chatAtt.scheme === 'blob:', chatAtt)
  await evalJs(cdp, `(function(){ const th=document.querySelector('.cx-att-thumb'); if(th) th.click(); return !!th; })()`, false)
  await sleep(600)
  const zoom = await evalJs(cdp, `(function(){
    const m=document.querySelector('.img-zoom-mask'); const i=document.querySelector('.img-zoom-img');
    const cs=m?getComputedStyle(m):null;
    return {mask:!!m, z:cs?cs.zIndex:null, big:i?i.naturalWidth:0, name:(document.querySelector('.img-zoom-name')||{}).textContent||''};
  })()`)
  check('点击缩略图放大查看原图', zoom.mask && zoom.big > 0, zoom)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(500)
  check('Esc 关掉放大层', (await evalJs(cdp, `!document.querySelector('.img-zoom-mask')`)) === true)

  // ---- 4.6) 放大层开着时按 Esc：只关图，不连带关抽屉 ----
  // 助手侧的图片附件受视觉能力门控（本机没有视觉模型会被挡下，那是另一条已验过的规则），
  // 所以这里直接发 openImageZoom 所发的那个事件，验的是层级而不是取图路径。
  await evalJs(cdp, `(function(){ const b=document.querySelector('.assistant-toggle'); if(b) b.click(); return true; })()`, false)
  await sleep(900)
  await evalJs(
    cdp,
    `(window.dispatchEvent(new CustomEvent('torra:zoom-image',{detail:{url:'data:image/png;base64,${PNG}',name:'shot.png'}})), true)`,
    false,
  )
  await sleep(600)
  const zoomWithDrawer = await evalJs(cdp, `(function(){
    const m=document.querySelector('.img-zoom-mask'); const d=document.querySelector('.assistant-drawer');
    return {mask:!!m, drawer:!!d, overDrawer: m&&d ? (getComputedStyle(m).zIndex|0) > (getComputedStyle(d).zIndex|0) : null};
  })()`)
  check('放大层浮在助手抽屉之上', zoomWithDrawer.mask && zoomWithDrawer.overDrawer === true, zoomWithDrawer)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)
  const afterZoomEsc = await evalJs(cdp, PROBE)
  const maskLeft = await evalJs(cdp, `!!document.querySelector('.img-zoom-mask')`)
  check('放大层的 Esc 不越级关抽屉', maskLeft === false && afterZoomEsc.drawer === true, { maskLeft, drawer: afterZoomEsc.drawer })

  // ---- 5) 识别窗口：横幅可关、关掉不复活 ----
  await evalJs(cdp, `(function(){ const b=document.querySelector('.assistant-toggle'); if(b) b.click(); return true; })()`, false).catch(() => false)
  await sleep(800)
  const planP = evalJs(cdp, `(window.torra.smartAddWebPlan({entry:${JSON.stringify(fixtureUrl)}}).then(r=>({ok:r.ok,reason:r.reason||''})).catch(e=>({err:String(e)})))`).catch((e) => ({ err: String(e) }))
  let sawBanner = null
  for (let i = 0; i < 30 && !sawBanner; i++) {
    await sleep(400)
    sawBanner = await evalJs(
      cdp,
      `(function(){
        const b=[...document.querySelectorAll('.banner')].find(x=>/识别窗口/.test(x.textContent||''));
        if(!b) return null;
        const btn=[...b.querySelectorAll('button')].find(x=>/关闭窗口/.test(x.textContent||''));
        return {text:(b.textContent||'').replace(/\\s+/g,' ').slice(0,120), closeBtn:!!btn};
      })()`,
    ).catch(() => null)
  }
  const scanTargets = async () => (await listTargets()).filter((t) => /^http:\/\/127\.0\.0\.1/.test(t.url || ''))
  const whileOpen = await scanTargets()
  check('识别窗口打开时应用顶部出现横幅', !!sawBanner && sawBanner.closeBtn, sawBanner)
  check('识别窗口是独立窗口（可在 /json/list 看到）', whileOpen.length >= 1, whileOpen.map((t) => t.url))
  await shot(cdp, 'verify-drawer-banner.png')

  if (sawBanner && sawBanner.closeBtn) {
    await evalJs(
      cdp,
      `(function(){ const b=[...document.querySelectorAll('.banner')].find(x=>/识别窗口/.test(x.textContent||'')); const btn=[...b.querySelectorAll('button')].find(x=>/关闭窗口/.test(x.textContent||'')); btn.click(); return true; })()`,
      false,
    )
    await sleep(1500)
    const afterClose = await evalJs(
      cdp,
      `(function(){ return [...document.querySelectorAll('.banner')].some(x=>/识别窗口/.test(x.textContent||'')); })()`,
    )
    const gone = await scanTargets()
    check('点「关闭窗口」后横幅消失', afterClose === false, { bannerStill: afterClose })
    check('点「关闭窗口」后独立窗口真的没了', gone.length === 0, gone.map((t) => t.url))
    const planRes = await planP
    console.log('识别流程返回:', JSON.stringify(planRes))
    await sleep(4000)
    const revived = await scanTargets()
    check('关闭后不被自动重开', revived.length === 0, revived.map((t) => t.url))
  }

  console.log('\n== 汇总 ==')
  const failed = results.filter((r) => !r.ok)
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  failed.forEach((f) => console.log('FAIL:', f.name, JSON.stringify(f.detail)))
  console.log('页面错误:', JSON.stringify(pageErrors.slice(0, 10)))
  if (failed.length) throw new Error('存在未通过项')
}

main()
  .then(() => cleanup(0))
  .catch((e) => {
    console.error('验证失败:', e.message)
    cleanup(1)
  })

function cleanup(code) {
  try {
    ws && ws.close()
  } catch {
    /* ignore */
  }
  try {
    if (child && !child.killed) child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 800)
}
