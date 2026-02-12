# System Overview - Paprwork V2

High-level architecture and design philosophy for Paprwork V2.

---

## 🎯 Design Philosophy

### Core Principles

1. **Type Safety First** - 100% TypeScript, zero `any` types
2. **Small, Modular Components** - Max 500 lines per file
3. **Shared Core Library** - Zero duplication between processes
4. **Separation of Concerns** - Clear boundaries between layers
5. **Test Coverage** - 80%+ coverage for critical paths

### Architecture Goals

- **Reliability** - No tool pairing bugs, graceful error handling
- **Performance** - <2s cold start, <1s first response
- **Maintainability** - Easy to understand, modify, and extend
- **Scalability** - Support thousands of messages, multiple agents

---

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Paprwork V2                          │
└─────────────────────────────────────────────────────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │   Renderer   │  │     Main     │  │   Gateway    │
  │   (React)    │  │  (Electron)  │  │ (Sub-agents) │
  └──────────────┘  └──────────────┘  └──────────────┘
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
                             ▼
                    ┌──────────────┐
                    │  Core Library │
                    │  (@core/*)    │
                    └──────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
    ┌─────────┐        ┌─────────┐      ┌─────────┐
    │  Mastra │        │ Storage │      │  Tools  │
    └─────────┘        └─────────┘      └─────────┘
```

---

## 📦 Process Architecture

### Three Main Processes

#### 1. Renderer Process (UI)
- **Technology:** React + TypeScript
- **Purpose:** User interface and interactions
- **Communication:** IPC to Main process
- **State:** Zustand for client-side state
- **Key Files:**
  - `src/renderer/App.tsx` - Root component
  - `src/renderer/components/` - UI components
  - `src/renderer/hooks/` - Custom React hooks

#### 2. Main Process (Electron)
- **Technology:** TypeScript + Electron
- **Purpose:** Application lifecycle, IPC, main agent
- **Communication:**
  - IPC from Renderer
  - WebSocket to Gateway (optional)
- **Key Files:**
  - `src/main/index.ts` - Entry point
  - `src/main/services/` - Business logic
  - `src/main/ipc/` - IPC handlers

#### 3. Gateway Process (Optional)
- **Technology:** TypeScript + WebSocket
- **Purpose:** Sub-agents, jobs, orchestration
- **Communication:** WebSocket from Main
- **Key Files:**
  - `src/gateway/index.ts` - Entry point
  - `src/gateway/server.ts` - WebSocket server
  - `src/gateway/services/` - Sub-agent services

---

## 🔄 Data Flow

### User Message Flow

```
1. User types message
   ↓
2. Renderer → IPC → Main Process
   ↓
3. Main Process → AgentService.streamMessage()
   ↓
4. AgentService → MastraAgent.stream()
   ↓
5. Mastra → Tool Execution (if needed)
   ↓
6. Stream chunks → Main Process → Renderer
   ↓
7. Renderer displays message
```

### Tool Execution Flow

```
1. Agent decides to use tool
   ↓
2. Mastra calls tool.execute()
   ↓
3. Tool runs (bash, read file, etc.)
   ↓
4. Tool returns ToolResult
   ↓
5. Mastra sends tool result to agent
   ↓
6. Agent continues based on result
```

---

## 🔐 Security Model

### IPC Security
- All IPC channels are typed
- Renderer cannot access Node APIs directly
- contextBridge in preload script
- Validate all inputs from renderer

### Tool Execution
- Tools run with user permissions
- Timeout for long-running tools (30s default)
- Validate tool inputs with Zod schemas
- Sanitize bash output for secrets

### API Keys
- Stored encrypted with electron-store
- Never logged or exposed to renderer
- Separate key per provider

---

## 📊 Storage Architecture

### Chat History
- **Format:** JSONL (JSON Lines)
- **Location:** `~/Library/Application Support/paprwork-v2/chats/`
- **Structure:**
  ```
  chats/
    {chatId}.jsonl      # One file per chat
  ```
- **Compaction:** Automatic when context window fills

### Settings
- **Format:** electron-store (encrypted JSON)
- **Location:** `~/Library/Application Support/paprwork-v2/`
- **Contents:**
  - API keys
  - Provider configs
  - User preferences

---

## 🔌 Extension Points

### 1. Custom Tools
Create new tools by implementing `ToolDefinition`:

```typescript
export const myTool = createTool({
  id: 'my_tool',
  description: 'What it does',
  inputSchema: z.object({ /* ... */ }),
  execute: async (input) => { /* ... */ }
});
```

### 2. Custom Providers
Add new AI providers via AI SDK:

```typescript
import { myprovider } from '@ai-sdk/myprovider';

// Register in ModelFallback
```

### 3. Custom UI Components
Create React components in `src/renderer/components/`:

```typescript
export const MyComponent: React.FC<Props> = (props) => {
  // Component logic
};
```

---

## 🚀 Performance Considerations

### Cold Start (<2s)
- Lazy load heavy dependencies
- Preload critical modules
- Minimize main process work on startup

### Message Response (<1s)
- Stream responses immediately
- Don't block on tool execution
- Use async/await properly

### Memory (<200MB idle)
- Clean up old sessions
- Limit chat history in memory
- Use efficient data structures

---

## 📈 Scaling Strategy

### Horizontal Scaling
- Multiple gateway processes for different users
- WebSocket for inter-process communication
- Shared storage (future: database)

### Vertical Scaling
- Optimize hot paths
- Batch API requests
- Cache frequently used data

---

## 🔮 Future Architecture

### Planned Improvements

1. **Plugin System** - Load extensions dynamically
2. **Database Backend** - Replace JSONL with SQLite
3. **Multi-User Support** - Separate user contexts
4. **Cloud Sync** - Optional cloud backup
5. **Mobile Apps** - iOS/Android companions

---

## 📚 Related Documents

- [CORE_LIBRARY.md](./CORE_LIBRARY.md) - Shared core library design
- [GATEWAY_ARCHITECTURE.md](./GATEWAY_ARCHITECTURE.md) - Gateway details
- [IPC_PROTOCOL.md](./IPC_PROTOCOL.md) - IPC communication
- [DATA_FLOW.md](./DATA_FLOW.md) - Detailed data flow diagrams

---

**Last Updated:** 2026-02-09
