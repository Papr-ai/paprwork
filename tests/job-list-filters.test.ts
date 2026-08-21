import { describe, expect, test } from "vitest";
import { matchesJobTypeFilter } from "../ui/utils/jobListFilters.js";
import type { JobRecord } from "../ui/hooks/useJobs.js";

function makeJob(overrides: Partial<JobRecord> & Pick<JobRecord, "id" | "type">): JobRecord {
  return {
    name: "Test job",
    status: "pending",
    appIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchesJobTypeFilter", () => {
  test("separates agent, standing sub-agent, and delegation runs", () => {
    const agent = makeJob({ id: "a", type: "agent" });
    const standing = makeJob({ id: "b", type: "subagent", name: "Weekly review" });
    const delegation = makeJob({
      id: "c",
      type: "subagent",
      name: "Delegation: Product Architect",
      delegatedBy: "chat-1",
    });

    expect(matchesJobTypeFilter(agent, "agent")).toBe(true);
    expect(matchesJobTypeFilter(standing, "subagent")).toBe(true);
    expect(matchesJobTypeFilter(delegation, "subagent")).toBe(false);
    expect(matchesJobTypeFilter(delegation, "delegation")).toBe(true);
  });

  test("matches script job types", () => {
    expect(matchesJobTypeFilter(makeJob({ id: "p", type: "python" }), "python")).toBe(true);
    expect(matchesJobTypeFilter(makeJob({ id: "b", type: "bash" }), "shell")).toBe(true);
    expect(matchesJobTypeFilter(makeJob({ id: "s", type: "shell" }), "shell")).toBe(true);
  });
});
