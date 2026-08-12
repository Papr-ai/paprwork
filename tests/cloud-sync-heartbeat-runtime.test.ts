import { describe, expect, test, vi } from "vitest";
import { applyPendingCloudRunPatches } from "../src/gateway/services/cloudSync/applyPendingCloudRunPatches.js";
import type { JobRuntimePatch } from "../src/gateway/types/cloudRuntime.js";

describe("applyPendingCloudRunPatches", () => {
  test("applies all patches and skips git when scheduleState present", async () => {
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

    expect(result).toEqual({ applied: 2, needsGitFallback: false });
    expect(applyCloudRunPatch).toHaveBeenCalledTimes(2);
  });

  test("requests git fallback when terminal patch lacks nextRunAt and was not applied", async () => {
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

    expect(result).toEqual({ applied: 0, needsGitFallback: true });
  });

  test("does not request git fallback when patch was skipped by LWW only", async () => {
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

    expect(result).toEqual({ applied: 0, needsGitFallback: false });
  });
});
