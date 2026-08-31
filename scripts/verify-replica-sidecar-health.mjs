#!/usr/bin/env node
/**
 * Production check: detect Turso Sync sidecar wedge on registry replica DBs.
 *
 * Usage:
 *   node scripts/verify-replica-sidecar-health.mjs
 *   node scripts/verify-replica-sidecar-health.mjs --path ~/Papr/.../data.db
 *   node scripts/verify-replica-sidecar-health.mjs --repair
 *
 * Exit 0 = all checked DBs healthy (or repaired successfully)
 * Exit 1 = wedge detected (or repair failed)
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function parseArgs(argv) {
  let targetPath = null;
  let repair = false;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--repair") {
      repair = true;
    } else if (argv[i] === "--path" && argv[i + 1]) {
      targetPath = argv[++i];
    }
  }
  return { targetPath, repair };
}

async function loadWedgeUtils() {
  const mod = await import(
    path.join(repoRoot, "dist/gateway/services/tursoReplica/tursoReplicaSidecarWedge.js")
  );
  return mod;
}

async function loadRegistryPaths() {
  const { initializeDatabaseRegistry, getDatabaseRegistryService } = await import(
    path.join(repoRoot, "dist/gateway/services/DatabaseRegistryService.js")
  );
  const { shouldUseTursoReplicaForDb, isTursoReplicaSyncFeatureEnabled } =
    await import(path.join(repoRoot, "dist/gateway/utils/tursoReplicaEnabled.js"));

  if (!isTursoReplicaSyncFeatureEnabled()) {
    console.log("PAPR_TURSO_REPLICA_SYNC not enabled — nothing to check.");
    return [];
  }

  await initializeDatabaseRegistry();
  const registry = getDatabaseRegistryService();
  return registry
    .listActive()
    .filter((record) => shouldUseTursoReplicaForDb({ syncMode: record.syncMode }))
    .map((record) => ({
      dbId: record.dbId,
      label: record.label ?? record.dbId,
      localPath: record.localPath,
    }));
}

function walSize(dbPath) {
  try {
    return fs.statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

async function main() {
  const { targetPath, repair } = parseArgs(process.argv);

  if (!fs.existsSync(path.join(repoRoot, "dist/gateway/services/tursoReplica/tursoReplicaSidecarWedge.js"))) {
    console.error("Run npm run build:gateway before verify:replica-sidecar");
    process.exit(1);
  }

  const { detectReplicaSidecarWedge, repairReplicaSidecarWedge } =
    await loadWedgeUtils();

  const targets = targetPath
    ? [{ dbId: "manual", label: path.basename(targetPath), localPath: targetPath }]
    : await loadRegistryPaths();

  if (targets.length === 0) {
    console.log("No replica registry DBs to check.");
    process.exit(0);
  }

  let failures = 0;

  for (const target of targets) {
    const dbPath = path.resolve(target.localPath);
    if (!fs.existsSync(dbPath)) {
      console.log(`SKIP ${target.label}: missing ${dbPath}`);
      continue;
    }

    const wedged = detectReplicaSidecarWedge(dbPath);
    const wal = walSize(dbPath);

    if (!wedged) {
      console.log(`OK   ${target.label} (${dbPath}) wal=${wal}B`);
      continue;
    }

    console.log(
      `WEDGE ${target.label} (${dbPath}) — empty sync WAL (${wal}B) with stale -info metadata`,
    );

    if (repair) {
      const repaired = repairReplicaSidecarWedge(dbPath);
      const stillWedged = detectReplicaSidecarWedge(dbPath);
      if (repaired && !stillWedged) {
        console.log(`     repaired sidecars (data.db kept)`);
      } else {
        console.log(`     repair failed or wedge persists`);
        failures += 1;
      }
    } else {
      failures += 1;
    }
  }

  if (failures > 0) {
    console.log(
      `\n${failures} wedged replica(s). Re-run with --repair or restart gateway after npm run build (auto-recovery on next pull/push).`,
    );
    process.exit(1);
  }

  console.log("\nAll checked replica DBs healthy.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
