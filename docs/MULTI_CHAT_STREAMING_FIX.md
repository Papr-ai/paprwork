# Multi-Chat Streaming Bug Fix

**Date:** 2026-02-16

## The Problem

Users reported seeing multiple separate assistant messages (one for "Thinking", another for "Exploring") instead of a single consolidated assistant message, especially when multiple chats were active simultaneously.

### Root Cause

The `useAgent` hook was using **per-instance refs** instead of **per-chatId refs**:

```typescript
// ❌ OLD: Refs shared across all chats in the same component instance
const streamingMessageIdRef = useRef<string | null>(null);
const streamingContentRef = useRef<string>("");
const streamingReasoningRef = useRef<string>("");
const toolCallsMapRef = useRef<Map<string, any>>(new Map());
```

**What went wrong:**

1. When you send a message to Chat A, `streamingMessageIdRef.current` is set to `"msg-123"`
2. If you then send a message to Chat B while Chat A is still streaming:
   - The hook checks `if (!streamingMessageIdRef.current)` → **FALSE** (it's still `"msg-123"` from Chat A)
   - Chat B creates a **new assistant message** with ID `"msg-456"`
   - `streamingMessageIdRef.current` is now `"msg-456"` (overwrites Chat A's ID!)
3. When Chat A's next chunk arrives (e.g., "tool-call"):
   - The hook checks `if (!streamingMessageIdRef.current)` → **FALSE** (it's `"msg-456"` from Chat B)
   - But `"msg-456"` doesn't exist in Chat A's messages!
   - So it creates **another assistant message** with ID `"msg-789"`
4. Result: Chat A has multiple assistant messages (one for thinking, one for exploring, etc.)

### Why This Happened

The refs were **component-instance-scoped** but needed to be **chatId-scoped**. When multiple chats are active (split view, or rapidly switching tabs), the refs would get confused about which chat owns which streaming message.

## The Solution

Changed all refs from single values to **Maps keyed by chatId**:

```typescript
// ✅ NEW: Refs keyed by chatId for proper isolation
const streamingMessageIdRef = useRef<Map<string, string>>(new Map());
const streamingContentRef = useRef<Map<string, string>>(new Map());
const streamingReasoningRef = useRef<Map<string, string>>(new Map());
const toolCallsMapRef = useRef<Map<string, Map<string, any>>>(new Map());
const updateBatchRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
```

**How it works now:**

1. Chat A message: `streamingMessageIdRef.current.set("chat-a", "msg-123")`
2. Chat B message: `streamingMessageIdRef.current.set("chat-b", "msg-456")`
3. Chat A chunk arrives: `streamingMessageIdRef.current.get("chat-a")` → `"msg-123"` ✅
4. Chat B chunk arrives: `streamingMessageIdRef.current.get("chat-b")` → `"msg-456"` ✅

Each chat maintains its own streaming state completely independently!

## Changes Made

### 1. Ref Initialization (`useAgent.ts`)

```typescript
// Before
const streamingMessageIdRef = useRef<string | null>(null);
const streamingContentRef = useRef<string>("");
const streamingReasoningRef.current = "";
const toolCallsMapRef = useRef<Map<string, any>>(new Map());

// After
const streamingMessageIdRef = useRef<Map<string, string>>(new Map());
const streamingContentRef = useRef<Map<string, string>>(new Map());
const streamingReasoningRef = useRef<Map<string, string>>(new Map());
const toolCallsMapRef = useRef<Map<string, Map<string, any>>>(new Map());
```

### 2. Chunk Handling

All chunk handlers now:
1. Extract `chatId` from the chunk
2. Get/set values using `ref.current.get(chatId)` / `ref.current.set(chatId, value)`
3. Clean up using `ref.current.delete(chatId)` when done

Example for `reasoning-delta`:

```typescript
// Before
streamingReasoningRef.current += text;

// After
const currentReasoning = streamingReasoningRef.current.get(chatId) || "";
streamingReasoningRef.current.set(chatId, currentReasoning + text);
```

### 3. Message Creation

```typescript
// Before
if (!streamingMessageIdRef.current && chunk.type !== "done" && chunk.type !== "error") {
  const messageId = `msg-${Date.now()}`;
  streamingMessageIdRef.current = messageId;
  // ...
}

// After
if (!streamingMessageIdRef.current.has(chatId) && chunk.type !== "done" && chunk.type !== "error") {
  const messageId = `msg-${Date.now()}`;
  streamingMessageIdRef.current.set(chatId, messageId);
  // ...
}
```

### 4. Cleanup on Done/Error

```typescript
// Before
streamingMessageIdRef.current = null;
streamingContentRef.current = "";
streamingReasoningRef.current = "";
toolCallsMapRef.current = new Map();

// After
streamingMessageIdRef.current.delete(chatId);
streamingContentRef.current.delete(chatId);
streamingReasoningRef.current.delete(chatId);
toolCallsMapRef.current.delete(chatId);
```

### 5. Send Message Cleanup

```typescript
// Before (in sendMessage)
streamingMessageIdRef.current = null;
streamingContentRef.current = "";
// ...

// After
streamingMessageIdRef.current.delete(finalChatId);
streamingContentRef.current.delete(finalChatId);
// ...
```

## Benefits

1. **✅ Multiple chats can stream simultaneously** without interfering with each other
2. **✅ Each chat maintains its own streaming state** (thinking, tool calls, content)
3. **✅ No more duplicate assistant messages** when switching between chats
4. **✅ Proper cleanup** when chats are done (no memory leaks)
5. **✅ Better UX** when users have multiple chat tabs open

## Testing

To verify the fix works:

1. Open 2 chat tabs side-by-side (split view)
2. Send a message to Chat A
3. While Chat A is still streaming (thinking/tool calls), send a message to Chat B
4. **Expected:** Both chats should have single, consolidated assistant messages
5. **Previously:** One or both chats would show multiple separate assistant messages

## Related Files

- `/ui/hooks/useAgent.ts` - Main fix location
- `/ui/stores/chatStore.ts` - Per-chat state management
- `/ui/components/Chat/ChatContainer.tsx` - Chat UI component

## Learnings

**Rule:** When dealing with parallel/concurrent operations (like multiple chat streams), **always use Maps keyed by the operation ID** instead of single shared refs or state variables.

**Pattern:**
```typescript
// ❌ BAD: Shared state
const streamingIdRef = useRef<string | null>(null);

// ✅ GOOD: Keyed state
const streamingIdsRef = useRef<Map<string, string>>(new Map());
```

This pattern applies to:
- WebSocket streams (per chatId)
- File uploads (per uploadId)
- Background jobs (per jobId)
- API requests (per requestId)
- Any async operation that can happen in parallel!
