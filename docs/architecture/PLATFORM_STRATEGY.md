# Platform Strategy - Multi-Platform Architecture

**Inspired by OpenClaw (179k⭐)** - Proven architecture for AI desktop assistants.

---

## 🎯 Overview

Paprwork V2 uses a **multi-platform architecture**:
- **Core App:** Electron + TypeScript (cross-platform)
- **Companion Apps:** Swift for native iOS/macOS features
- **Communication:** WebSocket protocol between apps

This matches OpenClaw's proven pattern used by 179k users.

---

## 🏗️ Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│              Paprwork V2 Ecosystem                      │
└─────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  Core App (Electron + TypeScript)                        │
│  ├── Windows / macOS / Linux                             │
│  ├── Main Process (Node.js + Electron)                   │
│  ├── Renderer (React + TypeScript)                       │
│  ├── Gateway (WebSocket Server)                          │
│  └── Storage (Local JSONL + Settings)                    │
└──────────────────────────────────────────────────────────┘
                       ↕ WebSocket
┌──────────────────────────────────────────────────────────┐
│  Companion Apps (Swift) - Optional                       │
│  ├── macOS Menu Bar App                                  │
│  │   ├── System tray icon                                │
│  │   ├── Quick actions menu                              │
│  │   ├── Native notifications                            │
│  │   └── Calendar/Contacts access                        │
│  └── iOS App                                             │
│      ├── Mobile chat interface                           │
│      ├── Voice input (Siri integration)                  │
│      ├── Camera/Photos access                            │
│      └── Push notifications                              │
└──────────────────────────────────────────────────────────┘
```

---

## 📦 Core App (Electron + TypeScript)

### Purpose
Primary application that runs on **all desktop platforms**.

### Technology Stack
- **Runtime:** Electron (cross-platform)
- **Language:** TypeScript (100%)
- **UI:** React + Vite
- **Agent:** Mastra framework
- **Storage:** JSONL files + electron-store

### Why Electron?
✅ Cross-platform (Mac, Windows, Linux)  
✅ Web technologies (React, TypeScript)  
✅ Rich ecosystem (npm, Mastra, AI SDK)  
✅ Fast iteration (hot reload)  
✅ Proven at scale (VS Code, Slack, Discord)  

### Responsibilities
- **Main agent** conversations
- **Chat history** management
- **Tool execution** (bash, filesystem, browser)
- **Settings** management
- **Gateway** for sub-agents (optional)
- **Core UI** for all features

### Target Platforms
- macOS (Intel + Apple Silicon)
- Windows 10/11 (x64)
- Linux (x64, AppImage + deb)

---

## 📱 Companion Apps (Swift)

### Purpose
**Optional** native apps for platform-specific features that Electron can't access easily.

### When to Use Companion Apps
Use Swift companions for:
- ✅ System tray/menu bar (macOS)
- ✅ Deep system integrations (Calendar, Contacts)
- ✅ Native notifications
- ✅ iOS mobile experience
- ✅ Voice input (Siri)
- ✅ Camera/Photos access

**Don't use for:**
- ❌ Core agent logic (stays in TypeScript)
- ❌ Chat interface (Electron handles this)
- ❌ Cross-platform features

### Architecture

#### macOS Menu Bar App
```swift
// SwiftUI macOS app
MenuBarApp
├── Communicates via WebSocket to Core
├── Displays system tray icon
├── Quick actions menu
├── Native notifications
└── Calendar/Contacts integration

// User clicks menu → WebSocket to Core → Agent responds
```

**Key Features:**
- **Always-on presence** in menu bar
- **Quick access** to agent
- **Native feel** (uses macOS APIs)
- **Lightweight** (doesn't duplicate core)

#### iOS Companion App
```swift
// SwiftUI iOS app
iOSApp
├── WebSocket connection to Core (via network)
├── Mobile chat interface
├── Voice input (Speech framework)
├── Camera integration
├── Push notifications (APNs)
└── Share extension

// Mobile UI → WebSocket to Core (Mac/Server) → Agent
```

**Key Features:**
- **Mobile access** to agent
- **Voice-first** interface
- **Camera/Photos** integration
- **Notifications** for responses
- **Share extension** (send to agent from other apps)

### Communication Protocol

Both companion apps use **WebSocket** to communicate with Core:

```typescript
// Protocol (shared between TypeScript and Swift)
interface WebSocketMessage {
  type: 'chat' | 'notification' | 'status' | 'settings';
  payload: unknown;
  timestamp: string;
}

// Swift → Core
{
  type: 'chat',
  payload: {
    message: 'User message from iOS',
    userId: 'user123'
  }
}

// Core → Swift
{
  type: 'chat',
  payload: {
    response: 'Agent response',
    thinking: '...'
  }
}
```

### Discovery & Pairing

Companion apps discover Core via:
1. **Bonjour/mDNS** (local network)
2. **Manual IP entry** (remote)
3. **QR code pairing** (security)

---

## ⚡ Development Tools (Rust)

### Purpose
**Dev-time tools** for faster development workflow.

### Why Rust Tools?
- **50-100x faster** than JavaScript equivalents
- **Better performance** for large codebases
- **Still use TypeScript** for runtime (no Rust in app)

### Tool Replacements

| Task | JavaScript Tool | Rust Tool | Speed Gain |
|------|----------------|-----------|------------|
| Linting | ESLint | **oxlint** | 50-100x |
| Formatting | Prettier | **oxfmt** | 50x |
| Bundling | Webpack | **rolldown** | 10x |
| Type checking | tsc | **oxc** | 10x |

### Setup

```bash
# Install Rust tools
npm install -D oxlint oxfmt rolldown

# Update scripts
{
  "lint": "oxlint --type-aware",
  "format": "oxfmt",
  "build:renderer": "rolldown"
}
```

**Benefits:**
- ✅ Faster CI (minutes → seconds)
- ✅ Better dev experience (instant feedback)
- ✅ Same output as JavaScript tools
- ✅ No runtime changes needed

---

## 🔄 Communication Flow

### Scenario 1: User Messages from Core App
```
User types in Electron UI
↓
Renderer → IPC → Main Process
↓
Main Process → MastraAgent
↓
Agent streams response
↓
Main → IPC → Renderer
↓
User sees response
```

### Scenario 2: User Messages from iOS App
```
User types in iOS app
↓
iOS → WebSocket → Core (Gateway)
↓
Gateway → MastraAgent
↓
Agent streams response
↓
Gateway → WebSocket → iOS
↓
User sees response on phone
```

### Scenario 3: Native Feature Request
```
Agent needs calendar access
↓
Core → WebSocket → macOS Menu Bar App
↓
Menu Bar → Native Calendar API
↓
Menu Bar → WebSocket → Core
↓
Agent receives calendar data
```

---

## 📊 Feature Distribution

| Feature | Core (Electron) | macOS Companion | iOS Companion |
|---------|----------------|-----------------|---------------|
| **Chat Interface** | ✅ Primary | ⏳ Quick access | ⏳ Mobile |
| **Agent Logic** | ✅ All | ❌ None | ❌ None |
| **Tool Execution** | ✅ All | ⏳ Native APIs | ⏳ Mobile APIs |
| **Settings** | ✅ Full | ⏳ Quick toggle | ⏳ Basic |
| **Notifications** | ⚠️ Basic | ✅ Native | ✅ Push |
| **System Tray** | ⚠️ Limited | ✅ Native | ❌ N/A |
| **Calendar** | ⚠️ Limited | ✅ Native | ✅ Native |
| **Voice Input** | ⚠️ Basic | ⏳ Native | ✅ Siri |
| **Camera** | ⚠️ Limited | ⏳ Native | ✅ Native |

**Legend:**
- ✅ Fully supported
- ⏳ Planned
- ⚠️ Limited support
- ❌ Not applicable

---

## 🚀 Development Phases

### Phase 1: Core App ✅ (Weeks 1-6)
**Status:** In Progress

**Deliverable:** Full-featured Electron app
- [x] Project setup
- [x] TypeScript core library
- [ ] Tool implementations
- [ ] Main process + IPC
- [ ] React UI
- [ ] Gateway process
- [ ] Testing suite

**Platforms:** macOS, Windows, Linux

### Phase 2: Rust Dev Tools (Week 7)
**Status:** Planned

**Deliverable:** Faster development workflow
- [ ] Install oxlint, oxfmt
- [ ] Update package.json scripts
- [ ] Benchmark speed improvements
- [ ] Update CI/CD pipelines

**Benefit:** 50-100x faster linting/formatting

### Phase 3: macOS Companion (Weeks 8-10)
**Status:** Planned

**Deliverable:** Native macOS menu bar app
- [ ] SwiftUI project setup
- [ ] WebSocket client
- [ ] Menu bar UI
- [ ] Quick actions
- [ ] Native notifications
- [ ] Calendar integration
- [ ] Bonjour discovery

**Platform:** macOS only

### Phase 4: iOS Companion (Weeks 11-14)
**Status:** Planned

**Deliverable:** Native iOS mobile app
- [ ] SwiftUI iOS project
- [ ] WebSocket client
- [ ] Mobile chat UI
- [ ] Voice input
- [ ] Camera integration
- [ ] Push notifications
- [ ] Share extension

**Platform:** iOS only

---

## 🔐 Security Model

### Core App
- Runs with **user permissions**
- Tool execution sandboxed per user
- API keys encrypted (electron-store)
- IPC validated with TypeScript types

### Companion Apps
- Authenticate via **shared secret** (QR code pairing)
- TLS for WebSocket (production)
- macOS entitlements for system access
- iOS sandbox for security

### Communication
- **Local network:** Bonjour discovery + TLS
- **Remote access:** VPN or SSH tunnel required
- **No cloud relay:** All traffic stays local

---

## 📱 Platform Capabilities

### Core App (Electron)
✅ Cross-platform UI  
✅ Full Node.js access  
✅ File system operations  
✅ Shell/terminal access  
✅ Browser automation  
⚠️ Limited system integration  

### macOS Companion (Swift)
✅ Native menu bar  
✅ System notifications  
✅ Calendar/Contacts access  
✅ Accessibility API  
✅ Screen recording  
✅ AppleScript automation  
❌ No cross-platform  

### iOS Companion (Swift)
✅ Mobile UI  
✅ Voice input (Siri)  
✅ Camera/Photos  
✅ Push notifications  
✅ Share extension  
✅ Background app refresh  
❌ Limited compared to desktop  

---

## 🔮 Future Enhancements

### Android Companion (Kotlin)
Similar to iOS app but for Android:
- Material Design UI
- Voice input (Google Assistant)
- Firebase push notifications
- Camera/Gallery integration

### Windows Native Companion (C#/WinUI)
Native Windows system tray:
- Windows notifications
- Quick actions
- Calendar integration
- System integrations

### Browser Extension
Lightweight browser companion:
- Send page to agent
- Inline chat
- Content analysis
- WebSocket to Core

---

## 📚 Related Documents

- [SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md) - Overall architecture
- [GATEWAY_VS_MAIN.md](./GATEWAY_VS_MAIN.md) - Process separation
- [IPC_PROTOCOL.md](./IPC_PROTOCOL.md) - Communication protocol

---

## 🎯 Key Decisions

**Decision 1: Electron for Core** ✅
- **Why:** Cross-platform, proven at scale
- **Alternative:** Native Swift (Mac only)
- **Outcome:** Better reach, faster development

**Decision 2: Swift for Companions** ✅
- **Why:** Best native experience, system access
- **Alternative:** React Native (slower, less native)
- **Outcome:** True native feel, full API access

**Decision 3: Rust for Dev Tools** ✅
- **Why:** 50-100x faster, no runtime changes
- **Alternative:** Stick with JavaScript tools
- **Outcome:** Faster dev workflow, same output

**Decision 4: WebSocket Communication** ✅
- **Why:** Flexible, works across platforms
- **Alternative:** gRPC, HTTP polling
- **Outcome:** Real-time, bidirectional, simple

---

**Last Updated:** 2026-02-09  
**Architecture:** OpenClaw-inspired multi-platform approach
