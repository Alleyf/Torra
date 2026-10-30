#!/usr/bin/env node
/**
 * 一键开发模式：
 *   vite dev server + 主进程增量编译 + Electron（TORRA_DEV=1，渲染层走 HMR）
 *
 * 分工：改渲染层代码即时生效；改主进程/preload 代码自动重启 Electron 窗口。
 */
'use strict'

const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')

// Windows 控制台默认代码页常是 GBK(936)，会把程序写出的 UTF-8 中文日志显示成乱码。
// 启动时把当前控制台切到 UTF-8(65001)；子进程（含 Electron）继承同一控制台，日志一并正常。
if (process.platform === 'win32') {
  try {
    spawnSync('chcp', ['65001'], { stdio: 'ignore' })
  } catch {
    /* 无控制台或非交互环境，忽略 */
  }
}

const ROOT = path.resolve(__dirname, '..')
const DEV_HOST = '127.0.0.1'
const DEV_PORT_START = 5273

const BINS = {
  vite: path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
  tsc: path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
}

const children = []
let devPort = DEV_PORT_START
let electron = null
let restartingElectron = false
let shuttingDown = false

function log(msg) {
  console.log(`[dev] ${msg}`)
}

/** ELECTRON_RUN_AS_NODE 存在时 Electron 会退化成纯 Node，主进程起不来 */
function childEnv(extra) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** 从 5273 起顺延找空闲端口：本机常有其他会话的 vite 占着默认口 */
function pickPort(tries = 12) {
  return new Promise((resolve, reject) => {
    const probe = (port, left) => {
      const srv = net.createServer()
      srv.once('error', () => {
        srv.close()
        if (left <= 0) return reject(new Error(`${DEV_PORT_START}~${port} 都被占用`))
        probe(port + 1, left - 1)
      })
      srv.once('listening', () => srv.close(() => resolve(port)))
      srv.listen(port, DEV_HOST)
    }
    probe(DEV_PORT_START, tries - 1)
  })
}

function killTree(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of children) killTree(child)
  if (electron) killTree(electron)
  process.exit(code)
}

function start(name, cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: childEnv() })
  children.push({ name, child })
  child.on('exit', (code) => {
    if (shuttingDown) return
    log(`${name} 已退出 (code ${code})，停止开发`)
    shutdown(code === 0 ? 0 : 1)
  })
  return child
}

function electronBin() {
  try {
    return require('electron')
  } catch {
    log('Electron 二进制未安装。执行：\n' +
      '  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js')
    process.exit(1)
  }
}

function startElectron() {
  const child = spawn(electronBin(), ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: childEnv({ TORRA_DEV: '1', TORRA_DEV_PORT: String(devPort) }),
  })
  electron = child
  log(`Electron 已启动（渲染层 http://${DEV_HOST}:${devPort}，支持 HMR）`)
  child.on('exit', (code) => {
    electron = null
    if (restartingElectron) {
      restartingElectron = false
      if (!shuttingDown) setTimeout(startElectron, 200)
      return
    }
    if (shuttingDown) return
    log('窗口已关闭')
    shutdown(code === 0 ? 0 : 1)
  })
}

function restartElectron() {
  if (!electron || shuttingDown || restartingElectron) return
  log('主进程 / preload 有变更，重启 Electron')
  restartingElectron = true
  killTree(electron)
}

/** 编译输入目录，与 tsconfig.main.json 的 include 对应 */
const SOURCE_ROOTS = ['src/main', 'src/preload', 'src/shared']
/** 真正会被 Electron 加载的产物目录 */
const OUTPUT_ROOTS = ['dist/main', 'dist/preload']

function listFiles(dir, keep, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, keep, out)
    else if (entry.isFile() && keep(full)) out.push(full)
  }
  return out
}

/** 记录一组文件的「指纹」：相对路径 → 大小 + mtime */
function toStampMap(roots, keep) {
  const map = new Map()
  for (const rel of roots) {
    for (const file of listFiles(path.join(ROOT, rel), keep, [])) {
      try {
        const st = fs.statSync(file)
        map.set(path.relative(ROOT, file), st.size + ':' + st.mtimeMs)
      } catch {
        /* 遍历时被删除的文件忽略即可 */
      }
    }
  }
  return map
}

const readSources = () => toStampMap(SOURCE_ROOTS, (file) => file.endsWith('.ts'))
const readOutputs = () => toStampMap(OUTPUT_ROOTS, (file) => file.endsWith('.js'))

function diffStamps(before, after) {
  const changed = []
  for (const [file, sig] of after) if (before.get(file) !== sig) changed.push(file)
  for (const file of before.keys()) if (!after.has(file)) changed.push(file + '（已删除）')
  return changed
}

/**
 * 主进程增量编译。以 tsc watch 的「编译完成」行为重启信号：
 * fs.watch 监听 dist 会在 watch 首轮全量落盘时误触发重启。
 */
function startMainWatch() {
  const child = spawn(process.execPath, [BINS.tsc, '-p', 'tsconfig.main.json', '--watch'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: childEnv(),
  })
  children.push({ name: 'tsc --watch', child })
  child.on('exit', (code) => {
    if (shuttingDown) return
    log(`tsc --watch 已退出 (code ${code})，停止开发`)
    shutdown(code === 0 ? 0 : 1)
  })

  let buffered = ''
  let firstPass = true
  let lastSources = readSources()
  let lastOutputs = readOutputs()
  let restartTimer = 0

  /** tsc 可能把 main 与 preload 分两轮落盘，合并成一次重启 */
  const scheduleRestart = () => {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = 0
      restartElectron()
    }, 250)
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    buffered += chunk
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.includes('Watching for file changes')) continue
      const sources = readSources()
      const changedSources = diffStamps(lastSources, sources)
      lastSources = sources
      const outputs = readOutputs()
      // 只看新增/重写：tsc 不会删除产物，产物消失不是一次真正的编译
      const outputChanged = Array.from(outputs).some(([file, sig]) => lastOutputs.get(file) !== sig)
      lastOutputs = outputs
      if (firstPass) {
        firstPass = false
        continue
      }
      if (!line.includes('Found 0 errors')) {
        log('主进程编译未通过，窗口保持上一版本')
        continue
      }
      if (!changedSources.length) {
        // tsc 还会盯着 dist：外部往产物目录里加文件、编辑器改写产物，都会报一轮编译。
        // 源码没变就没有值得重启的东西，重启只会把正在用的窗口打断。
        log('tsc 报告了变化，但源码没有变化，跳过重启')
        continue
      }
      if (!outputChanged) {
        // 只有目录事件 / 临时文件进出、正文没变时 tsc 也会报「File change detected」。
        // 这种空跑不重启窗口，否则保存一次无关文件也要整窗重开。
        log(`tsc 报告了变化（${changedSources.join('、')}），但没有新的编译产物，跳过重启`)
        continue
      }
      log(`主进程源码已更新：${changedSources.join('、')}`)
      scheduleRestart()
    }
  })
}

function waitForDevServer(port, tries = 200) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http
        .get({ host: DEV_HOST, port, path: '/', timeout: 1000 }, (res) => {
          res.resume()
          resolve()
        })
        .on('error', () => {
          if (tries-- <= 0) return reject(new Error(`vite dev server 未在 ${port} 端口就绪`))
          setTimeout(attempt, 150)
        })
      req.on('timeout', () => req.destroy())
    }
    attempt()
  })
}

async function main() {
  for (const [name, file] of Object.entries(BINS)) {
    if (!fs.existsSync(file)) {
      log(`缺少 ${name}，请先 npm install`)
      process.exit(1)
    }
  }

  log('首次编译主进程 + preload…')
  const built = spawnSync(process.execPath, [BINS.tsc, '-p', 'tsconfig.main.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (built.status !== 0) {
    log('主进程编译失败，已中止')
    process.exit(built.status === null ? 1 : built.status)
  }

  devPort = await pickPort()
  log(`dev server 端口 ${devPort}`)

  start('vite', process.execPath, [BINS.vite, '--port', String(devPort)])
  startMainWatch()

  await waitForDevServer(devPort)
  startElectron()
  log('Ctrl+C 退出')
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

void main().catch((e) => {
  log(String(e && e.message ? e.message : e))
  shutdown(1)
})
