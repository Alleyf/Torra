// 运行时验证：以独立 userData 启动真实构建应用，经 CDP 走一遍设置页的「自建工具 / 插件」：
// 开关、插件清单列表 + 删除、待审扩展源码预览 + 启用（搬进扩展目录）。
// 只管理本脚本 spawn 的 electron 进程，临时目录用完即删。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-selfauth-'))
const dataDir = path.join(userData, 'torra')
const outDir = path.join(ROOT, 'docs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let ws = null
let port = 0

/** 端口冲突不该成为停下来的理由：从 9423 起找一个空闲口 */
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
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
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
  console.log(`  ${ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${label}${extra ? ` — ${JSON.stringify(extra)}` : ''}`)
  if (!ok) process.exitCode = 1
}

async function main() {
  port = await freePort(9423)
  console.log(`CDP 端口 ${port}，userData ${userData}`)
  child = spawn(electronBin, [ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--no-sandbox'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write('[app] ' + d))
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|GPU|gpu|Warning|deprecat/i.test(s)) process.stdout.write('[app:err] ' + s)
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
  console.log('步骤：应用已起，处理首运行弹窗')

  // 首次运行须知会挡住界面，先确认掉
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('button')].find(x=>/我已理解|继续使用|知道了|同意/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`,
    false,
  )
  await sleep(600)

  // 进入 设置 → 助手能力
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('.app-nav-item,button')].find(x=>/^设置/.test((x.textContent||'').trim())); if(!b) throw new Error('未找到设置入口'); b.click(); return true; })()`,
    false,
  )
  await sleep(800)
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('.settings-tab')].find(x=>/助手能力/.test(x.textContent||'')); if(!b) throw new Error('未找到 助手能力 标签'); b.click(); return true; })()`,
    false,
  )
  await sleep(800)

  const dom0 = await evalJs(cdp, `(function(){
    const t=document.body.innerText;
    return { hasSection:/自建工具 \\/ 插件/.test(t), off:/已关闭（推荐）/.test(t), scroll:!!document.querySelector('.settings-scroll') };
  })()`)
  check('设置页渲染出「自建工具 / 插件」分区', dom0.hasSection, dom0)
  check('自建开关默认关', dom0.off, dom0)

  const caps0 = await evalJs(cdp, `(async function(){ const c=await window.torra.assistantCapabilities();
    return { self: c.selfAuthoringEnabled, plugins: c.plugins.length, dirs: c.dirs }; })()`)
  check('capabilities 默认 selfAuthoringEnabled=false 且带 plugins 目录', caps0.self === false && !!caps0.dirs?.plugins, caps0)

  // 摆一条清单 + 一份待审源码到盘上，看界面是否如实列出来
  const plugDir = path.join(dataDir, 'pi', 'plugins')
  const pendDir = path.join(dataDir, 'pi', 'pending')
  fs.mkdirSync(plugDir, { recursive: true })
  fs.mkdirSync(pendDir, { recursive: true })
  fs.writeFileSync(
    path.join(plugDir, 'probe-echo.plugin.json'),
    JSON.stringify(
      {
        name: 'probe-echo',
        label: '探针查询',
        description: '验证设置页能把声明式插件如实列出来并删掉它',
        kind: 'http',
        parameters: { type: 'object', properties: { q: { type: 'string', description: '查询词' } }, required: ['q'] },
        http: { url: 'https://example.com/ping?q={{q}}', method: 'GET' },
      },
      null,
      2,
    ),
    'utf-8',
  )
  const CODE = 'export default (pi) => {\n  pi.registerTool({ name: "probe_tool" })\n}\n'
  fs.writeFileSync(path.join(pendDir, 'probe-ext.js'), CODE, 'utf-8')

  const listed = await evalJs(cdp, `(async function(){
    const v = await window.torra.assistantPlugins();
    const p = await window.torra.assistantPending();
    return { plugins: v.plugins.map(x=>[x.name,x.kind,x.confirm]), invalid: v.invalid.map(x=>x.name), pending: p.map(x=>({name:x.name,lines:x.lines,bytes:x.bytes,preview:x.preview,truncated:x.truncated})) };
  })()`)
  check('插件清单被如实列出（GET 默认免确认）', listed.plugins.some((x) => x[0] === 'probe-echo' && x[2] === 'never'), listed)
  check('待审扩展列出源码本身', listed.pending[0]?.preview.includes('pi.registerTool') && listed.pending[0]?.lines === 4, listed.pending)

  await evalJs(cdp, `(function(){ window.torra.assistantPlugins().then(()=>{}); return true; })()`, false)
  // 刷新这一页：重新点一次标签以重读两个列表
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('.settings-tab')].find(x=>/链路体检/.test(x.textContent||'')); b&&b.click(); return true; })()`,
    false,
  )
  await sleep(400)
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('.settings-tab')].find(x=>/助手能力/.test(x.textContent||'')); b&&b.click(); return true; })()`,
    false,
  )
  await sleep(900)

  const dom1 = await evalJs(cdp, `(function(){
    const t=document.body.innerText;
    return {
      row:/探针查询/.test(t),
      file:/probe-echo\\.plugin\\.json/.test(t),
      srcPreview:!!document.querySelector('pre.pending-src'),
      enableBtn:[...document.querySelectorAll('button')].some(b=>/^启用/.test(b.title||'')),
    };
  })()`)
  check('界面上能看到清单行 + 文件路径', dom1.row && dom1.file, dom1)
  check('界面上有源码预览 <pre> 与启用按钮', dom1.srcPreview && dom1.enableBtn, dom1)

  // 两行都在的时候先截一张：末尾那张已经删空了，说明不了什么
  await evalJs(
    cdp,
    `(function(){ const h=[...document.querySelectorAll('h3')].find(x=>/自建工具 \\/ 插件/.test(x.textContent||'')); h&&h.scrollIntoView({block:'start'}); return !!h; })()`,
    false,
  )
  await sleep(500)
  await shot(cdp, 'verify-self-authoring.png')

  // 打开自建开关
  const toggleRes = await evalJs(cdp, `(async function(){
    const b=[...document.querySelectorAll('button')].find(x=>/开启|关闭/.test((x.textContent||'').trim()) && x.closest('.settings-row')?.textContent?.includes('允许助手自建工具'));
    if(!b) throw new Error('未找到自建开关按钮');
    b.click();
    await new Promise(r=>setTimeout(r,1600));
    const c=await window.torra.assistantCapabilities();
    return { text: document.body.innerText.match(/已开启[^\\n]{0,40}/g), self: c.selfAuthoringEnabled };
  })()`)
  check('点开关后 selfAuthoringEnabled=true 且有可见反馈', toggleRes.self === true && !!toggleRes.text?.length, toggleRes)

  // 启用待审扩展 = 文件搬进 extensions/
  await evalJs(cdp, `(function(){ const b=[...document.querySelectorAll('button')].find(x=>/^启用/.test(x.title||'')); b.click(); return true; })()`, false)
  await sleep(1800)
  const promoted = await evalJs(cdp, `(async function(){ const p=await window.torra.assistantPending(); return p.map(x=>x.name); })()`)
  check('启用后待审区不再包含它', !promoted.includes('probe-ext'), promoted)
  check(
    '文件确实搬进了 extensions/（内容一字未改）',
    fs.existsSync(path.join(dataDir, 'pi', 'extensions', 'probe-ext.js')) &&
      fs.readFileSync(path.join(dataDir, 'pi', 'extensions', 'probe-ext.js'), 'utf-8') === CODE,
  )
  check('待审区那份文件已不在', !fs.existsSync(path.join(pendDir, 'probe-ext.js')))

  // 删除插件清单 = 只删那一个文件
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('button[title^="删除插件清单"]')][0]; if(!b) throw new Error('未找到删除按钮'); b.click(); return true; })()`,
    false,
  )
  await sleep(1800)
  const afterRemove = await evalJs(cdp, `(async function(){ const v=await window.torra.assistantPlugins(); return v.plugins.map(x=>x.name); })()`)
  check('删除后列表不再包含它', !afterRemove.includes('probe-echo'), afterRemove)
  check('盘上那个文件确实被删掉', !fs.existsSync(path.join(plugDir, 'probe-echo.plugin.json')))

  // 截这一分区的图：不滚过去，截图只会停在「技能与扩展」开头
  await evalJs(
    cdp,
    `(function(){ const h=[...document.querySelectorAll('h3')].find(x=>/自建工具 \\/ 插件/.test(x.textContent||'')); h&&h.scrollIntoView({block:'start'}); return !!h; })()`,
    false,
  )
  await sleep(500)
  await shot(cdp, 'verify-self-authoring-after.png')
  console.log('\n== 验证完成 ==')
}

main()
  .then(() => cleanup(process.exitCode || 0))
  .catch((e) => {
    console.error('验证失败:', e.message)
    cleanup(1)
  })

// 卡住不该让验证永远挂着：到点就按失败退出，最后一条「步骤」标记就是卡住的位置
const guard = setTimeout(() => {
  console.error('验证超时（3 分钟）')
  cleanup(1)
}, 180000)

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
  // Windows 上 Electron 刚退出时目录里还有文件被占用，一次删不掉就补删几次
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(userData, { recursive: true, force: true })
      break
    } catch {
      sleepSync(500)
    }
  }
  setTimeout(() => process.exit(code), 800)
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
