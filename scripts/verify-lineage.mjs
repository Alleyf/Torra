// 运行时验证：科研工作台 → 服务器看板 → 族谱
//
// 族谱这层只在真窗口里才看得见问题：卡片位置是算出来的、连线端点靠固定宽高、
// 缩放靠 transform，任何一处算错都不会报错，只会画出一张对不上的图。
// 所以这里盯的是「肉眼能判断的几何 + 交互真的改了状态」，不是截图好不好看。
//
// 有远端机器时走真实扫描（TORRA_LINEAGE_TARGET='{"host":...}'），
// 没有就跑空态：至少证明标签点得开、四个挂点都在、提示说的是人话。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'lineage')
const port = await freePort(9471)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-lineage-'))

const target = process.env.TORRA_LINEAGE_TARGET ? JSON.parse(process.env.TORRA_LINEAGE_TARGET) : null
const SERVER_ID = 'srv-lineage-check'
if (target) {
  // 面板只认插件存储里的服务器；先写一份，省掉在界面上手填一遍。
  // 插件存储挂在 <userData>/torra 下面（主进程的 dataDir 多一层 torra），不是 userData 根
  const dir = path.join(userData, 'torra', 'plugin-data', 'research')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'store.json'),
    JSON.stringify({
      'server:servers': [
        {
          id: SERVER_ID,
          label: target.label || 'gpu-master',
          host: target.host,
          port: target.port || 22,
          user: target.user || 'root',
          keyPath: target.keyPath || '',
          createdAt: Date.now(),
          last: null,
        },
      ],
      // 故意用「秒」写这个时间戳：真实踩过一次，单位一错界面就说「校验于两万天前」，
      // 还把绑定永久判成过期。插件加载时会把秒认出来乘回毫秒（main.js cleanRootBinding）
      'server:roots': { [SERVER_ID]: { root: target.root || '/workspace', at: Math.floor(Date.now() / 1000) } },
    }),
  )
}

const failures = []
const check = (name, ok, extra) => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? ` · ${JSON.stringify(extra)}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let child = null
let page = null
let panel = null

/** 一个 CDP 连接：按帧/执行上下文求值，顺便记下页面报错 */
function client(socket) {
  let id = 0
  const pending = new Map()
  const contexts = []
  const errors = []
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context)
    if (msg.method === 'Runtime.executionContextDestroyed') {
      const at = contexts.findIndex((c) => c.id === msg.params.executionContextId)
      if (at >= 0) contexts.splice(at, 1)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'exception')
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })
  const api = {
    errors,
    send(method, params = {}, timeoutMs = 30000) {
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
    async eval(expression, awaitPromise = true) {
      const r = await api.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
      if (r.exceptionDetails) {
        throw new Error('页内执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      }
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
    /** 在指定帧里求值：面板是独立文档，不能拿主窗口的上下文 */
    async evalIn(frameId, expression, awaitPromise = true) {
      const ctxId = api.contextOf(frameId)
      if (!ctxId) throw new Error('这一帧还没有执行上下文：' + frameId)
      const r = await api.send('Runtime.evaluate', { expression, contextId: ctxId, returnByValue: true, awaitPromise })
      if (r.exceptionDetails) {
        throw new Error('帧内执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      }
      return r.result.value
    },
    /** 等到某一帧里出现某个选择器 */
    async waitIn(frameId, selector, timeoutMs = 20000) {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        try {
          if (await api.evalIn(frameId, `!!document.querySelector(${JSON.stringify(selector)})`, false)) return true
        } catch {
          /* 文档还在加载 */
        }
        await sleep(300)
      }
      return false
    },
  }
  return api
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((res, rej) => {
    socket.addEventListener('open', res)
    socket.addEventListener('error', rej)
  })
  return socket
}

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
}

async function waitTarget(match, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const hit = (await targets()).find(match)
      if (hit) return hit
    } catch {
      /* 尚未就绪 */
    }
    await sleep(400)
  }
  return null
}

async function shot(name) {
  await raiseWindow()
  // fromSurface:false 走渲染进程自己的合成结果：窗口被别的窗口挡住时
  // （document.visibilityState 会是 hidden）从 surface 截会一直等不到新帧
  try {
    const r = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: false }, 45000)
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  } catch (error) {
    // 截不到图不算验证失败：几何断言用的是 DOM 尺寸，图只是给人看的
    console.log(`    · 截图 ${name} 没拿到：${error.message}`)
  }
}

/**
 * 把验证实例的窗口顶到最前。Page.bringToFront 只动标签页，动不了操作系统那层的
 * z-order：这台机器上常同时开着别的 Electron 窗口（还有一份开发实例），
 * 验证窗口被完全盖住后不再产生新帧，于是布局量出 0 高、截图一路超时，
 * 一整串 FAIL 看着像改版改坏了，其实那轮根本没看见画面。
 * require('electron') 走不通（渲染层没开 nodeIntegration）就算了，
 * 下面还有一条靠 visibilitychange 轮询的兜底。
 */
async function raiseWindow() {
  try {
    await page.send('Page.bringToFront').catch(() => {})
    await page.eval(
      `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;w.setAlwaysOnTop(true,'screen-saver');w.show();w.focus()}return 'ok'})()`,
      false,
    )
    return true
  } catch {
    return false
  }
}

/** 等到窗口真的有画面、有尺寸；等不到就明确报出来，别让 0 高的数字冒充改版失败 */
async function waitForVisible(minW = 1000, minH = 600) {
  for (let i = 0; i < 25; i++) {
    const size = await page
      .eval(`({w:window.innerWidth,h:window.innerHeight,hidden:document.visibilityState==='hidden'})`, false)
      .catch(() => null)
    if (!!size && size.w >= minW && size.h >= minH && !size.hidden) return { ok: true, size, tries: i }
    await raiseWindow()
    await sleep(400)
  }
  const size = await page
    .eval(`({w:window.innerWidth,h:window.innerHeight,hidden:document.visibilityState})`, false)
    .catch(() => null)
  return { ok: false, size, tries: 25 }
}

async function main() {
  // 某些自动化环境会把 ELECTRON_RUN_AS_NODE 带进来，那样 electron 会当纯 node 跑、窗口起不来
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(
    electronBin,
    [
      ROOT,
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${port}`,
      '--no-sandbox',
      // 验证实例常被别的窗口挡住：不加这三个开关时 Chromium 会把页面当成
      // hidden，rAF 停摆、面板量出 0 宽，截图也一直等不到新帧
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env },
  )
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|GPU|gpu|Warning|deprecat/i.test(s)) console.log('[app:err] ' + s)
  })

  const pageTarget = await waitTarget((t) => t.type === 'page' && /^file:\/\/.*index\.html/.test(t.url || ''))
  if (!pageTarget) throw new Error('未找到渲染层页面目标')
  page = client(await connect(pageTarget.webSocketDebuggerUrl))
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  // 窗口被别的窗口完全挡住时 Chromium 会把页面标成 hidden：rAF 停摆，
  // 面板外壳按 rAF 量尺寸的 iframe 会一直是 0 宽，截图也等不到新帧。
  // 验证期间把它提到前台（只影响这一次临时实例）
  await page.send('Page.bringToFront').catch(() => {})
  // bringToFront 治不了「窗口被别的窗口盖住 / 被最小化」：那时布局直接是 0 高，
  // 整轮量到的全是 0，报错看起来像改版的问题，其实是这一轮没看见画面。
  // 窗口尺寸这里没法固定（Browser.* 在页面级会话上没有），所以几何一律按比例量，
  // 别写死像素；这里只保证「真的看得见画面」再往下量。
  const seen = await waitForVisible()
  check('验证实例的窗口真的看得见（没画面时下面量到的全是 0）', seen.ok, seen.size)
  await sleep(1200)
  // 首次启动的引导弹层会挡住导航
  for (let i = 0; i < 5; i++) {
    const clicked = await page.eval(
      `(function(){const b=[...document.querySelectorAll('.modal-mask button, .start-intro-foot button')].find(x=>/我已理解|知道了|开始|跳过/.test(x.textContent||''));if(b){b.click();return true}return false})()`,
      false,
    )
    if (!clicked) break
    await sleep(400)
  }

  // ── 打开科研工作台 ──
  // 全新 userData 里内置插件是「装好但没启用」：先按界面上会走的那条路启用它
  let navLabels = []
  for (let i = 0; i < 20; i++) {
    navLabels = await page.eval(`[...document.querySelectorAll('.app-nav-item')].map((b)=>b.getAttribute('aria-label')||b.textContent||'')`, false)
    if (navLabels.some((label) => label.indexOf('科研') >= 0)) break
    await sleep(300)
  }
  if (!navLabels.some((label) => label.indexOf('科研') >= 0)) {
    await page.eval(`window.torra.pluginsSetEnabled('research', true)`, false).catch(() => {})
    // 导航是监听 torra:plugins-changed 才重取的；这一步正是设置页启停后会走的通知
    await page.eval(`window.dispatchEvent(new Event('torra:plugins-changed'))`, false).catch(() => {})
    for (let i = 0; i < 40; i++) {
      navLabels = await page.eval(`[...document.querySelectorAll('.app-nav-item')].map((b)=>b.getAttribute('aria-label')||b.textContent||'')`, false)
      if (navLabels.some((label) => label.indexOf('科研') >= 0)) break
      await sleep(400)
    }
  }
  const opened = await page.eval(
    `(function(){const b=[...document.querySelectorAll('.app-nav-item')].find((x)=>/科研/.test(x.getAttribute('aria-label')||x.textContent||''));if(!b)return 'no-nav';b.click();return 'ok'})()`,
    false,
  )
  check('标题栏里有科研工作台入口', opened === 'ok', { opened, navLabels })

  // 入口在导航里出现 ≠ 插件进程已经能接 RPC。进程没起来时面板外壳会停在
  // 「插件进程没起来，面板拿不到数据」，之后再怎么点都不会自己重试，所以先等 ready
  let status = ''
  for (let i = 0; i < 40; i += 1) {
    status = await page
      .eval(
        `window.torra.pluginsList().then((r)=>((r&&r.plugins)||[]).map((p)=>p.id+':'+p.status).join(','))`,
        true,
      )
      .catch(() => '')
    if (/\bresearch:ready\b/.test(status)) break
    await sleep(500)
  }
  check('科研工作台进程就绪', /\bresearch:ready\b/.test(status), { status })

  // 刚才那次点击可能落在外壳的报错态上：先离开再回来，让面板按就绪状态重新挂载
  await page
    .eval(
      `(function(){const items=[...document.querySelectorAll('.app-nav-item')];const other=items.find((x)=>!/科研/.test(x.getAttribute('aria-label')||x.textContent||''));if(other)other.click();return !!other})()`,
      false,
    )
    .catch(() => {})
  await sleep(600)
  await page
    .eval(
      `(function(){const b=[...document.querySelectorAll('.app-nav-item')].find((x)=>/科研/.test(x.getAttribute('aria-label')||x.textContent||''));if(b)b.click()})()`,
      false,
    )
    .catch(() => {})

  // 面板是独立进程的帧：它自己有调试目标。
  // 这一步曾经踩过坑：点击是生效的，但 OOPIF 目标出现要等一次导航提交，
  // 所以每隔几秒把导航再点一次，避免「点了但 React 没进入该 section」的时序问题。
  let panelTarget = null
  for (let i = 0; i < 6 && !panelTarget; i += 1) {
    panelTarget = await waitTarget((t) => t.type === 'iframe' && /^torra-ui:\/\/frame\//.test(t.url || ''), 4000)
    if (!panelTarget) {
      const seen = await targets()
        .then((list) => list.map((t) => `${t.type}:${String(t.url || '').slice(0, 24)}`))
        .catch(() => ['/json/list 不可用'])
      const ui = await page
        .eval(
          `(function(){const s=document.querySelector('.plugin-state');const f=document.querySelector('iframe.plugin-frame');return {state:s?s.textContent:null,frame:!!f,nav:[...document.querySelectorAll('.app-nav-item.on,.app-nav-item[aria-current="page"]')].map((b)=>b.textContent)}})()`,
          false,
        )
        .catch(() => null)
      console.log(`    · 第 ${i + 1} 次没等到面板帧，当前目标：` + JSON.stringify(seen) + ' · 界面：' + JSON.stringify(ui))
      // 先离开再回来：同一条目重复点击是空操作，面板不会重新挂载
      await page
        .eval(
          `(function(){const items=[...document.querySelectorAll('.app-nav-item')];const other=items.find((x)=>!/科研/.test(x.getAttribute('aria-label')||x.textContent||''));if(other)other.click();return !!other})()`,
          false,
        )
        .catch(() => {})
      await sleep(500)
      await page.eval(
        `(function(){const b=[...document.querySelectorAll('.app-nav-item')].find((x)=>/科研/.test(x.getAttribute('aria-label')||x.textContent||''));if(b)b.click()})()`,
        false,
      ).catch(() => {})
    }
  }
  check('科研工作台面板帧加载出来', !!panelTarget)
  if (!panelTarget) return
  panel = client(await connect(panelTarget.webSocketDebuggerUrl))
  await panel.send('Runtime.enable')
  await panel.send('Page.enable')

  // 模块界面在外壳再往下的一层 srcdoc 帧里。
  // 外壳默认停在「概览」，三个模块各有一个空帧；先点侧栏的「实验机器」，
  // 服务器看板才会被拉起来，否则所有帧都是空的。
  const moduleEntered = await panel.eval(
    `(function(){
      const nodes=[...document.querySelectorAll('button,a,[role="button"],[role="tab"]')];
      const hit=nodes.find((n)=>(n.textContent||'').trim()==='实验机器');
      if(!hit)return 'no';
      hit.click();
      return 'ok'
    })()`,
    false,
  )
  check('外壳侧栏能进「实验机器」', moduleEntered === 'ok', { moduleEntered })

  let moduleFrame = null
  const until = Date.now() + 25000
  while (Date.now() < until && !moduleFrame) {
    for (const frame of await panel.frames()) {
      if (await panel.waitIn(frame.id, '#tab-lineage', 800).catch(() => false)) {
        moduleFrame = frame
        break
      }
    }
    if (!moduleFrame) await sleep(500)
  }
  check('服务器看板的标签里有「族谱」', !!moduleFrame)
  if (!moduleFrame) {
    // 面板外壳是 torra-ui://frame，模块界面是它里面再套一层的 srcdoc 帧；
    // 找不到时把帧树和报错打出来，比只报一句 FAIL 有用
    const tree = await panel.frames().catch(() => [])
    console.log('    · 面板帧：' + JSON.stringify(tree.map((f) => `${f.id}:${String(f.url || '').slice(0, 48)}`)))
    console.log('    · 面板报错：' + JSON.stringify(panel.errors.slice(0, 3)))
    return
  }
  const frameId = moduleFrame.id

  // ── 观测页：每条实验得说清它在几张卡上跑 ──
  // 这一层只有真机上验得动：卡号一半来自驱动的显存表、一半来自进程自己的声明，
  // 而容器里驱动报的是宿主机 PID（跟本容器对不上），夹具编不出这种局面。
  // 观测页是模块的默认页，主机采样靠这一页的轮询 —— 所以这段放在切走之前。
  if (target) {
    await panel.waitIn(frameId, '[data-exp-row]', 60000)
    const obs = await panel.evalIn(
      frameId,
      `(function(){
        const rows=[...document.querySelectorAll('[data-exp-row]')];
        const txt=(n)=>((n||{}).textContent||'').trim();
        const plain=document.querySelector('[data-exp-row] .exp-tags .tag:not(.gpu)');
        return {
          hidden:document.hidden,
          tabOn:txt(document.querySelector('#exp-count')),
          note:(document.querySelector('#obs-note')||{}).textContent||'',
          server:(document.querySelector('#obs-server')||{}).value||'',
          // 同排普通标签的字号：卡号要压过它，得比它大一档
          tagNpx:plain?getComputedStyle(plain).fontSize:'',
          body:txt(document.querySelector('#obs-experiments')).slice(0,80),
          chips:rows.map((r)=>{
            const chip=r.querySelector('.tag.gpu');
            const cs=chip?getComputedStyle(chip):null;
            return {
              name:txt(r.querySelector('.exp-name')).slice(0,34),
              chip:txt(chip),
              // 图标是这一格的一半意思：显卡 = 驱动实测，引号 = 进程自己说的
              icon:chip&&chip.querySelector('svg.ico')?(chip.querySelector('svg.ico').getAttribute('class')||''):'',
              // 「显眼」是可以量的：实心填色 + 加粗 + 比同排标签大一档的字号。
              // 从前这条只查了文字，色和气都被漏掉，于是标签退回成普通灰片也没人发现
              bg:cs?cs.backgroundColor:'',
              bold:cs?cs.fontWeight:'',
              color:cs?cs.color:'',
              npx:cs?cs.fontSize:'',
              tip:(chip||{}).title?String(chip.title).slice(0,80):'',
              // 排在标签行最前面：扫这一行先看见卡号，而不是混在一排注解里
              // （「绑定目录外」这种异常标签本来就该在最前，卡号排在它后面也算对）
              first:!!chip&&chip.parentNode.querySelector('.tag')===chip,
              out:!!r.querySelector('.exp-tags .tag.out')
            }
          }),
          // 真机上这台机器全是「声明」那一种，实测那种新上机才会出现 ——
          // 造两个同款标签量填色，确认「量过的」压过「自己说的」，不能退化成同一种灰
          variants:(function(){
            const box=document.createElement('div');
            box.style.cssText='position:absolute;left:-9999px;top:-9999px';
            document.body.appendChild(box);
            const mk=(cls)=>{
              const s=document.createElement('span');
              s.className='tag gpu '+cls;
              s.innerHTML='<svg class="ico" viewBox="0 0 24 24" fill="none"></svg>GPU <b>0</b>';
              box.appendChild(s);
              return s;
            };
            const m=mk('is-meas'), d=mk('is-say');
            // 用 lastIndexOf 取 alpha：正则里的 \/ 会被模板串吃成 //，后半行直接变注释
            const alpha=(n)=>{const s=getComputedStyle(n).backgroundColor;const i=s.lastIndexOf('/');return i<0?-1:parseFloat(s.slice(i+1))};
            const out={
              meas:alpha(m), say:alpha(d),
              mBold:getComputedStyle(m).fontWeight,
              dBold:getComputedStyle(d).fontWeight,
              mFont:getComputedStyle(m.querySelector('b')).fontSize,
              dFont:getComputedStyle(d.querySelector('b')).fontSize
            };
            box.remove();
            return out;
          })()
        }
      })()`,
      false,
    )
    console.log('    · 观测页快照：' + JSON.stringify(obs))
    check('观测页在真机上列出在跑的实验', obs.chips.length > 0, { rows: obs.chips.length, body: obs.body, server: obs.server })
    check(
      '绑定时间戳写成秒也不会说出「两万天前」',
      /校验于 (刚刚|\d+ 分钟内|\d+ 小时前)/.test(obs.note) && !/天前/.test(obs.note),
      { note: obs.note.slice(0, 70) },
    )
    check(
      '卡号标签只写「GPU 数字」或「未占卡」，不夹半句话',
      obs.chips.every((c) => !c.chip || /^(GPU [\d·+ ]+|未占卡)$/.test(c.chip)),
      obs.chips.filter((c) => c.chip && !/^(GPU [\d·+ ]+|未占卡)$/.test(c.chip)),
    )
    check(
      '带卡号的实验至少一条，且每条都在提示里说了来路',
      obs.chips.some((c) => c.chip) && obs.chips.filter((c) => /^GPU/.test(c.chip)).every((c) => /实测|声明/.test(c.tip)),
      obs.chips.filter((c) => /^GPU/.test(c.chip)).slice(0, 3),
    )
    // 「显眼」不是形容词，是三个可量的东西：实心填色（不是灰片）、加粗、字号比同排大一档。
    // 从前这一格没有自己的样式，和「脚本」「长跑」长得一模一样，所以没人注意到它
    const cardChips = obs.chips.filter((c) => /^GPU/.test(c.chip))
    check(
      '占卡的那几行，卡号是实心的、加粗的、比同排标签大一档',
      cardChips.length > 0 &&
        cardChips.every(
          (c) =>
            !/rgba\(0, 0, 0, 0\)|transparent/.test(c.bg) &&
            Number(c.bold) >= 600 &&
            parseFloat(c.npx) > parseFloat(obs.tagNpx || '0'),
        ),
      { tagNpx: obs.tagNpx, chips: cardChips.map((c) => ({ chip: c.chip, bg: c.bg, bold: c.bold, npx: c.npx })) },
    )
    check(
      '卡号那一格带得出来一张卡或一个引号 —— 图标自己就是「谁说的」',
      cardChips.every((c) => /ico/.test(c.icon)),
      cardChips.map((c) => ({ chip: c.chip, icon: c.icon })),
    )
    check(
      '卡号标签排在这一行标签的最前面，扫过去先看见它',
      cardChips.length > 0 && cardChips.every((c) => c.first || c.out),
      { rows: obs.chips.length, first: cardChips.filter((c) => c.first).length },
    )
    // 「量过的」和「自己说的」得看得出差别：填色实测更实，两个都实心，但深的那份是量的
    check(
      '实测与声明的标签分得开：实测填色更实，字都加粗且比同排大一档',
      obs.variants.meas > obs.variants.say &&
        obs.variants.say > 0 &&
        Number(obs.variants.mBold) >= 600 &&
        Number(obs.variants.dBold) >= 600 &&
        parseFloat(obs.variants.mFont) > parseFloat(obs.tagNpx || '0'),
      { ...obs.variants, tagNpx: obs.tagNpx },
    )
    const obsRow = await panel.evalIn(
      frameId,
      `(async function(){
        const row=document.querySelector('[data-exp-row]');
        if(!row)return null;
        row.click();
        await new Promise((r)=>setTimeout(r,700));
        const cells=[...document.querySelectorAll('.meta-cell')].map((c)=>({
          k:((c.querySelector('.k')||{}).textContent||'').trim(),
          v:((c.querySelector('.v')||{}).textContent||'').trim(),
          cls:(c.querySelector('.v')||{}).className||'',
          icon:!!c.querySelector('.v svg.ico')
        }));
        const pick=(k)=>{const c=cells.find((x)=>x.k===k);return c?c.v:''};
        const pickCell=(k)=>cells.find((x)=>x.k===k)||null;
        return {picked:((row.querySelector('.exp-name')||{}).textContent||'').trim(),
          gpu:pick('GPU 卡号'), gpuClass:(pickCell('GPU 卡号')||{}).cls, gpuIcon:!!(pickCell('GPU 卡号')||{}).icon,
          mem:pick('显存'), who:[...document.querySelectorAll('.gpu-who')].map((n)=>(n.textContent||'').trim()).slice(0,3)}
      })()`,
      true,
      30000,
    )
    check('详情里「GPU 卡号」说的是实话，不是空白', !!obsRow && !!obsRow.gpu, obsRow)
    check(
      '详情那一格也挂上了图标与强调色（和行里的标签同一套话）',
      !!obsRow && !!obsRow.gpuIcon && /gpu/.test(obsRow.gpuClass),
      obsRow && { cls: obsRow.gpuClass, icon: obsRow.gpuIcon, gpu: obsRow.gpu },
    )
    console.log('    · 详情卡号：' + JSON.stringify(obsRow))
    await shot('obs-gpu')
  }


  // ── 进族谱页 ──
  await raiseWindow()
  await panel.evalIn(frameId, `document.querySelector('#tab-lineage').click()`, false)
  await sleep(400)
  const entered = await panel.evalIn(
    frameId,
    `(function(){
      const v=document.querySelector('#view-lineage');
      const g=document.querySelector('#lin-graph');
      return {hidden:v?v.classList.contains('hidden'):null,
        tab:document.querySelector('#tab-lineage').classList.contains('on'),
        hasStats:!!document.querySelector('#lin-stats'),
        // 左栏只管「这一族在哪儿」——层级树；右栏从上到下是画布、主线聚焦、这一族的详情与矩阵。
        // 分成两块量：拥挤的感觉来自左栏被塞了三层内容，所以要看清每一栏里到底有什么。
        side:(function(){
          const s=document.querySelector('.lin-side'), g=document.querySelector('#lin-graph-card');
          if(!s||!g) return null;
          const rs=s.getBoundingClientRect(), rg=g.getBoundingClientRect();
          return {w:Math.round(rs.width), left:Math.round(rs.left), graphLeft:Math.round(rg.left),
            tree:!!s.querySelector('#lin-tree'),
            // 详情与矩阵不该再挤回左栏
            trailInSide:!!s.querySelector('#lin-trail'),
            chainsInSide:!!s.querySelector('#lin-chains-card'),
            cards:s.querySelectorAll(':scope > .card').length};
        })(),
        col:(function(){
          const c=document.querySelector('.lin-col');
          if(!c) return null;
          const rc=c.getBoundingClientRect();
          const trail=document.querySelector('#lin-trail');
          const rt=trail?trail.getBoundingClientRect():null;
          return {w:Math.round(rc.width),
            graph:!!c.querySelector('#lin-graph-card'),
            chains:!!c.querySelector('#lin-chains-card'),
            trail:!!trail,
            // 三块各占多高：挤不挤不是靠猜，是看这两块是不是都还有得看
            graphH:Math.round((c.querySelector('#lin-graph-card')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height),
            trailH:rt?Math.round(rt.height):0,
            // 通栏的意思：矩阵这一条几乎占到右栏全部宽度
            trailPct:rt&&rc.width?+(rt.width/rc.width*100).toFixed(1):0};
        })(),
        vh:v?v.clientHeight:0, gh:g?g.clientHeight:0,
        pageScroll:document.documentElement.scrollHeight-window.innerHeight}
    })()`,
    false,
  )
  check('点标签能切到族谱页', !!entered && !entered.hidden && entered.tab, entered)
  // 四张统计卡搬进了画布的计数与焦点链右侧：这一页只该有一处「多少族」，
  // 不该为了四个数字再占一整行
  check('统计卡不再单独占一行（数并进了画布计数与焦点链右端）', !!entered && !entered.hasStats, entered)
  check(
    '画布吃掉这一页一半以上的高度（主角还是图，下面那块是注解）',
    !!entered && entered.vh > 320 && entered.gh / entered.vh >= 0.5,
    entered && { 画布: entered.gh, 整页: entered.vh, 占比: +(entered.gh / entered.vh).toFixed(2) },
  )
  check(
    '画布确实比详情通栏高（70/30 的分法没被反过来吃掉）',
    !!entered && !!entered.col && entered.col.graphH > entered.col.trailH && entered.col.trailH >= 130,
    entered && entered.col,
  )
  check('整页不再整体滚动：多出来的内容交给画布自己滚', !!entered && entered.pageScroll <= 4, entered && { 溢出: entered.pageScroll })
  // 左右两栏：左栏只剩一棵层级树，右栏是画布 + 主线聚焦 + 详情通栏
  check(
    '左栏在画布左侧，里面只有一张卡：族谱层级树',
    !!entered && !!entered.side && entered.side.w >= 260 && entered.side.w <= 380 &&
      entered.side.left < entered.side.graphLeft && entered.side.tree && entered.side.cards === 1,
    entered && entered.side,
  )
  check(
    '详情与矩阵从左上角搬到画布下方的通栏，不再和树抢 300px',
    !!entered && !!entered.col && entered.col.trail &&
      entered.col.trailPct >= 85 && !entered.side.trailInSide && !entered.side.chainsInSide,
    entered && { col: entered.col, side: entered.side },
  )
  check(
    '主线聚焦收进右栏画布下面（不再常驻左栏）',
    !!entered && !!entered.col && entered.col.chains && !entered.side.chainsInSide,
    entered && entered.col,
  )

  if (!target) {
    const empty = await panel.evalIn(frameId, `(document.querySelector('#lin-graph').textContent||'').slice(0,40)`, false)
    check('没绑机器时给的是「扫一次」的提示，不是空白', /扫|没|台账/.test(empty), { empty })
    await shot('lineage-empty')
    return
  }
  // ── 真实扫描 ──
  // 先手动探一次 RPC：扫描没结果时，分不清是 ssh 挂了还是回包丢在桥上
  const probe = await panel
    .evalIn(
      frameId,
      `(function(){return new Promise(function(resolve){
        var t0=Date.now()
        window.torraPlugin.call('server.history',{serverId:(document.querySelector('#lin-server')||{}).value||''})
          .then(function(r){resolve({ms:Date.now()-t0,ok:true,bytes:JSON.stringify(r).length,runs:r&&r.runs?r.runs.length:null})},
                function(e){resolve({ms:Date.now()-t0,err:String((e&&e.message)||e)})})
        setTimeout(function(){resolve({ms:Date.now()-t0,hung:true})},45000)
      })})()`,
      true,
      60000,
    )
    .catch((e) => ({ evalErr: String(e) }))
  console.log('    · 直连探针 server.history：' + JSON.stringify(probe))
  // 减负验证：观测页现在是单次合并采样；60 秒内的第二次 history 应当是毫秒级缓存命中
  const perf = await panel
    .evalIn(
      frameId,
      `(function(){return new Promise(function(resolve){
        var sid=(document.querySelector('#lin-server')||{}).value||''
        var t0=Date.now()
        window.torraPlugin.call('server.observe',{serverId:sid})
          .then(function(r){
            var t1=Date.now()
            window.torraPlugin.call('server.history',{serverId:sid}).then(function(){
              var t2=Date.now()
              window.torraPlugin.call('server.history',{serverId:sid}).then(function(r2){
                resolve({observeMs:t1-t0,observeOk:!!(r&&r.metrics&&r.metrics.cpu),exps:Array.isArray(r.experiments)?r.experiments.length:null,
                  histCachedMs:t2-t1,runs:r2&&r2.runs?r2.runs.length:null})
              },function(e){resolve({histErr:String((e&&e.message)||e)})})
            },function(e){resolve({histErr:String((e&&e.message)||e)})})
          },function(e){resolve({err:String((e&&e.message)||e)})})
        setTimeout(function(){resolve({hung:true})},45000)
      })})()`,
      true,
      60000,
    )
    .catch((e) => ({ evalErr: String(e) }))
  console.log('    · 合并采样与缓存探针：' + JSON.stringify(perf))
  await panel.evalIn(frameId, `document.querySelector('#lin-scan').click()`, false)
  // 等的是「图谱里有卡片」，不是文档里任何一处 data-lin-family：
  // 左侧族列表也带这个属性，光看它会把「列表有了、图还空着」当成扫描成功
  const ready = await panel.waitIn(frameId, '#lin-graph [data-lin-family]', 40000)
  const afterScan = await panel
    .evalIn(
      frameId,
      `(function(){return {
        nodes:document.querySelectorAll('#lin-graph [data-lin-family]').length,
        count:(document.querySelector('#lin-graph-count')||{}).textContent||'',
        hist:(document.querySelector('#hist-count')||{}).textContent||'',
        text:(document.querySelector('#lin-graph').textContent||'').trim().slice(0,90)
      }})()`,
      false,
    )
    .catch(() => null)
  console.log('    · 扫描之后：' + JSON.stringify(afterScan))
  if (!ready && process.env.TORRA_LINEAGE_EXPECT_EMPTY) {
    // 这台机器上本来就没有实验族：族谱该给空态，而不是把整本台账摊出来
    const empty = await panel.evalIn(
      frameId,
      `(function(){
        const g=document.querySelector('#lin-graph');
        const tree=(document.querySelector('#lin-tree')||{}).textContent||'';
        return {text:(g?g.textContent:'').slice(0,200), nodes:document.querySelectorAll('#lin-graph [data-lin-family]').length,
          count:(document.querySelector('#lin-graph-count')||{}).textContent||'', tree:tree.trim()}
      })()`,
      false,
    )
    check('没有实验族的机器上给的是空态，不是整本台账', empty.nodes === 0 && /还没有实验族/.test(empty.text), empty)
    check('统计口径也是空的', /0 族 · 0 次运行/.test(empty.count), empty)
    check('全程没有面板脚本报错', panel.errors.length === 0 && page.errors.length === 0, {
      errors: [...panel.errors, ...page.errors].slice(0, 3),
    })
    await shot('lineage-empty-machine')
    return
  }
  check('扫描后图谱上出现族卡片', ready)
  if (!ready) {
    const why = await panel.evalIn(
      frameId,
      `(async function(){
        const g=document.querySelector('#lin-graph'),s=document.querySelector('#lin-server');
        document.querySelector('#tab-history').click()
        await new Promise((r)=>setTimeout(r,300))
        return {graph:(g?g.textContent:'').slice(0,160),server:s?s.value:'',options:s?[...s.options].map((o)=>o.textContent):[],
          hist:(document.querySelector('#hist-list')||{}).textContent||'',toast:(document.querySelector('.toast')||{}).textContent||''}
      })()`,
      true,
    )
    console.log('    · 扫描没有结果：' + JSON.stringify(why))
    console.log('    · 面板报错：' + JSON.stringify(panel.errors.slice(0, 3)))
    return
  }
  // 扫描结束时外壳可能还在过渡，图谱容器会短暂是 0 宽；等它有尺寸再量
  for (let i = 0; i < 12; i += 1) {
    const w = await panel
      .evalIn(frameId, `(document.querySelector('#lin-graph')||{}).clientWidth||0`, false)
      .catch(() => 0)
    if (w > 300) break
    await sleep(300)
  }
  await sleep(400)

  const graph = await panel.evalIn(
    frameId,
    `(function(){
      const nodes=[...document.querySelectorAll('#lin-graph [data-lin-family], #lin-graph [data-lin-loose]')];
      const edges=[...document.querySelectorAll('#lin-graph [data-edge]')];
      const box=document.querySelector('#lin-graph');
      const rects=nodes.map((n)=>{const r=n.getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}});
      // 同一条道里两张卡不许叠在一起：叠了就是深度和行号算错了
      let overlaps=0;
      for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];
        if(a.l<b.l+b.w&&b.l<a.l+a.w&&a.t<b.t+b.h&&b.t<a.t+a.h)overlaps++}
      const lanes=document.querySelectorAll('#lin-graph .lin-band').length;
      const pct=(document.querySelector('#lin-zoom-pct').textContent||'').trim();
      const count=(document.querySelector('#lin-graph-count').textContent||'').trim();
      const ids=nodes.map((n)=>n.getAttribute('data-lin-family')||n.getAttribute('data-lin-loose')||'');
      // 未归族的运行得落在「未归族」那条道里，而不是混进别的实验线
      const looseNode=document.querySelector('#lin-graph [data-lin-loose]');
      const otherBand=document.querySelector('#lin-graph [data-lin-band="other"]');
      const looseInsideOther=!!(looseNode&&otherBand)&&looseNode.offsetTop>=otherBand.offsetTop-1&&
        looseNode.offsetTop<otherBand.offsetTop+otherBand.offsetHeight;
      const otherHead=(otherBand&&otherBand.nextElementSibling&&/lin-lane-head/.test(otherBand.nextElementSibling.className))
        ? otherBand.nextElementSibling.textContent.trim() : '';
      return {nodes:nodes.length,edges:edges.length,overlaps,lanes,pct,count,
        linNodes:document.querySelectorAll('#lin-graph .lin-node').length,
        extras:document.querySelectorAll('#lin-graph .lin-node-extra').length,
        mrFoots:[...document.querySelectorAll('#lin-graph .lin-node-foot')].filter((f)=>/^MR /.test(f.textContent.trim())).length,
        dup:ids.length-new Set(ids).size, sample:ids.slice(0,4).concat(ids.slice(-4)),
        loose:document.querySelectorAll('#lin-graph [data-lin-loose]').length,
        looseInsideOther, otherHead:otherHead.slice(0,24),
        flowOn:document.querySelectorAll('#lin-graph .lin-edge-pair.on .lin-flow').length,
        flowAnim:(function(){const f=document.querySelector('#lin-graph .lin-edge-pair.on .lin-flow');
          return f?getComputedStyle(f).animationName:''})(),
        scrollH:box.scrollHeight,clientW:box.clientWidth,
        // 链路铺开的宽度：最右一张卡的右缘（画布坐标，不受缩放影响）
        spanRight:Math.max(0,...nodes.map((n)=>n.offsetLeft+n.offsetWidth)),
        canvasRight:box.clientWidth-32,
        on:document.querySelectorAll('#lin-graph .lin-node.on').length,
        pick:(document.querySelector('#lin-trail .td-title')||{}).textContent||''}
    })()`,
    false,
  )
  check('图谱有卡片也有连线', graph.nodes > 10 && graph.edges > 0, graph)
  // 层数少、容器宽的时候要把层间距拉开：卡片尺寸不变，链路横着走满一屏，
  // 右边不再空一大片（从前最右一张卡停在画布三成宽的地方）
  check(
    '链路横着铺满画布，右边不留一大片空白',
    graph.nodes === 0 || graph.spanRight >= graph.canvasRight * 0.85,
    { 最右卡右缘: graph.spanRight, 画布宽: graph.canvasRight },
  )
  check('卡片之间没有重叠', graph.overlaps === 0, { overlaps: graph.overlaps })
  check('每一条实验线都有自己的道', graph.lanes >= 5, { lanes: graph.lanes })
  check('未归族的运行落在「未归族」道里', graph.loose === 0 || (graph.looseInsideOther && /未归族/.test(graph.otherHead)), {
    inside: graph.looseInsideOther,
    head: graph.otherHead,
  })
  // 连线要真的在流：只有选中这条线上的边有流动层，别的边压暗不动
  check('选中的来路上有数据在流', graph.flowOn > 0 && graph.flowAnim === 'linFlow', {
    flowOn: graph.flowOn,
    anim: graph.flowAnim,
  })
  check('进来就选中一族，底部有解释', graph.on === 1 && graph.pick.length > 0, { on: graph.on, pick: graph.pick })
  check('统计口径与图谱一致', /^\d+ 族 · \d+ 次运行$/.test(graph.count), { count: graph.count })
  await shot('lineage-graph')
  // 未归族的运行也画在图上（other 道），看一眼铺开后的样子
  if (graph.loose > 0) {
    await panel.evalIn(
      frameId,
      `(function(){const b=document.querySelector('#lin-graph');b.scrollTop=b.scrollHeight;return b.scrollTop})()`,
      false,
    )
    await sleep(400)
    await shot('lineage-loose')
  }

  // ── 点另一张卡：只改类名，滚动位置不能跳 ──
  // 特意挑一条连线指向的族：它一定有上游，后面的轨迹页才该有面包屑
  const picked = await panel.evalIn(
    frameId,
    `(function(){
      const box=document.querySelector('#lin-graph');
      box.scrollTop=180;
      const before=box.scrollTop;
      const targetId=(document.querySelector('#lin-graph [data-edge]')||{}).getAttribute
        ? document.querySelector('#lin-graph [data-edge]').getAttribute('data-edge') : '';
      const nodes=[...document.querySelectorAll('#lin-graph [data-lin-family]')];
      const target=nodes.find((n)=>n.getAttribute('data-lin-family')===targetId) || nodes.find((n)=>!n.classList.contains('on'));
      if(!target)return null;
      const id=target.getAttribute('data-lin-family');
      target.click();
      const now=[...document.querySelectorAll('#lin-graph .lin-node.on')];
      return {id,before,after:box.scrollTop,on:now.length,onId:now[0]&&now[0].getAttribute('data-lin-family'),
        dim:document.querySelectorAll('#lin-graph .lin-node.dim').length,
        pick:(document.querySelector('#lin-trail .td-title')||{}).textContent||''}
    })()`,
    false,
  )
  check('点卡片能换选中，且只有一张是 on', !!picked && picked.on === 1 && picked.onId === picked.id, picked)
  check('换选不搬滚动条', !!picked && picked.after === picked.before, picked && { before: picked.before, after: picked.after })
  check('不在这一条线上的族被压暗', !!picked && picked.dim > 0, picked && { dim: picked.dim })
  check('底部说明跟着换', !!picked && picked.pick.length > 0, picked && { pick: picked.pick })

  // ── 真鼠标点卡片 ──
  // 上面用的是 element.click()：合成事件不经指针捕获。真人点击是
  // pointerdown → 画布可能抢指针 → pointerup → click，捕获一改写事件目标，
  // click 就落在画布上，卡片看起来「点了没反应」，只有左侧列表还能用。
  //
  // 坐标要换算：模块界面是 sandbox 过的 srcdoc，里面的 window.frameElement
  // 是 null，量不到自己的偏移；只能从外壳找那个可见的 iframe 当原点。
  // 少了这一步，事件会落到外壳左侧的导航栏上，测出来的「没反应」是假的。
  const frameOffset = await panel.eval(
    `(function(){
      const f=[...document.querySelectorAll('iframe')].find((el)=>{
        const r=el.getBoundingClientRect();
        return r.width>0&&r.height>0
      });
      if(!f) return {x:0,y:0};
      const r=f.getBoundingClientRect();
      return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}
    })()`,
    false,
  )
  const clickTarget = await panel.evalIn(
    frameId,
    `(async function(){
      const raf=()=>new Promise((res)=>requestAnimationFrame(()=>requestAnimationFrame(res)));
      const box=document.querySelector('#lin-graph');
      const nodes=[...document.querySelectorAll('#lin-graph [data-lin-family]')];
      // 页面现在是整屏工作台、自己不滚了：scrollIntoView 只会在页面上找滚动容器，
      // 卡片常常留在画布上沿之外（被焦点链压住），点下去落到栏上。
      // 所以直接挪画布，再挑一张「整张都在画布里」的卡来点
      const visible=(n,b)=>{const r=n.getBoundingClientRect();
        return r.top>=b.top+8&&r.bottom<=b.bottom-8&&r.left>=b.left+8&&r.right<=b.right-8};
      let b=box.getBoundingClientRect();
      let target=nodes.find((n)=>!n.classList.contains('on')&&visible(n,b));
      if(!target){
        const cand=nodes.find((n)=>!n.classList.contains('on'));
        if(!cand) return null;
        // 缩放是 1.0 时 offsetTop 就是画布坐标；缩放过的话这里只求「滚到大致位置」
        box.scrollTop=Math.max(0,cand.offsetTop-box.clientHeight/2+cand.offsetHeight/2);
        await raf();
        b=box.getBoundingClientRect();
        target=nodes.find((n)=>!n.classList.contains('on')&&visible(n,b));
      }
      if(!target) return null;
      const r=target.getBoundingClientRect();
      if(!window.__linClickLog){
        window.__linClickLog=[];
        ['pointerdown','pointerup','click'].forEach(function(name){
          document.addEventListener(name,function(e){
            window.__linClickLog.push(name+':'+(e.target.getAttribute&&e.target.getAttribute('data-lin-family')))
          },true)
        })
      }
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      const owner=hit&&hit.closest?hit.closest('[data-lin-family]'):null;
      return {id:target.getAttribute('data-lin-family'),
        localX:Math.round(r.x+r.width/2), localY:Math.round(r.y+r.height/2),
        hit:hit?(hit.tagName+'.'+(hit.className||'')+'|'+(hit.getAttribute&&hit.getAttribute('data-lin-family'))):'none',
        probe:{owner:owner?owner.getAttribute('data-lin-family'):'', rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}, box:{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}},
        inside:r.top>=b.top&&r.bottom<=b.bottom&&r.left>=b.left&&r.right<=b.right}
    })()`,
    true,
  )
  // 量完到点下去之间不留空档：这中间只要有一次重排，卡片就挪了，点下去会落在别处
  const clickX = clickTarget ? frameOffset.x + clickTarget.localX : 0
  const clickY = clickTarget ? frameOffset.y + clickTarget.localY : 0
  const stillThere = clickTarget && clickTarget.inside
    ? await panel
        .evalIn(
          frameId,
          `(function(){const el=document.elementFromPoint(${clickTarget.localX},${clickTarget.localY});
            const own=el&&el.closest?el.closest('[data-lin-family]'):null;
            return own?own.getAttribute('data-lin-family'):''})()`,
          false,
        )
        .catch(() => '')
    : ''
  if (clickTarget && clickTarget.inside && stillThere !== clickTarget.id) {
    console.log('    · 点之前卡片挪了：原本要点的 ' + clickTarget.id + '，那个点上现在是 ' + (stillThere || '空'))
  }
  if (clickTarget && clickTarget.inside) {
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY, button: 'none' })
    await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', buttons: 1, clickCount: 1 })
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(300)
  }
  const realLog = await panel.evalIn(
    frameId,
    `(function(){
      return {on:[...document.querySelectorAll('#lin-graph .lin-node.on')].map((n)=>n.getAttribute('data-lin-family')),
        log:(window.__linClickLog||[]).slice(-8)}
    })()`,
    false,
  )
  const afterReal = realLog.on
  check('真鼠标点卡片能换选中', !!clickTarget && afterReal.length === 1 && afterReal[0] === clickTarget.id, {
    target: clickTarget && clickTarget.id,
    on: afterReal,
    hit: clickTarget && clickTarget.hit,
    probe: clickTarget && clickTarget.probe,
    inside: clickTarget && clickTarget.inside,
    at: { x: clickX, y: clickY, offset: frameOffset },
    log: realLog.log,
  })

  // 没有上下游的基线：选中它时不该把其他族一起压暗，
  // 那会让人以为「这些实验坏了 / 不能点」。
  // 「孤不孤立」要看数据，不能看图上有没有线：图谱按渐进展开画，
  // 父族被收起时这一族就没有连线，但它其实是有来路的（压暗是对的）。
  // 也不能写死某个族名 —— 换一台机器它就未必在图上。
  const loneDim = await panel
    .evalIn(
      frameId,
      `(async function(){
        const sid=(document.querySelector('#lin-server')||{}).value||'';
        const r=await window.torraPlugin.call('server.history',{serverId:sid});
        const fams=(r&&r.lineage&&r.lineage.families)||[];
        const kids={};fams.forEach((f)=>{if(f.parent)kids[f.parent]=(kids[f.parent]||0)+1});
        const lone=fams.filter((f)=>!f.parent&&!kids[f.id]);
        for(const f of lone){
          const n=document.querySelector('#lin-graph [data-lin-family="'+CSS.escape(f.id)+'"]');
          if(!n)continue;
          n.click();
          await new Promise((r2)=>setTimeout(r2,250));
          const on=document.querySelector('#lin-graph .lin-node.on');
          return {want:f.id,on:on&&on.getAttribute('data-lin-family'),
            dim:document.querySelectorAll('#lin-graph .lin-node.dim').length,
            loneTotal:lone.length}
        }
        return {none:true,loneTotal:lone.length,fams:fams.length}
      })()`,
      true,
      30000,
    )
    .catch(() => null)
  if (loneDim && loneDim.none) console.log('    · 这台机器上的族都有来路，没有「孤零零的基线」可验：' + JSON.stringify(loneDim))
  check(
    '选中没有上下游的基线时不压暗别人',
    !loneDim || loneDim.none || (loneDim.on === loneDim.want && loneDim.dim === 0),
    loneDim,
  )

  // 拖动平移：按下 → 移过阈值 → 松手。画布要动，但不许顺手换掉选中
  const panFrom = await panel.evalIn(
    frameId,
    `(function(){
      const box=document.querySelector('#lin-graph');
      const r=box.getBoundingClientRect();
      const cs=getComputedStyle(box);
      const on=box.querySelector('.lin-node.on');
      return {x:Math.round(r.left+r.width*0.6), y:Math.round(r.top+r.height*0.55), left:box.scrollLeft, top:box.scrollTop,
        // 拖动前后比的是「同一张选中」：中间可能又点过别的族，写死早先的 id 会假红
        on:on?on.getAttribute('data-lin-family'):'',
        overflow:cs.overflowX+'/'+cs.overflowY,
        room:box.scrollHeight-box.clientHeight, wide:box.scrollWidth-box.clientWidth}
    })()`,
    false,
  )
  const panX = frameOffset.x + panFrom.x
  const panY = frameOffset.y + panFrom.y
  await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panX, y: panY, button: 'none' })
  await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: panX, y: panY, button: 'left', buttons: 1, clickCount: 1 })
  for (const step of [8, 24, 48, 70]) {
    await panel.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: panX - step,
      y: panY - step,
      button: 'left',
      buttons: 1,
    })
  }
  // 还没松手就读一次：按住拖动时画布会挂上 lin-grabbing。
  // 挂着但没动 = 平移写在了不该滚的容器上；没挂 = pointermove 根本没送到画布
  const midPan = await panel
    .evalIn(
      frameId,
      `(function(){const b=document.querySelector('#lin-graph');
        return {grabbing:b.classList.contains('lin-grabbing'),left:b.scrollLeft,top:b.scrollTop}})()`,
      false,
    )
    .catch(() => null)
  await panel.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: panX - 70,
    y: panY - 70,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  await sleep(300)
  const afterPan = await panel.evalIn(
    frameId,
    `(function(){
      const b=document.querySelector('#lin-graph');
      return {left:b.scrollLeft, top:b.scrollTop,
        on:[...document.querySelectorAll('#lin-graph .lin-node.on')].map((n)=>n.getAttribute('data-lin-family'))}
    })()`,
    false,
  )
  check(
    '按住拖动是平移，不顺手换选中',
    (afterPan.left > panFrom.left || afterPan.top > panFrom.top) &&
      afterPan.on.length === 1 &&
      afterPan.on[0] === panFrom.on,
    { from: panFrom, mid: midPan, to: afterPan },
  )

  // ── 缩放 ──
  const zoomed = await panel.evalIn(
    frameId,
    `(function(){
      const pct=()=>parseInt(document.querySelector('#lin-zoom-pct').textContent,10);
      document.querySelector('[data-zoom="fit"]').click();
      const fit=pct();
      document.querySelector('#lin-zoom-pct').click();
      const one=pct();
      document.querySelector('[data-zoom="out"]').click();
      const out=pct();
      return {fit,one,out}
    })()`,
    false,
  )
  check('适应会缩到看得见的比例（≥50%）', zoomed.fit >= 50 && zoomed.fit <= 100, zoomed)
  check('点百分比回到 100%', zoomed.one === 100, zoomed)
  check('减号能继续缩小', zoomed.out < 100, zoomed)

  // 回到 100% 滚到最上面，把 tkgr 与 case 两条道拍下来：
  // 这两条线的卡片名只有 full / mini / s42，图上认不认得出族，得看原尺寸
  await panel.evalIn(
    frameId,
    `(function(){
      document.querySelector('#lin-zoom-pct').click();
      const box=document.querySelector('#lin-graph');
      box.scrollTop=0;
      return document.querySelector('#lin-zoom-pct').textContent
    })()`,
    false,
  )
  await sleep(400)
  await shot('lineage-top')

  // 面包屑只对「有来路」的族有意义。上一步真鼠标点中的可能是 AdaTKG 这种
  // 父目录为空的基线：0 条面包屑是对的，不该算失败。先明确选一个有三代的族。
  await panel.evalIn(
    frameId,
    `(function(){
      const node=document.querySelector('#lin-graph [data-lin-family="tkgr.transfir.state.200ep"]')||
        document.querySelector('#lin-graph [data-lin-family="tkgr.transfir.state"]');
      if(node)node.click()
    })()`,
    false,
  )
  await sleep(200)

  // ── 合并之后只剩一页：左栏是层级树，这一族的说明与矩阵在画布下方通栏 ──
  const merged = await panel.evalIn(
    frameId,
    `(function(){
      const c=document.querySelector('.lin-col'), trail=document.querySelector('#lin-trail');
      const rc=c?c.getBoundingClientRect():null, rt=trail?trail.getBoundingClientRect():null;
      return {modeBtns:document.querySelectorAll('#lin-mode [data-mode]').length,
        trailCard:!!document.querySelector('#lin-trail-card'),
        famList:!!document.querySelector('#lin-fam-list'),
        rail:!!document.querySelector('#lin-rail'),
        side:!!trail,
        inSide:!!document.querySelector('.lin-side #lin-trail'),
        inCol:!!document.querySelector('.lin-col #lin-trail'),
        bandPct:rt&&rc&&rc.width?+(rt.width/rc.width*100).toFixed(1):0}
    })()`,
    false,
  )
  check('只剩一页：视角切换、另一套族列表、焦点链导轨都撤掉了', merged.modeBtns === 0 && !merged.trailCard && !merged.famList && !merged.rail, merged)
  check('这一族的说明与运行矩阵摆在画布下方的通栏里', merged.side && merged.inCol && !merged.inSide, merged)
  check('矩阵真的用上了通栏宽度（≥85% 的右栏宽）', merged.bandPct >= 85, merged)

  // ── 左栏那棵树：层级关系得看得出来，而且点它要能带着整页走 ──
  // 默认只摊焦点这一支，量不出层级。先按「全展开」（左栏和图谱共用同一个开关），
  // 摊平之后再量嵌套、缩进和点击联动。
  const tree = await panel.evalIn(
    frameId,
    `(async function(){
      document.querySelector('#lin-tree-expand').click();
      await new Promise((r)=>setTimeout(r,300));
      const t=document.querySelector('#lin-tree');
      if(!t)return null;
      const rows=[...t.querySelectorAll('.lin-fam')];
      // 深度看真实的嵌套：ul 里再套 ul 才算「有层级」。每条道最外面那层 ul 不算深度，
      // 所以减掉它；光比缩进像素会被左边框骗，缩进单独用横坐标另量一次。
      const depth=(node)=>{let d=0,p=node.parentNode;while(p&&p!==t){if(p.nodeName==='UL')d++;p=p.parentNode}return d-1};
      const depths=rows.map(depth);
      const nested=rows.filter((r,i)=>depths[i]>=1);
      // 缩进也得真的体现在横坐标上，否则「层级」只是 DOM 里的形状
      const shallow=rows.find((r,i)=>depths[i]===0), deep=nested[0];
      const indented=shallow&&deep?Math.round(deep.getBoundingClientRect().left-shallow.getBoundingClientRect().left):-999;
      const on=t.querySelector('.lin-fam.on');
      const toggles=[...t.querySelectorAll('.fold:not(.leaf)')].length;
      // 点一层深处的族：树里的高亮、图谱上的选中、下方通栏的说明，得一起跟过去
      let link=null;
      if(deep){
        const want=deep.getAttribute('data-lin-family');
        const before=(document.querySelector('#lin-trail .td-title')||{}).textContent||'';
        deep.click();
        await new Promise((r)=>setTimeout(r,260));
        const onNow=document.querySelector('#lin-tree .lin-fam.on');
        const gOn=document.querySelector('#lin-graph .lin-node.on');
        link={want,
          treeOn:onNow?onNow.getAttribute('data-lin-family'):'',
          graphOn:gOn?gOn.getAttribute('data-lin-family'):'',
          titleChanged:((document.querySelector('#lin-trail .td-title')||{}).textContent||'').trim()!==before.trim()}
      }
      return {rows:rows.length, maxDepth:Math.max(0,...depths), nested:nested.length, indented,
        selected:!!on,onId:on?on.getAttribute('data-lin-family'):'', toggles, link,
        count:(document.querySelector('#lin-tree-count')||{}).textContent||''}
    })()`,
    true,
    30000,
  )
  check('全展开后这棵树把族按父子层级铺出来（有第二层，且真的往右缩进）',
    !!tree && tree.maxDepth >= 1 && tree.nested > 0 && tree.indented >= 8, tree)
  check('树上点中的那一族就是当前焦点（图与详情跟着它）', !!tree && tree.selected && !!tree.onId, tree)
  check('有孩子的族给了折叠按钮（层级能收也能摊）', !!tree && tree.toggles > 0, tree)
  check('点树里深处的一族：树、图、通栏三处一起换到它',
    !!(tree && tree.link) && tree.link.treeOn === tree.link.want &&
      tree.link.graphOn === tree.link.want && tree.link.titleChanged,
    tree && tree.link)
  await shot('lineage-tree')

  // 从树上换到一个多阶段的族：矩阵按阶段分列、按 seed 分行，格子里的 Δ 就是这一跳的涨跌。
  // 走树的入口而不是图谱上的卡片——图谱默认只摊焦点这一支，卡片可能根本不在这儿。
  const flow = await panel.evalIn(
    frameId,
    `(async function(){
      const rows=[...document.querySelectorAll('#lin-tree .lin-fam'),
        ...document.querySelectorAll('#lin-graph [data-lin-family]')];
      for(const n of rows){
        n.click();
        await new Promise((r)=>setTimeout(r,160));
        const grid=document.querySelector('#lin-trail .trail-grid');
        const heads=grid?grid.querySelectorAll('.ghead').length:0;
        if(heads>=2){
          return {id:n.getAttribute('data-lin-family'),
            fromTree:!!n.closest('#lin-tree'),
            onTree:(document.querySelector('#lin-tree .lin-fam.on')||{}).getAttribute
              ?(document.querySelector('#lin-tree .lin-fam.on').getAttribute('data-lin-family')||''):'',
            title:(document.querySelector('#lin-trail .td-title')||{}).textContent||'',
            stages:[...grid.querySelectorAll('.ghead')].map((g)=>g.textContent),
            cells:grid.querySelectorAll('[data-lin-run]').length,
            deltas:[...document.querySelectorAll('#lin-trail .trail-cell .lin-delta')].map((d)=>d.textContent)}
        }
      }
      return {id:'',fromTree:false,onTree:'',title:'',stages:[],cells:0,deltas:[]}
    })()`,
    true,
    40000,
  )
  check('从树上换到多阶段族，下方通栏摆出阶段 × seed 矩阵', flow.stages.length >= 2 && flow.cells > 0, flow)
  check('树上点的一族成了树里的焦点（选中的高亮跟着走）', flow.onTree === flow.id && !!flow.id, flow)
  // 通栏不是「滚一下才到」的抽屉：点开一族，矩阵就得已经在视野里开始。
  // 头部（标题 + 一行说明 + 一排数）每多占一行，这条就更紧，所以直接量它。
  const bandFit = await panel.evalIn(
    frameId,
    `(function(){
      const box=document.querySelector('#lin-trail'), grid=document.querySelector('#lin-trail .trail-grid');
      const head=grid?grid.querySelector('.ghead'):null;
      const first=document.querySelector('#lin-trail .trail-cell:not(.blank)');
      if(!box||!grid)return null;
      const rb=box.getBoundingClientRect(), rg=grid.getBoundingClientRect();
      const rh=head?head.getBoundingClientRect():null, rc=first?first.getBoundingClientRect():null;
      return {scrollTop:Math.round(box.scrollTop), gridTopInBox:Math.round(rg.top-rb.top),
        headVisible:!!rh&&rh.top>=rb.top-2&&rh.bottom<=rb.bottom+2,
        cellVisible:!!rc&&rc.top>=rb.top-2&&rc.bottom<=rb.bottom+2,
        bandH:Math.round(rb.height), gridH:Math.round(rg.height)}
    })()`,
    false,
  )
  check('矩阵就在通栏视野里开始（不用先滚过头部才看到阶段列）',
    !!bandFit && bandFit.scrollTop === 0 && bandFit.gridTopInBox >= 0 && bandFit.headVisible,
    bandFit)
  check(
    '格子里的跳变 Δ 都带着方向',
    flow.deltas.length > 0 && flow.deltas.every((d) => /^[+−±]/.test(d)),
    { deltas: flow.deltas.slice(0, 6) },
  )
  // 量完层级就把「全展开」收回去：后面的截图要看的是默认那一屏，不是摊平的两千行
  await panel.evalIn(
    frameId,
    `(function(){document.querySelector('#lin-tree-expand').click();return true})()`,
    false,
  )
  await sleep(400)
  await shot('lineage-side-runs')
  // 格子里那几次运行的名字还在（没被分数挤成 0 宽）
  const cellFit = await panel.evalIn(
    frameId,
    `(function(){
      // 一格只有一次运行时，名字那行本来就是空的（阶段在列上、seed 在行上，不必重复），
      // 所以只挑「写了区分点」的格子量宽度
      const name=[...document.querySelectorAll('#lin-trail .trail-cell .rname')]
        .find((n)=>(n.textContent||'').trim());
      if(!name)return null;
      name.closest('.trail-cell').scrollIntoView({block:'nearest',inline:'nearest'});
      const box=name.closest('.trail-cell').getBoundingClientRect();
      const nr=name.getBoundingClientRect();
      return {cell:Math.round(box.width), rname:Math.round(nr.width), text:name.textContent.trim()}
    })()`,
    false,
  )
  check('格子里的运行名还在（没被分数挤成 0 宽）', !!cellFit && cellFit.rname >= 36, cellFit)
  await shot('lineage-side-runs-narrow')

  // 点一次运行 → 就地开日志：抽屉浮在族谱上，读完关掉还站在原地
  const inline = await panel.evalIn(
    frameId,
    `(function(){
      const cells=[...document.querySelectorAll('#lin-trail [data-lin-run]')];
      const cell=cells.find(function(c){return (c.getAttribute('data-lin-log')||'')!==''})||cells[0];
      if(!cell)return null;
      const id=cell.getAttribute('data-lin-run');
      const log=cell.getAttribute('data-lin-log')||'';
      cell.click();
      return {id:id,log:log,
        open:document.body.classList.contains('drawer-open'),
        lineage:!document.querySelector('#view-lineage').classList.contains('hidden'),
        history:!document.querySelector('#view-history').classList.contains('hidden')}
    })()`,
    false,
  )
  check('轨迹里点得到某一次运行', !!inline, inline)
  if (inline && inline.log) {
    check('点一次运行就地开日志抽屉', inline.open, inline)
    check('读日志时不跳到实验历史', inline.lineage && !inline.history, inline)
    // 日志是异步取的，等它回来再读抽屉
    await sleep(2500)
    const tail = await panel.evalIn(
      frameId,
      `(function(){
        const body=document.querySelector('#drawer-body');
        return {text:((body||{}).textContent||'').slice(0,160),
          sub:(document.querySelector('#drawer-sub')||{}).textContent||'',
          state:(document.querySelector('#drawer-state')||{}).textContent||'',
          open:document.body.classList.contains('drawer-open')}
      })()`,
      false,
    )
    check('抽屉里读到的是那次运行的日志', tail.open && tail.text.length > 0 && !/读取失败/.test(tail.text), tail)
    check('抽屉说的就是点的那份日志', tail.sub.indexOf(inline.log.split('/').pop()) >= 0, { sub: tail.sub, log: inline.log })
    await shot('lineage-inline-log')
    await panel.evalIn(frameId, `(function(){document.querySelector('#drawer-close').click();return true})()`, false)
    // 名字也是同一个入口：点它读的是同一次运行的日志
    const byName = await panel.evalIn(
      frameId,
      `(function(){
        const name=document.querySelector('#lin-trail .rname[data-lin-log]');
        if(!name)return null;
        name.click();
        return {open:document.body.classList.contains('drawer-open'),
          lineage:!document.querySelector('#view-lineage').classList.contains('hidden')}
      })()`,
      false,
    )
    check('点运行名也是就地开日志', !!byName && byName.open && byName.lineage, byName)
    await panel.evalIn(frameId, `(function(){document.querySelector('#drawer-close').click();return true})()`, false)
    const closed = await panel.evalIn(
      frameId,
      `(function(){return {open:document.body.classList.contains('drawer-open'),lineage:!document.querySelector('#view-lineage').classList.contains('hidden')}})()`,
      false,
    )
    check('关掉抽屉仍停在族谱这一页', !closed.open && closed.lineage, closed)
  } else {
    console.log('    · 这一族的运行没带日志文件，跳过就地读日志的检查')
  }

  // 「详情」→ 跳到实验历史并选中它
  const jumped = await panel.evalIn(
    frameId,
    `(function(){
      const more=document.querySelector('#lin-trail [data-lin-gorun]');
      if(!more)return null;
      const id=more.getAttribute('data-lin-gorun');
      more.click();
      const view=document.querySelector('#view-history');
      const on=document.querySelector('#hist-list .exp.on');
      return {id,history:!!view&&!view.classList.contains('hidden'),
        tab:document.querySelector('#tab-history').classList.contains('on'),
        selected:on?on.getAttribute('data-hist'):'', count:document.querySelectorAll('#hist-list .exp').length}
    })()`,
    false,
  )
  check('点「详情」会跳到实验历史', !!jumped && jumped.history && jumped.tab, jumped)
  check('并且直接选中那一条', !!jumped && jumped.selected === 'runs|' + jumped.id, jumped)
  await shot('lineage-jump-history')

  check('全程没有面板脚本报错', panel.errors.length === 0 && page.errors.length === 0, {
    errors: [...panel.errors, ...page.errors].slice(0, 3),
  })
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

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} 项未通过\x1b[0m ` + failures.join(', ')
    : `\n\x1b[32m全部通过\x1b[0m · 截图在 ${OUT}`,
)
process.exit(failures.length ? 1 : 0)
