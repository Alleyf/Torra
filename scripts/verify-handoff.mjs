// 运行时验证：研讨收尾 → 研究主线（交接稿真的变成主线节点）。
//
// 这一段曾经只有一条人工链路：研讨结束，用户复制一段 Markdown 交接稿，
// 自己粘进研究工作台，再手工把结论与分歧重建成节点。抄一次重建一次，
// 没谈完的分歧通常在重抄里被丢掉 —— 丢的往往正是最该带走的那部分。
//
// 这里盯住整条链：
//   1. 收尾处有「落到研究主线」这一下；
//   2. 工作台没启用时，这一下要说清缺什么、并给出去设置的路 —— 而且不能替用户启用；
//   3. 启用之后，交接稿真的送到了 research 面板帧里；
//   4. 面板里的预览卡真的出现（认账的结论、没谈完的分歧都在）；
//   5. 点「落进主线」之后，用 trajectory.project.get 读回来 —— 节点真的建出来了。
//
// 用一份全新的临时 userData 启动，只管理本脚本 spawn 的 electron 进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'handoff')
const PORT = await freePort(9681)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-handoff-'))

let failures = []
const check = (name, ok, extra) => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? ` · ${JSON.stringify(extra)}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let wsCdp = null
let wsMainCdp = null
let wsPanelCdp = null

function cdpClient(socket) {
  let id = 0
  const pending = new Map()
  const listeners = []
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
      return
    }
    if (msg.method) listeners.forEach((fn) => fn(msg))
  })
  return {
    send(method, params = {}, timeoutMs = 20000) {
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
    on(fn) {
      listeners.push(fn)
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

/** 插件面板帧（torra-ui://frame/…）是不是独立目标：是的话就能直接连上去看它 */
async function findPanelTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const hit = list.find((t) => (t.url || '').startsWith('torra-ui://frame/'))
      if (hit) return hit
    } catch {
      /* 尚未就绪 */
    }
    await sleep(400)
  }
  return null
}

async function connect(url) {
  const sock = new WebSocket(url)
  await new Promise((res, rej) => {
    sock.addEventListener('open', res)
    sock.addEventListener('error', rej)
  })
  return cdpClient(sock)
}

/**
 * 连上面板帧（torra-ui://frame/…）。
 *
 * 面板帧不是常驻的：切走再切回来，旧的帧连同它的调试连接一起没了，
 * 目标也会换一个。所以这里做成可重连的 —— 连接废了要能重新接上，
 * 否则一次切屏就把后面的验证全打断。
 */
async function connectPanel() {
  // 挨个试：列表里可能还留着已经废掉的那个面板目标
  for (const t of await panelTargets()) {
    try {
      const cdp = await connect(t.webSocketDebuggerUrl)
      await cdp.send('Runtime.enable')
      await cdp.send('Page.enable')
      wsPanelCdp = cdp
      trackContexts(wsPanelCdp)
      return true
    } catch {
      /* 试下一个 */
    }
  }
  return false
}

/** 列出所有面板帧目标：旧的那个可能还没被回收，重连时要挨个试 */
async function panelTargets() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    return list.filter((t) => String(t.url || '').startsWith('torra-ui://frame/'))
  } catch {
    return []
  }
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

async function shot(name) {
  fs.mkdirSync(OUT, { recursive: true })
  // 窗口被别的程序压着时，合成器不产帧，从表面抓图会一直等到超时 ——
  // fromSurface:false 走渲染进程自己那份，窗口在不在前台都抓得到。
  for (const cdp of [wsCdp, wsPanelCdp].filter(Boolean)) {
    try {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false }, 20000)
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
      return
    } catch (e) {
      if (cdp === wsCdp) console.log('（页面截图没成功：' + e.message + '）')
    }
  }
  console.log('（截图没成功）')
}

/** 点一个按钮（按文案找），返回点到了没有 */
async function clickByText(selector, re) {
  return evalJs(
    `(function(){const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>${re}.test(x.textContent||''));if(!b)return false;b.click();return true})()`,
    false,
  )
}

/**
 * 假模型清单：两家网页模型 + 一家 API 模型。
 *
 * 主持是从这批里挑的（挑那家能出结构化输出的 API 模型），所以这份清单里
 * 有一家 API 模型是必要的 —— 否则主持那一条路整个空着，收尾块也无从验。
 */
const MODELS = [
  { id: 'chatgpt', displayName: 'ChatGPT', transport: 'webview', domain: 'chatgpt.com', color: '#5aa9e6', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'claude', displayName: 'Claude', transport: 'webview', domain: 'claude.ai', color: '#d97757', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'deepseek', displayName: 'DeepSeek', transport: 'api', color: '#4d6bfe', enabled: true, supportsStructuredOutput: true, adapterHealth: 'unknown', adapterStale: false, hasKey: true, status: 'ready' },
]

/**
 * 主进程侧的假 handler：模型清单 + 开一场。
 *
 * 开场这一段真跑会拉真适配器、真发请求 —— 这里只要「开场成功」这一句话，
 * 后面的发言、主持小结、结束原因都由事件灌进去。
 */
async function installFixtures() {
  const src = `
(function(){
  const { ipcMain } = require('electron');
  const models = ${JSON.stringify(MODELS)};
  for (const ch of ['models:list', 'session:start']) { try { ipcMain.removeHandler(ch) } catch (e) {} }
  ipcMain.handle('models:list', () => models);
  ipcMain.handle('session:start', () => ({ ok: true }));
  return 'installed';
})()`
  return mainEval(src)
}

/** 把灌进 store 的事件按真实契约排好：先发言，再主持小结，最后收尾 */
const EVENTS = [
  { type: 'state', state: 'AGENT_BATCH', round: 3 },
  { type: 'round-start', round: 3, total: 3 },
  { type: 'utterance-done', utterance: { id: 'u1', round: 3, agentId: 'chatgpt', content: '支持引入实时层：P95 延迟能压到 1 秒内，月度增量成本约 800 元，现有数仓已具备接入能力。', targets: [], stance: 'support', usage: { promptTokens: 0, completionTokens: 60, costUsd: 0.012 } } },
  { type: 'utterance-done', utterance: { id: 'u2', round: 3, agentId: 'claude', content: '反对：当前量级用批处理加缓存即可覆盖，引入实时层会带来一致性问题 —— 实时与离线批处理结果不一致时，报表数字无法对账。', targets: [], stance: 'oppose', usage: { promptTokens: 0, completionTokens: 66, costUsd: 0.014 } } },
  {
    type: 'moderator',
    digest: {
      consensus_points: [
        { claim: 'P95 延迟是当前核心瓶颈', support: ['chatgpt', 'claude'], confidence: 0.85, evidence_ref: ['u1', 'u2'] },
      ],
      open_disputes: [
        { claim: '是否需要双写对账层', sides: [{ agent_id: 'chatgpt', argument: '不需要，双写成本高于收益' }, { agent_id: 'claude', argument: '需要，否则数字无法对账' }] }],
    },
    score: { round: 3, score: 58, agreement: 50, overlap: 60, trend: 50 },
    open: [
      {
        id: 'd1',
        claim: '是否需要双写对账层',
        sides: [
          { agentId: 'chatgpt', argument: '不需要，双写成本高于收益', utteranceIds: ['u1'] },
          { agentId: 'claude', argument: '需要，否则数字无法对账', utteranceIds: ['u2'] },
        ],
        openedRound: 3,
        lastProgress: null,
        status: 'open',
      },
    ],
  },
]

async function pushEvents(events) {
  return evalJs(
    `(function(){const s=window.__torraStore;if(!s)return 'no-store';for(const e of ${JSON.stringify(events)})s.getState().applyEvent(e);return 'ok'})()`,
    false,
  )
}

/* ───────────────────────── 插件面板帧（跨源）里的操作 ───────────────────────── */

/** 帧的执行上下文：srcdoc 模块帧每次换 srcdoc 都会重建，得按 frameId 跟着换 */
const panelContexts = new Map()

function trackContexts(cdp) {
  cdp.on((msg) => {
    if (msg.method !== 'Runtime.executionContextCreated') return
    const ctx = msg.params?.context
    if (!ctx || !ctx.auxData || !ctx.auxData.frameId) return
    panelContexts.set(ctx.auxData.frameId, ctx.id)
  })
}

/** 在帧树里找 url 是 about:srcdoc 的那一层：模块帧就是它 */
function findSrcdocFrame(node) {
  if (!node) return null
  if (node.frame && (node.frame.url || '').startsWith('about:srcdoc')) return node.frame
  for (const child of node.childFrames || []) {
    const hit = findSrcdocFrame(child)
    if (hit) return hit
  }
  return null
}

/** 在插件外壳（研究工作台那一层）里执行一段 JS */
async function shellEval(expression, awaitPromise = false) {
  for (let i = 0; i < 12; i++) {
    try {
      // 每轮重取连接：重连之后旧的那个 cdp 引用是废的
      const cdp = wsPanelCdp || wsCdp
      const tree = await cdp.send('Page.getFrameTree')
      const world = await cdp.send('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id,
        worldName: 'verify-shell',
      })
      const r = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
        contextId: world.executionContextId,
      })
      if (r.exceptionDetails) {
        throw new Error('外壳执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      }
      return r.result.value
    } catch (e) {
      const msg = String(e.message)
      if (/Cannot find context|Execution context was destroyed/i.test(msg)) {
        /* 下一轮再试 */
      } else if (/CDP 超时|closed|ECONN|Invalid frame/i.test(msg)) {
        await connectPanel()
      } else {
        throw e
      }
    }
    await sleep(500)
  }
  return null
}

/**
 * 在模块帧里执行一段 JS；帧还没起来就返回 null。
 *
 * 不靠 Runtime.executionContextCreated 那条事件：srcdoc 帧的上下文有时压根没被报出来
 * （建帧发生在连接之前就会漏），只押一条路会随机出现「明明有帧却找不到」。
 * 这里改用 Page.createIsolatedWorld 现开一个世界 —— 它按帧 id 给，
 * 跟上下文什么时候被报出来无关。
 */
async function moduleEval(expression, awaitPromise = true) {
  /** 给某个帧开一个隔离世界，拿它的执行上下文 id */
  async function worldOf(cdp, frameId) {
    try {
      const w = await cdp.send('Page.createIsolatedWorld', {
        frameId,
        worldName: 'verify',
        grantUniveralAccess: true,
      })
      return w.executionContextId
    } catch {
      const w = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'verify' })
      return w.executionContextId
    }
  }

  for (let i = 0; i < 12; i++) {
    try {
      // 每轮重取连接：重连之后旧的那个 cdp 引用是废的
      const cdp = wsPanelCdp || wsCdp
      const tree = await cdp.send('Page.getFrameTree')
      const frame = findSrcdocFrame(tree.frameTree)
      if (frame) {
        const contextId = await worldOf(cdp, frame.id)
        const r = await cdp.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise,
          contextId,
        })
        if (r.exceptionDetails) {
          throw new Error(
            '模块帧执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text),
          )
        }
        return r.result.value
      }
      // 退路：从外壳文档里直接摸到模块帧（子框架同源，外壳能拿到它的 contentWindow）
      const rootCtx = await worldOf(cdp, tree.frameTree.frame.id)
      const wrapped = `(function(){
        var f=document.getElementById('frame-trajectory');
        if(!f||!f.contentWindow||!f.contentDocument) return null;
        var w=f.contentWindow;
        return (function(){ ${expression} }).call(w);
      })()`
      const r = await cdp.send('Runtime.evaluate', {
        expression: wrapped,
        returnByValue: true,
        awaitPromise,
        contextId: rootCtx,
      })
      if (r.exceptionDetails) {
        throw new Error(
          '模块帧执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text),
        )
      }
      if (r.result.value !== null && r.result.value !== undefined) return r.result.value
    } catch (e) {
      const msg = String(e.message)
      if (/Cannot find context|Execution context was destroyed/i.test(msg)) {
        /* 上下文没了：下一轮再找 */
      } else if (/CDP 超时|closed|ECONN|Invalid frame/i.test(msg)) {
        // 连接废了（面板帧被换掉了）：重新接一次
        await connectPanel()
      } else {
        throw e
      }
    }
    await sleep(500)
  }
  return null
}

/** 模块帧里那张预览卡长什么样 */
async function readHandoffCard() {
  return moduleEval(
    `(function(){
      const host=document.getElementById('tj-handoff');
      if(!host) return {missing:true};
      const rows=[...host.querySelectorAll('.pv-row')].map(r=>({
        title:(r.querySelector('.pv-title')||{}).textContent||'',
        meta:(r.querySelector('.pv-meta')||{}).textContent||'',
      }));
      return {
        hidden:host.classList.contains('hidden'),
        text:(host.textContent||'').replace(/\\s+/g,' ').trim(),
        rows:rows,
        hasAccept:!![...host.querySelectorAll('button')].find(b=>(b.textContent||'').includes('落进主线')),
        hasDismiss:!![...host.querySelectorAll('button')].find(b=>(b.textContent||'').includes('先不放')),
      };
    })()`,
    false,
  )
}

/* ───────────────────────────────── 主流程 ───────────────────────────────── */

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
  trackContexts(wsCdp)
  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;if(w.isMinimized())w.restore();w.show();w.setContentSize(1600,950);w.moveTop();w.focus()}return 'ok'})()`,
  )
  await sleep(1800)

  const installed = await installFixtures()
  check('假模型清单与开场 handler 装进主进程', installed === 'installed', { installed })

  // 清单是渲染层挂载时读的，得让页面重载一次才拿到
  await mainEval(`(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(!w.isDestroyed())w.reload()}return 'reloaded'})()`)
  await sleep(2600)
  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(!w.isDestroyed())continue;w.show();w.setContentSize(1600,950);w.focus()}return 'ok'})()`,
  )
  await sleep(800)

  // 首次引导会挡住开场页，先把它收掉
  await clickByText('.start-intro-foot button', /知道了|不再显示|开始/)
  await sleep(500)

  const modelsLoaded = await evalJs(
    `(function(){const s=window.__torraStore;if(!s)return 0;return s.getState().models.length})()`,
    false,
  )
  check('渲染层拿到假模型清单', modelsLoaded === 3, { modelsLoaded })

  // 落座两位，再开场
  const seated = await evalJs(
    `(function(){
      const s=window.__torraStore;
      if(!s) return {err:'no-store'};
      const st=s.getState();
      const hasAction=typeof st.toggleParticipant==='function';
      if(hasAction){ st.toggleParticipant('chatgpt'); st.toggleParticipant('claude'); }
      if(s.getState().participantIds.length<2) s.setState({participantIds:['chatgpt','claude']});
      return {hasAction,final:s.getState().participantIds.join(',')};
    })()`,
    false,
  )
  check('两位模型落座', /chatgpt/.test(String(seated.final)) && /claude/.test(String(seated.final)), { seated })

  const started = await evalJs(
    `(function(){
      const el=document.querySelector('.ns-topic');
      if(!el) return 'no-topic';
      const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set;
      setter.call(el,'评估为报表系统引入实时计算层的必要性');
      el.dispatchEvent(new Event('input',{bubbles:true}));
      const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='开始讨论');
      if(!btn) return 'no-start-button';
      if(btn.disabled) return 'start-disabled';
      btn.click();
      return 'clicked';
    })()`,
    false,
  )
  check('点得到「开始讨论」', started === 'clicked', { started })
  await sleep(1600)

  // ── 灌事件：发言 → 主持小结 → 收尾 ──
  await pushEvents(EVENTS)
  await sleep(500)
  await pushEvents([{ type: 'done', reason: 'converged' }])
  await sleep(700)

  const finish = await evalJs(
    `(function(){
      const n=document.querySelector('.te-finish');
      if(!n) return null;
      const btn=[...n.querySelectorAll('button')].find(b=>(b.textContent||'').includes('落到研究主线'));
      return {
        text:(n.textContent||'').replace(/\\s+/g,' ').trim(),
        handoff: btn ? (btn.textContent||'').trim() : '',
        hasHandoff: !!btn,
      };
    })()`,
    false,
  )
  check('收尾块出现', !!finish, { finish })
  check('收尾处有「落到研究主线」这一下', !!finish && finish.hasHandoff, { handoff: finish?.handoff })

  // ── 工作台没启用：要说清缺什么，还要给出去设置的路 ──
  const pluginState = await evalJs(
    `(async function(){
      const r=await window.torra.pluginsList();
      const hit=(r.plugins||[]).find(p=>p.id==='research');
      return hit?{enabled:hit.enabled,status:hit.status}:null;
    })()`,
  )
  check('内置的研究工作台默认是关着的', !!pluginState && pluginState.enabled === false, { pluginState })

  const clickedBlocked = await evalJs(
    `(function(){
      const n=document.querySelector('.te-finish');
      const btn=[...n.querySelectorAll('button')].find(b=>(b.textContent||'').includes('落到研究主线'));
      if(!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()`,
    false,
  )
  check('没启用时这一下也点得动（不闷掉）', clickedBlocked === 'clicked', { clickedBlocked })
  await sleep(700)

  const blockedNote = await evalJs(
    `(function(){
      const note=document.querySelector('.te-handoff-note');
      if(!note) return null;
      const link=note.querySelector('button');
      return { text:(note.textContent||'').replace(/\\s+/g,' ').trim(), warn:note.classList.contains('warn'), link: link?(link.textContent||'').trim():'' };
    })()`,
    false,
  )
  check('没启用时说清「研究工作台还没启用」', !!blockedNote && /研究工作台还没启用/.test(blockedNote.text), { note: blockedNote?.text })
  check('给了去设置的路', !!blockedNote && blockedNote.link.includes('去设置'), { link: blockedNote?.link })

  const stillOff = await evalJs(
    `(async function(){
      const r=await window.torra.pluginsList();
      const hit=(r.plugins||[]).find(p=>p.id==='research');
      return hit?hit.enabled:null;
    })()`,
  )
  check('没有替用户偷偷启用插件', stillOff === false, { stillOff })

  const onSettings = await evalJs(
    `(function(){
      const note=document.querySelector('.te-handoff-note');
      const link=note && note.querySelector('button');
      if(!link) return 'no-link';
      link.click();
      return 'clicked';
    })()`,
    false,
  )
  check('「去设置」跳得过去', onSettings === 'clicked', { onSettings })
  await sleep(800)
  const onSettingsPage = await evalJs(
    `(function(){return !!document.querySelector('.st-root')})()`,
    false,
  )
  check('跳到了设置页', onSettingsPage === true, { onSettingsPage })
  await shot('handoff-blocked-settings')

  // ── 启用工作台，回到研讨收尾处再点一次 ──
  const enabled = await evalJs(
    `(async function(){
      const r=await window.torra.pluginsSetEnabled('research',true);
      return r&&r.ok;
    })()`,
  )
  check('研究工作台启用成功', enabled === true, { enabled })

  // 等插件进程真的起来：面板拿不到数据的话，预览卡不会出现
  let ready = false
  for (let i = 0; i < 40; i++) {
    const st = await evalJs(
      `(async function(){
        const r=await window.torra.pluginsList();
        const hit=(r.plugins||[]).find(p=>p.id==='research');
        return hit?{enabled:hit.enabled,status:hit.status,error:hit.error||''}:null;
      })()`,
    )
    if (st && st.enabled && st.status === 'ready') { ready = true; break }
    await sleep(500)
  }
  check('插件进程就绪', ready, {})

  // 渲染层的清单也得跟着变：启用发生在设置页之外（这里是直接调 IPC），
  // 清单要是不刷新，界面会一直说「还没启用」而插件其实已经开了。
  let navHasResearch = false
  for (let i = 0; i < 20; i++) {
    navHasResearch = await evalJs(
      `(function(){
        const navs=[...document.querySelectorAll('.app-nav-item')];
        return navs.some(n=>(n.getAttribute('aria-label')||'')==='科研工作台');
      })()`,
      false,
    )
    if (navHasResearch) break
    await sleep(500)
  }
  check('渲染层知道插件开了（顶栏多了入口）', navHasResearch === true, { navHasResearch })

  // 回研讨屏
  await evalJs(
    `(function(){
      const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'')==='设置');
      if(b) b.click();
      return 'ok';
    })()`,
    false,
  )
  await sleep(600)
  const backToDiscuss = await evalJs(
    `(function(){
      const navs=[...document.querySelectorAll('.app-nav-item')];
      const t=navs.find(n=>(n.getAttribute('aria-label')||'').includes('研讨'));
      if(!t) return 'no-nav';
      t.click();
      return 'clicked';
    })()`,
    false,
  )
  check('回到研讨屏', backToDiscuss === 'clicked', { backToDiscuss })
  await sleep(900)

  const clicked = await evalJs(
    `(function(){
      const n=document.querySelector('.te-finish');
      if(!n) return 'no-finish';
      const btn=[...n.querySelectorAll('button')].find(b=>(b.textContent||'').includes('落到研究主线'));
      if(!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()`,
    false,
  )
  check('启用之后这一下点得动', clicked === 'clicked', { clicked })
  await sleep(1200)

  const sentNote = await evalJs(
    `(function(){
      const note=document.querySelector('.te-handoff-note');
      return note?(note.textContent||'').replace(/\\s+/g,' ').trim():'';
    })()`,
    false,
  )
  // 送到的时候应用直接把人带到工作台屏，研讨屏上那行回话随屏一起走了 ——
  // 所以这里验的是「人到了哪儿」，不是那一行字。
  const navState = await evalJs(
    `(function(){
      const navs=[...document.querySelectorAll('.app-nav-item')];
      const t=navs.find(n=>(n.getAttribute('aria-label')||'')==='科研工作台');
      return t?{found:true,selected:t.getAttribute('aria-selected')==='true'}:{found:false};
    })()`,
    false,
  )
  check('顶栏把「科研工作台」标成了当前屏', navState.found && navState.selected, { navState })

  const onPluginScreen = await evalJs(
    `(function(){return !!document.querySelector('.plugin-page, iframe.plugin-frame')})()`,
    false,
  )
  check('应用切到了插件屏', onPluginScreen === true, { onPluginScreen })

  // ── 面板帧：交接稿要真的送进去，预览卡要真的出现 ──
  const panelTarget = await findPanelTarget()
  if (panelTarget) {
    wsPanelCdp = await connect(panelTarget.webSocketDebuggerUrl)
    await wsPanelCdp.send('Runtime.enable')
    await wsPanelCdp.send('Page.enable')
    trackContexts(wsPanelCdp)
    check('插件面板帧是独立目标（可以直接验它的界面）', true, { url: String(panelTarget.url).slice(0, 48) })
  } else {
    check('插件面板帧是独立目标（可以直接验它的界面）', true, { note: '不是独立目标，改从页面目标里找模块帧' })
  }
  let card = null
  for (let i = 0; i < 40; i++) {
    card = await readHandoffCard()
    if (card && !card.missing && card.rows && card.rows.length) break
    await sleep(500)
  }
  check('预览卡真的出现了', !!card && !card.missing && card.rows.length > 0, { card: card ? { text: String(card.text).slice(0, 160), rows: card.rows.length } : null })
  if (card && !card.missing) {
    check('预览卡里有「落进主线」和「先不放」', !!card.hasAccept && !!card.hasDismiss, { hasAccept: card.hasAccept, hasDismiss: card.hasDismiss })
    const cardText = String(card.text || '')
    check('预览卡里写着议题', /实时计算层/.test(cardText), { text: cardText.slice(0, 120) })
    check('预览卡里认账的结论在', /P95 延迟是当前核心瓶颈/.test(cardText), { text: cardText.slice(0, 200) })
    check('预览卡里没谈完的分歧也在', /是否需要双写对账层/.test(cardText), { text: cardText.slice(0, 240) })
  }
  await shot('handoff-preview')

  // ── 还没点头：主线里不该先长出节点 ──
  // 「结果先预览，用户确认后才写入」是插件层的规矩，不守的话用户只是看了一眼就改了本地的库。
  const beforeAccept = await evalJs(
    `(async function(){
      const p=await window.torra.pluginsPanel('research','dark');
      if(!p.ok) return {err:p.reason||'panel-not-open'};
      const list=await window.torra.pluginsInvoke(p.token,'trajectory.project.list',{});
      if(!list.ok) return {err:list.error||'list-failed'};
      const projects=(list.value&&list.value.projects)||[];
      let nodeTotal=0;
      for(const proj of projects){
        const get=await window.torra.pluginsInvoke(p.token,'trajectory.project.get',{projectId:proj.id});
        if(get.ok) nodeTotal+=((get.value&&get.value.nodes)||[]).length;
      }
      return {projects:projects.length,nodeTotal};
    })()`,
  )
  check(
    '还没点「落进主线」，主线里一条节点都没写',
    beforeAccept && beforeAccept.nodeTotal === 0,
    { beforeAccept },
  )

  // ── 点「落进主线」 ──
  const acceptClicked = await moduleEval(
    `(function(){
      const host=document.getElementById('tj-handoff');
      if(!host) return 'no-host';
      const b=[...host.querySelectorAll('button')].find(x=>(x.textContent||'').includes('落进主线'));
      if(!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`,
    false,
  )
  check('点得到「落进主线」', acceptClicked === 'clicked', { acceptClicked })

  // ── 读回来：节点真的建出来了 ──
  let readback = null
  for (let i = 0; i < 40; i++) {
    readback = await evalJs(
      `(async function(){
        const p=await window.torra.pluginsPanel('research','dark');
        if(!p.ok) return {err:p.reason||'panel-not-open'};
        const list=await window.torra.pluginsInvoke(p.token,'trajectory.project.list',{});
        if(!list.ok) return {err:list.error||'list-failed'};
        const projects=(list.value&&list.value.projects)||[];
        if(!projects.length) return {projects:[]};
        const get=await window.torra.pluginsInvoke(p.token,'trajectory.project.get',{projectId:projects[0].id});
        if(!get.ok) return {err:get.error||'get-failed'};
        const v=get.value||{};
        return {
          projects:projects.map(x=>({id:x.id,title:x.title,nodeCount:x.nodeCount})),
          nodes:(v.nodes||[]).map(n=>({id:n.id,title:n.title,kind:n.kind,status:n.status,note:n.note,parents:n.parents})),
        };
      })()`,
    )
    if (readback && readback.nodes && readback.nodes.length) break
    await sleep(500)
  }
  check('主线里读回了节点', !!readback && !!readback.nodes && readback.nodes.length >= 3, {
    nodes: readback?.nodes?.length,
    err: readback?.err,
  })
  if (readback && readback.nodes) {
    const kinds = readback.nodes.map((n) => n.kind)
    check('议题落成了根节点（question）', kinds.includes('question'), { kinds })
    check('认账的结论落成了结论节点（conclusion）', kinds.includes('conclusion'), { kinds })
    check('没谈完的分歧落成了待办的判断节点（claim/open）', readback.nodes.some((n) => n.kind === 'claim' && n.status === 'open'), {
      nodes: readback.nodes.map((n) => ({ kind: n.kind, status: n.status, title: n.title })),
    })
    check('结论的备注里写着谁支持', readback.nodes.some((n) => n.kind === 'conclusion' && /支持：ChatGPT、Claude/.test(n.note || '')), {
      note: readback.nodes.find((n) => n.kind === 'conclusion')?.note,
    })
    check('分歧的备注里留着各方的说法', readback.nodes.some((n) => n.kind === 'claim' && /ChatGPT：不需要/.test(n.note || '')), {
      note: readback.nodes.find((n) => n.kind === 'claim')?.note,
    })
    check('结论挂在议题根下面（主线是一棵树，不是散点）', readback.nodes.some((n) => n.kind === 'conclusion' && n.parents.length === 1), {
      nodes: readback.nodes.map((n) => ({ kind: n.kind, parents: n.parents })),
    })
  }

  const resultText = await moduleEval(
    `(function(){
      const host=document.getElementById('tj-handoff');
      if(!host) return '';
      const res=host.querySelector('.ho-result');
      return res?(res.textContent||'').replace(/\\s+/g,' ').trim():'';
    })()`,
    false,
  )
  check('面板里说清楚写进去几条', /落进主线/.test(String(resultText)), { result: resultText })
  await shot('handoff-done')

  // ── 来回切屏不会把同一场结论再灌一遍 ──
  // 交接稿送出去就要清掉：不清的话，用户从工作台切回研讨再切回来，
  // 面板会把同一场结论重新摆一次，看着像「又来了一遍」。
  await evalJs(
    `(function(){
      const navs=[...document.querySelectorAll('.app-nav-item')];
      const t=navs.find(n=>(n.getAttribute('aria-label')||'').includes('研讨'));
      if(t) t.click();
      return 'ok';
    })()`,
    false,
  )
  await sleep(900)
  await evalJs(
    `(function(){
      const navs=[...document.querySelectorAll('.app-nav-item')];
      const t=navs.find(n=>(n.getAttribute('aria-label')||'')==='科研工作台');
      if(t) t.click();
      return 'ok';
    })()`,
    false,
  )
  await sleep(1400)
  // 回到工作台后外壳停在概览屏，主线模块那一帧还没挂上；
  // 把它切出来，才谈得上看没又摆一次预览卡。
  const tabClicked = await shellEval(
    `(function(){
      const b=document.querySelector('.nav-item[data-view="trajectory"]');
      if(!b) return 'no-tab';
      b.click();
      return 'clicked';
    })()`,
  )
  check('切到「研究主线」那一屏', tabClicked === 'clicked', { tabClicked })
  await sleep(1200)

  const afterSwitch = await evalJs(
    `(async function(){
      const p=await window.torra.pluginsPanel('research','dark');
      if(!p.ok) return {err:p.reason||'panel-not-open'};
      const list=await window.torra.pluginsInvoke(p.token,'trajectory.project.list',{});
      if(!list.ok) return {err:list.error||'list-failed'};
      const projects=(list.value&&list.value.projects)||[];
      let nodeTotal=0;
      for(const proj of projects){
        const get=await window.torra.pluginsInvoke(p.token,'trajectory.project.get',{projectId:proj.id});
        if(get.ok) nodeTotal+=((get.value&&get.value.nodes)||[]).length;
      }
      return {projects:projects.length,nodeTotal};
    })()`,
  )
  check('来回切屏之后主线里的节点没有变多', afterSwitch && afterSwitch.nodeTotal === 3, { afterSwitch })

  const cardAgain = await moduleEval(
    `(function(){
      const host=document.getElementById('tj-handoff');
      if(!host) return {missing:true};
      return {
        missing:false,
        hidden:host.classList.contains('hidden'),
        rows:host.querySelectorAll('.pv-row').length,
        text:(host.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120),
      };
    })()`,
    false,
  )
  check(
    '来回切屏之后没有再摆一次预览卡',
    !cardAgain || cardAgain.missing || (cardAgain.rows || []).length === 0,
    { cardAgain },
  )

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
