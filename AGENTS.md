# Torra Agent Guide

这一页只放每次会话都需要、且会改变判断的东西。实现细节与它的推理都在 `docs/` 里：
这里出现的每个名字都不等于它的全部规则，找不到细节就去 `docs/`，不要靠猜补写。

## 命令

`npm run dev` 热重载（vite + tsc watch + Electron）· `npm run build` 三层构建 ·
`npm start` 构建并启动 · `npm run typecheck` 两份 tsconfig（main / renderer）都过一遍，
类型错先修再提交 · `npm test` 跑 `package.json` 里全部 `test:` 套件（CI 跑的是同一条）。

平时单跑一块就够：`test:plugins`（插件内核）· `test:acp`（ACP 层，离线不花钱）·
`test:contrast`（研究面板墨色对比）· `test:css-dead-rules`（面板样式 leftovers）。
`test:acp -- --live-full --write-matrix` 会发真 prompt，**花用户的额度，先问**。
webview 通道出问题时从 `diagnose:webview <站点>` 和 `list:cookies` 起手。

## 不许越的线

**Torra 从不安装任何东西**。「装了」只有唯一含义：启动命令在 PATH 上；
不在就把那条确切的安装命令交给用户跑。不做代码注入与 eval，不绕登录墙与 CAPTCHA，
尊重平台条款。凭据只进系统钥匙串，绝不写进配置、日志或备份包。

Torra 只说 ACP，不实现任何一家 agent，也没有 per-agent shim。
`src/shared/host.ts` 是任何 harness 协议与 UI 之间唯一一套词（`HostEvent` + 唯一一份归约
`applyHostEvent` + 续聊结论 `judgeResume`），主进程与渲染层共用那一份归约，
渲染层永远看不到裸 ACP payload。一轮能持久，前提是 harness 交出它自己的原生 key，
位置型 key 一律拒；回放读回非空正文时本地正文要删干净（记录降级成只有索引
`harnessOwned`），防抖保存必须查这个 flag，否则第二个真源会悄悄回来。

## 会改变判断的封闭集合

agent 状态只有 `ready` / `busy` / `expired` / `adapter-broken` / `disabled` / `absent`
（`src/shared/types.ts`），适配器失败要显式接住并报 `adapter-broken`。

面板的一个 `<style>` 里是两个 register：深色规则在前，后写的 `:root` 浅色靠源码序胜出 ——
往一处加的规则必须在另一处镜像或显式覆盖，`test:css-dead-rules` 捞不到漏写的那一半。

工作树是台账（HostItem）的投影，不是第二个存储；光线全项目只有一套（`lancerLight.ts`），
不经 React 渲染。编码工作台是导航区，不是抽屉。

主进程构建是 CommonJS：启动路径碰 ESM-only 依赖会在启动时 ERR_REQUIRE_ESM 死掉，
需要 ESM 的东西属于 `utilityProcess`（ACP 那条路由测试扫 import 闭包守着）。

## 会让排查浪费几小时的

浏览器里登录**不会**影响 Torra 的登录态：登录态在 `persist:torra-<id>` 分区里，
只认 Torra 自己的登录窗。

CDP 量几何或截图之前必须先把 OS 窗口抬起来（`setAlwaysOnTop(true, 'screen-saver')` + show/focus）：
`Page.bringToFront` 不抬窗口，否则每个量都读成 0，看上去像改版做坏了。

## 代码在哪

这一页只列到顶层，逐目录与逐文件的含义看 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ——
在这里抄第二份就会错第二份。

`src/main/`（编排、插件内核、内置助手、ACP 客户端、store）· `src/preload/` ·
`src/renderer/`（含编码工作台与工作树）· `src/shared/`（不变量与那一套词）·
`adapters/`（站点 YAML）· `plugins/`（内置插件 research / tech）· `scripts/`（自测与冒烟）· `docs/`。

## 细节在哪

ACP 边界、catalog 与「从不安装」、矩阵、身份闸与回放的完整规则：[docs/ACP-NOTES.md](docs/ACP-NOTES.md)。
插件内核与权限、面板样式 token、工作树与光线、智能体外观、技能标签：
[docs/PLUGIN-UI-NOTES.md](docs/PLUGIN-UI-NOTES.md)。
各功能的产品叙述：[docs/FEATURES.md](docs/FEATURES.md)；适配器写法与校验报错：
[docs/ADAPTERS.md](docs/ADAPTERS.md)；常用命令、热更新、CDP 实测与发布流程：[docs/DEV.md](docs/DEV.md)。
