# 🚀 Ready to Test: Permissions & System Prompt

**Status:** ✅ Build successful, ready for testing  
**Time:** ~3 hours implementation  
**Date:** 2026-02-12

---

## What Was Built

### 1. API Key Permission System
- Users can approve/deny key usage
- "Always allow" option for environment keys
- Permission requests show full context (tool, key, command)
- Permissions persist across sessions

### 2. Enhanced System Prompt
- Agent knows about `${KEY_NAME}` syntax
- Documents permission system
- Provides tool examples
- Security best practices

### 3. Full IPC Architecture
- Gateway ↔ Main ↔ Renderer communication
- Async permission requests
- Timeout handling
- State persistence

---

## 🧪 Test Plan

### Start the App
```bash
npm start
```

### Test 1: First Permission Request ⭐
**Goal:** Verify modal appears and "always allow" works

**Steps:**
1. Type: `"Check OpenAI models: curl -H 'Authorization: Bearer ${OPENAI_API_KEY}' https://api.openai.com/v1/models"`
2. Wait for AI to use bash tool
3. **Expected:** Modal appears showing:
   - Tool: bash
   - Key: OPENAI_API_KEY
   - Command: curl -H ...
   - ☐ Always allow this key
4. Check the "Always allow" checkbox
5. Click "Allow"
6. **Expected:**
   - Command executes
   - Output shows `Bearer ***` (key sanitized)
   - No errors

### Test 2: Always Allowed (No Modal) ⭐
**Goal:** Verify "always" works, no prompt

**Steps:**
1. Type: `"Run the same command again"`
2. **Expected:**
   - NO modal appears
   - Command executes immediately
   - Output shows `Bearer ***`

### Test 3: Permission Denied
**Goal:** Verify denial works gracefully

**Steps:**
1. Type: `"Run: echo ${ANTHROPIC_API_KEY}"`
2. Modal appears
3. Click "Deny" (don't check "always allow")
4. **Expected:**
   - AI receives error message
   - AI explains permission was denied
   - Offers alternative or asks to configure

### Test 4: Key Sanitization
**Goal:** Verify keys never leak

**Steps:**
1. Type: `"Run: env | grep API"`
2. **Expected:**
   - Output shows API key names
   - Values show as `***`
   - Full keys never visible

### Test 5: No Keys Used
**Goal:** Verify no permission needed for keyless commands

**Steps:**
1. Type: `"What files are in the current directory?"`
2. **Expected:**
   - AI uses: bash ls -la
   - NO permission modal
   - Command executes immediately
   - File list displayed

### Test 6: Large Output Truncation
**Goal:** Verify truncation works

**Steps:**
1. Type: `"Run npm install"`
2. **Expected:**
   - Large output is truncated
   - Shows: "[... N characters truncated for brevity]"
   - No crashes or token overflow

### Test 7: Multiple Keys
**Goal:** Verify multi-key scenarios

**Steps:**
1. Type: `"Run: curl -u '${API_USER}:${API_SECRET}' https://api.example.com"`
2. **Expected:**
   - May prompt for each key (if not always allowed)
   - Both keys substituted if approved
   - Both keys sanitized in output

---

## Expected Console Output

When permission is requested, you should see:

```
[GatewayPermissionBridge] Requesting permission for OPENAI_API_KEY (ID: gateway-perm-1-...)
[Electron] Gateway requested permission: { keyName: 'OPENAI_API_KEY', ... }
[Permissions IPC] Key permission requested: OPENAI_API_KEY
[Permissions IPC]   → Sending request to renderer (ID: perm-...)
[Preload] Setting up permission request listener
[useKeyPermissions] Permission request received: { keyName: 'OPENAI_API_KEY', ... }
[useKeyPermissions] Sending response: { approved: true, alwaysAllow: true }
[Preload] Sending permission response: { requestId: '...', ... }
[Permissions IPC] Response received for OPENAI_API_KEY: approved
[Permissions IPC]   ✓ Saving "always" permission for OPENAI_API_KEY
[GatewayPermissionBridge] Received response for gateway-perm-1-...: approved
```

---

## Troubleshooting

### Modal Doesn't Appear
**Check:**
1. Console for permission request logs
2. DevTools is open (press Cmd+Option+I)
3. Gateway is running (check terminal)

### Permission Always Denied
**Check:**
1. `~/.paprwork-v2/env-key-permissions.json`
2. May need to reset: delete file and restart app

### Keys Still Showing in Output
**Check:**
1. Console for sanitization logs
2. Build was successful
3. Using latest build (npm run build)

### Modal Shows But Nothing Happens
**Check:**
1. Console for IPC response logs
2. Check `pendingRequests` in permissions IPC
3. Verify IPC channels match (request/response)

---

## Next Steps After Testing

### If Tests Pass ✅
1. Enhance PermissionsTab UI (full management interface)
2. Add more tools (Browser, Papr Memory, Jobs)
3. Update test suite
4. Add E2E tests for permissions

### If Tests Fail ❌
1. Check console logs for error details
2. Verify IPC flow (Gateway → Main → Renderer → Main → Gateway)
3. Check permission storage files
4. Verify modal renders correctly

---

## Quick Commands

```bash
# Start app
npm start

# If Gateway port is busy
npm run kill:gateway && npm start

# Rebuild after changes
npm run build && npm start

# Check Gateway logs
# (They appear in the terminal where you ran npm start)

# Check permission storage
cat ~/.paprwork-v2/env-key-permissions.json
cat ~/.paprwork-v2/settings.json
```

---

**🎯 Goal:** All 7 test cases pass  
**📝 Document:** Any issues found  
**🚀 Next:** Add more tools with inherited permission system

Ready to test! 🎉
