/**
 * Workspace switch must return HTTP quickly — heavy teardown runs in background.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("workspace switch gateway handler", () => {
  it("returns before resetPathBoundSingletons — teardown is background-only", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/workspaceSwitchService.ts"),
      "utf-8",
    );

    const switchFn = content.slice(
      content.indexOf("export async function switchActiveWorkspace"),
      content.indexOf("/** Cloud sync, Turso, and vault"),
    );

    expect(switchFn).toContain("cancelActiveAgentStreamsQuick");
    expect(switchFn).toContain("stopActiveJobsBeforeWorkspaceSwitch");
    expect(switchFn).toContain("bumpWorkspaceWriteGeneration");
    expect(switchFn).toMatch(
      /stopActiveJobsBeforeWorkspaceSwitch\(\)[\s\S]*bumpWorkspaceWriteGeneration[\s\S]*pauseWorkspaceSwitchWriters\(\)[\s\S]*activateWorkspacePointer/,
    );
    expect(switchFn).not.toMatch(/await resetPathBoundSingletons\(\)/);
    expect(switchFn).toContain("void finishWorkspaceSwitchInBackground");
  });

  it("invalidates in-flight writers and publish client before pointer change", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/workspaceSwitchService.ts"),
      "utf-8",
    );

    const pauseFn = content.slice(
      content.indexOf("async function pauseWorkspaceSwitchWriters"),
      content.indexOf("const WORKSPACE_SWITCH_JOB_STOP_REASON"),
    );

    expect(pauseFn).toContain("resetCloudSyncServiceForWorkspaceSwitch");
    expect(pauseFn).toContain("cancelAllScheduledTursoPushes");
    expect(pauseFn).toContain("resetCloudAppPublishServiceForWorkspaceSwitch");
  });

  it("runs resetPathBoundSingletons in background before phased reinit", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/workspaceSwitchService.ts"),
      "utf-8",
    );

    const bgFn = content.slice(
      content.indexOf("async function finishWorkspaceSwitchInBackground"),
      content.indexOf("export async function switchActiveWorkspace"),
    );

    const resetIdx = bgFn.indexOf("await resetPathBoundSingletons()");
    const initIdx = bgFn.indexOf("await initializeWorkspaceServicesPhased");
    expect(resetIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(resetIdx);
  });

  it("restarts job scheduler after background workspace reinit", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/workspaceSwitchService.ts"),
      "utf-8",
    );

    const bgFn = content.slice(
      content.indexOf("async function finishWorkspaceSwitchInBackground"),
      content.indexOf("export async function switchActiveWorkspace"),
    );

    expect(bgFn).toContain("getJobsScheduler().start()");
  });

  it("ensures sleep and wiki writer jobs after workspace reinit", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/workspaceSwitchService.ts"),
      "utf-8",
    );

    const initFn = content.slice(
      content.indexOf("async function initializePathBoundServices"),
      content.indexOf("async function runPostMigrationPathRepairIfNeeded"),
    );

    expect(initFn).toContain("await getWorkspaceService().ensureSleepJob()");
    expect(initFn).toContain("await getWorkspaceService().ensureWikiWriterJob()");
  });

  it("yields during resetPathBoundSingletons for /health responsiveness", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/gateway/services/workspaceSwitchService.ts"),
      "utf-8",
    );

    const resetFn = content.slice(
      content.indexOf("async function resetPathBoundSingletons"),
      content.indexOf("async function initializePathBoundServices"),
    );

    expect(resetFn.match(/await yieldEventLoop\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(
      3,
    );
  });
});

describe("electron workspace switch recovery", () => {
  it("retries gateway POST and can restart on failure", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/electron/ipc/paprWorkspace.ts"),
      "utf-8",
    );

    expect(content).toContain("postWorkspaceSwitchRequest");
    expect(content).toContain("WORKSPACE_SWITCH_FETCH_RETRIES");
    expect(content).toContain("setGatewayRestartAfterWorkspaceSwitch");
    expect(content).toContain("restartGatewayAfterWorkspaceSwitch");
  });

  it("supervisor refreshes workspace env on each spawn", () => {
    const content = fs.readFileSync(
      path.join(SRC, "src/electron/index.cjs"),
      "utf-8",
    );

    expect(content).toContain("_resolveSpawnEnv");
    expect(content).toContain("readActiveWorkspaceEnv");
    expect(content).toContain("restartForWorkspaceSwitch");
  });
});
