# Claude OAuth Status - March 2026

**Date:** 2026-03-09  
**Status:** ⚠️ **OAuth Disabled by Anthropic**

## Critical Update

As of **February 2026**, Anthropic has **disabled OAuth token authentication for third-party applications**. This means the OAuth flow we implemented no longer works for API access.

## What Happened

### Issue #28091: Anthropic Disabled OAuth Tokens

From the GitHub issue tracking:

> "Anthropic disabled OAuth tokens for third-party API access in February 2026. OAuth workspace tokens (prefix `sk-ant-oat*`) generated via `claude setup-token` are no longer accepted by the API."

**Error messages users see:**
- "invalid x-api-key"  
- "OAuth authentication is currently not supported"

This is a **breaking change** that affects all paying Claude Pro/Max subscribers who previously used OAuth for third-party integrations.

## Technical Details of Our Implementation Attempt

### What We Tried

1. **Authorization Request (GET)** - ✅ **Works**
   ```
   GET https://claude.ai/oauth/authorize?
     code=true
     &client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e
     &response_type=code
     &redirect_uri=http://127.0.0.1:1456/auth/callback
     &scope=user:profile user:inference
     &code_challenge=...
     &code_challenge_method=S256
     &state=...
   ```
   **Result:** 200 OK - Authorization page loads successfully

2. **Authorization Submission (POST)** - ❌ **Fails**  
   When user clicks "Authorize", Claude's UI POSTs back to the authorize endpoint:
   ```
   POST https://claude.ai/v1/oauth/authorize
   Content-Type: application/json
   
   {
     "response_type": "code",
     "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
     "organization_uuid": "7fcda6e1-1735-4478-a566-0125a0a4306f",
     "redirect_uri": "http://127.0.0.1:1456/auth/callback",
     "code": "true",
     "scope": "user:profile user:inference",
     "state": "..."
   }
   ```
   **Result:** 400 Bad Request - "Invalid request format"

### Why It Fails

The POST request includes an `organization_uuid` parameter that Claude's OAuth UI automatically adds. This suggests:

1. **Third-party OAuth is restricted** - Anthropic may only allow OAuth for their own first-party apps (Claude Desktop, Claude Code CLI)
2. **Organization-level permissions required** - Individual Pro/Max subscriptions may not support OAuth API access
3. **Client ID is invalid/deprecated** - The client ID we're using may have been revoked for third-party use

## Alternative: Use API Keys Instead

Since OAuth is disabled, users should use **Anthropic Console API keys** instead:

### How to Get an API Key

1. Go to https://console.anthropic.com/
2. Navigate to "API Keys"  
3. Click "Create Key"
4. Copy the key (starts with `sk-ant-api03-...`)
5. Add it to Paprwork Settings under "API Keys"

### Comparison

| Method | Status | Cost | Access |
|--------|--------|------|--------|
| **OAuth (Pro/Max)** | ❌ Disabled | Subscription | Third-party blocked |
| **API Keys** | ✅ Working | Pay-per-token | Full API access |

## Should We Remove OAuth UI?

### Keep OAuth Code (Don't Remove)

Even though OAuth is currently disabled, we should **keep the implementation** because:

1. **Anthropic may re-enable it** - They disabled it suddenly, they could enable it again
2. **First-party apps still work** - Claude Desktop and Claude Code CLI still use OAuth
3. **Documentation value** - Shows how OAuth *should* work when/if it's restored
4. **No harm in keeping** - The UI can show a warning message but still offer the option

### Update UI with Warning

Add a warning message in Settings:

```
⚠️ Note: As of February 2026, Anthropic has disabled OAuth authentication 
for third-party applications. Please use API keys instead.

OAuth connection is currently unavailable. Learn more →
```

## Technical Implementation Notes

### What We Got Right

1. ✅ **Content-Type for token exchange** - `application/x-www-form-urlencoded` per OAuth 2.0 RFC 6749
2. ✅ **PKCE implementation** - Proper SHA-256 code challenge
3. ✅ **Redirect URI matching** - Local callback server matches OAuth config
4. ✅ **State parameter** - CSRF protection implemented correctly

### What Anthropic Changed

1. ❌ **OAuth tokens disabled** - `sk-ant-oat*` tokens no longer accepted by API
2. ❌ **Third-party client IDs blocked** - Only first-party apps can use OAuth
3. ❌ **Organization restrictions** - Individual subscriptions can't use OAuth for API access

## For Developers: Testing OAuth

If you want to test if OAuth gets re-enabled:

```bash
# 1. Start Paprwork
npm start

# 2. Open Settings → Claude Pro/Max → Connect
# 3. Try OAuth flow
# 4. Check terminal for errors

# Expected current behavior:
# - Authorization page loads (200 OK)
# - Click "Authorize" → 400 Bad Request "Invalid request format"
```

## References

- **Issue #28091**: "Anthropic disabled OAuth tokens for third-party apps" (Feb 2026)
- **OAuth 2.0 RFC 6749**: https://datatracker.ietf.org/doc/html/rfc6749
- **Anthropic Console**: https://console.anthropic.com/

## Recommendation

**For Paprwork V2:** 

1. ✅ Keep OAuth implementation code (for when/if it's restored)
2. ✅ Add warning message in UI about OAuth being disabled
3. ✅ Promote API key authentication as the primary method
4. ✅ Document this situation for users

**For Users:**

Use Anthropic Console API keys instead of OAuth until Anthropic re-enables third-party OAuth access.

---

**Status:** ⚠️ OAuth implementation is correct but disabled by Anthropic  
**Last Updated:** 2026-03-09
