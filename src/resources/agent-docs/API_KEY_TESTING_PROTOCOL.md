# API Key Testing Protocol (V2)

## CRITICAL: Test-First Approach with External APIs

When working with external APIs (Amplitude, Stripe, Attio, CRMs, ads, analytics), you MUST follow this protocol. Never build job code based on assumptions about API data.

---

## Step 0: Check Available Keys FIRST

Before requesting any API key, check what already exists. Use `bash` to inspect available custom keys.

**If key EXISTS** — proceed to testing.
**If key MISSING** — inform the user they need to add it in Settings > Custom API Keys. Provide the URL where they can find their key.

---

## The Rule: Test Before Building

**NEVER assume:**
- What data the API returns
- What fields are available
- What the data structure looks like
- What permissions the user's key has
- What the rate limits are

**ALWAYS test first to:**
- Verify the key works
- See actual data structure
- Understand available fields
- Check data quality/format
- Confirm with user before proceeding

---

## Step-by-Step Protocol

### Step 1: Run a Small Test Query

Before writing any job code, run a minimal query to see real data:

```bash
# Example: Amplitude Export API
curl -u "${AMPLITUDE_API_KEY}:${AMPLITUDE_SECRET_KEY}" \
  "https://amplitude.com/api/2/export?start=20260207T00&end=20260207T01" | \
  jq '.data[0:3]'
```

### Step 2: Share Results With User

Show the user what you found:

```
I tested the Amplitude API and found these event fields:
- event_type: "page_view", "login", "signup"
- location: "/" or "/docs" or "/auth"
- user_id: "abc123..."
- event_time: "2026-02-07T10:30:00.000Z"

Based on this, I can build a job that:
1. Tracks prelogin visitors (location == "/" or "/docs")
2. Tracks logins (event_type contains "login")
3. Computes conversion rates

Does this match what you expected? Should I proceed?
```

### Step 3: Wait for Confirmation

Do NOT proceed until user confirms:
- Data structure is correct
- Fields are what they expected
- Logic makes sense for their use case

### Step 4: Build the Job

Only after confirmation, create the job with `create_job` and verified field names.

---

## Common Scenarios

### Scenario 1: Amplitude Events

```bash
curl -u "${AMPLITUDE_API_KEY}:${AMPLITUDE_SECRET_KEY}" \
  "https://amplitude.com/api/2/export?start=YYYYMMDDTHH&end=YYYYMMDDTHH" | \
  jq '.data[0:5] | .[] | {event_type, user_id, event_properties: .event_properties | keys}'
```

**Check:** Does `event_properties` have the fields you need? Is `location` or `page_url` available? Are there nulls?

### Scenario 2: Stripe API

```bash
curl -H "Authorization: Bearer ${STRIPE_KEY}" \
  "https://api.stripe.com/v1/charges?limit=3" | \
  jq '.data[0:3] | .[] | {id, amount, currency, customer}'
```

**Check:** Is `customer` an ID or full object? Is `amount` in cents or dollars?

### Scenario 3: Attio CRM

```bash
curl -H "Authorization: Bearer ${ATTIO_KEY}" \
  "https://api.attio.com/v2/lists" | jq '.data[0:3]'
```

**Check:** What lists are available? What fields exist on records?

---

## Red Flags (Stop and Ask)

**STOP and ask for clarification if:**
- Test query returns empty data
- Expected fields are missing
- Data format is unexpected
- Permission/authentication errors
- Rate limits are very low
- Data quality is poor (lots of nulls)

Example response:
```
I tested the API but didn't find a 'location' field in the events.
I only see: event_type, user_id, timestamp.

How should I determine if a visitor is "prelogin"?
Is there another field I should use?
```

---

## V2 Execution Pattern

1. Use `bash` (with key substitution) for small probe calls
2. Use `create_job` only after data shape is validated
3. Use `run_job` to verify output and logs
4. Wire app only after verified outputs (`link_app_data_source`)

## Quick Checklist

- [ ] Probe query succeeds
- [ ] Response shape confirmed with real sample
- [ ] Required fields mapped to SQLite columns
- [ ] Pagination/rate-limit assumptions documented
- [ ] User intent and metric definitions confirmed
- [ ] Only then: write the job code

---

## Why This Matters

**Without testing:** Agent assumes API structure → writes 200+ lines → crashes on wrong field names → 30+ minutes wasted.

**With testing:** Agent runs 1 test query (10 seconds) → sees actual structure → confirms with user → writes correct code → works first try.

> **The Golden Rule: Never write job code based on assumptions about API data. Always test first, confirm with user, then build.**
