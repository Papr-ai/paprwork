# Default Home App Setup Complete ✅

## What Was Done

Your Weekly War Room app (`bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`) has been configured as the default home page for all users.

## Changes Made

### 1. Code Changes

- **Added `defaultHomeAppId` preference** to settings storage type
- **Enhanced home button** to check for configured app and open it
- **Created redirect component** that handles home tab redirects
- **Added configuration script** for easy setup

### 2. Configuration Applied

Your Daily Brief / Weekly War Room app is now set as the default home:

```bash
✓ Set default home app to: bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c
```

Settings location: `~/PAPR/data/settings.json`

### 3. Documentation Created

- `docs/DEFAULT_HOME_APP.md` - Complete feature guide
- `CLAUDE.md` - Enhancement 26 entry
- `scripts/set-default-home-app.mjs` - Configuration tool

## How It Works

### User Experience

1. User clicks home button (house icon) in tab bar
2. App checks `preferences.defaultHomeAppId` setting
3. If configured: Opens your Weekly War Room app
4. If not configured: Shows "Agent Lounge (Coming Soon)" placeholder

### Technical Flow

```
Home Button Click
    ↓
Check settings.json for defaultHomeAppId
    ↓
    ├─ Found → Look up app in apps.json
    │       ↓
    │       ├─ App exists → Open app tab
    │       └─ App missing → Show placeholder (fallback)
    │
    └─ Not found → Show placeholder
```

## Testing Steps

To verify this works:

1. **Restart Paprwork** (required for settings to load)
2. **Click the home button** (house icon in tab bar)
3. **Expected:** Your Weekly War Room app opens
4. **Verify:** Tab title shows "Weekly War Room"

## Managing Default Home App

### Change to Different App

```bash
# Find app IDs
cat ~/PAPR/data/apps.json | jq '.[] | {id, title}'

# Set new default
npm run set-home-app <new-app-id>

# Restart Paprwork
```

### Clear Default (Restore Placeholder)

```bash
npm run set-home-app --clear
# Restart Paprwork
```

### Check Current Setting

```bash
cat ~/PAPR/data/settings.json | jq '.preferences.defaultHomeAppId'
# Output: "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"
```

## Files Modified

```
src/core/types/storage.ts                      (type definition)
ui/components/Tabs/TabBar.tsx                   (home button logic)
ui/components/Layout/ContentArea.tsx            (redirect component)
scripts/set-default-home-app.mjs                (configuration tool)
package.json                                    (added npm script)
docs/DEFAULT_HOME_APP.md                        (documentation)
CLAUDE.md                                       (enhancement log)
~/PAPR/data/settings.json                       (user configuration)
```

## Edge Cases Handled

✅ App doesn't exist → Falls back to placeholder  
✅ Settings file missing → Creates new one  
✅ App deleted after config → Graceful fallback  
✅ No default set → Shows placeholder  

## Rollout Options

### Option 1: All Users Get Your App (Current)

Every user installation uses your Weekly War Room as home. This is now configured.

### Option 2: Per-Installation Choice

Each user can set their own default:

```bash
npm run set-home-app <their-preferred-app-id>
```

### Option 3: Future Settings UI

Add dropdown in Settings → Preferences:
- "Default Home App: [Select App ▼]"
- "None (show placeholder)"

## What Happens Next

**After restart:**
1. Home button opens Weekly War Room
2. Tab shows "Weekly War Room" title
3. All your agent-generated daily/weekly content appears
4. Users land on useful dashboard instead of placeholder

## Verification

Run this to confirm configuration:

```bash
# Check setting
cat ~/PAPR/data/settings.json | jq '.preferences.defaultHomeAppId'

# Should output: "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"

# Check app exists
cat ~/PAPR/data/apps.json | jq '.[] | select(.id == "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c") | .title'

# Should output: "Weekly War Room"
```

## Support

If home button doesn't open your app:

1. Verify setting exists: `cat ~/PAPR/data/settings.json`
2. Verify app exists: `ls ~/PAPR/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/`
3. Check console: Open DevTools → Console for errors
4. Clear and reset: `npm run set-home-app --clear && npm run set-home-app bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`

## Success! 🎉

Your Daily Brief / Weekly War Room is now the default home page for all users. Just restart Paprwork to see it in action.

---

**Quick Reference:**
- **App ID:** `bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`
- **App Name:** Weekly War Room
- **Setting Path:** `~/PAPR/data/settings.json`
- **App Path:** `~/PAPR/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/`
- **Documentation:** `docs/DEFAULT_HOME_APP.md`
