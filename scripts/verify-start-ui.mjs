// 开场页（ns- 层）运行时验证：独立 userData 起真实构建产物，明暗两主题各出一张图，
// 并检查「横向溢出 / 旧类名残留 / 墨色是否落在可见区间 / 胶囊-开关-档位点了要不要变」。
// 只管理本脚本 spawn 的 electron 进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-start-'))
const outDir = path.join(ROOT, 'docs')

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
  for (let p = 9430; p < 9440; p++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(600) })
      if (res.ok) continue
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
    } catch {}
    await sleep(500)
  }
  throw new Error('未找到渲染层页面目标')
}

async function run(expression, awaitPromise = true) {
  const r = await global.__cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails)
    throw new Error('页内执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function shot(name) {
  const r = await global.__cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'))
  console.log('  截图 →', name)
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true })
  const PORT = await pickPort()
  console.log('调试端口', PORT)
  child = spawn(electronBin, [ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'], {
    stdio: ['ignore', 'pipe', 'pipe'],
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
    mounted = await run(`!!document.querySelector('.ns-scroll')`)
    if (mounted) break
    await sleep(500)
  }
  console.log('开场页就绪:', mounted)
  if (!mounted) {
    await shot('start-diag-unmounted.png').catch(() => {})
    throw new Error('开场页未挂载')
  }
  await run(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>/我已理解|继续使用|知道了|同意/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`)
  await sleep(500)

  const fail = []
  for (const theme of ['light', 'dark']) {
    await run(`document.documentElement.setAttribute('data-theme','${theme}'); '${theme}'`)
    await sleep(350)

    const diag = await run(`(function(){
      const scroll = document.querySelector('.ns-scroll');
      const col = document.querySelector('.ns-col');
      if(!scroll||!col) return {err:'骨架缺失'};
      const overflow = scroll.scrollWidth - scroll.clientWidth;
      const wide = [...scroll.querySelectorAll('*')].filter(el=>{
        const r=el.getBoundingClientRect(); return r.right > scroll.getBoundingClientRect().right+1 && r.width>0;
      }).map(el=>el.className).filter(String).slice(0,4);
      const sr = scroll.getBoundingClientRect(), fr = document.querySelector('.ns-foot').getBoundingClientRect();
      const inkSample = ['.ns-h1','.ns-sec-title','.ns-sec-note','.ns-row-name','.ns-row-desc','.ns-chip','.ns-num-label','.ns-num-unit','.ns-foot-hint']
        .map(sel=>{ const el=scroll.querySelector(sel); if(!el) return null;
          const cs=getComputedStyle(el); return {sel, color: cs.color, size: cs.fontSize}; })
        .filter(Boolean);
      return {
        overflow, wide,
        footVisible: fr.bottom <= sr.bottom + 1 && fr.top >= sr.top - 1, footH: Math.round(fr.height),
        legacy: [...document.querySelectorAll('.empty-card,.check-grid,.strategy-grid,.strategy-choice,.start-scroll,.start-kicker,.start-lede,.check-item')].length,
        inline: [...scroll.querySelectorAll('[style]')].filter(el=>/background|color/.test(el.getAttribute('style')||'')).map(el=>el.getAttribute('style')).slice(0,5),
        counts: { secs: scroll.querySelectorAll('.ns-sec').length, chips: scroll.querySelectorAll('.ns-chip').length,
                  rows: scroll.querySelectorAll('.ns-row').length, switches: scroll.querySelectorAll('.ns-switch').length,
                  segs: scroll.querySelectorAll('.ns-seg-item').length, nums: scroll.querySelectorAll('.ns-num').length },
        chipStates: [...scroll.querySelectorAll('.ns-chip')].map(el => el.className + '|' + el.textContent.trim()),
        disabled: { go: document.querySelector('.ns-go').disabled, hint: document.querySelector('.ns-foot-hint')?.textContent },
        inkSample,
      };
    })()`)
    const label = `${theme}`
    console.log(label, JSON.stringify(diag))
    if (diag.err) fail.push(`${label}: ${diag.err}`)
    if (diag.overflow > 1) fail.push(`${label}: 横向溢出 ${diag.overflow}px ${JSON.stringify(diag.wide)}`)
    if (!diag.footVisible) fail.push(`${label}: 常驻底栏没落在可视区`)
    if (diag.legacy > 0) fail.push(`${label}: 仍有 ${diag.legacy} 个旧类名节点`)
    if (diag.inline.length) fail.push(`${label}: 残留内联颜色 ${JSON.stringify(diag.inline)}`)
    for (const [k, want] of [['secs', 6], ['chips', 5], ['rows', 4], ['switches', 3], ['segs', 6], ['nums', 4]]) {
      const got = diag.counts?.[k]
      if (typeof got === 'number' && got < want) fail.push(`${label}: ${k} 只有 ${got}，期望 ≥${want}`)
    }
    for (const s of diag.inkSample || []) {
      const m = /rgba?\((\d+), (\d+), (\d+)/.exec(s.color)
      if (!m) continue
      const lum = (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255
      const ok = theme === 'light' ? lum < 0.75 : lum > 0.25
      if (!ok) fail.push(`${label}: ${s.sel} 文字色 ${s.color} 在该主题下看不见`)
    }
    await shot(`start-${theme}.png`)

    if (theme === 'light') {
      // 交互取证：开关、核验档位、议题输入点了必须真的变，否则「看起来能按」和「按不动」在截图上长得一样
      const inter = await run(`(async function(){
        const wait = (ms) => new Promise(r=>setTimeout(r,ms));
        const row = document.querySelector('button.ns-row');
        const s0 = row.querySelector('.ns-switch').classList.contains('on');
        row.click(); await wait(150);
        const s1 = document.querySelector('button.ns-row').querySelector('.ns-switch').classList.contains('on');

        const tight = [...document.querySelectorAll('.ns-seg.tight .ns-seg-item')];
        tight[0].click(); await wait(150);
        const onIdx = [...document.querySelectorAll('.ns-seg.tight .ns-seg-item')].findIndex(el=>el.classList.contains('on'));

        const topic = document.querySelector('.ns-topic');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(topic), 'value').set;
        setter.call(topic, '评估为报表系统引入实时计算层的必要性');
        topic.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(150);
        return { sw: [s0,s1], onIdx, goDisabled: document.querySelector('.ns-go').disabled,
                 hint: document.querySelector('.ns-foot-hint')?.textContent,
                 sum: document.querySelector('.ns-foot-sum')?.textContent };
      })()`)
      console.log('  交互', JSON.stringify(inter))
      if (inter.sw[0] === inter.sw[1]) fail.push('点开关行没改变状态')
      if (inter.onIdx !== 0) fail.push('核验档位点「关闭」后没选中（onIdx=' + inter.onIdx + '）')
      if (!inter.hint || !String(inter.hint).includes('还差')) fail.push('议题已填但没选模型时底栏没说缺什么：' + inter.hint)

      /*
       * 参与胶囊单独一段：没登录的网页模型点下去会换成网页视图，页面就离开了开场页 ——
       * 这正是新交互要保证的事，所以放到最后测，测完再回来。
       */
      const chipTest = await run(`(async function(){
        const wait = (ms) => new Promise(r=>setTimeout(r,ms));
        const sel = '.ns-chip:not(.blocked)';
        const chip = document.querySelector(sel);
        if (chip) {
          const b0 = chip.classList.contains('on');
          chip.click(); await wait(150);
          const b1 = document.querySelector(sel).classList.contains('on');
          document.querySelector(sel).click(); await wait(150);
          return { kind: 'toggle', got: [b0, b1, document.querySelector(sel).classList.contains('on')] };
        }
        const blocked = document.querySelector('.ns-chip.blocked');
        if (!blocked) return { kind: 'none' };
        const name = blocked.textContent.trim();
        blocked.click(); await wait(900);
        const switched = !document.querySelector('.ns-scroll');
        if (switched) {
          // 网页视图是内嵌层，收掉它才回到开场页 —— 这条回来的路本身也是要被验的
          document.querySelector('[title=\"关闭网页视图\"]')?.click();
          await wait(900);
        }
        return { kind: 'blocked→网页视图', name, switched, 回来: !!document.querySelector('.ns-scroll') };
      })()`)
      console.log('  胶囊', JSON.stringify(chipTest))
      if (chipTest.kind === 'toggle' && new Set(chipTest.got).size !== 2) fail.push('点胶囊没改变选中态')
      if (chipTest.kind === 'none') fail.push('一颗参与胶囊都没有')
      if (chipTest.kind === 'blocked→网页视图' && (!chipTest.switched || !chipTest.回来))
        fail.push('点未登录的胶囊没能领去登录页（或回不来）：' + JSON.stringify(chipTest))
      await shot('start-interacted-light.png')
      // 表单在中下部：不滚下去看，胶囊/开关行/数值字段/底栏全在画外
      await run(`document.querySelector('.ns-scroll').scrollTo({top: 520, behavior:'instant'}); 1`)
      await sleep(300)
      await shot('start-form-light.png')
      await run(`const el=document.querySelector('.ns-scroll'); el.scrollTo({top: el.scrollHeight, behavior:'instant'}); 1`)
      await sleep(300)
      await shot('start-foot-light.png')
    }
  }

  console.log('页面错误:', pageErrors.length ? pageErrors.slice(0, 8) : '无')
  if (pageErrors.length) fail.push('渲染层报错 ' + pageErrors.length + ' 条')
  console.log(fail.length ? 'FAIL:\n' + fail.join('\n') : 'PASS：开场页两套主题结构 + 交互检查通过')
  if (ws) ws.close()
}

main()
  .catch((e) => console.error('验证失败:', e.message))
  .finally(async () => {
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
