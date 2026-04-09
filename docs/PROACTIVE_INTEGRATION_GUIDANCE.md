# Proactive Integration Guidance - Never Say "I Can't"

**Added:** 2026-04-07  
**Updated:** 2026-04-07 (Added Google Cloud CLI guidance)

## Problem

Agent was too quick to say "I don't have access to X" or "I can't do X" without checking its actual capabilities. This created a poor user experience where users thought Paprwork was limited when it actually has powerful automation tools.

**Example:**
```
User: "Pull up Hemang's email from LG"
Agent: "I don't have access to your email — Paprwork doesn't have email integration..."
```

**Reality:** The agent CAN access email through:
- Gmail API (Python job with `google-api-python-client`)
- Google Cloud CLI (`gcloud gmail` commands)
- IMAP (Python job with `imaplib`)
- Browser automation (browser tools)
- AppleScript/Mail.app (macOS bash)

## Root Cause

The agent wasn't taught to:
1. Check its available tools before saying "I can't"
2. Recognize that bash + packages = access to ANY API/service
3. Offer to build integrations instead of declining requests
4. Understand its full automation capabilities (browser, jobs, filesystem)

## Solution

Added new `buildProactiveIntegrationSection()` to SystemPrompt that teaches the agent:

### 1. The Proactive Pattern

Before saying "I can't":
1. ✅ Check available tools (bash, browser, jobs, filesystem)
2. ✅ Check if packages can be installed to gain access
3. ✅ Offer to build the integration
4. ✅ Ask which approach the user prefers
5. ✅ Build it with permission

### 2. Concrete Examples

The prompt now includes specific examples for common requests:

**Gmail/Email Access:**
- Gmail API (Python job with `google-api-python-client`)
- Google Cloud CLI (`gcloud gmail messages list`)
- IMAP (Python job with `imaplib`)
- Browser automation (login to Gmail)
- AppleScript (macOS Mail.app access)

**Google Calendar Access:**
- Google Calendar API (Python with OAuth)
- Google Cloud CLI (`gcloud calendar events list`)
- CalDAV protocol (username + app password)
- AppleScript (macOS Calendar.app)
- Browser automation

**Google Drive/Docs/Sheets:**
- Google Drive API (Python with OAuth)
- Google Cloud CLI (`gcloud storage` commands)
- gdrive CLI tool (third-party)
- Browser automation

**Social Media (LinkedIn, Twitter, etc.):**
- Browser automation (navigate, extract data)
- API integration (if user has credentials)
- Scraping jobs (Python with requests/selenium)

**Databases:**
- Install client libraries (`psycopg2`, `pymongo`, `mysql-connector`)
- Connect with custom keys (stored securely)
- Query and return results

### 3. Package Installation Capability

Agent now knows it can install ANY package or CLI tool:

```javascript
// Python packages for Google APIs
bash({ command: "pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib" })

// Google Cloud CLI installation
bash({ command: "brew install google-cloud-sdk" }) // macOS
bash({ command: "winget install Google.CloudSDK" }) // Windows
bash({ command: "curl https://sdk.cloud.google.com | bash" }) // Linux

// Node packages
bash({ command: "npm install @octokit/rest nodemailer" })

// System tools (with permission)
bash({ command: "brew install ffmpeg jq youtube-dl" }) // macOS
bash({ command: "winget install --id=Gyan.FFmpeg" }) // Windows
```

**Google Cloud CLI Usage:**

Once installed, agent can use gcloud commands:
```bash
# Authenticate (opens browser for OAuth)
gcloud auth login

# Gmail operations
gcloud alpha gmail messages list --query='from:john@example.com'

# Calendar operations  
gcloud calendar events list --calendar='primary'

# Drive/Storage operations
gcloud storage ls gs://my-bucket/
```

### 4. Browser Automation Awareness

Agent now understands it has FULL browser capabilities:
- Navigate to any website
- Fill forms, click buttons  
- Extract data from pages
- Take screenshots
- Automate multi-step workflows

**Never say "I can't access that website"** - it has browser tools!

## Implementation

**File Changed:**
- `src/core/agents/SystemPrompt.ts` - Added `buildProactiveIntegrationSection()` method

**Prompt Position:**
- Placed right after identity section (high priority, good caching)
- Loads on every chat session

**Section Content:**
1. Critical rule: Check capabilities before saying "I can't"
2. Concrete examples (email, calendar, social, databases)
3. The proactive pattern (5-step decision tree)
4. Package installation examples
5. Browser automation reminder
6. Bottom line: "You are a POWERFUL automation platform"

## Expected Agent Behavior

### Before
```
User: "Access my Gmail and find emails from john@example.com"
Agent: "I don't have access to your email — Paprwork doesn't have email integration, so I can't pull up emails directly."
```

### After
```
User: "Access my Gmail and find emails from john@example.com"
Agent: "I can access your Gmail in several ways:

1. **Gmail API** (recommended) - I can install `google-api-python-client` and create a Python job that uses the official Gmail API. Requires OAuth setup (I'll guide you).

2. **Google Cloud CLI** - I can install the `gcloud` CLI tool and use `gcloud gmail messages list` to search your emails. Also requires OAuth.

3. **Browser automation** - I can use browser tools to log into Gmail and extract the emails. No OAuth needed but slower.

4. **IMAP** - I can create a Python job using `imaplib` to fetch emails. Requires your username and an app password.

Option 1 (Gmail API) is the most reliable and gives the best results. Would you like me to set it up?"
```

## Coverage

This guidance applies to ANY external integration request:
- ✅ Email (Gmail API, gcloud CLI, IMAP, Outlook, etc.)
- ✅ Calendar (Google Calendar API, gcloud CLI, CalDAV, iCal, etc.)
- ✅ Google Services (Drive, Docs, Sheets via API or gcloud)
- ✅ Social media (LinkedIn, Twitter, Facebook, etc.)
- ✅ Databases (PostgreSQL, MySQL, MongoDB, etc.)
- ✅ Cloud services (AWS, Azure, GCP via CLI tools)
- ✅ APIs (REST, GraphQL, any HTTP endpoint)
- ✅ File formats (PDFs, Excel, images, videos)
- ✅ Web scraping (any public website)

## Impact

**Before:**
- Agent quickly declined requests → poor user experience
- Users thought Paprwork was limited → missed powerful features
- No integration offers → users gave up

**After:**
- Agent proactively offers solutions → empowered users
- Users discover Paprwork's automation capabilities → increased engagement
- Integration options presented → users can choose their preferred approach

## Testing

Manual verification needed:

1. **Gmail request:** "Pull up my emails from john@example.com"
   - ✅ Should offer Gmail API, gcloud CLI, IMAP, browser automation
   - ❌ Should NOT say "I don't have email access"

2. **Google Calendar request:** "Show me my meetings tomorrow"
   - ✅ Should offer Google Calendar API, gcloud CLI, CalDAV, browser automation
   - ❌ Should NOT say "I can't access your calendar"

3. **Google Drive request:** "List files in my Drive folder"
   - ✅ Should offer Google Drive API, gcloud storage, gdrive CLI, browser automation
   - ❌ Should NOT say "I don't have Drive integration"

4. **LinkedIn request:** "Find profiles of AI engineers at Microsoft"
   - ✅ Should offer browser automation, scraping job, API (if available)
   - ❌ Should NOT say "I don't have LinkedIn integration"

5. **Database request:** "Query my PostgreSQL database for user data"
   - ✅ Should offer to install psycopg2, create job, connect with custom key
   - ❌ Should NOT say "I can't connect to databases"

6. **API request:** "Fetch data from the GitHub API"
   - ✅ Should offer to install octokit, create job, use bash curl
   - ❌ Should NOT say "I don't have GitHub integration"

## Future Enhancements

1. **Integration templates:** Pre-built jobs for common integrations (Gmail, LinkedIn, etc.)
2. **One-click setup:** "Would you like me to set up Gmail access? This will take 2 minutes..."
3. **Integration marketplace:** Share common integrations between users
4. **Credential management:** Secure OAuth flow for popular services

## Related

- Enhancement 40 (Auto-Install Missing Packages) - Agent installs Python/Node when needed
- Browser tools (BROWSER_TOOLS_PHASE_1.md) - Full browser automation capabilities
- Jobs architecture (APP_AND_JOBS_GUIDE.md) - Persistent automation with jobs
- Custom keys (CLAUDE.md Issue 14) - Secure credential storage for APIs

---

**Key Insight:** The agent has been too conservative. It's actually a POWERFUL automation platform that can integrate with virtually anything through bash + packages + browser + jobs. This prompt update teaches it to recognize and leverage that power.
