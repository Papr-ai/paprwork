import { describe, expect, it } from "vitest";
import { githubRateLimitWaitSec } from "../src/gateway/services/cloudAppChangeGitHubReview.js";

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

describe("GitHub rate-limit detection", () => {
  it("primary limit: waits until x-ratelimit-reset", () => {
    expect(githubRateLimitWaitSec(403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000" }), "", 400_000)).toBe(600);
  });
  it("secondary limit: honours retry-after", () => {
    expect(githubRateLimitWaitSec(403, h({ "retry-after": "42" }), "secondary rate limit")).toBe(42);
  });
  it("plain 403 (no access) is not a rate limit", () => {
    expect(githubRateLimitWaitSec(403, h({ "x-ratelimit-remaining": "4000" }), "Resource not accessible")).toBeNull();
  });
  it("other statuses are ignored", () => {
    expect(githubRateLimitWaitSec(500, h({}), "rate limit")).toBeNull();
  });
});
