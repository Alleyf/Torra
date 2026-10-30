/**
 * 运行时冒烟测试
 *
 * 目的：验证构建产物在真实 Electron 运行时中能正确渲染三区布局，
 * 且无渲染层控制台错误。同时输出一张截图供视觉核查。
 *
 * 做法：注册与主进程一致的 IPC handler，让 preload 的真实 torra API 可用，
 * 不做任何 stub 注入（stub 会被 reload 清掉且掩盖真实问题）。
 */

const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const REPORT = path.join(ROOT, 'docs', 'smoke-report.json')
/** 冒烟环境用 CLI 指定冷启动主题，代替真实主进程从 preferences.json 解析 */
const BOOT_THEME = process.argv.includes('--theme=light') ? 'light' : 'dark'
// --show 才真的显示窗口：capturePage 对隐藏窗口会给空帧/过期帧，网页视图还挂着时
// 干脆不 resolve；只有可见窗口经 CDP 抓到的图才是用户实际看到的那一帧。
const SHOW_WIN = process.argv.includes('--show')
// --docs-shots：在同一条流程的三个节点额外留下 README 用的整窗图（scripts/capture-docs.mjs 传）。
// 断言照跑 —— 出图不该绕过测试，绕过测试的图也就没法证明它是真界面。
const DOCS_SHOTS = process.argv.includes('--docs-shots')

app.disableHardwareAcceleration()

/**
 * 冒烟用自己的 userData 目录。
 *
 * 不用默认目录是有原因的：默认目录就是真实应用的目录，上一次冒烟残留的
 * Electron 进程还攥着它的 Chromium 缓存锁 —— 新实例建不出缓存，
 * loadFile 直接 ERR_FAILED(-2)，整轮冒烟卡在「渲染层加载不完」。
 * 症状看着像渲染层炸了，其实是两个实例抢同一个目录。
 *
 * 每次跑用一个新的目录（带 pid），跑完删掉：谁也碰不到谁的锁。
 */
const SMOKE_USER_DATA = path.join(os.tmpdir(), `torra-smoke-${process.pid}`)
app.setPath('userData', SMOKE_USER_DATA)

/**
 * 模型图标：冒烟环境不跑真实主进程，因此 torra-icon:// 得由这里自己接住，
 * 否则渲染层会退回直连 6 个公共 favicon 源 —— 出图就成了「今天有网才有图标」，
 * 而且同一台机器上午和下午拍出来的能不一样。改为读 scripts/fixtures/icons/ 里的
 * 本地夹具，夹具由 scripts/make-icon-fixtures.ps1 从应用自己的图标缓存生成。
 * 注册表里没有的域名照样 404，让渲染层走它原有的兜底链。
 */
const ICON_FIXTURES = path.join(ROOT, 'scripts', 'fixtures', 'icons')
protocol.registerSchemesAsPrivileged([
  { scheme: 'torra-icon', privileges: { standard: true, secure: true, stream: true } },
])

/**
 * 出图夹具的模型清单。
 *
 * `domain` 必须照抄真实主进程的口径：src/main/index.ts 的 models:list 只从适配器
 * entry 的 host 推域名，所以网页模型有、API 模型没有（没有就退成首字母头像，
 * 这是渲染层 AvatarWithFavicon 设计好的兜底，不是 bug）。夹具里凭空多给一个域名，
 * README 的图就会显示真实用户看不到的图标 —— 宁可少一个图标，不能多一个假图标。
 */
const MODELS = [
  { id: 'chatgpt', displayName: 'ChatGPT', transport: 'webview', domain: 'chatgpt.com', color: '#5aa9e6', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'claude', displayName: 'Claude', transport: 'webview', domain: 'claude.ai', color: '#d97757', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'gemini', displayName: 'Gemini', transport: 'webview', domain: 'gemini.google.com', color: '#3fb950', enabled: true, supportsStructuredOutput: true, adapterHealth: 'unknown', adapterStale: false, hasKey: true, status: 'expired' },
  // 两个 api 模型故意配成「有 Key / 无 Key」：设置页的检查按钮一个能点、一个必须禁用
  { id: 'deepseek', displayName: 'DeepSeek', transport: 'api', color: '#4d6bfe', enabled: true, supportsStructuredOutput: true, adapterHealth: 'unknown', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'moderator', displayName: '主持 · DeepSeek', transport: 'api', color: '#9a8cff', enabled: true, supportsStructuredOutput: true, adapterHealth: 'unknown', adapterStale: false, hasKey: false, status: 'disabled' },
]

const errors = []
/**
 * 报告是「跑到哪算哪」的。
 *
 * 以前报告只在整轮顺利走完时写：中途崩了或卡死了，这轮就什么也没留下 ——
 * 只剩一句「卡住了」，连已经跑过的那些断言结论都保不住。
 * 现在它挂在模块级，跑一步填一步，finish() 无论走哪条路都会落盘。
 */
const report = { consoleErrors: errors }
global.__ivCalls = []
global.__doctorCalls = []
global.__retryCalls = []
global.__assistantCalls = []
global.__assistantApprovals = []
/**
 * 真主进程的 assistant:send 要等整轮跑完才返回，渲染层的忙碌态靠「invoke 回来 + settled」两条路收。
 * stub 若立刻返回，忙碌态就在几毫秒里被撤掉，测不出「转圈转到 settled 为止」—— 所以把这一轮挂住，
 * 由测试推 settled / error 时放行（abort 也算放行）。
 */
const pendingSends = []
const endAssistantTurn = () => {
  const rs = pendingSends.splice(0, pendingSends.length)
  for (const r of rs) r({ ok: true })
  return rs.length
}

/**
 * 助手模型清单：故意覆盖三条筛选口径 ——
 * api + enabled 才能当助手模型；webview 与停用项必须被 select 排除；
 * 有 api 模型没配 Key 时要在选项里标出来，但绝不带出 Key 的任何片段。
 */
const ASSISTANT_MODELS = [
  { id: 'deepseek', displayName: 'DeepSeek', transport: 'api', enabled: true, hasKey: true, baseUrl: 'https://api.deepseek.com/v1', apiModel: 'deepseek-chat', protocol: 'openai' },
  { id: 'glm', displayName: 'GLM-4.5', transport: 'api', enabled: true, hasKey: false },
  { id: 'paused', displayName: '已停用模型', transport: 'api', enabled: false, hasKey: true },
  { id: 'chatgpt', displayName: 'ChatGPT', transport: 'webview', enabled: true },
]

const ASSISTANT_HISTORY = [
  { role: 'user', text: 'deepseek 上一场为什么没发言？' },
  { role: 'tool', text: '读取流水线日志', toolName: 'read_log', ok: true },
  { role: 'assistant', text: '第 2 轮它的三次请求都在 20s 后超时，判定为网络侧问题。' },
]

global.__acpCalls = []

/**
 * ACP 注册表（冒烟用）。
 *
 * 故意留两家：一家收 http 形态的 MCP（工具包挂得上），一家不收（挂不上）。
 * 界面如果把工具包一律画成「已挂上」，在这份数据上就该露馅。
 */
const ACP_AGENTS = [
  {
    id: 'claude',
    title: 'Claude Code',
    blurb: 'Anthropic 的编码智能体，经官方 ACP 适配器接入',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.99.1'],
    package: { name: '@agentclientprotocol/claude-agent-acp', version: '0.99.1' },
    authHint: '适配器直接读你本机已有的 Claude Code 登录态与设置；没登录过就先在终端里登录一次',
    notes: ['它自带权限模式（Manual / Plan / Accept edits / Auto），Torra 默认不提供最后一档'],
    source: 'builtin',
  },
  {
    id: 'pi',
    title: 'pi',
    blurb: 'pi 编码智能体，经社区 ACP 适配器接入',
    command: 'npx',
    args: ['-y', 'pi-acp@0.0.34'],
    package: { name: 'pi-acp', version: '0.0.34' },
    authHint: '协议给的方式是「在终端里启动一次 pi 完成登录」',
    notes: ['它的 mode 是思考档（low / high / xhigh / max），不是权限档'],
    source: 'builtin',
  },
  {
    // 第三家只为覆盖矩阵徽标的第三种状态（压根没测过）
    id: 'codex',
    title: 'Codex',
    blurb: 'OpenAI 的编码智能体，经官方 ACP 适配器接入',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@2.5.0'],
    package: { name: '@agentclientprotocol/codex-acp', version: '2.5.0' },
    authHint: '协议给了两种登录方式：ChatGPT 账号或 API Key',
    notes: ['它的 mode 是沙箱档位（只读 / 工作区可写 / 自动审查 / 完全放开），与权限不是一回事'],
    source: 'builtin',
  },
]

/**
 * 协商结果（冒烟用）。
 *
 * 档位分成两组：mode 来自协议里的 modes，config 来自 configOptions。
 * 两组都要画成下拉，但发出去的方法不同 —— 界面只管画，不管发。
 * 「免掉全部授权」那一档已经不在里面了：主进程在协商那一步就摘掉了。
 */
const ACP_CAPS = {
  protocolVersion: 1,
  agentName: 'claude-code-acp',
  agentTitle: 'Claude Code',
  agentVersion: '2.1.312',
  loadSession: true,
  mcpHttp: true,
  mcpSse: false,
  sessionCapabilities: ['load', 'list', 'delete'],
  promptCapabilities: ['image'],
  authMethods: [{ id: 'anthropic-api', name: 'Anthropic 账号或 API Key' }],
  toolPack: { attached: true, tools: 6 },
  selects: [
    {
      id: 'permissionMode',
      name: '权限模式',
      category: 'mode',
      kind: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default', description: '每次改动前问一次' },
        { value: 'acceptEdits', name: 'Accept Edits', description: '文件改动直接落盘' },
        { value: 'plan', name: 'Plan', description: '只出计划，不动手' },
      ],
    },
    {
      id: 'model',
      name: '模型',
      category: 'model',
      kind: 'config',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    },
  ],
}

function installFixtureIcons() {
  // 魔数识别直接吃主进程那份实现，别在这儿抄第二份：它认得 webp/ico/svg，
  // 抄一份漏了 webp，ChatGPT 的图标就会在冒烟环境里凭空消失。
  let sniff
  try {
    sniff = require(path.join(ROOT, 'dist', 'main', 'net', 'favicon-cache')).sniffMime
  } catch (e) {
    console.log('[icons] 载入 sniffMime 失败，跳过 torra-icon：' + String(e && e.message))
    return
  }
  protocol.handle('torra-icon', async (request) => {
    let host = ''
    try {
      host = new URL(request.url).hostname
    } catch {
      /* 交给下面的 400 */
    }
    const file = path.join(ICON_FIXTURES, host)
    if (!/^[a-z0-9.-]+$/i.test(host) || !file.startsWith(ICON_FIXTURES) || !fs.existsSync(file)) {
      return new Response('miss', { status: 404 })
    }
    const buf = fs.readFileSync(file)
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': sniff(buf) || 'application/octet-stream',
        'Cache-Control': 'no-store',
        // 渲染层的 <img> 带 crossOrigin="anonymous"，缺这个头会被 CORS 拦下
        'Access-Control-Allow-Origin': '*',
      },
    })
  })
}

function registerStubs() {
  ipcMain.handle('risk:acknowledge', () => ({ ok: true }))
  // 一次性引导：冒烟环境当作「已经看过」，免得首页多出一块把既有断言的坐标系挪走
  ipcMain.handle('onboarding:state', () => ({ show: false }))
  ipcMain.handle('onboarding:dismiss', () => ({ ok: true }))
  ipcMain.handle('models:list', () => MODELS)
  // 渲染层在存在不可用模型时会轮询该通道；冒烟环境不连真实站点，直接返回。
  ipcMain.handle('models:probe', () => ({ ok: true }))
  // 设置页挂载时会问「被隐藏的内置模型」，冒烟环境里没有隐藏任何模型
  ipcMain.handle('models:list-hidden', () => [])
  ipcMain.handle('adapters:list', () => [])
  ipcMain.handle('adapters:check', () => ({ ok: true, health: 'ok' }))
  ipcMain.handle('login:open', () => ({ ok: true }))
  ipcMain.handle('webview:present', () => ({ ok: false }))
  ipcMain.handle('webview:dismiss', () => ({ ok: true }))
  ipcMain.handle('webview:memory', () => ({ estimatedMb: 750, count: 3 }))
  // 网页视图表头的刷新/全屏按钮：冒烟环境没有真站点，回执即可，别让 unhandled rejection 污染断言
  ipcMain.handle('webview:reload', () => ({ ok: true }))
  ipcMain.handle('webview:fullscreen', (_e, on) => ({ ok: true, fullscreen: !!on }))
  ipcMain.handle('webview:pin', (_e, modelIds) => ({
    ok: true,
    count: Array.isArray(modelIds) ? modelIds.length : 0,
  }))
  ipcMain.handle('session:start', () => ({ ok: true }))
  ipcMain.handle('session:interject', (_e, text, target) => {
    const r = { ok: true }
    global.__ivCalls.push({ fn: 'interject', text, target })
    return r
  })
  ipcMain.handle('session:followup', (_e, agentId, text, uttId) => {
    global.__ivCalls.push({ fn: 'followup', agentId, text, uttId })
    return { ok: true }
  })
  ipcMain.handle('session:duel', (_e, agentIds, topic) => {
    global.__ivCalls.push({ fn: 'duel', agentIds, topic })
    return { ok: true }
  })
  ipcMain.handle('session:set-stance', (_e, agentId, stance) => {
    global.__ivCalls.push({ fn: 'setStance', agentId, stance })
    return { ok: true }
  })
  ipcMain.handle('session:stance', () => ({ stance: null }))
  ipcMain.handle('session:pause', (_e, reason) => {
    global.__ivCalls.push({ fn: 'pause', reason })
    return { ok: true }
  })
  ipcMain.handle('session:resume', () => {
    global.__ivCalls.push({ fn: 'resume' })
    return { ok: true }
  })
  ipcMain.handle('session:interventions', () => ({ interventions: [], duels: [] }))
  ipcMain.handle('session:abort', () => ({ ok: true }))
  ipcMain.handle('session:state', () => ({ state: 'INIT', round: 0, spentUsd: 0 }))
  ipcMain.handle('session:list', () => [
    {
      id: 's1', title: '评估为报表系统引入实时计算层的必要性', background: '日均 2 万次查询',
      strategy: 'roundtable', state: 'DONE', finishedReason: 'max-rounds',
      createdAt: Date.now() - 86400000, updatedAt: Date.now() - 3600000,
      rounds: 3, totalCostUsd: 0.0412, consensusCount: 2, openDisputeCount: 1,
      absentAgentIds: ['gemini'], interventionCount: 2, duelCount: 1,
      hasReport: true, retryModeTag: null, statusNote: '轮次用尽仍未收敛',
    },
    {
      id: 's2', title: '是否应该引入双写对账层', background: '',
      strategy: 'debate', state: 'DONE', finishedReason: 'converged',
      createdAt: Date.now() - 172800000, updatedAt: Date.now() - 86400000,
      rounds: 2, totalCostUsd: 0.0188, consensusCount: 3, openDisputeCount: 0,
      absentAgentIds: [], interventionCount: 0, duelCount: 0,
      hasReport: true, retryModeTag: 'continue', statusNote: '结论收敛',
    },
    {
      id: 's3', title: '缓存策略选型', background: '',
      strategy: 'roundtable', state: 'ABORTED', finishedReason: 'aborted',
      createdAt: Date.now() - 259200000, updatedAt: Date.now() - 172800000,
      rounds: 1, totalCostUsd: 0.0061, consensusCount: 0, openDisputeCount: 0,
      absentAgentIds: ['claude', 'gemini'], interventionCount: 1, duelCount: 0,
      hasReport: true, retryModeTag: null, statusNote: '用户中止，结论可能不完整',
    },
  ])
  ipcMain.handle('session:detail', (_e, id) => ({
    report: {
      executiveSummary: '围绕「引入实时计算层」的讨论已结束（轮次用尽）。本场形成 2 条共识、1 项保留分歧。',
      consensus: [
        { claim: 'P95 延迟是当前核心瓶颈', supporters: ['ChatGPT', 'Claude'], sourceRounds: [1, 2] },
        { claim: '批处理 + 缓存可覆盖当前查询量级', supporters: ['ChatGPT', 'Claude'], sourceRounds: [2] },
      ],
      disputes: [{
        claim: '是否需要双写对账层',
        sides: [
          { agentId: 'ChatGPT', argument: '不需要，双写成本高于收益', sourceRounds: [2] },
          { agentId: 'Claude', argument: '需要，否则数字无法对账', sourceRounds: [2] },
        ],
        whyUnresolved: '经多轮讨论仍未能消解，各方论据均未被对方接受。',
      }],
      blindSpots: ['Gemini 在本场讨论中缺席（timeout），其视角未被纳入。'],
      interventions: ['第 2 轮插话：两位的成本估算都缺少人力投入，请补充。（对全员）', '专项对辩「是否需要双写对账层」：ChatGPT vs Claude'],
      duels: [{ topic: '是否需要双写对账层', agentIds: ['ChatGPT', 'Claude'], utteranceCount: 2 }],
      meta: { rounds: 3, totalCostUsd: 0.0412, finalConsensusScore: { score: 71 } },
    },
  }))
  ipcMain.handle('session:remove', () => ({ ok: true }))
  ipcMain.handle('session:retry', (_e, sessionId, plan) => {
    global.__retryCalls.push({ sessionId, plan })
    return { ok: true, notices: ['将从第 1 轮重新开始，不保留上一场任何结论。'] }
  })
  ipcMain.handle('report:get', () => null)
  ipcMain.handle('report:export-markdown', () => ({ ok: true, path: 'C:/tmp/report.md' }))
  ipcMain.handle('report:copy-image', () => ({ ok: true }))
  ipcMain.handle('secrets:set', () => ({ ok: true, encrypted: true }))
  ipcMain.handle('secrets:has', () => ({ has: false }))
  // 设置页「检查有效性」走的是体检的 api 层：桩必须把 opts 露出来，
  // 才能断言它按当前模型收敛（带 modelId），而不是整场体检都跑一遍。
  ipcMain.handle('doctor:run', (_e, opts) => {
    global.__doctorCalls.push(opts ?? {})
    return {
      startedAt: Date.now(),
      finishedAt: Date.now(),
      durationMs: 12,
      userData: 'C:/smoke/userData',
      scope: `model:${String(opts?.modelId ?? 'all')}`,
      blockingLayer: 'api',
      summary: { pass: 2, warn: 0, fail: 1, skip: 0 },
      checks: [
        {
          id: 'env:adapters', layer: 'env', title: '适配器目录可用', status: 'pass', ms: 1,
          evidence: ['count=4'],
        },
        {
          id: 'api:cfg:deepseek', layer: 'api', subject: 'deepseek',
          title: 'DeepSeek API 配置可用', status: 'pass', ms: 2,
          evidence: ['baseUrl=https://api.deepseek.com/v1', 'protocol=openai'],
        },
        {
          id: 'api:model:deepseek', layer: 'api', subject: 'deepseek',
          title: '端点清单里没有要用的模型名', status: 'fail', ms: 9,
          evidence: ['model=deepseek-chat', '清单含 deepseek-reasoner'],
          fix: '在设置页核对该模型的「模型标识」',
        },
      ],
    }
  })
  // 主题与偏好在启动即被读取；不注册的话渲染层拿到的是「没有 handler」
  // theme:boot 必须是同步 handler —— preload 在第一帧之前就问这一次
  ipcMain.on('theme:boot', (e) => { e.returnValue = BOOT_THEME })
  ipcMain.handle('theme:get', () => ({ mode: BOOT_THEME, resolved: BOOT_THEME }))
  ipcMain.handle('theme:set', (_e, mode) => ({ ok: true, mode, resolved: mode }))
  ipcMain.handle('preferences:load', () => ({}))
  /*
   * 「我的默认」：App.tsx 的开机序列卡在 loadPreferences 与 listModels 中间等这个返回值，
   * 桩没注册 → promise reject → 整个 boot effect 当场断掉，模型列表根本没机会灌进 store。
   * 表现是模型栏空着、网页坞打不开、后面每个探针读 null.style 把整条冒烟流程带进沟里 ——
   * 而 README 那几张图停在旧版本，正是这条断链的下游症状。空对象 = 没有任何覆盖，全用出厂值。
   */
  ipcMain.handle('discussion-defaults:get', () => ({}))
  ipcMain.handle('discussion-defaults:set', () => ({ ok: true }))
  ipcMain.handle('preferences:save', () => ({ ok: true }))
  // 「关于」与更新：开发构建的检查按钮必须禁用，状态模型直接用生产实现算。
  const { initialUpdateState } = require(path.join(ROOT, 'dist', 'shared', 'update'))
  ipcMain.handle('update:state', () =>
    initialUpdateState({ packaged: false, portable: false, version: app.getVersion() }),
  )
  ipcMain.handle('about:info', () => ({
    version: app.getVersion(),
    dataDir: app.getPath('userData'),
    packaged: false,
    portable: false,
    usage: null,
  }))
  // 区域尺寸：列挂载即读一次；不注册会让拖动落盘时抛 unhandled rejection
  ipcMain.handle('layout:get', () => ({}))
  ipcMain.handle('layout:set', () => ({ ok: true }))
  // 全局快捷键：设置页挂载即读一次，改键要回「是否真的注册上了」
  ipcMain.handle('hotkey:get', () => ({ enabled: true, accel: 'CommandOrControl+Alt+T', registered: true }))
  ipcMain.handle('hotkey:set', (_e, cfg) => ({
    enabled: !!cfg?.enabled,
    accel: cfg?.accel ?? 'CommandOrControl+Alt+T',
    registered: !!cfg?.enabled,
    ok: !!cfg?.enabled,
  }))

  // ---------- 助手抽屉：真实 IPC 契约，主进程侧用固定回执 ----------
  ipcMain.handle('assistant:status', () => ({ ready: false, modelId: 'deepseek', streaming: false, reason: '会话尚未创建' }))
  ipcMain.handle('assistant:models', () => ASSISTANT_MODELS)
  ipcMain.handle('assistant:history', () => (global.__assistantEmpty ? [] : ASSISTANT_HISTORY))
  // 抽屉挂载时按「审批偏好 → 浮层 → 历史」一路读下来：少一环会让历史静默不加载
  ipcMain.handle('assistant:overlay', () => ({
    mode: { mode: 'chat', round: 0, maxRounds: 8, running: false, readDirs: [] },
    skills: [],
    extensionsEnabled: false,
    // @ 的浏览根恒有值：没挑过项目目录时就是这份假数据目录自己
    workDir: 'C:\\smoke\\torra',
    defaultWorkDir: 'C:\\smoke\\torra',
  }))
  ipcMain.handle('assistant:at-list', () => ({ ok: true, workDir: 'C:\\smoke\\torra', entries: [] }))
  ipcMain.handle('assistant:set-model', (_e, { modelId }) => {
    global.__assistantCalls.push({ fn: 'set-model', modelId })
    if (modelId === 'glm') return { ok: false, reason: '该模型还没配 API Key，助手无法用它推理。' }
    return { ok: true }
  })
  ipcMain.handle('assistant:send', (_e, { text }) => {
    global.__assistantCalls.push({ fn: 'send', text })
    // 会话起不来时结论走 invoke 返回值，不走流式事件——这条路径也必须收掉忙碌态
    if (text.startsWith('【失败】')) {
      return {
        ok: false,
        reason: '没有可供助手使用的 API 模型。请在设置页新建一个 API 模型并填入 API Key。',
        detail: 'Error: no usable api model (models=2 usable=0) at ensureAssistant',
      }
    }
    return new Promise((resolve) => pendingSends.push(resolve))
  })
  ipcMain.handle('assistant:steer', (_e, { text }) => {
    global.__assistantCalls.push({ fn: 'steer', text })
    return { ok: true }
  })
  ipcMain.handle('assistant:abort', () => {
    global.__assistantCalls.push({ fn: 'abort' })
    endAssistantTurn()
    return { ok: true }
  })
  ipcMain.handle('assistant:reset', () => {
    global.__assistantCalls.push({ fn: 'reset' })
    return { ok: true }
  })
  /**
   * 账目与历史会话：抽屉一打开就会各问一次。
   * 少 stub 一个通道，渲染层拿到的是 reject —— 表现为一行「Uncaught (in promise)」，
   * 而界面看起来只是「那块没数据」，所以必须一次性补齐。
   */
  ipcMain.handle('assistant:stats', () => (global.__assistantEmpty ? null : {
    sessionId: 's-smoke',
    userMessages: 3,
    assistantMessages: 3,
    toolCalls: 5,
    totalMessages: 11,
    tokens: { input: 8200, output: 1400, cacheRead: 5100, cacheWrite: 0, total: 14700 },
    cost: 0.0312,
    contextTokens: 9800,
    contextWindow: 128000,
    contextPercent: 7.7,
  }))
  ipcMain.handle('assistant:sessions', () => (global.__assistantSessions ?? []))
  ipcMain.handle('assistant:open-session', (_e, { file }) => {
    global.__assistantCalls.push({ fn: 'open-session', file })
    return { ok: true }
  })
  ipcMain.handle('assistant:delete-session', (_e, { file }) => {
    global.__assistantCalls.push({ fn: 'delete-session', file })
    return { ok: true }
  })
  ipcMain.handle('assistant:capabilities', () => ({
    extensionsEnabled: true,
    // 清单不能空：空了就不渲染「已加载」那一块，搜索框和筛选根本没得上台
    skills: [
      { name: 'pdf-forms', description: '读取并填写 PDF 表单', path: 'C:\\fake\\skills\\pdf-forms\\SKILL.md' },
      { name: 'release-notes', description: '按提交记录起草发版说明', path: 'C:\\fake\\skills\\release-notes\\SKILL.md' },
    ],
    errors: [],
    note: '',
    dirs: { skills: 'C:\\fake\\pi\\skills', plugins: 'C:\\fake\\pi\\plugins' },
  }))
  ipcMain.handle('assistant:set-extensions', (_e, { on }) => {
    global.__assistantCalls.push({ fn: 'set-extensions', on })
    return { ok: true }
  })
  ipcMain.handle('assistant:skills-scan', () => ({
    ok: true,
    home: require('os').homedir(),
    skillsDir: require('path').join(require('os').tmpdir(), 'torra-smoke-skills'),
    apps: [
      {
        id: 'claude',
        displayName: 'Claude Code',
        roots: ['C:\\fake\\.claude\\skills'],
        missing: false,
        skills: [
          {
            key: require('path').join(require('os').tmpdir(), 'torra-smoke-skills', 'SKILL.md'),
            name: 'smoke-skill',
            description: '冒烟用的技能条目',
            path: 'C:\\fake\\smoke-skill\\SKILL.md',
            appId: 'claude',
            appDisplayName: 'Claude Code',
            kind: 'dir',
            loadable: true,
            warnings: [],
            imported: false,
          },
          {
            key: 'C:\\fake\\.claude\\skills\\broken\\SKILL.md',
            name: 'broken-skill',
            description: '',
            path: 'C:\\fake\\.claude\\skills\\broken\\SKILL.md',
            appId: 'claude',
            appDisplayName: 'Claude Code',
            kind: 'dir',
            loadable: false,
            warnings: ['链接指向的位置已不存在'],
            imported: false,
          },
        ],
        skipped: 0,
      },
    ],
    dangling: [{ name: 'ghost', target: 'C:\\fake\\gone' }],
    total: 2,
    imported: 0,
    scannedAt: Date.now(),
    extensionsEnabled: false,
    // Torra 技能目录里真正有什么：少了这一项，设置页读 .local.length 就炸，
    // 而仓库里没有 ErrorBoundary —— 整棵树会被卸掉，后面所有界面断言都跟着失真。
    local: [],
  }))
  ipcMain.handle('assistant:skills-import', (_e, { key }) => {
    global.__assistantCalls.push({ fn: 'skills-import', key })
    return { ok: true, name: 'smoke-skill', linkKind: 'junction', reason: '已导入。下一次对话会重新加载技能' }
  })
  ipcMain.handle('assistant:skills-remove', (_e, { name }) => {
    global.__assistantCalls.push({ fn: 'skills-remove', name })
    return { ok: true, name }
  })
  // 审批偏好：抽屉开卡时必读，缺 handler 会让整段初始化 await 断掉（历史回放跟着不跑）
  ipcMain.handle('assistant:approval-prefs', () => (global.__approvalPrefs ?? { mode: 'always_ask', timeoutMs: 10000 }))
  ipcMain.handle('assistant:set-approval-prefs', (_e, input) => {
    global.__assistantCalls.push({ fn: 'set-approval-prefs', ...input })
    global.__approvalPrefs = { ...(global.__approvalPrefs ?? { mode: 'always_ask', timeoutMs: 10000 }), ...input }
    return { ok: true }
  })
  ipcMain.handle('assistant:plugins', () => ({ dir: 'C:\\fake\\pi\\plugins', plugins: [], invalid: [], legacy: [] }))
  ipcMain.handle('assistant:plugins-remove', (_e, { name }) => {
    global.__assistantCalls.push({ fn: 'plugins-remove', name })
    return { ok: true }
  })
  ipcMain.handle('assistant:pending', () => ({ pending: [], invalid: [] }))
  ipcMain.handle('assistant:pending-enable', (_e, { name }) => {
    global.__assistantCalls.push({ fn: 'pending-enable', name })
    return { ok: true }
  })
  ipcMain.handle('assistant:pending-drop', (_e, { name }) => {
    global.__assistantCalls.push({ fn: 'pending-drop', name })
    return { ok: true }
  })
  ipcMain.handle('assistant:set-self-authoring', (_e, { on }) => {
    global.__assistantCalls.push({ fn: 'set-self-authoring', on })
    return { ok: true }
  })
  ipcMain.handle('assistant:approval:respond', (_e, { id, decision }) => {
    global.__assistantApprovals.push({ id, decision })
    return { ok: true }
  })

  // ---------- 补上几条后来加的通道 ----------
  // 这些是设置页与插件坞一开就问的。少一条，渲染层拿到的是 reject：
  // 表现是插件清单变成 undefined、渲染层在 .length 上炸掉，而仓库里没有 ErrorBoundary，
  // 整棵树会被卸掉 —— 后面所有关于界面的断言都会跟着失真（抽屉「不见了」就是这么来的）。
  ipcMain.handle('plugins:list', () => ({ plugins: [], invalid: [], userDir: 'C:\\fake\\torra\\plugins' }))
  ipcMain.handle('plugins:set-enabled', () => ({ ok: true }))
  ipcMain.handle('plugins:reload', () => ({ ok: true }))
  ipcMain.handle('assistant:repo-view', () => ({
    ok: true,
    repoDir: 'C:\\fake\\torra\\skill-repo',
    sources: [],
    total: 0,
    updates: [],
    checkedAt: Date.now(),
  }))
  ipcMain.handle('assistant:repo-skills', () => ({ ok: true, total: 0, offset: 0, rows: [] }))
  ipcMain.handle('assistant:scheduled-list', () => ({
    ok: true,
    file: 'C:\\fake\\torra\\scheduled.json',
    dir: 'C:\\fake\\torra\\scheduled',
    tasks: [],
    note: '应用没运行就不会触发',
  }))
  ipcMain.handle('report:regenerate', () => ({ ok: true }))

  // ---------- ACP 抽屉：注册表、预检、接上、发一轮 ----------
  // 这一段用的是真协议形状的假数据：协商结果里的档位分两种来源（mode / config），
  // 工具包有的挂上有的挂不上 —— 界面必须照着数据画，不能按一家人的习惯画。
  ipcMain.handle('acp:list', () => ({
    entries: ACP_AGENTS,
    problems: [],
    active: undefined,
    // 矩阵给三种状态各来一家：绿的是整轮跑通过的，黄的是接得上但没测全，
    // 灰的是压根没测。界面上这三样必须长得不一样 —— 混成一样就等于把
    // 「没量」说成「量过了」。
    matrix: {
      claude: {
        tested: true,
        currentVersionTested: true,
        green: true,
        cell: {
          id: 'claude',
          version: '0.99.1',
          agentVersion: '2.0.14',
          checkedAt: '2026-10-30',
          handshake: true,
          session: true,
          prompt: true,
          cancel: true,
          permission: true,
          toolPack: true,
          full: true,
          notes: [],
        },
      },
      pi: {
        tested: true,
        currentVersionTested: true,
        green: false,
        cell: {
          id: 'pi',
          version: '0.0.34',
          checkedAt: '2026-10-30',
          handshake: true,
          session: true,
          prompt: false,
          cancel: false,
          permission: false,
          toolPack: false,
          full: false,
          notes: ['这一家不收 http 形态的 MCP'],
        },
        reason: '只测到握手与建会话；发一轮、打断这两步没测',
      },
      codex: {
        tested: false,
        currentVersionTested: false,
        green: false,
        reason: '这一格还没验过',
      },
    },
  }))
  ipcMain.handle('acp:probe', (_e, { agentId }) => ({
    ok: true,
    agentId,
    agentTitle: 'Claude Code',
    elapsedMs: 812,
    capabilities: ACP_CAPS,
  }))
  ipcMain.handle('acp:pick-dir', () => ({ ok: true, path: 'C:\\smoke\\torra' }))
  ipcMain.handle('acp:start', (_e, { agentId }) => {
    global.__acpCalls.push({ fn: 'start', agentId })
    return { ok: true, agentId, capabilities: ACP_CAPS }
  })
  ipcMain.handle('acp:prompt', (_e, { text }) => {
    global.__acpCalls.push({ fn: 'prompt', text })
    return { ok: true }
  })
  ipcMain.handle('acp:cancel', () => {
    global.__acpCalls.push({ fn: 'cancel' })
    return { ok: true }
  })
  ipcMain.handle('acp:stop', () => {
    global.__acpCalls.push({ fn: 'stop' })
    return { ok: true }
  })
  ipcMain.handle('acp:set-option', (_e, { optionId, value }) => {
    global.__acpCalls.push({ fn: 'set-option', optionId, value })
    return { ok: true }
  })
  ipcMain.handle('acp:permission:respond', (_e, input) => {
    global.__acpCalls.push({ fn: 'permission', ...input })
    return { ok: true }
  })
  ipcMain.handle('acp:registry-save', (_e, entry) => {
    global.__acpCalls.push({ fn: 'registry-save', entry })
    return { ok: true }
  })
  ipcMain.handle('acp:registry-remove', (_e, { id }) => {
    global.__acpCalls.push({ fn: 'registry-remove', id })
    return { ok: true }
  })
  ipcMain.handle('acp:registry-path', () => ({ path: 'C:\\Users\\test\\AppData\\Roaming\\Torra\\torra\\acp.json' }))
}

app.whenReady().then(async () => {
  // 兜住整段脚本：以前一处抛错只会让整个 promise 静默拒绝，
  // 应用就这么挂着不退出 —— 看现象是「卡住」，其实是早就炸了，
  // 而炸在哪一行被吞得干干净净。改成把栈打出来再退。
  try {
    await runSmoke()
  } catch (e) {
    console.log('SMOKE_CRASH ' + (e && e.stack ? e.stack : String(e)))
    finish(2)
  }
})

/**
 * 收摊：把这次冒烟自己的 userData 目录删掉再退。
 *
 * app.exit() 是硬退，不走 will-quit，所以清理得自己来 ——
 * 留着目录不致命（下次带新 pid，不抢锁），但临时目录堆起来总归是垃圾。
 */
function finish(code) {
  if (global.__smokeWatchdog) clearTimeout(global.__smokeWatchdog)
  // 报告先落盘再退：崩了也要留下这一轮已经跑出来的断言结论
  try {
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8')
  } catch (e) {
    console.log('SMOKE_REPORT_FAILED ' + String(e))
  }
  try {
    fs.rmSync(SMOKE_USER_DATA, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
  } catch {
    /* 删不掉就算了，不影响这一轮的结果 */
  }
  app.exit(code)
}

/** 现在走到哪了 —— 卡住时用它报位置 */
let _pos = '起手'

/**
 * 看门狗：整轮冒烟超过这个时长还没结束，就把位置喊出来再退。
 *
 * 以前是「跑着跑着就不动了」：既不知道是慢还是死，也不知道死在哪。
 * 有了位置与上限，卡住就变成一条可读的信息，而不是一次需要重跑的赌博。
 */
global.__smokeWatchdog = setTimeout(() => {
  console.log(`SMOKE_STUCK 停在：${_pos}`)
  finish(3)
}, 8 * 60_000)

async function runSmoke() {
  // 走到哪一步要看得见：以前卡住时只能靠猜是「还在跑」还是「早就炸了」。
  let _step = 0
  /**
   * 记下「现在在哪」。卡住时只有这一行能说出卡点的位置：
   * 整轮冒烟有好几处会等渲染层回话，哪一处不回头就永远停在那儿，
   * 而现象只是「卡住了」—— 不知道卡在哪，就只能反复重跑赌运气。
   */
  const mark = (label) => { _pos = label; console.log(`>> ${label}`) }
  const step = (label) => { _step += 1; console.log(`step ${_step} :: ${label}`); mark(label) }
  step('起手')
  registerStubs()
  installFixtureIcons()

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: SHOW_WIN,
    backgroundColor: BOOT_THEME === 'dark' ? '#0f1115' : '#faf9f7',
    webPreferences: {
      preload: path.join(ROOT, 'dist', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
    },
  })

  // 只有可见窗口经 CDP 抓到的图才是用户实际看到的那一帧（capturePage 会给空帧/过期帧）
  //
  // 抓图这件事有两层「会卡住」：CDP 的 captureScreenshot 不回来，还有 debugger.attach
  // ——后者是同步调用，渲染层一旦不响应，它就把主进程一起挂在那儿，连超时都设不了。
  // 所以调试器只挂一次（挂着就好，不必每张图重挂），而每一层都有各自的时限，
  // 一层不行就退到下一层，再不行就停掉截图 —— 但测试本身继续往下跑。
  let shotMode = 'cdp' // 'cdp' → 'page' → 'off'
  let dbgAttached = false
  const attachDebugger = () => {
    if (dbgAttached) return true
    try {
      win.webContents.debugger.attach('1.3')
      dbgAttached = true
      return true
    } catch (e) {
      errors.push(`CDP 调试器挂不上：${String(e)}`)
      return false
    }
  }
  const cdpShot = async (file) => {
    if (!SHOW_WIN) return
    mark('抓图 ' + file)
    const abs = path.join(ROOT, 'docs', file)
    const write = (buf) => {
      fs.writeFileSync(abs, buf)
      console.log(`shot -> ${abs}`)
    }
    // 渲染层已经不在了就别再抓：对着一个死掉的窗口抓图，拿到的是空帧，
    // 而且有时干脆不回来 —— 那种「卡住」不是慢，是没有对象可问了。
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      errors.push(`截图时窗口已经没了：${file}`)
      shotMode = 'off'
      return
    }
    if (win.webContents.isCrashed()) {
      errors.push(`截图前渲染层已经崩了：${file}`)
      shotMode = 'off'
      return
    }
    if (shotMode === 'off') {
      errors.push(`截图已停用（前面失败过，后面不再冒险）：${file}`)
      return
    }
    if (shotMode === 'cdp' && attachDebugger()) {
      try {
        const { data } = await Promise.race([
          win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('CDP 抓图超时（25s）')), 25000),
          ),
        ])
        write(Buffer.from(data, 'base64'))
        return
      } catch (e) {
        errors.push(`CDP 截图失败（${file}）：${String(e)}`)
        // 抓不动了就退到 capturePage，后面的图不再走 CDP
        shotMode = 'page'
        // 顺便问一句渲染层还活着没有：CDP 卡住可能是调试器的问题，
        // 也可能是渲染层真的不响应了 —— 这两件事的修法完全不同，不能混着说。
        try {
          const alive = await Promise.race([
            win.webContents.executeJavaScript('1 + 1'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('渲染层 8s 没回话')), 8000)),
          ])
          if (alive !== 2) errors.push(`渲染层回了怪值：${String(alive)}`)
        } catch (e2) {
          errors.push(`渲染层不响应了：${String(e2)}`)
        }
      }
    }
    // 退一步：CDP 抓不到就用电子的 capturePage。网页视图挂着时它可能给空帧，
    // 但空帧也远好过没有图 —— 没有图就看不出这一屏到底画成了什么样。
    try {
      const img = await Promise.race([
        win.webContents.capturePage(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('capturePage 超时（10s）')), 10000)),
      ])
      const buf = img.toPNG()
      if (buf.length > 2000) {
        write(buf)
      } else {
        errors.push(`截图拿不到可用的画面：${file}`)
        shotMode = 'off'
      }
    } catch (e) {
      errors.push(`截图彻底失败：${file} · ${String(e)}`)
      shotMode = 'off'
    }
  }

  /**
   * README 配图：只在 --docs-shots 下出，出在断言已经跑到同一判据的那一刻。
   * 尺寸不另调 —— 就用冒烟窗口本来的 1264×735，跟 docs/ 里既有的图一致。
   * 中途试过 setContentSize(1280, 720) 凑 16:9，那两条分栏几何断言照样红，
   * 说明红不红跟这个尺寸无关；既然无关，出图就不该去动被测对象的窗口。
   */
  const docsShot = (file) => (DOCS_SHOTS ? cdpShot(file) : Promise.resolve())

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      errors.push(String(message))
      // 只在末尾汇总的话，脚本中途一reject 就什么都不剩，问题查不出来
      console.log(`[renderer ${level}] ${message} @ ${sourceId}:${line}`)
    }
  })

  await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'))
  await sleep(2000)

  // 主题：冷启动值由 preload 同步问主进程拿到；两套配色必须真的画出不同的明暗，
  // 只在 CSS 里换 token 而没人验证渲染结果，等于没验证。
  const probeTheme = await win.webContents.executeJavaScript(`
    (() => {
      try {
        const boot = document.documentElement.dataset.theme || null;
        const lum = (s, fromEnd) => {
          const all = [...String(s || '').matchAll(/rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/g)]
          if (!all.length) return null
          const m = (fromEnd ? all[all.length - 1] : all[0])
          const [r, g, b] = [1, 2, 3].map((i) => Number(m[i]))
          return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
        }
        const pick = (sel, prop) => {
          const el = document.querySelector(sel)
          return el ? getComputedStyle(el)[prop] : null
        }
        const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
        // token 的 computed 值是作者原样（多为 #hex），rgb() 形式则来自元素实时配色，两种都要能算亮度
        const hexLum = (v) => {
          const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim())
          if (!m) return null
          let s = m[1]
          if (s.length === 3) s = s.split('').map((c) => c + c).join('')
          const [r, g, b] = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16))
          return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
        }
        const colorLum = (v) => hexLum(v) ?? lum(v)
        const sample = () => ({
          // 地面取最后一层（底色渐变）：前面几层是氛围光晕，两套主题都偏亮
          ground: lum(pick('body', 'backgroundImage'), true),
          text: lum(pick('.titlebar-brand strong', 'color')),
          navBg: lum(pick('.app-nav', 'backgroundColor')),
          cardBg: lum(pick('.ns-foot', 'backgroundColor')),
          onAccent: colorLum(token('--on-accent')),
          accent: colorLum(token('--accent')),
        })
        // 参照时刻：文档装载完成。应用是 show:false + ready-to-show 才显示的，
        // 所以只要写入早于装载结束，用户能看到的第一帧就已经是正确配色了。
        const loadAt = () => {
          const n = performance.getEntriesByType('navigation')[0]
          const t = n ? Math.max(n.domComplete || 0, n.loadEventEnd || 0) : 0
          return t ? Math.round(t * 1000) / 1000 : null
        }
        document.documentElement.dataset.theme = 'dark'
        const dark = sample()
        document.documentElement.dataset.theme = 'light'
        const light = sample()
        document.documentElement.dataset.theme = boot || 'dark'
        return { boot, bootFromPreload: window.torra.bootTheme(), bootDiag: window.torra.bootDiag(), loadAt: loadAt(), dark, light }
      } catch (e) { return { error: String((e && e.stack) || e) } }
    })()
  `)
  const themeFails = []
  // 探针一旦被渲染层异常吞掉，executeJavaScript 会回 null；不挡一下就会在取属性时崩掉整轮冒烟
  if (probeTheme === null || typeof probeTheme !== 'object') {
    errors.push(`主题探针没返回对象（拿到 ${JSON.stringify(probeTheme)}），后面的断言全部跳过`)
  }
  const okTheme = probeTheme !== null && typeof probeTheme === 'object'
  if (okTheme && probeTheme.error) themeFails.push(`主题探针执行失败：${probeTheme.error}`)
  const pt = okTheme ? probeTheme : {}
  const side = (t) => pt[t] || {}
  if (pt.bootFromPreload !== BOOT_THEME) {
    themeFails.push(`preload 没从 theme:boot 问到冷启动主题：期望 ${BOOT_THEME}，实际 ${pt.bootFromPreload}`)
  }
  if (pt.boot !== BOOT_THEME) {
    themeFails.push(`preload 没把冷启动主题写进 data-theme：期望 ${BOOT_THEME}，实际 ${pt.boot}（诊断 ${JSON.stringify(pt.bootDiag)}）`)
  }
  // 写入必须早于文档装载结束，否则显示出来的第一帧可能还是默认配色
  const bootAt = pt.bootDiag && pt.bootDiag.at
  if (bootAt == null) {
    themeFails.push(`preload 从未写入过 data-theme（诊断 ${JSON.stringify(pt.bootDiag)}）`)
  } else if (pt.loadAt != null && bootAt > pt.loadAt) {
    themeFails.push(`冷启动主题写晚了：${bootAt}ms > 装载结束 ${pt.loadAt}ms，开场可能闪一帧默认配色`)
  }
  const expectDarker = (a, b, what) => {
    if (a == null || b == null) return themeFails.push(`${what}：取不到样本（选择器不在了？）`)
    if (a >= b) themeFails.push(`${what}：${a} 应暗于 ${b}`)
  }
  expectDarker(side('dark').ground, side('light').ground, '地面没有随主题变亮')
  expectDarker(side('dark').cardBg, side('light').cardBg, '卡片背景没换')
  expectDarker(side('light').text, side('dark').text, '正文没在白天变深')
  // 强调色底上的文字必须反向 contrast：白天白字、黑夜黑字，否则切主题后按钮文字糊在底色里
  const onAccentGap = (t) => {
    const s = side(t)
    if (s.onAccent == null || s.accent == null) return null
    return s.onAccent - s.accent
  }
  const [darkGap, lightGap] = [onAccentGap('dark'), onAccentGap('light')]
  if (darkGap == null || lightGap == null) {
    themeFails.push('--on-accent / --accent 取不到值')
  } else if (!(darkGap < 0 && lightGap > 0)) {
    themeFails.push(`强调色上的文字没有随主题反向 contrast：黑夜 ${darkGap}、白天 ${lightGap}（应 <0 / >0）`)
  }
  if (themeFails.length) errors.push(...themeFails)

  // 标题栏的切换按钮：点一下就要真的换色（乐观更新，不等 IPC 回来）
  const toggled = await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.theme-toggle');
      return { before: document.documentElement.dataset.theme || null, hasBtn: !!btn };
    })()
  `)
  if (!toggled || !toggled.hasBtn) {
    errors.push('标题栏没有主题切换按钮 .theme-toggle')
  } else {
    await win.webContents.executeJavaScript(`document.querySelector('.theme-toggle').click()`)
    await sleep(400)
    const after = await win.webContents.executeJavaScript(`document.documentElement.dataset.theme || null`)
    if (after === toggled.before) errors.push(`点主题按钮没换色：${after}`)
    // 换回去，后面的流程按冷启动主题继续跑
    await win.webContents.executeJavaScript(`document.querySelector('.theme-toggle').click()`)
    await sleep(400)
  }

  // 数值断言只能证明 token 换了；成图用来确认白天那套真的还是「玻璃 + 靛紫」，没退成灰白塑料
  await cdpShot(`smoke-theme-${BOOT_THEME}.png`)

  // ---------- 开场页的网页视图：必须是分栏，不许浮在表单之上 ----------
  step('开场页/分栏')
  // 判据用矩形，不用「看起来对不对」：浮层的本质就是两列在几何上重叠。
  const SPLIT_RECT = `
      (() => {
        const rect = (s) => { const e = document.querySelector(s); if (!e) return null;
          const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width) }; };
        const cs = (s, p) => { const e = document.querySelector(s); return e ? getComputedStyle(e)[p] : null; };
        return { center: rect('.center'), main: rect('.center-main'), web: rect('.discuss-webview'),
                 col: rect('.ns-col'), split: rect('.col-split'),
                 acts: rect('.wdh-actions'), tabs: rect('.wdh-tabs'),
                 head: rect('.webview-dock-head'),
                 radius: cs('.discuss-webview', 'borderRadius'), shadow: cs('.discuss-webview', 'boxShadow'),
                 overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      })()
  `
  const probeSplit = await (async () => {
    await win.webContents.executeJavaScript(
      `window.__torraStore.getState().setViewMode('broadcast', 'chatgpt')`
    )
    await sleep(420)
    const r = await win.webContents.executeJavaScript(SPLIT_RECT)
    await cdpShot('smoke-dock-split.png')
    // 最窄列是第二处判据：拖到 340 是允许的，表头在那儿最容易被挤出列外
    await win.webContents.executeJavaScript(
      `document.querySelector('.discuss-webview').style.setProperty('--disc-web-w', '340px')`
    )
    await sleep(260)
    r.narrow = await win.webContents.executeJavaScript(SPLIT_RECT)
    await cdpShot('smoke-dock-split-narrow.png')
    // 放大态：分栏外观必须整体退场（内容列/分隔条让开，网页列吃掉整行）。
    // 浮层时代 inset:0 就足够了，改成 flex 之后这一步得重新量一次。
    await win.webContents.executeJavaScript(
      `document.querySelector('.discuss-webview').style.removeProperty('--disc-web-w')`
    )
    await sleep(200)
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="放大网页视图"]').click()`)
    await sleep(360)
    r.zoom = await win.webContents.executeJavaScript(SPLIT_RECT)
    await cdpShot('smoke-dock-split-zoom.png')
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="放大网页视图"]').click()`)
    await sleep(300)
    await win.webContents.executeJavaScript(`window.__torraStore.getState().setViewMode('hall')`)
    await sleep(300)
    return r
  })()
  if (!probeSplit.web) errors.push('开场页打开网页视图后没有 .discuss-webview 列')
  else if (!probeSplit.main) errors.push('.center 里没有 .center-main 内容列，分栏无从谈起')
  else {
    const { center, main, web, col } = probeSplit
    if (web.l < main.r) errors.push(`网页列与内容列几何重叠：main.right=${main.r} > web.left=${web.l}`)
    if (center && Math.abs(web.r - center.r) > 2) errors.push(`网页列没贴到行右缘：web.right=${web.r} center.right=${center.r}`)
    if (Math.abs(web.b - web.t) < 200) errors.push('网页列没有撑满整行高度')
    // 表单文字被压住是这次改动的原始症状：正文列的右缘必须在网页列左边
    if (col && col.r > web.l) errors.push(`开场表单正文被网页列盖住：ns-col.right=${col.r} > web.left=${web.l}`)
    if (probeSplit.radius !== '0px') errors.push(`网页列还留着浮层圆角：${probeSplit.radius}`)
    if (probeSplit.shadow && probeSplit.shadow !== 'none') errors.push(`网页列还留着浮层阴影：${probeSplit.shadow}`)
    // 表头溢出是「浮层改分栏」的次生风险：列变窄后按钮被挤出列外，关闭就按不到了
    for (const [label, s] of [['默认列宽', probeSplit], ['最窄列宽', probeSplit.narrow], ['放大态', probeSplit.zoom]]) {
      if (!s || !s.acts || !s.web) continue
      if (s.acts.r > s.web.r + 1)
        errors.push(`${label}下表头按钮被挤出网页列：actions.right=${s.acts.r} > web.right=${s.web.r}（列宽 ${s.web.w}）`)
      // 这一列只看一个模型，换模型回左栏点：堆一条标签条会把名称和按钮挤成竖排
      if (s.tabs) errors.push(`${label}下表头还在堆叠可切换的网页模型标签条`)
      if (s.overflowX > 0) errors.push(`${label}下整行横向溢出 ${s.overflowX}px`)
      // 表头只许占一行：每多一行，网页就少一行可用高度
      if (s.head && s.head.b - s.head.t > 60)
        errors.push(`${label}下表头不止一行（head.height=${s.head.b - s.head.t}）`)
    }
    const z = probeSplit.zoom
    if (!z || !z.web) errors.push('放大态下没有网页列')
    else {
      if (z.main && z.main.w > 0) errors.push(`放大态下内容列没有让开：center-main.width=${z.main.w}`)
      if (z.split && z.split.w > 0) errors.push(`放大态下分隔条没有让开：col-split.width=${z.split.w}`)
      if (z.center && Math.abs(z.web.w - z.center.w) > 2)
        errors.push(`放大态网页列没吃满整行：web=${z.web.w} center=${z.center.w}`)
    }
  }

  const probe1 = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelector(s);
      const n = (s) => document.querySelectorAll(s).length;
      return {
        screen: 'guide',
        title: q('.titlebar h1')?.textContent ?? null,
        modelAvatars: n('.avatar'),
        checkItems: n('.ns-chip'),
        textFields: n('.ns-sec'),
        startBtn: [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始讨论')?.textContent ?? null,
        startBtnDisabled: [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始讨论')?.disabled ?? null,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        railW: Math.round(q('.model-rail')?.getBoundingClientRect().width ?? 0),
      };
    })()
  `)

  // 开场页整屏。这里和下面几处一律走 cdpShot，不再用 webContents.capturePage()：
  // 网页分栏挂着 <webview> 时它有不 resolve 的时候（实测过一趟：前面四张 CDP 图都正常，
  // 流程走到这一句就再也不往下走），而 cdpShot 的注释本来就写着 CDP 才是用户看到的那一帧。
  await cdpShot('screenshot-m1-guide.png')

  /*
   * 主持兼参会：放开校验后，开场页得让人看清「这颗胶囊既是主持也是发言者」，
   * 兼岗提示也要出现。探完立刻还原，别把网页模型当主持带进后面的开始讨论。
   * 必须分两步：patchConfig 之后 React 要到下一个 tick 才重渲染，同一次求值里读 DOM 必然为空。
   */
  await win.webContents.executeJavaScript(
    `window.__torraStore.getState().patchConfig({ moderatorId: window.__torraStore.getState().participantIds[0] })`
  )
  await sleep(150)
  const dualProbe = await win.webContents.executeJavaScript(`
    (() => {
      const chip = document.querySelector('.ns-chip-mod');
      const note = [...document.querySelectorAll('.ns-note')].find(x => x.textContent.includes('主持同时参会'));
      return {
        chipOn: document.querySelector('.ns-chip.on .ns-chip-mod')?.textContent?.trim() ?? null,
        // 样式拆在 newsession.css：胶囊自己的 999px 不会继承到内层 span，
        // 读到 0px 就说明这条规则没人加载
        chipRadius: chip ? getComputedStyle(chip).borderTopLeftRadius : null,
        noteShown: !!note,
        modNote: [...document.querySelectorAll('.ns-sec-note')].map(x => x.textContent.trim()).find(t => t.includes('兼参会') || t.includes('不参与发言')) ?? null,
      };
    })()
  `)
  await win.webContents.executeJavaScript(`window.__torraStore.getState().patchConfig({ moderatorId: null })`)
  if (dualProbe.chipOn !== '主持') errors.push(`兼主持标记没出现在参会胶囊上：${JSON.stringify(dualProbe.chipOn)}`)
  if (dualProbe.chipRadius !== '999px')
    errors.push(`.ns-chip-mod 没吃到样式（多半是规则没进 newsession.css）：radius=${dualProbe.chipRadius}`)
  if (!dualProbe.noteShown) errors.push('兼岗场次没提示「主持同时参会」的代价与兜底')
  if (!/兼参会/.test(dualProbe.modNote ?? ''))
    errors.push(`主持区说明没跟着兼岗变化：${dualProbe.modNote}`)

  // 走一遍真实交互：填议题 → 开始讨论
  await win.webContents.executeJavaScript(`
    (() => {
      const setVal = (el, v) => {
        if (!el) throw new Error('smoke: 开场页字段不在了')
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setVal(document.querySelector('.ns-topic'), '评估为报表系统引入实时计算层的必要性');
      const ta = document.querySelector('.ns-bg');
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
      setter.call(ta, '当前日均查询 2 万次，报表生成 P95 延迟约 8 秒，夜间批量任务常超时。');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      // 点击真正的「开始讨论」按钮（文本匹配，避免选中策略区的圆桌/辩论/评审）
      const btns = [...document.querySelectorAll('button')];
      const start = btns.find(b => b.textContent.trim() === '开始讨论');
      if (!start) return 'no-start-button';
      start.click();
      return 'clicked';
    })()
  `)
  const clickRes = await win.webContents.executeJavaScript(`window.__smokeClickResult || 'unknown'`)
  await sleep(1200)

  // 先推入运行态事件，否则介入面板的按钮会因 running=false 而禁用（PRD 8.3）
  await win.webContents.executeJavaScript(`
    (() => {
      const s = window.__torraStore;
      if (!s) return 'no-store';
      s.getState().applyEvent(${JSON.stringify({ type: 'state', state: 'AGENT_BATCH', round: 1 })});
      return 'ok';
    })()
  `)
  await sleep(400)

  // 注入模拟编排事件，验证议事厅 / 共识面板 / 分歧清单渲染
  const evSeq = [
    { type: 'state', state: 'AGENT_BATCH', round: 1 },
    { type: 'round-start', round: 1, total: 3 },
    { type: 'utterance-done', utterance: { id: 'u1', round: 1, agentId: 'chatgpt', content: '支持引入。实时链路可把 P95 延迟压到 1 秒内，成本增量约每月 800 元，且现有数仓已具备接入能力。', targets: [], stance: 'support', usage: { promptTokens: 0, completionTokens: 60, costUsd: 0.012 } } },
    { type: 'utterance-done', utterance: { id: 'u2', round: 1, agentId: 'claude', content: '反对。当前查询量级用批处理 + 缓存即可覆盖，引入实时层会带来一致性问题：实时链路与离线批处理结果不一致时，报表数字无法对账。', targets: [], stance: 'oppose', usage: { promptTokens: 0, completionTokens: 66, costUsd: 0.014 } } },
    { type: 'absent', utterance: { id: 'u3', round: 1, agentId: 'gemini', content: 'Gemini 本轮超时未响应 · 已跳过，不影响其他模型', targets: [], absent: true, absentReason: 'timeout' } },
    // open.sides 必须按真实事件契约给 agentId + utteranceIds（见 orchestrator 的 incoming 映射），
    // 只给 agent_id 会让渲染端读 undefined.length —— 那是夹具失真，不是被测代码的错
    { type: 'moderator', digest: { consensus_points: [{ claim: 'P95 延迟是当前核心瓶颈', support: ['chatgpt', 'claude'], confidence: 0.85, evidence_ref: ['u1', 'u2'] }], open_disputes: [{ claim: '是否需要双写对账层', sides: [{ agent_id: 'chatgpt', argument: '不需要，双写成本高于收益' }, { agent_id: 'claude', argument: '需要，否则数字无法对账' }] }] }, score: { round: 1, score: 58, agreement: 50, overlap: 60, trend: 50 }, open: [{ id: 'd1', claim: '是否需要双写对账层', sides: [{ agentId: 'chatgpt', argument: '不需要，双写成本高于收益', utteranceIds: ['u1'] }, { agentId: 'claude', argument: '需要，否则数字无法对账', utteranceIds: ['u2'] }], openedRound: 1, lastProgress: null, status: 'open' }] },
    // ---- 人工介入 ----
    { type: 'intervention', intervention: { id: 'iv1', kind: 'interject', text: '两位的成本估算都缺少人力投入，请补充。', atRound: 1, status: 'pending', targetAgentIds: [] } },
    { type: 'utterance-done', utterance: { id: 'uh1', round: 1, agentId: 'human', content: '两位的成本估算都缺少人力投入，请补充。', targets: [], human: true } },
    { type: 'round-start', round: 2, total: 3 },
    { type: 'utterance-done', utterance: { id: 'u4', round: 2, agentId: 'chatgpt', content: '第 2 轮：补充人力成本约 2 人周，折合一次性 6 万元。我承认一致性问题真实存在，但可通过在报表层标注数据来源与时间戳缓解，而非引入双写。', targets: ['u2'], stance: 'conditional', usage: { promptTokens: 0, completionTokens: 72, costUsd: 0.015 } } },
    { type: 'intervention', intervention: { id: 'iv2', kind: 'followup', text: '为什么不直接双写？', atRound: 2, status: 'pending', targetAgentIds: ['claude'], targetAgentId: 'claude' } },
    { type: 'stance-changed', agentId: 'claude', before: '（默认立场）', after: '风险审阅者', effectiveRound: 3 },
    { type: 'duel-start', duel: { topic: '是否需要双写对账层', agentIds: ['chatgpt', 'claude'] } },
    { type: 'utterance-done', utterance: { id: 'ud1', round: 2, agentId: 'chatgpt', content: '对辩：双写的边际成本随查询量线性增长，而读多写少场景下缓存命中率已超 92%，双写收益不成立。', targets: ['u2'], stance: 'oppose', usage: { promptTokens: 0, completionTokens: 58, costUsd: 0.012 } } },
    { type: 'utterance-done', utterance: { id: 'ud2', round: 2, agentId: 'claude', content: '对辩：92% 命中率意味着 8% 的不一致，而这 8% 恰好是财务最关心的口径差异。', targets: ['u1'], stance: 'oppose', usage: { promptTokens: 0, completionTokens: 52, costUsd: 0.011 } } },
    { type: 'duel-done', duelId: 'd1' },
  ]

  for (const ev of evSeq) {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('torra:inject', { detail: ${JSON.stringify(JSON.stringify(ev))} }))`
    )
    await sleep(60)
  }
  // 事件走真实 IPC 通道重放（preload 只允许白名单 channel，这里直接调 store）
  await win.webContents.executeJavaScript(`
    (() => {
      const evs = ${JSON.stringify(evSeq)};
      // preload 暴露的 on() 已绑定 orchestrator:event；此处通过其内部 store 重放
      const s = window.__torraStore;
      if (!s) return 'no-store';
      for (const e of evs) s.getState().applyEvent(e);
      return 'ok';
    })()
  `)
  await sleep(800)

  // 右栏现在是单列滚动（聚焦 + 结论台账 + 运行时），不再有页签：
  // 以前要先切到「结论台账」才看得见的 .cs-* 计数，现在进场就在 DOM 里。
  const probe2 = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelector(s);
      const n = (s) => document.querySelectorAll(s).length;
      const ivTabs = [...document.querySelectorAll('.iv-tab')].map(b => b.textContent);
      return {
        screen: 'session',
        modeTabs: [...document.querySelectorAll('.mode-tab')].map(b => b.textContent),
        roundPill: q('.round-pill')?.textContent ?? null,
        // 正文 = 论题演化图 + 跟随条：卡片只有跟随条这一份
        stageNodes: n('.te-ico'),
        endpoints: n('.te-end'),
        followCards: n('.te-follow .te-card.te-utt'),
        absentChips: n('.te-absent'),
        hostLine: !!q('.te-host'),
        stanceTags: n('.te-card-stance'),
        // 人工介入
        ivTabs,
        ivSelects: n('.iv-select'),
        ivTextarea: !!q('.interject-bar textarea'),
        interventionChips: n('.iv-chip'),
        tickerPresent: !!q('.iv-ticker'),
        humanCards: n('.te-card.te-utt.human'),
        actionButtons: n('.te-card-ops .te-op'),
        // 结论台账（右栏单列，不再分屏）
        aside: !!q('.rb-aside'),
        scoreChart: !!q('.score-chart'),
        lead: !!q('.cs-lead'),
        bucketCells: n('.cs-bucket'),
        dimMeters: n('.cs-dims .cs-meter'),
        consensusItems: n('.cs-point'),
        disputeItems: n('.cs-dispute'),
        ledger: !!q('.cs-ledger'),
        takeOverDisabled: document.querySelectorAll('.mode-tab')[2]?.disabled ?? null,
      };
    })()
  `)

  if (!probe2.stageNodes) errors.push('正文没有论题演化图（.te-ico 节点为 0）')
  if (!probe2.followCards) errors.push('正文没有跟随条发言卡（.te-follow .te-card）')
  if (!probe2.aside) errors.push('右栏 aside 不在场')
  if (!probe2.lead) errors.push('结论台账页没有「这场留下了什么」主角格（.cs-lead）')
  if (probe2.bucketCells !== 4) errors.push(`主角格的四桶不是四格：${probe2.bucketCells}`)
  if (!probe2.consensusItems) errors.push('结论台账页没有结论卡（.cs-point）')
  if (!probe2.disputeItems) errors.push('结论台账页没有对峙卡（.cs-dispute）')
  if (!probe2.ledger) errors.push('结论台账页没有本场账本抽屉（.cs-ledger）')
  // 停在有台账的这一屏留一张图
  await cdpShot('smoke-consensus-tab.png')
  // README 的「讨论进行中」：就是这一屏 —— 介入面板、论题演化图、结论台账同时在场
  await docsShot('smoke-discussion-flow.png')

  // 实际操作一次插话，验证 IPC 打通
  const preClick = await win.webContents.executeJavaScript(`
    (() => {
      const s = window.__torraStore.getState();
      const b = [...document.querySelectorAll('.interject-bar button')].find(x => x.textContent.trim() === '插话' && x.className.includes('primary'));
      return { state: s.state, round: s.round, btnDisabled: b ? b.disabled : 'no-btn', hasApi: typeof window.torra.interject === 'function' };
    })()
  `)
  await win.webContents.executeJavaScript(`
    (() => {
      const ta = document.querySelector('.interject-bar textarea');
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set;
      setter.call(ta, '请补充迁移期的双写成本');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const primary = [...document.querySelectorAll('.interject-bar button')].find(b => b.textContent.trim() === '插话' && b.className.includes('primary'));
      if (primary) primary.click();
      return true;
    })()
  `)
  await sleep(700)
  const ivCalls = global.__ivCalls

  // ---------- 正文：跟随条（跟随最新 / 点击锁定 / 一键退回）+ 结束原因与核验结论 ----------
  {
    const pad = (n) => `第 3 轮补充 ${n}：` + '这一段要有足够长度才能把跟随条撑出滚动条，用它模拟真实发言的篇幅。'.repeat(7)
    const push = async (ev) => {
      await win.webContents.executeJavaScript(
        `window.__torraStore.getState().applyEvent(${JSON.stringify(ev)})`
      )
      await sleep(140)
    }
    const read = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`)

    /**
     * 等一个条件成立，而不是死等一个固定时长。
     *
     * 固定 sleep 看着稳，其实把「机器这会儿有多慢」写进了判据：机器一慢，
     * 明明行为对的也判成错，于是这类失败会被当成功能坏了去查，查半天是查不出来的。
     * 轮询到条件成立为止，同时留一个上限 —— 条件真不成立时照样判失败。
     */

    await push({ type: 'state', state: 'AGENT_BATCH', round: 3 })
    for (let i = 0; i < 6; i++) {
      await push({
        type: 'utterance-done',
        utterance: { id: `uf${i}`, round: 3, agentId: i % 2 ? 'claude' : 'chatgpt', content: pad(i), targets: [], usage: { promptTokens: 0, completionTokens: 120, costUsd: 0.02 } },
      })
    }

    // 1) 跟随条默认贴最新一条，且此时不该出现「退回跟随」
    const live = await read(() => ({
      label: document.querySelector('.te-follow-label')?.textContent ?? null,
      cards: document.querySelectorAll('.te-follow .te-card').length,
      unpin: !!document.querySelector('.te-follow-unpin'),
      body: document.querySelector('.te-follow .te-card-body'),
    }))
    if (!live.cards) errors.push('跟随条里没有发言卡')
    if (!/跟随最新/.test(live.label || '')) errors.push(`跟随条没在贴最新一条：${JSON.stringify(live.label)}`)
    if (live.unpin) errors.push('没锁定时不该出现「退回跟随」')
    // 长发言在自己的面里贴底（正文只这一处滚动面，不再是整页钉底）
    if (live.body && live.body.scrollHeight - live.body.clientHeight > 8) {
      const gap = live.body.scrollHeight - live.body.scrollTop - live.body.clientHeight
      if (gap > 8) errors.push(`跟随条没贴底，离底 ${gap}px`)
    }

    // 2) 点图上的节点 = 锁定那一条：新的发言进来不许把它抢走
    const lockTarget = await read(() => {
      const ico = [...document.querySelectorAll('.te-ico')].filter((x) => !x.classList.contains('te-lane-ico'))
      const el = ico[1] || ico[0]
      if (!el) return null
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })
    await sleep(200)
    if (!lockTarget) errors.push('图上没有可点的发言节点（.te-ico）')
    const locked = await read(() => ({
      label: document.querySelector('.te-follow-label')?.textContent ?? null,
      pointer: !!document.querySelector('.te-follow .te-card.te-utt-pin'),
      stillFull: !!document.querySelector('.te-follow .te-card.te-utt'),
      unpin: !!document.querySelector('.te-follow-unpin'),
      speechLen: (document.querySelector('.rb-speech')?.textContent ?? '').length,
    }))
    if (!/已锁定/.test(locked.label || '')) errors.push(`点节点没有锁定：${JSON.stringify(locked.label)}`)
    // 锁定 = 正文收成一行指针，全文交给右栏：同一条不许在两处各铺一份
    if (!locked.pointer) errors.push('锁定后正文没收成指针（.te-utt-pin）')
    if (locked.stillFull) errors.push('锁定后正文仍铺着整张发言卡，右栏那份全文就成了第二份')
    if (!locked.unpin) errors.push('锁定后没有给出「退回跟随」的出口')
    if (locked.speechLen < 200) errors.push(`右栏「聚焦」没给全文，只读到 ${locked.speechLen} 个字符`)
    await push({
      type: 'utterance-done',
      utterance: { id: 'uf9', round: 3, agentId: 'chatgpt', content: pad(9), targets: [], usage: { promptTokens: 0, completionTokens: 120, costUsd: 0.02 } },
    })
    const still = await read(() => document.querySelector('.te-follow-label')?.textContent ?? null)
    if (!/已锁定/.test(still || '')) errors.push(`新发言把锁定的那条抢走了：${JSON.stringify(still)}`)

    // 3) 点「退回跟随」= 一键回到最新
    await read(() => { document.querySelector('.te-follow-unpin')?.click(); return true })
    await sleep(200)
    const back = await read(() => ({
      label: document.querySelector('.te-follow-label')?.textContent ?? null,
      unpin: !!document.querySelector('.te-follow-unpin'),
      card: !!document.querySelector('.te-follow .te-card.te-utt'),
      speech: !!document.querySelector('.rb-speech'),
    }))
    if (!/跟随最新/.test(back.label || '')) errors.push(`退回跟随没生效：${JSON.stringify(back.label)}`)
    if (back.unpin) errors.push('退回后「退回跟随」还挂着')
    if (!back.card) errors.push('退回后正文没回到整张发言卡')
    if (back.speech) errors.push('松开锁定后右栏还留着那份全文（聚焦没跟着清）')

    // 3.5) 点结论轴上的落点 = 聚焦收成指针、台账那一条滚到眼前：全文只有一份
    const picked = await read(() => {
      const end = document.querySelector('.te-end')
      if (!end) return null
      end.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })
    await sleep(360)
    if (!picked) errors.push('结论轴上没有落点（.te-end），指针与详版无从验起')
    // 滚动与展开是异步的：等它们真的到位，而不是赌机器够快
    await waitFor(async () => {
      const v = await read(() => {
        const claim = document.querySelector('.cs-focus .cs-claim')
        const r = claim?.getBoundingClientRect()
        const folds = [...document.querySelectorAll('.cs-focus details')].every((d) => d.open)
        return { inView: !!r && r.top < window.innerHeight && r.bottom > 0, folds }
      })
      return v && v.inView && v.folds
    }, 4000)
    const pin = await read(() => {
      const claim = document.querySelector('.cs-focus .cs-claim')
      const r = claim?.getBoundingClientRect()
      const cs = claim ? getComputedStyle(claim) : null
      return {
        pin: !!document.querySelector('.rb-pin'),
        badge: document.querySelector('.rb-pin .cs-badge')?.textContent ?? null,
        where: document.querySelector('.rb-pin .rb-btn')?.textContent ?? null,
        pinLen: (document.querySelector('.rb-pin-claim')?.textContent ?? '').length,
        fullLen: (claim?.textContent ?? '').length,
        // 详版这一条不许再被截断：曾经它就是被 clamp 成三行才读成半句
        clamp: cs ? cs.webkitLineClamp || cs.lineClamp || 'none' : null,
        folds: [...document.querySelectorAll('.cs-focus details')].every((d) => d.open),
        inView: !!r && r.top < window.innerHeight && r.bottom > 0,
      }
    })
    if (!pin.pin) errors.push('点落点后聚焦没收成指针（.rb-pin）')
    if (!/立住的|还开着|已消解|无人认领/.test(pin.badge || '')) errors.push(`指针没有桶徽标：${JSON.stringify(pin.badge)}`)
    if (!/台账/.test(pin.where || '')) errors.push(`指针没说出详版在哪一格：${JSON.stringify(pin.where)}`)
    if (pin.fullLen && pin.pinLen >= pin.fullLen) errors.push('指针把全文铺了一份，台账那条就成了第二份')
    if (pin.clamp && pin.clamp !== 'none') errors.push(`台账里那条结论仍被截断（line-clamp: ${pin.clamp}）`)
    if (!pin.folds) errors.push('点中的那条没把依据折叠展开：详版没给全')
    if (!pin.inView) errors.push('点中落点后台账那一条没滚到眼前')
    // Esc = 别再看选中的了：指针收掉，跟随条回到最新一条
    await read(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true })
    await sleep(220)
    const unpinned = await read(() => ({
      pin: !!document.querySelector('.rb-pin'),
      focused: !!document.querySelector('.cs-focus'),
      card: !!document.querySelector('.te-follow .te-card.te-utt'),
    }))
    if (unpinned.pin || unpinned.focused) errors.push('Esc 之后指针与台账描边还挂着')
    if (!unpinned.card) errors.push('Esc 之后正文没回到跟随最新一条')

    // 4) 点发言卡的「追问」= 模式、目标、光标一次到位，不再要用户自己切
    const hadFollow = await read(() => {
      const b = [...document.querySelectorAll('.te-card-ops .te-op')].find((x) => x.textContent.includes('就这条追问'))
      if (!b) return false
      b.click()
      return true
    })
    await sleep(240)
    const followReady = await read(() => ({
      activeTab: document.querySelector('.iv-tab.active')?.textContent ?? null,
      focused: document.activeElement === document.querySelector('.interject-bar textarea'),
      target: document.querySelector('.iv-select')?.value ?? null,
      kind: window.__torraStore.getState().pendingFollowup?.kind ?? null,
    }))
    if (!hadFollow) errors.push('跟随条里没有「追问」动作按钮')
    if (followReady.activeTab !== '追问') errors.push(`点追问没切到对应模式：${JSON.stringify(followReady)}`)
    if (!followReady.focused) errors.push('点追问后光标没落到输入框')
    if (!followReady.target) errors.push(`点追问后目标模型没选好：${JSON.stringify(followReady)}`)

    // 5) 「对辩」同理，还要替用户把对手补上（此前靠 toast 里那句「请补选对手」）
    const hadDuel = await read(() => {
      const b = [...document.querySelectorAll('.te-card-ops .te-op')].find((x) => x.textContent.includes('对辩'))
      if (!b) return false
      b.click()
      return true
    })
    await sleep(240)
    const duelReady = await read(() => ({
      activeTab: document.querySelector('.iv-tab.active')?.textContent ?? null,
      selects: [...document.querySelectorAll('.iv-select')].map((s) => s.value),
    }))
    if (!hadDuel) errors.push('有未消解分歧时没给出「对辩」动作按钮')
    if (duelReady.activeTab !== '对辩') errors.push(`点对辩没切到对应模式：${JSON.stringify(duelReady)}`)
    if (duelReady.selects.filter(Boolean).length < 2) errors.push(`对辩双方没自动凑齐：${JSON.stringify(duelReady.selects)}`)

    // 6) 核验结论实时进共识点：被质询撤回支持的那条要标出来，不能等报告
    //    右栏现在是单列，台账不再在第二屏，这里直接读就行
    const pointId = await read(() => window.__torraStore.getState().consensus[0]?.id ?? null)
    if (pointId) {
      await push({
        type: 'verification',
        correction: { id: 'vx1', round: 3, issue: 'unsupported_endorsement', outcome: 'denied', agentId: 'chatgpt', pointId, pointClaim: null, question: '你本人哪句话支持过这个判断？', answer: '我并未支持。', addedEvidenceRef: [], removedSupport: ['chatgpt'] },
      })
    }
    const chips = await read(() => [...document.querySelectorAll('.cs-point .cs-badge')].map((x) => x.textContent.trim()))
    if (!pointId) errors.push('共识面板里没有共识点，核验结论无从显示')
    if (!chips.some((t) => /有争议|已核验|无实质支持者/.test(t))) errors.push(`核验结论没出现在共识点上：${JSON.stringify(chips)}`)

    // 7) 结束原因写在正文的状态条上，而不是只留一个「已结束」
    await push({ type: 'done', reason: 'max-rounds' })
    await sleep(260)
    const fin = await read(() => {
      const n = document.querySelector('.te-finish')
      if (!n) return null
      const r = n.getBoundingClientRect()
      return {
        text: n.textContent,
        // 收尾行挂在图与跟随条之后：结束时人就在这一带，不该要他先滚上去找
        inView: r.top < window.innerHeight && r.bottom > 0,
      }
    })
    if (!fin) errors.push('结束后正文没有收尾说明')
    else {
      if (!/轮次用尽/.test(fin.text)) errors.push(`收尾没说清结束原因：${fin.text}`)
      if (!/没谈完/.test(fin.text)) errors.push(`收尾没解释这份结论该怎么用：${fin.text}`)
      if (!fin.inView) errors.push('收尾行挂在视口外，贴着底部的人看不到')
    }

    await cdpShot('smoke-topic-evolution.png')
  }

  // ---------- 历史页与重试 ----------
  step('历史页与重试')
  await win.webContents.executeJavaScript(`
    (() => {
      const btns = [...document.querySelectorAll('.titlebar button')];
      const h = btns.find(b => b.textContent.includes('历史'));
      if (h) h.click();
      return !!h;
    })()
  `)
  await sleep(900)

  const probeHistory = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelector(s);
      const n = (s) => document.querySelectorAll(s).length;
      return {
        historyPage: !!q('.history-page'),
        historyItems: n('.history-item'),
        badges: [...document.querySelectorAll('.hist-badge')].map(b => b.textContent),
        stats: [...document.querySelectorAll('.history-stats')].map(s => s.textContent.replace(/\\s+/g,' ').trim()),
        retryButtons: n('.retry-wrap .btn'),
        searchBox: !!q('.history-search'),
      };
    })()
  `)

  // 历史页截图（重试菜单打开前）
  await cdpShot('screenshot-m1-history.png')

  // 打开重试菜单
  await win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('.retry-wrap .btn')][0];
      if (b) b.click();
      return !!b;
    })()
  `)
  await sleep(400)

  const probeMenu = await win.webContents.executeJavaScript(`
    (() => ({
      menuOpen: !!document.querySelector('.retry-menu'),
      items: [...document.querySelectorAll('.retry-item-label')].map(x => x.textContent),
      disabled: [...document.querySelectorAll('.retry-item.disabled .retry-item-label')].map(x => x.textContent),
      hints: [...document.querySelectorAll('.retry-item-hint')].map(x => x.textContent.slice(0, 24)),
    }))()
  `)

  // 点「整场重跑」
  await win.webContents.executeJavaScript(`
    (() => {
      const it = [...document.querySelectorAll('.retry-item')].find(x => !x.classList.contains('disabled'));
      if (it) it.click();
      return !!it;
    })()
  `)
  await sleep(800)
  const retryCalls = global.__retryCalls

  // 重新打开历史并查看报告
  await win.webContents.executeJavaScript(`
    (() => {
      const btns = [...document.querySelectorAll('.titlebar button')];
      const h = btns.find(b => b.textContent.includes('历史'));
      if (h) h.click();
      return !!h;
    })()
  `)
  await sleep(600)
  await win.webContents.executeJavaScript(`
    (() => { const m = document.querySelector('.history-item-main'); if (m) m.click(); return !!m })()
  `)
  await sleep(700)

  const probeReport = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelector(s);
      const n = (s) => document.querySelectorAll(s).length;
      return {
        workspaceOpen: !!q('.rw-shell'),
        sections: [...document.querySelectorAll('.rw-block-head h3')].map(x => x.textContent),
        modes: [...document.querySelectorAll('.rw-mode')].map(x => x.textContent),
        claimCards: n('.rw-claim'),
        disputeRows: n('.rw-dispute'),
        actionCards: n('.rw-action'),
      };
    })()
  `)

  // 重试菜单展开态截图
  await cdpShot('screenshot-m1-retry-menu.png')

  // 关闭报告弹层，恢复会话页截图
  await win.webContents.executeJavaScript(`
    (() => { const b = document.querySelector('.rw-top-right .btn.icon'); if (b) b.click(); return !!b })()
  `)
  await sleep(300)
  await win.webContents.executeJavaScript(`
    (() => { const btns=[...document.querySelectorAll('.titlebar button')]; const h=btns.find(b=>b.textContent.includes('返回')); if(h) h.click(); return !!h })()
  `)
  await sleep(600)

  await cdpShot('screenshot-m1.png')

  // 设置页「模型与密钥」：API 模型行的「检查有效性」必须①只按这一台跑、
  // ②只留 api 层结论、③没配 Key 的行点不动。这三条都是纸面约定，实测才算数。
  await win.webContents.executeJavaScript(`
    (() => { const b=[...document.querySelectorAll('.titlebar button')].find(x=>x.textContent.includes('设置')); if(b) b.click(); return !!b })()
  `)
  await sleep(500)
  const probeBtns = await win.webContents.executeJavaScript(`
    (() => {
      const rows = [...document.querySelectorAll('.st-item')];
      const pick = (n) => rows.find(r => (r.querySelector('.st-name')?.textContent || '').trim() === n);
      const btn = (r) => r && [...r.querySelectorAll('.st-icon')].find(x => (x.getAttribute('aria-label') || '').includes('检查'));
      const withKey = pick('DeepSeek'), noKey = pick('主持 · DeepSeek');
      return {
        rows: rows.length,
        disabledWithKey: btn(withKey) ? btn(withKey).disabled : 'no-btn',
        disabledNoKey: btn(noKey) ? btn(noKey).disabled : 'no-btn',
      };
    })()
  `)
  if (probeBtns.rows !== 2) errors.push(`API 密钥区应有 2 行，实际 ${probeBtns.rows}`)
  if (probeBtns.disabledWithKey !== false) errors.push(`已配 Key 的行「检查有效性」应可点，实际 disabled=${probeBtns.disabledWithKey}`)
  if (probeBtns.disabledNoKey !== true) errors.push(`未配 Key 的行「检查有效性」应禁用，实际 disabled=${probeBtns.disabledNoKey}`)
  await win.webContents.executeJavaScript(`
    (() => {
      const rows = [...document.querySelectorAll('.st-item')];
      const r = rows.find(x => (x.querySelector('.st-name')?.textContent || '').trim() === 'DeepSeek');
      const b = r && [...r.querySelectorAll('.st-icon')].find(x => (x.getAttribute('aria-label') || '').includes('检查'));
      if (b) b.click();
      return !!b;
    })()
  `)
  await sleep(1400)
  const probeCheck = await win.webContents.executeJavaScript(`
    (() => {
      const row = [...document.querySelectorAll('.st-item')].find(x => (x.querySelector('.st-name')?.textContent || '').trim() === 'DeepSeek');
      const box = row && row.querySelector('.st-check');
      if (!box) return { present: false };
      return {
        present: true,
        pill: box.querySelector('.diag-pill')?.className.split(' ').pop() ?? null,
        pillText: (box.querySelector('.diag-pill')?.textContent || '').trim(),
        count: (box.querySelector('.st-check-count')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        titles: [...box.querySelectorAll('.diag-check-title')].map(x => x.textContent.trim()),
        expanded: !!box.querySelector('.diag-check'),
      };
    })()
  `)
  const doctorCall = global.__doctorCalls[global.__doctorCalls.length - 1] || {}
  if (!probeCheck.present) {
    errors.push('点了「检查有效性」没有出现结论块')
  } else {
    if (probeCheck.pill !== 'fail') errors.push(`有失败项时结论条应是 fail，实际 ${probeCheck.pill}`)
    // 2 条里只有 api 层的 1 条 pass 计入：env 层那条必须被筛掉
    if (probeCheck.count !== '通过 1 / 提醒 0 / 失败 1') errors.push(`结论计数不对：${probeCheck.count}`)
    if (!probeCheck.expanded) errors.push('存在失败项时结论应替用户展开，实际是收起的')
    if (probeCheck.titles.some((t) => t.includes('适配器目录'))) {
      errors.push(`非 api 层的结论漏进了单模型检查：${JSON.stringify(probeCheck.titles)}`)
    }
  }
  if (doctorCall.modelId !== 'deepseek' || doctorCall.probeApi !== true) {
    errors.push(`检查没有按当前模型收敛：${JSON.stringify(doctorCall)}`)
  }
  if (global.__doctorCalls.length !== 1) {
    errors.push(`点一次按钮跑了 ${global.__doctorCalls.length} 轮检查`)
  }
  // 结论条上的「重新检查」：必须重跑一次，且不能被外层折叠抢掉点击
  await win.webContents.executeJavaScript(`
    (() => { const b = document.querySelector('.st-check-head .st-icon'); if (b) b.click(); return !!b })()
  `)
  await sleep(1400)
  // 重跑是异步的：轮询到它真的发生为止，别用固定时长去赌机器速度
  await waitFor(() => global.__doctorCalls.length >= 2, 5000)
  const probeRecheck = await win.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('.st-check');
      return { expanded: !!box && !!box.querySelector('.diag-check') };
    })()
  `)
  if (global.__doctorCalls.length !== 2) {
    errors.push(`点「重新检查」应当再跑一轮，实际跑了 ${global.__doctorCalls.length} 轮`)
  }
  if (probeRecheck.expanded !== true) errors.push('点「重新检查」把明细折叠掉了（点击没被结论条拦住）')
  // 版式实测：结论条必须是一行不溢出（图标靠 margin-left:auto 顶右），
  // 明细卡不能被 .st-check 的 padding 撑出横向滚动。
  const probeGeom = await win.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('.st-check');
      const head = box && box.querySelector('.st-check-head');
      if (!head) return null;
      const mid = (e) => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
      return {
        headOverflowX: head.scrollWidth - head.clientWidth,
        boxOverflowX: box.scrollWidth - box.clientWidth,
        lanes: new Set([...head.children].map(mid)).size,
        headH: Math.round(head.getBoundingClientRect().height),
        tinted: getComputedStyle(box).backgroundColor,
      };
    })()
  `)
  if (!probeGeom) {
    errors.push('结论块没了，量不到版式')
  } else {
    if (probeGeom.headOverflowX > 0) errors.push(`结论条横向溢出 ${probeGeom.headOverflowX}px`)
    if (probeGeom.boxOverflowX > 0) errors.push(`明细卡溢出结论块 ${probeGeom.boxOverflowX}px`)
    if (probeGeom.lanes !== 1) errors.push(`结论条折成 ${probeGeom.lanes} 行了，应当是一行`)
    if (probeGeom.headH > 34) errors.push(`结论条高 ${probeGeom.headH}px，行内不该出现大块`)
    if (/rgba\\(0, 0, 0, 0\\)|transparent/.test(probeGeom.tinted)) {
      errors.push(`结论块没吃到底色：${probeGeom.tinted}`)
    }
  }
  await cdpShot('smoke-api-check.png')
  // 顺手验折叠：点结论条要把明细收起，别把设置页留在展开态影响后面的截图
  await win.webContents.executeJavaScript(`
    (() => { const h = document.querySelector('.st-check-head'); if (h) h.click(); return !!h })()
  `)
  await sleep(300)
  const collapsed = await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('.st-check'); return b ? !b.querySelector('.diag-check') : 'no-box' })()`
  )
  if (collapsed !== true) errors.push(`点结论条没收起明细：${JSON.stringify(collapsed)}`)

  // 设置页「外观」：三态选择必须在真实 DOM 里点得动、点了就换肤并回显当前意图
  await win.webContents.executeJavaScript(`
    (() => { const b=[...document.querySelectorAll('.titlebar button')].find(x=>x.textContent.includes('设置')); if(b) b.click(); return !!b })()
  `)
  await sleep(500)
  await win.webContents.executeJavaScript(`
    (() => { const b=[...document.querySelectorAll('.st-nav-item')].find(x=>x.textContent.includes('外观')); if(b) b.click(); return !!b })()
  `)
  await sleep(500)
  await cdpShot(`smoke-appearance-${BOOT_THEME}.png`)
  // 目标 = 与冷启动相反的那一项，这样「点了没换肤」才是真信号
  const flipLabel = BOOT_THEME === 'dark' ? '白天' : '黑夜'
  const flipIndex = BOOT_THEME === 'dark' ? 0 : 1
  const probeAppearance = await win.webContents.executeJavaScript(`
    (() => {
      const opts = [...document.querySelectorAll('.st-seg-item')];
      const labels = opts.map(o => o.textContent.trim());
      const active = opts.findIndex(o => o.classList.contains('on'));
      const before = document.documentElement.dataset.theme || null;
      const target = opts.find(o => o.textContent.includes('${flipLabel}'));
      if (target) target.click();
      return { labels, active, before, hasTarget: !!target };
    })()
  `)
  await sleep(500)
  probeAppearance.after = await win.webContents.executeJavaScript(`document.documentElement.dataset.theme || null`)
  probeAppearance.activeAfter = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.st-seg-item')].findIndex(o => o.classList.contains('on'))`
  )
  // 复原成冷启动主题，别把环境留在一个偶然状态
  await win.webContents.executeJavaScript(`
    (() => { const b=[...document.querySelectorAll('.st-seg-item')].find(x=>x.textContent.includes('${BOOT_THEME === 'dark' ? '黑夜' : '白天'}')); if(b) b.click(); return !!b })()
  `)
  await sleep(400)
  if (!probeAppearance || probeAppearance.labels == null) {
    errors.push(`外观页探针没返回结果（拿到 ${JSON.stringify(probeAppearance)}）`)
  } else if (probeAppearance.labels.length !== 3) {
    errors.push(`外观页应有白天/黑夜/跟随系统三个选项，实际 ${JSON.stringify(probeAppearance.labels)}`)
  }
  if (!probeAppearance.hasTarget) {
    errors.push(`外观页找不到「${flipLabel}」选项`)
  } else if (probeAppearance.after === probeAppearance.before) {
    errors.push(`点「${flipLabel}」没换肤：仍是 ${probeAppearance.after}`)
  } else if (probeAppearance.activeAfter !== flipIndex) {
    errors.push(`点「${flipLabel}」后高亮没跟过去：active 下标 ${probeAppearance.activeAfter}，应为 ${flipIndex}`)
  }

  // 「资源库 → 技能」页的筛选框：它一度直接套 .field（表单输入样式），
  // 在筛选条里撑成厚板、聚焦光晕还和相邻控件叠成双层边框。这里连样式一起验。
  // 资源库默认落在「技能」子页，所以进页签即可，不用再点子页。
  await win.webContents.executeJavaScript(`
    (() => { const b=[...document.querySelectorAll('.st-nav-item')].find(x=>x.textContent.includes('资源库')); if(b) b.click(); return !!b })()
  `)
  await sleep(500)
  const probeSearch = await win.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('.search-box');
      const el = box && box.querySelector('input');
      if (!el) return { found: false };
      el.focus();
      const cs = getComputedStyle(el);
      return {
        found: true,
        fontSize: cs.fontSize,
        padLeft: cs.paddingLeft,
        marginBottom: cs.marginBottom,
        shadow: cs.boxShadow !== 'none',
        icon: !!box.querySelector('svg'),
      };
    })()
  `)
  await sleep(250)
  await cdpShot('smoke-search-focus.png')
  if (!probeSearch.found) {
    errors.push('资源库的技能页没找到 .search-box 筛选框（已加载清单没渲染出来？）')
  } else if (probeSearch.fontSize !== '12px' || probeSearch.padLeft !== '27px' || probeSearch.marginBottom !== '0px' || !probeSearch.icon) {
    errors.push(`搜索框样式退回成表单输入了：${JSON.stringify(probeSearch)}`)
  }
  // 光有框不算数：键入关键词必须真的把清单筛掉（走 React 的受控更新）
  await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('.search-box input');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, 'pdf');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `)
  await sleep(400)
  const afterFilter = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.st-name')].map(x => x.textContent)`
  )
  if (!afterFilter.some((t) => t.includes('pdf-forms'))) {
    errors.push(`搜「pdf」把该留的也筛掉了：${JSON.stringify(afterFilter)}`)
  } else if (afterFilter.some((t) => t.includes('release-notes') || t.includes('sql-tools'))) {
    errors.push(`搜「pdf」没筛掉不匹配项：${JSON.stringify(afterFilter)}`)
  }
  // 设置页「关于」：冒烟跑的是开发构建，本机没有可替换的安装包 —— 「检查更新」
  // 必须是禁用的，而且理由要既写在 title 里、也写在抬头那句结论里。
  // 按钮亮着、点下去什么都不发生，是这一格最坏的失败方式。
  await win.webContents.executeJavaScript(`
    (() => { const b=[...document.querySelectorAll('.st-nav-item')].find(x=>x.textContent.includes('关于')); if(b) b.click(); return !!b })()
  `)
  await sleep(600)
  const probeAbout = await win.webContents.executeJavaScript(`
    (() => {
      const secs = [...document.querySelectorAll('.st-section')];
      const btn = [...document.querySelectorAll('.st-btn')].find(x => x.textContent.includes('检查更新'));
      const openDir = [...document.querySelectorAll('.st-icon')].find(x => x.getAttribute('aria-label') === '打开数据目录');
      return {
        sections: secs.length,
        hasCheck: !!btn,
        disabled: btn ? btn.disabled : null,
        reason: btn ? (btn.getAttribute('title') || '') : '',
        versionRow: [...document.querySelectorAll('.st-name')].some(x => x.textContent.trim() === 'Torra'),
        // 「打开数据目录」只有拿到 about:info 才可点 —— 路径本身不再显示给用户
        dirReady: openDir ? !openDir.disabled : false,
        // 本机绝对路径属于排查信息，画在这一格里既没用又泄露目录结构
        pathLeaked: secs.map(s => s.textContent).join(' ').includes(${JSON.stringify(app.getPath('userData'))}),
        // 第三方组件清单不再属于这一格：出现任何一行许可字样都算回归
        licenseWall: secs.map(s => s.textContent).join(' ').includes('开源许可'),
        meter: !!document.querySelector('.st-meter'),
        note: (document.querySelector('.st-note') || {}).textContent || '',
      };
    })()
  `)
  await cdpShot('smoke-about-tab.png')
  if (!probeAbout.hasCheck) {
    errors.push('关于页没有「检查更新」按钮（AboutSection 没渲染出来？）')
  } else if (!probeAbout.disabled) {
    errors.push('开发构建里「检查更新」不该可点：本机没有可被替换的安装包')
  }
  if (!/开发构建/.test(probeAbout.reason)) errors.push(`禁用理由没写进按钮 title：${JSON.stringify(probeAbout.reason)}`)
  if (!/开发构建/.test(probeAbout.note)) errors.push(`抬头那句结论里看不到禁用理由：${JSON.stringify(probeAbout.note)}`)
  if (!probeAbout.versionRow) errors.push('关于页没渲染出版本那一行')
  if (!probeAbout.dirReady) {
    errors.push('「打开数据目录」还是禁用的（about:info 没通，或 dataDir 没回来）')
  }
  if (probeAbout.pathLeaked) errors.push('关于页把本机数据目录的绝对路径显示给用户了（这一格只该给按钮）')
  if (probeAbout.licenseWall) errors.push('关于页又画出了第三方组件/许可清单（这一格只该有版本与数据两区）')
  if (probeAbout.meter) errors.push('一次都没下载过却画出了进度条')
  if (probeAbout.sections !== 2) errors.push(`关于页应有 2 个分区，实际 ${probeAbout.sections}`)

  // 回讨论页，别把助手抽屉那段截在设置页里
  await win.webContents.executeJavaScript(`
    (() => { const btns=[...document.querySelectorAll('.titlebar button')]; const h=btns.find(b=>b.textContent.includes('返回')); if(h) h.click(); return !!h })()
  `)
  await sleep(500)

  // ---------- 聊天输入卡片 ----------
  step('聊天输入卡片')
  // 输入区曾经被两套规则同时管：卡片里又套了一个带边框的 textarea，看着像两个输入框。
  await win.webContents.executeJavaScript(`
    (() => { const b=[...document.querySelectorAll('.titlebar button')].find(x=>x.textContent.includes('聊天')); if(b) b.click(); return !!b })()
  `)
  await sleep(700)
  const probeComposer = await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('.cx-dock');
      const el = document.querySelector('.cx-input');
      if (!row || !el) return { found: false, hasRow: !!row, hasInput: !!el };
      el.focus();
      const rs = getComputedStyle(row);
      const es = getComputedStyle(el);
      return {
        found: true,
        rowRadius: rs.borderRadius,
        inputBorder: es.borderTopWidth,
        inputBg: es.backgroundColor,
        height: Math.round(el.getBoundingClientRect().height),
      };
    })()
  `)
  await cdpShot('smoke-chat-composer.png')
  if (!probeComposer.found) {
    errors.push(`聊天页没有输入卡片（拿到 ${JSON.stringify(probeComposer)}；是不是没勾选参与者）`)
  } else if (probeComposer.inputBorder !== '0px') {
    errors.push(`输入框自己还画了一圈边框，卡片里套卡片：${JSON.stringify(probeComposer)}`)
  } else if (probeComposer.rowRadius !== '20px') {
    errors.push(`输入卡片圆角不对：${probeComposer.rowRadius}`)
  } else {
    // 只收掉一圈边框还不够：长问题得跟着内容长高，否则又回到一行里左右滚
    const setVal = (v) =>
      win.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector('.cx-input');
          if (!el) return false;
          const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          set.call(el, ${JSON.stringify(v)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `)
    const tall = '第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行'
    await setVal(tall)
    await sleep(400)
    const grew = await win.webContents.executeJavaScript(
      `Math.round(document.querySelector('.cx-input').getBoundingClientRect().height)`
    )
    await cdpShot('smoke-chat-composer-tall.png')
    if (grew <= probeComposer.height) {
      errors.push(`输入框没跟着内容长高：${probeComposer.height} → ${grew}`)
    } else if (grew > 184) {
      errors.push(`输入框长高没有上限（${grew}px，应封顶在 180px 左右）`)
    }
    await setVal('')
    await sleep(200)
  }
  await win.webContents.executeJavaScript(`
    (() => { const btns=[...document.querySelectorAll('.titlebar button')]; const h=btns.find(b=>b.textContent.includes('研讨')); if(h) h.click(); return !!h })()
  `)
  await sleep(500)

  // ---------- 助手抽屉 ----------
  step('助手抽屉')
  // 这一段把三条「只有渲染层才知道对错」的逻辑摊开验证：
  // 流式增量该并进同一段回答、工具态切换该收掉转圈、确认卡片该把决定送回主进程。
  // 事件用主进程 webContents.send 走真实通道推，比在控制台里调组件更贴近运行时。
  const pushStream = async (e) => {
    win.webContents.send('assistant:stream', e)
    // 一轮到此为止：把挂着的 send 放行，免得后面每一步都还在「正在工作」
    if (e.kind === 'settled' || e.kind === 'error') endAssistantTurn()
    await sleep(140)
  }
  const snapAssistant = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const n = (s) => document.querySelectorAll(s).length;
        const t = (s) => document.querySelector(s)?.textContent.replace(/\\s+/g,' ').trim() ?? null;
        const txt = (el) => el ? el.textContent.replace(/\\s+/g,' ').trim() : null;
        const say = [...document.querySelectorAll('.a-say-body')];
        return {
          drawer: n('.assistant-drawer'),
          state: t('.assistant-state'),
          pickerName: t('.a-picker-name'),
          pickerDisabled: document.querySelector('.a-picker-btn')?.disabled ?? null,
          chips: [...document.querySelectorAll('.a-picker-btn .a-chip')].map(x => x.textContent.trim()),
          userLines: n('.a-user'),
          sayLines: n('.a-say'),
          lastAssistant: txt(say[say.length - 1]),
          stepGroups: n('.a-steps'),
          think: n('.a-think'),
          tools: n('.a-step:not(.a-think)'),
          stepsRunning: n('.a-steps.running'),
          stepsBad: n('.a-steps.bad'),
          toolOut: n('.a-step:not(.a-think) .a-step-out'),
          status: [...document.querySelectorAll('.a-note')].map(x => x.textContent.trim()),
          errorLines: [...document.querySelectorAll('.a-alert')].map(x => x.textContent.trim()),
          alertHeads: [...document.querySelectorAll('.a-alert > span')].map(x => txt(x)),
          alertRaw: [...document.querySelectorAll('.a-alert-raw')].map(x => ({
            open: x.hasAttribute('open'),
            code: txt(x.querySelector('code')),
          })),
          note: n('.assistant-note'),
          /* 小字号中文正文一旦继承到粗体，笔画会并成一条横线，截图里看着像删除线却很难归因，
           * 所以直接量计算值：正文只允许 400，且不许有任何划线。 */
          textStyle: [...document.querySelectorAll('.a-say-body, .a-alert > span')].map(x => {
            const s = getComputedStyle(x);
            return { w: s.fontWeight, d: s.textDecorationLine };
          }),
          tally: t('.a-tally'),
          busy: t('.a-busy'),
          empty: n('.assistant-empty'),
          quickAsks: [...document.querySelectorAll('.assistant-chip')].map(x => x.textContent.trim()),
          approveKind: t('.a-ap-kind'),
          approveTitle: t('.a-ap-head b'),
          approveDetail: t('.a-ap-detail'),
          approveRisk: t('.a-ap-risk'),
          approveButtons: [...document.querySelectorAll('.a-ap-actions button')].map(b => b.textContent.trim()),
          keyInput: document.querySelector('.a-ap-key input')?.value ?? null,
          keyType: document.querySelector('.a-ap-key input')?.type ?? null,
          approveHint: t('.a-ap-hint'),
          footButtons: [...document.querySelectorAll('.ac-bar button')].map(b => ({
            label: b.textContent.trim() || b.getAttribute('aria-label'),
            disabled: b.disabled,
          })),
          // 送出/停止是同一枚键位：忙碌态只换它的图标和类，不换位置
          sendKey: (() => {
            const b = document.querySelector('.ac-send')
            if (!b) return null
            return {
              label: b.getAttribute('aria-label') || b.textContent.trim(),
              disabled: b.disabled,
              stop: b.classList.contains('stop'),
            }
          })(),
          queueKey: !!document.querySelector('.ac-queue'),
          draft: document.querySelector('.ac-input')?.value ?? null,
          drawerText: t('.assistant-drawer'),
        };
      })()
    `)
  const clickCardButton = (label) =>
    win.webContents.executeJavaScript(`
      (() => { const b = [...document.querySelectorAll('.a-ap-actions button')].find(x => x.textContent.includes('${label}')); if (b) b.click(); return !!b })()
    `)
  const clickSend = () =>
    win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.ac-send'); if (b && !b.disabled) b.click(); return !!b })()`
    )
  // 打开模型弹层并读回它列出的东西（助手模型只能取 api + 启用）
  // 点完必须等一次渲染：React 的 onClick 只改状态，同一拍里读不到弹层
  const probePicker = async () => {
    await win.webContents.executeJavaScript(`document.querySelector('.a-picker-btn')?.click()`)
    await sleep(200)
    /* 入场动画还没走完就量几何，会读到 opacity:0 的中间帧（窗口不在前台时 Chromium 会节流动画）。
     * 先让动画落地，再量 —— 我们要判的是「弹层画没画出来」，不是「动画跑到第几毫秒」。 */
    await win.webContents.executeJavaScript(`
      (() => {
        const pop = document.querySelector('.a-picker-pop');
        for (const a of (pop?.getAnimations?.({ subtree: true }) ?? [])) { try { a.finish() } catch (e) {} }
      })()
    `)
    await sleep(60)
    return win.webContents.executeJavaScript(`
      (() => {
        const btn = document.querySelector('.a-picker-btn');
        const pop = document.querySelector('.a-picker-pop');
        /* DOM 里有不等于看得见：弹层被裁掉、被压住、算出 0 高度，只有几何能暴露 */
        const g = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                   op: cs.opacity, vis: cs.visibility, disp: cs.display };
        };
        return {
          opened: !!pop,
          popBox: g(pop),
          btnBox: g(btn),
          drawerBox: g(document.querySelector('.assistant-drawer')),
          items: [...document.querySelectorAll('.a-pop-item')].map(b => ({
            name: b.querySelector('.a-pop-main b')?.textContent.trim() ?? null,
            detail: b.querySelector('.a-pop-main i')?.textContent.trim() ?? null,
            chip: b.querySelector('.a-chip')?.textContent.trim() ?? null,
            active: b.classList.contains('active'),
          })),
          empty: document.querySelector('.a-pop-empty')?.textContent.trim() ?? null,
        };
      })()
    `)
  }
  const pickFromPicker = (name) =>
    win.webContents.executeJavaScript(`
      (() => {
        const b = [...document.querySelectorAll('.a-pop-item')].find(x => x.querySelector('.a-pop-main b')?.textContent.trim() === ${JSON.stringify(name)});
        if (!b) return false;
        b.click();
        return true;
      })()
    `)
  const setField = (selector, value) =>
    win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('${selector}');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `)

  const A = {}
  // 跑到哪儿就把已知的结论先存进报告：后面再崩，结论也不会跟着一起丢
  Object.assign(report, {
    probe_theme: probeTheme,
    probe_appearance: probeAppearance,
    probe_split: probeSplit,
    probe_guide: probe1,
    probe_session: probe2,
    probe_history: probeHistory,
    probe_menu: probeMenu,
    probe_report: probeReport,
    assistantCalls: global.__assistantCalls,
    assistantApprovals: global.__assistantApprovals,
    ivCalls,
    retryCalls,
    preClick,
  })
  await win.webContents.executeJavaScript(`document.querySelector('.assistant-toggle')?.click()`)
  await sleep(700)
  A.open = await snapAssistant()
  if (A.open.drawer !== 1) errors.push('点标题栏助手按钮没打开抽屉（.assistant-drawer 数量 ' + A.open.drawer + '）')
  if (A.open.state !== '待命') errors.push(`空闲态该显示「待命」，实际「${A.open.state}」`)
  if (A.open.pickerName !== 'DeepSeek') errors.push(`模型选择器没显示状态里的模型：${A.open.pickerName}`)
  // 历史必须能回放成对话，否则重开抽屉就失忆
  if (!(A.open.userLines === 1 && A.open.sayLines === 1 && A.open.tools === 1)) {
    errors.push(`历史回放不对：user ${A.open.userLines} / say ${A.open.sayLines} / tool ${A.open.tools}`)
  }
  if (A.open.note !== 0) errors.push('有可用模型时不该显示「去设置页」提示')
  // 账目条来自 assistant:stats：这条 IPC 断了不会报错，只会安静地少一块信息
  if (!/3 问/.test(A.open.tally ?? '')) errors.push(`累计账没渲染出来：${A.open.tally}`)

  // 弹层选项：网页模型和停用模型不能出现在这里，缺 Key 的必须标出来
  A.picker = await probePicker()
  if (!A.picker?.opened) errors.push('模型选择器点了没展开')
  else if (JSON.stringify(A.picker.items.map((x) => x.name)) !== JSON.stringify(['DeepSeek', 'GLM-4.5'])) {
    errors.push(`助手模型选项不对：${JSON.stringify(A.picker.items)}`)
  } else if (!(A.picker.items[0].active && A.picker.items[1].chip === '缺 Key')) {
    errors.push(`选项的选中态/缺 Key 标注不对：${JSON.stringify(A.picker.items)}`)
  } else if (!String(A.picker.items[0].detail).includes('deepseek-chat')) {
    errors.push(`选项里该带上端点与模型名，方便认出用的到底是哪个：${A.picker.items[0].detail}`)
  }
  {
    // 展开的弹层必须真的落在屏幕上：只查 DOM 存在的话，被裁掉/被压住都测不出来
    const { popBox, btnBox, drawerBox } = A.picker
    const bad =
      !popBox ||
      popBox.w < 200 ||
      popBox.h < A.picker.items.length * 24 ||
      Number(popBox.op) === 0 ||
      popBox.vis !== 'visible' ||
      // 选择器在输入卡片里、贴着视口底部，弹层只能往上开：底边越过按钮顶边就是开反了方向
      popBox.y + popBox.h > btnBox.y + 2 ||
      popBox.x < drawerBox.x - 1 ||
      popBox.x + popBox.w > drawerBox.x + drawerBox.w + 1
    if (bad) {
      errors.push(`模型弹层几何不对：pop ${JSON.stringify(popBox)} btn ${JSON.stringify(btnBox)} drawer ${JSON.stringify(drawerBox)}`)
    }
  }

  // 切到一个没配 Key 的模型：主进程回绝后必须退回原模型，并把原因写进对话
  await cdpShot('smoke-assistant-picker.png')
  await pickFromPicker('GLM-4.5')
  await sleep(300)
  A.switchFailed = await snapAssistant()
  if (!global.__assistantCalls.some((c) => c.fn === 'set-model' && c.modelId === 'glm')) {
    errors.push('切模型没走到 IPC')
  }
  if (!A.switchFailed.errorLines.some((x) => x.includes('还没配 API Key'))) {
    errors.push(`切模型失败的原因没显示出来：${JSON.stringify(A.switchFailed.errorLines)}`)
  }
  if (A.switchFailed.pickerName !== 'DeepSeek') {
    errors.push(`切换失败后选择器没退回可用模型：${A.switchFailed.pickerName}`)
  }
  await cdpShot('smoke-assistant-open.png')

  // 发送：乐观上屏 + 立刻进忙碌态
  await setField('.ac-input', '查一下 deepseek 为什么超时')
  await clickSend()
  await sleep(250)
  A.sent = await snapAssistant()
  const lastSend = global.__assistantCalls.filter((c) => c.fn === 'send').pop()
  if (lastSend?.text !== '查一下 deepseek 为什么超时') errors.push(`发送没走到 IPC：${JSON.stringify(lastSend)}`)
  if (A.sent.userLines !== 2) errors.push(`发送后没有立刻上屏用户行：${A.sent.userLines}`)
  if (A.sent.draft !== '') errors.push('发送后输入框没清空')
  if (!A.sent.busy) errors.push('发送后没有忙碌反馈（用户会以为没反应）')
  if (A.sent.state !== '正在工作') errors.push(`忙碌态标题该跟着变：${A.sent.state}`)
  if (!(A.sent.sendKey?.stop && A.sent.sendKey.disabled === false && A.sent.queueKey)) {
    errors.push(`忙碌态该是「停止 + 可插话」：${JSON.stringify([A.sent.sendKey, A.sent.queueKey])}`)
  }

  // 流式回放
  await pushStream({ kind: 'thinking', delta: '先读日志，再看适配器健康度。' })
  await pushStream({ kind: 'tool-start', id: 't1', name: 'read_log', label: '读取 deepseek 流水线日志', args: {} })
  A.running = await snapAssistant()
  if (A.running.stepsRunning !== 1) errors.push('工具执行中没有 running 态')
  if (A.running.tools !== 2) errors.push(`新工具没并进本轮步骤组：${A.running.tools}`)
  await pushStream({ kind: 'tool-end', id: 't1', name: 'read_log', ok: true, excerpt: '3 条 request timeout' })
  await pushStream({ kind: 'tool-start', id: 't2', name: 'check_adapter', label: '检查 deepseek 适配器', args: {} })
  await pushStream({ kind: 'tool-end', id: 't2', name: 'check_adapter', ok: false, excerpt: 'reply 选择器未命中' })
  await pushStream({ kind: 'text', delta: '结论：deepseek ' })
  await pushStream({ kind: 'text', delta: '因网络侧超时失败，适配器本身没问题。' })
  A.streamed = await snapAssistant()
  if (A.streamed.lastAssistant !== '结论：deepseek 因网络侧超时失败，适配器本身没问题。') {
    errors.push(`流式增量没并进同一段：${JSON.stringify(A.streamed.lastAssistant)}`)
  }
  if (A.streamed.sayLines !== 2) errors.push(`增量不该各起一段：say 段数 ${A.streamed.sayLines}`)
  if (A.streamed.think !== 1) errors.push(`思考行没折叠成一条：${A.streamed.think}`)
  if (A.streamed.stepGroups !== 2) errors.push(`一轮的思考+工具该收进一个步骤组：${A.streamed.stepGroups}`)
  if (A.streamed.stepsBad !== 1 || A.streamed.stepsRunning !== 0) {
    errors.push(`工具态没收口：running ${A.streamed.stepsRunning} / bad ${A.streamed.stepsBad}`)
  }
  if (A.streamed.toolOut !== 2) errors.push(`工具结果摘要没渲染：${A.streamed.toolOut} 段`)
  const heavy = (A.streamed.textStyle ?? []).filter((x) => Number(x.w) >= 500 || x.d !== 'none')
  if (heavy.length) errors.push(`助手正文被加粗或划线了（小字号中文会糊成一条横线）：${JSON.stringify(heavy)}`)
  await cdpShot('smoke-assistant-stream.png')

  // settled 是唯一收口：忙碌态必须消失，按钮回到发送
  await pushStream({ kind: 'settled' })
  A.settled = await snapAssistant()
  if (A.settled.busy) errors.push(`收到 settled 还在转圈：${A.settled.busy}`)
  if (A.settled.state !== '待命') errors.push(`settled 后状态标题该回「待命」：${A.settled.state}`)
  if (!(A.settled.sendKey?.label === '送出' && A.settled.sendKey.disabled && !A.settled.sendKey.stop && !A.settled.queueKey)) {
    errors.push(`回合结束后按钮状态不对：${JSON.stringify([A.settled.sendKey, A.settled.queueKey])}`)
  }

  // 错误事件也必须收掉忙碌态（否则一次失败就永远转圈）
  // 主进程给的是「人话 + 原文」两段：界面上默认只露人话，原文收在折叠里
  await pushStream({
    kind: 'error',
    text: '模型端点上找不到要用的模型名。请在设置页核对该模型的「模型标识」。',
    detail: '404: glm-4.6 is not supported by this endpoint',
  })
  A.errored = await snapAssistant()
  if (!A.errored.errorLines.some((x) => x.includes('模型端点上找不到'))) {
    errors.push(`error 事件没显示成错误块：${JSON.stringify(A.errored.errorLines)}`)
  }
  if (A.errored.busy) errors.push('收到 error 还在转圈')
  {
    const raw = A.errored.alertRaw[A.errored.alertRaw.length - 1]
    if (!raw || raw.code !== '404: glm-4.6 is not supported by this endpoint') {
      errors.push(`错误块里没有可展开的原始信息：${JSON.stringify(A.errored.alertRaw)}`)
    } else if (raw.open) {
      errors.push('原始信息默认就该收起：一屏红字里混着堆栈等于没有说明')
    }
    if (A.errored.alertHeads.some((x) => /404: glm/.test(x))) {
      errors.push(`原文混进了错误块标题：${JSON.stringify(A.errored.alertHeads)}`)
    }
  }

  // 发送被主进程直接回绝（会话建不起来）：结论要出现在对话里，且不能留下转圈
  await setField('.ac-input', '【失败】再来一轮')
  await clickSend()
  await sleep(400)
  A.sendFailed = await snapAssistant()
  if (!A.sendFailed.errorLines.some((x) => x.includes('请在设置页新建'))) {
    errors.push(`发送失败的原因没显示出来：${JSON.stringify(A.sendFailed.errorLines)}`)
  }
  if (!A.sendFailed.alertRaw.some((x) => String(x.code).includes('ensureAssistant'))) {
    errors.push(`invoke 返回的原文没能带进折叠：${JSON.stringify(A.sendFailed.alertRaw)}`)
  }
  if (A.sendFailed.busy) errors.push('发送失败后还在转圈（invoke 返回值那条路没收口）')
  if (!(A.sendFailed.sendKey?.label === '送出' && !A.sendFailed.sendKey.stop && !A.sendFailed.queueKey)) {
    errors.push(`发送失败后底部按钮没回到发送态：${JSON.stringify(A.sendFailed.sendKey)}`)
  }

  // 确认卡片：允许
  win.webContents.send('assistant:approval:request', {
    id: 'ap1',
    action: 'save_adapter',
    title: '写入 deepseek 适配器',
    detail: '把 reply 选择器改为 .answer-box',
    risk: '选择器写错会让下一场讨论全部读不到回复',
  })
  await sleep(300)
  A.card = await snapAssistant()
  if (A.card.approveTitle !== '写入 deepseek 适配器') errors.push(`确认卡片标题没渲染：${A.card.approveTitle}`)
  if (A.card.approveKind !== '改配置') errors.push(`卡片该标出动作种类：${A.card.approveKind}`)
  if (!String(A.card.approveRisk).includes('读不到回复')) errors.push('确认卡片的风险说明没渲染')
  if (!(A.card.approveButtons[0]?.includes('拒绝') && A.card.approveButtons[1]?.includes('允许执行'))) {
    errors.push(`确认卡片按钮不对：${JSON.stringify(A.card.approveButtons)}`)
  }
  if (!(A.card.approveButtons[0]?.includes('Esc') && A.card.approveButtons[1]?.includes('Ctrl+Enter'))) {
    errors.push(`卡片上没写键盘出口：${JSON.stringify(A.card.approveButtons)}`)
  }
  if (A.card.keyInput !== null) errors.push('非建模型卡片不该有 Key 输入框')
  await cdpShot('smoke-assistant-approval.png')
  const approvalsAfter1 = global.__assistantApprovals.length
  await clickCardButton('允许')
  await sleep(300)
  A.approved = global.__assistantApprovals[approvalsAfter1]
  if (!(A.approved?.id === 'ap1' && A.approved.decision.approved === true)) {
    errors.push(`允许没回传正确决定：${JSON.stringify(A.approved)}`)
  }
  if ((await snapAssistant()).approveTitle !== null) errors.push('允许后卡片没收掉')
  if (!(await snapAssistant()).status.some((x) => x.includes('已允许'))) {
    errors.push('允许后没有「已允许」回执行')
  }

  // 确认卡片：需要 Key
  win.webContents.send('assistant:approval:request', {
    id: 'ap2',
    action: 'create_api_model',
    title: '新建 API 模型 GLM',
    detail: 'baseUrl https://open.bigmodel.cn/api/paas/v4 · 模型 glm-4.5-air',
    needsKey: true,
  })
  await sleep(300)
  A.keyCard = await snapAssistant()
  if (A.keyCard.approveKind !== '新建模型') errors.push(`建模型卡片种类标注不对：${A.keyCard.approveKind}`)
  if (A.keyCard.keyType !== 'password') errors.push(`Key 输入框必须是密码态：${A.keyCard.keyType}`)
  const approvalsBeforeEmpty = global.__assistantApprovals.length
  await clickCardButton('允许')
  await sleep(250)
  A.blocked = await snapAssistant()
  if (!String(A.blocked.approveHint).includes('必须填入 Key')) errors.push('空 Key 允许时没拦下来')
  if (global.__assistantApprovals.length !== approvalsBeforeEmpty) {
    errors.push('空 Key 也回传了主进程，会建出一个没 Key 的模型')
  }
  await setField('.a-ap-key input', 'sk-smoke-secret-123')
  await sleep(150)
  // Key 输入框里按 Enter 就等于允许（填完不必再挪一次手去点按钮）
  await win.webContents.executeJavaScript(`
    (() => { const i = document.querySelector('.a-ap-key input'); if (!i) return false; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()
  `)
  await sleep(300)
  A.keyApproved = global.__assistantApprovals[approvalsBeforeEmpty]
  if (A.keyApproved?.decision?.apiKey !== 'sk-smoke-secret-123') {
    errors.push(`Key 没原样交给主进程：${JSON.stringify(Object.keys(A.keyApproved?.decision ?? {}))}`)
  }
  if ((await snapAssistant()).drawerText.includes('sk-smoke-secret-123')) {
    errors.push('Key 出现在抽屉文本里（应当只进主进程）')
  }
  if ((await snapAssistant()).keyInput !== null) errors.push('允许后 Key 输入框没清掉')

  // 键盘允许：焦点在卡片上时 Ctrl+Enter 等价于点「允许执行」
  win.webContents.send('assistant:approval:request', { id: 'ap5', action: 'delete_model', title: '删除模型 gemini', detail: '会移除其配置' })
  await sleep(300)
  await win.webContents.executeJavaScript(`
    (() => { const c = document.querySelector('.assistant-approve'); if (!c) return false; c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); return true })()
  `)
  await sleep(300)
  A.byKeyboard = global.__assistantApprovals.find((x) => x.id === 'ap5')
  if (A.byKeyboard?.decision?.approved !== true) {
    errors.push(`Ctrl+Enter 没能允许卡片：${JSON.stringify(A.byKeyboard)}`)
  }

  // 拒绝按钮
  win.webContents.send('assistant:approval:request', { id: 'ap3', action: 'delete_model', title: '删除模型 gemini', detail: '会移除其配置' })
  await sleep(300)
  const approvalsBeforeReject = global.__assistantApprovals.length
  await clickCardButton('拒绝')
  await sleep(300)
  A.rejected = global.__assistantApprovals[approvalsBeforeReject]
  if (A.rejected?.decision?.approved !== false) errors.push(`拒绝没回传 approved:false：${JSON.stringify(A.rejected)}`)

  // Esc 分层：有卡片时只退卡片，不能把抽屉一起关掉
  win.webContents.send('assistant:approval:request', { id: 'ap6', action: 'open_login', title: '打开 deepseek 登录窗口', detail: '需要你在窗口里完成登录' })
  await sleep(300)
  await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await sleep(300)
  A.escCard = global.__assistantApprovals.find((x) => x.id === 'ap6')
  if (A.escCard?.decision?.approved !== false || !String(A.escCard?.decision?.reason).includes('Esc')) {
    errors.push(`Esc 该先取消卡片：${JSON.stringify(A.escCard)}`)
  }
  if ((await snapAssistant()).drawer !== 1) errors.push('Esc 取消卡片时把抽屉一起关了（越级）')

  // 关抽屉不能把确认卡片丢在主进程干等超时
  win.webContents.send('assistant:approval:request', { id: 'ap4', action: 'open_login', title: '打开 deepseek 登录窗口', detail: '需要你在窗口里完成登录' })
  await sleep(300)
  await win.webContents.executeJavaScript(`document.querySelector('.assistant-head button[title^="关闭"]')?.click()`)
  await sleep(400)
  A.closed = await snapAssistant()
  if (A.closed.drawer !== 0) errors.push('点关闭没收起抽屉')
  const dismissed = global.__assistantApprovals.find((x) => x.id === 'ap4')
  if (dismissed?.decision?.reason !== '用户关闭了助手面板') {
    errors.push(`关抽屉时未决卡片没被代拒：${JSON.stringify(dismissed)}`)
  }

  // 抽屉关干净后，Esc 才是「收起面板」
  await win.webContents.executeJavaScript(`document.querySelector('.assistant-toggle')?.click()`)
  await sleep(500)
  await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await sleep(400)
  A.escClosed = await snapAssistant()
  if (A.escClosed.drawer !== 0) errors.push('按 Esc 没收起抽屉')

  // 明暗两套各留一张：抽屉是这轮重做的主战场，只看一套等于没看
  await win.webContents.executeJavaScript(`document.querySelector('.assistant-toggle')?.click()`)
  await sleep(700)
  await pushStream({ kind: 'thinking', delta: '先读日志，再看适配器健康度。' })
  await pushStream({ kind: 'tool-start', id: 'v1', name: 'read_log', label: '读取 deepseek 流水线日志', args: {} })
  await pushStream({ kind: 'tool-end', id: 'v1', name: 'read_log', ok: true, excerpt: '3 条 request timeout' })
  await pushStream({ kind: 'text', delta: '结论：deepseek 因网络侧超时失败，适配器本身没问题。' })
  win.webContents.send('assistant:approval:request', {
    id: 'vis',
    action: 'create_api_model',
    title: '新建 API 模型 GLM',
    detail: 'baseUrl https://open.bigmodel.cn/api/paas/v4 · 模型 glm-4.5-air',
    needsKey: true,
    risk: 'Key 只交给主进程加密保存，不会进入对话记录',
  })
  await sleep(300)
  A.visual = await snapAssistant()
  const setTheme = async (th) => {
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(th)}`)
    await sleep(250)
  }
  for (const th of ['light', 'dark']) {
    await setTheme(th)
    await cdpShot(`smoke-assistant-${th}.png`)
  }

  // 空状态：没有任何历史时，抽屉该直接给出可点的起点，而不是留一块白板
  await win.webContents.executeJavaScript(`document.querySelector('.assistant-head button[title^="关闭"]')?.click()`)
  await sleep(400)
  global.__assistantEmpty = true
  await win.webContents.executeJavaScript(`document.querySelector('.assistant-toggle')?.click()`)
  await sleep(700)
  A.empty = await snapAssistant()
  if (!(A.empty.empty === 1 && A.empty.quickAsks.length === 3)) {
    errors.push(`空状态没给出可点的起点：empty ${A.empty.empty} / chips ${JSON.stringify(A.empty.quickAsks)}`)
  }
  if (A.empty.userLines !== 0) errors.push('历史为空却回放出了对话行')
  if (A.empty.tally) errors.push(`还没对话过就不该有累计账：${A.empty.tally}`)
  for (const th of ['light', 'dark']) {
    await setTheme(th)
    await cdpShot(`smoke-assistant-empty-${th}.png`)
  }
  // 点起点 = 直接发问，不必再打字
  await setTheme('light')
  await win.webContents.executeJavaScript(`document.querySelector('.assistant-chip')?.click()`)
  await sleep(400)
  A.chipSent = await snapAssistant()
  const chipText = global.__assistantCalls.filter((c) => c.fn === 'send').pop()
  if (!(A.empty.quickAsks[0] && chipText?.text === A.empty.quickAsks[0])) {
    errors.push(`快捷起点没把这句话发出去：${JSON.stringify(chipText)}`)
  }
  if (A.chipSent.empty !== 0) errors.push('发问后空状态还占着位置')
  await pushStream({ kind: 'settled' })
  await setTheme('dark')
  await cdpShot('smoke-assistant-chip.png')

  // 错误块的「查看原始信息」：默认收起，点开要能整段读到原文
  await pushStream({
    kind: 'error',
    text: '连不上模型端点。请检查网络，或在设置页核对该模型的 Base URL。',
    detail: 'fetch failed: getaddrinfo ENOTFOUND api.example.com:443',
  })
  await sleep(250)
  A.rawClosed = await snapAssistant()
  {
    const last = A.rawClosed.alertRaw[A.rawClosed.alertRaw.length - 1]
    if (!last || last.open) errors.push(`原文默认不该展开：${JSON.stringify(A.rawClosed.alertRaw)}`)
    if (A.rawClosed.alertHeads.some((x) => /ENOTFOUND/.test(x))) {
      errors.push(`原文混进了错误标题：${JSON.stringify(A.rawClosed.alertHeads)}`)
    }
  }
  await win.webContents.executeJavaScript(
    `(() => { const a = document.querySelectorAll('.a-alert-raw'); a[a.length - 1]?.querySelector('summary')?.click() })()`,
  )
  await sleep(250)
  A.rawOpen = await snapAssistant()
  {
    const last = A.rawOpen.alertRaw[A.rawOpen.alertRaw.length - 1]
    if (!last?.open || !String(last.code).includes('ENOTFOUND')) {
      errors.push(`点开「查看原始信息」没拿到原文：${JSON.stringify(A.rawOpen.alertRaw)}`)
    }
  }
  await cdpShot('smoke-assistant-alert.png')

  // ---------- 编码工作台 ----------
  step('编码工作台')
  // 这一段验的是三件只有渲染层才知道对错的事：
  // 1) 入口在主导航里 —— 这一屏要同时摆出会话、正文与改动，装不进一枚抽屉；
  // 2) 注册表与档位照协商结果画 —— 四家的启动方式、坑、档位含义互不相同，
  //    界面不能替它们统一口径；
  // 3) 事件折成行、diff 留在那一步上、审查面板画得出来 —— 「改了什么」只有这一份证据。
  const pushAcp = async (event) => {
    win.webContents.send('acp:event', { agentId: 'claude', event })
    await sleep(140)
  }
  const snapAcp = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const n = (s) => document.querySelectorAll(s).length;
        const txt = (el) => el ? el.textContent.replace(/\\s+/g,' ').trim() : null;
        const all = (s) => [...document.querySelectorAll(s)];
        const say = all('.agx-say');
        const btn = document.querySelector('.agx-sel-btn');
        const pop = document.querySelector('.agx-sel-pop');
        const r = (el) => el ? el.getBoundingClientRect() : null;
        return {
          page: n('.agx'),
          acpToggle: n('.acp-toggle'),
          assistantDrawer: n('.assistant-drawer'),
          agents: n('.agx-agent'),
          agentNames: all('.agx-agent-text b').map(x => x.textContent.trim()),
          agentStates: all('.agx-agent-text i').map(x => x.textContent.trim()),
          sessions: n('.agx-session'),
          sessionTitles: all('.agx-session-text b').map(x => x.textContent.trim()),
          welcome: n('.agx-welcome'),
          selects: n('.agx-sel'),
          selectNames: all('.agx-sel-btn > span').map(x => x.textContent.trim()),
          userLines: n('.agx-user'),
          sayBlocks: n('.agx-say'),
          lastSay: txt(say[say.length - 1]),
          stepGroups: n('.agx-steps'),
          tools: n('.agx-step:not(.think)'),
          editCards: n('.agx-editcard'),
          review: n('.agx-review'),
          reviewFiles: n('.agx-file'),
          diffRows: n('.agx-diff-row'),
          diffAdds: n('.agx-diff-row.add'),
          diffDels: n('.agx-diff-row.del'),
          perm: n('.agx-perm'),
          permButtons: all('.agx-perm-actions button').map(x => x.textContent.trim()),
          popOpen: !!pop,
          popItems: all('.agx-sel-pop .agx-pop-item b').map(x => x.textContent.trim()),
          popBox: r(pop),
          btnBox: r(btn),
          busy: n('.agx-working'),
        };
      })()
    `)

  const C = {}
  await win.webContents.executeJavaScript(`document.querySelector('.app-nav-item[aria-label="编码"]')?.click()`)
  await sleep(800)
  C.list = await snapAcp()
  if (C.list.page !== 1) errors.push('主导航的「编码」没把工作台打开')
  if (C.list.acpToggle !== 0) errors.push('标题栏里还留着旧的抽屉开关')
  if (C.list.assistantDrawer !== 0) errors.push('切到编码工作台时助手抽屉还开着：换一屏该把它收起来')
  if (C.list.agents !== ACP_AGENTS.length) {
    errors.push(`注册表没照数据画：画出 ${C.list.agents} 家，应为 ${ACP_AGENTS.length} 家`)
  }
  if (JSON.stringify(C.list.agentNames) !== JSON.stringify(ACP_AGENTS.map((a) => a.title))) {
    errors.push(`注册表里的名字不对：${JSON.stringify(C.list.agentNames)}`)
  }
  if (C.list.welcome !== 1) errors.push('还没有会话时没画空场（大字问候 + 四张卡）')
  // 三档状态必须长得不一样：绿是整轮跑通过，黄是接得上但没测全，灰是压根没测。
  // 把「没量」画成「量过了」比不画更坏。
  if (C.list.agentStates[0] !== '已验过') errors.push(`整轮验过的那家没标「已验过」：${C.list.agentStates[0]}`)
  if (C.list.agentStates[1] !== '接得上') errors.push(`只测到握手的那家没标「接得上」：${C.list.agentStates[1]}`)
  if (C.list.agentStates[2] !== '还没验过') errors.push(`没测过的那家没标「还没验过」：${C.list.agentStates[2]}`)
  await cdpShot('smoke-acp-list.png')

  // 注册表编辑器：填一条自定义条目，存盘这一步必须真的走到主进程
  await win.webContents.executeJavaScript(`document.querySelector('.acp-registry-toggle')?.click()`)
  await sleep(250)
  const fieldCount = await win.webContents.executeJavaScript(
    `(() => {
      const set = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const inputs = [...document.querySelectorAll('.acp-registry-form .acp-field input')]
      if (inputs.length < 4) return inputs.length
      set(inputs[0], 'my-agent')
      set(inputs[1], '我的一家')
      set(inputs[2], 'npx')
      set(inputs[3], '-y my-acp@1.0.0')
      return inputs.length
    })()`,
  )
  await sleep(250)
  if (fieldCount < 4) errors.push(`注册表编辑器的字段没画出来：只找到 ${fieldCount} 个输入框`)
  const saveEnabled = await win.webContents.executeJavaScript(
    `!!document.querySelector('.acp-registry-foot button.primary') && !document.querySelector('.acp-registry-foot button.primary').disabled`,
  )
  if (!saveEnabled) errors.push('填完还存不了：存盘按钮没解禁')
  await cdpShot('smoke-acp-registry.png')
  await win.webContents.executeJavaScript(`document.querySelector('.acp-registry-foot button.primary')?.click()`)
  await sleep(400)
  const saved = global.__acpCalls.find((c) => c.fn === 'registry-save')
  if (!saved) errors.push('存自定义条目没走到 acp:registry-save')
  else {
    const e = saved.entry ?? {}
    if (e.id !== 'my-agent') errors.push(`存下来的 id 不对：${JSON.stringify(e)}`)
    if (e.command !== 'npx') errors.push(`存下来的启动命令不对：${JSON.stringify(e)}`)
    if (!Array.isArray(e.args) || e.args.join(' ') !== '-y my-acp@1.0.0') {
      errors.push(`存下来的参数不对：${JSON.stringify(e.args)}`)
    }
  }

  // 选工作目录：它决定 agent 能碰哪些文件，必须在开场前就能定
  await win.webContents.executeJavaScript(`document.querySelector('.agx-dir')?.click()`)
  await sleep(300)
  const dirChip = await win.webContents.executeJavaScript(
    `document.querySelector('.agx-dir')?.textContent.replace(/\\s+/g,' ').trim() ?? null`,
  )
  if (!dirChip || !dirChip.includes('torra')) errors.push(`选了目录之后输入坞上没显示：${dirChip}`)

  // 接上一家：协商出来的两组档位都要变成下拉
  await win.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('.agx-agent')].find(x => x.querySelector('b')?.textContent.trim() === 'Claude Code'); b?.querySelector('.agx-agent-main')?.click(); return true })()`,
  )
  await sleep(700)
  C.attached = await snapAcp()
  if (!global.__acpCalls.some((c) => c.fn === 'start' && c.agentId === 'claude')) {
    errors.push('点「Claude Code」没走到 acp:start')
  }
  if (C.attached.selects !== 2) {
    errors.push(`档位没照协商结果画：画出 ${C.attached.selects} 个下拉，应为 2 个（mode + config）`)
  }
  if (JSON.stringify(C.attached.selectNames) !== JSON.stringify(['Default', 'Sonnet'])) {
    errors.push(`档位的当前值不对：${JSON.stringify(C.attached.selectNames)}`)
  }
  if (C.attached.sessions < 1) errors.push('接上之后左边没有这一场会话')
  await cdpShot('smoke-acp-attached.png')

  // 档位弹层：输入坞贴着底，弹层只能往上开
  await win.webContents.executeJavaScript(`document.querySelector('.agx-sel-btn')?.click()`)
  await sleep(250)
  C.pop = await snapAcp()
  if (!C.pop.popOpen) errors.push('档位下拉点了没展开')
  else {
    const items = C.pop.popItems.map((x) => (x ?? '').trim())
    if (JSON.stringify(items) !== JSON.stringify(['Default', 'Accept Edits', 'Plan'])) {
      errors.push(`档位选项不对：${JSON.stringify(C.pop.popItems)}`)
    }
    const pop = C.pop.popBox
    const btn = C.pop.btnBox
    if (!pop || !btn) errors.push('下拉几何量不到')
    else if (pop.y + pop.h > btn.y + 2) {
      errors.push(`上拉开反了方向：弹层底 ${Math.round(pop.y + pop.h)} 应在按钮顶 ${Math.round(btn.y)} 之上`)
    }
  }
  await cdpShot('smoke-acp-picker.png')
  await win.webContents.executeJavaScript(
    `(() => { const it = [...document.querySelectorAll('.agx-sel-pop .agx-pop-item')].find(x => x.textContent.includes('Accept')); it?.click(); return true })()`,
  )
  await sleep(300)
  const setOpt = global.__acpCalls.find((c) => c.fn === 'set-option')
  if (!setOpt || setOpt.value !== 'acceptEdits') {
    errors.push(`改档位没发对：${JSON.stringify(setOpt)}`)
  }

  // 发一轮：分片的文字要接成一段，工具结果要回到它对应的那一步
  await win.webContents.executeJavaScript(
    `(() => { const ta = document.querySelector('.agx-input textarea'); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set; setter.call(ta, '看一下目录'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
  )
  await sleep(200)
  await win.webContents.executeJavaScript(`document.querySelector('.agx-send')?.click()`)
  await sleep(300)
  if (!global.__acpCalls.some((c) => c.fn === 'prompt' && c.text === '看一下目录')) {
    errors.push('编码工作台那一轮没送出去')
  }
  await pushAcp({ kind: 'thinking', delta: '先看目录里有什么。' })
  await pushAcp({ kind: 'tool-call', id: 't1', title: '列出目录', status: 'pending' })
  await pushAcp({ kind: 'tool-result', id: 't1', status: 'completed', text: 'src / package.json / README.md' })
  await pushAcp({ kind: 'text', delta: '目录里有三个条目，' })
  await pushAcp({ kind: 'text', delta: 'README 在根目录。' })
  await pushAcp({ kind: 'usage', input: 320, output: 88 })
  await pushAcp({ kind: 'settled', stopReason: 'end_turn' })
  C.turn = await snapAcp()
  if (C.turn.userLines !== 1) errors.push(`用户那句没画出来：${C.turn.userLines}`)
  if (C.turn.sayBlocks !== 1) errors.push(`分片的文字被拆成了 ${C.turn.sayBlocks} 段`)
  if (!/目录里有三个条目.*README 在根目录/.test(C.turn.lastSay ?? '')) {
    errors.push(`正文内容不对：${C.turn.lastSay}`)
  }
  if (C.turn.tools !== 1) errors.push(`工具步数不对：${C.turn.tools}`)
  if (C.turn.busy !== 0) errors.push('这一轮结束了还在转圈')
  if (!C.turn.sessionTitles.some((t) => t.includes('看一下目录'))) {
    errors.push(`会话名没跟着第一句改：${JSON.stringify(C.turn.sessionTitles)}`)
  }
  await cdpShot('smoke-acp-turn.png')

  // 改文件：diff 留在那一步上，汇总成一张卡，点「审查」出右边的对照
  await pushAcp({ kind: 'thinking', delta: '把结论写进 README。' })
  await pushAcp({ kind: 'tool-call', id: 't2', title: '写文件 README.md', status: 'in_progress', toolKind: 'edit' })
  await pushAcp({
    kind: 'tool-result',
    id: 't2',
    status: 'completed',
    diffs: [
      {
        path: 'README.md',
        oldText: '# Torra\n\n用法。',
        newText: '# Torra\n\n用法。\n\n## 目录\n\n- src\n- scripts',
      },
    ],
  })
  await pushAcp({ kind: 'settled', stopReason: 'end_turn' })
  C.edit = await snapAcp()
  if (C.edit.editCards !== 1) errors.push(`改过文件之后没出汇总卡：${C.edit.editCards}`)
  await win.webContents.executeJavaScript(`document.querySelector('.agx-editcard-head .agx-btn')?.click()`)
  await sleep(400)
  C.review = await snapAcp()
  if (C.review.review !== 1) errors.push('点「审查」没打开右边的对照面板')
  if (C.review.reviewFiles < 1) errors.push('审查面板里没列出改过的文件')
  if (C.review.diffAdds < 1) errors.push('审查对照里没有新增行')
  if (C.review.diffRows < 3) errors.push(`审查对照画出来的行太少：${C.review.diffRows}`)
  await cdpShot('smoke-acp-review.png')
  // 白天那套也得看得过去：这一屏用了不少淡色（智能体色、增删底纹），只在暗色下看不作数
  {
    const before = await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme || null`,
    )
    if (before !== 'light') {
      await win.webContents.executeJavaScript(`document.querySelector('.theme-toggle')?.click()`)
      await sleep(400)
    }
    const day = await win.webContents.executeJavaScript(`document.documentElement.dataset.theme || null`)
    if (day !== 'light') errors.push(`编码工作台切到白天没换成 light：${day}`)
    await cdpShot('smoke-acp-light.png')
    if (before !== 'light') {
      await win.webContents.executeJavaScript(`document.querySelector('.theme-toggle')?.click()`)
      await sleep(400)
    }
  }
  await win.webContents.executeJavaScript(`document.querySelector('.agx-review-head .agx-icon-btn')?.click()`)
  await sleep(250)

  // 授权卡：这一家反过来要用户点头，选项照它给的列出来
  win.webContents.send('acp:permission', {
    agentId: 'claude',
    request: {
      id: 'p1',
      sessionId: 's1',
      title: '写文件 src/index.ts',
      toolKind: 'edit',
      rawInput: { path: 'src/index.ts', content: '…' },
      options: [
        { optionId: 'allow', name: '允许', kind: 'allow_once' },
        { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
      ],
    },
  })
  await sleep(400)
  C.perm = await snapAcp()
  if (C.perm.perm !== 1) errors.push('授权卡没画出来')
  else {
    const card = await win.webContents.executeJavaScript(
      `(() => { const c = document.querySelector('.agx-perm'); if (!c) return null; return { title: c.querySelector('.agx-perm-head b')?.textContent.trim() ?? null, buttons: [...c.querySelectorAll('.agx-perm-actions button')].map(b => b.textContent.trim()), foot: c.querySelector('.agx-perm-foot')?.textContent.trim() ?? null } })()`,
    )
    if (!card?.title?.includes('写文件')) errors.push(`授权卡标题不对：${card?.title}`)
    if (!card?.buttons.includes('允许') || !card?.buttons.includes('拒绝')) {
      errors.push(`授权卡没照 agent 给的选项列出来：${JSON.stringify(card?.buttons)}`)
    }
    if (!card?.foot?.includes('不替你挑')) errors.push(`授权卡没说明「选项是这一家自己给的」：${card?.foot}`)
  }
  await cdpShot('smoke-acp-permission.png')
  await win.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('.agx-perm-actions button')].find(x => x.textContent.trim() === '允许'); b?.click(); return true })()`,
  )
  await sleep(300)
  {
    const answered = global.__acpCalls.find((c) => c.fn === 'permission')
    if (!answered || answered.optionId !== 'allow') {
      errors.push(`授权回话没送对：${JSON.stringify(answered)}`)
    }
  }

  // 会话留得住：换屏再回来，这一场还在左边，正文还在中间
  {
    const stored = await win.webContents.executeJavaScript(
      `(() => { const raw = localStorage.getItem('torra.agents.sessions.v1'); if (!raw) return null; try { const a = JSON.parse(raw); return { n: a.length, title: a[0]?.title ?? null, lines: a[0]?.lines?.length ?? 0 } } catch { return 'bad' } })()`,
    )
    if (!stored || stored === 'bad' || stored.n < 1) errors.push(`会话没落到本地：${JSON.stringify(stored)}`)
    else if (!stored.title?.includes('看一下目录')) errors.push(`存下来的会话名不对：${JSON.stringify(stored)}`)
    if (stored && stored.lines < 3) errors.push(`存下来的行太少：${JSON.stringify(stored)}`)
  }

  // 送走这一家：子进程与工具包服务都得收掉，会话留在左边（标成已结束）
  await win.webContents.executeJavaScript(
    `document.querySelector('.agx-top button[title="送走这一家"]')?.click()`,
  )
  await sleep(400)
  if (!global.__acpCalls.some((c) => c.fn === 'stop')) errors.push('「送走这一家」没走到 acp:stop')
  C.stopped = await snapAcp()
  if (C.stopped.selects !== 0) errors.push('送走之后档位还留在界面上')
  if (C.stopped.sessions < 1) errors.push('送走之后会话从左边消失了：记录该留下')
  if (C.stopped.review !== 0) errors.push('送走之后审查面板还开着')

  // 旧会话点得开：只能看，不能接着跑 —— 照实说，并给「同一家新开一场」的出口
  await win.webContents.executeJavaScript(`document.querySelector('.agx-session')?.click()`)
  await sleep(400)
  {
    const archived = await win.webContents.executeJavaScript(
      `(() => { const a = document.querySelector('.agx-archived'); return a ? { text: a.textContent.replace(/\\s+/g,' ').trim(), disabled: !!document.querySelector('.agx-input textarea')?.disabled } : null })()`,
    )
    if (!archived) errors.push('点开旧会话没说明「这一场已经结束了」')
    else if (!archived.disabled) errors.push('旧会话的输入框没锁住：协议层面已经没有这一场了')
  }

  // 新的一场：空场回来
  await win.webContents.executeJavaScript(`document.querySelector('.agx-rail-top .agx-icon-btn')?.click()`)
  await sleep(400)
  C.fresh = await snapAcp()
  if (C.fresh.welcome !== 1) errors.push('新开一场之后没回到空场')
  if (C.fresh.userLines !== 0) errors.push('新开一场之后上一轮的对话还留在正文里')

  // 回研讨：助手抽屉不该跟着回来
  await win.webContents.executeJavaScript(`document.querySelector('.app-nav-item[aria-label="研讨"]')?.click()`)
  await sleep(400)

  // ---------- 网页通道附件时序 ----------
  step('网页通道附件')
  // 真 inject + 真 pasteImages 打一个复刻豆包行为的固定装置（scripts/fixtures/web-attach.html）：
  // 站点在输入框被清空时会连带丢掉待发附件，所以「先粘图 → send() 里 clearInput → 键入」
  // 的老顺序必然丢图。这里断言的是用户真正在意的那件事：按下发送时，站点还带着图。
  {
    const { INJECT_SCRIPT } = require('../dist/main/webview/inject')
    const { pasteImages, uploadFiles } = require('../dist/main/agents/webview-agent')
    const fx = new BrowserWindow({ width: 760, height: 620, show: SHOW_WIN })
    await fx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-attach.html'))
    await fx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = {
      id: 'fixture',
      entry: 'file://',
      send_mode: 'click',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 60 },
      selectors: { input: 'textarea[data-testid="chat_input_input"]', send: '#send', stream: '#answers .ans' },
    }
    const png = fs.readFileSync(path.join(ROOT, 'docs', 'smoke-assistant-picker.png')).toString('base64')
    const typed = await fx.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const pasteReport = await pasteImages(fx.webContents, spec, [{ mime: 'image/png', base64: png }], 'fixture', 'smoke-attach')
    const press = await fx.webContents.executeJavaScript(
      `window.__torra.pressSend(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    A.attach = await fx.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { pastes: p.pastes, sent: p.sent, imgs: document.querySelectorAll("#strip img").length } })()',
      true,
    )
    A.attach.dropped = pasteReport.dropped
    if (!typed.ok) errors.push(`固定装置里键入就失败了：${typed.reason}`)
    if (!A.attach.pastes.some((p) => p.trusted && p.files === 1)) {
      errors.push(`粘贴没拿到受信任的 paste 事件（附件通道断了）：${JSON.stringify(A.attach.pastes)}`)
    }
    if (!press.ok) errors.push(`贴完图后发送没被站点接走：${press.reason}`)
    if (!(A.attach.sent && A.attach.sent.files === 1 && A.attach.sent.text === '这是什么')) {
      errors.push(`按下发送时站点没带上图：${JSON.stringify(A.attach.sent)}`)
    }
    // 反向断言：图真的到了，就不能给用户挂「附件未送达」。
    // 误报比漏报更糟 —— 用户会开始无视所有警示。
    if (pasteReport.dropped.length > 0) {
      errors.push(`附件已送达却报了丢失：${JSON.stringify(pasteReport.dropped)}`)
    }
    // 正向断言：单轮最多粘 4 张，第 5 张起根本没尝试，必须报出来，
    // 否则用户以为 6 张都发出去了，得到的却是一个只看前 4 张的回答。
    await fx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-attach.html'))
    await fx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const many = await pasteImages(
      fx.webContents,
      spec,
      Array.from({ length: 6 }, () => ({ mime: 'image/png', base64: png })),
      'fixture',
      'smoke-attach-cap',
    )
    A.attach.cap = { placed: many.placed, dropped: many.dropped }
    if (many.dropped.length === 0) errors.push(`超出单轮上限的附件没报丢失：${JSON.stringify(many)}`)
    if (many.placed !== 4) errors.push(`上限内应粘上 4 张，实际 ${many.placed} 张`)
    fx.destroy()
  }

  // ---------- 网页模型附件：走网页本身的上传 ----------
  step('网页模型附件')
  // 有一大类站点压根不监听 paste，附件只能从「+ / 📎」点开的 input[type=file]
  // 进来 —— 剪贴板通道在这类页面上必然送不到图，这就是「上传附件失败」的根因。
  // 固定装置（scripts/fixtures/web-attach-fileinput.html）刻意只认 file input 的
  // change，且 input 要点「+」之后才挂进 DOM，于是断言「网页自身上传通道能通」
  // 就等于断言了用户看到的「图发出去了」。
  {
    const { INJECT_SCRIPT } = require('../dist/main/webview/inject')
    const { pasteImages, uploadFiles } = require('../dist/main/agents/webview-agent')
    const fx = new BrowserWindow({ width: 760, height: 620, show: SHOW_WIN })
    await fx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-attach-fileinput.html'))
    await fx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const spec = {
      id: 'fileinput-fixture',
      entry: 'file://',
      send_mode: 'click',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 60 },
      selectors: { input: 'textarea[data-testid="chat_input_input"]', send: '#send', stream: '#answers .ans' },
    }
    const png = fs.readFileSync(path.join(ROOT, 'docs', 'smoke-assistant-picker.png')).toString('base64')
    const typed = await fx.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    const uploadReport = await pasteImages(fx.webContents, spec, [{ mime: 'image/png', base64: png }], 'fileinput-fixture', 'smoke-attach-fileinput')
    // 预览必须在发送前数：站点一收到这一轮就会清掉待发附件，发完再数必然是 0
    const uploadBefore = await fx.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { pastes: p.pastes, changes: p.changes, menuOpened: p.menuOpened, imgs: document.querySelectorAll("#strip img").length } })()',
      true,
    )
    const press = await fx.webContents.executeJavaScript(
      `window.__torra.pressSend(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    A.attachFileInput = await fx.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { pastes: p.pastes, changes: p.changes, menuOpened: p.menuOpened, sent: p.sent, imgs: document.querySelectorAll("#strip img").length } })()',
      true,
    )
    A.attachFileInput.report = uploadReport
    if (!typed.ok) errors.push(`fileinput 固定装置里键入就失败了：${typed.reason}`)
    // 核心断言：站点自己认的 change 被触发了，且发送时它带着图
    if (uploadBefore.changes < 1 || uploadBefore.imgs < 1) {
      errors.push(`网页自身上传通道没把附件交给站点：${JSON.stringify(uploadBefore)}`)
    }
    if (uploadBefore.menuOpened < 1) {
      errors.push(`没点开站点的上传菜单（+），file input 是懒挂的：${JSON.stringify(uploadBefore)}`)
    }
    if (uploadReport.placed !== 1) {
      errors.push(`fileinput 通道报告 placed=${uploadReport.placed}，应为 1：${JSON.stringify(uploadReport)}`)
    }
    if (!press.ok) errors.push(`走上传通道后发送没被站点接走：${press.reason}`)
    if (!(A.attachFileInput.sent && A.attachFileInput.sent.files === 1 && A.attachFileInput.sent.text === '这是什么')) {
      errors.push(`走上传通道按下发送时站点没带上图：${JSON.stringify(A.attachFileInput.sent)}`)
    }
    // 这条通道通了就不该给用户挂「附件未送达」
    if (uploadReport.dropped.length > 0) {
      errors.push(`附件已送达却报了丢失：${JSON.stringify(uploadReport.dropped)}`)
    }

    /*
     * 上传入口离输入框很远（DeepSeek 网页版的真实布局）：「+」在页面右上角，
     * 输入框在自己的组件里，且 file input 是点「+」之后才异步挂上来的。
     * 只在 input.parentElement 里找、或点完同步重扫一次，两种都会落进
     * no-file-input —— 那就是「站点明明支持上传，我们就是送不进去」。
     */
    await fx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-attach-distant-plus.html'))
    await fx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const farSpec = {
      id: 'distant-plus-fixture',
      entry: 'file://',
      send_mode: 'enter',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 40 },
      selectors: { input: 'textarea[name="user query"]', stream: '#strip .chip' },
    }
    await fx.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(farSpec)}, '这是什么')`,
      true,
    )
    const farReport = await uploadFiles(
      fx.webContents,
      farSpec,
      [{ name: 'bookmarks_2026_9_10.html', mime: 'text/html', base64: Buffer.from('<html>x</html>', 'utf8').toString('base64') }],
      'distant-plus-fixture',
      'smoke-attach-distant',
    )
    const farProbe = await fx.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { changes: p.changes, menuOpened: p.menuOpened, names: p.names } })()',
      true,
    )
    A.attachDistantPlus = { probe: farProbe, report: farReport }
    if (farReport.placed !== 1) errors.push(`远处「+」按钮没被点到，附件送不进去：${JSON.stringify(farReport)}`)
    if (farProbe.menuOpened < 1 || farProbe.changes < 1) {
      errors.push(`远处的上传菜单/文件没落地：${JSON.stringify(farProbe)}`)
    }

    /*
     * 页面上有多个 file input（阿里系站点的常见布局，元宝就是这种）：
     * 图片走 accept="image/*" 的控件，文档走另一个，两个都在 DOM 里。
     * 点错按钮 → html 进只收图的控件 → 站点 accept 拒绝，
     * 而 change **确实触发了**，从外面看「有反应」，附件却凭空消失，
     * 我们还会照样报 placed=1。这组断言同时卡住「点对按钮」与「不误报成功」。
     */
    await fx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-attach-two-inputs.html'))
    await fx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const twoSpec = {
      id: 'two-inputs-fixture',
      entry: 'file://',
      send_mode: 'enter',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 40 },
      selectors: { input: '.ql-editor', stream: '#strip .chip' },
    }
    await fx.webContents.executeJavaScript(`window.__torra.typePrompt(${JSON.stringify(twoSpec)}, '这是什么')`, true)
    const twoReport = await uploadFiles(
      fx.webContents,
      twoSpec,
      [{ name: 'bookmarks_2026_9_10.html', mime: 'text/html', base64: Buffer.from('<html>x</html>', 'utf8').toString('base64') }],
      'two-inputs-fixture',
      'smoke-attach-two-inputs',
    )
    const twoProbe = await fx.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { changes: p.changes, menuOpened: p.menuOpened, imgMenuOpened: p.imgMenuOpened, accepted: p.accepted, rejected: p.rejected }; })()',
      true,
    )
    A.attachTwoInputs = { probe: twoProbe, report: twoReport }
    if (twoReport.placed !== 1) errors.push(`多 file input 形态没送达：${JSON.stringify(twoReport)}`)
    if (!twoProbe.accepted.some((a) => a.kind === 'doc' && a.name === 'bookmarks_2026_9_10.html')) {
      errors.push(`站点没把 html 收进文档控件（点错按钮了）：${JSON.stringify(twoProbe)}`)
    }
    if (twoProbe.rejected.length > 0) {
      errors.push(`站点按 accept 拒绝了附件（说明送错了控件）：${JSON.stringify(twoProbe.rejected)}`)
    }

    /*
     * 二级菜单形态（元宝）：「+」只展开菜单（上传图片 / 本地文件），
     * file input 只在点「本地文件」之后才创建。只点一级按钮等 1.2 秒
     * 永远等不到 —— 那就是用户看到的 no-file-input。断言两层都点到位，
     * 且文件落到「本地文件」那个控件而不是只收图的「上传图片」。
     */
    await fx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-attach-second-level.html'))
    await fx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const lv2Spec = {
      id: 'second-level-fixture',
      entry: 'file://',
      send_mode: 'enter',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 40 },
      selectors: { input: '.ql-editor', stream: '#strip .chip' },
    }
    await fx.webContents.executeJavaScript(`window.__torra.typePrompt(${JSON.stringify(lv2Spec)}, '这是什么')`, true)
    const lv2Report = await uploadFiles(
      fx.webContents,
      lv2Spec,
      [{ name: 'bookmarks_2026_9_10.html', mime: 'text/html', base64: Buffer.from('<html>y</html>', 'utf8').toString('base64') }],
      'second-level-fixture',
      'smoke-attach-second-level',
    )
    const lv2Probe = await fx.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { changes: p.changes, menuOpened: p.menuOpened, docMenuOpened: p.docMenuOpened, accepted: p.accepted, rejected: p.rejected } })()',
      true,
    )
    A.attachSecondLevel = { probe: lv2Probe, report: lv2Report }
    if (lv2Report.placed !== 1) errors.push(`二级菜单形态没送达：${JSON.stringify(lv2Report)}`)
    if (lv2Probe.menuOpened < 1 || lv2Probe.docMenuOpened < 1) {
      errors.push(`二级菜单没点到「本地文件」：${JSON.stringify(lv2Probe)}`)
    }
    if (!lv2Probe.accepted.some((a) => a.kind === 'doc')) {
      errors.push(`二级菜单：站点没把文件收进文档控件：${JSON.stringify(lv2Probe)}`)
    }
    if (lv2Probe.rejected.length > 0) {
      errors.push(`二级菜单：送错控件被拒收：${JSON.stringify(lv2Probe.rejected)}`)
    }

    /*
     * 元宝真实形态：上传入口是**无 aria-label/title 的纯 SVG 图标按钮**。
     * 语义命中（aria-label/title/class）与 isPlus（innerText 为 +）全都接不住，
     * 会报 no-upload-entry。真人靠位置找它：与输入框同一行、在其左侧。
     * 图标兜底就是这条几何判据 —— 断言它能点开入口并走完二级菜单。
     */
    await fx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-attach-icon-plus.html'))
    await fx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const iconSpec = {
      id: 'icon-plus-fixture',
      entry: 'file://',
      send_mode: 'enter',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 40 },
      selectors: { input: '.editor', stream: '#strip .chip' },
    }
    await fx.webContents.executeJavaScript(`window.__torra.typePrompt(${JSON.stringify(iconSpec)}, '这是什么')`, true)
    const iconReport = await uploadFiles(
      fx.webContents,
      iconSpec,
      [{ name: 'bookmarks_2026_9_10.html', mime: 'text/html', base64: Buffer.from('<html>z</html>', 'utf8').toString('base64') }],
      'icon-plus-fixture',
      'smoke-attach-icon-plus',
    )
    const iconProbe = await fx.webContents.executeJavaScript(
      '(() => { const p = window.__probe; return { changes: p.changes, menuOpened: p.menuOpened, docMenuOpened: p.docMenuOpened, accepted: p.accepted, rejected: p.rejected } })()',
      true,
    )
    A.attachIconPlus = { probe: iconProbe, report: iconReport }
    if (iconReport.placed !== 1) errors.push(`图标按钮形态没送达：${JSON.stringify(iconReport)}`)
    if (iconProbe.menuOpened < 1 || iconProbe.docMenuOpened < 1) {
      errors.push(`无标签的图标上传按钮/二级菜单没点到：${JSON.stringify(iconProbe)}`)
    }
    if (!iconProbe.accepted.some((a) => a.kind === 'doc')) {
      errors.push(`图标按钮：站点没把文件收进文档控件：${JSON.stringify(iconProbe)}`)
    }
    if (iconProbe.rejected.length > 0) {
      errors.push(`图标按钮：送错控件被拒收：${JSON.stringify(iconProbe.rejected)}`)
    }

    // 非图片附件（html/代码）走同一条通道，且正文**不进 prompt** ——
    // 「上传几百 KB 的 html，模型说后面全是空行」就是内联被输入框截断造成的。
    await fx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-attach-fileinput.html'))
    await fx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const fileBody = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n' + 'x'.repeat(5000)
    await fx.webContents.executeJavaScript(`window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`, true)
    const fileReport = await uploadFiles(
      fx.webContents,
      spec,
      [{ name: 'bookmarks_2026_9_10.html', mime: 'text/html', base64: Buffer.from(fileBody, 'utf8').toString('base64') }],
      'fileinput-fixture',
      'smoke-attach-fileinput-text',
    )
    const fileProbe = await fx.webContents.executeJavaScript(
      '(() => { const p = window.__probe; const f = p.files[0]; return { changes: p.changes, names: p.names, type: f ? f.type : "" } })()',
      true,
    )
    const fileTextLen = await fx.webContents.executeJavaScript('window.__probe.files[0].text().then(t => t.length)', true)
    A.attachFileText = { probe: fileProbe, report: fileReport, textLen: fileTextLen }
    if (fileReport.placed !== 1) errors.push(`文本附件 placed 应为 1，实际 ${fileReport.placed}`)
    if (fileProbe.changes < 1) errors.push(`文本附件没触发站点的 change：${JSON.stringify(fileProbe)}`)
    // 扩展名必须原样带过去：站点按 MIME/后缀分流，丢了 .html 就可能被当图片
    if (!fileProbe.names.includes('bookmarks_2026_9_10.html')) {
      errors.push(`站点收到的文件名不对：${JSON.stringify(fileProbe.names)}`)
    }
    if (fileTextLen !== fileBody.length) {
      errors.push(`站点拿到的文件正文长度 ${fileTextLen} != 原文 ${fileBody.length}（附件被截断了）`)
    }
    fx.destroy()
  }

  // ---------- 带附件轮次的结果提取 ----------
  step('附件轮次结果提取')
  // DeepSeek-网页实测：卡片报「generation did not start」，docked 视图里模型早就答完了。
  // 固定装置（scripts/fixtures/web-attach-vision.html）复刻图片轮次的三件事：
  // 回合容器同时命中用户那句、用户那句带着 blob 图 + 文件名（不等于提示词）、
  // 输入框先清空而回复容器过 1.5s 才长出来。对应三条断言：
  //   ① 站点收下这一轮必须有收据（框里的话没了），不能只等容器变长；
  //   ② 模型还没开口时读到的必须是空 —— 绝不能是我自己那句带图的提问；
  //   ③ 答案一落地就必须读得到；
  //   ④ 「已接收」这条收据本身要成立：容器始终不长时也不能判成适配器失效。
  {
    const { INJECT_SCRIPT } = require('../dist/main/webview/inject')
    const spec = {
      id: 'vision-fixture',
      entry: 'file://',
      send_mode: 'enter',
      automation: { typing_delay_ms: [1, 2], jitter: false, pre_send_pause_ms: 40 },
      completion: { mode: 'dom_stable', stable_ms: 400 },
      selectors: { input: '#ta', stream: '#thread .msg' },
    }
    const readJs = (r) =>
      `window.__torra.read('#thread .msg', 'last', ${r.streamCount}, ${JSON.stringify(r.streamBaselineText ?? '')}, '这是什么')`
    const vfx = new BrowserWindow({ width: 760, height: 620, show: SHOW_WIN })
    await vfx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-attach-vision.html'), { search: 'mode=slow-answer' })
    await vfx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const vTyped = await vfx.webContents.executeJavaScript(
      `window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`,
      true,
    )
    // attachments=1：贴了图的轮次判死窗口要跟着放宽
    const vPress = await vfx.webContents.executeJavaScript(
      `window.__torra.pressSend(${JSON.stringify(spec)}, '这是什么', 1)`,
      true,
    )
    const vEarly = await vfx.webContents.executeJavaScript(readJs(vPress), true)
    let vLate = ''
    for (let i = 0; i < 20 && !vLate; i++) {
      await sleep(300)
      vLate = await vfx.webContents.executeJavaScript(readJs(vPress), true)
    }
    A.vision = {
      ok: vPress.ok,
      streamCount: vPress.streamCount,
      early: vEarly,
      late: vLate,
    }
    if (!vTyped.ok) errors.push(`视觉固定装置里键入就失败了：${vTyped.reason}`)
    if (!vPress.ok) errors.push(`带附件的一轮被判成「生成未开始」：${vPress.reason}`)
    if (vEarly) errors.push(`把用户带图的提问当成本轮回复读了：${JSON.stringify(vEarly)}`)
    if (!String(vLate).includes('OBS')) {
      errors.push(`带附件的轮次拿不到模型回复（读到 ${JSON.stringify(vLate)}）—— 提取 schema 仍漏`)
    }

    // 收据分支：站点收下但回复容器一直不长（上传/服务端理解期间就是空的），
    // 必须认「输入框已清空」为开始，而不是等 30s 到点报 generation did not start。
    await vfx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-attach-vision.html'), { search: 'mode=no-answer' })
    await vfx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    await vfx.webContents.executeJavaScript(`window.__torra.typePrompt(${JSON.stringify(spec)}, '这是什么')`, true)
    const vPress2 = await vfx.webContents.executeJavaScript(
      `window.__torra.pressSend(${JSON.stringify(spec)}, '这是什么', 1)`,
      true,
    )
    A.vision.accepted = { ok: vPress2.ok, accepted: !!vPress2.accepted, reason: vPress2.reason }
    if (!(vPress2.ok && vPress2.accepted)) {
      errors.push(`站点已收下（输入框已清空）却没走收据：${JSON.stringify(vPress2)}`)
    }
    vfx.destroy()
  }

  // ---------- 后台实例的抓取能力（必须出帧，否则站点的答案根本不进 DOM） ----------
  step('后台实例抓取')
  // 早期结论是「隐藏宿主一帧都不出，抓取只能读定时器长出来的 DOM」，实测并不成立：
  // DeepSeek 的消息列表是虚拟化 + IntersectionObserver 挂载的，回调都排在渲染帧上 ——
  // 宿主窗口创建时 show:false 就永远不出帧（rAF 计数恒 0、visibilityState 恒 hidden，
  // 事后再 show()/showInactive() 也翻不回来），于是整页消息（连历史轮次）都不进 DOM，
  // 抓取只能读到空串，表现为「生成结束但未捕获到内容」。
  // 正解见 webview/pool.ts 的 ensureHost：宿主创建时即显示，只是摆在 -32000 屏幕外。
  // 这条断言盯的就是这个前提：后台实例既要有帧（rAF/IO 能跑），又要读得到帧驱动的新节点。
  {
    const { INJECT_SCRIPT } = require('../dist/main/webview/inject')
    const { WebContentsView } = require('electron')
    // 两种追加节奏同时测：定时器（旧前提）+ 渲染帧回调（DeepSeek 那类站点的真实节奏）。
    // data: URL 里的文本必须纯 ASCII —— 不做 URL 编码时中文会按错误字符集解析成乱码。
    const page =
      'data:text/html,<body><div id="thread"><div class="msg">OLD_ANSWER</div></div><script>' +
      'window.r=0;window.f=0;(function loop(){requestAnimationFrame(function(){window.r++;' +
      'if(!window.f&&window.r>=3){window.f=1;var e=document.createElement("div");e.className="msg";' +
      'e.textContent="ANSWER_FROM_FRAME";document.getElementById("thread").appendChild(e)}loop()})})();' +
      'setTimeout(function(){var d=document.createElement("div");d.className="msg";' +
      'd.textContent="ANSWER_FROM_BACKGROUND";document.getElementById("thread").appendChild(d)},600);</script></body>'
    const host = new BrowserWindow({
      width: 1280,
      height: 900,
      x: -32000,
      y: -32000,
      show: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      frame: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    const view = new WebContentsView({
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    host.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 1280, height: 900 })
    view.webContents.setBackgroundThrottling(false)
    await view.webContents.loadURL(page)
    await view.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const base = await view.webContents.executeJavaScript(`window.__torra.count('#thread .msg')`, true)
    await sleep(1500)
    const parkedRead = await view.webContents.executeJavaScript(
      `window.__torra.read('#thread .msg', 'last', ${base}, 'OLD_ANSWER', '')`,
      true,
    )
    // 'last' 只回最后一条有字的节点，证明不了帧驱动的那条也落地了 ——
    // 用 'all' 把本轮新增节点全部拼出来，才盯得住「有帧才会长出来的内容」。
    const parkedAll = await view.webContents.executeJavaScript(
      `window.__torra.read('#thread .msg', 'all', ${base}, 'OLD_ANSWER', '')`,
      true,
    )
    A.parked_frames = {
      raf: await view.webContents.executeJavaScript('window.r', true),
      vis: await view.webContents.executeJavaScript('document.visibilityState', true),
      read: parkedRead,
      all: parkedAll,
    }
    if (A.parked_frames.vis !== 'visible' || !(A.parked_frames.raf > 0)) {
      errors.push(`后台宿主没有出帧（visibility=${A.parked_frames.vis} rAF=${A.parked_frames.raf}）—— 虚拟化站点的答案不会进 DOM，网页通道会全线读空`)
    }
    if (!String(parkedRead).includes('ANSWER_FROM_BACKGROUND')) {
      errors.push(`后台实例（visibility=${A.parked_frames.vis}）读不到定时器追加的回复节点：${JSON.stringify(parkedRead)}`)
    }
    if (!String(parkedAll).includes('ANSWER_FROM_FRAME')) {
      errors.push(`后台实例读不到渲染帧里追加的回复节点（rAF=${A.parked_frames.raf}）：${JSON.stringify(parkedAll)}`)
    }
    host.destroy()
  }

  // ---------- HTML → Markdown 抓取 ----------
  step('HTML→Markdown')
  // innerText 会把富文本 DOM 压成一坨：标题/加粗/列表/代码块/表格全丢，
  // 渲染端再强的 Markdown 也无从谈起。固定装置（scripts/fixtures/web-md.html）
  // 复刻一条真实富文本回答，断言 mdOf 还原出 Markdown 结构，
  // 并把交互噪声（复制按钮、sr-only「模型说：」、折叠内容）挡在正文之外。
  {
    const { INJECT_SCRIPT } = require('../dist/main/webview/inject')
    const mdx = new BrowserWindow({ width: 900, height: 800, show: SHOW_WIN, webPreferences: { sandbox: true } })
    await mdx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-md.html'))
    await mdx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const md = String(await mdx.webContents.executeJavaScript(`window.__torra.read('.answer','last',0,'','')`, true))
    A.md = md
    const need = [
      ['## 方案总览', 'h2'],
      ['**双向指针**', '加粗'],
      ['`LRU`', '行内码'],
      ['1. 分配槽位', '有序列表'],
      ['- 哈希表', '无序列表'],
      ['```python', '代码围栏+语言'],
      ['move_to_front(node)', '代码正文'],
      ['> ', '引用块'],
      ['| --- | --- |', '表格分隔行'],
      ['O(1) \\| 带竖线', '表格内竖线转义'],
    ]
    for (const [frag, label] of need) {
      if (!md.includes(frag)) errors.push(`Markdown 抓取丢失「${label}」：缺 ${JSON.stringify(frag)}`)
    }
    for (const [frag, label] of [
      ['复制', '复制按钮'],
      ['模型说', 'sr-only 标签'],
      ['这段折叠内容', '折叠内容'],
      ['相关视频', '站点自标的推荐视频卡片（data-hidecopy）'],
      ['AI课代表小明', '视频卡作者'],
      ['这段是卡片噪声', '正文里夹着的 data-hidecopy 卡片'],
      ['另一张噪声卡片', '同容器带正文时的 data-hidecopy 卡片'],
    ]) {
      if (md.includes(frag)) errors.push(`Markdown 抓取混入噪声「${label}」`)
    }

    // 元宝（web-custom）的实错形状：站点自己画项目符号（<span class="*_dot">•</span>），
    // 条目正文是块级 div。旧抓取会输出「- •」再跟一个空行 —— 于是发言卡片里
    // 出现好几行孤零零的圆点、正文整段掉到列表外面（用户报的「· 单独一行」）。
    for (const [frag, label] of [
      ['- 身份：由腾讯开发的助手。', '站点圆点不混进正文'],
      ['- 能干啥：回答问题。\n\n  这一段和上一段同属一个条目。', '条目内续行留在列表里'],
      ['1. **设定一个模糊的边界概念**', '站点自绘的编号不重复（同一个 dot 元素装的是「1.」）'],
      ['2. 2024 年的数据也支持这一点。', '正文开头的数字没被当成编号吃掉'],
      ['  - 条目里再套一层无序列表', '有序列表里嵌套的无序列表'],
      ['1. 第一条\n2. 跳号之后的第三条', '空条目占位时按站点位置剥编号、输出端重新连号'],
      ['这段的正文足够长，不该因为旁边挂了张卡片就被整块丢掉。', '摘掉 hidecopy 卡片不能牵连同一个容器的正文'],
      ['这一段的正文要留下，后面的正文也要留下。', '行内 hidecopy 卡片只丢卡片'],
    ]) {
      if (!md.includes(frag)) errors.push(`Markdown 列表还原不足「${label}」：缺 ${JSON.stringify(frag)}`)
    }
    if (/^\s*-\s*[•·‣◦∙‧●○■]\s*$/m.test(md)) {
      errors.push(`Markdown 里还有孤零零的圆点条目：${JSON.stringify(md.match(/^.*[•·‣◦].*$/gm))}`)
    }
    if (/^\s*-\s*$/m.test(md)) errors.push('Markdown 里有空的列表条目（渲染端就是一行孤零零的圆点）')
    if (/^\s*\+\d{1,3}\s*$/m.test(md)) {
      errors.push(`Markdown 里残留引用计数控件：${JSON.stringify(md.match(/^\s*\+\d{1,3}\s*$/gm))}`)
    }
    if (/^\s*\d+\.\s+\d+\.\s/m.test(md)) {
      errors.push(`Markdown 里编号重复了：${JSON.stringify(md.match(/^.*\d+\.\s+\d+\..*$/m))}`)
    }
    mdx.destroy()
  }

  // ---------- 站点风控「环境异常」拦截页的识别 ----------
  step('风控拦截页识别')
  // DeepSeek 会对自动化环境弹整屏「使用环境异常……建议使用官方产品」，连输入框都不渲染。
  // 此时必须判成 risk-blocked（交还用户人工处理），而不是 selector missing / adapter-broken ——
  // 后者会把根本没坏的适配器标红，诱导用户去「更新」它。固定装置 scripts/fixtures/web-risk.html。
  {
    const { INJECT_SCRIPT } = require('../dist/main/webview/inject')
    const rx = new BrowserWindow({ width: 900, height: 800, show: SHOW_WIN, webPreferences: { sandbox: true } })
    await rx.loadFile(path.join(ROOT, 'scripts', 'fixtures', 'web-risk.html'))
    await rx.webContents.executeJavaScript(INJECT_SCRIPT, true)
    const HP = 'textarea[name="user query"],textarea[placeholder^="给 DeepSeek 发送消息"]'
    const probe = await rx.webContents.executeJavaScript(`window.__torra.probe(${JSON.stringify(HP)})`, true)
    const obs = await rx.webContents.executeJavaScript(`window.__torra.observe({selectors:{input:${JSON.stringify(HP)}}})`, true)
    A.risk = { probe, riskWall: obs && obs.riskWall }
    if (!probe || probe.reason !== 'risk-blocked') {
      errors.push(`风控拦截页没被判成 risk-blocked（会被误报成适配器失效）：${JSON.stringify(probe)}`)
    }
    if (!obs || obs.riskWall !== true) errors.push(`observe 没标记 riskWall：${JSON.stringify(obs)}`)
    rx.destroy()
  }

  Object.assign(report, { probe_assistant: A })
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8')

  process.stdout.write('SMOKE_REPORT_WRITTEN\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  finish(0)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 等一个条件成立，而不是死等一个固定时长。
 *
 * 固定 sleep 看着稳，其实把「机器这会儿有多慢」写进了判据：机器一慢，
 * 明明行为对的也判成错，于是这类失败会被当成功能坏了去查，查半天是查不出来的。
 * 轮询到条件成立为止，同时留一个上限 —— 条件真不成立时照样判失败。
 *
 * 放在模块级是因为好几处要用（跟随条、结论条、ACP 面板各自等自己的异步），
 * 之前它被定义在某一段块的内部，另一段用到它时就成了 ReferenceError。
 */
async function waitFor(fn, timeoutMs = 5000, stepMs = 120) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(stepMs)
  }
}
