# Chat Persistence - Implementation Roadmap

## ✅ Phase 1: COMPLETED - Storage Infrastructure
- ✅ `IStorageProvider` interface defined
- ✅ `LocalStorageProvider` with SQLite + JSONB
- ✅ `PaprMemoryProvider` with SDK integration (verified with 20 messages)
- ✅ `HybridStorageProvider` combining both
- ✅ `ChatExporter` for ~/Papr/ folder
- ✅ SQLite schema with chats, messages, summaries tables
- ✅ Sync tracking with `sync_status` fields

## 🚧 Phase 2: NEXT - Integration with Chat UI

### 2.1 Gateway Integration
**Goal**: Wire up storage to the Gateway's AgentService

**Tasks**:
1. Add `StorageManager` to Gateway
   - Initialize the appropriate provider (Local/PAPR/Hybrid) based on settings
   - Expose provider to AgentService

2. Update `AgentService.streamAgent()` to:
   - Save user message before streaming
   - Load message history for LLM context
   - Save assistant message chunks as they arrive
   - Export chat to ~/Papr/ folder after completion

3. Implement summarization trigger:
   - Check token count after each turn
   - Trigger PAPR compress or local summarization at 50K tokens
   - Cache summary for next LLM context

**Files to modify**:
- `/src/gateway/services/AgentService.ts`
- Create `/src/gateway/services/StorageManager.ts`

### 2.2 IPC Endpoints
**Goal**: Expose storage operations to Electron renderer

**Tasks**:
1. Add IPC handlers in `main.ts`:
   - `chat:create` - Create new chat
   - `chat:list` - List all chats
   - `chat:get` - Get chat metadata
   - `chat:delete` - Delete chat
   - `chat:messages:get` - Get messages for a chat
   - `chat:export` - Export chat to file

2. Add IPC invoke calls in preload

**Files to modify**:
- `/src/electron/main.ts`
- `/src/electron/preload.ts`

### 2.3 UI State Management
**Goal**: Add chat history management to UI

**Tasks**:
1. Update `useChatStore` (Zustand):
   - Add `chatHistory` state
   - Add `loadChatHistory()` action
   - Add `loadChat(chatId)` action
   - Add `deleteChat(chatId)` action

2. Update `ChatContainer.tsx`:
   - Load messages when chat is selected
   - Save messages during streaming
   - Show chat history in sidebar

**Files to modify**:
- `/ui/store/chatStore.ts`
- `/ui/components/Chat/ChatContainer.tsx`
- `/ui/components/Sidebar/ChatHistory.tsx` (create if doesn't exist)

### 2.4 Settings UI
**Goal**: Let users choose storage mode

**Tasks**:
1. Add storage mode settings:
   - Radio buttons: "Local Only" / "Local + PAPR" / "PAPR Only"
   - Show current mode
   - Require PAPR API key for PAPR modes

2. Save preference to Electron settings

**Files to modify**:
- `/ui/components/Settings/Settings.tsx`
- `/src/core/storage/SettingsStorage.ts`

## 📋 Phase 3: FUTURE - Advanced Features

### 3.1 Chat Search
- Full-text search in SQLite
- Search across all chats
- Highlight results in UI

### 3.2 Chat Export/Import
- Export individual chats as markdown
- Import chats from other sources
- Bulk operations

### 3.3 Enhanced Finder Integration
- ✅ ~/Papr/ folder created
- ✅ Auto-add to Finder sidebar (Favorites)
- ✅ Live sync of chat exports
- Custom folder icon
- Finder Quick Actions

---

## 🚀 Phase 4: FUTURE - Native File Provider Extension

### Goal
Transform ~/Papr/ into a Dropbox-like cloud storage experience that appears in Finder's "Locations" section with native sync capabilities.

### 4.1 File Provider Extension (Swift)
**What it provides:**
- ✅ Appears in Finder sidebar "Locations" (not just Favorites)
- ✅ On-demand file sync (smart sync) - save disk space
- ✅ Sync status indicators (cloud icons, checkmarks, progress)
- ✅ Background sync even when app is closed
- ✅ System-wide integration (Spotlight, Quick Look, drag & drop)
- ✅ Native conflict resolution UI
- ✅ Offline access control (pin files)
- ✅ Professional UX matching Dropbox/iCloud

**Components to build:**
1. **PaprFileProvider.appex** (Swift)
   - FileProvider framework implementation
   - File enumeration and metadata
   - Upload/download coordination
   - Sync status management

2. **XPC Bridge** (Native Node addon in C++)
   - Communication between Electron ↔ File Provider
   - Send sync commands from Gateway
   - Receive sync status updates

3. **PAPR API Integration**
   - File upload/download via PAPR Memory API
   - Chunk-based transfers for large files
   - Resume interrupted transfers
   - Bandwidth management

**Architecture:**
```
Paprwork.app/
├── Contents/
│   ├── MacOS/Paprwork           # Electron app
│   ├── Resources/app.asar       # Gateway + UI
│   └── PlugIns/
│       └── PaprFileProvider.appex/  # ⭐ File Provider
```

**Communication Flow:**
```
User Action in Finder
    ↓
File Provider Extension (Swift)
    ↓ (XPC)
Gateway FileProviderBridge (TypeScript)
    ↓
PAPR Memory API
```

### 4.2 Implementation Tasks

**Task 1: Create Swift File Provider Extension**
- [ ] Set up Xcode project for PaprFileProvider
- [ ] Implement NSFileProviderExtension
- [ ] Handle file enumeration (list files)
- [ ] Implement upload/download operations
- [ ] Add sync status tracking
- [ ] Configure Info.plist and entitlements

**Task 2: Build XPC Communication Bridge**
- [ ] Create C++ Node.js native addon
- [ ] Implement XPC client for communication
- [ ] Add message queue for async operations
- [ ] Handle errors and reconnection

**Task 3: Gateway Integration**
- [ ] Create FileProviderBridge service
- [ ] Monitor sync status from extension
- [ ] Trigger syncs from Gateway
- [ ] Update UI with sync indicators

**Task 4: Build & Packaging**
- [ ] Configure electron-builder for .appex bundling
- [ ] Add code signing for extension
- [ ] Set up entitlements (File Provider, App Groups)
- [ ] Test DMG packaging with extension

**Task 5: Testing**
- [ ] Test file creation/modification
- [ ] Test upload/download
- [ ] Test conflict resolution
- [ ] Test background sync
- [ ] Test offline mode

### 4.3 Benefits Summary

**For Users:**
- Papr appears in "Locations" like Dropbox
- Files sync automatically in background
- Save disk space with on-demand sync
- Visual sync indicators
- Works even when app is closed

**For Development:**
- Professional, native macOS integration
- Reduced Electron overhead for file operations
- System-optimized performance
- Matches user expectations from cloud storage

### 4.4 Estimated Effort
- **Development**: 1-2 weeks
- **Testing**: 3-5 days
- **Total**: ~2-3 weeks

### 4.5 Prerequisites
- macOS development experience (Swift)
- Apple Developer Program membership (for code signing)
- Understanding of File Provider framework
- XPC communication knowledge

### 4.6 Alternative Considered
**macFUSE approach**: Mount ~/Papr as a volume
- ❌ Requires users to install macFUSE separately
- ❌ Less reliable than native File Provider
- ❌ Doesn't provide sync status indicators
- ❌ Not recommended by Apple

**Decision**: File Provider is the proper, Apple-recommended approach.

---

## 🎯 Current Focus

**Start Phase 2.1**: Create `StorageManager` and integrate with `AgentService`

This will:
1. Initialize the storage provider based on settings
2. Save messages during chat streaming
3. Load message history for LLM context
4. Trigger summarization when needed

Phase 4 (File Provider) will be implemented after Phase 2 & 3 are complete.

Ready to start Phase 2? 🚀
