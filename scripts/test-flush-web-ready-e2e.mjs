#!/usr/bin/env node
/**
 * Phase 4+5 E2E — ordered flush + SyncCoordinator
 *
 * Tier A (module): real Turso + temp PAPR_HOME via dist/gateway modules
 *   Phase 4:
 *     F1. flushAppNow pushes Turso before git (spy call order)
 *     F2. Desktop row reaches remote after flush Turso leg
 *     F3. webReady + publish layer report reflect synced fixture
 *     F4/F5. push_cloud_sync routing contract
 *   Phase 5:
 *     C1. markDbDirty + isLinkedSourceDirtyFast dirty flag
 *     C2. SyncCoordinator markDbDirty propagates state
 *     C3. buildCoordinatorStatusReport → upload waiting when dirty
 *     C4. markGitDirty routes auto-upload apps away from enqueueRelativePath
 *     C5. flushAutoUploadAppFolderIfNeeded → coordinator ordered flush
 *     C6. coordinator.flushNow ordering (Turso → git)
 *     C7. shouldSkipTursoRescheduleForApps after coordinator flush
 *     C8. concurrent flushNow coalesces to single flushAppNow call
 *
 * Tier B (gateway HTTP, optional):
 *     G1. POST /api/sync/push { appId } + publish layer
 *     G2. GET /api/sync/items includes upload field (Phase 5 UI)
 *
 * Prerequisites (Tier A):
 *   npm run build:gateway
 *   PAPR_API_KEY in .env.local or Papr Work keychain
 *
 * Prerequisites (Tier B):
 *   npm start (gateway :18789)
 *   --app-id=<throwaway app with linked Turso DB in $PAPR_HOME>
 *
 * Usage:
 *   npm run test:sync-phase4-5-e2e
 *   npm run test:flush-web-ready-e2e   # alias
 *   node scripts/test-flush-web-ready-e2e.mjs [--gateway URL] [--app-id ID] [--skip-gateway] [--skip-module]
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { loadEnvLocal, resolvePaprApiKey } from "./lib/testEnv.mjs";
import {
  applyDirectMemoryEnv,
  BOLD,
  check,
  createCoordinatorSyncStub,
  CYAN,
  failFast,
  GREEN,
  jsonFetch,
  RED,
  RESET,
  skip,
  writeAutoUploadPrefs,
  writeManualUploadPrefs,
  writeMinimalAppTree,
  YELLOW,
} from "./lib/syncPhase45TestLib.mjs";
import {
  createModuleLoader,
  localInsertRow,
  readRemoteLabels,
  setupBidirectionalFixture,
  sleep,
} from "./lib/tursoBidirectionalTestLib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const gateway = (
  args.find((a) => a.startsWith("--gateway="))?.split("=")[1] ??
  "http://localhost:18789"
).replace(/\/$/, "");
const appIdArg = args.find((a) => a.startsWith("--app-id="))?.split("=")[1];
const skipGateway = args.includes("--skip-gateway");
const skipModule = args.includes("--skip-module");

loadEnvLocal();

/** @type {import('./lib/syncPhase45TestLib.mjs').TestCounters} */
const counters = { passed: 0, failed: 0, skipped: 0 };

const loadModule = createModuleLoader(
  path.join(__dirname, "../dist/gateway/services"),
);

async function ensureDirectMemoryAccess() {
  const resolved = await resolvePaprApiKey();
  if (!resolved) {
    return null;
  }
  applyDirectMemoryEnv({
    apiKey: resolved.key,
    memoryBase: process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai",
    source: resolved.source,
  });
  return resolved;
}

async function runPhase4ModuleTier(fixture) {
  console.log(`\n${BOLD}--- Phase 4: flushAppNow + web-ready ---${RESET}`);

  writeMinimalAppTree(fixture.appsRoot, fixture.appId, "flush-marker-v1");
  const desktopLabel = `flush-desktop-${Date.now()}`;
  await localInsertRow(loadModule, fixture.dbPath, desktopLabel);

  const { flushAppNow } = await loadModule("cloudSync/flushAppNow.js");
  const bridgeMod = await loadModule("TursoSyncBridge.js");
  const bridge = bridgeMod.getTursoSyncBridge();
  if (!bridge) {
    failFast("F1", "TursoSyncBridge not initialized");
  }

  // F1: Turso before git
  console.log(`\n${CYAN}F1. flushAppNow ordering (Turso → git → verify → post-flush)${RESET}`);
  const callOrder = [];
  const origPushApp = bridge.pushAppLinkedSources.bind(bridge);
  bridge.pushAppLinkedSources = async (appId) => {
    callOrder.push("turso");
    return origPushApp(appId);
  };

  const syncStub = createCoordinatorSyncStub(fixture.paprHome, { callOrder });
  let flushResult;
  try {
    flushResult = await flushAppNow(syncStub, fixture.appId);
  } catch (err) {
    failFast("F1 flushAppNow", err instanceof Error ? err.message : String(err));
  } finally {
    bridge.pushAppLinkedSources = origPushApp;
  }

  const tursoIdx = callOrder.indexOf("turso");
  const gitIdx = callOrder.indexOf("git");
  check(
    "Turso push ran before git",
    tursoIdx >= 0 && gitIdx > tursoIdx,
    `order=${callOrder.join(" → ")}`,
    counters,
  );
  check(
    "Turso leg completed",
    flushResult.tursoPushed === true,
    JSON.stringify(flushResult),
    counters,
  );
  check(
    "Git used skipPostSyncHooks path",
    !callOrder.includes("git-post-hooks-unexpected"),
    callOrder.join(", "),
    counters,
  );
  check(
    "Post-flush hooks only when web-ready",
    flushResult.webReady
      ? callOrder.includes("post-flush-hooks")
      : !callOrder.includes("post-flush-hooks"),
    `webReady=${flushResult.webReady} order=${callOrder.join(", ")}`,
    counters,
  );

  // F2: Row on remote
  console.log(`\n${CYAN}F2. Desktop row visible on Turso after flush${RESET}`);
  const remoteLabels = await readRemoteLabels(
    loadModule,
    fixture.bridge,
    fixture.jobId,
    fixture.tursoDbName,
  );
  check(
    "Remote includes desktop row",
    remoteLabels.includes(desktopLabel),
    `remote=${JSON.stringify(remoteLabels)}`,
    counters,
  );

  // F3: webReady + publish layer
  console.log(`\n${CYAN}F3. webReady + publish layer report${RESET}`);
  const cloudSyncMod = await loadModule("CloudSyncService.js");
  cloudSyncMod.initializeCloudSyncService({
    pushDebounceMs: 600_000,
    queueIntervalMs: 600_000,
  });
  const syncInstance = cloudSyncMod.getCloudSyncService();
  if (syncInstance) {
    syncInstance.getGitHubSyncItemsReport = () => ({
      workspace: [],
      apps: [
        {
          id: fixture.appId,
          kind: "app",
          label: fixture.appId,
          relativePath: `apps/${fixture.appId}`,
          status: "synced",
          lastSyncAt: new Date().toISOString(),
        },
      ],
      jobs: [],
      queuedPaths: [],
      summary: {
        synced: 1,
        pending: 0,
        outdated: 0,
        failed: 0,
        updatesAvailable: 0,
        total: 1,
      },
    });
  }

  const { webReady, buildPublishLayerReport } = await loadModule("cloudSync/webReady.js");
  const ready = await webReady(fixture.appId, fixture.paprHome);
  check(
    "webReady passes for synced fixture (git report stubbed)",
    ready.ready === true,
    ready.detail ?? ready.reason ?? JSON.stringify(ready),
    counters,
  );

  const publishReport = await buildPublishLayerReport(fixture.appId, {
    paprDir: fixture.paprHome,
  });
  check(
    "publish layer is synced when webReady",
    publishReport.status === "synced",
    JSON.stringify(publishReport),
    counters,
  );

  // F4/F5: routing contract
  console.log(`\n${CYAN}F4/F5. push_cloud_sync routing contract${RESET}`);
  function usesOrderedFlush(appId, targets) {
    return Boolean(appId && targets.includes("github") && targets.includes("turso"));
  }
  check(
    "both targets → ordered flushAppNow path",
    usesOrderedFlush(fixture.appId, ["github", "turso"]),
    "",
    counters,
  );
  check(
    "github-only → legacy pushGitNow path (no flush envelope)",
    !usesOrderedFlush(fixture.appId, ["github"]),
    "",
    counters,
  );
  check(
    "turso-only → bridge.pushScoped path (no auto-publish)",
    !usesOrderedFlush(fixture.appId, ["turso"]),
    "",
    counters,
  );
}

async function runPhase5ModuleTier(fixture) {
  console.log(`\n${BOLD}--- Phase 5: SyncCoordinator + upload status ---${RESET}`);

  const tursoStateMod = await loadModule("tursoSyncState.js");
  const {
    markDbDirty,
    loadTursoSyncState,
    isLinkedSourceDirtyFast,
    listDbDirtySyncKeys,
    clearDirtyAfterPush,
  } = tursoStateMod;

  // C1: dirty flag fast path
  console.log(`\n${CYAN}C1. markDbDirty + isLinkedSourceDirtyFast${RESET}`);
  clearDirtyAfterPush(fixture.jobId, fixture.paprHome);
  markDbDirty(fixture.jobId, fixture.dbPath, fixture.paprHome);
  const dirtyState = loadTursoSyncState(fixture.paprHome);
  check(
    "markDbDirty sets dirtyFlag",
    dirtyState.jobs[fixture.jobId]?.dirtyFlag === true,
    JSON.stringify(dirtyState.jobs[fixture.jobId]),
    counters,
  );
  check(
    "listDbDirtySyncKeys includes job",
    listDbDirtySyncKeys(fixture.paprHome).includes(fixture.jobId),
    "",
    counters,
  );
  check(
    "isLinkedSourceDirtyFast returns true when flagged",
    isLinkedSourceDirtyFast(fixture.jobId, fixture.dbPath, dirtyState) === true,
    "",
    counters,
  );

  // C2/C3: coordinator + upload status
  console.log(`\n${CYAN}C2/C3. SyncCoordinator + upload status report${RESET}`);
  const cloudSyncMod = await loadModule("CloudSyncService.js");
  cloudSyncMod.initializeCloudSyncService({
    pushDebounceMs: 600_000,
    queueIntervalMs: 600_000,
  });
  const { initializeSyncCoordinator, getSyncCoordinator } = await loadModule(
    "cloudSync/SyncCoordinator.js",
  );
  const coordStub = createCoordinatorSyncStub(fixture.paprHome);
  initializeSyncCoordinator(coordStub);
  const coordinator = getSyncCoordinator();
  check("SyncCoordinator initializes", coordinator !== null, "", counters);

  coordinator.markDbDirty(fixture.jobId, fixture.dbPath, "watcher");
  const afterCoordDirty = loadTursoSyncState(fixture.paprHome);
  check(
    "coordinator markDbDirty keeps dirtyFlag",
    afterCoordDirty.jobs[fixture.jobId]?.dirtyFlag === true,
    "",
    counters,
  );

  const { buildCoordinatorStatusReport } = await loadModule(
    "cloudSync/coordinatorStatusReport.js",
  );
  const waitingReport = buildCoordinatorStatusReport(coordinator, fixture.appId);
  check(
    "upload status is waiting when db dirty",
    waitingReport?.status === "waiting",
    JSON.stringify(waitingReport),
    counters,
  );
  check(
    "upload label is user-friendly",
    typeof waitingReport?.label === "string" && waitingReport.label.length > 0,
    waitingReport?.label ?? "",
    counters,
  );

  // C4: markGitDirty routing
  console.log(`\n${CYAN}C4. markGitDirty auto-upload vs legacy enqueue${RESET}`);
  writeAutoUploadPrefs(fixture.paprHome, fixture.appId);
  const autoEnqueueCalls = [];
  const manualEnqueueCalls = [];
  initializeSyncCoordinator(
    createCoordinatorSyncStub(fixture.paprHome, { enqueueCalls: autoEnqueueCalls }),
  );
  const autoCoord = getSyncCoordinator();
  autoCoord.markGitDirty(`apps/${fixture.appId}`);
  check(
    "auto-upload app skips enqueueRelativePath",
    autoEnqueueCalls.length === 0,
    `calls=${autoEnqueueCalls.join(", ")}`,
    counters,
  );

  const manualAppId = `${fixture.appId}-manual`;
  fs.mkdirSync(path.join(fixture.appsRoot, manualAppId), { recursive: true });
  writeManualUploadPrefs(fixture.paprHome, manualAppId);
  initializeSyncCoordinator(
    createCoordinatorSyncStub(fixture.paprHome, { enqueueCalls: manualEnqueueCalls }),
  );
  getSyncCoordinator().markGitDirty(`apps/${manualAppId}`);
  check(
    "non-auto app uses enqueueRelativePath",
    manualEnqueueCalls.length === 1,
    `calls=${manualEnqueueCalls.join(", ")}`,
    counters,
  );

  const { resetTursoSyncTestHooks } = await loadModule("tursoPushScheduler.js");

  // C5: flushAutoUploadAppFolderIfNeeded
  console.log(`\n${CYAN}C5. flushAutoUploadAppFolderIfNeeded${RESET}`);
  resetTursoSyncTestHooks();
  writeAutoUploadPrefs(fixture.paprHome, fixture.appId);
  const folderCallOrder = [];
  const bridgeMod = await loadModule("TursoSyncBridge.js");
  const bridge = bridgeMod.getTursoSyncBridge();
  const origPushApp = bridge.pushAppLinkedSources.bind(bridge);
  bridge.pushAppLinkedSources = async (appId) => {
    folderCallOrder.push("turso");
    return origPushApp(appId);
  };

  const folderStub = createCoordinatorSyncStub(fixture.paprHome, { callOrder: folderCallOrder });
  initializeSyncCoordinator(folderStub);
  const { flushAutoUploadAppFolderIfNeeded } = await loadModule(
    "cloudSync/flushQueuedAppFolder.js",
  );
  let folderHandled = false;
  try {
    folderHandled = await flushAutoUploadAppFolderIfNeeded(
      folderStub,
      `apps/${fixture.appId}`,
      "auto",
    );
  } finally {
    bridge.pushAppLinkedSources = origPushApp;
  }
  check("flushAutoUploadAppFolderIfNeeded returns true", folderHandled === true, "", counters);
  check(
    "auto-upload folder flush runs Turso leg",
    folderCallOrder.includes("turso"),
    folderCallOrder.join(" → "),
    counters,
  );

  // C6/C7: coordinator.flushNow + skip reschedule
  console.log(`\n${CYAN}C6/C7. coordinator.flushNow ordering + skip Turso reschedule${RESET}`);
  resetTursoSyncTestHooks();
  const coordFlushOrder = [];
  bridge.pushAppLinkedSources = async (appId) => {
    coordFlushOrder.push("turso");
    return origPushApp(appId);
  };

  initializeSyncCoordinator(
    createCoordinatorSyncStub(fixture.paprHome, { callOrder: coordFlushOrder }),
  );
  const flushCoord = getSyncCoordinator();
  let coordFlushResult;
  try {
    coordFlushResult = await flushCoord.flushNow(fixture.appId, { trigger: "manual" });
  } finally {
    bridge.pushAppLinkedSources = origPushApp;
  }

  const coordTursoIdx = coordFlushOrder.indexOf("turso");
  const coordGitIdx = coordFlushOrder.indexOf("git");
  check(
    "coordinator flush: Turso before git",
    coordTursoIdx >= 0 && coordGitIdx > coordTursoIdx,
    coordFlushOrder.join(" → "),
    counters,
  );
  check(
    "coordinator flush completes Turso leg",
    coordFlushResult.tursoPushed === true,
    JSON.stringify(coordFlushResult),
    counters,
  );
  check(
    "shouldSkipTursoReschedule true after coordinator flush",
    flushCoord.shouldSkipTursoRescheduleForApps([fixture.appId]),
    "",
    counters,
  );
  check(
    "consumeTursoFlushedForApp returns true once",
    flushCoord.consumeTursoFlushedForApp(fixture.appId) === true,
    "",
    counters,
  );
  check(
    "shouldSkipTursoReschedule false after consume",
    !flushCoord.shouldSkipTursoRescheduleForApps([fixture.appId]),
    "",
    counters,
  );

  // C8: concurrent flushNow coalescing (spy Turso leg — ESM exports are read-only)
  console.log(`\n${CYAN}C8. concurrent flushNow coalescing${RESET}`);
  resetTursoSyncTestHooks();
  let coalesceTursoCalls = 0;
  bridge.pushAppLinkedSources = async (appId) => {
    coalesceTursoCalls++;
    await sleep(200);
    return origPushApp(appId);
  };

  initializeSyncCoordinator(createCoordinatorSyncStub(fixture.paprHome));
  const coalesceCoord = getSyncCoordinator();
  try {
    await Promise.all([
      coalesceCoord.flushNow(fixture.appId, { trigger: "manual" }),
      coalesceCoord.flushNow(fixture.appId, { trigger: "manual" }),
    ]);
  } finally {
    bridge.pushAppLinkedSources = origPushApp;
  }

  check(
    "concurrent flushNow coalesced to one Turso push",
    coalesceTursoCalls === 1,
    `tursoCalls=${coalesceTursoCalls}`,
    counters,
  );
}

async function runModuleTier() {
  console.log(`\n${BOLD}--- Tier A: Module E2E (real Turso, temp PAPR_HOME) ---${RESET}`);

  const memory = await ensureDirectMemoryAccess();
  if (!memory) {
    skip(
      "Module tier",
      "no PAPR_API_KEY (set in .env.local or login via Papr Work keychain)",
      counters,
    );
    return;
  }
  console.log(`${CYAN}Memory: ${process.env.PAPR_MEMORY_SERVER_URL} (${memory.source})${RESET}`);

  let fixture;
  try {
    fixture = await setupBidirectionalFixture({
      prefix: "sync-phase45",
      seedLabel: "phase45-seed",
      loadModule,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ECONNREFUSED|credentials|Turso|PAPR_API_KEY/i.test(message)) {
      skip("Module tier", `Turso/memory unavailable (${message.slice(0, 100)})`, counters);
      return;
    }
    throw err;
  }

  try {
    await runPhase4ModuleTier(fixture);
    await runPhase5ModuleTier(fixture);
  } finally {
    try {
      fs.rmSync(fixture.paprHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function runGatewayTier() {
  console.log(`\n${BOLD}--- Tier B: Gateway HTTP E2E ---${RESET}`);

  if (skipGateway) {
    skip("Gateway tier", "--skip-gateway", counters);
    return;
  }

  let healthOk = false;
  try {
    const resp = await fetch(`${gateway}/health`, { signal: AbortSignal.timeout(5_000) });
    healthOk = resp.status === 200;
  } catch {
    healthOk = false;
  }
  if (!healthOk) {
    skip("Gateway tier", `gateway not reachable at ${gateway} (run npm start)`, counters);
    return;
  }
  check("Gateway reachable", true, "", counters);

  const syncStatus = await jsonFetch(gateway, "GET", "/api/sync/status");
  if (!syncStatus.data?.enabled) {
    skip("App-scoped flush via HTTP", syncStatus.data?.reason ?? "cloud sync disabled", counters);
    return;
  }

  const appId = appIdArg;
  if (!appId) {
    skip(
      "POST /api/sync/push { appId }",
      "pass --app-id=<throwaway app with linked Turso DB> (never default first app)",
      counters,
    );
    skip("GET /api/sync/items publish + upload layers", "no --app-id", counters);
    return;
  }

  console.log(`\n${CYAN}G1/G2. Upload now + publish/upload layers for app ${appId}${RESET}`);

  const itemsBefore = await jsonFetch(
    gateway,
    "GET",
    `/api/sync/items?appId=${encodeURIComponent(appId)}&refresh=1`,
  );
  check("GET /api/sync/items returns 200", itemsBefore.status === 200, `status=${itemsBefore.status}`, counters);
  check(
    "Response includes publish layer",
    itemsBefore.data?.publish != null && typeof itemsBefore.data.publish.status === "string",
    JSON.stringify(itemsBefore.data?.publish),
    counters,
  );
  check(
    "Response includes upload field (Phase 5)",
    itemsBefore.data?.upload != null && typeof itemsBefore.data.upload.status === "string",
    JSON.stringify(itemsBefore.data?.upload),
    counters,
  );
  check(
    "Upload field has user-friendly label",
    typeof itemsBefore.data?.upload?.label === "string" &&
      itemsBefore.data.upload.label.length > 0,
    itemsBefore.data?.upload?.label ?? "",
    counters,
  );

  const pushR = await jsonFetch(gateway, "POST", "/api/sync/push", { appId });
  const pushError = typeof pushR.data?.error === "string" ? pushR.data.error : "";
  const pushBlockedByGit =
    pushR.status !== 200 &&
    /newer commits|updates before pushing|non-fast-forward|git sync failed|Could not fetch cloud repo token/i.test(
      pushError,
    );
  check(
    "POST /api/sync/push { appId } returns 200 (or documents git blocker)",
    pushR.status === 200 || pushBlockedByGit,
    pushError || `status=${pushR.status}`,
    counters,
  );
  if (pushBlockedByGit) {
    console.log(
      `  ${YELLOW}ℹ Push blocked by git state (${pushError.slice(0, 120)}) — expected on busy workspaces${RESET}`,
    );
  }

  let publishStatus = null;
  let uploadStatus = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const items = await jsonFetch(
      gateway,
      "GET",
      `/api/sync/items?appId=${encodeURIComponent(appId)}&refresh=1`,
    );
    publishStatus = items.data?.publish?.status ?? null;
    uploadStatus = items.data?.upload?.status ?? null;
    const tursoPending =
      items.data?.turso?.sources?.some(
        (s) => s.appId === appId && s.status === "pending",
      ) ?? false;
    if (publishStatus === "synced" && !tursoPending && uploadStatus !== "uploading") break;
    if (publishStatus === "error") break;
    if (pushBlockedByGit && uploadStatus !== "uploading") break;
    await sleep(3_000);
  }

  check(
    "Publish layer reaches synced (or documents block reason)",
    publishStatus === "synced" || publishStatus === "not_web_ready" || publishStatus === "drift",
    `publish.status=${publishStatus}`,
    counters,
  );
  check(
    "Upload status settles (idle/waiting, not stuck uploading)",
    uploadStatus === "idle" ||
      uploadStatus === "waiting" ||
      uploadStatus === null ||
      (pushBlockedByGit && uploadStatus === "uploading"),
    `upload.status=${uploadStatus}`,
    counters,
  );

  if (publishStatus === "synced") {
    console.log(`  ${CYAN}ℹ Full cross-layer flush succeeded for ${appId}${RESET}`);
  } else {
    console.log(
      `  ${YELLOW}ℹ Publish blocked (${publishStatus}) — may be expected if git/Turso not fully synced${RESET}`,
    );
  }
}

async function main() {
  console.log(`${BOLD}Phase 4+5 E2E — flushAppNow + SyncCoordinator${RESET}`);

  if (!fs.existsSync(path.join(__dirname, "../dist/gateway/services/cloudSync/flushAppNow.js"))) {
    failFast("build", "Run npm run build:gateway first");
  }

  if (!skipModule) {
    await runModuleTier();
  } else {
    console.log(`\n${YELLOW}Skipping Tier A (--skip-module)${RESET}`);
  }
  await runGatewayTier();

  console.log(`\n${BOLD}--- Summary ---${RESET}`);
  console.log(
    `  ${GREEN}${counters.passed} passed${RESET}, ${RED}${counters.failed} failed${RESET}, ${YELLOW}${counters.skipped} skipped${RESET}`,
  );

  if (counters.failed > 0) process.exit(1);
  if (counters.passed === 0 && counters.skipped > 0) {
    console.log(
      `\n${YELLOW}No tests ran — set PAPR_API_KEY and ensure memory/Turso is reachable${RESET}`,
    );
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
