import { describe, expect, test } from "vitest";
import {
  checkPiStreamMemory,
  PI_PROCESS_MEMORY_BACKSTOP_BYTES,
  PI_STREAM_MEMORY_BUDGET_BYTES,
} from "../src/gateway/services/providers/piStreamMemoryLimits.js";

describe("checkPiStreamMemory", () => {
  test("flags stream budget when delta exceeds per-stream limit", () => {
    const baseline = 500 * 1024 * 1024;
    const heapUsed = baseline + PI_STREAM_MEMORY_BUDGET_BYTES + 1;

    const result = checkPiStreamMemory(baseline, heapUsed);

    expect(result.overStreamBudget).toBe(true);
    expect(result.overProcessBackstop).toBe(false);
  });

  test("flags process backstop independently of stream delta", () => {
    const baseline = PI_PROCESS_MEMORY_BACKSTOP_BYTES - 1024;
    const heapUsed = PI_PROCESS_MEMORY_BACKSTOP_BYTES + 1;

    const result = checkPiStreamMemory(baseline, heapUsed);

    expect(result.overProcessBackstop).toBe(true);
  });
});
