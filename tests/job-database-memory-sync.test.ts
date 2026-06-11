import { describe, expect, it } from "vitest";
import { buildJobDatabaseSnapshotContent } from "../src/gateway/services/JobDatabaseMemorySync.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    name: "People Verify",
    type: "python",
    command: "python3 main.py",
    status: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("JobDatabaseMemorySync", () => {
  it("builds readable snapshot content for memory", () => {
    const job = makeJob();
    const content = buildJobDatabaseSnapshotContent(job, "run-abc", [
      {
        table: "contacts",
        rowCount: 3,
        sampleRows: [{ id: 1, email: "test@example.com" }],
      },
    ]);

    expect(content).toContain("People Verify");
    expect(content).toContain("run-abc");
    expect(content).toContain("## Table: contacts");
    expect(content).toContain("test@example.com");
    expect(content).toContain("(showing 1 of 3 rows)");
  });

  it("truncates oversized snapshot content", () => {
    const job = makeJob({ name: "Large Export" });
    const bigRow = { payload: "x".repeat(9000) };
    const content = buildJobDatabaseSnapshotContent(job, "run-big", [
      { table: "rows", rowCount: 1, sampleRows: [bigRow] },
    ]);

    expect(content.length).toBeLessThanOrEqual(8050);
    expect(content).toContain("[... truncated for memory limits ...]");
  });
});
