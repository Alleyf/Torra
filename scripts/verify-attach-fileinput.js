/**
 * 验证「网页模型附件走网页本身的上传」这条通道。
 *
 * 单独跑，不依赖整包冒烟（smoke.js 还要渲染层产物）：真 Electron + 真注入脚本
 * + 真 pasteImages，打两个固定装置 ——
 *   web-attach-fileinput.html：只认自家 input[type=file] 的 change（不监听 paste），
 *     file input 还要点「+」之后才挂进 DOM。断言：图真的进了站点的待发队列并随发送出去。
 *   web-attach.html：老通道（受信任 paste）。断言新逻辑没有把它弄坏 —— 
 *     找不到 file input 时必须退回粘贴，并且仍拿到 isTrusted 的 paste 事件。
 */
const path = require('node:path')
const fs = require('node:fs')
const zlib = require('node:zlib')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const SHOW = process.argv.includes('--show')
const errors = []

const specFor = (id) => ({
  id,
  entry: 'file://',
  send_mode: 'click',
  automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 60 },
  selectors: { input: 'textarea[data-testid="chat_input_input"]', send: '#send', stream: '#answers .ans' },
})

/**
 * 反复 loadFile 同一个 file:// 在 Windows 上偶发 ERR_FAILED(-2)：
 * 上一份文档的 unload 与这一份的 load 撞在一起，Chromium 直接拒绝。
 * 用 about:blank 中转一下就能绕开 —— 每次都从一份「上一份一定已经卸载」的
 * 文档出发，竞态就不存在了。只影响验证脚本本身，与产品逻辑无关。
 */
let fixtureSeq = 0
async function loadFixture(win, file) {
  const p = path.join(ROOT, 'scripts', 'fixtures', file)
  fixtureSeq += 1
  await win.loadURL('about:blank')
  await win.loadFile(p)
}

/** 现造一张 4x4 的 PNG：冒烟用那张图是整包跑出来的，单独验证时并不存在 */
function tinyPng() {
  const w = 4
  const h = 4
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1)
    raw[row] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = 0x30
      raw[row + 2 + x * 3] = 0x60
      raw[row + 3 + x * 3] = 0x90
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  function crc32(buf) {
    let c
    const table = []
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

async function run() {
  const { INJECT_SCRIPT } = require('../dist/main/webview/inject')
  const { pasteImages, uploadFiles } = require('../dist/main/agents/webview-agent')
    const png = tinyPng()
  const win = new BrowserWindow({ width: 760, height: 620, show: SHOW })

  // ---- 只认 file input 的站点：新通道 ----
  {
    await loadFixture(win, 'web-attach-fileinput.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = specFor('fileinput-fixture')
    const typed = await win.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const report = await pasteImages(
      win.webContents,
      spec,
      [{ mime: 'image/png', base64: png }],
      'fileinput-fixture',
      'verify-attach-fileinput',
    )
    // 预览要在发送前看：站点收到这一轮就会把待发附件清掉，发完再数必然是 0
    const before = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { pastes: p.pastes, changes: p.changes, menuOpened: p.menuOpened, imgs: document.querySelectorAll("#strip img").length } })()',
      true,
    )
    const press = await win.webContents.executeJavaScript(
      `window.__torra.pressSend(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const probe = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { pastes: p.pastes, changes: p.changes, menuOpened: p.menuOpened, sent: p.sent, imgs: document.querySelectorAll("#strip img").length } })()',
      true,
    )
    console.log('fileinput:', JSON.stringify({ before, probe, report, pressed: press.ok }))
    if (!typed.ok) errors.push(`键入失败：${typed.reason}`)
    if (before.changes < 1 || before.imgs < 1) errors.push(`网页自身上传通道没把附件交给站点：${JSON.stringify(before)}`)
    if (before.menuOpened < 1) errors.push(`没点开站点的上传菜单（+），file input 是懒挂的：${JSON.stringify(before)}`)
    if (report.placed !== 1) errors.push(`placed 应为 1，实际 ${report.placed}`)
    if (report.dropped.length) errors.push(`附件已送达却报了丢失：${JSON.stringify(report.dropped)}`)
    if (!press.ok) errors.push(`发送未被站点接走：${press.reason}`)
    if (!(probe.sent && probe.sent.files === 1 && probe.sent.text === '这是什么')) {
      errors.push(`发送时站点没带上图：${JSON.stringify(probe.sent)}`)
    }
  }

  // ---- 非图片附件（html/代码）：走同一条上传通道，且**不进 prompt** ----
  // 这一条才是「上传了几百 KB 的 html，模型说后面全是空行」的根因：
  // 内联进输入框逐字敲会被上限截断。断言「站点拿到的是完整文件本身」。
  {
    await loadFixture(win, 'web-attach-fileinput.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = specFor('fileinput-fixture')
    const body = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n' + 'x'.repeat(5000)
    await win.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const report = await uploadFiles(
      win.webContents,
      spec,
      [
        {
          name: 'bookmarks_2026_9_10.html',
          mime: 'text/html',
          base64: Buffer.from(body, 'utf8').toString('base64'),
        },
      ],
      'fileinput-fixture',
      'verify-attach-fileinput',
    )
    const probe = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; const f = p.files[0]; return { changes: p.changes, names: p.names, size: f ? f.size : -1, type: f ? f.type : "" } })()',
      true,
    )
    // files[0] 可能不存在（这正是要测的失败形态）—— 直接 .text() 会抛，
    // 一抛后面所有组都跑不到，看不到别的结果。读法一律做空值保护。
    const textLen = await win.webContents.executeJavaScript(
      '(() => { const f = window.__probe.files[0]; return f ? f.text().then(t => t.length) : -1; })()',
      true,
    )
    console.log('file:', JSON.stringify({ probe, report, textLen }))
    if (report.placed !== 1) errors.push(`文本附件 placed 应为 1，实际 ${report.placed}`)
    if (report.dropped.length) errors.push(`文本附件已送达却报了丢失：${JSON.stringify(report.dropped)}`)
    if (probe.changes < 1) errors.push(`文本附件没触发站点的 change：${JSON.stringify(probe)}`)
    if (!probe.names.includes('bookmarks_2026_9_10.html')) {
      errors.push(`站点收到的文件名不对（会丢掉扩展名，站点按类型分流就错了）：${JSON.stringify(probe.names)}`)
    }
    // 关键断言：站点拿到的是**完整文件**，不是被输入框截断的片段
    if (textLen !== body.length) {
      errors.push(`站点拿到的文件正文长度 ${textLen} != 原文 ${body.length}（附件被截断了）`)
    }
    if (probe.type !== 'text/html') errors.push(`MIME 不对：${probe.type}`)
  }

  // ---- 老通道回归：没有 file input 的站点必须退回受信任粘贴 ----
  {
    /*
     * ---- 元宝真实形态：上传入口是无 aria-label/title 的纯图标按钮 ----
     * 语义命中（aria-label/title/class）与 isPlus（innerText 为 +）全都接不住，
     * 于是报 no-upload-entry —— 用户看到的正是这个。真人靠**位置**找它：
     * 输入框左侧。断言「图标兜底」能把它点开并走完二级菜单。
     */
    await loadFixture(win, 'web-attach-icon-plus.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const specI = {
      id: 'icon-plus-fixture',
      entry: 'file://',
      send_mode: 'enter',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 40 },
      selectors: { input: '.editor', stream: '#strip .chip' },
    }
    await win.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(specI)}, '这是什么')`,
      true,
    )
    const repI = await uploadFiles(
      win.webContents,
      specI,
      [{ name: 'bookmarks_2026_9_10.html', mime: 'text/html', base64: Buffer.from('<html>z</html>', 'utf8').toString('base64') }],
      'icon-plus-fixture',
      'verify-attach-icon-plus',
    )
    const pI = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { changes: p.changes, menuOpened: p.menuOpened, docMenuOpened: p.docMenuOpened, accepted: p.accepted, rejected: p.rejected } })()',
      true,
    )
    const geo = await win.webContents.executeJavaScript(
      `(() => {
        const ed = document.querySelector('.editor');
        const plus = document.getElementById('plus');
        const ir = ed.getBoundingClientRect();
        const br = plus.getBoundingClientRect();
        return {
          hasInput: !!ed, hasPlus: !!plus,
          sameRow: Math.abs((br.top + br.height/2) - (ir.top + ir.height/2)) < Math.max(ir.height, br.height) * 0.6,
          toLeft: ir.left - br.right, inRange: ir.left - br.right >= -8 && ir.left - br.right <= 160,
          plusVisibleOffsetParent: plus.offsetParent === null,
          plusText: JSON.stringify((plus.innerText||'').trim()),
          plusRect: [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)].join(',')
        };
      })()`,
      true,
    )
    console.log('icon:', JSON.stringify({ probe: pI, report: repI, geo }))
    if (repI.placed !== 1) errors.push(`图标按钮形态没送达：${JSON.stringify(repI)}`)
    if (pI.menuOpened < 1) errors.push(`无标签的图标上传按钮没被点到：${JSON.stringify(pI)}`)
    if (pI.docMenuOpened < 1) errors.push(`二级「本地文件」没点到：${JSON.stringify(pI)}`)
    if (!pI.accepted.some((a) => a.kind === 'doc')) errors.push(`站点没把文件收进文档控件：${JSON.stringify(pI)}`)
    if (pI.rejected.length > 0) errors.push(`送错控件被拒收：${JSON.stringify(pI.rejected)}`)
  }

  {
    /*
     * ---- 元宝形态：「+」点开二级菜单，「本地文件」之后才有 file input ----
     * 一级按钮只会展开菜单，永远等不到 input —— 上一版实现在这里报
     * no-file-input，截图里用户看到的正是这个。断言两层都点到位，
     * 且文件落到「本地文件」那个控件（而不是只收图的「上传图片」）。
     */
    await loadFixture(win, 'web-attach-second-level.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec2 = {
      id: 'second-level-fixture',
      entry: 'file://',
      send_mode: 'enter',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 40 },
      selectors: { input: '.ql-editor', stream: '#strip .chip' },
    }
    const body2 = '<html>y</html>'.repeat(40)
    await win.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec2)}, '这是什么')`,
      true,
    )
    const rep2 = await uploadFiles(
      win.webContents,
      spec2,
      [{ name: 'bookmarks_2026_9_10.html', mime: 'text/html', base64: Buffer.from(body2, 'utf8').toString('base64') }],
      'second-level-fixture',
      'verify-attach-second-level',
    )
    const p2 = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { changes: p.changes, menuOpened: p.menuOpened, docMenuOpened: p.docMenuOpened, accepted: p.accepted, rejected: p.rejected, names: p.names } })()',
      true,
    )
    console.log('second:', JSON.stringify({ probe: p2, report: rep2 }))
    if (rep2.placed !== 1) errors.push(`二级菜单形态没送达：${JSON.stringify(rep2)}`)
    if (p2.menuOpened < 1) errors.push(`一级菜单没点开：${JSON.stringify(p2)}`)
    if (p2.docMenuOpened < 1) errors.push(`二级「本地文件」没点到：${JSON.stringify(p2)}`)
    if (!p2.accepted.some((a) => a.kind === 'doc')) {
      errors.push(`站点没把文件收进文档控件：${JSON.stringify(p2)}`)
    }
    if (p2.rejected.length > 0) errors.push(`送错控件被站点拒收：${JSON.stringify(p2.rejected)}`)
  }

  {
    /*
     * ---- 绕过包装层，直接跑页面侧 ----
     * 前面的用例都经过主进程包装层，失败时分不清是页面逻辑错还是包装层错。
     * 这里直接调 __torra.uploadFiles，并把站点侧的实际落地情况一并打出来。
     * 包装层曾经把「页面成功、主进程报 placed:0」这类不一致藏住，
     * 两边并排看才看得见。
     */
    await loadFixture(win, 'web-attach-fileinput.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = specFor('min-fixture')
    const png2 = tinyPng()
    const payload = { mime: 'image/png', base64: png2, name: 'image-1.png' }
    const steps = {}
    steps.pickBefore = await win.webContents.executeJavaScript(
      `(() => { const s = document.getElementById('fi'); return { exists: !!s }; })()`,
      true,
    )
    steps.upload = await win.webContents
      .executeJavaScript(
        `window.__torra.uploadFiles(${JSON.stringify(spec)}, ${JSON.stringify([payload])})`,
        true,
      )
      .catch((e) => ({ err: String((e && e.message) || e) }))
    steps.after = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; const s = document.getElementById("fi"); return { changes: p.changes, menuOpened: p.menuOpened, pastes: p.pastes, inputFiles: s ? s.files.length : -1, names: p.names }; })()',
      true,
    )
    console.log('min:', JSON.stringify(steps))
    if (!steps.upload || steps.upload.placed !== 1) {
      errors.push(`页面侧上传就没成功：${JSON.stringify(steps)}`)
    }
    if (steps.after.changes < 1) errors.push(`站点没收到文件：${JSON.stringify(steps.after)}`)
  }

  {
    /*
     * ---- 干净页面上的整条链 ----
     * 前面几组都在同一个窗口里连着跑，页面里可能残留着上一轮创建的文件控件，
     * 「站点拿到的是哪份 input」会被污染。这组重新加载、只跑一次粘贴通道，
     * 保证「主进程包装层 + 页面侧逻辑」在干净起点上是一致的。
     */
    await loadFixture(win, 'web-attach-fileinput.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = specFor('clean-fixture')
    await win.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const r = await pasteImages(
      win.webContents,
      spec,
      [{ mime: 'image/png', base64: tinyPng() }],
      'clean-fixture',
      'verify-attach-clean',
    )
    const page = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; const s = document.getElementById("fi"); return { changes: p.changes, menuOpened: p.menuOpened, pastes: p.pastes, inputFiles: s ? s.files.length : -1, imgs: document.querySelectorAll("#strip img").length }; })()',
      true,
    )
    console.log('clean:', JSON.stringify({ report: r, page }))
    if (r.placed !== 1) errors.push(`干净页面上传就失败了：${JSON.stringify(r)}`)
    if (page.changes < 1) errors.push(`干净页面上站点没收到文件：${JSON.stringify(page)}`)
  }

  {
    /*
     * ---- 页面上有多个 file input（阿里系站点的常见布局）----
     * 图片走 accept="image/*" 的控件，文档走另一个 accept=".pdf,.doc,..." 的控件，
     * 两个都在 DOM 里。「页面上有 file input」永远为真，于是「找到 input 就以为通了」——
     * 实际把 html 塞进只收图的那个控件，站点的 accept 校验当场拒绝。
     * 本装置把只收图的 input 放在文档顺序**前面**，专门卡「取第一个」和
     * 「偏向收图片的」这两种写法。
     */
    await loadFixture(win, 'web-attach-two-inputs.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = {
      id: 'two-inputs-fixture',
      entry: 'file://',
      send_mode: 'enter',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 40 },
      selectors: { input: '.ql-editor', stream: '#strip .chip' },
    }
    const body = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n' + 'w'.repeat(3000)
    await win.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const report = await uploadFiles(
      win.webContents,
      spec,
      [{ name: 'bookmarks_2026_9_10.html', mime: 'text/html', base64: Buffer.from(body, 'utf8').toString('base64') }],
      'two-inputs-fixture',
      'verify-attach-two-inputs',
    )
    const probe = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { changes: p.changes, menuOpened: p.menuOpened, imgMenuOpened: p.imgMenuOpened, accepted: p.accepted, rejected: p.rejected, names: p.names } })()',
      true,
    )
    console.log('two-inputs:', JSON.stringify({ probe, report }))
    if (report.placed !== 1) errors.push(`多 file input 形态没送达：${JSON.stringify(report)}`)
    // 文件必须落到「收文档」的那个控件里，且被站点 accept
    if (!probe.accepted.some((a) => a.kind === 'doc' && a.name === 'bookmarks_2026_9_10.html')) {
      errors.push(`站点没把 html 收进文档控件：${JSON.stringify(probe)}`)
    }
    if (probe.rejected.length > 0) {
      errors.push(`站点按 accept 拒绝了附件（说明送错了控件）：${JSON.stringify(probe.rejected)}`)
    }
  }

  {
    /*
     * ---- 元宝形态：contenteditable 编辑器 + position:fixed 的「+」工具栏 ----
     * fixed 元素的 offsetParent 是 null，而注入脚本 isVisible 的第一条判死
     * 就是 offsetParent === null —— 于是「+」被判成不可见，点��等于没点。
     * 这条装置会把 offsetParent/rect 的现场也打出来，断言失败时能直接看清卡在哪。
     */
    await loadFixture(win, 'web-attach-fixed-toolbar.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = {
      id: 'fixed-toolbar-fixture',
      entry: 'file://',
      send_mode: 'click',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 40 },
      selectors: { input: '.ql-editor', send: '#send', stream: '#strip .chip' },
    }
    const body = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n' + 'z'.repeat(3000)
    await win.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const report = await uploadFiles(
      win.webContents,
      spec,
      [{ name: 'bookmarks_2026_9_10.html', mime: 'text/html', base64: Buffer.from(body, 'utf8').toString('base64') }],
      'fixed-toolbar-fixture',
      'verify-attach-fixed',
    )
    const probe = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; const f = p.files[0]; return { changes: p.changes, menuOpened: p.menuOpened, names: p.names, size: f ? f.size : -1, plusVisible: p.plusVisible } })()',
      true,
    )
    console.log('fixed:', JSON.stringify({ probe, report }))
    if (report.placed !== 1) errors.push(`fixed 工具栏上的「+」没被点到，附件送不进去：${JSON.stringify(report)}`)
    if (probe.menuOpened < 1) errors.push(`没点开 fixed 工具栏的上传菜单：${JSON.stringify(probe)}`)
    if (probe.changes < 1) errors.push(`元宝形态站点没收到文件：${JSON.stringify(probe)}`)
    if (!probe.names.includes('bookmarks_2026_9_10.html')) {
      errors.push(`站点收到的文件名不对：${JSON.stringify(probe.names)}`)
    }
    if (probe.size !== Buffer.byteLength(body, 'utf8')) {
      errors.push(`字节数不对：${probe.size} != ${Buffer.byteLength(body, 'utf8')}`)
    }
  }

  {
    /*
     * ---- 上传入口离输入框很远（DeepSeek 网页版的真实布局）----
     * 「+」按钮挂在页面右上角，输入框在自己的组件里，两者只是表亲 ——
     * 只在 input.parentElement 那一层找上传入口的实现，在这种布局上必然找不到。
     * 而且 file input 是点「+」之后才动态创建的，不是常驻节点。
     * 这两条正是「DeepSeek 网页明明支持上传、我们却送不进去」的症状来源。
     */
    await loadFixture(win, 'web-attach-distant-plus.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = {
      id: 'distant-plus-fixture',
      entry: 'file://',
      send_mode: 'enter',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 40 },
      selectors: { input: 'textarea[name="user query"]', stream: '#strip .chip' },
    }
    const body = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n' + 'y'.repeat(3000)
    await win.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const report = await uploadFiles(
      win.webContents,
      spec,
      [{ name: 'bookmarks_2026_9_10.html', mime: 'text/html', base64: Buffer.from(body, 'utf8').toString('base64') }],
      'distant-plus-fixture',
      'verify-attach-distant',
    )
    const probe = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; const f = p.files[0]; return { changes: p.changes, menuOpened: p.menuOpened, names: p.names, size: f ? f.size : -1 } })()',
      true,
    )
    console.log('distant:', JSON.stringify({ probe, report }))
    if (report.placed !== 1) errors.push(`远处的「+」按钮没被点到，附件送不进去：${JSON.stringify(report)}`)
    if (probe.menuOpened < 1) errors.push(`没点开远处��上传菜单：${JSON.stringify(probe)}`)
    if (probe.changes < 1) errors.push(`站点没收到文件：${JSON.stringify(probe)}`)
    if (!probe.names.includes('bookmarks_2026_9_10.html')) {
      errors.push(`站点收到的文件名不对：${JSON.stringify(probe.names)}`)
    }
    if (probe.size !== Buffer.byteLength(body, 'utf8')) {
      errors.push(`字节数不对：${probe.size} != ${Buffer.byteLength(body, 'utf8')}`)
    }
  }

  {
    // ---- 各种类型：都应当**原样**交给站点，不能被改扩展名或丢 MIME ----
    // 断言点只有一个：站点拿到的 File 的 name/type/正文长度与源文件一致。
    // 站点自己收不收是站点的事，我们这一层不允许悄悄改动用户的东西。
    const cases = [
      { name: 'notes.md', mime: 'text/markdown', body: '# 标题\n正文内容' },
      { name: 'data.json', mime: 'application/json', body: '{"a":1}' },
      { name: 'main.py', mime: 'text/x-python', body: 'print(1)\n' },
      { name: 'page.html', mime: 'text/html', body: '<html><body>hi</body></html>' },
      { name: 'style.css', mime: 'text/css', body: 'body{margin:0}' },
      { name: 'query.sql', mime: 'application/sql', body: 'select 1;' },
      { name: 'blob.bin', mime: 'application/octet-stream', body: ' binary' },
      { name: 'doc.pdf', mime: 'application/pdf', body: '%PDF-1.4 fake' },
    ]
    await loadFixture(win, 'web-attach-fileinput.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = specFor('fileinput-fixture')
    await win.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    /*
     * 分两批，且**逐批断言**。
     * 分批是因为单轮上限 4 个（uploadFiles 只取前 4），一批 8 个会被上限截断；
     * 逐批断言是因为装置复刻了真实站点行为：输入框被清空时待发附件一起丢，
     * 所以第二批之前要重新 typePrompt，第一批的文件到那时已经不在页面上了。
     * 装置把这一层也算进断言 —— 批内必须 4 个都在，才说明没被上限截断。
     */
    const batch1 = await uploadFiles(
      win.webContents,
      spec,
      cases.slice(0, 4).map((c) => ({ ...c, base64: Buffer.from(c.body, 'utf8').toString('base64') })),
      'fileinput-fixture',
      'verify-attach-types-1',
    )
    const got1 = await win.webContents.executeJavaScript(
      '(() => window.__probe.files.map(f => ({ name: f.name, type: f.type, size: f.size })))()',
      true,
    )
    const lens1 = await win.webContents.executeJavaScript(
      'Promise.all(window.__probe.files.map(f => f.text().then(t => t.length)))',
      true,
    )
    await win.webContents.executeJavaScript(`window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`, true)
    const batch2 = await uploadFiles(
      win.webContents,
      spec,
      cases.slice(4).map((c) => ({ ...c, base64: Buffer.from(c.body, 'utf8').toString('base64') })),
      'fileinput-fixture',
      'verify-attach-types-2',
    )
    const report = {
      placed: batch1.placed + batch2.placed,
      dropped: [...batch1.dropped, ...batch2.dropped],
    }
    const got = await win.webContents.executeJavaScript(
      '(() => window.__probe.files.map(f => ({ name: f.name, type: f.type, size: f.size })))()',
      true,
    )
    const lens = await win.webContents.executeJavaScript(
      'Promise.all(window.__probe.files.map(f => f.text().then(t => t.length)))',
      true,
    )
    console.log('types:', JSON.stringify({ report, got, lens }))
    if (report.placed !== cases.length) errors.push(`多类型应全部交付，实际 placed=${report.placed}`)
    if (report.dropped.length) errors.push(`多类型已送达却报丢失：${JSON.stringify(report.dropped)}`)
    /*
     * 两个长度不能混：size 是**字节**数（磁盘上的东西），text().length 是**字符**数。
     * 本组用例里有中文（标题/正文内容），两者差一倍多 —— 把字符数当字节数比会误报。
     * 字节数对不上才是真丢了字节（编码坏了或被截断），字符数对不上说明内容被改写。
     */
    cases.slice(0, 4).forEach((c, i) => {
      if (!got1[i] || got1[i].name !== c.name) {
        errors.push(`第 ${i + 1} 个文件名不对：期望 ${c.name}，实际 ${got1[i] && got1[i].name}`)
      }
      if (!got1[i] || got1[i].type !== c.mime) {
        errors.push(`第 ${i + 1} 个 MIME 不对：期望 ${c.mime}，实际 ${got1[i] && got1[i].type}`)
      }
      if (got1[i] && got1[i].size !== Buffer.byteLength(c.body, 'utf8')) {
        errors.push(`第 ${i + 1} 个（${c.name}）字节数 ${got1[i].size} != ${Buffer.byteLength(c.body, 'utf8')}`)
      }
      if (lens1[i] !== c.body.length) {
        errors.push(`第 ${i + 1} 个（${c.name}）字符数 ${lens1[i]} != ${c.body.length}（内容被改写了）`)
      }
    })
    cases.slice(4).forEach((c, j) => {
      const i = j + 4
      if (!got[j] || got[j].name !== c.name) {
        errors.push(`第 ${i + 1} 个文件名不对：期望 ${c.name}，实际 ${got[j] && got[j].name}`)
      }
      if (!got[j] || got[j].type !== c.mime) {
        errors.push(`第 ${i + 1} 个 MIME 不对：期望 ${c.mime}，实际 ${got[j] && got[j].type}`)
      }
      if (got[j] && got[j].size !== Buffer.byteLength(c.body, 'utf8')) {
        errors.push(`第 ${i + 1} 个（${c.name}）字节数 ${got[j].size} != ${Buffer.byteLength(c.body, 'utf8')}`)
      }
      if (lens[j] !== c.body.length) {
        errors.push(`第 ${i + 1} 个（${c.name}）字符数 ${lens[j]} != ${c.body.length}（内容被改写了）`)
      }
    })
  }

  {
    await loadFixture(win, 'web-attach.html')
    await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = specFor('paste-fixture')
    await win.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const report = await pasteImages(
      win.webContents,
      spec,
      [{ mime: 'image/png', base64: png }],
      'paste-fixture',
      'verify-attach-paste',
    )
    const press = await win.webContents.executeJavaScript(
      `window.__torra.pressSend(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const probe = await win.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { pastes: p.pastes, sent: p.sent } })()',
      true,
    )
    console.log('paste:', JSON.stringify({ probe, report, pressed: press.ok }))
    if (!probe.pastes.some((p) => p.trusted && p.files === 1)) {
      errors.push(`退回粘贴后没拿到受信任的 paste 事件：${JSON.stringify(probe.pastes)}`)
    }
    if (report.placed !== 1) errors.push(`粘贴通道 placed 应为 1，实际 ${report.placed}`)
    if (!press.ok) errors.push(`粘贴通道发送未被接走：${press.reason}`)
    if (!(probe.sent && probe.sent.files === 1 && probe.sent.text === '这是什么')) {
      errors.push(`粘贴通道发送时站点没带上图：${JSON.stringify(probe.sent)}`)
    }
  }
  win.destroy()
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (e) {
    errors.push(`脚本自身抛错：${(e && e.stack) || e}`)
  }
  for (const e of errors) console.error('FAIL:', e)
  console.log(errors.length ? `FAILED (${errors.length})` : 'OK')
  app.exit(errors.length ? 1 : 0)
})
