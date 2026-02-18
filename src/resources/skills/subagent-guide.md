---
id: preloaded-subagent-guide
name: Sub-Agent Creation Guide
description: Complete guide for creating specialized persistent AI agents — when to create vs delegate ephemerally, model selection (Anthropic/OpenAI/Google), tool access configuration, real-world examples, and common mistakes.
---
# Sub-Agent Creation Guide

**When to read:** Creating specialized AI agents for recurring or complex tasks.

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
- **Simple commands** — Just run `bash` or call a tool
- **Generic work** — Main agent can handle it

```
Need specialized work?
  ↓
Will this task repeat?
  ↓ YES → Create sub-agent (reusable)
  ↓ NO  → Use delegate_task (one-time, no agent needed)
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
// Uses default provider (openai) and model (gpt-5-mini)
```

### Full Example (All Options)

```javascript
create_sub_agent({
  id: "deep-researcher",              // Optional: specify for updates
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
  model: "claude-opus-4-5-thinking",        // Optional
  allowedToolIds: [                         // Optional: defaults to ["bash", "read_file", "write_file"]
    "bash",
    "read_file",
    "search_files",
    "search_agent_memory"
  ],
  assignedSkills: [],
  outputMode: "natural",                    // "natural" or "structured"
  maxTurns: 15,
  memoryPolicy: "summary"                   // "none", "summary", "full"
})
```

---

## Available Models

### When to specify a model?

**Use defaults (gpt-5-mini) for:**
- Fast, simple tasks
- Data processing
- Cost-sensitive, high-volume work

**Specify a model for:**
- Complex reasoning → Claude Opus, GPT-5.2
- Extended thinking → Claude Thinking models
- Code tasks → GPT-5.2 Codex

### Anthropic Claude

```javascript
model: "claude-haiku-4-5"          // Fast, efficient
model: "claude-sonnet-4-5"         // Balanced (default for Anthropic)
model: "claude-opus-4-5"           // Most capable
model: "claude-opus-4-5-thinking"  // Extended thinking for deep analysis
```

### OpenAI GPT

```javascript
model: "gpt-5-mini"       // Fast, efficient ⭐ RECOMMENDED DEFAULT
model: "gpt-5-2"          // Balanced reasoning
model: "gpt-5-2-low"      // Lower reasoning effort (faster)
model: "gpt-5-2-high"     // Higher reasoning effort
model: "gpt-5-2-xhigh"    // Maximum reasoning effort
model: "gpt-5-2-codex"    // Specialized for code
```

### Google Gemini

```javascript
model: "gemini-2-5-flash"          // Fast, capable (default for Google)
model: "gemini-2-5-flash-lite"     // Very fast, lightweight
model: "gemini-3-pro-preview"      // Most capable (experimental)
model: "gemini-3-flash-preview"    // Latest (experimental)
```

---

## Tool Access (allowedToolIds)

**Default (if not specified):**
```javascript
["bash", "read_file", "write_file"]
```

**Common combinations:**

```javascript
// Read-only research
allowedToolIds: ["bash", "read_file", "search_files", "search_agent_memory"]

// Job orchestration
allowedToolIds: ["bash", "create_job", "run_job", "read_job_logs"]

// Code implementation
allowedToolIds: ["bash", "read_file", "write_file", "search_files"]

// Memory-focused
allowedToolIds: ["bash", "search_agent_memory", "add_agent_memory"]
```

### ⚠️ Agent Jobs Need Tools

If your sub-agent will run as a **background job**, it MUST have explicit tool access:

```javascript
// ❌ BAD — no database access
create_sub_agent({ name: "data-processor", systemPrompt: "Process SQLite data", allowedToolIds: [] })

// ✅ GOOD
create_sub_agent({
  name: "data-processor",
  systemPrompt: "Process SQLite data",
  allowedToolIds: ["bash", "read_file", "write_file"]
})
```

---

## Real-World Examples

### Code Reviewer
```javascript
create_sub_agent({
  name: "Code Reviewer",
  description: "Reviews code for quality, security, and best practices",
  systemPrompt: `You are a senior code reviewer. Focus on: security vulnerabilities, performance, clarity, best practices, edge cases. Provide specific, actionable feedback with examples.`,
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  allowedToolIds: ["bash", "read_file", "search_files"]
})
```

### Data Analyst
```javascript
create_sub_agent({
  name: "Data Analyst",
  description: "Analyzes SQLite data and generates insights",
  systemPrompt: `You are a data analyst specializing in business intelligence. Process: understand question → query efficiently (use indexes) → identify patterns → provide recommendations. Always validate data quality first.`,
  model: "gpt-5-mini",
  allowedToolIds: ["bash", "read_file"]
})
```

### Content Writer
```javascript
create_sub_agent({
  name: "Content Writer",
  systemPrompt: `You are a professional content writer. Principles: clear headlines, scannable structure, active voice, concrete examples, strong CTAs. Match tone to audience.`,
  provider: "anthropic",
  model: "claude-opus-4-5",
  allowedToolIds: ["bash", "read_file", "write_file", "search_agent_memory"]
})
```

### Pipeline Manager
```javascript
create_sub_agent({
  name: "Pipeline Manager",
  systemPrompt: `You are a pipeline orchestrator. Create jobs with proper dependencies, monitor status and logs, handle errors, report progress. Always validate jobs completed successfully before starting dependent jobs.`,
  model: "gpt-5-mini",
  allowedToolIds: ["bash", "create_job", "run_job", "read_job_logs", "read_file"]
})
```

---

## Updating Sub-Agents

Call `create_sub_agent` with the **same ID** to update:

```javascript
// Upgrade to more powerful model
create_sub_agent({
  id: "researcher",       // ← Same ID triggers update
  name: "Researcher",
  model: "claude-opus-4-5-thinking"
})
```
What updates: system prompt, model/provider, tool access.  
What persists: `createdAt` timestamp, `runCount` statistics.

---

## Using Sub-Agents

### Immediate (in-conversation)
```javascript
delegate_task({
  task: "Research quantum computing applications in cryptography",
  useAgentId: "deep-researcher",
  reportChatId: "current-chat-id"
})
```

### Scheduled (background job)
```javascript
create_job({
  name: "Daily Code Review",
  type: "subagent",
  subAgentId: "code-reviewer",
  delegationTask: "Review all PRs merged yesterday",
  schedule: "0 9 * * *",
  deliver: { channel: "chat", targetId: "engineering-chat-id" }
})
```

---

## Common Mistakes

### ❌ Creating agent for one-time task
```javascript
// Bad
create_sub_agent({ name: "Fix Bug X", systemPrompt: "Fix the authentication bug" })
// Good — just delegate directly
delegate_task({ task: "Fix the authentication bug in auth.ts" })
```

### ❌ Wrong model ID format
```javascript
// Bad
model: "claude-opus-4.5"   // dots instead of dashes
model: "gpt4"               // wrong format
model: "claude-3-opus"      // old model

// Good
model: "claude-opus-4-5"
model: "gpt-5-2"
```

### ❌ Vague system prompts
```javascript
// Bad
systemPrompt: "You are a helpful assistant."

// Good — specific role + process + constraints
systemPrompt: "You are a security-focused code reviewer. Identify vulnerabilities, suggest fixes, explain risks. Always check for SQL injection, XSS, and auth bypass patterns."
```

### ❌ Too broad tool access
```javascript
// Bad — everything
allowedToolIds: ["bash", "read_file", "write_file", "create_job", "run_job", "search_files", "add_agent_memory"]

// Good — only what's needed
allowedToolIds: ["bash", "read_file", "search_files"]
```

---

## Quick Reference

| Task Type | Best Approach |
|-----------|---------------|
| One-time analysis | `delegate_task` (no agent needed) |
| Recurring specialized work | `create_sub_agent` + `delegate_task` |
| Scheduled background work | `create_sub_agent` + `create_job` (type: subagent) |
| Simple command | Just use tool directly (`bash`, etc.) |

**Remember:** Sub-agents are for **reusable specialists**, not one-off tasks!
