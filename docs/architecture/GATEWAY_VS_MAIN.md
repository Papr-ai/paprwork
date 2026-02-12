# Gateway vs. Main Process

Understanding the separation of concerns between Gateway and Main processes in Paprwork V2.

---

## 🎯 Overview

Paprwork V2 uses a **two-process architecture** inspired by OpenClaw's proven design:

- **Main Process** - Primary Electron app with UI and main agent
- **Gateway Process** - Optional control plane for sub-agents and orchestration

**Key Insight:** Both processes use the **same shared core library** - zero code duplication!

---

## 📊 Comparison Table

| Feature | Main Process | Gateway Process |
|---------|-------------|-----------------|
| **Purpose** | Primary UI & main agent | Sub-agents & orchestration |
| **Required** | Yes (core app) | No (optional) |
| **Technology** | Electron + TypeScript | Node + WebSocket |
| **UI** | Full Electron UI | None (headless) |
| **Agent** | Main conversational agent | Multiple sub-agents |
| **Tools** | All tools available | Selected tools per agent |
| **Storage** | Local chat history | Shared storage access |
| **Communication** | IPC to renderer | WebSocket to main |
| **Process Model** | Single instance | Can scale to multiple |
| **Use Cases** | Direct user interaction | Background jobs, delegation |

---

## 🏗️ Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Main Process (Electron)               │
│                                                          │
│  ┌──────────────┐      ┌──────────────┐                │
│  │   Renderer   │ IPC  │ Main Process │                │
│  │    (React)   │◄────►│  Services    │                │
│  └──────────────┘      └───────┬──────┘                │
│                                 │                        │
│                                 │ Uses @core/*          │
│                                 ▼                        │
│                        ┌──────────────┐                 │
│                        │ MastraAgent  │                 │
│                        │ SessionMgr   │                 │
│                        │ ToolRegistry │                 │
│                        └──────────────┘                 │
└─────────────────────────────────────────────────────────┘
                                 │
                                 │ WebSocket (optional)
                                 │
┌────────────────────────────────┼─────────────────────────┐
│                    Gateway Process (Optional)            │
│                                 │                         │
│                        ┌────────▼────────┐               │
│                        │  WS Server      │               │
│                        │  (port 8080)    │               │
│                        └────────┬────────┘               │
│                                 │                         │
│                                 │ Uses @core/*           │
│                                 ▼                         │
│                        ┌──────────────┐                  │
│                        │ MastraAgent  │ ← Same class!    │
│                        │ SessionMgr   │                  │
│                        │ ToolRegistry │                  │
│                        └──────────────┘                  │
│                                                           │
│  Multiple Sub-Agents:                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│  │ Research │ │   Code   │ │ Writing  │               │
│  │  Agent   │ │  Review  │ │  Agent   │               │
│  └──────────┘ └──────────┘ └──────────┘               │
└──────────────────────────────────────────────────────────┘
```

---

## 🔑 Key Differences

### Main Process Characteristics

**Responsibilities:**
- Manage Electron window lifecycle
- Handle IPC from renderer
- Run main conversational agent
- Execute user-initiated tasks
- Provide UI feedback

**Agent Configuration:**
```typescript
const mainAgent = new MastraAgent(userDataPath);
await mainAgent.initialize();

// Full access to all tools
mainAgent.getToolRegistry().registerMany([
  bashTool,
  readTool,
  writeTool,
  editTool,
  browserTool,
  // ... all tools
]);
```

**Use Cases:**
- Direct user conversations
- File editing and creation
- Browser automation
- Quick tasks

### Gateway Process Characteristics

**Responsibilities:**
- Run multiple sub-agents in parallel
- Handle delegated tasks
- Execute background jobs
- Manage long-running operations
- Coordinate between agents

**Agent Configuration:**
```typescript
// Each sub-agent has its own instance
const researchAgent = new MastraAgent(userDataPath);
await researchAgent.initialize();

// Limited tools per agent
researchAgent.getToolRegistry().registerMany([
  bashTool,
  readTool,
  // Only tools needed for research
]);
```

**Use Cases:**
- Background research tasks
- Code review
- Content writing
- Data analysis
- Scheduled jobs

---

## 🔄 Communication Flow

### Main → Gateway

```typescript
// Main process sends task to gateway
const ws = new WebSocket('ws://localhost:8080');

ws.send(JSON.stringify({
  type: 'agent:stream',
  chatId: 'research-123',
  message: 'Research topic X',
  config: {
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    apiKey: apiKey,
    systemPrompt: 'You are a research specialist...'
  }
}));

// Gateway streams back chunks
ws.on('message', (data) => {
  const chunk = JSON.parse(data);
  if (chunk.type === 'chunk') {
    // Forward to renderer
    webContents.send('gateway:chunk', chunk.data);
  }
});
```

### Gateway → Main (Results)

```typescript
// Gateway sends completion back
ws.send(JSON.stringify({
  type: 'done',
  chatId: 'research-123',
  result: {
    summary: '...',
    findings: [...]
  }
}));
```

---

## ⚙️ When to Use Gateway

### Use Gateway When:

✅ Running **background jobs** (hourly, daily tasks)  
✅ Need **multiple specialized agents** in parallel  
✅ Performing **long-running tasks** (30+ seconds)  
✅ Want to **delegate** without blocking main UI  
✅ Running **scheduled automation**  
✅ Need **separate tool permissions** per agent  

### Use Main Process When:

✅ **Direct user interaction** required  
✅ **Quick tasks** (<30 seconds)  
✅ Need **immediate UI feedback**  
✅ **Simple conversations**  
✅ **File operations** visible to user  
✅ Just getting started (no gateway needed)  

---

## 💡 Shared Core Library

**Critical Advantage:** Both processes import from `@core/*`:

```typescript
// src/main/services/AgentService.ts
import { MastraAgent } from '@core/agents/MastraAgent';

// src/gateway/services/SubAgentService.ts
import { MastraAgent } from '@core/agents/MastraAgent';

// Same class, same behavior, zero duplication!
```

**Benefits:**
- Fix bug once → fixed everywhere
- Add feature once → available everywhere
- Consistent behavior across processes
- Easier testing (test core once)
- Less code to maintain

---

## 🔐 Security Considerations

### Main Process
- Runs with user permissions
- Full filesystem access
- Can launch apps
- Direct IPC to renderer

### Gateway Process
- Can be sandboxed (future)
- Limited tool access per agent
- No direct renderer access
- Can run on separate machine

---

## 🚀 Deployment Options

### Option 1: Main Only (Simple)
```
User → Main Process → MastraAgent → Tools
```
- Single process
- Easy setup
- Good for most users

### Option 2: Main + Gateway (Advanced)
```
User → Main Process ─┐
                     ├→ WebSocket → Gateway → Sub-Agents
Background Jobs ─────┘
```
- Two processes
- Scalable
- Advanced features

### Option 3: Gateway on Server (Enterprise)
```
User (Mac) → Main Process → WS → Gateway (Linux Server) → Sub-Agents
```
- Gateway on dedicated server
- Main process stays lightweight
- Share gateway across team

---

## 📚 Code Examples

### Starting Both Processes

```bash
# Terminal 1: Start Gateway
npm run start:gateway

# Terminal 2: Start Main App
npm run start
```

### Development Mode

```bash
# Watch mode for gateway
npm run gateway:watch

# Watch mode for main app
npm run dev
```

---

## 🔮 Future Enhancements

### Planned Improvements

1. **Auto-Discovery** - Gateway auto-announces on local network
2. **Load Balancing** - Distribute tasks across multiple gateways
3. **Remote Gateway** - Run gateway on cloud server
4. **Gateway Dashboard** - Web UI for monitoring sub-agents
5. **Plugin System** - Load custom sub-agents dynamically

---

## 📚 Related Documents

- [SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md) - Overall architecture
- [CORE_LIBRARY.md](./CORE_LIBRARY.md) - Shared core design
- [IPC_PROTOCOL.md](./IPC_PROTOCOL.md) - Communication protocols

---

**Last Updated:** 2026-02-09
