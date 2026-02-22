# Task Delegation & Agent Management (V2)

## When to Delegate

Use `delegate_task` when:
- **Token-heavy operations**: Web scraping, browsing multiple pages, large code analysis
- **Specialized work**: Code reviews, content writing, UI design, data analysis
- **Parallel tasks**: Multiple independent research/collection tasks
- **Fresh context needed**: Task doesn't need your conversation history
- **Long-running operations**: Tasks that might take many steps

## Available Specialist Agents

Use `list_sub_agents` to see currently available agents. Default specialists include:

### 1. Research Specialist
Best for: Web research, data gathering, competitive analysis, market research
Tools: bash, browser, papr_memory

### 2. Implementation Specialist
Best for: Code writing, debugging, testing, technical implementation
Tools: bash, read_file, write_file, browser

### 3. Custom Agents
Create purpose-built agents with `create_sub_agent` for recurring specialized tasks.

---

## Delegation Patterns

### Pattern 1: Use Existing Specialist

```javascript
// Check available agents first
list_sub_agents()

// Delegate to existing specialist (reportChatId omitted = auto-uses current chat, user sees result + mini-chat)
delegate_task({
  task: "Review the authentication code in ~/project/auth.js for security issues",
  useAgentId: "research-specialist",
})
```

### Pattern 2: Create New Specialist

```javascript
// For recurring tasks, create a specialist agent
create_sub_agent({
  name: "E-commerce Scraper",
  systemPrompt: "You specialize in scraping product data from e-commerce sites...",
  allowedToolIds: ["bash", "browser"],
  assignedSkills: ["web-scraping"]
})

// Then delegate to it
delegate_task({
  task: "Scrape product data from these 50 e-commerce sites",
  useAgentId: "e-commerce-scraper"
})
```

### Pattern 3: Ephemeral Delegation

```javascript
// One-off tasks don't need a saved specialist
delegate_task({
  task: "Research the top 10 AI startups and summarize their key metrics"
})
```

---

## Planning Strategy

Use `create_plan` BEFORE starting complex work:
- **Multi-step tasks** (3+ steps): Break down into clear todos
- **Long operations**: Give users visibility into progress
- **Complex workflows**: Help users understand your approach

### Example Workflow

```javascript
// 1. Create the plan
create_plan({
  title: "AI Company Research Report",
  steps: [
    { id: "research", title: "Research top AI companies", status: "pending" },
    { id: "analyze", title: "Analyze their metrics", status: "pending" },
    { id: "report", title: "Create comprehensive report", status: "pending" }
  ]
})

// 2. Update as you work
update_plan({
  stepId: "research",
  status: "completed",
  notes: "Found 47 companies, saved to Papr Memory"
})

// 3. Continue with next steps
update_plan({
  stepId: "analyze",
  status: "in_progress"
})
```

Users see checkboxes getting checked off in real-time. This makes you look professional and organized.

---

## Agent Management Decision Tree

1. `list_sub_agents` -> See available specialists
2. Task matches existing specialist? -> Use `delegate_task` with `useAgentId`
3. Task is recurring/specialized? -> `create_sub_agent`, then delegate
4. Task is one-off? -> `delegate_task` without `useAgentId` (ephemeral)

## Key Principles

- **Specialists** improve over time as you refine their prompts
- **Ephemeral agents** are lighter weight for one-time tasks
- **Delegate token-heavy work** to save your context window
- **Sub-agents get fresh context** — include all necessary information in the task description
- **Use Agent Jobs** for recurring delegation (scheduled), sub-agents for in-conversation delegation

---

## Sub-Agent Communication Patterns

### How Sub-Agents Receive Context

Sub-agents run in **isolated sessions** with no access to:
- ❌ Main agent's conversation history
- ❌ User messages (unless you include them)
- ❌ Other sub-agent results (unless passed explicitly)
- ❌ Previous delegation outcomes

Sub-agents **only see:**
- ✅ `task` - The instruction you provide
- ✅ `context` - Optional additional information you pass
- ✅ `systemPrompt` - From their sub-agent profile
- ✅ Environment variables (`JOB_DIR`, `JOB_DB`, etc.)

**Example - Bad context:**
```javascript
delegate_task({
  task: "Review the code",
  context: "The user mentioned performance issues"
})
// ❌ Which code? Where? What kind of performance?
```

**Example - Good context:**
```javascript
delegate_task({
  task: "Review the authentication code for performance bottlenecks",
  context: `
    File: ~/project/src/auth.js
    User complaint: Login takes 3-5 seconds
    Current implementation: bcrypt with rounds=15
    Focus areas: Password hashing, database queries, session creation
    Expected: < 500ms login time
  `
})
// ✅ Complete, specific, actionable
```

### How Results Flow Back to Main Agent

**Flow:**
1. Sub-agent executes task using its tools
2. Output accumulated in `text` variable (from `text-delta` chunks)
3. Stored as `job.lastOutput` (max 32KB)
4. Mapped to `DelegationRunRecord.resultText`
5. Returned to main agent via `delegate_task` tool result

**Tool result structure:**
```json
{
  "success": true,
  "data": {
    "id": "delegation-xyz",
    "agentId": "security-specialist",
    "agentName": "Security Specialist",
    "task": "Review authentication code",
    "status": "completed",
    "resultText": "Found 3 issues:\n1. bcrypt rounds too high (15 → 12)\n2. Sequential DB queries (use Promise.all)\n3. Session not cached (add Redis)",
    "completedAt": "2026-02-19T15:45:00Z"
  }
}
```

**Main agent accesses result:**
```javascript
const result = delegate_task({ task: "...", context: "..." })
const findings = result.data.resultText
// Use the findings to continue work
```

### Passing Data Between Sub-Agents

Sub-agents **cannot directly communicate** with each other. Use these patterns:

**Pattern 1: Sequential delegation via main agent**
```javascript
// Sub-agent 1: Research
const research = delegate_task({
  task: "Research competitors",
  useAgentId: "research-specialist"
})

// Main agent extracts key findings
const keyFindings = extractTopCompetitors(research.data.resultText)

// Sub-agent 2: Analysis (gets Sub-agent 1's results via context)
delegate_task({
  task: "Analyze competitive positioning",
  context: `Competitors from research: ${keyFindings}`,
  useAgentId: "analysis-specialist"
})
```

**Pattern 2: Shared SQLite database**
```javascript
// Sub-agent 1: Writes data
delegate_task({
  task: `
    Research competitors and write to $JOB_DB:
    CREATE TABLE competitors (name TEXT, revenue REAL, employees INT)
    INSERT findings into this table
  `,
  useAgentId: "research-specialist"
})

// Sub-agent 2: Reads same database
delegate_task({
  task: `
    Read from $JOB_DB table 'competitors'
    Analyze market share and write report to $JOB_DB table 'analysis'
  `,
  useAgentId: "analysis-specialist"
})
```

### Sub-Agent Output Delivery Options

**Option 1: Return to main agent only (default)**
```javascript
const result = delegate_task({
  task: "Research user authentication best practices",
  background: false  // Wait for completion
})

// Main agent gets result
console.log(result.data.resultText)
// User does NOT see sub-agent's work directly
```

**Option 2: Deliver to chat**
```javascript
delegate_task({
  task: "Research user authentication best practices",
  // reportChatId omitted = auto-uses current chat
  background: false
})

// Result appears as assistant message in chat
// MiniChatCard shows inline (user can Join to participate)
// Main agent ALSO gets result in tool return
```

**Option 3: Background execution**
```javascript
delegate_task({
  task: "Daily data sync from APIs",
  // reportChatId omitted = auto-uses current chat
  background: true  // ← Key: don't wait
})

// Returns immediately with status "running"
// Main agent continues without blocking
// Result delivered to chat when complete
```

**Option 4: No delivery (logs only)**
```javascript
delegate_task({
  task: "Background monitoring task",
  background: true
  // No reportChatId = result only in job record
})

// Access later via: read_job_logs({ jobId })
```

---

## When Sub-Agents Are NOT Appropriate

❌ **Don't use sub-agents for:**

### 1. Tasks Requiring User Clarification

**Problem:** Sub-agents run single-shot, can't ask user questions mid-execution.

**Example:**
```javascript
// ❌ BAD - Sub-agent will guess or fail
delegate_task({
  task: "Design a logo for the user's company"
  // What colors? What style? What industry?
})

// ✅ GOOD - Main agent asks first
const preferences = await askUser("What colors and style for your logo?")
delegate_task({
  task: "Design a logo",
  context: `Colors: ${preferences.colors}, Style: ${preferences.style}, Industry: ${preferences.industry}`
})
```

### 2. Multi-Turn User Interactions

**Problem:** Sub-agents can't have back-and-forth conversations with users.

**Example:**
```javascript
// ❌ BAD - Sub-agent can't iterate with user
delegate_task({
  task: "Help the user debug their code interactively"
})

// ✅ GOOD - Main agent handles interaction
// Keep conversation in main chat, use tools directly
```

### 3. Real-Time User Approval/Feedback

**Problem:** Sub-agents can't pause for approval during execution.

**Example:**
```javascript
// ❌ BAD - Sub-agent will proceed without approval
delegate_task({
  task: "Refactor the codebase (get user approval before each change)"
})

// ✅ GOOD - Main agent manages approval loop
const plan = createRefactoringPlan()
const approved = await askUser(`Approve this plan? ${plan}`)
if (approved) {
  delegate_task({
    task: "Execute refactoring",
    context: `Approved plan: ${plan}`
  })
}
```

### 4. Tasks Needing Main Conversation Context

**Problem:** Sub-agents don't see the main chat history.

**Example:**
```javascript
// ❌ BAD - Sub-agent doesn't know what "it" refers to
delegate_task({
  task: "Review it for security issues"
})

// ✅ GOOD - Explicit context
delegate_task({
  task: "Review the authentication code at ~/project/auth.js for security issues"
})
```

---

## Workarounds for Current Limitations

### Limitation 1: Sub-Agent Can't Ask Questions

**Current:** Sub-agents run to completion without pausing for input.

**Workaround 1 - Pre-fill context:**
```javascript
// Main agent anticipates questions
const userGoals = await askUser("What's your primary goal for this analysis?")
const constraints = await askUser("Any constraints or requirements?")

delegate_task({
  task: "Analyze competitor strategies",
  context: `
    User goals: ${userGoals}
    Constraints: ${constraints}
    If you need more info, state assumptions in your report
  `
})
```

**Workaround 2 - Two-phase delegation:**
```javascript
// Phase 1: Discovery
const phase1 = delegate_task({
  task: "List 5 key questions you need answered to complete this analysis"
})

// Main agent asks user
const answers = await askUserMultiple(phase1.data.resultText)

// Phase 2: Execution
delegate_task({
  task: "Complete the analysis with these answers",
  context: JSON.stringify(answers)
})
```

**Workaround 3 - Sub-agent returns partial result:**
```javascript
const result = delegate_task({
  task: "Research X, but if you need clarification, return 'NEED_INFO: <question>'"
})

if (result.data.resultText.startsWith("NEED_INFO:")) {
  const question = result.data.resultText.replace("NEED_INFO: ", "")
  const answer = await askUser(question)
  
  // Re-delegate with answer
  delegate_task({
    task: "Research X",
    context: `Previous question: ${question}, Answer: ${answer}`
  })
}
```

### Limitation 2: No Multi-Turn Collaboration

**Future Enhancement: Mini-Chat Card 🚀**

Planned feature for agent-to-agent and user-sub-agent interaction:

```
[In main chat, a MiniChatCard appears]

┌─────────────────────────────────────────┐
│ 💬 Security Specialist                  │
│                           [Join] button  │
├─────────────────────────────────────────┤
│ Sub-Agent:                              │
│   Should I also check for SQL injection?│
│                                         │
│ Main Agent:                             │
│   Yes, and XSS vulnerabilities too      │
│                                         │
│ Sub-Agent:                              │
│   Found 2 SQL injection risks in login  │
│                                         │
│ [User clicks "Join" button]             │
│                                         │
│ User:                                   │
│   Check the registration endpoint too   │
│                                         │
│ Sub-Agent:                              │
│   Will do! Analyzing registration now...│
└─────────────────────────────────────────┘
```

**How it will work:**
1. Sub-agent gets persistent chat session (not single-shot)
2. Main agent can see and respond in mini-chat
3. User can observe passively
4. User can click "Join" to participate
5. Enables true multi-turn collaboration

**Benefits:**
- Sub-agents can ask clarifying questions
- Main agent can supervise and guide
- User can step in when needed
- Natural conversation flow

**Current status:** Planned, not yet implemented. Use workarounds above.

---

## Live Monitoring Sub-Agent Work

While sub-agents execute, you can see their activity in real-time:

### DelegationCard in UI

Shows sub-agent status and live logs:

```
┌─────────────────────────────────────────┐
│ 🤖 Security Specialist (running)        │
├─────────────────────────────────────────┤
│ Task: Review authentication code        │
│                                         │
│ Sub-agent Activity (last 24 lines):     │
│ 💭 Thinking: Reading auth.js file       │
│ 🔧 Tool: read_file                      │
│    path: ~/project/auth.js              │
│ ✅ Result: 245 lines read               │
│ 💭 Thinking: Analyzing password logic   │
│ 🔧 Tool: bash                           │
│    command: grep -n "bcrypt" auth.js    │
│ ✅ Result: Found on lines 23, 67, 89    │
│ 💭 Thinking: Checking for vulnerabilities│
└─────────────────────────────────────────┘
```

**What you see:**
- Real-time thinking process
- Tool calls with arguments
- Tool results
- Progress through the task

**How it works:**
- Sub-agent's `appendLog()` broadcasts via WebSocket
- Event: `jobs:log-line`
- UI subscribes via `jobLiveLogsStore`
- Logs auto-scroll as they arrive

---

## Advanced Patterns

### Pattern 1: Parallel Delegation

```javascript
// Launch multiple sub-agents in parallel
const [research, analysis, design] = await Promise.all([
  delegate_task({
    task: "Research competitors",
    background: false,
    useAgentId: "research-specialist"
  }),
  delegate_task({
    task: "Analyze market trends",
    background: false,
    useAgentId: "analysis-specialist"
  }),
  delegate_task({
    task: "Design wireframes",
    background: false,
    useAgentId: "design-specialist"
  })
])

// Combine results
const report = synthesizeFindings([
  research.data.resultText,
  analysis.data.resultText,
  design.data.resultText
])
```

### Pattern 2: Nested Delegation

```javascript
// Sub-agents can delegate to other sub-agents
delegate_task({
  task: `
    Research the top 10 AI companies.
    For each company, delegate to the 'analysis-specialist' to analyze their products.
    Compile all findings into a report.
  `,
  useAgentId: "research-specialist"
})

// The sub-agent will call delegate_task internally
// Results flow back through the chain
```

### Pattern 3: Conditional Delegation

```javascript
const initialAnalysis = analyzeUserRequest()

if (initialAnalysis.needsResearch) {
  const research = delegate_task({
    task: "Research topic X",
    useAgentId: "research-specialist"
  })
  // Use research.data.resultText
}

if (initialAnalysis.needsCodeReview) {
  const review = delegate_task({
    task: "Review code Y",
    useAgentId: "security-specialist"
  })
  // Use review.data.resultText
}

// Synthesize based on what was delegated
```

---

## Summary

**Use sub-agents when:**
- Task is specialized (research, code review, analysis)
- Task is token-heavy (save main agent context)
- Task doesn't need user interaction
- You can provide complete context upfront

**Don't use sub-agents when:**
- Task needs user clarification
- Task requires multi-turn interaction
- Task needs main conversation context
- Task is simple (use main agent's tools directly)

**Best practices:**
- Include ALL context in `task` and `context` fields
- Be specific about file paths and requirements
- Set `reportChatId` for user-facing results
- Use `background: true` for long-running tasks
- Monitor progress via DelegationCard
- Chain results through main agent, not sub-agent to sub-agent

**See also:**
- `AGENT_JOB_OUTPUT_GUIDE.md` - Complete output and delivery reference
- `SUBAGENT_CREATION_GUIDE.md` - Creating specialized sub-agents
- `APP_AND_JOBS_GUIDE.md` - Jobs and automation
