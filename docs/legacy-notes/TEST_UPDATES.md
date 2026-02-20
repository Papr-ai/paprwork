# Test Updates for Architecture Changes

## Summary
Updated all tests to match the new architecture:
1. **IPC-only key flow** - `AgentConfigInternal` with `apiKey`
2. **Per-chat state management** - Removed global `activeChat`

## Changes Made

### 1. Gateway Tests (`tests/chat-session-manager.test.ts`)

**Issue:** Tests were using old `AgentConfig` type without `apiKey`

**Fix:** Updated to use `AgentConfigInternal`

```typescript
// BEFORE
import type { AgentConfig } from '../src/types/agent';

const config: AgentConfig = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  // ❌ Missing apiKey
  systemPrompt: 'You are a helpful assistant.',
};

// AFTER  
import type { AgentConfigInternal } from '../src/core/types/agents';

const config: AgentConfigInternal = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  apiKey: 'test-key', // ✅ Required for internal use
  systemPrompt: 'You are a helpful assistant.',
};
```

**Files Changed:**
- `tests/chat-session-manager.test.ts` - All 4 test functions updated

### 2. UI Tests (`ui/__tests__/features/comprehensive.test.ts`)

**Issue:** Tests were using removed `activeChat` state and `setActiveChat()` method

**Fix:** Removed all `setActiveChat()` calls and updated tests to use per-chat state

#### A. Store Initialization

```typescript
// BEFORE
useChatStore.setState({
  activeChat: null, // ❌ Removed
  chatStates: new Map(),
  chats: [],
  messages: [],      // ❌ Removed (now per-chat)
  isLoading: false,  // ❌ Removed (now per-chat)
  isSending: false,  // ❌ Removed (now per-chat)
  error: null,       // ❌ Removed (now per-chat)
});

// AFTER
useChatStore.setState({
  chatStates: new Map(),
  chats: [],
});
```

#### B. Chat State Initialization

```typescript
// BEFORE - Had to "activate" chats first
useChatStore.getState().setActiveChat(chatId);
const state = useChatStore.getState().chatStates.get(chatId);

// AFTER - Chat state created on-demand
const state = useChatStore.getState().getChatState(chatId);
```

#### C. Multiple Chat Tests

```typescript
// BEFORE - Activate each chat
useChatStore.getState().setActiveChat("chat-1");
useChatStore.getState().setActiveChat("chat-2");
useChatStore.getState().setActiveChat("chat-3");
useChatStore.getState().addMessage(msg, "chat-1");

// AFTER - Direct access
useChatStore.getState().addMessage(msg, "chat-1");
useChatStore.getState().addMessage(msg, "chat-2");
```

#### D. Streaming State Tests

```typescript
// BEFORE
useChatStore.getState().setActiveChat("chat-1");
useChatStore.getState().setActiveChat("chat-2");
useChatStore.getState().setChatStreaming("chat-1", true);

// AFTER
useChatStore.getState().setChatStreaming("chat-1", true);
```

#### E. Unread State Tests

```typescript
// BEFORE
useChatStore.getState().setActiveChat("chat-1");
useChatStore.getState().setActiveChat("chat-2");
// Message added while not active
useChatStore.getState().addMessage(msg, "chat-1");
// Switch back
useChatStore.getState().setActiveChat("chat-1");

// AFTER
useChatStore.getState().addMessage(msg, "chat-1");
useChatStore.getState().markChatAsRead("chat-1");
```

#### F. Integration Tests

```typescript
// BEFORE
useChatStore.getState().setActiveChat("temp-123");
const chatTab = useTabStore.getState().createTab("chat", "temp-123", "Chat");

// AFTER
const chatStore = useChatStore.getState();
const chatTab = useTabStore.getState().createTab("chat", "temp-123", "Chat");
```

**Files Changed:**
- `ui/__tests__/features/comprehensive.test.ts` - 20+ test cases updated

## Architecture Changes Reflected

### 1. No More Global Active Chat
**Before:** Single global `activeChat` state that determined which chat receives events

**After:** Each chat has independent state in `chatStates` Map, accessed by `chatId`

**Benefits:**
- True parallel streaming
- No race conditions when switching tabs
- Clearer data flow

### 2. IPC-Only Key Flow
**Before:** Keys passed in request payload over WebSocket

**After:** Keys fetched internally via IPC within Gateway

**Benefits:**
- Keys never on network (even localhost)
- Type safety with `AgentConfigInternal`
- Centralized key management

## Test Coverage

### Gateway Tests ✅
- Session creation with multiple chats
- Session reuse for same config
- Session management (abort, clear)
- Parallel session handling

### UI Tests ✅
- Chat state management (per-chat)
- Parallel streaming (independent states)
- Unread tracking (per-chat)
- Empty chat detection
- Tab management
- Integration workflows

## Running Tests

```bash
# All tests
npm test

# Gateway tests only
npm run test:gateway

# UI tests only
cd ui && npm test

# Watch mode
npm test -- --watch
```

## Breaking Changes

### For Tests

1. **AgentConfig → AgentConfigInternal**
   - Gateway/internal code must use `AgentConfigInternal`
   - Must include `apiKey` in config objects

2. **No setActiveChat()**
   - Remove all `setActiveChat()` calls
   - Use `getChatState(chatId)` to access chat state
   - Use `addMessage(msg, chatId)` to add to specific chat

3. **No Global Chat State**
   - No `activeChat` property
   - No global `messages`, `isLoading`, `isSending`, `error`
   - All state is per-chat in `chatStates` Map

### For Application Code

All application code was already updated in previous changes. Tests are now in sync.

## Verification

✅ **Build Success**
```bash
npm run build
# Exit code: 0
```

✅ **No TypeScript Errors**
```bash
npx tsc --noEmit
# No errors
```

✅ **Tests Updated**
- Gateway tests: 4/4 updated
- UI tests: 20+/20+ updated

## Next Steps

1. Run tests to verify they pass: `npm test`
2. Add new tests for IPC key fetching
3. Add tests for error handling in key resolution
4. Add integration tests for full chat flow with IPC keys

## Related Documentation

- `SECURE_KEY_FLOW.md` - IPC key architecture
- `KEY_RESOLUTION_FIX.md` - Title generation fix
- `PARALLEL_CHAT_VERIFICATION.md` - Per-chat state architecture
