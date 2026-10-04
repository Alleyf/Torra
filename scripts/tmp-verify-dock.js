/**
 * 临时验证：聊天模式的网页视图是否作为布局内的一列停靠（而非浮层）。
 * 用后即删。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'tmp-dock-verify.png')

const MODELS = [
  { id: 'chatgpt', displayName: 'ChatGPT', transport: 'webview', domain: 'chatgpt.com', color: '#5aa9e6', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'claude', displayName: 'Claude', transport: 'webview', domain: 'claude.ai', color: '#d97757', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'deepseek', displayName: 'DeepSeek', transport: 'api', color: '#4d6bfe', enabled: true, supportsStructuredOutput: true, adapterHealth: 'unknown', adapterStale: false, hasKey: true, status: 'ready' },
]

let lastPresent = null
const calls = []

function registerStubs() {
  ipcMain.handle('risk:acknowledge', () => ({ ok: true }))
  ipcMain.handle('models:list', () => MODELS)
  ipcMain.handle('models:probe', () => ({ ok: true }))
  ipcMain.handle('adapters:list', () => [])
  ipcMain.handle('adapters:check', () => ({ ok: true, health: 'ok' }))
  ipcMain.handle('login:open', () => ({ ok: true }))
  ipcMain.handle('login:refresh', () => ({ ok: true }))
  ipcMain.handle('login:diagnose', () => ({ ok: true, status: 'ready' }))
  ipcMain.handle('webview:present', (_e, id, b) => {
    lastPresent = { id, b }
    calls.push(['present', id, JSON.stringify(b)])
    return { ok: true }
  })
  ipcMain.handle('webview:dismiss', (_e, id) => {
    calls.push(['dismiss', id])
    return { ok: true }
  })
  ipcMain.handle('webview:memory', () => ({ estimatedMb: 750, count: 3 }))
  ipcMain.handle('chat:send', () => ({ ok: true }))
  ipcMain.handle('preferences:load', () => ({}))
  ipcMain.handle('preferences:save', () => ({ ok: true }))
  ipcMain.handle('theme:get', () => ({ mode: 'light', resolved: 'light' }))
  ipcMain.handle('theme:set', () => ({ ok: true }))
  ipcMain.handle('session:list', () => [])
  ipcMain.handle('doctor:log', () => ({ events: [], file: null }))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 看门狗：任何一步卡住都必须自己退出，不能留一个常驻 Electron */
setTimeout(() => {
  console.log('WATCHDOG: 超时强制退出')
  app.exit(1)
}, 60000)

async function shot(win) {
  try {
    win.webContents.debugger.attach('1.3')
    const r = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(OUT, Buffer.from(r.data, 'base64'))
    win.webContents.debugger.detach()
  } catch (e) {
    console.log('shot failed: ' + e.message)
  }
}

app.whenReady().then(async () => {
  registerStubs()
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#faf9f7',
    webPreferences: {
      preload: path.join(ROOT, 'dist', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: ['--torra-theme=light'],
    },
  })
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer ${level}] ${message} @ ${sourceId}:${line}`)
  })

  await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'))
  await sleep(1200)

  // 预置两轮对话，让正文有实际高度可测
  await win.webContents.executeJavaScript(`
    localStorage.setItem('torra.chat.v1', JSON.stringify([{
      id: 'chat_v', title: '布局核查', createdAt: Date.now(), system: '',
      turns: [1, 2].map((i) => ({
        id: 't' + i, question: '第 ' + i + ' 轮问题：实时计算层的必要性怎么评估？',
        cells: {
          chatgpt: { content: '从延迟与成本两侧评估。'.repeat(12), streaming: false },
          claude: { content: '先看读多写少的比例。'.repeat(12), streaming: false },
        },
      })),
    }]))
  `)
  await win.webContents.reload()
  await sleep(1500)

  await win.webContents.executeJavaScript(`
    (() => {
      const nav = [...document.querySelectorAll('.app-nav-item')].find(b => b.textContent.includes('聊天'));
      if (!nav) return 'no-chat-nav';
      nav.click();
      return 'clicked';
    })()
  `)
  await sleep(900)

  const before = await win.webContents.executeJavaScript(`
    (() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      return { main: r(document.querySelector('.chat-main')), slot: r(document.querySelector('.chat-webview-slot')) };
    })()
  `)

  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const chip = document.querySelector('.chat-target-chip.is-webview');
      if (!chip) return 'no-chip';
      chip.click();
      return chip.textContent;
    })()
  `)
  await sleep(1400)

  const after = await win.webContents.executeJavaScript(`
    (() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      const overlap = (a, b) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      const slot = document.querySelector('.chat-webview-slot');
      const body = document.querySelector('.webview-dock-body');
      const cs = slot ? getComputedStyle(slot) : null;
      const main = document.querySelector('.chat-main');
      const turns = document.querySelector('.chat-turns');
      const composer = document.querySelector('.chat-composer');
      const page = document.querySelector('.chat-page');
      return {
        slotRect: r(slot), bodyRect: r(body), mainRect: r(main),
        turnsRect: r(turns), composerRect: r(composer),
        slotParent: slot ? slot.parentElement.className : null,
        pageDisplay: page ? getComputedStyle(page).flexDirection : null,
        slotPosition: cs ? cs.position : null,
        slotShadow: cs ? cs.boxShadow : null,
        overlapsTurns: overlap(r(slot), r(turns)),
        overlapsComposer: overlap(r(slot), r(composer)),
        docWidth: document.documentElement.clientWidth,
        docHeight: document.documentElement.clientHeight,
      };
    })()
  `)

  await shot(win)

  // 关闭后应回收原生视图
  await win.webContents.executeJavaScript(`document.querySelector('.wdh-actions .icon').click()`)
  await sleep(600)
  const closed = await win.webContents.executeJavaScript(`
    (() => { const s = document.querySelector('.chat-webview-slot');
      const m = document.querySelector('.chat-main');
      return { slotGone: !s, mainW: m ? Math.round(m.getBoundingClientRect().width) : null }; })()
  `)

  console.log(JSON.stringify({ before, clicked, after, lastPresent, closed, calls }, null, 2))
  app.exit(0)
})
