---
id: preloaded-delegation-strategy
name: Delegation & Planning Strategy
description: When and how to delegate work to sub-agents — patterns for using existing specialists, creating new ones, ephemeral delegation, and using create_plan for complex multi-step work.
---
# Delegation & Planning Strategy

## When to Delegate

Use `delegate_task` when:
- **Token-heavy operations**: Web scraping, browsing multiple pages, large code analysis
- **Specialized work**: Code reviews, content writing, UI design, data analysis
- **Parallel tasks**: Multiple independent research/collection tasks
- **Fresh context needed**: Task doesn't need your conversation history
- **Long-running operations**: Tasks that might take many steps

## Available Specialist Agents

Use `list_sub_agents` to see currently available agents. Default specialists include:

- **Research Specialist** — Web research, data gathering, competitive analysis. Tools: bash, browser, papr_memory
- **Implementation Specialist** — Code writing, debugging, testing. Tools: bash, read_file, write_file, browser
- **Custom Agents** — Create with `create_sub_agent` for recurring specialized tasks

---

## Delegation Patterns

### Pattern 1: Use Existing Specialist

```javascript
list_sub_agents()  // Check what's available first

delegate_task({
  task: "Review the authentication code in ~/project/auth.js for security issues",
  agentId: "implementation-specialist",
  tools: ["bash"]
})
```

### Pattern 2: Create New Specialist (for recurring tasks)

```javascript
create_sub_agent({
  name: "E-commerce Scraper",
  systemPrompt: "You specialize in scraping product data from e-commerce sites...",
  allowedToolIds: ["bash", "browser"],
  assignedSkills: []
})

delegate_task({
  task: "Scrape product data from these 50 e-commerce sites",
  agentId: "e-commerce-scraper"
})
```

### Pattern 3: Ephemeral Delegation (one-off tasks)

```javascript
delegate_task({
  task: "Research the top 10 AI startups and summarize their key metrics",
  tools: ["bash", "browser"]
  // No agentId needed — creates a temporary agent
})
```

---

## Planning Strategy

Use `create_plan` BEFORE starting complex work:
- **Multi-step tasks** (3+ steps): Break down into clear todos
- **Long operations**: Give users visibility into progress
- **App/job builds**: Required before building any mini-app

### Example Workflow

```javascript
// 1. Create the plan upfront
create_plan({
  title: "AI Company Research Report",
  steps: [
    { id: "research", description: "Research top AI companies" },
    { id: "analyze", description: "Analyze their metrics" },
    { id: "report", description: "Create comprehensive report" }
  ]
})

// 2. Update status as you work — users see checkboxes checking off in real-time
update_plan({ planId: "...", updates: [{ stepId: "research", status: "completed" }] })
update_plan({ planId: "...", updates: [{ stepId: "analyze", status: "in_progress" }] })
```

---

## Agent Management Decision Tree

1. `list_sub_agents` → See available specialists
2. Task matches existing specialist? → `delegate_task` with `agentId`
3. Task is recurring/specialized? → `create_sub_agent`, then delegate
4. Task is one-off? → `delegate_task` without `agentId` (ephemeral)

## Key Principles

- **Specialists** improve over time as you refine their prompts
- **Ephemeral agents** are lighter weight for one-time tasks
- **Delegate token-heavy work** to save your context window
- **Sub-agents get fresh context** — include ALL necessary information in the task description
- **Use Agent Jobs** for recurring scheduled delegation, sub-agents for in-conversation delegation
