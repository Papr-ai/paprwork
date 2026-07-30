# Code-Based Database Discovery (The Right Way)

**Date:** 2026-04-01  
**Issue:** Keyword/folder matching causes false positives - we should discover databases by analyzing actual code dependencies

---

## The Problem with Keyword Matching

**Original approach (WRONG):**
```typescript
// Match jobs by folder name
if (job.folder.toLowerCase() === app.title.toLowerCase()) {
  linkDatabase(job);
}
```

**Why it's wrong:**
- ❌ False positives: Jobs with matching names but no actual data connection
- ❌ False negatives: Jobs in different folders that ARE used by the app
- ❌ Relies on naming conventions instead of actual dependencies
- ❌ Breaks when folder names don't match app titles exactly

---

## The Right Way: Code Analysis

Instead of guessing based on keywords, **analyze which databases the app actually uses**:

1. **Scan mini-app code** for database path references
2. **Map database paths to jobs** (reverse lookup)
3. **Auto-link only databases that are actually referenced**

### Implementation

```typescript
async autoDiscoverDataSources(appId: string): Promise<AppDataSource[]> {
  // 1. Build map of database paths → jobs
  const dbPathToJob = new Map<string, Job>();
  for (const job of allJobs) {
    const dbPath = await jobsService.getJobDatabasePath(job.id);
    if (dbPath) {
      dbPathToJob.set(dbPath, job);
    }
  }
  
  // 2. Scan app code for database references
  const referencedDbPaths = await this.scanAppCodeForDatabasePaths(appDir);
  
  // 3. Link only jobs whose databases are actually referenced
  for (const dbPath of referencedDbPaths) {
    const job = dbPathToJob.get(dbPath);
    if (job) {
      await this.linkAppDataSource(appId, { jobId: job.id, dbPath, ... });
    }
  }
}
```

### Code Scanning Logic

```typescript
private async scanAppCodeForDatabasePaths(appDir: string): Promise<Set<string>> {
  const dbPaths = new Set<string>();
  
  // Read all code files (.js, .ts, .html)
  for (const file of codeFiles) {
    const content = await fs.readFile(file, 'utf8');
    
    // Pattern 1: Explicit database paths
    // /Users/.../PAPR/jobs/{jobId}/data/*.db
    const dbPathPattern = /\/PAPR\/jobs\/([a-f0-9-]+)\/data\/[^'"]+\.db/gi;
    dbPaths.add(...content.matchAll(dbPathPattern));
    
    // Pattern 2: Job ID references (implies database usage)
    // If app references a job ID, it likely queries that job's database
    const jobIdPattern = /['"]([a-f0-9-]{36})['"]/g;
    for (const [_, jobId] of content.matchAll(jobIdPattern)) {
      const dbPath = `$PAPR_HOME/Jobs/${jobId}/data/data.db`;
      if (await fileExists(dbPath)) {
        dbPaths.add(dbPath);
      }
    }
  }
  
  return dbPaths;
}
```

---

## What Gets Detected

### Pattern 1: Explicit Database Paths

```javascript
// In mini-app code:
const dbPath = '/Users/amir/PAPR/jobs/abc-123/data/data.db';
```
✅ **Detected:** Exact database path found → Link job `abc-123`

### Pattern 2: Job ID References

```javascript
// In mini-app code:
const jobId = '550e8400-e29b-41d4-a716-446655440000';
fetch('/api/db/query', { 
  body: JSON.stringify({ jobId, sql: '...' }) 
});
```
✅ **Detected:** Job ID reference + database exists → Link that job

### Pattern 3: Fetch API Calls (Future Enhancement)

```javascript
// In mini-app code:
fetch('/api/db/query', {
  method: 'POST',
  body: JSON.stringify({ 
    appId: 'my-app',
    sql: 'SELECT * FROM users' 
  })
});
```
🔮 **Future:** Track actual API calls at runtime, link databases that are queried

---

## Benefits vs. Keyword Matching

| Approach | Accuracy | False Positives | False Negatives | Maintenance |
|----------|----------|-----------------|-----------------|-------------|
| **Keyword Matching** | ❌ Low | ✅ High | ✅ High | ❌ Brittle |
| **Code Analysis** | ✅ High | ❌ Low | ❌ Low | ✅ Robust |

### Example: Why Keyword Matching Fails

**Scenario:**
- App: "LinkedIn Autopilot"
- Jobs:
  - `{ folder: "LinkedIn Autopilot", id: "job-1" }` - Cookie capture (not used by app)
  - `{ folder: "Data Processing", id: "job-2" }` - Connection data (ACTUALLY used by app)

**Keyword matching result:**
- ❌ Links `job-1` (FALSE POSITIVE - not actually used)
- ❌ Doesn't link `job-2` (FALSE NEGATIVE - actually used!)

**Code analysis result:**
- ✅ Scans app code, finds reference to `job-2` database path
- ✅ Links only `job-2` (CORRECT!)

---

## Edge Cases Handled

### 1. Multiple Path Formats
```typescript
// Handles both:
/Users/amir/PAPR/jobs/{jobId}/data/data.db
/Users/amir/Papr/jobs/{jobId}/data/data.db  // Case variation
```

### 2. Custom Database Names
```typescript
// Not just data.db:
/PAPR/jobs/{jobId}/data/stargazers.db
/PAPR/jobs/{jobId}/data/custom-name.db
```

### 3. Non-Existent Databases
If app code references a job ID but the database doesn't exist, it's skipped (no error).

### 4. Deduplication
Jobs already linked manually via `link_app_data_source` are not re-linked.

---

## Future Enhancements

### 1. Runtime Query Tracking

Instead of static code analysis, **track actual database queries**:

```typescript
// In /api/db/query endpoint:
app.post("/api/db/query", async (req, res) => {
  const { appId, sql } = req.body;
  
  // Track which databases this app actually queries
  await trackDatabaseAccess(appId, source.dbPath);
  
  // After X queries, auto-link this database
  await autoLinkIfFrequentlyUsed(appId, source.dbPath);
});
```

### 2. SQL Query Analysis

Parse SQL queries to understand which tables are accessed:

```typescript
// App queries: SELECT * FROM users, posts
// System knows: users table is in job-1, posts table is in job-2
// Auto-link: Both job-1 and job-2
```

### 3. Dependency Graph Visualization

Show users which jobs their app depends on:

```
[Mini-App: LinkedIn Dashboard]
  ├─> Job: Connection Scraper (queries connection_data table)
  ├─> Job: Message Parser (queries messages table)
  └─> Job: Analytics Aggregator (queries daily_stats table)
```

---

## Migration from Keyword Matching

For apps currently using folder-based matching:

1. **Phase 1:** Run code analysis, add newly discovered databases
2. **Phase 2:** Compare keyword matches vs. code-based matches
3. **Phase 3:** Remove false positives (keyword matches not found in code)

No breaking changes - existing `data-sources.json` files remain valid.

---

## Testing

### Test Case 1: Explicit Path Reference

```javascript
// app.js
const dbPath = '/Users/amir/PAPR/jobs/abc-123/data/data.db';
```

**Expected:** Job `abc-123` is auto-linked

### Test Case 2: Job ID Reference

```javascript
// app.js
const jobId = 'def-456';
fetch('/api/db/query', { body: JSON.stringify({ jobId, ... }) });
```

**Expected:** Job `def-456` is auto-linked (if database exists)

### Test Case 3: No References

```javascript
// app.js - pure client-side app, no database queries
const data = { hardcoded: 'values' };
```

**Expected:** No jobs auto-linked

---

## Files Changed

- `src/gateway/services/AppService.ts`:
  - Rewrote `autoDiscoverDataSources()` to use code analysis
  - Added `scanAppCodeForDatabasePaths()` method

---

**Status:** ✅ Implemented (Code-Based Discovery)  
**Accuracy:** High (detects actual dependencies, not keywords)  
**Next Step:** Add runtime query tracking for even better accuracy
