import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/services/workspaceSwitchService.js", () => ({
  getWorkspaceSwitchStatus: vi.fn(() => ({ active: false, phase: "idle" as const })),
}));

import {
  beginWorkspaceReadinessBarrier,
  isWorkspaceCoreReady,
  releaseWorkspaceReadinessBarrier,
  resetWorkspaceReadinessForTests,
  waitForWorkspaceReady,
} from "../src/gateway/services/workspaceReadiness.js";
import { getWorkspaceSwitchStatus } from "../src/gateway/services/workspaceSwitchService.js";

describe("workspaceReadiness", () => {
  afterEach(() => {
    resetWorkspaceReadinessForTests();
    vi.mocked(getWorkspaceSwitchStatus).mockReturnValue({
      active: false,
      phase: "idle",
    });
  });

  it("starts core-ready and wait resolves immediately", async () => {
    expect(isWorkspaceCoreReady()).toBe(true);
    await expect(waitForWorkspaceReady()).resolves.toBeUndefined();
  });

  it("blocks waiters until barrier is released", async () => {
    const gen = beginWorkspaceReadinessBarrier("test switch");
    vi.mocked(getWorkspaceSwitchStatus).mockReturnValue({
      active: true,
      phase: "preparing",
    });

    let released = false;
    const waiting = waitForWorkspaceReady().then(() => {
      released = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(released).toBe(false);

    releaseWorkspaceReadinessBarrier("test complete", gen);
    vi.mocked(getWorkspaceSwitchStatus).mockReturnValue({
      active: false,
      phase: "complete",
    });

    await waiting;
    expect(released).toBe(true);
    expect(isWorkspaceCoreReady()).toBe(true);
  });

  it("ignores stale barrier release from superseded switch", async () => {
    const first = beginWorkspaceReadinessBarrier("switch a");
    const second = beginWorkspaceReadinessBarrier("switch b");

    releaseWorkspaceReadinessBarrier("stale", first);

    let released = false;
    const waiting = waitForWorkspaceReady().then(() => {
      released = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(released).toBe(false);

    releaseWorkspaceReadinessBarrier("current", second);
    await waiting;
    expect(released).toBe(true);
  });
});
