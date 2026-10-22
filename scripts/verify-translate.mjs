// 端到端验证翻译屏（真实 Electron + 真实 Index-Translate 公共端点）
//
// 一次跑完下面这几件事，任何一件都要能看见：
// 1. 翻译屏真的能打开（lazy 屏的 Suspense 边界没有漏掉它）
// 2. 原文框、输出框、拖放上传区、设置面板各就各位
// 3. 失败要说人话，不能把失败静默成空白
// 4. 主题切换不能把翻译屏弄坏
//
// 整个验证过程用临时 userData 目录，只读脚本 spawn 一个 electron 进程。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = await freePort(9441)
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-translate-'))
const outDir = path.join(ROOT, '.autopilot', 'translate')

let failures = []
const check = (name, ok, extra) => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? `  · ${JSON.stringify(extra)}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let ws = null
let wsCdp = null

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
    send(method, params = {}, timeoutMs = 20000) {
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
      /* 还没起来 */
    }
    await sleep(400)
  }
  throw new Error(kind === 'page' ? '未找到渲染页面目标' : '未找到主进程调试目标')
}

async function connect(url) {
  const sock = new WebSocket(url)
  await new Promise((res, rej) => {
    sock.addEventListener('open', res)
    sock.addEventListener('error', rej)
  })
  return sock
}

async function evalJs(expression, awaitPromise = true) {
  const r = await wsCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) {
    throw new Error(
      '页面执行异常: ' +
        JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text),
    )
  }
  return r.result.value
}

async function shot(name) {
  // 截图偶尔会因为页面还在加载资源而卡住，重试几次再放弃
  for (let i = 0; i < 3; i++) {
    try {
      const r = await wsCdp.send('Page.captureScreenshot', { format: 'png' }, 40000)
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'))
      return
    } catch (e) {
      if (i === 2) throw e
      await sleep(1200)
    }
  }
}

/** 轮询直到表达式为真 */
async function waitFor(expr, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs
  let last = null
  while (Date.now() < until) {
    last = await evalJs(expr, false).catch(() => null)
    if (last) return last
    await sleep(400)
  }
  return last
}

/** 读取翻译屏当前可见状态 */
const TR_READ = `(function(){
  const q=(s)=>document.querySelector(s);
  const n=(s)=>document.querySelectorAll(s).length;
  // 空状态时译文栏只有占位文案，没有 .md；拿到 .md 才算真的有译文
  const out=q('.tr-out .md');
  const err=q('.tr-error');
  const page=q('.tr-page');
  const split=q('.tr-split-body');
  return {
    present: !!page,
    // 满屏双栏：左右铺满，不能留白
    fullBleed: !!page && page.clientHeight > 200 && page.scrollWidth - page.clientWidth <= 0,
    splitVisible: !!split && split.getBoundingClientRect().height > 200,
    panes: n('.tr-split-body > .tr-pane'),
    divider: n('.tr-split-body > .tr-divider'),
    // 顶部：两个语言 chip + 一个交换按钮
    langChips: n('.tr-bar-langs .tr-chip'),
    langs: n('.tr-bar-langs .tr-select'),
    swap: !!q('.tr-swap'),
    submit: q('.tr-run')?.textContent?.trim()||'',
    submitDisabled: q('.tr-run')?.disabled ?? null,
    drop: !!q('.tr-drop'),
    // 模型面板收在齿轮里，首屏不该占正文
    modelsOnFirstScreen: n('.tr-model'),
    modelPill: q('.tr-model-pill')?.textContent?.trim()||'',
    hasTextarea: !!q('.tr-textarea'),
    placeholder: q('.tr-textarea')?.getAttribute('placeholder')||'',
    out: out?.textContent?.trim()||'',
    outVisible: !!out,
    err: err?.querySelector('.tr-error-title')?.textContent?.trim()||'',
    errDetail: err?.querySelector('.tr-error-detail')?.textContent?.trim()||'',
    errVisible: !!err,
    overflow: page ? page.scrollWidth - page.clientWidth : -1,
  };
})()`

async function main() {
  child = spawn(
    electronBin,
    [
      `--inspect=${INSPECT_PORT}`,
      ROOT,
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|Debugger listening|Debugging suggestion|GPU|gpu|Warning|deprecat/i.test(s))
      console.log('[app:err] ' + s)
  })

  const page = await findTarget('page')
  ws = await connect(page.webSocketDebuggerUrl)
  wsCdp = cdpClient(ws)
  await wsCdp.send('Runtime.enable')
  await wsCdp.send('Page.enable')
  const pageErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push(
        'EX: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text),
      )
  })
  await sleep(5000)

  // 关掉所有可能挡住视线的弹窗
  for (let i = 0; i < 10; i++) {
    const clicked = await evalJs(
      `(function(){const b=[...document.querySelectorAll('.modal-mask button')].find(x=>/继续|知道了|确定/.test(x.textContent||''));if(b){b.click();return true}return false})()`,
      false,
    )
    if (clicked) {
      await sleep(500)
      continue
    }
    break
  }
  console.log('-'.repeat(46))

  // 1) 能进翻译屏
  const toTranslate = await evalJs(
    `(function(){const b=[...document.querySelectorAll('nav.app-nav button')].find(x=>(x.textContent||'').trim()==='翻译');if(!b)return false;b.click();return true})()`,
    false,
  )
  check('导航里有「翻译」这一项且点得到', toTranslate === true)
  const present = await waitFor(`!!document.querySelector('.tr-page')`)
  check('翻译屏真的挂上了（lazy 屏的 Suspense 边界没漏掉它）', present === true)

  let tr = await evalJs(TR_READ, false)
  check(
    '满屏双栏布局生效',
    tr.fullBleed === true && tr.splitVisible === true && tr.panes === 2 && tr.divider === 1,
    tr,
  )
  check('顶部有源语言、目标语言与交换按钮', tr.langChips === 2 && tr.langs === 2 && tr.swap === true, tr)
  check('三枚模型收进设置面板，首屏不占正文', tr.modelsOnFirstScreen === 0 && tr.modelPill === '35B-A3B', tr)
  check('底部拖放上传区存在，占位文案对齐截图', tr.drop === true && tr.placeholder === '请输入文本…', tr)
  check('空文本且无图片时提交按钮禁用', tr.submitDisabled === true, tr.submit)
  check('页面没有横向溢出', tr.overflow <= 0, { overflow: tr.overflow })

  // 2) 自定义语言下拉：自绘面板、唯一勾选态、键盘、外部点击、选中同步
  await evalJs(
    `(function(){const trigger=document.querySelector('.tr-select-source .tr-select-trigger');trigger?.click();return !!trigger})()`,
    false,
  )
  await sleep(300)
  const langMenu = await evalJs(
    `(function(){
      const list=document.querySelector('.tr-select-source .tr-select-list');
      const selected=list?.querySelector('[aria-selected="true"]');
      return {
        role:list?.getAttribute('role')||'',
        options:list?.querySelectorAll('[role="option"]').length||0,
        selected:selected?.textContent?.trim()||'',
        firstOption:list?.querySelector('[role="option"]')?.textContent?.trim()||'',
        visible:!!list && !list.hasAttribute('hidden'),
        nativeSelects:document.querySelectorAll('.tr-bar-langs select').length,
      };
    })()`,
    false,
  )
  check(
    '语言下拉是主题自绘面板，不再使用系统原生下拉',
    langMenu?.role === 'listbox' &&
      langMenu.options > 20 &&
      langMenu.nativeSelects === 0 &&
      langMenu.visible === true,
    langMenu,
  )
  check(
    '当前语言在列表里有唯一勾选态，且默认落在「自动判断」',
    langMenu?.selected === '自动判断' && langMenu.firstOption === '自动判断',
    langMenu,
  )
  await shot('translate-lang-menu.png')

  // 方向键移动高亮，aria-activedescendant 必须跟着走
  const keys = await evalJs(
    `(async function(){
      const root=document.querySelector('.tr-select-source');
      const trigger=root.querySelector('.tr-select-trigger');
      const key=(k)=>trigger.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));
      key('ArrowDown');
      await new Promise((r)=>setTimeout(r,150));
      const first=trigger.getAttribute('aria-activedescendant');
      key('ArrowDown');
      await new Promise((r)=>setTimeout(r,150));
      const second=trigger.getAttribute('aria-activedescendant');
      key('ArrowUp');
      await new Promise((r)=>setTimeout(r,150));
      const back=trigger.getAttribute('aria-activedescendant');
      return {first,second,back};
    })()`,
    true,
  )
  check(
    '方向键可移动高亮，aria-activedescendant 同步变化',
    !!keys.first && !!keys.second && keys.first !== keys.second && keys.back === keys.first,
    keys,
  )

  // 点外部关闭，收起后不留失效的 aria 引用
  await evalJs(
    `(function(){document.querySelector('.tr-split-body').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return true})()`,
    false,
  )
  await sleep(300)
  const closed = await evalJs(
    `(function(){
      const root=document.querySelector('.tr-select-source');
      const t=root.querySelector('.tr-select-trigger');
      return {
        visible:!!root.querySelector('.tr-select-list') && !root.querySelector('.tr-select-list').hasAttribute('hidden'),
        allLists:document.querySelectorAll('.tr-select-list').length,
        ariaControls:t.getAttribute('aria-controls')||'',
        activeDescendant:t.getAttribute('aria-activedescendant')||'',
        expanded:t.getAttribute('aria-expanded')||'',
      };
    })()`,
    false,
  )
  check(
    '点击外部关闭列表，且 aria 引用始终指向真实存在的列表',
    closed.visible === false &&
      closed.ariaControls === 'translate-source-list' &&
      closed.activeDescendant === '' &&
      closed.expanded === 'false',
    closed,
  )

  // 选一项，trigger 文案与勾选态一起更新
  await evalJs(
    `(function(){document.querySelector('.tr-select-source .tr-select-trigger').click();return true})()`,
    false,
  )
  await sleep(300)
  await evalJs(
    `(function(){
      const root=document.querySelector('.tr-select-source');
      const opts=[...root.querySelectorAll('[role="option"]')];
      const target=opts.find((o)=>(o.textContent||'').trim()==='英语');
      target?.click();
      return !!target;
    })()`,
    false,
  )
  await waitFor(
    `(function(){
      const root=document.querySelector('.tr-select-source');
      return (root.querySelector('.tr-select-value')?.textContent?.trim()||'')==='英语';
    })()`,
    4000,
  )
  const picked = await evalJs(
    `(function(){
      const root=document.querySelector('.tr-select-source');
      return {
        trigger:root.querySelector('.tr-select-value')?.textContent?.trim()||'',
        selected:root.querySelector('[aria-selected="true"]')?.textContent?.trim()||'',
        visible:!!root.querySelector('.tr-select-list') && !root.querySelector('.tr-select-list').hasAttribute('hidden'),
      };
    })()`,
    false,
  )
  check(
    '选中后 trigger 文案与勾选态一起更新',
    picked?.trigger === '英语' && picked.selected === '英语' && picked.visible === false,
    picked,
  )
  const sourceLabel = await evalJs(
    `document.querySelector('.tr-split-body .tr-pane .tr-pane-label')?.textContent?.trim()||''`,
    false,
  )
  check('源语言面板标题同步显示所选语言', sourceLabel === '英语', sourceLabel)

  // Esc 关闭
  await evalJs(
    `(function(){const t=document.querySelector('.tr-select-source .tr-select-trigger');t?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`,
    false,
  )
  await sleep(300)
  const escaped = await evalJs(
    `(function(){const l=document.querySelector('.tr-select-source .tr-select-list');return !!l && !l.hasAttribute('hidden')})()`,
    false,
  )
  check('Esc 关闭列表', escaped === false, { escaped })

  // 还原成自动判断，后面的翻译用默认源语言
  await evalJs(
    `(function(){const t=document.querySelector('.tr-select-source .tr-select-trigger');t.click();return true})()`,
    false,
  )
  await sleep(300)
  await evalJs(
    `(function(){
      const root=document.querySelector('.tr-select-source');
      const opts=[...root.querySelectorAll('[role="option"]')];
      opts[0]?.click();
      return true;
    })()`,
    false,
  )
  await waitFor(
    `(function(){
      const root=document.querySelector('.tr-select-source');
      return (root.querySelector('.tr-select-value')?.textContent?.trim()||'')==='自动判断';
    })()`,
    4000,
  )
  await shot('translate-empty.png')

  // 3) 走一遍真实翻译：原文进去了，译文出来了
  const typed = await evalJs(
    `(function(){
      const ta=document.querySelector('.tr-textarea');
      const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      setter.call(ta,'The weather is lovely today. We can take a walk in the park.');
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      return ta.value;
    })()`,
    false,
  )
  check('原文填进去了', typed === 'The weather is lovely today. We can take a walk in the park.', typed)
  await sleep(300)
  tr = await evalJs(TR_READ, false)
  check('有原文之后提交按钮可点了', tr.submitDisabled === false, tr.submit)

  await evalJs(
    `(function(){const b=document.querySelector('.tr-run');if(!b)return false;b.click();return true})()`,
    false,
  )
  // 端到端只认失败或成功，不能是空白
  const done = await waitFor(
    `(function(){const o=document.querySelector('.tr-out .md');const e=document.querySelector('.tr-error');return (o&&o.textContent.trim())||(e&&e.textContent.trim())||null})()`,
    90000,
  )
  tr = await evalJs(TR_READ, false)
  check('这一屏没有把失败吞成空白', done !== null, { done })
  if (tr.errVisible) {
    // 说明服务不可用也要给一句人话，不能是一堆原始响应
    check('失败说明是人话', tr.err.length > 0, tr.err)
    check('失败时保留了原始响应供排查', tr.errDetail.length > 0, tr.errDetail)
  } else {
    check('译文出来了，且不是原文', tr.out.length > 0 && tr.out !== typed, tr.out)
    check('译文是中文（目标语言是 zh）', /[一-龥]/.test(tr.out), tr.out)
  }
  await shot('translate-result.png')

  // 4) 设置面板里的模型与术语：开面板、换目标语言、填术语
  await evalJs(`(function(){const b=document.querySelector('.tr-bar-tools .tr-icon');if(b)b.click();return !!b})()`, false)
  await sleep(400)
  await evalJs(
    `(function(){const t=document.querySelector('.tr-select-target .tr-select-trigger');if(!t)return false;t.click();return true})()`,
    false,
  )
  await sleep(300)
  await evalJs(
    `(function(){
      const root=document.querySelector('.tr-select-target');
      const opts=[...root.querySelectorAll('[role="option"]')];
      const target=opts.find((o)=>(o.textContent||'').trim()==='英语');
      target?.click();
      return !!target;
    })()`,
    false,
  )
  await sleep(300)
  const glossary = await evalJs(
    `(function(){
      const inputs=[...document.querySelectorAll('.tr-panel input[type=text]')];
      const g=inputs[0];
      if(!g) return null;
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(g,'碳纤维:carbon fiber, 抗裂缝→crack resistance');
      g.dispatchEvent(new Event('input',{bubbles:true}));
      const ta=document.querySelector('.tr-split-body .tr-textarea');
      const s2=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      s2.call(ta,'碳纤维的力学性能如何？');
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      return g.value;
    })()`,
    false,
  )
  check('术语对照填进去了', typeof glossary === 'string' && glossary.includes('carbon fiber'), glossary)
  await sleep(300)
  await evalJs(
    `(function(){const b=document.querySelector('.tr-run');if(!b)return false;b.click();return true})()`,
    false,
  )
  const done2 = await waitFor(
    `(function(){const o=document.querySelector('.tr-out .md');return (o&&o.textContent.trim())||null})()`,
    90000,
  )
  tr = await evalJs(TR_READ, false)
  check('带术语的那次也出了结果', done2 !== null, { done2 })
  if (!tr.errVisible) {
    check('译文里出现了术语对照指定的写法', /carbon fiber/i.test(tr.out), tr.out)
  }
  await shot('translate-glossary.png')

  // 5) 图片直译：用 canvas 拼一张真实的 PNG，走真实文件输入通道
  await evalJs(
    `(function(){
      const gear=document.querySelector('.tr-bar-tools .tr-icon');
      if(gear && gear.classList.contains('active')) gear.click();
      const t=document.querySelector('.tr-select-target .tr-select-trigger');
      if(t) t.click();
      return true;
    })()`,
    false,
  )
  await sleep(300)
  await evalJs(
    `(function(){
      const root=document.querySelector('.tr-select-target');
      const opts=[...root.querySelectorAll('[role="option"]')];
      const target=opts.find((o)=>(o.textContent||'').trim()==='中文');
      target?.click();
      const ta=document.querySelector('.tr-split-body .tr-textarea');
      const ts=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      ts.call(ta,''); ta.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`,
    false,
  )
  const dropped = await evalJs(
    `(async function(){
      const c=document.createElement('canvas'); c.width=640; c.height=180;
      const g=c.getContext('2d'); g.fillStyle='#ffffff'; g.fillRect(0,0,c.width,c.height);
      g.fillStyle='#111111'; g.font='bold 56px sans-serif'; g.fillText('Hello world', 36, 108);
      const blob=await new Promise(r=>c.toBlob(r,'image/png'));
      const file=new File([blob],'ocr-test.png',{type:'image/png'});
      const dt=new DataTransfer(); dt.items.add(file);
      const drop=document.querySelector('.tr-drop');
      drop.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
      return file.size;
    })()`,
    false,
  )
  const chip = await waitFor(`!!document.querySelector('.tr-chip-file')`, 10000)
  check('图片附件 chip 出现', chip === true)
  // 把上一轮的结果记下来，翻译完要能看出页面不是停在原地
  const prevOut = await evalJs(
    `document.querySelector('.tr-out .md')?.textContent.trim()||''`,
    false,
  )
  await evalJs(
    `(function(){const b=document.querySelector('.tr-run');if(!b)return false;b.click();return true})()`,
    false,
  )
  await evalJs(`window.__trPrevOut=${JSON.stringify(prevOut)}`, false)
  const imageDone = await waitFor(
    `(function(){const o=document.querySelector('.tr-out .md');const e=document.querySelector('.tr-error');const t=e?e.querySelector('.tr-error-title'):null;const ev=t?t.textContent.trim():'';const v=o?o.textContent.trim():'';return ev||(v&&v!==window.__trPrevOut?v:null)})()`,
    90000,
  )
  tr = await evalJs(TR_READ, false)
  check('图片请求不会停在空白', imageDone !== null, { imageDone })
  if (!tr.errVisible) check('图片译文不为空', tr.out.length > 0, tr.out)
  await shot('translate-image.png')
  check('整轮没有渲染层异常', pageErrors.length === 0, pageErrors.slice(0, 3))

  // 8) 图片预览：缩略图点得开，Esc 关得上
  const hasThumb = await evalJs(`!!document.querySelector('.tr-chip-file .tr-thumb img')`, false)
  check('图片附件带缩略图，可点开预览', hasThumb === true, { hasThumb })
  await evalJs(`document.querySelector('.tr-chip-file .tr-thumb').click()`, false)
  await sleep(300)
  const lightbox = await evalJs(
    `(function(){
      const box=document.querySelector('.tr-lightbox');
      const img=box?.querySelector('img');
      return {open:!!box, hasImg:!!img, sameSrc:img?.getAttribute('src')?.startsWith('data:image/')||false};
    })()`,
    false,
  )
  check('点击缩略图打开灯箱且显示的是原图', lightbox.open === true && lightbox.hasImg === true && lightbox.sameSrc === true, lightbox)
  await shot('translate-lightbox.png')
  await evalJs(
    `(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`,
    false,
  )
  await sleep(300)
  const lightboxGone = await evalJs(`!!document.querySelector('.tr-lightbox')`, false)
  check('Esc 关闭灯箱', lightboxGone === false, { lightboxGone })

  // 9) 直接粘贴剪贴板图片应变成附件；焦点不在输入框时也要能贴
  await evalJs(
    `(function(){
      const ta=document.querySelector('.tr-textarea');
      const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      s.call(ta,'keep this'); ta.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('.tr-chip-file .tr-icon')?.click();
      return true;
    })()`
    , false,
  )
  const chipCleared = await waitFor(`!document.querySelector('.tr-chip-file')`, 5000)
  const pasted = await evalJs(
    `(async function(){
      const c=document.createElement('canvas'); c.width=320; c.height=120;
      const g=c.getContext('2d'); g.fillStyle='#ffffff'; g.fillRect(0,0,c.width,c.height);
      g.fillStyle='#111111'; g.font='bold 36px sans-serif'; g.fillText('Pasted image', 20, 74);
      const blob=await new Promise(r=>c.toBlob(r,'image/png'));
      const file=new File([blob],'clipboard.png',{type:'image/png'});
      const dt=new DataTransfer(); dt.items.add(file);
      const ta=document.querySelector('.tr-textarea'); ta.focus();
      ta.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));
      return file.size;
    })()`
    , true,
  )
  const pastedChip = await waitFor(`document.querySelectorAll('.tr-chip-file').length===1 && !!document.querySelector('.tr-chip-file .tr-thumb img')`, 10000)
  const afterPaste = await evalJs(
    `(function(){
      return {chips:document.querySelectorAll('.tr-chip-file').length, text:document.querySelector('.tr-textarea')?.value||''};
    })()`
    , false,
  )
  check(
    '直接粘贴剪贴板图片会替换为单个附件且不改动正文',
    chipCleared === true && typeof pasted === 'number' && pasted > 0 && pastedChip === true && afterPaste.chips === 1 && afterPaste.text === 'keep this',
    { chipCleared, pasted, pastedChip, afterPaste },
  )
  await evalJs(`document.querySelector('.tr-chip-file .tr-icon')?.click()`, false)
  const resetForFallback = await waitFor(`!document.querySelector('.tr-chip-file')`, 5000)
  const fallbackSize = await evalJs(
    `(async function(){
      const c=document.createElement('canvas'); c.width=32; c.height=32;
      const g=c.getContext('2d'); g.fillStyle='#eeeeee'; g.fillRect(0,0,c.width,c.height);
      const blob=await new Promise(r=>c.toBlob(r,'image/png'));
      const file=new File([blob],'doc-fallback.png',{type:'image/png'});
      const dt=new DataTransfer(); dt.items.add(file);
      document.activeElement?.blur();
      document.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));
      return file.size;
    })()`
    , true,
  )
  const fallbackChip = await waitFor(`document.querySelectorAll('.tr-chip-file').length===1 && !!document.querySelector('.tr-chip-file .tr-thumb img')`, 10000)
  check(
    '焦点不在输入框时也能粘贴剪贴板图片',
    resetForFallback === true && typeof fallbackSize === 'number' && fallbackSize > 0 && fallbackChip === true,
    { resetForFallback, fallbackSize, fallbackChip },
  )

  // 7) 译文必须按 Markdown 渲染，不能是纯文本 div
  const mdCheck = await evalJs(
    `(function(){
      const md=document.querySelector('.tr-out .md');
      return {
        hasMdWrapper:!!md,
        // Markdown 会产出块级标签；纯文本渲染只会有一个裸文本节点
        blockTags:md?[...md.querySelectorAll('p,h1,h2,h3,ul,ol,li,pre,blockquote,table,strong,code')].length:0,
        rendered:md?md.textContent?.trim()||'':'',
        tagName:md?md.tagName:'',
      };
    })()`,
    false,
  )
  check(
    '译文按 Markdown 渲染（不是纯文本 div）',
    mdCheck.hasMdWrapper === true && mdCheck.blockTags >= 1 && mdCheck.rendered.length > 0,
    mdCheck,
  )

  // 6) 主题切换：换成白天主题后这一屏还在
  await evalJs(`(function(){const b=document.querySelector('.theme-toggle');if(b)b.click();return !!b})()`, false)
  await sleep(1200)
  const light = await evalJs(TR_READ, false)
  check('切到白天主题后这一屏还在', light.present === true, { present: light.present })
  check('白天主题下也没有横向溢出', light.overflow <= 0, { overflow: light.overflow })
  check(
    '白天主题下译文与原文都还在（换主题不该把内容清掉）',
    light.out.length > 0 && light.errVisible === false,
    { out: light.out.slice(0, 40) },
  )
  await shot('translate-light.png')

  console.log('-'.repeat(46))
  if (failures.length) {
    console.log(`\x1b[31m失败 ${failures.length} 项\x1b[0m`)
    failures.forEach((f) => console.log('  ! ' + f))
  } else {
    console.log('\x1b[32m全部通过\x1b[0m')
  }
  console.log('截图在 ' + outDir)
}

try {
  await main()
} catch (e) {
  console.error('验证脚本执行失败：' + (e?.stack || e))
  failures.push('脚本执行异常')
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  child?.kill()
  await sleep(600)
  try {
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

process.exit(failures.length ? 1 : 0)
