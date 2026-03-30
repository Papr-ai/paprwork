# Quick Fix: Mini-App Won't Render (Node.js API Usage)

**Symptom:** Mini-app `.ts` file fails to render, but manually compiled `.js` works.

## Root Cause

Your agent wrote code importing Node.js modules (`fs`, `path`, `crypto`, etc.) which don't exist in browser iframes.

## Quick Fix

### Step 1: Find the Problem

Open your mini-app's TypeScript file and search for Node.js imports:

```typescript
// ❌ These won't work in mini-apps:
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
```

### Step 2: Replace with paprAPI

Use `window.paprAPI.invoke()` instead:

```typescript
// ✅ Correct approach:

// File operations
const result = await window.paprAPI.invoke('bash.run', {
  command: 'cat /path/to/file'
});
const fileContent = result.stdout;

// Path operations
const result = await window.paprAPI.invoke('bash.run', {
  command: 'realpath myfile.txt'
});
const absolutePath = result.stdout.trim();

// Execute commands
const result = await window.paprAPI.invoke('bash.run', {
  command: 'npm list --depth=0'
});
```

### Step 3: Rebuild

```bash
# The fix is already applied in the codebase (2026-03-29)
npm run build
npm start
```

## Why This Happened

**Mini-apps run in browser iframes, not Node.js:**

```
Browser Context (Chromium)
└── iframe (sandboxed)
    └── Your Mini-App ← No Node.js APIs here!
```

**Available APIs:**
- ✅ Web APIs: `fetch()`, `localStorage`, `document`, DOM
- ✅ Custom API: `window.paprAPI.invoke()` for system operations
- ❌ Node.js APIs: `fs`, `path`, `crypto`, `child_process`

## The Fix (Already Applied)

We fixed three things:

1. **Explicit platform setting:** esbuild now explicitly uses `platform: "browser"`
2. **Validation warnings:** Console warns when Node.js imports detected
3. **Better agent guidance:** SystemPrompt now clearly states mini-apps run in browser context

## How to Tell Your Agent

When creating/updating mini-apps, remind the agent:

> "This mini-app runs in a browser iframe. Use `window.paprAPI.invoke('bash.run', ...)` for file operations and shell commands. Don't import Node.js modules like `fs` or `path`."

## Alternative: Use Jobs Instead

If you need heavy Node.js processing, use a **job** instead of a mini-app:

- **Jobs:** Run in Node.js/Python (full system access)
- **Mini-Apps:** Display data (browser context only)

**Pattern:**
1. Job does heavy lifting (queries DB, processes files)
2. Job saves results to SQLite (`~/papr-jobs/{id}/data.db`)
3. Mini-app queries SQLite and displays data

## Examples

### ❌ Wrong (Node.js Style)

```typescript
import fs from 'fs';
import path from 'path';

const files = fs.readdirSync('/some/path');
const content = fs.readFileSync(path.join('/some/path', files[0]), 'utf-8');
```

### ✅ Correct (Browser + paprAPI)

```typescript
// List files
const result = await window.paprAPI.invoke('bash.run', {
  command: 'ls /some/path'
});
const files = result.stdout.trim().split('\n');

// Read file
const result2 = await window.paprAPI.invoke('bash.run', {
  command: `cat "/some/path/${files[0]}"`
});
const content = result2.stdout;
```

### ✅ Better (Use SQLite via fetch)

```typescript
// If data is in a job's SQLite database
const response = await fetch('/api/jobs/my-job-id/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'SELECT * FROM data LIMIT 100'
  })
});
const { rows } = await response.json();
```

## Need Help?

See the complete documentation:
- `docs/ESBUILD_PLATFORM_MISMATCH.md` - Technical deep dive
- `docs/ESBUILD_PLATFORM_FIX_SUMMARY.md` - This guide
- `CLAUDE.md` Issue #18 - Summary in project learnings

---

**TL;DR:** Mini-apps can't use Node.js APIs. Use `window.paprAPI.invoke('bash.run', ...)` instead.
