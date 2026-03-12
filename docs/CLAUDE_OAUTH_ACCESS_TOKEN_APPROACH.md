# Claude OAuth: Access Token Approach

**Date:** 2026-03-09  
**Status:** ✅ Recommended Approach

## Overview

Instead of implementing the full OAuth authorization code flow (which is currently failing), we can support **direct OAuth access tokens** like OpenClaw does.

## What is a Claude OAuth Access Token?

- **Format:** `sk-ant-oat01-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
- **Validity:** 1 year
- **Source:** Generated via `claude setup-token` command
- **Usage:** Works exactly like an API key but uses your Claude Pro/Max subscription

## Three Ways to Get the Token

### Option 1: Manual (Simplest - Implement First) ⭐

**User Steps:**
```bash
# 1. Install Claude Code CLI
npm install -g @anthropic/claude-code

# 2. Generate token
claude setup-token

# 3. Copy the displayed token (sk-ant-oat01-...)
```

**In Paprwork:**
- Add "Paste OAuth Token" button in Settings
- User pastes the token
- We store it like we store API keys
- Works immediately with no OAuth flow needed

**Pros:**
- ✅ Simple to implement (already have token storage)
- ✅ No OAuth flow issues
- ✅ Works with Claude Pro/Max subscriptions
- ✅ 1-year validity (no frequent re-auth)

**Cons:**
- ❌ Requires Claude Code CLI installation
- ❌ Manual copy-paste step
- ❌ Less seamless than full OAuth

### Option 2: Automate Token Generation (Medium Complexity)

We can automate running `claude setup-token` from within Paprwork:

```typescript
// Pseudocode
async function generateClaudeToken() {
  // 1. Check if Claude Code CLI is installed
  const hasClaudeCLI = await checkCommand('claude');
  
  if (!hasClaudeCLI) {
    // Offer to install it
    await installClaudeCLI(); // npm install -g @anthropic/claude-code
  }
  
  // 2. Run claude setup-token
  // This will open browser for OAuth
  const result = await exec('claude setup-token');
  
  // 3. Parse the output to extract token
  const token = extractTokenFromOutput(result.stdout);
  
  // 4. Store it
  await storeOAuthToken(token);
}
```

**Pros:**
- ✅ More automated than manual copy-paste
- ✅ Still uses official Claude Code CLI
- ✅ No need to implement OAuth ourselves

**Cons:**
- ⚠️ Requires installing Claude Code CLI
- ⚠️ Still opens browser for OAuth
- ⚠️ Need to parse CLI output (could break with updates)

### Option 3: Fully Automated OAuth (Most Complex)

Implement our own OAuth flow that generates the token directly:

```typescript
async function automatedClaudeOAuth() {
  // 1. Open OAuth authorization in embedded browser
  const authWindow = new BrowserWindow({
    webPreferences: { session: isolatedSession }
  });
  
  // 2. Load claude.ai OAuth page
  await authWindow.loadURL(oauthURL);
  
  // 3. Intercept the OAuth callback
  session.webRequest.onBeforeRequest({ urls: ['*://callback*'] }, (details) => {
    const url = new URL(details.url);
    const code = url.searchParams.get('code');
    
    // 4. Exchange code for token using claude.ai API
    const token = await exchangeCodeForToken(code);
    
    // 5. Store and close
    await storeOAuthToken(token);
    authWindow.close();
  });
}
```

**Pros:**
- ✅ Fully automated (single click)
- ✅ No external dependencies
- ✅ Best user experience

**Cons:**
- ❌ Currently failing with "Invalid request format"
- ❌ May be blocked for third-party apps
- ❌ Most complex to debug and maintain

## Recommended Implementation Plan

### Phase 1: Manual Token Paste (Quick Win) ⭐

1. Add "OAuth Token" field in Settings next to API key
2. Add helper text: "Get your token by running `claude setup-token`"
3. Store token same way as API keys
4. Update authentication to check for OAuth token first

**Implementation:**
- Add IPC handler: `auth:claude:paste-token`
- Modify `CustomKeysStorage` to accept OAuth tokens
- No OAuth flow needed!

### Phase 2: CLI Automation (If Users Request)

1. Check for Claude Code CLI installation
2. Offer to install if missing
3. Run `claude setup-token` programmatically
4. Parse and auto-fill the token

### Phase 3: Full OAuth (If We Can Fix It)

1. Debug why OAuth authorize POST fails
2. Try different endpoints/parameters
3. Contact Anthropic for third-party OAuth support

## Implementation: Phase 1 (Paste Token)

Let me create the code for the simplest approach:

### 1. Add IPC Handler

```typescript
// src/electron/ipc/oauth.ts
ipcMain.handle("auth:claude:paste-token", async (event, token: string) => {
  try {
    // Validate token format
    if (!token.startsWith('sk-ant-oat')) {
      return {
        success: false,
        error: 'Invalid token format. OAuth tokens start with sk-ant-oat'
      };
    }
    
    // Store as OAuth token (1 year expiry)
    const tokenInput = {
      provider: "anthropic" as const,
      accessToken: token,
      refreshToken: token, // OAuth tokens are self-contained
      expiresIn: 365 * 24 * 60 * 60, // 1 year in seconds
    };
    
    await oauthTokenStorage!.storeToken(tokenInput);
    
    // Sync to CustomKeysStorage for jobs/bash access
    await syncOAuthTokenToApiKeys("anthropic", token);
    
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message
    };
  }
});
```

### 2. Add UI Component

```typescript
// ui/components/Settings/ClaudeAuth.tsx
function ClaudeOAuthSection() {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  
  async function handlePasteToken() {
    setStatus('saving');
    
    const result = await window.api.invoke('auth:claude:paste-token', token);
    
    if (result.success) {
      setStatus('success');
      setToken(''); // Clear input
    } else {
      setStatus('error');
      alert(result.error);
    }
  }
  
  return (
    <div className="oauth-section">
      <h3>Claude Pro/Max OAuth Token</h3>
      
      <div className="help-text">
        <p>Get your OAuth token by running:</p>
        <code>claude setup-token</code>
        <p>Then paste it below. Token is valid for 1 year.</p>
      </div>
      
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="sk-ant-oat01-..."
        className="token-input"
      />
      
      <button 
        onClick={handlePasteToken}
        disabled={!token || status === 'saving'}
      >
        {status === 'saving' ? 'Saving...' : 'Save OAuth Token'}
      </button>
      
      {status === 'success' && (
        <div className="success">✓ OAuth token saved!</div>
      )}
    </div>
  );
}
```

### 3. Update Authentication Logic

The OAuth token will be used automatically since it's stored in `OAuthTokenStorage` and our `keyResolver` already checks OAuth tokens before API keys.

## Comparison with OpenClaw

| Feature | OpenClaw | Paprwork (Phase 1) |
|---------|----------|-------------------|
| OAuth Token Support | ✅ `openclaw models auth paste-token` | ✅ Paste in Settings UI |
| Auto-generation | ❌ Manual CLI | ❌ Manual CLI |
| Token Storage | `~/.openclaw/agents/*/auth-profiles.json` | Encrypted in Electron safeStorage |
| Token Refresh | ❌ Manual renewal after 1 year | ❌ Manual renewal (could add reminder) |
| Full OAuth Flow | ❌ Removed due to Anthropic ban | ⚠️ Attempted but failing |

## User Instructions

### For Users:

**Step 1: Get Your OAuth Token**
```bash
# Install Claude Code CLI (one-time)
npm install -g @anthropic/claude-code

# Generate token
claude setup-token
```

**Step 2: Add to Paprwork**
1. Open Paprwork Settings
2. Go to "API Keys & Authentication"
3. Find "Claude OAuth Token" section
4. Paste your token (starts with `sk-ant-oat01-`)
5. Click "Save OAuth Token"

**Step 3: Use Claude**
- Select any Claude model
- Your subscription is used automatically
- No per-token charges!

## Benefits Over API Keys

| Aspect | OAuth Token | API Key |
|--------|-------------|---------|
| **Cost** | Free (uses subscription) | Pay per token |
| **Models** | All subscription models | All API models |
| **Rate Limits** | Subscription limits | API limits |
| **Billing** | $20-200/month flat | Usage-based |
| **Validity** | 1 year | Forever (until revoked) |

## Next Steps

1. **Implement Phase 1** (paste token) - Quick win, works immediately
2. **Test with real OAuth token** from `claude setup-token`
3. **Consider Phase 2** (CLI automation) if users request it
4. **Keep Phase 3** (full OAuth) on backlog in case we can fix it

---

**Recommendation:** Start with Phase 1 (manual paste). It's simple, works reliably, and provides immediate value. We can always add automation later if users want it.
