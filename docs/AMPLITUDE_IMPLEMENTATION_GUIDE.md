# Amplitude Enhanced Tracking - Implementation Guide

**Created:** 2026-04-07

## Quick Start

This guide provides step-by-step instructions for implementing the enhanced Amplitude tracking with session replay.

## Prerequisites

✅ Already completed:
- [x] Amplitude SDK dependencies added to `package.json`
- [x] Event definitions created (`src/core/telemetry/events.ts`)
- [x] User properties helper created (`src/core/telemetry/properties.ts`)
- [x] Renderer telemetry client created (`ui/lib/telemetry.ts`)
- [x] Amplitude initialization added to `App.tsx`

## Implementation Checklist

### Phase 1: Core Infrastructure (Week 1)

#### 1.1 Install Dependencies
```bash
npm install
```

#### 1.2 Configure Environment Variables
Add to `.env.local`:
```bash
# Telemetry endpoint (defaults to Papr proxy if not set)
VITE_TELEMETRY_URL=https://dashboard.papr.ai/v1/telemetry/events
```

#### 1.3 Test Basic Tracking
```bash
# Start the app with telemetry enabled
npm start

# Check browser console for:
# "[Amplitude] Initialized with session replay"
# "[Amplitude] Events flushed"
```

### Phase 2: Add Event Tracking (Weeks 2-3)

#### 2.1 Lifecycle Events

**File: `src/electron/index.cjs`**

Already tracking:
- ✅ `paprwork_app_started`
- ✅ `paprwork_app_quit`  
- ✅ `paprwork_system_suspend`
- ✅ `paprwork_system_resume`

Add new events:
```javascript
// Window focus tracking
mainWindow.on('focus', () => {
  if (telemetryClientInstance) {
    telemetryClientInstance.trackFireAndForget('paprwork_window_focused');
  }
});

mainWindow.on('minimize', () => {
  if (telemetryClientInstance) {
    telemetryClientInstance.trackFireAndForget('paprwork_window_minimized');
  }
});
```

Enhance existing app_started:
```javascript
// Add first_launch detection and providers configured
const isFirstLaunch = !settingsStorage.getSettings().telemetry.installId;
const providersConfigured = getProvidersConfigured(settingsStorage.getSettings());

telemetryClientInstance.trackFireAndForget("paprwork_app_started", {
  first_launch: isFirstLaunch,
  providers_configured: providersConfigured,
  days_since_install: calculateDaysSinceInstall(firstLaunchDate),
});
```

#### 2.2 Onboarding Events

**File: `ui/components/Onboarding/OnboardingView.tsx`**

Add tracking to onboarding flow:
```typescript
import { trackEvent } from '../../lib/telemetry';
import { AmplitudeEvents } from '../../../src/core/telemetry/events';

// On component mount
useEffect(() => {
  trackEvent(AmplitudeEvents.ONBOARDING_STARTED);
}, []);

// When step completes
const handleStepComplete = (stepNumber: number, stepName: string) => {
  trackEvent(AmplitudeEvents.ONBOARDING_STEP_COMPLETED, {
    step_number: stepNumber,
    step_name: stepName,
  });
  
  // Proceed to next step...
};

// When onboarding completes
const handleOnboardingComplete = () => {
  const timeSpent = Date.now() - startTime;
  
  trackEvent(AmplitudeEvents.ONBOARDING_COMPLETED, {
    time_spent_seconds: Math.floor(timeSpent / 1000),
    steps_completed: 3,
  });
  
  // Close onboarding...
};
```

#### 2.3 Chat Events

**File: `ui/hooks/useAgent.ts`**

Add tracking to message send/receive:
```typescript
import { trackEvent, incrementUserProperty } from '../lib/telemetry';
import { AmplitudeEvents } from '../../src/core/telemetry/events';

// Track message sent
export function sendMessage(text: string) {
  const startTime = Date.now();
  
  trackEvent(AmplitudeEvents.MESSAGE_SENT, {
    message_length: text.length,
    has_attachments: false,
    model: currentModel,
    provider: currentProvider,
  });
  
  // Increment chat counter
  incrementUserProperty('chats_created_count');
  
  // Send message...
}

// Track message received
function handleMessageComplete(response: AgentResponse) {
  const duration = Date.now() - startTime;
  
  trackEvent(AmplitudeEvents.MESSAGE_RECEIVED, {
    response_time_ms: duration,
    token_count: response.usage?.total_tokens,
    cost: response.cost,
    model: currentModel,
    provider: currentProvider,
  });
}
```

**File: `ui/components/Chat/ChatView.tsx`**

Track chat creation/deletion:
```typescript
import { trackEvent } from '../../lib/telemetry';
import { AmplitudeEvents } from '../../../src/core/telemetry/events';

// Track chat created
const handleNewChat = async () => {
  const chatId = await createChat();
  
  trackEvent(AmplitudeEvents.CHAT_CREATED, {
    chat_id: chatId,
  });
  
  // Switch to new chat...
};

// Track chat deleted
const handleDeleteChat = async (chatId: string) => {
  await deleteChat(chatId);
  
  trackEvent(AmplitudeEvents.CHAT_DELETED, {
    chat_id: chatId,
  });
};
```

#### 2.4 Model Change Tracking

**File: `ui/components/ModelPicker/ModelPicker.tsx`**

Track model changes:
```typescript
import { trackEvent } from '../../lib/telemetry';
import { AmplitudeEvents } from '../../../src/core/telemetry/events';

const handleModelChange = (newModel: string, newProvider: string) => {
  trackEvent(AmplitudeEvents.MODEL_CHANGED, {
    from_model: currentModel,
    to_model: newModel,
    provider: newProvider,
  });
  
  setCurrentModel(newModel);
  setCurrentProvider(newProvider);
};
```

#### 2.5 Tool Usage Events

**File: `src/gateway/services/AgentService.ts`**

Track tool calls:
```typescript
import { getGatewayTelemetry } from './gatewayTelemetry.js';
import { AmplitudeEvents } from '../../core/telemetry/events';

// In tool execution logic
async function executeTool(toolName: string, args: unknown) {
  const startTime = performance.now();
  let success = false;
  let errorMessage: string | undefined;
  
  try {
    const result = await tool.execute(args);
    success = true;
    return result;
  } catch (error) {
    success = false;
    errorMessage = (error as Error).message;
    throw error;
  } finally {
    const duration = performance.now() - startTime;
    
    getGatewayTelemetry().trackFireAndForget(AmplitudeEvents.TOOL_CALLED, {
      tool_name: toolName,
      success,
      duration_ms: Math.round(duration),
      error_message: errorMessage,
    });
  }
}
```

#### 2.6 Job Events

**File: `src/gateway/services/JobsService.ts`**

Enhance existing job tracking:
```typescript
import { AmplitudeEvents } from '../../core/telemetry/events';

// Job created (NEW)
async createJob(input: CreateJobInput) {
  const job = await this.jobsService.createJob(input);
  
  getGatewayTelemetry().trackFireAndForget(AmplitudeEvents.JOB_CREATED, {
    job_id: job.id,
    job_type: job.type,
    has_schedule: !!job.schedule?.enabled,
    has_dependencies: (job.dependsOn?.length ?? 0) > 0,
    schedule_type: job.schedule?.enabled 
      ? (job.schedule.cron ? 'cron' : job.schedule.intervalMs ? 'interval' : 'at_time')
      : undefined,
  });
  
  return job;
}

// Job completed (ENHANCE EXISTING)
getGatewayTelemetry().trackFireAndForget(AmplitudeEvents.JOB_COMPLETED, {
  job_id: job.id,
  job_type: job.type,
  duration_ms: endTime - startTime, // ADD
  exit_code: result.exitCode, // ADD
  had_retry: attempt > 1, // ADD
  output_size_bytes: result.output.length, // ADD
  scheduled: job.schedule?.enabled ?? false, // ADD
});

// Job failed (ENHANCE EXISTING)
getGatewayTelemetry().trackFireAndForget(AmplitudeEvents.JOB_FAILED, {
  job_id: job.id,
  job_type: job.type,
  error_type: classifyError(error), // ADD
  error_message: (error as Error).message, // ADD
  attempt_number: attempt, // ADD
  max_attempts: maxAttempts, // ADD
});
```

#### 2.7 Mini-App Events

**File: `ui/hooks/useApps.ts`**

Track mini-app lifecycle:
```typescript
import { trackEvent, incrementUserProperty } from '../lib/telemetry';
import { AmplitudeEvents } from '../../src/core/telemetry/events';

// App created
export async function createApp(data: AppData) {
  const app = await gateway.send('apps:create', data);
  
  trackEvent(AmplitudeEvents.APP_CREATED, {
    app_id: app.id,
    has_icon: !!app.icon,
    has_data_sources: app.dataSources.length > 0,
  });
  
  incrementUserProperty('apps_created_count');
  
  return app;
}

// App opened
export function openApp(appId: string, source: 'tab' | 'home_button') {
  trackEvent(AmplitudeEvents.APP_OPENED, {
    app_id: appId,
    open_source: source,
  });
  
  // Track time opened for close event
  appOpenTimes.set(appId, Date.now());
}

// App closed
export function closeApp(appId: string) {
  const openTime = appOpenTimes.get(appId);
  if (openTime) {
    const timeOpen = Date.now() - openTime;
    
    trackEvent(AmplitudeEvents.APP_CLOSED, {
      app_id: appId,
      time_open_ms: timeOpen,
    });
    
    appOpenTimes.delete(appId);
  }
}
```

#### 2.8 Settings Events

**File: `ui/components/Settings/SettingsView.tsx`**

Track settings changes:
```typescript
import { trackEvent, setUserProperties } from '../../lib/telemetry';
import { AmplitudeEvents } from '../../../src/core/telemetry/events';

// Settings opened
useEffect(() => {
  trackEvent(AmplitudeEvents.SETTINGS_OPENED, {
    section: activeSection, // "providers" | "preferences" | etc
  });
}, [activeSection]);

// Provider configured
const handleProviderSave = async (provider: string, method: 'api_key' | 'oauth') => {
  await saveProviderConfig(provider, config);
  
  trackEvent(AmplitudeEvents.PROVIDER_CONFIGURED, {
    provider,
    method,
  });
  
  // Update user properties
  setUserProperties({
    [`has_${provider}`]: true,
  });
};

// Telemetry toggled
const handleTelemetryToggle = async (enabled: boolean) => {
  await window.electronAPI.telemetry.setEnabled(enabled);
  
  trackEvent(AmplitudeEvents.TELEMETRY_TOGGLED, {
    enabled,
  });
  
  setUserProperties({ telemetry_enabled: enabled });
};

// Theme changed
const handleThemeChange = (newTheme: Theme) => {
  trackEvent(AmplitudeEvents.THEME_CHANGED, {
    from_theme: currentTheme,
    to_theme: newTheme,
  });
  
  setUserProperties({ theme: newTheme });
  setCurrentTheme(newTheme);
};
```

### Phase 3: Error & Performance Tracking (Week 4)

#### 3.1 Global Error Handler

**File: `ui/App.tsx`**

Add global error boundary:
```typescript
import { trackEvent } from './lib/telemetry';
import { AmplitudeEvents } from '../src/core/telemetry/events';

// Add error listener
useEffect(() => {
  const handleError = (event: ErrorEvent) => {
    trackEvent(AmplitudeEvents.ERROR_OCCURRED, {
      error_type: 'unhandled_error',
      error_message: event.message,
      stack_trace: event.error?.stack?.substring(0, 500), // Truncate
      context: window.location.pathname,
    });
  };
  
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    trackEvent(AmplitudeEvents.ERROR_OCCURRED, {
      error_type: 'unhandled_promise_rejection',
      error_message: String(event.reason),
      context: window.location.pathname,
    });
  };
  
  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
  
  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  };
}, []);
```

#### 3.2 API Error Tracking

**File: `src/gateway/services/AgentService.ts`**

Track API errors:
```typescript
import { AmplitudeEvents } from '../../core/telemetry/events';

try {
  const response = await fetch(apiUrl, options);
  // ...
} catch (error) {
  getGatewayTelemetry().trackFireAndForget(AmplitudeEvents.API_ERROR, {
    provider: currentProvider,
    status_code: error.statusCode,
    error_message: error.message,
    endpoint: apiUrl,
  });
  
  throw error;
}
```

#### 3.3 Slow Operation Tracking

**File: `src/gateway/services/storage/LocalStorageProvider.ts`**

Track slow database queries:
```typescript
import { getGatewayTelemetry } from '../gatewayTelemetry.js';
import { AmplitudeEvents } from '../../../core/telemetry/events';

const SLOW_QUERY_THRESHOLD_MS = 1000; // 1 second

async function executeQuery<T>(query: () => T, queryType: string): Promise<T> {
  const startTime = performance.now();
  const result = query();
  const duration = performance.now() - startTime;
  
  if (duration > SLOW_QUERY_THRESHOLD_MS) {
    getGatewayTelemetry().trackFireAndForget(AmplitudeEvents.DATABASE_QUERY_SLOW, {
      query_type: queryType,
      duration_ms: Math.round(duration),
      threshold_ms: SLOW_QUERY_THRESHOLD_MS,
    });
  }
  
  return result;
}
```

### Phase 4: User Properties Management

#### 4.1 Initialize User Properties on First Launch

**File: `src/electron/index.cjs`**

Set initial user properties:
```javascript
const { setUserProperties } = await import('../core/telemetry/properties.js');

// On first launch
if (isFirstLaunch) {
  const initialProps = createInitialUserProperties(app.getVersion());
  
  // Store in settings for persistence
  settingsStorage.setUserProperties(initialProps);
  
  // Send to Amplitude (renderer will sync on startup)
}
```

#### 4.2 Update User Properties on Key Actions

Track feature usage counters:
```typescript
// When job created
incrementUserProperty('jobs_created_count');

// When app created  
incrementUserProperty('apps_created_count');

// When plan created
incrementUserProperty('plans_created_count');
```

### Phase 5: Session Replay Configuration

#### 5.1 Mark Sensitive Fields

**File: `ui/components/Settings/ApiKeyInput.tsx`**

Add `data-sensitive` attribute:
```tsx
<input
  type="password"
  data-sensitive="true"  // This will be masked in session replay
  value={apiKey}
  onChange={handleChange}
/>
```

**File: `ui/components/Chat/BashOutput.tsx`**

```tsx
<pre 
  className="bash-command-output"  // Blocked via selector
  data-sensitive="true"
>
  {output}
</pre>
```

#### 5.2 Test Session Replay Masking

1. Open app with telemetry enabled
2. Navigate to Settings → API Keys
3. Type in an API key field
4. Run a bash command with keys
5. Check Amplitude session replay - sensitive fields should be masked

### Phase 6: Testing & Validation

#### 6.1 Development Testing

```bash
# Enable telemetry in dev mode
npm start

# Open browser console
# Look for: "[Amplitude] Initialized with session replay"

# Trigger events:
# 1. Send a message (should see "paprwork_message_sent")
# 2. Create a job (should see "paprwork_job_created")
# 3. Open settings (should see "paprwork_settings_opened")

# Check Amplitude dashboard (test project)
# Events should appear within 60 seconds
```

#### 6.2 Event Validation Checklist

- [ ] Lifecycle events fire on app start/quit/suspend/resume
- [ ] Onboarding events track each step
- [ ] Chat events track message send/receive
- [ ] Job events track create/complete/fail
- [ ] Mini-app events track create/open/close
- [ ] Settings events track configuration changes
- [ ] Error events capture unhandled errors
- [ ] Slow operations are tracked
- [ ] User properties are set and updated correctly
- [ ] Session replay captures UI interactions
- [ ] Sensitive fields are masked in replay

#### 6.3 Privacy Validation

- [ ] Session replay disabled when telemetry disabled
- [ ] API keys masked in session replay
- [ ] Bash output masked in session replay  
- [ ] No message content sent (only length)
- [ ] No file paths sent (only read/write events)
- [ ] Anonymous install ID used (no PII)

### Phase 7: Amplitude Dashboard Setup

#### 7.1 Create Key Reports

1. **User Retention Cohorts**
   - Amplitude → Analytics → Cohorts → Create Cohort
   - Name: "Day 1 Retained Users"
   - Criteria: Performed `paprwork_app_started` on Day 0, returned on Day 1

2. **Feature Adoption Funnel**
   - Amplitude → Analytics → Funnels → Create Funnel
   - Steps:
     1. `paprwork_app_started` (first_launch: true)
     2. `paprwork_onboarding_completed`
     3. `paprwork_message_sent`
     4. `paprwork_job_created`
   - Group by: platform, providers_configured

3. **Job Success Rate**
   - Amplitude → Analytics → Events → Create Chart
   - Event A: `paprwork_job_completed`
   - Event B: `paprwork_job_failed`
   - Formula: A / (A + B) * 100
   - Segment by: job_type

4. **Error Dashboard**
   - Amplitude → Analytics → Dashboard → Create Dashboard
   - Widgets:
     - Error count over time (`paprwork_error_occurred`)
     - Top errors by type
     - API error rate by provider
     - Job error rate by type

#### 7.2 Set Up Alerts

1. **High Error Rate Alert**
   - Amplitude → Alerts → Create Alert
   - Condition: `paprwork_error_occurred` > 100 events/hour
   - Action: Send email to team@papr.ai

2. **Onboarding Drop-off Alert**
   - Condition: Onboarding completion rate < 50% (24hr rolling)
   - Action: Slack notification

### Phase 8: Production Rollout

#### 8.1 Staged Rollout

- **Week 1:** Release to 10% of users (canary)
- **Week 2:** Increase to 50% if no issues
- **Week 3:** Full rollout (100%)

#### 8.2 Monitor Key Metrics

Watch for:
- Session replay adoption rate (target: >80% of sessions)
- Event volume (target: 10-20 events per session)
- Performance overhead (target: <50ms per event)
- Error rate (target: <1% of sessions with errors)

## Troubleshooting

### Issue: Events not appearing in Amplitude

**Check:**
1. Telemetry enabled in settings?
2. Install ID present in settings?
3. Network requests succeeding? (Check browser dev tools)
4. Correct endpoint URL in env vars?

**Solution:**
```bash
# Check settings
cat $PAPR_HOME/data/settings.json | grep telemetry

# Check network
# Open browser dev tools → Network tab
# Look for POST requests to /v1/telemetry/events

# Check console for errors
# Should see: "[Amplitude] Initialized with session replay"
```

### Issue: Session replay not recording

**Check:**
1. Session Replay plugin loaded?
2. Sampling rate set correctly?
3. User opted in to telemetry?

**Solution:**
```typescript
// Check if plugin loaded
console.log('Amplitude plugins:', amplitude.getPlugins());

// Verify sampling rate
// In ui/lib/telemetry.ts, check sessionSampleRate: 1.0
```

### Issue: Sensitive data visible in replay

**Check:**
1. `data-sensitive` attribute on inputs?
2. CSS classes in `blockSelector`?
3. `maskAllInputs` set correctly?

**Solution:**
```tsx
// Add data-sensitive to input
<input type="text" data-sensitive="true" />

// Or add CSS class to blockSelector
blockSelector: ['.my-sensitive-class']
```

## Next Steps

After completing implementation:

1. **Monitor Amplitude dashboard daily** for first week
2. **Review session replays** of users who churn to identify friction
3. **Create custom dashboards** for your key metrics
4. **Set up alerts** for critical errors
5. **A/B test** onboarding variations using Amplitude experiments

## Resources

- [Amplitude Session Replay Docs](https://www.docs.developers.amplitude.com/session-replay/)
- [Amplitude Analytics API](https://www.docs.developers.amplitude.com/analytics/apis/http-v2-api/)
- [AMPLITUDE_ENHANCED_TRACKING.md](./AMPLITUDE_ENHANCED_TRACKING.md) - Full feature specification
- [Privacy Policy Template](https://www.amplitude.com/privacy-policy-template)

## Support

Questions? Issues?
- Internal docs: `docs/AMPLITUDE_ENHANCED_TRACKING.md`
- Amplitude support: support@amplitude.com
- Papr team: #engineering on Slack
