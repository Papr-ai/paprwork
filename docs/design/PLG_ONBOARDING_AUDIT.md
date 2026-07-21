# Paprwork PLG Onboarding Audit

**Status:** Product recommendation  
**Scope:** New user, from authentication through first repeatable value  
**North-star principle:** Onboarding is the shortest credible path from the user's intent to meaningful, repeatable value—not a tour or setup checklist.

## Executive recommendation

Paprwork should replace its current two-step, timer-completed onboarding with an intent-led first-workflow experience.

The desired first session is:

> **Choose an outcome → give the minimum input → watch Pen complete real work → inspect a durable result → choose the next action → establish a return trigger**

The current onboarding has the right raw ingredients—zero-key model access, an agent that can take action, persistent memory, jobs, mini-apps, and telemetry—but it delays the first win with a generic interview, marks progress before work is complete, and does not define activation in terms of value.

The most important Phase 1 change is not visual. It is semantic: **completion must come from a successful product outcome, not a click plus a two-second timeout.**

---

## Current journey

### 1. Authentication

`ui/components/Auth/AuthWall.tsx`

- Commercial builds gate the product behind Papr authentication.
- Sign-in and account creation open an external browser flow.
- The screen says “Welcome” and “Sign in to Papr Work to get started,” but does not show the product's promised outcome, expected setup time, or what the user can accomplish immediately afterward.
- Telemetry is re-identified after login.

### 2. Getting Started tab

`ui/App.tsx:163-201`

- On first run, the app creates a `getting-started` tab when none of three local flags are set.
- State is represented by separate `localStorage` keys and later copied to SQLite by `ui/hooks/useAppStatePersistence.ts`.
- The app does not select a path based on acquisition source, role, job-to-be-done, or starting point.

### 3. Two-step checklist

`ui/components/Onboarding/OnboardingView.tsx`

1. **Setup Your Agents** dispatches a generic chat prompt.
2. **Complete First Task** dispatches another generic prompt asking the agent to help or build an app.

Both steps are marked complete two seconds after the chat is created, regardless of whether:

- the message was delivered,
- the agent responded,
- onboarding questions were answered,
- a tool succeeded,
- an artifact was created,
- the user inspected the result, or
- the result was useful.

The sidebar duplicates this behavior in `ui/components/Sidebar/OnboardingCard.tsx`.

### 4. Agent-led interview

`src/resources/workspace-templates/ONBOARD.md` and `src/core/agents/SystemPrompt.ts:396-403`

- If `ONBOARD.md` is pending, the system prompt tells Pen to perform onboarding before responding to any other request.
- The script asks 3–5 profile and workflow questions, updates multiple workspace files, installs/configures features, creates starter automation, writes a summary document, and renames the onboarding file.
- This can ultimately create strong personalization, but it is a large upfront commitment before the user has received proof of value.

### 5. Generic chat empty state

`ui/components/Chat/WelcomeMessage.tsx`

- The empty state displays four starter ideas.
- The buttons have no click handlers, so they look actionable but do nothing.
- The prompts are feature examples rather than a coherent intent-to-outcome path.

### 6. Telemetry

`src/core/telemetry/events.ts`, `ui/lib/telemetry.ts`, and gateway services

- Paprwork tracks authentication, onboarding, chat, tool, job, app, and plan events.
- Packaged builds default telemetry on; development builds default it off.
- Existing onboarding events measure checklist interaction, not validated value.
- `OnboardingCompletedProperties` defines duration and completed-step properties, but `OnboardingView` emits completion with an empty property object.
- `ONBOARDING_STEP_VIEWED` exists in the registry but is not emitted by the onboarding view.

---

## PLG scorecard

| Principle | Current assessment | Evidence / implication |
|---|---|---|
| Continue the signup promise | Weak | Auth and first-run copy are generic; acquisition intent is lost. |
| Segment by job-to-be-done | Missing | Every user receives the same two steps and interview. |
| Optimize for first value | Critical gap | Completion is a timer after click, not an outcome. |
| Front-load value | Weak | A 3–5 question interview is mandatory before another request is handled. |
| Teach through doing | Partial | Onboarding uses chat and can take action, but begins with setup rather than the requested job. |
| Opinionated first session | Partial | There is a fixed sequence, but “help me or build an app” is too broad to be useful. |
| Empty states as launchpads | Broken | Welcome cards look interactive but have no handlers. |
| Standalone utility | Strong foundation | The agent, files, research, documents, jobs, and mini-apps can all create single-player value. |
| Atomic network | Premature for first value | Team invites live in settings and sharing exists, but collaboration is not yet part of a coherent value loop. |
| Hard-side support | Opportunity | Builders who create reusable jobs/apps are likely the supply side and need templates, examples, and reliable publishing. |
| Behavior-triggered support | Weak | Local checklist flags drive UI; actual user and agent state do not. |
| Repeat value | Missing | Onboarding ends after two dispatched prompts; no return trigger is required. |

---

## Product diagnosis

### The checklist measures fiction

The event named `paprwork_onboarding_step_completed` currently means “the user clicked and two seconds passed.” This cannot be used to learn whether onboarding causes retention. It will overstate activation, hide execution failures, and make funnel optimization misleading.

### The interview asks for trust before earning it

The onboarding script is thoughtful, but it asks a new user to explain their role, tools, repetitive work, preferences, and goals before Paprwork has demonstrated competence. For a horizontal AI workspace, this is a high-uncertainty moment: users often do not yet know what information is relevant or what the product can reliably do.

Paprwork should learn through the first task, then ask only the next question needed to improve the result. Rich profile setup should remain available as an explicit “Personalize Pen” path after the first win.

### The product's strongest differentiator appears too late

A generic chat response is not Paprwork's best proof. The product is differentiated when Pen uses tools to produce persistent work: a document, mini-app, automation, structured memory, or completed action. The first session should surface that distinction quickly.

### State and instrumentation are implementation-centric

Current state describes UI steps (`step1`, `step2`, `dismissed`) rather than user progress (`intent selected`, `first result created`, `result inspected`, `return trigger established`). This makes the experience difficult to personalize or resume accurately.

---

## Activation model

### Recommended activation event

An account is **activated** when, within seven days of signup:

1. the user gives Pen a real intent or source artifact,
2. Pen successfully completes at least one meaningful tool-backed workflow,
3. a durable result is created or a real external/local action is completed, and
4. the user inspects, opens, saves, runs, or otherwise acknowledges that result.

Qualifying results can include:

- a document created and opened,
- a mini-app created and launched,
- a job created and successfully run,
- an imported artifact analyzed with a saved output,
- a structured memory/schema populated and subsequently used, or
- another product-specific action with a verifiable success state.

A chat response by itself should be a leading indicator, not the primary activation event.

### Repeat value

A user reaches **repeat value** when they do one of the following within seven days of activation:

- return and complete a second meaningful workflow,
- run or receive output from a saved job,
- reopen/use a created mini-app,
- continue work on a durable artifact, or
- receive a contextual collaborator interaction.

### North-star onboarding metrics

1. Qualified signup → activation rate
2. Median and P75 time from authentication to activation
3. Activation → repeat-value rate within seven days
4. D7 and D30 retained usage, split by activated vs. non-activated cohorts
5. Successful result rate by onboarding intent and starter

Guardrails: failed tool rate, permission abandonment, support contacts, output-quality feedback, unwanted sharing, and onboarding dismissal without value.

---

## Target first-session experience

### Stage 0: Continue the promise

The authentication screen should state a concrete promise and expected time:

> **Turn a task into working software, an automation, or a finished artifact—with an agent that can use your computer.**  
> Choose a starting point and get a useful result in about five minutes.

If Paprwork controls download or campaign links, pass a privacy-safe `entry_intent` into the desktop app so the first screen can continue the originating promise.

### Stage 1: Choose the outcome

Ask one question:

> **What should Pen help you finish first?**

Recommended initial paths:

1. **Finish work now** — research, analyze, write, or organize an artifact.
2. **Build a tool** — create a small app for a workflow.
3. **Automate repeated work** — create and test a scheduled or on-demand job.
4. **Personalize Pen** — complete the richer interview and workspace setup.

Also offer **Use an example** for users without a task ready.

Do not ask role, industry, company size, or communication style yet unless the answer immediately changes the selected workflow.

### Stage 2: Choose a starting point

Depending on intent:

- Describe the desired outcome in one sentence.
- Drop a file or choose an existing file.
- Start from a tested template.
- Try a safe sample workspace with representative data.

Show what will happen, what access may be needed, and the expected time.

### Stage 3: Complete real work

Open chat with a structured, editable brief—not a hidden generic prompt. Pen should:

1. restate the outcome,
2. ask at most one blocking question at a time,
3. create a plan only when the work warrants it,
4. take action,
5. surface progress and permission requests clearly, and
6. produce a durable result.

The pending `ONBOARD.md` rule must not override the user's selected outcome. Instead, the system should capture explicit profile signals from the work and offer deeper personalization after value.

### Stage 4: Inspect the proof

Open the result automatically in the correct Paprwork surface:

- launch a mini-app,
- open the document,
- show the first successful job output,
- display the analysis next to its source, or
- show what memory/context was saved and how it changed the result.

Ask one lightweight question:

> **Is this useful enough to keep?**

This supplies a quality guardrail that mere creation events cannot provide.

### Stage 5: Recommend one next action

Choose one context-specific action:

- **Make it recurring** for a workflow that can become a job.
- **Use real data** if the user started with an example.
- **Personalize Pen** using facts already learned.
- **Share this result** when another person's action completes the job.
- **Do another task like this** to reinforce the core habit.

### Stage 6: Establish a return trigger

Before declaring onboarding complete, create a credible reason to return:

- a scheduled run,
- a follow-up reminder,
- a saved starter/template,
- a monitored data source,
- an assigned task, or
- a collaborator response.

This should be optional when it does not fit the job; it must not become another artificial checklist item.

---

## Cold Start and growth-loop application

Paprwork should follow **come for the tool, stay for the network**.

### Standalone value first

The first user must be able to create useful work without inviting anyone. Paprwork already has unusually strong single-player utility, so forcing team setup early would weaken onboarding.

### Likely hard side

The likely supply-side users are builders who create high-quality jobs, agents, templates, and mini-apps that others can reuse. Support them with:

- reliable starter templates,
- sample data,
- creation quality checks,
- fast publish/install paths,
- clear privacy and permission previews, and
- feedback on reuse and successful outcomes.

### Atomic network

The smallest valuable network is not “a workspace with several invited people.” It is:

> **one creator + one relevant recipient + one shared result that the recipient can use or act on**

Examples:

- an operator publishes a mini-app and a teammate uses it,
- an analyst shares a finding and an owner responds,
- a builder publishes an installable app and another Paprwork user forks it.

Collaboration prompts should appear only after a shareable object exists and should carry the exact object, context, expected action, and recipient value.

### Primary growth loop

1. A user asks Pen to solve a real problem.
2. Pen creates a durable tool, automation, or artifact.
3. The user gets value and optionally publishes or shares it.
4. A recipient uses, responds to, or installs the result.
5. The recipient enters with context and reaches value faster.
6. Reuse and feedback improve the starter available to future users.

Community templates can seed this loop, but template installation should be judged by successful outcomes—not install count.

---

## Phase 1: fix truth and time-to-value

**Goal:** A new user can produce and inspect one useful result in under five minutes, and telemetry can prove it.

### Product changes

1. Replace the two-step checklist with the four outcome cards above.
2. Make the existing welcome cards actually dispatch editable starter prompts, or replace them with the same shared starter component.
3. Make onboarding non-blocking: stop forcing the interview before the user's selected task.
4. Convert the full interview into the explicit **Personalize Pen** path and a post-value recommendation.
5. Open the resulting artifact automatically and show a context-specific next action.
6. Keep an escape hatch: **Skip and start a blank chat**.

### State changes

Replace raw UI flags with a versioned onboarding state machine:

```ts
type OnboardingStage =
  | "not_started"
  | "intent_selected"
  | "work_started"
  | "result_created"
  | "result_inspected"
  | "activated"
  | "dismissed";

interface OnboardingProgress {
  version: 2;
  stage: OnboardingStage;
  intent?: "finish_work" | "build_tool" | "automate_work" | "personalize";
  starterId?: string;
  resultType?: "document" | "app" | "job" | "analysis" | "action";
  resultId?: string;
  startedAt?: string;
  activatedAt?: string;
}
```

Persist this in the existing app-state/SQLite path, with local storage only as a migration bridge. Actual gateway success events should advance state.

### Instrumentation

Add or normalize these events without collecting prompt content:

| Event | Required properties |
|---|---|
| `paprwork_onboarding_viewed` | `state`, `entry_source`, `onboarding_version` |
| `paprwork_onboarding_intent_selected` | `intent`, `starter_id`, `used_example` |
| `paprwork_onboarding_work_started` | `intent`, `starter_id`, `seconds_since_auth` |
| `paprwork_onboarding_blocked` | `stage`, `reason`, `permission_type?`, `integration_type?` |
| `paprwork_onboarding_result_created` | `intent`, `result_type`, `seconds_since_auth`, `tool_count`, `had_retry` |
| `paprwork_onboarding_result_inspected` | `result_type`, `seconds_since_result` |
| `paprwork_activation_reached` | `intent`, `result_type`, `seconds_since_auth`, `used_example` |
| `paprwork_result_quality_feedback` | `result_type`, `useful` |
| `paprwork_repeat_value_reached` | `activation_age_hours`, `repeat_type` |
| `paprwork_contextual_share_started` | `result_type`, `share_type` |
| `paprwork_share_recipient_activated` | `result_type`, `share_type`, `hours_since_share` |

Keep existing low-level events for diagnosis, but do not call checklist clicks “completed.” Record them as selected/started.

### Tests

Add tests for:

- first-run routing after signup,
- each intent starter,
- starter prompt dispatch,
- example data path,
- interruption and resume,
- permission denial and recovery,
- execution failure without false completion,
- activation only after result creation plus inspection,
- event payloads and deduplication,
- migration from the three current local-storage keys,
- screen-reader and keyboard behavior for outcome cards, and
- a packaged-build E2E path from auth callback to first artifact.

---

## Phase 2: improve quality and compounding value

1. Personalize starters by acquisition source and observed first-task signals.
2. Add tested examples/templates for the three main outcome paths.
3. Recommend jobs, memory, specialist agents, or apps only after the initial task demonstrates fit.
4. Add behavior-triggered recovery for failed import, denied permission, abandoned generation, and uninspected results.
5. Add contextual sharing/publishing after a successful result.
6. Measure recipient activation and template outcome quality.
7. Validate which activation definition best predicts D30 retention using cohort analysis.

---

## Experiment sequence

Do not begin with cosmetic A/B tests. Fix event truth first.

1. **Completion integrity:** backend-confirmed result vs. timer-based completion. Success = trustworthy funnel and lower false activation.
2. **Value before interview:** intent-led task first vs. mandatory profile interview. Success = higher activation and lower time-to-value without lower result usefulness.
3. **Example vs. blank input:** tested example offered alongside real input. Success = higher activation for users arriving without a ready task; guardrail = conversion to real data.
4. **Three outcome starters:** compare activation and retained usage by intent; do not optimize merely for click-through.
5. **Post-value personalization:** offer profile setup after useful result. Success = higher profile completion without harming first-value rate.
6. **Contextual share:** share after result vs. no prompt. Success = recipient activation, not invites sent.

---

## Repository implementation map

| Area | Files |
|---|---|
| Authentication promise and entry source | `ui/components/Auth/AuthWall.tsx`, Papr auth callback/start-login services |
| First-run routing | `ui/App.tsx`, `ui/components/Layout/ContentArea.tsx` |
| Main onboarding UI | `ui/components/Onboarding/OnboardingView.tsx` and CSS |
| Sidebar/resume surface | `ui/components/Sidebar/OnboardingCard.tsx` and CSS |
| Chat empty state/starters | `ui/components/Chat/WelcomeMessage.tsx`, `ui/components/Chat/MessageList.tsx` |
| Shared prompts | `ui/constants/onboardingMessages.ts`, `ui/utils/startOnboardingChat.ts` |
| Persistence/migration | `ui/hooks/useAppStatePersistence.ts`, app-state gateway/storage types |
| Agent behavior | `src/core/agents/SystemPrompt.ts`, `src/resources/workspace-templates/ONBOARD.md` |
| Result success signals | `src/gateway/services/AppService.ts`, `src/gateway/services/JobsService.ts`, document/chat/tool completion paths |
| Telemetry definitions | `src/core/telemetry/events.ts`, `ui/lib/telemetry.ts`, gateway telemetry calls |
| Existing memory setup fallback | `ui/components/Memory/MemorySetupPanel.tsx`, `ui/utils/memoryWorkspaceHealth.ts` |

---

## Decision summary

- **Do:** optimize for one inspected, durable result.
- **Do:** let users choose an outcome and start with minimum input.
- **Do:** infer and progressively request profile context from real work.
- **Do:** use real execution state to drive onboarding and analytics.
- **Do:** introduce sharing only in the context of a completed result.
- **Do not:** treat a chat dispatch, checklist click, invite, or account setup as activation.
- **Do not:** require a broad interview before earning trust.
- **Do not:** build a larger checklist; build a shorter path to proof.

## Proposed Phase 1 acceptance criteria

- A new authenticated user can choose an intent within one screen.
- Every visible starter card performs an action and has keyboard-accessible behavior.
- At least one example path can create and open a useful result in under five minutes on a clean packaged install.
- Onboarding cannot reach `activated` when the agent or tool fails.
- Activation is emitted once per onboarding version with accurate elapsed time and result type.
- The user can skip onboarding and later resume without losing progress.
- The mandatory interview no longer overrides an explicit first task.
- Product analytics can compare activation and repeat value by intent, starter, source, app version, and platform without collecting content.
