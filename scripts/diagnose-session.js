/**
 * 会话持久化诊断（只读）
 *
 * 要回答的问题：登录后 cookie 到底存没存进分区？
 * 用户反馈「DeepSeek / Kimi 登录后还要反复登录，登录没登录一样」。
 *
 * 本脚本做三件事：
 * 1. 列出该分区当前持有的 cookie（只看域名与名，不导出值）
 * 2. 检查 localStorage / sessionStorage —— DeepSeek 与 Kimi 把登录态
 *    放在 localStorage 而非 cookie，只查 cookie 会误判为「没登录」
 * 3. 打开页面后比对「探针元素是否存在」与「是否落在登录墙」
 *
 * 关键：必须用与主进程完全相同的 partition + 同一个 userData 根目录，
 * 否则读到的是另一套空分区，结论无效。运行前请先退出 Torra。
 *
 * 用法：electron scripts/diagnose-session.js deepseek-web
 */

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'docs')

app.disableHardwareAcceleration()

// 分区名相同但 userData 根目录不同 = 另一套全新空分区。
// 直接跑脚本时落在 %APPDATA%\Electron，而 app 用 %APPDATA%\torra。
app.setName('torra')
app.setPath('userData', path.join(app.getPath('appData'), 'torra'))

const MODELS = {
  'deepseek-web': { partition: 'persist:torra-deepseek-web', entry: 'https://chat.deepseek.com/', probe: 'textarea[name="user query"]' },
  kimi: { partition: 'persist:torra-kimi', entry: 'https://www.kimi.com/', probe: 'div.chat-input-editor[contenteditable="true"]' },
  chatgpt: {
    partition: 'persist:torra-chatgpt',
    entry: 'https://chatgpt.com/',
    probe: 'div[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i],textarea[placeholder*="ChatGPT" i],textarea#mobile-composer-prompt,#prompt-textarea',
  },
  claude: { partition: 'persist:torra-claude', entry: 'https://claude.ai/new', probe: 'div[contenteditable="true"][role="textbox"]' },
  gemini: { partition: 'persist:torra-gemini', entry: 'https://gemini.google.com/app', probe: 'rich-textarea .ql-editor' },
}

const modelId = process.argv[2] || 'deepseek-web'
const cfg = MODELS[modelId]
if (!cfg) {
  process.stdout.write(`unknown model: ${modelId}\nknown: ${Object.keys(MODELS).join(', ')}\n`)
  app.exit(2)
}

/** 读页面里的各类存储。token 只报 key 名与长度，绝不输出值 */
const STORAGE_PROBE = `(() => {
  const ls = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      ls.push({ key: k, len: (localStorage.getItem(k) || '').length });
    }
  } catch (e) { ls.push({ error: String(e) }); }
  const ss = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      ss.push({ key: k, len: (sessionStorage.getItem(k) || '').length });
    }
  } catch (e) { ss.push({ error: String(e) }); }
  return {
    url: location.href,
    title: document.title,
    localStorage: ls,
    sessionStorage: ss,
    probeHit: (() => { try { return document.querySelectorAll(${JSON.stringify(cfg.probe)}).length; } catch { return -1; } })(),
    editables: document.querySelectorAll('[contenteditable="true"], textarea').length,
    loginWallEls: [...document.querySelectorAll('form[action*="login"],[name="captcha"],iframe[src*="recaptcha"]')].length,
    bodySnippet: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
  };
})()`

/** token 类 key 名特征：命中即高度疑似登录凭据 */
const TOKENISH = /token|auth|session|user|account|login|jwt|bearer|credential|__|passport|sso|uid/i

function classifyStorage(items) {
  const tokenish = []
  const other = []
  for (const it of items || []) {
    if (!it || !it.key) continue
    if (TOKENISH.test(it.key)) tokenish.push(it)
    else other.push(it)
  }
  return { tokenish, other }
}

app.whenReady().then(async () => {
  const partition = cfg.partition
  const ses = session.fromPartition(partition)

  const result = {
    modelId,
    partition,
    userData: app.getPath('userData'),
    entry: cfg.entry,
    probe: cfg.probe,
    phase1_beforeLoad: {},
    phase2_afterLoad: {},
  }

  // ---- 阶段一：只读分区当前状态（用户上次登录留下的）----
  try {
    const cookies = await ses.cookies.get({})
    const authLike = cookies
      .filter((c) => TOKENISH.test(c.name))
      .map((c) => ({ domain: c.domain, name: c.name, expires: c.expirationDate, session: c.session, httpOnly: c.httpOnly }))
    result.phase1_beforeLoad = {
      cookieTotal: cookies.length,
      cookieDomains: [...new Set(cookies.map((c) => c.domain))].sort(),
      authLikeCookies: authLike,
      hasAuthCookie: authLike.length > 0,
    }
  } catch (e) {
    result.phase1_beforeLoad = { error: String(e) }
  }

  // ---- 阶段二：加载页面后读取 ----
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  const wc = win.webContents

  try {
    await wc.loadURL(cfg.entry)
    result.loadedUrl = wc.getURL()
  } catch (e) {
    result.loadError = String(e)
  }

  await sleep(4000)

  try {
    const snap = await wc.executeJavaScript(STORAGE_PROBE, true)
    const ls = classifyStorage(snap.localStorage)
    const ss = classifyStorage(snap.sessionStorage)
    result.phase2_afterLoad = {
      url: snap.url,
      title: snap.title,
      probeHit: snap.probeHit,
      editables: snap.editables,
      loginWallEls: snap.loginWallEls,
      bodySnippet: snap.bodySnippet,
      localStorageTokenish: ls.tokenish,
      localStorageOtherCount: ls.other.length,
      sessionStorageTokenish: ss.tokenish,
      sessionStorageOtherCount: ss.other.length,
      // 判定：探针命中 = 已登录到对话页
      looksLoggedIn: snap.probeHit > 0,
      // 关键诊断点：登录态到底存在哪
      authStorageLocation: ls.tokenish.length > 0
        ? 'localStorage'
        : ss.tokenish.length > 0
          ? 'sessionStorage（随窗口关闭而丢，无法跨实例共享！）'
          : result.phase1_beforeLoad.authLikeCookies?.length
            ? 'cookie'
            : '未找到任何登录凭据',
    }
  } catch (e) {
    result.phase2_afterLoad = { error: String(e) }
  }

  // ---- 阶段三：cookie 是否在页面加载后有变化 ----
  try {
    const after = await ses.cookies.get({})
    result.cookieDelta = {
      before: result.phase1_beforeLoad.cookieTotal ?? 0,
      after: after.length,
      authLikeAfter: after.filter((c) => TOKENISH.test(c.name)).map((c) => c.domain + '::' + c.name),
    }
  } catch (e) {
    result.cookieDelta = { error: String(e) }
  }

  const outFile = path.join(OUT_DIR, `diagnose-session-${modelId}.json`)
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8')
  process.stdout.write(`DIAGNOSE_WRITTEN ${outFile}\n`)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  app.exit(0)
})

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
