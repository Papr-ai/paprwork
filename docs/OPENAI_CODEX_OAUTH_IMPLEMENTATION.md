# OpenAI Codex OAuth Implementation - Complete

## Date
2026-02-19

## Summary
Successfully implemented custom OpenAI Codex provider to enable ChatGPT Plus/Pro subscription access via OAuth, bypassing the AI SDK which only supports the Platform API.

## Problem
OpenAI has two separate access mechanisms:
1. **Platform API** (`api.openai.com/v1`) - Requires Platform API keys, used by AI SDK
2. **ChatGPT Backend API** (`chatgpt.com/backend-api`) - Uses ChatGPT OAuth tokens, different endpoint

The AI SDK's `openai.responses()` provider **only works with Platform API**, which explains why ChatGPT OAuth tokens fail with "Missing scopes: api.responses.write" error.

## Solution Architecture

### 1. Custom Provider (`OpenAICodexProvider.ts`)
- Makes direct HTTP calls to `https://chatgpt.com/backend-api/codex/responses`
- Handles OAuth token authentication with `chatgpt-account-id` header
- Implements retry logic for rate limits and transient errors
- Parses Server-Sent Events (SSE) stream

**Key Features:**
- Extracts `accountId` from JWT token payload
- Sends proper headers: `Authorization`, `chatgpt-account-id`, `OpenAI-Beta`
- Handles error responses with user-friendly messages
- Supports tool calling, reasoning effort, and session caching

### 2. Stream Adapter (`CodexStreamAdapter.ts`)
- Converts Codex stream events to AI SDK-compatible format
- Enables seamless integration with existing `orchestrateModelStream()`
- Maps Codex event types to AI SDK event types:
  - `response.content_part.delta` → `text-delta`
  - `response.function_call_arguments.delta` → `tool-call`
  - `response.output_item.done` → `tool-result`
  - `response.completed` → `finish`

### 3. AgentService Integration
- Conditional streaming logic based on provider
- **For `openai-codex`:** Use custom provider + adapter
- **For other providers:** Use AI SDK's `streamText()`
- Both paths feed into the same `orchestrateModelStream()` → **zero duplication!**

## Files Created/Modified

### Created
1. `src/gateway/services/providers/OpenAICodexProvider.ts` - Custom Codex HTTP client
2. `src/gateway/services/providers/CodexStreamAdapter.ts` - Stream format converter

### Modified
1. `src/gateway/services/AgentService.ts` - Added conditional provider logic in `streamAgent()`
2. `src/core/types/agents.ts` - Already had `openai-codex` provider type
3. `ui/constants/models.ts` - Already had `gpt-5.3-codex` model config

## Code Flow

```
User selects gpt-5.3-codex (openai-codex provider)
    ↓
AgentService.streamAgent() checks provider
    ↓
If openai-codex:
    1. Get OAuth token from process.env.OPENAI_API_KEY
    2. Convert messages/tools to Codex format
    3. Call streamOpenAICodex() → HTTP POST to chatgpt.com
    4. Parse SSE stream
    5. adaptCodexStreamToAISDK() → Convert to AI SDK format
    ↓
Else (openai/anthropic/google):
    1. Use AI SDK's streamText()
    ↓
Both paths → orchestrateModelStream() → UI
```

## Benefits

1. ✅ **Unified Interface** - Both custom and AI SDK providers use same stream format
2. ✅ **Zero Duplication** - Same `orchestrateModelStream()` logic for all providers
3. ✅ **User Transparency** - Users can switch between Gemini ↔ Claude ↔ OpenAI Codex seamlessly
4. ✅ **Maintainable** - Clear separation of concerns (provider logic vs. stream orchestration)
5. ✅ **Extensible** - Easy to add more custom providers (e.g., Anthropic Vertex AI)

## Testing

### Build Status
✅ TypeScript compilation: **PASSED**
✅ Build: **PASSED** (6.4s)

### Next Steps
1. Start app and test with ChatGPT OAuth token
2. Verify streaming works correctly
3. Test tool calling
4. Test reasoning/thinking output

## Technical Notes

### Codex API Differences
| Feature | Platform API | Codex API |
|---------|--------------|-----------|
| Endpoint | `/v1/responses` | `/codex/responses` |
| Auth Header | `Authorization: Bearer <key>` | Same + `chatgpt-account-id: <id>` |
| Beta Header | `OpenAI-Beta: responses=experimental` | Same |
| Originator | Not required | `originator: paprwork` |
| Tool Format | Standard | Standard |

### Event Mapping
| Codex Event | AI SDK Event | Description |
|-------------|--------------|-------------|
| `response.content_part.delta` | `text-delta` | Text streaming |
| `response.reasoning.delta` | `text-delta` | Thinking/reasoning |
| `response.function_call_arguments.delta` | `tool-call` | Tool call args |
| `response.output_item.done` | `tool-result` | Tool execution result |
| `response.completed` | `finish` | Stream complete |
| `error` / `response.failed` | `error` | Error occurred |

## References
- OpenClaw's implementation: `@mariozechner/pi-ai` (open source)
- Source file: `packages/ai/src/providers/openai-codex-responses.ts`
- Codex endpoint: `https://chatgpt.com/backend-api/codex/responses`

## Status
✅ **IMPLEMENTATION COMPLETE** - Ready for testing
