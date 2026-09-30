#!/usr/bin/env node
/**
 * Backfill schema_migrations ledger rows for migrations whose DDL already landed
 * on disk but were never recorded (partial apply / drift heal gap).
 *
 * Usage:
 *   npm run build:gateway
 *   PAPR_TURSO_REPLICA_SYNC=replica-records node scripts/backfill-replica-migration-ledger.mjs \
 *     --db-id db-a9b3a35d --ids 0002_drop_manager_fk,0003_person_categorization,0004_person_tags_sync_key,0005_person_tag_fresh_table,0006_test_cycle
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

loadEnv({ path: path.join(repoRoot, ".env.local") });
loadEnv({ path: path.join(repoRoot, ".env") });

function parseArgs(argv) {
  let dbId = null;
  let ids = [];
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--db-id" && argv[i + 1]) {
      dbId = argv[++i];
    } else if (argv[i] === "--ids" && argv[i + 1]) {
      ids = argv[++i].split(",").map((id) => id.trim()).filter(Boolean);
    }
  }
  if (!dbId || ids.length === 0) {
    console.error(
      "Usage: node scripts/backfill-replica-migration-ledger.mjs --db-id <id> --ids id1,id2,...",
    );
    process.exit(1);
  }
  return { dbId, ids };
}

async function main() {
  const { dbId, ids } = parseArgs(process.argv);

  const distRoot = path.join(repoRoot, "dist/gateway/services");
  if (!fs.existsSync(path.join(distRoot, "tursoReplica/PaprDbService.js"))) {
    console.error("Run npm run build:gateway first.");
    process.exit(1);
  }

  const { initializeDatabaseRegistry, getDatabaseRegistryService } =
    await import(path.join(distRoot, "DatabaseRegistryService.js"));
  const { writeLinkedDbViaTursoReplica } = await import(
    path.join(distRoot, "tursoReplica/tursoReplicaRouting.js")
  );
  const { ensureReplicaSchemaMigrationsLedger } = await import(
    path.join(distRoot, "tursoReplica/tursoReplicaSchemaLedger.js")
  );

  await initializeDatabaseRegistry();
  const record = getDatabaseRegistryService().getById(dbId);
  if (!record) {
    throw new Error(`Database not found: ${dbId}`);
  }
  const source = {
    id: record.dbId,
    type: "sqlite",
    dbId: record.dbId,
    alias: record.label ?? record.dbId,
    dbPath: record.localPath,
    tables: [],
    linkedAt: record.createdAt,
  };
  await ensureReplicaSchemaMigrationsLedger(source);

  for (const migrationId of ids) {
    const bareId = migrationId.replace(/\.sql$/, "");
    const result = await writeLinkedDbViaTursoReplica(
      source,
      "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))",
      [bareId],
    );
    console.log(`Ledger backfill ${bareId} pendingPush=${result.pendingPush}`);
  }

  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
