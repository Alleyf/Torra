/**
 * 一次性快照：读取各分区当前 cookie 与落地 URL，不长时间驻留。
 * 用 setTimeout 兜底退出，避免站点加载缓慢时卡死。
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const YAML = require(path.join(ROOT, 'node_modules', 'yaml'))
const modelId = process.argv[2] || 'deepseek-web'
const WAIT = Number(process.argv[3] || 6000)

// 关键：显式对齐真实应用的 userData。
// `electron scripts/xxx.js` 没有 productName，Electron 会退回默认目录
// Roaming/Electron，导致读到另一套空分区 —— 结论完全无效。
app.setPath('userData', path.join(process.env.APPDATA || process.env.HOME || '', 'torra'))

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 兜底：无论如何 40 秒后退出
const guard = setTimeout(() => {
  console.log('GUARD_TIMEOUT')
  process.stdout.write('PARTIAL\n')
  app.exit(3)
}, 40_000)

app.whenReady().then(async () => {
  // modelId 与适配器文件不一定同名（deepseek-web -> deepseek.yaml）
  const ADAPTER_ALIAS = {
    'deepseek-web': 'deepseek',
    chatgpt: 'chatgpt',
    claude: 'claude',
    gemini: 'gemini',
    qwen: 'qwen',
    doubao: 'doubao',
    kimi: 'kimi',
  }
  const adapterFile = ADAPTER_ALIAS[modelId] ?? modelId
  const spec = YAML.parse(fs.readFileSync(path.join(ROOT, 'adapters', `${adapterFile}.yaml`), 'utf8'))
  const partition = `persist:torra-${modelId}`

  const ck = await session.fromPartition(partition).cookies.get({})
  const auth = ck.filter((c) => /token|session|auth|ssid|csrf|__Secure/i.test(c.name))

  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  win.webContents.setBackgroundThrottling(false)
  await win.loadURL(spec.entry).catch(() => {})
  await sleep(WAIT)

  const url = await win.webContents.executeJavaScript('location.href', true).catch(() => '(failed)')
  const probe = await win.webContents.executeJavaScript(
    `(() => { const c=(s)=>{try{return document.querySelectorAll(s).length}catch{return -1}};
      return { input: c(${JSON.stringify(spec.health_probe)}), ta: c('textarea'), ed: c('[contenteditable="true"]'),
               body: (document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,90) }; })()`, true,
  ).catch(() => null)

  const out = {
    modelId, partition, entry: spec.entry,
    landedUrl: url,
    probeHit: probe?.input ?? null,
    textarea: probe?.ta, contenteditable: probe?.ed,
    bodyHead: probe?.body,
    cookieTotal: ck.length,
    authCookieNames: auth.map((c) => `${c.domain}:${c.name}`),
    verdict: url.includes('/sign_in') || url.includes('/login')
      ? 'LOGIN_PAGE (未登录)'
      : (probe?.input ?? 0) > 0 ? 'READY (已登录且选择器命中)' : 'NO_INPUT (已登录但选择器不匹配)',
  }
  console.log(JSON.stringify(out, null, 2))
  fs.writeFileSync(path.join(ROOT, 'docs', `snapshot-${modelId}.json`), JSON.stringify(out, null, 2), 'utf8')
  win.destroy()
  clearTimeout(guard)
  app.exit(0)
})
