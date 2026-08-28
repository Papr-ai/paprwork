/**
 * Behavioral tests for the central workspace readiness gate and registry write guards.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { Request, Response, NextFunction } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const reconcileRegistryAfterSync = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    tombstonesRemoved: 0,
    duplicatesReconciled: false,
    duplicateIdsRemoved: [] as string[],
  }),
);
const jobsInitialize = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../src/gateway/services/workspaceSwitchService.js", () => ({
  getWorkspaceSwitchStatus: vi.fn(() => ({ active: false, phase: "idle" as const })),
}));

vi.mock("../src/gateway/services/JobsService.js", () => ({
  getJobsService: () => ({
    initialize: jobsInitialize,
    reconcileRegistryAfterSync,
  }),
}));

import {
  beginWorkspaceReadinessBarrier,
  releaseWorkspaceReadinessBarrier,
  resetWorkspaceReadinessForTests,
  workspaceReadinessMiddleware,
} from "../src/gateway/services/workspaceReadiness.js";
import { reconcileJobsRegistryAfterSync } from "../src/gateway/services/jobs/jobsRegistryReconcile.js";
import { getWorkspaceSwitchStatus } from "../src/gateway/services/workspaceSwitchService.js";
import {
  bumpWorkspaceWriteGeneration,
  resetWorkspaceWriteGenerationForTests,
} from "../src/gateway/services/workspaceWriteGuard.js";
import { AppService } from "../src/gateway/services/AppService.js";
import {
  getDatabaseRegistryService,
  resetDatabaseRegistryForWorkspaceSwitch,
} from "../src/gateway/services/DatabaseRegistryService.js";

describe("workspaceReadinessMiddleware", () => {
  afterEach(() => {
    resetWorkspaceReadinessForTests();
    vi.mocked(getWorkspaceSwitchStatus).mockReturnValue({
      active: false,
      phase: "idle",
    });
  });

  function runMiddleware(pathname: string): {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    next: ReturnType<typeof vi.fn>;
  } {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();
    const req = { path: pathname } as Request;
    const res = { status, json } as unknown as Response;
    workspaceReadinessMiddleware(req, res, next as NextFunction);
    return { status, json, next };
  }

  it("returns 503 for /api routes while the readiness barrier is raised", () => {
    beginWorkspaceReadinessBarrier("test switch");
    vi.mocked(getWorkspaceSwitchStatus).mockReturnValue({
      active: true,
      phase: "preparing",
    });

    const { status, json, next } = runMiddleware("/api/apps");
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Workspace switch in progress" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("allows /health and /api/workspace during a switch", () => {
    beginWorkspaceReadinessBarrier("test switch");
    vi.mocked(getWorkspaceSwitchStatus).mockReturnValue({
      active: true,
      phase: "preparing",
    });

    const health = runMiddleware("/health");
    expect(health.next).toHaveBeenCalled();
    expect(health.status).not.toHaveBeenCalled();

    const workspace = runMiddleware("/api/workspace/switch");
    expect(workspace.next).toHaveBeenCalled();
    expect(workspace.status).not.toHaveBeenCalled();
  });

  it("allows /api routes after the barrier is released", () => {
    const gen = beginWorkspaceReadinessBarrier("test switch");
    releaseWorkspaceReadinessBarrier("done", gen);

    const { next, status } = runMiddleware("/api/jobs");
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});

describe("registry write guards during workspace switch", () => {
  const workspace = useIsolatedPaprWorkspace("readiness-guards");

  afterEach(() => {
    resetWorkspaceWriteGenerationForTests();
    resetDatabaseRegistryForWorkspaceSwitch();
  });

  it("AppService.saveApps skips disk writes after write generation bump", async () => {
    const appService = new AppService();
    await appService.initialize();

    const created = await appService.createApp("Guard Test", "Desc", [
      { filename: "index.html", content: "<h1>Hi</h1>" },
    ]);
    const indexPath = path.join(workspace.paprHome, "data", "apps.json");
    const before = await fs.readFile(indexPath, "utf8");

    bumpWorkspaceWriteGeneration("test switch");
    await appService.updateApp(created.id, { title: "Should Not Persist" });

    const after = await fs.readFile(indexPath, "utf8");
    expect(after).toBe(before);

    appService.cleanup();
  });

  it("DatabaseRegistry.save skips disk writes after write generation bump", async () => {
    const registry = getDatabaseRegistryService();
    await registry.initialize();

    await registry.register({
      localPath: "jobs/alpha/data/data.db",
      label: "Alpha",
    });
    const registryPath = registry.getRegistryPath();
    const before = await fs.readFile(registryPath, "utf8");

    bumpWorkspaceWriteGeneration("test switch");
    await registry.register({
      localPath: "jobs/beta/data/data.db",
      label: "Beta",
    });

    const after = await fs.readFile(registryPath, "utf8");
    expect(after).toBe(before);
  });
});

describe("background work waits on readiness gate", () => {
  afterEach(() => {
    resetWorkspaceReadinessForTests();
    reconcileRegistryAfterSync.mockClear();
    jobsInitialize.mockClear();
  });

  it("reconcileJobsRegistryAfterSync waits until barrier opens", async () => {
    const gen = beginWorkspaceReadinessBarrier("test switch");
    const promise = reconcileJobsRegistryAfterSync();

    await new Promise((r) => setTimeout(r, 30));
    expect(reconcileRegistryAfterSync).not.toHaveBeenCalled();

    releaseWorkspaceReadinessBarrier("done", gen);
    await promise;

    expect(jobsInitialize).toHaveBeenCalled();
    expect(reconcileRegistryAfterSync).toHaveBeenCalled();
  });
});
