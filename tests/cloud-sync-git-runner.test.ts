import { describe, expect, test } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("CloudSync git runner", () => {
  test("CloudSyncService uses async gitRunner instead of execSync", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/CloudSyncService.ts"),
      "utf-8",
    );
    expect(content).toContain("GitRunner");
    expect(content).toContain("probeGitInstalled");
    expect(content).not.toContain("execSync");
    expect(content).toContain("await this.git(");
  });

  test("gitRunner serializes operations through a promise chain", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/gitRunner.ts"),
      "utf-8",
    );
    expect(content).toContain("spawn(");
    expect(content).not.toMatch(/import\s*\{[^}]*execSync/);
    expect(content).toContain("private chain:");
    expect(content).toContain("isRepoAtRoot");
  });

  test("CloudSyncService uses workspace-local git, not parent repo", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/CloudSyncService.ts"),
      "utf-8",
    );
    expect(content).toContain("hasWorkspaceGitAtRoot");
    expect(content).toContain("getForeignGitRoot");
    expect(content).toContain("await this.callReposInit()");
    expect(content).toContain('buildCloudReposRequestBody("user")');
    expect(content).toContain("provisionCloudRepo");
  });
});
