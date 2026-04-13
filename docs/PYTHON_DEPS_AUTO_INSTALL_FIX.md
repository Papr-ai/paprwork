# Python Dependencies Auto-Install Fix

**Date:** 2026-04-12  
**Issue:** Silent background installation of BeautifulSoup4 and lxml

## Problems Fixed

### 1. Module Import Path Error
**Error:** `Cannot find module '.../src/dist/core/utils/pythonDependencies.js'`
**Root Cause:** Wrong relative path in `pythonDeps.cjs` - used `../../dist/` which resolved to `/src/dist/` (doesn't exist)
**Fix:** Changed to `../../../dist/` (three levels up from `/src/electron/ipc/`)

### 2. Virtualenv --user Flag Error
**Error:** `ERROR: Can not perform a '--user' install. User site-packages are not visible in this virtualenv.`
**Root Cause:** Installation always used `--user` flag, which doesn't work in virtualenvs
**Fix:** Detect virtualenv and omit `--user` flag when inside one

### 3. User-Facing Banner
**Problem:** Non-technical users saw confusing "Install BeautifulSoup4?" banner
**Fix:** Made installation completely silent in background - no UI shown

## Implementation

### Virtualenv Detection
```python
# Detects if Python is running in a virtualenv
import sys
print(hasattr(sys, 'real_prefix') or (hasattr(sys, 'base_prefix') and sys.base_prefix != sys.prefix))
```

Returns `True` if in virtualenv, `False` otherwise.

### Install Command Logic
```typescript
const isVirtualEnv = /* detect virtualenv */;
const userFlag = isVirtualEnv ? "" : "--user";
const installCmd = `python3 -m pip install ${userFlag} beautifulsoup4 lxml`;
```

- **In virtualenv:** `python3 -m pip install beautifulsoup4 lxml` (no --user)
- **Not in virtualenv:** `python3 -m pip install --user beautifulsoup4 lxml` (with --user)

## Files Changed

1. **src/electron/ipc/pythonDeps.cjs**
   - Fixed import path from `../../dist/` to `../../../dist/`
   - Added error handling with clear warning message

2. **src/core/utils/pythonDependencies.ts**
   - Added virtualenv detection
   - Made --user flag conditional
   - Added logging for debugging

3. **ui/components/Setup/PythonDepsSetup.tsx**
   - Removed all UI rendering (banner, progress, errors)
   - Made installation completely silent
   - Only logs to console for debugging

## User Experience

**Before:**
- ❌ Error banner shown asking "Install BeautifulSoup4?"
- ❌ Installation failed in virtualenvs with cryptic error
- ❌ Users confused about what BeautifulSoup4 is

**After:**
- ✅ No UI shown - completely silent
- ✅ Works in both virtualenv and system Python
- ✅ Auto-installs on first app launch
- ✅ Only console logs for debugging

## Testing

1. **System Python (no virtualenv):**
   ```bash
   npm start
   # Check console: Should see "Auto-installing..." then "✓ installed successfully"
   # Verify: python3 -c "import bs4; import lxml"
   ```

2. **With virtualenv:**
   ```bash
   python3 -m venv myenv
   source myenv/bin/activate
   npm start
   # Check console: Should see "Virtualenv detected: true"
   # Should install without --user flag
   ```

3. **Already installed:**
   ```bash
   npm start
   # Check console: "All Python dependencies already installed"
   # No installation attempted
   ```

## Related

- **browser_parse_html tool:** Requires BeautifulSoup4 for HTML parsing
- **lxml:** Optional but recommended for 2-3x faster parsing
- **Enhancement 50:** Persistent Python worker for performance (10-20x speedup)

## Future Improvements

1. Detect pip not installed and offer installation
2. Handle Python 2 vs Python 3 detection better
3. Support conda environments (similar to virtualenv)
4. Offer manual installation instructions on failure (agent-driven)
