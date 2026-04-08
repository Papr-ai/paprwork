# Home Dashboard - Fresh Installation Content

## What Users See on First Launch

When users open the home dashboard for the first time (no jobs/data linked), they see **sample data** demonstrating what the dashboard looks like when populated.

### Visual Layout

```
┌─────────────────────────────────────────────────────────┐
│  [< Prev]                            [Next >]            │
│                                                          │
│              Monday, April 7, 2026                       │
│                  Daily Brief                             │
│        5 meetings · 2 external · 3 action items          │
│                                                          │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                          │
│  📅 Today                                                │
│  ┌────────────────────────────────────────────────┐    │
│  │ 8:00  Weekly Ops Review            [internal]  │    │
│  │ 9:30  Papr Daily                   [internal]  │    │
│  │ 11:30 Papr × Techstars             [internal]  │    │
│  │ 12:00 Eric & Zachary — Perficient [external]  │    │
│  │       Intel: Large digital consultancy...      │    │
│  │ 1:30  Ajay Sharma                  [external]  │    │
│  └────────────────────────────────────────────────┘    │
│                                                          │
│  🎯 Focus This Week                                      │
│  ┌────────────────────────────────────────────────┐    │
│  │ 1. Close Capital One → pilot                   │    │
│  │    Highest-leverage. Demo Monday.              │    │
│  │ 2. DeepTrust → enterprise tier                 │    │
│  │    Active customer. Review Tuesday.            │    │
│  │ 3. 5 new discovery calls                       │    │
│  │    Pipeline building with better ICP.          │    │
│  └────────────────────────────────────────────────┘    │
│                                                          │
│  📊 OKR Alignment                                        │
│  ┌────────────────────────────────────────────────┐    │
│  │ Deep dive calls          2/5 ████░░░░░░         │    │
│  │ Discovery calls          1/5 ██░░░░░░░░         │    │
│  │ Paprwork feedback        2/5 ████░░░░░░         │    │
│  └────────────────────────────────────────────────┘    │
│                                                          │
│  🔔 Don't Forget                                         │
│  ┌────────────────────────────────────────────────┐    │
│  │ 🔴 Capital One demo Monday — prep agent memory │    │
│  │    → Build demo flow tonight                   │    │
│  │ 🟡 DeepTrust review dashboard exists           │    │
│  │    → Open Partnership Review app               │    │
│  └────────────────────────────────────────────────┘    │
│                                                          │
│  💭 My Take                                              │
│  ┌────────────────────────────────────────────────┐    │
│  │ This week is about conversion, not discovery.  │    │
│  │ Capital One is warm, DeepTrust is using the   │    │
│  │ product. Capital One is your best pilot shot. │    │
│  │ Prep that demo tonight.                        │    │
│  └────────────────────────────────────────────────┘    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## Content Shown (Sample Data)

### 1. Hero Section
- **Date:** Today's date (dynamically generated)
- **Title:** "Daily Brief"
- **Stats:** 
  - 5 meetings
  - 2 external
  - 3 action items

### 2. Timeline Section ("Today")
**5 sample meetings:**
1. **8:00 AM** - Weekly Ops Review `[internal]`
2. **9:30 AM** - Papr Daily `[internal]`
3. **11:30 AM** - Papr × Techstars `[internal]`
4. **12:00 PM** - Eric Immermann & Zachary Fischer — Perficient `[external]`
   - **Intel:** Large digital consultancy — potential channel partner
   - **Angle:** Position Papr as infra for their AI practice
   - **The Ask:** Propose joint pilot with one enterprise client
5. **1:30 PM** - Ajay Sharma `[external]`
   - **Intel:** Discovery call. No prior history
   - **Angle:** Paprwork if non-technical, Memory if engineering leader
   - **The Ask:** Qualify ICP fit. Book deep dive or demo

### 3. Priorities Section ("Focus This Week")
**3 sample priorities:**
1. **Close Capital One → pilot**
   - Why: Highest-leverage. Warm intro made. Demo Monday.
2. **DeepTrust → enterprise tier**
   - Why: Active customer. Partnership review Tuesday.
3. **5 new discovery calls**
   - Why: Pipeline building with better ICP targeting.

### 4. Tracker Section ("OKR Alignment")
**3 sample trackers:**
1. **Deep dive calls:** 2/5 calls (40% progress)
   - Context: Capital One Mon + DeepTrust Tue = 4
2. **Discovery calls:** 1/5 /week (20% progress)
   - Context: Ajay today, Firas Wed, 3 more needed
3. **Paprwork feedback:** 2/5 users (40% progress)
   - Context: Need 3 more sessions this week

### 5. Alerts Section ("Don't Forget")
**2 sample alerts:**
1. 🔴 **High priority:** Capital One demo Monday — prep agent memory walkthrough
   - Action: Build demo flow tonight
2. 🟡 **Medium priority:** DeepTrust review dashboard exists — check before Tue
   - Action: Open Partnership Review app

### 6. Freeform Section ("My Take")
**Sample executive summary:**
> **This week is about conversion, not discovery.** Capital One is warm, DeepTrust is already using the product, Verify is in play. _Capital One is your best pilot shot._ Prep that demo tonight.

## Data Source Configuration

**File:** `data-sources.json`
```json
[]
```

**Status:** Empty (no jobs linked yet)

**Behavior:**
- Dashboard tries to query: `SELECT brief_json FROM briefs WHERE date=...`
- Query fails (no database linked)
- **Falls back to `Data.sample()`** which returns the hardcoded sample data above

## Interactive Features (Even with Sample Data)

### 1. Card Hover Actions
Each card shows interactive buttons on hover:
- **✓ Mark complete** - Mark item as done
- **✗ Mark irrelevant** - Dismiss item
- **✎ Edit note** - Add clarification
- **↶ Undo** - Restore dismissed item
- **✨ Chat with agent** - Opens new chat with context

### 2. Fold Navigation
- **< Prev button** - Navigate to previous day's brief
- **> Next button** - Navigate to next day's brief
- Shows peek preview of adjacent days

### 3. Agent Integration
Clicking the sparkle icon (✨) on any card opens a new chat with:
- **Meeting cards:** "Help me prepare for [meeting]"
- **Priority cards:** "Help me with [priority]"
- **Tracker cards:** "Show progress on [metric]"
- **Alert cards:** "Help me address [alert]"

## How It Becomes Real Data

### User's Journey

1. **First launch:** See sample data (demonstrates functionality)

2. **User asks agent:**
   > "Can you create a job that generates my daily brief?"

3. **Agent creates job:**
   - Job type: Agent job (scheduled)
   - Schedule: Daily at 6 AM
   - Creates SQLite database: `~/Papr/Jobs/{jobId}/data/data.db`
   - Table: `briefs (date TEXT, brief_json TEXT)`
   - Generates first brief

4. **User links job to app:**
   > "Link the daily brief job to my home dashboard"
   
   **OR agent does it automatically**

5. **Dashboard shows real data:**
   - `data-sources.json` now contains job link
   - Dashboard queries actual database
   - Shows user's real meetings, priorities, OKRs

### Sample → Real Data Transition

**Before (sample):**
```json
data-sources.json: []
Dashboard queries → fails → shows sample data
```

**After (linked to job):**
```json
data-sources.json: [{
  "id": "job-123:Daily Brief",
  "type": "sqlite",
  "jobId": "job-123",
  "dbPath": "~/Papr/Jobs/job-123/data/data.db",
  "tables": ["briefs"]
}]
Dashboard queries → succeeds → shows real data
```

## Design Philosophy

### Why Show Sample Data?

1. **Demonstrates Value Immediately**
   - Users see what's possible before setting up
   - Clear "before/after" comparison
   - Reduces time to "aha moment"

2. **Sets Expectations**
   - Shows dashboard structure
   - Demonstrates data format
   - Makes setup goals clear

3. **No Empty State Anxiety**
   - Never shows blank dashboard
   - Always looks professional
   - Encourages users to populate with real data

4. **Interactive Learning**
   - Users can click around sample data
   - Test agent integration features
   - Understand workflow before committing

### Visual Design

**Aesthetic:** Liquid glass + ambient orbs
- Frosted glass cards with backdrop blur
- Animated gradient orbs in background
- Smooth hover interactions
- Clean typography with visual hierarchy

**Color Coding:**
- `[internal]` tags - Blue/neutral
- `[external]` tags - Highlighted/emphasized
- 🔴 High priority alerts
- 🟡 Medium priority alerts
- 🟢 Low priority alerts

## Future Enhancements

1. **Multiple sample templates** - Sales, Engineering, Executive, etc.
2. **"Try with your data" onboarding** - Guide to link first job
3. **Smart suggestions** - "This looks like sample data. Want to connect real data?"
4. **Template library** - Pre-built job templates for common use cases
5. **One-click setup** - "Generate my daily brief" button that creates job automatically

---

**Summary:** Fresh installations show a beautiful, fully-populated dashboard with **realistic sample data** that demonstrates the dashboard's capabilities. Users see exactly what they'll get once they link their own data sources, making the value proposition immediately clear.
