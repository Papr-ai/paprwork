import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CloudSyncService } from "../src/gateway/services/CloudSyncService.js";

const mockApplyLocalMigrations = vi.fn();
const mockPushAppLinkedSources = vi.fn();
const mockVerifyAppPushConvergence = vi.fn();
const mockAssertAppPushVerified = vi.fn();
const mockRunConvergenceCheckForApp = vi.fn();
const mockWebReady = vi.fn();

vi.mock("../src/gateway/services/cloudSync/applyLocalMigrationsForApp.js", () => ({
  applyLocalMigrationsForApp: (...args: unknown[]) =>
    mockApplyLocalMigrations(...args),
}));

vi.mock("../src/gateway/services/TursoSyncBridge.js", () => ({
  getTursoSyncBridge: () => ({
    pushAppLinkedSources: mockPushAppLinkedSources,
  }),
}));

vi.mock("../src/gateway/services/cloudSync/postPushVerify.js", () => ({
  verifyAppPushConvergence: (...args: unknown[]) =>
    mockVerifyAppPushConvergence(...args),
  assertAppPushVerified: (...args: unknown[]) =>
    mockAssertAppPushVerified(...args),
}));

vi.mock("../src/gateway/services/cloudSync/convergenceChecker.js", () => ({
  runConvergenceCheckForApp: (...args: unknown[]) =>
    mockRunConvergenceCheckForApp(...args),
}));

vi.mock("../src/gateway/services/cloudSync/webReady.js", () => ({
  webReady: (...args: unknown[]) => mockWebReady(...args),
}));

import { flushAppNow } from "../src/gateway/services/cloudSync/flushAppNow.js";

describe("flushAppNow", () => {
  const sync = {
    getPaprDir: () => "/tmp/papr",
    pushGitNow: vi.fn().mockResolvedValue(undefined),
    markAppForPostFlushHooks: vi.fn(),
    runPostFlushHooks: vi.fn().mockResolvedValue(undefined),
    runGit: vi.fn(),
  } as unknown as CloudSyncService;

  beforeEach(() => {
    mockApplyLocalMigrations.mockResolvedValue([]);
    mockPushAppLinkedSources.mockResolvedValue({
      pushed: 1,
      skipped: 0,
      failed: 0,
      results: [],
    });
    mockVerifyAppPushConvergence.mockResolvedValue({ ok: true, errors: [] });
    mockAssertAppPushVerified.mockResolvedValue(undefined);
    mockRunConvergenceCheckForApp.mockResolvedValue(undefined);
    mockWebReady.mockResolvedValue({ ready: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs Turso push before git and skips post-sync hooks during git", async () => {
    const callOrder: string[] = [];
    mockPushAppLinkedSources.mockImplementation(async () => {
      callOrder.push("turso");
      return { pushed: 1, skipped: 0, failed: 0, results: [] };
    });
    vi.mocked(sync.pushGitNow).mockImplementation(async () => {
      callOrder.push("git");
    });
    mockAssertAppPushVerified.mockImplementation(async () => {
      callOrder.push("verify");
    });

    await flushAppNow(sync, "app-1");

    expect(callOrder).toEqual(["turso", "git", "verify"]);
    expect(sync.pushGitNow).toHaveBeenCalledWith({
      appId: "app-1",
      skipPostSyncHooks: true,
    });
    expect(sync.runPostFlushHooks).toHaveBeenCalled();
  });

  it("does not publish when not web-ready", async () => {
    mockWebReady.mockResolvedValue({
      ready: false,
      reason: "turso_pending",
      detail: "main: pending",
    });

    const result = await flushAppNow(sync, "app-1");

    expect(result.webReady).toBe(false);
    expect(result.published).toBe(false);
    expect(sync.runPostFlushHooks).not.toHaveBeenCalled();
  });
});
