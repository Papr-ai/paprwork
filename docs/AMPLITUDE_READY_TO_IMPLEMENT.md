# Amplitude Event Tracking - Ready to Implement

**Status:** Infrastructure complete, just add tracking calls
**Privacy:** Events only, no session replay, fully anonymous

## What's Already Done ✅

1. ✅ Amplitude SDK installed (`@amplitude/analytics-browser`)
2. ✅ Event definitions created (40+ events with typed properties)
3. ✅ Telemetry client ready (`ui/lib/telemetry.ts`)
4. ✅ Initialization in App.tsx
5. ✅ User properties system
6. ✅ Privacy-first design (anonymous, opt-in)

## How to Add Event Tracking

### Step 1: Import the helpers

```typescript
import { trackEvent, incrementUserProperty } from '../lib/telemetry';
import { AmplitudeEvents } from '../../src/core/telemetry/events';
```

### Step 2: Track events

```typescript
// Example: Track message sent
trackEvent(AmplitudeEvents.MESSAGE_SENT, {
  message_length: text.length,
  model: currentModel,
  provider: currentProvider,
});

// Example: Track job completed
trackEvent(AmplitudeEvents.JOB_COMPLETED, {
  job_id: job.id,
  job_type: job.type,
  duration_ms: endTime - startTime,
  exit_code: result.exitCode,
});

// Example: Increment feature counter
incrementUserProperty('jobs_created_count');
```

## Events Ready to Track (40+)

### Lifecycle (6 events)
- ✅ `paprwork_app_started` - Already tracking
- ✅ `paprwork_app_quit` - Already tracking
- ✅ `paprwork_system_suspend` - Already tracking
- ✅ `paprwork_system_resume` - Already tracking
- 🆕 `paprwork_window_focused` - Add to window focus handler
- 🆕 `paprwork_window_minimized` - Add to window minimize handler

### Onboarding (6 events)
- 🆕 `paprwork_onboarding_started`
- 🆕 `paprwork_onboarding_step_viewed`
- 🆕 `paprwork_onboarding_step_completed`
- 🆕 `paprwork_onboarding_completed`
- 🆕 `paprwork_papr_login_started`
- 🆕 `paprwork_papr_login_completed`

### Chat (6 events)
- 🆕 `paprwork_chat_created`
- 🆕 `paprwork_message_sent`
- 🆕 `paprwork_message_received`
- 🆕 `paprwork_chat_deleted`
- 🆕 `paprwork_chat_renamed`
- 🆕 `paprwork_model_changed`

### Tools (5 events)
- 🆕 `paprwork_tool_called`
- 🆕 `paprwork_bash_command_executed`
- 🆕 `paprwork_file_read`
- 🆕 `paprwork_file_written`
- 🆕 `paprwork_browser_action`

### Jobs (6 events)
- 🆕 `paprwork_job_created`
- ✅ `paprwork_job_completed` - Already tracking (enhance with more properties)
- ✅ `paprwork_job_failed` - Already tracking (enhance with more properties)
- 🆕 `paprwork_job_edited`
- 🆕 `paprwork_job_deleted`

**Note:** Removed `paprwork_scheduler_tick` - too noisy for user analytics

### Mini-Apps (5 events)
- 🆕 `paprwork_app_created`
- 🆕 `paprwork_app_opened`
- 🆕 `paprwork_app_closed`
- 🆕 `paprwork_app_edited`
- 🆕 `paprwork_app_deleted`

### Plans (4 events)
- 🆕 `paprwork_plan_created`
- 🆕 `paprwork_plan_step_completed`
- 🆕 `paprwork_plan_completed`
- 🆕 `paprwork_plan_deleted`

### Settings (5 events)
- 🆕 `paprwork_settings_opened`
- 🆕 `paprwork_provider_configured`
- 🆕 `paprwork_telemetry_toggled`
- 🆕 `paprwork_theme_changed`
- 🆕 `paprwork_default_model_changed`

### Errors (3 events)
- 🆕 `paprwork_error_occurred`
- 🆕 `paprwork_api_error`
- 🆕 `paprwork_job_error`

### Performance (3 events)
- 🆕 `paprwork_slow_operation`
- 🆕 `paprwork_database_query_slow`
- 🆕 `paprwork_websocket_latency`

## Priority Implementation Order

### Phase 1: High-Value Events (Week 1)
Focus on these first for immediate insights:

1. **Onboarding tracking** (`OnboardingView.tsx`)
   ```typescript
   trackEvent(AmplitudeEvents.ONBOARDING_STARTED);
   trackEvent(AmplitudeEvents.ONBOARDING_STEP_COMPLETED, { step_number: 1 });
   trackEvent(AmplitudeEvents.ONBOARDING_COMPLETED, { time_spent_seconds: 120 });
   ```

2. **Chat events** (`useAgent.ts`, `ChatView.tsx`)
   ```typescript
   trackEvent(AmplitudeEvents.MESSAGE_SENT, { message_length: 100, model: 'gpt-5.2' });
   trackEvent(AmplitudeEvents.MESSAGE_RECEIVED, { response_time_ms: 2500 });
   ```

3. **Job events** (`JobsService.ts`)
   ```typescript
   trackEvent(AmplitudeEvents.JOB_CREATED, { job_type: 'python', has_schedule: true });
   // Enhance existing job_completed/failed with more properties
   ```

### Phase 2: Feature Tracking (Week 2)
4. **Mini-app events** (`useApps.ts`)
5. **Plan events** (`PlanService.ts`)
6. **Settings events** (`SettingsView.tsx`)

### Phase 3: Quality Tracking (Week 3)
7. **Error events** (Global error handler in `App.tsx`)
8. **Performance events** (Database queries, API calls)

## Code Examples

### Example 1: Onboarding Tracking

```typescript
// ui/components/Onboarding/OnboardingView.tsx
import { trackEvent } from '../../lib/telemetry';
import { AmplitudeEvents } from '../../../src/core/telemetry/events';

// On mount
useEffect(() => {
  trackEvent(AmplitudeEvents.ONBOARDING_STARTED);
}, []);

// When step completes
const handleStepComplete = (stepNumber: number, stepName: string) => {
  trackEvent(AmplitudeEvents.ONBOARDING_STEP_COMPLETED, {
    step_number: stepNumber,
    step_name: stepName,
  });
};

// When all steps done
const handleComplete = () => {
  trackEvent(AmplitudeEvents.ONBOARDING_COMPLETED, {
    time_spent_seconds: Math.floor((Date.now() - startTime) / 1000),
    steps_completed: 3,
  });
};
```

### Example 2: Chat Tracking

```typescript
// ui/hooks/useAgent.ts
import { trackEvent } from '../lib/telemetry';
import { AmplitudeEvents } from '../../src/core/telemetry/events';

// When sending message
export function sendMessage(text: string) {
  const startTime = Date.now();
  
  trackEvent(AmplitudeEvents.MESSAGE_SENT, {
    message_length: text.length,
    has_attachments: false,
    model: currentModel,
    provider: currentProvider,
  });
  
  // ... send message
}

// When receiving response
function handleComplete(response: AgentResponse) {
  trackEvent(AmplitudeEvents.MESSAGE_RECEIVED, {
    response_time_ms: Date.now() - startTime,
    token_count: response.usage?.total_tokens,
    cost: response.cost,
    model: currentModel,
    provider: currentProvider,
  });
}
```

### Example 3: Job Tracking

```typescript
// src/gateway/services/JobsService.ts
import { getGatewayTelemetry } from './gatewayTelemetry.js';
import { AmplitudeEvents } from '../../core/telemetry/events';

// When creating job
async createJob(input: CreateJobInput) {
  const job = await this.jobsService.createJob(input);
  
  getGatewayTelemetry().trackFireAndForget(AmplitudeEvents.JOB_CREATED, {
    job_id: job.id,
    job_type: job.type,
    has_schedule: !!job.schedule?.enabled,
    has_dependencies: (job.dependsOn?.length ?? 0) > 0,
  });
  
  return job;
}

// Enhance existing job_completed
getGatewayTelemetry().trackFireAndForget(AmplitudeEvents.JOB_COMPLETED, {
  job_id: job.id,
  job_type: job.type,
  duration_ms: endTime - startTime,  // ADD THIS
  exit_code: result.exitCode,        // ADD THIS
  had_retry: attempt > 1,            // ADD THIS
  output_size_bytes: result.output.length,  // ADD THIS
  scheduled: job.schedule?.enabled ?? false, // ADD THIS
});
```

## Testing Your Events

### 1. Check Console
```bash
npm start

# Look for:
# "[Amplitude] Initialized with event tracking (ID: abc123...)"
# "[Amplitude] Events flushed"
```

### 2. Trigger Events
- Send a message → Should see `paprwork_message_sent`
- Create a job → Should see `paprwork_job_created`
- Open settings → Should see `paprwork_settings_opened`

### 3. Check Amplitude Dashboard
- Events appear within 60 seconds
- Check "User Streams" to see your anonymous ID's events
- Verify properties are correct

## User Properties to Set

```typescript
import { setUserProperties, incrementUserProperty } from '../lib/telemetry';

// On app start (set initial properties)
setUserProperties({
  platform: process.platform,
  app_version: appVersion,
  has_anthropic: !!anthropicApiKey,
  has_openai: !!openaiApiKey,
  theme: currentTheme,
});

// When user creates features (increment counters)
incrementUserProperty('jobs_created_count');
incrementUserProperty('apps_created_count');
incrementUserProperty('chats_created_count');
```

## What Success Looks Like

After implementation, you'll be able to answer:

✅ **"How many users complete onboarding?"**
→ Check funnel: started → completed (target: >60%)

✅ **"What's our Day 7 retention?"**
→ Cohort analysis (target: >40%)

✅ **"Which features are most used?"**
→ Event volume by type (jobs > apps > plans)

✅ **"What causes the most errors?"**
→ Top errors by frequency (API errors > job failures)

✅ **"Do job users stick around longer?"**
→ Retention: job users vs non-job users

## Privacy Reminder

What we track:
- ✅ Events (which buttons clicked)
- ✅ Aggregated metrics (counts, durations)
- ✅ Error types (not personal data)

What we DON'T track:
- ❌ Message content
- ❌ API keys
- ❌ File contents
- ❌ Personal info (email, name)

## Next Steps

1. Start with **onboarding tracking** (highest ROI)
2. Add **chat events** (measure engagement)
3. Add **job events** (measure feature adoption)
4. Create **Amplitude dashboards**
5. Set up **error alerts**

## Resources

- Implementation guide: [AMPLITUDE_IMPLEMENTATION_GUIDE.md](./AMPLITUDE_IMPLEMENTATION_GUIDE.md)
- Full spec: [AMPLITUDE_ENHANCED_TRACKING.md](./AMPLITUDE_ENHANCED_TRACKING.md)
- Summary: [AMPLITUDE_EVENTS_ONLY_SUMMARY.md](./AMPLITUDE_EVENTS_ONLY_SUMMARY.md)

---

**You're ready to start tracking! The infrastructure is complete, just add the tracking calls.** 🚀
