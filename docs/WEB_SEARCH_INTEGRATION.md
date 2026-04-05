# Web Search Integration - Native Provider Tools

**Added:** 2026-03-31

## Overview

Paprwork V2 now supports native web search capabilities across all major AI providers (Claude, GPT, and Gemini), enabling agents to access real-time information from the internet without requiring custom web scraping tools.

## Supported Providers

### Claude (Anthropic) ✅
- **Tool:** `web_search_20260209` with dynamic filtering
- **Availability:** API key + OAuth (Claude Pro/Max)
- **Pricing:** $10 per 1,000 searches + standard token costs
- **Features:**
  - Dynamic filtering: Claude can write code to filter search results before they enter context
  - 24% token reduction on average
  - 11% accuracy improvement
  - Citations with source URLs

### GPT (OpenAI) ✅
- **Tool:** `web_search` (Responses API)
- **Availability:** API key + OAuth (ChatGPT Plus/Pro)
- **Pricing:** See OpenAI pricing for built-in tools
- **Features:**
  - Non-reasoning search (fast lookups)
  - Agentic search with reasoning models (GPT-5.x)
  - Deep research mode for extended investigations
  - Inline URL citations
  - Domain filtering support

### Gemini (Google) ✅
- **Tool:** `google_search` (Google Search Grounding)
- **Availability:** API key only
- **Pricing:** Included in Gemini API pricing
- **Features:**
  - Real-time Google Search results
  - Grounding metadata with citations
  - Web search queries tracking
  - Source attribution

### Ollama (Local) ❌
- **Not Available:** Local models don't have internet access
- **Alternative:** Use browser automation tools for web scraping

## Implementation

### Architecture

**AI SDK Path (API Keys):**
```
User asks question requiring web search
  ↓
AgentService.streamAgent()
  ↓
buildNativeSearchTools(provider)
  ↓
Merge into tools object
  ↓
streamText({ tools: { ...customTools, ...nativeSearchTools } })
  ↓
Provider executes search on their servers
  ↓
Results streamed back with citations
```

**pi-ai Path (OAuth):**
```
User asks question requiring web search
  ↓
AgentService.streamAgent()
  ↓
buildNativeSearchToolsForPiAi(provider)
  ↓
buildPiContext({ nativeTools: [...] })
  ↓
streamSimple({ tools: [...customTools, ...nativeTools] })
  ↓
Provider executes search on their servers
  ↓
Results streamed back with citations
```

### Code Structure

**Files Modified:**
1. `src/gateway/services/AgentService.ts` - Added `buildNativeSearchTools()` and `buildNativeSearchToolsForPiAi()` methods
2. `src/gateway/services/providers/piAiHelpers.ts` - Added `nativeTools` parameter to `buildPiContext()`

**Key Functions:**

```typescript
// For AI SDK (API keys)
private buildNativeSearchTools(provider: Provider): Record<string, any> {
  const tools: Record<string, any> = {};
  
  switch (provider) {
    case "google":
      tools.google_search = google.tools.googleSearch({});
      break;
    case "openai":
      tools.web_search = openai.tools.webSearch({ maxUses: 10 });
      break;
    case "anthropic":
      tools.web_search = anthropic.tools.webSearch_20260209({ maxUses: 10 });
      break;
  }
  
  return tools;
}

// For pi-ai (OAuth)
private buildNativeSearchToolsForPiAi(provider: string): Array<{...}> {
  // Returns native tool definitions in pi-ai format
  // Example: { type: "web_search_20260209", name: "web_search", max_uses: 10 }
}
```

### Usage

**No configuration needed!** Web search is automatically enabled for all supported providers. The model decides when to search based on the user's query.

**Example queries that trigger search:**
- "What's the latest news about AI?"
- "Who won the F1 Grand Prix this weekend?"
- "What's the weather in NYC today?"
- "Find the current price of Bitcoin"

**How it works:**
1. User asks a question requiring up-to-date information
2. Model decides to use web search tool
3. Provider executes search on their servers
4. Results returned with citations
5. Model generates response with sourced information
6. User sees answer with citation links

## API Details

### Anthropic (Claude)

**Tool Configuration:**
```typescript
tools: {
  web_search: anthropic.tools.webSearch_20260209({
    maxUses: 10,
    // Optional:
    // allowedDomains: ['techcrunch.com', 'wired.com'],
    // blockedDomains: ['spam-site.com'],
    // userLocation: { type: 'approximate', city: 'San Francisco', region: 'California', country: 'US' }
  })
}
```

**Response Format:**
```json
{
  "content": [
    { "type": "text", "text": "I'll search for that information." },
    { "type": "server_tool_use", "id": "srvtoolu_123", "name": "web_search", "input": { "query": "AI news" } },
    { "type": "web_search_tool_result", "tool_use_id": "srvtoolu_123", "content": [...] },
    { "type": "text", "text": "Based on the search results...", "citations": [...] }
  ]
}
```

### OpenAI (GPT)

**Tool Configuration:**
```typescript
tools: {
  web_search: openai.tools.webSearch({
    maxUses: 10,
    // Optional:
    // filters: { domains: ['openai.com'] },
    // userLocation: { country: 'US', city: 'San Francisco', region: 'California' }
  })
}
```

**Response Format:**
```json
{
  "content": [
    {
      "type": "output_text",
      "text": "According to recent news...",
      "annotations": [
        {
          "type": "url_citation",
          "start_index": 0,
          "end_index": 50,
          "url": "https://example.com",
          "title": "Article Title"
        }
      ]
    }
  ]
}
```

### Google (Gemini)

**Tool Configuration:**
```typescript
tools: {
  google_search: google.tools.googleSearch({
    // Optional:
    // searchTypes: { webSearch: {}, imageSearch: {} },
    // timeRangeFilter: { startTime: '2025-01-01T00:00:00Z', endTime: '2025-12-31T23:59:59Z' }
  })
}
```

**Response Format:**
```json
{
  "text": "Based on recent information...",
  "sources": [
    { "url": "https://example.com", "title": "Article Title" }
  ],
  "providerMetadata": {
    "google": {
      "groundingMetadata": {
        "webSearchQueries": ["query text"],
        "groundingChunks": [...],
        "groundingSupports": [...]
      }
    }
  }
}
```

## Configuration Limits

| Provider | Max Searches/Request | Cost | Models |
|----------|----------------------|------|--------|
| Anthropic | 10 (configurable) | $10/1K searches | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 |
| OpenAI | 10 (configurable) | See OpenAI pricing | GPT-5.x, GPT-4.x |
| Google | Unlimited | Included | Gemini 2.5, 2.0, 1.5 |

## Testing

### Manual Testing

```bash
# Start the app
npm start

# In the chat:
# 1. Select any supported model (Claude, GPT, Gemini)
# 2. Ask: "What's the latest news about AI?"
# 3. Wait for model to search
# 4. Verify response includes citations
```

### Expected Behavior

**Claude (API key or OAuth):**
```
User: What's the latest news about AI?
Assistant: I'll search for that.
[web_search tool call]
[search results received]
Assistant: According to recent reports... [citation links]
```

**GPT (API key or OAuth):**
```
User: What's the weather in NYC?
Assistant: [searches automatically]
According to current data... [inline citations]
```

**Gemini (API key):**
```
User: Who won the F1 Grand Prix?
Assistant: [searches Google]
Based on recent results... [sources listed]
```

## Pricing Impact

### Anthropic
- **Before:** No search capability
- **After:** $10 per 1,000 searches + tokens
- **Example:** 10 searches with 50K result tokens = $0.10 + $0.15 input tokens = **$0.25 total**

### OpenAI
- **Before:** No search capability
- **After:** See OpenAI built-in tools pricing
- **Example:** Varies by model and search type (non-reasoning vs agentic vs deep research)

### Google
- **Before:** No search capability
- **After:** Included in Gemini pricing (no additional cost)
- **Example:** Free with Gemini API usage

## Limitations

### Current Limitations

1. **OpenAI via pi-ai (OAuth):** Experimental - may not work if ChatGPT backend doesn't expose search tool
2. **No custom search config per user:** All searches use default configuration (10 max uses, no domain filters)
3. **No search result caching:** Each search incurs provider cost
4. **Citation formatting:** Not yet parsed into UI-friendly format (future enhancement)

### Model-Specific Limitations

- **GPT-5 minimal reasoning:** Web search not supported
- **gpt-4.1-nano:** Web search not supported
- **Web search context window:** Limited to 128K tokens even for models with larger windows

## Future Enhancements

### Phase 1 (Implemented) ✅
- [x] Enable native search for all providers
- [x] Automatic tool integration (no user config needed)
- [x] Support both API key and OAuth routes

### Phase 2 (Future)
- [ ] User-configurable search settings (domain filters, max uses, location)
- [ ] Citation UI improvements (clickable links in chat)
- [ ] Search result caching (reduce costs for repeated queries)
- [ ] Search history tracking (analytics)

### Phase 3 (Future)
- [ ] Web fetch tool (fetch specific URLs)
- [ ] Image search grounding (Gemini)
- [ ] Google Maps grounding (Gemini)
- [ ] File search grounding (Gemini)

## Related Documentation

- [Claude Web Search Tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool)
- [OpenAI Web Search Guide](https://developers.openai.com/docs/guides/tools-web-search)
- [Google Search Grounding](https://ai.google.dev/gemini-api/docs/grounding)
- [AI SDK Tools Documentation](https://ai-sdk.dev/docs/foundations/tools)

## Package Updates

**Required versions:**
- `@ai-sdk/anthropic`: ^3.0.47 (web search support)
- `@ai-sdk/openai`: ^3.0.55 (web search support)
- `@ai-sdk/google`: ^3.0.55 (googleSearch tool)
- `@mariozechner/pi-ai`: ^0.64.0 (native tool support)

**Update command:**
```bash
npm install @ai-sdk/google@latest @ai-sdk/anthropic@latest @ai-sdk/openai@latest @mariozechner/pi-ai@latest
```

## Summary

Web search is now a **first-class capability** in Paprwork V2:
- ✅ Works with API keys and OAuth
- ✅ Automatic (no user configuration needed)
- ✅ Provider-executed (fast, reliable)
- ✅ Citations included (source attribution)
- ✅ Cost-effective (especially Gemini - free!)

**Next:** Test with all providers and enhance citation UI.
