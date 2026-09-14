import { afterEach, describe, expect, test } from "vitest";
import {
  enterInteractiveHotPath,
  getInteractiveHotPathDepth,
  isInteractiveHotPathBusy,
  leaveInteractiveHotPath,
  waitForInteractiveQuietBeforeBackgroundWork,
} from "../src/gateway/services/gatewayInteractivePriority.js";

describe("gatewayInteractivePriority", () => {
  afterEach(() => {
    while (getInteractiveHotPathDepth() > 0) {
      leaveInteractiveHotPath();
    }
  });

  test("depth tracks nested hot path entries", () => {
    expect(getInteractiveHotPathDepth()).toBe(0);
    enterInteractiveHotPath("a");
    enterInteractiveHotPath("b");
    expect(getInteractiveHotPathDepth()).toBe(2);
    leaveInteractiveHotPath();
    expect(getInteractiveHotPathDepth()).toBe(1);
    leaveInteractiveHotPath();
    expect(getInteractiveHotPathDepth()).toBe(0);
  });

  test("isInteractiveHotPathBusy when depth > 0", async () => {
    enterInteractiveHotPath("app:get");
    await expect(isInteractiveHotPathBusy()).resolves.toBe(true);
    leaveInteractiveHotPath();
    await expect(isInteractiveHotPathBusy()).resolves.toBe(false);
  });

  test("waitForInteractiveQuiet proceeds after sustained idle", async () => {
    const started = Date.now();
    await waitForInteractiveQuietBeforeBackgroundWork("test", {
      minQuietMs: 50,
      maxWaitMs: 5000,
      pollMs: 25,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  test("waitForInteractiveQuiet proceeds after max wait when still busy", async () => {
    enterInteractiveHotPath("block");
    const started = Date.now();
    await waitForInteractiveQuietBeforeBackgroundWork("test", {
      minQuietMs: 5000,
      maxWaitMs: 80,
      pollMs: 20,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    leaveInteractiveHotPath();
  });
});
