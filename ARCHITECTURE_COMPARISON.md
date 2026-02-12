# Architecture Comparison: OpenClaw vs Paprwork V1 vs Paprwork V2

**Research Date:** 2026-02-12  
**Sources:** OpenClaw GitHub (186k⭐), OpenClaw docs, Paprwork V1 source

---

## OpenClaw (186k stars)

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      GATEWAY (Standalone)                     │
│                  ws://127.0.0.1:18789 (default)              │
│                                                              │
│  • Long-lived daemon (launchd/systemd)                      │
│  • Owns ALL messaging surfaces (WhatsApp, Telegram, etc.)    │
│  • Typed WebSocket API (TypeBox schemas)                     │
│  • Validates frames with JSON Schema                         │
│  • Emits events: agent, chat, presence, health, heartbeat    │
└──────────────────────────────┬──────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  macOS App    │    │  CLI          │    │  WebChat UI    │
│  (WebSocket   │    │  (WebSocket   │    │  (WebSocket   │
│   client)     │    │   client)     │    │   client)      │
└───────────────┘    └───────────────┘    └───────────────┘
```

### Key Points

1. **Gateway is the product** — "The Gateway is just the control plane; the product is the assistant."

2. **Everything connects via WebSocket** — No Electron IPC for chat/agent. The macOS app is a **client** that connects to the Gateway WebSocket.

3. **Wire Protocol:**
   - First frame **must** be `connect` (handshake)
   - Requests: `{type: "req", id, method, params}` → `{type: "res", id, ok, payload|error}`
   - Events: `{type: "event", event, payload, seq?, stateVersion?}`
   - TypeBox schemas + JSON Schema validation

4. **macOS App** = Optional companion that:
   - Connects to Gateway via WebSocket
   - Provides menu bar control, Voice Wake, WebChat
   - Does NOT run the agent — Gateway does

5. **Streaming** — OpenClaw uses **block streaming** for channels (coarse chunks), not token-by-token. WebChat gets events over the same WebSocket.

6. **Single Gateway per host** — One process owns all channels.

7. **Protocol codegen** — TypeBox → JSON Schema → Swift models (for iOS/macOS)

---

## Paprwork V1

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    ELECTRON MAIN PROCESS                     │
│                                                              │
│  • Spawns Gateway as child process                          │
│  • ipcMain.handle() for ALL operations                      │
│  • webContents.send() for streaming events                  │
└──────────────────────────────┬──────────────────────────────┘
                                │
                    IPC (invoke + on)
                                │
        ┌───────────────────────┴───────────────────────┐
        │                                                 │
        ▼                                                 ▼
┌───────────────┐                              ┌───────────────┐
│  PRELOAD      │                              │  GATEWAY      │
│  contextBridge│                              │  (child proc) │
│  exposeInMain │                              │  Agent logic  │
└───────────────┘                              └───────────────┘
        │
        ▼
┌───────────────┐
│  RENDERER     │
│  app.js       │
│  electronAPI  │
└───────────────┘
```

### Key Points

1. **Traditional Electron IPC** — Everything goes through `ipcMain.handle` + `ipcRenderer.invoke`

2. **Preload exposes:**
   ```javascript
   sendMessage: (message) => ipcRenderer.invoke('send-message', message),
   onTextDelta: (callback) => ipcRenderer.on('text-delta', (event, delta) => callback(delta)),
   onThinkingDelta: (callback) => ipcRenderer.on('thinking-delta', ...),
   onStreamingComplete: (callback) => ipcRenderer.on('streaming-complete', ...),
   onToolCall: (callback) => ipcRenderer.on('tool-call', ...),
   onToolComplete: (callback) => ipcRenderer.on('tool-complete', ...),
   ```

3. **Streaming pattern:**
   - Main process calls Gateway
   - Main receives chunks, forwards via `webContents.send('text-delta', delta)`
   - Renderer listens via `ipcRenderer.on('text-delta', callback)`

4. **Gateway** = Child process spawned by Electron main

5. **Single process for UI** — Renderer, main, and Gateway all coordinated by Electron

---

## Paprwork V2 (Current)

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    ELECTRON MAIN PROCESS                     │
│                                                              │
│  • Spawns Gateway as child process (ELECTRON_RUN_AS_NODE)    │
│  • Loads UI from Gateway HTTP server (localhost:18789)       │
│  • IPC only for: customKeys (keychain)                      │
└──────────────────────────────┬──────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  PRELOAD      │    │  GATEWAY      │    │  RENDERER     │
│  (customKeys  │    │  (subprocess) │    │  (loaded from │
│   only)       │    │               │    │   Gateway)     │
└───────────────┘    │  • HTTP server│    └───────┬───────┘
                     │  • WebSocket  │            │
                     │  • Agent svc  │            │
                     └───────┬───────┘            │
                             │                    │
                             │    WebSocket       │
                             └────────────────────┘
```

### Key Points

1. **OpenClaw-style** — UI connects to Gateway via WebSocket (as a client)

2. **Electron is a shell** — Just spawns Gateway, loads UI from `http://localhost:18789`

3. **No IPC for chat** — All chat/agent goes through WebSocket

4. **IPC only for privileged ops** — customKeys (keychain) uses Electron IPC

5. **UI served by Gateway** — In production, Gateway serves `dist/ui` static files

6. **WebSocket protocol** — Custom message format: `{id, type, payload}` with response handlers

---

## Side-by-Side Comparison

| Aspect | OpenClaw | Paprwork V1 | Paprwork V2 |
|--------|----------|-------------|-------------|
| **Gateway** | Standalone daemon | Child of Electron | Child of Electron |
| **Chat transport** | WebSocket | Electron IPC | WebSocket |
| **Streaming** | WS events | webContents.send | WS messages |
| **UI loads from** | Gateway (WebChat) | Electron (file://) | Gateway (HTTP) |
| **Preload exposes** | N/A (WS in browser) | sendMessage, onTextDelta, etc. | customKeys only |
| **macOS app role** | WS client | Main process | Shell + WS client |
| **Protocol** | TypeBox + req/res/events | ad-hoc IPC channels | ad-hoc WS types |
| **Can run headless** | Yes (CLI only) | No | Yes (Gateway + any WS client) |

---

## What OpenClaw Does Differently

### 1. Gateway-First Design
- Gateway can run **without** any app (CLI, headless)
- Apps are **clients** of the Gateway, not parents
- Enables: remote Gateway, multi-client, Docker deployment

### 2. Typed Protocol
- TypeBox schemas → JSON Schema → validation
- Swift models generated for iOS/macOS
- Single source of truth for protocol

### 3. Mandatory Handshake
- First frame must be `connect`
- Device identity + pairing
- Prevents malformed clients

### 4. Event Model
- `{type: "event", event, payload}`
- Clients subscribe to events
- No request-response for streaming — just events

### 5. Block Streaming (Not Token)
- Channels get **blocks** (paragraphs), not token deltas
- WebChat presumably gets similar structure
- Reduces message volume

---

## What Paprwork V1 Did (Simpler)

### 1. Everything in One Place
- Main process owns Gateway
- No network boundary between main and Gateway
- Simpler debugging

### 2. Native Electron Streaming
- `webContents.send('text-delta', delta)` — direct, no serialization
- Preload bridges to renderer
- Very low latency

### 3. Synchronous Feel
- IPC is process-local
- No WebSocket connection management
- No reconnection logic

### 4. Security
- All privileged ops in main
- Preload exposes whitelisted API
- contextIsolation: true

---

## Recommendations for Paprwork V2

### Option A: Stay with WebSocket (Current)
**Pros:** OpenClaw-aligned, can add remote clients, Gateway can run standalone  
**Cons:** More complex, reconnection logic, latency from serialization

### Option B: Hybrid — IPC for Streaming
**Idea:** Use Electron IPC for streaming (like V1), WebSocket for everything else  
**Pros:** Lower latency for streaming, simpler renderer code  
**Cons:** Ties UI to Electron, can't easily add web client

### Option C: Adopt OpenClaw Protocol
**Idea:** Use OpenClaw's req/res/event format, TypeBox schemas  
**Pros:** Proven protocol, documentation, potential compatibility  
**Cons:** Different from current, significant refactor

### Option D: Optimize Current (Pragmatic)
**Keep WebSocket** but:
- Add protocol typing (TypeBox or Zod)
- Batch streaming updates (already done ✅)
- Consider `requestAnimationFrame` for UI updates
- Add shallow selectors for Zustand (already done ✅)

---

## Key Insight: Why OpenClaw Uses WebSocket

From the docs: *"Control-plane clients (macOS app, CLI, web UI, automations) connect to the Gateway over WebSocket."*

**The Gateway is the center.** It's not "Electron + Gateway" — it's "Gateway + clients." The macOS app is just one client. This enables:
- WebChat (browser) as first-class
- CLI as first-class  
- Remote Gateway (Tailscale, SSH tunnel)
- Multi-device (iOS, Android connect to same Gateway)

**Paprwork V2 adopted this** — Gateway serves UI, UI connects via WebSocket. We're 90% there. The remaining pain (lag, complexity) is from our custom protocol and React store updates, not the WebSocket choice itself.

---

## Summary

| | OpenClaw | Paprwork V1 | Paprwork V2 |
|-|----------|-------------|-------------|
| **Philosophy** | Gateway-centric | Electron-centric | Gateway-centric (like OpenClaw) |
| **Streaming** | WS events | IPC (webContents.send) | WS messages |
| **Latency** | Network round-trip | Process-local | Network round-trip |
| **Flexibility** | High (multi-client) | Low (Electron only) | High |
| **Complexity** | Medium | Low | Medium |

**Bottom line:** OpenClaw uses WebSocket because the Gateway is the product. Paprwork V1 used IPC because Electron was the product. Paprwork V2 chose the OpenClaw model for flexibility — the latency we see is the tradeoff. To reduce it: batch updates (done), optimize selectors (done), and consider `requestAnimationFrame` for render coalescing.
