# Persistence Fixes - Favorites, Model, Onboarding

**Date:** 2026-03-03  
**Status:** ✅ Fixed

## Issues

1. **Favorites not showing:** Depending on where favorite was added from, it wouldn't appear consistently
2. **Model selection not persisting:** Last selected model not persisting across app restarts
3. **Onboarding not persisting:** Getting started steps not persisting across app restarts

## Root Causes

### 1. Favorites: Dual State Problem

`FavoritesList` was loading favorites from a separate `app:get_favorites` endpoint AND listening to custom events, creating inconsistent state. It should have been deriving favorites directly from the tabs store.

### 2. Model/Onboarding: Missing Load from Settings

While we added code to **save** model selection and onboarding state to settings, we never added code to **load** them back on app startup. They were only reading from localStorage.

## Solutions

### 1. Favorites: Derive from Tabs State

Changed `FavoritesList` to derive favorites directly from `useTabStore.tabs` where `isFavorite` is true:

```typescript
// BEFORE: Separate state + async loading
const [favorites, setFavorites] = useState<Favorite[]>([]);
useEffect(() => {
  gateway.send('app:get_favorites', {}).then(...)
}, []);

// AFTER: Derive from tabs state
const { tabs } = useTabStore();
const favorites: Favorite[] = tabs
  .filter(tab => tab.isFavorite)
  .map(tab => ({ id: tab.id, type: tab.type, title: tab.title }));
```

**Benefits:**
- ✅ Single source of truth
- ✅ Automatically stays in sync
- ✅ No race conditions
- ✅ Simpler code (removed 40+ lines of event listeners and sync logic)

### 2. Model Selection: Load from Settings on Startup

Added `loadUIPreferences()` method to `chatStore` and called it from `App.tsx`:

```typescript
// In chatStore.ts
loadUIPreferences: async () => {
  const response = await gateway.send('settings:get', {});
  if (response.success && response.data?.uiPreferences) {
    const { lastModelId } = response.data.uiPreferences;
    if (lastModelId) {
      // Store in localStorage for fast access
      localStorage.setItem("paprwork_last_model_id", lastModelId);
    }
  }
}

// In App.tsx
useEffect(() => {
  const migrateUIPreferences = async () => {
    const migrated = localStorage.getItem('papr_ui_preferences_migrated');
    if (migrated === 'true') {
      // Already migrated, just load from settings
      await useChatStore.getState().loadUIPreferences();
      return;
    }
    // ... migration code ...
  };
  migrateUIPreferences();
}, []);
```

### 3. Onboarding: Load from Settings on Mount

Added `loadDismissedFromSettings()` helper and called it in the component mount effect:

```typescript
async function loadDismissedFromSettings(): Promise<boolean> {
  const response = await gateway.send('settings:get', {});
  if (response.success && response.data?.uiPreferences) {
    const { onboardingDismissed } = response.data.uiPreferences;
    if (onboardingDismissed) {
      // Store in localStorage for fast access
      localStorage.setItem(DISMISSED_KEY, "true");
      return true;
    }
  }
  return false;
}

// In component
useEffect(() => {
  const checkDismissed = async () => {
    // Check localStorage first (fast)
    if (isDismissed()) {
      setHidden(true);
      return;
    }
    
    // Check settings (persistent)
    const dismissedInSettings = await loadDismissedFromSettings();
    if (dismissedInSettings) {
      setHidden(true);
    } else {
      setHidden(false);
    }
  };
  
  checkDismissed();
}, []);
```

## Data Flow

### Favorites
```
User toggles favorite
  ↓
Update tab.isFavorite in Zustand
  ↓
Send to SQLite (app:toggle_favorite_tab)
  ↓
FavoritesList auto-updates (derives from tabs)
```

### Model Selection
```
App Mount
  ↓
Load from settings (settings:get)
  ↓
Populate localStorage (fast access)
  ↓
UI reads from localStorage
  ↓
On change: Write to both localStorage + settings
```

### Onboarding
```
App Mount
  ↓
Check localStorage (instant)
  ↓
If not found, load from settings
  ↓
Populate localStorage (fast access)
  ↓
On dismiss: Write to both localStorage + settings
```

## Files Modified

### Favorites
- `ui/components/Sidebar/FavoritesList.tsx`
  - Removed separate state and async loading
  - Derive favorites from `useTabStore.tabs`
  - Removed event listeners and sync logic

### Model Selection
- `ui/stores/chatStore.ts`
  - Added `loadUIPreferences()` method
- `ui/App.tsx`
  - Call `loadUIPreferences()` after migration

### Onboarding
- `ui/components/Sidebar/OnboardingCard.tsx`
  - Added `loadDismissedFromSettings()` helper
  - Check both localStorage and settings on mount

## Testing

1. ✅ **Favorites:** Add favorite → restart app → still shows
2. ✅ **Model Selection:** Select model → restart app → still selected
3. ✅ **Onboarding:** Dismiss card → restart app → stays dismissed
4. ✅ **Fresh Install:** All defaults work correctly
5. ✅ **Migration:** Old localStorage data migrates to settings

## Performance

- **Favorites:** Now instant (derived, no async loading)
- **Model:** localStorage read (instant) + settings fallback
- **Onboarding:** localStorage read (instant) + settings fallback

## Related

- `docs/SQLITE_PERSISTENCE_MIGRATION.md` - Tabs/history persistence
- `docs/UI_PREFERENCES_MIGRATION.md` - Settings schema design
