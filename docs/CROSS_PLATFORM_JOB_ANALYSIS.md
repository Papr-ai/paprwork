# Cross-Platform Job Execution Analysis

**Date:** 2026-04-06  
**Context:** Investigation following Windows "node is not recognized" issue

## Executive Summary

After fixing the Windows Node.js PATH issue, I analyzed all job types for similar cross-platform problems. Here's what I found:

### Quick Answer
- **Linux:** ✅ No issue - uses same Unix-style paths as macOS
- **Other job types:** ⚠️ Python has **potential** Windows issues, but less severe

## Platform Compatibility Matrix

| Job Type | macOS | Linux | Windows | Issues Found |
|----------|-------|-------|---------|--------------|
| **bash** | ✅ | ✅ | ⚠️ | Windows uses cmd.exe (different syntax) |
| **shell** | ✅ | ✅ | ⚠️ | Platform-aware via `getShellCommand()` |
| **node** | ✅ | ✅ | ✅ | **FIXED** (Issue 37) |
| **python** | ✅ | ✅ | ⚠️ | Potential `python3` vs `python` issue |
| **swift** | ✅ | ❌ | ❌ | macOS-only (Xcode required) |
| **agent** | ✅ | ✅ | ✅ | No platform-specific code |
| **subagent** | ✅ | ✅ | ✅ | No platform-specific code |

## Detailed Analysis by Job Type

### 1. Node Jobs ✅ FIXED

**Status:** Fixed in Issue 37

**Problem (Windows only):**
- Used wrong PATH separator (`:` instead of `;`)
- Wrong nvm structure (Unix `NVM_DIR` vs Windows `NVM_HOME`)

**Solution:** Enhanced `getNvmEnv()` with proper Windows support

**Linux:** No issue - uses same nvm structure as macOS

---

### 2. Python Jobs ⚠️ POTENTIAL ISSUE

**Current Code:**
```typescript
execSync("python3 -m venv .venv", {
  cwd: params.jobDir,
  env: this.getNvmEnv(),
});
```

**Analysis:**

#### Windows Issues:
1. **`python3` command may not exist on Windows**
   - Windows Python installs typically use `python` not `python3`
   - Users installing from python.org get `python.exe` only
   - Microsoft Store Python adds `python3.exe` symlink (recent versions)

2. **Python not in PATH by default**
   - Unlike macOS/Linux, Windows Python installer asks to "Add to PATH"
   - Many users skip this option
   - Result: `python3 -m venv` fails with "not recognized"

3. **Multiple Python installations**
   - Windows can have Python 2 and 3 side-by-side
   - `python` might point to Python 2
   - `py -3` launcher is recommended but not used

#### Linux Status: ✅ NO ISSUE
- Linux distributions include `python3` by default
- PATH is properly configured
- Same code path as macOS

#### Recommended Fix:

```typescript
private async ensurePythonVenv(params: ExecutorLaunchParams): Promise<void> {
  const venvDir = path.join(params.jobDir, ".venv");
  
  // Create venv if it doesn't exist
  if (!existsSync(venvDir)) {
    await params.appendLog("Creating Python virtual environment...");
    try {
      // Platform-aware Python command
      const pythonCmd = this.getPythonCommand();
      
      execSync(`${pythonCmd} -m venv .venv`, {
        cwd: params.jobDir,
        timeout: 30_000,
        env: this.getNvmEnv(),
      });
      await params.appendLog("Virtual environment created.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await params.appendLog(`Failed to create venv: ${message}`);
      return;
    }
  }
  // ... rest of code
}

/**
 * Get the appropriate Python command for the current platform.
 * - Windows: Try python, py -3, python3 (in that order)
 * - Unix: python3
 */
private getPythonCommand(): string {
  if (process.platform === "win32") {
    // On Windows, try multiple options
    // 1. python (most common after 3.x became default)
    // 2. py -3 (Python launcher, most reliable)
    // 3. python3 (Microsoft Store Python)
    return "python"; // Simple approach: assume python3+ is aliased as python
  }
  return "python3";
}
```

**Severity:** Medium
- Most modern Windows Python installations work with `python`
- Microsoft Store Python adds `python3` symlink
- Only affects older installations or custom setups

---

### 3. Bash Jobs ⚠️ SYNTAX INCOMPATIBILITY

**Current Code:**
```typescript
// src/core/utils/platform.ts
export function getShellCommand(command: string): [string, string[]] {
  if (process.platform === "win32") {
    return [getShell(), ["/c", command]]; // cmd.exe
  }
  return [getShell(), ["-c", command]]; // bash
}
```

**Analysis:**

#### Windows Issues:
1. **Bash commands don't work in cmd.exe**
   - Commands like `ls`, `grep`, `cat` don't exist
   - Windows equivalents: `dir`, `findstr`, `type`
   - Job fails with "command not found"

2. **Path syntax differences**
   - Unix: `/Users/name/file.txt`
   - Windows: `C:\Users\name\file.txt` or `/c/Users/name/file.txt` (Git Bash)

#### Linux Status: ✅ NO ISSUE
- Same bash syntax as macOS
- Same command availability

#### Current Behavior:
The platform utility already handles this by using `cmd.exe` on Windows, but:
- **Agent might create bash-style jobs** (`ls`, `grep`, etc.)
- **Users expect bash commands** even on Windows
- **Documentation doesn't clarify** Windows limitations

#### Recommendation:
1. **Agent guidance:** System prompt should warn about Windows shell differences
2. **Error messages:** Better error when bash command fails on Windows
3. **Git Bash detection:** Optionally use Git Bash if available on Windows

---

### 4. Shell Jobs ✅ PLATFORM-AWARE

**Status:** Already handles platforms correctly via `getShellCommand()`

**Works on:**
- macOS: Uses bash
- Linux: Uses bash  
- Windows: Uses cmd.exe

**No issues found.**

---

### 5. Swift Jobs ❌ macOS-ONLY

**Status:** Platform-limited by design

**Works on:**
- macOS: ✅ (Xcode required)
- Linux: ❌ (Swift toolchain exists but not supported by jobs)
- Windows: ❌ (No Swift support)

**No cross-platform issues** - this is intentional.

---

### 6. Agent & Subagent Jobs ✅ NO PLATFORM CODE

**Status:** No platform-specific code paths

**Works on:** All platforms

**No issues found.**

---

## Summary of Findings

### Critical Issues (Block users)
1. ✅ **Node jobs on Windows** - FIXED in Issue 37

### Medium Priority (May affect some users)
2. ⚠️ **Python jobs on Windows** - `python3` command may not exist
   - **Impact:** Users with older Python installations
   - **Workaround:** Users can install Microsoft Store Python or configure PATH
   - **Fix needed:** Platform-aware Python command detection

### Low Priority (Documentation/UX)
3. ⚠️ **Bash jobs on Windows** - Syntax incompatibility expected
   - **Impact:** Agent creates bash commands that fail on Windows
   - **Workaround:** Agent should generate cmd.exe-compatible commands
   - **Fix needed:** Agent system prompt guidance

### No Issues
4. ✅ **Shell jobs** - Already platform-aware
5. ✅ **Swift jobs** - Intentionally macOS-only
6. ✅ **Agent/Subagent jobs** - No platform-specific code

---

## Linux-Specific Question: Is this the same issue?

**Answer: NO** ❌

Linux and macOS are both Unix-like systems that:
- Use the same PATH separator (`:`)
- Use the same nvm structure (`$NVM_DIR`)
- Use the same shell (`bash`)
- Use the same command names (`python3`, `node`, `npm`)

The Windows Node.js issue was Windows-specific because:
- Windows uses `;` not `:` for PATH
- Windows uses nvm-windows not nvm
- Windows uses cmd.exe not bash

**Linux works exactly the same as macOS** for job execution.

---

## Recommended Actions

### Immediate (Should fix before release)
1. ✅ **Node jobs Windows** - Already fixed
2. ⚠️ **Python jobs Windows** - Add `getPythonCommand()` method

### Short-term (Next sprint)
3. Add better error messages when commands not found on Windows
4. Update agent system prompt with Windows bash limitations
5. Add platform compatibility notes to job creation UI

### Long-term (Future enhancement)
6. Auto-detect Git Bash on Windows for better bash job support
7. Add job type warnings in UI ("Swift jobs require macOS")
8. Cross-platform job templates (agent generates platform-aware commands)

---

## Testing Checklist

Before marking any job type as "fully cross-platform":

- [ ] Test on Windows 11
- [ ] Test on macOS (Intel and Apple Silicon)
- [ ] Test on Linux (Ubuntu 22.04+)
- [ ] Test with fresh installations (no tools pre-configured)
- [ ] Test with various Python installations (python.org, Microsoft Store, Homebrew)
- [ ] Test with various Node installations (nvm, nvm-windows, system)
- [ ] Test error messages are helpful
- [ ] Test agent creates platform-appropriate commands

---

## References

- **Issue 37:** Windows Node.js PATH Fix
- **Issue 36:** Job Node Version Mismatch (Unix-only fix)
- **Platform Utils:** `src/core/utils/platform.ts`
- **Job Executor:** `src/gateway/services/jobs/executors/CommandJobExecutor.ts`
- **nvm-windows:** https://github.com/coreybutler/nvm-windows
- **Python on Windows:** https://docs.python.org/3/using/windows.html
