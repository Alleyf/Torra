// 诊断脚本：研讨屏「锁定一条发言」之后的 DOM 实况。
//
// 为什么单独写一个：smoke 里那两条断言（聚焦没给全文、指针旁边还铺着一份全文）
// 只说了「不对」，没说是哪儿不对。这里把锁定那一刻的 DOM 原样掏出来，
// 让人眼能判：全文到底铺在哪一份、右栏那一节到底装了什么。
//
// 不是回归脚本：它只打印，不判对错。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'probe-discuss-lock')
const PORT = await freePort(9601)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-probe-lock-'))

let wsCdp = null
let wsMainCdp = null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  throw new Error(kind === 'page' ? '未找到渲染层页面目标' : '未找到主进程调试目标')
}

async function connect(url) {
  const sock = new WebSocket(url)
  await new Promise((res, rej) => {
    sock.addEventListener('open', res)
    sock.addEventListener('error', rej)
  })
  return cdpClient(sock)
}

async function evalJs(expression, awaitPromise = false) {
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
  try {
    const r = await wsCdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false }, 20000)
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  } catch (e) {
    console.log('（截图没成功：' + e.message + '）')
  }
}

const MODELS = [
  { id: 'chatgpt', displayName: 'ChatGPT', transport: 'webview', domain: 'chatgpt.com', color: '#5aa9e6', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'claude', displayName: 'Claude', transport: 'webview', domain: 'claude.ai', color: '#d97757', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'deepseek', displayName: 'DeepSeek', transport: 'api', color: '#4d6bfe', enabled: true, supportsStructuredOutput: true, adapterHealth: 'unknown', adapterStale: false, hasKey: true, status: 'ready' },
]

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

const pad = (n) => `第 3 轮补充 ${n}：` + '这一段要有足够长度才能把跟随条撑出滚动条，用它模拟真实发言的篇幅。'.repeat(7)

async function main() {
  const child = spawn(
    electronBin,
    [`--inspect=${INSPECT_PORT}`, ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|Debugger listening|GPU|gpu|Warning|deprecat/i.test(s)) console.log('[app:err] ' + s)
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

  console.log('fixture:', await installFixtures())
  await mainEval(`(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(!w.isDestroyed())w.reload()}return 'reloaded'})()`)
  await sleep(2600)
  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;w.show();w.setContentSize(1600,950);w.focus()}return 'ok'})()`,
  )
  await sleep(800)

  await evalJs(`(function(){const b=[...document.querySelectorAll('.start-intro-foot button')].find(x=>/知道了|不再显示|开始/.test(x.textContent||''));if(b)b.click();return true})()`)
  await sleep(400)

  await evalJs(
    `(function(){const s=window.__torraStore;if(!s)return 'no-store';s.getState().toggleParticipant('chatgpt');s.getState().toggleParticipant('claude');if(s.getState().participantIds.length<2)s.setState({participantIds:['chatgpt','claude']});return s.getState().participantIds.join(',')})()`,
  )
  await evalJs(
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
  )
  await sleep(1600)

  // 灌发言
  const events = [
    { type: 'state', state: 'AGENT_BATCH', round: 3 },
    ...Array.from({ length: 6 }, (_, i) => ({
      type: 'utterance-done',
      utterance: {
        id: `uf${i}`,
        round: 3,
        agentId: i % 2 ? 'claude' : 'chatgpt',
        content: pad(i),
        targets: [],
        usage: { promptTokens: 0, completionTokens: 120, costUsd: 0.02 },
      },
    })),
  ]
  await evalJs(
    `(function(){const s=window.__torraStore;for(const e of ${JSON.stringify(events)})s.getState().applyEvent(e);return 'ok'})()`,
  )
  await sleep(700)

  const before = await evalJs(
    `(function(){
      const follow=document.querySelector('.te-follow');
      return {
        followHtml: follow ? follow.innerHTML.slice(0, 1200) : null,
        uttCardsInFollow: document.querySelectorAll('.te-follow .te-card.te-utt').length,
        pinInFollow: document.querySelectorAll('.te-follow .te-card.te-utt-pin').length,
        speech: (document.querySelector('.rb-speech')?.textContent || '').slice(0, 200),
        speechLen: (document.querySelector('.rb-speech')?.textContent || '').length,
      };
    })()`,
  )
  console.log('\n=== 锁定前 ===')
  console.log(JSON.stringify(before, null, 2))

  // 点图上的节点 = 锁定那一条
  await evalJs(
    `(function(){
      const ico=[...document.querySelectorAll('.te-ico')].filter(x=>!x.classList.contains('te-lane-ico'));
      const el=ico[1]||ico[0];
      if(!el) return 'no-ico';
      el.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      return 'clicked';
    })()`,
  )
  // smoke 读的是点完 200ms 之后的 DOM：那个时刻 React 可能还没重画完。
  // 这里按 200 / 700 两个时点各读一次，两次都读，才能判断是「慢」还是「错」。
  for (const wait of [200, 700]) {
    await sleep(wait === 200 ? 200 : 500)
    const snap = await evalJs(
      `(function(){
        const follow=document.querySelector('.te-follow');
        const speech=document.querySelector('.rb-speech');
        return {
          at: ${wait},
          followCount: document.querySelectorAll('.te-follow').length,
          followChildren: follow ? [...follow.children].map(c=>c.className) : null,
          uttCardsInFollow: document.querySelectorAll('.te-follow .te-card.te-utt').length,
          pinInFollow: document.querySelectorAll('.te-follow .te-card.te-utt-pin').length,
          uttCardsAnywhere: document.querySelectorAll('.te-card.te-utt').length,
          speechLen: speech ? (speech.textContent||'').length : 0,
          speechHead: speech ? (speech.textContent||'').slice(0, 80) : null,
        };
      })()`,
    )
    console.log('\n=== 锁定后 ' + wait + 'ms ===')
    console.log(JSON.stringify(snap, null, 2))
  }

  const after = await evalJs(
    `(function(){
      const follow=document.querySelector('.te-follow');
      const speech=document.querySelector('.rb-speech');
      return {
        label: document.querySelector('.te-follow-label')?.textContent ?? null,
        followHtml: follow ? follow.innerHTML.slice(0, 2500) : null,
        uttCardsInFollow: document.querySelectorAll('.te-follow .te-card.te-utt').length,
        pinInFollow: document.querySelectorAll('.te-follow .te-card.te-utt-pin').length,
        uttCardsAnywhere: document.querySelectorAll('.te-card.te-utt').length,
        speechText: speech ? (speech.textContent||'').slice(0, 400) : null,
        speechLen: speech ? (speech.textContent||'').length : 0,
      };
    })()`,
  )
  console.log('\n=== 锁定后（最终态） ===')
  console.log(JSON.stringify(after, null, 2))

  await shot('lock')

  child.kill()
}

main().catch((e) => {
  console.error('probe 失败：', e)
  process.exit(1)
})
