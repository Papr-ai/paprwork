# Plan Enforcement Strategy

**Date:** 2026-02-19  
**Purpose:** Ensure agents ALWAYS create plans before working on mini-apps or jobs (creating OR updating)

---

## Problem Statement

Agents need to consistently create plans before starting any multi-step work on apps/jobs to:
1. ✅ Show users the approach transparently
2. ✅ Track progress with visible checkboxes in the UI
3. ✅ Allow resuming work if chat is closed/reopened
4. ✅ Prevent rushing into changes without proper planning
5. ✅ Make the process professional and organized

---

## Multi-Layer Enforcement

We enforce plan creation through **4 reinforcing layers**:

### Layer 1: Tool Catalog Emphasis (SystemPrompt.ts:322)

```typescript
{
  area: "Planning",
  enabled: has("create_plan") || has("update_plan"),
  details: "REQUIRED for any multi-step task — create_plan shows visible progress cards in the UI; update_plan marks steps complete as you go"
}
```

**Effect:** Agent sees planning is REQUIRED in the high-level capability matrix.

---

### Layer 2: Tool Description (planning.ts:64)

```typescript
description:
  "REQUIRED for any multi-step task, especially app/job creation or updates. Create a step-by-step plan shown to the user as a progress card. Plans are persisted and associated with the chat. Use BEFORE starting any mini-app or job work (creating OR updating). Returns the plan with step statuses."
```

**Effect:** When the LLM considers using `create_plan`, the description emphasizes it's required for app/job work.

---

### Layer 3: App Creation Reminder (Always-On) (SystemPrompt.ts:1397)

```markdown
## CRITICAL: Always Create a Plan for Mini-Apps & Jobs

**BEFORE creating OR updating any mini-app or job, ALWAYS use `create_plan`:**

**For NEW apps/jobs:**
create_plan({
  title: "Build [App Name] Mini-App",
  steps: [...]
})

**For UPDATING existing apps/jobs:**
create_plan({
  title: "Update [App Name] - Add [Feature]",
  steps: [...]
})

**Why plans are required:**
1. ✅ Shows the user your approach transparently
2. ✅ Tracks progress with visible checkboxes in the UI
3. ✅ Makes the process professional and organized
4. ✅ Prevents rushing into changes without thinking through the steps
5. ✅ Allows resuming work if chat is closed and reopened
```

**Effect:** Always-on reminder section that appears in every agent conversation.

---

### Layer 4: App Creation Playbook (Extended Context) (SystemPrompt.ts:1482)

```markdown
## STEP 0: Create Plan (REQUIRED)

**CRITICAL: ALWAYS create a plan before ANY app/job work (creating OR updating).**

**For NEW apps/jobs:**
create_plan({ ... })

**For UPDATING existing apps/jobs:**
create_plan({
  title: "Update [App Name] - [What's Changing]",
  steps: [
    { id: "review", description: "Review current implementation" },
    { id: "plan", description: "Plan changes to existing code" },
    { id: "implement", description: "Make the changes" },
    { id: "test", description: "Test updated functionality" }
  ]
})

**Exception:** Only skip the plan for trivial text changes (typo fixes, color tweaks). 
For ANY logic changes, new features, or restructuring: CREATE A PLAN FIRST.
```

**Effect:** When agent detects app/job automation context in history, extended playbook is loaded with explicit STEP 0 requirement.

---

## When Plans Are Required

### ✅ ALWAYS Create a Plan For:

1. **Creating new mini-apps** - Any app creation work
2. **Creating new jobs** - Python/Node/Agent jobs
3. **Updating existing apps** - Adding features, refactoring, major changes
4. **Updating existing jobs** - Changing logic, adding functionality
5. **Multi-step tasks** - Anything with 3+ steps

### 🔶 Exception (No Plan Needed):

- **Trivial text-only changes:**
  - Fixing typos in UI text
  - Changing CSS color values
  - Updating static strings
  - Minor cosmetic tweaks

**Rule of thumb:** If the change involves logic, structure, or could break functionality → CREATE A PLAN.

---

## Plan Template Examples

### For Creating New App:

```javascript
create_plan({
  title: "Build [App Name] Mini-App",
  steps: [
    { id: "check", description: "Check existing apps" },
    { id: "load_docs", description: "Load agent-docs & design system" },
    { id: "design", description: "Design UI following Liquid Glass" },
    { id: "prototype", description: "Create mockup with placeholder data" },
    { id: "validate", description: "Validate data sources" },
    { id: "implement", description: "Build real app with live data" },
    { id: "test", description: "Test all UX states" }
  ]
})
```

### For Updating Existing App:

```javascript
create_plan({
  title: "Update GitHub Activity Tracker - Add Commit Details",
  steps: [
    { id: "review", description: "Review current app structure" },
    { id: "schema", description: "Check if SQLite schema needs updating" },
    { id: "job", description: "Update job to fetch commit details" },
    { id: "ui", description: "Update app.ts to display commit data" },
    { id: "test", description: "Test with real repository data" }
  ]
})
```

### For Creating New Job:

```javascript
create_plan({
  title: "Build Daily News Aggregator Job",
  steps: [
    { id: "apis", description: "Test news API endpoints" },
    { id: "schema", description: "Design SQLite schema for articles" },
    { id: "job", description: "Create Python job with API calls" },
    { id: "schedule", description: "Set up daily cron schedule" },
    { id: "test", description: "Run job manually and verify data" }
  ]
})
```

---

## Plan Persistence & Resumption

### Storage:
- Plans are saved to `~/PAPR/data/plans.db` (SQLite)
- Associated with `chatId`
- Status: `active`, `completed`, or `cancelled`

### Loading on Chat Reopen:
When a chat is reopened, `AgentService.buildContextualSystemPrompt()`:
1. Calls `planService.getActivePlansForChat(chatId)`
2. Injects active plans into system prompt with:
   - Plan title and ID
   - Progress indicators (☑ completed, ▶ in progress, ☐ pending)
   - Instruction to continue existing plans vs. create new ones

### Agent Behavior on Reopen:
```markdown
# Active Plans (Unfinished Work)

You have **1** active plan(s) in this conversation. **Continue where you left off** by updating these plans as you progress.

### Build Authentication System (2/5 completed)
Plan ID: `plan-abc123`
  ☑ Install libraries
  ☑ Create database schema
  ☐ Build login endpoint
  ☐ Build registration endpoint
  ☐ Add tests

## How to Resume Work
1. **Check what's done**: Look at completed (☑) vs pending (☐) steps
2. **Continue the plan**: Start with the next pending step
3. **Update progress**: Use `update_plan({ planId: "...", updates: [...] })` to mark steps as you complete them
4. **Don't create duplicate plans**: Update existing plans instead of creating new ones for the same work
```

---

## Verification Checklist

To verify plan enforcement is working:

1. ✅ **Layer 1:** Check `SystemPrompt.ts` line 322 - Planning marked as REQUIRED
2. ✅ **Layer 2:** Check `planning.ts` line 64 - Tool description emphasizes requirement
3. ✅ **Layer 3:** Check `SystemPrompt.ts` line 1397 - Always-on reminder section
4. ✅ **Layer 4:** Check `SystemPrompt.ts` line 1482 - STEP 0 in App Creation Playbook
5. ✅ **Plan Persistence:** Check `PlanService.ts` - SQLite storage working
6. ✅ **Plan Loading:** Check `AgentService.ts` line 1285 - Active plans loaded on chat reopen
7. ✅ **System Prompt Injection:** Check `SystemPrompt.ts` line 1561 - Plans injected into prompt

---

## Testing Plan Enforcement

### Test Case 1: New App Creation
```
User: "Create a GitHub activity tracker app"
Expected: Agent MUST call create_plan before any create_app calls
```

### Test Case 2: Update Existing App
```
User: "Update the GitHub tracker to show commit messages"
Expected: Agent MUST call create_plan with "Update [App] - [Feature]" title
```

### Test Case 3: Chat Resumption
```
1. User: "Build authentication system"
2. Agent: [creates plan, completes 2/5 steps]
3. User closes chat
4. User reopens chat
Expected: Agent sees active plan in system prompt, continues from step 3
```

### Test Case 4: Trivial Change (Exception)
```
User: "Change the header color to blue"
Expected: Agent MAY skip plan (trivial CSS change)
```

---

## Related Files

- `src/core/agents/SystemPrompt.ts` - Plan requirement in 4 places
- `src/core/tools/planning.ts` - Tool definitions with enforcement in description
- `src/gateway/services/PlanService.ts` - SQLite persistence
- `src/gateway/services/AgentService.ts` - Plan loading on chat reopen

---

## Success Metrics

1. **Plan creation rate:** 95%+ of app/job work should start with a plan
2. **Plan completion:** Plans should be updated as work progresses
3. **Plan resumption:** Reopening chats should continue existing plans
4. **User visibility:** Users should see plan cards in UI during work

---

**This is a living document. Update as enforcement strategy evolves.**
