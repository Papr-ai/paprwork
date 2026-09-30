# Automatic Hybrid Code Search

**Implemented:** 2026-03-31

## Overview

The bash tool now **automatically** combines Papr Memory semantic search with traditional grep when searching code in `$PAPR_HOME/apps/` or `$PAPR_HOME/Jobs/`. This provides the best of both worlds:

- **Semantic search** - Finds related code by meaning (even if search term doesn't appear literally)
- **Exact match** - Finds literal text matches (grep's traditional strength)

## How It Works

### 1. Detection

When the bash tool receives a command, it checks if it's a grep search in PAPR folders:

```bash
# These commands trigger hybrid search:
grep "authentication" $PAPR_HOME/apps/
grep -r "handleLogin" $PAPR_HOME/Jobs/
grep -rn "fetchData" $PAPR_HOME/apps/my-app/
rg "API_KEY" ~/Papr/
```

### 2. Parallel Execution

The system runs **two searches in parallel**:

1. **Papr Memory Search**
   - Query: The grep pattern
   - Scope: Code files (category='learning', source='code_indexer')
   - Limit: Top 10 most relevant files
   - Type: Semantic (finds by meaning)

2. **Bash Grep**
   - Original command executed normally
   - Type: Exact text matching

### 3. Combined Results

Both results are merged with clear section markers:

```
=== Memory Search Results (Semantic) ===
Found 3 relevant code files:

📄 /Users/you/PAPR/apps/dashboard/chart.ts
   Project: app-dashboard
   Language: TypeScript
   Match: Component handles data visualization with Chart.js. Accepts data prop...

📄 /Users/you/PAPR/apps/dashboard/utils.ts
   Project: app-dashboard
   Language: TypeScript
   Match: Helper functions for chart data transformation and formatting...

=== Grep Results (Exact Match) ===
/Users/you/PAPR/apps/dashboard/chart.ts:45:  const chartData = formatData();
/Users/you/PAPR/apps/dashboard/chart.ts:89:  return <Chart data={chartData} />;
/Users/you/PAPR/apps/dashboard/utils.ts:12:  function formatData(raw) {
```

## Why This Matters

### Without Hybrid Search:
```bash
# Agent searches for "authentication"
grep -r "authentication" $PAPR_HOME/apps/

# Results: Only files with literal "authentication" text
# MISSES: Files with login(), handleAuth(), verifyUser(), etc.
```

### With Hybrid Search:
```bash
# Same command
grep -r "authentication" $PAPR_HOME/apps/

# Memory finds (semantic):
# - login-handler.ts (no "authentication" text, but semantically related)
# - auth-utils.ts (related by meaning)
# - session-manager.ts (related functionality)

# Grep finds (exact):
# - config.ts:12: authentication: true
# - docs.md:45: Authentication flow diagram
```

**Result:** Agent sees BOTH semantically related files AND exact matches!

## Schema Used

**Schema:** `paprwork-code` v2.0.0 (ID: `BNSv8YCQXJ`)

### Node Types (10):

**Core (2):**
- `CodeFile` - Individual files (path, LOC, language)
- `Project` - Apps and jobs (ID, type, metadata)

**Search-Driven (5):**
- `Task` - What the code does (semantic threshold: 0.85)
- `Intent` - Why the code exists (semantic threshold: 0.85)
- `Operation` - Operations performed (semantic threshold: 0.85)
- `Behavior` - Expected behaviors (semantic threshold: 0.85)
- `Pattern` - Design patterns (semantic threshold: 0.80)

**Implementation (3):**
- `Language` - Python, TypeScript, JavaScript
- `API` - External APIs used
- `Dependency` - Package dependencies

### Relationships (9):

- `BELONGS_TO` - CodeFile → Project
- `DEPENDS_ON` - Project → Project (job dependencies)
- `WRITTEN_IN` - CodeFile → Language
- `PERFORMS` - CodeFile → Task
- `HAS_INTENT` - CodeFile → Intent
- `EXECUTES` - CodeFile → Operation
- `RETURNS` - CodeFile → Behavior
- `IMPLEMENTS` - CodeFile → Pattern
- `USES` - CodeFile → API/Dependency

## Implementation Details

### Code Changes

**File:** `src/core/tools/bash.ts`

**Functions Added:**
1. `detectPaprGrepCommand(command)` - Regex detection of grep in PAPR folders
2. `searchPaprMemoryForCode(pattern)` - Async memory search
3. Enhanced `executeBashCommand()` - Parallel execution + result merging

**Key Features:**
- Non-blocking: Memory search runs in parallel with grep
- Graceful fallback: If memory search fails, grep results still returned
- Zero learning curve: Works automatically, no new tools to learn
- Optional: Only triggers if PAPR_API_KEY is available

### Pattern Detection

The regex matches:
```bash
grep [options] "pattern" path
grep [options] pattern path
```

Where path contains:
- `PAPR/apps/`
- `PAPR/Jobs/`

**Examples that trigger hybrid search:**
```bash
grep "fetchData" $PAPR_HOME/apps/
grep -r "TODO" $PAPR_HOME/Jobs/my-job/
grep -rn "export" $HOME/PAPR/apps/
rg "API_KEY" "$PAPR_HOME/"  # ripgrep variant (active org/namespace workspace)
```

**Examples that DON'T trigger (not in PAPR folders):**
```bash
grep "TODO" ./src/
grep -r "function" /usr/local/
find ~/Documents -name "*.txt"
```

## Testing

### Manual Test:

1. Create a test file with semantic content:
```bash
cat > $PAPR_HOME/apps/test-app/auth.ts << 'EOF'
// User authentication and session management
export function handleLogin(username: string, password: string) {
  // Verify credentials
  return validateUser(username, password);
}
EOF
```

2. Wait 5-10 seconds for indexing

3. Test hybrid search:
```bash
# In Paprwork chat, ask agent:
"Search for authentication code in my apps"

# Agent will likely use:
bash({ command: "grep -r 'auth' $PAPR_HOME/apps/" })

# Results will show:
# - Memory: auth.ts, login-handler.ts, session-manager.ts (semantic)
# - Grep: Exact matches for "auth" text
```

### Verification:

Check logs for:
```
[Bash Tool] Detected grep in PAPR folder, running parallel memory search for: "auth"
[Bash Tool] Memory search returned 15 lines
```

## Performance

- **Memory search latency:** 300-800ms (runs in parallel)
- **No blocking:** Grep starts immediately
- **Total time:** ~Same as grep alone (parallel execution)

## Edge Cases

### 1. No PAPR_API_KEY
- Memory search skipped silently
- Only grep results returned
- No error shown

### 2. Memory Search Fails
```
[Bash Tool] Memory search failed: <error>
```
- Grep results still returned
- Error logged but not shown to agent
- Graceful degradation

### 3. No Memory Results
```
=== Memory Search Results (Semantic) ===
No relevant code files found in memory.

=== Grep Results (Exact Match) ===
<grep output>
```

### 4. No Grep Results
```
=== Memory Search Results (Semantic) ===
Found 3 relevant code files:
...

=== Grep Results ===
No exact matches found.
```

## Future Enhancements

### Phase 2 (Optional):
1. **Smart deduplication** - If memory result matches grep result, show once
2. **Relevance scoring** - Show memory confidence scores
3. **Path filtering** - Respect grep's path constraints in memory search
4. **Regex patterns** - Convert grep regex to semantic query
5. **User preference** - Toggle hybrid search on/off in settings

### Phase 3 (Advanced):
1. **Caching** - Cache memory results for repeated searches
2. **Learning** - Track which results agent clicks, improve ranking
3. **Context-aware** - Use current chat context to improve semantic search
4. **Graph traversal** - Follow relationships (e.g., find dependencies)

## Benefits

### For Agent:
- ✅ **More context** - Sees related code even if search term doesn't appear
- ✅ **Better understanding** - Semantic matches provide architectural context
- ✅ **No new patterns** - Just use grep as normal

### For User:
- ✅ **Better answers** - Agent finds relevant code it would have missed
- ✅ **Faster workflows** - One grep finds everything
- ✅ **Transparent** - Clear sections show both result types

### For System:
- ✅ **Non-breaking** - Existing grep behavior unchanged
- ✅ **Optional** - Only works if PAPR_API_KEY available
- ✅ **Performant** - Parallel execution, no blocking

## Examples

### Example 1: Finding Authentication Code

**Command:**
```bash
grep -r "login" $PAPR_HOME/apps/
```

**Results:**
```
=== Memory Search Results (Semantic) ===
Found 4 relevant code files:

📄 $PAPR_HOME/apps/dashboard/auth-handler.ts
   Project: app-dashboard
   Language: TypeScript
   Match: Authentication flow manager. Handles user login, session creation...

📄 $PAPR_HOME/apps/dashboard/session.ts
   Project: app-dashboard
   Language: TypeScript
   Match: Session management with localStorage persistence. Validates tokens...

📄 $PAPR_HOME/Jobs/user-sync/sync.py
   Project: user-sync-job
   Language: Python
   Match: Syncs user credentials from external API. Handles OAuth refresh...

=== Grep Results (Exact Match) ===
apps/dashboard/auth-handler.ts:12:export function handleLogin(username, password) {
apps/dashboard/auth-handler.ts:45:  // Redirect to login page
apps/dashboard/types.ts:8:  login: (user: User) => void;
```

**Analysis:**
- Memory found 3 related files that grep **missed** (no "login" text)
- Grep found exact matches in 2 files
- Agent gets complete picture of authentication system

### Example 2: Finding Data Processing

**Command:**
```bash
grep "transform" $PAPR_HOME/Jobs/
```

**Results:**
```
=== Memory Search Results (Semantic) ===
Found 2 relevant code files:

📄 $PAPR_HOME/Jobs/reddit-scraper/processor.py
   Project: reddit-scraper
   Language: Python
   Match: Data processing pipeline. Extracts, cleans, and formats Reddit posts...

📄 $PAPR_HOME/Jobs/reddit-scraper/utils.py
   Project: reddit-scraper
   Language: Python
   Match: Helper functions for data normalization and schema mapping...

=== Grep Results (Exact Match) ===
Jobs/reddit-scraper/processor.py:67:def transform_data(raw):
Jobs/reddit-scraper/processor.py:89:    transformed = transform_to_schema(item)
```

**Analysis:**
- Memory found `utils.py` (semantic match: "normalization" relates to "transform")
- Grep found exact "transform" text
- Agent sees both transformation logic and utilities

## Monitoring

### Logs to Watch:

```bash
# Success
[Bash Tool] Detected grep in PAPR folder, running parallel memory search for: "pattern"
[Bash Tool] Memory search returned 15 lines

# No results
[Bash Tool] Detected grep in PAPR folder, running parallel memory search for: "pattern"
[Bash Tool] Memory search returned 0 results

# Error (graceful)
[Bash Tool] Detected grep in PAPR folder, running parallel memory search for: "pattern"
[Bash Tool] Memory search failed: <error>
```

### Database Stats:

```bash
# Check indexed files
sqlite3 ~/.paprwork-v2/code-index.db "SELECT COUNT(*) FROM indexed_files"

# Check by language
sqlite3 ~/.paprwork-v2/code-index.db "
  SELECT language, COUNT(*) 
  FROM indexed_files 
  GROUP BY language
"

# Recently indexed
sqlite3 ~/.paprwork-v2/code-index.db "
  SELECT file_path, datetime(last_indexed_at)
  FROM indexed_files
  ORDER BY last_indexed_at DESC
  LIMIT 10
"
```

## Troubleshooting

### Memory search not triggering?

**Check:**
1. Is PAPR_API_KEY configured? `echo $PAPR_API_KEY`
2. Is code indexing running? Check logs for `🚀 Starting Smart Code Index Manager`
3. Are files indexed? Check `~/.paprwork-v2/code-index.db`

### No memory results?

**Possible causes:**
1. Files not indexed yet (wait 10-20 seconds after creating files)
2. Search pattern too specific (try broader terms)
3. Indexing queue backed up (check `index_queue` table)

### Memory search slow?

**Normal latency:** 300-800ms
- Runs in parallel with grep, so total time = max(grep, memory)
- If grep finishes in 50ms and memory in 500ms, total = 500ms

## Related Documentation

- `docs/CODE_INDEXING.md` - Code indexing architecture
- `docs/CODE_INDEXING_TRACKING_IMPLEMENTATION.md` - Tracking system
- `src/gateway/services/CodeSchemaRegistration.ts` - Schema definition
- `src/core/tools/bash.ts` - Implementation
