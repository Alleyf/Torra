# Torra Agent Working Guide

## Essential Commands
- `npm run dev`: Start development mode with hot reload (vite + tsc watch + Electron)
- `npm run build`: Build main process + preload + renderer layers
- `npm start`: Build and launch application
- `npm test`: Run all test suites (53 scripts)
- `npm run test:agents`: Run agent-specific tests
- `npm run test:plugins`: Run application-plugin kernel tests (manifest, zip, storage, panel SDK, research/tech panel logic)
- `npm run diagnose:webview <agent>`: Diagnose webview agent issues
- `npm run list:cookies`: List login cookies by partition
- `npm run test:acp`: ACP layer regression (registry, preflight, tool pack, matrix) — offline, no cost
- `npm run test:acp -- --live`: Probe the four real agents (downloads adapter packages, sends no prompt)
- `npm run test:acp -- --live-full --write-matrix`: Full matrix (sends real prompts — costs the user's quota)

## Code Organization
- **src/main/**: Main process entry point, orchestrator, session management
- **src/agents/**: Agent abstractions and implementations:
  - `api-agent.ts`: API-based agent communication
  - `webview-agent.ts`: Webview-based agent (browser interaction)
  - `agent.ts`: Base agent interface
- **src/adapters/**: YAML configuration files for AI service adapters
- **src/webview/**: Webview pool and injection scripts
- **src/main/plugins/**: Application plugin kernel (manifest validation, zip install, storage, utilityProcess runtime, panel sandbox)
- **src/main/assistant/skillTags.ts**: Skill categorization tags — the Torra-side record (`<dataDir>/skill-tags.json`), never the skill files; sanitize + read + atomic write of the `linkName → tags` map
- **src/main/acp/**: Pluggable coding agents over ACP — registry, preflight, NDJSON transport, MCP tool pack, compatibility matrix, and the catalog (`catalog.ts`: curated entries + official registry pull + PATH detection)
- **src/renderer/workTree.ts**: 会话工作树 —— 由 HostItem 投影出的节点（`session:` / `turn:` / `step:` / `deliver:`）、缩进式竖排布局、节点差与光线计划。纯函数，`scripts/test-work-tree.ts` 直接加载，不依赖 DOM
- **src/renderer/lancerLight.ts**: 全项目唯一一套光线 —— `createLightLayer(svg)` + `layer.emit(...)`；单 rAF、空闲停帧、页面隐藏冻结、卸载清理、`prefers-reduced-motion` 降级；每帧只改 SVG 属性，不走 React
- **src/renderer/components/WorkTreePanel.tsx**: 右栏那棵树（聚焦/全部、跟随、演示开关、交付文件卡）
- **src/renderer/components/AgentsPage.tsx**: 编码工作台 — the nav section (not a drawer) where external agents run: rail of agents/sessions, transcript with folded steps, right-side diff review
- **src/renderer/components/AgentCatalog.tsx**: the 「接一家」 overlay — curated cards + the pulled official registry as candidates. Every card states whether this machine already has it, and if not hands over the exact install line (copy button). The manual form lives here too, last, behind 「目录里没有？手写一条」
- **src/renderer/components/AgentRegistry.tsx**: the manual entry form (`RegistryEditor`) and the deletable list of entries the user added (`UserEntries`)
- **src/renderer/agentSessions.ts**: Torra's own session library for that workbench (localStorage, 240 lines / 30 sessions). Once a harness replays a session back, the local body is dropped and the record becomes an **index only** (`harnessOwned`) — the harness owns the transcript, Torra keeps who/which/when/session-id
- **src/renderer/agentMarks.tsx**: what each agent looks like — the vendors' own marks (Anthropic's sunburst, OpenAI's blossom, pi's three-colour glyph, OpenCode's block) plus a family hue. Marks are trademarks: they identify whose product this is, nothing more. An agent the user added has no mark, so it falls back to a letter plate
- **plugins/**: Built-in application plugins (`research` = 科研工作台 four-zone shell over `modules/{scholar,trajectory,server}`, `tech` = 技术工作台 with AIHOT hot topics); user installs land in `<userData>/plugins``
- **shared/**: Shared types, invariants, and utility functions

## Coding Agents (ACP)
- Torra is a **client** of external coding agents, not an implementer of one: `src/main/acp/` speaks ACP (JSON-RPC 2.0 over stdio NDJSON) and nothing else. No per-agent shim — adapters come from the ecosystem (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`, `pi-acp`, opencode's own `acp` entry)
- `registry.ts` holds the built-in four with **pinned adapter versions** (they track upstream; the matrix is keyed by id + version); user entries live in `<userData>/torra/acp.json` and override built-ins by id
- `matrix.ts` + `matrix-data.json` hold the measured compatibility matrix. A version with no cell reads as "not verified yet" — never borrow another version's verdict. Run `npm run test:acp -- --live --write-matrix` to refresh
- `mcp.ts` serves Torra's own tools to agents over MCP (127.0.0.1, per-session token). Tool definitions live once in `src/main/assistant/tools.ts`; the exit is what changes
- `catalog.ts` is the **catalog of what can be connected** — eleven curated entries plus the official ACP registry (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, 43 agents). The rule that outranks every other: **Torra never installs anything**. "Installed" means exactly one thing — the launch command is on PATH. Not on PATH ⇒ the card shows the exact install line and the user runs it
- The official registry speaks **its own platform vocabulary** (`windows-x86_64` / `darwin-aarch64` / `linux-x86_64`) — not Node's `process.platform` (`win32`). `platformKey()` translates; skipping that made every Windows binary-distributed agent read as "no build for this platform"
- Official icons are fetched **in main** and handed over as `data:` URIs — the renderer CSP does not allow that CDN, and whitelisting it would let any page pull images from it
- `OFFICIAL_ID_TO_TORRA_ID` maps the registry's ids onto Torra's (`claude-acp`→`claude`, `codebuddy-code`→`codebuddy`, `opencode-v2`→`opencode`). Without it the workbench shows two Claudes
- The workbench is a **nav section** (`编码`), not a drawer: rail of agents + sessions, transcript with folded steps, right-side diff review. Edits come from ACP `diff` content blocks only — `toolOutputParts` lifts `{path, oldText, newText}`, `acpLines.ts` folds them onto the step (last write wins), `sessionEdits` feeds the review panel; line counts use multiset comparison so a same-length rewrite reads +1 −1
- The ACP path loads **no third-party ESM**: the transport is hand-written (`jsonrpc.ts`) and tool parameters are plain JSON Schema (`src/shared/tool.ts`). A test enforces this by scanning the ACP import closure
- The in-house assistant still runs pi **in-process** (`src/main/assistant/pi-sdk.ts`, an ESM loader). Retiring it is not done: ACP still has no "steer", and `pi-acp` drops the MCP declaration, so a pi-hosted assistant would lose Torra's tools

## Host Domain Layer (the one vocabulary)
- `src/shared/host.ts` is the **only** vocabulary between any harness protocol and the UI: `HostEvent` (Torra's own words — turn/message/item/plan/usage), the single reducer `applyHostEvent`, and the resume verdict `judgeResume`. Main and renderer share that reducer; the renderer must never see a raw ACP payload
- `src/main/acp/host.ts` (`AcpHostProjector`) is the projector from ACP to Host events — and it serves **live and replay from one code path** (`{ replay: true }`). In replay the agent's echo of the user turn becomes `user.delta` (live it is dropped: the user line already came from Torra's own `turn.started`)
- **Identity gate**: a turn is only durable if the harness supplies its own native key. `readNativeTurnRef` reads it from `_meta` tail keys; `looksUnstableTurnRef` rejects positional keys (pure digits, `replay-1`, `turn-2`) because those change on every read; UUIDs are not rejected on shape alone — the cross-process comparison is what settles it. The resume verdict is `durable` / `history` / `none` and comes from the measured matrix cell, never from a runtime guess
- **One source of truth**: when a replay comes back non-empty, the local body is deleted and the session record becomes an index (`harnessOwned: true`). The debounced save must check that flag — otherwise it writes the body back and the second source of truth silently returns
- The regression that keeps this honest: close the client, open a **new** one, resume, read the snapshot, and the resumed `nativeTurnRef` must equal the live one (`npm run test:acp`, "关掉进程再接着聊")

## Key Patterns & Conventions
1. **Adapter System**: New AI services require only a YAML file in `adapters/` directory with proper selectors and configuration
2. **Session Management**: Sessions are persistent with model history; login state exists in isolated partitions
3. **Agent Status**: Status values ('ready', 'busy', 'expired', 'adapter-broken', 'disabled', 'absent') must be properly maintained
4. **Webview Isolation**: Webviews operate in separate partitions; login state is maintained in `persist:torra-<modelId>` 
5. **Error Handling**: Adapter failures must be explicitly handled and reported as 'adapter-broken' status
6. **Application Plugins**: Panels/tools/prompts ship as `torra-plugin.json` + `main.js` + `ui.html`; declared permissions gate every host capability, and panels never see `window.torra`
7. **Skill tags live on Torra's side**: a skill's category is how Torra reads it, not an attribute of the file — imported skills are junctions into other apps' directories, so `SKILL.md` is never edited. Tags key on `linkName` (the entry name inside the skills dir), are capped at 8×32 chars, and are **not** pruned when an import is removed (removal usually means "not now"). IPC channel: `assistant:skill-tags-set` → `window.torra.assistantSkillTagsSet`; `scanSkills()` merges them back onto `LocalSkillView.tags` (absent = 未分类, never an empty array)
8. **The work tree is a projection, never a second store**: nodes derive from the ledger (`HostItem`), so nothing lives only inside an animation. Edges and lights resolve by semantic id (`session:` / `turn:` / `step:` / `deliver:`), never by coordinates or "the nearest node" — a guessed parent is wrong exactly on parallel branches and wrong silently. Turning a node green does not mean "merged": only a real completion writes `mergeInto`. Lights fire off a **diff of node tables** while a flag marks wholesale replacements (session switch / history replay), which is what keeps re-renders and history loads from replaying light
9. **One light system, not two**: anything that draws light goes through `lancerLight.ts` (`createLightLayer` / `emit`) or reuses its curve helpers. A flight's path is seeded from the event id (same event → same arc; per-frame randomness is jitter), it never renders through React (a 1.2 s flight would re-render the tree ~70 times), and it stops the frame loop when idle, on unmount, and pauses while the page is hidden. `prefers-reduced-motion` means a still line, not a faster one

## Application Plugins
- Built-in plugins live in `plugins/<id>/`; user installs (directory or zip) land in `<userData>/plugins` and are listed in Settings → 应用
- `main.js` runs in a `utilityProcess` — crash isolation, not a security sandbox; host calls are gated per permission: `storage`, `panel`, `tools`, `secrets`, `ai`, `net:<host>`
- `ai` 只走带 Key 的 API 模型：模型只做判断与起草，检索/落库都在插件进程；结果先预览，用户确认后才写入
- Panels are top-nav screens: the entry sits in the titlebar next to the built-in sections, and the panel fills the content area in a sandboxed `torra-ui://frame` iframe with an injected `window.torraPlugin` SDK (`call`, `onTheme`) bridged to main; the URL carries a short-lived token bound to the plugin id
- Plugin tools are appended to the assistant toolset after the built-in whitelist, prefixed `${pluginId}_`; that same toolset is what the ACP MCP server hands to external agents (one definition, two exits); manifest permission drift auto-disables the plugin
- A merged plugin namespaces its own modules: storage keys `module:key`, RPC names `module.rpc`, tool names `${pluginId}_${tail}`; a module UI larger than the panel cap is streamed in via `host.asset` and mounted in a nested `srcdoc` frame that relays `torra:call` upward
- 科研工作台的四份 `ui.html` 共用外壳 `plugins/research/ui.html` 里那一套 `:root` token：外壳装载模块时把 `style#rw-tokens` 注入每个模块文档，**改色板与字号只改外壳一处**。规矩是——墨色四档每档要在纸面、卡片、左轨三块底上都过 4.5:1（`npm run test:contrast` 守着，`scripts/check-contrast.mjs` 也能生成候选色板）；字号只有五档（14 / 13 / 12 / 11 / 标题 18）；圆角三档（容器 4 / 控件 3 / 徽标 2，内层永远小于外层）；卡片不落阴影，阴影只给浮起层；发丝线分装饰 2:1 与控件 3:1
- `host.open_external` opens http/https links in the system browser — panels are sandboxed frames where `target=_blank` is dead
- Packaging requires `asarUnpack: plugins/**` — ESM plugin mains cannot be imported from inside an asar archive

## Critical Gotchas
- **Login State Isolation**: Logging in via Chrome browser does NOT affect Torra's login state; must use Torra's login window
- **Adapter Configuration**: YAML files must pass validation; common issues include missing selectors or incorrect transport type
- **Port Conflicts**: Development server ports must be unique; use `TORRA_DEV_PORT` environment variable
- **Electron Restart**: Changes to main process/preload require Electron restart (handled automatically in dev mode)
- **No Network Bypass**: Torra respects platform terms of service; cannot bypass login walls or CAPTCHAs
- **No Third-Party ESM in the Main Process**: the main build is CommonJS, so an ESM-only dependency on a startup path dies with ERR_REQUIRE_ESM at launch — pi's SDK did exactly this (an undici `markAsUncloneable` patch on Node 20.18). The ACP path is enforced by a test that scans its import closure; anything else needing an ESM package belongs in a `utilityProcess`
- **Panel themes are two registers in one `<style>`**: a research/tech panel's `ui.html` carries the dark base rules first and a later `:root` light register that wins by source order. Any rule added to one (layout, color, an overlay's ground) must be mirrored or deliberately overridden in the other — `npm run test:css-dead-rules` only catches the leftovers
- **A hidden Electron window stops producing frames**: when a CDP harness measures geometry or takes screenshots, raise the OS window first (`BrowserWindow.getAllWindows()` → `setAlwaysOnTop(true, 'screen-saver')` + `show()`/`focus()`), because a page-level session has no `Browser.*` domain and `Page.bringToFront` does not lift the window above other apps. Otherwise every measurement reads 0 and a redesign looks broken

## Architecture Overview
1. **Main Process**: Orchestrates discussion rounds, manages model participation, handles session state
2. **Webview Pool**: Manages browser instances for AI service interactions with health monitoring
3. **Agent System**: Two primary agent types:
   - API agents: Direct API communication
   - Webview agents: Browser-based interaction with AI services
4. **Discussion Flow**: 
   - Round-based structure (5 models × 3 rounds ≈ 2-4 minutes)
   - Snapshot isolation between rounds for independent model responses
   - Host-managed cross-round communication

## Testing Approach
- Comprehensive test suite with 53 specialized scripts
- Tests cover: invariants, hallucination, deduplication, rendering, API retry, credential expiry
- Integration tests use real browser sessions with actual login states
- Mock-based testing for API interactions

## Common Issues & Solutions
1. **Adapter Not Loading**:
   - Verify YAML syntax and required fields
   - Check `adapters/` directory is being watched (file changes trigger hot reload)
   - Use `npm run diagnose:webview <agent>` for detailed diagnostics

2. **Login State Issues**:
   - Ensure login occurs in Torra's dedicated window, not external browser
   - Check `persist:torra-<modelId>` partition status
   - Use `npm run list:cookies` to verify cookie presence

3. **Port Conflicts**:
   - Change `TORRA_DEV_PORT` environment variable
   - Ensure no other processes are using the port
   - Use `npm run diagnose:webview` to check port availability

4. **TypeScript Compilation**:
   - Maintain separate `tsconfig.main.json` and `tsconfig.renderer.json`
   - Run `npm run typecheck` regularly
   - Fix type errors before committing

## Agent Development Tips
- Study existing agent implementations in `src/agents/`
- Understand the agent status lifecycle and status value meanings
- When adding new agent functionality, follow existing patterns
- Test agent behavior in isolation before integration
- Use `npm run test:agents` to validate agent-specific logic

## Security Considerations
- Never log API keys or credentials
- Login state is isolated in user-specific partitions
- API keys are stored in system keychain, not in application config
- All webview interactions must respect platform terms of service
- No code injection or unsafe eval usage permitted

## Directory Structure Reference
- `src/main/`: Core application logic
- `src/agents/`: Agent implementations and abstractions
- `src/webview/`: Webview management and injection
- `src/main/plugins/`: Application plugin kernel and runtime
- `plugins/`: Built-in application plugins
- `adapters/`: AI service configuration files
- `scripts/`: Development and testing utilities
- `docs/`: Comprehensive documentation and guides