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
|   +-- Do you know ALL the steps?
|       +-- YES (known flow + one LLM call) -> Python job with requirements: ["anthropic"]
|       +-- NO (agent must explore/decide)  -> Agent Job (type: "agent")
|
+-- "Automate something" (no AI needed, just scripts)
|   +-- Script Job (python/node/bash)
|       Examples: backup database, process CSV, sync files, ETL pipeline
|
+-- "Create a complete system" (UI + automation + AI)
|   +-- FULL STACK: Mini-app + Job(s) + SQLite + (optional) Sub-agent
|       1. Python job: Collect/process data (with LLM call if needed)
|       2. SQLite: Store structured results (per-job data.db)
|       3. Mini-app: Dashboard to view/filter/manage (link_app_data_source)
|       4. Agent job (optional): Autonomous analysis that needs multi-step reasoning
|
+-- "Help me with something RIGHT NOW"
    +-- delegate_task (sub-agent for immediate help)
        Examples: review code, write blog post, analyze document, summarize research
```

---

## When to Use Each Pattern

### Python/Node Job with LLM Call (MOST COMMON for AI tasks)
- Task has **known steps** but needs **one AI judgment call**
- You control the flow: query DB → call LLM → save results
- Faster, cheaper, more debuggable than agent jobs
- Python gets auto-venv + auto-pip via `requirements` field
- API keys available via `os.environ['ANTHROPIC_API_KEY']` etc.

Examples: "Score 20 threads and pick the best 5" · "Classify 100 emails" · "Summarize today's news"

```javascript
create_job({
  name: "Thread Selector",
  type: "python",
  requirements: ["anthropic"],
  command: "python3 code/selector.py"
})
```

### Agent Job (autonomous, multi-step reasoning)
- Task requires **autonomy** — agent decides what to do next
- Path is **not predetermined** (explores, adapts, iterates)
- Task involves **web browsing** with dynamic navigation
- Agent jobs get auto-injected `JOB_DIR`, `JOB_DB`, `DEP_*` paths

Examples: "Research competitors and write a report" · "Debug why this job keeps failing" · "Find and analyze 10 new leads"

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
| "Score/rank/classify these items" | Python job + LLM call | Agent Job (overkill) |
| "Pick the best 5 from this list" | Python job + LLM call | Agent Job (overkill) |
| "Summarize this data" | Python job + LLM call | Agent Job (overkill) |
| "Research competitors deeply" | Agent Job (needs autonomy) | Python job (can't browse) |
| "Debug why X is failing" | Agent Job (needs iteration) | Script job |
| "Monitor Twitter for mentions" | Agent Job (needs browsing) | Script + API calls |
| "Process CSV files" | Script Job | Agent Job |
| "Review this code now" | Sub-agent (immediate) | Agent Job |
| "Build a CRM" | App + Python jobs + SQLite | Just an app |
| "Analyze this now" | Sub-agent | Agent Job |

## Decision Shortcuts

**Known steps + one AI judgment?** → Python job with `requirements: ["anthropic"]`  
**Agent must explore/decide/iterate?** → Agent Job  
**Has "now/currently/this"?** → Sub-agent (delegate_task)  
**Just data transformation?** → Script Job (Python/Node)  
**Needs UI?** → Add Mini-app (reads from job's SQLite via link_app_data_source)  
**Recurring + UI?** → Full stack: Jobs + SQLite + Mini-app

---

## Common Anti-Patterns

**Do NOT ask for API keys to create sub-agents** — Paprwork has built-in AI agents. Use Agent Jobs.

**Do NOT create sub-agent for recurring tasks** — `delegate_task` executes once. For recurring, use Agent Job with schedule.

**Do NOT use Agent Job when Python + LLM call works** — If you know the steps (query → call LLM → save), use Python. Agent jobs are for autonomous exploration.

**Do NOT create script job when AUTONOMOUS reasoning is needed** — If the agent must decide what to search/fix/explore, use Agent Job.

**Do NOT build a separate backend when SQLite works** — Jobs write to per-job SQLite, apps read via `link_app_data_source`. No API server needed.

---

## Multi-Stage Pipeline Example

```javascript
// Stage 1: Data Collection (python - fast, cheap, deterministic)
create_job({
  name: "Social Scraper",
  type: "python",
  requirements: ["requests", "beautifulsoup4"],
  command: "python3 code/scraper.py",
  schedule: { enabled: true, cron: "0 */6 * * *" }
})

// Stage 2: Analysis (python + LLM - known steps, one AI call)
// NOT an agent job! We know the steps: read DB → call Claude → write results
create_job({
  name: "Sentiment Analyzer",
  type: "python",
  requirements: ["anthropic"],
  command: "python3 code/analyze.py",
  dependsOn: [{ jobId: "<scraper-id>", onStatus: "completed" }]
})

// Stage 3: Deep Research (agent - only if autonomous exploration needed)
create_job({
  name: "Trend Researcher",
  type: "agent",
  dependsOn: [{ jobId: "<analyzer-id>", onStatus: "completed" }],
  deliver: { channel: "chat", targetId: "main" }
})

// Dashboard
create_app({ title: "Social Intelligence" })
link_app_data_source({ appId: "...", jobId: "<scraper-id>", alias: "social" })
```

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
**WRONG:** Requesting external AI API keys · Suggesting paid lead services before trying browser tool

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
**WRONG:** Using `delegate_task` for recurring tasks (it only runs once).
