import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeTelemetryProperties } from "../src/core/telemetry/sanitizeTelemetryProperties.js";
import {
  isTelemetrySendingEnabled,
  parseTelemetryEnvOverride,
  resolveTelemetryBaseUrl,
} from "../src/core/telemetry/telemetryEnv.js";
import { TelemetryClient } from "../src/core/telemetry/TelemetryClient.js";

describe("sanitizeTelemetryProperties", () => {
  it("keeps safe primitive properties", () => {
    expect(
      sanitizeTelemetryProperties({
        feature: "chat",
        count: 2,
        ok: true,
      }),
    ).toEqual({ feature: "chat", count: 2, ok: true });
  });

  it("removes keys that look like PII or content", () => {
    expect(
      sanitizeTelemetryProperties({
        safe: 1,
        user_email: "x@y.com",
        query_text: "secret",
        file_path: "/home/me",
      }),
    ).toEqual({ safe: 1 });
  });

  it("replaces arrays with length counts", () => {
    expect(
      sanitizeTelemetryProperties({
        items: ["a", "b"],
      }),
    ).toEqual({ items_count: 2 });
  });
});

describe("telemetryEnv", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    process.env = { ...prev };
    vi.unstubAllEnvs();
  });

  it("parseTelemetryEnvOverride returns undefined when unset", () => {
    delete process.env.PAPRWORK_TELEMETRY_ENABLED;
    expect(parseTelemetryEnvOverride()).toBeUndefined();
  });

  it("parseTelemetryEnvOverride parses true and false", () => {
    process.env.PAPRWORK_TELEMETRY_ENABLED = "true";
    expect(parseTelemetryEnvOverride()).toBe(true);
    process.env.PAPRWORK_TELEMETRY_ENABLED = "false";
    expect(parseTelemetryEnvOverride()).toBe(false);
  });

  it("resolveTelemetryBaseUrl defaults to memory.papr.ai", () => {
    delete process.env.PAPRWORK_TELEMETRY_URL;
    expect(resolveTelemetryBaseUrl()).toBe("https://memory.papr.ai");
  });

  it("resolveTelemetryBaseUrl returns null for empty string", () => {
    process.env.PAPRWORK_TELEMETRY_URL = "";
    expect(resolveTelemetryBaseUrl()).toBeNull();
  });

  it("resolveTelemetryBaseUrl returns null for invalid scheme", () => {
    process.env.PAPRWORK_TELEMETRY_URL = "ftp://example.com";
    expect(resolveTelemetryBaseUrl()).toBeNull();
  });

  it("isTelemetrySendingEnabled respects env false over preference", () => {
    process.env.PAPRWORK_TELEMETRY_ENABLED = "false";
    expect(isTelemetrySendingEnabled(() => true)).toBe(false);
  });

  it("isTelemetrySendingEnabled respects env true over preference", () => {
    process.env.PAPRWORK_TELEMETRY_ENABLED = "true";
    expect(isTelemetrySendingEnabled(() => false)).toBe(true);
  });

  it("isTelemetrySendingEnabled uses preference when env unset", () => {
    delete process.env.PAPRWORK_TELEMETRY_ENABLED;
    expect(isTelemetrySendingEnabled(() => true)).toBe(true);
    expect(isTelemetrySendingEnabled(() => false)).toBe(false);
  });
});

describe("TelemetryClient", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.PAPRWORK_TELEMETRY_ENABLED;
    delete process.env.PAPRWORK_TELEMETRY_URL;
  });

  afterEach(() => {
    process.env = { ...prev };
    vi.unstubAllEnvs();
  });

  it("does not call fetch when user preference is off", async () => {
    const fetchMock = vi.fn();
    const client = new TelemetryClient({
      getEffectiveEnabled: () => false,
      getAnonymousInstallId: () => "install-1",
      appVersion: "9.9.9",
      fetchImpl: fetchMock as typeof fetch,
    });
    await client.track("paprwork_test");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call fetch when anonymous id is empty", async () => {
    const fetchMock = vi.fn();
    const client = new TelemetryClient({
      getEffectiveEnabled: () => true,
      getAnonymousInstallId: () => "",
      appVersion: "1.0.0",
      fetchImpl: fetchMock as typeof fetch,
    });
    await client.track("paprwork_test");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls fetch when preference is on", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    });
    const client = new TelemetryClient({
      getEffectiveEnabled: () => true,
      getAnonymousInstallId: () => "install-2",
      appVersion: "1.0.0",
      fetchImpl: fetchMock as typeof fetch,
    });
    await client.track("paprwork_test_event", { foo: "bar" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit | undefined,
    ];
    expect(url).toBe("https://memory.papr.ai/v1/telemetry/events");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as {
      events: Array<{ event_name: string; properties: Record<string, unknown> }>;
      anonymous_id: string;
    };
    expect(body.events[0].event_name).toBe("paprwork_test_event");
    expect(body.events[0].properties.client).toBe("paprwork");
    expect(body.events[0].properties.foo).toBe("bar");
    expect(body.anonymous_id).toBe("install-2");
  });
});
