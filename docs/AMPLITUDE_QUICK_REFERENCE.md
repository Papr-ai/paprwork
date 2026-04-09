# Amplitude Session Replay & Enhanced Tracking - Quick Reference

**Created:** 2026-04-07
**Status:** Ready to implement
**Effort:** 2-3 weeks

## What We're Building

Comprehensive user analytics with **visual session replay** to understand:
- How users interact with the app
- Where they get stuck or confused  
- Which features drive retention
- What causes errors and churn

## Key Features

### 1. Session Replay
- **Visual playback** of user sessions (like watching a screen recording)
- See exact clicks, scrolls, typing
- Automatic masking of sensitive data (API keys, passwords)
- Links to specific moments before errors

### 2. Enhanced Event Tracking
- **40+ events** across full user journey
- Onboarding flow tracking
- Feature adoption (jobs, apps, plans)
- Performance monitoring (slow queries, API errors)
- Error tracking with full context

### 3. User Properties
- Platform info (OS, app version)
- Provider configuration (which APIs configured)
- Feature usage counters
- Settings preferences

## Why This Matters

### Before (Current State)
- ❌ Only 4 basic events tracked (app start/quit/suspend/resume)
- ❌ No visibility into user behavior
- ❌ Can't debug user-reported issues
- ❌ Don't know which features are used
- ❌ Can't see why users churn

### After (With This Enhancement)
- ✅ **Watch session replays** of users hitting bugs
- ✅ **Track onboarding completion** and drop-off points
- ✅ **Measure feature adoption** (jobs, apps, plans)
- ✅ **Identify friction** in UI/UX
- ✅ **Debug issues faster** with full context

## Example Use Cases

### 1. Debugging User Issues

**Scenario:** User reports "Jobs aren't working"

**Without session replay:**
- Ask user for steps to reproduce
- Can't see what they're doing wrong
- Spend hours trying to reproduce

**With session replay:**
- Watch their session → see they forgot to install Python
- See exact error message they saw
- Fix in 5 minutes by improving error message

### 2. Improving Onboarding

**Scenario:** 50% of users never send first message

**Without tracking:**
- Don't know which step confuses them
- Can't measure impact of changes
- Guessing what's wrong

**With tracking:**
- See 80% drop off at "Configure Provider" step
- Watch replays → see users confused by API key setup
- Add "Help" button → measure improvement (50% → 75% completion)

### 3. Feature Adoption

**Scenario:** Built new Jobs feature, want to know if people use it

**Without tracking:**
- No data on usage
- Don't know if it's valuable
- Can't justify continued investment

**With tracking:**
- See 30% of active users create jobs
- See average 5 jobs per power user
- Track job success rate (80%)
- **Result:** Justify building more job features

## Implementation Status

### ✅ Completed (Phase 0)
- [x] Dependencies added to `package.json`
- [x] Event definitions created
- [x] User properties helper created
- [x] Renderer telemetry client created
- [x] Amplitude initialization added to App.tsx
- [x] Documentation complete

### 🚧 Remaining Work (Phases 1-4)

**Week 1: Core Setup**
- [ ] Test Amplitude initialization
- [ ] Configure environment variables
- [ ] Verify events reaching Amplitude

**Week 2: Event Tracking**
- [ ] Add onboarding events
- [ ] Add chat events  
- [ ] Add job events
- [ ] Add mini-app events

**Week 3: Polish**
- [ ] Add error tracking
- [ ] Add performance tracking
- [ ] Add user properties management
- [ ] Configure session replay masking

**Week 4: Production**
- [ ] Create Amplitude dashboards
- [ ] Set up alerts
- [ ] Gradual rollout (10% → 50% → 100%)
- [ ] Monitor key metrics

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start app (telemetry auto-enabled in packaged builds)
npm start

# 3. Check browser console for:
# "[Amplitude] Initialized with session replay"

# 4. Trigger some events (send message, create job)

# 5. Check Amplitude dashboard
# Events appear within 60 seconds
```

## Key Files

```
src/core/telemetry/
├── events.ts              # Event definitions (40+ events)
├── properties.ts          # User properties helper
├── TelemetryClient.ts     # Backend telemetry (exists)
└── index.ts               # Exports

ui/lib/
└── telemetry.ts           # Renderer telemetry + session replay

docs/
├── AMPLITUDE_ENHANCED_TRACKING.md      # Full spec
└── AMPLITUDE_IMPLEMENTATION_GUIDE.md   # Step-by-step guide
```

## Privacy & Compliance

### What We Track
- ✅ Feature usage (button clicks, flows)
- ✅ Performance (slow queries, latency)
- ✅ Errors (crashes, API failures)
- ✅ User journey (onboarding → first message)

### What We DON'T Track
- ❌ Message content (only length)
- ❌ API keys (masked in replay)
- ❌ Bash commands (only success/fail)
- ❌ File paths (only read/write events)
- ❌ Email, name, IP address

### User Control
- ✅ **Opt-in by default** (commercial builds)
- ✅ **Opt-out in Settings** → Privacy
- ✅ **Clear disclosure** in onboarding
- ✅ **Anonymous IDs** (no PII)

## Cost Estimate

**Amplitude Pricing:**
- Session Replay: $0.0035 per session
- Events: Free up to 10M/month

**Expected Cost:**
- 1,000 daily users × 2 sessions = 2,000 sessions/day
- 2,000 × $0.0035 = $7/day = **~$210/month**

## Success Metrics

### Short-term (First Month)
- Session replay adoption: >80% of sessions
- Event volume: 10-20 events per session
- Error rate: <1%
- Onboarding completion: >60%

### Long-term (3-6 Months)
- Day 7 retention: >40%
- Day 30 retention: >25%
- Feature adoption (jobs): >30%
- Average session duration: >15 minutes

## Next Steps

1. **Review** this quick reference + full docs
2. **Test** in dev mode (`npm start`)
3. **Implement** events following the guide
4. **Monitor** Amplitude dashboard
5. **Iterate** based on insights

## Questions?

- Full details: [AMPLITUDE_ENHANCED_TRACKING.md](./AMPLITUDE_ENHANCED_TRACKING.md)
- Implementation: [AMPLITUDE_IMPLEMENTATION_GUIDE.md](./AMPLITUDE_IMPLEMENTATION_GUIDE.md)
- Amplitude docs: https://www.docs.developers.amplitude.com/
