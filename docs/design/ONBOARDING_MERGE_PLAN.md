# Onboarding Merge Plan

Decisions and sequencing for merging the onboarding redesign into the desktop app.
Companion to `PLG_ONBOARDING_AUDIT.md`.

---

## 1. Connect AI pre-auth, with a deliberate skip

Move Connect AI into the pre-auth gate so every new user hits the same flow.
Skip stays possible, but **skip cost scales with how deep the user is**:

| Surface | Skip affordance |
| --- | --- |
| Card view (provider list) | `Skip for now` — plain text link, always visible |
| Claude detailed setup (stepper) | **No skip link.** Only `Back to options` |
| Back on card view after a failed attempt | `Continue without AI models` + one-line consequence |

A user who never tried leaves in one click. A user mid-stepper cannot fat-finger
out — they must step back first, which is the explicit choice we want. No modal,
no "are you sure?" confirm. We remove the exit from the screen where accidental
exits happen, rather than adding friction everywhere.

**Required details**

- **Persist the skip** as `modelSkippedAt`. Today we cannot distinguish "skipped"
  from "never reached" in the funnel — these are very different signals.
- **Escape hatch inside the stepper.** If Claude OAuth hangs, the stepper must
  still surface `pasteToken` and "Use an API key instead". Dead-ending a user
  with no exit is worse than an easy skip.

**Structural note.** The gate grows from 2 screens to 3. `AuthWall.tsx` is
~460 lines with four `useEffect` timer blocks and its own state machine. Add a
small `<AuthFlow>` host that owns the stage machine, with `AuthWall` /
`OrgSetup` / `ConnectAI` as presentational children — rather than adding a third
state machine to that file.

---

## 2. Onboarding progress state — keep localStorage

**Decision: keep localStorage. No server-state migration.**

The phase machine is pure UI progress. The values that genuinely must survive a
device change — `paprConnected`, `modelConnected` — are *already* re-derived from
server truth on mount via `checkLoginStatus()` and `getStatus()`/keys.
localStorage is a cache of something we recompute anyway.

Moving it server-side buys a migration, an IPC surface, and a sync failure mode
in exchange for approximately nothing.

The one real gap — "how many users drop at connect_model" — is an analytics
question, answered by §4, not by app state.

---

## 3. Recommendations

Ported as discussed. No changes from the audit.

---

## 4. Amplitude → PostHog

### What is actually wired (verified)

There is **no Amplitude SDK in this repo.** No dependency in `package.json`, no
client library. The real path is:

```
trackEvent() → POST https://memory.papr.ai/v1/telemetry/events → [vendor, server-side]
```

`TelemetryClient.ts` states it directly: *"POST anonymous events to Papr's proxy
(Amplitude key server-side only)."* The matches for "amplitude" in this repo were
**naming only** — the `AmplitudeEvents` const map. No vendor coupling in the client.

### Consequence

**The desktop app does not need to change to move to PostHog.** Point the proxy
at PostHog, or dual-write during cutover. Ships as a server config change — no
app release, no version-gated gap in event history.

### Repo-side work (small, already done — see Status)

- **`AmplitudeEvents` → `TelemetryEvents`.** Mechanical rename, 17 references.
  Removes the misleading vendor name. Isolated commit.
- **`PAPRWORK_TELEMETRY_URL` already exists** (`telemetryEnv.ts`) and overrides the
  base URL. That is the "new instance" lever — point a build at a separate
  PostHog project with no code change.

### On "a new instance for onboarding"

**Recommend against a separate instance.** The onboarding funnel crosses the auth
boundary: `auth_wall_viewed` → `org_setup_*` → connect AI → first intent. Split
across two projects and the one funnel that matters cannot be built.

Use **one new PostHog project for all of Paprwork**, with onboarding as a named
funnel inside it. The Amplitude mess is a data-hygiene problem — fixed by not
importing the old events, not by fragmenting the new ones.

### Redesign the event shape while we are here

The current step union is 26 flat step names on one event — precisely how
Amplitude got messy. Model onboarding as:

- `stage` — `auth` | `org` | `connect_ai` | `recommend`
- `outcome` — `viewed` | `completed` | `skipped` | `failed`

Four clean funnel steps with drill-down, instead of 26 strings to memorize.

---

## Bug found: manual-code fallback was a type error

`AuthWall.tsx` called four steps missing from the `PaprLoginStep` union:

```
manual_code_submitted   manual_code_success
manual_code_failed      manual_code_error
```

**Confirmed real** — `npx tsc -p ui/tsconfig.json --noEmit` reported four
`TS2345` errors at `AuthWall.tsx:263,270,273,278`.

**Root cause:** `build:ui` is `cd ui && vite build` — esbuild transpiles without
typechecking, and no `typecheck` script exists in `package.json`. `ui/` is
excluded from the root `tsconfig.json` (`include: ["src/**/*"]`), so nothing in
the build pipeline ever typechecks the renderer. The UI currently has **357
standing type errors**, so these four were invisible in the noise.

**Correction to an earlier claim:** these events were *not* missing from
analytics. `trackEvent` accepts `keyof typeof TelemetryEvents | string` and
forwards `step` in the properties bag; `sanitizeTelemetryProperties` is a
PII blocklist, not an allowlist. The events **were reaching the proxy fine.**
The bug was type-safety only — the union had drifted from its call sites, so it
no longer protected against typos in the funnel. Lower severity than first
stated, still worth fixing before relying on the funnel.

---

## Sequencing

Land before redesign work, so the funnel is trustworthy when measurement starts:

1. **PR 1 — union fix.** Add the four `manual_code_*` steps. ✅ done
2. **PR 2 — rename.** `AmplitudeEvents` → `TelemetryEvents`, 17 refs. ✅ done
3. **PR 3 — typecheck script.** Add `"typecheck": "tsc -p ui/tsconfig.json --noEmit"`.
   Cannot gate CI at 357 errors; add as an advisory script now, ratchet later.
   **Not done — needs a decision on the ratchet strategy.**
4. Then: PostHog project + proxy cutover (server-side), event reshape, §1 gate work.

---

## Status

| Change | State | Verification |
| --- | --- | --- |
| `manual_code_*` added to `PaprLoginStep` | ✅ done | ui tsc: 4 `manual_code` errors → 0 |
| `AmplitudeEvents` → `TelemetryEvents` (17 refs) | ✅ done | 0 refs remain; gateway tsc + ui tsc clean for symbol |
| Net UI error count | 361 → 357 | exactly the 4 fixed, no collateral |
| `typecheck` npm script | ⬜ not started | needs ratchet decision |
| PostHog proxy cutover | ⬜ server-side | not a repo change |

Both edits are staged but **not committed** — the working tree already had ~24
unrelated modified files before this work, so review the telemetry files in
isolation before committing.
