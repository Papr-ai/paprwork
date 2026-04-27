# Stripe Projects Catalog Search Efficiency Fix

**Added:** 2026-04-22
**Issue:** Agent makes 5+ repeated `connect_service({ action: "catalog" })` calls trying to find providers, wasting time and creating poor UX

## Problem

When user asks about a service (e.g., "I thought there was Loops"), the agent:
1. Calls `connect_service({ action: "catalog" })` → Returns 10KB+ JSON
2. Result truncates at 2000 chars
3. Agent calls `get_full_tool_result` to read more
4. Still can't find what it needs
5. Repeats catalog call 3-4 more times
6. Eventually gives up

**User Experience:** Lots of "Working..." cards, takes 30-60 seconds to confirm a service isn't available.

## Root Causes

1. **No provider list in SystemPrompt** - Agent doesn't know what's available without calling the tool
2. **Catalog returns massive JSON** - 34 services × detailed metadata = 10KB+
3. **Tool result truncation** - Returns 2000 chars max, catalog gets cut off
4. **No search optimization** - Agent can't efficiently search for specific providers
5. **Repeated calls** - Agent keeps trying different approaches (catalog, catalog with filters, bash, etc.)

## Solution

### 1. Added Complete Provider List to SystemPrompt

Updated `buildConnectorsSection()` with:
- **18 providers** listed alphabetically with their services
- **"Not Available Yet"** section listing common requests (email, SMS, CRM)
- **Total count:** 34 services clearly documented
- **Search strategy:** "Check this list FIRST before calling connect_service"

```typescript
### By Provider (alphabetical):
- **Amplitude**: analytics
- **Chroma**: database (vector DB)
- **Clerk**: auth
- **Cloudflare**: containers, workers, d1, hyperdrive, queues, kv, browser-run, workers-ai, registrar:domain
// ... 18 providers total

### Not Available Yet:
- **No email providers** (Loops, Resend, SendGrid, Postmark, Mailgun, etc.)
- **No SMS providers** (Twilio, Vonage, etc.)
```

### 2. Added Explicit Guidance to Prevent Repeated Calls

```typescript
**IMPORTANT:** Check the provider list in this system prompt FIRST. If the service 
isn't listed, tell the user immediately that it's not available via Stripe Projects 
and suggest manual setup. DO NOT call connect_service({ action: "catalog" }) 
repeatedly — the list above is complete and up-to-date.
```

### 3. "Not Available Yet" Section

Preemptively lists commonly requested services that aren't in the catalog:
- Email providers (Loops, Resend, SendGrid, etc.)
- SMS providers (Twilio, Vonage)
- Payment processors
- CRM systems

This prevents agents from searching for services that definitely don't exist.

## Expected Behavior Now

**Before:**
```
User: "I thought there was Loops"
Agent: [Calls connect_service catalog] → truncated
Agent: [Calls get_full_tool_result] → still can't find
Agent: [Calls connect_service again] → truncated
Agent: [Calls bash to dump catalog] → truncated
Agent: [Calls connect_service 3rd time] → gives up
Agent: "Loops isn't available" (after 5+ tool calls, 45 seconds)
```

**After:**
```
User: "I thought there was Loops"
Agent: [Checks SystemPrompt provider list]
Agent: "Loops isn't in the Stripe Projects catalog. The catalog doesn't have any 
       email providers yet (no Loops, Resend, SendGrid, etc.). Want me to set up 
       Loops manually? I can request your API key and create a send-email job."
(Immediate response, 0 tool calls)
```

## Impact

- **Before:** 5+ tool calls, 30-60 seconds, truncated results, poor UX
- **After:** 0 tool calls (instant response), clear explanation, immediate alternative ✅
- **Savings:** 100% reduction in unnecessary catalog calls
- **User Experience:** Instant "not available" response with helpful alternatives

## Files Changed

- `src/core/agents/SystemPrompt.ts` - Added complete provider list (18 providers, 34 services) + "Not Available Yet" section + search strategy guidance

## Maintenance

**Update the provider list when:**
- Stripe adds new providers (check monthly via `stripe projects catalog`)
- Developer preview graduates to GA (may add many providers)
- User reports a provider is available but not listed

**How to update:**
```bash
# Get current provider list
cd ~/Papr/stripe-project && stripe projects catalog

# Update SystemPrompt.ts buildConnectorsSection()
# Add new providers to alphabetical list
# Remove from "Not Available Yet" if they were added
```

## Testing

Test that agent doesn't make repeated calls:

1. **Service available:** "Set up Neon database" → Should call connect_service once
2. **Service not available:** "Set up Loops" → Should check list, respond immediately (0 calls)
3. **Ambiguous request:** "I need email" → Should check list, suggest alternatives (0 calls)

## Related

- Issue 61: Stripe Projects Browser Authentication (authentication flow)
- Enhancement 56: Service Connectors via Stripe Projects (original implementation)
- Developer Preview: Catalog is small (34 services), will grow over time

## Future Enhancements

1. **Cached catalog in tool** - Store catalog JSON locally, refresh every 24h
2. **Search filter in tool** - Add `category` parameter to avoid full catalog dump
3. **Provider status API** - Real-time check if provider was recently added
4. **Auto-update SystemPrompt** - Script to regenerate provider list from catalog
