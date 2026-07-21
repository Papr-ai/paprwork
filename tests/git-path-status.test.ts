import { describe, expect, it } from "vitest";
import { canReconcilePathAsSynced } from "../src/gateway/services/cloudSync/gitPathStatus.js";

describe("canReconcilePathAsSynced", () => {
  it("returns true when folder exists, git clean, and tracked", () => {
    expect(
      canReconcilePathAsSynced({
        exists: true,
        porcelain: "",
        trackedFiles: "Jobs/job-a/job.json\n",
      }),
    ).toBe(true);
  });

  it("returns false when working tree has changes", () => {
    expect(
      canReconcilePathAsSynced({
        exists: true,
        porcelain: " M Jobs/job-a/job.json\n",
        trackedFiles: "Jobs/job-a/job.json\n",
      }),
    ).toBe(false);
  });

  it("returns false when nothing is tracked yet", () => {
    expect(
      canReconcilePathAsSynced({
        exists: true,
        porcelain: "?? Jobs/job-a/job.json\n",
        trackedFiles: "",
      }),
    ).toBe(false);
  });
});
