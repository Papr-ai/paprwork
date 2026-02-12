# Paprwork V2: Implementation Plan

## Overview

Build a new Paprwork application from scratch with proper architecture, TypeScript, and Mastra framework. Use existing codebase as reference/specification but implement cleanly with modern best practices.

**Timeline:** 4-6 weeks to feature parity  
**Approach:** Reference-driven greenfield  
**Goal:** Production-ready app with zero technical debt

## Why Fresh Start?

### Current V1 State
- ❌ 30,335 lines in 4 monolithic files
- ❌ 90% code duplication (main + gateway)
- ❌ No type safety
- ❌ Tight coupling everywhere
- ❌ Fragile with many patches

### V2 Architecture
- ✅ Modular TypeScript from day 1
- ✅ Shared core library (zero duplication)
- ✅ Full type safety
- ✅ Clean separation of concerns
- ✅ Mastra framework (proven)

## Timeline

| Week | Focus | Deliverable |
|------|-------|-------------|
| 1 | Foundation + Core | Core agent library with Mastra |
| 2 | Main Process + Tools | Working agent with tools |
| 3 | Renderer UI | Chat UI with streaming |
| 4 | Gateway | Sub-agents with shared core |
| 5 | Feature Parity | All v1 features ported |
| 6 | Testing + Migration | Production-ready |

## Week 1: Foundation + Core Library

### Day 1-2: Project Setup ✅
- [x] Initialize npm project
- [x] Install dependencies
- [x] Configure TypeScript (main, renderer, gateway)
- [x] Setup Vite for renderer
- [x] Create .gitignore and README

### Day 3-4: Core Types ✅
- [x] `src/core/types/messages.ts` - CoreMessage, PersistedMessage, CompactionEntry
- [x] `src/core/types/agents.ts` - AgentConfig, Provider, ModelInfo
- [x] `src/core/types/tools.ts` - ToolResult, ToolExecution, tool-specific types
- [x] `src/core/types/streaming.ts` - StreamChunk types and callbacks
- [x] `src/core/types/storage.ts` - Storage interfaces and settings

### Day 5-7: Core Agent Library
- [ ] `src/core/agents/MastraAgent.ts` - Main agent wrapper
- [ ] `src/core/agents/SessionManager.ts` - Chat history + compaction
- [ ] `src/core/agents/ToolRegistry.ts` - Tool management
- [ ] `src/core/agents/ModelFallback.ts` - Multi-provider fallback

## Week 2: Main Process + Tools

### Day 1-2: Tool Registry
- [ ] `src/core/tools/bash.ts` - Bash execution
- [ ] `src/core/tools/filesystem.ts` - Read, write, edit
- [ ] `src/core/tools/index.ts` - Tool registry setup

### Day 3-4: Main Process Services
- [ ] `src/main/services/AgentService.ts` - Agent management
- [ ] `src/main/services/ChatService.ts` - Chat operations
- [ ] `src/main/ipc/agent.ts` - IPC handlers for agent
- [ ] `src/main/ipc/chat.ts` - IPC handlers for chat

### Day 5-7: Main Process Setup
- [ ] `src/main/index.ts` - Entry point
- [ ] `src/main/window.ts` - Window management
- [ ] `src/main/preload.ts` - Preload script

## Week 3: Renderer (Chat UI)

### Day 1-3: Core Components
- [ ] `src/renderer/hooks/useChat.ts` - Chat hook with streaming
- [ ] `src/renderer/components/Chat/ChatContainer.tsx`
- [ ] `src/renderer/components/Chat/MessageList.tsx`
- [ ] `src/renderer/components/Chat/MessageItem.tsx`
- [ ] `src/renderer/components/Chat/InputBar.tsx`

### Day 4-5: Additional Components
- [ ] `src/renderer/components/Sidebar/ChatList.tsx`
- [ ] `src/renderer/components/Settings/SettingsPanel.tsx`
- [ ] `src/renderer/stores/chatStore.ts` - State management

### Day 6-7: Integration
- [ ] `src/renderer/App.tsx` - Root component
- [ ] `src/renderer/index.tsx` - Entry point
- [ ] Connect all components and test

## Week 4: Gateway + Sub-Agents

### Day 1-3: Gateway Process
- [ ] `src/gateway/index.ts` - Gateway entry point
- [ ] `src/gateway/server.ts` - WebSocket server
- [ ] `src/gateway/services/SubAgentService.ts` - Uses shared MastraAgent

### Day 4-7: Sub-Agent Integration
- [ ] Test sub-agent communication
- [ ] Implement job execution
- [ ] Add agent delegation logic

## Week 5: Feature Parity

- [ ] Skills system
- [ ] Mini-apps
- [ ] Meeting recording/prep
- [ ] Browser automation tools
- [ ] PAPR integration (documents, memory)
- [ ] Settings UI completion

## Week 6: Testing + Migration

- [ ] Unit tests (core library)
- [ ] Integration tests (services)
- [ ] E2E tests (Playwright)
- [ ] Data migration tool (`scripts/migrate-v1-data.ts`)
- [ ] Performance testing
- [ ] Bug fixes

## Success Metrics

### Code Quality
- ✅ 100% TypeScript (zero `any` types)
- ✅ 80%+ test coverage
- ✅ All files <500 lines
- ✅ Zero code duplication

### Performance
- ✅ Cold start <2 seconds
- ✅ First message response <1 second
- ✅ Memory usage <200MB idle
- ✅ No memory leaks

### Reliability
- ✅ Zero tool pairing errors
- ✅ Graceful error handling
- ✅ Automatic retries for API failures
- ✅ Session recovery after crashes

## Current Status

**✅ Week 1 (Days 1-4) Complete:**
- Project setup with TypeScript
- All core types defined
- Ready for agent library implementation

**🔄 Next Steps:**
- Implement SessionManager (chat history + compaction)
- Implement ToolRegistry (tool management)
- Implement MastraAgent (main agent wrapper)
