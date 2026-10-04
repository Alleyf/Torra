/**
 * 离线链路体检（CLI）—— 与设置页里的「链路体检」跑的是同一份代码。
 *
 * 为什么要有 CLI：app 正在出问题时你未必进得去设置页（实例卡死、白屏），
 * 而且体检需要独占分区。所以约定：先退出 Torra，再跑 npm run doctor。
 *
 * 关键约束（历史上踩过）：必须以 app 自己的 userData 启动。
 * 分区名相同但根目录不同 = 另一套全新空分区，测出来的登录态与选择器
 * 命中情况对真实运行完全无效 —— 旧脚本正是在这里得出过「未登录」的假结论。
 *
 * 用法：
 *   npm run doctor                          # 全部模型
 *   npm run doctor -- --model deepseek-web  # 只查一个
 *   npm run doctor -- --no-ping             # 不探测 API 端点（离线时用；Key 写错就查不出来了）
 *
 * 智能添加的离线演练（与设置页向导同一份代码，只读，不落地、不计费）：
 *   npm run doctor -- --smart https://yuanbao.tencent.com/       # 识别网页站点，打印方案与逐条命中数
 *   npm run doctor -- --smart <url> --answer page-input=xxx   # 把澄清回答喂给 refineWeb（同 UI 那条路）
 *   npm run doctor -- --smart-api https://api.example.com/v1     # 嗅探 API 端点（只 GET /models）
 *   可选 --assistant <apiModelId>；端点需要 Key 时用环境变量 TORRA_SMART_KEY 传入（不走命令行，避免留在历史里）
 */

const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist', 'main')

app.setName('torra')
app.setPath('userData', path.join(app.getPath('appData'), 'torra'))

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : argv[i + 1]
}
/** --answer 可重复，用于在命令行复现「澄清回答 → 更新方案」这一步 */
const answers = argv
  .map((a, i) => (a === '--answer' ? argv[i + 1] : null))
  .filter((s) => typeof s === 'string' && s.includes('='))
  .reduce((acc, s) => {
    const i = s.indexOf('=')
    acc[s.slice(0, i)] = s.slice(i + 1)
    return acc
  }, {})
const flags = {
  modelId: arg('model'),
  ping: !argv.includes('--no-ping'),
  smart: arg('smart'),
  smartApi: arg('smart-api'),
  assistant: arg('assistant'),
  answers,
}

function requireBuilt(rel) {
  const file = path.join(DIST, `${rel}.js`)
  if (!fs.existsSync(file)) {
    process.stderr.write(
      `缺少编译产物 ${path.relative(ROOT, file)}\n` +
        `先跑 npm run build:main（或让 npm run dev 的 tsc watch 完成一次构建）。\n`,
    )
    app.exit(2)
  }
  return require(file)
}

/**
 * 找出正在运行的 Torra 主进程。
 *
 * 必须区分「本项目在跑」和「机器上别人也在用 Electron」：分区数据库被
 * 另一个进程持锁时，本 CLI 读到的登录态与 DOM 全是假象，报告看着完整
 * 实则无效。命中就退出并提示改用设置页里的体检（同进程、无争用）。
 * 只按命令行里的本项目路径匹配，绝不结束他人进程。
 */
function detectLiveInstance() {
  const { execFileSync } = require('node:child_process')
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" | Select-Object -ExpandProperty CommandLine',
      ],
      { encoding: 'utf8', timeout: 8000 },
    )
    const needle = path.join(ROOT, 'node_modules').toLowerCase().replace(/\\/g, '/')
    return out
      .split(/\r?\n/)
      .filter((l) => l && l.toLowerCase().replace(/\\/g, '/').includes(needle))
      .filter((l) => !/doctor\.js/.test(l))
      .slice(0, 3)
  } catch {
    return []
  }
}

const { WebviewPool } = requireBuilt('webview/pool')
const { AdapterRegistry } = requireBuilt('adapters/registry')
const { FileSessionStore } = requireBuilt('store/session-store')
const { KeychainSecretStore } = requireBuilt('store/keychain')
const { diag } = requireBuilt('diagnostics/log')
const { runDoctor, persistReport } = requireBuilt('diagnostics/doctor')
const { ApiAgent } = requireBuilt('agents/api-agent')
const { createSmartAdd } = requireBuilt('setup/smart-add')
// 层的顺序与名称只在 src/shared/diagnostics.ts 定义一次，CLI 引用而不是抄一份
const { LAYER_ORDER, LAYER_LABEL } = requireBuilt('../shared/diagnostics')

const MARK = { pass: ' ok ', warn: 'warn', fail: 'FAIL', skip: ' ---' }

const ROLES_OUT = ['input', 'send', 'stop', 'stream', 'generating']

function printWebPlan(plan, out) {
  out(
    `来源 = ${plan.source}${plan.assistant ? `（助手：${plan.assistant.displayName}）` : '（无助手，规则降级）'}` +
      `｜回修轮次 = ${plan.rounds}\n` +
      `名称 = ${plan.name}\n入口 = ${plan.entry}\n登录 = ${plan.login.state} — ${plan.login.reason}\n` +
      `形态 = ${plan.input_kind} / 发送 ${plan.send_mode} / 读取 ${plan.stream_mode} / 完成 ${plan.completion_mode}(${plan.stable_ms}ms)\n\n`,
  )
  out('选择器（命中数来自真实页面，0 命中即 fail）\n')
  for (const role of ROLES_OUT) {
    const sel = plan.selectors[role] || '（留空）'
    const c = plan.checks[role]
    const conf = plan.confidence[role]
    const hit = c ? `${c.level} 命中 ${c.matches}` : '未校验'
    out(`  ${role.padEnd(11)} ${sel}\n              ${hit}${conf != null ? ` 置信 ${Math.round(conf * 100)}%` : ''}${c?.note ? ` ${c.note}` : ''}\n`)
    if (plan.why[role]) out(`              依据：${plan.why[role]}\n`)
  }
  out(`\n总置信 = ${plan.confidence.overall != null ? Math.round(plan.confidence.overall * 100) + '%' : '—'}\n`)
  if (plan.why.overall) out(`  ${plan.why.overall}\n`)
  if (plan.risks.length > 0) {
    out('\n风险\n')
    plan.risks.forEach((r) => out(`  - ${r}\n`))
  }
  if (plan.questions.length > 0) {
    out('\n待澄清（UI 里是卡片；命令行用 --answer id=值 复现）\n')
    for (const q of plan.questions) {
      out(`  ? ${q.prompt}\n    target=${q.target}  可选：${q.options.map((o) => `${o.value}${o.label ? `(${o.label})` : ''}`).join(' | ')}\n`)
    }
  }
}

/** 与设置页「创建模型」按钮同一判定：input 与 stream 都必须非空且未在页面上判死 */
function finishVerdict(plan, out) {
  const bad = ['input', 'stream'].filter((r) => !plan.selectors[r] || plan.checks[r]?.level === 'fail')
  out(
    `\n结论：${bad.length === 0 ? '可创建（输入框与回复容器都在真实页面命中）' : `不可创建：${bad.join('、')} 未确认`}\n`,
  )
  out('提示：命令行只演练不落地；要真的建模型，请在设置页「智能添加」向导里点创建。\n')
  return bad.length === 0
}

/**
 * 智能添加的离线演练：跑真实的「开页 → 快照 → 助手推断 → 逐条回页面校验」。
 *
 * 与设置页向导共用同一个 createSmartAdd，所以这里能出可用配置 = UI 能出。
 * 严格只读：不创建模型、不写适配器、不发任何计费请求（API 侧只 GET /models）。
 */
async function runSmartAdd({ models, pool, secrets }, out) {
  const keyed = models.filter((m) => m.transport === 'api' && m.api && secrets.has(m.api.apiKeyRef))
  const assistantId = flags.assistant ?? keyed[0]?.id ?? null
  if (flags.assistant && !keyed.some((m) => m.id === flags.assistant)) {
    out(`配置助手 ${flags.assistant} 不可用：要么不是 API 模型，要么钥匙串里没有它的 Key。\n可用：${keyed.map((m) => m.id).join(', ') || '（无）'}\n`)
    return 2
  }

  const cache = new Map()
  const getAgent = (id) => {
    if (cache.has(id)) return cache.get(id)
    const cfg = models.find((m) => m.id === id)
    if (!cfg?.api || !secrets.has(cfg.api.apiKeyRef)) return undefined
    const a = new ApiAgent(cfg.id, cfg.displayName, cfg.color ?? '#536dfe', cfg.api, (ref) => secrets.get(ref))
    cache.set(id, a)
    return a
  }

  const smart = createSmartAdd({
    pool: () => pool,
    getAgent,
    models: () => models,
    resolveKey: (ref) => secrets.get(ref),
    emit: (s) => out(`  · [${s.stage}] ${s.text}\n`),
    log: (e) =>
      diag.log({
        ts: Date.now(),
        layer: 'runtime',
        stage: e.stage,
        subject: e.subject ?? 'doctor:smart',
        ok: e.ok,
        detail: e.detail,
      }),
  })

  out(`配置助手 = ${assistantId ?? '（无，走规则降级）'}\n\n`)

  try {
    if (flags.smartApi) {
      out(`嗅探 API 端点：${flags.smartApi}（只读 GET /models，不计费）\n\n`)
      const probe = await smart.probeApi({ address: flags.smartApi, apiKey: process.env.TORRA_SMART_KEY || undefined })
      for (const a of probe.attempts) {
        out(`  [${a.ok ? ' ok ' : 'fail'}] ${a.protocol.padEnd(9)} ${a.base}  ${a.status ?? '—'}  模型 ${a.modelCount}${a.error ? `  ${a.error}` : ''}\n`)
      }
      if (probe.ok) {
        out(`\n可用端点 = ${probe.baseUrl}（${probe.protocol}），模型 ${probe.models?.length ?? 0} 个\n`)
        out(`  前 12 个：${(probe.models ?? []).slice(0, 12).join(', ')}\n`)
      } else {
        out(`\n未能确认：${probe.reason ?? ''}${probe.needsKey ? '（需要补 Key）' : ''}\n`)
      }
      return probe.ok ? 0 : 1
    }

    out(`识别网页站点：${flags.smart}\n\n`)
    const res = await smart.planWeb({ entry: flags.smart, assistantModelId: assistantId ?? undefined })
    if (!res.ok || !res.plan) {
      out(`\n识别失败：${res.reason ?? '未知原因'}\n`)
      return 1
    }
    out('\n')
    printWebPlan(res.plan, out)
    if (Object.keys(flags.answers).length === 0) {
      const usable = finishVerdict(res.plan, out)
      return usable ? 0 : 1
    }

    // 澄清回答走 refineWeb —— 和设置页卡片「用这些回答更新方案」完全同一条路
    out(`\n套用澄清回答：${JSON.stringify(flags.answers)}\n`)
    const refined = await smart.refineWeb(res.plan.planId, flags.answers)
    if (!refined.ok || !refined.plan) {
      out(`套用失败：${refined.reason ?? '未知原因'}\n`)
      return 1
    }
    out('\n—— 回答之后 ——\n')
    printWebPlan(refined.plan, out)
    return finishVerdict(refined.plan, out) ? 0 : 1
  } finally {
    smart.closeScanWindow()
  }
}

app.whenReady().then(async () => {
  const rootDir = path.join(app.getPath('userData'), 'torra')
  const snapshot = path.join(rootDir, 'models.snapshot.json')

  const live = detectLiveInstance()
  if (live.length > 0 && !argv.includes('--force')) {
    process.stderr.write(
      '检测到 Torra 正在运行，分区数据库由它持有。此时离线体检读到的登录态与页面状态无效。\n' +
        '  · 直接用设置页里的「链路体检」（同进程，无争用）；或\n' +
        '  · 退出 Torra 后重跑；确实要强行离线跑就加 --force\n',
    )
    app.exit(3)
  }

  if (!fs.existsSync(snapshot)) {
    process.stderr.write(
      `找不到生效模型清单：${snapshot}\n` +
        '该清单由 Torra 启动时写出。请先启动一次 Torra（npm run dev）再退出，然后重跑本命令。\n',
    )
    app.exit(2)
  }

  const models = JSON.parse(fs.readFileSync(snapshot, 'utf8'))
  const registry = new AdapterRegistry(path.join(ROOT, 'adapters'), path.join(rootDir, 'adapters'))
  await registry.loadAll()
  const pool = new WebviewPool()
  const store = new FileSessionStore(path.join(rootDir, 'sessions'))
  await store.init()
  const secrets = new KeychainSecretStore(path.join(rootDir, 'keys'))

  await diag.init(rootDir)

  if (flags.smart || flags.smartApi) {
    const code = await runSmartAdd({ models, pool, secrets }, (s) => process.stdout.write(String(s)))
    process.stdout.write(`\nuserData = ${app.getPath('userData')}\n`)
    await diag.flush()
    pool.disposeAll()
    app.exit(code)
    // app.exit 是异步生效的，不 return 会继续往下跑完整体检
    return
  }

  const prefsFile = path.join(rootDir, 'preferences.json')
  let moderatorId = null
  try {
    moderatorId = JSON.parse(fs.readFileSync(prefsFile, 'utf8')).moderatorId ?? null
  } catch {
    /* 无偏好文件即无主持 */
  }

  process.stdout.write(`userData = ${app.getPath('userData')}\nmodels   = ${models.length}\n\n`)

  const scopeNote = live.length > 0 ? '（--force：另一进程正持有分区，登录相关结论不可采信）' : ''

  const report = await runDoctor(
    {
      pool,
      registry,
      models: () => models,
      secrets,
      store,
      moderatorId: () => moderatorId,
      rootDir,
    },
    {
      modelId: flags.modelId ?? undefined,
      probeApi: flags.ping,
      // 登录层据此把「未登录」降级为「不可判定」：争用时读到的是随机结果，
      // 报成 fail 只会把用户推去重登一个根本没掉线的账号
      contended: live.length > 0,
    },
  )

  LAYER_ORDER.forEach((layer, i) => {
    const items = report.checks.filter((c) => c.layer === layer)
    if (items.length === 0) return
    process.stdout.write(`\n[${i + 1}/${LAYER_ORDER.length}] ${LAYER_LABEL[layer] ?? layer}\n`)
    for (const c of items) {
      process.stdout.write(`  [${MARK[c.status]}] ${c.title}${c.subject ? ` (${c.subject})` : ''}\n`)
      if (process.env.DIAG_VERBOSE === '1' || c.status === 'fail' || c.status === 'warn') {
        for (const e of c.evidence) process.stdout.write(`         ${e}\n`)
      }
      if (c.fix) process.stdout.write(`         修复: ${c.fix}\n`)
      if (c.suggestion) process.stdout.write(`         建议: ${c.suggestion}\n`)
    }
  })

  const s = report.summary
  if (scopeNote) report.scope = `${models.length} models ${scopeNote}`
  process.stdout.write(
    `\n结论：通过 ${s.pass} / 提醒 ${s.warn} / 失败 ${s.fail} / 跳过 ${s.skip}` +
      `${report.blockingLayer ? `，最先阻断在 ${report.blockingLayer}` : ''}\n`,
  )

  await persistReport(report, rootDir)
  await persistReport(report, path.join(ROOT, 'docs'))
  await diag.flush()
  pool.disposeAll()

  process.stdout.write(`报告：${report.files?.md}\n`)
  app.exit(s.fail > 0 ? 1 : 0)
})
