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

  // ── 进族谱页 ──
  await panel.evalIn(frameId, `document.querySelector('#tab-lineage').click()`, false)
  await sleep(400)
  const entered = await panel.evalIn(
    frameId,
    `(function(){const v=document.querySelector('#view-lineage');return v?{hidden:v.classList.contains('hidden'),tab:document.querySelector('#tab-lineage').classList.contains('on'),kpis:document.querySelectorAll('#lin-stats .kpi').length,statsTag:document.querySelector('#lin-stats').className,mode:document.querySelectorAll('#lin-mode [data-mode]').length}:null})()`,
    false,
  )
  check('点标签能切到族谱页', !!entered && !entered.hidden && entered.tab, entered)
  check('四张统计卡 + 两个模式按钮', !!entered && entered.kpis === 4 && entered.mode === 2, entered)
  check('统计卡容器自己就是 .kpis（不然四张会被挤成一列）', !!entered && /(^| )kpis( |$)/.test(entered.statsTag), entered?.statsTag)

  if (!target) {
    const empty = await panel.evalIn(frameId, `(document.querySelector('#lin-graph').textContent||'').slice(0,40)`, false)
    check('没绑机器时给的是「扫一次」的提示，不是空白', /扫|没|台账/.test(empty), { empty })
    await shot('lineage-empty')
    return
  }

  // ── 真实扫描 ──
  await panel.evalIn(frameId, `document.querySelector('#lin-scan').click()`, false)
  const ready = await panel.waitIn(frameId, '[data-lin-family]', 40000)
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
        dup:ids.length-new Set(ids).size, sample:ids.slice(0,4).concat(ids.slice(-4)),
        loose:document.querySelectorAll('#lin-graph [data-lin-loose]').length,
        looseInsideOther, otherHead:otherHead.slice(0,24),
        flowOn:document.querySelectorAll('#lin-graph .lin-edge-pair.on .lin-flow').length,
        flowAnim:(function(){const f=document.querySelector('#lin-graph .lin-edge-pair.on .lin-flow');
          return f?getComputedStyle(f).animationName:''})(),
        scrollH:box.scrollHeight,clientW:box.clientWidth,
        on:document.querySelectorAll('#lin-graph .lin-node.on').length,
        pick:(document.querySelector('#lin-pick .lin-pick-title')||{}).textContent||''}
    })()`,
    false,
  )
  check('图谱有卡片也有连线', graph.nodes > 10 && graph.edges > 0, graph)
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
        pick:(document.querySelector('#lin-pick .lin-pick-title')||{}).textContent||''}
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
    `(function(){
      const box=document.querySelector('#lin-graph');
      const nodes=[...document.querySelectorAll('#lin-graph [data-lin-family]')];
      const target=nodes.find((n)=>!n.classList.contains('on'));
      if(!target) return null;
      target.scrollIntoView({block:'center',inline:'center'});
      const r=target.getBoundingClientRect();
      const b=box.getBoundingClientRect();
      if(!window.__linClickLog){
        window.__linClickLog=[];
        ['pointerdown','pointerup','click'].forEach(function(name){
          document.addEventListener(name,function(e){
            window.__linClickLog.push(name+':'+(e.target.getAttribute&&e.target.getAttribute('data-lin-family')))
          },true)
        })
      }
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {id:target.getAttribute('data-lin-family'),
        localX:Math.round(r.x+r.width/2), localY:Math.round(r.y+r.height/2),
        hit:hit?(hit.tagName+'.'+(hit.className||'')+'|'+(hit.getAttribute&&hit.getAttribute('data-lin-family'))):'none',
        inside:r.top>=b.top&&r.bottom<=b.bottom&&r.left>=b.left&&r.right<=b.right}
    })()`,
    false,
  )
  await sleep(300)
  const clickX = clickTarget ? frameOffset.x + clickTarget.localX : 0
  const clickY = clickTarget ? frameOffset.y + clickTarget.localY : 0
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
    inside: clickTarget && clickTarget.inside,
    at: { x: clickX, y: clickY, offset: frameOffset },
    log: realLog.log,
  })

  // AdaTKG 是没有上下游的基线：选中它时不该把其他族一起压暗，
  // 那会让人以为「这些实验坏了 / 不能点」
  const loneDim = await panel.evalIn(
    frameId,
    `(function(){
      const on=document.querySelector('#lin-graph .lin-node.on');
      return {on:on&&on.getAttribute('data-lin-family'),
        dim:document.querySelectorAll('#lin-graph .lin-node.dim').length}
    })()`,
    false,
  )
  check('选中孤零零的基线时不压暗别人', loneDim.on === 'tkgr.adatkg' && loneDim.dim === 0, loneDim)

  // 拖动平移：按下 → 移过阈值 → 松手。画布要动，但不许顺手换掉选中
  const panFrom = await panel.evalIn(
    frameId,
    `(function(){
      const box=document.querySelector('#lin-graph');
      const r=box.getBoundingClientRect();
      return {x:Math.round(r.left+r.width*0.6), y:Math.round(r.top+r.height*0.55), left:box.scrollLeft, top:box.scrollTop}
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
      afterPan.on[0] === (clickTarget && clickTarget.id),
    { from: panFrom, to: afterPan },
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

  // ── 衍生轨迹 ──
  await panel.evalIn(frameId, `document.querySelector('#lin-mode [data-mode="trail"]').click()`, false)
  await sleep(500)
  const trail = await panel.evalIn(
    frameId,
    `(function(){
      const card=document.querySelector('#lin-trail-card');
      const grid=document.querySelector('#lin-trail .trail-grid');
      const fams=document.querySelectorAll('#lin-fam-list [data-lin-family]').length;
      return {
        visible:!!card&&!card.classList.contains('hidden'),
        graphHidden:document.querySelector('#lin-graph-card').classList.contains('hidden'),
        fams,heads:document.querySelectorAll('#lin-trail .ghead').length,
        runs:document.querySelectorAll('#lin-trail [data-lin-run]').length,
        crumbs:document.querySelectorAll('#lin-trail [data-lin-jump]').length,
        grid:!!grid,
        title:(document.querySelector('#lin-trail .trail-title')||{}).textContent||''
      }
    })()`,
    false,
  )
  check('切到衍生轨迹：图谱让位、轨迹出现', trail.visible && trail.graphHidden, trail)
  check('左边列出全部实验族', trail.fams > 10, trail)
  check('轨迹按「阶段 × seed」摆开', trail.grid && trail.heads > 0 && trail.runs > 0, trail)
  check('顶上有来路面包屑', trail.crumbs > 0, trail)

  // 换到多阶段的族：阶段之间该有一条会往右流的线，把分数怎么变直接写出来
  const flow = await panel.evalIn(
    frameId,
    `(function(){
      const target=[...document.querySelectorAll('#lin-fam-list [data-lin-family]')]
        .find((b)=>/消融三阶/.test(b.textContent));
      if(target)target.click();
      const strip=document.querySelector('#lin-trail .trail-flow');
      const arrows=[...(strip?strip.querySelectorAll('.tf-arrow'):[])];
      const link=arrows[0]?arrows[0].querySelector('i'):null;
      return {found:!!target,title:(document.querySelector('#lin-trail .trail-title')||{}).textContent||'',
        stages:strip?strip.querySelectorAll('.tf-stage').length:0,arrows:arrows.length,
        anim:link?getComputedStyle(link).animationName:'',
        names:[...document.querySelectorAll('#lin-trail .tf-name')].map((n)=>n.textContent),
        mrrs:[...document.querySelectorAll('#lin-trail .tf-mrr')].map((n)=>n.textContent),
        deltas:arrows.map((a)=>a.querySelector('b').textContent)}
    })()`,
    false,
  )
  check('多阶段族的阶段之间画出走向', flow.found && flow.stages >= 2 && flow.arrows === flow.stages - 1, flow)
  check('走向线在流动、跳变写在线上', flow.anim === 'tfRun' && flow.deltas.every((d) => /^[+−±—]/.test(d)), {
    anim: flow.anim,
    deltas: flow.deltas,
  })
  await shot('lineage-trail')

  // 点一次运行 → 跳到实验历史并选中它
  const jumped = await panel.evalIn(
    frameId,
    `(function(){
      const cell=document.querySelector('#lin-trail [data-lin-run]');
      if(!cell)return null;
      const id=cell.getAttribute('data-lin-run');
      cell.click();
      const view=document.querySelector('#view-history');
      const on=document.querySelector('#hist-list .exp.on');
      return {id,history:!!view&&!view.classList.contains('hidden'),
        tab:document.querySelector('#tab-history').classList.contains('on'),
        selected:on?on.getAttribute('data-hist'):'', count:document.querySelectorAll('#hist-list .exp').length}
    })()`,
    false,
  )
  check('点一次运行会跳到实验历史', !!jumped && jumped.history && jumped.tab, jumped)
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
