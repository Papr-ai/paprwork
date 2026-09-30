# Default Home App Configuration

**Added:** 2026-03-30

## Overview

This feature allows you to configure any mini-app as the default "home" view that opens when users click the home button in the tab bar. This is perfect for replacing the placeholder "Agent Lounge (Coming Soon)" with a custom dashboard like a Daily Brief, Weekly War Room, or any other app.

## How It Works

### Architecture

1. **Settings Storage** - A `defaultHomeAppId` field in `preferences` stores the app ID
2. **Home Button Handler** - The TabBar checks for the default app and opens it instead of creating a home tab
3. **Home Tab Redirect** - If a home tab is somehow created directly, it redirects to the default app
4. **Fallback Behavior** - If no default app is configured or the app doesn't exist, shows the original placeholder

### Files Modified

- `src/core/types/storage.ts` - Added `defaultHomeAppId?: string` to preferences
- `ui/components/Tabs/TabBar.tsx` - Enhanced home button handler to check for default app
- `ui/components/Layout/ContentArea.tsx` - Added `HomeRedirect` component to handle redirects
- `scripts/set-default-home-app.mjs` - CLI tool for setting the default app
- `package.json` - Added `set-home-app` script

## Usage

### Setting a Default Home App

#### Option 1: Using the npm script (Recommended)

```bash
# Set a specific app as home
npm run set-home-app <appId>

# Example (Weekly War Room)
npm run set-home-app bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c

# Clear the default home app (restore placeholder)
npm run set-home-app --clear
```

#### Option 2: Direct script execution

```bash
node scripts/set-default-home-app.mjs <appId>
node scripts/set-default-home-app.mjs --clear
```

#### Option 3: Manual settings.json edit

```bash
# Edit $PAPR_HOME/data/settings.json
{
  "preferences": {
    "defaultHomeAppId": "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"
  }
}
```

### Finding App IDs

```bash
# List all apps with their IDs
cat $PAPR_HOME/data/apps.json | jq '.[] | {id, title, description}'

# Find a specific app
cat $PAPR_HOME/data/apps.json | jq '.[] | select(.title | contains("Daily Brief"))'
```

### After Configuration

1. Restart Paprwork
2. Click the home button (house icon in tab bar)
3. Your configured app opens automatically

## User Experience

### Before Configuration

- Click home button → "Agent Lounge (Coming Soon)" placeholder
- No useful default landing page

### After Configuration

- Click home button → Opens your Daily Brief / War Room / Dashboard
- Consistent, branded home experience
- Users land on your custom app by default

## Use Cases

### 1. Daily Brief Dashboard

Perfect for your current setup:

```bash
npm run set-home-app bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c
```

Users click home → See today's brief with meetings, OKRs, priorities

### 2. Weekly War Room

Same app ID, different perspective:

```bash
npm run set-home-app bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c
```

Users click home → See weekly prep dashboard

### 3. Personal Analytics Dashboard

```bash
# Create an app that shows usage stats, productivity metrics, etc.
npm run set-home-app <analytics-app-id>
```

Users click home → See their productivity dashboard

### 4. Custom CRM Home

```bash
# Create an app showing today's leads, follow-ups, deals
npm run set-home-app <crm-app-id>
```

Users click home → See their daily CRM view

## Implementation Details

### TabBar Home Button Logic

```typescript
const handleHome = async () => {
  // Check if there's a default home app configured
  const response = await window.electronAPI.gateway.send('settings:get', {});
  const defaultHomeAppId = response?.data?.preferences?.defaultHomeAppId;
  
  if (defaultHomeAppId) {
    // Get app details to use its title
    const appsResponse = await window.electronAPI.gateway.send('app:list', {});
    const app = appsResponse?.data?.apps?.find((a: any) => a.id === defaultHomeAppId);
    
    if (app) {
      // Open the configured home app instead
      createTab("app", defaultHomeAppId, app.title);
      return;
    }
  }
  
  // Fallback: Create regular home tab
  createTab("home", "home", "Home");
};
```

### HomeRedirect Component

```typescript
function HomeRedirect() {
  const { createTab, closeTab, activeTabId } = useTabs();
  const [redirecting, setRedirecting] = useState(true);

  useEffect(() => {
    const checkAndRedirect = async () => {
      const response = await window.electronAPI.gateway.send('settings:get', {});
      const defaultHomeAppId = response?.data?.preferences?.defaultHomeAppId;
      
      if (defaultHomeAppId) {
        const appsResponse = await window.electronAPI.gateway.send('app:list', {});
        const app = appsResponse?.data?.apps?.find((a: any) => a.id === defaultHomeAppId);
        
        if (app) {
          // Close current home tab and open app tab
          if (activeTabId) closeTab(activeTabId);
          createTab("app", defaultHomeAppId, app.title);
          return;
        }
      }
      
      setRedirecting(false); // No redirect, show placeholder
    };

    checkAndRedirect();
  }, []);

  if (redirecting) {
    return <div className="content-area__empty">Loading...</div>;
  }

  return (
    <div className="content-area__placeholder">
      Agent Lounge (Coming Soon)
    </div>
  );
}
```

### Configuration Script

The `set-default-home-app.mjs` script:

1. Loads existing `$PAPR_HOME/data/settings.json`
2. Updates `preferences.defaultHomeAppId`
3. Saves back to disk
4. Provides clear confirmation messages

## Rollout Strategy

### Phase 1: Internal Testing (Current)

- Set your own Daily Brief as default home
- Verify home button behavior
- Test edge cases (app deleted, settings corrupt)

### Phase 2: Beta Users

- Document the feature
- Provide script for beta users
- Gather feedback on UX

### Phase 3: General Availability

Option A: **Settings UI**
- Add "Default Home App" dropdown in Settings → Preferences
- Users select from installed apps
- Most user-friendly

Option B: **Keep CLI-only**
- Power users set via script
- Simpler implementation
- Lower maintenance burden

Option C: **Agent Command**
- User: "Make Daily Brief my home page"
- Agent: Runs the script automatically
- Most Paprwork-native approach

## Edge Cases Handled

### App Doesn't Exist

If the configured app ID doesn't exist in `apps.json`:

1. Home button handler checks app list
2. If not found, falls back to regular home tab
3. No error thrown, graceful degradation

### Settings File Missing

If `$PAPR_HOME/data/settings.json` doesn't exist:

1. Script creates new settings file
2. Sets the default home app
3. User just needs to restart

### App Deleted After Configuration

1. Gateway returns empty app list for that ID
2. Home button handler detects this
3. Falls back to placeholder view
4. No crash, graceful handling

## Testing

### Manual Testing Checklist

- [ ] Set default home app via script
- [ ] Restart Paprwork
- [ ] Click home button
- [ ] Verify app opens (not placeholder)
- [ ] Tab title matches app title
- [ ] App renders correctly
- [ ] Clear default home app
- [ ] Restart Paprwork
- [ ] Verify placeholder shows
- [ ] Set to non-existent app ID
- [ ] Verify fallback to placeholder

### Automated Testing

```bash
# Test the configuration script
node scripts/set-default-home-app.mjs test-app-id
cat $PAPR_HOME/data/settings.json | jq '.preferences.defaultHomeAppId'

node scripts/set-default-home-app.mjs --clear
cat $PAPR_HOME/data/settings.json | jq '.preferences.defaultHomeAppId'
```

## Future Enhancements

### 1. Settings UI

Add dropdown in Settings → Preferences:

```typescript
<select 
  value={preferences.defaultHomeAppId || ''}
  onChange={(e) => updatePreference('defaultHomeAppId', e.target.value)}
>
  <option value="">None (show placeholder)</option>
  {apps.map(app => (
    <option key={app.id} value={app.id}>{app.title}</option>
  ))}
</select>
```

### 2. Per-User Defaults

Allow different defaults per Papr account:

```typescript
paprProfile: {
  preferences: {
    defaultHomeAppId: "user-specific-app-id"
  }
}
```

### 3. Quick Switch

Add context menu to app tabs:

- Right-click app tab
- "Set as Home" option
- Updates settings instantly

### 4. App Recommendations

When user creates Daily Brief-like apps:

```
Agent: "I've created your Daily Brief app. Would you like to make this your home page?"
[Set as Home] [Keep Current]
```

## Documentation Updates

### User-Facing Docs

- [ ] Add to README.md (Features section)
- [ ] Create user guide in docs/
- [ ] Add to onboarding tutorial
- [ ] Update keyboard shortcuts doc

### Developer Docs

- [x] This implementation doc
- [ ] Update CLAUDE.md with enhancement details
- [ ] Add to architecture diagrams
- [ ] Update API documentation

## Rollback Plan

If issues arise:

```bash
# Quick rollback
npm run set-home-app --clear

# Or edit settings manually
rm $PAPR_HOME/data/settings.json
# (will regenerate on next launch)
```

## Success Metrics

- **Adoption Rate:** % of users who configure default home app
- **Retention:** Do users keep their custom home page?
- **Support Tickets:** Any confusion or issues?
- **Power User Feedback:** What do they set as home?

## Related Features

- **Favorites System:** Pin apps to sidebar
- **Quick Launch:** Cmd+K → Open app
- **Recent Apps:** Track recently opened apps
- **App Templates:** Pre-built home dashboards

---

## Quick Reference

```bash
# Set Daily Brief as home
npm run set-home-app bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c

# Clear default home
npm run set-home-app --clear

# Find app IDs
cat $PAPR_HOME/data/apps.json | jq '.[] | {id, title}'

# Check current setting
cat $PAPR_HOME/data/settings.json | jq '.preferences.defaultHomeAppId'
```

**Status:** ✅ Implemented and configured for your Weekly War Room app

**Next Steps:** Test the home button behavior after restarting Paprwork
