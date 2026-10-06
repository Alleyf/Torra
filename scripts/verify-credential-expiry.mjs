// 运行时验证：有凭据的网页模型，界面上是否真的把有效期说清楚了。
//
// 做法：往隔离 userData 的几个登录分区里种上可预期的凭据（30 天 / 90 天 / 5 小时 / www 域），
// 起真实构建应用，经 CDP 同时读「主进程给的 models 快照」和「模型栏 DOM」，
// 再走设置页的 Cookie 面板点一次「检查」看逐条到期时间。临时目录（含假 cookie）用完即删。
//
// 只管理本脚本 spawn 的 electron 进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-credday-'))
const outDir = path.join(ROOT, 'docs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let ws = null
let port = 0

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryOne = (p, attempts) => {
      const srv = net.createServer()
      srv.once('error', () => {
        srv.close()
        if (attempts <= 0) reject(new Error('没有可用调试端口'))
        else tryOne(p + 1, attempts - 1)
      })
      srv.once('listening', () => srv.close(() => resolve(p)))
      srv.listen(p, '127.0.0.1')
    }
    tryOne(start, 20)
  })
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
      })
    },
  }
}

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
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

function check(label, ok, extra) {
  console.log(`  ${ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`)
  if (!ok) process.exitCode = 1
}

function runElectronOnce(args, tag) {
  return new Promise((resolve, reject) => {
    const p = spawn(electronBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => {
      out += String(d)
      process.stdout.write(`[${tag}] ` + d)
    })
    p.stderr.on('data', (d) => {
      const s = String(d)
      if (!/DevTools listening|GPU|gpu|Warning|deprecat/i.test(s)) process.stdout.write(`[${tag}:err] ` + d)
    })
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${tag} 退出码 ${code}`))))
    p.on('error', reject)
  })
}

const DAY = 86400_000
/** 天数按「向下取整」说，不夸大：种子是 30 天，运行到读的一刻通常显示 29 天 */
const daysText = (n) => new RegExp(`^剩 ${n - 1} 天$|^剩 ${n} 天$`)

async function main() {
  port = await freePort(9433)
  console.log(`CDP 端口 ${port}，userData ${userData}`)

  console.log('步骤：往隔离分区里种凭据')
  await runElectronOnce([path.join(ROOT, 'scripts', 'seed-credential-cookie.js'), `--user-data-dir=${userData}`, '--no-sandbox'], 'seed')

  child = spawn(electronBin, [ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--no-sandbox'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write('[app] ' + d))
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|GPU|gpu|Warning|deprecat/i.test(s)) process.stdout.write('[app:err] ' + d)
  })

  const page = await findPageTarget()
  console.log('步骤：连接 CDP')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
    setTimeout(() => rej(new Error('CDP 套接字 15 秒没连上')), 15000)
  })
  const cdp = cdpClient(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(6000)

  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('button')].find(x=>/我已理解|继续使用|知道了|同意/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`,
    false,
  )

  // 快照和 DOM 必须一次读完：分两次读，中间主进程还在复检登录态，
  // 拿旧快照去对新 DOM 只会验出「时序差」，验不出界面。
  const readUi = () =>
    evalJs(cdp, `(async function(){
      const ms = await window.torra.listModels();
      const snap = ms.filter(m => m.transport === 'webview').map(m => ({
        id: m.id, name: m.displayName, loginState: m.loginState ?? null,
        days: m.credExpiresAt ? Math.round((m.credExpiresAt - Date.now()) / ${DAY} * 10) / 10 : null,
        cookie: m.credExpiresCookie ?? null, sessionOnly: !!m.credSessionOnly,
      }));
      const rail = [...document.querySelectorAll('.model-card')].map(el => {
        const c = el.querySelector('.model-cred');
        return {
          name: (el.querySelector('.model-card-name')?.textContent || '').trim(),
          text: c ? c.textContent.trim() : null,
          tone: c ? (c.className.match(/tone-(\\w+)/) || [])[1] : null,
          title: c ? c.getAttribute('title') : null,
        };
      });
      return { snap, rail };
    })()`)

  console.log('步骤：等主进程把有效期探出来（同时读 DOM）')
  const seeded = ['chatgpt', 'deepseek-web', 'qwen', 'kimi']
  let snap = []
  let rail = []
  for (let i = 0; i < 20; i++) {
    const ui = await readUi()
    snap = ui.snap
    rail = ui.rail
    const byIdNow = Object.fromEntries(snap.map((s) => [s.id, s]))
    if (rail.some((r) => r.text) && seeded.every((id) => byIdNow[id]?.days !== null)) break
    await sleep(3000)
  }
  console.log('  快照：' + JSON.stringify(snap))
  console.log('  模型栏：' + JSON.stringify(rail.map((r) => [r.name, r.text, r.tone])))
  const byId = Object.fromEntries(snap.map((s) => [s.id, s]))

  check('ChatGPT：30 天左右的到期时刻，并点明依据的 cookie 名', (byId.chatgpt?.days ?? 0) >= 29 && byId.chatgpt?.cookie === 'access_token', byId.chatgpt)
  check('DeepSeek：两条凭据取最早的那条（30 天而不是 90 天）', byId['deepseek-web']?.cookie === 'ds_session_id' && (byId['deepseek-web']?.days ?? 0) >= 29, byId['deepseek-web'])
  check('通义千问：写在父域 .qwen.ai 上的凭据也算本站，且落进黄档', byId.qwen?.cookie === 'refresh_token' && (byId.qwen?.days ?? 99) < 1, byId.qwen)
  check('Kimi：入口带 www、凭据也写在 www 上 —— 两侧剥 www 后仍然认', byId.kimi?.cookie === 'session_token' && (byId.kimi?.days ?? 0) >= 1, byId.kimi)

  console.log('步骤：核对模型栏')
  // 界面规则（与 ModelRail 同源）：网页模型、没被判「未登录」、且能算出有效期才显示
  const expect = snap.map((s) => ({
    name: s.name,
    loginState: s.loginState,
    shouldShow: s.loginState !== 'logged-out' && (s.days !== null || s.sessionOnly),
  }))
  const domByName = Object.fromEntries(rail.map((r) => [r.name, r]))
  const mismatch = expect.filter((e) => {
    const seen = domByName[e.name]
    if (!seen) return true
    return !!seen.text !== e.shouldShow
  })
  check('模型栏每条卡片的显示与规则一致（未登录的不显示倒计时）', mismatch.length === 0, mismatch)
  check('至少有一条卡片真的显示出了有效期', rail.some((r) => r.text), rail.filter((r) => r.text).map((r) => [r.name, r.text]))
  // 卡片空间小，显示的是 short（「29 天」），带「剩」的完整文案在 Cookie 面板
  const shown = rail.find((r) => r.text && /天|小时|分钟|已过期/.test(r.text))
  check('显示出来的那条带着依据（悬停写明哪条 cookie 与局限）', !!shown && /认证 cookie「.+」/.test(shown.title || '') && /提前注销/.test(shown.title || ''), shown && [shown.name, shown.text, shown.title])
  const soon = rail.find((r) => r.text && /小时|分钟/.test(r.text))
  check('不足 36 小时的那条转黄', !soon || soon.tone === 'warn', soon)

  await shot(cdp, 'verify-credential-expiry-rail.png')

  console.log('步骤：设置页 → Cookie 与登录 → 检查 DeepSeek')
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('.app-nav-item,button')].find(x=>/^设置/.test((x.textContent||'').trim())); if(!b) throw new Error('未找到设置入口'); b.click(); return true; })()`,
    false,
  )
  await sleep(900)
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('.settings-tab')].find(x=>/Cookie/.test(x.textContent||'')); if(!b) throw new Error('未找到 Cookie 标签'); b.click(); return true; })()`,
    false,
  )
  await sleep(900)

  await evalJs(
    cdp,
    `(function(){
      const row=[...document.querySelectorAll('.cookie-row')].find(r=>/DeepSeek|深度/i.test(r.querySelector('.settings-row-name')?.textContent||''));
      if(!row) throw new Error('未找到 DeepSeek 行');
      const b=[...row.querySelectorAll('button')].find(x=>/检查/.test(x.textContent||''));
      if(!b) throw new Error('未找到检查按钮');
      b.click(); return true;
    })()`,
    false,
  )
  await sleep(4000)
  await evalJs(
    cdp,
    `(function(){
      const row=[...document.querySelectorAll('.cookie-row')].find(r=>/DeepSeek|深度/i.test(r.querySelector('.settings-row-name')?.textContent||''));
      if(!row.querySelector('.cookie-cred-list')) row.querySelector('.cookie-head')?.click();
      return true;
    })()`,
    false,
  )
  await sleep(1500)

  const detail = await evalJs(cdp, `(function(){
    const row=[...document.querySelectorAll('.cookie-row')].find(r=>/DeepSeek|深度/i.test(r.querySelector('.settings-row-name')?.textContent||''));
    return {
      head: (row.querySelector('.cookie-cred')?.textContent||'').trim(),
      items: [...row.querySelectorAll('.cookie-cred-item')].map(i => ({
        name: i.querySelector('.cookie-cred-name')?.textContent,
        left: i.querySelector('.cookie-cred-left')?.textContent,
        earliest: i.classList.contains('earliest'),
        flagged: !!i.querySelector('.cookie-cred-flag'),
      })),
    };
  })()`)
  console.log('  诊断：' + JSON.stringify(detail))
  check('诊断后逐条列出认证 cookie 的有效期', detail.items.length >= 2, detail.items)
  check(
    '最早到期的那条被标成界面依据，且只有一条',
    detail.items.filter((i) => i.earliest).length === 1 &&
      detail.items.some((i) => i.earliest && i.name === 'ds_session_id' && i.flagged),
    detail.items,
  )
  check('面板行头与诊断说的是同一个数', daysText(30).test(detail.head.replace(/^凭据/, '')), detail.head)
  check('逐条列表把最早到期的排在第一位', detail.items[0]?.earliest === true, detail.items.map((i) => i.left))

  await evalJs(cdp, `(function(){ const el=document.querySelector('.cookie-cred-list'); if(el) el.scrollIntoView({block:'center'}); return !!el; })()`, false)
  await sleep(500)
  await shot(cdp, 'verify-credential-expiry-panel.png')

  console.log('\n== 验证完成 ==')
}

main()
  .then(() => cleanup(process.exitCode || 0))
  .catch((e) => {
    console.error('验证失败:', e.message)
    cleanup(1)
  })

const guard = setTimeout(() => {
  console.error('验证超时（5 分钟）')
  cleanup(1)
}, 300000)

function cleanup(code) {
  try {
    clearTimeout(guard)
  } catch {
    /* ignore */
  }
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
  // 临时目录里有假 cookie，必须删干净；Windows 上刚退出时还可能被占用
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(userData, { recursive: true, force: true })
      break
    } catch {
      sleepSync(500)
    }
  }
  console.log('临时 userData 已删除:', !fs.existsSync(userData))
  setTimeout(() => process.exit(code), 800)
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
