# Onboarding — First Run Interview

This file guides the agent through user onboarding. Follow these instructions when this file is present.

## Your Goal

Deeply understand who the user is and what would make Paprwork most valuable to them. Then write what you learn to IDENTITY.md, MEMORY.md, AGENTS.md, and TOOLS.md so every future session starts with full context.

## Interview Phase

Ask 3-5 thoughtful questions. Don't rush — this is the most important phase.

**Core questions:**

1. What industry or field are you in? What does your day-to-day look like?
2. What tasks do you do most frequently that feel repetitive?
3. What tools, apps, or data sources do you use regularly? (CRM, project management, spreadsheets, APIs, etc.)
4. What would save you the most time each day?
5. How do you prefer to communicate? (Concise vs detailed, casual vs formal, bullet points vs paragraphs)

**Listen carefully for:**
- Data sources they access (APIs, databases, spreadsheets, CRMs)
- File types they work with (PDFs, CSVs, documents, presentations)
- External systems they use (project management, email, calendar, social media)
- Pain points and bottlenecks
- Communication preferences and tone
- Specific tools/platforms they mention

## Configuration Phase

After the interview, write what you learned to workspace files:

### 1. Update IDENTITY.md

Write the user's profile:
```markdown
## About
- Name: [name]
- Role: [role]
- Industry: [industry]
- Organization: [org if mentioned]

## Communication Style
- [preferences discovered during interview]

## Current Projects
- [what they're working on]

## Goals
- [what they want from Paprwork]

## Domain Context
- [industry-specific terms, tools, workflows]
```

### 2. Update MEMORY.md

Record initial decisions and context:
```markdown
## Decisions
- [YYYY-MM-DD] Initial setup: [what was configured and why]

## Preferences
- [key preferences discovered]

## Patterns
- [workflow patterns noted]
```

### 3. Update TOOLS.md

Record environment details:
```markdown
## System
- [OS and relevant details]

## API Keys Configured
- [any keys mentioned]

## Installed Tools
- [tools they confirmed having]
```

### 4. Update AGENTS.md

Add any user-specific workflow rules:
```markdown
## User-Specific Rules
- [any preferences that affect agent behavior]
```

## Setup Phase

Based on what you learned, set up relevant features:

1. **Install relevant skills** from the skills catalog (`read_file("~/PAPR/skills-catalog.json")`)
2. **Create Papr Memory schemas** for their domain if needed
3. **Create specialist agents** for recurring needs
4. **Create 1-2 starter jobs** for immediate time-savers
5. **Create a starter app** if there's an obvious dashboard/tool opportunity

## Completion

After writing all workspace files and setting up features:

1. Rename this file: `bash({ command: "mv ~/PAPR/workspace/ONBOARD.md ~/PAPR/workspace/ONBOARD.completed.md" })`
2. Create a summary document with `create_document` explaining what was configured
3. Tell the user their agent is ready and walk them through what was set up

## Important

- Be thorough in the interview — don't skip questions
- Write detailed workspace files — they're the agent's memory across sessions
- Always use `create_document` for documents, never create DOCX files directly
- Test everything you set up before presenting it to the user
