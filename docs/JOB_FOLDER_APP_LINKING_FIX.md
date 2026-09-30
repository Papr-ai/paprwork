# Job Folder → App Linking Fix

**Date:** 2026-04-01
**Issue:** Jobs with folder names matching mini-app titles weren't showing in app filters or graph views

---

## Problem

When creating jobs with a `folder` field that matches a mini-app's title (e.g., `folder: "LinkedIn Autopilot"`), those jobs were **not** appearing when:
1. Clicking the "LinkedIn Autopilot" filter chip in the Jobs view
2. Viewing the job graph filtered by that app

The user could see all the jobs when viewing "All Jobs" and scrolling, but the app filter showed only a subset.

### Root Cause

The job graph's `appLinks` data structure was built **only** from explicit data source links (`data-sources.json` files). Jobs were only included in an app's job list if they were explicitly linked via `addAppDataSource()`.

Jobs using the `folder` field for organizational grouping were separate from the app linking mechanism.

### Example Scenario

```typescript
// User creates jobs via agent
create_job({
  name: "LinkedIn Connection Sender",
  type: "node",
  folder: "LinkedIn Autopilot",  // ← Folder grouping
  schedule: { enabled: true, intervalMs: 180000 }
})

// User creates app
create_app({
  title: "LinkedIn Autopilot",  // ← Same name as folder
  icon: "🔗",
  ...
})
```

**Expected:** All jobs in "LinkedIn Autopilot" folder appear when filtering by LinkedIn Autopilot app

**Actual:** Only jobs explicitly linked via `data-sources.json` appear (often none or just a few)

---

## Solution

Enhanced `rebuildGraph()` method in `JobsService.ts` to build `appLinks` from **two sources**:

1. **Explicit data source links** (existing behavior)
   - Jobs linked via `addAppDataSource()` 
   - Stored in `$PAPR_HOME/apps/{appId}/data-sources.json`

2. **Folder name matching** (new behavior)
   - Jobs whose `folder` field matches an app's `title` (case-insensitive)
   - Automatic discovery without explicit linking

### Implementation

```typescript
// JobsService.ts - rebuildGraph()
const appLinks: Record<string, JobGraphAppLink> = {};
try {
  const appService = getAppService();
  await appService.initialize();
  const apps = await appService.listApps();
  
  for (const app of apps) {
    const linkedJobIds = new Set<string>();
    
    // 1. Include explicit data source links
    try {
      const dataSources = await appService.listAppDataSources(app.id);
      for (const ds of dataSources) {
        linkedJobIds.add(ds.jobId);
      }
    } catch {
      // skip apps with no data sources
    }
    
    // 2. Include jobs with matching folder names (NEW)
    const appTitleLower = app.title.toLowerCase();
    for (const job of jobs) {
      if (job.folder && job.folder.toLowerCase() === appTitleLower) {
        linkedJobIds.add(job.id);
      }
    }
    
    if (linkedJobIds.size > 0) {
      appLinks[app.id] = { name: app.title, jobIds: [...linkedJobIds] };
    }
  }
} catch {
  // AppService not yet initialized — skip app links this rebuild
}
```

---

## Impact

### Before Fix
- **All Jobs view:** Shows all 7 jobs (scrolling works)
- **LinkedIn Autopilot filter:** Shows 0-2 jobs (only explicitly linked)
- **Job graph for app:** Shows incomplete dependency graph

### After Fix
- **All Jobs view:** Shows all 7 jobs (unchanged)
- **LinkedIn Autopilot filter:** Shows all 7 jobs in "LinkedIn Autopilot" folder
- **Job graph for app:** Shows complete dependency graph with all related jobs

### Use Case Example

**LinkedIn Autopilot** mini-app with jobs:
```
✅ LinkedIn Auth — Cookie Capture (folder: "LinkedIn Autopilot")
✅ LinkedIn Autopilot DB Setup (folder: "LinkedIn Autopilot")
✅ LinkedIn Chrome Manager (folder: "LinkedIn Autopilot")
✅ LinkedIn Connection Sender (folder: "LinkedIn Autopilot")
✅ LinkedIn Message Sender (folder: "LinkedIn Autopilot")
✅ LinkedIn Campaign Optimizer (folder: "LinkedIn Autopilot")
✅ LinkedIn Connection Tracker (folder: "LinkedIn Autopilot")
```

**Before:** Clicking "LinkedIn Autopilot" chip → Shows 0-2 jobs (maybe just Auth + DB Setup if explicitly linked)

**After:** Clicking "LinkedIn Autopilot" chip → Shows all 7 jobs

---

## Benefits

1. ✅ **Intuitive behavior:** Jobs organized by folder automatically appear in app with matching title
2. ✅ **No breaking changes:** Explicit data source links still work (backward compatible)
3. ✅ **Flexible linking:** Can use folder-based OR explicit linking OR both
4. ✅ **Agent-friendly:** Agents naturally use `folder` field when creating related jobs
5. ✅ **Graph completeness:** Job dependency graphs show full picture for apps

---

## Folder vs. Data Source Linking

### When to Use Folder Linking (Automatic)
- Jobs are created **together** as a group
- All jobs belong to **one app/workflow**
- Folder name matches app title
- **Example:** LinkedIn Autopilot (7 jobs, 1 app)

### When to Use Explicit Data Source Linking
- Job is shared across **multiple apps**
- Job belongs to **different folder** than app title
- Need custom labeling in data sources
- **Example:** Shared "Email Sender" job used by multiple apps

### Both Work Together
```typescript
// Job with folder "CRM"
{ id: "job-1", folder: "CRM", ... }

// CRM app explicitly links job-2 from different folder
addAppDataSource("crm-app-id", { jobId: "job-2", label: "Email Job" })

// Result: CRM app shows both jobs
// - job-1 (via folder matching)
// - job-2 (via explicit link)
```

---

## Testing

### Manual Test Procedure

1. **Create jobs with folder:**
   ```typescript
   create_job({ name: "Job A", folder: "TestApp", ... })
   create_job({ name: "Job B", folder: "TestApp", ... })
   create_job({ name: "Job C", folder: "TestApp", ... })
   ```

2. **Create app with matching title:**
   ```typescript
   create_app({ title: "TestApp", ... })
   ```

3. **Verify filter:**
   - Go to Jobs view
   - Click "TestApp" chip
   - **Expected:** All 3 jobs visible

4. **Verify graph:**
   - Switch to graph view
   - Click "TestApp" chip
   - **Expected:** All 3 jobs visible in graph

5. **Test case-insensitive matching:**
   ```typescript
   create_job({ name: "Job D", folder: "testapp", ... })  // lowercase
   ```
   - **Expected:** Job D also appears in TestApp filter

### Automated Test (Future)

```typescript
describe("Job folder → app linking", () => {
  it("should include jobs with matching folder in app links", async () => {
    // Create app
    const app = await appService.createApp({ title: "Test App", ... });
    
    // Create job with matching folder
    const job = await jobsService.createJob({ 
      name: "Test Job", 
      folder: "Test App",
      ...
    });
    
    // Rebuild graph
    await jobsService.rebuildGraph();
    
    // Verify app links include job
    const graph = await jobsService.getJobGraph();
    expect(graph.appLinks[app.id].jobIds).toContain(job.id);
  });
  
  it("should be case-insensitive", async () => {
    const app = await appService.createApp({ title: "Test App", ... });
    const job = await jobsService.createJob({ folder: "test app", ... });
    const graph = await jobsService.getJobGraph();
    expect(graph.appLinks[app.id].jobIds).toContain(job.id);
  });
});
```

---

## Files Changed

- `src/gateway/services/JobsService.ts` - Enhanced `rebuildGraph()` method
- `docs/JOB_FOLDER_APP_LINKING_FIX.md` - This documentation

---

## Related Issues

- **Enhancement 22:** Mini-App Job Creation API (jobs created via `/api/jobs/create` also benefit)
- **Enhancement 30:** Default Home App Configuration (home dashboards now show all jobs correctly)

---

## Future Enhancements

1. **Fuzzy matching:** Match "linkedin-autopilot" folder with "LinkedIn Autopilot" app (handle hyphens, underscores)
2. **Multi-folder apps:** Support apps matching multiple folder patterns (e.g., "CRM Core" + "CRM Reports")
3. **UI indicator:** Show which jobs are linked via folder vs. explicit data sources
4. **Agent guidance:** Update system prompt to mention folder-based linking as best practice

---

**Fix Applied:** 2026-04-01
**Testing:** Manual verification with LinkedIn Autopilot app (7 jobs)
**Status:** ✅ Complete - All folder-based jobs now appear in app filters and graphs
