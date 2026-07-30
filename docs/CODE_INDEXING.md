# Code Indexing to PAPR Memory Cloud

## Overview

This feature **automatically** indexes all mini-app and job code from `~/Papr` to PAPR Memory Cloud using a sophisticated 10-node schema with holographic frequency bands for semantic search.

## Automatic Indexing

**Zero Configuration Required!**

Code indexing happens automatically in three ways:

### 1. On Gateway Startup
- Scans `$PAPR_HOME/apps` and `$PAPR_HOME/Jobs` for new/changed files
- Only indexes files that are new or have changed content (SHA-256 hash comparison)
- Queues files for background processing (no blocking)
- Uses local SQLite database (`~/.paprwork-v2/code-index.db`) to track state

### 2. File Watching (Real-time Updates)
- Watches for file changes in `$PAPR_HOME/apps` and `$PAPR_HOME/Jobs`
- 5-second debounce prevents excessive indexing during rapid edits
- Only re-indexes files with meaningful content changes
- Runs in background without interrupting your work

### 3. Batch Processing
- Processes queued files in batches of 50
- Prioritizes new files over changed files
- Continues processing until queue is empty
- Status visible via Settings UI

## Tracking System

The indexing system uses a local SQLite database to track:

**Indexed Files Table:**
- File path (unique)
- Content hash (SHA-256)
- Last indexed timestamp
- Schema version
- Memory ID (PAPR reference)
- Project ID
- Lines of code
- Programming language

**Indexed Projects Table:**
- Project ID (unique)
- Project type (mini_app or job)
- Last indexed timestamp
- Memory ID (PAPR reference)
- File count

**Index Queue Table:**
- File path (unique)
- Queued timestamp
- Priority (1=new file, 0=changed file)

## Manual Indexing (Optional)

If you want to manually trigger indexing:

```bash
# Set your PAPR API key
export PAPR_API_KEY=your-key-here

# Run the indexer
npm run index:code
```

This will:
1. Use cached schema (or register new one)
2. Scan `$PAPR_HOME/apps` and `$PAPR_HOME/Jobs`
3. Extract metadata (auto-detected + LLM-extracted)
4. Upload to PAPR Memory Cloud
5. Update local tracking database

## 10-Node Schema

**Core Nodes (2):**
- **CodeFile** - Individual code files
- **Project** - Unified container for mini-apps and jobs

**Search-Driven Nodes (5):** (Primary search drivers - what agents look for)
- **Task** - What the code accomplishes (50Hz - most discriminating)
- **Intent** - Why the code exists (2Hz)
- **Operation** - Main operation performed (4Hz)
- **Behavior** - What the code returns (19Hz)
- **Pattern** - Algorithm/pattern used (24Hz)

**Implementation Nodes (3):**
- **Language** - Programming language (Python, TypeScript, JavaScript)
- **API** - APIs/modules used (fetch, os.path, pandas.read_csv)
- **Dependency** - External packages (requests, pandas, node-fetch)

## Test Search

```bash
npm run test:code-search
```

This runs 7 test queries to validate search quality:
- Find code that fetches GitHub data
- Find TypeScript mini-apps
- Find Python jobs
- Find async/await patterns
- Find code with SQLite databases
- Find job dependencies
- Find API calling code

### 3. Search from Agent

Use the existing `search_agent_memory` tool with the `category` filter:

```typescript
await searchAgentMemory({
  query: "Find code that fetches API data with rate limiting",
  category: "code",  // Filter to code only
  maxMemories: 10
});
```

## What Gets Indexed

### Auto-Detected Metadata

**From File System:**
- File path, name, language, LOC, last modified
- Language detected from file extension

**From job.json:**
- Job ID, name, type (python/node/subagent), status
- Command, max attempts, retention days, output mode
- Memory policy, max turns, last run, exit code
- Timestamps (created, updated, last run)
- **Job dependencies** (dependsOn array)

**From data-sources.json:**
- Database connections (SQLite paths, aliases, tables)
- Linked at timestamp

### LLM-Extracted Metadata

The schema uses **14 holographic frequency bands** (inspired by neuroscience):
- **0.1Hz** - Programming domain (Web, Data, ML, Systems)
- **0.5Hz** - Language (auto-detected, confirmed by LLM)
- **2Hz** - Code intent (why it exists)
- **4Hz** - Primary operation (main action)
- **6Hz** - Key APIs (primary APIs used)
- **10Hz** - Data types used
- **12Hz** - Operation verbs (action words)
- **18Hz** - Secondary APIs
- **19Hz** - Return behavior (what it returns)
- **24Hz** - Algorithm pattern (async/await, recursion, etc.)
- **30Hz** - Input/output signature
- **40Hz** - Dependencies (external packages)
- **50Hz** - Specific task (most discriminating - what it does in 5-10 words)
- **70Hz** - Edge cases (error handling)

These fields are extracted asynchronously by PAPR's LLM and used to create graph nodes for rich traversal.

## Example Queries

**By Task:**
```
"Find code that fetches GitHub stargazers"
→ CodeFile -PERFORMS→ Task(fetch stargazers)
```

**By Language + Pattern:**
```
"Show TypeScript code using async/await"
→ CodeFile -WRITTEN_IN→ Language(TypeScript) -IMPLEMENTS→ Pattern(async/await)
```

**By Job Dependencies:**
```
"What jobs depend on the stargazers fetch job?"
→ Project -DEPENDS_ON→ Project(stargazers)
```

**By Data Sources:**
```
"Show projects that query the stargazers database"
→ Project (data_sources contains stargazers.db)
```

**By API Usage:**
```
"Find code using the requests library"
→ CodeFile -DEPENDS_ON→ Dependency(requests)
```

## Architecture

### Files Created

- `src/gateway/services/CodeSchemaRegistration.ts` - Schema definition
- `src/gateway/services/storage/CodeIndexerService.ts` - Indexing logic
- `src/gateway/services/storage/CodeFileWatcher.ts` - File watcher (future)
- `src/gateway/scripts/indexCodeToPapr.ts` - Batch upload script
- `src/gateway/scripts/testCodeSearch.ts` - Test queries
- `src/core/tools/paprMemory.ts` - Added `category` filter

### Match Strategies

**Exact Match:**
- File paths, project IDs (unique identifiers)
- Language names (Python, TypeScript)
- API names (fetch, os.path.join)
- Dependency names (requests, pandas)

**Semantic Match (threshold: 0.80-0.85):**
- Task descriptions ("fetch stars" ≈ "get stargazers")
- Intent descriptions (similar purposes)
- Operation descriptions (similar actions)
- Behavior descriptions (similar outputs)
- Pattern descriptions (similar algorithms)

**Upsert vs. Lookup:**
- **Upsert** (create or update): CodeFile, Project, Task, Intent, Operation, Behavior, Pattern, API
- **Lookup** (controlled vocabulary): Language, Dependency

## Benefits

✅ **Rich semantic search** - "Find code that fetches API data" works naturally

✅ **Graph traversal** - "Show all jobs that depend on X" uses relationships

✅ **Multi-attribute filtering** - "Python jobs with SQLite" combines nodes

✅ **Precise updates** - File changes upsert existing nodes, preserve relationships

✅ **Data lineage** - Track which code accesses which databases

✅ **Job orchestration** - Understand job dependency chains

✅ **Pattern discovery** - Find implementations of specific algorithms

## Limitations

- **Manual re-indexing** - File watcher logs changes but doesn't auto-reindex yet
- **50KB file limit** - Very long files are truncated for indexing
- **LLM extraction** - Graph nodes are created asynchronously (may take time)
- **No function-level granularity** - Indexes files, not individual functions (future enhancement)

## Future Enhancements

- [ ] Auto-reindex on file changes (file watcher integration)
- [ ] Function/class level indexing for finer-grained search
- [ ] Import relationship extraction (IMPORTS edges between files)
- [ ] Code snippet extraction for relevant segments only
- [ ] Performance metrics (execution time, memory usage)
- [ ] Version history tracking (git integration)

## Troubleshooting

**"Schema already exists" error:**
```bash
# Schemas are idempotent - it's safe to re-run
# The existing schema will be reused
```

**"No results found" in search:**
```bash
# Wait for LLM extraction to complete (can take 5-10 min for large codebases)
# Graph nodes are created asynchronously
```

**"Project not found" error:**
```bash
# Ensure $PAPR_HOME/apps or $PAPR_HOME/Jobs exists
# Check that projects have valid job.json files
```

## Related Documentation

- [PAPR Memory Cloud Docs](https://platform.papr.ai/overview)
- [10-Node Schema Plan](/Users/amirkabbara/.cursor/plans/index_code_to_papr_cloud_10node.plan.md)
- [Memory Project CosQA Schema](../memory/services/holographic_embedding/frequency_schema.py)
