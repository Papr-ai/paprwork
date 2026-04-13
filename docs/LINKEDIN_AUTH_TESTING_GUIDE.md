# LinkedIn Authentication Testing Guide

**Date:** 2026-04-08  
**Purpose:** Verify the updated social-media-auth skill correctly guides agent to set up LinkedIn authentication with cookie rotation handling

---

## Overview

This guide tests the complete LinkedIn authentication flow from skill loading through job creation and session management.

---

## Test Environment Setup

### Prerequisites

- Paprwork V2 running locally
- Access to LinkedIn account for testing
- Chrome installed at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

### Clean State

Before testing, ensure clean state:

```bash
# Remove any existing LinkedIn auth
rm -rf ~/.papr-linkedin/
pkill -f "remote-debugging-port=9222"

# Check for existing LinkedIn jobs
ls ~/Papr/Jobs/ | grep -i linkedin
# Delete any found
```

---

## Test Scenarios

### Test 1: Skill Loading ✅

**Goal:** Verify agent loads social-media-auth skill when user asks about LinkedIn

**User Message:**
```
"I want to connect my LinkedIn account so you can automate posting for me"
```

**Expected Agent Behavior:**
1. Agent recognizes this as LinkedIn authentication request
2. Agent calls: `read_skill({ skillId: "preloaded-social-media-auth" })`
3. Agent acknowledges LinkedIn requires special handling (cookie rotation)
4. Agent proposes creating 2 jobs: Auth + Chrome Manager

**Verification:**
- [ ] Agent loads the skill
- [ ] Agent mentions cookie rotation handling
- [ ] Agent proposes 2 jobs (not just 1)
- [ ] Agent explains Chrome Manager purpose

---

### Test 2: Auth Job Creation ✅

**Goal:** Verify agent creates LinkedIn Auth job correctly

**Expected Agent Actions:**
```javascript
create_job({
  name: "LinkedIn Auth — Cookie Capture",
  type: "node",
  command: "node linkedin_auth.js",
  requirements: ["puppeteer-core", "better-sqlite3"],
  folder: "LinkedIn"
})
```

**Verification:**
- [ ] Job created with correct name
- [ ] Job type is "node" (not python/bash)
- [ ] Command is "node linkedin_auth.js"
- [ ] Requirements include puppeteer-core and better-sqlite3
- [ ] Folder is "LinkedIn"

**Check Job Files:**
```bash
# Find the auth job ID
AUTH_JOB_ID=$(cat ~/Papr/data/jobs.json | jq -r '.[] | select(.name == "LinkedIn Auth — Cookie Capture") | .id')

# Verify job structure
ls ~/Papr/Jobs/$AUTH_JOB_ID/
# Should show: job.json, linkedin_auth.js, data/ (after first run)
```

---

### Test 3: Auth Job Code Template ✅

**Goal:** Verify agent writes correct linkedin_auth.js implementation

**Expected Agent Actions:**
- Agent writes linkedin_auth.js file to job directory
- Code includes:
  - Dedicated Chrome profile (`chrome-profile/`)
  - Remote debugging port 9222
  - Checkpoint detection (`waitForLinkedInHome`)
  - State cleanup (`killExistingChrome`, `clearLinkedInState`)
  - Multi-location storage (3 locations)

**Verification:**
```bash
# Read the generated file
cat ~/Papr/Jobs/$AUTH_JOB_ID/linkedin_auth.js | grep -i "remote-debugging-port"
# Should find: --remote-debugging-port=9222

cat ~/Papr/Jobs/$AUTH_JOB_ID/linkedin_auth.js | grep -i "checkpoint"
# Should find: waitForLinkedInHome function

cat ~/Papr/Jobs/$AUTH_JOB_ID/linkedin_auth.js | grep -i ".papr-linkedin"
# Should find: ~/.papr-linkedin/auth.json storage
```

**Key Code Elements:**
- [ ] Uses dedicated profile (not default Chrome)
- [ ] Port 9222 for remote debugging
- [ ] Handles checkpoints/challenges
- [ ] Cleans stale Chrome state
- [ ] Stores to 3 locations
- [ ] Keeps Chrome running (doesn't close)

---

### Test 4: Chrome Manager Job Creation ✅

**Goal:** Verify agent creates Chrome Manager job with correct schedule

**Expected Agent Actions:**
```javascript
create_job({
  name: "LinkedIn Chrome Manager",
  type: "node",
  command: "node chrome-manager.js",
  schedule: {
    enabled: true,
    cron: "*/5 * * * *"  // Every 5 minutes
  },
  requirements: ["puppeteer-core", "better-sqlite3"],
  folder: "LinkedIn"
})
```

**Verification:**
- [ ] Job created with "Chrome Manager" in name
- [ ] Schedule enabled
- [ ] Cron is "*/5 * * * *" (every 5 minutes)
- [ ] Same requirements as auth job
- [ ] Same folder as auth job

**Check Schedule:**
```bash
# Find Chrome Manager job
MANAGER_JOB_ID=$(cat ~/Papr/data/jobs.json | jq -r '.[] | select(.name == "LinkedIn Chrome Manager") | .id')

# Check schedule
cat ~/Papr/Jobs/$MANAGER_JOB_ID/job.json | jq '.schedule'
# Should show: { "enabled": true, "cron": "*/5 * * * *" }
```

---

### Test 5: Chrome Manager Code Template ✅

**Goal:** Verify Chrome Manager has cookie refresh logic

**Expected Code Elements:**
- Connects to existing Chrome on port 9222
- Navigates to /feed/ to verify session
- Extracts fresh cookies via `page.cookies()`
- Compares with stored cookies (detects rotation)
- Updates all 3 storage locations
- Detects session expiration
- Marks status in database

**Verification:**
```bash
cat ~/Papr/Jobs/$MANAGER_JOB_ID/chrome-manager.js | grep -i "li_at"
# Should find: token rotation detection logic

cat ~/Papr/Jobs/$MANAGER_JOB_ID/chrome-manager.js | grep -i "session_expired"
# Should find: status update on expiration

cat ~/Papr/Jobs/$MANAGER_JOB_ID/chrome-manager.js | grep -i "verifyAndRefreshSession"
# Should find: main refresh function
```

**Key Code Elements:**
- [ ] Tries to connect to port 9222 first
- [ ] Launches Chrome if not running
- [ ] Injects stored cookies before navigation
- [ ] Detects token changes
- [ ] Logs "🔄 LinkedIn rotated the li_at token" on rotation
- [ ] Updates database status

---

### Test 6: Database Setup ✅

**Goal:** Verify agent creates/references LinkedIn database correctly

**Expected Agent Guidance:**
Agent should explain or create:
- `linkedin_account` table with required columns
- Status field (`connected`, `session_expired`)
- Cookie storage fields (`cookie_value`, `jsessionid`, `cookie_expires`)
- Timestamps (`connected_at`, `last_keepalive`, `updated_at`)

**Verification:**
Check if agent:
- [ ] Creates a database for LinkedIn data
- [ ] Documents the schema
- [ ] Updates APP_DB path in both job files
- [ ] Explains the 3-location storage strategy

---

### Test 7: Initial Auth Run (Interactive) ✅

**Goal:** Run auth job and verify it captures cookies

**User Action:**
```
"Run the LinkedIn auth job so I can log in"
```

**Expected Flow:**
1. Agent triggers the auth job
2. Chrome window opens with LinkedIn login page
3. User logs in manually
4. Job detects successful login
5. Job extracts cookies
6. Job saves to 3 locations
7. Chrome stays open on port 9222

**Verification After Login:**
```bash
# Check shared auth file
cat ~/.papr-linkedin/auth.json
# Should have: li_at, jsessionid, profileName, cookieExpires

# Check job data file
cat ~/Papr/Jobs/$AUTH_JOB_ID/data/linkedin_auth.json
# Should match shared file

# Check Chrome is running
lsof -i :9222
# Should show Chrome process

# Check job output
cat ~/Papr/Jobs/$AUTH_JOB_ID/logs/latest.log | tail -20
# Should show: "✓ Connected as: [Your Name]"
# Should show: "Keeping Chrome running on port 9222"
```

**Manual Verification:**
- [ ] Chrome window appeared
- [ ] LinkedIn login page loaded
- [ ] After login, job completed successfully
- [ ] Chrome is still running (didn't close)
- [ ] ~/.papr-linkedin/auth.json exists
- [ ] auth.json has li_at cookie
- [ ] Job logs show success message

---

### Test 8: Chrome Manager First Run ✅

**Goal:** Verify Chrome Manager connects and refreshes cookies

**Wait:** 5 minutes after auth job completes (or manually trigger)

**Manual Trigger:**
```bash
# Get job ID
MANAGER_JOB_ID=$(cat ~/Papr/data/jobs.json | jq -r '.[] | select(.name == "LinkedIn Chrome Manager") | .id')

# Trigger manually
curl -X POST http://localhost:18789/api/jobs/run \
  -H "Content-Type: application/json" \
  -d "{\"jobId\": \"$MANAGER_JOB_ID\"}"
```

**Expected Behavior:**
1. Connects to Chrome on port 9222
2. Navigates to LinkedIn feed
3. Verifies session is active
4. Extracts cookies
5. Logs whether token changed or not

**Verification:**
```bash
# Check Chrome Manager logs
cat ~/Papr/Jobs/$MANAGER_JOB_ID/logs/latest.log | tail -30

# Should show one of:
# "✓ Cookie unchanged — session healthy"
# OR
# "🔄 LinkedIn rotated the li_at token — saving fresh cookie!"

# Verify it didn't launch new Chrome (already running)
cat ~/Papr/Jobs/$MANAGER_JOB_ID/logs/latest.log | grep "already running"
# Should find: "Chrome already running"
```

**Manual Verification:**
- [ ] Job completed successfully
- [ ] Connected to existing Chrome (didn't launch new one)
- [ ] Verified session is active
- [ ] Updated auth.json if token changed
- [ ] No errors in logs

---

### Test 9: Cookie Rotation Detection ✅

**Goal:** Verify Chrome Manager detects when LinkedIn rotates tokens

**Simulation:**
1. Manually modify `~/.papr-linkedin/auth.json`
2. Change a character in the `li_at` value
3. Wait for Chrome Manager to run (or trigger manually)

**Expected Behavior:**
- Chrome Manager extracts fresh cookie from browser
- Detects mismatch with stored cookie
- Logs: "🔄 LinkedIn rotated the li_at token — saving fresh cookie!"
- Overwrites auth.json with fresh cookie from browser

**Verification:**
```bash
# Before modification
BEFORE=$(cat ~/.papr-linkedin/auth.json | jq -r '.li_at')

# Modify (change last character)
jq '.li_at = (.li_at[:-1] + "X")' ~/.papr-linkedin/auth.json > /tmp/auth.json
mv /tmp/auth.json ~/.papr-linkedin/auth.json

# Trigger Chrome Manager
curl -X POST http://localhost:18789/api/jobs/run \
  -H "Content-Type: application/json" \
  -d "{\"jobId\": \"$MANAGER_JOB_ID\"}"

# Wait 30 seconds
sleep 30

# After refresh
AFTER=$(cat ~/.papr-linkedin/auth.json | jq -r '.li_at')

# Verify it was restored to correct value
echo "Before: $BEFORE"
echo "After:  $AFTER"
# Should match (manager restored the real cookie from browser)
```

**Manual Verification:**
- [ ] Modified cookie was detected
- [ ] Logs show rotation message
- [ ] auth.json restored to browser's actual cookie
- [ ] Database updated with fresh cookie

---

### Test 10: Session Expiration Detection ✅

**Goal:** Verify Chrome Manager detects expired sessions

**Simulation:**
1. Stop Chrome: `pkill -f "remote-debugging-port=9222"`
2. Delete cookies from profile: `rm -rf ~/Papr/Jobs/$AUTH_JOB_ID/data/chrome-profile/Default/Cookies*`
3. Trigger Chrome Manager

**Expected Behavior:**
- Chrome Manager launches new Chrome
- Navigates to LinkedIn feed
- Gets redirected to /login or /authwall
- Detects session expired
- Updates database status to 'session_expired'

**Verification:**
```bash
# Trigger after clearing cookies
curl -X POST http://localhost:18789/api/jobs/run \
  -H "Content-Type: application/json" \
  -d "{\"jobId\": \"$MANAGER_JOB_ID\"}"

sleep 30

# Check logs
cat ~/Papr/Jobs/$MANAGER_JOB_ID/logs/latest.log | grep -i "expired"
# Should show: "LinkedIn session: EXPIRED"

# Check database status (if using one)
sqlite3 ~/Papr/data/linkedin_app.db \
  "SELECT status, updated_at FROM linkedin_account WHERE id=1"
# Should show: session_expired | [timestamp]
```

**Manual Verification:**
- [ ] Expired session detected
- [ ] Status updated to 'session_expired'
- [ ] No crash or error
- [ ] Logs clearly indicate expiration

---

### Test 11: Re-Authentication After Expiration ✅

**Goal:** Verify user can re-run auth job to restore session

**User Message:**
```
"My LinkedIn session expired. Let me log in again."
```

**Expected Agent Behavior:**
1. Agent recognizes session is expired
2. Agent suggests running auth job again
3. Agent triggers the existing auth job (doesn't create new one)

**Verification:**
- [ ] Agent doesn't create duplicate auth job
- [ ] Agent triggers existing auth job
- [ ] Chrome window opens for login
- [ ] After login, session restored
- [ ] Chrome Manager resumes working

---

### Test 12: Agent Explains the System ✅

**Goal:** Verify agent can explain how LinkedIn auth works

**User Message:**
```
"How does the LinkedIn authentication work? Why do I need two jobs?"
```

**Expected Agent Response Should Include:**
- LinkedIn rotates cookies automatically
- Chrome Manager refreshes cookies every 5 minutes
- Auth job is for initial login only
- Chrome stays running for automation
- Cookies stored in 3 locations for reliability

**Verification:**
- [ ] Agent explains cookie rotation
- [ ] Agent explains Chrome Manager purpose
- [ ] Agent explains why Chrome stays running
- [ ] Agent explains 3-location storage

---

### Test 13: Integration with Automation Jobs ✅

**Goal:** Verify other jobs can use the LinkedIn auth

**Create a Simple LinkedIn Job:**
```javascript
create_job({
  name: "LinkedIn Profile Viewer",
  type: "node",
  command: "node view-profile.js",
  requirements: ["puppeteer-core"],
  folder: "LinkedIn"
})
```

**view-profile.js:**
```javascript
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');

async function main() {
  // Read auth
  const auth = JSON.parse(
    fs.readFileSync(os.homedir() + '/.papr-linkedin/auth.json', 'utf8')
  );
  
  // Connect to existing Chrome
  const resp = await fetch('http://127.0.0.1:9222/json/version');
  const { webSocketDebuggerUrl } = await resp.json();
  
  const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl });
  const page = await browser.newPage();
  
  // Inject cookies
  await page.setCookie({
    name: 'li_at',
    value: auth.li_at,
    domain: '.linkedin.com',
    path: '/',
    secure: true,
    httpOnly: true
  });
  
  // Navigate to LinkedIn
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle2' });
  
  const title = await page.title();
  console.log('Page title:', title);
  console.log('✓ Successfully accessed LinkedIn with saved auth');
  
  await page.close();
  browser.disconnect();
}

main();
```

**Verification:**
- [ ] Job can read from ~/.papr-linkedin/auth.json
- [ ] Job can connect to Chrome on port 9222
- [ ] Job can inject cookies successfully
- [ ] Job can access LinkedIn without re-login

---

## Success Criteria Summary

### Skill Updates ✅
- [ ] Social skill has LinkedIn-specific section
- [ ] Dedicated Chrome profile explained
- [ ] Cookie rotation documented
- [ ] 3-location storage documented
- [ ] Checkpoint handling documented
- [ ] State cleanup documented
- [ ] Complete code templates included

### Agent Behavior ✅
- [ ] Agent loads social skill when asked about LinkedIn
- [ ] Agent creates 2 jobs (Auth + Chrome Manager)
- [ ] Agent writes correct job code
- [ ] Agent explains cookie rotation
- [ ] Agent doesn't create duplicate jobs

### Auth Job ✅
- [ ] Uses dedicated Chrome profile
- [ ] Opens Chrome on port 9222
- [ ] Handles checkpoints/challenges
- [ ] Cleans stale state on retry
- [ ] Extracts cookies successfully
- [ ] Stores to 3 locations
- [ ] Keeps Chrome running

### Chrome Manager ✅
- [ ] Runs every 5 minutes
- [ ] Connects to existing Chrome
- [ ] Refreshes cookies from browser
- [ ] Detects token rotation
- [ ] Updates all storage locations
- [ ] Detects session expiration
- [ ] Updates database status

### System Integration ✅
- [ ] Other jobs can use saved auth
- [ ] Multiple automation jobs share same Chrome
- [ ] Sessions stay alive long-term
- [ ] Re-auth works after expiration

---

## Known Issues / Edge Cases

### Issue 1: Chrome Profile Conflicts
**Symptom:** Chrome won't start, singleton lock errors
**Solution:** Kill all Chrome processes, delete singleton files
```bash
pkill -f "Google Chrome"
rm ~/Papr/Jobs/$AUTH_JOB_ID/data/chrome-profile/SingletonLock
```

### Issue 2: Port 9222 Already in Use
**Symptom:** Chrome fails to start remote debugging
**Solution:** Find and kill process using port
```bash
lsof -ti :9222 | xargs kill -9
```

### Issue 3: LinkedIn Security Checkpoint
**Symptom:** Auth job waits forever at checkpoint
**User Action:** Complete the security challenge in the Chrome window
**Expected:** Job detects completion and continues

### Issue 4: Database Path Incorrect
**Symptom:** Jobs can't write to database
**Solution:** Verify APP_DB path in both job files points to existing database

---

## Cleanup After Testing

```bash
# Stop Chrome
pkill -f "remote-debugging-port=9222"

# Remove auth data
rm -rf ~/.papr-linkedin/

# Delete test jobs (if desired)
# Use UI or: delete_job({ jobId: "..." })

# Clear Chrome profile
rm -rf ~/Papr/Jobs/$AUTH_JOB_ID/data/chrome-profile/
```

---

## Reporting Issues

If any test fails, document:
1. Which test failed
2. Expected behavior
3. Actual behavior
4. Relevant log output
5. Job IDs and file paths
6. Error messages

Include:
- Agent conversation log
- Job logs (`~/Papr/Jobs/{jobId}/logs/latest.log`)
- Browser console errors (if applicable)
- System info (macOS version, Chrome version)
