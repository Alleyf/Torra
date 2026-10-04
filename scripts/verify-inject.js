/**
 * 回归验证：注入脚本对「未登录」与「适配器失效」的判定是否分得开。
 *
 * 期望：已登录 → probe.ok；未登录 → probe 与 send 都返回 login-required
 * （而不是 selector missing / adapter-broken）。
 * 该脚本不键入、不发送，纯只读。
 */

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')

function loadInjectScript() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'webview', 'inject.ts'), 'utf8')
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const sandboxModule = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', out)(
    sandboxModule.exports, require, sandboxModule, __filename, __dirname,
  )
  return sandboxModule.exports.INJECT_SCRIPT
}

app.disableHardwareAcceleration()

// 关键：必须落到与主进程同一套 userData。分区名相同但根目录不同 = 另一套
// 全新空分区，测出来的登录态与站点状态对本 app 完全无效（此前踩过：
// 脚本在 %APPDATA%\Electron 里测出「未登录」，而 app 用的是 %APPDATA%\torra）。
// 运行前先退出 Torra，否则分区被占用。
app.setName('torra')
app.setPath('userData', path.join(app.getPath('appData'), 'torra'))

app.whenReady().then(async () => {
  const INJECT = loadInjectScript()
  const inputSelector = 'div[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i],textarea[placeholder*="ChatGPT" i],textarea#mobile-composer-prompt,#prompt-textarea'
  const spec = { selectors: { input: inputSelector, send: 'button[aria-label*="Send message" i],button[aria-label*="发送消息"],button[data-testid="send-button"]' },
                 automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: [1, 1] } }

  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { partition: 'persist:torra-chatgpt', nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  const wc = win.webContents
  await wc.loadURL('https://chatgpt.com/')
  await sleep(4000)
  await wc.executeJavaScript(INJECT, true)

  const probe = await wc.executeJavaScript(`window.__torra.probe(${JSON.stringify(inputSelector)})`, true)
  // send 内部最多等 15s 挂载选择器；此处只验证它不误报 selector missing，
  // 加超时兜底避免脚本挂死。
  const send = await Promise.race([
    wc.executeJavaScript(`window.__torra.send(${JSON.stringify(spec)}, 'x')`, true),
    sleep(20000).then(() => ({ ok: false, reason: 'TIMEOUT_GUARD' })),
  ])

  const result = {
    userData: app.getPath('userData'),
    probe,
    send,
    // 判定标准：只要没把现场误报成 selector missing 类结论就算通过 ——
    // 已登录（ok）与确实未登录（login-required）都是正确回答。
    pass: ![probe, send].some((r) => r && r.ok !== true && r.reason !== 'login-required'),
  }
  fs.writeFileSync(path.join(ROOT, 'docs', 'verify-inject.json'), JSON.stringify(result, null, 2), 'utf8')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  app.exit(result.pass ? 0 : 1)
})

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
