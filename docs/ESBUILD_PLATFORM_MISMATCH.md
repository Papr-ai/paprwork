# esbuild Platform Mismatch - Mini-Apps Compilation

**Last Updated:** 2026-03-29  
**Status:** ✅ Documented, Solution Proposed

## The Issue

User reported: "Mentor Magic app visibility fix – you patched the app to load the compiled `app.js` instead of `app.ts`, which resolved the rendering issue."

This suggests the agent wrote TypeScript code (`app.ts`) that failed to render, but when manually compiled to JavaScript (`app.js`), it worked.

## Root Cause

The `esbuild.transform` call in the Gateway (line 783 of `src/gateway/index.ts`) is missing the **`platform`** option:

```typescript
// Current implementation
const result = await esbuild.transform(content, {
  loader: ext === ".tsx" ? "tsx" : "ts",
  format: "esm",
  target: "es2020",
  sourcemap: "inline",
  // ❌ Missing: platform option
});
```

**Default behavior:** When no `platform` is specified, esbuild defaults to `platform: 'browser'`.

## Why This Matters

### Context: Mini-Apps Run in Browser Iframes

Mini-apps are served via the Gateway and run in **sandboxed iframes** in the Electron renderer:

```
Browser Context (Chromium)
└── Electron Renderer
    └── iframe (sandbox)
        └── Mini-App Code ← Runs here (no Node.js APIs!)
```

**Available APIs:**
- ✅ Web APIs: `fetch()`, `localStorage`, `document`, `window`
- ✅ Custom: `window.paprAPI.invoke()` for system operations
- ❌ Node.js APIs: `fs`, `path`, `crypto` (not available in browser)

### The Mismatch Scenarios

#### Scenario 1: Agent Uses Node.js APIs (Most Likely)

Agent writes code like:
```typescript
// app.ts - Written by agent
import fs from 'fs';
import path from 'path';

export function loadData() {
  const data = fs.readFileSync('/path/to/file', 'utf-8');
  return data;
}
```

**What happens:**
1. esbuild transpiles with `platform: 'browser'` (default)
2. Imports like `import fs from 'fs'` are **not resolved** (browser has no `fs`)
3. Code fails at runtime: `Uncaught ReferenceError: fs is not defined`

**Fix:** Agent should use `window.paprAPI.invoke()` instead:
```typescript
// Correct mini-app code
export async function loadData() {
  const result = await window.paprAPI.invoke('bash.run', {
    command: 'cat /path/to/file'
  });
  return result.stdout;
}
```

#### Scenario 2: TypeScript Syntax Errors

Agent writes invalid TypeScript that passes transform but fails at runtime:
```typescript
// app.ts
const data: any = getStuff(); // TypeScript-only, runtime has no types
```

**What happens:**
1. esbuild strips types but doesn't validate logic
2. If there are semantic errors (wrong API usage), they surface at runtime

#### Scenario 3: Module Resolution Issues

esbuild with `platform: 'browser'` doesn't bundle Node.js built-ins. If the agent expects them to be available:
```typescript
import { Buffer } from 'buffer'; // Node.js built-in
```

This import won't resolve unless esbuild is told to bundle Node polyfills.

## The Solution

### Option 1: Explicit `platform: 'browser'` (Recommended)

Make the platform setting **explicit** so it's clear mini-apps are browser code:

```typescript
const result = await esbuild.transform(content, {
  loader: ext === ".tsx" ? "tsx" : "ts",
  format: "esm",
  target: "es2020",
  sourcemap: "inline",
  platform: "browser", // ✅ Explicit: mini-apps run in browser context
});
```

**Why this is correct:**
- Mini-apps run in iframes (browser context)
- No Node.js APIs available
- Agent should use `window.paprAPI.invoke()` for system operations
- Being explicit prevents future confusion

### Option 2: Add Node Polyfills (If Needed)

If mini-apps legitimately need Node.js APIs (rare), we could add polyfills:

```typescript
const result = await esbuild.build({
  stdin: {
    contents: content,
    loader: ext === ".tsx" ? "tsx" : "ts",
  },
  bundle: true,
  format: "esm",
  target: "es2020",
  platform: "browser",
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  inject: ['./node-polyfills.js'], // Add Node polyfills
  outfile: 'app.js',
});
```

**Downsides:**
- Increases bundle size significantly
- Adds complexity
- Mini-apps should use Gateway APIs instead

## Recommended Implementation

### Fix 1: Make Platform Explicit

```typescript
// src/gateway/index.ts - Line 783
const result = await esbuild.transform(content, {
  loader: ext === ".tsx" ? "tsx" : "ts",
  format: "esm",
  target: "es2020",
  sourcemap: "inline",
  platform: "browser", // ✅ Make it explicit
});
```

### Fix 2: Improve Agent Guidance

Update system prompt to emphasize mini-app context:

```markdown
## Mini-App Development Rules

**CRITICAL:** Mini-apps run in sandboxed browser iframes. They have:
- ✅ Web APIs: fetch(), localStorage, DOM
- ✅ Custom API: window.paprAPI.invoke()
- ❌ NO Node.js APIs: fs, path, child_process, etc.

**For system operations:**
```typescript
// ❌ DON'T use Node.js APIs
import fs from 'fs';
fs.readFileSync('/path');

// ✅ DO use paprAPI
const result = await window.paprAPI.invoke('bash.run', {
  command: 'cat /path'
});
```
```

### Fix 3: Add Validation

Add a check during transpilation to detect Node.js imports:

```typescript
// Before transpiling, check for Node.js built-ins
const nodeBuiltins = ['fs', 'path', 'crypto', 'child_process', 'os', 'net'];
const hasNodeImports = nodeBuiltins.some(mod => 
  content.includes(`from '${mod}'`) || 
  content.includes(`from "${mod}"`) ||
  content.includes(`require('${mod}')`)
);

if (hasNodeImports) {
  console.warn(`[Gateway] Mini-app ${appId}/${requestedPath} imports Node.js modules. These will not work in browser context.`);
  // Could optionally return an error or warning to the agent
}
```

## Testing the Fix

### Before Fix
```bash
# Agent writes app.ts with Node.js imports
# Transpile fails or runtime error occurs
```

### After Fix
```bash
# 1. Update esbuild.transform with explicit platform
# 2. Test with mini-app using Node.js APIs
# 3. Should get clear runtime error: "fs is not defined"
# 4. Agent learns to use window.paprAPI.invoke() instead
```

## Prevention

### For Future Development

1. **Always set `platform` explicitly** - Don't rely on defaults
2. **Document mini-app constraints** - Browser context, no Node APIs
3. **Add validation** - Detect Node.js imports during transpilation
4. **Update agent docs** - Emphasize `window.paprAPI` usage

### For Agent Behavior

The agent should:
1. Recognize mini-apps run in browser context
2. Use `window.paprAPI.invoke()` for system operations
3. Never import Node.js built-ins (`fs`, `path`, etc.)
4. Use web APIs (`fetch()`, `localStorage`) for data

## Related Files

- `src/gateway/index.ts` - Lines 779-802 (esbuild.transform)
- `ui/lib/miniAppAPI.ts` - Mini-app API documentation
- `src/core/agents/SystemPrompt.ts` - Lines 903-940 (mini-app guidance)
- `docs/APP_AND_JOBS_GUIDE.md` - Complete mini-app architecture

## Implementation Checklist

- [ ] Add `platform: "browser"` to esbuild.transform call
- [ ] Add Node.js import detection warning
- [ ] Update SystemPrompt.ts with stronger mini-app constraints
- [ ] Add test case for mini-app with Node.js imports
- [ ] Document in CLAUDE.md as Issue #21

## Why This Issue Occurs

**Common agent mistake:**
1. Agent sees "TypeScript file"
2. Assumes Node.js context (because TypeScript often = Node)
3. Writes Node.js-style code with `fs`, `path`, etc.
4. Code transpiles successfully (esbuild doesn't validate imports)
5. Code fails at runtime when iframe tries to execute

**The fix:**
- Make it explicit: `platform: "browser"`
- Better agent guidance: "Mini-apps = browser context"
- Runtime validation: Warn on Node.js imports

## Alternative: Use esbuild.build Instead of transform

For better error handling and bundling support:

```typescript
// Option: Use build() for full bundling + Node polyfills
const result = await esbuild.build({
  stdin: {
    contents: content,
    loader: ext === ".tsx" ? "tsx" : "ts",
  },
  bundle: true,
  format: "esm",
  target: "es2020",
  platform: "browser", // ✅ Explicit
  write: false, // Return in memory
  sourcemap: "inline",
});

content = result.outputFiles[0].text;
```

**Advantages:**
- Can bundle dependencies
- Better error messages
- Can add polyfills if needed

**Disadvantages:**
- Slower (bundles all imports)
- More complex
- Overkill for simple .ts → .js transpilation

## Recommendation

**Use `transform` with explicit `platform: "browser"`** - This is the right approach because:
1. Mini-apps run in browser context (fact)
2. They should use web APIs + `window.paprAPI` (design)
3. Fast transpilation (no bundling needed)
4. Clear error messages when Node.js APIs are used incorrectly

The real fix is **agent education** + explicit platform setting, not adding Node polyfills.

---

## Summary

**The issue:** esbuild defaults to `platform: 'browser'` (actually correct for mini-apps), but the setting is implicit and agents may write Node.js-style code that fails at runtime.

**The fix:** 
1. Make `platform: 'browser'` explicit (clarity)
2. Strengthen agent guidance (no Node.js APIs in mini-apps)
3. Add validation (warn on Node.js imports)

**Impact:** Clearer mini-app development constraints, fewer runtime errors, better agent behavior.
