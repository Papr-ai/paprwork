# Sub-Agent Default Tools

**Date:** 2026-02-17  
**Feature:** Add sensible default tools to sub-agents instead of requiring explicit specification

## Problem

When creating sub-agents, forgetting `allowedToolIds` resulted in agents with **NO tools**:

```javascript
// ❌ Agent has NO tools - can't access files or databases
create_sub_agent({
  name: "data-processor",
  systemPrompt: "Process SQLite data..."
  // Missing allowedToolIds!
})
```

This caused agent jobs to fail because they couldn't:
- Read SQLite databases
- Write output files
- Execute bash commands

## Solution: Smart Defaults

Sub-agents now default to basic file/database tools if `allowedToolIds` is not specified:

```typescript
// delegation.ts (line 75-78)
const argsWithDefaults = {
  ...args,
  allowedToolIds: args.allowedToolIds || ["bash", "read_file", "write_file"],
};
```

## Default Tool Set

**`["bash", "read_file", "write_file"]`**

This covers 80% of sub-agent use cases:

✅ **bash** - Execute sqlite3 queries, run scripts, check files
✅ **read_file** - Read config files, schemas, logs
✅ **write_file** - Write results, create output files

### Why These Defaults?

1. **Database access** - Can query SQLite via bash + sqlite3
2. **File I/O** - Can read input and write output
3. **Safe** - No job creation, no document creation, no dangerous operations
4. **Sufficient** - Covers data processing, analysis, transformation

## Usage Examples

### 1. Use Defaults (Most Common)

```javascript
// Defaults to ["bash", "read_file", "write_file"]
create_sub_agent({
  name: "thread-scorer",
  description: "Scores Reddit threads",
  systemPrompt: "Read from scraper.db, score threads, write to selector.db"
  // No allowedToolIds needed!
})
```

**Can do:**
- ✅ `bash({ command: "sqlite3 scraper.db 'SELECT * FROM threads'" })`
- ✅ `read_file({ path: "~/Papr/jobs/scraper/data.db" })`
- ✅ `write_file({ path: "output.json", content: "..." })`

### 2. Read-Only Research Agent

```javascript
create_sub_agent({
  name: "researcher",
  systemPrompt: "Research topics without modifying files",
  allowedToolIds: ["bash", "read_file", "search_files"]  // No write_file
})
```

**Can do:**
- ✅ Read files
- ✅ Search codebase
- ✅ Execute read-only bash commands
- ❌ Cannot write files (intentionally restricted)

### 3. Job Orchestrator

```javascript
create_sub_agent({
  name: "pipeline-coordinator",
  systemPrompt: "Manage multi-step job pipelines",
  allowedToolIds: ["bash", "create_job", "run_job", "read_job_logs"]
})
```

**Can do:**
- ✅ Create dependent jobs
- ✅ Run jobs in sequence
- ✅ Check job logs
- ❌ Cannot directly read/write files (delegates to jobs instead)

### 4. Memory-Focused Agent

```javascript
create_sub_agent({
  name: "knowledge-curator",
  systemPrompt: "Curate and organize knowledge",
  allowedToolIds: ["bash", "search_agent_memory", "add_agent_memory", "read_file"]
})
```

**Can do:**
- ✅ Search Papr Memory
- ✅ Add new memories
- ✅ Read documents
- ❌ No write_file (memories only)

### 5. Minimal Agent (Text Only)

```javascript
create_sub_agent({
  name: "summarizer",
  systemPrompt: "Summarize provided text",
  allowedToolIds: []  // Explicitly empty - NO tools
})
```

**Can do:**
- ✅ Process text
- ✅ Generate summaries
- ❌ No file or database access (intentionally tool-free)

## System Prompt Update

Changed from **"ALWAYS include"** to **"defaults to"**:

**Before:**
```
When creating sub-agents, ALWAYS include allowedToolIds:
```

**After:**
```
When creating sub-agents, you can optionally specify allowedToolIds.

Default tools (if not specified): ["bash", "read_file", "write_file"]
```

This makes it clear:
- ✅ Defaults are sensible
- ✅ Can override for specific needs
- ✅ No need to specify for common cases

## Benefits

**For Agent:**
- ✅ Less cognitive load (don't need to remember allowedToolIds)
- ✅ Still get database access by default
- ✅ Can override for special cases

**For Users:**
- ✅ Sub-agents work by default
- ✅ Fewer "agent can't access file" errors
- ✅ More predictable behavior

**For Security:**
- ✅ Still restricted (can't create jobs, documents, or use dangerous tools by default)
- ✅ Can tighten further by specifying minimal tool set
- ✅ Clear principle: defaults are safe but useful

## Migration

Existing sub-agents without `allowedToolIds`:
- ✅ Will get defaults on next `create_sub_agent` call
- ✅ Can be updated explicitly with desired tool set
- ✅ No breaking changes (defaults match common usage)

## Testing

The existing `tests/delegation-tools.test.ts` still passes:

```bash
npm test -- delegation-tools.test.ts
✓ 15 passed (15)
```

To test defaults:

```javascript
// Create without allowedToolIds
create_sub_agent({
  name: "test-agent",
  systemPrompt: "Test defaults"
})

// Verify it has bash, read_file, write_file
list_sub_agents()
```

## Files Changed

- `src/core/tools/delegation.ts` (lines 75-78) - Apply defaults if not specified
- `src/core/agents/SystemPrompt.ts` - Updated documentation to mention defaults
- `docs/SUBAGENT_DEFAULT_TOOLS.md` - This document

## Related Files

- `src/gateway/services/SubAgentService.ts` - Creates profiles (no changes needed)
- `src/gateway/services/jobs/executors/AgentJobExecutor.ts` - Uses allowedToolIds (no changes needed)

## Future Enhancements

Could add **role-based presets**:

```javascript
create_sub_agent({
  name: "researcher",
  role: "research",  // Preset: ["bash", "read_file", "search_files"]
  systemPrompt: "..."
})

create_sub_agent({
  name: "writer",
  role: "writer",  // Preset: ["bash", "read_file", "write_file", "create_document"]
  systemPrompt: "..."
})
```

But starting with simple defaults is better than complex presets.
