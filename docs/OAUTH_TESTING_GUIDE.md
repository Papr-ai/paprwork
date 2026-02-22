# OAuth Testing Guide

**Status:** Implementation complete, ready for testing  
**Date:** 2026-02-20

## Pre-Testing Checklist

- [x] Build completes successfully (`npm run build`)
- [ ] OpenAI Client ID configured (see Configuration section)
- [ ] Node v24+ installed (`nvm use 24`)
- [ ] No existing OAuth tokens (fresh test)

## Configuration Required

### OpenAI OAuth (Currently Needs Setup)

⚠️ **IMPORTANT:** OpenAI OAuth requires a registered application.

**Steps:**
1. Go to OpenAI Developer Portal
2. Create new OAuth application
3. Set redirect URI: `http://127.0.0.1:1455/auth/callback`
4. Copy Client ID
5. Update `src/core/services/OpenAIOAuthService.ts` line 16:
   ```typescript
   clientId: "YOUR_CLIENT_ID_HERE",
   ```
6. Rebuild: `npm run build`

### Claude OAuth (Ready to Test)

✅ Claude is pre-configured with official Claude Code client ID:
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- No additional setup needed

## Test Plan

### Test 1: Claude OAuth Flow (End-to-End)

**Goal:** Verify complete Claude OAuth flow with token sync

1. **Start the app:**
   ```bash
   npm start
   ```

2. **Open Settings → API Keys**
   - Should see "Claude" OAuth section above API keys list
   - Should show "Claude Pro/Max (OAuth)" option
   - Should show "Sign in with Claude" button

3. **Click "Sign in with Claude"**
   - Browser should open to `https://claude.ai/oauth/authorize`
   - Should see OAuth consent screen
   - Click "Authorize" or "Allow"

4. **After authorization:**
   - Browser redirects to callback URL
   - Should see "Authentication Successful! ✓" page
   - Page auto-closes after 2 seconds (or manually close)

5. **Back in Paprwork Settings:**
   - Poll for status (UI checks every 2 seconds)
   - Should see "✓ Connected" status
   - Should show account ID and token expiry

6. **Check API Keys List:**
   - Scroll down to "ANTHROPIC_API_KEY" in the list
   - Should see "🔒 OAuth" green badge next to key name
   - Should show "Claude Pro/Max OAuth Token (Auto-managed)" description

7. **Verify token is usable:**
   - Go to Chat
   - Select a Claude model (e.g., Claude Sonnet 4.5)
   - Send a message
   - Should work without API key prompt

8. **Check logs:**
   ```bash
   # In terminal where app is running
   # Should see:
   [OAuth IPC] Claude OAuth flow completed successfully
   [OAuth IPC] Created ANTHROPIC_API_KEY with OAuth token
   [AgentService] Using Anthropic OAuth token
   ```

### Test 2: Token Sync to CustomKeysStorage

**Goal:** Verify OAuth token appears as regular API key

1. **After Claude OAuth login (Test 1):**
   
2. **Open Developer Tools (Cmd+Option+I)**
   ```javascript
   // In Console:
   await window.electronAPI.customKeys.list()
   
   // Should return array with:
   {
     name: "ANTHROPIC_API_KEY",
     description: "Claude Pro/Max OAuth Token (Auto-managed)",
     permission: "always",
     source: "oauth",
     managedBy: "oauth",
     oauthProvider: "anthropic",
     // ... other fields
   }
   ```

3. **Test in Job/Bash:**
   ```javascript
   // Create a test Python job
   {
     name: "test-claude-oauth",
     type: "python",
     command: "python3 code/test.py --key ${ANTHROPIC_API_KEY}",
     code: {
       "code/test.py": `
import argparse
parser = argparse.ArgumentParser()
parser.add_argument('--key', required=True)
args = parser.parse_args()
print(f"Got key: {args.key[:20]}...")  # Print first 20 chars
       `
     }
   }
   
   // Run job - should print OAuth token (first 20 chars)
   ```

### Test 3: OAuth Token Auto-Refresh

**Goal:** Verify tokens refresh automatically before expiry

⚠️ **Note:** Full test requires waiting ~55 minutes for token to near expiry

**Quick Test (Manual Token Expiry):**

1. **After successful OAuth login:**

2. **Manually expire token in storage:**
   ```bash
   # Find the token file
   cat ~/Library/Application\ Support/Paprwork\ V2/data/oauth-tokens.json
   
   # Copy the expiresAt timestamp
   # Edit to be 4 minutes in the future
   # Restart app
   ```

3. **Wait 5 minutes**
   - Refresh timer runs every 5 minutes
   - Should see in logs:
   ```
   [OAuth IPC] Checking tokens for refresh...
   [OAuth IPC] Refreshing anthropic token (expires soon)
   [OAuth IPC] Successfully refreshed anthropic token
   [OAuth IPC] Updated ANTHROPIC_API_KEY with OAuth token
   ```

4. **Verify token still works:**
   - Send a Claude chat message
   - Should work without re-authentication

### Test 4: Disconnect and Reconnect

**Goal:** Verify disconnect removes OAuth-managed key only

1. **After successful OAuth login:**

2. **In Settings → API Keys:**
   - Scroll to Claude OAuth section
   - Click "Disconnect"

3. **Verify:**
   - OAuth section shows "Disconnected" state
   - "Sign in with Claude" button reappears
   - API keys list: `ANTHROPIC_API_KEY` **removed** (has OAuth badge)

4. **Add manual API key:**
   ```javascript
   // In Settings → API Keys → "Add API Key"
   Name: ANTHROPIC_API_KEY
   Value: sk-ant-test-manual-key-123
   Description: Manual Claude API Key
   Permission: Always allow
   ```

5. **Reconnect OAuth:**
   - Click "Sign in with Claude" again
   - Complete OAuth flow

6. **Verify:**
   - OAuth section shows "✓ Connected"
   - API keys list: `ANTHROPIC_API_KEY` with "🔒 OAuth" badge
   - Description updated to "Claude Pro/Max OAuth Token (Auto-managed)"
   - Manual key was **replaced** with OAuth token

### Test 5: Fallback to Manual API Key

**Goal:** Verify system uses manual API key when OAuth disconnected

1. **Start fresh** (disconnect OAuth if connected)

2. **Add manual API key:**
   ```
   Name: ANTHROPIC_API_KEY
   Value: sk-ant-your-real-api-key
   Permission: Always allow
   ```

3. **Send Claude chat message:**
   - Should work with manual API key
   - Check logs: `[AgentService] Using Anthropic API key`

4. **Connect OAuth:**
   - Click "Sign in with Claude"
   - Complete OAuth flow

5. **Send another Claude chat message:**
   - Should now use OAuth token
   - Check logs: `[AgentService] Using Anthropic OAuth token`

6. **Disconnect OAuth:**
   - Click "Disconnect"

7. **Manual API key should be gone:**
   - Because OAuth overwrote it
   - Would need to re-add manual key

### Test 6: OpenAI OAuth (After Configuration)

⚠️ **Requires OpenAI Client ID configuration first**

**Follow same test steps as Test 1, but for OpenAI:**
- OAuth section: "OpenAI"
- Button: "Sign in with OpenAI"
- OAuth URL: `https://auth.openai.com/oauth/authorize`
- API Key: `OPENAI_API_KEY`
- Model: GPT-5 Mini or GPT-5

### Test 7: Jobs Using OAuth Tokens

**Goal:** Verify jobs can use OAuth tokens via variable substitution

1. **After successful Claude OAuth login:**

2. **Create Python job using API:**
   ```python
   # Job config
   {
     "name": "test-oauth-job",
     "type": "python",
     "command": "python3 code/main.py --anthropic ${ANTHROPIC_API_KEY}",
     "requirements": ["anthropic"],
     "code": {
       "code/main.py": """
import argparse
import anthropic

parser = argparse.ArgumentParser()
parser.add_argument('--anthropic', required=True)
args = parser.parse_args()

client = anthropic.Anthropic(api_key=args.anthropic)
message = client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=100,
    messages=[{"role": "user", "content": "Say 'OAuth works!'"}]
)
print(message.content[0].text)
       """
     }
   }
   ```

3. **Run job:**
   ```bash
   # Should output: "OAuth works!"
   # Proves job received OAuth token via ${ANTHROPIC_API_KEY}
   ```

## Expected Behavior Summary

| Action | Expected Result |
|--------|----------------|
| OAuth login | Token synced to API keys list with badge |
| Send chat message | Uses OAuth token automatically |
| Job with `${OPENAI_API_KEY}` | Gets OAuth token value |
| Bash with `${ANTHROPIC_API_KEY}` | Gets OAuth token value |
| Token expires in <5 min | Auto-refreshes, updates API key |
| Disconnect OAuth | Removes OAuth-managed API key only |
| Manual key + OAuth login | OAuth overwrites manual key |
| OAuth disconnected + manual key exists | Uses manual key |
| list_keys() tool | Shows OAuth keys with metadata |

## Troubleshooting

### OAuth flow doesn't complete

**Symptoms:** Click "Sign in", browser opens, but status doesn't update

**Check:**
1. Callback server running: Look for `[OAuthCallback] Listening on http://127.0.0.1:1455`
2. Browser completed redirect
3. Check terminal for errors: `[OAuth IPC] OpenAI callback error:`

**Fix:**
- Make sure no other process is using port 1455 (OpenAI) or 1456 (Claude)
- Check firewall settings
- Try disconnecting and reconnecting

### OAuth token not appearing in API keys list

**Symptoms:** OAuth connected, but no badge in API keys list

**Check:**
```javascript
// In DevTools Console:
await window.electronAPI.customKeys.list()
// Look for OPENAI_API_KEY or ANTHROPIC_API_KEY
// Check if source: "oauth"
```

**Fix:**
- Restart app
- Disconnect and reconnect OAuth
- Check logs for sync errors: `[OAuth IPC] Failed to sync`

### Jobs/Bash not getting OAuth token

**Symptoms:** Job fails with "API key missing"

**Check:**
1. API key exists: `list_keys()` shows `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
2. Key has OAuth badge in Settings
3. Gateway received key via IPC: `[KeyResolver] ✓ OPENAI_API_KEY found`

**Fix:**
- Restart gateway process
- Check key permission is "always" (not "ask")
- Verify OAuth token not expired

### Token doesn't refresh

**Symptoms:** Token expires, user forced to re-authenticate

**Check logs:**
```
[OAuth IPC] Checking tokens for refresh...
[OAuth IPC] Refreshing anthropic token (expires soon)
```

**If missing:**
- Check refresh timer started: `[OAuth IPC] Starting token refresh timer`
- Check token expiry: `cat ~/Library/Application\ Support/Paprwork\ V2/data/oauth-tokens.json`

**Fix:**
- Restart app (starts refresh timer)
- Check OAuthTokenStorage has valid refresh token

## Success Criteria

✅ All tests pass when:
- [ ] Claude OAuth login completes successfully
- [ ] OAuth token appears in API keys list with badge
- [ ] Chat works with OAuth token
- [ ] Jobs receive OAuth token via `${ANTHROPIC_API_KEY}`
- [ ] Token auto-refreshes before expiry
- [ ] Disconnect removes only OAuth-managed key
- [ ] Manual keys preserved when appropriate

## Next Steps After Testing

1. **If tests pass:** Ready for documentation and release
2. **If tests fail:** Debug issues, fix bugs, re-test
3. **OpenAI setup:** Configure Client ID and test OpenAI flow
4. **Documentation:** Create user guide and developer docs
5. **Release:** Update changelog, create release notes
