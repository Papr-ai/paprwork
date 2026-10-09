import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  pinPublishedAppCommit,
  resetCloudAppHostCachesForTests,
} from "../src/gateway/services/appRuntime/cloudAppHostCache.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const T0 = Date.UTC(2026, 0, 1);

type ApiReply = (init: RequestInit | undefined) => Response;
interface Gh {
  api: Array<{ url: string; ifNoneMatch?: string }>;
  reply: ApiReply;
}

function stubGithub(reply: ApiReply): Gh {
  const gh: Gh = { api: [], reply };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://api.github.com/")) {
        const h = (init?.headers ?? {}) as Record<string, string>;
        gh.api.push({ url, ifNoneMatch: h["If-None-Match"] });
        return gh.reply(init);
      }
      const ref = url.split("/")[5];
      return new Response(`code@${ref}`, { status: 200, headers: { "content-type": "text/javascript" } });
    }),
  );
  return gh;
}

const ok = (sha: string) => () => new Response(sha, { status: 200, headers: { etag: `"${sha}"` } });
const notModified = () => () => new Response(null, { status: 304 });
const rateLimited = (resetSec: number) => () =>
  new Response('{"message":"API rate limit exceeded"}', {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSec) },
  });
const forbidden = () => () =>
  new Response('{"message":"Resource not accessible by integration"}', {
    status: 403,
    headers: { "x-ratelimit-remaining": "4000" },
  });

const read = (slug = "app", path = "dist/app.js") =>
  fetchCachedRuntimeRepoFile({ namespaceId: "ns", slug }, path).then((f) => f?.content);
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  resetCloudAppHostCachesForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("head lookups revalidate with ETag (#4)", () => {
  it("first lookup is unconditional; after the 60s window it sends If-None-Match", async () => {
    const gh = stubGithub(ok(SHA_A));
    expect(await read()).toBe(`code@${SHA_A}`);
    expect(gh.api).toHaveLength(1);
    expect(gh.api[0].ifNoneMatch).toBeUndefined();

    gh.reply = notModified();
    advance(61_000);
    expect(await read("app", "index.html")).toBe(`code@${SHA_A}`);
    expect(gh.api).toHaveLength(2);
    expect(gh.api[1].ifNoneMatch).toBe(`"${SHA_A}"`);
  });

  it("within the 60s window there is no lookup at all", async () => {
    const gh = stubGithub(ok(SHA_A));
    await read();
    advance(30_000);
    await read("app", "index.html");
    expect(gh.api).toHaveLength(1);
  });

  it("a moved branch (200 on the conditional request) switches to the new commit", async () => {
    const gh = stubGithub(ok(SHA_A));
    await read();
    gh.reply = ok(SHA_B);
    advance(61_000);
    expect(await read("app", "index.html")).toBe(`code@${SHA_B}`);
    advance(61_000);
    gh.reply = notModified();
    await read("app", "other.js");
    expect(gh.api.at(-1)?.ifNoneMatch).toBe(`"${SHA_B}"`);
  });

  it("does not send Cache-Control: no-cache (it would defeat the 304)", async () => {
    let sent: Record<string, string> = {};
    stubGithub((init) => {
      sent = (init?.headers ?? {}) as Record<string, string>;
      return ok(SHA_A)();
    });
    await read();
    expect(sent["Cache-Control"]).toBeUndefined();
  });
});

describe("head lookups stop while GitHub's budget is zero (#5)", () => {
  it("one rate-limit 403 pauses lookups for every app until reset, serving the last known commit", async () => {
    const gh = stubGithub(ok(SHA_A));
    await read("app");
    const resetSec = Math.floor(T0 / 1000) + 600;
    gh.reply = rateLimited(resetSec);
    advance(61_000);
    expect(await read("app", "index.html")).toBe(`code@${SHA_A}`); // last known, not branch
    const callsAfterLimit = gh.api.length;

    for (let i = 0; i < 5; i += 1) {
      advance(61_000);
      expect(await read("app", `f${i}.js`)).toBe(`code@${SHA_A}`);
      expect(await read("other-app", `f${i}.js`)).toBe("code@main"); // never resolved: branch read
    }
    expect(gh.api.length).toBe(callsAfterLimit); // zero GitHub API calls while paused

    vi.setSystemTime(resetSec * 1000 + 1_000);
    gh.reply = notModified();
    await read("app", "after.js");
    expect(gh.api.length).toBe(callsAfterLimit + 1);
  });

  it("a permission 403 with budget left does NOT pause other apps", async () => {
    const gh = stubGithub(forbidden());
    expect(await read("app")).toBe("code@main");
    gh.reply = ok(SHA_B);
    expect(await read("other-app")).toBe(`code@${SHA_B}`);
    expect(gh.api).toHaveLength(2);
  });

  it("a permission 403 after a good answer keeps serving the last known commit", async () => {
    const gh = stubGithub(ok(SHA_A));
    await read();
    gh.reply = forbidden();
    advance(61_000);
    expect(await read("app", "index.html")).toBe(`code@${SHA_A}`);
  });

  it("the pause is capped at one hour even if reset is far away", async () => {
    const gh = stubGithub(rateLimited(Math.floor(T0 / 1000) + 10 * 3600));
    await read("app");
    const n = gh.api.length;
    advance(59 * 60_000);
    await read("app2");
    expect(gh.api.length).toBe(n);
    advance(2 * 60_000);
    gh.reply = ok(SHA_A);
    expect(await read("app3")).toBe(`code@${SHA_A}`);
    expect(gh.api.length).toBe(n + 1);
  });
});

describe("publish pins and the last known commit", () => {
  it("an expired pin during a rate-limit pause serves the pinned commit, not the older head", async () => {
    const gh = stubGithub(ok(SHA_A));
    await read("app");                          // head = A
    pinPublishedAppCommit("ns", "app", SHA_B);  // publish B
    gh.reply = rateLimited(Math.floor(T0 / 1000) + 3600);
    await read("other-app");                    // trips the pause
    advance(11 * 60_000);                       // pin (10 min) expired, still paused
    expect(await read("app", "late.js")).toBe(`code@${SHA_B}`);
  });

  it("after a pin, the next lookup is unconditional (no stale ETag)", async () => {
    const gh = stubGithub(ok(SHA_A));
    await read("app");
    pinPublishedAppCommit("ns", "app", SHA_B);
    advance(11 * 60_000);
    gh.reply = ok(SHA_B);
    await read("app", "x.js");
    expect(gh.api.at(-1)?.ifNoneMatch).toBeUndefined();
  });
});
