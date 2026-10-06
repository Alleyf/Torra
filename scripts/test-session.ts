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
import { FileSessionStore } from '../src/main/store/session-store'
import { Orchestrator, type OrchestratorEvent } from '../src/main/orchestrator/orchestrator'
import type { Agent } from '../src/main/agents/agent'
import {
  SessionProjection,
  type DigestSnapshot,
  type ProjectionMeta,
} from '../src/main/store/projection'
import type { SessionConfig, Topic } from '../src/shared/types'
import { LAYER_LABEL, LAYER_ORDER } from '../src/shared/diagnostics'
import { DEFAULT_THEME_MODE, THEME_MODES, isThemeMode, resolveTheme } from '../src/shared/theme'
import { formatSpeech, mdExcerpt, plainMd } from '../src/renderer/textFormat'
import {
  DEFAULT_PARTICIPANT_CAP,
  channelMix,
  pickDefaultParticipants,
  roundWallClockMs,
  usableModels,
} from '../src/shared/participants'
import type { TransportKind } from '../src/shared/types'

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

/** it 的异步版：投影要真写盘，同步断言覆盖不到落盘顺序与原子替换 */
async function itAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

function projMeta(sessionId: string): ProjectionMeta {
  const topic: Topic = {
    id: 'topic_fix',
    title: '能不能用共享文件做结果共享',
    background: '背景材料若干',
    strategy: 'roundtable',
    attachments: [],
    createdAt: 1,
  }
  const config: SessionConfig = {
    maxRounds: 3,
    consensusThreshold: 85,
    participantIds: ['m_a', 'm_b'],
    moderatorId: 'm_m',
    budgetLimitUsd: 1,
  }
  return {
    sessionId,
    topic,
    config,
    names: { m_a: '甲模型', m_b: '乙模型', m_m: '主持模型' },
    startedAt: Date.now(),
  }
}

/** mark 用来断言「这一版写进去了、上一版没残留」 */
function projSnap(mark: string): DigestSnapshot {
  return {
    state: 'SUMMARIZING',
    round: 2,
    confirmed: [
      {
        id: 'c1',
        claim: `共识甲 ${mark}`,
        support: ['m_a', 'm_b'],
        confidence: 0.8,
        evidenceRef: ['u1'],
        confirmedRound: 1,
      },
    ],
    open: [
      {
        id: 'o1',
        claim: `分歧乙 ${mark}`,
        sides: [{ agentId: 'm_a', argument: '理由 A', utteranceIds: ['u1'] }],
        openedRound: 2,
        lastProgress: null,
        status: 'open',
      },
    ],
    scores: [{ round: 1, score: { agreement: 60, overlap: 50, trend: 70, score: 60 } }],
    latest: [{ round: 2, agent: '甲模型', snippet: '发言开头', absent: false }],
    spentUsd: 0.0123,
  }
}

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
  const authCookies = await readSrc('src/main/webview/auth-cookies.ts')
  const main = await readSrc('src/main/index.ts')
  const preload = await readSrc('src/preload/index.ts')
  const rail = await readSrc('src/renderer/components/ModelRail.tsx')
  const app = await readSrc('src/renderer/App.tsx')
  const storeSrc = await readSrc('src/renderer/store.ts')
  const cssSrc = await readSrc('src/renderer/styles.css')
  const newSession = await readSrc('src/renderer/components/NewSession.tsx')
  const dock = await readSrc('src/renderer/components/WebviewDock.tsx')
  const doctor = await readSrc('src/main/diagnostics/doctor.ts')
  const diagShared = await readSrc('src/shared/diagnostics.ts')
  const doctorCli = await readSrc('scripts/doctor.js')
  const panel = await readSrc('src/renderer/components/DiagnosticsPanel.tsx')
  const settings = await readSrc('src/renderer/components/SettingsPage.tsx')
  const themeUi = await readSrc('src/renderer/theme.ts')
  const brandTsx = await readSrc('src/renderer/components/BrandMark.tsx')
  const brandSvg = await readSrc('src/renderer/assets/brand/mark.svg')
  const drawer = await readSrc('src/renderer/components/AssistantDrawer.tsx')
  const participantsSrc = await readSrc('src/shared/participants.ts')

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
    assert.match(authCookies, /\^ds_session_id\$\//)
  })

  it('排除 CSRF 与匿名 SSO Cookie，避免游客页被判已登录', () => {
    assert.match(authCookies, /passport_csrf/)
    assert.match(authCookies, /bd_sso/)
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
    const start = main.indexOf("ipcMain.handle('login:diagnose'")
    const seg = main.slice(start)
    // 按「下一个 handler」截断，而不是固定字符数：诊断返回的字段还在长，
    // 写死长度会让任何新增字段都把这条测试变成假失败。
    const next = seg.indexOf('ipcMain.handle(', 20)
    const body = seg.slice(0, next > 0 ? next : seg.length)
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
    // login:open 既不弹窗，也不再自己贴原生视图：两者都请渲染层挂 <WebviewDock>，
    // 由 dock 量矩形并负责卸载时收起 —— 主进程贴出去的视图没有表头也没有关闭按钮
    const i = main.indexOf("ipcMain.handle('login:open'")
    const body = main.slice(i, main.indexOf("ipcMain.handle(", i + 40))
    assert.doesNotMatch(body, /openLoginWindow/)
    assert.doesNotMatch(body, /pool\.present\(/)
    assert.match(body, /send\('webview:request'/)
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
    // 没有关闭窗口这个终点了，必须给出明确的「我做完了」按钮；
    // 按钮随网页视图一起收进 WebviewDock，复核动作仍由 App 的 refreshLogin 承担。
    assert.match(dock, /我已登录完成/)
    assert.match(dock, /onRecheck/)
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
    assert.ok(presentCalls && presentCalls.length >= 1, '前台挂载入口必须复核前台实例')
    // 所有「打开页面」都改成请渲染层挂 dock：主进程自己贴出来的那块原生视图
    // 压在整个应用之上又关不掉，正是用户报的「网页挡住应用」
    assert.ok((main.match(/send\('webview:request', \{ modelId \}\)/g) ?? []).length >= 2, '登录与助手的打开入口都应交给 dock')
    assert.doesNotMatch(main, /const shown = pool\.present\(modelId\)/)
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
  const injectSrc = await readSrc('src/main/webview/inject.ts')

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

  console.log('\n=== 后台宿主必须出帧（DeepSeek 聊天轮「生成结束但未捕获到内容」的实错）===')

  it('宿主窗口创建时即显示、摆在屏幕外，而不是 show:false 再补 show', () => {
    /*
     * 实测：宿主创建时 show:false → document.visibilityState 恒 hidden、rAF 回调数恒 0，
     * 事后 show()/showInactive() 翻不回来。DeepSeek 的消息列表靠 IntersectionObserver/rAF
     * 挂载，没帧就连历史消息都不进 DOM，抓取只能读空 —— 而 ChatGPT/豆包靠定时器提交文本，
     * 不受影响，所以这个坑只在个别模型上发作。
     */
    const host = pool.slice(pool.indexOf('private ensureHost()'))
    assert.match(host, /show: true,/, '宿主窗口必须创建时即显示（后台实例才拿得到渲染帧）')
    assert.doesNotMatch(host, /show: false,/, '宿主窗口不能退回 show:false —— 之后 show() 救不回可见态')
    assert.match(host, /x: -32000,/, '用屏幕外负坐标让用户看不见，而不是靠隐藏窗口')
    assert.match(host, /skipTaskbar: true,/)
  })

  it('回合中途复查风控墙，别把站点拦截报成适配器抓不到', () => {
    // 键入阶段那道 isRiskWall 过去了之后，站点仍可在回合中途换成「使用环境异常」整页。
    assert.match(webviewAgentSrc, /obs: window\.__torra\.observe\(/)
    assert.match(webviewAgentSrc, /snap\.obs && snap\.obs\.riskWall/)
    assert.match(webviewAgentSrc, /stage: 'risk-wall'/)
    assert.match(webviewAgentSrc, /humanizeSendFailure\('risk-blocked'\)/)
  })

  it('读空时分清「选择器指错」与「后台没帧」两种病因', () => {
    // 两种病因的下一步动作完全不同，共用一句「未捕获到内容」只会误导用户改适配器。
    assert.match(injectSrc, /visibility: document\.visibilityState/)
    assert.match(webviewAgentSrc, /snap\.obs\?\.visibility === 'hidden' && snap\.act > stableWindow/)
    assert.match(webviewAgentSrc, /stage: noFrame \? 'read-no-frame' : 'read-empty'/)
    assert.match(webviewAgentSrc, /后台页面没有拿到渲染帧/)
  })

  console.log('\n=== 列表抓取要剥掉站点自绘的项目符号（元宝「· 单独一行」的实错）===')

  it('项目符号文本不进正文，条目内的续行留在列表里', () => {
    /*
     * 元宝真实形状（domscan 抓到的 outerHTML）：
     * <li><span class="ybc-li-component_dot">•</span>
     *     <span class="ybc-li-component_content"><div class="ybc-p">正文</div></span></li>
     * 旧 mdList ① 把站点自绘的「•」当正文留下 → 条目成了「- •」；
     * ② 块级正文自带空行且顶格 → CommonMark 只认缩进的续行，正文整段掉出列表。
     * 两者叠加就是用户看到的「好几行圆点单独成行、内容在下一行」。
     */
    const mdListSrc = injectSrc.slice(injectSrc.indexOf('function mdList('))
    assert.match(mdListSrc, /replace\(MD_LEAD_BULLET, ''\)/, '要剥掉站点自绘的项目符号')
    assert.match(mdListSrc, /if \(!body\) continue/, '去符号后为空的条目要跳过，而不是留一行孤零零的圆点')
    assert.match(mdListSrc, /parts\[p\] = cont \+ parts\[p\]/, '条目续行要补缩进才留在同一个列表项里')
    assert.doesNotMatch(mdListSrc, /body = ' '/, '不再用「空条目也要输出」的旧写法')
  })

  it('有序列表里站点自绘的「1.」也不能重复编号', () => {
    /*
     * 元宝的 <ol> 复用同一个 dot 元素，里面装的是「1.」文本 ——
     * mdList 再补一次编号就成了「1. 1.」，条目还被后面顶格的正文章节冲散
     * （用户第二次报的元宝排版问题，domscan --ask 复现）。
     * 约束：只有文本里的数字真等于本项序号才剥，否则「2024 年的数据…」会被吃掉前缀。
     */
    const mdListSrc = injectSrc.slice(injectSrc.indexOf('function mdList('))
    assert.match(mdListSrc, /MD_LEAD_NUM/, '要有一条有序编号的剥除规则')
    assert.match(mdListSrc, /if \(ordered\) \{/, '只在 <ol> 里剥数字编号，无序列表不走这条路')
    assert.match(mdListSrc, /Number\(num\[1\]\) === expect/, '编号要和站点按位置算出的序号对得上才剥')
    assert.match(mdListSrc, /var expect = start \+ liNo - 1/, '空条目也占号：比对用位置号，不用输出端的连号')
    assert.match(injectSrc, /\(\?!\[\\\\d\]\)/, '「1.5 米」这种以数字开头的正文不能被当编号')
  })

  console.log('\n=== 站点自标的推荐位卡片不能混进正文（元宝回答末尾的「相关视频」）===')

  it('data-hidecopy 的卡片整块丢掉，但不牵连同容器的正文', () => {
    /*
     * 元宝把「相关视频」推荐位标成 data-hidecopy="true"（站点自己的「复制时别带上」），
     * 标题却在标记外面 —— 只丢卡片会剩一行没头没尾的「相关视频」。
     * 两条边界：容器自己有直接文本就只摘卡片；摘完只剩短标题才整块丢。
     */
    const hc = injectSrc.slice(injectSrc.indexOf('function mdHidecopy('))
    assert.match(hc, /hasAttribute\('data-hidecopy'\)/, '要认站点自己的 hidecopy 标记，而不是按 class 猜站点')
    assert.match(hc, /if \(own\.trim\(\)\) return ''/, '容器有直接正文时只丢卡片')
    assert.match(hc, /rest\.length <= 24/, '摘掉卡片后只剩短标题才整块丢')
    const children = injectSrc.slice(injectSrc.indexOf('function mdChildren('))
    assert.match(children, /mdHidecopy\(el\)/, 'mdChildren 要过一遍 hidecopy 规则')
  })

  console.log('\n=== 聊天模式的重试口径（用户要求：只重试出问题的那个模型）===')
  const chatPage = await readSrc('src/renderer/components/ChatPage.tsx')

  it('失败分支只重跑该模型，不再把整轮发给所有参与者', () => {
    /*
     * 旧的「重试本轮」把问题填回输入框，回车后 send() 给每个参与者新建单元格并重发 ——
     * 一个模型登录过期就要所有人再跑一遍，而网页通道一轮要几分钟。
     * 现在卡片上的动作是 onRegenerate（regenerateCell 只发这一个模型，原位替换那格）。
     */
    assert.doesNotMatch(chatPage, /重试本轮/, '聊天模式不应再提供「重试本轮」')
    assert.doesNotMatch(chatPage, /onRetry/, '整轮重试的旧链路要删干净，不留死 props')
    const at = chatPage.lastIndexOf('cx-ans-error')
    assert.match(chatPage.slice(at, at + 400), /onClick=\{onRegenerate\}/)
    assert.match(chatPage, /\[\{ modelId, history \}\]/, '重新生成只发一个模型的 items')
  })

  it('放大查看单模型时也能就地重新生成', () => {
    // 用户是在放大的那张卡上读网页模型回答的，那里原本只有「复制回答」
    const modal = chatPage.slice(chatPage.indexOf('function FocusModal'))
    assert.match(modal, /onRegenerate: \(\) => void/)
    assert.match(modal, /onClick=\{onRegenerate\}/)
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

  console.log('\n=== 主持兼参会：放开硬禁，护栏挪到编排层 ===')

  const orchDual = await readSrc('src/main/orchestrator/orchestrator.ts')
  const nsCss = await readSrc('src/renderer/newsession.css')
  const e2eSrc = await readSrc('scripts/test-orchestrator-e2e.ts')
  it('主进程不再禁止主持出现在参会名单里', () => {
    /*
     * 过去校验层一刀切，用户想把最强的那颗模型既当发言者又当主持就做不到。
     * 兼岗的真实风险是「自己判自己」，那条靠编排层兜（下面两条），不是靠拒配置。
     */
    assert.doesNotMatch(main, /主持模型不能同时作为参会模型/)
    // 但通道资格这条不能跟着一起删：删了会退回「跑到结尾才静默降级成无主持」
    assert.match(main, /主持模型必须是 API 模型/)
  })

  it('基线绕开主持：兼岗时不能让它替全场搭擂台', () => {
    /*
     * 只在函数末尾兜底跳过主持是不够的 —— 参会名单第一位恰好是主持时，
     * 循环里就把它选中了，「不选主持」这条纪律被静默绕过。
     */
    const i = orchDual.indexOf('private resolveBaselineAgent()')
    assert.ok(i > 0)
    const body = orchDual.slice(i, orchDual.indexOf('/**', i + 30))
    assert.match(body, /if \(id === this\.config\.moderatorId\) continue/)
    assert.match(body, /return this\.config\.moderatorId \? this\.deps\.getAgent/)
  })

  it('主持提示词带兼岗护栏，且只在真兼岗时出现', () => {
    // 恒定注入会让所有场次多一条无关约束；条件挂载才是「这一场你确实下场了」
    assert.match(
      orchDual,
      /if \(this\.config\.moderatorId && this\.config\.participantIds\.includes\(this\.config\.moderatorId\)\)/,
    )
    assert.match(orchDual, /本场你同时是参会者/)
    // 署名轨把名单里那颗标成兼任；匿名轨故意不标（标了等于告诉它哪个别名是自己）
    assert.match(orchDual, /主持兼任参会，本场也在发言/)
    assert.match(orchDual, /!this\.aliases\.anonymous && id === this\.config\.moderatorId/)
  })

  it('开场页把兼岗说在胶囊和提示上', () => {
    assert.match(newSession, /className=\{`ns-chip-mod/)
    assert.match(newSession, /本场兼参会：轮内一起发言，轮间照样出小结/)
    assert.match(newSession, /主持同时参会/)
    // ns- 层已经拆到 newsession.css，规则写进 styles.css 会变成没人加载的死样式
    assert.match(nsCss, /\.ns-chip-mod\b/)
  })

  it('兼岗真的跑过一场：编排器 e2e 里有人主持兼参会的用例', () => {
    // 源不变量只证明代码写了；名单第一位就是主持那种走法，得靠假通道跑满一场才有算数
    assert.match(e2eSrc, /moderatorId: 'm_a'/)
    assert.match(e2eSrc, /基线交给名单里的另一位/)
  })

  console.log('\n=== 全新安装第一眼：研讨首页就地体检 ===')

  const USABLE = /transport === 'api' \? \w+\.hasKey : \w+\.status === 'ready'/
  it('「能不能开一场」和自动勾选参与名单用的是同一条口径', () => {
    /*
     * 两处各写一份判断，迟早变成「首页说缺人，下面的名单却已经给人选上了」
     * 这种自相矛盾的界面。所以判据只留 participants.ts 一份，两处都调它。
     */
    assert.match(newSession, /\busableModels\(/)
    assert.match(storeSrc, /\busableModels\(/)
    assert.match(participantsSrc, USABLE)
    // 内联副本一旦被写回来，这里的单点口径就又不成立了
    assert.doesNotMatch(newSession, USABLE)
    assert.doesNotMatch(storeSrc, USABLE)
  })

  it('体检块摆的是按得动的出路，不是又一段说明文字', () => {
    assert.match(newSession, /className="start-check"/)
    // 网页 chip → 内嵌视图；API → 设置页。两条都要求真的能跳转
    assert.match(newSession, /onClick=\{\(\) => onPickWebModel\(m\.id\)\}/)
    assert.match(newSession, /onClick=\{onGotoSettings\}/)
    // 这块只在「一个能发言的模型都没有」时出现，而助手也要一个带 Key 的 API 模型才能跑：
    // 摆「让助手替你查」等于把新人领进另一条死路。
    // 首屏的三条路介绍面板里可以有助手（那时不承诺它能跑通），所以判定范围只圈体检块本身。
    const checkAt = newSession.indexOf('className="start-check"')
    assert.ok(checkAt > 0, 'start-check 块找不到了')
    const startCheck = newSession.slice(checkAt, newSession.indexOf('议题标题', checkAt))
    assert.ok(startCheck.length > 200, '体检块的切片没有覆盖到整块')
    assert.doesNotMatch(startCheck, /onOpenAssistant/)
  })

  it('缺的东西补齐后这块自己收掉', () => {
    // 常驻的提示会对老用户变成噪音；条件必须同时看「有模型」和「一个都不能发言」
    assert.match(newSession, /models\.length > 0 && usable\.length === 0/)
  })

  console.log('\n=== 一次性引导：讲完就退场 ===')

  it('引导和体检不同时出现，讲完「有什么」再接「缺什么」', () => {
    // 两块一起摆会把议题表单挤出首屏；先后顺序就是新人该被引导的次序
    assert.match(newSession, /\{!showIntro && models\.length > 0 && usable\.length === 0/)
    assert.match(newSession, /\{showIntro && \(\s*<div className="start-intro"/)
  })

  it('三条路各自都有一个按得动的去处', () => {
    assert.match(newSession, /onClick=\{onDismissIntro\}/)
    assert.match(newSession, /onDismissIntro\(\)\s*\n\s*onOpenChat\(\)/)
    assert.match(newSession, /onDismissIntro\(\)\s*\n\s*onOpenAssistant\(\)/)
  })

  it('已读标记存在主进程那份安装里，不是渲染层的临时状态', () => {
    /*
     * 记在组件 state 或 localStorage：重载页面、换窗口就会再问一遍，
     * 「一次性」就成了「每次启动」。标记跟着这份安装走。
     */
    assert.match(main, /onboarding:dismiss/, '主进程没有 onboarding:dismiss')
    assert.match(main, /markFlag\('onboarding-seen'\)/)
    assert.match(main, /onboarding:state[\s\S]{0,160}flagExists\('onboarding-seen'\)/)
    assert.match(preload, /onboardingDismiss: \(\): Promise<\{ ok: boolean \}>/)
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
    //（.theme-options 随设置页主题分段控件一起退休了，这里改盯仍在用的 .theme-toggle；
    //  .view-subnav 随视图子导航并入 .app-nav 一起退休，盯一个不存在的类只会误报）
    for (const sel of ['.app-nav', '.vs-tab', '.absent-detail', '.theme-toggle', '.discussion-status-bar']) {
      assert.ok(ungated.includes(sel), `${sel} 应当定义在与主题无关的规则里`)
    }
  })

  it('深色 token 块之后不再出现裸 :root 覆盖', () => {
    // 裸 :root 靠源码顺序取胜；再往文件尾部追加一个，黑夜就会被悄悄改写
    assert.doesNotMatch(cssSrc.slice(dark.end), /:root\s*\{/)
  })

  it('品牌色号只活在变量定义里', () => {
    // 色号一旦散进组件规则，调品牌色就得满文件找，明暗两套的对应关系也会断
    const rules = ungated
      .split('\n')
      .filter((l) => !/^\s*--[a-z0-9-]+\s*:/.test(l))
      .join('\n')
      .replace(/,\s+/g, ',')
    const leaks = [
      '#536dfe', '#8b5cf6', '#7b8cff', '#a78bfa', '#191c38', '#12142b',
      'rgba(83,109,254', 'rgba(123,140,255', 'rgba(167,139,250', 'rgba(139,92,246',
    ]
    for (const leak of leaks) {
      assert.ok(!rules.includes(leak), `门控外的规则里出现了品牌色号 ${leak}`)
    }
  })

  it('品牌标记的几何在组件与 favicon 里同源', () => {
    // 应用内标记（24 盒）与 favicon/图标（64 盒）各写各的，就会长成两个牌子。
    // 认的是角度而不是坐标：三段 90° 弧 + 三个 30° 缺口 + 同一相位。
    const tsxArcs = [...brandTsx.matchAll(/'(M[\d. ]+A[^']+)'/g)].map((m) => m[1] as string)
    const svgArcs = [...brandSvg.matchAll(/<path d="(M[^"]+)"/g)].map((m) => m[1] as string)
    assert.equal(tsxArcs.length, 3, '组件里应当有三段弧')
    assert.equal(svgArcs.length, 3, 'SVG 里应当有三段弧')

    const angles = (d: string, c: number): { start: number; sweep: number } => {
      const m = d.match(/^M([\d.]+) ([\d.]+)A([\d.]+) ([\d.]+) 0 0 1 ([\d.]+) ([\d.]+)$/)
      assert.ok(m, `弧路径读不懂：${d}`)
      const deg = (x: string, y: string): number => (Math.atan2(Number(y) - c, Number(x) - c) * 180) / Math.PI
      const start = (deg(m![1] as string, m![2] as string) + 360) % 360
      let sweep = (deg(m![5] as string, m![6] as string) + 360) % 360 - start
      if (sweep < 0) sweep += 360
      return { start, sweep }
    }
    const t24 = tsxArcs.map((d) => angles(d, 12))
    const t64 = svgArcs.map((d) => angles(d, 32))
    const gaps = (list: { start: number; sweep: number }[]): number[] =>
      list.map((x, i) => (list[(i + 1) % list.length]!.start - ((x.start + x.sweep) % 360) + 360) % 360)

    t24.forEach((a, i) => {
      assert.ok(Math.abs(a.sweep - 90) < 0.5, `组件第 ${i + 1} 段不是 90°：${a.sweep.toFixed(2)}`)
      assert.ok(Math.abs(a.start - t64[i]!.start) < 0.5, `第 ${i + 1} 段相位漂移：${a.start.toFixed(2)} vs ${t64[i]!.start.toFixed(2)}`)
    })
    for (const g of [...gaps(t24), ...gaps(t64)]) {
      assert.ok(Math.abs(g - 30) < 0.5, `弧之间的缺口应当是 30°，实际 ${g.toFixed(2)}`)
    }
  })

  it('助手抽屉用到的每个类名都有对应样式', () => {
    // 这轮重做踩过的坑：TSX 换了一套类名，CSS 还停在旧结构上，
    // 结果抽屉变成没有样式的裸文本。类名与样式必须一起到位。
    const used = new Set<string>()
    for (const m of drawer.matchAll(/[`'"]([^`'"\n]*)[`'"]/g)) {
      for (const tok of (m[1] ?? '').split(/[^A-Za-z0-9-]+/)) {
        if (/^(a|assistant)-[a-z0-9-]+$/.test(tok)) used.add(tok)
      }
    }
    assert.ok(used.size > 30, `只抓到 ${used.size} 个类名，解析大概失效了`)
    const missing = [...used].filter((c) => !new RegExp(`\\.${c}(?![a-z0-9-])`).test(cssSrc))
    assert.deepEqual(missing, [], `styles.css 里缺少这些类名的样式：${missing.join(', ')}`)
  })

  it('抽屉动效有降级兜底', () => {
    // 循环动画在 prefers-reduced-motion 下必须显式关掉：
    // 全局降级只压时长，0.001ms 的无限循环会闪
    const reduced = cssSrc.slice(cssSrc.indexOf('@media (prefers-reduced-motion: reduce)', cssSrc.indexOf('.assistant-drawer')))
    for (const sel of ['.assistant-drawer', '.a-dots i', '.assistant-id-mark.live::after']) {
      assert.ok(reduced.includes(sel), `降级规则里少了 ${sel}`)
    }
  })

  it('冷启动主题：主进程同步应答，preload 等 <html> 一出现就写入', () => {
    assert.match(main, /ipcMain\.on\('theme:boot'/)
    assert.match(main, /e\.returnValue = resolvedTheme\(\)/)
    // 注册必须早于建窗口：handler 晚一步，preload 问不到只能回落默认值，
    // 白天用户就会在开场看到一帧黑夜（或反之）
    assert.match(main, /initTheme\(\)\s*\n\s*createWindow\(\)/)
    assert.match(preload, /sendSync\('theme:boot'\)/)
    // preload 执行时 documentElement 还是 null，直接写会静默失败
    assert.match(preload, /new MutationObserver/)
    assert.match(preload, /root\.dataset\.theme = BOOT_THEME/)
    // 已证实走不通的路径不许回来
    assert.doesNotMatch(main, /additionalArguments: \[`--torra-theme=/)
    assert.doesNotMatch(preload, /--torra-theme=/)
    assert.match(main, /backgroundColor: resolved === 'dark'/)
  })

  it('渲染层不把「preload 来不及写」当成黑夜', () => {
    assert.match(themeUi, /window\.torra\?\.bootTheme\?\.\(\)/)
    // 挂载时无条件补写一次，CSS 才不会停在默认配色而状态已是黑夜
    assert.match(themeUi, /document\.documentElement\.dataset\.theme = resolved/)
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
    assert.match(main, /await patchPreferences\(\{ theme: mode \}\)/)
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

  console.log('\n=== 对外投影：运行中的结论要能被外部只读消费 ===')

  const projSrc = await readSrc('src/main/store/projection.ts')
  const fileStoreSrc = await readSrc('src/main/store/session-store.ts')

  it('会话 ID 开场即定，投影文件与终态存档同名可对上', () => {
    // 运行中叫一个名字、存档后改叫另一个，外部读者就没法把两者关联
    assert.match(main, /currentSessionId = makeId\('sess'\)/)
    assert.match(main, /const sessionId = currentSessionId/)
    assert.doesNotMatch(main, /const sessionId = makeId\('sess'\)/)
  })

  it('事件流只收结构性事件，逐字流式增量不落盘', () => {
    assert.match(main, /if \(!e\.type\.endsWith\('-delta'\)\) \{/)
    assert.match(main, /projection\?\.append\(e\)/)
    assert.match(fileStoreSrc, /export async function atomicWrite/)
  })

  it('开场快照必须晚于编排器构造', () => {
    // liveDigest 读的是编排器状态；写早了会把上一场的结论当成本场的开场
    const started = main.slice(main.indexOf('async function startSession'))
    const built = started.indexOf('orchestrator = new Orchestrator(')
    const first = started.indexOf('applyLiveDigest()')
    assert.ok(built > 0 && first > built, 'applyLiveDigest() 不能早于 new Orchestrator(...)')
    assert.match(started.slice(0, built), /projection = new SessionProjection/)
    // 单轮墙钟按这一轮实际等的通道取，不再是写死的 240s
    assert.match(started.slice(built, first), /roundWallClockMs: roundWallClockMs\(/)
  })

  it('收尾补终态快照并停笔，投影写失败不得拖累报告', () => {
    assert.match(main, /projection\?\.append\(\{ type: 'session-end', reason, sessionId \}\)/)
    assert.match(main, /applyLiveDigest\(reason\)/)
    assert.match(main, /await projection\?\.close\(\)/)
    assert.match(projSrc, /this\.queue = this\.queue/)
    assert.match(projSrc, /this\.writeFailures \+= 1/)
  })

  it('删会话要连投影和日志切片一起删', () => {
    assert.match(fileStoreSrc, /\$\{id\}\.digest\.md/)
    assert.match(fileStoreSrc, /\$\{id\}\.events\.jsonl/)
    assert.match(fileStoreSrc, /\$\{id\}\.diag\.jsonl/)
  })

  const tmpRoot = path.join(ROOT, 'scripts', `.tmp-projection-${process.pid}`)
  await fs.rm(tmpRoot, { recursive: true, force: true })
  try {
    await itAsync('真实写盘：事件按发生顺序追加，快照整体替换不留中途态', async () => {
      const p = new SessionProjection(path.join(tmpRoot, 'ok'), projMeta('sess_ok'))
      for (let i = 0; i < 30; i++) p.append({ type: 'utterance-done', seq: i })
      p.writeDigest(projSnap('V1'))
      p.append({ type: 'moderator', seq: 99 })
      p.writeDigest(projSnap('V2'))
      await p.flush()

      const lines = (await fs.readFile(p.eventsPath, 'utf8')).trim().split(/\r?\n/)
      assert.equal(lines.length, 31)
      assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [...Array(30).keys(), 99])
      assert.ok(lines.every((l) => typeof JSON.parse(l).ts === 'number'))

      const md = await fs.readFile(p.digestPath, 'utf8')
      assert.ok(md.includes('V2') && !md.includes('V1'), '快照必须是整体替换，不能残留上一版')
      assert.ok(md.includes('共识度 60') && md.includes('分歧乙 V2') && md.includes('甲模型'))
      assert.ok(md.includes('主持：主持模型'))
      // 内部 id 一旦漏进快照，读者就对不上「是谁说的」，展示名必须全程换好
      assert.ok(!md.includes('m_a') && !md.includes('m_m'), '快照里漏出了内部 agent id')
      // 原子写的临时文件必须清干净，否则目录里全是垃圾
      assert.deepEqual((await fs.readdir(path.join(tmpRoot, 'ok'))).sort(), [
        'sess_ok.digest.md',
        'sess_ok.events.jsonl',
      ])
    })

    await itAsync('写不进也不能拖累讨论：记失败、队列照跑、flush 不抛', async () => {
      const dir = path.join(tmpRoot, 'blocked')
      await fs.mkdir(dir, { recursive: true })
      // 把两个目标名占成目录：append 与 rename 都会稳定失败
      await fs.mkdir(path.join(dir, 'sess_bad.events.jsonl'))
      await fs.mkdir(path.join(dir, 'sess_bad.digest.md'))
      const p = new SessionProjection(dir, projMeta('sess_bad'))
      p.append({ type: 'utterance-done' })
      p.writeDigest(projSnap('V'))
      await p.flush()
      p.append({ type: 'moderator' })
      await p.flush()
      assert.ok(p.failures >= 2, `应记下至少两次写入失败，实际 ${p.failures}`)
    })

    await itAsync('close 之后停笔：迟到的事件不会再写', async () => {
      const p = new SessionProjection(path.join(tmpRoot, 'closed'), projMeta('sess_done'))
      p.append({ type: 'a' })
      await p.close()
      p.append({ type: 'late' })
      p.writeDigest(projSnap('LATE'))
      await p.flush()
      const lines = (await fs.readFile(p.eventsPath, 'utf8')).trim().split(/\r?\n/)
      assert.equal(lines.length, 1)
      assert.equal(await fs.readdir(path.join(tmpRoot, 'closed')).then((f) => f.length), 1)
    })

    await itAsync('store.remove 清掉一场会话在盘上的所有侧面', async () => {
      const dir = path.join(tmpRoot, 'store')
      const store = new FileSessionStore(dir)
      await store.init()
      const id = 'sess_del'
      await fs.mkdir(path.join(dir, 'reports'), { recursive: true })
      for (const f of [`${id}.json`, `${id}.digest.md`, `${id}.events.jsonl`, `${id}.diag.jsonl`, `reports/${id}.json`]) {
        await fs.writeFile(path.join(dir, f), '{}', 'utf8')
      }
      await store.remove(id)
      assert.deepEqual((await fs.readdir(dir)).filter((x) => x !== 'reports'), [])
      assert.deepEqual(await fs.readdir(path.join(dir, 'reports')), [])
    })
    await itAsync('真编排器跑完一场：讨论中每个结构节点都刷新快照，完整发言入流', async () => {
      const base = projMeta('sess_live')
      // 无主持降级：投影快照的 config 必须与真跑的那份一致，否则快照会谎称有主持
      const config: SessionConfig = { ...base.config, moderatorId: null }
      const meta = { ...base, config }
      const agents = new Map<string, Agent>()
      for (const [id, name] of [
        ['m_a', '甲模型'],
        ['m_b', '乙模型'],
      ] as const) {
        agents.set(id, {
          id,
          displayName: name,
          transport: 'api',
          color: '#888888',
          status: 'ready',
          send: async (ctx) => ({
            content: `第 ${ctx.round} 轮 ${name}：应当采用方案 X，理由是落地成本更低。`,
            usage: { promptTokens: 10, completionTokens: 20, costUsd: 0.001 },
            targets: [],
          }),
          healthCheck: async () => true,
          dispose: () => undefined,
        })
      }

      const orch = new Orchestrator({ ...meta.topic, background: '' }, config, {
        getAgent: (id) => agents.get(id),
        getModerator: () => null,
      })
      const p = new SessionProjection(path.join(tmpRoot, 'live'), meta)
      p.append({ type: 'session-start', sessionId: 'sess_live' })
      // 主进程的 liveDigest 长在 electron 模块里，这里按同一契约重算
      orch.on('event', (e: OrchestratorEvent) => {
        if (e.type.endsWith('-delta')) return
        p.append(e)
        p.writeDigest({
          state: orch.getState(),
          round: orch.getRound(),
          confirmed: orch.getConsensusPoints(),
          open: orch.getOpenDisputes(),
          scores: orch.getScores(),
          latest: orch.getAllUtterances().map((u) => ({
            round: u.round,
            agent: u.human ? '人类参与者' : (agents.get(u.agentId)?.displayName ?? u.agentId),
            snippet: u.content.slice(0, 160),
            absent: !!u.absent,
          })),
          spentUsd: orch.getSpentUsd(),
        })
      })
      await orch.run()
      await p.close()

      const types = (await fs.readFile(p.eventsPath, 'utf8'))
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l).type as string)
      assert.ok(types.includes('utterance-done'), `事件流里没有完整发言：${types.join(',')}`)
      assert.ok(types.includes('done'), '没有收尾事件')
      assert.ok(!types.some((t) => t.endsWith('-delta')), '逐字增量漏进了事件流')

      const md = await fs.readFile(p.digestPath, 'utf8')
      assert.ok(md.includes('应当采用方案 X'), `快照里看不到发言内容：\n${md}`)
      assert.ok(md.includes('甲模型') && md.includes('乙模型'))
      assert.ok(md.includes('主持：无'), '无主持降级必须在快照上看得出来')
      assert.ok(md.includes('主持：无'), '无主持降级时快照要照实说明')
    })
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }

  console.log('\n=== 品牌层与打包：图标容器、托盘、单实例、asar 内容 ===')
  const builderYml = await readSrc('electron-builder.yml')
  const pkgJson = JSON.parse(await readSrc('package.json'))
  const iconsScript = await readSrc('scripts/make-icons.js')
  const ico = await fs.readFile(path.join(ROOT, 'resources', 'brand', 'icon.ico'))
  const icns = await fs.readFile(path.join(ROOT, 'resources', 'brand', 'icon.icns'))

  it('品牌资源不在 build/ 下（那是 electron-builder 的默认资源目录）', () => {
    assert.match(iconsScript, /path\.join\(ROOT, 'resources', 'brand'\)/)
    assert.match(main, /path\.join\(ROOT, 'resources', 'brand'/)
    assert.doesNotMatch(`${iconsScript}${main}`, /'build',\s*'brand'/)
  })

  it('.ico 每张图都能解析回来，Windows 外壳才有自己的牌子', () => {
    assert.equal(ico.readUInt16LE(0), 0, 'ICO 保留头')
    assert.equal(ico.readUInt16LE(2), 1, '类型必须是 1（图标）')
    const count = ico.readUInt16LE(4)
    assert.ok(count >= 6, `目录里只有 ${count} 张，任务栏/文件管理器缩放会糊`)
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16
      const off = ico.readUInt32LE(entry + 12)
      assert.equal(ico.slice(off, off + 8).toString('hex'), '89504e470d0a1a0a', `第 ${i} 张不是 PNG`)
      const dirSide = ico.readUInt8(entry) === 0 ? 256 : ico.readUInt8(entry)
      assert.equal(ico.readUInt32BE(off + 16), dirSide, `第 ${i} 张目录写 ${dirSide}、图里是 ${ico.readUInt32BE(off + 16)}`)
    }
  })

  it('.icns 覆盖到 1024（macOS 只认这个容器里的高清档）', () => {
    assert.equal(icns.toString('ascii', 0, 4), 'icns')
    assert.equal(icns.readUInt32BE(4), icns.length, 'ICNS 总长与实际字节不符')
    const types: string[] = []
    for (let p = 8; p < icns.length; ) {
      const len = icns.readUInt32BE(p + 4)
      types.push(icns.toString('ascii', p, p + 4))
      p += len
    }
    assert.ok(types.includes('ic09') && types.includes('ic10'), `缺 512/1024 档：${types.join(',')}`)
  })

  it('托盘在位，退出时撤掉句柄', () => {
    assert.match(main, /new Tray\(icon\)/)
    assert.match(main, /tray\?\.destroy\(\)/)
    // 托盘只做快捷入口：关掉主窗口仍然退出，不能变成「进程活着、界面无从下手」
    assert.match(main, /app\.on\('window-all-closed'[\s\S]{0,160}process\.platform !== 'darwin'\) app\.quit\(\)/)
  })

  it('单实例锁只给打包版，开发/诊断脚本共用 userData 时不能被锁挡掉', () => {
    assert.match(main, /if \(app\.isPackaged\) \{[\s\S]{0,160}requestSingleInstanceLock\(\)/)
    assert.match(main, /app\.on\('second-instance', revealMainWindow\)/)
  })

  it('userData 目录名钉死：productName 改了也不能把登录态「搬家」', () => {
    assert.equal(pkgJson.productName, 'Torra')
    const setName = main.indexOf("app.setName('torra')")
    assert.ok(setName > -1, '要显式把应用名钉成小写 torra')
    assert.ok(setName < main.indexOf('app.whenReady()'), 'setName 必须早于 ready，否则 userData 已经按新名字算好了')
  })

  it('打包配置把运行时要读的东西都装进 asar', () => {
    assert.match(builderYml, /appId: com\.torra\.app/)
    assert.match(builderYml, /icon: resources\/brand\/icon\.ico/)
    assert.match(builderYml, /- nsis/)
    assert.match(builderYml, /- portable/)
    assert.match(builderYml, /- adapters\/\*\*/, '内置适配器不进包，装完就是空壳')
    assert.match(builderYml, /- dist\/\*\*/)
    assert.match(builderYml, /- resources\/brand\/icon-256\.png/, '窗口/托盘图标要在 asar 里')
    // buildResources 一旦指到品牌目录，electron-builder 会连带把它从 asar 里排除
    assert.doesNotMatch(builderYml, /buildResources:\s*resources/)
    assert.match(builderYml, /'\*\*\/\*\.\{map,tsbuildinfo\}'|!\*\*\/\*\.\{map,tsbuildinfo\}/, 'sourcemap 不进包（55MB 死重）')
    // v26 检测到 CI 就隐式触发发布，缺 GH_TOKEN 时整条 dist 以「Token is not set」失败：
    // 本机怎么都能跑通，只有 CI 红，所以这条必须钉在配置里而不是靠人记得加参数。
    assert.match(builderYml, /^publish:\s*null/m, '打包不许走发布通道')
  })

  it('图标脚本自己校验产物，坏容器不会等到打包时才炸', () => {
    assert.match(iconsScript, /function pngSize/)
    assert.match(iconsScript, /function buildIco/)
    assert.match(iconsScript, /function buildIcns/)
    assert.match(iconsScript, /读回校验/)
    // app.exit 要等一轮消息循环，校验失败必须用 process.exit 才拦得住后面的日志
    assert.doesNotMatch(iconsScript.slice(iconsScript.indexOf('读回校验')), /app\.exit\(1\)/)
  })

  it('中文行内强调：把冒号挪出粗体，否则整条小标题会露出星号', () => {
    // CommonMark 的 right-flanking 规则不认「闭合竖线前是标点、后接中文」，中文里最典型的
    // `**立场：**正文` 因此根本不进强调语法；把标点移出闭合标记才合规。
    assert.equal(mdExcerpt('**立场：**支持懒加载。'), '**立场**：支持懒加载。')
    // 后面已经接空白/标点的写法本来就能渲染，不能多此一举改掉用户的加粗范围
    assert.equal(mdExcerpt('**立场：** 支持懒加载。'), '**立场：** 支持懒加载。')
    assert.equal(mdExcerpt('结论是**可行的。** 下一步'), '结论是**可行的。** 下一步')
    // 文本里的字面星号不是「没闭合的粗体」，不能补出一个大黑块
    assert.equal(mdExcerpt('公式 a**b 的运算。'), '公式 a**b 的运算。')
  })

  it('论点摘要：块级标记压成单段，截断要闭合且留省略号', () => {
    const s = mdExcerpt('## 结论\n- 甲方案\n- 乙方案\n\n第二段带 **强调**（`load()`）。')
    assert.doesNotMatch(s, /[\n#]/)
    assert.ok(!/^\s*-/.test(s), '列表标记不能被当成正文留在行首')
    assert.match(s, /第二段带 \*\*强调\*\*/)
    // 长文按句末收口，切在粗体中间要补闭合，否则半个 `**` 会印出来
    const cut = mdExcerpt('立场：**渐进式懒加载在首屏请求从 2 万次降到 200 次之后收益递减，'.repeat(6))
    assert.ok(cut.length <= 168, `摘要不该溢出卡片：${cut.length}`)
    assert.ok(cut.endsWith('…'), '被截断要显式收尾')
    assert.equal((cut.match(/\*\*/g) ?? []).length % 2, 0, '粗体标记必须成对')
    // 代码块在两三行的卡片里只会挤掉结论，整段去掉
    assert.equal(mdExcerpt('```js\nconst a = 1\n```\n结论：可用。'), '结论：可用。')
    // 网页通道老记录里引用号独占一行，会把句子竖排割裂
    assert.equal(mdExcerpt('首屏请求下降-\n4\n。这是抓回来的格式'), '首屏请求下降-4。这是抓回来的格式')
  })

  it('纯文本位（chip / SVG 节点 / 原生 title）不留任何 markdown 标记', () => {
    assert.equal(plainMd('带链接的 [参考](https://example.com) 与 ~~删除~~'), '带链接的 参考 与 删除')
    assert.equal(plainMd('- **多Agent协作**方案', 14), '多 Agent 协作方案')
    assert.equal(plainMd('立场：**没闭合的半截'), '立场：没闭合的半截')
    assert.equal(plainMd('立场：**支持**渐进式懒加载与预取策略', 12), '立场：支持渐进式懒加载与…')
  })

  it('议事厅正文保留分段与小标题加粗，中英交界补空格', () => {
    const s = formatSpeech('立场：支持懒加载。论据：首屏请求从2万次降到200次。')
    assert.equal(s.split('\n\n').length, 2, '行内小标题要断成两段')
    assert.match(s, /\*\*立场\*\*：/)
    assert.match(s, /从 2 万次/)
    // 句中的「例如：」只是引出例子，抬成一段会把句子劈成两截
    assert.equal(
      formatSpeech('这一步很快完成了。例如：某站点的首屏。'),
      '这一步很快完成了。例如：某站点的首屏。',
    )
    // 段首标签不能跨过句末标点，否则一整句会被抬成粗体
    assert.doesNotMatch(formatSpeech('这一步很快完成了。结论：可用。'), /\*\*这一步/)
  })

  console.log('\n=== 默认参与名单：把「这场要等多久」在开场前定下来 ===')

  const cand = (
    id: string,
    transport: TransportKind,
    over: Partial<{ enabled: boolean; hasKey: boolean; status: string }> = {},
  ) => ({
    id,
    transport,
    enabled: over.enabled ?? true,
    hasKey: over.hasKey ?? transport === 'api',
    status: over.status ?? (transport === 'api' ? 'ready' : 'ready'),
  })

  it('可用判定只有一处：API 看 Key、网页看登录态、禁用一律不算', () => {
    const list = [
      cand('api_ok', 'api'),
      cand('api_nokey', 'api', { hasKey: false }),
      cand('web_ready', 'webview'),
      cand('web_out', 'webview', { status: 'expired' }),
      cand('off', 'api', { enabled: false }),
    ]
    assert.deepEqual(usableModels(list).map((m) => m.id), ['api_ok', 'web_ready'])
  })

  it('API 够两个就只选 API —— 网页模型进默认名单等于给每轮加一分钟', () => {
    const list = [cand('a1', 'api'), cand('a2', 'api'), cand('w1', 'webview'), cand('w2', 'webview')]
    assert.deepEqual(pickDefaultParticipants(list, null), ['a1', 'a2'])
  })

  it('API 不够时补网页模型，但仍受上限约束', () => {
    const list = [cand('a1', 'api'), cand('w1', 'webview'), cand('w2', 'webview'), cand('w3', 'webview')]
    const picked = pickDefaultParticipants(list, null)
    assert.deepEqual(picked, ['a1', 'w1', 'w2'])
    assert.ok(picked.length <= DEFAULT_PARTICIPANT_CAP, '默认名单不能无限扩')
  })

  it('主持不占默认名额（兼发言要人自己在胶囊上勾）', () => {
    const list = [cand('a1', 'api'), cand('a2', 'api'), cand('a3', 'api')]
    assert.deepEqual(pickDefaultParticipants(list, 'a1'), ['a2', 'a3'])
  })

  it('一个 API 都没有时仍给出名单：能开场比开场快更重要', () => {
    const list = [cand('w1', 'webview'), cand('w2', 'webview'), cand('w3', 'webview')]
    assert.equal(pickDefaultParticipants(list, null).length, DEFAULT_PARTICIPANT_CAP)
  })

  it('墙钟按通道取：纯 API 场不必等满 4 分钟，混进网页就回退', () => {
    assert.equal(roundWallClockMs(['api', 'api']), 90_000)
    assert.equal(roundWallClockMs(['api', 'webview']), 240_000)
    assert.equal(roundWallClockMs([]), 90_000, '空名单按快的一侧算，别让一场空讨论等满 4 分钟')
  })

  it('通道构成只数已选里的模型，认不出的 id 不臆造', () => {
    const list = [cand('a1', 'api'), cand('w1', 'webview')]
    assert.deepEqual(channelMix(['a1', 'w1', 'ghost'], list), { api: 1, webview: 1 })
  })

  console.log('\n=== 议事厅读得下去：钉底、一键直达、说清为什么停 ===')

  const flow = await readSrc('src/renderer/components/DiscussionFlow.tsx')
  const ivBar = await readSrc('src/renderer/components/InterventionBar.tsx')
  const cpanel = await readSrc('src/renderer/components/ConsensusPanel.tsx')
  const appSrc = await readSrc('src/renderer/App.tsx')
  const orch = await readSrc('src/main/orchestrator/orchestrator.ts')
  const css = await readSrc('src/renderer/styles.css')

  it('自动滚动只在贴底时生效 —— 用户往上翻就该归他', () => {
    assert.match(flow, /if \(!pinned\) return/)
    assert.match(flow, /scrollHeight - el\.scrollTop - el\.clientHeight <= STICK_BOTTOM_PX/)
    assert.match(flow, /onScroll=\{onFlowScroll\}/)
    assert.match(css, /\.df-jump \{[^}]*position: sticky/)
  })

  it('点「追问 / 对辩」当场切模式、选目标、聚焦输入框', () => {
    assert.match(ivBar, /setMode\(pending\.kind\)/)
    assert.match(ivBar, /setTarget\(pending\.agentId\)/)
    assert.match(ivBar, /taRef\.current\?\.focus\(\)/)
    assert.match(storeSrc, /kind: 'followup' \| 'duel'/)
  })

  it('动作只剩「挂上目标」一件事，指令式 toast 已删干净', () => {
    assert.match(appSrc, /setPendingFollowup\(\{ agentId, utteranceId, topic, kind: 'followup' \}\)/)
    assert.match(appSrc, /kind: 'duel' \}\)/)
    assert.doesNotMatch(appSrc, /请切到「追问」/)
    assert.doesNotMatch(appSrc, /请切到「对辩」/)
  })

  it('结束原因从 done 一路留到界面，回放历史也带着', () => {
    assert.match(storeSrc, /finishedReason: e\.reason/)
    assert.match(storeSrc, /finishedReason: rec\.finishedReason \?\? null/)
    assert.match(flow, /FINISH_REASON_LABEL\[finishedReason\]/)
    assert.match(flow, /第 \{round\} 轮结束/)
  })

  /**
   * 编排器以后加一种结束原因，议事厅不能只显示英文枚举 ——
   * 「为什么停」是这份结论可信度的第一判据，漏一种等于漏一场。
   */
  it('每种结束原因都用人话说了这份结论该怎么用', () => {
    const block = flow.match(/const FINISH_HINT[\s\S]*?\n\}/)?.[0] ?? ''
    const flat = block.replace(/'/g, '')
    const reasons = orch.match(/finish\(reason: ([^)]+)\)/)?.[1] ?? ''
    const keys = reasons.match(/'[a-z-]+'/g) ?? []
    assert.ok(keys.length >= 5, `编排器应至少给出五种结束原因，实际 ${keys.length}`)
    for (const raw of keys) {
      const k = raw.slice(1, -1)
      assert.ok(flat.includes(`${k}:`), `FINISH_HINT 缺少 ${k} 的解释`)
    }
    assert.ok(flat.includes('轮次用尽时仍未收敛'), '轮次用尽必须和真收敛区分开')
  })

  it('核验结论实时出现在共识点上，不用等报告', () => {
    assert.match(cpanel, /c\.verification/)
    assert.match(cpanel, /verified: \{ text: '已核验'/)
    assert.match(cpanel, /无实质支持者/)
    assert.match(cpanel, /未核对/)
    assert.match(cpanel, /const corrections = useStore\(\(s\) => s\.corrections\)/)
  })

  /**
   * 两个 tab 的分工是这次重写的全部理由：演化页只当索引，结论页把主持产出、
   * 此前被界面丢掉的字段摊开。断言盯住「这些字段真的进了 DOM」，
   * 否则下次改动很容易又退回成两份一样的清单。
   */
  it('共识结果页讲结论与依据，不复述演化页的一句话摘要', () => {
    assert.match(cpanel, /s\.argument/, '分歧要给出双方论点原文，不只是「A vs B」')
    assert.match(cpanel, /c\.evidenceRef/, '共识点要能展开到具体发言')
    assert.match(cpanel, /c\.variants/, '归并前的其他措辞要留着，归并不是改写历史')
    assert.match(cpanel, /c\.confidence/, '有多确信')
    assert.match(cpanel, /c\.weight/, '有多少证据')
    assert.match(cpanel, /d\.lastProgress/, '分歧最近有没有进展要说清')
    assert.match(cpanel, /onLocate/, '依据要能在演化图上定位')
    assert.match(cpanel, /cs-ledger/, '审计/名次/花费收进抽屉，不占正文')
    assert.doesNotMatch(
      cpanel,
      /认同 \{c\.support\.map\(nameOf\)\.join\('、'\)\} · 第/,
      '「认同 X、Y · 第 N 轮」这种摘要归演化页，两份并排就是重复',
    )
  })

  console.log('\n=== 论题演化：结论落点是一张读得完的清单，不是一排胶囊 ===')

  const topic = await readSrc('src/renderer/components/TopicEvolution.tsx')

  it('落点按类型归组，正文给到能读的长度', () => {
    assert.match(topic, /const groups = useMemo/, '要先按共识/分歧/已消解归组')
    assert.match(topic, /tl-group-head/, '每组要有小标题和计数')
    assert.match(topic, /mdExcerpt\(e\.claim, 96\)/, '行内要过 markdown，不是截 18 个字符')
    assert.doesNotMatch(topic, /plainMd\(e\.claim, \d+\)/, '清单行不该再退成纯文本胶囊')
  })

  it('旧的 chips 层连 DOM 带样式一起删干净', () => {
    assert.doesNotMatch(topic, /te-chip|te-chips/)
    assert.doesNotMatch(css, /\.te-chip|\.te-chips|\.te-dot\b/, '覆盖层修补不算重做')
  })

  it('清单行是选中项：悬停预览、点击锁定、键盘能走到', () => {
    assert.match(topic, /aria-pressed=\{isPinned\}/)
    assert.match(topic, /onFocus=\{\(\) => setHover\(e\.id\)\}/)
    assert.match(topic, /onBlur=\{\(\) => setHover\(null\)\}/)
    assert.match(css, /\.tl-item:focus-visible \{ outline: 2px solid var\(--accent\)/)
    assert.match(topic, /pinnedEndpoint && \(/, '锁定后要能一键退回跟随最新落点')
  })

  /**
   * 清单和图抢同一列高度：谁都不许把对方挤到看不见。
   * 面板压矮时先缩清单，卡片区的 bottom 必须留在画布内 —— 之前就是这里被切掉 26px。
   */
  it('清单和图分高度：图有底线，清单先让步', () => {
    assert.match(css, /\.tl \{[^}]*flex: 0 3 auto/, '清单让步要比图快')
    assert.match(css, /\.tl \{[^}]*max-height: 38%/)
    assert.match(css, /\.te-canvas \{[^}]*min-height: 330px/, '画布没有底线就会切掉卡片区')
    assert.match(css, /\.te-notes \{[^}]*flex: 0 1 auto/)
    assert.match(css, /\.tl-scroll \{[^}]*overflow-y: auto/)
  })

  it('清单层只用主题 token，明暗两版不用各写一套', () => {
    const block = css.slice(css.indexOf('.tl {'), css.indexOf('.tl-pin'))
    assert.ok(block.length > 400, '取到的是清单这一层')
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}/, '不许写死色值')
    assert.doesNotMatch(block, /rgba?\(/, '不许写死色值')
  })

  it('新落点的行跟着它的轴点一起出现，降级动画时整条消失不了', () => {
    assert.match(topic, /animationDelay: `\$\{delayOfEndpoint\(e\.id\) \+ 300\}ms`/)
    assert.match(css, /@keyframes tl-in/)
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,320}\.tl-item \{ animation: none !important; \}/)
  })

  console.log('\n=== 报告：一眼能看出哪几节是结论，哪几节是过程 ===')

  const rp = await readSrc('src/renderer/components/ReportViewer.tsx')

  /**
   * `.modal p` 是 (0,1,1)，单类选择器压不住它 —— hero 标题会被静默打回 14px 灰字，
   * 整份报告重新变回「所有文字一样大」。这三条是这套层级唯一的承重墙。
   */
  it('hero 标题保住大字，且不被 .modal p 打回去', () => {
    assert.match(css, /\.report-body \.rp-hero-headline \{[^}]*font-size: 19px/, 'hero 标题要带 .report-body 才压得住 .modal p')
    assert.match(css, /\.report-body \.rp-lead \{/, '正文段同样要被 .modal p 让路')
    assert.match(css, /\.report-body \.rp-hero-headline \{[^}]*color: var\(--text\)/)
  })

  it('章节分四档，档位写在 DOM 上而不是靠文字描述', () => {
    assert.match(rp, /tier = 'plain'/)
    assert.match(rp, /className=\{`rp-sec rp-sec-\$\{tier\}`\}/)
    for (const k of ['rp-sec-key', 'rp-sec-risk', 'rp-sec-meta']) {
      assert.ok(css.includes(`.${k} `), `${k} 样式层要存在`)
    }
    assert.match(rp, /n="02" tier="key" accent="var\(--consensus\)"/)
    assert.match(rp, /n="03" tier="key" accent="var\(--dispute\)"/)
    assert.match(rp, /n="10" tier="key"/, '下一步建议和结论同档')
    assert.match(rp, /tier="meta" title="溯源与口径"/, '口径是附注，不该和结论同权重')
  })

  it('结果数字与过程数字分家：九个等大格子换成两个大数加一行小字', () => {
    assert.doesNotMatch(rp, /rp-stat|className="rp-stats"/, '旧等大方格已删')
    assert.doesNotMatch(css, /\.rp-stat\b|\.rp-stats\b/, '旧等大方格的样式也已删')
    assert.match(css, /\.rp-outcome-n \{[^}]*font-size: 24px/)
    assert.match(css, /\.rp-fstat \{[^}]*font-size: 10\.5px/, '过程计数要明显小一档')
    assert.match(rp, /<Fstat k="缺席事件"[^>]*warn=\{r\.stats\.absentCount > 0\}/, '缺席只在发生时才着色的')
  })

  it('空章节不该比有内容的章节更醒目', () => {
    assert.doesNotMatch(css, /\.rp-empty \{[^}]*dashed/, '空态不画虚线盒')
    assert.match(css, /\.rp-empty \{[^}]*color: var\(--text-4\)/)
  })

  it('报告层只用主题 token，明暗两版不用各写一套', () => {
    const block = css.slice(css.indexOf('.rp-figs {'), css.indexOf('.rp-sec {'))
    assert.ok(block.length > 400, '取到的是数字这一层')
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}/, '不许写死色值')
    assert.doesNotMatch(block, /rgba?\(/, '不许写死色值')
  })

  console.log(`\n${'='.repeat(46)}`)
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46) + '\n')

  process.exit(fail > 0 ? 1 : 0)
}

void main()
