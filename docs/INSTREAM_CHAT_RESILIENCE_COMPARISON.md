# In-Stream Chat Resilience: Paprwork vs Cursor, OpenAI, Claude Code, OpenClaw

**Date:** 2026-02-22  
**Purpose:** Compare how different AI coding/chat platforms handle resilience for in-stream agent chats, tool calls, and streaming.

---

## Executive Summary

| Platform | Uses Temporal? | API Retries | Resumable Streams | Partial Save | Timeout |
|----------|----------------|-------------|-------------------|--------------|---------|
| **Paprwork V2** | No | OAuth→API key fallback; context retry | No | Yes | No (step-limited) |
| **Cursor** | No | User retry; adaptive networking | No | Unknown | Yes (chunking workaround) |
| **OpenAI API** | No | Client config (max_retries, backoff) | No | No | Configurable |
| **Claude Code** | No | Recommended patterns | No | No | Configurable (bash, API) |
| **OpenClaw** | No | Session queuing | No | Preview streaming | Unknown |
| **Temporal (build-on)** | Yes (their platform) | Via Temporal Activities | N/A (workflow-based) | Via workflow state | Activity timeout |

**Key finding:** None of these products use Temporal for their in-stream chat. Temporal is a platform for *building* durable agent workflows—you'd use it if you were architecting from scratch. Cursor, OpenAI, Claude Code, and OpenClaw all use simpler patterns: client retries, user retry, or (for jobs) custom retry logic.

---

## 1. Paprwork V2

### In-Stream Chat

| Aspect | Implementation |
|--------|----------------|
| **Transport** | WebSocket (persistent connection) |
| **Timeout** | None—step-limited (100 tool calls) instead of time-based |
| **API retries** | OAuth rate limit → automatic fallback to API key (agent jobs, structured jobs) |
| **Context overflow** | Auto-retry: save partial, compress history, retry with compressed context |
| **Partial save** | Yes—on error, saves partial assistant message with error indicator |
| **Error delivery** | `agent:error` broadcast to client; error message in stored message |
| **User abort** | AbortController—user can cancel anytime via UI |
| **Temporal** | No |

### Tool Calls

- Tool calls stream as part of agent response
- Tool errors yield `tool-error` chunk; stream continues or fails based on severity
- Tool results truncated to 2KB when loading into context (prevents context overflow)

### Jobs (Background)

- Full resilience: idempotency, retries, execution tracking, next retry timestamp
- See [JOB_RELIABILITY_ENHANCEMENTS.md](JOB_RELIABILITY_ENHANCEMENTS.md)
- No Temporal—SQLite + in-process retry loop

---

## 2. Cursor

### In-Stream Chat

| Aspect | Implementation |
|--------|----------------|
| **Transport** | HTTP/2 + SSE (Server-Sent Events) |
| **Timeout** | Yes—timeouts occur; workaround: break into smaller steps |
| **API retries** | User-initiated retry; adaptive networking (fallback paths) |
| **Resumable streams** | No |
| **Partial save** | Unknown—likely lost on disconnect |
| **Rate limits** | 20–250 requests/min depending on endpoint |

### Resilience Strategy

- **Adaptive networking:** Detects network conditions; uses faster path when good, reliability-focused path when poor
- **Chunking:** When timeouts occur, recommend breaking requests into smaller steps (less context, shorter diffs)
- **User retry:** Mid-generation stops often succeed on retry (transient network hiccups)

### Tool Calls

- Not documented publicly; tool calls are part of agent flow
- No public mention of retry for tool execution

---

## 3. OpenAI (API / ChatGPT)

### API Client

| Aspect | Implementation |
|--------|----------------|
| **Retry config** | `max_retries` (e.g. 1–6), `timeout` (e.g. 65s) when initializing client |
| **429 handling** | Exponential backoff recommended; respect `Retry-After` header |
| **Streaming errors** | Errors can occur after 200; handle in event stream |
| **Temporal** | No—OpenAI does not use Temporal |

### Best Practices (from OpenAI docs)

- Rate limit (429): exponential backoff, check `Retry-After` / `x-ratelimit-reset-tokens`
- Lower timeout + higher max_retries can cause more timeouts (careful with config)
- `APIConnectionError` after max retries exhausted
- Wrap streaming in try/except for `APIConnectionError`, `RateLimitError`

### ChatGPT Product

- Internal architecture not public
- No evidence of Temporal or resumable streams in consumer product

---

## 4. Claude Code (Anthropic)

### In-Stream Chat

| Aspect | Implementation |
|--------|----------------|
| **Timeout** | Configurable: `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`; API ~60s+ |
| **Retry** | Recommended: exponential backoff for 408, 429; 5 retries with backoff |
| **Streaming** | SSE; keeps connection alive, reduces timeouts for long responses |
| **Stream errors** | Errors can occur mid-stream; handle within event stream |
| **Temporal** | No |

### Tool Calls (Bash)

- Default 2-minute timeout for bash commands
- Configurable in `~/.claude/settings.json`

---

## 5. OpenClaw

### In-Stream Chat

| Aspect | Implementation |
|--------|----------------|
| **Streaming** | Two layers: preview streaming (Telegram/Discord/Slack) + block streaming (channels) |
| **Block streaming** | Coarse chunks (not token deltas); `EmbeddedBlockChunker` with min/max bounds |
| **Resumable** | No—no server-side buffering or resume tokens |
| **Agent loop** | Session queuing—runs serialized per session; write locks before streaming |
| **Temporal** | No |

### Resilience

- **Session queuing:** Prevents tool/session races; consistent session history
- **Chunking:** Code fences never split; break preference (paragraph → newline → sentence)
- **Preview modes:** `progress`, `block`, `partial`, `off` per channel
- No automatic API retries documented

---

## 6. Temporal (Build-On Platform)

Temporal is not a chat product—it's a workflow orchestration platform. You *build* durable agents on it.

### How It Would Work

| Aspect | Implementation |
|--------|----------------|
| **Architecture** | LLM calls + tool invocations run as **Activities** |
| **Retries** | Temporal handles retries—disable client retries (`max_retries=0`) to avoid interference |
| **State** | Workflow state persisted; survives crashes, restarts |
| **Streaming** | Generation typically runs in Activity; client consumes result—different model than live token streaming |
| **Use case** | Long-running, durable workflows; multi-step agents that must survive restarts |

### Key Design (from Temporal AI Cookbook)

- Retries handled by Temporal, not OpenAI/Claude client
- Generic Activity for LLM invocation; tool execution as dynamic Activities
- Conversation history accumulated in workflow
- Best for: backend automation, scheduled agents, workflows needing durability—not necessarily for real-time in-stream chat UX

---

## Comparison Matrix: In-Stream Resilience

| Feature | Paprwork | Cursor | OpenAI API | Claude Code | OpenClaw |
|---------|----------|--------|------------|-------------|----------|
| **API retry (429, 5xx)** | OAuth fallback | User retry | Client config | Recommended | No |
| **Context overflow retry** | Yes (compress + retry) | Chunking | No | No | No |
| **Partial save on error** | Yes | Unknown | No | No | Preview only |
| **Resumable streams** | No | No | No | No | No |
| **Timeout** | None (step limit) | Yes | Configurable | Configurable | Unknown |
| **User abort** | Yes | Unknown | N/A | N/A | N/A |
| **Session queuing** | Per chatId | Unknown | N/A | N/A | Yes |
| **Temporal** | No | No | No | No | No |

---

## Recommendations for Paprwork

Based on this comparison:

1. **Keep current approach** for in-stream: OAuth fallback, context retry, partial save. It's ahead of Cursor and OpenClaw for in-stream resilience.
2. **Consider adding** (lower priority):
   - Broader API retry with exponential backoff for 429/5xx (beyond OAuth)
   - Circuit breaker if provider is consistently failing
3. **Resumable streams** (Redis + decoupled generator): High effort; only if users report frequent disconnect pain.
4. **Temporal**: Not needed for in-stream chat. Already decided against for jobs (see [JOB_RELIABILITY_ENHANCEMENTS.md](JOB_RELIABILITY_ENHANCEMENTS.md)).

---

## References

- [JOB_RELIABILITY_ENHANCEMENTS.md](JOB_RELIABILITY_ENHANCEMENTS.md) — Paprwork job resilience, Temporal comparison
- [AGENT_TIMEOUT_BEHAVIOR.md](AGENT_TIMEOUT_BEHAVIOR.md) — Paprwork timeout/step-limit design
- [OpenClaw Streaming](https://docs.openclaw.ai/concepts/streaming)
- [Temporal AI Cookbook](https://docs.temporal.io/ai-cookbook)
- [OpenAI Retry Best Practices](https://community.openai.com/t/best-practices-for-retrying-requests/8290)
- [Ably: Reliable Token Streaming](https://ably.com/blog/token-streaming-for-ai-ux)
- [Upstash: Resumable LLM Streams](https://upstash.com/blog/resumable-llm-streams)
