# Chat List Auto-Update Fix

**Date:** 2026-03-12  
**Issue:** Chat history sidebar not updating automatically after title generation  
**Status:** ✅ FIXED

---

## Problem

The chat list in the sidebar only updated when the app was closed and reopened. When a new chat was created and its title was generated, the sidebar still showed "New Chat" until the user manually reloaded.

### Root Cause

After title generation or manual title updates, the Gateway was updating the database but not broadcasting a notification to the UI that the chat list had changed. The UI had no way to know it should reload the chat list.

---

## Solution

Implemented a WebSocket broadcast system to notify the UI of chat list updates:

### 1. Added Broadcast After Title Updates

**File:** `src/gateway/services/AgentService.ts`

```typescript
async generateChatTitle(chatId: string, firstMessage: string): Promise<string> {
  // ... generate title logic ...
  await this.storageManager.updateChat(chatId, { title });
  
  // ✅ NEW: Broadcast chat list update
  const { broadcast } = await import("../websocket/index.js");
  broadcast({ type: "chat:list-updated" });
  
  return title;
}

async updateChatTitle(chatId: string, title: string): Promise<void> {
  await this.storageManager.updateChat(chatId, { title });
  
  // ✅ NEW: Broadcast chat list update
  const { broadcast } = await import("../websocket/index.js");
  broadcast({ type: "chat:list-updated" });
}
```

### 2. Added Listener in UI Hook

**File:** `ui/hooks/useChat.ts`

```typescript
// Listen for chat list updates broadcast from Gateway
useEffect(() => {
  const handleBroadcast = (event: Event) => {
    const customEvent = event as CustomEvent;
    if (customEvent.detail?.type === "chat:list-updated") {
      console.log("[useChat] Received chat list update broadcast, reloading...");
      loadChats(true); // Force reload
    }
  };

  window.addEventListener("gateway-broadcast", handleBroadcast);
  return () => {
    window.removeEventListener("gateway-broadcast", handleBroadcast);
  };
}, [loadChats]);
```

---

## How It Works

### Broadcast Flow

```
Gateway                           UI
   |                              |
   | 1. Title generated/updated   |
   | 2. Update database          |
   | 3. broadcast({ type: "chat:list-updated" })
   |----------------------------->|
   |                              | 4. Receive broadcast event
   |                              | 5. loadChats(true)
   |                              | 6. Re-fetch chat list
   |<-----------------------------|
   | 7. Return updated list       |
   |----------------------------->|
   |                              | 8. UI updates sidebar
```

### Gateway Broadcast System

The Gateway already had a broadcast mechanism in `src/gateway/websocket/index.ts`:

```typescript
export function broadcast(message: { type: string; data?: unknown }): void {
  if (!wssInstance) {
    console.warn("[WebSocket] Cannot broadcast - server not initialized");
    return;
  }

  const payload = JSON.stringify(message);
  wssInstance.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  });
}
```

The UI Gateway client already handled broadcasts:

```typescript
// In ui/src/lib/gateway.ts
this.ws.onmessage = (event) => {
  const response: GatewayResponse = JSON.parse(event.data);

  // Handle broadcast messages (no matching ID)
  if (!response.id && response.type) {
    window.dispatchEvent(
      new CustomEvent("gateway-broadcast", {
        detail: response,
      }),
    );
    return;
  }
  // ... handle regular responses ...
};
```

We just needed to:
1. Call `broadcast()` when titles change
2. Listen for the broadcast in `useChat`

---

## Testing

### Manual Test

1. Create a new chat
2. Send first message
3. Title generates in background
4. **✅ Sidebar updates automatically** (no reload needed)

### What Gets Broadcast

- `agent:generate-title` → updates chat title → broadcasts `chat:list-updated`
- `chat:update` → manual title edit → broadcasts `chat:list-updated`

---

## Related Broadcasts

Other parts of the system already use broadcasts for real-time updates:

- `app:list-updated` - App list changes
- `jobs:list-updated` - Jobs list changes
- `subagent:status` - Sub-agent status updates
- `bash:output` - Bash tool output

This fix brings chat list updates into alignment with the rest of the system.

---

## Performance Considerations

### Efficiency

- Broadcast is lightweight (just a notification, no data)
- UI only reloads when actually needed
- Uses existing WebSocket connection (no new connections)
- `loadChats(true)` forces cache refresh

### No Polling Required

Without broadcasts, we'd need to poll every N seconds:

```typescript
// ❌ BAD: Wasteful polling
setInterval(() => loadChats(true), 5000); // Check every 5s
```

With broadcasts:

```typescript
// ✅ GOOD: Only reload when changed
broadcast({ type: "chat:list-updated" }); // Instant, on-demand
```

---

## Future Enhancements

### Incremental Updates

Instead of reloading entire chat list, we could send the updated chat:

```typescript
// Future: Send just the changed chat
broadcast({ 
  type: "chat:updated",
  data: { chatId, title, updatedAt }
});
```

UI could then update just that one chat in the list without refetching everything.

### Optimistic Updates

UI could show title immediately (optimistically) then sync with server:

```typescript
// Show title immediately
updateLocalChatTitle(chatId, title);

// Sync with server in background
gateway.send("chat:update", { chatId, title });
```

---

## Files Changed

- ✅ `src/gateway/services/AgentService.ts` - Added broadcast calls
- ✅ `ui/hooks/useChat.ts` - Added broadcast listener
- ✅ `docs/CHAT_LIST_AUTO_UPDATE_FIX.md` - This documentation

---

## Related Issues

This fix resolves both:
1. Chat history not updating automatically
2. Title generation not reflecting in sidebar

Both stemmed from the same root cause: missing broadcast notifications.
