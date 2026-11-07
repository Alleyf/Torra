#!/usr/bin/env node
/**
 * 研讨屏「观点演化视图」离线验收：不起 Electron、不要 API Key。
 *
 * 为什么要有它：smoke 只证明 DOM 结构对，看不出视觉对 —— 阶段链的连接器、
 * 节点数值的字阶、汇流层的缩进，都得真看一眼。本脚本用 esbuild 把真实的
 * EvolutionStage（连同真 store）打成一份浏览器 bundle，内联 styles.css +
 * consensusLab.css，产出可直接用浏览器打开的单文件。
 *
 * 为什么走客户端挂载而不是 react-dom/server：store 是 zustand + React 18 的
 * useSyncExternalStore，服务端渲染只认初始状态，注入的夹具永远进不去组件 ——
 * 那样截出来的图是一张空壳，正好是「看着没坏、其实什么都没测」。
 *
 * 数据不是编的：夹具与 scripts/smoke.js 里那套事件序列同口径（见其
 * MODERATOR_SUMMARY 段落），只是把它一次性写进 store。
 *
 * 用法：
 *    node scripts/preview-lab-flow.mjs                 # 深色 · 容器 1400px
 *    node scripts/preview-lab-flow.mjs --light         # 浅色那一版
 *    node scripts/preview-lab-flow.mjs --width=1100    # 窄容器（验断点用）
 *
 * 产出 scripts/.lab-flow/index-<theme>-<width>.html，三份互不覆盖。
 * 页面把真 store 挂在 window.__labStore 上，验「值变了动画会不会重跑」这类事
 * 可以直接 setState，不用再搭一套桩。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.join(ROOT, 'scripts', '.lab-flow')
const THEME = process.argv.includes('--light') ? 'light' : 'dark'

/** 与 smoke.js 同一套参会模型口径 */
const models = [
  { id: 'chatgpt', displayName: 'ChatGPT', transport: 'webview', color: '#10a37f', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'claude', displayName: 'Claude', transport: 'webview', color: '#d97757', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'gemini', displayName: 'Gemini', transport: 'webview', color: '#4285F4', enabled: true, supportsStructuredOutput: true, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
  { id: 'deepseek', displayName: 'DeepSeek', transport: 'api', color: '#7b61ff', enabled: true, supportsStructuredOutput: false, adapterHealth: 'ok', adapterStale: false, hasKey: true, status: 'ready' },
]

/** 中途状态：两轮已跑完、第三轮正在主持小结 —— 四段流水线里三种 tone 都在场 */
const fixture = {
  participantIds: models.map((m) => m.id),
  moderatorId: null,
  state: 'MODERATOR_SUMMARY',
  round: 3,
  topicTitle: '实时对账层是否应当双写？',
  strategy: 'roundtable',
  utterances: [
    { id: 'u1', round: 1, agentId: 'chatgpt', content: '双写成本高于收益，不建议。', streaming: false, absent: false, targets: [], usage: { promptTokens: 1200, completionTokens: 80, costUsd: 0 } },
    { id: 'u2', round: 1, agentId: 'claude', content: '需要双写，否则数字无法对账。', streaming: false, absent: false, targets: ['u1'], usage: { promptTokens: 1300, completionTokens: 90, costUsd: 0 } },
    { id: 'u3', round: 2, agentId: 'gemini', content: '缓存命中率已超 92%，双写收益不成立。', streaming: false, absent: false, targets: ['u2'], usage: { promptTokens: 1100, completionTokens: 70, costUsd: 0 } },
    { id: 'u4', round: 2, agentId: 'chatgpt', content: '补充人力成本约 2 人周，折合 6 万元。', streaming: false, absent: false, targets: ['u2'], usage: { promptTokens: 1250, completionTokens: 72, costUsd: 0 } },
    { id: 'u5', round: 3, agentId: 'deepseek', content: '读多写少场景双写边际成本随查询量线性增长。', streaming: false, absent: false, targets: ['u2'], usage: { promptTokens: 900, completionTokens: 60, costUsd: 0 } },
    { id: 'u6', round: 3, agentId: 'claude', content: '我承认一致性问题真实存在，但可标注来源缓解。', streaming: false, absent: false, targets: ['u1'], usage: { promptTokens: 1400, completionTokens: 85, costUsd: 0 } },
    { id: 'u7', round: 3, agentId: 'gemini', content: '对账口径差异约 8%，财务最关心。', streaming: false, absent: false, targets: [], usage: { promptTokens: 1000, completionTokens: 65, costUsd: 0 } },
    { id: 'u8', round: 3, agentId: 'chatgpt', content: '在报表层标注数据来源与时间戳即可。', streaming: true, absent: false, targets: ['u2'], usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } },
  ],
  consensus: [
    { id: 'c1', claim: 'P95 延迟是当前核心瓶颈', support: ['chatgpt', 'claude'], confidence: 0.85, evidenceRef: ['u1', 'u2'], confirmedRound: 2 },
    { id: 'c2', claim: '报表层应标注数据来源与时间戳', support: ['chatgpt', 'claude'], confidence: 0.72, evidenceRef: ['u2', 'u4'], confirmedRound: 3 },
  ],
  disputes: [
    { id: 'd1', claim: '是否需要双写对账层', sides: [{ agentId: 'chatgpt', argument: '不需要' }, { agentId: 'claude', argument: '需要' }], openedRound: 1, lastProgress: '第 3 轮仍各执一词', status: 'open' },
    { id: 'd2', claim: '人力成本是否计入', sides: [{ agentId: 'claude', argument: '应计入' }], openedRound: 2, lastProgress: null, status: 'open' },
  ],
  reportReady: false,
  finishedReason: null,
  paused: false,
  stageTimings: [
    { round: 1, stage: 'baseline', startedAt: 0, durationMs: 8200, summary: '发言 4/4' },
    { round: 1, stage: 'agent-batch', startedAt: 8200, durationMs: 31000, summary: '发言 4/4' },
    { round: 2, stage: 'verification', startedAt: 40000, durationMs: 9500, summary: '追问 2' },
    { round: 3, stage: 'moderator', startedAt: 50000, durationMs: 6200, summary: '小结中' },
    { round: 3, stage: 'consensus', startedAt: 56200, durationMs: 3800, summary: '归并 2' },
  ],
}

const harnessEntry = [
  'import React from "react"',
  'import { createRoot } from "react-dom/client"',
  'import { EvolutionStage } from "./src/renderer/components/EvolutionStage"',
  'import { useStore } from "./src/renderer/store"',
  `const models = ${JSON.stringify(models)}`,
  `const fixture = ${JSON.stringify(fixture)}`,
  'useStore.setState(fixture)',
  '/** 主持小结的走秒靠一根针：给它一个刚开跑的 startedAt，截图里才是「进行中」 */',
  'useStore.setState({ moderatorLive: { startedAt: Date.now() - 4200, attempt: 1, firstByteMs: 1800, tail: "正在归纳各家的对账口径差异…" } })',
  'createRoot(document.getElementById("root")).render(',
  '  React.createElement(EvolutionStage, { models, onExpand: () => {} }),',
  ')',
  '/** 预览页要能自己改状态（验「值变了会不会重新跳动」这类事），store 挂到 window 上 */',
  'window.__labStore = useStore',
].join('\n')

const bundle = esbuild.buildSync({
  stdin: { contents: harnessEntry, loader: 'tsx', resolveDir: ROOT, sourcefile: 'lab-flow-harness.tsx' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  jsx: 'automatic',
  write: false,
  absWorkingDir: ROOT,
  alias: { '@shared': path.join(ROOT, 'src', 'shared') },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
})

const code = bundle.outputFiles[0]?.text
if (!code) throw new Error('esbuild 没有产出 bundle')

const css = [
  fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'src/renderer/consensusLab.css'), 'utf8'),
].join('\n')

/** 视口宽度：默认 1400 走宽屏布局；--width=1100 可看窄屏那一套 */
const WIDTH = Number(process.argv.find((a) => a.startsWith('--width='))?.slice(8)) || 1400

const html = `<!doctype html>
<html lang="zh-CN" data-theme="${THEME}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>观点演化视图验收</title>
<style>${css}</style>
<style>
  body { margin: 0; padding: 28px; background: var(--cl-bg); font-family: var(--font-ui, system-ui); }
  .wrap { max-width: ${WIDTH}px; margin: 0 auto; }
  .cap { font-size: 12px; color: var(--cl-text-3); margin: 0 0 14px; font-family: var(--font-mono); }
</style>
</head>
<body>
<div class="wrap">
  <p class="cap">观点演化视图 · ${WIDTH}px · ${THEME}</p>
  <div id="root"></div>
</div>
<script>${code}</script>
</body>
</html>`

/*
 * 只删自己要写的那一份。早先这里是 rmSync(OUT_DIR, recursive) ——
 * 出浅色那一版会把深色那版一起删掉，回头对着深色链接截图就是 ERR_FILE_NOT_FOUND。
 */
fs.mkdirSync(OUT_DIR, { recursive: true })
const out = path.join(OUT_DIR, `index-${THEME}-${WIDTH}.html`)
fs.writeFileSync(out, html, 'utf8')
console.log(`已生成 ${path.relative(ROOT, out)}（${(html.length / 1024).toFixed(0)} KB）`)
