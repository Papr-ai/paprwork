# Sleep/Wake Resumption Architecture (Future Enhancement)

**Status:** Not Implemented (Proposal)
**Complexity:** High
**Estimated Effort:** 2-3 weeks

## Current Limitation

When laptop sleeps during streaming, the response is **aborted** and user must re-send the message. This happens because:

1. **WebSocket connections cannot survive sleep** - OS suspends network stack
2. **New connection has no relationship to old one** - No session persistence
3. **Gateway continues processing in background** - But has no way to deliver results
4. **Streaming chunks are lost** - Once sent over closed socket, they're gone forever

## Proposed Solution: Checkpoint-Based Resumption

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ BEFORE SLEEP                                                 │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  UI Request:                                                  │
│    chatId: "abc-123"                                          │
│    requestId: "req-456"  ← PERSISTENT IDENTIFIER              │
│    message: "Write essay about AI"                            │
│                                                               │
│  Gateway:                                                     │
│    ✓ Stores (requestId → chatId) mapping in memory           │
│    ✓ Streams chunks to UI via WebSocket                      │
│    ✓ ALSO appends chunks to SQLite checkpoint:               │
│      ~/.paprwork-v2/streaming-checkpoints/req-456.db         │
│                                                               │
│  Checkpoint DB Schema:                                        │
│    - requestId (primary key)                                  │
│    - chatId                                                   │
│    - startedAt                                                │
│    - lastChunkAt                                              │
│    - status (streaming|completed|error)                       │
│    - chunks (JSONL blob: one chunk per line)                 │
│                                                               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ DURING SLEEP                                                  │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  WebSocket: CLOSED ✗                                          │
│                                                               │
│  Gateway Backend:                                             │
│    ✓ Detects WebSocket closed                                │
│    ✓ Continues processing (LLM call in flight)               │
│    ✓ Writes chunks to checkpoint DB only                     │
│    ✓ When LLM finishes → marks checkpoint as "completed"     │
│                                                               │
│  UI:                                                          │
│    ✓ Shows "Connection lost" message                         │
│    ✓ Stores requestId in localStorage for recovery           │
│                                                               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ AFTER WAKE (AUTO-RESUME)                                     │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  1. WebSocket reconnects                                     │
│     ↓                                                         │
│  2. UI checks localStorage for interrupted requestIds        │
│     - Finds: ["req-456"]                                     │
│     ↓                                                         │
│  3. UI sends: agent:resume { requestId: "req-456" }          │
│     ↓                                                         │
│  4. Gateway checks checkpoint DB                             │
│     - Status: "completed" ✓                                  │
│     - Has 127 chunks ready                                   │
│     ↓                                                         │
│  5. Gateway replays chunks to UI:                            │
│     - Sends all 127 chunks in rapid succession              │
│     - UI rebuilds streaming state                            │
│     - User sees completed response!                          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Checkpoint Storage (Backend)

**1. Create StreamingCheckpointService**

```typescript
// src/gateway/services/StreamingCheckpointService.ts
import Database from 'better-sqlite3';

export class StreamingCheckpointService {
  private db: Database;
  
  constructor() {
    this.db = new Database('~/.paprwork-v2/streaming-checkpoints.db');
    this.initializeSchema();
  }
  
  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        requestId TEXT PRIMARY KEY,
        chatId TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        lastChunkAt INTEGER,
        status TEXT DEFAULT 'streaming',
        chunks TEXT, -- JSONL format
        errorMessage TEXT,
        finalMessage TEXT -- JSON blob of final message
      );
      
      CREATE INDEX IF NOT EXISTS idx_chatId ON checkpoints(chatId);
      CREATE INDEX IF NOT EXISTS idx_status ON checkpoints(status);
      CREATE INDEX IF NOT EXISTS idx_lastChunkAt ON checkpoints(lastChunkAt);
    `);
  }
  
  createCheckpoint(requestId: string, chatId: string) {
    this.db.prepare(`
      INSERT OR REPLACE INTO checkpoints (requestId, chatId, startedAt, status)
      VALUES (?, ?, ?, 'streaming')
    `).run(requestId, chatId, Date.now());
  }
  
  appendChunk(requestId: string, chunk: any) {
    const existing = this.db.prepare(
      'SELECT chunks FROM checkpoints WHERE requestId = ?'
    ).get(requestId) as { chunks: string | null } | undefined;
    
    const currentChunks = existing?.chunks || '';
    const newChunks = currentChunks + JSON.stringify(chunk) + '\n';
    
    this.db.prepare(`
      UPDATE checkpoints 
      SET chunks = ?, lastChunkAt = ?
      WHERE requestId = ?
    `).run(newChunks, Date.now(), requestId);
  }
  
  markCompleted(requestId: string, finalMessage?: any) {
    this.db.prepare(`
      UPDATE checkpoints 
      SET status = 'completed', finalMessage = ?
      WHERE requestId = ?
    `).run(finalMessage ? JSON.stringify(finalMessage) : null, requestId);
  }
  
  markError(requestId: string, error: string) {
    this.db.prepare(`
      UPDATE checkpoints 
      SET status = 'error', errorMessage = ?
      WHERE requestId = ?
    `).run(error, requestId);
  }
  
  getCheckpoint(requestId: string) {
    const row = this.db.prepare(`
      SELECT * FROM checkpoints WHERE requestId = ?
    `).get(requestId);
    
    if (!row) return null;
    
    return {
      ...row,
      chunks: row.chunks?.split('\n').filter(Boolean).map(JSON.parse) || [],
      finalMessage: row.finalMessage ? JSON.parse(row.finalMessage) : null
    };
  }
  
  // Clean up old checkpoints (>24 hours)
  pruneOldCheckpoints() {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    this.db.prepare(`
      DELETE FROM checkpoints WHERE lastChunkAt < ?
    `).run(oneDayAgo);
  }
}
```

**2. Enhance AgentService Streaming**

```typescript
// src/gateway/services/AgentService.ts
async streamResponse(chatId: string, message: string, config: AgentConfig, ws: WebSocket) {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Create checkpoint
  this.checkpointService.createCheckpoint(requestId, chatId);
  
  try {
    for await (const chunk of this.generateStream(chatId, message, config)) {
      // Append to checkpoint FIRST (durable)
      this.checkpointService.appendChunk(requestId, chunk);
      
      // Try to send over WebSocket (might fail if connection dropped)
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            id: requestId, 
            type: 'agent:chunk', 
            data: chunk 
          }));
        }
      } catch (wsError) {
        console.warn(`[AgentService] WebSocket send failed for ${requestId}, continuing to checkpoint`);
        // Don't throw - keep processing and saving to checkpoint
      }
    }
    
    // Mark completed
    this.checkpointService.markCompleted(requestId, finalMessage);
    
  } catch (error) {
    this.checkpointService.markError(requestId, error.message);
    throw error;
  }
}
```

### Phase 2: Resume Handler (Backend)

**3. Add Resume WebSocket Handler**

```typescript
// src/gateway/websocket/agent.ts
case "agent:resume": {
  const { requestId } = message.payload as { requestId: string };
  
  const checkpoint = checkpointService.getCheckpoint(requestId);
  
  if (!checkpoint) {
    sendError(ws, message.id, "Checkpoint not found");
    return;
  }
  
  // Replay all chunks to client
  for (const chunk of checkpoint.chunks) {
    ws.send(JSON.stringify({
      id: message.id,
      type: 'agent:chunk',
      data: { ...chunk, isResumed: true } // Mark as resumed
    }));
    
    // Small delay to avoid overwhelming client (optional)
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  
  // Send completion
  if (checkpoint.status === 'completed') {
    ws.send(JSON.stringify({
      id: message.id,
      type: 'agent:complete',
      data: { 
        chatId: checkpoint.chatId,
        finalMessage: checkpoint.finalMessage 
      }
    }));
  } else if (checkpoint.status === 'error') {
    sendError(ws, message.id, checkpoint.errorMessage);
  } else {
    // Still streaming - client will receive new chunks normally
    sendResponse(ws, message.id, { status: 'resumed', continuing: true });
  }
  
  break;
}
```

### Phase 3: Auto-Resume (Frontend)

**4. Track Interrupted Requests**

```typescript
// ui/src/lib/gateway.ts
export class GatewayClient {
  private interruptedRequests: Set<string> = new Set();
  
  async stream(type: string, payload: unknown, onChunk: (chunk: unknown) => void, onRegistered?: (requestId: string) => void): Promise<void> {
    const id = Math.random().toString(36).substring(2, 15);
    
    // Track this request for potential resumption
    this.interruptedRequests.add(id);
    localStorage.setItem('paprwork_interrupted_requests', 
      JSON.stringify(Array.from(this.interruptedRequests))
    );
    
    // ... existing streaming code ...
    
    // Remove from interrupted set on successful completion
    this.handlers.set(id, (response) => {
      if (response.type === 'agent:complete' || response.success) {
        this.interruptedRequests.delete(id);
        localStorage.setItem('paprwork_interrupted_requests', 
          JSON.stringify(Array.from(this.interruptedRequests))
        );
      }
      // ... existing handler code ...
    });
  }
  
  private onReconnect() {
    // Check for interrupted requests
    const stored = localStorage.getItem('paprwork_interrupted_requests');
    if (stored) {
      const requestIds = JSON.parse(stored) as string[];
      
      for (const requestId of requestIds) {
        console.log(`[Gateway] Attempting to resume interrupted request: ${requestId}`);
        this.resumeRequest(requestId);
      }
    }
  }
  
  private async resumeRequest(requestId: string) {
    try {
      const response = await this.send('agent:resume', { requestId });
      
      if (response.success) {
        console.log(`[Gateway] Successfully resumed request: ${requestId}`);
        this.interruptedRequests.delete(requestId);
      }
    } catch (error) {
      console.error(`[Gateway] Failed to resume request ${requestId}:`, error);
      // Keep in interrupted set for manual retry
    }
  }
}
```

**5. UI Feedback During Resume**

```typescript
// ui/hooks/useAgent.ts
const handleStreamChunk = useCallback((chunk: StreamChunk) => {
  // Check if this is a resumed chunk
  const isResumed = (chunk as any).isResumed === true;
  
  if (isResumed) {
    // Show visual indicator: "Resuming previous response..."
    // Process chunks faster (no 50ms debounce)
  }
  
  // ... existing chunk handling ...
}, []);
```

## Benefits

### User Experience
- ✅ **Zero data loss** - Full response delivered even after sleep
- ✅ **Seamless recovery** - Automatic, no user action needed
- ✅ **Fast resume** - Pre-computed chunks replayed in <1 second
- ✅ **Visual feedback** - "Resuming..." indicator shows what's happening
- ✅ **Works for long responses** - Agent can work for hours while laptop sleeps

### System Reliability
- ✅ **Durable storage** - SQLite checkpoints survive crashes
- ✅ **Network resilient** - Works for any disconnect (sleep, WiFi drop, etc.)
- ✅ **Graceful degradation** - Old behavior (abort) if checkpoint missing
- ✅ **Automatic cleanup** - Old checkpoints pruned after 24 hours

## Challenges & Considerations

### Storage Overhead
- **Per-request cost:** 10-100KB depending on response length
- **Daily volume:** 10-50 MB for heavy users (100 requests/day)
- **Retention:** 24 hours, auto-pruned
- **Solution:** Acceptable overhead, could add user setting to disable

### Memory Pressure
- **Large responses:** 100KB+ streaming responses could overwhelm resume
- **Solution:** Resume in batches (50 chunks at a time) with progress indicator

### Race Conditions
- **Resume before completion:** User wakes, requests resume, backend still streaming
- **Solution:** Return "continuing: true" status, client waits for new chunks normally

### Multiple Devices
- **Cross-device resume:** Checkpoints are local, can't resume on different device
- **Solution:** Sync checkpoints to Papr Cloud (optional, future enhancement)

## Rollout Plan

### Week 1: Backend Infrastructure
- [ ] Create StreamingCheckpointService
- [ ] Add checkpoint creation/append/completion to AgentService
- [ ] Add agent:resume WebSocket handler
- [ ] Write unit tests for checkpoint storage

### Week 2: Frontend Integration
- [ ] Track interrupted requests in localStorage
- [ ] Implement auto-resume on reconnect
- [ ] Add "Resuming..." UI indicator
- [ ] Handle resumed chunks efficiently

### Week 3: Testing & Polish
- [ ] E2E test: Sleep during streaming → Resume works
- [ ] E2E test: Very long response (30+ min) → Resume works
- [ ] Performance test: 10,000 chunks → Resume fast
- [ ] Add user setting: "Auto-resume interrupted responses"

## Alternative Approaches (Evaluated)

### Option 1: Keep Gateway Connection Alive During Sleep ❌
- **Problem:** Not possible - OS suspends network stack
- **Verdict:** Not feasible

### Option 2: Client-Side Retry ❌
- **Problem:** Re-sending message costs money (re-runs LLM)
- **Verdict:** Wasteful, poor UX

### Option 3: SSE Instead of WebSocket ❌
- **Problem:** SSE also drops during sleep
- **Verdict:** Doesn't solve the problem

### Option 4: Checkpoint-Based Resume ✅ (Chosen)
- **Advantage:** Works for any disconnect reason
- **Advantage:** No wasted LLM calls
- **Advantage:** Durable, survives crashes
- **Verdict:** Best solution

## Success Metrics

**Measure resumption success rate:**
- % of interrupted requests successfully resumed
- Average resume latency (target: <1s for 100 chunks)
- User satisfaction: "Response completed after laptop woke up"

**Before:**
- Interrupted responses: 100% lost (must re-send)
- User frustration: High (wasted time, wasted API credits)

**After (Target):**
- Interrupted responses: 95%+ resumed automatically
- User frustration: Low (seamless experience)

## Related Work

- **Issue 45:** Current fix aborts on disconnect (this enhancement would resume instead)
- **Enhancement 41:** Amplitude telemetry (could track resume success rate)
- **Issue 40:** Stale running jobs (similar checkpoint pattern)

## Conclusion

**Should we implement this?**

**Pros:**
- Significantly better UX for laptop users
- No wasted API credits from re-sending
- Works for any disconnect (sleep, network, crash)

**Cons:**
- 2-3 weeks development effort
- Added complexity (checkpoint storage, resume logic)
- Storage overhead (~50MB/day for heavy users)

**Recommendation:** **Yes, implement after V2.0 launch**

This is a high-value feature for laptop users (majority of users). The implementation is clean and follows established patterns (SQLite checkpoints similar to job history). The benefits (seamless sleep/wake) outweigh the complexity.

Priority: **P1 (High) - Post-Launch Enhancement**
