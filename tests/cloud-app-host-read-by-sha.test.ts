import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/services/appRuntime/memoryRuntimeClient.js", () => ({
  fetchRuntimeRepoFile: vi.fn(async () => null),
  fetchRuntimeRepoCredentials: vi.fn(async () => ({
    githubOrg: "papr-work",
    repoName: "app-1",
    repoPath: ".",
    token: "ghs_test",
    expiresAt: "2099-01-01T00:00:00.000Z",
    defaultBranch: "main",
  })),
}));

import {
  fetchCachedRuntimeRepoFile,
  invalidateRepoCacheForPublishedApp,
  pinPublishedAppCommit,
  resetCloudAppHostCachesForTests,
} from "../src/gateway/services/appRuntime/cloudAppHostCache.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const auth = { namespaceId: "ns", slug: "app" };

function stubGithub(head: () => string) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url.startsWith("https://api.github.com/")) return new Response(head(), { status: 200 });
    const ref = url.split("/")[5];
    return new Response(`code@${ref}`, { status: 200, headers: { "content-type": "text/javascript" } });
  }));
  return urls;
}

afterEach(() => {
  resetCloudAppHostCachesForTests();
  vi.unstubAllGlobals();
});

describe("cloud app host reads published files by commit SHA (spike S5)", () => {
  it("reads raw files at the head SHA, never the branch name", async () => {
    const urls = stubGithub(() => SHA_A);
    const file = await fetchCachedRuntimeRepoFile(auth, "dist/app.js");
    expect(file?.content).toBe(`code@${SHA_A}`);
    const raw = urls.filter((u) => u.includes("raw.githubusercontent.com"));
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((u) => u.includes(`/${SHA_A}/`) && !u.includes("/main/"))).toBe(true);
  });

  it("switches to the SHA from the publish notify on the very next request", async () => {
    let head = SHA_A;
    stubGithub(() => head);
    expect((await fetchCachedRuntimeRepoFile(auth, "dist/app.js"))?.content).toBe(`code@${SHA_A}`);

    head = SHA_A; // GitHub API not yet consulted again — pin must win
    invalidateRepoCacheForPublishedApp("ns", "app");
    pinPublishedAppCommit("ns", "app", SHA_B);
    expect((await fetchCachedRuntimeRepoFile(auth, "dist/app.js"))?.content).toBe(`code@${SHA_B}`);
  });

  it("ignores a malformed SHA in the notify", async () => {
    stubGithub(() => SHA_A);
    pinPublishedAppCommit("ns", "app", "main");
    expect((await fetchCachedRuntimeRepoFile(auth, "dist/app.js"))?.content).toBe(`code@${SHA_A}`);
  });
});

describe("head lookup failure falls back without breaking reads", () => {
  it("reads by branch when the head lookup 403s, and by SHA once a commit is pinned", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.startsWith("https://api.github.com/")) {
        return new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
      }
      const ref = url.split("/")[5];
      return new Response(`code@${ref}`, { status: 200, headers: { "content-type": "text/javascript" } });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await fetchCachedRuntimeRepoFile(auth, "dist/app.js"))?.content).toBe("code@main");
    invalidateRepoCacheForPublishedApp("ns", "app");
    pinPublishedAppCommit("ns", "app", SHA_B);
    expect((await fetchCachedRuntimeRepoFile(auth, "dist/app.js"))?.content).toBe(`code@${SHA_B}`);
  });
});

describe("pinned commit keys the file cache", () => {
  it("uses the pinned SHA as the cache revision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 404 })));
    invalidateRepoCacheForPublishedApp("ns", "app");
    pinPublishedAppCommit("ns", "app", SHA_B);
    const { resolveAppCacheRevision } = await import("../src/gateway/services/appRuntime/cloudAppHostCache.js");
    expect(await resolveAppCacheRevision(auth)).toBe(SHA_B);
  });
});

describe("pinned commit survives bypass refreshes and the snapshot warm", () => {
  it("bypass revision resolution still returns the pinned SHA", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 404 })));
    invalidateRepoCacheForPublishedApp("ns", "app");
    pinPublishedAppCommit("ns", "app", SHA_B);
    const { resolveAppCacheRevision } = await import("../src/gateway/services/appRuntime/cloudAppHostCache.js");
    expect(await resolveAppCacheRevision(auth, true)).toBe(SHA_B);
    // a credential-less caller (the deploy-snapshot warm) sees the same pin
    expect(await resolveAppCacheRevision({ namespaceId: "ns", slug: "app" }, true)).toBe(SHA_B);
    expect(await resolveAppCacheRevision(auth)).toBe(SHA_B);
  });
});
