# Mini-App Process Isolation

**Status:** fetch-gate and injection fixes shipped unconditionally; origin isolation behind `PAPR_MINI_APP_ISOLATION`, default off pending on-device verification.
**Date:** 2026-09-17

---

## 1. The symptom

With an agent mid-turn, clicking any other tab — an app, a chat, a split view, a brand new chat — took
"forever". The whole window, including the tab bar and the composer caret, stopped responding for
seconds at a time. It did not matter which tab; it did not matter whether that tab had ever been
opened before.

## 2. What we measured

Everything in this section is observed, not inferred.

| Observation | Value |
|---|---|
| `Electron Helper (Renderer)` CPU | 120–166% (more than one core, so several threads busy) |
| Cumulative CPU time | 31m 12s over 75m 51s wall — ~41% of one core sustained, never idle |
| RSS | 464 MB → 615 MB → 730 MB over the same window |
| `sample` call stacks | JS running under `v8::MicrotasksScope::PerformCheckpoint`, deep and repeating |
| Cmd+R | spawned a **new renderer PID** — a full renderer restart, not an HMR reload |

Two things blocked deeper measurement, and both are findings in their own right:

1. **The Electron binary is stripped**, so `sample` gave us native frames and no JS function names.
   We could see *that* JS was looping in the microtask checkpoint; we could not see *which* JS.
2. **CDP could not attach.** Electron is launched with `--remote-debugging-port=9222`, and a running
   Chrome already held 9222. Chromium does not fail loudly when the debugging port is taken — it
   simply does not listen, so the profiler had nothing to connect to. This silently disables
   profiling for anyone who has Chrome open, which is everyone.

## 3. Why one slow mini-app stops the whole window

This is the part that is easy to get wrong, so it is worth stating precisely.

`MiniAppView` renders each app in an `<iframe>` whose `src` points at the local gateway
(`http://localhost:18789/apps/<appId>/index.html`) with `sandbox="… allow-same-origin …"`. The chat
UI is served from the same gateway. **The app and the chat UI are the same origin.**

Per the HTML Standard, documents in the same *agent cluster* share an event loop, and same-origin
documents are placed in the same agent cluster — they must be, because they are allowed to
synchronously script each other ([HTML Standard, agent clusters][html-agents];
[HTML Standard, event loops][html-eventloop]). Chromium implements this by putting them in the same
renderer process on the same main thread ([Chromium process model][chromium-process]).

So: **every mounted mini-app runs its JavaScript on the same main thread as the chat UI.** A `while`
loop, a tight `setInterval`, a runaway promise chain, or a large synchronous parse inside any app
blocks React rendering, the tab bar, and keyboard input for the whole window.

> **A trap worth naming.** web.dev's *Optimize INP* states: *"each browsing context will have its own
> main thread… each `<iframe>` element on the page will have its own main thread as well"*
> ([web.dev][webdev-inp-opt]). That is true for a **cross-site** iframe, which Chromium renders
> out-of-process. It is false for a **same-origin** iframe, which is exactly what we have. A reader
> who takes that sentence at face value concludes our architecture is already isolated and stops
> looking. It is not, and that is the whole bug.

How many apps are on that thread at once? `ContentArea` keeps an LRU warm set of
`max(7, visible + 1)` app tabs mounted so that returning to a tab does not pay a cold reload
(queries, Turso pulls). That is a deliberate and reasonable trade — but it means **up to seven
mini-apps are executing on the chat UI's main thread at any moment**, only one or two of which the
user can see.

## 4. Four defects found in the code

### 4.1 The fetch gate never ran before the app's own scripts

`injectMiniAppPreviewFetchGate` injects:

```html
<script async defer src="/__papr__/papr-preview-fetch-gate.js"></script>
```

The file's own doc comment says *"Inject preview fetch gate before app scripts"*. `async` says the
opposite: fetch in parallel, execute whenever it arrives, in no particular order relative to other
scripts. (`defer` is ignored entirely when `async` is present.) An app whose own script runs first
captures the native `window.fetch`, and every call it makes afterwards bypasses the gate — the gate
replaces `window.fetch`, but the app is no longer reading `window.fetch`. The gate was best-effort
in a way nobody had written down.

### 4.2 The queue was unbounded

```ts
return new Promise((resolve, reject) => {
  queue.push({ run: () => { nativeFetch(input, init).then(resolve, reject); }, reject });
});
```

No cap. A hidden app polling once a second for ten minutes accumulates 600 pending requests, each
holding its closure, its `init`, and its promise callbacks alive. This is a plausible contributor to
the RSS growth we measured, and it grows without limit.

### 4.3 …and it replayed all of them at the worst possible moment

The file header says: *"Stale queued requests are dropped (not flushed) when the tab becomes
visible."* The code says:

```ts
if (type === "papr:preview-visible") {
  phase = "visible";
  flushQueuedFetches();   // replays every queued request
```

Both cannot be true. And flushing fires the entire backlog **at the instant the user activates the
tab** — the one moment they are waiting on that tab to paint. That matches the reported symptom
precisely: the slowness is *worst on tab switch*.

The inline comment defending the flush has a real point, though: a caller that `await`ed a fetch
while hidden expects its promise to settle. Dropping silently leaves an app hanging forever. So
neither "flush everything" nor "drop everything" is right, which is why §6.3 coalesces instead.

### 4.4 Suspension is advisory, and nobody was told about it

`usePreviewTabLifecycle` posts `papr:preview-hidden` to the iframe. That is the entire mechanism. It
pauses `fetch` (see above) and nothing else — not timers, not `requestAnimationFrame`, not compute.
And `grep` finds no mention of `papr:preview-*` in `SystemPrompt.ts` or anywhere in
`src/resources/agent-docs/`, so the agent writing these apps has never been told the protocol exists.

This one cannot be fixed by documentation. An advisory signal to code we generate on the fly, that
users then edit, is not a resource bound. Even a perfectly behaved app that yields its timers still
parses its own JSON on our thread. **The only durable fix is to stop sharing the thread.**

## 5. What the research says

**Same agent cluster, same event loop.** Same-origin documents share an event loop by specification
([HTML Standard][html-agents], [§event loops][html-eventloop]). This is the mechanism in §3; it is
not a Chromium implementation detail we might tune around.

**A separate *site* gets a separate process.** Chromium locks a renderer process to a single *site*,
defined as *scheme plus eTLD+1*, under Site Isolation, which is on by default on desktop
([Chromium process model][chromium-process]). For a host with no registrable domain in the Public
Suffix List — which includes `*.localhost` — the whole host is the site. Two different hosts are
therefore two different sites, and Chromium renders the second one out-of-process (an OOPIF).

**A separate *origin* is only a hint — in a browser.** The `Origin-Agent-Cluster: ?1` response header
requests an origin-keyed agent cluster; browsers *may* honour it with a dedicated process, but
"the browser is under no obligation… and it might not do so for a variety of reasons"
([web.dev][webdev-oac]). Chromium separates the logical keying from process isolation explicitly:
origin-keyed *processes* require the `kOriginKeyedProcessesByDefault` feature, distinct from
`kOriginAgentClusterDefaultEnable` ([Chromium commit 53e24b7][chromium-oac-commit],
[`origin_agent_cluster_isolation_state.cc`][chromium-oac-src]).

> **This is the leverage Electron gives us.** A website can only ask. We ship the browser, so we can
> set `--enable-features=OriginKeyedProcessesByDefault` and turn the hint into a guarantee. Any
> design that works in a browser only by luck works here by configuration.

**The header's effect is observable at runtime.** `window.originAgentCluster` returns whether the
window actually got an origin-keyed agent cluster, and is only ever true in a secure context
([MDN][mdn-oac]). That gives us a verification signal instead of an assumption — see §7.

**`*.localhost` is loopback and is a secure context.** `.localhost` is reserved by
[RFC 6761 §6.3][rfc6761] and resolves to loopback; the Secure Contexts spec treats `localhost` and
anything under `.localhost` as potentially trustworthy ([W3C][secure-contexts]), which is required
for `originAgentCluster` to be true and for the app's own APIs to work.

**The responsiveness target.** Interaction to Next Paint is good at ≤200 ms at p75, and input delay
is caused by exactly the thing we measured: long tasks occupying the main thread when the event
arrives ([web.dev INP][webdev-inp]). Google's INP codelab demonstrates the specific case we have —
a click that lands while a `setInterval` task is running is slow *even though the click handler
itself does no work* ([Codelab][codelab-inp]). The user's stated goal of sub-100 ms interactions is
achievable only if nothing else can occupy the thread at the moment of the click.

## 6. What we are doing

### 6.1 Decision

**Give every mini-app its own origin — `http://app-<appId>.localhost:<port>` — so Chromium renders
it in its own process, and turn on the Chromium feature that makes that guarantee rather than a
hope.** Keep the DOM `<iframe>`.

### 6.2 Why this shape, and what we rejected

| Option | Verdict |
|---|---|
| **Per-app `*.localhost` subdomain** (chosen) | Different host → different site → OOPIF. Zero new servers: `*.localhost` is loopback, so the same Express instance on the same port receives it and routes by `Host`. The app's own `/api/*` calls stay **relative**, so they resolve to the app's *own* origin — same-origin from the browser's point of view, and **no CORS work at all**. |
| Per-app **port** | Rejected. Site is scheme + eTLD+1 and **ignores the port**, so `localhost:18790` is the *same site* as `localhost:18789` and would share the process. This looks like isolation and delivers none. |
| `Origin-Agent-Cluster` alone | Insufficient alone (same-site origins, hint-only), but kept as belt-and-braces: it also blocks `document.domain` from reaching across apps. |
| `WebContentsView` / `<webview>` | Guaranteed isolation plus `setBackgroundThrottling`, but a native view laid over the window — it does not flow in the DOM, so split panes, scrolling, and z-order all become main-process layout problems. Held as the escape hatch if §7 verification fails. |

### 6.3 Changes landing unconditionally (no flag)

These are strict improvements and they address the tab-switch stall directly.

1. **Inline the gate, do not just unblock it.** Dropping `async defer` alone is not enough, and
   *only* dropping it would reintroduce the bug it was added for: #155 added `async defer` because a
   missing SDK bundle made the frame block for ~11 s on a request that would 404. Inlining the
   compiled source into the `<head>` removes both failure modes at once — it runs before any app
   script *and* there is no request to hang on. It also matters more under §6.4 than it did before:
   per-app origins mean a separate HTTP cache per app, so a referenced script is re-fetched once per
   app rather than once. A missing bundle now fails at build time instead of at runtime.
2. **Fold identical requests at enqueue, not at flush.** A poller that calls the same URL 600 times
   while hidden occupies **one** queue entry, and all 600 promises settle from clones of a single
   network call. Folding only at flush would still let the queue grow to 600 entries — so the queue
   is bounded by *distinct* requests, not by call volume, and an app must ask for 64 different things
   while backgrounded to reach the cap. Non-GET requests are never folded: two queued mutations are
   not interchangeable.
3. **Past the cap, stop pausing — never reject.** A distinct request arriving with a full queue runs
   immediately. That is a return to pre-gate behaviour, which every app already copes with. The
   alternative was tried and reverted in the product's own history: v2.6.0 rejected a queue it judged
   stale and v2.6.1 removed that a day later, because *"callers expect these promises to settle on
   return"* — a mini-app awaiting `fetch` has no reason to expect an `AbortError` and hangs or
   crashes on one. Degrading to unpaused is recoverable; a rejection is not. Rejection survives in
   exactly one place, `papr:preview-evicting`, where the frame is going away and a promise that never
   settles would leak the caller's continuation.

### 6.4 Changes behind `PAPR_MINI_APP_ISOLATION` (default off)

4. **Per-app origin.** One source of truth (`src/core/miniApps/miniAppOrigin.ts`, zero imports so the
   renderer can import it too) builds `app-<id>.localhost:<port>` and parses the `appId` back out of a
   `Host` header. The gateway accepts the subdomain and sets `Origin-Agent-Cluster: ?1`.
5. **`--host-resolver-rules=MAP *.localhost 127.0.0.1`** in the main process, so we do not depend on
   OS resolver behaviour — Windows historically did not resolve `*.localhost` even though Chromium
   does. Plus `--enable-features=OriginKeyedProcessesByDefault` per §5.
6. **Same-origin DOM access moves server-side.** Three places in `MiniAppView` reach into
   `iframe.contentDocument` — installing `paprAPI`, forwarding runtime logs, and reading the document
   to tell a booted app from an error page. All three return `null` cross-origin, and they fail
   *silently*: `contentDocument` does not throw, so without this the app would appear to load and
   then do nothing. One injected script (`papr-app-bridge.ts`) now does all three from inside the
   frame and `postMessage`s to the parent, using the same mechanism as the existing
   `injectMiniAppApiErrorFetch` and `injectMiniAppBootWatchdog` injections. The parent keeps its
   `contentDocument` path for the shared origin and waits for the frame's own announcement when
   isolated, so one code path does not have to serve both readings.

### 6.5 The warm set is sized by which deployment you are in

`AppTabKeepAliveHost` keeps recently-used apps mounted so switching back is instant. How many it can
afford depends entirely on §3: **isolated previews cost memory, shared-origin previews cost the main
thread**, and those are not interchangeable budgets.

| | Cap | Why |
|---|---|---|
| Isolated origins | 7 | Each is its own process, so a hidden app's timers cannot delay a click. The only cost is memory, which is bounded by the count. |
| Shared origin | 2 | `display: none` stops `requestAnimationFrame` but **not** timers or promise chains, so every hidden app still competes for the one thread. Keeping 7 is what produced the reported stall. |

In both cases the floor is `max(cap, visibleAppTabCount + 1)` — the panes on screen must stay
mounted, and one hidden tab stays warm beyond them so the common back-and-forth between two apps
does not re-boot on every switch.

### 6.6 Known consequences, stated up front

- **Storage partitions per app.** Today every app shares one origin, so they share one `localStorage`
  — an app can read another app's keys. After isolation each app gets its own, which is the correct
  behaviour, but any app currently keeping state in `localStorage` starts empty. App state that lives
  in SQLite via `/api/db` is unaffected. This is the main reason the flag defaults off.
- **Process count rises.** Seven warm apps become up to seven processes. Each costs memory, but each
  is independently schedulable, independently throttleable, and independently killable — and the
  warm-set bound is what keeps the total finite.

## 7. How we will know it worked

Assumptions in §5 about Chromium's site computation for `*.localhost` are *reasoning*, and reasoning
is not evidence. Before the flag is defaulted on, all three must hold on-device:

1. **`window.originAgentCluster === true`** inside a mini-app frame (MDN's runtime signal). This one
   is wired rather than left to be checked by hand: the bridge reports its own reading in the boot
   announcement and the parent logs a warning when an isolated origin comes back unisolated. The
   three readings are kept distinct on purpose — `true` is isolated, `false` is **refused by the
   browser** (the case §5 warns about), and `undefined` is a frame whose bridge predates the field,
   which is not evidence either way and must not be reported as a refusal.
2. **Process count rises with warm apps.** `ps` shows one additional `Electron Helper (Renderer)` per
   mounted app rather than one total.
3. **A deliberately hostile app does not freeze the window.** An app running
   `while (true) {}` in a `setInterval` must leave the chat UI interactive. This is the acceptance
   test — everything else is a proxy for it.

Ongoing, the existing turn-metrics pipeline is the place to carry an interaction-latency measure so a
regression shows up as data rather than as a bug report.

## 8. Unrelated finding

The **"Publishing paused"** chip seen during this investigation is not a performance symptom. It is
`appCloudSyncStatus.ts` reporting a **quarantined database** — *"Publishing paused — ask the agent to
repair this database"*. Worth checking against the 3-strike crash-streak park added in Issue 84.

---

[html-agents]: https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-cluster-formalism
[html-eventloop]: https://html.spec.whatwg.org/multipage/webappapis.html#event-loop
[chromium-process]: https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md
[webdev-oac]: https://web.dev/articles/origin-agent-cluster
[mdn-oac]: https://developer.mozilla.org/en-US/docs/Web/API/Window/originAgentCluster
[chromium-oac-commit]: https://github.com/chromium/chromium/commit/53e24b7d7bdc2eb29d7482f443189cf6937e42c5
[chromium-oac-src]: https://chromium.googlesource.com/chromium/src/+/141.0.7390.122/content/browser/origin_agent_cluster_isolation_state.cc
[webdev-inp]: https://web.dev/articles/inp
[webdev-inp-opt]: https://web.dev/articles/optimize-inp
[codelab-inp]: https://codelabs.developers.google.com/understanding-inp
[rfc6761]: https://www.rfc-editor.org/rfc/rfc6761#section-6.3
[secure-contexts]: https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy
