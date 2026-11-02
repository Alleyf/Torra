// 运行时验证：讨论收尾块（为什么停 · 这份结论怎么用 · 下一步）。
//
// 收尾这一块曾经只有一行「轮次跑满（无主持）」：为什么停用的是正文自造的词
// （报告和历史里都叫「轮次用尽」），而「这份结论是没谈完还是谈不拢」这句话
// 偏偏在最常见的那一场（跑满轮次）里一次都没出现 —— 用户看完只知道结束了，
// 不知道这份结论还能拿它做什么。
//
// 这里盯四件事：
//   1. 「为什么停」的词跟报告/历史/台账是同一个（轮次用尽），不是各说各的；
//   2. 「怎么用」那句真的在正文里，且没说反：分歧是没谈完，不是谈不拢；
//   3. 「下一步」说得出还剩什么 —— 没谈完的条数落在正文里，不是藏在右栏；
//   4. 结论拿得走：交接稿按钮点下去真的写进剪贴板（不是个摆设按钮）。
//
// 无主持那一支单独再走一遍：它换过一句话，最容易把「怎么用」整段顶掉。
// 深浅两套主题都出图。用一份全新的临时 userData 启动，只管理本脚本 spawn 的 electron 进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'finish-handoff')
const PORT = await freePort(9581)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-finish-'))

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

async function shot(name) {
  const r = await wsCdp.send('Page.captureScreenshot', { format: 'png' }, 60000)
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
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
        { claim: '是否需要双写对账层', sides: [{ agent_id: 'chatgpt', argument: '不需要，双写成本高于收益' }, { agent_id: 'claude', argument: '需要，否则数字无法对账' }] },
      ],
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

/** 收尾块的三行分别是什么 */
async function readFinish() {
  return evalJs(
    `(function(){
      const n=document.querySelector('.te-finish');
      if(!n) return null;
      const r=n.getBoundingClientRect();
      const head=n.querySelector('.te-finish-head');
      const hint=n.querySelector('.te-finish-hint');
      const next=n.querySelector('.te-finish-nexttext');
      const act=n.querySelector('.te-finish-act');
      const cs=getComputedStyle(n);
      return {
        text:(n.textContent||'').replace(/\\s+/g,' ').trim(),
        head:head?(head.textContent||'').replace(/\\s+/g,' ').trim():'',
        hint:hint?(hint.textContent||'').trim():'',
        next:next?(next.textContent||'').trim():'',
        act:act?(act.textContent||'').trim():'',
        rows:n.children.length,
        ok:n.classList.contains('ok'),
        inView:r.top<window.innerHeight&&r.bottom>0,
        theme:document.documentElement.dataset.theme,
        radius:cs.borderTopLeftRadius,
        shadow:cs.boxShadow,
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

  const installed = await installFixtures()
  check('假模型清单与开场 handler 装进主进程', installed === 'installed', { installed })

  // 清单是渲染层挂载时读的，得让页面重载一次才拿到
  await mainEval(`(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(!w.isDestroyed())w.reload()}return 'reloaded'})()`)
  await sleep(2600)
  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;w.show();w.setContentSize(1600,950);w.focus()}return 'ok'})()`,
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
      const before=st.participantIds.join(',');
      const hasAction=typeof st.toggleParticipant==='function';
      if(hasAction){ st.toggleParticipant('chatgpt'); st.toggleParticipant('claude'); }
      const afterAction=s.getState().participantIds.join(',');
      if(s.getState().participantIds.length<2) s.setState({participantIds:['chatgpt','claude']});
      return {before,hasAction,afterAction,final:s.getState().participantIds.join(',')};
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

  const inDiscuss = await evalJs(`(function(){return !!document.querySelector('.te-canvas, .te-body, .te-status')})()`, false)
  check('进了研讨屏', inDiscuss)

  // ── 灌事件：发言 → 主持小结 → 收尾 ──
  await pushEvents(EVENTS)
  await sleep(500)
  await pushEvents([{ type: 'done', reason: 'max-rounds' }])
  await sleep(700)

  const fin = await readFinish()
  check('收尾块在正文底部', !!fin, { fin })
  if (!fin) return

  check('第一行说清「为什么停」，用的是全应用统一的词', /轮次用尽/.test(fin.head) && !/轮次跑满/.test(fin.head), { head: fin.head })
  check('第二行说清「这份结论怎么用」', /没谈完/.test(fin.hint), { hint: fin.hint })
  check('第三行说得出还剩什么', /分歧/.test(fin.next) && /1/.test(fin.next), { next: fin.next })
  check('三行都在（标题 / 怎么用 / 下一步）', fin.rows === 3, { rows: fin.rows })
  check('收尾块挂在视口里（结束时人就在这一带）', fin.inView)
  check('交接稿按钮在', fin.act.includes('复制交接稿'), { act: fin.act })

  // 没谈完的分歧在场，右栏也该看得见 —— 收尾这句话得有底
  const disputeInLedger = await evalJs(
    `(function(){const d=[...document.querySelectorAll('.cs-dispute')];return d.length})()`,
    false,
  )
  check('那条分歧在台账里也画着', disputeInLedger >= 1, { disputeInLedger })

  // ── 交接稿：点下去要真的写进剪贴板 ──
  // 剪贴板要「文档有焦点」才肯写。CDP 驱动时窗口未必在前台，
  // 所以这里先把页面提到前面、再把剪贴板权限开给这个源 ——
  // 否则测的是「窗口没焦点时会不会失败」，而不是产品本身对不对。
  await wsCdp.send('Page.bringToFront').catch(() => {})
  for (const opts of [{ origin: 'file://', permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }, { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }]) {
    try {
      await wsCdp.send('Browser.grantPermissions', opts)
      break
    } catch (e) {
      /* file:// 的 origin 在 CDP 里可能不认，退回到「给默认上下文」 */
    }
  }
  const clicked = await evalJs(
    `(function(){const b=document.querySelector('.te-finish-act');if(!b)return false;b.click();return true})()`,
    false,
  )
  await sleep(600)
  const after = await evalJs(`(function(){const b=document.querySelector('.te-finish-act');return b?(b.textContent||'').trim():''})()`, false)
  check('点得了「复制交接稿」', clicked)
  check('剪贴板真的写进去了（按钮回话「已复制」）', after.includes('已复制'), { after })

  const clip = await evalJs(
    `(navigator.clipboard.readText ? navigator.clipboard.readText().then(t=>t).catch(()=>'') : '')`,
    true,
  )
  if (typeof clip === 'string' && clip.length) {
    check('交接稿里带着结束原因', /研讨结论/.test(clip) && /轮次用尽/.test(clip), { head: clip.slice(0, 120) })
    check('交接稿里带着没谈完的那条', /双写对账层/.test(clip), { tail: clip.slice(-200) })
  } else {
    check('剪贴板读得到内容（读不到就不判内容，只判按钮）', false, { clip })
  }

  await shot('finish-handoff-dark')

  // ── 无主持那一支：它换过一句话，最容易把「怎么用」顶掉 ──
  await evalJs(`(function(){window.__torraStore.setState({moderatorId:null});return 'ok'})()`, false)
  await sleep(300)
  await pushEvents([{ type: 'done', reason: 'max-rounds' }])
  await sleep(600)
  const noHost = await readFinish()
  check('无主持也照样说清为什么停（还是那个词）', !!noHost && /轮次用尽/.test(noHost.head), { head: noHost?.head })
  check('无主持也没有把「怎么用」顶掉', !!noHost && /没谈完/.test(noHost.hint), { hint: noHost?.hint })
  check('无主持时说的是「只有发言记录」这份事实', !!noHost && /发言记录/.test(noHost.next), { next: noHost?.next })
  await shot('finish-handoff-nohost-dark')

  // ── 浅色 ──
  await evalJs(
    `(function(){const b=document.querySelector('.theme-toggle');if(b){b.click();return true}return false})()`,
    false,
  )
  await sleep(1200)
  const light = await readFinish()
  check('切到白天主题后收尾块还在', !!light && light.theme === 'light', { theme: light?.theme })
  check('浅色下仍有圆角与浮起阴影', !!light && parseFloat(light.radius) > 0 && light.shadow !== 'none', {
    radius: light?.radius,
    shadow: light?.shadow,
  })
  await shot('finish-handoff-light')

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
