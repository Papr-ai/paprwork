# Electron Module System Architecture

**Last Updated:** 2026-02-12

## TL;DR: The "Boring, Stable" Setup

```
Main Process + Preload = CommonJS (.cjs)
Renderer Process = ESM (Vite)
Gateway Process = ESM (Node v24)
```

**Why:** Don't fight Electron's multi-runtime reality. This is what ships to production.

---

## The Problem We Hit

When we tried to use `"type": "module"` in `package.json` with Electron:

1. ❌ `import { app } from 'electron'` doesn't work - Electron only exports `default` in ESM
2. ❌ `.cjs` files are still treated as ESM when referenced as main entry point
3. ❌ `require('electron')` returns a string (binary path) when `ELECTRON_RUN_AS_NODE=1` is set
4. ❌ Native modules (better-sqlite3) need rebuilding for Electron's embedded Node

---

## Our Architecture (What Actually Works)

### 1. Main Process (`src/electron/index.cjs`)
- **Format:** CommonJS
- **Why:** Electron's main process is Node-based, and CJS "just works"
- **Entry:** `src/electron/main.js` (shim) → `src/electron/index.cjs`
- **Module Loading:** Uses `require()` for Electron API, `import()` for ESM modules

```javascript
const { app, BrowserWindow } = require("electron"); // ✓ Works

// Dynamic import for ESM modules from dist/
async function loadESMModules() {
  const storage = await import("../../dist/electron/core/storage/CustomKeysStorage.js");
  // ...
}
```

### 2. Preload Script (`src/electron/preload.mjs`)
- **Format:** ES Module (`.mjs` required by Electron)
- **Why:** Electron requires `.mjs` extension for ESM preload scripts
- **Context:** Runs in sandboxed renderer, exposes IPC via `contextBridge`

```javascript
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("papr", {
  // Safe API exposure
});
```

### 3. Renderer Process (`ui/`)
- **Format:** ESM
- **Bundler:** Vite
- **Why:** Modern web tooling, React expects ESM

### 4. Gateway Process (`src/gateway/`)
- **Format:** ESM (TypeScript compiled to `.js`)
- **Runtime:** Electron's embedded Node v24 (via `ELECTRON_RUN_AS_NODE=1`)
- **Why:** Shares code with renderer, uses modern async/await

---

## package.json Configuration

```json
{
  "type": "module",  // ✓ OK for root - we use .cjs for electron main
  "main": "./src/electron/main.js",  // Shim that loads index.cjs
  
  "scripts": {
    "build:electron": "echo 'Electron uses .cjs (no compilation)' && mkdir -p dist/electron/electron && cp src/electron/preload.mjs dist/electron/electron/preload.mjs",
    "start": "NODE_ENV=production electron .",
    "dev": "concurrently \"npm run gateway:dev\" \"npm run ui:dev\" \"npm run electron:dev\""
  }
}
```

### Critical: `src/electron/package.json`
```json
{
  "type": "commonjs"
}
```

This overrides the root `"type": "module"` for the electron directory.

---

## Module System by File Extension

| Extension | Module System | When to Use |
|-----------|---------------|-------------|
| `.cjs` | CommonJS | Main process (Electron APIs) |
| `.mjs` | ES Module | Preload scripts, explicit ESM |
| `.js` | Depends on nearest package.json `type` | Gateway, core, renderer (ESM) |
| `.ts` | Compiles to `.js` (ESM) | Gateway, core (TypeScript) |

---

## Node Version Consistency

✅ **Electron 40.3.0** embeds **Node v24.13.0**

- System Node: v24.13.1 (via nvm)
- Electron Node: v24.13.0 (embedded)
- Gateway spawned with: `ELECTRON_RUN_AS_NODE=1` → Uses Electron's Node v24

**Why this matters:**
- Native modules must be compiled for the **exact Node version**
- Gateway runs on Electron's Node (v24), not system Node (v18 before)
- Run `npx @electron/rebuild` after any native module changes

---

## Critical Environment Variables

### ❌ `ELECTRON_RUN_AS_NODE=1` (in shell environment)
**Problem:** When set globally, makes `require('electron')` return a string instead of the API.

**Solution:** Only set when spawning Gateway subprocess:
```javascript
gatewayProcess = spawn(process.execPath, [gatewayScript], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",  // ✓ Only for Gateway subprocess
  },
});
```

---

## Common Errors & Solutions

### Error 1: `Cannot find module 'electron'` or `app is undefined`

**Cause:** `ELECTRON_RUN_AS_NODE=1` set in shell environment

**Fix:**
```bash
unset ELECTRON_RUN_AS_NODE
npm start
```

### Error 2: `The requested module 'electron' does not provide an export named 'app'`

**Cause:** Trying to use named imports with ESM: `import { app } from 'electron'`

**Fix:** Use CommonJS or default import:
```javascript
// ✓ CommonJS (recommended for main)
const { app } = require("electron");

// ✓ ESM with default import (if you must)
import electron from "electron";
const { app } = electron;
```

### Error 3: `better-sqlite3.node was compiled against a different Node.js version`

**Cause:** Native modules compiled for wrong Node version

**Fix:**
```bash
npx @electron/rebuild
```

### Error 4: Port 18789 already in use

**Cause:** Previous Gateway still running

**Fix:**
```bash
npm run kill:gateway
```

---

## Build Process

1. **Gateway** (`src/gateway/` → `dist/gateway/`)
   - TypeScript → JavaScript (ESM)
   - `tsc -p tsconfig.gateway.json`

2. **Electron Main** (`src/electron/index.cjs`)
   - No compilation - used directly as `.cjs`
   - Copy preload: `cp src/electron/preload.mjs dist/electron/electron/preload.mjs`

3. **UI** (`ui/` → `dist/ui/`)
   - Vite build (React + ESM)
   - `cd ui && vite build`

4. **Rebuild Native Modules**
   - `npx @electron/rebuild`
   - Run after: `npm install` or Node version change

---

## Development vs Production

### Development Mode
```bash
npm run dev
```

- Gateway: `tsx watch src/gateway/index.ts` (Node v18/v24 via nvm)
- UI: `vite` dev server (port 5173)
- Electron: Loads UI from `http://localhost:5173`

### Production Mode
```bash
npm run build
npm start
```

- Gateway: Spawned by Electron (Node v24 embedded)
- UI: Served from `dist/ui/` via Gateway HTTP server
- Electron: Loads UI from `http://localhost:18789`

---

## ESM vs CommonJS Decision Tree

```
Are you writing code for:

├─ Main Process? (Electron APIs)
│  └─ Use CommonJS (.cjs)
│     - Electron's `require('electron')` works reliably
│     - Use `import()` for ESM modules if needed
│
├─ Preload Script? (contextBridge)
│  └─ Use ESM (.mjs) - Electron requires it
│     - import { contextBridge } from "electron"
│
├─ Renderer Process? (React UI)
│  └─ Use ESM - Vite/React ecosystem expects it
│
└─ Gateway/Core? (Business logic)
   └─ Use ESM - Modern Node, async/await, shared with renderer
```

---

## References

1. [Electron ESM Documentation](https://www.electronjs.org/docs/latest/tutorial/esm)
2. [Node.js ES Modules](https://nodejs.org/api/esm.html)
3. [Electron Forge + Vite](https://www.electronforge.io/)
4. Electron 40 Release Notes: Node v24 embedded

---

## Key Takeaways

1. ✅ **Main = CJS, Renderer = ESM** is the battle-tested pattern
2. ✅ Use `src/electron/package.json` with `"type": "commonjs"` to override root
3. ✅ Gateway uses Electron's embedded Node v24 (consistent version)
4. ✅ Rebuild native modules after install: `npx @electron/rebuild`
5. ✅ Never set `ELECTRON_RUN_AS_NODE=1` globally - only in subprocess env

---

**This is the boring, stable setup that ships to production. Don't fight it.**
