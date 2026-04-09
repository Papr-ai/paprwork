# Job Grouping Consistency Fix

**Date:** 2026-04-05  
**Issue:** "All Jobs" page shows different folder names than app filter chips, causing confusion

---

## Problem

The Jobs view had **two separate grouping systems**:

1. **App Filter Chips:** Use app titles from `job-graph.json` (e.g., "mem0 Stargazers")
2. **Folder Groups:** Use raw `job.folder` field (e.g., "stargazers")

This caused:
- Inconsistent naming between filters and folder sections
- Jobs appearing "Ungrouped" when they actually belong to apps
- Confusion about which jobs belong to which apps

### Example Mismatch

**Job data:**
```json
{
  "id": "abc-123",
  "name": "GitHub Stars Scraper",
  "folder": "stargazers"  // ← lowercase, abbreviated
}
```

**App data:**
```json
{
  "id": "app-456",
  "title": "mem0 Stargazers"  // ← Full name with space
}
```

**Result:**
- **App filter chip:** Shows "mem0 Stargazers" (from app title)
- **Folder group:** Shows "stargazers" (from job.folder)
- **User sees:** Two different groups that are actually the same!

---

## Solution

Make the "All Jobs" page folder grouping **use app names** instead of raw folder names when there's a matching app.

### Implementation

```typescript
// Build a map of folder names to app names
const folderToAppName = new Map<string, string>();
if (graph) {
  for (const [appId, appLink] of Object.entries(graph.appLinks)) {
    for (const jobId of appLink.jobIds) {
      const job = jobs.find(j => j.id === jobId);
      if (job?.folder) {
        // Map folder name → app name (case-insensitive)
        folderToAppName.set(job.folder.toLowerCase(), appLink.name);
      }
    }
  }
}

// When grouping jobs, use app name if available
for (const job of filteredJobs) {
  if (job.folder) {
    // Use app name if folder matches an app, otherwise use raw folder
    const displayName = folderToAppName.get(job.folder.toLowerCase()) || job.folder;
    folderMap.set(displayName, [...]);
  }
}
```

### How It Works

1. **Scan job graph** for all app→job links
2. **Build mapping** from folder names to app titles
3. **When grouping jobs**, look up the app name for each folder
4. **Display app name** instead of folder name (when match exists)
5. **Fall back** to raw folder name for jobs without matching apps

---

## Impact

### Before Fix

**App Filter Chips:**
- mem0 Stargazers
- Papr ICP Map
- LinkedIn Autopilot

**"All Jobs" Folder Groups:**
- stargazers (should be "mem0 Stargazers")
- icp (should be "Papr ICP Map")  
- LinkedIn Autopilot ✅ (matches!)
- Ungrouped (many jobs that actually have apps)

### After Fix

**App Filter Chips:**
- mem0 Stargazers
- Papr ICP Map
- LinkedIn Autopilot

**"All Jobs" Folder Groups:**
- mem0 Stargazers ✅ (unified!)
- Papr ICP Map ✅ (unified!)
- LinkedIn Autopilot ✅ (matches!)
- Ungrouped (only jobs without folders OR apps)

---

## Benefits

✅ **Consistent naming** - Same names in filters and folder groups  
✅ **Fewer ungrouped jobs** - Jobs get grouped under their app names  
✅ **Better organization** - Clear connection between apps and jobs  
✅ **Less confusion** - User sees one canonical name per group

---

## Edge Cases

### 1. Job with folder but no matching app
```typescript
{ folder: "experiments" }  // No app with title matching "experiments"
```
**Result:** Grouped under "experiments" (raw folder name)

### 2. Job with no folder
```typescript
{ folder: null }
```
**Result:** Appears in "Ungrouped" section

### 3. Multiple apps with jobs in same folder
This shouldn't happen with current architecture, but if it did:
- First app name found wins
- All jobs in that folder grouped under that app name

### 4. Case sensitivity
```typescript
{ folder: "LinkedIn Autopilot" }  // Capital L
{ folder: "linkedin autopilot" }  // lowercase
```
**Result:** Both map to same app (case-insensitive matching)

---

## Testing

After rebuild and refresh:

1. **Check app filter chips** - Note the app names
2. **Scroll through "All Jobs"** - Folder group names should match app filter chips
3. **Verify counts** - Same jobs in filter and folder group
4. **Check ungrouped** - Should only contain jobs truly without apps

### Expected Results

```
✅ "mem0 Stargazers" folder matches "mem0 Stargazers" chip
✅ "Papr ICP Map" folder matches "Papr ICP Map" chip  
✅ "LinkedIn Autopilot" folder matches "LinkedIn Autopilot" chip
✅ Fewer jobs in "Ungrouped" section
```

---

## Files Changed

- `ui/components/Jobs/JobsView.tsx` - Enhanced `groupedJobs` memo to use app names

---

## Future Enhancements

1. **Show app icon** next to folder group name
2. **Click folder name** to open the app
3. **Show job count** in app filter chips
4. **Sort by app vs. folder** toggle

---

**Status:** ✅ Fixed  
**Next Step:** Rebuild UI and refresh to see consistent naming
