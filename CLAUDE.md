# CLAUDE.md - Project Context & Learnings

**Last Updated:** 2026-02-20

This file tracks key learnings, architectural decisions, and context for AI assistants working on Paprwork V2.

---

## Project Overview

**Paprwork V2** is a complete greenfield rewrite using OpenClaw's proven architecture:
- **Core App:** Electron + TypeScript (cross-platform: Mac, Windows, Linux)
- **Companion Apps:** Swift for native macOS/iOS features (future)
- **Dev Tools:** Rust-based tools for faster development

**⚠️ CRITICAL: Node Version Requirement**
- **Requires Node v24+** (matches Electron 40's embedded Node v24.13.0)
- Use `nvm use 24` or `nvm install 24` before running any commands
- The `.nvmrc` file enforces this version
- `@electron/rebuild` requires Node v24+ features

**Quick Start:**
```bash
# 1. Switch to Node v24
nvm use 24

# 2. Install dependencies (auto-rebuilds native modules)
npm install

# 3. Start the app
npm start
```

**Why V2?**
- V1 accumulated 30,335 lines in monolithic files
- 90% code duplication between main + gateway processes
- Fragile with 10+ patches for tool calling issues
- No type safety, tight coupling everywhere

**V2 Goals:**
- 100% TypeScript with zero `any` types
- Shared core library (zero duplication)
- Small, modular components (<500 lines per file)
- Mastra framework for reliable agent orchestration
- Production-ready with comprehensive tests

**Architecture (Inspired by OpenClaw 179k⭐):**
```
Core App (Electron + TypeScript)
├── Main Process (Node.js)
├── Renderer (React)
└── Gateway (WebSocket)

Companion Apps (Optional)
├── macOS Menu Bar (Swift) → WebSocket → Core
└── iOS App (Swift) → WebSocket → Core

Dev Tools (Rust)
├── oxlint (50-100x faster linting)
├── oxfmt (50x faster formatting)
└── rolldown (faster bundling)
```

---

## Tooling Strategy: Rust Where Possible

**Our Hybrid Approach:**
```
✅ Linting:       oxlint (Rust, 50-100x faster than ESLint)
✅ Formatting:    oxfmt (Rust, 30x faster than Prettier) 
⚠️  Type Checking: tsc --noEmit (TypeScript native - no Rust alternative exists)
✅ Bundling:      Vite (esbuild internally, very fast)
```

**Why still use `tsc --noEmit`?**
- No production-ready Rust-based TypeScript type checker exists yet
- SWC can strip types but doesn't do full semantic analysis
- `--noEmit` is fast enough (only validates, doesn't emit files)
- We use Rust everywhere else (linting, formatting)

**Command examples:**
```bash
npm run check     # Runs: type-check + format:check + lint + check:loc
npm run format    # Uses oxfmt (Rust)
npm run lint      # Uses oxlint (Rust)
npm run type-check # Uses tsc --noEmit (TypeScript) - both main + renderer
```

## Architecture Learnings

### 1. Gateway vs. Main Process Separation

**Pattern learned from OpenClaw (179k stars):**
- **Gateway** = Control plane for sub-agents, jobs, orchestration
- **Main** = Primary UI process with main agent
- **Shared Core** = Both use the same `@core` library (zero duplication!)

**Key Insight:** Don't duplicate agent logic. Both processes import from `src/core/` and use the exact same `MastraAgent` class.

```
paprwork-v2/
├── src/core/          ← Shared by both main + gateway
│   ├── agents/        ← MastraAgent, SessionManager, ToolRegistry
│   ├── tools/         ← Tool implementations
│   └── types/         ← Type definitions
├── src/main/          ← Main Electron process (UI, IPC)
├── src/gateway/       ← Gateway process (sub-agents, jobs)
└── src/renderer/      ← React UI
```

### 2. Mastra Framework Advantages

**Why Mastra over DIY:**
- ✅ Automatic tool lifecycle (no manual pairing)
- ✅ Multi-provider support (Claude, OpenAI, Google)
- ✅ Built-in streaming with proper chunk types
- ✅ Handles message format conversion internally
- ✅ Proven in papr-dev-platform

**Replaces 950+ lines of fragile validation code with ~200 lines of clean wrapper.**

### 3. Type Safety is Non-Negotiable

**Rules:**
1. NEVER use `any` type - always use proper types
2. Use `unknown` if truly unknown, then type guard
3. Every function parameter and return value must be typed
4. Use type unions instead of loose types
5. Enable strict TypeScript mode

**Example:**
```typescript
// ❌ BAD
function process(data: any) { ... }

// ✅ GOOD
function process(data: CoreMessage | CompactionEntry): void {
  if ('role' in data) {
    // TypeScript knows it's CoreMessage
  }
}
```

### 4. Small, Modular Components

**Max lines per file:**
- Components: 50-200 lines
- Services: 100-300 lines
- If exceeds limit: break into smaller files

**Benefits:**
- Easier to test
- Easier to maintain
- Clear separation of concerns
- Better code review

### 5. Electron Best Practices

**Mac-specific:**
- Use entitlements for permissions (mic, camera, calendar)
- Sign the app for distribution (codesign)
- Support both Intel and Apple Silicon
- Use launchd for background services (like OpenClaw)

**IPC Safety:**
- Type all IPC channels
- Validate all inputs from renderer
- Never expose Node APIs directly
- Use contextBridge in preload

---

## Key Technical Decisions

### Decision 1: Mastra Over Custom Agent
**Rationale:** OpenClaw (179k stars) uses `pi-coding-agent` library. They don't manually handle tool calling either - they delegate to a framework. Mastra is proven in our papr-dev-platform.

**Alternative considered:** Build custom like V1
**Outcome:** Use Mastra, add thin fallback wrapper if needed (~100 lines)

### Decision 2: Shared Core Library
**Rationale:** V1 had 90% duplication between main and gateway. V2 uses single shared core.

**Impact:**
- Zero duplication
- Fix bug once, fixed everywhere
- Consistent behavior
- Easier testing

### Decision 3: JSONL for Chat Storage
**Rationale:** Simple, reliable, human-readable, append-only.

**Benefits:**
- Easy to debug (just cat the file)
- Atomic writes (append-only)
- No database dependencies
- Fast for sequential reads
- Compatible with line-based tools

### Decision 4: TypeScript Strict Mode
**Rationale:** Catch errors at compile time, not runtime.

**Configuration:**
```json
{
  "strict": true,
  "noImplicitAny": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true
}
```

---

## Common Patterns

### Pattern 1: Tool Implementation

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const myTool = createTool({
  id: 'my_tool',
  description: 'Clear description of what tool does',
  inputSchema: z.object({
    param: z.string().describe('Parameter description')
  }),
  execute: async (inputData): Promise<ToolResult> => {
    // Unwrap Mastra context wrapper
    const args = inputData.context || inputData;
    const startTime = performance.now();

    try {
      const result = await doWork(args.param);
      return {
        success: true,
        data: result,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(JSON.stringify({
        success: false,
        error: (error as Error).message,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString()
      }));
    }
  }
});
```

### Pattern 2: IPC Handler

```typescript
export function registerMyHandlers(
  service: MyService,
  window: BrowserWindow
) {
  ipcMain.handle('my:action', async (event, params: MyParams) => {
    try {
      const result = await service.doAction(params);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
```

### Pattern 3: React Component with Hooks

```typescript
interface MyComponentProps {
  id: string;
  onUpdate: (data: MyData) => void;
}

export const MyComponent: React.FC<MyComponentProps> = ({ id, onUpdate }) => {
  const [data, setData] = useState<MyData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [id]);

  async function loadData() {
    try {
      const result = await MyAPI.load(id);
      setData(result);
    } catch (error) {
      console.error('Failed to load:', error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (!data) return <ErrorMessage />;

  return <div>{/* Component content */}</div>;
};
```

---

## Testing Strategy

### Unit Tests
- Test core library in isolation
- Mock external dependencies
- Target: 80%+ coverage

### Integration Tests
- Test IPC communication
- Test agent with real API calls (mocked responses)
- Test storage persistence

### E2E Tests
- Use Playwright for Electron
- Test full user workflows
- Test renderer ↔ main ↔ gateway flow

---

## Performance Targets

- Cold start: <2 seconds
- First message response: <1 second
- Memory usage idle: <200MB
- No memory leaks (run for 24h)

---

## Security Considerations

### 1. API Key Storage
- Use electron-store with encryption
- Never log API keys
- Sanitize bash output for keys

### 2. Tool Execution
- Validate all tool inputs
- Timeout for long-running tools (30s)
- Sandbox for untrusted code (future)

### 3. IPC Security
- Validate all renderer inputs
- Use contextBridge (never nodeIntegration)
- Type all IPC channels

---

## Migration from V1

### Data Migration Tool
`scripts/migrate-v1-data.ts` converts V1 chat history to V2 format.

**Steps:**
1. Read V1 JSONL files
2. Convert to V2 format (CoreMessage)
3. Write to new location
4. Preserve metadata (timestamps, IDs)

### Breaking Changes
- Message format changed (simplified)
- Tool format changed (Mastra)
- Storage location changed

---

## Known Issues & Solutions

### Issue 1: Mastra Context Wrapper
**Problem:** Mastra wraps tool args in `{ context: args }`  
**Solution:** `const args = inputData.context || inputData;`

### Issue 2: Node Module Path Resolution
**Problem:** ES modules need file extensions  
**Solution:** Use `.js` extension even for `.ts` files: `import { X } from './X.js'`

### Issue 3: Electron + TypeScript
**Problem:** Need different configs for main/renderer 
**Solution:** Separate tsconfig files (tsconfig.main.json, tsconfig.renderer.json)

### Issue 4: Port Already in Use (EADDRINUSE)
**Problem:** Gateway port 18789 already in use when switching between dev/prod modes
**Solution:** Run `npm run kill:gateway` before starting app
**Prevention:** Always stop dev mode (`Ctrl+C`) before running production mode

### Issue 5: Electron Module System (ESM vs CommonJS)
**Problem:** `import { app } from 'electron'` fails - Electron doesn't support named ESM imports
**Root Cause:** `ELECTRON_RUN_AS_NODE=1` set globally makes `require('electron')` return string
**Solution:** Main process uses CommonJS (`.cjs`), preload uses CommonJS (`.cjs`), renderer uses ESM
**Architecture:** See `docs/ELECTRON_MODULE_SYSTEM.md` for complete architecture
**Fix:** `unset ELECTRON_RUN_AS_NODE` and use `.cjs` for main + preload processes

**IMPORTANT: Best Practice for Electron Module Systems**
```
Main + Preload = CommonJS (.cjs)  ← Node runtime, stable with require()
Renderer = ESM (Vite)             ← Browser runtime, native ESM
Gateway = ESM (.js)               ← Separate Node process, can use ESM
```

**Why:**
- Electron loads main/preload in Node.js context (better CommonJS support)
- Preload is security-sensitive (contextBridge works best with CJS)
- Renderer runs in Chromium (native ESM support)
- Gateway is separate Node.js process (no Electron constraints)

**Files:**
- `src/electron/index.cjs` - Main process (CommonJS)
- `src/electron/preload.cjs` - Preload (CommonJS) ✅ CRITICAL for security
- `src/gateway/*.ts` - Gateway (ESM via TypeScript)
- `ui/*.tsx` - Renderer (ESM via Vite)

### Issue 6: Native Module Version Mismatch
**Problem:** `better-sqlite3.node was compiled against a different Node.js version`
**Solution:** 
1. **CRITICAL:** Use Node v24+ (matching Electron 40's embedded Node v24.13.0)
2. Run `npx @electron/rebuild` after npm install or Node version changes
3. The `postinstall` script automatically rebuilds, but only if Node v24+ is used
**Why:** 
- Electron 40 uses embedded Node v24.13.0
- `@electron/rebuild` requires Node v24+ features (`util.styleText`)
- Native modules must be compiled for the same Node version as Electron's embedded Node
**Required:** Add `"engines": { "node": ">=24.0.0" }` to `package.json`

### Issue 7: Chat Streams and Titles Not Showing
**Problem:** WebSocket connection fails, chat streams and titles don't display
**Root Cause:** Gateway binding to wrong network interface + incorrect preload module system
**Solution:** 
1. Gateway binds to `0.0.0.0` (all interfaces)
2. UI connects to `ws://localhost:18789`
3. Preload uses CommonJS (`.cjs`) not ESM (`.mjs`)
**Fix Applied:** 2026-02-12
**Files Changed:**
- `src/gateway/index.ts` - HOST changed to `0.0.0.0`
- `src/electron/preload.cjs` - Converted from ESM to CommonJS
- `src/electron/index.cjs` - Added Gateway health check
**See:** `ELECTRON_MODULE_SYSTEM_FIX.md` for complete details

### Issue 8: Context Length Exceeded - Tool Results Accumulating ✅ FIXED
**Problem:** Agent hits "context_length_exceeded" error during tool-heavy conversations
**Root Cause:** Tool results (up to 100KB each) were loaded verbatim into LLM context on every turn, causing rapid context window exhaustion
**Solution:** Truncate tool results to 2000 chars max when loading into LLM context (full results preserved in storage for UI/debugging)
**Fix Applied:** 2026-02-19
**Impact:**
- **Before:** 10 tool calls with 50KB results each = 500KB = ~125K tokens just for tool results
- **After:** 10 tool calls truncated to 2KB each = 20KB = ~5K tokens
- **Savings:** ~120K tokens per conversation with heavy tool usage
**Files Changed:**
- `src/gateway/services/agent/historyFormatter.ts` - Added truncation logic with clear truncation markers
- `docs/TOOL_RESULT_TRUNCATION_FIX.md` - Complete documentation
**Testing:** Verified with long tool-heavy conversations (15+ tool calls) - no more context errors

### Issue 9: Gateway Hangs on Startup - Database Migration Blocked ✅ FIXED
**Problem:** Gateway process hangs during initialization, never completes startup. App shows "Gateway failed to start after 20 attempts" and UI won't load.
**Root Cause:** Stale SQLite WAL (Write-Ahead Log) files from previous session blocking database migration when new schema columns are added. The `better-sqlite3` native module hangs when trying to open the database with uncommitted WAL changes.
**Symptoms:**
- Gateway logs show: `[LocalStorageProvider] Opening database: ~/.paprwork-v2/chats.db` but never prints `[LocalStorageProvider] Database opened`
- WAL files exist: `chats.db-shm` (shared memory) and `chats.db-wal` (write-ahead log)
- Typically happens after adding new columns to the messages table schema

**Solution (Quick Fix):**
```bash
# Stop all processes
pkill -f "npm start" && pkill -f "electron" && sleep 2

# Backup and clear WAL files
cd ~/.paprwork-v2
mv chats.db chats.db.backup
mv chats.db-shm chats.db-shm.backup 2>/dev/null
mv chats.db-wal chats.db-wal.backup 2>/dev/null

# Start app (creates fresh DB with migration)
npm start

# If successful, restore data
# Stop app, then:
rm -f chats.db chats.db-shm chats.db-wal
cp chats.db.backup chats.db
npm start  # Migration runs on restored data
```

**Solution (Rebuild Native Module):**
```bash
# If WAL cleanup doesn't work, rebuild better-sqlite3
npx @electron/rebuild -f -w better-sqlite3
```

**Prevention:**
- Ensure proper Gateway shutdown (wait for `SIGTERM` handler to complete)
- Database connections should be closed in shutdown handler
- WAL mode is necessary for concurrency but requires clean shutdowns

**Fix Applied:** 2026-02-20
**Files Changed:**
- Added detailed logging to `LocalStorageProvider.ts` to identify hang point
- Added logging to `StorageManager.ts` and `AgentService.ts` for initialization tracking
**Why It Happens:**
- Schema migrations add columns via `ALTER TABLE` 
- If WAL has uncommitted transactions, SQLite blocks waiting for them
- Child process (Gateway) doesn't have access to clean up parent's WAL state
**Long-term Fix:** Add database cleanup in Gateway shutdown handler to properly close connections and checkpoint WAL files before exit.

### Issue 10: npm install Not Installing UI Dependencies ✅ FIXED
**Problem:** Users running `npm install` then `npm run build` getting errors like:
```
[vite]: Rollup failed to resolve import "remark-gfm" from "ui/components/common/Markdown.tsx"
```
**Root Cause:** Project had two separate `package.json` files (root and `ui/`). When users ran `npm install` at root, it only installed root dependencies, not the nested `ui/package.json` dependencies. When Vite tried to build the UI, it couldn't find the UI packages.
**Solution:** Configure npm workspaces to make `npm install` handle all nested package.json files automatically.
**Fix Applied:** 2026-02-24
**Files Changed:**
- `package.json` - Added `"workspaces": ["ui"]` field
- `ui/package.json` - Added `"private": true`, moved all UI-specific dependencies here (TipTap, markdown rendering, syntax highlighting)
- `README.md` - Added workspace installation instructions
- `docs/NPM_WORKSPACES_SETUP.md` - Complete documentation
**How It Works:**
- Root `npm install` now installs dependencies from both `package.json` and `ui/package.json`
- All packages hoisted to root `node_modules/` (deduplication)
- No separate `ui/node_modules/` needed
- Single `package-lock.json` tracks everything
**User Instructions:** Just run `npm install` once at root. No need to `cd ui && npm install` separately!

---

## OAuth & pi-ai Architecture

Users can use **subscription OAuth** (ChatGPT Plus/Pro, Claude Pro/Max) or **API keys** for OpenAI and Anthropic models. Routing depends on auth type:

### Routing Logic

| Auth Type | OpenAI (gpt-5.2, gpt-5.3-codex) | Anthropic (Claude) | Google (Gemini) |
|-----------|----------------------------------|--------------------|-----------------|
| **OAuth** | pi-ai (`openai-codex`)           | pi-ai (`anthropic`) | N/A (API key only) |
| **API key** | AI SDK (Platform API)          | AI SDK (Mastra)    | AI SDK (Mastra) |

**Why two paths?** The OpenAI Platform API requires `api.responses.write` scope and Platform API keys. ChatGPT OAuth tokens use a different backend (`chatgpt.com/backend-api`) and don't have those scopes. pi-ai's `openai-codex` provider talks to the ChatGPT backend directly. Same idea for Claude: OAuth uses a different endpoint than the Platform API.

### Key Flow

1. **Key resolution** (`keyResolver.ts`): `getProviderAuth()` must request keys first (triggers IPC), then check OAuth. The main process sends `oauthTokens` in the KEYS_RESPONSE; the gateway caches them. If we checked OAuth before requesting keys, the cache would be empty and we'd incorrectly return `apiKey` type → wrong routing.

2. **Agent WebSocket** (`agent.ts`): Fetches auth via `getProviderAuth()`, passes `authType: "oauth" | "apiKey"` into `configInternal`.

3. **AgentService** (`AgentService.ts`): Uses `config.authType` to decide:
   - `authType === "oauth"` for OpenAI or Anthropic → pi-ai (subscription APIs)
   - Otherwise → AI SDK (Platform API, Mastra)

### Files

- `src/gateway/utils/keyResolver.ts` - `getProviderAuth()` (request keys first, then check OAuth)
- `src/gateway/websocket/agent.ts` - Resolves auth, passes `authType` to config
- `src/gateway/services/AgentService.ts` - Routing: pi-ai vs AI SDK
- `src/gateway/services/providers/` - PiCodexStreamWithToolLoop, piAiHelpers
- `src/electron/index.cjs` - Sends `oauthTokens` in KEYS_RESPONSE when OAuth connected

### Model Mapping (OpenAI OAuth)

For `openai` provider with OAuth, model IDs are normalized for pi-ai:
- `gpt-5.2-low`, `gpt-5.2-high` → `gpt-5.2` (reasoning effort passed separately)
- `gpt-5.2-codex`, `gpt-5.3-codex` → passed through as-is

---

## Resources & References

### External
- [Mastra Documentation](https://mastra.ai/docs)
- [Electron TypeScript Guide](https://electron-vite.org/)
- [OpenClaw Repository](https://github.com/openclaw/openclaw)
- [AI SDK Documentation](https://sdk.vercel.ai/docs)

### Internal - Agent Documentation
- `src/resources/agent-docs/AGENT_JOB_OUTPUT_GUIDE.md` - Complete guide to job outputs and delivery
- `src/resources/agent-docs/DELEGATION_STRATEGY.md` - Sub-agent delegation patterns
- `src/resources/agent-docs/APP_AND_JOBS_GUIDE.md` - Apps and jobs architecture
- `src/resources/agent-docs/SUBAGENT_CREATION_GUIDE.md` - Creating specialized sub-agents
- `src/resources/agent-docs/00-START-HERE.md` - Complete tool reference

### Internal - Implementation Docs
- V1 codebase: `../paprwork` (legacy version)
- V1 docs: `../paprwork/docs` (legacy docs)
- V1 architecture analysis: Legacy migration notes (see `docs/legacy-notes/`)
- `docs/AGENT_JOB_OUTPUT_IMPLEMENTATION.md` - Job output patterns (2026-02-19)

---

## Next Steps

### Week 1 ✅ (Completed)
- [x] Project setup
- [x] TypeScript configuration
- [x] Core types defined
- [x] SessionManager implemented
- [x] ToolRegistry implemented
- [x] MastraAgent implemented

### Week 2 (Current)
- [ ] Tool implementations (bash, filesystem)
- [ ] Main process services
- [ ] IPC handlers
- [ ] Basic UI setup

### Week 3-6
- See PLAN.md for detailed timeline

---

## Code Quality Checklist

Before committing any code, verify:
- [ ] No `any` types used
- [ ] All functions have return types
- [ ] All parameters are typed
- [ ] File is <500 lines
- [ ] Tests added for new features
- [ ] No console.log (use proper logging)
- [ ] Error handling included
- [ ] TypeScript strict mode passes

---

## OpenClaw Learnings (179k ⭐)

Analyzed OpenClaw's repository for proven patterns at scale.

### 1. **Automated LOC Enforcement** ✅
```json
// package.json
"check:loc": "node --import tsx scripts/check-ts-max-loc.ts --max 500"
```
**Learning:** Automate file size checks in CI. We should add this!

### 2. **Comprehensive Testing Strategy** ✅
OpenClaw uses multiple vitest configs:
- `vitest.config.ts` - Unit tests
- `vitest.e2e.config.ts` - End-to-end tests
- `vitest.live.config.ts` - Live API tests
- `vitest.gateway.config.ts` - Gateway-specific tests
- `vitest.extensions.config.ts` - Extension tests

**Learning:** Separate test configs for different test types. Better organization.

### 3. **Modern Build Tooling** ✅
- **tsdown** - Fast TypeScript bundler (instead of tsc)
- **oxfmt** - Fast code formatter (Rust-based)
- **oxlint** - Fast linter (Rust-based, 50-100x faster than ESLint)

**Learning:** Consider switching to Rust-based tools for speed.

### 4. **Protocol Schema Generation** ✅
```json
"protocol:gen": "node --import tsx scripts/protocol-gen.ts",
"protocol:gen:swift": "node --import tsx scripts/protocol-gen-swift.ts"
```

They generate TypeScript types from schemas and sync to Swift for iOS/macOS.

**Learning:** Generate types from single source of truth. Especially useful for IPC protocol.

### 5. **CLI Entry Pattern** ✅
Simple `openclaw.mjs` wrapper:
```javascript
#!/usr/bin/env node
import('./dist/cli-entry.js');
```

**Learning:** Thin wrapper for CLI, actual logic in TypeScript.

### 6. **Documentation Automation** ✅
```json
"docs:check-links": "node scripts/docs-link-audit.mjs",
"lint:docs": "pnpm dlx markdownlint-cli2",
"docs:build": "cd docs && mint broken-links"
```

**Learning:** Automate doc quality checks. Broken links, markdown linting.

### 7. **Parallel Testing** ✅
```json
"test": "node scripts/test-parallel.mjs"
```

Custom script to run tests in parallel for speed.

**Learning:** Don't just use default vitest - optimize test execution.

### 8. **Platform-Specific Scripts** ✅
Clean separation:
- `mac:package`, `mac:restart`
- `ios:build`, `ios:run`
- `android:assemble`, `android:install`

**Learning:** Clear naming conventions for platform-specific tasks.

### 9. **Pre-commit Hooks** ✅
```json
"prepare": "command -v git >/dev/null 2>&1 && git config core.hooksPath git-hooks || exit 0"
```

**Learning:** Set up git hooks on npm install. Enforce quality before commit.

### 10. **TypeScript Config** ✅
```json
{
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "target": "es2023",
  "strict": true,
  "skipLibCheck": true  // For speed
}
```

**Learning:** Use `NodeNext` for modern ESM + CommonJS interop.

### 11. **Plugin System Architecture** ✅
Separate plugin SDK:
```json
"exports": {
  ".": "./dist/index.js",
  "./plugin-sdk": "./dist/plugin-sdk/index.js"
}
```

**Learning:** Export plugin SDK separately for extensibility.

### 12. **Minimal Dependencies for Core** ✅
OpenClaw's core uses:
- `@mariozechner/pi-coding-agent` (their Mastra equivalent)
- Zod for schemas
- Vitest for testing
- Modern tooling (no webpack, no babel)

**Learning:** Keep core lean. Use modern tools that don't need polyfills.

### What We're Adopting (OpenClaw Architecture)

**✅ Phase 1: Core App (Weeks 1-6) - IN PROGRESS**
1. ✅ Electron + TypeScript foundation
2. ✅ Automated LOC check (`scripts/check-max-lines.ts`)
3. ✅ Multiple vitest configs (unit/integration/e2e)
4. ✅ Rust dev tools (oxlint) - **ADOPTED FROM DAY 1**
5. ⏳ Protocol generation (IPC types from schema)
6. ⏳ Pre-commit hooks

**📱 Phase 2: Companion Apps (Post V2.0)**
7. ⏳ Swift macOS menu bar app
   - System tray integration
   - Native notifications
   - Calendar/Contacts access
   - Communicates via WebSocket to Core
8. ⏳ Swift iOS companion app
   - Voice input
   - Camera integration
   - Push notifications
   - Mobile chat interface

**⚡ Phase 3: Performance (Ongoing)**
9. 🔄 Rust-based tools (50-100x faster dev workflow)
10. ⏳ Parallel test runner
11. ⏳ Doc automation

**🔌 Phase 4: Extensibility (Future)**
12. ⏳ Plugin SDK
13. ⏳ Extension marketplace

### Key Differences

| Feature | OpenClaw | Paprwork V2 |
|---------|----------|-------------|
| Agent Framework | pi-coding-agent | Mastra |
| Module System | NodeNext (ESM) | ESNext (ESM) |
| Build Tool | tsdown | tsc + vite |
| Linter | oxlint (Rust) | oxlint (Rust) ✅ |
| Formatter | oxfmt (Rust) | oxfmt (Rust, Phase 2) |
| CLI | openclaw.mjs | TBD |
| Monorepo | pnpm workspaces | No (yet) |

---

## 🏆 Jobs & Automation Architecture

**CRITICAL FINDING:** Paprwork's automation architecture is **BETTER than OpenClaw's**!

### OpenClaw's Approach
- ❌ **Ephemeral** - Cron triggers agent turn, no persistence
- ❌ **Agent-only** - Everything through AI (slow, expensive)
- ❌ **No job storage** - Can't version control, can't debug easily
- ❌ **No mini-apps** - Chat interface only
- ❌ **No SQLite** - Data in agent memory (slow queries, API costs)

### Paprwork's Approach (SUPERIOR)
- ✅ **Persistent jobs** - `~/papr-jobs/{id}/` with code, venv, data.db
- ✅ **Multi-runtime** - Python/Node/Swift (fast, cheap)
- ✅ **Agent jobs** - AI tasks as first-class job type
- ✅ **Mini-apps** - UNIQUE feature OpenClaw lacks
- ✅ **SQLite per job** - Fast queries, no API costs
- ✅ **Job dependencies** - Auto-chaining, parallel execution
- ✅ **Virtual envs** - Proper Python package isolation

### Architecture Comparison Score: **Paprwork 7 - OpenClaw 2** 🏆

**See:** [PAPRWORK_VS_OPENCLAW.md](../docs/architecture/PAPRWORK_VS_OPENCLAW.md) for detailed analysis.

### What to Adopt from OpenClaw

**For Agent Jobs:**
1. ✅ Isolated sessions (`job:{id}:{timestamp}`)
2. ✅ Delivery mechanism (send results to chat)
3. ✅ Session cleanup (delete after completion)

**Don't Adopt:**
- ❌ Ephemeral scripts (lose debugging, version control)
- ❌ Agent-only approach (lose performance, cost benefits)
- ❌ No persistent storage (lose data advantages)

### Final Architecture for V2

```
Gateway Process
├── JobsManager (Unified System)
│   ├── Script Jobs (Python/Node/Swift)
│   │   └─ Persistent: code, venv, data.db, logs
│   └── Agent Jobs (AI tasks)
│       └─ Isolated sessions, tool access, delivery
│
├── MiniAppsManager (UNIQUE to Paprwork!)
│   └─ TypeScript apps querying job SQLite databases
│
└── SubAgentManager (Multi-agent coordination)
    └─ Research, Code Review, Writing specialists
```

**Best of both worlds:** Paprwork's powerful infrastructure + OpenClaw's agent patterns.

---

## 📋 Plan Enforcement for Mini-Apps & Jobs

**CRITICAL:** Agents MUST create plans before working on mini-apps or jobs (creating OR updating).

### Why Plans Matter
1. ✅ **User Transparency** - Shows approach before implementation
2. ✅ **Progress Tracking** - Visible checkboxes in UI
3. ✅ **Resumability** - Continue work after chat closes/reopens
4. ✅ **Professionalism** - Structured, organized workflow

### Multi-Layer Enforcement Strategy

We enforce plan creation through **4 reinforcing layers**:

1. **Tool Catalog** - Planning marked as "REQUIRED" in capability matrix
2. **Tool Description** - `create_plan` description emphasizes requirement
3. **Always-On Reminder** - Section in every system prompt about plan requirement
4. **App Creation Playbook** - STEP 0: Create Plan (REQUIRED)

### When Plans Are Required

✅ **ALWAYS create plan for:**
- Creating new mini-apps
- Creating new jobs (Python/Node/Agent)
- Updating existing apps (adding features, refactoring)
- Updating existing jobs (changing logic)
- Any multi-step task (3+ steps)

🔶 **Exception (no plan needed):**
- Trivial text-only changes (typos, color tweaks, static strings)

**Rule of thumb:** If it involves logic, structure, or could break functionality → CREATE A PLAN FIRST.

### Plan Persistence & Resumption

- **Storage:** `~/PAPR/data/plans.db` (SQLite)
- **Associated with:** `chatId`
- **Status:** `active`, `completed`, or `cancelled`
- **On chat reopen:** Active plans automatically loaded into system prompt with progress indicators (☑/▶/☐)

**See:** [PLAN_ENFORCEMENT_STRATEGY.md](docs/PLAN_ENFORCEMENT_STRATEGY.md) for complete details, examples, and verification checklist.

---

## Contributing Guidelines

1. **TypeScript Only** - No JavaScript files
2. **Small Files** - Max 500 lines (will be enforced by CI)
3. **Type Safety** - Never use `any`
4. **Test Coverage** - Add tests for new features
5. **Documentation** - Update this file with learnings
6. **Pre-commit Checks** - Code quality enforced automatically

---

**This file is living documentation. Update it as we learn and make decisions.**
