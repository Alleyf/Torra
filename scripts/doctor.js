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
 *   带值的开关一律写成 --名=值：URL 用空格分隔时会被 Chromium 吃掉，进程不启动。
 *   npm run doctor -- --smart=https://yuanbao.tencent.com/                  # 识别网页站点，打印方案与逐条命中数
 *   npm run doctor -- --smart=<url> --answer page-input=xxx                 # 把澄清回答喂给 refineWeb（同 UI 那条路）
 *   npm run doctor -- --smart=<url> --drive 你好                             # 识别后代发一条消息（同 torra_send_site_message），等回复再重识别
 *     --drive 会在你的账号下产生一条真实对话，只在显式给出时才做；值留空则用「你好」
 *   npm run doctor -- --smart=<url> --drive --live                           # 再往前一步：用这套配置真跑一轮 WebviewAgent 发言
 *     --live 会在你的账号下再生成一次回答（值留空用「用一句话介绍你自己」）；spec 与「直接创建」同一份映射，
 *     所以这一步通过 = 建出来的模型在 app 里能说话。页内合成回车被站点忽略时，靠的是 agent 侧浏览器级补刀。
 *   npm run doctor -- --smart=<url> --look                                    # 打印扫描窗口当下的页面实况（识别用的同一套判据）
 *     --look 可带一个 png 路径顺便存截图；--drive 无论成败都会看一眼，失败时自动存 doctor-look.png
 *   npm run doctor -- --smart-api=https://api.example.com/v1                  # 嗅探 API 端点（只 GET /models）
 *   可选 --assistant <apiModelId>；端点需要 Key 时用环境变量 TORRA_SMART_KEY 传入（不走命令行，避免留在历史里）
 *
 *   --data <dir>  用隔离的 userData 跑：Torra 正在运行时分区归它持有，直接跑读到的是假现场。
 *     把要用的分区克隆进 <dir>/Partitions/…（用完必删，里面是真实 cookie），就能不退出实例做真机验证。
 */

const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist', 'main')

app.setName('torra')

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  if (i !== -1) {
    const v = argv[i + 1]
    // 值缺失（写在行尾或后面紧跟别的开关）时回空串，由调用方决定默认值：
    // --drive 就靠这条用默认文本「你好」，避免中文参数经过 shell 代码页被搞坏
    if (v === undefined || v.startsWith('--')) return ''
    return v
  }
  /*
   * --name=value 写法。URL 只能用这一种：空格写法里「https://…」会被
   * Chromium 当成自己的开关吃掉，主进程压根没起来就退出 —— 实测 45ms、
   * stdout 一个字节都没有，看上去像「体检工具坏了」，其实是命令行没跑到 JS。
   */
  const eq = argv.findIndex((a) => a.startsWith(`--${name}=`))
  if (eq === -1) return null
  return argv[eq].slice(name.length + 3)
}
// 隔离 userData 必须在读任何路径之前生效，所以这里不调用 getPath('userData') 之外的默认值
const isolatedData = arg('data')
app.setPath('userData', isolatedData ? path.resolve(isolatedData) : path.join(app.getPath('appData'), 'torra'))
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
  /** null = 没给 --drive（只识别不碰页面）；字符串 = 代发的内容（空串按「你好」） */
  drive: arg('drive'),
  /** null = 不做真机发言；字符串 = 真机提示词（空串按默认那句）。值给 --live 用 */
  live: arg('live'),
  /** 把扫描窗口当下的页面事实打出来（给值顺便存一张截图）。--drive 时总会看一眼 */
  look: argv.includes('--look') ? arg('look') || 'doctor-look.png' : null,
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
const { createSmartAdd, PICKER_PARTITION } = requireBuilt('setup/smart-add')
// 层的顺序与名称只在 src/shared/diagnostics.ts 定义一次，CLI 引用而不是抄一份
const { LAYER_ORDER, LAYER_LABEL } = requireBuilt('../shared/diagnostics')

const MARK = { pass: ' ok ', warn: 'warn', fail: 'FAIL', skip: ' ---' }

/*
 * 体检工具自己崩了却一声不响，比没有体检更糟：--smart + --data 出现过一次
 * 「45ms 退出、stdout 一个字节都没有」的情况，看不出是配置错、页面错还是代码错。
 * 崩溃一律同时写 stderr 和 doctor-crash.log（同步写，app.exit 不丢缓冲）。
 */
function crash(where, e) {
  const msg = `\n[doctor 崩溃] ${where}：${(e && (e.stack || e.message)) || String(e)}\n`
  try {
    fs.writeSync(2, msg)
  } catch {
    /* stderr 也可能不可用，下面还有文件兜底 */
  }
  try {
    fs.appendFileSync(path.join(ROOT, 'doctor-crash.log'), `${new Date().toISOString()} ${msg}`)
  } catch {
    /* 写不了文件就只剩 stderr */
  }
  app.exit(70)
}
process.on('unhandledRejection', (e) => crash('unhandledRejection', e))
process.on('uncaughtException', (e) => crash('uncaughtException', e))

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

/**
 * 真机排查：把扫描窗口当下的页面事实打出来，可选存一张截图。
 *
 * 为什么必须有：「站点到底回没回」不能靠猜。猜错一次 = 90 秒白等 + 一轮改错的代码。
 * 读页面用的就是识别链那份注入脚本（PICKER_SCRIPT），所以这里看到的判据和真实识别完全一致。
 * 截图走 CDP：capturePage 在动画期/离屏常给空帧。
 */
async function lookAtPage(out, shotTo) {
  try {
    const { BrowserWindow } = require('electron')
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && /^https?:/.test(x.webContents.getURL()))
    if (!w) {
      out('（没有可看的页面窗口）\n')
      return
    }
    const wc = w.webContents
    await wc.executeJavaScript(requireBuilt('webview/picker').PICKER_SCRIPT, true).catch(() => undefined)
    const facts = await wc.executeJavaScript(
      `(function(){
        var p = window.__torraPicker;
        var o = p.outline();
        var s = p.scan();
        return {
          url: location.href,
          title: document.title,
          reply: p.reply(''),
          blocks: (s.stream || []).slice(0, 6).map(function (b) {
            return { sel: b.chosen, hits: (b.candidates || []).map(function (c) { return c.selector + '=' + c.matches }).slice(0, 3), text: (b.text || '').slice(0, 40) };
          }),
          lists: (o.lists || []).slice(0, 4).map(function (l) { return { sel: l.sel, child: l.childSel, kids: l.kids, same: l.same, len: l.textLen } }),
          input: (s.input || []).slice(0, 3).map(function (i) { return i.chosen }),
          buttons: (s.send || []).slice(0, 8).map(function (i) { return (i.text || i.role || '') + ':' + i.chosen }),
          body: (document.body.innerText || '').slice(0, 200)
        };
      })()`,
      true,
    )
    out(`\n—— 页面实况 ——\n${JSON.stringify(facts, null, 1)}\n`)
    if (!shotTo) return
    const file = path.resolve(shotTo)
    try {
      wc.debugger.attach('1.3')
      const res = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(file, Buffer.from(res.data, 'base64'))
      wc.debugger.detach()
      out(`截图：${file}\n`)
    } catch (e) {
      out(`截图失败：${e.message}（不影响上面的页面实况）\n`)
    }
  } catch (e) {
    // 排查工具自己出问题时，绝不能把主结论一起吞掉
    out(`读取页面实况失败：${e.message}\n`)
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
 * 真机跑一轮发言：直接构造 WebviewAgent 并调用它的 send()。
 *
 * 为什么这一步不能省：识别与代发只证明「选择器在真实页面上命中」，
 * 不证明运行时那套（键入 → 发送 → 等生成 → 读回复 → 完成判定）跑通。
 * 网页通道的回车是页内合成事件，Quill 一类编辑器（元宝）会把不可信按键整条忽略，
 * 只有 agent 侧的浏览器级补刀能救回来 —— 那段代码不在这里跑一次就等于没验。
 *
 * spec 走 setup/web-spec.ts，与设置页「直接创建」、助手的 torra_create_web_model
 * 同一份映射，所以这里通过 = app 里建的模型能发言。分区复用扫描窗口那个，
 * 换新区就是空分区、没登录，测出来的只有「未登录」而不是链路。
 */
async function runLiveTurn(plan, out, pool) {
  const { webModelInputFromPlan, webSpecFromPlan } = requireBuilt('setup/web-spec')
  const { WebviewAgent } = requireBuilt('agents/webview-agent')
  const spec = webSpecFromPlan('web-doctor-live', webModelInputFromPlan(plan))
  const rt = { spec, health: 'ok', lastCheckedAt: Date.now() }
  const text = flags.live || '用一句话介绍你自己'

  out(`\n—— 真机跑一轮发言（WebviewAgent.send，与创建模型同一份 spec）——\n`)
  out(`  发送 ${spec.send_mode}｜完成 ${spec.completion.mode}(${spec.completion.stable_ms ?? '—'}ms)｜读取 ${spec.stream_mode}\n`)
  out(`  提示词「${text}」，站点会真的生成一条回复\n`)

  pool.ensure(spec.id, rt, PICKER_PARTITION)
  // 冷启动的 SPA 常常 20s 内还没挂载完，默认超时会让真机一步误判为失败
  if (!(await pool.waitReady(spec.id, 45000))) {
    out('  页面未就绪，真机发言没跑成\n')
    return 1
  }
  const agent = new WebviewAgent(spec.id, plan.name, '#8a7cff', pool, rt, PICKER_PARTITION)
  const t0 = Date.now()
  let printed = 0
  let code = 0
  try {
    const res = await agent.send(
      {
        sessionId: 'doctor-live',
        round: 1,
        topic: null,
        digest: null,
        callout: null,
        maxLenChars: 400,
        chat: { history: [{ role: 'user', content: text }] },
      },
      (chunk) => {
        if (printed < 240) {
          out(chunk)
          printed += chunk.length
        }
      },
    )
    out(
      `\n  ok 拿到回复 ${res.content.length} 字，耗时 ${Math.round((Date.now() - t0) / 1000)}s` +
        `（思考 ${res.thinking ? res.thinking.length : 0} 字／步骤 ${res.steps ? res.steps.length : 0} 字）\n`,
    )
  } catch (e) {
    code = 1
    out(`\n  失败（${e?.name ?? 'Error'}）：${e?.message ?? e}\n`)
    out('  对照：reason 含 generation did not start = 站点没接住这次发送；read-empty = 回复容器指错元素；\n' +
        '        timeout = 完成判定等不到结束；login-required = 分区里没有可用登录态。\n')
  }

  // 把这一轮真正发生了什么打出来：补刀有没有触发全靠这两行 stage
  const evs = diag.tail(400, { subject: spec.id }).filter((v) => ['send', 'send-native', 'read-empty', 'settle', 'wait-timeout'].includes(v.stage))
  if (evs.length > 0) {
    out('\n  运行时时序\n')
    for (const v of evs) out(`    ${v.stage.padEnd(13)} ${v.ok ? 'ok  ' : 'FAIL'} ${v.ms ?? '—'}ms  ${v.detail ?? ''}\n`)
  }
  agent.dispose()
  pool.disposeEntry(spec.id)
  return code
}

/**
 * 智能添加的离线演练：跑真实的「开页 → 快照 → 助手推断 → 逐条回页面校验」。
 *
 * 与设置页向导共用同一个 createSmartAdd，所以这里能出可用配置 = UI 能出。
 * 默认严格只读：不创建模型、不写适配器、不发任何计费请求（API 侧只 GET /models）。
 * 唯一例外是显式 --drive：它和助手的 torra_send_site_message 走同一个 driveWeb，
 * 会在你的账号下真发一条消息 —— 所以命令行不做默认动作，也不会有人误触。
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
    // 命令行没有界面可挂横幅，窗口状态直接打到 stdout
    onScanWindow: (st) => out(st.open ? `  · [window] 识别窗口已打开 ${st.entry ?? ''}\n` : '  · [window] 识别窗口已关闭\n'),
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
    const first = await smart.planWeb({ entry: flags.smart, assistantModelId: assistantId ?? undefined })
    if (!first.ok || !first.plan) {
      out(`\n识别失败：${first.reason ?? '未知原因'}\n`)
      return 1
    }
    out('\n')
    printWebPlan(first.plan, out)
    let current = first

    if (Object.keys(flags.answers).length > 0) {
      // 澄清回答走 refineWeb —— 和设置页卡片「用这些回答更新方案」完全同一条路
      out(`\n套用澄清回答：${JSON.stringify(flags.answers)}\n`)
      const refined = await smart.refineWeb(first.plan.planId, flags.answers)
      if (!refined.ok || !refined.plan) {
        out(`套用失败：${refined.reason ?? '未知原因'}\n`)
        return 1
      }
      out('\n—— 回答之后 ——\n')
      printWebPlan(refined.plan, out)
      current = refined
    }

    if (flags.drive !== null) {
      const text = flags.drive || '你好'
      out(`\n—— 代发消息「${text}」并重新识别（同助手工具 torra_send_site_message）——\n`)
      const driven = await smart.driveWeb(current.plan.planId, { text })
      // 先把主结论打出来：页面实况是附属证据，它出问题时不能把结论一起吞掉
      if (!driven.ok || !driven.plan) {
        out(`\n代发/重识别失败：${driven.reason ?? '未知原因'}\n`)
        await lookAtPage(out, flags.look || 'doctor-look.png')
        return 1
      }
      out('\n—— 页面上有回复之后 ——\n')
      printWebPlan(driven.plan, out)
      const ok = finishVerdict(driven.plan, out)
      await lookAtPage(out, flags.look)
      if (ok) {
        out(`可直接创建的这套配置（设置页/助手建模型用的就是它）：${JSON.stringify({
          entry: driven.plan.entry,
          selectors: driven.plan.selectors,
          input_kind: driven.plan.input_kind,
          send_mode: driven.plan.send_mode,
          stream_mode: driven.plan.stream_mode,
          completion_mode: driven.plan.completion_mode,
          stable_ms: driven.plan.stable_ms,
        })}\n`)
      }
      if (!ok) return 1
      // --live：拿这套刚认出来的配置真跑一轮发言。必须有回复在页面上才有 stream 选择器，
      // 所以只在 --drive 之后跑，识别阶段单独跑不出可用的 spec。
      if (flags.live !== null) return await runLiveTurn(driven.plan, out, pool)
      return 0
    }

    if (flags.live !== null) {
      out('\n--live 需要配合 --drive：回复容器要先把 AI 的回答逼出来才认得出，光识别没得跑。\n')
      return 1
    }

    if (flags.look) await lookAtPage(out, flags.look)
    return finishVerdict(current.plan, out) ? 0 : 1
  } finally {
    smart.closeScanWindow()
  }
}

app.whenReady().then(async () => {
  const rootDir = path.join(app.getPath('userData'), 'torra')
  const snapshot = path.join(rootDir, 'models.snapshot.json')

  const live = detectLiveInstance()
  // --data 时不拦：分区本来就在克隆出来的隔离目录里，正主实例碰不到它
  if (live.length > 0 && !argv.includes('--force') && !isolatedData) {
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
    // 走 fd1 同步写：app.exit 是立刻生效的，异步管道里还没刷出去的报告会被整段丢掉
    const code = await runSmartAdd({ models, pool, secrets }, (s) => fs.writeSync(1, String(s)))
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
