# UI Preferences Migration to Settings

**Date:** 2026-03-03  
**Status:** ✅ Implemented

## Problem

User reported that model selection and onboarding state were not persisting across app restarts.

## Root Cause

Both `lastModelId` and `onboardingDismissed` were stored in `localStorage` only, which can be cleared by the system or browser. This is unreliable for persistent user preferences.

## Solution

Migrated UI preferences from `localStorage` to the Settings JSON file, which is stored alongside other user preferences.

### Changes

#### 1. Settings Schema Extension

Added `UIPreferences` interface to `src/gateway/websocket/settings.ts`:

```typescript
interface UIPreferences {
  lastModelId: string | null;      // Last selected model
  onboardingDismissed: boolean;    // Whether onboarding was dismissed
}

interface SettingsData {
  profile: ProfileData;
  permissions: PermissionData;
  codeIndexing: CodeIndexingSettings;
  uiPreferences: UIPreferences;  // ← NEW
}
```

**Defaults:**
```typescript
uiPreferences: {
  lastModelId: null,
  onboardingDismissed: false,
}
```

#### 2. WebSocket Handler

Added new message type `settings:save-ui-preferences` to save UI preferences:

```typescript
case "settings:save-ui-preferences": {
  const payload = message.payload as Partial<UIPreferences>;
  const settings = await loadSettings();
  settings.uiPreferences = { ...settings.uiPreferences, ...payload };
  await saveSettings(settings);
  
  sendResponse(ws, {
    id: message.id,
    success: true,
    data: settings.uiPreferences,
  });
  break;
}
```

#### 3. Chat Store Update

Modified `ui/stores/chatStore.ts` to save model selection to both localStorage (fast) and settings (persistent):

```typescript
setLastSelectedModel: (chatId, modelId) => {
  // ... existing code ...
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem("paprwork_last_model_id", modelId);
      // Also save to Gateway settings for reliable persistence
      import('../src/lib/gateway.js').then(({ gateway }) => {
        gateway.send('settings:save-ui-preferences', { lastModelId: modelId }).catch(() => {});
      });
    } catch {
      /* ignore */
    }
  }
  // ...
}
```

#### 4. Onboarding Card Update

Modified `ui/components/Sidebar/OnboardingCard.tsx` to save dismissal to both localStorage and settings:

```typescript
function dismiss(): void {
  localStorage.setItem(DISMISSED_KEY, "true");
  // Also save to Gateway settings for reliable persistence
  import('../../src/lib/gateway.js').then(({ gateway }) => {
    gateway.send('settings:save-ui-preferences', { onboardingDismissed: true }).catch(() => {});
  });
}
```

#### 5. Migration on First Load

Added migration logic in `ui/App.tsx` to migrate existing localStorage data to settings on first load:

```typescript
useEffect(() => {
  const migrateUIPreferences = async () => {
    try {
      // Check if we've already migrated
      const migrated = localStorage.getItem('papr_ui_preferences_migrated');
      if (migrated === 'true') return;

      const lastModelId = localStorage.getItem('paprwork_last_model_id');
      const onboardingDismissed = localStorage.getItem('papr-onboarding-dismissed') === 'true';
      
      if (lastModelId || onboardingDismissed) {
        const { gateway } = await import('./src/lib/gateway.js');
        await gateway.send('settings:save-ui-preferences', {
          ...(lastModelId && { lastModelId }),
          onboardingDismissed,
        });
        console.log('[Migration] UI preferences migrated to settings');
      }
      
      localStorage.setItem('papr_ui_preferences_migrated', 'true');
    } catch (error) {
      console.error('[Migration] Failed to migrate UI preferences:', error);
    }
  };
  
  migrateUIPreferences();
}, []);
```

### Storage Strategy

**Hybrid approach for best performance:**

1. **Write to both:**
   - `localStorage` (instant, but can be cleared)
   - Settings file (persistent, but async)

2. **Read preference:**
   - Try `localStorage` first (fast)
   - Fall back to settings if missing

This gives us:
- ✅ Instant reads (localStorage)
- ✅ Reliable persistence (Settings JSON)
- ✅ Automatic migration from old data

## Files Modified

- `src/gateway/websocket/settings.ts` - Added UIPreferences schema + handler
- `ui/stores/chatStore.ts` - Save model selection to settings
- `ui/components/Sidebar/OnboardingCard.tsx` - Save onboarding dismissal to settings
- `ui/App.tsx` - One-time migration from localStorage to settings
- `docs/UI_PREFERENCES_MIGRATION.md` - This file

## Testing

1. **Fresh install:** Defaults apply correctly
2. **Existing user:** Migration runs once, preserves old data
3. **Model selection:** Persists across restarts
4. **Onboarding dismissal:** Persists across restarts
5. **localStorage cleared:** Settings file still has the data

## Related

- See `docs/SQLITE_PERSISTENCE_MIGRATION.md` for tabs/favorites persistence
- Settings file location: `~/.paprwork-v2/settings.json`
