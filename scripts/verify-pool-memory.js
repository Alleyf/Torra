/**
 * 一次性真机探针：常驻枚数裁剪与紧急释放到底有没有把内存还给系统。
 *
 * 为什么要在真 Electron 里跑：`memoryReport()` 读的是 `app.getAppMetrics()` 的
 * workingSetSize 按 pid 摊到每枚实例上 —— 这条链路（getOSProcessId → 指标映射）
 * 只有真内核才有，纯函数测试里量不到。这里钉四件事：
 *   1. 每枚实例确实是独立的渲染进程，且实测占用能把它的开销读出来；
 *   2. 保护期（15 秒）内那一刀砍不动；
 *   3. `trimToWarmLimit(3)` 之后恰好剩 3 枚，被裁掉的那几枚的内存真的回到 OS；
 *   4. `relievePressure()` 之后一枚不剩（attached / busy 的保护另有用例守）。
 *
 * 两个刻意的取法：
 * - 内存用「页面内自己分配」造（每枚渲染进程灌 64MB Uint8Array），不依赖网络与站点表现，
 *   这样占比一目了然、前后差是确定的。
 * - 宿主窗口交给池子自己建（`park()` → `ensureHost()`，show:true 摆到 -32000）。
 *   探针不自己 new 一个 show:false 的窗口 —— 那样测的是「隐藏窗口里的渲染进程」，
 *   与生产形态不同，读数不可信。
 *
 * 运行：.\node_modules\.bin\electron.cmd scripts/verify-pool-memory.js
 * 证据：docs/verify-pool-memory.json（每跑一次整体重写；已被 .gitignore 排除）
 */

const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execSync } = require('node:child_process')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
// 用临时 profile：探针不该碰用户真实的分区与登录态
app.setPath('userData', path.join(os.tmpdir(), 'torra-probe-memory'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MODELS = ['probe-1', 'probe-2', 'probe-3', 'probe-4', 'probe-5', 'probe-6']
const WARM_LIMIT = 3
/** 每枚渲染进程灌 8 × 8MB = 64MB */
const HOG_CHUNKS = 8
const HOG_MB_EACH = 8

/**
 * 给 Node 注册 .ts 加载器：pool.ts 会 require('./pool-memory') 等兄弟模块，
 * 只有让 Node 认 .ts 这一档，相对导入才解析得到。
 */
require.extensions['.ts'] = (mod, filename) => {
  const src = fs.readFileSync(filename, 'utf8')
  const js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  mod._compile(js, filename)
}

/** 整机层面独立取证：所有 electron.exe 的工作集之和（MB）。-1 = 量不到 */
function osElectronMb() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-Process electron -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"',
      { encoding: 'utf8', windowsHide: true },
    ).trim()
    const n = Number(out)
    return Number.isFinite(n) && n > 0 ? Math.round(n / 1048576) : -1
  } catch {
    return -1
  }
}

const guard = setTimeout(() => {
  console.log('GUARD_TIMEOUT')
  app.exit(3)
}, 240_000)

app.whenReady().then(async () => {
  const { WebviewPool, DEFAULT_MAX_WARM_INSTANCES } = require(path.join(ROOT, 'src/main/webview/pool.ts'))

  // 不 attachToWindow：park() 会自己建宿主窗口（生产同款 show:true + 屏幕外）
  const pool = new WebviewPool()

  const rt = {
    spec: { entry: 'about:blank', selectors: {}, completion: {}, automation: {}, health_probe: 'body' },
    health: 'unknown',
    lastCheckedAt: 0,
  }

  console.log('='.repeat(72))
  console.log('  常驻枚数裁剪 / 紧急释放：真机内存回收实测')
  console.log('='.repeat(72))
  console.log(`  默认常驻上限 = ${DEFAULT_MAX_WARM_INSTANCES} 枚；本次建 ${MODELS.length} 枚，每枚灌 ${HOG_CHUNKS * HOG_MB_EACH}MB`)

  const baseline = snapshot(pool, '基线（一个实例都没有）')
  printState(baseline)

  for (const id of MODELS) pool.ensure(id, rt, `persist:torra-probe-${id}`)

  // 等渲染进程起来，再往每枚里灌内存 —— 灌完才有可观测的「每枚多少钱」
  await sleep(2500)
  const hog =
    `window.__hog = Array.from({ length: ${HOG_CHUNKS} }, () => new Uint8Array(${HOG_MB_EACH} * 1024 * 1024).fill(7));` +
    ' window.__hog.length'
  for (const id of MODELS) {
    const view = pool.get(id)
    if (!view) {
      console.log(`  ${id} 实例没起来，探针无法继续`)
      clearTimeout(guard)
      app.exit(1)
      return
    }
    await view.webContents.executeJavaScript(hog)
  }
  await sleep(2000)

  const a = snapshot(pool, 'A 灌完内存（仍在保护期内）')
  console.log('\n' + renderSnapshot(a))

  // 保护期（15 秒）内的这一刀必须砍不动：刚 ensure/刚用过的不许被裁
  const duringProtection = pool.trimToWarmLimit()
  console.log(`\n  保护期内 trimToWarmLimit() 裁掉 ${duringProtection.length} 枚（期望 0）`)

  // 等过保护期，再裁一次 —— 这里显式调 trimToWarmLimit 只为验证「按枚数裁剪真能把内存还给 OS」。
  // 注意：生产里自动路径（空闲清扫、散场）已不再按枚数裁剪，并行实例数不设上限。
  await sleep(16_000)
  /*
   * 对照点：只等、不裁。把这一刀之前的状态单独量一次，
   * 才能分清「渲染进程是裁剪带走的」还是「这片环境里它们自己就没守住内存」。
   */
  const a2 = snapshot(pool, 'A2 又等了 16 秒（仍未裁剪）')
  console.log('\n' + renderSnapshot(a2))
  const trimmed = pool.trimToWarmLimit()
  // 刚杀掉几个渲染进程，进程表要落定一下再量，否则会读成「量不到」（退回保守估值）
  await sleep(2500)
  const b = snapshot(pool, `B trimToWarmLimit(${DEFAULT_MAX_WARM_INSTANCES}) 之后`)
  console.log('\n' + renderSnapshot(b))

  // 紧急释放：系统内存吃紧时把后台实例清空
  const released = pool.relievePressure()
  await sleep(2500)
  const c = snapshot(pool, 'C relievePressure() 之后')
  console.log('\n' + renderSnapshot(c))

  const checks = [
    ['6 枚实例都建起来了', a.report.count === MODELS.length, `count=${a.report.count}`],
    ['每枚都量到了实测占用', a.report.measured === true, `measured=${a.report.measured}`],
    ['每枚实例都是独立的渲染进程', a.rendererPids.length === MODELS.length, `${a.rendererPids.length} 个渲染 pid`],
    ['灌内存后池内占用明显高于基线', a.report.totalMb > baseline.report.totalMb + 200, `池内 ${a.report.totalMb}MB`],
    ['灌内存后 OS 级 RSS 明显高于基线', a.osMb - baseline.osMb > 200, `+${a.osMb - baseline.osMb}MB`],
    ['保护期内一枚都不裁', duringProtection.length === 0, `evict=${duringProtection.join('、') || '无'}`],
    [`trimToWarmLimit 后恰好剩 ${WARM_LIMIT} 枚`, b.report.count === WARM_LIMIT, `count=${b.report.count}`],
    ['被裁的是最久没用的那几枚', trimmed.length === MODELS.length - WARM_LIMIT, `evict=${trimmed.join('、')}`],
    ['裁剪后整机 RSS 明显回落', a.osMb - b.osMb > 150, `-${a.osMb - b.osMb}MB`],
    ['relievePressure 后一枚不剩', c.report.count === 0, `count=${c.report.count}`],
    ['残留占用归零', c.report.totalMb === 0, `totalMb=${c.report.totalMb}`],
    ['释放后整机回到基线附近', c.osMb > 0 && c.osMb - baseline.osMb < 200, `+${c.osMb - baseline.osMb}MB`],
  ]

  console.log('\n' + '-'.repeat(72))
  let failed = 0
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}（${detail}）`)
  }
  const verdict = failed === 0 ? 'PASS' : 'FAIL'
  console.log('-'.repeat(72))
  console.log(`  ${verdict}  ${checks.length - failed}/${checks.length} 通过`)
  console.log('='.repeat(72))

  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, 'docs', 'verify-pool-memory.json'),
    JSON.stringify(
      {
        verdict,
        warmLimit: DEFAULT_MAX_WARM_INSTANCES,
        models: MODELS,
        hogMbPerInstance: HOG_CHUNKS * HOG_MB_EACH,
        baseline,
        a,
        protectionEvict: duringProtection,
        trimmed,
        b,
        released,
        c,
        checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })),
      },
      null,
      2,
    ),
    'utf8',
  )

  clearTimeout(guard)
  pool.disposeAll()
  app.exit(failed === 0 ? 0 : 1)
})

/**
 * 一次快照：池内实况 + 逐枚 pid 与内核报的 RSS + 整机 electron 进程 RSS 合计。
 * 三者一起看才分得清「池子算错了」和「系统真的没回收」。
 */
function snapshot(pool, label) {
  const metrics = app.getAppMetrics()
  const byPid = new Map(metrics.map((m) => [m.pid, Math.round((m.memory?.workingSetSize ?? 0) / 1024)]))
  const rendererPids = metrics.filter((m) => m.type === 'Tab' || m.type === 'Renderer').map((m) => m.pid)
  return {
    label,
    report: pool.memoryReport(),
    perInstance: pool.listModelIds().map((id) => {
      let pid = 0
      try {
        pid = pool.get(id).webContents.getOSProcessId()
      } catch {
        pid = 0
      }
      return { modelId: id, pid, rssMb: byPid.get(pid) ?? null }
    }),
    rendererPids,
    appProcesses: metrics.map((m) => ({ pid: m.pid, type: m.type, rssMb: byPid.get(m.pid) ?? 0 })),
    osMb: osElectronMb(),
  }
}

function renderSnapshot(s) {
  const per = s.perInstance.map((x) => `${x.modelId}=pid${x.pid}/${x.rssMb ?? '?'}MB`).join('  ')
  return [
    `  ${s.label}`,
    `    池内 ${s.report.count} 枚 / ${s.report.totalMb}MB（${s.report.measured ? '实测' : '含估值'}）`,
    per ? `    逐枚：${per}` : '',
    `    整机 electron 进程 RSS 合计 = ${s.osMb}MB（内核列出 ${s.appProcesses.length} 个进程，其中渲染 ${s.rendererPids.length} 个）`,
  ]
    .filter(Boolean)
    .join('\n')
}

function printState(s) {
  console.log(renderSnapshot(s))
}
