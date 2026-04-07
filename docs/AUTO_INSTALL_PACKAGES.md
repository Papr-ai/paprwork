# Auto-Installing Missing Packages - Agent-Driven Setup

**Feature:** Issue 40  
**Added:** 2026-04-06  
**Status:** ✅ IMPLEMENTED

## Problem

Non-technical users get stuck when essential packages (Python, Node.js, Git) are missing. They don't know:
- What the error means
- How to install the package
- Which command to run
- Whether they did it correctly

**Before:**
```
Error: python3 is not recognized as a command
```
User is stuck. ❌

## Solution

**Agent automatically offers to install missing packages when needed.**

### User Experience

**User:** "Create a Python job that scrapes this website"

**Agent detects Python missing:**
"I notice Python is not installed on this Windows machine. May I install it for you? (Takes ~2-3 minutes)"

**User:** "Yes please"

**Agent installs:**
```bash
[Running] winget install Python.Python.3.12 --silent
[Progress] Installing Python...
[Success] Python 3.12.8 installed successfully!
```

**Agent continues:**
"Now creating your scraper job..."

✅ **Task completed. User never left the chat.**

---

## Implementation

### 1. Package Manager Utility (`src/gateway/utils/packageManager.ts`)

Provides:
- `checkPackage(name)` - Detects if package installed
- `installPackage(name)` - Runs installation command
- `getAgentInstallInstructions(name)` - Returns install commands per platform

**Supported Packages:**
- **Python** (essential for Python jobs)
- **Node.js** (essential for Node jobs)
- **Git** (recommended for version control)
- **curl** (essential for web requests)

### 2. System Prompt Integration (`src/core/agents/SystemPrompt.ts`)

Added `buildMissingPackagesSection()` with:
- Detection guidelines ("not found", "not recognized")
- Permission flow ("May I install X?")
- Platform-specific install commands
- Verification steps
- Fallback manual instructions

### 3. Platform-Specific Commands

| Package | Windows | macOS | Linux |
|---------|---------|-------|-------|
| **Python** | `winget install Python.Python.3.12 --silent` | `brew install python@3.12` | `sudo apt-get install python3 python3-pip` |
| **Node.js** | `winget install OpenJS.NodeJS.LTS --silent` | `brew install node@24` | `curl ...nodesource... && apt-get install nodejs` |
| **Git** | `winget install Git.Git --silent` | `brew install git` | `sudo apt-get install git` |
| **curl** | `winget install cURL.cURL --silent` | Pre-installed | `sudo apt-get install curl` |

---

## Agent Workflow

### Step 1: Detect Missing Package

Job or command fails with:
- "python is not recognized"
- "node: command not found"  
- "git: not found"
- Any similar error

### Step 2: Ask Permission

Agent responds:
```
I notice [Package Name] is not installed on this [Platform] machine.
May I install it for you? (Takes ~2-3 minutes)
```

**Key elements:**
- Name the package (Python, Node.js, Git)
- Name the platform (Windows, macOS, Linux)
- Estimated time (1-5 minutes)
- Ask explicitly (don't assume yes)

### Step 3: Install (If Approved)

Use bash tool:
```typescript
bash({
  command: "winget install Python.Python.3.12 --silent"
})
```

Show progress if available:
```
[Running] winget install Python.Python.3.12 --silent
Installing: Python 3.12... █████████░░░░░░░░░░░ 45%
```

### Step 4: Verify Installation

```typescript
bash({ command: "python --version" })
// Expected: Python 3.12.8
```

If verification fails:
```
Installation completed but [Package] not found in PATH.
Please try manual installation: [link]
Or restart the app and try again.
```

### Step 5: Continue Original Task

Agent picks up where it left off:
```
Python 3.12.8 installed successfully!
Now creating your scraper job...
```

---

## Safety & Rules

### 1. ALWAYS Ask Permission First

❌ **DON'T:**
```
[Agent silently runs] winget install Python...
```

✅ **DO:**
```
May I install Python for you? (Takes ~2-3 minutes)
```

### 2. Show Estimated Time

Users need to know:
- Python: ~2-3 minutes
- Node.js: ~1-2 minutes
- Git: ~1 minute
- curl: <30 seconds

### 3. Verify Success

Don't assume installation worked:
```bash
# After install, verify:
python --version
# Check output contains version number
```

### 4. Handle Failures Gracefully

If automatic install fails:
```
Installation failed: [error message]

You can install manually from: https://www.python.org/downloads/

Steps:
1. Click the link above
2. Download installer for Windows
3. During installation, check "Add to PATH"
4. Restart Paprwork
```

### 5. Platform Awareness

Use correct command for user's platform:
- **Windows:** `winget install`
- **macOS:** `brew install`
- **Linux:** `apt-get install` (Debian/Ubuntu)

---

## Examples

### Example 1: Python Job on Fresh Windows Install

**User:** "Create a daily job to scrape HackerNews top stories"

**Agent:**
```
I notice Python is not installed on this Windows machine.
May I install it for you? (Takes ~2-3 minutes)
```

**User:** "Sure"

**Agent:**
```bash
bash({ command: "winget install Python.Python.3.12 --silent" })
```

**Output:**
```
Found Python.Python.3.12 [Python Software Foundation]
This application is licensed to you by its owner.
Microsoft is not responsible for, nor does it grant any licenses to, third-party packages.
Downloading https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe
Successfully verified installer hash
Starting package install...
Successfully installed
```

**Agent:**
```bash
bash({ command: "python --version" })
```

**Output:** `Python 3.12.8`

**Agent:**
```
Python 3.12.8 installed successfully!

Now creating your HackerNews scraper job...
[Creates job with Python]
Done! Job "HN Top Stories" will run daily at 8 AM.
```

### Example 2: Node Job Without Node.js

**User:** "Create a Node job to process CSV files"

**Agent:**
```
I notice Node.js is not installed on this macOS machine.
May I install it for you? (Takes ~1-2 minutes)
```

**User:** "yes please"

**Agent:**
```bash
bash({ command: "brew install node@24" })
```

**Output:**
```
==> Downloading https://ghcr.io/v2/homebrew/core/node/24/manifests/24.13.0
...
🍺  /opt/homebrew/Cellar/node/24.13.0: 2,890 files, 82.5MB
```

**Agent:**
```bash
bash({ command: "node --version" })
```

**Output:** `v24.13.0`

**Agent:**
```
Node.js 24.13.0 installed successfully!

Creating your CSV processor job...
[Creates Node job]
Done! Job "CSV Processor" created and ready to run.
```

### Example 3: Installation Fails (Manual Fallback)

**User:** "Create a Python web scraper"

**Agent:**
```
I notice Python is not installed. May I install it? (Takes ~2-3 minutes)
```

**User:** "ok"

**Agent:**
```bash
bash({ command: "winget install Python.Python.3.12 --silent" })
```

**Error:**
```
Error: The system cannot execute the specified program.
(winget not available on Windows 10)
```

**Agent:**
```
Installation failed: winget is not available on your system.

Please install Python manually:
1. Visit: https://www.python.org/downloads/windows/
2. Download Python 3.12 installer
3. During installation, check "Add Python to PATH"
4. Restart Paprwork
5. Try again

Would you like me to guide you through the manual installation?
```

---

## Package Manager Requirements

### Windows
- **winget** (Windows Package Manager) - Built into Windows 11
- **Windows 10:** Requires manual install from Microsoft Store
- **Fallback:** Manual installation links

### macOS
- **Homebrew** - Most macOS users have it
- **Check:** `brew --version`
- **Install Homebrew:** `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
- **Fallback:** Manual installation from official sites

### Linux
- **apt** (Debian/Ubuntu) - Pre-installed
- **Other distros:** Agent provides appropriate commands (yum, dnf, pacman)
- **Fallback:** Manual compilation/installation

---

## Benefits

### For Non-Technical Users
- ✅ No need to leave the app
- ✅ No need to Google "how to install Python"
- ✅ No confusion about PATH or environment variables
- ✅ Installation happens in 1-3 minutes vs 10-20 minutes manually

### For Technical Users
- ✅ Still works (they can approve or decline)
- ✅ Saves time (no need to context switch)
- ✅ Consistent across platforms
- ✅ Can still install manually if preferred

### For Support
- ✅ Fewer "it doesn't work" tickets
- ✅ Clearer error messages
- ✅ Users can screenshot the permission prompt (shows what was attempted)
- ✅ Fallback instructions always provided

---

## Testing

### Manual Test Scenarios

1. **Fresh Windows 11 without Python:**
   - User asks to create Python job
   - Agent detects Python missing
   - Agent asks permission
   - User approves
   - Verify winget installs Python
   - Verify job creation succeeds

2. **macOS without Node.js:**
   - User asks to create Node job
   - Agent detects Node missing
   - Agent asks permission (mentioning Homebrew)
   - User approves
   - Verify brew installs Node
   - Verify job works

3. **Windows 10 without winget:**
   - Agent attempts winget command
   - Command fails (winget not found)
   - Agent provides manual installation guide
   - Verify fallback instructions are clear

4. **User Declines Installation:**
   - Agent asks permission
   - User says "no" or "not now"
   - Agent respects choice
   - Agent explains what user needs to do manually

### Automated Tests

```typescript
describe('PackageManager', () => {
  it('detects missing Python', async () => {
    const result = await checkPackage('python');
    expect(result.installed).toBe(false);
    expect(result.installCommand).toContain('winget' || 'brew' || 'apt-get');
  });
  
  it('provides platform-specific commands', () => {
    const instructions = getAgentInstallInstructions('python');
    if (platform() === 'win32') {
      expect(instructions).toContain('winget');
    }
  });
});
```

---

## Future Enhancements

### Phase 1 (Current) ✅
- Agent asks permission
- Platform-specific commands
- Verification after install
- Manual fallback instructions

### Phase 2 (Future)
- UI progress indicator during installation
- One-click "Install All Missing Packages" button
- Pre-flight check: scan for missing packages on app startup
- Optional auto-install mode (skip permission for trusted packages)

### Phase 3 (Long-term)
- Bundle Python/Node with app (no installation needed)
- Virtual environments automatically managed
- Package version management
- Automatic updates for bundled packages

---

## Related Issues

- **Issue 37:** Windows Node.js PATH (manual fix required)
- **Issue 38:** Python command detection (manual install guide)
- **Issue 39:** Playwright missing (required manual npm install)
- **Issue 40:** **THIS FIX** - Agent auto-installs packages

**Pattern:** Moving from manual fixes → agent-driven solutions for non-technical users

---

## Files

**Created:**
- `src/gateway/utils/packageManager.ts` - Package detection and installation
- `docs/AUTO_INSTALL_PACKAGES.md` - This documentation

**Modified:**
- `src/core/agents/SystemPrompt.ts` - Added `buildMissingPackagesSection()`

**Size:** ~350 lines of utility code + ~80 lines of system prompt

---

## Conclusion

**Before (Issues 37-39):**
```
Error: python3 is not recognized
→ User searches Google
→ User downloads installer
→ User forgets to check "Add to PATH"
→ Still doesn't work
→ User gives up
```

**After (Issue 40):**
```
Agent: "May I install Python? (2 minutes)"
User: "Yes"
[2 minutes later]
Agent: "Done! Your job is running."
```

**This is what "AI assistant" should mean.** 🎉
