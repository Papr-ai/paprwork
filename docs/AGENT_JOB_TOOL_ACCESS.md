# Agent Job Tool Access Issue

**Date:** 2026-02-17  
**Issue:** Agent jobs can't access databases or files without explicit tool permissions

## Problem

When creating a sub-agent that needs to read from a SQLite database:

```javascript
// What the main agent did (MISSING allowedToolIds):
create_sub_agent({
  name: "reddit-thread-selector",
  description: "Scores Reddit threads",
  systemPrompt: "Read from scraper.db and score threads..."
  // ❌ NO allowedToolIds specified!
})
```

When the agent job ran:
```
❌ Error: Agent can't access scraper.db
❌ Agent has no bash or read_file tools
❌ Agent returns plain text instead of working
```

## Root Cause

Agent jobs run in **isolated sessions** with **restricted tool access**:

```typescript
// AgentJobExecutor.ts (line 43)
allowedToolIds = profile.allowedToolIds;  // From sub-agent profile

// AgentService.ts (line 694)
for await (const chunk of this.streamAgent(chatId, prompt, config, {
  allowedToolIds: input.allowedToolIds,  // ← Only these tools available
  maxSteps: input.maxTurns,
})) {
```

If `allowedToolIds` is undefined or empty, the agent job has **NO tools** - it can only generate text!

## Solution

### 1. Updated System Prompt with CRITICAL Warning

Added explicit guidance in `SystemPrompt.ts`:

```typescript
## CRITICAL: Agent Jobs Need Tool Access

When creating sub-agents that will run as jobs, **ALWAYS specify allowedToolIds**:

\`\`\`javascript
create_sub_agent({
  name: "thread-selector",
  systemPrompt: "Score Reddit threads...",
  allowedToolIds: ["bash", "read_file", "write_file"]  // ← REQUIRED
})
\`\`\`

**Common tool combinations:**

- **Database access:** ["bash", "read_file"] - Read SQLite
- **File processing:** ["bash", "read_file", "write_file"] - Full I/O
- **Research:** ["bash", "read_file", "search_files"] - Code exploration

**Without these tools, agent jobs CANNOT access databases or files!**
```

### 2. Document Standard Tool Sets

For different agent types:

**Data Processing Agents:**
```javascript
allowedToolIds: ["bash", "read_file", "write_file"]
```
- `bash` - Execute sqlite3 queries, Python scripts
- `read_file` - Read database schema, config files
- `write_file` - Write results, create output files

**Research Agents:**
```javascript
allowedToolIds: ["bash", "read_file", "search_files", "search_agent_memory"]
```
- `bash` - Execute searches, API calls
- `read_file` - Read documentation
- `search_files` - Find relevant code
- `search_agent_memory` - Query past findings

**Orchestration Agents:**
```javascript
allowedToolIds: ["bash", "create_job", "run_job", "read_job_logs"]
```
- Can create and manage other jobs
- Can't access files directly (delegates that)

## How It Should Work

### Creating a Database-Reading Sub-Agent

```javascript
// ✅ CORRECT - Includes necessary tools
create_sub_agent({
  name: "reddit-thread-selector",
  description: "Scores Reddit threads for outreach relevance",
  systemPrompt: `Read threads from ~/Papr/jobs/reddit-scraper-rag-llm/data/scraper.db
                 Score each thread 0-5 based on relevance
                 Write results to ~/Papr/jobs/reddit-thread-selector/data/selector.db`,
  allowedToolIds: ["bash", "read_file", "write_file"],  // ← Can access files/DBs
  model: "gpt-5-mini",
  maxTurns: 15
})
```

Then when you delegate:
```javascript
delegate_task({
  task: "Score all threads in the scraper database",
  useAgentId: "reddit-thread-selector",
  context: "Database path: ~/Papr/jobs/reddit-scraper-rag-llm/data/scraper.db"
})
```

The agent can now:
```bash
# Read from database
bash({ command: "sqlite3 ~/Papr/jobs/reddit-scraper-rag-llm/data/scraper.db 'SELECT * FROM threads LIMIT 10'" })

# Or use read_file for schema
read_file({ path: "~/Papr/jobs/reddit-scraper-rag-llm/data/scraper.db" })
```

## Why This Design?

**Security & Isolation:**
- Main agent has full access (all tools)
- Sub-agents have restricted access (only specified tools)
- Prevents sub-agents from doing dangerous operations
- Clear separation of concerns

**Examples:**

| Sub-Agent Type | Allowed Tools | Why |
|----------------|---------------|-----|
| Research | `bash`, `read_file`, `search_files` | Only needs to read, not write |
| Data Processor | `bash`, `read_file`, `write_file` | Needs full DB access |
| Code Writer | `bash`, `read_file`, `write_file` | Needs to create files |
| Reporter | None or minimal | Just summarizes, no execution |

## Fix for Current Issue

The agent needs to recreate the sub-agent WITH tool access:

```javascript
// Option 1: Update existing profile
create_sub_agent({
  id: "reddit-thread-selector",  // Same ID = updates existing
  name: "Reddit Thread Selector",
  systemPrompt: "...",
  allowedToolIds: ["bash", "read_file", "write_file"],  // ← ADD THIS
  model: "gpt-5-mini"
})

// Option 2: Use Python instead (simpler for pure data processing)
create_job({
  name: "reddit-thread-selector",
  type: "python",  // Direct SQLite access, no tool restrictions
  command: "python code/selector.py"
})
```

## System Prompt Updates Needed

Add to the sub-agent creation section:

```markdown
## Required Parameters

When creating sub-agents, ALWAYS include:
- `name` - Human-readable name
- `description` - What the agent does
- `systemPrompt` - Agent's instructions
- **`allowedToolIds`** - Tools the agent can use (CRITICAL!)
- `model` - Which LLM to use (optional, defaults to gpt-5-mini)
- `maxTurns` - Max conversation rounds (optional, defaults to 12)

Example:
\`\`\`javascript
create_sub_agent({
  name: "data-analyzer",
  description: "Analyzes SQLite data and produces insights",
  systemPrompt: "You analyze data from SQLite databases...",
  allowedToolIds: ["bash", "read_file"],  // ← Database access
  model: "gpt-5-mini",
  maxTurns: 15
})
\`\`\`
```

## Testing

To verify tool access works:

1. Create sub-agent with tools:
   ```javascript
   create_sub_agent({
     name: "test-agent",
     systemPrompt: "Test filesystem access",
     allowedToolIds: ["bash", "read_file"]
   })
   ```

2. Delegate a file-reading task:
   ```javascript
   delegate_task({
     task: "List files in ~/Papr/jobs",
     useAgentId: "test-agent"
   })
   ```

3. Check logs - should show successful bash execution

## Files Changed

- `src/core/agents/SystemPrompt.ts` - Added CRITICAL warning about allowedToolIds
- `docs/AGENT_JOB_TOOL_ACCESS.md` - This document

## Related Files

- `src/gateway/services/AgentService.ts` (line 694) - Passes allowedToolIds to isolated session
- `src/gateway/services/jobs/executors/AgentJobExecutor.ts` (line 43) - Gets allowedToolIds from profile
- `src/core/tools/delegation.ts` - Sub-agent creation tool

## Lessons Learned

1. **Tool access is NOT inherited** - Sub-agents don't automatically get main agent's tools
2. **Always document required params** - `allowedToolIds` is critical but easy to forget
3. **Default sub-agents show the pattern** - They all include allowedToolIds
4. **Script jobs bypass this** - Python/Node jobs have direct OS access without tool restrictions
5. **Consider Python for pure data work** - Simpler than agent jobs with tool restrictions
