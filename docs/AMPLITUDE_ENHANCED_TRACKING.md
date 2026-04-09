# Amplitude Enhanced Tracking & Session Replay

**Created:** 2026-04-07

## Overview

This document outlines the enhanced Amplitude tracking implementation for Paprwork V2, including comprehensive event tracking, session replay, and user journey analytics.

## Goals

1. **Understand user behavior** - Track key actions and user flows
2. **Identify friction points** - See where users get stuck or confused
3. **Measure feature adoption** - Track which features are used most
4. **Debug user issues** - Session replay for troubleshooting
5. **Improve onboarding** - Track onboarding completion and drop-off

## Architecture

### Current Setup

- ✅ Basic telemetry client exists (`TelemetryClient.ts`)
- ✅ Proxy server pattern (Amplitude key server-side only)
- ✅ Anonymous install ID for privacy
- ✅ User opt-in/opt-out support
- ✅ Fire-and-forget tracking (no blocking)

### Enhanced Features

1. **Session Replay** - Visual replay of user sessions
2. **User Properties** - Track user attributes (OS, app version, providers configured)
3. **Event Properties** - Rich context for each event
4. **User Journey Tracking** - Track flows (onboarding → first message → first job)
5. **Performance Tracking** - Track slow operations
6. **Error Tracking** - Track errors with context

## Implementation Plan

### Phase 1: Amplitude Session Replay Setup

**Dependencies:**
```json
{
  "@amplitude/session-replay-browser": "^1.17.1",
  "@amplitude/analytics-browser": "^2.16.0"
}
```

**Integration Points:**
- Renderer process (UI) - Browser SDK for session replay
- Main/Gateway processes - Node SDK for backend events

**Privacy Considerations:**
- ✅ Session replay **only when user opts in** to telemetry
- ✅ Automatic masking of sensitive fields (API keys, passwords)
- ✅ Anonymous install ID (no email, no PII)
- ✅ Can disable specific UI elements from recording

### Phase 2: Event Taxonomy

#### Lifecycle Events
- `paprwork_app_started` (exists) - Add properties: providers_configured, first_launch
- `paprwork_app_quit` (exists)
- `paprwork_system_suspend` (exists)
- `paprwork_system_resume` (exists)
- `paprwork_window_focused` (new)
- `paprwork_window_minimized` (new)

#### Onboarding Events
- `paprwork_onboarding_started` (new)
- `paprwork_onboarding_step_viewed` (new) - Properties: step_number, step_name
- `paprwork_onboarding_step_completed` (new)
- `paprwork_onboarding_completed` (new) - Properties: time_spent, steps_completed
- `paprwork_papr_login_started` (new)
- `paprwork_papr_login_completed` (new)

#### Chat Events
- `paprwork_chat_created` (new)
- `paprwork_message_sent` (new) - Properties: message_length, has_attachments, model, provider
- `paprwork_message_received` (new) - Properties: response_time_ms, token_count, cost
- `paprwork_chat_deleted` (new)
- `paprwork_chat_renamed` (new)
- `paprwork_model_changed` (new) - Properties: from_model, to_model, provider

#### Tool Usage Events
- `paprwork_tool_called` (new) - Properties: tool_name, success, duration_ms
- `paprwork_bash_command_executed` (new) - Properties: success, duration_ms
- `paprwork_file_read` (new)
- `paprwork_file_written` (new)
- `paprwork_browser_action` (new) - Properties: action_type (navigate, click, snapshot)

#### Job Events
- `paprwork_job_created` (new) - Properties: job_type, has_schedule, has_dependencies
- `paprwork_job_completed` (exists) - Enhance with duration, output_size
- `paprwork_job_failed` (exists) - Enhance with error_type, attempt_number
- `paprwork_job_edited` (new)
- `paprwork_job_deleted` (new)
- `paprwork_scheduler_tick` (exists) - Keep as-is

#### Mini-App Events
- `paprwork_app_created` (new) - Properties: has_icon, has_data_sources
- `paprwork_app_opened` (new) - Properties: app_id, open_source (tab vs home button)
- `paprwork_app_closed` (new) - Properties: time_open_ms
- `paprwork_app_edited` (new)
- `paprwork_app_deleted` (new)
- `paprwork_home_app_set` (new) - Properties: app_id

#### Plan Events
- `paprwork_plan_created` (new) - Properties: step_count
- `paprwork_plan_step_completed` (new) - Properties: step_index, total_steps
- `paprwork_plan_completed` (new) - Properties: time_spent, steps_count
- `paprwork_plan_deleted` (new)

#### Settings Events
- `paprwork_settings_opened` (new) - Properties: section
- `paprwork_provider_configured` (new) - Properties: provider, method (api_key vs oauth)
- `paprwork_telemetry_toggled` (new) - Properties: enabled
- `paprwork_theme_changed` (new) - Properties: from_theme, to_theme
- `paprwork_default_model_changed` (new) - Properties: provider, model

#### Error Events
- `paprwork_error_occurred` (new) - Properties: error_type, error_message, context, stack_trace
- `paprwork_api_error` (new) - Properties: provider, status_code, error_message
- `paprwork_job_error` (new) - Properties: job_type, error_type, error_message

#### Performance Events
- `paprwork_slow_operation` (new) - Properties: operation_name, duration_ms, threshold_ms
- `paprwork_database_query_slow` (new) - Properties: query_type, duration_ms
- `paprwork_websocket_latency` (new) - Properties: latency_ms, event_type

### Phase 3: User Properties

**Set on app start:**
```typescript
{
  platform: "darwin" | "win32" | "linux",
  app_version: "2.0.20",
  node_version: process.version,
  electron_version: process.versions.electron,
  first_launch_date: "2026-04-01T...",
  days_since_install: 7,
  
  // Provider configuration (no keys, just yes/no)
  has_anthropic: true,
  has_openai: false,
  has_google: false,
  has_papr: true,
  
  // Feature usage
  jobs_created_count: 5,
  apps_created_count: 3,
  chats_created_count: 10,
  plans_created_count: 2,
  
  // Settings
  theme: "dark",
  telemetry_enabled: true,
  has_default_home_app: true,
}
```

**Updated on relevant events:**
- Provider configured → Update `has_<provider>: true`
- Job created → Increment `jobs_created_count`
- Theme changed → Update `theme`

### Phase 4: Session Replay Configuration

**Mask sensitive fields:**
```typescript
{
  maskAllInputs: false, // Allow most inputs
  maskAllText: false,   // Allow most text
  
  // Specific selectors to always mask
  blockSelector: [
    '[data-sensitive="true"]',     // Custom attribute for sensitive fields
    'input[type="password"]',      // Passwords
    '.api-key-input',              // API key fields
    '.papr-api-key',               // Papr API key
    '.bash-command-output',        // Bash output (may contain keys)
    '.environment-variable',       // Environment variables
  ],
  
  // Sampling (start with 100%, reduce if volume too high)
  sessionSampleRate: 1.0, // Record 100% of sessions
  errorSampleRate: 1.0,   // Record 100% of error sessions
}
```

### Phase 5: User Journey Tracking

**Define key flows:**

1. **First-Time User Journey**
   - `paprwork_app_started` (first_launch: true)
   - `paprwork_onboarding_started`
   - `paprwork_onboarding_step_completed` (repeat)
   - `paprwork_provider_configured` (optional)
   - `paprwork_papr_login_completed` (optional)
   - `paprwork_onboarding_completed`
   - `paprwork_chat_created`
   - `paprwork_message_sent`
   - **Success metric:** % of users who send first message within 5 minutes

2. **Job Creation Journey**
   - `paprwork_chat_opened`
   - `paprwork_message_sent` (contains "create job")
   - `paprwork_tool_called` (tool: "create_job")
   - `paprwork_job_created`
   - `paprwork_job_completed` (first run)
   - **Success metric:** % of jobs that complete successfully on first run

3. **Mini-App Creation Journey**
   - `paprwork_message_sent` (contains "create app")
   - `paprwork_tool_called` (tool: "create_app")
   - `paprwork_app_created`
   - `paprwork_app_opened` (first time)
   - **Success metric:** % of apps that get opened within 24 hours of creation

## Implementation Details

### File Structure

```
src/
├── core/
│   └── telemetry/
│       ├── TelemetryClient.ts (exists, enhanced)
│       ├── AmplitudeClient.ts (new)
│       ├── events.ts (new - event definitions)
│       ├── properties.ts (new - property helpers)
│       └── sessionReplay.ts (new)
├── electron/
│   └── ipc/
│       └── telemetry.ts (exists, enhanced)
└── gateway/
    └── services/
        └── gatewayTelemetry.ts (exists, enhanced)

ui/
└── lib/
    └── telemetry.ts (new - renderer tracking)
```

### Example: Enhanced Event Tracking

**Before:**
```typescript
telemetryClientInstance.trackFireAndForget("paprwork_job_completed", {
  job_id: job.id,
  job_type: job.type,
});
```

**After:**
```typescript
telemetryClientInstance.trackFireAndForget("paprwork_job_completed", {
  job_id: job.id, // Still anonymous (UUID)
  job_type: job.type,
  duration_ms: endTime - startTime,
  exit_code: result.exitCode,
  had_retry: attempt > 1,
  output_size_bytes: result.output.length,
  scheduled: job.schedule?.enabled ?? false,
  has_dependencies: (job.dependsOn?.length ?? 0) > 0,
});
```

### Example: Session Replay Setup

**Renderer (UI):**
```typescript
// ui/lib/telemetry.ts
import * as amplitude from '@amplitude/analytics-browser';
import { sessionReplayPlugin } from '@amplitude/session-replay-browser';

export async function initializeAmplitude(installId: string, enabled: boolean) {
  if (!enabled) return;
  
  const sessionReplay = sessionReplayPlugin({
    sessionSampleRate: 1.0,
    errorSampleRate: 1.0,
    maskAllInputs: false,
    maskAllText: false,
    blockSelector: [
      '[data-sensitive="true"]',
      'input[type="password"]',
      '.api-key-input',
    ],
  });
  
  amplitude.init('proxy-endpoint-url', installId, {
    plugins: [sessionReplay],
    serverUrl: 'https://dashboard.papr.ai/v1/telemetry/events',
  });
}

export function trackEvent(eventName: string, properties?: Record<string, unknown>) {
  amplitude.track(eventName, properties);
}

export function setUserProperties(properties: Record<string, unknown>) {
  const identify = new amplitude.Identify();
  Object.entries(properties).forEach(([key, value]) => {
    identify.set(key, value);
  });
  amplitude.identify(identify);
}
```

**Usage in Components:**
```tsx
// ui/components/Chat/ChatView.tsx
import { trackEvent } from '../../lib/telemetry';

function ChatView() {
  const sendMessage = async (text: string) => {
    trackEvent('paprwork_message_sent', {
      message_length: text.length,
      has_attachments: false,
      model: currentModel,
      provider: currentProvider,
    });
    
    // ... send message logic
  };
}
```

## Privacy & Compliance

### User Control
- ✅ **Opt-in by default** for packaged builds (commercial)
- ✅ **Opt-out available** in Settings → Privacy
- ✅ **Clear disclosure** in onboarding and settings
- ✅ **Anonymous IDs** - no PII, no emails
- ✅ **Data retention** - 90 days default (configurable in Amplitude)

### What We Track
- ✅ Feature usage (which buttons clicked, which flows completed)
- ✅ Performance metrics (slow operations, latency)
- ✅ Error events (crashes, API failures)
- ✅ User journeys (onboarding → first message → feature adoption)

### What We DON'T Track
- ❌ Message content (only length, not text)
- ❌ API keys (masked in session replay)
- ❌ Bash command details (only success/failure)
- ❌ File paths (only read/write events)
- ❌ Personal identifiers (email, name, IP)

### GDPR Compliance
- ✅ Anonymous tracking (no personal data)
- ✅ User consent required (telemetry toggle)
- ✅ Data deletion request support (via Amplitude DSAR)
- ✅ Privacy policy link in settings

## Amplitude Dashboard Setup

### Key Reports to Create

1. **User Retention Cohorts**
   - Day 1, Day 7, Day 30 retention
   - Segmented by: first action taken, provider used, onboarding completed

2. **Feature Adoption Funnel**
   - App start → Onboarding → First message → First job → First app
   - Drop-off analysis at each step

3. **Job Success Rate**
   - % of jobs that complete vs fail
   - Average retry count
   - Segmented by job type

4. **Session Duration**
   - Average time per session
   - Segmented by day of week, hour of day

5. **Error Rate Dashboard**
   - Top errors by frequency
   - Error trends over time
   - Errors by version

6. **Provider Usage**
   - Most popular providers
   - Model switching patterns
   - API error rates by provider

### Session Replay Use Cases

1. **Onboarding Drop-off**
   - Watch sessions where users quit during onboarding
   - Identify confusing steps

2. **Feature Discovery Issues**
   - See how users try to find features
   - Identify UI/UX issues

3. **Error Investigation**
   - Watch session leading up to error
   - See exact user actions that triggered bug

4. **Job Creation Flow**
   - Watch how users create jobs
   - Identify common mistakes or confusion

## Testing Strategy

### Development Testing
```bash
# Test with telemetry enabled
TELEMETRY_ENABLED=true npm start

# Test with telemetry disabled
TELEMETRY_ENABLED=false npm start

# Check events in Amplitude (test project)
# Use test API key for dev builds
```

### Validation Checklist
- [ ] Events fire correctly in both main and renderer
- [ ] Session replay captures UI interactions
- [ ] Sensitive fields are masked in replay
- [ ] User can opt-out and events stop
- [ ] Performance overhead is <50ms per event
- [ ] Events appear in Amplitude within 60 seconds

## Rollout Plan

### Week 1: Core Infrastructure
- [ ] Add Amplitude browser SDK to renderer
- [ ] Create `AmplitudeClient.ts` wrapper
- [ ] Add session replay configuration
- [ ] Test in dev mode

### Week 2: Lifecycle & Onboarding Events
- [ ] Add onboarding tracking
- [ ] Add window lifecycle events
- [ ] Add user properties
- [ ] Test onboarding flow

### Week 3: Feature Events
- [ ] Add chat events
- [ ] Add job events
- [ ] Add mini-app events
- [ ] Add plan events

### Week 4: Error & Performance Tracking
- [ ] Add error tracking
- [ ] Add performance tracking
- [ ] Add slow operation alerts
- [ ] Test error scenarios

### Week 5: Polish & Launch
- [ ] Create Amplitude dashboards
- [ ] Set up alerts for critical errors
- [ ] Document privacy policy updates
- [ ] Launch to production

## Metrics to Watch

### Short-term (First Month)
- Session replay adoption (% of sessions recorded)
- Event volume (events per session)
- Error rate
- Onboarding completion rate

### Medium-term (3 Months)
- Day 7 retention
- Feature adoption (% using jobs, apps, plans)
- Job success rate
- Average session duration

### Long-term (6+ Months)
- Day 30 retention
- Power user identification (top 10% by usage)
- Churn prediction (drop-off patterns)
- Feature ROI (most-used vs least-used features)

## Cost Estimation

**Amplitude Pricing (Growth Plan):**
- Session Replay: $0.0035 per session
- Events: Included up to 10M/month

**Expected Volume:**
- 1,000 daily active users
- 10 events per session average
- 2 sessions per user per day
- = 20,000 events/day = 600K events/month ✅ Well within free tier

**Session Replay Cost:**
- 2,000 sessions/day × $0.0035 = $7/day = $210/month
- **Total: ~$210/month** for comprehensive session replay

## Future Enhancements

1. **A/B Testing**
   - Test different onboarding flows
   - Test UI variations
   - Measure impact on retention

2. **Predictive Analytics**
   - Churn prediction
   - Feature recommendation
   - User segmentation

3. **Custom Dashboards**
   - Real-time error monitoring
   - Job health dashboard
   - Provider performance comparison

4. **Alerting**
   - Spike in errors → Slack notification
   - Drop in retention → Email alert
   - New critical error → PagerDuty

---

**Status:** Ready to implement
**Priority:** High - Critical for understanding user behavior and improving product
**Effort:** ~2-3 weeks (including testing and rollout)
