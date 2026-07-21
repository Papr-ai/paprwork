# Cursor Composer via Papr AI Proxy

**Status:** Paprwork Gateway implemented; memory server route required.

## Goal

Users select **Composer 2.5** with Papr login only. Papr's `CURSOR_API_KEY` stays on the memory server — **never** sent to Paprwork clients.

## Security Model

| Secret | Where it lives |
|---|---|
| `CURSOR_API_KEY` | Memory server env / Secret Manager only |
| `PAPR_API_KEY` | User keychain (Papr login) |
| `@cursor/sdk` | **Memory server only** — not in Paprwork |

Paprwork is a thin HTTP client. It calls the AI proxy with `PAPR_API_KEY`, same as OpenAI/Anthropic/Google routes.

## Architecture

```
User selects Composer 2.5
  → Paprwork Gateway (provider=cursor)
  → POST memory.papr.ai/v1/ai/cursor/runs/stream
      Auth: X-API-Key: {PAPR_API_KEY}
      Body: { chatId, prompt, model, agentId?, cwd? }
  → Memory server runs @cursor/sdk with CURSOR_API_KEY (server-side)
  → SSE stream of normalized events back to Gateway
  → Paprwork chat UI
```

**No credential broker. No key transit. No @cursor/sdk in Paprwork.**

## Memory Server Endpoint (Required)

### `POST /v1/ai/cursor/runs/stream`

Lives alongside existing AI proxy routes (`/v1/ai/openai`, `/v1/ai/anthropic`, etc.).

**Auth:** `X-API-Key: {PAPR_API_KEY}`

**Request:**

```json
{
  "chatId": "chat-abc123",
  "prompt": "Refactor the jobs scheduler",
  "model": "composer-2.5",
  "agentId": "agent-optional-for-resume",
  "cwd": "/Users/me/Papr",
  "repos": [{ "url": "https://github.com/org/repo", "startingRef": "main" }]
}
```

**Response:** `text/event-stream` with JSON lines:

```
data: {"type":"agent-meta","agentId":"agent-xyz"}
data: {"type":"text-delta","text":"I'll start by..."}
data: {"type":"tool-call","toolCallId":"tc_1","toolName":"shell","args":{"command":"ls"}}
data: {"type":"tool-result","toolCallId":"tc_1","toolName":"shell","result":"..."}
data: {"type":"done","agentId":"agent-xyz","runId":"run_abc","finishReason":"stop"}
```

**Errors:**

| Status | Meaning |
|---|---|
| 401 | Invalid/missing PAPR_API_KEY |
| 402 | Insufficient Papr credits |
| 503 | `CURSOR_API_KEY` not configured |

### Server implementation sketch

```python
# memory/routers/v1/ai_proxy_routes.py (add alongside openai/anthropic/google)

import os
import json
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

CURSOR_API_KEY = os.environ.get("CURSOR_API_KEY")

class CursorRunRequest(BaseModel):
    chatId: str
    prompt: str
    model: str = "composer-2.5"
    agentId: str | None = None
    cwd: str | None = None
    repos: list[dict] | None = None

@router.post("/cursor/runs/stream")
async def cursor_run_stream(
    body: CursorRunRequest,
    papr_user=Depends(require_papr_api_key),
):
    # 1. Validate credits / plan
    # 2. import Agent from @cursor/sdk (Node sidecar or Python cursor-sdk)
    # 3. Agent.create/resume with CURSOR_API_KEY — never expose to client
    # 4. agent.send(body.prompt) → adapt run.stream() → SSE yield
    # 5. First event: {"type":"agent-meta","agentId": agent.agentId}
    # 6. Final event: {"type":"done","agentId":...,"runId":...}
    async def event_generator():
        yield f"data: {json.dumps({'type':'text-delta','text':'...'})}\n\n"
    return StreamingResponse(event_generator(), media_type="text/event-stream")
```

> **Note:** Memory server is Python (FastAPI) today. Options for `@cursor/sdk`:
> 1. **Node sidecar** microservice the Python proxy calls internally
> 2. **Python `cursor-sdk`** package (same Agent/Run model)
> 3. **Cursor Cloud Agents REST API** (`POST /v1/agents`) if cloud-only is acceptable

The key point: SDK execution and `CURSOR_API_KEY` stay inside Papr infrastructure.

## Paprwork Files

| File | Purpose |
|---|---|
| `src/gateway/utils/cursorDelegationClient.ts` | SSE client → `/v1/ai/cursor/runs/stream` |
| `src/gateway/services/providers/CursorDelegationService.ts` | Maps proxy events → stream chunks |
| `src/gateway/services/providers/cursorAgentStream.ts` | AgentService integration |
| `ui/constants/models.ts` | Composer 2.5 model entry |

## Environment Variables

```bash
# Paprwork — same as existing AI proxy
PAPR_AI_PROXY_BASE_URL=https://memoryserver-development-....run.app/v1/ai

# Memory server only (NEVER in Paprwork)
CURSOR_API_KEY=cursor_...
```

## Trade-offs

| Approach | Security | Local ~/Papr access |
|---|---|---|
| ~~Broker key to client~~ | ❌ Key extractable | ✅ |
| **Server-side SDK (this)** | ✅ Key never leaves server | ⚠️ Server workspace / cloud repos only |

For user's local `~/Papr` files, options:
1. **Cloud agents** with user's connected GitHub repos
2. **Future:** Paprwork uploads relevant file context in the request body
3. **Future:** Paprwork MCP bridge the server-side agent calls back into user's Gateway

## Testing

```bash
# 1. Deploy /v1/ai/cursor/runs/stream on memory server
# 2. Set CURSOR_API_KEY on server
# 3. Sign in with Papr in Paprwork
# 4. Select Composer 2.5, send a message
# 5. Gateway logs should show cursor proxy SSE, no local SDK import
```
