# Stripe Projects - Simplified CLI-First Architecture

**Final Design:** 2026-04-22
**Replaces:** Complex multi-action tool approach

## The Problem with Multi-Action Tools

Original `connect_service` tool had 6 actions:
- `list_providers` - List available providers
- `catalog` - Browse full catalog
- `check_auth` - Verify authentication
- `add` - Provision + auto-store
- `status` - Check provisioned services
- `remove` - Deprovision service

**Issues:**
- Agent already has CLI access via `bash()` for all of these
- Tool abstraction hides CLI output (harder to debug)
- Tool parsing can break when CLI output changes
- Maintains duplicate logic (CLI + tool)
- More complex to maintain

## The Solution: CLI-First + Minimal Tool

**Use Stripe CLI directly for:** Everything except provisioning
**Use `provision_service` tool for:** Provisioning with automatic credential storage

## Why Keep a Tool at All?

The **ONLY** reason:

```typescript
// Without tool - Agent might forget:
bash({ command: 'stripe projects add neon/database --json > /tmp/creds.json' })
// Agent forgets to extract and store credentials ❌
// Later: Job uses ${NEON_DATABASE_URL} → fails

// With tool - Guaranteed storage:
provision_service({ provider: 'neon', service: 'database' })
// Automatically extracts NEON_DATABASE_URL and stores it ✅
// Jobs work immediately
```

**The tool is a reliability guarantee** - credentials are ALWAYS stored.

## Architecture

```typescript
export const provisionServiceTool = createTool({
  id: "provision_service",
  // Does THREE things:
  // 1. Runs: stripe projects add provider/service --json
  // 2. Parses credentials from JSON output
  // 3. Auto-stores ALL credentials via CustomKeysService
});
```

**That's it.** 400 lines → tool does ONE thing well.

## Agent Workflow

### Checking Availability (CLI)

```bash
# Search catalog
stripe projects catalog | grep loops
# Not found

stripe projects catalog | grep neon
# Found: neon/postgres
```

### Authentication (CLI)

```typescript
// 1. Open browser
shell.openExternal({ url: 'https://dashboard.stripe.com/login' })

// 2. Pair CLI after user logs in
bash({ command: 'stripe login --interactive' })

// 3. Verify
bash({ command: 'stripe projects status' })
// Output shows: authenticated: true
```

### Provisioning (TOOL)

```typescript
provision_service({ 
  provider: 'neon', 
  service: 'database' 
})

// Returns:
// {
//   success: true,
//   credentials_stored: ['NEON_DATABASE_URL'],
//   message: '✓ Provisioned neon/database. Auto-stored 1 credential in keychain.'
// }
```

### Status Checks (CLI)

```bash
stripe projects status
stripe projects env
```

## Benefits

### 1. Simplicity
- **Before:** 723 lines, 6 actions, complex switch statement
- **After:** 400 lines, 1 purpose, clear logic

### 2. Transparency
- **Before:** Tool hides CLI output in structured JSON
- **After:** Agent sees real CLI output, understands what's happening

### 3. Flexibility
- **Before:** Tool must support every CLI feature
- **After:** Agent can use ANY CLI command directly

### 4. Maintainability
- **Before:** Tool breaks when CLI output format changes
- **After:** Only 1 parsing function to maintain (credential extraction)

### 5. Debuggability
- **Before:** "Tool failed" - why? Check tool code, check CLI, check parsing
- **After:** See exact CLI command + output in chat

## What Changed

### Removed Actions

| Old Action | New Approach |
|-----------|--------------|
| `list_providers` | `bash({ command: 'stripe projects catalog' })` |
| `catalog` | `bash({ command: 'stripe projects catalog \| grep provider' })` |
| `check_auth` | `bash({ command: 'stripe projects status' })` |
| `status` | `bash({ command: 'stripe projects status' })` |
| `remove` | `bash({ command: 'stripe projects remove provider/service' })` |

### Kept Action (Renamed)

| Old | New | Why |
|-----|-----|-----|
| `connect_service({ action: "add" })` | `provision_service()` | Auto-stores credentials (reliability) |

## Files Changed

1. **src/core/tools/connectors.ts** - Simplified from 723 → 400 lines
2. **src/core/agents/SystemPrompt.ts** - CLI-first guidance instead of tool catalog
3. **docs/STRIPE_PROJECTS_CLI_FIRST.md** - This file

## Comparison

### Old Approach (Multi-Action Tool)

```typescript
// Check availability
connect_service({ action: "list_providers" })
// → Returns structured JSON, hides CLI

// Provision
connect_service({ action: "add", provider: "neon", service: "database" })
// → Works but abstracts away what's happening

// Check status
connect_service({ action: "status" })
// → Returns structured JSON
```

**Issues:**
- Agent doesn't see CLI output
- Can't handle edge cases
- Tool must support every feature
- Breaks when CLI changes

### New Approach (CLI-First)

```typescript
// Check availability
bash({ command: 'stripe projects catalog | grep neon' })
// → Agent sees real output, can search/filter/parse

// Provision
provision_service({ provider: "neon", service: "database" })
// → Guarantees credential storage

// Check status
bash({ command: 'stripe projects status' })
// → Agent sees real CLI output
```

**Benefits:**
- Full CLI transparency
- Handles any edge case
- Agent learns from output
- Reliable credential storage

## Testing

```bash
# Test CLI access
stripe projects catalog
stripe projects status

# Test tool
# (Run via agent or direct tool test)
```

## User's Key Insight

> "Why not just tell the agent they have CLI access and let the agent work that way?"

**Answer:** You're right! The agent is MORE capable with direct CLI access. We only need a tool for the ONE thing that requires guaranteed execution: credential storage.

This is a perfect example of **minimal abstraction** - only wrap what absolutely needs wrapping.

## Related Docs

- Enhancement 56: Service Connectors (original complex implementation)
- Issue 61: Browser Authentication (auth flow)
- Issue 62: Repeated Catalog Calls (superseded by CLI approach)
