# Sub-Agent Creation Guide (V2)

**When to read:** Creating specialized AI agents for recurring or complex tasks  
**Quick start:** Create reusable specialist agents that handle specific domains

---

## What Are Sub-Agents?

Sub-agents are **persistent AI agent profiles** with:
- Custom system prompts
- Specific tool access
- Optional model selection
- Reusable across multiple tasks

**Think of them as:** Hiring specialists for your team (researchers, coders, analysts).

---

## When to Create a Sub-Agent

### ✅ CREATE for:
- **Recurring specialized tasks** — Same type of work, different inputs
- **Domain expertise** — Needs specific knowledge/prompt
- **Consistent behavior** — Same approach every time
- **Tool restrictions** — Limit what agent can do

### ❌ DON'T CREATE for:
- **One-time tasks** — Use `delegate_task` directly
- **Simple commands** — Just run `bash` or call tool
- **Generic work** — Main agent can handle it

---

## Quick Decision Tree

```
Need specialized work?
  ↓
Will this task repeat?
  ↓ YES → Create sub-agent (reusable)
  ↓ NO  → Use delegate_task (one-time)
```

---

## Creating a Sub-Agent

### Minimal Example

```javascript
create_sub_agent({
  name: "Research Specialist",
  description: "Investigates complex topics with evidence",
  systemPrompt: "You are a focused researcher. Gather evidence, cite sources, and highlight uncertainty."
})
// Result: Uses default provider (openai) and model (gpt-5.4-mini)
```

### Full Example (All Options)

```javascript
create_sub_agent({
  id: "deep-researcher",  // Optional: Specify ID for updates
  name: "Deep Research Specialist",
  description: "Complex research requiring extended thinking",
  systemPrompt: `You are an expert researcher specializing in technical analysis.
  
Your approach:
1. Break down complex questions into sub-questions
2. Gather evidence from multiple sources
3. Cross-reference claims
4. Highlight uncertainty and confidence levels
5. Provide clear, structured summaries

Always cite sources and explain your reasoning.`,
  
  provider: "anthropic",                    // Optional: anthropic, openai, google
  model: "claude-opus-4-5-thinking",        // Optional: Specific model
  allowedToolIds: [                         // Optional: Defaults to ["bash", "read_file", "write_file"]
    "bash",
    "read_file", 
    "search_files",
    "search_agent_memory"
  ],
  assignedSkills: [],                       // Optional: Skills to pre-load
  outputMode: "natural",                    // Optional: "natural" or "structured"
  maxTurns: 15,                             // Optional: Max conversation turns
  memoryPolicy: "summary"                   // Optional: "none", "summary", "full"
})
```

---

## Available Models for Sub-Agents

**OAuth vs API key:** Sub-agents and agent jobs work with both. Paprwork routes automatically:
- **OAuth** (ChatGPT/Claude subscription) → pi-ai backend
- **API key** (Platform) → AI SDK backend

Pick models the user has access to. Default to `gpt-5.4-mini` or `claude-sonnet-4-6` when unspecified.

### When to Specify a Model?

**Use defaults (gpt-5.4-mini or claude-sonnet-4-6) for:**
- ✅ Fast, simple tasks
- ✅ Data processing
- ✅ Cost-sensitive operations
- ✅ High-volume work

**Specify a model for:**
- ✅ Complex reasoning (Claude Opus, GPT-5.2-high)
- ✅ Code tasks (GPT-5.2 Codex, GPT 5.3)
- ✅ Extended thinking (Claude Thinking models)

### Anthropic Claude Models

```javascript
// Fast, efficient
model: "claude-haiku-4-5"

// Balanced (default for Anthropic)
model: "claude-sonnet-4-6"

// Most capable
model: "claude-opus-4-6"

// Extended thinking for deep analysis
model: "claude-opus-4-5-thinking"
```

### OpenAI GPT Models

```javascript
// Fast reasoning
model: "gpt-5.4-low"

// Balanced (default) ⭐ RECOMMENDED
model: "gpt-5.4"

// Deep reasoning
model: "gpt-5.4-high"

// Specialized for code
model: "gpt-5.3-codex"

// Latest Codex (OAuth only)
model: "gpt-5.3-codex"
```

### Google Gemini Models

```javascript
// Fast, capable (default for Google)
model: "gemini-2.5-flash"

// Lightweight, very fast
model: "gemini-2.5-flash-lite"

// Most capable (experimental)
model: "gemini-3-pro-preview"

// Latest (experimental)
model: "gemini-3-flash-preview"
```

---

## Tool Access (allowedToolIds)

### Default Tools

If you **don't specify** `allowedToolIds`, sub-agent gets:
```javascript
["bash", "read_file", "write_file"]  // Basic file and database access
```

### Common Tool Combinations

**Database access:**
```javascript
allowedToolIds: ["bash", "read_file", "write_file"]
// Read/write SQLite, process files
```

**Read-only research:**
```javascript
allowedToolIds: ["bash", "read_file", "search_files", "search_agent_memory"]
// Explore code, search docs, no writes
```

**Job orchestration:**
```javascript
allowedToolIds: ["bash", "create_job", "run_job", "read_job_logs"]
// Manage background jobs
```

**Code implementation:**
```javascript
allowedToolIds: ["bash", "read_file", "write_file", "search_files"]
// Full file I/O for coding
```

**Memory-focused:**
```javascript
allowedToolIds: ["bash", "search_agent_memory", "add_agent_memory"]
// Work with agent memory system
```

### ⚠️ CRITICAL: Agent Jobs Need Tools

If your sub-agent will run as a **background job**, it **MUST** have tool access:

```javascript
// ❌ BAD - No database access
create_sub_agent({
  name: "data-processor",
  systemPrompt: "Process SQLite data..."
  // Missing allowedToolIds - defaults to ["bash", "read_file", "write_file"]
})

// ✅ GOOD - Explicit tool access
create_sub_agent({
  name: "data-processor",
  systemPrompt: "Process SQLite data...",
  allowedToolIds: ["bash", "read_file", "write_file"]
})
```

**Why:** Sub-agents running as jobs are isolated and can only use tools you specify.

---

## Real-World Examples

### Example 1: Code Review Specialist

```javascript
create_sub_agent({
  name: "Code Reviewer",
  description: "Reviews code for quality, security, and best practices",
  systemPrompt: `You are a senior code reviewer.

Focus on:
- Security vulnerabilities
- Performance issues
- Code clarity and maintainability
- Best practices violations
- Edge cases

Provide specific, actionable feedback with examples.`,
  
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  allowedToolIds: ["bash", "read_file", "search_files"]
})
```

### Example 2: Data Analyst

```javascript
create_sub_agent({
  name: "Data Analyst",
  description: "Analyzes SQLite data and generates insights",
  systemPrompt: `You are a data analyst specializing in business intelligence.

Your process:
1. Understand the question and data schema
2. Query data efficiently (use indexes)
3. Identify patterns and anomalies
4. Generate clear visualizations (when possible)
5. Provide actionable recommendations

Always validate data quality before analysis.`,
  
  model: "gpt-5.4",  // Fast for data processing
  allowedToolIds: ["bash", "read_file"]
})
```

### Example 3: Content Writer

```javascript
create_sub_agent({
  name: "Content Writer",
  description: "Creates marketing copy and blog posts",
  systemPrompt: `You are a professional content writer.

Writing principles:
- Clear, engaging headlines
- Scannable structure (headings, bullets)
- Active voice
- Concrete examples
- Strong CTAs

Match the tone to the audience and platform.`,
  
  provider: "anthropic",
  model: "claude-opus-4-5",  // High quality writing
  allowedToolIds: ["bash", "read_file", "write_file", "search_agent_memory"]
})
```

### Example 4: Job Orchestrator

```javascript
create_sub_agent({
  name: "Pipeline Manager",
  description: "Manages multi-step job pipelines",
  systemPrompt: `You are a pipeline orchestrator.

Responsibilities:
- Create jobs with proper dependencies
- Monitor job status and logs
- Handle errors and retries
- Report progress to user

Always validate jobs completed successfully before starting dependent jobs.`,
  
  model: "gpt-5.4",
  allowedToolIds: ["bash", "create_job", "run_job", "read_job_logs", "read_file"]
})
```

---

## Updating Existing Sub-Agents

To update a sub-agent, call `create_sub_agent` with the **same ID**:

```javascript
// Original creation
create_sub_agent({
  id: "researcher",
  name: "Researcher",
  model: "gpt-5.4",
  // ...
})

// Later: Upgrade to more powerful model
create_sub_agent({
  id: "researcher",  // ← Same ID triggers update
  name: "Researcher",
  model: "claude-opus-4-5-thinking",  // ← Changed
  // ... other fields
})
```

**What gets updated:**
- System prompt
- Model/provider
- Tool access
- Any other specified fields

**What persists:**
- `createdAt` timestamp
- `runCount` statistics

---

## Using Your Sub-Agents

### Option 1: Delegate Task (Immediate)

```javascript
// Delegate work to specific sub-agent
delegate_task({
  task: "Research quantum computing applications in cryptography",
  useAgentId: "deep-researcher",
  reportChatId: "current-chat-id"  // Report back here
})
```

### Option 2: Create Agent Job (Scheduled)

```javascript
// Create recurring job using sub-agent
create_job({
  name: "Daily Code Review",
  type: "subagent",
  subAgentId: "code-reviewer",
  delegationTask: "Review all PRs merged yesterday",
  schedule: "0 9 * * *",  // Daily at 9 AM
  deliver: {
    channel: "chat",
    targetId: "engineering-chat-id"
  }
})
```

---

## Best Practices

### 1. **Descriptive Names**
```javascript
// ❌ Vague
name: "Agent 1"

// ✅ Clear purpose
name: "Security Code Reviewer"
```

### 2. **Specific System Prompts**
```javascript
// ❌ Generic
systemPrompt: "You are a helpful assistant."

// ✅ Focused role
systemPrompt: "You are a security-focused code reviewer. Identify vulnerabilities, suggest fixes, and explain risks."
```

### 3. **Minimal Tool Access**
```javascript
// ❌ Too broad
allowedToolIds: ["bash", "read_file", "write_file", "create_job", "run_job", "search_files", "add_agent_memory"]

// ✅ Only what's needed
allowedToolIds: ["bash", "read_file", "search_files"]
```

### 4. **Match Model to Task**
```javascript
// ❌ Overkill for simple task
model: "claude-opus-4-5-thinking"  // Expensive!

// ✅ Right-sized
model: "gpt-5.4"  // Fast, cheap, sufficient
```

### 5. **Include Context in System Prompt**
```javascript
// ❌ Missing context
systemPrompt: "Analyze data."

// ✅ Complete instructions
systemPrompt: `Analyze SQLite data from ~/Papr/jobs/{jobId}/data.db.

Schema:
- leads table: id, name, email, score, created_at
- events table: lead_id, event_type, timestamp

Generate summary statistics and identify high-value leads (score > 80).`
```

---

## Listing and Managing Sub-Agents

### List All Sub-Agents

```javascript
list_sub_agents()
// Returns: Array of all sub-agent profiles with stats
```

### Delete Sub-Agent

```javascript
delete_sub_agent({ agentId: "old-researcher" })
// Note: Does NOT delete past delegation runs
```

---

## Common Mistakes

### ❌ Mistake 1: Creating Agent for One-Time Task

```javascript
// Bad: Creating agent for single use
create_sub_agent({
  name: "Fix Bug X",
  systemPrompt: "Fix the authentication bug"
})
delegate_task({ useAgentId: "fix-bug-x", ... })

// Good: Just delegate directly
delegate_task({
  task: "Fix the authentication bug in auth.ts"
})
```

### ❌ Mistake 2: No Tool Access for Job

```javascript
// Bad: Agent job without tools
create_sub_agent({
  name: "Data Processor",
  systemPrompt: "Process SQLite data",
  allowedToolIds: []  // ← Can't access database!
})

// Good: Grant necessary tools
create_sub_agent({
  name: "Data Processor",
  systemPrompt: "Process SQLite data",
  allowedToolIds: ["bash", "read_file", "write_file"]
})
```

### ❌ Mistake 3: Wrong Model Format

```javascript
// Bad: Wrong model ID format
model: "claude-opus-4.5"  // ← Dots instead of dashes
model: "gpt4"             // ← Wrong format
model: "claude-3-opus"    // ← Old model

// Good: Correct current model IDs
model: "claude-opus-4-5"
model: "gpt-5-2"
model: "claude-sonnet-4-6"
```

---

## Workflow: Creating a Specialized Agent

1. **Identify recurring task pattern**
   - "I often need to review code for security"
   - "Daily analysis of lead data"
   - "Weekly content generation"

2. **Define scope and constraints**
   - What should agent do?
   - What tools does it need?
   - How powerful should it be?

3. **Create agent with focused prompt**
   ```javascript
   create_sub_agent({
     name: "...",
     description: "...",
     systemPrompt: "Clear, specific instructions...",
     model: "appropriate-model",
     allowedToolIds: ["minimal", "set"]
   })
   ```

4. **Test with delegation**
   ```javascript
   delegate_task({
     task: "Test task",
     useAgentId: "your-agent",
     reportChatId: "current-chat"
   })
   ```

5. **Refine based on results**
   - Update system prompt if needed
   - Adjust tool access
   - Change model if too slow/expensive

---

## See Also

- `DELEGATION_STRATEGY.md` — When and how to delegate work
- `DECISION_TREE_AGENT_CAPABILITIES.md` — Agent Job vs Sub-agent vs Script
- `APP_AND_JOBS_GUIDE.md` — Using sub-agents with jobs
- `00-START-HERE.md` — Full tool listing

---

## Quick Reference

| Task Type | Best Approach |
|-----------|---------------|
| One-time analysis | `delegate_task` (no agent needed) |
| Recurring specialized work | `create_sub_agent` + `delegate_task` |
| Scheduled background work | `create_sub_agent` + `create_job` (type: subagent) |
| Simple command | Just use tool directly (`bash`, etc.) |

**Remember:** Sub-agents are for **reusable specialists**, not one-off tasks!
