# Stripe Projects Browser Authentication Fix

**Added:** 2026-04-22
**Issue:** Browser doesn't open reliably when `stripe login` is run

## Problem

When users need to authenticate with Stripe (via `stripe login`), the browser sometimes doesn't open automatically. This is a common issue with CLI tools that rely on OS-level browser commands.

**User Report:** "When I need to sign in, sometimes browser doesn't open up for me to do that"

## Root Cause

The `stripe login` command uses OS-level commands to open the default browser (`xdg-open` on Linux, `open` on macOS, `start` on Windows). These commands can fail silently if:
- No default browser is set
- Display environment variables are incorrect (SSH sessions, tmux)
- Browser is not in PATH
- Security restrictions block automatic browser launch

## Solution

Enhanced the authentication flow with multiple fallback options:

### 1. Enhanced Tool Response

Updated `ensureStripeReady()` to return structured instructions with three methods:

```typescript
{
  status: "needs_auth",
  message: "Use shell.openExternal() to force-open browser OR run stripe login",
  instructions: [
    "1. PREFERRED: shell.openExternal({ url: 'https://dashboard.stripe.com/login' })",
    "2. User logs in to Stripe dashboard",
    "3. Run: bash({ command: 'stripe login --interactive' }) to complete CLI pairing",
    "4. Alternative: bash({ command: 'stripe login' }) (may not open browser reliably)",
    "5. Manual fallback: Tell user to visit https://dashboard.stripe.com/login",
    "6. After login, retry connect_service action"
  ],
  manual_url: "https://dashboard.stripe.com/login",
  fallback_command: "stripe login --interactive"
}
```

### 2. SystemPrompt Guidance

Added clear instructions for agents:

```typescript
**Browser Opening Issues:** If `stripe login` doesn't open the browser (common on some systems), 
ALWAYS try `shell.openExternal()` first to force-open the Stripe dashboard, then run the CLI 
pairing command.
```

## Why This Works

**Three-tier fallback strategy:**

1. **Primary (Best):** `shell.openExternal()` - Uses Electron's native browser opener, most reliable
2. **Secondary:** `stripe login --interactive` - CLI pairing after browser login
3. **Tertiary:** Manual URL - User opens browser manually

This covers all scenarios:
- ✅ Normal case: shell.openExternal works
- ✅ Restricted environments: User manually visits URL
- ✅ SSH/tmux sessions: Agent provides manual URL immediately
- ✅ No browser configured: Manual URL always works

## User Experience

**Before:**
```
Agent: "Run stripe login"
User: *waits* "Nothing happened..."
User: *manually searches for how to authenticate Stripe CLI*
```

**After:**
```
Agent: "Opening Stripe dashboard for authentication..."
[Browser opens automatically via shell.openExternal]
Agent: "Please log in, then I'll complete the CLI pairing."
User: *logs in*
Agent: "Great! Pairing CLI now..." [runs stripe login --interactive]
Agent: "Authentication complete! Provisioning your database..."
```

**Edge Case (no browser open):**
```
Agent: "I tried to open the browser but it didn't work. Please visit this URL manually:"
Agent: "https://dashboard.stripe.com/login"
User: *opens URL, logs in*
Agent: "Now running the CLI pairing command..."
Agent: "Authentication complete!"
```

## Files Changed

- `src/core/tools/connectors.ts` - Enhanced authentication response with 3 fallback methods
- `src/core/agents/SystemPrompt.ts` - Added browser opening guidance + Stripe Projects developer preview note

## Impact

- **Before:** Browser didn't open → user stuck → manual troubleshooting required
- **After:** Multiple fallback options → always works → smooth authentication flow ✅

## Testing

Test all three methods:

1. **Primary:** `shell.openExternal({ url: 'https://dashboard.stripe.com/login' })` → verify browser opens
2. **Secondary:** `stripe login --interactive` → verify CLI pairing works
3. **Manual:** User visits URL → verify pairing completes

Test edge cases:
- SSH session (no DISPLAY) → manual URL should be provided
- tmux session → shell.openExternal or manual URL
- Headless server → manual URL only option

## Prevention

For future CLI-based authentication flows:
1. **Always use shell.openExternal() as primary method** (most reliable)
2. Provide manual URL as fallback (never leave user stuck)
3. Document all authentication methods in tool response
4. Test in restricted environments (SSH, docker, tmux)

## Related

- Enhancement 56: Service Connectors via Stripe Projects (original implementation)
- `shell.openExternal` tool: Used for reliable cross-platform browser opening
- OAuth flows: Similar pattern (deep links + manual URL fallback)
