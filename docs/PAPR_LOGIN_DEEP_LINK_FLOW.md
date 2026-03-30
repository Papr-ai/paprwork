# Papr Login Implementation - Deep Link Flow

**Implementation Date:** 2026-03-28  
**Status:** ✅ Complete

## TL;DR

Paprwork now uses the **existing desktop auth flow** already built into dashboard.papr.ai. No GraphQL, no callback servers, no complex OAuth handling - just clean deep link integration!

## How It Works

### The Flow (Simple!)

1. **User clicks "Login with Papr"** in Paprwork
2. **Paprwork opens**: `https://dashboard.papr.ai/desktop-login?state=<random-32-chars>`
3. **Desktop login page** stores the state in localStorage (`papr_desktop_auth`)
4. **Desktop login page** redirects to `/api/auth/login?returnTo=/get-started`
5. **User logs in** via Auth0 (or auto-continues if already logged in)
6. **Auth0 redirects to** `/get-started` page
7. **Get Started page detects** `papr_desktop_auth` in localStorage (lines 30-72 of get-started/page.tsx)
8. **Dashboard gets** user's existing API key from their profile
9. **Dashboard redirects to**: `papr://auth/callback?api_key=xxx&state=xxx&email=xxx&user_id=xxx`
10. **Paprwork catches** the deep link (OS opens papr:// URLs with Paprwork)
11. **Paprwork validates** state parameter matches what we sent (CSRF protection)
12. **Paprwork stores** API key in macOS Keychain automatically
13. **UI updates** to show "Connected to Papr"

### Why This Is Better

**Original Plan:**
- ❌ Local HTTP server on port 18790
- ❌ Complex OAuth code exchange
- ❌ GraphQL queries to fetch/create API keys
- ❌ Manual token management
- ❌ ~400 lines of code

**Current Implementation:**
- ✅ Uses dashboard's existing desktop auth
- ✅ Simple deep link protocol (`papr://`)
- ✅ Dashboard handles everything
- ✅ ~150 lines of code
- ✅ No ports, no servers, no GraphQL

## Code Structure

### Files Created

1. `ui/components/Settings/PaprLoginSection.tsx` - Login UI (shows login button or connected status)
2. `ui/components/Settings/PaprLoginSection.css` - Styles
3. `src/electron/ipc/paprLogin.ts` - IPC handlers for deep link flow

### Files Modified

1. `src/electron/index.cjs`:
   - Register `papr://` protocol with OS
   - Handle `open-url` events (macOS)
   - Handle command-line URL arguments (Windows/Linux)
   - Call `handlePaprAuthCallback()` when deep link received

2. `src/electron/preload.cjs`:
   - Expose `window.electronAPI.papr.*` methods to renderer

3. `ui/types/electron.d.ts`:
   - Add TypeScript types for Papr API

4. `ui/components/Settings/SettingsView.tsx`:
   - Add PaprLoginSection at top of API Keys tab

5. `ui/components/Onboarding/OnboardingView.tsx`:
   - Add Papr login section before Step 1

## Key Functions

### `handlePaprAuthCallback(url, customKeysStorage)`

Called when OS opens a `papr://` URL:

```typescript
// 1. Parse URL: papr://auth/callback?api_key=xxx&state=xxx&email=xxx
// 2. Validate state matches loginState.pendingState (CSRF)
// 3. Store API key in CustomKeysStorage
// 4. Update loginState
// 5. Notify renderer via 'papr-login-success' event
```

### `window.electronAPI.papr.startLogin()`

Opens dashboard with desktop auth flag:

```typescript
// 1. Generate random state (32 chars)
// 2. Store in loginState.pendingState
// 3. Open: dashboard.papr.ai/desktop-login?state=xxx
```

### `window.electronAPI.papr.checkLoginStatus()`

Checks if PAPR_API_KEY exists in keychain:

```typescript
// 1. List all keys from CustomKeysStorage
// 2. Find PAPR_API_KEY
// 3. Return { isLoggedIn: bool, email: string }
```

## Why No GraphQL?

You asked: **"i don't understand what graphql is used for here why do we need it in login?"**

**Answer:** We don't! 🎉

The original implementation tried to:
1. Exchange OAuth code for session token
2. Fetch user's organization/namespace via REST API
3. **Query GraphQL** to check if API key exists
4. **Create via GraphQL** if no key exists

But the **dashboard already does all this**! When a user logs in, they already have an API key (shown on the Get Started page). The dashboard's desktop auth flow simply sends that existing key via deep link.

So we removed:
- ❌ 200+ lines of GraphQL query/mutation code
- ❌ Token exchange logic
- ❌ User info fetching
- ❌ API key generation

And use:
- ✅ Dashboard's built-in desktop auth (already exists!)
- ✅ Simple deep link protocol
- ✅ ~50 lines of code

## Testing

```bash
# 1. Build and start app
npm run build
npm start

# 2. Go to Settings → API Keys or Getting Started
# 3. Click "Login with Papr"
# 4. Browser opens to dashboard.papr.ai
# 5. Log in with your account
# 6. Watch the redirect happen automatically
# 7. Paprwork should show "Connected to Papr"
```

## Troubleshooting

### "Connecting..." never completes

**Cause:** Dashboard didn't redirect back to `papr://` URL
**Check:**
- Did you use the `/desktop-login` page (not direct Auth0)?
- Did you complete the Auth0 login?
- Check browser console on `/get-started` page for errors
- Check browser console for localStorage item `papr_desktop_auth`

### "Security error: Invalid state parameter"

**Cause:** State mismatch (possible CSRF or login expired)
**Fix:** Click "Login with Papr" again to generate new state

### Deep link doesn't open Paprwork

**Cause:** `papr://` protocol not registered
**Fix:**
- Restart Paprwork (protocol registered on launch)
- Check if another app claimed the protocol

## Dashboard Code Reference

The dashboard's desktop auth code is in:
```
papr-dev-platform/apps/web/app/(protected)/get-started/page.tsx
Lines 30-72: Desktop auth detection and redirect
```

Key logic:
```typescript
const desktopAuthData = localStorage.getItem('papr_desktop_auth');
if (desktopAuthData && userProfile) {
  // Get user's API key
  const apiKey = firstKey.key;
  
  // Build deep link
  const callbackUrl = new URL('papr://auth/callback');
  callbackUrl.searchParams.set('api_key', apiKey);
  callbackUrl.searchParams.set('state', authData.state);
  callbackUrl.searchParams.set('email', userProfile.email);
  
  // Redirect browser to deep link
  window.location.href = callbackUrl.toString();
}
```

## Future Enhancement: Full Automation

If you want to make this even more seamless, you could:

1. **Add to dashboard**: After redirect to `papr://auth/callback`, show a success page with:
   - "✅ API Key Sent to Paprwork"
   - "You can close this window"
   - Auto-close after 2 seconds

2. **Add to Paprwork**: Show notification when API key is received:
   - "✅ Connected to Papr"
   - "API key added successfully"

But the current implementation already works great!
