/**
 * verify-lingguang —— 用**生产代码**验证灵光正文提取（只读，不发消息）
 *
 * 不重写逻辑：直接 require dist 里的 frames.ts 与 inject.ts，
 * 在真实会话页上跑 frameScan → pickTurnFrames → readFrameContent 这条生产路径。
 * 跑通就说明「灵光提取可用」，而不是「测试替身通过了」。
 *
 * 用法：electron scripts/verify-lingguang.js [--chat <标题>] [--wait ms]
 */
const { app, BrowserWindow, WebContentsView, session } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(app.isPackaged ? 1 : 2)
const flagVal = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const chatArg = flagVal('--chat', '检索时序知识图谱推理文献')
const waitMs = Number(flagVal('--wait', 14000))
const MODEL = 'user-web-custom-3'

const CLONE = path.join(app.getPath('appData'), 'torra-verify-lg')
const SRC = path.join(app.getPath('appData'), 'torra', 'Partitions', 'torra-' + MODEL)
app.setPath('userData', CLONE)

function clonePartition() {
  fs.rmSync(CLONE, { recursive: true, force: true })
  fs.mkdirSync(path.join(CLONE, 'Partitions'), { recursive: true })
  fs.copyFileSync(path.join(app.getPath('appData'), 'torra', 'Local State'), path.join(CLONE, 'Local State'))
  fs.cpSync(SRC, path.join(CLONE, 'Partitions', 'torra-' + MODEL), {
    recursive: true, filter: (s) => path.basename(s) !== 'LOCK', errorOnExist: false, force: true,
  })
}
function cleanup() {
  try { fs.rmSync(CLONE, { recursive: true, force: true }) } catch (e) {}
  if (fs.existsSync(CLONE)) console.log('!! 副本未删除：' + CLONE)
}

const YAML = require('yaml')
const spec = YAML.parse(fs.readFileSync(
  path.join(app.getPath('appData'), 'torra', 'torra', 'adapters', 'web-custom-3.yaml'), 'utf8'))

// 生产代码，不是仿造
const { pickTurnFrames, readFrameContent } = require('../dist/main/webview/frames')
const { INJECT_SCRIPT, INJECT_BUILD } = require('../dist/main/webview/inject')

let failures = 0
function check(name, ok, detail) {
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failures++
}

app.whenReady().then(async () => {
  clonePartition()
  const partition = 'persist:torra-' + MODEL
  session.fromPartition(partition).setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')
  const win = new BrowserWindow({
    width: 1280, height: 900, x: -32000, y: -32000, show: true, skipTaskbar: true, focusable: false, frame: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true } })
  view.webContents.setBackgroundThrottling(false)
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 })
  const wc = view.webContents
  setTimeout(() => { console.log('guard timeout'); cleanup(); app.exit(3) }, 200000)

  await wc.loadURL(spec.entry)
  await new Promise((r) => setTimeout(r, waitMs))

  const CLICK = `(() => {
    const needle = ${JSON.stringify(chatArg)}
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n, hit = null
    while ((n = w.nextNode())) { if ((n.nodeValue || '').includes(needle)) { hit = n.parentElement; break } }
    if (!hit) return 'no-text-node'
    let el = hit
    for (let i = 0; i < 8 && el; i++) {
      if (el.tagName === 'A' || el.onclick || el.getAttribute('role') === 'button' || ('' + (el.className || '')).includes('item')) break
      el = el.parentElement
    }
    ;(el || hit).scrollIntoView({ block: 'center' }); (el || hit).click()
    return 'clicked'
  })()`
  console.log('open:', await wc.executeJavaScript(CLICK, true).catch((e) => 'err:' + e.message))
  await new Promise((r) => setTimeout(r, 11000))

  const streamSel = spec.selectors.stream
  const frameSel = spec.selectors.stream_frame
  console.log('\n=== 生产路径验证（模型 ' + MODEL + '）===')
  console.log('stream=' + streamSel + '  stream_frame=' + frameSel)

  // 1. 页面侧：注入并报帧结构（生产用的同一个 __torra.frameScan）
  await wc.executeJavaScript(INJECT_SCRIPT, true)
  const scan = await wc.executeJavaScript(`window.__torra.frameScan(${JSON.stringify(streamSel)})`, true)
  check('页面侧报出帧结构', !!scan && Array.isArray(scan.last),
    scan ? `nodes=${scan.nodes} lastFrames=${(scan.last || []).length}` : 'null')

  // 2. 页面侧读到的文本（这就是用户看到的失败现场）
  const pageText = await wc.executeJavaScript(
    `window.__torra.read(${JSON.stringify(streamSel)}, 'last', 0, '', '')`, true)
  console.log('页面侧读到 ' + String(pageText || '').length + ' 字：' + JSON.stringify(String(pageText || '').slice(0, 60)))

  // 3. 主进程进帧读（生产用的同一个 pickTurnFrames / readFrameContent）
  const frames = pickTurnFrames(wc.mainFrame.framesInSubtree, scan)
  check('挑出本轮那一帧', frames.length === 1,
    frames.length + ' 帧' + (frames[0] ? ' · ' + String(frames[0].url).slice(0, 50) : ''))
  const got = await readFrameContent(frames, INJECT_SCRIPT, INJECT_BUILD, frameSel, true)
  check('帧里读出正文', got.text.trim().length > 200, got.text.length + ' 字')

  // 4. 正文质量：Markdown 结构真的在（标题 / 列表 / 链接）
  const md = got.text
  check('正文带 Markdown 标题', /^#{1,3} /m.test(md), (md.match(/^#{1,3} .*/m) || [''])[0].slice(0, 50))
  check('正文带列表项', /^\s*[-\d]/m.test(md), '')
  check('正文不是外壳状态条', !/^已思考 \d+s$/.test(md.trim()) && !md.includes('来自灵光移动端 App'),
    '页脚/状态条没有混进来')

  console.log('\n--- 正文前 400 字 ---')
  console.log(md.slice(0, 400))
  console.log('\n' + (failures === 0 ? '提取可用（' + got.text.length + ' 字）' : failures + ' 项未通过'))
  cleanup()
  app.exit(failures === 0 ? 0 : 1)
})
process.on('exit', cleanup)
