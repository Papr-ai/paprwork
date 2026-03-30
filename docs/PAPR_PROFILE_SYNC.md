# Papr Profile Sync

**Added:** 2026-03-28

After users authenticate with Papr, we automatically fetch their profile information from the dashboard and store it in Paprwork settings. This provides a seamless experience where users' profile data is synced from their Papr account.

---

## Overview

When a user authenticates with Papr (via the deep link OAuth flow), we:

1. Store the API key in CustomKeysStorage (keychain)
2. **Fetch full profile from dashboard** (`/api/user-info`)
3. **Store profile in settings** (`paprProfile`)
4. **Auto-populate manual profile fields** with Papr data

---

## User Flow

### First-Time Authentication

1. User clicks "Create Account" in AuthWall or Papr Login button in settings
2. Dashboard redirects to Auth0 for sign-up
3. User completes Auth0 onboarding (name, image, email)
4. Dashboard redirects back to Paprwork via deep link: `papr://auth/callback?api_key=xxx&email=xxx&user_id=xxx`
5. **Paprwork fetches full profile** from `https://dashboard.papr.ai/api/user-info`
6. Profile stored in settings (`~/.paprwork-v2/config.json`)
7. **Manual profile fields auto-populated** in Settings → Profile tab

### Profile Display

- **Settings → Profile tab** shows two sections:
  1. **"Papr Account"** - Read-only display of synced profile (name, email, image, connected date)
  2. **"Your Profile"** - Editable fields (pre-filled from Papr profile)

### Logout

- User clicks "Logout" in Papr Login section
- Deletes ALL `PAPR_API_KEY` entries from keychain
- **Clears Papr profile from settings**
- Manual profile fields remain unchanged

---

## API Integration

### Dashboard Endpoint: Deep Link URL Parameters

**No API call needed!** Profile data is passed directly in the deep link URL from the dashboard.

**Deep Link Format:**
```
papr://auth/callback?api_key=xxx&state=xxx&email=xxx&user_id=xxx&display_name=xxx&profile_image=xxx
```

**Parameters:**
- `api_key` - User's Papr API key
- `state` - CSRF protection token
- `email` - User's email address
- `user_id` - Papr user ID
- `display_name` - User's full name (from Auth0)
- `profile_image` - Profile photo URL (from Auth0/Google/etc.)

**Why URL params instead of API call?**
- ✅ **Simpler** - No additional network request
- ✅ **Faster** - Immediate profile availability
- ✅ **More reliable** - No auth token complexity (API key alone can't access session-protected endpoints)
- ✅ **Secure** - Data comes from authenticated dashboard session, passed via HTTPS → deep link

---

## Implementation Details

### 1. Type Definitions

**File:** `src/core/types/storage.ts`

Added `paprProfile` to `AppSettings`:

```typescript
export interface AppSettings {
  // ... existing fields ...
  
  /** Papr user profile (fetched from dashboard after authentication) */
  paprProfile?: {
    userId: string;
    email: string;
    displayName?: string;
    profileImage?: string;
    authenticatedAt: string;
  };
}
```

### 2. SettingsStorage Methods

**File:** `src/core/storage/SettingsStorage.ts`

Added three public methods:

```typescript
setPaprProfile(profile: { ... }): void
getPaprProfile(): AppSettings["paprProfile"] | undefined
clearPaprProfile(): void
```

### 3. Profile Fetching Logic

**File:** `src/electron/ipc/paprLogin.ts`

Enhanced `handlePaprAuthCallback()` to extract profile from URL params:

```typescript
// Extract parameters
const displayName = parsedUrl.searchParams.get("display_name");
const profileImage = parsedUrl.searchParams.get("profile_image");

// Store profile in settings (no API call needed)
settingsStorage.setPaprProfile({
  userId: userId || "",
  email: email || "",
  displayName: displayName || undefined,
  profileImage: profileImage || undefined,
  authenticatedAt: new Date().toISOString(),
});
```

**Why URL params?**
- Dashboard already has profile data from Auth0 session
- Passing via deep link avoids auth complexity
- Faster (no additional network request)
- More reliable (no session cookie issues)

### 4. IPC Handler

**File:** `src/electron/ipc/paprLogin.ts`

Added `papr:get-profile` handler:

```typescript
ipcMain.handle("papr:get-profile", async () => {
  const profile = settingsStorage.getPaprProfile();
  return { success: true, profile };
});
```

### 5. Preload API

**File:** `src/electron/preload.cjs`

Added to `papr` namespace:

```javascript
papr: {
  // ... existing methods ...
  getProfile: () => ipcRenderer.invoke("papr:get-profile"),
}
```

### 6. TypeScript Definitions

**File:** `ui/types/electron.d.ts`

Added to `papr` interface:

```typescript
papr: {
  // ... existing methods ...
  getProfile: () => Promise<{
    success: boolean;
    profile?: {
      userId: string;
      email: string;
      displayName?: string;
      profileImage?: string;
      authenticatedAt: string;
    };
    error?: string;
  }>;
}
```

### 7. UI Display

**File:** `ui/components/Settings/SettingsView.tsx`

Enhanced `ProfileTab` component:

1. **Fetch Papr profile on mount:**
   ```typescript
   const paprResponse = await window.electronAPI.papr.getProfile();
   if (paprResponse.success && paprResponse.profile) {
     setPaprProfile(paprResponse.profile);
   }
   ```

2. **Auto-populate manual fields:**
   ```typescript
   // Pre-fill manual profile fields if empty
   setName(data.profile.name ?? paprResponse.profile.displayName ?? "");
   setEmail(data.profile.email ?? paprResponse.profile.email ?? "");
   setImageUrl(data.profile.imageUrl ?? paprResponse.profile.profileImage ?? "");
   ```

3. **Display Papr profile section:**
   ```tsx
   {paprProfile && (
     <div className="settings-section">
       <h2>Papr Account</h2>
       {/* Shows profile image, name, email, connected date */}
     </div>
   )}
   ```

4. **Listen for auth events:**
   ```typescript
   window.addEventListener('papr-auth-success', handleAuthSuccess);
   ```

---

## User Experience

### Before Authentication

**Settings → Profile:**
```
┌─────────────────────────────────┐
│ Your Profile                    │
│ --------------------------------│
│ [Empty Photo]                   │
│ Name: _____                     │
│ Email: _____                    │
│ [Save Profile]                  │
└─────────────────────────────────┘
```

### After Authentication

**Settings → Profile:**
```
┌─────────────────────────────────┐
│ Papr Account                    │
│ Profile synced from your account│
│ --------------------------------│
│ [Profile Photo] John Doe        │
│                 john@example.com│
│                 Connected Mar 28│
│                                 │
│ Your Profile                    │
│ --------------------------------│
│ [Profile Photo]                 │
│ Name: John Doe ← auto-populated │
│ Email: john@example.com ←       │
│ [Save Profile]                  │
└─────────────────────────────────┘
```

### Benefits

1. ✅ **Zero manual entry** - Profile data synced automatically
2. ✅ **Single source of truth** - Papr account is authoritative
3. ✅ **Seamless onboarding** - Users see their info immediately
4. ✅ **Editable** - Users can override with custom values if needed
5. ✅ **Privacy** - Profile stored locally in encrypted settings

---

## Security

### Data Flow

1. **Dashboard → Electron (Deep Link):**
   - API key, email, user_id passed via `papr://` URL
   - Protected by CSRF state parameter

2. **Electron → Dashboard (Profile Fetch):**
   - HTTPS request to `/api/user-info`
   - Authenticated with `X-API-Key` header
   - Profile data fetched from Auth0 session

3. **Storage:**
   - API key in macOS Keychain (secure)
   - Profile in electron-store (encrypted with AES-256-GCM)
   - Never sent to third parties

### What We Store

- `userId` - Papr user ID (for future API integrations)
- `email` - User's email
- `displayName` - User's full name
- `profileImage` - Profile photo URL (hosted by Auth0/Google)
- `authenticatedAt` - ISO timestamp of authentication

### What We Don't Store

- ❌ Session tokens (not needed - API key is sufficient)
- ❌ Auth0 credentials
- ❌ Sensitive user data

---

## Testing

### Test Profile Sync

1. **Fresh authentication:**
   ```bash
   # Remove existing API key
   # Open Paprwork → Settings → API Keys → Logout
   
   # Authenticate
   # Click "Create Account" in AuthWall
   # Complete Auth0 sign-up
   # Allow deep link redirect
   
   # Verify in Settings → Profile:
   # - "Papr Account" section appears
   # - Profile image, name, email displayed
   # - Manual fields auto-populated
   ```

2. **Check stored data:**
   ```bash
   # Settings stored in:
   cat ~/.paprwork-v2/config.json | jq .paprProfile
   ```

3. **Test logout:**
   ```bash
   # Settings → API Keys → Logout
   # Verify:
   # - "Papr Account" section disappears
   # - Manual profile fields remain unchanged
   ```

### Test Auto-Population

1. **New user flow:**
   - Fresh install
   - Authenticate with Papr
   - Go to Settings → Profile
   - **Expected:** Name, email, image pre-filled from Papr

2. **Existing user flow:**
   - Already has manual profile
   - Authenticate with Papr
   - Go to Settings → Profile
   - **Expected:** 
     - "Papr Account" section appears
     - Manual profile unchanged (no overwrite)

---

## Error Handling

### Profile Fetch Fails

If `/api/user-info` request fails:
- ✅ API key still stored (authentication succeeds)
- ✅ Basic data from deep link used (email, user_id)
- ⚠️ Warning logged to console
- ℹ️ User can manually enter profile info

### No Profile Image

If user hasn't uploaded a profile photo on dashboard:
- Default avatar icon displayed in "Papr Account" section
- Manual profile photo upload still available

---

## Future Enhancements

1. **Profile Sync Button** - Manual refresh of Papr profile
2. **Two-Way Sync** - Upload local profile changes to dashboard
3. **Workspace Integration** - Show Papr workspace members
4. **Usage Stats** - Display API usage from dashboard

---

## Files Changed

### Core Types
- `src/core/types/storage.ts` - Added `paprProfile` to `AppSettings`

### Storage Layer
- `src/core/storage/SettingsStorage.ts` - Added profile methods

### Electron Main Process
- `src/electron/ipc/paprLogin.ts` - Extract profile from URL params (no API call)
- `src/electron/index.cjs` - Pass `settingsStorage` to handlers

### Electron Preload
- `src/electron/preload.cjs` - Added `getProfile()` to papr namespace

### Dashboard (papr-dev-platform)
- `apps/web/app/(protected)/get-started/page.tsx` - Pass profile in deep link URL, auto-redirect (no modal)

### UI
- `ui/types/electron.d.ts` - Type definitions for profile API
- `ui/components/Settings/SettingsView.tsx` - Profile display + auto-populate

---

## Related Documentation

- [PAPR_LOGIN_INTEGRATION.md](./PAPR_LOGIN_INTEGRATION.md) - Deep link OAuth flow
- [AUTH_WALL_IMPLEMENTATION.md](./AUTH_WALL_IMPLEMENTATION.md) - Authentication wall for commercial builds
- [PAPR_LOGIN_DEEP_LINK_FLOW.md](./PAPR_LOGIN_DEEP_LINK_FLOW.md) - Technical deep link flow diagram

---

**This enhancement makes Paprwork feel like a native Papr experience - users' identity is seamlessly synced from their account.**
