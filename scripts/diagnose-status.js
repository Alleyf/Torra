/**
 * 状态灯判定诊断（只读）
 *
 * 回答：用户已登录 DeepSeek，为何状态灯仍是红色？
 *
 * 需要区分三种「红」，它们的修复方向完全不同：
 *   expired          → 登录态判定失败（inspectLogin 说不准）
 *   adapter-broken   → 选择器失效（探针找不到输入框）
 *   disabled         → agent 未创建（连实例都没有）
 *
 * 用法：electron scripts/diagnose-status.js deepseek-web
 * 运行前请先退出 Torra（否则分区被锁，读到的状态不可信）。
 */

const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'docs')

app.disableHardwareAcceleration()

// 必须与主进程对齐，否则读到的是 %APPDATA%\Electron 下的空分区
app.setName('torra')
app.setPath('userData', path.join(app.getPath('appData'), 'torra'))

const MODELS = {
  'deepseek-web': 'deepseek',
  kimi: 'kimi',
  qwen: 'qwen',
  doubao: 'doubao',
  chatgpt: 'chatgpt',
  claude: 'claude',
  gemini: 'gemini',
}

const modelId = process.argv[2] || 'deepseek-web'
const adapterId = MODELS[modelId]
if (!adapterId) {
  process.stdout.write(`unknown model: ${modelId}\nknown: ${Object.keys(MODELS).join(', ')}\n`)
  app.exit(2)
}

/**
 * 极简 YAML 取值：只取本脚本需要的几个标量字段。
 * 不引 yaml 依赖 —— Electron 主进程对 node_modules 的 require 路径
 * 与 node 不同，引依赖容易踩坑，而这里只需三四个字符串。
 */
function loadSpec() {
  const f = path.join(ROOT, 'adapters', `${adapterId}.yaml`)
  if (!fs.existsSync(f)) throw new Error(`adapter not found: ${f}`)
  const text = fs.readFileSync(f, 'utf8')
  // 行内注释会造成误匹配（如 health_probe 后跟 # 说明），
  // 故按「单引号 > 双引号 > 裸值」的顺序取值
  const pick = (key, indent) => {
    const re = new RegExp(`^${indent}${key}:\\s*(.*)$`, 'm')
    const m = text.match(re)
    if (!m) return ''
    let v = m[1].trim()
    const sq = v.match(/^'([\\s\\S]*)'\\s*(?:#.*)?$/)
    if (sq) return sq[1]
    const dq = v.match(/^"([\\s\\S]*)"\\s*(?:#.*)?$/)
    if (dq) return dq[1]
    return v.replace(/\s+#.*$/, '').trim()
  }
  const pickTop = (key) => pick(key, '')
  const pickSel = (key) => pick(key, '\\s{2}')
  return {
    entry: pickTop('entry'),
    health_probe: pickTop('health_probe'),
    selectors: {
      input: pickSel('input'),
      stream: pickSel('stream'),
      stop: pickSel('stop'),
    },
  }
}

app.whenReady().then(async () => {
  const spec = loadSpec()
  // 与 main/index.ts 的 partitionOf 规则一致
  const partition = `persist:torra-${modelId}`
  const ses = session.fromPartition(partition)

  const out = { modelId, adapterId, partition, spec: { entry: spec.entry, health_probe: spec.health_probe } }

  // ---- cookie 现状 ----
  try {
    const cookies = await ses.cookies.get({})
    out.cookies = {
      total: cookies.length,
      authLike: cookies
        .filter((c) => /token|auth|session|jwt|bearer|uid|passport(?!_csrf)|__Secure/i.test(c.name) && !/passport_csrf|bd_sso/i.test(c.name))
        .map((c) => `${c.domain} :: ${c.name}`),
    }
  } catch (e) {
    out.cookies = { error: String(e) }
  }

  // ---- 打开页面，复现主流程的三项判定 ----
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  const wc = win.webContents

  try {
    await wc.loadURL(spec.entry)
    out.loadedUrl = wc.getURL()
  } catch (e) {
    out.loadError = String(e)
  }

  await sleep(5000)

  try {
    out.observed = await wc.executeJavaScript(
      `(() => {
        const count = (s) => { try { return document.querySelectorAll(s).length; } catch { return -1; } };
        const visible = (s) => { try { const e = document.querySelector(s); if (!e) return false; return e.offsetParent !== null; } catch { return false; } };
        const grab = (st) => { const a = []; try { for (let i = 0; i < st.length; i++) a.push(st.key(i)); } catch {} return a; };
        return {
          url: location.href,
          // 决定性证据
          onLoginPage: /\\/(sign_?in|sign_?up|login|register|auth)(\\/|$)/i.test(location.pathname),
          loginCta: [...document.querySelectorAll('button,a,span,div')]
            .map(e => (e.textContent || '').trim())
            .filter(t => t.length > 0 && t.length < 12)
            .some(t => /^(登录|立即登录|登录\\/注册|Sign in|Log in|Login|注册)$/.test(t)),
          localKeys: grab(localStorage).slice(0, 30),
          // 探针能否命中（注意：命中 ≠ 已登录）
          healthProbeHit: count(${JSON.stringify(spec.health_probe)}),
          inputHit: count(${JSON.stringify(spec.selectors.input)}),
          streamHit: count(${JSON.stringify(spec.selectors.stream)}),
          stopVisible: ${spec.selectors.stop ? `visible(${JSON.stringify(spec.selectors.stop)})` : 'null'},
          editables: count('[contenteditable="true"], textarea'),
          bodySnippet: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
        };
      })()`,
      true,
    )
  } catch (e) {
    out.observed = { error: String(e) }
  }

  // ---- 复刻 inspectLogin 的判定链 ----
  const ob = out.observed || {}
  if (ob.onLoginPage) {
    out.inspectLoginVerdict = { state: 'logged-out', reason: '落在登录页' }
  } else {
    const tokenish = (ob.localKeys || []).filter((k) =>
      /token|auth|session|user|account|uid|jwt|bearer|credential|passport|sso/i.test(k),
    )
    const hasUserFlag = (ob.localKeys || []).some((k) => /^__.*user|^.*_user$|profile|account/i.test(k))
    if (hasUserFlag) {
      out.inspectLoginVerdict = { state: 'logged-in', reason: '检测到用户态标记', tokenish }
    } else if (tokenish.length > 0 && !ob.loginCta) {
      out.inspectLoginVerdict = { state: 'logged-in', reason: '有凭据且无登录入口', tokenish }
    } else if (ob.loginCta && tokenish.length === 0) {
      out.inspectLoginVerdict = { state: 'logged-out', reason: '有登录入口且无凭据' }
    } else {
      out.inspectLoginVerdict = {
        state: 'unknown',
        reason: '无法判定',
        tokenish,
        tokenishCount: tokenish.length,
        hasCta: !!ob.loginCta,
      }
    }
  }

  // ---- healthCheck 复刻：探针命中即 ok ----
  out.healthCheckWouldReturn = ob.healthProbeHit > 0

  const outFile = path.join(OUT_DIR, `diagnose-status-${modelId}.json`)
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8')
  process.stdout.write(`DIAGNOSE_WRITTEN ${outFile}\n`)
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  app.exit(0)
})

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
