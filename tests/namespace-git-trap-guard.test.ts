import { describe, expect, it } from "vitest";
import {
  buildNamespaceGitTrapWarning,
  detectNamespaceGitTrapCommand,
} from "../src/core/utils/namespaceGitTrapGuard.js";
import {
  extractAppIdFromRepoPath,
  normalizePerAppRepoRelativePath,
} from "../src/gateway/services/cloudSync/appWriterRepoObservability.js";

const APP_ID = "4fea25e9-5fba-4ce0-9ca9-fa24d6713486";

describe("detectNamespaceGitTrapCommand", () => {
  it("flags git ls-files under apps/", () => {
    expect(detectNamespaceGitTrapCommand("git ls-files apps/")).toBe(true);
    expect(
      detectNamespaceGitTrapCommand(`git ls-files 'apps/${APP_ID}/'`),
    ).toBe(true);
  });

  it("flags git status and ls-tree on apps paths", () => {
    expect(detectNamespaceGitTrapCommand(`git status apps/${APP_ID}`)).toBe(
      true,
    );
    expect(
      detectNamespaceGitTrapCommand(`git ls-tree -r HEAD apps/${APP_ID}`),
    ).toBe(true);
  });

  it("does not flag unrelated git commands", () => {
    expect(detectNamespaceGitTrapCommand("git status")).toBe(false);
    expect(detectNamespaceGitTrapCommand("git log -1")).toBe(false);
    expect(detectNamespaceGitTrapCommand("grep -r foo apps/")).toBe(false);
  });

  it("includes guidance in warning block", () => {
    expect(buildNamespaceGitTrapWarning()).toMatch(/get_cloud_sync_status/);
    expect(buildNamespaceGitTrapWarning()).toMatch(/inspect_cloud_repo/);
  });
});

describe("normalizePerAppRepoRelativePath", () => {
  it("strips apps/{appId}/ prefix and infers app id", () => {
    const result = normalizePerAppRepoRelativePath(
      `apps/${APP_ID}/dist/app.js`,
    );
    expect(result.path).toBe("dist/app.js");
    expect(result.inferredAppId).toBe(APP_ID);
  });

  it("rejects mismatched appId", () => {
    const other = "11111111-1111-1111-1111-111111111111";
    expect(() =>
      normalizePerAppRepoRelativePath(`apps/${APP_ID}/dist/app.js`, other),
    ).toThrow(/Pass one app only/i);
  });

  it("extracts app id from repo paths", () => {
    expect(extractAppIdFromRepoPath(`apps/${APP_ID}/backend/`)).toBe(APP_ID);
    expect(extractAppIdFromRepoPath("data/apps.json")).toBeNull();
  });
});
