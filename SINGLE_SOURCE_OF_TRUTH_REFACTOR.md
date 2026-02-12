# Single Source of Truth Refactor

## The Problem

V2 had **TWO stores** tracking the same thing:

```typescript
// Problem: Two sources fighting each other
chatStore.activeChat = "temp-1234567890"
tabStore.activeTabId.entityId = "temp-1234567891"  // Different!
```

They were created milliseconds apart and **never synced**, causing:
- "No active tab found: undefined"
- "Tab not found" errors
- Title updates failing
- Messages going to wrong chat

## V1's Simple Approach

**One Source of Truth**: `tabRegistry`

```javascript
// V1: Simple and reliable
const activeTab = document.querySelector('.header-tab.active');
const chatId = activeTab.dataset.chatId;
```

That's it. The tab **IS** the chat.

## The Solution

**Use ONLY `tabStore` as source of truth** (like V1's `tabRegistry`)

### Changes Made

#### 1. Removed `activeChat` from ChatStore
**File**: `ui/stores/chatStore.ts`

```typescript
// BEFORE
interface ChatStore {
  activeChat: string | null;  // ❌ Duplicate tracking
  setActiveChat: (chatId: string) => void;
  // ...
}

// AFTER
interface ChatStore {
  // NOTE: No activeChat! Use tabStore.activeTab.entityId instead
  messages: ChatMessage[];
  chatStates: Map<string, ChatState>;
  // ...
}
```

#### 2. Updated `useChat` to Use TabStore
**File**: `ui/hooks/useChat.ts`

```typescript
// BEFORE
const { activeChat, setActiveChat } = useChatStore();

// AFTER (V1 approach)
const { activeTabId, getTab } = useTabStore();
const activeTab = activeTabId ? getTab(activeTabId) : null;
const activeChat = activeTab?.type === 'chat' ? activeTab.entityId : null;
```

#### 3. Updated `ChatContainer` to Use TabStore
**File**: `ui/components/Chat/ChatContainer.tsx`

```typescript
// BEFORE
const { activeChat } = useChat();
if (!activeChat) return;

// AFTER (V1 approach)
const { activeTabId } = useTabStore();
if (!activeTabId) return;
```

#### 4. Simplified Chat Operations
**File**: `ui/hooks/useChat.ts`

```typescript
// createChat: Just returns temp ID, doesn't set active (tabStore does that)
// switchChat: Calls tabStore.switchToTab (single operation)
// deleteChat: Only deletes from backend (tab closing handled by tabStore)
```

#### 5. Removed Redundant Sync
**File**: `ui/hooks/useAgent.ts`

```typescript
// REMOVED: setActiveChat(newChatId) after creating permanent chat
// tabStore is already updated via updateTabId - that's enough!
```

## The Result

### Single Flow (V1 Style)
```
1. App.tsx creates temp chat and tab
2. createTab() calls switchToTab()
3. switchToTab() sets activeTabId
4. useChat derives activeChat from activeTabId
5. ChatContainer checks activeTabId
6. useAgent uses activeTab.entityId
7. Everything in sync! ✅
```

### Benefits
- ✅ **One source of truth** (tabStore.activeTabId)
- ✅ **No sync issues** (nothing to sync!)
- ✅ **Simpler code** (~100 lines removed)
- ✅ **More reliable** (can't go out of sync)
- ✅ **Matches V1** (proven pattern)

## Files Modified

1. `ui/stores/chatStore.ts` - Removed `activeChat` and `setActiveChat`
2. `ui/hooks/useChat.ts` - Get activeChat from tabStore
3. `ui/components/Chat/ChatContainer.tsx` - Use `activeTabId` from tabStore
4. `ui/hooks/useAgent.ts` - Removed redundant chatStore sync
5. `ui/stores/tabStore.ts` - Added logging for debugging
6. `ui/App.tsx` - Added logging for initialization

## Testing Checklist

**Start the app:**
```bash
npm start
```

**Expected Console Logs:**
```
[App] Initializing... Current tabs: 0
[App] No tabs found, creating initial tab
[App] Created chat: temp-xxx
[TabStore] Created tab: chat-temp-xxx, switching to it...
[TabStore.switchToTab] Called with tabId: chat-temp-xxx
[TabStore.switchToTab] Setting standalone tab as active: chat-temp-xxx
[TabStore.switchToTab] Active tab is now: chat-temp-xxx
[App] Created initial tab: chat-temp-xxx for chat: temp-xxx
[App] Active tab after creation: chat-temp-xxx
```

**Send a message:**
```
[useAgent] activeTab: chat-temp-xxx  ✅ (NOT undefined!)
[useAgent] Available tabs: [{id: 'chat-temp-xxx', entityId: 'temp-xxx'}]
[useAgent] Using tab chat-temp-xxx with entityId: temp-xxx
[useAgent] First message - creating permanent chat before streaming
[useAgent] Created permanent chat: <UUID>
[useAgent] Updated tab: chat-temp-xxx → chat-<UUID>
```

**Visual Checks:**
- ✅ Tab exists and is active on app start
- ✅ Message sends successfully
- ✅ Title generates and updates tab
- ✅ No "undefined" errors in console

---

**Date:** 2026-02-11  
**Status:** ✅ Complete - Single Source of Truth Achieved  
**Result:** V2 now follows V1's proven simple pattern
