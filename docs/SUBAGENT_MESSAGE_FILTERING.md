# Sub-Agent Message Filtering

**Date:** 2026-02-22  
**Component:** `ui/components/Chat/MessageList.tsx`

## Problem

When the main agent interacts with sub-agents (via `request_agent_input` → `respond_to_sub_agent`), the entire conversation was showing up in the main chat UI. This created noise and confusion for users, as these internal sub-agent exchanges should only appear in the MiniChatCard (mini-chat interface).

### What Was Showing

1. **Synthetic user messages** - Injected by `SubAgentResponseTrigger`:
   - `[Sub-agent question for delegation {id}]...`
   - `[User message in sub-agent chat for delegation {id}]...`

2. **Assistant responses** - Main agent responding to sub-agent with `respond_to_sub_agent` tool

Both of these should only appear in the MiniChatCard, not the main chat.

## Solution

Added client-side filtering in `MessageList.tsx` to hide sub-agent related messages from the main chat UI.

### Implementation

```typescript
// Filter out sub-agent trigger messages from main chat (they appear in MiniChatCard)
const filteredMessages = messages.filter((msg) => {
  // Hide synthetic sub-agent user messages
  if (
    msg.role === "user" &&
    (msg.content.startsWith("[Sub-agent question for delegation ") ||
      msg.content.startsWith("[User message in sub-agent chat for delegation "))
  ) {
    return false;
  }
  // Hide assistant responses that use respond_to_sub_agent (sub-agent interactions)
  if (
    msg.role === "assistant" &&
    msg.toolCalls &&
    msg.toolCalls.some((tc) => tc.toolName === "respond_to_sub_agent")
  ) {
    return false;
  }
  return true;
});
```

### What Gets Filtered

#### User Messages (Synthetic)
❌ `[Sub-agent question for delegation abc-123]...`  
❌ `[User message in sub-agent chat for delegation abc-123]...`

#### Assistant Messages
❌ Messages with `respond_to_sub_agent` tool calls

### What Remains Visible

✅ Real user messages  
✅ Assistant messages without sub-agent interactions  
✅ Delegation cards (visual representation of sub-agent tasks)  
✅ All other tool calls and content

## How It Works

### Flow

1. **Sub-agent asks question** → `SubAgentResponseTrigger` injects synthetic user message
2. **Main agent responds** → Uses `respond_to_sub_agent` tool
3. **MessageList receives messages** → Filters out both synthetic message and response
4. **Main chat shows** → Only user-initiated messages and non-sub-agent responses
5. **MiniChatCard shows** → Full sub-agent conversation (separate broadcast channel)

### Two Display Paths

| Location | Shows |
|----------|-------|
| **Main Chat** (MessageList) | User messages + Main agent responses (filtered) |
| **Mini-Chat** (MiniChatCard) | Full sub-agent conversation (unfiltered) |

## Benefits

1. **Cleaner main chat** - No synthetic/internal messages cluttering the UI
2. **Clear separation** - Sub-agent conversations stay in MiniChatCard
3. **Better UX** - Users see only their actual conversation with the main agent
4. **Proper context** - Sub-agent interactions visible where they're relevant

## Technical Details

### Server-Side (Already Existed)
- `historyMapper.ts` - Filters synthetic messages when hydrating chat history
- `useAgent.ts` - Filters `isSubAgentTrigger` chunks for delegation chats only

### Client-Side (New)
- `MessageList.tsx` - Runtime filtering for display
- Applied to `messages` array before rendering
- Also updates auto-scroll logic to use `filteredMessages`

## Testing

To verify filtering works:

1. Delegate a task to a sub-agent that will ask questions
2. Sub-agent uses `request_agent_input`
3. Main agent responds with `respond_to_sub_agent`
4. **Main chat:** Should NOT show synthetic messages or responses
5. **MiniChatCard:** Should show full conversation

### Console Verification

Sub-agent trigger responses log:
```
[SubAgentResponseTrigger] Triggering main agent for chat {chatId}
```

Messages should be filtered before display.

## Edge Cases Handled

### Multi-tool Messages
If an assistant message has BOTH `respond_to_sub_agent` AND other tools, the entire message is hidden. This is intentional - responses to sub-agents should not appear in main chat even if they do other things.

### Streaming Messages
Filtering applies to both complete and streaming messages. Uses `filteredMessages` in all rendering and scroll logic.

### History Hydration
When reloading chat history, `historyMapper.ts` filters synthetic messages at hydration time, and `MessageList` provides runtime filtering as backup.

## Related Files

- `ui/components/Chat/MessageList.tsx` - Main chat display filtering (this implementation)
- `ui/utils/historyMapper.ts` - History hydration filtering
- `ui/hooks/useAgent.ts` - Stream chunk filtering for delegation chats
- `src/gateway/services/SubAgentResponseTrigger.ts` - Synthetic message injection
- `ui/components/Chat/MiniChatCard.tsx` - Sub-agent conversation display (unfiltered)

## Future Improvements

Consider:
- Add metadata flag `isSubAgentTrigger` to messages instead of content prefix matching
- Filter at storage level instead of display level (cleaner architecture)
- Add setting to toggle sub-agent message visibility for debugging
