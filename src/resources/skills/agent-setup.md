---
id: preloaded-agent-setup
name: Agent Setup & Onboarding Workflow
description: Complete workflow for onboarding a user — interview phase, configuring Papr Memory schemas, installing relevant skills, creating specialist agents, starter jobs, apps, and documents. Triggered when user asks to "set up my agent" or clicks Setup Your Agents.
---
# Agent Setup & Onboarding Workflow

**Trigger:** User asks to "set up my agent", "help me with my work", or clicks "Setup Your Agents" in the onboarding card. The message will be: "I want to set up my agent to help me with my work. Can you ask me some questions..."

Start immediately with the interview phase.

---

## Interview Phase

Ask 3-5 thoughtful questions. Don't rush — this is the most important phase.

**Core questions:**
1. What industry or field are you in? What does your day-to-day look like?
2. What are the tasks you do most frequently that feel repetitive?
3. What tools, apps, or data sources do you use regularly? (CRM, project management, spreadsheets, APIs, etc.)
4. What would save you the most time each day?
5. What data do you access frequently? (databases, files, websites, APIs)

**Listen for:**
- Data sources (APIs, databases, spreadsheets, CRMs)
- File types they work with (PDFs, CSVs, documents, presentations)
- External systems (project management, email, calendar, social media, HubSpot, Notion, Slack, Stripe)
- Pain points and bottlenecks
- Recurring patterns in their work

**Do NOT ask about:** automation comfort level, technical constraints, privacy preferences.

---

## Configuration Phase

Tell the user what you're going to set up and why, then execute.

### 1. Create Papr Memory Schemas

```javascript
register_schema({
  name: "LinkedIn Leads",
  nodeTypes: ["Lead", "Company", "Contact"],
  relationshipTypes: ["WORKS_AT", "CONNECTED_TO"]
})
```

### 2. Install Relevant Skills

**Step A: Check pre-installed skills**
```javascript
read_skill()  // No args — lists all installed skills
```

**Step B: Browse the skills catalog**
```javascript
read_file({ path: "~/PAPR/skills-catalog.json" })
```
This has popular skills organized by category. Search for skills matching the user's industry. Do NOT browse the web for skills — everything is in this catalog.

**Step C: Install discovered skills**
```javascript
create_skill({
  name: "Discovered Skill Name",
  description: "What it does",
  content: "Full skill content adapted for Paprwork..."
})
```

**Common skills by domain:**
- **Marketing:** Content Strategy, Copywriting, SEO Audit, Social Media Scheduler
- **Development:** Systematic Debugging, GitHub Integration, Paprwork Design System
- **Research:** Summarize Content, Brainstorming, Web Scraping
- **Productivity:** XLSX, PPTX, Doc Co-Authoring, Calendar Tools
- **Finance:** Yahoo Finance, Data Analysis
- **Sales:** CRM Tools, Email Tools, Lead Management
- **Design:** Paprwork Design System (visual identity + implementation)

### 3. Set Up Specialist Agents

```javascript
create_sub_agent({
  name: "Lead Manager",
  systemPrompt: "You specialize in finding and qualifying sales leads...",
  allowedToolIds: ["browser", "bash"],
  assignedSkills: []
})
```

### 4. Create Starter Jobs

Build 1-2 jobs that address their immediate needs:

```javascript
create_job({
  name: "Daily Tech News",
  type: "agent",
  task: "Browse TechCrunch, Hacker News, ArsTechnica. Extract top 10 stories with summaries.",
  tools: ["browser"],
  schedule: "0 9 * * *",
  deliver: { channel: "chat", targetId: "main" }
})
```

### 5. Import Community Apps or Create Starter Apps

**Step A: Check the community app registry for relevant pre-built apps**
```javascript
import_app_bundle({ source: "https://github.com/Papr-ai/paprwork-community-apps" })
```

Before building apps from scratch, check if a community bundle already solves the user's need. Browse the community registry by listing available bundles:
```javascript
list_app_bundles()
```

If a relevant community app exists (e.g., expense tracker for finance users), import it:
```javascript
import_app_bundle({ source: "https://github.com/Papr-ai/paprwork-community-apps/bundles/expense-tracker" })
```

**Step B: Create custom apps for needs not covered by community bundles**
```javascript
create_app({
  title: "Customer Dashboard",
  description: "View and manage customer data from Papr Memory"
})
```

Prefer importing community apps over building from scratch — they're tested and ready to use. Only create custom apps when the user's needs aren't met by existing bundles.

### 6. Create Setup Summary Document

Always use `create_document` — never create DOCX files directly. Users export to DOCX from the editor toolbar.

```javascript
create_document({
  title: "Workspace Setup Summary",
  content: "# Your Paprwork Setup\n\n## What was configured\n\n..."
})
```

---

## Testing Phase

Walk them through what you configured:
1. **Test schemas** — Add sample data, query it back, show relationships
2. **Demo skills** — Show how to invoke skills, explain when each is useful
3. **Try specialist agents** — Run a delegate_task, show results
4. **Launch apps** — Open apps, walk through features
5. **Test jobs** — `run_job` then `read_job_logs`

---

## Example Complete Flow (Real Estate)

**User:** "I'm in real estate. I track properties, follow up with leads, and create property reports."

**You:** "Based on what you've told me, here's what I'm going to set up:
1. Papr Memory schema for properties, leads, and showings
2. Relevant skills from the catalog for real estate
3. Property Dashboard app
4. Lead Follow-Up job that reminds you about stale leads
5. Setup summary document

Let me get started..."

```javascript
// 1. Find relevant skills
read_file({ path: "~/PAPR/skills-catalog.json" })

// 2. Create schema
register_schema({
  name: "Real Estate CRM",
  nodeTypes: ["Property", "Lead", "Showing", "Offer"],
  relationshipTypes: ["INTERESTED_IN", "VIEWED", "MADE_OFFER"]
})

// 3. Create specialist
create_sub_agent({
  name: "Property Researcher",
  systemPrompt: "You specialize in real estate research...",
  allowedToolIds: ["browser", "bash"]
})

// 4. Recurring job
create_job({
  name: "Lead Follow-Up",
  type: "agent",
  task: "Check lead list, suggest follow-up actions for leads not contacted in 3 days.",
  schedule: "0 9 * * 1-5",
  deliver: { channel: "chat", targetId: "main" }
})

// 5. Check community apps first, then create custom ones
list_app_bundles()  // See what's available
// Import relevant community apps if they match user needs
// Then create custom apps for anything not covered:
create_app({ title: "Property Dashboard", description: "Track properties and leads" })

// 6. Summary doc
create_document({ title: "Workspace Setup Summary", content: "# Your Paprwork Setup\n..." })
```

---

## Best Practices

1. **Be thorough in the interview** — understand workflow deeply before configuring
2. **Read the skills catalog** — use `read_file("~/PAPR/skills-catalog.json")`, never browse web for skills
3. **Match skills to their domain** — install only relevant skills
4. **Community apps first** — check community bundles before building apps from scratch. Import pre-built apps when they fit, create custom apps only for unmet needs
5. **Always use create_document** — never create DOCX directly
6. **Test everything** — walk through each configured feature
7. **Provide a summary** — create a document summarizing what was configured
