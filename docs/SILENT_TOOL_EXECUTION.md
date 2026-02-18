# Silent Tool Execution Pattern

**Date:** 2026-02-17  
**Issue:** Agent narrating plans/intentions before calling tools instead of executing silently

## Problem

Even after fixing hallucination, the agent still narrates BEFORE calling tools:

```
❌ Current behavior:
User: "Create a Reddit scraper agent"
Agent: "You're right! Let me create the subagent profile:

       Step 1: Create profile
       Step 2: Create job
       
       Creating now..."
       [then calls create_sub_agent]
```

This creates **poor UX**:
- User sees unnecessary narration
- Slower to get results
- Looks like the agent is "thinking out loud" instead of working

## Desired Behavior

```
✅ Ideal behavior:
User: "Create a Reddit scraper agent"  
Agent: [calls create_sub_agent silently]
       [calls create_job silently]
       [waits for results]
       
       "✓ Created reddit-thread-selector agent and configured the scraper job.
       
       Next: Run `run_job` to test it."
```

## Why This Happens

LLMs naturally want to "show their work" because:
1. **Training data** includes step-by-step explanations
2. **Helpful instinct** - explaining seems more transparent
3. **Uncertainty hedging** - narrating gives plausible deniability if tools fail

But in a tool-using agent, this is **anti-pattern**:
- Tools handle the work
- User cares about RESULTS, not process
- Narration adds latency

## Solution: Explicit Banned Phrases

Updated `SystemPrompt.ts` with concrete banned phrases:

```typescript
## BANNED Phrases (Never use these):

❌ "Let me create..."
❌ "Creating now..."
❌ "Step 1: Create X Step 2: Create Y"
❌ "I'll now..."
❌ "Building now..."

**Instead:** Just call the tools silently, then show results.
```

## Pattern: Call → Wait → Report

**The only correct pattern:**

```
1. [Call tool silently]      ← No text output
2. [Wait for result]          ← No text output
3. "✓ Result description"     ← Text AFTER execution
```

## Examples

### Creating Jobs

❌ **Bad:**
```
User: "Create a Python scraper"
Agent: "Great idea! Let me create that job:
        
        Step 1: Define the job
        Step 2: Configure Python runtime
        
        Creating now..."
        [calls create_job]
```

✅ **Good:**
```
User: "Create a Python scraper"
Agent: [calls create_job silently]
       "✓ Created Python scraper job: reddit-scraper-v1
       
       Run with: run_job({ jobId: 'reddit-scraper-v1' })"
```

### Creating Sub-Agents

❌ **Bad:**
```
User: "Create a research agent"
Agent: "Perfect! Let me set that up:
        
        Creating the research specialist profile..."
        [calls create_sub_agent]
```

✅ **Good:**
```
User: "Create a research agent"
Agent: [calls create_sub_agent silently]
       "✓ Created research-specialist with bash, read_file, and search_files access.
       
       Delegate tasks with: delegate_task({ useAgentId: 'research-specialist', task: '...' })"
```

### Multi-Step Operations

❌ **Bad:**
```
User: "Set up the scraper pipeline"
Agent: "I'll create the components:
        
        1. Scraper job (Python)
        2. Selector agent (AI)
        3. Outreach job (Python)
        
        Starting..."
        [calls create_job]
        [calls create_sub_agent]
        [calls create_job]
```

✅ **Good:**
```
User: "Set up the scraper pipeline"
Agent: [calls create_job silently]
       [calls create_sub_agent silently]  
       [calls create_job silently]
       
       "✓ Pipeline created:
       
       1. reddit-scraper → Collects threads to scraper.db
       2. thread-selector → Scores threads 0-5
       3. outreach-bot → Sends replies
       
       Run: run_job({ jobId: 'reddit-scraper' })"
```

## System Prompt Changes

### Before (Weak):
```
- **Call tools silently** without text preamble.
- **Only output text AFTER tools execute**
```

### After (Strong):
```
- **NEVER narrate before calling tools.** Don't say "Let me..." - just call.
- **If you need to call tools, output NOTHING until tools complete.**

## BANNED Phrases (Never use these):

❌ "Let me create..."
❌ "Creating now..."
❌ "Step 1: ... Step 2: ..."
❌ "I'll now..."
❌ "Building now..."
```

## Verification

To check if the pattern is working:

1. **No pre-tool text:** Agent response should start with tool calls, not text
2. **Tool calls first:** Backend logs show tools before any text chunks
3. **Results-focused:** Agent text describes outcomes, not intentions

**Check logs:**
```
[AgentService] Received chunk type: tool-call     ← Should come FIRST
[AgentService] Received chunk type: tool-result
[AgentService] Received chunk type: text-delta    ← Should come AFTER
```

**Bad pattern (narration first):**
```
[AgentService] Received chunk type: text-delta    ← Text before tools!
[AgentService] Received chunk type: tool-call
```

## Why It Matters

**User Experience:**

❌ **With pre-narration:** 
- User waits 3-5 seconds reading "Let me create..."
- Then waits another 10-20 seconds for actual execution
- Total: 13-25 seconds to see results

✅ **Silent execution:**
- Tool calls start immediately (no text delays them)
- User sees results as soon as they're available
- Total: 10-20 seconds to see results
- **Saves 3-5 seconds per operation**

**Professionalism:**

❌ Pre-narration feels like:
- "I'm thinking about doing this..."
- "Let me figure out the steps..."
- Uncertain, slow

✅ Silent execution feels like:
- [Actions happen]
- "✓ Done. Here's what happened."
- Confident, fast

## Related Patterns

### When Narration IS Appropriate

1. **After dangerous operations:**
   ```
   [calls bash({ command: "rm -rf old-data/" })]
   "⚠️ Deleted 1,247 files from old-data/. Backup saved to ~/.trash/"
   ```

2. **Complex multi-step results:**
   ```
   [calls create_job] [calls link_app_data_source]
   "✓ Created scraper job and linked it to the dashboard.
   
   The dashboard will auto-update every 15 minutes with new threads."
   ```

3. **When user asks for explanation:**
   ```
   User: "How did you set up the pipeline?"
   Agent: "I created 3 components:
          1. Scraper (Python) - Runs every 15min...
          2. Selector (Agent) - Scores threads...
          3. Dashboard (Mini-app) - Shows top threads..."
   ```

### When Narration is NOT Appropriate

1. **Before tool calls** - Never
2. **During tool execution** - Never
3. **Announcing intentions** - Never
4. **Listing steps before doing them** - Never

## Files Changed

- `src/core/agents/SystemPrompt.ts` - Added BANNED phrases section
- `docs/SILENT_TOOL_EXECUTION.md` - This document

## Testing

Run the agent and verify:
1. No "Let me..." or "Creating..." phrases
2. Tool calls appear in logs before text
3. Agent text describes results, not plans
