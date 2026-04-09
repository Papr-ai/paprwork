# Job Folder → App Linking Fix - Summary

**Issue:** Mini-app filters, job graphs, AND database queries weren't working for jobs with matching folder names

**Root Cause:** 
1. Job graph `appLinks` only included explicitly linked data sources
2. Mini-apps couldn't query job databases without manual `link_app_data_source` calls

**Fix:** Implemented **automatic data source discovery** that:
1. Includes folder-matched jobs in UI filters and graphs
2. Auto-links job databases as data sources for querying

## The Real Problem

The issue wasn't just UI filtering - it was that mini-apps **couldn't query job databases** at all unless the agent explicitly called `link_app_data_source` for each job.

**Before:**
```
Jobs with folder="LinkedIn Autopilot": 7 jobs
LinkedIn Autopilot app filter shows: 0 jobs
App database queries: FAIL ("No data sources linked")
Agent must call link_app_data_source 7 times
```

**After:**
```
Jobs with folder="LinkedIn Autopilot": 7 jobs
LinkedIn Autopilot app filter shows: 7 jobs
App database queries: SUCCESS (auto-linked)
Agent just creates jobs + app, done!
```

## Implementation

### Part 1: UI Linking (Job Graph)

The graph builder now includes jobs from **two sources**:

1. **Explicit data sources** (existing) - From `data-sources.json`
2. **Folder matching** (new) - Jobs whose `folder` equals app `title`

### Part 2: Automatic Data Source Linking

Added `AppService.autoDiscoverDataSources()` method that:
- Finds all jobs with matching folder names
- Links their databases as data sources automatically
- Runs asynchronously after every graph rebuild

```typescript
// Auto-discovery runs after graph rebuild
for (const app of apps) {
  void appService.autoDiscoverDataSources(app.id).catch(err => {
    console.warn(`Auto-discovery failed for app ${app.id}:`, err);
  });
}
```

## Benefits

✅ **Zero manual linking** - Agent just uses matching folder names
✅ **Immediate data access** - Apps can query job databases right away  
✅ **Complete UI** - Filters and graphs show all related jobs
✅ **Backward compatible** - Explicit linking still works

## Example Workflow

**Before (7 tool calls + manual linking):**
```typescript
create_job({ folder: "CRM", ... }) // x7
create_app({ title: "CRM", ... })
link_app_data_source({ appId, jobId })  // x7 manual calls
```

**After (just 8 tool calls):**
```typescript
create_job({ folder: "CRM", ... }) // x7
create_app({ title: "CRM", ... })
// Done! All 7 databases auto-linked and queryable
```

## Files Changed

- `src/gateway/services/AppService.ts` - Added `autoDiscoverDataSources()` method
- `src/gateway/services/JobsService.ts` - Enhanced `rebuildGraph()` to trigger auto-discovery

## Testing

Restart the app to rebuild the job graph:

```bash
npm run build
npm start
```

Then verify:
1. Jobs filter shows all folder-matched jobs
2. App can query job databases without manual linking
3. Console shows: `[AppService] Auto-linked data source: {job} → {app}`

**Status:** ✅ Fixed (2026-04-01)

**See also:** `docs/AUTOMATIC_DATA_SOURCE_DISCOVERY.md` for complete technical details
