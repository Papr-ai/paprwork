# App & Jobs Guide (V2)

Complete guide for building mini-apps, jobs, and app+job pipelines in Paprwork V2.

## The Golden Rule

> **Mock the UI first, show the user, get approval, THEN build the backend.**
> **Test each piece independently before connecting them.**

## Default Stage Flow

1. **Prototype UI** — Build a thin mockup with placeholder data (`create_app`). Make sure you use the Liquid Glass Design System skill when designing the app. Align on outcomes and states.
2. **Validate upstream data** — Run small API/data probes with `bash` before committing schema. Inspect actual field names, pagination, auth constraints.
3. **Define contracts** — Lock SQLite write model (what jobs produce) and read model (what the app queries). Add indexes for app query paths.
4. **Implement jobs** — Create with `create_job`, execute with `run_job`, inspect with `read_job_logs`. Adjust schema based on observed outputs.
5. **Wire app to data** — Link with `link_app_data_source`. Validate end-to-end with realistic records across all UX states.

If the task is tiny and explicit, merge steps. Always explain tradeoffs when skipping discovery.

---

## V2 Tools Reference

| Tool | Purpose |
|------|---------|
| `list_apps` | List all existing mini-apps (ALWAYS call this first!) |
| `create_app` | Create a mini-app with HTML/CSS/JS files |
| `read_app_file` | Read app file content with line numbers |
| `edit_app_file` | Edit via string replacement (simple text changes) |
| `edit_app_file_lines` | Edit via line ranges (RECOMMENDED for code) |
| `list_app_files` | List all files in an app |
| `list_jobs` | List all jobs with status, deps, dir path (call before create!) |
| `create_job` | Create a job with retries, dependencies, delivery |
| `update_job` | Patch job config (command, requirements, schedule, deps) |
| `delete_job` | Remove a job from the index (optionally wipe files) |
| `run_job` | Execute a job and inspect output |
| `read_job_logs` | Read job execution logs |
| `list_job_files` / `read_job_file` / `edit_job_file` | Browse and patch job scripts directly |
| `link_app_data_source` | Wire app to job's SQLite database |
| `read_app_data_sources` | List linked data sources for an app |
| `export_app_bundle` | Package app + jobs + schemas as portable app bundle |
| `import_app_bundle` | Install app bundle from local path or GitHub URL |
| `list_app_bundles` | List all installed app bundles |
| `get_app_bundle_info` | Preview app bundle contents without importing |

**Mini-App REST APIs** (called with `fetch()` from within the app — no auth, same-origin):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/db/schema?appId=ID` | GET | List linked SQLite tables & columns |
| `/api/db/query` | POST | **Read only** — `SELECT` / `WITH ... SELECT` on linked SQLite (INSERT/UPDATE/DELETE → **403**) |
| `/api/db/write` | POST | **Writes** — `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `UPSERT` on linked SQLite (`?` + `params` required for values) |
| `/api/db/exec` | POST | **DDL** — only `CREATE TABLE IF NOT EXISTS ...` (safe schema bootstrap) |
| `/api/jobs/list` | GET | List all jobs (id, name, type, status) |
| `/api/jobs/status/:jobId` | GET | Poll job status |
| `/api/jobs/run` | POST | Trigger a job (fire-and-forget or wait) |
| `/api/jobs/create` | POST | **NEW:** Create jobs programmatically (same as `create_job` tool) |
| `/api/bash/run` | POST | Run a bash command and get stdout/stderr |

> **When a button in a mini-app needs to do backend work** (re-generate content, reset data, call an API, run a script) — use `/api/jobs/run` or `/api/bash/run`. These give mini-apps the same power agents have via `run_job` and `bash`. Do NOT build a separate HTTP server job as a bridge — that is always the wrong approach.

> **NEW: Mini-apps can now CREATE jobs dynamically via `/api/jobs/create`**. This enables lazy job creation patterns (e.g., LinkedIn Autopilot creates action jobs on-demand when campaigns need them). Rate limited to 10 jobs/min per app. See "Mini-App Job Creation" section below.

> **CRITICAL:** If a mini-app needs to **INSERT/UPDATE/DELETE**, use **`POST /api/db/write`**, not `/api/db/query`. A 403 on `/api/db/query` means you used the read endpoint for a write — switch endpoints; **writes from apps are supported.**

---

## Verifying the Gateway API (do this before concluding an endpoint doesn't exist)

The Paprwork gateway is a real Express REST server running at `http://localhost:18789`. All API routes return **JSON**. The SPA catch-all returns `index.html` only for unknown paths.

**Critical diagnostic rule: if you `fetch()` an API path and get back HTML, you hit the SPA catch-all. That means the route doesn't exist — NOT that there is no API.**

Before building any workaround, verify the gateway is alive:

```javascript
// Always check /health first
const res = await fetch('/health');
const body = await res.json(); // → { status: "ok", timestamp: 1234567890 }
```

If `/health` returns JSON, the gateway is running and the API works. Then test the specific endpoint:

```javascript
// This always returns JSON (not HTML):
const res = await fetch('/api/jobs/list');
const { jobs } = await res.json(); // → { jobs: [...], count: N }
```

### ❌ Never do these when you need mini-app → backend communication

```javascript
// WRONG: building a separate HTTP server job as a bridge
create_job({ name: "regen-bridge", type: "node", command: "node bridge-server.js" })
// → fragile, port conflicts, extra process to manage, completely unnecessary

// WRONG: writing request files and polling them
window.__papr_write_file(...)   // doesn't exist
localStorage.setItem('regenRequest', threadId)  // agent can't read localStorage

// WRONG: hitting an unknown path and assuming there's no API when you get HTML
fetch('/api/regen') // → HTML (SPA catch-all) → "no REST API" (WRONG conclusion)

// WRONG: using webview_execute to test or inject API calls into a live app
webview_launch_app({ appId })
webview_execute({ script: "fetch('/api/jobs/run', ...)" })  // ← DO NOT do this
// → webview_execute is for visual inspection only, not for wiring up API calls
// → just edit the app source file directly — no need to verify via webview first
```

### ✅ Always do this instead

```javascript
// RIGHT: use the built-in gateway APIs directly in app code
fetch('/api/jobs/run', { method: 'POST', body: JSON.stringify({ jobId: 'my-job' }) })
fetch('/api/bash/run', { method: 'POST', body: JSON.stringify({ command: 'sqlite3 ...' }) })
fetch('/api/db/query', { method: 'POST', body: JSON.stringify({ appId, sql }) })
fetch('/api/db/write', { method: 'POST', body: JSON.stringify({ appId, sql, params }) })
```

### ✅ Testing endpoints before wiring them into the app

If you want to verify an endpoint works before writing app code, use `bash` with `curl` — NOT `webview_execute`. The gateway is just localhost:

```bash
# Verify gateway is up
curl -s http://localhost:18789/health

# Test /api/jobs/list
curl -s http://localhost:18789/api/jobs/list | python3 -m json.tool

# Test /api/jobs/run (fire-and-forget)
curl -s -X POST http://localhost:18789/api/jobs/run \
  -H 'Content-Type: application/json' \
  -d '{"jobId":"YOUR_JOB_ID"}' | python3 -m json.tool

# Test /api/bash/run
curl -s -X POST http://localhost:18789/api/bash/run \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo hello"}' | python3 -m json.tool

# Test /api/db/query
curl -s -X POST http://localhost:18789/api/db/query \
  -H 'Content-Type: application/json' \
  -d '{"appId":"YOUR_APP_ID","sql":"SELECT COUNT(*) FROM threads"}' | python3 -m json.tool
```

Or as a one-liner Node script if you prefer:

```bash
node -e "
fetch('http://localhost:18789/api/jobs/list')
  .then(r => r.json())
  .then(d => console.log(JSON.stringify(d, null, 2)))
"
```

**Rule:** use `bash` + `curl` to test, then write the working code into the app. Never use `webview_execute` for this — it's for visual inspection only.

---

## Editing App Files: Which Tool to Use?

### Use `edit_app_file_lines` (RECOMMENDED for most edits)

**When:** Making any code changes — HTML structure, JavaScript functions, CSS blocks

**Why:** Line-based editing is more reliable:
- No string matching issues (line numbers are unambiguous)
- Works with special characters, escape sequences, whitespace
- Better error messages show exactly what went wrong
- Tells you how line numbers shifted after the edit

**Workflow:**
```javascript
// 1. Read file to see line numbers
read_app_file({ appId: "abc-123", filename: "index.html" })
// Returns numbered lines like: "45|    <div class='old-structure'>..."

// 2. Replace lines 45-60 with new structure
edit_app_file_lines({
  appId: "abc-123",
  filename: "index.html",
  startLine: 45,
  endLine: 60,
  newContent: `    <div class="new-structure">
      <span>Updated content</span>
    </div>`
})

// Returns: { linesRemoved: 16, linesAdded: 3, netChange: -13, tip: "..." }
```

### Use `edit_app_file` (Only for simple text replacements)

**When:** Changing a simple string value, URL, or variable that appears once

**Why:** Faster for obvious one-off changes like:
- Updating an API endpoint URL
- Changing a hardcoded value
- Replacing a class name that appears in one place

**Workflow:**
```javascript
// Quick replacement - no line numbers needed
edit_app_file({
  appId: "abc-123",
  filename: "app.js",
  oldString: "const API_URL = 'http://localhost:3000'",
  newString: "const API_URL = 'http://localhost:18789'"
})
```

**⚠️ Limitations:**
- Fails if string doesn't match exactly (including whitespace)
- Replaces only first occurrence
- Poor error messages when string not found
- Doesn't handle escape sequences well

### Decision Tree

```
Need to edit app file?
├─ Changing HTML structure / JS function / CSS block?
│  └─ Use edit_app_file_lines (read file first for line numbers)
├─ Replacing simple text that appears once?
│  └─ Use edit_app_file (if you know exact string)
└─ Complex multi-step refactor?
   └─ Use bash with sed/awk OR multiple edit_app_file_lines calls
```

---

## How Mini-Apps Read from SQLite Databases

Mini-apps are static HTML/JS/CSS served from `http://localhost:18789/apps/<appId>/`. Because they run on the **same origin** as the gateway, they can freely `fetch()` the gateway's REST API — including a built-in SQLite query endpoint.

### Step 1 — Link the data source

```javascript
// Agent calls this tool after the job has run:
link_app_data_source({ appId: "...", jobId: "..." })
```

### Step 2 — Inspect the schema (optional)

```javascript
// App or agent can call:
const res = await fetch('/api/db/schema?appId=APP_ID');
const { sources } = await res.json();
// sources[0].tables → [{ table: "threads", columns: [...] }]
```

### Step 3 — Query in app JavaScript

```javascript
// Anywhere in the app's .ts / .js files:
async function loadData() {
  const res = await fetch('/api/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: 'APP_ID_HERE',          // hardcode the appId
      sql: 'SELECT * FROM threads ORDER BY score DESC LIMIT 50',
      // sourceId: 'alias'           // optional — picks first source if omitted
      // params: [value1, value2]    // optional — bound params for ? placeholders
    })
  });
  const { rows, columns, count } = await res.json();
  return rows;
}
```

### Security rules enforced by the gateway

- **`/api/db/query` is read-only**: only `SELECT` and `WITH ... SELECT`. Any INSERT/UPDATE/DELETE on this route returns HTTP 403 — use **`POST /api/db/write`** for mutations.
- **`/api/db/write`**: only `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `UPSERT`; bound parameters required for user-supplied values.
- **Scoped**: only databases registered via `link_app_data_source` for that specific `appId` are accessible.
- **No path traversal**: the db path is taken from the stored data-source record, not from the request.

### Full working pattern

```typescript
// app.ts — reads from linked SQLite job database
const APP_ID = 'your-app-id-here';

interface Thread { id: number; title: string; score: number; subreddit: string; }

async function fetchThreads(): Promise<Thread[]> {
  const res = await fetch('/api/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: APP_ID,
      sql: 'SELECT id, title, score, subreddit FROM threads ORDER BY score DESC LIMIT 100'
    })
  });
  if (!res.ok) {
    const err = await res.json() as { error: string };
    throw new Error(err.error);
  }
  const data = await res.json() as { rows: Thread[] };
  return data.rows;
}
```

### ❌ What does NOT work

```javascript
// WRONG — no such endpoint, don't try this:
fetch('/api/data/query', ...)
fetch('/query', ...)
// Node.js imports don't work in browser JS:
import Database from 'better-sqlite3'  // ❌ browser can't use Node modules
```

## How Mini-Apps Trigger Jobs

Mini-apps can trigger backend jobs directly — the same capability the agent has via `run_job`. Use this when a user clicks a button that needs to kick off real work (re-generate a draft, refresh data, process a file, etc.).

### Three layers of job environment — don't confuse them

| Layer | What it is | How it's set | When available |
|-------|-----------|-------------|----------------|
| **Job paths** | `$JOB_DIR`, `$JOB_DB` | Set automatically by Paprwork | Always, every job, automatically |
| **API keys** | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. | User keychain → gateway env | Always, every job, automatically |
| **Job config env** | `SUBREDDIT=python`, `MODE=production` | `create_job` / `update_job` command or env | Every run of this job |
| **Runtime params** | `THREAD_ID=abc123`, `ACTION=regen` | `params` field in `/api/jobs/run` | This invocation only — not persisted |

**Job path variables (ALWAYS use these instead of hardcoded paths):**
- `$JOB_DIR` — the job's own directory (e.g. `~/Papr/jobs/{jobId}`). Use for accessing job files: `$JOB_DIR/data/data.db`, `$JOB_DIR/code/script.py`, etc.
- `$JOB_DB` — shortcut to the job's SQLite database (`$JOB_DIR/data/data.db`)
- These are set as real env vars for command jobs (bash/python/node/swift) and injected into the prompt for agent/subagent jobs
- **NEVER hardcode absolute paths** like `/Users/john/PAPR/jobs/...` in job commands — always use `$JOB_DIR` or `$JOB_DB`

Runtime params are passed as env vars to the job process for that single run. In Python: `os.environ['THREAD_ID']`. In bash: `$THREAD_ID`.

### Available endpoints (all same-origin, no auth needed)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/jobs/list` | List all jobs with id, name, type, status |
| `GET` | `/api/jobs/status/:jobId` | Poll the status of one job |
| `POST` | `/api/jobs/run` | Trigger a job (with optional runtime params) |

### Passing runtime params to a job

```typescript
// The app passes THREAD_ID to the job for this specific run
await fetch('/api/jobs/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jobId: 'reddit-draft-replies',
    params: { THREAD_ID: threadId, ACTION: 'regen' }
  })
});
```

The job reads them as standard env vars:

```python
# Python job (code/main.py)
import os
thread_id = os.environ.get('THREAD_ID')
action = os.environ.get('ACTION', 'draft')  # default to 'draft'
```

```bash
# Bash job
THREAD_ID=${THREAD_ID:-}  # read runtime param
ACTION=${ACTION:-draft}
```

This solves the "I need to regen a specific thread" problem cleanly — no file bridges, no polling, no watcher jobs needed.

### Preferred pattern: WebSocket push (no polling)

The gateway broadcasts a `jobs:status-changed` event over WebSocket the instant any job completes, fails, or starts. Mini-apps can open their own WebSocket connection to `ws://localhost:18789` and react immediately — no polling loop needed.

```typescript
const JOB_ID = 'your-job-id-here';  // hardcode the job id

// Set up WebSocket listener once on app load
function subscribeToJobEvents(onJobComplete: (jobId: string) => void): WebSocket {
  const ws = new WebSocket('ws://localhost:18789');
  ws.onmessage = (e: MessageEvent) => {
    const msg = JSON.parse(e.data as string) as {
      type: string;
      data?: { jobId: string; status: string; error?: string };
    };
    if (
      msg.type === 'jobs:status-changed' &&
      (msg.data?.status === 'completed' || msg.data?.status === 'failed')
    ) {
      onJobComplete(msg.data.jobId);
    }
  };
  ws.onerror = () => console.warn('WebSocket error — will not receive job push events');
  return ws;
}

// In your app initialisation:
subscribeToJobEvents((completedJobId) => {
  if (completedJobId === JOB_ID) {
    loadData();   // re-query /api/db/query and re-render
  }
});

async function triggerRegen(): Promise<void> {
  const res = await fetch('/api/jobs/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: JOB_ID })
  });
  if (!res.ok) throw new Error((await res.json() as { error: string }).error);
  // Done — WebSocket listener above will call loadData() when job finishes
}
```

### Fallback: polling (use only if WebSocket is unavailable)

```typescript
async function pollJobStatus(
  jobId: string,
  timeoutMs: number
): Promise<{ status: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(`/api/jobs/status/${jobId}`);
    const job = await res.json() as { status: string; error?: string };
    if (job.status === 'completed' || job.status === 'failed') return job;
  }
  return { status: 'timeout' };
}
```

### Wait-for-completion (short jobs only, <30s)

```typescript
const res = await fetch('/api/jobs/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jobId: JOB_ID, wait: true })
});
const { status, error } = await res.json() as { status: string; error?: string };
```

### UI pattern: button with loading state

```typescript
let isRunning = false;

async function handleRegenClick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  updateButton('⏳ Thinking...');

  try {
    await triggerRegen();
    await loadData();     // re-query linked SQLite source
    render();             // refresh UI
  } catch (err) {
    showError((err as Error).message);
  } finally {
    isRunning = false;
    updateButton('↺ Regen');
  }
}
```

### How to design jobs for mini-app triggering

When a job will be called from a button click:
1. **Make it idempotent** — running it twice on the same input should produce the same result
2. **Write output to SQLite** — app re-queries the linked source after completion
3. **Keep it fast** — aim for <30s. Long jobs should update a `status` column in SQLite so the app can show incremental progress
4. **Pass context via the job's script** — if the job needs to know _which_ item to process (e.g. a thread ID), store that in a `requests` table in the job's SQLite DB that the app can INSERT into before triggering the job

### Passing parameters to a job via SQLite

Since `/api/jobs/run` doesn't accept runtime parameters (jobs are fully configured at creation time), use the job's own SQLite database as the message channel:

```typescript
// App writes the request into the job's DB before triggering it
// Step 1: app uses /api/db-write to insert a request row (see bash pattern below)
// Step 2: app calls /api/jobs/run
// Step 3: job reads the pending request row, processes it, updates status
```

Or use `/api/bash/run` (below) to do a targeted SQL write directly.

---

## How Mini-Apps Run Bash Commands

For quick one-off backend calls — resetting a DB row, calling a CLI tool, writing a file — mini-apps can run bash commands directly. This is the same capability the agent has via the `bash` tool.

```
POST /api/bash/run
body: { command: string, timeoutMs?: number }
returns: { stdout: string, stderr: string, exitCode: number }
```

**Timeout:** defaults to 30s, capped at 120s. Use this for quick commands only.

### Example: write a request row to a job's SQLite DB

```typescript
async function writeRegenRequest(threadId: string): Promise<void> {
  const dbPath = `${process.env.HOME}/PAPR/jobs/JOB_ID/data/data.db`;
  const sql = `INSERT OR REPLACE INTO regen_requests (thread_id, status, created_at)
               VALUES ('${threadId}', 'pending', datetime('now'))`;

  const res = await fetch('/api/bash/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: `sqlite3 "${dbPath}" "${sql}"` })
  });
  const { exitCode, stderr } = await res.json() as { exitCode: number; stderr: string };
  if (exitCode !== 0) throw new Error(stderr);
}
```

### Example: full regen flow using bash + job trigger

```typescript
const JOB_ID = 'reddit-draft-replies';
const DB_PATH = `/Users/YOUR_USER/PAPR/jobs/${JOB_ID}/data/data.db`;

async function regenReply(threadId: string): Promise<void> {
  // 1. Mark thread as needing re-draft (reset status in DB)
  await fetch('/api/bash/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: `sqlite3 "${DB_PATH}" "UPDATE threads SET status='selected', draft=NULL WHERE id='${threadId}'"`
    })
  });

  // 2. Trigger the existing draft job
  await fetch('/api/jobs/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: JOB_ID })
  });

  // 3. Poll for completion and refresh UI
  await pollJobStatus(JOB_ID, 60_000);
  await loadData();
}
```

### Using custom keys in `/api/bash/run`

**NEW:** Mini-apps can access custom keys from Settings → API Keys using `${KEY_NAME}` syntax (same as jobs):

```typescript
// app.ts - Query Neon PostgreSQL database
async function loadUsers() {
  const res = await fetch('/api/bash/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'psql "${NEON_DB_URL}" -t -A -F, -c "SELECT id, name, email FROM users LIMIT 10"'
    })
  });
  
  const { stdout, exitCode, stderr } = await res.json();
  if (exitCode !== 0) {
    console.error('Query failed:', stderr);
    throw new Error('Database query failed');
  }
  
  // Parse CSV output (PostgreSQL with -A -F,)
  return stdout.trim().split('\n').map(line => {
    const [id, name, email] = line.split(',');
    return { id: parseInt(id), name, email };
  });
}
```

**Example: Call REST API with authentication**

```typescript
// app.ts - Fetch GitHub repos
async function getRepos() {
  const res = await fetch('/api/bash/run', {
    method: 'POST',
    body: JSON.stringify({
      command: 'curl -s -H "Authorization: token ${GITHUB_TOKEN}" https://api.github.com/user/repos'
    })
  });
  
  const { stdout, exitCode } = await res.json();
  if (exitCode !== 0) throw new Error('API call failed');
  
  return JSON.parse(stdout);
}
```

**Example: Query MySQL database**

```typescript
// app.ts - Get order count
async function getOrderCount() {
  const res = await fetch('/api/bash/run', {
    method: 'POST',
    body: JSON.stringify({
      command: 'mysql -h mydb.example.com -u admin -p"${MYSQL_PASSWORD}" -N -e "SELECT COUNT(*) FROM orders"'
    })
  });
  
  const { stdout } = await res.json();
  return parseInt(stdout.trim());
}
```

**How it works:**
1. `${KEY_NAME}` placeholders are replaced server-side (Gateway process)
2. Custom keys are loaded from Keychain via CustomKeysService
3. Keys never reach the browser (secure)
4. Output is sanitized to remove any leaked key values

**When to use this vs. jobs + SQLite:**

| Use `/api/bash/run` + custom keys | Use jobs + SQLite |
|-----------------------------------|-------------------|
| Simple read-only queries (<5s) | Complex data transformations |
| Quick API calls | Scheduled/recurring syncs |
| Data fits in stdout (~1MB) | Large datasets (>1MB) |
| Real-time data (no caching) | Multi-step workflows |

**Example: Neon DB dashboard**
```typescript
// Fetch active users in real-time
const users = await loadUsers(); // Uses /api/bash/run

// vs.

// Scheduled job syncs users every hour → SQLite
// App reads from SQLite (faster, cached)
```

### Security note

`/api/bash/run` executes commands on the user's machine with the same permissions as the Gateway process. Only use it in apps you build — never construct the command string from user-controlled input without sanitizing it.

**Custom keys:** `${KEY_NAME}` substitution is secure because:
- Keys are resolved server-side (Gateway process)
- Browser never sees actual key values
- Output is sanitized to prevent leakage
- Only same-origin requests allowed (no external access)

---

### Mini-Apps and System Integration (window.paprAPI)

**IMPORTANT:** Mini-apps run in sandboxed iframes. Native browser APIs like `<a download>`, `window.open()`, and `navigator.clipboard` **do not work** because they're blocked by the iframe sandbox.

Instead, use `window.paprAPI.invoke()` to call Electron system APIs. This method is automatically available in all mini-apps.

#### Common System Actions

**Download/Save Files:**
```typescript
// Show save dialog, let user choose location
const result = await window.paprAPI.invoke('dialog.showSaveDialog', {
  defaultPath: 'export.csv',
  content: csvData,
  filters: [{ name: 'CSV Files', extensions: ['csv'] }]
});

if (!result.canceled) {
  console.log(`Saved to: ${result.filePath}`);
}
```

**Open External Links:**
```typescript
// Open in default browser
await window.paprAPI.invoke('shell.openExternal', 'https://github.com/user/repo');

// Open mail app
await window.paprAPI.invoke('shell.openExternal', 'mailto:user@example.com?subject=Hello&body=Message');

// Open any URL with system default app
await window.paprAPI.invoke('shell.openExternal', 'https://maps.google.com');
```

**Clipboard:**
```typescript
// Copy to clipboard
await window.paprAPI.invoke('clipboard.writeText', shareLink);

// Read from clipboard
const { text } = await window.paprAPI.invoke('clipboard.readText');
console.log('Clipboard contains:', text);
```

**Notifications:**
```typescript
// Show native OS notification
await window.paprAPI.invoke('notification.show', {
  title: 'Export Complete',
  body: 'Your data has been saved successfully',
  urgency: 'normal' // low, normal, or critical
});
```

**Show Files in Finder/Explorer:**
```typescript
// Reveal file in Finder (macOS) or Explorer (Windows)
await window.paprAPI.invoke('shell.showItemInFolder', '/Users/john/Downloads/report.pdf');
```

**Delete Files (Move to Trash):**
```typescript
// Move file to trash (safe, reversible)
await window.paprAPI.invoke('shell.trashItem', '/path/to/file.txt');
```

#### Complete Example: Export Button with Notification

```typescript
// app.ts
async function handleExport() {
  try {
    // Generate CSV
    const csv = users.map(u => `${u.id},${u.name},${u.email}`).join('\n');
    const content = 'ID,Name,Email\n' + csv;
    
    // Show save dialog
    const result = await window.paprAPI.invoke('dialog.showSaveDialog', {
      defaultPath: 'users.csv',
      content: content,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    
    if (!result.canceled) {
      // Show success notification
      await window.paprAPI.invoke('notification.show', {
        title: 'Export Complete',
        body: `Saved ${users.length} users to ${result.filePath}`
      });
      
      // Optionally reveal in Finder
      await window.paprAPI.invoke('shell.showItemInFolder', result.filePath);
    }
  } catch (error) {
    console.error('Export failed:', error);
    await window.paprAPI.invoke('notification.show', {
      title: 'Export Failed',
      body: error.message,
      urgency: 'critical'
    });
  }
}
```

#### Available Electron APIs

All mini-apps have access to these APIs via `window.paprAPI.invoke(method, ...args)`:

**shell module:**
- `shell.openExternal(url)` - Open URL in default app (browser, mail, etc.)
- `shell.showItemInFolder(path)` - Show file in Finder/Explorer
- `shell.trashItem(path)` - Move file to trash

**dialog module:**
- `dialog.showSaveDialog(options)` - Show save file dialog
  - Options: `{ defaultPath, content, filters }`
  - Returns: `{ filePath, canceled }`
- `dialog.showOpenDialog(options)` - Show open file dialog
  - Options: `{ filters, properties: ['openFile', 'openDirectory', 'multiSelections'] }`
  - Returns: `{ filePaths, canceled }`
- `dialog.showMessageBox(options)` - Show alert/confirm dialog
  - Options: `{ message, type: 'info'|'warning'|'error', buttons: ['OK', 'Cancel'] }`
  - Returns: `{ response: 0|1 }` (button index)

**clipboard module:**
- `clipboard.writeText(text)` - Copy text to clipboard
- `clipboard.readText()` - Read text from clipboard (returns `{ text }`)

**notification module:**
- `notification.show(options)` - Show native OS notification
  - Options: `{ title, body, urgency: 'low'|'normal'|'critical' }`

**app module:**
- `app.getPath(name)` - Get standard paths
  - Valid names: `'downloads'`, `'documents'`, `'desktop'`, `'home'`
  - Returns: `{ path: '/Users/john/Downloads' }`

**chat module (mini-apps only):**
- `chat.open(options?)` - Open a new chat tab from a dashboard / mini-app
  - Options: `{ message?: string; model?: string; provider?: string }` — all optional
  - `message` pre-fills the **composer draft** (user can edit before sending)
  - `model` should be a real model id from the app model picker (e.g. `gpt-5.2`, `claude-sonnet-4-6`)
  - Example — “Ask agent” on a card: `await window.paprAPI.invoke('chat.open', { message: 'Help with: ' + cardSummary })`
- **Do not use** `paprwork://…` links, `window.paprwork`, or raw `window.electronAPI` inside mini-app code — only `window.paprAPI.invoke(...)` is injected in the iframe.

#### Why Native Browser APIs Don't Work

Mini-apps run in sandboxed iframes for security. These browser APIs are blocked:

❌ **Doesn't work:**
```typescript
// Blocked by iframe sandbox
const link = document.createElement('a');
link.href = dataUrl;
link.download = 'file.csv';
link.click(); // Won't download!

// Opens in iframe, not system browser
window.open('https://github.com'); // Wrong!

// Restricted in iframe
navigator.clipboard.writeText('text'); // Permission denied!
```

✅ **Use window.paprAPI instead:**
```typescript
// Works! Opens in system browser
await window.paprAPI.invoke('shell.openExternal', 'https://github.com');

// Works! Shows native save dialog
await window.paprAPI.invoke('dialog.showSaveDialog', {
  defaultPath: 'file.csv',
  content: csvData
});

// Works! Copies to system clipboard
await window.paprAPI.invoke('clipboard.writeText', 'text');
```

#### Error Handling

```typescript
try {
  const result = await window.paprAPI.invoke('shell.openExternal', url);
  console.log('Opened successfully:', result);
} catch (error) {
  // API call failed (invalid URL, permission denied, etc.)
  console.error('Failed to open URL:', error.message);
  
  // Show user-friendly error
  await window.paprAPI.invoke('dialog.showMessageBox', {
    type: 'error',
    message: 'Failed to open link',
    detail: error.message
  });
}
```

---

## V2 Storage Layout

```
~/Papr/apps/{appId}/
  index.html            # Entry point (no inline JS)
  style.css             # Liquid Glass styles
  app.ts                # Main entry (TypeScript — auto-transpiled)
  types.ts              # Shared interfaces
  components/           # One component per file (<150 lines each)
  utils/                # Helpers, formatters, API calls
  data-sources.json     # Created by link_app_data_source

~/Papr/jobs/{jobId}/
  job.json              # Job configuration
  code/                 # Scripts (main.py, main.js, etc.)
  logs/                 # Execution logs
  data/                 # Output files
  data.db               # SQLite database (per job)
  migrations/           # Schema migrations
```

## Job Types

- `shell` / `bash` — Simple shell commands (use for curl, git, quick one-liners)
- `python` — Python scripts (auto-creates venv, auto-installs requirements) ← **USE THIS for scripts**
- `node` — Node.js scripts (auto-installs from package.json)
- `swift` — Swift scripts
- `agent` — AI agent with tool access (autonomous multi-step reasoning)
- `subagent` — Delegated to a sub-agent profile

**When to use each:**

| Use Case | Job Type | Example |
|----------|----------|---------|
| Python script with logic | `python` | Data processing, API calls, ML |
| Simple API call | `bash` | `curl https://api.com/data` |
| Git operations | `bash` | `git clone`, `git pull` |
| Node.js script | `node` | TypeScript apps, npm scripts |
| Multi-step AI task | `agent` | Research, code review |

**IMPORTANT: For Python scripts with API keys:**
- Type: `python` (NOT `bash`)
- Command: `python3 code/main.py --token ${KEY_NAME}`
- The script uses argparse to receive the key

### Python Job: Auto Venv + Requirements

Python jobs automatically get a virtual environment and package installation:

```javascript
create_job({
  name: "Reddit Selector",
  type: "python",
  requirements: ["anthropic", "sqlite-utils", "requests"],
  command: "python3 code/selector.py"
})
```

What happens automatically:
1. Creates `.venv` in the job directory (reused on subsequent runs)
2. Writes `requirements.txt` and runs `pip install` (only when requirements change)
3. Wraps the command to use venv Python: `python3` → `.venv/bin/python3`

**API keys are passed as CLI arguments (secure):**

```python
# ✅ CORRECT: Keys passed as CLI arguments in the COMMAND field
# Job command:
create_job({
  command: "python3 code/main.py --anthropic-key ${ANTHROPIC_API_KEY} --github-token ${GITHUB_TOKEN}"
  //                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ Substitution happens HERE
})

# code/main.py - Script receives substituted values as CLI args:
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--anthropic-key', required=True)
parser.add_argument('--github-token', required=True)
args = parser.parse_args()

# Use the keys - they're already substituted with real values!
client = anthropic.Client(api_key=args.anthropic_key)  # ✅ Has actual key value
```

**❌ CRITICAL ANTI-PATTERN: Do NOT put ${KEY} in Python source code!**

```python
# ❌ WRONG - Don't write ${KEY_NAME} in the Python file itself!
# code/main.py
token = "${GITHUB_TOKEN}"  # This is LITERAL TEXT, not substituted!

# When the script runs, token will be the STRING "${GITHUB_TOKEN}", not the actual key!
# This is the most common mistake agents make.
```

**Why this doesn't work:**
- `${KEY_NAME}` substitution ONLY happens in bash command strings
- It does NOT work inside Python/Node source files
- The Python file would see literal text `"${GITHUB_TOKEN}"`
- Bash substitution happens at spawn time, not when writing files

**The correct mental model:**

1. **Write Python file with argparse** (no keys in source):
   ```python
   parser.add_argument('--github-token', required=True)
   args = parser.parse_args()
   token = args.github_token  # ← Will receive actual value
   ```

2. **Create job with ${KEY} in command** (substitution happens here):
   ```javascript
   command: "python3 code/main.py --github-token ${GITHUB_TOKEN}"
   ```

3. **At spawn time**, bash substitutes:
   ```bash
   python3 code/main.py --github-token ghp_abc123...  # ← Real value injected
   ```

**❌ ALSO INCORRECT: Do NOT use os.environ for API keys**
```python
# ❌ This won't work - custom keys are NOT in environment
import os
key = os.getenv('GITHUB_TOKEN')  # Returns None!
```

**Why CLI args?**
- ✅ More secure (keys not in job environment, can't be leaked to files)
- ✅ Explicit (clear which keys each job uses)
- ✅ Cloud-ready (matches AWS/GCP/Kubernetes patterns)
- ✅ Keys substituted at runtime: `${GITHUB_TOKEN}` → actual value

**Environment keys (inherited from gateway):**
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` (from Settings or `.env.local`)
- These CAN be used via `os.environ` (but CLI args are still preferred)

**OAuth vs API key for jobs:**
- **Agent jobs** — Paprwork routes automatically. OAuth (ChatGPT/Claude subscription) → pi-ai. API key → AI SDK. No setup needed.
- **Python/bash jobs that call LLM APIs** — ❌ **DON'T DO THIS!** Use agent jobs instead (see below).

### ⚠️ Use Agent Jobs for LLM Calls, Not Python/Bash Scripts

**❌ WRONG:**
```python
# DON'T call OpenAI/Anthropic APIs from Python jobs
import openai
response = openai.chat.completions.create(...)
```

**Problems:**
- OAuth tokens don't work with Platform API
- No automatic OAuth → API key fallback
- Requires Platform API key even if user has OAuth subscription

**✅ CORRECT:** Use agent jobs (type: "agent" or "subagent")

Agent jobs automatically handle:
- OAuth → API key routing (uses subscription first, falls back to Platform API)
- Rate limit fallback (retries with API key if OAuth rate limited)
- Works with OAuth, API key, or both

**Example:**
```javascript
// Create sub-agent for LLM task
create_sub_agent({
  id: "reviewer",
  name: "Content Reviewer",
  systemPrompt: "Review and polish content for clarity",
  provider: "openai",
  model: "gpt-5.2"
})

// Use in pipeline (autoTrigger required if Review should start when fetch finishes)
create_job({
  name: "Review Posts",
  type: "subagent",
  subAgentId: "reviewer",
  dependsOn: [{ jobId: "fetch-data", onStatus: "completed", autoTrigger: true }]
})
```

**Pipeline pattern:** Python (data fetch) → Agent job (LLM) → Python (format output)

### Agent Jobs: When to Use Model Override vs. Subagent

**Two ways to specify a model for agent jobs:**

1. **Direct model override** (`type: "agent"` with `provider`/`model`)
2. **Subagent with custom profile** (`type: "subagent"` with `subAgentId`)

**Use direct model override when:**
- ✅ Same behavior as main agent, just need more power/context
- ✅ One-off task (don't need reusable profile)
- ✅ Quick model swap for testing (A/B test different models)
- ✅ No custom system prompt or tool restrictions needed

**Example: Weekly briefing with more context**
```javascript
// Just need GPT-5.4's 272K context (vs gpt-5.2's 120K)
create_job({
  name: "Weekly Prep Briefing",
  type: "agent",  // ← Same main agent behavior
  provider: "openai",
  model: "gpt-5.4",  // ← Just need bigger context window
  command: "Search memory for ICP decisions, product focus, and Techstars tasks from past week",
  schedule: { enabled: true, cron: "0 7 * * 1" },  // Every Monday at 7am
})
```

**Use subagent when:**
- ✅ Specialized role/behavior (custom system prompt)
- ✅ Restricted tool access (security/safety)
- ✅ Reusable profile (multiple jobs use same agent)
- ✅ Distinct identity matters (e.g., "Code Reviewer" vs. "Content Writer")

**Example: Code review specialist**
```javascript
// Create reusable code review agent with custom prompt + restricted tools
create_sub_agent({
  id: "code-reviewer",
  name: "Code Review Specialist",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  systemPrompt: `You are a senior code reviewer. Focus on:
- Security vulnerabilities
- Performance bottlenecks
- Code style consistency
- Test coverage gaps
NEVER suggest adding comments unless code is truly unclear.`,
  allowedToolIds: ["read_file", "list_files", "grep"]  // No bash execution!
})

// Use in multiple contexts
create_job({
  name: "PR Review Bot",
  type: "subagent",
  subAgentId: "code-reviewer",
  command: "Review files changed in latest PR",
})

create_job({
  name: "Weekly Security Audit",
  type: "subagent",
  subAgentId: "code-reviewer",  // ← Same agent, different task
  schedule: { enabled: true, cron: "0 9 * * 1" },
})
```

**Quick decision tree:**

```
Need different model/provider?
├─ YES → Need custom behavior/tools/prompt?
│        ├─ YES → Use subagent (2 steps: create_sub_agent + create_job)
│        └─ NO  → Use direct override (1 step: create_job with model)
└─ NO  → Use plain agent job (type: "agent", no model specified)
```

**Priority order (when both are specified):**
1. Subagent profile (highest priority) — if job is `type: "subagent"`
2. Job record `provider`/`model` — if specified in `create_job`
3. Default (`openai/gpt-5.2`) — fallback

### Calling Agent Jobs from Python Scripts

**Yes!** Python jobs can call agent jobs mid-script:

```python
import requests, json

# Fetch data
posts = fetch_reddit_posts()

# Call agent job for each post (gets OAuth/API key routing)
for post in posts:
    response = requests.post('http://localhost:18789/api/jobs/run', json={
        'jobId': 'review-post-agent',
        'wait': True,  # Wait for result
        'params': {'POST_CONTENT': post['content']}
    })
    
    result = response.json()
    if result['status'] == 'completed':
        reviewed = json.loads(result['lastOutput'])
        post['reviewed'] = reviewed['content']

# Continue with LLM results
save_to_database(posts)
```

**When to use:**
- LLM calls in middle of processing
- Processing items in a loop
- Single atomic job clearer than pipeline
- **Bash/Python jobs** calling OpenAI/Anthropic — Require a **Platform API key**. OAuth tokens won't work (they use a different backend). If user only has OAuth, tell them to add a Platform key in Settings for script use.

**Runtime params** (job-specific config like `THREAD_ID`, `ACTION`):
- These ARE available via `os.environ` - use them freely!

---

## Phase 0: Create Plan (REQUIRED for Mini-Apps)

**CRITICAL: Always create a plan BEFORE building mini-apps.**

Use `create_plan` to show the user your approach and track progress:

```javascript
create_plan({
  title: "Build Funnel Dashboard Mini-App",
  steps: [
    { id: "check", title: "Check existing apps for similar functionality", status: "pending" },
    { id: "design", title: "Load design system & design UI", status: "pending" },
    { id: "prototype", title: "Create mockup with placeholder data", status: "pending" },
    { id: "validate", title: "Validate data source schema", status: "pending" },
    { id: "implement", title: "Build real app with live data", status: "pending" },
    { id: "test", title: "Test all UX states (loading/empty/error/success)", status: "pending" }
  ]
})
```

Update the plan as you progress:

```javascript
update_plan({ stepId: "check", status: "completed" })
update_plan({ stepId: "design", status: "in_progress" })
```

---

## Phase 1: Check Existing Apps (REQUIRED)

**CRITICAL: Always call `list_apps` BEFORE creating a new app.**

Check if a similar app already exists that you can update instead:

```javascript
// 1. List all existing apps
list_apps()

// Returns:
{
  apps: [
    { id: "abc-123", title: "Sales Dashboard", description: "Track sales metrics" },
    { id: "def-456", title: "User Analytics", description: "User behavior tracking" }
  ],
  count: 2
}

// 2. If similar app exists, UPDATE it instead of creating new one
edit_app_file({
  appId: "abc-123",
  filename: "app.js",
  oldString: "const metrics = [...old data...]",
  newString: "const metrics = [...new data...]"
})

// 3. Only create NEW app if no similar functionality exists
create_app({ ... })
```

**Why this matters:**
- Prevents duplicate apps with similar functionality
- Preserves user's existing apps and data sources
- Faster than building from scratch
- Better UX (user sees updates, not new apps)

---

## Phase 2: UI-First Development

### Mock the UI (5-10 minutes)

Create a placeholder UI to align with the user on layout, data, and actions:

```javascript
create_app({
  title: "Funnel Dashboard",
  description: "Track visitor-to-login conversion",
  files: {
    "index.html": "<!-- mockup with placeholder data -->",
    "style.css": "/* Liquid Glass styling */",
    "app.js": "// Mock data for alignment"
  }
})
```

Start with hard-coded placeholder data:

```javascript
// app.js — mock data for user alignment
const mockMetrics = [
  { label: 'Pre-login Visitors', value: 1234, change: 5.2 },
  { label: 'Logins', value: 456, change: -2.1 },
  { label: 'Conversion Rate', value: '37%', change: 1.2 }
];
```

Show the user and ask: "Does this match what you're looking for? What else should be displayed?"

### Required UX States

When creating mini-apps with \`create_app\`:
1. **FIRST: Load design system** → \`read_skill({ skillId: "preloaded-paprwork-design-system" })\`
2. **THEN: Design the UI** following Liquid Glass principles
3. **FINALLY: Create the app** with \`create_app\`

Critical design rules:
- One primary action per screen
- Progressive disclosure for complexity
- Glass aesthetic with backdrop blur
- 44px minimum button height`;

Every app must handle these four states:
- **Loading** — Skeleton or spinner while data loads
- **Empty** — Helpful message when no data yet ("Run the sync job to populate data")
- **Error** — Clear error message with retry action
- **Success** — Real data displayed

### App Structure Guidelines — MANDATORY

Mini-apps support **TypeScript** (`.ts`/`.tsx`) — the gateway transpiles them automatically. **Always use TypeScript and modular architecture.**

#### Required File Structure

```
~/Papr/apps/{appId}/
  index.html          # Entry point — loads modules, no inline JS
  style.css           # Global styles (Liquid Glass tokens)
  app.ts              # Main entry — initialises app, wires components
  components/
    header.ts         # Header component
    metricCard.ts     # Reusable metric card
    chart.ts          # Chart component
    ...
  utils/
    api.ts            # Data fetching helpers
    formatters.ts     # Number/date formatting
  types.ts            # Shared interfaces and type definitions
```

#### Rules

1. **TypeScript required** — use `.ts` files, not `.js`. The gateway transpiles them on-the-fly via esbuild.
2. **Max 150 lines per file** — if a file exceeds this, split it into smaller components.
3. **ES modules** — use `import`/`export` between files. Load in `index.html` via `<script type="module" src="app.ts"></script>`.
4. **No inline JavaScript** — keep `<script>` content in `.ts` files, not inside HTML.
5. **One component per file** — each UI section (header, card, chart, list, form) is its own file.
6. **Shared types** — define interfaces in `types.ts` and import them.
7. **Utility separation** — formatters, API calls, and helpers go in `utils/`.

#### Example: index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Dashboard</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="app.ts"></script>
</body>
</html>
```

#### Example: app.ts (entry point)

```typescript
import { renderHeader } from './components/header.ts';
import { renderMetrics } from './components/metricCard.ts';
import { fetchMetrics } from './utils/api.ts';
import type { AppState } from './types.ts';

async function init(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;

  const state: AppState = { loading: true, data: null, error: null };
  renderHeader(app, 'Sales Dashboard');

  try {
    state.data = await fetchMetrics();
    state.loading = false;
    renderMetrics(app, state.data);
  } catch (err) {
    state.error = (err as Error).message;
    state.loading = false;
    app.innerHTML += `<p class="error">${state.error}</p>`;
  }
}

init();
```

#### Example: components/metricCard.ts

```typescript
import type { Metric } from '../types.ts';

export function renderMetrics(container: HTMLElement, metrics: Metric[]): void {
  const grid = document.createElement('div');
  grid.className = 'metrics-grid';

  for (const metric of metrics) {
    const card = document.createElement('div');
    card.className = 'glass-card metric-card';
    card.innerHTML = `
      <span class="metric-label">${metric.label}</span>
      <span class="metric-value">${metric.value}</span>
    `;
    grid.appendChild(card);
  }

  container.appendChild(grid);
}
```

#### Using `create_app` with Modular Files

```javascript
create_app({
  title: "Sales Dashboard",
  description: "Track sales metrics and conversion",
  files: [
    { filename: "index.html", content: "..." },
    { filename: "style.css", content: "..." },
    { filename: "app.ts", content: "..." },
    { filename: "types.ts", content: "..." },
    { filename: "components/header.ts", content: "..." },
    { filename: "components/metricCard.ts", content: "..." },
    { filename: "utils/api.ts", content: "..." },
    { filename: "utils/formatters.ts", content: "..." }
  ]
})
```

- Use Liquid Glass design tokens (see Liquid Glass Design skill)
- Test with `webview_launch_app` + `webview_wait_for({ time: 2 })` or `webview_snapshot` — never `browser_wait_for` after preview launch (different browser)

#### App Logo / Icon — Shown in Tabs, Favorites, and Bundles

Every mini-app **MUST** have an icon. It appears in the tab bar, sidebar favorites, artifact cards, and is automatically included in bundle manifests when exported. There are two ways to set it:

**Option A — `icon` parameter (recommended):** Pass an SVG string or emoji directly to `create_app`:

```javascript
create_app({
  title: "Sales Dashboard",
  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  // ... rest of params
})
```

Or use an emoji (concise, great for quick apps):

```javascript
create_app({
  title: "Weather Widget",
  icon: "⛅",
  // ...
})
```

**Option B — favicon in `index.html` (auto-extracted):** Add a `<link rel="icon">` with a data URI SVG in the `<head>` of `index.html`. The app service auto-extracts it as the icon — no `icon` param needed:

```html
<head>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' width='14' height='14'%3E%3Cpath d='M12 2L2 7l10 5 10-5-10-5z' stroke='currentColor' stroke-width='1.5'/%3E%3C/svg%3E">
</head>
```

**Priority order:** explicit `icon` param > `<link rel="icon">` in HTML > `logo.svg` / `icon.svg` / `favicon.svg` file in app directory.

##### Icon Design Guidelines

**SVG Rules:**
- **Size:** `width="14" height="14"` with `viewBox="0 0 24 24"` — the 24×24 viewBox gives you a comfortable design grid, while 14px rendering keeps it crisp at tab/sidebar scale
- **Stroke style:** `stroke="currentColor"` with `stroke-width="1.5"` or `"2"` — adapts to dark/light themes automatically
- **Fill:** Use `fill="none"` for outlined icons (preferred) or `fill="currentColor"` for solid icons — never use hardcoded colors
- **Line caps:** `stroke-linecap="round" stroke-linejoin="round"` for a polished look
- **Keep it simple:** 1-3 recognizable shapes. The icon renders at 14px — fine details disappear

**Design Approach — Think Lucide/Feather:**
Design icons in the same spirit as [Lucide](https://lucide.dev) icons: clean, minimal, stroke-based, universally readable. Pick 1-2 distinctive shapes that communicate the app's purpose at a glance.

##### Icon Examples by App Type

**Expense Tracker** (receipt/dollar):
```
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M12 11h4"/><path d="M12 15h4"/><path d="M8 11h.01"/><path d="M8 15h.01"/></svg>
```

**Hello World / Getting Started** (waving hand):
```
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v-1a4 4 0 0 1 4-4h0a4 4 0 0 1 4 4v5"/><path d="M11 7V4a2 2 0 1 1 4 0v3"/><path d="M7 11a2 2 0 0 0-4 0v4a8 8 0 0 0 16 0v-2a2 2 0 1 0-4 0"/><path d="M7 11V8a2 2 0 1 0-4 0v3"/></svg>
```

**Dashboard / Analytics** (bar chart):
```
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
```

**Task Manager / Todo** (check-square):
```
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
```

**Calendar / Schedule** (calendar):
```
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
```

**Notes / Writing** (pen-line):
```
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838.838-2.872a2 2 0 0 1 .506-.855z"/></svg>
```

**Weather** (cloud-sun):
```
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>
```

**Fitness / Health** (heart-pulse):
```
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12.572 12 20l-7.5-7.428A5 5 0 1 1 12 6.006a5 5 0 1 1 7.5 6.572"/><path d="M5 12h2l2-3 3 6 2-3h2"/></svg>
```

##### When to Use Emoji vs SVG

| Use Case | Recommendation |
|----------|---------------|
| Quick prototype / demo app | Emoji (`"📊"`, `"⛅"`, `"✅"`) |
| Production / polished app | SVG (matches Liquid Glass aesthetic) |
| Community bundle / shared app | SVG (looks professional in registry) |
| App with dark/light mode | SVG with `currentColor` (adapts automatically) |

**Emoji examples:** `"💰"` (finance), `"📝"` (notes), `"🏋️"` (fitness), `"🌤️"` (weather), `"📅"` (calendar), `"🛒"` (shopping), `"🎵"` (music), `"📸"` (photos)

The icon shows in: tab bar, sidebar favorites, artifact card preview, and bundle manifests (auto-included on export)

---

## Phase 2: Validate Upstream Data

### Test Before Building (Critical)

Before writing any job code, probe the actual data:

```bash
# Example: Test Amplitude API
curl -u "${AMPLITUDE_API_KEY}:${AMPLITUDE_SECRET_KEY}" \
  "https://amplitude.com/api/2/export?start=20260207T00&end=20260207T01" | \
  jq '.data[0:3]'
```

Show the user what you found:

```
I tested the Amplitude API and found these fields:
- event_type: "page_view", "login", "signup"
- location: "/" or "/docs"
- user_id: "abc123..."

Based on this, I can build a job that tracks prelogin visitors and computes conversion rates.
Does this match what you expected?
```

Wait for confirmation before proceeding. See `API_KEY_TESTING_PROTOCOL.md` for the full test-first workflow.

---

## Phase 3: Define Contracts

### Job Write Model (what the job produces)

```sql
-- Define stable table names and keys before implementation
CREATE TABLE funnel_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  prelogin_visitors INTEGER,
  logins INTEGER,
  conversion_rate REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_funnel_date ON funnel_runs(date);
```

### App Read Model (what the UI queries)

| Widget | Query | Index Needed |
|--------|-------|-------------|
| Today's metrics | `SELECT * FROM funnel_runs WHERE date = date('now')` | `idx_funnel_date` |
| 7-day trend | `SELECT * FROM funnel_runs ORDER BY date DESC LIMIT 7` | `idx_funnel_date` |

### Contract Checklist

- [ ] Table names and columns defined before coding
- [ ] Indexes match app query patterns
- [ ] Retention policy declared (`retentionDays` in job config)
- [ ] Schema migrations use `schema_migrations` table for versioning
- [ ] Write model and read model are explicitly documented
- [ ] Fallback behavior defined for empty/missing data

---

## Phase 4: Implement Jobs

### Create and Test

```javascript
// Create the job
create_job({
  name: "Amplitude Sync",
  type: "python",
  command: "python code/main.py",
  retries: { maxAttempts: 3, backoffMs: 5000 },
  schedule: "0 */6 * * *",   // Every 6 hours
  retentionDays: 90
})

// Run a small verification
run_job({ jobId: "amplitude-sync" })

// Inspect output
read_job_logs({ jobId: "amplitude-sync", runId: "latest" })
```

### Choosing: Script Job vs Agent Job vs Python + LLM

This is the most important decision. There are THREE patterns, not two:

#### Pattern 1: Pure Script Job (no AI)

Use `python`/`node`/`bash` when the task is fully deterministic:
- ETL pipelines, file processing, data transformation
- API calls with known request/response shapes
- Database queries, migrations, backups

#### Pattern 2: Python Job WITH LLM Call (RECOMMENDED for most AI tasks)

Use a `python` job that calls an LLM directly when you **know the steps** but need **AI judgment** at one point. This is the most common pattern and is almost always better than an agent job:

```javascript
create_job({
  name: "Reddit Selector",
  type: "python",
  requirements: ["anthropic"],
  command: "python3 code/selector.py --anthropic-key ${ANTHROPIC_API_KEY}",
  dependsOn: [{ jobId: "scraper-id", onStatus: "completed", autoTrigger: true }]
})
```

```python
# code/selector.py
import os, json, sqlite3, anthropic, argparse

# Parse CLI arguments (for API keys)
parser = argparse.ArgumentParser()
parser.add_argument('--anthropic-key', required=True)
args = parser.parse_args()

# Step 1: SQL query (deterministic, fast)
db = sqlite3.connect(os.environ.get('DEP_SCRAPER_DB', '../scraper/data/data.db'))
rows = db.execute("""
    SELECT id, title, score, num_comments FROM threads
    WHERE score > 5 ORDER BY score DESC LIMIT 20
""").fetchall()
db.close()

# Step 2: One LLM call for judgment (the AI part)
client = anthropic.Anthropic()  # picks up ANTHROPIC_API_KEY from env
response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": f"Pick 5-7 best threads to engage with: {json.dumps(rows)}"}]
)

# Step 3: Parse and write results (deterministic)
picks = json.loads(response.content[0].text)
out_db = sqlite3.connect("data/data.db")
out_db.execute("CREATE TABLE IF NOT EXISTS picks (id TEXT, title TEXT, reason TEXT)")
for p in picks:
    out_db.execute("INSERT INTO picks VALUES (?, ?, ?)", (p['id'], p['title'], p['reason']))
out_db.commit()
print(f"Selected {len(picks)} threads")
```

**Why this is better than an agent job:**
- One LLM call vs potentially dozens of tool-calling turns
- Python controls the exact flow — no reasoning overhead
- Faster, cheaper, more debuggable
- Script is version-controlled and readable
- Structured output via `response_format` is reliable

**Use this pattern when:**
- You know all the steps (query DB → call LLM → write results)
- The AI part is one judgment call, not autonomous exploration
- You need specific Python packages (pandas, requests, etc.)
- The task involves data processing + one AI step

#### Pattern 3: Agent Job (autonomous multi-step reasoning)

Use `agent`/`subagent` ONLY when the task requires **autonomy** — the agent must decide what to do based on what it finds:

- "Research this topic" — agent decides what to search, which pages to read, when to stop
- "Debug why this scraper is failing" — agent reads logs, tries fixes, iterates
- "Write a comprehensive report on X" — agent gathers sources, outlines, drafts, revises
- "Set up a new data pipeline for Y" — agent explores the API, creates schema, tests

Agent jobs get automatic environment injection:
```
=== JOB ENVIRONMENT ===
JOB_DIR="/Users/.../PAPR/jobs/{id}"
JOB_DB="/Users/.../PAPR/jobs/{id}/data/data.db"
DEP_SCRAPER_DIR="/Users/.../PAPR/jobs/{dep-id}"
DEP_SCRAPER_DB="/Users/.../PAPR/jobs/{dep-id}/data/data.db"
=======================
```

The agent can use `bash` to query these paths directly — no need to hard-code or guess.

#### Decision Quick-Check

```
Do you know ALL the steps in advance?
  YES → Is one step "ask LLM for judgment"?
    YES → Python job with LLM call (Pattern 2)
    NO  → Pure script job (Pattern 1)
  NO  → Agent job (Pattern 3)
```

### Job Dependencies (DAG Pipelines)

**`dependsOn` alone does not auto-run the next job.** To start job B automatically when job A reaches a terminal status, B’s dependency entry must include **`autoTrigger: true`**. That is true for **every** link in the chain (python → subagent, subagent → subagent, etc.). Without it, `dependsOn` only enforces **order** when B is started manually, by schedule, or because a later job pulled the dependency chain via `run_job`.

When updating dependencies with `update_job`, re-send the full `dependsOn` array including `autoTrigger: true` for each link that should keep auto-chaining — otherwise auto-start is dropped.

```javascript
// Job A: Collect data (script)
create_job({ name: "Data Collector", type: "python", ... }) // note returned job id

// Job B: Analyze (agent) — starts automatically when A completes
create_job({
  name: "Data Analyzer",
  type: "agent",
  dependsOn: [{ jobId: "<data-collector-job-id>", onStatus: "completed", autoTrigger: true }],
  ...
})

// Job C: Report (agent) — starts automatically when B completes
create_job({
  name: "Daily Report",
  type: "agent",
  dependsOn: [{ jobId: "data-analyzer-id", onStatus: "completed", autoTrigger: true }],
  deliver: { channel: "chat", targetId: "main" }
})
```

### Delivery

Jobs can deliver results to chat:

```javascript
create_job({
  ...
  deliver: { channel: "chat", targetId: "main" }
})
```

---

## Phase 5: Wire App to Data

### Link Data Source

```javascript
link_app_data_source({
  appId: "funnel-dashboard",
  jobId: "amplitude-sync",
  alias: "funnel",          // Human-readable name
  tables: ["funnel_runs"]   // Optional but recommended
})
```

This creates `data-sources.json` in the app folder:

```json
[{
  "type": "sqlite",
  "jobId": "amplitude-sync",
  "alias": "funnel",
  "dbPath": "~/Papr/jobs/amplitude-sync/data.db",
  "tables": ["funnel_runs"],
  "linkedAt": "2026-02-13T..."
}]
```

### Update App to Use Real Data

Replace placeholder data with real queries:

```javascript
// Before (placeholder):
const metrics = { visitors: 1234, logins: 456 };

// After (real data from linked source):
async function loadMetrics() {
  const result = await window.electronAPI.executeCommand(
    `sqlite3 -json "${dbPath}" "SELECT * FROM funnel_runs ORDER BY date DESC LIMIT 1"`
  );
  return JSON.parse(result.stdout)[0];
}
```

### Best Practices

- Keep aliases domain-specific (`orders`, `funnel_events`, `crm_accounts`)
- Avoid implicit assumptions — define read queries from the linked contract
- Re-run `run_job` after schema changes to verify compatibility
- Validate all four UX states with realistic records

---

## Quick Examples

### Example 1: API -> Job -> App

1. Probe API with small `bash` query, inspect fields
2. `create_job` (python) to ingest into SQLite
3. `run_job` to verify logs and rows
4. `create_app` for dashboard UI
5. `link_app_data_source` with alias `funnel`

### Example 2: Agent Analysis Pipeline

1. Job A (python) writes `metrics_daily`
2. Job B (agent) depends on A, reads metrics, writes summary
3. Job C (agent) generates report, delivers to chat
4. Configure retries for all jobs

### Example 3: Existing Job, New App

1. Inspect producer outputs and DB path
2. `create_app` with loading/empty/error states
3. `link_app_data_source` with alias and table list
4. Validate UX with realistic records

### Example 4: Recovery Loop

When a run fails:
1. Read `read_job_logs` output
2. Fix command/schema mismatch
3. Re-run with small scope via `run_job`
4. Only then expand schedule/dependencies

---

## Reliability Checklist

- [ ] Job output verified with sample rows (`run_job` + `read_job_logs`)
- [ ] App queries mapped to indexed columns
- [ ] Error paths are visible and actionable in the UI
- [ ] Data source alias and tables documented in `data-sources.json`
- [ ] Test script exists and passes for the job
- [ ] All four UX states (loading, empty, error, success) implemented
- [ ] Retry policy configured for jobs
- [ ] Retention policy set for job data

---

## Job Resilience & Patterns

### Three Job Patterns

1. **One-shot / Transient Failure Jobs**
   - API calls, data fetches, notifications
   - Failures are transient (rate limits, network timeouts)
   - Solution: Use `retries` with exponential backoff
   - Example: Fetch GitHub repos, send Slack message

2. **Long-running / Processing Jobs**
   - Process large datasets (1M records), multi-step workflows
   - Failures lose partial progress without checkpointing
   - Solution: Script implements checkpointing + retries
   - Example: ETL pipeline, ML training, multi-hour scraping

3. **Always-on / Service Jobs**
   - HTTP servers, webhook listeners, scheduled watchers
   - Should survive app restarts (future: detached mode)
   - Solution: Use scheduled jobs (cron/interval) with auto-restart
   - Example: Dashboard server, webhook receiver

### When to Use Retries

**Use `retries` for transient failures:**

```javascript
create_job({
  name: "Fetch GitHub Repos",
  type: "python",
  command: "python3 code/fetch.py",
  retries: { maxAttempts: 3, backoffMs: 2000 }
  // Attempt 1 fails → wait 2s
  // Attempt 2 fails → wait 4s
  // Attempt 3 fails → mark as failed
})
```

**Good for:**
- API rate limits (429 errors)
- Network timeouts
- Temporary service outages
- Database connection issues

**Not good for:**
- Logic errors in your script (retries won't help)
- Processing large datasets (retries restart from beginning)

### How to Add Checkpointing for Resumable Work

For jobs processing large datasets, implement checkpointing in your script:

**Pattern 1: Track last processed ID**

```python
import sqlite3
from pathlib import Path

db_path = Path(__file__).parent.parent / "data" / "data.db"
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Initialize schema
cur.execute("""
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  data TEXT,
  processed_at TEXT
)
""")
cur.execute("""
CREATE TABLE IF NOT EXISTS checkpoint (
  key TEXT PRIMARY KEY,
  value TEXT
)
""")
conn.commit()

# Load checkpoint
cur.execute("SELECT value FROM checkpoint WHERE key='last_id'")
row = cur.fetchone()
last_id = int(row[0]) if row else 0

print(f"Resuming from ID {last_id}")

# Process items
for item_id in range(last_id + 1, 1_000_000):
    # Fetch and process item
    data = fetch_item(item_id)
    cur.execute(
        "INSERT INTO items (id, data, processed_at) VALUES (?, ?, datetime('now'))",
        (item_id, data)
    )
    
    # Save checkpoint every 100 items
    if item_id % 100 == 0:
        cur.execute(
            "INSERT OR REPLACE INTO checkpoint (key, value) VALUES ('last_id', ?)",
            (str(item_id),)
        )
        conn.commit()
        print(f"Checkpoint: {item_id}/1,000,000")

# Final checkpoint
cur.execute("INSERT OR REPLACE INTO checkpoint (key, value) VALUES ('last_id', ?)", (str(1_000_000),))
conn.commit()
print("Processing complete!")
```

**Pattern 2: Status column approach**

```python
# Mark items as pending/processing/complete
cur.execute("UPDATE items SET status='processing' WHERE id=?", (item_id,))
# ... process item ...
cur.execute("UPDATE items SET status='complete', result=? WHERE id=?", (result, item_id))
conn.commit()

# On restart, resume from pending items
cur.execute("SELECT id FROM items WHERE status IN ('pending', 'processing') ORDER BY id")
```

**Pattern 3: Work queue table**

```python
# Separate queue table tracks work items
cur.execute("""
CREATE TABLE IF NOT EXISTS work_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type TEXT,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
)
""")

# Pop next pending item
cur.execute("""
  UPDATE work_queue
  SET status='processing', attempts=attempts+1
  WHERE id = (
    SELECT id FROM work_queue
    WHERE status='pending' AND attempts < max_attempts
    ORDER BY created_at
    LIMIT 1
  )
  RETURNING id, payload
""")
```

### Combining Retries + Checkpointing

For maximum resilience:

```javascript
create_job({
  name: "Process 1M Records",
  type: "python",
  command: "python3 code/processor.py",
  retries: { maxAttempts: 3, backoffMs: 5000 }
  // Script has checkpointing → retries continue from checkpoint
})
```

If the job fails:
1. Attempt 1: Processes 300K records → crashes at 300K
2. Attempt 2: Resumes from checkpoint (300K) → crashes at 700K
3. Attempt 3: Resumes from checkpoint (700K) → completes

### App Closures & Job Interruptions

**What happens when the app closes while a job is running:**

1. Job process is killed (SIGTERM on graceful shutdown)
2. Job marked as "cancelled" (graceful) or "failed" (crash)
3. On next app start:
   - **Scheduled jobs (cron/interval):** Auto-run on next schedule
   - **Manual jobs with retries:** Show "X retries remaining - click Run to retry"
   - **Jobs with checkpointing:** Resume from last checkpoint when re-run

**Design for interruptions:**
- Use scheduled jobs (cron/interval) for auto-recovery
- Add checkpointing for long-running work
- Set `catchUpMissed: true` on cron jobs to run missed occurrences

### Example: Resilient ETL Pipeline

```javascript
// Step 1: Create job with retries + checkpointing
create_job({
  name: "Ingest HackerNews Posts",
  type: "python",
  command: "python3 code/ingest.py",
  requirements: ["requests", "beautifulsoup4"],
  retries: { maxAttempts: 3, backoffMs: 5000 },
  schedule: {
    enabled: true,
    cron: "0 */6 * * *",  // Every 6 hours
    catchUpMissed: true    // Run on startup if missed
  }
})

// Step 2: Write checkpointing script
bash({ command: `cat > ~/Papr/jobs/<jobId>/code/ingest.py << 'EOF'
import sqlite3
import requests
from pathlib import Path

db_path = Path(__file__).parent.parent / "data" / "data.db"
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Schema + checkpoint table
cur.execute("""
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  title TEXT,
  url TEXT,
  score INTEGER,
  fetched_at TEXT
)
""")
cur.execute("""
CREATE TABLE IF NOT EXISTS checkpoint (
  key TEXT PRIMARY KEY,
  value TEXT
)
""")
conn.commit()

# Load last processed page
cur.execute("SELECT value FROM checkpoint WHERE key='last_page'")
row = cur.fetchone()
start_page = int(row[0]) if row else 1

# Fetch pages with checkpointing
for page in range(start_page, 100):
    response = requests.get(f"https://news.ycombinator.com/news?p={page}")
    # ... parse and insert posts ...
    
    # Checkpoint every page
    cur.execute(
        "INSERT OR REPLACE INTO checkpoint (key, value) VALUES ('last_page', ?)",
        (str(page),)
    )
    conn.commit()
    print(f"Page {page}/100 complete")

print("Ingestion complete!")
EOF` })

// Step 3: Test resilience
run_job({ jobId: "<jobId>" })
```

**Resilience benefits:**
- **Transient failures:** Retries handle network timeouts
- **App crashes:** Checkpointing preserves progress
- **Missed runs:** `catchUpMissed: true` runs on startup
- **Scheduled recovery:** Runs every 6 hours automatically

---

## Writing Prompts & Tone References

Use these prompts when agent jobs involve generating text for public platforms. Include the relevant prompt in the agent job's system prompt or prepend it to the task instructions.

### Social Media Reply Tone (Reddit, Twitter/X, HN, LinkedIn comments)

Use this when an agent job is posting replies, comments, or responses on social platforms on behalf of a founder or individual. It produces natural, non-corporate replies that read as genuine rather than AI-generated.

```
You're a founder replying on social.

Be genuine — post because you have something to say, not because you want to be seen saying something.

Write like you're texting a friend who asked a good question. Natural language. Incomplete thoughts are fine. No perfect grammar police. Use real social voice.
- Concise and direct. No filler, no wind-up, no landing.
- "tbh", "imo", "tl;dr" are all fine
- Contractions work (you're, don't, here's)
- Lowercase is fine at times. Mix it up.
- Sentence fragments? sure
- One-sentence paragraphs work too

TONE & STYLE:
- Concise and direct. No filler, no wind-up, no landing.
- Lowercase is fine, natural mix it up. Contractions work (you're, don't, here's). "tbh", "imo" fine.
- Sentence fragment fine. One sentence paragraphs work. Don't use ; 
- Get to the point in the first sentence. No intro, no "Great question!", no "Happy to help!".
- No conclusion or summary at the end. Just stop when you're done.
- Short paragraphs. 2-4 sentences max per paragraph.

Skip:
- Opening with "Great [noun]!" or "Hey," or "you're approach sounds promising"
- Bullet-point essays where prose would work
- "Here are some thoughts:" lead-ins
- Restating the question before answering it
- Closing with encouragement like "Good luck!", "Great work!", "Happy to help!"
- Performative helpfulness — sounding like a customer support agent
- Listing bullets
- "I'd be happy to help!" filler
- Corporate speak
- Sales pitches

Do:
- Jump straight into the substance. Actually answer the question
- Share what you've actually run into, not generic advice
- 4-8 sentences total is usually right
- Admit when something's annoying or doesn't work well
- One clarifying question at the end is fine, two max
- Be helpful without being performatively helpful

Just be direct and useful. Write like you actually know this stuff. Don't format it to death. Just be real.
```

**When to use:** Any agent job that generates draft replies, comment responses, or community engagement posts. Works well for Reddit monitoring jobs, HN thread watchers, or Twitter/X reply drafters.

**Usage pattern:** Prepend this as the system prompt in the agent job, then pass the original post/comment as the user message along with any context about the product/founder.

---

---

## Sharing Mini-Apps via App Bundles

### Overview

App bundles are Paprwork's sharing format - portable packages containing a mini-app with all its jobs, database schemas, and migrations. Use app bundles to:
- Share complete apps with colleagues or the community
- Version control entire app+job pipelines
- Create reusable app templates
- Distribute apps via GitHub, Dropbox, or file transfer

### App Bundle Tools

| Tool | Purpose |
|------|---------|
| `export_app_bundle` | Package an app with its jobs and schemas into a portable app bundle |
| `import_app_bundle` | Install an app bundle from a local path or GitHub URL |
| `list_app_bundles` | List all installed app bundles |
| `get_app_bundle_info` | Preview app bundle contents without importing |

### Exporting an App Bundle

Use `export_app_bundle` to create a shareable app bundle:

```javascript
export_app_bundle({
  appId: "app-twitter-dashboard",
  name: "Twitter Intelligence Suite",
  version: "1.0.0",
  description: "Analyze Twitter trends and engagement",
  // jobIds auto-detected from app's linked data sources if omitted
  // + full pipeline auto-discovered via dependsOn/runtimeCalls chains
})
```

**Automatic pipeline discovery:** When jobIds are omitted, the tool discovers ALL related jobs via three methods:
1. **Data-source links** — jobs whose databases the app queries (from `data-sources.json`)
2. **Source code scanning** — scans the app's JS/TS/HTML files for job IDs referenced directly in code (e.g. `const JOB_ID = "uuid"` used with `fetch('/api/jobs/run', ...)`)
3. **Dependency walking** — recursively follows `dependsOn` and `runtimeCalls` chains from all discovered jobs to find upstream pipeline jobs

For example, if the app has a data-source link to a "Summarizer" job plus `const REFRESH_JOB_ID = "uuid"` in its code, and the Summarizer has `dependsOn: [{ jobId: "calendar-reader", onStatus: "completed", autoTrigger: true }]`, ALL THREE jobs are included automatically. Check `resolvedJobIds` in the tool result to see the complete list.

**What gets created:**
```
~/Papr/bundles/{bundle-id}/
├── manifest.json      # App + job metadata, schemas, versions
├── README.md          # Auto-generated installation guide
├── .gitignore         # Excludes large data files
├── apps/{appId}/      # Mini app HTML/CSS/JS/TS files
└── jobs/{jobId}/      # Job code, migrations
    ├── code/
    └── migrations/    # SQL schema migrations
```

**Automatic privacy scrub:** The export tool automatically removes private data after copying:
- Databases: `*.db`, `*.db-shm`, `*.db-wal`, `*.sqlite`, `*.sqlite3`
- Logs: `*.log`, `logs/` directories
- Build artifacts: `venv/`, `.venv/`, `__pycache__/`, `node_modules/`
- History: `.versions/`, `data/` directories

The scrub report is included in the tool result — always review it and tell the user what was removed.

**Auto-detection:** If you don't specify `jobIds`, the tool automatically includes all jobs linked to the app via `data-sources.json`.

### Importing an App Bundle

**From local path:**
```javascript
import_app_bundle({
  source: "~/Downloads/twitter-dashboard-bundle"
})
```

**From GitHub URL:**
```javascript
import_app_bundle({
  source: "github.com/username/papr-twitter-dashboard"
})
// Also works: https://github.com/username/repo
```

**Conflict handling:**
- By default (`renameConflicts: true`), import proceeds even if app/job IDs exist
- Set `renameConflicts: false` to block import on conflicts
- Manual rename via `update_job` if needed after import

### Sharing Workflow — Publish to the Paprwork Community

**IMPORTANT:** When users want to publish/share a mini-app, publish it to the official **paprwork-community-apps** repo so it appears in the Community Apps tab for all Paprwork users.

**1. Call the `export_app_bundle` tool (REQUIRED — do NOT manually create bundles):**
```javascript
export_app_bundle({
  appId: "app-reddit-studio",
  name: "Reddit Studio",
  version: "1.0.0",
  description: "Reddit analytics dashboard"
  // jobIds auto-detected if omitted
  // includeData: true  ← only if user explicitly wants to share data files
})
```
**You MUST use this tool.** Do NOT manually copy files, create manifest.json, or assemble the bundle structure by hand. The tool handles everything: copying app + job files, generating manifest.json, README.md, .gitignore, automatically scrubbing private data, running a portability check, and **automatically discovering the full job pipeline** (scans app source for job IDs, walks dependsOn + runtimeCalls chains — all related jobs are included, not just the directly linked ones). Check `resolvedJobIds` in the tool result to see all jobs that were included.

**2. Fix portability warnings (REQUIRED — fix source, then re-export):**
The tool automatically scans all text files and job commands for hardcoded user-specific paths like `/Users/john/...` or `/home/john/...`. If the portability report has warnings:

**CRITICAL: To fix job commands, you MUST use `update_job` — do NOT use `sed`, `bash`, or edit job files directly.** The export tool reads job commands from the job's database record (stored state), NOT from files on disk. If you edit the file with `sed`, the export will still contain the old hardcoded command.

Fix workflow:
1. Use `update_job({ jobId, command: "fixed command with $JOB_DIR/..." })` to fix the job command
2. Use `write_job_file` if any job script files have hardcoded paths
3. Delete the old bundle (if it exists)
4. Re-run `export_app_bundle` — the new export will read the fixed command from the job record

Common replacements:
- `/Users/john/PAPR/jobs/{jobId}/data/data.db` → `$JOB_DIR/data/data.db`
- `/Users/john/PAPR/jobs/{jobId}/...` → `$JOB_DIR/...`
- `/Users/john/PAPR/...` → `$HOME/PAPR/...` or relative paths

**Paprwork runtime environment variables** (set automatically for every job run):
- `$JOB_DIR` — absolute path to the job's own directory (e.g. `~/Papr/jobs/{jobId}`)
- `$JOB_DB` — absolute path to the job's SQLite database (`$JOB_DIR/data/data.db`)
- These work for ALL job types: bash, python, node, swift, agent, and subagent
- **Always use `$JOB_DIR` and `$JOB_DB` instead of hardcoded paths** — this makes jobs portable across machines

**Note:** `data-sources.json` absolute `dbPath` values are automatically cleaned during export (resolved from `jobId` at import time). No manual fix needed for those.

**3. Privacy verification (REQUIRED before publishing):**
After export, always:
- Review the scrub report and tell the user what was auto-removed
- Ask the user: "Would you like me to verify no private data remains, or did you want to include any data files?"
- If they want data included: re-export with `includeData: true` — this skips the scrub and keeps databases, logs, etc. Only do this when the user explicitly asks.
- If they want verification: scan remaining files (especially migration SQL, config files, any `.txt`/`.md` files) for personal info, meeting notes, transcripts, names, emails, etc.
- Only proceed to publishing after user confirms

**4. Fork & clone the community repo (NEVER clone the main repo directly):**
```bash
# Fork to user's GitHub account and clone the fork — this ensures they
# can only push to their own fork, never to the main repo.
gh repo fork Papr-ai/paprwork-community-apps --clone --remote -- /tmp/paprwork-community-apps
cp -r ~/Papr/bundles/{bundleId} /tmp/paprwork-community-apps/bundles/{bundleId}
```
**SECURITY: Always use `gh repo fork`, never `git clone` on the main repo.** This prevents any possibility of pushing changes directly to the main repo (deleting other apps, modifying other entries, etc.). The PR review process on the upstream repo is the only way changes get merged.

**5. Add entry to registry.json (only YOUR new entry — do NOT modify or remove existing entries):**

**PREFERRED:** Use the pre-built `registryEntry` JSON from the `export_app_bundle` tool result. It already has the correct types for all array fields (`requirements`, `platform`). Just fill in `author` (run `gh api user -q .login`) and `tags`, then append it to the `bundles` array.

**Manual fallback** (if registryEntry not available): Edit `/tmp/paprwork-community-apps/registry.json` and add a new entry to the `bundles` array:
```json
{
  "bundleId": "my-app-name",
  "name": "My App Name",
  "description": "What this app does",
  "version": "1.0.0",
  "author": "<result of: gh api user -q .login>",
  "tags": ["category1", "category2"],
  "minPaprworkVersion": "2.0.0",
  "path": "bundles/my-app-name",
  "icon": "<svg>...</svg>",
  "requirements": ["OPENAI_API_KEY"],
  "platform": ["macos"]
}
```

**Registry entry fields (Zod-validated — entries that fail are silently dropped):**
- `bundleId`: string, min 1 char (kebab-case, must match folder name)
- `name`: string, min 1 char (human-readable display name)
- `description`: string, min 1 char (1-2 sentence description)
- `version`: string, min 1 char (semver, e.g. "1.0.0")
- `author`: string, min 1 char (the user's actual GitHub username — run `gh api user -q .login` to get it, NEVER hardcode "paprwork-team" or guess)
- `tags`: string[] (category tags shown as chips, e.g. `["finance", "data"]`)
- `minPaprworkVersion`: string, min 1 char (e.g. "2.0.0")
- `path`: string (always `bundles/{bundleId}`)
- `icon`: string, optional (SVG string or emoji)
- `requirements`: string[], optional (flat string array — e.g. `["OPENAI_API_KEY", "Python 3.8+"]`)
- `platform`: string[], optional (auto-detected — e.g. `["macos"]` or `["macos", "windows", "linux"]`). Use the `detectedPlatform` from the export tool result. Values: `"macos"`, `"windows"`, `"linux"`. Defaults to all three if omitted.

**Platform auto-detection:** The `export_app_bundle` tool automatically scans for platform-specific indicators:
- **macOS only:** `swift` job type, `.swift` source files, `osascript`, `open -a`, `pbcopy`/`pbpaste`, `brew install`, `defaults write`, `launchctl`, `.app` references
- **Windows only:** `.bat`/`.ps1` scripts, `powershell`, `cmd.exe`, `reg.exe`, `C:\` paths, `choco install`
- **Linux only:** `apt-get`/`apt install`, `systemctl`, `journalctl`, `yum`/`dnf`/`pacman` package managers
If only macOS indicators are found, the bundle is tagged `["macos"]`. If no platform-specific signals are found, it defaults to `["macos", "windows", "linux"]` (cross-platform). Always use the `detectedPlatform` from the tool result in registry.json.

**CRITICAL: `requirements` AND `platform` must be flat string arrays, NOT objects or bare strings.**
```
❌ WRONG (entry will be silently rejected and NOT displayed in Community Apps):
"requirements": [{ "key": "OPENAI_API_KEY", "label": "OpenAI Key", "required": true }]
"platform": "macos"

✅ CORRECT:
"requirements": ["OPENAI_API_KEY"]
"platform": ["macos"]

✅ ALSO CORRECT (no requirements, platform omitted defaults to all):
"requirements": []
```

**6. Commit, push to the fork, and open a PR to upstream:**
```bash
cd /tmp/paprwork-community-apps
git checkout -b add-{bundleId}
git add .
git commit -m "Add {App Name} v1.0.0"
# Push to the user's fork (origin), NOT to upstream
git push -u origin add-{bundleId}
# Open PR from the fork to the upstream repo
gh pr create --repo Papr-ai/paprwork-community-apps --title "Add {App Name}" --body "New community app: {description}"
```

**7. Others discover and import from the Community Apps tab** in Paprwork (no manual URL sharing needed).

### Alternative: Private Sharing via Separate Repo

If the user wants to share privately (not to the community), create a standalone repo:

```bash
cd ~/Papr/bundles/{bundleId}
git init
git add .
git commit -m "Initial release v1.0.0"
gh repo create papr-{app-name} --public --source=.
git push -u origin main
```

Others import with: `import_app_bundle({ source: "github.com/username/papr-{app-name}" })`

### Preview Before Import

Use `get_app_bundle_info` to inspect an app bundle without installing:

```javascript
get_app_bundle_info({
  source: "~/Downloads/app-bundle" // or bundleId for installed bundles
})
```

Returns:
- App metadata (name, description)
- Job specs (type, dependencies)
- Database schemas (tables, columns)
- Version requirements

### List Installed App Bundles

```javascript
list_app_bundles()
```

Shows all app bundles in `~/Papr/bundles/` with:
- Bundle ID, name, version
- Creation date
- Full path

### Best Practices

**Versioning:**
- Use semantic versioning (1.0.0, 1.1.0, 2.0.0)
- Update version on breaking schema changes
- Document changes in README

**Database schemas:**
- Share via migrations, not data.db (reproducible)
- Include sample data in separate seed migration if needed
- Document schema in manifest and README

**Security:**
- Never commit API keys or credentials
- Review job code before export
- .gitignore excludes data.db by default

**Testing:**
- Test import in clean environment
- Verify all jobs run successfully after import
- Check app displays correctly with empty/sample data

### Common Patterns

**Creating app templates:**
```javascript
// 1. Create reference app with best practices
export_app_bundle({ appId: "app-crm-template", name: "CRM Template", ... })

// 2. Share as template
// Users: import_app_bundle({ source: "github.com/org/crm-template" })

// 3. Customize after import
update_job({ jobId: "...", command: "..." })
```

**Versioning an existing app bundle:**
```javascript
// Export with incremented version
export_app_bundle({
  appId: "app-dashboard",
  bundleId: "bundle-dashboard-v2",
  version: "2.0.0",
  description: "Major update: added forecasting job"
})
```

**Forking an app bundle:**
```javascript
// 1. Import original
import_app_bundle({ source: "github.com/user/original" })

// 2. Modify
edit_app_file({ appId: "...", filename: "style.css", ... })
update_job({ jobId: "...", ... })

// 3. Export as new app bundle
export_app_bundle({ appId: "...", bundleId: "my-fork", version: "1.0.0" })
```

---

## Job Folders & Graph

### TL;DR

- **Always** call `get_job_graph()` before creating jobs for an existing pipeline
- Assign `folder` when creating a job using `create_job({ folder: "ingestion", ... })`
- Use `set_job_folder` to assign or move existing jobs
- Folders show as collapsible sections in the UI; apps can filter to their linked jobs

### Folder Conventions

Folders group jobs by **pipeline stage**, not by app. A folder named `ingestion` can feed multiple apps; an app can pull from multiple folders.

| Folder name | Jobs that belong here |
|-------------|----------------------|
| `ingestion` | fetch, sync, import, download |
| `processing` | transform, enrich, aggregate, normalize |
| `reporting` | build PDFs, populate dashboards, compute metrics |
| `notifications` | send emails, Slack messages, webhooks |
| `cleanup` | prune old records, archive data, vacuum |

Avoid naming folders after apps (`sales-dashboard`) — those are linkages, not stages.

### New Tools

| Tool | Purpose |
|------|---------|
| `get_job_graph()` | Full dependency graph + folder groupings + app linkages. Read this before building a pipeline. |
| `list_job_folders()` | Distinct folder names across all jobs. Check this before assigning a new folder name. |
| `set_job_folder(jobId, folder)` | Assign a job to a folder. Omit `folder` to clear. |

### Updated Tools

- `create_job` — new `folder` param: assign folder at creation time
- `update_job` — new `folder` param: reassign after the fact
- `list_jobs` — new `folder` and `appId` filter params

### Workflow for Building a Pipeline

```
1. get_job_graph()                   → understand what already exists
2. list_job_folders()                → see current folder names
3. create_job({ folder: "ingestion", ... })
4. create_job({ folder: "processing", dependsOn: [{ jobId: "...", onStatus: "completed", autoTrigger: true }], ... })
5. link_app_data_source(...)         → wire processing job output to app
```

### How the Graph Works

`~/Papr/data/job-graph.json` is automatically rebuilt after every job create/update/delete. It contains:

```json
{
  "folders": { "ingestion": ["job-id-1"], "processing": ["job-id-2"] },
  "appLinks": { "app-id-1": { "name": "Sales Dashboard", "jobIds": ["job-id-2"] } },
  "edges": [{ "from": "job-id-1", "to": "job-id-2", "onStatus": "completed", "autoTrigger": true }]
}
```

The UI uses this for:
- **App filter chips** — filter the jobs list to only jobs linked to a specific app
- **Folder sections** — collapsible groups in the list view
- **Graph view** — visual DAG showing nodes (jobs), edges (dependsOn), clusters (folders)

## Notes

---

## Mini-App Job Creation (NEW)

**Added:** 2026-03-30

Mini-apps can now create jobs programmatically via `/api/jobs/create`. This enables **lazy job creation patterns** where jobs are created on-demand when needed, rather than pre-creating all possible jobs upfront.

### Why This Matters

**Before:** You had to pre-create all possible jobs, even if they might never be used
- LinkedIn Autopilot: Pre-create all 7 action jobs (view_profile, endorse, etc.) even if campaigns only use 2
- User workflows: Can't create jobs based on user configuration in the UI

**After:** Create jobs dynamically when needed
- LinkedIn Autopilot: Create "view_profile" job only when a campaign adds that action type
- Data pipeline builders: User configures scraper in UI → app creates the job
- Workflow generators: Generate job chains based on user input

### API Specification

```typescript
POST /api/jobs/create
Content-Type: application/json

{
  name: string;              // Job display name
  type: "shell" | "bash" | "node" | "python" | "swift" | "agent" | "subagent";
  folder?: string;           // Group label (e.g. "ingestion")
  command?: string;          // Command to execute
  requirements?: string[];   // Python/Node packages
  dependsOn?: Array<{        // Dependencies
    jobId: string;
    onStatus: "completed" | "failed";
    autoTrigger?: boolean;
  }>;
  schedule?: {
    enabled: boolean;
    cron?: string;
    intervalMs?: number;
  };
  // ... (all CreateJobInput fields supported)
}

// Response
{
  success: true,
  jobId: string,
  name: string,
  type: string,
  status: string
}
```

### Security & Limits

- **Rate Limited:** 10 jobs/min per app (prevents abuse)
- **Size Limit:** 100KB command maximum
- **Validation:** Full Zod schema validation (same as `create_job` tool)
- **No Privilege Escalation:** Mini-apps already have bash access via `/api/bash/run`

### Example 1: Lazy Job Creation (LinkedIn Autopilot)

```typescript
// app.ts - Check if job exists, create if needed
async function ensureActionJob(actionType: string): Promise<string> {
  // Check if job already exists
  const res = await fetch('/api/jobs/list');
  const { jobs } = await res.json();
  
  const existing = jobs.find(j => 
    j.name === `LinkedIn ${actionType} Action`
  );
  
  if (existing) {
    console.log(`Job exists: ${existing.id}`);
    return existing.id;
  }

  // Create on-demand
  console.log(`Creating ${actionType} job...`);
  const createRes = await fetch('/api/jobs/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `LinkedIn ${actionType} Action`,
      type: "python",
      folder: "linkedin-actions",
      command: `python3 code/${actionType}.py`,
      requirements: ["linkedin-api", "sqlite-utils"],
      schedule: {
        enabled: true,
        intervalMs: 60000 // Every minute
      }
    })
  });

  const { jobId } = await createRes.json();
  console.log(`Created job: ${jobId}`);
  return jobId;
}

// User adds "view_profile" action to campaign
const jobId = await ensureActionJob('view_profile');
// Store mapping: view_profile → jobId in campaigns table
```

### Example 2: User-Configured Pipeline

```typescript
// User configures a data pipeline in the UI
async function createPipeline(config: {
  source: string;
  transform: string;
  destination: string;
}) {
  // Create scraper job
  const scraperRes = await fetch('/api/jobs/create', {
    method: 'POST',
    body: JSON.stringify({
      name: "Pipeline: Scraper",
      type: "python",
      folder: "ingestion",
      command: `python3 code/scrape.py --source ${config.source}`,
      requirements: ["requests", "beautifulsoup4"]
    })
  });
  const { jobId: scraperId } = await scraperRes.json();

  // Create transformer (depends on scraper)
  const transformRes = await fetch('/api/jobs/create', {
    method: 'POST',
    body: JSON.stringify({
      name: "Pipeline: Transform",
      type: "python",
      folder: "processing",
      command: `python3 code/transform.py --type ${config.transform}`,
      requirements: ["pandas"],
      dependsOn: [{
        jobId: scraperId,
        onStatus: "completed",
        autoTrigger: true // Auto-run when scraper finishes
      }]
    })
  });
  const { jobId: transformerId } = await transformRes.json();

  // Create destination job
  const destRes = await fetch('/api/jobs/create', {
    method: 'POST',
    body: JSON.stringify({
      name: "Pipeline: Load",
      type: "bash",
      folder: "processing",
      command: `./load.sh ${config.destination}`,
      dependsOn: [{
        jobId: transformerId,
        onStatus: "completed",
        autoTrigger: true
      }]
    })
  });

  console.log(`Pipeline created: ${scraperId} → ${transformerId} → ${destRes.jobId}`);
  
  // Start the pipeline
  await fetch('/api/jobs/run', {
    method: 'POST',
    body: JSON.stringify({ jobId: scraperId })
  });
}
```

### Example 3: Simple On-Demand Job

```typescript
// Create a job when user clicks "Start Scraping"
async function startScrapingJob() {
  const res = await fetch('/api/jobs/create', {
    method: 'POST',
    body: JSON.stringify({
      name: "Reddit Scraper",
      type: "python",
      command: "python3 code/scraper.py",
      requirements: ["requests", "sqlite-utils"]
    })
  });

  const { jobId } = await res.json();
  
  // Run it immediately
  await fetch('/api/jobs/run', {
    method: 'POST',
    body: JSON.stringify({ jobId })
  });
}
```

### Rate Limit Handling

If you might hit the 10 jobs/min limit, implement retry logic:

```typescript
async function createJobWithRetry(jobConfig, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch('/api/jobs/create', {
      method: 'POST',
      body: JSON.stringify(jobConfig)
    });

    if (res.ok) {
      return await res.json();
    }

    if (res.status === 429) {
      const { error } = await res.json();
      const match = error.match(/Try again in (\d+)s/);
      const waitSeconds = match ? parseInt(match[1]) : 60;
      
      console.log(`Rate limited. Waiting ${waitSeconds}s...`);
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }

    throw new Error((await res.json()).error);
  }
  
  throw new Error('Failed to create job after retries');
}
```

### When to Use

**Use `/api/jobs/create` when:**
- Dynamic job generation based on user input
- Lazy creation patterns (only create when needed)
- User-configured workflows
- Runtime job pipeline construction

**Use agent `create_job` tool when:**
- Initial setup (creating baseline jobs)
- Complex pipelines with many dependencies
- Bulk job creation (>10 jobs)
- Jobs requiring agent reasoning to configure

### Architecture Benefits

**Hybrid Approach = Best of Both Worlds:**
- Pre-create common jobs for reliability
- Use `/api/jobs/create` for dynamic user needs
- No cron overhead for unused jobs
- More flexible, cleaner architecture

---

## Notes

- Guidance is flexible — do not hard-gate progress if the task is simple
- Prefer deterministic script jobs for data generation and agent jobs for reasoning/synthesis
- See `API_KEY_TESTING_PROTOCOL.md` for external API integration protocol
- See `DECISION_TREE_AGENT_CAPABILITIES.md` for choosing the right execution pattern
- See `DELEGATION_STRATEGY.md` for when to use sub-agents vs jobs
