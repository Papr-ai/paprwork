# Draft Message Persistence

**Date:** 2026-02-19  
**Status:** ✅ Implemented

## Problem

When typing a message in the chat input and switching to another tab (or another chat), the typed text would disappear when returning to the original chat. This resulted in lost work and poor user experience.

## Solution

Implemented per-chat draft message persistence using the Zustand chat store. Each chat now maintains its own draft message that persists across tab switches.

## Implementation Details

### 1. Type Changes

Added `draftMessage` field to `ChatState` in `ui/types/chat.ts`:

```typescript
export interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  isSending: boolean;
  isStreaming: boolean;
  hasUnread: boolean;
  draftMessage?: string; // Persisted draft message for this chat
}
```

### 2. Store Changes

Added three new actions to `chatStore` in `ui/stores/chatStore.ts`:

```typescript
interface ChatStore {
  // ... existing actions ...
  
  // Draft message management
  setDraftMessage: (chatId: string, draft: string) => void;
  getDraftMessage: (chatId: string) => string;
  clearDraftMessage: (chatId: string) => void;
}
```

**Implementation:**
- `setDraftMessage`: Updates the draft message for a specific chat
- `getDraftMessage`: Retrieves the draft message (returns empty string if none)
- `clearDraftMessage`: Clears the draft message after sending

### 3. Component Changes

#### InputBar Component (`ui/components/Chat/InputBar.tsx`)

**Added:**
- `chatId` prop (required) to identify which chat's draft to persist
- Store integration via `useChatStore` hooks
- Effect to sync local state with store when `chatId` changes
- Effect to auto-save draft to store on every message change
- Clear draft from store when message is sent

**Key Changes:**
```typescript
// Get draft message from store
const draftMessage = useChatStore((state) => state.getDraftMessage(chatId));
const setDraftMessage = useChatStore((state) => state.setDraftMessage);
const clearDraftMessage = useChatStore((state) => state.clearDraftMessage);

// Initialize with draft from store
const [message, setMessage] = useState(draftMessage);

// Sync when chatId changes
useEffect(() => {
  const draft = useChatStore.getState().getDraftMessage(chatId);
  setMessage(draft);
}, [chatId]);

// Auto-save to store
useEffect(() => {
  setDraftMessage(chatId, message);
}, [message, chatId, setDraftMessage]);

// Clear on send
const handleSend = () => {
  // ... existing code ...
  clearDraftMessage(chatId);
};
```

#### ChatContainer Component (`ui/components/Chat/ChatContainer.tsx`)

**Changed:**
- Pass `chatId` prop to `InputBar` component

```typescript
<InputBar
  ref={inputBarRef}
  chatId={chatId}  // <- Added
  onSend={handleSendMessage}
  // ... other props ...
/>
```

### 4. Tests

Added comprehensive test suite in `ui/__tests__/components/ChatContainer.test.tsx`:

**New Test Suite: "Draft Message Persistence"**
- ✅ Should persist draft message when switching between chats
- ✅ Should clear draft message after sending

All 23 tests pass (21 existing + 2 new).

## Behavior

### Before
1. User types "Hello world" in Chat A
2. User switches to Chat B
3. User returns to Chat A
4. **Input is empty** ❌

### After
1. User types "Hello world" in Chat A
2. User switches to Chat B
3. User returns to Chat A
4. **Input shows "Hello world"** ✅

### Edge Cases Handled
- ✅ Draft persists when switching tabs
- ✅ Draft persists when navigating away and back
- ✅ Draft clears when message is sent
- ✅ Each chat has its own independent draft
- ✅ Empty drafts don't cause issues

## Performance Considerations

- **Minimal overhead**: Draft is stored in memory (Zustand store)
- **No network calls**: All operations are local
- **Efficient updates**: Only the affected chat state is updated
- **No unnecessary re-renders**: Uses Zustand's selector optimization

## Future Enhancements (Optional)

1. **LocalStorage Persistence**: Save drafts to localStorage for persistence across app restarts
2. **Draft Indicators**: Show visual indicator when a chat has a draft
3. **Draft Timestamps**: Track when drafts were last modified
4. **Context Artifacts**: Persist selected context artifacts with drafts
5. **Auto-save Notifications**: Show subtle toast when draft is auto-saved

## Files Changed

1. `ui/types/chat.ts` - Added `draftMessage` to `ChatState`
2. `ui/stores/chatStore.ts` - Added draft message actions
3. `ui/components/Chat/InputBar.tsx` - Integrated store for draft persistence
4. `ui/components/Chat/ChatContainer.tsx` - Pass `chatId` to InputBar
5. `ui/__tests__/components/ChatContainer.test.tsx` - Added test coverage

## Testing

Run tests:
```bash
npm test -- ChatContainer.test.tsx
```

All tests pass ✅ (23/23)

## Migration

No migration needed. Existing chats automatically get empty draft messages, which is the expected default behavior.
