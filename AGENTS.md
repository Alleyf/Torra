# Torra Agent Working Guide

## Essential Commands
- `npm run dev`: Start development mode with hot reload (vite + tsc watch + Electron)
- `npm run build`: Build main process + preload + renderer layers
- `npm start`: Build and launch application
- `npm test`: Run all test suites (19 scripts)
- `npm run test:agents`: Run agent-specific tests
- `npm run diagnose:webview <agent>`: Diagnose webview agent issues
- `npm run list:cookies`: List login cookies by partition

## Code Organization
- **src/main/**: Main process entry point, orchestrator, session management
- **src/agents/**: Agent abstractions and implementations:
  - `api-agent.ts`: API-based agent communication
  - `webview-agent.ts`: Webview-based agent (browser interaction)
  - `agent.ts`: Base agent interface
- **src/adapters/**: YAML configuration files for AI service adapters
- **src/webview/**: Webview pool and injection scripts
- **shared/**: Shared types, invariants, and utility functions

## Key Patterns & Conventions
1. **Adapter System**: New AI services require only a YAML file in `adapters/` directory with proper selectors and configuration
2. **Session Management**: Sessions are persistent with model history; login state exists in isolated partitions
3. **Agent Status**: Status values ('ready', 'busy', 'expired', 'adapter-broken', 'disabled', 'absent') must be properly maintained
4. **Webview Isolation**: Webviews operate in separate partitions; login state is maintained in `persist:torra-<modelId>` 
5. **Error Handling**: Adapter failures must be explicitly handled and reported as 'adapter-broken' status

## Critical Gotchas
- **Login State Isolation**: Logging in via Chrome browser does NOT affect Torra's login state; must use Torra's login window
- **Adapter Configuration**: YAML files must pass validation; common issues include missing selectors or incorrect transport type
- **Port Conflicts**: Development server ports must be unique; use `TORRA_DEV_PORT` environment variable
- **Electron Restart**: Changes to main process/preload require Electron restart (handled automatically in dev mode)
- **No Network Bypass**: Torra respects platform terms of service; cannot bypass login walls or CAPTCHAs

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
- Comprehensive test suite with 19 specialized scripts
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
- `adapters/`: AI service configuration files
- `scripts/`: Development and testing utilities
- `docs/`: Comprehensive documentation and guides