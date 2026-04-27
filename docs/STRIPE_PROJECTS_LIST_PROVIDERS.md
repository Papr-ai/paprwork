# Stripe Projects list_providers Action - Dynamic Provider Discovery

**Added:** 2026-04-22
**Replaces:** Hardcoded provider list in SystemPrompt (Issue 62 approach)

## Problem with Hardcoded List

The original fix (Issue 62) hardcoded the provider list in SystemPrompt:
- ❌ Gets stale as Stripe adds providers
- ❌ Requires manual updates to SystemPrompt
- ❌ No way to stay current automatically
- ❌ Developer preview catalog changes frequently

## Better Solution: Dynamic list_providers Action

Added new `list_providers` action to `connect_service` tool that:
- ✅ **Always current** - Fetches live data from Stripe Projects
- ✅ **Lightweight** - Returns ~500 bytes (vs 10KB full catalog)
- ✅ **Fast** - Completes in 2-3 seconds
- ✅ **Categorized** - Groups providers by category (hosting, database, AI, etc.)
- ✅ **Cacheable** - Agent can call once per session

## Implementation

### Tool Enhancement

Added `list_providers` as 5th action to `connect_service`:

```typescript
export const connectServiceTool = createTool({
  inputSchema: z.object({
    action: z.enum(["catalog", "list_providers", "add", "status", "remove"])
  })
});
```

### Parsing Logic

1. Calls `stripe projects catalog` (human-readable output)
2. Strips ANSI escape codes
3. Extracts category headers (uppercase lines)
4. Extracts provider names from `provider/service` lines
5. Groups providers by category (using Set for deduplication)
6. Returns structured JSON

**Output format:**
```json
{
  "success": true,
  "data": {
    "categories": {
      "database": ["neon", "supabase", "turso", "planetscale", ...],
      "hosting": ["vercel", "cloudflare", "railway", ...],
      "analytics": ["amplitude", "mixpanel", "posthog"]
    },
    "providers": ["amplitude", "chroma", "clerk", ...],
    "total_providers": 18,
    "total_categories": 11
  }
}
```

### SystemPrompt Changes

**Before (Issue 62):**
```typescript
## Available Providers (34 services from 18 providers)
- **Amplitude**: analytics
- **Chroma**: database (vector DB)
// ... hardcoded list of 18 providers
```

**After (Better):**
```typescript
## Checking What's Available

Always call `connect_service({ action: "list_providers" })` first when a user 
needs an external service. This returns providers grouped by category.

If the provider the user needs is NOT in the list, immediately suggest manual 
setup. DO NOT repeatedly call list_providers or catalog.
```

## Agent Workflow

**Efficient pattern:**

```typescript
// User: "I need Loops for email"

// Step 1: Check availability (once per session)
connect_service({ action: "list_providers" })
// Returns: { providers: ["amplitude", "neon", ...] } - no "loops"

// Step 2: Immediate response (no repeated calls)
"Loops isn't available via Stripe Projects yet. Want me to set it up manually?"

// Total: 1 tool call, 2-3 seconds ✅
```

**Compare to old approach:**
- Issue 62 (hardcoded): 0 calls but stale data
- Without fix: 5+ catalog calls, 30-60 seconds

## Performance

| Metric | list_providers | Full catalog |
|--------|---------------|--------------|
| Size | ~500 bytes | ~10KB |
| Time | 2-3 seconds | 2-3 seconds |
| Truncation | Never | Always (2000 char limit) |
| Updates | Real-time | Real-time |
| Parsing | Simple (categories) | Complex (full JSON) |

## Testing

Created test script: `scripts/test-list-providers.mjs`

**Tests:**
- ✅ Category extraction (11 categories found)
- ✅ Provider deduplication (18 unique providers)
- ✅ Specific queries (neon=available, loops=not available)
- ✅ ANSI code stripping

**Run:**
```bash
node scripts/test-list-providers.mjs
```

## Files Changed

- `src/core/tools/connectors.ts` - Added `list_providers` action with parsing logic
- `src/core/agents/SystemPrompt.ts` - Replaced hardcoded list with `list_providers` guidance
- `scripts/test-list-providers.mjs` - NEW: Test script
- `docs/STRIPE_PROJECTS_LIST_PROVIDERS.md` - This file

## Impact

- **Before (Issue 62):** 0 calls but manual updates required, list gets stale
- **After:** 1 call per session, always current, no maintenance needed ✅
- **Scalability:** Works automatically as Stripe adds 100+ providers
- **User Experience:** Fast, accurate, no repeated calls

## Edge Cases Handled

1. **ANSI escape codes** - Stripped before parsing
2. **Duplicate providers** - Sets ensure uniqueness
3. **Category changes** - Parses dynamically (not hardcoded)
4. **New providers** - Automatically included
5. **Empty categories** - Filtered out

## Maintenance

**Zero maintenance required!** The list_providers action:
- Always fetches live data from Stripe
- No hardcoded lists to update
- Works as Stripe catalog grows
- Self-documenting (categories from catalog)

**Only update needed:** If Stripe changes catalog output format (unlikely in developer preview)

## Migration from Issue 62

Issue 62 hardcoded the provider list to prevent repeated catalog calls. This new approach:
- Keeps the efficiency (1 call instead of 5+)
- Adds accuracy (always current, never stale)
- Removes maintenance (no manual updates)
- Improves scalability (works with 100+ providers)

## Related

- Issue 61: Stripe Projects Browser Authentication
- Issue 62: Stripe Projects Repeated Catalog Calls (replaced by this approach)
- Enhancement 56: Service Connectors via Stripe Projects (original implementation)
