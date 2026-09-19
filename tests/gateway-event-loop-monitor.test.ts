import { describe, expect, test } from "vitest";
import {
  sampleEventLoopLagMs,
  startGatewayEventLoopMonitor,
  stopGatewayEventLoopMonitor,
} from "../src/gateway/services/gatewayEventLoopMonitor.js";

describe("gatewayEventLoopMonitor", () => {
  test("returns zero when monitor not started", () => {
    stopGatewayEventLoopMonitor();
    expect(sampleEventLoopLagMs()).toBe(0);
  });

  test("samples after start", async () => {
    stopGatewayEventLoopMonitor();
    startGatewayEventLoopMonitor();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sampleEventLoopLagMs()).toBeGreaterThanOrEqual(0);
    stopGatewayEventLoopMonitor();
  });
});

test("retains maximum delay across diagnostic reads and captures resources", async () => {
  const { collectGatewayResourceSample, getGatewayResourceDiagnostics } = await import("../src/gateway/services/gatewayEventLoopMonitor.js");
  startGatewayEventLoopMonitor();
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    const started = performance.now();
    while (performance.now() - started < 120) { /* Intentional blocked gateway. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
    const first = getGatewayResourceDiagnostics();
    expect(first.currentWindow.eventLoop.maxMs).toBeGreaterThan(60);
    sampleEventLoopLagMs(true);
    expect(getGatewayResourceDiagnostics().currentWindow.eventLoop.maxMs).toBeGreaterThanOrEqual(first.currentWindow.eventLoop.maxMs);
    const sample = collectGatewayResourceSample()!;
    expect(sample.eventLoop.p95Ms).toBeGreaterThanOrEqual(0);
    expect(sample.memory.rss).toBeGreaterThan(0);
    expect(sample.runtime?.heapLimitBytes).toBeGreaterThan(sample.memory.heapUsed);
    expect(sample.runtime?.eventLoopActiveMs).toBeGreaterThan(60);
    expect(sample.runtime?.eventLoopUtilization).toBeGreaterThan(0);
    expect(sample.runtime?.resourceUsageDelta.majorPageFaults).toBeGreaterThanOrEqual(0);
    expect(sample.cpuPercentOfOneCore).toBeGreaterThan(0);
    expect(getGatewayResourceDiagnostics().samples.at(-1)?.eventLoop.maxMs).toBeGreaterThan(60);
    for (let i = 0; i < 125; i++) collectGatewayResourceSample();
    expect(getGatewayResourceDiagnostics().samples).toHaveLength(120);
  } finally { stopGatewayEventLoopMonitor(); }
});
