# Decision Tree: Choosing the Right Paprwork V2 Capability

This guide helps the agent decide which tool or approach to use for different user requests.

## Quick Decision Tree

```
User wants to build something?
|
+-- "Create an app/dashboard/UI"
|   +-- Does it need background data?
|       +-- YES -> Mini-app + Job + SQLite (see APP_AND_JOBS_GUIDE.md)
|       +-- NO  -> Just create_app
|
+-- "Automate something with AI" (recurring/scheduled)
|   +-- Do you know ALL the steps?
|       +-- YES (known flow + one LLM call) -> Python job with requirements: ["anthropic"]
|       +-- NO (agent must explore/decide) -> Agent Job (type: "agent")
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

## When to Use Each Pattern

### Python/Node Job with LLM Call (MOST COMMON for AI tasks)
- Task has **known steps** but needs **one AI judgment call**
- You control the flow: query DB → call LLM → save results
- Faster, cheaper, more debuggable than agent jobs
- Python gets auto-venv + auto-pip via `requirements` field
- API keys available via `os.environ['ANTHROPIC_API_KEY']` etc.

Examples:
- "Score 20 threads and pick the best 5" (SQL → one Claude call → save)
- "Classify 100 emails by category" (read emails → one LLM call → write DB)
- "Summarize today's news" (fetch RSS → one LLM call → write summary)
- "Extract entities from documents" (read files → LLM call → save to DB)

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
- Path is **not predetermined** (agent explores, adapts, iterates)
- Task involves **web browsing** with dynamic navigation
- Task needs **tool access** (bash, read_file, write_file)
- Agent jobs get auto-injected `JOB_DIR`, `JOB_DB`, `DEP_*` paths

Examples:
- "Research competitors and write a report" (agent decides what to search)
- "Debug why this job keeps failing" (agent reads logs, tries fixes)
- "Set up monitoring for website changes" (agent explores site structure)
- "Find and analyze 10 new leads" (agent browses, evaluates, decides)

### Pure Script Job (deterministic, no AI)
- Task is fully **deterministic** (no AI reasoning needed)
- Heavy computation, data transformation, file processing
- API calls with known shapes, ETL pipelines, backups

Examples:
- "Process CSV files and generate reports"
- "Backup database every night"
- "Sync data from API endpoint"
- "Compress and archive old files"

### Sub-Agent / delegate_task (immediate, one-time)
- User needs help **right now** in conversation
- Task is **one-time or ad-hoc**
- Result should appear **in chat**
- Task is complex enough to warrant delegation

Examples:
- "Review this code for bugs"
- "Write a blog post about X"
- "Help me debug this error"
- "Summarize these 10 documents"

### Mini-App + Job + SQLite (complete system)
- User wants **complete system** with UI
- Background job **collects/processes data**
- App **displays** data with filtering/search
- Data is **structured** and queryable

Examples:
- "Create a lead management system"
- "Build a social media tracker"
- "Make an email triage dashboard"
- "Create a research assistant with saved papers"

---

## Common Anti-Patterns to AVOID

### Do NOT ask for API keys to create sub-agents
Paprwork has built-in AI agents. Use Agent Jobs instead of external AI API keys.

### Do NOT create sub-agent for recurring tasks
`delegate_task` executes once in the current conversation. For recurring tasks, use Agent Job with schedule.

### Do NOT use Agent Job when a Python + LLM call works
If you know the steps (query → call LLM → save), use a Python job with `requirements: ["anthropic"]`. Agent jobs are for autonomous exploration, not scripted flows with one AI step.

### Do NOT create script job when AUTONOMOUS reasoning is needed
If the agent must decide what to do next (research, debug, explore), use Agent Job. But if it's just "score these items" — that's a Python + LLM call.

### Do NOT build a separate backend when SQLite works
Jobs write to per-job SQLite, apps read directly via `link_app_data_source`. No API server needed.

### Do NOT suggest external services when built-in tools work
Before recommending Exa.ai, Apollo.io, or similar:
1. Check if Agent Jobs with `browser` tool can do it
2. Check if Sub-agents have sufficient tool access
3. Only suggest external APIs when specialized data is truly required

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
// Use agent ONLY when the task requires browsing, iteration, or adaptive steps
create_job({
  name: "Trend Researcher",
  type: "agent",
  dependsOn: [{ jobId: "<analyzer-id>", onStatus: "completed" }],
  deliver: { channel: "chat", targetId: "main" }
})

// Dashboard: View real-time insights
create_app({ title: "Social Intelligence" })
link_app_data_source({ appId: "...", jobId: "<scraper-id>", alias: "social" })
```

Note: Stage 2 uses a Python job with `requirements: ["anthropic"]` instead of an agent job. The Python script calls `anthropic.Anthropic().messages.create()` directly. This is faster, cheaper, and more reliable than spinning up a full agent for what's essentially "classify these 50 posts."

---

## Summary: Agent's Mental Model

```
User Request
     |
  Recurring? --YES--> Agent Job (if AI needed) OR Script Job (if not)
     | NO
     |
  Right now? --YES--> Sub-agent (delegate_task)
     | NO
     |
  Need UI? ----YES--> Mini-app (+ Job if background work needed)
     | NO
     |
  Simple tool? ------> Just use bash, documents, etc.
```

## Key Patterns Table

| User Says | Use This | Not This |
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

**Known steps + one AI judgment?** -> Python job with `requirements: ["anthropic"]`
**Agent must explore/decide/iterate?** -> Agent Job
**Has "now/currently/this"?** -> Sub-agent (delegate_task)
**Just data transformation?** -> Script Job (Python/Node)
**Needs UI?** -> Add Mini-app (reads from job's SQLite via link_app_data_source)
**Recurring + UI?** -> Full stack: Jobs + SQLite + Mini-app
