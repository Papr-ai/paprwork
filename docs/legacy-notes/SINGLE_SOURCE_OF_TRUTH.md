# Single Source of Truth: The Real Fix

## The Core Problem

**V2 had TWO sources of truth competing with each other:**

1. `chatStore.activeChat` - Created by `useChat().createChat()`
2. `tabStore.activeTab.entityId` - Created when tab is created

These were generating **different temp IDs milliseconds apart**, causing them to be permanently out of sync:

```
chatStore.activeChat = "temp-1770831961988-uok5rmb"  // Created second
tabStore.activeTab =   "chat-temp-1770831961987-qbakkvv"  // Created first (1ms earlier!)
```

**Result:** When trying to update the tab, it couldn't find it because it was looking for the wrong ID.

## Why V1 Was Simple

**V1 had ONE source of truth:** The tab's `dataset.chatId`

```javascript
// V1: Single source of truth
const currentActiveTab = document.querySelector('.header-tab.active');
const currentChatId = currentActiveTab?.dataset.chatId;
```

No competing stores. No sync issues. Just one place to look.

## The V2 Architecture Issue

V2 introduced:
- **Zustand `chatStore`**: Manages chat messages and state
- **Zustand `tabStore`**: Manages tabs (chat, settings, etc.)

Both stores tried to track "what is the active chat?" independently, leading to:
- Race conditions during temp ID generation
- Constant need to "sync" stores
- Complex migration logic
- Fragile state management

## The Fix: Use TabStore as Single Source of Truth

**Principle:** The user interacts with **tabs**, not abstract "chats". The tab is the source of truth.

### Changes Made

#### 1. ChatContainer: Stop Using chatStore.activeChat

**Before:**
```typescript
const { activeChat } = useChat();  // ❌ From chatStore
await sendMessage(activeChat, message, config);  // Pass chat ID
```

**After:**
```typescript
// ✅ Don't use activeChat from chatStore
// sendMessage will get it from tabStore internally
await sendMessage(message, config);  // No chat ID parameter
```

#### 2. useAgent: Get Everything from TabStore

**Before:**
```typescript
async sendMessage(sessionId: string, ...) {
  // sessionId came from chatStore - could be out of sync!
  const chatId = sessionId;
}
```

**After:**
```typescript
async sendMessage(message: string, config: AgentConfig) {
  // Get active tab from tabStore (single source of truth)
  const { activeTab, getTab } = useTabStore.getState();
  const tab = getTab(activeTab);
  
  // Use tab's entityId as the chat ID
  const chatId = tab.entityId;
}
```

#### 3. Keep ChatStore in Sync (One-Way)

ChatStore is updated **after** tabStore, not independently:

```typescript
// 1. Update tabStore (source of truth)
updateTabId(activeTab, `chat-${newChatId}`);

// 2. Sync chatStore to match (one-way)
setActiveChat(newChatId);
```

## The Flow Now (Like V1)

1. **User clicks "New Chat"**
   - Tab created with temp ID
   - Tab becomes active
   - chatStore may or may not have a matching entry (doesn't matter!)

2. **User types message and clicks send**
   - Get `activeTab` from tabStore
   - Get `tab.entityId` (the chat ID)
   - Use that for everything

3. **First message sent**
   - Check if `entityId` starts with "temp-"
   - If yes: Create permanent chat
   - Update tab: `updateTabId(activeTab, chat-${newChatId})`
   - Sync chatStore: `setActiveChat(newChatId)`

4. **Stream and generate title**
   - Use the permanent ID
   - Update tab title

## Key Benefits

### ✅ Simplicity
- One source of truth (like V1)
- No complex sync logic
- No race conditions

### ✅ Reliability
- Tab ID always matches what's displayed
- No "tab not found" errors
- Deterministic behavior

### ✅ Maintainability
- Clear data flow
- Easy to debug
- Matches V1's mental model

## Files Modified

1. **`ui/components/Chat/ChatContainer.tsx`**
   - Removed dependency on `chatStore.activeChat`
   - `sendMessage()` no longer takes chat ID parameter

2. **`ui/hooks/useAgent.ts`**
   - Signature changed from `sendMessage(sessionId, message, config)` to `sendMessage(message, config)`
   - Gets `activeTab` from tabStore internally
   - Uses `tab.entityId` as single source of truth
   - Updates chatStore after tabStore (one-way sync)

---

**Result:** Simple, reliable, maintainable—just like V1, but with V2's architecture.

**Date:** 2026-02-11  
**Status:** ✅ Fixed with single source of truth pattern
