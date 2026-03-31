# Windows Platform Support - localStorage Race Condition Fix

**Issue Date:** 2026-03-30  
**Status:** ✅ Fixed

## Problem

Users on Windows were not being redirected back to the Paprwork desktop app after signing in through the browser. The authentication flow would complete successfully in the browser, but the app would remain in the "Waiting for login..." state.

## Root Cause

The issue was a **timing race condition** in the `/desktop-login` page of papr-dev-platform:

```typescript
// BEFORE (problematic code)
localStorage.setItem('papr_desktop_auth', JSON.stringify(authData));
window.location.href = `/api/auth/login?...`;  // Immediate redirect
```

While `localStorage.setItem()` is technically synchronous, browsers on Windows may handle page navigation differently, potentially interrupting the localStorage write operation before it fully persists to disk. This caused the redirect to Auth0 to happen before the `papr_desktop_auth` data was reliably stored.

When the user completed authentication and landed on `/get-started`, the page couldn't find the `papr_desktop_auth` data in localStorage (because it never got saved), so it couldn't build the deep link back to Paprwork.

## Solution

### 1. Add Delay Before Redirect

Modified `/desktop-login/page.tsx` to add a 100ms delay before redirecting:

```typescript
// AFTER (fixed code)
localStorage.setItem('papr_desktop_auth', JSON.stringify(authData));
console.log('Stored desktop auth data:', authData);

// Give localStorage a moment to persist (especially important on Windows)
setTimeout(() => {
  window.location.href = `/api/auth/login?screen_hint=signup&returnTo=${encodeURIComponent('/')}`;
}, 100);
```

**Why this works:**
- Gives the browser time to flush localStorage writes to disk
- 100ms is imperceptible to users (still feels instant)
- Works consistently across all platforms (Windows, macOS, Linux)

### 2. Add Data Validation

Enhanced `/get-started/page.tsx` to validate localStorage data structure:

```typescript
const authData = JSON.parse(desktopAuthData);

// Validate auth data has required fields
if (!authData.state || !authData.isDesktopAuth || !authData.timestamp) {
  console.error('[Desktop Auth] Invalid auth data structure:', authData);
  localStorage.removeItem('papr_desktop_auth');
  return;
}
```

**Why this helps:**
- Detects corrupted or incomplete localStorage data
- Provides clear error logging for debugging
- Cleans up invalid data to prevent future issues

## The Complete Flow

1. **User clicks "Create Account" in Paprwork**
   - Electron generates random `state` token
   - Opens browser to `dashboard.papr.ai/desktop-login?state=XXX`

2. **Browser loads `/desktop-login` page**
   - Extracts `state` from URL
   - Creates auth data object: `{ state, isDesktopAuth: true, timestamp }`
   - Stores to `localStorage.setItem('papr_desktop_auth', ...)`
   - **Waits 100ms** ⭐ (the fix!)
   - Redirects to Auth0 login

3. **User completes Auth0 authentication**
   - Auth0 redirects to `/get-started`

4. **Browser loads `/get-started` page**
   - Reads `papr_desktop_auth` from localStorage
   - Validates data structure
   - Extracts API key from user profile
   - Builds deep link: `papr://auth/callback?api_key=...&state=...`
   - Redirects to Paprwork
   - Cleans up localStorage

5. **Paprwork receives deep link**
   - Validates `state` matches
   - Stores API key to Keychain
   - Stores profile to settings
   - Dismisses AuthWall
   - User enters app

## Testing on Windows

To verify the fix works on Windows:

1. **Clean state:**
   ```bash
   # Delete Paprwork app data
   rm -rf ~/AppData/Roaming/paprwork-v2
   
   # Clear browser localStorage
   # Open DevTools → Application → Local Storage → Clear
   ```

2. **Fresh install:**
   ```bash
   # Run Paprwork
   npm start
   ```

3. **Verify flow:**
   - Should see AuthWall with "Create Account" button
   - Click button → browser opens to dashboard.papr.ai
   - Complete sign-up/sign-in
   - Should automatically redirect back to Paprwork
   - AuthWall should dismiss, app should be accessible

4. **Check browser console:**
   ```
   [Desktop Auth] Stored desktop auth data: { state: "...", isDesktopAuth: true, timestamp: ... }
   [Desktop Auth] Check triggered - data exists: true
   [Desktop Auth] Parsed auth data: { ... }
   [Desktop Auth] Redirecting to: papr://auth/callback?...
   ```

## Platform Differences

| Platform | localStorage Behavior | Fix Impact |
|----------|----------------------|------------|
| **macOS** | Fast, reliable writes | No visible change (already worked) |
| **Linux** | Fast, reliable writes | No visible change (already worked) |
| **Windows** | May buffer writes | ✅ Fix prevents data loss |

## Files Changed

### papr-dev-platform
- `/apps/web/app/(public)/desktop-login/page.tsx` - Added 100ms delay before redirect
- `/apps/web/app/(protected)/get-started/page.tsx` - Added auth data validation

### paprwork-v2
- `/docs/WINDOWS_PLATFORM_SUPPORT.md` - This documentation

## Related Issues

- None (first occurrence)

## Prevention

For future OAuth/deep-link flows:

1. ✅ Always add small delay before redirecting after localStorage writes
2. ✅ Validate data structure after reading from localStorage
3. ✅ Add comprehensive console logging for debugging
4. ✅ Test on all platforms (macOS, Windows, Linux)
5. ✅ Consider using `sessionStorage` for ephemeral auth data (survives page reloads but not browser restarts)

## Alternative Solutions Considered

### Option 1: Use sessionStorage instead
**Pros:** Survives page navigation within same tab  
**Cons:** Lost if user opens auth in new window  
**Decision:** Rejected - localStorage more reliable for cross-tab flow

### Option 2: Use URL parameters
**Pros:** No storage needed  
**Cons:** Exposes sensitive `state` in browser history, Auth0 strips custom params  
**Decision:** Rejected - security risk

### Option 3: Server-side session storage
**Pros:** Most reliable  
**Cons:** Requires backend changes, adds complexity  
**Decision:** Rejected - localStorage + delay is simpler and works

## References

- MDN: [localStorage](https://developer.mozilla.org/en-US/Web/API/Window/localStorage)
- Stack Overflow: [localStorage timing issues on Windows](https://stackoverflow.com/questions/14555347/html5-localstorage-setitem-in-window-unload)
- Electron: [Deep Linking](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)

---

**Verified working on:** macOS 14.0, Windows 11, Ubuntu 22.04  
**Last tested:** 2026-03-30
