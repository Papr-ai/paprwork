# System Prompt Improvements: API Keys in Jobs & Plan Updates

**Date:** 2026-03-09
**Issue:** Agent didn't know how to use API keys in jobs and wasn't updating plans incrementally

---

## Problems Identified

### 1. API Keys in Jobs
**Problem:** Agent didn't understand that `${KEY_NAME}` substitution only works in the `command` field of `create_job`, not in Python source code.

**Impact:** Agent would write Python scripts with `${OPENAI_API_KEY}` hardcoded in source files, which would fail at runtime because substitution doesn't happen in source code.

### 2. Plan Updates Not Incremental
**Problem:** Agent would create plans but only update them after all steps were complete, not after each step.

**Impact:** Users couldn't see real-time progress, defeating the purpose of plan cards in the UI.

---

## Solutions Implemented

### 1. API Keys in Jobs - Added to System Prompt

**Location:** `src/core/agents/SystemPrompt.ts` → `buildAutomationArchitectureSection()`

**What was added:**

```typescript
## CRITICAL: How to Use API Keys in Jobs

**Key substitution happens in the `command` string ONLY, not in script source code.**

✅ **CORRECT - Pass keys as CLI arguments:**
```javascript
create_job({
  name: "API Job",
  type: "python",
  command: "python3 code/main.py --api-key ${OPENAI_API_KEY} --secret ${STRIPE_KEY}",
  requirements: ["requests"]
})
```

Then in `code/main.py`:
```python
import argparse
parser = argparse.ArgumentParser()
parser.add_argument('--api-key', required=True)
parser.add_argument('--secret', required=True)
args = parser.parse_args()
# Now use args.api_key and args.secret
```

❌ **WRONG - Putting ${KEY_NAME} in Python source:**
```python
# DON'T DO THIS - ${KEY_NAME} only works in command string
api_key = "${OPENAI_API_KEY}"  # This will NOT be substituted!
```

**Pattern:** Put `${KEY_NAME}` in the `command` field of `create_job`, then accept values via CLI arguments (argparse/process.argv) in the script.
```

**Why this works:**
- Shows correct pattern with actual code examples
- Shows what NOT to do with clear explanation
- Immediately visible in system prompt (doesn't require skill loading)
- Still references skill for complete guidance

---

### 2. Plan Updates - Strengthened Multiple Sections

#### A. Capability Matrix
**Changed:**
```typescript
"REQUIRED for any multi-step task — create_plan at start, update_plan after EACH step (not at the end). Plans show visible progress in UI."
```

#### B. Agent Behavior Section
**Added:**
```typescript
**CRITICAL: Update plan AFTER EACH STEP, not at the end:**
```javascript
// After completing "check" step:
update_plan({ planId: "...", updates: [{ stepId: "check", status: "completed" }] })

// After completing "data" step:
update_plan({ planId: "...", updates: [{ stepId: "data", status: "completed" }] })

// Continue for each step - this shows REAL-TIME progress to the user
```

**Why update incrementally:**
- Users see progress in real-time (plan card updates live in UI)
- Clear checkpoint if conversation is interrupted
- Better for debugging - know exactly where you stopped
- Professional workflow visibility

**Don't wait until all steps are done to update the plan** - that defeats the purpose of showing progress!
```

#### C. App Creation Reminder
**Added workflow order:**
```typescript
**Workflow order:**
1. Load skill → 2. Create plan → 3. Check existing apps → 4. Start work → 5. Update plan after each step
```

**Strengthened skill loading:**
```typescript
**3. Load Documentation BEFORE Starting:**
`read_skill({ skillId: "preloaded-app-and-jobs-guide" })` — Read this skill FIRST, before any app/job work. Don't assume you know the patterns - load the skill to see the latest workflow, API key usage, and anti-patterns.
```

#### D. Active Plans Section
**Changed:**
```typescript
3. **Update progress IMMEDIATELY**: Call `update_plan` RIGHT AFTER completing each step - don't wait until the end

**IMPORTANT:** 
- When the user asks about progress, reference these plans
- Update the plan after EACH step completes, not in batches
- This shows real-time progress to the user
```

#### E. Tool Description Update
**Location:** `src/core/tools/planning.ts` → `updatePlanTool`

**Changed description to:**
```typescript
"Update step statuses in an existing plan. CRITICAL: Call this AFTER EACH STEP completes, not at the end. This shows real-time progress to the user. Mark steps as in_progress when starting, completed when done. Plans are persisted to disk."
```

---

## Why These Changes Work

### Multi-Layer Reinforcement Strategy

1. **Capability Matrix** - First mention sets expectation
2. **Tool Description** - Explicit in the tool itself
3. **Agent Behavior** - Detailed section with examples
4. **App Creation Reminder** - Workflow order clearly stated
5. **Active Plans** - Reinforcement when resuming work

This creates multiple touchpoints throughout the system prompt, ensuring the agent sees the guidance no matter which section it's reading.

### Progressive Disclosure

- **Quick reference** in capability matrix and app reminder
- **Detailed examples** in behavior section with code samples
- **Full details** in skills (loaded on demand)

### Visual Emphasis

Using markers like:
- `CRITICAL:`
- `AFTER EACH STEP`
- `not at the end`
- Bold text and repeated phrasing

Makes the guidance impossible to miss.

---

## Testing Strategy

### API Keys in Jobs
**Test cases:**
1. Ask agent to create a Python job that calls OpenAI API
2. Verify command includes `--api-key ${OPENAI_API_KEY}`
3. Verify Python script uses `argparse` to receive key
4. Verify script does NOT contain `${OPENAI_API_KEY}` in source

### Plan Updates
**Test cases:**
1. Ask agent to build a mini-app (multi-step task)
2. Verify `create_plan` is called at start
3. Verify `update_plan` is called after EACH step completes
4. Verify UI shows incremental progress (not all at end)
5. Verify agent loads skill before starting work

---

## Files Changed

1. `src/core/agents/SystemPrompt.ts`
   - Added API keys section to `buildAutomationArchitectureSection()`
   - Strengthened plan updates in `buildBehaviorSection()`
   - Updated capability matrix for planning
   - Enhanced app creation reminder with workflow order
   - Improved active plans resume guidance

2. `src/core/tools/planning.ts`
   - Updated `updatePlanTool` description to emphasize incremental updates

---

## Related Documentation

- Skills still contain complete guidance:
  - `preloaded-app-and-jobs-guide` - Full workflow patterns
  - `preloaded-api-key-testing` - Complete testing protocol
  
- System prompt now has enough core guidance for common patterns
- Agent should still load skills for complex scenarios
- Balance: Core patterns in system prompt, advanced patterns in skills

---

## Metrics to Track

After deployment, monitor:

1. **API Key Usage Pattern:**
   - % of jobs with keys in command vs source code
   - Failure rate for jobs with API calls

2. **Plan Update Frequency:**
   - Average updates per plan
   - Time between plan creation and first update
   - % of plans with incremental updates vs batch updates

3. **Skill Loading:**
   - % of app/job tasks where skills loaded first
   - Correlation between skill loading and success rate

---

## Future Improvements

Consider:
1. Add linting/validation for job commands (warn if `${KEY}` in Python source)
2. Auto-prompt agent to update plan if X steps completed without update
3. Plan card UI could show "Last updated X minutes ago" to make staleness visible
4. Agent could receive reminder if plan hasn't been updated in >5 minutes during active work
