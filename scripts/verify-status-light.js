/**
 * 验证修复：状态灯是否反映真实登录态，而非 Agent 初始值 'ready'。
 *
 * 做法：复刻 src/main/index.ts 的 probeAllAgents 逻辑，
 * 对每个 webview 型模型跑一次 healthCheck，打印真实状态。
 * 只读，不键入不发送。
 */

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')

function loadInject() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'webview', 'inject.ts'), 'utf8')
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const m = { exports: {} }
  new Function('exports', 'require', 'module', '__filename', '__dirname', out)(
    m.exports, require, m, 'inject.ts', ROOT,
  )
  return m.exports.INJECT_SCRIPT
}

// 与 loadDefaultModels() 中的 webview 型模型一致
const MODELS = [
  { id: 'chatgpt', adapter: 'chatgpt' },
  { id: 'deepseek-web', adapter: 'deepseek' },
  { id: 'claude', adapter: 'claude' },
  { id: 'qwen', adapter: 'qwen' },
  { id: 'doubao', adapter: 'doubao' },
  { id: 'kimi', adapter: 'kimi' },
]

// 关键：显式对齐真实应用的 userData。
// `electron scripts/xxx.js` 没有 productName，Electron 会退回默认目录
// Roaming/Electron，导致读到另一套空分区 —— 结论完全无效。
app.setPath('userData', path.join(process.env.APPDATA || process.env.HOME || '', 'torra'))

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
// 保持引用：销毁最后一个窗口会让 Electron 触发 window-all-closed 并退出应用，
// 导致循环在第一个站点后就终止（实测仅输出 chatgpt 一行）。
const keepAlive = { windows: [] }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.on('window-all-closed', (e) => {
  // 故意不退出：本脚本自行控制生命周期
  void e
})

app.whenReady().then(async () => {
  const YAML = require(path.join(ROOT, 'node_modules', 'yaml'))
  const INJECT = loadInject()
  const results = []

  for (const m of MODELS) {
    const rec = { modelId: m.id, partition: `persist:torra-${m.id}` }
    try {
      const spec = YAML.parse(
        fs.readFileSync(path.join(ROOT, 'adapters', `${m.adapter}.yaml`), 'utf8'),
      )
      rec.entry = spec.entry
      rec.healthProbe = spec.health_probe
      await runOne(m, spec, rec.partition, rec, INJECT)
    } catch (e) {
      rec.fatal = String(e && e.message ? e.message : e)
    }
    results.push(rec)
    process.stdout.write(
      `${m.id.padEnd(14)} before=${String(rec.statusBeforeFix).padEnd(8)} after=${String(rec.statusAfterFix).padEnd(16)} url=${rec.finalUrl || '-'}\n`,
    )
  }

  fs.writeFileSync(path.join(ROOT, 'docs', 'verify-status-light.json'),
    JSON.stringify(results, null, 2), 'utf8')
  process.stdout.write('\nWROTE docs/verify-status-light.json\n')
  app.exit(0)
})

async function runOne(m, spec, partition, rec, INJECT) {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  const wc = win.webContents
  wc.setBackgroundThrottling(false)

  try {
    await wc.loadURL(spec.entry)
  } catch (e) {
    rec.loadError = String(e && e.message ? e.message : e)
  }
  await sleep(5000)
  try { await wc.executeJavaScript(INJECT, true) } catch (e) { rec.injectError = String(e.message) }

  let probe
  try {
    probe = await wc.executeJavaScript(
      `window.__torra.probe(${JSON.stringify(spec.health_probe)})`, true)
  } catch (e) {
    probe = { ok: false, reason: 'probe threw: ' + e.message }
  }
  rec.probe = probe
  rec.statusAfterFix = probe?.ok ? 'ready' : probe?.reason === 'login-required' ? 'expired' : 'adapter-broken'
  rec.statusBeforeFix = 'ready'

  try { rec.finalUrl = await wc.executeJavaScript('location.href', true) } catch { /* ignore */ }

  win.destroy()
  keepAlive.windows = keepAlive.windows.filter((w) => !w.isDestroyed())
}
