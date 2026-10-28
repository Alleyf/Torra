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
  const split=q('.tr-body');
  return {
    present: !!page,
    // 满屏双栏：左右铺满，不能留白
    fullBleed: !!page && page.clientHeight > 200 && page.scrollWidth - page.clientWidth <= 0,
    splitVisible: !!split && split.getBoundingClientRect().height > 200,
    panes: n('.tr-body > .tr-pane'),
    divider: n('.tr-body > .tr-divider'),
    // 顶部：两个语言 chip + 一个交换按钮
    langChips: n('.tr-select-source, .tr-select-target'),
    langs: n('.tr-select'),
    langFlagImages: n('.tr-select-trigger .tr-flag img'),
    swap: !!q('.tr-swap'),
    submit: q('.tr-run')?.textContent?.trim()||'',
    submitDisabled: q('.tr-run')?.disabled ?? null,
    drop: !!q('.tr-drop'),
    // 模型面板收在齿轮里，首屏不该占正文
    modelsOnFirstScreen: n('.tr-model'),
    modelPill: q('.tr-model-trigger-name')?.textContent?.trim()||'',
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
  check('顶部语言选择都使用真实国旗图标', tr.langFlagImages === 2, tr.langFlagImages)
  check('三枚模型收进设置面板，首屏不占正文', tr.modelsOnFirstScreen === 0 && tr.modelPill === '9B', tr)
  check(
    '底部拖放上传区存在，占位文案可用',
    tr.drop === true && tr.placeholder === '输入原文或粘贴图片...',
    tr,
  )
  check('空文本且无图片时提交按钮禁用', tr.submitDisabled === true, tr.submit)
  check('页面没有横向溢出', tr.overflow <= 0, { overflow: tr.overflow })

  // 模型弹窗：搜索、固定、默认 9B、选择与点外关闭
  await evalJs(
    `(function(){const b=document.querySelector('.tr-model-trigger');if(!b)return false;b.click();return true})()`,
    false,
  )
  const modelOpen = await waitFor(`!!document.querySelector('.tr-pop .tr-search input')`)
  check('模型弹窗可以打开并带搜索框', modelOpen === true)
  const modelMenu = await evalJs(
    `(function(){
      const pop=document.querySelector('.tr-pop');
      return {
        rows:pop?.querySelectorAll('.tr-model-row').length||0,
        groups:[...pop?.querySelectorAll('.tr-pop-group')||[]].map((x)=>x.textContent.trim()),
        active:pop?.querySelector('.tr-model-row.active strong')?.textContent?.trim()||'',
        pinned:!!pop?.querySelector('.tr-model-pin.active'),
      };
    })()`,
    false,
  )
  check(
    '模型弹窗默认固定并选中 9B，同时列出全部档位',
    modelMenu.rows === 3 &&
      modelMenu.groups.includes('已固定') &&
      modelMenu.active === 'Index-Translate-9B' &&
      modelMenu.pinned === true,
    modelMenu,
  )
  await shot('translate-model.png')
  const modelFiltered = await evalJs(
    `(async function(){
      const input=document.querySelector('.tr-pop .tr-search input');
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(input,'2B');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise((r)=>setTimeout(r,120));
      return {
        rows:document.querySelectorAll('.tr-pop .tr-model-row').length,
        model:document.querySelector('.tr-pop .tr-model-row strong')?.textContent?.trim()||'',
      };
    })()`,
    true,
  )
  check(
    '模型搜索会实时过滤',
    modelFiltered.rows === 1 && modelFiltered.model === 'Index-Translate-2B',
    modelFiltered,
  )
  await evalJs(
    `(function(){document.querySelector('.tr-pop .tr-model-row-main')?.click();return true})()`,
    false,
  )
  const picked2B = await waitFor(
    `document.querySelector('.tr-model-trigger-name')?.textContent?.trim()==='2B'`,
    4000,
  )
  check('选择模型后弹窗关闭且按钮同步', picked2B === true)
  await sleep(650)
  const persisted2B = await evalJs(
    `(async function(){const s=await window.torra.translateSettingsLoad();return s.model})()`,
    true,
  )
  check('模型选择会持久化', persisted2B === 'Index-Translate-2B', persisted2B)
  await evalJs(`document.querySelector('.tr-model-trigger').click()`, false)
  await waitFor(`!!document.querySelector('.tr-pop .tr-search input')`)
  await evalJs(
    `(function(){
      const row=[...document.querySelectorAll('.tr-pop .tr-model-row')].find((x)=>x.querySelector('strong')?.textContent?.trim()==='Index-Translate-9B');
      row?.querySelector('.tr-model-row-main')?.click();
      return !!row;
    })()`,
    false,
  )
  const restored9B = await waitFor(
    `document.querySelector('.tr-model-trigger-name')?.textContent?.trim()==='9B'`,
    4000,
  )
  check('可重新选择回默认 9B 模型', restored9B === true)
  await sleep(650)
  const persisted9B = await evalJs(
    `(async function(){const s=await window.torra.translateSettingsLoad();return s.model})()`,
    true,
  )
  check('重新选择的 9B 也会持久化', persisted9B === 'Index-Translate-9B', persisted9B)
  await evalJs(`document.querySelector('.tr-model-trigger').click()`, false)
  await waitFor(`!!document.querySelector('.tr-pop')`)
  await evalJs(
    `document.querySelector('.tr-body').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`,
    false,
  )
  const modelClosed = await waitFor(`!document.querySelector('.tr-pop')`, 4000)
  check('点击弹窗外部会关闭模型菜单', modelClosed === true)

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
        selectedFlag:!!selected?.querySelector('.tr-flag img'),
        visible:!!list && !list.hasAttribute('hidden'),
        nativeSelects:document.querySelectorAll('select').length,
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
    '当前语言在列表里有唯一勾选态，且国旗与默认语言同步',
    langMenu?.selected === '英语' &&
      langMenu?.firstOption?.includes('自动判断') &&
      langMenu?.selectedFlag === true,
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
    `(function(){document.querySelector('.tr-body').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return true})()`,
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
      const target=opts.find((o)=>(o.textContent||'').trim().endsWith('英语'));
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
        flag:!!root.querySelector('.tr-select-trigger .tr-flag img'),
        visible:!!root.querySelector('.tr-select-list') && !root.querySelector('.tr-select-list').hasAttribute('hidden'),
      };
    })()`,
    false,
  )
  check(
    '选中后 trigger 文案与勾选态一起更新',
    picked?.trigger === '英语' &&
      picked.selected === '英语' &&
      picked.flag === true &&
      picked.visible === false,
    picked,
  )
  const sourceLabel = await evalJs(
    `document.querySelector('.tr-pane .tr-pane-label')?.textContent?.trim()||''`,
    false,
  )
  const sourceFlag = await evalJs(
    `!!document.querySelector('.tr-pane .tr-pane-label .tr-flag img')`,
    false,
  )
  check('源语言面板标题同步显示所选语言与国旗', sourceLabel === '英语' && sourceFlag === true, {
    sourceLabel,
    sourceFlag,
  })

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

  const shortcutAccepted = await evalJs(
    `(function(){
      const e=new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true});
      return document.dispatchEvent(e);
    })()`,
    false,
  )
  check('Ctrl+Enter 快捷键会接管提交', shortcutAccepted === false)
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

  // 切换目标语言后旧译文必须失效，不能挂在新语言标题下
  await evalJs(`document.querySelector('.tr-select-target .tr-select-trigger').click()`, false)
  await sleep(150)
  await evalJs(
    `(function(){
      const opts=[...document.querySelectorAll('.tr-select-target [role="option"]')];
      opts.find((o)=>o.textContent.trim().endsWith('日语'))?.click();
      return true;
    })()`,
    false,
  )
  await sleep(200)
  const staleResult = await evalJs(
    `(function(){
      const pane=document.querySelectorAll('.tr-body > .tr-pane')[1];
      return {
        out:!!document.querySelector('.tr-out .md'),
        label:pane?.querySelector('.tr-pane-label')?.textContent?.trim()||'',
      };
    })()`,
    false,
  )
  check(
    '切换目标语言会清掉旧译文，不产生语言错配',
    staleResult.out === false && staleResult.label.includes('日语'),
    staleResult,
  )
  await evalJs(`document.querySelector('.tr-select-target .tr-select-trigger').click()`, false)
  await sleep(150)
  await evalJs(
    `(function(){
      const opts=[...document.querySelectorAll('.tr-select-target [role="option"]')];
      opts.find((o)=>o.textContent.trim().endsWith('中文'))?.click();
      return true;
    })()`,
    false,
  )
  await sleep(150)

  // 翻译历史：真实条目、国旗、收藏筛选与点击恢复
  await evalJs(
    `(function(){const b=document.querySelector('button[aria-label="翻译历史"]');if(!b)return false;b.click();return true})()`,
    false,
  )
  const historyOpen = await waitFor(`!!document.querySelector('.tr-drawer .tr-hist-list')`)
  const historyState = await evalJs(
    `(function(){
      const items=[...document.querySelectorAll('.tr-hist-item')];
      const first=items[0];
      const drawer=document.querySelector('.tr-drawer[aria-label="翻译历史"]');
      return {
        open:!!document.querySelector('.tr-drawer .tr-hist-list'),
        title:document.querySelector('.tr-drawer-title')?.textContent?.trim()||'',
        dialogRole:drawer?.getAttribute('role')||'',
        ariaModal:drawer?.getAttribute('aria-modal')||'',
        items:items.length,
        flags:first?.querySelectorAll('.tr-flag').length||0,
        flagImages:first?.querySelectorAll('.tr-flag img').length||0,
        src:first?.querySelector('.tr-hist-src')?.textContent?.trim()||'',
        dst:first?.querySelector('.tr-hist-dst')?.textContent?.trim()||'',
        star:!!first?.querySelector('.tr-hist-star'),
      };
    })()`,
    false,
  )
  check(
    '翻译历史展示真实条目、语言国旗和原文/译文',
    historyOpen === true &&
      historyState.title.includes('翻译历史') &&
      historyState.items > 0 &&
      historyState.flags === 2 &&
      historyState.flagImages === 2 &&
      historyState.dialogRole === 'dialog' &&
      historyState.ariaModal === 'true' &&
      !!historyState.src &&
      !!historyState.dst &&
      historyState.star === true,
    historyState,
  )
  await shot('translate-history.png')
  await evalJs(`document.querySelector('.tr-hist-star')?.click()`, false)
  const historyPinned = await waitFor(`!!document.querySelector('.tr-hist-item.pinned')`, 5000)
  check('历史条目可以收藏并即时更新', historyPinned === true)
  const starKeyboardSafe = await evalJs(
    `(function(){
      const star=document.querySelector('.tr-hist-star');
      star.focus();
      star.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));
      return {
        open:!!document.querySelector('.tr-drawer[aria-label="翻译历史"]'),
        items:document.querySelectorAll('.tr-hist-item').length,
      };
    })()`,
    false,
  )
  check(
    '键盘操作收藏星标不会误触历史恢复',
    starKeyboardSafe.open === true && starKeyboardSafe.items > 0,
    starKeyboardSafe,
  )
  const dedupePinned = await evalJs(
    `(async function(){
      const first=document.querySelector('.tr-hist-item');
      const r=await window.torra.translateHistoryAdd({
        id:'dedupe-'+Date.now(),
        ts:Date.now(),
        source:'en',
        target:'zh',
        sourceText:first.querySelector('.tr-hist-src').textContent.trim(),
        resultText:first.querySelector('.tr-hist-dst').textContent.trim(),
        model:'Index-Translate-9B',
        pinned:false,
      });
      return {ok:r.ok,pinned:r.history?.[0]?.pinned===true};
    })()`,
    true,
  )
  check('重复翻译不会丢失已有收藏状态', dedupePinned.ok === true && dedupePinned.pinned === true, dedupePinned)
  await evalJs(`document.querySelector('button[aria-label="只看收藏"]')?.click()`, false)
  await sleep(250)
  const pinnedOnly = await evalJs(
    `(function(){
      const items=[...document.querySelectorAll('.tr-hist-item')];
      return { count:items.length, allPinned:items.every((x)=>x.classList.contains('pinned')) };
    })()`,
    false,
  )
  check(
    '只看收藏筛选生效',
    pinnedOnly.count > 0 && pinnedOnly.allPinned === true,
    pinnedOnly,
  )
  await evalJs(`document.querySelector('.tr-hist-item')?.click()`, false)
  const historyRestored = await waitFor(`!document.querySelector('.tr-drawer .tr-hist-list')`, 5000)
  check('点击历史条目会恢复内容并关闭抽屉', historyRestored === true)

  // 4) 打开翻译设置，写入术语对照，关闭后重新提交，验证术语真实生效
  await evalJs(
    `(function(){const b=document.querySelector('button[aria-label="翻译设置"]');if(!b)return false;b.click();return true})()`,
    false,
  )
  await sleep(400)
  const settingsOpened = await evalJs(`!!document.querySelector('.tr-drawer .tr-set-body')`, false)
  check('翻译设置抽屉可打开', settingsOpened === true)
  const settingsAudit = await evalJs(
    `(function(){
      const body=document.querySelector('.tr-set-body');
      return {
        sections:document.querySelectorAll('.tr-set-sec').length,
        switches:document.querySelectorAll('.tr-set-body [role="switch"]').length,
        detectButtons:document.querySelectorAll('.tr-seg [aria-pressed]').length,
        prompt:!!document.querySelector('textarea[aria-label="翻译提示词"]'),
        glossary:!!document.querySelector('.tr-set-input'),
        customLangForm:!!document.querySelector('.tr-lang-form'),
        overflowX:body ? body.scrollWidth-body.clientWidth : -1,
        scrollable:body ? body.scrollHeight>body.clientHeight : false,
      };
    })()`,
    false,
  )
  check(
    '设置抽屉包含通用、参数、提示词和自定义语言四组控件',
    settingsAudit.sections === 4 &&
      settingsAudit.switches === 6 &&
      settingsAudit.detectButtons === 3 &&
      settingsAudit.prompt === true &&
      settingsAudit.glossary === true &&
      settingsAudit.customLangForm === true &&
      settingsAudit.overflowX <= 0,
    settingsAudit,
  )
  const shortcutIgnored = await evalJs(
    `(function(){
      const prompt=document.querySelector('textarea[aria-label="翻译提示词"]');
      const e=new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true});
      const notPrevented=prompt.dispatchEvent(e);
      return {
        notPrevented,
        settingsOpen:!!document.querySelector('.tr-drawer[aria-label="翻译设置"]'),
      };
    })()`,
    false,
  )
  check(
    '设置输入框里的 Ctrl+Enter 不会误触发翻译',
    shortcutIgnored.notPrevented === true && shortcutIgnored.settingsOpen === true,
    shortcutIgnored,
  )
  await shot('translate-settings.png')
  await evalJs(
    `(function(){const b=document.querySelector('.tr-set-body');if(b)b.scrollTop=b.scrollHeight;return true})()`,
    false,
  )
  await sleep(150)
  await shot('translate-settings-bottom.png')
  await evalJs(
    `document.querySelector('button[aria-label="双向翻译设置"]')?.click()`,
    false,
  )
  const bilingual = await waitFor(`!!document.querySelector('.tr-bi-row')`, 4000)
  const bilingualState = await evalJs(
    `(function(){
      const row=document.querySelector('.tr-bi-row');
      return {
        selects:row?.querySelectorAll('.tr-select').length||0,
        flags:row?.querySelectorAll('.tr-select-trigger .tr-flag').length||0,
        flagImages:row?.querySelectorAll('.tr-select-trigger .tr-flag img').length||0,
      };
    })()`,
    false,
  )
  check(
    '双向翻译语言对带国旗',
    bilingual === true &&
      bilingualState.selects === 2 &&
      bilingualState.flags === 2 &&
      bilingualState.flagImages === 2,
    bilingualState,
  )
  await evalJs(
    `document.querySelector('button[aria-label="双向翻译设置"]')?.click()`,
    false,
  )
  const glossary = await evalJs(
    `(function(){
      const g=document.querySelector('.tr-set-sec .tr-set-input');
      if(!g) return null;
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(g,'碳纤维:carbon fiber, 抗裂缝:crack resistance');
      g.dispatchEvent(new Event('input',{bubbles:true}));
      return g.value;
    })()`,
    false,
  )
  check('术语对照写进设置', typeof glossary === 'string' && glossary.includes('carbon fiber'), glossary)
  const closeSettings = await evalJs(
    `(function(){const b=document.querySelector('.tr-drawer button[aria-label="关闭设置"]');if(!b)return false;b.click();return true})()`,
    false,
  )
  check('设置抽屉可关闭', closeSettings === true)
  await sleep(400)
  await evalJs(`document.querySelector('button[aria-label="翻译设置"]')?.click()`, false)
  await waitFor(`!!document.querySelector('.tr-drawer[aria-label="翻译设置"]')`, 4000)
  await evalJs(
    `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    false,
  )
  const settingsEscaped = await waitFor(
    `!document.querySelector('.tr-drawer[aria-label="翻译设置"]')`,
    4000,
  )
  check('Esc 可以关闭翻译设置抽屉', settingsEscaped === true)
  await evalJs(
    `(function(){const t=document.querySelector('.tr-select-target .tr-select-trigger');if(!t)return false;t.click();return true})()`,
    false,
  )
  await sleep(300)
  const pickedTargetEn = await evalJs(
    `(function(){
      const root=document.querySelector('.tr-select-target');
      const opts=[...root.querySelectorAll('[role="option"]')];
      const target=opts.find((o)=>(o.textContent||'').trim().endsWith('英语'));
      target?.click();
      const ta=document.querySelector('.tr-textarea');
      const s2=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      s2.call(ta,'碳纤维的化学性质与抗裂缝。');
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      return !!target;
    })()`,
    false,
  )
  check('目标语言可以切换到英语', pickedTargetEn === true)
  await sleep(300)
  const targetMenuClosed = await evalJs(
    `(function(){const l=document.querySelector('.tr-select-target .tr-select-list');return !l||l.hasAttribute('hidden')})()`,
    false,
  )
  check('选中目标语言后菜单关闭', targetMenuClosed === true)
  await evalJs(
    `(function(){const b=document.querySelector('.tr-run');if(!b)return false;b.click();return true})()`,
    false,
  )
  const done2 = await waitFor(
    `(function(){const o=document.querySelector('.tr-out .md');const e=document.querySelector('.tr-error');return (o&&o.textContent.trim())||(e&&e.textContent.trim())||null})()`,
    90000,
  )
  tr = await evalJs(TR_READ, false)
  check('带术语再翻一次不会停在空白', done2 !== null, { done2 })
  if (!tr.errVisible) {
    check('译文输出包含已指定术语', /carbon fiber/i.test(tr.out), tr.out)
  } else {
    check('术语翻译失败也有可读原因', tr.err.length > 0, tr.err)
  }
  await shot('translate-glossary.png')

  // 5) 图片直译：用 canvas 拼一张真实的 PNG，走真实文件输入通道
  await evalJs(
    `(function(){
      const gear=document.querySelector('button[aria-label="翻译设置"]');
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
      const target=opts.find((o)=>(o.textContent||'').trim().endsWith('中文'));
      target?.click();
      const ta=document.querySelector('.tr-textarea');
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
      const page=document.querySelector('.tr-page');
      const br=box?.getBoundingClientRect();
      const pr=page?.getBoundingClientRect();
      return {
        open:!!box,
        hasImg:!!img,
        sameSrc:img?.getAttribute('src')?.startsWith('data:image/')||false,
        position:box?getComputedStyle(box).position:'',
        covers:!!br&&!!pr&&Math.abs(br.width-pr.width)<2&&Math.abs(br.height-pr.height)<2,
      };
    })()`,
    false,
  )
  check(
    '点击缩略图打开全屏灯箱且显示的是原图',
    lightbox.open === true &&
      lightbox.hasImg === true &&
      lightbox.sameSrc === true &&
      lightbox.position === 'absolute' &&
      lightbox.covers === true,
    lightbox,
  )
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

  // 窄屏：页面不横向溢出，语言菜单和模型弹窗都不能跑出视口
  await wsCdp.send('Emulation.setDeviceMetricsOverride', {
    width: 600,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(500)
  const narrow = await evalJs(
    `(function(){
      const page=document.querySelector('.tr-page');
      return {
        width:innerWidth,
        pageOverflow:page?page.scrollWidth-page.clientWidth:-1,
        documentOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      };
    })()`,
    false,
  )
  check(
    '窄屏下翻译页没有横向溢出',
    narrow.width <= 600 && narrow.pageOverflow <= 0 && narrow.documentOverflow <= 0,
    narrow,
  )
  await evalJs(`document.querySelector('.tr-select-target .tr-select-trigger')?.click()`, false)
  await sleep(200)
  const narrowLangMenu = await evalJs(
    `(function(){
      const r=document.querySelector('.tr-select-target .tr-select-list')?.getBoundingClientRect();
      return r?{left:r.left,right:r.right,width:r.width,viewport:innerWidth}:null;
    })()`,
    false,
  )
  check(
    '窄屏下目标语言菜单完整留在视口内',
    !!narrowLangMenu && narrowLangMenu.left >= 0 && narrowLangMenu.right <= narrowLangMenu.viewport,
    narrowLangMenu,
  )
  await evalJs(
    `document.querySelector('.tr-body').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`,
    false,
  )
  await evalJs(`document.querySelector('.tr-model-trigger')?.click()`, false)
  await waitFor(`!!document.querySelector('.tr-pop')`, 4000)
  const narrowModel = await evalJs(
    `(function(){
      const r=document.querySelector('.tr-pop')?.getBoundingClientRect();
      return r?{left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewportW:innerWidth,viewportH:innerHeight}:null;
    })()`,
    false,
  )
  check(
    '窄屏下模型弹窗贴在按钮下方且不越过视口',
    !!narrowModel &&
      narrowModel.left >= 0 &&
      narrowModel.right <= narrowModel.viewportW &&
      narrowModel.top >= 0 &&
      narrowModel.bottom <= narrowModel.viewportH,
    narrowModel,
  )
  await shot('translate-narrow.png')
  await wsCdp.send('Emulation.clearDeviceMetricsOverride')

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
