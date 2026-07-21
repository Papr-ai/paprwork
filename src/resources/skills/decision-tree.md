---
id: preloaded-decision-tree
name: Agent Capability Decision Tree
description: How to choose the right Paprwork pattern for any task — Agent Job vs Python Job vs Script Job vs Sub-agent vs Mini-app vs delegate_task. Includes correct/wrong examples for common scenarios.
---
# Agent Capability Decision Tree

Use this when you need to decide which execution pattern to use for a user request.

---

## Quick Decision Tree

```
User wants to build something?
|
+-- "Create an app/dashboard/UI"
|   +-- Does it need background data?
|       +-- YES -> Mini-app + Job + SQLite (read preloaded-app-and-jobs-guide)
|       +-- NO  -> Just create_app
|
+-- "Automate something with AI" (recurring/scheduled)
|   +-- DEFAULT -> Agent Job (type: "agent")
|       Built-in OAuth/API routing, tools, delivery, recipes — no LLM SDK boilerplate
|   +-- EXCEPTION: Fixed batch pipeline only?
|       +-- YES (read known data → single LLM call → write SQLite, no tools/exploration)
|           -> Python job with requirements: ["anthropic"] — rare, last resort
|       +-- NO -> Agent Job
|
+-- "Automate something" (no AI needed, just scripts)
|   +-- Script Job (python/node/bash)
|       Examples: backup database, process CSV, sync files, ETL pipeline
|
+-- "Create a complete system" (UI + automation + AI)
|   +-- FULL STACK: Mini-app + Job(s) + SQLite + (optional) Agent job
|       1. Python job: Collect/process data (deterministic scraping, ETL — no LLM)
|       2. Agent job: AI analysis, classification, summarization, research
|       3. SQLite: Store structured results (per-job data.db)
|       4. Mini-app: Dashboard to view/filter/manage (link_app_data_source)
|
+-- "Help me with something RIGHT NOW"
    +-- delegate_task (sub-agent for immediate help)
        Examples: review code, write blog post, analyze document, summarize research
|
+-- "Run this once" (probe API, peek sqlite, quick script, no rerun)
    +-- bash tool — NOT create_job
        Examples: curl an endpoint, inspect JSON shape, test auth, one sqlite query
        Promote to create_job ONLY when: schedule, app button, named rerun, or pipeline
```

---

## Bash Tool vs create_job

| Use `bash` | Use `create_job` |
|------------|------------------|
| One-time probe or fix in this chat | User/app will trigger again |
| Explore before committing schema | Schedule (cron / interval) |
| Completes in <60s, no history needed | Linked to mini-app (`appIds`) |
| | Multi-step `dependsOn` pipeline |

**Wrong:** `create_job({ type: "python", command: "curl …" })` for a single API check you'll never rerun.
**Right:** `bash({ command: "curl …" })` first; create a job when reuse justifies it.

---

## When to Use Each Pattern

### Agent Job (DEFAULT for AI tasks)
- **Default choice** for any recurring task that needs AI reasoning
- Built-in **OAuth/subscription routing** — no anthropic/openai Python packages or API key boilerplate
- Full **tool access** (bash, read_file, write_file, browser)
- **Delivery**, **recipes**, **retries**, and **scheduling** built in
- Agent jobs get auto-injected `JOB_DIR`, `JOB_DB`, `DEP_*` paths

Examples: "Score 20 threads and pick the best 5" · "Classify 100 emails" · "Summarize today's news" · "Research competitors" · "Debug why this job keeps failing"

```javascript
create_job({
  name: "Thread Selector",
  type: "agent",
  command: "Read threads from $JOB_DB, score them, and save the top 5 back to $JOB_DB",
  provider: "anthropic",
  schedule: { enabled: true, cron: "0 9 * * *" }
})
```

`create_job` returns `_agentJobReminder` if you add LLM SDK packages (`anthropic`, `openai`, etc.) to a script job — switch to `type: "agent"`.

### Python/Node Job with Direct LLM Call (RARE EXCEPTION)
- **Only** when ALL are true: fully fixed steps, exactly one LLM call, known I/O shapes, no tools/browsing
- If any condition is false → use **Agent Job**

```javascript
// ONLY for fixed batch pipelines — prefer agent job in most cases
create_job({
  name: "Batch Classifier",
  type: "python",
  requirements: ["anthropic"],
  command: "python3 code/classify.py --api-key ${ANTHROPIC_API_KEY}"
})
```

### Pure Script Job (deterministic, no AI)
- Fully **deterministic** (no AI reasoning needed)
- Heavy computation, data transformation, file processing
- API calls with known shapes, ETL pipelines, backups

Examples: "Process CSV files" · "Backup database every night" · "Sync data from API"

### Sub-Agent / delegate_task (immediate, one-time)
- User needs help **right now** in conversation
- Task is **one-time or ad-hoc**
- Result should appear **in chat**

Examples: "Review this code for bugs" · "Write a blog post about X" · "Summarize these 10 documents"

### Mini-App + Job + SQLite (complete system)
- User wants **complete system** with UI
- Background job **collects/processes data**
- App **displays** data with filtering/search

Examples: "Create a lead management system" · "Build a social media tracker" · "Make an email triage dashboard"

---

## Key Patterns Table

| User Says | Use This | NOT This |
|-----------|----------|----------|
| "Score/rank/classify these items" | Agent Job | Python + LLM SDK |
| "Pick the best 5 from this list" | Agent Job | Python + LLM SDK |
| "Summarize this data" | Agent Job | Python + LLM SDK |
| "Research competitors deeply" | Agent Job (needs autonomy) | Python job (can't browse) |
| "Debug why X is failing" | Agent Job (needs iteration) | Script job |
| "Monitor Twitter for mentions" | Agent Job (needs browsing) | Script + API calls |
| "Process CSV files" | Script Job | Agent Job |
| "Review this code now" | Sub-agent (immediate) | Agent Job |
| "Build a CRM" | App + Jobs + SQLite | Just an app |
| "Analyze this now" | Sub-agent | Agent Job |
| "Batch-classify 50K frozen rows" | Python + LLM (exception) | Agent Job (expensive) |

## Decision Shortcuts

**Needs AI reasoning (default)?** → Agent Job (`type: "agent"`)  
**Fixed batch: read DB → one LLM call → write DB, no tools?** → Python + LLM (rare exception)  
**Agent must explore/decide/iterate?** → Agent Job  
**Has "now/currently/this"?** → Sub-agent (delegate_task)  
**Just data transformation?** → Script Job (Python/Node)  
**Needs UI?** → Add Mini-app (reads from linked SQLite via `create_job({ appIds })` auto-link or `attach_database`)  
**Recurring + UI?** → Full stack: Jobs + SQLite + Mini-app

---

## Common Anti-Patterns

**Do NOT create Python/Node jobs that call OpenAI/Anthropic directly** — Use `type: "agent"`. `create_job` warns with `_agentJobReminder` when it detects LLM SDK packages on script jobs.

**Do NOT ask for API keys to create sub-agents or agent jobs** — Paprwork has built-in OAuth/API routing.

**Do NOT create sub-agent for recurring tasks** — `delegate_task` executes once. For recurring, use Agent Job with schedule.

**Do NOT use Python + LLM when an agent job would work** — Agent jobs are the default for AI. Python + LLM is only for rigid batch pipelines.

**Do NOT create script job when AUTONOMOUS reasoning is needed** — If the agent must decide what to search/fix/explore, use Agent Job.

**Do NOT build a separate backend when SQLite works** — Jobs write to `$APP_DB` / `$JOB_DB`; apps read via `/api/db/*`. `create_job({ appIds })` auto-links — manual `link_app_data_source` only as fallback.

---

## Multi-Stage Pipeline Example

```javascript
// Stage 1: Data Collection (python - deterministic, no LLM)
create_job({
  name: "Social Scraper",
  type: "python",
  requirements: ["requests", "beautifulsoup4"],
  command: "python3 code/scraper.py",
  schedule: { enabled: true, cron: "0 */6 * * *" }
})

// Stage 2: Analysis (agent job — DEFAULT for AI)
create_job({
  name: "Sentiment Analyzer",
  type: "agent",
  command: "Read new posts from $DEP_<scraper-id>_DB, classify sentiment, write results to $JOB_DB",
  provider: "anthropic",
  dependsOn: [{ jobId: "<scraper-id>", onStatus: "completed", autoTrigger: true }]
})

// Stage 3: Deep Research (agent — multi-step exploration)
create_job({
  name: "Trend Researcher",
  type: "agent",
  command: "Research emerging trends from analyzed posts and write a weekly brief to $JOB_DB",
  dependsOn: [{ jobId: "<analyzer-id>", onStatus: "completed", autoTrigger: true }],
  deliver: { channel: "chat", targetId: "main" }
})

// Dashboard
create_app({ title: "Social Intelligence" })
link_app_data_source({ appId: "...", jobId: "<scraper-id>", alias: "social" })
```

**When to use Python + LLM in a pipeline (rare):** Only when you have 10K+ identical rows, a frozen prompt template, zero tool use, and need strict per-call cost accounting.

---

## Correct/Wrong Examples by Scenario

### Lead Generation

**CORRECT:**
```javascript
create_job({
  name: "Lead Finder", type: "agent",
  task: "Search LinkedIn, Crunchbase for companies matching ICP. Extract company name, website, size, industry, contact. Score 1-10 based on ICP fit. Save to SQLite.",
  tools: ["browser", "bash"],
  schedule: "0 9 * * *"
})
create_app({ title: "Lead Manager" })
link_app_data_source({ appId: "lead-manager", jobId: "lead-finder", alias: "leads" })
```
**WRONG:** Requesting external AI API keys · Suggesting paid lead services before trying browser tool · Python job with `requirements: ["anthropic"]`

### Social Media Monitoring

**CORRECT:**
```javascript
create_job({
  name: "Twitter Monitor", type: "agent",
  task: "Monitor @mentions and hashtags. Extract text, author, engagement, sentiment. Alert if viral post detected.",
  tools: ["browser", "bash"],
  schedule: "0 * * * *",
  deliver: { channel: "chat", targetId: "main" }
})
```
**WRONG:** Building Python scraper from scratch when agent can browse directly.

### Code Review (One-time)

**CORRECT:**
```javascript
delegate_task({
  task: "Review ~/project/auth.js for security vulnerabilities",
  agentId: "implementation-specialist"
})
```
**WRONG:** Creating an Agent Job for a one-time request.

### External API Integration

**CORRECT:**
```javascript
// Step 1: Test API first (load preloaded-api-key-testing skill)
// bash: curl -H "Authorization: Bearer ${ATTIO_KEY}" "https://api.attio.com/v2/lists" | jq '.data[0:3]'

// Step 2: After validating fields, create job
create_job({
  name: "Attio CRM Sync", type: "python",
  command: "python code/main.py",
  schedule: "0 */6 * * *",
  retries: { maxAttempts: 3, backoffMs: 5000 }
})
```
**WRONG:** Hardcoding API keys · Building job before testing API response shape

### Email Triage

**CORRECT:**
```javascript
create_job({
  name: "Email Triage", type: "agent",
  task: "Check unread emails via AppleScript. Categorize urgent/important/routine. For urgent: extract sender, subject, key points. Deliver summary.",
  tools: ["bash"],
  schedule: "0 8,12,16 * * 1-5",
  deliver: { channel: "chat", targetId: "main" }
})
```
**WRONG:** Using `delegate_task` for recurring tasks (it only runs once) · Python job calling Anthropic directly.
