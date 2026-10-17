/**
 * 临时取证：在真实网页会话里 dump 回答节点内的 <img> 形态（src scheme / 尺寸 / alt / 父级 class）。
 * 复用 domscan 的分区克隆，跑完删除副本（含真实 cookie）。
 *
 * 用法：electron scripts/probe-answer-images.js <modelId> [--find <会话标题子串>] [--md <选择器>] [--wait ms]
 */
const { app, BrowserWindow, session, WebContentsView } = require('electron')
const fs = require('fs')
const path = require('path')
const YAML = require('yaml')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--find', '--md', '--wait'].includes(argv[i - 1]))
const MODEL_ID = positional[0] || 'web-custom-2'
const FIND = process.env.PROBE_FIND || flag('--find')
const MD = process.env.PROBE_MD || flag('--md')
const WAIT = Number(flag('--wait', 12000))

const SRC = path.join(app.getPath('appData'), 'torra', 'Partitions', 'torra-user-' + MODEL_ID.replace(/^user-/, ''))
const CLONE = path.join(app.getPath('appData'), 'torra-imgprobe')
const PARTITION = 'persist:torra-user-' + MODEL_ID.replace(/^user-/, '')

function readAdapter(id) {
  for (const dir of [path.join(ROOT, 'adapters'), path.join(app.getPath('appData'), 'torra', 'torra', 'adapters')]) {
    const f = path.join(dir, id + '.yaml')
    if (fs.existsSync(f)) { const s = YAML.parse(fs.readFileSync(f, 'utf8')); if (s && s.entry) return s }
  }
  throw new Error('no adapter for ' + id)
}
function cleanup() {
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  for (let i = 0; i < 3; i++) { try { fs.rmSync(CLONE, { recursive: true, force: true }) } catch {} if (!fs.existsSync(CLONE)) return; nap(400) }
  console.error('!! clone left behind: ' + CLONE)
}

app.setName('torra-imgprobe')
app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) { console.error('partition missing', SRC); app.exit(1) }
  fs.rmSync(CLONE, { recursive: true, force: true })
  fs.mkdirSync(path.join(CLONE, 'Partitions'), { recursive: true })
  fs.copyFileSync(path.join(app.getPath('appData'), 'torra', 'Local State'), path.join(CLONE, 'Local State'))
  fs.cpSync(SRC, path.join(CLONE, 'Partitions', 'torra-user-' + MODEL_ID.replace(/^user-/, '')), {
    recursive: true, filter: (s) => path.basename(s) !== 'LOCK', force: true,
  })
  app.setPath('userData', CLONE)
  setTimeout(() => { cleanup(); app.exit(3) }, 200000)

  const spec = readAdapter(MODEL_ID)
  const { applyChromeIdentity, primeDocumentIdentity } = require(path.join(ROOT, 'dist/main/webview/chrome-identity'))
  applyChromeIdentity(session.fromPartition(PARTITION), PARTITION)
  const win = new BrowserWindow({ width: 1280, height: 900, x: -32000, y: -32000, show: true, skipTaskbar: true, focusable: false, frame: false, webPreferences: { contextIsolation: true, sandbox: true } })
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true } })
  view.webContents.setBackgroundThrottling(false)
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 })
  const wc = view.webContents
  try {
    await primeDocumentIdentity(wc, PARTITION)
    await wc.loadURL(FIND && /^https?:/i.test(FIND) ? FIND : spec.entry)
    await new Promise((r) => setTimeout(r, WAIT))
    if (FIND && !/^https?:/i.test(FIND)) {
      // 会话列表项未必是 <a>，文本节点也常被拆：找「包含关键词的最深元素」，再向上找可点祖先
      const nav = await wc.executeJavaScript(`(() => {
        const want = ${JSON.stringify(FIND)}
        const all = [...document.querySelectorAll('*')].filter((e) => {
          const t = (e.innerText || '').trim()
          return t && t.includes(want) && t.length <= 120
        })
        if (!all.length) return { ok: false, count: 0 }
        const deepest = all[all.length - 1]
        let el = deepest
        for (let i = 0; i < 6 && el; i++) {
          el.click()
          if (location.href.indexOf('/chat/') >= 0) break
          el = el.parentElement
        }
        return { ok: true, text: (deepest.innerText || '').trim().slice(0, 40), href: location.href.slice(0, 80) }
      })()`, true)
      console.log('nav:', JSON.stringify(nav))
      // 取证失败时把页面文本与候选链接打出来，便于确认会话列表在哪
      if (!nav.ok) {
        const page = await wc.executeJavaScript(`(() => ({
          url: location.href.slice(0, 90),
          body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200),
          links: [...document.querySelectorAll('a[href]')].slice(0, 40).map(a => (a.getAttribute('href') || '') + ' :: ' + (a.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 24)),
        }))()`, true)
        console.log('PAGE', JSON.stringify(page, null, 1))
      }

      await new Promise((r) => setTimeout(r, 9000))
    }
    // 用真实页面验证抓取层：注入脚本后分别调 read / readImages
    const { INJECT_SCRIPT } = require(path.join(ROOT, 'dist/main/webview/inject'))
    await wc.executeJavaScript(INJECT_SCRIPT, true)
    const cap = await wc.executeJavaScript(`(() => ({
      build: window.__torra.__build,
      text: window.__torra.read(${JSON.stringify(MD || spec.selectors.stream)}, ${JSON.stringify(spec.stream_mode || 'last')}, 0, '', ''),
      imgs: window.__torra.readImages(${JSON.stringify(MD || spec.selectors.stream)}, 0, ''),
    }))()`, true)
    console.log('CAPTURE build=' + cap.build, '| textChars=' + String(cap.text || '').length, '| images=' + JSON.stringify((cap.imgs || []).map((x) => x.src.slice(0, 70)), null, 1))
    // 真实运行路径：虚拟化列表里 sinceCount 可能等于当前节点数（见 webview-agent 传入值）
    const capStale = await wc.executeJavaScript(
      `window.__torra.readImages(${JSON.stringify(MD || spec.selectors.stream)}, 1, '')`,
      true,
    )
    console.log('CAPTURE sinceCount=1 images=' + JSON.stringify((capStale || []).map((x) => x.src.slice(0, 60)), null, 1))

    const sel = MD || (spec.selectors || {}).stream
    const dump = await wc.executeJavaScript(`(() => {
      const sel = ${JSON.stringify(sel)}
      const nodes = [...document.querySelectorAll(sel)]
      const info = (n) => {
        const r = n.getBoundingClientRect()
        const chain = []
        for (let p = n.parentElement, k = 0; p && k < 5; p = p.parentElement, k++) {
          chain.push(p.tagName + '.' + ('' + (p.className || '')).split(' ').slice(0, 2).join('.'))
        }
        return {
          tag: n.tagName, src: (n.getAttribute('src') || '').slice(0, 140),
          srcset: (n.getAttribute('srcset') || '').slice(0, 80),
          complete: n.complete, nw: n.naturalWidth, nh: n.naturalHeight,
          rw: Math.round(r.width), rh: Math.round(r.height),
          alt: (n.getAttribute('alt') || '').slice(0, 40),
          cls: ('' + (n.className || '')).slice(0, 70),
          parentCls: ('' + ((n.parentElement && n.parentElement.className) || '')).slice(0, 70),
          gpTag: n.parentElement && n.parentElement.parentElement ? n.parentElement.parentElement.tagName : '',
          chain: chain.join(' < '),
        }
      }
      const out = []
      for (let i = Math.max(0, nodes.length - 6); i < nodes.length; i++) {
        const imgs = [...nodes[i].querySelectorAll('img,video,[data-src],picture source')].map(info)
        out.push({ idx: i, nodeCls: ('' + nodes[i].className).slice(0, 70), textLen: (nodes[i].innerText || '').trim().length, textHead: (nodes[i].innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60), imgs })
      }
      const loose = [...document.querySelectorAll('img')].map(info).filter(x => x.nw > 80 || x.rw > 80 || /blob:|data:|Image/i.test(x.alt))
      return { url: location.href.slice(0, 90), streamSel: sel, nodeCount: nodes.length, out, looseCount: loose.length, loose: loose.slice(-14) }
    })()`, true)
    console.log(JSON.stringify(dump, null, 2))
  } catch (e) {
    console.error('ERR', e && e.message)
  }
  try { win.destroy() } catch {}
  await new Promise((r) => setTimeout(r, 800))
  cleanup()
  app.exit(0)
})
