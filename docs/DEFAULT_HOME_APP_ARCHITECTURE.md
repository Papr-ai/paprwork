# Default Home App Architecture

## System Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Action                              │
│                    Clicks Home Button 🏠                         │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    TabBar.tsx                                    │
│                  handleHome() async                              │
│                                                                  │
│  1. Send 'settings:get' to Gateway                              │
│  2. Check response.data.preferences.defaultHomeAppId            │
└─────────────────────┬───────────────────────────────────────────┘
                      │
         ┌────────────┴────────────┐
         │                         │
         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐
│   Has App ID?    │      │   No App ID?     │
│   ✅ Yes         │      │   ❌ No          │
└────────┬─────────┘      └────────┬─────────┘
         │                         │
         │                         └─────────────────┐
         ▼                                           │
┌─────────────────────────────────────────┐         │
│  Send 'app:list' to Gateway              │         │
│  Find app by ID                          │         │
└────────┬────────────────────────────────┘         │
         │                                           │
    ┌────┴─────┐                                    │
    │          │                                    │
    ▼          ▼                                    ▼
┌────────┐  ┌────────┐                    ┌──────────────┐
│App     │  │App     │                    │Create        │
│Found   │  │Missing │                    │home tab      │
│✅      │  │❌      │                    │(placeholder) │
└───┬────┘  └───┬────┘                    └──────┬───────┘
    │           │                                 │
    │           └────────────────┐                │
    │                            │                │
    ▼                            ▼                ▼
┌─────────────────┐    ┌──────────────────────────────────┐
│ createTab(      │    │        ContentArea.tsx           │
│   "app",        │    │      case "home":                │
│   appId,        │    │        <HomeRedirect />          │
│   app.title     │    │                                  │
│ )               │    │  Shows placeholder or redirects  │
└─────────────────┘    └──────────────────────────────────┘
```

## Data Flow

```
Settings Storage (~/Papr/data/settings.json)
│
├─ preferences: {
│    defaultHomeAppId: "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"
│  }
│
│  Read by Gateway → Sent to UI
│
▼
TabBar Component
│
├─ User clicks home button
│
├─ Async check: Is defaultHomeAppId set?
│   │
│   ├─ YES → Look up app in apps.json
│   │         │
│   │         ├─ App exists → Open app tab ✅
│   │         └─ App missing → Fallback to placeholder
│   │
│   └─ NO → Create home tab → Shows placeholder
│
▼
App Opens (Weekly War Room)
```

## File Structure

```
paprwork-v2/
│
├── src/
│   ├── core/types/storage.ts
│   │   └── AppSettings.preferences.defaultHomeAppId?: string
│   │
│   └── ...
│
├── ui/
│   └── components/
│       ├── Tabs/TabBar.tsx
│       │   └── handleHome() - Checks for default app
│       │
│       └── Layout/ContentArea.tsx
│           └── HomeRedirect component - Redirects if configured
│
├── scripts/
│   └── set-default-home-app.mjs
│       └── CLI tool for configuration
│
├── docs/
│   ├── DEFAULT_HOME_APP.md
│   └── DEFAULT_HOME_APP_SETUP_COMPLETE.md
│
└── ~/Papr/
    ├── data/
    │   ├── settings.json
    │   │   └── preferences.defaultHomeAppId: "<app-id>"
    │   │
    │   └── apps.json
    │       └── [{ id, title, description, ... }]
    │
    └── apps/
        └── bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/
            └── Weekly War Room files
```

## Component Interaction

```
┌──────────────────────────────────────────────────────────────┐
│                         App.tsx                               │
│  (Main application, loads preferences on startup)             │
└───────────────────────────┬──────────────────────────────────┘
                            │
                ┌───────────┴────────────┐
                │                        │
                ▼                        ▼
    ┌──────────────────────┐   ┌──────────────────────┐
    │   TabBar.tsx         │   │   ContentArea.tsx    │
    │                      │   │                      │
    │  Home Button         │   │  Tab Renderer        │
    │  ├─ handleHome()     │   │  ├─ renderView()     │
    │  │   ├─ Get setting  │   │  │   └─ HomeRedirect│
    │  │   ├─ Get app      │   │  │                   │
    │  │   └─ Open tab     │   │  └─ Or placeholder  │
    │  │                   │   │                      │
    └──┴───────────────────┘   └──┴───────────────────┘
       │                          │
       └──────────┬───────────────┘
                  │
                  ▼
    ┌──────────────────────────────┐
    │     Gateway WebSocket        │
    │  ├─ settings:get             │
    │  └─ app:list                 │
    └──────────────────────────────┘
                  │
                  ▼
    ┌──────────────────────────────┐
    │    Settings Storage          │
    │    ~/Papr/data/settings.json │
    └──────────────────────────────┘
```

## Configuration Flow

```
Developer/User
    │
    ├─ npm run set-home-app <app-id>
    │
    ▼
scripts/set-default-home-app.mjs
    │
    ├─ Read ~/Papr/data/settings.json
    │
    ├─ Set preferences.defaultHomeAppId = <app-id>
    │
    └─ Write settings.json
        │
        ▼
    User restarts Paprwork
        │
        ▼
    App.tsx loads preferences
        │
        ▼
    TabBar checks defaultHomeAppId on home click
        │
        └─ Opens configured app ✅
```

## State Management

```
┌─────────────────────────────────────────────────────────┐
│                    Persistent State                      │
│               (~/Papr/data/settings.json)                │
│                                                          │
│  {                                                       │
│    "preferences": {                                      │
│      "defaultHomeAppId": "bbb7e17e-c810-47ef..."       │
│    }                                                     │
│  }                                                       │
└─────────────────────────────┬───────────────────────────┘
                              │
                              │ Loaded on app start
                              │
                              ▼
                 ┌──────────────────────────┐
                 │   Runtime State          │
                 │   (Gateway + UI)         │
                 │                          │
                 │  Gateway reads from      │
                 │  settings.json on        │
                 │  'settings:get' IPC      │
                 │                          │
                 │  UI caches response      │
                 │  for fast access         │
                 └──────────────────────────┘
                              │
                              │ Used on home click
                              │
                              ▼
                 ┌──────────────────────────┐
                 │  TabBar.handleHome()     │
                 │  Checks cache/gateway    │
                 │  Opens configured app    │
                 └──────────────────────────┘
```

## Error Handling

```
Home Button Clicked
    │
    ├─ Try: Get settings
    │   │
    │   ├─ Success: Has defaultHomeAppId?
    │   │   │
    │   │   ├─ YES → Try: Get app list
    │   │   │   │
    │   │   │   ├─ Success: App found?
    │   │   │   │   │
    │   │   │   │   ├─ YES → Open app tab ✅
    │   │   │   │   │
    │   │   │   │   └─ NO → Log warning → Fallback
    │   │   │   │
    │   │   │   └─ Error → Log error → Fallback
    │   │   │
    │   │   └─ NO → Fallback
    │   │
    │   └─ Error → Log error → Fallback
    │
    └─ Fallback: createTab("home", "home", "Home")
           │
           └─ Shows placeholder "Agent Lounge (Coming Soon)"
```

## Timeline

```
T0: User clicks home button
    │
    ├─ 0-10ms: Check settings cache
    │          (or IPC to Gateway)
    │
    ├─ 10-20ms: Get app list from Gateway
    │           (cached in memory)
    │
    ├─ 20-30ms: Find app by ID
    │           (array lookup)
    │
    └─ 30-40ms: Create tab, render app
               (Vite transpiles on demand)
        │
        └─ 40-100ms: App fully loaded
                     (depends on app complexity)
```

## Key Design Decisions

### 1. Why Settings Storage?

✅ Persistent across restarts  
✅ Easy to backup/restore  
✅ Human-readable (JSON)  
✅ Already exists in architecture  

### 2. Why Async Check on Home Click?

✅ Settings might change at runtime  
✅ Apps might be installed/deleted  
✅ Graceful fallback if app missing  
✅ No blocking on app launch  

### 3. Why Redirect Component?

✅ Handles edge case (direct home tab creation)  
✅ Consistent behavior across entry points  
✅ Clean separation of concerns  
✅ Easy to test independently  

### 4. Why CLI Script First?

✅ Fastest to implement  
✅ Works immediately  
✅ Foundation for Settings UI later  
✅ Power users can automate  

## Future Architecture

```
Current:
  User → CLI script → settings.json → Restart → Home button → App

Future Option 1 (Settings UI):
  User → Settings dropdown → settings.json → No restart → Home button → App

Future Option 2 (Agent Command):
  User → Chat: "Make Daily Brief my home"
       → Agent → settings.json → No restart → Home button → App

Future Option 3 (Right-click):
  User → Right-click app tab → "Set as Home"
       → settings.json → No restart → Home button → App
```
