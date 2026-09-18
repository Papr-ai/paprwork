// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("papr-preview-fetch-gate", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (window as Window & { __paprPreviewFetchGateInstalled?: boolean })
      .__paprPreviewFetchGateInstalled;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows same-origin /api fetch before any lifecycle message", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);

    await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js");

    await window.fetch("/api/db/query", { method: "POST" });

    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("queues /api fetch after papr:preview-hidden and flushes small queue on visible", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);

    await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js");

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-hidden" } }),
    );

    const pending = window.fetch("/api/db/query");
    expect(nativeFetch).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-visible" } }),
    );

    await pending;
    expect(nativeFetch).toHaveBeenCalledTimes(1);

    await window.fetch("/api/db/query");
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  /**
   * This test's name is the v2.6.1 decision and still holds: a queue judged
   * stale is flushed, never rejected, because "callers expect these promises to
   * settle on return".
   *
   * It asserted that via `toHaveBeenCalledTimes(6)` — one network call per
   * queued call. That is the mechanism, not the requirement, and it is the one
   * coalescing changes: six identical GETs now issue one request. So the
   * assertion moves to what the caller can actually observe — every promise
   * settles, with its own readable body — which is strictly stronger, since a
   * shared un-cloned response would satisfy a call count and still hand five of
   * the six callers an already-consumed stream.
   */
  it("flushes large stale queues on visible instead of rejecting", async () => {
    const nativeFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", nativeFetch);

    await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js");

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-hidden" } }),
    );

    const pending = Array.from({ length: 6 }, () => window.fetch("/api/db/query"));
    expect(nativeFetch).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-visible" } }),
    );

    const settled = await Promise.all(pending);
    expect(settled).toHaveLength(6);
    expect(await Promise.all(settled.map((r) => r.text()))).toEqual(
      Array(6).fill("ok"),
    );
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("does not spend the queue cap on a poller's own duplicates", async () => {
    // The failure this pins: fold only at flush and 200 polls are 200 entries,
    // so the cap evicts (or passes through) 136 of them and the backlog hits
    // the gateway at the moment the user is waiting for paint — the exact
    // thundering herd the gate exists to prevent.
    const nativeFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", nativeFetch);

    await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js");
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-hidden" } }),
    );

    const polls = Array.from({ length: 200 }, () =>
      window.fetch("/api/jobs/status"),
    );
    expect(nativeFetch).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-visible" } }),
    );

    expect(await Promise.all(polls)).toHaveLength(200);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("runs a request unpaused rather than rejecting it when the queue is full", async () => {
    const nativeFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", nativeFetch);

    await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js");
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-hidden" } }),
    );

    // 64 distinct requests fill the queue without reaching the network.
    const queued = Array.from({ length: 64 }, (_unused, i) =>
      window.fetch(`/api/db/query?row=${i}`),
    );
    expect(nativeFetch).not.toHaveBeenCalled();

    // The 65th is distinct, so there is nothing to fold it into. It runs now.
    await expect(window.fetch("/api/db/query?row=overflow")).resolves.toBeInstanceOf(
      Response,
    );
    expect(nativeFetch).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-visible" } }),
    );
    expect(await Promise.all(queued)).toHaveLength(64);
  });

  it("still rejects on evict, where the frame is going away", async () => {
    // Distinct from the visible path: on evict there is no tab to return to,
    // so a promise that never settles would leak the caller's continuation.
    // v2.6.1 removed rejection from the visible path and kept it here.
    const nativeFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", nativeFetch);

    await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js");
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-hidden" } }),
    );

    const pending = window.fetch("/api/db/query");
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-evicting" } }),
    );

    await expect(pending).rejects.toThrow(/Preview evicted/);
  });
});
