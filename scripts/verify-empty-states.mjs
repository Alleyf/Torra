// 运行时验证：空状态与失败提示说人话。
//
// 这一类问题编译器看不见：文案还是那句话，界面照样渲染，
// 但用户读完不知道下一步该点哪儿 —— 「暂无数据」四个字就是这种界面。
//
// 这里盯四件事：
//   1. 屏幕上没有裸露的空话（「暂无数据」「无数据」这类没有下文的话）；
//   2. 标准空状态组件（.es-box）两行都在：上面说「这里会出现什么」，
//      下面说「怎么让它出现」，缺一行都不算合格；
//   3. 失败提示的原始信息（英文异常、内部 id）不占主句 —— 它得缩成灰色小字，
//      主句说清「什么坏了 + 你能做什么」；
//   4. 全程没人碰过 alert / confirm / prompt —— 那个年代的做法在这套界面里早该退休了。
//
// 走的是真窗口：起一个 Electron，临时 userData，CDP 驱动渲染层，
// 逐屏扫一遍，把每屏的可见文本都抓下来对。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'empty-states')
const PORT = await freePort(9585)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-empty-'))

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

async function evalJs(expression, awaitPromise = true) {
  const r = await wsCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) {
    throw new Error('页内执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}

async function mainEval(expression) {
  const r = await wsMainCdp.send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true })
  if (r.exceptionDetails) {
    throw new Error('主进程执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}

async function shot(name) {
  const r = await wsCdp.send('Page.captureScreenshot', { format: 'png' }, 60000)
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
}

/** 点顶栏/设置页里按文案找的那一颗按钮 */
async function clickByText(selector, re) {
  return evalJs(
    `(function(){const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>${re}.test(x.textContent||''));if(!b)return false;b.click();return true})()`,
    false,
  )
}

/**
 * 没有下文的空话 —— 这些句子本身不构成一个空状态：
 * 用户读完只知道自己眼前是空的，不知道这里本来该有什么、怎么才能有。
 */
const BARE = ['暂无数据', '暂无', '无数据', '空空如也', '暂无记录', '暂无内容', '暂无信息', '没有数据']

/**
 * 扫一屏：找裸露的空话，并核对标准空状态组件的两行都在。
 *
 * 「裸露」按元素自己的文字算（不含子元素）—— 一句话里恰好带了「暂无」两个字
 * 不算问题（「暂无更多历史」是有下文的话），一整个元素只有「暂无数据」才算。
 */
const SCAN = `(function(){
  const BARE = ${JSON.stringify(BARE)};
  const bare = [];
  const boxes = [];
  const seen = new Set();
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT','STYLE','TEMPLATE','NOSCRIPT'].includes(el.tagName)) continue;
    if (!visible(el)) continue;
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent || '').join('').replace(/\\s+/g,' ').trim();
    if (own && BARE.includes(own)) {
      bare.push({ text: own, tag: el.tagName, cls: el.className && String(el.className).slice(0,60) });
    }
    if (el.classList && el.classList.contains('es-box') && !seen.has(el)) {
      seen.add(el);
      const what = el.querySelector('.es-what');
      const how = el.querySelector('.es-how');
      boxes.push({
        what: what ? (what.textContent||'').replace(/\\s+/g,' ').trim() : '',
        how: how ? (how.textContent||'').replace(/\\s+/g,' ').trim() : '',
      });
    }
  }
  return { bare, boxes, text: (document.body.innerText||'').replace(/\\s+/g,' ') };
})()`

/** 逐屏扫一遍 */
async function scanScreen(label) {
  const r = await evalJs(SCAN, false)
  const bareHits = r.bare.filter((b) => !b.cls.includes('es-how'))
  check(
    `${label}：没有裸露的空话`,
    bareHits.length === 0,
    bareHits.length ? { hits: bareHits.slice(0, 4) } : { scanned: r.bare.length },
  )
  const halfBoxes = r.boxes.filter((b) => !b.what || !b.how)
  check(
    `${label}：标准空状态两行都在`,
    halfBoxes.length === 0,
    halfBoxes.length ? { bad: halfBoxes.slice(0, 3) } : { boxes: r.boxes.length },
  )
  return r
}

/** 一份够用的假模型清单：有一家 API 模型，密钥页才有东西可看 */
const MODELS = [
  {
    id: 'demo-api',
    displayName: '演示 API 模型',
    transport: 'api',
    color: '#4d6bfe',
    enabled: true,
    supportsStructuredOutput: true,
    adapterHealth: 'ok',
    adapterStale: false,
    hasKey: false,
    status: 'ready',
  },
]

/** 主进程侧的假 handler：模型清单 + 一个会失败的密钥保存 */
async function installFixtures() {
  const src = `
(function(){
  const { ipcMain } = require('electron');
  const models = ${JSON.stringify(MODELS)};
  for (const ch of ['models:list','secrets:set','secrets:has']) { try { ipcMain.removeHandler(ch) } catch (e) {} }
  ipcMain.handle('models:list', () => models);
  ipcMain.handle('secrets:has', () => ({ has: false }));
  // 故意给一条英文的底层原因：这正是「原始信息」该被挪到次要位置的那种情况
  ipcMain.handle('secrets:set', () => ({ ok: false, encrypted: false, reason: 'keychain write failed: 0x80070032 (ENOENT)' }));
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
    if (!/DevTools listening|Debugger listening|Debugging suggestion|GPU|gpu|Warning|deprecat/i.test(s)) {
      console.log('[app:err] ' + s)
    }
  })

  const page = await findTarget('page')
  wsCdp = await connect(page.webSocketDebuggerUrl)
  wsMainCdp = await connect((await findTarget('node')).webSocketDebuggerUrl)
  await wsCdp.send('Runtime.enable')
  await wsCdp.send('Page.enable')

  // 原生弹窗先打桩计数：它们在被调用的一瞬间就会被记下来。
  // 这一步必须早于任何页面脚本 —— addScriptToEvaluateOnNewDocument 在每个新文档上先跑。
  await wsCdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
(function(){
  window.__nativeDialogCalls = [];
  for (const name of ['alert','confirm','prompt']) {
    const orig = window[name];
    window[name] = function(){
      window.__nativeDialogCalls.push({ name: name, args: Array.prototype.slice.call(arguments).map(String) });
      return name === 'confirm' ? false : undefined;
    };
    try { Object.defineProperty(window[name], 'toString', { value: function(){ return 'function ' + name + '() { [native code] }'; } }); } catch (e) {}
  }
})();`,
  })

  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;if(w.isMinimized())w.restore();w.show();w.setContentSize(1600,950);w.moveTop();w.focus()}return 'ok'})()`,
  )
  await sleep(1500)

  const installed = await installFixtures()
  check('假模型清单与假密钥 handler 装进主进程', installed === 'installed', { installed })

  // 清单是渲染层挂载时读的，得重载一次才拿到
  await mainEval(`(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(!w.isDestroyed())w.reload()}return 'reloaded'})()`)
  await sleep(2800)
  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;w.show();w.setContentSize(1600,950);w.focus()}return 'ok'})()`,
  )
  await sleep(900)

  // 首次引导会挡住界面，先把它收掉
  await clickByText('.start-intro-foot button', /知道了|不再显示|开始/)
  await sleep(500)

  const modelsLoaded = await evalJs(`(function(){const s=window.__torraStore;if(!s)return 0;return s.getState().models.length})()`, false)
  check('渲染层拿到假模型清单', modelsLoaded === 1, { modelsLoaded })

  // ── 逐屏扫 ──
  const topSections = ['研讨', '聊天', '编码', '翻译', '历史', '设置']
  for (const label of topSections) {
    const clicked = await evalJs(
      `(function(){const b=[...document.querySelectorAll('.app-nav-item')].find(x=>(x.getAttribute('aria-label')||'')===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`,
      false,
    )
    check(`顶栏能切到「${label}」`, clicked === true)
    await sleep(1500)
    await scanScreen(label)
    await shot(`screen-${label}`)
  }

  // ── 设置页的子页签也扫一遍：空状态多半藏在这里 ──
  const settingTabs = ['模型管理', '密钥', '讨论参数', '诊断与日志', '资源库', '外观', '性能', '备份', '用量与成本', '入口与更新', '关于']
  for (const label of settingTabs) {
    const clicked = await clickByText('.st-nav-item', new RegExp(`^${label}`))
    if (!clicked) {
      console.log(`  \x1b[33mSKIP\x1b[0m 设置页没有「${label}」这一页签`)
      continue
    }
    await sleep(1100)
    await scanScreen(`设置·${label}`)
  }

  // ── 失败提示：原始信息不许占主句 ──
  await clickByText('.st-nav-item', /^密钥/)
  await sleep(900)
  const triggered = await evalJs(
    `(function(){
      const row = document.querySelector('.st-list .st-row');
      if (!row) return { ok:false, why:'没有密钥行' };
      const input = row.querySelector('input.st-input');
      const btn = row.querySelector('.st-btn.primary');
      if (!input || !btn) return { ok:false, why:'密钥行缺输入框或按钮' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(input, 'sk-demo-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      return { ok:true };
    })()`,
    false,
  )
  check('能触发一次真实的保存失败', triggered?.ok === true, { triggered })
  await sleep(1400)

  const failure = await evalJs(
    `(function(){
      // 失败主句与「未配置」那个状态徽章都是 .st-meta 里的 .warn ，
      // 直接 querySelector('.st-meta .warn') 会抓到徽章 —— 断言就成了一句废话。
      // 正解是顺着原始信息那块往回找：它的上一块 .st-meta 才是失败主句。
      const detail = document.querySelector('.st-note-detail');
      const detailWrap = detail ? detail.closest('.st-meta') : null;
      const noteWrap = detailWrap ? detailWrap.previousElementSibling : null;
      const note = noteWrap ? noteWrap.querySelector('.warn') : null;
      const raw = 'keychain write failed';
      const dText = detail ? (detail.textContent||'').trim() : '';
      const nText = note ? (note.textContent||'').replace(/\\s+/g,' ').trim() : '';
      const dcs = detail ? getComputedStyle(detail) : null;
      const ncs = note ? getComputedStyle(note) : null;
      return {
        hasDetail: !!detail,
        detailText: dText,
        noteText: nText,
        rawInDetail: dText.includes(raw),
        rawInNote: nText.includes(raw),
        detailSize: dcs ? parseFloat(dcs.fontSize) : null,
        noteSize: ncs ? parseFloat(ncs.fontSize) : null,
        detailColor: dcs ? dcs.color : null,
        noteColor: ncs ? ncs.color : null,
      };
    })()`,
    false,
  )
  check('失败时原始信息有落脚处（灰色小字那一档）', failure.hasDetail === true, { detailText: failure.detailText })
  check('抓到的确实是失败主句，不是旁边那个状态徽章', failure.noteText !== '未配置' && failure.noteText.length > 0, {
    noteText: failure.noteText,
  })
  check('原始信息确实落在小字里，不在主句里', failure.rawInDetail === true && failure.rawInNote === false, {
    rawInDetail: failure.rawInDetail,
    rawInNote: failure.rawInNote,
  })
  check('小字比主句更弱（字号更小或颜色更淡）', failure.detailSize !== null && failure.noteSize !== null && (failure.detailSize <= failure.noteSize || failure.detailColor !== failure.noteColor), {
    detailSize: failure.detailSize,
    noteSize: failure.noteSize,
    detailColor: failure.detailColor,
    noteColor: failure.noteColor,
  })
  check(
    '主句说得出「你能做什么」',
    /[点打开新建去试换设置确认选择添加开始重试导入启用]/.test(failure.noteText || ''),
    { noteText: failure.noteText },
  )
  await shot('failure-detail')

  // ── 原生弹窗 ──
  const dialogs = await evalJs(`(function(){return window.__nativeDialogCalls || []})()`, false)
  check('全程没人碰过 alert / confirm / prompt', Array.isArray(dialogs) && dialogs.length === 0, {
    calls: (dialogs || []).slice(0, 5),
  })

  console.log(failures.length === 0 ? '\n\x1b[32m全部通过\x1b[0m' : `\n\x1b[31m${failures.length} 项未通过\x1b[0m`)
  console.log(`截图在 ${OUT}`)
  for (const f of failures) console.log(`  - ${f}`)
}

main()
  .catch((e) => {
    console.error('验证脚本崩了:', e)
    failures.push('脚本异常')
  })
  .finally(async () => {
    try {
      if (child && !child.killed) child.kill()
    } catch {
      /* 忽略 */
    }
    try {
      fs.rmSync(userData, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    process.exit(failures.length === 0 ? 0 : 1)
  })
