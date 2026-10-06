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
