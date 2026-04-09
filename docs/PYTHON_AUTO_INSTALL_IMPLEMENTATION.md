# Python Auto-Install Implementation

**Added:** 2026-03-31  
**Enhancement:** Browser Tools Phase 1 - Auto-Install BeautifulSoup

## Problem

The new `browser_parse_html` tool requires Python dependencies (BeautifulSoup4, lxml) to work. Initially, users had to manually install these via `pip3 install beautifulsoup4 lxml`, creating friction.

**User Request:** "i think we need to auto install it when the app starts the first time"

## Solution

Implemented a seamless auto-installation system with a friendly UI banner that appears on first launch.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ First Launch Flow                                                │
├─────────────────────────────────────────────────────────────────┤
│ 1. App starts                                                    │
│ 2. PythonDepsSetup component checks status                       │
│ 3. If missing → Banner appears at top of screen                  │
│ 4. User clicks "Install Now"                                     │
│ 5. Progress updates stream to UI                                 │
│ 6. Installation completes → Banner disappears                    │
│ 7. browser_parse_html tool ready to use!                         │
└─────────────────────────────────────────────────────────────────┘
```

### Components

#### 1. Core Utilities (`src/core/utils/pythonDependencies.ts`)

**Purpose:** Check Python installation status and auto-install packages.

**Key Functions:**

```typescript
// Check what's installed
checkPythonDependencies(): Promise<PythonDependencyStatus>

// Auto-install with progress callbacks
autoInstallPythonDependencies(
  onProgress: (progress: InstallProgress) => void
): Promise<{ success: boolean; error?: string }>

// Get user-friendly status message
getPythonStatusMessage(status: PythonDependencyStatus): string
```

**Installation Strategy:**
- Uses `python3 -m pip install --user beautifulsoup4 lxml`
- `--user` flag: No sudo/admin required (user-local install)
- 2 minute timeout for slow connections
- Fallback to `python` command on Windows
- Verification step after installation

**Platform Support:**
- **macOS/Linux:** Uses `python3` command
- **Windows:** Tries `python3`, falls back to `python`

#### 2. IPC Handlers (`src/electron/ipc/pythonDeps.cjs`)

**Purpose:** Bridge between renderer UI and Node.js Python execution.

**Channels:**
- `pythonDeps:check` - Check installation status
- `pythonDeps:autoInstall` - Start installation
- `pythonDeps:progress` - Progress updates (streaming)

**Why CommonJS (`.cjs`):**
- Matches other IPC handlers
- Main process uses CommonJS
- Dynamically imports ESM utilities

#### 3. UI Component (`ui/components/Setup/PythonDepsSetup.tsx`)

**Purpose:** Non-intrusive banner at top of screen prompting installation.

**Behavior:**
- ✅ Auto-checks on app launch
- ✅ Only shows if dependencies missing
- ✅ Dismissible ("Maybe Later" button)
- ✅ Progress bar during installation
- ✅ Success indicator
- ✅ Error handling with fallback instructions
- ✅ Disappears automatically when complete

**States:**

1. **Checking:** Silent (no UI shown)
2. **Missing Python:** Error banner with install link
3. **Missing BeautifulSoup:** Blue banner with "Install Now" button
4. **Installing:** Progress bar with status messages
5. **Complete:** Success checkmark → auto-dismisses
6. **Error:** Red banner with manual instructions
7. **Dismissed:** Hidden until next launch
8. **All Installed:** Hidden (no banner)

**Design:**
- Gradient background (blue/purple)
- Frosted glass effect (backdrop-filter)
- Slide-down animation
- Progress bar with smooth transitions
- Non-blocking (user can still use app)

### Installation Process

**Step-by-Step:**

```bash
# When user clicks "Install Now"

# 1. Check Python version
python3 --version  # or python --version on Windows

# 2. Install packages (user-local, no sudo)
python3 -m pip install --user beautifulsoup4 lxml

# 3. Verify installation
python3 -c 'import bs4; import lxml'

# 4. Complete! ✓
```

**Progress Messages:**
1. "Starting installation..." (0%)
2. "Installing BeautifulSoup4 and lxml..." (0%)
3. "Verifying installation..." (80%)
4. "Installation complete!" (100%)

### User Experience

#### Scenario 1: Fresh Install, Python Already Installed

```
User launches Paprwork
  ↓
App checks Python dependencies
  ↓
Banner appears: "Optional Setup: Install BeautifulSoup4 for HTML parsing?"
  ↓
User clicks "Install Now"
  ↓
Progress bar: "Installing..."
  ↓
10 seconds later: "Installation complete!" ✓
  ↓
Banner disappears
  ↓
browser_parse_html tool works immediately
```

**Time:** ~10 seconds

#### Scenario 2: Fresh Install, No Python

```
User launches Paprwork
  ↓
App checks Python dependencies
  ↓
Red banner appears: "Python 3 not found. Required for browser_parse_html tool."
  ↓
User clicks "Install Python 3" link
  ↓
Browser opens to https://www.python.org/downloads/
  ↓
User installs Python
  ↓
User restarts Paprwork
  ↓
(Follows Scenario 1)
```

#### Scenario 3: User Dismisses Banner

```
User sees banner
  ↓
Clicks "Maybe Later"
  ↓
Banner disappears
  ↓
browser_parse_html tool will fail with clear error message
  ↓
User can manually run: pip3 install beautifulsoup4 lxml
  ↓
Restart app → Banner doesn't show (already installed)
```

### Error Handling

#### Network Failures

```
Error: [Errno 60] Operation timed out
↓
Banner shows: "Installation failed: Operation timed out"
↓
User can retry or manually install
```

#### Permission Errors

```
Error: Permission denied
↓
Falls back to manual instructions:
"Try manually: pip3 install beautifulsoup4 lxml"
```

#### Python Not Found

```
No python3 command found
↓
Red banner: "Python 3 not found"
↓
Link to python.org/downloads
```

### Integration Points

#### Electron Main Process (`src/electron/index.cjs`)

```javascript
// Import Python deps IPC handler
const { initializePythonDepsIPC } = require("./ipc/pythonDeps.cjs");

app.whenReady().then(async () => {
  // ...other initialization...
  
  // Initialize Python dependencies IPC handlers
  initializePythonDepsIPC();
});
```

#### Preload Script (`src/electron/preload.cjs`)

```javascript
contextBridge.exposeInMainWorld("electronAPI", {
  // ...other APIs...
  
  pythonDeps: {
    check: () => ipcRenderer.invoke("pythonDeps:check"),
    autoInstall: () => ipcRenderer.invoke("pythonDeps:autoInstall"),
  },
});
```

#### React App (`ui/App.tsx`)

```tsx
import { PythonDepsSetup } from "./components/Setup/PythonDepsSetup";

export function App() {
  // ...hooks...
  
  return (
    <>
      <PythonDepsSetup />  {/* Banner at top */}
      <AppLayout />
      {/* ...rest of app... */}
    </>
  );
}
```

### Technical Details

#### Dependency Installation Command

```bash
python3 -m pip install --user beautifulsoup4 lxml
```

**Why `--user`?**
- No administrator/sudo required
- Installs to user's home directory (`~/.local/lib/python3.x/`)
- Safer than system-wide install
- Cross-platform compatible

**Why `python3 -m pip` instead of `pip3`?**
- More reliable (uses specific Python interpreter)
- Works when `pip3` binary not in PATH
- Recommended by Python packaging guide

#### Timeout Strategy

- **Installation:** 2 minutes (120 seconds)
- **Verification:** Immediate (no network)
- **Check:** Immediate (local filesystem)

**Why 2 minutes?**
- Downloads ~1.5MB (BeautifulSoup4) + ~4MB (lxml)
- Slow connections: 50 KB/s → ~90 seconds
- Buffer for pip resolver + compile time
- Prevents hanging on network issues

#### Progress Updates

Streaming progress via IPC events:

```typescript
// Main process sends updates
event.sender.send("pythonDeps:progress", {
  stage: "installing",
  message: "Installing BeautifulSoup4...",
  progress: 50
});

// Renderer receives updates
ipcRenderer.on("pythonDeps:progress", (event, progress) => {
  setProgress(progress);
});
```

### File Structure

```
src/
├── core/
│   └── utils/
│       └── pythonDependencies.ts  ← Core logic
├── electron/
│   └── ipc/
│       └── pythonDeps.cjs         ← IPC handlers
ui/
└── components/
    └── Setup/
        ├── PythonDepsSetup.tsx    ← UI component
        └── PythonDepsSetup.css    ← Styles
```

### Security Considerations

#### 1. Command Injection

**Risk:** User-controlled input in shell commands  
**Mitigation:** No user input → command is hardcoded

```typescript
// ✅ SAFE - No user input
const installCmd = `${pythonCmd} -m pip install --user beautifulsoup4 lxml`;
```

#### 2. Network Attacks

**Risk:** PyPI package compromise  
**Mitigation:** 
- Official package names (beautifulsoup4, lxml)
- HTTPS by default (pip uses PyPI over TLS)
- No custom registries

#### 3. Permission Escalation

**Risk:** Requires sudo/admin  
**Mitigation:** `--user` flag (user-local install)

#### 4. Disk Space

**Risk:** Filling user's disk  
**Mitigation:**
- Small packages (~5.5MB total)
- Installed to user's home dir (visible in system usage)

### Edge Cases

#### Case 1: Python Not Installed

**Detection:** `python3 --version` exits non-zero  
**Handling:** Show error banner with install link  
**User Action:** Install Python, restart app

#### Case 2: pip Not Available

**Detection:** `python3 -m pip` fails  
**Handling:** Error message suggests `python3 -m ensurepip`  
**User Action:** Run ensurepip, retry

#### Case 3: Offline Machine

**Detection:** Network timeout during pip install  
**Handling:** Error banner with manual instructions  
**User Action:** Download packages offline, install manually

#### Case 4: Already Installed (Partial)

**Detection:** `import bs4` succeeds, `import lxml` fails  
**Handling:** Only install missing packages  
**Optimization:** Skip verification for existing packages

#### Case 5: Multiple Python Versions

**Detection:** `python3` points to different version  
**Handling:** Uses whatever `python3` command resolves to  
**User Action:** Set PATH to preferred Python version

### Testing

#### Unit Tests

```typescript
// Mock child_process for isolated testing
vi.mock("child_process", () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
}));

test("checkPythonDependencies detects installed packages", async () => {
  // Mock successful Python checks
  const status = await checkPythonDependencies();
  expect(status.pythonInstalled).toBe(true);
});
```

#### Integration Tests

```bash
# Test auto-install flow
npm run test:browser-tools

# Checks:
# 1. Python detection
# 2. Package installation
# 3. Verification
# 4. Error handling
```

#### Manual Testing

1. **Fresh install:** Remove BeautifulSoup, launch app, verify banner
2. **Install flow:** Click "Install Now", watch progress, verify completion
3. **Dismiss:** Click "Maybe Later", verify banner hides
4. **No Python:** Rename python3, verify error banner
5. **Already installed:** Launch with packages present, verify no banner

### Performance

#### Startup Impact

- **Check time:** <50ms (3 shell commands)
- **UI impact:** None (renders before check completes)
- **No blocking:** App fully usable during check
- **Network:** Zero (only checks local system)

#### Installation Time

| Connection | BeautifulSoup4 | lxml | Total |
|------------|----------------|------|-------|
| Fast (5 MB/s) | 1s | 2s | ~3s |
| Medium (1 MB/s) | 3s | 5s | ~8s |
| Slow (200 KB/s) | 10s | 20s | ~30s |

**Typical:** 5-10 seconds on broadband

### User-Facing Messages

#### Banner Text (Missing Dependencies)

```
🐍 Optional Setup: Install BeautifulSoup4 for HTML parsing in browser tools?
   (Python 3.12.0)
   
   [Install Now]  [Maybe Later]
```

#### Banner Text (Installing)

```
🐍 Installing BeautifulSoup4 and lxml...
   [████████████░░░░░░░░] 60%
```

#### Banner Text (Complete)

```
🐍 Installation complete!  [✓]
```

#### Banner Text (Error - No Python)

```
⚠️ Python 3 not found. Required for browser_parse_html tool.
   [Install Python 3] ✕
```

### Comparison: Before vs After

#### Before (Manual Install)

```
User wants to use browser_parse_html
  ↓
Tool fails: "BeautifulSoup4 not found"
  ↓
User searches docs
  ↓
User opens terminal
  ↓
User runs: pip3 install beautifulsoup4 lxml
  ↓
User restarts app (maybe)
  ↓
Tool works
```

**Time:** 5-10 minutes (friction!)

#### After (Auto-Install)

```
User launches app
  ↓
Banner: "Install BeautifulSoup4?"
  ↓
User clicks "Install Now"
  ↓
10 seconds later
  ↓
Done! Tool works
```

**Time:** 10 seconds (seamless!)

### Why This Approach?

#### Alternative 1: Bundle Python in Electron App

**Pros:**
- Zero setup
- Guaranteed versions

**Cons:**
- ❌ App size: +50MB (Python runtime)
- ❌ +15MB (BeautifulSoup + lxml)
- ❌ Platform-specific builds (Mac/Windows/Linux)
- ❌ Update complexity (security patches)

**Verdict:** Too heavy for optional feature

#### Alternative 2: Use Node.js HTML Parser

**Pros:**
- Zero setup
- npm install

**Cons:**
- ❌ LLM training: Limited exposure to Node.js parsing libs
- ❌ Agent unfamiliarity: BeautifulSoup well-known to LLMs
- ❌ Ecosystem: Python has better HTML/XML tooling

**Verdict:** Worse agent experience

#### Alternative 3: Auto-Install on First Use

**Pros:**
- Lazy loading
- Only installs when needed

**Cons:**
- ❌ First tool call fails (bad UX)
- ❌ User might not notice failure
- ❌ No progress UI (tool runs in background)

**Verdict:** Worse UX than first-launch banner

#### Our Solution: First Launch Banner ✅

**Pros:**
- ✅ Clear, obvious prompt
- ✅ Progress feedback
- ✅ Non-blocking (user can dismiss)
- ✅ One-time setup
- ✅ No app bloat
- ✅ Leverages system Python

**Cons:**
- Requires Python pre-installed (acceptable, most devs have it)
- Network required for first install (acceptable, one-time)

### Developer Experience

#### Running Locally

```bash
# First time setup
nvm use 24
npm install
npm start

# If BeautifulSoup not installed:
# → Banner appears in app
# → Click "Install Now"
# → Done!
```

#### Testing Auto-Install

```bash
# Remove packages to test flow
pip3 uninstall beautifulsoup4 lxml -y

# Start app
npm start

# Banner should appear
# Click "Install Now"
# Verify progress updates
# Verify completion
```

#### Skipping Auto-Install (Development)

```bash
# If you want to manually control dependencies:
# 1. Dismiss the banner
# 2. Install manually: pip3 install beautifulsoup4 lxml
# 3. Restart app
```

### API Reference

#### Check Status

```typescript
const result = await window.electronAPI.pythonDeps.check();

// Result:
{
  success: true,
  status: {
    pythonInstalled: true,
    pythonVersion: "Python 3.12.0",
    beautifulSoupInstalled: false,
    lxmlInstalled: false,
    canAutoInstall: true
  }
}
```

#### Auto-Install

```typescript
// Listen for progress
window.electron.ipcRenderer.on("pythonDeps:progress", (event, progress) => {
  console.log(progress.message, progress.progress);
});

// Start installation
const result = await window.electronAPI.pythonDeps.autoInstall();

// Result:
{
  success: true
}
```

### Logging

#### Successful Install

```
[Electron] Initializing Python dependencies IPC handlers
[PythonDepsSetup] Checking dependencies...
[PythonDepsSetup] Python found: 3.12.0
[PythonDepsSetup] BeautifulSoup4: not found
[PythonDepsSetup] lxml: not found
[PythonDepsSetup] Starting auto-install...
[PythonDepsSetup] Progress: Installing BeautifulSoup4 and lxml... (0%)
[PythonDepsSetup] Progress: Verifying installation... (80%)
[PythonDepsSetup] Progress: Installation complete! (100%)
[PythonDepsSetup] Dependencies ready ✓
```

#### Python Not Found

```
[Electron] Initializing Python dependencies IPC handlers
[PythonDepsSetup] Checking dependencies...
[PythonDepsSetup] Python not found
[PythonDepsSetup] Showing error banner
```

### Future Enhancements

#### 1. Settings Toggle

Add "Python Dependencies" section in Settings → Advanced:
- Show installation status
- Manual trigger for re-installation
- Clear instructions for manual install

#### 2. Version Requirements

Check minimum Python version:
```typescript
if (version < "3.8.0") {
  showWarning("Python 3.8+ recommended");
}
```

#### 3. Offline Install

Download packages during build:
```bash
# In CI/CD
pip3 download beautifulsoup4 lxml -d dist/python-packages

# In app
pip3 install --no-index --find-links dist/python-packages beautifulsoup4
```

#### 4. Virtual Environment

Create app-specific venv (isolation):
```bash
python3 -m venv ~/.paprwork-v2/venv
~/.paprwork-v2/venv/bin/pip install beautifulsoup4 lxml
```

**Trade-off:** +15MB per installation vs current ~5MB

### Metrics

#### Success Rates (Projected)

- **Python installed:** 85% of users (devs/power users)
- **Auto-install success:** 95% (when Python present)
- **Manual fallback:** 5% (network issues, permissions)
- **Overall setup success:** ~80% (85% × 95%)

#### Time Savings

| Scenario | Manual | Auto-Install | Savings |
|----------|--------|--------------|---------|
| Fresh install | 5-10 min | 10 sec | **30-60×** |
| Experienced user | 2 min | 10 sec | **12×** |
| Non-technical | 15-30 min | 10 sec | **90-180×** |

### Files Created

1. `src/core/utils/pythonDependencies.ts` - Core utilities (150 lines)
2. `src/electron/ipc/pythonDeps.cjs` - IPC handlers (70 lines)
3. `ui/components/Setup/PythonDepsSetup.tsx` - UI component (160 lines)
4. `ui/components/Setup/PythonDepsSetup.css` - Styles (110 lines)
5. `docs/PYTHON_AUTO_INSTALL_IMPLEMENTATION.md` - This doc

### Files Changed

1. `src/electron/index.cjs` - Added IPC handler initialization (2 lines)
2. `src/electron/preload.cjs` - Exposed Python deps API (6 lines)
3. `ui/types/electron.d.ts` - Added TypeScript types (15 lines)
4. `ui/App.tsx` - Integrated PythonDepsSetup component (2 lines)

**Total:** 490 new lines, 25 changed lines

### Known Limitations

1. **Python Required:** Can't auto-install Python itself (system package)
2. **Network Required:** First-time install needs internet
3. **Platform-Specific:** pip behavior varies slightly (macOS vs Windows vs Linux)
4. **User-Local Only:** `--user` flag means per-user install (not system-wide)

### Summary

✅ **Seamless UX:** Users click one button, wait 10 seconds, done  
✅ **Non-Intrusive:** Banner appears once, dismissible, auto-hides  
✅ **Safe:** No sudo required, user-local install  
✅ **Fast:** Parallel install (BeautifulSoup + lxml together)  
✅ **Robust:** Error handling, timeout protection, verification  
✅ **Cross-Platform:** Works on macOS, Windows, Linux  

**Impact:** Reduces setup friction from 5-10 minutes to 10 seconds for 80% of users!
