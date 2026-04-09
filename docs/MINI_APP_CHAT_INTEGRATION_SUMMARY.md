# Mini-App Chat Integration - Summary

## Question
Can mini-apps have a button that opens chat?

## Answer
**Yes!** As of 2026-03-31, mini-apps can now open chat via `window.paprAPI.invoke('chat.open', {})`.

## Quick Usage

```typescript
// Simple button in a mini-app
<button onClick={async () => {
  await window.paprAPI.invoke('chat.open', {});
}}>
  💬 Ask Agent
</button>
```

## What Was Implemented

1. **Electron Main Process** - Added `chat.open` handler to system invoke whitelist
2. **Preload Script** - Forwards `chat:open` IPC events to renderer as DOM events
3. **React Renderer** - Listens for DOM events and creates new chat tabs
4. **System Prompt** - Updated with usage examples and best practices

## How It Works

```
Mini-App (iframe)
  ↓ window.paprAPI.invoke('chat.open', {})
MiniAppView.tsx
  ↓ postMessage to parent
Main Process (Electron)
  ↓ IPC: chat:open
Preload Script
  ↓ DOM Event: papr-chat-open
App.tsx
  ↓ createChat + createTab
New Chat Tab Opens ✅
```

## Real-World Examples

### Dashboard Quick Actions
```typescript
<div className="dashboard-header">
  <h1>Dashboard</h1>
  <button onClick={() => window.paprAPI.invoke('chat.open', {})}>
    Ask Agent
  </button>
</div>
```

### Error State Help
```typescript
{error && (
  <div className="error-banner">
    <p>{error.message}</p>
    <button onClick={() => window.paprAPI.invoke('chat.open', {})}>
      Get Help
    </button>
  </div>
)}
```

### Data Analysis Launcher
```typescript
<button onClick={() => window.paprAPI.invoke('chat.open', {})}>
  📊 Analyze with AI
</button>
```

## Current Limitations

1. **No pre-filled messages** - The `message` option is accepted but not yet implemented
2. **No model selection** - Always uses user's default model/provider
3. **No callback** - Can't detect when chat is closed or message sent

## Testing

A test file is available at `/test-chat-integration.html`. To test:

1. Start the app: `npm start`
2. Create a test mini-app using the agent with the HTML content from the test file
3. Click the test buttons to verify functionality

## Files Changed

- `src/electron/index.cjs` - Added `chat.open` handler
- `src/electron/preload.cjs` - Added IPC→DOM forwarder
- `ui/App.tsx` - Added event listener
- `src/core/agents/SystemPrompt.ts` - Added documentation
- `docs/MINI_APP_CHAT_INTEGRATION.md` - Complete technical docs
- `CLAUDE.md` - Enhancement 29 entry

## Future Enhancements

### 1. Pre-filled Messages
```typescript
await window.paprAPI.invoke('chat.open', {
  message: 'Analyze sales data from Q4 2025'
});
```

### 2. Model/Provider Selection
```typescript
await window.paprAPI.invoke('chat.open', {
  model: 'gpt-5.4',
  provider: 'openai'
});
```

### 3. Callback Support
```typescript
const result = await window.paprAPI.invoke('chat.open', {
  message: 'Generate report',
  waitForResponse: true
});
console.log(result.response);
```

## Impact

- **Before**: Mini-apps were isolated, couldn't trigger agent workflows
- **After**: Mini-apps can seamlessly launch chat sessions
- **User Experience**: Agent features more discoverable and integrated
- **Use Cases**: Dashboard actions, help links, quick launchers, workflow triggers
