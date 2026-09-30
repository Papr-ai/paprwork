import { describe, expect, it } from "vitest";

import {
  appSourceRepoRelativeDir,
  isAppRepoRootPath,
  isGitRepositoryNotFoundError,
  linkedJobRepoRelativeDir,
  redactGitCloneErrorMessage,
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

  it("detects missing GitHub repos from clone errors", () => {
    const err = new Error(
      "git clone failed (128): remote: Repository not found.\nfatal: repository 'https://github.com/papr-work/app-x.git/' not found",
    );
    expect(isGitRepositoryNotFoundError(err)).toBe(true);
    expect(isGitRepositoryNotFoundError(new Error("timed out"))).toBe(false);
  });

  it("redacts git tokens from clone error messages", () => {
    const raw =
      "git clone https://x-access-token:ghs_secret@github.com/papr-work/app-x.git failed";
    expect(redactGitCloneErrorMessage(raw)).toBe(
      "git clone https://***@github.com/papr-work/app-x.git failed",
    );
  });
});
