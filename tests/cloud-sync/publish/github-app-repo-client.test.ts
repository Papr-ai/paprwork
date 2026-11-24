import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGithubBranchHead,
  fetchGithubBranchHeadSha,
  GithubRateLimitError,
  resolveGithubRepoObjectPath,
  repoCredentialsCacheTtlMs,
} from "../../../src/gateway/services/appRuntime/githubAppRepoClient.js";
import type { AppRuntimeRepoCredentials } from "../../../src/gateway/services/appRuntime/types.js";

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

describe("fetchGithubBranchHead", () => {
  const creds: AppRuntimeRepoCredentials = {
    githubOrg: "papr-work",
    repoName: "app-shard-1",
    repoPath: ".",
    token: "ghs_test",
    expiresAt: "2099-01-01T00:00:00.000Z",
    defaultBranch: "main",
  };
  const SHA = "c".repeat(40);
  afterEach(() => vi.unstubAllGlobals());

  it("returns sha + etag, and sends If-None-Match when given an etag", async () => {
    const f = vi.fn(async () => new Response(SHA, { status: 200, headers: { etag: '"e1"' } }));
    vi.stubGlobal("fetch", f);
    expect(await fetchGithubBranchHead(creds)).toEqual({ notModified: false, sha: SHA, etag: '"e1"' });
    await fetchGithubBranchHead(creds, { etag: '"e1"' });
    expect((f.mock.calls[1][1] as RequestInit).headers).toMatchObject({ "If-None-Match": '"e1"' });
  });

  it("304 with an etag is notModified", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    expect(await fetchGithubBranchHead(creds, { etag: '"e1"' })).toEqual({ notModified: true });
  });

  it("403 with remaining=0 throws GithubRateLimitError carrying the reset time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate", {
      status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
    })));
    const err = await fetchGithubBranchHead(creds).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect(err.resetAt).toBe(2_000_000_000_000);
  });

  it("403 with budget left is a plain error, not a rate limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", {
      status: 403, headers: { "x-ratelimit-remaining": "4000" },
    })));
    const err = await fetchGithubBranchHead(creds).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GithubRateLimitError);
  });

  it("fetchGithubBranchHeadSha still returns a plain sha", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(SHA, { status: 200 })));
    expect(await fetchGithubBranchHeadSha(creds)).toBe(SHA);
  });
});
