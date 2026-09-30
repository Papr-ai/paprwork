import { describe, expect, test } from "vitest";
import {
  JobScheduleIndex,
  bruteForceDueJobIds,
  sortedJobIds,
} from "../src/gateway/services/jobs/jobScheduleIndex.js";
import { msUntilSoonestNextRun } from "../src/gateway/services/jobs/scheduleEngine.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

function makeJob(
  id: string,
  overrides: Partial<JobRecord> = {},
): JobRecord {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    type: "shell",
    status: "pending",
    appIds: ["__standalone__"],
    command: "echo",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("JobScheduleIndex", () => {
  test("matches brute-force due ids after sync and rebuild", () => {
    const nowMs = Date.parse("2026-09-13T12:00:00.000Z");
    const jobs: JobRecord[] = [
      makeJob("due-1", {
        schedule: { enabled: true, intervalMs: 60_000 },
        scheduleState: { nextRunAt: new Date(nowMs - 1000).toISOString() },
      }),
      makeJob("future-1", {
        schedule: { enabled: true, intervalMs: 60_000 },
        scheduleState: { nextRunAt: new Date(nowMs + 60_000).toISOString() },
      }),
      makeJob("disabled-1", {
        schedule: { enabled: false, intervalMs: 60_000 },
        scheduleState: { nextRunAt: new Date(nowMs - 1000).toISOString() },
      }),
      makeJob("no-next", {
        schedule: { enabled: true, intervalMs: 60_000 },
        scheduleState: {},
      }),
    ];

    const index = new JobScheduleIndex();
    index.rebuildFromJobs(jobs);

    const brute = bruteForceDueJobIds(jobs, nowMs);
    const indexed = sortedJobIds(index.getDueJobIds(nowMs));
    expect(indexed).toEqual(brute);
    expect(indexed).toEqual(["due-1"]);
  });

  test("remove and schedule toggle update due set", () => {
    const nowMs = Date.parse("2026-09-13T12:00:00.000Z");
    const index = new JobScheduleIndex();
    const job = makeJob("j1", {
      schedule: { enabled: true, intervalMs: 1000 },
      scheduleState: { nextRunAt: new Date(nowMs - 1).toISOString() },
    });
    index.syncJob(job);
    expect(index.getDueJobIds(nowMs)).toEqual(["j1"]);

    index.syncJob({
      ...job,
      schedule: { enabled: false, intervalMs: 1000 },
    });
    expect(index.getDueJobIds(nowMs)).toEqual([]);

    index.syncJob({
      ...job,
      schedule: { enabled: true, intervalMs: 1000 },
      scheduleState: { nextRunAt: new Date(nowMs + 10_000).toISOString() },
    });
    expect(index.getDueJobIds(nowMs)).toEqual([]);
  });

  test("wake candidates from index match msUntilSoonestNextRun on full list", () => {
    const nowMs = Date.parse("2026-09-13T12:00:00.000Z");
    const jobs: JobRecord[] = [
      makeJob("a", {
        schedule: { enabled: true, intervalMs: 1000 },
        scheduleState: { nextRunAt: new Date(nowMs + 5000).toISOString() },
      }),
      makeJob("b", {
        schedule: { enabled: true, intervalMs: 1000 },
        scheduleState: { nextRunAt: new Date(nowMs + 2000).toISOString() },
      }),
    ];
    const index = new JobScheduleIndex();
    index.rebuildFromJobs(jobs);

    const fromIndex: JobRecord[] = [];
    for (const id of index.getScheduledJobIds()) {
      const found = jobs.find((j) => j.id === id);
      if (found) {
        fromIndex.push(found);
      }
    }

    expect(msUntilSoonestNextRun(fromIndex, nowMs)).toBe(
      msUntilSoonestNextRun(jobs, nowMs),
    );
  });
});
