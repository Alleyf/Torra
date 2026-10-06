# 开发指南

> 从 README 迁入。面向改代码的人;使用者看根 README 即可。

## 常用命令

```bash
npm run dev                 # 开发模式：vite + tsc watch + Electron，一条命令全起
npm run build               # 构建主进程 + preload + 渲染层
npm start                   # 构建并启动
npm run typecheck           # 两段 TypeScript 类型检查
npm test                    # 全量自测链（19 个脚本，CI 同口径）
npm run test:invariants     # 核心不变量自测（36 项）
npm run smoke               # 运行时界面冒烟测试 + 截图
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
