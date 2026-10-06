// 运行时验证：独立 userData 启动真实构建应用，经 CDP 打开助手抽屉，验证
// 复制 / 附件（文本放行、图片按视觉能力门控）/ 编辑重发 / 重新生成 的界面落点。
// 无 API 密钥：发送会以失败收场，但用户气泡仍会渲染，正好用来验消息级操作。
// 只管理本脚本 spawn 的 electron 进程。用 Node 24 自带 fetch/WebSocket。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = 9412
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-asst-'))
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
        // 单条 CDP 调用兜底超时：页面卡死时不让整个脚本无限挂起
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

async function findPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      // 主窗口是 file:// 下的 index.html；内嵌 webview 是 https，排除掉
      const pages = list.filter((t) => t.type === 'page' && /^file:\/\//.test(t.url || ''))
      const main = pages.find((t) => /index\.html/.test(t.url || ''))
      if (main) return main
    } catch {
      /* 尚未就绪 */
    }
    await sleep(500)
  }
  throw new Error('未找到渲染层页面目标')
}

async function evalJs(cdp, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails)
    throw new Error('页内执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(outDir, name)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  截图 →', file)
}

async function main() {
  child = spawn(electronBin, [ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write('[app] ' + d))
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|GPU|gpu|Warning|deprecat/i.test(s)) process.stdout.write('[app:err] ' + s)
  })

  console.log('等待 CDP 目标…')
  const page = await findPageTarget()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = cdpClient(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable').catch(() => {})
  const pageErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push('EX: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      pageErrors.push('ERR: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
      pageErrors.push('LOG: ' + m.params.entry.text)
  })
  await sleep(6000)

  // 等待渲染层挂载完成（应用会预热内嵌 webview，启动可能偏慢）。
  // 以助手开关出现为「已挂载」的信号，最长轮询 ~40s。
  let mounted = false
  for (let i = 0; i < 80; i++) {
    try {
      mounted = await evalJs(cdp, `!!document.querySelector('.assistant-toggle')`)
    } catch {
      mounted = false
    }
    if (mounted) break
    await sleep(500)
  }
  console.log('渲染层挂载就绪:', mounted)
  if (!mounted) {
    const diag = await evalJs(cdp, `(function(){ return { url: location.href, rootChild: document.querySelector('#root')?.firstElementChild?.className||'', bodyLen: document.body?.innerHTML?.length||0 }; })()`).catch((e) => ({ err: String(e) }))
    console.log('挂载诊断:', JSON.stringify(diag))
    console.log('页面错误:', JSON.stringify(pageErrors.slice(0, 12)))
    await shot(cdp, 'verify-assistant-diag.png').catch(() => {})
    throw new Error('渲染层未挂载')
  }

  // 关掉首运行须知弹窗（若有）
  await evalJs(
    cdp,
    `(function(){ const b=[...document.querySelectorAll('button')].find(x=>/我已理解|继续使用|知道了|同意/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`,
    false,
  )
  await sleep(500)

  // 1) 打开助手抽屉。webview 预热可能让渲染层短暂重载，导致开关闪现即失，
  // 因此轮询「开关存在 → 点击 → 抽屉出现」，重试直至成功或超时。
  let opened = false
  for (let attempt = 0; attempt < 15 && !opened; attempt++) {
    const hasToggle = await evalJs(cdp, `!!document.querySelector('.assistant-toggle')`).catch(() => false)
    if (!hasToggle) {
      await sleep(1000)
      continue
    }
    // 关一次首运行弹窗（重载后可能再次出现）
    await evalJs(cdp, `(function(){ const b=[...document.querySelectorAll('button')].find(x=>/我已理解|继续使用|知道了|同意/.test(x.textContent||'')); if(b) b.click(); return !!b; })()`, false).catch(() => false)
    await evalJs(cdp, `(function(){ const b=document.querySelector('.assistant-toggle'); if(b) b.click(); return true; })()`, false).catch(() => false)
    for (let i = 0; i < 8; i++) {
      opened = await evalJs(cdp, `!!document.querySelector('.assistant-drawer')`).catch(() => false)
      if (opened) break
      await sleep(400)
    }
    if (!opened) await sleep(800)
  }
  console.log('助手抽屉打开:', opened)
  if (!opened) {
    const diag = await evalJs(
      cdp,
      `(function(){
        const t=document.querySelector('.assistant-toggle');
        return {
          toggle: t ? { cls: t.className, disabled: t.disabled } : null,
          drawerCount: document.querySelectorAll('.assistant-drawer').length,
          modalMask: !!document.querySelector('.modal-mask'),
          modalBtns: [...document.querySelectorAll('.modal-mask button')].map(b=>b.textContent.trim()),
          rootClass: document.querySelector('#root')?.firstElementChild?.className || '',
          asideCount: document.querySelectorAll('aside').length,
        };
      })()`,
    )
    console.log('诊断:', JSON.stringify(diag))
    const ex = pageErrors.filter((e) => e.startsWith('EX:'))
    console.log('JS 异常:', JSON.stringify(ex.slice(0, 6)))
    console.log('页面错误:', JSON.stringify(pageErrors.slice(0, 12)))
    await shot(cdp, 'verify-assistant-diag.png')
    throw new Error('助手抽屉未打开')
  }

  // 2) composer 落点 + 视觉门控：无视觉模型时 file input 的 accept 不应含 image/*
  const composer = await evalJs(
    cdp,
    `(function(){
      const input=document.querySelector('.assistant-drawer input[type=file]');
      return {
        attachBtn: !!document.querySelector('.assistant-drawer .ac-btn[aria-label="添加附件"]'),
        hasFileInput: !!input,
        accept: input ? input.getAttribute('accept') : null,
        imageAllowed: input ? /image\\//.test(input.getAttribute('accept')||'') : null,
      };
    })()`,
  )
  console.log('composer:', JSON.stringify(composer))

  // 3) 附件：文本文件应放行成 chip；图片在无视觉模型下应被挡并给出提示
  const attRes = await evalJs(cdp, `(async function(){
    const pngB64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin=Uint8Array.from(atob(pngB64), c=>c.charCodeAt(0));
    const img=new File([bin],'shot.png',{type:'image/png'});
    const txt=new File([new Blob(['hello assistant'],{type:'text/plain'})],'note.txt',{type:'text/plain'});
    const input=document.querySelector('.assistant-drawer input[type=file]');
    const dt=new DataTransfer(); dt.items.add(txt);
    input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,700));
    const afterText=document.querySelectorAll('.assistant-drawer .ac-att').length;
    // 再塞一张图片，期望被视觉门控挡下（chip 数不变，出现提示）
    const dt2=new DataTransfer(); dt2.items.add(img);
    input.files=dt2.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,700));
    return {
      textChips: afterText,
      chipsAfterImage: document.querySelectorAll('.assistant-drawer .ac-att').length,
      noteShown: !!document.querySelector('.assistant-drawer .ac-note'),
      strip: !!document.querySelector('.assistant-drawer .ac-atts'),
    };
  })()`)
  console.log('附件:', JSON.stringify(attRes))
  await shot(cdp, 'verify-assistant-attach.png')

  // 4) 发一条消息（无密钥会以失败收场，但用户气泡应渲染出来）
  await evalJs(cdp, `(function(){
    const ta=document.querySelector('.assistant-drawer .ac-input');
    const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    setter.call(ta,'验证消息：助手附件与编辑'); ta.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`, false)
  await sleep(300)
  await evalJs(
    cdp,
    `(function(){ const ta=document.querySelector('.assistant-drawer .ac-input'); ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return true; })()`,
    false,
  )
  await sleep(1500)
  const userDom = await evalJs(cdp, `(function(){
    const u=document.querySelector('.assistant-drawer .a-user');
    return {
      userBlock: !!u,
      attRow: !!document.querySelector('.assistant-drawer .a-att-row'),
      attFile: !!document.querySelector('.assistant-drawer .a-att-file'),
      actCount: document.querySelectorAll('.assistant-drawer .a-user .a-act').length,
      titles: [...document.querySelectorAll('.assistant-drawer .a-user .a-act')].map(b=>b.title),
    };
  })()`)
  console.log('用户气泡 DOM:', JSON.stringify(userDom))

  // 5) 进入编辑态（点 title=编辑后重发 的按钮）
  const editDom = await evalJs(cdp, `(function(){
    const btn=[...document.querySelectorAll('.assistant-drawer .a-user .a-act')].find(b=>/编辑后重发/.test(b.title||''));
    if(!btn) return { editing:false };
    btn.click();
    return new Promise(res=>setTimeout(()=>res({
      editing: !!document.querySelector('.assistant-drawer .a-user.editing'),
      area: !!document.querySelector('.assistant-drawer .a-edit-area'),
      saveBtn: [...document.querySelectorAll('.assistant-drawer button')].some(b=>/保存并重新发送/.test(b.textContent||'')),
    }),300));
  })()`)
  console.log('编辑态 DOM:', JSON.stringify(editDom))
  await shot(cdp, 'verify-assistant-edit.png')

  console.log('\n== 验证完成 ==')
}

main()
  .then(() => cleanup(0))
  .catch((e) => {
    console.error('验证失败:', e.message)
    cleanup(1)
  })

function cleanup(code) {
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
  try {
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 800)
}
