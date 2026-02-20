# What Changed & Why Different File Extensions

**Date:** 2026-02-12

---

## What We Changed That Caused the Issue

### The Changes Today (Permission System Implementation)

1. **Added new TypeScript files:**
   - `src/electron/ipc/permissions.ts` ← NEW
   - `src/core/storage/KeyPermissionsStorage.ts` ← NEW
   - `src/core/storage/index.ts` ← NEW (barrel export)

2. **Updated import paths in `src/electron/index.cjs`:**
   ```javascript
   // Added these imports:
   const storageModule = await import("../../dist/core/storage/index.js");
   KeyPermissionsStorage = storageModule.KeyPermissionsStorage;
   SettingsStorage = storageModule.SettingsStorage;
   
   const permissionsIpcModule = await import("../../dist/electron/electron/ipc/permissions.js");
   initializePermissionsIPC = permissionsIpcModule.initializePermissionsIPC;
   ```

3. **The problem:**
   - We added `.ts` files but **forgot Electron's build wasn't compiling TypeScript**
   - The `build:electron` script was just copying `.cjs` files:
     ```json
     "build:electron": "echo 'Electron uses .cjs (no compilation)'"
     ```
   - So `permissions.ts` never got compiled to `permissions.js`!

### The Fix

Changed the build script to compile TypeScript:
```json
// Before:
"build:electron": "echo 'Electron uses .cjs (no compilation)' && ..."

// After:
"build:electron": "tsc -p tsconfig.electron.json && ..."
```

Now TypeScript files in `src/electron/` get compiled to `dist/electron/`.

---

## Why .js vs .cjs vs .ts?

This is about **Electron's unique multi-runtime architecture**.

### The File Extension Breakdown

```
Paprwork V2 Architecture:
├── src/electron/
│   ├── index.cjs          ← CommonJS (Electron main process)
│   ├── preload.cjs        ← CommonJS (Electron preload)
│   └── ipc/
│       └── permissions.ts ← TypeScript → compiles to .js (ESM)
│
├── src/gateway/
│   └── *.ts               ← TypeScript → compiles to .js (ESM)
│
├── src/core/
│   └── *.ts               ← TypeScript → compiles to .js (ESM)
│
└── ui/
    └── *.tsx              ← TypeScript React → bundled by Vite
```

---

## Why Each Extension?

### 1. `.cjs` = CommonJS (Electron Main + Preload)

**Files:**
- `src/electron/index.cjs`
- `src/electron/preload.cjs`

**Why CommonJS (.cjs)?**
- ✅ Electron's `require('electron')` only works reliably in CommonJS
- ✅ No ESM import issues with Electron's APIs
- ✅ Stable and boring (good for production)
- ✅ Can dynamically `import()` ESM modules when needed

**Example:**
```javascript
// ✅ Works in CommonJS
const { app, BrowserWindow } = require("electron");

// ❌ Doesn't work in ESM (Electron limitation)
import { app, BrowserWindow } from "electron";
// Error: Electron only exports default in ESM
```

**From docs:**
> "Electron's main process is Node-based, and CJS 'just works'"

---

### 2. `.ts` = TypeScript (Compiles to ESM)

**Files:**
- `src/electron/ipc/*.ts`
- `src/gateway/**/*.ts`
- `src/core/**/*.ts`

**Why TypeScript?**
- ✅ Type safety (no `any` allowed)
- ✅ Better IDE support
- ✅ Catches errors at compile time
- ✅ Shared code between Gateway, Main, and Renderer

**Compilation:**
```
src/electron/ipc/permissions.ts
  ↓ tsc -p tsconfig.electron.json
dist/electron/electron/ipc/permissions.js (ESM)
```

**Example:**
```typescript
// permissions.ts
import type { KeyPermissionRequest } from "../../core/types/permissions.js";

export function initializePermissionsIPC(storage: KeyPermissionsStorage) {
  // Typed, safe, modern
}
```

---

### 3. `.js` = JavaScript ES Modules (Output)

**Files in `dist/`:**
- `dist/electron/electron/ipc/permissions.js`
- `dist/gateway/index.js`
- `dist/core/storage/index.js`

**Why .js (not .mjs)?**
- ✅ TypeScript outputs `.js` by default
- ✅ Node recognizes as ESM (because `package.json` has `"type": "module"`)
- ✅ Consistent with modern Node.js conventions

**How Node knows it's ESM:**
```json
// package.json at root
{
  "type": "module"  // ← All .js files are ESM
}
```

---

## The Import Chain

Here's how it all connects:

```
1. Electron starts: index.cjs (CommonJS)
   ↓
2. index.cjs uses require('electron') ✓
   ↓
3. index.cjs dynamically imports ESM:
   await import("../../dist/core/storage/index.js")  ← TypeScript output
   ↓
4. TypeScript files (.ts) were compiled to .js (ESM)
   by tsc during build
```

**Visual:**
```
START: electron .
  ↓
RUN: src/electron/index.cjs (CommonJS)
  ↓ require('electron') ✓
  ↓ await import() for ESM modules
  ├─→ dist/core/storage/index.js (was .ts)
  ├─→ dist/electron/electron/ipc/permissions.js (was .ts)
  └─→ dist/electron/electron/ipc/customKeys.js (was .ts)
```

---

## Why This Setup?

### Historical Context (from CLAUDE.md Issue #5)

**The Problem:**
```javascript
// Tried this in V1:
import { app } from 'electron';
// ❌ Error: Electron doesn't support named ESM imports
```

**The Solution:**
- Use `.cjs` for Electron main process (reliable `require()`)
- Compile TypeScript to ESM `.js` for everything else
- Mix and match as needed

**From CLAUDE.md:**
> "Issue 5: Electron Module System (ESM vs CommonJS)
> **Problem:** `import { app } from 'electron'` fails
> **Root Cause:** Electron doesn't support named ESM imports
> **Solution:** Main process uses CommonJS (.cjs)"

---

## Build Process

### Step 1: Gateway (TypeScript → ESM)
```bash
npm run build:gateway
# tsc -p tsconfig.gateway.json
# Outputs: dist/gateway/*.js (ESM)
```

### Step 2: Electron (TypeScript → ESM + Copy .cjs)
```bash
npm run build:electron
# tsc -p tsconfig.electron.json  ← Compiles .ts to .js
# cp src/electron/preload.cjs dist/electron/  ← Copies .cjs as-is
# Outputs: dist/electron/**/*.js (ESM) + preload.cjs
```

### Step 3: UI (React TypeScript → Bundled)
```bash
npm run build:ui
# cd ui && vite build
# Outputs: dist/ui/*.js (bundled)
```

---

## What Was Wrong Before?

**Before today's fix:**
```json
"build:electron": "echo 'Electron uses .cjs (no compilation)' && cp ..."
```

**Problem:**
- Only copied `.cjs` files
- **Never compiled `.ts` files** in `src/electron/ipc/`
- So `permissions.ts` → never became `permissions.js`
- Import failed: "Cannot find module .../permissions.js"

**After the fix:**
```json
"build:electron": "tsc -p tsconfig.electron.json && cp ..."
```

**Now:**
- ✅ Compiles all `.ts` in `src/electron/` and `src/core/`
- ✅ Outputs to `dist/electron/`
- ✅ Copies `.cjs` files as-is
- ✅ All imports resolve correctly

---

## Summary

| Extension | Type | Used For | Compiled? |
|-----------|------|----------|-----------|
| `.cjs` | CommonJS | Electron main/preload | No (copied as-is) |
| `.ts` | TypeScript | Core, Gateway, Electron IPC | Yes (→ .js) |
| `.js` | ESM | TypeScript output | Yes (it's the output!) |
| `.tsx` | TypeScript React | UI components | Yes (bundled by Vite) |

**The Golden Rule:**
- **Electron API calls** → Use `.cjs` (CommonJS)
- **Everything else** → Use `.ts` (TypeScript → ESM)

---

## Why Not Just Use TypeScript Everywhere?

**We tried! But Electron's `require('electron')` doesn't work in ESM.**

From the docs:
> "Problem: `import { app } from 'electron'` doesn't work - Electron only exports default in ESM"

So we use:
- `.cjs` for the thin Electron wrapper
- `.ts` for all business logic
- Dynamic `import()` to bridge the gap

**It's the "boring, stable" solution that ships to production.**

---

## Testing the Fix

```bash
# 1. Build
npm run build

# 2. Check files exist
ls -la dist/electron/electron/ipc/permissions.js  # ✓ Should exist now
ls -la dist/core/storage/index.js                 # ✓ Should exist

# 3. Start app
npm start  # ✓ No more import errors
```

---

**Key Takeaway:** We use different file extensions because Electron runs in a **multi-runtime environment** (Node main process + Chromium renderer). The `.cjs` / `.ts` / `.js` mix is the stable way to handle this complexity.
