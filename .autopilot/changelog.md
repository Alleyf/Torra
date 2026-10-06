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
