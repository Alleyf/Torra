/**
 * domscan —— 消息 DOM 结构扫描器（默认只读；--ask 会代发一轮，账号里留下一条对话）
 *
 * 用途：核对/更新适配器时，抓取站点真实消息容器的 class 结构树，
 * 回答「思考/工具调用/正文分别是什么选择器」这类问题。
 *
 * 关键设计：不要求退出 Torra。把目标分区复制到独立 userData
 * （%APPDATA%\torra-domscan）再以同一分区名加载 —— 运行中的实例锁着
 * 原分区，但复制出来的 cookie/存储足以还原登录态。扫描结束立即删除
 * 副本（副本含会话凭据，不允许滞留磁盘）。
 *
 * 用法：
 *   electron scripts/domscan.js [modelId=kimi] [--chat <序号|url>] [--wait ms]
 *                              [--md <选择器>] [--ask <提示词>]
 *   --md：默认取适配器的 stream。输出「这一轮会被捕获成什么 Markdown」
 *         以及对应节点的 outerHTML —— 排版出问题时，只有同时拿到 DOM 和捕获结果，
 *         才分得清是站点结构、抓取（mdOf）还是渲染端的锅。
 *   --ask：代发一条真实消息再扫（会在该账号下留下一条对话，只在显式给出时才做）。
 *   输出：docs/domscan-<modelId>.json
 *
 * modelId 既可以是内置适配器（adapters/*.yaml），也可以是用户在「网页版模型」
 * 界面里自建的（%APPDATA%/torra/torra/adapters/*.yaml）—— 后者不在仓库里，
 * 只能运行时按 appData 解析。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(app.isPackaged ? 1 : 2)
const VALUE_FLAGS = ['--chat', '--wait', '--md', '--ask']
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]))
const modelId = positional[0] || 'kimi'
const flagVal = (name, dflt = null) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : dflt
}
const mdSel = flagVal('--md')
/**
 * --ask <提示词>：不止看历史，而是代发的**一轮真发言**，然后同时 dump
 * 「生产会捕获成什么 Markdown」和对应节点 outerHTML。
 * 这一条会在该账号下产生一条真实对话，只在显式给出时才做。
 * 排版/抓取类问题（列表断成孤行圆点、正文掉出列表…）只有把 DOM 与捕获结果
 * 放在一起看才分得清责任在站点结构、mdOf 序列化还是渲染端。
 */
const askPrompt = flagVal('--ask')
const chatArg = (() => {
  if (process.env.DOMSCAN_FIND) return process.env.DOMSCAN_FIND
  return flagVal('--chat')
})()
const waitMs = (() => {
  const v = flagVal('--wait')
  return v ? Number(v) : 9000
})()

function readAdapter(id) {
  // 分区名带通道后缀（torra-deepseek-web），适配器文件不带（deepseek.yaml）；
  // 用户在界面上自建的模型，分区是 torra-user-<adapterId>（见 index.ts 的 persist:torra-user-*），
  // 文件名却是 <adapterId>.yaml —— 两边都要能对上。
  const candidates = [id, id.replace(/-web$/, ''), id.replace(/^user-/, '')]
  // 内置适配器在仓库里；用户在「网页版模型」界面自建的写在 userData 下
  const dirs = [
    path.join(ROOT, 'adapters'),
    path.join(app.getPath('appData'), 'torra', 'torra', 'adapters'),
  ]
  for (const dir of dirs) {
    for (const c of candidates) {
      const f = path.join(dir, c + '.yaml')
      if (!fs.existsSync(f)) continue
      const YAML = require('yaml')
      const spec = YAML.parse(fs.readFileSync(f, 'utf8'))
      if (spec && spec.entry) return { file: f, spec }
    }
  }
  throw new Error('no adapter/entry for: ' + id)
}

const CLONE = path.join(app.getPath('appData'), 'torra-domscan')
const SRC = path.join(app.getPath('appData'), 'torra', 'Partitions', 'torra-' + modelId)

function clonePartition() {
  // 运行中的实例锁着 LOCK 文件；其余数据文件可读。副本必须包含
  // Cookies + Local Storage + Session Storage，否则登录态还原不了。
  fs.rmSync(CLONE, { recursive: true, force: true })
  fs.mkdirSync(path.join(CLONE, 'Partitions'), { recursive: true })
  fs.copyFileSync(path.join(app.getPath('appData'), 'torra', 'Local State'), path.join(CLONE, 'Local State'))
  fs.cpSync(SRC, path.join(CLONE, 'Partitions', 'torra-' + modelId), {
    recursive: true,
    filter: (s) => path.basename(s) !== 'LOCK',
    errorOnExist: false,
    force: true,
  })
}

function cleanup() {
  // 副本里是真实 cookie，删不干净就是凭据滞留磁盘。rmSync 在 Chromium 还握着
  // 文件句柄时会静默失败（force 把 ENOENT/EBUSY 都吞了），所以必须验一遍：
  // 短暂退避重试，最后仍留着就把路径喊出来，别让「跑完了」冒充「清理干净了」。
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(CLONE, { recursive: true, force: true }) } catch {}
    if (!fs.existsSync(CLONE)) return
    nap(400)
  }
  console.error('!! 分区副本未删除（含真实 cookie），请手工删掉：' + CLONE)
}

app.setName('torra-domscan')

app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) { console.error('partition missing:', SRC); app.exit(1) }
  try { clonePartition() } catch (e) { console.error('clone failed:', e.message); app.exit(1) }
  app.setPath('userData', CLONE)

  const { spec } = readAdapter(modelId)
  const entry = spec.entry
  const streamSel = mdSel || (spec.selectors || {}).stream
  // 与生产同形（对照 webview/pool.ts 的 ensureHost + WebContentsView），否则扫到的是假现场：
  // ① UA：Electron 默认 UA 带 `Electron/xx`，DeepSeek 据此整页换成「使用环境异常」，
  //    扫出来的 DOM 里根本没有消息容器；
  // ② 有帧：必须「宿主窗口创建时就显示 + 站点跑在挂上去的 WebContentsView 里」。
  //    实测两种形态的差别：show:false 的窗口（以及创建时显示、但把站点直接装进
  //    窗口自身 webContents 的离屏窗口）都是 visibilityState=hidden、一帧不出；
  //    而 view-in-shown-host 是 visible 且正常出帧。DeepSeek 的消息列表靠
  //    IntersectionObserver/rAF 挂载，没帧就连历史回复都不进 DOM —— 扫出来是空壳，
  //    会被误读成「选择器全灭」。
  const { session, WebContentsView } = require('electron')
  const partition = 'persist:torra-' + modelId
  session.fromPartition(partition).setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  )
  const win = new BrowserWindow({
    width: 1280, height: 900, x: -32000, y: -32000, show: true,
    skipTaskbar: true, focusable: false, frame: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true } })
  view.webContents.setBackgroundThrottling(false)
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 })
  const wc = view.webContents
  wc.on('render-process-gone', () => { cleanup(); app.exit(2) })
  // --ask 要等一轮真实生成，保护超时随之放宽
  setTimeout(() => { console.error('guard timeout'); cleanup(); app.exit(3) }, askPrompt ? 300000 : 180000)

  await wc.loadURL(entry)
  await new Promise((r) => setTimeout(r, waitMs))

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  if (askPrompt) {
    // 走生产那条通道：注入同一份 INJECT_SCRIPT，用适配器 spec 发送、按 stream 读取。
    // 基线（发送前的节点数）必须由 read 的 sinceCount 承担，否则会把历史回答
    // 当成本轮发言 —— 与 WebviewAgent 同一套约束。
    const { INJECT_SCRIPT } = require('../dist/main/webview/inject')
    await wc.executeJavaScript(INJECT_SCRIPT, true)
    const sel = spec.selectors || {}
    const mode = spec.stream_mode || 'last'
    if (!sel.input || !streamSel) {
      console.error('--ask 需要适配器同时有 selectors.input 与 stream（或 --md）')
      cleanup(); app.exit(4)
    }
    const before = await wc.executeJavaScript(`window.__torra.count(${JSON.stringify(streamSel)})`, true)
    const sent = await wc.executeJavaScript(
      `window.__torra.send(${JSON.stringify(spec)}, ${JSON.stringify(askPrompt)})`, true,
    )
    console.log('send:', JSON.stringify(sent), '| stream baseline=' + before)
    if (!sent || !sent.ok) { cleanup(); app.exit(5) }
    // 等到正文停止增长：与 completion.stable_ms 同判据，外加固定上限。
    const stableMs = (spec.completion && spec.completion.stable_ms) || 3000
    const deadline = Date.now() + 200000
    let lastText = '', lastChange = Date.now()
    while (Date.now() < deadline) {
      await sleep(1500)
      const cur = String(await wc.executeJavaScript(
        `window.__torra.read(${JSON.stringify(streamSel)}, ${JSON.stringify(mode)}, ${before}, '', ${JSON.stringify(askPrompt)})`,
        true,
      ))
      if (cur !== lastText) { lastText = cur; lastChange = Date.now() }
      else if (cur.length > 0 && Date.now() - lastChange >= Math.max(stableMs, 4000)) break
    }
    console.log('driven chars:', lastText.length)
  }

  const DUMP = `(async () => {
    const cls = (e) => ('' + (e.className || '')).replace(/\\s+/g, ' ').slice(0, 160)
    const DESCV = /(segment|message|markdown|response|answer|question|think|tool|plugin|code|search|plan|step|rollup|reasoning|process)/i
    const roots = [...document.querySelectorAll('[class], [data-testid], [data-thinking-box], [contenteditable]')].filter(e => {
      const c = '' + (e.className || '')
      return /\\b(segment|message|markdown)/.test(c) || /\\bmd-|doc|article|editor|preview|artifact/i.test(c)
        || (e.hasAttribute && (e.hasAttribute('data-thinking-box') || e.hasAttribute('data-testid')))
    })
    const seen = new Set()
    const nodes = []
    for (const el of roots) {
      if (nodes.length > 220) break
      // 只保留「不被另一个命中节点包含」的最外层节点会丢结构，这里干脆全记，
      // 附 parentClass，让离线分析能重建层级。
      const pc = el.parentElement ? cls(el.parentElement) : ''
      const key = cls(el) + '|' + pc
      if (seen.has(key)) continue
      seen.add(key)
      nodes.push({
        tag: el.tagName.toLowerCase(),
        cls: cls(el),
        parent: pc,
        text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 90),
      })
    }
    const links = [...document.querySelectorAll('a[href]')]
      .map(a => ({ href: a.getAttribute('href'), text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40) }))
      .filter(l => l.href && /\\/(chat|c|conversation)\\b|\\/(chat|c)\\//.test(l.href))
      .slice(0, 40)
    const side = [...document.querySelectorAll('*')].find(e => (e.innerText || '').includes('新对话') && e.clientWidth < 400 && e.clientHeight > 400)
    const sidebarText = side ? (side.innerText || '').replace(/\\s+/g, ' ').slice(0, 900) : ''
    // 现场元信息：扫到 0 个节点时，要能当场分清是「选择器没对上」还是
    // 「站点把我们拦下来了（使用环境异常）」/「窗口压根没出帧」。
    // 帧探针：300ms 内数 rAF 回调；1.5s 还没等到第一帧就说明不出帧，返回 -1。
    const frames = await new Promise((res) => {
      let t = 0, done = false
      const t0 = performance.now()
      ;(function loop() {
        requestAnimationFrame(() => {
          if (done) return
          t++
          if (performance.now() - t0 < 300) loop()
          else { done = true; res(t) }
        })
      })()
      setTimeout(() => { if (!done) { done = true; res(-1) } }, 1500)
    })
    const bodyText = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ')
    const meta = {
      url: location.href.slice(0, 100),
      title: document.title.slice(0, 60),
      vis: document.visibilityState,
      frames,
      bodyChars: bodyText.length,
      riskWall: /使用环境异常|数据和隐私泄露风险/.test(bodyText),
      loginWall: /\\/(login|sign_in)\\b/.test(location.pathname) || !!document.querySelector('form[action*="login"]'),
      bodyText: bodyText.slice(0, 240),
    }
    return { url: location.href, title: document.title.slice(0, 60), links, sidebarText, nodes, meta }
  })()`

  let out = await wc.executeJavaScript(DUMP, true)

  // 首页往往只渲染会话列表/空态：按 --chat 进入真实会话再扫一次。
  // 支持三种值：完整 url ／ 序号 ／ 会话标题子串（侧栏链接文本匹配）。
  let target = null
  if (chatArg && /^https?:/.test(chatArg)) target = chatArg
  else if (out.links.length) {
    let l = null
    if (chatArg != null && !/^\d+$/.test(String(chatArg))) l = out.links.find(x => x.text && x.text.includes(chatArg))
    if (!l && chatArg == null) l = out.links[0]
    if (!l && /^\d+$/.test(String(chatArg))) l = out.links[Number(chatArg) || 0]
    if (l) target = new URL(l.href, out.url).href
    // 侧栏没有 a[href]（可点击 div / 虚拟列表）时，标题子串不能当成 URL 去 loadURL，
    // 否则 loadURL('钢人') 直接 ERR_INVALID_URL；交给下面的文本节点点击兜底。
    else if (/^https?:/.test(String(chatArg))) target = String(chatArg)
  } else if (chatArg && /^https?:/.test(String(chatArg))) target = String(chatArg)

  // 标题不在 a[href] 里（不少站点侧栏「最近会话」是可点击 div，且列表可能虚拟化）：
  // 先把侧栏/窗口滚一遍把目标滚出来，再用 TreeWalker 找文本节点，向上点最近的交互祖先。
  if (!target && chatArg && !/^\d+$/.test(String(chatArg)) && !/^https?:/.test(chatArg)) {
    const HAS = `(() => {
      const needle = ${JSON.stringify(String(chatArg))}
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) if ((n.nodeValue || '').includes(needle)) return true
      return false
    })()`
    if (await wc.executeJavaScript(HAS, true)) {
      console.log('scroll: found without scroll')
    } else {
      // 折叠的「展开更多对话」类按钮先点掉，再滚
      await wc.executeJavaScript(`(() => {
        const hits = [...document.querySelectorAll('*')]
          .filter(e => e.childElementCount === 0 && /展开更多|查看更多|加载更多|Show more/i.test((e.innerText || '').trim()) && (e.innerText || '').length < 20)
          .slice(0, 3)
        hits.forEach(e => e.click())
        return hits.length + ' expand clicks'
      })()`, true).then((r) => console.log('expand:', r))
      await new Promise((r) => setTimeout(r, 1500))
      // 侧栏常是 transform 虚拟滚动，且忽略合成 wheel 事件 ——
      // 用 webContents.sendInputEvent 派发「受信任」的滚轮输入。
      const pt = await wc.executeJavaScript(`(() => {
        const a = document.querySelector('a[href^="/chat/"]')
        const r = a ? a.getBoundingClientRect() : { x: 120, y: 400, width: 10, height: 10 }
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`, true)
      let found = false
      for (let step = 1; step <= 40 && !found; step++) {
        wc.sendInputEvent({ type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: 400 })
        await new Promise((r) => setTimeout(r, 220))
        found = await wc.executeJavaScript(HAS, true)
        if (found) console.log('scroll: found at native-wheel-' + step)
      }
      if (!found) console.log('scroll: not-found after 40 native wheels')
    }
    const CLICK = `(() => {
      const needle = ${JSON.stringify(String(chatArg))}
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let n, hit = null
      while ((n = walker.nextNode())) {
        if ((n.nodeValue || '').includes(needle)) { hit = n.parentElement; break }
      }
      if (!hit) {
        // 没找到就把侧栏全部行 dump 出来，便于人工定位目标会话 id
        const rows = [...document.querySelectorAll('a[href^="/chat/"], [class*="session"], [class*="history"] li, [class*="list"] li')]
          .map(e => ({ href: e.getAttribute && e.getAttribute('href'), text: (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 50) }))
          .filter(r => r.text)
        window.__domscanRows = rows
        return 'no-text-node|rows=' + rows.length
      }
      let el = hit
      for (let i = 0; i < 8 && el; i++) {
        if (el.tagName === 'A' || el.onclick || el.getAttribute('role') === 'button' || el.className.includes('item')) break
        el = el.parentElement
      }
      ;(el || hit).scrollIntoView({ block: 'center' })
      ;(el || hit).click()
      return 'clicked:' + ((el || hit).innerText || '').replace(/\\s+/g, ' ').slice(0, 40)
    })()`
    const clickRes = await wc.executeJavaScript(CLICK, true)
    console.log('click-fallback:', clickRes)
    if (String(clickRes).startsWith('no-text-node')) {
      out.sidebarRows = await wc.executeJavaScript('window.__domscanRows || []', true)
    }
    await new Promise((r) => setTimeout(r, waitMs))
    const conv = await wc.executeJavaScript(DUMP, true)
    out = { ...out, conversation: conv }
  }

  if (target) {
    await wc.loadURL(target)
    await new Promise((r) => setTimeout(r, waitMs))
    const conv = await wc.executeJavaScript(DUMP, true)
    out = { ...out, conversation: conv }
  }

  if (streamSel) {
    // 与生产同一条捕获通道：注入同一份 INJECT_SCRIPT，再按适配器的 stream 选择器读一次。
    // 拿到「会被捕获成什么 Markdown」+ 对应节点 outerHTML，才能分清排版问题出在抓取还是渲染端。
    const { INJECT_SCRIPT } = require('../dist/main/webview/inject')
    await wc.executeJavaScript(INJECT_SCRIPT, true)
    const MDDUMP = `(() => {
      const sel = ${JSON.stringify(streamSel)}
      let nodes = []
      try { nodes = [...document.querySelectorAll(sel)] } catch (e) { return { error: 'bad selector: ' + e.message } }
      const tail = nodes.slice(-2).map(el => ({
        cls: ('' + (el.className || '')).slice(0, 120),
        html: (el.outerHTML || '').slice(0, 8000),
      }))
      return {
        count: nodes.length,
        read: window.__torra.read(sel, 'last', 0, '', ''),
        listShapes: nodes.slice(-2).map(el => [...el.querySelectorAll('ul,ol,li')]
          .slice(0, 40)
          .map(x => x.tagName + ':' + (x.innerText || '').replace(/\\s+/g, ' ').slice(0, 40))),
        tail,
      }
    })()`
    out.capture = await wc.executeJavaScript(MDDUMP, true)
    const cap = out.capture || {}
    console.log('capture: nodes=' + cap.count + ' md chars=' + String(cap.read || '').length)
  }

  const dest = path.join(ROOT, 'docs', 'domscan-' + modelId + '.json')
  fs.writeFileSync(dest, JSON.stringify(out, null, 2))
  console.log('wrote', dest, '| nodes:', (out.conversation || out).nodes.length)
  cleanup()
  app.exit(0)
})

process.on('exit', cleanup)
