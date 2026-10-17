/**
 * 元宝真实页面上传模拟。
 *
 * 用 domscan 的分区克隆方式（不改运行中实例，不碰登录态）加载 yb 分区，
 * 注入生产 INJECT_SCRIPT，然后按生产链路执行 uploadFiles：
 *   1. dump 上传入口现场（附近的按钮/图标/菜单容器、file input 有无）
 *   2. 直接调 window.__torra.uploadFiles 传一个真实生成的测试文件
 *   3. 观察站点是否真的开始上传（预览节点 / 上传中指示 / change 触发）
 *
 * 输出逐步打印，任何一步卡住都能看清是哪一层的问题。
 * 结束时删除分区副本（含真实 cookie，不允许滞留磁盘）。
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('fs')
const path = require('path')
const YAML = require('yaml')

const ROOT = path.resolve(__dirname, '..')
const MODEL_ID = process.argv[2] || 'web-custom-2'
// --chat <序号|url|标题子串>：进入一个已有会话再测（与用户真实使用场景一致 ——
// 用户是在历史会话里发的附件，全新入口页的 composer 可能是另一个组件形态）
const chatIdx = (() => {
  const i = process.argv.indexOf('--chat')
  return i >= 0 ? process.argv[i + 1] : null
})()
// 用户自建模型的分区名带 user- 前缀（torra-user-<id>），适配器文件名不带
const SRC = path.join(app.getPath('appData'), 'torra', 'Partitions', 'torra-user-' + MODEL_ID.replace(/^user-/, ''))
const CLONE = path.join(app.getPath('appData'), 'torra-domscan')
const PARTITION = 'persist:torra-user-' + MODEL_ID.replace(/^user-/, '')

function readAdapter(id) {
  const candidates = [id, id.replace(/-web$/, ''), id.replace(/^user-/, '')]
  const dirs = [path.join(ROOT, 'adapters'), path.join(app.getPath('appData'), 'torra', 'torra', 'adapters')]
  for (const dir of dirs) for (const c of candidates) {
    const f = path.join(dir, c + '.yaml')
    if (!fs.existsSync(f)) continue
    const spec = YAML.parse(fs.readFileSync(f, 'utf8'))
    if (spec && spec.entry) return spec
  }
  throw new Error('no adapter for ' + id)
}

function clonePartition() {
  fs.rmSync(CLONE, { recursive: true, force: true })
  fs.mkdirSync(path.join(CLONE, 'Partitions'), { recursive: true })
  const partName = 'torra-user-' + MODEL_ID.replace(/^user-/, '')
  fs.cpSync(SRC, path.join(CLONE, 'Partitions', partName), {
    recursive: true, filter: (s) => path.basename(s) !== 'LOCK', force: true,
  })
}

function cleanup() {
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(CLONE, { recursive: true, force: true }) } catch {}
    if (!fs.existsSync(CLONE)) return
    nap(400)
  }
  console.error('!! 分区副本未删除（含真实 cookie），请手工删掉：' + CLONE)
}

/** 生成一个真实的小 html 附件（约 3KB），模拟用户上传书签导出文件 */
function makeTestFile() {
  const body = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<!-- This is an automatically generated file. -->\n' +
    Array.from({ length: 40 }, (_, i) => `<DT><A HREF="https://example.com/page-${i}" ADD_DATE="1752543161">示例书签 ${i + 1}</A>\n`).join('')
  return { name: 'torra-upload-test.html', mime: 'text/html', body }
}

app.setName('torra-upload-test')

app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) { console.error('partition missing:', SRC); app.exit(1) }
  try { clonePartition() } catch (e) { console.error('clone failed:', e.message); app.exit(1) }
  app.setPath('userData', CLONE)
  setTimeout(() => { console.error('guard timeout'); cleanup(); app.exit(3) }, 240000)

  const spec = readAdapter(MODEL_ID)
  const { INJECT_SCRIPT } = require('../dist/main/webview/inject')

  session.fromPartition(PARTITION).setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  )
  const win = new BrowserWindow({
    width: 1280, height: 900, x: -32000, y: -32000, show: true,
    skipTaskbar: true, focusable: false, frame: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  const view = new (require('electron').WebContentsView)({
    webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
  })
  view.webContents.setBackgroundThrottling(false)
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 })
  const wc = view.webContents
  wc.on('render-process-gone', () => { cleanup(); app.exit(2) })

  const errors = []
  const log = (k, v) => console.log(k + ':', typeof v === 'string' ? v : JSON.stringify(v))

  try {
    await wc.loadURL(spec.entry)
    await new Promise((r) => setTimeout(r, 12000))
    if (chatIdx != null) {
      // 元宝的会话列表不是 <a href>：条目是 div/span + 前端路由跳转。
      // 这里按侧栏文本找（与 domscan 同判据：含「新建对话」的窄容器），
      // 点文本命中的那个条目，然后等路由完成。
      const nav = await wc.executeJavaScript(`(() => {
        const links = [...document.querySelectorAll('a[href]')]
          .map(a => ({ href: a.href, text: (a.innerText || '').trim() }))
          .filter(l => l.href && /\\/(chat|c)\\//.test(l.href))
        if (links.length) {
          let hit = null
          if (/^\\d+$/.test(${JSON.stringify(String(chatIdx))})) hit = links[Number(${JSON.stringify(String(chatIdx))})]
          else hit = links.find(l => l.text && l.text.includes(${JSON.stringify(String(chatIdx))}))
          return hit ? { ok: true, href: hit.href, text: hit.text.slice(0, 40) } : { ok: false, count: links.length, sample: links.slice(0, 5).map(l => l.text.slice(0, 16)) }
        }
        // 无 <a>：找侧栏容器里的会话条目（title 属性或短文本），点击后回当前 URL
        const side = [...document.querySelectorAll('*')].find(e => (e.innerText || '').includes('新建对话') && e.clientWidth < 420 && e.clientHeight > 300)
        const urlBefore = location.href
        if (side) {
          const items = [...side.querySelectorAll('[title],[class*="item"],[class*="chat"],li,span,div')]
            .filter(e => { const t = (e.innerText || '').trim(); return t.length > 3 && t.length < 40 && e.offsetParent !== null })
          const want = ${JSON.stringify(String(chatIdx))}
          const el = /^\\d+$/.test(want) ? items[Number(want)] : items.find(e => (e.innerText || '').trim().includes(want))
          if (el) { el.click(); return { ok: true, href: urlBefore, text: (el.innerText || '').trim().slice(0, 40), clicked: true } }
          return { ok: false, count: items.length, sample: items.slice(0, 5).map(e => (e.innerText || '').trim().slice(0, 16)) }
        }
        return { ok: false, count: 0, noSidebar: true }
      })()`, true)
      log('chat-nav', nav)
      if (!nav.ok) { errors.push('没找到可进入的会话：' + JSON.stringify(nav)) }
      else {
        // 点击跳转（前端路由）不需要 loadURL；有 href 的才显式导航
        if (!nav.clicked && /^https?:/.test(nav.href)) await wc.loadURL(nav.href)
        await new Promise((r) => setTimeout(r, 9000))
      }
    }
    await wc.executeJavaScript(INJECT_SCRIPT, true)

    // 现场一：输入框与附近控件。没有输入框就谈不上上传。
    // 补充：dump 编辑器的祖先链与视口底部（composer 所在区域）的所有可见按钮。
    const probe1 = await wc.executeJavaScript(`(() => {
      const ed = document.querySelector('.ql-editor')
      if (!ed) return { hasEditor: false, url: location.href.slice(0, 80), body: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 160) }
      const ir = ed.getBoundingClientRect()
      const chain = []
      let p = ed.parentElement
      for (let i = 0; p && i < 8; i++) {
        chain.push({ tag: p.tagName.toLowerCase(), cls: ('' + p.className).slice(0, 80), rect: [Math.round(p.getBoundingClientRect().left), Math.round(p.getBoundingClientRect().top), Math.round(p.getBoundingClientRect().width), Math.round(p.getBoundingClientRect().height)].join(',') })
        p = p.parentElement
      }
      const bottomBtns = [...document.querySelectorAll('button,[role="button"]')]
        .filter(b => b.offsetParent !== null)
        .map(b => {
          const r = b.getBoundingClientRect()
          return { y: Math.round(r.top), x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
                   label: b.getAttribute('aria-label') || '', text: (b.innerText || '').trim().slice(0, 10), svg: !!b.querySelector('svg') }
        })
        .filter(b => b.y > 600)
        .sort((a, b) => a.y - b.y)
        .slice(0, 25)
      const btns = [...document.querySelectorAll('button,[role="button"]')].filter(b => {
        if (b.offsetParent === null) return false
        const r = b.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        const sameRow = Math.abs((r.top + r.height/2) - (ir.top + ir.height/2)) < Math.max(ir.height, r.height) * 0.6
        const gap = ir.left - r.right
        return sameRow && gap >= -8 && gap <= 200
      }).map(b => ({
        label: b.getAttribute('aria-label') || b.getAttribute('title') || '',
        text: (b.innerText || '').trim().slice(0, 12),
        cls: ('' + b.className).slice(0, 60),
        svg: !!b.querySelector('svg'),
        rect: [Math.round(b.getBoundingClientRect().left), Math.round(b.getBoundingClientRect().top), Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)].join(','),
      }))
      return { hasEditor: true, editorRect: [Math.round(ir.left), Math.round(ir.top), Math.round(ir.width), Math.round(ir.height)].join(','), chain, bottomBtns, nearby: btns.slice(0, 12) }
    })()`, true)
    log('probe1-nearby', probe1)
    if (!probe1.hasEditor) errors.push('页面上没有 .ql-editor（可能被风控/未登录）')

    // 现场二：全页 file input 与含「上传/文件/更多」语义的可见元素
    const probe2 = await wc.executeJavaScript(`(() => {
      const inputs = [...document.querySelectorAll('input[type="file"]')].map(i => ({ accept: i.getAttribute('accept'), visible: i.offsetParent !== null }))
      // 把「更多」按钮的几何现场量出来：它相对编辑器在哪个方向、多远
      const more = [...document.querySelectorAll('button,[role="button"]')]
        .find(b => (b.getAttribute('aria-label') || '') === '更多' || (b.innerText || '').trim() === '更多')
      const ed = document.querySelector('.ql-editor')
      const geo = (() => {
        if (!more || !ed) return null
        const br = more.getBoundingClientRect()
        const ir = ed.getBoundingClientRect()
        return {
          rect: [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)].join(','),
          editorRect: [Math.round(ir.left), Math.round(ir.top), Math.round(ir.width), Math.round(ir.height)].join(','),
          sameRow: Math.abs((br.top + br.height/2) - (ir.top + ir.height/2)) < Math.max(ir.height, br.height) * 0.6,
          centerDeltaY: Math.round(Math.abs((br.top + br.height/2) - (ir.top + ir.height/2))),
          gap: Math.round(ir.left - br.right),
          visible: more.offsetParent !== null,
          outer: more.outerHTML.slice(0, 300),
        }
      })()
      const sem = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],li,div')]
        .filter(e => e.offsetParent !== null && (e.innerText || '').trim().length > 0 && (e.innerText || '').trim().length <= 12)
        .map(e => ({ tag: e.tagName.toLowerCase(), text: (e.innerText || '').trim().slice(0, 10), label: e.getAttribute('aria-label') || e.getAttribute('title') || '' }))
        .filter(x => /上传|附件|本地文件|更多|文件/.test(x.text + ' ' + x.label))
      return { fileInputs: inputs, semantic: sem.slice(0, 20), moreGeo: geo }
    })()`, true)
    log('probe2-semantic', probe2)

    // 直接走生产链路：uploadFiles
    const tf = makeTestFile()
    const payload = { name: tf.name, mime: tf.mime, base64: Buffer.from(tf.body, 'utf8').toString('base64') }
    const result = await wc.executeJavaScript(
      `window.__torra.uploadFiles(${JSON.stringify(spec)}, ${JSON.stringify([payload])})`,
      true,
    ).catch((e) => ({ err: String((e && e.message) || e) }))
    log('upload-result', result)

    // 现场三：上传后的页面状态（预览节点/上传中指示/输入框内容）
    await new Promise((r) => setTimeout(r, 5000))
    const probe3 = await wc.executeJavaScript(`(() => {
      const ed = document.querySelector('.ql-editor')
      const imgs = document.querySelectorAll('img[src^="blob:"],img[src^="data:"]').length
      const chips = [...document.querySelectorAll('[class*="file"],[class*="upload"],[class*="attach"]')]
        .filter(e => e.offsetParent !== null && (e.innerText || '').trim())
        .map(e => ({ cls: ('' + e.className).slice(0, 60), text: (e.innerText || '').trim().slice(0, 40) }))
      return { editorText: ed ? (ed.innerText || '').trim().slice(0, 80) : null, imgs, chips: chips.slice(0, 8) }
    })()`, true)
    log('probe3-after', probe3)

    if (!result || !result.ok) errors.push('uploadFiles 未成功：' + JSON.stringify(result))
    else if ((probe3.imgs + probe3.chips.length) === 0) {
      errors.push('uploadFiles 报成功但页面上没有任何附件预览（可能交付到没人监听的 input）')
    }
  } catch (e) {
    errors.push('脚本自身抛错：' + ((e && e.stack) || e))
  }

  for (const e of errors) console.error('FAIL:', e)
  console.log(errors.length ? `FAILED (${errors.length})` : 'OK')
  try { win.destroy() } catch {}
  await new Promise((r) => setTimeout(r, 800))
  cleanup()
  app.exit(errors.length ? 1 : 0)
})
