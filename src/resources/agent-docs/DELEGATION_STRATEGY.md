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

// Delegate to existing specialist
delegate_task({
  task: "Review the authentication code in ~/project/auth.js for security issues",
  agentId: "research-specialist",
  tools: ["bash"]
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
  agentId: "e-commerce-scraper"
})
```

### Pattern 3: Ephemeral Delegation

```javascript
// One-off tasks don't need a saved specialist
delegate_task({
  task: "Research the top 10 AI startups and summarize their key metrics",
  tools: ["bash", "browser"]
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
2. Task matches existing specialist? -> Use `delegate_task` with `agentId`
3. Task is recurring/specialized? -> `create_sub_agent`, then delegate
4. Task is one-off? -> `delegate_task` without `agentId` (ephemeral)

## Key Principles

- **Specialists** improve over time as you refine their prompts
- **Ephemeral agents** are lighter weight for one-time tasks
- **Delegate token-heavy work** to save your context window
- **Sub-agents get fresh context** — include all necessary information in the task description
- **Use Agent Jobs** for recurring delegation (scheduled), sub-agents for in-conversation delegation
