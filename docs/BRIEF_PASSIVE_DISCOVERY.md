# Simplified Brief Generation - Passive Discovery Only

**Updated:** 2026-04-07

## Key Principle

**The Daily Brief job should be PASSIVE and SIMPLE:**
- ✅ Just works with whatever data already exists
- ✅ No setup prompts
- ✅ No package installation
- ✅ No configuration requests
- ✅ Discovers available jobs and uses their data
- ❌ Does NOT prompt for calendar setup
- ❌ Does NOT install Google Workspace CLI
- ❌ Does NOT ask for integrations

## Architecture

```
Daily Brief Job (Passive)
├── Discovers: list_jobs()
├── Checks: What data exists in job databases
├── Reads: Available data (calendar, LinkedIn, CRM, etc.)
├── Queries: Papr Memory (conversation history)
└── Generates: Brief from WHATEVER IS AVAILABLE
```

**Separation of Concerns:**
- **Daily Brief** = Passive reader, uses existing data
- **Calendar Sync** = Separate job user creates IF they want calendar
- **LinkedIn Sync** = Separate job user creates IF they want LinkedIn
- **User** = Decides what integrations to add via chat or app

## Agent Command

**Updated command in `metadata.json`:**
```json
{
  "command": "Generate a daily brief from available data. Check what jobs exist (list_jobs), what data they have, and use that to create a brief. Include: meetings (if calendar job exists), priorities (from chat history and goals), progress tracking (from other job data if available), and insights. If no external data exists, generate from our conversation history and stated goals. Format as JSON matching the dashboard schema."
}
```

## How It Works

### 1. Data Discovery (Passive)

```typescript
// Agent ONLY discovers, never prompts
list_jobs() → ["Daily Brief Generator", "Calendar Sync", "LinkedIn"]

// Check each job's database
for each job {
  bash({ command: "sqlite3 {jobPath}/data.db '.tables'" })
  
  if (hasData) {
    // Query relevant tables
    bash({ command: "sqlite3 {jobPath}/data.db 'SELECT ...'" })
  }
}

// Check Papr Memory
// Automatic - conversation history always available

// Check file system (optional)
bash({ command: "ls ~/Documents" })
→ If user has notes/files, read them
```

### 2. Brief Generation (Adaptive)

**The brief adapts to available data:**

**Week 1 (Fresh install - no jobs):**
```json
{
  "sections": [
    {
      "type": "priorities",
      "title": "Getting Started",
      "items": [
        {"rank": 1, "title": "Explore Paprwork"},
        {"rank": 2, "title": "Connect tools when ready"}
      ]
    },
    {
      "type": "freeform",
      "content": "Your brief will grow as you add integrations..."
    }
  ]
}
```

**Week 2 (User created Calendar Sync job):**
```json
{
  "sections": [
    {
      "type": "timeline",
      "title": "Today",
      "items": [...meetings from calendar.db...]
    },
    {
      "type": "priorities",
      "items": [...from chat history...]
    }
  ]
}
```

**Month 2 (Calendar + LinkedIn + CRM jobs):**
```json
{
  "sections": [
    {"type": "timeline", "items": [...with attendee intel...]},
    {"type": "priorities", "items": [...data-driven...]},
    {"type": "tracker", "items": [...real metrics...]},
    {"type": "intel", "items": [...from LinkedIn...]},
    {"type": "freeform", "content": "...strategic insights..."}
  ]
}
```

## User Journey

### Day 1: First Click

**User opens home dashboard** → Sees sample data + banner

**User clicks "Generate My Real Brief":**
1. Job runs
2. Agent discovers: No jobs exist yet
3. Agent uses: Chat history + Papr Memory
4. Agent generates: Minimal but real brief
5. Dashboard reloads with real (minimal) content
6. Banner disappears forever

**User sees:**
```
Daily Brief (Generated from our conversations)

Focus This Week
• Explore Paprwork features
• Set up your first automation

My Take
As you add jobs and integrations, this brief will become 
more personalized with calendar events, metrics, and insights.
```

### Week 1: Adding Calendar

**User opens chat:**
```
User: "I want my calendar in the daily brief"
Agent: "I can create a Calendar Sync job that:
- Syncs your Google Calendar every 15 minutes
- Stores events in SQLite
- Daily Brief will automatically include them
Would you like me to create it?"

User: "Yes"
Agent: [Creates Calendar Sync job, helps with OAuth setup]
```

**Next morning at 6 AM:**
- Calendar Sync runs (background, every 15 min)
- Daily Brief runs
- Agent discovers Calendar Sync job exists
- Agent reads calendar.db
- Agent includes meetings in brief
- User sees meetings automatically!

### Month 2: Full Automation

**User has multiple jobs:**
- Calendar Sync (every 15 min)
- LinkedIn Tracker (daily)
- CRM Sync (hourly)
- Email Digest (daily)

**Daily Brief automatically includes:**
- Timeline: Today's meetings with attendee context
- Intel: LinkedIn updates about meeting attendees
- Priorities: Ranked by CRM pipeline + email threads
- Tracker: Real metrics from job databases
- Insights: Strategic analysis of patterns

**User did NOTHING after initial job setup** - everything just works!

## What Separates From Calendar Sync

| Concern | Daily Brief | Calendar Sync Job |
|---------|-------------|-------------------|
| **Purpose** | Passive reader | Active syncer |
| **Setup** | None | User creates via chat |
| **Auth** | None | Google OAuth |
| **Scheduling** | 6 AM daily | Every 15 min |
| **Dependencies** | None | Google Workspace CLI |
| **Data** | Reads from others | Writes to calendar.db |
| **Prompts user** | Never | Only during initial setup |

## Benefits

**For Users:**
- ✅ Works immediately (even with no data)
- ✅ No setup friction on first use
- ✅ Grows naturally as they add integrations
- ✅ Clear separation: Brief = reader, Jobs = writers

**For Developers:**
- ✅ Simple, focused Daily Brief implementation
- ✅ No complex setup logic in brief job
- ✅ Calendar setup is separate, optional feature
- ✅ Easy to test (just mock available jobs)

**For Product:**
- ✅ Users see value immediately (button works!)
- ✅ Natural upgrade path (add jobs → richer briefs)
- ✅ No failed setup experiences
- ✅ Flexible (works with ANY job data)

## Examples

### Example 1: Fresh Install

**Available data:** Chat history only

**Brief generated:**
```json
{
  "hero": {
    "date": "Monday, April 7, 2026",
    "title": "Daily Brief",
    "subtitle": "Getting Started"
  },
  "sections": [
    {
      "type": "priorities",
      "title": "Focus Today",
      "items": [
        {
          "rank": 1,
          "title": "Explore Paprwork features",
          "why": "Learn what's possible with automation"
        }
      ]
    },
    {
      "type": "freeform",
      "title": "Welcome",
      "content": "Your daily brief will grow as you connect tools and create jobs. Start by asking me to create integrations you need!"
    }
  ]
}
```

### Example 2: Calendar Job Added

**Available data:** Chat history + Calendar Sync job with events

**Brief generated:**
```json
{
  "hero": {
    "date": "Monday, April 7, 2026",
    "title": "Daily Brief",
    "subtitle": "4 meetings · 1 external"
  },
  "sections": [
    {
      "type": "timeline",
      "title": "Today",
      "items": [
        {"time": "9:00", "title": "Team Standup", "tags": ["internal"]},
        {"time": "14:00", "title": "Client Call - Acme", "tags": ["external"]}
      ]
    },
    {
      "type": "priorities",
      "title": "Focus Today",
      "items": [
        {"rank": 1, "title": "Prep for Acme call", "why": "Important client"}
      ]
    }
  ]
}
```

### Example 3: Full Integration Suite

**Available data:** Chat + Calendar + LinkedIn + CRM + Email

**Brief generated:**
```json
{
  "hero": {
    "date": "Monday, April 7, 2026",
    "title": "Daily Brief",
    "subtitle": "4 meetings · 2 external · 3 action items"
  },
  "sections": [
    {
      "type": "timeline",
      "title": "Today",
      "items": [
        {
          "time": "14:00",
          "title": "Sarah Chen — Acme Corp",
          "tags": ["external"],
          "detail": {
            "Intel": "Product Manager at Acme. Posted about challenges with current solution.",
            "Angle": "Focus on ease of use and integration features.",
            "The Ask": "Demo next week with engineering team."
          }
        }
      ]
    },
    {
      "type": "priorities",
      "items": [
        {"rank": 1, "title": "Close Acme deal", "why": "$50K ARR, hot lead"},
        {"rank": 2, "title": "Follow up with 3 prospects", "why": "Warm leads from last week"}
      ]
    },
    {
      "type": "tracker",
      "items": [
        {"label": "Pipeline", "current": 5, "target": 10, "unit": "deals"},
        {"label": "Demos", "current": 3, "target": 5, "unit": "this week"}
      ]
    }
  ]
}
```

## Implementation

**File:** `src/resources/default-jobs/daily-brief-generator/metadata.json`

**Updated command:**
```json
{
  "command": "Generate a daily brief from available data. Check what jobs exist (list_jobs), what data they have, and use that to create a brief. Include: meetings (if calendar job exists), priorities (from chat history and goals), progress tracking (from other job data if available), and insights. If no external data exists, generate from our conversation history and stated goals. Format as JSON matching the dashboard schema."
}
```

**Key behaviors:**
- Uses `list_jobs()` to discover available data sources
- Queries SQLite databases from other jobs
- Accesses Papr Memory automatically
- Generates adaptive brief based on what's available
- NEVER prompts for setup
- NEVER installs packages
- NEVER asks for configuration

---

**Summary:** Daily Brief is now a **passive, adaptive reader** that generates briefs from whatever data exists. It works immediately on first use (even with no data) and grows richer as users add jobs. Calendar setup is a separate concern handled by Calendar Sync job (user creates via chat when ready). This keeps the brief simple, focused, and always functional.
