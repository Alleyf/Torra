/**
 * 打包产物自检：真的把 release/win-unpacked 里的应用跑起来，验证品牌层和生命周期。
 *
 * 为什么必须真跑：这几处失败全是静默的 ——
 * - 图标没进 asar → nativeImage 读不到 → 窗口/托盘退回 Electron 默认牌子，不报错；
 * - package.json 的 productName 会把 userData 改名 → 用户「装了新版突然全部未登录」；
 * - 单实例锁没生效 → 双击两次开出两套房，分区互抢 cookie 写盘。
 *
 * 安全边界：一律用 --user-data-dir 指到 output/pack-check/udata，绝不碰 %APPDATA%\torra
 * 里的真实登录态；第二个实例只验证「它自己退出、不多开窗口」，不发消息、不点任何按钮。
 *
 * 用法：先 `npm run dist`（或 `npm run dist:dir`），再 `node scripts/verify-package.mjs`。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Torra.exe')
const WORK = path.join(ROOT, 'output', 'pack-check')
const PROBLEMS = []
const bad = (m) => PROBLEMS.push(m)

if (process.platform !== 'win32') {
  console.log('[pack] 目前只验 Windows 产物；macOS/Linux 需要先加对应 target 再补这条')
  process.exit(0)
}
if (!fs.existsSync(EXE)) {
  console.log(`[pack] 没有 ${path.relative(ROOT, EXE)}，先跑 npm run dist:dir`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 端口自适应：问系统要两个空闲端口，别和别的会话的调试实例撞 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

function start({ debug, mainPort, pagePort }) {
  const args = [`--user-data-dir=${path.join(WORK, 'udata')}`]
  // 第二个实例不带调试端口：端口已被第一个占着，抢不到会干扰前一次的 CDP 读法
  if (debug) args.push(`--remote-debugging-port=${pagePort}`, `--inspect=${mainPort}`)
  return spawn(EXE, args, { stdio: 'ignore' })
}

/** 连 CDP 求值。主进程必须带 includeCommandLineAPI 才拿得到 require。 */
async function evalOn(port, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const wsUrl = targets[0]?.webSocketDebuggerUrl
  if (!wsUrl) throw new Error(`端口 ${port} 上没有 CDP 目标`)
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP(${port}) 求值超时`)), 25000)
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, includeCommandLineAPI: true, awaitPromise: true },
        }),
      )
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id !== 1) return
        clearTimeout(timer)
        if (msg.error) return reject(new Error(JSON.stringify(msg.error)))
        const r = msg.result?.result
        if (r?.subtype === 'error') return reject(new Error(r.description))
        resolve(r?.value)
      })
    })
  } finally {
    ws.close()
  }
}

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })
const [mainPort, pagePort] = [await freePort(), await freePort()]

const child = start({ debug: true, mainPort, pagePort })
let exited = null
child.on('exit', (code) => (exited = { code }))
await sleep(14000)
if (exited) bad(`打包版启动 ${((14000 / 1000) | 0)}s 内就退了（code=${exited.code}），什么都没验成`)

const MAIN_SNAPSHOT = `(() => {
  const { app, BrowserWindow, nativeImage, Tray } = require('electron');
  const fs = require('fs'), path = require('path');
  const brandFile = (n) => path.join(process.resourcesPath, 'app.asar', 'resources', 'brand', 'icon-' + n + '.png');
  const sizes = [16, 32, 256].map((n) => {
    try { const s = nativeImage.createFromBuffer(fs.readFileSync(brandFile(n))).getSize(); return { n, width: s.width, height: s.height }; }
    catch (e) { return { n, error: String(e.message || e) }; }
  });
  const wins = BrowserWindow.getAllWindows();
  return JSON.stringify({
    isPackaged: app.isPackaged,
    name: app.getName(),
    userData: app.getPath('userData'),
    mainFile: require.main ? require.main.filename : null,
    adapters: (() => { try { return fs.readdirSync(path.join(process.resourcesPath, 'app.asar', 'adapters')).filter((f) => f.endsWith('.yaml')).length } catch (e) { return 'err:' + e.message } })(),
    iconSizes: sizes,
    trayCount: (() => { try { return typeof Tray.getAllTrays === 'function' ? Tray.getAllTrays().length : 'no-api' } catch (e) { return 'err:' + e.message } })(),
    windows: wins.map((w) => ({ title: w.getTitle(), visible: w.isVisible() })),
    rendererUrl: wins[0] ? wins[0].webContents.getURL() : null,
  });
})()`

const main = JSON.parse(await evalOn(mainPort, MAIN_SNAPSHOT))

if (!main.isPackaged) bad('跑起来的不是打包版（app.isPackaged=false）')
if (main.name !== 'torra') {
  bad(`应用名没钉住：app.getName()=${main.name} —— userData 会跟着 productName 变成 Torra，登录态看起来像全丢了`)
}
if (!/[/\\]output[/\\]pack-check[/\\]udata$/i.test(main.userData || '')) {
  bad(`userData 没隔离到 output/pack-check（会读写真实登录态）：${main.userData}`)
}
if (!/app\.asar/.test(main.mainFile || '')) bad(`主模块不在 asar 里：${main.mainFile}`)
for (const s of main.iconSizes) {
  if (s.error) bad(`asar 里的 icon-${s.n}.png 运行时读不出来：${s.error}`)
  else if (s.width !== s.n || s.height !== s.n) bad(`icon-${s.n}.png 运行时读出来是 ${s.width}x${s.height}`)
}
if (main.adapters < 1) bad(`内置适配器没进包（adapters=${main.adapters}），装完就是一个空壳`)
const win = main.windows.find((w) => w.title === 'Torra')
if (!win) bad(`没有标题为 Torra 的窗口：${JSON.stringify(main.windows)}`)
if (!/app\.asar[/\\]dist[/\\]renderer/.test(main.rendererUrl || '')) bad(`渲染层不是从 asar 加载：${main.rendererUrl}`)
// Electron 33 没有「枚举当前托盘」的 API（trayCount 只能拿到 no-api），
// 所以托盘只能反推：createTray() 在建窗之后执行、跑完应用还活着 = 没抛，
// 而它喂给 Tray 的正是上面那张 icon-32.png。
if (main.trayCount === 0) bad('托盘没挂上（Tray.getAllTrays() 返回 0）')

const page = JSON.parse(
  await evalOn(pagePort, `JSON.stringify({ title: document.title, rootChildren: document.getElementById('root')?.childElementCount ?? 0, errs: (window.__errs || []).slice(0, 3) })`),
)
if (!page.rootChildren) bad('渲染层白屏：#root 没有子节点')
if (page.errs.length) bad(`渲染层报错：${JSON.stringify(page.errs)}`)

// 单实例：第二个进程必须自己退出，并且不给第一个实例多开一扇窗
const before = main.windows.filter((w) => w.title === 'Torra').length
const second = start({ debug: false, mainPort, pagePort })
const secondExit = await new Promise((resolve) => {
  const t = setTimeout(() => resolve({ timeout: true }), 10000)
  second.on('exit', (code) => {
    clearTimeout(t)
    resolve({ code })
  })
})
await sleep(3000)
const after = JSON.parse(await evalOn(mainPort, `require('electron').BrowserWindow.getAllWindows().filter(w => w.getTitle() === 'Torra').length`))
if (secondExit.timeout) bad('第二个实例没有退出（单实例锁没生效）')
if (after !== before) bad(`第二个实例多开了窗口（${before} → ${after}）`)

child.kill('SIGTERM')
await sleep(3000)
if (!exited) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })

const report = { main, page, secondExit, windows: { before, after }, problems: PROBLEMS }
fs.writeFileSync(path.join(WORK, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (PROBLEMS.length) {
  console.log(`[pack] ${PROBLEMS.length} 项不通过`)
  process.exit(1)
}
console.log('[pack] 品牌层与生命周期全部通过')
