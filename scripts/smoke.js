/**
 * 运行时冒烟测试
 *
 * 目的：验证构建产物在真实 Electron 运行时中能正确渲染三区布局，
 * 且无渲染层控制台错误。同时输出一张截图供视觉核查。
 *
 * 做法：注册与主进程一致的 IPC handler，让 preload 的真实 torra API 可用，
 * 不做任何 stub 注入（stub 会被 reload 清掉且掩盖真实问题）。
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'screenshot-m1.png')
const REPORT = path.join(ROOT, 'docs', 'smoke-report.json')
/** 冒烟环境用 CLI 指定冷启动主题，代替真实主进程从 preferences.json 解析 */
const BOOT_THEME = process.argv.includes('--theme=light') ? 'light' : 'dark'

app.disableHardwareAcceleration()

const MODELS = [
  { id: 'chatgpt', displayName: 'ChatGPT', transport: 'webview', color: '#5aa9e6', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'claude', displayName: 'Claude', transport: 'webview', color: '#d97757', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'gemini', displayName: 'Gemini', transport: 'webview', color: '#3fb950', enabled: true, supportsStructuredOutput: true, adapterHealth: 'unknown', adapterStale: false, hasKey: true, status: 'expired' },
  { id: 'deepseek', displayName: 'DeepSeek', transport: 'api', color: '#4d6bfe', enabled: true, supportsStructuredOutput: true, adapterHealth: 'unknown', adapterStale: false, hasKey: false, status: 'disabled' },
  { id: 'moderator', displayName: '主持 · DeepSeek', transport: 'api', color: '#9a8cff', enabled: true, supportsStructuredOutput: true, adapterHealth: 'unknown', adapterStale: false, hasKey: false, status: 'disabled' },
]

const errors = []
global.__ivCalls = []
global.__retryCalls = []

function registerStubs() {
  ipcMain.handle('risk:acknowledge', () => ({ ok: true }))
  ipcMain.handle('models:list', () => MODELS)
  // 渲染层在存在不可用模型时会轮询该通道；冒烟环境不连真实站点，直接返回。
  ipcMain.handle('models:probe', () => ({ ok: true }))
  ipcMain.handle('adapters:list', () => [])
  ipcMain.handle('adapters:check', () => ({ ok: true, health: 'ok' }))
  ipcMain.handle('login:open', () => ({ ok: true }))
  ipcMain.handle('webview:present', () => ({ ok: false }))
  ipcMain.handle('webview:dismiss', () => ({ ok: true }))
  ipcMain.handle('webview:memory', () => ({ estimatedMb: 750, count: 3 }))
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
      hasReport: true, retryModeTag: 'continue', statusNote: '正常达成共识',
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
  ipcMain.handle('secrets:set', () => ({ ok: true, encrypted: true }))
  ipcMain.handle('secrets:has', () => ({ has: false }))
  // 主题与偏好在启动即被读取；不注册的话渲染层拿到的是「没有 handler」
  ipcMain.handle('theme:get', () => ({ mode: BOOT_THEME, resolved: BOOT_THEME }))
  ipcMain.handle('theme:set', (_e, mode) => ({ ok: true, mode, resolved: mode }))
  ipcMain.handle('preferences:load', () => ({}))
  ipcMain.handle('preferences:save', () => ({ ok: true }))
}

app.whenReady().then(async () => {
  registerStubs()

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: BOOT_THEME === 'dark' ? '#0f1115' : '#faf9f7',
    webPreferences: {
      preload: path.join(ROOT, 'dist', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: [`--torra-theme=${BOOT_THEME}`],
    },
  })

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      errors.push(String(message))
      // 只在末尾汇总的话，脚本中途一reject 就什么都不剩，问题查不出来
      console.log(`[renderer ${level}] ${message} @ ${sourceId}:${line}`)
    }
  })

  await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'))
  await sleep(2000)

  // 主题：冷启动值来自 preload 的 boot arg；两套配色必须真的画出不同的明暗，
  // 只在 CSS 里换 token 而没人验证渲染结果，等于没验证。
  const probeTheme = await win.webContents.executeJavaScript(`
    (() => {
      try {
      const boot = document.documentElement.dataset.theme || null;
      const lum = (s) => {
        const m = /rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/.exec(String(s) || '')
        if (!m) return null
        const [r, g, b] = [1, 2, 3].map((i) => Number(m[i]))
        return Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b))
      }
      const pick = (sel, prop) => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el)[prop] : null
      }
      const sample = () => ({
        ground: lum(pick('body', 'backgroundImage')),
        text: lum(pick('.titlebar-brand strong', 'color')),
        navBg: lum(pick('.app-nav', 'backgroundColor')),
        cardBg: lum(pick('.empty-card', 'backgroundColor')),
        navActiveColor: lum(pick('.app-nav-item.active', 'color')),
      })
      document.documentElement.dataset.theme = 'dark'
      const dark = sample()
      document.documentElement.dataset.theme = 'light'
      const light = sample()
      document.documentElement.dataset.theme = boot || 'dark'
      return { boot, dark, light }
      } catch (e) { return { error: String((e && e.stack) || e) } }
    })()
  `)
  const themeFails = []
  if (probeTheme.boot !== BOOT_THEME) {
    themeFails.push(`preload 没把冷启动主题写进 data-theme：期望 ${BOOT_THEME}，实际 ${probeTheme.boot}`)
  }
  const expectDarker = (a, b, what) => {
    if (a == null || b == null) return themeFails.push(`${what}：取不到样本（选择器不在了？）`)
    if (a >= b) themeFails.push(`${what}：${a} 应暗于 ${b}`)
  }
  expectDarker(probeTheme.dark.ground, probeTheme.light.ground, '地面没有随主题变亮')
  expectDarker(probeTheme.dark.cardBg, probeTheme.light.cardBg, '卡片背景没换')
  expectDarker(probeTheme.light.text, probeTheme.dark.text, '正文没在白天变深')
  if (probeTheme.dark.navActiveColor === probeTheme.light.navActiveColor) {
    themeFails.push('强调按钮上的文字色两套主题相同（--on-accent 没生效）')
  }
  if (themeFails.length) errors.push(...themeFails)

  const probe1 = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelector(s);
      const n = (s) => document.querySelectorAll(s).length;
      return {
        screen: 'guide',
        title: q('.titlebar h1')?.textContent ?? null,
        modelAvatars: n('.avatar'),
        checkItems: n('.check-item'),
        textFields: n('.field'),
        startBtn: [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始讨论')?.textContent ?? null,
        startBtnDisabled: [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始讨论')?.disabled ?? null,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        railW: Math.round(q('.model-rail')?.getBoundingClientRect().width ?? 0),
      };
    })()
  `)

  const shot1 = await win.webContents.capturePage()
  fs.writeFileSync(OUT.replace('.png', '-guide.png'), shot1.toPNG())

  // 走一遍真实交互：填议题 → 开始讨论
  await win.webContents.executeJavaScript(`
    (() => {
      const inputs = document.querySelectorAll('.field input[type=text]');
      const setVal = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setVal(inputs[0], '评估为报表系统引入实时计算层的必要性');
      const ta = document.querySelector('.field textarea');
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
    { type: 'moderator', digest: { consensus_points: [{ claim: 'P95 延迟是当前核心瓶颈', support: ['chatgpt', 'claude'], confidence: 0.85, evidence_ref: ['u1', 'u2'] }], open_disputes: [{ claim: '是否需要双写对账层', sides: [{ agent_id: 'chatgpt', argument: '不需要，双写成本高于收益' }, { agent_id: 'claude', argument: '需要，否则数字无法对账' }] }] }, score: { round: 1, score: 58, agreement: 50, overlap: 60, trend: 50 } },
    // ---- 人工介入 ----
    { type: 'intervention', intervention: { id: 'iv1', kind: 'interject', text: '两位的成本估算都缺少人力投入，请补充。', atRound: 1, status: 'pending', targetAgentIds: [] } },
    { type: 'utterance-done', utterance: { id: 'uh1', round: 1, agentId: 'human', content: '两位的成本估算都缺少人力投入，请补充。', targets: [], human: true } },
    { type: 'round-start', round: 2, total: 3 },
    { type: 'utterance-done', utterance: { id: 'u4', round: 2, agentId: 'chatgpt', content: '第 2 轮：补充人力成本约 2 人周，折合一次性 6 万元。我承认一致性问题真实存在，但可通过在报表层标注数据来源与时间戳缓解，而非引入双写。', targets: ['claude'], stance: 'conditional', usage: { promptTokens: 0, completionTokens: 72, costUsd: 0.015 } } },
    { type: 'intervention', intervention: { id: 'iv2', kind: 'followup', text: '为什么不直接双写？', atRound: 2, status: 'pending', targetAgentIds: ['claude'], targetAgentId: 'claude' } },
    { type: 'stance-changed', agentId: 'claude', before: '（默认立场）', after: '风险审阅者', effectiveRound: 3 },
    { type: 'duel-start', duel: { topic: '是否需要双写对账层', agentIds: ['chatgpt', 'claude'] } },
    { type: 'utterance-done', utterance: { id: 'ud1', round: 2, agentId: 'chatgpt', content: '对辩：双写的边际成本随查询量线性增长，而读多写少场景下缓存命中率已超 92%，双写收益不成立。', targets: ['claude'], stance: 'oppose', usage: { promptTokens: 0, completionTokens: 58, costUsd: 0.012 } } },
    { type: 'utterance-done', utterance: { id: 'ud2', round: 2, agentId: 'claude', content: '对辩：92% 命中率意味着 8% 的不一致，而这 8% 恰好是财务最关心的口径差异。', targets: ['chatgpt'], stance: 'oppose', usage: { promptTokens: 0, completionTokens: 52, costUsd: 0.011 } } },
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

  const probe2 = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelector(s);
      const n = (s) => document.querySelectorAll(s).length;
      const ivTabs = [...document.querySelectorAll('.iv-tab')].map(b => b.textContent);
      return {
        screen: 'session',
        modeTabs: [...document.querySelectorAll('.mode-tab')].map(b => b.textContent),
        roundPill: q('.round-pill')?.textContent ?? null,
        roundDividers: n('.round-divider'),
        utteranceCards: n('.utterance'),
        absentCards: n('.u-absent'),
        calloutHints: n('.u-callout'),
        stanceTags: n('.stance-tag'),
        // 人工介入
        ivTabs,
        ivSelects: n('.iv-select'),
        ivTextarea: !!q('.interject-bar textarea'),
        interventionChips: n('.iv-chip'),
        tickerPresent: !!q('.iv-ticker'),
        humanCards: [...document.querySelectorAll('.u-meta')].filter(m => m.textContent.includes('人类参与者')).length,
        actionButtons: n('.u-actions .btn'),
        // 共识面板
        consensusPanel: !!q('.consensus-panel'),
        scoreChart: !!q('.score-chart'),
        dimBoxes: n('.dim-box'),
        consensusItems: n('.point-item.consensus'),
        disputeItems: n('.point-item.dispute'),
        takeOverDisabled: document.querySelectorAll('.mode-tab')[2]?.disabled ?? null,
      };
    })()
  `)

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

  // ---------- 历史页与重试 ----------
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
  const shotHistoryList = await win.webContents.capturePage()
  fs.writeFileSync(OUT.replace('.png', '-history.png'), shotHistoryList.toPNG())

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
        modalOpen: !!q('.report-modal'),
        sections: [...document.querySelectorAll('.report-sec-title')].map(x => x.textContent),
        consensusRows: n('.report-consensus'),
        disputeRows: n('.report-dispute'),
        interventionRows: n('.report-sec .report-sub'),
        foot: q('.report-foot')?.textContent ?? null,
      };
    })()
  `)

  // 重试菜单展开态截图
  const shotMenu = await win.webContents.capturePage()
  fs.writeFileSync(OUT.replace('.png', '-retry-menu.png'), shotMenu.toPNG())

  // 关闭报告弹层，恢复会话页截图
  await win.webContents.executeJavaScript(`
    (() => { const b = [...document.querySelectorAll('.report-head button')][0]; if (b) b.click(); return !!b })()
  `)
  await sleep(300)
  await win.webContents.executeJavaScript(`
    (() => { const btns=[...document.querySelectorAll('.titlebar button')]; const h=btns.find(b=>b.textContent.includes('返回')); if(h) h.click(); return !!h })()
  `)
  await sleep(600)

  const shot2 = await win.webContents.capturePage()
  fs.writeFileSync(OUT, shot2.toPNG())

  const report = {
    probe_theme: probeTheme,
    probe_guide: probe1,
    probe_session: probe2,
    probe_history: probeHistory,
    probe_menu: probeMenu,
    probe_report: probeReport,
    ivCalls,
    retryCalls,
    preClick,
    consoleErrors: errors,
  }
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8')

  process.stdout.write('SMOKE_REPORT_WRITTEN\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  app.exit(0)
})

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
