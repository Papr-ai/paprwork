# Quick Examples: Agent Jobs vs Sub-agents vs Scripts (V2)

Quick reference for choosing the right approach for common scenarios.

---

## Lead Generation / Prospecting

**CORRECT:**
```javascript
// 1. Create Agent Job for recurring lead finding
create_job({
  name: "Lead Finder",
  type: "agent",
  task: "Search for companies matching ICP: [description]. Use browser to search LinkedIn, Crunchbase, etc. For each lead: extract company name, website, employee count, industry, contact info. Score 1-10 based on ICP fit. Save to SQLite with schema: id, company_name, website, size, industry, contact_name, score, reasoning, found_date.",
  tools: ["browser", "bash"],
  schedule: "0 9 * * *"
})

// 2. Create Mini-app for viewing/managing leads
create_app({
  title: "Lead Manager",
  description: "View and manage leads from Lead Finder"
})

// 3. Link data
link_app_data_source({ appId: "lead-manager", jobId: "lead-finder", alias: "leads" })
```

**WRONG:**
- Requesting API keys for AI services (Paprwork has built-in AI agents)
- Suggesting external lead services before trying built-in browser tool

---

## Social Media Monitoring

**CORRECT:**
```javascript
create_job({
  name: "Twitter Monitor",
  type: "agent",
  task: "Monitor @mentions and relevant hashtags. For each post: extract text, author, engagement, sentiment. Identify trends and themes. Save to Papr Memory. Alert if viral post or crisis detected.",
  tools: ["browser", "bash"],
  schedule: "0 * * * *",
  deliver: { channel: "chat", targetId: "main" }
})
```

**WRONG:** Building a Python scraper from scratch when the agent can browse directly.

---

## Competitor Research (Multi-stage Pipeline)

**CORRECT:**
```javascript
// Job 1: Data Collection (Agent)
create_job({
  name: "Competitor Scraper",
  type: "agent",
  task: "Monitor competitor websites, blogs, social. Extract product updates, pricing changes, new features, hiring.",
  tools: ["browser", "bash"],
  schedule: "0 6,18 * * *"
})

// Job 2: Analysis (Agent) - Runs after scraper
create_job({
  name: "Competitor Analyzer",
  type: "agent",
  dependsOn: [{ jobId: "competitor-scraper", onStatus: "completed" }],
  task: "Analyze competitor data. Identify strategic moves, feature gaps, pricing opportunities."
})

// Job 3: Weekly Report (Agent)
create_job({
  name: "Competitor Report",
  type: "agent",
  schedule: "0 9 * * 1",
  dependsOn: [{ jobId: "competitor-analyzer", onStatus: "completed" }],
  task: "Generate weekly competitor intelligence report.",
  deliver: { channel: "chat", targetId: "main" }
})
```

---

## Code Review (One-time, Right Now)

**CORRECT:**
```javascript
// User asks: "Review this code for security issues"
delegate_task({
  task: "Review the following code for security vulnerabilities, SQL injection, XSS, auth issues: [code path]",
  agentId: "implementation-specialist"
})
```

**WRONG:** Creating an Agent Job for a one-time request.

---

## Data Processing (No AI Needed)

**CORRECT (Script Job):**
```javascript
create_job({
  name: "CSV Processor",
  type: "python",
  command: "python code/main.py",
  schedule: "0 2 * * *"
})
```

**WRONG:** Using an Agent Job for deterministic data transformation.

---

## Email Triage

**CORRECT:**
```javascript
create_job({
  name: "Email Triage",
  type: "agent",
  task: "Check unread emails via AppleScript. Categorize by priority (urgent/important/routine). For urgent: extract sender, subject, key points, suggested action. Deliver summary.",
  tools: ["bash"],
  schedule: "0 8,12,16 * * 1-5",
  deliver: { channel: "chat", targetId: "main" }
})
```

**WRONG:** Using `delegate_task` for recurring tasks (it only runs once).

---

## External API Integration

**CORRECT:**
```javascript
// Step 1: Test API first (see API_KEY_TESTING_PROTOCOL.md)
// bash: curl -H "Authorization: Bearer ${ATTIO_KEY}" "https://api.attio.com/v2/lists" | jq '.data[0:3]'

// Step 2: After validating fields, create job
create_job({
  name: "Attio CRM Sync",
  type: "python",
  command: "python code/main.py",
  schedule: "0 */6 * * *",
  retries: { maxAttempts: 3, backoffMs: 5000 }
})
```

**WRONG:**
- Hardcoding API keys in scripts
- Building job code before testing API response shape
- Requesting AI API keys (Agent Jobs have built-in AI)

---

## Complete CRM System (Full Stack)

**CORRECT:**
```javascript
// 1. Lead Finding Job (Agent)
create_job({ name: "Lead Finder", type: "agent", schedule: "0 9 * * *", ... })

// 2. Lead Enrichment Job (Agent) - Runs after finder
create_job({
  name: "Lead Enricher",
  type: "agent",
  dependsOn: [{ jobId: "lead-finder", onStatus: "completed" }],
  task: "For each new lead, find: tech stack, recent news, decision makers, contact info"
})

// 3. Email Composer (Agent)
create_job({
  name: "Email Composer",
  type: "agent",
  task: "For qualified leads, compose personalized outreach based on research"
})

// 4. CRM Mini-app
create_app({ title: "Simple CRM" })
link_app_data_source({ appId: "simple-crm", jobId: "lead-finder", alias: "leads" })
```

---

## Meeting Preparation

**CORRECT:**
```javascript
create_job({
  name: "Meeting Prep",
  type: "agent",
  task: "Check calendar via AppleScript. For each meeting in next 24h: find participant LinkedIn profiles, recent company news, previous email threads. Compile briefing document.",
  tools: ["bash", "browser"],
  schedule: "0 8 * * 1-5",
  deliver: { channel: "chat", targetId: "main" }
})
```

---

## Decision Shortcuts

| Signal | Use This |
|--------|----------|
| "daily/hourly/weekly" or "monitor/track" | Agent Job with schedule |
| "now/currently/this" | Sub-agent (delegate_task) |
| AI analysis/writing/research | Agent Job (has built-in AI) |
| Just data transformation | Script Job (Python/Node) |
| Needs UI | Add Mini-app + link_app_data_source |
| Recurring + UI | Full stack: Agent Job + SQLite + Mini-app |
