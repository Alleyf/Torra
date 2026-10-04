/**
 * 只读诊断：对比多个分区的真实登录态与选择器命中情况。
 * 用于回答「为什么状态灯颜色不同」，不键入、不发送。
 *
 * 用法：electron scripts/diagnose-partitions.js
 */

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

// 与 src/main/index.ts loadDefaultModels() 保持一致
const TARGETS = [
  { modelId: 'chatgpt', adapterFile: 'chatgpt.yaml' },
  { modelId: 'deepseek-web', adapterFile: 'deepseek.yaml' },
  { modelId: 'claude', adapterFile: 'claude.yaml' },
  { modelId: 'gemini', adapterFile: 'gemini.yaml' },
]

app.disableHardwareAcceleration()

/** 极简 YAML 取值：只需 id/entry/health_probe/selectors.input */
function readAdapterSpec(file) {
  const text = fs.readFileSync(file, 'utf8')
  const yaml = require(path.join(ROOT, 'node_modules', 'yaml'))
  return yaml.parse(text)
}

function probeScript(probe) {
  return `(() => {
  const count = (s) => { try { return document.querySelectorAll(s).length; } catch { return -1; } };
  const editables = [...document.querySelectorAll('[contenteditable="true"], textarea')]
    .slice(0, 6).map((e) => ({
      tag: e.tagName,
      id: e.id || null,
      name: e.getAttribute('name'),
      ph: (e.getAttribute('placeholder')||'').slice(0,40),
      visible: e.offsetParent !== null || e.getClientRects().length > 0,
    }));
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    probeHit: count(${JSON.stringify(probe)}),
    loginWall: count('form[action*="login"],[name="captcha"],iframe[src*="recaptcha"],iframe[title*="challenge"]'),
    editables,
    bodyText: (document.body?.innerText || '').replace(/\\s+/g,' ').slice(0, 260),
  };
})()`
}

app.whenReady().then(async () => {
  const out = []

  for (const t of TARGETS) {
    const rec = { modelId: t.modelId, partition: `persist:torra-${t.modelId}` }
    try {
      const spec = readAdapterSpec(path.join(ROOT, 'adapters', t.adapterFile))
      rec.entry = spec.entry
      rec.probe = spec.health_probe

      const win = new BrowserWindow({
        width: 1280, height: 860, show: false,
        webPreferences: {
          partition: rec.partition,
          nodeIntegration: false, contextIsolation: true, sandbox: true,
        },
      })
      const wc = win.webContents
      await wc.loadURL(spec.entry)
      await sleep(5000)
      rec.dom = await wc.executeJavaScript(probeScript(spec.health_probe), true)

      const cookies = await session.fromPartition(rec.partition).cookies.get({})
      rec.cookieCount = cookies.length
      rec.authCookieNames = cookies
        .filter((c) => /token|session|auth|ssid|csrf|__Secure/i.test(c.name))
        .map((c) => c.name)
        .slice(0, 10)
      rec.looksLoggedOut = /登录|注册|Sign up|Log in/.test(rec.dom.bodyText)

      win.destroy()
    } catch (e) {
      rec.error = String(e && e.message ? e.message : e)
    }
    out.push(rec)
    process.stdout.write(`--- ${t.modelId} ---\n${JSON.stringify(rec, null, 2)}\n`)
  }

  fs.writeFileSync(path.join(ROOT, 'docs', 'diagnose-partitions.json'), JSON.stringify(out, null, 2), 'utf8')
  process.stdout.write('WROTE docs/diagnose-partitions.json\n')
  app.exit(0)
})

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
