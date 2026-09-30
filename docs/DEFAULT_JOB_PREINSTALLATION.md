# Default Job & Dashboard Pre-Installation

**Date:** 2026-04-07

## Overview

Fresh installations now come with:
1. **Pre-installed Daily Brief job** - Scheduled agent job that runs daily at 6 AM
2. **Pre-initialized SQLite database** - Contains sample brief data
3. **Pre-linked home dashboard** - Connected to the job's database
4. **Generic sample data** - No personal information, all fake

## What Users See on First Launch

### Home Dashboard Shows Real Data

When users click the home button, they see a **fully functional dashboard** with:

✅ **Sample brief for today**
- 4 meetings (Team Standup, Product Review, etc.)
- 1 external meeting (Sarah Chen - Acme Corp)
- Focus priorities (Q2 planning, follow-ups, ship feature)
- Weekly goals with progress bars
- Alerts and reminders
- Executive summary

✅ **Fully interactive**
- Can mark items complete
- Can mark items irrelevant
- Can chat with agent about any item
- Can navigate to previous/next days

✅ **Backend working**
- SQLite database: `$PAPR_HOME/Jobs/{jobId}/data/data.db`
- Briefs table with sample data
- Dashboard queries real database (not fallback)

### Sample Data (Generic/Fake)

**Meetings:**
- 9:00 AM - Team Standup `[internal]`
- 10:30 AM - Product Review `[internal]`
- 2:00 PM - Sarah Chen — Acme Corp `[external]`
  - Intel: Product Manager evaluating solutions
  - Angle: Focus on ease of use
  - The Ask: Schedule follow-up demo
- 3:30 PM - Sprint Planning `[internal]`

**Priorities:**
1. Complete Q2 planning (Strategic priorities due Friday)
2. Follow up with 3 prospects (Pipeline building)
3. Ship feature X (Committed to customers)

**Weekly Goals:**
- Customer calls: 3/5 (60% progress)
- Code reviews: 4/8 (50% progress)
- Documentation: 2/3 (67% progress)

**Alerts:**
- 🔴 Q2 planning deck due Friday
- 🟡 Team offsite next week — book venue

**Executive Summary:**
> This week is about execution and follow-through. The planning work matters, but so do the customer conversations. Don't let admin tasks crowd out the important stuff. Block focus time.

## Technical Implementation

### Default Job Structure

```
src/resources/default-jobs/daily-brief-generator/
├── job-id.txt          # Job UUID
├── metadata.json       # Job configuration  
└── init-db.sql         # Database schema + sample data
```

### Installation Flow

1. **On first app launch** → `JobsService.initialize()` runs
2. **Checks for default jobs** in `dist/resources/default-jobs/`
3. **For each default job:**
   - Reads `job-id.txt` to get job ID
   - Checks if job already exists (skip if yes)
   - Copies job files to `$PAPR_HOME/Jobs/{jobId}/`
   - Reads `metadata.json` for job configuration
   - Creates `JobRecord` and adds to registry
   - If `init-db.sql` exists:
     - Creates `$PAPR_HOME/Jobs/{jobId}/data/` directory
     - Creates `data.db` SQLite database
     - Executes init SQL script
   - Saves to `$PAPR_HOME/data/jobs.json`

4. **Home dashboard pre-linked:**
   - `data-sources.json` already contains link to job
   - Dashboard queries job's database automatically
   - Shows real data from SQLite (not sample fallback)

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS briefs (
  date TEXT PRIMARY KEY,
  brief_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**Sample data inserted:**
- One brief for today's date
- JSON structure matching dashboard schema
- Hero section + 5 content sections

### Job Configuration

**metadata.json:**
```json
{
  "id": "2cafb2e9-696b-42db-98fa-5d605977123c",
  "name": "Daily Brief Generator",
  "type": "agent",
  "command": "Generate comprehensive daily brief...",
  "schedule": {
    "enabled": true,
    "cron": "0 6 * * *"
  }
}
```

**Schedule:** Daily at 6:00 AM (agent generates fresh brief)

## User Experience

### Day 1 (First Launch)
- Install app
- Open home dashboard
- **See sample brief with today's date**
- All features work (mark complete, chat with agent, etc.)
- Job is scheduled to run tomorrow at 6 AM

### Day 2 (After First Run)
- Agent job runs at 6 AM
- Generates new brief based on user's actual data
- Dashboard shows real brief (or continues showing sample if agent has no data yet)

### Transition: Sample → Real Data

**Gradual evolution:**
1. **Day 1-7:** Sample data + agent learning about user
2. **Week 2+:** Agent generates real briefs based on:
   - Calendar integrations
   - Task management systems
   - CRM data
   - User's goals and priorities
3. **Dashboard seamlessly transitions** from sample → real data

## Testing

**Automated Test:** `npm run test:default-job`

**Coverage:**
- ✅ Job installation on fresh install
- ✅ Job registered in `jobs.json`
- ✅ Job directory and files copied
- ✅ SQLite database created
- ✅ Sample data inserted
- ✅ Idempotency (no duplicates)

**Manual Verification:**
```bash
# Check job exists
cat $PAPR_HOME/data/jobs.json | jq '.[] | select(.id == "2cafb2e9-696b-42db-98fa-5d605977123c")'

# Check database
sqlite3 $PAPR_HOME/Jobs/2cafb2e9-696b-42db-98fa-5d605977123c/data/data.db "SELECT date FROM briefs;"

# Check dashboard link
cat $PAPR_HOME/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c/data-sources.json
```

## Files Changed

### Created
- `src/resources/default-jobs/daily-brief-generator/job-id.txt`
- `src/resources/default-jobs/daily-brief-generator/metadata.json`
- `src/resources/default-jobs/daily-brief-generator/init-db.sql`
- `scripts/test-default-job-install.mjs`

### Modified
- `src/gateway/services/JobsService.ts`
  - Added ESM compatibility (`import.meta.url`)
  - Added `installDefaultJobs()` method
  - Called from `initialize()`
- `src/resources/default-apps/home-dashboard/data.js`
  - Updated sample data (generic instead of personal)
- `src/resources/default-apps/home-dashboard/data-sources.json`
  - Pre-linked to Daily Brief job
- `package.json`
  - Added `test:default-job` script
- `electron-builder.json`
  - Already includes `src/resources/**/*`

## Impact

### Before
- Home dashboard showed fallback sample data
- No backend database
- Users had to manually:
  - Create Daily Brief job
  - Link job to dashboard
  - Configure schedule
- First-time users saw placeholder

### After
- Home dashboard shows real data from SQLite
- Backend fully functional out of the box
- Users get working example immediately
- Zero configuration needed
- Professional first impression

## Future Enhancements

1. **Multiple default jobs:**
   - Weekly summary generator
   - Meeting prep assistant
   - Email digest generator

2. **Smart sample data:**
   - Detect user's timezone
   - Generate appropriate meeting times
   - Localize content

3. **Onboarding integration:**
   - "This is sample data - want to personalize it?"
   - One-click calendar connection
   - Auto-generate first real brief

4. **Template library:**
   - Sales dashboard
   - Engineering dashboard
   - Executive dashboard
   - Custom templates

## Related

- Issue 42: Default Home App Installation Fix
- Enhancement 27: Smart Default Provider & Bundled Home Dashboard
- Enhancement 26: Default Home App Configuration

---

**Summary:** Fresh installations now include a fully functional Daily Brief job with SQLite database and sample data, making the home dashboard work out of the box with zero configuration!
