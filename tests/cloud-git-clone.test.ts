import { describe, expect, it } from "vitest";

import {
  appSourceRepoRelativeDir,
  isAppRepoRootPath,
  linkedJobRepoRelativeDir,
} from "../src/gateway/services/cloudSync/cloudGitClone.js";

describe("cloudGitClone helpers", () => {
  it("detects app repo root paths", () => {
    expect(isAppRepoRootPath(".")).toBe(true);
    expect(isAppRepoRootPath("")).toBe(true);
    expect(isAppRepoRootPath("apps/app-1")).toBe(false);
  });

  it("maps contribute staging paths for legacy vs app repos", () => {
    expect(appSourceRepoRelativeDir(".", "app-1")).toBe(".");
    expect(appSourceRepoRelativeDir("apps/app-1", "app-1")).toBe("apps/app-1");
    expect(linkedJobRepoRelativeDir(".", "job-1")).toBe("jobs/job-1");
    expect(linkedJobRepoRelativeDir("apps/app-1", "job-1")).toBe("Jobs/job-1");
  });
});
