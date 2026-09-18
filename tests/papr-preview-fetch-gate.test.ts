// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);

    ({ disposePreviewFetchGate: dispose } =
      await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js"));

    await window.fetch("/api/db/query", { method: "POST" });

    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects /api fetch while hidden instead of queueing", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);

    ({ disposePreviewFetchGate: dispose } =
      await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js"));

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: { type: "papr:preview-hidden" },
      }),
    );

    await expect(window.fetch("/api/db/query")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("allows /api fetch again after papr:preview-visible", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);

    ({ disposePreviewFetchGate: dispose } =
      await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js"));

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: { type: "papr:preview-hidden" },
      }),
    );
    await expect(window.fetch("/api/db/query")).rejects.toThrow();

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: { type: "papr:preview-visible" },
      }),
    );

    await window.fetch("/api/db/query");
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });
  it("starts hidden before the first app call and never replays blocked writes", async () => {
    window.name = "papr-preview:hidden";
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } =
      await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js"));
    const capturedFetch = window.fetch;
    await expect(
      capturedFetch("/api/db/write", { method: "POST" }),
    ).rejects.toMatchObject({ name: "AbortError" });
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: { type: "papr:preview-visible" },
      }),
    );
    expect(nativeFetch).not.toHaveBeenCalled();
    await capturedFetch("/api/db/write", { method: "POST" });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-flight save intact and ignores messages from another window", async () => {
    let finish!: (response: Response) => void;
    const nativeFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", nativeFetch);
    ({ disposePreviewFetchGate: dispose } =
      await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js"));
    const saving = window.fetch("/api/db/write", { method: "POST" });
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: { type: "papr:preview-hidden" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: null,
        data: { type: "papr:preview-visible" },
      }),
    );
    await expect(window.fetch("/api/db/query")).rejects.toThrow();
    finish(new Response("saved"));
    expect(await (await saving).text()).toBe("saved");
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("late lifecycle imports pause registered resources immediately", async () => {
    window.name = "papr-preview:hidden";
    vi.stubGlobal("fetch", vi.fn());
    ({ disposePreviewFetchGate: dispose } =
      await import("../src/resources/mini-app-sdk/papr-preview-fetch-gate.js"));
    const lifecycle =
      await import("../src/resources/mini-app-sdk/papr-preview-lifecycle.js");
    const pause = vi.fn();
    const unregister = lifecycle.registerPausablePreviewResource({
      pause,
      resume: vi.fn(),
    });
    expect(pause).toHaveBeenCalledOnce();
    unregister();
  });
});
