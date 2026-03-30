# Authentication Wall - Commercial vs Open Source Builds

**Added:** 2026-03-29

## Overview

Paprwork V2 supports two build modes:
1. **Open Source Mode** (default) - Papr authentication is optional
2. **Commercial Mode** - Papr authentication is **required** before accessing the app

This allows the downloadable commercial version to enforce Papr login while keeping the open-source codebase fully functional without Papr.

## Configuration

### Environment Variable

```bash
# .env.local or build environment
REQUIRE_PAPR_AUTH=true   # Commercial build (requires Papr login)
REQUIRE_PAPR_AUTH=false  # Open source build (Papr login optional)
```

**Default:** `false` (open source mode)

### Build Commands

```bash
# Open source build (default)
npm run build

# Commercial build (requires auth)
REQUIRE_PAPR_AUTH=true npm run build

# Package commercial version
REQUIRE_PAPR_AUTH=true npm run package
```

## User Experience

### Open Source Mode (`REQUIRE_PAPR_AUTH=false`)

1. ✅ App loads immediately
2. ✅ "Getting Started" tab shows with optional Papr login
3. ✅ Users can skip Papr login and use local-only mode
4. ✅ All features accessible (except cloud sync/memory)

### Commercial Mode (`REQUIRE_PAPR_AUTH=true`)

1. 🔒 App shows authentication wall on first launch
2. 🔒 User **must** login with Papr before accessing any features
3. ✅ After authentication, full app access
4. ✅ Authentication persists (stored in system keychain)

## Authentication Wall UI

**When `REQUIRE_PAPR_AUTH=true`:**

```
┌─────────────────────────────────────────┐
│                                         │
│           [Papr Logo]                   │
│                                         │
│      Welcome to Paprwork                │
│                                         │
│  Sign in with your Papr account        │
│      to get started                     │
│                                         │
│    ┌───────────────────────┐           │
│    │  Sign In with Papr    │           │
│    └───────────────────────┘           │
│                                         │
│  Don't have an account?                │
│  Sign up at dashboard.papr.ai          │
│                                         │
└─────────────────────────────────────────┘
```

**Features:**
- Beautiful gradient background
- Frosted glass effect
- Animated loading spinner during authentication
- Real-time polling (checks login status every 2s)
- Error handling with clear messages
- Link to sign up page

## Implementation Details

### Components

1. **AuthWall** (`ui/components/Auth/AuthWall.tsx`)
   - Full-screen authentication gate
   - Checks for existing authentication on mount
   - Polls for login completion after user clicks "Sign In"
   - Calls `onAuthenticated()` callback when complete

2. **App.tsx** (modified)
   - Reads `VITE_REQUIRE_PAPR_AUTH` environment variable
   - Shows `AuthWall` if authentication required and user not authenticated
   - Bypasses auth check in open source mode

3. **Vite Config** (`ui/vite.config.ts`)
   - Exposes `REQUIRE_PAPR_AUTH` env var to client code
   - Available as `import.meta.env.VITE_REQUIRE_PAPR_AUTH`

### Authentication Flow

**Commercial Mode:**

```
User launches app
  ↓
Check REQUIRE_PAPR_AUTH
  ↓
Auth required? → YES
  ↓
Check existing auth (Keychain)
  ↓
Not authenticated?
  ↓
Show AuthWall
  ↓
User clicks "Sign In"
  ↓
Open browser → dashboard.papr.ai/desktop-login
  ↓
User completes login
  ↓
Deep link: papr://auth/callback?api_key=xxx
  ↓
Poll detects authentication
  ↓
Hide AuthWall, show app ✅
```

### Security

- ✅ API key stored in system keychain (macOS Keychain, Windows Credential Manager)
- ✅ Authentication persists across app restarts
- ✅ No API keys exposed in source code
- ✅ Deep link validation (state parameter CSRF protection)

## Testing

### Test Open Source Mode

```bash
# 1. Ensure REQUIRE_PAPR_AUTH is false (or unset)
npm start

# Expected: App loads immediately, no auth wall
```

### Test Commercial Mode

```bash
# 1. Set environment variable
export REQUIRE_PAPR_AUTH=true

# 2. Clear existing authentication
rm ~/Library/Application\ Support/Paprwork/.keychain  # macOS

# 3. Start app
npm start

# Expected: Auth wall appears, blocks access until login
```

### Test Authentication Persistence

```bash
# 1. Login to commercial build
REQUIRE_PAPR_AUTH=true npm start
# Login with Papr

# 2. Close app

# 3. Restart
REQUIRE_PAPR_AUTH=true npm start

# Expected: No auth wall, app loads directly (authenticated)
```

## Distribution

### GitHub Releases (Downloadable Binaries)

The GitHub Actions workflow automatically sets `REQUIRE_PAPR_AUTH=true` for all release builds:

```yaml
# .github/workflows/release.yml
- name: Build app
  run: npm run build
  env:
    REQUIRE_PAPR_AUTH: true  # ✅ Enforced for downloadable releases
```

**Result:** All binaries published to GitHub Releases (DMG, EXE, AppImage) require Papr authentication.

### Developer Builds (Source Code)

Developers cloning the repo and building locally get open-source mode by default:

```bash
git clone https://github.com/paprwork/paprwork-v2
cd paprwork-v2
npm install
npm start  # REQUIRE_PAPR_AUTH defaults to false
```

**Result:** Developers can run the app without Papr authentication (optional).

### Summary

| Build Type | Auth Required | How Set |
|------------|---------------|---------|
| **GitHub Releases** (downloadable) | ✅ YES | GitHub Actions workflow env var |
| **Local dev build** (source) | ❌ NO | Default value (false) |
| **Custom CI/CD** | Configurable | Set `REQUIRE_PAPR_AUTH` in build env |

## Migration Path

For users who download the commercial version:

1. **First Launch:** Must authenticate with Papr
2. **API Key Provisioned:** Automatically via dashboard deep link
3. **Subsequent Launches:** Authenticated automatically (keychain)
4. **Logout:** Can logout from Settings → removes API key

## Files Changed

**New Files:**
- `ui/components/Auth/AuthWall.tsx` - Authentication wall component
- `ui/components/Auth/AuthWall.css` - Styles
- `docs/AUTH_WALL_IMPLEMENTATION.md` - This file

**Modified Files:**
- `ui/App.tsx` - Added auth check and AuthWall rendering
- `ui/vite.config.ts` - Exposed REQUIRE_PAPR_AUTH environment variable
- `.env.example` - Added REQUIRE_PAPR_AUTH documentation

## Future Enhancements

- [ ] Add "Remember me" checkbox (currently always remembers)
- [ ] Add offline mode detection (show different message if no internet)
- [ ] Add "Forgot password" link
- [ ] Track authentication metrics (login success rate, time to auth)
- [ ] Add onboarding video/tutorial on auth wall

---

**Note:** The open-source codebase remains fully functional without Papr. The authentication requirement is purely a build-time configuration for commercial distributions.
