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
