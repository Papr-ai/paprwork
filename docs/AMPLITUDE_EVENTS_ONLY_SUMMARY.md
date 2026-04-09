# Amplitude Enhanced Event Tracking - Summary

**Created:** 2026-04-07
**Status:** Ready to implement
**Decision:** Events only, no session replay (privacy-first approach)

## What We're Building

Comprehensive anonymous event tracking to understand user behavior and improve the product through data-driven decisions.

## Key Features

### 1. **40+ Events Tracked**
- **Lifecycle:** App start/quit/suspend/resume/focus/minimize
- **Onboarding:** Flow tracking from start to completion
- **Chat:** Message send/receive, chat creation, model changes
- **Tools:** Tool calls with success/failure/duration
- **Jobs:** Creation, completion, failure, scheduling
- **Mini-Apps:** Create/open/close/edit lifecycle
- **Plans:** Step-by-step progress tracking
- **Settings:** Configuration changes, provider setup
- **Errors:** Error events with context for debugging
- **Performance:** Slow operations, database queries, latency

### 2. **User Properties**
- Platform info (OS, app version)
- Providers configured (which APIs set up)
- Feature usage counters
- Settings preferences

### 3. **Privacy-First Design**
✅ **Anonymous install ID** (no email, name, or IP)
✅ **Events only** (no visual recording)
✅ **User opt-in** required
✅ **No message content** (only length)
✅ **No API keys** tracked
✅ **No file paths** (only read/write counts)

## Why No Session Replay?

**Privacy concerns addressed:**
- No visual recording of user sessions
- Users can't feel "watched"
- Open source transparency maintained
- Events + error context sufficient for debugging
- Zero cost (vs $210/month for replay)

## What We Track vs Don't Track

### ✅ What We Track
- Feature usage (buttons clicked, flows completed)
- Performance metrics (slow operations)
- Error events (crashes, API failures)
- User journeys (onboarding → features)

### ❌ What We DON'T Track
- Message content (only length)
- API keys (never sent)
- Bash commands (only success/fail)
- File paths (only count of reads/writes)
- Personal info (email, name, IP)

## Cost

**$0/month** - Events are free up to 10M/month (well within expected volume)

## Implementation Status

### ✅ Completed (Phase 0)
- [x] Amplitude browser SDK added
- [x] Event definitions created (40+ events)
- [x] User properties helper created
- [x] Telemetry client created (events only)
- [x] Initialization added to App.tsx
- [x] Documentation complete

### 🚧 Remaining Work (2-3 weeks)

**Week 1:** Test setup
- Test Amplitude initialization
- Verify events reaching dashboard
- Configure environment variables

**Week 2:** Implement events
- Onboarding tracking
- Chat events
- Job/app/plan events
- Settings changes

**Week 3:** Polish
- Error tracking
- Performance tracking
- User properties management

**Week 4:** Production
- Create dashboards
- Set up alerts
- Gradual rollout

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start app
npm start

# 3. Check console for:
# "[Amplitude] Initialized with event tracking"

# 4. Trigger events (send message, create job)

# 5. Check Amplitude dashboard
# Events appear within 60 seconds
```

## Key Metrics to Track

**Short-term (First Month):**
- Event volume: 10-20 events per session
- Error rate: <1%
- Onboarding completion: >60%

**Long-term (3-6 Months):**
- Day 7 retention: >40%
- Day 30 retention: >25%
- Feature adoption (jobs): >30%
- Session duration: >15 minutes

## Use Cases

### 1. Feature Adoption
**Question:** "Are people using the jobs feature?"
**Answer:** Track `paprwork_job_created` events → 30% of users create jobs → Justify continued investment

### 2. Onboarding Drop-off
**Question:** "Where do users quit during onboarding?"
**Answer:** Track funnel: started → step 1 → step 2 → completed → 50% drop off at "Configure Provider" → Improve that step

### 3. Error Patterns
**Question:** "What's causing the most crashes?"
**Answer:** Track `paprwork_error_occurred` → Top error: "API key invalid" → Add validation UI

### 4. Retention Analysis
**Question:** "Do job users stick around longer?"
**Answer:** Compare retention: Job users (60% D7) vs non-job users (30% D7) → Jobs drive retention

## Files Structure

```
src/core/telemetry/
├── events.ts              # 40+ event definitions
├── properties.ts          # User properties helpers
├── TelemetryClient.ts     # Backend tracking (exists)
└── index.ts               # Exports

ui/lib/
└── telemetry.ts           # Renderer tracking (events only)

docs/
├── AMPLITUDE_ENHANCED_TRACKING.md       # Full spec
├── AMPLITUDE_IMPLEMENTATION_GUIDE.md    # Step-by-step guide
└── AMPLITUDE_EVENTS_ONLY_SUMMARY.md     # This file
```

## Next Steps

1. **Run** `npm install` to install Amplitude SDK
2. **Test** initialization by checking browser console
3. **Implement** events following the implementation guide
4. **Create** Amplitude dashboards for key metrics
5. **Monitor** event volume and error rate

## Questions?

- Full spec: [AMPLITUDE_ENHANCED_TRACKING.md](./AMPLITUDE_ENHANCED_TRACKING.md)
- Implementation guide: [AMPLITUDE_IMPLEMENTATION_GUIDE.md](./AMPLITUDE_IMPLEMENTATION_GUIDE.md)
- Amplitude docs: https://www.docs.developers.amplitude.com/

---

**Bottom line:** Privacy-first analytics with comprehensive event tracking, zero visual recording, and complete user transparency.
