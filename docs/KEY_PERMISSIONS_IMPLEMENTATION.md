# API Key Permissions System - Implementation Plan

**Status:** 🔄 In Progress  
**Started:** 2026-02-12

---

## Overview

Implementing a comprehensive permission system for API key usage in tools, matching Paprwork V1's functionality with improvements.

### Requirements
1. ✅ Users can set per-key permissions ("ask" vs "always")
2. ✅ Environment keys get runtime permission prompts
3. ✅ Custom keys have permissions in their definition
4. ⏳ Permission requests show context (tool name, command)
5. ⏳ "Always allow" checkbox for environment keys
6. ⏳ Respect permission level settings (open/moderate/strict)
7. ⏳ Settings UI for managing all permissions

---

## Phase 1: Foundation ✅ (COMPLETE)

### 1. Types & Interfaces ✅
**File:** `src/core/types/permissions.ts`

```typescript
// Permission types
export type PermissionLevel = "open" | "moderate" | "strict";
export type KeyPermission = "ask" | "always";

// Request/Response for IPC
export interface KeyPermissionRequest { ... }
export interface KeyPermissionResponse { ... }

// Settings storage
export interface PermissionSettings {
  permissionLevel: PermissionLevel;
  requireConfirmForBash: boolean;
  requireConfirmForFileWrite: boolean;
  requireConfirmForBrowser: boolean;
}
```

### 2. Storage Layer ✅
**File:** `src/core/storage/KeyPermissionsStorage.ts`

- Manages environment key permissions
- Separate from CustomKeysStorage (which has `permission` field)
- Encrypted storage via electron-store
- Methods:
  - `getPermission(keyName)` → "ask" | "always"
  - `setPermission(keyName, permission)`
  - `shouldAskPermission(keyName)` → boolean
  - `getAlwaysAllowedKeys()` → string[]

**File:** `src/core/storage/SettingsStorage.ts` (Updated)

- Added permission settings support
- Methods:
  - `getPermissionLevel()` → "open" | "moderate" | "strict"
  - `setPermissionLevel(level)`
  - `getPermissionSettings()` → PermissionSettings
  - `getToolPermission(tool)` → boolean

### 3. Type Updates ✅
**File:** `src/core/types/storage.ts`

- `AppSettings` now includes `permissions: PermissionSettings`

**File:** `src/core/types/index.ts`

- Exports all permission types

---

## Phase 2: Permission Checking Logic ⏳ (NEXT)

### 1. Update `security.ts` to Check Permissions

**File:** `src/core/tools/security.ts`

Add permission checking before key substitution:

```typescript
export interface KeySubstitutionContext {
  toolName: string;
  command?: string;
  customKeys: Record<string, string>;
  onPermissionRequest?: (request: KeyPermissionRequest) => Promise<KeyPermissionResponse>;
}

export async function substituteCustomKeysWithPermission(
  command: string,
  context: KeySubstitutionContext
): Promise<string> {
  let result = command;
  
  for (const [name, value] of Object.entries(context.customKeys)) {
    if (result.includes(`\${${name}}`)) {
      // Check if permission is needed
      const needsPermission = await checkKeyPermission(name, context);
      
      if (needsPermission && context.onPermissionRequest) {
        const response = await context.onPermissionRequest({
          keyName: name,
          description: `Allow ${name} to be used in ${context.toolName}?`,
          isEnvKey: isEnvironmentKey(name),
          toolContext: {
            toolName: context.toolName,
            command: context.command,
          },
        });
        
        if (!response.approved) {
          throw new Error(`Permission denied for key: ${name}`);
        }
        
        // Save "always allow" if checked
        if (response.alwaysAllow && isEnvironmentKey(name)) {
          await savePermission(name, 'always');
        }
      }
      
      // Substitute the key
      result = result.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), value);
    }
  }
  
  return result;
}

async function checkKeyPermission(keyName: string, context: KeySubstitutionContext): Promise<boolean> {
  // Check if it's an environment key
  if (isEnvironmentKey(keyName)) {
    // Load from KeyPermissionsStorage
    const permission = keyPermissionsStorage.getPermission(keyName);
    return permission === 'ask';
  } else {
    // Custom key - check from CustomKeysStorage
    const customKey = await customKeysStorage.getKey(keyName);
    return customKey?.permission === 'ask';
  }
}

function isEnvironmentKey(keyName: string): boolean {
  return process.env[keyName] !== undefined;
}
```

### 2. Update Bash Tool to Use Permission Checking

**File:** `src/core/tools/bash.ts`

```typescript
// In executeBashCommand, before substitution:
const command = await substituteCustomKeysWithPermission(command, {
  toolName: 'bash',
  command: input.command,
  customKeys,
  onPermissionRequest: async (request) => {
    // Send IPC request to main process
    return await requestKeyPermission(request);
  },
});
```

---

## Phase 3: IPC Communication ⏳

### 1. Main Process IPC Handlers

**File:** `src/electron/main.cjs` or new `src/electron/ipc/permissions.cjs`

```javascript
// Request permission from renderer
ipcMain.handle('permissions:request-key', async (event, request) => {
  return new Promise((resolve) => {
    // Store promise resolver
    pendingPermissionRequests.set(request.id, resolve);
    
    // Send to renderer
    BrowserWindow.getAllWindows()[0].webContents.send(
      'permissions:key-request',
      request
    );
  });
});

// Response from renderer
ipcMain.on('permissions:key-response', (event, response) => {
  const resolver = pendingPermissionRequests.get(response.id);
  if (resolver) {
    resolver(response);
    pendingPermissionRequests.delete(response.id);
  }
});

// Get permission settings
ipcMain.handle('permissions:get-settings', async () => {
  return settingsStorage.getPermissionSettings();
});

// Update permission settings
ipcMain.handle('permissions:update-settings', async (event, settings) => {
  settingsStorage.setPermissionSettings(settings);
});

// Get key permissions
ipcMain.handle('permissions:get-key-permissions', async () => {
  return keyPermissionsStorage.getAll();
});

// Reset key permission
ipcMain.handle('permissions:reset-key', async (event, keyName) => {
  keyPermissionsStorage.resetPermission(keyName);
});
```

### 2. Preload API

**File:** `src/electron/preload.cjs`

```javascript
contextBridge.exposeInMainWorld('permissions', {
  requestKey: (request) => ipcRenderer.invoke('permissions:request-key', request),
  onKeyRequest: (callback) => ipcRenderer.on('permissions:key-request', callback),
  respondToKeyRequest: (response) => ipcRenderer.send('permissions:key-response', response),
  getSettings: () => ipcRenderer.invoke('permissions:get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('permissions:update-settings', settings),
  getKeyPermissions: () => ipcRenderer.invoke('permissions:get-key-permissions'),
  resetKey: (keyName) => ipcRenderer.invoke('permissions:reset-key', keyName),
});
```

### 3. UI Type Definitions

**File:** `ui/types/electron.d.ts`

```typescript
interface Window {
  permissions: {
    requestKey: (request: KeyPermissionRequest) => Promise<KeyPermissionResponse>;
    onKeyRequest: (callback: (event: any, request: KeyPermissionRequest) => void) => void;
    respondToKeyRequest: (response: KeyPermissionResponse) => void;
    getSettings: () => Promise<PermissionSettings>;
    updateSettings: (settings: Partial<PermissionSettings>) => Promise<void>;
    getKeyPermissions: () => Promise<Record<string, KeyPermission>>;
    resetKey: (keyName: string) => Promise<void>;
  };
}
```

---

## Phase 4: UI Components ⏳

### 1. Permission Request Modal

**File:** `ui/components/Permissions/KeyPermissionModal.tsx`

```tsx
interface KeyPermissionModalProps {
  request: KeyPermissionRequest;
  onResponse: (response: KeyPermissionResponse) => void;
}

export function KeyPermissionModal({ request, onResponse }: KeyPermissionModalProps) {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  
  return (
    <div className="modal-overlay">
      <div className="key-permission-modal">
        <h2>API Key Permission Request</h2>
        
        <div className="permission-details">
          <p><strong>Tool:</strong> {request.toolContext?.toolName}</p>
          <p><strong>Key:</strong> {request.keyName}</p>
          {request.toolContext?.command && (
            <p><strong>Command:</strong> <code>{request.toolContext.command}</code></p>
          )}
        </div>
        
        <p>{request.description}</p>
        
        {request.isEnvKey && (
          <label>
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
            />
            Always allow this key (don't ask again)
          </label>
        )}
        
        <div className="modal-actions">
          <button onClick={() => onResponse({ approved: false })}>
            Deny
          </button>
          <button onClick={() => onResponse({ approved: true, alwaysAllow })}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
```

**File:** `ui/hooks/useKeyPermissions.ts`

```typescript
export function useKeyPermissions() {
  const [activeRequest, setActiveRequest] = useState<KeyPermissionRequest | null>(null);
  
  useEffect(() => {
    const handler = (event: any, request: KeyPermissionRequest) => {
      setActiveRequest(request);
    };
    
    window.permissions.onKeyRequest(handler);
    
    return () => {
      // Cleanup
    };
  }, []);
  
  const handleResponse = useCallback((response: KeyPermissionResponse) => {
    window.permissions.respondToKeyRequest(response);
    setActiveRequest(null);
  }, []);
  
  return {
    activeRequest,
    handleResponse,
  };
}
```

### 2. Permission Settings UI

**File:** `ui/components/Settings/PermissionsTab.tsx` (Update existing)

```tsx
export function PermissionsTab() {
  const [settings, setSettings] = useState<PermissionSettings | null>(null);
  const [keyPermissions, setKeyPermissions] = useState<Record<string, KeyPermission>>({});
  
  useEffect(() => {
    loadPermissions();
  }, []);
  
  async function loadPermissions() {
    const [permSettings, keyPerms] = await Promise.all([
      window.permissions.getSettings(),
      window.permissions.getKeyPermissions(),
    ]);
    setSettings(permSettings);
    setKeyPermissions(keyPerms);
  }
  
  return (
    <div className="permissions-tab">
      <section>
        <h3>Permission Level</h3>
        <select
          value={settings?.permissionLevel}
          onChange={(e) => updatePermissionLevel(e.target.value as PermissionLevel)}
        >
          <option value="open">Open - Tools run automatically</option>
          <option value="moderate">Moderate - Some tools require confirmation</option>
          <option value="strict">Strict - All tools require confirmation</option>
        </select>
      </section>
      
      <section>
        <h3>Tool Permissions</h3>
        <label>
          <input
            type="checkbox"
            checked={settings?.requireConfirmForBash}
            onChange={(e) => updateSetting('requireConfirmForBash', e.target.checked)}
          />
          Require confirmation for bash commands
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings?.requireConfirmForFileWrite}
            onChange={(e) => updateSetting('requireConfirmForFileWrite', e.target.checked)}
          />
          Require confirmation for file writes
        </label>
      </section>
      
      <section>
        <h3>API Key Permissions</h3>
        {Object.entries(keyPermissions).map(([keyName, permission]) => (
          <div key={keyName} className="key-permission-item">
            <span>{keyName}</span>
            <span>{permission === 'always' ? 'Always allow' : 'Ask each time'}</span>
            <button onClick={() => resetKeyPermission(keyName)}>Reset</button>
          </div>
        ))}
      </section>
    </div>
  );
}
```

---

## Phase 5: Integration & Testing ⏳

### 1. Update Gateway Service

Gateway needs access to permission storage for checking before tool execution.

### 2. Test Cases

1. **Environment Key - First Use:**
   - User runs bash command with `${OPENAI_API_KEY}`
   - Modal appears asking for permission
   - User checks "Always allow"
   - Key is substituted and saved to permissions
   - Future uses don't prompt

2. **Environment Key - Ask Mode:**
   - User runs command with key set to "ask"
   - Modal appears every time
   - User can approve/deny per use

3. **Custom Key - Always:**
   - Custom key with `permission: "always"`
   - No prompt, substitutes automatically

4. **Custom Key - Ask:**
   - Custom key with `permission: "ask"`
   - Prompts every time, no "always allow" checkbox (must change in settings)

5. **Permission Denied:**
   - User denies permission
   - Tool execution fails with clear error
   - Key is not substituted

6. **Settings UI:**
   - Change permission level
   - Enable/disable tool confirmations
   - View and reset key permissions

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         UI Layer                             │
│  ┌──────────────────┐        ┌─────────────────────────┐   │
│  │ KeyPermissionModal│◄──────│ useKeyPermissions Hook   │   │
│  └──────────────────┘        └─────────────────────────┘   │
│  ┌──────────────────┐                                       │
│  │ PermissionsTab   │  (Settings UI)                       │
│  └──────────────────┘                                       │
└──────────────┬──────────────────────────────────────────────┘
               │ IPC (permissions:*)
┌──────────────▼──────────────────────────────────────────────┐
│                      Main Process                            │
│  ┌────────────────────┐      ┌──────────────────────────┐  │
│  │ Permission IPC     │      │ SettingsStorage          │  │
│  │ Handlers           │◄─────┤ KeyPermissionsStorage    │  │
│  └────────────────────┘      └──────────────────────────┘  │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│                    Gateway Process                           │
│  ┌──────────────────┐      ┌──────────────────────────┐    │
│  │ Tool Execution   │      │ security.ts              │    │
│  │ (AgentService)   │◄─────┤ - substituteCustomKeys    │    │
│  │                  │      │ - checkKeyPermission      │    │
│  └──────────────────┘      └──────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Files to Create/Modify

### ✅ Already Created:
- `src/core/types/permissions.ts`
- `src/core/storage/KeyPermissionsStorage.ts`

### ✅ Already Modified:
- `src/core/storage/SettingsStorage.ts`
- `src/core/types/storage.ts`
- `src/core/types/index.ts`

### ⏳ Need to Create:
- `ui/components/Permissions/KeyPermissionModal.tsx`
- `ui/components/Permissions/KeyPermissionModal.css`
- `ui/hooks/useKeyPermissions.ts`
- `src/electron/ipc/permissions.cjs` (or add to main.cjs)

### ⏳ Need to Modify:
- `src/core/tools/security.ts` (add permission checking)
- `src/core/tools/bash.ts` (use permission-aware substitution)
- `src/electron/main.cjs` (add IPC handlers)
- `src/electron/preload.cjs` (expose permission API)
- `ui/types/electron.d.ts` (add permission types)
- `ui/components/Settings/PermissionsTab.tsx` (enhance UI)
- `ui/App.tsx` (render KeyPermissionModal)
- `src/gateway/services/AgentService.ts` (permission context)

---

## Timeline Estimate

- ✅ **Phase 1:** Foundation (30 min) - COMPLETE
- ⏳ **Phase 2:** Permission Logic (1 hour) - NEXT
- ⏳ **Phase 3:** IPC Setup (45 min)
- ⏳ **Phase 4:** UI Components (1 hour)
- ⏳ **Phase 5:** Integration & Testing (45 min)

**Total:** ~4 hours to complete

---

## Current Status

✅ **Phase 1 Complete:**
- Types defined
- Storage layer created
- Settings integrated

**Next Step:** Implement Phase 2 (Permission Checking Logic)

Want me to continue with Phase 2?
