# Default Jobs & Home App Setup

## What's Bundled

### 1. Default Jobs (2 jobs)

**Location:** `src/resources/default-jobs/`

#### Daily Brief Generator
- **ID:** `2cafb2e9-696b-42db-98fa-5d605977123c`
- **Type:** Agent job
- **Schedule:** Daily at 6 AM (`0 6 * * *`)
- **Database:** Empty SQLite with `briefs` table schema
- **Purpose:** Generates daily brief JSON for home dashboard

#### Weekly War Room — Orchestrator  
- **ID:** `6c840212-9cdc-4b2e-a3ae-951ee2f277a1`
- **Type:** Agent job
- **Schedule:** Manual (not enabled)
- **Database:** Empty SQLite
- **Purpose:** Manual orchestration job

### 2. Home Dashboard App

**Location:** `src/resources/default-apps/home-dashboard/`

- **ID:** `bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`
- **Title:** "Home"
- **Data Sources:** Both jobs linked via `data-sources.json`

## What Happens on First Launch

### Jobs Installation (`JobsService.installDefaultJobs()`)

1. **Reads** bundled jobs from `dist/resources/default-jobs/`
2. **For each job:**
   - Reads `job.json` to get configuration
   - Checks if job ID already exists (skip if yes)
   - **Copies** entire job folder to `~/Papr/Jobs/{jobId}/`
     - Includes: `job.json`, `code/`, `data/data.db`, `logs/`, `migrations/`
   - **Registers** job in `~/Papr/data/jobs.json`
   - **Resets** runtime fields (status → idle, clears errors/lastRunAt)
3. **Saves** jobs index to disk

### App Installation (`AppService.installDefaultApps()`)

1. **Reads** bundled apps from `dist/resources/default-apps/`
2. **For home dashboard:**
   - Copies app files to `~/Papr/apps/{appId}/`
   - **Includes pre-linked** `data-sources.json` with both jobs
   - Registers in `~/Papr/data/apps.json`

### Settings Defaults (`gateway/websocket/settings.ts`)

1. **Returns** `preferences.defaultHomeAppId` pointing to home dashboard
2. **Home button** → Opens home dashboard (not placeholder)
3. **HomeRedirect** → Redirects home tabs to dashboard app

## User Experience

### First Launch
1. App starts
2. Gateway initializes and installs default jobs + home app
3. User clicks home button → Home dashboard opens
4. Dashboard shows **sample data** (no briefs generated yet)
5. User clicks "Generate My Real Brief" → Job runs immediately
6. Dashboard refreshes with real brief

### Next Morning (6 AM)
1. Daily Brief job runs automatically
2. Generates brief JSON and saves to SQLite
3. Home dashboard shows fresh brief when opened

### No Configuration Needed
- ✅ Jobs already created
- ✅ Jobs already scheduled
- ✅ Jobs already linked to app
- ✅ App already set as home
- ✅ Database schema ready

## Bundle Sizes

- **Daily Brief job:** 44 KB
- **War Room job:** 212 KB
- **Home app:** 552 KB
- **Total resources:** 808 KB

## Files Changed

1. `src/gateway/services/JobsService.ts` - Updated `installDefaultJobs()` to read `job.json`
2. `src/gateway/websocket/settings.ts` - Added `preferences.defaultHomeAppId` to defaults
3. `src/resources/default-apps/home-dashboard/data-sources.json` - Both jobs linked
4. `src/resources/default-apps/home-dashboard/data.js` - Added `WHERE brief_json IS NOT NULL`
5. `src/resources/default-jobs/` - Added 2 production job folders

## Build Process

```bash
npm run build:gateway  # Copies src/resources → dist/resources
npm run dist:mac       # Packages into ASAR
```

The `electron-builder.json` already includes `src/resources/**/*` in files array.

## Testing

To test the installation flow:

```bash
# 1. Delete existing jobs and home app
rm -rf ~/Papr/Jobs/2cafb2e9-696b-42db-98fa-5d605977123c
rm -rf ~/Papr/Jobs/6c840212-9cdc-4b2e-a3ae-951ee2f277a1
rm -rf ~/Papr/apps/bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c

# 2. Remove from indexes
# Edit ~/Papr/data/jobs.json and remove both job entries
# Edit ~/Papr/data/apps.json and remove home app entry

# 3. Restart app
npm start

# 4. Check logs for:
# [JobsService] Registered default job: 2cafb2e9... - Daily Brief Generator
# [JobsService] Registered default job: 6c840212... - Weekly War Room — Orchestrator
# [JobsService] Installed and registered 2 default job(s)
# [AppService] Registered default app: bbb7e17e... - Home

# 5. Click home button → Should open dashboard with sample data
# 6. Click "Generate My Real Brief" → Should run job
# 7. Check ~/Papr/Jobs/ - both job folders should exist
```

## Known Issues

- Daily Brief job hitting context limits with GPT-5.4 (separate issue, not related to bundling)
- War Room job is manual-only (no schedule)

## Future Enhancements

1. Add more default jobs (Calendar Sync, Meeting Monitor, etc.)
2. Auto-create jobs on first run of related features
3. Job marketplace for downloading community jobs
4. Template jobs for common workflows
