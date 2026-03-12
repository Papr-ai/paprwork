# Session Summary: System Prompt & Tool Improvements

**Date:** 2026-03-09
**Focus:** Agent behavior improvements for API keys, plans, and design system

---

## Issues Addressed

### 1. API Keys in Jobs ✅
**Problem:** Agent didn't know that `${KEY_NAME}` substitution only works in command field, not in Python source code.

**Solution:** Added explicit section to system prompt with ✅/❌ examples showing:
- Correct: Pass keys as CLI args in `command` field
- Wrong: Put `${KEY_NAME}` in Python source code
- Pattern: Use argparse to receive values in scripts

### 2. Incremental Plan Updates ✅
**Problem:** Agent created plans but only updated them after all steps were complete.

**Solution:** Multi-layer enforcement:
- Updated capability matrix
- Added detailed behavior section with examples
- Updated tool description
- Added "Only call ONCE" guidance
- Enhanced active plans resume section

### 3. Plan Tool Multiple Calls ✅
**Problem:** Claude called `create_plan` 3 times, said "formatting issue", then skipped planning.

**Solution:** 
- Changed tool to return JSON.stringify with prominent success message
- Added clear guidance: "Don't call again if you see 'Plan created'"
- Updated PlanCard parser to handle double-stringified JSON
- Made success unmistakable with checkmarks and next-step guidance

### 4. Design System Loading ✅
**Problem:** Agent created UI without loading design system, resulting in inconsistent styling.

**Solution:**
- Added Rule #4 to capability matrix
- Added detailed section in app creation reminder
- Updated workflow order to include design system as first step for UI work
- Listed explicit scenarios when to load it

---

## Files Changed

### Core Tools
1. **`src/core/tools/planning.ts`**
   - Added descriptive `message` fields to both tools
   - Changed return to `JSON.stringify` for Claude clarity
   - Updated `createPlanTool` description with "ONCE per task" warning
   - Updated `updatePlanTool` description with "AFTER EACH STEP" emphasis

### System Prompt
2. **`src/core/agents/SystemPrompt.ts`**
   - **API Keys Section** - Added to `buildAutomationArchitectureSection()` with code examples
   - **Plan Updates** - Strengthened in 5 places:
     - Capability matrix
     - Behavior section (detailed examples)
     - App creation reminder
     - Active plans section
     - Workflow order
   - **Design System** - Added to:
     - Capability matrix (Rule #4)
     - App creation reminder (detailed section)
     - Workflow order

### UI Components
3. **`ui/components/Chat/PlanCard.tsx`**
   - Added double-stringified JSON handling
   - Improved error recovery with recursive parsing

### Documentation
4. **`docs/SYSTEM_PROMPT_IMPROVEMENTS_API_KEYS_PLANS.md`**
5. **`docs/PLAN_TOOL_MULTIPLE_CALLS_ISSUE.md`**
6. **`docs/PLAN_TOOL_FIX_SUMMARY.md`**
7. **`docs/CLAUDE_TOOL_RESULT_FORMAT_FIX.md`**
8. **`docs/DESIGN_SYSTEM_LOADING_ENFORCEMENT.md`**

---

## Key Patterns Used

### 1. Multi-Layer Reinforcement
Don't rely on a single mention - reinforce critical behaviors in multiple places:
- Capability matrix (first mention)
- Tool description (at point of use)
- Behavior section (detailed examples)
- App creation reminder (workflow context)
- Active plans section (resume context)

### 2. Visual Emphasis
Use markers that stand out:
- `CRITICAL:`
- `REQUIRED`
- `AFTER EACH STEP`
- `ONCE per task`
- `Don't ... without it`
- Bold text and repeated phrasing

### 3. Clear Examples
Show both correct and incorrect patterns:
- ✅ **CORRECT** - with explanation
- ❌ **WRONG** - with explanation of why

### 4. Explicit Scope
Don't say "use when appropriate" - list specific scenarios:
- "This includes: Creating new mini-apps, Editing app files, Updating styling..."
- "Required for: Building or updating a mini-app, Creating a job pipeline..."

### 5. Actionable Guidance
Tell agent exactly what to do:
- "Load design system FIRST"
- "Update plan IMMEDIATELY after each step"
- "Only call create_plan ONCE"
- "Put ${KEY_NAME} in command field, use argparse in script"

---

## Testing Checklist

### API Keys in Jobs
- [ ] Agent creates Python job with API call
- [ ] Verify command includes `--api-key ${OPENAI_API_KEY}`
- [ ] Verify Python script uses argparse, not `${KEY}`
- [ ] Job runs successfully with key substitution

### Incremental Plan Updates
- [ ] Agent creates plan for multi-step task
- [ ] Verify `update_plan` called after EACH step
- [ ] Verify UI shows real-time progress
- [ ] Plan card updates live, not in batch

### Plan Tool Single Call
- [ ] Agent creates plan once (not 3 times)
- [ ] No "formatting issue" messages
- [ ] Plan card renders correctly
- [ ] Works with both ChatGPT and Claude OAuth

### Design System Loading
- [ ] Agent loads design system before `create_app`
- [ ] Agent loads design system before editing UI files
- [ ] Generated UIs follow Liquid Glass aesthetic
- [ ] Colors, typography, spacing match design tokens

---

## Success Metrics

After deployment, monitor:

1. **API Key Usage Pattern:**
   - % of jobs with keys in command (should be 100%)
   - % of jobs with keys in source code (should be 0%)

2. **Plan Update Frequency:**
   - Avg updates per plan (should be ≈ number of steps)
   - Time between plan creation and first update (should be <30s)

3. **Plan Creation Rate:**
   - % of plans with multiple creation calls (should be <5%)
   - Frequency of "formatting issue" messages (should be 0%)

4. **Design System Usage:**
   - % of UI work that loads design system (should be 95%+)
   - Consistency score from manual UI review (should improve)

---

## Lessons Learned

### 1. Claude vs ChatGPT Differences
Claude has different expectations for:
- **Planning confirmations** - Needs very clear success signals
- **Tool result formats** - Stringification affects interpretation
- **Retry behavior** - More defensive about unclear results

Solution: Return prominent, human-readable messages for critical operations.

### 2. System Prompt Effectiveness
Single mentions aren't enough for critical behaviors. Use:
- Multiple reinforcement points
- Visual emphasis (CRITICAL, REQUIRED)
- Concrete examples (✅/❌)
- Explicit scope lists
- Actionable instructions

### 3. Tool Return Formats
For tools that show UI cards or critical confirmations:
- Consider returning formatted strings, not just JSON
- Include clear success indicators (checkmarks, explicit messages)
- Provide next-step guidance
- Make success unmistakable

### 4. Progressive Disclosure
Balance between:
- **System prompt** - Core patterns, critical rules, quick reference
- **Skills** - Detailed workflows, edge cases, advanced patterns
- **Agent docs** - Complete reference, architecture, best practices

Don't try to put everything in system prompt - guide to the right resource.

---

## Next Steps

### Short Term
1. Monitor metrics after deployment
2. Watch for Claude retry behavior on other tools
3. Collect feedback on UI consistency
4. Track plan update patterns

### Medium Term
1. Consider adding validation warnings in tools
2. Add automatic design system dependency hints
3. Create skill dependency system
4. Build automated UI consistency linting

### Long Term
1. ML-based detection of missing design system loads
2. Automatic suggestion system for relevant skills
3. Visual diff tools for design system compliance
4. Context-aware skill loading

---

## Impact

These changes make the agent:
- **More reliable** - Follows critical workflows correctly
- **More predictable** - Consistent behavior across LLM providers
- **More professional** - Better UI consistency, proper planning
- **More efficient** - Less rework, fewer retries, clearer guidance

Users benefit from:
- **Better UX** - Consistent Liquid Glass aesthetic
- **Less confusion** - Plans show clear progress
- **Fewer errors** - API keys work correctly in jobs
- **More trust** - Agent follows best practices reliably
