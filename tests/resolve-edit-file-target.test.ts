import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import { resolveEditFileTarget } from "../src/core/utils/resolveEditFileTarget.js";

describe("resolveEditFileTarget", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `papr-edit-target-${Date.now()}`);
    origHome = process.env.PAPR_HOME;
    process.env.PAPR_HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.PAPR_HOME;
    } else {
      process.env.PAPR_HOME = origHome;
    }
  });

  it("classifies mini-app paths", () => {
    const file = path.join(tmpHome, "apps", "app-1", "index.html");
    const target = resolveEditFileTarget(file);
    expect(target).toEqual({
      kind: "mini_app",
      appId: "app-1",
      filename: "index.html",
      resolvedPath: path.resolve(file),
    });
  });

  it("classifies job paths", () => {
    const file = path.join(tmpHome, "Jobs", "job-1", "code", "main.py");
    const target = resolveEditFileTarget(file);
    expect(target).toEqual({
      kind: "job",
      jobId: "job-1",
      filename: "code/main.py",
      resolvedPath: path.resolve(file),
    });
  });

  it("classifies external repo paths", () => {
    const file = "/Users/dev/github/paprwork-v2/src/core/tools/bash.ts";
    const target = resolveEditFileTarget(file);
    expect(target).toEqual({
      kind: "external",
      resolvedPath: path.resolve(file),
    });
  });

  it("blocks mini-app dist edits", () => {
    const file = path.join(tmpHome, "apps", "app-1", "dist", "app.js");
    const target = resolveEditFileTarget(file);
    expect(target.kind).toBe("blocked");
  });
});
