# Per-Chat Model Controls (Thinking, Fast, Context, Effort)

**Added:** 2026-09-07

## Why

Four things decide what a turn costs, and none of them were reachable from the
composer:

1. **Context** was whatever the model advertised. On a 1M-window model the
   history budget computes to ~636K tokens, and everything inside that budget is
   re-sent on **every step** of a turn that can run to 100 steps. Anthropic
   dropped the >200K surcharge in March 2026, so the window is not a price
   *tier* — but input is billed per token, so it is a spend dial regardless.
   Console usage for Sep 2–6 shows the overwhelming majority of tokens in the
   `200k – 1M` bucket.
2. **Effort** was expressed by shipping a *separate model per level*.
   `gpt-5-6-sol-low` / `gpt-5-6-sol` / `gpt-5-6-sol-high` are one API model with
   three `reasoning.effort` values, and the picker listed all three as if they
   were different models.
3. **Thinking** could not be turned off at all, even on the providers whose
   request has a real off switch.
4. **Fast** (Anthropic, ~2× rate) was not exposed anywhere.

## The rule that shapes the UI

**A row appears only when the request can actually carry it.** A switch wired to
nothing is worse than no switch, so capability is derived from the model rather
than hand-listed per control (`ui/constants/modelControls.ts`):

| Control  | Offered when |
|----------|--------------|
| Thinking | Provider has a real off switch: Anthropic `thinking: {type:"disabled"}`, Google zero budget, Ollama `think: false`. **Not** OpenAI — reasoning is intrinsic there and effort is the only dial. |
| Fast     | Anthropic **and** Opus-5 class **and** API key. pi-ai has no `speed` parameter, so it is hidden on OAuth. Labeled `2× cost`. |
| Context  | More than one option fits inside the model's own window. |
| Effort   | Provider carries a reasoning-effort field **and** thinking is on. On Anthropic, additionally only the *adaptive*-thinking models — see below. |

### Anthropic effort is an adaptive-thinking field

`effort` lives on Anthropic's adaptive thinking surface. The budget-thinking
models (Sonnet 4.6, Haiku 4.5, Opus 4.6) take `{type: "enabled", budgetTokens}`
and have no effort field, so offering the row there would send a parameter the
request cannot carry. Both the UI gate and the gateway gate call the *same*
predicate — `anthropicModelUsesAdaptiveThinking` — rather than mirroring a list.
`max` is offered only on Fable and Opus 5, matching the gateway's own
`xhigh -> max` promotion; Sonnet 5 tops out at `high`.

### `thinkingBudget: 0` cannot mean "thinking off"

Opus 5 and Fable 5.1 ship `defaultThinkingBudget: 0` and still think
adaptively. So the off state is its own field — `AgentConfig.thinking?: false`,
only ever `false`, absent meaning "provider default". Overloading the budget
would have silently disabled reasoning on exactly the models people reach for it
on.

## Context is a cap, never a widener

`resolveEffectiveContextWindow` takes `min(modelWindow, max(userCap, 128K))`:

- Asking for 1M on a 200K model does not widen anything.
- The 128K floor exists because a turn carries ~86K of tool schemas before any
  conversation; a cap below that leaves no room for the history it is meant to be
  budgeting and every turn would trim to the 8K floor.

Options are **200K / 400K / 1M, defaulting to 200K**. Defaulting low is the part
that saves money.

## Picker collapse

Effort variants are packaging, not models. `EFFORT_VARIANT_MODELS` unpacks each
retired id into `{ modelId, effort }`, so a chat pinned to `gpt-5-6-sol-high`
keeps running at high effort after the picker stops listing it as its own row.
The picker drops from ~11 rows to ~7.

Migration runs on two paths: `migratePickerModelId` for the visible list, and
`adoptEffortFromVariant` for a chat's stored settings.

## Persistence

`ui/utils/chatModelSettings.ts`, same shape as `chatModelMemory`: per-`chatId`,
bounded LRU, plus a separate `NEW_CHAT_DEFAULT_KEY` for what a *new* chat
starts on. Per Issue 74, a read for a specific chat never falls back to the
global value — that is how a previous chat's model leaked across chats.

Settings are forgotten on chat delete (`useChat`) and carried across the
temp→permanent id rename (`chatStore.migrateChatId`).

## Files

**New:**
- `ui/constants/modelControls.ts` — capability derivation, variant unpacking, context table
- `ui/utils/chatModelSettings.ts` — per-chat persistence
- `ui/utils/buildAgentConfig.ts` — single place that turns model + settings into `AgentConfig`
- `ui/components/Chat/ModelSettingsPopover.tsx` / `.css` — the popover
- `ui/components/Chat/ModelSettingsButton.tsx` — the composer pill
- `tests/model-controls.test.ts` — 40 tests

**Changed:**
- `src/core/types/agents.ts` — `contextLimit`, `thinking?: false`, `speed`
- `src/gateway/services/agent/contextBudget.ts` — `resolveEffectiveContextWindow`
- `src/gateway/services/AgentService.ts` — honour all four on the AI SDK route
- `src/gateway/services/providers/piAiAnthropicAdaptiveThinking.ts` — off switch on the OAuth route
- `ui/constants/modelPicker.ts` — collapse + migration
- `ui/components/Chat/{ChatContainer,InputBar,ModelPickerDropdown}.tsx`

## Drift guards

Two copies exist for build reasons and both are pinned by tests:

- `MODEL_CONTEXT_WINDOWS` restates the gateway's `ModelFallback` because the
  renderer cannot import that module (its relative imports carry `.js`
  specifiers Vite will not resolve back to `.ts`). A test asserts every entry
  equals `ModelFallback.getModelInfo(id).contextWindow`.
- The Anthropic effort gate is asserted on both sides against the same model
  lists.

## Prevention

Do not express a parameter as a separate model id — the picker then advertises
packaging as capability, and the parameter stays unreachable. Do not overload a
numeric default (`0`) to mean "off" when a provider already uses that value as a
real default. And before wiring a control, check the SDK actually accepts the
field: a toggle whose value is silently dropped is worse than no toggle.
