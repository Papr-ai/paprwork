# Default Home App - Final Configuration Summary

## Changes Made (2026-03-31)

### 1. All Users Get Weekly War Room as Home ✅

**Updated:** `src/core/storage/SettingsStorage.ts`

Added your Weekly War Room app to the default settings that ship with every new installation:

```typescript
const DEFAULT_SETTINGS: AppSettings = {
  providers: {},
  preferences: {
    theme: "system",
    language: "en",
    autoSave: true,
    keyboardShortcuts: true,
    telemetryEnabled: false,
    defaultHomeAppId: "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c", // Weekly War Room
  },
  // ...
};
```

**Impact:**
- ✅ Every new user gets Weekly War Room as their home page
- ✅ Existing users keep their current settings (no overwrite)
- ✅ Fresh installations automatically configured

### 2. Tab Title Shows "Home" ✅

**Updated:** 
- `ui/components/Tabs/TabBar.tsx` - Home button uses "Home" as title
- `ui/components/Layout/ContentArea.tsx` - Redirect component uses "Home" as title

Changed from:
```typescript
createTab("app", defaultHomeAppId, app.title); // "Weekly War Room"
```

To:
```typescript
createTab("app", defaultHomeAppId, "Home"); // Always "Home"
```

**Impact:**
- ✅ Tab always shows "Home" (not "Weekly War Room")
- ✅ Consistent branding across all users
- ✅ Users don't need to know the underlying app name

## User Experience

### What Users See

1. **Fresh Installation:**
   - Launch Paprwork
   - Click home button 🏠
   - Tab opens labeled "Home"
   - Content shows Weekly War Room dashboard

2. **Existing Users:**
   - Already have settings.json
   - Need to manually set (or delete settings to get defaults)
   - Or we can run migration script

3. **Tab Appearance:**
   ```
   [Home] [Chat 1] [Chat 2] ...
   ```
   Not:
   ```
   [Weekly War Room] [Chat 1] [Chat 2] ...
   ```

## Rollout Strategy

### Option A: Fresh Installs Only (Current)

✅ **Pros:**
- No existing user disruption
- Safe default for new users
- Users can still override

❌ **Cons:**
- Existing users don't get the improvement
- Manual configuration needed for current users

### Option B: Update All Users

Add migration in App.tsx on startup:

```typescript
// Check if user has no defaultHomeAppId set
const settings = await gateway.send('settings:get');
if (!settings.data.preferences.defaultHomeAppId) {
  // Set the default
  await gateway.send('settings:update', {
    preferences: {
      ...settings.data.preferences,
      defaultHomeAppId: 'bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c'
    }
  });
}
```

**Recommendation:** Use Option A (current approach) - less invasive, respects user choice

## Verification

### For Fresh Installations

1. Delete existing settings:
   ```bash
   rm $PAPR_HOME/data/settings.json
   ```

2. Restart Paprwork

3. Settings regenerated with default home app:
   ```bash
   cat $PAPR_HOME/data/settings.json | jq '.preferences.defaultHomeAppId'
   # Output: "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"
   ```

4. Click home button → "Home" tab opens → Weekly War Room shows

### For Existing Users

Your settings.json already has the configuration from the script we ran earlier:

```bash
cat $PAPR_HOME/data/settings.json | jq '.preferences.defaultHomeAppId'
# Output: "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"
```

## Distribution Checklist

When shipping Paprwork to users:

- [x] Default settings include Weekly War Room app ID
- [x] Tab title shows "Home" (not app name)
- [x] Graceful fallback if app missing
- [x] Users can override via settings (future Settings UI)
- [ ] Include Weekly War Room app in default apps bundle (see below)

## Important: App Bundling

**Critical Issue:** The `defaultHomeAppId` points to an app that exists on your machine, but won't exist on fresh installations!

### Current State

```
Your Machine:
  $PAPR_HOME/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/  ✅ Exists
    ├── index.html
    ├── app.js
    └── ...

Fresh Installation:
  $PAPR_HOME/apps/  ❌ Empty directory
```

### Solution Options

#### Option 1: Bundle Default Apps (Recommended)

Ship Weekly War Room app with the installation:

```
paprwork-v2/
├── src/resources/
│   └── default-apps/
│       └── weekly-war-room/
│           ├── id.txt  # Contains: bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c
│           ├── index.html
│           ├── app.js
│           └── ...
```

On first launch, copy to `$PAPR_HOME/apps/`:

```typescript
// In AppService.initialize()
const defaultAppsDir = path.join(__dirname, 'resources', 'default-apps');
const weeklyWarRoomSource = path.join(defaultAppsDir, 'weekly-war-room');
const weeklyWarRoomTarget = path.join(appsDir, 'bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c');

if (!fs.existsSync(weeklyWarRoomTarget)) {
  fs.copySync(weeklyWarRoomSource, weeklyWarRoomTarget);
  // Register in apps.json
}
```

#### Option 2: Generate on First Launch

Create Weekly War Room app programmatically when user first opens Paprwork:

```typescript
// In App.tsx or main.ts
const hasWeeklyWarRoom = await checkAppExists('bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c');
if (!hasWeeklyWarRoom) {
  await createWeeklyWarRoomApp();
}
```

#### Option 3: Dynamic Default

Don't hardcode the app ID, create and set it dynamically:

```typescript
const DEFAULT_SETTINGS: AppSettings = {
  preferences: {
    defaultHomeAppId: undefined, // Set after creating default app
  }
};

// On first launch
const weeklyWarRoom = await createWeeklyWarRoomApp();
await settingsStorage.updatePreferences({
  defaultHomeAppId: weeklyWarRoom.id
});
```

### Recommendation

**Use Option 1** (Bundle Default Apps):
- Most reliable
- Users get consistent experience
- No runtime generation complexity
- App works offline from day 1

## Next Steps

### Immediate (Required)

1. **Export your Weekly War Room app:**
   ```bash
   # Create bundle
   mkdir -p src/resources/default-apps/weekly-war-room
   cp -r $PAPR_HOME/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/* \
         src/resources/default-apps/weekly-war-room/
   
   # Document the app ID
   echo "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c" > \
         src/resources/default-apps/weekly-war-room/app-id.txt
   ```

2. **Add copy logic to AppService:**
   ```typescript
   // In src/gateway/services/AppService.ts
   async installDefaultApps() {
     const defaultAppsDir = path.join(__dirname, '..', 'resources', 'default-apps');
     // Copy weekly-war-room if not exists
   }
   ```

3. **Call on first launch:**
   ```typescript
   // In AppService.initialize()
   await this.installDefaultApps();
   ```

### Future Enhancements

1. **Settings UI:**
   - Add dropdown to select home app
   - "None" option to restore placeholder
   - Preview home app before setting

2. **Multiple Default Apps:**
   - Ship with 3-5 starter apps
   - Let user choose during onboarding
   - Templates: Daily Brief, CRM, Analytics, etc.

3. **Agent Setup:**
   - "Create your home dashboard"
   - Agent generates personalized home app
   - Auto-set as default

## Testing

### Test Fresh Installation

```bash
# 1. Clear app data
rm -rf $PAPR_HOME/data/settings.json
rm -rf $PAPR_HOME/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c

# 2. Start app
npm start

# 3. Verify defaults
cat $PAPR_HOME/data/settings.json | jq '.preferences.defaultHomeAppId'

# 4. Click home button
# Expected: Falls back to placeholder (app missing)

# 5. Manually copy app back
cp -r /path/to/backup $PAPR_HOME/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c

# 6. Click home button again
# Expected: Opens "Home" tab with Weekly War Room
```

## Summary

### ✅ Completed

1. Default settings include Weekly War Room app ID
2. Tab title always shows "Home"
3. Fresh installations get the default
4. Existing users keep their settings

### ⚠️ Action Required

**Bundle the Weekly War Room app with the installation** so fresh installs have the app files, not just the setting pointing to a non-existent app.

### 📊 Current State

```
Setting:     ✅ defaultHomeAppId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"
Tab Title:   ✅ Shows "Home"
Your Machine: ✅ App exists, works perfectly
Fresh Install: ❌ App missing, falls back to placeholder
```

**Next:** Bundle the app files to make fresh installs work out of the box.
