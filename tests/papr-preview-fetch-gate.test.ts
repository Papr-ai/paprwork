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

  it("rejects /api fetch while hidden instead of queueing", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);

    await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js");

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-hidden" } }),
    );

    await expect(window.fetch("/api/db/query")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("allows /api fetch again after papr:preview-visible", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);

    await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js");

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-hidden" } }),
    );
    await expect(window.fetch("/api/db/query")).rejects.toThrow();

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "papr:preview-visible" } }),
    );

    await window.fetch("/api/db/query");
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });
});
