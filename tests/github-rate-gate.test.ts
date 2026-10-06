import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertGitHubNotPaused,
  clearGitHubPause,
  GitHubPausedError,
  githubPauseRemainingSec,
  noteGitHubRateLimit,
  pauseGitHub,
  resetGitHubRateGateCacheForTests,
} from "../src/gateway/services/githubRateGate.js";

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-gate-"));
  process.env.PAPR_GITHUB_PAUSE_FILE = path.join(dir, "pause.json");
  resetGitHubRateGateCacheForTests();
});
afterEach(() => {
  clearGitHubPause();
  delete process.env.PAPR_GITHUB_PAUSE_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("shared GitHub pause", () => {
  it("is open by default", () => {
    expect(githubPauseRemainingSec()).toBeNull();
    expect(() => assertGitHubNotPaused()).not.toThrow();
  });

  it("a rate limit pauses everyone via the shared file", () => {
    const now = 1_000_000_000_000;
    expect(noteGitHubRateLimit(403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 600) }), "", "test", now)).toBe(600);
    // Another process: fresh cache, same file.
    resetGitHubRateGateCacheForTests();
    expect(() => assertGitHubNotPaused(now + 1000)).toThrow(GitHubPausedError);
    expect(githubPauseRemainingSec(now + 1000)).toBe(599);
  });

  it("memory/writer 429 + Retry-After counts", () => {
    expect(noteGitHubRateLimit(429, h({ "retry-after": "120" }), "", "writer")).toBe(120);
  });

  it("plain 403 (no access) and our own non-GitHub 429 do not pause", () => {
    expect(noteGitHubRateLimit(403, h({ "x-ratelimit-remaining": "4000" }), "Resource not accessible", "t")).toBeNull();
    expect(noteGitHubRateLimit(429, h({}), "Turso database limit reached", "t")).toBeNull();
    expect(githubPauseRemainingSec()).toBeNull();
  });

  it("expires on its own", () => {
    const now = 2_000_000_000_000;
    pauseGitHub(30, "t", now);
    resetGitHubRateGateCacheForTests();
    expect(() => assertGitHubNotPaused(now + 31_000)).not.toThrow();
  });

  it("extends but never shortens, and is capped at an hour", () => {
    const now = 3_000_000_000_000;
    pauseGitHub(600, "long", now);
    pauseGitHub(10, "short", now);
    resetGitHubRateGateCacheForTests();
    expect(githubPauseRemainingSec(now)).toBe(600);
    pauseGitHub(99_999, "huge", now);
    resetGitHubRateGateCacheForTests();
    expect(githubPauseRemainingSec(now)).toBe(3600);
  });

  it("a corrupt file is ignored", () => {
    fs.writeFileSync(process.env.PAPR_GITHUB_PAUSE_FILE!, "{not json");
    expect(() => assertGitHubNotPaused()).not.toThrow();
  });
});
