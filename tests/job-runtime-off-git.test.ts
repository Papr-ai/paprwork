import { afterEach, describe, expect, it } from "vitest";
import { isJobRuntimeOffGit } from "../src/gateway/services/jobs/jobRuntimeOffGit.js";

const ENV = "JOB_RUNTIME_OFF_GIT";

describe("isJobRuntimeOffGit", () => {
  let previous: string | undefined;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = previous;
    }
  });

  it("defaults to on when unset", () => {
    previous = process.env[ENV];
    delete process.env[ENV];
    expect(isJobRuntimeOffGit()).toBe(true);
  });

  it("opts out with 0/false/no", () => {
    previous = process.env[ENV];
    for (const value of ["0", "false", "no"]) {
      process.env[ENV] = value;
      expect(isJobRuntimeOffGit()).toBe(false);
    }
  });

  it("accepts explicit on values", () => {
    previous = process.env[ENV];
    for (const value of ["1", "true", "yes"]) {
      process.env[ENV] = value;
      expect(isJobRuntimeOffGit()).toBe(true);
    }
  });
});
