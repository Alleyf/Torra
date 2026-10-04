/**
 * 只读扫描：为指定站点列出当前真实的选择器候选。
 * 站点改版后用它来重新校准 YAML —— 不猜，看真实 DOM。
 *
 * 用法：electron scripts/scan-selectors.js <modelId>
 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const modelId = process.argv[2] || 'doubao'
const YAML = require(path.join(ROOT, 'node_modules', 'yaml'))

const SCAN = `(() => {
  const vis = (el) => {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  };
  const desc = (el) => {
    const t = (el.getAttribute('data-testid') ? '[data-testid=' + el.getAttribute('data-testid') + ']'
      : el.id ? '#' + el.id
      : (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''));
    return { sel: el.tagName.toLowerCase() + t, visible: vis(el) };
  };
  const pick = (q, n) => [...document.querySelectorAll(q)].slice(0, n).map(desc);
  return {
    url: location.href,
    title: document.title,
    textareas: pick('textarea', 5),
    editables: pick('[contenteditable="true"]', 5),
    sendButtons: pick('button[data-testid*="send" i],[data-testid*="send" i],[aria-label*="发送" i],[aria-label*="Send" i]', 5),
    stopButtons: pick('button[data-testid*="break" i],[data-testid*="stop" i],[aria-label*="停止" i]', 5),
    mdRoots: pick('.md-box-root, [class*="markdown" i]', 3),
    bodyHasLogin: /登录|登陆|Sign in|Log in/.test(document.body?.innerText || ''),
    bodyHead: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
  };
})()`

app.disableHardwareAcceleration()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const spec = YAML.parse(
    fs.readFileSync(path.join(ROOT, 'adapters', `${modelId}.yaml`), 'utf8'),
  )
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: {
      partition: `persist:torra-${modelId}`,
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  })
  try { await win.loadURL(spec.entry) } catch (e) { console.log('LOAD_FAIL', e.message) }
  await sleep(6000)
  const r = await win.executeJavaScript(SCAN, true)
  console.log(JSON.stringify(r, null, 2))
  fs.writeFileSync(path.join(ROOT, 'docs', `scan-${modelId}.json`), JSON.stringify(r, null, 2), 'utf8')
  win.destroy()
  app.exit(0)
})
