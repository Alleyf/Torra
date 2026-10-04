/**
 * 决定性验证：同一分区加载站点页面，直接读 DOM 判断登录态。
 * 不依赖 cookie API（可能读到的是过期/无效项）。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const YAML = require(path.join(ROOT, 'node_modules', 'yaml'))

const ADAPTER = { 'deepseek-web': 'deepseek', chatgpt: 'chatgpt', claude: 'claude', qwen: 'qwen', kimi: 'kimi', doubao: 'doubao' }

const modelId = process.argv[2] || 'chatgpt'
const WAIT = Number(process.argv[3] || 9000)

// 关键：显式对齐真实应用的 userData。
// `electron scripts/xxx.js` 没有 productName，Electron 会退回默认目录
// Roaming/Electron，导致读到另一套空分区 —— 结论完全无效。
app.setPath('userData', path.join(process.env.APPDATA || process.env.HOME || '', 'torra'))

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const guard = setTimeout(() => { console.log('GUARD'); app.exit(3) }, 45_000)

app.whenReady().then(async () => {
  const spec = YAML.parse(fs.readFileSync(path.join(ROOT, 'adapters', `${ADAPTER[modelId] ?? modelId}.yaml`), 'utf8'))
  const partition = `persist:torra-${modelId}`

  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  await wc.loadURL(spec.entry).catch(() => {})
  await sleep(WAIT)

  const r = await wc.executeJavaScript(`(() => {
    const txt = (document.body?.innerText || '');
    const probe = ${JSON.stringify(spec.health_probe)};
    const q = (s) => { try { return document.querySelectorAll(s).length } catch { return -1 } };
    return {
      url: location.href,
      title: document.title,
      probeHit: q(probe),
      // 站点特定的登录判据
      hasComposer: q('textarea') + q('[contenteditable="true"]'),
      // 常见未登录标志物
      loginWords: /登录|注册|Sign ?up|Log ?in/i.test(txt),
      chatWords: /新对话|新聊天|发送|问问|Ask|NEW CHAT/i.test(txt),
      head: txt.replace(/\\s+/g,' ').slice(0, 160),
    };
  })()`, true).catch((e) => ({ error: e.message }))

  console.log(JSON.stringify({ modelId, partition, entry: spec.entry, ...r }, null, 2))
  fs.writeFileSync(path.join(ROOT, 'docs', `domcheck-${modelId}.json`),
    JSON.stringify({ modelId, partition, ...r }, null, 2), 'utf8')
  win.destroy(); clearTimeout(guard); app.exit(0)
})
