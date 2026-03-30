# CLAUDE.md - Project Context & Learnings

**Last Updated:** 2026-03-18

This file tracks key learnings, architectural decisions, and context for AI assistants working on Paprwork V2.

---

## Project Overview

**Paprwork V2** is a complete greenfield rewrite using OpenClaw's proven architecture:
- **Core App:** Electron + TypeScript (cross-platform: Mac, Windows, Linux)
- **Companion Apps:** Swift for native macOS/iOS features (future)
- **Dev Tools:** Rust-based tools for faster development
- **Local AI:** Ollama integration for on-device inference (privacy + zero cost)

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

### Issue 10: OAuth Context Management ✅ FIXED
**Problem:** ChatGPT/Claude OAuth routes hit "context_length_exceeded" errors during tool-heavy conversations
**Root Cause:** Pi-ai OAuth path (`PiCodexStreamWithToolLoop`) lacked context truncation and summarization that AI SDK path had
**Solution:** 
1. Added adaptive tool result truncation to `appendToolTurnToContext()` (matches AI SDK's `prepareStep` logic)
2. Added context pressure monitoring to `createPiCodexStreamWithToolLoop()` (tracks cumulative tokens, aborts at 120K)
3. Added auto-summarization callback from AgentService (triggers compression + retry on pressure)
**Fix Applied:** 2026-03-03
**Impact:**
- **Before:** OAuth routes crashed after 10-15 tool calls with large results
- **After:** Adaptive truncation + auto-summarization at 120K tokens (same as API key route)
- **Result:** OAuth and API key routes now have identical context management
**Files Changed:**
- `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts` - Added truncation + monitoring
- `src/gateway/services/AgentService.ts` - Added context pressure callback for pi-ai path
- `docs/OAUTH_CONTEXT_MANAGEMENT.md` - Complete documentation
**Testing:** Verified with 15+ tool calls in ChatGPT OAuth sessions - no more context errors, auto-compression works

### Issue 11: npm install Not Installing UI Dependencies ✅ FIXED
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

### Issue 12: Multi-Step Streaming Creating Multiple UI Cards ✅ FIXED
**Problem:** Multiple "Working/Thinking" cards displayed for single assistant response during multi-step tool calling
**Root Cause:** The AI SDK's `finish-step` chunk was yielding a `done` chunk, triggering premature frontend finalization and clearing the streaming message ref. The next `start-step` would then create a NEW message instead of continuing the existing one.
**Solution:** Changed `finish-step` to yield `step-usage` instead of `done`. Only the final `finish` triggers `done`.
**Fix Applied:** 2026-03-04
**Files Changed:**
- `src/gateway/services/agent/streamOrchestrator.ts` - Changed `finish-step` to yield `step-usage`
- `src/gateway/services/AgentService.ts` - Extract usage from both `done` and `step-usage`
- `src/core/types/streaming.ts` - Added `step-usage` to `StreamChunkType` union
- `docs/MULTI_STEP_STREAMING_FIX.md` - Complete documentation
**Impact:** Now shows ONE "Working on it..." card per assistant response, consolidating all thinking/tools/text

### Issue 13: Qwen Context Window Too Small - Tool Schema Truncation ✅ FIXED
**Problem:** Qwen 3.5 9B only seeing subset of tools (delegation/planning) and claiming no access to core tools (bash, filesystem, browser)
**Root Cause:** Ollama's default `num_ctx` is 4096 tokens. With 70 tools consuming ~8.5K tokens, Ollama was truncating the prompt from 11,483 tokens to 4,096, cutting off most tool schemas.
**Evidence:** `[Ollama] level=WARN msg="truncating input prompt" limit=4096 prompt=11483 keep=4 new=4096`
**Solution:** Set `num_ctx: 32768` in Ollama provider options (Qwen 3.5 supports up to 128K)
**Fix Applied:** 2026-03-04
**Files Changed:**
- `src/gateway/services/AgentService.ts` - Added `options: { num_ctx: 32768 }` to `providerOptions.ollama`
- `docs/QWEN_CONTEXT_WINDOW_FIX.md` - Complete documentation with context window guidelines
**Impact:** Qwen now sees all 70 tools, can use core tools like bash/filesystem/browser
**Prevention:** Always set `num_ctx` to at least 4x tool schema size for Ollama models

### Issue 14: IPC Channel Closed - Gateway Crashes ✅ FIXED
**Problem:** Gateway process crashes with `ERR_IPC_CHANNEL_CLOSED` when bash tool tries to access custom keys
**Root Cause:** `CustomKeysService.listKeys()` called `process.send()` without checking if IPC channel was still open. When main process disconnects (shutdown, termination), the gateway throws unhandled exception.
**Error:** `Error [ERR_IPC_CHANNEL_CLOSED]: Channel closed at target.send (node:internal/child_process:753:16)`
**Solution:** 
1. Added `checkIpcAvailable()` method checking `process.send` and `process.connected`
2. Added `safeSend()` wrapper with try-catch for `ERR_IPC_CHANNEL_CLOSED`
3. Added `ipcAvailable` state tracking to avoid repeated failed attempts
4. All IPC methods now fall back gracefully to dev mode (env vars, empty arrays)
**Fix Applied:** 2026-03-16
**Files Changed:**
- `src/gateway/services/CustomKeysService.ts` - Added graceful IPC channel handling
- `docs/IPC_CHANNEL_CLOSED_FIX.md` - Complete documentation and prevention guidelines
**Impact:**
- **Before:** Gateway crashes, agent stops, user sees error, must restart app
- **After:** Gateway continues, bash tool uses env vars, agent execution smooth, only warning logged
**Prevention:** Always check `process.connected` before `process.send()`, wrap in try-catch, provide fallbacks

### Enhancement 15: Custom Keys in /api/bash/run ✅ IMPLEMENTED
**Added:** 2026-03-18
**Problem:** Mini-apps couldn't access external databases (Neon PostgreSQL) or APIs because custom keys are stored in Keychain, not accessible from browser. Required workaround: create job → fetch data → save to SQLite → app reads SQLite (overly complex for simple queries).
**Solution:** Enhanced `/api/bash/run` endpoint to support `${KEY_NAME}` substitution (same pattern as bash tool and jobs)
**Implementation:**
1. Created `src/gateway/utils/keySubstitution.ts` - Centralized utility for loading and substituting custom keys
2. Enhanced `/api/bash/run` in `src/gateway/index.ts` to use key substitution before execution
3. Added output sanitization to prevent key leakage
4. Updated documentation and system prompt
**Usage:**
```typescript
// Mini-app calls /api/bash/run with ${KEY_NAME}
fetch('/api/bash/run', {
  method: 'POST',
  body: JSON.stringify({
    command: 'psql "${NEON_DB_URL}" -c "SELECT * FROM users LIMIT 10"'
  })
});
```
**Security:**
- Keys substituted server-side (never exposed to browser)
- Output sanitized to remove any leaked key values
- Same-origin only (iframe sandbox)
- No new attack surface (mini-apps already have bash access)
**Benefits:**
- Simple queries: 100-500ms (vs. 3-5s for job + SQLite)
- Real-time data access without background jobs
- Consistent `${KEY_NAME}` pattern across tools, jobs, and mini-apps
**Files Changed:**
- `src/gateway/utils/keySubstitution.ts` - NEW: Key loading + substitution utility
- `src/gateway/index.ts` - MODIFIED: Enhanced `/api/bash/run` endpoint
- `src/resources/agent-docs/APP_AND_JOBS_GUIDE.md` - MODIFIED: Added examples and guidance
- `src/core/agents/SystemPrompt.ts` - MODIFIED: Added agent guidance
- `docs/BASH_CUSTOM_KEYS_IMPLEMENTATION.md` - NEW: Complete implementation docs
**When to Use:**
- `/api/bash/run` + custom keys: Simple queries (<5s), real-time data, REST API calls
- Jobs + SQLite: Complex ETL, scheduled syncs, large datasets (>1MB)

### Issue 16: window.paprAPI Race Condition - Undefined at Runtime ✅ FIXED
**Problem:** Mini-apps getting `Uncaught TypeError: Cannot read properties of undefined (reading 'invoke')` when trying to use `window.paprAPI.invoke()`
**Root Cause:** Race condition between iframe content loading and paprAPI injection. Original implementation injected paprAPI **after** iframe load event, but mini-app scripts execute **during** load, before the injection happens.
**Symptom:** Agent correctly used `window.paprAPI.invoke('shell.openExternal', 'mailto:...')` but got runtime error because `window.paprAPI` was undefined.
**Solution:** Inject paprAPI as an **inline `<script>` tag** at the **beginning of iframe's `<head>`** in the DOM, ensuring it executes before any mini-app scripts.
**Fix Applied:** 2026-03-18
**Implementation:**
```typescript
// MiniAppView.tsx - Inject script tag into iframe DOM
const paprScript = iframeDocument.createElement('script');
paprScript.textContent = `window.paprAPI = { invoke: function(method, ...args) { ... } };`;
head.insertBefore(paprScript, head.firstChild); // Insert BEFORE any app scripts
```
**Why This Works:**
- Browser executes scripts in document order
- paprAPI script runs first (inserted at beginning of `<head>`)
- Mini-app scripts run second, `window.paprAPI` already available
**Files Changed:**
- `ui/components/Apps/MiniAppView.tsx` - Changed from contentWindow assignment to DOM script injection
- `docs/PAPR_API_INJECTION_FIX.md` - Complete technical documentation with alternatives analysis
**Impact:**
- **Before:** Agent used correct API syntax but got runtime error, confusing for users
- **After:** `window.paprAPI.invoke()` works immediately when mini-app code executes
**Prevention:** When injecting APIs into iframes, use DOM script injection instead of contentWindow property assignment to ensure proper execution order.

### Issue 17: GPT-5.4 Context Limit - Multiple Message Cards ✅ FIXED
**Problem:** GPT-5.4 Thinking via pi-ai hitting context limits quickly (after 10-15 tool calls), creating multiple assistant message cards when retrying instead of continuing in the existing message.
**Root Causes:**
1. **GPT-5.4's massive reasoning text:** 10-50KB per response (3-5x larger than Claude)
2. **One-size-fits-all threshold:** 120K for all models, but GPT-5.4 has 272K context (too conservative)
3. **Rough token estimation:** `length / 4` underestimates reasoning-heavy content
4. **Retry clears streaming state:** New stream → frontend creates new message card
**Solution:**
1. **Model-aware thresholds:** GPT-5.4 uses 200K threshold (vs 120K), Claude keeps 120K
2. **Preserve streaming message:** Don't finalize message on context limit errors
3. **Handle compression chunks:** `compression-start` and `compression-complete` don't create new message
4. **Pass model ID:** Enable threshold selection based on model
**Fix Applied:** 2026-03-19
**Implementation:**
```typescript
// PiCodexStreamWithToolLoop.ts - Model-aware thresholds
const getContextThreshold = (): number => {
  if (modelId?.startsWith('gpt-5.4')) return 200000; // 272K - 72K buffer
  if (modelId?.startsWith('gpt-5.2') || modelId?.startsWith('gpt-5.3')) return 200000;
  if (modelId?.includes('claude')) return 120000; // Conservative
  return 120000; // Safe default
};

// useAgent.ts - Preserve message during compression
case "error":
  const isContextLimitError = rawError.includes("Context limit approaching");
  if (isContextLimitError) {
    // DO NOT finalize - compression chunks will follow
  } else {
    finalizeStreamingMessage(...);
  }

case "compression-start":
  // Show indicator without finalizing
  sequence.push({ type: "text", data: "\n\n_Compressing..._\n\n" });
  // DO NOT clear state

case "compression-complete":
  // Remove indicator and continue
  // DO NOT clear state
```
**Files Changed:**
- `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts` - Model-aware thresholds
- `src/gateway/services/AgentService.ts` - Pass modelId
- `ui/hooks/useAgent.ts` - Compression chunk handlers, preserve streaming message
- `docs/GPT_5_4_CONTEXT_LIMIT_FIX.md` - Complete documentation
**Impact:**
- **Before:** Multiple message cards, 8-12 tool calls before compression
- **After:** Single message card, 20-30 tool calls before compression (67% improvement)
**Metrics:**

| Metric | Before | After |
|--------|--------|-------|
| GPT-5.4 threshold | 120K | **200K** ✅ |
| Tool calls before compression | 8-12 | **20-30** ✅ |
| Multiple message cards | ❌ Yes | ✅ No |

**Prevention:** Use model-aware thresholds instead of one-size-fits-all, preserve streaming state during retry mechanisms.

### Issue 18: esbuild Platform Mismatch - Mini-Apps Using Node.js APIs ✅ FIXED
**Added:** 2026-03-29
**Problem:** Mini-apps written by agent fail at runtime when they import Node.js modules (`fs`, `path`, `crypto`, etc.). Code transpiles successfully but crashes in the browser iframe with "module is not defined" errors.
**Root Cause:** The `esbuild.transform` call in Gateway was missing the `platform` option, defaulting to `platform: 'browser'` implicitly. This is actually correct (mini-apps run in browser iframes), but the implicit default made it unclear, and agents weren't properly guided to avoid Node.js APIs.
**Solution:**
1. Made `platform: "browser"` **explicit** in esbuild.transform options for clarity
2. Added **validation** to detect Node.js imports and log warnings
3. Strengthened **agent guidance** in SystemPrompt emphasizing browser context
**Fix Applied:** 2026-03-29
**Implementation:**
```typescript
// src/gateway/index.ts - Mini-app transpilation
const nodeBuiltins = ["fs", "path", "crypto", "child_process", "os", "net", "http", "https", "stream", "buffer", "process"];
const hasNodeImports = nodeBuiltins.some(mod => 
  content.includes(`from '${mod}'`) || 
  content.includes(`from "${mod}"`) ||
  content.includes(`require('${mod}')`)
);

if (hasNodeImports) {
  console.warn(
    `[Gateway] Mini-app ${appId}/${requestedPath} imports Node.js modules. ` +
    `These APIs are not available in browser context. Use window.paprAPI.invoke() instead.`
  );
}

const result = await esbuild.transform(content, {
  loader: ext === ".tsx" ? "tsx" : "ts",
  format: "esm",
  target: "es2020",
  platform: "browser", // ✅ Explicit: mini-apps run in iframe (browser context)
  sourcemap: "inline",
});
```
**Files Changed:**
- `src/gateway/index.ts` - Added explicit `platform: "browser"`, added Node.js import validation
- `src/core/agents/SystemPrompt.ts` - Strengthened mini-app guidance with clear "Available/NOT Available" list
- `docs/ESBUILD_PLATFORM_MISMATCH.md` - Complete documentation
**Impact:**
- **Before:** Agent wrote Node.js-style code, transpiled successfully, failed at runtime with cryptic errors
- **After:** Explicit platform setting, warnings logged when Node imports detected, clearer agent guidance
- **Agent behavior:** Should now correctly use `window.paprAPI.invoke('bash.run', ...)` for file operations instead of importing `fs`
**Prevention:** 
1. Always set `platform` explicitly in esbuild configs (don't rely on defaults)
2. Validate code for platform-inappropriate imports before transpilation
3. Clear documentation: mini-apps = browser context, use paprAPI for system operations

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

## 🖥️ On-Device AI with Ollama

**Added:** 2026-03-03

Paprwork V2 supports running AI models locally using Ollama for complete privacy and zero API costs.

### Supported Models

- **Qwen 3.5 (0.8B - 27B)** - Multiple model sizes for different hardware
- 256K context window
- Runs completely on-device (no internet required)
- No API keys needed

### Quick Model Selection

| Your RAM | Recommended Model | Download Size |
|----------|-------------------|---------------|
| 8GB | Qwen 3.5 2B | 2.7 GB |
| 16GB | **Qwen 3.5 9B** ⭐ | 6.6 GB |
| 32GB+ | Qwen 3.5 27B | 17 GB |

**🌟 Most Popular:** Qwen 3.5 9B - best quality/performance balance for modern machines

### Key Benefits

1. ✅ **Complete Privacy** - All inference happens locally, no data sent to cloud
2. ✅ **Zero API Costs** - No per-token charges
3. ✅ **Offline Capable** - Works without internet connection
4. ✅ **Always Available** - No rate limits or quotas
5. ✅ **Auto-Install** - Just select a model, everything else is automatic

### Quick Start

```bash
# No manual installation needed!
# Just select a Qwen model in Paprwork:
# 1. Open model picker in chat
# 2. Select from "Ollama (On-Device)" group
# 3. Wait for auto-download (shows progress)
# 4. Chat runs 100% locally!
```

### Architecture Integration

- **Provider:** `ollama` (added to `Provider` union type)
- **Authentication:** None required (local inference)
- **SDK:** `ollama-ai-provider-v2` (AI SDK compatible)
- **Auto-Install:** `electron-ollama` (auto-downloads Ollama binaries)
- **Default Host:** `http://localhost:11434/api`
- **UI:** Always available in model picker (no API key check)
- **Storage:** Binaries in `userData/ollama`, models in Ollama's data directory

**See:** 
- [QWEN_MODEL_SELECTION_GUIDE.md](docs/QWEN_MODEL_SELECTION_GUIDE.md) - **Choosing the right model for your device**
- [OLLAMA_DOWNLOAD_TIME_EXPLANATION.md](docs/OLLAMA_DOWNLOAD_TIME_EXPLANATION.md) - **Why downloads take time & what we do about it**
- [OLLAMA_QWEN_SETUP.md](docs/OLLAMA_QWEN_SETUP.md) - Complete setup guide & troubleshooting
- [OLLAMA_AUTO_INSTALL_IMPLEMENTATION.md](docs/OLLAMA_AUTO_INSTALL_IMPLEMENTATION.md) - Technical architecture details

---

## 🚀 GPT-5.4 Support (Latest Model)

**Added:** 2026-03-05

Paprwork V2 now supports OpenAI's latest GPT-5.4 models with native computer use capabilities.

### Supported Models

- **GPT-5.4 Thinking** (`gpt-5.4`) - Latest model with 47% improved efficiency, native computer use
- **GPT-5.4 Pro** (`gpt-5.4-pro`) - Most powerful model for complex multi-step workflows

### Key Capabilities

1. ✅ **Native Computer Use** - Screenshot + keyboard/mouse control, Playwright automation
2. ✅ **Tool Search** - 47% token reduction on large tool sets (MCP Atlas benchmark)
3. ✅ **Enhanced Accuracy** - 33% fewer false claims vs GPT-5.2
4. ✅ **Large Context** - 1M token window (272K default, 2× pricing after)
5. ✅ **128K Output** - Massive output capability for long-form content

### Availability

| Route | Auth Method | Models Available |
|-------|-------------|------------------|
| AI SDK | API Key | gpt-5.4, gpt-5.4-pro ✅ |
| pi-ai | OAuth (ChatGPT Plus/Pro) | gpt-5.4, gpt-5.4-pro ✅ |

**Note:** GPT-5.4 models work with OAuth via manual model object creation. The model registry lookup is bypassed when needed, and model objects are created programmatically with the correct structure for ChatGPT's backend.

### Pricing (API)

- **GPT-5.4:** $2.50/$15.00 per 1M tokens (input/output)
- **GPT-5.4 Pro:** $30.00/$180.00 per 1M tokens (input/output)
- **Note:** 2× rate for inputs exceeding 272K tokens

### Architecture Integration

- **Model Definitions** - Added to `ui/constants/models.ts` with proper metadata
- **Cost Calculation** - Pricing added to `src/gateway/services/CostCalculation.ts`
- **Model Normalizer** - Added to `OPENAI_CODEX_MODELS` for OAuth routing
- **Delegation Tool** - Available for sub-agent creation
- **Auto-Handling** - ChatSessionManager, AgentService, streaming all work automatically

**See:** [GPT_5_4_INTEGRATION.md](docs/GPT_5_4_INTEGRATION.md) for complete documentation, usage examples, and benchmarks

---

### Enhancement 18: Job Scheduler Improvements (Run History + Error Classification) ✅ IMPLEMENTED
**Added:** 2026-03-28
**Problem:** Limited observability into job execution patterns, all errors treated the same (network blips retry forever, auth failures waste retries), agent jobs always returned exit code 0 even on failure.
**Solution:** 
1. Added run history tracking - persists every run to `~/Papr/data/job-runs.jsonl` with auto-pruning
2. Added transient/permanent error classification - network errors retry, auth errors stop immediately
3. Added log rotation - auto-prune logs >2MB to last 2000 lines
4. Added verbose scheduler logging - see what scheduler is doing on every tick
5. Fixed agent jobs to return proper exit codes (0 = success, 1 = failure)
**Implementation:**
1. Created `JobRunHistory` class for JSONL-based run persistence with statistics
2. Created `errorClassifier` to distinguish transient vs permanent errors
3. Added `pruneJobLog()` for automatic log rotation
4. Enhanced scheduler tick with detailed logging (enabled/due/launched/skipped counts)
5. Agent jobs now detect failures (exceptions, no output) and return exitCode: 1
**Agent Tools:**
- `get_job_history({ jobId, limit })` - Get last N runs with status, duration, timestamps
- `get_job_stats({ jobId })` - Get success rate, avg duration, failure counts
**Impact:**
- **Run history:** Can now answer "why did this fail 5 times yesterday?" and "how long do runs typically take?"
- **Error classification:** Auth errors fail fast (1 attempt), network errors retry with backoff (3 attempts)
- **Log rotation:** Prevents disk space issues (2MB limit per job)
- **Agent parity:** Agent jobs now have full parity with non-agent jobs for error handling
**Files Created:**
- `src/gateway/services/jobs/JobRunHistory.ts` - Run history persistence
- `src/gateway/services/jobs/errorClassifier.ts` - Error classification logic
- `docs/JOB_SCHEDULER_IMPROVEMENTS_2026-03-28.md` - Complete documentation
**Files Changed:**
- `src/gateway/services/JobsScheduler.ts` - Verbose logging
- `src/gateway/services/JobsService.ts` - Run history integration, error classification, log rotation
- `src/gateway/services/jobs/executors/AgentJobExecutor.ts` - Proper exit codes and error messages
- `src/core/tools/appJobs.ts` - New agent tools
- `src/core/tools/index.ts` - Export new tools
**Coverage:** ALL improvements apply to ALL job types (agent, subagent, shell, bash, node, python, swift)

### Enhancement 19: Comprehensive E2E Job Testing ✅ IMPLEMENTED
**Added:** 2026-03-28
**Problem:** No automated tests verifying the job scheduling system works end-to-end with real execution, scheduling, retry logic, run history tracking, agent jobs, or app restart scenarios.
**Solution:** Created two comprehensive E2E test suites covering bash, python, agent jobs, scheduling, error handling, retry logic, run history, app restart, and persistence.
**Implementation:**
1. **Basic E2E Script** (`scripts/test-jobs-e2e.mjs`) - 8 tests for bash, python, scheduling, retry, error classification, run history
2. **Advanced E2E Script** (`scripts/test-jobs-advanced.mjs`) - 8 tests for agent jobs, scheduled agents, app restart, persistence, interrupted job recovery, concurrent execution prevention
3. **Vitest Tests** (`tests/jobs-e2e-simple.test.ts`) - Unit tests for error classification and run history
4. **Testing Guide** (`docs/E2E_JOB_TESTING_GUIDE.md`) - Complete guide with verification checklist
**Tests (16 total):**
- **Non-Agent Jobs (6):** Bash execution, retry (3 attempts), Python venv, scheduled interval, scheduled cron, log rotation
- **Agent Jobs (3):** Agent execution, scheduled agent, agent retry
- **App Restart (4):** Job persistence, schedule reconciliation, run history persistence, interrupted job recovery
- **Concurrency (1):** Overlapping run prevention
- **Error Handling (2):** Transient vs permanent classification, retry behavior
**Bug Fixed:** Scheduler `patchNextRun` was using `new Date()` (current time) instead of `scheduledDueAt` as anchor, causing intervals to drift. Now uses the scheduled time as anchor for consistent intervals (job scheduled every 10s runs at T, T+10s, T+20s, not T, T+0.02s, T+0.04s).
**Commands:**
- `npm run test:jobs-e2e` - Basic tests (~14s)
- `npm run test:jobs-advanced` - Advanced tests (~5s)
**Result:** ✅ All 16 tests passing - agent jobs, scheduled jobs, and restart scenarios fully verified
**Files Created:**
- `scripts/test-jobs-e2e.mjs` - Basic E2E test suite
- `scripts/test-jobs-advanced.mjs` - Advanced E2E test suite
- `tests/jobs-e2e-simple.test.ts` - Vitest unit tests
- `docs/E2E_JOB_TESTING_GUIDE.md` - Testing guide
- `docs/E2E_JOB_TESTING_RESULTS.md` - Initial results summary
- `docs/COMPLETE_TEST_COVERAGE.md` - Complete coverage report
- `docs/QUICK_TEST_REFERENCE.md` - Quick command reference
**Files Changed:**
- `src/gateway/services/JobsScheduler.ts` - Fixed anchor calculation in `patchNextRun` (uses `scheduledDueAt` instead of `new Date()`)
- `package.json` - Added `test:jobs-e2e` and `test:jobs-advanced` scripts

### Enhancement 20: Papr Platform Login - Automatic API Key Provisioning ✅ IMPLEMENTED
**Added:** 2026-03-28
**Problem:** Users had to manually sign up at dashboard.papr.ai, navigate to API keys, copy the key, then paste it into Paprwork settings. This created friction during onboarding and made it harder for new users to experience Papr Memory features.
**Solution:** Integrated deep-link authentication flow with papr-dev-platform's existing desktop auth mechanism to automatically retrieve and store API keys directly from Paprwork's onboarding and settings screens.
**Implementation:**
1. Created `PaprLoginSection` React component with login/logout UI and status display
2. Created IPC handler (`paprLogin.ts`) with deep-link flow orchestration:
   - Opens dashboard at `/desktop-login?state=xxx` page
   - Generates random state parameter for CSRF protection
   - Handles `papr://auth/callback` deep links from dashboard
   - Validates state parameter before storing API key
   - Automatic storage in CustomKeysStorage (macOS Keychain)
3. Added Papr login section to onboarding (pre-step, marked "Recommended")
4. Added Papr login section to Settings → API Keys tab (top of page)
5. Registered `papr://` custom URL protocol in Electron app
**Deep Link Flow:**
1. User clicks "Login with Papr"
2. Browser opens to `dashboard.papr.ai/desktop-login?state=xxx`
3. Desktop login page stores state in localStorage (`papr_desktop_auth`)
4. Desktop login page redirects to Auth0 for authentication
5. User authenticates via Auth0
6. Dashboard redirects to `/get-started` page
7. Get Started page detects `papr_desktop_auth` in localStorage
8. Dashboard retrieves user's existing API key from profile
9. Dashboard redirects to `papr://auth/callback?api_key=xxx&state=xxx&email=xxx&user_id=xxx`
10. Paprwork catches the deep link via OS `open-url` event
11. Paprwork validates state parameter (CSRF protection)
12. Paprwork stores key in CustomKeysStorage as `PAPR_API_KEY`
13. UI shows "Connected to Papr" with user email
**Why Deep Links (Not GraphQL/OAuth):**
- Dashboard already has desktop auth flow built-in (`/desktop-login` page)
- No need for local callback server, token exchange, or GraphQL queries
- Dashboard handles all API key retrieval from user's existing profile
- Simpler, more reliable, leverages existing infrastructure
**API Key Format:** `sk-org-{orgId}-namespace-{namespaceId}-{32-random-chars}` (retrieved from user's existing keys, not created new)
**Security:**
- State parameter provides CSRF protection (32-char random value)
- API key only sent via deep link (never exposed in browser)
- API key stored in system keychain (macOS Keychain, Windows Credential Manager)
- State validation ensures callback came from legitimate login attempt
- 10-minute timeout for desktop auth localStorage data
**User Experience:**
- **First-time users:** Login during onboarding, API key auto-provisioned from existing dashboard profile
- **Existing users:** Login from Settings, retrieves their existing API key
- **Logout:** Removes PAPR_API_KEY from keychain
**Environment Variables:**
- `PAPR_PLATFORM_URL` - Platform URL (default: https://dashboard.papr.ai)
**Impact:**
- **Before:** 5-step manual process (sign up → verify email → navigate to API keys → copy → paste)
- **After:** 1-click login, automatic key retrieval, zero copy-paste
- **Code simplification:** Eliminated 200+ lines of OAuth/GraphQL code by using existing dashboard flow
**Files Created:**
- `ui/components/Settings/PaprLoginSection.tsx` - Login UI component
- `ui/components/Settings/PaprLoginSection.css` - Styles
- `src/electron/ipc/paprLogin.ts` - IPC handlers and deep-link logic
- `docs/PAPR_LOGIN_INTEGRATION.md` - Complete documentation
- `docs/PAPR_LOGIN_DEEP_LINK_FLOW.md` - Deep link flow explanation
**Files Changed:**
- `src/electron/index.cjs` - Initialize Papr login IPC, register `papr://` protocol, handle deep links
- `ui/types/electron.d.ts` - Add `papr` API namespace
- `ui/components/Settings/SettingsView.tsx` - Add PaprLoginSection
- `ui/components/Onboarding/OnboardingView.tsx` - Add Papr login section
- `ui/components/Onboarding/OnboardingView.css` - Add Papr section styles
- `.env.example` - Add PAPR_PLATFORM_URL configuration
**Testing:** Manual testing checklist in docs/PAPR_LOGIN_INTEGRATION.md

### Enhancement 21: Authentication Wall for Commercial Builds ✅ IMPLEMENTED
**Added:** 2026-03-29
**Problem:** Need to enforce Papr authentication for downloadable commercial version while keeping open-source version fully functional without Papr.
**Solution:** Implemented build-time configuration flag (`REQUIRE_PAPR_AUTH`) that shows a full-screen authentication wall when enabled, blocking all app access until user authenticates with Papr.
**Implementation:**
1. Created `AuthWall` component with beautiful UI:
   - Full-screen gradient background with frosted glass effect
   - Animated loading spinner during authentication
   - Real-time polling (checks login status every 2s)
   - Error handling and sign-up link
2. Added `REQUIRE_PAPR_AUTH` environment variable:
   - `false` (default): Open source mode, Papr login optional
   - `true`: Commercial mode, Papr login required
3. Modified `App.tsx` to conditionally render AuthWall before main app
4. Updated Vite config to expose env var to client code
**Authentication Flow (Commercial Mode):**
1. User launches app
2. App checks `REQUIRE_PAPR_AUTH` environment variable
3. If true, check for existing authentication in system keychain
4. If not authenticated, show AuthWall (blocks all features)
5. User clicks "Sign In with Papr"
6. Browser opens to `dashboard.papr.ai/desktop-login`
7. User completes login (existing flow)
8. Deep link fires: `papr://auth/callback?api_key=xxx`
9. Poll detects authentication, hides AuthWall
10. Full app access granted
**User Experience:**
- **Open Source Mode** (`REQUIRE_PAPR_AUTH=false`): App loads immediately, Papr login optional, all features accessible (except cloud sync)
- **Commercial Mode** (`REQUIRE_PAPR_AUTH=true`): Auth wall blocks access, must login before using any features, authentication persists across restarts
**Security:**
- API key stored in system keychain (persists across restarts)
- Same deep link flow with CSRF protection (state parameter)
- No API keys in source code or environment variables
**Build Commands:**
- Developer build: `npm run build` (default, auth optional)
- Release build: Set in `.github/workflows/release.yml` (auth required)
**Impact:**
- **GitHub Releases:** Downloadable binaries require Papr authentication
- **Source Code:** Developers building from source get optional authentication
- **Single Codebase:** No source code changes needed between modes
**Files Created:**
- `ui/components/Auth/AuthWall.tsx` - Authentication wall component
- `ui/components/Auth/AuthWall.css` - Frosted glass UI styles
- `docs/AUTH_WALL_IMPLEMENTATION.md` - Complete documentation
**Files Changed:**
- `ui/App.tsx` - Added auth check and AuthWall conditional rendering
- `ui/vite.config.ts` - Exposed REQUIRE_PAPR_AUTH to client
- `.env.example` - Added REQUIRE_PAPR_AUTH documentation
**Testing:** See docs/AUTH_WALL_IMPLEMENTATION.md for test procedures

### Enhancement 22: Mini-App Job Creation API ✅ IMPLEMENTED
**Added:** 2026-03-30
**Problem:** Mini-apps could only run existing jobs via `/api/jobs/run`. Users needed to pre-create all possible jobs upfront, even if they might never be used. This was inflexible for dynamic workflows where job requirements emerge at runtime (e.g., LinkedIn Autopilot creating action jobs on-demand when campaigns need them, user-configured data pipelines).
**Solution:** Added `/api/jobs/create` endpoint allowing mini-apps to programmatically create jobs with the same capabilities as the agent's `create_job` tool.
**Implementation:**
1. Added `/api/jobs/create` POST endpoint in Gateway (`src/gateway/index.ts`)
2. Rate limiting: 10 jobs per minute per app (prevents abuse)
3. Size validation: Command capped at 100KB (prevents massive job creation)
4. Full validation: All `CreateJobInput` Zod schema validation applies
5. No privilege escalation: Mini-apps already have bash access via `/api/bash/run`, creating jobs is just structured code execution
**Security Measures:**
- **Rate Limiting (Primary):** Per-app sliding window (10 jobs/min), returns 429 with wait time
- **Size Validation:** 100KB command max, returns 400 error
- **Zod Schemas:** Job type, schedule, dependencies, requirements validated
- **No New Capabilities:** Mini-apps already have bash + custom keys, jobs are just trackable
**Use Cases:**
- **Lazy Creation:** LinkedIn Autopilot creates "view_profile" job only when campaign needs it
- **User Workflows:** Data pipeline builders where users configure scrapers in UI
- **Dynamic Pipelines:** Workflow generators creating job chains (A → B → C) from user input
**API:**
```typescript
POST /api/jobs/create
Body: { name, type, command, requirements, schedule, dependsOn, ... } // CreateJobInput
Response: { success: true, jobId, name, type, status } | { error: string }
```
**Examples:**
```typescript
// Create on-demand job
const res = await fetch('/api/jobs/create', {
  method: 'POST',
  body: JSON.stringify({
    name: "LinkedIn View Profile Action",
    type: "python",
    command: "python3 code/view_profile.py",
    requirements: ["linkedin-api"],
    schedule: { enabled: true, intervalMs: 60000 }
  })
});
const { jobId } = await res.json();
```
**Architecture Benefits:**
- **Before:** Pre-create all possible jobs → cron overhead for unused jobs, less flexible
- **After:** Hybrid approach → pre-create common jobs (reliability) + dynamic creation (flexibility)
**Impact:**
- **Before:** Must anticipate all job types upfront, unused jobs consume cron cycles
- **After:** Create jobs on-demand, cleaner architecture, more flexible workflows
**Files Created:**
- `docs/MINI_APP_JOB_CREATION.md` - Complete feature documentation
- `docs/JOB_CREATION_API_SUMMARY.md` - Implementation summary
- `scripts/test-job-creation-api.mjs` - Automated test script (basic creation, rate limiting, size validation)
**Files Changed:**
- `src/gateway/index.ts` - Added `/api/jobs/create` endpoint with rate limiter and validation
- `src/core/agents/SystemPrompt.ts` - Added section "6. Mini-Apps Can Create Jobs Programmatically" with usage examples
**Testing:** `node scripts/test-job-creation-api.mjs` (requires Gateway running)

---

### Enhancement 21: Authentication Wall for Commercial Builds ✅ IMPLEMENTED
**Added:** 2026-03-18
**Problem:** Open-source repo needs downloadable releases that require Papr authentication, while keeping it optional for developers
**Solution:** Build-time flag (`REQUIRE_PAPR_AUTH`) enforces authentication only in GitHub release builds via environment variable
**Implementation:**
1. Created `AuthWall` component (liquid glass aesthetic) shown on app launch before any other content
2. Added `REQUIRE_PAPR_AUTH` environment variable (false in dev, true in release builds)
3. Modified GitHub Actions workflow to set `REQUIRE_PAPR_AUTH=true` in release builds
4. Authentication check runs BEFORE loading preferences/SQLite to eliminate flicker
5. Integrated with deep link OAuth flow (redirects to sign-up page via `screen_hint=signup`)
**User Experience:**
- **Open-source devs:** No auth wall, optional Papr login in settings
- **Downloaded releases:** Auth wall blocks access until authenticated, seamless profile sync
**Files Created:**
- `ui/components/Auth/AuthWall.tsx` - Full-screen authentication gate
- `ui/components/Auth/AuthWall.css` - Liquid glass styling
- `docs/AUTH_WALL_IMPLEMENTATION.md` - Complete documentation
**Files Changed:**
- `ui/App.tsx` - Auth check before app load, conditional AuthWall rendering
- `ui/vite.config.ts` - Expose `VITE_REQUIRE_PAPR_AUTH` to client
- `.env.example` - Added `REQUIRE_PAPR_AUTH` (default: false)
- `.github/workflows/release.yml` - Set `REQUIRE_PAPR_AUTH=true` for release builds
- `src/electron/ipc/paprLogin.ts` - Refined deep link handling
- `CLAUDE.md` - Updated Enhancement 20 with final deep-link approach
**Impact:**
- **Before:** Open-source + downloadable builds identical, no monetization path
- **After:** Open-source remains free, downloadable releases gated by Papr auth

### Enhancement 22: Papr Profile Sync ✅ IMPLEMENTED
**Added:** 2026-03-28
**Problem:** Users authenticate with Papr but their profile info (name, image, email from Auth0 onboarding) isn't available in Paprwork
**Solution:** After authentication, automatically fetch user profile from dashboard's `/api/user-info` endpoint and store in settings, auto-populate profile fields
**Implementation:**
1. Added `paprProfile` field to `AppSettings` interface with userId, email, displayName, profileImage, authenticatedAt
2. Created `setPaprProfile()`, `getPaprProfile()`, `clearPaprProfile()` methods in SettingsStorage
3. Enhanced `handlePaprAuthCallback()` to fetch profile from `dashboard.papr.ai/api/user-info` using API key
4. Added `papr:get-profile` IPC handler to expose profile to renderer
5. Enhanced Settings → Profile tab to display Papr account info and auto-populate manual fields
**User Experience:**
- **After sign-up:** Profile (name, image from Auth0) automatically synced to Paprwork
- **Settings → Profile:** Shows "Papr Account" section (read-only) + editable "Your Profile" fields
- **Auto-populate:** Manual profile fields pre-filled from Papr data if empty
- **On logout:** Papr profile cleared, manual profile unchanged
**API Integration:**
- Endpoint: `GET https://dashboard.papr.ai/api/user-info`
- Auth: `X-API-Key` header
- Returns: displayName, profileImage, email, userId, etc.
**Files Created:**
- `docs/PAPR_PROFILE_SYNC.md` - Complete feature documentation
**Files Changed:**
- `src/core/types/storage.ts` - Added `paprProfile` to AppSettings
- `src/core/storage/SettingsStorage.ts` - Added profile management methods
- `src/electron/ipc/paprLogin.ts` - Profile fetching logic + `fetchUserProfile()` helper
- `src/electron/index.cjs` - Pass settingsStorage to paprLogin handlers
- `src/electron/preload.cjs` - Added `getProfile()` to papr namespace
- `ui/types/electron.d.ts` - Type definitions for profile API
- `ui/components/Settings/SettingsView.tsx` - Profile display + auto-populate logic
**Impact:**
- **Before:** Users authenticate but must manually enter profile info
- **After:** Profile synced automatically from Papr account, seamless onboarding

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
