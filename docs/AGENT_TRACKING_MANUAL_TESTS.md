# Agent Attribution Tracking - Manual Testing Guide

## Overview
This guide walks through manually testing all the new agent attribution tracking features we implemented.

## Prerequisites
- App must be built: `npm run build`
- App must be running: `npm start`

## Test Scenarios

### 1. Message Token & Cost Tracking

**Test:** Verify tokens and cost are captured for agent messages

**Steps:**
1. Open the app
2. Create a new chat
3. Send a message to the agent
4. Wait for the agent to respond
5. Navigate to the Agents page
6. Check the Agent Roster card

**Expected Results:**
- Agent row shows non-zero values for:
  - Messages count
  - Tokens (should show K format if > 1000)
  - Cost (should show $ amount)
  - Tool Calls count

### 2. Per-Agent Statistics

**Test:** Verify per-agent metrics are correctly aggregated

**Steps:**
1. Have multiple chats with different amounts of messages
2. Navigate to the Agents page
3. Observe the Agent Roster card

**Expected Results:**
- Each agent shows accurate totals for:
  - Total messages sent
  - Total tokens used
  - Total cost incurred
  - Number of tool calls made
- Most Used Tools section shows top 3 tools with counts

### 3. Cost Overview Card

**Test:** Verify global cost statistics

**Steps:**
1. Navigate to Agents page
2. Look at the Cost Overview card

**Expected Results:**
- Shows total spend (large number)
- Breakdown by time period:
  - Today's cost
  - This week's cost
  - This month's cost
- Model distribution with bar charts
- Trend indicator (up/down arrow with %)

### 4. Token Usage Card

**Test:** Verify token tracking across agents

**Steps:**
1. Navigate to Agents page
2. Look at the Token Usage card

**Expected Results:**
- Shows total tokens used (formatted: 1.5K, 2M, etc.)
- Average tokens per message
- Top 5 agents by token usage with bars
- Efficiency score (High/Medium/Low)

### 5. Jobs & Runs Card

**Test:** Verify job tracking

**Steps:**
1. Navigate to Agents page
2. Look at the Jobs & Runs card

**Expected Results:**
- Stats grid shows:
  - Total runs
  - Active runs (with active badge)
  - Successful runs (green)
  - Failed runs (red)
- Top agents by delegation count
- Recent activity with timestamps

### 6. Active Operations Card

**Test:** Verify real-time operation tracking

**Steps:**
1. Delegate a task to an agent (that will take some time)
2. Navigate to Agents page
3. Look at the Active Operations card

**Expected Results:**
- Shows currently running operations
- Each operation displays:
  - Agent name
  - Status indicator (pulsing dot)
  - Duration (updates in real-time)
  - Session ID
  - Progress bar (animated)

### 7. Outputs Card - Documents

**Test:** Verify document attribution tracking

**Steps:**
1. Ask an agent to create a document
2. Navigate to Agents page
3. Look at the Outputs Card

**Expected Results:**
- Documents section shows count
- Recent outputs list shows the document with:
  - Document icon
  - Title
  - "Document" type badge
  - Time ago (e.g., "5m ago")

### 8. Outputs Card - Apps

**Test:** Verify app attribution tracking

**Steps:**
1. Ask an agent to create a mini-app
2. Navigate to Agents page
3. Look at the Outputs Card

**Expected Results:**
- Apps section shows count
- Recent outputs list shows the app with:
  - App icon
  - Title
  - "App" type badge
  - Time ago

### 9. Outputs Card - Plans

**Test:** Verify plan attribution tracking

**Steps:**
1. Ask an agent to create a plan
2. Navigate to Agents page
3. Look at the Outputs Card

**Expected Results:**
- Plans section shows count
- Recent outputs list shows the plan with:
  - Plan icon
  - Title
  - "Plan" type badge
  - Time ago

### 10. Tools & Skills Card

**Test:** Verify tool usage tracking

**Steps:**
1. Have agents use various tools (bash, read_file, etc.)
2. Navigate to Agents page
3. Look at the Tools & Skills card

**Expected Results:**
- Shows top 10 most-used tools
- Each tool has:
  - Icon (matching tool type)
  - Formatted name (e.g., "Read File")
  - Call count
  - Usage bar (relative to most-used tool)
- Cards are hoverable with color change

### 11. Header Stats Bar

**Test:** Verify compact header metrics

**Steps:**
1. Navigate to Agents page
2. Look at the top header bar

**Expected Results:**
- Shows 6 compact metrics:
  - Total Agents count
  - Active runs (with active badge color)
  - Total Runs
  - Average Score (%)
  - Total Cost ($)
  - Pending tasks count

### 12. Database Migration

**Test:** Verify existing databases migrate correctly

**Steps:**
1. Stop the app
2. Check the logs on next startup

**Expected Results:**
- Console shows:
  - `[PlanService] Added source_agent_id column` (if new)
  - `[PlanService] Added source_agent_name column` (if new)
  - `[PlanService] Initialized` (always)
- No errors about missing columns
- App starts successfully

### 13. Card Layout & Spacing

**Test:** Verify visual design

**Steps:**
1. Navigate to Agents page
2. Observe the overall layout

**Expected Results:**
- Cards have 24px spacing between them
- Cards have proper shadows
- Cards have hover effects (shadow increases)
- Grid is responsive (2 columns on desktop, stacks on mobile)
- Agent Roster spans full width
- All icons are SVG (no emojis)
- Icons match sidebar design style

## Verification Checklist

After running all tests, verify:

- [ ] All cards load without errors
- [ ] Data updates in real-time
- [ ] No console errors in browser DevTools
- [ ] No TypeScript errors during build
- [ ] Database migration completes successfully
- [ ] Tokens are tracked per message
- [ ] Cost is calculated per message
- [ ] Agent attribution is saved for documents
- [ ] Agent attribution is saved for apps
- [ ] Agent attribution is saved for plans
- [ ] Tool calls are counted correctly
- [ ] Most used tools are displayed
- [ ] Active operations show in real-time
- [ ] Cost trends calculate correctly
- [ ] Model distribution shows accurately
- [ ] Per-agent stats aggregate correctly
- [ ] Outputs card filters by agent
- [ ] Header stats are accurate
- [ ] All cards have proper spacing
- [ ] Icons are consistent (no emojis)

## Common Issues & Solutions

### Issue: Cards show "Loading..." indefinitely
**Solution:** Check browser console for WebSocket connection errors. Ensure Gateway is running on port 18789.

### Issue: All costs show $0.00
**Solution:** This is expected for old messages created before cost tracking was implemented. Create new messages to see costs.

### Issue: "Skills 0" showing despite tool calls
**Solution:** The skills count refers to assigned skills (config), not executed tool calls. Tool calls are shown in the Tools & Skills card.

### Issue: Outputs card is empty
**Solution:** Agent attribution only works for newly created documents/apps/plans. Old items won't have attribution.

### Issue: Database migration error
**Solution:** If you see "no such column" errors, delete the plans.db file and restart. The migration will recreate it.

## Success Metrics

The implementation is successful if:
1. ✅ All 13 test scenarios pass
2. ✅ All items in verification checklist are checked
3. ✅ No errors in console or logs
4. ✅ Data persists across app restarts
5. ✅ Performance is smooth (no lag when loading Agents page)

## Notes

- Token and cost tracking only works for messages created after the implementation
- Agent attribution for outputs only applies to newly created items
- The plans database automatically migrates with ALTER TABLE statements
- Tests can also be verified by inspecting the SQLite databases directly:
  - `~/PAPR/data/chats.db` - Messages with tokens/cost
  - `~/PAPR/data/plans.db` - Plans with source_agent_id
  - `~/PAPR/documents/*/meta.json` - Documents with createdByAgentId
  - `~/PAPR/data/apps.json` - Apps with createdByAgentId
