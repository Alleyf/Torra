/**
 * 会话持久化不变量（对应「登录后还要反复登录」的修复）
 *
 * 这些规则都属于「不写测试就会被改坏」的类型：
 * 违反时代码照常编译、照常启动，只是登录悄悄失效，用户无从察觉。
 *
 * 运行：npm run test:session
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LAYER_LABEL, LAYER_ORDER } from '../src/shared/diagnostics'
import { DEFAULT_THEME_MODE, THEME_MODES, isThemeMode, resolveTheme } from '../src/shared/theme'

let pass = 0
let fail = 0

function it(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn()
    if (r instanceof Promise) {
      throw new Error('此用例须同步编写')
    }
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

const ROOT = path.resolve(__dirname, '..')

/**
 * 用源码静态断言守护结构性规则。
 * 不用运行时依赖：这些规则跨进程（主进程 ↔ 池 ↔ 登录窗口），
 * 纯单元测试搭不起来，而静态检查已足以覆盖真正会出错的改动形态
 * （例如某处又漏传 partition）。
 */
function readSrc(rel: string): Promise<string> {
  return fs.readFile(path.join(ROOT, rel), 'utf8')
}

async function main(): Promise<void> {
  const pool = await readSrc('src/main/webview/pool.ts')
  const main = await readSrc('src/main/index.ts')
  const preload = await readSrc('src/preload/index.ts')
  const rail = await readSrc('src/renderer/components/ModelRail.tsx')
  const app = await readSrc('src/renderer/App.tsx')
  const storeSrc = await readSrc('src/renderer/store.ts')
  const cssSrc = await readSrc('src/renderer/styles.css')
  const newSession = await readSrc('src/renderer/components/NewSession.tsx')
  const doctor = await readSrc('src/main/diagnostics/doctor.ts')
  const diagShared = await readSrc('src/shared/diagnostics.ts')
  const doctorCli = await readSrc('scripts/doctor.js')
  const panel = await readSrc('src/renderer/components/DiagnosticsPanel.tsx')
  const settings = await readSrc('src/renderer/components/SettingsPage.tsx')
  const themeUi = await readSrc('src/renderer/theme.ts')

  console.log('\n=== 分区持久化（cookie 落盘的前提）===')

  it('ensure 不再自行推导分区，改用调用方声明值', () => {
    // 若这里退回 `persist:torra-${modelId}` 单一来源，用户自建模型
    // （声明 persist:torra-user-<id>）的登录窗口与后台实例就会落到两个分区。
    assert.match(pool, /partitionOf\(modelId: string, declared\?: string\)/)
    assert.match(pool, /return declared \?\? `persist:torra-\$\{modelId\}`/)
  })

  it('WebContentsView 用解析后的分区，而非 modelId 推导值', () => {
    assert.match(pool, /partition: part,/)
    assert.doesNotMatch(pool, /webPreferences:\s*\{\s*\n\s*partition,\s*\n/)
  })

  it('分区名一律带 persist: 前缀', () => {
    // Electron 33 的 fromPartition 不接受 persist 选项，只有 "persist:" 命名约定
    const derived = pool.match(/`persist:torra-\$\{modelId\}`/)
    assert.ok(derived, '未找到 persist: 前缀的分区推导')
    assert.doesNotMatch(pool, /`torra-\$\{modelId\}`/)
  })

  console.log('\n=== DeepSeek 会话预热 ===')

  it('识别 DeepSeek 的 ds_session_id 会话 Cookie', () => {
    // DeepSeek 不使用通用 access_token 命名；漏识别会让启动预热跳过
    // 已登录实例，首轮体检/发言就会落到未初始化路径。
    assert.match(pool, /\^ds_session_id\$\//)
  })

  it('排除 CSRF 与匿名 SSO Cookie，避免游客页被判已登录', () => {
    assert.match(pool, /passport_csrf/)
    assert.match(pool, /bd_sso/)
  })

  console.log('\n=== 登录窗口与后台实例必须同分区 ===')

  it('openLoginWindow 接受 partition 参数', () => {
    assert.match(pool, /openLoginWindow\([\s\S]*?options\?: \{ partition\?: string/)
  })

  it('openLoginWindow 把分区写进 webPreferences', () => {
    const seg = pool.slice(
      pool.indexOf('openLoginWindow'),
      pool.indexOf('openLoginWindow') + 900,
    )
    assert.match(seg, /partition: part,/)
  })

  it('login:open 把分区传给 ensure（内嵌后无独立窗口）', () => {
    // 统一内嵌后 login:open 与 present 合流，但仍必须显式传分区：
    // 漏传会让实例落到按 modelId 推导的分区，与用户此前登录的那份不一致。
    const i = main.indexOf("ipcMain.handle('login:open'")
    const seg = main.slice(i, main.indexOf("ipcMain.handle(", i + 40))
    assert.match(seg, /pool\.ensure\(modelId, rt, cfg\.partition\)/)
  })

  it('所有 pool.ensure 调用点都传了分区', () => {
    const calls = [...main.matchAll(/pool\.ensure\(([^)]*)\)/g)].map((m) => m[1]!)
    assert.ok(calls.length >= 6, `调用点偏少：${calls.length}`)
    const missing = calls.filter((a) => !a.includes('partition'))
    assert.equal(missing.length, 0, `以下调用未传分区：${missing.join(' | ')}`)
  })

  console.log('\n=== 登录后必须刷新后台实例 ===')

  it('登录窗口关闭触发后台实例重载', () => {
    // 不刷新的话：登录窗口写入了 cookie，但后台实例仍停在登录前
    // 加载的那份文档上，站点不会自行重渲染 —— 表现为「反复要求登录」。
    assert.match(pool, /onClosed\?: \(\) => void/)
    assert.match(pool, /login\.once\('closed', options\.onClosed\)/)
  })

  it('提供 reloadEntry 且走 loadURL 重新导航', () => {
    assert.match(pool, /reloadEntry\(modelId: string\): void/)
    assert.match(pool, /void e\.view\.webContents\.loadURL\(e\.adapter\.spec\.entry\)/)
  })

  it('提供 waitReady 等待页面就绪，避免刷新后立刻探测误判', () => {
    assert.match(pool, /waitReady\(modelId: string/)
    assert.match(pool, /did-finish-load/)
  })

  it('登录态变化会复核并通知渲染层', () => {
    // 内嵌后没有「关闭窗口」这个终点，改为导航变化即复检（watchLogin），
    // 状态一变就更新状态灯 —— 免得用户登录完还要手动确认。
    const i = main.indexOf('function attachLoginWatcher')
    assert.ok(i > 0, '缺少 attachLoginWatcher')
    const body = main.slice(i, main.indexOf("ipcMain.handle('webview:present'", i))
    assert.match(body, /pool\.watchLogin\(modelId/)
    // 委托 syncModelState 统一处理，它负责通知 UI 与更新健康度
    assert.match(body, /syncModelState\(m, \{ notify: true \}\)/)
    // syncModelState 内部必须发出通知并更新健康度
    const j = main.indexOf('async function syncModelState')
    const sb = main.slice(j, main.indexOf('function startLoginWatchdog', j))
    assert.match(sb, /send\('login:result'/, '未通知渲染层')
    assert.match(sb, /registry\.setHealth\(/, '未更新适配器健康状态')
    assert.match(sb, /send\('models:changed'/, '未触发 UI 刷新')
  })

  console.log('\n=== 登录态可诊断 ===')

  it('提供 login:diagnose，直接回答 cookie 存没存', () => {
    assert.match(main, /ipcMain\.handle\('login:diagnose'/)
    assert.match(main, /ses\.cookies\.get/)
  })

  it('诊断不回传 cookie 值，只报域名与名称', () => {
    // 凭据外泄是不可逆事故，诊断功能更不该成为泄露通道
    const seg = main.slice(main.indexOf("ipcMain.handle('login:diagnose'"))
    const body = seg.slice(0, 1400)
    assert.doesNotMatch(body, /\.value\b/)
    assert.match(body, /c\.name/)
    assert.match(body, /c\.domain/)
  })

  it('诊断同时查 localStorage —— 部分站点不把登录态放 cookie', () => {
    // DeepSeek / Kimi 把凭据放在 localStorage，只查 cookie 会误判为未登录
    assert.match(main, /localStorage/)
    assert.match(main, /sessionStorage/)
  })

  it('诊断能区分「没存」与「存了但没生效」', () => {
    const seg = main.slice(main.indexOf("ipcMain.handle('login:diagnose'"))
    const body = seg.slice(0, 2600)
    assert.match(body, /verdict:/)
    // 「分区为空」与「有 cookie 但页面不接受」必须给出不同结论 ——
    // 前者要重新登录，后者是站点换了凭据机制，修复方向完全相反
    assert.match(body, /分区为空/)
    assert.match(body, /页面未接受/)
  })

  it('暴露分区不一致告警', () => {
    assert.match(main, /partitionMismatch/)
  })

  console.log('\n=== 登录态判定必须可靠 ===')

  it('提供 inspectLogin 专用判定', () => {
    // 实测：Kimi 未登录时同样渲染出 div.chat-input-editor，
    // 用 health_probe 判定登录会得到假阳性，反复登录变成无解循环。
    assert.match(pool, /async inspectLogin\(modelId: string\)/)
  })

  it('登录页 URL 作为决定性证据', () => {
    assert.match(pool, /sign_\?in\|sign_\?up\|login\|register/)
  })

  it('读取 localStorage 判断用户态', () => {
    // DeepSeek / Kimi 均把凭据放在 localStorage，不读它必然误判
    assert.match(pool, /localStorage/)
    assert.match(pool, /sessionStorage/)
  })

  it('存储 API 异常时仍使用聊天输入区判定', () => {
    // localStorage 在导航中或某些受限 origin 下可能抛 SecurityError；
    // 不能因此把已经可输入的 DeepSeek 页面报成“尚未就绪”。
    assert.match(pool, /storageReadable/)
    assert.match(pool, /页面存储暂不可读，不能确认登录态/)
    assert.match(pool, /DOM-only attempt/) 
  })

  it('判不出时返回 unknown 而非瞎猜', () => {
    // 宁可说「不确定」也不要谎报「已登录」——后者会让用户反复登录
    assert.match(pool, /state: 'unknown'/)
  })

  it('登录态判定一律走 inspectLogin，绝不用 healthCheck 代替', () => {
    // inspectLogin 是唯一可信的登录判据；healthCheck 只回答
    // 「输入框在不在」，用它判登录会得到假阳性。
    assert.match(pool, /this\.inspectLogin\(modelId\)/)
    assert.match(pool, /async inspectLogin\(modelId: string\)/)
    // watchLogin 里不得混入 healthCheck
    const i = pool.indexOf('watchLogin(')
    const body = pool.slice(i, pool.indexOf('重新加载后台实例', i))
    assert.doesNotMatch(body, /healthCheck/)
  })

  it('诊断与刷新均用 inspectLogin', () => {
    assert.match(main, /pool\.inspectLogin/)
    assert.match(main, /loginState: st\.state/)
  })

  it('提示语点明「输入框存在不等于已登录」', () => {
    assert.match(main, /输入框存在不等于已登录/)
  })

  console.log('\n=== 打开方式统一为内嵌 ===')

  it('点击头像一律内嵌，不按状态分叉', () => {
    // 此前按 blocked 状态分叉：需登录弹独立窗口、否则内嵌。
    // 同一模型因状态不同而行为不同，用户得记两套操作。
    assert.doesNotMatch(rail, /onOpenLogin/)
    assert.match(rail, /onClick=\{\(\) => onSelectBroadcast\(m\.id\)\}/)
  })

  it('登录与查看走同一个 IPC', () => {
    // login:open 内部改为 present，不再弹窗
    const i = main.indexOf("ipcMain.handle('login:open'")
    const body = main.slice(i, main.indexOf("ipcMain.handle(", i + 40))
    assert.doesNotMatch(body, /openLoginWindow/)
    assert.match(body, /pool\.present\(modelId\)/)
  })

  it('视图模式只保留 hall 与 broadcast', () => {
    // takeover 已合并：内嵌页面本就可直接交互，再切模式只会让
    // 「登录在哪做」变得含糊
    const store = storeSrc
    assert.match(store, /export type ViewMode = 'hall' \| 'broadcast'/)
    assert.doesNotMatch(store, /ViewMode = 'hall' \| 'broadcast' \| 'takeover'/)
    assert.doesNotMatch(app, /viewMode === 'takeover'/)
  })

  it('标签文案改为「网页视图」', () => {
    assert.match(app, /网页视图/)
  })

  it('内嵌视图提供登录完成的出口', () => {
    // 没有关闭窗口这个终点了，必须给出明确的「我做完了」按钮
    assert.match(app, /我已登录完成，复核状态/)
    assert.match(app, /refreshLogin/)
  })

  it('提示条不与 WebView 区域重叠', () => {
    // WebContentsView 是原生子视图，永远盖在渲染层之上。
    // 提示条必须独立占行，且高度与 presentBounds 的 BOTTOM 对齐。
    const css = cssSrc
    assert.match(css, /\.broadcast-hint\s*\{/)
    assert.match(css, /flex: 0 0 44px/)
    assert.match(pool, /const BOTTOM = 44/)
    assert.match(pool, /const TOP = 56 \+ 36/)
  })

  it('登录态自动检测：导航变化即复检', () => {
    assert.match(pool, /watchLogin\(modelId: string/)
    assert.match(pool, /did-navigate-in-page/)
    // 登录常伴随多次跳转，需延迟判定以避开中间态
    assert.match(pool, /2500/)
  })

  it('绑定登录观察器时主动复核当前页面', () => {
    const i = pool.indexOf('watchLogin(modelId: string')
    const body = pool.slice(i, pool.indexOf('/**', i + 20))
    assert.match(body, /did-finish-load', check\)/)
    assert.match(body, /\n\s*check\(\)\s*\n/) 
  })

  it('前台挂载后强制复核同一个 WebContents', () => {
    assert.match(main, /async function syncPresentedModel\(m: ModelConfig\)/)
    assert.match(main, /await pool\.waitReady\(m\.id, 12_000\)/)
    assert.match(main, /await syncModelState\(m, \{ notify: true \}\)/)
    const presentCalls = main.match(/if \(ok\) void syncPresentedModel\(cfg\)/g)
    assert.ok(presentCalls && presentCalls.length >= 2, '登录与转播入口都必须复核前台实例')
  })

  it('只在状态真正变化时通知，避免频繁弹提示', () => {
    assert.match(pool, /if \(prev === st\.state\) return/)
  })

  it('登录与转播入口都挂观察器', () => {
    assert.match(main, /function attachLoginWatcher/)
    const uses = main.match(/attachLoginWatcher\(modelId\)/g)
    assert.ok(uses && uses.length >= 2, '两个打开入口都应挂观察器')
  })

  console.log('\n=== 状态灯必须如实反映登录态 ===')

  it('存在登录态快照，状态灯不再只读 agent 缓存', () => {
    // agent.status 是有状态缓存，没人改它就一直停在过期时的值 ——
    // 这正是「登录了还是红」的根因。必须有一份无状态快照。
    assert.match(main, /const lastLoginState = new Map/)
  })

  it('models:list 读快照而非仅 agent.status', () => {
    const i = main.indexOf("ipcMain.handle('models:list'")
    const body = main.slice(i, main.indexOf("ipcMain.handle(", i + 40))
    assert.match(body, /lastLoginState\.get\(m\.id\)/)
    assert.match(body, /st === 'logged-in'\) return 'ready'/)
    assert.match(body, /st === 'logged-out'\) return 'expired'/)
  })

  it('发言中不被复检打断', () => {
    const i = main.indexOf("ipcMain.handle('models:list'")
    const body = main.slice(i, main.indexOf("ipcMain.handle(", i + 40))
    assert.match(body, /a\?\.status === 'busy'\) return 'busy'/)
  })

  it('syncModelState 同时写回 agent.status', () => {
    const i = main.indexOf('async function syncModelState')
    const body = main.slice(i, main.indexOf('function startLoginWatchdog', i))
    assert.match(body, /lastLoginState\.set\(m\.id, loggedIn\.state\)/)
    assert.match(body, /agent\.status = isIn \? 'ready' : 'expired'/)
  })

  it('判定前确保实例已初始化', () => {
    // 实例不存在时 inspectLogin 返回 unknown，状态灯会退化成灰色，
    // 用户看到的是无法解释的圆点而非「未登录」
    const i = main.indexOf('async function syncModelState')
    const body = main.slice(i, main.indexOf('function startLoginWatchdog', i))
    assert.match(body, /if \(!pool\.has\(m\.id\)\)/)
    assert.match(body, /pool\.ensure\(m\.id, rt, m\.partition\)/)
  })

  it('存在周期性复检（登录可发生在 Torra 之外）', () => {
    assert.match(main, /function startLoginWatchdog/)
    assert.match(main, /startLoginWatchdog\(\)/)
    assert.match(main, /setInterval/)
    // 未注册 unref 会阻止进程退出
    assert.match(main, /timer\.unref/)
  })

  it('看门狗只在状态翻转时通知', () => {
    const i = main.indexOf('function startLoginWatchdog')
    const body = main.slice(i, main.indexOf("ipcMain.handle('login:diagnose'", i))
    assert.match(body, /if \(before !== after\)/)
  })

  it('登录观察器复用 syncModelState，不自建判定逻辑', () => {
    // 两套判定逻辑必然漂移：观察器更新了 registry 却没碰 agent.status
    const i = main.indexOf('function attachLoginWatcher')
    const body = main.slice(i, main.indexOf("ipcMain.handle('webview:present'", i))
    assert.match(body, /pool\.watchLogin\(modelId/)
    assert.match(body, /syncModelState\(m, \{ notify: true \}\)/)
    assert.doesNotMatch(body, /registry\.setHealth/)
  })

  it('login:refresh 不再丢弃 agent', () => {
    // agents.delete 会让状态灯退化成 disabled（灰），比红色更难懂
    const i = main.indexOf("ipcMain.handle('login:refresh'")
    const body = main.slice(i, main.indexOf("ipcMain.handle(", i + 40))
    assert.doesNotMatch(body, /agents\.delete/)
    assert.match(body, /syncModelState\(cfg/)
  })

  console.log('\n=== 登录态判定不得被文案误导 ===')

  it('引入「输入区可用」作为关键证据', () => {
    // 上一版把「页面上出现『登录』二字」当强证据，但已登录的对话页
    // 同样会出现该文本（侧栏提示、用户菜单的「退出登录」等），
    // 于是凭据在、页面能用，却被判成未登录 —— 状态灯永远红。
    assert.match(pool, /hasUsableInput/)
    assert.match(pool, /inputPresent/)
  })

  it('可信 Cookie 或用户态标记 → 判为已登录', () => {
    assert.match(pool, /authCookieKeys/)
    assert.match(pool, /if \(hasUserFlag \|\| authCookieKeys\.length > 0\)/)
  })

  it('输入区单独不能证明已登录', () => {
    // 游客页也会渲染输入框；没有认证证据只能是 unknown，禁止状态灯变绿
    assert.match(pool, /聊天输入区可用但未检测到可信登录凭据/)
    assert.match(pool, /聊天输入区可用但页面存储暂不可读，不能确认登录态/)
    assert.match(pool, /if \(hasLoginCta\)/)
  })

  it('登录页 URL 判定保留为决定性证据', () => {
    const i = pool.indexOf('async inspectLogin')
    const body = pool.slice(i, pool.indexOf('hasUsableInput = false', i))
    assert.match(body, /onLoginPage|sign_\?in/)
  })

  it('inspectLogin 注入脚本避免模板字符串中的转义斜杠', () => {
    // 斜杠转义在模板字符串中可能被折叠，导致页面脚本语法错误，
    // 随后错误地进入“存储暂不可读”的兜底分支。
    assert.doesNotMatch(pool, /登录\\\/注册/)
    assert.match(pool, /ctaLabels = \['登录'/)
  })

  it('返回原始证据供诊断', () => {
    assert.match(pool, /evidence\?: \{/)
    assert.match(pool, /onLoginPage: boolean/)
    assert.match(main, /evidence: st\.evidence \?\? null/)
  })

  it('兜底兜底：判不出时报 unknown 而非 logged-out', () => {
    // 硬猜未登录会让用户反复登录 —— 这正是本次要修的症状
    assert.match(pool, /state: 'unknown',[\s\S]{0,200}无法确定登录态/)
  })

  console.log('\n=== 状态灯刷新必须闭环且不成环 ===')

  it('models:list 触发后台复检', () => {
    // 只靠事件驱动不够：用户在页面里登录可能不产生我们监听的事件
    assert.match(main, /function kickBackgroundProbe/)
    const i = main.indexOf("ipcMain.handle('models:list'")
    const body = main.slice(i, main.indexOf("ipcMain.handle(", i + 40))
    assert.match(body, /kickBackgroundProbe\(\)/)
  })

  it('复检不得形成刷新死循环', () => {
    // models:changed → listModels → kickBackgroundProbe → models:changed，
    // 无条件推送会变成界面持续闪烁、CPU 打满
    const i = main.indexOf('async function probeAllAgents')
    const body = main.slice(i, main.indexOf('function syncModelState', i))
    assert.match(body, /before !== after/)
    assert.match(body, /if \(results\.some\(Boolean\)\) send\('models:changed'/)
  })

  it('并发复检有去重保护', () => {
    // 多个入口可能同时触发，不能叠加执行
    assert.match(main, /listProbeInFlight/)
  })

  it('判定理由透传到 UI', () => {
    assert.match(main, /const lastLoginReason = new Map/)
    const i = main.indexOf("ipcMain.handle('models:list'")
    const body = main.slice(i, main.indexOf("ipcMain.handle(", i + 40))
    assert.match(body, /loginNote: m\.transport === 'webview' \? lastLoginReason\.get\(m\.id\)/)
    // 悬停可见
    // 判定理由的悬停展示在 ModelRail，不在 App
    assert.match(rail, /判定依据：\$\{m\.loginNote\}/)
  })

  console.log('\n=== preload 白名单同步 ===')

  it('login:result 在 preload 事件白名单内', () => {
    assert.match(preload, /'login:result'/)
  })

  it('诊断与刷新已暴露给渲染层', () => {
    assert.match(preload, /diagnoseLogin/)
    assert.match(preload, /refreshLogin/)
  })

  // -------------------------------------------------------------------------
  // WebView 池内存预算（回归守卫）
  //
  // 真实故障：内置网页版模型增至 9 个后，9 × 250MB = 2250MB 超出 1536MB 预算，
  // 启动预热时 ensure() 逐个创建并触发 enforceMemoryBudget()，后者把刚创建的
  // 实例按 LRU 销毁 —— ensure() 返回后实例已不存在，发言时抛
  // 「WebView 未初始化」，该模型整场缺席且原因与真实问题无关。
  // -------------------------------------------------------------------------

  console.log('\n=== WebView 内存预算（缺席故障回归守卫）===')

  // 复用外层已读取的 pool / main，避免重复声明
  const webviewModels = (main.match(/transport: 'webview'/g) ?? []).length
  const webviewAgentSrc = await readSrc('src/main/agents/webview-agent.ts')

  it(`默认预算可容纳全部 ${webviewModels} 个网页版模型`, () => {
    assert.match(pool, /export const MB_PER_WEBVIEW = 250/)
    const budget = Number(pool.match(/DEFAULT_MEMORY_BUDGET_MB = (\d+)/)?.[1])
    assert.ok(Number.isFinite(budget), '应导出默认内存预算常量')
    const needed = webviewModels * 250
    assert.ok(
      budget >= needed,
      `默认预算 ${budget}MB 不足以容纳 ${webviewModels} 个 WebView（需 ${needed}MB）——` +
        '启动预热会触发 LRU 自毁，导致模型无故缺席',
    )
  })

  it('主进程不再硬编码过小的内存预算', () => {
    // 硬编码 1536 会覆盖池的默认值，是本次故障的直接原因
    assert.doesNotMatch(
      main,
      /memoryBudgetMb:\s*1536/,
      '主进程不应硬编码 1536MB，应使用 WebviewPool 默认预算',
    )
  })

  it('LRU 回收有保护期，不会销毁刚创建的实例', () => {
    assert.match(pool, /protectAfter/)
    assert.match(pool, /if \(e\.lastUsedAt > protectAfter\) continue/)
  })

  it('发言时实例缺失会重建而非直接判缺席', () => {
    const agent = webviewAgentSrc
    assert.match(agent, /private async ensureView\(\)/)
    // 重建必须带声明的 partition，否则登录态不延续
    assert.match(agent, /this\.pool\.ensure\(this\.id, this\.adapter/)
    // send 路径必须走自愈版本
    assert.match(agent, /const view = await this\.ensureView\(\)/)
  })

  it('启动只预热已登录模型，未登录的按需启动', () => {
    // cookie 预检作为启动决策依据
    assert.match(pool, /export async function probeSessionCookies/)
    assert.match(main, /await warmLikelyLoggedIn\(\)/)
    assert.match(main, /if \(probe\.likelyLoggedIn \|\| rt\.spec\.prewarm === true\) \{\s*\n\s*pool\.ensure/)
    // 后台巡检不得触发补建，否则按需预热会被第一轮巡检击穿
    assert.match(main, /allowCreate/)
  })

  console.log('\n=== 主持通道边界（DeepSeek 链路实错：偏好里存了网页模型当主持）===')

  it('主进程校验拦住非 API 主持', () => {
    /*
     * 旧校验只查「模型存在」，于是 moderatorId=deepseek-web 时校验通过，
     * buildModerator 却因为 cfg.api 不存在而返回 null ——
     * 讨论一路跑到结尾才静默降级成无主持，中间没有任何提示。
     */
    const i = main.indexOf('主持模型不存在')
    assert.ok(i > 0)
    const body = main.slice(i, main.indexOf('/** 用户自建适配器目录', i))
    assert.match(body, /!models\.find\(\(m\) => m\.id === c\.moderatorId\)\?\.api/)
  })

  it('主持下拉只列 API 模型，缺 Key 的置灰而非隐藏', () => {
    assert.match(newSession, /m\.transport === 'api' && m\.supportsStructuredOutput/)
    assert.match(newSession, /disabled=\{!m\.hasKey\}/)
  })

  it('恢复旧偏好时丢弃网页主持', () => {
    // 不改持久化就只能等用户自己发现：这里在恢复阶段直接作废无效值，
    // 后续「偏好变化自动持久化」会把它覆盖掉
    assert.match(app, /x\.id === prefs\.moderatorId && x\.transport === 'api'/)
  })

  console.log('\n=== 体检与真实写入必须同一条通道 ===')

  it('体检按 pickInput 复用 send 的可见优先选取', () => {
    assert.match(doctor, /window\.__torra && window\.__torra\.pickInput/)
    assert.match(doctor, /visibleHits !== 1/)
  })

  it('登录层用到期时间区分「过期」与「被站点拒绝」', () => {
    // 两者的修复动作完全不同：前者去重登，后者多半是另一个实例持有分区
    assert.match(doctor, /凭据未过期但被站点拒绝/)
    assert.match(doctor, /登录已过期/)
    assert.match(doctor, /该分区内没有登录凭据/)
  })

  it('登录诊断只输出 cookie 元数据，不碰凭据值', () => {
    const i = doctor.indexOf('async function checkLogin')
    const body = doctor.slice(i, doctor.indexOf('/** L4 通道', i))
    assert.doesNotMatch(body, /\.value/, 'cookie 值一旦进入报告就会落到日志与导出文件')
    assert.match(body, /expirationDate/)
  })

  console.log('\n=== 体检覆盖 API 接入通道 ===')

  it('api 层插在适配器与登录之间', () => {
    // 它是参会模型之外的第二条通道：网页模型看登录，API 模型看 Key 与端点
    assert.ok(LAYER_ORDER.indexOf('adapter') < LAYER_ORDER.indexOf('api'))
    assert.ok(LAYER_ORDER.indexOf('api') < LAYER_ORDER.indexOf('login'))
    assert.equal(LAYER_LABEL.api, 'API 接入')
    assert.match(diagShared, /\| 'api'/, 'DiagLayer 联合类型里必须有 api，否则检查项无处安放')
  })

  it('体检覆盖全部启用的 API 模型', () => {
    assert.match(doctor, /\.filter\(\(m\) => m\.enabled && m\.transport === 'api'\)/)
    assert.match(doctor, /checks\.push\(\.\.\.\(await checkApiChannel\(deps, m, opts\)\)\)/)
  })

  it('主持走 api 层查通道，不在主持层重复报 Key 与端点', () => {
    // 重复报告会给出两条互相矛盾的结论（api:key 通过、moderator:key 失败），
    // 用户不知道先修哪条；主持层只判资格
    const mod = doctor.slice(doctor.indexOf('async function checkModerator'), doctor.indexOf('/** L7 结果产出'))
    assert.doesNotMatch(mod, /moderator:key|moderator:reach|fetch\(|secrets\./)
    assert.match(mod, /moderator:cap|不具备结构化输出资格/)
    assert.match(mod, /是网页通道，不能担任主持/)
    // 主持若同时是参会模型，通道只查一次
    assert.match(doctor, /!apiTargets\.some\(\(m\) => m\.id === modId\)/)
  })

  it('API 探测只发 GET /models，绝不发补全请求', () => {
    // 补全会花用户的钱；体检的授权边界是只读
    const probe = doctor.slice(doctor.indexOf('async function probeApiEndpoint'), doctor.indexOf('/** L2 API 接入通道'))
    assert.match(probe, /\/models/)
    assert.doesNotMatch(probe, /completions|messages|chat/i)
    assert.match(doctor, /x-api-key/)
    assert.match(doctor, /anthropic-version/)
    // 关掉联网探测时必须留下 skip，而不是悄悄少一层
    assert.match(doctor, /opts\.probeApi === false/)
    assert.match(doctor, /端点连通性未探测/, '关掉探测要留下 skip 条目，不能让 api 层凭空消失')
  })

  it('离线 CLI 的层序号引用共享定义，不自抄一份', () => {
    // 自抄的副本会在新增一层时落后，报告里的「第 N 层」开始说谎
    assert.doesNotMatch(doctorCli, /const LAYER_ORDER = \[/)
    assert.match(doctorCli, /LAYER_ORDER, LAYER_LABEL \} = requireBuilt/)
    assert.match(doctorCli, /probeApi: flags\.ping/)
  })

  it('报告按层归组输出，主持范围可选 API 模型', () => {
    assert.match(doctor, /for \(const layer of LAYER_ORDER\)/)
    assert.match(panel, /m\.transport === 'api' \? '（API）'/)
    assert.match(settings, /modelIds=\{models\.map/)
    assert.doesNotMatch(settings, /modelIds=\{webModels\.map/)
  })

  console.log('\n=== 白天 / 黑夜主题 ===')

  // 把两套 token 块从 CSS 里切出来，其余规则应当与主题无关
  const sliceBlock = (from: string): { body: string; start: number; end: number } => {
    const start = cssSrc.indexOf(from)
    assert.ok(start >= 0, `CSS 里找不到 ${from}`)
    const end = cssSrc.indexOf('\n}', start)
    assert.ok(end > start, `${from} 的块没有正常闭合`)
    return { body: cssSrc.slice(start, end), start, end: end + 2 }
  }
  const day = sliceBlock(':root {')
  const dark = sliceBlock(":root[data-theme='dark'] {")
  const tokenNames = (block: string): Set<string> =>
    new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string))
  const dayTokens = tokenNames(day.body)
  const darkTokens = tokenNames(dark.body)
  const ungated = cssSrc.slice(0, day.start) + cssSrc.slice(day.end, dark.start) + cssSrc.slice(dark.end)

  it('黑夜用到的每个表面 token，白天都定义了同一个名字', () => {
    // 少一个名字，白天就会拿到未定义的变量：轻则透明、重则白底白字
    const missing = [...darkTokens].filter((t) => !dayTokens.has(t))
    assert.deepEqual(missing, [], `白天 :root 缺少 ${missing.join(', ')}`)
    for (const t of ['--surface-raise', '--sunken', '--panel-glass', '--scrim', '--sheen', '--on-accent', '--think-text', '--ground']) {
      assert.ok(dayTokens.has(t) && darkTokens.has(t), `${t} 必须两套主题都定义`)
    }
  })

  it('共用规则里不留深色字面量', () => {
    // 这些颜色只属于黑夜；出现在门控之外，白天模式就会画出黑色的面
    for (const leak of ['#0a0b14', '#cbb8ff', 'rgba(150, 90, 255', 'rgba(0, 0, 0, 0.28)', 'rgba(4, 5, 12', 'rgba(6, 8, 18', 'rgba(24, 30, 54', 'rgba(21, 26, 46', 'rgba(10, 12, 22']) {
      assert.ok(!ungated.includes(leak), `门控外的规则里出现了深色字面量 ${leak}`)
    }
  })

  it('结构选择器没有被关进深色块', () => {
    // 曾经 .app-nav / .vs-tab 只写在深色覆盖里：切回白天整个导航失去样式
    for (const sel of ['.app-nav', '.view-subnav', '.vs-tab', '.absent-detail', '.theme-options', '.discussion-status-bar']) {
      assert.ok(ungated.includes(sel), `${sel} 应当定义在与主题无关的规则里`)
    }
  })

  it('深色 token 块之后不再出现裸 :root 覆盖', () => {
    // 裸 :root 靠源码顺序取胜；再往文件尾部追加一个，黑夜就会被悄悄改写
    assert.doesNotMatch(cssSrc.slice(dark.end), /:root\s*\{/)
  })

  it('冷启动主题由主进程解析后经 preload 落进 data-theme', () => {
    assert.match(main, /additionalArguments: \[`--torra-theme=\$\{resolved\}`\]/)
    assert.match(main, /backgroundColor: resolved === 'dark'/)
    assert.match(preload, /--torra-theme=/)
    assert.match(preload, /document\.documentElement\.dataset\.theme = theme/)
  })

  it('主题默认黑夜，且「跟随系统」不自创状态', () => {
    // 默认值一变，老用户升级后看到的就不是他一直在用的那套外观
    assert.equal(DEFAULT_THEME_MODE, 'dark')
    assert.deepEqual(THEME_MODES, ['light', 'dark', 'system'])
    assert.equal(resolveTheme('system', true), 'dark')
    assert.equal(resolveTheme('system', false), 'light')
    assert.equal(resolveTheme('light', true), 'light')
    assert.equal(isThemeMode('night'), false)
  })

  it('保存偏好不再整份覆盖 preferences.json', () => {
    // 覆盖写会让一次普通的参与者选择保存抹掉主题，反之亦然
    assert.match(main, /patchPreferences\(\{ participantIds: prefs\.participantIds/)
    assert.doesNotMatch(main, /JSON\.stringify\(prefs, null, 2\)/)
    assert.match(main, /const merged = \{ \.\.\.\(await readPreferences\(\)\), \.\.\.patch \}/)
  })

  it('渲染层订阅主进程的解析结果，两处入口共用同一状态', () => {
    assert.match(main, /nativeTheme\.themeSource = mode === 'system' \? 'system' : mode/)
    assert.match(main, /win\.webContents\.send\('theme:resolved'/)
    assert.match(preload, /'theme:resolved'/)
    assert.match(themeUi, /document\.documentElement\.dataset\.theme = next/)
    assert.match(themeUi, /window\.torra\.on\('theme:resolved'/)
    assert.match(app, /toggleTheme/)
    assert.match(settings, /AppearanceSection/)
    assert.match(settings, /THEME_MODES\.map/)
  })

  console.log(`\n${'='.repeat(46)}`)
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46) + '\n')

  process.exit(fail > 0 ? 1 : 0)
}

void main()
