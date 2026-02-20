# Keychain Popup Fix

## Problem

V2 was showing macOS Keychain Access permission popup **every time the app started**, while V1 never showed this popup.

### Root Cause

**V2 was eagerly decrypting ALL keys on startup:**

```typescript
// ❌ BAD: Upfront decryption on startup (electron/index.ts)
const keys = await customKeysStorage.listKeys();
for (const key of keys) {
  const value = await customKeysStorage.getKey(key.id); // 🔴 Triggers keychain!
  apiKeys[key.name] = value;
}
```

Every call to `customKeysStorage.getKey()` triggers `safeStorage.decryptString()`, which causes the keychain permission popup.

**V1 used lazy on-demand key resolution:**

```javascript
// ✅ GOOD: Lazy loading via IPC (V1 approach)
const keyResolver = async (keyName) => {
  const key = await getCustomKeyByName(keyName);
  if (!key) return null;
  
  // Only decrypt when actually needed, only keys with "always" permission
  if (key.permission !== 'always') return null;
  
  return decryptKeyValue(key.encryptedValue); // Only called on-demand!
};
```

## The Fix

### 1. Remove Upfront Decryption (electron/index.ts)

**Before:**
```typescript
// Decrypt all keys on startup ❌
const keys = await customKeysStorage.listKeys();
for (const key of keys) {
  const value = await customKeysStorage.getKey(key.id);
  apiKeys[key.name] = value;
}

gatewayProcess = spawn("node", [gatewayPath], {
  env: { ...process.env, ...apiKeys }, // Pass decrypted keys
});
```

**After:**
```typescript
// No upfront decryption ✅
console.log("[Electron] Setting up on-demand key resolution (no upfront decryption)");

gatewayProcess = spawn("node", [gatewayPath], {
  stdio: ["inherit", "inherit", "inherit", "ipc"], // Enable IPC
  env: { ...process.env }, // No keys yet!
});

// Set up lazy IPC-based key resolution
gatewayProcess.on("message", async (message: any) => {
  if (message.type === "resolve-keys") {
    const { requestId, keyNames } = message;
    const resolvedKeys: Record<string, string> = {};
    
    for (const keyName of keyNames) {
      const value = await customKeysStorage.getKeyByName(keyName);
      if (value) resolvedKeys[keyName] = value;
    }
    
    gatewayProcess?.send({ type: "keys-resolved", requestId, keys: resolvedKeys });
  }
});
```

### 2. Add Lazy Key Resolver (gateway/utils/keyResolver.ts)

New utility that requests keys from main process **only when needed**:

```typescript
export async function getApiKeys(keyNames: string[]): Promise<Record<string, string>> {
  const isDev = process.env.NODE_ENV === "development";

  if (isDev) {
    // Development: use .env.local
    return keyNames.reduce((acc, name) => {
      if (process.env[name]) acc[name] = process.env[name];
      return acc;
    }, {});
  }

  // Production: request from main process via IPC (lazy!)
  return await requestKeysViaIPC(keyNames);
}
```

### 3. Gateway: Don't Load Keys on Init (gateway/index.ts)

```typescript
// ✅ DON'T request keys during initialization!
// AgentService will lazy-load them when first message is sent
await initializeAgentService({
  mode: 'local', // Start in local mode
  paprApiKey: undefined, // Will be loaded lazily
  openaiApiKey: undefined, // Will be loaded lazily
});
```

### 4. AgentService: Lazy Load on First Message (gateway/services/AgentService.ts)

```typescript
private async ensureKeysLoaded(): Promise<void> {
  if (this.keysLoaded) return;

  console.log('[AgentService] Lazy-loading API keys (first message)...');
  
  const { getApiKeys } = await import("../utils/keyResolver.js");
  const keys = await getApiKeys(["PAPR_API_KEY", "OPENAI_API_KEY"]);
  
  // Upgrade storage if PAPR key becomes available
  if (keys.PAPR_API_KEY) {
    await this.storageManager.initialize({
      mode: 'hybrid',
      paprApiKey: keys.PAPR_API_KEY,
    });
  }
  
  this.keysLoaded = true;
}

async *streamAgent(chatId: string, userMessage: string, config: AgentConfig) {
  // Lazy-load API keys on first message (no keychain popup on startup!)
  await this.ensureKeysLoaded();
  
  // ... rest of streaming logic
}
```

## Benefits

✅ **No keychain popup on startup** - matches V1 behavior  
✅ **Ultra-lazy loading** - only decrypt keys when user sends first message  
✅ **Cache keys** - decrypt once, use many times  
✅ **Dev/prod split** - use .env.local in dev, IPC in production  
✅ **Security** - keys not passed via env vars (they're in memory only)  
✅ **Fast startup** - Gateway starts in local mode immediately  

## Architecture Comparison

### V1 (Original)
```
App Startup
  ↓
No decryption (zero keychain popups!)
  ↓
Gateway starts a job
  ↓
Job needs API key
  ↓
Gateway sends IPC: "resolve-keys" → Main
  ↓
Main decrypts ONLY requested keys (keychain prompt if needed)
  ↓
Main sends IPC: "keys-resolved" → Gateway
  ↓
Gateway uses keys
```

### V2 (Fixed)
```
App Startup
  ↓
No decryption (zero keychain popups!) ✅
  ↓
Gateway starts in local mode (zero key loading!) ✅
  ↓
User sends FIRST message
  ↓
AgentService.ensureKeysLoaded() called
  ↓
Gateway sends IPC: "resolve-keys" → Electron
  ↓
Electron decrypts ONLY requested keys (keychain prompt on FIRST message only)
  ↓
Electron sends IPC: "keys-resolved" → Gateway
  ↓
Gateway caches keys and upgrades to hybrid mode
  ↓
All subsequent messages use cached keys (no more prompts!)
```

## Testing

### Development Mode
```bash
# Uses .env.local (no keychain)
npm run dev
```

### Production Mode (Packaged App)
```bash
# Build and package
npm run build
npm run package

# Run packaged app
open dist/mac-arm64/Paprwork.app

# Should NOT show keychain popup on startup ✅
# Only shows keychain popup when agent actually needs keys
```

## Key Insights

1. **`listKeys()` doesn't decrypt** - it only returns metadata (name, id, permission)
2. **`getKey()` decrypts** - every call triggers keychain access
3. **V1's approach was correct** - lazy IPC-based resolution
4. **V2's mistake** - eager loading all keys upfront

## Related Files

- `src/electron/index.ts` - Main process, IPC handler for key resolution
- `src/gateway/utils/keyResolver.ts` - Lazy key loading utility (NEW)
- `src/gateway/index.ts` - Gateway initialization (no key loading)
- `src/gateway/services/AgentService.ts` - Lazy key loading on first message
- `src/core/storage/CustomKeysStorage.ts` - Keychain storage (unchanged)

## Notes

- **Keychain popup only shows when user sends first message** (not on app startup!)
- In development, we still use `.env.local` for convenience
- In production (packaged app), we use IPC for security
- Keys are cached after first resolution (no repeated prompts)
- Gateway starts in local mode, upgrades to hybrid when keys are available
- This matches OpenClaw's architecture for key management
