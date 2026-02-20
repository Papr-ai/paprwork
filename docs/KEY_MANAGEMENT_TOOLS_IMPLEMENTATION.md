# Key Management Tools Implementation

**Date:** 2026-02-19  
**Issue:** Agent cannot access custom API keys added by user in Settings UI

---

## Problem

User added a custom API key (`PAPRWORK_PUBLICREPOS`) in Settings UI, but the agent:
1. Didn't check if the key exists using `list_keys`
2. Searched random file locations (`~/PAPR/secrets.json`, papr.db, etc.)
3. Told user "token doesn't seem to be persisted anywhere"

**Root Cause:** The key management tools (`list_keys`, `get_key`, `set_key`, `delete_key`) were **mentioned in the system prompt** but **never implemented**!

---

## Solution

Implemented complete key management tool suite with Gateway ↔ Electron IPC bridge.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Agent Tools (src/core/tools/keyManagement.ts)              │
│  • list_keys: List all custom keys (metadata only)          │
│  • get_key: Check if a key exists and get its value        │
│  • set_key: Add or update a custom key                      │
│  • delete_key: Remove a custom key                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ CustomKeysService (src/gateway/services/)                   │
│  • Singleton service in Gateway process                      │
│  • Sends IPC messages to Electron                          │
│  • Handles responses with timeout + cleanup                 │
└──────────────────────┬──────────────────────────────────────┘
                       │ process.send() / process.on("message")
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Electron IPC Handler (src/electron/index.cjs)               │
│  • Receives messages from Gateway                           │
│  • Calls CustomKeysStorage methods                         │
│  • Sends responses back to Gateway                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ CustomKeysStorage (src/core/storage/)                       │
│  • Encrypts/decrypts keys using safeStorage API            │
│  • Stores in ~/.paprwork/data/custom-keys.json             │
│  • macOS: Uses System Keychain for encryption              │
└─────────────────────────────────────────────────────────────┘
```

---

## Files Created

### 1. `src/core/tools/keyManagement.ts` (300 lines)

Five new agent tools:

```typescript
// List all custom keys (metadata only, no values)
export const listKeysTool = createTool({
  id: "list_keys",
  description: "List all custom API keys configured in Settings...",
  execute: async () => {
    const service = getCustomKeysService();
    const keys = await service.listKeys();
    return { keys, count: keys.length };
  }
});

// Get a specific key value (to check if it exists)
export const getKeyTool = createTool({
  id: "get_key",
  description: "Get the value of a specific custom API key by name...",
  execute: async (args) => {
    const value = await service.getKeyByName(args.name);
    return { exists: !!value, valueLength: value?.length };
  }
});

// Add or update a key (programmatic setup only)
export const setKeyTool = createTool({
  id: "set_key",
  description: "Add or update a custom API key. Only use when user provides value...",
  execute: async (args) => {
    await service.addKey({
      name: args.name,
      value: args.value,
      description: args.description,
      permission: args.permission
    });
  }
});

// Delete a key
export const deleteKeyTool = createTool({
  id: "delete_key",
  description: "Delete a custom API key...",
  execute: async (args) => {
    await service.deleteKey(args.name);
  }
});

// Request a missing key with inline input card (NEW - BEST UX!)
export const requestKeyTool = createTool({
  id: "request_key",
  description: "Request a missing API key with an inline input card in chat...",
  inputSchema: z.object({
    name: z.string(),
    description: z.string(),
    sourceUrl: z.string().optional(),
    requiredScopes: z.array(z.string()).optional(),
    permission: z.enum(["always", "ask"]).default("ask")
  }),
  execute: async (args) => {
    // Returns special format that UI recognizes and renders as KeyRequestCard
    return {
      success: true,
      data: {
        type: "key_request",
        name: args.name,
        description: args.description,
        sourceUrl: args.sourceUrl,
        requiredScopes: args.requiredScopes,
        suggestedPermission: args.permission,
        status: "awaiting_user_input"
      }
    };
  }
});
```

### 2. `src/gateway/services/CustomKeysService.ts` (240 lines)

Gateway service that bridges to Electron via IPC:

```typescript
export class CustomKeysService {
  // List all keys (sends CUSTOM_KEYS_LIST message)
  async listKeys(): Promise<CustomKey[]> {
    return new Promise((resolve, reject) => {
      const requestId = `custom-keys-list-${Date.now()}`;
      process.on("message", messageHandler);
      process.send!({ type: "CUSTOM_KEYS_LIST", requestId });
    });
  }

  // Get key by name (sends CUSTOM_KEYS_GET_BY_NAME message)
  async getKeyByName(name: string): Promise<string | null> { ... }

  // Add key (sends CUSTOM_KEYS_ADD message)
  async addKey(input: CustomKeyInput): Promise<CustomKey> { ... }

  // Delete key (sends CUSTOM_KEYS_DELETE message)
  async deleteKey(name: string): Promise<void> { ... }
}
```

---

## Files Modified

### 1. `src/core/tools/index.ts`

Added key management tools to registry:

```typescript
import { keyManagementTools } from "./keyManagement.js";

export const allTools = [
  bashTool,
  ...filesystemTools,
  ...keyManagementTools,  // ← NEW
];

export const toolsByCategory = {
  system: [bashTool],
  filesystem: filesystemTools,
  keyManagement: keyManagementTools,  // ← NEW
};
```

### 2. `src/electron/index.cjs`

Added Gateway IPC message handlers:

```javascript
gatewayProcess.on("message", async (msg) => {
  // ... existing handlers ...

  // List custom keys
  else if (msg.type === "CUSTOM_KEYS_LIST") {
    const keys = await customKeysStorage.listKeys();
    gatewayProcess.send({
      type: "CUSTOM_KEYS_RESPONSE",
      requestId: msg.requestId,
      keys,
    });
  }

  // Get key by name
  else if (msg.type === "CUSTOM_KEYS_GET_BY_NAME") {
    const value = await customKeysStorage.getKeyByName(msg.name);
    gatewayProcess.send({
      type: "CUSTOM_KEYS_RESPONSE",
      requestId: msg.requestId,
      value,
    });
  }

  // Add key
  else if (msg.type === "CUSTOM_KEYS_ADD") {
    const key = await customKeysStorage.addKey(msg.input);
    gatewayProcess.send({
      type: "CUSTOM_KEYS_RESPONSE",
      requestId: msg.requestId,
      key,
    });
  }

  // Delete key
  else if (msg.type === "CUSTOM_KEYS_DELETE") {
    await customKeysStorage.deleteKey(msg.keyId);
    gatewayProcess.send({
      type: "CUSTOM_KEYS_RESPONSE",
      requestId: msg.requestId,
    });
  }
});
```

### 3. `src/core/agents/SystemPrompt.ts`

Updated with workflow guidance (from earlier fix):

```typescript
## When You Need a Key That Doesn't Exist

1. **Check what keys exist**: Call \`list_keys\` to see available keys
2. **Direct user to Settings UI**: Tell them to add the key in Settings
3. **Provide clear instructions**: Key name, source URL, permissions
4. **Wait for confirmation**: Let user add it, then continue
```

---

## Expected Behavior After Fix

### Scenario: Agent needs GitHub token

**Before (no tools):**
```
Agent: [searches random files]
Agent: "The token doesn't seem to be persisted anywhere. 
       Paste it here and I'll hardcode it into the job script."
```

**After (with tools):**
```
Agent: [calls list_keys]
Agent: "I see you have PAPRWORK_PUBLICREPOS configured. 
       I'll use that for the API calls."
Agent: [calls bash with ${PAPRWORK_PUBLICREPOS}]
```

### Scenario: Key doesn't exist

**Before:**
```
Agent: [searches files, finds nothing]
Agent: "Can you paste the token here?"
```

**After:**
```
Agent: [calls list_keys → no GITHUB_TOKEN]
Agent: "I'll need a GitHub token. Please:
1. Go to Settings → API Keys → Custom API Keys
2. Click 'Add Custom Key'
3. Name: GITHUB_TOKEN
4. Value: Get from github.com/settings/tokens
5. Permission: 'Always Allow' (for automation)

Let me know once you've added it!"
```

---

## Testing

### Test Case 1: List keys
```typescript
// Agent calls: list_keys()
// Result:
{
  keys: [
    {
      name: "PAPRWORK_PUBLICREPOS",
      description: "GitHub token for public repos",
      permission: "always",
      createdAt: "2026-02-19T..."
    }
  ],
  count: 1
}
```

### Test Case 2: Check if key exists
```typescript
// Agent calls: get_key({ name: "PAPRWORK_PUBLICREPOS" })
// Result:
{
  name: "PAPRWORK_PUBLICREPOS",
  exists: true,
  valueLength: 40,
  message: "Use ${PAPRWORK_PUBLICREPOS} in bash commands"
}
```

### Test Case 3: Key not found
```typescript
// Agent calls: get_key({ name: "MISSING_KEY" })
// Result:
{
  success: false,
  error: "Key 'MISSING_KEY' not found. User needs to add it in Settings."
}
```

---

## Security

All tools follow the secure key management pattern:

1. **Values never logged**: Tool results show metadata only (name, length, exists)
2. **Keys encrypted**: Storage uses macOS Keychain via Electron's safeStorage
3. **Permission control**: User sets "always" or "ask" per key
4. **IPC bridge**: Gateway → Electron IPC prevents direct file access
5. **Sanitization**: All bash outputs automatically redact key values

---

## Benefits

### For Agents
- ✅ Can check what keys are available (`list_keys`)
- ✅ Can verify a key exists before using it (`get_key`)
- ✅ Can guide users to add missing keys (Settings UI workflow)
- ✅ No more random file searches or hardcoded values

### For Users
- ✅ Keys securely stored in system Keychain
- ✅ Keys work across all sessions/jobs
- ✅ Fine-grained permission control (always/ask)
- ✅ Agent respects Settings UI as single source of truth

### For Developers
- ✅ Clean IPC architecture (Gateway ↔ Electron)
- ✅ Reusable service pattern
- ✅ Type-safe tool definitions
- ✅ Comprehensive error handling

---

## Related Documentation

- **API Key Workflow Fix:** `docs/API_KEY_WORKFLOW_FIX.md`
- **Custom Keys System:** `docs/CUSTOM_KEYS.md`
- **Key Storage:** `src/core/storage/CustomKeysStorage.ts`
- **IPC Types:** `src/core/types/gateway-ipc.ts`
- **Tool Security:** `src/core/tools/security.ts`

---

**Summary:** Implemented complete key management tool suite that bridges Gateway → Electron via IPC. Agent can now check what keys exist, verify specific keys, and guide users to Settings UI for missing keys — no more random file searches!
