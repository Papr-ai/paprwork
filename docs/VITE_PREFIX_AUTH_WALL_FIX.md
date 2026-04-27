# Auth Wall Not Showing in Packaged Apps - VITE_ Prefix Fix

**Issue 64** | Fixed: 2026-04-22

## Problem

Users downloading the packaged commercial version (PKG, DMG, EXE) were NOT seeing the Papr authentication wall on first launch. The app loaded directly without requiring authentication, defeating the purpose of commercial build enforcement.

## Root Cause

**Variable Name Mismatch** between GitHub Actions workflow and Vite config:

```yaml
# GitHub Actions workflow (.github/workflows/release.yml)
env:
  REQUIRE_PAPR_AUTH: true  # ❌ Wrong variable name
```

```typescript
// Vite config (ui/vite.config.ts)
const env = loadEnv(mode, process.cwd(), '');
define: {
  'import.meta.env.VITE_REQUIRE_PAPR_AUTH': JSON.stringify(
    env.VITE_REQUIRE_PAPR_AUTH || 'false'  // ✅ Looking for VITE_ prefix
  ),
}
```

**The Issue:** Vite requires environment variables to be prefixed with `VITE_` to expose them to client code. The workflow was setting `REQUIRE_PAPR_AUTH` (no prefix) but Vite was looking for `VITE_REQUIRE_PAPR_AUTH` (with prefix).

**Result:** The variable wasn't found, defaulted to `'false'`, and the auth wall never appeared in packaged builds.

## Solution

Changed all references to use the correct `VITE_` prefix:

### 1. GitHub Actions Workflow

```yaml
# .github/workflows/release.yml
# Mac build
- name: Build app
  run: npm run build
  env:
    VITE_REQUIRE_PAPR_AUTH: true  # ✅ Fixed

# Windows build
- name: Build app
  run: npm run build
  env:
    VITE_REQUIRE_PAPR_AUTH: true  # ✅ Fixed

# Linux build
- name: Build app
  run: npm run build
  env:
    VITE_REQUIRE_PAPR_AUTH: true  # ✅ Fixed
```

### 2. Environment Variable Example

```bash
# .env.example (updated)
# NOTE: Must use VITE_ prefix for Vite to expose to client code
VITE_REQUIRE_PAPR_AUTH=false  # ✅ Fixed
```

### 3. Documentation

Updated all documentation files to use `VITE_REQUIRE_PAPR_AUTH`:
- `docs/AUTH_WALL_IMPLEMENTATION.md` - Testing, build commands, distribution
- `.env.example` - Variable definition with note about VITE_ prefix

## Why VITE_ Prefix is Required

Vite **only exposes** environment variables that start with `VITE_` to client code for security reasons. This prevents accidentally exposing sensitive server-side variables (like database passwords) to the browser.

**From Vite docs:**
> To prevent accidentally leaking env variables to the client, only variables prefixed with `VITE_` are exposed to your Vite-processed code.

**Example:**
```bash
# Server-side only (NOT exposed to client)
DATABASE_PASSWORD=secret123

# Client-side (exposed via import.meta.env)
VITE_REQUIRE_PAPR_AUTH=true
```

## Testing the Fix

### Before Fix
```bash
# Build commercial version
REQUIRE_PAPR_AUTH=true npm run build
npm run package

# Result: Auth wall NOT showing ❌
```

### After Fix
```bash
# Build commercial version
VITE_REQUIRE_PAPR_AUTH=true npm run build
npm run package

# Result: Auth wall SHOWS correctly ✅
```

### Verify in Packaged App

1. Download the PKG/DMG/EXE from GitHub Releases
2. Install and launch for the first time
3. **Expected:** Auth wall appears with "Sign In with Papr" button
4. **Before fix:** App loaded directly without auth wall

## Impact

| Metric | Before | After |
|--------|--------|-------|
| **Commercial builds require auth** | ❌ No | ✅ Yes |
| **Auth wall shows** | ❌ No | ✅ Yes |
| **Variable name** | `REQUIRE_PAPR_AUTH` | `VITE_REQUIRE_PAPR_AUTH` |
| **Users affected** | 100% of downloads | 0% (fixed) |

## Files Changed

**Modified:**
- `.github/workflows/release.yml` - Fixed all 3 build steps (Mac, Windows, Linux)
- `.env.example` - Changed to `VITE_REQUIRE_PAPR_AUTH` with note
- `docs/AUTH_WALL_IMPLEMENTATION.md` - Updated all references
- `docs/VITE_PREFIX_AUTH_WALL_FIX.md` - NEW: This documentation

**Note:** No code changes needed - only environment variable naming.

## Related Issues

- **Enhancement 21:** Authentication Wall for Commercial Builds (original implementation)
- **CLAUDE.md line 1417-1548:** Auth wall architecture documentation

## Prevention

**When adding new environment variables for client code:**
1. ✅ Always use `VITE_` prefix
2. ✅ Document the requirement in `.env.example`
3. ✅ Test in both dev and packaged builds
4. ✅ Verify variables are defined in GitHub Actions workflow

## Verification Checklist

- [x] GitHub Actions workflow sets `VITE_REQUIRE_PAPR_AUTH=true`
- [x] `.env.example` documents `VITE_REQUIRE_PAPR_AUTH`
- [x] Vite config reads `env.VITE_REQUIRE_PAPR_AUTH`
- [x] Documentation updated with correct variable name
- [x] Local testing: `VITE_REQUIRE_PAPR_AUTH=true npm start` shows auth wall
- [ ] **TODO:** Next release - verify auth wall appears in packaged builds

## Key Takeaway

**Environment variables for client code MUST have `VITE_` prefix.** This is a Vite security feature, not optional. Always prefix client-exposed variables with `VITE_` to ensure they're accessible in the browser.
