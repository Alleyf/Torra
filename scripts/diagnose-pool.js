/**
 * 对照诊断（只读）：未挂载到窗口的 WebContentsView 到底会不会完成导航、渲染出输入框
 *
 * A 组：与 pool.ensure 完全一致 —— new WebContentsView(...) 后直接 loadURL，不 addChildView、不设 bounds
 * B 组：同一 view 挂到窗口并给真实 bounds
 *
 * 全程不 await loadURL（若它永不 resolve，本身就是要抓的 bug）。
 * 每个事件即时追加写入 docs/diagnose-pool.log，便于定位卡在哪一步。
 *
 * 实测结论：A 组视口 0×0 → 站点渲染降级/移动端布局 → 桌面选择器不存在 →
 * 主进程误报「适配器失效」。这就是那类误报的根因证据。
 *
 * 注意：先退出 Torra 再跑 —— 下面把 userData 显式指到 %APPDATA%\torra，
 * 与主进程共用同一套分区；不指的话读到的是空分区，结论无效。
 *
 * 用法：electron scripts/diagnose-pool.js
 */

const { app, BrowserWindow, WebContentsView } = require('electron')
const fs = require('fs')
const path = require('path')

app.setName('torra')
app.setPath('userData', path.join(app.getPath('appData'), 'torra'))

const OUT_DIR = path.resolve(__dirname, '..', 'docs')
const LOG = path.join(OUT_DIR, 'diagnose-pool.log')
const JSON_OUT = path.join(OUT_DIR, 'diagnose-pool.json')
const T0 = Date.now()

function log(msg, extra) {
  const line = `[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`
  fs.appendFileSync(LOG, line, 'utf8')
  process.stderr.write(line)
}

const PROBE = `(() => {
  const q = (s) => { try { return document.querySelectorAll(s).length } catch { return -1 } };
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibility: document.visibilityState,
    vw: window.innerWidth, vh: window.innerHeight,
    promptTextarea: q('#prompt-textarea'),
    contenteditable: q('[contenteditable="true"]'),
    textarea: q('textarea'),
    loginForm: q('form[action*="login"]'),
    cf: q('iframe[src*="challenges.cloudflare"],iframe[title*="challenge"],#cf-challenge-running'),
    bodyChars: (document.body && document.body.innerText || '').length,
    bodyText: (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0,160),
  };
})()`

function track(wc, tag, events) {
  for (const ev of ['did-start-navigation', 'did-redirect-navigation', 'did-frame-navigate',
                    'did-finish-load', 'dom-ready', 'did-fail-load', 'render-process-gone',
                    'unresponsive', 'plugin-crashed']) {
    wc.on(ev, (...a) => {
      const rec = { ev, at: `+${((Date.now() - T0) / 1000).toFixed(1)}s`, args: a.slice(0, 4) }
      events.push(rec)
      log(`${tag} ${ev}`, { args: a.slice(0, 4).map(String) })
    })
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

process.on('uncaughtException', (e) => log('UNCAUGHT ' + (e && e.stack ? e.stack : e)))
process.on('unhandledRejection', (e) => log('UNHANDLED ' + (e && e.stack ? e.stack : String(e))))

async function probe(wc, tag) {
  const raced = await Promise.race([
    wc.executeJavaScript(PROBE, true).then((v) => ({ ok: true, v })),
    sleep(8000).then(() => ({ ok: false, v: 'executeJavaScript TIMEOUT 8s' })),
  ])
  log(`${tag} probe`, { ok: raced.ok, dom: raced.ok ? raced.v : raced.v })
  return raced
}

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '', 'utf8')
  const result = { startedAt: new Date(T0).toISOString(), userData: app.getPath('userData') }
  log('userData', { dir: app.getPath('userData') })

  const win = new BrowserWindow({ width: 1280, height: 860, show: false })
  log('窗口已创建')

  const evA = []
  const view = new WebContentsView({
    webPreferences: { partition: 'persist:torra-chatgpt', contextIsolation: true, sandbox: true },
  })
  view.webContents.setBackgroundThrottling(false)
  track(view.webContents, 'A', evA)
  result.A = { attached: false, bounds: view.getBounds(), events: evA }

  log('A: loadURL 发起（不 await，与 pool.ensure 一致）')
  const loadP = view.webContents.loadURL('https://chatgpt.com/')
  let loadSettled = null
  loadP.then(() => { loadSettled = 'resolved' }).catch((e) => { loadSettled = 'rejected: ' + e.message })

  await sleep(20000)
  result.A.loadPromise = loadSettled
  result.A.isLoading = view.webContents.isLoading()
  result.A.canGoBack = view.webContents.canGoBack()
  result.A.currentUrl = view.webContents.getURL()
  result.A.crashed = view.webContents.isCrashed()
  log('A: 20s 后状态', { loadPromise: loadSettled, isLoading: result.A.isLoading, url: result.A.currentUrl })
  result.A.dom = (await probe(view.webContents, 'A')).v

  // ---- B：挂载 + 给尺寸 ----
  view.setBounds({ x: 0, y: 0, width: 1200, height: 800 })
  win.contentView.addChildView(view)
  const evB = []
  result.B = { attached: true, bounds: view.getBounds(), events: evB }
  track(view.webContents, 'B', evB)
  log('B: 重新导航（挂载态）')
  const loadB = view.webContents.loadURL('https://chatgpt.com/')
  let settledB = null
  loadB.then(() => { settledB = 'resolved' }).catch((e) => { settledB = 'rejected: ' + e.message })
  await sleep(20000)
  result.B.loadPromise = settledB
  result.B.isLoading = view.webContents.isLoading()
  result.B.currentUrl = view.webContents.getURL()
  log('B: 20s 后状态', { loadPromise: settledB, isLoading: result.B.isLoading, url: result.B.currentUrl })
  result.B.dom = (await probe(view.webContents, 'B')).v

  fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2), 'utf8')
  log('DONE', { out: JSON_OUT })
  app.exit(0)
})

setTimeout(() => {
  log('GLOBAL TIMEOUT 90s')
  app.exit(1)
}, 90000)
