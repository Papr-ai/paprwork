# "Generate My Real Brief" Button

**Added:** 2026-04-07

## Overview

Users who open the home dashboard for the first time see **sample data** demonstrating what the dashboard looks like when populated. A prominent banner with a **"Generate My Real Brief"** button lets them instantly create their first real brief using the agent.

## User Experience

### What Users See (Fresh Install)

```
┌─────────────────────────────────────────────────────────┐
│  ╔═════════════════════════════════════════════════╗    │
│  ║ 💡 This is sample data — showing what your      ║    │
│  ║    dashboard will look like when populated.     ║    │
│  ║                                                  ║    │
│  ║         [✨ Generate My Real Brief]             ║    │
│  ╚═════════════════════════════════════════════════╝    │
│                                                          │
│              Monday, April 7, 2026                       │
│                  Daily Brief                             │
│        4 meetings · 1 external · 2 action items          │
│                                                          │
│  📅 Today                                                │
│  ├─ 9:00  Team Standup                    [internal]    │
│  ├─ 10:30 Product Review                  [internal]    │
│  ├─ 2:00  Sarah Chen — Acme Corp         [external]    │
│  └─ 3:30  Sprint Planning                 [internal]    │
│  ...                                                     │
└─────────────────────────────────────────────────────────┘
```

### Interaction Flow

**1. User clicks "Generate My Real Brief"**

Button shows loading state:
```
[⟳ Generating...]
```

**2. Behind the scenes:**
```javascript
POST /api/jobs/run
Body: {
  jobId: "2cafb2e9-696b-42db-98fa-5d605977123c",
  wait: true  // Wait for completion
}
```

**3. Agent job runs:**
- Calls all available tools to gather data
- Checks calendar (if connected)
- Reviews recent chats
- Analyzes tasks and priorities
- Queries Papr Memory for context
- Generates personalized brief JSON
- Inserts into SQLite: `INSERT INTO briefs VALUES (date('now'), ...)`

**4. Success:**
```
[✓ Generated! Reloading...]
```
Dashboard reloads with real data!

**5. Failure (no data sources connected yet):**
```
[✗ Failed - Try Chat]
```
Button resets after 3 seconds.

## Technical Implementation

### Detection Logic

**How we detect sample data:**

```javascript
// data.js - Mark sample data with flag
sample() {
  return { 
    _isSample: true,  // ← Detection flag
    hero: { ... },
    sections: [ ... ]
  };
}

// app.js - Check for flag
const testBrief = await Data.load();
this.isSampleData = testBrief._isSample === true;

// Render banner only if sample
if (this.isSampleData) {
  renderSampleDataBanner();
}
```

### Button Handler

```javascript
async generateRealBrief() {
  // 1. Disable button + show loading
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div>Generating...';
  
  // 2. Trigger Daily Brief Generator job
  const response = await fetch('/api/jobs/run', {
    method: 'POST',
    body: JSON.stringify({
      jobId: '2cafb2e9-696b-42db-98fa-5d605977123c',
      wait: true  // Wait for completion
    })
  });
  
  // 3. Handle result
  if (result.success) {
    btn.innerHTML = '✓ Generated! Reloading...';
    setTimeout(() => {
      this.dates = []; // Clear cache
      this.init();      // Reload dashboard
    }, 1000);
  } else {
    btn.innerHTML = '✗ Failed - Try Chat';
    // Reset after 3 seconds
  }
}
```

### Banner Styling

**Design:** Frosted glass with blue gradient
- Semi-transparent background with backdrop blur
- Blue border with glow effect
- Smooth slide-in animation
- Glowing blue CTA button

**CSS:**
```css
.sample-data-banner {
  background: linear-gradient(135deg, rgba(59,130,246,0.12), rgba(79,70,229,0.08));
  border: 1px solid rgba(59,130,246,0.2);
  backdrop-filter: blur(20px);
  animation: bannerSlideIn 0.4s ease;
}

.gen-real-brief-btn {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  box-shadow: 0 2px 8px rgba(59,130,246,0.3);
}
```

## What the Agent Can Do

### What the Agent Can Do

When the button triggers the job, the agent **discovers and uses whatever data exists**:

**Data Discovery (Passive):**
```typescript
// 1. See what jobs exist
list_jobs() → ["Calendar Sync", "LinkedIn", "CRM", "Email Tracker"]

// 2. Check each job's database
for each job {
  bash({ command: "sqlite3 {jobPath}/data.db '.tables'" })
  → If has data, query relevant tables
}

// 3. Check Papr Memory
// Automatic access to conversation history, goals

// 4. Check file system (if user has notes)
bash({ command: "ls ~/Documents" })
```

**What it generates based on available data:**

**Scenario A: No external integrations yet**
```json
{
  "sections": [
    {"type": "priorities", "items": [...from chat history...]},
    {"type": "freeform", "content": "Based on our conversations..."}
  ]
}
```

**Scenario B: Calendar job exists**
```json
{
  "sections": [
    {"type": "timeline", "items": [...from calendar.db...]},
    {"type": "priorities", "items": [...from chat + goals...]},
    {"type": "freeform", "content": "..."}
  ]
}
```

**Scenario C: Full integrations (Calendar + LinkedIn + CRM)**
```json
{
  "sections": [
    {"type": "timeline", "items": [...meetings with intel...]},
    {"type": "priorities", "items": [...data-driven ranking...]},
    {"type": "tracker", "items": [...real metrics...]},
    {"type": "freeform", "content": "...strategic insights..."}
  ]
}
```

**Key principle: The brief grows with your integrations**
- Week 1: Just chat history → Basic priorities
- Week 2: Add calendar → Timeline appears
- Month 2: Add LinkedIn/CRM → Full context with intel

### Brief Generation Process

**Agent job command:**
```
"Generate a daily brief from available data. Check what jobs exist 
(list_jobs), what data they have, and use that to create a brief. 
Include: meetings (if calendar job exists), priorities (from chat 
history and goals), progress tracking (from other job data if available), 
and insights. If no external data exists, generate from our conversation 
history and stated goals. Format as JSON matching the dashboard schema."
```

**Agent's execution (simplified, passive approach):**
```typescript
// 1. Discover what data is available
list_jobs() → See what other jobs exist

// 2. Check available job databases
// If calendar job exists:
bash({ command: "sqlite3 $PAPR_HOME/Jobs/*/data.db '.databases'" })
→ Find calendar.db

// If found, query it:
bash({ 
  command: "sqlite3 .../calendar.db 'SELECT * FROM events WHERE date(start_time) = date(\"now\")'" 
})

// 3. Check other job data if they exist
// LinkedIn job?
bash({ command: "sqlite3 .../linkedin.db 'SELECT * FROM activities LIMIT 5'" })

// CRM job?
bash({ command: "sqlite3 .../crm.db 'SELECT * FROM contacts LIMIT 5'" })

// 4. Use Papr Memory for context
// Automatic - agent sees conversation history, goals

// 5. Generate brief from WHATEVER IS AVAILABLE
// - If calendar data exists → Include meetings section
// - If LinkedIn data exists → Include network section
// - If CRM data exists → Include pipeline section
// - If nothing exists → Generate from chat history only

// 6. Save to database
bash({ 
  command: `sqlite3 .../data.db "INSERT INTO briefs VALUES 
    (date('now'), '${JSON.stringify(briefData)}', datetime('now'))"`
})
```

**Key principle: Passive discovery, no setup**
- Agent NEVER prompts for calendar setup
- Agent NEVER installs packages
- Agent NEVER asks for configuration
- Agent JUST WORKS with what's already there

## User Journey Evolution

### Week 1: Sample Data + Button

**First open:**
```
💡 This is sample data
   [✨ Generate My Real Brief]
```

**User clicks button:**
- Job runs with agent's available tools
- Might generate minimal brief (if no integrations yet)
- Or asks user: "Connect your calendar first?"
- Banner disappears after first real brief generated

### Week 2: Minimal Real Data

**Agent generates from available data:**
- Chat history context
- User's stated goals
- Maybe 1-2 integrations (calendar or email)

**Brief sections:**
- Timeline: Real meetings from calendar
- Priorities: From conversations with agent
- Goals: From stated objectives
- Alerts: Generated from due dates

### Month 2: Fully Personalized

**Agent has rich context:**
- Multiple data sources (LinkedIn, CRM, email)
- Deep conversation history in Papr Memory
- User's workflows and preferences
- Connected systems and APIs

**Brief becomes:**
- Highly accurate meeting prep
- Data-driven priority ranking
- Real progress metrics
- Actionable insights

## Banner Visibility Logic

### When Banner Shows

```javascript
showBanner = (
  brief._isSample === true &&           // Sample data
  idx === 0                             // Today's view (not historical)
)
```

### When Banner Hides

```javascript
hideBanner = (
  brief._isSample !== true ||           // Real data loaded
  idx > 0                               // Viewing past day
)
```

**Once real data is generated, banner never shows again!**

## Error Handling

### Scenario 1: No Integrations Yet (Fresh Install)

**User clicks button** → Agent job runs

**Agent (passive discovery):**
```typescript
list_jobs() → Only "Daily Brief Generator"
// No calendar job, no LinkedIn, no CRM

// Agent generates minimal brief from available data
```

**Output:** Creates basic brief from chat history:
```json
{
  "sections": [
    {
      "type": "priorities",
      "title": "Getting Started",
      "items": [
        {"rank": 1, "title": "Explore Paprwork features"},
        {"rank": 2, "title": "Connect your tools when ready"}
      ]
    }
  ]
}
```

**Result:** Banner disappears, user sees it works (even if minimal)

### Scenario 2: Has Jobs But They're Empty

**User has Calendar Sync job but it hasn't run yet**

**Agent:**
```typescript
list_jobs() → Sees "Calendar Sync"
bash({ command: "sqlite3 calendar.db 'SELECT COUNT(*) FROM events'" })
→ Result: 0 (or only sample event)

// Agent generates brief WITHOUT calendar section
```

**Output:**
```json
{
  "sections": [
    {
      "type": "freeform",
      "content": "I see you have a Calendar Sync job but no events yet. It will auto-sync in the background. For now, here's what I know from our conversations..."
    },
    {"type": "priorities", ...}
  ]
}
```

**Result:** Brief works, gracefully notes calendar will populate later

### Scenario 3: Job Fails to Run

**Network error, API timeout, etc.**

**Button shows:**
```
[✗ Failed - Try Chat]
```

**User can:**
- Click to try again
- Or open chat and ask: "Why did the brief generation fail?"
- Agent: "Let me check the logs..." → Diagnoses issue

## Files Changed

**Created:**
- `docs/GENERATE_REAL_BRIEF_BUTTON.md` - This documentation

**Modified:**
- `src/resources/default-apps/home-dashboard/app.js`
  - Added `isSampleData` tracking
  - Added `generateRealBrief()` method
  - Added `renderSampleDataBanner()` method
  - Updated `init()` to detect sample data
  - Updated `render()` to show banner

- `src/resources/default-apps/home-dashboard/data.js`
  - Added `_isSample: true` flag to `sample()` method

- `src/resources/default-apps/home-dashboard/styles.css`
  - Added banner styles
  - Added button styles with loading states
  - Added animations

## Impact

### Before
- Users see sample data
- No obvious way to generate real data
- Had to ask agent in chat: "Update my home dashboard"
- Unclear what's sample vs real

### After
- Users see sample data with clear indication
- Obvious CTA: "Generate My Real Brief"
- One-click to trigger job
- Banner disappears once real data exists
- Seamless onboarding to real usage

## Alternative User Flows

### Option 1: Use Button (Recommended)
```
Open home → See sample data
Click "Generate My Real Brief"
Wait 5-30 seconds
Dashboard reloads with real brief
```

### Option 2: Use Chat
```
Open home → See sample data
Open new chat
Ask: "Generate my daily brief"
Agent runs job
Dashboard updates
```

### Option 3: Wait for Schedule
```
Open home → See sample data
Do nothing
Next day at 6 AM → Job runs automatically
Open home → See real brief
```

All three work! Button is just the fastest path.

## Should We Pre-Install a Calendar Sync Job?

**Yes!** Here's why and how:

### Problem with Current Approach

**Current:** Daily Brief job tries to access calendar every time it runs
- ❌ Slower (agent must detect + query each run)
- ❌ API rate limits (Google Calendar API)
- ❌ Authentication challenges (OAuth flow on each run)
- ❌ Inconsistent (works differently on macOS/Windows/Linux)

### Better Approach: Pre-Install Calendar Sync Job

**New:** Separate "Calendar Sync" job that runs every 15 minutes
- ✅ Faster (Daily Brief just reads from SQLite)
- ✅ No rate limits (data is cached locally)
- ✅ One-time OAuth setup
- ✅ Cross-platform (uses Google Workspace CLI)
- ✅ Works offline (last sync is still available)

### Recommended Architecture

```
Default Jobs (Pre-Installed)
├── Daily Brief Generator (6 AM daily)
│   └── Reads FROM: calendar.db, linkedin.db, crm.db, etc.
│
└── Calendar Sync (Every 15 minutes)
    └── Writes TO: $PAPR_HOME/Jobs/{calendarId}/data/calendar.db
```

### Calendar Sync Job Structure

**Location:** `src/resources/default-jobs/calendar-sync/`

**Files:**
- `job-id.txt` - UUID
- `metadata.json` - Job config
- `init-db.sql` - Schema for events table
- `README.md` - Setup instructions

**metadata.json:**
```json
{
  "id": "a1b2c3d4-...",
  "name": "Calendar Sync",
  "type": "agent",
  "command": "Sync my Google Calendar events for the next 7 days. Use Google Workspace CLI (gws) if installed, otherwise offer to install it. Store events in SQLite.",
  "schedule": {
    "enabled": true,
    "intervalMs": 900000
  },
  "isDefault": true
}
```

**init-db.sql:**
```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  summary TEXT,
  start_time TEXT,
  end_time TEXT,
  location TEXT,
  description TEXT,
  attendees TEXT,
  calendar_name TEXT,
  synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_start_time ON events(start_time);
```

**Agent Command:**
```
"Sync my Google Calendar events for the next 7 days. Use Google Workspace 
CLI (gws) if installed, otherwise offer to install it. Store events in SQLite 
with schema: id, summary, start_time, end_time, location, description, 
attendees, calendar_name, synced_at. Clear old events before inserting."
```

### First-Time Setup Flow

**User clicks "Generate My Real Brief":**

1. Daily Brief job runs
2. Agent checks: `list_jobs()` → Sees "Calendar Sync" job
3. Agent checks: `bash({ command: "sqlite3 calendar.db 'SELECT COUNT(*) FROM events'" })`
4. If empty:
   ```
   "I notice you have a Calendar Sync job but no events yet. 
   Would you like me to:
   1. Install Google Workspace CLI and connect your calendar
   2. Skip calendar and generate brief from chat history
   3. Guide you through manual calendar setup"
   ```
5. User chooses option 1
6. Agent installs gws: `bash({ command: "npm install -g @googleworkspace/cli" })`
7. Agent runs auth: `bash({ command: "gws auth login" })` → Opens browser
8. User authenticates
9. Calendar Sync job runs immediately: `run_job({ jobId: "calendar-sync" })`
10. Daily Brief job continues with calendar data now available

### Benefits

**Speed:**
- Daily Brief reads from SQLite: ~5ms
- vs API call: ~200-500ms

**Reliability:**
- Works offline (last sync available)
- No authentication on every brief generation
- Handles rate limits gracefully

**User Experience:**
- One-time calendar setup
- Auto-syncs in background
- Other apps can also read calendar data

**Cross-Platform:**
- Google Workspace CLI works on all platforms
- No AppleScript/PowerShell dependencies
- Consistent behavior everywhere

### Alternative: Meeting-Specific App

**Should we create a "Meetings" mini-app?**

**Option A: Generic Calendar Sync Job (Recommended)**
```
Calendar Sync Job
└── Stores all calendar events
    └── Used by: Daily Brief, Meetings App, other apps
```

**Option B: Meetings-Specific App (Alternative)**
```
Meetings App
├── Has its own calendar sync logic
├── Displays meetings in custom UI
└── Only useful for viewing meetings
```

**Verdict: Option A (Calendar Sync Job) is better**
- ✅ Reusable by all apps
- ✅ Single source of truth
- ✅ Centralized OAuth
- ✅ DRY principle

The Meetings App can be created later as a viewer that queries the Calendar Sync job's database.

### Implementation Plan

**Week 1: Calendar Sync Job**
1. Create `src/resources/default-jobs/calendar-sync/`
2. Add metadata.json with 15-min schedule
3. Add init-db.sql with events schema
4. Add to `installDefaultJobs()` in JobsService
5. Update Daily Brief to read from calendar.db

**Week 2: First-Run Setup**
1. Enhance Daily Brief to detect empty calendar.db
2. Add setup flow: "Install gws CLI?"
3. Auto-trigger calendar sync on first setup
4. Update docs with setup instructions

**Week 3: Optional Meetings App**
1. Create mini-app that displays calendar events
2. Add filters: today, week, month
3. Add meeting prep button (opens chat)
4. Link to Calendar Sync job database

---

**Summary:** Yes, we should pre-install a Calendar Sync job that runs every 15 minutes and stores events in SQLite. This makes the Daily Brief faster, more reliable, and cross-platform. The agent handles first-time Google Workspace CLI installation and OAuth setup automatically when the user clicks "Generate My Real Brief".
