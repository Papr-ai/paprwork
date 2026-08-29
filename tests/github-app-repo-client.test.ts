import { describe, expect, it } from "vitest";
import {
  resolveGithubRepoObjectPath,
  repoCredentialsCacheTtlMs,
} from "../src/gateway/services/appRuntime/githubAppRepoClient.js";
import type { AppRuntimeRepoCredentials } from "../src/gateway/services/appRuntime/types.js";

describe("githubAppRepoClient", () => {
  const shardCreds: AppRuntimeRepoCredentials = {
    githubOrg: "papr-work",
    repoName: "app-shard-1",
    repoPath: ".",
    token: "ghs_test",
    expiresAt: "2099-01-01T00:00:00.000Z",
    defaultBranch: "main",
  };

  it("maps Sync V3 shard repo paths at repo root", () => {
    expect(resolveGithubRepoObjectPath(shardCreds, "dist/app.js")).toBe(
      "dist/app.js",
    );
  });

  it("prefixes legacy monorepo app paths", () => {
    const legacy: AppRuntimeRepoCredentials = {
      ...shardCreds,
      repoPath: "apps/app-123",
    };
    expect(resolveGithubRepoObjectPath(legacy, "index.html")).toBe(
      "apps/app-123/index.html",
    );
  });

  it("rejects path traversal", () => {
    expect(() => resolveGithubRepoObjectPath(shardCreds, "../secrets.env")).toThrow(
      /Invalid relative path/,
    );
  });

  it("computes credential cache TTL with buffer before expiry", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const ttl = repoCredentialsCacheTtlMs(future);
    expect(ttl).toBeGreaterThan(3_000_000);
    expect(ttl).toBeLessThanOrEqual(3_600_000);
  });
});
