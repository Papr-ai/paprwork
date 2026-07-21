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
```

## When to Use Each Pattern

### Agent Job (DEFAULT for AI tasks)
- **Default choice** for any recurring task that needs AI reasoning
- Built-in **OAuth/subscription routing** — no anthropic/openai Python packages or API key boilerplate
- Full **tool access** (bash, read_file, write_file, browser)
- **Delivery**, **recipes**, **retries**, and **scheduling** built in
- Agent jobs get auto-injected `JOB_DIR`, `JOB_DB`, `DEP_*` paths

Use agent jobs when the task needs:
- AI judgment, classification, summarization, or scoring
- Multi-step reasoning or adaptation
- Web browsing with dynamic navigation
- Tool access to files, databases, or shell commands
- Exploration where the path is not fully predetermined

Examples:
- "Score 20 threads and pick the best 5"
- "Classify 100 emails by category"
- "Summarize today's news"
- "Research competitors and write a report"
- "Debug why this job keeps failing"
- "Find and analyze 10 new leads"

```javascript
create_job({
  name: "Thread Selector",
  type: "agent",
  command: "Read threads from $JOB_DB, score them, and save the top 5 back to $JOB_DB",
  provider: "anthropic",
  schedule: { enabled: true, cron: "0 9 * * *" }
})
```

`create_job` returns `_agentJobReminder` if you add LLM SDK packages (`anthropic`, `openai`, etc.) to a script job — that is a signal to switch to `type: "agent"`.

### Python/Node Job with Direct LLM Call (RARE EXCEPTION)
- **Only** when ALL of these are true:
  1. Steps are **fully fixed** (no tools, no browsing, no exploration)
  2. Exactly **one** LLM API call per run
  3. Input/output shapes are **known in advance** (e.g. batch-classify rows already in SQLite)
  4. You have a **strong reason** not to use an agent job (e.g. strict per-row cost control on 10K+ items)

If any of the above is false → use an **Agent Job** instead.

```javascript
// ONLY for fixed batch pipelines — prefer agent job in most cases
create_job({
  name: "Batch Classifier",
  type: "python",
  requirements: ["anthropic"],
  command: "python3 code/classify.py --api-key ${ANTHROPIC_API_KEY}",
  dependsOn: [{ jobId: "<ingest-id>", onStatus: "completed" }]
})
```

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

### Do NOT create Python/Node jobs that call OpenAI/Anthropic directly
Paprwork has built-in agent jobs with OAuth/API routing. Use `type: "agent"` instead of `requirements: ["anthropic"]` + direct SDK calls.

`create_job` will warn with `_agentJobReminder` when it detects LLM SDK packages or API keys on script jobs.

### Do NOT ask for API keys to create sub-agents or agent jobs
Built-in routing handles OpenAI, Anthropic, Google, and Ollama. Agent jobs use the user's configured auth automatically.

### Do NOT create sub-agent for recurring tasks
`delegate_task` executes once in the current conversation. For recurring tasks, use Agent Job with schedule.

### Do NOT use Python + LLM when an agent job would work
If the task needs tools, browsing, multi-step reasoning, or you are unsure of the exact steps → Agent Job. Python + LLM is only for rigid batch pipelines.

### Do NOT create script job when AUTONOMOUS reasoning is needed
If the agent must decide what to do next (research, debug, explore), use Agent Job.

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

// Dashboard: View real-time insights
create_app({ title: "Social Intelligence" })
link_app_data_source({ appId: "...", jobId: "<scraper-id>", alias: "social" })
```

**When to use Python + LLM in a pipeline (rare):** Only Stage 2-style work where you have 10K+ identical rows, a frozen prompt template, zero tool use, and need strict per-call cost accounting. Otherwise use `type: "agent"`.

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
| "Score/rank/classify these items" | Agent Job | Python + LLM SDK |
| "Pick the best 5 from this list" | Agent Job | Python + LLM SDK |
| "Summarize this data" | Agent Job | Python + LLM SDK |
| "Research competitors deeply" | Agent Job | Python job (can't browse) |
| "Debug why X is failing" | Agent Job | Script job |
| "Monitor Twitter for mentions" | Agent Job | Script + API calls |
| "Process CSV files" | Script Job | Agent Job |
| "Review this code now" | Sub-agent (immediate) | Agent Job |
| "Build a CRM" | App + Jobs + SQLite | Just an app |
| "Analyze this now" | Sub-agent | Agent Job |
| "Batch-classify 50K frozen rows" | Python + LLM (exception) | Agent Job (expensive) |

## Decision Shortcuts

**Needs AI reasoning (default)?** -> Agent Job (`type: "agent"`)
**Fixed batch: read DB → one LLM call → write DB, no tools?** -> Python + LLM (rare exception)
**Agent must explore/decide/iterate?** -> Agent Job
**Has "now/currently/this"?** -> Sub-agent (delegate_task)
**Just data transformation?** -> Script Job (Python/Node)
**Needs UI?** -> Add Mini-app (reads from job's SQLite via link_app_data_source)
**Recurring + UI?** -> Full stack: Jobs + SQLite + Mini-app
