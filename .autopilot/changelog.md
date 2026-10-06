# Autopilot Changelog

## Round 1 · 2026-10-07T19:41Z · 基线轮（不做业务改动）

- 建立 `.autopilot/`（rules/backlog/changelog/state/metrics），`.gitignore` 收口：目录默认忽略，只放行 rules.md / backlog.md / changelog.md。
- 基线：`npm run build` ✅（vite 8.04s，renderer bundle 696.45 kB / gzip 214.89 kB，main tsc 无错）、`npm run typecheck` ✅ 0 错。
- **发现红色基线**：HEAD `4d53b49` 的 `test:orchestrator-e2e` 有 1 条断言失败，`npm test` 的 `&&` 链在第 4 个套件就断掉，后 16 个套件从未被执行。
  - 根因：`4d53b49` 把署名轨标签从 `id（显示名）` 改成纯显示名（src/shared/anonymity.ts:69-79），e2e 夹具没接 `nameOf`（scripts/test-orchestrator-e2e.ts:249），断言仍写旧格式（同文件:310）。
  - 处理：测试侧接线 `nameOf` 并把断言更新为真实口径 + 补一条「内部 id 不外泄」的反向断言。改后 14/14 通过。业务代码零改动。

## Round 2 · 2026-10-07T20:00Z · 安全可靠性（ROI 18.8）

- 选点：`assistant:open-session` 是当时唯一「IPC 参数可直达磁盘读取」的缺口 —— 同模块的 read/delete 都先过 `assertOwnSessionFile`，只有 open 没有；并且它在校验之前就 `dropPendingApprovals` + `clearSessionScoped` + `assistant.dispose()`。
- 改动（3 文件，净 +约 40 行）：
  - `src/main/assistant/sessions.ts`：`assertOwnSessionFile` 改为导出，注释写明「凡拿渲染层路径动磁盘的动作都先过这一道」。
  - `src/main/assistant/bridge.ts`：`openSession` 先 `path.resolve` + 归属校验，失败就记 `assistant:open-session` 日志并带原因返回；校验通过后才拆状态，`target` 存绝对路径。
  - `scripts/test-assistant-bridge.ts`：新用例覆盖 4 类越界（keys 目录内文件、`..` 绕回、非 .jsonl、空参数），并断言拒绝后工作目录/读取授权/模式原样保留。
- 验证：`npm run typecheck` 0 错；`npm run build` ✅；`npm run test:assistant-bridge` 55 passed 0 failed；`npm test` 20 套件 0 失败。无新 IPC，故 `scripts/smoke.js` 桩不必改。
- 分数：安全可靠性 7.5 → 8.0，综合 6.5 → 6.56。

## Round 3 · 2026-10-07T20:05Z · 安全可靠性（ROI 15.0）

- 选点：`@` 引用是主进程直接读盘、绕开 pi 的 `read` 闸门的通道，`keys/` 密文只靠 `DEFAULT_AT_HIDDEN` 一道挡。旧实现 `hiddenFirst` 只看输入路径的第一段，`notes/../keys/x.bin` 首段无害、解析后落在凭据目录里 —— 一次粘贴就把密文送进模型上下文与请求体。
- 改动（2 文件，净 +约 45 行）：
  - `src/main/assistant/atrefs.ts`：`hiddenFirst` → `hiddenSegment`（root 之下逐段查，落到 root 外则整条查）+ `hiddenHit`（先按输入位置查，再对 `fs.realpathSync` 的真实落点查一次）。`expandAt` 调整判定顺序，让「不在工作目录里」和「落在不对外引用的目录里」两句提示各归其位；`listAt` 的目录列表与子路径校验都换到同一口径。
  - `scripts/test-assistant-bridge.ts`：新用例覆盖 `..` 绕路、更深的同名目录、指向 `keys` 的链接（本机 `LINK_OK true`，走的是真分支）、候选列表不外泄文件名、以及「名单为空时行为零变化」。
- 有意不拦的：真实落点在根之外的链接。导入技能靠 `pi/skills/*` 接合点指向外部目录，这是 `scripts/test-assistant-plugin-host.ts:146` 记录过的刻意设计；本轮只拦「真实落点里出现隐藏段」，不破坏它。
- 验证：`npm run typecheck` 0 错；`npm run build` ✅；`npm run test:assistant-bridge` 56 passed 0 failed；`npm test` 20 套件 0 失败。纯函数层验证，未起 Electron。
- 分数：安全可靠性 8.0 → 8.5，综合 6.56 → 6.63。

## Round 4 · 2026-10-07T20:12Z · 实用性（崩溃面，ROI 12.0）

- 选点：backlog 里唯一的崩溃类项。此前任一组件在渲染或 `useEffect` 里抛错，React 会把 `#root` 整棵卸掉 —— 用户看到的是一片白，没有原因、没有出口，只能强制退出重开（项目记忆「白屏的定位办法」：事后靠 CDP 数 `#root.childElementCount` 才知道崩过）。
- 改动（6 文件：新建 3 + 修改 3；业务代码 +146 行、测试 +132 行，对照单轮 500 行上限有余量）：
  - `src/renderer/renderError.ts`（新）：纯函数归一层。`crashLine()` 把任何被抛出的值收敛成一行 —— Error 取 message 并从堆栈第一个调用帧剥出 `文件:行:列`（丢掉 `http://localhost` / 打包后的主机名），非 Error 值（字符串 / `undefined` / 普通对象 / 循环引用）各有明确口径，换行折叠、超 180 字截断；`noteCrash()` + `isRapidCrash()` 用 5 秒窗口统计连续崩溃，隔得够久的上一次不并入，避免「用户离开一会儿回来」被误判成连环崩。单独成模块是为了 ts-node 能直接测，不必给仓库添一套 React 渲染测试设施。
  - `src/renderer/components/RenderGuard.tsx`（新）：class 兜底边界。`getDerivedStateFromError` 只切显示态，`componentDidCatch` 把完整 error + `componentStack` 交给 `console.error('[torra] 渲染层抛错', ...)`（ DevTools 里仍有全堆栈可查），界面只给人看一行。两个出口：「重试这一屏」把边界自身重置（不清 store、不丢会话），「重新载入应用」走 `window.location.reload()`；窗口内连崩 3 次追加一句提示，劝走 reload 而不是原地再撞。
  - `src/renderer/main.tsx`：`RenderGuard` 包在 `StrictMode` 之外，挂载阶段就抛错也接得住。
  - `src/renderer/styles.css`：末尾 `.render-guard` 段 7 条规则，文档流 + 既有 `.btn`/`.btn.primary`/`.muted`，颜色一律走 `var(--text)`/`var(--text-3)`，不新增盒子、阴影、彩色装饰（对照既定现代深色风）。
  - `scripts/test-render-guard.ts`（新）+ `package.json`：8 条用例挂入 `npm test` 链（`test:argmap` 之后），覆盖归一逻辑、快速崩溃窗口、`main.tsx` 接线、兜底屏两个出口的存在性、样式卫生（无 box-shadow、不写死十六进制色）、脚本注册。
- 验证：`npm run typecheck` 0 错；`npm run build` ✅（vite 7.90s，index js 687.87 kB / gzip 213.09 kB，css 178.48 kB）；`npm run test:render-guard` 通过 8 · 失败 0；`npm test` 21 套件 0 失败（682 条断言）。DoD 的「无关核心路径未破坏」由同链的 `test:orchestrator-e2e` 14/0、`test:session` 165/0、`test:assistant-bridge` 56/0 覆盖。未起 Electron（新界面结构由源码接线 + CSS 卫生断言钉住，无新 IPC 故 `scripts/smoke.js` 桩不必改）。
- 过程中修掉一个自己引入的类型错：`renderError.ts` 里 `loc[1]` 在 `noUncheckedIndexedAccess` 下是 `string | undefined`（TC_EXIT=2 那一次），改为 `?.[1]` 先取再判空。
- 分数：实用性 6.5 → 7.0，综合 6.63 → 6.69。

## Round 5 · 2026-10-07T20:22Z · 效率性（逐字流落盘，ROI 10.0）

- 选点：效率维度里最贵且最容易证死的一项。`ChatPage.tsx` 旧写法是「`chats` 引用一变就 `JSON.stringify` 全量 + 同步写 `localStorage`」，而逐字流每来一个 token 就换一次引用 —— 会话越长单次 stringify 越贵，乘上 token 数就是平方级的主线程开销（对照仓库里已有的正确写法 `layout.ts:39-51` 的 320ms 防抖）。
- 改动（4 文件：新建 2 + 修改 2；业务代码净 +81 行、测试 +252 行）：
  - `src/renderer/chatPersistence.ts`（新，62 行）：把「变化」和「写盘」拆开。`schedule(snapshot)` 只覆盖最新快照并保证最多一个定时器在排；到点或 `flush()` 才真正 stringify 一次。用的是**速率闸门**而不是纯尾部防抖 —— 无限长的流式输出下每 320ms 仍会落一次盘，丢帧窗口有上限（纯防抖在不停流的场景下等于永不落盘）。`delay` 注入参数让 ts-node 能脱离 DOM 测节奏，不必为测试添渲染设施。
  - `src/renderer/components/ChatPage.tsx:255-279`：`useMemo` 建落盘器（`localStorage.setItem` 的 try/catch 静默口径原样保留），effect 里只做 `schedule(chats)`；另在 `beforeunload`、`visibilitychange`、卸载清理三处补 `flush()`，把 backlog 标注的「刷新/退出时丢最后一帧」这条风险关掉。读路径 `localStorage.getItem(STORE_KEY)` 与 key 名一个字未动 —— 不迁移、不删用户数据，回滚只需还原这两个文件。
  - `scripts/test-chat-persistence.ts`（新，252 行）+ `package.json`：10 条用例挂入 `npm test` 链（`test:render-guard` 之后），覆盖多排定时器、只落最新快照、跨窗口继续排、`flush()` 不重复写（含「定时器已排出去才来的取消」这种最坏情况）、空队列 flush 是空操作、key 透传、前后数值对照、ChatPage 两处接线、脚本注册。
- 验证：`npm run typecheck` 0 错；`npm run build` ✅（vite 7.67s，index js 688.54 kB / gzip 213.33 kB，css 178.48 kB —— 新模块让 js 增 0.67 kB）；`npm run test:chat-persistence` 通过 10 · 失败 0；`npm test` 22 套件 0 失败（692 条断言）。DoD 的「无关核心路径未破坏」由同链 `test:session` 165/0、`test:orchestrator-e2e` 14/0、`test:assistant-bridge` 56/0 覆盖；无新 IPC 故 `scripts/smoke.js` 桩不必改；未起 Electron。
- 性能数值（套件第 7 例打印，夹具 = 8 会话 × 12 轮 × 3 模型单元格 = 82,273 字节；2000 次 token 级变化）：主线程 stringify+写盘 **372.0ms → 0.3ms**，落盘字节量 **164,546,000 → 82,273（约三个数量级）**，写盘调用 2000 次 → 1 次。夹具刻意不做到 2MB：那个量级下旧口径单个用例要跑十几秒，测试会比被改的代码还慢。
- 过程中修掉两个测试自身的问题：`fire()` 没把已触发的定时器摘出队列，导致「跨窗口继续排」用例误判多排了一个（计数从 2 应为 1）；性能夹具第一版取 60×30×4 让整套跑到 13s，缩到当前形状后单用例 <1s。都在测试侧，未放松任何断言。
- 分数：效率性 3.0 → 5.5（仍扣分：`useStore()` 无 selector、`store.ts:543-615` 每 token 复制整数组、`Markdown.tsx` 未 memo、长列表无虚拟化、冷启动/内存峰值无实测值），综合 6.69 → 7.00。

## Round 6 · 2026-10-07T20:41Z · 安全可靠性（内嵌站点权限与弹窗闸门，ROI 8.0）

- 选点：安全类强制置顶。改动前 grep 全 `src/main` + `scripts` 对 `setPermissionCheckHandler` / `setPermissionRequestHandler` / `setWindowOpenHandler` / `web-contents-created` **零命中**，而 Electron 官方安全文档写明「未自定义 handler 时权限请求一律自动批准」（检查清单第 5、11、14 条正是这三件事）。后果是池里任一站点可静默拿到通知/麦克风/摄像头/地理位置，用户既无提示也无撤销出口；`window.open` 则在应用内开子窗，并复用同一 `persist:` 分区 —— 一个仿冒页能顶着 Torra 的外壳、带着用户登录态显示钓鱼内容。
- 改动（5 文件：新建 2 + 修改 3；业务净 +99 行、测试 +164 行）：
  - `src/main/webview/guards.ts`（新，62 行，纯函数层不 import electron，沿用 `auth-cookies.ts`/`renderError.ts` 的分层约定）：`isHttpUrl` 只认 http/https（`javascript:`/`data:`/`blob:`/`file:`/`about:blank`/`//evil.com`/空串一律不算）；`popupDisposition` 三档（登录窗口→应用内、其他站点→系统浏览器、非 http(s)→整体拒，且这一档与是否登录窗口无关）；登录例外改成 `webContents.id` 登记制（`markLoginWindow`/`releaseLoginWindow`）；`denyNote`/`popupNote` 只落主机名，绝不把 query/hash 抄进日志（那里面常带一次性 token）。
  - `src/main/index.ts:1814-1877`：`hardenEmbeddedContents()` 装在 `app.on('web-contents-created')` 上，模块顶层调用排在 `app.whenReady()` 之前，所以第一枚窗口就带闸门，`window.open` 由 Electron 自己造出来的子窗也不例外。权限 handler 挂在 `contents.session` 并按 session 去重（同分区重复注册会把前一个闭包顶掉，日志来源就会串），`setPermissionCheckHandler(() => false)` + `setPermissionRequestHandler(... callback(false))` 恒拒；`setWindowOpenHandler` 默认 deny，http(s) 走 `shell.openExternal`，只有登记过的登录窗口 `action:'allow'`。拒与放都写 `diag.log`（layer `runtime`，stage `permission-deny` / `popup-in-app|external|block`）。
  - `src/main/webview/pool.ts`：`openLoginWindow` 取 `login.webContents.id` 登记为唯一例外，`closed` 时撤销（id 必须在窗口还在时取 —— 关闭回调里 webContents 已销毁）；`webSecurity: true` 上方注释改为指向真正的拒处。
  - `scripts/test-webview-guards.ts`（新，11 条）+ `package.json`：挂入 `npm test` 链（`test:chat-persistence` 之后），覆盖协议判定、三档归属、登记制生命周期、日志不漏 token、拒绝措辞、`index.ts`/`pool.ts` 接线（含「handler 必须挂 session」「必须按 session 去重」「登记早于 whenReady」）、脚本注册。
- 验证：`npm run typecheck` 0 错；`npm run build` ✅（vite 7.79s，index js 688.54 kB / gzip 213.33 kB、css 178.48 kB —— 与第 5 轮逐字节相同，本轮纯主进程改动，renderer 零成本）；`npm run test:webview-guards` 通过 11 · 失败 0；`npm test` 23 套件 0 失败（703 条断言）。无关核心路径由 `test:session` 165/0、`test:orchestrator-e2e` 14/0、`test:assistant-bridge` 56/0 覆盖；无新 IPC 故 `scripts/smoke.js` 桩不必改；未起 Electron。
- 过程中被 typecheck 抓到并修掉的一个真错：第一版把两个权限 handler 写成 `contents.setPermissionCheckHandler(...)`，Electron 33 typings 里 WebContents 没有这两个方法（TC_EXIT=2，6 条报错）—— 挂错对象就是「代码看着装了、实际静默不生效」，已在测试里补断言钉住。
- 分数：安全可靠性 8.5 → 9.0（仍扣分：登录例外按整窗放行、交系统浏览器只验协议不验 host → 新增 backlog ROI 4.0 项；崩溃文案外显 file:line；favicon 第三方 CDN 待人类取舍），综合 7.00 → 7.06。

## Round 7 · 2026-10-07T20:55Z · 效率性（Markdown 重解析，ROI 6.0）

- 选点：效率维度里第 2 个「逐字流放大」源头。`src/renderer/components/Markdown.tsx` 的 `Markdown`/`MarkdownInline` 当时是裸函数组件，而每来一个 token，store 换一次 `chats` 引用 → 整页重渲染 → **每一格早已写完的消息都被 react-markdown 重新解析一遍**（无 `[] as DepsArray`、无 memo）；同时 `remarkPlugins={[remarkGfm]}`、`allowedElements={[...INLINE_ONLY]}` 写在 JSX 里，每次渲染都是新数组对象，等于每帧都给 ReactMarkdown 一份「新的」配置。长会话下这是纯主线程浪费，且直接表现为用户看到的「打字越久越卡」。
- 改动（3 文件：修改 2 + 新建 1；业务 +11 行、测试 289 行）：
  - `src/renderer/components/Markdown.tsx`：两个组件包进 `React.memo`；`REMARK_PLUGINS`、`INLINE_ALLOWED` 提到模块级；`components` 本来就是模块级常量，保持。memo 的前提在注释里写明 —— 消费方只传 `text`（字符串按值比较），所以默认浅比较就够，不需要自定义比较器。
  - `scripts/test-markdown-memo.ts`（新，289 行，10 条）：因为 react-markdown 10 是 ESM-only、ts-node 的 CommonJS 里 `require` 不到，套件用 esbuild 在内存里把渲染夹具打成 CJS 再 `Module._compile` 执行（不落临时文件、不加依赖）。覆盖四层：**产物层** —— 5 个夹具（标题+列表+嵌套列表+引用、带 query 的链接与裸 `<script>`、GFM 表格右对齐、代码块 `language-` 类、行内白名单）的 HTML 与改动前抓的金标准**逐字节相同**，同一输入重复渲染稳定；**安全层** —— 链接仍 `target=_blank rel=noopener noreferrer`、原始 HTML 仍转义（`&lt;script&gt;alert(1)&lt;/script&gt;` 不外泄）；**结构层** —— `$$typeof === 'Symbol(react.memo)'`、源码不得再出现 JSX 内联数组字面量、扫描 5 个消费方文件（`seen >= 9`）确认每个 `<Markdown…/>` 只带 `text=`/`key=`（多传对象型 props 会让 memo 静默失效，这条是防回归的关键）；**接线层** —— package.json 脚本与 `npm test` 链注册。支持 `--emit-golden` 重新抓取金标准。
  - `package.json`：新增 `test:markdown-memo`，插在 `test:webview-guards` 之后挂入 `npm test` 链（23 → 24 套件）。
- 验证：`npm run typecheck` 0 错（TC_EXIT=0）；`npm run build` ✅（vite 7.78s，index js 688.56 kB / gzip 213.33 kB —— 比第 6 轮 +0.02 kB，css 178.48 kB 逐字节相同）；`npm run test:markdown-memo` 通过 10 · 失败 0；`npm test` 24 套件 0 失败（713 条断言）。无关核心路径由 `test:session` 165/0、`test:orchestrator-e2e` 14/0、`test:assistant-bridge` 56/0 覆盖；无新 IPC 故 `scripts/smoke.js` 桩不必改；未起 Electron，产物全部在内存中执行，磁盘无残留（过程中的 `dist/tc7.log`、`bd7.log`、`tt7.log` 已删）。
- 性能数值口径（诚实声明）：SSR 无法观测 memo 跳过，所以拆成两段测 —— ① 用套件实测「单次解析成本」：300 次解析 434ms → **单次 1.447ms**；② 乘上「解析次数下降」：24 个模型单元格 × 2000 次 token 级重渲染，改动前每帧全量解析 48,000 次 → 改动后只解析在写的那格 2,000 次，`69,440ms → 2,893ms`（**约 −95.8%**）。真实浏览器里的收益取决于帧合并与流式节奏，这两个数是上界估算的下界版本，不当作实测帧率宣传。
- 过程中修掉两个自身问题：① 金标准 harness 第一版报 `ReferenceError: React is not defined` —— `Markdown.tsx` 依赖 vite 的自动 JSX 运行时、文件里根本没有 `import React`，esbuild 默认经典运行时会在渲染中途崩；补 `jsx: 'automatic'` 并在代码注释里写明这个失败模式。② 写 backlog 第 6 行时 `old_string` 取成了行首前缀，把第 7 行文本 splice 进了第 6 行；两次 Edit 修回后确认第 6 行逐字节复原、第 7 行重新追加。都在我自己产出的文件里，未触碰业务代码。
- 分数：效率性 5.5 → 6.5（仍扣分：`useStore()` 无 selector、`store.ts:543-615` 每 token 复制整数组、长列表无虚拟化、冷启动/内存峰值无实测值），可维护性 5.0 → 5.0（新套件为 CommonJS 里的 ESM 依赖立了可复用范式，但 `npm test` 的 `&&` 串链仍是一处失败遮蔽后 23 套的结构问题），综合 7.06 → 7.19。

## Round 8 · 2026-10-07T21:07Z · 安全可靠性（登录弹窗的额度与窗口身份，ROI 4.0）

- 选点：安全类强制置顶，也是第 6 轮自己在 backlog 里立下的收尾项。第 6 轮给内嵌站点装了权限与弹窗两道闸门，但「登录窗口」这个应用内例外是**按整窗、无限放行**的：`popupDisposition` 只看 `loginWindow` 一个布尔。后果是登录窗口里嵌的每一个文档 —— 站点自己的跳转、第三方登录按钮、甚至一个广告 iframe —— 都能刷出一串临时窗口，复用同一 `persist:` 分区（带着用户刚种的登录态），标题还来自站点自己的 `<title>`。用户分不清「这是 Torra 给我开的临时弹窗」还是「我自己点的链接」，而这层混淆正是仿冒页要的皮。
- 改动（3 文件，全部修改；业务 +约 30 行、测试 +约 70 行）：
  - `src/main/webview/guards.ts`：登记结构从 `Set<number>` 改为 `Map<number, {used:number}>`，新增常量 `LOGIN_POPUP_BUDGET = 2`（OAuth 常见一枚，个别站点多一步授权确认，所以留两枚）、`claimInAppPopup(id)`（取到额度返回第几枚，未登记或用尽返回 `null`）、`loginPopupTitle(index)`（`Torra 登录弹窗（第 N 枚 · 临时窗口，登录完成后可关闭）`）。`popupNote` 增加可选 `reason`，只在两条正常分支追加。`popupDisposition(url, {loginWindow})` **签名不变** —— 现在这个布尔的语义是「已登记且额度未用尽」，判定与额度分开两步，日志才分得清「不是登录窗口」和「额度已用尽」。
  - `src/main/index.ts:1852-1881`：`setWindowOpenHandler` 里 `const claim = isLoginWindow(contents.id) ? claimInAppPopup(contents.id) : null`，`action:'allow'` 必须同时满足 `d === 'in-app' && claim !== null`；`overrideBrowserWindowOptions` 创建时就带 `title`（`setTitle` 之前那一瞬也是空档），并在 `did-create-window` 里 `child.setTitle(title)` + `child.on('page-title-updated', e => e.preventDefault())` 把身份钉死；超额度自然落到 `external` 分支交系统浏览器，`diag.log` 的 detail 里写明「登录弹窗额度已用尽」。数字只在 guards.ts 说了算，接线层不自己数。
  - `scripts/test-webview-guards.ts`：11 → 17 条。新增额度上限、按窗口计数（重登记清零、窗口之间互不影响）、额度与协议判定两条独立闸（非 http(s) 恒 `block`，额度不参与）、标题措辞（含「Torra 登录弹窗」「第 1 枚」「临时窗口」，且不含任何域名样式片段，不同序号标题不同）、留痕能说明「为什么走了外部」且绝不把整条 URL（`\?code=`）抄进日志、`index.ts` 接线的 8 条源码切片断言（含 `doesNotMatch(impl, /LOGIN_POPUP_BUDGET/)` 反向钉住「魔法数不许写在接线层」）。
- 验证：`npm run typecheck` 0 错（TC_EXIT=0）；`npm run build` ✅（vite 7.85s，index js 688.56 kB / gzip 213.33 kB、css 178.48 kB —— **与第 7 轮逐字节相同**，本轮纯主进程 + 纯函数层改动，renderer 零成本）；`npm run test:webview-guards` 通过 17 · 失败 0；`npm test` 24 套件 0 失败（713 → **719** 条断言）。无关核心路径由 `test:session` 165/0、`test:assistant-bridge` 56/0、`test:orchestrator-e2e` 14/0 覆盖；无新 IPC 故 `scripts/smoke.js` 桩不必改；未起 Electron（额度与标题全是纯函数 + 源码切片口径），过程日志已删。
- 攻击面如何关闭：第一枚与第二枚应用内弹窗仍可放行，多步 OAuth 走得住；第三枚起降级为系统浏览器 —— 登录流程仍然完成，只是不再长 Torra 的外壳。凡放行的窗口标题由 Torra 钉死、站点的 `<title>` 被 `preventDefault` 挡回，仿冒页拿不到「看起来像 Torra 的窗口」这层皮。每一次放行/降级/挡掉都进 `diag.log`，doctor 里能看到是额度挡的还是协议挡的。
- 有意不做的（记进 backlog 而不是默默忽略）：`shell.openExternal` 这条路只验协议不验 host。加 host 白名单会挡掉真实的跨域 OAuth 续跳（第三方登录按钮常常先跳自己的域名再跳回来），代价是把登录功能弄坏；这一档现在交给系统浏览器，浏览器会显示真实地址栏。作为取舍单独列为 ROI 2.0 项。
- 过程中修掉三个自身错误：① `assert.doesNotMatch(note, /auth\.example\.com/)` 写错了口径 —— `popupNote` 按设计就要落目标主机名，改为只查 token 泄漏（`/SECRET|\?code=/`）。② 插入接线用例时把下一条用例的 `await it('用例本身挂在 npm test 链上…', () => {` 头部一起替换掉了，留下孤儿 body；补回头部。这与第 7 轮 splice 错 backlog 是同一类错误 —— **锚点要取整行，不是行首片段**；结构性 Edit 之后必须重读。③ 接线正则多写一个闭括号（`isLoginWindow\(contents\.id\)\)`）导致 16/1，改为 `isLoginWindow\(contents\.id\)\s*\?\s*claimInAppPopup\(contents\.id\)` 后 17/0。另外 `state.json` 插入历史条目时漏了上一条的尾逗号，靠 `node -e JSON.parse` 抓到。
- 整链首跑遇到的 flake（已升为 backlog 项）：第一次 `npm test` 以 `test:api-retry` 的「200 + OpenAI 整包 JSON」失败退出（`fetch failed`，本地 mock 争用），单跑该套件 14/0，整链第二次 0 失败。本轮改动与网络/mock 无关，判定为既有 flaky；但**这次失败让 `&&` 之后的 11 个套件根本没跑却被一眼看成「本轮验证过」** —— 这正是第 7 轮给可维护性留 5.0 的那条结构问题，现在有实测证据了，已单独记为 ROI 3.0 项。
- 分数：安全可靠性 9.0 → 9.5（仍扣分：`shell.openExternal` 只验协议不验 host（刻意取舍，已记录）；崩溃文案外显 file:line；favicon 依赖 6 个第三方 CDN 待人类取舍），可维护性 5.0 → 5.0（api-retry flake 让 `&&` 截断的代价从推断变成观测），综合 7.19 → **7.25**。

## Round 9 · 2026-10-07T21:18Z · 可维护性（`npm test` 改为跑完全部再汇总，ROI 3.0）

- 选点：这是第 8 轮被现场证实的那条结构问题，也是仓库里第三次付同一种代价。`&&` 串链的代价从来不是「慢」，是**遮蔽**：第一处失败就把后面的套件全部跳过，而输出里只看得到那一条失败，看不出「还剩多少套根本没跑」。第 1 轮的假绿基线（e2e 单条断言失败，后 16 套从未执行却被当成跑过）、第 8 轮（api-retry 一条本地 mock 偶发失败，其后 11 套零输出，只留 `13 passed 1 failed`）都是同一个失效模式。CI（`.github/workflows/build.yml` 的 `npm test`）吃的是同一个口径，所以验证通道本身不可信时，前 8 轮所有「全链 0 失败」的证据强度都要打折。
- 改动（7 文件，净增约 280 行，业务代码 0 行）：
  - `scripts/run-tests.js`（新，103 行，CommonJS 纯脚本）：`listSuites` 从 package.json 的 `test:` 键枚举名单 —— **「加了 test:x 却没进链」这个失效模式被结构性取消**，不再靠人记得往串链里补一段。`runSuites(suites, execute)` 逐套执行、任何失败只记录不中断，`execute` 做成参数正是为了让用例能注入假执行器验证这条不变量。`parseSummary` 兼容仓库里并存的三种汇总行口径（`通过 X · 失败 Y` / `X passed, Y failed` / `全部通过：N passed, 0 failed`），从后往前取第一条命中的（中间过程也可能打印计数，取第一条会把「跑到一半」当成结论）。`formatReport` 每套一行 `ok`/`FAIL` + 计数 + 「套件 N/M 通过 · 断言 X 通过 / Y 失败」，失败套件的完整输出成块附在汇总行之后；**判定仍以退出码为唯一权威**，解析不到汇总行的套件照样计入通过，CI 的语义与改前一致。`spawnSuite` 里两个必须显式处理的点：`maxBuffer` 默认 1MB 会把长输出套件判成失败（本轮 25 套全量输出约 7.4 kB，留 32MB），PATH 必须补 `node_modules/.bin`（npm 只在 `npm run` 下配这层，直接 `node scripts/run-tests.js` 起跑时没人配，否则找不到 ts-node）。
  - `package.json`：`test` 改为 `node scripts/run-tests.js`（24 段 `&&` 整串退役），新增 `test:suite-runner`。
  - `scripts/test-suite-runner.ts`（新，166 行，9 条）：核心不变量「第 2 套失败，第 3~5 套照样跑」用注入的假执行器验证；另覆盖名单枚举与三种汇总口径、null 时以退出码为准、报告文本三条（`FAIL test:c`、`ok test:a` 都要出现 —— 别让「没跑」和「跑过」看不出区别；「套件 2/3 通过」要数得出来；失败详情成块排在汇总行之后）、`--list` 与 package.json 清单一致且含本套自己、`node --check`。反身的一条最要紧：断言 `run-tests.js` 源码里**不得出现任何具体套件名**，防止名单再次硬化。
  - 迁移 4 处对已退役 `&&` 链的耦合断言：`test-render-guard.ts:125-126`、`test-chat-persistence.ts:242-243`、`test-webview-guards.ts:229-230`、`test-markdown-memo.ts:282-283` 原本都断言 `pkg.scripts.test` 里含自己的套件名。统一改为「指向 run-tests.js 且不含 `&&`」，**没有放松成「不再检查」**。
- 验证：`npm run typecheck` 0 错（TC_EXIT=0）；`npm run build` ✅（vite 8.87s，index js 688.56 kB / gzip 213.33 kB、css 178.48 kB —— 与第 8 轮**逐字节相同**，src 一行未动）；`npm run test:suite-runner` 通过 9 · 失败 0；`npm test` **套件 25/25 通过 · 断言 728 通过 / 0 失败**（TEST_EXIT=0）。728 这个数字从此由汇总跑法机器计数，且与第 8 轮手工合计的 719 + 新套件 9 逐字吻合。无关核心路径由 `test:session` 165/0、`test:orchestrator-e2e` 14/0、`test:assistant-bridge` 56/0 覆盖；无新 IPC 故 `scripts/smoke.js` 桩不必改；未起 Electron，两个一次性演示 package.json 跑完即删。
- 遮蔽问题的三段对照实验（本轮的「性能/行为改动给前后数值」）：① 改前口径 —— 同序三段 `node -e` 用 `&&` 串，第二个 exit 3，输出只打印第一条 `ok`，`CHAIN_EXIT=3`，第三个套件零输出；② 改后口径 —— 临时 package.json 造三套（中间那套带失败汇总行），报告给出 `ok / FAIL / ok` 三行 + 「套件 2/3 通过」+ 失败详情成块；③ npm 层真实退出码 —— 同一份临时 package.json 走 `npm test`，`NPM_EXIT=1`，证明非 0 是传给 CI 的而不是脚本内部的返回值。墙钟：汇总跑法 29.95s vs 逐套 `npm run` 手工串 47.67s（**−37.2%**，`time` 的 real，单次测量，不宣称稳定值）。
- 过程中修掉两个自身问题：① 我自己那条断言自相矛盾 —— 写了 `!report.includes('[FAIL] 某条断言\n期望')`，而 run-tests.js 恰恰故意把失败套件的完整输出原样打出来；换成「详情排在汇总行之后」的次序断言（先看结论再看堆栈，翻的时候不用来回找）。② 首跑 4 套同时失败（7/1、9/1、16/1、9/1），全是上述那处对 `&&` 的耦合；`&&` 链下只会看到第一个，剩下三个要一轮修复-重跑才浮出来 —— 这一条本身就是本轮选点的现场证据。另记：`test-markdown-memo.ts` 第 29 行的夹具文本里仍写着旧的 `&&` 串链措辞，那是金标准 HTML 的输入，动它等于重抓 5 个夹具，本轮不改。
- 分数：可维护性 5.0 → 6.0（验证通道从「会遮蔽」改为「跑完再汇总」，且名单不再可能漏掉套件；仍扣分：styles.css 7536 行含死规则与三重定义、`test-session` 源码切片断言边界会随并行新增函数漂移、主进程 store 与 renderer localStorage 两套持久化口径并存），功能性 8.0 → 8.0（不动 src，但「全链 0 失败」这条证据从此可信度更高），综合 7.25 → **7.38**。
- 顺带放出来一项（已进 backlog）：`test:api-retry` 那条偶发 `fetch failed` 现在不再被截断，会直接把 CI 染成假红 —— 假红比假绿更难查，因为它长得像真失败。根因未定位（候选：mock 监听器就绪竞态、上一套残留句柄），第 8 轮复现 1 次、重跑通过，第 9 轮汇总跑法 25/25 全绿 1 次。列为 ROI 3.0，要求先稳定复现再动手，不许靠加重试把 flake 掩掉。

## Round 10 · 2026-10-07T21:31Z · 实用性 / 可维护性（模型「顺序 + 启停」收口到设置页，ROI 3.0）

- 选点理由：这一项同时命中三处证据。① 项目既定约定「配置一律收口设置页」，而实测设置页的「模型管理」只能添加/编辑/验证/隐藏恢复，**排序与停用两个动作一个都不在**（`ModelRail.tsx` 的拖动 + `App.tsx` 的 `handleReorder`/`handleToggleEnabled` 是唯一入口）；② `usable` 自第 4 轮起到第 9 轮一直停在 7.0，四维里唯一连续 4 轮没动过的就是它，而这一条正是它名下 ROI 最高且能独立做完的项；③ 备选三项都不适合本轮：`useStore` 全量订阅要和并行会话正在改的 `RightPanel`/`ChatPage` 对齐（`git status` 现场显示对方在动）、`api-retry` 的 flake 本轮压 300 轮 0 复现（无根因不动）、styles.css 死规则会在别人正在重排的样式消费方上误判。第 10 轮是「每 5 轮 1 次发散」的那一轮，但发散名额用在结构收口上比用在探索性功能上更稳 —— 不新开界面，只把已有能力搬到它该在的位置。
- 改动（7 文件，净增约 +443 行：新增 432 行 + 接线 +16/-5，未触发单轮 >10 文件或 >500 行的拆线）：
  - `src/renderer/modelOrder.ts`（新，27 行，纯函数）：`moveBefore`（侧栏拖动语义 = 插到目标之前，目标不在列表里就追加到末尾）与 `moveStep`（设置页箭头语义 = 相邻交换，贴边或 id 不在列表里原样返回，调用方据此把按钮置灰）。收口的必要性不在「少写几行」，在**两种语义本来可以各写各的**：两处都手写 `splice` 时，「拖动得到的顺序」和「箭头调出的顺序」会静默分家，而界面上没人会去对表。
  - `src/renderer/components/ModelManageSection.tsx`（新，110 行）：每行 ↑ / ↓ / Power 三个图标按钮 + `第 N 位 · 网页|API` + 已停用标记 + 处理中…；**只收 props，一行都不碰 `window.torra`** —— 写盘、脱勾、提示留在 `App.tsx` 既有 handler 里，避免同一条 IPC 出现两个调用者。一行动作串行（`busy[id]` 闸门）：连点两次会用同一份旧顺序算出两个新顺序、后者覆盖前者，所以第二次点击直接不吃。
  - `SettingsPage.tsx`：加 props（`onReorder`/`onToggleEnabled`）并把本节插在「添加模型」与「API 模型」之间（顺序：添加 → 顺序与启停 → API → 网页 → 已隐藏）。`App.tsx`：把已有 handler 原样接进去。`ModelRail.tsx`：`commitReorder` 的内联 `rest.splice(...)` 换成 `onReorder(moveBefore(...))`。
  - `scripts/test-model-order.ts`（新，295 行，21 条）并挂入链（`test:model-order`）：纯函数层做**全枚举置换不变量**（4 个 id 的全排列 × 每个 dragId × 两个方向，断言结果仍是同一多重集、被挤开的那个元素正好换到原下标），口径层断言两处 UI 真的 import 同一个模块且没再手写别的外科手术式下标运算，产物层用 SSR（esbuild 内存 bundle + `renderToStaticMarkup`）验行序、首末行的 `disabled` 分布、启用计数文案、空态，以及「不许用 `st-actions quiet` 这种悬停才可见的动作样式」。
- **新套件首跑 17/3，抓到一个真 bug**：`moveStep` 最初写成 `moveBefore(ids, id, ids[to])`，而「把 a 插到紧跟着它的 b 之前」按定义就是原地不动 —— 用户点 ↓ 会看着毫无反应。这不是慢，是压根没动，正是第 5 轮那条「异步操作要有可见反馈」的反面。修法是先摘掉自己再按目标下标插回（代码里留了一条 WHY 注释说明为什么不能复用 `moveBefore`），顺带让重复 id 只搬那一位（新增用例 `moveStep(['a','b','a','c'],'a',1) === ['b','a','a','c']`）。另一处失败是我自己写错的期望值（`moveBefore(['a','b','c','d'],'a','c')` 应为 `['b','a','c','d']`），修的是夹具不是代码，并补了一条把「拖到紧邻下一张 = 原地」这个诚实的拖动语义钉住。
- 验证：`npm run typecheck` 0 错；`npm run build` ✅（vite 8.02s，index js **691.51 kB** / gzip 214.09 kB、css **178.48 kB 逐字节相同** —— 本轮没写一行样式，体积代价 +2.95 kB / +0.43% 全部来自渲染图里新增的两个模块）；`npm run test:model-order` 通过 21 · 失败 0；`npm test` **套件 26/26 通过 · 断言 749 通过 / 0 失败**（749 = 728 + 21，机器计数）。无关核心路径：`test:session` 165/0（含它对 `ModelRail`/`SettingsPage` 的既有切片断言，本轮改动没让任何一条由通过变失败）、`test:orchestrator-e2e` 14/0、`test:credential-expiry` 24/0、`test:assistant-bridge` 56/0。无新 IPC → 不必改 `scripts/smoke.js` 桩；未起 Electron、未打真实 API。
- 有意不做的：不加「恢复默认值」（那是另一条 ROI 3.0，需要主进程决定默认参数从哪儿来，本轮不混着做）；不动 `useStore` 全量订阅；不做「拖拽手柄 + 键盘重排」的新交互（先把已有能力搬到该在的位置，验证过再谈加）；`TopicEvolution.tsx` 零改动。
- 顺带纠正一处 backlog 的错误证据：设置页在 `src/renderer/components/SettingsPage.tsx`，不是 `src/renderer/pages/SettingsPage.tsx`（历轮引用的一直是后者，路径不存在）。
- 分数：实用性 7.0 → **7.5**（设置页缺的「顺序 + 启停」补齐；仍扣分：无恢复默认值出口、没有整页键盘路径），可维护性 6.0 → **6.5**（顺序语义从两份 UI 收成一个可断言的纯函数模块；仍扣分：styles.css 7536 行死规则与三重定义、`test-session` 切片断言边界会漂移、持久化两套口径），综合 7.38 → **7.56**。

## Round 11 · 2026-10-07T21:45Z · 实用性（讨论参数「恢复默认值」出口 + 默认值单一来源，ROI 3.0）

- 选点理由：① backlog 里 ROI ≥ 3.0 的三项中，`useStore` 全量订阅仍被并行会话挡住（`git status` 现场：对方 `RightPanel.tsx` 在其暂存区、`ArgumentMap.tsx`/`argmap.css` 在工作区删除，改动面横跨 App/ChatPage），`api-retry` 的 flake 仍缺第二次现场证据（规则：无根因不动）；剩这一项成本「低」、风险「低」，且是 usable 名下唯一能独立做完的。② 证据直接可查：默认参数散在 `src/renderer/store.ts:367-374`（初始化）与 `NewSession.tsx` 的三处硬编码（`{ at: 85, text: '默认' }`、`n <= 0 ? 2`、`fallback={12}`），界面自己写一份「默认」，恢复动作无处可取。③ 这一项同时补上第 10 轮收口的最后一块：设置页此前有「模型管理」但没有「讨论参数」。
- 改动（8 文件：新增 3、改 5；净增约 +590 行，业务代码 +226、测试 +382、链 +1；未触发 >10 文件或 >500 行业务代码的拆线）：
  - `src/renderer/configDefaults.ts`（新，95 行，纯数据 + 纯函数）：`CONFIG_DEFAULTS`（9 项）+ `CONFIG_ROWS`（同一份表的界面顺序与叫法，兼作「恢复默认值」的作用域）+ `formatConfigValue`（单位口径：轮 / % / 美元 / 分钟 / 开关 / 圆桌·辩论·评审 / 关闭·自动·逐条）+ `diffFromDefaults`（返回与默认不一致的项，空数组即「没有可恢复的东西」）。两个默认值不自己写：`verifyPass` 与 `timeBudgetMin` 直接取 `@shared/types` 的 `VERIFY_PASS_DEFAULT` / `TIME_BUDGET_DEFAULT_MS`，让「界面说的默认」与「主进程 `validateSessionInput` 的默认」不可能分家。文件头写明本轮唯一要守住的前提：**恢复默认值动的是「怎么讨论」，不是「讨论了什么」**。
  - `src/renderer/components/ConfigDefaultsSection.tsx`（新，99 行，只收 props）：一行一项列出「默认 X / 当前 Y」，已改的项用 `wm-tally` 正常态、未改的用 `ok` 态；全默认时按钮 `disabled` 并给 `title="当前已经全是默认值"`，有差异时按钮文案带条数（`把 N 项改回默认值`），点完 4 秒内行内提示「已恢复 N 项」。零新 CSS —— 复用设置页既有 `st-section`/`st-list`/`st-btn`/`st-inline-msg` 与 `.wm-tally`。
  - `store.ts`：`initial` 展开 `...CONFIG_DEFAULTS`（`consensusThreshold: 85` 等四项手写值整批删掉）；新增 `resetDiscussionConfig: () => set({ ...CONFIG_DEFAULTS } as Partial<TorraState>)`，只回九项参数，**不碰** `topicTitle`/`topicBackground`/`participantIds`/`moderatorId`/`round`/`state`/`utterances`；`reset()`（清空整场）原样保留。
  - `SettingsPage.tsx`：新增 tab `discussion`（「讨论参数」），props 收 `config` + `onResetConfig`；`App.tsx`：把九项从 store 原样传下去并接 `onResetConfig={() => s.resetDiscussionConfig()}`。`NewSession.tsx`：三处硬编码默认改为 `CONFIG_DEFAULTS.*`。
  - `scripts/test-config-defaults.ts`（新，382 行，22 条）并挂入链（`test:config-defaults`）：默认值层（与 `@shared` 常量同源；九项全部落在主进程校验区间内）→ 口径层（`CONFIG_ROWS` 的键 ≡ `CONFIG_DEFAULTS` 的键；逐项单改恰好产生 1 条差异、改回即清零；多条同改时顺序跟随 `CONFIG_ROWS`；`diffFromDefaults` 不改入参；`store.ts` 里不得再出现手写的 `consensusThreshold: 85` 这类数字；`configDefaults.ts` 只许导出这两张表）→ 状态层（**真调** `resetDiscussionConfig()` 对 esbuild 打出来的 zustand store 下断言：九项回默认，而 `topicTitle`/`topicBackground`/`participantIds`/`moderatorId`/`round`/`state`/`models` 引用逐个不变；再调一次幂等；`reset()` 仍是全清）→ 接线层（SettingsPage 的 tab/import/props、App 的传参与回调、组件不得出现 `window.torra`、package.json 挂链）→ 产物层（SSR：行数与顺序、全默认时 `disabled` + 9 个「未改」+ 不出现「当前 」+ 不渲染行内提示、有差异时条数与「当前 5 轮」文案、禁 `card` 类名与 `linear-gradient`/`box-shadow`、禁新增 `<input>`/`<select>`）。
- **新套件首跑 20/2，其中一条是产品 bug**：行内计数 `<span className="wm-tally{changed.has(r.key) ? '' : ' ok'}">` 把类名表达式写成了普通字符串属性，SSR 产出 `class="wm-tally{changed.has(r.key) ? &#x27;&#x27; : &#x27; ok&#x27;}"` —— 「未改」的弱化态永远不会生效，界面上已改和未改长得一样。改成模板字面量 `` className={`wm-tally${…}`} `` 后 22/0。另一条失败是我自己测试里的 ASI 陷阱：`const keep = { … }` 多行字面量后面紧跟 `(S.getState().resetDiscussionConfig as () => void)()`，被解析成对对象字面量的调用，报错位置还指向 `}` 那行；修法是先取引用再调用（`const act = …; act()`）。这与第 10 轮的 `moveStep` 同构 —— 两轮连续证明：把「两处一致」变成断言之后，测试首跑的失败率本身就是这类收口的收益凭证。
- 验证：`npm run typecheck` 0 错（main + renderer 双 tsconfig）；`npm run build` ✅（vite 7.98s，index js **695.34 kB** / gzip 215.76 kB、css **178.48 kB 逐字节相同**，本轮没写一行样式；index js 691.51 → 695.34 kB = **+3.83 kB / +0.55%**，全部来自渲染图新增两个模块）；`npm run test:config-defaults` 通过 22 · 失败 0；`npm test` **套件 27/27 通过 · 断言 771 通过 / 0 失败**（771 = 749 + 22，机器计数）。无关核心路径四条未破坏：`test:session` 165/0（它对 `SettingsPage`/`App` 的既有源码切片断言没有因新增 tab 与新增 props 由通过变失败）、`test:orchestrator-e2e` 14/0、`test:model-order` 21/0（同页另一节）、`test:credential-expiry` 24/0。**安全/性能类 DoD 本项目不适用**：无 IPC、无文件与网络改动、无主进程改动，因此不需要 `scripts/smoke.js` 补桩；未起 Electron、未打真实 API。
- 有意不做的：不做「跨会话持久化默认参数」（只有 `participantIds`/`moderatorId` 会重启存活，本轮的恢复出口按同一口径只覆盖会话内）；不加主进程侧的 `config:reset` IPC（渲染层 store 是唯一写通道，加一层 IPC 只会造出第二个写者）；不碰 `useStore` 全量订阅、不删 styles.css 死规则（两项都在别人正在动的面上）；`TopicEvolution.tsx` 零改动。
- 过程中修掉一个自身问题：`git status` 复核发现 `NewSession.tsx` 的改动全是我这一轮的三处默认值引用（`git diff` 逐段确认 46 插入 / 13 删除都在本轮 5 个文件里），没有把并行会话的暂存内容（`RightPanel.tsx`）或它删掉的 `ArgumentMap.tsx`/`argmap.css` 一起带走 —— 提交用 pathspec 限定到本轮 8 + 3 个文件。
- 分数：实用性 7.5 → **8.0**（设置页四类收口到此齐：配置/网页登录/模型排序停用/恢复默认值；仍扣分：没有整页快捷键图，键盘路径只有按钮原生 tab 顺序），可维护性 6.5 → **7.0**（默认值从「store 初始化 + NewSession 硬写」两份收成一张表，且「恢复动作不许清用户数据」这条不变量现在是运行时可断言的；仍扣分：styles.css 7536 行死规则与三重定义、`test-session` 切片断言边界会漂移、持久化两套口径），综合 7.56 → **7.63**。
