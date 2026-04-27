# Stripe Projects Authentication - Quick Reference

## When Authentication is Needed

The agent will detect when Stripe authentication is required and use this flow:

## Three-Tier Authentication Flow

### Method 1: Force-Open Browser (Preferred) ✅

**Most reliable** - Uses Electron's native browser opener:

```typescript
// Agent calls:
shell.openExternal({ url: 'https://dashboard.stripe.com/login' })

// Then after user logs in:
bash({ command: 'stripe login --interactive' })
```

**Why:** `shell.openExternal()` bypasses OS-level browser command issues

### Method 2: CLI Auto-Open (Fallback)

**May work** - Relies on OS browser commands:

```typescript
bash({ command: 'stripe login' })
```

**Limitations:** May not open browser in:
- SSH sessions (no DISPLAY)
- tmux/screen sessions
- Headless environments
- Systems without default browser

### Method 3: Manual URL (Always Works)

**Guaranteed fallback** - User opens browser manually:

```
1. Agent provides URL: https://dashboard.stripe.com/login
2. User manually visits URL and logs in
3. Agent runs: bash({ command: 'stripe login --interactive' })
```

## Authentication Check

The tool automatically checks authentication before provisioning:

```typescript
// Returns this if not authenticated:
{
  status: "needs_auth",
  message: "Use shell.openExternal() to force-open browser OR run stripe login",
  manual_url: "https://dashboard.stripe.com/login",
  fallback_command: "stripe login --interactive"
}
```

## Complete Example Flow

```typescript
// User asks to provision a database
connect_service({ action: "add", provider: "neon", service: "database" })

// If not authenticated, returns:
{
  success: false,
  data: {
    status: "needs_auth",
    instructions: [
      "1. PREFERRED: shell.openExternal({ url: 'https://dashboard.stripe.com/login' })",
      "2. User logs in to Stripe dashboard",
      "3. Run: bash({ command: 'stripe login --interactive' })",
      "4. Alternative: bash({ command: 'stripe login' })",
      "5. Manual fallback: Visit https://dashboard.stripe.com/login",
      "6. Retry connect_service action"
    ]
  }
}

// Agent uses Method 1:
shell.openExternal({ url: 'https://dashboard.stripe.com/login' })
// → Browser opens, user logs in

bash({ command: 'stripe login --interactive' })
// → CLI pairs with authenticated session

// Retry provisioning:
connect_service({ action: "add", provider: "neon", service: "database" })
// → Success! Database provisioned, credentials stored
```

## Verification

Check authentication status:

```bash
stripe projects status --json | jq '.meta.authenticated'
# Should return: true
```

## Troubleshooting

**Browser doesn't open with Method 1:**
- Check if `shell.openExternal` tool is available
- Try Method 3 (manual URL) instead

**"pairing code failed":**
- User needs to log in to dashboard FIRST (step 2)
- Then run `stripe login --interactive` (step 3)

**"not authenticated" persists:**
- Run `stripe logout` then retry full flow
- Check Stripe dashboard for active session

## Files Reference

- Tool: `src/core/tools/connectors.ts`
- Guidance: `src/core/agents/SystemPrompt.ts` (buildConnectorsSection)
- Docs: `docs/STRIPE_PROJECTS_BROWSER_FIX.md`
