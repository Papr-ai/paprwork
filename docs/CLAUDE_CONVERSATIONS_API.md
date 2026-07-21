# Claude.ai Conversation History API — Reverse Engineering Notes

**Date:** 2026-06-19  
**Status:** ✅ Confirmed via Chrome DevTools (CDP) on signed-in session  
**Method:** Attached to user's Chrome tab (`remote-debugging-port=9222`)

## Summary

Claude web history uses **claude.ai session cookies** (not Paprwork Claude OAuth tokens). The OAuth scopes used for inference (`user:profile`, `user:inference`) do **not** grant access to these endpoints.

This is **not** parallel to ChatGPT's `backend-api/conversations` + OAuth Bearer flow.

---

## Confirmed Endpoints

### 1. List conversations (sidebar)

```
GET https://claude.ai/api/organizations/{org_uuid}/chat_conversations_v2
  ?limit=30
  &starred=false
  &consistency=eventual
```

**Notes:**
- `chat_conversations_v2` (not the older `chat_conversations` path some tools document)
- Pagination via `limit` + likely `offset` (offset observed in older `chat_conversations` docs)
- `consistency=eventual` appears required for list reads

### 2. Single conversation (full messages)

```
GET https://claude.ai/api/organizations/{org_uuid}/chat_conversations/{conversation_uuid}
  ?tree=True
  &rendering_mode=messages
  &render_all_tools=true
  &consistency=strong
```

**Response (confirmed shape):**
```json
{
  "uuid": "e7f85eaf-bd80-4b32-a847-deb9f7f32909",
  "name": "Pre-seed data room checklist for AI infra companies",
  "summary": "",
  "model": "claude-opus-4-5-20251101",
  "created_at": "2026-01-19T19:13:07.864662Z",
  "updated_at": "2026-01-21T01:10:11.548996Z",
  "settings": { ... },
  "is_starred": false,
  "is_temporary": false,
  "platform": "CLAUDE_AI",
  "chat_messages": [ ... ]
}
```

Messages use tree structure (`parent_message_uuid`, `current_leaf_message_uuid` on conversation).

### 3. Bootstrap / org discovery

```
GET https://claude.ai/edge-api/bootstrap/{org_uuid}/app_start
  ?statsig_hashing_algorithm=djb2
  &growthbook_format=sdk
  &include_system_prompts=false
```

Returns account, org uuid, model configs, memberships (~400KB). Useful to discover `org_uuid` if unknown.

```
GET https://claude.ai/api/bootstrap/{org_uuid}/current_user_access
```

Returns feature flags and permissions (includes `export:data`).

---

## Authentication

### What works (web client)

| Mechanism | Details |
|-----------|---------|
| **Cookie** | `sessionKey=sk-ant-sid01-...` (HttpOnly, set on login) |
| **Client headers** | See below |

**Required / observed headers (no `Authorization: Bearer`):**
```
anthropic-client-platform: web_claude_ai
anthropic-client-version: 1.0.0
anthropic-client-sha: <git sha of web bundle>
anthropic-anonymous-id: claudeai.v1.<uuid>
anthropic-device-id: <uuid>
x-activity-session-id: <uuid>
content-type: application/json
User-Agent: Mozilla/5.0 ...
Referer: https://claude.ai/chats
```

Optional telemetry: `x-datadog-*`, `traceparent`, `tracestate`

### What does NOT work

- Paprwork **Claude OAuth** access token (`sk-ant-oat01-...`) → inference API only
- API keys (`sk-ant-api03-...`) → Platform API, not claude.ai web

---

## How We Captured This

### Prerequisites

Chrome with remote debugging (user already had port 9222 open):

```bash
# If needed:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

### Probe script (attach to signed-in tab)

```bash
node scripts/probe-claude-existing-tab.mjs
```

Opens `/chats`, clicks first chat, logs Network via CDP.

### Manual DevTools steps

1. Open **claude.ai** in Chrome (signed in)
2. DevTools → **Network** → filter `chat_conversation`
3. Go to **Chats** (`/chats`) → see `chat_conversations_v2`
4. Open any chat → see `chat_conversations/{uuid}?tree=True...`
5. Right-click request → **Copy as cURL** (includes cookies)

---

## Comparison: ChatGPT vs Claude

| | ChatGPT | Claude.ai |
|---|---------|-----------|
| **Auth** | OAuth Bearer token | Session cookie `sessionKey` |
| **List** | `/backend-api/conversations` | `/api/organizations/{org}/chat_conversations_v2` |
| **Detail** | `/backend-api/conversation/{id}` | `/api/organizations/{org}/chat_conversations/{id}` |
| **Paprwork OAuth** | ✅ Works | ❌ Different auth surface |
| **Official import** | N/A | Settings → Privacy → Export data (ZIP) |

---

## Implementation Options for Paprwork

### Option A: Official ZIP import (recommended)

User exports from claude.ai → upload `conversations.json` → parse into Paprwork chats. ToS-safe, no session hijacking.

### Option B: Session cookie + unofficial API

Like [claude-explorer](https://github.com/rpeck/claude-explorer): Playwright login → capture `sessionKey` → call endpoints above. Fragile (Cloudflare, expiry, unofficial).

### Option C: OAuth like ChatGPT

**Not viable** — scopes and token type do not cover web conversation APIs.

---

## Probe Scripts

| Script | Purpose |
|--------|---------|
| `scripts/probe-claude-existing-tab.mjs` | Attach to signed-in Chrome tab |
| `scripts/probe-claude-history-cdp.mjs` | Open new tab via CDP |
| `scripts/probe-claude-conversation-detail.mjs` | Single chat page capture |

---

## Related Docs

- `docs/CHATGPT_CONVERSATIONS_API.md` — ChatGPT OAuth approach (works differently)
- `docs/CHATGPT_CONV_HISTORY_IMPLEMENTATION.md` — Paprwork ChatGPT UI
