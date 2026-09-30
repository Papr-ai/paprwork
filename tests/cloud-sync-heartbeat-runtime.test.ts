import { describe, expect, test, vi } from "vitest";
import { applyPendingCloudRunPatches } from "../src/gateway/services/cloudSync/applyPendingCloudRunPatches.js";
import type { JobRuntimePatch } from "../src/gateway/types/cloudRuntime.js";

describe("applyPendingCloudRunPatches", () => {
  test("applies all patches when scheduleState present", async () => {
    const applyCloudRunPatch = vi
      .fn()
      .mockResolvedValueOnce({ id: "a" })
      .mockResolvedValueOnce({ id: "b" });

    const result = await applyPendingCloudRunPatches(
      [
        {
          jobId: "a",
          status: "completed",
          recordedAt: "2025-06-01T10:00:00.000Z",
          scheduleState: { nextRunAt: "2025-06-01T11:00:00.000Z" },
        },
        {
          jobId: "b",
          status: "completed",
          recordedAt: "2025-06-01T10:05:00.000Z",
          scheduleState: { nextRunAt: "2025-06-01T11:05:00.000Z" },
        },
      ] satisfies JobRuntimePatch[],
      {
        jobsService: {
          initialize: vi.fn().mockResolvedValue(undefined),
          applyCloudRunPatch,
        },
      },
    );

    expect(result).toEqual({ applied: 2, incompletePatches: 0 });
    expect(applyCloudRunPatch).toHaveBeenCalledTimes(2);
  });

  test("counts incomplete terminal patches lacking nextRunAt (no git fallback)", async () => {
    const applyCloudRunPatch = vi.fn().mockResolvedValue(null);

    const result = await applyPendingCloudRunPatches(
      [
        {
          jobId: "a",
          status: "completed",
          recordedAt: "2025-06-01T10:00:00.000Z",
        },
      ],
      {
        jobsService: {
          initialize: vi.fn().mockResolvedValue(undefined),
          applyCloudRunPatch,
        },
      },
    );

    expect(result).toEqual({ applied: 0, incompletePatches: 1 });
  });

  test("does not count non-terminal skipped patches as incomplete", async () => {
    const applyCloudRunPatch = vi.fn().mockResolvedValue(null);

    const result = await applyPendingCloudRunPatches(
      [
        {
          jobId: "a",
          status: "running",
          recordedAt: "2025-06-01T10:00:00.000Z",
        },
      ],
      {
        jobsService: {
          initialize: vi.fn().mockResolvedValue(undefined),
          applyCloudRunPatch,
        },
      },
    );

    expect(result).toEqual({ applied: 0, incompletePatches: 0 });
  });
});
