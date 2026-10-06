// 运行时验证：以独立 userData 启动真实构建应用（注册全部主进程 handler），
// 经 CDP 驱动 Chat 页，真实走一遍 attachment:save / attachment:read IPC 与资源落盘，
// 截图取证 composer 附件条、图片预览、编辑框。只管理本脚本 spawn 的 electron 进程。
// 用 Node 24 自带 fetch/WebSocket，无需额外依赖。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = 9411
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-'))
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
      })
    },
  }
}

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find(
        (t) => t.type === 'page' && /index\.html|file:\/\//.test(t.url || ''),
      )
      if (page) return page
    } catch {
      /* 尚未就绪 */
    }
    await sleep(500)
  }
  throw new Error('未找到渲染层页面目标')
}

async function evalJs(cdp, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  })
  if (r.exceptionDetails) throw new Error('页内执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(outDir, name)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  截图 →', file)
}

async function main() {
  child = spawn(electronBin, [
    ROOT,
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
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

  // 等模型列表就绪、应用启动完成
  await sleep(6000)

  // 1) 进入 Chat 页
  await evalJs(cdp, `(function(){
    const b=[...document.querySelectorAll('button')].find(x=>/聊天/.test(x.textContent||''));
    if(!b) throw new Error('未找到 聊天 导航按钮');
    b.click(); return true;
  })()`, false)
  // composer 仅在已勾选参与者时渲染：先双击一个模型卡片把它加入参与者
  await evalJs(cdp, `(function(){
    const toggle=document.querySelector('.rail-toggle'); // 若模型栏收起，先展开
    const card=document.querySelector('.model-card:not(.disabled)')||document.querySelector('.rail-collapsed-list [title]');
    if(!card) throw new Error('未找到模型卡片');
    card.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window}));
    return true;
  })()`, false)
  await sleep(800)
  // 轮询等待 composer 出现（最长 ~10s）
  let haveComposer = false
  for (let i = 0; i < 20; i++) {
    haveComposer = await evalJs(cdp, `!!document.querySelector('.cx-dock')`)
    if (haveComposer) break
    await sleep(500)
  }
  console.log('聊天页 composer 就绪:', haveComposer)
  if (!haveComposer) {
    const diag = await evalJs(cdp, `(function(){
      const btns=[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,25);
      return { url: location.href, rootChild: document.querySelector('#root')?.firstElementChild?.className||'', btns };
    })()`)
    console.log('诊断:', JSON.stringify(diag))
    await shot(cdp, 'verify-chat-diag.png')
    throw new Error('未渲染出聊天 composer')
  }

  // 2) 真实附件：构造 png(1x1)+txt，塞进隐藏 file input 并触发 change → 走 attachment:save
  const attRes = await evalJs(cdp, `(async function(){
    const pngB64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin=Uint8Array.from(atob(pngB64), c=>c.charCodeAt(0));
    const img=new File([bin],'demo.png',{type:'image/png'});
    const txt=new File([new Blob(['hello from verify'],{type:'text/plain'})],'note.txt',{type:'text/plain'});
    const input=document.querySelector('input[type=file]');
    if(!input) throw new Error('未找到文件输入框');
    const dt=new DataTransfer(); dt.items.add(img); dt.items.add(txt);
    input.files=dt.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,900));
    return {
      chips: document.querySelectorAll('.cx-att-chip').length,
      strip: !!document.querySelector('.cx-att-strip'),
    };
  })()`)
  console.log('待发送附件 chips:', attRes.chips, '附件条:', attRes.strip)
  await shot(cdp, 'verify-chat-attach.png')

  // 3) 直接验证 attachment:save 落盘 + attachment:read 回读（真实 IPC）
  const ipcRes = await evalJs(cdp, `(async function(){
    const id='verify_'+Date.now();
    const pngB64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const data=Uint8Array.from(atob(pngB64), c=>c.charCodeAt(0));
    const save=await window.torra.attachmentSave({ id, kind:'image', name:'probe.png', mime:'image/png', data });
    const read=await window.torra.attachmentRead(id);
    return { save, readOk: read && read.ok, b64len: read && read.base64 ? read.base64.length : 0 };
  })()`)
  console.log('attachmentSave/Read:', JSON.stringify(ipcRes))

  // 4) 落盘目录确有 {id}.bin / {id}.json
  const assetsDir = path.join(userData, 'torra', 'chat-assets')
  const onDisk = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : []
  console.log('磁盘资源文件:', onDisk.join(', ') || '(空)')

  // 5) 预置一轮含图片附件的会话，验证 ChatImageAtt 经 attachment:read 复原预览
  const seeded = await evalJs(cdp, `(async function(){
    const imgId='verify_seed_'+Date.now();
    const pngB64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const data=Uint8Array.from(atob(pngB64), c=>c.charCodeAt(0));
    await window.torra.attachmentSave({ id:imgId, kind:'image', name:'seed.png', mime:'image/png', data });
    // 读取当前侧栏选中的参与模型，作为 cells 的键，避免 order/cell 不匹配
    return { imgId };
  })()`)
  // 通过真实发送不可用（无密钥），改为直接在 DOM 挂载后写入 storage 再重载。
  // 关键：cells 必须覆盖所有可能的参与模型 id（order ⊆ cell 键），否则网格取值 undefined 会崩。
  await evalJs(cdp, `(async function(){
    const key='torra.chat.v1';
    const models=await window.torra.listModels();
    const cells={};
    models.forEach(m=>{ cells[m.id]={ content:'这是预置的一条回答，用于验证复制/重新生成/编辑按钮的渲染。', streaming:false }; });
    // 第二轮：故意让第一个模型的单元格带上失败态，用来验「只重试这个模型」的口径
    const cells2={};
    models.forEach((m,i)=>{
      cells2[m.id] = i===0
        ? { content:'', streaming:false, error:'生成结束但未捕获到内容（预置的验证用失败态）' }
        : { content:'这一格的回答是正常的。', streaming:false };
    });
    const chat={ id:'c_'+Date.now(), title:'验证会话', createdAt:Date.now(), system:'', turns:[
      { id:'t_'+Date.now(), question:'预置问题：附件与编辑验证',
        attachments:[{ id:'${seeded.imgId}', kind:'image', name:'seed.png', mime:'image/png', size:68 }],
        cells },
      { id:'t2_'+Date.now(), question:'预置问题：单模型重试验证', cells: cells2 }
    ]};
    localStorage.setItem(key, JSON.stringify([chat]));
    return { modelCount: models.length };
  })()`).then((v)=>console.log('预置模型数:', v.modelCount))
  // 重载以让 ChatPage 读到预置会话
  await cdp.send('Page.reload', {})
  await sleep(3500)
  // 重载后可能出现首次运行风险须知弹窗，先关掉
  await evalJs(cdp, `(function(){
    const b=[...document.querySelectorAll('button')].find(x=>/我已理解|继续使用|知道了|同意/.test(x.textContent||''));
    if(b) b.click();
    return !!b;
  })()`, false)
  await sleep(600)
  await evalJs(cdp, `(function(){ const b=[...document.querySelectorAll('button')].find(x=>/聊天/.test(x.textContent||'')); if(b) b.click(); return true; })()`, false)
  await sleep(1200)
  const seedDom = await evalJs(cdp, `(function(){
    return {
      questionBubble: !!document.querySelector('.cx-q'),
      cqActions: !!document.querySelector('.cx-q-actions'),
      attRow: !!document.querySelector('.cx-q-atts'),
      attImg: !!document.querySelector('.cx-q-att-img'),
      editBtn: [...document.querySelectorAll('.cx-q-actions button')].some(b=>/编辑/.test((b.title||'')+(b.getAttribute('aria-label')||''))),
      regenBtn: [...document.querySelectorAll('button')].some(b=>/重新生成/.test((b.title||'')+(b.getAttribute('aria-label')||''))),
    };
  })()`)
  console.log('预置轮次 DOM:', JSON.stringify(seedDom))

  // 5.5) 单模型重试：失败卡片只给「重试这个模型」，页面上不应再有任何整轮重试的入口
  // 只读 DOM，绝不点击重试按钮 —— 点了会走 chat:send，可能真去驱动网页模型跑一轮。
  const retryDom = await evalJs(cdp, `(function(){
    const card=document.querySelector('.cx-ans.has-error');
    if(card) card.scrollIntoView({block:'center'});
    const err=card ? card.querySelector('.cx-ans-error') : null;
    const btns=err ? [...err.querySelectorAll('button')] : [];
    const headerBtn=card ? card.querySelector('.cx-ans-tools [aria-label="重新生成"]') : null;
    return {
      hasErrorCard: !!card,
      retryLabel: btns.map(b=>(b.textContent||'').trim()).join('|'),
      noWholeTurnRetry: !/重试本轮|重新发送本轮/.test(document.body.innerText||''),
      headerRetryEnabled: !!headerBtn && !headerBtn.disabled,
      headerRetryTitle: headerBtn ? (headerBtn.title||'') : '',
    };
  })()`)
  console.log('失败卡片 DOM:', JSON.stringify(retryDom))

  // 放大那张失败卡：标题栏要有就地重新生成的按钮（同样只看不点）
  const focusDom = await evalJs(cdp, `(function(){
    const card=document.querySelector('.cx-ans.has-error');
    const btn=card ? card.querySelector('.cx-ans-tools [aria-label="放大查看"]') : null;
    if(!btn) return { opened:false };
    btn.click();
    return new Promise(res=>setTimeout(()=>{
      const modal=document.querySelector('.cx-focus');
      const rb=modal ? modal.querySelector('[aria-label="重新生成"]') : null;
      const hint=modal ? (modal.innerText||'') : '';
      const close=modal ? modal.querySelector('.cx-focus-close') : null;
      if(close) close.click();
      res({
        opened:true,
        modalRetry: !!rb && !rb.disabled,
        modalRetryTitle: rb ? (rb.title||'') : '',
        hintMentionsModal: /重新生成/.test(hint),
      });
    },350));
  })()`)
  console.log('放大视图 DOM:', JSON.stringify(focusDom))
  await shot(cdp, 'verify-chat-retry.png')

  const problems = []
  if (!retryDom.hasErrorCard) problems.push('失败的回答卡没有渲染出来（预置的 error 单元格没生效？）')
  if (!/重试这个模型/.test(retryDom.retryLabel)) problems.push(`失败卡片上没有「重试这个模型」，实际按钮是：${retryDom.retryLabel || '（无）'}`)
  if (!retryDom.noWholeTurnRetry) problems.push('页面上还残留整轮重试的入口文案')
  if (!retryDom.headerRetryEnabled) problems.push('卡片标题栏缺少可用的「重新生成」按钮')
  if (!/仅重跑这个模型/.test(retryDom.headerRetryTitle)) problems.push(`标题栏按钮的说明不指向单模型：${retryDom.headerRetryTitle}`)
  if (!focusDom.opened) problems.push('失败卡片没能放大')
  else if (!focusDom.modalRetry) problems.push('放大视图的标题栏缺少可用的重新生成按钮')
  else if (!/仅重跑这个模型/.test(focusDom.modalRetryTitle)) problems.push(`放大视图按钮说明不指向单模型：${focusDom.modalRetryTitle}`)
  if (problems.length) throw new Error('单模型重试验证不通过：' + problems.join('；'))

  // 进入编辑态
  const editDom = await evalJs(cdp, `(function(){
    const btn=[...document.querySelectorAll('.cx-q-actions button')].find(b=>/编辑/.test((b.title||'')+(b.getAttribute('aria-label')||'')));
    if(!btn) return { editing:false };
    btn.click();
    return new Promise(res=>setTimeout(()=>res({
      editing: !!document.querySelector('.cx-q-edit'),
      area: !!document.querySelector('.cx-q-edit-area'),
      saveBtn: [...document.querySelectorAll('button')].some(b=>/保存并重新发送/.test(b.textContent||'')),
    }),300));
  })()`)
  console.log('编辑态 DOM:', JSON.stringify(editDom))
  await shot(cdp, 'verify-chat-edit.png')

  console.log('\n== 验证完成 ==')
}

main()
  .then(() => cleanup(0))
  .catch((e) => {
    console.error('验证失败:', e.message)
    cleanup(1)
  })

function cleanup(code) {
  try { ws && ws.close() } catch { /* ignore */ }
  try { if (child && !child.killed) child.kill('SIGTERM') } catch { /* ignore */ }
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 800)
}
