#!/usr/bin/env node
/**
 * Repair leadership-sync replica: reseed from Turso primary (cleanest path).
 *
 * Usage (gateway must be stopped):
 *   npm run build:gateway
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/repair-leadership-sync.mjs
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { readActiveWorkspace } from "./lib/replicaE2eHarness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const dist = path.join(repoRoot, "dist/gateway");

const DB_ID = "db-942deefb";

async function importDist(rel) {
  return import(pathToFileURL(path.join(dist, rel)).href);
}

function loadCachedTursoCredentials(paprHome, tursoDatabase) {
  const credPath = path.join(paprHome, "data/.turso-credentials.json");
  const parsed = JSON.parse(fs.readFileSync(credPath, "utf8"));
  const entry = parsed.databases?.[tursoDatabase];
  if (!entry?.tursoUrl || !entry?.authToken) {
    throw new Error(`No cached Turso credentials for ${tursoDatabase} in ${credPath}`);
  }
  return { tursoUrl: entry.tursoUrl, authToken: entry.authToken };
}

async function main() {
  const workspace = readActiveWorkspace();
  process.env.PAPR_HOME = workspace.paprHome;
  process.env.PAPR_ORG_ID = workspace.orgId;
  process.env.PAPR_NAMESPACE_ID = workspace.namespaceId;
  process.env.CLOUD_SYNC_ENABLED = "true";
  process.env.PAPR_TURSO_REPLICA_SYNC = "force";

  const { getDatabaseRegistryService } = await importDist(
    "services/DatabaseRegistryService.js",
  );
  const registry = getDatabaseRegistryService();
  await registry.initialize();

  const record = registry.getById(DB_ID);
  if (!record) {
    throw new Error(`${DB_ID} not found`);
  }

  console.log("[repair] localPath:", record.localPath);
  console.log("[repair] turso:", record.tursoShortName ?? "d-942deefb");

  const { initializeTursoSyncBridge } = await importDist("services/TursoSyncBridge.js");
  const { removeTursoReplicaLocalFiles } = await importDist(
    "services/tursoReplica/tursoReplicaFileGuard.js",
  );
  const { getTursoReplicaSyncWorkerClient, shutdownTursoReplicaSyncWorker } =
    await importDist("services/tursoReplica/TursoReplicaSyncWorkerClient.js");

  const bridge = initializeTursoSyncBridge();
  const tursoDatabase = record.tursoShortName ?? "d-942deefb";
  const cached = loadCachedTursoCredentials(workspace.paprHome, tursoDatabase);
  bridge.fetchCredentials = async () => cached;
  bridge.resolveCredentialsForReplicaOpen = async () => cached;

  if (fs.existsSync(record.localPath)) {
    const quarantinePath = `${record.localPath}.corrupted-${Date.now()}`;
    fs.renameSync(record.localPath, quarantinePath);
    console.log("[repair] Quarantined local file:", quarantinePath);
  }
  removeTursoReplicaLocalFiles(record.localPath);
  await fs.promises.mkdir(path.dirname(record.localPath), { recursive: true });

  await shutdownTursoReplicaSyncWorker().catch(() => undefined);

  const PULL_TIMEOUT_MS = 5 * 60_000;
  const worker = getTursoReplicaSyncWorkerClient();
  const spec = {
    localPath: record.localPath,
    tursoUrl: cached.tursoUrl,
    authToken: cached.authToken,
    bootstrapIfEmpty: true,
    timeoutMs: PULL_TIMEOUT_MS,
  };

  console.log("[repair] Bootstrapping replica from Turso (up to 5 min for large DB)...");
  await worker.exec({ ...spec, sql: "SELECT 1" });
  await worker.sync(spec, "pull");
  await worker.close(record.localPath);
  await shutdownTursoReplicaSyncWorker().catch(() => undefined);

  const { queryLinkedDbViaTursoReplica } = await importDist(
    "services/tursoReplica/tursoReplicaRouting.js",
  );
  const source = {
    id: DB_ID,
    type: "sqlite",
    dbId: DB_ID,
    alias: "sync",
    dbPath: record.localPath,
    tables: [],
    linkedAt: record.createdAt,
  };

  const probe = await queryLinkedDbViaTursoReplica(
    source,
    "SELECT COUNT(*) AS n FROM meetings",
    [],
    { pullBeforeRead: false },
  );
  const count = Number(probe.rows[0]?.n ?? probe.rows[0]?.[0] ?? 0);
  console.log("[repair] meetings count via replica engine:", count);
  console.log("[repair] OK — leadership-sync repaired. Restart Papr Work.");
}

main().catch((error) => {
  console.error("[repair] fatal:", error);
  process.exitCode = 1;
});
