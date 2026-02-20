# API Key Workflow Fix

**Date:** 2026-02-19  
**Issue:** Agent asks users to paste API keys in chat + bash tool not loading custom keys from Settings

---

## Problems

### Problem 1: Agent Asking for Keys in Chat

When the agent needed an API key that wasn't configured (e.g., `GITHUB_TOKEN`), it would ask the user to paste the key directly in the chat:

```
Agent: "I need a GitHub token to continue. Please paste your token here."
```

This is **insecure** because:
- Keys exposed in plaintext in chat history
- Keys not encrypted in macOS Keychain
- Keys not reusable across sessions/jobs
- No permission controls

### Problem 2: Bash Tool Not Loading Custom Keys ⚠️ CRITICAL

Even after user added keys in Settings, bash commands would fail:

```javascript
// User adds GITHUB_TOKEN in Settings
bash({ command: 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" ...' })

// ❌ Error: "Token not found in environment"
// ❌ Agent: "The token isn't in the shell environment"
```

**Root Cause:** Bash tool was ONLY checking `process.env`, NOT CustomKeysStorage where user-configured keys are stored.

---

## Root Cause

The system prompt had conflicting instructions:

**What it said:**
```
**NEVER ask users to paste API keys or secrets in chat!** Use the built-in key management system.
```

**What was missing:**
- No workflow for when a key **doesn't exist yet**
- No mention of Settings UI
- No instructions to call `list_keys` first
- No example of what to tell the user

Result: Agent followed "don't ask in chat" but had no alternative, so it asked anyway.

---

## Solution

The solution has **three critical fixes** - inline key request (best UX), Settings UI fallback, and bash tool integration:

### Fix 1: Inline Key Request (Primary, Best UX)

Added `request_key` tool that shows an **inline input card in the chat**:

**Tool Definition:**
```typescript
export const requestKeyTool = createTool({
  id: "request_key",
  description: "Request a missing API key with an inline input card...",
  inputSchema: z.object({
    name: z.string(), // e.g., "GITHUB_TOKEN"
    description: z.string(), // What it's for
    sourceUrl: z.string().optional(), // Where to get it
    requiredScopes: z.array(z.string()).optional(), // API permissions
    permission: z.enum(["always", "ask"]).default("ask")
  }),
  execute: async (args) => {
    // Returns special format that UI recognizes
    return {
      success: true,
      data: {
        type: "key_request", // Signals UI to show input card
        name: args.name,
        description: args.description,
        sourceUrl: args.sourceUrl,
        requiredScopes: args.requiredScopes,
        suggestedPermission: args.permission,
        status: "awaiting_user_input"
      }
    };
  }
});
```

**UI Component:** `KeyRequestCard.tsx`
- Inline card that appears in chat
- Password input with show/hide toggle
- Permission controls (always allow vs. ask each time)
- Link to key generation page (opens in browser)
- Submits to CustomKeysService → Electron IPC → Keychain

### Fix 2: Settings UI Fallback

Added workflow instructions to `SystemPrompt.ts`:

**New Section: "When You Need a Key That Doesn't Exist"**

```typescript
## When You Need a Key That Doesn't Exist

**Primary Method: request_key tool (Best UX)**

1. Check what keys exist first: Call `list_keys`
2. Request the key inline: Call `request_key` with metadata
3. User enters key in inline card (never leaves chat)

Example:

request_key({
  name: "GITHUB_TOKEN",
  description: "GitHub API access for fetching repository data",
  sourceUrl: "github.com/settings/tokens",
  requiredScopes: ["repo", "read:user"],
  permission: "always"
})

**Alternative: Direct to Settings UI**

If request_key fails or for batch key setup:

"I'll need a GitHub token. Please:
1. Go to Settings → API Keys → Custom API Keys
2. Add a new key:
   - Name: GITHUB_TOKEN
   - Value: Your token from github.com/settings/tokens
   - Permission: 'Always Allow' (for automation)
3. Let me know when you've added it!"
```

### Fix 3: Bash Tool Loading Custom Keys ⚠️ CRITICAL

**Before (Broken):**
```typescript
// src/core/tools/bash.ts

// Build custom keys map from environment
const customKeys: Record<string, string> = {};
for (const key of apiKeys) {
  const keyName = Object.keys(process.env).find(
    (k) => process.env[k] === key
  );
  if (keyName) {
    customKeys[keyName] = key;
  }
}
// ❌ ONLY checks process.env - misses custom keys from Settings!
```

**After (Fixed):**
```typescript
// Build custom keys map from environment AND CustomKeysStorage
const customKeys: Record<string, string> = {};

// 1. Add keys from environment
for (const key of apiKeys) {
  const keyName = Object.keys(process.env).find(
    (k) => process.env[k] === key
  );
  if (keyName) {
    customKeys[keyName] = key;
  }
}

// 2. Add keys from CustomKeysStorage (user-configured keys)
try {
  const { getCustomKeysService } = await import("../../gateway/services/CustomKeysService.js");
  const service = getCustomKeysService();
  const storedKeys = await service.listKeys();
  
  // Fetch values for all stored keys
  for (const keyMeta of storedKeys) {
    const value = await service.getKeyByName(keyMeta.name);
    if (value) {
      customKeys[keyMeta.name] = value;
      // Add to apiKeys array for sanitization
      if (!apiKeys.includes(value)) {
        apiKeys.push(value);
      }
    }
  }
} catch (error) {
  console.warn('[Bash Tool] Failed to load custom keys:', error);
  // Continue without custom keys - env vars still work
}
```

**Impact:**
- ✅ Bash commands now load keys from Settings
- ✅ Keys encrypted in Keychain (secure)
- ✅ Keys work in jobs (not just environment)
- ✅ `${GITHUB_TOKEN}` substitutes correctly
- ✅ Same fix applied to `executeBashCommandStreaming()`

**See:** `docs/BASH_TOOL_CUSTOM_KEYS_FIX.md` for detailed testing examples.

---

## Complete Workflow

**Step-by-step flow with all three fixes:**

1. **Agent needs missing key**
   ```
   Agent: [calls list_keys]
   Result: No GITHUB_TOKEN found
   ```

2. **Agent requests key inline (Fix 1)**
   ```
   Agent: [calls request_key({
     name: "GITHUB_TOKEN",
     description: "GitHub API access for fetching repository data",
     sourceUrl: "github.com/settings/tokens",
     requiredScopes: ["repo", "read:user"],
     permission: "always"
   })]
   ```

3. **User enters key in inline card**
   ```
   UI: Shows KeyRequestCard inline in chat
   User: Enters key value (password field with show/hide)
   User: Selects permission level (always/ask)
   User: Clicks "Add Key"
   ```

4. **Key saved securely**
   ```
   KeyRequestCard → CustomKeysService (IPC) → Electron → Keychain (encrypted)
   ```

5. **Agent uses key in bash command (Fix 3)**
   ```
   Agent: bash({ command: 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" https://api.github.com/repos/...' })
   ```

6. **Bash tool loads key (Fix 3)**
   ```typescript
   // Loads from BOTH:
   // 1. process.env (environment variables)
   // 2. CustomKeysStorage (Settings keys) ← FIX!
   
   const service = getCustomKeysService();
   const storedKeys = await service.listKeys();
   
   for (const keyMeta of storedKeys) {
     const value = await service.getKeyByName(keyMeta.name);
     if (value) {
       customKeys[keyMeta.name] = value; // ✅ GITHUB_TOKEN loaded!
     }
   }
   ```

7. **Key substituted and command executes**
   ```bash
   # Before substitution:
   curl -H "Authorization: Bearer ${GITHUB_TOKEN}" ...
   
   # After substitution (Fix 3):
   curl -H "Authorization: Bearer ghp_abc123..." ...
   
   # Output:
   ✅ 200 OK - Repository data fetched successfully
   ```

8. **Output sanitized**
   ```
   # Raw output might include key value
   # Sanitized output replaces with:
   curl -H "Authorization: Bearer ***" ...
   ```

**Fallback (Fix 2):**
If `request_key` fails or user prefers Settings UI:
```
Agent: "I'll need a GitHub token. Please:
1. Go to Settings → API Keys → Custom API Keys
2. Click 'Add Custom Key'
3. Name: GITHUB_TOKEN
4. Value: Get from github.com/settings/tokens (needs repo scope)
5. Permission: 'Always Allow' (for automation)

Let me know once you've added it and I'll continue!"
```

**NEVER ask users to paste keys in chat** - keys must go through `request_key` tool or Settings UI for encryption and security.

---

## Best Practices

**Added "Prefer request_key" as #2 best practice:**

1. **Check keys first** - Call `list_keys` before assuming a key exists
2. **Prefer request_key** - Better UX than Settings redirect (inline card in chat)
3. **Only use keys when necessary** - Don't fetch keys just to check them
4. **Use environment keys when available** - Prefer `OPENAI_API_KEY` over custom keys
5. **Explain why you need the key** - Context helps users approve
6. **Handle permission denials gracefully** - Offer alternatives if possible

---

## Expected Behavior After All Fixes

### Scenario 1: Agent needs GitHub token (inline request - PRIMARY)

**Before:**
```
Agent: "I need a GitHub token. Please paste it here."
User: ghp_1234567890... [exposes key in chat]
```

**After (with request_key tool):**
```
Agent: [calls list_keys → no GITHUB_TOKEN]
Agent: [calls request_key({
  name: "GITHUB_TOKEN",
  description: "GitHub API access for fetching repository data",
  sourceUrl: "github.com/settings/tokens",
  requiredScopes: ["repo", "read:user"],
  permission: "always"
})]

→ User sees inline KeyRequestCard in chat:

  🔑 API Key Required
  
  GitHub API access for fetching repository data
  
  Get key from: github.com/settings/tokens ↗
  Required permissions: [repo] [read:user]
  
  GITHUB_TOKEN
  [•••••••••••••••••••] 👁️
  
  ○ Always allow (for automation)
  ● Ask each time (more secure)
  
  [Cancel] [Add Key]

→ User clicks source URL link (opens in browser)
→ User copies token from GitHub
→ User pastes into password field
→ User selects permission
→ User clicks "Add Key"
→ ✓ Key encrypted and saved to Keychain

Agent: "Key added successfully. Continuing with GitHub API call..."
Agent: [calls bash({ command: 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" ...' })]

→ Bash tool loads key from CustomKeysStorage (Fix 3)
→ Substitutes ${GITHUB_TOKEN} with actual value
→ Command executes successfully
→ Output sanitized (key value replaced with ***)

✅ 200 OK - Repository data fetched
```

### Scenario 2: User already added key in Settings

**Key already exists, bash tool loads it (Fix 3):**

```
Agent: [calls list_keys]
Result: ✅ GITHUB_TOKEN exists (permission: always)

Agent: [calls bash({ command: 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" ...' })]

→ Bash tool loads keys from:
  1. process.env (environment variables)
  2. CustomKeysStorage (Settings keys) ← Fix 3!
  
→ Finds GITHUB_TOKEN in CustomKeysStorage
→ Substitutes ${GITHUB_TOKEN} with actual value
→ Command executes successfully

✅ 200 OK - Repository data fetched
```

### Scenario 3: Agent needs key (Settings UI fallback - Fix 2)

**When to use:** request_key fails, timeout, or user prefers Settings

```
Agent: [calls list_keys → no GITHUB_TOKEN]
Agent: "I'll need a GitHub token. Please:

1. Go to Settings → API Keys → Custom API Keys
2. Click 'Add Custom Key'
3. Name: GITHUB_TOKEN
4. Value: Get from github.com/settings/tokens (needs repo scope)
5. Permission: 'Always Allow' (for automation)

Let me know once you've added it and I'll continue!"

User: "Done!"
Agent: [calls bash({ command: 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" ...' })]
→ Bash tool loads from CustomKeysStorage (Fix 3)
✅ Command executes successfully
```

### Scenario 4: Before Fix 3 (Broken)

**What happened before the bash tool fix:**

```
User: [Adds GITHUB_TOKEN in Settings UI]
Agent: [calls bash({ command: 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" ...' })]

❌ Error: "Token not found in environment"
❌ Agent: "The token isn't in the shell environment — it's in Paprwork's secret store..."

→ Bash tool ONLY checked process.env
→ DIDN'T check CustomKeysStorage
→ ${GITHUB_TOKEN} NOT substituted
→ Command failed with 401 (literal string "${GITHUB_TOKEN}" sent to API)
```

**After Fix 3:**

```
User: [Adds GITHUB_TOKEN in Settings UI]
Agent: [calls bash({ command: 'curl -H "Authorization: Bearer ${GITHUB_TOKEN}" ...' })]

✅ Bash tool checks BOTH:
   1. process.env
   2. CustomKeysStorage ← FIX!
   
✅ ${GITHUB_TOKEN} found in CustomKeysStorage
✅ Substituted with actual value
✅ Command executes successfully
✅ 200 OK - Repository data fetched
```

---

## Benefits

### Security (All Fixes)
- ✅ Keys encrypted in macOS Keychain (Fix 1 + 2)
- ✅ Keys never exposed in chat history (Fix 1)
- ✅ Keys sanitized in tool outputs (shown as `***`) (Fix 3)
- ✅ Permission prompts for key usage

### Reusability (Fix 3)
- ✅ Keys work across all sessions (bash tool loads from Settings)
- ✅ Keys work across all jobs (bash tool loads from Settings)
- ✅ Keys work across all agents/sub-agents

### User Control (Fix 1 + 2)
- ✅ User controls permission level (always/ask)
- ✅ User can revoke keys anytime
- ✅ User sees what keys are being used
- ✅ Inline key input (never leaves chat) (Fix 1)
- ✅ Fallback to Settings UI (Fix 2)

### Developer Experience (All Fixes)
- ✅ Agent checks `list_keys` before assuming
- ✅ Clear workflow prevents confusion
- ✅ Consistent behavior across all scenarios
- ✅ Bash tool actually works with custom keys! (Fix 3)

---

## Files Changed

### Fix 1: Inline Key Request

**`src/core/tools/keyManagement.ts`** - NEW
- Added `request_key` tool
- Added `list_keys`, `get_key`, `set_key`, `delete_key` tools

**`ui/components/Chat/KeyRequestCard.tsx`** - NEW
- Inline card component for secure key entry
- Password field with show/hide toggle
- Permission controls (always/ask)
- Source URL link

**`ui/components/Chat/KeyRequestCard.css`** - NEW
- Liquid Glass design system styling

### Fix 2: Settings UI Fallback

**`src/core/agents/SystemPrompt.ts`**

Added new section "When You Need a Key That Doesn't Exist" with:
- Primary method: `request_key` tool (inline card)
- Fallback method: Settings UI instructions
- Complete workflow (check → request → instruct → wait)
- Example response template
- Security reminder
- Updated best practices

Lines added: ~50 lines  
Location: After "Permission System" section, before "Best Practices"

### Fix 3: Bash Tool Loading Custom Keys ⚠️ CRITICAL

**`src/core/tools/bash.ts`** - MODIFIED

**Changes in `executeBashCommand()` function (lines ~79-115):**
- BEFORE: Only checked `process.env` for keys
- AFTER: Loads keys from BOTH `process.env` AND `CustomKeysStorage`
- Imports `getCustomKeysService()` dynamically
- Calls `service.listKeys()` and `service.getKeyByName()` for each key
- Merges custom keys into `customKeys` map
- Adds custom key values to `apiKeys` array for sanitization

**Changes in `executeBashCommandStreaming()` function (lines ~262-300):**
- Same fix as above for streaming version
- Ensures both streaming and non-streaming execute consistently

**Impact:**
- ✅ `${GITHUB_TOKEN}` now substitutes correctly
- ✅ Custom keys from Settings now work in bash commands
- ✅ Jobs can use custom keys (not just env vars)
- ✅ Graceful fallback if CustomKeysStorage fails to load

---

## Testing

### Test Case 1: Missing GitHub Token (Fix 1 - Inline Request)
```typescript
User: "Check my GitHub issues"
Agent: [calls list_keys] → no GITHUB_TOKEN
Agent: [calls request_key({
  name: "GITHUB_TOKEN",
  description: "GitHub API access for issues",
  sourceUrl: "github.com/settings/tokens",
  requiredScopes: ["repo"],
  permission: "always"
})]
→ User sees inline KeyRequestCard
→ User enters key, clicks "Add Key"
→ Key saved to Keychain
Agent: [calls bash with ${GITHUB_TOKEN}]
✅ Token substituted, command succeeds
```

### Test Case 2: Token Exists (Fix 3 - Bash Tool Loads From Settings)
```typescript
User: "Check my GitHub issues"
Agent: [calls list_keys] → GITHUB_TOKEN exists
Agent: [calls bash: curl -H "Authorization: Bearer ${GITHUB_TOKEN}" ...]
```

### Test Case 3: Permission Denied
```typescript
Agent: [tries to use GITHUB_TOKEN]
System: Permission denied
Agent: "The GitHub token permission was denied. Please:
1. Go to Settings → API Keys
2. Find GITHUB_TOKEN
3. Change permission to 'Always Allow'
..."
```

---

## Related Documentation

- **API Keys System:** `docs/CUSTOM_KEYS.md`
- **Settings UI:** `ui/components/Settings/ApiKeysSettings.tsx`
- **Key Resolution:** `src/gateway/utils/keyResolver.ts`
- **Tool Context:** `src/core/tools/context.ts`

---

## Future Improvements

1. **Auto-detect missing keys**: Tool could return specific error when key missing
2. **Deep link to Settings**: Open Settings UI directly to API Keys section
3. **Key templates**: Pre-filled forms for common services (GitHub, Stripe, etc.)
4. **Permission hints**: Suggest "Always Allow" for automation jobs vs "Ask" for manual tasks

---

**Summary:** Agent now has a clear, secure workflow for handling missing API keys. It directs users to Settings UI instead of asking them to paste keys in chat, ensuring encryption, reusability, and user control.
