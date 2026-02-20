# Agents Page Improvements

## Issues Fixed

### 1. Permission Store Error (Critical)
**Problem:** App crashed with "Cannot read properties of undefined (reading 'permissions')"  
**Root Cause:** `window.electronAPI.permissions` is undefined when running in browser (not Electron)  
**Fix:** Added safety checks in `permissionStore.ts`:
```typescript
if (!window.electronAPI?.permissions) {
  console.warn("[PermissionStore] Not running in Electron, skipping permission listener");
  return;
}
```

### 2. Data Not Showing
**Possible causes:**
- WebSocket connection issues
- Gateway not initialized  
- SubAgentService not loading data
- Dashboard/runs endpoints returning empty data

**Debug steps added:**
- Added console logging to AgentsView to show data state
- Added loading and error states to UI
- Show actual counts and data in debug logs

## Recommended UX Improvements

Based on the reference screenshot (Command Center-style), users need to see:

### Key Metrics (Top Row)
1. **Active Agents** - Total specialist agents available
2. **Total Runs** - All delegation attempts
3. **Success Rate** - % of successful completions
4. **Cost** - Estimated API cost (if tracking)
5. **Running Now** - Currently active delegations

### Agent Roster (Main Section)
For each agent, show:
- **Name** & **Description**
- **Runs** - Total times delegated
- **Avg Score** - Quality/success metric (0-100%)
- **Trend** - Performance over time (sparkline)
- **Cost** - API cost per agent
- **Last Active** - Time since last use
- **Status indicator** - Active/Idle/Declining

### Active Operations (Right Panel)
- Currently running delegations
- Task description
- Progress indicator
- Time elapsed

### Performance Insights
- **Top Performers** - Best agents by success rate
- **Cost Analysis** - Which agents are most expensive
- **Declining Agents** - Performance drops needing attention
- **Recommendations** - Suggested model changes or prompt improvements

### Learning & Improvement
- **Success Patterns** - What types of tasks work well
- **Failure Analysis** - Common failure modes
- **Optimization Suggestions** - Based on usage patterns

## Implementation Plan

### Phase 1: Fix Data Loading (Current)
- [x] Fix permission store crash
- [ ] Verify WebSocket connection
- [ ] Verify SubAgentService initialization
- [ ] Add debug logging
- [ ] Test with real delegation data

### Phase 2: Enhanced Metrics
- [ ] Add performance scoring system
- [ ] Track cost per agent/run
- [ ] Add trend calculation (sparklines)
- [ ] Store historical performance data

### Phase 3: Better UX
- [ ] Redesign layout to match Command Center aesthetic
- [ ] Add real-time updates (live status)
- [ ] Add filtering/sorting (by performance, cost, usage)
- [ ] Add agent detail view (click to see full history)
- [ ] Add inline actions (delegate task, edit agent, view logs)

### Phase 4: Intelligence
- [ ] Auto-detect declining performance
- [ ] Suggest model upgrades/downgrades based on complexity
- [ ] Identify underutilized specialists
- [ ] Recommend new specialists based on task patterns
- [ ] Cost optimization suggestions

## Design Mockup (Text Description)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Agents                                            [Refresh]          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────┐  │
│  │ AGENTS   │  │ RUNS     │  │ AVG SCORE │  │ COST     │  │ LIVE │  │
│  │   14     │  │   33     │  │   63%     │  │  $9.11   │  │  2  │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └─────┘  │
│                                                                       │
├─────────────────────────────────────────────────┬─────────────────────┤
│ AGENT ROSTER                                    │ ACTIVE OPERATIONS  │
│                                                 │                     │
│ ┌─────────────────────────────────────────┐   │ ● Interview Debrief│
│ │ 🤖 Research Specialist                  │   │   1d 58s           │
│ │ Investigates complex topics             │   │                     │
│ │                                         │   │ ● Deal Desk Analyst│
│ │ Runs: 12  Score: 88%  📈  Cost: $2.14  │   │   1d 64s           │
│ │ Last: 2h ago                            │   │                     │
│ └─────────────────────────────────────────┘   └─────────────────────┘
│                                                                       │
│ ┌─────────────────────────────────────────┐                         │
│ │ 🎨 UI Designer                          │                         │
│ │ Creates interface mockups               │                         │
│ │                                         │                         │
│ │ Runs: 8   Score: 71%  📉  Cost: $1.80  │                         │
│ │ Last: 5h ago                            │                         │
│ └─────────────────────────────────────────┘                         │
│                                                                       │
├─────────────────────────────────────────────────────────────────────┤
│ INSIGHTS                                                             │
│                                                                       │
│ ⚠️  3 agents declining in performance - review prompts              │
│ 💡 Research Specialist could use gpt-5-mini → save $1.50/run       │
│ ✨  486 pending improvements                                         │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Next Steps

1. Test the fixed permission store
2. Verify data is now loading properly
3. If data loads, enhance the existing UI with better metrics
4. If data still doesn't load, debug WebSocket/Gateway connection
5. Implement Phase 2-4 improvements incrementally
