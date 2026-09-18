// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  readGateReport,
  startRendererPerformanceReporting,
  trackPreviewFrame,
} from "../ui/utils/rendererPerformance";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reports buffered counts with bounded incidents and cleans up observers and timers", async () => {
  vi.useFakeTimers();
  const callbacks: Record<
    string,
    (list: { getEntries: () => unknown[] }) => void
  > = {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      static supportedEntryTypes = ["longtask", "event"];
      constructor(private callback: (typeof callbacks)[string]) {}
      observe({ type }: { type: string }) {
        callbacks[type] = this.callback;
      }
      disconnect = disconnect;
    },
  );
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const poll = vi.fn();
  const untrack = trackPreviewFrame("frame", {
    poll,
    read: () => ({
      instanceId: "frame",
      appId: "app",
      loaded: true,
      expectedPhase: "hidden",
      acknowledgedPhase: null,
      acknowledgementAgeMs: null,
      gate: null,
    }),
  });
  const stop = startRendererPerformanceReporting("http://localhost/report");
  callbacks.longtask({
    getEntries: () =>
      Array.from({ length: 25 }, () => ({ startTime: 1, duration: 60 })),
  });
  callbacks.event({
    getEntries: () => [{ startTime: 1, processingStart: 101 }],
  });
  await vi.advanceTimersByTimeAsync(5000);
  const report = JSON.parse(fetch.mock.calls[0][1].body);
  expect(report.longTaskCount).toBe(25);
  expect(report.longTaskTotalMs).toBe(1500);
  expect(report.maxInputDelayMs).toBe(100);
  expect(report.incidents).toHaveLength(20);
  expect(report.droppedIncidents).toBe(6);
  expect(report.apps[0].acknowledgedPhase).toBeNull();
  expect(poll).toHaveBeenCalledOnce();
  stop();
  untrack();
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledTimes(2);
});

it("does not overlap uploads and exposes failed reports without retrying old samples", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("PerformanceObserver", undefined);
  let reject!: (reason: Error) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      (_url, options) =>
        new Promise((_res, rej) => {
          reject = rej;
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    )
    .mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const stop = startRendererPerformanceReporting("http://localhost/report");
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledTimes(2);
  const report = JSON.parse(fetch.mock.calls[1][1].body);
  expect(report.failedReports).toBe(1);
  expect(report.sequence).toBe(2);
  expect(report.longTasksSupported).toBe(false);
  stop();
});

it("rejects malformed frame reports instead of retaining arbitrary data", () => {
  expect(
    readGateReport({
      documentId: "x",
      phase: "hidden",
      allowedApi: -1,
      blockedApi: 0,
      allowedOther: 0,
    }),
  ).toBeNull();
  expect(
    readGateReport({
      documentId: "x",
      phase: "hidden",
      allowedApi: 1,
      blockedApi: 0,
      allowedOther: 0,
      url: "secret",
    }),
  ).not.toHaveProperty("url");
});
