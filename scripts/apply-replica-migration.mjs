#!/usr/bin/env node
/**
 * Apply a single registry migration via Plan A Turso replica (pull → exec → push).
 *
 * Usage:
 *   npm run build:gateway
 *   PAPR_TURSO_REPLICA_SYNC=replica-records node scripts/apply-replica-migration.mjs \
 *     --db-id db-a9b3a35d --migration 0007_job_function_repair
 */

import * as path from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

loadEnv({ path: path.join(repoRoot, ".env.local") });
loadEnv({ path: path.join(repoRoot, ".env") });

function parseArgs(argv) {
  let dbId = null;
  let migrationId = null;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--db-id" && argv[i + 1]) {
      dbId = argv[++i];
    } else if (argv[i] === "--migration" && argv[i + 1]) {
      migrationId = argv[++i];
    }
  }
  if (!dbId || !migrationId) {
    console.error(
      "Usage: node scripts/apply-replica-migration.mjs --db-id <id> --migration <0007_name>",
    );
    process.exit(1);
  }
  return { dbId, migrationId };
}

async function main() {
  const { dbId, migrationId } = parseArgs(process.argv);

  const wedgePath = path.join(
    repoRoot,
    "dist/gateway/services/tursoReplica/tursoReplicaSidecarWedge.js",
  );
  const { existsSync } = await import("fs");
  if (!existsSync(wedgePath)) {
    console.error("Run npm run build:gateway first.");
    process.exit(1);
  }

  const { paprDbApplyMigration } = await import(
    path.join(repoRoot, "dist/gateway/services/tursoReplica/PaprDbService.js")
  );

  console.log(`Applying migration ${migrationId} on ${dbId}...`);
  const result = await paprDbApplyMigration({ dbId, migrationId });
  console.log(JSON.stringify(result, null, 2));

  if (!result.applied) {
    console.log("Migration was already applied (no-op).");
  } else {
    console.log("Migration applied successfully.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
