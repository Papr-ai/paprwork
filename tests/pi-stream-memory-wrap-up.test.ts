import { describe, expect, test } from "vitest";
import {
  PI_PROCESS_MEMORY_BACKSTOP_BYTES,
  PI_STREAM_MEMORY_BUDGET_BYTES,
  type PiStreamMemoryCheck,
} from "../src/gateway/services/providers/piStreamMemoryLimits.js";
import { resolvePiStreamMemoryLoopAction } from "../src/gateway/services/providers/piStreamMemoryWrapUp.js";

function makeCheck(overrides: Partial<PiStreamMemoryCheck>): PiStreamMemoryCheck {
  return {
    heapUsed: 0,
    streamDelta: 0,
    overStreamBudget: false,
    overProcessBackstop: false,
    overStreamWarning: false,
    streamBudget: PI_STREAM_MEMORY_BUDGET_BYTES,
    confirmedAfterGc: false,
    ...overrides,
  };
}

describe("resolvePiStreamMemoryLoopAction", () => {
  test("continues normally under budget", () => {
    const action = resolvePiStreamMemoryLoopAction(
      makeCheck({ overStreamWarning: false }),
      false,
    );
    expect(action).toEqual({ kind: "continue", memoryPressure: false });
  });

  test("continues with compaction when approaching budget", () => {
    const action = resolvePiStreamMemoryLoopAction(
      makeCheck({ overStreamWarning: true }),
      false,
    );
    expect(action).toEqual({ kind: "continue", memoryPressure: true });
  });

  test("forces wrap-up the first time stream budget is exceeded", () => {
    const action = resolvePiStreamMemoryLoopAction(
      makeCheck({ overStreamBudget: true, overStreamWarning: true }),
      false,
    );
    expect(action).toEqual({ kind: "force_wrap_up" });
  });

  test("ends gracefully after wrap-up was already attempted", () => {
    const action = resolvePiStreamMemoryLoopAction(
      makeCheck({ overStreamBudget: true }),
      true,
    );
    expect(action).toEqual({ kind: "graceful_end" });
  });

  test("process backstop still hard-errors", () => {
    const action = resolvePiStreamMemoryLoopAction(
      makeCheck({
        overProcessBackstop: true,
        overStreamBudget: true,
        heapUsed: PI_PROCESS_MEMORY_BACKSTOP_BYTES + 1,
      }),
      false,
    );
    expect(action).toEqual({ kind: "process_error" });
  });
});
