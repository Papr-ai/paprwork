# Windows Node.js PATH Fix

**Issue Number:** 37  
**Added:** 2026-04-06  
**Status:** ✅ FIXED

## Problem

Windows users experienced "node is not recognized as a command" errors when running Node.js jobs. The jobs would fail immediately with exit code 1 and the error message:

```
'node' is not recognized as an internal or external command,
operable program or batch file.
```

This happened even when Node.js was properly installed via nvm-windows and worked correctly in regular terminals.

## Root Cause

The `getNvmEnv()` method in `CommandJobExecutor.ts` had three critical Windows-specific issues:

### 1. Wrong PATH Separator
```typescript
// ❌ WRONG (Unix-style)
env.PATH = `${nvmNodePath}:${env.PATH || ''}`;

// ✅ CORRECT (Platform-aware)
const pathSeparator = isWindows ? ';' : ':';
env.PATH = `${nvmNodePath}${pathSeparator}${env.PATH || ''}`;
```

**Why it broke:** Windows uses semicolons (`;`) to separate PATH entries, not colons (`:`). Using `:` made Windows interpret the entire string as a single invalid path.

### 2. Wrong nvm Structure
```typescript
// ❌ WRONG (Unix nvm structure)
const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME, '.nvm');
const nvmNodePath = path.join(nvmDir, 'versions', 'node', `v${version}`, 'bin');

// ✅ CORRECT (nvm-windows structure)
const nvmHome = process.env.NVM_HOME || process.env.NVM_SYMLINK;
// nvm-windows creates a symlink, no version-specific path needed
```

**Why it broke:** nvm-windows uses `NVM_HOME` or `NVM_SYMLINK` environment variables, not `NVM_DIR`. It manages versions differently - using symbolic links rather than version-specific directories.

### 3. Missing Windows Detection
The original code had no Windows-specific logic at all. It assumed Unix-style paths and environment variables, causing complete failure on Windows.

## Solution

Enhanced `getNvmEnv()` to properly handle both Windows and Unix platforms:

### Implementation

```typescript
private getNvmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  
  // Windows uses nvm-windows with different structure, Unix uses nvm
  const isWindows = process.platform === 'win32';
  const pathSeparator = isWindows ? ';' : ':';
  
  if (isWindows) {
    // Windows: nvm-windows uses NVM_HOME or NVM_SYMLINK
    const nvmHome = process.env.NVM_HOME || process.env.NVM_SYMLINK;
    if (nvmHome && existsSync(nvmHome)) {
      // nvm-windows creates a symlink at NVM_SYMLINK pointing to the active version
      // Just ensure it's in PATH
      const currentPath = env.PATH || '';
      if (!currentPath.includes(nvmHome)) {
        env.PATH = `${nvmHome}${pathSeparator}${currentPath}`;
      }
    }
  } else {
    // Unix: Use nvm with .nvmrc version
    const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
    const nvmrcPath = path.join(process.cwd(), '.nvmrc');
    
    if (existsSync(nvmDir) && existsSync(nvmrcPath)) {
      try {
        const { readFileSync } = require('fs') as typeof import('fs');
        const nvmVersion = readFileSync(nvmrcPath, 'utf8').trim();
        const nvmNodePath = path.join(nvmDir, 'versions', 'node', `v${nvmVersion}`, 'bin');
        
        if (existsSync(nvmNodePath)) {
          env.PATH = `${nvmNodePath}${pathSeparator}${env.PATH || ''}`;
        }
      } catch {
        // If we can't read .nvmrc, just use current environment
      }
    }
  }
  
  return env;
}
```

### Simplified Job Launch

Also cleaned up the `launch()` method to avoid duplication:

```typescript
// ✅ BEFORE: Duplicated nvm logic
const env = { ...process.env, JOB_DIR, JOB_DB };
// 20 lines of nvm PATH manipulation here...

// ✅ AFTER: Clean delegation
const env = {
  ...this.getNvmEnv(),  // Handles nvm properly for both platforms
  JOB_DIR: params.jobDir,
  JOB_DB: jobDbPath,
  ...(params.runtimeParams ?? {}),
};
```

## Key Differences: nvm vs nvm-windows

| Feature | Unix (nvm) | Windows (nvm-windows) |
|---------|------------|----------------------|
| **Env Var** | `NVM_DIR` | `NVM_HOME` or `NVM_SYMLINK` |
| **Structure** | `$NVM_DIR/versions/node/v24/bin/node` | `%NVM_SYMLINK%\node.exe` |
| **Version Management** | Version-specific directories | Symlink to active version |
| **PATH Separator** | `:` (colon) | `;` (semicolon) |
| **Config File** | `.nvmrc` (project-level) | None (global `nvm use`) |

## Testing

### Manual Test (Windows)
1. Install nvm-windows: https://github.com/coreybutler/nvm-windows/releases
2. Install Node.js: `nvm install 24` and `nvm use 24`
3. Create a Node job: `create_job({ name: "Test", type: "node", command: "node --version" })`
4. Run the job: `run_job({ jobId: "..." })`
5. Verify output shows Node version (e.g., `v24.13.0`)

### Expected Output
```
[Job Test] Starting...
v24.13.0
[Job Test] Completed successfully (exit code: 0)
```

### Error Indicators (Before Fix)
```
❌ 'node' is not recognized as an internal or external command
❌ Exit code: 1
❌ Job fails immediately
```

## Files Changed

- `src/gateway/services/jobs/executors/CommandJobExecutor.ts`
  - Enhanced `getNvmEnv()` with Windows support
  - Simplified `launch()` to use `getNvmEnv()` directly
  - Removed duplicate nvm PATH logic

## Impact

### Before
- **Windows:** Node jobs failed with "node is not recognized"
- **Unix:** Worked correctly

### After
- **Windows:** Node jobs work correctly with nvm-windows ✅
- **Unix:** Continues working with nvm ✅
- **Both:** Proper PATH separator, proper nvm structure

## Platform Support

| Platform | nvm Tool | Support Status |
|----------|----------|----------------|
| macOS | nvm | ✅ Fully supported |
| Linux | nvm | ✅ Fully supported |
| Windows | nvm-windows | ✅ **Fixed in this update** |

## Related Issues

- **Issue 36 (Job Node Version Mismatch):** Original fix that introduced Unix-only nvm support
- **Issue 6 (Native Module Version Mismatch):** Root cause requiring nvm version matching

## Prevention

When writing cross-platform Node.js code:

1. **Always check `process.platform`** before using Unix-style paths
2. **Use proper PATH separator:** `path.delimiter` or manual check for `;` vs `:`
3. **Test on Windows:** Cross-platform assumptions break easily
4. **Use platform utilities:** The `src/core/utils/platform.ts` file has helpers for this
5. **Document platform differences:** nvm vs nvm-windows have different APIs

## Future Enhancements

1. **Automatic nvm-windows detection:** Warn users if nvm-windows not installed
2. **Fallback to system Node:** If nvm not available, use system Node with warning
3. **Version validation:** Check if Node version matches requirements
4. **Better error messages:** "nvm-windows not found, install from..." instead of "node not recognized"

## References

- **nvm (Unix):** https://github.com/nvm-sh/nvm
- **nvm-windows:** https://github.com/coreybutler/nvm-windows
- **Node.js PATH on Windows:** https://nodejs.org/en/docs/guides/nodejs-docker-webapp
- **Windows Environment Variables:** https://docs.microsoft.com/en-us/windows/win32/procthread/environment-variables
