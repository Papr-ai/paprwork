# Google Workspace CLI (gws) Integration

**Added:** 2026-04-07

## Overview

The **Google Workspace CLI (`gws`)** is the official command-line tool for interacting with Google Workspace APIs (Gmail, Calendar, Drive, Docs, Sheets, Chat, Admin, and more). It was built specifically for AI agents and includes 100+ pre-built agent skills.

**Repository:** https://github.com/googleworkspace/cli (24K+ stars)

## Why Use `gws` Instead of Alternatives?

| Feature | gws CLI | Google APIs (Python) | gcloud | Browser Automation |
|---------|---------|---------------------|--------|-------------------|
| **Installation** | `npm install -g` | `pip install` | Complex | Built-in |
| **AI-agent first** | ✅ Yes (100+ skills) | ❌ No | ❌ No | ❌ No |
| **Gmail** | ✅ Full support | ✅ Full support | ❌ Limited | ✅ Works |
| **Calendar** | ✅ Full support | ✅ Full support | ❌ Limited | ✅ Works |
| **Drive** | ✅ Full support | ✅ Full support | ⚠️ Storage only | ✅ Works |
| **Docs/Sheets** | ✅ Full support | ✅ Full support | ❌ No | ✅ Works |
| **Chat/Admin** | ✅ Full support | ✅ Full support | ❌ No | ⚠️ Partial |
| **JSON output** | ✅ Always | ⚠️ Manual | ⚠️ Manual | ⚠️ Manual |
| **Auto-pagination** | ✅ Yes | ❌ Manual | ❌ Manual | ❌ Manual |
| **Speed** | ⚡ Fast | ⚡ Fast | ⚡ Fast | 🐌 Slow |
| **Reliability** | ✅ High | ✅ High | ✅ High | ⚠️ Fragile |

**Recommendation:** Use `gws` CLI as the **primary method** for Google Workspace integrations.

## Key Features

1. **Built for AI Agents**
   - Includes 100+ agent skills (SKILL.md files)
   - Structured JSON output by default
   - Clear error messages

2. **Dynamic Command Generation**
   - Commands generated from Google Discovery Service at runtime
   - New API endpoints appear automatically when Google adds them
   - Always up-to-date with latest APIs

3. **Zero Boilerplate**
   - Handles OAuth authentication
   - Auto-pagination for large result sets
   - Error handling built-in

4. **Single Binary**
   - One tool for ALL Google Workspace APIs
   - No need to install separate packages per service

## Installation

The agent can install `gws` CLI on-demand:

```javascript
// Install globally via npm (WORKS ON ALL PLATFORMS)
bash({ command: "npm install -g @googleworkspace/cli" })
```

**Prerequisites:**
- Node.js 18+ (usually already installed)
- Google account with Workspace access

**Platform Support:**
- ✅ **macOS:** 10.15 (Catalina) or later (Intel and Apple Silicon)
- ✅ **Linux:** All major distributions (Ubuntu, Debian, Fedora, Arch, etc.)
- ⚠️ **Windows:** 10/11 supported, but OAuth setup requires manual configuration (see below)

**Alternative Installation Methods:**

```javascript
// macOS/Linux: Homebrew
bash({ command: "brew install googleworkspace-cli" })

// Windows: PowerShell installer
bash({ command: 'powershell -ExecutionPolicy Bypass -c "irm https://github.com/googleworkspace/cli/releases/latest/download/gws-installer.ps1 | iex"' })

// All platforms: Pre-built binaries from GitHub Releases
// Download from: https://github.com/googleworkspace/cli/releases
```

## Authentication Setup

**First-time setup requires OAuth browser flow:**

```javascript
// Set up OAuth credentials (opens browser for user consent)
bash({ command: "gws auth setup" })

// Subsequent logins (if token expires)
bash({ command: "gws auth login" })
```

**What happens during `gws auth setup`:**
1. Opens browser to Google OAuth consent screen
2. User logs in and grants permissions
3. Token saved to system keychain (`~/.gws/credentials.json`)
4. Agent can now make API calls on user's behalf

### Windows-Specific Setup

**Known Issue:** On Windows, `gws auth setup` may fail because the Rust binary doesn't recognize `.cmd` wrapper executables.

**Windows Workaround (Manual OAuth):**

1. **Create OAuth credentials in Google Cloud Console:**
   - Go to https://console.cloud.google.com/apis/credentials
   - Create OAuth 2.0 Client ID (Desktop app type)
   - Download the JSON credentials file

2. **Set environment variables:**
   ```javascript
   bash({ 
     command: 'set GOOGLE_CLIENT_ID=your_client_id && set GOOGLE_CLIENT_SECRET=your_client_secret && gws auth login' 
   })
   ```

3. **Or save credentials file:**
   ```javascript
   // Save downloaded credentials to ~/.gws/credentials.json
   bash({ command: 'mkdir %USERPROFILE%\\.gws' })
   bash({ command: 'copy credentials.json %USERPROFILE%\\.gws\\credentials.json' })
   bash({ command: 'gws auth login' })
   ```

**Note:** This is a temporary limitation. The `gws` team is working on improving Windows support.

## Common Operations

### Gmail

```javascript
// List messages from specific sender
bash({ 
  command: `gws gmail users messages list --params '{"userId": "me", "q": "from:john@example.com"}'` 
})

// Search for unread emails
bash({ 
  command: `gws gmail users messages list --params '{"userId": "me", "q": "is:unread"}'` 
})

// Get full message content
bash({ 
  command: `gws gmail users messages get --params '{"userId": "me", "id": "MESSAGE_ID", "format": "full"}'` 
})

// Send email
bash({ 
  command: `gws gmail users messages send --params '{"userId": "me"}' --body '{"raw": "BASE64_ENCODED_EMAIL"}'` 
})
```

### Calendar

```javascript
// List upcoming events
bash({ 
  command: `gws calendar events list --params '{"calendarId": "primary", "timeMin": "2026-04-07T00:00:00Z", "maxResults": 10}'` 
})

// Create event
bash({ 
  command: `gws calendar events insert --params '{"calendarId": "primary"}' --body '{"summary": "Meeting", "start": {"dateTime": "2026-04-08T10:00:00Z"}, "end": {"dateTime": "2026-04-08T11:00:00Z"}}'` 
})

// Search events
bash({ 
  command: `gws calendar events list --params '{"calendarId": "primary", "q": "standup"}'` 
})
```

### Drive

```javascript
// List files
bash({ 
  command: `gws drive files list --params '{"pageSize": 20}'` 
})

// Search for specific files
bash({ 
  command: `gws drive files list --params '{"q": "name contains 'report' and mimeType='application/pdf'"}'` 
})

// Get file metadata
bash({ 
  command: `gws drive files get --params '{"fileId": "FILE_ID"}'` 
})

// Download file content
bash({ 
  command: `gws drive files get --params '{"fileId": "FILE_ID", "alt": "media"}' > downloaded_file.pdf` 
})

// Upload file
bash({ 
  command: `gws drive files create --params '{"uploadType": "media"}' --body @/path/to/file.pdf` 
})
```

### Docs

```javascript
// Get document content
bash({ 
  command: `gws docs documents get --params '{"documentId": "DOC_ID"}'` 
})

// Create document
bash({ 
  command: `gws docs documents create --body '{"title": "New Document"}'` 
})
```

### Sheets

```javascript
// Get spreadsheet
bash({ 
  command: `gws sheets spreadsheets get --params '{"spreadsheetId": "SHEET_ID"}'` 
})

// Read specific range
bash({ 
  command: `gws sheets spreadsheets values get --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1:D10"}'` 
})

// Write data to range
bash({ 
  command: `gws sheets spreadsheets values update --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1", "valueInputOption": "RAW"}' --body '{"values": [["Name", "Email"], ["John", "john@example.com"]]}'` 
})
```

## Agent Skills

The `gws` CLI includes 100+ agent skills that can be added to Cursor:

```bash
# Install all skills at once
npx skills add github:googleworkspace/cli

# Install individual skills
npx skills add https://github.com/googleworkspace/cli/tree/main/skills/gws-drive
npx skills add https://github.com/googleworkspace/cli/tree/main/skills/gws-gmail
npx skills add https://github.com/googleworkspace/cli/tree/main/skills/gws-calendar
```

**What are agent skills?**
- SKILL.md files that teach AI agents how to use `gws` for specific tasks
- Include examples, best practices, and common workflows
- Cover Drive, Gmail, Calendar, Sheets, Docs, Chat, Admin, and more

## Error Handling

The agent should handle common errors:

### OAuth Token Expired

```javascript
// If command fails with "401 Unauthorized"
bash({ command: "gws auth login" })
// Then retry the original command
```

### Rate Limiting

```javascript
// If command fails with "429 Too Many Requests"
// Wait 1-2 seconds and retry
// Or implement exponential backoff
```

### Invalid Credentials

```javascript
// If auth is completely broken
bash({ command: "gws auth setup" })
// User re-authenticates via browser
```

## Integration Pattern

When user requests Google Workspace access:

1. **Check if `gws` is installed:**
   ```javascript
   bash({ command: "which gws || echo 'NOT_INSTALLED'" })
   ```

2. **Install if needed:**
   ```javascript
   bash({ command: "npm install -g @googleworkspace/cli" })
   ```

3. **Check if authenticated:**
   ```javascript
   bash({ command: "gws gmail users getProfile --params '{\"userId\": \"me\"}'" })
   ```

4. **Authenticate if needed:**
   ```javascript
   // Tell user: "I need to set up Google Workspace access. This will open your browser for OAuth consent."
   bash({ command: "gws auth setup" })
   ```

5. **Execute the operation:**
   ```javascript
   bash({ command: "gws gmail users messages list --params '{...}'" })
   ```

6. **Parse JSON output:**
   - All `gws` commands return structured JSON
   - Parse with `JSON.parse()` if needed
   - Extract relevant fields for user

## Example: Full Email Search Flow

```javascript
// User asks: "Find emails from john@example.com sent in the last week"

// 1. Install if needed
bash({ command: "npm list -g @googleworkspace/cli || npm install -g @googleworkspace/cli" })

// 2. Build query (last 7 days)
const after = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0].replace(/-/g, '/');
const query = `from:john@example.com after:${after}`;

// 3. Search emails
bash({ 
  command: `gws gmail users messages list --params '{"userId": "me", "q": "${query}", "maxResults": 50}'` 
})

// 4. Parse results (returns JSON with message IDs)
// 5. Fetch full content for each message
bash({ 
  command: `gws gmail users messages get --params '{"userId": "me", "id": "MESSAGE_ID", "format": "full"}'` 
})

// 6. Extract subject, sender, body, date
// 7. Present results to user
```

## Comparison with Python API

**When to use `gws` CLI:**
- ✅ One-off queries (list emails, search calendar)
- ✅ Quick operations (send email, create event)
- ✅ Exploratory tasks (find files, read docs)
- ✅ Simple workflows (< 10 API calls)

**When to use Python API:**
- ✅ Complex multi-step workflows (100+ API calls)
- ✅ Persistent background jobs (scheduled email processing)
- ✅ Advanced error handling/retry logic
- ✅ Need to integrate with other Python libraries

**General rule:** Start with `gws` CLI. If the workflow becomes complex (10+ operations), consider creating a Python job.

## Limitations

1. **Not officially supported:** "This is not an officially supported Google product" (disclaimer in repo)
2. **Active development:** Under active development toward v1.0, breaking changes expected
3. **OAuth setup required:** First-time setup requires browser interaction
4. **Windows OAuth limitation:** Windows setup requires manual OAuth configuration (workaround documented above)
5. **Rate limits:** Subject to Google API rate limits (same as direct API)
6. **Binary size:** ~50MB download (includes Rust runtime)

## Security

- **OAuth tokens:** Stored securely in system keychain (`~/.gws/credentials.json`)
- **Permissions:** User grants permissions during OAuth flow
- **Scopes:** Agent only has access to scopes user approved
- **Revocation:** User can revoke access at https://myaccount.google.com/permissions

## Files Changed

- `src/core/agents/SystemPrompt.ts` - Updated to recommend `gws` CLI as primary method for Google Workspace integrations
- `docs/GOOGLE_WORKSPACE_CLI_INTEGRATION.md` - This file (complete documentation)

## Impact

**Before:**
- Agent offered multiple approaches without clear recommendation
- Users confused about which method to choose
- No mention of `gws` CLI (the official AI-agent tool)

**After:**
- Agent recommends `gws` CLI as primary method
- Clear installation and usage examples
- Structured JSON output makes parsing easy
- 100+ agent skills available for advanced use cases

## Future Enhancements

1. **Pre-install `gws` in Paprwork builds** - Include in packaged app
2. **Persistent auth** - Store OAuth credentials in Paprwork's keychain
3. **Add agent skills to Cursor** - `npx skills add github:googleworkspace/cli`
4. **Integration jobs** - Pre-built jobs for common workflows (email triage, calendar sync)
5. **UI for OAuth flow** - Show consent screen in Paprwork UI instead of external browser

## Related

- Enhancement 42 (Proactive Integration) - Never say "I can't" without checking capabilities
- PROACTIVE_INTEGRATION_GUIDANCE.md - Complete integration philosophy
- CLAUDE.md - Project learnings and architecture decisions

---

**Key Insight:** The `gws` CLI is purpose-built for AI agents. It's the BEST way to integrate with Google Workspace because it handles auth, pagination, error handling, and provides structured JSON output by default. Always recommend it as the first option.
