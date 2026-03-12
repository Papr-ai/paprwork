# Onboarding Progress Persistence Fix

**Date:** 2026-03-12  
**Issue:** Getting started progress not persisting across app restarts (always showing 0%)  
**Status:** ✅ FIXED

---

## Problem Description

Users completing onboarding steps (Configure API Keys, Setup Agents, Complete First Task) would see their progress reset to 0% when closing and reopening the app, even though the data was being saved to SQLite.

---

## Root Cause Analysis

The issue was in the promise chain in `useAppStatePersistence.ts`:

```typescript
// OLD CODE (BROKEN)
gateway.send('app:load_tabs', {}).then((response) => {
  if (response.success && response.data && response.data.length > 0) {
    // Load tabs...
    
    // Load app state after tabs
    return gateway.send('app:load_state', {});
  } else {
    // NO TABS → Reject promise and never load app state!
    return Promise.reject(new Error('No tabs'));
  }
}).then((response) => {
  // This block never executed when no tabs existed!
  if (response.success && response.data) {
    // Write onboarding state to localStorage...
  }
})
```

**The Problem:**
1. When no tabs existed in the database, the promise was rejected
2. The `.then()` block that loads app state never executed
3. Onboarding progress was never written to localStorage
4. OnboardingCard would read empty/default values

**Why This Happened:**
- New users start with zero tabs
- Users who cleared their tabs would have zero tabs
- In both cases, app state (including onboarding) would never load

---

## The Fix

Changed the logic to **always** load app state, regardless of whether tabs exist:

```typescript
// NEW CODE (FIXED)
gateway.send('app:load_tabs', {}).then((response) => {
  if (response.success && response.data && response.data.length > 0) {
    // Load tabs...
  } else {
    console.log('No tabs found, starting fresh');
  }
  
  // ALWAYS load app state (even if no tabs)
  return gateway.send('app:load_state', {});
}).then((response) => {
  if (response.success && response.data) {
    // Write onboarding state to localStorage
    localStorage.setItem('papr-onboarding-step1', state.onboardingStep1Completed ? 'true' : 'false');
    // ... other state ...
  } else {
    console.log('No app state found, using defaults');
  }
  
  // ALWAYS notify that SQLite load is complete
  (window as any).__paprSqliteLoaded = true;
  window.dispatchEvent(new CustomEvent('papr-sqlite-loaded'));
})
```

**Key Changes:**
1. ✅ Removed `Promise.reject()` when no tabs exist
2. ✅ Always call `gateway.send('app:load_state', {})` 
3. ✅ Always dispatch `papr-sqlite-loaded` event (even when no data)
4. ✅ Handle missing data gracefully with default values

---

## Files Changed

### `ui/hooks/useAppStatePersistence.ts`

**Lines 24-119** - Fixed promise chain to always load app state

**Before:**
```typescript
} else {
  // Mark as loaded even if no data
  (window as any).__paprSqliteLoaded = true;
  window.dispatchEvent(new CustomEvent('papr-sqlite-loaded'));
  return Promise.reject(new Error('No tabs')); // ❌ This broke the chain!
}
```

**After:**
```typescript
} else {
  console.log('[Persistence] No tabs found in SQLite, starting fresh');
}

// ALWAYS load app state (even if no tabs)
return gateway.send('app:load_state', {});
```

---

## Testing

### Manual Test Steps

1. **Setup:** Complete step 1 of onboarding (Configure API Keys)
2. **Verify:** SQLite database should have `onboardingStep1Completed = true`
3. **Close:** Quit the app completely
4. **Reopen:** Launch the app again
5. **Expected:** Onboarding card should show 33% progress (1/3 steps complete)

### Database Verification

Check SQLite database directly:
```bash
sqlite3 ~/.paprwork-v2/app-state.db "SELECT key, value FROM app_state WHERE key LIKE 'onboarding%' ORDER BY key"
```

Expected output:
```
onboardingDismissed|false
onboardingStep1Completed|true
onboardingStep2Completed|false
onboardingStep3Completed|false
```

### Console Log Verification

When app starts, console should show:
```
[Persistence] Loading tabs from SQLite...
[Persistence] No tabs found in SQLite, starting fresh (or loaded N tabs)
[Persistence] Loaded app state: { onboardingStep1Completed: true, ... }
[Persistence] Onboarding state loaded: { step1: true, step2: false, step3: false, dismissed: false }
[OnboardingCard] localStorage values: { step1: true, step2: false, step3: false }
```

---

## Data Flow

### Correct Flow (After Fix)

```
App Start
  ↓
Load Tabs from SQLite
  ├─ Tabs exist? Restore them
  └─ No tabs? Continue
  ↓
ALWAYS Load App State from SQLite
  ↓
Parse onboarding state
  ↓
Write to localStorage
  ↓
Dispatch 'papr-sqlite-loaded' event
  ↓
App renders (waits for event)
  ↓
OnboardingCard mounts
  ↓
Read from localStorage
  ↓
Display correct progress ✅
```

### Previous Flow (Broken)

```
App Start
  ↓
Load Tabs from SQLite
  ├─ Tabs exist? Load app state ✅
  └─ No tabs? Promise.reject() ❌
       ↓
     App state never loaded
       ↓
     localStorage empty
       ↓
     OnboardingCard shows 0% ❌
```

---

## Prevention

To prevent similar issues in the future:

1. **Never use `Promise.reject()` to skip loading critical state** - Use conditional logic inside the promise chain instead
2. **Always dispatch completion events** - Don't gate completion events behind data checks
3. **Test with empty state** - Always test persistence with zero data to ensure defaults work
4. **Add fallback values** - Handle missing data gracefully with sensible defaults

---

## Related Files

- `ui/hooks/useAppStatePersistence.ts` - Main persistence hook
- `ui/components/Sidebar/OnboardingCard.tsx` - Reads onboarding state from localStorage
- `src/gateway/services/storage/AppStateStorage.ts` - SQLite storage implementation
- `src/gateway/websocket/app.ts` - WebSocket handlers for app state

---

## Impact

**Before Fix:**
- Onboarding progress never persisted for new users (no tabs = no state load)
- Users had to redo onboarding steps every time they opened the app
- Poor user experience

**After Fix:**
- Onboarding progress persists correctly across app restarts
- Works for users with zero tabs (new users)
- Works for users with existing tabs
- Consistent experience ✅
