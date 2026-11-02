// 运行时验证：编码工作台上的两件「协议说了、界面没说」的事。
//
//   一、locations —— 协议说「这一步碰了哪些文件」，界面以前把它丢了，
//      于是只给路径、不给 diff 的那一步看起来像「什么都没改」。
//      这里盯的是：路径折到了步骤上、评审面板列得出这些文件、
//      而且它们被明确标成「只说了动过」，不是当成改动。
//   二、authMethods —— 协议报上来的登录方式，界面以前一句都没说。
//      这里盯的是：有就画出来（连说明一起），没有就整栏不画。
//
// 这两件最容易出的错是「把两件事说成一件」：把只给了路径的当改动报，
// 或者在协议没给登录方式的时候拿兜底文案顶上。所以断言都卡在这两处。
//
// 用一份全新的临时 userData 启动，只管理本脚本 spawn 的 electron 进程，用完连目录一起删。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'acp-grounding')
const PORT = await freePort(9483)
const INSPECT_PORT = await freePort(PORT + 1)
/**
 * 找一个没人占的端口。
 *
 * 往后挨个试，而不是死磕第一个：上一轮跑剩的进程还占着端口时，
 * 这一轮该换个端口继续，而不是整轮失败。
 */
async function freePort(from) {
  for (let p = from; p < from + 40; p++) {
    const got = await new Promise((resolve) => {
      const s = net.createServer()
      s.on('error', () => resolve(null))
      s.listen(p, '127.0.0.1', () => {
        const port = s.address().port
        s.close(() => resolve(port))
      })
    })
    if (got !== null) return got
  }
  throw new Error(`端口 ${from}~${from + 40} 都被占着`)
}
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-acp-grounding-'))

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
 * 主进程侧的假协议出口。
 *
 * 预检返回协商结果（authMethods 在里面），接上返回一份能用的能力，
 * 于是界面真的会走「预检 → 显示登录方式」与「接上 → 收事件」这两条路。
 */
const CAPS_BASE = {
  protocolVersion: 1,
  agentName: 'claude-code-acp',
  agentTitle: 'Claude Code',
  agentVersion: '2.1.312',
  loadSession: true,
  mcpHttp: true,
  mcpSse: false,
  sessionCapabilities: ['load'],
  promptCapabilities: [],
  selects: [],
}

const AUTH_METHODS = [
  { id: 'anthropic-api', name: 'Anthropic 账号或 API Key', description: '用订阅账号登录，或给一个 ANTHROPIC_API_KEY' },
  { id: 'oauth', name: '浏览器 OAuth', description: '在浏览器里授权一次，之后复用凭据' },
]

async function installFixtures(authMethods) {
  const src = `
(function(){
  const { ipcMain } = require('electron');
  const caps = ${JSON.stringify({ ...CAPS_BASE, authMethods })};
  const probe = { ok: true, agentId: 'claude', agentTitle: 'Claude Code', elapsedMs: 42, capabilities: caps };
  for (const ch of ['acp:probe', 'acp:start']) { try { ipcMain.removeHandler(ch) } catch (e) {} }
  ipcMain.handle('acp:probe', (_e, input) => {
    const id = (input && input.agentId) || 'claude';
    return { ...probe, agentId: id, capabilities: { ...caps, agentTitle: id } };
  });
  ipcMain.handle('acp:start', (_e, input) => {
    const id = (input && input.agentId) || 'claude';
    return { ok: true, agentId: id, sessionId: 'fake-session-1', capabilities: { ...caps, agentTitle: id } };
  });
  return 'installed';
})()`
  return mainEval(src)
}

/** 往渲染层推一条 Host 领域事件（跟主进程推的是同一种形状） */
async function pushAcp(event, agentId = 'claude') {
  return mainEval(
    `(function(){
      const { BrowserWindow } = require('electron');
      const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
      const win = wins.find(w => String(w.webContents.getURL()||'').includes('index.html')) || wins[0];
      if (!win) return 'no-window';
      win.webContents.send('acp:event', ${JSON.stringify({ agentId, event })});
      return 'sent';
    })()`,
  )
}

/** 点某一家那一行的预检按钮（不送话，只看协商结果） */
async function clickProbe() {
  return evalJs(
    `(function(){const a=document.querySelector('.agx-agent');const b=a&&a.querySelector('.agx-icon-btn.sm');if(!b)return false;b.click();return true})()`,
    false,
  )
}

/** 页内算对比度：把半透明底一路合成到不透明，再跟文字颜色比 */
const CONTRAST_HELPER = `
(function(){
  const parse = (c) => {
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  function bgOf(el) {
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      node = node.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    if (!layers.length) return base;
    let acc = layers[layers.length - 1];
    if (acc.a < 1) acc = over(acc, base);
    for (let i = layers.length - 2; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  }
  function ratio(el) {
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    const bg = bgOf(el);
    if (!fg) return null;
    const f = fg.a < 1 ? over(fg, bg) : fg;
    const l1 = lum(f), l2 = lum(bg);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  }
  window.__ratio = ratio;
  return 'ok';
})()`

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
  // 首次引导会挡住工作台，先把它收掉
  await clickByText('.start-intro-foot button', /知道了|不再显示/)
  await sleep(400)

  // ── 进编码工作台 ──
  const went = await evalJs(
    `(function(){const b=document.querySelector('.app-nav-item[aria-label="编码"]');if(!b)return false;b.click();return true})()`,
    false,
  )
  await sleep(1200)
  const onPage = await evalJs(`(function(){return {page:document.querySelectorAll('.agx').length, agents:document.querySelectorAll('.agx-agent').length}})()`, false)
  check('进到编码工作台', went && onPage.page === 1 && onPage.agents > 0, onPage)

  // ── 一、登录方式 ──
  const installed = await installFixtures(AUTH_METHODS)
  check('假协议出口装进主进程', installed === 'installed', { installed })

  await clickProbe()
  await sleep(900)
  const auth = await evalJs(
    `(function(){
      const box=document.querySelector('.agx-auth');
      const note=document.querySelector('.agx-agent-note');
      return {
        has: !!box,
        label: box?(box.querySelector('.agx-auth-label')||{}).textContent||'':'',
        items: box?[...box.querySelectorAll('.agx-auth-list li')].map(li=>({name:(li.querySelector('b')||{}).textContent||'',desc:(li.querySelector('i')||{}).textContent||''})):[],
        note: note?(note.textContent||'').trim():'',
      };
    })()`,
    false,
  )
  check('预检有登录方式时，界面上出现「登录方式」', auth.has && /登录方式/.test(auth.label), auth)
  check(
    '每一种登录方式连说明一起列出来',
    auth.items.length === 2 &&
      auth.items[0].name.includes('Anthropic') &&
      /API_KEY/.test(auth.items[0].desc) &&
      auth.items[1].name.includes('OAuth') &&
      auth.items[1].desc.length > 0,
    auth.items,
  )

  // 协议没给登录方式：整栏不画（不许拿兜底文案顶上）
  await installFixtures([])
  await clickProbe()
  await sleep(900)
  const noAuth = await evalJs(
    `(function(){return {has:!!document.querySelector('.agx-auth'), note:(document.querySelector('.agx-agent-note')||{textContent:''}).textContent.trim()}})()`,
    false,
  )
  check('协议没给登录方式时，这一栏整个不出现', !noAuth.has, noAuth)
  check('但预检结论本身还在（不能连结论一起吞掉）', noAuth.note.length > 0, noAuth)

  // ── 二、locations ──
  await installFixtures(AUTH_METHODS)
  // 预检再来一次：登录方式这一栏得回到画面上（后面要量它的对比度）
  await clickProbe()
  await sleep(800)
  // 接上这一家：接上之后界面才会收事件
  await evalJs(
    `(function(){const a=document.querySelector('.agx-agent');const b=a&&a.querySelector('.agx-agent-main');if(!b)return false;b.click();return true})()`,
    false,
  )
  await sleep(900)

  // 接上会把「上一次预检结论」清掉，但登录方式是这一家的属性，不该跟着消失
  const authAfterConnect = await evalJs(
    `(function(){const box=document.querySelector('.agx-auth');return {has:!!box,label:box?(box.querySelector('.agx-auth-label')||{textContent:''}).textContent.trim():'',items:box?box.querySelectorAll('.agx-auth-list li').length:0}})()`,
    false,
  )
  check('接上以后，登录方式那一栏还在', authAfterConnect.has && authAfterConnect.items === 2, authAfterConnect)

  await pushAcp({ kind: 'turn.started', turnId: 't1', text: '把两个文件收拾一下' })
  await pushAcp({ kind: 'item.started', turnId: 't1', itemId: 'i1', title: '重写 src/app.ts', toolKind: 'edit' })
  await pushAcp({
    kind: 'item.completed',
    turnId: 't1',
    itemId: 'i1',
    status: 'completed',
    text: '写完了',
    locations: ['src/app.ts', 'docs/readme.md'],
  })
  await sleep(700)

  const touched = await evalJs(
    `(function(){
      const card=document.querySelector('.agx-touchcard');
      const edit=document.querySelector('.agx-editcard');
      const chip=[...document.querySelectorAll('.agx-top-right .agx-chip')].find(c=>/审查/.test(c.textContent||''));
      const step=[...document.querySelectorAll('.agx-step-touch')].map(x=>(x.textContent||'').trim());
      return {
        hasCard: !!card,
        cardText: card?(card.textContent||'').replace(/\\s+/g,' ').trim():'',
        editCards: document.querySelectorAll('.agx-editcard').length,
        chip: chip?(chip.textContent||'').replace(/\\s+/g,' ').trim():'',
        steps: step,
        diffRows: document.querySelectorAll('.agx-diff-row').length,
      };
    })()`,
    false,
  )
  check('只给路径的那一步，界面上有一张「动过」的卡', touched.hasCard, touched)
  check('卡上写的是「动过」，不是「已编辑」', /动过 2 个文件/.test(touched.cardText) && !/已编辑/.test(touched.cardText), touched)
  check('卡上那两个文件都列出来了', /src\/app\.ts/.test(touched.cardText) && /docs\/readme\.md/.test(touched.cardText), touched)
  check('它没有混进「已编辑」那张卡', touched.editCards === 0, { editCards: touched.editCards })
  check('步骤上也标了「动过」', touched.steps.some((s) => /动过 2 个文件/.test(s)), touched.steps)
  check('顶栏的审查入口把这两个文件算进去了', /审查 2 个文件/.test(touched.chip), touched)
  check('没有 diff 就不该有对照行', touched.diffRows === 0, { diffRows: touched.diffRows })

  // 打开评审面板
  await evalJs(
    `(function(){const b=document.querySelector('.agx-touchcard .agx-btn');if(!b)return false;b.click();return true})()`,
    false,
  )
  await sleep(700)
  const panel = await evalJs(
    `(function(){
      const files=[...document.querySelectorAll('.agx-file')].map(f=>({
        cls:f.className,
        name:(f.querySelector('.agx-file-name')||{textContent:''}).textContent.trim(),
        dir:(f.querySelector('.agx-file-dir')||{textContent:''}).textContent.trim(),
        touch:(f.querySelector('.agx-file-touch')||{textContent:''}).textContent.trim(),
        add:(f.querySelector('.agx-add')||{textContent:''}).textContent.trim(),
        del:(f.querySelector('.agx-del')||{textContent:''}).textContent.trim(),
      }));
      const notice=document.querySelector('.agx-touchnotice');
      return {
        open: document.querySelectorAll('.agx-review').length,
        head: (document.querySelector('.agx-review-head span')||{textContent:''}).textContent.replace(/\\s+/g,' ').trim(),
        files,
        notice: notice?(notice.textContent||'').replace(/\\s+/g,' ').trim():'',
        diffRows: document.querySelectorAll('.agx-diff-row').length,
      };
    })()`,
    false,
  )
  check('评审面板开着，两个文件都在列表里', panel.open === 1 && panel.files.length === 2, panel)
  check(
    '这两个被标成「动过」，没有增删数',
    panel.files.every((f) => f.touch.includes('动过') && !f.add && !f.del),
    panel.files,
  )
  check(
    '点开只有一个路径的文件，界面说清「没给出改动内容」',
    /没给出改动内容/.test(panel.notice) && /src\/app\.ts/.test(panel.notice) && panel.diffRows === 0,
    { notice: panel.notice, diffRows: panel.diffRows },
  )
  check('面板头上把两种文件分开报', /只说了动过/.test(panel.head) && !/有改动内容/.test(panel.head), panel.head)

  // ── 三、同一份文件既有 diff 又被点名：按改动算 ──
  await pushAcp({ kind: 'item.started', turnId: 't1', itemId: 'i2', title: '写 src/app.ts', toolKind: 'edit' })
  await pushAcp({
    kind: 'item.completed',
    turnId: 't1',
    itemId: 'i2',
    status: 'completed',
    edits: [{ path: 'src/app.ts', oldText: 'a\nb', newText: 'a\nc' }],
  })
  await sleep(700)
  const mixed = await evalJs(
    `(function(){
      const files=[...document.querySelectorAll('.agx-file')].map(f=>({
        name:(f.querySelector('.agx-file-name')||{textContent:''}).textContent.trim(),
        touch:!!f.querySelector('.agx-file-touch'),
        add:(f.querySelector('.agx-add')||{textContent:''}).textContent.trim(),
      }));
      const head=(document.querySelector('.agx-review-head span')||{textContent:''}).textContent.replace(/\\s+/g,' ').trim();
      const cards=[...document.querySelectorAll('.agx-touchcard')].map(c=>(c.textContent||'').replace(/\\s+/g,' ').trim());
      const editCards=[...document.querySelectorAll('.agx-editcard')].map(c=>(c.textContent||'').replace(/\\s+/g,' ').trim());
      return {files, head, cards, editCards};
    })()`,
    false,
  )
  check(
    '拿到了 diff 的那个文件回到「改动」那一类',
    mixed.files.length === 2 && mixed.files.some((f) => f.name === 'app.ts' && !f.touch && f.add) &&
      mixed.files.some((f) => f.name === 'readme.md' && f.touch),
    mixed.files,
  )
  check('面板头上两种文件分开报', /有改动内容/.test(mixed.head) && /只说了动过/.test(mixed.head), mixed.head)
  check('「动过」那张卡里只剩没给改动内容的那一个', mixed.cards.length === 1 && !/src\/app\.ts/.test(mixed.cards[0]), mixed.cards)
  check('「已编辑」那张卡里是改了内容的那一个', mixed.editCards.length === 1 && /app\.ts/.test(mixed.editCards[0]), mixed.editCards)

  // 点开那个只说了动过的文件：那句实话得摊在画面上，才能量它的对比度
  const openedTouch = await evalJs(
    `(function(){const b=[...document.querySelectorAll('.agx-file.touch')].find(x=>/readme\.md/.test(x.textContent||''));if(!b)return false;b.click();return true})()`,
    false,
  )
  await sleep(600)
  const noticeNow = await evalJs(
    `(function(){const n=document.querySelector('.agx-touchnotice');return {open:!!n,text:n?(n.textContent||'').replace(/\\s+/g,' ').trim():'',diffRows:document.querySelectorAll('.agx-diff-row').length}})()`,
    false,
  )
  check('点开只说了动过的那个文件，说的是「没给出改动内容」', openedTouch && noticeNow.open && /没给出改动内容/.test(noticeNow.text) && noticeNow.diffRows === 0, noticeNow)

  // ── 四、深浅两套皮肤 ──
  await evalJs(CONTRAST_HELPER, false)
  const contrast = await evalJs(
    `(function(){
      const sels=['.agx-auth-list b','.agx-auth-list i','.agx-touchcard-note','.agx-touch-tag','.agx-file-touch','.agx-touchnotice-text b','.agx-touchnotice-text span','.agx-step-touch'];
      const out={};
      for(const s of sels){
        const el=document.querySelector(s);
        out[s]= el? window.__ratio(el) : null;
      }
      out.theme=document.documentElement.dataset.theme;
      return out;
    })()`,
    false,
  )
  console.log(`  · 对比度：${JSON.stringify(contrast)}`)
  const ratios = Object.entries(contrast).filter(([k]) => k.startsWith('.agx-'))
  const low = ratios.filter(([, v]) => v === null || v < 4.5)
  check('新增文字在当前主题下都过了 4.5:1', low.length === 0, low)

  /**
   * 把顶栏那条一次性提示收掉。
   *
   * 它跟这两件事没关系（是登录态盘点之类），留着只会把证据照糊；
   * 收的是应用自己给的关闭按钮，不动 DOM。
   */
  async function dismissNotices() {
    return evalJs(
      `(function(){const n=document.querySelectorAll('.titlebar-notice .tn-x');n.forEach(b=>b.click());return n.length})()`,
      false,
    )
  }

  await dismissNotices()
  await sleep(400)
  await shot('acp-grounding-dark')

  await evalJs(`(function(){const b=document.querySelector('.theme-toggle');if(b){b.click();return true}return false})()`, false)
  await sleep(1200)
  await dismissNotices()
  await sleep(300)
  const light = await evalJs(
    `(function(){
      const sels=['.agx-auth-list b','.agx-auth-list i','.agx-touchcard-note','.agx-touch-tag','.agx-file-touch','.agx-touchnotice-text b','.agx-touchnotice-text span','.agx-step-touch'];
      const out={theme:document.documentElement.dataset.theme};
      for(const s of sels){const el=document.querySelector(s);out[s]= el? window.__ratio(el):null;}
      return out;
    })()`,
    false,
  )
  console.log(`  · 对比度（浅色）：${JSON.stringify(light)}`)
  check('切到浅色主题', light.theme === 'light', light)
  const lowLight = Object.entries(light)
    .filter(([k]) => k.startsWith('.agx-'))
    .filter(([, v]) => v === null || v < 4.5)
  check('新增文字在浅色主题下也都过了 4.5:1', lowLight.length === 0, lowLight)
  await shot('acp-grounding-light')

  console.log(
    failures.length
      ? `\n\x1b[31m${failures.length} 项未通过\x1b[0m ` + failures.join(', ')
      : `\n\x1b[32m全部通过\x1b[0m · 截图在 ${OUT}`,
  )
}

try {
  await main()
} catch (e) {
  console.error('验证脚本异常：', e)
  failures.push('exception')
} finally {
  /*
   * 只收自己 spawn 的那棵进程树。
   *
   * Windows 上光 kill 主进程不够：electron 还会留下渲染进程与 GPU 进程，
   * 它们照样占着 --remote-debugging-port，下一轮就会撞端口。
   * taskkill /T 按树收，只碰本脚本拉起来的那一棵。
   */
  if (child?.pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      /* 已经退出 */
    }
  }
  await sleep(800)
  fs.rmSync(userData, { recursive: true, force: true })
}
process.exit(failures.length ? 1 : 0)
