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
- **src/main/acp/**: Pluggable coding agents over ACP — registry, preflight, NDJSON transport, MCP tool pack, compatibility matrix
- **src/renderer/components/AgentsPage.tsx**: 编码工作台 — the nav section (not a drawer) where external agents run: rail of agents/sessions, transcript with folded steps, right-side diff review
- **src/renderer/agentSessions.ts**: Torra's own session library for that workbench (localStorage, 240 lines / 30 sessions). ACP has no transcript, so archived sessions are read-only with a "start a new session" exit
- **plugins/**: Built-in application plugins (`research` = 科研工作台 four-zone shell over `modules/{scholar,trajectory,server}`, `tech` = 技术工作台 with AIHOT hot topics); user installs land in `<userData>/plugins``
- **shared/**: Shared types, invariants, and utility functions

## Coding Agents (ACP)
- Torra is a **client** of external coding agents, not an implementer of one: `src/main/acp/` speaks ACP (JSON-RPC 2.0 over stdio NDJSON) and nothing else. No per-agent shim — adapters come from the ecosystem (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`, `pi-acp`, opencode's own `acp` entry)
- `registry.ts` holds the built-in four with **pinned adapter versions** (they track upstream; the matrix is keyed by id + version); user entries live in `<userData>/torra/acp.json` and override built-ins by id
- `matrix.ts` + `matrix-data.json` hold the measured compatibility matrix. A version with no cell reads as "not verified yet" — never borrow another version's verdict. Run `npm run test:acp -- --live --write-matrix` to refresh
- `mcp.ts` serves Torra's own tools to agents over MCP (127.0.0.1, per-session token). Tool definitions live once in `src/main/assistant/tools.ts`; the exit is what changes
- The workbench is a **nav section** (`编码`), not a drawer: rail of agents + sessions, transcript with folded steps, right-side diff review. Edits come from ACP `diff` content blocks only — `toolOutputParts` lifts `{path, oldText, newText}`, `acpLines.ts` folds them onto the step (last write wins), `sessionEdits` feeds the review panel; line counts use multiset comparison so a same-length rewrite reads +1 −1
- The ACP path loads **no third-party ESM**: the transport is hand-written (`jsonrpc.ts`) and tool parameters are plain JSON Schema (`src/shared/tool.ts`). A test enforces this by scanning the ACP import closure
- The in-house assistant still runs pi **in-process** (`src/main/assistant/pi-sdk.ts`, an ESM loader). Retiring it is not done: ACP has no transcript persistence and no "steer", and `pi-acp` drops the MCP declaration, so a pi-hosted assistant would lose Torra's tools

## Key Patterns & Conventions
1. **Adapter System**: New AI services require only a YAML file in `adapters/` directory with proper selectors and configuration
2. **Session Management**: Sessions are persistent with model history; login state exists in isolated partitions
3. **Agent Status**: Status values ('ready', 'busy', 'expired', 'adapter-broken', 'disabled', 'absent') must be properly maintained
4. **Webview Isolation**: Webviews operate in separate partitions; login state is maintained in `persist:torra-<modelId>` 
5. **Error Handling**: Adapter failures must be explicitly handled and reported as 'adapter-broken' status
6. **Application Plugins**: Panels/tools/prompts ship as `torra-plugin.json` + `main.js` + `ui.html`; declared permissions gate every host capability, and panels never see `window.torra`

## Application Plugins
- Built-in plugins live in `plugins/<id>/`; user installs (directory or zip) land in `<userData>/plugins` and are listed in Settings → 应用
- `main.js` runs in a `utilityProcess` — crash isolation, not a security sandbox; host calls are gated per permission: `storage`, `panel`, `tools`, `secrets`, `ai`, `net:<host>`
- `ai` 只走带 Key 的 API 模型：模型只做判断与起草，检索/落库都在插件进程；结果先预览，用户确认后才写入
- Panels are top-nav screens: the entry sits in the titlebar next to the built-in sections, and the panel fills the content area in a sandboxed `torra-ui://frame` iframe with an injected `window.torraPlugin` SDK (`call`, `onTheme`) bridged to main; the URL carries a short-lived token bound to the plugin id
- Plugin tools are appended to the assistant toolset after the built-in whitelist, prefixed `${pluginId}_`; that same toolset is what the ACP MCP server hands to external agents (one definition, two exits); manifest permission drift auto-disables the plugin
- A merged plugin namespaces its own modules: storage keys `module:key`, RPC names `module.rpc`, tool names `${pluginId}_${tail}`; a module UI larger than the panel cap is streamed in via `host.asset` and mounted in a nested `srcdoc` frame that relays `torra:call` upward
- `host.open_external` opens http/https links in the system browser — panels are sandboxed frames where `target=_blank` is dead
- Packaging requires `asarUnpack: plugins/**` — ESM plugin mains cannot be imported from inside an asar archive

## Critical Gotchas
- **Login State Isolation**: Logging in via Chrome browser does NOT affect Torra's login state; must use Torra's login window
- **Adapter Configuration**: YAML files must pass validation; common issues include missing selectors or incorrect transport type
- **Port Conflicts**: Development server ports must be unique; use `TORRA_DEV_PORT` environment variable
- **Electron Restart**: Changes to main process/preload require Electron restart (handled automatically in dev mode)
- **No Network Bypass**: Torra respects platform terms of service; cannot bypass login walls or CAPTCHAs
- **No Third-Party ESM in the Main Process**: the main build is CommonJS, so an ESM-only dependency on a startup path dies with ERR_REQUIRE_ESM at launch — pi's SDK did exactly this (an undici `markAsUncloneable` patch on Node 20.18). The ACP path is enforced by a test that scans its import closure; anything else needing an ESM package belongs in a `utilityProcess`

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