import { describe, expect, it } from "vitest";
import {
  parseRendererSample,
  RendererPerformanceDiagnostics,
} from "../src/gateway/services/rendererPerformanceDiagnostics.js";

const sample = (sequence = 1, sessionId = "session-1") => ({
  sessionId,
  sequence,
  startedAt: "2026-09-18T00:00:00.000Z",
  finishedAt: "2026-09-18T00:00:05.000Z",
  documentVisible: true,
  longTasksSupported: true,
  inputTimingSupported: false,
  longTaskCount: 2,
  longTaskTotalMs: 123,
  maxInputDelayMs: 0,
  maxTimerDelayMs: 120,
  droppedIncidents: 0,
  failedReports: 0,
  apps: [
    {
      instanceId: "frame-1",
      appId: "app-1",
      loaded: true,
      expectedPhase: "hidden",
      acknowledgedPhase: "hidden",
      acknowledgementAgeMs: 100,
      gate: {
        documentId: "document-1",
        phase: "hidden",
        allowedApi: 1,
        blockedApi: 20,
        allowedOther: 0,
      },
    },
  ],
  incidents: [
    {
      kind: "long-task",
      startedAt: "2026-09-18T00:00:01.000Z",
      durationMs: 70,
    },
  ],
});

describe("renderer diagnostics", () => {
  it("retains bounded history, detects stale sessions and rejects reordering", () => {
    const store = new RendererPerformanceDiagnostics();
    for (let i = 1; i <= 130; i++)
      expect(store.record(sample(i), 1000)).toBe(true);
    expect(store.record(sample(129), 1100)).toBe(false);
    const session = store.snapshot(17000).sessions[0];
    expect(session.samples).toHaveLength(120);
    expect(session.samples[0].sequence).toBe(11);
    expect(session.stale).toBe(true);
    for (let i = 2; i <= 6; i++) store.record(sample(1, `session-${i}`), 20000);
    expect(store.snapshot().sessions).toHaveLength(4);
    expect(
      store.snapshot().sessions.some((s) => s.sessionId === "session-1"),
    ).toBe(false);
  });
  it("validates size/numbers and strips unexpected content at every level", () => {
    const input = {
      ...sample(),
      url: "secret",
      apps: sample().apps.map((a) => ({
        ...a,
        text: "secret",
        gate: { ...a.gate, url: "secret" },
      })),
    };
    expect(JSON.stringify(parseRendererSample(input))).not.toContain("secret");
    expect(
      parseRendererSample({ ...sample(), maxTimerDelayMs: Infinity }),
    ).toBeNull();
    expect(
      parseRendererSample({
        ...sample(),
        apps: Array(33).fill(sample().apps[0]),
      }),
    ).toBeNull();
    expect(
      parseRendererSample({
        ...sample(),
        incidents: Array(21).fill(sample().incidents[0]),
      }),
    ).toBeNull();
    expect(parseRendererSample({ ...sample(), apps: [null] })).toBeNull();
  });
});
