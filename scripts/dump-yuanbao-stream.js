/**
 * 临时诊断：真实元宝会话页上，按适配器 stream 选择器 dump 每个候选容器的
 * 文本长度与来源，确认「一条回答是不是被拆成多个 stream 节点」。
 * 跑完清理克隆分区（含真实 cookie）。
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('fs')
const path = require('path')
const YAML = require('yaml')

const ROOT = path.resolve(__dirname, '..')
const MODEL_ID = process.argv[2] || 'web-custom-2'
const CHAT_ARG = process.argv[3]
const CHAT = CHAT_ARG == null ? null : CHAT_ARG
const SRC = path.join(app.getPath('appData'), 'torra', 'Partitions', 'torra-user-' + MODEL_ID.replace(/^user-/, ''))
const CLONE = path.join(app.getPath('appData'), 'torra-domscan')
const PARTITION = 'persist:torra-user-' + MODEL_ID.replace(/^user-/, '')

function readAdapter(id) {
  const dirs = [path.join(ROOT, 'adapters'), path.join(app.getPath('appData'), 'torra', 'torra', 'adapters')]
  for (const dir of dirs) {
    const f = path.join(dir, id + '.yaml')
    if (!fs.existsSync(f)) continue
    const spec = YAML.parse(fs.readFileSync(f, 'utf8'))
    if (spec && spec.entry) return spec
  }
  throw new Error('no adapter for ' + id)
}

function cleanup() {
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(CLONE, { recursive: true, force: true }) } catch {}
    if (!fs.existsSync(CLONE)) return
    nap(400)
  }
  console.error('!! clone not removed: ' + CLONE)
}

app.setName('torra-stream-dump')
app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) { console.error('partition missing'); app.exit(1) }
  fs.rmSync(CLONE, { recursive: true, force: true })
  fs.mkdirSync(path.join(CLONE, 'Partitions'), { recursive: true })
  fs.cpSync(SRC, path.join(CLONE, 'Partitions', 'torra-user-' + MODEL_ID.replace(/^user-/, '')), {
    recursive: true, filter: (s) => path.basename(s) !== 'LOCK', force: true,
  })
  app.setPath('userData', CLONE)
  setTimeout(() => { cleanup(); app.exit(3) }, 180000)

  const spec = readAdapter(MODEL_ID)
  // 与生产同形：applyChromeIdentity 装 UA/客户端提示/navigator 文档补丁，
  // 只改 UA 字符串会被站点识别为异常环境（正文掉到 774 字符的那次就是它）。
  require(path.join(ROOT, 'dist/main/webview/chrome-identity')).applyChromeIdentity(
    session.fromPartition(PARTITION), PARTITION,
  )
  const win = new BrowserWindow({
    width: 1280, height: 900, x: -32000, y: -32000, show: true,
    skipTaskbar: true, focusable: false, frame: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  const view = new (require('electron').WebContentsView)({
    webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
  })
  view.webContents.setBackgroundThrottling(false)
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 })
  const wc = view.webContents
  try {
    // 与生产同形：先唤醒渲染进程并挂文档层身份补丁（内核级品牌覆盖），
    // 之后再进站点 —— 早于补丁的第一份文档会被站点判异常。
    await require(path.join(ROOT, 'dist/main/webview/chrome-identity')).primeDocumentIdentity(wc, PARTITION)
    await wc.loadURL(spec.entry)
    await new Promise((r) => setTimeout(r, 12000))
    const nav = await wc.executeJavaScript(`(() => {
      const want = ${JSON.stringify(CHAT)}
      const links = [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.innerText || '').trim() }))
      const hit = links.find(l => l.text && l.text.includes(want))
      if (hit) { hit.el = null; }
      if (hit) { const a = [...document.querySelectorAll('a[href]')].find(x => x.href === hit.href && (x.innerText || '').trim().includes(want)); if (a) a.click(); return { ok: true, href: hit.href } }
      if (want == null) { const first = [...document.querySelectorAll('a[href]')].find(x => /\\/(chat|c)\\//.test(x.href)); if (first) { first.click(); return { ok: true, href: first.href, text: (first.innerText || '').trim().slice(0, 40) } } }
      return { ok: false, links: links.slice(0, 12).map(l => l.text.slice(0, 24)), sample: [...document.querySelectorAll('a[href]')].slice(0, 12).map(a => a.href) }
    })()`, true)
    console.log('nav:', JSON.stringify(nav))
    if (!nav.ok) {
      // 会话列表可能不是 <a>（截图里就是普通节点）。按可见侧栏文本找目标。
      const nav2 = await wc.executeJavaScript(`(() => {
        const want = ${JSON.stringify(CHAT)}
        const cands = [...document.querySelectorAll('*')].filter(e => {
          const t = (e.innerText || '').trim()
          return t && t.length <= 60 && e.offsetParent !== null && e.children.length <= 4
        })
        const hit = cands.find(e => want == null ? /新建对话|最近/.test((e.innerText || '')) === false && false : (e.innerText || '').trim().includes(want))
        if (!hit) return { ok: false, sample: cands.slice(-30).map(e => (e.innerText || '').trim().slice(0, 24)) }
        hit.click()
        return { ok: true, text: (hit.innerText || '').trim().slice(0, 40) }
      })()`, true)
      console.log('nav2:', JSON.stringify(nav2))
      if (!nav2.ok) { cleanup(); app.exit(2) }
    }
    await new Promise((r) => setTimeout(r, 9000))
    const dump = await wc.executeJavaScript(`(() => {
      const side = [...document.querySelectorAll('*')].find(e => (e.innerText || '').includes('新建对话') && e.clientWidth < 420 && e.clientHeight > 300)
      const sideInfo = side ? { w: side.clientWidth, h: side.clientHeight, text: (side.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) } : null
      const anchors = [...document.querySelectorAll('a[href]')].length
      const sel = ${JSON.stringify(spec.selectors.stream)}
      const stat = (n) => {
        const r = n.getBoundingClientRect()
        return { len: (n.innerText || '').trim().length, cls: ('' + n.className).slice(0, 80), rect: [Math.round(r.top), Math.round(r.height)].join(','), head: (n.innerText || '').trim().slice(0, 60).replace(/\\s+/g, ' ') }
      }
      const nodes = [...document.querySelectorAll(sel)].map(stat)
      const contents = [...document.querySelectorAll('.hyc-content-md')].map(stat)
      const scroller = [...document.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 500 && e.clientHeight > 300)
      if (scroller) scroller.scrollTop = scroller.scrollHeight
      return new Promise(res => setTimeout(() => {
        const after = [...document.querySelectorAll(sel)].map(stat)
        const afterContents = [...document.querySelectorAll('.hyc-content-md')].map(stat)
        const bodyLen = (document.body.innerText || '').length
        res({ count: nodes.length, totalLen: nodes.reduce((s, x) => s + x.len, 0), contentCount: contents.length, contentTotalLen: contents.reduce((s, x) => s + x.len, 0), nodes: nodes.slice(-12), contents: contents.slice(-8), afterCount: after.length, afterTotal: after.reduce((s, x) => s + x.len, 0), afterContentCount: afterContents.length, afterContentTotal: afterContents.reduce((s, x) => s + x.len, 0), bodyLen, url: location.href.slice(0, 90), anchors, sideInfo })
      }, 1500))
    })()`, true)
    console.log(JSON.stringify(dump, null, 2))
  } catch (e) {
    console.error('ERR', e && e.message)
  }
  try { win.destroy() } catch {}
  await new Promise((r) => setTimeout(r, 800))
  cleanup()
  app.exit(0)
})
