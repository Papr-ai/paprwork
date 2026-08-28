#!/usr/bin/env node
/**
 * Diagnose stuck cdcOperations on a Turso Sync replica file.
 * Usage: ELECTRON_RUN_AS_NODE=1 electron scripts/diagnose-replica-cdc.mjs
 */

import { connect } from "@tursodatabase/sync";
import { createClient } from "@libsql/client";
import { loadEnvLocal, resolveMemoryAccess } from "./lib/testEnv.mjs";

const LOCAL_PATH =
  process.env.REPLICA_DB_PATH ??
  "/Users/amirkabbara/Papr/orgs/crwNcCnClI/namespaces/VIA2C5VDxj/data/databases/todo-list/data.db";
const TURSO_DB = process.env.TURSO_DB ?? "d-caf671ba";

async function fetchToken(cloudBase, dbName) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.PAPR_API_KEY?.trim()) {
    headers["X-API-Key"] = process.env.PAPR_API_KEY.trim();
  }
  const res = await fetch(`${cloudBase}/databases/token`, {
    method: "POST",
    headers,
    body: JSON.stringify({ database: dbName }),
  });
  if (!res.ok) {
    throw new Error(`token (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

function fmtStats(s) {
  if (!s) return "(no stats)";
  return JSON.stringify(
    {
      cdcOperations: s.cdcOperations,
      mainWalSize: s.mainWalSize,
      lastPullUnixTime: s.lastPullUnixTime,
      lastPushUnixTime: s.lastPushUnixTime,
      revision: s.revision,
      networkSentBytes: s.networkSentBytes,
      networkReceivedBytes: s.networkReceivedBytes,
    },
    null,
    2,
  );
}

async function main() {
  loadEnvLocal();
  const access = await resolveMemoryAccess();
  if (!access) {
    console.error("No Papr access — login or set PAPR_API_KEY");
    process.exit(1);
  }
  const cloudBase =
    access.mode === "gateway" ? access.cloudBase : `${access.memoryBase}/v1/cloud`;
  const { tursoUrl, authToken } = await fetchToken(cloudBase, TURSO_DB);

  console.log("\n=== Replica CDC diagnose ===");
  console.log("local:", LOCAL_PATH);
  console.log("turso:", TURSO_DB);
  console.log("url:", tursoUrl);

  const db = await connect({
    path: LOCAL_PATH,
    url: tursoUrl,
    authToken,
    bootstrapIfEmpty: false,
    clientName: "papr-cdc-diagnose",
  });
  await db.connect();

  console.log("\n--- stats BEFORE ---");
  console.log(fmtStats(await db.stats()));

  console.log("\n--- pull ---");
  const pulled = await db.pull();
  console.log("pulled:", pulled);
  console.log(fmtStats(await db.stats()));

  console.log("\n--- push ---");
  await db.push();
  console.log(fmtStats(await db.stats()));

  console.log("\n--- checkpoint ---");
  if (typeof db.checkpoint === "function") {
    await db.checkpoint();
    console.log(fmtStats(await db.stats()));
  } else {
    console.log("(no checkpoint API)");
  }

  const remote = createClient({ url: tursoUrl, authToken });
  try {
    const migrations = await remote.execute(
      "SELECT id FROM schema_migrations ORDER BY id",
    );
    console.log("\n--- remote schema_migrations ---");
    console.log(migrations.rows.map((r) => r.id).join(", "));

    const todos = await remote.execute(
      "SELECT id, text, person FROM todos ORDER BY created_at DESC LIMIT 5",
    );
    console.log("\n--- remote todos (sample) ---");
    console.log(JSON.stringify(todos.rows, null, 2));
  } finally {
    remote.close();
  }

  const localMigrations = await db.prepare(
    "SELECT id FROM schema_migrations ORDER BY id",
  );
  const localMigRows = await localMigrations.all();
  console.log("\n--- local schema_migrations ---");
  console.log(
    (Array.isArray(localMigRows) ? localMigRows : [])
      .map((r) => String(r.id ?? r[0] ?? ""))
      .join(", "),
  );

  await db.close();
  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
