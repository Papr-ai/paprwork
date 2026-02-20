# Paprwork V2 - Project Structure

Complete overview of the project organization.

---

## 📁 Directory Structure

```
paprwork-v2/
├── .github/                    # GitHub workflows and CI/CD
│   └── workflows/
│       └── test.yml
│
├── build/                      # Build resources and assets
│   ├── entitlements.mac.plist
│   ├── entitlements.mac.inherit.plist
│   └── icon.icns
│
├── docs/                       # 📚 Documentation
│   ├── README.md               # Documentation index
│   ├── architecture/           # System architecture
│   │   ├── SYSTEM_OVERVIEW.md
│   │   ├── CORE_LIBRARY.md
│   │   ├── GATEWAY_VS_MAIN.md
│   │   ├── IPC_PROTOCOL.md
│   │   └── DATA_FLOW.md
│   ├── guides/                 # User & developer guides
│   │   ├── GETTING_STARTED.md
│   │   ├── DEVELOPMENT_SETUP.md
│   │   ├── BUILDING_TOOLS.md
│   │   ├── TESTING_GUIDE.md
│   │   └── DEPLOYMENT.md
│   ├── api/                    # API references
│   │   ├── CORE_API.md
│   │   ├── IPC_API.md
│   │   ├── TOOL_API.md
│   │   └── STREAMING_API.md
│   ├── implementations/        # Feature implementation docs
│   └── improvements/           # Future improvements
│
├── plans/                      # 📋 Feature plans & specs
│   ├── README.md
│   └── TEMPLATE.md
│
├── scripts/                    # 🔧 Build & automation scripts
│   ├── templates/
│   ├── migrate-v1-data.ts
│   └── build.ts
│
├── src/                        # 💻 Source code
│   ├── core/                   # ⭐ Shared core library
│   │   ├── agents/             # Agent implementations
│   │   │   ├── MastraAgent.ts
│   │   │   ├── SessionManager.ts
│   │   │   ├── ToolRegistry.ts
│   │   │   ├── ModelFallback.ts
│   │   │   └── index.ts
│   │   ├── storage/            # Storage implementations
│   │   │   ├── ChatStorage.ts
│   │   │   └── SettingsStorage.ts
│   │   ├── tools/              # Tool implementations
│   │   │   ├── bash.ts
│   │   │   ├── filesystem.ts
│   │   │   ├── papr.ts
│   │   │   ├── browser.ts
│   │   │   └── index.ts
│   │   ├── types/              # TypeScript type definitions
│   │   │   ├── messages.ts
│   │   │   ├── agents.ts
│   │   │   ├── tools.ts
│   │   │   ├── streaming.ts
│   │   │   ├── storage.ts
│   │   │   └── index.ts
│   │   └── index.ts            # Core exports
│   │
│   ├── main/                   # 🖥️ Main process (Electron)
│   │   ├── index.ts            # Entry point
│   │   ├── window.ts           # Window management
│   │   ├── preload.ts          # Preload script
│   │   ├── ipc/                # IPC handlers
│   │   │   ├── chat.ts
│   │   │   ├── agent.ts
│   │   │   ├── settings.ts
│   │   │   ├── skills.ts
│   │   │   └── index.ts
│   │   └── services/           # Business logic
│   │       ├── AgentService.ts
│   │       ├── ChatService.ts
│   │       ├── SkillService.ts
│   │       ├── MeetingService.ts
│   │       └── index.ts
│   │
│   ├── gateway/                # 🌐 Gateway process (optional)
│   │   ├── index.ts            # Entry point
│   │   ├── server.ts           # WebSocket server
│   │   ├── services/           # Gateway services
│   │   │   └── SubAgentService.ts
│   │   └── handlers/           # Request handlers
│   │       ├── job.ts
│   │       └── agent.ts
│   │
│   └── renderer/               # 🎨 Renderer process (React)
│       ├── index.tsx           # Entry point
│       ├── App.tsx             # Root component
│       ├── components/         # React components
│       │   ├── Chat/
│       │   │   ├── ChatContainer.tsx
│       │   │   ├── MessageList.tsx
│       │   │   ├── MessageItem.tsx
│       │   │   ├── InputBar.tsx
│       │   │   ├── StreamingMessage.tsx
│       │   │   └── ToolCallCard.tsx
│       │   ├── Sidebar/
│       │   │   ├── ChatList.tsx
│       │   │   ├── ChatItem.tsx
│       │   │   └── NewChatButton.tsx
│       │   ├── Settings/
│       │   │   ├── SettingsPanel.tsx
│       │   │   ├── APIKeysSection.tsx
│       │   │   ├── ModelSection.tsx
│       │   │   └── PreferencesSection.tsx
│       │   ├── MiniApps/
│       │   │   ├── MiniAppContainer.tsx
│       │   │   └── MiniAppRenderer.tsx
│       │   └── Skills/
│       │       ├── SkillsPanel.tsx
│       │       └── SkillCard.tsx
│       ├── hooks/              # Custom React hooks
│       │   ├── useChat.ts
│       │   ├── useAgent.ts
│       │   ├── useSettings.ts
│       │   ├── useStreaming.ts
│       │   └── useSkills.ts
│       ├── services/           # API services
│       │   ├── ChatAPI.ts
│       │   ├── AgentAPI.ts
│       │   ├── SettingsAPI.ts
│       │   └── SkillsAPI.ts
│       ├── stores/             # State management
│       │   ├── chatStore.ts
│       │   ├── settingsStore.ts
│       │   └── uiStore.ts
│       ├── types/              # Renderer-specific types
│       │   └── index.ts
│       └── styles/             # Stylesheets
│           ├── global.css
│           └── components/
│
├── test/                       # 🧪 Tests
│   ├── unit/                   # Unit tests
│   │   ├── core/
│   │   ├── main/
│   │   └── renderer/
│   ├── integration/            # Integration tests
│   └── e2e/                    # End-to-end tests
│
├── .eslintrc.json              # ESLint configuration
├── .gitignore                  # Git ignore rules
├── CLAUDE.md                   # 🤖 AI context & learnings
├── electron-builder.json       # Electron builder config
├── package.json                # Dependencies & scripts
├── PLAN.md                     # 📅 Implementation timeline
├── PROJECT_STRUCTURE.md        # 📁 This file
├── README.md                   # Project overview
├── tsconfig.json               # TypeScript root config
├── tsconfig.main.json          # Main process TS config
├── tsconfig.renderer.json      # Renderer process TS config
├── tsconfig.gateway.json       # Gateway process TS config
└── vite.config.ts              # Vite configuration
```

---

## 🎯 Key Principles

### 1. Shared Core Library (`src/core/`)
- **Zero duplication** between main and gateway processes
- Both import from `@core/*`
- Single source of truth for agent logic
- Easier testing and maintenance

### 2. Modular Components
- **Max 500 lines** per file
- Clear separation of concerns
- Easy to test in isolation
- Easy to understand and modify

### 3. Type Safety
- **100% TypeScript**
- **Zero `any` types** (use `unknown` + type guards)
- All function parameters and returns typed
- Strict mode enabled

### 4. Documentation-Driven
- **CLAUDE.md** - Project context for AI assistants
- **docs/** - Technical documentation
- **plans/** - Feature specifications
- **README.md** - User-facing overview

---

## 📦 Important Files

### Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | Dependencies, scripts, project metadata |
| `tsconfig.json` | Root TypeScript configuration |
| `tsconfig.main.json` | Main process TypeScript config |
| `tsconfig.renderer.json` | Renderer process TypeScript config |
| `tsconfig.gateway.json` | Gateway process TypeScript config |
| `vite.config.ts` | Vite bundler configuration |
| `.eslintrc.json` | Linting rules |
| `electron-builder.json` | Electron packaging config |

### Documentation Files

| File | Purpose |
|------|---------|
| `README.md` | Project overview and quick start |
| `CLAUDE.md` | AI assistant context and learnings |
| `PLAN.md` | Implementation timeline and milestones |
| `PROJECT_STRUCTURE.md` | This file - project organization |
| `docs/README.md` | Documentation index |

### Entry Points

| File | Purpose |
|------|---------|
| `src/main/index.ts` | Main Electron process entry |
| `src/gateway/index.ts` | Gateway process entry |
| `src/renderer/index.tsx` | React UI entry |
| `src/core/index.ts` | Core library exports |

---

## 🔄 Process Architecture

```
┌────────────────────────────────────────────────────┐
│                Paprwork V2 Application              │
└────────────────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
  ┌───────────┐   ┌───────────┐   ┌───────────┐
  │ Renderer  │   │   Main    │   │  Gateway  │
  │  (React)  │   │(Electron) │   │ (Optional)│
  └───────────┘   └───────────┘   └───────────┘
         │               │               │
         └───────────────┼───────────────┘
                         │
                         ▼
                  ┌─────────────┐
                  │ Core Library│
                  │  (@core/*)  │
                  └─────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
    ┌────────┐      ┌────────┐     ┌────────┐
    │ Mastra │      │Storage │     │ Tools  │
    └────────┘      └────────┘     └────────┘
```

---

## 🚀 Development Workflow

### 1. Starting Development

```bash
# Install dependencies
npm install

# Start renderer in watch mode
npm run dev

# In another terminal: Start main process
npm run start

# In another terminal: Start gateway (optional)
npm run start:gateway
```

### 2. Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# With coverage
npm run test:coverage
```

### 3. Type Checking

```bash
# Check all TypeScript
npm run type-check

# Watch mode (continuous)
npm run type-check:watch
```

### 4. Linting

```bash
# Check code quality
npm run lint

# Auto-fix issues
npm run lint:fix
```

### 5. Building

```bash
# Build everything
npm run build

# Build main process
npm run build:main

# Build renderer
npm run build:renderer

# Build gateway
npm run build:gateway
```

---

## 📚 Navigation Guide

### For Developers

**Getting Started:**
1. Read `README.md`
2. Review `CLAUDE.md` for context
3. Check `docs/guides/GETTING_STARTED.md`
4. Set up development environment

**Understanding Architecture:**
1. Read `docs/architecture/SYSTEM_OVERVIEW.md`
2. Review `docs/architecture/GATEWAY_VS_MAIN.md`
3. Check `src/core/` for shared library
4. See `docs/architecture/DATA_FLOW.md`

**Building Features:**
1. Check `PLAN.md` for timeline
2. Read relevant `docs/api/` files
3. See `docs/guides/BUILDING_TOOLS.md`
4. Write tests in `test/`

### For AI Assistants

**Primary Context Files:**
1. `CLAUDE.md` - Project learnings and decisions
2. `PROJECT_STRUCTURE.md` - This file
3. `PLAN.md` - Implementation timeline
4. `docs/architecture/` - System design

**Code Organization:**
- All types: `src/core/types/`
- Agent logic: `src/core/agents/`
- Tools: `src/core/tools/`
- Main process: `src/main/`
- Gateway: `src/gateway/`
- UI: `src/renderer/`

---

## 🎓 Learning Resources

### Internal Documentation
- [CLAUDE.md](./CLAUDE.md) - Project context
- [docs/README.md](./docs/README.md) - Documentation index
- [PLAN.md](./PLAN.md) - Implementation plan

### External References
- [Mastra Documentation](https://mastra.ai/docs)
- [Electron Documentation](https://electronjs.org/docs)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/)
- [React Documentation](https://react.dev/)

### Inspiration
- [OpenClaw](https://github.com/openclaw/openclaw) - 179k stars, TypeScript Electron app
- [Paprwork V1](../paprwork/) - Our legacy codebase (reference only)

---

## ✅ Status

**Current Phase:** Week 1 - Foundation Complete ✅

**Completed:**
- [x] Project setup
- [x] TypeScript configuration
- [x] Core type definitions
- [x] Core agent library (MastraAgent, SessionManager, ToolRegistry)
- [x] Storage implementations
- [x] Documentation structure
- [x] ESLint configuration
- [x] Build system setup

**Next Steps:**
- [ ] Implement tools (bash, filesystem)
- [ ] Main process services
- [ ] IPC handlers
- [ ] React UI setup

See [PLAN.md](./PLAN.md) for detailed timeline.

---

**Last Updated:** 2026-02-09
