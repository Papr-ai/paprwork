# Default Provider Resolution & Home Dashboard App

**Implemented:** 2026-03-31

## Overview

Two major improvements for better user experience across different LLM configurations:

1. **Smart Default Provider** - Agent jobs without explicit provider/model automatically use what the user has configured
2. **Bundled Home Dashboard** - Weekly War Room app ships with Paprwork and installs on first launch

---

## 1. Smart Default Provider Resolution

### The Problem

Previously, agent jobs defaulted to `openai/gpt-5.2` when provider/model weren't specified. This meant:
- Users with only Anthropic → Jobs failed
- Users with only Google → Jobs failed  
- Users with only Ollama → Jobs failed

### The Solution

Created `src/gateway/utils/defaultProvider.ts` with smart resolution:

```typescript
export async function getDefaultProviderAndModel(): Promise<{
  provider: Provider;
  model: string;
}> {
  // Priority order:
  // 1. OAuth-authenticated providers (openai, anthropic)
  // 2. API key providers (openai, anthropic, google)
  // 3. Ollama (always available, no auth needed)
  // 4. Fallback: openai/gpt-5.2 (will error if not configured)
}
```

### Resolution Priority

```
┌─────────────────────────────────────────┐
│  1. OpenAI OAuth (ChatGPT Plus/Pro)    │
├─────────────────────────────────────────┤
│  2. Anthropic OAuth (Claude Pro/Max)   │
├─────────────────────────────────────────┤
│  3. OpenAI API Key                      │
├─────────────────────────────────────────┤
│  4. Anthropic API Key                   │
├─────────────────────────────────────────┤
│  5. Google API Key (Gemini)            │
├─────────────────────────────────────────┤
│  6. Ollama (local, always available)    │
├─────────────────────────────────────────┤
│  7. Fallback to OpenAI (may error)      │
└─────────────────────────────────────────┘
```

### Default Models by Provider

| Provider | Default Model |
|----------|---------------|
| `openai` | `gpt-5.2` |
| `openai-codex` | `gpt-5.3-codex` |
| `anthropic` | `claude-sonnet-4-6` |
| `google` | `gemini-2.5-flash` |
| `ollama` | `qwen3.5:latest` |

### Integration

Updated both job session methods in `AgentService.ts`:

**Before:**
```typescript
const provider = input.provider ?? "openai";
const model = input.model ?? defaultModelByProvider[provider];
```

**After:**
```typescript
let provider = input.provider;
let model = input.model;

if (!provider || !model) {
  const { getDefaultProviderAndModel } = await import("../utils/defaultProvider.js");
  const defaults = await getDefaultProviderAndModel();
  provider = provider ?? defaults.provider;
  model = model ?? defaults.model;
  console.log(`[AgentService] Using default provider/model: ${provider}/${model}`);
}
```

### User Impact

**Before:**
```bash
# User has only Claude Pro OAuth
create_job({
  name: "Weekly Brief",
  type: "agent",
  command: "Generate weekly brief"
})
# ❌ Error: No OpenAI API key found
```

**After:**
```bash
# Same user, same job creation
create_job({
  name: "Weekly Brief",
  type: "agent",
  command: "Generate weekly brief"
})
# ✅ Success: Uses Claude Sonnet (from OAuth)
# ✅ Console: "[AgentService] Using default provider/model: anthropic/claude-sonnet-4-6"
```

### API for Future Use

The `defaultProvider.ts` module exports two functions:

```typescript
// Get single best default
const defaults = await getDefaultProviderAndModel();
// { provider: "anthropic", model: "claude-sonnet-4-6" }

// Get all available providers (useful for Settings UI)
const available = await getAvailableProviders();
// [
//   { provider: "anthropic", model: "claude-sonnet-4-6", hasAuth: true },
//   { provider: "ollama", model: "qwen3.5:latest", hasAuth: true }
// ]
```

---

## 2. Bundled Home Dashboard App

### The Problem

We configured `defaultHomeAppId` in settings, but the app itself only existed on your machine. Fresh installations would:
- Have the setting pointing to a non-existent app
- Fall back to placeholder "Agent Lounge (Coming Soon)"
- User sees no home dashboard

### The Solution

Bundle the Weekly War Room app with Paprwork and auto-install on first launch.

### Implementation

**1. Bundled App Location:**
```
src/resources/default-apps/home-dashboard/
├── app-id.txt              # bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c
├── metadata.json           # App metadata
├── index.html              # Main HTML
├── app.js                  # App logic
├── data.js                 # Data loading
├── render.js               # UI rendering
├── fold_nav.js             # Navigation
├── curl.js, curl_draw.js   # Animations
├── styles.css, fold.css, cards.css # Styles
├── data-sources.json       # Empty array (users link their own jobs)
└── README.md               # Documentation
```

**2. Build Process:**
```bash
# package.json - build:gateway script
"build:gateway": "tsc -p tsconfig.gateway.json && shx cp -r src/resources dist/"
```

The `src/resources/` folder is automatically copied to `dist/resources/` during build.

**3. Auto-Installation Logic:**

Added `installDefaultApps()` method in `AppService.ts`:

```typescript
private async installDefaultApps(): Promise<void> {
  const defaultAppsDir = path.join(__dirname, "..", "resources", "default-apps");
  
  for (const appDirName of await fs.readdir(defaultAppsDir)) {
    // Read app ID from app-id.txt
    const appId = (await fs.readFile("app-id.txt", "utf-8")).trim();
    
    // Check if already installed
    const targetDir = path.join(this.appsDir, appId);
    if (exists(targetDir)) continue; // Skip if already exists
    
    // Copy app files
    await fs.cp(sourceDir, targetDir, { recursive: true });
    console.log(`[AppService] Installed default app: ${appId}`);
  }
}
```

Called in `initialize()`:
```typescript
async initialize(): Promise<void> {
  await this.migrateLegacyIfNeeded();
  await fs.mkdir(this.appsDir, { recursive: true });
  await this.installDefaultApps(); // ✅ Install default apps
  await this.loadApps();
  await this.startWatchingApps();
}
```

### User Experience

**Fresh Installation Flow:**
```
1. User installs Paprwork
2. First launch → AppService.initialize() runs
3. installDefaultApps() checks ~/PAPR/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/
4. Not found → Copies from dist/resources/default-apps/home-dashboard/
5. App appears in apps list
6. settings.json has defaultHomeAppId pointing to it
7. User clicks home button → Dashboard opens ✅
```

### Data Sources

The bundled app has empty `data-sources.json`:

```json
[]
```

Users need to:
1. Create their own "Weekly Brief Generator" agent job
2. Link it to the home dashboard app
3. Dashboard will display the data

**Agent guidance (SystemPrompt.ts) includes:**
```
When creating jobs for the home dashboard, don't specify provider/model 
- they will automatically use the user's configured provider.
```

---

## Files Changed

### Core Changes
- `src/gateway/utils/defaultProvider.ts` - ✅ NEW: Smart provider resolution
- `src/gateway/services/AgentService.ts` - ✅ MODIFIED: Use default provider
- `src/gateway/services/AppService.ts` - ✅ MODIFIED: Auto-install default apps

### Bundled Resources
- `src/resources/default-apps/home-dashboard/` - ✅ NEW: Complete app bundle
  - All app files (HTML, JS, CSS)
  - metadata.json with app info
  - Empty data-sources.json
  - README.md with usage instructions

### Settings
- `src/core/storage/SettingsStorage.ts` - ✅ Already has default homeAppId
- `ui/components/Tabs/TabBar.tsx` - ✅ Already uses "Home" title
- `ui/components/Layout/ContentArea.tsx` - ✅ Already has redirect logic

---

## Testing

### Test Default Provider Resolution

```typescript
// 1. User with only Claude OAuth
// Create agent job without provider/model
create_job({
  name: "Test Job",
  type: "agent",
  command: "Say hello"
});

// Expected console output:
// [AgentService] Using default provider/model: anthropic/claude-sonnet-4-6

// 2. User with only Ollama (no API keys, no OAuth)
// Same job creation
// Expected console output:
// [AgentService] Using default provider/model: ollama/qwen3.5:latest
```

### Test Default App Installation

```bash
# 1. Fresh installation simulation
rm -rf ~/PAPR/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c
rm -f ~/PAPR/data/apps.json

# 2. Build the app (copies resources to dist/)
npm run build

# 3. Start the app
npm start

# 4. Check console for installation message
# Expected: "[AppService] Installed default app: bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c (home-dashboard)"

# 5. Verify app exists
ls ~/PAPR/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/

# 6. Click home button
# Expected: "Home" tab opens with Weekly War Room dashboard
```

### Test with Different Providers

```bash
# Scenario 1: User with OpenAI API key only
# Expected: Jobs use openai/gpt-5.2

# Scenario 2: User with Claude OAuth only  
# Expected: Jobs use anthropic/claude-sonnet-4-6

# Scenario 3: User with Gemini API key only
# Expected: Jobs use google/gemini-2.5-flash

# Scenario 4: User with no auth (just Ollama installed)
# Expected: Jobs use ollama/qwen3.5:latest

# Scenario 5: User with explicit provider in job
create_job({ provider: "openai", model: "gpt-5.4", ... })
# Expected: Uses gpt-5.4 (explicit overrides default)
```

---

## Agent Guidance Updates

Update `SystemPrompt.ts` to inform the agent about this feature:

```typescript
### Agent Jobs - Provider/Model Selection

When creating agent jobs, you can OPTIONALLY specify provider and model.
If not specified, the system will automatically use the user's available provider:

✅ **Recommended (Auto-select):**
create_job({
  name: "Weekly Brief",
  type: "agent",
  command: "Generate weekly brief"
  // No provider/model → Uses user's default
})

✅ **Explicit (Override):**
create_job({
  name: "Weekly Brief",
  type: "agent",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  command: "Generate weekly brief"
})

**Priority order:** OAuth → API keys → Ollama (local)
```

---

## User Documentation

### For Users Creating Jobs

**Simple (Recommended):**
```typescript
"Create a weekly brief job"
// Agent creates job without provider/model
// Uses your configured provider automatically
```

**Advanced (Override):**
```typescript
"Create a weekly brief job using GPT-5.4"
// Agent creates job with explicit model
// Useful when you want specific model capabilities
```

### For Users Setting Up Home Dashboard

1. **Automatic Setup (Recommended):**
   - Click home button
   - Dashboard appears (pre-installed)
   - Create jobs to populate it
   - Agent will automatically link jobs to dashboard

2. **Manual Setup:**
   ```bash
   # Create job
   create_job({
     name: "Weekly Brief Generator",
     type: "agent",
     command: "Generate weekly brief and save to database",
     schedule: { enabled: true, cron: "0 7 * * 1" }
   })
   
   # Link job to dashboard
   # Agent will handle this automatically when you mention the home dashboard
   ```

---

## Benefits Summary

### 1. Provider Resolution

✅ Works with any provider configuration  
✅ No hardcoded OpenAI dependency  
✅ Ollama fallback (free, local)  
✅ OAuth prioritized (best UX)  
✅ Explicit provider overrides still work  

### 2. Bundled Home App

✅ Works out-of-the-box (no setup)  
✅ Professional home page (not placeholder)  
✅ Users just need to create data jobs  
✅ Agent guides users through setup  
✅ Consistent across all installations  

---

## Future Enhancements

### 1. Multiple Default Apps

Ship with starter app templates:
- Daily Brief Dashboard
- CRM Home View
- Analytics Dashboard
- Project Tracker

User picks during onboarding or from Settings.

### 2. Provider Recommendation UI

Settings → Providers → Show detected providers with "Recommended" badge:

```
Available Providers:
 ⭐ Anthropic (Claude Pro OAuth) - Recommended
    OpenAI (API Key)
    Ollama (Local) - Free, Private
```

### 3. Smart Job Creation

Agent detects provider and suggests appropriate models:

```
User: "Create a reasoning-heavy job"
Agent: "I'll use GPT-5.4 (detected via your ChatGPT Pro OAuth) for its 
enhanced reasoning capabilities. Creating job..."
```

### 4. App Marketplace

Users can download more default apps:
- LinkedIn Autopilot
- GitHub Dashboard
- Notion Sync
- Custom templates

---

## Success Criteria

### Provider Resolution
- [ ] Works with OpenAI OAuth only
- [ ] Works with Claude OAuth only
- [ ] Works with API keys only
- [ ] Works with Ollama only (no auth)
- [ ] Works with mixed authentication
- [ ] Logs chosen provider clearly
- [ ] Explicit provider overrides work

### Home Dashboard
- [ ] Installs on first launch
- [ ] Does not reinstall if exists
- [ ] Home button opens dashboard
- [ ] Tab shows "Home" (not app name)
- [ ] Empty data sources initially
- [ ] README explains setup
- [ ] Agent can create data jobs
- [ ] Agent can link jobs to dashboard

---

## Status

✅ **Default provider resolution** - Implemented  
✅ **Home dashboard bundling** - Implemented  
✅ **Auto-installation logic** - Implemented  
✅ **Build process** - Configured  
✅ **Documentation** - Complete  

**Next:** Test with fresh installation and different provider configurations
