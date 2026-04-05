# Mini-App Chat Integration

**Added:** 2026-03-31

## Overview

Mini-apps can now programmatically open new chat tabs via `window.paprAPI.invoke('chat.open', ...)`. This enables "Ask Agent" buttons, context-aware help links, and quick action launchers directly from dashboard apps.

## Implementation

### 1. Electron Main Process (`src/electron/index.cjs`)

Added `chat.open` to the system invoke whitelist:

```javascript
const ALLOWED_APIS = {
  // ... existing APIs ...
  
  'chat.open': async (options) => {
    // Send message to renderer to open a new chat tab
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:open', {
        message: options?.message || '',
        model: options?.model || null,
        provider: options?.provider || null,
      });
      return { success: true };
    }
    throw new Error('Main window not available');
  },
};
```

### 2. Preload Script (`src/electron/preload.cjs`)

Forward `chat:open` IPC event to renderer as DOM event:

```javascript
// Initialize chat IPC listener (forward to DOM event)
console.log("[Preload] Initializing chat listener");
ipcRenderer.on("chat:open", (_event, data) => {
  window.dispatchEvent(new CustomEvent('papr-chat-open', { detail: data }));
});
```

### 3. Renderer (`ui/App.tsx`)

Listen for DOM event and create new chat tab:

```typescript
// Listen for chat:open requests from mini-apps
useEffect(() => {
  const handleChatOpen = (event: CustomEvent) => {
    console.log('[App] Received chat:open request from mini-app');
    
    // Create new chat (pre-filled message not yet supported)
    createChat().then(chatId => {
      if (chatId) {
        createTab('chat', chatId, 'New Chat');
      }
    });
  };

  window.addEventListener('papr-chat-open', handleChatOpen as EventListener);
  return () => window.removeEventListener('papr-chat-open', handleChatOpen as EventListener);
}, [createChat, createTab]);
```

## Usage

### Basic Example

```typescript
// app.ts - Simple "Ask Agent" button
<button onClick={async () => {
  await window.paprAPI.invoke('chat.open', {});
}}>
  Ask Agent
</button>
```

### With Options (Future Enhancement)

```typescript
// Future: Pre-fill message, specify model
await window.paprAPI.invoke('chat.open', {
  message: 'Analyze this data', // Not yet supported
  model: 'gpt-5.2',              // Not yet supported
  provider: 'openai'             // Not yet supported
});
```

### Real-World Examples

```typescript
// Dashboard with quick actions
<div className="dashboard-actions">
  <button onClick={() => window.paprAPI.invoke('chat.open', {})}>
    💬 Ask Agent
  </button>
</div>

// Error state with context-aware help
{error && (
  <div className="error-banner">
    <p>{error.message}</p>
    <button onClick={() => window.paprAPI.invoke('chat.open', {})}>
      Get Help from Agent
    </button>
  </div>
)}

// Data analysis launcher
<button onClick={() => window.paprAPI.invoke('chat.open', {})}>
  📊 Analyze with AI
</button>
```

## User Experience

### Flow

1. User clicks "Ask Agent" button in mini-app
2. Mini-app calls `window.paprAPI.invoke('chat.open', {})`
3. Electron forwards request to renderer via IPC
4. Renderer creates new chat tab
5. New chat tab opens and becomes active
6. User can immediately start typing

### Benefits

- **Seamless Integration**: Mini-apps can launch agent workflows without leaving the app
- **Contextual Help**: Apps can provide AI assistance for specific tasks
- **Discoverability**: Makes agent features more visible to users
- **Progressive Enhancement**: Works alongside existing chat UI

## Current Limitations

1. **No pre-filled messages**: The `message` option is accepted but not yet implemented
2. **No model/provider selection**: Always uses user's default model
3. **No callback**: Can't detect when chat is closed or message sent

## Future Enhancements

### 1. Pre-filled Messages

Requires changes to `useChat` hook and chat initialization:

```typescript
// Goal: Open chat with pre-filled message ready to send
await window.paprAPI.invoke('chat.open', {
  message: 'Analyze sales data from Q4 2025'
});
```

**Implementation:**
- Pass message through IPC event
- Store in temporary state (sessionStorage or React state)
- ChatInput reads from temp state on mount
- Clear temp state after reading

### 2. Model/Provider Selection

Allow apps to request specific models:

```typescript
await window.paprAPI.invoke('chat.open', {
  model: 'gpt-5.4',
  provider: 'openai'
});
```

**Implementation:**
- Pass model/provider through IPC
- Store in chat session metadata
- Override model selector default

### 3. Callback Support

Notify mini-app when chat completes:

```typescript
const result = await window.paprAPI.invoke('chat.open', {
  message: 'Generate report',
  waitForResponse: true
});
console.log('Agent response:', result.response);
```

**Implementation:**
- Assign unique request ID
- Track request in global state
- Return response via postMessage to iframe
- Timeout after 5 minutes

### 4. Chat Templates

Pre-defined chat workflows:

```typescript
await window.paprAPI.invoke('chat.open', {
  template: 'data-analysis',
  context: { tableName: 'users', filters: {...} }
});
```

## Architecture

### Message Flow

```
Mini-App (iframe)
  ↓ postMessage
MiniAppView.tsx (renderer)
  ↓ electronAPI.system.invoke
Preload Script
  ↓ IPC: system:invoke
Main Process (Electron)
  ↓ IPC: chat:open
Preload Script
  ↓ DOM Event: papr-chat-open
App.tsx (renderer)
  ↓ createChat + createTab
New Chat Tab Opens
```

### Security

- **Sandboxed**: Mini-apps run in sandboxed iframes, can't access IPC directly
- **Whitelisted**: Only `chat.open` is exposed, not arbitrary chat manipulation
- **Validated**: Main process validates all options before processing
- **Same-origin**: Mini-apps can't open external URLs in chat

## Testing

### Manual Test

1. Create a mini-app with "Ask Agent" button:

```typescript
// test-app/app.ts
const btn = document.createElement('button');
btn.textContent = 'Ask Agent';
btn.onclick = async () => {
  await window.paprAPI.invoke('chat.open', {});
};
document.body.appendChild(btn);
```

2. Open the mini-app
3. Click the button
4. Verify new chat tab opens

### Edge Cases

- **Multiple clicks**: Should open multiple chat tabs
- **Window closed**: Should gracefully fail if main window destroyed
- **Invalid options**: Should ignore unknown options
- **Rapid clicks**: Should handle debouncing (current behavior: opens multiple tabs)

## Related Files

- `src/electron/index.cjs` - Main process handler
- `src/electron/preload.cjs` - IPC forwarder
- `ui/App.tsx` - Chat creation logic
- `ui/components/Apps/MiniAppView.tsx` - paprAPI injection
- `src/core/agents/SystemPrompt.ts` - Agent documentation

## Impact

**Before:** Mini-apps were isolated, couldn't trigger agent workflows

**After:** Mini-apps can seamlessly launch chat sessions, making agent features more discoverable and integrated

**Use Cases:**
- Dashboard "Ask Agent" buttons
- Error state help links
- Quick action launchers
- Context-aware AI assistance
- Workflow triggers from data views
