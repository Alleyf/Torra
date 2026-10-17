/**
 * 验证「网页模型 AI 生图」抓取通道：__torra.readImages。
 *
 * 背景：元宝生图那一轮的回答节点里一个字都没有，只有 <img>。抓取层（mdChildren）
 * 把 IMG 整个跳过，于是整轮被读成「空回复」。图片改由 readImages 单独收集，
 * 主进程下载入库后渲染层按附件渲染。
 *
 * 用无头 Electron + 注入脚本 + 固定装置 scripts/fixtures/web-answer-images.html，
 * 不依赖真实站点、不消耗登录态。
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const SHOW = process.argv.includes('--show')
const errors = []

const STREAM = '#answers .ans'
const PROMPT = '画一张 SDD / 敏捷 / 瀑布 的对比架构图'

async function loadFixture(win, file) {
  await win.loadURL('about:blank')
  await win.loadFile(path.join(ROOT, 'scripts', 'fixtures', file))
}

async function run() {
  const { INJECT_SCRIPT } = require('../dist/main/webview/inject')
  const win = new BrowserWindow({ width: 820, height: 700, show: SHOW })
  await loadFixture(win, 'web-answer-images.html')
  await win.webContents.executeJavaScript(INJECT_SCRIPT, true)
  await win.webContents.executeJavaScript('window.__markPendingIncomplete()', true)

  const build = await win.webContents.executeJavaScript('window.__torra.__build', true)
  console.log('inject build:', build)

  // 正文：生图轮读出来是空的 —— 这正是问题现场，readImages 必须补上
  const text = String(
    await win.webContents.executeJavaScript(`window.__torra.read(${JSON.stringify(STREAM)}, 'all', 1, '', ${JSON.stringify(PROMPT)})`, true),
  )
  console.log('read() chars:', text.length)

  const imgs = await win.webContents.executeJavaScript(
    `window.__torra.readImages(${JSON.stringify(STREAM)}, 1, ${JSON.stringify(PROMPT)})`,
    true,
  )
  console.log('readImages:', JSON.stringify(imgs, null, 1))

  const srcs = (imgs || []).map((x) => x.src)
  const want = ['gen-1.png', 'gen-2.png', 'gen-3.png']
  for (const w of want) {
    if (!srcs.some((s) => s.includes(w))) errors.push(`漏掉本轮生成图：${w}（实得 ${JSON.stringify(srcs)}）`)
  }
  if (srcs.filter((s) => s.includes('gen-2.png')).length > 1) errors.push('同一 URL 没去重')
  if (srcs.some((s) => s.includes('old.png'))) errors.push('把上一轮（sinceCount 之前）的图当成本轮产出')
  if (srcs.some((s) => s.includes('icon-copy'))) errors.push('小图标被当成内容图')
  if (srcs.some((s) => s.includes('pending'))) errors.push('未加载完的占位图被提前收下')
  if (srcs.some((s) => s.startsWith('blob:'))) errors.push('用户上传轮的预览图被当成模型产出')

  // 没有 sinceCount（-1）时不该崩，且仍能读到内容
  const all = await win.webContents.executeJavaScript(
    `window.__torra.readImages(${JSON.stringify(STREAM)}, -1, '')`,
    true,
  )
  if (!Array.isArray(all) || !all.length) errors.push(`readImages 全量读返回异常：${JSON.stringify(all)}`)
  if (!all.some((x) => String(x.src).includes('old.png'))) errors.push('sinceCount=-1 时应包含历史图')

  /**
   * 虚拟化：站点回收旧节点后，发送前记下的 sinceCount 可能大于等于当前节点数
   * （元宝实测 nodeCount=1：整篇对话只留一个 div.hyc-content-md）。
   * 这时不能直接越界返回空，要退到末尾窗口继续扫 —— 否则生图轮永远拿到 0 张图。
   */
  const shrunk = await win.webContents.executeJavaScript(
    `window.__torra.readImages(${JSON.stringify(STREAM)}, 99, '')`,
    true,
  )
  if (!Array.isArray(shrunk) || !shrunk.length) {
    errors.push(`sinceCount 越过节点数时要退回末尾窗口，实得 ${JSON.stringify(shrunk)}`)
  }
  if (!(shrunk || []).some((s) => String(s.src).includes('gen-1.png'))) {
    errors.push('退回末尾窗口后没读到本轮的图')
  }

  win.destroy()
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (e) {
    errors.push(`脚本本身出错：${(e && e.stack) || e}`)
  }
  for (const e of errors) console.error('FAIL:', e)
  console.log(errors.length ? `FAILED (${errors.length})` : 'OK')
  app.exit(errors.length ? 1 : 0)
})
