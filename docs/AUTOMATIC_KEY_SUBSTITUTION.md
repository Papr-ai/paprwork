# Automatic Key Substitution in V2

**Status:** ✅ **FULLY IMPLEMENTED** (Same as V1)

---

## How It Works

When you use `${KEY_NAME}` syntax in bash commands, the system **automatically**:

1. **Detects** the placeholder in the command
2. **Resolves** the key from secure storage (macOS Keychain)
3. **Checks** permissions (if needed, shows modal)
4. **Substitutes** the actual value before execution
5. **Sanitizes** output (keys shown as `***`)

---

## Example Usage

### Basic API Call

```javascript
bash({
  command: 'curl -H "Authorization: Bearer ${OPENAI_API_KEY}" https://api.openai.com/v1/models'
})
```

**What happens:**
1. System detects `${OPENAI_API_KEY}`
2. Checks if key exists in Settings
3. If first use, shows permission modal
4. Substitutes actual value: `Bearer sk-abc123...`
5. Executes curl command
6. Output sanitized: key shown as `***`

### Multiple Keys

```javascript
bash({
  command: 'curl -u "${AMPLITUDE_API_KEY}:${AMPLITUDE_SECRET_KEY}" https://amplitude.com/api/2/export'
})
```

### Custom Keys

```javascript
bash({
  command: 'curl -H "X-API-Key: ${GITHUB_TOKEN}" https://api.github.com/repos/owner/repo'
})
```

---

## Key Sources (In Priority Order)

The system checks for keys in this order:

1. **Custom Keys** (Settings → API Keys → Custom API Keys)
   - User-configured keys
   - Encrypted in macOS Keychain
   - Permission-controlled

2. **Environment Variables**
   - System env vars (`OPENAI_API_KEY`, etc.)
   - `.env.local` in development
   - Process environment

---

## Permission System

### First Use
When a key is used for the first time, user sees:

```
🔑 API Key Permission

Tool: bash
Key: OPENAI_API_KEY
Command: curl -H "Authorization: Bearer ${OPENAI_API_KEY}" ...

☐ Always allow this key (don't ask again)

[Deny]  [Allow]
```

### Always Allow
If user checks "Always allow":
- Key auto-approved for all future uses
- No more prompts
- Great for automation/jobs

### Ask Each Time
Default for sensitive keys:
- User approves every use
- More secure
- Good for financial APIs, admin tokens

---

## Security Features

### 1. Automatic Sanitization

**Before sanitization:**
```bash
curl: (401) Invalid key: sk-abc123xyz456def789
```

**After sanitization:**
```bash
curl: (401) Invalid key: ***
```

All outputs automatically sanitized:
- Stdout
- Stderr  
- Error messages
- Tool results
- Console logs

### 2. Encrypted Storage

- **macOS:** System Keychain
- **Windows:** DPAPI (Data Protection API)
- **Linux:** Secret Service API / libsecret

Keys **never** stored in plaintext.

### 3. Permission Control

- User decides per-key permission level
- Keys can be revoked anytime
- Audit trail of key usage

---

## Complete Flow Diagram

```
User: "Fetch GitHub issues"

Agent: bash({ 
  command: "curl -H 'Authorization: Bearer ${GITHUB_TOKEN}' ..." 
})
    ↓
┌─────────────────────────────────────────────────────────┐
│ 1. Bash Tool Detects: ${GITHUB_TOKEN}                  │
└───────────────────┬─────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────┐
│ 2. Check Key Sources:                                   │
│    a. Custom Keys (Settings) → Found!                   │
│    b. Environment Variables → (skip)                    │
└───────────────────┬─────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────┐
│ 3. Check Permissions:                                   │
│    - First use? → Show modal                            │
│    - Always allow? → Auto-approve                       │
│    - Ask each time? → Show modal                        │
└───────────────────┬─────────────────────────────────────┘
                    ↓
        ┌───────────────────────┐
        │ User Approves? │
        └───────┬───────────────┘
                ↓
         Yes           No
          ↓             ↓
┌──────────────┐  ┌─────────────────┐
│ 4. Substitute │  │ Return Error:   │
│    Value      │  │ Permission      │
│               │  │ Denied          │
└───────┬───────┘  └─────────────────┘
        ↓
┌─────────────────────────────────────────────────────────┐
│ 5. Execute Command:                                     │
│    curl -H 'Authorization: Bearer ghp_actual_token' ... │
└───────────────────┬─────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────┐
│ 6. Sanitize Output:                                     │
│    - Replace all key values with ***                    │
│    - Show user safe output                              │
└─────────────────────────────────────────────────────────┘
```

---

## Missing Key Flow (NEW in Issue 9 Fix!)

### Old Behavior (Before Fix):
```
Agent: [searches random files]
Agent: "Can you paste your GITHUB_TOKEN?"
```

### New Behavior (After Fix):

**Option 1: Inline Request Card (Best UX)**
```javascript
Agent: [calls list_keys() → no GITHUB_TOKEN]
Agent: [calls request_key({
  name: "GITHUB_TOKEN",
  description: "GitHub API access",
  sourceUrl: "github.com/settings/tokens",
  requiredScopes: ["repo"],
  permission: "always"
})]

→ Shows inline card in chat
→ User enters key
→ Key encrypted & saved
→ bash command executes with ${GITHUB_TOKEN}
```

**Option 2: Settings UI (Fallback)**
```
Agent: "Please add GITHUB_TOKEN in Settings → API Keys"
```

---

## Code Implementation

### Bash Tool (src/core/tools/bash.ts)

```typescript
// 1. Detect placeholders
const usesKeys = Object.keys(customKeys).some((keyName) =>
  command.includes(`\${${keyName}}`)
);

if (usesKeys) {
  // 2. Request permissions
  command = await substituteCustomKeysWithPermission(
    command,
    customKeys,
    { toolName: "bash", command: input.command },
    async (keyName, context) => {
      return await requestKeyPermission({
        keyName,
        description: `Allow ${keyName} to be used in bash command?`,
        isEnvKey: process.env[keyName] !== undefined,
        toolContext: context,
      });
    }
  );
} else {
  // 3. Simple substitution (no keys)
  command = substituteCustomKeys(command, customKeys);
}
```

### Security Utilities (src/core/tools/security.ts)

```typescript
// Substitute ${KEY_NAME} → actual_value
export function substituteCustomKeys(
  command: string,
  customKeys: Record<string, string>
): string {
  let result = command;
  for (const [keyName, value] of Object.entries(customKeys)) {
    result = result.replace(
      new RegExp(`\\$\\{${keyName}\\}`, 'g'),
      value
    );
  }
  return result;
}

// Sanitize output: actual_value → ***
export function sanitizeError(
  text: string,
  apiKeys: string[]
): string {
  let sanitized = text;
  for (const key of apiKeys) {
    if (key && key.length > 0) {
      const regex = new RegExp(escapeRegex(key), 'g');
      sanitized = sanitized.replace(regex, '***');
    }
  }
  return sanitized;
}
```

---

## Testing

### Test 1: Basic Substitution
```javascript
bash({ command: 'echo "Key: ${OPENAI_API_KEY}"' })
// Output (sanitized): "Key: ***"
```

### Test 2: API Call
```javascript
bash({ 
  command: 'curl -H "Authorization: Bearer ${OPENAI_API_KEY}" https://api.openai.com/v1/models' 
})
// Executes with real key, output sanitized
```

### Test 3: Missing Key
```javascript
bash({ command: 'curl -H "X-Token: ${MISSING_KEY}" ...' })
// Error: "MISSING_KEY not found in environment or custom keys"
// Agent calls request_key() to show inline card
```

---

## Comparison with V1

| Feature | V1 | V2 | Status |
|---------|----|----|--------|
| `${KEY_NAME}` syntax | ✅ | ✅ | Same |
| Auto-substitution | ✅ | ✅ | Same |
| Permission prompts | ✅ | ✅ | Same |
| Output sanitization | ✅ | ✅ | Same |
| Keychain encryption | ✅ | ✅ | Same |
| Inline key request | ❌ | ✅ | **Better in V2!** |
| Settings UI | ✅ | ✅ | Same |

**V2 Improvement:** Inline key request card (no need to leave chat!)

---

## FAQ

### Q: Do I need to configure anything?
**A:** No! It works automatically. Just use `${KEY_NAME}` in bash commands.

### Q: Where are keys stored?
**A:** Encrypted in your system keychain (macOS Keychain, Windows DPAPI, Linux Secret Service).

### Q: What if I don't have a key?
**A:** Agent calls `request_key()` and shows an inline card where you can enter it.

### Q: Can I see my keys?
**A:** Go to Settings → API Keys. You can see names/descriptions, but not values (security).

### Q: How do I revoke a key?
**A:** Settings → API Keys → Select key → Change permission to "Ask each time" or delete it.

### Q: Does this work in jobs?
**A:** Yes! Jobs can use `${KEY_NAME}` in their scripts. Keys are resolved when job runs.

---

## Summary

✅ **Automatic key substitution works exactly like V1**
✅ **Use `${KEY_NAME}` syntax in any bash command**
✅ **Keys encrypted in system keychain**
✅ **Output automatically sanitized**
✅ **Permission system for security**
✅ **NEW: Inline key request card for missing keys**

No configuration needed - just works! 🎉
