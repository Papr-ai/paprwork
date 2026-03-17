# Agent Setup & Onboarding Workflow (V2)

## Overview

When a user asks to "set up my agent", "help me with my work", or wants to configure Paprwork for their needs, follow this onboarding process.

**Trigger recognition:** This flow is auto-triggered when the user clicks "Setup Your Agents" in the onboarding card. The message will be: "I want to set up my agent to help me with my work. Can you ask me some questions about what I do and what I need help with?" Start immediately with the interview phase.

---

## Interview Phase

Your goal is to deeply understand what the user does and what would make Paprwork most valuable to them. Ask 3-5 thoughtful questions. Don't rush — this is the most important phase.

**Core questions:**

1. What industry or field are you in? What does your day-to-day look like?
2. What are the tasks you do most frequently that feel repetitive?
3. What tools, apps, or data sources do you use regularly? (CRM, project management, spreadsheets, APIs, etc.)
4. What would save you the most time each day?
5. What data do you access frequently? (databases, files, websites, APIs)

**Listen carefully for:**
- Data sources they access (APIs, databases, spreadsheets, CRMs)
- File types they work with (PDFs, CSVs, documents, presentations)
- External systems they use (project management, email, calendar, social media)
- Pain points and bottlenecks — what frustrates them
- Recurring patterns in their work
- Specific tools/platforms they mention (HubSpot, Notion, Slack, Stripe, etc.)

**Do NOT ask about:**
- Automation comfort level — Paprwork handles this transparently
- Technical constraints — we figure these out during configuration
- Privacy preferences — Paprwork is local-first by design

---

## Configuration Phase

After the interview, tell the user what you're going to set up and why. Then execute.

### 1. Create Papr Memory Schemas

Use `register_schema` to set up data structures for their domain:

```javascript
register_schema({
  name: "LinkedIn Leads",
  nodeTypes: ["Lead", "Company", "Contact"],
  relationshipTypes: ["WORKS_AT", "CONNECTED_TO"]
})
```

### 2. Install Relevant Skills

**Step A: Check pre-installed skills**

Use `read_skill()` (no arguments) to list all installed skills. Scan for skills relevant to the user's domain.

**Step B: Browse the skills catalog**

Read the cached skills catalog to find additional skills for the user:

```javascript
read_file({ path: "~/PAPR/skills-catalog.json" })
```

This file contains popular skills from skills.sh and ClawHub, organized by category. Search it for skills matching the user's industry and needs. Do NOT browse the web for skills — everything is in this catalog.

**Step C: Install discovered skills**

For each useful skill found in the catalog, create it locally:
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
- **Design:** Paprwork Design System (covers visual, identity, and implementation)

### 3. Set Up Specialist Agents

Create purpose-built agents for their recurring needs:

```javascript
create_sub_agent({
  name: "Lead Manager",
  systemPrompt: "You specialize in finding and qualifying sales leads...",
  allowedToolIds: ["browser", "bash"],
  assignedSkills: ["content-strategy"]
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

Before building apps from scratch, check if a community bundle already solves the user's need. Browse available bundles:

```javascript
list_app_bundles()
```

If a relevant community app exists (e.g., expense tracker for finance users), import it directly:

```javascript
import_app_bundle({ source: "https://github.com/Papr-ai/paprwork-community-apps/bundles/expense-tracker" })
```

The community repo at `https://github.com/Papr-ai/paprwork-community-apps` contains curated app bundles organized by category. Each bundle includes the app, optional jobs, and database schemas — ready to use immediately.

**Step B: Create custom apps for needs not covered by community bundles**

```javascript
create_app({
  title: "Customer Dashboard",
  description: "View and manage customer data from Papr Memory"
})
```

Prefer importing community apps over building from scratch — they're tested, well-designed, and ready to use. Only create custom apps when the user's needs aren't met by existing community bundles.

### 6. Create Initial Documents

Always use `create_document` for new documents — never create DOCX files directly:

```javascript
create_document({
  title: "Setup Summary",
  content: "# Workspace Setup\n\n## What was configured\n\n..."
})
```

Users can export any document to DOCX from the editor toolbar when needed. To import existing Word files, use `import_document` which auto-converts DOCX to Markdown.

---

## Testing Phase

Walk them through using what you configured:

1. **Test the schemas** — Add sample data, query it back, show relationships
2. **Demo the skills** — Show how to invoke skills, explain when each is useful
3. **Try the specialist agents** — Run a task, show results
4. **Launch the apps** — Open apps, walk through key features
5. **Test the jobs** — Run a job with `run_job`, inspect logs with `read_job_logs`

---

## Example Complete Flow

**User:** "I want to set up my agent to help me with my work. Can you ask me some questions about what I do and what I need help with?"

**You:** "I'd love to help you get the most out of Paprwork! Let me learn about your work so I can set things up perfectly for you.

1. What industry or field are you in? What does your day-to-day look like?
2. What tasks do you do most frequently that feel repetitive?
3. What tools or data sources do you use regularly?
4. What would save you the most time each day?"

**User:** "I'm in real estate. I spend a lot of time tracking properties, following up with leads, and creating property reports."

**You:** "Great — real estate is a perfect fit for Paprwork. Based on what you've told me, here's what I'm going to set up:

1. **Papr Memory schema** for properties, leads, and showings
2. **Relevant skills** — I'll check the catalog for real estate tools
3. **Property Dashboard app** so you can track everything in one place
4. **Lead Follow-Up job** that automatically reminds you about stale leads
5. **Setup summary document** with everything configured

Let me get started..."

Then execute:
```javascript
// 1. Read the skills catalog to find relevant skills
read_file({ path: "~/PAPR/skills-catalog.json" })

// 2. Create schema
register_schema({
  name: "Real Estate CRM",
  nodeTypes: ["Property", "Lead", "Showing", "Offer"],
  relationshipTypes: ["INTERESTED_IN", "VIEWED", "MADE_OFFER"]
})

// 3. Create specialist agent
create_sub_agent({
  name: "Property Researcher",
  systemPrompt: "You specialize in real estate research...",
  allowedToolIds: ["browser", "bash"]
})

// 4. Create recurring job
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
create_app({
  title: "Property Dashboard",
  description: "Track properties and leads in one place"
})

// 6. Create setup summary document
create_document({
  title: "Workspace Setup Summary",
  content: "# Your Paprwork Setup\n\n## Configured for: Real Estate\n\n..."
})
```

---

## Best Practices

1. **Be thorough in the interview** — Don't skip questions. Understand their workflow deeply
2. **Read the skills catalog** — Use `read_file("~/PAPR/skills-catalog.json")` to find relevant skills. Never browse the web for skills
3. **Match skills to their domain** — Install only what's relevant to what they told you
4. **Community apps first** — Check community bundles at `https://github.com/Papr-ai/paprwork-community-apps` before building apps from scratch. Import pre-built apps when they fit the user's needs, create custom apps only for unmet needs
5. **Always use create_document** — Never create DOCX files directly
6. **Test everything** — Walk them through each feature you configured
7. **Provide a summary** — Create a document summarizing what was configured
8. **Follow up** — Ask how the setup is working and if they need adjustments

This personalized setup makes Paprwork immediately valuable for users.
