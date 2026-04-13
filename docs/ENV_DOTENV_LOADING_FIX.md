# Environment Variables Not Loading - dotenv Missing

**Date:** 2026-04-12  
**Issue:** Auth0 configuration from .env.local not being used  
**Status:** ✅ Fixed

## Problem

The Auth0 configuration in `.env.local` was not being used by the application. Despite having:
```bash
AUTH0_DOMAIN=papr-development.auth0.com
AUTH0_CLIENT_ID=8MUWN8YrzTRReIJKxUuoZTOY179f85qg
```

The app was still using the default production values:
```bash
papr.auth0.com
asVGkVRkRAxYvtQadqivntIRjB4D1Iur
```

## Root Causes

### 1. No dotenv Loading in Electron Main Process
The `src/electron/index.cjs` file didn't call `dotenv.config()` to load environment variables from `.env.local`.

### 2. No dotenv Loading in Gateway Process
The `src/gateway/index.ts` file (where Auth0 config is used) also didn't load `.env.local`.

### 3. Leading Spaces in .env.local (Secondary Issue)
Lines 28-29 had leading spaces:
```bash
 AUTH0_DOMAIN=...  # ❌ Leading space
```

## Solution

### 1. Added dotenv to Electron Main Process
```javascript
// src/electron/index.cjs (at the very top)
require("dotenv").config({ path: require("path").join(__dirname, "../../.env.local") });

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, powerMonitor, nativeTheme } = require("electron");
```

### 2. Added dotenv to Gateway Process
```typescript
// src/gateway/index.ts (at the very top)
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../../.env.local") });
```

### 3. Fixed Leading Spaces in .env.local
```bash
# ✅ CORRECT - No leading spaces
AUTH0_DOMAIN=papr-development.auth0.com
AUTH0_CLIENT_ID=8MUWN8YrzTRReIJKxUuoZTOY179f85qg
```

## Why Both Files Need dotenv

1. **Electron Main Process** (`src/electron/index.cjs`):
   - Loads `.env.local` and makes variables available to its own code
   - Passes `process.env` to Gateway via `gatewayEnv` (line 1452)

2. **Gateway Process** (`src/gateway/index.ts`):
   - Spawned as separate process via `ELECTRON_RUN_AS_NODE=1`
   - Gets environment from Electron BUT not from `.env.local` unless explicitly loaded
   - Auth0 config is read here in `paprLogin.ts` (lines 23-24)

## How Environment Variables Flow

```
.env.local
    ↓
[Electron loads dotenv]
    ↓
process.env (Electron)
    ↓
gatewayEnv = { ...process.env, ... }
    ↓
Gateway Process spawned with gatewayEnv
    ↓
[Gateway loads dotenv too for safety]
    ↓
process.env (Gateway)
    ↓
AUTH0_DOMAIN = process.env.AUTH0_DOMAIN
```

## Testing

### 1. Verify Environment Variables Load
Add temporary logging to `src/electron/ipc/paprLogin.ts`:
```typescript
console.log(`  AUTH0_DOMAIN: ${AUTH0_DOMAIN}`);
console.log(`  AUTH0_CLIENT_ID: ${AUTH0_CLIENT_ID}`);
console.log(`  ENV AUTH0_DOMAIN: ${process.env.AUTH0_DOMAIN || "(not set)"}`);
console.log(`  ENV AUTH0_CLIENT_ID: ${process.env.AUTH0_CLIENT_ID || "(not set)"}`);
```

### 2. Start App and Check Logs
```bash
npm start
```

**Expected output:**
```
[PaprLogin] Configuration:
  AUTH0_DOMAIN: papr-development.auth0.com
  AUTH0_CLIENT_ID: 8MUWN8YrzTRReIJKxUuoZTOY179f85qg
  ENV AUTH0_DOMAIN: papr-development.auth0.com
  ENV AUTH0_CLIENT_ID: 8MUWN8YrzTRReIJKxUuoZTOY179f85qg
```

### 3. Test Authentication
Click "Sign In" and verify the URL uses:
```
https://papr-development.auth0.com/authorize?client_id=8MUWN8YrzTRReIJKxUuoZTOY179f85qg...
```

Instead of:
```
https://papr.auth0.com/authorize?client_id=asVGkVRkRAxYvtQadqivntIRjB4D1Iur...
```

## Files Changed

- `src/electron/index.cjs`:
  - Added `dotenv.config()` at the very beginning
  
- `src/gateway/index.ts`:
  - Added `dotenv.config()` at the very beginning
  - Added ESM compatibility imports for path resolution

- `.env.local`:
  - Removed leading spaces from AUTH0 variables

## Impact

- **Before:** Auth0 config ignored, always used production values
- **After:** Auth0 config properly loaded from .env.local ✅
- **Development:** Can now test with dev Auth0 tenant
- **Production:** Still works (dotenv.config() safely does nothing if .env.local doesn't exist)

## Prevention

**Always load dotenv FIRST:**
1. At the top of entry point files (before any other imports)
2. In both Electron main and Gateway processes
3. Check the file path is correct relative to the entry point

## Related

- Issue 52: Auth0 Double HTTPS fix (domain stripping)
- Enhancement 20: Papr Login Integration
- Environment variable documentation
