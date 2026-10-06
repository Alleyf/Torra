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
