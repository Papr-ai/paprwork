# Using Existing Home App & Daily Brief Job

**Fixed:** 2026-04-07

## The Issue

I was creating NEW IDs for the home dashboard app and Daily Brief job in the bundled resources, when we should have been using YOUR EXISTING working versions:

**Existing (Working):**
- Home app ID: `bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`
- Daily Brief job ID: `2cafb2e9-696b-42db-98fa-5d605977123c`

**What I was creating (Wrong):**
- Generated new random UUIDs
- Would have created duplicate apps/jobs for new users
- Wouldn't match existing user setups

## The Fix

**Now using the SAME IDs across all installations:**

### 1. Home Dashboard App
- **ID**: `bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c` (your existing one)
- **Location**: `src/resources/default-apps/home-dashboard/`
- **Files**: All your working files (app.js, data.js, styles.css, etc.)
- **ID File**: `app-id.txt` contains the fixed UUID

### 2. Daily Brief Generator Job
- **ID**: `2cafb2e9-696b-42db-98fa-5d605977123c` (your existing one)
- **Location**: `src/resources/default-jobs/daily-brief-generator/`
- **Command**: Your working command (passive discovery with list_jobs)
- **ID File**: `job-id.txt` contains the fixed UUID

### 3. Data Sources Linking
```json
[{
  "id": "2cafb2e9-696b-42db-98fa-5d605977123c:Daily Brief Generator (2cafb2e9)",
  "type": "sqlite",
  "jobId": "2cafb2e9-696b-42db-98fa-5d605977123c",
  "alias": "Daily Brief Generator (2cafb2e9)",
  "dbPath": "",
  "tables": ["briefs"],
  "linkedAt": "2026-04-07T00:00:00.000Z"
}]
```

## Why This Matters

**Before (Wrong approach):**
```
Your machine: Home app ID = bbb7e17e...
New user download: Home app ID = abc123... (different!)
→ Inconsistent, couldn't share tips/docs with same IDs
```

**After (Correct approach):**
```
Your machine: Home app ID = bbb7e17e...
New user download: Home app ID = bbb7e17e... (same!)
→ Consistent, everyone has the same default apps
```

## Benefits

1. **Consistency**: Everyone's home app has the same ID
2. **Support**: Can reference "Open app bbb7e17e..." in docs
3. **No Duplicates**: Won't create multiple home apps
4. **Migration**: Your existing setup is now the standard

## For New Users

When they download and install Paprwork:

1. `AppService.installDefaultApps()` checks for `bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c`
2. If doesn't exist → Copies from `dist/resources/default-apps/home-dashboard/`
3. If already exists → Skips (idempotent)
4. Same for Daily Brief job: `2cafb2e9-696b-42db-98fa-5d605977123c`

## For Existing Users (You)

Nothing changes! Your apps/jobs already have these IDs, so:

1. `installDefaultApps()` runs
2. Checks: "Does `bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c` exist?"
3. Yes → Skips installation
4. Your existing setup remains untouched

## Command Changes

Your existing Daily Brief command is now the default, with one addition:

**Added:**
```
## IMPORTANT: PASSIVE DISCOVERY ONLY
- DO NOT prompt user to install packages
- DO NOT ask for calendar setup
- DO NOT request configuration
- JUST USE whatever data exists
```

This ensures the brief works for new users who don't have any jobs yet (generates from chat history).

## Files Changed

**Updated:**
- `src/resources/default-apps/home-dashboard/app-id.txt` - Set to `bbb7e17e...`
- `src/resources/default-jobs/daily-brief-generator/job-id.txt` - Set to `2cafb2e9...`
- `src/resources/default-jobs/daily-brief-generator/metadata.json` - Uses your working command
- `src/resources/default-apps/home-dashboard/data-sources.json` - Links to correct job ID

---

**Summary:** Now using YOUR existing working home app and Daily Brief job as the canonical versions that ship with all Paprwork installations. Everyone gets the same IDs, making support and documentation easier.
