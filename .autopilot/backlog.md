# Backlog

> 评分口径：`ROI = (用户影响 I × 严重度 S × 修复确定性 C) / (改动成本 × 回归风险)`，各因子 1–5。
> 安全漏洞 / 数据丢失 / 崩溃类按流程规则强制置顶。

## 待处理（按 ROI 降序）

| ROI | 维度 | 问题 | 证据 | 预估成本 | 风险 |
|---|---|---|---|---|---|
| — | 效率性 | ⛔ 需人类授权后才能做：冷启动耗时与主/渲染进程内存峰值仍无实测数值。测量本身必须起真实 Electron + CDP，而 rules 第 9 条要求「优先最轻通道」、项目长期约束写明「别为此启动 Electron」。静态能采的都已采（vite 7.78s / index js 688.56 kB / css 178.48 kB / dist 体积）。证据：`.autopilot/metrics.json` 中 `cold_start_ms` / `memory_peak_mb` 为 null | 低 | 无 |
| 5.3 | 效率性 | `const s = useStore()` 无 selector，整棵 store 订阅：任一字段变化即全页重渲染（I3×S4×C4 / 3×3） | `src/renderer/App.tsx:94`、`src/renderer/components/ChatPage.tsx:141`；store 副本放大 `src/renderer/store.ts:543-615` | 中（两处页面消费面大） | 中 |
| 4.0 | 安全可靠性 | 第 6 轮闸门的登录例外是「整窗放行到应用内」：登录窗口里站点自己开的钓鱼窗仍会顶 Torra 外壳；交系统浏览器也只验协议不验 host（I2×S3×C3 / 2×2） | `src/main/webview/guards.ts` `popupDisposition` 只看 `loginWindow` 布尔；`src/main/webview/pool.ts` 登记处 | 中 | 中（收紧过头会挡掉多步 OAuth） |
| 3.3 | 可维护性/美观性 | styles.css 7536 行里有死规则与重复定义：`.utterance-card/.u-card/.msg-card` 无消费方，`.u-body` 定义三次，`:root` 重复，硬编码浅色 `#f7f6f3` 混在深色主题里（I2×S2×C5 / 3×2） | `src/renderer/styles.css:5500-5506`、`:938`/`:1107`/`:5704`、`:3863`、`:4212` | 中 | 中（并行会话同改样式） |
| 3.0 | 实用性 | 模型排序/停用入口散落在侧栏与页面内，未收口到设置页；与既定「配置收口设置页」约定不一致（I2×S3×C3 / 3×2） | `src/renderer/App.tsx:444-461`、`src/renderer/components/ModelRail.tsx:133-138`、`src/renderer/pages/SettingsPage.tsx:1449` | 中 | 中（并行会话正在改右栏/侧栏） |
| 3.0 | 实用性 | 没有「恢复默认值」出口：默认参数写死在 store 初始化里，用户改坏后无法回退（I2×S2×C3 / 2×2） | `src/renderer/store.ts:367-374` | 低 | 低 |
| 2.3 | 效率性 | 逐字流长列表无虚拟化、历史轮次不折叠：一场多模型长研讨后 DOM 节点线性增长（I3×S3×C3 / 4×3） | `src/renderer/components/ChatPage.tsx` 渲染循环（无虚拟化窗口） | 高 | 中 |
| 1.3 | 安全可靠性 | favicon 抓取上游是 6 个第三方 CDN/公开服务，与「禁止联网第三方取配置」红线冲突。需人类决定是本地内置图标还是保留（擅自改会让模型卡片图标全灭）（I2×S3×C2 / 3×3） | `src/main/net/favicon-cache.ts:14-21`、`:86-97`；`src/renderer/components/ModelRail.tsx:43-48`；CSP 白名单 `src/renderer/index.html:8` | 高 | 高 |
| 1.1 | 完备性 | 会话/聊天历史存 renderer localStorage，其余状态走主进程持久化，两套口径并存（重启丢失面不同、迁移难做）（I2×S3×C3 / 4×4） | `src/renderer/components/ChatPage.tsx:255-279` + `src/renderer/chatPersistence.ts` vs 主进程 store 持久化 | 高 | 高（涉用户数据迁移，须幂等可回退） |

## 失败记录（≥2 次失败则跳过）

| 维度 | 尝试方案 | 失败原因 | 次数 |
|---|---|---|---|
| — | — | 首轮无失败记录 | 0 |

## 已完成

| 轮次 | 维度 | 改动 |
|---|---|---|
| 1 | 安全可靠性/可维护性（基线修复，仅测试侧） | 修复 HEAD 上「假绿基线」：`npm test` 用 `&&` 串 20 套件，`test:orchestrator-e2e` 单条断言失败导致后 16 套件从未执行却被误判为通过。根因是署名轨标签口径迁移（`src/shared/anonymity.ts:69-79` 已改为纯显示名）而 e2e 夹具没接 `nameOf`。补 `nameOf` 接线并更新过时断言，未触碰业务代码；20 套件 0 失败（648 条通过断言） |
| 2 | 安全可靠性 | ROI 18.8 项已做：`assistant:open-session` 补上会话归属校验并纠正动作顺序 —— `assertOwnSessionFile` 从 `src/main/assistant/sessions.ts:48-56` 导出，桥接层 `bridge.ts` 在 `dropPendingApprovals`/`clearSessionScoped`/`assistant.dispose()` 之前先验路径，越界与非 `.jsonl` 直接带原因返回；`target` 改存 `path.resolve` 后的绝对路径。关闭的攻击面：渲染层传来的任意路径不再直达 `SessionManager.open`，一次误点或构造参数也不再连带丢掉审批队列、工作目录、读取授权与当前模式。新用例「切换会话：越界路径挡在校验这一关，拒绝也不许拆掉正在用的工作状态」，bridge 套件 54 → 55，全链 20 套件 0 失败 |
| 3 | 安全可靠性 | ROI 15.0 项已做：`@` 引用的隐藏目录闸门从「只看路径首段」改成「按解析后的位置逐段查，并对着 realpath 再查一次」。`src/main/assistant/atrefs.ts` 新增 `hiddenSegment`/`hiddenHit`，`expandAt` 与 `listAt` 两条通道共用；名单为空（人亲手挑的项目目录）时判定整体短路，一个字都不改变。关闭的攻击面：`notes/../keys/x.bin` 这类首段无害、解析后落进凭据目录的绕路不再可读；指向 `keys` 的链接/接合点按真实落点拦截；`pi/skills/keys/deep.bin` 这类更深的同名目录同样挡（原先只看第一层，读得到却说不清为什么被挡）；候选列表不再把隐藏目录内的文件名交出去。不拦「真实落点在根之外」的链接 —— 那是导入技能的既有设计（`scripts/test-assistant-plugin-host.ts:146`）。新用例「@ 闸门：隐藏目录按解析后的位置逐段挡，.. 绕路和指向它的链接都不给读」，bridge 套件 55 → 56，全链 20 套件 0 失败 |
| 4 | 实用性（崩溃面） | ROI 12.0 项已做：渲染层补上兜底边界，白屏改为可读的一行崩溃说明 + 两个出口。`src/renderer/main.tsx` 把 `RenderGuard` 包在 `StrictMode` 之外（装配阶段抛错也接得住）；新增 `src/renderer/components/RenderGuard.tsx`（`getDerivedStateFromError` 切兜底、`componentDidCatch` 走 `console.error` 留完整堆栈、「重试这一屏」只重置自己、「重新载入应用」走 `window.location.reload()`）；新增 `src/renderer/renderError.ts` 纯函数层把任何被抛出的值（Error/字符串/undefined/普通对象/循环引用）归一成一行人话，剥掉主机名只留 `文件:行:列`，超 180 字截断；5 秒窗口内连崩 3 次自动判定「重试没用」，界面转劝 reload。样式 `.render-guard` 段只用文档流 + 既有 `.btn`/`.muted` + CSS 变量，无新盒子、无新彩色。关闭的崩溃面：任一 `useEffect`/渲染函数抛错不再把 `#root` 卸成一片白。新套件 `scripts/test-render-guard.ts` 8 条用例并挂入 `npm test` 链（20 → 21 套件），全链 0 失败（682 条断言） |
| 5 | 效率性 | ROI 10.0 项已做：聊天落盘不再跟着 token 走。`src/renderer/chatPersistence.ts`（新增 62 行）把「变化」与「写盘」分开 —— `schedule()` 只留最新快照，`flush()` 补写；写盘最多每 320ms 一次（用的是速率闸门而非纯防抖，所以无限流也照样每 320ms 落一次，丢帧窗口有上限）。`ChatPage.tsx:255-279` 接线：`useMemo` 建落盘器，`useEffect` 里 `schedule(chats)`，另在 `beforeunload`/`visibilitychange`/卸载清理三处补 `flush()`；读路径 `localStorage.getItem(STORE_KEY)` 与 key 一字未动，try/catch 静默保持原样。关掉的成本：82,273 字节夹具下 2000 次 token 级变化，主线程 stringify+写盘 372.0ms → 0.3ms，落盘字节量 164,546,000 → 82,273。新套件 `scripts/test-chat-persistence.ts` 10 条用例并挂入 `npm test` 链（21 → 22 套件），全链 0 失败（692 条断言） |
| 6 | 安全可靠性 | ROI 8.0 项已做：给内嵌站点装上权限与弹窗两道闸门。`src/main/webview/guards.ts`（新增纯函数层，不 import electron）负责判定：`isHttpUrl` 只认 http/https（`javascript:`/`data:`/`blob:`/`file:`/`about:`/`//host` 一律不算）、`popupDisposition` 按来源分三档（登录窗口→应用内、其余站点→系统浏览器、非 http(s)→整体挡掉）、`denyNote`/`popupNote` 只落主机名不留 query。`src/main/index.ts:1814-1877` 的 `hardenEmbeddedContents()` 在 `app.on('web-contents-created')` 上登记，模块顶层调用早于 `app.whenReady()`，因此第一枚窗口就带闸门，`window.open` 由 Electron 自己造出来的子窗也不例外：权限 handler 挂在 `contents.session` 上（Electron 里这两个 API 属于 Session 而非 WebContents）并按 session 去重，`setPermissionCheckHandler(() => false)` + `setPermissionRequestHandler(... callback(false))` 恒拒；`setWindowOpenHandler` 拒应用内开窗，http(s) 交 `shell.openExternal`。`src/main/webview/pool.ts` 的 `openLoginWindow` 是唯一例外，用 `webContents.id` 登记、`closed` 时撤销。关闭的攻击面：Electron 官方文档写明「未自定义 handler 时权限请求一律自动批准」，此前任一站点可静默取得通知/麦克风/摄像头/地理位置且无用户出口；此前 `window.open` 会在应用内开子窗并复用同一 `persist:` 分区（仿冒页可顶着 Torra 外壳带用户登录态显示）。拒绝与放行都写 `diag.log`（layer `runtime`，stage `permission-deny`/`popup-*`）。新套件 `scripts/test-webview-guards.ts` 11 条用例并挂入 `npm test` 链（22 → 23 套件），全链 0 失败（703 条断言） |
| 7 | 效率性 | ROI 6.0 项已做：Markdown 渲染不再跟着 token 重解析。`src/renderer/components/Markdown.tsx` 把 `Markdown`/`MarkdownInline` 包进 `React.memo`（消费方只传 `text` 字符串，按值比较，跳过成立），并把写在 JSX 里的 `remarkPlugins={[remarkGfm]}`、`allowedElements={[...INLINE_ONLY]}` 提到模块级常量 `REMARK_PLUGINS`/`INLINE_ALLOWED` —— 字面量数组每次渲染都是新对象，会让「配置没变」被误判成「配置变了」，memo 白加。输出零变化：5 个夹具（标题/列表/嵌套列表/引用、带 query 的链接与裸 `<script>`、GFM 表格对齐、代码块 language 类、行内白名单）的 HTML 与改动前逐字节相同（金标准由 `--emit-golden` 在改动前抓取）；链接仍带 `target=_blank rel=noopener noreferrer`，原始 HTML 仍转义成 `&lt;script&gt;`。实测口径：SSR 里看不到 memo 跳过，所以套件测「单次解析成本」再乘「解析次数下降」—— 300 次解析 434ms → 单次 1.447ms；场景 24 个模型单元格 × 2000 token 级重渲染，解析工作量 69,440ms → 2,893ms（约 −95.8%）。新套件 `scripts/test-markdown-memo.ts` 10 条用例并挂入 `npm test` 链（23 → 24 套件），全链 0 失败（713 条断言） |
