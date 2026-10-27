/**
 * torra-ui 离线可视化验收页：不起 Electron、不要 API Key
 *
 * test:assistant-ui 只证明 DOM 结构对，看不出视觉对 —— 环形图缺口朝哪、
 * 窄屏下柱状图标签列有没有被压扁，都得真看一眼。本脚本用同一套
 * esbuild + react-dom/server 通路把真实组件渲成静态 HTML，再原样内联
 * styles.css，产出可直接用浏览器打开的单文件。
 *
 * 用法：npm run preview:assistant-ui  ->  scripts/.aui-preview/index.html
 */
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'scripts', '.aui-preview')
const CASES: Array<{ name: string; text: string }> = [
  {
    name: "完整形态：五种 block + 动作按钮",
    text: [
      "~~~torra-ui",
      "{\n  \"version\": 1,\n  \"title\": \"模型接入体检\",\n  \"description\": \"数据来自本轮 torra_list_models 与 torra_run_doctor 的返回值\",\n  \"blocks\": [\n    {\n      \"type\": \"metrics\",\n      \"title\": \"关键指标\",\n      \"items\": [\n        {\n          \"label\": \"可用模型\",\n          \"value\": \"3\",\n          \"hint\": \"已配置 Key\"\n        },\n        {\n          \"label\": \"待登录\",\n          \"value\": \"1\",\n          \"hint\": \"需本人扫码\"\n        },\n        {\n          \"label\": \"平均耗时\",\n          \"value\": \"1.9\",\n          \"hint\": \"秒\"\n        }\n      ]\n    },\n    {\n      \"type\": \"bar\",\n      \"title\": \"单轮耗时对比\",\n      \"items\": [\n        {\n          \"label\": \"元宝\",\n          \"value\": 1.8,\n          \"detail\": \"秒\"\n        },\n        {\n          \"label\": \"豆包\",\n          \"value\": 2.4,\n          \"detail\": \"秒\"\n        },\n        {\n          \"label\": \"通义\",\n          \"value\": 0.9,\n          \"detail\": \"秒\"\n        }\n      ]\n    },\n    {\n      \"type\": \"line\",\n      \"title\": \"近五轮成功率\",\n      \"points\": [\n        {\n          \"label\": \"R1\",\n          \"value\": 62\n        },\n        {\n          \"label\": \"R2\",\n          \"value\": 71\n        },\n        {\n          \"label\": \"R3\",\n          \"value\": 68\n        },\n        {\n          \"label\": \"R4\",\n          \"value\": 84\n        },\n        {\n          \"label\": \"R5\",\n          \"value\": 91\n        }\n      ]\n    },\n    {\n      \"type\": \"donut\",\n      \"title\": \"站点分布\",\n      \"items\": [\n        {\n          \"label\": \"已接入\",\n          \"value\": 7\n        },\n        {\n          \"label\": \"待接入\",\n          \"value\": 3\n        }\n      ]\n    },\n    {\n      \"type\": \"table\",\n      \"title\": \"明细\",\n      \"columns\": [\n        \"模型\",\n        \"状态\",\n        \"耗时\"\n      ],\n      \"rows\": [\n        [\n          \"元宝\",\n          \"可用\",\n          \"1.8s\"\n        ],\n        [\n          \"豆包\",\n          \"待登录\",\n          \"-\"\n        ],\n        [\n          \"通义\",\n          \"可用\",\n          \"0.9s\"\n        ]\n      ]\n    }\n  ],\n  \"actions\": [\n    {\n      \"label\": \"查看详细诊断\",\n      \"prompt\": \"请继续检查这几个模型的连接状态\"\n    }\n  ]\n}",
      "~~~",
    ].join(String.fromCharCode(10)),
  },
  {
    name: "流式中：围栏未闭合",
    text: [
      "~~~torra-ui",
      "{\n  \"version\": 1,\n  \"title\": \"正在汇总\",\n  \"blocks\": []\n}",
    ].join(String.fromCharCode(10)),
  },
  {
    name: "降级：协议无效",
    text: [
      "~~~torra-ui",
      "{ 这不是合法 JSON }",
      "~~~",
    ].join(String.fromCharCode(10)),
  },
]

type Harness = { preload: () => Promise<void>; renderUi: (text: string, streaming?: boolean) => string }

function loadHarness(): Harness {
  const esbuild = require("esbuild") as typeof import("esbuild")
  const entry = [
    'import React from "react"',
    'import { renderToStaticMarkup } from "react-dom/server"',
    'import { Markdown, preloadMarkdown } from "./src/renderer/components/Markdown"',
    "export function preload(): Promise<void> { return preloadMarkdown() }",
    "const ui = { onAction: (p: string) => { void p } }",
    "export function renderUi(text: string, streaming: boolean): string {",
    "  return renderToStaticMarkup(React.createElement(Markdown, { text, ui, streaming }))",
    "}",
  ].join("\n")
  const result = esbuild.buildSync({
    stdin: { contents: entry, loader: "ts", resolveDir: ROOT, sourcefile: "aui-preview-harness.ts" },
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2022",
    jsx: "automatic",
    write: false,
    absWorkingDir: ROOT,
    alias: { "@shared": path.join(ROOT, "src/shared") },
    logLevel: "silent",
  })
  const code = result.outputFiles[0]?.text
  if (!code) throw new Error("esbuild 没有产出 bundle")
  const m = new Module("aui-preview-harness")
  m.filename = path.join(ROOT, "scripts", "aui-preview-harness.js")
  m.paths = (Module as any)._nodeModulePaths(path.dirname(m.filename))
  ;(m as any)._compile(code, m.filename)
  return m.exports as unknown as Harness
}

async function main(): Promise<void> {
  const h = loadHarness()
  await h.preload()

  const css = fs.readFileSync(path.join(ROOT, "src/renderer/styles.css"), "utf8")
  const sections = CASES.map((c) => {
    const streaming = c.name.startsWith("流式")
    return [
      "<h3>${c.name}</h3>",
      '<div class="a-block a-say">',
      '  <span class="a-say-mark"></span>',
      '  <div class="a-say-body md">',
      h.renderUi(c.text, streaming),
      "  </div>",
      "</div>",
    ].join("\n")
  }).join("\n")

  const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>交互视图验收</title>
<style>${css}</style>
<style>
  body { margin: 0; padding: 24px; background: var(--bg-app, #101014); color: var(--text); font-family: system-ui, sans-serif; }
  .wrap { max-width: 460px; margin: 0 auto; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .tip { font-size: 12px; color: var(--text-3); margin: 0 0 20px; }
  h3 { font-size: 12px; color: var(--text-3); margin: 22px 0 6px; font-weight: 500; }
</style>
</head>
<body>
<div class="wrap">
  <h2>交互视图（torra-ui）验收</h2>
  <p class="tip">宽度与助手抽屉一致（460px）。把窗口收到 520px 以下，看柱状图标签列是否收起。</p>
${sections}
</div>
</body>
</html>`

  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = path.join(OUT_DIR, "index.html")
  fs.writeFileSync(out, html, "utf8")
  console.log(`已生成 ` + path.relative(ROOT, out) + `（` + (html.length / 1024).toFixed(0) + ` KB）`)
  console.log("浏览器打开即可查看，无需启动 Electron。")
}

void main()
