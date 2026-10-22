/**
 * 便携版自更新（主进程侧）
 *
 * 为什么便携版要单独一套：electron-builder 的 portable 目标**不写** latest.yml
 * （源码 NsisTarget.js: isWriteUpdateInfo: !this.isPortable），
 * 也就是说 latest.yml 里只有 Torra-Setup-*.exe，没有便携版自己的产物地址。
 * electron-updater 那条「下载 NSIS 安装包 → 跑安装器」的路径对便携版根本不成立。
 *
 * 便携版的权威产物就是那个 exe 文件本身，所以自更新是：
 *   检查新版本 → 下载新的 Portable exe → 校验 sha256 → 退出 → 替换 exe → 拉起新的
 *
 * 更新清单用 CI 已经发布的 SHA256SUMS.txt（里面本来就有便携版 exe 的 sha256），
 * 版本号从 GitHub 的 latest release 拿。因此不需要改 CI 流水线。
 */

import { app, net } from 'electron'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  PORTABLE_SUMS_FILE,
  assessPortableOffer,
  type PortableOffer,
} from '../../shared/portable-update'

const GITHUB_API = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 30_000

export interface PortableUpdaterDeps {
  /** 仓库坐标，和 setup/updater.ts 里的 RELEASE_REPO 必须一致 */
  owner: string
  repo: string
  /** 当前版本（裸版本号） */
  version: string
  /** 权威 exe 的绝对路径（便携版宿主注入的 PORTABLE_EXECUTABLE_FILE） */
  targetExe: string
  /** 下载完成的 exe 落在哪 */
  pendingDir: string
  /** 状态回传给渲染层 */
  publish: (ev: PortableEvent) => void
  /** 日志 */
  log?: (detail: string) => void
}

export type PortableEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; percent: number; transferred: number | null; total: number | null }
  | { type: 'downloaded'; file: string }
  | { type: 'error'; stage: 'check' | 'download'; message: string }

export interface PortableUpdaterApi {
  check: () => Promise<{ ok: boolean; reason?: string }>
  download: () => Promise<{ ok: boolean; reason?: string }>
  /** 安排替换 exe 并拉起新版本；本进程随即退出 */
  install: () => { ok: boolean; reason?: string }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/**
 * 带超时的 GET
 *
 * 用 Electron 的 net.request，而不是 net.fetch：
 * - net.request 走 Chromium 的网络栈，会认系统代理设置，和 electron-updater
 *   （内部也用 electron.net）口径一致；用户在需要代理的网络里两个入口表现一致。
 * - 实测 net.fetch 在首次连接 api.github.com 时会卡 8 秒以上、甚至直接失败，
 *   而 net.request 同一地址 3ms 就回。更新检查不能赌这个。
 */
function get(url: string, accept: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url })
    let settled = false
    const done = (err: Error | null, body?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(body!)
    }
    const timer = setTimeout(() => {
      req.abort()
      done(new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`))
    }, REQUEST_TIMEOUT_MS)
    req.on('response', (res) => {
      const code = res.statusCode ?? 0
      if (code < 200 || code >= 300) {
        req.abort()
        done(new Error(`HTTP ${code}`))
        return
      }
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => done(null, body))
      res.on('error', (e: Error) => done(e))
    })
    req.on('error', (e: Error) => done(e))
    req.setHeader('Accept', accept)
    req.setHeader('User-Agent', 'Torra-Desktop')
    req.end()
  })
}

function downloadFile(
  url: string,
  dest: string,
  onProgress: (percent: number, transferred: number, total: number | null) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url })
    let settled = false
    let timer: NodeJS.Timeout
    let out: ReturnType<typeof createWriteStream> | null = null

    const finish = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }

    const resetTimer = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        req.abort()
        out?.destroy()
        finish(new Error(`下载超时（${REQUEST_TIMEOUT_MS / 1000} 秒没有收到数据）`))
      }, REQUEST_TIMEOUT_MS)
    }

    resetTimer()
    req.on('response', (res) => {
      const code = res.statusCode ?? 0
      if (code < 200 || code >= 300) {
        req.abort()
        finish(new Error(`下载失败：HTTP ${code}`))
        return
      }

      const total = Number(res.headers['content-length']) || null
      let transferred = 0
      out = createWriteStream(dest)

      res.on('data', (chunk: Buffer) => {
        if (settled) return
        resetTimer()
        transferred += chunk.byteLength
        onProgress(total ? Math.min(100, Math.floor((transferred / total) * 100)) : 0, transferred, total)
      })
      res.on('error', (e: Error) => {
        out?.destroy()
        finish(e)
      })
      res.on('aborted', () => {
        out?.destroy()
        finish(new Error('下载被中止了，文件不完整，已丢弃。'))
      })
      out.on('error', (e: Error) => {
        req.abort()
        finish(e)
      })
      out.on('finish', () => finish(null))
      /*
       * Electron 的类型声明没暴露 IncomingMessage 的流方法，但运行时它确实是
       * Node 可读流。实测 pause / resume / pipe / read 都存在，交给 pipe 才能
       * 在磁盘写不过来时暂停网络，避免把整个升级包堆进内存。
       */
      ;(res as unknown as NodeJS.ReadableStream).pipe(out)
    })
    req.on('error', (e: Error) => {
      out?.destroy()
      finish(e)
    })
    req.setHeader('User-Agent', 'Torra-Desktop')
    req.end()
  })
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(file)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

export function createPortableUpdater(deps: PortableUpdaterDeps): PortableUpdaterApi {
  let offer: PortableOffer | null = null
  let downloaded: string | null = null
  let downloading = false
  let installScheduled = false

  const releaseBase = `https://github.com/${deps.owner}/${deps.repo}/releases`

  return {
    async check() {
      if (downloading) return { ok: false, reason: '更新包正在下载，请等这一轮结束。' }
      if (installScheduled) return { ok: false, reason: '升级已经安排好了，正在退出应用。' }
      try {
        deps.publish({ type: 'checking' })
        offer = null
        const latest = await get(
          `${GITHUB_API}/repos/${deps.owner}/${deps.repo}/releases/latest`,
          'application/vnd.github+json',
        )
        let tag = ''
        try {
          tag = String((JSON.parse(latest) as { tag_name?: string }).tag_name ?? '')
        } catch {
          throw new Error('GitHub 返回的版本信息不是 JSON')
        }
        if (!tag) throw new Error('GitHub 没给出版本号（tag_name 为空）')

        /*
         * 清单和产物都按同一个 tag 取。
         * 不写 /latest：那个别名在「刚发了新版本、两次请求之间版本跳了」时
         * 可能给出和清单不配套的一对文件，而 sha256 校验会把它挡下来、
         * 让用户看到一个莫名其妙的失败。写死 tag 就没这个窗口。
         */
        const sums = await get(`${releaseBase}/download/${tag}/${PORTABLE_SUMS_FILE}`, 'text/plain')
        const assessed = assessPortableOffer({
          tag,
          sums,
          current: deps.version,
          downloadUrl: (fileName) => `${releaseBase}/download/${tag}/${fileName}`,
        })
        if (!assessed.ok) {
          deps.log?.(assessed.reason)
          if (assessed.notAvailable) {
            deps.publish({ type: 'not-available', version: deps.version })
          } else {
            deps.publish({ type: 'error', stage: 'check', message: assessed.reason })
          }
          return { ok: false, reason: assessed.reason }
        }
        offer = assessed.offer
        deps.publish({ type: 'available', version: assessed.offer.version })
        return { ok: true }
      } catch (e) {
        const message = errMessage(e)
        deps.log?.(`检查更新失败：${message}`)
        deps.publish({ type: 'error', stage: 'check', message })
        return { ok: false, reason: message }
      }
    },

    async download() {
      if (downloading) return { ok: false, reason: '更新包正在下载，请等这一轮结束。' }
      if (installScheduled) return { ok: false, reason: '升级已经安排好了，正在退出应用。' }
      const activeOffer = offer
      if (!activeOffer) return { ok: false, reason: '还没有待下载的新版本。' }
      downloading = true
      try {
        // 先把状态推进到 downloading，界面上的「检查更新」会立刻让开
        deps.publish({ type: 'progress', percent: 0, transferred: 0, total: null })
        const dest = path.join(deps.pendingDir, activeOffer.fileName)
        try {
          await fs.mkdir(deps.pendingDir, { recursive: true })
          // 先删掉上次没下完的残留，否则续传会把新旧字节拼在一起
          await fs.rm(dest, { force: true })

          await downloadFile(activeOffer.url, dest, (percent, transferred, total) => {
            deps.publish({ type: 'progress', percent, transferred, total })
          })
          // 校验落盘后的文件，而不是只信网络流：写盘失败或短写也必须被拦住
          const digest = await sha256File(dest)
          if (digest !== activeOffer.sha256) {
            await fs.rm(dest, { force: true })
            const reason = `下载到的文件校验和不符（期望 ${activeOffer.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…），已丢弃，请重试。`
            deps.publish({ type: 'error', stage: 'download', message: reason })
            return { ok: false, reason }
          }

          downloaded = dest
          deps.publish({ type: 'downloaded', file: dest })
          return { ok: true }
        } catch (e) {
          const message = errMessage(e)
          await fs.rm(dest, { force: true }).catch(() => {})
          deps.log?.(`下载失败：${message}`)
          deps.publish({ type: 'error', stage: 'download', message })
          return { ok: false, reason: message }
        }
      } finally {
        downloading = false
      }
    },

    install() {
      if (installScheduled) return { ok: false, reason: '升级已经安排好了，正在退出应用。' }
      if (!downloaded) return { ok: false, reason: '新版本还没下载完。' }
      const target = deps.targetExe
      if (!target) return { ok: false, reason: '找不到便携版主程序的路径，无法替换。' }
      const scriptPath = path.join(deps.pendingDir, 'apply-update.ps1')
      try {
        /*
         * 替换必须发生在**当前进程完全退出之后**。
         *
         * 实测：便携版运行期间，那个 exe 被 NSIS 的 SFX 宿主打开着，
         * 对它改名会拿到 EBUSY —— Windows 允许改名，但删不掉正被占用的文件，
         * 而这个 exe 还额外被宿主占着。所以替换动作交给一个独立的
         * PowerShell 进程，它会一直重试改名，直到宿主放手。
         *
         * 用 PowerShell 而不是 cmd：需要「重试直到成功」和可靠的存在性判断，
         * cmd 的 move 在文件被占用时失败一次就往下走，会留下半个替换状态。
         */
        const ps = [
          '$ErrorActionPreference = "Stop"',
          `$src = ${psQuote(downloaded)}`,
          `$dst = ${psQuote(target)}`,
          `$bak = ${psQuote(target + '.old')}`,
          `$log = ${psQuote(path.join(deps.pendingDir, 'apply-update.log'))}`,
          'function Say($m) { Add-Content -LiteralPath $log -Value $m -ErrorAction SilentlyContinue }',
          'Say ("start " + (Get-Date -Format o))',
          'if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }',
          '$moved = $false',
          'for ($i = 0; $i -lt 60; $i++) {',
          '  try {',
          '    Move-Item -LiteralPath $dst -Destination $bak -Force -ErrorAction Stop',
          '    $moved = $true',
          '    break',
          '  } catch { Start-Sleep -Milliseconds 500 }',
          '}',
          'if (-not $moved) {',
          '  Say "move failed after 30s"',
          '  try { Start-Process -FilePath $dst; Say "relaunched old after move timeout" } catch { Say ("old relaunch failed: " + $_.Exception.Message) }',
          '  exit 2',
          '}',
          'try {',
          '  Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop',
          '  Say "copied"',
          '} catch {',
          '  Say ("copy failed: " + $_.Exception.Message)',
          '  Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue',
          '  if (Test-Path -LiteralPath $bak) {',
          '    try { Move-Item -LiteralPath $bak -Destination $dst -Force -ErrorAction Stop; Say "rolled back" } catch { Say ("rollback failed: " + $_.Exception.Message) }',
          '  }',
          '  try { Start-Process -FilePath $dst; Say "relaunched old" } catch { Say ("old relaunch failed: " + $_.Exception.Message) }',
          '  exit 3',
          '}',
          'Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue',
          'Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue',
          'Say "replaced"',
          // 拉起新版本失败也不能算替换失败 —— 文件这会儿已经换好了
          'try { Start-Process -FilePath $dst; Say "relaunched" } catch { Say ("relaunch failed: " + $_.Exception.Message) }',
        ].join('\r\n')

        // PowerShell 5.1 对无 BOM 的 UTF-8 按 ANSI 解析；路径含中文时必须带 BOM
        writeFileSync(scriptPath, '\ufeff' + ps, 'utf8')
        /*
         * 启动方式不是「直接 spawn powershell」，而是「cmd /c start」。
         *
         * 实测（本机 Windows）：
         * - detached + 直接 spawn powershell.exe：脚本**根本没执行**，
         *   进程秒退且没有任何输出 —— 这是最坏的一种失败，因为它看起来像成功了。
         * - cmd /c start：脚本正常执行，而且父进程退出后它还活着。
         *
         * 所以这里必须走 cmd 的 start：它会另起一个独立进程，
         * 既躲开了 powershell 在 detached 下的毛病，也保证了本进程退出后
         * 替换脚本还在跑 —— 而替换必须在宿主放手之后才能做。
         * 用 spawnSync 等 cmd 自己退出：这样脚本没拉起来时能当场返回失败，
         * 而不是提前关掉应用、留下一个看起来成功但什么都没发生的状态。
         */
        const launched = spawnSync(
          'cmd.exe',
          [
            '/c',
            'start',
            '""',
            '/b',
            'powershell.exe',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-WindowStyle',
            'Hidden',
            '-File',
            scriptPath,
          ],
          { windowsHide: true, stdio: 'ignore' },
        )
        if (launched.error) throw launched.error
        if (launched.status !== 0) throw new Error(`替换脚本启动失败（cmd exit ${launched.status}）`)
        installScheduled = true

        // 本进程必须先退出，SFX 宿主才会放手那个 exe。
        // 走 app.quit() 而不是 app.exit()：前者会触发 before-quit 的会话刷盘。
        setTimeout(() => app.quit(), 300)
        return { ok: true }
      } catch (e) {
        installScheduled = false
        return { ok: false, reason: errMessage(e) }
      }
    },
  }
}

/** PowerShell 单引号串里要 doubled 的单引号 */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** 便携版宿主注入的 exe 路径；非便携版返回 null */
export function portableExePath(): string | null {
  const p = process.env.PORTABLE_EXECUTABLE_FILE
  return p && p.trim() ? path.resolve(p.trim()) : null
}

/** 便携版下更新包的暂存目录 */
export function portablePendingDir(): string {
  return path.join(app.getPath('userData'), 'updates')
}
