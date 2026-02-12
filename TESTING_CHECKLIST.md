# Testing Checklist - Permissions & System Prompt

**Date:** 2026-02-12  
**Status:** Ready for testing

---

## Quick Start

```bash
npm start
```

---

## Test Cases

### ✅ Test 1: First Permission Request
**Command:** `"Check OpenAI models: curl -H 'Authorization: Bearer ${OPENAI_API_KEY}' https://api.openai.com/v1/models"`

- [ ] Modal appears
- [ ] Shows Tool: bash
- [ ] Shows Key: OPENAI_API_KEY
- [ ] Shows command
- [ ] Has "Always allow" checkbox
- [ ] Click "Allow" + check box
- [ ] Command executes
- [ ] Output shows `***` not key

---

### ✅ Test 2: Always Allowed
**Command:** `"Run the same command again"`

- [ ] NO modal appears
- [ ] Command executes immediately
- [ ] Output shows `***`

---

### ✅ Test 3: Permission Denied
**Command:** `"Run: echo ${ANTHROPIC_API_KEY}"`

- [ ] Modal appears
- [ ] Click "Deny"
- [ ] AI receives error
- [ ] AI explains denial

---

### ✅ Test 4: Key Sanitization
**Command:** `"Run: env | grep API"`

- [ ] Keys show as `***`
- [ ] Never see full key values

---

### ✅ Test 5: No Keys (No Modal)
**Command:** `"What files are in the current directory?"`

- [ ] NO modal (no keys used)
- [ ] bash: ls -la executes
- [ ] File list displayed

---

### ✅ Test 6: Large Output
**Command:** `"Run npm install"`

- [ ] Output is truncated
- [ ] Shows truncation message
- [ ] No crashes

---

### ✅ Test 7: Multiple Keys
**Command:** `"Run: curl -u '${USER}:${PASS}' example.com"`

- [ ] Prompts for each key (if needed)
- [ ] Both keys substituted
- [ ] Both keys sanitized

---

## Console Checks

Open DevTools (Cmd+Option+I):

- [ ] No errors in console
- [ ] See permission request logs
- [ ] See permission response logs
- [ ] See sanitization logs

---

## Files to Verify

```bash
# Check permission storage
cat ~/.paprwork-v2/env-key-permissions.json

# Should show:
{
  "OPENAI_API_KEY": "always"
}
```

---

## If Something Fails

1. Check console logs (both DevTools and terminal)
2. Verify Gateway is running
3. Check permission storage files
4. Try: `npm run build && npm start`
5. Report the specific failure with console logs

---

**Goal:** All 7 tests pass ✅
