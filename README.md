# Torra

> 多模型 AI 议事厅桌面客户端 —— 把"用户当传声筒"变成"模型开圆桌会"

Electron + React + TypeScript。用户提供议题，多个 LLM（网页版或 API）按轮次并行发言、
相互点名回应，由主持模型记录共识与分歧，最终输出带溯源的结构化报告。

---

## 快速开始

```bash
npm install                 # 若报 esbuild / rollup 平台包缺失，见下方「安装陷阱」
npm run build               # 构建主进程 + preload + 渲染层
npm start                   # 构建并启动

npm run dev                 # 开发模式：vite + tsc watch + Electron，一条命令全起
npm run typecheck           # 两段 TypeScript 类型检查
npm run test:invariants     # 核心不变量自测（36 项）
npm run smoke               # 运行时界面冒烟测试 + 截图
npm run diagnose:webview chatgpt   # 只读诊断某站点分区实际加载了什么
npm run verify:inject             # 在真实分区回归验证注入脚本判定
```

首次使用：在「发起一场讨论」页填入 DeepSeek API Key（仅存本机钥匙串），并点击左栏模型
头像完成网页版登录。

> ⚠️ **网页登录必须在 Torra 自己的登录窗口里完成**。Torra 用独立分区
> （`persist:torra-<model>`）承载登录态，与你日常浏览器的会话完全隔离 ——
> 在 Chrome/Edge 里登录 ChatGPT 对 Torra 无效，这是「明明登录了却提示需要登录」
> 最常见的原因。

---

## 架构

```
渲染层（React）
  左模型栏 64px │ 中讨论流 │ 右共识面板 220px
        │ SSE / IPC
主进程：编排状态机
  轮次控制 · 上下文裁剪 · 共识评估 · 消息路由
        │
  ┌─────┴──────┐
WebView 池     API 传输层
独立 partition  OpenAI 兼容协议
站点适配器注入  每厂商一个适配器
```

### 关键设计

| 机制 | 说明 |
| --- | --- |
| **轮内并行、轮间串行** | 一轮 = 1 个并行发言批次 + 1 次主持小结。5 模型 × 3 轮 = 6 个串行批次 ≈ 2~4 分钟，这是「5 分钟」目标的前提 |
| **轮内快照隔离** | 同批次模型看到同一份「上轮结束时的快照」，互相看不到本轮发言，保证发言独立性；交叉质询靠主持 callout 在下一轮实现 |
| **立场分化** | 参与模型被分配互斥立场（支持/反对/风险/务实/中立）并写进 system prompt，对抗「向均值漂移」的同质化倾向 |
| **共识度三维度** | 立场一致度 40% + 论点重合度 30% + 收敛趋势 30%，全部由程序从发言数据核算，不接受主观总分 |
| **机械校验防假收敛** | 主持声称的共识点若 `support` 指向不存在的模型、或 `evidence_ref` 指向不存在的发言，程序直接拒绝该次小结并要求重打 |
| **未决分歧只增不减** | 历史 open 条目不会因本轮未提及而消失；消解必须给出依据；上下文压缩时逐字搬运不经改写 |
| **API 优先原则** | 同时配置了 Key 与网页登录时默认走 API，网页作备用；webview 通道可随时手动接管 |
| **单模型缺席不阻塞** | 超时/失效/需登录均降级为「缺席占位」，虚线卡片显式展示原因，报告标注缺席 |

### 目录

```
src/
  shared/         三段共用类型与不变量（共识度核算、机械校验、分歧合并、压缩保分歧）
  main/
    index.ts      主进程入口 + IPC 白名单
    orchestrator/ 编排状态机
    agents/       Agent 抽象 + WebviewAgent + ApiAgent
    webview/      WebView 池 + 注入脚本
    adapters/     YAML 适配器注册表
    report/       报告生成与 Markdown 导出
    store/        会话存储 + 钥匙串
  preload/        contextBridge 白名单 API
  renderer/       React 界面
adapters/         站点适配器（chatgpt / claude / gemini）
scripts/          自测与冒烟脚本
docs/             PRD 与截图
```

---

## 站点适配器

新增站点只需加一个 YAML，**不改主程序任何代码**：

```yaml
id: chatgpt
name: ChatGPT
transport: webview
entry: https://chatgpt.com/
selectors:
  input: 'div[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i], textarea[placeholder*="ChatGPT" i], textarea#mobile-composer-prompt, #prompt-textarea'
  send: 'button[aria-label*="Send message" i], button[aria-label*="发送消息"], button[data-testid="send-button"]'
  stream: 'div[data-message-author-role="assistant"]'
  stop: 'button[aria-label*="Stop" i], button[aria-label*="停止"], button[data-testid="stop-button"]'
completion:
  mode: stop_button_hidden
  timeout_s: 120
automation:
  typing_delay_ms: [80, 220]
  pre_send_pause_ms: [500, 1500]
  max_wait_s: 120
  jitter: true
health_probe: 'div[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i], textarea[placeholder*="ChatGPT" i], textarea#mobile-composer-prompt, #prompt-textarea'
verified_at: '2026-10-01'
```

适配器目录被监听，改动后自动热更新，无需重启客户端：spec 在注册表内**原地替换**，
`WebviewAgent` 与后台 WebView 持有同一对象，下一次发言即用新选择器；`entry` 变了则重新导航，
站点同源时不打断当前页面；YAML 删除即摘除该适配器，左栏健康标记同步刷新。
校验不通过的 YAML 会被拒绝并保留旧 spec，不会把运行时带坏。

`npm run dev` 的热更新分两层：改**渲染层**（`src/renderer`）由 vite HMR 即时生效；改**主进程 /
preload**（`src/main`、`src/preload`）由 `tsc --watch` 增量编译，编译通过后自动重启 Electron
窗口——网页版登录态存在 `persist:` 分区里，重启不丢。dev server 端口从 5273 起自动顺延找空闲口，
再经 `TORRA_DEV_PORT` 交给主进程，两端不会串（同机开多个会话时各用各的端口）。

### 排查「适配器失效 / 选择器丢失」

`input selector missing` 有三种截然不同的成因，**不要一上来就改选择器**：

| 真实成因 | 判别依据 | 正确处置 |
| --- | --- | --- |
| 该分区未登录 | 页面存在 `<form action=".../auth/login_with">` | 在 Torra 内重新登录 |
| 站点改版 | 已登录但输入框选择器不存在 | 更新 YAML 选择器 + `verified_at` |
| 页面还没渲染完 | SPA 延迟挂载输入框 | 等待，已由 `waitFor` 处理 |

用只读诊断确认属于哪一种：

```bash
npm run diagnose:webview chatgpt
# 输出 docs/diagnose-chatgpt.json：
#   samples[].bodyText        页面正文（含「登录」即未登录）
#   samples[].loginWallEls    登录墙命中的具体元素
#   samples[].candidates      各类候选选择器命中数
#   samples[].editables       页面全部可编辑区域 —— 站点改版时据此更新 YAML
#   cookies                   仅统计数量与认证类 cookie 名，不导出凭据
```

诊断使用与主进程相同的 partition，读到的是同一套登录态，结论可信。

### 登录态持久化与自动检查

登录态存在 `persist:torra-<modelId>` 分区，**重启后自动恢复，无需重复登录**。
启动流程：

1. 预热各分区的后台 WebView（按分区恢复会话）
2. 等各实例 `did-finish-load` + SPA 挂载延迟后探测真实登录态
3. 已登录的分区**强制 flushStorageData** 一次（修复历史遗留的未落盘凭据）
4. 一次性汇报盘点结果：`已恢复 N/M` + 需重登的站点清单

两个关键机制（缺一个就会出现「重启又要重登」）：

| 时机 | 动作 | 原因 |
| --- | --- | --- |
| 登录判定为成功时 | `flushStorageData()` | Chromium cookie 走延迟写缓冲，不主动刷会随进程退出丢失 |
| 应用退出前 | `before-quit` 里 `flushStorageData()` | 同上；必须在 `window-all-closed` 之后拦住，否则缓冲随进程消失 |

自检与排查命令：

```bash
npm run list:cookies              # 列出各分区 cookie（仅名称/域/过期，不输出值）
npm run domcheck chatgpt          # 加载页面直接读 DOM 判断登录态（最可靠）
npm run snapshot:partition deepseek-web
npm run verify:flush              # 验证刷盘链路（写入探针 cookie → flush → 重读）
```

> **诊断脚本必须显式设置 userData**：`app.setPath('userData', .../Roaming/torra)`。
> 否则 `electron scripts/xxx.js` 会落到 `Roaming/Electron`（Electron 默认名），
> 读到的是另一套空分区，结论完全无效 —— 这个坑曾导致误判「登录态已丢失」。


### 状态灯颜色含义

左栏头像右下角的圆点反映该通道的**真实可用性**，启动后与登录完成后各探测一次：

| 颜色 | 状态 | 含义与处置 |
| --- | --- | --- |
| 绿 | 就绪 | 页面已加载且输入框存在，可以发言 |
| 橙 | 发言中 | 正在生成 |
| 红 | 会话过期 | **该分区未登录**，点头像在 Torra 内重新登录 |
| 红 | 适配器失效 | 已登录但选择器失效 —— 站点改版了，需更新 YAML |
| 灰 | 已禁用 / 未配置 | api 型表示**没配 API Key**（不是登录问题）|

红点统一表示「不可用」，两种成因靠悬停提示区分 —— 都先别用它，
但一个要重新登录、一个要改选择器。

> **状态灯必须在登录窗口关闭后才更新。** 登录窗口与后台实例是两个独立
> WebContents：后台实例在登录前就加载完了页面，不会因另一个实例写入 cookie
> 而自行重渲染。Torra 在登录窗口关闭时会自动 reload 后台实例并复核状态；
> 若状态仍不对，点提示条上的「刷新状态」手动复核。
>
> 登录态保存在 `persist:torra-<modelId>` 独立分区，与日常浏览器完全隔离。
> 在 Chrome 登录 DeepSeek 对 Torra 无效 —— 必须点左栏头像，在 Torra 内登录。

> ⚠️ **合规前提**：驱动网页版 LLM 可能触发平台风控甚至封号。Torra 不提供任何规避验证码
> 或风控的手段，检测到人机验证时立即停下并引导用户手动接管。首次启动会展示风险确认墙。
> 接入新站点前请确认其服务条款对自动化访问的态度。

---

## 安装陷阱

**npmmirror 镜像下 optionalDependencies 的平台包不会自动安装**，需手动补：

```bash
npm install --save-dev @esbuild/win32-x64 @rollup/rollup-win32-x64
```

Electron 二进制未下载时：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

**启动报 `Cannot read properties of undefined (reading 'isPackaged')`**：
环境里存在 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 退化成纯 Node 运行时。
启动前 `unset ELECTRON_RUN_AS_NODE`。

---

## M1 状态

| 出口标准 | 状态 |
| --- | --- |
| 核心不变量自测 20 项 | ✅ 通过 |
| TypeScript 类型检查（主进程 + 渲染层） | ✅ 通过 |
| 构建产物完整 | ✅ 通过 |
| 界面三区渲染 + 零控制台错误 | ✅ 通过 |
| ChatGPT 单站点连续 20 轮成功率 ≥ 95% | ⬜ 待人工验证（需真实登录） |
| 单轮端到端 ≤ 60s | ⬜ 待人工验证 |
| 会话重启后登录态保持 | ⬜ 待人工验证 |

> 后三项需要真实登录各站点后手工验证，未在无凭据环境下自动执行。
> 这三项是 M1 的形态假设闸门——若 ChatGPT 单站点成功率无法达到 95%，
> 应触发形态复审（API-first 降级方案），而非继续推进 M2。

---

## 人工介入（PRD 5.5）

讨论进行中，用户可随时插手。**介入是一等公民**，不是普通上下文：

| 动作 | 入口 | 语义 |
| --- | --- | --- |
| **插话** | 底部面板 → 插话 | 内容进入下一批次所有（或指定）模型的上下文 |
| **定向追问** | 发言卡「追问此点」 | 指定模型针对某条发言再答一轮，插为下一批次首个发言 |
| **要求对辩** | 发言卡「就此对辩」 | 两个模型就某议题点追加专项轮次，**突破 maxRounds 上限**，不计入收敛度判定 |
| **调整立场** | 底部面板 → 调立场 | 中途改某模型立场，下一轮生效；webview 通道会写进 user prompt |
| **暂停 / 继续** | 底部面板 → 暂停 | 当前批次结束后暂停，可继续 |
| **终止并出报告** | 标题栏 | 立即结束并生成部分完成报告 |

### 三条设计约束

1. **介入不被稀释**：介入内容以独立区块 `【人类参与者介入】` 注入 prompt，
   **不进 `explored`** —— 否则会被摘要器当成"已排除方向"而淡化掉。
2. **人类发言不计入共识度**：人的表态不是模型共识的组成部分。`modelUtterancesOnly()`
   在核算前过滤掉人类与缺席发言；报告中单列一章并显式说明这一点。
3. **缺席目标不静默丢弃**：定向插话/追问的目标模型若已失效，
   介入记录会被标记 `cancelled` 并写明原因，而不是悄悄消失。

介入全记录持久化在会话中，报告的「四、人类参与者的介入与影响」章节逐条列出，
可完整追溯"谁在什么时候干预了什么"。

---

## 重试已结束的议题（PRD 7.2 / F6）

标题栏「历史」进入历史页，展示**全部**会话（含中止与失败——它们最需要重试）。
每条会话显示状态、轮次、共识/分歧数、介入次数、费用、缺席模型。

### 四种重试语义

| 模式 | 保留什么 | 重跑什么 | 何时用 |
| --- | --- | --- | --- |
| **整场重跑** | 无 | 整场，从第 1 轮 | 换一批采样重来 |
| **带着上一轮结论继续** | 上一轮结论作为「已知前提」 | 整场，从第 1 轮 | 刚才那场没聊透 |
| **仅重跑缺席模型** | 已有轮次 + 已发言模型 | 仅缺席模型一轮 | 修正单点失败 |
| **就某个分歧点再辩** | 全部历史 | 专项对辩 | 深挖某条保留分歧 |

不可用的模式会置灰并说明原因（如「上一场无缺席模型」）。

### 核心约束：重试不得制造假共识

「带着上一轮结论继续」最容易出问题——直接把上一轮的结论当本轮共识，
就成了抄自己答案的假共识。因此：

1. 上一轮结论以 `【上一场讨论的已知前提】` **独立区块**注入，
   措辞明确要求「可以认可、可以反驳、也可以指出其局限，不要因为它们被列出就默认认同」；
2. 这些前提**不写入** `confirmed` / `open`，因此**不参与共识度核算**；
3. 有自测专门验证前提文本不伪装成「已确认共识」或「已排除方向」。

### 重试产生新会话，不覆盖原记录

原报告是决策依据，必须保留。重试会：
- 用原议题 + 原配置创建**新** `Topic`（`continue` 模式追加上一场报告摘要到背景材料）
- `dispute` 模式只让两个对辩方参与，`fill-missing` 模式只让缺席模型参与
- 在新会话上标注 `retryMode` 与 `retrySourceId`，历史页显示「重试」徽章
- 专项对辩不计入收敛度判定，报告中单列一章

### 不可执行的重试会被拒绝

`validateRetryPlan()` 在执行前拦截并给出可操作提示——
例如「上一场没有缺席模型，无需补跑。可改用『整场重跑』」，
避免用户等一个必然失败的过程。
