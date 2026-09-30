> **Paths:** `$PAPR_HOME` = active org/namespace workspace (`~/Papr/orgs/{orgId}/namespaces/{nsId}/`). See `docs/PAPR_WORKSPACE_PATHS.md`. Prefer app/job tools over raw paths.

# Agent Job Output & Delivery Guide

**Last Updated:** 2026-02-19

This guide explains how agent jobs produce output, how that output is delivered, and how to choose the right approach for your use case.

---

## Output Modes

Agent jobs support three primary output modes:

### 1. Natural Output (Default)

**When to use:**
- Response is explanatory or conversational
- Output length/format is unpredictable
- Delivering to chat for human reading
- Examples: Research summaries, code reviews, analysis reports

**How it works:**
- Agent generates free-form text using `streamText`
- Output is concatenated from `text-delta` chunks
- Stored in `job.lastOutput` (capped at 32KB)
- Truncated to 5000 chars in tool result

**Example:**
```javascript
create_job({
  name: "Code Review",
  type: "agent",
  prompt: "Review the authentication code in ~/project/auth.js for security issues",
  // outputMode: "natural" is the default
  deliver: {
    channel: "chat",
    targetId: currentChatId
  }
})
```

**Result:**
```
I reviewed the authentication code and found the following issues:

1. Password comparison uses == instead of secure comparison
2. Session tokens are not rotated after login
3. No rate limiting on login endpoint

Recommendations:
- Use bcrypt.compare() for password verification
- Implement session rotation with crypto.randomBytes()
- Add express-rate-limit middleware
```

---

### 2. Structured Output

**When to use:**
- Need guaranteed JSON schema conformance
- Output will be parsed by code (not shown to user directly)
- Building data pipelines
- Examples: Data extraction, configuration generation, API responses

**How it works:**
- Uses AI SDK's `generateObject` for schema-constrained JSON
- Model-level enforcement (not prompt-based)
- OAuth fallback: prompt-based JSON generation
- Result stringified and stored in `job.lastOutput`

**Important:** Works best with API key auth. OAuth uses fallback method.

**Example:**
```javascript
create_job({
  name: "Extract Product Data",
  type: "agent",
  prompt: "Extract products from ~/data/catalog.html",
  outputMode: "structured",
  outputSchema: {
    type: "object",
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "number" },
            sku: { type: "string" },
            inStock: { type: "boolean" }
          },
          required: ["name", "price", "sku"]
        }
      },
      totalCount: { type: "number" },
      scrapedAt: { type: "string", format: "date-time" }
    },
    required: ["products", "totalCount"]
  }
})
```

**Result (in job.lastOutput):**
```json
{
  "products": [
    {
      "name": "Widget Pro",
      "price": 29.99,
      "sku": "WGT-001",
      "inStock": true
    },
    {
      "name": "Gadget Plus",
      "price": 49.99,
      "sku": "GDG-002",
      "inStock": false
    }
  ],
  "totalCount": 2,
  "scrapedAt": "2026-02-19T15:30:00Z"
}
```

---

### 3. Tool-Based Outputs (Artifacts)

**When to use:**
- Need to create reusable code/scripts
- Output is multi-file or complex
- Result should be version controlled
- Building apps, jobs, or code artifacts

**How it works:**
- Agent uses tools during execution (`write_file`, `bash`, `create_app`, `create_job`)
- Results persist in job directory or app directory
- Natural text goes to `job.lastOutput`, artifacts live in filesystem

**Available artifact tools:**
- `write_file` - Create/modify files
- `create_app` - Create mini-app
- `create_job` - Create job with code
- `bash` - Execute commands, write to `$JOB_DIR`

**Example:**
```javascript
create_job({
  name: "Generate API Client",
  type: "agent",
  prompt: `
    Create a TypeScript API client for the GitHub API.
    Write it to ~/api-client/github.ts with:
    - Methods for repos, issues, pull requests
    - Type definitions
    - Error handling
    - JSDoc comments
  `
})
```

**Result:**
- File created: `~/api-client/github.ts` (agent uses `write_file`)
- `job.lastOutput`: "Created TypeScript API client with 15 methods and full type safety"

---

## Consuming Structured Output

Structured output is stored in `job.lastOutput` as a JSON string. Here's how to use it in downstream workflows:

### Pattern 1: Python Job Consumes Agent Output

**Use case:** Agent extracts data → Python processes and stores it

```javascript
// Step 1: Create structured agent job
create_job({
  name: "extract-products",
  type: "agent",
  prompt: "Extract products from ~/data/catalog.html",
  outputMode: "structured",
  outputSchema: {
    type: "object",
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "number" },
            sku: { type: "string" }
          }
        }
      }
    }
  }
})

// Step 2: Run it and wait
run_job({ jobId: "extract-products", wait: true })

// Step 3: Create Python job to process the output
create_job({
  name: "process-products",
  type: "python",
  command: "python3 main.py"
})

// Write the Python code:
write_file({
  path: "~/papr-jobs/process-products/code/main.py",
  content: `
import json
import sqlite3
from pathlib import Path

# Read agent job output
agent_job_dir = Path.home() / "Papr" / "jobs" / "extract-products"
with open(agent_job_dir / "job.json") as f:
    job_data = json.load(f)
    
# Parse structured output
products = json.loads(job_data["lastOutput"])

# Store in database
db_path = Path(__file__).parent.parent / "data" / "data.db"
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

cursor.execute("""
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    sku TEXT UNIQUE NOT NULL,
    imported_at TEXT NOT NULL
)
""")

from datetime import datetime
for product in products["products"]:
    cursor.execute(
        "INSERT OR REPLACE INTO products (name, price, sku, imported_at) VALUES (?, ?, ?, ?)",
        (product["name"], product["price"], product["sku"], datetime.utcnow().isoformat())
    )

conn.commit()
print(f"Imported {len(products['products'])} products")
`
})

// Step 4: Run processing job
run_job({ jobId: "process-products" })
```

### Pattern 2: Agent Reads Own Structured Job Output

**Use case:** Chain multiple agent jobs

```javascript
// Job 1: Extract data (structured)
create_job({
  name: "extract-users",
  type: "agent",
  outputMode: "structured",
  outputSchema: { /* ... */ }
})

run_job({ jobId: "extract-users", wait: true })

// Job 2: Transform data (agent reads Job 1's output)
create_job({
  name: "enrich-users",
  type: "agent",
  prompt: `
    1. Read the output from job 'extract-users' using:
       read_job_file({ jobId: "extract-users", filePath: "job.json" })
    
    2. Parse the lastOutput field as JSON
    
    3. For each user, enrich with additional data from the API
    
    4. Write the enriched data to $JOB_DB in the 'users' table
  `
})

run_job({ jobId: "enrich-users" })
```

### Pattern 3: Access via read_job_file Tool

```javascript
// In any agent job or main agent:
const jobData = read_job_file({
  jobId: "extract-products",
  filePath: "job.json"
})

// Parse the structured output
const output = JSON.parse(jobData.lastOutput)

// Use it
output.products.forEach(product => {
  // Process each product...
})
```

---

## Delivery Mechanisms

How the output reaches its destination:

### 1. Chat Delivery

**When to use:**
- User initiated the job and wants results inline
- Result is human-readable text
- Context: Continuing a conversation

**Configuration:**
```javascript
create_job({
  name: "Research Task",
  type: "agent",
  prompt: "Research the top 10 AI startups",
  deliver: {
    channel: "chat",
    targetId: currentChatId  // The chat where results appear
  }
})
```

**Result:**
- Output appears as assistant message in specified chat
- User sees it as normal chat message
- Formatted as markdown

**UI Example:**
```
Assistant: [from job "Research Task"]

I researched the top 10 AI startups by funding and market impact:

1. OpenAI - $11.3B funding, ChatGPT platform
2. Anthropic - $7.3B funding, Claude AI assistant
...
```

---

### 2. Job Record Storage

**When to use:**
- Job is background/scheduled
- Result will be fetched programmatically
- User checks job status later

**Configuration:**
- No `deliver` field, or `deliver: undefined`

**Access methods:**
- `read_job_logs({ jobId })` - Read logs + output
- `read_job_file({ jobId, filePath: "job.json" })` - Read job metadata
- API: `GET /api/jobs/:id`

**Example:**
```javascript
// Create background job
create_job({
  name: "Daily Analytics",
  type: "agent",
  prompt: "Analyze today's metrics and generate report",
  schedule: { cron: "0 9 * * *" }
  // No deliver - runs in background
})

// Later, fetch the result:
const logs = read_job_logs({ jobId: "daily-analytics" })
// or
const jobData = read_job_file({ jobId: "daily-analytics", filePath: "job.json" })
const lastRun = jobData.lastOutput
```

---

### 3. Live Logs (Real-Time Streaming)

**When to use:**
- Always (automatic for all jobs)
- Shows progress during execution
- User wants visibility into what's happening

**How it works:**
- `appendLog()` writes to file + broadcasts via WebSocket
- Event: `jobs:log-line` with `{ jobId, line }`
- UI: `JobStatusCard` and `DelegationCard` subscribe

**What streams:**
- Agent thinking: "💭 Thinking: I need to fetch the repository data..."
- Tool calls: "🔧 Tool: bash"
- Tool results: "✅ Result: { 'name': 'paprwork-v2', ... }"
- Errors: "❌ Error: File not found"

**UI Display:**
```
[JobStatusCard]
┌─────────────────────────────────┐
│ 🔄 Code Review (running)        │
├─────────────────────────────────┤
│ 💭 Thinking: Analyzing auth.js  │
│ 🔧 Tool: read_file              │
│    path: ~/project/auth.js      │
│ ✅ Result: 245 lines read       │
│ 💭 Thinking: Found 3 issues...  │
│ ...                             │
└─────────────────────────────────┘
```

---

### 4. SQLite for UI Updates

**When to use:**
- Data will be queried/filtered by UI
- Need structured persistent storage
- Building dashboards or data views
- Examples: Analytics data, monitoring logs, inventory

**Pattern:**
1. Job writes to `$JOB_DB` ($PAPR_HOME/Jobs/{jobId}/data/data.db)
2. Link app to job DB via `link_app_data_source`
3. UI queries via REST API or WebSocket

**Example:**
```javascript
// Step 1: Create job that writes to SQLite
create_job({
  name: "import-customers",
  type: "python",
  command: "python3 import.py"
})

write_file({
  path: "~/papr-jobs/import-customers/code/import.py",
  content: `
import sqlite3
from pathlib import Path

db = sqlite3.connect(Path(__file__).parent.parent / "data" / "data.db")
cursor = db.cursor()

cursor.execute("""
CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    created_at TEXT
)
""")

# Import data...
cursor.execute(
    "INSERT INTO customers (name, email, created_at) VALUES (?, ?, ?)",
    ("Alice Smith", "alice@example.com", "2026-02-19")
)
db.commit()
`
})

// Step 2: Run the job
run_job({ jobId: "import-customers", wait: true })

// Step 3: Link to app
link_app_data_source({
  appId: "customer-dashboard",
  jobId: "import-customers",
  alias: "customers"
})

// Now the app can query:
// POST /api/db/query
// { appId: "customer-dashboard", sql: "SELECT * FROM customers LIMIT 10" }
```

**UI Display:**
- `TableView` component shows data in grid
- Mini-apps can run custom queries
- Real-time updates via polling or manual refresh

---

### 5. Papr Memory Writeback

**When to use:**
- Want agent to learn from job results
- Building knowledge base
- Future jobs should reference this work

**Configuration:**
```javascript
create_job({
  name: "Research Competitors",
  type: "agent",
  prompt: "Research our top 5 competitors",
  memoryPolicy: "summary"  // or "full" or "none"
})
```

**Memory Policies:**
- `none` - Don't write to memory (default)
- `summary` - Write summarized output
- `full` - Write complete output

**Access:**
- Future agents can search: `search_agent_memory({ query: "competitor analysis" })`
- Builds organizational knowledge over time

---

## Sub-Agent Delegation

Sub-agents are specialized agents that handle specific tasks. They run in isolated sessions and return results to the main agent.

### How Delegation Works

```javascript
// Main agent delegates a task
delegate_task({
  task: "Review authentication code for security issues",
  context: "Focus on password handling and session management",
  useAgentId: "security-specialist",  // Optional: use specific sub-agent
  reportChatId: currentChatId,        // Optional: deliver result to chat
  background: false                   // Wait for completion
})
```

**Flow:**
1. Main agent calls `delegate_task`
2. `SubAgentService` creates a job (`type: "subagent"`)
3. Sub-agent runs in isolated session (`chatId: "job:{jobId}:{runId}"`)
4. Sub-agent executes task with its tools
5. Result stored in `job.lastOutput`
6. Mapped to `DelegationRunRecord.resultText`
7. Tool returns result to main agent

**Result structure:**
```json
{
  "success": true,
  "data": {
    "id": "delegation-abc123",
    "agentId": "security-specialist",
    "agentName": "Security Specialist",
    "task": "Review authentication code",
    "status": "completed",
    "resultText": "Found 3 security issues:\n1. ...\n2. ...\n3. ...",
    "createdAt": "2026-02-19T10:00:00Z",
    "completedAt": "2026-02-19T10:02:30Z"
  }
}
```

### Sub-Agent Context Passing

**Critical:** Sub-agents only see what you pass in `task` and `context`. They cannot:
- Access main agent's conversation history
- Ask user questions (single-shot execution)
- See other sub-agent results (unless passed explicitly)

**Best practices:**
```javascript
// ❌ BAD - Vague context
delegate_task({
  task: "Analyze the data",
  context: "It's in the file"
})

// ✅ GOOD - Complete context
delegate_task({
  task: "Analyze the data",
  context: `
    Data location: ~/data/sales-2026-Q1.csv
    Focus areas: Revenue trends, top customers, regional breakdown
    Format: Generate markdown report with charts
    The user mentioned they care most about West Coast performance
  `
})
```

### Sub-Agent Output Delivery

**Option 1: Return to main agent only**
```javascript
const result = delegate_task({
  task: "Research competitors",
  background: false
})

// Main agent gets: result.data.resultText
// User doesn't see sub-agent work directly
```

**Option 2: Deliver to chat**
```javascript
delegate_task({
  task: "Research competitors",
  reportChatId: currentChatId,
  background: false
})

// Result appears in chat as assistant message
// User sees sub-agent's output
// Main agent also gets result in tool return value
```

**Option 3: Background execution**
```javascript
delegate_task({
  task: "Daily data sync",
  reportChatId: currentChatId,
  background: true
})

// Returns immediately with status "running"
// Main agent continues without waiting
// Result delivered to chat when complete
```

### UI: DelegationCard

Shows delegation status inline in chat:

```
[DelegationCard]
┌─────────────────────────────────────────┐
│ 🤖 Security Specialist (completed)      │
├─────────────────────────────────────────┤
│ Task: Review authentication code        │
│                                         │
│ Context: Focus on password handling...  │
│                                         │
│ Result:                                 │
│ Found 3 security issues:                │
│ 1. Password comparison uses == instead  │
│    of secure comparison                 │
│ 2. Session tokens not rotated           │
│ 3. No rate limiting                     │
└─────────────────────────────────────────┘
```

**Live logs** (while running):
```
┌─────────────────────────────────────────┐
│ 🤖 Security Specialist (running)        │
├─────────────────────────────────────────┤
│ Sub-agent Activity (last 24 lines):     │
│ 💭 Thinking: Reading auth.js            │
│ 🔧 Tool: read_file                      │
│ ✅ Result: 245 lines read               │
│ 💭 Thinking: Analyzing password logic...│
└─────────────────────────────────────────┘
```

### Current Limitations

**Sub-agents cannot:**
1. **Ask clarifying questions** - They run single-shot, no pause for user input
2. **Access user conversation** - Only see `task` + `context` from main agent
3. **Multi-turn with user** - No interactive back-and-forth

**Workarounds:**

**Pattern 1: Pre-fill context**
```javascript
// Main agent asks user first
const userAnswer = await getNextUserMessage()

// Then delegate with answer included
delegate_task({
  task: "Research competitors",
  context: `User wants focus on: ${userAnswer}`
})
```

**Pattern 2: Two-phase delegation**
```javascript
// Phase 1: Get initial findings
const phase1 = delegate_task({
  task: "Research competitors, list 5 key questions you need answered"
})

// Main agent asks user those questions
const answers = await askUser(phase1.resultText)

// Phase 2: Complete research with answers
delegate_task({
  task: "Research competitors with these answers: ...",
  context: answers
})
```

### Future Enhancement: Mini-Chat Card 🚀

**Planned feature** for multi-turn sub-agent collaboration:

```
[MiniChatCard in main chat]
┌─────────────────────────────────────────┐
│ 💬 Sub-Agent: Security Specialist       │
│                           [Join] button  │
├─────────────────────────────────────────┤
│ Sub-Agent: Should I check for SQL       │
│            injection too?                │
│                                         │
│ Main Agent: Yes, and XSS vulnerabilities│
│                                         │
│ Sub-Agent: Found 2 SQL injection risks  │
│            in the login endpoint         │
│                                         │
│ [User clicks "Join"]                    │
│ User: Check the registration endpoint   │
│       too please                         │
│                                         │
│ Sub-Agent: Will do! Analyzing now...    │
└─────────────────────────────────────────┘
```

**Features:**
- Sub-agent gets persistent chat session
- Main agent can respond and guide sub-agent
- User can observe or join the conversation
- Enables true agent-to-agent collaboration

---

## Decision Tree: Choosing Output Strategy

```
START: What's the job's purpose?
│
├─→ Human will read it?
│   ├─→ YES → Use Natural Output
│   │         + deliver: { channel: "chat" } if user-initiated
│   │         + No deliver if background/scheduled
│   │
│   └─→ NO → Continue...
│
├─→ Code will parse it?
│   ├─→ YES → Use Structured Output
│   │         + Define outputSchema
│   │         + Downstream job/script reads job.lastOutput
│   │         + Example: Data extraction, ETL pipelines
│   │
│   └─→ NO → Continue...
│
├─→ Creating files/artifacts?
│   ├─→ YES → Use Tool-Based Output
│   │         + Agent calls write_file, create_app, etc.
│   │         + Natural text still goes to job.lastOutput
│   │         + Example: Code generation, app creation
│   │
│   └─→ NO → Continue...
│
├─→ UI will query/display data?
│   ├─→ YES → Write to SQLite
│   │         + Job writes to $JOB_DB
│   │         + link_app_data_source to connect app
│   │         + UI uses TableView or mini-app
│   │         + Example: Dashboards, reports, monitoring
│   │
│   └─→ NO → Continue...
│
└─→ Task needs specialization?
    └─→ YES → Delegate to Sub-Agent
              + Use delegate_task
              + Include complete context
              + Set reportChatId for chat delivery
              + Example: Code review, research, analysis
```

---

## Quick Reference Matrix

| Output Mode | Use Case | Delivery | Access Method |
|-------------|----------|----------|---------------|
| Natural | Human-readable text | Chat or job record | Chat message or `read_job_logs` |
| Structured | Machine-parseable JSON | Job record | `read_job_file` → parse `lastOutput` |
| Tool-based | Files/artifacts | Filesystem | Direct file access or job file tools |
| SQLite | UI-queryable data | Database | `link_app_data_source` + REST API |
| Sub-agent | Specialized task | Delegation result | Tool return value or chat delivery |

---

## Best Practices

### 1. Output Truncation

- `job.lastOutput` capped at 32KB
- Tool result truncated to 5000 chars
- For large outputs: Write to file or SQLite

### 2. Schema Design (Structured Output)

```javascript
// ✅ GOOD - Clear, specific schema
{
  type: "object",
  properties: {
    users: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
          email: { type: "string", format: "email" }
        },
        required: ["id", "name"]
      }
    },
    totalCount: { type: "number" }
  },
  required: ["users", "totalCount"]
}

// ❌ BAD - Too loose
{
  type: "object",
  properties: {
    data: { type: "array" }  // What's in the array?
  }
}
```

### 3. SQLite Patterns

```python
# ✅ GOOD - Idempotent, versioned schema
cursor.execute("""
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    sku TEXT UNIQUE NOT NULL,
    imported_at TEXT NOT NULL
)
""")

# Use UPSERT for updates
cursor.execute("""
INSERT INTO products (name, price, sku, imported_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(sku) DO UPDATE SET
    name = excluded.name,
    price = excluded.price,
    imported_at = excluded.imported_at
""", (name, price, sku, now))
```

### 4. Memory Policy Selection

- **none**: One-off tasks, no learning needed
- **summary**: Important findings, keep key points
- **full**: Critical data, complete record needed

### 5. Sub-Agent Context

Include in `context`:
- File paths (absolute or relative to home)
- User preferences/constraints
- Output format requirements
- Relevant prior findings
- Anything the sub-agent can't access itself

---

## Examples

### Example 1: Research with Chat Delivery

```javascript
create_job({
  name: "AI Startups Research",
  type: "agent",
  prompt: "Research top 10 AI startups by funding and summarize their key products",
  deliver: {
    channel: "chat",
    targetId: currentChatId
  },
  memoryPolicy: "summary"
})

run_job({ jobId: "ai-research", wait: false })

// User sees result in chat when complete
// Main agent can reference it later via memory search
```

### Example 2: Data Pipeline with Structured Output

```javascript
// Extract
create_job({
  name: "extract-orders",
  type: "agent",
  prompt: "Extract all orders from ~/data/orders.csv",
  outputMode: "structured",
  outputSchema: {
    type: "object",
    properties: {
      orders: { type: "array", items: { /* ... */ } }
    }
  }
})

// Transform & Load
create_job({
  name: "load-orders",
  type: "python",
  command: "python3 etl.py"
})

// etl.py reads extract-orders/job.json → parses lastOutput → writes to SQLite

// Display
link_app_data_source({
  appId: "orders-dashboard",
  jobId: "load-orders",
  alias: "orders"
})
```

### Example 3: Code Generation with Artifacts

```javascript
create_job({
  name: "Generate REST API",
  type: "agent",
  prompt: `
    Create a REST API for a blog:
    - Express.js server
    - Routes: GET/POST/PUT/DELETE for posts
    - TypeScript with types
    - Save to ~/blog-api/
  `,
  deliver: {
    channel: "chat",
    targetId: currentChatId
  }
})

// Result: Files created in ~/blog-api/
// Chat shows: "Created REST API with 8 endpoints and full TypeScript types"
```

### Example 4: Sub-Agent Code Review

```javascript
delegate_task({
  task: "Review the authentication implementation for security issues",
  context: `
    File: ~/project/src/auth.js
    Focus on:
    - Password hashing and comparison
    - Session management
    - Rate limiting
    - Input validation
    
    Provide actionable recommendations with code examples.
  `,
  useAgentId: "security-specialist",
  reportChatId: currentChatId
})

// Sub-agent reviews code, finds issues, returns detailed report
// Result appears in chat + returned to main agent
```

---

## Troubleshooting

### Structured Output Returns String Instead of JSON

**Problem:** `job.lastOutput` contains plain text, not JSON

**Cause:** OAuth mode fallback or schema not enforced

**Solution:** 
- Use API key auth for best results
- Verify `outputSchema` is valid JSON Schema
- Check logs for model errors

### Job Output Truncated

**Problem:** Only seeing first 5000 chars

**Cause:** Tool result truncation

**Solution:**
- Use `read_job_logs` for full output
- Or write data to SQLite/file instead

### Sub-Agent Missing Context

**Problem:** Sub-agent asks for info you already provided

**Cause:** Context not included in `context` field

**Solution:**
- Include ALL necessary info in `context` parameter
- Don't assume sub-agent can access main conversation
- Be explicit about file paths, requirements, constraints

### Live Logs Not Appearing

**Problem:** JobStatusCard shows "Waiting for output..."

**Cause:** Job hasn't produced logs yet, or broadcast not working

**Solution:**
- Wait a few seconds (job initialization)
- Check browser console for WebSocket errors
- Verify `appendLog` is being called in job executor

---

## See Also

- `DELEGATION_STRATEGY.md` - When and how to delegate
- `SUBAGENT_CREATION_GUIDE.md` - Creating specialized sub-agents
- `APP_AND_JOBS_GUIDE.md` - Apps and jobs architecture
- `00-START-HERE.md` - Complete tool reference
