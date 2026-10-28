# 开发指南

> 从 README 迁入。面向改代码的人;使用者看根 README 即可。

## 常用命令

```bash
npm run dev                 # 开发模式：vite + tsc watch + Electron，一条命令全起
npm run build               # 构建主进程 + preload + 渲染层
npm start                   # 构建并启动
npm run typecheck           # 两段 TypeScript 类型检查
npm test                    # 全量自测链（38 套件 / 1000+ 断言，CI 同口径）
npm run test:invariants     # 核心不变量自测（36 项）
npm run smoke               # 运行时界面冒烟测试 + 截图
npm run shots               # 只重拍 README「界面」那三张：跑同一条冒烟流程，断言照跑
npm run doctor              # 八层体检 + 流水线日志
npm run dist                # electron-builder 打 Windows 安装包
npm run diagnose:webview chatgpt   # 只读诊断某站点分区实际加载了什么
npm run verify:inject             # 在真实分区回归验证注入脚本判定
```

## 热更新的两层结构

`npm run dev` 的热更新分两层：改**渲染层**（`src/renderer`）由 vite HMR 即时生效；
改**主进程 / preload**（`src/main`、`src/preload`）由 `tsc --watch` 增量编译，编译通过后自动重启 Electron
窗口——网页版登录态存在 `persist:` 分区里，重启不丢。dev server 端口从 5273 起自动顺延找空闲口，
再经 `TORRA_DEV_PORT` 交给主进程，两端不会串（同机开多个会话时各用各的端口）。

## 用 CDP 驱动界面实测的坑

给原生墙做「真的按住鼠标拖一条缝」这类实测时，探针要认两件事：

**指针事件必须走 `Input.dispatchMouseEvent`，不能用 `dispatchEvent` 造。** 拖拽那里调
`setPointerCapture(pointerId)`，合成 PointerEvent 的 pointerId 在主进程之外不存在，直接抛
NotFoundError，于是拖拽在第一步就断，测出来的「拖不动」是测试自己的假阳性。

**窗口被最小化或整面遮挡时，`visibilityState` 是 hidden，Chromium 会把派发的鼠标事件攒起来不投递。**
症状最难认：`Runtime.evaluate` 全绿、DOM 探针答得头头是道，界却一句话都不动，看起来像把手坏了。
发事件前先补一句 `Page.setWebLifecycleState {state:'active'}`，再用 `document.visibilityState`
确认已经是 visible —— 这一步只影响测试车，不是产品行为。

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

## 发布

推 `v*` tag 即触发 CI：typecheck → 全量测试 → electron-builder 打包 →
自动创建 GitHub Release 并上传安装包与 SHA256SUMS（见 `.github/workflows/build.yml`）。
tag 从它指向的 commit 构建——先确认要发布的代码都已提交，再打 tag。

同一个 commit 只要既在 main 上又被打上 tag，就会起两条并发流水线，于是「tag 那条红了、main 那条全绿」
是能同时出现的两行事实。这时先怀疑机器而不是代码：两次跑的是同一份工作树、同一个 workflow，
差异只可能来自 runner 的速度与抢占（本地 `npm test` 全绿而 CI 单条红，就是这个形状）。
分辨它只要一次 Re-run failed jobs —— 注意重跑读的还是 tag 那个 commit 里的 `build.yml`，
之后推上 main 的诊断改动不会参与这一跑。

红的时候先看 Annotations，别看日志：job 原始日志与 step summary 对未登录访客是 403 和空白
（`actions/jobs/{id}/logs` 匿名访问实测 403，公开 check-runs 里的 `output.summary` 是空字符串），
而 Annotations 匿名页面就能读。所以 `Surface test failure tail` 那一步会把红在哪一套件、
那套件里红了哪条断言，逐条以 `::error::` 发出来；测试本身没红时它发 `::notice::`，
免得「套件 43/43 通过」挂成一条假 error 把人引去翻测试日志。

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
>
> **补测规程（PRD 13 章 V1.1）**：登录各站点后，对 7 个内置适配器逐一执行 20 轮
> 自动键入 + 抓取（可用 `npm run smoke` 的固定装置口径），记录每站成功率与失败原因分类
> （登录失效 / 选择器丢失 / 流式抓取失败 / 超时），结果回填上表。这是产品最核心的赌注，
> 必须用数字而非体感结算。
