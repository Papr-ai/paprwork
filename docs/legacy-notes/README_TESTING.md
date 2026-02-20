# Testing Guide

## LLM Streaming Tests

To test streaming functionality with multiple LLM providers:

### 1. Setup API Keys

Create a `.env.local` file in the project root (already created) and add your API keys:

```bash
# Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-your-key-here

# OpenAI (GPT)
OPENAI_API_KEY=sk-your-key-here

# Google (Gemini) - Note: Mastra expects this specific name
GOOGLE_GENERATIVE_AI_API_KEY=your-key-here
```

**Note**: The `.env.local` file is gitignored and won't be committed.

### 2. Run Tests

```bash
npm run test:llm-streaming
```

This will test streaming with all providers that have API keys configured.

### 3. What the Test Checks

- ✅ Chunks are received from the API
- ✅ Text content is extracted from chunks
- ✅ Streaming completes successfully
- ✅ Response time and performance metrics

### Expected Output

```
🧪 LLM STREAMING TESTS
Found 3 API key(s):
   ✓ anthropic (ANTHROPIC_API_KEY)
   ✓ openai (OPENAI_API_KEY)
   ✓ google (GOOGLE_API_KEY)

============================================================
Testing ANTHROPIC (claude-sonnet-4-20250514)
============================================================

📤 Sending: "Say 'Hello World' and nothing else."
⏳ Streaming response...
Hello World

────────────────────────────────────────────────────────────
📊 RESULTS:
   ✅ Status: Success
   📦 Total chunks: 12
   📝 Text length: 11 chars
   💭 Thinking length: 0 chars
   🔧 Tool calls: 0
   ⏱️  Duration: 847ms
   📈 Avg chunk time: 70ms
────────────────────────────────────────────────────────────
```

## Other Tests

```bash
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# All tests
npm run test:all

# With coverage
npm run test:coverage
```
