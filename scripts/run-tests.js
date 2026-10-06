/**
 * 一次跑完所有 test:* 套件再汇总 —— 取代 npm test 的 `&&` 串链
 *
 * `&&` 的代价不是「慢」，是**遮蔽**：第一处失败就把后面的套件全部跳过，而输出里只看得到
 * 那一条失败，看不出「还剩多少套件根本没跑」。这在仓库里已经真实发生过两次：
 * 第 1 轮的假绿基线（e2e 单条断言失败，后 16 套从未执行却被当成跑过）、
 * 第 8 轮（api-retry 一条本地 mock 偶发失败，其后 11 套零输出）。
 * CI 的 `npm test`（.github/workflows/build.yml）吃的是同一个口径，所以这里也必须管它。
 *
 * 判定仍以退出码为唯一权威（套件自己 exit 1 就算失败）；汇总行只是展示，
 * 解析不到汇总行的套件照样计入通过。
 *
 * 用法：npm test（全部套件）· npm test -- --list（只列清单，不执行）
 */
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

/** 套件清单取自 package.json 的 `test:` 键，不写死名字 —— 「加了脚本却没进链」正是本文件要防的事 */
function listSuites(scripts) {
  return Object.keys(scripts).filter((key) => key.startsWith('test:'))
}

/**
 * 仓库里并存三种汇总行口径：「通过 12 · 失败 0」「12 passed, 0 failed」「全部通过：12 passed, 0 failed」。
 * 从后往前找第一条命中的，因为套件末尾那行才是最终计数。
 */
function parseSummary(output) {
  const lines = String(output || '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/通过 (\d+) · 失败 (\d+)/) || lines[i].match(/(\d+) passed,? (\d+) failed/)
    if (m) return { pass: Number(m[1]), fail: Number(m[2]) }
  }
  return null
}

/**
 * 逐套执行、不提前中断：任何一处失败都只记录，不影响后面的套件是否运行。
 * `execute(key)` 返回 `{ code, output }`，抽成参数是为了让用例能注入假执行器验这条不变量。
 */
function runSuites(suites, execute) {
  return suites.map((key) => {
    const { code, output } = execute(key)
    return { key, code, output: String(output || ''), summary: parseSummary(output) }
  })
}

/** 展示 + 退出码：有任一失败 → 1，并把失败套件的完整输出附在末尾（通过只显示一行，避免刷屏） */
function formatReport(results) {
  const failed = results.filter((r) => r.code !== 0)
  const lines = ['', '='.repeat(46)]
  for (const r of results) {
    const counts = r.summary ? `${r.summary.pass} 通过 / ${r.summary.fail} 失败` : '（无汇总行）'
    lines.push(`${r.code === 0 ? ' ok ' : 'FAIL'} ${r.key.padEnd(26)} ${counts}`)
  }
  const passedAssertions = results.reduce((acc, r) => acc + (r.summary ? r.summary.pass : 0), 0)
  const failedAssertions = results.reduce((acc, r) => acc + (r.summary ? r.summary.fail : 0), 0)
  lines.push('-'.repeat(46))
  lines.push(
    `套件 ${results.length - failed.length}/${results.length} 通过 · 断言 ${passedAssertions} 通过 / ${failedAssertions} 失败`,
  )
  for (const r of failed) {
    lines.push('', `! ${r.key} 退出码 ${r.code}，完整输出：`, r.output.trimEnd() || '(无输出)')
  }
  return { report: lines.join('\n'), exitCode: failed.length ? 1 : 0 }
}

/** 真实执行器：跑 package.json 里那条命令本身，保证与改前的 `npm run test:x` 一字不差 */
function spawnSuite(command) {
  const bin = path.join(ROOT, 'node_modules', '.bin')
  const res = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // 直接 `node scripts/run-tests.js` 时没人帮我们配 PATH，npm 里跑才有；两种入口都得能跑
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` },
  })
  if (res.error) return { code: 1, output: String(res.error.message) }
  return { code: res.status === null ? 1 : res.status, output: `${res.stdout || ''}${res.stderr || ''}` }
}

function main() {
  const pkg = require(path.join(ROOT, 'package.json'))
  const suites = listSuites(pkg.scripts)
  if (process.argv.includes('--list')) {
    console.log(suites.join('\n'))
    return 0
  }
  console.log(`共 ${suites.length} 个套件，全部跑完再汇总（一处失败不截断后面的套件）`)
  const results = runSuites(suites, (key) => {
    process.stdout.write(`▶ ${key}\n`)
    return spawnSuite(pkg.scripts[key])
  })
  const { report, exitCode } = formatReport(results)
  console.log(report)
  return exitCode
}

if (require.main === module) process.exit(main())

module.exports = { formatReport, listSuites, parseSummary, runSuites, spawnSuite }
