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

  it("rejects large stale queues on visible instead of flushing", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
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

    await expect(Promise.all(pending)).rejects.toMatchObject({ name: "AbortError" });
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});
