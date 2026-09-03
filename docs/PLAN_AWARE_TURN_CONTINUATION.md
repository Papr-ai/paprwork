# Plan-Aware Turn Continuation

**Added:** 2026-09-03

Fixes turns that report "Finished Working" while the active plan still has
pending steps.

## Symptom

A turn runs 6–77 tool calls, ends with a sentence that announces the *next*
action, and the UI shows the turn as finished. The plan sits at 0/7 with step 1
still "In Progress". On the next message the model appears to have lost context —
it re-derives state it already established.

## Evidence

From production logs (54 turns), 9 ended with plan steps outstanding. The
gateway's own diagnostic already named it:

```
"activePlans":1,"activePlanPendingSteps":2,"trailingTextAfterTools":true,
"postStreamWrapUp":"trailing_text_after_tools",
"likelyCause":"model_stop_with_pending_plan_steps (not gateway wrap-up)"
```

Every one had `reason:"model_stop"` and `modelFinishReason:"stop"` — no step
limit, no token cap, no abort. The trailing text was consistently a preamble,
not a conclusion:

| Model | Pending | Trailing text |
|---|---|---|
| fable-5 | 2 | "…Now let me survey the training ma…" |
| fable-5 | 1 | "Now let me see how the v56a launcher invokes `autonomous_loop`…" |
| fable-5 | 1 | "Let me pull the actual μ numbers…" |
| opus-5 | 4 | "Running the apply now. I'll stage it: **nodes first**…" |

## Root cause

The turn-end decision was binary, and both outcomes end the turn:

1. **Terminal wrap-up.** When the sequence ended on a tool call with no text,
   the gateway injected `WRAP_UP_AFTER_TOOLS_NO_TEXT` — *"This turn is complete
   … do not call tools."* It fired regardless of plan state, so on the opus-5
   turn above the gateway itself converted 4 pending steps into a report of
   completion. The "finished" claim was the gateway's, not the model's.

2. **Silent skip.** Any trailing text at all returned
   `skipReason: "trailing_text_after_tools"` and nothing happened — 47 of 54
   turns. A mid-work preamble is indistinguishable from a closing summary under
   that rule.

Plan state was already queried at turn end, but only for the log line:
*"Plan lookup is best-effort for diagnostics only."*

The apparent context loss is a consequence, not a separate bug. A turn that ends
narrating intent leaves a history saying "I'll do X next" with no evidence X
happened, so the next turn re-derives state. Plan context itself was verified
correct: `loadActivePlansContext` runs on both routes and injects step status
icons, progress counts, and "continue where you left off."

## Fix

The decision is now three-way — `wrap_up`, `continue`, or `none` — in
`src/gateway/services/agent/turnContinuation.ts`.

| Pending steps | Turn ended | Action |
|---|---|---|
| 0 | on a tool, no text | `wrap_up` (terminal — unchanged) |
| 0 | with text | `none` (unchanged) |
| > 0 | either | `continue` (tools stay on) |
| > 0 | text hands off to user | `none` |
| > 0 | budget spent, no text | `wrap_up` (states what remains) |

Three properties matter:

- **Continuation is gated on an active plan.** No plan means no reliable signal
  that work remains, so those turns behave exactly as before. This bounds the
  blast radius to plan-driven work.
- **The terminal wrap-up can no longer fire over pending steps.** It is replaced
  by `WRAP_UP_WITH_PLAN_INCOMPLETE`, which asks for what was done, what is
  outstanding, and what is needed — and forbids claiming completion.
- **Handoffs are respected.** `trailingTextAwaitsUser` inspects the last 400
  characters for a trailing question mark or an approval phrase ("for your
  approval", "say the word", "your call", "tell me which"). A question early in
  a long report does not count; a question at the end does. Without this, a turn
  ending "Tell me which, and whether you want the gate-3 graft before launch"
  would be steamrolled.

The nudge names the next pending step, requires `update_plan`, forbids
re-summarizing or creating a new plan, and leaves an explicit escape hatch:
*"If you truly cannot proceed without a decision from the user, ask one direct
question and stop."* Without that hatch the model would loop against a real
blocker until the budget ran out.

Bounded at `MAX_PLAN_CONTINUATIONS_PER_TURN = 2`.

## Where continuation happens

**pi-ai (OAuth) — in-loop.** `createPiCodexStreamWithToolLoop` takes a
`resolveModelStop` callback, consulted at the `model_stop` exit. Returning a
nudge appends the assistant's own closing message (so the resumed step can see
what it just said), pushes the nudge, and does `continue stepLoop`. Because it
resumes the existing loop, every budget already in place — step limit, memory
checks, token accounting, repetition detection — keeps applying, and the whole
turn stays one assistant message and one UI card.

The callback lives in `AgentService` so the provider layer stays free of
`PlanService`.

**ai-sdk — post-stream.** `streamText` owns its tool loop and `stopWhen` is only
consulted after a step that produced tool calls, so a `finishReason: "stop"`
cannot be overridden from inside. `runAiSdkPlanContinuation` instead issues a
fresh `streamText` with the spread options (tools, `stopWhen` and `prepareStep`
intact) and merges the full result via `mergeContinuationIntoState`.

Known limitation, matching the pre-existing wrap-up path: token usage from an
ai-sdk continuation is not merged into the turn's reported usage.

## Files

**Added**
- `src/gateway/services/agent/turnContinuation.ts` — decision matrix, handoff
  detection, nudge builder
- `tests/turn-continuation.test.ts` — 30 tests; the handoff cases use verbatim
  trailing text from the logged failures

**Changed**
- `agent/wrapUpContinuation.ts` — `WRAP_UP_WITH_PLAN_INCOMPLETE`,
  `applyPlanContinuationStep`, `runAiSdkPlanContinuation`,
  `mergeContinuationIntoState`, optional `wrapUpMessage` on both runners
- `providers/PiCodexStreamWithToolLoop.ts` — `resolveModelStop` hook, per-step
  trailing-text tracking, continuation at the `model_stop` exit
- `AgentService.ts` — `loadPendingPlanState`, resolver wiring, plan-aware
  wrap-up wording, ai-sdk continuation loop

## Observability

`[TurnEnd:plan-continuation]` records each resume with chat, step, pending step
count, and which attempt it was. `[TurnEnd]` still carries `activePlans` and
`activePlanPendingSteps`, now re-read after continuation so the numbers reflect
the final state.

A healthy fix shows `activePlanPendingSteps: 0` on turns that previously logged
`likelyCause: "model_stop_with_pending_plan_steps"`.
