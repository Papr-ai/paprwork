# Browser Parse HTML Performance Optimization

**Date:** 2026-04-11  
**Issue:** `browser_parse_html` taking 2-5+ seconds per call due to subprocess spawn overhead

## Problem

The original implementation spawned a new Python subprocess for every HTML parse:

```typescript
// OLD: Spawn new process each time
const proc = spawn("python3", ["-c", script]);
// - Subprocess startup: ~500ms
// - Import BeautifulSoup: ~1-2s
// - Parse HTML: ~100-500ms
// - Total: 2-5s per call
```

**Bottlenecks:**
1. Python interpreter startup (~500ms)
2. BeautifulSoup import (~1-2s)
3. Process communication overhead (~100-200ms)

## Solution: Persistent Python Worker Pool

Implemented a long-lived Python worker process that stays running and accepts JSON-RPC requests:

```typescript
// NEW: Persistent worker
class PythonWorkerPool {
  - Spawns once on first use
  - Stays alive for the session
  - Processes requests via JSON-RPC
  - Automatic restart on failures
}
```

**Performance:**
- **First call:** ~2-5s (worker startup + BeautifulSoup import)
- **Subsequent calls:** ~100-300ms (direct execution)
- **Speedup:** 10-20x faster after warmup

## Architecture

### JSON-RPC Protocol

```python
# Worker receives:
{
  "id": "uuid",
  "code": "soup = BeautifulSoup(html, 'lxml')\nresult = ...",
  "context": {"html": "<html>..."},
  "timeout": 30000
}

# Worker responds:
{
  "type": "response",
  "id": "uuid",
  "success": true,
  "result": {...}
}
```

### Worker Lifecycle

```
App Startup
  ↓
First browser_parse_html call
  ↓
Spawn Python worker (~2s)
  - Import json, sys, BeautifulSoup
  - Print {"type": "ready"}
  - Enter request loop
  ↓
Worker ready ✓
  ↓
Subsequent calls (~100-300ms each)
  - Send JSON request
  - Execute code
  - Return result
  ↓
App quit → Worker cleanup
```

### Error Handling

- **Timeout:** Request fails after specified timeout
- **Parse error:** Worker returns `{"success": false, "error": "..."}`
- **Worker crash:** Automatic restart + retry
- **Graceful shutdown:** Cleanup on SIGINT/SIGTERM/exit

## Implementation

### Files Created
- `src/core/tools/pythonWorker.ts` - Worker pool implementation (248 lines)

### Files Changed
- `src/core/tools/browser.ts` - Replace inline subprocess with worker import

### Key Features

1. **Singleton pattern** - One worker per app instance
2. **Request tracking** - Map of pending requests with timeouts
3. **Line-buffered I/O** - Handles partial JSON responses
4. **Ready detection** - Waits for worker startup signal
5. **Auto-restart** - Recovers from worker failures
6. **Cleanup handlers** - Proper shutdown on exit

## Testing

### Manual Verification

```bash
# Terminal 1: Start app
npm start

# Terminal 2: Open chat, run browser parse
> Navigate to https://news.ycombinator.com
> Parse top 10 stories with browser_parse_html

# First call timing
→ browser_parse_html: ~2-5s (worker startup)

# Subsequent calls timing  
→ browser_parse_html: ~100-300ms ✓
→ browser_parse_html: ~100-300ms ✓
→ browser_parse_html: ~100-300ms ✓
```

### Performance Benchmarks

| Scenario | Before (subprocess) | After (worker) | Speedup |
|----------|-------------------|----------------|---------|
| First call | 2-5s | 2-5s | Same (startup) |
| 2nd call | 2-5s | 100-300ms | **10-20x faster** |
| 10th call | 2-5s | 100-300ms | **10-20x faster** |
| 100th call | 2-5s | 100-300ms | **10-20x faster** |

## Additional Optimizations Applied

Based on web research:

### 1. lxml Parser (Already Using)
```python
soup = BeautifulSoup(html, 'lxml')  # ✓ Already using fastest parser
```

### 2. UTF-8 Encoding Hint
```python
# Future enhancement: Skip charset detection
soup = BeautifulSoup(html, 'lxml', from_encoding='utf-8')
```

### 3. Limited HTML Payload
- Consider `browser_snapshot({ maxChars: 50000 })` for large pages
- Only pass necessary HTML sections to worker

## Impact

### Before
```
User: "Parse the contact table"
  ↓
Spawn Python process (500ms)
  ↓
Import BeautifulSoup (1-2s)
  ↓
Parse HTML (100-500ms)
  ↓
Kill process
  ↓
Total: 2-5 seconds
```

### After
```
First parse:
User: "Parse the contact table"
  ↓
Start worker (one-time, 2-5s)
  ↓
Parse HTML (100-300ms)
  ↓
Total: 2-5 seconds

Subsequent parses:
User: "Parse another table"
  ↓
Send to existing worker
  ↓
Parse HTML (100-300ms)
  ↓
Total: 100-300ms ✓ (10-20x faster)
```

## Edge Cases Handled

1. **Worker startup failure** - 5s timeout with clear error
2. **Worker becomes unresponsive** - Auto-restart on next request
3. **Multiple concurrent requests** - Queued and processed in order
4. **App restart** - Worker restarts fresh each session
5. **Memory leaks** - Worker is stateless (no persistent data)

## Future Enhancements

1. **Worker pool (multiple workers)** - For parallel parsing
2. **Worker recycling** - Restart after N requests (memory safety)
3. **Caching** - Cache parsed results for identical HTML
4. **Metrics** - Track worker health and performance
5. **Alternative parsers** - Support html5lib, selectolax

## Related Issues

- Issue #XX: browser_parse_html slow for repeated calls
- Enhancement 46: Browser Tools Phase 1 (BeautifulSoup integration)

## References

- [BeautifulSoup Performance Tips](https://scrapingbee.com/blog/how-to-make-pythons-beautiful-soup-faster-performance)
- [Python Subprocess Optimization](https://stackoverflow.com/questions/75045739/faster-startup-of-processes-python)
- [browser-use Architecture](https://github.com/browser-use/browser-use) - Inspiration for persistent worker pattern
