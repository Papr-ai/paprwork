# Custom API Keys - Secure Storage System

## Overview

Paprwork v2 implements a secure custom API keys system that allows users to add their own API keys for use in jobs, agent tools, and automations. Keys are stored securely using:

- **macOS**: System Keychain (via Electron's `safeStorage`)
- **Windows**: DPAPI (Data Protection API)
- **Linux**: Secret Service API / libsecret

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ UI (React)                                                   │
│  • Settings page with custom keys management                │
│  • useCustomKeys hook for CRUD operations                   │
└──────────────────────┬──────────────────────────────────────┘
                       │ WebSocket
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Gateway (Node.js)                                            │
│  • CustomKeysService (WebSocket handlers)                   │
│  • Routes WS messages to Electron                           │
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC (production) / No-op (dev)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Electron Main Process                                        │
│  • CustomKeysStorage (uses safeStorage)                     │
│  • IPC handlers for key operations                          │
│  • File: ~/.paprwork/data/custom-keys.json (encrypted)     │
└─────────────────────────────────────────────────────────────┘
```

## Key Features

### 1. **Secure Storage**

Keys are encrypted using Electron's `safeStorage` API:

```typescript
// Encryption (automatically uses Keychain on macOS)
const encryptedValue = safeStorage.encryptString(value).toString("base64");

// Decryption
const value = safeStorage.decryptString(Buffer.from(encryptedValue, "base64"));
```

Storage file: `~/.paprwork/data/custom-keys.json` contains only encrypted values.

### 2. **Permission System**

Each key has a permission level:

- **Always Allow**: Jobs and tools can use automatically (for automation)
- **Ask Each Time**: User must approve each use (more secure for sensitive keys)

### 3. **Usage in Jobs & Agents**

Use custom keys with placeholder syntax: `${KEY_NAME}`

Example job config:

```json
{
  "id": "amplitude-tracker",
  "name": "Track Amplitude Event",
  "type": "script",
  "config": {
    "env": {
      "AMPLITUDE_API_KEY": "${AMPLITUDE_API_KEY}",
      "AMPLITUDE_SECRET_KEY": "${AMPLITUDE_SECRET_KEY}"
    }
  }
}
```

At runtime:
- Gateway calls `CustomKeysService.resolvePlaceholders(config.env)`
- Only keys with `permission: "always"` are auto-resolved
- Keys with `permission: "ask"` trigger user confirmation dialog
- Resolved keys are injected into process environment
- **Actual values are never logged** (sanitized in output)

### 4. **Log Sanitization**

All logs and error messages automatically sanitize API key values:

```typescript
// Before: "Error: Authentication failed with key sk-ant-1234567890abcdef"
// After:  "Error: Authentication failed with key ***ANTHROPIC_KEY_REDACTED***"
```

Patterns detected and redacted:
- Custom key values (from resolved keys)
- Common API key patterns (`sk-...`, `Bearer ...`, etc.)

## UI Components

### Settings Page

Navigate to: **Settings → API Keys → Custom API Keys**

Features:
- **Add Key**: Enter name, value, description, and permission level
- **Edit Key**: Update any field (value is optional - leave empty to keep current)
- **Delete Key**: Remove a key (requires confirmation)
- **View Usage**: Shows placeholder syntax `${KEY_NAME}` for easy reference

### Key Naming Convention

- Use `UPPER_CASE` with underscores
- Must start with a letter or underscore
- Only alphanumeric and underscore characters
- Examples: `AMPLITUDE_API_KEY`, `MY_SERVICE_TOKEN`

## API Reference

### React Hook: `useCustomKeys()`

```typescript
import { useCustomKeys } from "../../hooks/useCustomKeys";

function MyComponent() {
  const { keys, loading, error, addKey, updateKey, deleteKey } = useCustomKeys();

  // Add a new key
  await addKey({
    name: "MY_API_KEY",
    value: "secret-value-123",
    description: "API key for MyService",
    permission: "ask", // or "always"
  });

  // Update a key
  await updateKey(keyId, {
    value: "new-secret-value", // optional
    description: "Updated description",
    permission: "always",
  });

  // Delete a key
  await deleteKey(keyId);
}
```

### CustomKeysService (Gateway)

```typescript
import { CustomKeysService } from "./services/CustomKeysService";

const service = new CustomKeysService();

// List all keys (metadata only, no values)
const keys = await service.listKeys();

// Get decrypted value
const value = await service.getKeyByName("MY_API_KEY");

// Resolve placeholders in text
const resolved = await service.resolvePlaceholders(
  "curl -H 'Authorization: Bearer ${MY_API_KEY}' ...",
  ["MY_API_KEY"] // optional: explicitly allowed keys
);
```

### CustomKeysStorage (Electron)

```typescript
import { CustomKeysStorage } from "./core/storage/CustomKeysStorage";

const storage = new CustomKeysStorage();
await storage.initialize();

// Add key
await storage.addKey({
  name: "MY_KEY",
  value: "secret",
  permission: "always",
});

// Get required key names from text
const required = storage.getRequiredKeys("Uses ${KEY1} and ${KEY2}");
// Returns: ["KEY1", "KEY2"]

// Sanitize logs
const sanitized = storage.sanitizeText(
  "API call with key: secret-value",
  { MY_KEY: "secret-value" }
);
// Returns: "API call with key: ***MY_KEY_REDACTED***"
```

## Security Best Practices

1. **Use "Ask Each Time" for sensitive keys**: OAuth tokens, financial API keys
2. **Use "Always Allow" for automation**: Analytics, logging, non-sensitive services
3. **Never commit keys to code**: Always use `${KEY_NAME}` placeholders
4. **Rotate keys regularly**: Update values in Settings when rotating credentials
5. **Review key usage**: Check which keys are set to "Always Allow"

## Development vs Production

### Development Mode
- Gateway runs separately from Electron
- IPC bridge is not available
- Keys stored locally in Gateway (for testing)
- Not secure - for development only

### Production Mode
- Gateway is a child process of Electron
- IPC bridge connects to main process
- Keys stored in system Keychain (macOS) / DPAPI (Windows)
- Fully secure

## File Locations

- **Custom Keys**: `~/.paprwork/data/custom-keys.json` (encrypted)
- **Essential Keys**: Stored via `electron-store` in `settings.json`
- **Storage Class**: `src/core/storage/CustomKeysStorage.ts`
- **IPC Handlers**: `src/electron/ipc/customKeys.ts`
- **Gateway Service**: `src/gateway/services/CustomKeysService.ts`
- **WebSocket Handler**: `src/gateway/websocket/customKeys.ts`
- **UI Hook**: `ui/hooks/useCustomKeys.ts`
- **Settings UI**: `ui/components/Settings/SettingsView.tsx`

## Examples

### Example 1: Adding a Stripe Key

```typescript
// In Settings UI
await addKey({
  name: "STRIPE_API_KEY",
  value: "sk_test_...",
  description: "Stripe API key for payment processing",
  permission: "ask", // Require approval for security
});

// In a job config
{
  "env": {
    "STRIPE_KEY": "${STRIPE_API_KEY}"
  }
}

// At runtime: User sees prompt "Allow job to use STRIPE_API_KEY?"
```

### Example 2: Amplitude Analytics (Auto-allow)

```typescript
// In Settings UI
await addKey({
  name: "AMPLITUDE_API_KEY",
  value: "abc123...",
  description: "Analytics tracking",
  permission: "always", // No prompt needed
});

// In agent tool
const apiKey = await customKeysService.getKeyByName("AMPLITUDE_API_KEY");
await trackEvent(apiKey, eventData);

// Logs automatically sanitized: ***AMPLITUDE_API_KEY_REDACTED***
```

## Troubleshooting

### Keys not appearing in Settings
- Check browser console for WebSocket errors
- Verify Gateway is running
- Check `~/.paprwork/data/custom-keys.json` exists

### "Encryption not available" warning
- macOS: Ensure app is signed or running from Applications folder
- Windows: Check DPAPI is available (usually always is)
- Fallback: Uses base64 encoding (not secure, for testing only)

### Keys not resolving in jobs
- Check key name matches exactly (case-sensitive)
- Verify permission is set to "always" for automated use
- Check Gateway logs for IPC errors

## Migration from v1

Paprwork v1 custom keys are not automatically migrated. To import:

1. Export from v1: Open v1 Settings, copy key names and descriptions
2. Manually re-add in v2 Settings (values must be re-entered for security)
3. Update job configs to use `${KEY_NAME}` syntax if different

## Future Enhancements

- Key groups/categories
- Key expiration dates
- Usage analytics per key
- Key sharing between team members (enterprise)
- Integration with 1Password/Bitwarden
