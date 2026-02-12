# Phase 2: Gateway Integration - Implementation Plan

## Overview
Implement proper chat management with parallel streaming, title generation, tab status indicators, and persistence.

---

## Architecture (Based on V1 Analysis)

### Backend (Gateway)
```
chatSessions Map: chatId -> {
  agent: MastraAgent,
  abortController: AbortController,
  history: Message[]
}

For each chat:
- Separate Mastra agent instance
- Independent abort control
- Own conversation history
```

### Frontend (UI)
```
chatState Map: chatId -> {
  container: HTMLElement,        // #chat-messages-{chatId}
  streamingState: {
    thinkingCard: HTMLElement,
    textElement: HTMLElement,
    actioningCard: HTMLElement,
    messageData: Object
  },
  status: 'idle' | 'streaming' | 'unread'
}

tabRegistry Map: tabId -> {
  chatId: string,
  title: string,
  status: 'idle' | 'streaming' | 'unread',
  isActive: boolean
}
```

---

## Implementation Tasks

### ✅ Task 1: Storage Infrastructure (COMPLETE)
- [x] LocalStorageProvider
- [x] PaprMemoryProvider
- [x] HybridStorageProvider
- [x] ChatExporter

### 🚧 Task 2: Gateway - StorageManager
**File**: `src/gateway/services/StorageManager.ts`

**Responsibilities**:
- Initialize storage provider based on settings (Local/PAPR/Hybrid)
- Expose storage operations to AgentService
- Handle storage mode switching

**Interface**:
```typescript
class StorageManager {
  private provider: IStorageProvider;
  
  async initialize(mode: 'local' | 'papr' | 'hybrid', config: Config): Promise<void>
  async saveMessage(chatId: string, message: StoredMessage): Promise<void>
  async loadMessages(chatId: string): Promise<StoredMessage[]>
  async createChat(chatId: string, title?: string): Promise<void>
  async updateChatTitle(chatId: string, title: string): Promise<void>
  async getChatStats(chatId: string): Promise<ChatStats>
  // ... more methods
}
```

### 🚧 Task 3: Gateway - ChatSessionManager
**File**: `src/gateway/services/ChatSessionManager.ts`

**Responsibilities**:
- Manage parallel chat sessions (like V1's `chatSessions` Map)
- Create/retrieve Mastra agents per chat
- Handle abort controllers per chat
- Load conversation history

**Interface**:
```typescript
interface ChatSession {
  chatId: string;
  agent: Agent;
  abortController: AbortController;
  history: Message[];
  isStreaming: boolean;
}

class ChatSessionManager {
  private sessions: Map<string, ChatSession>;
  
  async getSession(chatId: string, model: string): Promise<ChatSession>
  async abortSession(chatId: string): Promise<void>
  async clearSession(chatId: string): Promise<void>
  getAllActiveSessions(): ChatSession[]
}
```

### 🚧 Task 4: Gateway - Update AgentService
**File**: `src/gateway/services/AgentService.ts`

**Changes**:
1. Add `chatId` parameter to all methods
2. Use `ChatSessionManager` instead of single agent
3. Save messages via `StorageManager`
4. Include `chatId` in all SSE events

**Streaming Flow**:
```typescript
async *streamAgent(chatId: string, userMessage: string, config: AgentConfig) {
  // 1. Get or create session
  const session = await this.sessionManager.getSession(chatId, config.model);
  
  // 2. Save user message
  await this.storageManager.saveMessage(chatId, {
    role: 'user',
    message: userMessage,
    // ...
  });
  
  // 3. Load history for context
  const history = await this.storageManager.loadMessages(chatId);
  
  // 4. Stream with chatId in events
  for await (const chunk of session.agent.stream(userMessage, history)) {
    yield { chatId, ...chunk };
  }
  
  // 5. Save assistant message
  await this.storageManager.saveMessage(chatId, assistantMessage);
  
  // 6. Export to ~/Papr/
  await this.chatExporter.exportChat(chatId, title, allMessages);
}
```

### 🚧 Task 5: Gateway - Title Generation Service
**File**: `src/gateway/services/TitleGenerationService.ts`

**Responsibilities**:
- Generate chat titles using gpt-5-mini-2025-08-07
- Fallback to truncated first message
- Called after first user message

**Implementation** (from V1):
```typescript
class TitleGenerationService {
  private openai: OpenAI;
  
  async generateTitle(firstMessage: string): Promise<string> {
    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-5-mini-2025-08-07', // Fast and cheap
        messages: [
          {
            role: 'system',
            content: `Generate a concise title that summarizes the user's message. Rules:
- Maximum 40 characters
- No quotes, colons, or prefixes like "Here is" or "Title:"
- Just return the title directly
- Make it descriptive and clear
- Use title case`
          },
          { role: 'user', content: firstMessage }
        ],
        max_tokens: 20,
        temperature: 0.7
      });
      
      return completion.choices[0].message.content?.trim() || this.fallbackTitle(firstMessage);
    } catch (error) {
      return this.fallbackTitle(firstMessage);
    }
  }
  
  private fallbackTitle(message: string): string {
    return message.length > 40 
      ? message.substring(0, 40) + '...'
      : message;
  }
}
```

### 🚧 Task 6: IPC - Add Chat Management Endpoints
**File**: `src/electron/main.ts`

**New IPC Handlers**:
```typescript
// Chat operations
ipcMain.handle('chat:create', async (event, { title }) => { ... });
ipcMain.handle('chat:list', async () => { ... });
ipcMain.handle('chat:get', async (event, { chatId }) => { ... });
ipcMain.handle('chat:delete', async (event, { chatId }) => { ... });
ipcMain.handle('chat:updateTitle', async (event, { chatId, title }) => { ... });
ipcMain.handle('chat:generateTitle', async (event, { message }) => { ... });

// Message operations
ipcMain.handle('chat:messages:get', async (event, { chatId }) => { ... });
ipcMain.handle('chat:messages:save', async (event, { chatId, message }) => { ... });

// Streaming (modified to include chatId)
ipcMain.handle('agent:stream', async (event, { chatId, message, config }) => { ... });
ipcMain.handle('agent:stop', async (event, { chatId }) => { ... });
```

### 🚧 Task 7: IPC - Update Preload
**File**: `src/electron/preload.ts`

**Expose**:
```typescript
const electronAPI = {
  chat: {
    create: (title: string) => ipcRenderer.invoke('chat:create', { title }),
    list: () => ipcRenderer.invoke('chat:list'),
    get: (chatId: string) => ipcRenderer.invoke('chat:get', { chatId }),
    delete: (chatId: string) => ipcRenderer.invoke('chat:delete', { chatId }),
    updateTitle: (chatId: string, title: string) => 
      ipcRenderer.invoke('chat:updateTitle', { chatId, title }),
    generateTitle: (message: string) => 
      ipcRenderer.invoke('chat:generateTitle', { message }),
    
    messages: {
      get: (chatId: string) => ipcRenderer.invoke('chat:messages:get', { chatId }),
      save: (chatId: string, message: any) => 
        ipcRenderer.invoke('chat:messages:save', { chatId, message }),
    },
    
    // SSE event listeners (with chatId)
    onStreamChunk: (callback: (data: { chatId: string, chunk: any }) => void) =>
      ipcRenderer.on('agent:stream:chunk', (_, data) => callback(data)),
    onStreamComplete: (callback: (data: { chatId: string }) => void) =>
      ipcRenderer.on('agent:stream:complete', (_, data) => callback(data)),
    onStreamError: (callback: (data: { chatId: string, error: any }) => void) =>
      ipcRenderer.on('agent:stream:error', (_, data) => callback(data)),
  },
  
  agent: {
    stream: (chatId: string, message: string, config: any) =>
      ipcRenderer.invoke('agent:stream', { chatId, message, config }),
    stop: (chatId: string) => ipcRenderer.invoke('agent:stop', { chatId }),
  }
};
```

### 🚧 Task 8: UI - Create Chat Store (Zustand)
**File**: `ui/store/useChatStore.ts`

**State**:
```typescript
interface ChatState {
  // Chat registry
  chats: Map<string, {
    id: string;
    title: string;
    createdAt: string;
    messageCount: number;
  }>;
  
  // Active chat per pane
  activeChatId: string | null;
  
  // Chat streaming states (like V1's chatStreamingState)
  streamingStates: Map<string, {
    isStreaming: boolean;
    status: 'idle' | 'streaming' | 'unread';
    container: HTMLElement | null;
    currentMessage: string;
  }>;
  
  // Actions
  createChat: (title?: string) => Promise<string>;
  loadChat: (chatId: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  updateChatTitle: (chatId: string, title: string) => Promise<void>;
  generateChatTitle: (chatId: string, message: string) => Promise<void>;
  
  // Streaming state
  setStreamingStatus: (chatId: string, status: 'streaming' | 'unread' | 'idle') => void;
  markChatAsRead: (chatId: string) => void;
}
```

### 🚧 Task 9: UI - Tab Status Indicators (CSS)
**File**: `ui/components/Tabs/TabBar.css`

**Add** (from V1):
```css
/* Tab status indicators - blue dot for streaming, green dot for unread */
.tab.tab-streaming,
.tab.tab-unread {
  position: relative;
}

.tab.tab-streaming::before,
.tab.tab-unread::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 8px;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

/* Blue pulsing dot for actively streaming */
.tab.tab-streaming::before {
  background-color: #3B82F6; /* Blue */
  animation: pulse-streaming 1.5s ease-in-out infinite;
}

/* Green static dot for unread (finished streaming) */
.tab.tab-unread::before {
  background-color: #10B981; /* Green */
}

@keyframes pulse-streaming {
  0%, 100% {
    opacity: 1;
    transform: translateY(-50%) scale(1);
  }
  50% {
    opacity: 0.5;
    transform: translateY(-50%) scale(1.2);
  }
}
```

### 🚧 Task 10: UI - Update ChatContainer
**File**: `ui/components/Chat/ChatContainer.tsx`

**Changes**:
1. Add `chatId` prop or get from store
2. Listen to streaming events with `chatId`
3. Update tab status on stream start/end
4. Call title generation after first message
5. Route events to correct chat state

**Key Functions**:
```typescript
// On send message (first time in temp chat)
const handleSendMessage = async (message: string) => {
  // If temp chat, create real chat first
  if (chatId.startsWith('temp-')) {
    const realChatId = await chatStore.createChat();
    setChatId(realChatId);
    
    // Generate title async (don't wait)
    chatStore.generateChatTitle(realChatId, message);
  }
  
  // Set streaming status
  chatStore.setStreamingStatus(chatId, 'streaming');
  
  // Start streaming
  await electronAPI.agent.stream(chatId, message, config);
};

// Listen to stream events
useEffect(() => {
  const handleStreamChunk = ({ chatId: eventChatId, chunk }: any) => {
    if (eventChatId === chatId) {
      // Handle chunk for this chat only
    }
  };
  
  const handleStreamComplete = ({ chatId: eventChatId }: any) => {
    if (eventChatId === chatId) {
      // If this tab is active, clear status
      if (isActiveTab) {
        chatStore.setStreamingStatus(chatId, 'idle');
      } else {
        // Mark as unread
        chatStore.setStreamingStatus(chatId, 'unread');
      }
    }
  };
  
  electronAPI.chat.onStreamChunk(handleStreamChunk);
  electronAPI.chat.onStreamComplete(handleStreamComplete);
  
  return () => {
    // Cleanup listeners
  };
}, [chatId, isActiveTab]);
```

### 🚧 Task 11: UI - Update Tab Component
**File**: `ui/components/Tabs/Tab.tsx`

**Changes**:
1. Get status from chat store
2. Apply CSS classes based on status
3. Mark as read on tab click

```typescript
const Tab = ({ chatId }: { chatId: string }) => {
  const { streamingStates, markChatAsRead } = useChatStore();
  const status = streamingStates.get(chatId)?.status || 'idle';
  
  const handleClick = () => {
    // Mark as read when switching to this tab
    if (status === 'unread') {
      markChatAsRead(chatId);
    }
    // Switch to chat
  };
  
  return (
    <div 
      className={`tab ${status === 'streaming' ? 'tab-streaming' : ''} ${status === 'unread' ? 'tab-unread' : ''}`}
      onClick={handleClick}
    >
      {/* Tab content */}
    </div>
  );
};
```

---

## Implementation Order

1. ✅ **Storage (Done)** - LocalStorage, PAPR, Hybrid providers
2. **Gateway** - StorageManager → ChatSessionManager → Update AgentService → TitleGeneration
3. **IPC** - Add chat endpoints → Update preload
4. **UI State** - Create Zustand store
5. **UI Components** - Update ChatContainer → Add tab indicators → Test

---

## Testing Plan

### Unit Tests
- StorageManager initialization
- ChatSessionManager session creation
- Title generation (with mock OpenAI)
- Parallel streaming (3+ chats simultaneously)

### Integration Tests
- Create temp chat → send message → migrate to real chat → generate title
- Stream in Chat A → switch to Chat B → start stream → verify both running
- Stream completes in background → verify green dot → switch tab → verify dot clears
- Multiple messages in same chat → verify history loads correctly

### E2E Tests
- Full user flow: new chat → type message → see blue dot → response streams → dot turns green → click tab → dot disappears
- Parallel streaming: 3 tabs streaming at once, switch between them
- Title generation: first message generates title, tab updates

---

## Timeline Estimate

| Task | Effort | Status |
|------|--------|--------|
| StorageManager | 2-3 hours | 🚧 Next |
| ChatSessionManager | 3-4 hours | 📋 Planned |
| Update AgentService | 3-4 hours | 📋 Planned |
| TitleGenerationService | 1-2 hours | 📋 Planned |
| IPC Handlers | 2-3 hours | 📋 Planned |
| Zustand Store | 2-3 hours | 📋 Planned |
| UI Components | 3-4 hours | 📋 Planned |
| CSS/Styling | 1 hour | 📋 Planned |
| Testing | 3-4 hours | 📋 Planned |

**Total: ~20-30 hours** (2-3 days of focused work)

---

## Next Step

Start with **StorageManager** - it's the foundation that everything else builds on.

Ready to begin? 🚀
