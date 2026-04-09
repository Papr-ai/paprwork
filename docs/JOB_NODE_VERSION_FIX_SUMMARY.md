# Job Node Version Fix - Summary

## Issue
Jobs were failing with native module version mismatch errors:
```
better-sqlite3 was compiled for a different Node.js version
```

## Root Cause
Jobs inherited `process.env` which had Homebrew's Node v25 in PATH, while native modules were compiled with nvm's Node v24.

## Solution Applied
Modified `CommandJobExecutor` to prepend nvm's Node v24 path to PATH for all job operations.

## What Changed

### 1. Added `getNvmEnv()` Helper Method
```typescript
private getNvmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
  const nvmrcPath = path.join(process.cwd(), '.nvmrc');
  
  if (existsSync(nvmDir) && existsSync(nvmrcPath)) {
    try {
      const nvmVersion = readFileSync(nvmrcPath, 'utf8').trim();
      const nvmNodePath = path.join(nvmDir, 'versions', 'node', `v${nvmVersion}`, 'bin');
      
      if (existsSync(nvmNodePath)) {
        env.PATH = `${nvmNodePath}:${env.PATH || ''}`;
      }
    } catch {
      // Fallback to current environment
    }
  }
  
  return env;
}
```

### 2. Applied to All Job Operations
- `launch()` - Job execution spawn
- `ensurePythonVenv()` - Python venv creation (execSync)
- `ensureNodeModules()` - npm install (execSync)
- pip install (execSync)

## Next Steps

1. **Restart the app** to apply the changes:
   ```bash
   npm start
   ```

2. **Test a job** that previously failed with the native module error

3. **Verify** the job now uses the correct Node version:
   - Check job logs for any Node version mismatch errors
   - Should see no `better-sqlite3` version errors

## Files Modified

1. `src/gateway/services/jobs/executors/CommandJobExecutor.ts`
   - Added `getNvmEnv()` method
   - Updated all child process operations to use nvm environment

## Documentation Added

1. `docs/JOB_NODE_VERSION_FIX.md` - Complete technical documentation
2. `CLAUDE.md` - Added Issue 36 with full details

## Expected Result

**Before:**
- Jobs fail with: `better-sqlite3 was compiled for a different Node.js version`
- Inconsistent behavior between dev and production
- Native modules couldn't be loaded in job contexts

**After:**
- Jobs use nvm's Node v24 consistently
- Native modules load successfully
- No version mismatch errors
- All job types (python, node, bash, shell) benefit from the fix

## Platform Support

- ✅ macOS - Fully supported (nvm standard)
- ✅ Linux - Fully supported (nvm standard)
- ⚠️ Windows - May need adjustment for nvm-windows paths (different directory structure)

## Verification Commands

```bash
# 1. Check current Node version
node --version
# Should show: v24.13.1 (or similar v24.x)

# 2. Check which Node is being used
which node
# Should show: /Users/amirkabbara/.nvm/versions/node/v24.13.1/bin/node

# 3. Verify .nvmrc content
cat .nvmrc
# Should show: 24

# 4. Start the app
npm start

# 5. Run a job that uses better-sqlite3 or other native modules
# Should complete successfully without version mismatch errors
```

## Related Issues

- **Issue 6**: Original native module version mismatch documentation in CLAUDE.md
- **`.nvmrc` file**: Enforces Node v24 requirement
- **`package.json`**: `engines` field requires Node >=24.0.0
- **postinstall script**: `npx @electron/rebuild` requires Node v24+
