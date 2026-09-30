import { describe, expect, it } from "vitest";
import type { DiagnosticRecord } from "../src/core/utils/performanceDiagnostics.js";
import type { GatewayResourceSample } from "../src/gateway/services/gatewayEventLoopMonitor.js";
import {
  assignTimelineRows,
  buildGatewayPerformanceTimeline,
  correlateSlowEventLoopWindows,
} from "../src/gateway/services/gatewayPerformanceTimeline.js";

function sample(partial: Partial<GatewayResourceSample>): GatewayResourceSample {
  return {
    startedAt: "2026-09-17T20:00:00.000Z",
    finishedAt: "2026-09-17T20:00:05.000Z",
    elapsedMs: 5000,
    eventLoop: { meanMs: 10, p95Ms: 20, maxMs: 100, count: 50 },
    cpuPercentOfOneCore: 12,
    memory: process.memoryUsage(),
    system: { freeMemoryBytes: 1, totalMemoryBytes: 2, loadAverage: [0, 0, 0] },
    gc: { count: 0, totalMs: 0, maxMs: 0 },
    activeOperationIds: [],
    ...partial,
  };
}

function op(partial: Partial<DiagnosticRecord> & Pick<DiagnosticRecord, "id" | "kind" | "name">): DiagnosticRecord {
  return {
    queuedAt: "2026-09-17T20:00:01.000Z",
    status: "running",
    events: 0,
    errorCount: 0,
    longestStreamGapMs: 0,
    ...partial,
  };
}

describe("gatewayPerformanceTimeline", () => {
  it("lists overlapping ops for slow event-loop windows", () => {
    const chat = op({
      id: "chat-1",
      kind: "chat",
      name: "agent-turn",
      queuedAt: "2026-09-17T19:59:58.000Z",
      startedAt: "2026-09-17T19:59:58.000Z",
    });
    const bg = op({
      id: "bg-1",
      kind: "background",
      name: "papr:resume-cloud",
      queuedAt: "2026-09-17T20:00:00.500Z",
      startedAt: "2026-09-17T20:00:02.000Z",
    });
    const index = new Map([
      [chat.id, chat],
      [bg.id, bg],
    ]);
    const windows = correlateSlowEventLoopWindows(
      [
        sample({
          eventLoop: { meanMs: 200, p95Ms: 500, maxMs: 7500, count: 80 },
          activeOperationIds: ["chat-1"],
        }),
      ],
      index,
      "2026-09-17T20:00:10.000Z",
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.eventLoop.maxMs).toBe(7500);
    expect(windows[0]?.activeAtSample.map((r) => r.id)).toEqual(["chat-1"]);
    expect(windows[0]?.overlapping.map((r) => r.id).sort()).toEqual(["bg-1", "chat-1"]);
  });

  it("stacks parallel tool bars on separate rows", () => {
    const bars = assignTimelineRows(
      [
        op({
          id: "t1",
          kind: "tool",
          name: "read_file",
          queuedAt: "2026-09-17T20:00:00.000Z",
          startedAt: "2026-09-17T20:00:00.000Z",
          finishedAt: "2026-09-17T20:00:00.050Z",
        }),
        op({
          id: "t2",
          kind: "tool",
          name: "read_file",
          queuedAt: "2026-09-17T20:00:00.010Z",
          startedAt: "2026-09-17T20:00:00.010Z",
          finishedAt: "2026-09-17T20:00:00.040Z",
        }),
      ],
      "2026-09-17T20:00:10.000Z",
    );
    expect(bars.map((b) => b.row).sort()).toEqual([0, 1]);
  });

  it("buildGatewayPerformanceTimeline includes slow windows", () => {
    const timeline = buildGatewayPerformanceTimeline({
      capturedAt: "2026-09-17T20:00:10.000Z",
      samples: [
        sample({
          eventLoop: { meanMs: 1, p95Ms: 2, maxMs: 50, count: 10 },
        }),
        sample({
          startedAt: "2026-09-17T20:00:05.000Z",
          finishedAt: "2026-09-17T20:00:10.000Z",
          eventLoop: { meanMs: 400, p95Ms: 2000, maxMs: 7499, count: 90 },
        }),
      ],
      active: [],
      recent: [
        op({
          id: "m1",
          kind: "model",
          name: "provider-request",
          finishedAt: "2026-09-17T20:00:08.000Z",
          status: "completed",
          totalMs: 8000,
        }),
      ],
    });
    expect(timeline.slowEventLoopWindows[0]?.eventLoop.maxMs).toBe(7499);
    expect(timeline.operations.some((o) => o.id === "m1")).toBe(true);
  });
});

it("retains the resource time range without any operation traces", () => {
  const timeline = buildGatewayPerformanceTimeline({ capturedAt: "2026-09-17T20:00:10.000Z", samples: [sample({})], active: [], recent: [] });
  expect(timeline.rangeStart).toBe("2026-09-17T20:00:00.000Z");
});

it("keeps overlapping queues on separate rows and forwards wait and parent metadata", () => {
  const bars = assignTimelineRows([
    op({ id: "a", kind: "tool", name: "a", startedAt: "2026-09-17T20:00:01.000Z", finishedAt: "2026-09-17T20:00:04.000Z" }),
    op({ id: "b", kind: "tool", name: "b", turnId: "parent", startedAt: "2026-09-17T20:00:05.000Z", waits: [{ startedAt: "2026-09-17T20:00:01.000Z", finishedAt: "2026-09-17T20:00:05.000Z" }] }),
  ], "2026-09-17T20:00:10.000Z");
  expect(bars[0].row).not.toBe(bars[1].row);
  expect(bars[1].turnId).toBe("parent"); expect(bars[1].waits).toHaveLength(1);
});
