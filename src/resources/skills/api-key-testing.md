---
id: preloaded-api-key-testing
name: API Key Testing Protocol
description: Test-first protocol for external API integration — always probe before building job code. Covers checking available keys, running sample queries, confirming data shape with the user, and common patterns for Amplitude, Stripe, Attio, and similar APIs.
---
# API Key Testing Protocol

> **The Golden Rule: Never write job code based on assumptions about API data. Always test first, confirm with user, then build.**

---

## Step 0: Check Available Keys FIRST

Before requesting any API key, check what already exists:

```bash
# List custom keys the user has configured
bash({ command: "env | grep -E 'KEY|TOKEN|SECRET' | sort" })
```

**If key EXISTS** — proceed to testing.  
**If key MISSING** — tell the user they need to add it in Settings > Custom API Keys. Provide the URL where they can find their key.

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
- Confirm data quality/format
- Get user approval before writing job code

---

## Step-by-Step Protocol

### Step 1: Run a Small Test Query

Before writing any job code, run a minimal query to see real data:

```bash
# Amplitude Export API
curl -u "${AMPLITUDE_API_KEY}:${AMPLITUDE_SECRET_KEY}" \
  "https://amplitude.com/api/2/export?start=20260207T00&end=20260207T01" | \
  jq '.data[0:3]'

# Stripe API
curl -H "Authorization: Bearer ${STRIPE_KEY}" \
  "https://api.stripe.com/v1/charges?limit=3" | \
  jq '.data[0:3] | .[] | {id, amount, currency, customer}'

# Attio CRM
curl -H "Authorization: Bearer ${ATTIO_KEY}" \
  "https://api.attio.com/v2/lists" | jq '.data[0:3]'
```

### Step 2: Share Results With User

Show what you found before writing any code:

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

Only after confirmation, create the job with `create_job` and the verified field names.

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

1. `bash` with `curl` for small probe calls (key substitution works automatically)
2. `create_job` only after data shape is validated
3. `run_job` to verify output and logs
4. `link_app_data_source` only after verified outputs

## Quick Checklist

- [ ] Probe query succeeds with real data
- [ ] Response shape confirmed with actual sample
- [ ] Required fields mapped to SQLite columns
- [ ] Pagination/rate-limit assumptions documented
- [ ] User intent and metric definitions confirmed
- [ ] Only then: write the job code

---

## Why This Matters

**Without testing:** Agent assumes API structure → writes 200+ lines → crashes on wrong field names → 30+ minutes wasted.

**With testing:** Agent runs 1 test query (10 seconds) → sees actual structure → confirms with user → writes correct code → works first try.
