import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTelemetryForTests,
  flushEvents,
  initializeAmplitudeBrowser,
  resolveRendererPlatform,
  trackEvent,
} from "../ui/lib/telemetry";

describe("renderer telemetry", () => {
  beforeEach(() => {
    __resetTelemetryForTests();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    vi.stubGlobal("navigator", { platform: "MacIntel" });
  });

  afterEach(() => {
    __resetTelemetryForTests();
    vi.unstubAllGlobals();
  });

  it("resolveRendererPlatform maps Mac to darwin", () => {
    expect(resolveRendererPlatform()).toBe("darwin");
  });

  it("queues events before init and flushes after initializeAmplitudeBrowser", async () => {
    trackEvent("paprwork_onboarding_started", { phase: "welcome" });

    expect(fetch).not.toHaveBeenCalled();

    await initializeAmplitudeBrowser("install-test-id", true, "2.0.0");
    await flushEvents();

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    );
    expect(body.events[0].event_name).toBe("paprwork_onboarding_started");
    expect(body.events[0].properties.platform).toBe("darwin");
    expect(body.events[0].properties.client).toBe("paprwork-renderer");
  });
});
