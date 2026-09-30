import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  beginGatewayStartupTiming,
  beginRouteRegistrationTiming,
  getGatewayStartupTimingRows,
  lapRouteRegistrationSection,
  timeStartupSync,
  timeStartupStep,
} from "../src/gateway/services/gatewayStartupTiming.js";

describe("gatewayStartupTiming", () => {
  const prevEnv = process.env.GATEWAY_STARTUP_TIMING;

  beforeEach(() => {
    process.env.GATEWAY_STARTUP_TIMING = "1"; // opt-in in production; tests force on
    beginGatewayStartupTiming();
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.GATEWAY_STARTUP_TIMING;
    } else {
      process.env.GATEWAY_STARTUP_TIMING = prevEnv;
    }
  });

  it("records async and sync steps", async () => {
    await timeStartupStep("services", "A", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    timeStartupSync("services", "B", () => {
      /* sync */
    });

    const rows = getGatewayStartupTimingRows();
    expect(rows.some((r) => r.step === "A" && r.phase === "services")).toBe(true);
    expect(rows.some((r) => r.step === "B")).toBe(true);
  });

  it("laps route sections sequentially", () => {
    beginRouteRegistrationTiming();
    lapRouteRegistrationSection("first");
    lapRouteRegistrationSection("second");

    const rows = getGatewayStartupTimingRows();
    expect(rows.filter((r) => r.phase === "routes").map((r) => r.step)).toEqual([
      "first",
      "second",
    ]);
  });
});
