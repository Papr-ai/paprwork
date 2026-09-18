/**
 * Mini-app process isolation (docs/MINI_APP_PROCESS_ISOLATION.md).
 *
 * Three things are pinned here:
 *  - origin derivation and its inverse, because the renderer and the gateway
 *    must agree exactly or a request lands on the wrong app;
 *  - the fetch gate's coalescing decision, which is what stops the queued
 *    backlog firing at the moment the user activates the tab;
 *  - structural invariants that a future edit could quietly undo (the gate must
 *    not go back to `async`, the header must still be set).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appIdFromHost,
  miniAppOrigin,
  miniAppOriginHost,
} from "../src/core/miniApps/miniAppOrigin.js";
import {
  coalesceKeyForRequest,
} from "../src/resources/mini-app-sdk/papr-preview-fetch-gate.js";
import { injectMiniAppPreviewFetchGate } from "../src/gateway/utils/injectMiniAppPreviewFetchGate.js";
import { resolveMiniAppIdFromRequest } from "../src/gateway/utils/inferMiniAppIdFromRequest.js";
import {
  miniAppPreviewIsolationEnabled,
  resolveMiniAppPreviewOrigin,
} from "../ui/utils/miniAppPreviewOrigin.js";
import {
  readAppIdFromLocation,
  readOriginAgentCluster,
} from "../src/resources/mini-app-sdk/papr-app-bridge.js";
import {
  describeIsolationOutcome,
  isShellAnnouncementFor,
  miniAppShellLooksLikeError,
  readSameOriginDocument,
} from "../ui/utils/miniAppShellProbe.js";
import {
  MAX_MOUNTED_APP_PREVIEWS,
  MAX_MOUNTED_APP_PREVIEWS_SHARED_ORIGIN,
  effectiveMaxMountedAppPreviews,
  selectMountedAppTabIds,
} from "../ui/utils/appPreviewMemoryPolicy.js";
import type { Tab } from "../ui/types/tabs.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_A = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
const APP_B = "432ed79f-1111-4222-8333-444455556666";

function readSource(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

describe("per-app origin derivation", () => {
  it("gives each app a distinct host under .localhost", () => {
    expect(miniAppOriginHost(APP_A)).toBe(`app-${APP_A}.localhost`);
    expect(miniAppOriginHost(APP_A)).not.toBe(miniAppOriginHost(APP_B));
  });

  it("round-trips the app id through the Host header", () => {
    const host = miniAppOriginHost(APP_A);
    expect(appIdFromHost(`${host}:18789`)).toBe(APP_A);
  });

  it("keeps http so .localhost stays a potentially-trustworthy origin", () => {
    // originAgentCluster is only ever true in a secure context, and *.localhost
    // qualifies over plain http. Switching to https here would need a cert and
    // would buy nothing.
    expect(miniAppOrigin(APP_A, 18789)).toBe(`http://app-${APP_A}.localhost:18789`);
  });

  it("returns null rather than mangling an id that cannot be a DNS label", () => {
    // Null means "serve from the shared origin, unisolated" — a correctness-
    // preserving downgrade. Encoding the id instead would make the host
    // unreadable for no benefit, since ids are UUIDs.
    expect(miniAppOriginHost("has spaces")).toBeNull();
    expect(miniAppOriginHost("under_score")).toBeNull();
    expect(miniAppOriginHost("-leading")).toBeNull();
    expect(miniAppOriginHost("")).toBeNull();
    expect(miniAppOrigin("has spaces", 18789)).toBeNull();
  });

  it("does not read the shared gateway host as an app", () => {
    expect(appIdFromHost("localhost:18789")).toBeNull();
    expect(appIdFromHost("127.0.0.1:18789")).toBeNull();
    expect(appIdFromHost(undefined)).toBeNull();
  });

  it("rejects a host that would parse to an empty id", () => {
    // Without the round-trip check `app-.localhost` yields "" and every
    // downstream lookup then runs against the empty app id.
    expect(appIdFromHost("app-.localhost:18789")).toBeNull();
  });

  it("matches hosts case-insensitively", () => {
    expect(appIdFromHost(`APP-${APP_A.toUpperCase()}.LOCALHOST:18789`)).toBe(APP_A);
  });

  it("strips the port without truncating an IPv6 literal", () => {
    expect(appIdFromHost("[::1]:18789")).toBeNull();
  });
});

describe("preview origin selection", () => {
  const base = { appId: APP_A, host: "localhost", port: "18789" };

  it("stays on the shared origin when the flag is off", () => {
    const resolved = resolveMiniAppPreviewOrigin({ ...base, isolationFlag: "0" });
    expect(resolved).toEqual({ origin: "http://localhost:18789", isolated: false });
  });

  it("uses the per-app origin when the flag is on", () => {
    const resolved = resolveMiniAppPreviewOrigin({ ...base, isolationFlag: "1" });
    expect(resolved).toEqual({
      origin: `http://app-${APP_A}.localhost:18789`,
      isolated: true,
    });
  });

  it("falls back when the gateway is not reached through localhost", () => {
    // There is no .localhost suffix to hang a subdomain off an IP, and
    // inventing one produces a host that does not resolve — a blank iframe
    // rather than a slow one.
    const resolved = resolveMiniAppPreviewOrigin({
      ...base,
      host: "192.168.1.20",
      isolationFlag: "1",
    });
    expect(resolved.isolated).toBe(false);
    expect(resolved.origin).toBe("http://192.168.1.20:18789");
  });

  it("falls back for an id that cannot be a hostname", () => {
    const resolved = resolveMiniAppPreviewOrigin({
      ...base,
      appId: "not a uuid",
      isolationFlag: "1",
    });
    expect(resolved.isolated).toBe(false);
  });
});

describe("fetch gate coalescing", () => {
  it("coalesces repeat GETs of the same URL", () => {
    const a = coalesceKeyForRequest("/api/db/query?x=1");
    const b = coalesceKeyForRequest("/api/db/query?x=1");
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("keeps different URLs apart", () => {
    expect(coalesceKeyForRequest("/api/a")).not.toBe(coalesceKeyForRequest("/api/b"));
  });

  it("never coalesces a mutation", () => {
    // Two queued POSTs are not interchangeable: answering both from one
    // response would silently drop a write.
    expect(coalesceKeyForRequest("/api/db/query", { method: "POST" })).toBeNull();
    expect(coalesceKeyForRequest("/api/x", { method: "post" })).toBeNull();
  });

  it("never coalesces a GET carrying a body", () => {
    expect(coalesceKeyForRequest("/api/x", { body: "{}" })).toBeNull();
  });

  it("never coalesces a request carrying an abort signal", () => {
    // One waiter aborting must not cancel the others.
    const controller = new AbortController();
    expect(
      coalesceKeyForRequest("/api/x", { signal: controller.signal }),
    ).toBeNull();
  });

  it("treats differing headers as different requests", () => {
    // Same URL, different auth, legitimately different responses.
    const a = coalesceKeyForRequest("/api/x", { headers: { "x-key": "a" } });
    const b = coalesceKeyForRequest("/api/x", { headers: { "x-key": "b" } });
    expect(a).not.toBe(b);
  });

  it("ignores header order", () => {
    const a = coalesceKeyForRequest("/api/x", { headers: { a: "1", b: "2" } });
    const b = coalesceKeyForRequest("/api/x", { headers: { b: "2", a: "1" } });
    expect(a).toBe(b);
  });

  it("gives a poller's every call the same identity", () => {
    // The whole point: 600 polls of one URL share a key, so they fold into one
    // queue entry at enqueue and cannot exhaust the cap between them. That
    // folding is asserted behaviourally in tests/papr-preview-fetch-gate.test.ts
    // ("does not spend the queue cap on a poller's own duplicates"); here we
    // only pin that the key is stable, which is what makes it possible.
    const keys = new Set(
      Array.from({ length: 600 }, () =>
        coalesceKeyForRequest("/api/db/query?x=1"),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it("gives every uncoalescable request a null identity", () => {
    // Null means "replay me alone" — never folded, never deduped.
    expect(coalesceKeyForRequest("/api/x", { method: "POST" })).toBeNull();
  });
});

describe("structural invariants", () => {
  it("injects the gate inline, never deferred", async () => {
    // `async defer` runs the script in no defined order against the app's own
    // scripts, so an app that ran first captured the native fetch and never
    // saw the gate. Inlining removes the request entirely — which also keeps
    // #155's requirement that a missing bundle cannot block load.
    const html = await injectMiniAppPreviewFetchGate(
      "<html><head></head></html>",
    );
    expect(html).toContain("papr-preview-fetch-gate.ts");

    // Assert on the tag openings only: the bundled code legitimately contains
    // the word "async", so scanning the whole document would fail on itself.
    for (const tag of html.match(/<script[^>]*>/g) ?? []) {
      expect(tag).not.toMatch(/\basync\b/);
      expect(tag).not.toMatch(/\bdefer\b/);
    }
  });

  it("puts the gate ahead of the app's own scripts", async () => {
    const html = await injectMiniAppPreviewFetchGate(
      '<html><head><script src="/apps/x/index.js"></script></head></html>',
    );
    expect(html.indexOf("papr-preview-fetch-gate.ts")).toBeLessThan(
      html.indexOf("/apps/x/index.js"),
    );
  });

  it("does not inject twice", async () => {
    const once = await injectMiniAppPreviewFetchGate(
      "<html><head></head></html>",
    );
    expect(await injectMiniAppPreviewFetchGate(once)).toBe(once);
  });

  it("does not ship a sourcemap on every app's HTML response", async () => {
    // The prebuild emits inline maps, right for the cacheable /__papr__/ route
    // and wrong for a payload on the critical path of every cold app load.
    const html = await injectMiniAppPreviewFetchGate(
      "<html><head></head></html>",
    );
    expect(html).not.toContain("sourceMappingURL=data:application/json");
  });

  it("caps the queue so a long-hidden app cannot grow memory without bound", () => {
    const source = readSource("src/resources/mini-app-sdk/papr-preview-fetch-gate.ts");
    expect(source).toMatch(/MAX_QUEUED_FETCHES\s*=\s*\d+/);
    expect(source).toContain("queue.length >= MAX_QUEUED_FETCHES");
  });

  it("asks for an origin-keyed agent cluster when served from a per-app host", () => {
    const source = readSource("src/gateway/index.ts");
    const header = source.indexOf('"Origin-Agent-Cluster", "?1"');
    expect(header).toBeGreaterThan(-1);
    // Guarded by hostAppId: setting it unconditionally would key the chat UI's
    // own origin too, which is not what we want.
    const guard = source.lastIndexOf("if (hostAppId) {", header);
    expect(guard).toBeGreaterThan(-1);
  });

  it("refuses to serve one app's files from another app's origin", () => {
    const source = readSource("src/gateway/index.ts");
    expect(source).toContain("App origin does not match requested app");
  });

  it("turns the Origin-Agent-Cluster hint into a guarantee via Chromium flags", () => {
    // A page can only ask; we ship the browser, so we enable the feature that
    // makes origin-keyed *processes* the default rather than a maybe.
    const source = readSource("src/electron/index.cjs");
    expect(source).toContain("OriginKeyedProcessesByDefault");
    expect(source).toContain("MAP *.localhost 127.0.0.1");
    expect(source).toContain('process.env.PAPR_MINI_APP_ISOLATION === "1"');
  });

  it("exposes the isolation flag to the renderer under a VITE_ name", () => {
    // Vite only forwards VITE_-prefixed vars to client code (Issue 64); without
    // the mapping the renderer keeps building same-origin srcs while the
    // gateway serves isolated ones.
    const source = readSource("ui/vite.config.ts");
    expect(source).toContain("import.meta.env.VITE_PAPR_MINI_APP_ISOLATION");
    expect(source).toContain("env.PAPR_MINI_APP_ISOLATION");
  });
});

describe("app identity under per-app origins", () => {
  it("reads the app from the Host header", () => {
    const resolved = resolveMiniAppIdFromRequest(undefined, {
      host: `app-${APP_A}.localhost:18789`,
    });
    expect(resolved.appId).toBe(APP_A);
  });

  it("still reads the app from Referer on the shared origin", () => {
    const resolved = resolveMiniAppIdFromRequest(undefined, {
      host: "localhost:18789",
      referer: `http://localhost:18789/apps/${APP_A}/index.html`,
    });
    expect(resolved.appId).toBe(APP_A);
  });

  it("prefers Host, which a referrer policy cannot suppress", () => {
    const resolved = resolveMiniAppIdFromRequest(undefined, {
      host: `app-${APP_A}.localhost:18789`,
    });
    expect(resolved.appId).toBe(APP_A);
    expect(resolved.error).toBeUndefined();
  });

  it("refuses when Host and Referer name different apps", () => {
    // A request from inside app A's origin claiming to be app B.
    const resolved = resolveMiniAppIdFromRequest(undefined, {
      host: `app-${APP_A}.localhost:18789`,
      referer: `http://app-${APP_B}.localhost:18789/apps/${APP_B}/index.html`,
    });
    expect(resolved.appId).toBeUndefined();
    expect(resolved.status).toBe(403);
  });

  it("refuses when an explicit appId contradicts the Host", () => {
    const resolved = resolveMiniAppIdFromRequest(APP_B, {
      host: `app-${APP_A}.localhost:18789`,
    });
    expect(resolved.appId).toBeUndefined();
    expect(resolved.status).toBe(403);
  });
});

describe("the bridge that replaces contentDocument injection", () => {
  it("knows which app it is from the host under isolation", () => {
    expect(
      readAppIdFromLocation({
        hostname: `app-${APP_A}.localhost`,
        pathname: "/apps/whatever/index.html",
      }),
    ).toBe(APP_A);
  });

  it("prefers the host over the path", () => {
    // Client-side routing can rewrite the path; it cannot rewrite the origin.
    expect(
      readAppIdFromLocation({
        hostname: `app-${APP_A}.localhost`,
        pathname: `/apps/${APP_B}/index.html`,
      }),
    ).toBe(APP_A);
  });

  it("falls back to the path on the shared origin", () => {
    expect(
      readAppIdFromLocation({
        hostname: "localhost",
        pathname: `/apps/${APP_A}/index.html`,
      }),
    ).toBe(APP_A);
  });

  it("reports no app rather than guessing one", () => {
    expect(
      readAppIdFromLocation({ hostname: "localhost", pathname: "/settings" }),
    ).toBeNull();
    // `app-.localhost` carries no id — an empty string would install the bridge
    // under a bogus identity and every invoke would be silently dropped by the
    // parent's appId check.
    expect(
      readAppIdFromLocation({ hostname: "app-.localhost", pathname: "/" }),
    ).toBeNull();
  });

  it("is injected as a blocking script ahead of the fetch gate", async () => {
    // paprAPI must exist before the app's first line (Issue 16). The renderer's
    // copy ran on `load`, after every app script — this one runs during parse.
    const html = await injectMiniAppPreviewFetchGate(
      '<html><head><script src="/apps/x/index.js"></script></head></html>',
    );
    const bridge = html.indexOf("papr-app-bridge.ts");
    const gate = html.indexOf("papr-preview-fetch-gate.ts");
    expect(bridge).toBeGreaterThan(-1);
    expect(bridge).toBeLessThan(gate);
    expect(bridge).toBeLessThan(html.indexOf("/apps/x/index.js"));
  });

  it("is registered in the SDK manifest so its route exists", () => {
    // Routes are auto-discovered from this set; without the entry the injected
    // <script> 404s and paprAPI is undefined again.
    const source = readSource("src/resources/mini-app-sdk/sdk-manifest.ts");
    expect(source).toContain('"papr-app-bridge.ts"');
  });

  it("does not double-install when both paths run", () => {
    // The renderer keeps its same-origin injection for HTML the gateway did not
    // serve. Whichever runs first must win.
    const bridge = readSource("src/resources/mini-app-sdk/papr-app-bridge.ts");
    expect(bridge).toContain("__paprAppBridgeInstalled");
    const view = readSource("ui/components/Apps/MiniAppView.tsx");
    expect(view).toContain("paprAPI) return;");
  });
});

describe("proving the shell loaded without reading its document", () => {
  it("recognises the gateway's not-ready page from either transport", () => {
    // One predicate, two inputs: same-origin read and postMessage announcement.
    // Restating the rule per transport is how the two readings drift apart.
    expect(
      miniAppShellLooksLikeError({ title: "Error", bodyText: "" }),
    ).toBe(true);
    expect(
      miniAppShellLooksLikeError({
        title: "",
        bodyText: `Cannot GET /apps/${APP_A}/index.html`,
      }),
    ).toBe(true);
    expect(
      miniAppShellLooksLikeError({ title: "Audit Workbench", bodyText: "Loading…" }),
    ).toBe(false);
  });

  it("treats a missing signal as neither error nor success", () => {
    expect(miniAppShellLooksLikeError({})).toBe(false);
  });

  it("only accepts an announcement naming this app", () => {
    const announcement = { type: "papr-preview-booted", appId: APP_A, title: "A" };
    expect(isShellAnnouncementFor(APP_A, announcement)).toBe(true);
    expect(isShellAnnouncementFor(APP_B, announcement)).toBe(false);
    expect(isShellAnnouncementFor(APP_A, { type: "papr-runtime-log", appId: APP_A })).toBe(
      false,
    );
    expect(isShellAnnouncementFor(APP_A, null)).toBe(false);
    expect(isShellAnnouncementFor(APP_A, "papr-preview-booted")).toBe(false);
  });

  it("returns null rather than throwing when the document is not ours", () => {
    expect(readSameOriginDocument(null)).toBeNull();
    expect(readSameOriginDocument({ contentDocument: null })).toBeNull();
    expect(
      readSameOriginDocument({
        get contentDocument(): Document | null {
          throw new Error("SecurityError");
        },
      }),
    ).toBeNull();
  });

  it("waits for the announcement instead of erroring when the read fails", () => {
    // Under isolation contentDocument is null on every load. Concluding "this
    // app is gone" from an unreadable document would blank every isolated
    // preview; the bounded wait retries instead (Issue 98).
    const view = readSource("ui/components/Apps/MiniAppView.tsx");
    const onLoad = view.indexOf("onLoad={() => {");
    expect(onLoad).toBeGreaterThan(-1);
    const body = view.slice(onLoad, view.indexOf("onError=", onLoad));
    expect(body).toContain("readSameOriginDocument");
    expect(body).toContain("awaitShellAnnouncement()");
    expect(body).toContain("miniAppShellLooksLikeError");
  });

  it("bounds the wait and retries rather than reporting failure", () => {
    const view = readSource("ui/components/Apps/MiniAppView.tsx");
    const fn = view.indexOf("const awaitShellAnnouncement");
    expect(fn).toBeGreaterThan(-1);
    const body = view.slice(fn, view.indexOf("}, [scheduleIframeRetry]);", fn));
    expect(body).toContain("MINI_APP_SHELL_ANNOUNCE_GRACE_MS");
    expect(body).toContain("scheduleIframeRetry");
  });
});

describe("how many previews stay warm, and what warm costs", () => {
  const appTab = (id: string): Tab =>
    ({ id, type: "app", entityId: id, title: id }) as unknown as Tab;

  it("keeps one warm hidden preview on the shared origin", () => {
    // A hidden same-origin iframe is display:none, which stops rAF but not
    // timers, promise continuations or fetch callbacks — and all of those run
    // on the chat UI's thread. Seven of them is the measured pathology.
    expect(effectiveMaxMountedAppPreviews(1, false)).toBe(
      MAX_MOUNTED_APP_PREVIEWS_SHARED_ORIGIN,
    );
    expect(MAX_MOUNTED_APP_PREVIEWS_SHARED_ORIGIN).toBeLessThan(
      MAX_MOUNTED_APP_PREVIEWS,
    );
  });

  it("keeps the full warm set once previews have their own process", () => {
    expect(effectiveMaxMountedAppPreviews(1, true)).toBe(MAX_MOUNTED_APP_PREVIEWS);
  });

  it("never evicts a visible pane to honour either cap", () => {
    // Split view with more visible apps than the shared cap must still mount
    // every visible one — a blank pane is worse than a busy thread.
    const visible = new Set(["a", "b", "c"]);
    const mounted = selectMountedAppTabIds(
      ["a", "b", "c", "d"].map(appTab),
      visible,
      new Map(),
      { isolatedOrigins: false },
    );
    for (const id of visible) {
      expect(mounted.has(id)).toBe(true);
    }
  });

  it("still keeps one hidden tab warm when the panes alone reach the cap", () => {
    // The cap is a bound on *hidden* warmth, so it has to be read relative to
    // what is already on screen. Returning the bare constant would mean that
    // in split view nothing stays warm at all and every switch-back reloads —
    // which is the regression the `+ 1` exists to prevent.
    expect(effectiveMaxMountedAppPreviews(3, false)).toBe(4);
    expect(effectiveMaxMountedAppPreviews(9, true)).toBe(10);

    const mounted = selectMountedAppTabIds(
      ["a", "b", "c", "warm"].map(appTab),
      new Set(["a", "b", "c"]),
      new Map([["warm", 1_000]]),
      { isolatedOrigins: false },
    );
    expect(mounted.has("warm")).toBe(true);
  });

  it("evicts the least recently active hidden preview first", () => {
    const mounted = selectMountedAppTabIds(
      ["visible", "recent", "stale"].map(appTab),
      new Set(["visible"]),
      new Map([
        ["recent", 2_000],
        ["stale", 1_000],
      ]),
      { isolatedOrigins: false },
    );
    expect(mounted.has("recent")).toBe(true);
    expect(mounted.has("stale")).toBe(false);
  });

  it("sizes the warm set from the deployment, not from one app id", () => {
    // Asking resolveMiniAppPreviewOrigin with a placeholder id would let a
    // single un-isolatable id decide the cap for every app.
    expect(
      miniAppPreviewIsolationEnabled({ host: "localhost", isolationFlag: "1" }),
    ).toBe(true);
    expect(
      miniAppPreviewIsolationEnabled({ host: "127.0.0.1", isolationFlag: "1" }),
    ).toBe(false);
    expect(
      miniAppPreviewIsolationEnabled({ host: "localhost", isolationFlag: undefined }),
    ).toBe(false);

    const contentArea = readSource("ui/components/Layout/ContentArea.tsx");
    expect(contentArea).toContain("miniAppPreviewIsolationEnabled");
    expect(contentArea).toContain("isolatedOrigins");
  });
});

describe("proving isolation actually took effect", () => {
  it("treats the header as a request, not as evidence", () => {
    // Origin-Agent-Cluster can be refused silently — a document already loaded
    // on this origin the other way wins. Only the frame can report the result.
    expect(describeIsolationOutcome(true, true)).toBe("isolated");
    expect(describeIsolationOutcome(true, false)).toBe("refused");
  });

  it("does not call a pre-bridge frame a refusal", () => {
    // Absent is not false. An older preview reports nothing; warning about
    // those would fire on every shared-origin app we never asked to isolate.
    expect(describeIsolationOutcome(true, undefined)).toBe("unknown");
    expect(describeIsolationOutcome(true, null)).toBe("unknown");
    expect(describeIsolationOutcome(false, undefined)).toBe("shared");
    expect(describeIsolationOutcome(false, null)).toBe("shared");
  });

  it("still reads an isolated frame as isolated when we did not ask", () => {
    // The browser may origin-key for its own reasons; the frame's answer wins.
    expect(describeIsolationOutcome(false, true)).toBe("isolated");
  });

  it("reports the frame's own reading rather than a constant", () => {
    // The interpreter above is only as good as its input. A bridge that always
    // announced the same value would make every outcome above unreachable —
    // and the renderer would never learn that the browser had refused.
    expect(readOriginAgentCluster({ originAgentCluster: true })).toBe(true);
    expect(readOriginAgentCluster({ originAgentCluster: false })).toBe(false);
    // Engines without the property answer nothing, which is not a refusal.
    expect(readOriginAgentCluster({})).toBeNull();
    expect(readOriginAgentCluster({ originAgentCluster: "yes" })).toBeNull();

    const bridge = readSource("src/resources/mini-app-sdk/papr-app-bridge.ts");
    expect(bridge).toContain("announceShell(appId, readOriginAgentCluster(window))");
  });

  it("carries the frame's own reading in the announcement", () => {
    const bridge = readSource("src/resources/mini-app-sdk/papr-app-bridge.ts");
    expect(bridge).toContain("originAgentCluster");
    const view = readSource("ui/components/Apps/MiniAppView.tsx");
    expect(view).toContain("describeIsolationOutcome");
    expect(view).toContain("originAgentCluster");
  });

  it("reads the flag from the shell as well as from .env files", () => {
    // The three readers of PAPR_MINI_APP_ISOLATION have to agree or the
    // deployment is half-on: the gateway serves per-app origins while the
    // renderer keeps pointing iframes at the shared one, and isolation
    // silently does nothing. The main process and gateway read process.env;
    // Vite's loadEnv covers .env files ONLY, so the renderer needs process.env
    // named explicitly or a shell-exported flag reaches two readers of three.
    const config = readSource("ui/vite.config.ts");
    const mapping = config.slice(
      config.indexOf("'import.meta.env.VITE_PAPR_MINI_APP_ISOLATION'"),
    );
    const body = mapping.slice(0, mapping.indexOf("),") + 2);
    expect(body).toContain("process.env.PAPR_MINI_APP_ISOLATION");
  });
});
