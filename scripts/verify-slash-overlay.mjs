// 运行时验证：助手抽屉里的 `/` 功能浮层和 `@` 引用浮层。
//
// 盯四件在离线测试里看不见的事：
// 1. 面板真的能唤醒（点按钮 / 打 `/` 两条路），也真的能收起；
// 2. 定位父级是对的 —— 往上开、不越出视口、背景不透明（抽屉自带 backdrop-filter）；
// 3. 选中模式项之后：主进程的状态镜像回到界面（徽标 + 轮数），而且没有替人按下发送；
// 4. `@` 浮层挑的是盘上真实的路径：能下钻、能插入、越界的不给选，发出去时展开成人话。
//
// 工作目录本来只能由原生目录选择器交出来，无头环境点不动它 —— 所以额外开一个
// --inspect 口，在主进程里把 dialog.showOpenDialog 换成「就选这个临时项目目录」。
// 附件项点开的是原生文件选择框，这里只验它在清单里，不点。
// 只管理本脚本 spawn 的 electron 进程，用完删临时 userData 和临时项目目录。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
// 端口不能写死：开发中的 Torra 或另一场验证先占了 9417，findPageTarget 就会连到别人的窗口，
// 于是脚本在操作一个它没启动的实例（改端口、点按钮都打在真身上）。空出来才用，占了就往上涨。
const PORT = await freePort(9417)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-slash-'))
// 一个假项目：@ 引用要挑的是盘上真实存在的文件，内存里编不出来
const atRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-at-'))
const outDir = path.join(ROOT, 'docs')

let failures = []
const check = (name, ok, extra) => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? ` · ${JSON.stringify(extra)}` : ''}`)
  if (!ok) failures.push(name)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let ws = null
let wsMain = null
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

async function findPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const main = list.find((t) => t.type === 'page' && /^file:\/\/.*index\.html/.test(t.url || ''))
      if (main) return main
    } catch {
      /* 尚未就绪 */
    }
    await sleep(500)
  }
  throw new Error('未找到渲染层页面目标')
}

async function evalJs(expression, awaitPromise = true) {
  const r = await wsCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) {
    throw new Error('页内执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}

/** 主进程那边（--inspect 口）：无头环境点不动原生目录框，只能进去把 dialog 换掉 */
async function findNodeTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json()
      const node = list.find((t) => t.type === 'node' && t.webSocketDebuggerUrl)
      if (node) return node
    } catch {
      /* 尚未就绪 */
    }
    await sleep(300)
  }
  throw new Error('未找到主进程调试目标（--inspect 没起来？）')
}

async function mainEval(expression) {
  // includeCommandLineAPI 才有 require —— Node 的 --inspect 全局上下文里本来是不带的
  const r = await wsMainCdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    includeCommandLineAPI: true,
  })
  if (r.exceptionDetails) {
    throw new Error('主进程执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}

/**
 * 把原生目录选择器改成「就选这个临时项目目录」。
 *
 * 只换 showOpenDialog，不碰桥里的逻辑：闸门（是不是绝对路径 / 存不存在 / 盘根 / 主目录）
 * 照样在 setWorkDir 里跑，测的还是真那条路。
 */
async function stubDirectoryPicker() {
  return mainEval(
    `(function(){
      try {
        const el = require('electron')
        if (!el || !el.dialog || typeof el.dialog.showOpenDialog !== 'function') return 'no-dialog'
        el.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(atRoot)}] })
        return 'patched'
      } catch (e) { return 'ERR:' + e.message }
    })()`,
  )
}

/** 主进程的流水线日志（最近 300 条）：@ 引用展开了几条只有那里看得到 */
async function pipelineTail() {
  const logJs = path.join(ROOT, 'dist', 'main', 'diagnostics', 'log.js')
  const r = await mainEval(
    `(function(){
      try {
        const m = require(${JSON.stringify(logJs)})
        return { list: (m.diag.tail(300) || []).map((e) => ({ stage: e.stage, ok: e.ok, detail: String(e.detail || '').slice(0, 200) })) }
      } catch (e) { return { err: 'ERR:' + e.message } }
    })()`,
  )
  return r && Array.isArray(r.list) ? { list: r.list, err: null } : { list: [], err: (r && r.err) || '读不到主进程日志' }
}

async function connectMain() {
  const nodeTarget = await findNodeTarget()
  wsMain = new WebSocket(nodeTarget.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    wsMain.addEventListener('open', res)
    wsMain.addEventListener('error', rej)
  })
  wsMainCdp = cdpClient(wsMain)
}

/** 主进程 + 渲染层两端连的是不是同一个实例：靠 argv 里那份临时 userData 自证 */
async function assertOwnInstance() {
  const marker = `--user-data-dir=${userData}`
  const argv = await mainEval(`(process.argv || []).join('\\n')`)
  return String(argv || '').split('\n').includes(marker)
}

let wsCdp = null

/** 窗口被别的窗口完全挡住时 Chromium 不再产帧，截图会一直等到超时：让主进程把它抬起来 */
async function revealWindow() {
  return mainEval(
    `(function(){
      try {
        const el = require('electron')
        let n = 0
        for (const w of el.BrowserWindow.getAllWindows()) {
          if (w.isDestroyed()) continue
          if (w.isMinimized()) w.restore()
          w.show()
          w.moveTop()
          w.focus()
          n++
        }
        return n
      } catch (e) { return 'ERR:' + e.message }
    })()`,
  )
}

async function shot(name) {
  // 两条路轮着试：常规帧 → 越过视口裁剪直接画一张；截图失败不该把整场验证带走
  const variants = [{}, { captureBeyondViewport: true }, {}, { captureBeyondViewport: true }]
  let lastErr = null
  for (const params of variants) {
    try {
      const raised = await revealWindow().catch(() => null)
      if (typeof raised === 'string') console.log('  [窗口抬不起来] ' + raised)
      await wsCdp.send('Page.bringToFront').catch(() => {})
      const r = await wsCdp.send('Page.captureScreenshot', { format: 'png', ...params }, 30000)
      const file = path.join(outDir, name)
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
      console.log('  截图 →', file)
      return
    } catch (e) {
      lastErr = e
      await sleep(1200)
    }
  }
  console.log(`  截图跳过 ${name}: ${lastErr?.message}`)
}

/** 往输入框里写一句话（必须走原生 setter，否则 React 收不到 change） */
async function type(text) {
  await evalJs(
    `(function(){
      const ta=document.querySelector('.assistant-drawer .ac-input');
      const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      ta.focus();
      return true;
    })()`,
    false,
  )
  await sleep(250)
}

async function key(k) {
  await evalJs(
    `(function(){
      const ta=document.querySelector('.assistant-drawer .ac-input');
      ta.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true}));
      return true;
    })()`,
    false,
  )
  await sleep(250)
}

const overlayDom = `(function(){
  const pop=document.querySelector('.a-slash-pop');
  const comp=document.querySelector('.assistant-drawer .ac');
  if(!pop||!comp) return { open: !!pop };
  const pr=pop.getBoundingClientRect(), cr=comp.getBoundingClientRect();
  const bg=getComputedStyle(pop).backgroundColor;
  const cs=getComputedStyle(comp).position;
  const items=[...pop.querySelectorAll('.a-slash-item')].map((b)=>({
    kind: b.querySelector('.a-slash-kind')?.textContent||'',
    label: b.querySelector('.a-pop-main b')?.textContent||'',
    hint: b.querySelector('.a-pop-main i')?.textContent||'',
    off: b.className.includes(' off'),
  }));
  return {
    open: true,
    items,
    empty: pop.querySelector('.a-pop-empty')?.textContent||null,
    foot: pop.querySelector('.a-slash-foot')?.textContent||'',
    titleCmd: pop.querySelector('.a-slash-cmd')?.textContent||'',
    stateLine: pop.querySelector('.a-slash-state')?.textContent||'',
    composerPosition: cs,
    opensUpward: pr.bottom <= cr.top + 1,
    inViewport: pr.top >= 0 && pr.left >= -1 && pr.right <= innerWidth + 1,
    opaque: !/rgba\\(.*[,\\s]0(\\.\\d+)?\\)/.test(bg) && bg !== 'transparent',
    bg,
    maxH: getComputedStyle(pop).maxHeight,
    // 长提示要么收成省略号，要么整行别顶破面板：横向溢出=文字被边缘裁掉
    hScroll: pop.scrollWidth - pop.clientWidth,
    rowsOver: [...pop.querySelectorAll('.a-slash-item')]
      .map((b)=>({
        label: (b.querySelector('.a-pop-main b')?.textContent||'').slice(0,10),
        over: Math.round(b.getBoundingClientRect().right - pr.right),
        ell: (b.querySelector('.a-pop-main i')||{}).scrollWidth
             > (b.querySelector('.a-pop-main i')||{}).clientWidth + 1,
      }))
      .filter((x)=>x.over > 1),
  };
})()`

const badgeDom = `(function(){
  const b=document.querySelector('.assistant-drawer .ac-run');
  return b ? { run: b.getAttribute('data-run'), text: b.textContent||'', counter: b.querySelector('i')?.textContent||'' } : null;
})()`

/** @ 浮层的一眼能看完的状态：标题、每一行的路径 / 类型 / 副标、空态、提示脚 */
const atDom = `(function(){
  const pop=document.querySelector('.a-at-pop');
  if(!pop) return { open:false };
  const rows=[...pop.querySelectorAll('.a-slash-item')].map((b)=>({
    kind: b.querySelector('.a-slash-kind')?.textContent||'',
    path: b.querySelector('.a-pop-main b')?.textContent||'',
    hint: b.querySelector('.a-pop-main i')?.textContent||'',
    active: b.className.includes(' active'),
  }));
  const first=pop.querySelector('.a-pop-main b');
  return {
    open:true, rows,
    cmd: pop.querySelector('.a-slash-cmd')?.textContent||'',
    state: pop.querySelector('.a-slash-state')?.textContent||'',
    empty: pop.querySelector('.a-pop-empty')?.textContent||null,
    foot: pop.querySelector('.a-slash-foot')?.textContent||'',
    mono: first ? getComputedStyle(first).fontFamily : '',
    hScroll: pop.scrollWidth - pop.clientWidth,
  };
})()`

/** @ 浮层里真正的路径候选：末尾那两条「换目录」的行动项不算 */
const atCands = (rows) => (rows || []).filter((r) => r.kind === '目录' || r.kind === '文件')

/** 输入卡片下面常驻的那行「@ 现在从哪儿挑」徽标 */
const rootChipDom = `(function(){
  const b=document.querySelector('.assistant-drawer .a-root');
  return b ? { text: b.textContent||'', title: b.getAttribute('title')||'' } : null
})()`

/** 用按钮把浮层展开（已经开着就不动它，避免点成「收起」） */
async function openPalette() {
  await evalJs(
    `(function(){ if(!document.querySelector('.a-slash-pop')) document.querySelector('.ac-add')?.click(); return true; })()`,
    false,
  )
  await sleep(600)
  return (await evalJs(overlayDom)).open === true
}

/** 按 kind + 标签片段点浮层里的一项 */
async function clickItem(kind, labelPart) {
  const hit = await evalJs(
    `(function(){
      const rows=[...document.querySelectorAll('.a-slash-pop .a-slash-item')];
      const t=rows.find(r=>(r.querySelector('.a-slash-kind')?.textContent||'')===${JSON.stringify(kind)}
        && (r.querySelector('.a-pop-main b')?.textContent||'').includes(${JSON.stringify(labelPart)}));
      if(!t) return false;
      t.click();
      return true;
    })()`,
    false,
  )
  await sleep(700)
  return hit
}

/** 按路径片段点 @ 浮层里的一行（浮层只列工作目录里的真实路径） */
async function clickAtRow(pathPart) {
  const hit = await evalJs(
    `(function(){
      const rows=[...document.querySelectorAll('.a-at-pop .a-slash-item')];
      const t=rows.find(r=>(r.querySelector('.a-pop-main b')?.textContent||'')===${JSON.stringify(pathPart)});
      if(!t) return false;
      t.click();
      return true;
    })()`,
    false,
  )
  await sleep(700)
  return hit
}

const draftVal = `(document.querySelector('.assistant-drawer .ac-input')||{}).value ?? null`

const noteList = `[...document.querySelectorAll('.a-block.a-note')].map((n)=>n.textContent||'')`

/** Windows 的分隔符大小写都可能在解析这一步被规范化过，比较时统一掉 */
const samePath = (a, b) =>
  !!a && !!b && String(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(b).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** 一个够小的假项目：目录在前、文件在后、越界的和二进制各留一个 */
function writeFixtureProject(dir) {
  const w = (rel, content) => {
    const f = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content, 'utf8')
  }
  w('readme.md', '# fixture\n用来验证 @ 引用挑的是盘上真实文件\n')
  w('src/app.ts', 'export const app = 1\n')
  w('src/main/modes.ts', 'export const modes = 2\n')
  w('docs/note.md', 'notes\n')
  w('shot.png', '\x89PNG\r\n\x1a\n genuinely not text\n')
}

async function main() {
  // 盘上先放一条技能：浮层的技能清单读的是 <userData>/torra/pi/skills
  const skillDir = path.join(userData, 'torra', 'pi', 'skills', 'overlay-demo')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: 浮层运行时用例用的技能\n---\n# overlay-demo\n', 'utf8')
  writeFixtureProject(atRoot)

  child = spawn(
    electronBin,
    [`--inspect=${INSPECT_PORT}`, ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|Debugger listening|Debugging suggestion|GPU|gpu|Warning|deprecat/i.test(s)) console.log('[app:err] ' + s)
  })

  // 先自证身份再动手：连错实例的话，后面每个 click 都打在别人身上
  await connectMain()
  const page = await findPageTarget()
  if (!(await assertOwnInstance())) throw new Error('调试口连到的不是本脚本启动的实例，停手')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  wsCdp = cdpClient(ws)
  await wsCdp.send('Runtime.enable')
  await wsCdp.send('Page.enable')
  const pageErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push('EX: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
  })
  await sleep(5000)

  // 挂载 → 关首运行弹窗 → 开抽屉（沿用既有的轮询重试：预热 webview 会让渲染层短暂重载）
  let opened = false
  for (let attempt = 0; attempt < 20 && !opened; attempt++) {
    await evalJs(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>/我已理解|继续使用|知道了|同意/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`).catch(() => false)
    if (!(await evalJs(`!!document.querySelector('.assistant-toggle')`).catch(() => false))) {
      await sleep(1000)
      continue
    }
    await evalJs(`(function(){ const b=document.querySelector('.assistant-toggle'); if(b) b.click(); return true; })()`).catch(() => false)
    for (let i = 0; i < 8; i++) {
      opened = await evalJs(`!!document.querySelector('.assistant-drawer')`).catch(() => false)
      if (opened) break
      await sleep(400)
    }
  }
  if (!opened) {
    console.log('页面错误:', JSON.stringify(pageErrors.slice(0, 8)))
    throw new Error('助手抽屉未打开')
  }
  console.log('助手抽屉已打开\n' + '-'.repeat(46))

  check('浮层开关按钮存在', await evalJs(`!!document.querySelector('.assistant-drawer .ac-add')`))

  // 1) 点按钮唤醒
  await evalJs(`(function(){ document.querySelector('.ac-add').click(); return true; })()`)
  await sleep(600)
  let dom = await evalJs(overlayDom)
  check('点按钮能唤醒面板', dom.open === true, dom && { titleCmd: dom.titleCmd })
  const kinds = [...new Set((dom.items || []).map((i) => i.kind))]
  check('面板里有四类功能', ['模式', '附件', '引用', '工作目录'].every((k) => kinds.includes(k)), kinds)
  check('读取授权的老项已经不在了', !/授权/.test((dom.items || []).map((i) => i.label).join(' ')), (dom.items || []).map((i) => i.label))
  check(
    '技能项来自盘上的清单',
    (dom.items || []).some((i) => i.kind === '技能' && i.label.includes('overlay-demo')),
    (dom.items || []).filter((i) => i.kind === '技能'),
  )
  check(
    '加载开关没开时技能是灰的并给出理由',
    (dom.items || []).filter((i) => i.kind === '技能').every((i) => i.off && /加载技能/.test(i.hint)),
  )
  check('定位父级是输入卡片', dom.composerPosition === 'relative', dom.composerPosition)
  check('面板往上开', dom.opensUpward === true)
  check('面板不越出视口', dom.inViewport === true)
  check('面板背景不透明', dom.opaque === true, dom.bg)
  check('有键盘操作提示', /Enter/.test(dom.foot || ''), dom.foot)
  check('标题行显示当前模式', !!dom.stateLine, dom.stateLine)
  check('面板没有横向溢出', dom.hScroll === 0, dom.hScroll)
  check('长提示收成省略号、不顶破面板', (dom.rowsOver || []).length === 0, dom.rowsOver)
  // 超出宽度的行必须是在自己框里被省略号截断（整行裁切看起来像文字丢了）
  const rowStats = await evalJs(`(function(){
    const pop=document.querySelector('.a-slash-pop'); const pr=pop.getBoundingClientRect();
    return [...pop.querySelectorAll('.a-pop-main i')].map((i)=>({
      cut: i.scrollWidth > i.clientWidth + 1,
      inside: i.getBoundingClientRect().right <= pr.right + 1,
      endsWithEll: getComputedStyle(i).textOverflow === 'ellipsis',
    }));
  })()`)
  check(
    '每一行都在面板内，超宽的走省略号',
    rowStats.every((r) => r.inside && (!r.cut || r.endsWithEll)),
    rowStats,
  )
  await shot('verify-slash-open.png')

  // 2) 打 `/` 也能唤醒；输入普通文字就收起
  await type('随便说点什么')
  check('输入普通文字时面板不碍事', (await evalJs(overlayDom)).open === false)
  await type('/')
  check('打 / 能唤醒面板', (await evalJs(overlayDom)).open === true)
  await type('/目')
  const filtered = await evalJs(overlayDom)
  check('按输入过滤', filtered.titleCmd === '/目' && filtered.items.every((i) => /目|模式|目标/.test(i.label + i.kind + i.hint)), filtered.items.map((i) => i.label))
  await type('/zzz-nothing')
  const none = await evalJs(overlayDom)
  check('无匹配时给空态而不是空白', /没有匹配/.test(none.empty || ''), none.empty)
  await shot('verify-slash-filter.png')
  await key('Escape')
  check('Esc 收起面板', (await evalJs(overlayDom)).open === false)
  check(
    '过滤到 0 项时 Esc 也只收浮层',
    await evalJs(`!!document.querySelector('.assistant-drawer .ac-input')`),
  )
  // 有清单可筛选时同样只收浮层
  await type('/')
  await key('Escape')
  check(
    '有匹配项时 Esc 收浮层并留着抽屉',
    (await evalJs(overlayDom)).open === false &&
      (await evalJs(`!!document.querySelector('.assistant-drawer .ac-input')`)),
  )
  await type('')

  // 3) 键盘导航：↑↓ 移动高亮，Enter 就用高亮那一项
  await type('/')
  const first = await evalJs(`document.querySelector('.a-slash-pop .a-slash-item')?.textContent||''`)
  await key('ArrowDown')
  const active = await evalJs(`document.querySelector('.a-slash-pop .a-slash-item.active')?.textContent||''`)
  check('↑ 会把高亮从第一项移开', !!active && active !== first && /计划模式/.test(active), active.slice(0, 20))
  await key('Enter')
  let badge = await evalJs(badgeDom)
  check('Enter 用的就是高亮项', badge?.run === 'plan', badge)
  const draftAfterEnter = await evalJs(`document.querySelector('.ac-input').value`)
  check('选模式不替人发送', draftAfterEnter === '' && (await evalJs(`!document.querySelector('.assistant-drawer .a-user')`)), { draftAfterEnter })

  // 4) 目标模式：空手进 = 下一条消息当目标；带着草稿进 = 草稿就是目标
  await openPalette()
  await clickItem('模式', '目标模式')
  let snap = await evalJs(`window.torra.assistantOverlay()`)
  check('进目标模式但不设目标', snap?.mode?.mode === 'goal' && snap.mode.goal === undefined, snap?.mode)
  check('目标模式不留计划锁', snap?.mode?.planLocked !== true, snap?.mode)
  badge = await evalJs(badgeDom)
  check('徽标带轮数上限', badge?.run === 'goal' && /\/\s*8/.test(badge?.counter || ''), badge)

  await openPalette()
  await clickItem('模式', '回到普通对话')
  await type('把 deepseek 的选择器修好')
  await openPalette()
  await clickItem('模式', '目标模式')
  snap = await evalJs(`window.torra.assistantOverlay()`)
  check('草稿被当作目标交给主进程', snap?.mode?.mode === 'goal' && /deepseek/.test(snap.mode.goal || ''), snap?.mode?.goal)
  check(
    '带目标进模式后草稿留着，等人按一下开始',
    (await evalJs(`document.querySelector('.ac-input').value`)) === '把 deepseek 的选择器修好',
  )
  await shot('verify-slash-goal.png')

  // 4b) 目标模式一步切到计划模式（不用先退普通对话），旧目标要被丢下
  check('浮层能再展开', await openPalette())
  await clickItem('模式', '计划模式')
  badge = await evalJs(badgeDom)
  check('计划模式徽标 + 只读标记', badge?.run === 'plan' && /只读/.test(badge.text), badge)
  snap = await evalJs(`window.torra.assistantOverlay()`)
  check('切模式把上一档的目标丢下', snap?.mode?.goal === undefined, snap?.mode?.goal)
  await shot('verify-slash-plan.png')

  // 5) 回到普通对话：徽标消失，浮层里的模式项跟着换回来
  await openPalette()
  await clickItem('模式', '回到普通对话')
  check('切回普通对话后徽标消失', (await evalJs(badgeDom)) === null)
  await openPalette()
  dom = await evalJs(overlayDom)
  check(
    '浮层里的模式项跟着变',
    dom.open && dom.items.some((i) => i.label === '目标模式') && dom.items.some((i) => i.label === '计划模式') && !dom.items.some((i) => i.label === '回到普通对话'),
    dom.items?.map((i) => i.label),
  )
  check('普通对话下没有「执行这份计划」', !dom.items.some((i) => i.label.includes('执行')), dom.items?.map((i) => i.label))

  // 6) 技能项：开关状态要从主进程现取 —— 关着时浮层给的不该是「去设置页」，而是一条就地打开的开关
  const pdGray = await evalJs(overlayDom)
  const flagRow = (pdGray.items || []).find((i) => i.kind === '开关')
  check('开关关着时给一条一键打开', !!flagRow && /加载技能/.test(flagRow.label || '') && !flagRow.off, flagRow)
  check(
    '这时候技能项是灰的，说的也是同一个开关',
    (pdGray.items || []).some((i) => i.kind === '技能' && i.off && /开关/.test(i.hint || '')),
    (pdGray.items || []).filter((i) => i.kind === '技能'),
  )
  check('点开关这一条', await clickItem('开关', '加载技能'))
  check('浮层能再展开', await openPalette())
  const pdOn = await evalJs(overlayDom)
  const skillRow = (pdOn.items || []).find((i) => i.kind === '技能')
  check('点一下开关就把技能放开了', skillRow && !skillRow.off, skillRow)
  check('开着的时候不再重复给那条开关', !(pdOn.items || []).some((i) => i.kind === '开关'), pdOn.items?.map((i) => i.kind))
  await clickItem('技能', 'overlay-demo')
  const d2 = await evalJs(`document.querySelector('.ac-input').value`)
  check('技能项写的是 /技能 前缀', /^\/技能\s+overlay-demo\s*$/.test(d2), JSON.stringify(d2))
  const r1 = await evalJs(`window.torra.assistantSend('/技能 没这条 帮我看看')`)
  check('未知技能名以可执行原因拒绝', r1?.ok === false && /技能目录里没有/.test(r1.reason || ''), r1)
  await evalJs(`window.torra.assistantSetExtensions(false)`)
  await type('')

  // 7) 撤销项跟着读取授权走：现在一条授权都还没给，就不该有得撤
  check('浮层能再展开', await openPalette())
  const kinds2 = [...new Set(((await evalJs(overlayDom)).items || []).map((i) => i.kind))]
  check('撤销项只在有授权时才出现', !kinds2.includes('撤销'), kinds2)
  await key('Escape')
  await type('')

  // 8) @ 引用：浮层列的是盘上真实的路径，边界由主进程守，展开结果进流水线日志
  //    工作目录只能由原生目录框交出来，无头环境点不动 —— 借 --inspect 口把它换掉
  const patched = await stubDirectoryPicker()
  check('主进程的目录选择器已接到临时项目目录', patched === 'patched', patched)

  await type('@')
  let at = await evalJs(atDom)
  check('打 @ 唤醒引用浮层', at.open === true && at.cmd === '@', { cmd: at.cmd, rows: (at.rows || []).length })
  // 默认浏览根：一个目录都没挑过，@ 也要当场列得出东西 —— 那一个是助手自己的数据目录
  const roots0 = await evalJs(`window.torra.assistantOverlay()`)
  check(
    '没挑过目录时浏览根就是助手目录',
    !!roots0?.workDir && samePath(roots0.workDir, roots0.defaultWorkDir) && /torra$/i.test(roots0.workDir),
    roots0,
  )
  check('浮层标题把这层明说成「助手目录」', at.state === `助手目录 · ${path.basename(roots0?.workDir || '')}`, at.state)
  const cand0 = atCands(at.rows)
  check('默认根开箱就列得出候选', cand0.length > 0, at.rows)
  check('凭据目录既不列出来也不给选', !cand0.some((r) => /^keys/i.test(r.path)), cand0.map((r) => r.path))
  check('引用浮层没有横向溢出', at.hScroll === 0, at.hScroll)
  const chip0 = await evalJs(rootChipDom)
  check('卡片下面常驻的那行报的是同一个根', !!chip0 && chip0.text.includes(path.basename(roots0?.workDir || '')), chip0)
  await shot('verify-at-default-root.png')

  // 挑不到东西时的出路是当场给两条可点的，而不是「你先去做件别的事」
  await type('@zzz')
  await sleep(400)
  at = await evalJs(atDom)
  check(
    '对不上的前缀列不出候选，并说一句为什么',
    at.open === true && atCands(at.rows).length === 0 && /没有对得上/.test(at.empty || ''),
    { rows: at.rows, empty: at.empty },
  )
  check('这时候给的是「挑一个项目目录」', (at.rows || []).some((r) => r.path === '挑一个项目目录'), at.rows)
  await shot('verify-at-need-workdir.png')

  check('点它就走通了选目录那条路', (await clickAtRow('挑一个项目目录')) === true)
  const snap3 = await evalJs(`window.torra.assistantOverlay()`)
  check('工作目录落在主进程这一场会话里', samePath(snap3?.workDir, atRoot), snap3?.workDir)
  await type('@')
  let paths = []
  for (let i = 0; i < 12; i++) {
    at = await evalJs(atDom)
    paths = (at.rows || []).map((r) => r.path)
    if (paths.length) break
    await sleep(400)
  }
  check('选好之后浮层里换成了盘上的候选', paths.join(' ') === 'docs/ src/ readme.md shot.png', paths)
  check('目录排在文件前面', at.rows[0].kind === '目录' && at.rows[2].kind === '文件', at.rows.map((r) => r.kind))
  check('标题行报的是工作目录这一层', at.state === path.basename(atRoot), { state: at.state, want: path.basename(atRoot) })
  check('路径用等宽字', /mono|consolas|menlo|courier/i.test(at.mono || ''), at.mono)
  check('文件行报大小、目录行报往里走', /KB|B/.test(at.rows[2].hint) && /往里/.test(at.rows[0].hint), at.rows.map((r) => r.hint))
  const chip1 = await evalJs(rootChipDom)
  check('换了目录后卡片下面那行跟着走', !!chip1 && chip1.text.includes(path.basename(atRoot)) && chip1.title.includes(atRoot), chip1)
  await shot('verify-at-list.png')

  await type('@src/')
  await sleep(400)
  at = await evalJs(atDom)
  const srcPaths = (at.rows || []).map((r) => r.path)
  check('打前缀只留这一层里对得上的', at.cmd === '@src/' && srcPaths.join(' ') === 'src/main/ src/app.ts', { cmd: at.cmd, srcPaths })
  await key('Enter')
  let draft = await evalJs(draftVal)
  check('回车在目录上是往里走，不是收尾', draft === '@src/main/', JSON.stringify(draft))
  at = await evalJs(atDom)
  check('进去以后列的是这一层', at.open === true && (at.rows || []).length === 1 && at.rows[0].path === 'src/main/modes.ts', at.rows)
  await key('Enter')
  draft = await evalJs(draftVal)
  check('回车在文件上把路径写进草稿并收起', draft === '@src/main/modes.ts ', JSON.stringify(draft))
  check('挑完文件浮层让位给输入', (await evalJs(atDom)).open === false)

  await type('@docs/')
  await sleep(400)
  check('挑目录时也能用 Esc 收', (await evalJs(atDom)).open === true)
  await key('Escape')
  draft = await evalJs(draftVal)
  check(
    'Esc 只收浮层：草稿留着、抽屉还开着',
    (await evalJs(atDom)).open === false &&
      draft === '@docs/' &&
      (await evalJs(`!!document.querySelector('.assistant-drawer .ac-input')`)),
    { draft },
  )

  await type('联系邮箱是 a@b.com')
  check('邮箱里的 @ 不唤醒浮层', (await evalJs(atDom)).open === false)
  await type('看 @C:/Windows')
  await sleep(400)
  at = await evalJs(atDom)
  check('绝对路径不落进工作目录：一个都不给选', at.open === true && atCands(at.rows).length === 0 && /只能落在工作目录里面/.test(at.empty || ''), at.empty)
  await type('看 @../')
  await sleep(400)
  at = await evalJs(atDom)
  check('往上跳的 .. 也挑不到东西', at.open === true && atCands(at.rows).length === 0, { rows: atCands(at.rows), empty: at.empty })

  // 发出去那一下：越界的要当面说一句，落在里面的要真展开。
  // 这个临时 profile 里没有可用的 API 模型，回合会在展开之后才失败 —— 于是展开结果
  // 只剩流水线日志这一处看得到，正好借 --inspect 口去读它。
  await type('')
  const notesBefore = await evalJs(noteList)
  const rOut = await evalJs(`window.torra.assistantSend('这个 @../windows 里有什么')`)
  await sleep(600)
  const notesAfter = await evalJs(noteList)
  check(
    '越界的引用发出去时会当面说一句',
    notesAfter.length > notesBefore.length && notesAfter.some((t) => /不在工作目录里面/.test(t)),
    notesAfter.slice(notesBefore.length),
  )
  check('说一句之后消息照走，不被引用拒掉吞了', rOut && typeof rOut.ok === 'boolean' && typeof rOut.reason === 'string', rOut)

  const refBefore = (await pipelineTail()).list.filter((e) => e.stage === 'assistant:at-ref').length
  await evalJs(`window.torra.assistantSend('这个 @readme.md 讲了什么')`)
  await sleep(700)
  const { list: tail, err: tailErr } = await pipelineTail()
  const refs = tail.filter((e) => e.stage === 'assistant:at-ref')
  check(
    '落在工作目录里的引用真的展开进了消息',
    refs.length > refBefore && refs.some((e) => /1 个引用已展开/.test(e.detail)),
    { 新增: refs.length - refBefore, 最近: refs.slice(-2), err: tailErr },
  )

  // 8.5) 收回授权后，@ 不该变成「没有起点」：回到助手目录，同时把上次那个项目留成一行可点的「继续用」
  const revoked = await evalJs(`window.torra.assistantRevokeDir(${JSON.stringify(atRoot)})`)
  check('撤销这个项目目录的读取授权', revoked?.ok === true, revoked)
  const roots1 = await evalJs(`window.torra.assistantOverlay()`)
  check('撤销后浏览根回到助手目录', samePath(roots1?.workDir || '', roots1?.defaultWorkDir || ''), roots1)
  check('记住的那个项目成了「继续用」的候选', samePath(roots1?.recentWorkDir || '', atRoot), roots1?.recentWorkDir)
  check('浮层能再展开', await openPalette())
  const pd2 = await evalJs(overlayDom)
  check(
    '/ 浮层里给出「继续用「...」」那一条',
    (pd2.items || []).some((i) => i.kind === '工作目录' && i.label.startsWith('继续用') && i.label.includes(path.basename(atRoot))),
    (pd2.items || []).filter((i) => i.kind === '工作目录').map((i) => i.label),
  )
  await shot('verify-at-recent-workdir.png')
  await key('Escape')
  await type('')
  check('浮层能再展开', await openPalette())
  check('点「继续用」不用开选择器就把授权拿回来', await clickItem('工作目录', '继续用'), await evalJs(rootChipDom))
  const roots2 = await evalJs(`window.torra.assistantOverlay()`)
  check(
    '一键下去：浏览根回到那个项目，读取授权同时跟上',
    samePath(roots2?.workDir || '', atRoot) && (roots2?.mode?.readDirs || []).length === 1,
    roots2,
  )
  check('这一场里既记住了它、又不重复给候选', !roots2?.recentWorkDir, roots2?.recentWorkDir)

  // 9) 附件那一项点开的是原生文件框，这里只验它在清单里
  check('浮层能再展开', await openPalette())
  const pd = await evalJs(overlayDom)
  const kinds3 = [...new Set((pd.items || []).map((i) => i.kind))]
  check('附件项还在清单里', kinds3.includes('附件'), kinds3)
  check('工作目录定了之后才有得撤', kinds3.includes('撤销'), kinds3)
  check(
    '引用与工作目录两项报的是当前这个目录',
    (pd.items || []).filter((i) => i.kind === '引用' || i.kind === '工作目录').every((i) => i.hint.includes(path.basename(atRoot))),
    (pd.items || []).filter((i) => i.kind === '引用' || i.kind === '工作目录').map((i) => i.hint),
  )

  // 10) 盘上一条技能都没有：浮层要当场说出来，并给一条点得动的出路
  const skillsRoot = path.join(userData, 'torra', 'pi', 'skills')
  fs.renameSync(skillsRoot, `${skillsRoot}.off`)
  try {
    await key('Escape')
    await type('')
    check('浮层能再展开', await openPalette())
    const pd3 = await evalJs(overlayDom)
    const none = (pd3.items || []).find((i) => i.kind === '设置')
    check('技能为空是一条看得见的说明，不是静默没有', !!none && /一条都还没有/.test(none.label || ''), (pd3.items || []).map((i) => i.kind))
    check('说明里说清去哪儿导入', /设置页/.test(none?.hint || '') && /导入/.test(none?.hint || ''), none?.hint)
    check('没有技能时不再给灰技能项和开关项', !(pd3.items || []).some((i) => i.kind === '技能' || i.kind === '开关'), (pd3.items || []).map((i) => i.label))
    // 摆位本身也是这条改动的目的：能力类的行不能被范围类挤到要滚动才看得见
    const noneRect = await evalJs(
      `(function(){
        const pop=document.querySelector('.a-slash-pop');
        const t=[...pop.querySelectorAll('.a-slash-item')].find(r=>(r.querySelector('.a-slash-kind')?.textContent||'')==='设置');
        if(!t) return null;
        const pr=pop.getBoundingClientRect(), tr=t.getBoundingClientRect();
        return { inView: tr.top>=pr.top-1 && tr.bottom<=pr.bottom+1, scrolled: pop.scrollTop };
      })()`,
      false,
    )
    check('空态那条不用滚动就在这一屏里', noneRect?.inView === true && noneRect.scrolled === 0, noneRect)
    await shot('verify-slash-no-skills.png')
    check(
      '点空态那条真的把人送到设置页',
      (await clickItem('设置', '一条都还没有')) === true && (await evalJs(`!!document.querySelector('.settings-tabs')`)) === true,
      await evalJs(`document.querySelector('.a-slash-pop')?.textContent||'(浮层已收)'`),
    )
  } finally {
    fs.renameSync(`${skillsRoot}.off`, skillsRoot)
  }

  const errs = pageErrors.filter((e) => e.startsWith('EX:'))
  check('全程没有页面异常', errs.length === 0, errs.slice(0, 3))

  console.log('-'.repeat(46))
  if (failures.length) {
    console.log(`失败 ${failures.length} 项：${failures.join(' / ')}`)
    process.exitCode = 1
  } else console.log('全部通过')
}

main()
  .catch((e) => {
    console.error('验证失败:', e.message)
    process.exitCode = 1
  })
  .finally(() => {
    try {
      ws && ws.close()
    } catch {}
    try {
      wsMain && wsMain.close()
    } catch {}
    try {
      if (child && !child.killed) child.kill('SIGTERM')
    } catch {}
    try {
      fs.rmSync(userData, { recursive: true, force: true })
    } catch {}
    try {
      fs.rmSync(atRoot, { recursive: true, force: true })
    } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 800)
  })
