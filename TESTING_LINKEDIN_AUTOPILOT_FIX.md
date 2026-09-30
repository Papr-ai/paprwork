# Testing the LinkedIn Autopilot Filter Fix

> **DEPRECATED (2026-09):** References legacy Chrome Manager jobs. Current LinkedIn automation uses Platform Connections + `linkedin-api` CDP (see `social-media-auth.md`).

## Current State

**Job Graph (stale):**
- LinkedIn Autopilot app links: 2 jobs only
  - `4b23982f-1e1d-4645-9e5f-2304d0197a0c` (LinkedIn Auth — Cookie Capture)
  - `2b15ccb4-8d8f-48ad-99a0-964905e382b8` (LinkedIn Autopilot DB Setup)

**Actual Jobs (from jobs.json):**
- 12 jobs with folder "LinkedIn Autopilot"

## The Problem

The code changes I made are in TypeScript source files, but they haven't been:
1. Compiled to JavaScript
2. Applied by restarting the app
3. Triggered to rebuild the job graph

## Steps to Fix

```bash
# 1. Stop the app (Cmd+C in terminal)
# Press Ctrl+C or Cmd+C

# 2. Rebuild the TypeScript code
npm run build

# 3. Start the app (this will trigger job graph rebuild)
npm start
```

## What Should Happen

After restart, the job graph should rebuild and:

1. **Code-based discovery** scans LinkedIn Autopilot app code for database references
2. **Folder-based linking** includes all 12 jobs in the filter (UI improvement)
3. **Auto-linking** connects job databases as data sources (for querying)

## Verification

After restart:

```bash
# Check the updated job graph
cat $PAPR_HOME/data/job-graph.json | jq '.appLinks."a595958d-2a94-4565-ad6d-34feea6db456".jobIds | length'
# Should show: 12 (not 2)

# Check console logs for auto-discovery
# Should see: [AppService] Auto-linked data source: {job} → LinkedIn Autopilot
```

## Expected Result

**Jobs View → Click "LinkedIn Autopilot" filter:**
- Should show all 12 jobs:
  - LinkedIn Chrome Manager
  - LinkedIn Connection Sender
  - LinkedIn Message Sender
  - LinkedIn Auth — Cookie Capture
  - LinkedIn Campaign Optimizer
  - LinkedIn Connection Tracker
  - mem0 Leads → LinkedIn Autopilot
  - LinkedIn Reply Drafter
  - LinkedIn Recommendation Implementer
  - LinkedIn Lead Enrichment
  - LinkedIn Search Import
  - LinkedIn Autopilot DB Setup

Currently showing: 2 jobs (stale graph)
After fix: 12 jobs (complete graph)
