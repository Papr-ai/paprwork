# Cross-Platform Calendar Integration Strategy

**Added:** 2026-04-07

## Problem

The home dashboard "Generate My Real Brief" button currently has platform-specific calendar access issues:
- ❌ **macOS:** Uses AppleScript (works but macOS-only)
- ❌ **Windows:** No calendar access at all
- ❌ **Linux:** No calendar access at all

This creates an inconsistent user experience and limits the Daily Brief's usefulness on non-Mac platforms.

## Solution: Google Workspace CLI + Calendar Sync Job

### Architecture

```
Pre-Installed Default Jobs
├── Calendar Sync Job (runs every 15 min)
│   ├── Uses: Google Workspace CLI (gws)
│   ├── Platform: Windows, macOS, Linux
│   ├── Auth: One-time OAuth (opens browser)
│   └── Output: ~/Papr/jobs/{id}/data/calendar.db
│
└── Daily Brief Generator (runs 6 AM daily)
    ├── Reads FROM: calendar.db, other job DBs
    └── Output: ~/Papr/jobs/{id}/data/briefs.db
```

### Why Google Workspace CLI?

**1. Cross-Platform**
- ✅ Works on Windows, macOS, Linux
- ✅ npm package (no native dependencies)
- ✅ Consistent API across platforms

**2. Official & Maintained**
- ✅ Built by Google for AI agents
- ✅ Actively maintained
- ✅ Covers entire Google Workspace (Gmail, Calendar, Drive, Docs, Sheets)

**3. OAuth Built-In**
- ✅ One-time browser auth
- ✅ Token refresh handled automatically
- ✅ Secure (no app passwords needed)

**4. Agent-Friendly**
- ✅ JSON output
- ✅ Clear CLI commands
- ✅ Documented for AI agents

### Alternative Approaches (and Why We Rejected Them)

**❌ AppleScript (macOS Calendar.app)**
```typescript
bash({ command: "osascript -e 'tell application \"Calendar\"...'" })
```
- ✅ Works on macOS
- ❌ Doesn't work on Windows/Linux
- ❌ Requires Calendar.app configured
- ❌ Fragile syntax

**❌ PowerShell (Windows Outlook)**
```typescript
bash({ command: "powershell Get-OutlookCalendar" })
```
- ✅ Works on Windows
- ❌ Doesn't work on macOS/Linux
- ❌ Requires Outlook installed
- ❌ Not all users use Outlook

**❌ CalDAV Protocol**
```typescript
// Direct CalDAV queries
```
- ✅ Cross-platform protocol
- ❌ Requires manual server URLs
- ❌ Complex authentication
- ❌ Provider-specific quirks

**✅ Google Workspace CLI (Chosen)**
```typescript
bash({ command: "gws calendar events list --params '{...}'" })
```
- ✅ Cross-platform
- ✅ OAuth built-in
- ✅ Consistent API
- ✅ JSON output
- ✅ Covers entire Workspace

## Calendar Sync Job Structure

### File Structure

```
src/resources/default-jobs/calendar-sync/
├── job-id.txt               # UUID
├── metadata.json            # Job configuration
├── init-db.sql              # SQLite schema
└── README.md                # Setup instructions
```

### metadata.json

```json
{
  "id": "a1b2c3d4-5e6f-7g8h-9i0j-k1l2m3n4o5p6",
  "name": "Calendar Sync",
  "type": "agent",
  "command": "Sync my Google Calendar events for the next 7 days. Use Google Workspace CLI (gws) if installed, otherwise offer to install it. Query events from primary calendar using: gws calendar events list --params '{\"calendarId\": \"primary\", \"timeMin\": \"<now>\", \"timeMax\": \"<+7days>\", \"singleEvents\": true, \"orderBy\": \"startTime\"}'. Clear old events (older than today) before inserting new ones. Store in SQLite: id, summary, start_time, end_time, location, description, attendees (JSON array), calendar_name, synced_at.",
  "status": "idle",
  "createdAt": "2026-04-07T00:00:00.000Z",
  "updatedAt": "2026-04-07T00:00:00.000Z",
  "schedule": {
    "enabled": true,
    "intervalMs": 900000
  },
  "isDefault": true
}
```

### init-db.sql

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  location TEXT,
  description TEXT,
  attendees TEXT,
  calendar_name TEXT DEFAULT 'primary',
  synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_start_time ON events(start_time);
CREATE INDEX idx_end_time ON events(end_time);

-- Insert sample event for fresh installs
INSERT OR REPLACE INTO events (
  id, summary, start_time, end_time, location, description, attendees, calendar_name
) VALUES (
  'sample-event-1',
  'Sample Meeting',
  datetime('now', '+2 hours'),
  datetime('now', '+3 hours'),
  'Conference Room A',
  'This is a sample calendar event showing what your synced events will look like.',
  '[]',
  'primary'
);
```

### Agent Command Breakdown

**What the agent does when the job runs:**

```typescript
// 1. Check if Google Workspace CLI is installed
bash({ command: "which gws || where gws" })

// 2. If not installed, offer to install
if (!installed) {
  return {
    output: "Google Workspace CLI not found. Would you like me to install it? (npm install -g @googleworkspace/cli)",
    needsUserInput: true
  };
}

// 3. Check if authenticated
bash({ command: "gws auth status" })

// 4. If not authenticated, prompt for auth
if (!authenticated) {
  return {
    output: "Google Workspace CLI not authenticated. Run: gws auth login",
    needsUserInput: true
  };
}

// 5. Query calendar events (next 7 days)
const now = new Date().toISOString();
const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

bash({
  command: `gws calendar events list --params '{
    "calendarId": "primary",
    "timeMin": "${now}",
    "timeMax": "${weekLater}",
    "singleEvents": true,
    "orderBy": "startTime"
  }'`
})

// 6. Parse JSON output
const events = JSON.parse(output).items;

// 7. Clear old events
bash({
  command: `sqlite3 data/calendar.db "DELETE FROM events WHERE start_time < date('now')"`
})

// 8. Insert new events
for (const event of events) {
  bash({
    command: `sqlite3 data/calendar.db "
      INSERT OR REPLACE INTO events VALUES (
        '${event.id}',
        '${event.summary}',
        '${event.start.dateTime}',
        '${event.end.dateTime}',
        '${event.location || ''}',
        '${event.description || ''}',
        '${JSON.stringify(event.attendees || [])}',
        'primary',
        datetime('now')
      )
    "`
  })
}

// 9. Return success
return {
  output: `Synced ${events.length} events from Google Calendar`,
  eventsCount: events.length
};
```

## First-Run User Experience

### Scenario 1: Fresh Install (No Calendar)

**User clicks "Generate My Real Brief":**

```
1. Daily Brief job runs
2. Agent checks: list_jobs() → Sees "Calendar Sync" job
3. Agent checks: sqlite3 calendar.db "SELECT COUNT(*)"
4. Result: 1 (sample event only)

Agent output:
"I see you have a sample calendar event. To sync your real Google Calendar:
1. I can install Google Workspace CLI (takes ~30 seconds)
2. You'll authenticate once via browser
3. Calendar will sync automatically every 15 minutes

Would you like to proceed?"
```

**User responds: "Yes"**

```
5. Agent installs: npm install -g @googleworkspace/cli
6. Agent runs: gws auth login → Opens browser
7. User authenticates with Google
8. Agent runs calendar sync job immediately
9. Agent generates brief with real calendar data
10. Dashboard reloads showing real meetings
```

### Scenario 2: Already Has Calendar Sync

**User clicks "Generate My Real Brief":**

```
1. Daily Brief job runs
2. Agent checks: sqlite3 calendar.db "SELECT COUNT(*)"
3. Result: 15+ events (real data)
4. Agent generates brief using calendar events
5. Dashboard shows real meetings with context
```

### Scenario 3: Calendar Sync Failed

**User clicks "Generate My Real Brief":**

```
1. Daily Brief job runs
2. Agent checks calendar.db → Empty (sync failed)
3. Agent checks Calendar Sync job logs
4. Agent output:

"Calendar sync failed: [reason]
- Authentication expired? Run: gws auth login
- Rate limit hit? Will retry in 15 minutes
- No events? Check calendar settings

I'll generate a brief from other sources (chat history, goals)."

5. Agent generates minimal brief without calendar
6. Dashboard shows with note about calendar issue
```

## How Daily Brief Uses Calendar Data

### Query Pattern

```sql
-- Get today's meetings (sorted by time)
SELECT 
  summary,
  start_time,
  end_time,
  location,
  description,
  attendees
FROM events
WHERE date(start_time) = date('now')
ORDER BY start_time ASC;

-- Get upcoming meetings (next 7 days)
SELECT * FROM events
WHERE start_time BETWEEN datetime('now') AND datetime('now', '+7 days')
ORDER BY start_time ASC;

-- Get external meetings (attendees from outside domain)
SELECT * FROM events
WHERE attendees LIKE '%@gmail.com%'
  OR attendees NOT LIKE '%@yourcompany.com%'
ORDER BY start_time ASC;
```

### Brief Generation Logic

```typescript
// 1. Query calendar data
const todayMeetings = bash({ 
  command: `sqlite3 calendar.db "SELECT * FROM events WHERE date(start_time) = date('now')"` 
});

// 2. Enrich with context from other sources
for (const meeting of todayMeetings) {
  // Check if attendee has LinkedIn profile
  const linkedin = bash({
    command: `sqlite3 ~/Papr/jobs/linkedin/data.db 
      "SELECT * FROM profiles WHERE email='${attendee.email}'"`
  });
  
  // Check if there are CRM notes
  const crm = bash({
    command: `sqlite3 ~/Papr/jobs/crm/data.db 
      "SELECT * FROM contacts WHERE email='${attendee.email}'"`
  });
  
  // Add context to meeting
  meeting.intel = {
    linkedIn: linkedin?.headline,
    company: crm?.company,
    lastContact: crm?.lastContactDate,
    notes: crm?.notes
  };
}

// 3. Generate brief JSON
const brief = {
  hero: {
    date: new Date().toLocaleDateString(),
    title: 'Daily Brief',
    subtitle: `${todayMeetings.length} meetings · ${externalCount} external`
  },
  sections: [
    {
      type: 'timeline',
      title: 'Today',
      items: todayMeetings.map(m => ({
        time: formatTime(m.start_time),
        title: m.summary,
        tags: isExternal(m) ? ['external'] : ['internal'],
        detail: m.intel ? {
          Intel: `${m.intel.linkedIn} at ${m.intel.company}`,
          Angle: m.intel.notes,
          'The Ask': 'Follow up on last discussion'
        } : null
      }))
    }
  ]
};

// 4. Save to briefs.db
bash({
  command: `sqlite3 data/briefs.db "
    INSERT INTO briefs VALUES (date('now'), '${JSON.stringify(brief)}', datetime('now'))
  "`
});
```

## Benefits

### Speed
- **Before:** API call every time (200-500ms)
- **After:** SQLite query (5-10ms)
- **Improvement:** 20-50x faster

### Reliability
- **Before:** Depends on Google API availability
- **After:** Works offline with last sync
- **Improvement:** 99.9% uptime

### User Experience
- **Before:** Authentication on every brief generation
- **After:** One-time OAuth, auto-syncs forever
- **Improvement:** No friction

### Cross-Platform
- **Before:** Only works on macOS (AppleScript)
- **After:** Works on Windows, macOS, Linux
- **Improvement:** 100% platform coverage

### Data Reusability
- **Before:** Calendar data only in Daily Brief
- **After:** Any job/app can read calendar.db
- **Improvement:** DRY, single source of truth

## Future Enhancements

### Week 1: Basic Calendar Sync
- Pre-install Calendar Sync job
- Auto-detect and offer gws installation
- Store events in SQLite
- Daily Brief reads from calendar.db

### Week 2: Multi-Calendar Support
- Allow syncing multiple calendars
- Add calendar selection UI
- Support work + personal calendars
- Filter by calendar in queries

### Week 3: Meeting Prep App
- Create mini-app displaying calendar
- Add meeting prep button per event
- Show attendee intel (LinkedIn, CRM)
- Generate pre-meeting brief

### Week 4: Smart Scheduling
- Detect scheduling conflicts
- Suggest optimal meeting times
- Auto-decline double-booked meetings
- Recommend focus time blocks

---

**Summary:** Replace platform-specific calendar access (AppleScript on macOS) with Google Workspace CLI for cross-platform consistency. Pre-install a Calendar Sync job that runs every 15 minutes and stores events in SQLite. Daily Brief reads from SQLite for fast, reliable, offline-capable calendar integration. Agent handles first-time gws installation and OAuth automatically.
