# Custom Keys Implementation Summary

## Overview

Implemented a complete secure custom API keys system for Paprwork v2, following the same architecture as v1 but adapted for the Gateway architecture.

## Components Created

### 1. Core Storage Layer (`src/core/storage/CustomKeysStorage.ts`)

**Purpose**: Manages encrypted storage of custom keys using Electron's `safeStorage` API (macOS Keychain / Windows DPAPI).

**Key Features**:
- Encryption/decryption using system secure storage
- CRUD operations for custom keys
- Placeholder resolution (`${KEY_NAME}` → actual value)
- Log sanitization (redacts key values from output)
- Atomic file writes with proper error handling

**Methods**:
- `addKey(input)` - Add new encrypted key
- `updateKey(keyId, updates)` - Update existing key
- `deleteKey(keyId)` - Remove key
- `getKey(keyId)` - Get decrypted value
- `getKeyByName(name)` - Get value by name
- `resolvePlaceholders(text, allowedKeys?)` - Replace `${KEY}` with values
- `sanitizeText(text, resolvedKeys)` - Redact values from logs

### 2. Electron IPC Handlers (`src/electron/ipc/customKeys.ts`)

**Purpose**: Bridge between Electron main process and Gateway/UI.

**IPC Channels**:
- `custom-keys:list` - Get all keys (metadata only)
- `custom-keys:get` - Get decrypted value by ID
- `custom-keys:get-by-name` - Get value by name
- `custom-keys:add` - Add new key
- `custom-keys:update` - Update key
- `custom-keys:delete` - Delete key
- `custom-keys:resolve` - Resolve placeholders
- `custom-keys:get-required` - Find `${KEY}` patterns in text

### 3. Gateway Service (`src/gateway/services/CustomKeysService.ts`)

**Purpose**: Gateway bridge to Electron's secure storage (production) or local storage (dev).

**Methods**: Mirror the CustomKeysStorage API but communicate via IPC.

**Behavior**:
- **Production**: Uses IPC to communicate with Electron main process
- **Development**: No-op (prints warnings) - for testing without Electron

### 4. WebSocket Handler (`src/gateway/websocket/customKeys.ts`)

**Purpose**: Handle WebSocket messages from UI and route to CustomKeysService.

**Integration**: Separate connection handler that listens for `custom-keys:*` messages and sends responses back to UI.

### 5. React Hook (`ui/hooks/useCustomKeys.ts`)

**Purpose**: Provides React components with custom keys CRUD operations.

**API**:
```typescript
const {
  keys,           // CustomKey[] - list of keys (metadata only)
  loading,        // boolean
  error,          // string | null
  loadKeys,       // () => Promise<void>
  addKey,         // (input) => Promise<boolean>
  updateKey,      // (id, updates) => Promise<boolean>
  deleteKey,      // (id) => Promise<boolean>
} = useCustomKeys();
```

### 6. Settings UI (`ui/components/Settings/SettingsView.tsx`)

**Enhanced Features**:
- New "Custom API Keys" section in API Keys tab
- Add key form with:
  - Name input (auto-formats to UPPER_CASE)
  - Password input for value
  - Description (optional)
  - Permission radio (Always / Ask Each Time)
- Keys list with:
  - Edit/Delete actions
  - Permission badge (Auto / Ask)
  - Usage syntax `${KEY_NAME}`
  - Inline edit form
- Empty state with helpful hints
- Error display
- Confirmation before delete

### 7. CSS Styles (`ui/components/Settings/SettingsView.css`)

**New Styles**:
- `.custom-keys-error` - Error message styling
- `.custom-keys-empty` - Empty state
- `.custom-keys-list` - List container
- `.custom-key-item` - Individual key card
- `.custom-key-form` - Add/edit form
- `.permission-radios` - Permission selection
- `.custom-key-item__badge` - Permission badge
- Dark mode variants

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────┐
│ User adds key in Settings                                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ useCustomKeys.addKey({ name, value, permission })           │
└──────────────────────┬──────────────────────────────────────┘
                       │ WebSocket
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Gateway: customKeys.ts handler                               │
│  → CustomKeysService.addKey()                               │
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC (production)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Electron: customKeys IPC handler                             │
│  → CustomKeysStorage.addKey()                               │
│  → safeStorage.encryptString(value)                         │
│  → Write to ~/.paprwork/data/custom-keys.json              │
└─────────────────────────────────────────────────────────────┘
```

## Usage in Jobs & Agents

### Example Job Config:

```json
{
  "id": "send-email",
  "name": "Send Email via SendGrid",
  "type": "script",
  "config": {
    "env": {
      "SENDGRID_API_KEY": "${SENDGRID_API_KEY}",
      "FROM_EMAIL": "noreply@example.com"
    }
  },
  "script": "node send-email.js"
}
```

### Runtime Resolution:

```typescript
// 1. Job manager detects ${SENDGRID_API_KEY}
const requiredKeys = customKeysService.getRequiredKeys(config.env);
// Returns: ["SENDGRID_API_KEY"]

// 2. Check permissions
const key = await customKeysService.getKeyByName("SENDGRID_API_KEY");
if (key.permission === "ask") {
  // Show permission dialog to user
  const approved = await showPermissionDialog("SENDGRID_API_KEY");
  if (!approved) throw new Error("Permission denied");
}

// 3. Resolve placeholders
const resolvedEnv = await customKeysService.resolvePlaceholders(
  JSON.stringify(config.env),
  requiredKeys
);

// 4. Spawn job with resolved environment
spawn("node", ["send-email.js"], {
  env: { ...process.env, ...JSON.parse(resolvedEnv) }
});

// 5. Sanitize logs
const sanitized = customKeysService.sanitizeText(
  jobOutput,
  { SENDGRID_API_KEY: actualValue }
);
```

## Security Features

1. **Encryption at Rest**: All key values encrypted using system secure storage
2. **No Plain Text Logs**: Automatic sanitization of key values in output
3. **Permission System**: User control over automated vs. manual approval
4. **No Value Display**: UI never shows actual key values after creation
5. **IPC Isolation**: Keys only accessible via secure IPC channel
6. **Atomic Writes**: File operations use atomic write pattern

## Key Differences from v1

| Feature | v1 | v2 |
|---------|----|----|
| Storage | Electron Main Process | Same, but via Gateway |
| IPC | Direct IPC | IPC → Gateway → WebSocket → UI |
| UI | Modal | Settings page tab |
| Dev Mode | Full encryption | No-op (warnings only) |
| Architecture | Monolithic Electron | Decoupled Gateway + Electron |

## Files Modified

### New Files:
- `src/core/storage/CustomKeysStorage.ts`
- `src/electron/ipc/customKeys.ts`
- `src/gateway/services/CustomKeysService.ts`
- `src/gateway/websocket/customKeys.ts`
- `ui/hooks/useCustomKeys.ts`
- `docs/CUSTOM_KEYS.md`

### Modified Files:
- `src/electron/index.ts` - Initialize CustomKeysStorage
- `src/gateway/websocket/index.ts` - Register custom keys handlers
- `ui/components/Settings/SettingsView.tsx` - Add custom keys UI
- `ui/components/Settings/SettingsView.css` - Add custom keys styles
- `tsconfig.electron.json` - Include src/core in compilation

## Testing Checklist

- [x] TypeScript compilation (0 errors)
- [x] ESLint (0 warnings, 0 errors)
- [x] Code formatting
- [ ] Add key in Settings UI
- [ ] Edit key in Settings UI
- [ ] Delete key in Settings UI
- [ ] View keys list
- [ ] Empty state display
- [ ] Permission selection (Always / Ask)
- [ ] Key storage in `~/.paprwork/data/custom-keys.json`
- [ ] Encryption verification (file should contain base64 strings)
- [ ] Placeholder resolution in job config
- [ ] Log sanitization
- [ ] IPC communication in production mode
- [ ] WebSocket communication from UI

## Next Steps

1. **Test in running app**: Start dev server and test full flow
2. **Add permission dialogs**: Implement "Ask Each Time" approval UI
3. **Job integration**: Wire up key resolution in JobsService
4. **Agent tool integration**: Add key access to agent tools
5. **Import from v1**: Add migration utility (optional)
6. **Key rotation**: Add "Test Connection" button for API keys
7. **Usage tracking**: Log which keys are used by which jobs

## Documentation

Full documentation available in:
- `/docs/CUSTOM_KEYS.md` - User guide and API reference
- Inline JSDoc comments in all source files
- TypeScript interfaces with detailed property descriptions
