# How the Agent Discovers and Uses Data

## Yes - It's Tool-Based Discovery!

The agent **discovers data sources through tools**. It doesn't have a magical database of everything - it uses tools to explore and find what's available.

## Discovery Flow

### 1. Initial Discovery Tools

**First thing the agent does when asked about data:**

```typescript
// Agent calls these tools to discover what exists:
list_jobs()        // Returns ALL jobs with names, types, status, paths
list_apps()        // Returns ALL mini-apps with titles, IDs
bash({ command: "ls ~/Papr/jobs/" })  // Browse job directories
```

**Example output:**
```javascript
list_jobs() → {
  jobs: [
    {
      id: "2cafb2e9-696b-42db-98fa-5d605977123c",
      name: "Daily Brief Generator",
      type: "agent",
      status: "idle",
      schedule: { cron: "0 6 * * *" },
      path: "~/Papr/jobs/2cafb2e9-696b-42db-98fa-5d605977123c"
    },
    {
      id: "abc-123",
      name: "LinkedIn Scraper",
      type: "python",
      status: "completed",
      path: "~/Papr/jobs/abc-123"
    }
  ]
}
```

### 2. Database Discovery

**Once the agent knows a job exists, it explores its database:**

```typescript
// Method 1: Read job's database file directly
bash({ 
  command: "sqlite3 ~/Papr/jobs/{jobId}/data/data.db '.tables'"
})
// → Returns: briefs  meetings  priorities

// Method 2: Check schema
bash({
  command: "sqlite3 ~/Papr/jobs/{jobId}/data/data.db '.schema briefs'"
})
// → Returns: CREATE TABLE briefs (date TEXT, brief_json TEXT, ...)

// Method 3: Sample data
bash({
  command: "sqlite3 ~/Papr/jobs/{jobId}/data/data.db 'SELECT * FROM briefs LIMIT 1'"
})
// → Returns: 2026-04-07|{"hero":{...}}|2026-04-07 06:00:00
```

### 3. Mini-App Data Source Discovery

**For mini-apps, the agent checks what databases are linked:**

```typescript
read_app_data_sources({ appId: "home-dashboard-id" })
// → Returns:
{
  sources: [
    {
      id: "2cafb2e9:Daily Brief",
      jobId: "2cafb2e9-696b-42db-98fa-5d605977123c",
      dbPath: "~/Papr/jobs/.../data.db",
      tables: ["briefs"],
      alias: "Daily Brief Generator"
    }
  ]
}
```

## Agent's Mental Model

### When User Asks: "Update my home dashboard"

**Agent's thought process:**

1. **"What's the home dashboard?"**
   ```typescript
   list_apps() → Find app with title="Home"
   ```

2. **"What data does it use?"**
   ```typescript
   read_app_data_sources({ appId: "home-id" })
   → Sees: Daily Brief job linked
   ```

3. **"What's in that job's database?"**
   ```typescript
   bash({ command: "sqlite3 .../data.db '.tables'" })
   → Sees: briefs table
   ```

4. **"What's the data structure?"**
   ```typescript
   bash({ command: "sqlite3 .../data.db 'SELECT * FROM briefs LIMIT 1'" })
   → Sees: JSON with hero, sections, etc.
   ```

5. **"What does the dashboard code expect?"**
   ```typescript
   read_app_file({ appId: "home-id", filename: "app.js" })
   → Sees: Data.load() expects { hero: {...}, sections: [...] }
   ```

6. **Now the agent knows:**
   - Dashboard queries `briefs` table
   - Expects JSON format: `{ hero, sections }`
   - Job generates this data daily at 6 AM
   - Can update by modifying the agent job's command

## Available Tools for Data Discovery

### Jobs
```typescript
list_jobs()              // See all jobs
read_job_logs({ jobId }) // Check job output
get_job_history({ jobId }) // See run history
get_job_stats({ jobId })   // Success rate, duration
```

### Apps
```typescript
list_apps()                        // See all apps
read_app_data_sources({ appId })   // See linked databases
read_app_file({ appId, filename }) // Read app code
```

### Direct Data Access
```typescript
bash({ command: "sqlite3 {path} 'SELECT ...'" })  // Query any database
bash({ command: "cat ~/Papr/data/jobs.json" })    // Read job registry
bash({ command: "ls ~/Papr/jobs/" })              // Browse job directories
```

### File System
```typescript
read_file({ path: "~/Papr/jobs/{id}/code/main.py" })  // Read job code
list_files({ path: "~/Papr/jobs/{id}/" })             // List job files
bash({ command: "find ~/Papr -name '*.db'" })         // Find databases
```

## Discovery Patterns

### Pattern 1: "What data do I have?"

**User:** "What data sources do I have access to?"

**Agent:**
```typescript
1. list_jobs() → See all jobs
2. For each job with SQLite:
   bash({ command: "sqlite3 {path} '.tables'" })
3. Returns: "You have 3 jobs with databases:
   - Daily Brief: briefs table
   - LinkedIn Scraper: profiles, messages tables  
   - CRM Sync: companies, contacts, deals tables"
```

### Pattern 2: "Can you show me X?"

**User:** "Show me my LinkedIn data"

**Agent:**
```typescript
1. list_jobs() → Find "LinkedIn Scraper" job
2. bash({ command: "sqlite3 {path} '.tables'" })
   → See: profiles, messages tables
3. bash({ command: "sqlite3 {path} 'SELECT * FROM profiles LIMIT 5'" })
   → See sample rows
4. create_app({ 
     title: "LinkedIn Explorer",
     html: "table showing profiles..."
   })
5. link_app_data_source({
     appId: "new-app-id",
     jobId: "linkedin-scraper-id"
   })
```

### Pattern 3: "Update the dashboard"

**User:** "Add a new section to my home dashboard"

**Agent:**
```typescript
1. list_apps() → Find home dashboard
2. read_app_data_sources({ appId: "home-id" })
   → See: Daily Brief job linked
3. read_app_file({ appId: "home-id", filename: "app.js" })
   → Understand current structure
4. bash({ command: "sqlite3 {path} '.schema briefs'" })
   → Understand database schema
5. Decision: Add new section type or modify existing?
6. edit_app_file({ appId: "home-id", filename: "app.js", ... })
   → Add new section rendering
```

## What the Agent Knows vs. Discovers

### ❌ Agent Does NOT Know in Advance:
- What jobs the user has created
- What databases exist
- What tables are in those databases
- What apps are installed
- What data sources apps are linked to
- The user's actual data

### ✅ Agent DOES Know:
- How to use tools to discover the above
- The patterns and schemas it should look for
- How jobs and apps work architecturally
- Default installations (knows Daily Brief job exists)

### 🎯 Agent LEARNS During Conversation:
- User's workflows and preferences
- Available data sources (via list_jobs)
- Database schemas (via bash + sqlite3)
- App structure (via read_app_file)
- What data the user cares about

## Default Job Special Case

### The ONE Exception: Daily Brief Job

**The agent DOES know** about the pre-installed Daily Brief job because:

1. **It's documented in the system prompt:**
   ```
   "Default installations include a Daily Brief Generator job 
    scheduled to run at 6 AM daily..."
   ```

2. **The agent can assume it exists:**
   ```typescript
   // Agent can skip list_jobs() for default job
   read_job_logs({ 
     jobId: "2cafb2e9-696b-42db-98fa-5d605977123c" 
   })
   ```

3. **But still validates with tools:**
   ```typescript
   // Best practice: always verify
   list_jobs() → Confirm Daily Brief exists
   → If missing: Create it
   → If exists: Use it
   ```

## Example: Complete Discovery Flow

**User:** "Can you analyze my sales data and create a dashboard?"

**Agent's discovery process:**

```typescript
// Step 1: What jobs exist?
list_jobs()
→ Returns: ["Daily Brief", "LinkedIn Scraper", "Email Digest"]
→ Agent: "Hmm, no sales job yet"

// Step 2: What about databases?
bash({ command: "find ~/Papr/jobs -name '*.db'" })
→ Returns: 3 databases (brief, linkedin, email)
→ Agent: "No sales database"

// Step 3: Do they have a CRM?
bash({ command: "ls ~/Papr/apps" })
→ Returns: home-dashboard only
→ Agent: "No existing sales app"

// Step 4: Ask user or explore more?
→ Agent: "I don't see any sales data yet. Do you have:
   - A CRM system I can connect to?
   - Sales data in spreadsheets?
   - An existing database I should know about?"

// Step 5: User responds
User: "I have HubSpot CRM data"

// Step 6: Agent builds pipeline
create_job({ 
  name: "HubSpot Sync",
  type: "python",
  command: "python sync_hubspot.py",
  requirements: ["hubspot-api"],
  schedule: { cron: "0 */6 * * *" }  // Every 6 hours
})

// Step 7: Run and verify
run_job({ jobId: "hubspot-job-id", wait: true })
bash({ command: "sqlite3 {path} '.tables'" })
→ Returns: companies, deals, contacts

// Step 8: Create dashboard
create_app({
  title: "Sales Dashboard",
  html: "...",
  javascript: "..."
})

// Step 9: Link data
link_app_data_source({
  appId: "sales-dashboard-id",
  jobId: "hubspot-job-id"
})
```

## Summary

### Discovery is Tool-Driven

**The agent uses tools to:**
1. ✅ List existing jobs/apps
2. ✅ Explore job directories
3. ✅ Query databases to understand schemas
4. ✅ Read app code to understand data needs
5. ✅ Check what's linked to what

**The agent does NOT:**
- ❌ Have a master list of all user data
- ❌ Know database schemas without checking
- ❌ Automatically know what apps need
- ❌ See data without querying

### Pre-Installed Default Job

**Special case:**
- Daily Brief job is pre-installed (agent knows this)
- Has sample data in SQLite from day 1
- Home dashboard pre-linked to it
- Agent can assume it exists (but should verify)

**Everything else:**
- User creates via conversation
- Agent discovers via tools
- Agent learns data structure as it goes

---

**Key Insight:** The agent is **exploratory and tool-driven**, not omniscient. It discovers data by calling `list_jobs()`, reading files with `bash`, querying databases with `sqlite3`, and reading app code. The only exception is the default Daily Brief job which it knows about from the system prompt.
