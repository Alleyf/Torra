/**
 * 站点适配器诊断（只读）
 *
 * 目的：定位 webview 通道「input selector missing」的真正原因。
 * 只做页面导航与 DOM 读取，不键入、不发送、不修改任何站点数据。
 *
 * 关键：用与主进程完全相同的 partition（persist:torra-<model>），
 * 否则读到的是另一套 cookie，诊断结论无效。
 *
 * 用法：electron scripts/diagnose-webview.js [modelId]
 */

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'docs')

const MODELS = {
  chatgpt: {
    entry: 'https://chatgpt.com/',
    probe: 'div[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i],textarea[placeholder*="ChatGPT" i],textarea#mobile-composer-prompt,#prompt-textarea',
  },
  claude: { entry: 'https://claude.ai/new', probe: 'div[contenteditable="true"][role="textbox"]' },
  gemini: { entry: 'https://gemini.google.com/app', probe: 'rich-textarea .ql-editor' },
}

const modelId = process.argv[2] || 'chatgpt'
const cfg = MODELS[modelId]
if (!cfg) {
  process.stdout.write(`unknown model: ${modelId}\n`)
  app.exit(2)
}

app.disableHardwareAcceleration()

// 分区名相同但 userData 根目录不同 = 另一套全新空分区。electron 直接跑脚本时
// 落在 %APPDATA%\Electron，而 app 用 %APPDATA%\torra —— 不显式改这里，
// 读到的是空分区的登录态，诊断结论对 app 无效。运行前先退出 Torra。
app.setName('torra')
app.setPath('userData', path.join(app.getPath('appData'), 'torra'))

/**
 * 在页面上下文里跑的一次性探测。
 * 候选选择器来自公开的 ChatGPT/Claude/Gemini 自动化实践，用于判断
 * 「是本站改版了」还是「页面根本没到聊天页」。
 */
function probeScript(probe) {
  return `(() => {
  const count = (s) => { try { return document.querySelectorAll(s).length; } catch { return -1; } };
  const one = (s) => { try { const e = document.querySelector(s); return e ? describe(e) : null; } catch { return null; } };
  function describe(e) {
    const cs = (typeof e.className === 'string') ? e.className : '';
    return {
      tag: e.tagName,
      id: e.id || null,
      cls: cs.slice(0, 160) || null,
      role: e.getAttribute('role'),
      testid: e.getAttribute('data-testid'),
      aria: e.getAttribute('aria-label'),
      ph: e.getAttribute('placeholder'),
      contenteditable: e.getAttribute('contenteditable'),
      visible: e.offsetParent !== null || e.getClientRects().length > 0,
    };
  }

  // 所有可编辑区域（不限选择器）—— 站点改版时唯一可靠的发现方式
  const editables = [...document.querySelectorAll('[contenteditable="true"], textarea, input[type=text]')]
    .slice(0, 20).map(describe);

  // 所有按钮的语义属性（取前 40 个，找 send / stop 的真实标识）
  const buttons = [...document.querySelectorAll('button')]
    .slice(0, 40)
    .map((b) => ({
      testid: b.getAttribute('data-testid'),
      aria: b.getAttribute('aria-label'),
      disabled: b.disabled === true,
      visible: b.offsetParent !== null || b.getClientRects().length > 0,
    }))
    .filter((b) => b.testid || b.aria);

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    probeHit: count(${JSON.stringify(probe)}),
    loginWall: count('form[action*="login"],[name="captcha"],iframe[src*="recaptcha"],iframe[title*="challenge"]'),
    // 逐个列出登录墙命中元素，确认检测选择器本身是否可靠
    loginWallEls: [...document.querySelectorAll('form[action*="login"],[name="captcha"],iframe[src*="recaptcha"],iframe[title*="challenge"]')]
      .slice(0, 6)
      .map((e) => ({
        tag: e.tagName,
        action: e.getAttribute('action'),
        name: e.getAttribute('name'),
        src: (e.getAttribute('src') || '').slice(0, 80),
        title: e.getAttribute('title'),
        visible: e.offsetParent !== null || e.getClientRects().length > 0,
      })),
    // 未登录判定：ChatGPT 未登录时正文含「登录」CTA，且移动端 composer 出现
    looksLoggedOut: /登录|Log in|Sign up/.test(document.body?.innerText || '') &&
    !document.querySelector('div[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i],textarea[placeholder*="ChatGPT" i],textarea#mobile-composer-prompt,#prompt-textarea'),
    cfChallenge: count('#challenge-form,#cf-challenge-running,[id*="cf-chl"]'),
    candidates: {
      'chatgpt composer': count('div[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i],textarea[placeholder*="ChatGPT" i],textarea#mobile-composer-prompt,#prompt-textarea'),
      'ProseMirror composer': count('div.ProseMirror[contenteditable="true"][role="textbox"]'),
      'unified-composer form': count('form[data-type="unified-composer"]'),
      'any [contenteditable=true]': count('[contenteditable="true"]'),
      'textarea': count('textarea'),
      'send-button': count('button[data-testid="send-button"]'),
      'aria Send message': count('button[aria-label*="Send" i]'),
      'stop-button': count('button[data-testid="stop-button"]'),
      'aria Stop': count('button[aria-label*="Stop" i]'),
      'assistant msg': count('div[data-message-author-role="assistant"]'),
      'conversation-turn': count('[data-testid^="conversation-turn"]'),
    },
    probeElement: one(${JSON.stringify(probe)}),
    editables,
    buttons,
    bodyText: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
  };
})()`
}

app.whenReady().then(async () => {
  const partition = `persist:torra-${modelId}`
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  const wc = win.webContents
  const consoleErrors = []
  wc.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(String(message).slice(0, 200))
  })

  const didFailLoad = []
  wc.on('did-fail-load', (_e, code, desc, url) => {
    didFailLoad.push({ code, desc, url })
  })

  const result = {
    modelId,
    partition,
    userData: app.getPath('userData'),
    entry: cfg.entry,
    consoleErrors,
    didFailLoad,
  }

  try {
    await wc.loadURL(cfg.entry)
    result.loadedUrl = wc.getURL()
  } catch (e) {
    result.loadError = String(e && e.message ? e.message : e)
  }

  // 给 SPA 渲染留时间：ChatGPT 首屏 composer 通常在 load 后 1~3s 才挂载。
  // 这里分 3 个时间点采样，用于区分「一直不存在」与「只是慢」。
  const samples = []
  for (const waitMs of [1500, 3000, 5000]) {
    await sleep(waitMs === 1500 ? 1500 : 3000)
    try {
      const snap = await wc.executeJavaScript(probeScript(cfg.probe), true)
      samples.push({ atMs: waitMs, ...snap })
    } catch (e) {
      samples.push({ atMs: waitMs, error: String(e && e.message ? e.message : e) })
    }
  }
  result.samples = samples

  // 会话 cookie 存在性（只看域名与名，不取值 —— 不导出凭据）
  try {
    const cookies = await session.fromPartition(partition).cookies.get({})
    const domains = [...new Set(cookies.map((c) => c.domain))].sort()
    const names = cookies
      .filter((c) => /auth|session|token|csrf|__Secure|next/i.test(c.name))
      .map((c) => c.domain + ' :: ' + c.name)
      .slice(0, 25)
    result.cookies = { total: cookies.length, domains, authLikeNames: names }
  } catch (e) {
    result.cookies = { error: String(e && e.message ? e.message : e) }
  }

  const outFile = path.join(OUT_DIR, `diagnose-${modelId}.json`)
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8')
  process.stdout.write(`DIAGNOSE_WRITTEN ${outFile}\n`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  app.exit(0)
})

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
