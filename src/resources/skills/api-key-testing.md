---
id: preloaded-api-key-testing
name: API Key Testing Protocol
description: Test-first protocol for external API integration — always probe before building job code. Covers checking available keys, running sample queries, confirming data shape with the user, and common patterns for Amplitude, Stripe, Attio, and similar APIs.
---
# API Key Testing Protocol

> **The Golden Rule: Never write job code based on assumptions about API data. Always test first, confirm with user, then build.**

---

## OAuth vs API Key: Which Path for What

Users can authenticate with **OAuth** (ChatGPT/Claude subscription) or **API keys** (Platform API). Paprwork routes automatically based on what the user has:

| Context | OAuth (subscription) | API key (Platform) |
|---------|----------------------|--------------------|
| **Chat** | ✅ Uses pi-ai (ChatGPT/Claude backend) | ✅ Uses AI SDK (Platform API) |
| **Agent jobs** | ✅ Uses pi-ai — works with subscription | ✅ Uses AI SDK — needs Platform key |
| **Bash/Python jobs** | ❌ OAuth token won't work | ✅ Needs Platform API key |

**Why?** OAuth tokens use the ChatGPT/Claude subscription backend (different API). The `openai` Python SDK and `curl api.openai.com` use the **Platform API** — they require a Platform API key (`sk-proj-...`), not an OAuth token.

**When building jobs:**
- **Agent jobs** — No action needed. Paprwork routes to pi-ai when OAuth is connected, AI SDK when API key is used.
- **Bash/Python jobs that call OpenAI/Anthropic** — User must add a **Platform API key** in Settings. OAuth alone won't work for scripts. If user only has OAuth, suggest: "For this Python job to call the OpenAI API, you'll need to add an OpenAI Platform API key in Settings → API Keys. Your ChatGPT subscription (OAuth) works for chat and agent jobs, but scripts use the Platform API which needs a separate key."

---

## Step 0: Check Available Keys FIRST

Before requesting any API key, **use the key management tools** to check what already exists:

```javascript
// Check what custom keys are configured
list_keys()
// Returns: { keys: [{ name: "AMPLITUDE_API_KEY", permission: "always", ... }], count: 1 }
```

**If key EXISTS** — proceed to testing.  
**If key MISSING** — use `request_key` to show an inline input card:

```javascript
request_key({
  name: "AMPLITUDE_API_KEY",
  description: "Amplitude API key for event data export",
  sourceUrl: "analytics.amplitude.com/settings/projects",
  requiredScopes: ["read:events"],
  permission: "always"
})
```

This shows an **inline card in chat** where the user can:
- Click the source URL to get their key
- Enter the key value securely (password field)
- Select permission level (always/ask)
- Submit without leaving the conversation

**Alternative (fallback):** Direct to Settings → API Keys → Custom API Keys if `request_key` fails.

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

**Use the right job type and key pattern:**
- **Python job** (`type: "python"`) — For scripts with logic, API calls, data processing. Pass keys as CLI args in the command.
- **Bash job** (`type: "bash"`) — For simple one-liners like `curl`, `git`, `jq`. Use `${KEY_NAME}` directly in the command.

```javascript
// ✅ Python job with API key — keys in COMMAND, not in Python source
create_job({
  name: "Amplitude Sync",
  type: "python",
  command: "python3 code/main.py --amplitude-key ${AMPLITUDE_API_KEY}",
  requirements: ["requests"]
})

// ✅ Bash job — ${KEY} works in command directly
create_job({
  name: "Quick Export",
  type: "bash",
  command: "curl -H 'Authorization: Bearer ${STRIPE_KEY}' ... | jq '.'"
})
```

**❌ CRITICAL: Do NOT put `${KEY_NAME}` in Python source code.** Substitution only happens in the command string at spawn time. In Python, use `argparse` and receive the value as a CLI argument.

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

1. `list_keys` to check what keys exist; `request_key` if missing
2. `bash` with `curl` for small probe calls (`${KEY_NAME}` substitution works automatically)
3. `create_job` only after data shape is validated — use `type: "python"` for scripts with API keys, pass keys as CLI args
4. `run_job` to verify output and logs
5. `link_app_data_source` only after verified outputs

## Quick Checklist

- [ ] `list_keys` called to check existing keys before testing
- [ ] Probe query succeeds with real data (bash + curl with `${KEY_NAME}`)
- [ ] Response shape confirmed with actual sample
- [ ] Required fields mapped to SQLite columns
- [ ] Pagination/rate-limit assumptions documented
- [ ] User intent and metric definitions confirmed
- [ ] Job created with correct type: `python` for scripts, `bash` for one-liners
- [ ] Python jobs: keys passed as CLI args in command, NOT in source code
- [ ] Only then: write the job code

---

## Why This Matters

**Without testing:** Agent assumes API structure → writes 200+ lines → crashes on wrong field names → 30+ minutes wasted.

**With testing:** Agent runs 1 test query (10 seconds) → sees actual structure → confirms with user → writes correct code → works first try.
