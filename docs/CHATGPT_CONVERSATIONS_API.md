# ChatGPT Conversations API - Reverse Engineering Notes

**Date:** 2026-02-23  
**Status:** Research / Experimental

## Overview

This document covers research into accessing a user's prior ChatGPT conversations via the `chatgpt.com/backend-api` endpoints when authenticated with OAuth tokens.

## Known Endpoints

### 1. Chat Completion (✅ Confirmed Working)

**Endpoint:** `https://chatgpt.com/backend-api/codex/responses`  
**Method:** POST  
**Purpose:** Create new chat completions (model inference)  
**Status:** ✅ Working in Paprwork via `@mariozechner/pi-ai`

**Headers Required:**
```
Authorization: Bearer <oauth_access_token>
chatgpt-account-id: <account_id>
OpenAI-Beta: responses=experimental
originator: paprwork
content-type: application/json
```

**Implementation:** `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts`

---

## 🎯 Conversation Structure (CONFIRMED)

The `/conversation/{id}/textdocs` endpoint returns a detailed conversation tree:

```typescript
{
  title: string;
  create_time: number; // Unix timestamp (seconds)
  update_time: number; // Unix timestamp (seconds)
  conversation_id: string;
  current_node: string; // ID of the current/latest message
  
  // The conversation tree - each node is a message
  mapping: {
    [nodeId: string]: {
      id: string;
      message: {
        id: string;
        author: { role: "user" | "assistant" | "system" };
        create_time: number;
        content: {
          content_type: "text" | "user_editable_context" | "model_editable_context";
          parts: string[]; // Actual message text
        };
        status: "finished_successfully" | ...;
        metadata: {
          model_slug?: string;
          token_count?: number;
          thinking_effort?: string;
          // ... many more fields
        };
      } | null;
      parent: string | null; // Parent node ID
      children: string[]; // Child node IDs (for branching)
    };
  };
  
  // Other metadata
  moderation_results: [];
  is_archived: boolean;
  default_model_slug: string;
  safe_urls: string[];
  // ... more fields
}
```

### Key Insights

1. **Tree Structure:** Messages form a tree (not linear) to support branching/editing
2. **Timestamps:** Unix seconds (not milliseconds!)
3. **Message Text:** In `content.parts[0]`
4. **Hidden Messages:** System messages with `is_visually_hidden_from_conversation: true`
5. **Current Path:** Follow `current_node` backwards via `parent` to get the active conversation thread

**Endpoint:** `https://chatgpt.com/backend-api/conversations`  
**Method:** GET  
**Purpose:** List user's conversation history from chatgpt.com  
**Status:** ✅ CONFIRMED via browser DevTools

**Headers Required:**
```
Authorization: Bearer <oauth_access_token>
Accept: */*
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: en-US,en;q=0.9
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
```

**Query Parameters:**
```
?offset=0              // Pagination offset (default: 0)
?limit=28              // Results per page (default: 28)
?order=-updated        // Sort order: -updated (desc) or updated (asc)
?is_archived=false     // Filter: exclude archived
?is_starred=false      // Filter: exclude starred
```

**Response Structure (confirmed):**
```json
{
  "items": [
    {
      "id": "conv-abc123...",
      "title": "Conversation title",
      "create_time": 1708698600.123,  // Unix timestamp
      "update_time": 1708706700.456,  // Unix timestamp
      "mapping": null,  // Not included in list view
      "model_slug": "gpt-5.3-codex",
      "conversation_template_id": null,
      "is_archived": false,
      "workspace_id": null
    }
  ],
  "total": 142,
  "limit": 28,
  "offset": 0,
  "has_next": true
}
```

**Key Notes:**
- ✅ Only requires OAuth Bearer token (no chatgpt-account-id needed)
- ✅ No CSRF token required for GET requests
- ✅ Returns 200 OK with valid OAuth token
- ⚠️ `mapping` (messages) is NOT included in list - must fetch individually

---

### 3. Single Conversation (⏳ Needs Testing)

**Likely Endpoint:** `https://chatgpt.com/backend-api/conversation/<conversation_id>`  
**Method:** GET  
**Purpose:** Fetch full conversation history for a specific chat  
**Status:** ⏳ Endpoint pattern likely correct, needs confirmation

**Headers (expected to be same as list):**
```
Authorization: Bearer <oauth_access_token>
Accept: */*
User-Agent: Mozilla/5.0 ...
```

**Expected Response:**
- Full message tree in `mapping` node graph structure
- Each turn with role, content, metadata, tool calls
- Branching/editing history preserved

**Next Step:** Add this endpoint to test script and confirm structure

---

### 4. Security Gate (⚠️ May Be Required)

**Endpoint:** `https://chatgpt.com/backend-api/sentinel/chat-requirements`  
**Method:** POST  
**Purpose:** Pre-flight security check before conversation access  
**Status:** ⚠️ Required by web client, may be enforced

**Returns:**
- Token + expiry
- Proof-of-work challenge (seed + difficulty)
- Turnstile CAPTCHA requirements
- Arkose anti-abuse requirements

**Note:** Web client must complete proof-of-work (hash computation) before proceeding.

---

## Authentication Flow

### Current Paprwork OAuth Flow (✅ Working)

```
1. User initiates OAuth in Paprwork
2. Opens: https://auth.openai.com/oauth/authorize
   - client_id: app_EMoamEEZ73f0CkXaXp7hrann (pi-ai public client)
   - scopes: openid profile email offline_access
   - PKCE challenge
3. User logs in to ChatGPT
4. OpenAI redirects: http://localhost:1455/auth/callback?code=...
5. Paprwork exchanges code for tokens (POST to /oauth/token)
6. Receives:
   - access_token (JWT with chatgpt_account_id claim)
   - refresh_token
   - id_token
7. Stores tokens in ~/.paprwork-v2/custom-keys.json
8. Uses access_token for /codex/responses calls
```

**Implementation:** `src/core/services/OpenAIOAuthService.ts`

---

## Research Approach

### Method 1: Test Script (Recommended First Step)

Run the test script to probe the conversations endpoint:

```bash
cd /Users/amirkabbara/Documents/GitHub/paprwork-v2
node scripts/test-chatgpt-conversations.mjs
```

**What it does:**
- Reads OAuth token from `~/.paprwork-v2/custom-keys.json`
- Extracts account ID from JWT
- Tests multiple endpoint variations:
  - `GET /backend-api/conversations`
  - `GET /backend-api/conversations?limit=20&offset=0`
  - `GET /backend-api/conversation`
  - `GET /backend-api/me`
- Reports status codes, headers, response structures

**Results (2026-02-23):**
- ✅ **CONFIRMED WORKING!** Conversations list endpoint returns 200 OK
- ✅ Only needs OAuth Bearer token (no extra headers)
- ✅ No CSRF or proof-of-work required for GET requests
- ✅ Supports pagination (offset/limit) and filtering (archived/starred)

---

### Method 2: Browser DevTools (Most Reliable)

1. Open Chrome DevTools (Network tab)
2. Go to https://chatgpt.com
3. Log in with your ChatGPT account
4. Clear network log
5. Click on conversation history sidebar
6. Look for requests to `/backend-api/...`
7. Inspect:
   - Request URL
   - Request headers (especially csrf-token, cookies)
   - Response structure
8. Right-click request → "Copy as cURL" or "Copy as fetch"

**Key things to capture:**
- Full endpoint URL with query params
- All request headers (especially non-obvious ones)
- Cookie values if needed
- Response JSON structure

---

### Method 3: GitHub Reverse Engineering Projects

Check these open-source projects for implementation details:

1. **gin337/ChatGPTReversed** (GitHub)
   - TypeScript implementation
   - May have conversations endpoint documented

2. **binary-husky/Reverse-engineered-ChatGPT-API** (GitHub)
   - Python implementation
   - Check for list_conversations() method

3. **GPT Keyhole Study** (alinr.com)
   - HAR file analysis
   - Documents conversation data structure

**Search for:**
- `conversations` endpoint paths
- `mapping` structure (message tree)
- Required headers (csrf-token, session-token)

---

## Security Considerations

### 1. Anti-Abuse Protection

ChatGPT backend has multiple security layers:
- **Cloudflare bot detection** (at edge)
- **Turnstile CAPTCHA** (application layer)
- **Proof-of-work** (hash computation)
- **Arkose Labs** (anti-automation)

**Impact on automation:**
- May block programmatic access
- May require browser-like user-agent
- May need to complete proof-of-work challenges

### 2. CSRF Protection

Web client includes `csrf-token` header:
- Obtained from initial page load (cookie or meta tag)
- Sent with each API request
- May be required even with OAuth token

**If needed:**
- Extract from cookies after OAuth login
- Or make initial GET to chatgpt.com to retrieve token

### 3. Rate Limiting

Expect rate limits on conversation listing:
- Likely stricter than /codex/responses
- May trigger security gates on rapid requests
- Implement backoff/retry logic

---

## Implementation Plan (If Endpoint Confirmed)

### Phase 1: Prototype (Test Script) ✅ COMPLETE
✅ Created: `scripts/test-chatgpt-conversations.mjs`
- [x] Load OAuth token from storage
- [x] Extract account ID from JWT
- [x] Test endpoint variations
- [x] **CONFIRMED working endpoint + headers (2026-02-23)**

**Confirmed via browser DevTools:**
- Endpoint: `/backend-api/conversations?offset=0&limit=28&order=-updated&is_archived=false&is_starred=false`
- Method: GET
- Headers: Authorization Bearer token (minimal)

### Phase 2: Core Service
Create `src/core/services/ChatGPTConversationsService.ts`:
```typescript
export class ChatGPTConversationsService {
  async listConversations(
    accessToken: string,
    options?: {
      limit?: number;
      offset?: number;
      order?: 'created' | 'updated';
    }
  ): Promise<ConversationListResponse>;

  async getConversation(
    accessToken: string,
    conversationId: string
  ): Promise<ConversationDetail>;

  async importConversation(
    conversationId: string,
    storageManager: StorageManager
  ): Promise<{ chatId: string; messageCount: number }>;
}
```

### Phase 3: UI Integration
Add import feature to UI:
- Settings → ChatGPT → "Import Conversations"
- List conversations with checkboxes
- Select conversations to import
- Convert ChatGPT message format → Paprwork format
- Store in local SQLite (`~/.paprwork-v2/chats.db`)
- Preserve metadata (timestamps, model, tool calls)

### Phase 4: Format Conversion
Map ChatGPT conversation structure → Paprwork:
```typescript
ChatGPT mapping node → CoreMessage
- role: "user" | "assistant" | "system"
- content: { type: "text", text: "..." }[]
- tool_calls → CoreToolCall[]
- metadata → Store in message metadata
```

---

## Alternative: Export Feature

If programmatic access is blocked, provide export instructions:

**Manual Export (User-driven):**
1. Go to https://chatgpt.com/settings → Data Controls → Export
2. OpenAI emails zip file with all conversations (JSON)
3. In Paprwork: Settings → Import → "Import ChatGPT Export"
4. Select downloaded JSON file
5. Paprwork parses and imports conversations

**Pros:**
- No reverse engineering needed
- Official OpenAI feature
- Includes full history

**Cons:**
- Manual process (not one-click)
- Export takes hours/days to prepare
- Not real-time

---

## Next Steps

1. **Run test script** to confirm endpoint accessibility
2. **If 200 OK:** Document response structure, implement service
3. **If 401/403:** Use browser DevTools to capture real requests
4. **If blocked:** Implement manual export import feature instead
5. **Update this doc** with findings

---

## References

- OpenAI OAuth Service: `src/core/services/OpenAIOAuthService.ts`
- Pi-ai codex integration: `src/gateway/services/providers/PiCodexStreamWithToolLoop.ts`
- Test script: `scripts/test-chatgpt-conversations.mjs`
- Codex implementation doc: `docs/OPENAI_CODEX_OAUTH_IMPLEMENTATION.md`

## Status Log

- **2026-02-23 (14:43):** Initial research, test script created
- **2026-02-23 (15:57):** ✅ **ENDPOINT CONFIRMED!** Captured working request via browser DevTools
  - Conversations list: `GET /backend-api/conversations` (200 OK)
  - Only requires OAuth Bearer token
  - Supports pagination, sorting, filtering
  - Ready for implementation phase
