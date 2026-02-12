# API Key Permissions & System Prompt - Implementation Status

**Date:** 2026-02-12  
**Status:** Foundation Complete, Remaining Phases Ready for Implementation

---

## ✅ Completed (Phase 1 + Prompt)

### 1. System Prompt Builder ✅
**File:** `src/core/agents/SystemPrompt.ts`

Complete system prompt matching V1's structure with:
- Identity section
- Tool call style guidelines
- API key management workflow (list, request, use)
- Bash tool documentation with examples
- Filesystem tools documentation
- Security guidelines
- Agent behavior rules
- Narration guidelines

**Key Features:**
- Explains `${KEY_NAME}` syntax for keys in bash
- Documents permission system (ask vs always)
- Lists available environment and custom keys
- Provides clear examples for all tools

### 2. Permission Types ✅
**File:** `src/core/types/permissions.ts`

```typescript
export type PermissionLevel = "open" | "moderate" | "strict";
export type KeyPermission = "ask" | "always";

export interface KeyPermissionRequest {
  keyName: string;
  description: string;
  isEnvKey: boolean;
  toolContext?: { toolName: string; command?: string };
}

export interface KeyPermissionResponse {
  approved: boolean;
  alwaysAllow?: boolean;
}

export interface PermissionSettings {
  permissionLevel: PermissionLevel;
  requireConfirmForBash: boolean;
  requireConfirmForFileWrite: boolean;
  requireConfirmForBrowser: boolean;
}
```

### 3. Storage Layer ✅
**Files:**
- `src/core/storage/KeyPermissionsStorage.ts` - Environment key permissions
- `src/core/storage/SettingsStorage.ts` (updated) - Permission settings
- `src/core/storage/index.ts` - Exports

**Key Permissions Storage:**
```typescript
class KeyPermissionsStorage {
  getPermission(keyName: string): KeyPermission;
  setPermission(keyName: string, permission: KeyPermission): void;
  shouldAskPermission(keyName: string): boolean;
  getAlwaysAllowedKeys(): string[];
  resetPermission(keyName: string): void;
}
```

**Settings Storage (enhanced):**
```typescript
class SettingsStorage {
  getPermissionLevel(): PermissionLevel;
  setPermissionLevel(level: PermissionLevel): void;
  getPermissionSettings(): PermissionSettings;
  setPermissionSettings(settings: Partial<PermissionSettings>): void;
  getToolPermission(tool: "bash" | "fileWrite" | "browser"): boolean;
}
```

### 4. Permission-Aware Key Substitution ✅
**File:** `src/core/tools/security.ts` (updated)

```typescript
export async function substituteCustomKeysWithPermission(
  command: string,
  customKeys: Record<string, string>,
  context: { toolName: string; command?: string },
  onPermissionRequest?: PermissionRequestCallback
): Promise<string>
```

**Features:**
- Finds all keys used in command
- Requests permission for each key
- Throws error if denied
- Substitutes approved keys
- Falls back to simple substitution if no callback

---

## ⏳ Remaining Implementation

### Phase 2: Tool Integration (1 hour)

**Update Bash Tool** (`src/core/tools/bash.ts`):
```typescript
// Instead of simple substitution:
command = substituteCustomKeys(command, customKeys);

// Use permission-aware version:
try {
  command = await substituteCustomKeysWithPermission(
    command,
    customKeys,
    { toolName: 'bash', command: input.command },
    async (keyName, context) => {
      // Request permission via IPC
      return await requestKeyPermission({
        keyName,
        description: `Allow ${keyName} in bash command?`,
        isEnvKey: isEnvironmentKey(keyName),
        toolContext: context,
      });
    }
  );
} catch (error) {
  return {
    success: false,
    error: `Permission denied: ${error.message}`,
    type: 'permission_error',
  };
}
```

### Phase 3: IPC Infrastructure (45 minutes)

**Add to `src/electron/index.cjs`:**
```javascript
// Permission state
const pendingPermissionRequests = new Map();

// Load additional storage
let KeyPermissionsStorage, SettingsStorage;

async function loadESMModules() {
  const storageModule = await import("../../dist/electron/core/storage/index.js");
  CustomKeysStorage = storageModule.CustomKeysStorage;
  KeyPermissionsStorage = storageModule.KeyPermissionsStorage;
  SettingsStorage = storageModule.SettingsStorage;
  
  const ipcModule = await import("../../dist/electron/electron/ipc/customKeys.js");
  initializeCustomKeysIPC = ipcModule.initializeCustomKeysIPC;
  
  const permIpcModule = await import("../../dist/electron/electron/ipc/permissions.js");
  initializePermissionsIPC = permIpcModule.initializePermissionsIPC;
}

// In app.whenReady():
const keyPermissionsStorage = new KeyPermissionsStorage();
const settingsStorage = new SettingsStorage();
await keyPermissionsStorage.initialize();
await settingsStorage.initialize();

initializePermissionsIPC(keyPermissionsStorage, settingsStorage, mainWindow);
```

**Create `src/electron/ipc/permissions.ts`:**
```typescript
import { ipcMain } from 'electron';
import type { KeyPermissionsStorage } from '../../core/storage/KeyPermissionsStorage.js';
import type { SettingsStorage } from '../../core/storage/SettingsStorage.js';
import type {
  KeyPermissionRequest,
  KeyPermissionResponse,
} from '../../core/types/permissions.js';

const pendingRequests = new Map<string, (response: KeyPermissionResponse) => void>();

export function initializePermissionsIPC(
  keyPermStorage: KeyPermissionsStorage,
  settingsStorage: SettingsStorage,
  mainWindow: BrowserWindow
) {
  // Request permission (called from Gateway via IPC bridge)
  ipcMain.handle('permissions:request-key', async (event, request: KeyPermissionRequest) => {
    // Check if key has "always" permission
    if (request.isEnvKey && keyPermStorage.getPermission(request.keyName) === 'always') {
      return { approved: true };
    }
    
    // Generate unique ID for this request
    const requestId = `perm-${Date.now()}-${Math.random()}`;
    
    // Send to renderer
    mainWindow.webContents.send('permissions:key-request', {
      ...request,
      requestId,
    });
    
    // Wait for response
    return new Promise((resolve) => {
      pendingRequests.set(requestId, resolve);
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          resolve({ approved: false });
        }
      }, 30000);
    });
  });
  
  // Response from renderer
  ipcMain.on('permissions:key-response', (event, data) => {
    const { requestId, response } = data;
    const resolver = pendingRequests.get(requestId);
    
    if (resolver) {
      // Save "always allow" if requested
      if (response.approved && response.alwaysAllow) {
        keyPermStorage.setPermission(data.keyName, 'always');
      }
      
      resolver(response);
      pendingRequests.delete(requestId);
    }
  });
  
  // Get all permissions
  ipcMain.handle('permissions:get-all', async () => {
    return {
      keyPermissions: keyPermStorage.getAll(),
      settings: settingsStorage.getPermissionSettings(),
    };
  });
  
  // Update settings
  ipcMain.handle('permissions:update-settings', async (event, settings) => {
    settingsStorage.setPermissionSettings(settings);
  });
  
  // Reset key permission
  ipcMain.handle('permissions:reset-key', async (event, keyName) => {
    keyPermStorage.resetPermission(keyName);
  });
}
```

**Update `src/electron/preload.cjs`:**
```javascript
contextBridge.exposeInMainWorld("permissions", {
  requestKey: (request) => ipcRenderer.invoke("permissions:request-key", request),
  onKeyRequest: (callback) => ipcRenderer.on("permissions:key-request", callback),
  respondToRequest: (response) => ipcRenderer.send("permissions:key-response", response),
  getAll: () => ipcRenderer.invoke("permissions:get-all"),
  updateSettings: (settings) => ipcRenderer.invoke("permissions:update-settings", settings),
  resetKey: (keyName) => ipcRenderer.invoke("permissions:reset-key", keyName),
});
```

### Phase 4: UI Components (1 hour)

**Create `ui/components/Permissions/KeyPermissionModal.tsx`:**
```tsx
import React, { useState } from 'react';
import type { KeyPermissionRequest, KeyPermissionResponse } from '../../types/permissions';
import './KeyPermissionModal.css';

interface Props {
  request: KeyPermissionRequest & { requestId: string };
  onResponse: (response: KeyPermissionResponse & { requestId: string; keyName: string }) => void;
}

export function KeyPermissionModal({ request, onResponse }: Props) {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  
  const handleApprove = () => {
    onResponse({
      requestId: request.requestId,
      keyName: request.keyName,
      approved: true,
      alwaysAllow: request.isEnvKey ? alwaysAllow : undefined,
    });
  };
  
  const handleDeny = () => {
    onResponse({
      requestId: request.requestId,
      keyName: request.keyName,
      approved: false,
    });
  };
  
  return (
    <div className="modal-overlay" onClick={handleDeny}>
      <div className="key-permission-modal" onClick={(e) => e.stopPropagation()}>
        <h2>🔑 API Key Permission Request</h2>
        
        <div className="permission-details">
          <div className="detail-row">
            <span className="label">Tool:</span>
            <code>{request.toolContext?.toolName || 'Unknown'}</code>
          </div>
          <div className="detail-row">
            <span className="label">Key:</span>
            <code>{request.keyName}</code>
          </div>
          {request.toolContext?.command && (
            <div className="detail-row">
              <span className="label">Command:</span>
              <code className="command-preview">{request.toolContext.command}</code>
            </div>
          )}
        </div>
        
        <p className="description">{request.description}</p>
        
        {request.isEnvKey && (
          <label className="always-allow-checkbox">
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
            />
            <span>Always allow this key (don't ask again)</span>
          </label>
        )}
        
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={handleDeny}>
            Deny
          </button>
          <button className="btn btn-primary" onClick={handleApprove}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Create `ui/hooks/useKeyPermissions.ts`:**
```typescript
import { useState, useEffect, useCallback } from 'react';
import type { KeyPermissionRequest } from '../types/permissions';

export function useKeyPermissions() {
  const [activeRequest, setActiveRequest] = useState<(KeyPermissionRequest & { requestId: string }) | null>(null);
  
  useEffect(() => {
    const handler = (_event: any, request: KeyPermissionRequest & { requestId: string }) => {
      setActiveRequest(request);
    };
    
    window.permissions.onKeyRequest(handler);
    
    return () => {
      // Cleanup if needed
    };
  }, []);
  
  const handleResponse = useCallback((response: any) => {
    window.permissions.respondToRequest(response);
    setActiveRequest(null);
  }, []);
  
  return {
    activeRequest,
    handleResponse,
  };
}
```

**Update `ui/App.tsx`:**
```tsx
import { KeyPermissionModal } from './components/Permissions/KeyPermissionModal';
import { useKeyPermissions } from './hooks/useKeyPermissions';

export function App() {
  const { activeRequest, handleResponse } = useKeyPermissions();
  
  return (
    <>
      {/* Existing app UI */}
      {activeRequest && (
        <KeyPermissionModal
          request={activeRequest}
          onResponse={handleResponse}
        />
      )}
    </>
  );
}
```

**Update `ui/components/Settings/PermissionsTab.tsx`:**
```tsx
// Add UI for viewing/resetting key permissions
// Show permission level dropdown
// Show tool-specific confirmation toggles
// List all keys with "always" permission and reset buttons
```

### Phase 5: Agent Service Integration (30 minutes)

**Update `src/gateway/services/AgentService.ts`:**
```typescript
import { buildSystemPrompt } from '../../core/agents/SystemPrompt.js';

// In initialize():
async initialize() {
  // ... existing code ...
  
  // Build system prompt with custom keys
  const customKeys = await this.loadCustomKeys();
  this.systemPrompt = buildSystemPrompt({
    userDataPath: this.userDataPath,
    workspacePath: process.cwd(),
    availableTools: allTools.map(t => t.id),
    customKeys,
  });
}

// In streamAgent(), add system prompt:
if (!messages.some(m => m.role === 'system')) {
  messages.unshift({
    role: 'system',
    content: this.systemPrompt,
  });
}
```

---

## Integration Flow

```
User runs bash with ${KEY} 
  ↓
Bash Tool → substituteCustomKeysWithPermission()
  ↓
Calls onPermissionRequest callback
  ↓
Gateway → Main Process IPC (permissions:request-key)
  ↓
Main Process → Renderer (permissions:key-request)
  ↓
Renderer shows KeyPermissionModal
  ↓
User clicks Allow/Deny (optionally "Always allow")
  ↓
Renderer → Main Process (permissions:key-response)
  ↓
Main Process saves "always" if checked
  ↓
Main Process → Gateway IPC response
  ↓
Gateway → Bash Tool → Substitutes key or throws error
  ↓
Bash executes with substituted key
  ↓
Output is sanitized (keys → ***)
  ↓
Streamed to UI
```

---

## Testing Plan

### 1. Unit Tests
- KeyPermissionsStorage CRUD operations
- substituteCustomKeysWithPermission logic
- System prompt generation

### 2. Integration Tests
- IPC flow (request → response)
- Permission saving
- "Always allow" functionality

### 3. E2E Tests
1. **First Use:**
   - Run bash with `${OPENAI_API_KEY}`
   - Modal appears
   - User clicks "Allow" + "Always allow"
   - Command executes
   - Output shows `***`

2. **Always Allowed:**
   - Run bash with same key
   - No modal appears
   - Command executes immediately

3. **Permission Denied:**
   - Run bash with different key
   - User clicks "Deny"
   - Error message shown
   - Command does not execute

4. **Settings Management:**
   - View all key permissions
   - Reset a key to "ask"
   - Next use prompts again

---

## Current Status Summary

✅ **Complete:**
- System prompt builder
- Permission types & interfaces
- Storage layer (KeyPermissionsStorage, SettingsStorage)
- Permission-aware key substitution function

⏳ **Remaining (~3 hours):**
- Update bash tool to use permission checking
- Create IPC handlers (permissions.ts)
- Create UI components (KeyPermissionModal, updated PermissionsTab)
- Integrate system prompt into AgentService
- End-to-end testing

---

## Next Steps

1. **Implement Phase 2:** Update bash tool (~15 min)
2. **Implement Phase 3:** IPC infrastructure (~45 min)
3. **Implement Phase 4:** UI components (~1 hour)
4. **Implement Phase 5:** Agent integration (~30 min)
5. **Test end-to-end:** All scenarios (~30 min)

**Total Remaining:** ~3 hours of focused implementation

---

## Files Checklist

### ✅ Created/Updated:
- `src/core/agents/SystemPrompt.ts` (new)
- `src/core/types/permissions.ts` (new)
- `src/core/storage/KeyPermissionsStorage.ts` (new)
- `src/core/storage/SettingsStorage.ts` (updated)
- `src/core/storage/index.ts` (new)
- `src/core/types/storage.ts` (updated)
- `src/core/types/index.ts` (updated)
- `src/core/tools/security.ts` (updated)

### ⏳ Need to Create:
- `src/electron/ipc/permissions.ts`
- `ui/components/Permissions/KeyPermissionModal.tsx`
- `ui/components/Permissions/KeyPermissionModal.css`
- `ui/hooks/useKeyPermissions.ts`
- `ui/types/permissions.ts`

### ⏳ Need to Update:
- `src/electron/index.cjs`
- `src/electron/preload.cjs`
- `src/core/tools/bash.ts`
- `src/gateway/services/AgentService.ts`
- `ui/types/electron.d.ts`
- `ui/components/Settings/PermissionsTab.tsx`
- `ui/App.tsx`

---

**Ready to continue with Phase 2-5 implementation!**
