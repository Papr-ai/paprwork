#!/usr/bin/env node
/**
 * Diagnose Leadership Sync flush failure — runs catch-up + ship against live PAPR_HOME.
 *
 * Usage:
 *   npm run build:gateway
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/diagnose-leadership-sync-flush.mjs
 */

import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { loadEnvLocal } from "./lib/testEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

loadEnvLocal();

process.env.PAPR_HOME =
  process.env.PAPR_HOME ??
  path.join(process.env.HOME ?? "", "Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V");

const APP_ID = "4fea25e9-5fba-4ce0-9ca9-fa24d6713486";
const DB_PATH = path.join(
  process.env.PAPR_HOME,
  "data/databases/leadership-sync/data.db",
);

async function main() {
  const dist = path.join(repoRoot, "dist/gateway");
  const { discoverTursoLinkedSources } = await import(
    pathToFileURL(path.join(dist, "services/tursoLinkedSources.js")).href
  );
  const { catchUpLinkedSourceFromWorkspaceLog, shipLinkedSourceToWorkspaceLog } =
    await import(
      pathToFileURL(path.join(dist, "services/syncV3/workspaceLogSync.js")).href
    );
  const { getWorkspaceLogCursor } = await import(
    pathToFileURL(path.join(dist, "services/syncV3/workspaceLogCursor.js")).href
  );

  const appsRoot = path.join(process.env.PAPR_HOME, "apps");
  const sources = (await discoverTursoLinkedSources(appsRoot)).filter(
    (s) => s.appId === APP_ID,
  );
  if (sources.length === 0) {
    throw new Error(`No linked Turso sources for app ${APP_ID}`);
  }

  const source = sources.find((s) => s.alias === "sync") ?? sources[0];
  const replicaId = source.dbId ? `d-${source.dbId.replace(/^db-/, "")}` : null;
  console.log("[diagnose] PAPR_HOME:", process.env.PAPR_HOME);
  console.log("[diagnose] source:", source.alias, source.dbPath);
  console.log("[diagnose] db exists:", DB_PATH);

  const cursorBefore = replicaId ? await getWorkspaceLogCursor(replicaId) : null;
  console.log("[diagnose] workspace log cursor before:", cursorBefore);

  console.log("\n[diagnose] Step 1: catchUpLinkedSourceFromWorkspaceLog...");
  try {
    const applied = await catchUpLinkedSourceFromWorkspaceLog(source);
    console.log("[diagnose] catch-up applied entries:", applied);
  } catch (error) {
    console.error("[diagnose] catch-up FAILED:", error);
    process.exitCode = 1;
    return;
  }

  const cursorAfterCatchUp = replicaId ? await getWorkspaceLogCursor(replicaId) : null;
  console.log("[diagnose] workspace log cursor after catch-up:", cursorAfterCatchUp);

  console.log("\n[diagnose] Step 2: shipLinkedSourceToWorkspaceLog (one round)...");
  try {
    const ship = await shipLinkedSourceToWorkspaceLog(source, { force: false });
    console.log("[diagnose] ship result:", ship);
  } catch (error) {
    console.error("[diagnose] ship FAILED:", error);
    process.exitCode = 1;
    return;
  }

  console.log("\n[diagnose] Step 3: catch-up again after ship...");
  try {
    const applied2 = await catchUpLinkedSourceFromWorkspaceLog(source);
    console.log("[diagnose] second catch-up applied:", applied2);
  } catch (error) {
    console.error("[diagnose] second catch-up FAILED:", error);
    process.exitCode = 1;
    return;
  }

  console.log("\n[diagnose] OK — no FOREIGN KEY errors in catch-up/ship path");
}

main().catch((error) => {
  console.error("[diagnose] fatal:", error);
  process.exitCode = 1;
});
