---
id: preloaded-app-and-jobs-guide
name: App & Jobs Workflow Guide
description: Complete workflow for building Paprwork mini-apps and jobs — stage flow, tools reference, file structure, SQLite integration, job triggering, WebSocket push updates, and anti-patterns. Read this before building any app or job.
---
# App & Jobs Workflow Guide

> **Read this before building any mini-app, job, or app+job pipeline.**
> The REST API reference (endpoints, params, bash, WebSocket) is always in your system prompt. This guide covers the *workflow* — how to sequence the steps correctly.

---

## Golden Rule

> **Mock the UI first, show the user, get approval, THEN build the backend.**
> **Test each piece independently before connecting them.**

---

## Stage Flow (always follow this order)

1. **Prototype UI** — `create_app` with placeholder/hardcoded data. Load the design system skill (`preloaded-paprwork-design-system`) first. Align on all states before writing backend.
2. **Validate upstream data** — Run small probes with `bash` before committing schema. Check real field names, pagination, auth constraints.
3. **Define contracts** — Lock the SQLite write model (what jobs write) and read model (what app queries). Add indexes for app query paths.
4. **Implement jobs** — `create_job` → `run_job` → `read_job_logs`. Adjust schema based on real output.
5. **Wire app to data** — `link_app_data_source`, validate end-to-end with realistic data across all UI states.

If the task is explicit and small, merge steps. Always explain tradeoffs when skipping discovery.

---

## Agent Tools Reference

| Tool | Purpose |
|------|---------|
| `list_apps` | List existing mini-apps — **call first** before creating |
| `create_app` | Create a mini-app with HTML/CSS/JS files |
| `read_app_file` / `edit_app_file` / `list_app_files` | Read, edit, list app source files |
| `list_jobs` | List all jobs — **call first** before creating |
| `create_job` | Create a job (shell/python/node/agent type) |
| `update_job` | Patch job config (command, schedule, deps, env) |
| `run_job` | Execute a job and wait for output |
| `read_job_logs` | Read execution logs for a job |
| `list_job_files` / `read_job_file` / `edit_job_file` | Browse and edit job scripts |
| `link_app_data_source` | Register a job's SQLite DB to an app |
| `read_app_data_sources` | List registered data sources for an app |
| `read_skill` | Load a skill for detailed guidance |

> Mini-app REST APIs (`/api/db/query`, `/api/jobs/run`, `/api/bash/run`, etc.) are always shown in your system prompt — you do not need to look them up.

---

## Job Resilience Quick Reference

When creating jobs, consider resilience needs:

**One-shot jobs (API calls):**
- Add `retries: { maxAttempts: 3, backoffMs: 2000 }`
- Handles rate limits, network timeouts

**Long-running jobs (large datasets):**
- Use `useCheckpointTemplate: true` to generate resumable code
- Add retries for max resilience
- Script saves progress every N items

**Scheduled jobs:**
- Set `catchUpMissed: true` on cron schedules
- Runs missed occurrences on app startup

See full patterns in APP_AND_JOBS_GUIDE.md → "Job Resilience & Patterns"

---

## File Structure

```
~/PAPR/apps/{appId}/
  index.html            # Entry point — NO inline JS, load app.ts as module
  style.css             # Liquid Glass styles
  app.ts                # Main entry (TypeScript — auto-transpiled by gateway)
  types.ts              # Shared interfaces
  components/           # One component per file (<150 lines each)
  utils/                # Helpers, formatters, API calls
  data-sources.json     # Created automatically by link_app_data_source

~/PAPR/jobs/{jobId}/
  job.json              # Config (schedule, type, command, env, deps)
  code/main.py          # (Python) or code/main.js (Node) or code/run.sh (Shell)
  code/requirements.txt # Python dependencies
  data/data.db          # SQLite — job writes here, app reads here
  logs/                 # Execution logs (read with read_job_logs)
```

**index.html must follow this structure:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App Name</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="app.ts"></script>
</body>
</html>
```

---

## SQLite Workflow

### Step 1 — Link data source (agent tool call, done once)
```javascript
link_app_data_source({ appId: "your-app-id", jobId: "your-job-id" })
```

### Step 2 — Inspect schema (optional, from app JS)
```javascript
const { sources } = await fetch('/api/db/schema?appId=APP_ID').then(r => r.json());
// sources[0].tables → [{ table: "threads", columns: [...] }]
```

### Step 3 — Query in app code

No `sourceId` needed — the platform reads the table name from the SQL and automatically opens the correct database. Only pass `sourceId` if two linked sources happen to have a table with the same name.

```typescript
const APP_ID = 'your-app-id';  // hardcode this

async function loadData() {
  const { rows } = await fetch('/api/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: APP_ID,
      sql: 'SELECT * FROM threads ORDER BY score DESC LIMIT 100'
      // No sourceId needed — platform finds which linked DB has "threads"
    })
  }).then(r => r.json()) as { rows: Thread[] };
  return rows;
}
```

### Step 4 — Write from app code (UPDATE / INSERT / DELETE)

Use `/api/db/write` when the app needs to update state directly — marking items, resetting status, inserting user actions.

```typescript
// UPDATE — e.g. mark a thread as selected before triggering a job
const { changes } = await fetch('/api/db/write', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appId: APP_ID,
    sql: 'UPDATE threads SET status = ? WHERE id = ?',
    params: ['selected', threadId]   // always use ? placeholders + params array
  })
}).then(r => r.json()) as { changes: number };

// INSERT
const { lastInsertRowid } = await fetch('/api/db/write', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appId: APP_ID,
    sql: 'INSERT INTO actions (thread_id, action, created_at) VALUES (?, ?, datetime("now"))',
    params: [threadId, 'regenerate']
  })
}).then(r => r.json()) as { lastInsertRowid: number };
```

**Security:** Only `INSERT`, `UPDATE`, `DELETE`, `REPLACE` allowed — SELECT and DDL blocked. Only databases linked via `link_app_data_source`. Always use `params` array with `?` placeholders, never interpolate user input.

**Write vs trigger a job:** Use `/api/db/write` for direct state changes the app owns (select, flag, delete). Use `/api/jobs/run` when the change requires backend processing (LLM call, API call, complex logic).

---

## Job Types (choose correctly)

| Type | Use for | Example |
|------|---------|---------|
| `python` | Scripts with logic, API calls, data processing, ML | `command: "python3 code/main.py --token ${GITHUB_TOKEN}"` |
| `bash` | Simple shell one-liners | `command: "curl -H 'Authorization: Bearer ${KEY}' ..."` |
| `node` | Node.js/TypeScript scripts | `command: "node code/main.js --api-key ${KEY}"` |

**Use `type: "python"` when:** The job has multi-step logic, API calls, data processing, or needs pip packages. Pass API keys as CLI arguments in the command.

**Use `type: "bash"` when:** The job is a simple command or one-liner (curl, git, jq). Keys go directly in the command string.

---

## API Keys in Jobs

**Custom API keys (from Settings) are NOT in the job environment.** Pass them as CLI arguments:

```javascript
// ✅ Python job — keys as CLI args
create_job({
  name: "GitHub Sync",
  type: "python",
  command: "python3 code/fetch.py --github-token ${GITHUB_TOKEN}",
  requirements: ["requests"]
})
```

```python
# code/fetch.py
import argparse
parser = argparse.ArgumentParser()
parser.add_argument('--github-token', required=True)
args = parser.parse_args()
token = args.github_token  # ✅ Receives actual value
```

**❌ Do NOT:** Put `${GITHUB_TOKEN}` in the Python file. Substitution happens in the command string only.

**❌ Do NOT:** Use `os.getenv('GITHUB_TOKEN')` for custom keys — they are not in the environment.

**Runtime params** (THREAD_ID, ACTION, etc.) ARE in the environment — use `os.environ.get('THREAD_ID')` for those.

---

## Job Design Principles

When a job will be triggered by a button click:
1. **Idempotent** — running twice on same input produces same result
2. **Write to SQLite** — app re-queries after completion, no other IPC needed
3. **Fast** (<30s) — long jobs should update a `status` column in SQLite so app shows progress
4. **Three environment layers** — don't confuse them:

| Layer | Set by | Available in job |
|-------|--------|-------------------|
| API keys (custom from Settings) | `create_job` command | Pass as CLI args: `--token ${KEY_NAME}` |
| Job config env (`SUBREDDIT=python`) | `create_job` / `update_job` | `os.environ`, `$VAR` |
| Runtime params (`THREAD_ID=abc123`) | `params` in `/api/jobs/run` | `os.environ.get('THREAD_ID')`, `$THREAD_ID` |

Runtime params: `os.environ.get('THREAD_ID')`. API keys: pass via CLI args, parse with `argparse`.

---

## Job Triggering Patterns

**Three ways a job can send data back to the app:**

| Output type | Pattern | How job delivers |
|-------------|---------|-----------------|
| Short text (draft, answer, summary) | `wait: true` → `lastOutput` | `print()` / `echo` to stdout |
| Structured data (lists, records) | SQLite + WebSocket push | Write to `data.db` |
| Simple status | WebSocket `jobs:status-changed` | Just completing the job |

### Pattern 1: Inline output — job prints, app reads directly (simplest for short responses)

Use when the job produces a short text result (a draft, a summary, an answer). The job's stdout is captured and returned in the HTTP response — no SQLite, no WebSocket needed.

**Job config** (API key via CLI arg, runtime param via env):
```javascript
create_job({
  name: "Draft Generator",
  type: "python",
  command: "python3 code/main.py --anthropic-key ${ANTHROPIC_API_KEY}",
  requirements: ["anthropic"]
})
```

**Job script:**
```python
# Python job — API key from argparse, runtime param from os.environ
import json, os, argparse

parser = argparse.ArgumentParser()
parser.add_argument('--anthropic-key', required=True)
args = parser.parse_args()

thread_id = os.environ.get('THREAD_ID', '')  # Runtime param — from /api/jobs/run params
draft = generate_reply(thread_id, args.anthropic_key)  # API key from CLI
print(json.dumps({ "draft": draft, "threadId": thread_id }))
```

**App code:**
```typescript
const res = await fetch('/api/jobs/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jobId: JOB_ID, wait: true, params: { THREAD_ID: id } })
});
const { status, lastOutput, error } = await res.json() as {
  status: string; lastOutput?: string; error?: string;
};
if (status === 'completed' && lastOutput) {
  const result = JSON.parse(lastOutput) as { draft: string; threadId: string };
  showDraft(result.draft);
}
```

`lastOutput` is also included in the WebSocket `jobs:status-changed` event, so fire-and-forget + WebSocket push works too.

### Pattern 2: Structured data — job writes to SQLite, app re-queries (preferred for dashboards/lists)

```typescript
const JOB_ID = 'your-job-id';

// Set up once on app load — WebSocket notifies when any job completes
const ws = new WebSocket('ws://localhost:18789');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data) as {
    type: string;
    data?: { jobId: string; status: string; lastOutput?: string };
  };
  if (msg.type === 'jobs:status-changed' && msg.data?.jobId === JOB_ID
      && (msg.data.status === 'completed' || msg.data.status === 'failed')) {
    loadData();  // re-query /api/db/query and re-render
  }
};

// Trigger the job (fire-and-forget — WebSocket handles completion)
async function triggerJob(params?: Record<string, string>) {
  await fetch('/api/jobs/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: JOB_ID, params })
  });
}
```

### Pattern 3: Polling (fallback when WebSocket unavailable)

```typescript
async function pollJob(jobId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const { status } = await fetch(`/api/jobs/status/${jobId}`).then(r => r.json()) as { status: string };
    if (status === 'completed' || status === 'failed') return status;
  }
  return 'timeout';
}
```

### Button loading state pattern

```typescript
let isRunning = false;

async function handleClick() {
  if (isRunning) return;
  isRunning = true;
  btn.textContent = '⏳ Working...';
  btn.disabled = true;
  try {
    await triggerJob({ THREAD_ID: selectedId });
    // If using wait:true with lastOutput, handle the result inline
    // If using WebSocket push, loadData() is called automatically by ws.onmessage
  } catch (err) {
    showError((err as Error).message);
    isRunning = false;
    btn.textContent = '↺ Retry';
    btn.disabled = false;
  }
}

// Called by WebSocket handler on completion
function onJobComplete() {
  loadData();
  isRunning = false;
  btn.textContent = '↺ Regen';
  btn.disabled = false;
}
```

---

## Quick Reference: Common Bash Operations from App

```typescript
// ✅ Write to linked SQLite — use /api/db/write (scoped, safe, no path knowledge needed)
await fetch('/api/db/write', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appId: APP_ID,
    sql: "UPDATE items SET status = ? WHERE id = ?",
    params: ['pending', id]   // always parameterize — never interpolate user input
  })
});

// Use /api/bash/run only for things /api/db/write can't do (e.g. unlinked databases, file ops)


// Check if a file exists or read its content
const { stdout } = await fetch('/api/bash/run', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ command: 'cat "$HOME/PAPR/jobs/JOB_ID/data/output.json"' })
}).then(r => r.json()) as { stdout: string };
```

**Security:** Never pass raw user input directly into the command string — sanitize first.

---

## Anti-Patterns (never do these)

```javascript
// ❌ Using bash job for Python script with API calls
create_job({ type: "bash", command: "pip3 install requests && python3 fetch.py" })
// → Use type: "python" for scripts. Bash jobs don't get venv or proper key injection.

// ❌ Putting ${KEY_NAME} in Python source code
// code/main.py: token = "${GITHUB_TOKEN}"
// → Substitution only works in the command string. Use argparse + CLI args.

// ❌ Using os.getenv for custom API keys
// Python: token = os.getenv('GITHUB_TOKEN')
// → Custom keys from Settings are NOT in env. Pass as CLI args.

// ❌ Building a separate HTTP server job as a bridge
create_job({ name: "api-bridge", type: "node", command: "node server.js" })
// → fragile, port conflicts, completely unnecessary — use /api/jobs/run directly

// ❌ File-based IPC
window.__papr_write_file(...)    // doesn't exist
localStorage.setItem('req', id)  // agent process can't read browser localStorage

// ❌ Hitting an unknown path and concluding "no REST API" because you get HTML
fetch('/api/regen')  // → HTML (SPA catch-all) → wrong conclusion
// → test with curl bash first: curl http://localhost:18789/health

// ❌ Using webview_execute to test API calls
webview_execute({ script: "fetch('/api/jobs/run', ...)" })
// → webview_execute is for VISUAL INSPECTION only — edit app source files directly

// ❌ Node.js imports in browser JS
import Database from 'better-sqlite3'  // browser can't use Node modules

// ❌ Polling when WebSocket push is available
setInterval(() => fetch('/api/jobs/status/...'), 1000)
// → set up ws.onmessage listener instead
```

---

## Job Schema Patterns

### Write pattern (job side)
```python
import sqlite3, os

db_path = os.path.join(os.environ['JOB_DIR'], 'data', 'data.db')
conn = sqlite3.connect(db_path)
conn.execute('''CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT DEFAULT 'pending',
  result TEXT,
  updated_at TEXT
)''')
conn.execute("CREATE INDEX IF NOT EXISTS idx_status ON items(status)")
conn.commit()
```

### Read pattern (app side)
```typescript
// Always add ORDER BY + LIMIT for performance
const { rows } = await fetch('/api/db/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appId: APP_ID,
    sql: 'SELECT id, title, status, result FROM items WHERE status != ? ORDER BY updated_at DESC LIMIT 200',
    params: ['archived']
  })
}).then(r => r.json()) as { rows: Item[] };
```

---

## Key Checklist Before Shipping

- [ ] `list_apps` called before `create_app` (avoid duplicates)
- [ ] `list_jobs` called before `create_job` (avoid duplicates)
- [ ] `list_keys` called before jobs that need API keys
- [ ] Job type correct: `python` for scripts, `bash` for one-liners
- [ ] Python jobs with API keys: command uses `--token ${KEY_NAME}`, script uses argparse
- [ ] Design system loaded (`read_skill({ skillId: "preloaded-paprwork-design-system" })`)
- [ ] `link_app_data_source` called after job has run at least once
- [ ] App uses APP_ID constant (not hardcoded string scattered everywhere)
- [ ] Job uses `JOB_DIR` env var for all file paths (not hardcoded `~/PAPR/...`)
- [ ] Button has loading/disabled state during job execution
- [ ] WebSocket listener set up for job completion push
- [ ] Error states handled in UI (not just happy path)
- [ ] Tested with `curl` or `bash` probe before wiring into app
