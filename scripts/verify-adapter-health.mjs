// 运行时验证：设置页里的「适配器体检」面板。
//
// 这一块的风险不在代码，在「主进程返回的形状有没有被界面如实翻译」：
// adapters:list 的 health 有五种取值（ok / selector-missing / login-required /
// entry-unreachable / unknown），其中 unknown 不是故障而是「没测过」——
// 界面把这两类混成一种红，就等于骗人。所以这里盯三件事：
//
//   1. 五种状态各自的措辞都在，且「没体检」与「有问题」分得开；
//   2. 重测的结果就地写回那一行，而不是重画整页；
//   3. 深浅两套主题都成立 —— 这一块是浅底卡片，阴影/描边一旦只写深色，切回白天就塌了。
//
// 用一份全新的临时 userData 启动，只管理本脚本 spawn 的 electron 进程，用完连目录一起删。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'adapter-health')
const PORT = await freePort(9481)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-adapter-'))

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
 * 往主进程里塞一份假适配器清单。
 * 清单覆盖五种 health 各一条，外加一条过期、一条用户自建、一条带 tos 提示与 lastError 的。
 */
const FIXTURE = JSON.stringify([
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    health: 'ok',
    verifiedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    stale: false,
    origin: 'builtin',
    entry: 'https://chatgpt.com',
    selectors: { input: '#prompt-textarea', send: 'button[data-testid=send-message]' },
  },
  {
    id: 'claude',
    name: 'Claude',
    health: 'selector-missing',
    verifiedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    stale: false,
    origin: 'builtin',
    entry: 'https://claude.ai',
    lastError: '回复容器没命中：.font-claude-message 已被改版',
    selectors: { input: 'div[contenteditable=true]', reply: '.font-claude-message' },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    health: 'login-required',
    verifiedAt: new Date(Date.now() - 41 * 86_400_000).toISOString(),
    stale: true,
    origin: 'builtin',
    entry: 'https://gemini.google.com',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    health: 'entry-unreachable',
    verifiedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    stale: true,
    origin: 'builtin',
    entry: 'https://chat.deepseek.com',
    tosNotice: '该站点对自动化访问有额外限制，请自行确认是否合规。',
  },
  {
    id: 'my-site',
    name: '我自己的站点',
    health: 'unknown',
    verifiedAt: '',
    stale: false,
    origin: 'user',
    entry: 'https://example.com',
  },
])

/** 主进程侧的假 handler：重测时按 id 回不同的结论 */
async function installFixtures() {
  const src = `
(function(){
  const { ipcMain } = require('electron');
  const list = ${FIXTURE};
  const checks = {
    chatgpt: { ok: true, health: 'ok' },
    claude: { ok: false, health: 'selector-missing', reason: 'reply 选择器未命中' },
    gemini: { ok: false, health: 'login-required', reason: '需要登录' },
    deepseek: { ok: false, health: 'entry-unreachable', reason: '入口不可达' },
    'my-site': { ok: false, reason: 'no model bound' },
  };
  for (const ch of ['adapters:list', 'adapters:check']) { try { ipcMain.removeHandler(ch) } catch (e) {} }
  ipcMain.handle('adapters:list', () => list);
  ipcMain.handle('adapters:check', (_e, id) => checks[id] || { ok: false, reason: '未知适配器' });
  return 'installed';
})()`
  return mainEval(src)
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
  // 首次引导会挡住设置页，先把它收掉
  await clickByText('.start-intro-foot button', /知道了|不再显示/)
  await sleep(400)

  const installed = await installFixtures()
  check('假适配器清单装进主进程', installed === 'installed', { installed })

  // ── 进设置页 → 模型管理 ──
  const wentSettings = await clickByText('.app-nav-item', /设置/)
  await sleep(1200)
  check('点导航能进设置页', wentSettings)
  const wentModels = await clickByText('.st-nav-item', /模型管理/)
  await sleep(900)
  check('能切到模型管理这一屏', wentModels)

  // ── 面板出现 ──
  let panel = null
  for (let i = 0; i < 20; i++) {
    panel = await evalJs(
      `(function(){const el=document.querySelector('[data-testid="adapter-health"]');if(!el)return null;el.scrollIntoView({block:'center'});return true})()`,
      false,
    )
    if (panel) break
    await sleep(300)
  }
  check('适配器体检面板出现', !!panel)
  await sleep(500)

  const read = await evalJs(
    `(function(){
      const cs=(el)=>getComputedStyle(el);
      const cards=[...document.querySelectorAll('[data-testid="adapter-health"] .ah-card')];
      const tally=document.querySelector('.ah-tally');
      return {
        n: cards.length,
        ids: cards.map(c=>c.getAttribute('data-adapter-id')),
        pills: cards.map(c=>{const p=c.querySelector('.ah-pill');return p?{text:(p.textContent||'').trim(),tone:p.className}:null}),
        stale: cards.map(c=>!!c.querySelector('.ah-stale')),
        tos: cards.filter(c=>c.querySelector('.ah-tos')).length,
        err: cards.filter(c=>c.querySelector('.ah-err')).length,
        tally: tally?(tally.textContent||'').trim():'',
        hasSelectorsBtn: cards.filter(c=>c.querySelector('.ah-sel-toggle')).length,
        noSelNote: cards.filter(c=>c.querySelector('.ah-no-sel')).length,
        // 卡片得是「圆角 + 浮起阴影」里的一种，不能边框阴影双份
        cardStyle: cards[0]?{radius:cs(cards[0]).borderTopLeftRadius,shadow:cs(cards[0]).boxShadow,border:cs(cards[0]).borderTopWidth}:null,
        theme: document.documentElement.dataset.theme,
      };
    })()`,
    false,
  )
  check('五个适配器各一张卡', read.n === 5, { n: read.n, ids: read.ids })
  const words = read.pills.map((p) => (p ? p.text : ''))
  check('五种健康状态各有自己的措辞', ['正常', '选择器失效', '需要登录', '站点打不开', '未体检'].every((w) => words.includes(w)), { words })
  check('「未体检」不算故障（tone 是 idle）', read.pills.some((p) => p && /idle/.test(p.tone) && p.text === '未体检'), {
    pills: read.pills,
  })
  check('过期标记落在过期那两张上', read.stale.filter(Boolean).length === 2, { stale: read.stale })
  check('服务条款提示与最近错误都露出来', read.tos === 1 && read.err === 1, { tos: read.tos, err: read.err })
  check('计数条与实际张数对得上', /共 5 个/.test(read.tally), { tally: read.tally })
  check(
    '声明了选择器的给「展开选择器」，没声明的说清没有',
    read.hasSelectorsBtn === 2 && read.noSelNote === 3,
    { hasSelectorsBtn: read.hasSelectorsBtn, noSelNote: read.noSelNote },
  )
  check('卡片圆角不为 0', read.cardStyle && parseFloat(read.cardStyle.radius) > 0, read.cardStyle)
  await shot('adapter-health-dark')

  // ── 重测：结果就地写回那一行 ──
  const clicked = await evalJs(
    `(function(){const card=document.querySelector('[data-adapter-id="claude"]');if(!card)return false;const b=[...card.querySelectorAll('button')].find(x=>/重测/.test(x.textContent||''));if(!b)return false;b.click();return true})()`,
    false,
  )
  await sleep(1500)
  check('点得到那一行的重测', clicked)
  const note = await evalJs(
    `(function(){const card=document.querySelector('[data-adapter-id="claude"]');const n=card&&card.querySelector('.ah-note');return n?(n.textContent||'').trim():''})()`,
    false,
  )
  check('重测结论就地写回那一行', /没通过/.test(note) && /选择器失效/.test(note), { note })

  const noModel = await evalJs(
    `(function(){
       const card=document.querySelector('[data-adapter-id="my-site"]');
       if(!card) return '';
       const b=[...card.querySelectorAll('button')].find(x=>/重测/.test(x.textContent||''));
       if(b) b.click();
       return 'clicked';
     })()`,
    false,
  )
  await sleep(1500)
  const noModelNote = await evalJs(
    `(function(){const card=document.querySelector('[data-adapter-id="my-site"]');const n=card&&card.querySelector('.ah-note');return n?(n.textContent||'').trim():''})()`,
    false,
  )
  check('没绑模型与「坏了」分开说', /没绑模型/.test(noModelNote), { noModel, noModelNote })

  // ── 选择器展开 ──
  await evalJs(
    `(function(){const card=document.querySelector('[data-adapter-id="chatgpt"]');const b=card&&card.querySelector('.ah-sel-toggle');if(b)b.click();return !!b})()`,
    false,
  )
  await sleep(500)
  const sel = await evalJs(
    `(function(){const card=document.querySelector('[data-adapter-id="chatgpt"]');const w=card&&card.querySelector('.ah-sel-wrap');if(!w)return null;const code=card.querySelector('.ah-sel-code');const r=w.getBoundingClientRect();return {open:w.classList.contains('open'),h:Math.round(r.height),code:code?(code.textContent||'').trim():''}})()`,
    false,
  )
  check('选择器展开后确实露出代码', sel && sel.open && sel.h > 0 && sel.code.length > 0, sel)
  await shot('adapter-health-selectors-dark')

  // ── 筛选 ──
  await clickByText('.ah-filter-item', /有问题/)
  await sleep(500)
  const filtered = await evalJs(
    `(function(){const cards=[...document.querySelectorAll('[data-testid="adapter-health"] .ah-card')];return cards.map(c=>c.getAttribute('data-adapter-id'))})()`,
    false,
  )
  check(
    '「有问题」只留下坏的那几张，且不含未体检的',
    filtered.length === 3 && !filtered.includes('my-site') && !filtered.includes('chatgpt'),
    { filtered },
  )
  await clickByText('.ah-filter-item', /^全部/)
  await sleep(400)

  // ── 浅色 ──
  await evalJs(
    `(function(){const b=document.querySelector('.theme-toggle');if(b){b.click();return true}return false})()`,
    false,
  )
  await sleep(1200)
  const light = await evalJs(
    `(function(){const el=document.querySelector('[data-testid="adapter-health"] .ah-card');if(!el)return null;const cs=getComputedStyle(el);return {theme:document.documentElement.dataset.theme,radius:cs.borderTopLeftRadius,shadow:cs.boxShadow,color:cs.color,bg:cs.backgroundColor}})()`,
    false,
  )
  check('切到白天主题后面板还在', light && light.theme === 'light', light)
  check('浅色下卡片仍有圆角与阴影', light && parseFloat(light.radius) > 0 && light.shadow !== 'none', light)
  await shot('adapter-health-light')

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
