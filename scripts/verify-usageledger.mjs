// 运行时验证：设置页里的「用量与成本」那一屏。
//
// 这一屏的风险不在代码，在「口径有没有被界面如实翻译」：
//   1. 金额是估算而不是账单 —— 单价表的核对日期必须露出来，过期要说一句；
//   2. 网页渠道量不到 token —— 那一行只能是「未计量」，不能显示成 0（那是拿估算冒充实测）；
//   3. 空账要显示「本机还没有记录」，而不是摆一排 0；
//   4. 喂进去的数与界面显示的数必须一致（累计花费、次数、按天分桶）。
//
// 另外在同一脚本里断言纯函数口径：同一模型两次调用后 calls=2、token 相加、
// 天数桶按调用发生的那天落、网页渠道 token 为 0 且 webCalls 递增、
// 日桶只留 30 天而总额与每模型累计永不裁剪。
//
// 用一份全新的临时 userData 启动，只管理本脚本 spawn 的 electron 进程，用完连目录一起删。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, '.autopilot', 'usageledger')
const STORE_JS = path.join(ROOT, 'dist', 'main', 'store', 'usage-stats.js')
const PORT = await freePort(9483)
const INSPECT_PORT = await freePort(PORT + 1)
function freePort(from) {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(from, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}
const require = createRequire(import.meta.url)
const electronBin = require(path.join(ROOT, 'node_modules', 'electron'))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-verify-usage-'))

if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'index.js')) || !fs.existsSync(STORE_JS)) {
  console.error('验证脚本需要先构建：npm run build（dist/main/index.js 与 dist/main/store/usage-stats.js 都要在）')
  process.exit(1)
}

let failures = []
const check = (name, ok, extra) => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? ` · ${JSON.stringify(extra)}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let wsCdp = null
let wsMainCdp = null

function cdpClient(socket) {
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })
  return {
    send(method, params = {}, timeoutMs = 15000) {
      const mid = ++id
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject })
        socket.send(JSON.stringify({ id: mid, method, params }))
        setTimeout(() => {
          if (pending.has(mid)) {
            pending.delete(mid)
            reject(new Error(`CDP 超时: ${method}`))
          }
        }, timeoutMs)
      })
    },
  }
}

async function findTarget(kind) {
  for (let i = 0; i < 60; i++) {
    const port = kind === 'page' ? PORT : INSPECT_PORT
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const hit =
        kind === 'page'
          ? list.find((t) => t.type === 'page' && /^file:\/\/.*index\.html/.test(t.url || ''))
          : list.find((t) => t.type === 'node' && t.webSocketDebuggerUrl)
      if (hit) return hit
    } catch {
      /* 尚未就绪 */
    }
    await sleep(400)
  }
  throw new Error(kind === 'page' ? '未找到渲染层页面目标' : '未找到主进程调试目标（--inspect 没起来？）')
}

async function connect(url) {
  const sock = new WebSocket(url)
  await new Promise((res, rej) => {
    sock.addEventListener('open', res)
    sock.addEventListener('error', rej)
  })
  return cdpClient(sock)
}

async function evalJs(expression, awaitPromise = true) {
  const r = await wsCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) {
    throw new Error('页内执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}

async function mainEval(expression, awaitPromise = false) {
  const r = await wsMainCdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    includeCommandLineAPI: true,
    awaitPromise,
  })
  if (r.exceptionDetails) throw new Error('主进程执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function shot(name) {
  const r = await wsCdp.send('Page.captureScreenshot', { format: 'png' }, 60000)
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  return path.join(OUT, `${name}.png`)
}

/** 点一个按钮（按文案找），返回点到了没有 */
async function clickByText(selector, re) {
  return evalJs(
    `(function(){const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>${re}.test(x.textContent||''));if(!b)return false;b.click();return true})()`,
    false,
  )
}

/* ── 假账：喂进去的数必须与界面显示的数一模一样 ── */
const NOW = Date.now()
const dayKey = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** 最近 14 天的按天花费：给一个有起伏的形状，柱状图才有东西可看 */
const FAKE_DAYS = {}
for (let i = 13; i >= 0; i--) {
  const at = new Date(NOW)
  at.setHours(12, 0, 0, 0)
  at.setDate(at.getDate() - i)
  FAKE_DAYS[dayKey(at.getTime())] = { calls: i === 3 ? 0 : 1 + (i % 3), costUsd: i === 3 ? 0 : Number((0.0021 * (1 + (i % 5))).toFixed(6)) }
}
const FAKE_LEDGER = {
  models: {
    'gpt-5.6-sol': {
      calls: 12,
      promptTokens: 120000,
      completionTokens: 34000,
      costUsd: 0.5832,
      lastAt: NOW - 3600_000,
      transport: 'api',
      label: 'GPT-5.6 Sol',
    },
    'deepseek-chat': {
      calls: 5,
      promptTokens: 21000,
      completionTokens: 9000,
      costUsd: 0.0123,
      lastAt: NOW - 86_400_000,
      transport: 'api',
      label: 'DeepSeek',
    },
    chatgpt: {
      calls: 9,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      lastAt: NOW - 7200_000,
      transport: 'web',
      label: 'ChatGPT',
    },
  },
  days: FAKE_DAYS,
  totalCostUsd: 0.5955,
  totalCalls: 26,
  webCalls: 9,
  apiCalls: 17,
  updatedAt: NOW,
}

/* ── 纯函数口径：同一模型两次调用 + 一次网页调用 ── */
const T1 = new Date(NOW)
T1.setDate(T1.getDate() - 2)
T1.setHours(12, 0, 0, 0)
const T2 = new Date(NOW)
T2.setDate(T2.getDate() - 1)
T2.setHours(12, 0, 0, 0)
const DAY1 = dayKey(T1.getTime())
const DAY2 = dayKey(T2.getTime())
/* 40 天前：用来验「日桶只留 30 天，但总额与每模型累计永不裁剪」 */
const T_OLD = new Date(NOW)
T_OLD.setDate(T_OLD.getDate() - 40)
T_OLD.setHours(12, 0, 0, 0)
const DAY_OLD = dayKey(T_OLD.getTime())

async function main() {
  child = spawn(
    electronBin,
    [`--inspect=${INSPECT_PORT}`, ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (!/DevTools listening|Debugger listening|Debugging suggestion|GPU|gpu|Warning|deprecat/i.test(s)) console.log('[app:err] ' + s)
  })

  const page = await findTarget('page')
  wsCdp = await connect(page.webSocketDebuggerUrl)
  wsMainCdp = await connect((await findTarget('node')).webSocketDebuggerUrl)
  await wsCdp.send('Runtime.enable')
  await wsCdp.send('Page.enable')
  await mainEval(
    `(function(){for(const w of require('electron').BrowserWindow.getAllWindows()){if(w.isDestroyed())continue;if(w.isMinimized())w.restore();w.show();w.setContentSize(1600,950);w.moveTop();w.focus()}return 'ok'})()`,
  )
  await sleep(1800)
  // 首次引导会挡住设置页，先把它收掉
  await clickByText('.start-intro-foot button', /知道了|不再显示/)
  await sleep(400)

  // ── 纯函数口径（跑在主进程里，用的是应用真正加载的那份编译产物）──
  const pure = await mainEval(
    `(function(){
      const store = require(${JSON.stringify(STORE_JS)});
      let s = store.emptyUsageStats();
      s = store.noteModelUsage(s, 'gpt-5', { promptTokens: 1000, completionTokens: 200, costUsd: 0.01 }, 'api', ${T1.getTime()});
      s = store.noteModelUsage(s, 'gpt-5', { promptTokens: 500, completionTokens: 100, costUsd: 0.005 }, 'api', ${T2.getTime()});
      s = store.noteModelUsage(s, 'chatgpt', { promptTokens: 0, completionTokens: 9999, costUsd: 0 }, 'web', ${T2.getTime()});
      const l = s.ledger;
      return {
        gpt: l.models['gpt-5'],
        web: l.models['chatgpt'],
        days: l.days,
        totalCalls: l.totalCalls,
        totalCostUsd: l.totalCostUsd,
        apiCalls: l.apiCalls,
        webCalls: l.webCalls,
      };
    })()`,
  )
  check('同一模型两次调用后 calls=2', pure?.gpt?.calls === 2, { calls: pure?.gpt?.calls })
  check('token 相加（输入 1500 / 输出 300）', pure?.gpt?.promptTokens === 1500 && pure?.gpt?.completionTokens === 300, {
    promptTokens: pure?.gpt?.promptTokens,
    completionTokens: pure?.gpt?.completionTokens,
  })
  check('金额相加（0.015）', Math.abs((pure?.gpt?.costUsd ?? 0) - 0.015) < 1e-9, { costUsd: pure?.gpt?.costUsd })
  check(
    '天数桶按调用发生的那天落（两天各一桶）',
    pure?.days?.[DAY1]?.calls === 1 && pure?.days?.[DAY2]?.calls === 2,
    { days: pure?.days, DAY1, DAY2 },
  )
  check(
    '网页渠道 token 为 0（不拿字符数折算冒充实测）',
    pure?.web?.promptTokens === 0 && pure?.web?.completionTokens === 0 && pure?.web?.costUsd === 0 && pure?.web?.calls === 1,
    { web: pure?.web },
  )
  check('webCalls 递增、apiCalls 各归各', pure?.webCalls === 1 && pure?.apiCalls === 2, {
    webCalls: pure?.webCalls,
    apiCalls: pure?.apiCalls,
  })
  check('总计与分项一致', pure?.totalCalls === 3 && Math.abs((pure?.totalCostUsd ?? 0) - 0.015) < 1e-9, {
    totalCalls: pure?.totalCalls,
    totalCostUsd: pure?.totalCostUsd,
  })

  // 日桶只留最近 30 天 —— 但「这台机器上花掉多少」不能跟着一起被裁掉
  const pruned = await mainEval(
    `(function(){
      const store = require(${JSON.stringify(STORE_JS)});
      let s = store.emptyUsageStats();
      s = store.noteModelUsage(s, 'old-model', { promptTokens: 10, completionTokens: 5, costUsd: 0.02 }, 'api', ${T_OLD.getTime()});
      s = store.noteModelUsage(s, 'new-model', { promptTokens: 20, completionTokens: 10, costUsd: 0.03 }, 'api', ${NOW});
      const l = s.ledger;
      return { oldDay: l.days[${JSON.stringify(DAY_OLD)}], oldModel: l.models['old-model'], totalCalls: l.totalCalls, totalCostUsd: l.totalCostUsd, dayKeys: Object.keys(l.days) };
    })()`,
  )
  check(
    '超过 30 天的日桶被裁掉（柱状图只看近期）',
    pruned?.oldDay === undefined,
    { dayKeys: pruned?.dayKeys, DAY_OLD },
  )
  check(
    '日桶被裁掉也不影响总额与每模型累计（钱不会忘）',
    pruned?.oldModel?.calls === 1 &&
      Math.abs((pruned?.oldModel?.costUsd ?? 0) - 0.02) < 1e-9 &&
      pruned?.totalCalls === 2 &&
      Math.abs((pruned?.totalCostUsd ?? 0) - 0.05) < 1e-9,
    { oldModel: pruned?.oldModel, totalCalls: pruned?.totalCalls, totalCostUsd: pruned?.totalCostUsd },
  )

  // ── 进设置页 → 用量与成本 ──
  const wentSettings = await clickByText('.app-nav-item', /设置/)
  await sleep(1200)
  check('点导航能进设置页', wentSettings)
  const wentUsage = await clickByText('.st-nav-item', /用量与成本/)
  await sleep(900)
  check('能切到「用量与成本」这一屏', wentUsage)

  let panel = null
  for (let i = 0; i < 20; i++) {
    panel = await evalJs(
      `(function(){const el=document.querySelector('[data-testid="usage-ledger"]');if(!el)return null;el.scrollIntoView({block:'center'});return true})()`,
      false,
    )
    if (panel) break
    await sleep(300)
  }
  check('用量与成本这一屏出现', !!panel)

  // ── 空账：必须说「本机还没有记录」，而不是一排 0 ──
  const empty = await evalJs(
    `(function(){
      const el = document.querySelector('[data-testid="usage-empty"]');
      return {
        text: el ? (el.textContent||'').trim() : '',
        hasTotal: !!document.querySelector('[data-testid="usage-total-cost"]'),
        zeroRows: document.querySelectorAll('[data-testid="usage-row"]').length,
      };
    })()`,
    false,
  )
  check('空账显示「本机还没有记录」', /本机还没有记录/.test(empty?.text ?? ''), { text: empty?.text })
  check('空账不摆一排 0（没有总额、没有任何行）', empty?.hasTotal === false && empty?.zeroRows === 0, {
    hasTotal: empty?.hasTotal,
    zeroRows: empty?.zeroRows,
  })
  const emptyShot = await shot('usage-empty-dark')

  // ── 塞一份假账进本机 preferences.json（走应用自己的落盘函数）──
  const written = await mainEval(
    `(function(){
      const path = require('path');
      const { app } = require('electron');
      const store = require(${JSON.stringify(STORE_JS)});
      const file = path.join(app.getPath('userData'), 'torra', 'preferences.json');
      const stats = store.normalizeUsageStats({ ledger: ${JSON.stringify(FAKE_LEDGER)} });
      return store.writeUsageStats(file, stats).then(() => 'written');
    })()`,
    true,
  )
  check('假账写进本机 preferences.json', written === 'written', { written })

  // ── 刷新这一屏，读回界面上的数 ──
  const refreshed = await clickByText('[data-testid="usage-ledger"] button', /刷新/)
  await sleep(1200)
  check('点得到这一屏的刷新', refreshed)

  const read = await evalJs(
    `(function(){
      const cs = (el) => getComputedStyle(el);
      const root = document.querySelector('[data-testid="usage-ledger"]');
      const rows = [...document.querySelectorAll('[data-testid="usage-row"]')];
      const stat = document.querySelector('.ul-stat');
      const bar = document.querySelector('.ul-bar');
      return {
        totalCost: (document.querySelector('[data-testid="usage-total-cost"]')?.textContent||'').trim(),
        totalCalls: (document.querySelector('[data-testid="usage-total-calls"]')?.textContent||'').trim(),
        totalDays: (document.querySelector('[data-testid="usage-total-days"]')?.textContent||'').trim(),
        price: (document.querySelector('[data-testid="usage-price"]')?.textContent||'').trim(),
        rowIds: rows.map(r => r.getAttribute('data-model-id')),
        rowCosts: rows.map(r => (r.querySelector('.ul-row-cost')?.textContent||'').trim()),
        rowTokens: rows.map(r => (r.querySelector('.ul-row-tokens')?.textContent||'').trim()),
        webNote: (document.querySelector('[data-testid="usage-web-note"]')?.textContent||'').trim(),
        chartCols: document.querySelectorAll('[data-testid="usage-chart"] .ul-col').length,
        bars: document.querySelectorAll('[data-testid="usage-chart"] .ul-bar').length,
        theme: document.documentElement.dataset.theme,
        cardStyle: stat ? { radius: cs(stat).borderTopLeftRadius, shadow: cs(stat).boxShadow, border: cs(stat).borderTopWidth } : null,
        barColor: bar ? cs(bar).backgroundColor : null,
        rootText: root ? (root.textContent||'').slice(0, 200) : '',
      };
    })()`,
    false,
  )
  check('界面显示的累计花费与喂进去的一致', read?.totalCost === '$0.5955', { shown: read?.totalCost, expected: '$0.5955' })
  check('界面显示的累计调用与喂进去的一致', read?.totalCalls === '26 次', { shown: read?.totalCalls, expected: '26 次' })
  check('按花费降序：最贵的在最前', read?.rowIds?.[0] === 'gpt-5.6-sol', { rowIds: read?.rowIds })
  check(
    '每个模型行的花费与喂进去的一致',
    read?.rowCosts?.[0] === '$0.5832' && read?.rowCosts?.[1] === '$0.0123',
    { rowCosts: read?.rowCosts },
  )
  check('网页渠道那一行标着「量不到 token」', /网页渠道量不到 token/.test(read?.webNote ?? ''), { webNote: read?.webNote })
  check(
    '网页渠道那一行显示「token 未计量」而不是 0',
    (read?.rowTokens ?? []).some((t) => /token 未计量/.test(t)),
    { rowTokens: read?.rowTokens },
  )
  check('柱状图按最近 14 天画', read?.chartCols === 14 && read?.bars === 14, { chartCols: read?.chartCols, bars: read?.bars })
  check('单价表的核对日期露出来了', /核对于\s*\d{4}-\d{2}-\d{2}/.test(read?.price ?? ''), { price: read?.price })
  check(
    '卡片是「圆角 + 浮起阴影」且没有叠描边',
    read?.cardStyle && parseFloat(read.cardStyle.radius) > 0 && read.cardStyle.shadow !== 'none' && read.cardStyle.border === '0px',
    read?.cardStyle,
  )

  // 深浅两套皮肤各截一张
  const shots = []
  shots.push(await shot('usage-ledger-dark'))
  await evalJs(
    `(function(){const b=document.querySelector('.theme-toggle');if(b){b.click();return true}return false})()`,
    false,
  )
  await sleep(1200)
  const light = await evalJs(
    `(function(){const el=document.querySelector('[data-testid="usage-ledger"] .ul-stat');if(!el)return null;const cs=getComputedStyle(el);return {theme:document.documentElement.dataset.theme,radius:cs.borderTopLeftRadius,shadow:cs.boxShadow,border:cs.borderTopWidth,color:cs.color,bg:cs.backgroundColor}})()`,
    false,
  )
  check('切到白天主题后这一屏还在', light && light.theme === 'light', light)
  check('浅色下卡片仍有圆角与阴影', light && parseFloat(light.radius) > 0 && light.shadow !== 'none' && light.border === '0px', light)
  shots.push(await shot('usage-ledger-light'))

  console.log(failures.length ? `\n\x1b[31m${failures.length} 项未通过\x1b[0m ` + failures.join(', ') : `\n\x1b[32m全部通过\x1b[0m · 截图在 ${OUT}`)
  console.log('截图：' + [emptyShot, ...shots].join(' · '))
}

try {
  await main()
} catch (e) {
  console.error('验证脚本异常：', e)
  failures.push('exception')
} finally {
  try {
    child?.kill()
  } catch {
    /* 已退出 */
  }
  await sleep(600)
  fs.rmSync(userData, { recursive: true, force: true })
}
process.exit(failures.length ? 1 : 0)
