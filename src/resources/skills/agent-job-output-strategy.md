# Agent Job Output Strategy Skill

Quick reference for choosing the right job output mode and delivery mechanism.

## When to Use Each Output Mode

### Natural Output
- **Use when:** Human will read the result
- **Examples:** Research summaries, code reviews, analysis reports
- **How:** Default mode, no configuration needed
- **Access:** Chat message or `read_job_logs`

### Structured Output
- **Use when:** Code will parse the result
- **Examples:** Data extraction, ETL pipelines, API responses
- **How:** Set `outputMode: "structured"` + `outputSchema: {...}`
- **Access:** `read_job_file({ jobId, filePath: "job.json" })` → parse `lastOutput`

**Consumption pattern:**
```python
# Python job reads agent job output
import json
from pathlib import Path

job_json = Path.home() / "Papr" / "jobs" / "agent-job-id" / "job.json"
data = json.loads(json.load(open(job_json))["lastOutput"])
# Process structured data...
```

### Tool-Based (Artifacts)
- **Use when:** Creating files, apps, or code
- **Examples:** Code generation, app creation, job templates
- **How:** Agent uses `write_file`, `create_app`, `bash` tools
- **Access:** Direct file system or job file tools

### SQLite Output
- **Use when:** UI will query/display data
- **Examples:** Dashboards, reports, monitoring, analytics
- **How:** Job writes via `writeDbIds` → `PAPR_DB_*`; app reads/writes via `/api/db/query` and `/api/db/write` with `sourceId`
- **Setup:** `create_database` → `attach_database` → `create_job({ writeDbIds: [dbId] })`
- **Access:** REST API `/api/db/query` or TableView component

### Live DB change events (SSE)

```typescript
import { subscribeJobEvents } from "/__papr__/papr-job-events.ts";

subscribeJobEvents({
  dbIds: ["db-abcdef12"],  // registry dbId from data-sources.json
  onDbChanged: () => loadData(),
});
```

Filter by `jobIds` for job-owned DBs, or `dbIds` for standalone/registry databases. Prefer `onDbChanged` over polling when jobs write to linked tables.

## Delivery Mechanisms

### Chat Delivery
```javascript
create_job({
  name: "Research Task",
  prompt: "...",
  deliver: {
    channel: "chat",
    targetId: currentChatId
  }
})
```
Result appears as assistant message in chat.

### Job Record Only
```javascript
create_job({
  name: "Background Task",
  prompt: "...",
  schedule: { cron: "0 9 * * *" }
  // No deliver = background execution
})
```
Access later via `read_job_logs` or `/api/jobs/:id`.

### Memory Writeback
```javascript
create_job({
  name: "Important Research",
  prompt: "...",
  memoryPolicy: "summary"  // or "full"
})
```
Builds knowledge base for future reference.

## Sub-Agent Context Rules

**CRITICAL:** Sub-agents run in isolated sessions. They CANNOT:
- ❌ Access main conversation history
- ❌ Ask user questions mid-execution
- ❌ See other sub-agent results

**Always include in `context`:**
- File paths (absolute or ~/relative)
- User preferences/constraints
- Expected output format
- All relevant context

**Example:**
```javascript
delegate_task({
  task: "Review authentication code",
  context: `
    File: ~/project/auth.js
    User concern: Login slow (3-5s)
    Current: bcrypt rounds=15
    Focus: Performance + security
    Expected: < 500ms login time
  `,
  reportChatId: currentChatId
})
```

## Quick Decision Tree

```
User-facing text?
  → Natural + deliver: { channel: "chat" }

Code will parse it?
  → Structured + downstream job reads lastOutput

Creating artifacts?
  → Tool-based (write_file, create_app)

UI needs to query?
  → SQLite — `create_database` → `attach_database` → `create_job({ writeDbIds })`

Needs specialization?
  → delegate_task with complete context
```

## Common Patterns

### Pattern 1: Extract → Transform → Load
```javascript
// 1. Agent extracts (structured)
create_job({
  name: "extract",
  outputMode: "structured",
  outputSchema: {...}
})

// 2. Python processes
create_job({
  name: "transform",
  type: "python",
  command: "python3 etl.py"
  // etl.py reads extract job output
})

// 3. Link to UI
link_app_data_source({
  appId: "dashboard",
  jobId: "transform"
})
```

### Pattern 2: Research → Summarize → Chat
```javascript
// 1. Sub-agent researches
delegate_task({
  task: "Research competitors",
  context: "Focus on pricing and features"
})

// 2. Main agent synthesizes
// Uses result.data.resultText

// 3. Delivers to user
// Natural conversation continues
```

### Pattern 3: SQLite → App → User
```python
# Job writes to SQLite
db.execute("""
  CREATE TABLE IF NOT EXISTS metrics (
    date TEXT PRIMARY KEY,
    value REAL
  )
""")
```

```javascript
// Link to app
link_app_data_source({ appId: "metrics-dashboard", jobId: "metrics-job" })

// App queries via REST
fetch('/api/db/query', {
  method: 'POST',
  body: JSON.stringify({
    appId: "metrics-dashboard",
    sql: "SELECT * FROM metrics ORDER BY date DESC LIMIT 30"
  })
})
```

## See Also

- `AGENT_JOB_OUTPUT_GUIDE.md` - Complete reference
- `DELEGATION_STRATEGY.md` - Sub-agent patterns
- `APP_AND_JOBS_GUIDE.md` - Apps and jobs architecture
