// README 配图：一条命令把 docs/ 里那三张界面图重拍成「当前构建的样子」。
//
// 为什么复用 scripts/smoke.js，而不是像 scripts/capture-site.mjs 那样自己起一个界面：
// README 要的是「讨论真的在跑」的那几屏 —— 发言卡、论题演化、共识台账、报告溯源，
// 这些状态全部来自冒烟脚本里那份事件夹具。另起一份就等于把夹具抄第二遍，
// 抄来的那份迟早和断言用的那份不一致，到时候 README 的图就成了自证清白的道具。
// 所以这里只做四件事：确认构建是新的、把窗口摆到出图模式、等它跑完、验图真的落盘。
//
// 与 capture-site.mjs 的另一处分工：落地页那批图要的是零数据状态（首页引导、设置未配置），
// 这批要的是有内容的工作态。两边各拍各的，谁也不借谁的图。
//
// 用法：npm run shots            重拍 README 三张
//       npm run shots -- --no-build   跳过构建（刚 build 过时省 10 秒）
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const DOCS = path.join(ROOT, 'docs')
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))

/**
 * README「界面」小节用的三张图。
 *
 * 名字沿用冒烟脚本原本就在写的那几个：另起一套干净的名字容易，难的是从此
 * docs/ 里同一屏存着两份图，过半年没人知道该看哪一份。
 * 其中开场页与历史页两张是冒烟流程本来就会写的，只有「讨论进行中」那张
 * 需要 --docs-shots 才出 —— 它挑的是断言正好停在有台账那一屏的时刻。
 */
const SHOTS = [
  ['screenshot-m1-guide.png', '发起讨论：模型通道带真实状态灯，参与模型一行直接换通道'],
  ['smoke-discussion-flow.png', '讨论进行中：介入面板、论题演化图与结论台账并排在场'],
  ['screenshot-m1-history.png', '历史：每场的结论状态、轮次、费用与缺席模型都留着'],
]

function dims(file) {
  const b = fs.readFileSync(file)
  if (b.readUInt32BE(0) !== 0x8950_4e47) return '非 PNG'
  return `${b.readUInt32BE(16)}×${b.readUInt32BE(20)}`
}

function needBuild() {
  const missing = ['dist/renderer/index.html', 'dist/main/net/favicon-cache.js'].filter(
    (f) => !fs.existsSync(path.join(ROOT, f)),
  )
  if (!missing.length) return
  console.log('先构建：' + missing.join(', ') + ' 不在')
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    // Windows 上 npm 是 npm.cmd，没有 shell 起不来
    shell: process.platform === 'win32',
  })
  if (r.status !== 0) {
    console.error('构建失败，先修构建再出图。')
    process.exit(r.status ?? 1)
  }
}

const startedAt = Date.now()
if (!process.argv.includes('--no-build')) needBuild()

/*
 * 先把上一趟的报告删掉。docs/smoke-report.json 是 gitignore 掉的产物，跑一次留一份，
 * 不删的话「这一趟卡死了」和「这一趟全绿」看起来是一模一样的 —— 读出来的是昨天那份。
 */
const REPORT = path.join(DOCS, 'smoke-report.json')
fs.rmSync(REPORT, { force: true })

console.log('跑冒烟流程出图（窗口会真的弹出来，约 3~4 分钟）…\n')
// 冒烟流程偶尔会在开机那几步上再也不往下走（窗口在、进程活着、一行输出都没有）。
// 与其让这条命令挂到天荒地老，不如到点自己收摊，把「没跑到终点」说清楚。
const LIMIT_MS = 8 * 60 * 1000
const { code, timedOut } = await new Promise((resolve) => {
  let hitLimit = false
  const child = spawn(electronBin, [path.join(ROOT, 'scripts', 'smoke.js'), '--show', '--docs-shots'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const timer = setTimeout(() => {
    hitLimit = true
    console.log(`\n超过 ${LIMIT_MS / 60000} 分钟没跑完，收摊。`)
    if (process.platform === 'win32') {
      // 只 kill 父进程的话，Electron 的 zygote/渲染子进程会留在桌面上继续开着
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  }, LIMIT_MS)
  child.on('exit', (c) => {
    clearTimeout(timer)
    resolve({ code: c ?? 1, timedOut: hitLimit })
  })
})

console.log('\n结果：')
let bad = 0
for (const [file, what] of SHOTS) {
  const abs = path.join(DOCS, file)
  if (!fs.existsSync(abs)) {
    console.log(`  \x1b[31m✗\x1b[0m ${file} 不存在 —— ${what}`)
    bad++
    continue
  }
  const mtime = fs.statSync(abs).mtimeMs
  if (mtime < startedAt - 5000) {
    console.log(`  \x1b[31m✗\x1b[0m ${file} 没被更新（${new Date(mtime).toLocaleTimeString()} 的旧图）—— 出图点没跑到`)
    bad++
    continue
  }
  console.log(`  \x1b[32m✓\x1b[0m ${file}  ${dims(abs)}  ${what}`)
}

if (timedOut) {
  console.log('\n\x1b[31m这一趟是被超时掐掉的：上面没打 ✓ 的图就是没拍到，别拿旧图交差。\x1b[0m')
  bad++
} else if (code !== 0) {
  console.log(`\n冒烟流程退出码 ${code}：图可以是对的，但断言有红，先看上面再决定用不用。`)
}

/*
 * 出图这件事本身不该只由「图存在」来担保。冒烟脚本跑完会把这一趟攒下的所有
 * 断言失败写进 docs/smoke-report.json 的 consoleErrors 字段（字段名是历史遗留，
 * 里面既有渲染层报错也有断言判词），这里把它读出来贴到结论后面 ——
 * 一张来自报错现场的图，和一张来自干净运行的图，看起来可以一模一样。
 */
if (!fs.existsSync(REPORT)) {
  console.log('\n没等到 docs/smoke-report.json：这一趟冒烟没跑到写报告那一步，上面的图请当未核验。')
  bad++
} else {
  const rep = JSON.parse(fs.readFileSync(REPORT, 'utf8'))
  const errs = Array.isArray(rep.consoleErrors) ? rep.consoleErrors : []
  if (errs.length) {
    console.log(`\n\x1b[33m注意：这一趟冒烟有 ${errs.length} 条断言没绿，图是在有红的运行里拍的。\x1b[0m`)
    for (const e of errs.slice(0, 5)) console.log('  · ' + String(e).slice(0, 160))
    if (errs.length > 5) console.log(`  … 其余 ${errs.length - 5} 条见 ${REPORT}`)
  } else {
    console.log('\n冒烟断言：全绿。')
  }
}
process.exit(bad ? 1 : 0)
