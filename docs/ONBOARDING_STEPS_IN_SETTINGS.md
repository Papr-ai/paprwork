# Onboarding Steps Moved to Settings

**Date:** 2026-03-07  
**Status:** ✅ Implemented

## Problem

Onboarding step completion state (step1, step2, step3) was only stored in localStorage, which gets cleared by the system. This meant:
- ❌ Steps would reset to incomplete after app restart
- ❌ Only the dismissal state persisted (in settings)
- ❌ Inconsistent persistence strategy

## Solution

Moved ALL onboarding state to settings.json for reliable long-term persistence.

### Changes

#### 1. Settings Schema Extension

Added onboarding step fields to `UIPreferences`:

```typescript
interface UIPreferences {
  lastModelId: string | null;
  onboardingDismissed: boolean;
  onboardingStep1Completed: boolean;  // ← NEW
  onboardingStep2Completed: boolean;  // ← NEW
  onboardingStep3Completed: boolean;  // ← NEW
}
```

**Defaults:**
```typescript
uiPreferences: {
  lastModelId: null,
  onboardingDismissed: false,
  onboardingStep1Completed: false,
  onboardingStep2Completed: false,
  onboardingStep3Completed: false,
}
```

#### 2. App.tsx - Load Steps on Startup

Modified the preferences loader to populate localStorage with step states:

```typescript
const { 
  lastModelId, 
  onboardingDismissed,
  onboardingStep1Completed,
  onboardingStep2Completed,
  onboardingStep3Completed
} = response.data.uiPreferences;

// Populate localStorage for fast access
if (onboardingStep1Completed) {
  localStorage.setItem("papr-onboarding-step1", "true");
}
// ... same for step2 and step3
```

#### 3. OnboardingCard - Read from localStorage, Save to Settings

Simplified component to use localStorage (pre-populated by App.tsx):

```typescript
// Load from localStorage (pre-populated by App.tsx)
useEffect(() => {
  const step1 = localStorage.getItem("papr-onboarding-step1") === "true";
  const step2 = localStorage.getItem("papr-onboarding-step2") === "true";
  const step3 = localStorage.getItem("papr-onboarding-step3") === "true";
  
  setState({
    step1Completed: step1,
    step2Completed: step2,
    step3Completed: step3,
  });
}, []);

// Save to both localStorage (fast) and settings (persistent)
useEffect(() => {
  localStorage.setItem("papr-onboarding-step1", state.step1Completed.toString());
  localStorage.setItem("papr-onboarding-step2", state.step2Completed.toString());
  localStorage.setItem("papr-onboarding-step3", state.step3Completed.toString());
  
  gateway.send('settings:save-ui-preferences', {
    onboardingStep1Completed: state.step1Completed,
    onboardingStep2Completed: state.step2Completed,
    onboardingStep3Completed: state.step3Completed,
  }).catch(() => {});
}, [state]);
```

## Data Flow

### On App Startup
```
App.tsx loads
  ↓
Fetch settings from Gateway
  ↓
Extract onboardingStep1/2/3Completed
  ↓
Populate localStorage with step states
  ↓
OnboardingCard mounts
  ↓
Read from localStorage (instant)
  ✓ Steps show correct completion state
```

### When User Completes a Step
```
User clicks step button
  ↓
setState({ step1Completed: true })
  ↓
useEffect triggers
  ↓
Write to localStorage (instant UI update)
  ↓
Send to settings (persistent storage)
```

### On Next App Launch
```
App.tsx loads settings
  ↓
Sees onboardingStep1Completed: true
  ↓
Sets localStorage
  ↓
OnboardingCard reads from localStorage
  ✓ Step 1 still shows as completed
```

## Storage Strategy

**Hybrid approach for best performance:**

1. **Settings (source of truth):**
   - Persistent across app restarts
   - Survives localStorage clearing
   - Loaded once on app startup

2. **localStorage (performance):**
   - Fast reads for UI
   - Pre-populated from settings
   - Updated immediately on changes

3. **Write to both:**
   - localStorage for instant UI update
   - Settings for long-term persistence

## Files Modified

- `src/gateway/websocket/settings.ts`
  - Added `onboardingStep1/2/3Completed` to `UIPreferences`
  - Updated defaults

- `ui/App.tsx`
  - Load step states from settings
  - Populate localStorage on startup

- `ui/components/Sidebar/OnboardingCard.tsx`
  - Removed old localStorage-only logic
  - Read from localStorage (pre-populated)
  - Save to both localStorage + settings

## Benefits

✅ **Long-term persistence** - Steps persist across app restarts
✅ **Survives clearing** - Even if localStorage is cleared, settings restore it
✅ **Fast UI** - localStorage reads are instant
✅ **Single source of truth** - Settings is the authoritative source
✅ **Consistent strategy** - Same pattern as model selection

## Testing

1. ✅ Complete step 1 → close app → reopen → **step 1 still completed**
2. ✅ Complete all steps → auto-dismiss → close app → reopen → **stays dismissed**
3. ✅ Clear localStorage → reopen app → **settings restore localStorage**
4. ✅ Fresh install → defaults work correctly

## Related

- `docs/SETTINGS_PRELOAD_FIX.md` - Settings preload architecture
- `docs/UI_PREFERENCES_MIGRATION.md` - Settings schema design
- `docs/PERSISTENCE_FIXES.md` - Favorites/tabs persistence
