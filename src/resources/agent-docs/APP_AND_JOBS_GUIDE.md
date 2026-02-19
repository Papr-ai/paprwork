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
| `read_app_file` / `edit_app_file` / `list_app_files` | Read, edit, list app files |
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
| `/api/db/query` | POST | Read data from linked SQLite sources |
| `/api/jobs/list` | GET | List all jobs (id, name, type, status) |
| `/api/jobs/status/:jobId` | GET | Poll job status |
| `/api/jobs/run` | POST | Trigger a job (fire-and-forget or wait) |
| `/api/bash/run` | POST | Run a bash command and get stdout/stderr |

> **When a button in a mini-app needs to do backend work** (re-generate content, reset data, call an API, run a script) — use `/api/jobs/run` or `/api/bash/run`. These give mini-apps the same power agents have via `run_job` and `bash`. Do NOT build a separate HTTP server job as a bridge — that is always the wrong approach.

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

**Rule:** use `bash` + `curl` to test, then `edit_app_file` to write the working code into the app. Never use `webview_execute` for this — it's for visual inspection only.

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

- **Read-only**: only `SELECT` and `WITH ... SELECT` are allowed. Any INSERT/UPDATE/DELETE returns HTTP 403.
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
| **API keys** | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. | User keychain → gateway env | Always, every job, automatically |
| **Job config env** | `SUBREDDIT=python`, `MODE=production` | `create_job` / `update_job` command or env | Every run of this job |
| **Runtime params** | `THREAD_ID=abc123`, `ACTION=regen` | `params` field in `/api/jobs/run` | This invocation only — not persisted |

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

### Security note

`/api/bash/run` executes commands on the user's machine with the same permissions as the Gateway process. Only use it in apps you build — never construct the command string from user-controlled input without sanitizing it.

---

## V2 Storage Layout

```
~/PAPR/apps/{appId}/
  index.html            # Entry point (no inline JS)
  style.css             # Liquid Glass styles
  app.ts                # Main entry (TypeScript — auto-transpiled)
  types.ts              # Shared interfaces
  components/           # One component per file (<150 lines each)
  utils/                # Helpers, formatters, API calls
  data-sources.json     # Created by link_app_data_source

~/PAPR/jobs/{jobId}/
  job.json              # Job configuration
  code/                 # Scripts (main.py, main.js, etc.)
  logs/                 # Execution logs
  data/                 # Output files
  data.db               # SQLite database (per job)
  migrations/           # Schema migrations
```

## Job Types

- `shell` / `bash` — Shell commands
- `python` — Python scripts (auto-creates venv, auto-installs requirements)
- `node` — Node.js scripts (auto-installs from package.json)
- `swift` — Swift scripts
- `agent` — AI agent with tool access (autonomous multi-step reasoning)
- `subagent` — Delegated to a sub-agent profile

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

**API keys are available via environment variables:**
- `os.environ['ANTHROPIC_API_KEY']`
- `os.environ['OPENAI_API_KEY']`
- `os.environ['GOOGLE_API_KEY']`

These are inherited from the gateway process — no extra setup needed.

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
~/PAPR/apps/{appId}/
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
- Test with `webview_launch_app` + `webview_snapshot`

#### App Logo / Icon — Shown in Tabs and Favorites

Every mini-app should have a logo. It appears in the tab bar and in the sidebar favorites list. There are two ways to set it:

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

**Tips:**
- If both `icon` param and `<link rel="icon">` are present, the explicit `icon` param wins
- Keep SVGs small (14×14px viewBox), use `stroke="currentColor"` so they adapt to dark/light mode
- The icon shows in: tab bar, sidebar favorites, artifact card preview

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
  command: "python3 code/selector.py",
  dependsOn: [{ jobId: "scraper-id", onStatus: "completed" }]
})
```

```python
# code/selector.py
import os, json, sqlite3, anthropic

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
    model="claude-sonnet-4-5",
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

```javascript
// Job A: Collect data (script)
create_job({ name: "Data Collector", type: "python", ... })

// Job B: Analyze (agent) — runs after A completes
create_job({
  name: "Data Analyzer",
  type: "agent",
  dependsOn: [{ jobId: "data-collector", onStatus: "completed" }],
  ...
})

// Job C: Report (agent) — runs after B
create_job({
  name: "Daily Report",
  type: "agent",
  dependsOn: [{ jobId: "data-analyzer", onStatus: "completed" }],
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
  "dbPath": "~/PAPR/jobs/amplitude-sync/data.db",
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
})
```

**What gets created:**
```
~/PAPR/bundles/{bundle-id}/
├── manifest.json      # App + job metadata, schemas, versions
├── README.md          # Auto-generated installation guide
├── .gitignore         # Excludes large data files
├── apps/{appId}/      # Mini app HTML/CSS/JS/TS files
└── jobs/{jobId}/      # Job code, migrations, SQLite databases
    ├── code/
    ├── migrations/    # SQL schema migrations
    └── data.db        # SQLite database (excluded by .gitignore)
```

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

### Sharing Workflow

**1. Export the app bundle:**
```
Agent: "Export my Reddit Studio app as an app bundle"
```

**2. Push to GitHub:**
```bash
cd ~/PAPR/bundles/reddit-studio
git init
git add .
git commit -m "Initial release v1.0.0"
gh repo create papr-reddit-studio --public --source=.
git push -u origin main
```

**3. Share the URL:**
```
github.com/username/papr-reddit-studio
```

**4. Others import:**
```
Agent: "Import the app bundle from github.com/username/papr-reddit-studio"
```

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

Shows all app bundles in `~/PAPR/bundles/` with:
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
4. create_job({ folder: "processing", dependsOn: [{ jobId: "...", onStatus: "completed" }], ... })
5. link_app_data_source(...)         → wire processing job output to app
```

### How the Graph Works

`~/PAPR/data/job-graph.json` is automatically rebuilt after every job create/update/delete. It contains:

```json
{
  "folders": { "ingestion": ["job-id-1"], "processing": ["job-id-2"] },
  "appLinks": { "app-id-1": { "name": "Sales Dashboard", "jobIds": ["job-id-2"] } },
  "edges": [{ "from": "job-id-1", "to": "job-id-2", "onStatus": "completed" }]
}
```

The UI uses this for:
- **App filter chips** — filter the jobs list to only jobs linked to a specific app
- **Folder sections** — collapsible groups in the list view
- **Graph view** — visual DAG showing nodes (jobs), edges (dependsOn), clusters (folders)

## Notes

- Guidance is flexible — do not hard-gate progress if the task is simple
- Prefer deterministic script jobs for data generation and agent jobs for reasoning/synthesis
- See `API_KEY_TESTING_PROTOCOL.md` for external API integration protocol
- See `DECISION_TREE_AGENT_CAPABILITIES.md` for choosing the right execution pattern
- See `DELEGATION_STRATEGY.md` for when to use sub-agents vs jobs
