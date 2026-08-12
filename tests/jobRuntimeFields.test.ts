import { describe, expect, test } from "vitest";
import {
  hashJobConfigContent,
  mergeJobConfigAndRuntime,
  parseMonolithicJobJson,
  recordHasRuntimeFields,
  splitJobRecord,
  stripRuntimeForGit,
  toConfigIndexEntry,
  jobRecordToRuntimePatch,
} from "../src/gateway/services/jobs/jobRuntimeFields.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

function sampleJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    name: "Test Job",
    type: "bash",
    status: "completed",
    appIds: ["__standalone__"],
    command: "echo hi",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-06-01T12:00:00.000Z",
    lastRunAt: "2025-06-01T12:00:00.000Z",
    exitCode: 0,
    scheduleState: { nextRunAt: "2025-06-01T13:00:00.000Z" },
    ...overrides,
  };
}

describe("jobRuntimeFields", () => {
  test("splitJobRecord separates config and runtime", () => {
    const job = sampleJob();
    const { config, runtime } = splitJobRecord(job);
    expect(config.id).toBe("job-1");
    expect(config.command).toBe("echo hi");
    expect(config.status).toBeUndefined();
    expect(runtime.status).toBe("completed");
    expect(runtime.scheduleState?.nextRunAt).toBe("2025-06-01T13:00:00.000Z");
  });

  test("mergeJobConfigAndRuntime round-trips", () => {
    const job = sampleJob();
    const { config, runtime } = splitJobRecord(job);
    const merged = mergeJobConfigAndRuntime(config, runtime);
    expect(merged.id).toBe(job.id);
    expect(merged.status).toBe(job.status);
    expect(merged.scheduleState?.nextRunAt).toBe(job.scheduleState?.nextRunAt);
  });

  test("stripRuntimeForGit and toConfigIndexEntry omit runtime", () => {
    const job = sampleJob();
    expect(recordHasRuntimeFields(stripRuntimeForGit(job) as Record<string, unknown>)).toBe(
      false,
    );
    expect(toConfigIndexEntry(job).status).toBeUndefined();
  });

  test("parseMonolithicJobJson splits mixed object", () => {
    const raw = {
      id: "x",
      name: "n",
      type: "python",
      appIds: ["a"],
      createdAt: "t",
      status: "running",
      lastRunAt: "t2",
    };
    const { config, runtime } = parseMonolithicJobJson(raw);
    expect(config.id).toBe("x");
    expect(runtime.status).toBe("running");
  });

  test("hashJobConfigContent is stable for same config", () => {
    const job = sampleJob();
    const { config } = splitJobRecord(job);
    const a = hashJobConfigContent(config);
    const b = hashJobConfigContent(config);
    expect(a).toBe(b);
    expect(a.length).toBe(64);
  });

  test("jobRecordToRuntimePatch includes runtime fields for cloud upsert", () => {
    const job = sampleJob();
    const patch = jobRecordToRuntimePatch(job, "desktop");
    expect(patch.jobId).toBe("job-1");
    expect(patch.status).toBe("completed");
    expect(patch.recordedAt).toBe("2025-06-01T12:00:00.000Z");
    expect(patch.source).toBe("desktop");
    expect(patch.lastRunAt).toBe("2025-06-01T12:00:00.000Z");
    expect(patch.exitCode).toBe(0);
    expect(patch.scheduleState?.nextRunAt).toBe("2025-06-01T13:00:00.000Z");
  });
});
