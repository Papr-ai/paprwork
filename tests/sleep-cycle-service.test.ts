import { describe, it, expect } from "vitest";
import {
  isSleepCycleJobName,
  SLEEP_JOB_DEFAULTS,
  SLEEP_PROMPT_VERSION,
} from "../src/gateway/services/SleepCycleService.js";

describe("SleepCycleService", () => {
  it("recognizes sleep job names", () => {
    expect(isSleepCycleJobName("Papr Sleep Cycle")).toBe(true);
    expect(isSleepCycleJobName("papr-sleep")).toBe(true);
    expect(isSleepCycleJobName("Daily Brief")).toBe(false);
  });

  it("uses Claude Sonnet and 100 max turns by default", () => {
    expect(SLEEP_JOB_DEFAULTS.provider).toBe("anthropic");
    expect(SLEEP_JOB_DEFAULTS.model).toBe("claude-sonnet-4-6");
    expect(SLEEP_JOB_DEFAULTS.maxTurns).toBe(100);
    expect(SLEEP_JOB_DEFAULTS.retries.maxAttempts).toBe(2);
  });

  it("bumps sleep prompt template version", () => {
    expect(SLEEP_PROMPT_VERSION).toBeGreaterThanOrEqual(2);
  });
});
