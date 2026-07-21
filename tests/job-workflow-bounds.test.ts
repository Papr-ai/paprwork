import { describe, expect, it } from "vitest";
import { collectWorkflowJobIds } from "../ui/components/Jobs/workflowUtils";
import {
  STANDALONE_WORKFLOW_ID,
  resolveListAppFilterId,
} from "../ui/utils/jobGraph";
import type { JobGraph, JobRecord } from "../ui/hooks/useJobs";

function makeJob(
  id: string,
  dependsOn: JobRecord["dependsOn"] = [],
): JobRecord {
  return {
    id,
    name: id,
    type: "python",
    status: "idle",
    appIds: ["app-test"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    dependsOn,
  };
}

describe("resolveListAppFilterId", () => {
  it("maps workflow-only ungrouped id to no list filter", () => {
    expect(resolveListAppFilterId(null)).toBeNull();
    expect(resolveListAppFilterId(STANDALONE_WORKFLOW_ID)).toBeNull();
    expect(resolveListAppFilterId("app-123")).toBe("app-123");
  });
});

describe("collectWorkflowJobIds", () => {
  const jobs = [
    makeJob("ungrouped-a", [{ jobId: "app-linked-b", onStatus: "completed" }]),
    makeJob("app-linked-b"),
    makeJob("ungrouped-c"),
  ];

  const edges: JobGraph["edges"] = [
    { from: "ungrouped-c", to: "ungrouped-a", onStatus: "completed" },
  ];

  it("expands across app boundaries when no allowed set is provided", () => {
    const result = collectWorkflowJobIds(["ungrouped-a"], jobs, edges);
    expect([...result].sort()).toEqual(
      ["app-linked-b", "ungrouped-a", "ungrouped-c"].sort(),
    );
  });

  it("keeps expansion inside allowed jobs for ungrouped workflows", () => {
    const allowed = new Set(["ungrouped-a", "ungrouped-c"]);
    const result = collectWorkflowJobIds(
      ["ungrouped-a"],
      jobs,
      edges,
      allowed,
    );
    expect([...result].sort()).toEqual(["ungrouped-a", "ungrouped-c"].sort());
    expect(result.has("app-linked-b")).toBe(false);
  });

  it("keeps app workflows inside app-linked jobs", () => {
    const allowed = new Set(["app-linked-b"]);
    const result = collectWorkflowJobIds(
      ["app-linked-b"],
      jobs,
      edges,
      allowed,
    );
    expect([...result]).toEqual(["app-linked-b"]);
  });
});
