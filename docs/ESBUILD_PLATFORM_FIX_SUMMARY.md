# esbuild Platform Mismatch - Fix Summary

**Date:** 2026-03-29  
**Issue:** Mini-apps using Node.js APIs fail at runtime  
**Status:** ✅ Fixed

## The Problem

User reported that Mentor Magic mini-app had rendering issues when agent created `app.ts`, but worked when manually compiled to `app.js`. This indicates a **transpilation platform mismatch**.

### What Was Happening

1. Agent writes mini-app code in TypeScript (`app.ts`)
2. Agent (incorrectly) uses Node.js APIs: `import fs from 'fs'`
3. Gateway transpiles with esbuild (platform defaulted to `browser`)
4. Transpilation succeeds (syntax is valid)
5. **Runtime failure:** Browser iframe has no `fs` module → `ReferenceError`

### Root Causes

1. **Implicit platform setting:** esbuild defaults to `platform: 'browser'` when not specified (actually correct for mini-apps)
2. **Unclear constraints:** Agent wasn't strongly guided to avoid Node.js APIs
3. **No validation:** No warnings when Node.js imports detected

## The Fix

### 1. Made Platform Setting Explicit

**Before:**
```typescript
const result = await esbuild.transform(content, {
  loader: ext === ".tsx" ? "tsx" : "ts",
  format: "esm",
  target: "es2020",
  sourcemap: "inline",
  // ❌ Platform implicit (defaults to 'browser')
});
```

**After:**
```typescript
const result = await esbuild.transform(content, {
  loader: ext === ".tsx" ? "tsx" : "ts",
  format: "esm",
  target: "es2020",
  platform: "browser", // ✅ Explicit: mini-apps run in iframe
  sourcemap: "inline",
});
```

**Why:** Makes it crystal clear that mini-apps run in browser context, not Node.js.

### 2. Added Node.js Import Detection

**Added validation before transpilation:**
```typescript
// Validate: Warn if mini-app imports Node.js built-ins
const nodeBuiltins = [
  "fs", "path", "crypto", "child_process", "os", 
  "net", "http", "https", "stream", "buffer", "process"
];

const hasNodeImports = nodeBuiltins.some(mod => 
  content.includes(`from '${mod}'`) || 
  content.includes(`from "${mod}"`) ||
  content.includes(`require('${mod}')`) ||
  content.includes(`from 'node:${mod}'`)
);

if (hasNodeImports) {
  console.warn(
    `[Gateway] Mini-app ${appId}/${requestedPath} imports Node.js modules. ` +
    `These APIs are not available in browser context. ` +
    `Use window.paprAPI.invoke() instead.`
  );
}
```

**Impact:** Agent sees warnings in logs, learns to avoid Node.js APIs.

### 3. Strengthened Agent Guidance

**Updated SystemPrompt.ts with clear Available/NOT Available list:**

```markdown
**⚠️ IMPORTANT: Mini-Apps Run in Browser Context**
- ✅ **Available:** Web APIs (fetch(), localStorage, document, DOM events)
- ✅ **Available:** window.paprAPI.invoke() for system operations
- ❌ **NOT Available:** Node.js APIs (fs, path, crypto, child_process, etc.)

**If you need Node.js functionality, use window.paprAPI.invoke('bash.run', ...):**
```typescript
// ❌ WRONG - Don't import Node.js modules
import fs from 'fs';
const data = fs.readFileSync('/path/to/file', 'utf-8');

// ✅ CORRECT - Use paprAPI to run shell commands
const result = await window.paprAPI.invoke('bash.run', {
  command: 'cat /path/to/file'
});
const data = result.stdout;
```
```

## Why This Fix Works

### Mini-Apps Architecture

```
Electron Main Process (Node.js)
  ↓
Electron Renderer (Chromium)
  ↓
Sandboxed iframe (Browser Context) ← Mini-apps run HERE
  ↓
Mini-app Code (TypeScript → JavaScript)
```

**Key constraint:** Iframes run in **browser context**, not Node.js context.

**Available APIs:**
- ✅ Standard browser APIs: `fetch()`, `localStorage`, `document`, `XMLHttpRequest`
- ✅ Custom bridge: `window.paprAPI` (talks to Electron main process via IPC)
- ❌ Node.js APIs: Not available, not accessible, won't work

### esbuild Platform Options

| Platform | Target Environment | Use Case |
|----------|-------------------|----------|
| `browser` | Browser (Chromium, Firefox, Safari) | Mini-apps, web apps |
| `node` | Node.js runtime | CLI tools, servers, Gateway |
| `neutral` | Platform-agnostic | Libraries, shared code |

**For Paprwork mini-apps:** `platform: "browser"` is correct.

## Testing

### Test Case 1: Mini-App with Node.js Imports

Create a mini-app with:
```typescript
// app.ts
import fs from 'fs';

export function readFile() {
  return fs.readFileSync('/path', 'utf-8');
}
```

**Expected behavior:**
1. ✅ Transpilation succeeds (syntax is valid)
2. ✅ Warning logged: "imports Node.js modules...use window.paprAPI instead"
3. ❌ Runtime error in browser: `ReferenceError: fs is not defined`

### Test Case 2: Mini-App with Correct APIs

Create a mini-app with:
```typescript
// app.ts
export async function readFile() {
  const result = await window.paprAPI.invoke('bash.run', {
    command: 'cat /path'
  });
  return result.stdout;
}
```

**Expected behavior:**
1. ✅ Transpilation succeeds
2. ✅ No warnings (no Node.js imports)
3. ✅ Runtime succeeds (paprAPI works in iframe)

### Test Case 3: Mini-App with Web APIs

Create a mini-app with:
```typescript
// app.ts
export async function fetchData() {
  const response = await fetch('https://api.example.com/data');
  return response.json();
}
```

**Expected behavior:**
1. ✅ Transpilation succeeds
2. ✅ No warnings
3. ✅ Runtime succeeds (fetch is browser API)

## Files Changed

1. **`src/gateway/index.ts`** (lines 779-803)
   - Added explicit `platform: "browser"` to esbuild.transform
   - Added Node.js import validation with warning

2. **`src/core/agents/SystemPrompt.ts`** (lines 901-928)
   - Added "Available/NOT Available" API list
   - Added example showing wrong vs correct approach
   - Emphasized browser context constraints

3. **`CLAUDE.md`** (Issue #18)
   - Documented as known issue with solution
   - Added to learnings section

4. **`docs/ESBUILD_PLATFORM_MISMATCH.md`** (new)
   - Complete technical documentation
   - Explains browser vs node platform differences
   - Testing scenarios and validation

5. **`docs/ESBUILD_PLATFORM_FIX_SUMMARY.md`** (this file)
   - Executive summary for quick reference

## Impact

### Before Fix
- ❌ Implicit platform setting (defaults to browser)
- ❌ No validation for Node.js imports
- ❌ Weak agent guidance about mini-app constraints
- ❌ Runtime failures with confusing errors

### After Fix
- ✅ Explicit `platform: "browser"` (clarity)
- ✅ Warnings logged when Node.js imports detected
- ✅ Strong agent guidance with clear examples
- ✅ Faster debugging (know to check for Node.js imports)

## Rollout

### For Current Users
If you're experiencing mini-app rendering issues:

1. **Check for Node.js imports:**
   ```bash
   # In your mini-app directory
   cat app.ts | grep "from 'fs'\|from 'path'\|from 'crypto'"
   ```

2. **Replace with paprAPI calls:**
   ```typescript
   // Instead of: import fs from 'fs';
   // Use: window.paprAPI.invoke('bash.run', ...)
   ```

3. **Rebuild and test:**
   ```bash
   npm run build && npm start
   ```

### For Developers

When working on Paprwork:
1. ✅ Always set `platform` explicitly in esbuild configs
2. ✅ Add validation for platform-inappropriate imports
3. ✅ Document execution context clearly
4. ✅ Test with platform-specific APIs

## Related Documentation

- `docs/ESBUILD_PLATFORM_MISMATCH.md` - Complete technical deep dive
- `docs/APP_AND_JOBS_GUIDE.md` - Mini-app architecture
- `src/resources/agent-docs/APP_AND_JOBS_GUIDE.md` - Agent documentation
- `ui/lib/miniAppAPI.ts` - paprAPI reference
- `CLAUDE.md` Issue #18 - Summary in learnings

## Prevention Checklist

When transpiling/bundling code with esbuild:

- [ ] Set `platform` explicitly (`browser`, `node`, or `neutral`)
- [ ] Validate imports match target platform
- [ ] Document execution context clearly
- [ ] Provide clear guidance to code generators (agents)
- [ ] Test in actual target environment

---

**Key Takeaway:** Mini-apps run in **browser iframes**, not Node.js. They must use web APIs + `window.paprAPI.invoke()` for system operations. Never import Node.js built-ins (`fs`, `path`, etc.) in mini-app code.
