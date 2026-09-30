#!/usr/bin/env node
/**
 * Integration test — Turso bidirectional merge (Phase 2 acceptance).
 *
 * Verifies web/cloud rows survive when desktop has local dirty changes, across:
 *   - pushJob (core merge)
 *   - pushAppLinkedSources (share bar Upload now — Turso leg)
 *   - pushScoped / push_cloud_sync (agent tool — Turso only)
 *   - reconcileFromCloud / syncLinkedSourceFromCloud (session: manual/periodic)
 *   - reconcileFromCloudDbChanges (cloud db-changed notification path)
 *   - TursoLinkedDbWatcher debounced push (after-change)
 *   - reconcileFromSyncIndex (heartbeat sync-index poll)
 *   - pull-only control when local is clean
 *
 * Uses real Turso + temp PAPR_HOME. Does not require memory server (sync-index bumped locally).
 *
 * Usage:
 *   npm run test:turso-bidirectional-e2e
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { loadEnvLocal, requirePaprApiKey } from "./lib/testEnv.mjs";
import {
  assertBidirectionalMerge,
  bumpSyncIndexForDatabase,
  cloudInsertRow,
  createModuleLoader,
  drainPushQueue,
  flushDebouncedPush,
  localInsertRow,
  readLabels,
  setupBidirectionalFixture,
  sleep,
  waitForPushJobCalls,
} from "./lib/tursoBidirectionalTestLib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvLocal();
const API_KEY = requirePaprApiKey();

function parsePaprApiKeyScope(apiKey) {
  const match = apiKey.match(/^sk-org-([^-]+)-namespace-([^-]+)(?:-.+)?$/);
  if (!match) return null;
  return { organizationId: match[1], namespaceId: match[2] };
}

const keyScope = parsePaprApiKeyScope(API_KEY);
if (keyScope) {
  process.env.PAPR_ORG_ID = keyScope.organizationId;
  process.env.PAPR_NAMESPACE_ID = keyScope.namespaceId;
}

process.env.PAPR_MEMORY_SERVER_URL = (
  process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai"
).replace(/\/$/, "");
process.env.PAPR_API_KEY = API_KEY;
process.env.NODE_ENV = "development";
process.env.GATEWAY_MODE = process.env.GATEWAY_MODE ?? "cloud_agent";
process.env.TURSO_PUSH_DEBOUNCE_MS = process.env.TURSO_PUSH_DEBOUNCE_MS ?? "800";

const loadModule = createModuleLoader(
  path.join(__dirname, "../dist/gateway/services"),
);

function log(msg) {
  console.log(msg);
}

function fail(label, detail) {
  console.error(`❌ FAIL [${label}]:`, detail);
  process.exit(1);
}

async function prepareDirtyMergeScenario(scenarioId) {
  const fixture = await setupBidirectionalFixture({
    prefix: `bidir-${scenarioId}`,
    seedLabel: `seed-${scenarioId}`,
    loadModule,
  });
  const webLabel = `web-${scenarioId}`;
  const desktopLabel = `desktop-${scenarioId}`;

  await cloudInsertRow(loadModule, fixture.bridge, fixture.jobId, fixture.tursoDbName, webLabel);
  await localInsertRow(loadModule, fixture.dbPath, desktopLabel);

  return {
    ...fixture,
    loadModule,
    webLabel,
    desktopLabel,
  };
}

async function runB1() {
  log("B1. pushJob — merge pull-then-push preserves web + desktop rows...");
  const ctx = await prepareDirtyMergeScenario("b1");
  const push = await ctx.bridge.pushJob(ctx.jobId);
  if (push.status !== "pushed" && push.reason !== "all_tables_unchanged") {
    fail("B1 push", push);
  }
  try {
    await assertBidirectionalMerge(ctx, "B1", ctx.webLabel, ctx.desktopLabel);
  } catch (err) {
    fail("B1", err instanceof Error ? err.message : String(err));
  }
  log("   ✅ both rows on local and Turso\n");
}

async function runB2() {
  log("B2. pushAppLinkedSources — share bar Upload now (Turso leg)...");
  const ctx = await prepareDirtyMergeScenario("b2");
  const summary = await ctx.bridge.pushAppLinkedSources(ctx.appId);
  if (summary.failed > 0 || summary.pushed < 1) {
    fail("B2 summary", summary);
  }
  try {
    await assertBidirectionalMerge(ctx, "B2", ctx.webLabel, ctx.desktopLabel);
  } catch (err) {
    fail("B2", err instanceof Error ? err.message : String(err));
  }
  log(`   ✅ pushed=${summary.pushed} failed=${summary.failed}\n`);
}

async function runB3() {
  log("B3. pushScoped — agent push_cloud_sync({ appId, targets: ['turso'] })...");
  const ctx = await prepareDirtyMergeScenario("b3");

  const cloudSyncMod = await loadModule("CloudSyncService.js");
  cloudSyncMod.initializeCloudSyncService({
    pushDebounceMs: 600_000,
    queueIntervalMs: 600_000,
  });

  const { pushCloudSync } = await loadModule("CloudObservabilityService.js");
  const result = await pushCloudSync({ appId: ctx.appId, targets: ["turso"] });
  if (!result.success || !result.turso || result.turso.failed > 0) {
    fail("B3 pushCloudSync", result);
  }

  try {
    await assertBidirectionalMerge(ctx, "B3", ctx.webLabel, ctx.desktopLabel);
  } catch (err) {
    fail("B3", err instanceof Error ? err.message : String(err));
  }
  log(`   ✅ turso pushed=${result.turso.pushed}\n`);
}

async function runB4() {
  log("B4. reconcileFromCloud — local dirty → push session (manual/periodic)...");
  const ctx = await prepareDirtyMergeScenario("b4");
  const { resetTursoSyncSessionStatsForTests } = await loadModule("tursoSyncSession.js");
  resetTursoSyncSessionStatsForTests();

  const summary = await ctx.bridge.reconcileFromCloud(
    { jobId: ctx.jobId },
    { trigger: "manual" },
  );
  if (summary.failed > 0 || summary.pushed < 1) {
    fail("B4 summary", summary);
  }

  try {
    await assertBidirectionalMerge(ctx, "B4", ctx.webLabel, ctx.desktopLabel);
  } catch (err) {
    fail("B4", err instanceof Error ? err.message : String(err));
  }
  log(`   ✅ pushed=${summary.pushed} pulled=${summary.pulled}\n`);
}

async function runB5() {
  log("B5. reconcileFromCloudDbChanges — local dirty → push (not pull-only)...");
  const ctx = await prepareDirtyMergeScenario("b5");
  const { resetTursoPushSchedulerStatsForTests } = await loadModule(
    "tursoPushScheduler.js",
  );
  const { stopTursoLinkedDbWatcher } = await loadModule("TursoLinkedDbWatcher.js");
  await stopTursoLinkedDbWatcher();
  await drainPushQueue(loadModule);
  resetTursoPushSchedulerStatsForTests();

  const summary = await ctx.bridge.reconcileFromCloudDbChanges([{ jobId: ctx.jobId }]);
  if (summary.failed > 0 || summary.pushed < 1) {
    fail("B5 summary", summary);
  }

  try {
    await assertBidirectionalMerge(ctx, "B5", ctx.webLabel, ctx.desktopLabel);
  } catch (err) {
    fail("B5", err instanceof Error ? err.message : String(err));
  }
  log(`   ✅ db-changed session pushed=${summary.pushed}\n`);
}

async function runB6() {
  log("B6. TursoLinkedDbWatcher — debounced push after local write (remote has web row)...");
  const fixture = await setupBidirectionalFixture({
    prefix: "bidir-b6",
    seedLabel: "seed-b6",
    loadModule,
  });
  const webLabel = "web-b6";
  const desktopLabel = "desktop-b6";
  const ctx = { ...fixture, loadModule, webLabel, desktopLabel };

  await cloudInsertRow(loadModule, ctx.bridge, ctx.jobId, ctx.tursoDbName, webLabel);

  const { resetTursoPushSchedulerStatsForTests } = await loadModule(
    "tursoPushScheduler.js",
  );
  const { startTursoLinkedDbWatcher, stopTursoLinkedDbWatcher } = await loadModule(
    "TursoLinkedDbWatcher.js",
  );

  resetTursoPushSchedulerStatsForTests();
  await startTursoLinkedDbWatcher(ctx.appsRoot);

  await localInsertRow(loadModule, ctx.dbPath, desktopLabel);

  await flushDebouncedPush();
  const stats = await waitForPushJobCalls(loadModule, 1);
  await stopTursoLinkedDbWatcher();

  if (stats.pushJobCalls < 1) {
    fail("B6 watcher", stats);
  }

  try {
    await assertBidirectionalMerge(ctx, "B6", ctx.webLabel, ctx.desktopLabel);
  } catch (err) {
    fail("B6", err instanceof Error ? err.message : String(err));
  }
  log(`   ✅ pushJobCalls=${stats.pushJobCalls}\n`);
  await drainPushQueue(loadModule);
}

async function runB7() {
  log("B7. reconcileFromSyncIndex — heartbeat path when local dirty...");
  const ctx = await prepareDirtyMergeScenario("b7");

  await bumpSyncIndexForDatabase(loadModule, ctx.bridge, ctx.tursoDbName);

  const summary = await ctx.bridge.reconcileFromSyncIndex({ trigger: "heartbeat" });
  if (summary.failed > 0 || summary.pushed < 1) {
    fail("B7 summary", summary);
  }

  try {
    await assertBidirectionalMerge(ctx, "B7", ctx.webLabel, ctx.desktopLabel);
  } catch (err) {
    fail("B7", err instanceof Error ? err.message : String(err));
  }
  log(`   ✅ sync-index session pushed=${summary.pushed}\n`);
}

async function runB8() {
  log("B8. Control — local clean + remote ahead → pull only (no push)...");
  const fixture = await setupBidirectionalFixture({
    prefix: "bidir-b8",
    seedLabel: "seed-b8",
    loadModule,
  });
  const webLabel = "web-b8-clean";
  await cloudInsertRow(loadModule, fixture.bridge, fixture.jobId, fixture.tursoDbName, webLabel);

  const { resetTursoPushSchedulerStatsForTests } = await loadModule(
    "tursoPushScheduler.js",
  );
  const { stopTursoLinkedDbWatcher } = await loadModule("TursoLinkedDbWatcher.js");
  await stopTursoLinkedDbWatcher();
  await drainPushQueue(loadModule);
  resetTursoPushSchedulerStatsForTests();

  const summary = await fixture.bridge.reconcileFromCloudDbChanges([
    { jobId: fixture.jobId },
  ]);
  const pushStats = (
    await loadModule("tursoPushScheduler.js")
  ).getTursoPushSchedulerStatsForTests();

  const labels = readLabels(fixture.dbPath);
  if (summary.pulled !== 1 || summary.pushed > 0 || pushStats.pushJobCalls > 0) {
    fail("B8", { summary, pushStats, labels });
  }
  if (!labels.includes(webLabel)) {
    fail("B8 labels", labels);
  }
  log(`   ✅ pulled=${summary.pulled} pushJobCalls=${pushStats.pushJobCalls}\n`);
}

async function main() {
  log("\n=== Turso Bidirectional Merge E2E ===\n");

  const distBridge = path.join(__dirname, "../dist/gateway/services/TursoSyncBridge.js");
  if (!fs.existsSync(distBridge)) {
    console.error("Gateway not built. Run: npm run build:gateway");
    process.exit(1);
  }

  const health = await fetch(`${process.env.PAPR_MEMORY_SERVER_URL}/health`).catch(
    () => null,
  );
  if (!health?.ok) {
    console.error(
      "Memory server not reachable at",
      process.env.PAPR_MEMORY_SERVER_URL,
      "— required for Turso credentials",
    );
    process.exit(1);
  }

  await runB1();
  await runB2();
  await runB3();
  await runB4();
  await runB5();
  await runB6();
  await runB7();
  await runB8();

  log("✅ All bidirectional merge scenarios passed (B1–B8)\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
