import { describe, expect, test } from "vitest";
import {
  buildDelegationRunGroups,
  delegationGroupKey,
  delegationProfileName,
  formatDelegationGroupSummary,
  isDelegationRun,
} from "../ui/utils/delegationJobGrouping.js";
import type { JobRecord } from "../ui/hooks/useJobs.js";

function makeJob(overrides: Partial<JobRecord> & Pick<JobRecord, "id">): JobRecord {
  return {
    name: "Delegation: Product Architect",
    type: "subagent",
    status: "completed",
    appIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("delegationJobGrouping", () => {
  test("isDelegationRun matches subagent delegation jobs", () => {
    expect(
      isDelegationRun(makeJob({ id: "a", name: "Delegation: Sync Explorer" })),
    ).toBe(true);
    expect(
      isDelegationRun(
        makeJob({ id: "b", name: "Custom", delegatedBy: "chat-1" }),
      ),
    ).toBe(true);
    expect(isDelegationRun(makeJob({ id: "c", type: "python" }))).toBe(false);
    expect(
      isDelegationRun(makeJob({ id: "d", name: "Standing subagent", type: "subagent" })),
    ).toBe(false);
  });

  test("groups runs by subAgentId with profile name fallback", () => {
    const jobs = [
      makeJob({
        id: "1",
        subAgentId: "product-architect",
        name: "Delegation: Product Architect",
        lastRunAt: "2026-02-01T00:00:00.000Z",
      }),
      makeJob({
        id: "2",
        subAgentId: "product-architect",
        name: "Delegation: Product Architect",
        status: "failed",
        lastRunAt: "2026-02-02T00:00:00.000Z",
      }),
      makeJob({
        id: "3",
        name: "Delegation: Code Reviewer",
        lastRunAt: "2026-02-03T00:00:00.000Z",
      }),
    ];

    const groups = buildDelegationRunGroups(jobs);
    expect(groups).toHaveLength(2);
    const architect = groups.find((g) => g.key === "id:product-architect");
    const reviewer = groups.find((g) => g.key === "name:code reviewer");
    expect(architect?.totalRuns).toBe(2);
    expect(architect?.failedCount).toBe(1);
    expect(reviewer?.profileName).toBe("Code Reviewer");
  });

  test("hideCompleted removes completed runs", () => {
    const jobs = [
      makeJob({ id: "1", status: "completed" }),
      makeJob({ id: "2", status: "failed" }),
    ];
    const groups = buildDelegationRunGroups(jobs, { hideCompleted: true });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.runs).toHaveLength(1);
    expect(groups[0]?.runs[0]?.id).toBe("2");
  });

  test("delegationProfileName and group key helpers", () => {
    const job = makeJob({
      id: "x",
      subAgentId: "agent-1",
      name: "Delegation:  Product Architect ",
    });
    expect(delegationProfileName(job)).toBe("Product Architect");
    expect(delegationGroupKey(job)).toBe("id:agent-1");
    expect(formatDelegationGroupSummary({
      key: "id:agent-1",
      profileName: "Product Architect",
      runs: [job],
      totalRuns: 3,
      failedCount: 1,
      activeCount: 0,
      hasActive: false,
    })).toBe("3 runs · 1 failed");
  });
});
