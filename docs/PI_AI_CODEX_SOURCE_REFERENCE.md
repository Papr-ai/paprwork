# pi-ai Codex Source Reference

Reference: [badlogic/pi-mono](https://github.com/badlogic/pi-mono) - packages/ai/src/providers/

## Key Files

- `openai-codex-responses.ts` - Codex-specific: URL, auth, SSE parse, event mapping
- `openai-responses-shared.ts` - Shared: stream processing, text/tool/reasoning handling

## 1. Tool Format (pi-ai)

From openai-responses-shared.ts convertResponsesTools():

```typescript
return tools.map((tool) => ({
  type: "function",
  name: tool.name,           // TOP LEVEL - not nested under "function"
  description: tool.description,
  parameters: tool.parameters,
  strict,
}));
```

Tools use flat structure: { type, name, description, parameters }

## 2. Stream Event Flow for Text (pi-ai)

From openai-responses-shared.ts processResponsesStream():

1. response.output_item.added (item.type === "message") - creates text block
2. response.content_part.added (part.type === "output_text") - adds part to content
3. response.output_text.delta - streams chunks via **event.delta** (string directly, not event.delta.text)
4. response.output_item.done - finalizes message
5. response.completed - done, usage

Note: pi-ai does NOT use response.content_part.delta for text. Text comes from response.output_text.delta only.

## 3. Event Types pi-ai Handles (from processResponsesStream)

| Event Type | Structure | Notes |
|------------|------------|-------|
| response.output_item.added | event.item (reasoning/message/function_call) | Creates block |
| response.content_part.added | event.part (output_text/refusal) | Adds part to message |
| response.output_text.delta | **event.delta** = string | Primary text stream |
| response.reasoning_summary_text.delta | event.delta = string | Reasoning/thinking (NOT response.reasoning.delta) |
| response.reasoning_summary_part.added | event.part | |
| response.reasoning_summary_part.done | | |
| response.refusal.delta | event.delta = string | Refusal text |
| response.function_call_arguments.delta | event.delta = string | Tool args streaming |
| response.function_call_arguments.done | event.arguments = string | Full tool args |
| response.output_item.done | event.item | Finalizes item |
| response.completed | event.response (usage, status) | Stream complete |
| error | event.message, event.code | |
| response.failed | | |

**Event type source**: Events have `event.type` in the JSON. If ChatGPT backend puts type in SSE `event:` header instead, we merge it in parseSSE.

## 4. Our CodexStreamAdapter Mapping

- response.output_text.delta → text-delta (event.delta = string)
- response.content_part.delta → text-delta (event.delta.text, if backend sends it)
- response.reasoning.delta → text-delta (event.delta.text)
- response.reasoning_summary_text.delta → text-delta (event.delta = string) - pi-ai's reasoning format
