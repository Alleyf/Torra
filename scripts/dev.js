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
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    buffered += chunk
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.includes('Watching for file changes')) continue
      if (firstPass) {
        firstPass = false
        continue
      }
      if (line.includes('Found 0 errors')) restartElectron()
      else log('主进程编译未通过，窗口保持上一版本')
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
