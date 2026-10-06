# Backlog

> 评分口径：`ROI = (用户影响 I × 严重度 S × 修复确定性 C) / (改动成本 × 回归风险)`，各因子 1–5。
> 安全漏洞 / 数据丢失 / 崩溃类按流程规则强制置顶。

## 待处理（按 ROI 降序）

| ROI | 维度 | 问题 | 证据 | 预估成本 | 风险 |
|---|---|---|---|---|---|
| 18.8 | 安全可靠性 | `assistant:open-session` 直接按传入文件名打开会话，未做归属校验 —— 同文件的 delete/read 都走了 `assertOwnSessionFile`，唯独 open 这条没有；IPC 一旦参数被构造，可读到非本会话前缀的会话文件（I3×S5×C5 / 2×2） | `src/main/assistant/bridge.ts:1227` → `:942-956`（无校验）；对照 `src/main/sessions.ts:48-53 assertOwnSessionFile` 与 `:241-242 SessionManager.open(file)` | 低（1 文件 + 1 用例） | 低 |
| 15.0 | 安全可靠性 | `expandAt` 的隐藏目录闸门只看路径首段：`sub/../keys/x.bin` 绕过；符号链接未拦（无 realpath/lstat），`keys/` 内凭据可被 @ 引用直读盘读出（I3×S5×C4 / 2×2） | `src/main/assistant/atrefs.ts:51-55`（`hiddenFirst`）用于 `:159`；默认隐藏项 `src/main/assistant/bridge.ts:95 DEFAULT_AT_HIDDEN = ['keys']`，`:303` 仅对兜底根生效 | 低（1 文件 + 用例扩展） | 中（误拦正常相对路径） |
| 12.0 | 实用性（崩溃面） | 渲染层无 ErrorBoundary：任一 `useEffect` 抛错直接把 `#root` 卸掉 → 白屏，用户零反馈、零恢复入口（崩溃类强制优先）（I3×S4×C4 / 2×2） | `src/renderer/main.tsx:11`（无 boundary）；项目记忆「白屏的定位办法」：`#root.childElementCount` + `window.__errs` 只能事后靠 CDP 诊断 | 低（1 文件 + SSR/用例） | 低 |
| 10.0 | 效率性 | 逐字流每个 token 触发一次全量 `localStorage.setItem(JSON.stringify(chats))`：长会话 O(n²) 主线程写入（I3×S4×C5 / 2×3） | `src/renderer/pages/ChatPage.tsx:254-260`；对照已存在的正确写法 `src/renderer/layout.ts:40-51`（320ms 防抖） | 低 | 中（刷新/退出时丢最后一帧） |
| 8.0 | 安全可靠性 | webview 池未设 `setPermissionRequestHandler` / `setWindowOpenHandler`：站点可请求通知/麦克风/地理定位，`window.open` 无拦截（I2×S5×C4 / 2×2.5） | `src/main/webview/pool.ts:151`、`:280`、`:481` 创建视图处；全 `src/main` 无这两类 handler | 低 | 低 |
| 8.0 | 效率性 | 冷启动耗时与主/渲染进程内存峰值仍无实测数值，性能维度只能靠静态证据打分（I2×S2×C4 / 2×1） | `.autopilot/metrics.json` 中 `cold_start_ms` / `memory_peak_mb` 为 null；需真实 Electron + CDP 口径 | 低 | 无 |
| 6.0 | 效率性 | `Markdown` 组件每次渲染都重走 `ReactMarkdown` 解析，逐字流场景每 token 重解析（I2×S3×C4 / 2×2） | `src/renderer/components/Markdown.tsx:14-22`（无 memo/无缓存） | 低 | 低 |
| 5.3 | 效率性 | `const s = useStore()` 无 selector，整棵 store 订阅：任一字段变化即全页重渲染（I3×S4×C4 / 3×3） | `src/renderer/App.tsx:94`、`src/renderer/pages/ChatPage.tsx:140`；store 副本放大 `src/renderer/store.ts:543-615` | 中（两处页面消费面大） | 中 |
| 3.3 | 可维护性/美观性 | styles.css 7528 行里有死规则与重复定义：`.utterance-card/.u-card/.msg-card` 无消费方，`.u-body` 定义三次，`:root` 重复，硬编码浅色 `#f7f6f3` 混在深色主题里（I2×S2×C5 / 3×2） | `src/renderer/styles.css:5500-5506`、`:938`/`:1107`/`:5704`、`:3863`、`:4212` | 中 | 中（并行会话同改样式） |
| 3.0 | 实用性 | 模型排序/停用入口散落在侧栏与页面内，未收口到设置页；与既定「配置收口设置页」约定不一致（I2×S3×C3 / 3×2） | `src/renderer/App.tsx:444-461`、`src/renderer/components/ModelRail.tsx:133-138`、`src/renderer/pages/SettingsPage.tsx:1449` | 中 | 中（并行会话正在改右栏/侧栏） |
| 3.0 | 实用性 | 没有「恢复默认值」出口：默认参数写死在 store 初始化里，用户改坏后无法回退（I2×S2×C3 / 2×2） | `src/renderer/store.ts:367-374` | 低 | 低 |
| 2.3 | 效率性 | 逐字流长列表无虚拟化、历史轮次不折叠：一场多模型长研讨后 DOM 节点线性增长（I3×S3×C3 / 4×3） | `src/renderer/pages/ChatPage.tsx` 渲染循环（无虚拟化窗口） | 高 | 中 |
| 1.3 | 安全可靠性 | favicon 抓取上游是 6 个第三方 CDN/公开服务，与「禁止联网第三方取配置」红线冲突。需人类决定是本地内置图标还是保留（擅自改会让模型卡片图标全灭）（I2×S3×C2 / 3×3） | `src/main/net/favicon-cache.ts:14-21`、`:86-97`；`src/renderer/components/ModelRail.tsx:43-48`；CSP 白名单 `src/renderer/index.html:8` | 高 | 高 |
| 1.1 | 完备性 | 会话/聊天历史存 renderer localStorage，其余状态走主进程持久化，两套口径并存（重启丢失面不同、迁移难做）（I2×S3×C3 / 4×4） | `src/renderer/pages/ChatPage.tsx:254-260` vs 主进程 store 持久化 | 高 | 高（涉用户数据迁移，须幂等可回退） |

## 失败记录（≥2 次失败则跳过）

| 维度 | 尝试方案 | 失败原因 | 次数 |
|---|---|---|---|
| — | — | 首轮无失败记录 | 0 |

## 已完成

| 轮次 | 维度 | 改动 |
|---|---|---|
| 1 | 安全可靠性/可维护性（基线修复，仅测试侧） | 修复 HEAD 上「假绿基线」：`npm test` 用 `&&` 串 20 套件，`test:orchestrator-e2e` 单条断言失败导致后 16 套件从未执行却被误判为通过。根因是署名轨标签口径迁移（`src/shared/anonymity.ts:69-79` 已改为纯显示名）而 e2e 夹具没接 `nameOf`。补 `nameOf` 接线并更新过时断言，未触碰业务代码；20 套件 0 失败（648 条通过断言） |
