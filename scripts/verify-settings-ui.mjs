// 运行时验证：设置页（st- 层）在明暗两套主题下的五个分区。
// 用独立 userData 启动真实构建产物，经 CDP 点导航、截图、并检查
// 「有没有横向溢出 / 是否还有旧 .settings-* 残留 / 文字色是否落在可见区间」。
// 只管理本脚本 spawn 的 electron 进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-settings-'))
const outDir = path.join(ROOT, 'docs')
const TABS = ['models', 'cookie', 'doctor', 'assistant', 'appearance']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let ws = null

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
        setTimeout(() => {
          if (pending.has(mid)) {
            pending.delete(mid)
            reject(new Error(`CDP 超时: ${method}`))
          }
        }, 15000)
      })
    },
  }
}

async function pickPort() {
  for (let p = 9420; p < 9430; p++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(600) })
      if (res.ok) continue // 已被别的实例占用
    } catch {
      return p
    }
  }
  throw new Error('没有可用的调试端口')
}

async function findPageTarget(port) {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const main = list.find((t) => t.type === 'page' && /file:\/\/.*index\.html/.test(t.url || ''))
      if (main) return main
    } catch {
      /* 尚未就绪 */
    }
    await sleep(500)
  }
  throw new Error('未找到渲染层页面目标')
}

async function run(expression, awaitPromise = true) {
  const cdp = global.__cdp
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails)
    throw new Error('页内执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function shot(name) {
  const r = await global.__cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(outDir, name)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  截图 →', path.basename(file))
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  const PORT = await pickPort()
  console.log('调试端口', PORT)
  child = spawn(electronBin, [ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => {
    const s = String(d)
    if (!/^\[app\]/.test(s) && /settings|Error/i.test(s)) process.stdout.write('[app] ' + s)
  })
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|GPU|gpu|Warning|deprecat/i.test(s)) process.stdout.write('[app:err] ' + s)
  })

  const page = await findPageTarget(PORT)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = cdpClient(ws)
  global.__cdp = cdp
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  const pageErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push('EX: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      pageErrors.push('ERR: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  })

  await sleep(6000)
  let mounted = false
  for (let i = 0; i < 80; i++) {
    mounted = await run(`!!document.querySelector('.app-nav-item')`)
    if (mounted) break
    await sleep(500)
  }
  console.log('渲染层挂载就绪:', mounted)
  if (!mounted) {
    await shot('settings-diag-unmounted.png').catch(() => {})
    throw new Error('渲染层未挂载')
  }
  // 关掉首运行须知弹窗（若有）
  await run(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>/我已理解|继续使用|知道了|同意/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`)

  const entered = await run(`(function(){
    const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='设置');
    if(!b) return false; b.click(); return true; })()`)
  if (!entered) throw new Error('未能进入设置页')
  await sleep(800)

  const fail = []
  for (const theme of ['light', 'dark']) {
    await run(`document.documentElement.setAttribute('data-theme','${theme}'); '${theme}'`)
    await sleep(350)
    for (let i = 0; i < TABS.length; i++) {
      await run(`(function(){ const n=document.querySelectorAll('.st-nav-item')[${i}]; if(!n) throw new Error('导航项缺失 ${i}'); n.click(); return n.textContent.trim(); })()`)
      await sleep(450)
      const diag = await run(`(function(){
        const main=document.querySelector('.st-main'), body=document.querySelector('.st-body');
        if(!main||!body) return {err:'骨架缺失'};
        const overflow = main.scrollWidth - main.clientWidth;
        const wide = [...body.querySelectorAll('*')].filter(el=>{
          const r=el.getBoundingClientRect(); return r.right > main.getBoundingClientRect().right+1 && r.width>0;
        }).map(el=>el.className).filter(String).slice(0,4);
        const inkSample = (()=>{
          const pick = (sel)=>{ const el=body.querySelector(sel); if(!el) return null;
            const cs=getComputedStyle(el); return {sel, color: cs.color, size: cs.fontSize}; };
          return ['.st-h1','.st-sec-title','.st-name','.st-desc','.st-meta'].map(pick).filter(Boolean);
        })();
        return {
          overflow, wide,
          legacy: [...document.querySelectorAll('[class*="settings-"],[class*="theme-option"],[class*="ap-mode"]')].length,
          inline: [...body.querySelectorAll('[style]')].filter(el=>/background|color/.test(el.getAttribute('style')||'')).map(el=>el.getAttribute('style')).slice(0,5),
          counts: { rows: body.querySelectorAll('.st-row').length, sections: body.querySelectorAll('.st-section').length,
                    switch: body.querySelectorAll('.st-switch').length, empty: body.querySelectorAll('.st-empty').length },
          inkSample,
        };
      })()`)
      const label = `${theme}/${TABS[i]}`
      console.log(label, JSON.stringify(diag))
      if (diag.err) fail.push(`${label}: ${diag.err}`)
      if (diag.overflow > 1) fail.push(`${label}: 横向溢出 ${diag.overflow}px ${JSON.stringify(diag.wide)}`)
      if (diag.legacy > 0) fail.push(`${label}: 仍有 ${diag.legacy} 个旧类名节点`)
      for (const s of diag.inkSample || []) {
        const m = /rgba?\((\d+), (\d+), (\d+)/.exec(s.color)
        if (!m) continue
        const [r, g, b] = [+m[1], +m[2], +m[3]]
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        const wantLight = theme === 'light' ? lum < 0.75 : lum > 0.25
        if (!wantLight) fail.push(`${label}: ${s.sel} 文字色 ${s.color} 在该主题下看不见`)
      }
      await shot(`settings-${TABS[i]}-${theme}.png`)
      if (theme === 'light' && TABS[i] === 'models') {
        // 悬停才出现的行内操作：不验一遍的话，「永远点不到」和「按设计收起」在截图上长得一样
        const box = await run(`(function(){ const r=document.querySelector('.st-row'); if(!r) return null;
          const b=r.getBoundingClientRect(); return {x:b.x+b.width/2, y:b.y+b.height/2}; })()`)
        if (box) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
          await sleep(400)
          const op = await run(`(function(){ const el=document.querySelector('.st-row .st-actions.quiet');
            return el? getComputedStyle(el).opacity : 'none'; })()`)
          console.log('  悬停后行内操作 opacity =', op)
          if (op !== '1') fail.push(`悬停未显示行内操作（opacity=${op}）`)
          await shot('settings-models-hover-light.png')
        }
      }
    }
  }

  console.log('页面错误:', pageErrors.length ? pageErrors.slice(0, 8) : '无')
  if (pageErrors.length) fail.push('渲染层报错 ' + pageErrors.length + ' 条')
  console.log(fail.length ? 'FAIL:\n' + fail.join('\n') : 'PASS：五个分区 × 两套主题结构检查通过')
  if (ws) ws.close()
}

main()
  .catch((e) => console.error('验证失败:', e.message))
  .finally(async () => {
    // 临时 userData 里有 cookie，必须等进程真的退出再删干净
    const exited = child ? new Promise((r) => child.once('exit', r)) : Promise.resolve()
    try {
      if (child && child.exitCode === null) child.kill()
    } catch {}
    await Promise.race([exited, sleep(8000)])
    for (let i = 0; i < 12; i++) {
      try {
        fs.rmSync(userData, { recursive: true, force: true })
        console.log('已清理临时 userData')
        return
      } catch (e) {
        await sleep(1000)
        if (i === 11) console.log('userData 清理失败（请手动删除）:', userData, e.message)
      }
    }
  })
