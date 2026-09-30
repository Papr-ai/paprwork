import { describe, expect, it } from "vitest";
import { isJobRuntimeOffGit } from "../src/gateway/services/jobs/jobRuntimeOffGit.js";

describe("isJobRuntimeOffGit", () => {
  it("is always enabled (Sync V3 — runtime via heartbeat, not git)", () => {
    expect(isJobRuntimeOffGit()).toBe(true);
  });
});
