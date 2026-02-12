# Gateway Architecture

Paprwork V2 uses a Gateway architecture inspired by OpenClaw, providing clean separation between the backend services and the UI.

## Overview

```
┌──────────────────────────────────────┐
│  Electron Shell                       │
│  - Minimal wrapper                    │
│  - Loads UI from localhost           │
│  - Native features (menus, etc.)     │
└───────────┬──────────────────────────┘
            │ WebSocket
┌───────────▼──────────────────────────┐
│  Gateway Server (:18789)              │
│  ├─ Express HTTP server              │
│  ├─ WebSocket server                 │
│  ├─ AgentService (Mastra)            │
│  ├─ ChatService (SQLite)             │
│  └─ Serves UI assets                 │
└───────────────────────────────────────┘
```

## Components

### 1. Gateway Server (`src/gateway/`)

Pure Node.js server (no Electron dependencies):

- **HTTP Server**: Express serving UI assets in production
- **WebSocket Server**: Real-time communication with clients
- **AgentService**: AI agent orchestration using Mastra
- **ChatService**: Chat session management with SQLite

**Key Files:**
- `src/gateway/index.ts` - Server entry point
- `src/gateway/services/` - Backend services
- `src/gateway/websocket/` - WebSocket message handlers

### 2. UI (`ui/`)

React application built with Vite:

- **React Components**: Liquid Glass design system
- **WebSocket Client**: Connects to Gateway
- **Zustand Store**: State management

**Key Files:**
- `ui/src/lib/gateway.ts` - WebSocket client
- `ui/hooks/` - React hooks for agent & chat
- `ui/components/` - UI components

### 3. Electron Shell (`src/electron/`)

Minimal Electron wrapper:

- Creates application window
- Loads UI from Gateway
- Provides native features (menus, shortcuts)
- Starts Gateway process in production

**Key Files:**
- `src/electron/index.ts` - Electron entry point

## Communication

### WebSocket Messages

All communication uses WebSocket messages with this structure:

```typescript
// Request
{
  id: string;        // Unique message ID
  type: string;      // Message type (e.g., "agent:stream")
  payload?: unknown; // Optional payload
}

// Response
{
  id: string;        // Matches request ID
  success: boolean;  // Success status
  data?: unknown;    // Response data
  error?: string;    // Error message if failed
}
```

### Message Types

**Agent:**
- `agent:stream` - Stream AI agent response
- `agent:history` - Get chat history
- `agent:clear` - Clear chat history

**Chat:**
- `chat:list` - List all chats
- `chat:create` - Create new chat
- `chat:update` - Update chat metadata
- `chat:delete` - Delete chat
- `chat:switch` - Switch active chat

## Development

### Starting All Services

```bash
npm run dev
```

This starts three processes concurrently:
1. Gateway server (tsx watch)
2. Vite dev server
3. Electron shell

### Starting Services Separately

```bash
# Terminal 1: Gateway
npm run gateway:dev

# Terminal 2: UI
npm run ui:dev

# Terminal 3: Electron
npm run electron:dev
```

## Production

### Building

```bash
npm run build
```

Builds:
1. Gateway → `dist/gateway/`
2. Electron → `dist/electron/`
3. UI → `dist/ui/`

### Running

```bash
npm start
```

Electron starts the Gateway process and loads the UI from `dist/ui/`.

## Benefits

### 1. Clean Separation
- Gateway: Pure Node.js (no Electron dependencies)
- UI: Standard React app (works in browser)
- Shell: Minimal Electron wrapper

### 2. No Bundling Issues
- No Electron module bundling problems
- No preload script complexity
- Standard ES modules throughout

### 3. Remote Access
Gateway can be accessed from:
- Electron shell (default)
- Web browser (`http://localhost:18789`)
- Mobile devices (on same network)

### 4. Easier Testing
- Test Gateway independently
- Test UI in browser
- Mock WebSocket for unit tests

### 5. Better Development
- Hot reload for UI (Vite)
- Watch mode for Gateway (tsx)
- Separate terminal logs

## Comparison to Electron-Only

| Aspect | Gateway Architecture | Electron-Only |
|--------|---------------------|---------------|
| **Separation** | ✅ Clean layers | ❌ Coupled |
| **Module Issues** | ✅ None | ❌ Bundling problems |
| **Remote Access** | ✅ Browser + Electron | ❌ Electron only |
| **Testing** | ✅ Easier | ❌ Harder |
| **Dev Experience** | ✅ Better | ⚠️ Mixed |
| **Complexity** | ⚠️ More parts | ✅ Simpler |

## Future Enhancements

- **Authentication**: Add token-based auth for remote access
- **HTTPS**: SSL/TLS for secure connections
- **Multi-user**: Support multiple clients
- **Native Apps**: Swift (macOS), Kotlin (Android) shells
