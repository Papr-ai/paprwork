# Job Node Version Fix

**Added:** 2026-04-06

## Problem

Jobs were failing with native module version mismatch errors when using `better-sqlite3` or other native Node modules. The error message was:

```
Native module issue — better-sqlite3 was compiled for a different Node version
```

This happened because jobs were using a different Node version (Homebrew's Node v25) than the main app (nvm's Node v24).

## Root Cause

The `CommandJobExecutor.launch()` method was using `process.env` without ensuring the correct Node version was in the PATH. When jobs spawned child processes:

1. Gateway process starts with nvm's Node v24
2. Native modules (better-sqlite3) compiled for Node v24
3. Jobs inherit `process.env` which may have Homebrew's Node v25 in PATH
4. Jobs try to load native modules → version mismatch error

The issue was particularly common on macOS where users have both:
- nvm's Node v24 (correct version, specified in `.nvmrc`)
- Homebrew's Node v25 (system default, wrong version)

## Solution

Modified `CommandJobExecutor` to ensure jobs always use the Node version specified in `.nvmrc`:

1. **Read `.nvmrc`** to get the required Node version
2. **Find nvm's Node path** for that version
3. **Prepend to PATH** so it takes priority over system Node
4. **Apply consistently** to all job operations (spawn, execSync, venv, npm install)

### Implementation

```typescript
// New helper method
private getNvmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
  const nvmrcPath = path.join(process.cwd(), '.nvmrc');
  
  if (existsSync(nvmDir) && existsSync(nvmrcPath)) {
    try {
      const { readFileSync } = require('fs') as typeof import('fs');
      const nvmVersion = readFileSync(nvmrcPath, 'utf8').trim();
      const nvmNodePath = path.join(nvmDir, 'versions', 'node', `v${nvmVersion}`, 'bin');
      
      if (existsSync(nvmNodePath)) {
        // Prepend nvm's Node path to ensure it takes priority over system Node
        env.PATH = `${nvmNodePath}:${env.PATH || ''}`;
      }
    } catch {
      // If we can't read .nvmrc, just use current environment
    }
  }
  
  return env;
}
```

This method is called in:
- `launch()` - Job execution spawn
- `ensurePythonVenv()` - Python venv creation
- `ensureNodeModules()` - npm install
- All `execSync()` calls for pip install

## Files Changed

- `src/gateway/services/jobs/executors/CommandJobExecutor.ts`
  - Added `getNvmEnv()` method
  - Updated `launch()` to use nvm environment
  - Updated `ensurePythonVenv()` to use nvm environment
  - Updated `ensureNodeModules()` to use nvm environment

## Impact

**Before:**
- Jobs used system Node (v25) → native module version mismatch
- Random failures with better-sqlite3, node-pty, etc.
- Inconsistent behavior between dev and production

**After:**
- Jobs use nvm Node (v24) → matches compiled native modules
- Consistent Node version across all job operations
- Reliable native module loading

## Testing

1. Verify current Node version: `node --version` → should show v24.x
2. Check which node: `which node` → should show nvm path
3. Run a job that uses better-sqlite3
4. Verify no version mismatch errors in job logs

## Related Issues

- Issue 6 (Enhancement): Native Module Version Mismatch - Original documentation in CLAUDE.md
- `.nvmrc` file: Enforces Node v24 requirement
- `package.json`: `engines` field requires Node >=24.0.0

## Prevention

1. Always use nvm for Node version management
2. Run `nvm use` before starting the app
3. The postinstall script `npx @electron/rebuild` requires Node v24+
4. Jobs now automatically use the correct version from `.nvmrc`

## Platform Support

- **macOS**: ✅ Fully supported (nvm standard)
- **Linux**: ✅ Fully supported (nvm standard)
- **Windows**: ⚠️ Uses nvm-windows (different paths, may need adjustment)

## Future Enhancements

1. Add Windows-specific nvm path detection
2. Log warning if Node version mismatch detected
3. Add automatic Node version switching in job initialization
4. Consider bundling Node binary with packaged app
