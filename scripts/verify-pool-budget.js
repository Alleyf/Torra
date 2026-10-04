/**
 * 运行时验证：内存预算修复后，9 个 WebView 实例能否共存。
 *
 * 复现原故障：预算 1536MB 时，第 7 个实例创建完即被 LRU 销毁，
 * ensure() 返回后 pool.get() 已为 undefined → 发言报「WebView 未初始化」。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
app.setPath('userData', path.join(process.env.APPDATA || '', 'torra'))

// 与 src/main/index.ts loadDefaultModels() 的 webview 型模型一致
const BASE_MODELS = [
  'chatgpt', 'claude', 'gemini', 'deepseek-web', 'qwen', 'doubao', 'kimi',
]
// 压力测试：可用 EXTRA 追加虚拟模型，制造超预算场景
const EXTRA = Number(process.env.EXTRA || 0)
const WEBVIEW_MODELS = [
  ...BASE_MODELS,
  ...Array.from({ length: EXTRA }, (_, i) => `stress-${i + 1}`),
]

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadPool() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'webview', 'pool.ts'), 'utf8')
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const m = { exports: {} }
  const req = (id) => (id === 'electron' ? require('electron') : require(id))
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(
    m.exports, req, m, 'pool.ts', path.join(ROOT, 'src', 'main', 'webview'),
  )
  return m.exports
}

const guard = setTimeout(() => { console.log('GUARD_TIMEOUT'); app.exit(3) }, 90_000)

app.whenReady().then(async () => {
  const { WebviewPool, DEFAULT_MEMORY_BUDGET_MB, MB_PER_WEBVIEW } = loadPool()
  const YAML = require(path.join(ROOT, 'node_modules', 'yaml'))

  // 用默认预算（修复后应为 3072）
  // 可选：传入旧预算复现原故障
  const override = process.env.BUDGET_MB ? Number(process.env.BUDGET_MB) : null
  const pool = override ? new WebviewPool({ memoryBudgetMb: override }) : new WebviewPool()
  if (override) console.log(`（对照实验：使用旧预算 ${override}MB）\n`)
  const budget = DEFAULT_MEMORY_BUDGET_MB
  const perView = MB_PER_WEBVIEW
  console.log(`预算=${budget}MB 单实例=${perView}MB 可容纳=${Math.floor(budget / perView)} 个，模型数=${WEBVIEW_MODELS.length}`)
  console.log(`需求=${WEBVIEW_MODELS.length * perView}MB ${WEBVIEW_MODELS.length * perView <= budget ? '≤ 预算 ✓' : '> 预算 ✗'}\n`)

  // 建一个隐藏宿主窗口（生产代码 park() 需要）
  const host = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  pool.attachToWindow(host)

  // 复刻 AdapterRuntime：只用到 spec.entry
  for (const id of WEBVIEW_MODELS) {
    let spec
    if (id.startsWith('stress-')) {
      spec = { entry: 'about:blank', selectors: {}, completion: {}, automation: {}, health_probe: 'body' }
    } else {
      const adapterFile = id === 'deepseek-web' ? 'deepseek' : id
      spec = YAML.parse(fs.readFileSync(path.join(ROOT, 'adapters', `${adapterFile}.yaml`), 'utf8'))
    }
    // 不真加载站点 URL（避免网络耗时），这里只验证池的存活判定
    const rt = { spec: { ...spec, entry: 'about:blank' }, health: 'unknown', lastCheckedAt: 0 }
    pool.ensure(id, rt)
    // 关键断言：ensure 返回后立刻 get 必须拿得到
    const alive = pool.has(id)
    console.log(`  ${id.padEnd(14)} ensure 后存活=${alive ? 'YES' : 'NO ← 被 LRU 销毁'}`)
  }

  console.log('')
  const aliveCount = WEBVIEW_MODELS.filter((id) => pool.has(id)).length
  console.log(`存活实例 ${aliveCount}/${WEBVIEW_MODELS.length}`)
  console.log(aliveCount === WEBVIEW_MODELS.length
    ? 'PASS 全部实例共存，无人被 LRU 误伤'
    : `FAIL 有 ${WEBVIEW_MODELS.length - aliveCount} 个实例被误销毁（原故障）`)

  const out = { budget, perView, models: WEBVIEW_MODELS.length, aliveCount,
    verdict: aliveCount === WEBVIEW_MODELS.length ? 'PASS' : 'FAIL' }
  fs.writeFileSync(path.join(ROOT, 'docs', 'verify-pool-budget.json'), JSON.stringify(out, null, 2), 'utf8')
  clearTimeout(guard)
  app.exit(aliveCount === WEBVIEW_MODELS.length ? 0 : 1)
})
