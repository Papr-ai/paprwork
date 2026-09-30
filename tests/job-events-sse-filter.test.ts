import { describe, expect, it } from "vitest";
import type { JobEvent } from "../src/core/types/jobEvents.js";
import { jobEventDbId, jobEventJobId } from "../src/core/types/jobEvents.js";

function matchesFilter(
  event: JobEvent,
  jobIds: string[],
  dbIds: string[],
): boolean {
  if (jobIds.length === 0 && dbIds.length === 0) {
    return true;
  }

  if (event.type === "jobs:db-changed" && dbIds.length > 0) {
    const dbId = jobEventDbId(event);
    if (dbId !== undefined && dbIds.includes(dbId)) {
      return true;
    }
  }

  const jobId = jobEventJobId(event);
  return jobId !== undefined && jobIds.includes(jobId);
}

describe("job events SSE filter", () => {
  it("matches db-changed by dbId", () => {
    const event: JobEvent = {
      type: "jobs:db-changed",
      data: { dbId: "db-abcdef12", tables: [] },
    };
    expect(matchesFilter(event, [], ["db-abcdef12"])).toBe(true);
    expect(matchesFilter(event, [], ["db-other"])).toBe(false);
  });

  it("matches status-changed by jobId only", () => {
    const event: JobEvent = {
      type: "jobs:status-changed",
      data: { jobId: "job-1", status: "completed" },
    };
    expect(matchesFilter(event, ["job-1"], [])).toBe(true);
    expect(matchesFilter(event, [], ["db-abcdef12"])).toBe(false);
  });

  it("matches db-changed by jobId when app subscribes with jobIds only", () => {
    const event: JobEvent = {
      type: "jobs:db-changed",
      data: {
        jobId: "51abf434-1d0f-4f14-8111-fabe8eedf224",
        dbId: "db-2d6b4294",
        tables: ["audit_modules"],
      },
    };
    expect(
      matchesFilter(event, ["51abf434-1d0f-4f14-8111-fabe8eedf224"], []),
    ).toBe(true);
  });

  it("does not match db-changed with dbId only when subscribed by jobIds", () => {
    const event: JobEvent = {
      type: "jobs:db-changed",
      data: { dbId: "db-2d6b4294", tables: ["audit_modules"] },
    };
    expect(matchesFilter(event, ["51abf434-1d0f-4f14-8111-fabe8eedf224"], [])).toBe(
      false,
    );
  });
});
