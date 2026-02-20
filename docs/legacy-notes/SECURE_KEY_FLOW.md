# Secure API Key Flow (IPC-Only)

## Summary
Refactored to use IPC for ALL API key access. Keys are never sent over WebSocket anymore.

## Changes Made

### 1. Type System
**Created two types:**

```typescript
// Public interface (UI → Gateway)
export interface AgentConfig {
  provider: Provider;
  model: string;
  systemPrompt: string;
  // NO apiKey
}

// Internal interface (Gateway only)
export interface AgentConfigInternal extends AgentConfig {
  apiKey: string; // Fetched via IPC
}
```

**Files:**
- `src/core/types/agents.ts` - Core type definitions
- `ui/types/core.ts` - UI type definitions (mirrors core)

### 2. UI Changes
**Removed key fetching from UI:**

```typescript
// BEFORE (ui/components/Chat/ChatContainer.tsx)
const key = await window.electronAPI.customKeys.getByName(keyName);
const config = { provider, model, apiKey: key, ... };

// AFTER
const config = { provider, model, ... }; // NO apiKey
```

**Files:**
- `ui/components/Chat/ChatContainer.tsx` - Removed `electronAPI.customKeys.getByName()`

### 3. Gateway Changes
**Added key fetching in WebSocket handler:**

```typescript
// src/gateway/websocket/agent.ts
case "agent:stream": {
  // Fetch API key via IPC (secure method - never sent over WebSocket)
  const { getApiKeys } = await import("../utils/keyResolver.js");
  const keyName = `${config.provider.toUpperCase()}_API_KEY`;
  const keys = await getApiKeys([keyName]);
  apiKey = keys[keyName];
  
  // Create internal config with API key
  const configInternal = { ...config, apiKey };
  
  // Use internal config for streaming
  await agentService.streamAgent(chatId, userMessage, configInternal);
}
```

**Files:**
- `src/gateway/websocket/agent.ts` - Added IPC key fetching
- `src/gateway/services/AgentService.ts` - Now accepts `AgentConfigInternal`
- `src/gateway/services/ChatSessionManager.ts` - Now uses `AgentConfigInternal`
- `src/core/agents/MastraAgent.ts` - Now uses `AgentConfigInternal`

### 4. Bug Fix (Bonus)
**Fixed title generation key resolution:**

```typescript
// BEFORE (src/electron/index.cjs)
const value = await customKeysStorage.getKey(keyName); // ❌ Wrong! Expects UUID

// AFTER
const value = await customKeysStorage.getKeyByName(keyName); // ✅ Correct!
```

**Files:**
- `src/electron/index.cjs` - Fixed IPC key resolver method

## Security Improvements

### Before (Insecure)
```
┌─────────────────────────────────────────────────┐
│ UI                                              │
│ ├─ Fetches key from Electron                    │
│ └─ Sends over WebSocket: { apiKey: "sk-..." }  │
└─────────────────────────────────────────────────┘
                    │
                    ▼ ❌ Key sent over network (plaintext)
┌─────────────────────────────────────────────────┐
│ Gateway                                         │
│ └─ Uses key from WebSocket message              │
└─────────────────────────────────────────────────┘
```

**Vulnerabilities:**
- Keys visible in WebSocket traffic (even localhost)
- Keys visible in browser DevTools Network tab
- Keys visible to network sniffers (Wireshark, Charles)
- Keys accessible to any process monitoring network

### After (Secure)
```
┌─────────────────────────────────────────────────┐
│ UI                                              │
│ └─ Sends over WebSocket: { provider, model }   │
│    (NO apiKey)                                  │
└─────────────────────────────────────────────────┘
                    │
                    ▼ ✅ No keys on network
┌─────────────────────────────────────────────────┐
│ Gateway                                         │
│ ├─ Receives config (no key)                     │
│ ├─ Fetches key via IPC ← Electron → Keychain   │
│ └─ Uses key internally                          │
└─────────────────────────────────────────────────┘
```

**Security Benefits:**
- ✅ Keys never touch network layer (even localhost)
- ✅ Keys never visible in browser DevTools
- ✅ Keys only in Gateway process memory
- ✅ Keys fetched securely via IPC (not network-based)
- ✅ Consistent with macOS Keychain security model

## Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│ 1. User sends message                                        │
│    UI creates AgentConfig (NO apiKey)                        │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼ WebSocket (no keys)
┌──────────────────────────────────────────────────────────────┐
│ 2. Gateway receives request                                  │
│    ├─ WebSocket handler: agent.ts                            │
│    ├─ Fetches key via IPC: getApiKeys(["OPENAI_API_KEY"])   │
│    ├─ Creates AgentConfigInternal: { ...config, apiKey }    │
│    └─ Passes to AgentService.streamAgent()                   │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼ IPC (secure)
┌──────────────────────────────────────────────────────────────┐
│ 3. Electron Main Process                                     │
│    ├─ Receives IPC request: "REQUEST_KEYS"                   │
│    ├─ Fetches from Keychain: customKeys.getKeyByName()      │
│    └─ Returns via IPC: "KEYS_RESPONSE"                       │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. Gateway uses key                                          │
│    ├─ AgentService.streamAgent(configInternal)              │
│    ├─ ChatSessionManager sets process.env.OPENAI_API_KEY    │
│    └─ AI SDK streams response                                │
└──────────────────────────────────────────────────────────────┘
```

## Testing

1. **Restart TypeScript server** (IDE cache issue):
   - `Cmd+Shift+P` → "TypeScript: Restart TS Server"

2. **Test chat streaming**:
   ```bash
   npm start
   ```
   - Create new chat
   - Send message
   - Verify streaming works
   - Check logs for: `[Electron]   ✓ Resolved OPENAI_API_KEY`
   - Check logs for: `[Agent WS] Starting stream for chat ...`

3. **Verify title generation**:
   - First message should generate AI title (not truncated)
   - Check logs for: `[AgentService] Title generation enabled`

4. **Security verification**:
   - Open browser DevTools → Network tab
   - Send a message
   - Inspect WebSocket frames
   - Verify: NO `apiKey` field in request payload ✅

## Files Changed

**Core Types:**
- `src/core/types/agents.ts` - Added `AgentConfigInternal`
- `src/core/types/index.ts` - Export `AgentConfigInternal`
- `ui/types/core.ts` - Removed `apiKey` from `AgentConfig`

**UI:**
- `ui/components/Chat/ChatContainer.tsx` - Removed key fetching

**Gateway:**
- `src/gateway/websocket/agent.ts` - Added IPC key fetching
- `src/gateway/services/AgentService.ts` - Uses `AgentConfigInternal`
- `src/gateway/services/ChatSessionManager.ts` - Uses `AgentConfigInternal`
- `src/core/agents/MastraAgent.ts` - Uses `AgentConfigInternal`

**Electron:**
- `src/electron/index.cjs` - Fixed key resolution bug

## Migration Notes

This is a **breaking change** for any code that:
1. Creates `AgentConfig` with `apiKey` field
2. Expects `AgentConfig` to have `apiKey`

**Migration:**
- UI code: Remove `apiKey` from config creation
- Gateway internal code: Use `AgentConfigInternal` instead of `AgentConfig`

## Future Enhancements

1. **Session tokens**: Generate short-lived tokens instead of passing keys
2. **Key rotation**: Support automatic key rotation without restart
3. **Multi-key support**: Allow multiple keys per provider for load balancing
4. **Audit logging**: Log all key access for security monitoring
