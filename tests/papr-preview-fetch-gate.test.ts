// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const GATE = "../src/resources/mini-app-sdk/papr-preview-fetch-gate.js";

/** jsdom runs these at top level, where `window.parent === window`. */
function post(type: string): void {
  window.dispatchEvent(
    new MessageEvent("message", { source: window.parent, data: { type } }),
  );
}

/** A distinct Response per call: a folded waiter clones, and a clone of an
 * already-read body throws. */
function freshResponses() {
  return vi.fn(() => Promise.resolve(new Response("ok")));
}

const READ = "/api/db/query";
const jsonRead = (sql: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sql }),
});

describe("papr-preview-fetch-gate", () => {
  let dispose: (() => void) | undefined;
  beforeEach(() => {
    vi.resetModules();
    window.name = "";
    delete (window as Window & { __paprPreviewFetchGateInstalled?: boolean })
      .__paprPreviewFetchGateInstalled;
  });

  afterEach(() => {
    dispose?.();
    vi.unstubAllGlobals();
  });

  it("allows same-origin /api fetch before any lifecycle message", async () => {
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);

    ({ disposePreviewFetchGate: dispose } = await import(GATE));

    await window.fetch(READ, jsonRead("SELECT 1"));

    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("defers a read while hidden and settles it on visible", async () => {
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } = await import(GATE));

    post("papr:preview-hidden");
    const pending = window.fetch(READ, jsonRead("SELECT 1"));
    expect(nativeFetch).not.toHaveBeenCalled();

    post("papr:preview-visible");
    expect(await (await pending).text()).toBe("ok");
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("starts hidden from iframe.name, before the app's first call", async () => {
    // The race this repairs: waiting for papr:preview-hidden lets the app's own
    // module-scope fetch go out first, and the hidden app wins. iframe.name is
    // readable synchronously, even across origins, so the phase is known at boot.
    window.name = "papr-preview:hidden";
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);

    ({ disposePreviewFetchGate: dispose } = await import(GATE));
    const pending = window.fetch(READ, jsonRead("SELECT 1"));

    expect(nativeFetch).not.toHaveBeenCalled();
    post("papr:preview-visible");
    expect(await (await pending).text()).toBe("ok");
  });

  it("lets a write through while hidden rather than holding or failing it", async () => {
    // A write is work someone asked for. Holding it until the tab is looked at
    // again would be worse than letting it through, and rejecting would lose
    // it — the caller has no reason to expect an AbortError from a save.
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } = await import(GATE));

    post("papr:preview-hidden");
    await expect(
      window.fetch("/api/db/write", { method: "POST", body: "{}" }),
    ).resolves.toBeInstanceOf(Response);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("lets an unrecognised /api path through while hidden", async () => {
    // Only paths the gateway itself guarantees are read-only may be deferred.
    // Anything else runs: deferring a path we have not classified could hold a
    // mutation for as long as the tab stays hidden.
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } = await import(GATE));

    post("papr:preview-hidden");
    await expect(window.fetch("/api/jobs/status")).resolves.toBeInstanceOf(
      Response,
    );
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("folds by body, so identical queries share one call and different ones do not", async () => {
    // The defect this pins: keying on method left folding dead against real
    // traffic. Every read in the installed apps is a POST carrying its query in
    // the body, so a bodyless-GET rule folded nothing and the queue filled with
    // one entry per poll.
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } = await import(GATE));

    post("papr:preview-hidden");
    const same = [
      window.fetch(READ, jsonRead("SELECT 1")),
      window.fetch(READ, jsonRead("SELECT 1")),
    ];
    const other = window.fetch(READ, jsonRead("SELECT 2"));
    expect(nativeFetch).not.toHaveBeenCalled();

    post("papr:preview-visible");
    const settled = await Promise.all([...same, other]);
    expect(await Promise.all(settled.map((r) => r.text()))).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it("does not spend the queue cap on a poller's own duplicates", async () => {
    // Fold only at flush and 200 polls are 200 entries, so the cap passes 136
    // of them straight through and the backlog hits the gateway at the moment
    // the user is waiting for paint — the thundering herd the gate prevents.
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } = await import(GATE));

    post("papr:preview-hidden");
    const polls = Array.from({ length: 200 }, () =>
      window.fetch(READ, jsonRead("SELECT 1")),
    );
    expect(nativeFetch).not.toHaveBeenCalled();

    post("papr:preview-visible");
    expect(await Promise.all(polls)).toHaveLength(200);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("flushes a large stale queue on visible instead of rejecting it", async () => {
    // The v2.6.1 decision: a queue judged stale is flushed, never rejected,
    // because callers expect these promises to settle on return. Asserted on
    // what the caller observes — every promise settles with its own readable
    // body — rather than on a call count, which a shared un-cloned response
    // would satisfy while handing five of six callers a consumed stream.
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } = await import(GATE));

    post("papr:preview-hidden");
    const pending = Array.from({ length: 6 }, () =>
      window.fetch(READ, jsonRead("SELECT 1")),
    );

    post("papr:preview-visible");
    const settled = await Promise.all(pending);
    expect(await Promise.all(settled.map((r) => r.text()))).toEqual(
      Array(6).fill("ok"),
    );
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("runs a request unpaused rather than rejecting it when the queue is full", async () => {
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } = await import(GATE));

    post("papr:preview-hidden");
    // 64 distinct queries fill the queue without reaching the network.
    const queued = Array.from({ length: 64 }, (_unused, i) =>
      window.fetch(READ, jsonRead(`SELECT ${i}`)),
    );
    expect(nativeFetch).not.toHaveBeenCalled();

    // The 65th is distinct, so there is nothing to fold it into. It runs now.
    await expect(
      window.fetch(READ, jsonRead("SELECT overflow")),
    ).resolves.toBeInstanceOf(Response);
    expect(nativeFetch).toHaveBeenCalledTimes(1);

    post("papr:preview-visible");
    expect(await Promise.all(queued)).toHaveLength(64);
  });

  it("still rejects on evict, where the frame is going away", async () => {
    // Distinct from the visible path: on evict there is no tab to return to,
    // so a promise that never settles would leak the caller's continuation.
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } = await import(GATE));

    post("papr:preview-hidden");
    const pending = window.fetch(READ, jsonRead("SELECT 1"));
    post("papr:preview-evicting");

    await expect(pending).rejects.toThrow(/Preview evicted/);
  });

  it("keeps an in-flight save intact and ignores messages from another window", async () => {
    // Only the first call is held open — the save. Later calls (the flush)
    // resolve at once, so capturing one shared resolver would strand them.
    let finish: ((response: Response) => void) | undefined;
    const nativeFetch = vi.fn(() =>
      finish === undefined
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } = await import(GATE));

    const saving = window.fetch("/api/db/write", { method: "POST" });
    post("papr:preview-hidden");
    window.dispatchEvent(
      new MessageEvent("message", {
        source: null,
        data: { type: "papr:preview-visible" },
      }),
    );

    // Still hidden, so the read is held rather than run.
    const held = window.fetch(READ, jsonRead("SELECT 1"));
    expect(nativeFetch).toHaveBeenCalledTimes(1);

    finish?.(new Response("saved"));
    expect(await (await saving).text()).toBe("saved");
    post("papr:preview-visible");
    await expect(held).resolves.toBeInstanceOf(Response);
  });

  it("flushes held requests on dispose rather than stranding their callers", async () => {
    const nativeFetch = freshResponses();
    vi.stubGlobal("fetch", nativeFetch);
    const gate = await import(GATE);

    post("papr:preview-hidden");
    const pending = window.fetch(READ, jsonRead("SELECT 1"));
    gate.disposePreviewFetchGate?.();
    dispose = undefined;

    await expect(pending).resolves.toBeInstanceOf(Response);
  });

  it("late lifecycle imports pause registered resources immediately", async () => {
    window.name = "papr-preview:hidden";
    vi.stubGlobal("fetch", vi.fn());
    ({ disposePreviewFetchGate: dispose } = await import(GATE));
    const lifecycle = await import(
      "../src/resources/mini-app-sdk/papr-preview-lifecycle.js"
    );
    const pause = vi.fn();
    const unregister = lifecycle.registerPausablePreviewResource({
      pause,
      resume: vi.fn(),
    });
    expect(pause).toHaveBeenCalledOnce();
    unregister();
  });
});
